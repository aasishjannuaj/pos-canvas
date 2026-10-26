// C7 — separate ADVERSARIAL pass over the migration-history audit. Each test
// attacks an assumption of the corrected flow. Run first against the C7 fix as
// first written (evidence/c7/unit/04-*), then after any correction.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUARANTINE_ACKNOWLEDGEMENT, entryKey, quarantineKey, type KeyValueStorage, type PendingInventoryAction } from "@/lib/inventoryPending";
import {
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
  vi.restoreAllMocks();
});

const P = "p1";
const LIST = `pos-canvas:inventory-pending:${P}`;
const actor = { userId: "u1", label: "owner" };
const entry = (id: string, over: Partial<PendingInventoryAction> = {}): PendingInventoryAction =>
  ({ requestId: id, projectId: P, action: "receive", itemId: "cola", input: 2, createdAt: "2026-10-24T10:00:00.000Z", ...over });
const K = (id: string, project = P) => entryKey(project, id);
const dispatchable = async (ls: KeyValueStorage, project = P) => {
  const r = await readPendingStore(project, ls);
  return r.status === "ok" ? r.entries.map((e) => e.requestId) : [];
};
async function oldDatabase(version: 1 | 2, migration: Record<string, unknown>[], pending: Record<string, unknown>[] = []) {
  await new Promise<void>((resolve) => {
    const req = factory.open("pos-canvas-inventory-pending", version);
    req.onupgradeneeded = () => {
      for (const n of version === 1 ? ["pending", "quarantine", "migration"] : ["pending", "quarantine", "migration", "handled"]) req.result.createObjectStore(n, { keyPath: "key" });
    };
    req.onsuccess = () => {
      const t = req.result.transaction(["pending", "migration"], "readwrite");
      for (const r of migration) t.objectStore("migration").put(r);
      for (const r of pending) t.objectStore("pending").put(r);
      t.oncomplete = () => {
        req.result.close();
        resolve();
      };
    };
  });
}

describe("C7 adversarial: migration-history audit", () => {
  it("X1 CLOCK SKEW: a C5 settlement record stamped in the FUTURE (clock was ahead) still counts as earlier history", async () => {
    await oldDatabase(1, [{ key: K("x1"), raw: JSON.stringify(entry("x1")), migratedAt: "2027-06-01T00:00:00.000Z", outcome: "added" }]);
    const ls = memoryStorage();
    ls.setItem(K("x1"), JSON.stringify(entry("x1", { input: 9 })));
    expect(await dispatchable(ls)).toEqual([]);
  });

  it("X1b CLOCK SKEW on a C6 (v2) per-bytes record of a list → the member's later per-entry bytes are not dispatchable", async () => {
    await oldDatabase(2, [{ key: `${LIST}\u0000deadbeef`, lsKey: LIST, raw: JSON.stringify([entry("x2")]), migratedAt: "2027-06-01T00:00:00.000Z", outcome: "added" }]);
    const ls = memoryStorage();
    ls.setItem(K("x2"), JSON.stringify(entry("x2", { input: 4 })));
    expect(await dispatchable(ls)).toEqual([]);
  });

  it("X2 TIES: every timestamp identical (same millisecond) — earlier history is still distinguished from the import itself", async () => {
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2026-10-26T00:00:00.000Z");
    const ls = memoryStorage();
    const A = JSON.stringify(entry("x3"));
    ls.setItem(K("x3"), A);
    expect(await dispatchable(ls)).toEqual(["x3"]);
    expect(await settlePendingStore(entry("x3"))).toBe("settled");
    ls.setItem(K("x3"), JSON.stringify(entry("x3", { input: 6 })));
    expect(await dispatchable(ls)).toEqual([]);
  });

  it("X3 another business's history never blocks this business (same request id)", async () => {
    await oldDatabase(1, [{ key: K("x4", "p2"), raw: JSON.stringify(entry("x4", { projectId: "p2" })), migratedAt: "2026-10-01T00:00:00.000Z", outcome: "added" }]);
    const ls = memoryStorage();
    ls.setItem(K("x4"), JSON.stringify(entry("x4")));
    expect(await dispatchable(ls)).toEqual(["x4"]);
  });

  it("X4 members of ONE list imported together are not flagged by that list's own record (no false positive)", async () => {
    const ls = memoryStorage();
    ls.setItem(LIST, JSON.stringify([entry("x5"), entry("x6")]));
    expect((await dispatchable(ls)).sort()).toEqual(["x5", "x6"]);
  });

  it("X5 an active entry is not flagged by a LATER conflicting copy of its own key", async () => {
    const ls = memoryStorage();
    ls.setItem(K("x7"), JSON.stringify(entry("x7")));
    await readPendingStore(P, ls);
    ls.setItem(K("x7"), JSON.stringify(entry("x7", { input: 3 })));
    const r = await readPendingStore(P, ls);
    expect(r.status).toBe("unresolved"); // the conflicting copy needs review…
    if (r.status === "unresolved") expect(r.keys).not.toContain(K("x7")); // …but the active entry itself is not history-flagged
  });

  it("X6 a history-flagged quarantine racing a reload: exactly one outcome, never dispatchable", async () => {
    const ls = memoryStorage();
    const A = JSON.stringify(entry("x8"));
    ls.setItem(K("x8"), A);
    ls.setItem(quarantineKey(P, "other"), JSON.stringify({ version: 1, projectId: P, originalKey: "other", rawValue: "{z", requestReference: "x8",
      quarantinedAt: "t", actor, reason: "r", serverOutcome: "unknown", acknowledgement: QUARANTINE_ACKNOWLEDGEMENT }));
    await readPendingStore(P, ls);
    const [q] = await Promise.all([quarantineStore(P, { key: K("x8"), expectedRaw: A, actor, reason: "race", acknowledged: true }), readPendingStore(P, ls)]);
    expect(q.status).toBe("quarantined");
    expect(await dispatchable(ls)).toEqual([]);
  });
});
