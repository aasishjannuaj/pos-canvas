// v1.3 Feature 1A / 1A.1 — the employee identity and till session PURE model.
//
// Dependency-free: no React, no Supabase, no browser API, no timers. Every
// decision the runtime will later make about who is signed in at a till lives
// here so it can be unit-tested under plain Node, exactly like
// lib/deviceSession.ts and lib/devicePairing.ts.
//
// The effectful half lives in lib/employee.rpc.ts, which owns the device
// Supabase client. This module never imports it.
//
// THE PIN IS NEVER PERSISTED, ANYWHERE. Nothing in this file writes to
// localStorage, sessionStorage, IndexedDB or the offline cache, and nothing
// returns a PIN, a hash, a failure counter or a lockout deadline back out of a
// parsed payload. A PIN exists only as an argument travelling to the login RPC
// and is dropped the moment that call returns.
//
// WHY THIS MODEL IS DELIBERATELY SMALL. Feature 1A ships the identity and
// session foundation, not the till UI. There is no screen state machine here
// because there is no screen yet: Lane 2 builds that on top of these types.
//
// FEATURE 1A.1 — SELECT, THEN PROVE. The till first lists who may sign in
// (parseLoginEmployeesResult), the operator picks themselves, and only then is a
// PIN sent — with the chosen employeeId — so the server verifies ONE hash
// instead of scanning the roster. The selector carries an id and a name and
// nothing else: no role, no PIN material, no account state. The id identifies;
// it never authorizes. Everything about whether that person may sign in is
// decided by the server after the PIN is checked.

// ---------------------------------------------------------------------------
// Roles — a closed set, by design
// ---------------------------------------------------------------------------

/**
 * The complete v1.3 role set. There is no configurable permission model and no
 * RBAC engine behind these: they are labels the till and later features read,
 * and widening the set is a schema change (employees_role_check), not a config
 * change.
 */
export const EMPLOYEE_ROLES = ["owner", "manager", "cashier"] as const;

export type EmployeeRole = (typeof EMPLOYEE_ROLES)[number];

