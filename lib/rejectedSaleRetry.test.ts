// Feature 24.5F — retrying a sale that gave up, and the budget that let it.
//
// TWO DEFECTS, ONE HARDWARE SEQUENCE. Windows QA queued a sale offline and
// pressed Sync now repeatedly. Because manual presses had just been allowed to
// skip the backoff, and the backoff was the only thing rate-limiting attempts,
// ten taps burned the entire SYNC_MAX_ATTEMPTS budget in seconds and filed a
// perfectly good sale as needing attention. And once there, the ready POS screen
// offered no way to act on it at all — the sale was unreachable, and reset could
// not clear it either, because that sale was what blocked reset.
//
// The budget rule is a statement about TIME (ten attempts is roughly seventy
// minutes of the curve), not about how many times a finger touched glass.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  RETRYABLE_NEEDS_ATTENTION_CODES,
  TERMINAL_LOCAL_RESOLUTION_CODES,
  decideRejectedSaleDiscardSafety,
  decideRejectedSaleRetrySafety,
  describeRejectedSaleReason,
  isRetryableNeedsAttentionCode,
} from "@/lib/rejectedSaleResolution";
import { classifySubmissionFailure } from "@/lib/saleSyncClassifier";
import { enqueueSale, getQueuedSale, updateQueueState } from "@/lib/saleQueueSession";
import type { EnqueueSaleInput } from "@/lib/saleQueueSession";
import { createSaleSyncEngine, resetSyncEngineForTests } from "@/lib/saleSyncEngine";
import { readOfflineSaleStatus } from "@/lib/offlineCheckoutSession";
import { listRejectedSaleReviews, retryRejectedSale } from "@/lib/rejectedSaleSession";
import { armUncertainSale, resolveUncertainSale } from "@/lib/uncertainSaleSession";
import { createUncertainSale } from "@/lib/saleSubmission";
import type { OfflineSaleSubmission } from "@/lib/offlineSaleRpc";
import type { QueuedSale } from "@/lib/saleQueue";

const OCCURRED_AT = "2026-08-22T09:00:00.000Z";
const NOW = Date.parse("2026-08-22T10:00:00.000Z");

const IDENTITY = {
  deviceAuthUserId: "22222222-2222-4222-8222-222222222222",
  deviceId: "33333333-3333-4333-8333-333333333333",
  projectId: "44444444-4444-4444-8444-444444444444",
  buildJobId: "55555555-5555-4555-8555-555555555555",
};

let seq = 0;

function input(): EnqueueSaleInput {
  seq += 1;

  return {
    queueRecordId: `q-${seq}`,
    saleRequestId: `${String(seq).padStart(8, "a")}-1111-4111-8111-${String(seq).padStart(12, "0")}`,
    ...IDENTITY,
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
    createdAt: "2026-08-22T10:00:00Z",
    items: [],
  };
}

/** Exactly what postgrest-js synthesizes when the device has no network. */
const offlineSubmit = vi.fn(
  async (): Promise<OfflineSaleSubmission> => ({
    ok: false,
    failure: { transport: "transport", message: "TypeError: fetch failed" },
  })
);

function sale(patch: Partial<QueuedSale> = {}): QueuedSale {
  return {
    state: "needs_attention",
    lastErrorCode: "transport_attempts_exhausted",
    saleRequestId: "11111111-1111-4111-8111-111111111111",
    serverOrderId: null,
    serverOrderNumber: null,
    ...patch,
  } as QueuedSale;
}

const NO_UNCERTAIN = { present: false } as const;

beforeEach(() => {
  seq = 0;
  globalThis.indexedDB = new IDBFactory();
  resetSyncEngineForTests();
  offlineSubmit.mockClear();
});

// ---------------------------------------------------------------------------
// A. the manual attempt budget
// ---------------------------------------------------------------------------

