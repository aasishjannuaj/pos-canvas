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
  applyDailyRefresh,
  applyEmployeeAuthenticated,
  applyExplicitDailyEstablished,
  applyReconnectDerivation,
  applySaleAttributionFailure,
  beginEmployeeSwitch,
  buildOfflineClaims,
  canCheckoutOffline,
  resolvePosGate,
} from "@/lib/posGate";
import type { DailyAcquisition, PosGateState } from "@/lib/posGate";
import type { EmployeeSession } from "@/lib/employeeSession";
import type { DailyRegisterContext } from "@/lib/dailyRegister";

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

const DAY_A: DailyRegisterContext = {
  registerSessionId: "daily-a",
  businessDate: "2026-09-18",
  businessTimezone: "America/New_York",
  openedAt: "2026-09-18T04:00:00.000Z",
  closedAt: "2026-09-19T04:00:00.000Z",
};

const DAY_B: DailyRegisterContext = {
  ...DAY_A,
  registerSessionId: "daily-b",
  businessDate: "2026-09-19",
};

const gotA: DailyAcquisition = { ok: true, context: DAY_A };
const gotB: DailyAcquisition = { ok: true, context: DAY_B };
const stillSame = (employee: EmployeeSession) => ({ ok: true as const, session: employee });

/** Ada + today, established from the server. The till is selling. */
const established: PosGateState = {
  employee: ADA,
  daily: DAY_A,
  establishedOnline: true,
  recovery: null,
  setup: null,
};

// ---------------------------------------------------------------------------
// EMPLOYEE CHANGED
// ---------------------------------------------------------------------------

describe("employee_changed: the server reports Bo, and the POS must not reopen", () => {
  // The exact scenario in the review: local till believes Ada + register A, the
  // server has moved on to Bo + register B, the sale is refused.
  const refused = applySaleAttributionFailure(established, "employee_changed");
  const observed = applyDailyRefresh(refused, { ok: false, reason: 'unavailable' });

  it("the refusal itself drops Ada and raises an employee recovery", () => {
    expect(refused.employee).toBeNull();
    expect(refused.daily).toBeNull();
    expect(refused.establishedOnline).toBe(false);
    expect(refused.recovery).toBe("employee");
  });

  it("re-reading the server does NOT adopt Bo", () => {
    expect(observed.employee).toBeNull();
    expect(observed.recovery).toBe("employee");
  });

  it("re-reading the server does NOT adopt register B either", () => {
    // Never even stored, so no later code path can reach it.
    expect(observed.daily).toBeNull();
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
    const afterExplicitLogin = applyEmployeeAuthenticated({ employee: BO, daily: { ok: true, context: DAY_B }, revalidated: stillSame(BO) });

    expect(afterExplicitLogin.recovery).toBeNull();
    expect(afterExplicitLogin.establishedOnline).toBe(true);
    expect(resolvePosGate(afterExplicitLogin)).toBe("pos");
    expect(buildOfflineClaims(afterExplicitLogin).employeePosSessionId).toBe("sess-bo");
  });

  it("no number of re-reads ever establishes on its own", () => {
    // The loop that would otherwise reopen the POS by attrition.
    let state = refused;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      state = applyDailyRefresh(state, { ok: false, reason: 'unavailable' });
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
    const observed = applyDailyRefresh(refused, { ok: false, reason: 'unavailable' });

    expect(resolvePosGate(observed)).toBe("employee");
    expect(observed.establishedOnline).toBe(false);
  });

  it("does not reopen when the server reports nobody either", () => {
    const observed = applyDailyRefresh(refused, { ok: false, reason: 'unavailable' });

    expect(resolvePosGate(observed)).toBe("employee");
  });
});

// ---------------------------------------------------------------------------
// REGISTER CHANGED
// ---------------------------------------------------------------------------

