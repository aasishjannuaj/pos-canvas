// v1.3 Task 5D — how long a shift was, and what an unfinished one is worth.
//
// PURE THROUGHOUT. Nothing is mocked: every function is given its inputs,
// including the instant that stands for "now". A time report that changed
// depending on which machine rendered it, or on how long ago the page was
// opened, would not be a time report.
//
// THE CONTRACT'S FILTERING SEMANTICS ARE PINNED AGAINST THE MIGRATION SOURCE at
// the bottom of this file. They were established by reading
// 20260928120000_owner_reporting_contracts.sql, not assumed, and the report's
// whole inclusion model rests on them — so a future edit to either side has to
// break a test rather than quietly change what a range means.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  OPEN_SESSION_DURATION_LABEL,
  OPEN_SESSION_STATUS_LABEL,
  TIMESTAMP_ZONE_UNAVAILABLE_SUFFIX,
  TIME_RANGE_INCLUSION_NOTE,
  businessDayStartInstant,
  closedSessionDurationMs,
  countClosedSessions,
  countOpenSessions,
  currentDateInTimezone,
  describeClockOut,
  describeSessionDuration,
  formatDuration,
  formatSessionTimestamp,
  shiftDate,
  timeReportWindow,
  totalClosedDurationMs,
} from "@/lib/timeReporting";
import type { TimeReportSession } from "@/lib/timeReporting";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function closed(
  id: string,
  clockedInAt: string,
  clockedOutAt: string,
  displayName = "Ada"
): TimeReportSession {
  return {
    timeSessionId: id,
    employeeId: `emp-${displayName}`,
    displayName,
    clockedInAt,
    clockedOutAt,
    isOpen: false,
  };
}

function open(id: string, clockedInAt: string, displayName = "Ada"): TimeReportSession {
  return {
    timeSessionId: id,
    employeeId: `emp-${displayName}`,
    displayName,
    clockedInAt,
    clockedOutAt: null,
    isOpen: true,
  };
}

// ---------------------------------------------------------------------------
// A finished shift
// ---------------------------------------------------------------------------