describe("manual presses cannot burn the retry budget", () => {
  it("survives fifteen offline Sync now presses without needing attention", async () => {
    await enqueueSale(input());

    const engine = createSaleSyncEngine({ submit: offlineSubmit, now: () => NOW });

    // The exact hardware sequence: offline, tapping, clock never advancing.
    for (let press = 0; press < 15; press += 1) {
      await engine.run({ manual: true });
    }

    const record = await getQueuedSale("q-1");
    const status = await readOfflineSaleStatus();

    expect(record.ok).toBe(true);

    if (record.ok) {
      expect(record.value.state).toBe("pending");
      expect(record.value.lastErrorCode).toBe("transport");
      // The attempts are still counted — the curve and the diagnostics stay
      // honest. What changes is that a manual press cannot be the one that
      // escalates.
      expect(record.value.attemptCount).toBe(15);
    }

    expect(status.needsAttention).toBe(0);
    expect(status.waiting).toBe(1);
  });

  it("keeps one identity across every press", async () => {
    await enqueueSale(input());

    const before = await getQueuedSale("q-1");
    const engine = createSaleSyncEngine({ submit: offlineSubmit, now: () => NOW });

    for (let press = 0; press < 12; press += 1) {
      await engine.run({ manual: true });
    }

    const after = await getQueuedSale("q-1");

    expect(after.ok && before.ok && after.value.saleRequestId).toBe(
      before.ok ? before.value.saleRequestId : null
    );
  });

  it("syncs on the next press once the network returns, with one order", async () => {
    await enqueueSale(input());

    const engine = createSaleSyncEngine({ submit: offlineSubmit, now: () => NOW });

    for (let press = 0; press < 12; press += 1) {
      await engine.run({ manual: true });
    }

    const orders = new Map<string, string>();
    const online = vi.fn(async (record: QueuedSale): Promise<OfflineSaleSubmission> => {
      const existing = orders.get(record.saleRequestId);

      if (existing !== undefined) return { ok: true, receipt: receipt(existing) };

      orders.set(record.saleRequestId, "ORD5001");

      return { ok: true, receipt: receipt("ORD5001") };
    });

    await createSaleSyncEngine({ submit: online, now: () => NOW }).run({ manual: true });

    expect(orders.size).toBe(1);
    expect((await readOfflineSaleStatus()).synced).toBe(1);
  });

  it("AUTOMATIC attempts still exhaust normally under the timed backoff", async () => {
    await enqueueSale(input());

    // Each automatic pass gets a clock past the persisted backoff, which is what
    // a real outage looks like over an hour and a bit.
    let clock = NOW;

    for (let pass = 0; pass < 12; pass += 1) {
      await createSaleSyncEngine({ submit: offlineSubmit, now: () => clock }).run();
      clock += 16 * 60 * 1000;
    }

    const record = await getQueuedSale("q-1");

    expect(record.ok && record.value.state).toBe("needs_attention");
    expect(record.ok && record.value.lastErrorCode).toBe("transport_attempts_exhausted");
  });

  it("a manual press still respects a server's answer", async () => {
    await enqueueSale(input());

    const refuse = vi.fn(
      async (): Promise<OfflineSaleSubmission> => ({
        ok: false,
        failure: {
          transport: "server_rejected",
          message: "Offline sale occurred after this device was revoked",
        },
      })
    );

    await createSaleSyncEngine({ submit: refuse, now: () => NOW }).run({ manual: true });

    const record = await getQueuedSale("q-1");

    // `manual` must never mean "ignore the server".
    expect(record.ok && record.value.state).toBe("needs_attention");
    expect(record.ok && record.value.lastErrorCode).toBe("post_revocation");
  });

  it("classifies exhaustion by trigger, not by counter alone", () => {
    const transport = { transport: "transport" as const, message: "fetch failed" };

    expect(classifySubmissionFailure(transport, 10)).toEqual({
      outcome: "needs_attention",
      code: "transport_attempts_exhausted",
    });
    expect(classifySubmissionFailure(transport, 10, { manual: true })).toEqual({
      outcome: "retry",
      code: "transport",
    });

    const timeout = { transport: "unknown" as const, message: "…", timedOut: true };

    expect(classifySubmissionFailure(timeout, 10, { manual: true })).toEqual({
      outcome: "retry",
      code: "sale_timeout",
    });

    const unknown = { transport: "unknown" as const, message: "?" };

    expect(classifySubmissionFailure(unknown, 10, { manual: true })).toEqual({
      outcome: "retry",
      code: "unknown_outcome",
    });

    // A business answer is unaffected by who asked.
    expect(
      classifySubmissionFailure(
        { transport: "server_rejected", message: "Offline sale occurred after this device was revoked" },
        10,
        { manual: true }
      )
    ).toEqual({ outcome: "needs_attention", code: "post_revocation" });
  });
});

