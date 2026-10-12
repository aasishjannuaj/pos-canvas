// v1.3 CP-2B item C — who may review a BLOCKED offline sale, what they are
// shown, and what their decision records.
//
// A BLOCKED SALE IS NOT A REJECTED SALE IN GENERAL. It is specifically a queued
// offline sale the server refused because its register attribution could not be
// proven — 'A register session is required for an offline sale'. The money very
// probably crossed the counter; POS Canvas simply will not file it against a
// register it cannot stand behind. That is why this screen exists and why the
// decision has to be attributable to a person.
//
// PURE. No React, no DOM, no IndexedDB, no Supabase, no clock. The caller
// supplies the instant, because a function that reads the clock cannot be tested
// for what it records about time. Every refusal is a returned value; nothing
// here throws.
//
// IT GRANTS NOTHING AND WRITES NOTHING. It decides whether a role is permitted,
// reduces a queue record to the facts a reviewer must see, and builds the
// acknowledgement another layer persists. It cannot discard a sale, cannot
// retry one, cannot reach storage, and has no opinion about registers beyond
// repeating the claim the record already carries.
//
// WHAT IT DELIBERATELY DOES NOT DO, because Control Room forbade each one:
//   - it never reassigns a register, and exposes no field that could carry one;
//   - it never produces a replacement sale id -- `saleRequestId` is copied from
//     the record and is the only identity in the summary;
//   - it never reports a sale as synced, and has no success state at all;
//   - it never deletes anything.

import type { EmployeeRole } from "@/lib/employeeSession";
import { isEmployeeRole } from "@/lib/employeeSession";

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/**
 * The roles permitted to review a blocked sale.
 *
 * OWNER AND MANAGER ONLY, AND THE CASHIER'S EXCLUSION IS THE POINT. The person
 * most likely to be standing at the till when a sale blocks is the one who took
 * the money, and letting them clear their own unreconciled takings is precisely
 * the gap this closes. The roles are the accepted v1.3 set
 * (employees_role_check: owner, manager, cashier); no permission model is
 * invented here and no role is added.
 */
export const BLOCKED_SALE_REVIEW_ROLES: readonly EmployeeRole[] = Object.freeze([
  "owner",
  "manager",
]);

export type BlockedSaleReviewerRefusal =
  | "not_signed_in"
  | "role_not_permitted";

/**
 * The reviewer, as the device already knows them from the signed-in session.
 *
 * NOTHING NEW IS AUTHENTICATED HERE. employee_login_by_code already proved who
 * this is and what role they hold, and lib/employeeSession.ts already carries
 * both. This reads that established identity; it does not verify a PIN, mint a
 * token, or contact anything.
 */
export type BlockedSaleReviewer = {
  employeeId: string;
  displayName: string;
  role: EmployeeRole;
};

export type BlockedSaleReviewerDecision =
  | { allowed: true; reviewer: BlockedSaleReviewer }
  | { allowed: false; refusal: BlockedSaleReviewerRefusal; message: string };

export const BLOCKED_SALE_REVIEW_REFUSALS: Readonly<
  Record<BlockedSaleReviewerRefusal, string>
> = Object.freeze({
  not_signed_in:
    "Sign in before reviewing a sale that could not be recorded.",
  role_not_permitted:
    "Only an owner or a manager can review a sale that could not be recorded.",
});

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * May this person review blocked sales?
 *
 * FAIL CLOSED ON ANYTHING UNREADABLE. A malformed session is not a permitted
 * one: an absent role, an unknown role, a missing employee id and a non-object
 * all refuse. There is no "assume manager" path.
 */
export function decideBlockedSaleReviewer(session: unknown): BlockedSaleReviewerDecision {
  const refuse = (refusal: BlockedSaleReviewerRefusal): BlockedSaleReviewerDecision => ({
    allowed: false,
    refusal,
    message: BLOCKED_SALE_REVIEW_REFUSALS[refusal],
  });

  if (session === null || typeof session !== "object") return refuse("not_signed_in");

  const candidate = session as Record<string, unknown>;

  if (!isNonEmptyString(candidate.employeeId)) return refuse("not_signed_in");
  if (!isNonEmptyString(candidate.displayName)) return refuse("not_signed_in");
  if (!isEmployeeRole(candidate.role)) return refuse("not_signed_in");

  if (!BLOCKED_SALE_REVIEW_ROLES.includes(candidate.role)) {
    return refuse("role_not_permitted");
  }

  return {
    allowed: true,
    reviewer: {
      employeeId: candidate.employeeId,
      displayName: candidate.displayName,
      role: candidate.role,
    },
  };
}

// ---------------------------------------------------------------------------
// What the reviewer is shown
// ---------------------------------------------------------------------------

