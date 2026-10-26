// W-02-RETRY-UX-FIX-2 — Retry decides and moves the record in ONE transaction,
// against the record actually being mutated.
//
// THE GAP CLOSED. In FIX-1 the Retry action read the record, read the
// uncertain-sale evidence and then called startOperatorRetry, which read and
// wrote again — three transactions. A marker armed, or the record advanced by
// another action, between the check and the write was not seen by the write.
//
// Real modules: saleQueueSession, rejectedSaleSession, deviceOfflineStore,
// uncertainSaleRecord, saleQueue. Storage: fake-indexeddb. The only
// simulations are failures and interleavings injected at IDBObjectStore.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enqueueSale, getSaleByRequestId } from "@/lib/saleQueueSession";
import { transitionQueuedSale, beginOperatorRetry } from "@/lib/saleQueue";
import type { QueuedSale } from "@/lib/saleQueue";
import { CACHE_STORE, SALE_QUEUE_STORE, openOfflineDb, putQueuedSale } from "@/lib/deviceOfflineStore";
import { UNCERTAIN_SALE_KEY } from "@/lib/uncertainSaleRecord";
import { discardRejectedSale, listRejectedSaleReviews, retryRejectedSale } from "@/lib/rejectedSaleSession";

const IDENTITY = {
  deviceAuthUserId: "11111111-1111-4111-8111-111111111111",
  deviceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  buildJobId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};
const SALE_ID = "9e9e0000-0000-4000-8000-00000000009e";
const QID = "q-atomic-1";
const EMPLOYEE_SESSION = "5e550000-0000-4000-8000-000000000001";
const REGISTER = "f0000000-0000-4000-8000-0000000000f1";
const OCCURRED = "2026-10-15T09:00:00.000Z";
const QUEUED_AT = "2026-10-15T09:00:01.000Z";

type Proto = Record<string, (...a: unknown[]) => IDBRequest>;
const restores: (() => void)[] = [];

async function withDb<T>(run: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const opened = await openOfflineDb();

  if (!opened.ok) throw new Error("storage did not open");

  try {
    return await run(opened.value);
  } finally {
    opened.value.close();
  }
}

async function seed(lastErrorCode = "transport_attempts_exhausted"): Promise<QueuedSale> {
  const enqueued = await enqueueSale({
    saleRequestId: SALE_ID,
    queueRecordId: QID,
    ...IDENTITY,
    paymentMethod: "card",
    items: [{ itemId: "item-1", quantity: 2, modifiers: [{ groupId: "g1", optionIds: ["o1"] }] }],
    occurredAt: OCCURRED,
    now: QUEUED_AT,
    employeePosSessionId: EMPLOYEE_SESSION,
    registerSessionId: REGISTER,
  });

  if (!enqueued.ok) throw new Error(`seed failed: ${enqueued.reason}`);

  const syncing = transitionQueuedSale(enqueued.value, "syncing", "2026-10-15T09:01:00.000Z");

  if (!syncing.ok) throw new Error("seed transition 1");

  const attention = transitionQueuedSale(syncing.record, "needs_attention", "2026-10-15T09:02:00.000Z", {
    lastErrorCode,
    lastErrorMessage: "W-02 synthetic",
  });

  if (!attention.ok) throw new Error("seed transition 2");

  const record = { ...attention.record, attemptCount: 10 };

  await withDb((db) => putQueuedSale(db, record));

  return record;
}

async function current(): Promise<QueuedSale> {
  const read = await getSaleByRequestId(SALE_ID);

  if (!read.ok) throw new Error(`read failed: ${read.reason}`);

  return read.value;
}

