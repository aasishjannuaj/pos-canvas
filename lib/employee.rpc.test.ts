// v1.3 Feature 1A / 1A.1 — behavioural tests for the employee RPC boundary.
//
// WHY THIS FILE MOCKS. lib/employeeSecurity.guards.test.ts proves structure by
// reading source, and lib/employeeSession.test.ts proves the pure model.
// Neither can prove what this file exists for: that a SUBMITTED login attempt
// actually reaches public.employee_login carrying the selected employee id and
// the exact string the operator typed, and that the selector is asked for with
// no arguments. Those are claims about calls being made, so the calls must be
// observable. Only lib/supabase/deviceClient is replaced.
//
// THE RULES BEING PROTECTED.
//   * Every submitted attempt reaches the server, malformed or not: the server
//     records a malformed PIN as a counted device failure, and a client that
//     refused it locally would hand out free probes.
//   * Login sends exactly { p_employee_id, p_pin } — never a project or device.
//   * Feature 1A.1 retired the PIN-only employee_login(text). Nothing may call
//     employee_login with a PIN alone again.
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();

vi.mock("@/lib/supabase/deviceClient", () => ({
  DEVICE_AUTH_STORAGE_KEY: "pos-canvas-device-auth",
  getDeviceSupabaseClient: () => ({ rpc }),
  resetDeviceSupabaseClientCache: () => {},
}));

const { employeeLogin, employeeLogout, fetchCurrentEmployeeSession, fetchLoginEmployees } =
  await import("@/lib/employee.rpc");

function replies(data: unknown) {
  rpc.mockResolvedValue({ data, error: null, status: 200, statusText: "OK" });
}

const ADA = "11111111-1111-4111-8111-111111111111";
const SAM_ONE = "22222222-2222-4222-8222-222222222222";
const SAM_TWO = "33333333-3333-4333-8333-333333333333";

const SESSION = {
  employeeSessionId: "44444444-4444-4444-8444-444444444444",
  employeeId: ADA,
  displayName: "Ada",
  role: "manager",
  startedAt: "2026-09-16T10:00:00.000Z",
};

beforeEach(() => {
  rpc.mockReset();
});

// ---------------------------------------------------------------------------
// The selector
// ---------------------------------------------------------------------------

describe("fetchLoginEmployees", () => {
  it("asks list_login_employees with no arguments at all", async () => {
    replies({ ok: true, employees: [] });

    await fetchLoginEmployees();

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("list_login_employees");
    expect(rpc.mock.calls[0].length).toBe(1);
  });

  it("returns the roster in server order, two fields each", async () => {
    replies({
      ok: true,
      employees: [
        { employeeId: ADA, displayName: "Ada" },
        { employeeId: SAM_ONE, displayName: "Sam" },
        { employeeId: SAM_TWO, displayName: "Sam" },
      ],
    });

    expect(await fetchLoginEmployees()).toEqual({
      ok: true,
      employees: [
        { employeeId: ADA, displayName: "Ada" },
        { employeeId: SAM_ONE, displayName: "Sam" },
        { employeeId: SAM_TWO, displayName: "Sam" },
      ],
    });
  });

  it("drops anything the server over-shares", async () => {
    replies({
      ok: true,
      employees: [
        {
          employeeId: ADA,
          displayName: "Ada",
          role: "owner",
          pin_hash: "$2a$10$leaked",
          active: true,
          deactivatedAt: null,
        },
      ],
    });

    const result = await fetchLoginEmployees();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.employees[0]).sort()).toEqual(["displayName", "employeeId"]);
    }
  });

  it("passes not_paired through, so a revoked till can act on it", async () => {
    replies({ ok: false, error: "not_paired" });

    const result = await fetchLoginEmployees();

    expect(result).toMatchObject({ ok: false, error: "not_paired" });
  });

  it("reports an unreachable server as offline or unavailable", async () => {
    rpc.mockRejectedValue(new Error("boom"));

    const result = await fetchLoginEmployees();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["offline", "unavailable"]).toContain(result.error);
    }
  });
});

// ---------------------------------------------------------------------------
// Every submitted attempt reaches the server
// ---------------------------------------------------------------------------

