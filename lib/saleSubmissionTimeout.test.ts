// Feature 24.5F — the bounded sale submission, and what a timeout means.
//
// THE BLOCKER THIS CLOSES. complete_sale_v4 was issued with no deadline. A hung
// socket meant `await deps.submit(...)` never settled, so the row stayed
// `syncing` where isDueForAttempt refuses it and earliestRetryAt schedules no
// timer, and the engine's single-flight promise was never released — every later
// Sync now, reconnect and retry joined the same dead promise. Only a process
// restart could recover, and the till could not sync, reset, or be re-paired.
//
// THE TRAP THESE TESTS EXIST TO CATCH. An aborted request does NOT arrive as a
// thrown AbortError: postgrest-js catches it and synthesizes an ordinary error
// object whose message contains "AbortError". TRANSPORT_MESSAGE_FRAGMENTS
// matches that string, so an abort routed through the normal classifier comes
// back as `transport` — a definite claim that the request never reached the
// server. That claim is false for a timeout, and it is the exact evidence the
// offline-mode switch runs on. The hanging fixture below reproduces that shape
// faithfully, so a regression here fails rather than quietly going offline.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SALE_SUBMISSION_TIMEOUT_MS,
  submitQueuedSale,
} from "@/lib/offlineSaleRpc";
import type { SaleRpcCall } from "@/lib/offlineSaleRpc";
import { classifySubmissionFailure } from "@/lib/saleSyncClassifier";
import { enqueueSale, getQueuedSale, listQueuedSales } from "@/lib/saleQueueSession";
import type { EnqueueSaleInput } from "@/lib/saleQueueSession";
import {
  createSaleSyncEngine,
  recoverStrandedSales,
  resetStartupSyncForTests,
  resetSyncEngineForTests,
  triggerSaleSync,
} from "@/lib/saleSyncEngine";
import { readOfflineSaleStatus } from "@/lib/offlineCheckoutSession";
import type { OfflineSaleSubmission } from "@/lib/offlineSaleRpc";
import type { QueuedSale } from "@/lib/saleQueue";

const OCCURRED_AT = "2026-08-21T10:00:00.000Z";
const NOW = Date.parse("2026-08-21T11:00:00.000Z");

let seq = 0;

function input(): EnqueueSaleInput {
  seq += 1;

  return {
    queueRecordId: `q-${seq}`,
    saleRequestId: `${String(seq).padStart(8, "a")}-1111-4111-8111-${String(seq).padStart(12, "0")}`,
    deviceAuthUserId: "22222222-2222-4222-8222-222222222222",
    deviceId: "33333333-3333-4333-8333-333333333333",
    projectId: "44444444-4444-4444-8444-444444444444",
    buildJobId: "55555555-5555-4555-8555-555555555555",
    paymentMethod: "cash",
    items: [{ itemId: "1", quantity: 1, modifiers: [] }],
    occurredAt: OCCURRED_AT,
    now: OCCURRED_AT,
  };
}

function receipt(orderNumber: string) {
  return {
    orderId: `order-${orderNumber}`,
    orderNumber,
    paymentMethod: "cash" as const,
    subtotal: "5.00",
    taxAmount: "0.50",
    tipAmount: "0.00",
    total: "5.50",
    createdAt: "2026-08-21T11:00:00Z",
    items: [],
  };
}

/**
 * A request that never answers, and answers the abort the way PostgREST does.
 *
 * postgrest-js does not rethrow to us — it catches the AbortError and resolves
 * with a synthesized error object carrying that text. Reproduced exactly,
 * because a fixture that threw instead would let the sentinel be bypassed and
 * the test would still pass.
 */
const hangingRpc: SaleRpcCall = (_args, signal) =>
  new Promise((resolve) => {
    signal.addEventListener("abort", () => {
      resolve({
        data: null,
        error: {
          message: "AbortError: The operation was aborted",
          details: "",
          hint: "",
          code: "",
        },
      });
    });
  });

/**
 * Waits for a record to actually reach a state, rather than guessing at ticks.
 *
 * The claim is an IndexedDB write, so "await a couple of microtasks" is a race:
 * it passed locally and would have failed on a slower machine, hiding whichever
 * assertion came after it. THROWS on timeout, so a claim that never lands fails
 * the test instead of skipping the interesting part.
 */
