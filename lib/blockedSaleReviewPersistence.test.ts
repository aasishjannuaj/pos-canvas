// v1.3 CP-2B item C — the persistence boundary, against a real IndexedDB.
//
// fake-indexeddb implements the IndexedDB specification, so these go through
// the actual store: the same open, the same object store, the same read-back.
// That is what makes "persists across a local reload" a measurement here rather
// than a claim — the record is re-read from storage, not from a variable.
//
// EVERY NEGATIVE CASE INDEPENDENT REVIEW NAMED IS ASSERTED HERE, at the boundary
// that actually writes, not in pure logic a caller might not use.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";

import {
  enqueueSale,
  getQueuedSale,
  recordBlockedSaleReview,
  REGISTER_BLOCKED_ERROR_CODE,
  updateQueueState,
} from "@/lib/saleQueueSession";
import { BLOCKED_SALE_REVIEW_TRAIL_LIMIT } from "@/lib/saleQueue";
import type { BlockedSaleReviewEntry } from "@/lib/saleQueue";

const SALE = "11111111-1111-4111-8111-111111111111";
const QUEUE = "q-1";
const NOW = "2026-10-12T09:00:00.000Z";

function entry(overrides: Partial<BlockedSaleReviewEntry> = {}): BlockedSaleReviewEntry {
  return {
    action: "acknowledged",
    saleRequestId: SALE,
    byEmployeeId: "66666666-6666-4666-8666-666666666666",
    byDisplayName: "Mira",
    byRole: "manager",
    atIso: NOW,
    claimedRegisterSessionId: "77777777-7777-4777-8777-777777777777",
    recordedAsCashPayment: true,
    note: null,
    ...overrides,
  };
}

/** A queued sale blocked exactly the way this workflow exists for. */
async function seedBlockedSale(): Promise<void> {
  const queued = await enqueueSale({
    saleRequestId: SALE,
    queueRecordId: QUEUE,
    deviceAuthUserId: "22222222-2222-4222-8222-222222222222",
    deviceId: "33333333-3333-4333-8333-333333333333",
    projectId: "44444444-4444-4444-8444-444444444444",
    buildJobId: "55555555-5555-4555-8555-555555555555",
    paymentMethod: "cash",
    items: [{ itemId: "item-1", quantity: 2, modifiers: [] }],
    occurredAt: "2026-10-12T00:05:00.000Z",
    now: NOW,
    registerSessionId: "77777777-7777-4777-8777-777777777777",
  });

  expect(queued.ok).toBe(true);

  const syncing = await updateQueueState(QUEUE, "syncing", NOW);

  expect(syncing.ok).toBe(true);

  const blocked = await updateQueueState(QUEUE, "needs_attention", NOW, {
    lastErrorCode: REGISTER_BLOCKED_ERROR_CODE,
    lastErrorMessage: "A register session is required for an offline sale",
  });

  expect(blocked.ok).toBe(true);
}

/** Re-reads from storage. Nothing in-memory is trusted. */
async function reload() {
  const read = await getQueuedSale(QUEUE);

  expect(read.ok).toBe(true);
  if (!read.ok) throw new Error("record vanished");

  return read.value;
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  await seedBlockedSale();
});

describe("recording a decision", () => {
  it("persists across a local reload", async () => {
    const saved = await recordBlockedSaleReview(QUEUE, entry());

    expect(saved.ok).toBe(true);

    // READ BACK FROM THE STORE, not from the value returned above.
    const after = await reload();

    expect(after.blockedSaleReviews).toHaveLength(1);
    expect(after.blockedSaleReviews?.[0]).toEqual(entry());
  });

  it("leaves the sale financially unresolved and still in Needs Attention", async () => {
    const before = await reload();

    expect((await recordBlockedSaleReview(QUEUE, entry())).ok).toBe(true);

    const after = await reload();

    // THE SALE IS UNCHANGED. Acknowledging is not resolving: identity, money,
    // claim, state and error code all survive, so it stays on the screen.
    expect(after.state).toBe("needs_attention");
    expect(after.saleRequestId).toBe(before.saleRequestId);
    expect(after.items).toEqual(before.items);
    expect(after.paymentMethod).toBe(before.paymentMethod);
    expect(after.registerSessionId).toBe(before.registerSessionId);
    expect(after.occurredAt).toBe(before.occurredAt);
    expect(after.lastErrorCode).toBe(REGISTER_BLOCKED_ERROR_CODE);
    expect(after.serverOrderId).toBeNull();
  });

  it("appends a second decision without replacing the first", async () => {
    await recordBlockedSaleReview(QUEUE, entry());
    await recordBlockedSaleReview(QUEUE, entry({ action: "escalated", byDisplayName: "Olive" }));

    const after = await reload();

    expect(after.blockedSaleReviews?.map((e) => e.action)).toEqual([
      "acknowledged",
      "escalated",
    ]);
  });
});

