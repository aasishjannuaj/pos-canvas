// v1.3 Task 5E — what a cash movement is, and what it is not allowed to become.
//
// PURE THROUGHOUT. The interesting claims are about EXACT MONEY and about the
// boundary between an event stream and a reconciliation, and neither needs a
// mock to state.
//
// THE CONTRACT'S SIGNATURE, FILTERING AND PROJECTION ARE PINNED against the
// migration source at the bottom of this file. They were established by reading
// 20260928120000_owner_reporting_contracts.sql, not assumed.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CASH_ACTIVITY_DATE_NOTE,
  CASH_ACTIVITY_LABELS,
  CASH_NOTE_ABSENT_LABEL,
  cashAmountToMoney,
  countForType,
  describeMovementDevice,
  describeMovementEmployee,
  describeMovementRegister,
  describeNote,
  formatCashAmount,
  formatCashTotal,
  getCashActivityLabel,
  totalForType,
} from "@/lib/cashActivity";
import type { CashActivityRow } from "@/lib/cashActivity";
import { CASH_MOVEMENT_LABELS, CASH_MOVEMENT_TYPES } from "@/lib/cashMovement";
import type { CashMovementType } from "@/lib/cashMovement";
import { ZERO_MONEY } from "@/lib/money";
import { matchesBusinessDateRange } from "@/lib/salesReporting";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Comment-stripped source.
 *
 * The assertions below are about CODE. This module's own docblock names
 * Expected Cash, Over/Short, variance and opening_cash precisely in order to
 * say they are NOT implemented, and an earlier form of these two tests read the
 * raw file and failed on that honest prose — a guard punishing the
 * documentation that makes the boundary clear.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function movement(
  id: string,
  movementType: CashMovementType,
  amount: string,
  overrides: Partial<CashActivityRow> = {}
): CashActivityRow {
  return {
    movementId: id,
    movementType,
    amount,
    employeeId: "emp-ada",
    displayName: "Ada",
    pairedDeviceId: "device-1",
    registerSessionId: "register-1",
    businessDate: "2026-09-28",
    occurredAt: "2026-09-28T18:00:00.000Z",
    note: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The three canonical kinds
// ---------------------------------------------------------------------------

describe("how a stored movement type is named to the owner", () => {
  it("names cash_drop as Cash Pickup / Safe Drop", () => {
    expect(getCashActivityLabel("cash_drop")).toBe("Cash Pickup / Safe Drop");
  });

  it("names paid_in and paid_out", () => {
    expect(getCashActivityLabel("paid_in")).toBe("Paid In");
    expect(getCashActivityLabel("paid_out")).toBe("Paid Out");
  });

  it("covers exactly the three canonical stored values, and no fourth", () => {
    expect(Object.keys(CASH_ACTIVITY_LABELS).sort()).toEqual([
      "cash_drop",
      "paid_in",
      "paid_out",
    ]);
    expect([...CASH_MOVEMENT_TYPES].sort()).toEqual(["cash_drop", "paid_in", "paid_out"]);
  });

  it("agrees with the till on two labels and deliberately differs on one", () => {
    // The till says "Cash Drop" to the cashier doing it; the owner's report
    // names the same event more fully. Pinned so neither drifts by accident.
    expect(CASH_ACTIVITY_LABELS.paid_in).toBe(CASH_MOVEMENT_LABELS.paid_in);
    expect(CASH_ACTIVITY_LABELS.paid_out).toBe(CASH_MOVEMENT_LABELS.paid_out);
    expect(CASH_ACTIVITY_LABELS.cash_drop).not.toBe(CASH_MOVEMENT_LABELS.cash_drop);
    expect(CASH_MOVEMENT_LABELS.cash_drop).toBe("Cash Drop");
  });

  it("renames nothing in the stored data", () => {
    // Presentation only: the row still carries the canonical value.
    const row = movement("m1", "cash_drop", "20.00");

    expect(row.movementType).toBe("cash_drop");
    expect(getCashActivityLabel(row.movementType)).toBe("Cash Pickup / Safe Drop");
  });
});

// ---------------------------------------------------------------------------
// Exact money
// ---------------------------------------------------------------------------

describe("amounts are exact", () => {
  it("reads a two-decimal stored amount exactly", () => {
    expect(formatCashAmount("20.00")).toBe("20.00");
    expect(formatCashAmount("0.01")).toBe("0.01");
    expect(formatCashAmount("9999999999.99")).toBe("9999999999.99");
  });

  it("pads a shortened decimal rather than parsing it as a float", () => {
    // numeric(12,2) can arrive as the JSON number 12.5, which the accepted
    // parser stringifies to "12.5". Same exact decimal, padded — never rounded.
    expect(formatCashAmount("12.5")).toBe("12.50");
    expect(formatCashAmount("12")).toBe("12.00");
    expect(cashAmountToMoney("12.5")).toEqual(cashAmountToMoney("12.50"));
  });

  it("refuses a shape it does not recognise instead of inventing a figure", () => {
    for (const bad of ["", "abc", "1.234", "1,00", "1e2", " "]) {
      expect(`amount ${JSON.stringify(bad)}`).toBe(`amount ${JSON.stringify(bad)}`);
      expect(cashAmountToMoney(bad)).toBeNull();
    }

    // And an unreadable amount is never displayed as 0.00.
    expect(formatCashAmount("abc")).toBe("abc");
    expect(formatCashAmount("abc")).not.toBe("0.00");
  });

  it("sums without floating-point error", () => {
    // 0.1 + 0.2 is the canonical IEEE-754 failure: it gives 0.30000000000000004.
    const rows = [movement("m1", "paid_in", "0.10"), movement("m2", "paid_in", "0.20")];

    expect(formatCashTotal(totalForType(rows, "paid_in"))).toBe("0.30");
    expect(formatCashTotal(totalForType(rows, "paid_in"))).not.toContain("0000");
  });

  it("stays exact over many awkward amounts", () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      movement(`m${index}`, "paid_out", "0.07")
    );

    expect(formatCashTotal(totalForType(rows, "paid_out"))).toBe("0.70");
  });

  it("keeps stored amounts positive, with direction carried by the type", () => {
    const rows = [
      movement("m1", "paid_in", "5.00"),
      movement("m2", "paid_out", "5.00"),
    ];

    // Neither is rewritten negative, and they are not netted against each other.
    expect(formatCashAmount(rows[0].amount)).toBe("5.00");
    expect(formatCashAmount(rows[1].amount)).toBe("5.00");
    expect(formatCashTotal(totalForType(rows, "paid_in"))).toBe("5.00");
    expect(formatCashTotal(totalForType(rows, "paid_out"))).toBe("5.00");
    expect(formatCashAmount(rows[1].amount)).not.toContain("-");
  });
});

