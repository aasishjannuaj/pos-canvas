// v1.3 Feature 1B-RUNTIME — the register session RPCs, device side.
//
// THE ONLY MODULE THAT CALLS open_register_session,
// get_current_register_session or close_register_session. lib/registerSession.ts
// holds the pure types, validation and parsers; this file is the adapter, and it
// is deliberately as thin as lib/employee.rpc.ts.
//
// NO IDENTITY CROSSES THE WIRE. None of these calls takes a project id, a device
// id or an employee id: the server derives the device from auth.uid(), the
// project from that device's pairing row, and the employee from the POS session
// open on it. The only arguments that exist are an idempotency key and an
// amount. A till that could name its own register would be a till that could
// choose one.
import { getDeviceSupabaseClient } from "@/lib/supabase/deviceClient";
import { classifyDeviceFailure } from "@/lib/deviceConnectivity";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import {
  parseCurrentRegisterSessionResult,
  parseRegisterCloseResult,
  parseRegisterOpenResult,
} from "@/lib/registerSession";
import type {
  CurrentRegisterSessionResult,
  RegisterCloseResult,
  RegisterOpenResult,
} from "@/lib/registerSession";

/**
 * Carries the HTTP status onto the error object so classifyDeviceFailure can
 * tell a real refusal from a synthesized fetch failure. Same shape, and same
 * reason, as lib/employee.rpc.ts and lib/device.rpc.ts.
 */
function withStatus(error: unknown, status: number | undefined): unknown {
  if (error === null || typeof error !== "object" || status === undefined) {
    return error;
  }

  return Object.assign(Object.create(Object.getPrototypeOf(error)), error, { status });
}

/**
 * A failure that reached no server becomes `unavailable` here.
 *
 * The register calls do not distinguish `offline` the way employee login does:
 * every one of them is an online-only operation, and a till that cannot reach
 * the server simply cannot open or close a register. The caller decides what to
 * show; this only reports that nothing was established.
 */
function unreached(error: unknown): "unavailable" {
  void (isAuthRetryableFetchError(error) || classifyDeviceFailure(error));

  return "unavailable";
}

/**
 * The register open on THIS till right now, or null.
 *
 * NOT CACHED AND NOT PERSISTED, for the same reason the employee session is
 * not: an open register is server state, and a till that remembered one across
 * a restart would be inventing authority it no longer has. The runtime calls
 * this at startup and on reconnect and believes the answer.
 */
export async function fetchCurrentRegisterSession(): Promise<CurrentRegisterSessionResult> {
  try {
    const { data, error, status } = await getDeviceSupabaseClient().rpc(
      "get_current_register_session"
    );

    if (error) {
      return { ok: false, code: unreached(withStatus(error, status)) };
    }

    return parseCurrentRegisterSessionResult(data);
  } catch (thrown) {
    return { ok: false, code: unreached(thrown) };
  }
}

/**
 * Opens the register on this till.
 *
 * IDEMPOTENT ON THE REQUEST ID, which the CALLER mints once per attempt and
 * reuses on retry. That is what makes a lost response safe: the same request id
 * with the same amount returns the session the server already opened instead of
 * opening a second one, and the same request id with a DIFFERENT amount is a
 * conflict rather than a silent overwrite.
 *
 * The amount is sent exactly as validated — never rounded here. Over-precision
 * is the server's refusal to make, and lib/registerSession.ts only pre-empts it
 * so the cashier hears about it a moment sooner.
 */
export async function openRegisterSession(
  requestId: string,
  openingCash: number
): Promise<RegisterOpenResult> {
  try {
    const { data, error, status } = await getDeviceSupabaseClient().rpc("open_register_session", {
      p_request_id: requestId,
      p_opening_cash: openingCash,
    });

    if (error) {
      return { ok: false, code: unreached(withStatus(error, status)), session: null };
    }

    return parseRegisterOpenResult(data);
  } catch (thrown) {
    return { ok: false, code: unreached(thrown), session: null };
  }
}

/**
 * Closes one register session — the primitive lifecycle close, and nothing else.
 *
 * NO CASH RECONCILIATION PASSES THROUGH HERE. There is no counted amount, no
 * variance and no report: those belong to Cash Control, and the server function
 * this calls writes only closed_at and closed_by_employee_id.
 *
 * THE ID IS A TARGET, NOT AUTHORITY. The server resolves ownership from the
 * target's own paired device and refuses anything else with the same not_found
 * it gives an id that does not exist. A retry of an already-closed session
 * returns its stored state unchanged, so a lost response is safe to repeat.
 */
export async function closeRegisterSession(
  registerSessionId: string
): Promise<RegisterCloseResult> {
  try {
    const { data, error, status } = await getDeviceSupabaseClient().rpc("close_register_session", {
      p_register_session_id: registerSessionId,
    });

    if (error) {
      return { ok: false, code: unreached(withStatus(error, status)) };
    }

    return parseRegisterCloseResult(data);
  } catch (thrown) {
    return { ok: false, code: unreached(thrown) };
  }
}
