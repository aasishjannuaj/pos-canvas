/**
 * v1.3 Feature 1D — cash movements, client side.
 *
 * PURE. No Supabase, no React, no storage: the three movement kinds, the amount
 * and note rules, and the parser for what record_cash_drop / record_paid_in /
 * record_paid_out return. lib/cashMovement.rpc.ts is the only module that talks
 * to the server, exactly as lib/timeClock.ts and lib/timeClock.rpc.ts are split
 * for Feature 1C.
 *
 * THE SERVER IS THE AUTHORITY. Everything here exists so a till can refuse an
 * impossible entry a moment sooner and show an exact figure on a review screen.
 * None of it decides anything: the role gate, the note requirement, the business
 * day and the money rules are all enforced again in the RPC, and when the two
 * disagree the server's answer is the one that counts.
 *
 * WHAT IT DELIBERATELY CANNOT DO. There is no expected cash, no actual cash, no
 * resulting balance, no variance and no over/short anywhere in this module, and
 * nothing here reads a register's opening cash — which is a structural 0 on
 * every DAILY row and not a drawer anybody counted. Feature 1D records source
 * events; arithmetic over them belongs to a close this product has not built.
 *
 * ONLINE ONLY. A transport failure is reported as a refusal and nothing is kept:
 * no queue, no draft, no retry that could land a cash record minutes later
 * without anybody standing at the till. An offline device cannot even know which
 * business day a movement belongs to — that is a server-derived, timezone-
 * dependent fact — so a queued movement would be filed under a day guessed
 * after the event.
 */

import { compareMoney, formatMoney, moneyFromFixedString, ZERO_MONEY } from "@/lib/money";
import type { Money } from "@/lib/money";

/**
 * The three kinds, stored exactly as the server spells them.
 *
 * A DROP and a PAID OUT both shrink the drawer and are still not one thing: a
 * drop's cash stays inside the business and will be counted again at the safe, a
 * paid-out's has left it and must be matched to an expense. "Safe drop" and
 * "cash pickup", by contrast, are NOT separate kinds — they name the destination
 * or the collector of the same event.
 */
export type CashMovementType = "cash_drop" | "paid_in" | "paid_out";

export const CASH_MOVEMENT_TYPES: readonly CashMovementType[] = [
  "cash_drop",
  "paid_in",
  "paid_out",
];

export const CASH_MOVEMENT_LABELS: Record<CashMovementType, string> = {
  cash_drop: "Cash Drop",
  paid_in: "Paid In",
  paid_out: "Paid Out",
};

export function getCashMovementLabel(type: CashMovementType): string {
  return CASH_MOVEMENT_LABELS[type];
}

/**
 * A reason is required for money moving in or out for a non-sale reason, and not
 * for a drop.
 *
 * A paid-out is cash leaving the business, and "what for" is the first thing
 * anybody asks about it later; a paid-in is usually a float top-up and worth
 * the same keystrokes. A drop's reason IS the drop. Mirrors the server's
 * cash_movements_note_required constraint, which is the rule that actually
 * holds.
 */
export function isCashMovementNoteRequired(type: CashMovementType): boolean {
  return type !== "cash_drop";
}

// ---------------------------------------------------------------------------
// The note
// ---------------------------------------------------------------------------

export const CASH_MOVEMENT_NOTE_MAX_LENGTH = 200;

/**
 * The whitespace a note is trimmed of, written out.
 *
 * THIS IS THE CONTRACT, NOT A CONVENIENCE. `String.prototype.trim()` removes
 * exactly these code points, and the server's `cash_movement_trim` enumerates the
 * same set — because it could not rely on either of the obvious shortcuts. Bare
 * `btrim()` in PostgreSQL strips SPACES ONLY, which is how a one-tab reason first
 * got through. `[[:space:]]` is closer but is resolved from the cluster's ctype
 * rather than from any rule of ours, and under en_US.UTF-8 it misses U+FEFF — so a
 * reason of one U+FEFF would have survived the server, read as present, and
 * satisfied a REQUIRED note with something nobody can see.
 *
 * Exported so a test can prove the two implementations agree character by
 * character, rather than by two people reading two lists.
 *
 * U+200B ZERO WIDTH SPACE is deliberately ABSENT: trim() does not remove it, so
 * neither does the server, and a note of one U+200B is real (if odd) content.
 */
