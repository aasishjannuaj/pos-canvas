// Feature 24.5A — the ONLY module in this repository that touches IndexedDB.
//
// KEPT DELIBERATELY THIN. Every rule about what may be trusted lives in
// lib/deviceOfflineCache.ts and is tested under plain Node; this file opens a
// database, reads a key, writes a key, and clears. Concentrating the browser
// dependency in one small adapter is what lets the interesting half of the
// feature be tested without a DOM.
//
// ONE IMPLEMENTATION FOR BOTH SHELLS. The Android Capacitor WebView and the
// Windows Electron window load the SAME hosted origin, so this code runs
// unchanged on both and there is no platform adapter, no Capacitor storage
// plugin, no SQLite and no Electron IPC. See docs/OFFLINE_ARCHITECTURE.md §16.
//
// EVERY FUNCTION HERE FAILS SOFT. Storage can be absent (private mode), denied,
// full or corrupt. None of those may take the POS down: an unavailable cache
// means "this device cannot start offline", never "this device cannot start".
import {
  PAIRING_ASSERTION_KEY,
  PINNED_CONFIG_KEY,
} from "@/lib/deviceOfflineCache";

/** Database name and version. Bump the version to add or change a store. */
export const OFFLINE_DB_NAME = "pos-canvas-device";

/**
 * Feature 24.5C — bumped from 1 to 2 to add the sale queue.
 *
 * The upgrade is PURELY ADDITIVE. device-cache is not dropped, recreated or
 * migrated; a device that already holds a pinned config and a pairing assertion
 * keeps both, and the only observable change is that a second store now exists.
 * onupgradeneeded runs for exactly the version steps a given browser is behind,
 * so a fresh install and a v1 device converge on the same v2 schema.
 */
export const OFFLINE_DB_VERSION = 2;

/**
 * The single object store 24.5A creates.
 *
 * 24.5A deliberately reserved no queue store, on the grounds that an unused one
 * would be an empty promise. 24.5C adds it for real, below.
 */
export const CACHE_STORE = "device-cache";

/**
 * Feature 24.5C — one record per queued offline sale.
 *
 * KEYED BY queueRecordId rather than saleRequestId, with saleRequestId carried
 * as a UNIQUE index instead. The distinction matters: the key path is this
 * device's local handle on a row, while saleRequestId is the server's identity
 * for the sale. Making the latter a unique index means IndexedDB itself refuses
 * a second record claiming the same sale — a constraint the storage engine
 * enforces, not something application code has to remember to check.
 */
export const SALE_QUEUE_STORE = "sale-queue";

/** Index names, spelled once so a typo cannot silently fall back to a scan. */
export const SALE_QUEUE_REQUEST_ID_INDEX = "by-sale-request-id";
export const SALE_QUEUE_STATE_INDEX = "by-state";
export const SALE_QUEUE_QUEUED_AT_INDEX = "by-queued-at";

export type OfflineStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "unavailable" | "failed" };

function getFactory(factory?: IDBFactory): IDBFactory | null {
  const resolved = factory ?? (typeof globalThis !== "undefined" ? globalThis.indexedDB : undefined);

  return resolved ?? null;
}

/**
 * Opens the database, creating the store on first use.
 *
 * `onblocked` is handled: another tab holding an older version open would
 * otherwise leave this promise pending forever, which on a till reads as a
 * hung startup. It resolves to unavailable instead, and the device starts
 * online-only.
 */
