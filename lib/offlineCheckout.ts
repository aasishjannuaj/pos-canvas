// Feature 24.5E — whether this till may take a sale offline, and what exactly
// gets written when it does.
//
// PURE. No IndexedDB, no React, no Supabase, no clock of its own — every input
// is passed in, including the time. lib/offlineCheckoutSession.ts reads the
// storage and calls these; keeping the decisions here is what lets every
// refusal path be exercised under plain Node, including the ones that are
// nearly impossible to produce on a real device.
//
// THE SHAPE OF THE DECISION, and why it is one function rather than a scatter
// of checks at the call site: offline checkout is the moment this product
// writes money with no server in the loop, so the list of things that must be
// true is long, and a list that long must live in exactly one place or it will
// eventually be enforced in only some of them.
//
// NOTHING HERE SUBMITS. complete_sale_v4 is reachable only from
// lib/offlineSaleRpc.ts, called only by the sync engine. An offline checkout
// ends at a durable IndexedDB record; the network comes later, or not at all.
import { decideOfflineFallback } from "@/lib/deviceSession";
import { OFFLINE_BLOCKED_MESSAGES } from "@/lib/deviceSession";
import type { DevicePairing, OfflineBlockedReason } from "@/lib/deviceSession";
import { evaluateLease } from "@/lib/deviceOfflineCache";
import { buildSaleRequestItems } from "@/lib/saleSubmission";
import { createSaleFingerprint, createSaleRequestId } from "@/lib/saleRequest";
import type { CartItem, PaymentMethod } from "@/lib/cart";
import type { GeneratedPosConfig } from "@/lib/generatedPosConfig";
import type { EnqueueSaleInput } from "@/lib/saleQueueSession";
import type { QueuedSale, QueuedSaleItem } from "@/lib/saleQueue";

// ---------------------------------------------------------------------------
// Why a sale may not be taken offline
// ---------------------------------------------------------------------------

/**
 * Every reason offline checkout can be refused.
 *
 * The first six are OfflineBlockedReason verbatim — the same vocabulary the
 * read-only start already refuses in — so a device that could not OPEN from
 * cache and a device that may not SELL from cache speak with one voice. The
 * rest are specific to writing a sale.
 */
export type OfflineCheckoutBlockedReason =
  | OfflineBlockedReason
  | "device_revoked"
  | "queue_unavailable"
  | "empty_cart"
  | "unsupported_payment_method"
  | "insecure_browser";

/**
 * Operator copy for every refusal.
 *
 * Feature 22 rules: say what is true, say what to do, promise nothing, and name
 * no database, no schema and no version. The six inherited entries are reused
 * rather than reworded so the two screens cannot drift apart.
 */
export const OFFLINE_CHECKOUT_BLOCKED_MESSAGES: Record<
  OfflineCheckoutBlockedReason,
  string
> = {
  ...OFFLINE_BLOCKED_MESSAGES,
  device_revoked:
    "This till can no longer take payments. Connect to the internet to check its status.",
  queue_unavailable:
    "This till cannot save a sale on this device right now, so it cannot take payments offline. Connect to the internet to keep selling.",
  empty_cart: "Add at least one item before completing a sale.",
  unsupported_payment_method: "Choose cash or card to complete this sale.",
  insecure_browser:
    "This device cannot complete a secure sale. Connect to the internet, or use a different device.",
};

/**
 * Shown while the till is still deciding whether it may sell offline.
 *
 * A DISTINCT MESSAGE FROM EVERY REFUSAL ABOVE, on purpose: "we have not
 * finished checking" is not a reason a sale was refused, and dressing it up as
 * one would tell an operator something is wrong when nothing is. Checkout is
 * blocked while it shows, because an undecided device must never be treated as
 * an eligible one.
 */
export const OFFLINE_CHECKOUT_PREPARING_MESSAGE =
  "Getting this till ready to take payments offline. Try again in a moment.";

// ---------------------------------------------------------------------------
// The offline session
// ---------------------------------------------------------------------------

