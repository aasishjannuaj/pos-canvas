// Feature 24.5F — a revoked till still owes the server its queued sales.
//
// THE HARDWARE DEADLOCK THIS PINS. A phone held one legitimate sale taken
// BEFORE the owner revoked it. On learning the revocation the screen said "let
// it sync before resetting this device" and reset correctly refused — but
// nothing could sync, and it sat there for five minutes. The engine was mounted
// the whole time; every route to it happened to be shut at once:
//
//   * startup   — latched per device session, spent at boot;
//   * reconnect — fires on `online`, and the device was ALREADY online;
//   * retry     — needs a persisted nextAttemptAt, and this row had never been
//                 attempted;
//   * Sync now  — rendered only inside the `ready` branch.
//
// THE SERVER WAS NEVER THE PROBLEM. complete_sale_v4 §2 resolves a device
// WITHOUT the revoked filter precisely so §6c can judge each sale: one that
// occurred before revoked_at is accepted, one after it is refused. That
// asymmetry is modelled faithfully below, because the whole point of the fix is
// that the device stops guessing and lets the server decide.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueSale, getQueuedSale, listQueuedSales } from "@/lib/saleQueueSession";
import type { EnqueueSaleInput } from "@/lib/saleQueueSession";
import { createSaleSyncEngine, resetStartupSyncForTests, resetSyncEngineForTests } from "@/lib/saleSyncEngine";
import { readOfflineSaleStatus } from "@/lib/offlineCheckoutSession";
import { decideDeviceResetSafety } from "@/lib/offlineSaleStatus";
import { armUncertainSale, resolveUncertainSale } from "@/lib/uncertainSaleSession";
import {
  discardRejectedSale,
  listRejectedSaleReviews,
  readRejectedSaleReview,
} from "@/lib/rejectedSaleSession";
import { createUncertainSale } from "@/lib/saleSubmission";
import { getDeviceRuntimeMode } from "@/lib/deviceSession";
import type { DevicePairing, DeviceState } from "@/lib/deviceSession";
import type { OfflineSaleSubmission } from "@/lib/offlineSaleRpc";
import type { QueuedSale } from "@/lib/saleQueue";

const REVOKED_AT = Date.parse("2026-08-21T12:00:00.000Z");
const BEFORE = new Date(REVOKED_AT - 3_600_000).toISOString();
const AFTER = new Date(REVOKED_AT + 3_600_000).toISOString();
const NOW = REVOKED_AT + 7_200_000;

const PAIRING: DevicePairing = {
  deviceId: "33333333-3333-4333-8333-333333333333",
  projectId: "44444444-4444-4444-8444-444444444444",
  buildJobId: "55555555-5555-4555-8555-555555555555",
  deviceName: "POS Device",
  platform: "android",
  createdAt: null,
  revokedAt: new Date(REVOKED_AT).toISOString(),
};

let seq = 0;

function input(occurredAt: string): EnqueueSaleInput {
  seq += 1;

  return {
    queueRecordId: `q-${seq}`,
    saleRequestId: `${String(seq).padStart(8, "a")}-1111-4111-8111-${String(seq).padStart(12, "0")}`,
    deviceAuthUserId: "22222222-2222-4222-8222-222222222222",
    deviceId: PAIRING.deviceId,
    projectId: PAIRING.projectId,
    buildJobId: PAIRING.buildJobId,
    paymentMethod: "cash",
    items: [{ itemId: "1", quantity: 1, modifiers: [] }],
    occurredAt,
    now: occurredAt,
  };
}

function receipt(orderNumber: string): OfflineSaleSubmission {
  return {
    ok: true,
    receipt: {
      orderId: `order-${orderNumber}`,
      orderNumber,
      paymentMethod: "cash",
      subtotal: "5.00",
      taxAmount: "0.50",
      tipAmount: "0.00",
      total: "5.50",
      createdAt: "2026-08-21T14:00:00Z",
      items: [],
    },
  };
}

