// v1.3 Feature 1B-RUNTIME — the register session, client side.
//
// PURE. No Supabase, no React, no storage. Types, opening-cash validation and
// the parsers for what open_register_session / get_current_register_session /
// close_register_session return. lib/register.rpc.ts is the only module that
// talks to the server, exactly as lib/employeeSession.ts and
// lib/employee.rpc.ts are split for Feature 1A.
//
// THE SERVER IS THE AUTHORITY. Everything here exists so the till can show a
// useful message a moment sooner; none of it decides anything. The opening-cash
// rules below mirror open_register_session's, and when they disagree the
// server's answer is the one that counts — which is why an amount this module
// accepts is still sent verbatim, never rounded or normalised first.

/** The register identity is the paired device. There is no second model. */
export type RegisterSession = {
  registerSessionId: string;
  openedAt: string;
  openedByEmployeeId: string;
  /** Exact, as the server rendered it: a fixed two-decimal string. */
  openingCash: string;
  closedAt: string | null;
  closedByEmployeeId: string | null;
};

export type RegisterOpenErrorCode =
  | "not_authenticated"
  | "not_paired"
  | "invalid_request"
  | "invalid_opening_cash"
  | "employee_session_required"
  | "already_open"
  | "request_conflict"
  | "unavailable";

export type RegisterCloseErrorCode =
  | "not_authenticated"
  | "not_paired"
  | "not_found"
  | "employee_session_required"
  | "unavailable";

export type RegisterCurrentErrorCode = "not_authenticated" | "not_paired" | "unavailable";

export type RegisterOpenResult =
  | { ok: true; session: RegisterSession; replayed: boolean }
  /** already_open carries the session that is open, so the till can adopt it. */
  | { ok: false; code: RegisterOpenErrorCode; session: RegisterSession | null };

export type RegisterCloseResult =
  | { ok: true; session: RegisterSession; alreadyClosed: boolean }
  | { ok: false; code: RegisterCloseErrorCode };

export type CurrentRegisterSessionResult =
  | { ok: true; session: RegisterSession | null }
  | { ok: false; code: RegisterCurrentErrorCode };

// ---------------------------------------------------------------------------
// Opening cash
// ---------------------------------------------------------------------------

/** numeric(12,2): the largest value the column can hold. */
export const MAX_OPENING_CASH = 9999999999.99;

export type OpeningCashProblem =
  | "empty"
  | "not_a_number"
  | "negative"
  | "too_precise"
  | "too_large";

export type OpeningCashResult =
  | { ok: true; amount: number; canonical: string }
  | { ok: false; problem: OpeningCashProblem };

const OPENING_CASH_MESSAGES: Record<OpeningCashProblem, string> = {
  empty: "Enter the cash in the drawer.",
  not_a_number: "Enter an amount, like 100 or 100.50.",
  negative: "The opening amount cannot be negative.",
  too_precise: "Use at most two decimal places.",
  too_large: "That amount is too large.",
};

export function getOpeningCashMessage(problem: OpeningCashProblem): string {
  return OPENING_CASH_MESSAGES[problem];
}

/**
 * Validates typed opening cash the way open_register_session does.
 *
 * REFUSES OVER-PRECISION RATHER THAN ROUNDING IT. 12.345 is a typo or a
 * misunderstanding, and silently sending 12.35 would put a number in the books
 * that nobody entered — the same reason the server refuses it instead of
 * letting numeric(12,2) round on assignment.
 *
 * Parsed from the TEXT the cashier typed, not from a float: the digit string is
 * what decides the precision, so 1.10 is two decimals and not "1.1000000001".
 */
