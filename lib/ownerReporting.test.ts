// v1.3 Feature 1F — the owner reporting parsers, as behaviour.
//
// These are the rules that decide what an owner is shown when the server sends
// something unexpected. A report that quietly drops a shift, a movement, or a
// business date is worse than one that says it could not load.
import { describe, expect, it } from "vitest";

import {
  findOrderBusinessDate,
  getOwnerReportMessage,
  isCashMovementType,
  parseCashMovementsResult,
  parseOrderBusinessDatesResult,
  parseTimeSessionsResult,
} from "@/lib/ownerReporting";
import { parseSetEmployeeRoleResult } from "@/lib/employeeAdmin.rpc";

const CLOSED = {
  timeSessionId: "t1",
  employeeId: "e1",
  displayName: "Amy",
  clockedInAt: "2026-09-20T13:00:00Z",
  clockedOutAt: "2026-09-20T21:00:00Z",
  isOpen: false,
  clockInPairedDeviceId: "d1",
  clockOutPairedDeviceId: "d1",
};

const OPEN = { ...CLOSED, timeSessionId: "t2", clockedOutAt: null, isOpen: true, clockOutPairedDeviceId: null };

const MOVEMENT = {
  movementId: "m1",
  movementType: "cash_drop",
  amount: "100.00",
  employeeId: "e1",
  displayName: "Amy",
  pairedDeviceId: "d1",
  registerSessionId: "r1",
  businessDate: "2026-09-20",
  occurredAt: "2026-09-20T15:00:00Z",
  note: "to safe",
};

