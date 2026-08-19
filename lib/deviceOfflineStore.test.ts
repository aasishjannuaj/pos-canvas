// Feature 24.5A — the IndexedDB adapter, exercised against a real IDB engine.
//
// WHY THIS FILE OPTS IN RATHER THAN THE SUITE: vitest.config.ts runs in the
// `node` environment on purpose, and its own comment records that the suite
// "never touches React, the DOM, or any browser API". Importing the shim here
// keeps that true for every other file — vitest isolates test files, so these
// globals do not leak — and avoids changing a config the whole repository
// depends on for one adapter.
//
// fake-indexeddb is a DEV dependency only. It implements the real IndexedDB
// specification, so schema creation, versioning and transaction semantics are
// genuinely exercised rather than mocked away.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CACHE_STORE,
  SALE_QUEUE_STORE,
  OFFLINE_DB_NAME,
  OFFLINE_DB_VERSION,
  clearDeviceCache,
  openOfflineDb,
  readPairingAssertionRecord,
  readPinnedConfigRecord,
  requestStoragePersistence,
  writePairingAssertionRecord,
  writePinnedConfigRecord,
} from "@/lib/deviceOfflineStore";

// A fresh engine per test: IndexedDB is persistent by nature, and a leaked
// database from one test would make the next one pass for the wrong reason.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

async function open() {
  const opened = await openOfflineDb();

  expect(opened.ok).toBe(true);

  if (!opened.ok) throw new Error("unreachable");

  return opened.value;
}

describe("the database is created with the expected shape", () => {
  it("opens at the declared name and version and creates the store", async () => {
    const db = await open();

    expect(db.name).toBe(OFFLINE_DB_NAME);
    expect(db.version).toBe(OFFLINE_DB_VERSION);
    expect(db.objectStoreNames.contains(CACHE_STORE)).toBe(true);

    db.close();
  });

  it("holds exactly the two approved stores", () => {
    // SUPERSEDED BY 24.5C. This used to assert that ONLY device-cache existed,
    // on the grounds that an unused queue store would be an empty promise.
    // 24.5C designed and built the queue, so the store is real now — but the
    // list stays closed, so a third store cannot appear unnoticed.
    return open().then((db) => {
      expect(Array.from(db.objectStoreNames).sort()).toEqual(
        [CACHE_STORE, SALE_QUEUE_STORE].sort()
      );
      db.close();
    });
  });

  it("opening twice is idempotent", async () => {
    const first = await open();
    first.close();

    const second = await open();
    expect(second.objectStoreNames.contains(CACHE_STORE)).toBe(true);
    second.close();
  });

  it("reports unavailable rather than throwing when IndexedDB is absent", async () => {
    const result = await openOfflineDb(undefined as unknown as IDBFactory);

    // globalThis.indexedDB is set by the shim, so pass an explicitly broken
    // factory to reach the failure path.
    expect(result.ok).toBe(true);

    const broken = {
      open() {
        throw new Error("denied");
      },
    } as unknown as IDBFactory;

    expect((await openOfflineDb(broken)).ok).toBe(false);
  });
});

describe("records round-trip", () => {
  it("writes and reads a pairing assertion", async () => {
    const db = await open();
    const record = { cacheSchemaVersion: 1, deviceAuthUserId: "user-a" };

    expect((await writePairingAssertionRecord(db, record)).ok).toBe(true);

    const read = await readPairingAssertionRecord(db);

    expect(read.ok).toBe(true);
    expect(read.ok === true && read.value).toEqual(record);

    db.close();
  });

  it("writes and reads a pinned config", async () => {
    const db = await open();
    const record = { cacheSchemaVersion: 1, configSnapshot: { schemaVersion: 1 } };

    expect((await writePinnedConfigRecord(db, record)).ok).toBe(true);

    const read = await readPinnedConfigRecord(db);

    expect(read.ok === true && read.value).toEqual(record);

    db.close();
  });

  it("a missing key reads as null, not as a failure", async () => {
    const db = await open();
    const read = await readPinnedConfigRecord(db);

    expect(read.ok).toBe(true);
    expect(read.ok === true && read.value).toBeNull();

    db.close();
  });

  it("a second write replaces the first wholesale — nothing is merged", async () => {
    // A configuration is a snapshot, not a document. An authoritative build
    // change must not leave fragments of the previous one behind.
    const db = await open();

    await writePinnedConfigRecord(db, { buildJobId: "build-1", extra: "gone" });
    await writePinnedConfigRecord(db, { buildJobId: "build-2" });

    const read = await readPinnedConfigRecord(db);

    expect(read.ok === true && read.value).toEqual({ buildJobId: "build-2" });

    db.close();
  });

  it("the two records are independent keys", async () => {
    const db = await open();

    await writePairingAssertionRecord(db, { kind: "assertion" });
    await writePinnedConfigRecord(db, { kind: "config" });

    expect((await readPairingAssertionRecord(db)).ok).toBe(true);
    expect(
      ((await readPairingAssertionRecord(db)) as { value: unknown }).value
    ).toEqual({ kind: "assertion" });
    expect(
      ((await readPinnedConfigRecord(db)) as { value: unknown }).value
    ).toEqual({ kind: "config" });

    db.close();
  });
});

describe("clearing removes every record", () => {
  it("clears both keys, so no business's config outlives its pairing", async () => {
    const db = await open();

    await writePairingAssertionRecord(db, { business: "A" });
    await writePinnedConfigRecord(db, { business: "A" });

    expect((await clearDeviceCache(db)).ok).toBe(true);

    expect(((await readPairingAssertionRecord(db)) as { value: unknown }).value).toBeNull();
    expect(((await readPinnedConfigRecord(db)) as { value: unknown }).value).toBeNull();

    db.close();
  });

  it("clearing an already-empty cache is not an error", async () => {
    const db = await open();

    expect((await clearDeviceCache(db)).ok).toBe(true);

    db.close();
  });
});

describe("a value that cannot be stored fails softly", () => {
  it("a non-cloneable value is a failed write, never a thrown exception", async () => {
    const db = await open();
    const notCloneable = { fn: () => undefined };

    const result = await writePinnedConfigRecord(db, notCloneable);

    expect(result.ok).toBe(false);

    db.close();
  });
});

describe("storage persistence is advisory", () => {
  it("reports unsupported when the API is absent", async () => {
    expect(await requestStoragePersistence(null)).toBe("unsupported");
    expect(await requestStoragePersistence({} as StorageManager)).toBe("unsupported");
  });

  it("reports granted when the browser agrees", async () => {
    const storage = {
      persisted: async () => false,
      persist: async () => true,
    } as unknown as StorageManager;

    expect(await requestStoragePersistence(storage)).toBe("granted");
  });

  it("does not re-ask when persistence is already granted", async () => {
    let asked = false;
    const storage = {
      persisted: async () => true,
      persist: async () => {
        asked = true;
        return false;
      },
    } as unknown as StorageManager;

    expect(await requestStoragePersistence(storage)).toBe("granted");
    expect(asked).toBe(false);
  });

  it("a denial is reported, not thrown — the till still works", async () => {
    const storage = {
      persisted: async () => false,
      persist: async () => false,
    } as unknown as StorageManager;

    expect(await requestStoragePersistence(storage)).toBe("denied");
  });

  it("a throwing implementation is caught", async () => {
    const storage = {
      persisted: async () => {
        throw new Error("nope");
      },
      persist: async () => true,
    } as unknown as StorageManager;

    expect(await requestStoragePersistence(storage)).toBe("failed");
  });
});