export function validateOpeningCash(raw: string): OpeningCashResult {
  const text = raw.trim();

  if (text === "") {
    return { ok: false, problem: "empty" };
  }

  // No exponents, no leading +, no thousands separators, no currency symbol:
  // one optional minus, digits, and at most one decimal point.
  // A trailing dot ("10.") is a half-typed number, not ten: the fraction must
  // have at least one digit if the point is there at all.
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);

  if (!match) {
    return { ok: false, problem: "not_a_number" };
  }

  const [, sign, whole, fraction = ""] = match;

  if (fraction.length > 2) {
    return { ok: false, problem: "too_precise" };
  }

  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0") || "0");

  if (sign === "-" && cents > 0n) {
    return { ok: false, problem: "negative" };
  }

  if (cents > BigInt(Math.round(MAX_OPENING_CASH * 100))) {
    return { ok: false, problem: "too_large" };
  }

  const canonical = `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;

  return { ok: true, amount: Number(canonical), canonical };
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** A register session as the server renders it, or null if the shape is wrong. */
export function parseRegisterSession(value: unknown): RegisterSession | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const registerSessionId = nonEmptyString(raw.registerSessionId);
  const openedAt = nonEmptyString(raw.openedAt);
  const openedByEmployeeId = nonEmptyString(raw.openedByEmployeeId);
  const openingCash = nonEmptyString(raw.openingCash);

  if (
    registerSessionId === null ||
    openedAt === null ||
    openedByEmployeeId === null ||
    openingCash === null
  ) {
    return null;
  }

  const closedAt = nullableString(raw.closedAt);
  const closedByEmployeeId = nullableString(raw.closedByEmployeeId);

  // The server's biconditional, restated: a closed session always says who
  // closed it. A half-closed shape is refused rather than displayed.
  if ((closedAt === null) !== (closedByEmployeeId === null)) {
    return null;
  }

  return { registerSessionId, openedAt, openedByEmployeeId, openingCash, closedAt, closedByEmployeeId };
}

const OPEN_ERROR_CODES: readonly RegisterOpenErrorCode[] = [
  "not_authenticated",
  "not_paired",
  "invalid_request",
  "invalid_opening_cash",
  "employee_session_required",
  "already_open",
  "request_conflict",
];

export function parseRegisterOpenResult(payload: unknown): RegisterOpenResult {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, code: "unavailable", session: null };
  }

  const raw = payload as Record<string, unknown>;

  if (raw.ok === true) {
    const session = parseRegisterSession(raw.registerSession);

    return session === null
      ? { ok: false, code: "unavailable", session: null }
      : { ok: true, session, replayed: raw.replayed === true };
  }

  const code = OPEN_ERROR_CODES.find((known) => known === raw.error) ?? "unavailable";

  return { ok: false, code, session: parseRegisterSession(raw.registerSession) };
}

const CLOSE_ERROR_CODES: readonly RegisterCloseErrorCode[] = [
  "not_authenticated",
  "not_paired",
  "not_found",
  "employee_session_required",
];

export function parseRegisterCloseResult(payload: unknown): RegisterCloseResult {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, code: "unavailable" };
  }

  const raw = payload as Record<string, unknown>;

  if (raw.ok === true) {
    const session = parseRegisterSession(raw.registerSession);

    return session === null
      ? { ok: false, code: "unavailable" }
      : { ok: true, session, alreadyClosed: raw.alreadyClosed === true };
  }

  return { ok: false, code: CLOSE_ERROR_CODES.find((known) => known === raw.error) ?? "unavailable" };
}

export function parseCurrentRegisterSessionResult(payload: unknown): CurrentRegisterSessionResult {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, code: "unavailable" };
  }

  const raw = payload as Record<string, unknown>;

  if (raw.ok === true) {
    // No open register is a successful answer, not an error.
    if (raw.registerSession === null || raw.registerSession === undefined) {
      return { ok: true, session: null };
    }

    const session = parseRegisterSession(raw.registerSession);

    return session === null ? { ok: false, code: "unavailable" } : { ok: true, session };
  }

  const code = raw.error === "not_authenticated" || raw.error === "not_paired" ? raw.error : "unavailable";

  return { ok: false, code };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const OPEN_MESSAGES: Record<RegisterOpenErrorCode, string> = {
  not_authenticated: "This till is not signed in. Reconnect and try again.",
  not_paired: "This till is no longer paired.",
  invalid_request: "Could not start the register. Try again.",
  invalid_opening_cash: "That opening amount was refused. Check it and try again.",
  employee_session_required: "Sign in an employee before opening the register.",
  already_open: "A register is already open on this till.",
  request_conflict: "A register was already opened with a different amount.",
  unavailable: "Could not reach the server. Try again.",
};

const CLOSE_MESSAGES: Record<RegisterCloseErrorCode, string> = {
  not_authenticated: "This till is not signed in. Reconnect and try again.",
  not_paired: "This till is no longer paired.",
  not_found: "That register session could not be found.",
  employee_session_required: "Sign in an employee before closing the register.",
  unavailable: "Could not reach the server. Try again.",
};

export function getRegisterOpenMessage(code: RegisterOpenErrorCode): string {
  return OPEN_MESSAGES[code];
}

export function getRegisterCloseMessage(code: RegisterCloseErrorCode): string {
  return CLOSE_MESSAGES[code];
}
