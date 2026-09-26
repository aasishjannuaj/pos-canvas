// v1.3 CP4 — the ten-minute Auto-Lock, driven with fake timers.
//
// THE SITUATION THIS EXISTS FOR. A cashier walks away mid-shift and nobody
// presses Ring Out. Until now the till stayed signed in, so the next person to
// pick it up sold under that cashier's name and session. Auto-Lock is the till
// deciding it has not heard from anyone for long enough to keep trusting them.
//
// WHAT IS ACTUALLY BEING TESTED. The shipped loop, through an injected host —
// not a re-implementation of it. The host is what makes ten minutes cost
// microseconds: the clock is a variable, so "the machine slept for an hour"
// is one assignment rather than an hour of waiting.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_LOCK_ACTIVITY_EVENTS,
  AUTO_LOCK_MESSAGE,
  AUTO_LOCK_TIMEOUT_MS,
  autoLockDeadlineFrom,
  autoLockRemainingMs,
  hasAutoLockExpired,
  isTrustedActivity,
  startAutoLock,
} from "@/lib/autoLock";
import type { AutoLockTimer, ObservedActivity } from "@/lib/autoLock";

// ---------------------------------------------------------------------------
// A host whose clock is a variable, so sleep and background cost nothing.
// ---------------------------------------------------------------------------

type Harness = {
  /** Every delay the loop scheduled, in order. */
  delays: number[];
  /** How many timers are armed right now. Must never exceed 1. */
  live: () => number;
  locks: () => number;
  /** Move the world forward: advances BOTH the clock and the timers. */
  advance: (ms: number) => Promise<void>;
  /** Move the clock WITHOUT running timers — a suspended machine. */
  sleep: (ms: number) => void;
  activity: (event: ObservedActivity) => void;
  resume: () => void;
  stop: () => void;
};

function makeHarness(): Harness {
  const delays: number[] = [];
  let clock = 1_000_000;
  let armed = 0;
  let locks = 0;
  let activityHandler: ((event: ObservedActivity) => void) | null = null;
  let resumeHandler: (() => void) | null = null;

  const stop = startAutoLock(
    {
      now: () => clock,
      setTimer: (run, delayMs) => {
        delays.push(delayMs);
        armed += 1;
        const id = setTimeout(() => {
          armed -= 1;
          run();
        }, delayMs);
        return id as unknown as AutoLockTimer;
      },
      clearTimer: (timer) => {
        armed -= 1;
        clearTimeout(timer as ReturnType<typeof setTimeout>);
      },
      onActivity: (handler) => {
        activityHandler = handler;
        return () => { activityHandler = null; };
      },
      onResume: (handler) => {
        resumeHandler = handler;
        return () => { resumeHandler = null; };
      },
    },
    () => { locks += 1; }
  );

  return {
    delays,
    live: () => armed,
    locks: () => locks,
    advance: async (ms) => {
      clock += ms;
      await vi.advanceTimersByTimeAsync(ms);
    },
    sleep: (ms) => { clock += ms; },
    activity: (event) => activityHandler?.(event),
    resume: () => resumeHandler?.(),
    stop,
  };
}

const trusted = (type: string): ObservedActivity => ({ type, isTrusted: true });
const synthetic = (type: string): ObservedActivity => ({ type, isTrusted: false });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

// ---------------------------------------------------------------------------
// The constant and the arithmetic
// ---------------------------------------------------------------------------