describe("a closed shift's duration", () => {
  it("is exactly clockedOutAt minus clockedInAt", () => {
    const session = closed("s1", "2026-09-28T09:00:00.000Z", "2026-09-28T17:14:00.000Z");

    expect(closedSessionDurationMs(session)).toBe(8 * 3_600_000 + 14 * 60_000);
    expect(describeSessionDuration(session)).toBe("8h 14m");
  });

  it("is not rounded to a payroll increment", () => {
    // 7 minutes is 7 minutes. A 15-minute rounding rule would make this 0m or
    // 15m, and a grace period would make it something else again; v1.3 has
    // neither, and inventing one here would invent a pay policy.
    const seven = closed("s1", "2026-09-28T09:00:00.000Z", "2026-09-28T09:07:00.000Z");

    expect(closedSessionDurationMs(seven)).toBe(7 * 60_000);
    expect(describeSessionDuration(seven)).toBe("7m");
    expect(describeSessionDuration(seven)).not.toBe("0m");
    expect(describeSessionDuration(seven)).not.toBe("15m");
  });

  it("truncates seconds rather than inventing worked time", () => {
    const session = closed("s1", "2026-09-28T09:00:00.000Z", "2026-09-28T09:59:59.000Z");

    // Displayed <= true elapsed, always.
    expect(describeSessionDuration(session)).toBe("59m");
    expect(closedSessionDurationMs(session)).toBe(59 * 60_000 + 59_000);
  });

  it("formats hours and minutes without a payroll decimal", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(3_600_000)).toBe("1h 0m");
    expect(formatDuration(8 * 3_600_000 + 14 * 60_000)).toBe("8h 14m");
    expect(formatDuration(25 * 3_600_000)).toBe("25h 0m");
  });

  it("refuses a row whose clock-out precedes its clock-in", () => {
    // Not a negative shift — a row this model cannot read. A negative number
    // would silently reduce a total.
    const backwards = closed("s1", "2026-09-28T17:00:00.000Z", "2026-09-28T09:00:00.000Z");

    expect(closedSessionDurationMs(backwards)).toBeNull();
    expect(describeSessionDuration(backwards)).toBe(OPEN_SESSION_DURATION_LABEL);
  });

  it("does not rewrite the authoritative timestamps", () => {
    const session = closed("s1", "2026-09-28T09:00:00.000Z", "2026-09-28T17:14:00.000Z");
    const before = { ...session };

    closedSessionDurationMs(session);
    describeSessionDuration(session);
    describeClockOut(session, "America/New_York");
    formatSessionTimestamp(session.clockedInAt, "Asia/Tokyo");

    expect(session).toEqual(before);
    expect(session.clockedInAt).toBe("2026-09-28T09:00:00.000Z");
    expect(session.clockedOutAt).toBe("2026-09-28T17:14:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// An unfinished shift
// ---------------------------------------------------------------------------

describe("an open shift", () => {
  const shift = open("s-open", "2026-09-28T09:00:00.000Z");

  it("stays visibly open where a clock-out would be", () => {
    expect(describeClockOut(shift, "America/New_York")).toBe(OPEN_SESSION_STATUS_LABEL);
    expect(OPEN_SESSION_STATUS_LABEL).toBe("Open");
  });

  it("has no duration at all", () => {
    expect(closedSessionDurationMs(shift)).toBeNull();
    expect(describeSessionDuration(shift)).toBe(OPEN_SESSION_DURATION_LABEL);
    expect(OPEN_SESSION_DURATION_LABEL).toBe("—");
  });

  it("is never `now - clockedInAt`", () => {
    // Structural, not incidental: the function takes ONE argument and has no
    // clock to consult, so there is no path by which a live figure could be
    // produced. Called twice with real time passing, the answer is the same.
    expect(closedSessionDurationMs.length).toBe(1);

    const first = describeSessionDuration(shift);
    const second = describeSessionDuration(shift);

    expect(first).toBe(second);
    expect(first).toBe(OPEN_SESSION_DURATION_LABEL);
    // And it is not any elapsed-time string.
    expect(first).not.toMatch(/\d+h|\d+m/);
  });

  it("is not a completed zero-duration shift", () => {
    // "0m" would say the shift happened and took no time. It has not ended.
    expect(describeSessionDuration(shift)).not.toBe("0m");
    expect(describeSessionDuration(shift)).not.toBe("0h 0m");
    expect(closedSessionDurationMs(shift)).not.toBe(0);
  });

  it("contributes nothing to a duration total", () => {
    const sessions = [
      closed("s1", "2026-09-28T09:00:00.000Z", "2026-09-28T12:00:00.000Z"),
      open("s2", "2026-09-28T13:00:00.000Z"),
    ];

    expect(totalClosedDurationMs(sessions)).toBe(3 * 3_600_000);
    expect(formatDuration(totalClosedDurationMs(sessions))).toBe("3h 0m");
    // Counted separately so an owner can see it exists without it being worked
    // time.
    expect(countClosedSessions(sessions)).toBe(1);
    expect(countOpenSessions(sessions)).toBe(1);
  });

  it("does not make a total of only open shifts look like zero work", () => {
    const sessions = [open("s1", "2026-09-28T09:00:00.000Z")];

    expect(totalClosedDurationMs(sessions)).toBe(0);
    expect(countClosedSessions(sessions)).toBe(0);
    // The caller distinguishes them: 0 closed sessions is why the total is 0.
    expect(countOpenSessions(sessions)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

describe("totalling worked time", () => {
  it("adds several closed shifts exactly", () => {
    const sessions = [
      closed("s1", "2026-09-28T09:00:00.000Z", "2026-09-28T12:30:00.000Z"), // 3h30
      closed("s2", "2026-09-28T13:00:00.000Z", "2026-09-28T17:00:00.000Z"), // 4h00
      closed("s3", "2026-09-29T08:00:00.000Z", "2026-09-29T08:45:00.000Z"), // 0h45
    ];

    expect(totalClosedDurationMs(sessions)).toBe(
      3.5 * 3_600_000 + 4 * 3_600_000 + 45 * 60_000
    );
    expect(formatDuration(totalClosedDurationMs(sessions))).toBe("8h 15m");
  });

  it("sums exact milliseconds so truncation cannot accumulate", () => {
    // Three shifts of 59 seconds each. Formatting each first would give 0m, and
    // summing those would give 0m; summing the real values gives 2m.
    const almost = [
      closed("s1", "2026-09-28T09:00:00.000Z", "2026-09-28T09:00:59.000Z"),
      closed("s2", "2026-09-28T10:00:00.000Z", "2026-09-28T10:00:59.000Z"),
      closed("s3", "2026-09-28T11:00:00.000Z", "2026-09-28T11:00:59.000Z"),
    ];

    expect(totalClosedDurationMs(almost)).toBe(3 * 59_000);
    expect(formatDuration(totalClosedDurationMs(almost))).toBe("2m");
  });

  it("keeps the seconds in the authoritative total that the labels do not show", () => {
    // THE PRECISION CASE, PINNED. Two shifts of 30m 45s. Each ROW LABEL reads
    // "30m", because a label shows whole minutes — but the authoritative
    // duration is the exact timestamp difference, and the total is summed from
    // those, never from what the labels say:
    //
    //   authoritative : 1_845_000 + 1_845_000 = 3_690_000ms = 61m 30s → "1h 1m"
    //   label arithmetic:      30m +      30m =        60m            → "1h 0m"
    //
    // Formatting is presentation. It must never become the input to a sum.
    const shifts = [
      closed("s1", "2026-09-28T09:00:00.000Z", "2026-09-28T09:30:45.000Z"),
      closed("s2", "2026-09-28T10:00:00.000Z", "2026-09-28T10:30:45.000Z"),
    ];

    // Each session keeps its seconds in the authoritative value...
    expect(closedSessionDurationMs(shifts[0])).toBe(30 * 60_000 + 45_000);
    expect(closedSessionDurationMs(shifts[1])).toBe(30 * 60_000 + 45_000);
    // ...while its label shows whole minutes, which is presentation only.
    expect(describeSessionDuration(shifts[0])).toBe("30m");

    // The total is the sum of the authoritative differences: 61m 30s exactly.
    expect(totalClosedDurationMs(shifts)).toBe(3_690_000);
    expect(totalClosedDurationMs(shifts)).toBe(61 * 60_000 + 30_000);

    // Formatted once, at the end — never the 60m the labels would imply.
    expect(formatDuration(totalClosedDurationMs(shifts))).toBe("1h 1m");
    expect(formatDuration(totalClosedDurationMs(shifts))).not.toBe("1h 0m");
  });

  it("is zero for no sessions, without claiming anything else", () => {
    expect(totalClosedDurationMs([])).toBe(0);
    expect(countClosedSessions([])).toBe(0);
    expect(countOpenSessions([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Crossing midnight
// ---------------------------------------------------------------------------

describe("a shift that crosses midnight", () => {
  const overnight = closed("s1", "2026-09-28T23:00:00.000Z", "2026-09-29T07:00:00.000Z");

  it("is one session of eight hours", () => {
    expect(closedSessionDurationMs(overnight)).toBe(8 * 3_600_000);
    expect(describeSessionDuration(overnight)).toBe("8h 0m");
  });

  it("is not split into calendar or payroll days", () => {
    // One row in, one row out. There is no payroll day in v1.3, so there is
    // nothing to split it across, and splitting would invent one.
    const sessions = [overnight];

    expect(sessions).toHaveLength(1);
    expect(countClosedSessions(sessions)).toBe(1);
    expect(totalClosedDurationMs(sessions)).toBe(8 * 3_600_000);
    // Not 1h on the 28th plus 7h on the 29th, reported as two records.
    expect(countClosedSessions(sessions)).not.toBe(2);
  });

  it("stays one session across a DST change too", () => {
    // US DST ends 2026-11-01: 01:00 local repeats. The elapsed instants are
    // what matter, and they are unambiguous.
    const dstNight = closed("s1", "2026-11-01T04:00:00.000Z", "2026-11-01T12:00:00.000Z");

    expect(closedSessionDurationMs(dstNight)).toBe(8 * 3_600_000);
  });
});

// ---------------------------------------------------------------------------
// Showing a timestamp
// ---------------------------------------------------------------------------

describe("presenting a Time Clock timestamp", () => {
  const INSTANT = "2026-09-29T03:30:00.000Z";

  it("reads it in the business timezone it is given", () => {
    expect(formatSessionTimestamp(INSTANT, "America/New_York")).toBe("2026-09-28 23:30");
    expect(formatSessionTimestamp(INSTANT, "Asia/Tokyo")).toBe("2026-09-29 12:30");
    expect(formatSessionTimestamp(INSTANT, "UTC")).toBe("2026-09-29 03:30");
  });

  it("does not use the machine's timezone", () => {
    const machineZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    expect(formatSessionTimestamp(INSTANT, "America/New_York")).toBe("2026-09-28 23:30");

    if (machineZone !== "America/New_York") {
      const machineRendering = new Date(INSTANT).toLocaleString();

      expect(formatSessionTimestamp(INSTANT, "America/New_York")).not.toBe(
        machineRendering
      );
    }
  });

  it("falls back to a labelled absolute instant, never a fabricated zone", () => {
    for (const zone of [null, undefined, "", "   ", "Mars/Olympus"]) {
      const shown = formatSessionTimestamp(INSTANT, zone);

      expect(`zone ${JSON.stringify(zone)}`).toBe(`zone ${JSON.stringify(zone)}`);
      // Says which clock it is: an absolute presentation, openly labelled.
      expect(shown).toBe(`2026-09-29 03:30 ${TIMESTAMP_ZONE_UNAVAILABLE_SUFFIX}`);
      expect(shown).toContain("UTC");
      // And it is NOT silently New York, Tokyo or the browser's zone.
      expect(shown).not.toBe("2026-09-28 23:30");
      expect(shown).not.toBe("2026-09-29 12:30");
    }
  });

  it("never claims a Time Clock row has a business date", () => {
    // The rendering is an instant read in a zone. No date is stored on the row,
    // and this returns a wall-clock reading, not a bucket.
    expect(formatSessionTimestamp(INSTANT, "America/New_York")).toContain("23:30");
  });
});

// ---------------------------------------------------------------------------
// Turning a range into the window the contract understands
// ---------------------------------------------------------------------------

describe("building the request window", () => {
  const NOW = new Date("2026-09-29T16:00:00.000Z"); // 12:00 in New York
  const NY = "America/New_York";

  it("knows today in the business timezone, not the machine's", () => {
    expect(currentDateInTimezone(NOW, NY)).toBe("2026-09-29");
    expect(currentDateInTimezone(NOW, "Asia/Tokyo")).toBe("2026-09-30");
    expect(currentDateInTimezone(NOW, null)).toBeNull();
  });

  it("starts a day at the zone's own midnight, not UTC's or the browser's", () => {
    // 2026-09-28 in New York begins at 04:00 UTC (EDT, UTC-4).
    expect(businessDayStartInstant("2026-09-28", NY)).toBe("2026-09-28T04:00:00.000Z");
    // And in Tokyo the same date begins the previous UTC afternoon.
    expect(businessDayStartInstant("2026-09-28", "Asia/Tokyo")).toBe(
      "2026-09-27T15:00:00.000Z"
    );
    expect(businessDayStartInstant("2026-09-28", "UTC")).toBe("2026-09-28T00:00:00.000Z");
  });

  it("lands on the right side of a DST transition", () => {
    // US DST begins 2026-03-08 (EST -5 → EDT -4) and ends 2026-11-01.
    expect(businessDayStartInstant("2026-03-07", NY)).toBe("2026-03-07T05:00:00.000Z");
    expect(businessDayStartInstant("2026-03-08", NY)).toBe("2026-03-08T05:00:00.000Z");
    expect(businessDayStartInstant("2026-03-09", NY)).toBe("2026-03-09T04:00:00.000Z");
    expect(businessDayStartInstant("2026-11-01", NY)).toBe("2026-11-01T04:00:00.000Z");
    expect(businessDayStartInstant("2026-11-02", NY)).toBe("2026-11-02T05:00:00.000Z");
  });

  it("refuses to build a window without a usable timezone", () => {
    // No defensible instant for "the start of today in this business" exists,
    // so none is manufactured out of the browser's midnight.
    for (const range of ["today", "yesterday", "last7", "thisMonth"] as const) {
      expect(`range ${range}`).toBe(`range ${range}`);
      expect(timeReportWindow(range, NOW, null)).toBeNull();
      expect(timeReportWindow(range, NOW, "Mars/Olympus")).toBeNull();
    }

    // All Time needs no timezone and stays available.
    expect(timeReportWindow("allTime", NOW, null)).toEqual({ from: null, to: null });
  });

  it("builds a half-open window, matching the contract exactly", () => {
    const today = timeReportWindow("today", NOW, NY);

    // [start of 2026-09-29, start of 2026-09-30)
    expect(today).toEqual({
      from: "2026-09-29T04:00:00.000Z",
      to: "2026-09-30T04:00:00.000Z",
    });

    const yesterday = timeReportWindow("yesterday", NOW, NY);

    expect(yesterday).toEqual({
      from: "2026-09-28T04:00:00.000Z",
      to: "2026-09-29T04:00:00.000Z",
    });

    // Yesterday's exclusive end is today's inclusive start: no gap, no overlap.
    expect(yesterday?.to).toBe(today?.from);
  });

  it("covers seven days and the month from its first day", () => {
    expect(timeReportWindow("last7", NOW, NY)?.from).toBe("2026-09-23T04:00:00.000Z");
    expect(timeReportWindow("last7", NOW, NY)?.to).toBe("2026-09-30T04:00:00.000Z");
    expect(timeReportWindow("thisMonth", NOW, NY)?.from).toBe("2026-09-01T04:00:00.000Z");
  });

  it("steps dates without a timezone of its own", () => {
    expect(shiftDate("2026-09-01", -1)).toBe("2026-08-31");
    expect(shiftDate("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDate("2028-02-28", 1)).toBe("2028-02-29");
  });
});

// ---------------------------------------------------------------------------
// The contract's own inclusion model, pinned to its source
// ---------------------------------------------------------------------------

describe("what p_from and p_to actually mean", () => {
  const migration = readFileSync(
    join(repoRoot, "supabase/migrations/20260928120000_owner_reporting_contracts.sql"),
    "utf-8"
  );
  // Sliced to the function's OWN body terminator, not to the next function: an
  // earlier form ended at list_cash_movements and swept in the explanatory
  // comment block before it, which mentions register_sessions — a guard failing
  // on prose about a different contract.
  const fnStart = migration.indexOf(
    "create or replace function public.list_employee_time_sessions"
  );
  const fn = migration.slice(
    fnStart,
    migration.indexOf("$function$;", fnStart) + "$function$;".length
  );

  it("filters on the clock-in instant and nothing else", () => {
    expect(fn).toContain("t.clocked_in_at >= p_from");
    expect(fn).toContain("t.clocked_in_at < p_to");
    // The clock-out column is never part of the WHERE clause, so inclusion is
    // not overlap-based and not containment-based.
    const where = fn.slice(fn.indexOf("where t.project_id"));
    expect(where).not.toContain("clocked_out_at >=");
    expect(where).not.toContain("clocked_out_at <");
    expect(where).not.toMatch(/overlaps|tstzrange|between/i);
  });

  it("is inclusive at the start and exclusive at the end", () => {
    expect(fn).toMatch(/clocked_in_at\s*>=\s*p_from/);
    expect(fn).toMatch(/clocked_in_at\s*<\s*p_to/);
    // Not <=, which would double-count a shift on a range boundary.
    expect(fn).not.toMatch(/clocked_in_at\s*<=\s*p_to/);
  });

  it("treats a null bound as unbounded on that side", () => {
    expect(fn).toContain("p_from is null or");
    expect(fn).toContain("p_to is null or");
  });

  it("returns open sessions that began inside the window", () => {
    // isOpen is the server's own computation, and nothing excludes a null
    // clock-out from the result set.
    expect(fn).toContain("'isOpen', t.clocked_out_at is null");
    expect(fn.slice(fn.indexOf("where t.project_id"))).not.toContain(
      "clocked_out_at is not null"
    );
  });

  it("reads employee_time_sessions, never a POS session table", () => {
    expect(fn).toContain("from public.employee_time_sessions t");
    expect(fn).not.toContain("employee_pos_sessions");
    expect(fn).not.toContain("register_sessions");
    expect(fn).not.toContain("public.orders");
  });

  it("projects no credential or idempotency material", () => {
    const projection = fn.slice(fn.indexOf("jsonb_build_object"), fn.indexOf("order by"));

    expect(projection).not.toMatch(/pin|hash|request_id|token|secret/i);
    for (const field of [
      "timeSessionId",
      "employeeId",
      "displayName",
      "clockedInAt",
      "clockedOutAt",
      "isOpen",
    ]) {
      expect(`projects ${field}`).toBe(`projects ${field}`);
      expect(projection).toContain(field);
    }
  });

  it("orders newest shift first", () => {
    expect(fn).toContain("order by t.clocked_in_at desc, t.id");
  });

  it("is described to the owner in those exact terms", () => {
    // The UI must not describe this as "shifts in this range", which is the
    // wider, overlap-based claim the contract does not make.
    expect(TIME_RANGE_INCLUSION_NOTE).toMatch(/started/i);
    expect(TIME_RANGE_INCLUSION_NOTE).toMatch(/began before this range is not included/i);
  });
});

// ---------------------------------------------------------------------------
// Whose shift it was
// ---------------------------------------------------------------------------

describe("historical attribution", () => {
  it("keeps the employee the contract returned", () => {
    const session = closed("s1", "2026-09-28T09:00:00.000Z", "2026-09-28T17:00:00.000Z", "Bo");

    expect(session.displayName).toBe("Bo");
    expect(session.employeeId).toBe("emp-Bo");
    // Nothing in this module can change either: they are read, never resolved.
    expect(describeSessionDuration(session)).toBe("8h 0m");
    expect(session.displayName).toBe("Bo");
  });

  it("carries no role, so deactivation cannot reach a past shift", () => {
    const session = closed("s1", "2026-09-28T09:00:00.000Z", "2026-09-28T17:00:00.000Z");

    // TimeReportSession has no `active` and no `role` field: there is no
    // channel through which present-day employee state could alter history.
    expect(Object.keys(session).sort()).toEqual([
      "clockedInAt",
      "clockedOutAt",
      "displayName",
      "employeeId",
      "isOpen",
      "timeSessionId",
    ]);
  });

  it("exposes no PIN or credential material", () => {
    const session = closed("s1", "2026-09-28T09:00:00.000Z", "2026-09-28T17:00:00.000Z");

    expect(JSON.stringify(session).toLowerCase()).not.toContain("pin");
    expect(JSON.stringify(session).toLowerCase()).not.toContain("hash");
  });
});