describe("the boundary verifies its own target", () => {
  it("REFUSES an entry whose sale id does not match the stored record", async () => {
    // The defect independent review found: a stale or swapped entry could be
    // filed against another sale's record.
    const result = await recordBlockedSaleReview(
      QUEUE,
      entry({ saleRequestId: "99999999-9999-4999-8999-999999999999" })
    );

    expect(result).toEqual({ ok: false, reason: "sale_mismatch" });
    expect((await reload()).blockedSaleReviews).toEqual([]);
  });

  it("REFUSES a record that is not waiting for attention", async () => {
    for (const state of ["pending", "discarded"] as const) {
      globalThis.indexedDB = new IDBFactory();
      await seedBlockedSale();

      const moved =
        state === "pending"
          ? await updateQueueState(QUEUE, "pending", NOW)
          : await updateQueueState(QUEUE, "discarded", NOW);

      expect(moved.ok).toBe(true);

      expect(await recordBlockedSaleReview(QUEUE, entry())).toEqual({
        ok: false,
        reason: "not_blocked",
      });
      expect((await reload()).blockedSaleReviews).toEqual([]);
    }
  });

  it("REFUSES a sale blocked for some other reason", async () => {
    // This workflow was authorised for register-attribution-blocked sales.
    const moved = await updateQueueState(QUEUE, "pending", NOW);

    expect(moved.ok).toBe(true);

    const resyncing = await updateQueueState(QUEUE, "syncing", NOW);

    expect(resyncing.ok).toBe(true);

    const other = await updateQueueState(QUEUE, "needs_attention", NOW, {
      lastErrorCode: "server_rejected",
      lastErrorMessage: "Something else entirely",
    });

    expect(other.ok).toBe(true);

    expect(await recordBlockedSaleReview(QUEUE, entry())).toEqual({
      ok: false,
      reason: "not_register_blocked",
    });
    expect((await reload()).blockedSaleReviews).toEqual([]);
  });

  it("refuses an unknown record rather than creating one", async () => {
    expect(await recordBlockedSaleReview("no-such-record", entry())).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("the history limit cannot silently lose a decision", () => {
  it("refuses at the cap and reports it, rather than returning success", async () => {
    for (let i = 0; i < BLOCKED_SALE_REVIEW_TRAIL_LIMIT; i += 1) {
      const step = await recordBlockedSaleReview(QUEUE, entry({ byDisplayName: `R${i}` }));

      expect(step.ok).toBe(true);
    }

    expect((await reload()).blockedSaleReviews).toHaveLength(BLOCKED_SALE_REVIEW_TRAIL_LIMIT);

    const overflow = await recordBlockedSaleReview(QUEUE, entry({ byDisplayName: "LOST" }));

    // NOT { ok: true }. The caller must be able to tell the reviewer.
    expect(overflow).toEqual({ ok: false, reason: "history_full" });
  });

  it("preserves every existing decision when it refuses", async () => {
    for (let i = 0; i < BLOCKED_SALE_REVIEW_TRAIL_LIMIT; i += 1) {
      await recordBlockedSaleReview(QUEUE, entry({ byDisplayName: `R${i}` }));
    }

    const before = await reload();

    await recordBlockedSaleReview(QUEUE, entry({ byDisplayName: "LOST" }));

    const after = await reload();

    expect(after.blockedSaleReviews).toEqual(before.blockedSaleReviews);
    expect(after.blockedSaleReviews?.[0].byDisplayName).toBe("R0");
    expect(after.blockedSaleReviews?.some((e) => e.byDisplayName === "LOST")).toBe(false);
  });
});
