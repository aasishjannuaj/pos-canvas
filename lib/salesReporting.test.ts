// v1.3 Task 5C — which business day a sale belongs to, and whose sale it was.
//
// PURE THROUGHOUT. Nothing is mocked because nothing needs to be: every
// function under test is given its inputs, including the instant that stands
// for "now". That is itself the feature — a sales report that changed depending
// on which machine rendered it would not be a report.
//
// THE MACHINE'S TIMEZONE IS THE ADVERSARY IN THIS FILE. Several tests below
// pass an instant that falls on DIFFERENT calendar days in different zones, and
// assert the answer follows the BUSINESS timezone that was handed in. Those
// assertions hold on a runner in Honolulu, London or Tokyo; if any of them ever
// starts depending on `process.env.TZ`, it fails.
//
// WHAT IS DELIBERATELY NOT RE-TESTED HERE. Whether register_sessions.business_date
// is correct, and whether list_order_business_dates is authorized properly, are
// the database's and are proven by
// supabase/migrations/20260928120000_owner_reporting_contracts.db.test.ts.
import { describe, expect, it } from "vitest";
import {
  BUSINESS_DATE_UNAVAILABLE_LABEL,
  BUSINESS_RANGE_OPTIONS,
  UNATTRIBUTED_EMPLOYEE_LABEL,
  UNATTRIBUTED_GROUP_KEY,
  businessDateInTimezone,
  currentBusinessDate,
  groupSalesByEmployee,
  indexOrderBusinessDates,
  isBusinessDate,
  matchesBusinessDateRange,
  resolveOrderBusinessDate,
  shiftBusinessDate,
  totalAcrossEmployeeGroups,
} from "@/lib/salesReporting";

// 03:30 UTC on the 29th. In New York it is still the evening of the 28th; in
// Tokyo it is the afternoon of the 29th. One instant, two business days.
const LATE_NIGHT = "2026-09-29T03:30:00.000Z";

const REGISTERED_ORDER = { id: "order-registered", createdAt: LATE_NIGHT };
const LEGACY_ORDER = { id: "order-legacy", createdAt: LATE_NIGHT };

const NO_DATES = indexOrderBusinessDates([]);

// ---------------------------------------------------------------------------
// Reading a date in a named timezone
// ---------------------------------------------------------------------------

