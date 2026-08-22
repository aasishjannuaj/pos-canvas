// Feature 24.5F — resolving a sale the server has AUTHORITATIVELY REFUSED.
//
// THE SITUATION THIS EXISTS FOR. A till was revoked, and afterwards someone rang
// up one more sale on it. The device queued that sale honestly, synced it
// honestly, and complete_sale_v4 refused it just as honestly: its occurred_at
// was at or after the moment the owner revoked the device, so §6c declined to
// record it (docs/OFFLINE_ARCHITECTURE.md §13). No order exists and none ever
// will — the server has already answered this question and will answer it the
// same way every time.
//
// That leaves a record which is not waiting for anything, cannot be retried, and
// which the reset guard correctly refuses to let anyone erase. Without a way to
// resolve it deliberately, the till is bricked: it cannot sync, cannot reset,
// and cannot be re-paired. This module is the deliberate way out.
//
// WHAT IT IS NOT. It is not a delete-sale feature and must never become one.
// Everything below is a narrow allowlist, and the narrowness IS the safety
// property: the only sale a person may resolve locally is one the server has
// definitively refused, that carries no order number, and that no other part of
// the system still considers open. A sale that might have gone through is
// exactly the sale this must never touch.
//
// PURE. No storage, no clock, no network — so the policy can be exhaustively
// tested, and so the UI cannot express a discard the policy has not approved.

import type { QueuedSale } from "@/lib/saleQueue";

/**
 * Rejection codes a person is allowed to resolve on the device.
 *
 * ONE ENTRY, DELIBERATELY. Every other needs_attention code either might be
 * retryable, or means we do not know what the server did — and "we do not know"
 * is the one state where discarding evidence is unforgivable. Adding a code
 * here is a financial decision, not a refactor: it must be an answer the server
 * gives the same way every time, that allocates nothing and records nothing.
 */
export const TERMINAL_LOCAL_RESOLUTION_CODES: readonly string[] = ["post_revocation"];

export function isTerminalLocalResolutionCode(code: string | null): boolean {
  return code !== null && TERMINAL_LOCAL_RESOLUTION_CODES.includes(code);
}

/**
 * What the device knows about an outstanding online request, if anything.
 *
 * `saleRequestId: null` means evidence EXISTS but cannot be attributed — an
 * unreadable record, or one belonging to another pairing. That reads as "this
 * might be about the sale in front of you", and is refused.
 */
export type UncertainSaleEvidence =
  | { present: false }
  | { present: true; saleRequestId: string | null };

export type RejectedSaleDiscardSafety =
  | { allowed: true }
  | { allowed: false; reason: RejectedSaleDiscardRefusal };

export type RejectedSaleDiscardRefusal =
  | "not_needs_attention"
  | "not_terminal_rejection"
  | "server_order_exists"
  | "uncertain_sale_outstanding";

/**
 * The ONE place that decides whether a rejected sale may be resolved locally.
 *
 * Every condition lives here rather than in the screen that offers the button,
 * so there is a single function to read, a single function to test, and no way
 * for a UI change to widen the rule by accident. The session layer re-runs this
 * against freshly read storage immediately before writing — a decision made
 * against a stale React record is not a decision.
 */
export function decideRejectedSaleDiscardSafety(input: {
  record: QueuedSale;
  uncertain: UncertainSaleEvidence;
}): RejectedSaleDiscardSafety {
  const { record, uncertain } = input;

  // pending, syncing, synced, discarded and permanent_failure all fail here.
  // pending and syncing are still the engine's business; synced belongs to the
  // server; permanent_failure is a corruption case this feature has not been
  // designed for and must not quietly inherit.
  if (record.state !== "needs_attention") {
    return { allowed: false, reason: "not_needs_attention" };
  }

  // A transport failure, an unknown outcome, or a server error we have not
  // catalogued can all land in needs_attention. None of them is proof the sale
  // was refused — only the allowlist is.
  if (!isTerminalLocalResolutionCode(record.lastErrorCode)) {
    return { allowed: false, reason: "not_terminal_rejection" };
  }

  // Belt and braces against the state check above: if this record has ever been
  // answered with an order, the server owns the sale and nobody discards it.
  if (record.serverOrderNumber !== null || record.serverOrderId !== null) {
    return { allowed: false, reason: "server_order_exists" };
  }

  // An outstanding online request is a sale that MAY ALREADY BE IN THE BOOKS
  // under an idempotency key this device is the only holder of. If it names
  // this sale — or if we cannot tell whose it is — the evidence stays.
  if (
    uncertain.present &&
    (uncertain.saleRequestId === null || uncertain.saleRequestId === record.saleRequestId)
  ) {
    return { allowed: false, reason: "uncertain_sale_outstanding" };
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Operator-facing copy
// ---------------------------------------------------------------------------

/**
 * Why this sale is unresolved, in words a cashier can act on.
 *
 * NO SERVER JARGON. The person reading this is standing at a counter, not
 * looking at a stack trace: no SQLSTATE, no function name, no "v4", no
 * "post_revocation". They need to know the sale was not recorded and that the
 * money is now their problem to reconcile.
 */
export function describeRejectedSaleReason(lastErrorCode: string | null): string {
  if (lastErrorCode === "post_revocation") {
    return "This sale was created after this device had already been revoked and POS Canvas did not create a server order for it.";
  }

  return "POS Canvas could not record this sale, and it cannot be sent again automatically.";
}

/** Shown above the review, so the state is named before any action is offered. */
export const REJECTED_SALE_STATUS_LABEL = "Needs attention";

export const REJECTED_SALE_REVIEW_TITLE = "Sale needs attention";

/** The only action offered, and never the default one. */
export const DISCARD_REJECTED_SALE_ACTION = "Discard rejected local sale";

export const DISCARD_REJECTED_SALE_CONFIRM_ACTION = "Discard rejected sale";

/**
 * The confirmation, verbatim per the approved wording.
 *
 * IT NAMES THE MONEY. The sale did not happen as far as POS Canvas is
 * concerned, but it may very well have happened as far as the customer and the
 * cash drawer are concerned, and that reconciliation is a human job this screen
 * must not let anyone skip past.
 */
export const DISCARD_REJECTED_SALE_CONFIRMATION_LINES: readonly string[] = [
  "This sale was not recorded by POS Canvas.",
  "Discarding it permanently removes this unresolved local record from this device.",
  "Make sure any cash/card amount collected for this sale has been handled manually.",
  "This cannot be undone.",
];

/** Why a refusal happened, if the policy declines at confirmation time. */
export const DISCARD_REJECTED_SALE_REFUSALS: Readonly<
  Record<RejectedSaleDiscardRefusal, string>
> = {
  not_needs_attention:
    "This sale is no longer waiting for someone to resolve it. Reopen this screen to see its current state.",
  not_terminal_rejection:
    "This sale has not been refused outright, so it may still go through. It cannot be discarded here.",
  server_order_exists:
    "POS Canvas has already recorded this sale, so there is nothing to discard.",
  uncertain_sale_outstanding:
    "Another sale on this device may already have gone through. Connect to the internet and finish that sale first.",
};
