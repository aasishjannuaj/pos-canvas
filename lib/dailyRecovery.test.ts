// v1.3 CP2d — explicit DAILY recovery, and the read race.
//
// THE RULE. The operator's press authorizes re-establishing the DAY. It is not
// authorization to switch EMPLOYEE. So the retained employee POS session must
// be confirmed on BOTH sides of the ensure call:
//
//     read employee → [ensure_daily_register_context] → read employee again
//
// WHY THE SECOND READ EARNS ITS ROUND TRIP. Reading the employee once and then
// the register left a window. The server could switch Ada → Bo in between, and
// the client would establish a pair it had never seen coexist:
//
//     employee = Ada (confirmed a moment ago, already stale)
//     daily    = today's context (established after she was gone)
//     establishedOnline = true
//
// An online v5 sale refuses that pair, so the money is safe while the network
// is up. But `establishedOnline` is exactly what Policy 1 reads: a connection
// drop straight afterwards would let a NEW OFFLINE SALE be taken under an
// employee the server had already replaced — written to disk, with a claim that
// can never be proven at sync time. A later online refusal cannot un-take a
// sale that has already been accepted locally.
//
// This is not atomicity and is not claimed to be. A switch AFTER the final read
// is ordinary runtime staleness, which the v5 online expectations refuse. What
// it removes is the case where the client ITSELF observed the register under
// one employee and established under another.
//
// CP2d CHANGED WHAT IS BEING RE-ESTABLISHED, NOT THE RACE. There is no register
// to open any more: the operator asks the server for the business day, and the
// sandwich around that call is unchanged, comparison for comparison.
import { describe, expect, it } from "vitest";
import {
  applyExplicitDailyEstablished,
  applySaleAttributionFailure,
  buildOfflineClaims,
  canCheckoutOffline,
  checkRetainedEmployee,
  resolvePosGate,
} from "@/lib/posGate";
import type { DailyRecoveryReads, PosGateState } from "@/lib/posGate";
import type { EmployeeSession } from "@/lib/employeeSession";
import type { DailyRegisterContext } from "@/lib/dailyRegister";

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
 * What a weaker comparison would wave through: same employee id, same display
 * name, different POS session. complete_sale_v5 compares session ids, so
 * accepting this would only move the refusal later.
 */
const ADA_AGAIN: EmployeeSession = {
  ...ADA,
  employeeSessionId: "sess-ada-2",
  startedAt: "2026-09-18T03:00:00.000Z",
};

const DAY_A: DailyRegisterContext = {
  registerSessionId: "daily-a",
  businessDate: "2026-09-18",
  businessTimezone: "America/New_York",
  openedAt: "2026-09-18T04:00:00.000Z",
  closedAt: "2026-09-19T04:00:00.000Z",
};

/** The day the server establishes when the recovery asks. */
const DAY_B: DailyRegisterContext = {
  ...DAY_A,
  registerSessionId: "daily-b",
  businessDate: "2026-09-19",
  openedAt: "2026-09-19T04:00:00.000Z",
  closedAt: "2026-09-20T04:00:00.000Z",
};

const established: PosGateState = {
  employee: ADA,
  daily: DAY_A,
  establishedOnline: true,
  recovery: null,
  setup: null,
};

/** Ada retained, the day cleared, recovery pending — awaiting the press. */
const dailyRecovery = applySaleAttributionFailure(established, "register_changed");

/** The three reads, written the way they happen: before, ensure, after. */
function reads(
  employeeBefore: EmployeeSession | null | "failed",
  daily: DailyRegisterContext | null | "failed",
  employeeAfter: EmployeeSession | null | "failed"
): DailyRecoveryReads {
  return {
    employeeBefore: employeeBefore === "failed" ? { ok: false } : { ok: true, session: employeeBefore },
    daily:
      daily === "failed"
        ? { ok: false, reason: "unavailable" }
        : daily === null
          ? { ok: false, reason: "conflict" }
          : { ok: true, context: daily },
    employeeAfter: employeeAfter === "failed" ? { ok: false } : { ok: true, session: employeeAfter },
  };
}

