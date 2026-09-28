// v1.3 Feature 1B-RUNTIME correction 2 — the login roster's lifecycle.
//
// THE DEFECT: the roster started as an empty array and was only ever fetched by
// the Refresh button or by Switch employee. A normal online startup therefore
// landed on the employee gate holding `[]` and told the operator:
//
//     "No one can sign in on this till yet. Add an employee from the dashboard."
//
// before a single request had been made. A brand-new till, correctly set up,
// was sent to go fix a problem that did not exist — and the one control that
// would have shown the truth was the Refresh button nobody had a reason to
// press.
import { describe, expect, it } from "vitest";
import {
  ROSTER_FAILED_MESSAGE,
  UNLOADED_ROSTER,
  applyRosterFailed,
  applyRosterLoaded,
  beginRosterLoad,
  isRosterConfirmedEmpty,
  resetRoster,
  rosterEmployees,
  shouldLoadRoster,
} from "@/lib/employeeRoster";
import type { RosterState } from "@/lib/employeeRoster";
import type { LoginEmployee } from "@/lib/employeeSession";

const ADA: LoginEmployee = { employeeId: "emp-ada", displayName: "Ada" };
const BO: LoginEmployee = { employeeId: "emp-bo", displayName: "Bo" };

/** A till that is ready, online, at the employee gate, with nobody selected. */
const AT_THE_GATE = {
  ready: true,
  online: true,
  gate: "employee",
  employeeSelected: false,
} as const;

describe("the initial load", () => {
  it("an online employee gate requests the roster", () => {
    // The defect, stated as the fix: this used to be false forever.
    expect(shouldLoadRoster({ ...AT_THE_GATE, roster: UNLOADED_ROSTER })).toBe(true);
  });

  it("a populated response presents employees without pressing Refresh", () => {
    const loaded = applyRosterLoaded([ADA, BO]);

    expect(rosterEmployees(loaded)).toEqual([ADA, BO]);
    expect(isRosterConfirmedEmpty(loaded)).toBe(false);
    // And the till does not ask again.
    expect(shouldLoadRoster({ ...AT_THE_GATE, roster: loaded })).toBe(false);
  });

  it("offers nothing to pick before the answer arrives", () => {
    expect(rosterEmployees(UNLOADED_ROSTER)).toEqual([]);
    expect(rosterEmployees(beginRosterLoad(UNLOADED_ROSTER))).toEqual([]);
  });
});

describe("empty is a FACT, and needs a fact behind it", () => {
  it("a successful empty response establishes it", () => {
    expect(isRosterConfirmedEmpty(applyRosterLoaded([]))).toBe(true);
  });

  it("nothing else may claim it", () => {
    // Each of these once rendered as "No one can sign in on this till yet".
    expect(isRosterConfirmedEmpty(UNLOADED_ROSTER)).toBe(false);
    expect(isRosterConfirmedEmpty({ status: "loading" })).toBe(false);
    expect(isRosterConfirmedEmpty(applyRosterFailed())).toBe(false);
  });
});

describe("failure", () => {
  it("carries a message the operator can act on", () => {
    const failed = applyRosterFailed();

    expect(failed.status).toBe("failed");
    expect(failed.status === "failed" && failed.message).toBe(ROSTER_FAILED_MESSAGE);
  });

  it("offers no employees", () => {
    expect(rosterEmployees(applyRosterFailed())).toEqual([]);
  });

  it("is NOT retried automatically — that is the loop guard", () => {
    // A till in an outage would otherwise re-request once per render, forever.
    expect(shouldLoadRoster({ ...AT_THE_GATE, roster: applyRosterFailed() })).toBe(false);
  });

  it("an explicit Refresh still starts a new load from a failure", () => {
    expect(beginRosterLoad(applyRosterFailed()).status).toBe("loading");
  });
});

describe("no duplicate concurrent fetches", () => {
  it("a load already in flight is not started again", () => {
    const loading = beginRosterLoad(UNLOADED_ROSTER);

    expect(shouldLoadRoster({ ...AT_THE_GATE, roster: loading })).toBe(false);
  });

  it("beginRosterLoad is idempotent while loading", () => {
    const first = beginRosterLoad(UNLOADED_ROSTER);

    // Same value back, so a re-render cannot turn one fetch into two.
    expect(beginRosterLoad(first)).toBe(first);
  });

  it("a reconnect does not create uncontrolled duplicate calls", () => {
    // The reconnect signal can fire repeatedly while a connection flaps. Once
    // the roster is loaded or loading, every one of those is a no-op.
    let roster: RosterState = UNLOADED_ROSTER;
    let requests = 0;

    for (let tick = 0; tick < 25; tick += 1) {
      if (shouldLoadRoster({ ...AT_THE_GATE, roster })) {
        requests += 1;
        roster = beginRosterLoad(roster);
      }

      // The answer lands somewhere in the middle of the flapping.
      if (tick === 10) roster = applyRosterLoaded([ADA]);
    }

    expect(requests).toBe(1);
  });
});

describe("when the till must NOT ask", () => {
  it("not while offline — the roster is not a way in", () => {
    expect(shouldLoadRoster({ ...AT_THE_GATE, online: false, roster: UNLOADED_ROSTER })).toBe(false);
  });

  it("not before the pairing is ready", () => {
    expect(shouldLoadRoster({ ...AT_THE_GATE, ready: false, roster: UNLOADED_ROSTER })).toBe(false);
  });

  it("not at an exception gate or inside the POS", () => {
    expect(shouldLoadRoster({ ...AT_THE_GATE, gate: "daily", roster: UNLOADED_ROSTER })).toBe(
      false
    );
    expect(shouldLoadRoster({ ...AT_THE_GATE, gate: "timezone", roster: UNLOADED_ROSTER })).toBe(
      false
    );
    expect(shouldLoadRoster({ ...AT_THE_GATE, gate: "pos", roster: UNLOADED_ROSTER })).toBe(false);
  });

  it("not once an employee has been selected and is entering a PIN", () => {
    expect(
      shouldLoadRoster({ ...AT_THE_GATE, employeeSelected: true, roster: UNLOADED_ROSTER })
    ).toBe(false);
  });

  it("an offline COLD START asks for nothing and can use nothing", () => {
    // Policy 1 in this corner: an offline till holds no roster, so there is
    // nothing here that could be mistaken for authority even by accident.
    const offlineColdStart = { ...AT_THE_GATE, online: false, roster: UNLOADED_ROSTER };

    expect(shouldLoadRoster(offlineColdStart)).toBe(false);
    expect(rosterEmployees(offlineColdStart.roster)).toEqual([]);
    expect(isRosterConfirmedEmpty(offlineColdStart.roster)).toBe(false);
  });
});

describe("switching employee", () => {
  it("an explicit refresh reloads from a loaded roster", () => {
    // Switch employee calls the loader directly, so a stale list is replaced
    // rather than reused.
    expect(beginRosterLoad(applyRosterLoaded([ADA])).status).toBe("loading");
  });

  it("the new answer replaces the old one wholesale", () => {
    expect(rosterEmployees(applyRosterLoaded([BO]))).toEqual([BO]);
  });
});

describe("losing the pairing", () => {
  it("forgets the roster entirely, so the next till starts clean", () => {
    expect(resetRoster()).toEqual(UNLOADED_ROSTER);
    expect(rosterEmployees(resetRoster())).toEqual([]);
  });

  it("and the reset state asks again once the till is ready and online", () => {
    expect(shouldLoadRoster({ ...AT_THE_GATE, roster: resetRoster() })).toBe(true);
  });
});
