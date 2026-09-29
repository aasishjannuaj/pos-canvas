// v1.3 Task 5C — business-date sales reporting and sales by employee, as a
// pure model.
//
// PURE. No Supabase, no React, no storage, and — the point of the whole file —
// NO AMBIENT CLOCK OR TIMEZONE. Nothing here reads the machine's timezone, the
// browser's offset, a locale or `Date.now()`. Every function is given the
// values it needs and returns an answer that is the same on every machine,
// which is what makes a sales report reproducible rather than a property of
// whoever happens to be looking at it.
//
// WHY THIS EXISTS AT ALL. lib/dateRange.ts buckets orders by the VIEWER'S local
// calendar day (`toDateString()`, `setHours(0,0,0,0)`). That is the wrong
// question for a point of sale: a shop in New York that closes at 2am has a
// business day the viewer's browser in London knows nothing about, and two
// owners looking at the same shop would see two different "Today". dateRange is
// left exactly as it is — Product Performance still uses it — and business
// reporting asks the business's own question instead.
//
// THREE WAYS AN ORDER GETS A BUSINESS DATE, IN STRICT PRIORITY ORDER:
//
//   1. REGISTERED — register_sessions.business_date, recorded when the sale was
//      rung and read through list_order_business_dates. This is authoritative
//      and permanent: it is never recomputed, and changing the project's
//      timezone afterwards does not move a sale that already happened.
//   2. DERIVED — for a sale with no register session (legacy v1.2, or an
//      offline sale that recorded no business day), the instant in
//      `orders.created_at` read in the project's CURRENT business timezone.
//      A presentation fallback, labelled as one, never written back.
//   3. UNAVAILABLE — no register date AND no usable project timezone. There is
//      no honest answer, so none is invented. The sale keeps its money in the
//      overall totals and is simply not a member of any dated bucket.
//
// DATES ARE CANONICAL `YYYY-MM-DD` STRINGS, COMPARED AS STRINGS. That format
// sorts lexicographically in calendar order, so a range check needs no Date
// object and therefore cannot acquire a timezone by accident.
import type { OrderBusinessDate } from "@/lib/ownerReporting";

/** Shown where a sale cannot be placed on any business day. */
export const BUSINESS_DATE_UNAVAILABLE_LABEL = "Business date unavailable";

/** The group every sale with no recorded employee belongs to. */
export const UNATTRIBUTED_EMPLOYEE_LABEL = "Unattributed";

/**
 * Where an order's business date came from.
 *
 * Kept on the resolution rather than inferred later, because "the register said
 * so" and "we worked it out from the timezone" are different kinds of claim and
 * the screen is allowed to say which it is making.
 */
export type BusinessDateSource = "registered" | "derived" | "unavailable";

export type BusinessDateResolution = {
  businessDate: string | null;
  source: BusinessDateSource;
};

const CANONICAL_BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Is this a canonical `YYYY-MM-DD` business date? */
export function isBusinessDate(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_BUSINESS_DATE.test(value);
}

/**
 * The calendar date an instant falls on, IN A NAMED TIMEZONE.
 *
 * `Intl.DateTimeFormat` with an explicit `timeZone` is the only place this
 * module converts anything, and it is given the zone rather than allowed to
 * default — a `DateTimeFormat` with no `timeZone` silently uses the machine's,
 * which is exactly the bug this whole file exists to remove.
 *
 * Assembled from `formatToParts` instead of trusting a locale's date order, so
 * the result is `YYYY-MM-DD` regardless of the environment's locale data.
 *
 * Returns null — never a guess — for an unusable timezone (null, blank, or one
 * the runtime rejects, which throws a RangeError) or an unparsable instant.
 */
export function businessDateInTimezone(
  createdAt: string,
  timeZone: string | null | undefined
): string | null {
  if (typeof timeZone !== "string" || timeZone.trim() === "") return null;

  const instant = new Date(createdAt);

  if (Number.isNaN(instant.getTime())) return null;

  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant);

    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;

    if (!year || !month || !day) return null;

    const businessDate = `${year}-${month}-${day}`;

    return isBusinessDate(businessDate) ? businessDate : null;
  } catch {
    // An invalid IANA identifier throws. It is not repaired and not replaced
    // with UTC: an invalid timezone means we do not know what day it was.
    return null;
  }
}

