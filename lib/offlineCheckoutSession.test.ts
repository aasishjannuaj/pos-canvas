// Feature 24.5E — offline checkout against a real IndexedDB engine.
//
// Opts into fake-indexeddb the same way the 24.5A/C/D suites do, so
// vitest.config.ts stays a plain node environment for every other file. The
// shim implements the real specification, so the unique index, transaction
// semantics and durability across a simulated restart are genuinely exercised
// rather than mocked.
//
// THE CENTRAL CLAIM UNDER TEST: a sale is on disk before anything reports
// success, and it stays there — through a failed sync, a restart, and a
// reconciliation that arrives hours later.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  OFFLINE_SALE_CONFLICT_MESSAGE,
  OFFLINE_SALE_STORAGE_FAILURE_MESSAGE,
  completeOfflineSale,
  readOfflineSaleStatus,
  reconstructProvisionalReceipt,
  resolveOfflineCheckoutSession,
} from "@/lib/offlineCheckoutSession";
import { isEquivalentOfflineSale, resolveOfflineSaleDraft } from "@/lib/offlineCheckout";
import type { OfflineCheckoutSession, OfflineSaleDraft } from "@/lib/offlineCheckout";
import { reconcileQueuedSale, toOfflineReference } from "@/lib/provisionalReceipt";
import { decideDeviceResetSafety } from "@/lib/offlineSaleStatus";
import {
  OFFLINE_DEVICE_LEASE_MS,
  buildPairingAssertion,
  buildPinnedConfigRecord,
} from "@/lib/deviceOfflineCache";
import {
  openOfflineDb,
  writePairingAssertionRecord,
  writePinnedConfigRecord,
} from "@/lib/deviceOfflineStore";
import { getQueuedSale, getSaleByRequestId, listQueuedSales } from "@/lib/saleQueueSession";
import { createSaleSyncEngine } from "@/lib/saleSyncEngine";
import type { OfflineSaleSubmission } from "@/lib/offlineSaleRpc";
import { createGeneratedPosConfig } from "@/lib/generatedPosConfig";
import { cloneProjectConfig, defaultProjectConfig } from "@/lib/projectConfig";
import { createCartItem } from "@/lib/cart";
import type { CartItem } from "@/lib/cart";
import type { DevicePairing } from "@/lib/deviceSession";
import type { QueuedSale } from "@/lib/saleQueue";

const USER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BUILD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DEVICE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const VERIFIED_AT = "2026-08-18T09:00:00.000Z";
const SOLD_AT = Date.parse("2026-08-19T14:05:00.000Z");
const REQUEST_OTHER = "7a4b2c9d-1e3f-4a5b-8c6d-9e0f1a2b3c4d";
const SYNCED_AT = Date.parse("2026-08-19T18:40:00.000Z");

const project = cloneProjectConfig(defaultProjectConfig);
const config = createGeneratedPosConfig(
  { projectId: PROJECT, projectName: "Cafe A", templateId: "restaurant", config: project },
  { generatedAt: VERIFIED_AT }
);

const pairing: DevicePairing = {
  deviceId: DEVICE,
  projectId: PROJECT,
  buildJobId: BUILD,
  deviceName: "POS Device",
  platform: "windows",
  createdAt: null,
  revokedAt: null,
};

const session: OfflineCheckoutSession = {
  deviceAuthUserId: USER,
  deviceId: DEVICE,
  projectId: PROJECT,
  buildJobId: BUILD,
  lastVerifiedAt: VERIFIED_AT,
  leaseExpiresAt: new Date(Date.parse(VERIFIED_AT) + OFFLINE_DEVICE_LEASE_MS).toISOString(),
};

let seq = 0;

