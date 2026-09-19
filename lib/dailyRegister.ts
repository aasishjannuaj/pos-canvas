// v1.3 CP2d — the DAILY register context, as the device holds it.
//
// PURE. No Supabase, no React, no storage and — deliberately — NO CLOCK
// AUTHORITY. Nothing here decides what day it is. The server does that, in
// ensure_daily_register_context(), using the project's own timezone; this
// module parses that answer, decides WHEN to ask again, and nothing more.
//
// THE RULE THIS FILE EXISTS FOR: a till may not date its own sales. Not from
// the browser's timezone, not from Android's, not from Windows's, not from UTC
// and not from a locale. A device clock is wrong often enough that letting it
// choose a business day would silently misfile money, and the one thing that
// cannot be repaired later is a sale on the wrong day. So the only thing the
// local clock is used for here is scheduling a question.
/**
 * The same pattern lib/saleRequest.ts and lib/buildJobs.ts use, declared here
 * for the same reason they declare it: a shared "utils" module for one regex
 * would couple three unrelated contracts together.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * A business day, for this till, as the server established it.
 *
 * Every field is the server's answer, kept for display and for freshness
 * scheduling. NONE of it is authority: `businessDate` is never used to decide
 * anything, and `closedAt` only ever suggests when to ask again.
 */
export type DailyRegisterContext = {
  registerSessionId: string;
  /** The server's business date, YYYY-MM-DD. Shown, never computed from. */
  businessDate: string;
  /** The immutable snapshot the interval was built from. */
  businessTimezone: string;
  openedAt: string;
  /**
   * When this business day ends, or null.
   *
   * Null means ADOPTED WITHOUT FULL CONTEXT: a completed sale told us the
   * server had rolled the till forward and gave us only the new id. The
   * expectation is correct and usable immediately; the rest of the context has
   * not been fetched yet, and the scheduler treats null as "ask again soon".
   */
  closedAt: string | null;
};

export type DailyEnsureFailure =
  | "not_authenticated"
  | "not_paired"
  | "business_timezone_required"
  | "daily_register_timezone_conflict"
  | "unavailable";

export type DailyEnsureResult =
  | { ok: true; context: DailyRegisterContext }
  | { ok: false; error: DailyEnsureFailure };

const FAILURES: readonly DailyEnsureFailure[] = [
  "not_authenticated",
  "not_paired",
  "business_timezone_required",
  "daily_register_timezone_conflict",
  "unavailable",
];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Parses what ensure_daily_register_context() returned.
 *
 * STRICT ABOUT THE ID AND LENIENT ABOUT NOTHING ELSE THAT MATTERS. The id
 * becomes an expectation sent to complete_sale_v5, so a malformed one must not
 * reach it; a payload that cannot be read at all is `unavailable`, which the
 * caller treats as "ask again", not as "the server said no".
 */