describe("time session parsing", () => {
  it("accepts a closed shift and an open one", () => {
    const result = parseTimeSessionsResult({ ok: true, timeSessions: [CLOSED, OPEN] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.timeSessions).toHaveLength(2);
    expect(result.timeSessions[1].isOpen).toBe(true);
    expect(result.timeSessions[1].clockedOutAt).toBeNull();
  });

  it("refuses a row whose open flag disagrees with its clock-out", () => {
    // Either one of these is lying about whether somebody is still on shift.
    expect(parseTimeSessionsResult({ ok: true, timeSessions: [{ ...OPEN, isOpen: false }] }))
      .toEqual({ ok: false, code: "unavailable" });
    expect(parseTimeSessionsResult({ ok: true, timeSessions: [{ ...CLOSED, isOpen: true }] }))
      .toEqual({ ok: false, code: "unavailable" });
  });

  it("fails the whole report rather than dropping an unreadable shift", () => {
    const result = parseTimeSessionsResult({
      ok: true,
      timeSessions: [CLOSED, { ...CLOSED, timeSessionId: "" }],
    });

    expect(result).toEqual({ ok: false, code: "unavailable" });
  });

  it("carries the server's refusal through verbatim", () => {
    expect(parseTimeSessionsResult({ ok: false, error: "not_found" }))
      .toEqual({ ok: false, code: "not_found" });
    expect(parseTimeSessionsResult({ ok: false, error: "not_authenticated" }))
      .toEqual({ ok: false, code: "not_authenticated" });
  });

  it("treats an unrecognised refusal as unavailable rather than guessing", () => {
    expect(parseTimeSessionsResult({ ok: false, error: "teapot" }))
      .toEqual({ ok: false, code: "unavailable" });
    expect(parseTimeSessionsResult(null)).toEqual({ ok: false, code: "unavailable" });
    expect(parseTimeSessionsResult({ ok: true })).toEqual({ ok: false, code: "unavailable" });
  });

  it("an empty report is a real answer, not a failure", () => {
    expect(parseTimeSessionsResult({ ok: true, timeSessions: [] }))
      .toEqual({ ok: true, timeSessions: [] });
  });
});

describe("cash movement parsing", () => {
  it("accepts the three authoritative types and nothing else", () => {
    for (const type of ["cash_drop", "paid_in", "paid_out"]) {
      expect(isCashMovementType(type)).toBe(true);
    }
    for (const type of ["refund", "void", "adjustment", "", 3]) {
      expect(isCashMovementType(type)).toBe(false);
    }
  });

  it("refuses a movement with an unknown type", () => {
    expect(parseCashMovementsResult({ ok: true, cashMovements: [{ ...MOVEMENT, movementType: "refund" }] }))
      .toEqual({ ok: false, code: "unavailable" });
  });

  it("keeps the amount as exact text, never a float", () => {
    const result = parseCashMovementsResult({ ok: true, cashMovements: [MOVEMENT] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cashMovements[0].amount).toBe("100.00");
    expect(typeof result.cashMovements[0].amount).toBe("string");
  });

  it("carries a numeric amount through as its exact text", () => {
    const result = parseCashMovementsResult({
      ok: true,
      cashMovements: [{ ...MOVEMENT, amount: 12.5 }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cashMovements[0].amount).toBe("12.5");
  });

  it("requires the stored business date -- a movement without one is unreadable", () => {
    expect(parseCashMovementsResult({ ok: true, cashMovements: [{ ...MOVEMENT, businessDate: null }] }))
      .toEqual({ ok: false, code: "unavailable" });
  });

  it("allows an absent note only where the server allows it", () => {
    const result = parseCashMovementsResult({ ok: true, cashMovements: [{ ...MOVEMENT, note: null }] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cashMovements[0].note).toBeNull();
  });

  it("fails the report rather than dropping an unreadable movement", () => {
    expect(parseCashMovementsResult({ ok: true, cashMovements: [MOVEMENT, { movementId: "x" }] }))
      .toEqual({ ok: false, code: "unavailable" });
  });
});

describe("registered-order business dates", () => {
  const DATES = [{ orderId: "o1", businessDate: "2026-09-20" }];

  it("parses the pairs", () => {
    expect(parseOrderBusinessDatesResult({ ok: true, orderBusinessDates: DATES }))
      .toEqual({ ok: true, orderBusinessDates: DATES });
  });

  it("finds a registered order's authoritative date", () => {
    expect(findOrderBusinessDate(DATES, "o1")).toBe("2026-09-20");
  });

  it("returns NULL for an order the product never recorded one for", () => {
    // Null is the signal to fall back at the presentation layer. It is never
    // filled in here, and never bucketed by a viewer's clock.
    expect(findOrderBusinessDate(DATES, "legacy")).toBeNull();
    expect(findOrderBusinessDate([], "o1")).toBeNull();
  });

  it("refuses a pair with a missing date rather than inventing one", () => {
    expect(parseOrderBusinessDatesResult({ ok: true, orderBusinessDates: [{ orderId: "o1" }] }))
      .toEqual({ ok: false, code: "unavailable" });
  });
});

describe("role mutation parsing", () => {
  it("accepts a well-formed success", () => {
    expect(
      parseSetEmployeeRoleResult({
        ok: true,
        employeeId: "e1",
        displayName: "Bo",
        role: "cashier",
        active: true,
      })
    ).toEqual({ ok: true, employeeId: "e1", displayName: "Bo", role: "cashier", active: true });
  });

  it("refuses a success carrying a role that is not one of the three", () => {
    expect(
      parseSetEmployeeRoleResult({ ok: true, employeeId: "e1", role: "supervisor", active: true })
    ).toEqual({ ok: false, code: "unavailable" });
  });

  it("carries invalid_role, not_found and not_authenticated through", () => {
    for (const error of ["invalid_role", "not_found", "not_authenticated"] as const) {
      expect(parseSetEmployeeRoleResult({ ok: false, error })).toEqual({ ok: false, code: error });
    }
  });
});

describe("messages", () => {
  it("never speculates about why a project was not found", () => {
    const message = getOwnerReportMessage("not_found");

    expect(message).not.toMatch(/permission|forbidden|owner|device/i);
  });
});