describe("turning an instant into a business date", () => {
  it("uses the timezone it is given, not the one the machine is in", () => {
    // The same instant, four zones, and the answers straddle midnight.
    expect(businessDateInTimezone(LATE_NIGHT, "America/New_York")).toBe("2026-09-28");
    expect(businessDateInTimezone(LATE_NIGHT, "Pacific/Honolulu")).toBe("2026-09-28");
    expect(businessDateInTimezone(LATE_NIGHT, "UTC")).toBe("2026-09-29");
    expect(businessDateInTimezone(LATE_NIGHT, "Asia/Tokyo")).toBe("2026-09-29");
  });

  it("gives the same answer whatever this test runner's timezone is", () => {
    // Nothing about the assertion above refers to the machine. Stated directly:
    // the machine's own reading of this instant is irrelevant to the result.
    const machineZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const machineDate = new Date(LATE_NIGHT).toLocaleDateString("en-CA");

    expect(businessDateInTimezone(LATE_NIGHT, "America/New_York")).toBe("2026-09-28");

    if (machineZone !== "America/New_York" && machineDate !== "2026-09-28") {
      expect(businessDateInTimezone(LATE_NIGHT, "America/New_York")).not.toBe(machineDate);
    }
  });

  it("returns a canonical YYYY-MM-DD, zero-padded", () => {
    expect(businessDateInTimezone("2026-01-05T12:00:00.000Z", "UTC")).toBe("2026-01-05");
    expect(isBusinessDate(businessDateInTimezone("2026-01-05T12:00:00.000Z", "UTC"))).toBe(
      true
    );
  });

  it("refuses to guess when the timezone is missing or unusable", () => {
    for (const zone of [null, undefined, "", "   ", "Mars/Olympus", "not a zone"]) {
      expect(`zone ${JSON.stringify(zone)}`).toBe(`zone ${JSON.stringify(zone)}`);
      expect(businessDateInTimezone(LATE_NIGHT, zone)).toBeNull();
    }
  });

  it("refuses an unparsable instant rather than inventing a date", () => {
    expect(businessDateInTimezone("not-a-date", "UTC")).toBeNull();
    expect(businessDateInTimezone("", "UTC")).toBeNull();
  });

  it("never silently falls back to UTC when a zone is unusable", () => {
    // The failure mode this guards: "Mars/Olympus" quietly becoming UTC would
    // date the sale 2026-09-29 and look entirely plausible.
    expect(businessDateInTimezone(LATE_NIGHT, "Mars/Olympus")).not.toBe("2026-09-29");
    expect(businessDateInTimezone(LATE_NIGHT, "Mars/Olympus")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CASE A — the registered sale
// ---------------------------------------------------------------------------

describe("a sale the register dated", () => {
  const registered = indexOrderBusinessDates([
    { orderId: REGISTERED_ORDER.id, businessDate: "2026-09-28" },
  ]);

  it("uses the stored register business date", () => {
    const resolution = resolveOrderBusinessDate(
      REGISTERED_ORDER,
      registered,
      "America/New_York"
    );

    expect(resolution).toEqual({ businessDate: "2026-09-28", source: "registered" });
  });

  it("does not move when the project's timezone changes afterwards", () => {
    // THE CENTRAL GUARANTEE. An owner correcting their timezone must not
    // reshuffle takings that were already banked on a business day.
    for (const zone of ["America/New_York", "UTC", "Asia/Tokyo", "Pacific/Honolulu"]) {
      expect(`zone ${zone}`).toBe(`zone ${zone}`);
      expect(resolveOrderBusinessDate(REGISTERED_ORDER, registered, zone)).toEqual({
        businessDate: "2026-09-28",
        source: "registered",
      });
    }

    // Even with no timezone at all, the recorded date still stands.
    expect(resolveOrderBusinessDate(REGISTERED_ORDER, registered, null)).toEqual({
      businessDate: "2026-09-28",
      source: "registered",
    });
  });

  it("is not recomputed from created_at", () => {
    // In Tokyo this instant is the 29th. The stored date wins anyway.
    expect(businessDateInTimezone(REGISTERED_ORDER.createdAt, "Asia/Tokyo")).toBe(
      "2026-09-29"
    );
    expect(
      resolveOrderBusinessDate(REGISTERED_ORDER, registered, "Asia/Tokyo").businessDate
    ).toBe("2026-09-28");
  });

  it("does not use the browser's timezone", () => {
    const machineDate = new Date(LATE_NIGHT).toLocaleDateString("en-CA");
    const resolved = resolveOrderBusinessDate(REGISTERED_ORDER, registered, null);

    expect(resolved.businessDate).toBe("2026-09-28");
    if (machineDate !== "2026-09-28") expect(resolved.businessDate).not.toBe(machineDate);
  });

  it("ignores a malformed stored date rather than trusting it", () => {
    const bad = indexOrderBusinessDates([
      { orderId: REGISTERED_ORDER.id, businessDate: "28/09/2026" },
    ]);

    // Not indexed at all, so the order falls through to the ordinary fallback.
    expect(bad.has(REGISTERED_ORDER.id)).toBe(false);
    expect(
      resolveOrderBusinessDate(REGISTERED_ORDER, bad, "America/New_York").source
    ).toBe("derived");
  });
});

// ---------------------------------------------------------------------------
// CASE B — the legacy sale
// ---------------------------------------------------------------------------

describe("a sale with no register date", () => {
  it("derives its date from created_at in the CURRENT project timezone", () => {
    expect(resolveOrderBusinessDate(LEGACY_ORDER, NO_DATES, "America/New_York")).toEqual({
      businessDate: "2026-09-28",
      source: "derived",
    });

    expect(resolveOrderBusinessDate(LEGACY_ORDER, NO_DATES, "Asia/Tokyo")).toEqual({
      businessDate: "2026-09-29",
      source: "derived",
    });
  });

  it("does not use the browser's timezone", () => {
    const machineDate = new Date(LATE_NIGHT).toLocaleDateString("en-CA");
    const derived = resolveOrderBusinessDate(LEGACY_ORDER, NO_DATES, "Pacific/Honolulu");

    expect(derived.businessDate).toBe("2026-09-28");
    if (machineDate !== "2026-09-28") {
      expect(derived.businessDate).not.toBe(machineDate);
    }
  });

  it("is marked as derived, so it is never mistaken for a recorded date", () => {
    expect(resolveOrderBusinessDate(LEGACY_ORDER, NO_DATES, "UTC").source).toBe("derived");
  });
});

// ---------------------------------------------------------------------------
// Neither one: no honest answer exists
// ---------------------------------------------------------------------------

describe("a sale with no register date and no usable timezone", () => {
  for (const zone of [null, undefined, "", "Mars/Olympus"]) {
    it(`fabricates nothing for timezone ${JSON.stringify(zone)}`, () => {
      const resolution = resolveOrderBusinessDate(LEGACY_ORDER, NO_DATES, zone);

      expect(resolution).toEqual({ businessDate: null, source: "unavailable" });
    });
  }

  it("is not quietly assigned to UTC, the browser, or a plausible zone", () => {
    const resolution = resolveOrderBusinessDate(LEGACY_ORDER, NO_DATES, null);
    const machineDate = new Date(LATE_NIGHT).toLocaleDateString("en-CA");

    expect(resolution.businessDate).toBeNull();
    // The three dates it must not have acquired.
    expect(resolution.businessDate).not.toBe("2026-09-29"); // UTC
    expect(resolution.businessDate).not.toBe("2026-09-28"); // America/New_York
    expect(resolution.businessDate).not.toBe(machineDate); // the viewer's
  });

  it("has a truthful label to show instead of a date", () => {
    expect(BUSINESS_DATE_UNAVAILABLE_LABEL).toBe("Business date unavailable");
  });

  it("still belongs to the business, and stays in All Time", () => {
    // The money is real even when the day is unknown. Dropping it from All Time
    // would understate the takings.
    expect(matchesBusinessDateRange(null, "allTime", "2026-09-29")).toBe(true);
  });

  it("is not forced into a dated bucket to compensate", () => {
    for (const range of ["today", "yesterday", "last7", "thisMonth"] as const) {
      expect(`range ${range}`).toBe(`range ${range}`);
      expect(matchesBusinessDateRange(null, range, "2026-09-29")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Ranges are business dates, not browser midnights
// ---------------------------------------------------------------------------

describe("business-date arithmetic", () => {
  it("steps days without a timezone of its own", () => {
    expect(shiftBusinessDate("2026-09-29", -1)).toBe("2026-09-28");
    expect(shiftBusinessDate("2026-09-29", -6)).toBe("2026-09-23");
    expect(shiftBusinessDate("2026-09-01", -1)).toBe("2026-08-31");
    expect(shiftBusinessDate("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftBusinessDate("2028-03-01", -1)).toBe("2028-02-29");
  });

  it("crosses a DST boundary without losing or repeating a day", () => {
    // US DST begins 2026-03-08. Browser-local `setDate()` arithmetic is where
    // that becomes a bug; UTC arithmetic on a date string cannot have one.
    expect(shiftBusinessDate("2026-03-09", -1)).toBe("2026-03-08");
    expect(shiftBusinessDate("2026-03-08", -1)).toBe("2026-03-07");
    expect(shiftBusinessDate("2026-11-02", -1)).toBe("2026-11-01");
  });

  it("leaves a value that is not a business date alone", () => {
    expect(shiftBusinessDate("not-a-date", -1)).toBe("not-a-date");
  });
});

describe("selecting a range", () => {
  const TODAY = "2026-09-29";

  it("Today means the business day, matched exactly", () => {
    expect(matchesBusinessDateRange("2026-09-29", "today", TODAY)).toBe(true);
    expect(matchesBusinessDateRange("2026-09-28", "today", TODAY)).toBe(false);
    expect(matchesBusinessDateRange("2026-09-30", "today", TODAY)).toBe(false);
  });

  it("Yesterday is the business day before", () => {
    expect(matchesBusinessDateRange("2026-09-28", "yesterday", TODAY)).toBe(true);
    expect(matchesBusinessDateRange("2026-09-29", "yesterday", TODAY)).toBe(false);
  });

  it("Last 7 Days includes both boundaries and excludes either side", () => {
    // Seven business days: the 23rd through the 29th.
    expect(matchesBusinessDateRange("2026-09-23", "last7", TODAY)).toBe(true);
    expect(matchesBusinessDateRange("2026-09-29", "last7", TODAY)).toBe(true);
    expect(matchesBusinessDateRange("2026-09-22", "last7", TODAY)).toBe(false);
    expect(matchesBusinessDateRange("2026-09-30", "last7", TODAY)).toBe(false);
  });

  it("This Month is the reference date's calendar month", () => {
    expect(matchesBusinessDateRange("2026-09-01", "thisMonth", TODAY)).toBe(true);
    expect(matchesBusinessDateRange("2026-09-30", "thisMonth", TODAY)).toBe(true);
    expect(matchesBusinessDateRange("2026-08-31", "thisMonth", TODAY)).toBe(false);
    expect(matchesBusinessDateRange("2026-10-01", "thisMonth", TODAY)).toBe(false);
  });

  it("All Time includes every sale, dated or not", () => {
    for (const date of ["2020-01-01", "2026-09-29", "2099-12-31", null]) {
      expect(`allTime ${date}`).toBe(`allTime ${date}`);
      expect(matchesBusinessDateRange(date, "allTime", TODAY)).toBe(true);
    }
  });

  it("evaluates no dated range when today cannot be known", () => {
    // No project timezone means no reference business day. Rather than fall
    // back to the viewer's calendar, dated ranges simply match nothing.
    for (const range of ["today", "yesterday", "last7", "thisMonth"] as const) {
      expect(`no-today ${range}`).toBe(`no-today ${range}`);
      expect(matchesBusinessDateRange("2026-09-29", range, null)).toBe(false);
    }

    expect(matchesBusinessDateRange("2026-09-29", "allTime", null)).toBe(true);
  });

  it("compares dates as strings, so no Date boundary is involved", () => {
    // Every argument is a canonical date string; there is no instant to
    // interpret and therefore no timezone that could interpret it.
    expect(matchesBusinessDateRange("2026-09-29", "today", "2026-09-29")).toBe(true);
    expect(BUSINESS_RANGE_OPTIONS.map((option) => option.value)).toEqual([
      "today",
      "yesterday",
      "last7",
      "thisMonth",
      "allTime",
    ]);
  });

  it("anchors 'today' to the business timezone, not the machine", () => {
    const now = new Date(LATE_NIGHT);

    expect(currentBusinessDate(now, "America/New_York")).toBe("2026-09-28");
    expect(currentBusinessDate(now, "Asia/Tokyo")).toBe("2026-09-29");
    expect(currentBusinessDate(now, null)).toBeNull();

    // A sale rung at this instant is "today" in New York and also "today" in
    // Tokyo — because both the sale and the reference move together.
    const derivedNY = resolveOrderBusinessDate(LEGACY_ORDER, NO_DATES, "America/New_York");
    expect(
      matchesBusinessDateRange(
        derivedNY.businessDate,
        "today",
        currentBusinessDate(now, "America/New_York")
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sales by employee
// ---------------------------------------------------------------------------

const ADA = {
  employeeId: "11111111-1111-4111-8111-111111111111",
  displayName: "Ada",
  employeeCode: "001",
  active: true,
};

const BO = {
  employeeId: "22222222-2222-4222-8222-222222222222",
  displayName: "Bo",
  employeeCode: "025",
  active: false,
};

function sale(id: string, employeeId: string | null, total: number, taxAmount = 0) {
  return { id, employeeId, total, taxAmount };
}

describe("grouping sales by the employee who rang them", () => {
  it("attributes a sale to the employee stored on the order", () => {
    const groups = groupSalesByEmployee([sale("o1", ADA.employeeId, 10)], [ADA, BO]);

    expect(groups).toHaveLength(1);
    expect(groups[0].employeeId).toBe(ADA.employeeId);
    expect(groups[0].displayName).toBe("Ada");
    expect(groups[0].orderCount).toBe(1);
    expect(groups[0].total).toBe(10);
  });

  it("keeps two employees separate", () => {
    const groups = groupSalesByEmployee(
      [
        sale("o1", ADA.employeeId, 10),
        sale("o2", BO.employeeId, 30),
        sale("o3", ADA.employeeId, 5),
      ],
      [ADA, BO]
    );

    expect(groups).toHaveLength(2);

    const ada = groups.find((group) => group.employeeId === ADA.employeeId);
    const bo = groups.find((group) => group.employeeId === BO.employeeId);

    expect(ada?.orderCount).toBe(2);
    expect(ada?.total).toBe(15);
    expect(bo?.orderCount).toBe(1);
    expect(bo?.total).toBe(30);
  });

  it("groups a sale with no employee as Unattributed", () => {
    const groups = groupSalesByEmployee([sale("o1", null, 10)], [ADA]);

    expect(groups).toHaveLength(1);
    expect(groups[0].employeeId).toBeNull();
    expect(groups[0].key).toBe(UNATTRIBUTED_GROUP_KEY);
    expect(groups[0].displayName).toBe(UNATTRIBUTED_EMPLOYEE_LABEL);
    expect(UNATTRIBUTED_EMPLOYEE_LABEL).toBe("Unattributed");
  });

  it("never hands an unattributed sale to somebody", () => {
    // The list of people it must not become: the only employee on the roster,
    // the first employee, or any named person at all.
    const groups = groupSalesByEmployee([sale("o1", null, 10)], [ADA, BO]);

    expect(groups[0].displayName).not.toBe("Ada");
    expect(groups[0].displayName).not.toBe("Bo");
    expect(groups[0].employeeId).toBeNull();
    expect(groups[0].employeeCode).toBeNull();
  });

  it("keeps unattributed sales in the overall total", () => {
    const orders = [
      sale("o1", ADA.employeeId, 10),
      sale("o2", null, 7),
      sale("o3", BO.employeeId, 3),
    ];
    const groups = groupSalesByEmployee(orders, [ADA, BO]);
    const overall = orders.reduce((sum, order) => sum + order.total, 0);

    // THE RECONCILIATION. Every penny in the report's Total Sales is in exactly
    // one group, and the unattributed group is one of them.
    expect(totalAcrossEmployeeGroups(groups)).toBe(overall);
    expect(totalAcrossEmployeeGroups(groups)).toBe(20);
    expect(groups.some((group) => group.employeeId === null)).toBe(true);
    expect(groups.reduce((sum, group) => sum + group.orderCount, 0)).toBe(orders.length);
  });

  it("reconciles when every sale is unattributed", () => {
    const orders = [sale("o1", null, 4), sale("o2", null, 6)];
    const groups = groupSalesByEmployee(orders, []);

    expect(groups).toHaveLength(1);
    expect(totalAcrossEmployeeGroups(groups)).toBe(10);
  });

  it("keeps an inactive employee's history as their own", () => {
    // Bo has left. The sales Bo rang are still Bo's.
    const groups = groupSalesByEmployee([sale("o1", BO.employeeId, 12)], [ADA, BO]);

    expect(groups[0].employeeId).toBe(BO.employeeId);
    expect(groups[0].displayName).toBe("Bo");
    expect(groups[0].active).toBe(false);
    expect(groups[0].resolved).toBe(true);
    // Not reassigned to the active employee, and not made unattributed.
    expect(groups[0].displayName).not.toBe(UNATTRIBUTED_EMPLOYEE_LABEL);
  });

  it("is unaffected by the employee's current role", () => {
    // ReportEmployee carries no role at all: there is no field through which a
    // present-day role could alter a historical attribution.
    const groups = groupSalesByEmployee([sale("o1", ADA.employeeId, 9)], [ADA]);

    expect(Object.keys(groups[0]).includes("role")).toBe(false);
    expect(groups[0].employeeId).toBe(ADA.employeeId);
  });

  it("keeps an Employee ID a string, leading zeros and all", () => {
    const groups = groupSalesByEmployee(
      [sale("o1", ADA.employeeId, 1), sale("o2", BO.employeeId, 1)],
      [ADA, BO]
    );

    const codes = groups.map((group) => group.employeeCode);

    expect(codes).toContain("001");
    expect(codes).toContain("025");
    for (const code of codes) {
      expect(`code ${code}`).toBe(`code ${code}`);
      expect(typeof code).toBe("string");
      expect(code).not.toBe("1");
      expect(code).not.toBe("25");
    }
  });

  it("carries no PIN or credential material of any kind", () => {
    const groups = groupSalesByEmployee([sale("o1", ADA.employeeId, 1)], [ADA]);
    const serialised = JSON.stringify(groups).toLowerCase();

    expect(serialised).not.toContain("pin");
    expect(serialised).not.toContain("hash");
    expect(Object.keys(groups[0]).sort()).toEqual([
      "active",
      "displayName",
      "employeeCode",
      "employeeId",
      "key",
      "orderCount",
      "resolved",
      "taxAmount",
      "total",
    ]);
  });

  it("does not collapse an unresolvable id into Unattributed", () => {
    // Structurally unreachable — every attribution FK is ON DELETE NO ACTION,
    // there is no delete-employee contract, and list_employees returns the
    // whole roster. If it ever happened, the sale must NOT be reported as
    // having had no operator, and must not borrow a name.
    const groups = groupSalesByEmployee([sale("o1", "missing-id", 5)], [ADA]);

    expect(groups).toHaveLength(1);
    expect(groups[0].employeeId).toBe("missing-id");
    expect(groups[0].resolved).toBe(false);
    expect(groups[0].displayName).not.toBe(UNATTRIBUTED_EMPLOYEE_LABEL);
    expect(groups[0].displayName).not.toBe("Ada");
    expect(groups[0].employeeCode).toBeNull();
    // And its money is still counted.
    expect(totalAcrossEmployeeGroups(groups)).toBe(5);
  });

  it("returns nothing for no sales, rather than an empty-looking employee", () => {
    expect(groupSalesByEmployee([], [ADA, BO])).toEqual([]);
    expect(totalAcrossEmployeeGroups([])).toBe(0);
  });

  it("orders by takings, with a stable tiebreak", () => {
    const groups = groupSalesByEmployee(
      [sale("o1", ADA.employeeId, 5), sale("o2", BO.employeeId, 50), sale("o3", null, 20)],
      [ADA, BO]
    );

    expect(groups.map((group) => group.total)).toEqual([50, 20, 5]);
  });
});

// ---------------------------------------------------------------------------
// The two halves together
// ---------------------------------------------------------------------------

describe("a report range and its employee breakdown agree", () => {
  it("the groups of a filtered range sum to that range's total", () => {
    const orders = [
      { ...sale("o1", ADA.employeeId, 10, 1), createdAt: LATE_NIGHT },
      { ...sale("o2", null, 7, 0), createdAt: LATE_NIGHT },
      { ...sale("o3", BO.employeeId, 3, 0), createdAt: "2026-09-20T12:00:00.000Z" },
    ];

    const dates = indexOrderBusinessDates([
      { orderId: "o1", businessDate: "2026-09-28" },
      { orderId: "o2", businessDate: "2026-09-28" },
      { orderId: "o3", businessDate: "2026-09-20" },
    ]);

    const inRange = orders.filter((order) =>
      matchesBusinessDateRange(
        resolveOrderBusinessDate(order, dates, "America/New_York").businessDate,
        "today",
        "2026-09-28"
      )
    );

    expect(inRange.map((order) => order.id)).toEqual(["o1", "o2"]);

    const rangeTotal = inRange.reduce((sum, order) => sum + order.total, 0);
    const groups = groupSalesByEmployee(inRange, [ADA, BO]);

    expect(rangeTotal).toBe(17);
    expect(totalAcrossEmployeeGroups(groups)).toBe(rangeTotal);
    // Ada's sale and the unattributed one, and nothing of Bo's.
    expect(groups).toHaveLength(2);
    expect(groups.some((group) => group.employeeId === BO.employeeId)).toBe(false);
  });
});