/**
 * The validated identity an offline sale is written against.
 *
 * Every field is taken from the CACHED assertion after it has been checked
 * against the running device, never from React state — a queued sale carries
 * its own authorization context so a stale queue cannot be replayed elsewhere
 * (docs/OFFLINE_ARCHITECTURE.md §6).
 */
export type OfflineCheckoutSession = {
  deviceAuthUserId: string;
  deviceId: string;
  projectId: string;
  buildJobId: string;
  /** When the server last vouched for this device. */
  lastVerifiedAt: string;
  /** When the 7-day lease runs out, so a caller can re-check it cheaply. */
  leaseExpiresAt: string;
};

export type OfflineCheckoutEligibility =
  | {
      ok: true;
      session: OfflineCheckoutSession;
      /** The pinned snapshot the sale is priced and receipted from. */
      config: GeneratedPosConfig;
    }
  | { ok: false; reason: OfflineCheckoutBlockedReason };

export type OfflineCheckoutSessionInput = {
  now: number;
  /** The anonymous auth user this browser is currently signed in as. */
  sessionUserId: string;
  /** The pairing the RUNNING app resolved, cached or authoritative. */
  runtime: DevicePairing;
  assertionRecord: unknown;
  configRecord: unknown;
  /** False when the durable queue could not be opened or listed. */
  queueAvailable: boolean;
  leaseMs?: number;
};

/**
 * Decides whether this device may write a sale locally.
 *
 * ASYNC BUT STILL PURE: the only awaited work is the SHA-256 recomputation of
 * the cached configuration, which is the integrity check itself.
 *
 * WHAT IS CHECKED, in order, and why each one is not redundant:
 *
 *   1. local revocation      a pairing this app already knows is withdrawn
 *   2. pairing assertion     exists, parses, belongs to THIS auth user
 *   3. the 7-day lease       against the current clock, refusing a future one
 *   4. the pinned config     parses as a configuration this app understands
 *   5. its integrity digest  recomputed, not trusted
 *   6. cached identity       auth user + project + build, inside the cache
 *   7. runtime identity      the cache describes the device that is RUNNING
 *   8. the durable queue     openable, so "saved" can mean something
 *
 * 2-6 are exactly decideOfflineFallback, reused rather than reimplemented: the
 * bar for SELLING from a cache must never be lower than the bar for OPENING
 * from it, and sharing the function is the only way to guarantee that.
 *
 * 7 is the one check a cached START does not make, because at start there is no
 * running pairing to compare against — the cache supplies it. By checkout time
 * there is one, and a cache describing a different device, project or build
 * than the app is running is a refusal rather than a curiosity.
 */
export async function decideOfflineCheckoutSession(
  input: OfflineCheckoutSessionInput
): Promise<OfflineCheckoutEligibility> {
  // A revocation this device has already been told about. An offline pairing
  // carries a null revokedAt by construction (nothing revoked is cached), so
  // this fires only when an authoritative answer is still in hand.
  if (input.runtime.revokedAt !== null) {
    return { ok: false, reason: "device_revoked" };
  }

  const fallback = await decideOfflineFallback({
    now: input.now,
    sessionUserId: input.sessionUserId,
    assertionRecord: input.assertionRecord,
    configRecord: input.configRecord,
    leaseMs: input.leaseMs,
  });

  if (!fallback.ok) {
    return { ok: false, reason: fallback.reason };
  }

  const cached = fallback.pairing;

  if (
    cached.deviceId !== input.runtime.deviceId ||
    cached.projectId !== input.runtime.projectId ||
    cached.buildJobId !== input.runtime.buildJobId
  ) {
    return { ok: false, reason: "identity_mismatch" };
  }

  // A queue that cannot be opened means a sale cannot be made durable, and a
  // sale that cannot be made durable must not be taken. There is deliberately
  // no memory-only or localStorage path underneath this.
  if (!input.queueAvailable) {
    return { ok: false, reason: "queue_unavailable" };
  }

  return {
    ok: true,
    session: {
      deviceAuthUserId: input.sessionUserId,
      deviceId: cached.deviceId,
      projectId: cached.projectId,
      buildJobId: cached.buildJobId,
      lastVerifiedAt: fallback.offline.lastVerifiedAt,
      leaseExpiresAt: fallback.offline.leaseExpiresAt,
    },
    config: fallback.config,
  };
}