export function isEmployeeRole(value: unknown): value is EmployeeRole {
  return typeof value === "string" && (EMPLOYEE_ROLES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// PIN shape
// ---------------------------------------------------------------------------

// v1.3 CP2d — CORRECTED TO 4, AND THE RANGE THEY DESCRIBED IS GONE.
//
// Checkpoint 1 tightened the PIN to exactly four digits on the server and in
// isValidEmployeePinShape below, but these two constants were left describing
// the old 4–6 range. Nothing reads either of them — the live rule is the regex
// — so this was a stale statement rather than a live bug, and it is corrected
// because a constant that says 6 next to a rule that means 4 is exactly the
// kind of thing somebody later believes.
export const EMPLOYEE_PIN_MIN_LENGTH = 4;
export const EMPLOYEE_PIN_MAX_LENGTH = 4;

/**
 * Exactly 4 ASCII digits. The same rule the database enforces, restated here
 * so a till can refuse an obviously malformed entry without spending a round
 * trip — never so it can decide what is valid.
 *
 * IT DOES NOT TRIM, PAD, STRIP OR NORMALIZE. A pairing code is normalized on
 * both sides because an owner reads it aloud and a human retypes it with
 * spaces and hyphens; a PIN is typed on a keypad and a value that is not
 * already 4 digits is not a near-miss to be repaired, it is wrong. Coercing
 * " 1234 " into "1234" here would also mean the client and the server disagreed
 * about what was submitted.
 *
 * Unicode digits are rejected on purpose: the server's check is `^[0-9]{4}$`
 * over ASCII, so accepting "١٢٣٤" here would only produce a puzzling round trip.
 */
export function isValidEmployeePinShape(pin: unknown): pin is string {
  // v1.3 checkpoint 1 tightened this to EXACTLY four digits, on the server and
  // here. A range meant two tills in the same shop drawing a different number
  // of boxes; 20260919120000 removed it everywhere with no legacy branch.
  return typeof pin === "string" && /^[0-9]{4}$/.test(pin);
}

/**
 * The Employee ID a cashier types: exactly three digits, `001`-`999`.
 *
 * `000` is refused because it reads as "no employee" on a keypad and is the
 * single most likely accidental entry. The server refuses it too — this only
 * lets the till say so before spending a round trip.
 *
 * SHAPE ONLY. It says nothing about whether the ID exists, and it must not:
 * that answer is the server's, and it is deliberately indistinguishable from a
 * wrong PIN.
 */
export function isValidEmployeeCodeShape(code: unknown): code is string {
  return typeof code === "string" && /^[0-9]{3}$/.test(code) && code !== "000";
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

/**
 * What the server is willing to say about the person signed in at this till.
 *
 * Note what is absent and must stay absent: no PIN, no hash, no project id, no
 * device id, no owner identity, no failed-attempt count and no lockout state.
 */
export type EmployeeSession = {
  employeeSessionId: string;
  employeeId: string;
  displayName: string;
  role: EmployeeRole;
  startedAt: string;
};

/**
 * Why a login or a session read could not proceed.
 *
 * `invalid_credentials` is ONE code covering every credential-shaped failure —
 * wrong PIN, an employee id that does not exist, an inactive employee, another
 * project's employee, and a malformed PIN. The server collapses them deliberately, and this module must
 * never reintroduce the distinction the backend removed.
 *
 * `locked_out` is separate and is not a credential answer: it reports this
 * register's own rate-limit state, which this register produced. It tells an
 * operator to wait rather than to keep guessing, and reveals nothing about
 * whether any PIN exists or who the employees are.
 *
 * `offline` and `unavailable` are separated for the reason DeviceErrorKind
 * documents at length: telling an operator "unavailable" when nothing answered
 * sends them to restart a till, and telling them "offline" when the server
 * actively refused sends them to check a router that is working. They are
 * distinguished by what is KNOWN — `offline` means the request was positively
 * classified as never having reached a server. NEITHER is ever produced by the
 * database; both are decided client-side in lib/employee.rpc.ts.
 */
export type EmployeeLoginErrorCode =
  | "not_authenticated"
  | "not_paired"
  | "invalid_credentials"
  | "locked_out"
  | "offline"
  | "unavailable";

const EMPLOYEE_LOGIN_ERROR_CODES: readonly EmployeeLoginErrorCode[] = [
  "not_authenticated",
  "not_paired",
  "invalid_credentials",
  "locked_out",
  "offline",
  "unavailable",
];

// No server jargon: the person reading this is standing at a counter with a
// queue behind them. Nothing here names an RPC, a table, a role, a SQLSTATE or
// a Postgres error.
const EMPLOYEE_LOGIN_ERROR_MESSAGES: Record<EmployeeLoginErrorCode, string> = {
  not_authenticated: "This till is not signed in.",
  not_paired: "This till is no longer set up for your shop.",
  invalid_credentials: "That PIN was not recognised.",
  locked_out: "Too many incorrect PINs. Try again shortly.",
  offline: "This till is offline. Check the connection and try again.",
  unavailable: "Sign-in is unavailable right now.",
};

export function getEmployeeLoginErrorMessage(
  code: EmployeeLoginErrorCode,
  retryAfterSeconds?: number | null
): string {
  if (code !== "locked_out" || typeof retryAfterSeconds !== "number") {
    return EMPLOYEE_LOGIN_ERROR_MESSAGES[code];
  }

  return `Too many incorrect PINs. Try again in ${formatRetryWait(retryAfterSeconds)}.`;
}

/**
 * A wait an operator can act on, rounded UP so the message never expires before
 * the lock does — being told "try again in 1 minute" and being refused at 59
 * seconds is worse than waiting an extra second.
 */
export function formatRetryWait(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "a moment";
  }

  const whole = Math.ceil(seconds);

  if (whole < 60) {
    return `${whole} second${whole === 1 ? "" : "s"}`;
  }

  const minutes = Math.ceil(whole / 60);

  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export type EmployeeLoginResult =
  | { ok: true; session: EmployeeSession }
  | {
      ok: false;
      error: EmployeeLoginErrorCode;
      message: string;
      // Present only for `locked_out`. Never carries a deadline, a counter, or
      // anything else derived from the server's failure state.
      retryAfterSeconds?: number;
    };

export type CurrentEmployeeSessionResult =
  | { ok: true; session: EmployeeSession | null }
  | { ok: false; error: EmployeeLoginErrorCode; message: string };

export type EmployeeLogoutResult =
  | { ok: true; endedSessionId: string | null }
  | { ok: false; error: EmployeeLoginErrorCode; message: string };

// ---------------------------------------------------------------------------
// Payload parsing
//
// Every parser is total: any shape it does not recognise becomes a failure
// result, never a throw and never a partially populated session. An
// unrecognised payload is `unavailable` rather than `invalid_credentials`,
// because "the server said no" and "the server said something we could not
// read" are different facts and only the first is about the PIN.
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function toLoginErrorCode(value: unknown): EmployeeLoginErrorCode {
  return EMPLOYEE_LOGIN_ERROR_CODES.includes(value as EmployeeLoginErrorCode)
    ? (value as EmployeeLoginErrorCode)
    : "unavailable";
}

function loginFailure(
  code: EmployeeLoginErrorCode,
  retryAfterSeconds?: number
): EmployeeLoginResult {
  if (code === "locked_out" && typeof retryAfterSeconds === "number") {
    return {
      ok: false,
      error: code,
      message: getEmployeeLoginErrorMessage(code, retryAfterSeconds),
      retryAfterSeconds,
    };
  }

  return { ok: false, error: code, message: getEmployeeLoginErrorMessage(code) };
}

/**
 * Reads a session object out of a payload, or null if it is not a complete one.
 *
 * ALL FIVE FIELDS ARE REQUIRED. A session missing its role or its id is not a
 * usable operator record, and filling a gap with a default would invent an
 * authorization fact the server never stated.
 */
function parseSession(value: unknown): EmployeeSession | null {
  const record = asRecord(value);

  if (!record) {
    return null;
  }

  const employeeSessionId = asNonEmptyString(record.employeeSessionId);
  const employeeId = asNonEmptyString(record.employeeId);
  const displayName = asNonEmptyString(record.displayName);
  const startedAt = asNonEmptyString(record.startedAt);

  if (!employeeSessionId || !employeeId || !displayName || !startedAt) {
    return null;
  }

  if (!isEmployeeRole(record.role)) {
    return null;
  }

  return { employeeSessionId, employeeId, displayName, role: record.role, startedAt };
}

function parseRetryAfterSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return Math.ceil(value);
}

export function parseEmployeeLoginResult(payload: unknown): EmployeeLoginResult {
  const record = asRecord(payload);

  if (!record) {
    return loginFailure("unavailable");
  }

  if (record.ok !== true) {
    const code = toLoginErrorCode(record.error);

    return code === "locked_out"
      ? loginFailure(code, parseRetryAfterSeconds(record.retryAfterSeconds))
      : loginFailure(code);
  }

  // A success payload is the session, flattened — the server does not nest it
  // on this call, and inventing a wrapper here would diverge from the RPC.
  const session = parseSession(record);

  return session ? { ok: true, session } : loginFailure("unavailable");
}

export function parseCurrentEmployeeSessionResult(
  payload: unknown
): CurrentEmployeeSessionResult {
  const record = asRecord(payload);

  if (!record) {
    return { ok: false, error: "unavailable", message: getEmployeeLoginErrorMessage("unavailable") };
  }

  if (record.ok !== true) {
    const code = toLoginErrorCode(record.error);

    return { ok: false, error: code, message: getEmployeeLoginErrorMessage(code) };
  }

  // Nobody signed in is a successful answer, and is NOT the same as a payload
  // we could not read.
  if (record.session === null || record.session === undefined) {
    return { ok: true, session: null };
  }

  const session = parseSession(record.session);

  return session
    ? { ok: true, session }
    : { ok: false, error: "unavailable", message: getEmployeeLoginErrorMessage("unavailable") };
}

export function parseEmployeeLogoutResult(payload: unknown): EmployeeLogoutResult {
  const record = asRecord(payload);

  if (!record) {
    return { ok: false, error: "unavailable", message: getEmployeeLoginErrorMessage("unavailable") };
  }

  if (record.ok !== true) {
    const code = toLoginErrorCode(record.error);

    return { ok: false, error: code, message: getEmployeeLoginErrorMessage(code) };
  }

  // Logging out when nobody was signed in succeeds and reports null. The RPC is
  // idempotent precisely so a client that never saw the reply can retry.
  return { ok: true, endedSessionId: asNonEmptyString(record.endedSessionId) };
}

// ---------------------------------------------------------------------------
// Feature 1A.1 — the login selector
// ---------------------------------------------------------------------------

/**
 * One person the till may offer for sign-in.
 *
 * EXACTLY TWO FIELDS, AND THAT IS A SECURITY PROPERTY, NOT AN OMISSION. The
 * selector is shown before anyone has authenticated, on a screen a customer can
 * see. Role would publish who the managers are; anything account-shaped would
 * publish more. Role arrives only in EmployeeSession, after the PIN is checked.
 *
 * Two people may share a displayName. They are different employees and are
 * told apart by employeeId alone; nothing here merges, dedupes or renames them.
 */
export type LoginEmployee = {
  employeeId: string;
  displayName: string;
};

export type LoginEmployeesResult =
  | { ok: true; employees: LoginEmployee[] }
  | { ok: false; error: EmployeeLoginErrorCode; message: string };

function loginEmployeesFailure(code: EmployeeLoginErrorCode): LoginEmployeesResult {
  return { ok: false, error: code, message: getEmployeeLoginErrorMessage(code) };
}

/**
 * Reads the selector payload.
 *
 * ORDER IS PRESERVED EXACTLY. The server sorts by display name then id; this
 * does not re-sort, filter or dedupe, so every caller renders the same order.
 *
 * ONLY THE TWO FIELDS ARE COPIED. Anything else the payload carries is dropped
 * on the floor rather than passed through, so a server that ever over-shared
 * could not widen what the UI receives.
 *
 * ONE BAD ENTRY FAILS THE WHOLE LIST. Silently skipping an unreadable entry
 * would hide a real employee from the till with no explanation; `unavailable`
 * is the honest answer.
 */
export function parseLoginEmployeesResult(payload: unknown): LoginEmployeesResult {
  const record = asRecord(payload);

  if (!record) {
    return loginEmployeesFailure("unavailable");
  }

  if (record.ok !== true) {
    return loginEmployeesFailure(toLoginErrorCode(record.error));
  }

  if (!Array.isArray(record.employees)) {
    return loginEmployeesFailure("unavailable");
  }

  const employees: LoginEmployee[] = [];

  for (const entry of record.employees) {
    const item = asRecord(entry);
    const employeeId = item ? asNonEmptyString(item.employeeId) : null;
    const displayName = item ? asNonEmptyString(item.displayName) : null;

    if (!employeeId || !displayName) {
      return loginEmployeesFailure("unavailable");
    }

    employees.push({ employeeId, displayName });
  }

  return { ok: true, employees };
}
