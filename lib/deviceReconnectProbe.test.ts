// v1.3 CP2e follow-up — the automatic reconnect probe.
//
// THE STAGING FAILURE THIS PINS. A paired till held authoritative employee and
// DAILY context, the backend was made unreachable while the LINK STAYED UP, and
// one sale was taken offline and queued correctly. The backend was then
// restored. Nothing recovered: the till never asked the server again, the queue
// never drained, a replaced employee POS-session was never noticed, and every
// further sale queued. navigator.onLine read true the entire time, so the
// browser's `online` event — the reconnect path's ONLY trigger — never fired.
// Dispatching that event by hand recovered everything immediately, which proved
// the reconnect path itself was correct and the TRIGGER was the whole defect.
//
// These tests drive the real loop with fake timers and an injected host, so
// what they assert is the shipped scheduling policy rather than a copy of it.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  RECONNECT_PROBE_BACKOFF_MS,
  RECONNECT_PROBE_MAX_MS,
  nextReconnectProbeDelayMs,
  startReconnectProbe,
} from "@/lib/deviceReconnectProbe";
import type { ReconnectProbeHost, ReconnectProbeTimer } from "@/lib/deviceReconnectProbe";

// ---------------------------------------------------------------------------
// A host that records what the loop asked for, so the schedule is observable.
// ---------------------------------------------------------------------------

type Harness = {
  host: ReconnectProbeHost;
  /** Every delay the loop scheduled, in order. This IS the backoff curve. */
  delays: number[];
  /** How many times the loop called the reconnect path. */
  attempts: () => number;
  /** How many attempts were running at once, ever. Must never exceed 1. */
  peakConcurrent: () => number;
  fireForeground: () => void;
  setVisible: (visible: boolean) => void;
  /** Resolve the pending attempt, then let the loop's own promise settle. */
  settle: () => Promise<void>;
  stop: () => void;
};

function makeHarness(options: { succeedOnAttempt?: number } = {}): Harness {
  const delays: number[] = [];
  let visible = true;
  let handler: (() => void) | null = null;
  let attempts = 0;
  let concurrent = 0;
  let peak = 0;

  const host: ReconnectProbeHost = {
    isVisible: () => visible,
    onForeground: (h) => {
      handler = h;
      return () => {
        handler = null;
      };
    },
    setTimer: (run, delayMs) => {
      delays.push(delayMs);
      return setTimeout(run, delayMs) as unknown as ReconnectProbeTimer;
    },
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  };

  let stop: () => void = () => undefined;

  const attempt = async (): Promise<void> => {
    attempts += 1;
    concurrent += 1;
    peak = Math.max(peak, concurrent);

    // One microtask turn of real async, the way a network call behaves.
    await Promise.resolve();

    concurrent -= 1;

    // A successful probe is terminal because the caller tears the loop down
    // when the till leaves offline mode. Modelled exactly that way.
    if (options.succeedOnAttempt !== undefined && attempts >= options.succeedOnAttempt) {
      stop();
    }
  };

  stop = startReconnectProbe(host, attempt);

  return {
    host,
    delays,
    attempts: () => attempts,
    peakConcurrent: () => peak,
    fireForeground: () => handler?.(),
    setVisible: (v) => {
      visible = v;
    },
    settle: async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    stop: () => stop(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// The curve itself
// ---------------------------------------------------------------------------

describe("nextReconnectProbeDelayMs", () => {
  it("is the schedule Control Room locked: 5 -> 10 -> 20 -> 30 -> 60", () => {
    expect(RECONNECT_PROBE_BACKOFF_MS).toEqual([5_000, 10_000, 20_000, 30_000, 60_000]);
  });

  it("returns each step in order, then holds at 60s forever", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 50].map(nextReconnectProbeDelayMs)).toEqual([
      5_000, 10_000, 20_000, 30_000, 60_000, 60_000, 60_000, 60_000,
    ]);
  });

  it("never exceeds the declared maximum", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(nextReconnectProbeDelayMs(i)).toBeLessThanOrEqual(RECONNECT_PROBE_MAX_MS);
    }
  });

  // NEGATIVE CONTROL: a caller that lost count must still get a usable delay.
  // Returning NaN would hand NaN to setTimeout, which fires immediately and
  // turns a backoff into a hot loop against the backend.
  it("clamps nonsense input instead of producing NaN", () => {
    expect(nextReconnectProbeDelayMs(-1)).toBe(5_000);
    expect(nextReconnectProbeDelayMs(-999)).toBe(5_000);
    expect(nextReconnectProbeDelayMs(2.7)).toBe(20_000);
    expect(nextReconnectProbeDelayMs(Number.NaN)).toBe(RECONNECT_PROBE_MAX_MS);
    expect(nextReconnectProbeDelayMs(Number.POSITIVE_INFINITY)).toBe(RECONNECT_PROBE_MAX_MS);
  });
});

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

