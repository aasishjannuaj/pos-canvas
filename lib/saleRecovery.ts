// G-1-CLIENT-1 — recovering an uncertain sale WITHOUT changing who rang it.
//
// PURE. No IndexedDB, no React, no Supabase. lib/saleRecoveryRpc.ts moves the
// bytes to the server, lib/saleRecoverySession.ts joins storage and the network,
// and this module owns every rule they apply — so every rule runs under Node.
//
// WHAT IT DECIDES:
//   * what an answer from get_device_sale_by_request_id or
//     complete_sale_recovery_v1 actually says, validated field by field — a
//     reply that does not match the accepted server contract is MALFORMED and
//     protects nothing away;
//   * what to do with an outstanding uncertain sale, given that answer;
//   * whether a queue record is a VERIFIED transfer of a marker's protection,
//     which is the only thing that lets the marker go.
//
// THE RULES IT NEVER BREAKS:
//   1. One sale, one id. Nothing here mints an id; every path reuses the
//      marker's original saleRequestId.
//   2. "not_found" is not proof of absence. An earlier request under the same
//      id may still commit, so it never clears a marker; it only decides HOW the
//      sale is completed under its original id.
//   3. Attribution comes from the marker's originals and nowhere else. The
//      currently signed-in employee decides only whether the ONLINE recovery
//      path is available (the server requires the same employee there); it is
//      never written into a claim.
//   4. complete_sale_v5 is never a fallback. A missing, failing or malformed
//      recovery function leaves the sale protected.
import { canonicalLineIdentity } from "@/lib/modifiers";
import { isCompletedSaleReceipt, isFixedDecimalString } from "@/lib/completedSale";
import type { CompletedSaleReceipt } from "@/lib/completedSale";
import { parseIsoTime } from "@/lib/deviceOfflineCache";
import { isStrictRecoverySale } from "@/lib/saleQueue";
import type { QueuedSale, StrictRecoveryClaims } from "@/lib/saleQueue";
import type { PersistedUncertainSale } from "@/lib/uncertainSaleRecord";

// ---------------------------------------------------------------------------
// The lookup answer
// ---------------------------------------------------------------------------

export type LookupAttribution = "verified" | "conflict" | "unverified" | "claims_unverifiable";

/**
 * The order summary get_device_sale_by_request_id returns on a match.
 *
 * EXACTLY these fields, because that is all the server sends. It is NOT a
 * receipt: there are no lines, no subtotal and no tax here, and nothing in this
 * client may present it as one or fill the gaps in.
 */
export type LookupOrderSummary = {
  orderId: string;
  orderNumber: string;
  total: string;
  paymentMethod: "cash" | "card";
  createdAt: string;
  occurredAt: string | null;
  source: string;
  employeeId: string | null;
  registerSessionId: string | null;
};

export type SaleLookupAnswer =
  | { status: "not_found" }
  | { status: "not_this_device" }
  | { status: "payload_mismatch" }
  | { status: "match"; attribution: LookupAttribution; order: LookupOrderSummary }
  | { status: "malformed" };