function generate(): string {
  seq += 1;

  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

function cart(quantity = 2): CartItem[] {
  return [createCartItem(project.menuItems[0], [], quantity)];
}

function draftFor(items: CartItem[] = cart(), now = SOLD_AT): OfflineSaleDraft {
  const drafted = resolveOfflineSaleDraft({
    current: null,
    projectId: PROJECT,
    paymentMethod: "cash",
    tipAmount: 0,
    cart: items,
    now,
    generate,
  });

  if (!drafted.ok) throw new Error("draft failed");

  return drafted.draft;
}


/**
 * A stand-in for the device host's draft discipline, modelled exactly as
 * DeviceApp holds it: minted before the write, kept when the write fails so a
 * retry of the same attempt reuses it, consumed on a durable success, and
 * discarded when the checkout attempt ends.
 *
 * Written as a model rather than asserted only against DeviceApp because the
 * property under test is behavioural — "a later identical cart is a different
 * sale" — while the component's own wiring is a structural one, pinned by
 * lib/offlineCheckout.guards.test.ts.
 */
function offlineHost() {
  let draft: OfflineSaleDraft | null = null;

  return {
    peek: (): OfflineSaleDraft | null => draft,
    /** The cashier left the checkout. Any identity held for a retry is void. */
    endAttempt: (): void => {
      draft = null;
    },
    sell: async (items: CartItem[], paymentMethod: "cash" | "card", now: number) => {
      const drafted = resolveOfflineSaleDraft({
        current: draft,
        projectId: PROJECT,
        paymentMethod,
        tipAmount: 0,
        cart: items,
        now,
        generate,
      });

      if (!drafted.ok) throw new Error(`draft refused: ${drafted.reason}`);

      draft = drafted.draft;

      const outcome = await completeOfflineSale({
        session,
        config,
        draft: drafted.draft,
        cart: items,
        paymentMethod,
        now,
      });

      if (outcome.ok) {
        draft = null;
      }

      return { outcome, draft: drafted.draft };
    },
  };
}

/** Writes the 24.5A cache exactly as a successful authoritative start would. */
async function seedCache(): Promise<void> {
  const opened = await openOfflineDb();

  if (!opened.ok) throw new Error("storage unavailable");

  const record = await buildPinnedConfigRecord({
    deviceAuthUserId: USER,
    projectId: PROJECT,
    buildJobId: BUILD,
    config,
    verifiedAt: VERIFIED_AT,
  });

  await writePinnedConfigRecord(opened.value, record);
  await writePairingAssertionRecord(
    opened.value,
    buildPairingAssertion({
      deviceAuthUserId: USER,
      deviceId: DEVICE,
      projectId: PROJECT,
      buildJobId: BUILD,
      deviceName: "POS Device",
      platform: "windows",
      verifiedAt: VERIFIED_AT,
    })
  );

  opened.value.close();
}

function receiptFor(orderNumber: string): OfflineSaleSubmission {
  return {
    ok: true,
    receipt: {
      orderId: `order-${orderNumber}`,
      orderNumber,
      paymentMethod: "cash",
      subtotal: "12.98",
      taxAmount: "0.82",
      tipAmount: "0.00",
      total: "13.80",
      createdAt: new Date(SYNCED_AT).toISOString(),
      items: [],
    },
  };
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  seq = 0;
  await seedCache();
});

// ---------------------------------------------------------------------------
// Eligibility against real storage
// ---------------------------------------------------------------------------

describe("eligibility is decided from what is actually on disk", () => {
  it("accepts a device whose cache, lease and queue are all sound", async () => {
    const eligibility = await resolveOfflineCheckoutSession({
      now: SOLD_AT,
      sessionUserId: USER,
      pairing,
    });

    expect(eligibility.ok).toBe(true);

    if (!eligibility.ok) return;

    expect(eligibility.session.buildJobId).toBe(BUILD);
    expect(eligibility.config.project.projectId).toBe(PROJECT);
  });

  it("refuses when storage is not available at all", async () => {
    // Private mode, a denied quota, a corrupted profile: the till can still
    // browse, but it must not take a sale it cannot save.
    const saved = globalThis.indexedDB;

    globalThis.indexedDB = undefined as unknown as IDBFactory;

    const eligibility = await resolveOfflineCheckoutSession({
      now: SOLD_AT,
      sessionUserId: USER,
      pairing,
    });

    globalThis.indexedDB = saved;

    expect(eligibility.ok).toBe(false);

    if (eligibility.ok) return;

    expect(eligibility.reason).toBe("storage_unavailable");
  });

  it("does not extend the lease by being read", async () => {
    await resolveOfflineCheckoutSession({ now: SOLD_AT, sessionUserId: USER, pairing });

    const again = await resolveOfflineCheckoutSession({
      // One millisecond past the lease. If the read above had refreshed
      // lastVerifiedAt, this would still pass — and a till kept off the network
      // would renew itself forever.
      now: Date.parse(VERIFIED_AT) + OFFLINE_DEVICE_LEASE_MS + 1,
      sessionUserId: USER,
      pairing,
    });

    expect(again.ok).toBe(false);

    if (again.ok) return;

    expect(again.reason).toBe("lease_expired");
  });
});