/**
 * complete_sale_v4's revocation window, modelled from the migration's §6c.
 *
 * A revoked device is still RESOLVED — that is what §2 changed — and each
 * offline row is then judged on its own occurred_at.
 */
function revokedServer() {
  const orders = new Map<string, string>();
  let allocated = 1000;

  return {
    orders,
    submit: vi.fn(async (record: QueuedSale): Promise<OfflineSaleSubmission> => {
      const existing = orders.get(record.saleRequestId);

      if (existing !== undefined) {
        return receipt(existing);
      }

      if (Date.parse(record.occurredAt) >= REVOKED_AT) {
        return {
          ok: false,
          failure: {
            transport: "server_rejected",
            // The exact string the migration raises.
            message: "Offline sale occurred after this device was revoked",
          },
        };
      }

      allocated += 1;
      orders.set(record.saleRequestId, `ORD${allocated}`);

      return receipt(`ORD${allocated}`);
    }),
  };
}

function transportFailure(): OfflineSaleSubmission {
  return { ok: false, failure: { transport: "transport", message: "Failed to fetch" } };
}

/** The revoked screen, as DeviceApp renders it. */
function revokedScreen(status: { unsynced: number }) {
  return {
    rendersPosRuntime: false,
    checkoutAvailable: false,
    // statusSlot is rendered only while unresolved evidence exists.
    showsQueueStatus: status.unsynced > 0,
    syncNowAvailable: status.unsynced > 0,
  };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  seq = 0;
  resetSyncEngineForTests();
  resetStartupSyncForTests();
});

// ---------------------------------------------------------------------------
// The exact hardware case
// ---------------------------------------------------------------------------