const adopt = (r: DailyRecoveryReads) => applyExplicitDailyEstablished(dailyRecovery, r);

// ---------------------------------------------------------------------------
// DAY ADOPTION — the nine required cases
// ---------------------------------------------------------------------------

describe("1. employee same before AND after, register open", () => {
  const adopted = adopt(reads(ADA, DAY_B, ADA));

  it("establishes", () => {
    expect(adopted.establishedOnline).toBe(true);
    expect(adopted.recovery).toBeNull();
    expect(adopted.daily).toEqual(DAY_B);
    expect(adopted.employee).toEqual(ADA);
    expect(resolvePosGate(adopted)).toBe("pos");
  });

  it("and only then may an offline sale be taken", () => {
    expect(canCheckoutOffline(adopted).ok).toBe(true);
    expect(buildOfflineClaims(adopted)).toEqual({
      employeePosSessionId: "sess-ada",
      registerSessionId: "daily-b",
    });
  });
});

describe("2. the employee changes BEFORE the ensure call", () => {
  // The server had already moved on when the press landed.
  const result = adopt(reads(BO, DAY_B, BO));

  it("does not establish", () => {
    expect(result.establishedOnline).toBe(false);
  });

  it("escalates to the employee gate, adopting neither Bo nor the register", () => {
    expect(result.recovery).toBe("employee");
    expect(result.employee).toBeNull();
    expect(result.daily).toBeNull();
    expect(resolvePosGate(result)).toBe("employee");
  });
});

describe("3. the employee changes BETWEEN the register read and the final read", () => {
  // THE RACE THIS CORRECTION EXISTS FOR. The first read said Ada, so the old
  // two-read version would have established Ada + Register B — a pair that
  // never coexisted on the server.
  const result = adopt(reads(ADA, DAY_B, BO));

  it("does not establish", () => {
    expect(result.establishedOnline).toBe(false);
  });

  it("escalates to the employee gate", () => {
    expect(result.recovery).toBe("employee");
    expect(resolvePosGate(result)).toBe("employee");
  });

  it("does not adopt the register it just read", () => {
    expect(result.daily).toBeNull();
  });

  it("does not adopt the employee it just observed", () => {
    expect(result.employee).toBeNull();
  });

  it("the employee VANISHING between the reads is treated the same way", () => {
    const vanished = adopt(reads(ADA, DAY_B, null));

    expect(vanished.establishedOnline).toBe(false);
    expect(vanished.recovery).toBe("employee");
  });
});

describe("4. same employee id, NEW POS session id", () => {
  it("does not establish, on either side of the sandwich", () => {
    for (const r of [
      reads(ADA_AGAIN, DAY_B, ADA_AGAIN),
      reads(ADA, DAY_B, ADA_AGAIN),
      reads(ADA_AGAIN, DAY_B, ADA),
    ]) {
      const result = adopt(r);

      expect(result.establishedOnline).toBe(false);
      expect(result.recovery).toBe("employee");
      expect(result.employee).toBeNull();
    }
  });
});

describe("5. the employee disappears", () => {
  const result = adopt(reads(null, DAY_B, null));

  it("escalates to an employee recovery", () => {
    expect(result.recovery).toBe("employee");
    expect(result.employee).toBeNull();
    expect(result.daily).toBeNull();
    expect(result.establishedOnline).toBe(false);
  });
});

describe("6. the FIRST employee read fails", () => {
  const result = adopt(reads("failed", DAY_B, ADA));

  it("establishes nothing", () => {
    expect(result.establishedOnline).toBe(false);
  });

  it("stays at the register recovery — a failed read is not evidence", () => {
    expect(result.recovery).toBe("daily");
    expect(result.employee).toEqual(ADA);
    expect(result.daily).toBeNull();
  });
});

describe("7. the register read fails", () => {
  const result = adopt(reads(ADA, "failed", ADA));

  it("establishes nothing and stays gated", () => {
    expect(result.establishedOnline).toBe(false);
    expect(result.recovery).toBe("daily");
    expect(result.daily).toBeNull();
  });
});

