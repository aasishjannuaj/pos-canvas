// W-02-STORAGE-FIX-1 — withStore reports success only once its transaction has
// COMMITTED.
//
// THE DEFECT. withStore resolved `{ ok: true }` from the request's `success`
// event, while the transaction was still open. A transaction can still abort
// after that (Chromium checks quota and flushes at commit), so a write that
// never reached disk was reported as durable. W-02C showed the consequence
// with an injected abort: armUncertainSale returned true with no marker on
// disk, and completeOfflineSale reported a saved sale with an empty queue.
//
// HOW THE FAILURE IS INJECTED. fake-indexeddb object-store methods are wrapped
// so the REAL request is issued, then a `success` listener — which runs before
// the adapter's own `onsuccess` property handler — aborts the transaction.
// Everything from withStore upwards (the adapter, uncertainSaleSession,
// saleQueueSession, offlineCheckoutSession) is the shipped code, unmocked.
//
// WHAT THIS IS NOT. An injected abort proves the failure is handled. It does
// not reproduce a real Chromium/Electron commit failure, says nothing about
// power-loss durability (fake-indexeddb has no durability modes), and does not
// execute DeviceApp or PosRuntime, which this repository cannot render.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CACHE_STORE,
  SALE_QUEUE_STORE,
  clearDeviceCache,
  countQueuedSaleRecords,
  deleteQueuedSaleRecord,
  deleteUncertainSaleRecordRaw,
  insertQueuedSale,
  openOfflineDb,
  putQueuedSale,
  readAllQueuedSaleRecords,
  readCacheKey,
  readQueuedSaleByRequestId,
  readQueuedSaleRecord,
  readUncertainSaleRecordRaw,
  writeCacheKey,
  writeUncertainSaleRecordRaw,
} from "@/lib/deviceOfflineStore";
import { armUncertainSale } from "@/lib/uncertainSaleSession";
import { completeOfflineSale } from "@/lib/offlineCheckoutSession";
import { resolveOfflineSaleDraft } from "@/lib/offlineCheckout";
import type { OfflineCheckoutSession } from "@/lib/offlineCheckout";
import { OFFLINE_DEVICE_LEASE_MS } from "@/lib/deviceOfflineCache";
import { createGeneratedPosConfig } from "@/lib/generatedPosConfig";
import { cloneProjectConfig, defaultProjectConfig } from "@/lib/projectConfig";
import { createCartItem } from "@/lib/cart";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IDENTITY = {
  deviceAuthUserId: "11111111-1111-4111-8111-111111111111",
  deviceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  projectId: PROJECT,
  buildJobId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};
const SALE_ID = "c0000000-0000-4000-8000-000000000001";
const EMPLOYEE_SESSION = "e1e1e1e1-0000-4000-8000-000000000001";
const REGISTER_SESSION = "f1f1f1f1-0000-4000-8000-000000000001";
const VERIFIED_AT = "2026-10-13T20:00:00.000Z";
const SOLD_AT = Date.parse("2026-10-14T02:43:00.000Z");

const project = cloneProjectConfig(defaultProjectConfig);
const config = createGeneratedPosConfig(
  { projectId: PROJECT, projectName: "Synthetic Shop", templateId: "restaurant", config: project },
  { generatedAt: VERIFIED_AT }
);
const session: OfflineCheckoutSession = {
  ...IDENTITY,
  lastVerifiedAt: VERIFIED_AT,
  leaseExpiresAt: new Date(Date.parse(VERIFIED_AT) + OFFLINE_DEVICE_LEASE_MS).toISOString(),
};

function queued(patch: Record<string, unknown> = {}) {
  return {
    queueRecordId: "q-1",
    saleRequestId: SALE_ID,
    state: "pending",
    queuedAt: "2026-10-14T02:43:00.000Z",
    employeePosSessionId: EMPLOYEE_SESSION,
    registerSessionId: REGISTER_SESSION,
    ...patch,
  };
}

async function open(): Promise<IDBDatabase> {
  const opened = await openOfflineDb();

  if (!opened.ok) throw new Error("storage did not open");

  return opened.value;
}

// ---------------------------------------------------------------------------
// The storage boundary
// ---------------------------------------------------------------------------

type Method = "put" | "add" | "delete" | "get";
type Proto = Record<string, (...args: unknown[]) => IDBRequest>;

const restores: (() => void)[] = [];

