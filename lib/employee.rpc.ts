// v1.3 Feature 1A / 1A.1 — the employee session RPC boundary.
//
// The ONLY module that pairs a Supabase client with the pure decisions in
// lib/employeeSession.ts. Every call goes through the dedicated device client
// (localStorage-namespaced, never cookie-backed), so no employee operation can
// touch an owner session.
//
// IMPORT DISCIPLINE, ENFORCED BY lib/employeeSecurity.guards.test.ts — the same
// list lib/device.rpc.ts lives under:
//   * never lib/supabase/client.ts   (cookie-backed — would clobber the owner)
//   * never lib/supabase/server.ts   (server-only, needs next/headers)
//   * never lib/supabase/admin.ts    (service-role)
//   * never lib/orders.ts            (creates the cookie client internally)
//   * never lib/projects.ts          (owner-RLS reads a device cannot do)
//
// THE PIN PASSES THROUGH AND IS NOT KEPT. It is an argument to one call. This
// module does not store it, does not log it, does not put it in an error, and
// does not hand it back. Note in particular that no catch block here
// stringifies the arguments it was called with.
//
// ERROR DISCIPLINE: the database collapses wrong PIN, unknown employee id,
// inactive employee, another project's employee and malformed PIN into a single
// `invalid_credentials`, exactly as pairing collapses five outcomes into
// `invalid_code`. This module maps through lib/employeeSession.ts's message
// table and never surfaces a raw Postgres message, so the UI cannot
// reintroduce the distinction the backend removed.
//
// NO OWNER-MANAGEMENT RPC IS WIRED HERE. create_employee, list_employees,
// set_employee_active and set_employee_pin exist in the database as the
// authoritative write path, but they are owner operations and a paired device
// must never be able to call them. Lane 3 binds them from the owner surface.
import { getDeviceSupabaseClient } from "@/lib/supabase/deviceClient";
import { classifyDeviceFailure } from "@/lib/deviceConnectivity";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import {
  getEmployeeLoginErrorMessage,
  parseCurrentEmployeeSessionResult,
  parseEmployeeLoginResult,
  parseEmployeeLogoutResult,
  parseLoginEmployeesResult,
} from "@/lib/employeeSession";
import type {
  CurrentEmployeeSessionResult,
  EmployeeLoginResult,
  EmployeeLogoutResult,
  LoginEmployeesResult,
} from "@/lib/employeeSession";

/**
 * Attaches the HTTP status supabase-js reports alongside the error, so the
 * classifier can tell a real refusal from a synthesized fetch failure. Copied in
 * spirit from lib/device.rpc.ts's `withStatus`, and for the same reason: a
 * PostgrestError carries no status of its own.
 */
function withStatus(error: unknown, status: number | undefined): unknown {
  if (error === null || typeof error !== "object" || typeof status !== "number") {
    return error;
  }

  return { ...(error as Record<string, unknown>), status };
}

/**
 * A failure that reached no verification becomes `offline` or `unavailable` —
 * never `invalid_credentials`.
 *
 * THIS DISTINCTION IS LOAD-BEARING, TWICE OVER.
 *
 * Against the PIN: reporting a dropped connection as a bad PIN would tell an
 * operator to doubt a PIN that is correct, would make a flaky network look
 * exactly like an attack in the till's own error history, and is simply untrue —
 * nothing was verified.
 *
 * Between the two remaining answers: `offline` means the request was positively
 * classified as never having reached a server, so the network is the thing to
 * check; `unavailable` means something answered and refused, or the failure
 * could not be PROVEN to be transport, so the network is not the lead. Feature
 * 25.4 records what conflating those two cost on a till with perfect
 * connectivity, and this uses the same vocabulary rather than a second
 * classifier.
 *
 * `isAuthRetryableFetchError` is consulted first because it is auth-js's own
 * public predicate for "this did not reach the server", and a fetch failure it
 * wraps carries a status of 0 and an engine-dependent message.
 */
function unreachedFailure(error: unknown): "offline" | "unavailable" {
  const kind = isAuthRetryableFetchError(error) ? "transport" : classifyDeviceFailure(error);

  return kind === "transport" ? "offline" : "unavailable";
}

/**
 * The one failure shape all three calls share. It is assignable to the failure
 * arm of every result type here, which is why none of them needs its own copy.
 */
type UnreachedFailure = { ok: false; error: "offline" | "unavailable"; message: string };

function failure(code: "offline" | "unavailable"): UnreachedFailure {
  return { ok: false, error: code, message: getEmployeeLoginErrorMessage(code) };
}

// ---------------------------------------------------------------------------
// list_login_employees — Feature 1A.1
// ---------------------------------------------------------------------------

/**
 * Who this till may offer for sign-in, as the SERVER sees it right now.
 *
 * Takes no arguments: the server reads the project off this device's own
 * pairing row, so a till cannot ask for another shop's staff.
 *
 * NOT CACHED, NOT PERSISTED. The list changes when an owner deactivates
 * someone, and employee authentication is online-authoritative. A caller may
 * hold the result in memory for the life of one selector screen; it must not
 * be written to storage or treated as permission — login re-checks everything.
 */
