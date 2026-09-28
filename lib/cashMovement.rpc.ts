/**
 * v1.3 Feature 1D — the only three calls a till makes about cash that moves
 * without a sale.
 *
 * THREE CALLS, NOT ONE WITH A KIND. Each names the event it creates, matching the
 * three server RPCs, and there is no code path here through which a till could
 * supply a movement type. That is the point: the server's role gate asks "is this
 * money leaving the business, or just the drawer?", and a caller that could answer
 * that question itself could walk straight past the gate.
 *
 * THE PAYLOAD CARRIES NO AUTHORITY. Employee ID, PIN, amount, note, the business
 * day the till believed it was on, and a request id. No project, device or employee
 * id -- authority is derived from the caller's own pairing row, so a till cannot
 * record money against another shop or against somebody who never authorized it.
 * No timestamp, because the server owns the clock: a device with a wrong one must
 * not be able to file this shop's cash under another business day.
 *
 * THE AMOUNT GOES AS TEXT, AND THAT IS A CORRECTNESS RULE. JSON.stringify(25.00)
 * is "25", and a JavaScript number cannot carry an exact decimal at all -- so the
 * canonical two-decimal string built by validateCashAmount is what travels, and
 * PostgreSQL casts it to numeric on arrival. Nothing in this path is IEEE-754.
 *
 * ONLINE ONLY, DELIBERATELY. A transport failure is reported and nothing is kept:
 * no queue, no IndexedDB record, no draft, no automatic retry after reconnect. A
 * cash record that appears without a person confirming it is worse than a missing
 * one, and an offline till cannot even know which business day it would belong to.
 */

import { getDeviceSupabaseClient } from "@/lib/supabase/deviceClient";
import { classifyDeviceFailure } from "@/lib/deviceConnectivity";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { cashMovementFailure, parseCashMovementResult } from "@/lib/cashMovement";
import type { CashMovementResult, CashMovementType } from "@/lib/cashMovement";

/** The RPC that records each kind. The mapping lives here and nowhere else. */
const CASH_MOVEMENT_RPCS: Record<CashMovementType, string> = {
  cash_drop: "record_cash_drop",
  paid_in: "record_paid_in",
  paid_out: "record_paid_out",
};

/**
 * A fresh id for one movement a person is confirming right now.
 *
 * It exists so a lost reply can be retried safely: the server answers a repeat
 * with the ORIGINAL record rather than moving the money twice. Generated per
 * confirmed attempt, not per keystroke.
 */
export function newCashMovementRequestId(): string {
  return crypto.randomUUID();
}

/** Attaches the HTTP status supabase-js reports, so transport is separable. */
function withStatus(error: unknown, status: number | undefined): unknown {
  if (error === null || typeof error !== "object" || typeof status !== "number") {
    return error;
  }

  return { ...(error as Record<string, unknown>), status };
}

/**
 * "Did not reach the server" versus "the server said no".
 *
 * Only the first may be called offline, and a cash movement treats offline as a
 * refusal rather than as a reason to remember something for later.
 */
function unreachedFailure(error: unknown): "offline" | "unavailable" {
  const kind = isAuthRetryableFetchError(error) ? "transport" : classifyDeviceFailure(error);

  return kind === "transport" ? "offline" : "unavailable";
}

export type CashMovementRequest = {
  employeeCode: string;
  pin: string;
  /** The canonical two-decimal string from validateCashAmount. Never a number. */
  amount: string;
  /** Already trimmed, or null. The server trims again and requires it where it must. */
  note: string | null;
  /** The DAILY the till believed it was on. An EXPECTATION, never authority. */
  expectedRegisterSessionId: string;
  requestId: string;
};

async function record(
  type: CashMovementType,
  request: CashMovementRequest
): Promise<CashMovementResult> {
  try {
    const { data, error, status } = await getDeviceSupabaseClient().rpc(
      CASH_MOVEMENT_RPCS[type],
      {
        p_employee_code: request.employeeCode,
        p_pin: request.pin,
        p_amount: request.amount,
        p_note: request.note,
        p_expected_register_session_id: request.expectedRegisterSessionId,
        p_request_id: request.requestId,
      }
    );

    if (error) {
      return cashMovementFailure(unreachedFailure(withStatus(error, status)));
    }

    return parseCashMovementResult(data);
  } catch (thrown) {
    return cashMovementFailure(unreachedFailure(thrown));
  }
}

/** Cash taken out of this till for safer storage. Any active employee may. */
export async function recordCashDrop(
  request: CashMovementRequest
): Promise<CashMovementResult> {
  return record("cash_drop", request);
}

/** Cash added for a reason that is not a sale. Owner or manager; note required. */
export async function recordPaidIn(
  request: CashMovementRequest
): Promise<CashMovementResult> {
  return record("paid_in", request);
}

/**
 * Cash removed to settle an operational expense -- money that leaves the
 * business, unlike a drop. Owner or manager; note required.
 */
export async function recordPaidOut(
  request: CashMovementRequest
): Promise<CashMovementResult> {
  return record("paid_out", request);
}

/** Dispatches to the call for `type`. No generic server RPC stands behind it. */
export async function recordCashMovement(
  type: CashMovementType,
  request: CashMovementRequest
): Promise<CashMovementResult> {
  return record(type, request);
}
