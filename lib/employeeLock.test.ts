// v1.3 Feature 1B-RUNTIME checkpoint 2 — the primary employee lock.
//
// THE RULE THIS FILE EXISTS FOR, stated once: a server observation is not an
// operator. `get_current_employee_session` answering "Ada is signed in" says
// something true about the server and nothing at all about who is standing at
// this till. A POS session outlives a reload, an app switch, a battery swap and
// a shift change, so unlocking on it would reopen the till under whoever was
// last authenticated, for anyone who picks it up.
//
// Only an Employee ID and a PIN, typed here, in this app run, unlock the POS.
import { describe, expect, it } from "vitest";
import {
  EMPTY_POS_GATE_STATE,
  applyEmployeeAuthenticated,
  applyReconnectDerivation,
  applySaleAttributionFailure,
  applyStartupLock,
  buildOfflineClaims,
  canCheckoutOffline,
  resolvePosGate,
} from "@/lib/posGate";
import type { PosGateState } from "@/lib/posGate";
import { isValidEmployeeCodeShape, isValidEmployeePinShape } from "@/lib/employeeSession";
import type { EmployeeSession } from "@/lib/employeeSession";
import type { RegisterSession } from "@/lib/registerSession";

const ADA: EmployeeSession = {
  employeeSessionId: "sess-ada",
  employeeId: "emp-ada",
  displayName: "Ada",
  role: "cashier",
  startedAt: "2026-09-19T08:00:00.000Z",
};

const BO: EmployeeSession = {
  ...ADA,
  employeeSessionId: "sess-bo",
  employeeId: "emp-bo",
  displayName: "Bo",
};

/** Ada, signed in again later — same person, a DIFFERENT session. */
const ADA_AGAIN: EmployeeSession = { ...ADA, employeeSessionId: "sess-ada-2" };

const REGISTER: RegisterSession = {
  registerSessionId: "reg-1",
  openedAt: "2026-09-19T08:05:00.000Z",
  openedByEmployeeId: "emp-ada",
  openingCash: "125.50",
  closedAt: null,
  closedByEmployeeId: null,
};

const OTHER_REGISTER: RegisterSession = { ...REGISTER, registerSessionId: "reg-2" };

// ---------------------------------------------------------------------------
// Employee ID and PIN shapes
// ---------------------------------------------------------------------------

describe("the Employee ID a cashier types", () => {
  it("accepts 001 through 999", () => {
    for (const code of ["001", "010", "123", "500", "999"]) {
      expect(`${code}: ${isValidEmployeeCodeShape(code)}`).toBe(`${code}: true`);
    }
  });

  it("refuses 000 — it reads as 'no employee' on a keypad", () => {
    expect(isValidEmployeeCodeShape("000")).toBe(false);
  });

  it("refuses anything that is not exactly three digits", () => {
    for (const code of ["", "1", "01", "1000", "12a", "abc", " 12", "12 ", "1.2", "-12", "١٢٣"]) {
      expect(`${JSON.stringify(code)}: ${isValidEmployeeCodeShape(code)}`).toBe(
        `${JSON.stringify(code)}: false`
      );
    }
  });

  it("refuses anything that is not a string", () => {
    for (const code of [123, null, undefined, {}, ["001"]]) {
      expect(isValidEmployeeCodeShape(code)).toBe(false);
    }
  });

  it("says nothing about whether the ID exists", () => {
    // Shape only. Whether `999` is somebody is the server's answer, and it is
    // deliberately indistinguishable from a wrong PIN.
    expect(isValidEmployeeCodeShape("999")).toBe(true);
  });
});

