// W-02-RETRY-UX-FIX-2 — withQueueRecordMutation must turn EVERY failure inside
// its IndexedDB callbacks into one controlled { ok: false }, commit nothing,
// never hang, and report success only after the transaction completes.
//
// THE DEFECT. A synchronous throw from store.get / store.put inside the
// helper's request callbacks escaped the callback: the transaction aborted (so
// the operation still failed closed) but the exception surfaced as an uncaught
// error — in Chromium a page error (W-02-RETRY-UX-FIX-1 log 05), here an
// unhandled exception Vitest reports. A put that threw synchronously could also
// leave the decision's value reported against nothing.
//
// Real adapter, fake-indexeddb storage. Failures are injected at
// IDBObjectStore.prototype only.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CACHE_STORE,
  SALE_QUEUE_STORE,
  insertQueuedSale,
  openOfflineDb,
  readQueuedSaleRecord,
  withQueueRecordMutation,
} from "@/lib/deviceOfflineStore";
import type { QueueMutationDecision } from "@/lib/deviceOfflineStore";
import { UNCERTAIN_SALE_KEY } from "@/lib/uncertainSaleRecord";

const RECORD = { queueRecordId: "q-1", saleRequestId: "c0000000-0000-4000-8000-000000000001", state: "needs_attention", queuedAt: "2026-10-15T10:00:00.000Z", note: "original" };

type Proto = Record<string, (...a: unknown[]) => IDBRequest>;
const restores: (() => void)[] = [];

function wrap(method: "get" | "put", storeName: string, how: "throw" | "abort_after_success" | "abort_before_result", key?: unknown) {
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

    if (matches && how === "abort_before_result") {
      hits.push(`${method}:${storeName}:abort_before_result`);
      try {
        this.transaction.abort();
      } catch {
        // already finished
      }
    }

    return request;
  };

  restores.push(() => {
    proto[method] = original;
  });

  return hits;
}

async function db(): Promise<IDBDatabase> {
  const opened = await openOfflineDb();

  if (!opened.ok) throw new Error("storage did not open");

  return opened.value;
}

/** Fails the test instead of hanging if the helper never settles. */
function bounded<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("withQueueRecordMutation did not settle")), ms))]);
}

const commitV2: (input: { queued: unknown; uncertain: unknown }) => QueueMutationDecision<string> = ({ queued }) => ({
  commit: true,
  record: { ...(queued as object), note: "changed" },
  value: "committed",
});

let handle: IDBDatabase;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  handle = await db();
  expect((await insertQueuedSale(handle, RECORD)).ok).toBe(true);
});

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
  handle.close();
});

const stored = async () => (await readQueuedSaleRecord(handle, "q-1"));

describe("FIX-2 withQueueRecordMutation: healthy behaviour is unchanged", () => {
  it("a committing decision writes the record and resolves only after completion", async () => {
    let decided = false;
    const result = await bounded(
      withQueueRecordMutation<string>(handle, "q-1", UNCERTAIN_SALE_KEY, (input) => {
        decided = true;

        return commitV2(input);
      })
    );

    expect(decided).toBe(true);
    expect(result).toEqual({ ok: true, value: "committed" });
    expect(await stored()).toEqual({ ok: true, value: { ...RECORD, note: "changed" } });
  });

  it("a non-committing decision writes nothing and returns its value", async () => {
    const result = await bounded(withQueueRecordMutation<string>(handle, "q-1", UNCERTAIN_SALE_KEY, () => ({ commit: false, value: "refused" })));

    expect(result).toEqual({ ok: true, value: "refused" });
    expect(await stored()).toEqual({ ok: true, value: RECORD });
  });

  it("the decision sees the queue record and the marker read in the same transaction", async () => {
    const seen: unknown[] = [];

    await bounded(
      withQueueRecordMutation<string>(handle, "q-1", UNCERTAIN_SALE_KEY, (input) => {
        seen.push(input);

        return { commit: false, value: "x" };
      })
    );

    expect(seen).toEqual([{ queued: RECORD, uncertain: undefined }]);
  });
});