describe("8. the FINAL employee read fails", () => {
  const result = adopt(reads(ADA, DAY_B, "failed"));

  it("establishes nothing — an unverified span is not a verified one", () => {
    expect(result.establishedOnline).toBe(false);
  });

  it("stays at the register recovery, and does not sign Ada out", () => {
    expect(result.recovery).toBe("daily");
    expect(result.employee).toEqual(ADA);
  });

  it("does not adopt the register it read", () => {
    expect(result.daily).toBeNull();
  });
});

describe("9. offline checkout is false for every failure and mismatch", () => {
  const CASES = [
    ["employee changed before", reads(BO, DAY_B, BO)],
    ["employee changed after", reads(ADA, DAY_B, BO)],
    ["new session for the same person", reads(ADA_AGAIN, DAY_B, ADA_AGAIN)],
    ["employee missing", reads(null, DAY_B, null)],
    ["employee vanished mid-operation", reads(ADA, DAY_B, null)],
    ["register missing", reads(ADA, null, ADA)],
    ["first employee read failed", reads("failed", DAY_B, ADA)],
    ["register read failed", reads(ADA, "failed", ADA)],
    ["final employee read failed", reads(ADA, DAY_B, "failed")],
    ["every read failed", reads("failed", "failed", "failed")],
  ] as const;

  for (const [name, r] of CASES) {
    it(`${name}: canCheckoutOffline is false`, () => {
      expect(canCheckoutOffline(adopt(r)).ok).toBe(false);
    });
  }

  it("the recovery state blocks it before any press, too", () => {
    expect(canCheckoutOffline(dailyRecovery).ok).toBe(false);
  });

  it("and exactly one shape establishes", () => {
    const establishing = CASES.filter(([, r]) => adopt(r).establishedOnline);

    expect(establishing).toHaveLength(0);
    expect(adopt(reads(ADA, DAY_B, ADA)).establishedOnline).toBe(true);
  });
});

describe("14. no different employee session ever becomes an offline claim", () => {
  for (const [name, r] of [
    ["changed before", reads(BO, DAY_B, BO)],
    ["changed after", reads(ADA, DAY_B, BO)],
    ["new session, same person", reads(ADA_AGAIN, DAY_B, ADA_AGAIN)],
    ["missing", reads(null, DAY_B, null)],
  ] as const) {
    it(`${name}: claims nothing`, () => {
      const result = adopt(r);

      expect(buildOfflineClaims(result)).toEqual({
        employeePosSessionId: null,
        registerSessionId: null,
      });
      // Never stored at all, so no future code path can reach them.
      expect(JSON.stringify(result)).not.toContain("sess-bo");
      expect(JSON.stringify(result)).not.toContain("sess-ada-2");
      expect(JSON.stringify(result)).not.toContain("reg-b");
    });
  }
});

// ---------------------------------------------------------------------------
// REGISTER OPEN DURING RECOVERY — the pre-check is a gate
// ---------------------------------------------------------------------------

describe("10. a stale retained employee is detected BEFORE the open", () => {
  // The host calls checkRetainedEmployee first and only calls
  // open_register_session when it returns ok. These are the answers that stop
  // the RPC from ever being issued, so no register is opened under somebody the
  // local operator was not recovering.
  it("a different employee refuses the operation", () => {
    const check = checkRetainedEmployee(dailyRecovery, { ok: true, session: BO });

    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toBe("employee_changed");
    expect(check.ok === false && check.state.recovery).toBe("employee");
    expect(check.ok === false && check.state.establishedOnline).toBe(false);
  });

  it("a new session for the same person refuses it too", () => {
    expect(checkRetainedEmployee(dailyRecovery, { ok: true, session: ADA_AGAIN }).ok).toBe(false);
  });

  it("a missing employee refuses it", () => {
    const check = checkRetainedEmployee(dailyRecovery, { ok: true, session: null });

    expect(check.ok).toBe(false);
    expect(check.ok === false && check.state.recovery).toBe("employee");
  });

  it("a FAILED read refuses it without signing anybody out", () => {
    const check = checkRetainedEmployee(dailyRecovery, { ok: false });

    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toBe("unavailable");
    expect(check.ok === false && check.state.employee).toEqual(ADA);
    expect(check.ok === false && check.state.recovery).toBe("daily");
  });

  it("a state with nothing retained refuses it", () => {
    const orphaned: PosGateState = {
      employee: null,
      daily: null,
      establishedOnline: false,
      recovery: "daily", setup: null };

    expect(checkRetainedEmployee(orphaned, { ok: true, session: ADA }).ok).toBe(false);
  });
});

