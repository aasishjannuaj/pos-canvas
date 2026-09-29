// v1.3 Task 5D — Employee Time Reports, as a pure model.
//
// PURE. No Supabase, no React, no storage, and no ambient clock or timezone.
// `now` and the business timezone are always passed in, so a time report reads
// the same on every machine.
//
// THE ONLY TIME CLOCK AUTHORITY IS `employee_time_sessions`, read through
// list_employee_time_sessions. Nothing here consults employee_pos_sessions,
// register_sessions, orders, sale attribution or cash movements. A POS session
// answers "who is signed in at this till" and a register session answers "which
// drawer period is open"; neither is worked time, and combining them with the
// Time Clock would produce a number that is not any real quantity.
//
// WHAT A SHIFT'S DURATION IS, AND THE THREE THINGS IT IS NOT. For a CLOSED
// session it is exactly `clockedOutAt - clockedInAt` from the authoritative
// timestamps. It is not rounded to a payroll increment, not adjusted by a grace
// period, and not reconstructed from anything else. For an OPEN session there
// is NO duration: not `now - clockedInAt` (that is a claim about a shift that
// has not ended, and it changes every time you look), and not zero (that is a
// claim it was worked and took no time). Open is open.
//
// ONE SESSION STAYS ONE SESSION. A shift from 23:00 to 07:00 crosses midnight
// and is a single eight-hour record. v1.3 has no payroll day, no pay period and
// no splitting rule, so inventing one here would invent an accounting model the
// product does not have.

/** What an open shift shows where a clock-out time would go. */
export const OPEN_SESSION_STATUS_LABEL = "Open";

/** What an open shift shows where a duration would go. Never "0h 0m". */
export const OPEN_SESSION_DURATION_LABEL = "—";

/** Shown when a timestamp cannot be placed in a business timezone. */
export const TIMESTAMP_ZONE_UNAVAILABLE_SUFFIX = "UTC";

/**
 * The subset of a Time Clock row this model needs.
 *
 * A structural subset of lib/ownerReporting's TimeSessionRow, consumed from the
 * accepted contract rather than copied into a second time model. Note what is
 * absent and must stay absent: no PIN, no hash, no request or idempotency id,
 * no credential of any kind — the contract projects none of them.
 */
export type TimeReportSession = {
  timeSessionId: string;
  employeeId: string;
  displayName: string;
  clockedInAt: string;
  clockedOutAt: string | null;
  isOpen: boolean;
};

// ---------------------------------------------------------------------------
// Duration
// ---------------------------------------------------------------------------

/**
 * A closed shift's length in milliseconds, or null when there is not one.
 *
 * NULL FOR AN OPEN SHIFT, and null for a row whose timestamps cannot be read or
 * run backwards. Every caller must then decide what to show, and none of them
 * may substitute a number: that is the whole point of returning null rather
 * than 0.
 */
export function closedSessionDurationMs(session: TimeReportSession): number | null {
  if (session.isOpen || session.clockedOutAt === null) return null;

  const start = new Date(session.clockedInAt).getTime();
  const end = new Date(session.clockedOutAt).getTime();

  if (Number.isNaN(start) || Number.isNaN(end)) return null;

  // A clock-out before its clock-in is not a negative shift; it is a row this
  // model cannot read, and a negative number would quietly reduce a total.
  return end < start ? null : end - start;
}

/**
 * Milliseconds as `8h 14m`.
 *
 * TRUNCATED, NEVER ROUNDED UP, and never to a payroll increment: minutes are
 * whole minutes of real elapsed time, so the displayed value is always <= the
 * true difference and never invents worked time. Totals are summed in exact
 * milliseconds and formatted once at the end, so truncation cannot accumulate.
 */