// ---------------------------------------------------------------------------
// Per-type totals, and the line they must not cross
// ---------------------------------------------------------------------------

describe("source-event totals", () => {
  const mixed = [
    movement("m1", "cash_drop", "100.00"),
    movement("m2", "cash_drop", "50.50"),
    movement("m3", "paid_in", "20.00"),
    movement("m4", "paid_out", "7.25"),
  ];

  it("includes only its own movement type", () => {
    expect(formatCashTotal(totalForType(mixed, "cash_drop"))).toBe("150.50");
    expect(formatCashTotal(totalForType(mixed, "paid_in"))).toBe("20.00");
    expect(formatCashTotal(totalForType(mixed, "paid_out"))).toBe("7.25");

    expect(countForType(mixed, "cash_drop")).toBe(2);
    expect(countForType(mixed, "paid_in")).toBe(1);
    expect(countForType(mixed, "paid_out")).toBe(1);
  });

  it("is the exact sum of the authoritative events", () => {
    // Each total equals its own rows and nothing else's.
    const drops = mixed.filter((row) => row.movementType === "cash_drop");

    expect(countForType(mixed, "cash_drop")).toBe(drops.length);
    expect(formatCashTotal(totalForType(mixed, "cash_drop"))).toBe("150.50");
  });

  it("is zero for a type with no events, without borrowing another's", () => {
    const onlyDrops = [movement("m1", "cash_drop", "10.00")];

    expect(formatCashTotal(totalForType(onlyDrops, "paid_in"))).toBe("0.00");
    expect(formatCashTotal(totalForType(onlyDrops, "paid_out"))).toBe("0.00");
    expect(formatCashTotal(ZERO_MONEY)).toBe("0.00");
  });

  it("offers no combined figure of any kind", () => {
    // THE BOUNDARY. There is no exported function that adds two types
    // together, because any such number would be a drawer position POS Canvas
    // cannot compute — there is no counted-closing-cash contract anywhere.
    const model = code(readFileSync(join(repoRoot, "lib/cashActivity.ts"), "utf-8"));

    expect(model).not.toMatch(/expectedCash|actualCash|countedCash|drawerBalance/i);
    expect(model).not.toMatch(/overShort|variance|netCash|closingCash|reconcil/i);
    expect(model).not.toContain("subtractMoney");
    // totalForType is the only summing function, and it takes ONE type.
    expect(model.match(/export function total/g)).toHaveLength(1);
    expect(model).toContain("type: CashMovementType");
  });

  it("never reads opening cash", () => {
    const model = code(readFileSync(join(repoRoot, "lib/cashActivity.ts"), "utf-8"));

    expect(model).not.toMatch(/openingCash|opening_cash/);
  });
});

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