describe("register_changed: the employee survives, the register must be re-taken", () => {
  const refused = applySaleAttributionFailure(established, "register_changed");
  const observed = applyDailyRefresh(refused, { ok: false, reason: 'unavailable' });

  it("Ada stays signed in — she was not what the server disproved", () => {
    expect(refused.employee).toEqual(ADA);
    expect(refused.recovery).toBe("daily");
  });

  it("the changed register is NOT silently adopted", () => {
    expect(observed.daily).toBeNull();
    expect(observed.recovery).toBe("daily");
  });

  it("the POS MUST NOT continue under the changed register", () => {
    expect(resolvePosGate(observed)).toBe("daily");
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
    const adopted = applyExplicitDailyEstablished(observed, { employeeBefore: { ok: true, session: ADA }, daily: { ok: true, context: DAY_B }, employeeAfter: { ok: true, session: ADA } });

    expect(adopted.recovery).toBeNull();
    expect(adopted.daily).toEqual(DAY_B);
    expect(adopted.employee).toEqual(ADA);
    expect(resolvePosGate(adopted)).toBe("pos");
    expect(canCheckoutOffline(adopted).ok).toBe(true);
  });

  it("opening a register outright also clears it, because that too is explicit", () => {
    expect(applyEmployeeAuthenticated({ employee: ADA, daily: { ok: true, context: DAY_B }, revalidated: stillSame(ADA) }).recovery).toBeNull();
  });

  it("a refresh cannot resolve it, however good the server's answer looks", () => {
    // A refresh is not the operator's choice to trust the till again. Even a
    // perfectly good business day leaves the recovery standing and the POS shut.
    const refreshed = applyDailyRefresh(refused, gotB);

    expect(refreshed.recovery).toBe("daily");
    expect(refreshed.establishedOnline).toBe(false);
    expect(refreshed.daily).toBeNull();
    expect(resolvePosGate(refreshed)).toBe("daily");
  });

  it("and a reconnect ESCALATES when the employee also changed", () => {
    // This is what makes the employee read worth performing during a daily
    // recovery: it can discover a second, worse mismatch.
    const escalated = applyReconnectDerivation(refused, {
      employee: { ok: true, session: BO },
      daily: gotB,
    });

    expect(escalated.employee).toBeNull();
    expect(escalated.recovery).toBeNull();
    expect(escalated.establishedOnline).toBe(false);
    expect(resolvePosGate(escalated)).toBe("employee");
  });

  it("a reconnect that confirms the SAME operator still keeps the recovery", () => {
    const same = applyReconnectDerivation(refused, {
      employee: { ok: true, session: ADA },
      daily: gotB,
    });

    expect(same.employee).toEqual(ADA);
    expect(same.recovery).toBe("daily");
    expect(resolvePosGate(same)).toBe("daily");
  });
});

describe("register_closed: the register gate is required", () => {
  const refused = applySaleAttributionFailure(established, "register_closed");

  it("sends the operator to the register gate", () => {
    expect(refused.recovery).toBe("daily");
    expect(resolvePosGate(refused)).toBe("daily");
  });

  it("stays there even when the server reports a NEW register already open", () => {
    const observed = applyDailyRefresh(refused, { ok: false, reason: 'unavailable' });

    expect(resolvePosGate(observed)).toBe("daily");
    expect(observed.daily).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// EXPECTATIONS MISSING
// ---------------------------------------------------------------------------

describe("expectations_missing: explicit recovery required", () => {
  const refused = applySaleAttributionFailure(established, "expectations_missing");

  it("is treated as the strictest case — back to the employee gate", () => {
    expect(refused.employee).toBeNull();
    expect(refused.daily).toBeNull();
    expect(refused.recovery).toBe("employee");
    expect(resolvePosGate(refused)).toBe("employee");
  });

  it("a re-read cannot shortcut it", () => {
    const observed = applyDailyRefresh(refused, { ok: false, reason: 'unavailable' });

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
      const observed = applyDailyRefresh(refused, { ok: false, reason: 'unavailable' });

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
        expect(claims.registerSessionId).not.toBe("daily-b");
      });
    });
  }
});

// ---------------------------------------------------------------------------
// The paths this correction must NOT weaken
// ---------------------------------------------------------------------------

describe("ordinary startup and reconnect derivation is unchanged", () => {
  it("a clean startup that finds both establishes normally", () => {
    const started = applyEmployeeAuthenticated({ employee: ADA, daily: { ok: true, context: DAY_A }, revalidated: stillSame(ADA) });

    expect(started).toEqual(established);
    expect(resolvePosGate(started)).toBe("pos");
    expect(canCheckoutOffline(started).ok).toBe(true);
  });

  it("a reconnect that finds a DIFFERENT employee still establishes", () => {
    // No refusal has happened here. Nobody has been proven wrong about
    // anything; the till simply asked and was told. Tightening this would break
    // the approved startup contract, which is not what the correction asks for.
    const reconnected = applyEmployeeAuthenticated({ employee: BO, daily: { ok: true, context: DAY_B }, revalidated: stillSame(BO) });

    expect(reconnected.recovery).toBeNull();
    expect(reconnected.establishedOnline).toBe(true);
    expect(resolvePosGate(reconnected)).toBe("pos");
  });

  it("a login whose day could not be established stops at the daily gate", () => {
    const started = applyEmployeeAuthenticated({
      employee: ADA,
      daily: { ok: false, reason: "unavailable" },
      revalidated: stillSame(ADA),
    });

    expect(started.recovery).toBeNull();
    expect(started.establishedOnline).toBe(false);
    expect(resolvePosGate(started)).toBe("daily");
  });

  it("a login whose operator was replaced mid-flight stops at the employee gate", () => {
    expect(
      applyEmployeeAuthenticated({
        employee: ADA,
        daily: gotA,
        revalidated: { ok: true, session: null },
      })
    ).toEqual(EMPTY_POS_GATE_STATE);
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
    expect(canCheckoutOffline({ ...established, recovery: "daily" }).ok).toBe(false);
    expect(canCheckoutOffline({ ...established, recovery: "employee" }).ok).toBe(false);
  });
});