async function waitForState(queueRecordId: string, state: QueuedSale["state"]) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const stored = await getQueuedSale(queueRecordId);

    if (stored.ok && stored.value.state === state) return stored.value;

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(`${queueRecordId} never reached "${state}"`);
}

beforeEach(() => {
  seq = 0;
  globalThis.indexedDB = new IDBFactory();
  resetSyncEngineForTests();
  resetStartupSyncForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

describe("the submission is bounded", () => {
  it("passes an abort signal through to the RPC", async () => {
    const rpc = vi.fn<SaleRpcCall>(async () => ({ data: receipt("ORD1"), error: null }));

    await submitQueuedSale({ ...(input() as unknown as QueuedSale) }, { rpc });

    const signal = rpc.mock.calls[0][1];

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it("returns the receipt untouched when the server answers in time", async () => {
    const rpc = vi.fn<SaleRpcCall>(async () => ({ data: receipt("ORD1"), error: null }));
    const result = await submitQueuedSale(input() as unknown as QueuedSale, { rpc });

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.receipt.orderNumber).toBe("ORD1");
    }
  });

  it("sends the PERSISTED saleRequestId, not a fresh one", async () => {
    const rpc = vi.fn<SaleRpcCall>(async () => ({ data: receipt("ORD1"), error: null }));
    const record = input() as unknown as QueuedSale;

    await submitQueuedSale(record, { rpc });
    await submitQueuedSale(record, { rpc });

    expect(rpc.mock.calls[0][0].p_sale_request_id).toBe(record.saleRequestId);
    expect(rpc.mock.calls[1][0].p_sale_request_id).toBe(record.saleRequestId);
  });

  it("aborts a request that never answers, and calls it UNKNOWN", async () => {
    vi.useFakeTimers();

    const pending = submitQueuedSale(input() as unknown as QueuedSale, { rpc: hangingRpc });

    await vi.advanceTimersByTimeAsync(SALE_SUBMISSION_TIMEOUT_MS);

    const result = await pending;

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.failure.timedOut).toBe(true);
      // The whole point. NOT "transport" — that would assert the request never
      // reached the server, which nobody can know here.
      expect(result.failure.transport).toBe("unknown");
    }
  });

  it("does not abort before the deadline", async () => {
    vi.useFakeTimers();

    let aborted = false;
    const rpc: SaleRpcCall = (_args, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        setTimeout(() => resolve({ data: receipt("ORD1"), error: null }), SALE_SUBMISSION_TIMEOUT_MS - 1);
      });

    const pending = submitQueuedSale(input() as unknown as QueuedSale, { rpc });

    await vi.advanceTimersByTimeAsync(SALE_SUBMISSION_TIMEOUT_MS - 1);

    expect(await pending).toMatchObject({ ok: true });
    expect(aborted).toBe(false);
  });

  it("leaves a definite server rejection classified as before", async () => {
    const rpc: SaleRpcCall = async () => ({
      data: null,
      error: {
        message: "Offline sale occurred after this device was revoked",
        details: "",
        hint: "",
        code: "P0001",
      },
    });

    const result = await submitQueuedSale(input() as unknown as QueuedSale, { rpc });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.failure.timedOut).toBeUndefined();
      expect(result.failure.transport).toBe("server_rejected");
    }
  });

  it("leaves a definite transport failure classified as before", async () => {
    const rpc: SaleRpcCall = async () => ({
      data: null,
      error: { message: "TypeError: fetch failed", details: "", hint: "", code: "" },
    });

    const result = await submitQueuedSale(input() as unknown as QueuedSale, { rpc });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.failure.timedOut).toBeUndefined();
      expect(result.failure.transport).toBe("transport");
    }
  });
});