// ---------------------------------------------------------------------------
// The per-sale check
// ---------------------------------------------------------------------------

export type OfflineSaleEligibility =
  | { ok: true }
  | { ok: false; reason: OfflineCheckoutBlockedReason };

/**
 * The checks that depend on THIS sale rather than on the session.
 *
 * The lease is re-evaluated here even though the session already passed one:
 * a till can sit open past midnight on the seventh day, and the moment that
 * matters is the moment money changes hands, not the moment the app started.
 *
 * INVENTORY IS DELIBERATELY ABSENT. An offline sale is never refused because
 * cached stock looks insufficient (docs/OFFLINE_ARCHITECTURE.md §9, owner
 * decision 4): the food is gone and the cash is in the drawer, and destroying a
 * real financial record to protect a stock number is the wrong trade. The
 * server floors tracked stock at zero and records the shortfall at sync.
 */
export function decideOfflineSaleEligibility(input: {
  session: OfflineCheckoutSession;
  cart: readonly CartItem[];
  paymentMethod: PaymentMethod | null;
  now: number;
  leaseMs?: number;
}): OfflineSaleEligibility {
  const lease = evaluateLease(input.session.lastVerifiedAt, input.now, input.leaseMs);

  if (!lease.ok) {
    return {
      ok: false,
      reason: lease.reason === "expired" ? "lease_expired" : "clock_invalid",
    };
  }

  if (input.cart.length === 0) {
    return { ok: false, reason: "empty_cart" };
  }

  // The two labels the server accepts, and the two this product records. POS
  // Canvas authorizes nothing and holds no card data either way (§10).
  if (input.paymentMethod !== "cash" && input.paymentMethod !== "card") {
    return { ok: false, reason: "unsupported_payment_method" };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// The sale's identity, minted once
// ---------------------------------------------------------------------------

/**
 * Everything about a queued sale that must exist BEFORE it is persisted and
 * must never change afterwards.
 *
 * `fingerprint` is what makes "once" survive a retry: a second press of
 * Complete Sale on an unchanged cart resolves to the SAME draft, so a failed
 * enqueue that actually committed cannot become a second sale. Changing the
 * cart changes the fingerprint and correctly mints a new sale.
 */
export type OfflineSaleDraft = {
  saleRequestId: string;
  queueRecordId: string;
  /** ISO — when the customer paid, on this device's clock. */
  occurredAt: string;
  fingerprint: string;
};

export type OfflineSaleDraftResult =
  | { ok: true; draft: OfflineSaleDraft }
  | { ok: false; reason: OfflineCheckoutBlockedReason };

/**
 * Returns the draft to use for this attempt, reusing an unchanged one.
 *
 * THE IDEMPOTENCY KEY AND THE SALE TIME ARE MINTED TOGETHER, exactly once, and
 * before anything is written. Generating occurredAt later — at enqueue, or at
 * submission — would let a retry after a crash record a sale time hours after
 * the customer actually paid, which is the one number the whole two-timestamp
 * design (§6.1) exists to keep honest.
 *
 * createSaleRequestId is the SAME generator the online path uses; it throws
 * rather than falling back to Math.random when crypto.randomUUID is missing,
 * because colliding ids across two tills would cross-wire two receipts.
 */
export function resolveOfflineSaleDraft(input: {
  current: OfflineSaleDraft | null;
  projectId: string;
  paymentMethod: PaymentMethod;
  tipAmount: number;
  cart: readonly CartItem[];
  now: number;
  /** Injected only by tests; production uses createSaleRequestId. */
  generate?: () => string;
}): OfflineSaleDraftResult {
  const fingerprint = createSaleFingerprint({
    projectId: input.projectId,
    paymentMethod: input.paymentMethod,
    tipAmount: input.tipAmount,
    items: input.cart,
  });

  if (input.current !== null && input.current.fingerprint === fingerprint) {
    return { ok: true, draft: input.current };
  }

  const generate = input.generate ?? createSaleRequestId;

  try {
    const saleRequestId = generate();
    // A separate local key, so this device's handle on the row stays distinct
    // from the server's identity for the sale. Both are minted here, in this
    // one place, and neither is ever regenerated.
    const queueRecordId = generate();

    return {
      ok: true,
      draft: {
        saleRequestId,
        queueRecordId,
        occurredAt: new Date(input.now).toISOString(),
        fingerprint,
      },
    };
  } catch {
    return { ok: false, reason: "insecure_browser" };
  }
}

/**
 * Builds the durable record's input.
 *
 * IDENTIFIERS AND QUANTITIES ONLY. buildSaleRequestItems is the same function
 * the online checkout uses to strip a cart down to what may cross the wire, so
 * there is exactly one description of what a sale payload may contain — and no
 * price, name or total can reach the queue even by accident.
 *
 * The authorization context comes from the VALIDATED session, never from the
 * cart or from component props.
 */
export function buildOfflineEnqueueInput(input: {
  draft: OfflineSaleDraft;
  session: OfflineCheckoutSession;
  cart: readonly CartItem[];
  paymentMethod: PaymentMethod;
  now: number;
}): EnqueueSaleInput {
  return {
    saleRequestId: input.draft.saleRequestId,
    queueRecordId: input.draft.queueRecordId,
    deviceAuthUserId: input.session.deviceAuthUserId,
    deviceId: input.session.deviceId,
    projectId: input.session.projectId,
    buildJobId: input.session.buildJobId,
    paymentMethod: input.paymentMethod,
    items: buildSaleRequestItems(input.cart),
    occurredAt: input.draft.occurredAt,
    now: new Date(input.now).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Equivalence
// ---------------------------------------------------------------------------

/**
 * A stable description of one sale's financial content.
 *
 * CANONICAL, matching the shape the server hashes: option ids sorted within a
 * group, groups sorted within a line, lines sorted within the order. Two
 * requests that differ only in the order the cashier happened to tap things are
 * the same request; two that differ in an item, a quantity or an option are not.
 * Duplicate identical lines survive the sort, because two of the same line is
 * genuinely a different order from one.
 */
function canonicalItems(items: readonly QueuedSaleItem[]): string {
  return items
    .map((item) => {
      const groups = item.modifiers
        .map((group) => `${group.groupId}:${[...group.optionIds].sort().join("+")}`)
        .sort()
        .join(";");

      return `${item.itemId}|${item.quantity}|${groups}`;
    })
    .sort()
    .join(",");
}

/**
 * Does a record already on disk represent the SAME sale this attempt is making?
 *
 * WHY THIS EXISTS. The unique index on saleRequestId refuses a second record
 * claiming one sale, and the enqueue path reports that as
 * `duplicate_sale_request`. The tempting reading is "the sale is already
 * saved — report success". That is only true if the stored row is the same
 * financial request. If it is not, the storage engine has just told us that two
 * DIFFERENT sales are claiming one idempotency key, and answering "sale saved"
 * would hand the cashier a receipt for a sale that was never recorded — while
 * complete_sale_v4 would later reject the survivor with a hash conflict.
 *
 * So the key alone is never enough. Every field that identifies the money, the
 * authorization context and the moment is compared, and anything short of an
 * exact match is a conflict rather than a success.
 */
export function isEquivalentOfflineSale(
  record: QueuedSale,
  attempted: EnqueueSaleInput
): boolean {
  return (
    record.saleRequestId === attempted.saleRequestId &&
    record.queueRecordId === attempted.queueRecordId &&
    record.deviceAuthUserId === attempted.deviceAuthUserId &&
    record.deviceId === attempted.deviceId &&
    record.projectId === attempted.projectId &&
    record.buildJobId === attempted.buildJobId &&
    record.paymentMethod === attempted.paymentMethod &&
    // Devices may not tip; both sides are validated to 0, and comparing it
    // anyway means a future tip-bearing surface cannot skip this check.
    record.tipAmount === 0 &&
    record.source === "offline_queued" &&
    record.occurredAt === attempted.occurredAt &&
    canonicalItems(record.items) === canonicalItems(attempted.items)
  );
}
