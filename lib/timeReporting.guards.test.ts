// v1.3 Task 5D — the boundaries of Employee Time Reports.
//
// lib/timeReporting.test.ts proves the model and pins the contract's inclusion
// semantics. These are the structural claims — each one a way this feature
// could quietly become something it was not authorized to be:
//
//   * the Time Clock is the ONLY source, and a POS session is not a substitute;
//   * an unfinished shift never acquires a number;
//   * nothing rounds, splits, or prices worked time;
//   * no clock or timezone is inherited from whoever is looking;
//   * it reports, and never edits or corrects a record.
//
// Source-level because this repository has no React Testing Library (verified —
// no testing-library dependency in package.json), so the component is read.
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

const MODEL = "lib/timeReporting.ts";
const REPORT = "components/dashboard/EmployeeTimeReport.tsx";
const SHELL = "components/editor/EditorShell.tsx";

const TASK_5D_SOURCES = [MODEL, REPORT];

// ---------------------------------------------------------------------------
// One source of truth
// ---------------------------------------------------------------------------

describe("the Time Clock is the only authority", () => {
  it("reads employee_time_sessions through the accepted contract", () => {
    const report = code(read(REPORT));

    expect(report).toContain("fetchEmployeeTimeSessions(projectId, window)");
    expect(report).toContain('from "@/lib/ownerReporting.rpc"');
    // Not a new RPC of its own, and not a direct table read.
    expect(report).not.toMatch(/\.rpc\(/);
    expect(report).not.toMatch(/\.from\(\s*["']employee_time_sessions["']\s*\)/);
  });

  it("never substitutes a POS session, register, sale or cash movement", () => {
    // The central substitution risk. "Signed in at a till" and "on the clock"
    // are different facts with different spans.
    for (const file of TASK_5D_SOURCES) {
      const source = code(read(file));

      for (const banned of [
        "employee_pos_sessions",
        "employeePosSession",
        "EmployeeSession",
        "register_sessions",
        "registerSessionId",
        "orderTotals",
        "OrderTotal",
        "cash_movements",
        "CashMovementRow",
        "fetchCashMovements",
        "fetchOrderBusinessDates",
        "posGate",
      ]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("builds no second time model and copies no employee model", () => {
    const model = code(read(MODEL));

    // A structural subset of the accepted row, not a parallel store.
    expect(model).toContain("export type TimeReportSession");
    expect(model).not.toMatch(/\brole\b|\bactive\b/);
    expect(model).not.toMatch(/employeeCode/);
  });
});

// ---------------------------------------------------------------------------
// An open shift is not a number
// ---------------------------------------------------------------------------

describe("an unfinished shift never acquires a duration", () => {
  it("has no clock to read it against", () => {
    const model = code(read(MODEL));
    const duration = model.slice(
      model.indexOf("export function closedSessionDurationMs"),
      model.indexOf("export function formatDuration")
    );

    // No `now`, no Date.now(), no current-time subtraction anywhere near it.
    expect(duration).not.toContain("Date.now");
    expect(duration).not.toMatch(/new Date\(\)/);
    expect(duration).toContain("if (session.isOpen || session.clockedOutAt === null) return null");
  });

  it("is labelled open rather than zero", () => {
    const model = code(read(MODEL));

    expect(model).toContain('OPEN_SESSION_STATUS_LABEL = "Open"');
    expect(model).toContain('OPEN_SESSION_DURATION_LABEL = "—"');
    // The two answers it must never give.
    expect(model).not.toMatch(/OPEN_SESSION_DURATION_LABEL\s*=\s*["']0/);
    expect(model).not.toMatch(/isOpen[\s\S]{0,80}return 0\b/);
  });

  it("is excluded from the total rather than added as zero", () => {
    const model = code(read(MODEL));
    const total = model.slice(
      model.indexOf("export function totalClosedDurationMs"),
      model.indexOf("export function countClosedSessions")
    );

    expect(total).toContain("if (durationMs !== null) total += durationMs");
    expect(total).not.toMatch(/\?\?\s*0/);
  });

  it("is counted separately, so a total is never silently short", () => {
    const report = code(read(REPORT));

    expect(report).toContain("countOpenSessions");
    expect(report).toContain('label: "Total Worked (Closed Shifts)"');
    expect(report).toContain("not included in the total");
  });
});

// ---------------------------------------------------------------------------
// No payroll semantics
// ---------------------------------------------------------------------------

describe("this reports time, it does not price it", () => {
  it("introduces no wage, overtime or labour-cost concept", () => {
    for (const file of TASK_5D_SOURCES) {
      const source = code(read(file));

      for (const banned of [
        "payroll",
        "overtime",
        "wage",
        "payRate",
        "hourlyRate",
        "labor",
        "labour",
        "gross",
        "netPay",
        "break",
        "schedule",
        "approve",
        "timesheet",
        "payPeriod",
      ]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source.toLowerCase()).not.toContain(banned.toLowerCase());
      }
    }
  });

  it("rounds nothing to a payroll increment", () => {
    const model = code(read(MODEL));

    // Whole minutes of real elapsed time, floored. No 15-minute bucket, no
    // grace period, no rounding up.
    expect(model).toContain("Math.floor(durationMs / 60_000)");
    expect(model).not.toMatch(/Math\.round|Math\.ceil/);
    expect(model).not.toMatch(/\b15\b|\b0\.25\b|grace/i);
  });

  it("splits no shift across a day boundary", () => {
    for (const file of TASK_5D_SOURCES) {
      const source = code(read(file));

      // The CONCEPT, not the word: an earlier form banned /split/i and matched
      // `date.split("-")` in the date helper, which is string splitting and has
      // nothing to do with dividing a shift.
      expect(`${file}: splitting`).toBe(`${file}: splitting`);
      expect(source).not.toMatch(
        /splitShift|splitSession|splitAcross|perDay|dailyPortion|payrollDay|segmentShift/i
      );
      // And no shift is ever turned into more than one row.
      expect(source).not.toMatch(/flatMap\([^)]*session/i);
    }
  });

  it("edits nothing — it is a read-only report", () => {
    for (const file of TASK_5D_SOURCES) {
      const source = code(read(file));

      expect(`${file}: writes`).toBe(`${file}: writes`);
      expect(source).not.toMatch(/\.update\(|\.insert\(|\.upsert\(|\.delete\(/);
      expect(source).not.toMatch(/clock_out_employee|clockOutEmployee|correct|adjustTime/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Whose clock decides anything
// ---------------------------------------------------------------------------

describe("no browser or machine timezone is authoritative", () => {
  it("the model reads no ambient timezone", () => {
    const model = code(read(MODEL));

    for (const banned of [
      "resolvedOptions",
      "getTimezoneOffset",
      "toDateString",
      "toLocaleDateString",
      "toLocaleTimeString",
      "setHours",
      "navigator",
      "process.env.TZ",
    ]) {
      expect(`${MODEL}: ${banned}`).toBe(`${MODEL}: ${banned}`);
      expect(model).not.toContain(banned);
    }
  });

  it("every conversion names the timezone it converts into", () => {
    const model = code(read(MODEL));
    const formatters = [...model.matchAll(/new Intl\.DateTimeFormat\(([\s\S]{0,240}?)\)/g)];

    expect(formatters.length).toBeGreaterThan(0);
    for (const [, args] of formatters) {
      expect(`formatter args: ${args}`).toBe(`formatter args: ${args}`);
      expect(args).toContain("timeZone");
    }
  });

  it("fabricates no timezone when the project has none", () => {
    const model = code(read(MODEL));

    // UTC appears only as an openly LABELLED absolute fallback, never as a
    // silently assumed business timezone.
    expect(model).toContain('TIMESTAMP_ZONE_UNAVAILABLE_SUFFIX = "UTC"');
    expect(model).not.toMatch(/America\/New_York/);
    expect(model).not.toMatch(/timeZone:\s*["'][A-Za-z]+\/[A-Za-z_]+["']/);
    expect(model).not.toMatch(/\?\?\s*["']America|\|\|\s*["']America/);
  });

  it("refuses to build a dated window without a business timezone", () => {
    const model = code(read(MODEL));
    const windowFn = model.slice(model.indexOf("export function timeReportWindow"));

    expect(windowFn).toContain("if (today === null) return null");
    // The report must then offer All Time only, rather than a browser-local day.
    expect(code(read(REPORT))).toContain("datedRangesAvailable");
    expect(code(read(REPORT))).toContain('timeReportWindow("today", new Date(), businessTimezone) !== null');
  });

  it("uses the SAVED timezone, not the one being edited", () => {
    const shell = code(read(SHELL));
    const start = shell.indexOf("<EmployeeTimeReport");
    const mount = shell.slice(start, shell.indexOf("/>", start));

    expect(mount).toContain("businessTimezone={savedBusinessTimezone}");
    expect(mount).not.toMatch(/businessTimezone=\{businessTimezone\}/);
  });
});

// ---------------------------------------------------------------------------
// The contract's inclusion model is described, not widened
// ---------------------------------------------------------------------------

describe("the range means what the contract means", () => {
  it("sends a half-open window over the clock-in instant", () => {
    const model = code(read(MODEL));
    const windowFn = model.slice(model.indexOf("export function timeReportWindow"));

    // Yesterday's exclusive end is today's inclusive start.
    expect(windowFn).toContain('range === "yesterday" ? today : shiftDate(today, 1)');
    expect(model).toContain("export function businessDayStartInstant");
  });

  it("tells the owner the inclusion rule in the report itself", () => {
    const report = code(read(REPORT));

    expect(report).toContain("TIME_RANGE_INCLUSION_NOTE");
  });

  it("invents no overlap or containment semantics of its own", () => {
    for (const file of TASK_5D_SOURCES) {
      const source = code(read(file));

      expect(`${file}: semantics`).toBe(`${file}: semantics`);
      expect(source).not.toMatch(/overlap|containment|clippedTo|intersect/i);
      // Filtering is the server's; the client does not re-filter the rows.
      expect(source).not.toMatch(/sessions\.filter\([^)]*clockedInAt/);
    }
  });
});

// ---------------------------------------------------------------------------
// Who it is for, and what it exposes
// ---------------------------------------------------------------------------

describe("owner reporting, with nothing leaked", () => {
  it("adds no SQL, migration, RPC or service-role path", () => {
    for (const file of [...TASK_5D_SOURCES, SHELL]) {
      const source = code(read(file));

      expect(`${file}: backend`).toBe(`${file}: backend`);
      expect(source).not.toMatch(/create\s+(or\s+replace\s+)?function/i);
      expect(source).not.toMatch(/\bcreate table\b|\balter table\b|\bgrant execute\b/i);
      for (const banned of ["service_role", "SUPABASE_SERVICE_ROLE_KEY", "createAdminClient"]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("exposes no PIN, credential or idempotency internals", () => {
    for (const file of TASK_5D_SOURCES) {
      const source = code(read(file));

      expect(`${file}: secrets`).toBe(`${file}: secrets`);
      expect(source).not.toMatch(/pin_hash|pinHash|\bpin\b/i);
      expect(source).not.toMatch(/requestId|request_id|idempotenc/i);
    }
  });

  it("does not read an operational POS role for web access", () => {
    for (const file of TASK_5D_SOURCES) {
      const source = code(read(file));

      expect(`${file}: role`).toBe(`${file}: role`);
      expect(source).not.toMatch(/role === ["'](owner|manager|cashier)["']/);
      expect(source).not.toMatch(/isOwner|canViewReports|hasPermission/);
    }
  });

  it("is gated on no template", () => {
    for (const file of TASK_5D_SOURCES) {
      const source = code(read(file));

      expect(`${file}: template`).toBe(`${file}: template`);
      expect(source).not.toMatch(/liquor|retail|templateId|template_id|barcode/i);
    }
  });

  it("lives in the existing Builder and adds no route", () => {
    const sidebar = code(read("components/editor/EditorSidebar.tsx"));

    expect(sidebar).toContain('{ label: "Employee Time"');
    expect(code(read(SHELL))).toContain('| "Employee Time"');

    for (const file of TASK_5D_SOURCES) {
      expect(`${file}: route`).toBe(`${file}: route`);
      expect(code(read(file))).not.toMatch(/router\.push|useRouter|redirect\(/);
    }
  });

  it("keeps Time Clock data out of the project configuration", () => {
    const shell = code(read(SHELL));

    // EditorShell holds no Time Clock state: the panel owns its own.
    expect(shell).not.toMatch(/const \[timeSessions/);
    expect(shell).not.toMatch(/timeSessions[^\n]*(config|publish|export)/i);

    for (const file of ["lib/projects.ts", "lib/projects.server.ts"]) {
      expect(`${file}: time`).toBe(`${file}: time`);
      expect(code(read(file))).not.toMatch(/clockedIn|timeSession|employee_time/i);
    }
  });

  it("shows a failure instead of an empty report", () => {
    const report = code(read(REPORT));

    expect(report).toContain("setErrorMessage(getOwnerReportMessage(result.code))");
    expect(report).toContain("Time Clock Data Unavailable");
    // And an empty success is a different, real answer.
    expect(report).toContain("No Time Clock records in this range.");
    expect(report).toContain("Loading Time Clock records…");
  });
});

// ---------------------------------------------------------------------------
// Task 5E stays unstarted
// ---------------------------------------------------------------------------

describe("Task 5D does not reach into Task 5E", () => {
  it("implements no cash activity", () => {
    for (const file of TASK_5D_SOURCES) {
      const source = code(read(file));

      for (const banned of [
        "cashMovement",
        "cash_drop",
        "paid_in",
        "paid_out",
        "Expected Cash",
        "Actual Cash",
        "Over / Short",
        "Drawer",
        "openingCash",
        "reconcil",
      ]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });
});
