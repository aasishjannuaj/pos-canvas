// v1.3 Cash Drawer Checkpoint 1C — the renderer side of the Windows hardware
// bridge: lib/windowsCashDrawer.ts, and how the 1A coordinator uses it.
//
// The adapter forwards NOTHING (zero arguments), decides nothing, maps every
// non-status reply / rejection / throw / timeout to `unknown`, and never calls
// the bridge twice. Through the coordinator, the bridge is reached only after
// cash, live Windows, the owner's setting and the durable claim, and its
// outcome can never reach the sale.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CASH_DRAWER_BRIDGE_TIMEOUT_MS,
  createWindowsCashDrawerCapability,
  detectCashDrawerBridge,
  resolveCashDrawerCapability,
} from "@/lib/windowsCashDrawer";
import { UNAVAILABLE_CASH_DRAWER, runAutomaticDrawerEvent } from "@/lib/cashDrawer";
import { claimAutomaticDrawerEvent } from "@/lib/cashDrawerSession";

const SALE = "6f1d2a4e-7b3c-4d5e-8f90-a1b2c3d4e5f6";
const event = { saleRequestId: SALE };

/** A bridge that records how it was called and answers `reply`. */
function bridge(reply: () => unknown = () => Promise.resolve("sent")) {
  const calls: unknown[][] = [];
  // Returns whatever `reply` gives, including a synchronous throw: the cast only
  // satisfies the bridge's declared type, so non-promise replies stay testable.
  const open = (...args: unknown[]): Promise<unknown> => {
    calls.push(args);
    return reply() as Promise<unknown>;
  };

  return { open, calls };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { window?: unknown }).window;
});

describe("detecting the bridge", () => {
  it("accepts only an object whose openCashDrawer is a function", () => {
    const open = () => Promise.resolve("sent");

    expect(detectCashDrawerBridge({ openCashDrawer: open })).toBe(open);

    for (const value of [undefined, null, true, "x", {}, { openCashDrawer: "sent" }, { openCashDrawer: {} }]) {
      expect(detectCashDrawerBridge(value)).toBeNull();
    }
  });

  it("no window, or no bridge, resolves to the 1A no-op — unavailable", async () => {
    expect(resolveCashDrawerCapability()).toBe(UNAVAILABLE_CASH_DRAWER);

    (globalThis as { window?: unknown }).window = {};
    expect(resolveCashDrawerCapability()).toBe(UNAVAILABLE_CASH_DRAWER);

    // The Windows IDENTITY fact is not a drawer: posCanvasDesktop alone gives nothing.
    (globalThis as { window?: unknown }).window = { posCanvasDesktop: { isWindowsShell: true } };
    expect(resolveCashDrawerCapability()).toBe(UNAVAILABLE_CASH_DRAWER);
    expect(await UNAVAILABLE_CASH_DRAWER.requestOpen(event)).toBe("unavailable");
  });

  it("the exposed bridge resolves to an available capability, and resolving calls nothing", () => {
    const b = bridge();

    (globalThis as { window?: unknown }).window = { posCanvasCashDrawer: { openCashDrawer: b.open } };

    const capability = resolveCashDrawerCapability();

    expect(capability.available).toBe(true);
    expect(b.calls).toHaveLength(0);
  });
});

describe("the capability forwards nothing and decides nothing", () => {
  it("calls openCashDrawer exactly once with ZERO arguments — the sale id never crosses", async () => {
    const b = bridge();

    await createWindowsCashDrawerCapability(b.open).requestOpen(event);

    expect(b.calls).toEqual([[]]);
    expect(JSON.stringify(b.calls)).not.toContain(SALE);
  });

  it("preserves every known status", async () => {
    for (const status of ["sent", "not_configured", "failed", "unknown", "unavailable"] as const) {
      const b = bridge(() => Promise.resolve(status));

      expect(await createWindowsCashDrawerCapability(b.open).requestOpen(event)).toBe(status);
    }
  });

  it("anything else is unknown — including the retired 'opened', objects and wrong case", async () => {
    for (const reply of ["opened", "SENT", "", null, undefined, 1, { status: "sent" }, ["sent"]]) {
      const b = bridge(() => Promise.resolve(reply));

      expect(await createWindowsCashDrawerCapability(b.open).requestOpen(event)).toBe("unknown");
    }
  });

  it("a rejection or a synchronous throw is unknown, never thrown", async () => {
    const rejecting = bridge(() => Promise.reject(new Error("ipc gone")));
    const throwing = bridge(() => {
      throw new Error("bridge broken");
    });

    await expect(createWindowsCashDrawerCapability(rejecting.open).requestOpen(event)).resolves.toBe("unknown");
    await expect(createWindowsCashDrawerCapability(throwing.open).requestOpen(event)).resolves.toBe("unknown");
    expect(rejecting.calls).toHaveLength(1);
    expect(throwing.calls).toHaveLength(1);
  });
});