/**
 * The facts a person needs to decide what to do about one blocked sale.
 *
 * EVERY FIELD IS COPIED, NOT DERIVED. The amount comes from the provisional
 * receipt the device already produced; the register is the CLAIM the record
 * already carries; the identity is the original sale request id. Nothing here
 * is recomputed, and nothing is filled in when it is missing — an absent value
 * is null and the screen says so, because a blank is honest and a guess is not.
 */
export type BlockedSaleSummary = {
  /** The ORIGINAL sale identity. Never replaced, never regenerated. */
  saleRequestId: string;
  /** This device's durable handle on the record. */
  queueRecordId: string;
  /** When the money changed hands, as the device recorded it. */
  occurredAt: string;
  paymentMethod: "cash" | "card";
  /**
   * The sale was RECORDED AS a cash payment.
   *
   * IT IS AN INFERENCE FROM THE PAYMENT METHOD, NOT A VERIFIED COUNT, and the
   * name now says so. The earlier name, cashCollected, read like a confirmed
   * fact about money in a drawer; nothing in this device knows that. What is
   * true is that the cashier selected cash, which is what makes this sale worth
   * a person's attention: a blocked card sale is a bookkeeping problem, while a
   * blocked cash sale probably means takings that POS Canvas has no record of.
   * Whether the money is actually there is the reviewer's job to establish.
   */
  recordedAsCashPayment: boolean;
  /** The provisional total, or null when the device could not produce one. */
  totalFixed: string | null;
  items: readonly { name: string; quantity: number; lineTotal: string | null }[];
  /**
   * The register the till CLAIMED, not one assigned by anything here.
   *
   * Null when the record carries none — which is itself a reason a sale blocks,
   * and must read as "none recorded" rather than being quietly filled in.
   */
  claimedRegisterSessionId: string | null;
  claimedEmployeeSessionId: string | null;
  /** Why the server refused it, in the operator's words. */
  rejectionReason: string;
  /** The classifier's code, for support. Null when the record has none. */
  rejectionCode: string | null;
};

function readItems(receipt: unknown): BlockedSaleSummary["items"] {
  const candidate = receipt as { items?: unknown } | null;

  if (candidate === null || typeof candidate !== "object" || !Array.isArray(candidate.items)) {
    return [];
  }

  return candidate.items.flatMap((raw) => {
    if (raw === null || typeof raw !== "object") return [];

    const item = raw as Record<string, unknown>;
    const name = isNonEmptyString(item.itemName) ? item.itemName : null;
    const quantity = typeof item.quantity === "number" && Number.isSafeInteger(item.quantity)
      ? item.quantity
      : null;

    if (name === null || quantity === null) return [];

    return [{
      name,
      quantity,
      lineTotal: isNonEmptyString(item.lineTotal) ? item.lineTotal : null,
    }];
  });
}

/**
 * Reduces one queued record to what the reviewer sees.
 *
 * TOLERANT OF A DEGRADED RECORD, AND SILENT ABOUT NOTHING. A record written by
 * an older build, or one whose receipt could not be rebuilt, still produces a
 * summary — with nulls where the facts are missing. Refusing to render it would
 * leave an operator with a blocked sale they cannot even look at.
 */
export function summarizeBlockedSale(input: {
  record: unknown;
  receipt: unknown;
  rejectionReason: string;
}): BlockedSaleSummary | null {
  const record = input?.record as Record<string, unknown> | null;

  if (record === null || typeof record !== "object") return null;
  if (!isNonEmptyString(record.saleRequestId)) return null;
  if (!isNonEmptyString(record.queueRecordId)) return null;

  const paymentMethod = record.paymentMethod === "cash" ? "cash" : "card";
  const receipt = input.receipt as Record<string, unknown> | null;

  return {
    saleRequestId: record.saleRequestId,
    queueRecordId: record.queueRecordId,
    occurredAt: isNonEmptyString(record.occurredAt) ? record.occurredAt : "",
    paymentMethod,
    recordedAsCashPayment: paymentMethod === "cash",
    totalFixed:
      receipt !== null && typeof receipt === "object" && isNonEmptyString(receipt.total)
        ? receipt.total
        : null,
    items: readItems(receipt),
    claimedRegisterSessionId: isNonEmptyString(record.registerSessionId)
      ? record.registerSessionId
      : null,
    claimedEmployeeSessionId: isNonEmptyString(record.employeePosSessionId)
      ? record.employeePosSessionId
      : null,
    rejectionReason: isNonEmptyString(input.rejectionReason) ? input.rejectionReason : "",
    rejectionCode: isNonEmptyString(record.lastErrorCode) ? record.lastErrorCode : null,
  };
}

// ---------------------------------------------------------------------------
// The decision the reviewer records
// ---------------------------------------------------------------------------

