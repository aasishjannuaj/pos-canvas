// Feature 24.5E — offline checkout's public API: storage I/O plus the pure
// rules, joined.
//
// Thin by design, exactly like lib/deviceOfflineSession.ts and
// lib/saleQueueSession.ts. Every decision lives in lib/offlineCheckout.ts, every
// byte of receipt rendering in lib/provisionalReceipt.ts, and every write in
// the 24.5C queue API. This module owns the glue and nothing else, so there is
// no third place for a rule about money to hide.
//
// THE ONE PROMISE THIS MODULE MAKES: when completeOfflineSale resolves `ok`,
// the sale is on disk. Not "queued in memory", not "scheduled to be written" —
// the IndexedDB transaction that holds it has committed. Everything the UI does
// afterwards (clear the cart, print, say "saved") depends on that being true,
// so it is the only thing this function is allowed to be optimistic about, and
// it is not optimistic about it at all.
//
// NOTHING HERE SUBMITS ANYTHING. complete_sale_v4 is reachable only from
// lib/offlineSaleRpc.ts, and only the sync engine calls that.
import {
  buildOfflineEnqueueInput,
  decideOfflineCheckoutSession,
  isEquivalentOfflineSale,
  OFFLINE_CHECKOUT_BLOCKED_MESSAGES,
} from "@/lib/offlineCheckout";
import type {
  OfflineCheckoutBlockedReason,
  OfflineCheckoutEligibility,
  OfflineCheckoutSession,
  OfflineSaleDraft,
} from "@/lib/offlineCheckout";
import { buildProvisionalReceipt } from "@/lib/provisionalReceipt";
import type { ProvisionalReceipt } from "@/lib/provisionalReceipt";
import {
  enqueueSale,
  getQueuedSale,
  getSaleByRequestId,
  listQueuedSales,
} from "@/lib/saleQueueSession";
import { summarizeQueue } from "@/lib/saleQueue";
import type { QueuedSale } from "@/lib/saleQueue";
import { earliestRetryAt, toOfflineSaleStatus } from "@/lib/offlineSaleStatus";
import { hasUncertainSaleEvidence } from "@/lib/uncertainSaleSession";
import type { OfflineSaleStatus } from "@/lib/offlineSaleStatus";
import {
  openOfflineDb,
  readPairingAssertionRecord,
  readPinnedConfigRecord,
} from "@/lib/deviceOfflineStore";
import type { CartItem, PaymentMethod } from "@/lib/cart";
import type { DevicePairing } from "@/lib/deviceSession";
import type { GeneratedPosConfig } from "@/lib/generatedPosConfig";

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/**
 * Reads what is on disk and asks lib/offlineCheckout.ts whether this till may
 * sell.
 *
 * RE-READS EVERYTHING, every time it is called. It does not trust the records
 * the app started from: the configuration's integrity digest is recomputed, the
 * lease is re-evaluated against the current clock, and the durable queue is
 * probed by actually listing it. Caching this answer for the life of the
 * session would mean a device that lost its storage mid-shift kept believing it
 * could save a sale.
 *
 * Reading NEVER writes. In particular it does not touch `lastVerifiedAt`: a
 * till kept off the network must not renew its own lease by taking sales.
 */
