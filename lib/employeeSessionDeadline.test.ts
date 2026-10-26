// OFF-3 — fetchCurrentEmployeeSession's optional deadline.
//
// The deadline bounds the WHOLE call (authentication preparation included),
// aborts the underlying request, discards any late outcome, and never turns a
// server answer that arrived in time into a timeout. Without it the call is
// exactly what it was.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Answer = { data: unknown; error: unknown; status: number };

let behave: (signal: AbortSignal | null) => Promise<Answer>;
const abortSignalCalls: AbortSignal[] = [];
let rpcCalls = 0;

vi.mock("@/lib/supabase/deviceClient", () => ({
  DEVICE_AUTH_STORAGE_KEY: "pos-canvas-device-auth",
  getDeviceSupabaseClient: () => ({
    rpc: (name: string) => {
      rpcCalls += 1;
      expect(name).toBe("get_current_employee_session");
      let signal: AbortSignal | null = null;
      const builder = {
        abortSignal(s: AbortSignal) {
          signal = s;
          abortSignalCalls.push(s);
          return builder;
        },
        then<A, B>(ok?: (v: Answer) => A, fail?: (e: unknown) => B) {
          return behave(signal).then(ok, fail);
        },
      };
      return builder;
    },
  }),
}));

const { fetchCurrentEmployeeSession } = await import("@/lib/employee.rpc");

const SESSION = {
  ok: true,
  session: {
    employeeSessionId: "5e550000-0000-4000-8000-000000000001",
    employeeId: "e0000000-0000-4000-8000-000000000101",
    displayName: "Synthetic One",
    role: "cashier",
    startedAt: "2026-10-18T18:00:00.000Z",
  },
};

const answer = (data: unknown): Answer => ({ data, error: null, status: 200 });

/** Never settles unless aborted; when aborted, settles the way postgrest-js reports an abort. */
const hangUntilAborted = (signal: AbortSignal | null) =>
  new Promise<Answer>((resolve) => {
    signal?.addEventListener("abort", () =>
      resolve({ data: null, error: { message: "AbortError: aborted", code: "" }, status: 0 })
    );
  });

beforeEach(() => {
  vi.useFakeTimers();
  abortSignalCalls.length = 0;
  rpcCalls = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchCurrentEmployeeSession with a deadline", () => {
  it("an answer inside the deadline is returned exactly as without one", async () => {
    behave = async () => answer(SESSION);
    const result = await fetchCurrentEmployeeSession({ timeoutMs: 10_000 });

    expect(result.ok).toBe(true);
    expect(rpcCalls).toBe(1);
    expect(abortSignalCalls).toHaveLength(1);
    expect(abortSignalCalls[0].aborted).toBe(false);
  });

  it("a hung request is reported offline AT the deadline and its fetch is aborted", async () => {
    behave = hangUntilAborted;
    let settled: unknown = null;
    const pending = fetchCurrentEmployeeSession({ timeoutMs: 10_000 }).then((r) => (settled = r));

    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(settled).toMatchObject({ ok: false, error: "offline" });
    expect(abortSignalCalls[0].aborted).toBe(true);
  });

  it("slow authentication preparation that IGNORES the abort still cannot outlast the deadline", async () => {
    // Models supabase-js awaiting getSession()/a token refresh before fetch:
    // the abort signal does not reach that step at all.
    behave = () => new Promise<Answer>((resolve) => setTimeout(() => resolve(answer(SESSION)), 30_000));
    let settled: unknown = null;
    const pending = fetchCurrentEmployeeSession({ timeoutMs: 10_000 }).then((r) => (settled = r));

    await vi.advanceTimersByTimeAsync(10_000);
    await pending;

    expect(settled).toMatchObject({ ok: false, error: "offline" });
  });

  it("a late success after the deadline is discarded: the caller already has `offline`", async () => {
    behave = () => new Promise<Answer>((resolve) => setTimeout(() => resolve(answer(SESSION)), 12_000));
    const pending = fetchCurrentEmployeeSession({ timeoutMs: 10_000 });

    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    await vi.advanceTimersByTimeAsync(5_000);
    expect(result).toMatchObject({ ok: false, error: "offline" });
  });

  it("an explicit refusal inside the deadline is NOT a timeout (stays `unavailable`)", async () => {
    behave = async () => ({ data: null, error: { code: "PGRST301", message: "JWT expired" }, status: 401 });
    const result = await fetchCurrentEmployeeSession({ timeoutMs: 10_000 });

    expect(result).toMatchObject({ ok: false, error: "unavailable" });
  });

  it("a server body carrying `offline` inside the deadline stays a refusal", async () => {
    behave = async () => answer({ ok: false, error: "offline" });
    const result = await fetchCurrentEmployeeSession({ timeoutMs: 10_000 });

    expect(result).toMatchObject({ ok: false, error: "unavailable" });
  });

  it("a fast transport failure inside the deadline is `offline`, as before", async () => {
    behave = async () => ({
      data: null,
      error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" },
      status: 0,
    });
    const result = await fetchCurrentEmployeeSession({ timeoutMs: 10_000 });

    expect(result).toMatchObject({ ok: false, error: "offline" });
  });
});

describe("fetchCurrentEmployeeSession WITHOUT a deadline is unchanged", () => {
  it("attaches no abort signal and waits as long as the request takes", async () => {
    behave = () => new Promise<Answer>((resolve) => setTimeout(() => resolve(answer(SESSION)), 60_000));
    let settled: unknown = null;
    const pending = fetchCurrentEmployeeSession().then((r) => (settled = r));

    await vi.advanceTimersByTimeAsync(59_999);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(abortSignalCalls).toHaveLength(0);
    expect((settled as { ok: boolean }).ok).toBe(true);
  });
});
