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
export const OFFLINE_DB_VERSION = 1;

/**
 * The single object store 24.5A creates.
 *
 * NO SALE-QUEUE STORE IS RESERVED HERE. A store created now would be an empty
 * promise of a contract 24.5C has not designed yet, and IndexedDB versioning
 * makes adding one later a routine upgrade — `onupgradeneeded` runs for exactly
 * the version steps a given browser is behind. Reserving the name buys nothing
 * and would put an unused, untested store on every till.
 */
export const CACHE_STORE = "device-cache";

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

      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        db.createObjectStore(CACHE_STORE);
      }
    };

    request.onsuccess = () => {
      const db = request.result;

      // A database that exists but lacks the store means an interrupted upgrade
      // or a hand-edited profile. Treat it as unusable rather than reading from
      // a store that is not there.
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
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
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<OfflineStoreResult<T>> {
  return new Promise((resolve) => {
    let request: IDBRequest<T>;

    try {
      const transaction = db.transaction(CACHE_STORE, mode);

      transaction.onabort = () => resolve({ ok: false, reason: "failed" });
      transaction.onerror = () => resolve({ ok: false, reason: "failed" });

      request = run(transaction.objectStore(CACHE_STORE));
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
  const result = await withStore<unknown>(db, "readonly", (store) => store.get(key));

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
  const result = await withStore<IDBValidKey>(db, "readwrite", (store) =>
    store.put(value, key)
  );

  return result.ok ? { ok: true, value: undefined } : result;
}

/** Removes every cached record. Used on unpair, re-pair and confirmed revocation. */
export async function clearDeviceCache(
  db: IDBDatabase
): Promise<OfflineStoreResult<void>> {
  const result = await withStore<undefined>(db, "readwrite", (store) => store.clear());

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
