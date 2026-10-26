// C7 — migration history must be established BEFORE a legacy request becomes
// dispatchable, and the final dispatchable set is audited against ALL preserved
// history (not only what each import happened to see). MOCKED storage
// (fake-indexeddb, fresh origin per test; in-memory localStorage). Written FIRST
// and run against the unchanged C6 code to reproduce (evidence/c7/unit/01-*).
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QUARANTINE_ACKNOWLEDGEMENT, entryKey, quarantineKey, type KeyValueStorage, type PendingInventoryAction } from "@/lib/inventoryPending";
import {
  beginPendingStore,
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
const LIST = `pos-canvas:inventory-pending:${P}`;
const entry = (id: string, over: Partial<PendingInventoryAction> = {}): PendingInventoryAction =>
  ({ requestId: id, projectId: P, action: "receive", itemId: "cola", input: 2, createdAt: "2026-10-24T10:00:00.000Z", ...over });
const K = (id: string) => entryKey(P, id);
/** A C4-format archive written by an older tab into localStorage. */
function archive(originalKey: string, rawValue: string, over: Record<string, unknown> = {}) {
  return JSON.stringify({ version: 1, projectId: P, originalKey, rawValue, requestReference: null, quarantinedAt: "2026-10-23T10:00:00.000Z",
    actor, reason: "older tab", serverOutcome: "unknown", acknowledgement: QUARANTINE_ACKNOWLEDGEMENT, ...over });
}
const dispatchable = async (ls: KeyValueStorage) => {
  const r = await readPendingStore(P, ls);
  return r.status === "ok" ? r.entries.map((e) => e.requestId) : r.keys.filter(() => false); // unresolved → nothing dispatchable
};
const unresolvedKeys = async (ls: KeyValueStorage) => {
  const r = await readPendingStore(P, ls);
  return r.status === "unresolved" ? r.keys : [];
};

/** A C5 (schema v1) database with the given rows — C5 had no "handled" store. */
async function c5Database(rows: { pending?: { key: string; raw: string }[]; migration?: { key: string; raw: string }[] }) {
  await new Promise<void>((resolve) => {
    const req = factory.open("pos-canvas-inventory-pending", 1);
    req.onupgradeneeded = () => {
      for (const n of ["pending", "quarantine", "migration"]) req.result.createObjectStore(n, { keyPath: "key" });
    };
    req.onsuccess = () => {
      const t = req.result.transaction(["pending", "migration"], "readwrite");
      for (const r of rows.pending ?? []) t.objectStore("pending").put(r);
      for (const r of rows.migration ?? []) t.objectStore("migration").put({ ...r, migratedAt: "2026-10-23T09:00:00.000Z", outcome: "added" });
      t.oncomplete = () => {
        req.result.close();
        resolve();
      };
    };
  });
}

// ===========================================================================
describe("Case 1 — FIRST MIGRATION with an archive already in localStorage", () => {
  it("per-entry record + archive of the SAME key (pending keys sort first) → review-only, never dispatchable", async () => {
    const ls = memoryStorage();
    const A = JSON.stringify(entry("c1"));
    ls.setItem(K("c1"), A);
    ls.setItem(quarantineKey(P, K("c1")), archive(K("c1"), "{torn earlier bytes", { requestReference: "c1" }));
    expect(await dispatchable(ls)).toEqual([]);
    // Archives are taken first, so the record is routed to a review copy at import: its exact bytes are unresolved.
    const r = await readPendingStore(P, ls);
    expect(r.status === "unresolved" && Object.values(r.raws)).toContain(A);
  });

  it("archive under a DIFFERENT key whose requestReference names the request → review-only", async () => {
    const ls = memoryStorage();
    ls.setItem(K("c2"), JSON.stringify(entry("c2")));
    const copyKey = `pos-canvas:inventory-pending:${P}:review-0000abcd`;
    ls.setItem(quarantineKey(P, copyKey), archive(copyKey, JSON.stringify(entry("c2", { input: 9 })), { requestReference: "c2", sourceKey: K("c2") }));
    expect(await dispatchable(ls)).toEqual([]);
  });

  it("archive whose only link is its sourceKey, or a requestId inside its damaged raw bytes → review-only", async () => {
    const ls = memoryStorage();
    ls.setItem(K("c3"), JSON.stringify(entry("c3")));
    ls.setItem(quarantineKey(P, "x-other"), archive("x-other", "{damaged", { sourceKey: K("c3") }));
    ls.setItem(K("c4"), JSON.stringify(entry("c4")));
    ls.setItem(quarantineKey(P, "y-other"), archive("y-other", '{"requestId":"c4","projectId":"p1","act'));
    expect(await dispatchable(ls)).toEqual([]);
    expect((await unresolvedKeys(ls)).sort()).toEqual([K("c3"), K("c4")].sort());
  });

  it("LIST format: a list member whose request was quarantined (archive of the list key, reference in its bytes) → review-only", async () => {
    const ls = memoryStorage();
    ls.setItem(LIST, JSON.stringify([entry("l1"), entry("l2")]));
    ls.setItem(quarantineKey(P, LIST), archive(LIST, '[{"requestId":"l1","projectId":"p1","act', { requestReference: "l1" }));
    const r = await readPendingStore(P, ls);
    expect(r.status === "ok" && r.entries.some((e) => e.requestId === "l1")).toBe(false);
  });

  it("no history → still dispatchable (no false positive)", async () => {
    const ls = memoryStorage();
    ls.setItem(K("ok1"), JSON.stringify(entry("ok1")));
    ls.setItem(LIST, JSON.stringify([entry("ok2")]));
    expect((await dispatchable(ls)).sort()).toEqual(["ok1", "ok2"]);
  });
});

// ===========================================================================
describe("Case 2 — C5→C6 UPGRADE: settled in C5 (migration record, no pending row, no handled record)", () => {
  it("per-entry: an older tab writes CHANGED readable bytes under the settled reference → review-only", async () => {
    const A = JSON.stringify(entry("u1"));
    await c5Database({ migration: [{ key: K("u1"), raw: A }] });
    const ls = memoryStorage();
    ls.setItem(K("u1"), JSON.stringify(entry("u1", { input: 7 })));
    expect(await dispatchable(ls)).toEqual([]);
    expect((await unresolvedKeys(ls)).length).toBe(1);
  });

  it("list format in C5 (taken via the list key), then changed per-entry bytes — and then a new list — never dispatchable", async () => {
    await c5Database({ migration: [{ key: LIST, raw: JSON.stringify([entry("u2")]) }] });
    const ls = memoryStorage();
    ls.setItem(K("u2"), JSON.stringify(entry("u2", { input: 5 })));
    expect(await dispatchable(ls)).toEqual([]);
    ls.removeItem(K("u2"));
    ls.setItem(LIST, JSON.stringify([entry("u2", { input: 6 })]));
    expect(await dispatchable(ls)).toEqual([]);
  });

  it("a C5 row that is STILL pending (same bytes as its migration record) stays dispatchable after the upgrade (no false positive)", async () => {
    const A = JSON.stringify(entry("u3"));
    await c5Database({ pending: [{ key: K("u3"), raw: A }], migration: [{ key: K("u3"), raw: A }] });
    const ls = memoryStorage();
    ls.setItem(K("u3"), A);
    expect(await dispatchable(ls)).toEqual(["u3"]);
    expect(await settlePendingStore(entry("u3"))).toBe("settled");
    ls.setItem(K("u3"), JSON.stringify(entry("u3", { input: 4 })));
    expect(await dispatchable(ls)).toEqual([]);
  });
});

// ===========================================================================
describe("The final dispatchable set is audited against ALL preserved history", () => {
  it("history that arrives AFTER an entry was imported (another tab migrates an archive later) removes it from the dispatchable set", async () => {
    const ls = memoryStorage();
    ls.setItem(K("h1"), JSON.stringify(entry("h1")));
    expect(await dispatchable(ls)).toEqual(["h1"]);
    ls.setItem(quarantineKey(P, "z-other"), archive("z-other", "{x", { requestReference: "h1" }));
    expect(await dispatchable(ls)).toEqual([]);
  });

  it("a history-flagged READABLE record can be quarantined (it is not treated as 'repaired'); afterwards it never returns", async () => {
    const ls = memoryStorage();
    const A = JSON.stringify(entry("h2"));
    ls.setItem(K("h2"), A);
    ls.setItem(quarantineKey(P, "w-other"), archive("w-other", "{y", { requestReference: "h2" }));
    expect(await unresolvedKeys(ls)).toEqual([K("h2")]);
    const q = await quarantineStore(P, { key: K("h2"), expectedRaw: A, actor, reason: "history", acknowledged: true });
    expect(q.status).toBe("quarantined");
    for (let i = 0; i < 3; i += 1) expect(await dispatchable(ls)).toEqual([]);
    expect(ls.getItem(K("h2"))).toBe(A);
  });

  it("an ordinary readable entry is still refused by quarantine as 'repaired' (no history)", async () => {
    const ls = memoryStorage();
    const A = JSON.stringify(entry("h3"));
    ls.setItem(K("h3"), A);
    await readPendingStore(P, ls);
    expect((await quarantineStore(P, { key: K("h3"), expectedRaw: A, actor, reason: "x", acknowledged: true })).status).toBe("repaired");
  });

  it("entries created by begin (new actions) are unaffected", async () => {
    const r = await beginPendingStore({ projectId: P, action: "count", itemId: "chips", input: 3 }, () => "fresh-1", memoryStorage());
    expect(r.ok).toBe(true);
    expect(await dispatchable(memoryStorage())).toEqual(["fresh-1"]);
  });
});

// ===========================================================================
describe("Interruption, concurrency, reloads", () => {
  it("INTERRUPTED first migration (crash after the pending key, before the archive) → the reload still never dispatches it", async () => {
    const ls = memoryStorage();
    ls.setItem(K("i1"), JSON.stringify(entry("i1")));
    ls.setItem(quarantineKey(P, K("i1")), archive(K("i1"), "{torn", { requestReference: "i1" }));
    let n = 0;
    setPendingStoreTestHooks({ betweenMigrationKeys: () => { n += 1; if (n === 2) throw new Error("crash"); } });
    await expect(readPendingStore(P, ls)).rejects.toThrow("crash");
    setPendingStoreTestHooks({});
    for (let i = 0; i < 3; i += 1) expect(await dispatchable(ls)).toEqual([]);
  });

  it("CONCURRENT tabs migrating case 1 and case 2 at once: no tab ever reports them dispatchable", async () => {
    await c5Database({ migration: [{ key: K("k2"), raw: JSON.stringify(entry("k2")) }] });
    const ls = memoryStorage();
    ls.setItem(K("k1"), JSON.stringify(entry("k1")));
    ls.setItem(quarantineKey(P, K("k1")), archive(K("k1"), "{torn", { requestReference: "k1" }));
    ls.setItem(K("k2"), JSON.stringify(entry("k2", { input: 8 })));
    const results = await Promise.all([readPendingStore(P, ls), readPendingStore(P, ls), readPendingStore(P, ls)]);
    for (const r of results) expect(r.status === "ok" && r.entries.length > 0).toBe(false);
  });
});

void openPendingStore;
