// C6 — whole-flow review of inventory recovery: persistence, dispatch,
// settlement, quarantine, legacy migration, startup recovery. MOCKED storage
// (fake-indexeddb; a fresh IDBFactory per test = one browser origin; every call
// opens its own connection, as tabs do) and an in-memory localStorage that
// "older-format tabs" write to. Written FIRST and run against the unchanged C5
// code to reproduce the known findings (evidence/c6/unit/01-*).
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entryKey, quarantineKey, type KeyValueStorage, type PendingInventoryAction } from "@/lib/inventoryPending";
import {
  beginPendingStore,
  openPendingStore,
  quarantineStore,
  readPendingStore,
  readQuarantineStore,
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
const P2 = "p2";
const actor = { userId: "u1", label: "owner@synthetic.test" };
const entry = (id: string, over: Partial<PendingInventoryAction> = {}): PendingInventoryAction =>
  ({ requestId: id, projectId: P, action: "receive", itemId: "cola", input: 2, createdAt: "2026-10-24T10:00:00.000Z", ...over });
const K = (id: string, project = P) => entryKey(project, id);

async function rows(store: "pending" | "quarantine"): Promise<{ key: string; raw: string }[]> {
  const db = await openPendingStore();
  if (!db) throw new Error("no db");
  return new Promise((resolve) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => {
      db.close();
      resolve(r.result as { key: string; raw: string }[]);
    };
  });
}
const activeEntries = async (ls: KeyValueStorage) => {
  const r = await readPendingStore(P, ls);
  return r.status === "ok" ? r.entries.map((e) => e.requestId) : r;
};

// ===========================================================================
describe("Finding 1 — inaccessible legacy storage is not proven empty", () => {
  it("no legacy storage → unresolved, and NOTHING is persisted or dispatchable", async () => {
    expect(await readPendingStore(P, null)).toMatchObject({ status: "unresolved", reason: "storage_unavailable" });
    expect(await beginPendingStore({ projectId: P, action: "receive", itemId: "cola", input: 1 }, () => "x", null))
      .toEqual({ ok: false, reason: "storage_unavailable" });
    expect(await rows("pending")).toEqual([]);
  });

  it("legacy storage whose enumeration or reads fail → unresolved", async () => {
    const ls = memoryStorage();
    ls.setItem(K("a"), JSON.stringify(entry("a")));
    const brokenKey = { ...ls, key: () => { throw new DOMException("denied", "SecurityError"); }, get length() { return 1; } };
    expect(await readPendingStore(P, brokenKey as KeyValueStorage)).toMatchObject({ status: "unresolved", reason: "storage_unavailable" });
    const brokenGet = { ...ls, key: ls.key, get length() { return ls.length; }, getItem: () => { throw new DOMException("denied", "SecurityError"); } };
    expect(await readPendingStore(P, brokenGet as KeyValueStorage)).toMatchObject({ status: "unresolved", reason: "storage_unavailable" });
  });
});

// ===========================================================================
describe("Finding 2 — a quarantined reference is never resurrected", () => {
  it("damaged legacy record → migration → quarantine → older tab writes READABLE bytes under the same reference → reload: preserved for review, never active", async () => {
    const ls = memoryStorage();
    ls.setItem(K("q1"), "{torn legacy");
    expect(await readPendingStore(P, ls)).toMatchObject({ status: "unresolved", keys: [K("q1")] });
    expect((await quarantineStore(P, { key: K("q1"), expectedRaw: "{torn legacy", actor, reason: "damaged", acknowledged: true })).status).toBe("quarantined");

    const readable = JSON.stringify(entry("q1"));
    ls.setItem(K("q1"), readable); // an older-format tab rewrites the reference with readable bytes
    for (let reload = 0; reload < 3; reload += 1) {
      const r = await readPendingStore(P, ls);
      expect(r.status).toBe("unresolved"); // never { ok, entries: [q1] } → never auto-submitted
      if (r.status === "unresolved") {
        expect(r.keys).not.toContain(K("q1"));
        expect(Object.values(r.raws)).toContain(readable);
      }
    }
    expect((await rows("pending")).filter((x) => x.raw === readable)).toHaveLength(1); // one review copy, kept
    expect(ls.getItem(K("q1"))).toBe(readable); // legacy original untouched
    expect((await readQuarantineStore(P))[0]).toMatchObject({ kind: "record", record: { rawValue: "{torn legacy", serverOutcome: "unknown" } });
  });
});