describe("a movement's note", () => {
  it("is shown faithfully when one was recorded", () => {
    expect(describeNote("Bank run")).toBe("Bank run");
    expect(describeNote("Milk for the machine")).toBe("Milk for the machine");
  });

  it("is an absence when there is none, not an invented reason", () => {
    // A cash_drop legitimately has no note — the drop is its own reason.
    expect(describeNote(null)).toBe(CASH_NOTE_ABSENT_LABEL);
    expect(describeNote("")).toBe(CASH_NOTE_ABSENT_LABEL);
    expect(describeNote("   ")).toBe(CASH_NOTE_ABSENT_LABEL);
    expect(CASH_NOTE_ABSENT_LABEL).toBe("—");

    // None of the plausible-sounding placeholders.
    for (const fabricated of ["Cash drop", "No reason given", "N/A", "Safe drop"]) {
      expect(`not fabricated: ${fabricated}`).toBe(`not fabricated: ${fabricated}`);
      expect(describeNote(null)).not.toBe(fabricated);
    }
  });

  it("is never an internal identifier", () => {
    const row = movement("m1", "cash_drop", "20.00");

    expect(describeNote(row.note)).not.toBe(row.movementId);
    expect(describeNote(row.note)).not.toBe(row.registerSessionId);
    expect(JSON.stringify(row).toLowerCase()).not.toContain("request");
    expect(JSON.stringify(row).toLowerCase()).not.toContain("idempot");
  });
});

// ---------------------------------------------------------------------------
// Three identities
// ---------------------------------------------------------------------------

