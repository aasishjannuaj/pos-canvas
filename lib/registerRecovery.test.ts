// v1.3 Feature 1B-RUNTIME correction 3 — explicit register adoption
// revalidates the EMPLOYEE as well as the register.
//
// THE DEFECT. A register recovery deliberately keeps the employee: they were
// not what the server disproved. The adopt path then read only the register, so
// it could pair a LOCALLY-HELD Ada with a FRESHLY-READ register B and mark the
// pair established — although the server may have moved to Bo in the window
// between the observe pass and the operator's press. Nothing proved Ada was
// still signed in.
//
// WHY THAT PAIR IS DANGEROUS RATHER THAN MERELY WRONG. An online v5 sale would
// refuse the stale employee expectation, so the money is safe while the network
// is up. But `establishedOnline` is exactly what Policy 1 reads: if the
// connection dropped after such an adoption, the till would take a NEW OFFLINE
// SALE under an employee the server had already replaced — a sale that goes to
// disk, and whose claim can never be proven at sync time.
//
// THE RULE. The press authorizes taking the REGISTER. It is not authorization
// to switch EMPLOYEE.
import { describe, expect, it } from "vitest";
import {
  applyExplicitRegisterEstablished,
  applySaleAttributionFailure,
  buildOfflineClaims,
  canCheckoutOffline,
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

/** A DIFFERENT PERSON. */
const BO: EmployeeSession = {
  ...ADA,
  employeeSessionId: "sess-bo",
  employeeId: "emp-bo",
  displayName: "Bo",
};

/**
 * THE SAME PERSON, A NEW SESSION — Ada signed out and back in.
 *
 * The case that a weaker comparison would wave through: same employee id, same
 * display name, different POS session. complete_sale_v5 compares session ids,
 * so accepting this here would only move the refusal later.
 */
const ADA_AGAIN: EmployeeSession = {
  ...ADA,
  employeeSessionId: "sess-ada-2",
  startedAt: "2026-09-18T03:00:00.000Z",
};

const REGISTER_A: RegisterSession = {
  registerSessionId: "reg-a",
  openedAt: "2026-09-18T02:05:00.000Z",
  openedByEmployeeId: "emp-ada",
  openingCash: "25.50",
  closedAt: null,
  closedByEmployeeId: null,
};

const REGISTER_B: RegisterSession = {
  ...REGISTER_A,
  registerSessionId: "reg-b",
  openedByEmployeeId: "emp-bo",
  openingCash: "100.00",
};

const established: PosGateState = {
  employee: ADA,
  register: REGISTER_A,
  establishedOnline: true,
  recovery: null,
};

/** Ada retained, register cleared, recovery pending — awaiting the press. */
const registerRecovery = applySaleAttributionFailure(established, "register_changed");

describe("1. same employee session + open register", () => {
  const adopted = applyExplicitRegisterEstablished(registerRecovery, {
    ok: true,
    employee: ADA,
    register: REGISTER_B,
  });

  it("the adoption succeeds", () => {
    expect(adopted.register).toEqual(REGISTER_B);
    expect(adopted.employee).toEqual(ADA);
  });

  it("the recovery is cleared and the POS may reopen", () => {
    expect(adopted.recovery).toBeNull();
    expect(adopted.establishedOnline).toBe(true);
    expect(resolvePosGate(adopted)).toBe("pos");
  });

  it("and only then may an offline sale be taken", () => {
    expect(canCheckoutOffline(adopted).ok).toBe(true);
    expect(buildOfflineClaims(adopted)).toEqual({
      employeePosSessionId: "sess-ada",
      registerSessionId: "reg-b",
    });
  });

  it("the employee stored is the SERVER's, which has just been proven identical", () => {
    expect(adopted.employee?.employeeSessionId).toBe(ADA.employeeSessionId);
  });
});

describe("2. different employee session + open register", () => {
  // The failure scenario from the review, exactly: the server moved to Bo
  // between the observe pass and the press.
  const result = applyExplicitRegisterEstablished(registerRecovery, {
    ok: true,
    employee: BO,
    register: REGISTER_B,
  });

  it("escalates to an EMPLOYEE recovery", () => {
    expect(result.recovery).toBe("employee");
    expect(resolvePosGate(result)).toBe("employee");
  });

  it("does NOT adopt the register", () => {
    expect(result.register).toBeNull();
  });

  it("does NOT establish", () => {
    expect(result.establishedOnline).toBe(false);
  });

  it("does NOT adopt Bo either — pressing a register button is not a login", () => {
    expect(result.employee).toBeNull();
  });

  it("A NEW SESSION FOR THE SAME PERSON IS STILL A DIFFERENT SESSION", () => {
    // Compared by POS session identity, not by employee id or display name.
    const sameNameNewSession = applyExplicitRegisterEstablished(registerRecovery, {
      ok: true,
      employee: ADA_AGAIN,
      register: REGISTER_B,
    });

    expect(sameNameNewSession.recovery).toBe("employee");
    expect(sameNameNewSession.establishedOnline).toBe(false);
    expect(sameNameNewSession.employee).toBeNull();
  });
});

describe("3. employee missing", () => {
  const result = applyExplicitRegisterEstablished(registerRecovery, {
    ok: true,
    employee: null,
    register: REGISTER_B,
  });

  it("escalates to an employee recovery", () => {
    expect(result.recovery).toBe("employee");
    expect(result.employee).toBeNull();
    expect(resolvePosGate(result)).toBe("employee");
  });

  it("establishes nothing, and takes no register", () => {
    expect(result.establishedOnline).toBe(false);
    expect(result.register).toBeNull();
  });
});

describe("4. register missing", () => {
  const result = applyExplicitRegisterEstablished(registerRecovery, {
    ok: true,
    employee: ADA,
    register: null,
  });

  it("stays at the register recovery — there is nothing to take", () => {
    expect(result.recovery).toBe("register");
    expect(resolvePosGate(result)).toBe("register");
  });

  it("keeps the confirmed employee signed in", () => {
    expect(result.employee).toEqual(ADA);
  });

  it("establishes nothing", () => {
    expect(result.establishedOnline).toBe(false);
  });
});

describe("5 + 6. a failed read establishes nothing", () => {
  // Both reads collapse to one case on purpose: "the server says nobody is
  // signed in" and "we could not ask" must never become the same transition.
  const result = applyExplicitRegisterEstablished(registerRecovery, { ok: false });

  it("leaves the till safely gated", () => {
    expect(result.establishedOnline).toBe(false);
    expect(result.recovery).toBe("register");
    expect(resolvePosGate(result)).toBe("register");
  });

  it("does not invent a register", () => {
    expect(result.register).toBeNull();
  });

  it("does not sign the retained employee out either — nothing was learned", () => {
    expect(result.employee).toEqual(ADA);
  });

  it("a retry after the connection returns still works normally", () => {
    const retried = applyExplicitRegisterEstablished(result, {
      ok: true,
      employee: ADA,
      register: REGISTER_B,
    });

    expect(retried.establishedOnline).toBe(true);
    expect(retried.recovery).toBeNull();
  });
});

describe("7. offline checkout stays blocked through every escalation", () => {
  for (const [name, observation] of [
    ["different employee", { ok: true, employee: BO, register: REGISTER_B }],
    ["same person, new session", { ok: true, employee: ADA_AGAIN, register: REGISTER_B }],
    ["employee missing", { ok: true, employee: null, register: REGISTER_B }],
    ["register missing", { ok: true, employee: ADA, register: null }],
    ["read failure", { ok: false }],
  ] as const) {
    it(`${name}: canCheckoutOffline is false`, () => {
      const result = applyExplicitRegisterEstablished(registerRecovery, observation);

      expect(canCheckoutOffline(result).ok).toBe(false);
    });
  }

  it("the recovery state itself blocks it before any press", () => {
    expect(canCheckoutOffline(registerRecovery).ok).toBe(false);
  });
});

describe("8. no observed employee becomes an offline claim", () => {
  for (const [name, observation] of [
    ["different employee", { ok: true, employee: BO, register: REGISTER_B }],
    ["same person, new session", { ok: true, employee: ADA_AGAIN, register: REGISTER_B }],
    ["employee missing", { ok: true, employee: null, register: REGISTER_B }],
  ] as const) {
    it(`${name}: claims nothing`, () => {
      const claims = buildOfflineClaims(
        applyExplicitRegisterEstablished(registerRecovery, observation)
      );

      expect(claims.employeePosSessionId).toBeNull();
      expect(claims.registerSessionId).toBeNull();
    });
  }

  it("a register that was never adopted can never be claimed", () => {
    const result = applyExplicitRegisterEstablished(registerRecovery, {
      ok: true,
      employee: BO,
      register: REGISTER_B,
    });

    expect(JSON.stringify(result)).not.toContain("reg-b");
    expect(JSON.stringify(result)).not.toContain("sess-bo");
  });
});

describe("9. establishing out of a register recovery has exactly one shape", () => {
  it("the ONLY establishing outcome is same-session plus an open register", () => {
    // The whole truth table, asserted as a table. Exactly one row establishes.
    const rows = [
      { employee: ADA, register: REGISTER_B, establishes: true },
      { employee: ADA, register: REGISTER_A, establishes: true },
      { employee: BO, register: REGISTER_B, establishes: false },
      { employee: ADA_AGAIN, register: REGISTER_B, establishes: false },
      { employee: null, register: REGISTER_B, establishes: false },
      { employee: ADA, register: null, establishes: false },
      { employee: BO, register: null, establishes: false },
      { employee: null, register: null, establishes: false },
    ] as const;

    for (const row of rows) {
      const result = applyExplicitRegisterEstablished(registerRecovery, {
        ok: true,
        employee: row.employee,
        register: row.register,
      });

      expect({
        employee: row.employee?.employeeSessionId ?? null,
        register: row.register?.registerSessionId ?? null,
        establishes: result.establishedOnline,
      }).toEqual({
        employee: row.employee?.employeeSessionId ?? null,
        register: row.register?.registerSessionId ?? null,
        establishes: row.establishes,
      });
    }
  });

  it("a state with no retained employee cannot establish at all", () => {
    // Fail closed: there is nothing to revalidate against.
    const orphaned = applyExplicitRegisterEstablished(
      { employee: null, register: null, establishedOnline: false, recovery: "register" },
      { ok: true, employee: ADA, register: REGISTER_B }
    );

    expect(orphaned.establishedOnline).toBe(false);
    expect(orphaned.recovery).toBe("employee");
    expect(orphaned.employee).toBeNull();
  });

  it("repeated presses never accumulate into an establishment", () => {
    let state = registerRecovery;

    for (let press = 0; press < 5; press += 1) {
      state = applyExplicitRegisterEstablished(state, {
        ok: true,
        employee: BO,
        register: REGISTER_B,
      });
    }

    expect(state.establishedOnline).toBe(false);
    expect(state.recovery).toBe("employee");
  });
});

// ---------------------------------------------------------------------------
// The register-OPEN recovery path, which is the same class
// ---------------------------------------------------------------------------

describe("the Open register path during a recovery is the same class", () => {
  // open_register_session opens under the SERVER's own current employee
  // session — never one the client names (the migration inserts
  // v_employee_session.employee_id). So a register opened during a recovery
  // while the server holds Bo belongs to Bo, and an establishing derivation
  // would then adopt Bo: a register recovery silently becoming an employee
  // switch. The host routes the recovery case through this same transition.
  it("an open performed while the server holds a different employee cannot establish", () => {
    const afterOpen = applyExplicitRegisterEstablished(registerRecovery, {
      ok: true,
      employee: BO,
      register: REGISTER_B,
    });

    expect(afterOpen.establishedOnline).toBe(false);
    expect(afterOpen.recovery).toBe("employee");
    expect(resolvePosGate(afterOpen)).toBe("employee");
  });

  it("an open performed by the retained employee establishes normally", () => {
    const afterOpen = applyExplicitRegisterEstablished(registerRecovery, {
      ok: true,
      employee: ADA,
      register: REGISTER_A,
    });

    expect(afterOpen.establishedOnline).toBe(true);
    expect(afterOpen.recovery).toBeNull();
    expect(resolvePosGate(afterOpen)).toBe("pos");
  });

  it("the escalation still requires a PIN, not another press", () => {
    const escalated = applyExplicitRegisterEstablished(registerRecovery, {
      ok: true,
      employee: BO,
      register: REGISTER_B,
    });

    // Pressing again changes nothing: only an explicit login clears an
    // employee recovery, and that path runs applyServerDerivation.
    expect(
      applyExplicitRegisterEstablished(escalated, {
        ok: true,
        employee: BO,
        register: REGISTER_B,
      }).establishedOnline
    ).toBe(false);
  });
});