export async function resolveOfflineCheckoutSession(input: {
  now: number;
  sessionUserId: string;
  pairing: DevicePairing;
  leaseMs?: number;
}): Promise<OfflineCheckoutEligibility> {
  const opened = await openOfflineDb();

  if (!opened.ok) {
    return { ok: false, reason: "storage_unavailable" };
  }

  const db = opened.value;
  let assertionRecord: unknown = null;
  let configRecord: unknown = null;

  try {
    const assertion = await readPairingAssertionRecord(db);
    const config = await readPinnedConfigRecord(db);

    if (!assertion.ok || !config.ok) {
      return { ok: false, reason: "storage_unavailable" };
    }

    assertionRecord = assertion.value;
    configRecord = config.value;
  } finally {
    db.close();
  }

  // THE QUEUE PROBE IS A REAL LISTING, not a "does the database open" check.
  // Opening proves the schema exists; listing proves this device can actually
  // read the sales it already holds, which is what a duplicate check at enqueue
  // time depends on.
  //
  // Note what does NOT block a sale: individual records that failed to parse.
  // Those are surfaced as "needs attention" and are never deleted, but refusing
  // to trade because a row from three days ago is unreadable would punish the
  // shop for a fault it cannot fix at the counter.
  const listing = await listQueuedSales();

  return decideOfflineCheckoutSession({
    now: input.now,
    sessionUserId: input.sessionUserId,
    runtime: input.pairing,
    assertionRecord,
    configRecord,
    queueAvailable: listing.ok,
    leaseMs: input.leaseMs,
  });
}

// ---------------------------------------------------------------------------
// Completing a sale
// ---------------------------------------------------------------------------

export type OfflineSaleFailureReason =
  | OfflineCheckoutBlockedReason
  | "storage_write_failed"
  /**
   * A record already on disk claims this sale's idempotency key but is NOT this
   * sale. Never reported as success — see completeOfflineSale.
   */
  | "conflicting_local_record";

export type OfflineSaleOutcome =
  | {
      ok: true;
      record: QueuedSale;
      /**
       * The paper copy. Null ONLY when the durable record cannot be rendered —
       * the sale is still saved, and a missing receipt must never be reported
       * as a failed sale.
       */
      receipt: ProvisionalReceipt | null;
    }
  | { ok: false; reason: OfflineSaleFailureReason; message: string };

/**
 * The message shown when a sale could not be made durable.
 *
 * BLOCKING AND UNAMBIGUOUS, per docs/OFFLINE_ARCHITECTURE.md §18 case 15: the
 * operator must learn the sale cannot be saved BEFORE they hand over the order.
 * It says the sale did not complete, and it says the cart is still there —
 * which is the fact that lets the cashier retry rather than guess.
 */
export const OFFLINE_SALE_STORAGE_FAILURE_MESSAGE =
  "This sale could not be saved on this device, so it has not been completed. The items are still in the cart — try again, or connect to the internet to take payment.";

/**
 * The message shown when a different sale already holds this one's identity.
 *
 * A DISTINCT MESSAGE FROM THE ONE ABOVE, because it is a distinct situation and
 * a distinct instruction: retrying cannot help, and the operator needs someone
 * to look at the till rather than to press the button again. It still says the
 * sale did not complete and the items are still there, which are the two facts
 * that stop food leaving the counter.
 */
export const OFFLINE_SALE_CONFLICT_MESSAGE =
  "This sale could not be saved on this device, so it has not been completed. The items are still in the cart. Ask the account owner to check this till before taking more payments on it.";

/**
 * Persists one offline sale and builds its provisional receipt.
 *
 * THE ORDER IS THE FEATURE:
 *
 *   1. build the record from the validated session and the frozen draft
 *   2. await enqueueSale — an IndexedDB transaction that either commits or not
 *   3. only then produce a receipt
 *
 * There is no step that returns success before 2 resolves, and no in-memory or
 * localStorage fallback underneath it. A caller that clears its cart on `ok` is
 * therefore clearing it against a committed transaction.
 *
 * A DUPLICATE IS A SUCCESS, not an error. The unique index on saleRequestId
 * refuses a second record for one sale; reaching it means this exact sale is
 * already on disk — usually because a previous attempt committed and then
 * failed to report back. Returning the stored record is the truthful answer,
 * and the alternative (telling the cashier it failed) is how one sale becomes
 * two.
 */