export const CASH_NOTE_TRIMMED_WHITESPACE: readonly string[] = [
  "\u0009", // tab
  "\u000A", // line feed
  "\u000B", // vertical tab
  "\u000C", // form feed
  "\u000D", // carriage return
  "\u0020", // space
  "\u00A0", // no-break space
  "\u1680", // ogham space mark
  "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005",
  "\u2006", "\u2007", "\u2008", "\u2009", "\u200A", // en quad .. hair space
  "\u2028", // line separator
  "\u2029", // paragraph separator
  "\u202F", // narrow no-break space
  "\u205F", // medium mathematical space
  "\u3000", // ideographic space
  "\uFEFF", // zero-width no-break space
];

export type CashNoteProblem = "required" | "too_long";

export type CashNoteResult =
  | { ok: true; note: string | null }
  | { ok: false; problem: CashNoteProblem };

const CASH_NOTE_MESSAGES: Record<CashNoteProblem, string> = {
  required: "Say what this is for.",
  too_long: `Keep the reason under ${CASH_MOVEMENT_NOTE_MAX_LENGTH} characters.`,
};

export function getCashNoteMessage(problem: CashNoteProblem): string {
  return CASH_NOTE_MESSAGES[problem];
}

/**
 * Trims, and collapses blank to null so "no note" has exactly one spelling.
 *
 * `.trim()` IS the contract, and the server matches it — see
 * CASH_NOTE_TRIMMED_WHITESPACE. A reason of one tab, or one non-breaking space,
 * is blank on both sides, so a required note cannot be satisfied by something
 * invisible and an optional one cannot be stored as invisible content.
 *
 * MEASURED AFTER TRIMMING, as the server measures it. Trailing whitespace is not
 * content, so a 200-character reason typed with a stray space still fits.
 *
 * REFUSES OVER-LENGTH RATHER THAN TRUNCATING IT. A silently shortened reason is
 * a different reason, and the clause that got cut is usually the one that
 * explained the money.
 */
export function validateCashNote(raw: string, type: CashMovementType): CashNoteResult {
  const note = raw.trim();

  if (note === "") {
    return isCashMovementNoteRequired(type)
      ? { ok: false, problem: "required" }
      : { ok: true, note: null };
  }

  if (note.length > CASH_MOVEMENT_NOTE_MAX_LENGTH) {
    return { ok: false, problem: "too_long" };
  }

  return { ok: true, note };
}

// ---------------------------------------------------------------------------
// The amount
// ---------------------------------------------------------------------------

/** numeric(12,2): the largest value the column can hold, as the server states it. */
export const MAX_CASH_MOVEMENT_AMOUNT = "9999999999.99";

export type CashAmountProblem = "empty" | "not_a_number" | "too_precise" | "not_positive" | "too_large";

export type CashAmountResult =
  | {
      ok: true;
      /** The exact value, in this codebase's only money representation. */
      amount: Money;
      /** What goes on the wire and on the screen: a fixed two-decimal string. */
      canonical: string;
    }
  | { ok: false; problem: CashAmountProblem };

const CASH_AMOUNT_MESSAGES: Record<CashAmountProblem, string> = {
  empty: "Enter an amount.",
  not_a_number: "Enter an amount, like 100 or 100.50.",
  too_precise: "Use at most two decimal places.",
  not_positive: "Enter an amount greater than zero.",
  too_large: "That amount is too large.",
};

export function getCashAmountMessage(problem: CashAmountProblem): string {
  return CASH_AMOUNT_MESSAGES[problem];
}

/**
 * Validates a typed amount the way the server's cash_movement_append does.
 *
 * PARSED FROM THE TEXT, NEVER THROUGH A FLOAT. The digit string is what decides
 * the precision, so "1.10" is two decimals and not 1.1000000000000001, and the
 * exact value is carried as `Money` — this codebase's single money
 * representation — rather than as a number. No arithmetic here is IEEE-754.
 *
 * REFUSES OVER-PRECISION RATHER THAN ROUNDING IT. 12.345 is a typo or a
 * misunderstanding, and quietly sending 12.35 would put a figure in the books
 * that nobody entered. The server refuses it for the same reason, instead of
 * letting numeric(12,2) round on assignment.
 *
 * AND REFUSES ZERO AND NEGATIVES. Direction is carried by the movement kind, so
 * a negative amount is not a movement the other way — it is a mistake, or an
 * attempt to express a reversal as arithmetic, and Feature 1D has no reversal.
 */
