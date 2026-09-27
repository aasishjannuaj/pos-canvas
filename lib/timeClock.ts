/**
 * v1.3 Feature 1C — Time Clock types and parsing.
 *
 * WHAT THIS RECORDS, AND WHAT IT DOES NOT. A Time Clock session is when a
 * person was at work. It is not who is operating the till — that is the
 * employee POS-session — and it is not which business day the money belongs to,
 * which is the DAILY register. Nothing in this module refers to either, on
 * purpose: an employee hands the register to a colleague and keeps working, and
 * a cashier's shift ends while the till stays open for the next person. Both
 * are ordinary days, and both become unrecordable the moment these ideas are
 * coupled.
 *
 * NO TIME COMES FROM HERE. There is no field through which a client could offer
 * a clock-in or clock-out instant; both are read back from the server's reply.
 * A till with a wrong clock — or an operator who set it — cannot change what
 * payroll sees.
 *
 * ONLINE ONLY. An unreachable backend is reported as a failure and nothing is
 * kept locally: no queued punch, no draft, no "we will send it later". A
 * timesheet entry that appears without a person standing at a till is worse
 * than a missing one, because nobody can tell it is wrong.
 */

export type TimeClockAction = "clock_in" | "clock_out";

/** What happened. `replayed` marks a retry answered from the original record. */
export type TimeClockOutcome = "clocked_in" | "clocked_out";

/**
 * Why a punch did nothing.
 *
 * `invalid_credentials` deliberately covers an unknown Employee ID, a wrong PIN
 * AND a deactivated employee. Telling them apart would make the Time Clock a
 * way to discover who works here — a weaker door standing beside the hardened
 * one the POS login already uses.
 */
export type TimeClockErrorCode =
  | "not_authenticated"
  | "not_paired"
  | "invalid_credentials"
  | "locked_out"
  | "already_clocked_in"
  | "not_clocked_in"
  | "request_required"
  | "request_conflict"
  | "offline"
  | "unavailable";

export type TimeClockResult =
  | {
      ok: true;
      outcome: TimeClockOutcome;
      timeSessionId: string;
      /** The SERVER's instant, echoed back. Never computed here. */
      clockedInAt: string;
      clockedOutAt: string | null;
      replayed: boolean;
    }
  | {
      ok: false;
      error: TimeClockErrorCode;
      message: string;
      /** Present on `locked_out`, and on the two state conflicts. */
      retryAfterSeconds?: number;
      clockedInAt?: string;
    };

const TIME_CLOCK_ERROR_CODES: readonly TimeClockErrorCode[] = [
  "not_authenticated",
  "not_paired",
  "invalid_credentials",
  "locked_out",
  "already_clocked_in",
  "not_clocked_in",
  "request_required",
  "request_conflict",
  "offline",
  "unavailable",
];

// The reader is an employee at a counter, often with a queue behind them.
// Nothing here names an RPC, a table, a column or a role.
const TIME_CLOCK_MESSAGES: Record<TimeClockErrorCode, string> = {
  not_authenticated: "This till is not signed in.",
  not_paired: "This till is no longer set up for your shop.",
  invalid_credentials: "That Employee ID or PIN was not recognised.",
  locked_out: "Too many incorrect PINs. Try again shortly.",
  already_clocked_in: "You are already clocked in.",
  not_clocked_in: "You are not clocked in.",
  request_required: "That did not go through. Try again.",
  // DELIBERATELY BLAND. This means the request id already belongs to somebody
  // else's punch. Saying so would confirm that another employee used this till
  // and when -- and the person reading it can do nothing with that. They press
  // the button again and get a fresh id.
  request_conflict: "Please try again.",
  offline: "This till is offline. Time Clock needs a connection.",
  unavailable: "The Time Clock is unavailable right now.",
};

export function getTimeClockMessage(
  code: TimeClockErrorCode,
  retryAfterSeconds?: number | null
): string {
  if (code === "locked_out" && typeof retryAfterSeconds === "number" && retryAfterSeconds > 0) {
    const whole = Math.ceil(retryAfterSeconds);

    return whole < 60
      ? `Too many incorrect PINs. Try again in ${whole} second${whole === 1 ? "" : "s"}.`
      : `Too many incorrect PINs. Try again in ${Math.ceil(whole / 60)} minute${
          Math.ceil(whole / 60) === 1 ? "" : "s"
        }.`;
  }

  return TIME_CLOCK_MESSAGES[code];
}

/** Both fields must be shaped right before a PIN is ever sent anywhere. */
export function isValidTimeClockCode(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{3}$/.test(value) && value !== "000";
}

export function isValidTimeClockPin(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{4}$/.test(value);
}

function asRecord(payload: unknown): Record<string, unknown> | null {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function toErrorCode(value: unknown): TimeClockErrorCode {
  return TIME_CLOCK_ERROR_CODES.includes(value as TimeClockErrorCode)
    ? (value as TimeClockErrorCode)
    : "unavailable";
}

export function timeClockFailure(
  code: TimeClockErrorCode,
  retryAfterSeconds?: number
): TimeClockResult {
  return {
    ok: false,
    error: code,
    message: getTimeClockMessage(code, retryAfterSeconds ?? null),
    ...(typeof retryAfterSeconds === "number" ? { retryAfterSeconds } : {}),
  };
}

/**
 * Total: any shape this does not recognise becomes a failure, never a throw and
 * never a half-built success.
 *
 * AN UNREADABLE SUCCESS IS NOT A SUCCESS. A reply claiming `ok` without a
 * session id or a clock-in instant is reported as `unavailable`, because the
 * employee is about to be told they are clocked in and that has to be true.
 */
export function parseTimeClockResult(payload: unknown): TimeClockResult {
  const record = asRecord(payload);

  if (!record) {
    return timeClockFailure("unavailable");
  }

  if (record.ok !== true) {
    const code = toErrorCode(record.error);
    const retry =
      typeof record.retryAfterSeconds === "number" ? record.retryAfterSeconds : undefined;
    const clockedInAt = asNonEmptyString(record.clockedInAt);

    return {
      ...timeClockFailure(code, retry),
      ...(clockedInAt !== null ? { clockedInAt } : {}),
    } as TimeClockResult;
  }

  const outcome = record.outcome;

  if (outcome !== "clocked_in" && outcome !== "clocked_out") {
    return timeClockFailure("unavailable");
  }

  const timeSessionId = asNonEmptyString(record.timeSessionId);
  const clockedInAt = asNonEmptyString(record.clockedInAt);

  if (timeSessionId === null || clockedInAt === null) {
    return timeClockFailure("unavailable");
  }

  // A close without an end instant is not a close.
  const clockedOutAt = asNonEmptyString(record.clockedOutAt);

  if (outcome === "clocked_out" && clockedOutAt === null) {
    return timeClockFailure("unavailable");
  }

  return {
    ok: true,
    outcome,
    timeSessionId,
    clockedInAt,
    clockedOutAt,
    replayed: record.replayed === true,
  };
}

/** What the panel says after a punch lands. The time is the server's. */
export function describeTimeClockSuccess(result: TimeClockResult): string {
  if (!result.ok) {
    return result.message;
  }

  return result.outcome === "clocked_in" ? "Clocked in." : "Clocked out.";
}