/**
 * What a reviewer did about a blocked sale.
 *
 * TWO OUTCOMES, AND NEITHER OF THEM IS "FIXED". `acknowledged` means a
 * responsible person has seen it and taken the money into manual
 * reconciliation; `escalated` means they are leaving it for someone else and it
 * must stay on the screen. There is deliberately no outcome meaning the sale
 * was recorded, because this workflow cannot record one.
 */
export type BlockedSaleAction = "acknowledged" | "escalated";

export type BlockedSaleAcknowledgement = {
  action: BlockedSaleAction;
  /** The ORIGINAL sale identity this decision is about. */
  saleRequestId: string;
  byEmployeeId: string;
  byDisplayName: string;
  byRole: EmployeeRole;
  /** Supplied by the caller; this module never reads a clock. */
  atIso: string;
  /** What was claimed at the time, carried into the record so it cannot drift. */
  claimedRegisterSessionId: string | null;
  /** Recorded as cash, not verified as collected. See the summary field. */
  recordedAsCashPayment: boolean;
  note: string | null;
};

export type BlockedSaleAcknowledgementRefusal =
  | "reviewer_not_permitted"
  | "unreadable_sale"
  | "invalid_time"
  | "unknown_action";

export const BLOCKED_SALE_ACK_REFUSALS: Readonly<
  Record<BlockedSaleAcknowledgementRefusal, string>
> = Object.freeze({
  reviewer_not_permitted:
    "Only an owner or a manager can record a decision about this sale.",
  unreadable_sale:
    "This sale could not be read well enough to record a decision about it.",
  invalid_time: "This device could not supply a valid time for the record.",
  unknown_action: "That is not a decision this screen can record.",
});

export type BlockedSaleAcknowledgementResult =
  | { ok: true; acknowledgement: BlockedSaleAcknowledgement }
  | { ok: false; refusal: BlockedSaleAcknowledgementRefusal; message: string };

/**
 * A real instant in canonical form, decided by Date rather than by a pattern.
 *
 * A SHAPE CHECK IS NOT ENOUGH, and the first version of this was one: the
 * regex `\d{4}-\d{2}-\d{2}T...` happily accepts "2026-99-12T09:00:00.000Z",
 * a month that does not exist. Its own test caught that. The round trip asks
 * the platform instead: an unparseable value is NaN, and anything whose
 * canonical spelling differs from what was handed in is a second spelling of an
 * instant, which an audit entry must not carry.
 *
 * Callers produce this with `new Date().toISOString()`, which is exactly the
 * canonical form, so nothing legitimate is refused.
 */
function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) return false;

  return parsed.toISOString() === value;
}

const MAX_NOTE_LENGTH = 500;

/**
 * Builds the durable record of a reviewer's decision.
 *
 * NEVER ANONYMOUS. A decision without an attributable, permitted reviewer is
 * refused rather than recorded as "someone". An audit entry that cannot say who
 * is worse than none, because it looks like accountability and is not.
 *
 * THE TIME IS THE CALLER'S, AND IT IS VALIDATED. A device clock can be wrong,
 * but it cannot be absent or malformed: this is the only timestamp the entry
 * will ever have, and no server will correct it. See the report — a device-set
 * time is a stated limitation of this workflow, not a hidden one.
 */
export function buildBlockedSaleAcknowledgement(input: {
  action: unknown;
  summary: BlockedSaleSummary | null;
  reviewer: BlockedSaleReviewerDecision;
  atIso: unknown;
  note?: unknown;
}): BlockedSaleAcknowledgementResult {
  const refuse = (
    refusal: BlockedSaleAcknowledgementRefusal
  ): BlockedSaleAcknowledgementResult => ({
    ok: false,
    refusal,
    message: BLOCKED_SALE_ACK_REFUSALS[refusal],
  });

  if (input?.reviewer === undefined || input.reviewer === null) {
    return refuse("reviewer_not_permitted");
  }
  if (input.reviewer.allowed !== true) return refuse("reviewer_not_permitted");

  const summary = input.summary;

  if (summary === null || summary === undefined) return refuse("unreadable_sale");
  if (!isNonEmptyString(summary.saleRequestId)) return refuse("unreadable_sale");

  if (input.action !== "acknowledged" && input.action !== "escalated") {
    return refuse("unknown_action");
  }

  if (!isCanonicalInstant(input.atIso)) return refuse("invalid_time");

  const note =
    typeof input.note === "string" && input.note.trim() !== ""
      ? input.note.trim().slice(0, MAX_NOTE_LENGTH)
      : null;

  return {
    ok: true,
    acknowledgement: {
      action: input.action,
      saleRequestId: summary.saleRequestId,
      byEmployeeId: input.reviewer.reviewer.employeeId,
      byDisplayName: input.reviewer.reviewer.displayName,
      byRole: input.reviewer.reviewer.role,
      atIso: input.atIso,
      claimedRegisterSessionId: summary.claimedRegisterSessionId,
      recordedAsCashPayment: summary.recordedAsCashPayment,
      note,
    },
  };
}