export function openOfflineDb(
  factory?: IDBFactory
): Promise<OfflineStoreResult<IDBDatabase>> {
  const idb = getFactory(factory);

  if (idb === null) {
    return Promise.resolve({ ok: false, reason: "unavailable" });
  }

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: OfflineStoreResult<IDBDatabase>): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    let request: IDBOpenDBRequest;

    try {
      request = idb.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    } catch {
      settle({ ok: false, reason: "unavailable" });
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;

      // Guarded by `contains` rather than by oldVersion, so a fresh install and
      // a v1 device both land on the same schema without branching on version
      // numbers that will keep growing.
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        db.createObjectStore(CACHE_STORE);
      }

      if (!db.objectStoreNames.contains(SALE_QUEUE_STORE)) {
        const queue = db.createObjectStore(SALE_QUEUE_STORE, {
          keyPath: "queueRecordId",
        });

        // UNIQUE. Two queue records must never claim one sale: that is how a
        // duplicate submission would be born, and the storage engine is a far
        // better place to enforce it than a read-then-write in application code
        // that a crash could interleave.
        queue.createIndex(SALE_QUEUE_REQUEST_ID_INDEX, "saleRequestId", { unique: true });

        // Non-unique: many records share a state, and 24.5D reads by it.
        queue.createIndex(SALE_QUEUE_STATE_INDEX, "state", { unique: false });

        // FIFO ordering without loading and sorting the whole queue.
        queue.createIndex(SALE_QUEUE_QUEUED_AT_INDEX, "queuedAt", { unique: false });
      }
    };

    request.onsuccess = () => {
      const db = request.result;

      // A database that exists but lacks a store means an interrupted upgrade or
      // a hand-edited profile. Treat it as unusable rather than reading from a
      // store that is not there. BOTH are required from 24.5C onwards.
      if (
        !db.objectStoreNames.contains(CACHE_STORE) ||
        !db.objectStoreNames.contains(SALE_QUEUE_STORE)
      ) {
        db.close();
        settle({ ok: false, reason: "failed" });
        return;
      }

      settle({ ok: true, value: db });
    };

    request.onerror = () => settle({ ok: false, reason: "failed" });
    request.onblocked = () => settle({ ok: false, reason: "unavailable" });
  });
}

function withStore<T>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<OfflineStoreResult<T>> {
  return new Promise((resolve) => {
    let request: IDBRequest<T>;

    try {
      const transaction = db.transaction(storeName, mode);

      transaction.onabort = () => resolve({ ok: false, reason: "failed" });
      transaction.onerror = () => resolve({ ok: false, reason: "failed" });

      request = run(transaction.objectStore(storeName));
    } catch {
      resolve({ ok: false, reason: "failed" });
      return;
    }

    request.onsuccess = () => resolve({ ok: true, value: request.result });
    request.onerror = () => resolve({ ok: false, reason: "failed" });
  });
}

export async function readCacheKey(
  db: IDBDatabase,
  key: string
): Promise<OfflineStoreResult<unknown>> {
  const result = await withStore<unknown>(db, CACHE_STORE, "readonly", (store) => store.get(key));

  return result.ok ? { ok: true, value: result.value ?? null } : result;
}

export async function writeCacheKey(
  db: IDBDatabase,
  key: string,
  value: unknown
): Promise<OfflineStoreResult<void>> {
  // structuredClone is what IndexedDB does internally on put(); doing it here
  // first turns a non-cloneable value into a caught failure rather than an
  // exception thrown from inside the transaction.
  const result = await withStore<IDBValidKey>(db, CACHE_STORE, "readwrite", (store) =>
    store.put(value, key)
  );

  return result.ok ? { ok: true, value: undefined } : result;
}

/** Removes every cached record. Used on unpair, re-pair and confirmed revocation. */
export async function clearDeviceCache(
  db: IDBDatabase
): Promise<OfflineStoreResult<void>> {
  const result = await withStore<undefined>(db, CACHE_STORE, "readwrite", (store) => store.clear());

  return result.ok ? { ok: true, value: undefined } : result;
}

/** Convenience wrappers so callers never spell a key themselves. */
export const readPairingAssertionRecord = (db: IDBDatabase) =>
  readCacheKey(db, PAIRING_ASSERTION_KEY);
export const readPinnedConfigRecord = (db: IDBDatabase) =>
  readCacheKey(db, PINNED_CONFIG_KEY);
export const writePairingAssertionRecord = (db: IDBDatabase, value: unknown) =>
  writeCacheKey(db, PAIRING_ASSERTION_KEY, value);
export const writePinnedConfigRecord = (db: IDBDatabase, value: unknown) =>
  writeCacheKey(db, PINNED_CONFIG_KEY, value);

// ---------------------------------------------------------------------------
// Feature 24.5C — sale queue primitives
//
// Thin, like everything else here. Validation of what comes back lives in
// lib/saleQueue.ts; these functions move bytes and report whether it worked.
// ---------------------------------------------------------------------------

/**
 * Inserts a queued sale, refusing to overwrite an existing one.
 *
 * `add` rather than `put`, deliberately. A `put` would silently replace a
 * record that already exists, which for a financial row is the difference
 * between "this sale is queued once" and "an earlier sale just disappeared".
 * The unique index on saleRequestId gives the same protection from the other
 * direction, and a violation of either surfaces as a `constraint` failure
 * rather than a lost sale.
 */