export function validateCashAmount(raw: string): CashAmountResult {
  const text = raw.trim();

  if (text === "") {
    return { ok: false, problem: "empty" };
  }

  // No sign, no exponent, no thousands separators, no currency symbol: digits,
  // and at most one decimal point. A trailing dot ("10.") is a half-typed
  // number, not ten, so the fraction must have a digit if the point is there.
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);

  if (match === null) {
    return { ok: false, problem: "not_a_number" };
  }

  const [, whole, fraction = ""] = match;

  if (fraction.length > 2) {
    return { ok: false, problem: "too_precise" };
  }

  const canonical = `${whole}.${fraction.padEnd(2, "0")}`;
  const amount = moneyFromFixedString(canonical);
  const ceiling = moneyFromFixedString(MAX_CASH_MOVEMENT_AMOUNT);

  // Unreachable: the pattern above already guarantees the fixed-decimal shape
  // the parser wants. Handled rather than asserted, because a money value this
  // module could not read is not one it may guess at.
  if (amount === null || ceiling === null) {
    return { ok: false, problem: "not_a_number" };
  }

  if (compareMoney(amount, ZERO_MONEY) <= 0) {
    return { ok: false, problem: "not_positive" };
  }

  if (compareMoney(amount, ceiling) > 0) {
    return { ok: false, problem: "too_large" };
  }

  // formatMoney rather than the matched text, so what the review screen shows is
  // rendered by the same function that renders every other figure in the POS.
  return { ok: true, amount, canonical: formatMoney(amount) };
}

// ---------------------------------------------------------------------------
// The server's answer
// ---------------------------------------------------------------------------

/**
 * Why a movement did nothing.
 *
 * `invalid_credentials` deliberately covers an unknown Employee ID, a wrong PIN
 * AND a deactivated employee, exactly as the POS login and the Time Clock do.
 * Telling them apart would make this panel a way to discover who works here.
 *
 * `not_permitted` is separate and only ever reached AFTER a correct PIN: it
 * means this employee may not perform this action. It names no role and no
 * requirement, so it cannot be used to read somebody's role off a till.
 *
 * `request_conflict` means the request id already belongs to a different
 * employee, business day or action. It carries no details for the same reason.
 */
export type CashMovementErrorCode =
  | "not_authenticated"
  | "not_paired"
  | "invalid_credentials"
  | "locked_out"
  | "not_permitted"
  | "invalid_amount"
  | "note_required"
  | "invalid_note"
  | "invalid_request"
  | "no_daily_context"
  | "daily_changed"
  | "business_timezone_required"
  | "request_required"
  | "request_conflict"
  | "offline"
  | "unavailable";

export type CashMovementResult =
  | {
      ok: true;
      movementId: string;
      movementType: CashMovementType;
      /** Exact, as the SERVER rendered it: a fixed two-decimal string. */
      amount: string;
      note: string | null;
      employeeName: string;
      /** The SERVER's instant, echoed back. Never computed here. */
      occurredAt: string;
      replayed: boolean;
    }
  | {
      ok: false;
      error: CashMovementErrorCode;
      message: string;
      /** Present on `locked_out`. */
      retryAfterSeconds?: number;
    };

const CASH_MOVEMENT_ERROR_CODES: readonly CashMovementErrorCode[] = [
  "not_authenticated",
  "not_paired",
  "invalid_credentials",
  "locked_out",
  "not_permitted",
  "invalid_amount",
  "note_required",
  "invalid_note",
  "invalid_request",
  "no_daily_context",
  "daily_changed",
  "business_timezone_required",
  "request_required",
  "request_conflict",
  "offline",
  "unavailable",
];