describe("FIX-2 withQueueRecordMutation: every failure is controlled", () => {
  it("a synchronous throw from the MARKER read returns failure and commits nothing", async () => {
    const hits = wrap("get", CACHE_STORE, "throw", UNCERTAIN_SALE_KEY);
    const result = await bounded(withQueueRecordMutation<string>(handle, "q-1", UNCERTAIN_SALE_KEY, commitV2));

    restores.pop()!();
    expect(hits.length).toBeGreaterThan(0);
    expect(result).toEqual({ ok: false, reason: "failed" });
    expect(await stored()).toEqual({ ok: true, value: RECORD });
  });

  it("a synchronous throw from the QUEUE read returns failure and commits nothing", async () => {
    const hits = wrap("get", SALE_QUEUE_STORE, "throw", "q-1");
    const result = await bounded(withQueueRecordMutation<string>(handle, "q-1", UNCERTAIN_SALE_KEY, commitV2));

    restores.pop()!();
    expect(hits.length).toBeGreaterThan(0);
    expect(result).toEqual({ ok: false, reason: "failed" });
    expect(await stored()).toEqual({ ok: true, value: RECORD });
  });

  it("a throwing DECISION returns failure and commits nothing", async () => {
    const result = await bounded(
      withQueueRecordMutation<string>(handle, "q-1", UNCERTAIN_SALE_KEY, () => {
        throw new Error("W-02 decision failure");
      })
    );

    expect(result).toEqual({ ok: false, reason: "failed" });
    expect(await stored()).toEqual({ ok: true, value: RECORD });
  });

  it("a synchronous throw from the WRITE returns failure and commits nothing", async () => {
    const hits = wrap("put", SALE_QUEUE_STORE, "throw");
    const result = await bounded(withQueueRecordMutation<string>(handle, "q-1", UNCERTAIN_SALE_KEY, commitV2));

    restores.pop()!();
    expect(hits.length).toBeGreaterThan(0);
    expect(result).toEqual({ ok: false, reason: "failed" });
    expect(await stored()).toEqual({ ok: true, value: RECORD });
  });

  it("a non-cloneable record (a real synchronous DataCloneError) returns failure and commits nothing", async () => {
    const result = await bounded(
      withQueueRecordMutation<string>(handle, "q-1", UNCERTAIN_SALE_KEY, ({ queued }) => ({
        commit: true,
        record: { ...(queued as object), fn: () => 1 },
        value: "committed",
      }))
    );

    expect(result).toEqual({ ok: false, reason: "failed" });
    expect(await stored()).toEqual({ ok: true, value: RECORD });
  });

  it("a transaction that aborts AFTER the write request succeeded cannot report success", async () => {
    const hits = wrap("put", SALE_QUEUE_STORE, "abort_after_success");
    const result = await bounded(withQueueRecordMutation<string>(handle, "q-1", UNCERTAIN_SALE_KEY, commitV2));

    restores.pop()!();
    expect(hits.length).toBeGreaterThan(0);
    expect(result).toEqual({ ok: false, reason: "failed" });
    expect(await stored()).toEqual({ ok: true, value: RECORD });
  });

  it("a marker read that errors asynchronously returns failure and commits nothing", async () => {
    const hits = wrap("get", CACHE_STORE, "abort_before_result", UNCERTAIN_SALE_KEY);
    const result = await bounded(withQueueRecordMutation<string>(handle, "q-1", UNCERTAIN_SALE_KEY, commitV2));

    restores.pop()!();
    expect(hits.length).toBeGreaterThan(0);
    expect(result).toEqual({ ok: false, reason: "failed" });
    expect(await stored()).toEqual({ ok: true, value: RECORD });
  });
});