export async function completeOfflineSale(input: {
  session: OfflineCheckoutSession;
  config: GeneratedPosConfig;
  draft: OfflineSaleDraft;
  cart: readonly CartItem[];
  paymentMethod: PaymentMethod;
  now: number;
}): Promise<OfflineSaleOutcome> {
  const attempted = buildOfflineEnqueueInput({
    draft: input.draft,
    session: input.session,
    cart: input.cart,
    paymentMethod: input.paymentMethod,
    now: input.now,
  });

  const enqueued = await enqueueSale(attempted);

  if (enqueued.ok) {
    return { ok: true, record: enqueued.value, receipt: toReceipt(enqueued.value, input.config) };
  }

  if (enqueued.reason === "duplicate_sale_request") {
    const existing = await getSaleByRequestId(input.draft.saleRequestId);

    // THE KEY ALONE IS NOT ENOUGH. "Something already holds this id" and "this
    // sale is already saved" are different statements, and only the second one
    // justifies telling a cashier the sale is done. The stored record is
    // compared field by field, canonically, before that claim is made.
    if (existing.ok && isEquivalentOfflineSale(existing.value, attempted)) {
      return { ok: true, record: existing.value, receipt: toReceipt(existing.value, input.config) };
    }

    if (existing.ok) {
      // A DIFFERENT sale holds this key. Retrying cannot resolve it — the same
      // key would collide again — and complete_sale_v4 would reject whichever
      // one reached it second as a hash conflict. Refuse loudly, keep both
      // records, and keep the cart.
      return {
        ok: false,
        reason: "conflicting_local_record",
        message: OFFLINE_SALE_CONFLICT_MESSAGE,
      };
    }
  }

  return {
    ok: false,
    reason: "storage_write_failed",
    message: OFFLINE_SALE_STORAGE_FAILURE_MESSAGE,
  };
}

function toReceipt(
  record: QueuedSale,
  config: GeneratedPosConfig
): ProvisionalReceipt | null {
  const built = buildProvisionalReceipt({ record, config });

  return built.ok ? built.receipt : null;
}

/**
 * Rebuilds a provisional receipt from durable storage.
 *
 * This is the reload path: after a restart there is no cart and no React state,
 * only the record and the pinned configuration — which is exactly what
 * buildProvisionalReceipt takes, so the reprinted receipt is produced by the
 * same function that produced the original and carries the same reference.
 */
export async function reconstructProvisionalReceipt(input: {
  queueRecordId: string;
  config: GeneratedPosConfig;
}): Promise<ProvisionalReceipt | null> {
  const stored = await getQueuedSale(input.queueRecordId);

  return stored.ok ? toReceipt(stored.value, input.config) : null;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * What the cashier is told, and what governs whether this device may be reset.
 *
 * An unreadable queue reports zero rather than throwing: the status strip is an
 * indicator, and a till whose storage has failed has bigger problems than a
 * missing count — the checkout eligibility check refuses the sale in that case,
 * which is where that failure belongs.
 */
export async function readOfflineSaleStatus(): Promise<OfflineSaleStatus> {
  const listing = await listQueuedSales();

  if (!listing.ok) {
    return {
      waiting: 0,
      needsAttention: 0,
      synced: 0,
      unsynced: 0,
      total: 0,
      nextRetryAt: null,
      uncertainOnlineSale: await hasUncertainSaleEvidence(),
    };
  }

  return toOfflineSaleStatus(
    summarizeQueue(listing.value.sales),
    listing.value.quarantined.length,
    // Feature 24.5F (DEF-02) — read from the SAME listing, so the count a
    // cashier sees and the retry a host schedules can never describe two
    // different queues.
    earliestRetryAt(listing.value.sales),
    // Feature 24.5F — evidence, not a queue row. Read alongside so the reset
    // gate and the cashier's counts describe one consistent moment.
    await hasUncertainSaleEvidence()
  );
}

/** The operator-facing reason a blocked offline checkout gives. */
export function describeOfflineCheckoutBlock(reason: OfflineCheckoutBlockedReason): string {
  return OFFLINE_CHECKOUT_BLOCKED_MESSAGES[reason];
}