describe("how a timeout is classified", () => {
  it("retries under a distinct code, and never as a transport failure", () => {
    expect(
      classifySubmissionFailure({ transport: "unknown", message: "…", timedOut: true }, 1)
    ).toEqual({ outcome: "retry", code: "sale_timeout" });
  });

  it("asks for a person once the attempts are spent", () => {
    expect(
      classifySubmissionFailure({ transport: "unknown", message: "…", timedOut: true }, 10)
    ).toEqual({ outcome: "needs_attention", code: "timeout_attempts_exhausted" });
  });

  it("wins over the message table, whatever the text says", () => {
    // A timed-out attempt whose message happens to match a catalogued server
    // error must still be an unknown outcome: we never got an answer.
    expect(
      classifySubmissionFailure(
        {
          transport: "unknown",
          message: "Offline sale occurred after this device was revoked",
          timedOut: true,
        },
        1
      )
    ).toEqual({ outcome: "retry", code: "sale_timeout" });
  });

  it("is not something an operator may discard locally", async () => {
    const { decideRejectedSaleDiscardSafety } = await import("@/lib/rejectedSaleResolution");

    for (const code of ["sale_timeout", "timeout_attempts_exhausted"]) {
      expect(
        decideRejectedSaleDiscardSafety({
          record: {
            state: "needs_attention",
            lastErrorCode: code,
            saleRequestId: "x",
            serverOrderId: null,
            serverOrderNumber: null,
          } as QueuedSale,
          uncertain: { present: false },
        })
      ).toEqual({ allowed: false, reason: "not_terminal_rejection" });
    }
  });
});

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/** A submit that hangs for the first N calls, then behaves like a real server. */
function serverWithHangs(hangs: number) {
  const orders = new Map<string, string>();
  let allocated = 1000;
  let calls = 0;

  return {
    orders,
    get calls() {
      return calls;
    },
    submit: vi.fn(async (record: QueuedSale): Promise<OfflineSaleSubmission> => {
      calls += 1;

      if (calls <= hangs) {
        // What the bounded adapter returns when it gives up waiting.
        return {
          ok: false,
          failure: { transport: "unknown", message: "timed out", timedOut: true },
        };
      }

      const existing = orders.get(record.saleRequestId);

      if (existing !== undefined) {
        return { ok: true, receipt: receipt(existing) };
      }

      allocated += 1;
      orders.set(record.saleRequestId, `ORD${allocated}`);

      return { ok: true, receipt: receipt(`ORD${allocated}`) };
    }),
  };
}

describe("a timed-out submission leaves the queue recoverable", () => {
  it("returns the row to pending with its identity intact", async () => {
    await enqueueSale(input());

    const before = await getQueuedSale("q-1");
    const server = serverWithHangs(1);

    await createSaleSyncEngine({ submit: server.submit, now: () => NOW }).run();

    const after = await getQueuedSale("q-1");

    expect(after.ok).toBe(true);

    if (after.ok && before.ok) {
      // OUT of syncing — the whole blocker.
      expect(after.value.state).toBe("pending");
      expect(after.value.lastErrorCode).toBe("sale_timeout");
      // Same sale, same key, same time. Nothing was minted.
      expect(after.value.saleRequestId).toBe(before.value.saleRequestId);
      expect(after.value.occurredAt).toBe(before.value.occurredAt);
      expect(after.value.serverOrderNumber).toBeNull();
      // A retry instant was persisted, so the row is reachable again.
      expect(after.value.nextAttemptAt).not.toBeNull();
    }
  });

  it("does not mark the sale synced, and creates no order", async () => {
    await enqueueSale(input());

    const server = serverWithHangs(1);

    await createSaleSyncEngine({ submit: server.submit, now: () => NOW }).run();

    const status = await readOfflineSaleStatus();

    expect(status.synced).toBe(0);
    expect(status.waiting).toBe(1);
    expect(server.orders.size).toBe(0);
  });

  it("keeps the queue evidence and its provisional reference unchanged", async () => {
    await enqueueSale(input());

    const before = await listQueuedSales();
    const server = serverWithHangs(1);

    await createSaleSyncEngine({ submit: server.submit, now: () => NOW }).run();

    const after = await listQueuedSales();

    expect(after.ok && after.value.sales).toHaveLength(1);

    if (after.ok && before.ok) {
      // The reference a customer is holding is derived from saleRequestId, so
      // this is the assertion that the paper slip still matches the record.
      expect(after.value.sales[0].saleRequestId).toBe(before.value.sales[0].saleRequestId);
      expect(after.value.sales[0].items).toEqual(before.value.sales[0].items);
      expect(after.value.quarantined).toHaveLength(0);
    }
  });

  it("releases the engine, so the next trigger actually runs", async () => {
    await enqueueSale(input());

    const server = serverWithHangs(1);
    const engine = createSaleSyncEngine({ submit: server.submit, now: () => NOW });

    await engine.run();

    // The old failure mode: activeRun never cleared because the drain promise
    // never settled, so everything after this joined a dead promise.
    expect(engine.isRunning()).toBe(false);

    await engine.run({ manual: true });

    expect(server.submit).toHaveBeenCalledTimes(2);
    expect((await readOfflineSaleStatus()).synced).toBe(1);
  });
});

