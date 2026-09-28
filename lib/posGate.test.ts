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
  SALE_DAILY_NOT_PAIRED,
  SALE_DAILY_TIMEZONE_CONFLICT,
  SALE_DAILY_TIMEZONE_REQUIRED,
  SALE_REGISTER_CHANGED,
  SALE_REGISTER_CLOSED,
  applyDailyRefresh,
  applyEmployeeAuthenticated,
  applySaleAttributionFailure,
  buildOfflineClaims,
  canCheckoutOffline,
  classifySaleAttributionFailure,
  clearPosGateState,
  describePosGateBlock,
  resolvePosGate,
} from "@/lib/posGate";
import type { PosGateState } from "@/lib/posGate";
import type { EmployeeSession } from "@/lib/employeeSession";
import type { DailyRegisterContext } from "@/lib/dailyRegister";

const ADA: EmployeeSession = {
  employeeSessionId: "sess-ada",
  employeeId: "emp-ada",
  displayName: "Ada",
  role: "cashier",
  startedAt: "2026-09-18T02:00:00.000Z",
};

/** A business day, exactly as ensure_daily_register_context() reports one. */
const TODAY: DailyRegisterContext = {
  registerSessionId: "daily-1",
  businessDate: "2026-09-18",
  businessTimezone: "America/New_York",
  openedAt: "2026-09-18T04:00:00.000Z",
  closedAt: "2026-09-19T04:00:00.000Z",
};

const established: PosGateState = {
  employee: ADA,
  daily: TODAY,
  establishedOnline: true,
  recovery: null,
  setup: null,
};

describe("which gate the till stands at", () => {
  it("asks for an employee first", () => {
    expect(resolvePosGate(EMPTY_POS_GATE_STATE)).toBe("employee");
  });

  it("asks for today's business day once an employee is signed in", () => {
    expect(
      resolvePosGate({ employee: ADA, daily: null, establishedOnline: false, recovery: null, setup: null })
    ).toBe("daily");
  });

  it("opens the POS only when both exist", () => {
    expect(resolvePosGate(established)).toBe("pos");
  });

  it("returns to the employee gate when the employee is gone, even with a register", () => {
    // The order is the contract: a register cannot be opened — or sold
    // through — without someone signed in.
    expect(
      resolvePosGate({ employee: null, daily: TODAY, establishedOnline: false, recovery: null, setup: null })
    ).toBe("employee");
  });
});

describe("what a pending gate tells the runtime's checkout fence", () => {
  // Fed to PosRuntime's checkoutBlockedReason, which is the FIRST statement in
  // completeSale. The overlay stops a person reaching the button; this stops
  // the sale whatever else happens.
  it("names the gate that is pending", () => {
    expect(describePosGateBlock(EMPTY_POS_GATE_STATE)).toBe(
      "Sign in an employee before taking a sale."
    );
    expect(
      describePosGateBlock({ employee: ADA, daily: null, establishedOnline: false, recovery: null, setup: null })
    ).toBe("Reconnect to establish today's register before taking a sale.");

    // The one setup problem a cashier cannot fix says so in its own words.
    expect(
      describePosGateBlock({ ...established, setup: "business_timezone" })
    ).toBe("Set this business's timezone before taking a sale.");
  });

  it("blocks while EITHER recovery is pending, however complete the state looks", () => {
    expect(describePosGateBlock({ ...established, recovery: "employee" })).toBe(
      "Sign in an employee before taking a sale."
    );
    expect(describePosGateBlock({ ...established, recovery: "daily" })).toBe(
      "Reconnect to establish today's register before taking a sale."
    );
  });

  it("blocks after every kind of refusal", () => {
    for (const failure of [
      "employee_changed",
      "employee_missing",
      "register_changed",
      "register_closed",
      "expectations_missing",
    ] as const) {
      expect(describePosGateBlock(applySaleAttributionFailure(established, failure))).not.toBeNull();
    }
  });

  it("and blocks nothing once both are established", () => {
    expect(describePosGateBlock(established)).toBeNull();
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
    expect(canCheckoutOffline({ employee: ADA, daily: null, establishedOnline: false, recovery: null, setup: null }).ok).toBe(
      false
    );
  });

  it("blocks when only the register is established", () => {
    expect(
      canCheckoutOffline({ employee: null, daily: TODAY, establishedOnline: false, recovery: null, setup: null }).ok
    ).toBe(false);
  });

  it("blocks values that were never confirmed by the server, however complete they look", () => {
    // The whole point of establishedOnline: holding an employee and a register
    // is not the same as having derived them. A till that assembled this from
    // stale UI state must not sell on it.
    expect(canCheckoutOffline({ employee: ADA, daily: TODAY, establishedOnline: false, recovery: null, setup: null }).ok).toBe(
      false
    );
  });
});

