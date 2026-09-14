// v1.3 Feature 1A — behavioural tests for the employee RPC boundary.
//
// WHY THIS FILE EXISTS, AND WHY IT MOCKS.
//
// lib/employeeSecurity.guards.test.ts proves structural properties by reading
// source text, and lib/employeeSession.test.ts proves the pure model. Neither
// can prove the property this file exists for: that a SUBMITTED login attempt
// actually reaches public.employee_login carrying the exact string the operator
// typed. That is a claim about a call being made, so it needs the call to be
// observable.
//
// This is the first vi.mock in this repository. It is deliberately narrow: only
// lib/supabase/deviceClient is replaced, the module under test is the real one,
// and nothing here touches a network, a database or a browser.
//
// THE RULE BEING PROTECTED. employee_login resolves the active paired device
// FIRST and only then inspects the PIN, so a malformed PIN is a recorded failed
// attempt that advances the lockout ladder. A client that refused malformed
// input locally would delete that record, hand an attacker unlimited free
// probes against the device-scoped counter, and report "not recognised" for a
// submission the server never saw. A previous revision of employeeLogin did
// exactly that; these tests are why it cannot come back.
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();

vi.mock("@/lib/supabase/deviceClient", () => ({
  DEVICE_AUTH_STORAGE_KEY: "pos-canvas-device-auth",
  getDeviceSupabaseClient: () => ({ rpc }),
  resetDeviceSupabaseClientCache: () => {},
}));

const { employeeLogin, employeeLogout, fetchCurrentEmployeeSession } = await import(
  "@/lib/employee.rpc"
);

/** What supabase-js hands back from a successful `.rpc()`. */
function replies(data: unknown) {
  rpc.mockResolvedValue({ data, error: null, status: 200, statusText: "OK" });
}

const SESSION = {
  employeeSessionId: "11111111-1111-1111-1111-111111111111",
  employeeId: "22222222-2222-2222-2222-222222222222",
  displayName: "Sam",
  role: "cashier",
  startedAt: "2026-09-14T10:00:00.000Z",
};

beforeEach(() => {
  rpc.mockReset();
});

// ---------------------------------------------------------------------------
// The correction: every submitted attempt reaches the server
// ---------------------------------------------------------------------------

describe("a submitted login attempt always reaches employee_login", () => {
  // The exact values the manager's ruling enumerates, plus the empty string and
  // a Unicode-digit PIN, which are the other two ways a keypad can produce
  // something the server's `^[0-9]{4,6}$` will reject.
  const MALFORMED = ["123", "1234567", "12a4", " 1234", "1234 ", "", "١٢٣٤", "12 4", "1234\n"];

  for (const pin of MALFORMED) {
    it(`sends ${JSON.stringify(pin)} to the RPC instead of refusing it locally`, async () => {
      replies({ ok: false, error: "invalid_credentials" });

      await employeeLogin(pin);

      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith("employee_login", { p_pin: pin });
    });

    it(`transmits ${JSON.stringify(pin)} byte-for-byte — no trim, pad or repair`, async () => {
      replies({ ok: false, error: "invalid_credentials" });

      await employeeLogin(pin);

      const sent = (rpc.mock.calls[0][1] as { p_pin: string }).p_pin;

      // Identity, not equivalence: a trimmed or normalized value would differ.
      expect(sent).toBe(pin);
      expect(sent.length).toBe(pin.length);
    });
  }

  it("still reports the server's generic answer for a malformed attempt", async () => {
    replies({ ok: false, error: "invalid_credentials" });

    const result = await employeeLogin("12a4");

    expect(result).toEqual({
      ok: false,
      error: "invalid_credentials",
      message: "That PIN was not recognised.",
    });
  });

  it("never answers invalid_credentials without having called the server", async () => {
    // The regression in one assertion: if any input short-circuits, the RPC
    // call count for that input is zero while the result claims a credential
    // verdict the server never gave.
    for (const pin of [...MALFORMED, "1234", "123456"]) {
      rpc.mockReset();
      replies({ ok: false, error: "invalid_credentials" });

      const result = await employeeLogin(pin);

      if (!result.ok && result.error === "invalid_credentials") {
        expect(rpc).toHaveBeenCalledTimes(1);
      }
    }
  });

  it("sends a well-formed PIN unchanged too", async () => {
    replies({ ok: true, ...SESSION });

    for (const pin of ["0000", "1234", "12345", "123456"]) {
      rpc.mockReset();
      replies({ ok: true, ...SESSION });

      await employeeLogin(pin);

      expect(rpc).toHaveBeenCalledWith("employee_login", { p_pin: pin });
    }
  });

  it("sends the PIN and nothing else — no project id, no device id", async () => {
    replies({ ok: true, ...SESSION });

    await employeeLogin("1234");

    expect(rpc.mock.calls[0][0]).toBe("employee_login");
    expect(Object.keys(rpc.mock.calls[0][1] as object)).toEqual(["p_pin"]);
  });
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

describe("employeeLogin result mapping", () => {
  it("returns the session on success", async () => {
    replies({ ok: true, ...SESSION });

    expect(await employeeLogin("1234")).toEqual({ ok: true, session: SESSION });
  });

  it("carries a lockout wait through", async () => {
    replies({ ok: false, error: "locked_out", retryAfterSeconds: 30 });

    expect(await employeeLogin("1234")).toEqual({
      ok: false,
      error: "locked_out",
      retryAfterSeconds: 30,
      message: "Too many incorrect PINs. Try again in 30 seconds.",
    });
  });

  it("reports a transport failure as offline, never as a bad PIN", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: "Failed to fetch", status: 0 },
      status: 0,
      statusText: "",
    });

    const result = await employeeLogin("1234");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("offline");
      expect(result.error).not.toBe("invalid_credentials");
    }
  });

  it("reports a thrown error as offline or unavailable, never as a bad PIN", async () => {
    rpc.mockRejectedValue(new Error("boom"));

    const result = await employeeLogin("1234");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["offline", "unavailable"]).toContain(result.error);
    }
  });

  it("does not put the PIN in the failure it returns", async () => {
    rpc.mockRejectedValue(new Error("boom"));

    const result = await employeeLogin("987654");

    expect(JSON.stringify(result)).not.toContain("987654");
  });
});

// ---------------------------------------------------------------------------
// The other two calls
// ---------------------------------------------------------------------------

describe("the zero-argument calls send no arguments", () => {
  it("get_current_employee_session takes nothing", async () => {
    replies({ ok: true, session: null });

    expect(await fetchCurrentEmployeeSession()).toEqual({ ok: true, session: null });
    expect(rpc).toHaveBeenCalledWith("get_current_employee_session");
    expect(rpc.mock.calls[0].length).toBe(1);
  });

  it("employee_logout takes nothing, so no other device can be named", async () => {
    replies({ ok: true, endedSessionId: SESSION.employeeSessionId });

    expect(await employeeLogout()).toEqual({
      ok: true,
      endedSessionId: SESSION.employeeSessionId,
    });
    expect(rpc).toHaveBeenCalledWith("employee_logout");
    expect(rpc.mock.calls[0].length).toBe(1);
  });

  it("logout is idempotent when nobody is signed in", async () => {
    replies({ ok: true, endedSessionId: null });

    expect(await employeeLogout()).toEqual({ ok: true, endedSessionId: null });
  });
});
