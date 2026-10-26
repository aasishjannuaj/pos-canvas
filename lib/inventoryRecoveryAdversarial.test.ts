// C6 — ADVERSARIAL review of the complete changed recovery flow. Each test tries
// to break an assumption with deterministic failure injection or a forced
// interleaving (a hook fires INSIDE one transaction and starts the competing
// operation, which IndexedDB must serialize after it). MOCKED storage
// (fake-indexeddb); see race-browser.mjs for real-Chromium counterparts.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entryKey, type KeyValueStorage, type PendingInventoryAction } from "@/lib/inventoryPending";
import {
  openPendingStore,
  quarantineStore,
  readPendingStore,
  setPendingStoreFactoryForTests,
  setPendingStoreTestHooks,
  settlePendingStore,
} from "@/lib/inventoryPendingStore";

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
    key: (i) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
}
let factory: IDBFactory;
beforeEach(() => {
  factory = new IDBFactory();
  setPendingStoreFactoryForTests(factory);
  setPendingStoreTestHooks({});
});
afterEach(() => {
  setPendingStoreFactoryForTests(undefined);
  setPendingStoreTestHooks({});
});

const P = "p1";
const actor = { userId: "u1", label: "owner" };
const entry = (id: string, over: Partial<PendingInventoryAction> = {}): PendingInventoryAction =>
  ({ requestId: id, projectId: P, action: "receive", itemId: "cola", input: 2, createdAt: "2026-10-24T10:00:00.000Z", ...over });
const K = (id: string, project = P) => entryKey(project, id);
async function all(store: string): Promise<{ key: string; raw: string }[]> {
  const db = (await openPendingStore()) as IDBDatabase;
  return new Promise((r) => {
    const q = db.transaction(store).objectStore(store).getAll();
    q.onsuccess = () => {
      db.close();
      r(q.result);
    };
  });
}
const active = async (ls: KeyValueStorage) => {
  const r = await readPendingStore(P, ls);
  return r.status === "ok" ? r.entries.map((e) => e.requestId) : (r.keys as string[]).map((k) => `unresolved:${k}`);
};

/** The store's FNV-1a (32-bit), mirrored to MANUFACTURE real collisions. */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
function collide(make: (n: number) => string, hashOf: (s: string) => string): [string, string] {
  const seen = new Map<string, string>();
  for (let n = 0; n < 2_000_000; n += 1) {
    const s = make(n);
    const h = hashOf(s);
    const prior = seen.get(h);
    if (prior !== undefined && prior !== s) return [prior, s];
    seen.set(h, s);
  }
  throw new Error("no collision found");
}