describe("a submitted login attempt always reaches employee_login", () => {
  const MALFORMED = ["123", "1234567", "12a4", " 1234", "1234 ", "", "١٢٣٤", "12 4", "1234\n"];

  for (const pin of MALFORMED) {
    it(`sends ${JSON.stringify(pin)} with the selected employee instead of refusing it`, async () => {
      replies({ ok: false, error: "invalid_credentials" });

      await employeeLogin(ADA, pin);

      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith("employee_login", { p_employee_id: ADA, p_pin: pin });
    });

    it(`transmits ${JSON.stringify(pin)} byte-for-byte`, async () => {
      replies({ ok: false, error: "invalid_credentials" });

      await employeeLogin(ADA, pin);

      const sent = (rpc.mock.calls[0][1] as { p_pin: string }).p_pin;

      expect(sent).toBe(pin);
      expect(sent.length).toBe(pin.length);
    });
  }

  it("never answers invalid_credentials without having called the server", async () => {
    for (const pin of [...MALFORMED, "1234", "123456"]) {
      rpc.mockReset();
      replies({ ok: false, error: "invalid_credentials" });

      const result = await employeeLogin(ADA, pin);

      if (!result.ok && result.error === "invalid_credentials") {
        expect(rpc).toHaveBeenCalledTimes(1);
      }
    }
  });

  it("sends the employee id unmodified — it is the server's to judge", async () => {
    replies({ ok: false, error: "invalid_credentials" });

    for (const id of [ADA, "not-a-uuid", "", ` ${ADA} `]) {
      rpc.mockReset();
      replies({ ok: false, error: "invalid_credentials" });

      await employeeLogin(id, "1234");

      expect((rpc.mock.calls[0][1] as { p_employee_id: string }).p_employee_id).toBe(id);
    }
  });

  it("sends exactly two arguments — no project id, no device id, no role", async () => {
    replies({ ok: true, ...SESSION });

    await employeeLogin(ADA, "1234");

    expect(rpc.mock.calls[0][0]).toBe("employee_login");
    expect(Object.keys(rpc.mock.calls[0][1] as object).sort()).toEqual(["p_employee_id", "p_pin"]);
  });

  it("never calls the retired PIN-only signature", async () => {
    replies({ ok: true, ...SESSION });

    await employeeLogin(ADA, "1234");

    for (const call of rpc.mock.calls) {
      if (call[0] === "employee_login") {
        expect(call[1]).toHaveProperty("p_employee_id");
      }
    }
  });

  it("lets two employees who share a PIN each be selected independently", async () => {
    replies({ ok: true, ...SESSION, employeeId: SAM_ONE, displayName: "Sam" });
    await employeeLogin(SAM_ONE, "4242");

    replies({ ok: true, ...SESSION, employeeId: SAM_TWO, displayName: "Sam" });
    await employeeLogin(SAM_TWO, "4242");

    expect(rpc.mock.calls.map((c) => (c[1] as { p_employee_id: string }).p_employee_id)).toEqual([
      SAM_ONE,
      SAM_TWO,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

describe("employeeLogin result mapping", () => {
  it("returns the server-derived session on success, role included", async () => {
    replies({ ok: true, ...SESSION });

    expect(await employeeLogin(ADA, "1234")).toEqual({ ok: true, session: SESSION });
  });

  it("carries a lockout wait through", async () => {
    replies({ ok: false, error: "locked_out", retryAfterSeconds: 15 });

    expect(await employeeLogin(ADA, "1234")).toEqual({
      ok: false,
      error: "locked_out",
      retryAfterSeconds: 15,
      message: "Too many incorrect PINs. Try again in 15 seconds.",
    });
  });

  it("reports a transport failure as offline, never as a bad PIN", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: "Failed to fetch", status: 0 },
      status: 0,
      statusText: "",
    });

    const result = await employeeLogin(ADA, "1234");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("offline");
    }
  });

  it("reports a thrown error as offline or unavailable, never as a bad PIN", async () => {
    rpc.mockRejectedValue(new Error("boom"));

    const result = await employeeLogin(ADA, "1234");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["offline", "unavailable"]).toContain(result.error);
    }
  });

  it("does not put the PIN or the employee id in the failure it returns", async () => {
    rpc.mockRejectedValue(new Error("boom"));

    const result = await employeeLogin(ADA, "987654");

    expect(JSON.stringify(result)).not.toContain("987654");
    expect(JSON.stringify(result)).not.toContain(ADA);
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