describe("startReconnectProbe", () => {
  it("probes automatically with no browser online event at all", async () => {
    const h = makeHarness();

    expect(h.attempts()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(h.attempts()).toBe(1);
    h.stop();
  });

  it("schedules the first attempt 5s after entering offline mode", () => {
    const h = makeHarness();

    expect(h.delays[0]).toBe(5_000);
    h.stop();
  });

  // NEGATIVE CONTROL: nothing may fire before the first step elapses.
  it("does not probe early", async () => {
    const h = makeHarness();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.attempts()).toBe(0);

    h.stop();
  });

  it("stays offline on a failed probe and schedules the next step", async () => {
    const h = makeHarness();

    await vi.advanceTimersByTimeAsync(5_000);
    await h.settle();

    // Still running: the attempt did not reach the backend, so the loop armed
    // the next step rather than giving up.
    expect(h.attempts()).toBe(1);
    expect(h.delays).toEqual([5_000, 10_000]);

    h.stop();
  });

  it("walks the exact backoff curve across consecutive failures", async () => {
    const h = makeHarness();

    for (const step of [5_000, 10_000, 20_000, 30_000, 60_000, 60_000]) {
      await vi.advanceTimersByTimeAsync(step);
      await h.settle();
    }

    expect(h.attempts()).toBe(6);
    expect(h.delays).toEqual([5_000, 10_000, 20_000, 30_000, 60_000, 60_000, 60_000]);

    h.stop();
  });

  it("stops scheduling once the caller tears the loop down on success", async () => {
    const h = makeHarness({ succeedOnAttempt: 2 });

    await vi.advanceTimersByTimeAsync(5_000);
    await h.settle();
    await vi.advanceTimersByTimeAsync(10_000);
    await h.settle();

    expect(h.attempts()).toBe(2);

    // NEGATIVE CONTROL: hours may pass and nothing further may be attempted.
    const scheduledAtSuccess = h.delays.length;
    await vi.advanceTimersByTimeAsync(60_000 * 60);
    await h.settle();

    expect(h.attempts()).toBe(2);
    expect(h.delays.length).toBe(scheduledAtSuccess);
  });

  it("attempts immediately when the till returns to the foreground", async () => {
    const h = makeHarness();

    h.fireForeground();
    await h.settle();

    // No timer had to elapse: a cashier waiting at the till gets an attempt now.
    expect(h.attempts()).toBe(1);

    h.stop();
  });

  it("collapses duplicate foreground signals into ONE backend attempt", async () => {
    const h = makeHarness();

    // visibilitychange and focus both arrive for a single foreground.
    h.fireForeground();
    h.fireForeground();
    h.fireForeground();

    expect(h.attempts()).toBe(1);
    expect(h.peakConcurrent()).toBe(1);

    await h.settle();
    h.stop();
  });

  it("never runs two attempts concurrently, however hard it is pushed", async () => {
    const h = makeHarness();

    for (let i = 0; i < 25; i += 1) {
      h.fireForeground();
    }
    await vi.advanceTimersByTimeAsync(5_000);
    await h.settle();

    expect(h.peakConcurrent()).toBe(1);

    h.stop();
  });

  it("pauses scheduled probing while hidden", async () => {
    const h = makeHarness();

    h.setVisible(false);
    h.fireForeground(); // the hide notification itself
    const before = h.attempts();

    await vi.advanceTimersByTimeAsync(60_000 * 10);
    await h.settle();

    // NEGATIVE CONTROL: ten minutes hidden must produce no traffic at all.
    expect(h.attempts()).toBe(before);

    h.stop();
  });

  it("probes immediately on resume and resumes scheduling", async () => {
    const h = makeHarness();

    h.setVisible(false);
    h.fireForeground();
    await vi.advanceTimersByTimeAsync(60_000 * 10);
    expect(h.attempts()).toBe(0);

    h.setVisible(true);
    h.fireForeground();
    await h.settle();

    expect(h.attempts()).toBe(1);

    // And the clock is running again.
    await vi.advanceTimersByTimeAsync(10_000);
    await h.settle();
    expect(h.attempts()).toBe(2);

    h.stop();
  });

  it("does not schedule at all when it starts hidden", () => {
    const delays: number[] = [];
    const stop = startReconnectProbe(
      {
        isVisible: () => false,
        onForeground: () => () => undefined,
        setTimer: (run, delayMs) => {
          delays.push(delayMs);
          return setTimeout(run, delayMs) as unknown as ReconnectProbeTimer;
        },
        clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      },
      async () => undefined
    );

    expect(delays).toEqual([]);
    stop();
  });

  it("unsubscribes its lifecycle listeners when stopped", () => {
    let subscribed = 0;
    const stop = startReconnectProbe(
      {
        isVisible: () => true,
        onForeground: () => {
          subscribed += 1;
          return () => {
            subscribed -= 1;
          };
        },
        setTimer: (run, delayMs) => setTimeout(run, delayMs) as unknown as ReconnectProbeTimer,
        clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      },
      async () => undefined
    );

    expect(subscribed).toBe(1);
    stop();
    expect(subscribed).toBe(0);
  });

  // NEGATIVE CONTROL: a torn-down loop must be inert even if a stray lifecycle
  // signal arrives afterwards — a backgrounded Android WebView does exactly
  // this, and an attempt after teardown would race the next episode.
  it("ignores foreground signals delivered after it was stopped", async () => {
    const h = makeHarness();

    h.stop();
    h.fireForeground();
    await vi.advanceTimersByTimeAsync(60_000);
    await h.settle();

    expect(h.attempts()).toBe(0);
  });

  it("starts a genuinely new episode at the beginning of the curve", async () => {
    const first = makeHarness();
    await vi.advanceTimersByTimeAsync(5_000);
    await first.settle();
    await vi.advanceTimersByTimeAsync(10_000);
    await first.settle();
    expect(first.delays).toEqual([5_000, 10_000, 20_000]);
    first.stop();

    // A new outage mounts a new loop, which must not inherit the 20s position.
    const second = makeHarness();
    expect(second.delays).toEqual([5_000]);
    second.stop();
  });
});
