// v1.3 CP3 — Ring Out: the operator hands the till back.
//
// WHAT RING OUT IS. It ends one person's authority to operate this POS. It is
// not a clock out, not a register close, not an end of the business day, and
// not a handoff wizard. Employee POS-session, DAILY register and any future
// time-clock session are three independent lifecycles, and Ring Out touches
// exactly one of them.
//
// WHY THE LOCAL ACT COMES FIRST. The decision is made at the till by a person
// standing there. If it were a request the server had to grant, then a till
// that lost its backend could not hand over safely -- which is precisely when
// handing over matters, because the alternative is walking away from an
// unlocked register. So the local transition is applied before anything is
// awaited, and no server answer may reverse it.
//
// These tests pin the primitives that transition carries. The ordering inside
// DeviceApp -- ref before await, guard before transition -- is pinned by
// lib/ringOut.guards.test.ts, because ordering is a property of the call site.
import { describe, expect, it } from "vitest";
import {
  EMPTY_POS_GATE_STATE,
  applyEmployeeAuthenticated,
  applyReconnectDerivation,
  beginEmployeeSwitch,
  canCheckoutOffline,
  resolvePosGate,
} from "@/lib/posGate";
import type { PosGateState } from "@/lib/posGate";
import type { EmployeeSession } from "@/lib/employeeSession";
import type { DailyRegisterContext } from "@/lib/dailyRegister";

const ADA: EmployeeSession = {
  employeeSessionId: "11111111-1111-4111-8111-111111111111",
  employeeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  displayName: "Ada",
  role: "cashier",
  startedAt: "2026-09-26T13:00:00.000Z",
};

// Same human being, a NEW session. The server issues one of these on every
// login, which is exactly why a UUID match on the employee is not authority.
const ADA_RELOGIN: EmployeeSession = {
  ...ADA,
  employeeSessionId: "22222222-2222-4222-8222-222222222222",
  startedAt: "2026-09-26T13:40:00.000Z",
};

const BO: EmployeeSession = {
  employeeSessionId: "33333333-3333-4333-8333-333333333333",
  employeeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  displayName: "Bo",
  role: "cashier",
  startedAt: "2026-09-26T13:45:00.000Z",
};

const TODAY: DailyRegisterContext = {
  registerSessionId: "44444444-4444-4444-8444-444444444444",
  businessDate: "2026-09-26",
  businessTimezone: "America/New_York",
  openedAt: "2026-09-26T04:00:00.000Z",
  closedAt: "2026-09-27T04:00:00.000Z",
};

/** A till Ada signed into, online, with today's context established. */
function adaOnTill(): PosGateState {
  const state = applyEmployeeAuthenticated({
    employee: ADA,
    daily: { ok: true, context: TODAY },
    revalidated: { ok: true, session: ADA },
  });

  expect(state.employee?.employeeSessionId).toBe(ADA.employeeSessionId);
  expect(state.daily?.registerSessionId).toBe(TODAY.registerSessionId);
  expect(resolvePosGate(state)).toBe("pos");

  return state;
}

describe("the local Ring Out transition", () => {
  it("clears the employee", () => {
    expect(beginEmployeeSwitch(adaOnTill()).employee).toBeNull();
  });

  it("closes the POS behind the employee gate", () => {
    expect(resolvePosGate(beginEmployeeSwitch(adaOnTill()))).toBe("employee");
  });

  it("KEEPS the DAILY register — a business day is not a drawer period", () => {
    const after = beginEmployeeSwitch(adaOnTill());

    expect(after.daily).not.toBeNull();
    expect(after.daily?.registerSessionId).toBe(TODAY.registerSessionId);
    expect(after.daily?.businessDate).toBe("2026-09-26");
    expect(after.daily?.businessTimezone).toBe("America/New_York");
  });

  it("drops the online establishment, so nothing offline is authorized", () => {
    expect(beginEmployeeSwitch(adaOnTill()).establishedOnline).toBe(false);
  });

  // NEGATIVE CONTROL: Ring Out is a handover, not an incident. Raising a
  // recovery would send the next operator to a screen built for a server
  // refusal, and would outrank the ordinary login they actually need.
  it("raises no recovery and no setup", () => {
    const after = beginEmployeeSwitch(adaOnTill());

    expect(after.recovery).toBeNull();
    expect(after.setup).toBeNull();
  });

  it("is idempotent — a second Ring Out changes nothing further", () => {
    const once = beginEmployeeSwitch(adaOnTill());
    const twice = beginEmployeeSwitch(once);

    expect(twice).toEqual(once);
  });
});

describe("a rung-out till cannot take a sale", () => {
  it("refuses offline checkout once the employee is gone", () => {
    const after = beginEmployeeSwitch(adaOnTill());
    const gate = canCheckoutOffline(after);

    expect(gate.ok).toBe(false);
  });

  // NEGATIVE CONTROL: the DAILY survives, and on its own it must not be
  // mistaken for permission to ring anything.
  it("is refused even though the DAILY context is still held", () => {
    const after = beginEmployeeSwitch(adaOnTill());

    expect(after.daily).not.toBeNull();
    expect(canCheckoutOffline(after).ok).toBe(false);
  });
});