describe("what a queued offline sale claims", () => {
  it("carries the employee session and the RETAINED DAILY id as claims", () => {
    expect(buildOfflineClaims(established)).toEqual({
      employeePosSessionId: "sess-ada",
      registerSessionId: "daily-1",
    });
  });

  it("claims nothing it does not hold", () => {
    expect(buildOfflineClaims(EMPTY_POS_GATE_STATE)).toEqual({
      employeePosSessionId: null,
      registerSessionId: null,
    });
  });
});

describe("explicit authentication is the only way state is established", () => {
  const same = { ok: true, session: ADA } as const;

  it("establishes when the day comes back and the operator is still the same", () => {
    expect(
      applyEmployeeAuthenticated({
        employee: ADA,
        daily: { ok: true, context: TODAY },
        revalidated: same,
      })
    ).toEqual(established);
  });

  it("does NOT establish when the business has no timezone — that is setup, not recovery", () => {
    expect(
      applyEmployeeAuthenticated({
        employee: ADA,
        daily: { ok: false, reason: "timezone_required" },
        revalidated: same,
      })
    ).toEqual({
      employee: ADA,
      daily: null,
      establishedOnline: false,
      recovery: null,
      setup: "business_timezone",
    });
  });

  it("does NOT establish when the day was refused — that is an exception", () => {
    expect(
      applyEmployeeAuthenticated({
        employee: ADA,
        daily: { ok: false, reason: "conflict" },
        revalidated: same,
      })
    ).toEqual({
      employee: ADA,
      daily: null,
      establishedOnline: false,
      recovery: "daily",
      setup: null,
    });
  });

  it("LOCKS when the POS session changed while the day was being established", () => {
    // The race CP2d exists to close. Same person, new session id, is NOT the
    // same authority — and a failed re-read is not evidence either way, so it
    // locks too.
    const reborn: EmployeeSession = { ...ADA, employeeSessionId: "sess-ada-2" };

    expect(
      applyEmployeeAuthenticated({
        employee: ADA,
        daily: { ok: true, context: TODAY },
        revalidated: { ok: true, session: reborn },
      })
    ).toEqual(EMPTY_POS_GATE_STATE);

    expect(
      applyEmployeeAuthenticated({
        employee: ADA,
        daily: { ok: true, context: TODAY },
        revalidated: { ok: true, session: null },
      })
    ).toEqual(EMPTY_POS_GATE_STATE);

    expect(
      applyEmployeeAuthenticated({
        employee: ADA,
        daily: { ok: true, context: TODAY },
        revalidated: { ok: false },
      })
    ).toEqual(EMPTY_POS_GATE_STATE);
  });

  it("a refresh can only ever ADD — it never takes the till away", () => {
    // Offline, or any unreachable server: everything is kept.
    expect(applyDailyRefresh(established, { ok: false, reason: "unavailable" })).toEqual(established);

    // A till with nobody signed in is not a way in.
    expect(applyDailyRefresh(EMPTY_POS_GATE_STATE, { ok: true, context: TODAY })).toEqual(
      EMPTY_POS_GATE_STATE
    );

    // A newer day replaces the old one, with the operator untouched.
    const tomorrow: DailyRegisterContext = { ...TODAY, registerSessionId: "daily-2", businessDate: "2026-09-19" };

    expect(applyDailyRefresh(established, { ok: true, context: tomorrow })).toEqual({
      ...established,
      daily: tomorrow,
    });
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
        ...EMPTY_POS_GATE_STATE,
        recovery: "employee",
      });
    }
  });

  it("CP2c: a timezone CONFLICT keeps the operator and demands a DAILY recovery", () => {
    // Driven from the string complete_sale_v5 actually raises, not from a
    // recovery this test set up for itself. That is the whole point: the defect
    // CP2e found was that the real refusal never reached a state at all.
    expect(classifySaleAttributionFailure(SALE_DAILY_TIMEZONE_CONFLICT)).toBe("daily_conflict");

    const refused = applySaleAttributionFailure(established, "daily_conflict");

    expect(refused).toEqual({
      employee: ADA,
      daily: null,
      establishedOnline: false,
      recovery: "daily",
      setup: null,
    });
    // The operator is NOT signed out and no PIN is demanded for a calendar
    // problem; the gate is the daily one.
    expect(refused.employee).toEqual(ADA);
    expect(resolvePosGate(refused)).toBe("daily");
    expect(canCheckoutOffline(refused).ok).toBe(false);
  });

  it("CP2c: a MISSING business timezone is setup, not recovery", () => {
    expect(classifySaleAttributionFailure(SALE_DAILY_TIMEZONE_REQUIRED)).toBe("timezone_required");

    const refused = applySaleAttributionFailure(established, "timezone_required");

    expect(refused).toEqual({
      employee: ADA,
      daily: null,
      establishedOnline: false,
      recovery: null,
      setup: "business_timezone",
    });
    // No recovery is raised, because retrying at this till cannot succeed until
    // somebody configures the business.
    expect(refused.recovery).toBeNull();
    expect(resolvePosGate(refused)).toBe("timezone");
    expect(describePosGateBlock(refused)).toBe("Set this business's timezone before taking a sale.");
    expect(canCheckoutOffline(refused).ok).toBe(false);
  });

  it("CP2c: both survive PostgREST's wrapping, as the Feature 1B strings do", () => {
    expect(classifySaleAttributionFailure(`error running query: ${SALE_DAILY_TIMEZONE_CONFLICT}`))
      .toBe("daily_conflict");
    expect(classifySaleAttributionFailure(`error running query: ${SALE_DAILY_TIMEZONE_REQUIRED}`))
      .toBe("timezone_required");
  });

  it("CP2c: `not_paired` is DELIBERATELY unclassified", () => {
    // daily_register_context_for_sale can return it and v5 would re-raise it
    // the same way. There is no cashier state for a till that is not paired --
    // no operator to retain, no day to recover, nothing at the counter to
    // configure -- so it falls through to the generic failure path on purpose.
    expect(classifySaleAttributionFailure(SALE_DAILY_NOT_PAIRED)).toBeNull();
    expect(classifySaleAttributionFailure(`error running query: ${SALE_DAILY_NOT_PAIRED}`)).toBeNull();
  });

  it("an unrecognised refusal still changes nothing", () => {
    for (const message of [
      "Insufficient inventory for Coffee",
      "Menu item foodtruck-1 is not available",
      "some_future_contract_code",
    ]) {
      expect(`${message}: ${classifySaleAttributionFailure(message)}`).toBe(`${message}: null`);
    }
  });

  it("a register refusal keeps the employee and demands a DAILY recovery", () => {
    // v1.3 CP2d — an ordinary midnight never gets here: complete_sale_v5 rolls
    // the sale forward itself. A refusal that still reaches the till is an
    // exception, and it is the DAY that must be re-established, not a drawer.
    for (const failure of ["register_changed", "register_closed"] as const) {
      expect(applySaleAttributionFailure(established, failure)).toEqual({
        employee: ADA,
        daily: null,
        establishedOnline: false,
        recovery: "daily",
        setup: null,
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
