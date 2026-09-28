// v1.3 CP4 — the lines Auto-Lock must never cross.
//
// Auto-Lock adds a way for the till to take authority away from an operator
// who is not there. That is a security improvement only while it stays exactly
// that: it must not become a logout, a clock-out, a register close, or a
// reason to drop a cart. And the ordering that makes it safe — capture the
// session id, clear local authority, THEN talk to the server — is a property
// of the call site, which no unit test on lib/autoLock can observe.
//
// The other half of this file is about what may reset the deadline. A till
// that counts its own network traffic as "a person is here" never locks, and
// the failure is silent: everything looks fine until someone sells under
// somebody else's name.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf-8");

/** Source with comments removed: these guards are about code, not prose. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

const DEVICE_APP = "components/device/DeviceApp.tsx";
const AUTO_LOCK = "lib/autoLock.ts";
const POS_RUNTIME = "components/runtime/PosRuntime.tsx";

/** The shared lock primitive's body, isolated from a 3000-line component. */
function lockPrimitive(): string {
  const source = read(DEVICE_APP);
  const start = source.indexOf("const lockOperatorOut = useCallback");
  expect(start).toBeGreaterThan(-1);

  const end = source.indexOf("  }, []);", start);
  expect(end).toBeGreaterThan(start);

  return source.slice(start, end);
}

/** The Auto-Lock effect's body. */
function autoLockEffect(): string {
  const source = read(DEVICE_APP);
  const call = source.indexOf("return startAutoLock(");
  expect(call).toBeGreaterThan(-1);

  // From the effect's own useEffect, so the guard can see the session-id read
  // and the guard clause above the call, not just the host literal.
  const start = source.lastIndexOf("useEffect(() => {", call);
  expect(start).toBeGreaterThan(-1);

  const end = source.indexOf("  }, [gate.employee?.employeeSessionId, lockOperatorOut]);", start);
  expect(end).toBeGreaterThan(start);

  return source.slice(start, end);
}

const lockCode = () => stripComments(lockPrimitive());
const effectCode = () => stripComments(autoLockEffect());

// ---------------------------------------------------------------------------
// One primitive, one single-flight
// ---------------------------------------------------------------------------