describe("the ten-second timeout", () => {
  it("is ten seconds", () => {
    expect(CASH_DRAWER_BRIDGE_TIMEOUT_MS).toBe(10_000);
  });

  it("no answer within ten seconds is unknown, the bridge is NOT called again, and a late answer is ignored", async () => {
    vi.useFakeTimers();

    let answer: (value: unknown) => void = () => undefined;
    const b = bridge(() => new Promise((resolve) => (answer = resolve)));
    const pending = createWindowsCashDrawerCapability(b.open).requestOpen(event);

    await vi.advanceTimersByTimeAsync(9_999);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe("unknown");

    answer("sent");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await pending).toBe("unknown");
    expect(b.calls).toHaveLength(1);
  });

  it("an answer in time clears the timer", async () => {
    const cleared: unknown[] = [];
    const capability = createWindowsCashDrawerCapability(bridge().open, {
      setTimer: () => "timer-1",
      clearTimer: (handle) => cleared.push(handle),
    });

    expect(await capability.requestOpen(event)).toBe("sent");
    expect(cleared).toEqual(["timer-1"]);
  });
});

describe("through the 1A coordinator", () => {
  const capability = (reply: () => unknown) => {
    const b = bridge(reply);
    return { b, capability: createWindowsCashDrawerCapability(b.open) };
  };

  it("eligible Windows cash sale with the owner's setting on: claimed, then the bridge once", async () => {
    const { b, capability: cap } = capability(() => Promise.resolve("sent"));

    expect(
      await runAutomaticDrawerEvent({
        event: { saleRequestId: SALE, paymentMethod: "cash" },
        platform: "windows",
        autoOpenEnabled: true,
        claim: claimAutomaticDrawerEvent,
        capability: cap,
      })
    ).toEqual({ status: "requested", outcome: "sent" });
    expect(b.calls).toEqual([[]]);
  });

  it("card, Android, web and a disabled device never reach the bridge", async () => {
    const { b, capability: cap } = capability(() => Promise.resolve("sent"));

    for (const [paymentMethod, platform, autoOpenEnabled] of [
      ["card", "windows", true],
      ["cash", "android", true],
      ["cash", "web", true],
      ["cash", "windows", false],
    ] as const) {
      await runAutomaticDrawerEvent({
        event: { saleRequestId: SALE, paymentMethod },
        platform,
        autoOpenEnabled,
        claim: claimAutomaticDrawerEvent,
        capability: cap,
      });
    }

    expect(b.calls).toHaveLength(0);
  });

  it("unknown, failed and timeout are final: the same sale never reaches the bridge again", async () => {
    // The timeout is fired by hand through the adapter's injectable timer:
    // fake timers would also freeze fake-indexeddb, which the real claim uses.
    let fireTimeout: () => void = () => undefined;
    const b = bridge(() => new Promise(() => undefined));
    const cap = createWindowsCashDrawerCapability(b.open, {
      setTimer: (callback) => {
        fireTimeout = callback;
        return "timer";
      },
      clearTimer: () => undefined,
    });
    const run = () =>
      runAutomaticDrawerEvent({
        event: { saleRequestId: SALE, paymentMethod: "cash" },
        platform: "windows",
        autoOpenEnabled: true,
        claim: claimAutomaticDrawerEvent,
        capability: cap,
      });

    const first = run();

    // Wait for the claim to commit and the bridge to be called, then time out.
    await vi.waitFor(() => expect(b.calls).toHaveLength(1));
    fireTimeout();

    expect(await first).toEqual({ status: "requested", outcome: "unknown" });
    expect(await run()).toEqual({ status: "already_claimed" });
    expect(b.calls).toHaveLength(1);
  });

  it("a hardware failure never escapes: the coordinator resolves, so the sale it follows is untouched", async () => {
    for (const reply of [
      () => Promise.reject(new Error("spooler")),
      () => {
        throw new Error("bridge");
      },
      () => Promise.resolve("failed"),
    ]) {
      globalThis.indexedDB = new IDBFactory();

      const { capability: cap } = capability(reply);

      await expect(
        runAutomaticDrawerEvent({
          event: { saleRequestId: SALE, paymentMethod: "cash" },
          platform: "windows",
          autoOpenEnabled: true,
          claim: claimAutomaticDrawerEvent,
          capability: cap,
        })
      ).resolves.toMatchObject({ status: "requested" });
    }
  });
});
