// G-1-CLIENT-1 requirement 2 — an employee established online is NOT logged
// out merely because connectivity fails; everything else still locks.
//
// Pure gate rules (lib/posGate.ts) plus the employee adapter's classification
// (lib/employee.rpc.ts), with the Supabase client mocked at its one boundary.
// The REAL app behaviour — minimise/resume during an outage, then an offline
// sale under the same attribution — is exercised in the browser suite.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyReconnectDerivation,
  applyStartupLock,
  beginEmployeeSwitch,
  buildOfflineClaims,
  canCheckoutOffline,
  clearPosGateState,
  resolvePosGate,
} from "@/lib/posGate";
import type { PosGateState } from "@/lib/posGate";
import type { EmployeeSession } from "@/lib/employeeSession";
import type { DailyRegisterContext } from "@/lib/dailyRegister";

const rpc = vi.fn();

vi.mock("@/lib/supabase/deviceClient", () => ({
  DEVICE_AUTH_STORAGE_KEY: "pos-canvas-device-auth",
  getDeviceSupabaseClient: () => ({ rpc }),
  resetDeviceSupabaseClientCache: () => {},
}));

const { fetchCurrentEmployeeSession } = await import("@/lib/employee.rpc");

const AMY: EmployeeSession = {
  employeeSessionId: "5e550000-0000-4000-8000-0000000000a1",
  employeeId: "e0000000-0000-4000-8000-0000000000a1",
  displayName: "Amy",
  role: "cashier",
  startedAt: "2026-10-15T13:00:00.000Z",
};

const TODAY: DailyRegisterContext = {
  registerSessionId: "f0000000-0000-4000-8000-0000000000f1",
  businessDate: "2026-10-15",
  businessTimezone: "America/New_York",
  openedAt: "2026-10-15T04:00:00.000Z",
  closedAt: "2026-10-16T04:00:00.000Z",
};

const ESTABLISHED: PosGateState = {
  employee: AMY,
  daily: TODAY,
  establishedOnline: true,
  recovery: null,
  setup: null,
};

const unavailableDaily = { ok: false, reason: "unavailable" } as const;

beforeEach(() => {
  rpc.mockReset();
});

describe("the gate rule", () => {
  it("a CONFIRMED transport failure keeps exactly what this till established", () => {
    const next = applyReconnectDerivation(ESTABLISHED, {
      employee: { ok: false, unreached: "offline" },
      daily: unavailableDaily,
    });

    expect(next).toBe(ESTABLISHED);
    expect(resolvePosGate(next)).toBe("pos");
    expect(canCheckoutOffline(next)).toEqual({ ok: true });
    // The offline sale would carry THIS employee and register.
    expect(buildOfflineClaims(next)).toEqual({
      employeePosSessionId: AMY.employeeSessionId,
      registerSessionId: TODAY.registerSessionId,
    });
  });

  it("an UNCLASSIFIED or server-answered failure still locks (fail closed, as before)", () => {
    const next = applyReconnectDerivation(ESTABLISHED, { employee: { ok: false }, daily: unavailableDaily });

    expect(next).toEqual(applyStartupLock());
    expect(resolvePosGate(next)).toBe("employee");
    expect(canCheckoutOffline(next).ok).toBe(false);
  });

  it("a reachable server reporting a different or no session still locks", () => {
    for (const session of [null, { ...AMY, employeeSessionId: "5e550000-0000-4000-8000-0000000000a2" }]) {
      const next = applyReconnectDerivation(ESTABLISHED, { employee: { ok: true, session }, daily: unavailableDaily });

      expect(resolvePosGate(next)).toBe("employee");
    }
  });

  it("a locked till stays locked through a transport failure — it is never a way in", () => {
    const next = applyReconnectDerivation(applyStartupLock(), {
      employee: { ok: false, unreached: "offline" },
      daily: unavailableDaily,
    });

    expect(resolvePosGate(next)).toBe("employee");
    expect(canCheckoutOffline(next).ok).toBe(false);
  });

  it("explicit switch and loss of authority still prevent checkout, offline included", () => {
    expect(canCheckoutOffline(beginEmployeeSwitch(ESTABLISHED)).ok).toBe(false);
    expect(resolvePosGate(beginEmployeeSwitch(ESTABLISHED))).toBe("employee");
    expect(canCheckoutOffline(clearPosGateState()).ok).toBe(false);
  });

  it("a pending recovery survives the transport failure (nothing reopens)", () => {
    const recovering: PosGateState = { ...ESTABLISHED, daily: null, establishedOnline: false, recovery: "daily" };
    const next = applyReconnectDerivation(recovering, {
      employee: { ok: false, unreached: "offline" },
      daily: unavailableDaily,
    });

    expect(next).toBe(recovering);
    expect(canCheckoutOffline(next).ok).toBe(false);
  });
});

describe("only a request that never reached a server reads as `offline`", () => {
  it("postgrest's synthesized fetch failure -> offline", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: "TypeError: Failed to fetch", details: "TypeError: Failed to fetch\n    at …", hint: "", code: "" },
      status: 0,
    });

    expect(await fetchCurrentEmployeeSession()).toMatchObject({ ok: false, error: "offline" });
  });

  it("a server ANSWER carrying the code 'offline' is read as a refusal, never as transport", async () => {
    rpc.mockResolvedValue({ data: { ok: false, error: "offline" }, error: null, status: 200 });

    expect(await fetchCurrentEmployeeSession()).toMatchObject({ ok: false, error: "unavailable" });
  });

  it("an HTTP error from the server -> unavailable", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: "JWT expired", code: "PGRST301", details: null, hint: null },
      status: 401,
    });

    expect(await fetchCurrentEmployeeSession()).toMatchObject({ ok: false, error: "unavailable" });
  });

  it("a thrown network error -> offline", async () => {
    rpc.mockRejectedValue(new TypeError("Failed to fetch"));

    expect(await fetchCurrentEmployeeSession()).toMatchObject({ ok: false, error: "offline" });
  });
});
