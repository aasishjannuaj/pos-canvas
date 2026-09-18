// v1.3 Feature 1B-RUNTIME — the gate state machine.
//
// Pure in, pure out: no React, no Supabase, no storage. Every runtime rule the
// Control Room locked is expressed here as a value transition.
import { describe, expect, it } from "vitest";
import {
  EMPTY_POS_GATE_STATE,
  SALE_EMPLOYEE_CHANGED,
  SALE_EMPLOYEE_MISSING,
  SALE_EXPECTATIONS_MISSING,
  SALE_REGISTER_CHANGED,
  SALE_REGISTER_CLOSED,
  applySaleAttributionFailure,
  applyServerDerivation,
  buildOfflineClaims,
  canCheckoutOffline,
  classifySaleAttributionFailure,
  clearPosGateState,
  resolvePosGate,
} from "@/lib/posGate";
import type { PosGateState } from "@/lib/posGate";
import type { EmployeeSession } from "@/lib/employeeSession";
import type { RegisterSession } from "@/lib/registerSession";

const ADA: EmployeeSession = {
  employeeSessionId: "sess-ada",
  employeeId: "emp-ada",
  displayName: "Ada",
  role: "cashier",
  startedAt: "2026-09-18T02:00:00.000Z",
};

const REGISTER: RegisterSession = {
  registerSessionId: "reg-1",
  openedAt: "2026-09-18T02:05:00.000Z",
  openedByEmployeeId: "emp-ada",
  openingCash: "25.50",
  closedAt: null,
  closedByEmployeeId: null,
};

const established: PosGateState = { employee: ADA, register: REGISTER, establishedOnline: true, recovery: null };

describe("which gate the till stands at", () => {
  it("asks for an employee first", () => {
    expect(resolvePosGate(EMPTY_POS_GATE_STATE)).toBe("employee");
  });

  it("asks for a register once an employee is signed in", () => {
    expect(resolvePosGate({ employee: ADA, register: null, establishedOnline: false, recovery: null })).toBe("register");
  });

  it("opens the POS only when both exist", () => {
    expect(resolvePosGate(established)).toBe("pos");
  });

  it("returns to the employee gate when the employee is gone, even with a register", () => {
    // The order is the contract: a register cannot be opened — or sold
    // through — without someone signed in.
    expect(resolvePosGate({ employee: null, register: REGISTER, establishedOnline: false, recovery: null })).toBe(
      "employee"
    );
  });
});

describe("Policy 1 — offline checkout needs state established online", () => {
  it("allows a checkout when both were established in this app run", () => {
    expect(canCheckoutOffline(established)).toEqual({ ok: true });
  });

  it("blocks a cold start that established nothing", () => {
    const blocked = canCheckoutOffline(EMPTY_POS_GATE_STATE);

    expect(blocked.ok).toBe(false);
    expect(blocked.ok === false && blocked.reason).toBe("not_established");
  });

  it("blocks when only the employee is established", () => {
    expect(canCheckoutOffline({ employee: ADA, register: null, establishedOnline: false, recovery: null }).ok).toBe(
      false
    );
  });

  it("blocks when only the register is established", () => {
    expect(
      canCheckoutOffline({ employee: null, register: REGISTER, establishedOnline: false, recovery: null }).ok
    ).toBe(false);
  });

  it("blocks values that were never confirmed by the server, however complete they look", () => {
    // The whole point of establishedOnline: holding an employee and a register
    // is not the same as having derived them. A till that assembled this from
    // stale UI state must not sell on it.
    expect(canCheckoutOffline({ employee: ADA, register: REGISTER, establishedOnline: false, recovery: null }).ok).toBe(
      false
    );
  });
});