describe("C6 adversarial review", () => {
  it("A1 a failure INSIDE a migration transaction (thrown from a request callback) rolls that key back; localStorage untouched; the next load completes it", async () => {
    const ls = memoryStorage();
    ls.setItem(K("a1"), JSON.stringify(entry("a1")));
    setPendingStoreTestHooks({ afterConditionalRead: (op) => { if (op === "migrate") throw new Error("injected"); } });
    expect(await readPendingStore(P, ls)).toMatchObject({ status: "unresolved", reason: "storage_unavailable" });
    expect(await all("pending")).toEqual([]);
    expect(await all("migration")).toEqual([]);
    setPendingStoreTestHooks({});
    expect(await active(ls)).toEqual(["a1"]);
  });

  it("A2 a REAL hash collision between two byte strings for one key: both are recorded as distinct takes, neither is skipped, A→B→A still takes each once", async () => {
    const [b1, b2] = collide((n) => `{"x":${n}}`, fnv);
    expect(fnv(b1)).toBe(fnv(b2));
    const ls = memoryStorage();
    ls.setItem(K("a2"), b1);
    await readPendingStore(P, ls);
    ls.setItem(K("a2"), b2);
    await readPendingStore(P, ls);
    ls.setItem(K("a2"), b1);
    await readPendingStore(P, ls);
    const mig = (await all("migration")).filter((m) => m.key.startsWith(K("a2")));
    expect(mig.map((m) => m.raw).sort()).toEqual([b1, b2].sort());
    const pending = await all("pending");
    expect(pending.filter((r) => r.raw === b1)).toHaveLength(1);
    expect(pending.filter((r) => r.raw === b2)).toHaveLength(1); // b2 kept as a review copy, not lost to the collision
  });

  it("A3 a REAL collision between two review copies of one key: both copies are kept (probe suffix), nothing overwritten", async () => {
    const key = K("a3");
    const [c1, c2] = collide((n) => `{"y":${n}}`, (s) => fnv(key + "\u0000" + s));
    const ls = memoryStorage();
    ls.setItem(key, JSON.stringify(entry("a3")));
    await readPendingStore(P, ls); // active
    ls.setItem(key, c1);
    await readPendingStore(P, ls); // review copy 1
    ls.setItem(key, c2);
    await readPendingStore(P, ls); // review copy 2 — same base key, different bytes
    const copies = (await all("pending")).filter((r) => r.key.includes(":review-"));
    expect(copies.map((r) => r.raw).sort()).toEqual([c1, c2].sort());
    expect(new Set(copies.map((r) => r.key)).size).toBe(2);
  });

  it("A4 an older tab writes a DIFFERENT archive under an existing quarantine key: the archive is never overwritten; the new bytes become a review copy", async () => {
    const ls = memoryStorage();
    ls.setItem(K("a4"), "{torn");
    await readPendingStore(P, ls);
    const q = await quarantineStore(P, { key: K("a4"), expectedRaw: "{torn", actor, reason: "first", acknowledged: true });
    expect(q.status).toBe("quarantined");
    const archives = await all("quarantine");
    const archiveKey = archives[0].key;
    ls.setItem(archiveKey, '{"forged":"archive"}');
    await readPendingStore(P, ls);
    expect((await all("quarantine")).find((r) => r.key === archiveKey)?.raw).toBe(archives[0].raw);
    expect((await all("pending")).some((r) => r.raw === '{"forged":"archive"}')).toBe(true);
  });

  it("A5 two tabs migrating the same localStorage at the same moment: every key taken exactly once", async () => {
    const ls = memoryStorage();
    for (const id of ["x", "y", "z"]) ls.setItem(K(id), JSON.stringify(entry(id)));
    await Promise.all([readPendingStore(P, ls), readPendingStore(P, ls), readPendingStore(P, ls)]);
    expect((await all("pending")).map((r) => r.key).sort()).toEqual([K("x"), K("y"), K("z")]);
    expect(await all("migration")).toHaveLength(3);
  });

  for (const order of ["settle-first", "intake-first"] as const) {
    it(`A6 settlement racing the intake of an older tab's rewrite (${order}): the rewrite never becomes active work`, async () => {
      const ls = memoryStorage();
      const e = entry("a6");
      ls.setItem(K("a6"), JSON.stringify(e));
      await readPendingStore(P, ls);
      ls.setItem(K("a6"), JSON.stringify(entry("a6", { input: 8 })));
      let second: Promise<unknown> = Promise.resolve();
      setPendingStoreTestHooks({ afterConditionalRead: (op) => {
        if (order === "settle-first" && op === "settle") second = readPendingStore(P, ls);
        if (order === "intake-first" && op === "migrate") second = settlePendingStore(e);
        setPendingStoreTestHooks({});
      } });
      if (order === "settle-first") expect(await settlePendingStore(e)).toBe("settled");
      else await readPendingStore(P, ls);
      await second;
      const now = await readPendingStore(P, ls);
      expect(now.status === "ok" && now.entries.map((x) => x.requestId).includes("a6")).toBe(false);
      expect((await all("pending")).some((r) => r.raw === JSON.stringify(entry("a6", { input: 8 })))).toBe(true); // preserved
    });
  }

  it("A7 quarantine racing the intake of readable bytes under the same reference (both orders): never active; nothing lost", async () => {
    for (const order of ["quarantine-first", "intake-first"] as const) {
      setPendingStoreFactoryForTests((factory = new IDBFactory()));
      const ls = memoryStorage();
      ls.setItem(K("a7"), "{torn");
      await readPendingStore(P, ls);
      ls.setItem(K("a7"), JSON.stringify(entry("a7")));
      let second: Promise<unknown> = Promise.resolve();
      setPendingStoreTestHooks({ afterConditionalRead: (op) => {
        if (order === "quarantine-first" && op === "quarantine") second = readPendingStore(P, ls);
        if (order === "intake-first" && op === "migrate") second = quarantineStore(P, { key: K("a7"), expectedRaw: "{torn", actor, reason: "r", acknowledged: true });
        setPendingStoreTestHooks({});
      } });
      if (order === "quarantine-first") await quarantineStore(P, { key: K("a7"), expectedRaw: "{torn", actor, reason: "r", acknowledged: true });
      else await readPendingStore(P, ls);
      await second;
      const r = await readPendingStore(P, ls);
      expect(r.status === "ok" && r.entries.some((x) => x.requestId === "a7")).toBe(false);
      expect((await all("quarantine")).some((q) => JSON.parse(q.raw).rawValue === "{torn")).toBe(true);
      expect((await all("pending")).some((x) => x.raw === JSON.stringify(entry("a7")))).toBe(true);
    }
  });

  it("A8 business separation of handled references: settling p1/x does not block p2/x", async () => {
    const ls = memoryStorage();
    ls.setItem(K("x"), JSON.stringify(entry("x")));
    await readPendingStore(P, ls);
    expect(await settlePendingStore(entry("x"))).toBe("settled");
    ls.setItem(K("x", "p2"), JSON.stringify(entry("x", { projectId: "p2" })));
    const r2 = await readPendingStore("p2", ls);
    expect(r2.status === "ok" && r2.entries.map((e) => e.requestId)).toEqual(["x"]);
  });

  it("A9 a legacy list holding the same reference twice with different bytes: one active, the other a review copy", async () => {
    const ls = memoryStorage();
    ls.setItem(`pos-canvas:inventory-pending:${P}`, JSON.stringify([entry("d1"), entry("d1", { input: 3 })]));
    const r = await readPendingStore(P, ls);
    const pending = await all("pending");
    expect(pending.find((x) => x.key === K("d1"))?.raw).toBe(JSON.stringify(entry("d1")));
    expect(pending.some((x) => x.raw === JSON.stringify(entry("d1", { input: 3 })))).toBe(true);
    expect(r.status).toBe("unresolved");
  });

  it("A10 a failure INSIDE settlement keeps the entry (it is replayed later, never lost or doubled)", async () => {
    const ls = memoryStorage();
    ls.setItem(K("a10"), JSON.stringify(entry("a10")));
    await readPendingStore(P, ls);
    setPendingStoreTestHooks({ afterConditionalRead: (op) => { if (op === "settle") throw new Error("injected"); } });
    expect(await settlePendingStore(entry("a10"))).toBe("failed");
    setPendingStoreTestHooks({});
    expect(await active(ls)).toEqual(["a10"]);
    expect((await all("handled")).length).toBe(0);
  });

  it("A11 settled bytes reappearing from ANOTHER legacy source (a Batch B list) are not resurrected", async () => {
    const ls = memoryStorage();
    ls.setItem(K("a11"), JSON.stringify(entry("a11")));
    await readPendingStore(P, ls);
    expect(await settlePendingStore(entry("a11"))).toBe("settled");
    ls.setItem(`pos-canvas:inventory-pending:${P}`, JSON.stringify([entry("a11")]));
    const r = await readPendingStore(P, ls);
    expect(r.status === "ok" && r.entries.some((e) => e.requestId === "a11")).toBe(false);
  });
});