// ---------------------------------------------------------------------------
// B. which codes may be retried
// ---------------------------------------------------------------------------

describe("the retry allowlist", () => {
  it("holds exactly the three no-answer codes", () => {
    expect([...RETRYABLE_NEEDS_ATTENTION_CODES].sort()).toEqual([
      "timeout_attempts_exhausted",
      "transport_attempts_exhausted",
      "unknown_attempts_exhausted",
    ]);
  });

  it("is DISJOINT from the discard allowlist", () => {
    const overlap = RETRYABLE_NEEDS_ATTENTION_CODES.filter((code) =>
      TERMINAL_LOCAL_RESOLUTION_CODES.includes(code)
    );

    // Retryable means "no answer yet". Discardable means "a definitive answer
    // that will never change". Nothing can be both.
    expect(overlap).toEqual([]);
  });

  for (const code of [
    "transport_attempts_exhausted",
    "timeout_attempts_exhausted",
    "unknown_attempts_exhausted",
  ]) {
    it(`allows retry for ${code}`, () => {
      expect(
        decideRejectedSaleRetrySafety({ record: sale({ lastErrorCode: code }), uncertain: NO_UNCERTAIN })
      ).toEqual({ allowed: true });
      expect(isRetryableNeedsAttentionCode(code)).toBe(true);
    });
  }

  it("forbids retry for post_revocation, which stays discardable", () => {
    const record = sale({ lastErrorCode: "post_revocation" });

    expect(decideRejectedSaleRetrySafety({ record, uncertain: NO_UNCERTAIN })).toEqual({
      allowed: false,
      reason: "not_retryable",
    });
    expect(decideRejectedSaleDiscardSafety({ record, uncertain: NO_UNCERTAIN })).toEqual({
      allowed: true,
    });
  });

  it("offers neither action for an arbitrary server rejection", () => {
    for (const code of ["unrecognised_server_error", "invalid_item", "hash_conflict", "not_authorized"]) {
      const record = sale({ lastErrorCode: code });

      expect(decideRejectedSaleRetrySafety({ record, uncertain: NO_UNCERTAIN })).toEqual({
        allowed: false,
        reason: "not_retryable",
      });
      expect(decideRejectedSaleDiscardSafety({ record, uncertain: NO_UNCERTAIN })).toEqual({
        allowed: false,
        reason: "not_terminal_rejection",
      });
    }
  });

  it("refuses retry for every state that is not needs_attention", () => {
    for (const state of ["pending", "syncing", "synced", "discarded", "permanent_failure"] as const) {
      expect(
        decideRejectedSaleRetrySafety({ record: sale({ state }), uncertain: NO_UNCERTAIN })
      ).toEqual({ allowed: false, reason: "not_needs_attention" });
    }
  });

  it("refuses retry when the server already has an order", () => {
    expect(
      decideRejectedSaleRetrySafety({ record: sale({ serverOrderNumber: "ORD1" }), uncertain: NO_UNCERTAIN })
    ).toEqual({ allowed: false, reason: "server_order_exists" });

    expect(
      decideRejectedSaleRetrySafety({ record: sale({ serverOrderId: "order-1" }), uncertain: NO_UNCERTAIN })
    ).toEqual({ allowed: false, reason: "server_order_exists" });
  });

  it("refuses retry while an outstanding request may be this sale", () => {
    expect(
      decideRejectedSaleRetrySafety({
        record: sale(),
        uncertain: { present: true, saleRequestId: "11111111-1111-4111-8111-111111111111" },
      })
    ).toEqual({ allowed: false, reason: "uncertain_sale_outstanding" });

    expect(
      decideRejectedSaleRetrySafety({
        record: sale(),
        uncertain: { present: true, saleRequestId: null },
      })
    ).toEqual({ allowed: false, reason: "uncertain_sale_outstanding" });
  });

  it("explains a no-answer failure without blaming the server", () => {
    const reason = describeRejectedSaleReason("transport_attempts_exhausted");

    expect(reason).toContain("couldn't finish syncing");
    expect(reason).toContain("can be sent again");

    for (const jargon of ["transport", "v4", "complete_sale", "RPC", "attempts_exhausted"]) {
      expect(reason).not.toContain(jargon);
    }
  });
});