function onStore(method: "get" | "put", storeName: string, how: "throw" | "abort_after_success", key?: unknown) {
  const proto = IDBObjectStore.prototype as unknown as Proto;
  const original = proto[method];
  const hits: string[] = [];

  proto[method] = function (this: IDBObjectStore, ...args: unknown[]) {
    const matches = this.name === storeName && (key === undefined || args[0] === key);

    if (matches && how === "throw") {
      hits.push(`${method}:${storeName}:throw`);
      throw new DOMException("W-02 injected synchronous failure", "UnknownError");
    }

    const request = original.apply(this, args);

    if (matches && how === "abort_after_success") {
      const tx = this.transaction;

      hits.push(`${method}:${storeName}:abort_after_success`);
      request.addEventListener("success", () => {
        try {
          tx.abort();
        } catch {
          // already finished
        }
      });
    }

    return request;
  };

  const restore = () => {
    proto[method] = original;
  };

  restores.push(restore);

  return { hits, restore };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

// ===========================================================================

describe("FIX-2 atomic Retry: established behaviour is preserved", () => {
  it("healthy Retry applies exactly beginOperatorRetry's transition and keeps everything else", async () => {
    const before = await seed();
    const result = await retryRejectedSale(QID);
    const after = await current();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The SAME transition startOperatorRetry applied: compute it from the
    // pre-state with the timestamp the call actually wrote.
    const expected = beginOperatorRetry(before, after.updatedAt);

    expect(expected.ok).toBe(true);
    if (!expected.ok) return;
    expect(after).toEqual(expected.record);
    expect(result.record).toEqual(after);

    // Spelled out, because these are the fields that must never move.
    expect(after).toMatchObject({
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      saleRequestId: SALE_ID,
      queueRecordId: QID,
      occurredAt: OCCURRED,
      queuedAt: QUEUED_AT,
      employeePosSessionId: EMPLOYEE_SESSION,
      registerSessionId: REGISTER,
      items: before.items,
      paymentMethod: "card",
      serverOrderId: null,
    });
    expect(after.updatedAt).not.toBe(before.updatedAt);
  });

  it("an unknown queue record is not_found; a non-retryable code is refused and untouched", async () => {
    expect(await retryRejectedSale("no-such-record")).toEqual({ ok: false, reason: "not_found" });

    await seed("post_revocation");
    expect(await retryRejectedSale(QID)).toEqual({ ok: false, reason: "not_retryable" });
    expect((await current()).state).toBe("needs_attention");
  });
});

describe("FIX-2 atomic Retry: the decision is made against the record being mutated", () => {
  it("two concurrent Retries: exactly one moves the record; the other is refused BY POLICY on the moved record", async () => {
    await seed();

    const results = await Promise.all([retryRejectedSale(QID), retryRejectedSale(QID)]);
    const okCount = results.filter((r) => r.ok).length;
    const refused = results.find((r) => !r.ok);

    expect(okCount).toBe(1);
    expect(refused).toEqual({ ok: false, reason: "not_needs_attention" });
    expect((await current()).state).toBe("pending");
  });

  it("a record advanced by another action after Review offered Retry is not reset or overwritten", async () => {
    await seed();
    expect((await listRejectedSaleReviews())[0].retry).toEqual({ allowed: true });

    // Another action: an operator retry elsewhere, then the engine claimed it.
    const moved = beginOperatorRetry(await current(), "2026-10-15T09:05:00.000Z");

    if (!moved.ok) throw new Error("setup");

    const claimed = transitionQueuedSale(moved.record, "syncing", "2026-10-15T09:05:01.000Z");

    if (!claimed.ok) throw new Error("setup");

    const advanced = { ...claimed.record, attemptCount: 3 };

    await withDb((db) => putQueuedSale(db, advanced));

    expect(await retryRejectedSale(QID)).toEqual({ ok: false, reason: "not_needs_attention" });
    expect(await current()).toEqual(advanced);
  });

  it("a marker armed WHILE the Retry is in flight is serialized: no transition is committed after it", async () => {
    await seed();

    // When the Retry's own marker read succeeds, another actor immediately
    // arms an uncertain-sale marker for THIS sale in its own transaction.
    const order: string[] = [];
    const proto = IDBObjectStore.prototype as unknown as Proto;
    const realGet = proto.get;
    const realPut = proto.put;
    let armed = false;

    proto.get = function (this: IDBObjectStore, ...args: unknown[]) {
      const request = realGet.apply(this, args);

      if (!armed && this.name === CACHE_STORE && args[0] === UNCERTAIN_SALE_KEY) {
        armed = true;
        request.addEventListener("success", () => {
          void withDb(
            (db) =>
              new Promise<void>((resolve) => {
                const tx = db.transaction(CACHE_STORE, "readwrite");

                tx.objectStore(CACHE_STORE).put({ schemaVersion: 99, saleRequestId: SALE_ID }, UNCERTAIN_SALE_KEY);
                tx.oncomplete = () => {
                  order.push("marker_committed");
                  resolve();
                };
                tx.onabort = () => resolve();
              })
          );
        });
      }

      return request;
    };
    proto.put = function (this: IDBObjectStore, ...args: unknown[]) {
      const request = realPut.apply(this, args);

      if (this.name === SALE_QUEUE_STORE) {
        const tx = this.transaction;

        tx.addEventListener("complete", () => order.push(`queue_write_committed:${(args[0] as QueuedSale).state}`));
      }

      return request;
    };
    restores.push(() => {
      proto.get = realGet;
      proto.put = realPut;
    });

    const result = await retryRejectedSale(QID);

    await new Promise((r) => setTimeout(r, 50));

    const final = await current();
    const queueCommit = order.findIndex((e) => e.startsWith("queue_write_committed"));
    const markerCommit = order.indexOf("marker_committed");

    // SERIALIZABLE: either the Retry committed BEFORE the marker existed, or it
    // was refused. A pending record committed after the marker is the race.
    if (final.state === "pending") {
      expect(result.ok).toBe(true);
      expect(queueCommit).toBeGreaterThanOrEqual(0);
      expect(markerCommit).toBeGreaterThan(queueCommit);
    } else {
      expect(result.ok).toBe(false);
      expect(final.state).toBe("needs_attention");
    }

    expect({ order, finalState: final.state, result }).toBeTruthy();
  });
});

describe("FIX-2 atomic Retry: failures inside the transaction refuse and commit nothing", () => {
  it("a synchronous throw from the marker read refuses Retry and leaves the record untouched", async () => {
    const before = await seed();
    const { hits, restore } = onStore("get", CACHE_STORE, "throw", UNCERTAIN_SALE_KEY);
    const result = await retryRejectedSale(QID);

    restore();
    expect(hits.length).toBeGreaterThan(0);
    expect(result).toEqual({ ok: false, reason: "storage_unavailable" });
    expect(await current()).toEqual(before);
  });

  it("a transaction that aborts after the Retry write request succeeded cannot report success", async () => {
    const before = await seed();
    const { hits, restore } = onStore("put", SALE_QUEUE_STORE, "abort_after_success");
    const result = await retryRejectedSale(QID);

    restore();
    expect(hits.length).toBeGreaterThan(0);
    expect(result).toEqual({ ok: false, reason: "storage_unavailable" });
    expect(await current()).toEqual(before);
  });

  it("a synchronous throw from the Retry write refuses and leaves the record untouched", async () => {
    const before = await seed();
    const { hits, restore } = onStore("put", SALE_QUEUE_STORE, "throw");
    const result = await retryRejectedSale(QID);

    restore();
    expect(hits.length).toBeGreaterThan(0);
    expect(result).toEqual({ ok: false, reason: "storage_unavailable" });
    expect(await current()).toEqual(before);
  });
});

describe("FIX-2 Discard: permission checks and failure handling are intact", () => {
  it("a terminally rejected sale is discarded once, keeping its rejection code", async () => {
    await seed("post_revocation");

    const result = await discardRejectedSale(QID, { allowed: false });
    const after = await current();

    expect(result.ok).toBe(true);
    expect(after.state).toBe("discarded");
    expect(after.lastErrorCode).toBe("post_revocation");
    expect(await discardRejectedSale(QID, { allowed: true })).toEqual({ ok: false, reason: "not_needs_attention" });
  });

  it("a register-blocked sale refuses Discard without a permitted reviewer", async () => {
    await seed("register_unverified");

    expect(await discardRejectedSale(QID, { allowed: false })).toEqual({ ok: false, reason: "reviewer_not_permitted" });
    expect((await current()).state).toBe("needs_attention");
  });

  it("a synchronous marker-read throw during Discard refuses it and leaves the record untouched", async () => {
    const before = await seed("post_revocation");
    const { hits, restore } = onStore("get", CACHE_STORE, "throw", UNCERTAIN_SALE_KEY);
    const result = await discardRejectedSale(QID, { allowed: true });

    restore();
    expect(hits.length).toBeGreaterThan(0);
    expect(result).toEqual({ ok: false, reason: "storage_unavailable" });
    expect(await current()).toEqual(before);
  });
});
