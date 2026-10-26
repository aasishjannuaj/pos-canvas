// W-02-RETRY-UX-FIX-1 — Retry of a rejected sale must FAIL CLOSED on
// uncertain-sale evidence it cannot read.
//
// THE DEFECT. rejectedSaleSession read the uncertain-sale marker through the
// legacy readUncertainSale, which reports a storage failure as "none". Both the
// review (what is offered) and retryRejectedSale (what is done) then treated
// "could not look" as "nothing there", so a transient read failure let Retry
// proceed against policy. W-02-APP-VERIFY-1 reproduced it in the real app.
//
// Real modules throughout: saleQueueSession, rejectedSaleSession,
// deviceOfflineStore, uncertainSaleRecord. Storage is fake-indexeddb; the only
// simulation is a failure injected at IDBObjectStore.get for the marker key, or
// an IndexedDB factory that cannot open.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enqueueSale, getSaleByRequestId } from "@/lib/saleQueueSession";
import { transitionQueuedSale } from "@/lib/saleQueue";
import { openOfflineDb, putQueuedSale, writeUncertainSaleRecordRaw } from "@/lib/deviceOfflineStore";
import { buildUncertainSaleRecord, UNCERTAIN_SALE_KEY } from "@/lib/uncertainSaleRecord";
import { listRejectedSaleReviews, retryRejectedSale } from "@/lib/rejectedSaleSession";

const IDENTITY = {
  deviceAuthUserId: "11111111-1111-4111-8111-111111111111",
  deviceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  buildJobId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};
const QUEUED_ID = "9e9e0000-0000-4000-8000-00000000009e";
const OTHER_ID = "0a0a0000-0000-4000-8000-0000000000a0";
const EMPLOYEE_SESSION = "5e550000-0000-4000-8000-000000000001";
const REGISTER = "f0000000-0000-4000-8000-0000000000f1";
const NOW = "2026-10-14T12:00:00.000Z";

const restores: (() => void)[] = [];

function failMarkerReads() {
  const proto = IDBObjectStore.prototype as unknown as Record<string, (...a: unknown[]) => IDBRequest>;
  const original = proto.get;

  proto.get = function (this: IDBObjectStore, ...args: unknown[]) {
    if (this.name === "device-cache" && args[0] === UNCERTAIN_SALE_KEY) {
      throw new DOMException("W-02 injected marker read failure", "UnknownError");
    }

    return original.apply(this, args);
  };

  const restore = () => {
    proto.get = original;
  };

  restores.push(restore);

  return restore;
}

async function seedNeedsAttention() {
  const enqueued = await enqueueSale({
    saleRequestId: QUEUED_ID,
    queueRecordId: "q-legacy-1",
    ...IDENTITY,
    paymentMethod: "card",
    items: [{ itemId: "item-1", quantity: 1, modifiers: [] }],
    occurredAt: NOW,
    now: NOW,
    employeePosSessionId: EMPLOYEE_SESSION,
    registerSessionId: REGISTER,
  });

  if (!enqueued.ok) throw new Error(`seed enqueue failed: ${enqueued.reason}`);

  const syncing = transitionQueuedSale(enqueued.value, "syncing", NOW);

  if (!syncing.ok) throw new Error("seed transition 1 failed");

  const attention = transitionQueuedSale(syncing.record, "needs_attention", NOW, {
    lastErrorCode: "transport_attempts_exhausted",
    lastErrorMessage: "W-02 synthetic: attempts exhausted",
  });

  if (!attention.ok) throw new Error("seed transition 2 failed");

  await withDb((db) => putQueuedSale(db, attention.record));

  return attention.record;
}

async function withDb<T>(run: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const opened = await openOfflineDb();

  if (!opened.ok) throw new Error("storage did not open");

  try {
    return await run(opened.value);
  } finally {
    opened.value.close();
  }
}

function markerFor(saleRequestId: string, identity = IDENTITY) {
  return buildUncertainSaleRecord({
    sale: {
      saleRequestId,
      projectId: identity.projectId,
      paymentMethod: "card",
      tipAmount: 0,
      items: [{ itemId: "item-2", quantity: 1, modifiers: [] }],
      fingerprint: `fp-${saleRequestId}`,
    },
    identity,
    dispatchedAt: NOW,
  });
}

async function writeMarker(value: unknown) {
  const written = await withDb((db) => writeUncertainSaleRecordRaw(db, value));

  expect(written.ok).toBe(true);
}

async function queuedState() {
  const read = await getSaleByRequestId(QUEUED_ID);

  return read.ok ? { state: read.value.state, attemptCount: read.value.attemptCount, employeePosSessionId: read.value.employeePosSessionId, registerSessionId: read.value.registerSessionId, saleRequestId: read.value.saleRequestId } : { error: read.reason };
}

