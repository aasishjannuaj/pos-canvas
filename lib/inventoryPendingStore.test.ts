// Correction C5 — atomic pending/quarantine storage (lib/inventoryPendingStore.ts).
// Storage: fake-indexeddb, a fresh IDBFactory per test ("one browser origin");
// each call opens its own connection, as separate tabs do. localStorage: an
// in-memory KeyValueStorage (the migration source). MOCKED storage; the same
// races in a real Chromium are prototype/correction/race-browser.mjs.
//
// Every race is FORCED deterministically: a hook runs synchronously INSIDE the
// operation's transaction — after its final read, before its delete/write —
// and issues the competing write on a second, already-open connection.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QUARANTINE_PREFIX, entryKey, quarantineKey, type KeyValueStorage, type PendingInventoryAction } from "@/lib/inventoryPending";
import {
  PENDING_DB_NAME,
  beginPendingStore,
  migrateFromLocalStorage,
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
const actor = { userId: "u1", label: "owner@synthetic.test" };
const sub = (over: Partial<Omit<PendingInventoryAction, "requestId" | "createdAt">> = {}) =>
  ({ projectId: P, action: "receive" as const, itemId: "cola", input: 10, ...over });
const entry = (id: string, over: Partial<PendingInventoryAction> = {}): PendingInventoryAction =>
  ({ requestId: id, projectId: P, action: "receive", itemId: "cola", input: 2, createdAt: "2026-10-24T10:00:00.000Z", ...over });

/** Direct store access, as "another tab" would have it. */
async function raw(store: "pending" | "quarantine" | "migration", key: string): Promise<string | null> {
  const db = await openPendingStore();
  if (!db) throw new Error("no db");
  return new Promise((resolve) => {
    const r = db.transaction(store).objectStore(store).get(key);
    r.onsuccess = () => {
      db.close();
      resolve(r.result ? (r.result as { raw: string }).raw : null);
    };
  });
}
async function put(store: "pending" | "quarantine", key: string, value: string): Promise<void> {
  const db = await openPendingStore();
  if (!db) throw new Error("no db");
  await new Promise<void>((resolve) => {
    const t = db.transaction(store, "readwrite");
    t.objectStore(store).put({ key, raw: value });
    t.oncomplete = () => resolve();
  });
  db.close();
}
async function count(store: "pending" | "quarantine"): Promise<number> {
  const db = await openPendingStore();
  if (!db) throw new Error("no db");
  return new Promise((resolve) => {
    const r = db.transaction(store).objectStore(store).count();
    r.onsuccess = () => {
      db.close();
      resolve(r.result);
    };
  });
}
/** A second, already-open connection whose write is issued synchronously from inside a hook. */
async function competitor() {
  const db = await openPendingStore();
  if (!db) throw new Error("no db");
  let done: Promise<void> = Promise.resolve();
  return {
    write(store: "pending" | "quarantine", key: string, value: string) {
      done = new Promise<void>((resolve) => {
        const t = db.transaction(store, "readwrite");
        t.objectStore(store).put({ key, raw: value });
        t.oncomplete = () => resolve();
        t.onabort = () => resolve();
      });
    },
    finished: () => done.then(() => db.close()),
  };
}

// ===========================================================================
describe("C1/C4 behaviour, preserved on the atomic store", () => {
  it("persists and reads back before dispatch; the same submission gets the SAME id; a new one a new id", async () => {
    let n = 0;
    const first = await beginPendingStore(sub(), () => `id-${++n}`, memoryStorage());
    expect(first).toMatchObject({ ok: true, reused: false });
    const again = await beginPendingStore(sub(), () => `id-${++n}`, memoryStorage());
    expect(again.ok && again.reused && again.entry.requestId).toBe("id-1");
    const other = await beginPendingStore(sub({ input: 11 }), () => `id-${++n}`, memoryStorage());
    expect(other.ok && other.entry.requestId).toBe("id-2"); // the reused submission minted nothing
  });

  it("no IndexedDB → unresolved storage_unavailable; a failing write → persist_failed; nothing stored", async () => {
    setPendingStoreFactoryForTests(null);
    expect(await beginPendingStore(sub(), () => "x", memoryStorage())).toEqual({ ok: false, reason: "storage_unavailable" });
    setPendingStoreFactoryForTests(factory);
    const proto = IDBObjectStore.prototype as unknown as { add: (...a: unknown[]) => unknown };
    const add = proto.add;
    proto.add = function () {
      throw new DOMException("synthetic quota", "QuotaExceededError");
    };
    try {
      expect(await beginPendingStore(sub(), () => "x", memoryStorage())).toEqual({ ok: false, reason: "persist_failed" });
    } finally {
      proto.add = add;
    }
    expect(await count("pending")).toBe(0);
  });

  it("unreadable records are UNRESOLVED (with their raw bytes); new actions refused", async () => {
    await put("pending", `${entryKey(P, "broken")}`, "{not json");
    const read = await readPendingStore(P, memoryStorage()) /* C6: null now means "legacy storage inaccessible" */;
    expect(read).toEqual({ status: "unresolved", reason: "unreadable_record", keys: [entryKey(P, "broken")], raws: { [entryKey(P, "broken")]: "{not json" } });
    expect(await beginPendingStore(sub(), () => "x", memoryStorage())).toEqual({ ok: false, reason: "unreadable_record" });
  });

  it("quarantine archives exact bytes, key, reference, actor, time, reason, unknown outcome — in ONE transaction", async () => {
    const key = entryKey(P, "req-7");
    await put("pending", key, '{"requestId":"req-7","to');
    const r = await quarantineStore(P, { key, expectedRaw: '{"requestId":"req-7","to', actor, reason: "torn", acknowledged: true }, () => "2026-10-24T12:00:00.000Z");
    expect(r.status).toBe("quarantined");
    expect(await raw("pending", key)).toBeNull();
    const views = await readQuarantineStore(P);
    expect(views).toMatchObject([{ kind: "record", record: { originalKey: key, rawValue: '{"requestId":"req-7","to', requestReference: "req-7",
      actor, quarantinedAt: "2026-10-24T12:00:00.000Z", reason: "torn", serverOutcome: "unknown" } }]);
    expect(await readPendingStore(P, memoryStorage()) /* C6: null now means "legacy storage inaccessible" */).toEqual({ status: "ok", entries: [] });
  });

  it("a failing archive write aborts the WHOLE transaction: original kept, nothing archived", async () => {
    const key = entryKey(P, "q2");
    await put("pending", key, "{torn");
    const proto = IDBObjectStore.prototype as unknown as { add: (...a: unknown[]) => unknown; name: string };
    const add = proto.add;
    proto.add = function (this: IDBObjectStore, ...a: unknown[]) {
      if (this.name === "quarantine") throw new DOMException("synthetic quota", "QuotaExceededError");
      return (add as (...x: unknown[]) => unknown).apply(this, a);
    };
    try {
      expect((await quarantineStore(P, { key, expectedRaw: "{torn", actor, reason: "r", acknowledged: true })).status).toBe("quarantine_failed");
    } finally {
      proto.add = add;
    }
    expect(await raw("pending", key)).toBe("{torn");
    expect(await count("quarantine")).toBe(0);
  });

  it("stale tab: changed / gone / repaired → nothing done; an existing archive is never overwritten", async () => {
    const key = entryKey(P, "s1");
    await put("pending", key, "{a");
    expect((await quarantineStore(P, { key, expectedRaw: "{b", actor, reason: "r", acknowledged: true })).status).toBe("changed");
    expect((await quarantineStore(P, { key: entryKey(P, "nope"), expectedRaw: "{a", actor, reason: "r", acknowledged: true })).status).toBe("gone");
    const good = JSON.stringify(entry("s2"));
    await put("pending", entryKey(P, "s2"), good);
    expect((await quarantineStore(P, { key: entryKey(P, "s2"), expectedRaw: good, actor, reason: "r", acknowledged: true })).status).toBe("repaired");

    expect((await quarantineStore(P, { key, expectedRaw: "{a", actor, reason: "first", acknowledged: true })).status).toBe("quarantined");
    await put("pending", key, "{different");
    expect((await quarantineStore(P, { key, expectedRaw: "{different", actor, reason: "second", acknowledged: true })).status).toBe("quarantine_failed");
    expect(await raw("pending", key)).toBe("{different");
    expect(JSON.parse((await raw("quarantine", quarantineKey(P, key))) as string)).toMatchObject({ rawValue: "{a", reason: "first" });
  });

  it("settlement removes only EXACTLY the entry's bytes; torn bytes stay for the owner", async () => {
    const e = entry("t1");
    await put("pending", entryKey(P, "t1"), JSON.stringify(e).slice(0, 25));
    expect(await settlePendingStore(e)).toBe("not_matching");
    expect(await raw("pending", entryKey(P, "t1"))).toBe(JSON.stringify(e).slice(0, 25));
    await put("pending", entryKey(P, "t1"), JSON.stringify(e));
    expect(await settlePendingStore(e)).toBe("settled");
    expect(await settlePendingStore(e)).toBe("absent");
  });
});

// ===========================================================================
describe("C5 forced races (replacement bytes always survive)", () => {
  it("SETTLE: replacement written after the final read, before removal → removal settles the ORIGINAL identity; the replacement survives", async () => {
    const e = entry("r1");
    const key = entryKey(P, "r1");
    await put("pending", key, JSON.stringify(e));
    const other = await competitor();
    setPendingStoreTestHooks({ afterConditionalRead: (op, k) => op === "settle" && k === key && other.write("pending", key, "REPLACEMENT-r1") });
    expect(await settlePendingStore(e)).toBe("settled");
    await other.finished();
    expect(await raw("pending", key)).toBe("REPLACEMENT-r1"); // ran after the atomic check+delete
  });

  it("QUARANTINE: replacement written after the final read, before removal → original archived exactly; replacement survives as a NEW unresolved record", async () => {
    const key = entryKey(P, "r2");
    await put("pending", key, "{original");
    const other = await competitor();
    setPendingStoreTestHooks({ afterConditionalRead: (op, k) => op === "quarantine" && k === key && other.write("pending", key, "{replacement") });
    expect((await quarantineStore(P, { key, expectedRaw: "{original", actor, reason: "r", acknowledged: true })).status).toBe("quarantined");
    await other.finished();
    setPendingStoreTestHooks({});
    expect(await raw("pending", key)).toBe("{replacement");
    expect(JSON.parse((await raw("quarantine", quarantineKey(P, key))) as string).rawValue).toBe("{original");
    expect(await readPendingStore(P, memoryStorage()) /* C6: null now means "legacy storage inaccessible" */).toMatchObject({ status: "unresolved", keys: [key] });
  });

  it("COMPLETION of an interrupted (pre-C5) quarantine: replacement during completion survives", async () => {
    const key = entryKey(P, "r3");
    const archive = { version: 1, projectId: P, originalKey: key, rawValue: "{r3", requestReference: "r3", quarantinedAt: "t",
      actor, reason: "r", serverOutcome: "unknown", acknowledgement: "a" };
    await put("quarantine", quarantineKey(P, key), JSON.stringify(archive));
    await put("pending", key, "{r3");
    const other = await competitor();
    setPendingStoreTestHooks({ afterConditionalRead: (op, k) => op === "complete" && k === key && other.write("pending", key, "{r3-replaced") });
    await readPendingStore(P, memoryStorage()) /* C6: null now means "legacy storage inaccessible" */; // completes: same bytes at read time → deletes inside the transaction
    await other.finished();
    setPendingStoreTestHooks({});
    expect(await raw("pending", key)).toBe("{r3-replaced");
    expect(JSON.parse((await raw("quarantine", quarantineKey(P, key))) as string).rawValue).toBe("{r3");
  });

  it("SIMULTANEOUS ARCHIVE CREATION from two tabs: exactly one archive (first reason), the other tab is told it was already handled", async () => {
    const key = entryKey(P, "r4");
    await put("pending", key, "{four");
    const results = await Promise.all([
      quarantineStore(P, { key, expectedRaw: "{four", actor, reason: "tab A", acknowledged: true }),
      quarantineStore(P, { key, expectedRaw: "{four", actor: { userId: "u2", label: "other" }, reason: "tab B", acknowledged: true }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["gone", "quarantined"]);
    expect(await count("quarantine")).toBe(1);
    const winner = results.find((r) => r.status === "quarantined") as { record: { reason: string } };
    expect(JSON.parse((await raw("quarantine", quarantineKey(P, key))) as string).reason).toBe(winner.record.reason);
  });

  it("SETTLEMENT RACING QUARANTINE, both orders: torn bytes → archived exactly, never settled; intact bytes → settled under the original identity, never archived", async () => {
    for (const order of ["settle-first", "quarantine-first"] as const) {
      setPendingStoreFactoryForTests((factory = new IDBFactory()));
      const e = entry("r5");
      const key = entryKey(P, "r5");
      // (a) torn bytes
      const torn = JSON.stringify(e).slice(0, 30);
      await put("pending", key, torn);
      let second: Promise<unknown> = Promise.resolve();
      setPendingStoreTestHooks({ afterConditionalRead: (op) => {
        if (order === "settle-first" && op === "settle") second = quarantineStore(P, { key, expectedRaw: torn, actor, reason: "race", acknowledged: true });
        if (order === "quarantine-first" && op === "quarantine") second = settlePendingStore(e);
        setPendingStoreTestHooks({});
      } });
      const first = order === "settle-first" ? await settlePendingStore(e) : (await quarantineStore(P, { key, expectedRaw: torn, actor, reason: "race", acknowledged: true })).status;
      const other = await second;
      const settleResult = order === "settle-first" ? first : other;
      expect(settleResult === "settled").toBe(false);
      expect(JSON.parse((await raw("quarantine", quarantineKey(P, key))) as string).rawValue).toBe(torn);
      expect(await raw("pending", key)).toBeNull();

      // (b) intact bytes
      setPendingStoreFactoryForTests((factory = new IDBFactory()));
      const intact = JSON.stringify(e);
      await put("pending", key, intact);
      second = Promise.resolve();
      setPendingStoreTestHooks({ afterConditionalRead: (op) => {
        if (order === "settle-first" && op === "settle") second = quarantineStore(P, { key, expectedRaw: intact, actor, reason: "race", acknowledged: true });
        if (order === "quarantine-first" && op === "quarantine") second = settlePendingStore(e);
        setPendingStoreTestHooks({});
      } });
      const s1 = order === "settle-first" ? await settlePendingStore(e) : (await quarantineStore(P, { key, expectedRaw: intact, actor, reason: "race", acknowledged: true })).status;
      const s2 = await second;
      const settleB = order === "settle-first" ? s1 : s2;
      const quarantineB = order === "settle-first" ? (s2 as { status: string }).status : s1;
      expect(settleB).toBe("settled");
      expect(["gone", "repaired"]).toContain(quarantineB);
      expect(await count("quarantine")).toBe(0);
      expect(await raw("pending", key)).toBeNull();
    }
  });
});

// ===========================================================================
describe("C5 migration from localStorage", () => {
  const lsKey = (id: string) => entryKey(P, id);

  it("copies every pending and quarantine key verbatim, records it, never removes the originals, never re-imports settled bytes", async () => {
    const ls = memoryStorage();
    const e1 = entry("m1");
    ls.setItem(lsKey("m1"), JSON.stringify(e1));
    ls.setItem(lsKey("m2"), "{torn");
    const qk = `${QUARANTINE_PREFIX}${P}:${encodeURIComponent(lsKey("old"))}`;
    ls.setItem(qk, JSON.stringify({ version: 1, projectId: P, originalKey: lsKey("old"), rawValue: "{old", requestReference: "old",
      quarantinedAt: "t", actor, reason: "r", serverOutcome: "unknown", acknowledgement: "a" }));
    ls.setItem("pos-canvas:inventory-pending:other-project:z", "{not ours");

    const read = await readPendingStore(P, ls);
    expect(read).toMatchObject({ status: "unresolved", keys: [lsKey("m2")] });
    expect(await raw("pending", lsKey("m1"))).toBe(JSON.stringify(e1));
    expect(await raw("pending", lsKey("m2"))).toBe("{torn");
    expect(await raw("quarantine", qk)).toBe(ls.getItem(qk));
    expect(await raw("pending", "pos-canvas:inventory-pending:other-project:z")).toBeNull();
    expect(ls.data.size).toBe(4); // originals preserved

    // settle m1 in IndexedDB; a reload must NOT resurrect it from the untouched localStorage copy
    expect(await settlePendingStore(e1)).toBe("settled");
    await readPendingStore(P, ls);
    expect(await raw("pending", lsKey("m1"))).toBeNull();
    // C6: one migration record per (key, exact bytes) — it holds exactly the bytes taken.
    const migDb = (await openPendingStore()) as IDBDatabase;
    const migRows = await new Promise<{ lsKey?: string; raw: string }[]>((r) => { const q = migDb.transaction("migration").objectStore("migration").getAll(); q.onsuccess = () => r(q.result); });
    migDb.close();
    expect(migRows.filter((m) => m.lsKey === lsKey("m1")).map((m) => m.raw)).toEqual([JSON.stringify(e1)]);
  });

  it("bytes an older tab rewrote in localStorage AFTER migration are kept as a separate unresolved copy; the IndexedDB record is untouched", async () => {
    const ls = memoryStorage();
    const e = entry("m3");
    ls.setItem(lsKey("m3"), JSON.stringify(e));
    await readPendingStore(P, ls);
    ls.setItem(lsKey("m3"), "{rewritten by an old tab");
    const read = await readPendingStore(P, ls);
    expect(await raw("pending", lsKey("m3"))).toBe(JSON.stringify(e));
    expect(read.status).toBe("unresolved");
    const copyKey = read.status === "unresolved" ? read.keys.find((k) => k.includes(":review-")) /* C6 copy-key name */ : undefined;
    expect(copyKey && (await raw("pending", copyKey))).toBe("{rewritten by an old tab");
  });

  it("INTERRUPTION/RELOAD during migration: a crash between keys leaves each key either fully migrated or untouched; the rerun completes it exactly once", async () => {
    const ls = memoryStorage();
    for (const id of ["a", "b", "c"]) ls.setItem(lsKey(id), JSON.stringify(entry(id)));
    let seen = 0;
    setPendingStoreTestHooks({ betweenMigrationKeys: () => {
      seen += 1;
      if (seen === 2) throw new Error("tab closed during migration");
    } });
    await expect(readPendingStore(P, ls)).rejects.toThrow("tab closed during migration");
    expect(await raw("pending", lsKey("a"))).toBe(JSON.stringify(entry("a")));
    expect(await raw("pending", lsKey("b"))).toBeNull();
    setPendingStoreTestHooks({});
    const read = await readPendingStore(P, ls); // "reload"
    expect(read.status === "ok" && read.entries.map((e) => e.requestId)).toEqual(["a", "b", "c"]);
    expect(await count("pending")).toBe(3);
    expect(ls.data.size).toBe(3);
    await readPendingStore(P, ls);
    expect(await count("pending")).toBe(3); // idempotent
  });

  it("a replacement written into IndexedDB during a key's migration transaction is never overwritten by the localStorage bytes", async () => {
    const ls = memoryStorage();
    ls.setItem(lsKey("m4"), "{from-localStorage");
    const db = await openPendingStore(); // create the schema before the race
    db?.close();
    const other = await competitor();
    setPendingStoreTestHooks({ afterConditionalRead: (op, k) => op === "migrate" && k === lsKey("m4") && other.write("pending", lsKey("m4"), "{written-meanwhile") });
    const ok = await migrateFromLocalStorage((await openPendingStore()) as IDBDatabase, ls, P);
    await other.finished();
    setPendingStoreTestHooks({});
    expect(ok).toBe(true);
    // The migration ran first (added the localStorage bytes); the concurrent write ran after — and is what remains.
    expect(await raw("pending", lsKey("m4"))).toBe("{written-meanwhile");
    expect(ls.getItem(lsKey("m4"))).toBe("{from-localStorage"); // original preserved
    await readPendingStore(P, ls); // a reload: the recorded migration stops a re-import over it
    expect(await raw("pending", lsKey("m4"))).toBe("{written-meanwhile");
  });

  it("the database name is stable", () => {
    expect(PENDING_DB_NAME).toBe("pos-canvas-inventory-pending");
  });
});