/**
 * The authoritative dates, keyed by order id.
 *
 * A map rather than repeated scans, because a report reads every order against
 * the same list. `findOrderBusinessDate` in lib/ownerReporting.ts stays as it
 * is for single lookups.
 */
export function indexOrderBusinessDates(
  rows: readonly OrderBusinessDate[]
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();

  for (const row of rows) {
    if (isBusinessDate(row.businessDate)) index.set(row.orderId, row.businessDate);
  }

  return index;
}

/**
 * Which business day a sale belongs to.
 *
 * THE REGISTERED DATE WINS, ALWAYS AND WITHOUT RECOMPUTATION. This is the rule
 * the rest of the feature rests on: a sale rung on business day 2026-09-28 is
 * reported on 2026-09-28 forever, whatever the project's timezone is set to
 * later and whoever is looking. Recomputing it from `created_at` would silently
 * move historical takings between days the first time an owner corrected their
 * timezone.
 */
export function resolveOrderBusinessDate(
  order: { id: string; createdAt: string },
  authoritativeDates: ReadonlyMap<string, string>,
  businessTimezone: string | null | undefined
): BusinessDateResolution {
  const registered = authoritativeDates.get(order.id);

  if (isBusinessDate(registered)) {
    return { businessDate: registered, source: "registered" };
  }

  const derived = businessDateInTimezone(order.createdAt, businessTimezone);

  return derived === null
    ? { businessDate: null, source: "unavailable" }
    : { businessDate: derived, source: "derived" };
}

// ---------------------------------------------------------------------------
// Ranges, over business dates
// ---------------------------------------------------------------------------

export type BusinessDateRange =
  | "today"
  | "yesterday"
  | "last7"
  | "thisMonth"
  | "allTime";

export const BUSINESS_RANGE_OPTIONS: { value: BusinessDateRange; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last7", label: "Last 7 Days" },
  { value: "thisMonth", label: "This Month" },
  { value: "allTime", label: "All Time" },
];

/**
 * Shift a business date by whole days.
 *
 * Built on `Date.UTC`, which has no timezone of its own, so the arithmetic is
 * identical on every machine. The browser-local equivalent
 * (`date.setDate(date.getDate() - 1)`) crosses a DST boundary differently
 * depending on where the viewer is — the same class of bug as bucketing by
 * `toDateString()`.
 */