// ===========================================================================
describe("Whole flow — already-handled bytes never become fresh automatic submissions", () => {
  it("SETTLED reference: an older tab rewrites it with different readable bytes → review copy, not active", async () => {
    const ls = memoryStorage();
    const a = entry("s1");
    ls.setItem(K("s1"), JSON.stringify(a));
    expect(await activeEntries(ls)).toEqual(["s1"]);
    expect(await settlePendingStore(a)).toBe("settled");
    ls.setItem(K("s1"), JSON.stringify(entry("s1", { input: 9 })));
    const r = await readPendingStore(P, ls);
    expect(r.status).toBe("unresolved");
    expect(r.status === "unresolved" && r.keys.some((k) => k === K("s1"))).toBe(false);
  });

  it("legacy bytes cycling A → B → A → B: each distinct byte string is taken once; A never returns as active after settlement", async () => {
    const ls = memoryStorage();
    const A = JSON.stringify(entry("c1"));
    const B = JSON.stringify(entry("c1", { input: 5 }));
    ls.setItem(K("c1"), A);
    expect(await activeEntries(ls)).toEqual(["c1"]);
    ls.setItem(K("c1"), B);
    await readPendingStore(P, ls); // B differs from active A → one review copy
    ls.setItem(K("c1"), A);
    await readPendingStore(P, ls); // A was taken before → nothing new
    ls.setItem(K("c1"), B);
    await readPendingStore(P, ls); // B was taken before → nothing new
    const pending = await rows("pending");
    expect(pending.filter((x) => x.raw === B)).toHaveLength(1);
    expect(pending.filter((x) => x.raw === A)).toHaveLength(1);
    expect(await settlePendingStore(entry("c1"))).toBe("settled");
    ls.setItem(K("c1"), A);
    const after = await readPendingStore(P, ls);
    expect(after.status === "ok" && after.entries.map((e) => e.requestId)).not.toEqual(["c1"]);
    expect((await rows("pending")).some((x) => x.key === K("c1"))).toBe(false);
  });

  it("legacy LIST expansion: a settled member becomes a review copy; a conflicting member is kept beside the active one; the list bytes stay in localStorage", async () => {
    const ls = memoryStorage();
    const done = entry("l1");
    ls.setItem(K("l1"), JSON.stringify(done));
    await readPendingStore(P, ls);
    expect(await settlePendingStore(done)).toBe("settled");
    ls.setItem(K("l2"), JSON.stringify(entry("l2")));
    await readPendingStore(P, ls);
    const list = JSON.stringify([done, entry("l2", { input: 7 }), entry("l3")]);
    ls.setItem(`pos-canvas:inventory-pending:${P}`, list); // an older Batch B tab writes its single-list format
    const r = await readPendingStore(P, ls);
    const pending = await rows("pending");
    expect(pending.some((x) => x.key === K("l1"))).toBe(false); // settled member not resurrected as active
    expect(pending.find((x) => x.key === K("l2"))?.raw).toBe(JSON.stringify(entry("l2"))); // active one untouched
    expect(pending.some((x) => x.key === K("l3"))).toBe(true); // a genuinely new member is active
    expect(r.status).toBe("unresolved"); // the settled + conflicting members await review
    expect(pending.filter((x) => x.raw === JSON.stringify(done) || x.raw === JSON.stringify(entry("l2", { input: 7 })))).toHaveLength(2);
    expect(ls.getItem(`pos-canvas:inventory-pending:${P}`)).toBe(list);
  });

  it("an older-format tab's NEW action is taken under its OWN id (no new id is minted for it)", async () => {
    const ls = memoryStorage();
    ls.setItem(K("o1"), JSON.stringify(entry("o1")));
    expect(await activeEntries(ls)).toEqual(["o1"]);
  });

  it("a delayed server result arriving after quarantine finds nothing to settle and changes nothing", async () => {
    const ls = memoryStorage();
    const e = entry("d1");
    ls.setItem(K("d1"), JSON.stringify(e).slice(0, 20));
    await readPendingStore(P, ls);
    expect((await quarantineStore(P, { key: K("d1"), expectedRaw: JSON.stringify(e).slice(0, 20), actor, reason: "r", acknowledged: true })).status).toBe("quarantined");
    expect(await settlePendingStore(e)).toBe("absent");
    expect((await readQuarantineStore(P))[0]).toMatchObject({ kind: "record", record: { serverOutcome: "unknown" } });
  });
});