// ---------------------------------------------------------------------------
// C. the operator retry
// ---------------------------------------------------------------------------

/** Drives a queued sale to needs_attention/transport_attempts_exhausted. */
async function exhaustedSale() {
  await enqueueSale(input());

  let clock = NOW;

  for (let pass = 0; pass < 12; pass += 1) {
    await createSaleSyncEngine({ submit: offlineSubmit, now: () => clock }).run();
    clock += 16 * 60 * 1000;
  }

  const record = await getQueuedSale("q-1");

  if (!record.ok || record.value.state !== "needs_attention") {
    throw new Error("fixture did not reach needs_attention");
  }

  return record.value;
}

describe("an operator retry starts a clean cycle", () => {
  it("resets the budget, clears the backoff, and keeps the identity", async () => {
    const before = await exhaustedSale();

    expect(before.attemptCount).toBe(10);

    const result = await retryRejectedSale("q-1");

    expect(result.ok).toBe(true);

    const after = await getQueuedSale("q-1");

    expect(after.ok).toBe(true);

    if (after.ok) {
      expect(after.value.state).toBe("pending");
      expect(after.value.attemptCount).toBe(0);
      expect(after.value.nextAttemptAt).toBeNull();
      expect(after.value.lastErrorCode).toBeNull();
      // THE SALE IS THE SAME SALE.
      expect(after.value.saleRequestId).toBe(before.saleRequestId);
      expect(after.value.occurredAt).toBe(before.occurredAt);
      expect(after.value.items).toEqual(before.items);
      expect(after.value.paymentMethod).toBe(before.paymentMethod);
      expect(after.value.source).toBe(before.source);
      expect(after.value.queuedAt).toBe(before.queuedAt);
      expect(after.value.serverOrderNumber).toBeNull();
    }
  });

  it("then syncs to exactly one order", async () => {
    const before = await exhaustedSale();

    await retryRejectedSale("q-1");

    const orders = new Map<string, string>();
    const online = vi.fn(async (record: QueuedSale): Promise<OfflineSaleSubmission> => {
      const existing = orders.get(record.saleRequestId);

      if (existing !== undefined) return { ok: true, receipt: receipt(existing) };

      orders.set(record.saleRequestId, "ORD7001");

      return { ok: true, receipt: receipt("ORD7001") };
    });

    await createSaleSyncEngine({ submit: online, now: () => NOW }).run({ manual: true });

    const final = await getQueuedSale("q-1");

    expect(final.ok && final.value.state).toBe("synced");
    expect(final.ok && final.value.serverOrderNumber).toBe("ORD7001");
    expect(final.ok && final.value.saleRequestId).toBe(before.saleRequestId);
    expect(orders.size).toBe(1);
    expect((await readOfflineSaleStatus()).unsynced).toBe(0);
  });

  it("replays the ORIGINAL order when the server had already committed", async () => {
    const before = await exhaustedSale();

    await retryRejectedSale("q-1");

    // The server took it during one of the attempts we gave up on.
    const orders = new Map<string, string>([[before.saleRequestId, "ORD7777"]]);
    const online = vi.fn(async (record: QueuedSale): Promise<OfflineSaleSubmission> => {
      const existing = orders.get(record.saleRequestId);

      if (existing === undefined) {
        throw new Error("a second order was allocated for the same sale");
      }

      return { ok: true, receipt: receipt(existing) };
    });

    await createSaleSyncEngine({ submit: online, now: () => NOW }).run({ manual: true });

    const final = await getQueuedSale("q-1");

    expect(final.ok && final.value.serverOrderNumber).toBe("ORD7777");
    expect(orders.size).toBe(1);
  });

  it("refuses a sale the server already recorded", async () => {
    await exhaustedSale();
    await updateQueueState("q-1", "pending", new Date(NOW).toISOString());
    await updateQueueState("q-1", "syncing", new Date(NOW).toISOString());

    const online = vi.fn(
      async (): Promise<OfflineSaleSubmission> => ({ ok: true, receipt: receipt("ORD1") })
    );

    await createSaleSyncEngine({ submit: online, now: () => NOW }).run({ manual: true });

    expect(await retryRejectedSale("q-1")).toEqual({
      ok: false,
      reason: "not_needs_attention",
    });
  });

  it("refuses a pending sale the engine still owns", async () => {
    await enqueueSale(input());

    expect(await retryRejectedSale("q-1")).toEqual({
      ok: false,
      reason: "not_needs_attention",
    });
  });

  it("refuses a post_revocation sale outright", async () => {
    await enqueueSale(input());

    const refuse = vi.fn(
      async (): Promise<OfflineSaleSubmission> => ({
        ok: false,
        failure: {
          transport: "server_rejected",
          message: "Offline sale occurred after this device was revoked",
        },
      })
    );

    await createSaleSyncEngine({ submit: refuse, now: () => NOW }).run();

    expect(await retryRejectedSale("q-1")).toEqual({ ok: false, reason: "not_retryable" });

    const record = await getQueuedSale("q-1");

    expect(record.ok && record.value.state).toBe("needs_attention");
  });

  it("refuses while an outstanding request names this sale", async () => {
    const before = await exhaustedSale();

    await armUncertainSale({
      sale: createUncertainSale({
        saleRequestId: before.saleRequestId,
        projectId: IDENTITY.projectId,
        paymentMethod: "cash",
        tipAmount: 0,
        items: [{ itemId: "1", quantity: 1, modifiers: [] }],
        fingerprint: "same-sale",
      }),
      identity: IDENTITY,
      dispatchedAt: OCCURRED_AT,
    });

    expect(await retryRejectedSale("q-1")).toEqual({
      ok: false,
      reason: "uncertain_sale_outstanding",
    });

    await resolveUncertainSale();

    expect((await retryRejectedSale("q-1")).ok).toBe(true);
  });

  it("a stale review cannot talk it into acting", async () => {
    await exhaustedSale();

    // What a stale render still believes: retryable.
    const staleReviews = await listRejectedSaleReviews();

    expect(staleReviews[0].retry.allowed).toBe(true);

    // Storage moves on underneath it.
    await retryRejectedSale("q-1");

    // The second press, from the same stale screen, is refused by the fresh
    // durable check rather than starting a second cycle.
    expect(await retryRejectedSale("q-1")).toEqual({
      ok: false,
      reason: "not_needs_attention",
    });
  });

  it("reports not_found rather than inventing a record", async () => {
    expect(await retryRejectedSale("nope")).toEqual({ ok: false, reason: "not_found" });
  });

  it("reviewing repeatedly never mutates the evidence", async () => {
    await exhaustedSale();

    const before = await getQueuedSale("q-1");

    for (let i = 0; i < 3; i += 1) await listRejectedSaleReviews();

    expect(await getQueuedSale("q-1")).toEqual(before);
  });

  it("surfaces retry, not discard, on an exhausted sale", async () => {
    await exhaustedSale();

    const [review] = await listRejectedSaleReviews();

    expect(review.retry).toEqual({ allowed: true });
    expect(review.discard.allowed).toBe(false);
  });
});
