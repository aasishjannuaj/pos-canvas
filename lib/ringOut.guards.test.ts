// v1.3 CP3 — the ordering Ring Out depends on, and the lines it must not cross.
//
// THE BUG THESE EXIST TO PREVENT IS AN ORDERING BUG. Ring Out is safe only
// because the local transition happens BEFORE the logout is awaited, and
// because it is written through `gateRef` rather than only through React state.
// Both are properties of the call site, not of any function's return value, so
// no unit test on lib/posGate can observe them. They are checked here, against
// the real source.
//
// The previous implementation is the cautionary case: it awaited
// employee_logout, threw the result away, and let a re-derivation decide. It
// only ever locked because that derivation happens to be fail-closed -- so a
// logout that failed while the session READ still succeeded left the rung-out
// employee holding a live, unlocked till.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf-8");

/**
 * Source with comments stripped.
 *
 * The forbidden-token guards are about what the CODE does. These files'
 * comments deliberately name the things the code must not do, so matching
 * prose would make a guard fail for documenting itself.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

const DEVICE_APP = "components/device/DeviceApp.tsx";
const POS_GATES = "components/device/PosGates.tsx";

/** The Ring Out handler body, isolated from a 3000-line component. */
function ringOutBody(): string {
  const source = read(DEVICE_APP);
  const start = source.indexOf("const handleEmployeeLogout = useCallback");
  expect(start).toBeGreaterThan(-1);

  const end = source.indexOf("  }, []);", start);
  expect(end).toBeGreaterThan(start);

  return source.slice(start, end);
}

const ringOutCode = () => stripComments(ringOutBody());

describe("the local transition happens BEFORE any await", () => {
  it("clears the employee and only then calls employee_logout", () => {
    const body = ringOutCode();

    const transition = body.indexOf("beginEmployeeSwitch(gateRef.current)");
    const logout = body.indexOf("await employeeLogout()");

    expect(transition).toBeGreaterThan(-1);
    expect(logout).toBeGreaterThan(-1);
    expect(transition).toBeLessThan(logout);
  });

  it("writes gateRef BEFORE the await, because checkout reads the ref", () => {
    const body = ringOutCode();

    const refWrite = body.indexOf("gateRef.current = lockedOut");
    const logout = body.indexOf("await employeeLogout()");

    expect(refWrite).toBeGreaterThan(-1);
    expect(refWrite).toBeLessThan(logout);
  });

  it("writes the React state before the await too", () => {
    const body = ringOutCode();

    expect(body.indexOf("setGate(lockedOut)")).toBeGreaterThan(-1);
    expect(body.indexOf("setGate(lockedOut)")).toBeLessThan(body.indexOf("await employeeLogout()"));
  });

  it("clears the employee-selection residue before the await", () => {
    const body = ringOutCode();

    expect(body.indexOf("setSelectedEmployee(null)")).toBeGreaterThan(-1);
    expect(body.indexOf("setSelectedEmployee(null)")).toBeLessThan(
      body.indexOf("await employeeLogout()")
    );
  });

  // NEGATIVE CONTROL. This is the old shape: awaiting the server first and
  // deciding afterwards. If it ever returns, the ordering guarantee is gone.
  it("does not await anything before the transition", () => {
    const body = ringOutCode();
    const transition = body.indexOf("beginEmployeeSwitch(gateRef.current)");

    expect(body.slice(0, transition)).not.toContain("await ");
  });
});