// ---------------------------------------------------------------------------
// Durability
// ---------------------------------------------------------------------------

describe("a sale is on disk before anything reports success", () => {
  it("returns ok only once the record can be read back", async () => {
    const draft = draftFor();

    const outcome = await completeOfflineSale({
      session,
      config,
      draft,
      cart: cart(),
      paymentMethod: "cash",
      now: SOLD_AT,
    });

    expect(outcome.ok).toBe(true);

    if (!outcome.ok) return;

    // The claim is not "the promise resolved"; it is "the row is there".
    const stored = await getQueuedSale(draft.queueRecordId);

    expect(stored.ok).toBe(true);

    if (!stored.ok) return;

    expect(stored.value.saleRequestId).toBe(draft.saleRequestId);
    expect(stored.value.occurredAt).toBe(draft.occurredAt);
    expect(stored.value.state).toBe("pending");
    expect(stored.value.source).toBe("offline_queued");
  });

  it("persists ONE request id and ONE sale time, both from the draft", async () => {
    const draft = draftFor();

    await completeOfflineSale({
      session,
      config,
      draft,
      cart: cart(),
      paymentMethod: "cash",
      now: SOLD_AT,
    });

    const listing = await listQueuedSales();

    expect(listing.ok).toBe(true);

    if (!listing.ok) return;

    expect(listing.value.sales).toHaveLength(1);
    expect(listing.value.sales[0].saleRequestId).toBe(draft.saleRequestId);
    expect(listing.value.sales[0].occurredAt).toBe(new Date(SOLD_AT).toISOString());
  });

  it("reports a storage failure instead of a sale when it cannot write", async () => {
    const saved = globalThis.indexedDB;

    globalThis.indexedDB = undefined as unknown as IDBFactory;

    const outcome = await completeOfflineSale({
      session,
      config,
      draft: draftFor(),
      cart: cart(),
      paymentMethod: "cash",
      now: SOLD_AT,
    });

    globalThis.indexedDB = saved;

    expect(outcome.ok).toBe(false);

    if (outcome.ok) return;

    expect(outcome.reason).toBe("storage_write_failed");
    expect(outcome.message).toBe(OFFLINE_SALE_STORAGE_FAILURE_MESSAGE);
    // The operator is told the sale did NOT complete, and that the cart is
    // still there — before they hand anything over.
    expect(outcome.message.toLowerCase()).toContain("has not been completed");
    expect(outcome.message.toLowerCase()).toContain("still in the cart");

    // And nothing was left behind.
    const listing = await listQueuedSales();

    expect(listing.ok && listing.value.sales).toHaveLength(0);
  });

  it("treats a re-submitted identity as the sale it already saved", async () => {
    // The dangerous case: the first write committed and the answer was lost.
    // Reporting failure here is how one sale becomes two.
    const draft = draftFor();

    const first = await completeOfflineSale({
      session,
      config,
      draft,
      cart: cart(),
      paymentMethod: "cash",
      now: SOLD_AT,
    });

    const second = await completeOfflineSale({
      session,
      config,
      draft,
      cart: cart(),
      paymentMethod: "cash",
      now: SOLD_AT + 30_000,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    if (!first.ok || !second.ok) return;

    expect(second.record.queueRecordId).toBe(first.record.queueRecordId);
    expect(second.record.occurredAt).toBe(first.record.occurredAt);

    const listing = await listQueuedSales();

    expect(listing.ok && listing.value.sales).toHaveLength(1);
  });

  it("never refuses a sale for exceeding cached stock", async () => {
    // The cached snapshot says 20 of this item; the cart asks for 500.
    const draft = draftFor(cart(500));

    const outcome = await completeOfflineSale({
      session,
      config,
      draft,
      cart: cart(500),
      paymentMethod: "cash",
      now: SOLD_AT,
    });

    expect(outcome.ok).toBe(true);

    if (!outcome.ok) return;

    expect(outcome.record.items[0].quantity).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Restart
// ---------------------------------------------------------------------------

describe("a queued sale survives a restart", () => {
  it("keeps the record, the reference and the whole receipt", async () => {
    const draft = draftFor();

    const outcome = await completeOfflineSale({
      session,
      config,
      draft,
      cart: cart(),
      paymentMethod: "cash",
      now: SOLD_AT,
    });

    expect(outcome.ok).toBe(true);

    if (!outcome.ok || outcome.receipt === null) throw new Error("no receipt");

    const before = outcome.receipt;

    // A restart, modelled the only way it can be here: forget every in-memory
    // value and go back to the same storage.
    const rebuilt = await reconstructProvisionalReceipt({
      queueRecordId: draft.queueRecordId,
      config,
    });

    expect(rebuilt).not.toBeNull();
    expect(rebuilt).toEqual(before);
    expect(rebuilt?.offlineReference).toBe(toOfflineReference(draft.saleRequestId));
    expect(rebuilt?.occurredAt).toBe(new Date(SOLD_AT).toISOString());
    expect(rebuilt?.total).toBe("13.80");
  });

  it("reports the sale as still waiting, not as recorded", async () => {
    await completeOfflineSale({
      session,
      config,
      draft: draftFor(),
      cart: cart(),
      paymentMethod: "cash",
      now: SOLD_AT,
    });

    const status = await readOfflineSaleStatus();

    expect(status).toEqual({
      waiting: 1,
      needsAttention: 0,
      synced: 0,
      unsynced: 1,
      total: 1,
    });
    expect(decideDeviceResetSafety(status).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sync and reconciliation — the §Q scenario, end to end
// ---------------------------------------------------------------------------

describe("the sale reconciles against the server without losing anything", () => {
  it("keeps Ref ABC, gains ORD1010, and creates exactly one order", async () => {
    // 1. an offline sale completes locally
    const draft = draftFor();
    const outcome = await completeOfflineSale({
      session,
      config,
      draft,
      cart: cart(),
      paymentMethod: "cash",
      now: SOLD_AT,
    });

    expect(outcome.ok).toBe(true);

    if (!outcome.ok || outcome.receipt === null) throw new Error("no receipt");

    // 2. the provisional receipt shows a reference and NO order number
    const reference = outcome.receipt.offlineReference;

    expect(reference).toBe(toOfflineReference(draft.saleRequestId));
    expect(JSON.stringify(outcome.receipt)).not.toContain("ORD");

    // 3. + 4. the app restarts; the record and its reference are unchanged
    const afterRestart = await reconstructProvisionalReceipt({
      queueRecordId: draft.queueRecordId,
      config,
    });

    expect(afterRestart?.offlineReference).toBe(reference);

    // 5. + 6. connectivity returns and the sync succeeds as ORD1010
    const submit = vi.fn(async (record: QueuedSale) => {
      void record;

      return receiptFor("ORD1010");
    });
    const engine = createSaleSyncEngine({ submit, now: () => SYNCED_AT });
    const report = await engine.run();

    expect(report.synced).toBe(1);

    // 10. exactly one submission, carrying the ONE persisted request id
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0].saleRequestId).toBe(draft.saleRequestId);
    expect(submit.mock.calls[0][0].occurredAt).toBe(new Date(SOLD_AT).toISOString());

    const stored = await getQueuedSale(draft.queueRecordId);

    expect(stored.ok).toBe(true);

    if (!stored.ok) return;

    // 7. the reconciliation model now shows both identities
    const reconciled = reconcileQueuedSale(stored.value);

    expect(reconciled?.offlineReference).toBe(reference);
    expect(reconciled?.synced).toBe(true);
    expect(reconciled?.serverOrderNumber).toBe("ORD1010");
    expect(reconciled?.serverOrderId).toBe("order-ORD1010");

    // 8. + 9. both times survive, and the server's is the later one
    expect(reconciled?.occurredAt).toBe(new Date(SOLD_AT).toISOString());
    expect(reconciled?.serverCreatedAt).toBe(new Date(SYNCED_AT).toISOString());
    expect(Date.parse(reconciled!.serverCreatedAt!)).toBeGreaterThan(
      Date.parse(reconciled!.occurredAt)
    );

    // The record is NOT deleted on sync: the operator holding a paper slip
    // needs the reference-to-order mapping to exist somewhere.
    expect(stored.value.state).toBe("synced");
  });

  it("leaves the sale saved and waiting when the immediate sync fails", async () => {
    const draft = draftFor();

    await completeOfflineSale({
      session,
      config,
      draft,
      cart: cart(),
      paymentMethod: "cash",
      now: SOLD_AT,
    });

    const engine = createSaleSyncEngine({
      submit: async () => ({
        ok: false,
        failure: { transport: "transport", message: "Failed to fetch" },
      }),
      now: () => SOLD_AT + 1_000,
    });

    const report = await engine.run();

    expect(report.retrying).toBe(1);

    const stored = await getQueuedSale(draft.queueRecordId);

    expect(stored.ok).toBe(true);

    if (!stored.ok) return;

    // The local sale is untouched by a failed transmission.
    expect(stored.value.state).toBe("pending");
    expect(stored.value.occurredAt).toBe(new Date(SOLD_AT).toISOString());
    expect(stored.value.serverOrderNumber).toBeNull();

    const receipt = await reconstructProvisionalReceipt({
      queueRecordId: draft.queueRecordId,
      config,
    });

    expect(receipt?.offlineReference).toBe(toOfflineReference(draft.saleRequestId));
  });

  it("keeps a post-revocation rejection as evidence, never deleting it", async () => {
    const draft = draftFor();

    await completeOfflineSale({
      session,
      config,
      draft,
      cart: cart(),
      paymentMethod: "cash",
      now: SOLD_AT,
    });

    const engine = createSaleSyncEngine({
      submit: async () => ({
        ok: false,
        failure: {
          transport: "server_rejected",
          message: "Offline sale occurred after this device was revoked",
        },
      }),
      now: () => SYNCED_AT,
    });

    await engine.run();

    const stored = await getQueuedSale(draft.queueRecordId);

    expect(stored.ok).toBe(true);

    if (!stored.ok) return;

    expect(stored.value.state).toBe("needs_attention");
    expect(stored.value.lastErrorCode).toBe("post_revocation");

    // It must never present itself as recorded.
    expect(reconcileQueuedSale(stored.value)?.synced).toBe(false);
    expect(reconcileQueuedSale(stored.value)?.serverOrderNumber).toBeNull();

    const status = await readOfflineSaleStatus();

    expect(status.needsAttention).toBe(1);
    expect(status.synced).toBe(0);
    // And it blocks a reset, because it is exactly the evidence a reset would
    // destroy.
    expect(decideDeviceResetSafety(status).allowed).toBe(false);
  });

  it("allows a reset once every sale has actually reached the server", async () => {
    await completeOfflineSale({
      session,
      config,
      draft: draftFor(),
      cart: cart(),
      paymentMethod: "cash",
      now: SOLD_AT,
    });

    const engine = createSaleSyncEngine({
      submit: async () => receiptFor("ORD1010"),
      now: () => SYNCED_AT,
    });

    await engine.run();

    const status = await readOfflineSaleStatus();

    expect(status.synced).toBe(1);
    expect(status.unsynced).toBe(0);
    expect(decideDeviceResetSafety(status).allowed).toBe(true);

    // The evidence is still on the device, reconciled, not destroyed.
    const listing = await listQueuedSales();

    expect(listing.ok && listing.value.sales).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Ordering across two sales
// ---------------------------------------------------------------------------

describe("two offline sales stay two distinct sales", () => {
  it("gives each its own identity, reference and record", async () => {
    const first = draftFor(cart(1));
    const second = draftFor(cart(3), SOLD_AT + 60_000);

    await completeOfflineSale({
      session,
      config,
      draft: first,
      cart: cart(1),
      paymentMethod: "cash",
      now: SOLD_AT,
    });
    await completeOfflineSale({
      session,
      config,
      draft: second,
      cart: cart(3),
      paymentMethod: "card",
      now: SOLD_AT + 60_000,
    });

    const listing = await listQueuedSales();

    expect(listing.ok).toBe(true);

    if (!listing.ok) return;

    expect(listing.value.sales).toHaveLength(2);
    expect(listing.value.sales[0].queuedAt < listing.value.sales[1].queuedAt).toBe(true);
    expect(
      new Set(listing.value.sales.map((sale) => sale.saleRequestId)).size
    ).toBe(2);
    expect(
      new Set(
        listing.value.sales.map((sale) => toOfflineReference(sale.saleRequestId))
      ).size
    ).toBe(2);

    // And each is addressable by the server identity it will eventually use.
    const byRequest = await getSaleByRequestId(second.saleRequestId);

    expect(byRequest.ok && byRequest.value.paymentMethod).toBe("card");
  });
});

// ---------------------------------------------------------------------------
// Draft lifecycle — the review's central question
// ---------------------------------------------------------------------------

describe("a sale's identity belongs to ONE checkout attempt", () => {
  it("reuses the identity when the SAME attempt retries after a failed write", async () => {
    const host = offlineHost();
    const saved = globalThis.indexedDB;

    globalThis.indexedDB = undefined as unknown as IDBFactory;

    const first = await host.sell(cart(), "cash", SOLD_AT);

    globalThis.indexedDB = saved;

    expect(first.outcome.ok).toBe(false);
    // The failed attempt kept its identity, which is the whole point of keeping
    // it: a retry must not become a second sale.
    expect(host.peek()).toEqual(first.draft);

    const retry = await host.sell(cart(), "cash", SOLD_AT + 20_000);

    expect(retry.outcome.ok).toBe(true);
    expect(retry.draft.saleRequestId).toBe(first.draft.saleRequestId);
    expect(retry.draft.occurredAt).toBe(first.draft.occurredAt);

    const listing = await listQueuedSales();

    expect(listing.ok && listing.value.sales).toHaveLength(1);
  });

  it("consumes the identity the moment the write is durable", async () => {
    const host = offlineHost();

    const first = await host.sell(cart(), "cash", SOLD_AT);

    expect(first.outcome.ok).toBe(true);
    expect(host.peek()).toBeNull();
  });

  it("gives a later IDENTICAL cart a new identity, and both become distinct orders", async () => {
    const host = offlineHost();

    // 1. + 2. cart X, enqueued durably
    const first = await host.sell(cart(), "cash", SOLD_AT);

    expect(first.outcome.ok).toBe(true);

    // 3. the cart clears — modelled by the identity being consumed
    expect(host.peek()).toBeNull();

    // 4. + 5. + 6. an identical cart X, minutes later, is a DIFFERENT sale
    const second = await host.sell(cart(), "cash", SOLD_AT + 300_000);

    expect(second.outcome.ok).toBe(true);
    expect(second.draft.saleRequestId).not.toBe(first.draft.saleRequestId);
    expect(second.draft.queueRecordId).not.toBe(first.draft.queueRecordId);
    expect(Date.parse(second.draft.occurredAt)).toBeGreaterThan(
      Date.parse(first.draft.occurredAt)
    );

    // 7. two distinct records
    const listing = await listQueuedSales();

    expect(listing.ok).toBe(true);

    if (!listing.ok) return;

    expect(listing.value.sales).toHaveLength(2);
    expect(new Set(listing.value.sales.map((sale) => sale.saleRequestId)).size).toBe(2);
    expect(new Set(listing.value.sales.map((sale) => sale.occurredAt)).size).toBe(2);

    // 8. both reach the server as separate orders
    let allocated = 0;
    const submit = vi.fn(async (record: QueuedSale) => {
      void record;
      allocated += 1;

      return receiptFor(`ORD10${allocated}`);
    });
    const engine = createSaleSyncEngine({ submit, now: () => SYNCED_AT });
    const report = await engine.run();

    expect(report.synced).toBe(2);
    expect(submit).toHaveBeenCalledTimes(2);

    const after = await listQueuedSales();

    expect(after.ok).toBe(true);

    if (!after.ok) return;

    const orderNumbers = after.value.sales.map((sale) => sale.serverOrderNumber);

    expect(new Set(orderNumbers).size).toBe(2);
    expect(orderNumbers).not.toContain(null);
  });

  it("discards an ABANDONED identity, so it cannot be inherited later", async () => {
    // The hole this review surfaced: a failed attempt keeps its identity for a
    // retry, and without an end-of-attempt signal that identity would be handed
    // to the next cart that happened to hash the same — recording a new
    // customer's money at an old customer's time.
    const host = offlineHost();
    const saved = globalThis.indexedDB;

    globalThis.indexedDB = undefined as unknown as IDBFactory;

    const failed = await host.sell(cart(), "cash", SOLD_AT);

    globalThis.indexedDB = saved;

    expect(failed.outcome.ok).toBe(false);

    // The cashier cancels the checkout.
    host.endAttempt();

    expect(host.peek()).toBeNull();

    const later = await host.sell(cart(), "cash", SOLD_AT + 600_000);

    expect(later.outcome.ok).toBe(true);
    expect(later.draft.saleRequestId).not.toBe(failed.draft.saleRequestId);
    expect(later.draft.occurredAt).toBe(new Date(SOLD_AT + 600_000).toISOString());
  });

  it("treats a payment-method change before the write as a different sale", async () => {
    const host = offlineHost();
    const saved = globalThis.indexedDB;

    globalThis.indexedDB = undefined as unknown as IDBFactory;

    const asCash = await host.sell(cart(), "cash", SOLD_AT);

    globalThis.indexedDB = saved;

    expect(asCash.outcome.ok).toBe(false);

    // The customer's card works after all. This is not the same request the
    // server would hash, so it must not reuse the same idempotency key.
    const asCard = await host.sell(cart(), "card", SOLD_AT + 15_000);

    expect(asCard.outcome.ok).toBe(true);
    expect(asCard.draft.saleRequestId).not.toBe(asCash.draft.saleRequestId);

    const listing = await listQueuedSales();

    expect(listing.ok && listing.value.sales).toHaveLength(1);
    expect(listing.ok && listing.value.sales[0].paymentMethod).toBe("card");
  });
});

// ---------------------------------------------------------------------------
// Duplicate keys
// ---------------------------------------------------------------------------

describe("a duplicate key is a success only when it is the SAME sale", () => {
  it("returns the stored sale when the request is identical", async () => {
    const draft = draftFor();

    const first = await completeOfflineSale({
      session,
      config,
      draft,
      cart: cart(),
      paymentMethod: "cash",
      now: SOLD_AT,
    });

    const again = await completeOfflineSale({
      session,
      config,
      draft,
      cart: cart(),
      paymentMethod: "cash",
      now: SOLD_AT,
    });

    expect(first.ok).toBe(true);
    expect(again.ok).toBe(true);

    if (!again.ok) return;

    expect(again.record.queueRecordId).toBe(draft.queueRecordId);

    const listing = await listQueuedSales();

    expect(listing.ok && listing.value.sales).toHaveLength(1);
  });

  it("REFUSES when a different sale already holds the key", async () => {
    const draft = draftFor();

    await completeOfflineSale({
      session,
      config,
      draft,
      cart: cart(2),
      paymentMethod: "cash",
      now: SOLD_AT,
    });

    // The same identity, a different order. The unique index rejects the row;
    // saying "sale saved" here would hand over a receipt for a sale that was
    // never stored, and complete_sale_v4 would reject whichever request reached
    // it second as a hash conflict.
    const conflicting = await completeOfflineSale({
      session,
      config,
      draft,
      cart: cart(7),
      paymentMethod: "card",
      now: SOLD_AT,
    });

    expect(conflicting.ok).toBe(false);

    if (conflicting.ok) return;

    expect(conflicting.reason).toBe("conflicting_local_record");
    expect(conflicting.message).toBe(OFFLINE_SALE_CONFLICT_MESSAGE);
    expect(conflicting.message).not.toBe(OFFLINE_SALE_STORAGE_FAILURE_MESSAGE);
    // No receipt is produced on a refusal — the shape has nowhere to put one.
    expect("receipt" in conflicting).toBe(false);

    // The stored sale is untouched, and no second record was created.
    const listing = await listQueuedSales();

    expect(listing.ok).toBe(true);

    if (!listing.ok) return;

    expect(listing.value.sales).toHaveLength(1);
    expect(listing.value.sales[0].items[0].quantity).toBe(2);
    expect(listing.value.sales[0].paymentMethod).toBe("cash");
  });

  it("compares every field that identifies the money and the moment", async () => {
    const draft = draftFor();
    const attempted = {
      saleRequestId: draft.saleRequestId,
      queueRecordId: draft.queueRecordId,
      deviceAuthUserId: USER,
      deviceId: DEVICE,
      projectId: PROJECT,
      buildJobId: BUILD,
      paymentMethod: "cash" as const,
      items: [
        {
          itemId: "1",
          quantity: 2,
          modifiers: [{ groupId: "g", optionIds: ["b", "a"] }],
        },
      ],
      occurredAt: new Date(SOLD_AT).toISOString(),
      now: new Date(SOLD_AT).toISOString(),
    };

    const stored: QueuedSale = {
      queueSchemaVersion: 1,
      requestPayloadVersion: 4,
      queueRecordId: draft.queueRecordId,
      saleRequestId: draft.saleRequestId,
      deviceAuthUserId: USER,
      deviceId: DEVICE,
      projectId: PROJECT,
      buildJobId: BUILD,
      paymentMethod: "cash",
      tipAmount: 0,
      // Option order reversed: the same selection, canonically.
      items: [{ itemId: "1", quantity: 2, modifiers: [{ groupId: "g", optionIds: ["a", "b"] }] }],
      occurredAt: new Date(SOLD_AT).toISOString(),
      source: "offline_queued",
      state: "pending",
      queuedAt: new Date(SOLD_AT).toISOString(),
      updatedAt: new Date(SOLD_AT).toISOString(),
      attemptCount: 0,
      lastAttemptAt: null,
      nextAttemptAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      serverOrderId: null,
      serverOrderNumber: null,
      serverCreatedAt: null,
    };

    // Canonically identical.
    expect(isEquivalentOfflineSale(stored, attempted)).toBe(true);

    // Every field that matters, changed one at a time.
    expect(isEquivalentOfflineSale({ ...stored, paymentMethod: "card" }, attempted)).toBe(false);
    expect(isEquivalentOfflineSale({ ...stored, projectId: BUILD }, attempted)).toBe(false);
    expect(isEquivalentOfflineSale({ ...stored, buildJobId: PROJECT }, attempted)).toBe(false);
    expect(isEquivalentOfflineSale({ ...stored, deviceId: USER }, attempted)).toBe(false);
    expect(isEquivalentOfflineSale({ ...stored, deviceAuthUserId: DEVICE }, attempted)).toBe(false);
    expect(
      isEquivalentOfflineSale({ ...stored, occurredAt: new Date(SOLD_AT + 1000).toISOString() }, attempted)
    ).toBe(false);
    expect(
      isEquivalentOfflineSale(
        { ...stored, items: [{ itemId: "1", quantity: 3, modifiers: [{ groupId: "g", optionIds: ["a", "b"] }] }] },
        attempted
      )
    ).toBe(false);
    expect(
      isEquivalentOfflineSale(
        { ...stored, items: [{ itemId: "2", quantity: 2, modifiers: [{ groupId: "g", optionIds: ["a", "b"] }] }] },
        attempted
      )
    ).toBe(false);
    expect(
      isEquivalentOfflineSale(
        { ...stored, items: [{ itemId: "1", quantity: 2, modifiers: [{ groupId: "g", optionIds: ["a"] }] }] },
        attempted
      )
    ).toBe(false);
    expect(isEquivalentOfflineSale({ ...stored, saleRequestId: REQUEST_OTHER }, attempted)).toBe(false);
  });
});