describe("11. the correct retained employee lets the open proceed", () => {
  it("the pre-check passes and returns the confirmed session", () => {
    const check = checkRetainedEmployee(dailyRecovery, { ok: true, session: ADA });

    expect(check.ok).toBe(true);
    expect(check.ok === true && check.employee.employeeSessionId).toBe("sess-ada");
  });

  it("and the completed operation establishes", () => {
    const afterOpen = adopt(reads(ADA, DAY_A, ADA));

    expect(afterOpen.establishedOnline).toBe(true);
    expect(afterOpen.recovery).toBeNull();
    expect(resolvePosGate(afterOpen)).toBe("pos");
  });
});

describe("12. the employee changes while the open RPC is in flight", () => {
  // The unavoidable residue: the pre-check passed, so the RPC was issued, and
  // open_register_session opens under the SERVER's own current employee
  // session. A register may therefore exist server-side, belonging to Bo. The
  // CLIENT must still refuse to establish on it.
  const result = adopt(reads(ADA, DAY_B, BO));

  it("the client does NOT establish the register that was opened", () => {
    expect(result.establishedOnline).toBe(false);
    expect(result.daily).toBeNull();
  });

  it("the operator is sent to the employee gate", () => {
    expect(result.recovery).toBe("employee");
    expect(resolvePosGate(result)).toBe("employee");
  });

  it("and offline checkout stays blocked", () => {
    expect(canCheckoutOffline(result).ok).toBe(false);
  });

  it("pressing again does not accumulate into an establishment", () => {
    let state = result;

    for (let press = 0; press < 5; press += 1) {
      state = applyExplicitDailyEstablished(state, reads(BO, DAY_B, BO));
    }

    expect(state.establishedOnline).toBe(false);
    expect(state.recovery).toBe("employee");
  });
});

describe("13. already_open takes the same pre- and post-checks", () => {
  // The host returns the carried session from the already_open branch through
  // the same operation slot, so it lands in exactly the same transition.
  it("establishes only when the employee spans the operation", () => {
    expect(adopt(reads(ADA, DAY_A, ADA)).establishedOnline).toBe(true);
  });

  it("refuses when the employee changed during it", () => {
    expect(adopt(reads(ADA, DAY_A, BO)).establishedOnline).toBe(false);
    expect(adopt(reads(BO, DAY_A, BO)).establishedOnline).toBe(false);
  });

  it("refuses when the final read could not be made", () => {
    expect(adopt(reads(ADA, DAY_A, "failed")).establishedOnline).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The full truth table
// ---------------------------------------------------------------------------

describe("the whole space, as a table", () => {
  it("establishes on exactly one shape: same session, a day, same session", () => {
    const employees = [ADA, BO, ADA_AGAIN, null, "failed"] as const;
    const registers = [DAY_A, DAY_B, null, "failed"] as const;
    const established: string[] = [];

    for (const before of employees) {
      for (const register of registers) {
        for (const after of employees) {
          const result = adopt(reads(before, register, after));

          if (result.establishedOnline) {
            established.push(
              `${before === "failed" ? "failed" : before?.employeeSessionId ?? "none"}/` +
                `${register === "failed" ? "failed" : register?.registerSessionId ?? "none"}/` +
                `${after === "failed" ? "failed" : after?.employeeSessionId ?? "none"}`
            );
          }
        }
      }
    }

    expect(established.sort()).toEqual([
      "sess-ada/daily-a/sess-ada",
      "sess-ada/daily-b/sess-ada",
    ]);
  });

  it("nothing that establishes ever carries an employee other than the retained one", () => {
    expect(adopt(reads(ADA, DAY_B, ADA)).employee?.employeeSessionId).toBe("sess-ada");
  });
});