describe("the timeout is fixed at ten minutes", () => {
  it("is exactly 600000ms", () => {
    expect(AUTO_LOCK_TIMEOUT_MS).toBe(600_000);
    expect(AUTO_LOCK_TIMEOUT_MS).toBe(10 * 60 * 1000);
  });

  it("computes a deadline ten minutes after the activity", () => {
    expect(autoLockDeadlineFrom(1_000)).toBe(601_000);
  });

  it("reports remaining time, never negative", () => {
    expect(autoLockRemainingMs(601_000, 1_000)).toBe(600_000);
    expect(autoLockRemainingMs(601_000, 600_999)).toBe(1);
    expect(autoLockRemainingMs(601_000, 601_000)).toBe(0);
    expect(autoLockRemainingMs(601_000, 9_999_999)).toBe(0);
  });

  it("expires AT the deadline, not after it", () => {
    expect(hasAutoLockExpired(601_000, 600_999)).toBe(false);
    expect(hasAutoLockExpired(601_000, 601_000)).toBe(true);
    expect(hasAutoLockExpired(601_000, 601_001)).toBe(true);
  });

  // NEGATIVE CONTROL: nonsense must not produce NaN, which would make a
  // setTimeout fire immediately and lock a till mid-sale.
  it("treats a non-finite deadline as expired rather than as NaN", () => {
    expect(autoLockRemainingMs(Number.NaN, 1)).toBe(0);
    expect(hasAutoLockExpired(Number.NaN, 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// What counts as a person
// ---------------------------------------------------------------------------

describe("only a real person resets the deadline", () => {
  it("accepts exactly pointerdown, keydown and wheel", () => {
    expect(AUTO_LOCK_ACTIVITY_EVENTS).toEqual(["pointerdown", "keydown", "wheel"]);

    for (const type of AUTO_LOCK_ACTIVITY_EVENTS) {
      expect(isTrustedActivity(trusted(type))).toBe(true);
    }
  });

  // NEGATIVE CONTROL. A cursor resting under a shop fan, or a van shaking the
  // counter, would hold a till open all night.
  it("rejects mousemove even when genuinely trusted", () => {
    expect(isTrustedActivity(trusted("mousemove"))).toBe(false);
  });

  // NEGATIVE CONTROL. A window coming forward is not a person; treating it as
  // one would let a background tab refresh the deadline indefinitely.
  it("rejects focus and visibilitychange", () => {
    expect(isTrustedActivity(trusted("focus"))).toBe(false);
    expect(isTrustedActivity(trusted("visibilitychange"))).toBe(false);
  });

  // NEGATIVE CONTROL. dispatchEvent and element.click() produce isTrusted
  // false — this is what separates a finger from a script.
  it("rejects synthetic events of the RIGHT type", () => {
    for (const type of AUTO_LOCK_ACTIVITY_EVENTS) {
      expect(isTrustedActivity(synthetic(type))).toBe(false);
    }
  });

  it("rejects a missing or non-boolean isTrusted", () => {
    expect(isTrustedActivity({ type: "keydown" } as unknown as ObservedActivity)).toBe(false);
    expect(isTrustedActivity({ type: "keydown", isTrusted: "yes" } as unknown as ObservedActivity)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The episode
// ---------------------------------------------------------------------------

describe("an authority episode", () => {
  it("1. arms a 600000ms deadline the moment it starts", () => {
    const h = makeHarness();

    expect(h.delays[0]).toBe(600_000);
    h.stop();
  });

  it("2. does not lock at 599999ms", async () => {
    const h = makeHarness();

    await h.advance(599_999);

    expect(h.locks()).toBe(0);
    h.stop();
  });

  it("3-4. locks at exactly 600000ms", async () => {
    const h = makeHarness();

    await h.advance(600_000);

    expect(h.locks()).toBe(1);
  });

  it("5-7. trusted pointerdown, keydown and wheel each reset it", async () => {
    for (const type of AUTO_LOCK_ACTIVITY_EVENTS) {
      const h = makeHarness();

      await h.advance(599_000);
      h.activity(trusted(type));
      await h.advance(599_000);

      // 1,198s of wall clock, but only 599s since the touch.
      expect(h.locks()).toBe(0);

      await h.advance(1_000);
      expect(h.locks()).toBe(1);
    }
  });

  it("8-10. synthetic events of the right type do NOT reset it", async () => {
    for (const type of AUTO_LOCK_ACTIVITY_EVENTS) {
      const h = makeHarness();

      await h.advance(599_000);
      h.activity(synthetic(type));
      await h.advance(1_000);

      expect(h.locks()).toBe(1);
    }
  });

  it("11-13. mousemove, focus and visibilitychange do not reset it", async () => {
    const h = makeHarness();

    await h.advance(599_000);
    h.activity(trusted("mousemove"));
    h.activity(trusted("focus"));
    h.activity(trusted("visibilitychange"));
    await h.advance(1_000);

    expect(h.locks()).toBe(1);
  });

  // 14. Nothing the app does to itself is even offered to the loop: the host
  // subscribes only to the three human events. This asserts the consequence —
  // time passing while the app is busy still locks the till.
  it("14. app activity does not hold the till open", async () => {
    const h = makeHarness();

    // Stand in for a queue drain, a reconnect probe, a config refresh: the
    // loop is never told about any of them.
    await h.advance(600_000);

    expect(h.locks()).toBe(1);
  });

  it("15. repeated activity leaves exactly ONE armed timer", async () => {
    const h = makeHarness();

    for (let i = 0; i < 50; i += 1) {
      h.activity(trusted("pointerdown"));
      expect(h.live()).toBe(1);
    }

    await h.advance(599_999);
    expect(h.locks()).toBe(0);
    await h.advance(1);
    expect(h.locks()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Hidden, resumed, slept
// ---------------------------------------------------------------------------

describe("hidden time counts", () => {
  it("16-18. back before the deadline keeps authority and only the REMAINING time", async () => {
    const h = makeHarness();

    await h.advance(120_000);        // two minutes of use
    h.sleep(180_000);                // hidden for three
    h.resume();

    expect(h.locks()).toBe(0);

    // The resume scheduled what was left, not a fresh ten minutes.
    expect(h.delays.at(-1)).toBe(300_000);

    // And it really does lock five minutes later, not fifteen.
    await h.advance(299_999);
    expect(h.locks()).toBe(0);
    await h.advance(1);
    expect(h.locks()).toBe(1);
  });

  it("19. resuming exactly at the deadline locks", () => {
    const h = makeHarness();

    h.sleep(600_000);
    h.resume();

    expect(h.locks()).toBe(1);
  });

  it("20-21. resuming after a long sleep locks immediately and synchronously", () => {
    const h = makeHarness();

    // The machine was asleep: the clock moved, the timers did not.
    h.sleep(60 * 60 * 1000);
    h.resume();

    // Synchronous — no await. An expired till must lose authority before the
    // operator's next interaction can rely on it.
    expect(h.locks()).toBe(1);
  });

  it("a resume that fires repeatedly still locks only once", () => {
    const h = makeHarness();

    h.sleep(900_000);
    h.resume();
    h.resume();
    h.resume();

    expect(h.locks()).toBe(1);
  });

  // NEGATIVE CONTROL: resume must never extend. If it did, a till could be
  // held open forever by nothing more than a window regaining focus.
  it("resuming never pushes the deadline out", async () => {
    const h = makeHarness();

    await h.advance(599_000);
    h.resume();
    h.resume();
    await h.advance(1_000);

    expect(h.locks()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Ending the episode
// ---------------------------------------------------------------------------

describe("the episode ends exactly once", () => {
  it("24-25. stopping cancels the deadline — Ring Out and stale locks do this", async () => {
    const h = makeHarness();

    h.stop();
    await h.advance(600_000 * 10);

    expect(h.locks()).toBe(0);
    expect(h.live()).toBe(0);
  });

  it("37. a resume racing the timer produces ONE lock", async () => {
    const h = makeHarness();

    h.sleep(600_000);
    h.resume();                 // locks here
    await h.advance(600_000);   // the armed timer would have fired too

    expect(h.locks()).toBe(1);
  });

  it("activity after expiry cannot revive the episode", async () => {
    const h = makeHarness();

    await h.advance(600_000);
    expect(h.locks()).toBe(1);

    h.activity(trusted("keydown"));
    await h.advance(600_000);

    expect(h.locks()).toBe(1);
  });

  it("36. a fresh episode starts a fresh ten minutes", async () => {
    const first = makeHarness();
    await first.advance(600_000);
    expect(first.locks()).toBe(1);

    // A re-login is a new session id, so DeviceApp mounts a new episode.
    const second = makeHarness();
    expect(second.delays[0]).toBe(600_000);

    await second.advance(599_999);
    expect(second.locks()).toBe(0);
    second.stop();
  });

  it("unsubscribes both listener sets when stopped", () => {
    const h = makeHarness();

    h.stop();
    h.activity(trusted("pointerdown"));
    h.resume();

    expect(h.locks()).toBe(0);
  });
});

describe("the operator is told why", () => {
  it("names the ten minutes, without jargon", () => {
    expect(AUTO_LOCK_MESSAGE).toBe("Locked after 10 minutes of inactivity.");
    expect(AUTO_LOCK_MESSAGE).not.toMatch(/session|RPC|token|timer|null/i);
  });
});