export async function insertQueuedSale(
  db: IDBDatabase,
  record: unknown
): Promise<OfflineStoreResult<void>> {
  const result = await withStore<IDBValidKey>(db, SALE_QUEUE_STORE, "readwrite", (store) =>
    store.add(record)
  );

  return result.ok ? { ok: true, value: undefined } : result;
}

/** Overwrites an existing record. Used for state changes, never for enqueue. */
export async function putQueuedSale(
  db: IDBDatabase,
  record: unknown
): Promise<OfflineStoreResult<void>> {
  const result = await withStore<IDBValidKey>(db, SALE_QUEUE_STORE, "readwrite", (store) =>
    store.put(record)
  );

  return result.ok ? { ok: true, value: undefined } : result;
}

export async function readQueuedSaleRecord(
  db: IDBDatabase,
  queueRecordId: string
): Promise<OfflineStoreResult<unknown>> {
  const result = await withStore<unknown>(db, SALE_QUEUE_STORE, "readonly", (store) =>
    store.get(queueRecordId)
  );

  return result.ok ? { ok: true, value: result.value ?? null } : result;
}

/** Looks a sale up by the SERVER's identity for it, through the unique index. */
export async function readQueuedSaleByRequestId(
  db: IDBDatabase,
  saleRequestId: string
): Promise<OfflineStoreResult<unknown>> {
  const result = await withStore<unknown>(db, SALE_QUEUE_STORE, "readonly", (store) =>
    store.index(SALE_QUEUE_REQUEST_ID_INDEX).get(saleRequestId)
  );

  return result.ok ? { ok: true, value: result.value ?? null } : result;
}

export async function readAllQueuedSaleRecords(
  db: IDBDatabase
): Promise<OfflineStoreResult<unknown[]>> {
  const result = await withStore<unknown[]>(db, SALE_QUEUE_STORE, "readonly", (store) =>
    store.getAll()
  );

  return result.ok ? { ok: true, value: result.value ?? [] } : result;
}

/**
 * Removes ONE record by key.
 *
 * Deliberately singular and key-addressed: there is no "clear the queue" here,
 * because the owner-approved rule is that queued sales are never deleted in
 * bulk (docs/OFFLINE_ARCHITECTURE.md §15). clearDeviceCache above clears the
 * CONFIG cache only, and does not touch this store.
 */
export async function deleteQueuedSaleRecord(
  db: IDBDatabase,
  queueRecordId: string
): Promise<OfflineStoreResult<void>> {
  const result = await withStore<undefined>(db, SALE_QUEUE_STORE, "readwrite", (store) =>
    store.delete(queueRecordId)
  );

  return result.ok ? { ok: true, value: undefined } : result;
}

export async function countQueuedSaleRecords(
  db: IDBDatabase
): Promise<OfflineStoreResult<number>> {
  return withStore<number>(db, SALE_QUEUE_STORE, "readonly", (store) => store.count());
}

// ---------------------------------------------------------------------------
// Storage persistence
// ---------------------------------------------------------------------------

export type PersistenceOutcome = "granted" | "denied" | "unsupported" | "failed";

/**
 * Asks the browser to keep this origin's storage rather than evicting it under
 * pressure. ADVISORY ONLY.
 *
 * Chromium grants this without a prompt when the origin looks "installed" or
 * sufficiently engaged, and silently declines otherwise. A denial is not an
 * error and must never block the POS or be shown to an operator as one — there
 * is nothing they could do about it, and the till works either way. It is
 * returned so a caller can record it; 24.5C, which will be storing real money,
 * is where a denial starts to matter enough to surface.
 */
export async function requestStoragePersistence(
  // `null` accepted alongside `undefined` for the same reason digestConfig
  // accepts it: a default parameter cannot represent "explicitly absent".
  storage: StorageManager | null | undefined = globalThis.navigator?.storage
): Promise<PersistenceOutcome> {
  if (!storage || typeof storage.persist !== "function") {
    return "unsupported";
  }

  try {
    if (typeof storage.persisted === "function" && (await storage.persisted())) {
      return "granted";
    }

    return (await storage.persist()) ? "granted" : "denied";
  } catch {
    return "failed";
  }
}
