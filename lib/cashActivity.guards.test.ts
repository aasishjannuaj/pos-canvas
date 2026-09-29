// v1.3 Task 5E — the boundaries of Cash Activity.
//
// lib/cashActivity.test.ts proves the model and pins the contract. These are
// the structural claims, and the first one is the whole point of the feature:
//
//   * cash_movements is the only authority, and a cash SALE is not a movement;
//   * amounts stay positive and exact, and no two types are ever combined;
//   * the report describes events and never claims a drawer position;
//   * employee, device and register remain three different things;
//   * the stored business date is used, never recomputed.
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

const MODEL = "lib/cashActivity.ts";
const REPORT = "components/dashboard/CashActivityReport.tsx";
const SHELL = "components/editor/EditorShell.tsx";

const TASK_5E_SOURCES = [MODEL, REPORT];

// ---------------------------------------------------------------------------
// One authority
// ---------------------------------------------------------------------------

describe("cash_movements is the only Cash Activity authority", () => {
  it("reads it through the accepted owner contract", () => {
    const report = code(read(REPORT));

    expect(report).toContain("fetchCashMovements(projectId, UNBOUNDED_WINDOW)");
    expect(report).toContain('from "@/lib/ownerReporting.rpc"');
    expect(report).not.toMatch(/\.rpc\(/);
    expect(report).not.toMatch(/\.from\(\s*["']cash_movements["']\s*\)/);
  });

  it("never reconstructs a movement from a sale or anything else", () => {
    // THE CENTRAL SUBSTITUTION RISK. A customer paying cash is a SALE.
    for (const file of TASK_5E_SOURCES) {
      const source = code(read(file));

      for (const banned of [
        "OrderTotal",
        "orderTotals",
        "getProjectOrderTotals",
        "paymentMethod",
        "payment_method",
        "completeSale",
        "receipt",
        "cartItem",
        "employee_pos_sessions",
        "fetchEmployeeTimeSessions",
        "TimeSessionRow",
        "openingCash",
        "opening_cash",
      ]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("adds no SQL, migration, RPC or service-role path", () => {
    for (const file of [...TASK_5E_SOURCES, SHELL]) {
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
});

// ---------------------------------------------------------------------------
// This is not a reconciliation
// ---------------------------------------------------------------------------

describe("Cash Activity never claims a drawer position", () => {
  it("names none of the figures this product cannot compute", () => {
    for (const file of TASK_5E_SOURCES) {
      const source = code(read(file));

      for (const banned of [
        "Expected Cash",
        "expectedCash",
        "Actual Cash",
        "actualCash",
        "Counted",
        "countedCash",
        "Closing Cash",
        "closingCash",
        "Drawer Balance",
        "drawerBalance",
        "Over / Short",
        "Over/Short",
        "overShort",
        "Variance",
        "variance",
        "Financial Close",
        "financialClose",
        "reconcil",
        "netCash",
        "netDrawer",
      ]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("has exactly one summing function, and it takes one type", () => {
    const model = code(read(MODEL));

    expect(model.match(/export function total/g)).toHaveLength(1);
    expect(model).toContain("export function totalForType(");
    expect(model).toContain("if (row.movementType !== type) continue;");
    // No subtraction anywhere: a difference between two types is a balance.
    expect(model).not.toContain("subtractMoney");
    expect(model).not.toMatch(/-\s*totalForType|totalForType[^\n]*-\s*total/);
  });

  it("renders each total against its own type only", () => {
    const report = code(read(REPORT));

    // One tile per canonical type, each fed by totalForType(visible, type).
    expect(report).toContain("CASH_MOVEMENT_TYPES.map((type)");
    expect(report).toContain("totalForType(visible, type)");
    // No tile that sums across types.
    expect(report).not.toMatch(/totalForType\([^)]*\)\s*[+-]/);
  });

  it("tells the owner plainly that no drawer is counted", () => {
    expect(read(REPORT)).toMatch(/does not count a\s*\n?\s*drawer/);
  });

  it("does not read opening cash anywhere", () => {
    for (const file of TASK_5E_SOURCES) {
      const source = code(read(file));

      expect(`${file}: opening`).toBe(`${file}: opening`);
      expect(source).not.toMatch(/opening/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

describe("amounts are exact and positive", () => {
  it("goes through the exact money module, never floats", () => {
    const model = code(read(MODEL));

    expect(model).toContain('from "@/lib/money"');
    expect(model).toContain("addMoney");
    expect(model).toContain("moneyFromFixedString");
    // The float paths this codebase has already been burned by.
    expect(model).not.toMatch(/parseFloat|Number\(|toFixed\(/);
    expect(model).not.toMatch(/\bamount\s*\+\s*|\+=\s*Number/);
  });

  it("does the same in the component", () => {
    const report = code(read(REPORT));

    expect(report).toContain("formatCashTotal(totalForType(visible, type))");
    expect(report).toContain("formatCashAmount(movement.amount)");
    expect(report).not.toMatch(/parseFloat|Number\(|toFixed\(/);
  });

  it("never rewrites a stored amount negative", () => {
    for (const file of TASK_5E_SOURCES) {
      const source = code(read(file));

      expect(`${file}: sign`).toBe(`${file}: sign`);
      expect(source).not.toMatch(/-\s*amount|amount\s*\*\s*-1|negate/i);
    }
  });
});

// ---------------------------------------------------------------------------
// The stored business date
// ---------------------------------------------------------------------------

describe("the business date is stored, not derived", () => {
  it("selects on the stored value", () => {
    const report = code(read(REPORT));

    expect(report).toContain("matchesBusinessDateRange(movement.businessDate");
    expect(report).toContain("movement.businessDate");
  });

  it("recomputes no date from a timestamp", () => {
    for (const file of TASK_5E_SOURCES) {
      const source = code(read(file));

      expect(`${file}: derive`).toBe(`${file}: derive`);
      expect(source).not.toContain("businessDateInTimezone");
      expect(source).not.toContain("resolveOrderBusinessDate");
      expect(source).not.toMatch(/new Intl\.DateTimeFormat/);
      expect(source).not.toMatch(/toDateString|getTimezoneOffset|resolvedOptions/);
    }
  });

  it("sends no timestamp window, so the two semantics cannot conflict", () => {
    const report = code(read(REPORT));

    // The contract filters occurred_at; the UI selects business dates. Sending
    // both would be two different questions under one label.
    expect(report).toContain("UNBOUNDED_WINDOW");
    expect(report).not.toMatch(/p_from|p_to|\{ from:|occurredAt.*filter/);
  });

  it("uses the SAVED timezone only to know today, never to date a movement", () => {
    const shell = code(read(SHELL));
    const start = shell.indexOf("<CashActivityReport");
    const mount = shell.slice(start, shell.indexOf("/>", start));

    expect(mount).toContain("businessTimezone={savedBusinessTimezone}");
    expect(mount).not.toMatch(/businessTimezone=\{businessTimezone\}/);
    expect(code(read(REPORT))).toContain("currentBusinessDate(new Date(), businessTimezone)");
  });
});

// ---------------------------------------------------------------------------
// Identities and secrets
// ---------------------------------------------------------------------------

describe("who and what a movement belongs to", () => {
  it("keeps employee, device and register apart", () => {
    const model = code(read(MODEL));

    expect(model).toContain("export function describeMovementEmployee");
    expect(model).toContain("export function describeMovementDevice");
    expect(model).toContain("export function describeMovementRegister");
    // None of them falls back to another.
    expect(model).not.toMatch(/displayName\s*\?\?\s*(row\.)?(pairedDeviceId|registerSessionId)/);
    expect(model).not.toMatch(/employeeId\s*\?\?\s*(row\.)?(pairedDeviceId|registerSessionId)/);
  });

  it("infers employee identity from nothing", () => {
    for (const file of TASK_5E_SOURCES) {
      const source = code(read(file));

      for (const banned of ["currentEmployee", "posGate", "ownerId", "auth.uid", "clockedIn"]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("exposes no PIN, credential or idempotency internals", () => {
    for (const file of TASK_5E_SOURCES) {
      const source = code(read(file));

      expect(`${file}: secrets`).toBe(`${file}: secrets`);
      expect(source).not.toMatch(/pin_hash|pinHash|\bpin\b/i);
      expect(source).not.toMatch(/requestId|request_id|idempotenc/i);
    }
  });

  it("fabricates no note", () => {
    const model = code(read(MODEL));

    expect(model).toContain('CASH_NOTE_ABSENT_LABEL = "—"');
    expect(model).not.toMatch(/note\s*\?\?\s*["'][A-Za-z]/);
    expect(code(read(REPORT))).toContain("describeNote(movement.note)");
  });
});

// ---------------------------------------------------------------------------
// Where it lives, and what it leaves alone
// ---------------------------------------------------------------------------

describe("Cash Activity sits beside the other v1.3 reports", () => {
  it("is a sidebar section in the existing Builder", () => {
    expect(code(read("components/editor/EditorSidebar.tsx"))).toContain(
      '{ label: "Cash Activity"'
    );
    expect(code(read(SHELL))).toContain('| "Cash Activity"');
  });

  it("adds no route and no new navigation architecture", () => {
    for (const file of TASK_5E_SOURCES) {
      expect(`${file}: route`).toBe(`${file}: route`);
      expect(code(read(file))).not.toMatch(/router\.push|useRouter|redirect\(/);
    }
  });

  it("is gated on no template", () => {
    for (const file of TASK_5E_SOURCES) {
      const source = code(read(file));

      expect(`${file}: template`).toBe(`${file}: template`);
      expect(source).not.toMatch(/liquor|retail|templateId|template_id|barcode/i);
    }
  });

  it("does not read an operational POS role for web access", () => {
    for (const file of TASK_5E_SOURCES) {
      const source = code(read(file));

      expect(`${file}: role`).toBe(`${file}: role`);
      expect(source).not.toMatch(/role === ["'](owner|manager|cashier)["']/);
      expect(source).not.toMatch(/isOwner|canViewReports|hasPermission/);
    }
  });

  it("keeps cash data out of the project configuration", () => {
    const shell = code(read(SHELL));

    expect(shell).not.toMatch(/const \[cashMovements/);
    expect(shell).not.toMatch(/cashMovements[^\n]*(config|publish|export)/i);

    for (const file of ["lib/projects.ts", "lib/projects.server.ts"]) {
      expect(`${file}: cash`).toBe(`${file}: cash`);
      expect(code(read(file))).not.toMatch(/cashMovement|movementType/i);
    }
  });

  it("leaves Task 5C and Task 5D intact", () => {
    // Their sections, models and mounts are untouched by Task 5E.
    const shell = code(read(SHELL));

    expect(shell).toContain("<SalesReport");
    expect(shell).toContain("<EmployeeTimeReport");
    expect(shell).toContain('| "Sales Report"');
    expect(shell).toContain('| "Employee Time"');
    // Task 5E reuses 5C's range model rather than forking it.
    expect(code(read(REPORT))).toContain('from "@/lib/salesReporting"');
  });

  it("shows a failure instead of an empty report", () => {
    const report = code(read(REPORT));

    expect(report).toContain("setErrorMessage(getOwnerReportMessage(result.code))");
    expect(report).toContain("Cash Activity Unavailable");
    expect(report).toContain("No cash movements in this range.");
    expect(report).toContain("Loading cash activity…");
  });
});