describe("retrying after a timeout cannot duplicate a sale", () => {
  it("creates exactly one order when the server never committed", async () => {
    await enqueueSale(input());

    const server = serverWithHangs(1);
    const engine = createSaleSyncEngine({ submit: server.submit, now: () => NOW });

    await engine.run();
    await engine.run({ manual: true });

    expect(server.orders.size).toBe(1);
    expect((await readOfflineSaleStatus()).synced).toBe(1);
  });

  it("returns the ORIGINAL order when the server did commit but the answer was lost", async () => {
    await enqueueSale(input());

    const stored = await getQueuedSale("q-1");
    const key = stored.ok ? stored.value.saleRequestId : "";

    const orders = new Map<string, string>([[key, "ORD9001"]]);
    let calls = 0;

    // The server committed on the attempt we timed out on. Every later attempt
    // must find that order by its idempotency key, not allocate a new one.
    const submit = vi.fn(async (record: QueuedSale): Promise<OfflineSaleSubmission> => {
      calls += 1;

      if (calls === 1) {
        return {
          ok: false,
          failure: { transport: "unknown", message: "timed out", timedOut: true },
        };
      }

      const existing = orders.get(record.saleRequestId);

      if (existing === undefined) {
        throw new Error("a second order was allocated for the same sale");
      }

      return { ok: true, receipt: receipt(existing) };
    });

    const engine = createSaleSyncEngine({ submit, now: () => NOW });

    await engine.run();
    await engine.run({ manual: true });

    const final = await getQueuedSale("q-1");

    expect(final.ok && final.value.state).toBe("synced");
    expect(final.ok && final.value.serverOrderNumber).toBe("ORD9001");
    expect(orders.size).toBe(1);
  });

  it("survives repeated timeouts without ever losing the key", async () => {
    await enqueueSale(input());

    const before = await getQueuedSale("q-1");
    const server = serverWithHangs(3);
    const engine = createSaleSyncEngine({ submit: server.submit, now: () => NOW });

    for (let i = 0; i < 4; i += 1) {
      await engine.run({ manual: true });
    }

    const keys = new Set(server.submit.mock.calls.map((call) => call[0].saleRequestId));

    expect(keys.size).toBe(1);
    expect(before.ok && keys.has(before.value.saleRequestId)).toBe(true);
    expect(server.orders.size).toBe(1);
  });
});