// The reader is an employee at a counter. Nothing here names an RPC, a table, a
// column or a role, and nothing implies a refused movement is waiting somewhere.
const CASH_MOVEMENT_MESSAGES: Record<CashMovementErrorCode, string> = {
  not_authenticated: "This till is not signed in.",
  not_paired: "This till is no longer set up for your shop.",
  invalid_credentials: "That Employee ID or PIN was not recognised.",
  locked_out: "Too many incorrect PINs. Try again shortly.",
  // NAMES NO ROLE, DELIBERATELY. It says what happened and stops, so the panel
  // cannot be used to read anybody's role off an unattended till.
  not_permitted: "This employee cannot record that movement.",
  invalid_amount: "That amount cannot be recorded.",
  note_required: "Say what this is for.",
  invalid_note: `Keep the reason under ${CASH_MOVEMENT_NOTE_MAX_LENGTH} characters.`,
  invalid_request: "That did not go through. Try again.",
  // THE ONE REFUSAL WITH REAL GUIDANCE. There is no business day on this till
  // yet, and a cash movement may not start one -- so the operator is told what
  // does.
  no_daily_context: "Sign in on this till first to start today's register.",
  daily_changed: "The business day changed. Check the amount and try again.",
  business_timezone_required: "This shop has no business timezone set yet.",
  request_required: "That did not go through. Try again.",
  // DELIBERATELY BLAND. This means the request id already belongs to somebody
  // else's movement. Saying so would confirm that another employee used this
  // till and when -- and the reader can do nothing with that. They press the
  // button again and get a fresh id.
  request_conflict: "Please try again.",
  offline: "This till is offline. Cash movements need a connection.",
  unavailable: "Cash movements are unavailable right now.",
};

export function getCashMovementMessage(
  code: CashMovementErrorCode,
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

  return CASH_MOVEMENT_MESSAGES[code];
}

export function cashMovementFailure(
  code: CashMovementErrorCode,
  retryAfterSeconds?: number
): CashMovementResult {
  return {
    ok: false,
    error: code,
    message: getCashMovementMessage(code, retryAfterSeconds ?? null),
    ...(typeof retryAfterSeconds === "number" ? { retryAfterSeconds } : {}),
  };
}

function asRecord(payload: unknown): Record<string, unknown> | null {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function toErrorCode(value: unknown): CashMovementErrorCode {
  return CASH_MOVEMENT_ERROR_CODES.includes(value as CashMovementErrorCode)
    ? (value as CashMovementErrorCode)
    : "unavailable";
}

function toMovementType(value: unknown): CashMovementType | null {
  return CASH_MOVEMENT_TYPES.includes(value as CashMovementType)
    ? (value as CashMovementType)
    : null;
}

/**
 * Total: any shape this does not recognise becomes a failure, never a throw and
 * never a half-built success.
 *
 * AN UNREADABLE SUCCESS IS NOT A SUCCESS. The employee is about to be told their
 * cash movement was recorded, so that has to be true and the figure shown has to
 * be the figure stored. A reply missing the id, the kind, the amount or the
 * instant is reported as `unavailable` — and the amount must still read as stored
 * money, so a third decimal or a bare integer is refused rather than displayed.
 */
export function parseCashMovementResult(payload: unknown): CashMovementResult {
  const record = asRecord(payload);

  if (record === null) {
    return cashMovementFailure("unavailable");
  }

  if (record.ok !== true) {
    const retry =
      typeof record.retryAfterSeconds === "number" ? record.retryAfterSeconds : undefined;

    return cashMovementFailure(toErrorCode(record.error), retry);
  }

  const movementId = asNonEmptyString(record.movementId);
  const movementType = toMovementType(record.movementType);
  const occurredAt = asNonEmptyString(record.occurredAt);
  const employeeName = asNonEmptyString(record.employeeName);
  const amountText = asNonEmptyString(record.amount);

  if (
    movementId === null ||
    movementType === null ||
    occurredAt === null ||
    employeeName === null ||
    amountText === null
  ) {
    return cashMovementFailure("unavailable");
  }

  // The amount arrives as the exact two-decimal text numeric(12,2) renders. Read
  // through the money parser rather than trusted, so a reply this module cannot
  // account for exactly never reaches a confirmation screen.
  const amount = moneyFromFixedString(amountText);

  if (amount === null) {
    return cashMovementFailure("unavailable");
  }

  return {
    ok: true,
    movementId,
    movementType,
    amount: formatMoney(amount),
    note: asNonEmptyString(record.note),
    employeeName,
    occurredAt,
    replayed: record.replayed === true,
  };
}

/** What the panel says after a movement lands. The figure is the server's. */
export function describeCashMovementSuccess(result: CashMovementResult): string {
  if (!result.ok) {
    return result.message;
  }

  return `${getCashMovementLabel(result.movementType)} of ${result.amount} recorded.`;
}
