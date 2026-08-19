// Feature 24.5C — the durable queue, exercised against a real IndexedDB engine.
//
// Opts into fake-indexeddb the same way lib/deviceOfflineStore.test.ts does, so
// vitest.config.ts stays a plain node environment for every other file. The
// shim implements the real specification, so the v1 -> v2 upgrade, the unique
// index and transaction semantics are genuinely exercised rather than mocked.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CACHE_STORE,
  OFFLINE_DB_NAME,
  OFFLINE_DB_VERSION,
  SALE_QUEUE_REQUEST_ID_INDEX,
  SALE_QUEUE_STORE,
  openOfflineDb,
  readPairingAssertionRecord,
  readPinnedConfigRecord,
  writePairingAssertionRecord,
  writePinnedConfigRecord,
} from "@/lib/deviceOfflineStore";
import {
  countQueuedSales,
  deleteSyncedSale,
  enqueueSale,
  getQueueSummary,
  getQueuedSale,
  getSaleByRequestId,
  listPendingSales,
  listQueuedSales,
  markAttempt,
  recoverInterruptedSyncs,
  updateQueueState,
} from "@/lib/saleQueueSession";
import type { EnqueueSaleInput } from "@/lib/saleQueueSession";

const NOW = "2026-08-19T12:00:00.000Z";

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

let seq = 0;

function input(overrides: Partial<EnqueueSaleInput> = {}): EnqueueSaleInput {
  seq += 1;

  return {
    queueRecordId: `q-${seq}`,
    saleRequestId: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    deviceAuthUserId: "22222222-2222-4222-8222-222222222222",
    deviceId: "33333333-3333-4333-8333-333333333333",
    projectId: "44444444-4444-4444-8444-444444444444",
    buildJobId: "55555555-5555-4555-8555-555555555555",
    paymentMethod: "cash",
    items: [{ itemId: "item-1", quantity: 1, modifiers: [] }],
    occurredAt: "2026-08-19T11:00:00.000Z",
    now: `2026-08-19T11:00:${String(seq).padStart(2, "0")}.000Z`,
    ...overrides,
  };
}