function wrap(method: Method, storeName: string, onSuccess: (tx: IDBTransaction, store: IDBObjectStore) => void) {
  const proto = IDBObjectStore.prototype as unknown as Proto;
  const original = proto[method];
  let armed = true;

  proto[method] = function (this: IDBObjectStore, ...args: unknown[]) {
    const request = original.apply(this, args);

    if (armed && this.name === storeName) {
      armed = false; // the first matching request only
      const transaction = this.transaction;

      request.addEventListener("success", () => onSuccess(transaction, this));
    }

    return request;
  };

  restores.push(() => {
    proto[method] = original;
  });
}

/** Request succeeds, then the transaction aborts before it can commit. */
function abortAfterSuccess(method: Method, storeName: string) {
  wrap(method, storeName, (transaction) => {
    try {
      transaction.abort();
    } catch {
      // already finished
    }
  });
}

/**
 * Request succeeds, then the transaction is HELD OPEN for several more rounds
 * of requests. `probe()` is sampled at each round, i.e. while the transaction
 * is provably still active after the request succeeded.
 */
function holdOpenAfterSuccess(method: Method, storeName: string, probe: () => boolean, samples: boolean[]) {
  wrap(method, storeName, (_transaction, store) => {
    let rounds = 0;
    const next = () => {
      samples.push(probe());
      rounds += 1;

      if (rounds < 4) store.count().onsuccess = next;
    };

    store.count().onsuccess = next;
  });
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

// ===========================================================================
// 1. Request success is not storage success
// ===========================================================================

describe("STORAGE-FIX-1: request success alone does not report success", () => {
  it("a write has not reported while its transaction is still open after the request succeeded", async () => {
    const db = await open();
    let reported = false;
    const samples: boolean[] = [];

    holdOpenAfterSuccess("put", CACHE_STORE, () => reported, samples);

    const pending = writeCacheKey(db, "k", { v: 1 });

    void pending.then(() => {
      reported = true;
    });

    const result = await pending;

    // Every sample was taken after the put succeeded and before the
    // transaction completed. None may have seen a reported outcome.
    expect(samples).toHaveLength(4);
    expect(samples).toEqual([false, false, false, false]);
    expect(result).toEqual({ ok: true, value: undefined });
    db.close();
  });

  it("an insert has not reported while its transaction is still open", async () => {
    const db = await open();
    let reported = false;
    const samples: boolean[] = [];

    holdOpenAfterSuccess("add", SALE_QUEUE_STORE, () => reported, samples);

    const pending = insertQueuedSale(db, queued());

    void pending.then(() => {
      reported = true;
    });

    expect(await pending).toEqual({ ok: true, value: undefined });
    expect(samples).toEqual([false, false, false, false]);
    db.close();
  });
});

// ===========================================================================
// 2. Completion returns the expected result
// ===========================================================================

describe("STORAGE-FIX-1: transaction completion returns the expected result", () => {
  it("writes, reads, updates, deletes and missing reads behave as before", async () => {
    const db = await open();

    // Missing records read as null / empty / zero, not as failures.
    expect(await readCacheKey(db, "absent")).toEqual({ ok: true, value: null });
    expect(await readUncertainSaleRecordRaw(db)).toEqual({ ok: true, value: null });
    expect(await readQueuedSaleRecord(db, "absent")).toEqual({ ok: true, value: null });
    expect(await readQueuedSaleByRequestId(db, SALE_ID)).toEqual({ ok: true, value: null });
    expect(await readAllQueuedSaleRecords(db)).toEqual({ ok: true, value: [] });
    expect(await countQueuedSaleRecords(db)).toEqual({ ok: true, value: 0 });

    // Write and read back.
    expect(await writeCacheKey(db, "k", { v: 1 })).toEqual({ ok: true, value: undefined });
    expect(await readCacheKey(db, "k")).toEqual({ ok: true, value: { v: 1 } });

    // Insert, then read by key, by request id, as a list and as a count.
    expect(await insertQueuedSale(db, queued())).toEqual({ ok: true, value: undefined });
    expect(await readQueuedSaleRecord(db, "q-1")).toEqual({ ok: true, value: queued() });
    expect(await readQueuedSaleByRequestId(db, SALE_ID)).toEqual({ ok: true, value: queued() });
    expect(await readAllQueuedSaleRecords(db)).toEqual({ ok: true, value: [queued()] });
    expect(await countQueuedSaleRecords(db)).toEqual({ ok: true, value: 1 });

    // Update keeps the sale id and the attribution claims exactly.
    expect(await putQueuedSale(db, queued({ state: "syncing" }))).toEqual({ ok: true, value: undefined });
    const updated = await readQueuedSaleRecord(db, "q-1");

    expect(updated).toEqual({ ok: true, value: queued({ state: "syncing" }) });

    // Delete.
    expect(await deleteQueuedSaleRecord(db, "q-1")).toEqual({ ok: true, value: undefined });
    expect(await readQueuedSaleRecord(db, "q-1")).toEqual({ ok: true, value: null });

    // Uncertain marker round trip and delete.
    expect(await writeUncertainSaleRecordRaw(db, { saleRequestId: SALE_ID })).toEqual({ ok: true, value: undefined });
    expect(await readUncertainSaleRecordRaw(db)).toEqual({ ok: true, value: { saleRequestId: SALE_ID } });
    expect(await deleteUncertainSaleRecordRaw(db)).toEqual({ ok: true, value: undefined });
    expect(await readUncertainSaleRecordRaw(db)).toEqual({ ok: true, value: null });

    // clearDeviceCache still clears config keys only.
    expect(await writeUncertainSaleRecordRaw(db, { saleRequestId: SALE_ID })).toEqual({ ok: true, value: undefined });
    expect(await clearDeviceCache(db)).toEqual({ ok: true, value: undefined });
    expect(await readUncertainSaleRecordRaw(db)).toEqual({ ok: true, value: { saleRequestId: SALE_ID } });
    db.close();
  });

  it("a duplicate insert is a failure and leaves the committed record intact", async () => {
    const db = await open();

    expect((await insertQueuedSale(db, queued())).ok).toBe(true);
    expect(await insertQueuedSale(db, queued({ state: "synced" }))).toEqual({ ok: false, reason: "failed" });
    expect(await readQueuedSaleRecord(db, "q-1")).toEqual({ ok: true, value: queued() });
    db.close();
  });

  it("a synchronous failure is reported and commits nothing", async () => {
    const db = await open();

    // A function is not structured-cloneable: put throws synchronously.
    expect(await writeCacheKey(db, "k", { fn: () => 1 })).toEqual({ ok: false, reason: "failed" });
    expect(await readCacheKey(db, "k")).toEqual({ ok: true, value: null });
    db.close();
  });
});

// ===========================================================================
// 3. An abort after request success is a failure, and changes nothing
// ===========================================================================

describe("STORAGE-FIX-1: abort after request success", () => {
  it("an aborted marker write reports failure and leaves no marker", async () => {
    const db = await open();

    abortAfterSuccess("put", CACHE_STORE);

    expect(await writeUncertainSaleRecordRaw(db, { saleRequestId: SALE_ID })).toEqual({ ok: false, reason: "failed" });
    expect(await readUncertainSaleRecordRaw(db)).toEqual({ ok: true, value: null });
    db.close();
  });

  it("an aborted insert reports failure and leaves no queued sale", async () => {
    const db = await open();

    abortAfterSuccess("add", SALE_QUEUE_STORE);

    expect(await insertQueuedSale(db, queued())).toEqual({ ok: false, reason: "failed" });
    expect(await readAllQueuedSaleRecords(db)).toEqual({ ok: true, value: [] });
    db.close();
  });

  it("an aborted update reports failure and preserves the committed record", async () => {
    const db = await open();

    expect((await insertQueuedSale(db, queued())).ok).toBe(true);
    expect((await writeCacheKey(db, "k", { v: 1 })).ok).toBe(true);

    abortAfterSuccess("put", SALE_QUEUE_STORE);
    expect(
      await putQueuedSale(db, queued({ state: "synced", employeePosSessionId: null, registerSessionId: null }))
    ).toEqual({ ok: false, reason: "failed" });

    abortAfterSuccess("put", CACHE_STORE);
    expect(await writeCacheKey(db, "k", { v: 2 })).toEqual({ ok: false, reason: "failed" });

    // The committed versions, including sale id and attribution, survive.
    expect(await readQueuedSaleRecord(db, "q-1")).toEqual({ ok: true, value: queued() });
    expect(await readCacheKey(db, "k")).toEqual({ ok: true, value: { v: 1 } });
    db.close();
  });

  it("aborted deletes report failure and preserve the committed record", async () => {
    const db = await open();

    expect((await insertQueuedSale(db, queued())).ok).toBe(true);
    expect((await writeUncertainSaleRecordRaw(db, { saleRequestId: SALE_ID })).ok).toBe(true);

    abortAfterSuccess("delete", SALE_QUEUE_STORE);
    expect(await deleteQueuedSaleRecord(db, "q-1")).toEqual({ ok: false, reason: "failed" });

    abortAfterSuccess("delete", CACHE_STORE);
    expect(await deleteUncertainSaleRecordRaw(db)).toEqual({ ok: false, reason: "failed" });

    expect(await readQueuedSaleRecord(db, "q-1")).toEqual({ ok: true, value: queued() });
    expect(await readUncertainSaleRecordRaw(db)).toEqual({ ok: true, value: { saleRequestId: SALE_ID } });
    db.close();
  });

  it("an aborted read reports failure rather than a value", async () => {
    const db = await open();

    expect((await writeCacheKey(db, "k", { v: 1 })).ok).toBe(true);
    abortAfterSuccess("get", CACHE_STORE);

    expect(await readCacheKey(db, "k")).toEqual({ ok: false, reason: "failed" });
    db.close();
  });
});

// ===========================================================================
// 4. The real callers that depend on it (library level only)
// ===========================================================================

describe("STORAGE-FIX-1: real session functions see the failure", () => {
  it("armUncertainSale returns false when the marker transaction aborts after request success", async () => {
    abortAfterSuccess("put", CACHE_STORE);

    const armed = await armUncertainSale({
      sale: {
        saleRequestId: SALE_ID,
        projectId: PROJECT,
        paymentMethod: "cash",
        tipAmount: 0,
        items: [{ itemId: project.menuItems[0].id, quantity: 2, modifiers: [] }],
        fingerprint: "fp",
      },
      identity: IDENTITY,
      dispatchedAt: new Date(SOLD_AT).toISOString(),
    });

    const db = await open();

    expect(armed).toBe(false);
    expect(await readUncertainSaleRecordRaw(db)).toEqual({ ok: true, value: null });
    db.close();
  });

  it("armUncertainSale still returns true, with the marker on disk, when the transaction commits", async () => {
    const armed = await armUncertainSale({
      sale: {
        saleRequestId: SALE_ID,
        projectId: PROJECT,
        paymentMethod: "cash",
        tipAmount: 0,
        items: [{ itemId: project.menuItems[0].id, quantity: 2, modifiers: [] }],
        fingerprint: "fp",
      },
      identity: IDENTITY,
      dispatchedAt: new Date(SOLD_AT).toISOString(),
    });
    const db = await open();
    const stored = await readUncertainSaleRecordRaw(db);

    expect(armed).toBe(true);
    expect(stored.ok && (stored.value as { saleRequestId: string }).saleRequestId).toBe(SALE_ID);
    db.close();
  });

  function draft() {
    const drafted = resolveOfflineSaleDraft({
      current: null,
      projectId: PROJECT,
      paymentMethod: "cash",
      tipAmount: 0,
      cart: [createCartItem(project.menuItems[0], [], 2)],
      now: SOLD_AT,
      inherited: null,
      generate: () => SALE_ID,
    });

    if (!drafted.ok) throw new Error(`draft refused: ${drafted.reason}`);

    return drafted.draft;
  }

  it("completeOfflineSale does not report success when the queue transaction aborts", async () => {
    abortAfterSuccess("add", SALE_QUEUE_STORE);

    const outcome = await completeOfflineSale({
      session,
      config,
      draft: draft(),
      cart: [createCartItem(project.menuItems[0], [], 2)],
      paymentMethod: "cash",
      now: SOLD_AT,
      claims: { employeePosSessionId: EMPLOYEE_SESSION, registerSessionId: REGISTER_SESSION },
    });
    const db = await open();

    expect(outcome.ok).toBe(false);
    expect(await readAllQueuedSaleRecords(db)).toEqual({ ok: true, value: [] });
    db.close();
  });

  it("completeOfflineSale still saves, with its sale id and claims, when the transaction commits", async () => {
    const outcome = await completeOfflineSale({
      session,
      config,
      draft: draft(),
      cart: [createCartItem(project.menuItems[0], [], 2)],
      paymentMethod: "cash",
      now: SOLD_AT,
      claims: { employeePosSessionId: EMPLOYEE_SESSION, registerSessionId: REGISTER_SESSION },
    });
    const db = await open();
    const stored = await readQueuedSaleByRequestId(db, SALE_ID);

    expect(outcome.ok).toBe(true);
    expect(stored.ok && stored.value).toMatchObject({
      saleRequestId: SALE_ID,
      employeePosSessionId: EMPLOYEE_SESSION,
      registerSessionId: REGISTER_SESSION,
      state: "pending",
    });
    db.close();
  });
});
