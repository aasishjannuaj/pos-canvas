// v1.3 Task 5C — the boundaries of business-date sales reporting.
//
// lib/salesReporting.test.ts proves the model. These are the claims that are
// structural rather than behavioural, and each one is a way this feature could
// quietly become something it was not authorized to be:
//
//   * it may READ the accepted owner contracts and may not invent one;
//   * the viewer's clock may format a timestamp and may NEVER decide which
//     business day a sale belongs to;
//   * attribution is read from the order and never resolved from the present;
//   * it reports sales, and says nothing about cash reconciliation;
//   * no part of it is gated on a template.
//
// Source-level because this repository has no React Testing Library (verified —
// no testing-library dependency in package.json), so the components are read.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf-8");
}

/** Comment-stripped source: explanatory prose must never satisfy a guard. */
function code(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const MODEL = "lib/salesReporting.ts";
const REPORT = "components/dashboard/SalesReport.tsx";
const DASHBOARD = "components/dashboard/ProjectDashboard.tsx";
const SHELL = "components/editor/EditorShell.tsx";

const TASK_5C_SOURCES = [MODEL, REPORT, DASHBOARD];

// ---------------------------------------------------------------------------
// The viewer's clock has no authority over a business day
// ---------------------------------------------------------------------------

describe("no browser or machine timezone decides a business date", () => {
  it("the model reads no ambient timezone at all", () => {
    const model = code(read(MODEL));

    for (const banned of [
      "resolvedOptions",
      "getTimezoneOffset",
      "toDateString",
      "setHours",
      "navigator",
      "process.env.TZ",
      "Date.now()",
    ]) {
      expect(`${MODEL}: ${banned}`).toBe(`${MODEL}: ${banned}`);
      expect(model).not.toContain(banned);
    }
  });

  it("every conversion names the timezone it converts into", () => {
    const model = code(read(MODEL));

    // A DateTimeFormat without an explicit `timeZone` silently uses the
    // machine's, which is the entire bug this feature removes. Every
    // construction in the model passes one.
    const formatters = [...model.matchAll(/new Intl\.DateTimeFormat\(([\s\S]{0,200}?)\)/g)];

    expect(formatters.length).toBeGreaterThan(0);
    for (const [, args] of formatters) {
      expect(`formatter args: ${args}`).toBe(`formatter args: ${args}`);
      expect(args).toContain("timeZone");
    }
  });

  it("bucketing never goes through the browser-local range helper", () => {
    for (const file of TASK_5C_SOURCES) {
      const source = code(read(file));

      expect(`${file}: dateRange`).toBe(`${file}: dateRange`);
      expect(source).not.toContain("@/lib/dateRange");
      expect(source).not.toMatch(/\bmatchesRange\b|\bisSameLocalDay\b/);
    }
  });

  it("leaves lib/dateRange.ts itself exactly as it was", () => {
    const dateRange = code(read("lib/dateRange.ts"));

    // Not deleted and not redefined: Product Performance still uses it, and
    // Task 5C has no authority to change what "This Month" means there.
    expect(dateRange).toContain("export function matchesRange");
    expect(dateRange).toContain("isSameLocalDay");
    expect(code(read("components/dashboard/ProductPerformance.tsx"))).toContain(
      "@/lib/dateRange"
    );
  });

  it("the report's only local formatting is the timestamp column", () => {
    const report = code(read(REPORT));

    // `toLocaleString` appears once, inside formatDateTime, which renders WHEN
    // a sale happened in the viewer's own time. The business day beside it
    // comes from resolveOrderBusinessDate, which never sees this browser.
    expect(report.match(/toLocaleString/g)).toHaveLength(1);
    expect(report).toMatch(/function formatDateTime\([\s\S]{0,300}?toLocaleString/);
    expect(report).toContain("matchesBusinessDateRange");
    expect(report).toContain("resolveOrderBusinessDate");
  });

  it("the dashboard's Today is a business day", () => {
    const dashboard = code(read(DASHBOARD));

    expect(dashboard).toContain("currentBusinessDate");
    expect(dashboard).toContain("resolveOrderBusinessDate");
    // The old browser-local implementation is gone, not merely bypassed.
    expect(dashboard).not.toContain("toDateString");
    expect(dashboard).not.toMatch(/function isToday/);
  });

  it("the reference instant is passed in, never read inside the model", () => {
    const model = code(read(MODEL));

    expect(model).toContain("export function currentBusinessDate(\n  now: Date,");
    expect(model).not.toMatch(/const now = new Date\(\)/);
  });
});

// ---------------------------------------------------------------------------
// No business date is ever fabricated
// ---------------------------------------------------------------------------

describe("an unknown business day stays unknown", () => {
  it("has no fallback zone hidden anywhere in the model", () => {
    const model = code(read(MODEL));

    // The three tempting defaults. UTC is a timezone an owner may legitimately
    // CHOOSE, but it is never one this code picks on their behalf.
    expect(model).not.toMatch(/\?\?\s*["']UTC["']|\|\|\s*["']UTC["']|=\s*["']UTC["']/);
    expect(model).not.toMatch(/America\/New_York/);
    expect(model).not.toMatch(/timeZone:\s*["'][A-Za-z]+\/[A-Za-z_]+["']/);
  });

  it("returns null rather than a date it cannot justify", () => {
    const model = code(read(MODEL));

    expect(model).toContain('source: "unavailable"');
    expect(model).toContain("businessDate: null");
    expect(model).toContain('BUSINESS_DATE_UNAVAILABLE_LABEL = "Business date unavailable"');
  });

  it("keeps an undated sale in All Time and out of every dated bucket", () => {
    const model = code(read(MODEL));
    const matcher = model.slice(model.indexOf("export function matchesBusinessDateRange"));

    // All Time answers before the null check; every other range is refused by
    // it. Reversing those two lines is exactly how an undated sale would start
    // appearing in "Today".
    expect(matcher.indexOf('range === "allTime"')).toBeLessThan(
      matcher.indexOf("businessDate === null")
    );
  });

  it("never writes a derived date back to an order", () => {
    for (const file of TASK_5C_SOURCES) {
      const source = code(read(file));

      expect(`${file}: write-back`).toBe(`${file}: write-back`);
      expect(source).not.toMatch(/\.update\(|\.insert\(|\.upsert\(|\.rpc\(/);
      expect(source).not.toContain("business_date");
    }
  });
});

// ---------------------------------------------------------------------------
// Only the accepted contracts, only for reading
// ---------------------------------------------------------------------------

describe("Task 5C reads accepted owner contracts and adds none", () => {
  it("consumes exactly list_order_business_dates and list_employees", () => {
    const shell = code(read(SHELL));

    expect(shell).toContain("fetchOrderBusinessDates(projectId)");
    expect(shell).toContain("listEmployees(projectId)");
    // Through the existing accepted wrappers, not a new RPC call of its own.
    expect(shell).not.toMatch(/\.rpc\(\s*["']list_order_business_dates/);
    expect(shell).not.toMatch(/\.rpc\(\s*["']list_employees/);
  });

  it("defines no SQL, no migration and no new RPC", () => {
    for (const file of [...TASK_5C_SOURCES, SHELL]) {
      const source = code(read(file));

      expect(`${file}: sql`).toBe(`${file}: sql`);
      expect(source).not.toMatch(/create\s+(or\s+replace\s+)?function/i);
      expect(source).not.toMatch(/\bcreate table\b|\balter table\b|\bgrant execute\b/i);
    }
  });

  it("reaches for no service role and no protected table", () => {
    for (const file of TASK_5C_SOURCES) {
      const source = code(read(file));

      for (const banned of [
        "service_role",
        "SUPABASE_SERVICE_ROLE_KEY",
        "supabase/admin",
        "createAdminClient",
      ]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }

      expect(source).not.toMatch(
        /\.from\(\s*["'](employees|orders|register_sessions|paired_devices|employee_time_sessions|cash_movements)["']\s*\)/
      );
    }
  });

  it("sends no owner identity the server derives for itself", () => {
    const shell = code(read(SHELL));
    const loader = shell.slice(
      shell.indexOf("fetchOrderBusinessDates(projectId)") - 600,
      shell.indexOf("fetchOrderBusinessDates(projectId)") + 1400
    );

    expect(loader).not.toMatch(/user_id|auth_user_id|p_owner|getUser\(\)/);
  });

  it("copies no employee model of its own", () => {
    const model = code(read(MODEL));

    // ReportEmployee is a structural subset consumed from the accepted roster,
    // not a second employee table or a cached copy.
    expect(model).toContain("export type ReportEmployee");
    expect(model).not.toMatch(/pin|hash|role/i);
  });
});

// ---------------------------------------------------------------------------
// Attribution is history, not the present
// ---------------------------------------------------------------------------

describe("who rang a sale is read, never decided", () => {
  it("groups on the order's stored employee id and nothing else", () => {
    const model = code(read(MODEL));
    const grouping = model.slice(model.indexOf("export function groupSalesByEmployee"));

    expect(grouping).toContain("order.employeeId ?? UNATTRIBUTED_GROUP_KEY");
    // None of the present-day answers it must never substitute.
    for (const banned of [
      "currentEmployee",
      "session",
      "posGate",
      "ownerId",
      "auth",
      "clock",
      "device",
      "employees[0]",
    ]) {
      expect(`grouping: ${banned}`).toBe(`grouping: ${banned}`);
      expect(grouping).not.toContain(banned);
    }
  });

  it("gives a null attribution its own group and no name", () => {
    const model = code(read(MODEL));

    expect(model).toContain('UNATTRIBUTED_EMPLOYEE_LABEL = "Unattributed"');
    expect(model).toContain("UNATTRIBUTED_GROUP_KEY");
    // No fallback that would hand it to a person.
    expect(model).not.toMatch(/employeeId\s*\?\?\s*(owner|employees|current)/i);
  });

  it("never numerically reformats an Employee ID", () => {
    for (const file of TASK_5C_SOURCES) {
      const source = code(read(file));

      for (const banned of ["parseInt", "parseFloat", "Number(", "padStart(3", "toFixed(0)"]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }

    // The report renders the code as given, with a dash when there is none.
    expect(code(read(REPORT))).toContain('{group.employeeCode ?? "—"}');
  });

  it("puts no PIN or credential material in a report", () => {
    for (const file of [...TASK_5C_SOURCES, SHELL]) {
      const source = code(read(file));

      expect(`${file}: pin`).toBe(`${file}: pin`);
      expect(source).not.toMatch(/pin_hash|pinHash|\bpin\b/i);
    }
  });
});

// ---------------------------------------------------------------------------
// What this report does not claim to know
// ---------------------------------------------------------------------------

describe("reporting sales is not closing a drawer", () => {
  it("claims nothing about cash reconciliation", () => {
    for (const file of TASK_5C_SOURCES) {
      const source = code(read(file));

      for (const banned of [
        "Expected Cash",
        "expectedCash",
        "Actual Cash",
        "actualCash",
        "Counted",
        "countedCash",
        "Over / Short",
        "overShort",
        "Drawer",
        "openingCash",
        "opening_cash",
        "Financial Close",
        "reconcil",
      ]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("starts no Task 5D or 5E surface", () => {
    for (const file of TASK_5C_SOURCES) {
      const source = code(read(file));

      for (const banned of [
        "employee_time_sessions",
        "fetchEmployeeTimeSessions",
        "TimeSessionRow",
        "fetchCashMovements",
        "CashMovementRow",
        "cash_movements",
        "clockedIn",
      ]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("does not redefine what a sale is worth", () => {
    const report = code(read(REPORT));

    // The same four metrics over the same fields as before Task 5C; only the
    // set of orders they run over changed.
    expect(report).toContain('label: "Total Sales"');
    expect(report).toContain('label: "Transactions"');
    expect(report).toContain('label: "Average Order Value"');
    expect(report).toContain('label: "Tax Collected"');
    expect(report).toContain("sum + order.total");
    expect(report).toContain("sum + order.taxAmount");
    // No invented accounting.
    expect(report).not.toMatch(/discount|refund|void|writeOff/i);
  });
});

// ---------------------------------------------------------------------------
// Where it lives, and who it is for
// ---------------------------------------------------------------------------

describe("reporting is project-level owner administration", () => {
  it("is gated on no template", () => {
    for (const file of TASK_5C_SOURCES) {
      const source = code(read(file));

      expect(`${file}: template`).toBe(`${file}: template`);
      expect(source).not.toMatch(/liquor|retail|templateId|template_id|barcode/i);
    }
  });

  it("does not read an operational POS role for web access", () => {
    for (const file of TASK_5C_SOURCES) {
      const source = code(read(file));

      expect(`${file}: role`).toBe(`${file}: role`);
      expect(source).not.toMatch(/role === ["'](owner|manager|cashier)["']/);
      expect(source).not.toMatch(/isOwner|canViewReports|hasPermission/);
    }
  });

  it("adds no route and no new navigation architecture", () => {
    for (const file of TASK_5C_SOURCES) {
      const source = code(read(file));

      expect(`${file}: route`).toBe(`${file}: route`);
      expect(source).not.toMatch(/router\.push|useRouter|redirect\(/);
    }

    // Still the existing sidebar sections; no new destination was invented.
    const sidebar = code(read("components/editor/EditorSidebar.tsx"));
    expect(sidebar).toContain('{ label: "Sales Report"');
    expect(sidebar).toContain('{ label: "Dashboard"');
  });

  it("keeps report data out of the project configuration", () => {
    const shell = code(read(SHELL));

    // Nothing loaded for a report is saved, published or exported.
    expect(shell).not.toMatch(/config[^\n]*orderBusinessDates/);
    expect(shell).not.toMatch(/orderBusinessDates[^\n]*config/);
    expect(shell).not.toMatch(/reportEmployees[^\n]*(config|publish|export)/i);

    for (const file of ["lib/projects.ts", "lib/projects.server.ts"]) {
      expect(`${file}: reporting`).toBe(`${file}: reporting`);
      expect(code(read(file))).not.toMatch(/businessDate|employeeId|orderBusinessDates/);
    }
  });

  it("uses the SAVED timezone, not the one being edited", () => {
    const shell = code(read(SHELL));

    // `businessTimezone` is the value in the Business panel's select, which may
    // be an unsaved edit. A report must not re-bucket itself because somebody
    // opened a dropdown.
    //
    // SCOPED TO THE TWO REPORT MOUNTS. An earlier form of this guard banned
    // `businessTimezone={businessTimezone}` across the whole file and failed on
    // EditorPropertiesPanel's own prop — which is Task 5A's edit control and is
    // SUPPOSED to receive the unsaved value. A guard that punishes correct code
    // elsewhere is worse than no guard.
    for (const mount of ["<SalesReport", "<ProjectDashboard"]) {
      const start = shell.indexOf(mount);
      const props = shell.slice(start, shell.indexOf("/>", start));

      expect(`${mount}: saved timezone`).toBe(`${mount}: saved timezone`);
      expect(props).toContain("businessTimezone={savedBusinessTimezone}");
      expect(props).not.toMatch(/businessTimezone=\{businessTimezone\}/);
    }
  });
});

// ---------------------------------------------------------------------------
// A failure is said out loud
// ---------------------------------------------------------------------------

describe("a broken report never looks like a quiet day", () => {
  it("shows the business-date failure rather than an empty list", () => {
    const shell = code(read(SHELL));
    const report = code(read(REPORT));

    expect(shell).toContain("setBusinessDatesError(getOwnerReportMessage(dates.code))");
    expect(report).toContain("businessDatesError !== null");
    expect(report).toMatch(/businessDatesError[\s\S]{0,400}?role="alert"/);
  });

  it("shows the roster failure separately from the sales failure", () => {
    const report = code(read(REPORT));

    // Two different statements: "I cannot name the employees" is not "I cannot
    // tell you what was sold".
    expect(report).toContain("employeesError !== null");
    expect(report).toContain("orderTotalsError ?");
    expect(report).toContain("Sales Data Unavailable");
  });

  it("distinguishes loading from empty", () => {
    const report = code(read(REPORT));

    expect(report).toContain("isLoadingReportData");
    expect(report).toContain("Loading sales report…");
    expect(report).toContain("No sales in this range.");
  });
});
