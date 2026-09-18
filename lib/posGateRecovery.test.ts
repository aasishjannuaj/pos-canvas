// v1.3 Feature 1B-RUNTIME correction 1 — stale-expectation recovery.
//
// THE DEFECT THIS FILE EXISTS TO PIN DOWN. After complete_sale_v5 refused a
// sale because the till's expectations were stale, the runtime cleared what was
// disproved and immediately re-derived from the server. The derivation set
// `establishedOnline` back to true whenever an employee and an open register
// both existed — so a till that had just been told "the signed-in employee
// changed" would adopt Bo and reopen the POS on its own. The operator never
// chose Bo. That is the silent adoption the whole expectation mechanism exists
// to prevent, arriving one step later than the mechanism looked.
//
// THE DISTINCTION THE FIX RESTS ON:
//
//   AUTHORITATIVE OBSERVATION   "the server currently reports Bo + register B"
//   ESTABLISHED AUTHORITY       "this operator signed in as Bo and took B"
//
// The refusal invalidates the second without invalidating the first. Only the
// second may reopen the POS, so `recovery` survives the re-read and forces the
// gate no matter what the observation contains.
import { describe, expect, it } from "vitest";
import {
  EMPTY_POS_GATE_STATE,
  applyExplicitRegisterEstablished,
  applyRecoveryObservation,
  applySaleAttributionFailure,
  applyServerDerivation,
  beginEmployeeSwitch,
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

const BO: EmployeeSession = {
  ...ADA,
  employeeSessionId: "sess-bo",
  employeeId: "emp-bo",
  displayName: "Bo",
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

/** Ada + register A, established from the server. The till is selling. */
const established: PosGateState = {
  employee: ADA,
  register: REGISTER_A,
  establishedOnline: true,
  recovery: null,
};

// ---------------------------------------------------------------------------
// EMPLOYEE CHANGED
// ---------------------------------------------------------------------------

describe("employee_changed: the server reports Bo, and the POS must not reopen", () => {
  // The exact scenario in the review: local till believes Ada + register A, the
  // server has moved on to Bo + register B, the sale is refused.
  const refused = applySaleAttributionFailure(established, "employee_changed");
  const observed = applyRecoveryObservation(refused, { employee: BO, register: REGISTER_B });

  it("the refusal itself drops Ada and raises an employee recovery", () => {
    expect(refused.employee).toBeNull();
    expect(refused.register).toBeNull();
    expect(refused.establishedOnline).toBe(false);
    expect(refused.recovery).toBe("employee");
  });

  it("re-reading the server does NOT adopt Bo", () => {
    expect(observed.employee).toBeNull();
    expect(observed.recovery).toBe("employee");
  });

  it("re-reading the server does NOT adopt register B either", () => {
    // Never even stored, so no later code path can reach it.
    expect(observed.register).toBeNull();
  });

  it("the POS MUST NOT reopen — the employee gate is required", () => {
    expect(resolvePosGate(observed)).toBe("employee");
    expect(observed.establishedOnline).toBe(false);
  });

  it("the observation cannot be claimed on an offline sale", () => {
    expect(buildOfflineClaims(observed)).toEqual({
      employeePosSessionId: null,
      registerSessionId: null,
    });
  });

  it("offline checkout stays blocked until state is explicitly re-established", () => {
    expect(canCheckoutOffline(observed).ok).toBe(false);
  });

  it("ONLY an explicit employee login may establish checkout again", () => {
    // What the host does after employee_login succeeds: a plain derivation,
    // which is the ONE path that clears `recovery`. It is reachable only from a
    // successful PIN entry — a person choosing an employee and proving it.
    const afterExplicitLogin = applyServerDerivation({ employee: BO, register: REGISTER_B });

    expect(afterExplicitLogin.recovery).toBeNull();
    expect(afterExplicitLogin.establishedOnline).toBe(true);
    expect(resolvePosGate(afterExplicitLogin)).toBe("pos");
    expect(buildOfflineClaims(afterExplicitLogin).employeePosSessionId).toBe("sess-bo");
  });

  it("no number of re-reads ever establishes on its own", () => {
    // The loop that would otherwise reopen the POS by attrition.
    let state = refused;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      state = applyRecoveryObservation(state, { employee: BO, register: REGISTER_B });
    }

    expect(state.recovery).toBe("employee");
    expect(state.establishedOnline).toBe(false);
    expect(resolvePosGate(state)).toBe("employee");
  });
});

// ---------------------------------------------------------------------------
// EMPLOYEE MISSING
// ---------------------------------------------------------------------------

describe("employee_missing: no automatic POS reopening", () => {
  const refused = applySaleAttributionFailure(established, "employee_missing");

  it("raises an employee recovery", () => {
    expect(refused.recovery).toBe("employee");
  });

  it("does not reopen even if the server has since signed someone in", () => {
    const observed = applyRecoveryObservation(refused, { employee: BO, register: REGISTER_B });

    expect(resolvePosGate(observed)).toBe("employee");
    expect(observed.establishedOnline).toBe(false);
  });

  it("does not reopen when the server reports nobody either", () => {
    const observed = applyRecoveryObservation(refused, { employee: null, register: null });

    expect(resolvePosGate(observed)).toBe("employee");
  });
});

// ---------------------------------------------------------------------------
// REGISTER CHANGED
// ---------------------------------------------------------------------------

describe("register_changed: the employee survives, the register must be re-taken", () => {
  const refused = applySaleAttributionFailure(established, "register_changed");
  const observed = applyRecoveryObservation(refused, { employee: ADA, register: REGISTER_B });

  it("Ada stays signed in — she was not what the server disproved", () => {
    expect(refused.employee).toEqual(ADA);
    expect(refused.recovery).toBe("register");
  });

  it("the changed register is NOT silently adopted", () => {
    expect(observed.register).toBeNull();
    expect(observed.recovery).toBe("register");
  });

  it("the POS MUST NOT continue under the changed register", () => {
    expect(resolvePosGate(observed)).toBe("register");
    expect(observed.establishedOnline).toBe(false);
  });

  it("nothing claims register B on an offline sale", () => {
    expect(buildOfflineClaims(observed).registerSessionId).toBeNull();
  });

  it("offline checkout stays blocked", () => {
    expect(canCheckoutOffline(observed).ok).toBe(false);
  });

  it("an explicit adoption by a person is the way out", () => {
    // The register recovery surface shows which register the server reports and
    // offers a button. THE PRESS is the explicit act; the till never performs
    // it on the operator's behalf — and the adoption revalidates BOTH sessions,
    // which is why the employee is passed here too.
    const adopted = applyExplicitRegisterEstablished(observed, {
      ok: true,
      employee: ADA,
      register: REGISTER_B,
    });

    expect(adopted.recovery).toBeNull();
    expect(adopted.register).toEqual(REGISTER_B);
    expect(adopted.employee).toEqual(ADA);
    expect(resolvePosGate(adopted)).toBe("pos");
    expect(canCheckoutOffline(adopted).ok).toBe(true);
  });

  it("opening a register outright also clears it, because that too is explicit", () => {
    expect(applyServerDerivation({ employee: ADA, register: REGISTER_B }).recovery).toBeNull();
  });

  it("ESCALATES to an employee recovery if the employee ALSO changed", () => {
    // This is what makes the re-read worth performing during a register
    // recovery: it can discover a second, worse mismatch.
    const escalated = applyRecoveryObservation(refused, { employee: BO, register: REGISTER_B });

    expect(escalated.employee).toBeNull();
    expect(escalated.recovery).toBe("employee");
    expect(resolvePosGate(escalated)).toBe("employee");
  });

  it("escalates when the server reports nobody signed in at all", () => {
    const escalated = applyRecoveryObservation(refused, { employee: null, register: REGISTER_B });

    expect(escalated.recovery).toBe("employee");
  });

  it("an explicit adoption with nobody signed in establishes nothing", () => {
    expect(
      applyExplicitRegisterEstablished(EMPTY_POS_GATE_STATE, {
        ok: true,
        employee: ADA,
        register: REGISTER_B,
      })
    ).toEqual({ employee: null, register: null, establishedOnline: false, recovery: "employee" });
  });
});

// ---------------------------------------------------------------------------
// REGISTER CLOSED
// ---------------------------------------------------------------------------

describe("register_closed: the register gate is required", () => {
  const refused = applySaleAttributionFailure(established, "register_closed");

  it("sends the operator to the register gate", () => {
    expect(refused.recovery).toBe("register");
    expect(resolvePosGate(refused)).toBe("register");
  });

  it("stays there even when the server reports a NEW register already open", () => {
    const observed = applyRecoveryObservation(refused, { employee: ADA, register: REGISTER_B });

    expect(resolvePosGate(observed)).toBe("register");
    expect(observed.register).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// EXPECTATIONS MISSING
// ---------------------------------------------------------------------------

describe("expectations_missing: explicit recovery required", () => {
  const refused = applySaleAttributionFailure(established, "expectations_missing");

  it("is treated as the strictest case — back to the employee gate", () => {
    expect(refused.employee).toBeNull();
    expect(refused.register).toBeNull();
    expect(refused.recovery).toBe("employee");
    expect(resolvePosGate(refused)).toBe("employee");
  });

  it("a re-read cannot shortcut it", () => {
    const observed = applyRecoveryObservation(refused, { employee: ADA, register: REGISTER_A });

    expect(resolvePosGate(observed)).toBe("employee");
    expect(canCheckoutOffline(observed).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Properties that must hold for EVERY refusal
// ---------------------------------------------------------------------------

describe("every refusal, every time", () => {
  const FAILURES = [
    "employee_changed",
    "employee_missing",
    "register_changed",
    "register_closed",
    "expectations_missing",
  ] as const;

  for (const failure of FAILURES) {
    describe(failure, () => {
      const refused = applySaleAttributionFailure(established, failure);
      // The worst case for the runtime: the server reports a complete, healthy,
      // DIFFERENT context, which is exactly what would tempt an adoption.
      const observed = applyRecoveryObservation(refused, { employee: BO, register: REGISTER_B });

      it("never reopens the POS by itself", () => {
        expect(resolvePosGate(observed)).not.toBe("pos");
      });

      it("never marks itself established", () => {
        expect(refused.establishedOnline).toBe(false);
        expect(observed.establishedOnline).toBe(false);
      });

      it("always leaves a recovery pending", () => {
        expect(observed.recovery).not.toBeNull();
      });

      it("blocks offline checkout throughout", () => {
        expect(canCheckoutOffline(refused).ok).toBe(false);
        expect(canCheckoutOffline(observed).ok).toBe(false);
      });

      it("claims nothing it has not established", () => {
        const claims = buildOfflineClaims(observed);

        expect(claims.employeePosSessionId).not.toBe("sess-bo");
        expect(claims.registerSessionId).not.toBe("reg-b");
      });
    });
  }
});

// ---------------------------------------------------------------------------
// The paths this correction must NOT weaken
// ---------------------------------------------------------------------------

describe("ordinary startup and reconnect derivation is unchanged", () => {
  it("a clean startup that finds both establishes normally", () => {
    const started = applyServerDerivation({ employee: ADA, register: REGISTER_A });

    expect(started).toEqual(established);
    expect(resolvePosGate(started)).toBe("pos");
    expect(canCheckoutOffline(started).ok).toBe(true);
  });

  it("a reconnect that finds a DIFFERENT employee still establishes", () => {
    // No refusal has happened here. Nobody has been proven wrong about
    // anything; the till simply asked and was told. Tightening this would break
    // the approved startup contract, which is not what the correction asks for.
    const reconnected = applyServerDerivation({ employee: BO, register: REGISTER_B });

    expect(reconnected.recovery).toBeNull();
    expect(reconnected.establishedOnline).toBe(true);
    expect(resolvePosGate(reconnected)).toBe("pos");
  });

  it("a startup that finds an employee but no register stops at the register gate", () => {
    const started = applyServerDerivation({ employee: ADA, register: null });

    expect(started.recovery).toBeNull();
    expect(started.establishedOnline).toBe(false);
    expect(resolvePosGate(started)).toBe("register");
  });

  it("a startup that finds nothing stops at the employee gate", () => {
    expect(applyServerDerivation({ employee: null, register: null })).toEqual(EMPTY_POS_GATE_STATE);
  });

  it("switching employee is explicit, so it raises no recovery", () => {
    const switching = beginEmployeeSwitch(established);

    expect(switching.employee).toBeNull();
    expect(switching.establishedOnline).toBe(false);
    expect(switching.recovery).toBeNull();
    expect(resolvePosGate(switching)).toBe("employee");
  });

  it("a recovery pending blocks offline checkout even if everything else looks right", () => {
    // Belt and braces: `establishedOnline` would already block this. The
    // explicit `recovery` check means a future refactor that reorders these
    // flags cannot quietly reopen the hole.
    expect(canCheckoutOffline({ ...established, recovery: "register" }).ok).toBe(false);
    expect(canCheckoutOffline({ ...established, recovery: "employee" }).ok).toBe(false);
  });
});
