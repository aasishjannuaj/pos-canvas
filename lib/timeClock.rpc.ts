/**
 * v1.3 Feature 1C — the only two calls a till makes about work hours.
 *
 * THE PAYLOAD IS THREE THINGS AND NOTHING ELSE: the Employee ID, the PIN, and a
 * request id. No timestamp, because the server owns the clock and a device with
 * a wrong one must not be able to move somebody's recorded hours. No project,
 * device or employee id, because authority is derived from the caller's own
 * pairing — a till cannot ask about another shop's staff by naming them.
 *
 * ONLINE ONLY, DELIBERATELY. A transport failure is reported and nothing is
 * kept: no queue, no draft, no retry that could land a punch minutes later
 * without anybody standing at the till. A timesheet entry nobody made is worse
 * than a missing one, because it looks true.
 */

import { getDeviceSupabaseClient } from "@/lib/supabase/deviceClient";
import { classifyDeviceFailure } from "@/lib/deviceConnectivity";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { parseTimeClockResult, timeClockFailure } from "@/lib/timeClock";
import type { TimeClockResult } from "@/lib/timeClock";

/**
 * A fresh id for one punch a person is making right now.
 *
 * It exists so a lost reply can be retried safely: the server answers a repeat
 * with the ORIGINAL record rather than opening a second shift or re-stamping a
 * close. Generated per attempt by the caller, not per keystroke.
 */
export function newTimeClockRequestId(): string {
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
 * Only the first may be called offline, and the Time Clock treats offline as a
 * refusal rather than as a reason to remember something for later.
 */
function unreachedFailure(error: unknown): "offline" | "unavailable" {
  const kind = isAuthRetryableFetchError(error) ? "transport" : classifyDeviceFailure(error);

  return kind === "transport" ? "offline" : "unavailable";
}

async function punch(
  rpc: "clock_in_employee" | "clock_out_employee",
  employeeCode: string,
  pin: string,
  requestId: string
): Promise<TimeClockResult> {
  try {
    const { data, error, status } = await getDeviceSupabaseClient().rpc(rpc, {
      p_employee_code: employeeCode,
      p_pin: pin,
      p_request_id: requestId,
    });

    if (error) {
      return timeClockFailure(unreachedFailure(withStatus(error, status)));
    }

    return parseTimeClockResult(data);
  } catch (thrown) {
    return timeClockFailure(unreachedFailure(thrown));
  }
}

/** Opens this employee's business-level shift. Creates no POS authority. */
export async function clockInEmployee(
  employeeCode: string,
  pin: string,
  requestId: string
): Promise<TimeClockResult> {
  return punch("clock_in_employee", employeeCode, pin, requestId);
}

/**
 * Closes this employee's open shift, whichever till opened it.
 *
 * Ends no POS session and rings nobody out: the person may still be operating
 * this register, or somebody else may be.
 */
export async function clockOutEmployee(
  employeeCode: string,
  pin: string,
  requestId: string
): Promise<TimeClockResult> {
  return punch("clock_out_employee", employeeCode, pin, requestId);
}