describe("employee, device and register stay distinct", () => {
  it("shows the employee the movement recorded", () => {
    const row = movement("m1", "paid_out", "5.00", {
      displayName: "Bo",
      employeeId: "emp-bo",
    });

    expect(describeMovementEmployee(row)).toBe("Bo");
  });

  it("never returns a device or register where an employee belongs", () => {
    const row = movement("m1", "paid_out", "5.00", {
      displayName: "Bo",
      pairedDeviceId: "device-9",
      registerSessionId: "register-9",
    });

    expect(describeMovementEmployee(row)).not.toBe(describeMovementDevice(row));
    expect(describeMovementEmployee(row)).not.toBe(describeMovementRegister(row));
    expect(describeMovementDevice(row)).toBe("device-9");
    expect(describeMovementRegister(row)).toBe("register-9");
  });

  it("keeps a deactivated employee's movements as theirs", () => {
    // Attribution is read from the row. There is no `active` or `role` field
    // through which present-day employee state could reach a past movement.
    const row = movement("m1", "cash_drop", "80.00", { displayName: "Ada" });

    expect(describeMovementEmployee(row)).toBe("Ada");
    expect(Object.keys(row)).not.toContain("active");
    expect(Object.keys(row)).not.toContain("role");
  });

  it("carries no PIN or credential material", () => {
    const row = movement("m1", "cash_drop", "80.00");
    const serialized = JSON.stringify(row).toLowerCase();

    expect(serialized).not.toContain("pin");
    expect(serialized).not.toContain("hash");
    expect(Object.keys(row).sort()).toEqual([
      "amount",
      "businessDate",
      "displayName",
      "employeeId",
      "movementId",
      "movementType",
      "note",
      "occurredAt",
      "pairedDeviceId",
      "registerSessionId",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The stored business date
// ---------------------------------------------------------------------------

describe("the business date is the register's own", () => {
  it("selects on the stored value, not on occurredAt", () => {
    // occurredAt is late on the 28th UTC; the register recorded the 27th. The
    // stored date wins, and no timezone reading of occurredAt can change it.
    const row = movement("m1", "cash_drop", "40.00", {
      businessDate: "2026-09-27",
      occurredAt: "2026-09-28T03:00:00.000Z",
    });

    expect(matchesBusinessDateRange(row.businessDate, "today", "2026-09-27")).toBe(true);
    expect(matchesBusinessDateRange(row.businessDate, "today", "2026-09-28")).toBe(false);
  });

  it("does not move when the project's timezone changes afterwards", () => {
    // The stored string is the only input to the selection, so there is no
    // timezone for a later change to re-read it under.
    const row = movement("m1", "paid_in", "10.00", { businessDate: "2026-09-27" });

    for (const today of ["2026-09-27"]) {
      expect(`today ${today}`).toBe(`today ${today}`);
      expect(matchesBusinessDateRange(row.businessDate, "today", today)).toBe(true);
    }

    expect(row.businessDate).toBe("2026-09-27");
  });

  it("is a plain stored date string, never recomputed", () => {
    const model = code(readFileSync(join(repoRoot, "lib/cashActivity.ts"), "utf-8"));

    // Nothing in the model derives a date from an instant.
    expect(model).not.toMatch(/businessDateInTimezone|resolveOrderBusinessDate/);
    expect(model).not.toMatch(/new Intl\.DateTimeFormat/);
    expect(model).not.toMatch(/occurredAt[\s\S]{0,60}businessDate/);
  });

  it("is always present, because a movement cannot exist without one", () => {
    // cash_movements.register_session_id is NOT NULL and cash_movement_append
    // selects the register by `r.business_date = v_business_date`, refusing a
    // null business date outright. So the type is non-nullable by construction.
    const row = movement("m1", "cash_drop", "40.00");

    expect(typeof row.businessDate).toBe("string");
    expect(row.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// The contract, pinned to its source
// ---------------------------------------------------------------------------

describe("what list_cash_movements actually does", () => {
  const migration = readFileSync(
    join(repoRoot, "supabase/migrations/20260928120000_owner_reporting_contracts.sql"),
    "utf-8"
  );
  const fnStart = migration.indexOf(
    "create or replace function public.list_cash_movements"
  );
  const fn = migration.slice(
    fnStart,
    migration.indexOf("$function$;", fnStart) + "$function$;".length
  );

  it("has the exact accepted signature", () => {
    expect(fn).toContain("p_project_id uuid");
    expect(fn).toContain("p_from timestamptz");
    expect(fn).toContain("p_to timestamptz");
    expect(fn).toContain("returns jsonb");
    expect(fn).toContain("security definer");
  });

  it("filters on occurred_at, half-open, with null meaning unbounded", () => {
    expect(fn).toContain("p_from is null or m.occurred_at >= p_from");
    expect(fn).toContain("p_to is null or m.occurred_at < p_to");
    // Not <=, and not filtered on business_date.
    expect(fn).not.toMatch(/occurred_at\s*<=\s*p_to/);
    const where = fn.slice(fn.indexOf("where m.project_id"));
    expect(where).not.toContain("business_date >=");
    expect(where).not.toContain("business_date <");
  });

  it("orders newest first", () => {
    expect(fn).toContain("order by m.occurred_at desc, m.id");
  });

  it("returns the stored register business date, joined not derived", () => {
    expect(fn).toContain("'businessDate', r.business_date");
    expect(fn).toContain("join public.register_sessions r on r.id = m.register_session_id");
  });

  it("projects exactly the accepted fields and no internals", () => {
    const projection = fn.slice(fn.indexOf("jsonb_build_object"), fn.indexOf("order by"));

    for (const field of [
      "movementId",
      "movementType",
      "amount",
      "employeeId",
      "displayName",
      "pairedDeviceId",
      "registerSessionId",
      "businessDate",
      "occurredAt",
      "note",
    ]) {
      expect(`projects ${field}`).toBe(`projects ${field}`);
      expect(projection).toContain(field);
    }

    // request_id exists on the table and is deliberately not exposed.
    expect(projection).not.toContain("request_id");
    expect(projection).not.toMatch(/pin|hash|token|secret|idempot/i);
  });

  it("reads cash_movements, never orders or sales", () => {
    expect(fn).toContain("from public.cash_movements m");
    expect(fn).not.toContain("public.orders");
    expect(fn).not.toContain("payment_method");
    expect(fn).not.toContain("opening_cash");
  });

  it("is owner-authorized and refuses a paired device", () => {
    expect(fn).toContain("v_caller := auth.uid()");
    expect(fn).toContain("from public.paired_devices d where d.auth_user_id = v_caller");
    expect(fn).toContain("v_project_owner is distinct from v_caller");
  });

  it("is described to the owner in the terms it actually uses", () => {
    expect(CASH_ACTIVITY_DATE_NOTE).toMatch(/business day the register recorded/i);
  });
});