describe("manual Sync now, backoff, and live claims", () => {
  it("automatic triggers respect a persisted backoff", async () => {
    await enqueueSale(input());

    const server = serverWithHangs(1);
    const engine = createSaleSyncEngine({ submit: server.submit, now: () => NOW });

    await engine.run();

    // The backoff instant is in the future, so an automatic pass finds nothing.
    await engine.run();

    expect(server.submit).toHaveBeenCalledTimes(1);
  });

  it("a manual press retries a pending row despite a future backoff", async () => {
    await enqueueSale(input());

    const server = serverWithHangs(1);
    const engine = createSaleSyncEngine({ submit: server.submit, now: () => NOW });

    await engine.run();
    await engine.run({ manual: true });

    expect(server.submit).toHaveBeenCalledTimes(2);
    expect((await readOfflineSaleStatus()).synced).toBe(1);
  });

  it("a manual press NEVER reclaims a row that is still syncing", async () => {
    await enqueueSale(input());

    // Declared with a definite-assignment assertion: TypeScript narrows a
    // `let` assigned only inside a Promise executor to `never` at the use site.
    let release!: (value: OfflineSaleSubmission) => void;
    const inFlight = new Promise<OfflineSaleSubmission>((resolve) => {
      release = resolve;
    });

    const submit = vi.fn(async (): Promise<OfflineSaleSubmission> => inFlight);
    const engine = createSaleSyncEngine({ submit, now: () => NOW });

    const first = engine.run();

    // The row is now `syncing` with a request genuinely on the wire.
    await waitForState("q-1", "syncing");

    // A manual press while it is genuinely in flight must not reissue it.
    const second = createSaleSyncEngine({ submit, now: () => NOW });

    await second.run({ manual: true });

    expect(submit).toHaveBeenCalledTimes(1);

    release({ ok: true, receipt: receipt("ORD1") });
    await first;

    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("repeated manual presses stay single-flight and submit once", async () => {
    await enqueueSale(input());

    const server = serverWithHangs(0);
    const engine = createSaleSyncEngine({ submit: server.submit, now: () => NOW });

    await Promise.all([
      engine.run({ manual: true }),
      engine.run({ manual: true }),
      engine.run({ manual: true }),
    ]);

    expect(server.submit).toHaveBeenCalledTimes(1);
    expect(server.orders.size).toBe(1);
  });

  it("only the manual trigger relaxes the backoff", async () => {
    await enqueueSale(input());

    const server = serverWithHangs(1);

    // Prime a backoff through the shared engine the triggers use.
    await triggerSaleSync("retry", { submit: server.submit, now: () => NOW });
    expect(server.submit).toHaveBeenCalledTimes(1);

    for (const trigger of ["reconnect", "retry", "revoked"] as const) {
      await triggerSaleSync(trigger, { submit: server.submit, now: () => NOW });
    }

    expect(server.submit).toHaveBeenCalledTimes(1);

    await triggerSaleSync("manual", { submit: server.submit, now: () => NOW });

    expect(server.submit).toHaveBeenCalledTimes(2);
  });
});

describe("a process killed mid-submission still recovers", () => {
  it("startup reclaims the stranded row under the same identity", async () => {
    await enqueueSale(input());

    const before = await getQueuedSale("q-1");

    // Model the kill: claim the row, then abandon the promise entirely.
    const abandoned = createSaleSyncEngine({
      submit: () => new Promise<OfflineSaleSubmission>(() => {}),
      now: () => NOW,
    });

    void abandoned.run();

    await waitForState("q-1", "syncing");

    // A restart: fresh module state, then the startup reclaim.
    resetSyncEngineForTests();
    resetStartupSyncForTests();

    expect(await recoverStrandedSales(NOW)).toBe(1);

    const recovered = await getQueuedSale("q-1");

    expect(recovered.ok && recovered.value.state).toBe("pending");
    expect(recovered.ok && before.ok && recovered.value.saleRequestId).toBe(
      before.ok ? before.value.saleRequestId : null
    );

    const server = serverWithHangs(0);

    await createSaleSyncEngine({ submit: server.submit, now: () => NOW }).run({
      manual: true,
    });

    expect(server.orders.size).toBe(1);
    expect((await readOfflineSaleStatus()).synced).toBe(1);
  });
});

describe("end to end: the real adapter unwedges a hung row", () => {
  // A SHORT REAL TIMEOUT, not fake timers. fake-indexeddb schedules its own work
  // on the macrotask queue, so freezing the clock here would deadlock the
  // storage layer rather than test it. 25ms is long enough to be a real deadline
  // and short enough to keep the suite fast.
  const BRIEF = 25;

  it("claims, gives up, and returns the row to pending under the same key", async () => {
    await enqueueSale(input());

    const before = await getQueuedSale("q-1");
    const engine = createSaleSyncEngine({
      submit: (record) => submitQueuedSale(record, { rpc: hangingRpc, timeoutMs: BRIEF }),
      now: () => NOW,
    });

    // WITHOUT THE TIMEOUT THIS NEVER RESOLVES. That is the blocker, and it is
    // what the negative control demonstrates when the timer is disarmed.
    const report = await engine.run();

    expect(report.attempted).toBe(1);
    expect(report.retrying).toBe(1);
    expect(engine.isRunning()).toBe(false);

    const after = await getQueuedSale("q-1");

    expect(after.ok && after.value.state).toBe("pending");
    expect(after.ok && after.value.lastErrorCode).toBe("sale_timeout");
    expect(after.ok && before.ok && after.value.saleRequestId).toBe(
      before.ok ? before.value.saleRequestId : null
    );
    expect(after.ok && after.value.serverOrderNumber).toBeNull();
  });

  it("a manual press afterwards reaches the server and settles the sale", async () => {
    await enqueueSale(input());

    const engine = createSaleSyncEngine({
      submit: (record) => submitQueuedSale(record, { rpc: hangingRpc, timeoutMs: BRIEF }),
      now: () => NOW,
    });

    await engine.run();

    const server = serverWithHangs(0);

    // The press that used to join a dead promise and do nothing.
    await createSaleSyncEngine({ submit: server.submit, now: () => NOW }).run({
      manual: true,
    });

    expect(server.orders.size).toBe(1);
    expect((await readOfflineSaleStatus()).synced).toBe(1);
    expect((await readOfflineSaleStatus()).unsynced).toBe(0);
  });
});