describe("the PIN", () => {
  it("is exactly four digits", () => {
    expect(isValidEmployeePinShape("1234")).toBe(true);

    for (const pin of ["", "1", "123", "12345", "123456", "abcd", "12 4", "12.4"]) {
      expect(`${JSON.stringify(pin)}: ${isValidEmployeePinShape(pin)}`).toBe(
        `${JSON.stringify(pin)}: false`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

describe("startup and reload leave the till LOCKED", () => {
  it("a cold start is locked", () => {
    expect(applyStartupLock()).toEqual(EMPTY_POS_GATE_STATE);
    expect(resolvePosGate(applyStartupLock())).toBe("employee");
  });

  it("an observed server session does NOT unlock it", () => {
    // THE CHECKPOINT-2 RULE. The server reports Ada signed in with a register
    // open — the most tempting possible observation — and the till stays locked
    // because nobody has authenticated here.
    const observed = applyReconnectDerivation(applyStartupLock(), {
      employee: ADA,
      register: REGISTER,
    });

    expect(observed.employee).toBeNull();
    expect(observed.register).toBeNull();
    expect(observed.establishedOnline).toBe(false);
    expect(resolvePosGate(observed)).toBe("employee");
  });

  it("no number of re-reads unlocks it", () => {
    let state = applyStartupLock();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      state = applyReconnectDerivation(state, { employee: ADA, register: REGISTER });
    }

    expect(resolvePosGate(state)).toBe("employee");
  });

  it("and nothing observed can be claimed on an offline sale", () => {
    const observed = applyReconnectDerivation(applyStartupLock(), {
      employee: ADA,
      register: REGISTER,
    });

    expect(buildOfflineClaims(observed)).toEqual({
      employeePosSessionId: null,
      registerSessionId: null,
    });
    expect(canCheckoutOffline(observed).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Explicit authentication
// ---------------------------------------------------------------------------

describe("explicit Employee ID + PIN authentication", () => {
  it("unlocks the POS when a register is already open", () => {
    const authenticated = applyEmployeeAuthenticated({ employee: ADA, register: REGISTER });

    expect(authenticated.employee).toEqual(ADA);
    expect(authenticated.register).toEqual(REGISTER);
    expect(authenticated.establishedOnline).toBe(true);
    expect(resolvePosGate(authenticated)).toBe("pos");
  });

  it("REUSES the open register — it does not rotate it", () => {
    const authenticated = applyEmployeeAuthenticated({ employee: BO, register: REGISTER });

    // Same session id, same opening cash, same opened_by. Signing in is not a
    // drawer event, and one register spans many operators.
    expect(authenticated.register).toBe(REGISTER);
    expect(authenticated.register?.registerSessionId).toBe("reg-1");
    expect(authenticated.register?.openingCash).toBe("125.50");
    expect(authenticated.register?.openedByEmployeeId).toBe("emp-ada");
    expect(authenticated.register?.closedAt).toBeNull();
  });

  it("stops at the register gate when no register is open", () => {
    const authenticated = applyEmployeeAuthenticated({ employee: ADA, register: null });

    expect(authenticated.employee).toEqual(ADA);
    expect(authenticated.establishedOnline).toBe(false);
    expect(resolvePosGate(authenticated)).toBe("register");
  });

  it("and only then may an offline sale be taken", () => {
    expect(canCheckoutOffline(applyEmployeeAuthenticated({ employee: ADA, register: REGISTER })).ok)
      .toBe(true);
    expect(canCheckoutOffline(applyEmployeeAuthenticated({ employee: ADA, register: null })).ok)
      .toBe(false);
  });

  it("clears any pending recovery, because a person just re-established it", () => {
    expect(applyEmployeeAuthenticated({ employee: ADA, register: REGISTER }).recovery).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reconnect
// ---------------------------------------------------------------------------

describe("reconnect keeps an authenticated operator, and only them", () => {
  const authenticated = applyEmployeeAuthenticated({ employee: ADA, register: REGISTER });

  it("a flapping connection is not a shift change", () => {
    const after = applyReconnectDerivation(authenticated, {
      employee: ADA,
      register: REGISTER,
    });

    expect(after.employee).toEqual(ADA);
    expect(resolvePosGate(after)).toBe("pos");
  });

  it("it picks up a register that was opened meanwhile", () => {
    const after = applyReconnectDerivation(
      applyEmployeeAuthenticated({ employee: ADA, register: null }),
      { employee: ADA, register: REGISTER }
    );

    expect(after.register).toEqual(REGISTER);
    expect(resolvePosGate(after)).toBe("pos");
  });

  it("it LOCKS when the server reports a different employee", () => {
    const after = applyReconnectDerivation(authenticated, { employee: BO, register: REGISTER });

    expect(after.employee).toBeNull();
    expect(resolvePosGate(after)).toBe("employee");
  });

  it("a new session for the SAME person also locks", () => {
    // The cashier believes Ada is signed in; the server would attribute a sale
    // to a different session. Same person is not the same session.
    const after = applyReconnectDerivation(authenticated, {
      employee: ADA_AGAIN,
      register: REGISTER,
    });

    expect(after.employee).toBeNull();
    expect(resolvePosGate(after)).toBe("employee");
  });

  it("it locks when the server reports nobody", () => {
    expect(resolvePosGate(applyReconnectDerivation(authenticated, { employee: null, register: REGISTER })))
      .toBe("employee");
  });

  it("it cannot unlock a locked till, whatever it sees", () => {
    expect(resolvePosGate(applyReconnectDerivation(EMPTY_POS_GATE_STATE, {
      employee: ADA,
      register: REGISTER,
    }))).toBe("employee");
  });

  it("a pending recovery survives a reconnect", () => {
    const recovering: PosGateState = { ...authenticated, recovery: "register" };
    const after = applyReconnectDerivation(recovering, { employee: ADA, register: OTHER_REGISTER });

    expect(after.recovery).toBe("register");
    expect(resolvePosGate(after)).toBe("register");
  });
});

// ---------------------------------------------------------------------------
// Stale employee recovery, through the same lock surface
// ---------------------------------------------------------------------------

describe("stale employee recovery uses the same lock, and needs a PIN", () => {
  const established = applyEmployeeAuthenticated({ employee: ADA, register: REGISTER });
  const refused = applySaleAttributionFailure(established, "employee_changed");

  it("the refusal locks the till and names the reason", () => {
    expect(refused.employee).toBeNull();
    expect(refused.recovery).toBe("employee");
    expect(resolvePosGate(refused)).toBe("employee");
  });

  it("re-reading the server does not unlock it", () => {
    expect(resolvePosGate(applyReconnectDerivation(refused, { employee: BO, register: REGISTER })))
      .toBe("employee");
  });

  it("offline checkout stays blocked throughout", () => {
    expect(canCheckoutOffline(refused).ok).toBe(false);
  });

  it("explicit authentication is what resolves it", () => {
    const recovered = applyEmployeeAuthenticated({ employee: BO, register: REGISTER });

    expect(recovered.recovery).toBeNull();
    expect(resolvePosGate(recovered)).toBe("pos");
    expect(buildOfflineClaims(recovered).employeePosSessionId).toBe("sess-bo");
  });

  it("and the register is reused, not rotated, by that recovery", () => {
    expect(applyEmployeeAuthenticated({ employee: BO, register: REGISTER }).register).toBe(REGISTER);
  });
});

describe("employee recovery does not weaken stale-REGISTER protection", () => {
  const established = applyEmployeeAuthenticated({ employee: ADA, register: REGISTER });

  it("a register refusal still demands its own explicit recovery", () => {
    const refused = applySaleAttributionFailure(established, "register_changed");

    expect(refused.recovery).toBe("register");
    expect(refused.register).toBeNull();
    expect(resolvePosGate(refused)).toBe("register");
  });

  it("authenticating an employee does not adopt a changed register", () => {
    // The combined case. Signing in again is permission to operate, not
    // permission to accept a drawer period nobody chose: the register handed to
    // applyEmployeeAuthenticated is whatever the server reports at that moment,
    // and a pending register recovery is resolved by its own explicit path.
    const registerRecovery = applySaleAttributionFailure(established, "register_changed");
    const reconnected = applyReconnectDerivation(registerRecovery, {
      employee: ADA,
      register: OTHER_REGISTER,
    });

    expect(reconnected.recovery).toBe("register");
    expect(resolvePosGate(reconnected)).toBe("register");
    expect(canCheckoutOffline(reconnected).ok).toBe(false);
  });
});