describe("what a queued offline sale claims", () => {
  it("carries both session ids as claims", () => {
    expect(buildOfflineClaims(established)).toEqual({
      employeePosSessionId: "sess-ada",
      registerSessionId: "reg-1",
    });
  });

  it("claims nothing it does not hold", () => {
    expect(buildOfflineClaims(EMPTY_POS_GATE_STATE)).toEqual({
      employeePosSessionId: null,
      registerSessionId: null,
    });
  });
});

describe("server derivation is the only way state is established", () => {
  it("establishes when both come back", () => {
    expect(applyServerDerivation({ employee: ADA, register: REGISTER })).toEqual(established);
  });

  it("does NOT establish when the register is missing", () => {
    expect(applyServerDerivation({ employee: ADA, register: null })).toEqual({
      employee: ADA,
      register: null,
      establishedOnline: false,
      recovery: null,
    });
  });

  it("does NOT establish when nobody is signed in", () => {
    expect(applyServerDerivation({ employee: null, register: null })).toEqual(EMPTY_POS_GATE_STATE);
  });

  it("clearing drops everything", () => {
    expect(clearPosGateState()).toEqual(EMPTY_POS_GATE_STATE);
  });
});

describe("stale-state refusals from complete_sale_v5", () => {
  it("classifies each refusal the server raises", () => {
    expect(classifySaleAttributionFailure(SALE_EMPLOYEE_CHANGED)).toBe("employee_changed");
    expect(classifySaleAttributionFailure(SALE_EMPLOYEE_MISSING)).toBe("employee_missing");
    expect(classifySaleAttributionFailure(SALE_REGISTER_CHANGED)).toBe("register_changed");
    expect(classifySaleAttributionFailure(SALE_REGISTER_CLOSED)).toBe("register_closed");
    expect(classifySaleAttributionFailure(SALE_EXPECTATIONS_MISSING)).toBe("expectations_missing");
  });

  it("recognises the message inside PostgREST's wrapping", () => {
    expect(
      classifySaleAttributionFailure(`error running query: ${SALE_REGISTER_CHANGED}`)
    ).toBe("register_changed");
  });

  it("leaves an unrelated failure alone", () => {
    // A sale that failed for some other reason must not clear the operator's
    // session as a side effect.
    expect(classifySaleAttributionFailure("Insufficient inventory for Coffee")).toBeNull();
    expect(classifySaleAttributionFailure("Order amounts are not valid")).toBeNull();
    expect(classifySaleAttributionFailure(null)).toBeNull();
  });

  it("an employee refusal drops both sessions and demands an EMPLOYEE recovery", () => {
    for (const failure of ["employee_changed", "employee_missing", "expectations_missing"] as const) {
      expect(applySaleAttributionFailure(established, failure)).toEqual({
        employee: null,
        register: null,
        establishedOnline: false,
        recovery: "employee",
      });
    }
  });

  it("a register refusal keeps the employee and demands a REGISTER recovery", () => {
    for (const failure of ["register_changed", "register_closed"] as const) {
      expect(applySaleAttributionFailure(established, failure)).toEqual({
        employee: ADA,
        register: null,
        establishedOnline: false,
        recovery: "register",
      });
    }
  });

  it("every refusal leaves the till unable to check out offline until it re-derives", () => {
    for (const failure of [
      "employee_changed",
      "employee_missing",
      "register_changed",
      "register_closed",
      "expectations_missing",
    ] as const) {
      expect(canCheckoutOffline(applySaleAttributionFailure(established, failure)).ok).toBe(false);
    }
  });

  it("a switch mid-cart cannot silently become the new employee", () => {
    // The refusal names the employee, so the till forgets who it thought was
    // signed in and REMEMBERS THAT SOMEONE MUST SIGN IN AGAIN. The sale is not
    // resubmitted, and nothing here reuses the old expectation.
    const afterRefusal = applySaleAttributionFailure(established, "employee_changed");

    expect(afterRefusal.employee).toBeNull();
    expect(afterRefusal.recovery).toBe("employee");
    expect(resolvePosGate(afterRefusal)).toBe("employee");
  });
});