/** Opens the database at an explicit version, the way a v1 install would have. */
function openAtVersion(version: number, upgrade: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(OFFLINE_DB_NAME, version);

    request.onupgradeneeded = () => upgrade(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

describe("the database upgrades from v1 to v2 without losing anything", () => {
  it("a fresh install creates both stores at version 2", async () => {
    const opened = await openOfflineDb();

    expect(opened.ok).toBe(true);

    if (!opened.ok) return;

    expect(opened.value.version).toBe(OFFLINE_DB_VERSION);
    expect(OFFLINE_DB_VERSION).toBe(2);
    expect(opened.value.objectStoreNames.contains(CACHE_STORE)).toBe(true);
    expect(opened.value.objectStoreNames.contains(SALE_QUEUE_STORE)).toBe(true);

    opened.value.close();
  });

  it("an existing v1 device keeps its cached config and pairing assertion", async () => {
    // THE MIGRATION THAT MATTERS. A till that has been running 24.5A holds a
    // pinned config it may be relying on to open offline. The upgrade must not
    // cost it that.
    const v1 = await openAtVersion(1, (db) => {
      db.createObjectStore(CACHE_STORE);
    });

    expect(v1.version).toBe(1);
    expect(v1.objectStoreNames.contains(SALE_QUEUE_STORE)).toBe(false);

    await writePairingAssertionRecord(v1, { marker: "assertion-from-v1" });
    await writePinnedConfigRecord(v1, { marker: "config-from-v1" });
    v1.close();

    const upgraded = await openOfflineDb();

    expect(upgraded.ok).toBe(true);

    if (!upgraded.ok) return;

    expect(upgraded.value.version).toBe(2);
    expect(upgraded.value.objectStoreNames.contains(SALE_QUEUE_STORE)).toBe(true);

    const assertion = await readPairingAssertionRecord(upgraded.value);
    const config = await readPinnedConfigRecord(upgraded.value);

    expect(assertion.ok === true && assertion.value).toEqual({ marker: "assertion-from-v1" });
    expect(config.ok === true && config.value).toEqual({ marker: "config-from-v1" });

    upgraded.value.close();
  });

  it("the queue store is keyed by queueRecordId with a UNIQUE sale-request index", async () => {
    const opened = await openOfflineDb();

    if (!opened.ok) throw new Error("unreachable");

    const tx = opened.value.transaction(SALE_QUEUE_STORE, "readonly");
    const store = tx.objectStore(SALE_QUEUE_STORE);

    expect(store.keyPath).toBe("queueRecordId");
    expect(store.index(SALE_QUEUE_REQUEST_ID_INDEX).unique).toBe(true);
    expect(store.index(SALE_QUEUE_REQUEST_ID_INDEX).keyPath).toBe("saleRequestId");

    opened.value.close();
  });

  it("upgrading twice is idempotent", async () => {
    const first = await openOfflineDb();

    if (first.ok) first.value.close();

    const second = await openOfflineDb();

    expect(second.ok).toBe(true);
    expect(second.ok === true && second.value.version).toBe(2);

    if (second.ok) second.value.close();
  });
});

// ---------------------------------------------------------------------------
// Enqueue and durability
// ---------------------------------------------------------------------------

describe("enqueue is durable and all-or-nothing", () => {
  it("persists a complete record", async () => {
    const enqueued = await enqueueSale(input({ queueRecordId: "q-a" }));

    expect(enqueued.ok).toBe(true);

    const read = await getQueuedSale("q-a");

    expect(read.ok).toBe(true);

    if (!read.ok) return;

    expect(read.value.state).toBe("pending");
    expect(read.value.source).toBe("offline_queued");
    expect(read.value.tipAmount).toBe(0);
    expect(read.value.attemptCount).toBe(0);
  });

  it("survives a simulated reload — a new connection sees the queue", async () => {
    await enqueueSale(input({ queueRecordId: "q-reload" }));

    // A reload is a fresh open of the same database, which is exactly what
    // every call in this module does.
    const listing = await listQueuedSales();

    expect(listing.ok === true && listing.value.sales.map((s) => s.queueRecordId)).toContain(
      "q-reload"
    );
  });

  it("preserves device, project and pinned-build identity", async () => {
    await enqueueSale(input({ queueRecordId: "q-id" }));

    const read = await getQueuedSale("q-id");

    if (!read.ok) throw new Error("unreachable");

    expect(read.value.deviceAuthUserId).toBe("22222222-2222-4222-8222-222222222222");
    expect(read.value.deviceId).toBe("33333333-3333-4333-8333-333333333333");
    expect(read.value.projectId).toBe("44444444-4444-4444-8444-444444444444");
    expect(read.value.buildJobId).toBe("55555555-5555-4555-8555-555555555555");
  });

  it("persists a cash sale", async () => {
    await enqueueSale(input({ queueRecordId: "q-cash", paymentMethod: "cash" }));

    const read = await getQueuedSale("q-cash");

    expect(read.ok === true && read.value.paymentMethod).toBe("cash");
  });

  it("persists a card sale as a LABEL, with no card data anywhere", async () => {
    await enqueueSale(input({ queueRecordId: "q-card", paymentMethod: "card" }));

    const read = await getQueuedSale("q-card");

    if (!read.ok) throw new Error("unreachable");

    expect(read.value.paymentMethod).toBe("card");

    // POS Canvas never receives card data, so there is nothing to store — and
    // the record's shape gives it nowhere to live.
    const serialized = JSON.stringify(read.value).toLowerCase();

    for (const banned of ["pan", "cvv", "cardnumber", "expiry", "cardholder", "track2"]) {
      expect(`record contains ${banned}`).toBe(`record contains ${banned}`);
      expect(serialized).not.toContain(banned);
    }
  });

  it("refuses a record it could not read back", async () => {
    const bad = await enqueueSale(input({ items: [] }));

    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.reason).toBe("corrupt_record");

    // And nothing was written.
    expect((await countQueuedSales()).ok === true && (await countQueuedSales())).toEqual({
      ok: true,
      value: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("one sale, one idempotency key", () => {
  it("rejects a second record claiming the same sale_request_id", async () => {
    const first = await enqueueSale(input({ queueRecordId: "q-1", saleRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }));
    const second = await enqueueSale(input({ queueRecordId: "q-2", saleRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.reason).toBe("duplicate_sale_request");

    const count = await countQueuedSales();

    expect(count.ok === true && count.value).toBe(1);
  });

  it("the persisted key is the one the caller supplied, unchanged", async () => {
    // enqueueSale must never mint its own key: a function that did would
    // produce a new one on every retry, which is how a crash becomes two sales.
    await enqueueSale(input({ queueRecordId: "q-k", saleRequestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }));

    const read = await getQueuedSale("q-k");

    expect(read.ok === true && read.value.saleRequestId).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });

  it("the key is stable across state changes and attempts", async () => {
    await enqueueSale(input({ queueRecordId: "q-s", saleRequestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }));
    await updateQueueState("q-s", "syncing", NOW);
    await markAttempt("q-s", NOW);
    await updateQueueState("q-s", "pending", NOW);
    await updateQueueState("q-s", "syncing", NOW);

    const read = await getQueuedSale("q-s");

    expect(read.ok === true && read.value.saleRequestId).toBe("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    expect(read.ok === true && read.value.attemptCount).toBe(1);
  });

  it("is findable by request id, the server's identity for the sale", async () => {
    await enqueueSale(input({ queueRecordId: "q-f", saleRequestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }));

    const found = await getSaleByRequestId("dddddddd-dddd-4ddd-8ddd-dddddddddddd");

    expect(found.ok === true && found.value.queueRecordId).toBe("q-f");

    const missing = await getSaleByRequestId("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");

    expect(missing.ok === false && missing.reason).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// State transitions through storage
// ---------------------------------------------------------------------------

describe("state transitions are enforced on the stored record", () => {
  it("applies a legal transition and persists it", async () => {
    await enqueueSale(input({ queueRecordId: "q-t" }));

    const moved = await updateQueueState("q-t", "syncing", NOW);

    expect(moved.ok).toBe(true);

    const read = await getQueuedSale("q-t");

    expect(read.ok === true && read.value.state).toBe("syncing");
  });

  it("refuses an illegal transition and leaves the record untouched", async () => {
    await enqueueSale(input({ queueRecordId: "q-i" }));
    await updateQueueState("q-i", "syncing", NOW);
    await updateQueueState("q-i", "synced", NOW);

    const illegal = await updateQueueState("q-i", "pending", NOW);

    expect(illegal.ok).toBe(false);
    expect(illegal.ok === false && illegal.reason).toBe("illegal_transition");

    const read = await getQueuedSale("q-i");

    expect(read.ok === true && read.value.state).toBe("synced");
  });

  it("records the failure reason on needs_attention", async () => {
    await enqueueSale(input({ queueRecordId: "q-n" }));
    await updateQueueState("q-n", "syncing", NOW);
    await updateQueueState("q-n", "needs_attention", NOW, {
      lastErrorCode: "P0001",
      lastErrorMessage: "Offline sale time is older than the offline limit",
    });

    const read = await getQueuedSale("q-n");

    expect(read.ok === true && read.value.lastErrorCode).toBe("P0001");
    expect(read.ok === true && read.value.lastErrorMessage).toContain("older than");
  });

  it("attempt metadata persists across a reopen", async () => {
    await enqueueSale(input({ queueRecordId: "q-m" }));
    await updateQueueState("q-m", "syncing", NOW);
    await markAttempt("q-m", NOW);
    await markAttempt("q-m", NOW);

    const read = await getQueuedSale("q-m");

    expect(read.ok === true && read.value.attemptCount).toBe(2);
    expect(read.ok === true && read.value.lastAttemptAt).toBe(NOW);
  });
});

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

describe("startup recovery of interrupted syncs", () => {
  it("returns stranded syncing records to pending", async () => {
    await enqueueSale(input({ queueRecordId: "q-r1" }));
    await enqueueSale(input({ queueRecordId: "q-r2" }));
    await updateQueueState("q-r1", "syncing", NOW);
    await updateQueueState("q-r2", "syncing", NOW);
    await markAttempt("q-r1", NOW);

    const report = await recoverInterruptedSyncs(NOW);

    expect(report.ok === true && report.value.recovered).toBe(2);

    const pending = await listPendingSales();

    expect(pending.ok === true && pending.value.map((s) => s.queueRecordId).sort()).toEqual([
      "q-r1",
      "q-r2",
    ]);

    // Attempt history survives, so a record that keeps dying still reaches a cap.
    const read = await getQueuedSale("q-r1");

    expect(read.ok === true && read.value.attemptCount).toBe(1);
  });

  it("does nothing when no record is stranded", async () => {
    await enqueueSale(input({ queueRecordId: "q-ok" }));

    const report = await recoverInterruptedSyncs(NOW);

    expect(report.ok === true && report.value.recovered).toBe(0);
  });

  it("does not resurrect a synced record", async () => {
    await enqueueSale(input({ queueRecordId: "q-done" }));
    await updateQueueState("q-done", "syncing", NOW);
    await updateQueueState("q-done", "synced", NOW);

    await recoverInterruptedSyncs(NOW);

    const read = await getQueuedSale("q-done");

    expect(read.ok === true && read.value.state).toBe("synced");
  });
});

// ---------------------------------------------------------------------------
// Listing, counts, corruption, cleanup
// ---------------------------------------------------------------------------

describe("listing, counts and corruption", () => {
  it("lists FIFO regardless of insertion order", async () => {
    await enqueueSale(input({ queueRecordId: "q-late", now: "2026-08-19T11:00:09.000Z" }));
    await enqueueSale(input({ queueRecordId: "q-early", now: "2026-08-19T11:00:01.000Z" }));

    const listing = await listQueuedSales();

    expect(listing.ok === true && listing.value.sales.map((s) => s.queueRecordId)).toEqual([
      "q-early",
      "q-late",
    ]);
  });

  it("counts every state correctly", async () => {
    await enqueueSale(input({ queueRecordId: "s1" }));
    await enqueueSale(input({ queueRecordId: "s2" }));
    await enqueueSale(input({ queueRecordId: "s3" }));
    await updateQueueState("s2", "syncing", NOW);
    await updateQueueState("s3", "syncing", NOW);
    await updateQueueState("s3", "needs_attention", NOW);

    const summary = await getQueueSummary();

    if (!summary.ok) throw new Error("unreachable");

    expect(summary.value.pending).toBe(1);
    expect(summary.value.syncing).toBe(1);
    expect(summary.value.needsAttention).toBe(1);
    expect(summary.value.outstanding).toBe(3);
    expect(summary.value.total).toBe(3);
  });

  it("quarantines a corrupt record instead of dropping it", async () => {
    await enqueueSale(input({ queueRecordId: "q-good" }));

    // Write a structurally broken row straight past the API, as a torn write or
    // a hand-edited profile would.
    const opened = await openOfflineDb();

    if (!opened.ok) throw new Error("unreachable");

    await new Promise<void>((resolve) => {
      const tx = opened.value.transaction(SALE_QUEUE_STORE, "readwrite");
      tx.objectStore(SALE_QUEUE_STORE).put({ queueRecordId: "q-bad", saleRequestId: "not-a-uuid" });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    opened.value.close();

    const listing = await listQueuedSales();

    if (!listing.ok) throw new Error("unreachable");

    // The good one still reads; the bad one is reported, not silently skipped.
    expect(listing.value.sales.map((s) => s.queueRecordId)).toEqual(["q-good"]);
    expect(listing.value.quarantined).toEqual([
      { queueRecordId: "q-bad", reason: "unsupported_schema" },
    ]);

    // And it is still on disk — money is never deleted because it is unreadable.
    const count = await countQueuedSales();

    expect(count.ok === true && count.value).toBe(2);
  });

  it("deletes only a SYNCED record, and only the one named", async () => {
    await enqueueSale(input({ queueRecordId: "d1" }));
    await enqueueSale(input({ queueRecordId: "d2" }));
    await updateQueueState("d1", "syncing", NOW);
    await updateQueueState("d1", "synced", NOW);

    const deleted = await deleteSyncedSale("d1");

    expect(deleted.ok).toBe(true);

    const remaining = await listQueuedSales();

    expect(remaining.ok === true && remaining.value.sales.map((s) => s.queueRecordId)).toEqual([
      "d2",
    ]);
  });

  it("refuses to delete anything not yet synced", async () => {
    await enqueueSale(input({ queueRecordId: "keep" }));

    const refused = await deleteSyncedSale("keep");

    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toBe("illegal_transition");

    const count = await countQueuedSales();

    expect(count.ok === true && count.value).toBe(1);
  });

  it("reports not_found rather than inventing a record", async () => {
    expect((await getQueuedSale("nope")).ok).toBe(false);
    expect((await updateQueueState("nope", "syncing", NOW)).ok).toBe(false);
    expect((await markAttempt("nope", NOW)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 24.5A must keep working
// ---------------------------------------------------------------------------

describe("the 24.5A config cache is unaffected", () => {
  it("cache reads and writes still work alongside a populated queue", async () => {
    await enqueueSale(input({ queueRecordId: "coexist" }));

    const opened = await openOfflineDb();

    if (!opened.ok) throw new Error("unreachable");

    await writePinnedConfigRecord(opened.value, { marker: "still-here" });

    const config = await readPinnedConfigRecord(opened.value);

    expect(config.ok === true && config.value).toEqual({ marker: "still-here" });

    opened.value.close();

    // And the queue is untouched by cache activity.
    const count = await countQueuedSales();

    expect(count.ok === true && count.value).toBe(1);
  });
});