describe("the pre-revocation sale on a revoked till", () => {
  it("reaches v4, is accepted, and clears the deadlock", async () => {
    const enqueued = await enqueueSale(input(BEFORE));

    expect(enqueued.ok).toBe(true);

    if (!enqueued.ok) return;

    // 1-3. the device learns it is revoked. Checkout is gone; the queue is not.
    const revokedState: DeviceState = { status: "revoked", pairing: PAIRING };

    expect(revokedState.status).toBe("revoked");

    const before = await readOfflineSaleStatus();

    expect(before.waiting).toBe(1);
    expect(decideDeviceResetSafety(before).allowed).toBe(false);

    const screen = revokedScreen(before);

    expect(screen.rendersPosRuntime).toBe(false);
    expect(screen.checkoutAvailable).toBe(false);
    // 4-5. THE FIX: the count and the button are visible on this screen.
    expect(screen.showsQueueStatus).toBe(true);
    expect(screen.syncNowAvailable).toBe(true);

    // 6-8. the automatic drain the revoked state now starts.
    const server = revokedServer();

    await createSaleSyncEngine({ submit: server.submit, now: () => NOW }).run();

    const stored = await getQueuedSale(enqueued.value.queueRecordId);

    expect(stored.ok).toBe(true);

    if (!stored.ok) return;

    expect(stored.value.state).toBe("synced");
    expect(stored.value.serverOrderNumber).toMatch(/^ORD\d+$/);
    // occurred_at is the customer's time, untouched by a late sync.
    expect(stored.value.occurredAt).toBe(BEFORE);

    // 9-10. the count clears and Reset unblocks.
    const after = await readOfflineSaleStatus();

    expect(after.waiting).toBe(0);
    expect(after.unsynced).toBe(0);
    expect(decideDeviceResetSafety(after).allowed).toBe(true);

    // And the screen stops showing a queue it no longer has.
    expect(revokedScreen(after).showsQueueStatus).toBe(false);
  });

  it("submits the row without the device judging its own eligibility", async () => {
    // No local filter on revoked_at anywhere: the row is sent and the server
    // decides. A device that pre-judged would either strand real money or
    // quietly discard evidence.
    await enqueueSale(input(BEFORE));

    const server = revokedServer();

    await createSaleSyncEngine({ submit: server.submit, now: () => NOW }).run();

    expect(server.submit).toHaveBeenCalledTimes(1);
    expect(server.orders.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Post-revocation
// ---------------------------------------------------------------------------

describe("a post-revocation row is submitted and authoritatively refused", () => {
  it("becomes needs_attention, is retained, and keeps Reset blocked", async () => {
    const enqueued = await enqueueSale(input(AFTER));

    expect(enqueued.ok).toBe(true);

    if (!enqueued.ok) return;

    const server = revokedServer();

    await createSaleSyncEngine({ submit: server.submit, now: () => NOW }).run();

    // It WAS sent — the device does not withhold it.
    expect(server.submit).toHaveBeenCalledTimes(1);
    // And no order was created for it.
    expect(server.orders.size).toBe(0);

    const stored = await getQueuedSale(enqueued.value.queueRecordId);

    expect(stored.ok).toBe(true);

    if (!stored.ok) return;

    expect(stored.value.state).toBe("needs_attention");
    expect(stored.value.lastErrorCode).toBe("post_revocation");
    expect(stored.value.serverOrderNumber).toBeNull();

    const status = await readOfflineSaleStatus();

    expect(status.needsAttention).toBe(1);
    expect(status.synced).toBe(0);
    expect(decideDeviceResetSafety(status).allowed).toBe(false);

    // Retained, never deleted, and never retried automatically.
    const listing = await listQueuedSales();

    expect(listing.ok && listing.value.sales).toHaveLength(1);

    const again = vi.fn(async () => receipt("ORD9999"));

    await createSaleSyncEngine({ submit: again, now: () => NOW + 3_600_000 }).run();

    expect(again).not.toHaveBeenCalled();
  });

  it("a mixed queue settles each row on its own merits", async () => {
    await enqueueSale(input(BEFORE));
    await enqueueSale(input(AFTER));

    const server = revokedServer();

    await createSaleSyncEngine({ submit: server.submit, now: () => NOW }).run();

    const listing = await listQueuedSales();

    expect(listing.ok).toBe(true);

    if (!listing.ok) return;

    const states = listing.value.sales.map((sale) => sale.state).sort();

    expect(states).toEqual(["needs_attention", "synced"]);
    expect(server.orders.size).toBe(1);

    // One resolved, one needing a person — reset stays blocked on the evidence.
    const status = await readOfflineSaleStatus();

    expect(status.synced).toBe(1);
    expect(status.needsAttention).toBe(1);
    expect(decideDeviceResetSafety(status).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Failure, retry and repetition
// ---------------------------------------------------------------------------

describe("syncing while revoked behaves like syncing anywhere else", () => {
  it("a transport failure preserves the queue and schedules a retry", async () => {
    const enqueued = await enqueueSale(input(BEFORE));

    expect(enqueued.ok).toBe(true);

    if (!enqueued.ok) return;

    await createSaleSyncEngine({ submit: async () => transportFailure(), now: () => NOW }).run();

    const stored = await getQueuedSale(enqueued.value.queueRecordId);

    expect(stored.ok).toBe(true);

    if (!stored.ok) return;

    expect(stored.value.state).toBe("pending");
    expect(stored.value.nextAttemptAt).not.toBeNull();
    expect(stored.value.serverOrderNumber).toBeNull();

    // Still blocking reset, still visible on the screen.
    const status = await readOfflineSaleStatus();

    expect(status.unsynced).toBe(1);
    expect(status.nextRetryAt).not.toBeNull();
    expect(revokedScreen(status).syncNowAvailable).toBe(true);
  });

  it("a later attempt succeeds once the network returns", async () => {
    const enqueued = await enqueueSale(input(BEFORE));

    expect(enqueued.ok).toBe(true);

    if (!enqueued.ok) return;

    await createSaleSyncEngine({ submit: async () => transportFailure(), now: () => NOW }).run();

    const status = await readOfflineSaleStatus();
    const dueAt = Date.parse(status.nextRetryAt!);
    const server = revokedServer();

    await createSaleSyncEngine({ submit: server.submit, now: () => dueAt + 1_000 }).run();

    const stored = await getQueuedSale(enqueued.value.queueRecordId);

    expect(stored.ok && stored.value.state).toBe("synced");
  });

  it("repeated Sync now presses stay single-flight and create no duplicates", async () => {
    await enqueueSale(input(BEFORE));
    await enqueueSale(input(BEFORE));

    const server = revokedServer();
    const engine = createSaleSyncEngine({ submit: server.submit, now: () => NOW });

    await Promise.all([engine.run(), engine.run(), engine.run(), engine.run()]);

    expect(server.submit).toHaveBeenCalledTimes(2);
    expect(server.orders.size).toBe(2);

    const listing = await listQueuedSales();

    expect(
      listing.ok && new Set(listing.value.sales.map((s) => s.serverOrderNumber)).size
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

describe("what a revoked screen may and may not do", () => {
  it("never offers checkout or a POS, whatever the queue holds", async () => {
    await enqueueSale(input(BEFORE));

    const status = await readOfflineSaleStatus();
    const screen = revokedScreen(status);

    expect(screen.rendersPosRuntime).toBe(false);
    expect(screen.checkoutAvailable).toBe(false);
    // A revoked device is not a runtime mode — no POS is rendered at all.
    expect(getDeviceRuntimeMode({ status: "revoked", pairing: PAIRING })).not.toBe("offline");
  });

  it("an uncertain online sale keeps Reset blocked even with an empty queue", async () => {
    // Revocation must not be a reason to discard the one key that could still
    // identify an order the server may already hold.
    const armed = await armUncertainSale({
      sale: createUncertainSale({
        saleRequestId: "cccccccc-1111-4111-8111-000000000001",
        projectId: PAIRING.projectId,
        paymentMethod: "cash",
        tipAmount: 0,
        items: [{ itemId: "1", quantity: 1, modifiers: [] }],
        fingerprint: "fp",
      }),
      identity: {
        deviceAuthUserId: "22222222-2222-4222-8222-222222222222",
        deviceId: PAIRING.deviceId,
        projectId: PAIRING.projectId,
        buildJobId: PAIRING.buildJobId,
      },
      dispatchedAt: BEFORE,
    });

    expect(armed).toBe(true);

    const status = await readOfflineSaleStatus();

    expect(status.waiting).toBe(0);
    expect(status.uncertainOnlineSale).toBe(true);
    expect(decideDeviceResetSafety(status).allowed).toBe(false);

    // Cleared only by a positive resolution, never by revocation.
    await resolveUncertainSale();

    expect(decideDeviceResetSafety(await readOfflineSaleStatus()).allowed).toBe(true);
  });

  it("records the server already accepted do not block a reset", async () => {
    await enqueueSale(input(BEFORE));

    const server = revokedServer();

    await createSaleSyncEngine({ submit: server.submit, now: () => NOW }).run();

    const status = await readOfflineSaleStatus();

    // Kept for reconciliation, but they are in the books — nothing is owed.
    expect(status.synced).toBe(1);
    expect(status.unsynced).toBe(0);
    expect(decideDeviceResetSafety(status).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Resolving an authoritatively rejected sale
// ---------------------------------------------------------------------------

/**
 * Drives the queue to the exact state the hardware was found in: one revoked
 * till, one sale rung up AFTER revocation, refused by §6c and sitting in
 * needs_attention with nothing able to retry it.
 */
async function strandedRejectedSale() {
  await enqueueSale(input(AFTER));

  const server = revokedServer();

  await createSaleSyncEngine({ submit: server.submit, now: () => NOW }).run();

  return server;
}

describe("a rejected sale can be reviewed", () => {
  it("is offered for review, with a reason a cashier can act on", async () => {
    await strandedRejectedSale();

    const reviews = await listRejectedSaleReviews();

    expect(reviews).toHaveLength(1);
    expect(reviews[0].record.state).toBe("needs_attention");
    expect(reviews[0].record.lastErrorCode).toBe("post_revocation");
    expect(reviews[0].reason).toContain("after this device had already been revoked");
    expect(reviews[0].discard).toEqual({ allowed: true });
  });

  it("shows nothing to review while the sale is still waiting to sync", async () => {
    await enqueueSale(input(BEFORE));

    // Never drained: the row is pending, which is the engine's business.
    expect(await listRejectedSaleReviews()).toHaveLength(0);
  });

  it("the status says needs attention and NOTHING is waiting", async () => {
    await strandedRejectedSale();

    const status = await readOfflineSaleStatus();

    // This pair is what hides Sync now: the button is gated on `waiting`, and
    // a needs_attention row can never be promoted back to pending.
    expect(status.waiting).toBe(0);
    expect(status.needsAttention).toBe(1);
    expect(status.unsynced).toBe(1);
  });

  it("reviewing repeatedly never mutates the evidence", async () => {
    await strandedRejectedSale();

    const before = await getQueuedSale("q-1");

    for (let i = 0; i < 3; i += 1) {
      await listRejectedSaleReviews();
      await readRejectedSaleReview("q-1");
    }

    expect(await getQueuedSale("q-1")).toEqual(before);
    expect((await readOfflineSaleStatus()).unsynced).toBe(1);
  });

  it("degrades to the record alone when no pinned config is cached", async () => {
    await strandedRejectedSale();

    const [review] = await listRejectedSaleReviews();

    // No cache in this fixture, so there is no itemised breakdown — and the
    // sale is still fully reviewable without one.
    expect(review.receipt).toBeNull();
    expect(review.record.occurredAt).toBe(AFTER);
    expect(review.record.paymentMethod).toBe("cash");
  });
});

describe("discarding an authoritatively rejected sale", () => {
  it("clears the deadlock without touching the server", async () => {
    const server = await strandedRejectedSale();
    const callsBefore = server.submit.mock.calls.length;

    expect(decideDeviceResetSafety(await readOfflineSaleStatus()).allowed).toBe(false);

    const discarded = await discardRejectedSale("q-1");

    expect(discarded.ok).toBe(true);

    const status = await readOfflineSaleStatus();

    expect(status.unsynced).toBe(0);
    expect(status.needsAttention).toBe(0);
    expect(decideDeviceResetSafety(status).allowed).toBe(true);

    // NO server call, no order, no invented order number.
    expect(server.submit.mock.calls).toHaveLength(callsBefore);
    expect(server.orders.size).toBe(0);
  });

  it("retains the record rather than deleting it", async () => {
    await strandedRejectedSale();
    await discardRejectedSale("q-1");

    const stored = await getQueuedSale("q-1");

    expect(stored.ok).toBe(true);

    if (stored.ok) {
      expect(stored.value.state).toBe("discarded");
      // Everything that made it evidence is still here.
      expect(stored.value.saleRequestId).toBeTruthy();
      expect(stored.value.occurredAt).toBe(AFTER);
      expect(stored.value.lastErrorCode).toBe("post_revocation");
      expect(stored.value.serverOrderNumber).toBeNull();
    }
  });

  it("is terminal: a later drain never resurrects it as pending", async () => {
    const server = await strandedRejectedSale();

    await discardRejectedSale("q-1");

    // Simulate a relaunch: fresh engine, startup reclaim, full drain.
    resetSyncEngineForTests();
    resetStartupSyncForTests();
    await createSaleSyncEngine({ submit: server.submit, now: () => NOW }).run();

    const stored = await getQueuedSale("q-1");

    expect(stored.ok && stored.value.state).toBe("discarded");
    expect((await readOfflineSaleStatus()).unsynced).toBe(0);
    expect(server.orders.size).toBe(0);
  });

  it("discards ONLY the targeted record", async () => {
    await enqueueSale(input(AFTER)); // q-1, will be refused
    await enqueueSale(input(AFTER)); // q-2, will be refused

    const server = revokedServer();

    await createSaleSyncEngine({ submit: server.submit, now: () => NOW }).run();

    expect((await readOfflineSaleStatus()).needsAttention).toBe(2);

    await discardRejectedSale("q-1");

    const first = await getQueuedSale("q-1");
    const second = await getQueuedSale("q-2");

    expect(first.ok && first.value.state).toBe("discarded");
    expect(second.ok && second.value.state).toBe("needs_attention");
    expect((await readOfflineSaleStatus()).unsynced).toBe(1);
  });

  it("refuses a sale that is still waiting to sync", async () => {
    await enqueueSale(input(BEFORE));

    expect(await discardRejectedSale("q-1")).toEqual({
      ok: false,
      reason: "not_needs_attention",
    });

    const stored = await getQueuedSale("q-1");

    expect(stored.ok && stored.value.state).toBe("pending");
  });

  it("refuses a sale the server accepted", async () => {
    await enqueueSale(input(BEFORE));

    const server = revokedServer();

    await createSaleSyncEngine({ submit: server.submit, now: () => NOW }).run();

    expect(await discardRejectedSale("q-1")).toEqual({
      ok: false,
      reason: "not_needs_attention",
    });
  });

  it("refuses while an outstanding online request cannot be ruled out", async () => {
    await strandedRejectedSale();

    await armUncertainSale({
      sale: createUncertainSale({
        saleRequestId: "99999999-9999-4999-8999-999999999999",
        projectId: PAIRING.projectId,
        paymentMethod: "cash",
        tipAmount: 0,
        items: [{ itemId: "1", quantity: 1, modifiers: [] }],
        fingerprint: "fingerprint-of-a-different-sale",
      }),
      identity: {
        deviceAuthUserId: "22222222-2222-4222-8222-222222222222",
        deviceId: PAIRING.deviceId,
        projectId: PAIRING.projectId,
        buildJobId: PAIRING.buildJobId,
      },
      dispatchedAt: AFTER,
    });

    // A DIFFERENT sale is outstanding, so this one may be resolved — but the
    // reset stays blocked by the uncertain evidence in its own right.
    expect((await discardRejectedSale("q-1")).ok).toBe(true);
    expect(decideDeviceResetSafety(await readOfflineSaleStatus()).allowed).toBe(false);

    await resolveUncertainSale();

    expect(decideDeviceResetSafety(await readOfflineSaleStatus()).allowed).toBe(true);
  });

  it("reports not_found rather than inventing a record", async () => {
    expect(await discardRejectedSale("nope")).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("stale UI state cannot erase durable evidence", () => {
  it("a status object that says 'safe' is overruled by what storage holds", async () => {
    await strandedRejectedSale();

    // What a stale React render might still be holding: an empty status from
    // before the sale was ever taken. On its own it permits a reset.
    const stale = {
      waiting: 0,
      needsAttention: 0,
      synced: 0,
      unsynced: 0,
      total: 0,
      nextRetryAt: null,
      uncertainOnlineSale: false,
    };

    expect(decideDeviceResetSafety(stale).allowed).toBe(true);

    // handleReset does not trust that. It re-reads durable storage first, and
    // THAT is the answer — which is why the affordance in DeviceStatusScreen is
    // only ever an affordance.
    const durable = await readOfflineSaleStatus();

    expect(durable.needsAttention).toBe(1);
    expect(decideDeviceResetSafety(durable).allowed).toBe(false);
  });

  it("reset becomes allowed only after the sale is deliberately resolved", async () => {
    await strandedRejectedSale();

    expect(decideDeviceResetSafety(await readOfflineSaleStatus()).allowed).toBe(false);

    await discardRejectedSale("q-1");

    expect(decideDeviceResetSafety(await readOfflineSaleStatus()).allowed).toBe(true);
  });
});