// ===========================================================================
describe("Whole flow — evidence, binding, separation, upgrade, failures", () => {
  it("quarantining a review copy keeps the request reference from its BYTES and records where it came from", async () => {
    const ls = memoryStorage();
    ls.setItem(K("r1"), JSON.stringify(entry("r1")));
    await readPendingStore(P, ls);
    ls.setItem(K("r1"), JSON.stringify(entry("r1", { input: 4 })));
    const r = await readPendingStore(P, ls);
    const copyKey = r.status === "unresolved" ? r.keys[0] : "";
    const q = await quarantineStore(P, { key: copyKey, expectedRaw: r.status === "unresolved" ? r.raws[copyKey] : "", actor, reason: "conflict", acknowledged: true });
    expect(q.status).toBe("quarantined");
    expect(q.status === "quarantined" && q.record.requestReference).toBe("r1");
    expect(q.status === "quarantined" && (q.record as { sourceKey?: string }).sourceKey).toBe(K("r1"));
  });

  it("request binding / business separation: another business's bytes under this business's key are unresolved, never submitted; another business's records are invisible", async () => {
    const ls = memoryStorage();
    ls.setItem(K("x1"), JSON.stringify(entry("x1", { projectId: P2 })));
    ls.setItem(K("y1", P2), JSON.stringify(entry("y1", { projectId: P2 })));
    const r = await readPendingStore(P, ls);
    expect(r).toMatchObject({ status: "unresolved", keys: [K("x1")] });
    const r2 = await readPendingStore(P2, ls);
    expect(r2.status === "ok" && r2.entries.map((e) => e.requestId)).toEqual(["y1"]);
  });

  it("upgrade: a C5 (version 1) database keeps every row when opened by this version", async () => {
    await new Promise<void>((resolve) => {
      const req = factory.open("pos-canvas-inventory-pending", 1);
      req.onupgradeneeded = () => {
        for (const n of ["pending", "quarantine", "migration"]) req.result.createObjectStore(n, { keyPath: "key" });
      };
      req.onsuccess = () => {
        const t = req.result.transaction("pending", "readwrite");
        t.objectStore("pending").put({ key: K("v1"), raw: JSON.stringify(entry("v1")) });
        t.oncomplete = () => {
          req.result.close();
          resolve();
        };
      };
    });
    expect(await activeEntries(memoryStorage())).toEqual(["v1"]);
  });

  it("interruption AFTER commit (page closed before the screen updated): the next load shows the committed quarantine; BEFORE commit: nothing changed", async () => {
    const ls = memoryStorage();
    ls.setItem(K("i1"), "{broken");
    await readPendingStore(P, ls);
    await quarantineStore(P, { key: K("i1"), expectedRaw: "{broken", actor, reason: "r", acknowledged: true });
    expect(await readPendingStore(P, ls)).toEqual({ status: "ok", entries: [] }); // the "reload"
    expect(await readQuarantineStore(P)).toHaveLength(1);

    ls.setItem(K("i2"), "{broken2");
    await readPendingStore(P, ls);
    setPendingStoreTestHooks({ afterConditionalRead: (op) => { if (op === "quarantine") throw new Error("tab closed mid-transaction"); } });
    expect((await quarantineStore(P, { key: K("i2"), expectedRaw: "{broken2", actor, reason: "r", acknowledged: true })).status).toBe("quarantine_failed");
    setPendingStoreTestHooks({});
    expect((await rows("pending")).find((x) => x.key === K("i2"))?.raw).toBe("{broken2");
  });

  it("full / failing IndexedDB during migration → unresolved; localStorage untouched; nothing half-written", async () => {
    const ls = memoryStorage();
    ls.setItem(K("f1"), JSON.stringify(entry("f1")));
    const proto = IDBObjectStore.prototype as unknown as { add: (...a: unknown[]) => unknown };
    const add = proto.add;
    proto.add = function () {
      throw new DOMException("synthetic quota", "QuotaExceededError");
    };
    try {
      expect(await readPendingStore(P, ls)).toMatchObject({ status: "unresolved", reason: "storage_unavailable" });
    } finally {
      proto.add = add;
    }
    expect(await rows("pending")).toEqual([]);
    expect(ls.getItem(K("f1"))).toBe(JSON.stringify(entry("f1")));
    expect(await activeEntries(ls)).toEqual(["f1"]); // retried once storage works
  });
});

void quarantineKey;