export function parseDailyEnsureResponse(value: unknown): DailyEnsureResult {
  if (!value || typeof value !== "object") {
    return { ok: false, error: "unavailable" };
  }

  const payload = value as Record<string, unknown>;

  if (payload.ok === false) {
    const error = payload.error;

    return {
      ok: false,
      error: FAILURES.includes(error as DailyEnsureFailure)
        ? (error as DailyEnsureFailure)
        : "unavailable",
    };
  }

  if (payload.ok !== true) {
    return { ok: false, error: "unavailable" };
  }

  const session = payload.registerSession;

  if (!session || typeof session !== "object") {
    return { ok: false, error: "unavailable" };
  }

  const row = session as Record<string, unknown>;

  if (
    !isUuid(row.registerSessionId) ||
    !isNonEmptyString(row.businessDate) ||
    !isNonEmptyString(row.businessTimezone) ||
    !isNonEmptyString(row.openedAt) ||
    !isNonEmptyString(row.closedAt)
  ) {
    return { ok: false, error: "unavailable" };
  }

  return {
    ok: true,
    context: {
      registerSessionId: row.registerSessionId,
      businessDate: row.businessDate,
      businessTimezone: row.businessTimezone,
      openedAt: row.openedAt,
      closedAt: row.closedAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Freshness scheduling
// ---------------------------------------------------------------------------

/**
 * How long to wait before asking the server for the current context again.
 *
 * THE TIMER IS FRESHNESS, NOT CORRECTNESS. CP2c rolls a sale forward at the
 * moment of sale whatever this till believes, so a timer that fires late,
 * early, or never cannot misfile money — it can only leave the till holding a
 * yesterday id that the next sale corrects. Android suspends, Windows sleeps,
 * JS timers drift and device clocks are wrong; none of that is allowed to
 * matter, and this function is written on the assumption that all of it will
 * happen.
 *
 * THE BACKOFF IS WHY IT CANNOT BUSY-LOOP. When `closedAt` has already passed
 * by the device's own reckoning — an early timer, a fast clock, or a context
 * adopted without one — the answer is not "ask immediately, forever". Each
 * consecutive refresh that returns the SAME context waits longer, so a till
 * whose clock is a day fast settles down instead of hammering the server.
 */
export const DAILY_REFRESH_GRACE_MS = 5_000;
export const DAILY_REFRESH_BACKOFF_MS: readonly number[] = [
  60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000,
];
export const DAILY_REFRESH_MAX_MS = 6 * 60 * 60_000;

export function nextDailyRefreshDelayMs(input: {
  /** The context's closedAt in epoch ms, or null when it has none. */
  closedAtMs: number | null;
  nowMs: number;
  /** Refreshes so far that came back with the same context id. */
  consecutiveUnchanged: number;
}): number {
  const backoff =
    DAILY_REFRESH_BACKOFF_MS[
      Math.min(Math.max(input.consecutiveUnchanged, 0), DAILY_REFRESH_BACKOFF_MS.length - 1)
    ];

  if (input.closedAtMs === null || !Number.isFinite(input.closedAtMs)) {
    return backoff;
  }

  const untilEnd = input.closedAtMs + DAILY_REFRESH_GRACE_MS - input.nowMs;

  // The day has not ended by this device's clock: wake just after it should,
  // but never sleep so long that a suspended app comes back hours stale.
  if (untilEnd > 0) {
    return Math.min(untilEnd, DAILY_REFRESH_MAX_MS);
  }

  // It has ended, and the server is still handing back the same context. Either
  // this clock is ahead or the server disagrees; either way, wait longer.
  return backoff;
}

/** Epoch ms for a server timestamp, or null when it cannot be read. */
export function timestampMs(value: string | null): number | null {
  if (value === null) return null;

  const parsed = Date.parse(value);

  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Adopting what a completed sale reported
// ---------------------------------------------------------------------------

/**
 * Whether a completed sale's stored register id should replace what the till
 * was holding.
 *
 * WHY THIS IS SAFE, AND WHY IT IS ONLY EVER A FRESHNESS UPDATE. The server has
 * already completed the sale and stored this id against it, under the same
 * employee POS session the till sent. So it is not a claim the client is
 * making — it is what the server did. Adopting it means the NEXT sale arrives
 * with the current expectation instead of yesterday's, which is a round trip
 * saved and nothing more: refusing to adopt would still be correct, because
 * CP2c would roll the next sale forward too.
 *
 * It is never adopted when it matches, and never when it is not a uuid.
 */
export function shouldAdoptSaleRegisterId(
  retained: DailyRegisterContext | null,
  returned: unknown
): returned is string {
  if (!isUuid(returned)) return false;

  return retained === null || retained.registerSessionId !== returned;
}

/**
 * The context to hold after adopting a sale's register id.
 *
 * closedAt becomes null on purpose: the id is authoritative, the calendar
 * around it was not returned, and pretending yesterday's end time still
 * applies would schedule the next refresh against a day that has already
 * finished. Null makes the scheduler ask again soon and reconcile properly.
 */
export function adoptSaleRegisterId(
  retained: DailyRegisterContext | null,
  registerSessionId: string
): DailyRegisterContext {
  return {
    registerSessionId,
    businessDate: retained?.businessDate ?? "",
    businessTimezone: retained?.businessTimezone ?? "",
    openedAt: retained?.openedAt ?? "",
    closedAt: null,
  };
}