export function shiftBusinessDate(businessDate: string, days: number): string {
  if (!isBusinessDate(businessDate)) return businessDate;

  const [year, month, day] = businessDate.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));

  return [
    String(shifted.getUTCFullYear()).padStart(4, "0"),
    String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    String(shifted.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * Today's business date for a project, or null when it cannot be known.
 *
 * `now` is passed in rather than read, so a test pins the instant and no
 * function in this module ever consults the machine clock on its own.
 */
export function currentBusinessDate(
  now: Date,
  businessTimezone: string | null | undefined
): string | null {
  return businessDateInTimezone(now.toISOString(), businessTimezone);
}

/**
 * Is this sale inside the selected range?
 *
 * ALL TIME INCLUDES EVERYTHING, INCLUDING SALES WITH NO BUSINESS DATE. That is
 * deliberate and is the rule that keeps the report's money honest: a sale that
 * cannot be placed on a day is still a sale that happened, and dropping it from
 * "All Time" would quietly understate the business's takings.
 *
 * EVERY DATED RANGE EXCLUDES THEM. Putting an undated sale in "Today" would be
 * inventing the membership this feature refuses to invent. It is excluded from
 * the bucket, not from the business.
 *
 * `today` is the reference business date. When it is null — no usable project
 * timezone — no dated range can be evaluated at all, so only All Time answers
 * true. The caller offers the owner nothing else in that state.
 */
export function matchesBusinessDateRange(
  businessDate: string | null,
  range: BusinessDateRange,
  today: string | null
): boolean {
  if (range === "allTime") return true;

  if (businessDate === null || today === null) return false;

  if (range === "today") return businessDate === today;

  if (range === "yesterday") return businessDate === shiftBusinessDate(today, -1);

  if (range === "last7") {
    // Today plus the previous six business days, inclusive. String comparison
    // is calendar comparison for `YYYY-MM-DD`.
    return businessDate >= shiftBusinessDate(today, -6) && businessDate <= today;
  }

  // thisMonth — same calendar month as the reference business date.
  return businessDate.slice(0, 7) === today.slice(0, 7);
}

// ---------------------------------------------------------------------------
// Sales by employee
// ---------------------------------------------------------------------------

/** The key the unattributed group is held under. Not a real employee id. */
export const UNATTRIBUTED_GROUP_KEY = "__unattributed__";

/**
 * What a report needs to know about an employee to name them.
 *
 * A structural subset of lib/employeeAdmin.rpc's EmployeeSummary, so the roster
 * is consumed through the accepted owner contract rather than copied into a
 * second employee model.
 */
export type ReportEmployee = {
  employeeId: string;
  displayName: string;
  employeeCode: string | null;
  active: boolean;
};

export type EmployeeSalesGroup = {
  key: string;
  /** The stored attribution. Null is the unattributed group, and only that. */
  employeeId: string | null;
  displayName: string;
  /**
   * Text, always. `001` is `001` — an Employee ID's leading zeros are part of
   * the identity, and reporting never reformats one.
   */
  employeeCode: string | null;
  /** Null for the unattributed group, and for an id the roster cannot name. */
  active: boolean | null;
  /**
   * False only when a non-null employee id is not in the roster.
   *
   * STRUCTURALLY UNREACHABLE, AND STILL NOT COLLAPSED. Every attribution FK is
   * ON DELETE NO ACTION, `authenticated` holds no DELETE on employees, there is
   * no delete-employee contract, and list_employees returns the project's whole
   * roster including inactive staff — so an attributed employee cannot vanish.
   * If one ever did, this stays its own group: folding it into Unattributed
   * would claim the sale had no operator, and borrowing another employee's name
   * would attribute someone's takings to a person who did not ring them.
   */
  resolved: boolean;
  orderCount: number;
  total: number;
  taxAmount: number;
};

type ReportOrder = {
  id: string;
  employeeId: string | null;
  total: number;
  taxAmount: number;
};

/**
 * Group sales by the employee the SERVER recorded against them.
 *
 * ATTRIBUTION IS READ, NEVER DECIDED. The only input is `order.employeeId`, as
 * stored at the moment of the sale. Nothing here consults who is signed in now,
 * who owns the project, which employee is clocked in, which device rang it, or
 * who is looking at the report — every one of those would rewrite history to
 * match the present.
 *
 * ROLE AND ACTIVE STATUS CHANGE NOTHING. An employee who has since been
 * deactivated, or whose role changed, keeps every sale they rang; the roster is
 * consulted only to put a name to an id.
 */
export function groupSalesByEmployee(
  orders: readonly ReportOrder[],
  employees: readonly ReportEmployee[]
): EmployeeSalesGroup[] {
  const roster = new Map<string, ReportEmployee>();

  for (const employee of employees) roster.set(employee.employeeId, employee);

  const groups = new Map<string, EmployeeSalesGroup>();

  for (const order of orders) {
    const key = order.employeeId ?? UNATTRIBUTED_GROUP_KEY;
    const existing = groups.get(key);

    if (existing) {
      existing.orderCount += 1;
      existing.total += order.total;
      existing.taxAmount += order.taxAmount;
      continue;
    }

    const employee = order.employeeId === null ? null : roster.get(order.employeeId);

    groups.set(key, {
      key,
      employeeId: order.employeeId,
      displayName:
        order.employeeId === null
          ? UNATTRIBUTED_EMPLOYEE_LABEL
          : // An unnamed id is shown as the id's own group, never as a
            // fabricated name and never as Unattributed.
            employee?.displayName ?? "Unknown employee",
      employeeCode: employee?.employeeCode ?? null,
      active: employee ? employee.active : null,
      resolved: order.employeeId === null || employee !== undefined,
      orderCount: 1,
      total: order.total,
      taxAmount: order.taxAmount,
    });
  }

  // Biggest takings first; ties by name so the order is stable. Unattributed
  // sorts with everyone else rather than being pinned somewhere special — it is
  // a real share of the business, not a footnote.
  return [...groups.values()].sort(
    (a, b) => b.total - a.total || a.displayName.localeCompare(b.displayName)
  );
}

/**
 * The sum of every group's takings.
 *
 * Exists so the reconciliation can be asserted rather than assumed: this must
 * equal the overall total of the same orders, which is only true while nothing
 * silently drops the unattributed group.
 */
export function totalAcrossEmployeeGroups(groups: readonly EmployeeSalesGroup[]): number {
  return groups.reduce((sum, group) => sum + group.total, 0);
}
