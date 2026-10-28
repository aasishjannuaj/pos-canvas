// v1.3.4 — the quick pre-sale server check. It sends no sale; it only decides
// whether the till may send one now or should switch to offline first.
import { describe, expect, it, vi } from "vitest";
import { PRE_SALE_CHECK_TIMEOUT_MS, isServerReachableBeforeSale } from "@/lib/preSaleReachability";

const response = (status: number) => ({ type: "response" as const, status, data: null, errorCode: status >= 400 ? "x" : null });

describe("isServerReachableBeforeSale", () => {
  it("waits at most 3 seconds", () => {
    expect(PRE_SALE_CHECK_TIMEOUT_MS).toBe(3_000);
  });

  it("any server answer — even an error status — is reachable", async () => {
    for (const status of [200, 401, 404, 500, 503]) {
      expect(await isServerReachableBeforeSale(async () => response(status))).toBe(true);
    }
  });

  it("a transport failure, a rejection or a synchronous throw is unreachable", async () => {
    expect(await isServerReachableBeforeSale(async () => ({ type: "transport" as const }))).toBe(false);
    expect(await isServerReachableBeforeSale(async () => { throw new Error("x"); })).toBe(false);
    expect(await isServerReachableBeforeSale(() => { throw new Error("x"); })).toBe(false);
  });

  it("silence past the deadline is unreachable, and the probe is aborted", async () => {
    let fire: () => void = () => {};
    let seen: AbortSignal | null = null;
    const result = isServerReachableBeforeSale(
      (signal) => { seen = signal; return new Promise(() => {}); },
      { setTimer: (run) => { fire = run; return 1; }, clearTimer: () => {} }
    );
    fire();
    expect(await result).toBe(false);
    expect(seen!.aborted).toBe(true);
  });

  it("a late answer after the deadline cannot flip the result", async () => {
    let fire: () => void = () => {};
    let answer: (v: unknown) => void = () => {};
    const result = isServerReachableBeforeSale(
      () => new Promise((resolve) => { answer = resolve as never; }),
      { setTimer: (run) => { fire = run; return 1; }, clearTimer: () => {} }
    );
    fire();
    answer(response(200));
    expect(await result).toBe(false);
  });

  it("clears its timer when the server answers in time", async () => {
    const clearTimer = vi.fn();
    await isServerReachableBeforeSale(async () => response(200), { setTimer: () => 7, clearTimer });
    expect(clearTimer).toHaveBeenCalledWith(7);
  });
});