export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return OPEN_SESSION_DURATION_LABEL;

  const totalMinutes = Math.floor(durationMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes}m`;
}

/** What a row shows in its Duration column. */
export function describeSessionDuration(session: TimeReportSession): string {
  const durationMs = closedSessionDurationMs(session);

  return durationMs === null ? OPEN_SESSION_DURATION_LABEL : formatDuration(durationMs);
}

/** What a row shows in its Clocked Out column. */
export function describeClockOut(
  session: TimeReportSession,
  businessTimezone: string | null | undefined
): string {
  return session.clockedOutAt === null
    ? OPEN_SESSION_STATUS_LABEL
    : formatSessionTimestamp(session.clockedOutAt, businessTimezone);
}

/**
 * Total worked time across CLOSED sessions only.
 *
 * AN OPEN SHIFT CONTRIBUTES NOTHING, which is not the same as contributing
 * zero: it is excluded from the sum and reported separately, so a total is
 * never quietly understated by counting an unfinished shift as no work.
 * Summed in exact milliseconds; formatting happens once, afterwards.
 */
export function totalClosedDurationMs(sessions: readonly TimeReportSession[]): number {
  let total = 0;

  for (const session of sessions) {
    const durationMs = closedSessionDurationMs(session);

    if (durationMs !== null) total += durationMs;
  }

  return total;
}

export function countClosedSessions(sessions: readonly TimeReportSession[]): number {
  return sessions.filter((session) => closedSessionDurationMs(session) !== null).length;
}

export function countOpenSessions(sessions: readonly TimeReportSession[]): number {
  return sessions.filter((session) => session.isOpen).length;
}

// ---------------------------------------------------------------------------
// Presenting an instant
// ---------------------------------------------------------------------------

function zoneParts(
  instant: Date,
  timeZone: string
): Record<string, string> | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(instant);

    const found: Record<string, string> = {};

    for (const part of parts) found[part.type] = part.value;

    return found.year && found.month && found.day && found.hour && found.minute
      ? found
      : null;
  } catch {
    // An invalid IANA identifier throws. Not repaired, not replaced.
    return null;
  }
}

/**
 * A Time Clock timestamp, shown in the project's business timezone.
 *
 * THE STORED VALUE IS NOT REWRITTEN. `clocked_in_at` is an absolute instant;
 * this only chooses the wall clock it is read against, and the row keeps
 * exactly the timestamptz the Time Clock recorded. A Time Clock row stores no
 * business date, and nothing here pretends it does.
 *
 * WHEN THERE IS NO USABLE BUSINESS TIMEZONE the instant is shown in UTC and
 * SAID to be UTC. That is a truthful absolute presentation, not a fabricated
 * business timezone: the reader can see which clock they are being shown, and
 * nothing silently substitutes the browser's zone, the device's, a locale, a
 * location or a plausible-looking default.
 */
export function formatSessionTimestamp(
  isoInstant: string,
  timeZone: string | null | undefined
): string {
  const instant = new Date(isoInstant);

  if (Number.isNaN(instant.getTime())) return isoInstant;

  const zone =
    typeof timeZone === "string" && timeZone.trim() !== "" ? timeZone : null;
  const parts = zone === null ? null : zoneParts(instant, zone);

  if (parts === null) {
    const utc = zoneParts(instant, "UTC");

    if (utc === null) return isoInstant;

    return `${utc.year}-${utc.month}-${utc.day} ${utc.hour}:${utc.minute} ${TIMESTAMP_ZONE_UNAVAILABLE_SUFFIX}`;
  }

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

// ---------------------------------------------------------------------------
// The window the contract actually understands
// ---------------------------------------------------------------------------

/**
 * A window for list_employee_time_sessions: ISO instants, or null for open.
 *
 * Structural rather than imported so this module stays free of the RPC layer.
 */
export type TimeReportWindow = { from: string | null; to: string | null };

export const UNBOUNDED_TIME_WINDOW: TimeReportWindow = { from: null, to: null };

export type TimeReportRange = "today" | "yesterday" | "last7" | "thisMonth" | "allTime";

export const TIME_RANGE_OPTIONS: { value: TimeReportRange; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last7", label: "Last 7 Days" },
  { value: "thisMonth", label: "This Month" },
  { value: "allTime", label: "All Time" },
];

/**
 * WHAT A RANGE MEANS HERE, READ OFF THE CONTRACT AND NOT CHOSEN BY THIS CODE.
 *
 * list_employee_time_sessions filters on ONE column:
 *
 *     and (p_from is null or t.clocked_in_at >= p_from)
 *     and (p_to   is null or t.clocked_in_at <  p_to)
 *
 * So inclusion is decided by the CLOCK-IN instant alone, on a half-open
 * interval [from, to). It is not overlap, not containment, and the clock-out
 * time is never consulted. A shift that began before the window and ended
 * inside it is NOT returned; a shift that began inside it and is still open IS
 * returned. The UI says "started in this range" for exactly this reason —
 * describing it as "shifts in this range" would be a different, wider claim
 * than the contract makes.
 */
export const TIME_RANGE_INCLUSION_NOTE =
  "Shifts are listed by when they started. A shift that began before this range is not included, even if it ended inside it.";

/** The UTC offset of a zone at an instant, in milliseconds. */
function zoneOffsetMs(instant: Date, timeZone: string): number | null {
  const parts = zoneParts(instant, timeZone);

  if (parts === null) return null;

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) === 24 ? 0 : Number(parts.hour),
    Number(parts.minute)
  );

  // The wall clock in the zone, minus the true instant, is the offset. Minutes
  // resolution is enough: no IANA zone has a sub-minute offset.
  return asUtc - Math.floor(instant.getTime() / 60_000) * 60_000;
}

/**
 * The absolute instant at which a calendar date BEGINS in a timezone.
 *
 * NOT browser-local midnight. `new Date("2026-09-28")` is parsed as UTC and
 * `new Date(2026, 8, 28)` is parsed in the machine's zone; neither is the
 * moment the business day started in the shop. The offset is resolved at the
 * candidate instant and then re-resolved, so a date on which the offset changes
 * (a DST transition) lands on the correct side of it.
 *
 * Returns null for an unusable zone or a malformed date, so a caller cannot
 * build a window out of a guess.
 */
export function businessDayStartInstant(
  businessDate: string,
  timeZone: string | null | undefined
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) return null;
  if (typeof timeZone !== "string" || timeZone.trim() === "") return null;

  const midnightUtc = new Date(`${businessDate}T00:00:00.000Z`);

  if (Number.isNaN(midnightUtc.getTime())) return null;

  const firstOffset = zoneOffsetMs(midnightUtc, timeZone);

  if (firstOffset === null) return null;

  let candidate = new Date(midnightUtc.getTime() - firstOffset);
  const secondOffset = zoneOffsetMs(candidate, timeZone);

  if (secondOffset === null) return null;

  if (secondOffset !== firstOffset) {
    candidate = new Date(midnightUtc.getTime() - secondOffset);
  }

  return candidate.toISOString();
}

/** Shift a `YYYY-MM-DD` by whole days, with no timezone of its own. */
export function shiftDate(date: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;

  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));

  return [
    String(shifted.getUTCFullYear()).padStart(4, "0"),
    String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    String(shifted.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/** Today's calendar date in a timezone, or null when it cannot be known. */
export function currentDateInTimezone(
  now: Date,
  timeZone: string | null | undefined
): string | null {
  if (typeof timeZone !== "string" || timeZone.trim() === "") return null;

  const parts = zoneParts(now, timeZone);

  return parts === null ? null : `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Turn an owner's range choice into the half-open instant window the contract
 * takes, or null when it cannot be built honestly.
 *
 * NULL MEANS "DO NOT ASK FOR A RANGE". Without a valid business timezone there
 * is no defensible instant for "the start of today" in this business, and this
 * function refuses to manufacture one out of the browser's midnight. The caller
 * then offers All Time only, and says why.
 */
export function timeReportWindow(
  range: TimeReportRange,
  now: Date,
  businessTimezone: string | null | undefined
): TimeReportWindow | null {
  if (range === "allTime") return UNBOUNDED_TIME_WINDOW;

  const today = currentDateInTimezone(now, businessTimezone);

  if (today === null) return null;

  const startDate =
    range === "today"
      ? today
      : range === "yesterday"
        ? shiftDate(today, -1)
        : range === "last7"
          ? shiftDate(today, -6)
          : `${today.slice(0, 7)}-01`;

  // Exclusive end, matching the contract's `clocked_in_at < p_to`: the instant
  // the day AFTER the last included day begins.
  const endDate = range === "yesterday" ? today : shiftDate(today, 1);

  const from = businessDayStartInstant(startDate, businessTimezone);
  const to = businessDayStartInstant(endDate, businessTimezone);

  return from === null || to === null ? null : { from, to };
}