export async function fetchLoginEmployees(): Promise<LoginEmployeesResult> {
  try {
    const { data, error, status } = await getDeviceSupabaseClient().rpc("list_login_employees");

    if (error) {
      return failure(unreachedFailure(withStatus(error, status)));
    }

    return parseLoginEmployeesResult(data);
  } catch (thrown) {
    return failure(unreachedFailure(thrown));
  }
}

// ---------------------------------------------------------------------------
// employee_login
// ---------------------------------------------------------------------------

/**
 * Signs the SELECTED employee in at THIS till, or switches the till to them.
 *
 * SENDS THE SELECTED EMPLOYEE ID AND THE PIN, AND NOTHING ELSE. There is no
 * project id and no device id to pass: the server derives both from the
 * caller's own pairing row. A device that could name its own tenant would be a
 * device that could choose one.
 *
 * THE EMPLOYEE ID IS AN IDENTIFIER, NOT AUTHORIZATION. The server re-reads the
 * employee's project, active flag and hash for itself; an id from another shop
 * fails exactly like a wrong PIN. It is also what lets the server verify ONE
 * hash instead of scanning the roster (Feature 1A.1). A value that is not a
 * uuid at all is rejected by the database before the function body runs, so it
 * reaches no PIN check and reports `unavailable`; ids only ever come from
 * fetchLoginEmployees.
 *
 * A SUCCESSFUL LOGIN WHILE SOMEONE ELSE IS SIGNED IN IS THE SWITCH. The server
 * closes the incumbent session and opens the new one in one transaction, so
 * there is no separate switch call to make and no window in which the till has
 * two operators.
 *
 * EVERY SUBMITTED ATTEMPT REACHES THE SERVER, MALFORMED OR NOT, AND THAT IS THE
 * WHOLE POINT OF THIS FUNCTION'S SHAPE.
 *
 * An earlier version short-circuited on isValidEmployeePinShape and returned
 * `invalid_credentials` without calling the RPC. It looked like a free round
 * trip saved. It was actually the client deciding the outcome of an
 * authentication attempt, and it silently disabled the one defence that makes a
 * 4-6 digit PIN survivable: employee_login resolves the active device FIRST,
 * then records a malformed PIN as a counted device failure, which is what drives
 * the till's throttle. A till that filtered those attempts out locally would let
 * an attacker probe indefinitely at zero cost to that counter — and would report
 * "not recognised" for a submission the server never saw and never recorded.
 *
 * So: NO TRIMMING, NO PADDING, NO NORMALIZATION, NO LOCAL REFUSAL. "123",
 * "1234567", "12a4", " 1234" and "1234 " are all transmitted exactly as the
 * operator submitted them. The server returns the same generic
 * `invalid_credentials` and records the attempt.
 *
 * isValidEmployeePinShape remains available for the keypad to grey out a Submit
 * button or colour a field. That is presentation. Once an attempt is SUBMITTED,
 * it belongs to the server.
 */
export async function employeeLogin(
  employeeId: string,
  pin: string
): Promise<EmployeeLoginResult> {
  try {
    const { data, error, status } = await getDeviceSupabaseClient().rpc("employee_login", {
      p_employee_id: employeeId,
      p_pin: pin,
    });

    if (error) {
      return failure(unreachedFailure(withStatus(error, status)));
    }

    return parseEmployeeLoginResult(data);
  } catch (thrown) {
    return failure(unreachedFailure(thrown));
  }
}

// ---------------------------------------------------------------------------
// get_current_employee_session
// ---------------------------------------------------------------------------

/**
 * Who is signed in at this till right now, as the SERVER sees it.
 *
 * Deliberately not cached and deliberately not persisted. An employee session
 * is an authorization fact, and the reason get_device_config re-checks the
 * pairing on every call — rather than trusting a stored answer — applies here
 * identically: an employee deactivated mid-shift must stop being the current
 * operator on the next question, not on the next restart.
 *
 * `{ ok: true, session: null }` means nobody is signed in. That is an answer,
 * not an error.
 */
export async function fetchCurrentEmployeeSession(): Promise<CurrentEmployeeSessionResult> {
  try {
    const { data, error, status } = await getDeviceSupabaseClient().rpc(
      "get_current_employee_session"
    );

    if (error) {
      return failure(unreachedFailure(withStatus(error, status)));
    }

    return parseCurrentEmployeeSessionResult(data);
  } catch (thrown) {
    return failure(unreachedFailure(thrown));
  }
}

// ---------------------------------------------------------------------------
// employee_logout
// ---------------------------------------------------------------------------

/**
 * Signs the current employee out of THIS till.
 *
 * Takes no arguments, which is the point: there is no parameter through which a
 * till could ask to end someone else's session on another register. The server
 * closes only the open session belonging to the device it resolved from the
 * caller.
 *
 * Idempotent — logging out when nobody is signed in succeeds and reports null,
 * so a client that never saw the reply is free to retry.
 */
export async function employeeLogout(): Promise<EmployeeLogoutResult> {
  try {
    const { data, error, status } = await getDeviceSupabaseClient().rpc("employee_logout");

    if (error) {
      return failure(unreachedFailure(withStatus(error, status)));
    }

    return parseEmployeeLogoutResult(data);
  } catch (thrown) {
    return failure(unreachedFailure(thrown));
  }
}