async function reviewRetry() {
  const reviews = await listRejectedSaleReviews();

  return reviews.find((r) => r.record.saleRequestId === QUEUED_ID)?.retry ?? null;
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

// ===========================================================================

describe("RETRY-UX FIX 1: permitted cases are unchanged", () => {
  it("verified absence: Retry is offered and moves the record to pending", async () => {
    await seedNeedsAttention();

    expect(await reviewRetry()).toEqual({ allowed: true });

    const result = await retryRejectedSale("q-legacy-1");

    expect(result.ok).toBe(true);
    expect(await queuedState()).toMatchObject({
      state: "pending",
      attemptCount: 0,
      saleRequestId: QUEUED_ID,
      employeePosSessionId: EMPLOYEE_SESSION,
      registerSessionId: REGISTER,
    });
  });

  it("a readable marker for a DIFFERENT sale of this pairing does not block Retry", async () => {
    await seedNeedsAttention();
    await writeMarker(markerFor(OTHER_ID));

    expect(await reviewRetry()).toEqual({ allowed: true });
    expect((await retryRejectedSale("q-legacy-1")).ok).toBe(true);
    expect((await queuedState()).state).toBe("pending");
  });

  it("a readable marker for the SAME sale still refuses Retry (same-ID rule preserved)", async () => {
    await seedNeedsAttention();
    await writeMarker(markerFor(QUEUED_ID));

    expect(await reviewRetry()).toEqual({ allowed: false, reason: "uncertain_sale_outstanding" });
    expect(await retryRejectedSale("q-legacy-1")).toEqual({ ok: false, reason: "uncertain_sale_outstanding" });
    expect((await queuedState()).state).toBe("needs_attention");
  });
});

describe("RETRY-UX FIX 1: evidence that cannot be trusted refuses Retry", () => {
  it("a malformed marker refuses Retry in the review and in the action", async () => {
    await seedNeedsAttention();
    await writeMarker({ schemaVersion: 99, saleRequestId: QUEUED_ID });

    expect(await reviewRetry()).toEqual({ allowed: false, reason: "uncertain_sale_outstanding" });
    expect(await retryRejectedSale("q-legacy-1")).toEqual({ ok: false, reason: "uncertain_sale_outstanding" });
    expect((await queuedState()).state).toBe("needs_attention");
  });

  it("a marker from ANOTHER pairing refuses Retry", async () => {
    await seedNeedsAttention();
    await writeMarker(markerFor(OTHER_ID, { ...IDENTITY, deviceAuthUserId: "99999999-9999-4999-8999-999999999999" }));

    expect(await reviewRetry()).toEqual({ allowed: false, reason: "uncertain_sale_outstanding" });
    expect((await retryRejectedSale("q-legacy-1")).ok).toBe(false);
    expect((await queuedState()).state).toBe("needs_attention");
  });

  it("PERSISTENT read failure: the review does not offer Retry and the action refuses", async () => {
    await seedNeedsAttention();
    failMarkerReads();

    const offered = await reviewRetry();
    const result = await retryRejectedSale("q-legacy-1");

    expect(offered).not.toEqual({ allowed: true });
    expect(result.ok).toBe(false);

    const restore = restores.pop()!;

    restore();
    expect((await queuedState()).state).toBe("needs_attention");
  });

  it("TRANSIENT read failure starting AFTER the review offered Retry: the action itself refuses", async () => {
    await seedNeedsAttention();

    // The review was rendered while storage was healthy and the marker absent.
    expect(await reviewRetry()).toEqual({ allowed: true });

    failMarkerReads();

    const result = await retryRejectedSale("q-legacy-1");

    restores.pop()!();

    expect(result.ok).toBe(false);
    expect((await queuedState()).state).toBe("needs_attention");
    expect((await queuedState()).attemptCount).toBeGreaterThanOrEqual(0);
  });

  it("evidence APPEARING after the review offered Retry is honoured by the action", async () => {
    await seedNeedsAttention();
    expect(await reviewRetry()).toEqual({ allowed: true });

    await writeMarker({ schemaVersion: 99, saleRequestId: QUEUED_ID });

    expect(await retryRejectedSale("q-legacy-1")).toEqual({ ok: false, reason: "uncertain_sale_outstanding" });
    expect((await queuedState()).state).toBe("needs_attention");
  });

  it("storage that cannot open refuses Retry and lists nothing to act on", async () => {
    await seedNeedsAttention();

    const saved = globalThis.indexedDB;

    // @ts-expect-error simulating a host whose IndexedDB is unavailable
    globalThis.indexedDB = undefined;

    const reviews = await listRejectedSaleReviews();
    const result = await retryRejectedSale("q-legacy-1");

    globalThis.indexedDB = saved;

    expect(reviews).toEqual([]);
    expect(result.ok).toBe(false);
    expect((await queuedState()).state).toBe("needs_attention");
  });
});