describe("the server cannot give the authority back", () => {
  it("a reconnect that finds the OLD session still open keeps the till locked", () => {
    // Exactly the offline Ring Out case: the logout never reached the server,
    // so the session is still open and the read succeeds. It is still not
    // authority, because this operator gave it up here.
    const after = beginEmployeeSwitch(adaOnTill());

    const reconnected = applyReconnectDerivation(after, {
      employee: { ok: true, session: ADA },
      daily: { ok: true, context: TODAY },
    });

    expect(reconnected.employee).toBeNull();
    expect(resolvePosGate(reconnected)).toBe("employee");
  });

  it("a reconnect that finds a DIFFERENT operator does not adopt them", () => {
    const after = beginEmployeeSwitch(adaOnTill());

    const reconnected = applyReconnectDerivation(after, {
      employee: { ok: true, session: BO },
      daily: { ok: true, context: TODAY },
    });

    expect(reconnected.employee).toBeNull();
    expect(resolvePosGate(reconnected)).toBe("employee");
  });

  it("a reconnect that finds nobody keeps the till locked", () => {
    const after = beginEmployeeSwitch(adaOnTill());

    const reconnected = applyReconnectDerivation(after, {
      employee: { ok: true, session: null },
      daily: { ok: true, context: TODAY },
    });

    expect(reconnected.employee).toBeNull();
  });

  it("an unreachable reconnect keeps the till locked", () => {
    const after = beginEmployeeSwitch(adaOnTill());

    const reconnected = applyReconnectDerivation(after, {
      employee: { ok: false },
      daily: { ok: false, reason: "unavailable" },
    });

    expect(reconnected.employee).toBeNull();
  });
});

describe("the next operator", () => {
  it("must authenticate explicitly — the same person is a NEW session", () => {
    const after = beginEmployeeSwitch(adaOnTill());
    expect(after.employee).toBeNull();

    const back = applyEmployeeAuthenticated({
      employee: ADA_RELOGIN,
      daily: { ok: true, context: TODAY },
      revalidated: { ok: true, session: ADA_RELOGIN },
    });

    expect(back.employee?.employeeSessionId).toBe(ADA_RELOGIN.employeeSessionId);
    expect(back.employee?.employeeSessionId).not.toBe(ADA.employeeSessionId);
    expect(resolvePosGate(back)).toBe("pos");
  });

  // NEGATIVE CONTROL. The same employee UUID with a stale session id is the
  // exact shape a silent restore would produce, and it must not establish.
  it("cannot establish on the OLD session id even as the same employee", () => {
    const stale = applyEmployeeAuthenticated({
      employee: ADA_RELOGIN,
      daily: { ok: true, context: TODAY },
      revalidated: { ok: true, session: ADA },
    });

    expect(stale).toEqual(EMPTY_POS_GATE_STATE);
    expect(resolvePosGate(stale)).toBe("employee");
  });

  it("a different employee signs in through the same flow", () => {
    const bo = applyEmployeeAuthenticated({
      employee: BO,
      daily: { ok: true, context: TODAY },
      revalidated: { ok: true, session: BO },
    });

    expect(bo.employee?.employeeId).toBe(BO.employeeId);
    expect(resolvePosGate(bo)).toBe("pos");
  });

  it("gets the SAME current business day back, not a new one", () => {
    const bo = applyEmployeeAuthenticated({
      employee: BO,
      daily: { ok: true, context: TODAY },
      revalidated: { ok: true, session: BO },
    });

    expect(bo.daily?.registerSessionId).toBe(TODAY.registerSessionId);
    expect(bo.daily?.businessDate).toBe(TODAY.businessDate);
  });
});

describe("attribution follows authority at checkout, not who built the cart", () => {
  it("after a handover the till holds BO's session, never Ada's", () => {
    // Ada rings items, rings out, Bo signs in. The cart is untouched by all of
    // it; what changed is whose session the next sale will be sent under.
    const adasTill = adaOnTill();
    expect(adasTill.employee?.employeeId).toBe(ADA.employeeId);

    const handedBack = beginEmployeeSwitch(adasTill);

    const bosTill = applyEmployeeAuthenticated({
      employee: BO,
      daily: { ok: true, context: handedBack.daily ?? TODAY },
      revalidated: { ok: true, session: BO },
    });

    expect(bosTill.employee?.employeeId).toBe(BO.employeeId);
    expect(bosTill.employee?.employeeSessionId).toBe(BO.employeeSessionId);
    expect(bosTill.employee?.employeeSessionId).not.toBe(ADA.employeeSessionId);

    // And the day the sale lands on is still the one that was already open.
    expect(bosTill.daily?.registerSessionId).toBe(TODAY.registerSessionId);
  });
});