const LOOKUP_ATTRIBUTIONS: readonly LookupAttribution[] = [
  "verified",
  "conflict",
  "unverified",
  "claims_unverifiable",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function nullableNonEmptyString(value: unknown): string | null | "invalid" {
  if (value === null) return null;

  return nonEmptyString(value) ?? "invalid";
}

/** An answer whose ONLY key is `status`, with exactly this value. */
function isBareStatus(raw: Record<string, unknown>, status: string): boolean {
  const keys = Object.keys(raw);

  return raw.status === status && keys.length === 1;
}

/**
 * Validates a get_device_sale_by_request_id answer against the accepted
 * contract (20261015120000_sale_recovery_attribution.sql §2).
 *
 * A "not_this_device" or "payload_mismatch" carrying ANY extra key is
 * malformed: the server is contracted to disclose nothing else about another
 * till's order, and a client that tolerated more would be the first place a
 * leak went unnoticed.
 */
export function parseSaleLookupAnswer(value: unknown): SaleLookupAnswer {
  if (!isRecord(value)) return { status: "malformed" };

  if (isBareStatus(value, "not_found")) return { status: "not_found" };
  if (isBareStatus(value, "not_this_device")) return { status: "not_this_device" };
  if (isBareStatus(value, "payload_mismatch")) return { status: "payload_mismatch" };

  if (value.status !== "match") return { status: "malformed" };

  const attribution = value.attribution;

  if (
    typeof attribution !== "string" ||
    !(LOOKUP_ATTRIBUTIONS as readonly string[]).includes(attribution) ||
    !isRecord(value.order)
  ) {
    return { status: "malformed" };
  }

  const order = value.order;
  const orderId = nonEmptyString(order.orderId);
  const orderNumber = nonEmptyString(order.orderNumber);
  const source = nonEmptyString(order.source);
  const createdAt =
    typeof order.createdAt === "string" && parseIsoTime(order.createdAt) !== null
      ? order.createdAt
      : null;
  const occurredAt =
    order.occurredAt === null
      ? null
      : typeof order.occurredAt === "string" && parseIsoTime(order.occurredAt) !== null
        ? order.occurredAt
        : "invalid";
  const employeeId = nullableNonEmptyString(order.employeeId);
  const registerSessionId = nullableNonEmptyString(order.registerSessionId);

  if (
    orderId === null ||
    orderNumber === null ||
    source === null ||
    createdAt === null ||
    occurredAt === "invalid" ||
    employeeId === "invalid" ||
    registerSessionId === "invalid" ||
    !isFixedDecimalString(order.total) ||
    (order.paymentMethod !== "cash" && order.paymentMethod !== "card")
  ) {
    return { status: "malformed" };
  }

  return {
    status: "match",
    attribution: attribution as LookupAttribution,
    order: {
      orderId,
      orderNumber,
      total: order.total,
      paymentMethod: order.paymentMethod,
      createdAt,
      occurredAt,
      source,
      employeeId,
      registerSessionId,
    },
  };
}

// ---------------------------------------------------------------------------
// The strict-recovery answer
// ---------------------------------------------------------------------------

export type SaleRecoveryAnswer =
  | { status: "created" | "replayed"; receipt: CompletedSaleReceipt }
  | { status: "attribution_conflict"; orderId: string; orderNumber: string }
  | { status: "not_this_device" }
  | { status: "malformed" };

/**
 * Validates a complete_sale_recovery_v1 answer (the same migration, §3).
 *
 * created / replayed are successes ONLY when they carry a receipt the existing
 * receipt validator accepts — the same bar every other sale path holds. An
 * attribution conflict is reported with the order's identity and nothing is
 * ever treated as recorded from it.
 */
export function parseSaleRecoveryAnswer(value: unknown): SaleRecoveryAnswer {
  if (!isRecord(value)) return { status: "malformed" };

  if (isBareStatus(value, "not_this_device")) return { status: "not_this_device" };

  if (value.status === "created" || value.status === "replayed") {
    return isCompletedSaleReceipt(value.receipt)
      ? { status: value.status, receipt: value.receipt }
      : { status: "malformed" };
  }

  if (value.status === "attribution_conflict") {
    const orderId = nonEmptyString(value.orderId);
    const orderNumber = nonEmptyString(value.orderNumber);

    if (orderId === null || orderNumber === null) return { status: "malformed" };

    return { status: "attribution_conflict", orderId, orderNumber };
  }

  return { status: "malformed" };
}

/**
 * Is this PostgREST error "the function does not exist"?
 *
 * PGRST202 is PostgREST's own code for a function missing from its schema
 * cache — what a device sees before the server migration is applied, or after
 * it is rolled back. It is reported as its own outcome so the operator is told
 * the truth, and so nothing anywhere mistakes it for permission to fall back.
 */
export function isMissingRecoveryFunction(error: unknown): boolean {
  return isRecord(error) && error.code === "PGRST202";
}

// ---------------------------------------------------------------------------
// The decision table
// ---------------------------------------------------------------------------

/** Who is signed in and which register is open, right now. Routing only. */
export type CurrentOperator = {
  employeeId: string;
  employeePosSessionId: string;
  registerSessionId: string;
};

/** Why a sale stays protected. Each has its own operator sentence. */
export type ProtectedReason =
  | "legacy_unresolvable"
  | "attribution_conflict"
  | "claims_unverifiable"
  | "not_this_device"
  | "payload_mismatch"
  | "malformed_response"
  | "recovery_unavailable"
  | "server_rejected"
  | "unknown_outcome"
  | "connection_lost"
  | "transfer_failed"
  | "transfer_conflict";

export type RecoveryStep =
  /** The order exists for this device and payload: the marker may go. */
  | { step: "resolve_recorded"; order: LookupOrderSummary }
  /** Create or replay online, under the original attribution. */
  | { step: "online_strict" }
  /** Transfer into a strict-recovery queue record, under the originals. */
  | { step: "queue_strict" }
  /** Nothing may be done with the evidence available. */
  | { step: "protected"; reason: ProtectedReason };

/**
 * May an outstanding marker be routed WITHOUT asking the server first?
 *
 * Only offline, and only to the strict queue: a queued strict record carries
 * the originals and the server decides whether it can prove them. A legacy
 * marker has nothing to queue a strict record with, and must never be queued
 * under whoever is signed in now — it stays protected until a lookup can answer.
 */
export function decideOfflineRecovery(marker: PersistedUncertainSale): RecoveryStep {
  return marker.originalAttribution === null
    ? { step: "protected", reason: "legacy_unresolvable" }
    : { step: "queue_strict" };
}

/**
 * What to do with an outstanding marker after the server's lookup answered.
 *
 * LEGACY CLEARANCE — THE EXACT EVIDENCE REQUIRED. A marker with no original
 * attribution is released ONLY on `status: "match"`, which the server returns
 * only when ALL of these hold for the order stored under this sale request id:
 *   (a) it belongs to the calling device's own project (lookup scope),
 *   (b) its paired_device_id IS the calling device (not_this_device otherwise,
 *       including an order with no device at all),
 *   (c) its canonical sale hash equals the hash of the marker's own payment
 *       method, tip and items (payload_mismatch otherwise),
 * and the reply validates field by field (malformed otherwise). Together these
 * prove that the very sale this marker protects is recorded on the server, on
 * this till, exactly once — so no later request under this id can create a
 * second order, and the marker has nothing left to protect. The attribution
 * stays whatever the server stored; nothing here can or does change it, and no
 * receipt is invented from the summary. ANY other answer keeps it protected.
 *
 * For a marker WITH original attribution the same match must also report
 * attribution "verified"; a conflict or unverifiable claims stays protected.
 */
export function decideAfterLookup(
  marker: PersistedUncertainSale,
  answer: SaleLookupAnswer,
  current: CurrentOperator | null
): RecoveryStep {
  switch (answer.status) {
    case "malformed":
      return { step: "protected", reason: "malformed_response" };
    case "not_this_device":
      return { step: "protected", reason: "not_this_device" };
    case "payload_mismatch":
      return { step: "protected", reason: "payload_mismatch" };
    case "match": {
      if (answer.order.paymentMethod !== marker.paymentMethod) {
        return { step: "protected", reason: "malformed_response" };
      }

      if (marker.originalAttribution === null) {
        // Claims were never sent, so the only honest server answer is
        // "unverified". Anything else is not the contract.
        return answer.attribution === "unverified"
          ? { step: "resolve_recorded", order: answer.order }
          : { step: "protected", reason: "malformed_response" };
      }

      if (answer.attribution === "verified") {
        return { step: "resolve_recorded", order: answer.order };
      }

      if (answer.attribution === "conflict") {
        return { step: "protected", reason: "attribution_conflict" };
      }

      if (answer.attribution === "claims_unverifiable") {
        return { step: "protected", reason: "claims_unverifiable" };
      }

      // "unverified" in reply to claims that WERE sent is not the contract.
      return { step: "protected", reason: "malformed_response" };
    }
    case "not_found": {
      const original = marker.originalAttribution;

      if (original === null) {
        // NOT PROOF OF ABSENCE, and there is no original attribution to
        // complete it under. Protected until a lookup can find it.
        return { step: "protected", reason: "legacy_unresolvable" };
      }

      // The server creates online ONLY for the original employee, and v5's
      // online path requires the original register to be the one still open.
      // Anyone else — a different employee, a rolled-over register, nobody —
      // completes it through the historical-claim path instead, under the very
      // same originals. Never under the current operator.
      if (
        current !== null &&
        current.employeeId === original.employeeId &&
        current.registerSessionId === original.registerSessionId
      ) {
        return { step: "online_strict" };
      }

      return { step: "queue_strict" };
    }
  }
}

// ---------------------------------------------------------------------------
// Queue transfer
// ---------------------------------------------------------------------------

/** The strict claims a marker's protection transfers under, if it has any. */
export function strictClaimsFromMarker(marker: PersistedUncertainSale): StrictRecoveryClaims | null {
  const original = marker.originalAttribution;

  if (original === null) return null;

  return {
    originalEmployeeId: original.employeeId,
    originalEmployeePosSessionId: original.employeePosSessionId,
    originalRegisterSessionId: original.registerSessionId,
    originalAttemptAt: original.attemptedAt,
  };
}

function canonicalItems(
  items: readonly { itemId: string; quantity: number; modifiers: { groupId: string; optionIds: string[] }[] }[]
): string {
  return items
    .map((item) => `${canonicalLineIdentity(item.itemId, item.modifiers)}=${item.quantity}`)
    .sort()
    .join("\u001e");
}

export type TransferVerification =
  | { ok: true }
  | {
      ok: false;
      reason: "different_sale" | "different_pairing" | "not_strict" | "different_originals";
    };

/**
 * Does this queue record carry the marker's protection?
 *
 * The ONLY test that lets a marker go after a transfer (and at startup, after a
 * crash between the two writes). Matched on the exact key, the pairing and the
 * complete financial content; and, for a marker with original attribution, on
 * a strict record bound to those very originals. A record that merely holds the
 * same key — written by an older build, or under different claims — does not
 * qualify: it would sync under something the marker never authorised.
 */
export function verifyQueueTransfer(
  marker: PersistedUncertainSale,
  record: QueuedSale
): TransferVerification {
  if (
    record.saleRequestId !== marker.saleRequestId ||
    record.paymentMethod !== marker.paymentMethod ||
    record.tipAmount !== marker.tipAmount ||
    canonicalItems(record.items) !== canonicalItems(marker.items)
  ) {
    return { ok: false, reason: "different_sale" };
  }

  if (
    record.deviceAuthUserId !== marker.deviceAuthUserId ||
    record.deviceId !== marker.deviceId ||
    record.projectId !== marker.projectId ||
    record.buildJobId !== marker.buildJobId
  ) {
    return { ok: false, reason: "different_pairing" };
  }

  const claims = strictClaimsFromMarker(marker);

  if (claims === null) {
    // A legacy marker: the record holding this exact sale owns its key, which
    // is all a legacy marker was ever protecting. (No strict record can have
    // been made from it — there were no originals to make one with.)
    return { ok: true };
  }

  if (!isStrictRecoverySale(record) || record.strictRecovery == null) {
    return { ok: false, reason: "not_strict" };
  }

  const stored = record.strictRecovery;

  if (
    stored.originalEmployeeId !== claims.originalEmployeeId ||
    stored.originalEmployeePosSessionId !== claims.originalEmployeePosSessionId ||
    stored.originalRegisterSessionId !== claims.originalRegisterSessionId ||
    stored.originalAttemptAt !== claims.originalAttemptAt ||
    record.occurredAt !== claims.originalAttemptAt
  ) {
    return { ok: false, reason: "different_originals" };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Operator sentences
// ---------------------------------------------------------------------------

/**
 * What the cashier reads while a sale stays protected. Never a promise the
 * gates may not keep, and never the raw server text.
 */
export const RECOVERY_PROTECTED_MESSAGES: Readonly<Record<ProtectedReason, string>> = {
  legacy_unresolvable:
    "An earlier sale on this till could not be confirmed, and this till cannot finish it on its own. Keep the order unchanged and reconnect so it can be checked.",
  attribution_conflict:
    "This sale is already recorded, but under a different employee or register than the one that rang it. It has been kept on this till. Ask the account owner to review it.",
  claims_unverifiable:
    "This sale is already recorded, but who rang it could not be confirmed. It has been kept on this till. Ask the account owner to review it.",
  not_this_device:
    "This sale's reference belongs to a different till. It has been kept on this till. Ask the account owner to review it.",
  payload_mismatch:
    "A different sale is already recorded under this sale's reference. It has been kept on this till. Ask the account owner to review it.",
  malformed_response:
    "The server's answer about this sale could not be read. Nothing was changed. Keep the order unchanged and try again.",
  recovery_unavailable:
    "This till cannot finish the earlier sale yet because the server does not support it. Nothing was changed. Keep the order unchanged and ask the account owner.",
  server_rejected:
    "The server refused to finish this sale. Nothing was changed. Keep the order unchanged and ask the account owner.",
  unknown_outcome:
    "Whether this sale finished could not be confirmed. Keep the order unchanged and try again.",
  connection_lost:
    "The connection was lost while checking this sale. Keep the order unchanged and try again.",
  transfer_failed:
    "This sale could not be saved on this device, so nothing was changed. Keep the order unchanged and try again.",
  transfer_conflict:
    "A different saved sale already uses this sale's reference on this device. Nothing was changed. Ask the account owner to check this till.",
};

/** The success note for a sale the server already had. No invented receipt. */
export function describeRecordedSale(order: LookupOrderSummary): string {
  return `This sale was already recorded as order ${order.orderNumber} (total ${order.total}). It has not been recorded a second time.`;
}