describe("Ring Out and Auto-Lock share one path", () => {
  it("both call the same primitive, with a reason", () => {
    const source = read(DEVICE_APP);

    expect(source).toContain('void lockOperatorOut("ring_out")');
    expect(source).toContain('void lockOperatorOut("auto_lock")');
    expect(source).toContain("const lockOperatorOut = useCallback");
  });

  // NEGATIVE CONTROL: a second termination call site is how the two paths
  // drift apart, and how a press racing a timeout becomes two logouts.
  it("there is exactly ONE termination call in the component", () => {
    const calls = read(DEVICE_APP).match(/await endEmployeePosSession\(/g) ?? [];

    expect(calls.length).toBe(1);
  });

  it("both take the SAME single-flight ref before doing anything", () => {
    const body = lockCode();

    expect(body).toContain("if (ringOutInFlightRef.current)");
    expect(body.indexOf("if (ringOutInFlightRef.current)")).toBeLessThan(
      body.indexOf("beginEmployeeSwitch(gateRef.current)")
    );
    expect(body).toContain("} finally {");
    expect(body.slice(body.indexOf("} finally {"))).toContain("ringOutInFlightRef.current = false");
  });
});

// ---------------------------------------------------------------------------
// The ordering CP3/CP3.1 established, still intact
// ---------------------------------------------------------------------------

describe("local authority goes first, for both reasons", () => {
  it("captures the session id BEFORE clearing it", () => {
    const body = lockCode();

    const capture = body.indexOf(
      "const expectedEmployeePosSessionId = gateRef.current.employee?.employeeSessionId"
    );
    const clear = body.indexOf("beginEmployeeSwitch(gateRef.current)");

    expect(capture).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(clear);
  });

  it("writes gateRef before the first await, because checkout reads the ref", () => {
    const body = lockCode();

    expect(body.indexOf("gateRef.current = lockedOut")).toBeLessThan(
      body.indexOf("await endEmployeePosSession(")
    );
  });

  // NEGATIVE CONTROL: awaiting before the transition reopens the window in
  // which a new sale could begin under the operator who is being locked out.
  it("awaits nothing before the transition", () => {
    const body = lockCode();

    expect(body.slice(0, body.indexOf("beginEmployeeSwitch(gateRef.current)"))).not.toContain("await ");
  });

  it("uses the CP3.1 expectation-bound termination, never the zero-arg logout", () => {
    const body = lockCode();

    expect(body).toContain("await endEmployeePosSession(expectedEmployeePosSessionId)");
    expect(body).not.toContain("employeeLogout");
    expect(stripComments(read(DEVICE_APP))).not.toContain("employee_logout");
  });

  it("keeps the accepted transport-failure transition", () => {
    const body = lockCode();

    expect(body).toContain('result.error === "offline"');
    expect(body).toContain("await enterOfflineRef.current?.()");
  });

  // NEGATIVE CONTROL: no answer may hand authority back.
  it("no server answer restores an employee", () => {
    const body = lockCode();

    for (const forbidden of [
      "applyEmployeeAuthenticated",
      "applyReconnectDerivation",
      "deriveGateState",
      "readEmployeeSession",
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// The deadline, and what may move it
// ---------------------------------------------------------------------------

describe("ten minutes, fixed", () => {
  it("is one constant and it is 600000", () => {
    expect(read(AUTO_LOCK)).toContain("export const AUTO_LOCK_TIMEOUT_MS = 600_000;");
  });

  // NEGATIVE CONTROL: a till with a "Never" option is a till set to Never.
  it("offers no alternate durations and no setting", () => {
    const helperSource = stripComments(read(AUTO_LOCK));
    const effect = effectCode();

    for (const forbidden of ["300_000", "900_000", "1_800_000", "Never", "timeoutOptions", "setTimeoutMinutes"]) {
      expect(helperSource).not.toContain(forbidden);
      expect(effect).not.toContain(forbidden);
    }
  });

  it("the effect passes no duration of its own", () => {
    expect(effectCode()).not.toMatch(/\b\d{4,}\b/);
  });
});

describe("only trusted human events are subscribed", () => {
  it("subscribes exactly pointerdown, keydown and wheel", () => {
    expect(read(AUTO_LOCK)).toContain(
      'export const AUTO_LOCK_ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel"] as const;'
    );
    expect(effectCode()).toContain("for (const type of AUTO_LOCK_ACTIVITY_EVENTS)");
  });

  // NEGATIVE CONTROL: the single most likely wrong answer.
  it("never listens for mousemove", () => {
    expect(stripComments(read(AUTO_LOCK))).not.toContain("mousemove");
    expect(effectCode()).not.toContain("mousemove");
  });

  it("requires isTrusted rather than assuming it", () => {
    expect(stripComments(read(AUTO_LOCK))).toContain("event.isTrusted !== true");
  });

  it("treats resume as a CHECK, subscribed separately from activity", () => {
    const effect = effectCode();

    // visibilitychange/focus reach onResume, never onActivity.
    const activity = effect.slice(effect.indexOf("onActivity:"), effect.indexOf("onResume:"));

    expect(activity).not.toContain("visibilitychange");
    expect(activity).not.toContain('"focus"');
    expect(effect.slice(effect.indexOf("onResume:"))).toContain("visibilitychange");
    expect(effect.slice(effect.indexOf("onResume:"))).toContain('window.addEventListener("focus"');
  });
});

// ---------------------------------------------------------------------------
// Where the listeners live
// ---------------------------------------------------------------------------

describe("the runtime tree stays free of listeners", () => {
  // The inert boundary is only trustworthy because PosRuntime has no document
  // listeners. recoveryCartPreservation.guards.test.ts pins that; this makes
  // sure CP4 did not quietly become the exception.
  it("PosRuntime gained no activity listener", () => {
    const runtime = stripComments(read(POS_RUNTIME));

    for (const banned of ["pointerdown", "keydown", "wheel", "document.addEventListener", "startAutoLock"]) {
      expect(`${POS_RUNTIME}: ${banned}`).toBe(`${POS_RUNTIME}: ${banned}`);
      expect(runtime).not.toContain(banned);
    }
  });

  it("no template or editor layout gained one either", () => {
    const walk = (dir: string): string[] => {
      const out: string[] = [];

      for (const entry of readdirSync(join(repoRoot, dir))) {
        const child = join(dir, entry);

        if (statSync(join(repoRoot, child)).isDirectory()) out.push(...walk(child));
        else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(child);
      }

      return out;
    };

    for (const file of [...walk("components/editor/pos-layouts"), ...walk("components/runtime")]) {
      const source = stripComments(read(file));

      for (const banned of ["startAutoLock", "AUTO_LOCK_", "pointerdown"]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("the effect is keyed on the employee POS-session id", () => {
    expect(read(DEVICE_APP)).toContain(
      "}, [gate.employee?.employeeSessionId, lockOperatorOut]);"
    );
    expect(effectCode()).toContain("gate.employee?.employeeSessionId");
  });
});

// ---------------------------------------------------------------------------
// Everything Auto-Lock must not touch
// ---------------------------------------------------------------------------

describe("nothing else moves", () => {
  it("closes, opens or replaces no DAILY register", () => {
    const body = lockCode();
    const effect = effectCode();

    for (const forbidden of [
      "close_register_session",
      "closeRegisterSession",
      "open_register_session",
      "openRegisterSession",
      "ensureDailyRegisterContext",
      "acquireDaily",
      "applyDailyRefresh",
    ]) {
      expect(body).not.toContain(forbidden);
      expect(effect).not.toContain(forbidden);
    }
  });

  it("touches no cart, runtime, queue or sale", () => {
    const body = lockCode();
    const effect = effectCode();

    for (const forbidden of [
      "clearCart",
      "setCart",
      "resolveDeviceState",
      "enqueueSale",
      "runSync",
      "completeDeviceSaleV5",
      "complete_sale",
      "saleRequestId",
      "queueSchemaVersion",
      "indexedDB",
    ]) {
      expect(body).not.toContain(forbidden);
      expect(effect).not.toContain(forbidden);
    }
  });

  it("introduces no Time Clock", () => {
    const helperSource = stripComments(read(AUTO_LOCK));
    const body = lockCode();

    for (const forbidden of ["clockIn", "clockOut", "clock_in", "clock_out", "timeClock"]) {
      expect(helperSource).not.toContain(forbidden);
      expect(body).not.toContain(forbidden);
    }
  });

  it("persists no delayed termination", () => {
    const helperSource = stripComments(read(AUTO_LOCK));
    const body = lockCode();

    for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "pendingLogout", "retryTermination"]) {
      expect(helperSource).not.toContain(forbidden);
      expect(body).not.toContain(forbidden);
    }
  });

  it("leaves the sale path's expectations and no-retry rule intact", () => {
    const source = read(DEVICE_APP);

    expect(source).toContain("expectedEmployeePosSessionId: current.employee.employeeSessionId");
    expect(source).toContain("expectedRegisterSessionId: current.daily.registerSessionId");
    expect(source).toContain("STALE STATE IS NOT RETRIED");
  });

  it("keeps the gate an overlay over a mounted PosRuntime", () => {
    const source = read(DEVICE_APP);

    expect(source).toContain("inert");
    expect(source).toContain("<PosRuntime");
  });
});

describe("the helper stays pure", () => {
  it("imports nothing at all — not the product, not a framework", () => {
    // A helper that reaches into DeviceApp or a server module stops being
    // testable in isolation, and starts being able to decide things it must
    // not decide.
    expect(stripComments(read(AUTO_LOCK))).not.toContain("import ");
  });

  it("reads no clock of its own", () => {
    const helperSource = stripComments(read(AUTO_LOCK));

    // The host supplies `now`, which is what lets a test sleep an hour for free
    // and what lets a future clock strategy be substituted in one place.
    expect(helperSource).not.toContain("Date.now()");
    expect(helperSource).not.toContain("performance.now()");
    expect(helperSource).toContain("now: () => number");
  });
});