describe("the server answer can never restore authority", () => {
  // NEGATIVE CONTROL. deriveGateState CAN repopulate `employee` from the
  // server. Calling it here would re-adopt whatever session the server still
  // reports -- including the stale one this Ring Out failed to close.
  it("runs no gate derivation at all", () => {
    expect(ringOutCode()).not.toContain("deriveGateState");
  });

  it("never writes an employee back into the gate", () => {
    const body = ringOutCode();

    for (const forbidden of [
      "applyEmployeeAuthenticated",
      "applyReconnectDerivation",
      "applyExplicitDailyEstablished",
      "readEmployeeSession",
      "fetchCurrentEmployeeSession",
      "employee_login",
      "employeeLoginByCode",
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });

  it("uses the result only to classify the failure", () => {
    const body = ringOutCode();

    // The result is READ -- the old code discarded it -- but only to branch on
    // how it failed, never to rebuild state from.
    expect(body).toContain("const result = await employeeLogout()");
    expect(body).toContain("if (!result.ok)");
  });
});

describe("transport failure reuses the accepted offline transition", () => {
  it("enters offline runtime mode when the logout never reached the server", () => {
    const body = ringOutCode();

    expect(body).toContain('result.error === "offline"');
    // Reached through the ref, which holds the very same function.
    expect(body).toContain("await enterOfflineRef.current?.()");
  });

  it("that transition is the SAME one the sale path already uses", () => {
    // One implementation, two callers: the sale rejection handler and Ring Out.
    const source = read(DEVICE_APP);
    expect(source).toContain("const enterOfflineFromTransportFailure = useCallback");
    // The ref is ASSIGNED that exact function, so Ring Out and the sale path
    // share one implementation rather than each having their own.
    expect(source).toContain("enterOfflineRef.current = enterOfflineFromTransportFailure");
    expect(source).toContain("void enterOfflineFromTransportFailure();");
  });

  // NEGATIVE CONTROL: a non-transport refusal is a different fact and must not
  // pretend the network is down.
  it("does not enter offline mode for a server refusal", () => {
    const body = ringOutCode();

    const offlineBranch = body.indexOf('result.error === "offline"');
    const elseBranch = body.indexOf("} else {", offlineBranch);

    expect(elseBranch).toBeGreaterThan(offlineBranch);
    expect(body.slice(elseBranch)).not.toContain("enterOfflineRef");
  });

  it("says so on the lock card rather than implying the operator is still on", () => {
    expect(ringOutCode()).toContain("setGateError(");
  });
});

describe("single-flight", () => {
  it("guards on a ref, not on React state", () => {
    const body = ringOutCode();

    // gateBusy is not visible to a second click before the render commits.
    expect(body).toContain("if (ringOutInFlightRef.current)");
    expect(body.indexOf("if (ringOutInFlightRef.current)")).toBeLessThan(
      body.indexOf("beginEmployeeSwitch(gateRef.current)")
    );
  });

  it("takes the guard before the transition and releases it in finally", () => {
    const body = ringOutCode();

    const take = body.indexOf("ringOutInFlightRef.current = true");
    const transition = body.indexOf("beginEmployeeSwitch(gateRef.current)");

    expect(take).toBeGreaterThan(-1);
    expect(take).toBeLessThan(transition);
    expect(body).toContain("} finally {");
    expect(body.slice(body.indexOf("} finally {"))).toContain(
      "ringOutInFlightRef.current = false"
    );
  });

  it("declares the ref alongside the other in-flight guards", () => {
    expect(read(DEVICE_APP)).toContain("const ringOutInFlightRef = useRef(false)");
  });
});

describe("nothing else moves", () => {
  it("does not close, open or replace the DAILY register", () => {
    const body = ringOutCode();

    for (const forbidden of [
      "close_register_session",
      "closeRegisterSession",
      "open_register_session",
      "openRegisterSession",
      "ensureDailyRegisterContext",
      "ensure_daily_register_context",
      "acquireDaily",
      "applyDailyRefresh",
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });

  it("does not touch the cart, the runtime or the queue", () => {
    const body = ringOutCode();

    for (const forbidden of [
      "clearCart",
      "setCart",
      "resolveDeviceState",
      "enqueueSale",
      "runSync",
      "completeDeviceSaleV5",
      "complete_sale",
      "saleRequestId",
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });

  it("introduces no time-clock operation", () => {
    const body = ringOutCode();

    for (const forbidden of ["clockIn", "clockOut", "clock_in", "clock_out", "timeClock"]) {
      expect(body).not.toContain(forbidden);
    }
  });

  it("leaves the sale path's expected-session protection untouched", () => {
    const source = read(DEVICE_APP);

    expect(source).toContain("expectedEmployeePosSessionId: current.employee.employeeSessionId");
    expect(source).toContain("expectedRegisterSessionId: current.daily.registerSessionId");
  });

  it("keeps the no-automatic-retry rule on a refused sale", () => {
    expect(read(DEVICE_APP)).toContain("STALE STATE IS NOT RETRIED");
  });

  it("keeps the gate an overlay over a mounted PosRuntime", () => {
    // Pinned in depth by lib/recoveryCartPreservation.guards.test.ts; restated
    // here because Ring Out is a new way to reach the locked state.
    const source = read(DEVICE_APP);

    expect(source).toContain("inert");
    expect(source).toContain("<PosRuntime");
  });
});

describe("the operator-facing control", () => {
  it("is called Ring Out", () => {
    expect(read(POS_GATES)).toContain("Ring Out");
  });

  // NEGATIVE CONTROL: one action, one word. A surface still saying "Sign out"
  // would read as a different, larger act than the one that happens.
  it("no device surface still says Sign out", () => {
    expect(read(POS_GATES)).not.toContain("Sign out");
    expect(read(DEVICE_APP)).not.toContain("Sign out");
  });

  it("stays in the existing status strip, wired to the existing handler", () => {
    const source = read(DEVICE_APP);

    expect(source).toContain("<DailyRegisterStatus");
    expect(source).toContain("onLogout={() => void handleEmployeeLogout()}");
  });

  it("disappears once the till is locked, because the strip needs an employee", () => {
    expect(read(DEVICE_APP)).toContain("gate.employee !== null && gate.daily !== null && (");
  });
});
