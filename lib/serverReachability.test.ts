// IND-1 — the display-only reachability loop, driven with a deterministic fake
// clock and timer queue so every request, abort and late result is observable.
//
// What these pin: one underlying request at a time; real cancellation (the
// signal handed to the check is aborted); >= 5s between any two starts whatever
// triggered them; 5/10/20/30s failure backoff; nothing while hidden or paused;
// coalesced lifecycle events; and that a late result can never overwrite newer
// evidence or report after stop().
import { describe, expect, it } from "vitest";
import {
  LIVE_CHECK_MIN_SPACING_MS,
  LIVE_CHECK_TIMEOUT_MS,
} from "@/lib/liveStatus";
import type { LiveEvidence, ReachabilityProbeResult } from "@/lib/liveStatus";
import { startServerReachability } from "@/lib/serverReachability";
import type { ReachabilityControl, ReachabilityHost } from "@/lib/serverReachability";

const DEVICE = "d0000000-0000-4000-8000-0000000000d1";

const PAIRED = {
  paired: true,
  device_id: DEVICE,
  project_id: "b0000000-0000-4000-8000-0000000000b1",
  build_job_id: "c0000000-0000-4000-8000-0000000000c1",
  device_name: "Till",
  platform: "web",
  created_at: null,
  revoked_at: null,
  active: true,
};

const OK: ReachabilityProbeResult = { type: "response", status: 200, data: PAIRED, errorCode: null };
const DOWN: ReachabilityProbeResult = { type: "transport" };
const ERROR_500: ReachabilityProbeResult = { type: "response", status: 500, data: null, errorCode: "unknown" };

/**
 * How one check behaves: answer `result` after `latencyMs` (fake clock), or
 * "hang" until aborted. `settleOnAbortAfterMs` models a request that does not
 * settle the instant it is aborted (e.g. stuck in the auth client's getSession).
 */
type Behaviour =
  | { result: ReachabilityProbeResult; latencyMs?: number; ignoreAbort?: boolean }
  | { hang: true; settleOnAbortAfterMs?: number };

type Started = { at: number; signal: AbortSignal; settledAt: number | null };

class FakeWorld {
  t = 0;
  visible = true;
  onlineHint: boolean | null = true;
  private seq = 0;
  private timers: { id: number; at: number; run: () => void }[] = [];
  handlers: { visibility: () => void; online: () => void; offline: () => void } | null = null;
  unsubscribed = 0;
  started: Started[] = [];
  reports: { t: number; evidence: LiveEvidence | null }[] = [];
  inFlight = 0;
  maxInFlight = 0;
  behave: (index: number) => Behaviour = () => ({ result: OK });

  host(): ReachabilityHost {
    return {
      now: () => this.t,
      isVisible: () => this.visible,
      readOnlineHint: () => this.onlineHint,
      setTimer: (run, delayMs) => this.setTimer(run, delayMs),
      clearTimer: (id) => {
        this.timers = this.timers.filter((timer) => timer.id !== id);
      },
      subscribe: (handlers) => {
        this.handlers = handlers;

        return () => {
          this.unsubscribed += 1;
          this.handlers = null;
        };
      },
      check: (signal) => this.check(signal),
      report: (evidence) => {
        this.reports.push({ t: this.t, evidence });
      },
    };
  }

  setTimer(run: () => void, delayMs: number): number {
    this.seq += 1;
    this.timers.push({ id: this.seq, at: this.t + Math.max(0, delayMs), run });

    return this.seq;
  }

  private check(signal: AbortSignal): Promise<ReachabilityProbeResult> {
    const record: Started = { at: this.t, signal, settledAt: null };
    const behaviour = this.behave(this.started.length);

    this.started.push(record);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);

    return new Promise<ReachabilityProbeResult>((resolve) => {
      let done = false;
      const settle = (result: ReachabilityProbeResult) => {
        if (done) return;
        done = true;
        record.settledAt = this.t;
        this.inFlight -= 1;
        resolve(result);
      };

      signal.addEventListener("abort", () => {
        if ("result" in behaviour && behaviour.ignoreAbort) return;

        const after = "hang" in behaviour ? (behaviour.settleOnAbortAfterMs ?? 0) : 0;

        if (after === 0) settle({ type: "aborted" });
        else this.setTimer(() => settle({ type: "aborted" }), after);
      });

      if ("result" in behaviour) {
        const latency = behaviour.latencyMs ?? 0;

        if (latency === 0) settle(behaviour.result);
        else this.setTimer(() => settle(behaviour.result), latency);
      }
    });
  }

  async flush(): Promise<void> {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }

  /** Advances the fake clock, running due timers in order with microtasks flushed between. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;

    await this.flush();

    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];

      if (next === undefined || next.at > target) break;

      this.timers.shift();
      this.t = next.at;
      next.run();
      await this.flush();
    }

    this.t = target;
  }

  starts(): number[] {
    return this.started.map((s) => s.at);
  }

  outcomes(): (string | null)[] {
    return this.reports.map((r) => r.evidence?.outcome ?? null);
  }

  minGap(): number {
    const s = this.starts();
    let min = Number.POSITIVE_INFINITY;

    for (let i = 1; i < s.length; i += 1) min = Math.min(min, s[i] - s[i - 1]);

    return min;
  }
}

async function boot(world: FakeWorld, deviceId = DEVICE): Promise<ReachabilityControl> {
  const control = startServerReachability(world.host(), { expectedDeviceId: deviceId });

  // The immediate check is a 0 ms timer: run everything due now.
  await world.advance(0);

  return control;
}

describe("start-up and the healthy schedule", () => {
  it("reports 'no current evidence' first, then checks immediately", async () => {
    const world = new FakeWorld();

    await boot(world);

    expect(world.reports[0]).toEqual({ t: 0, evidence: null });
    expect(world.starts()).toEqual([0]);
    expect(world.outcomes()).toEqual([null, "reachable"]);
  });

  it("healthy: one start every 5s, measured start-to-start, even with latency", async () => {
    const world = new FakeWorld();

    world.behave = () => ({ result: OK, latencyMs: 700 });
    await boot(world);
    await world.advance(30_000);

    expect(world.starts()).toEqual([0, 5_000, 10_000, 15_000, 20_000, 25_000, 30_000]);
    expect(world.maxInFlight).toBe(1);
  });

  it("budget: exactly 720 starts in one visible healthy hour", async () => {
    const world = new FakeWorld();

    await boot(world);
    await world.advance(3_600_000 - 1);

    expect(world.started).toHaveLength(720);
    expect(world.minGap()).toBe(5_000);
  });

  it("does not start at all while hidden at start-up, and reports nothing", async () => {
    const world = new FakeWorld();

    world.visible = false;
    await boot(world);
    await world.advance(3_600_000);

    expect(world.started).toHaveLength(0);
    expect(world.reports).toHaveLength(0);
  });
});

describe("timeout, cancellation and single flight", () => {
  it("a hung check is ABORTED at 4s, reported as a failure, and the next waits for backoff", async () => {
    const world = new FakeWorld();

    world.behave = (i) => (i === 0 ? { hang: true } : { result: OK });
    await boot(world);
    await world.advance(LIVE_CHECK_TIMEOUT_MS - 1);

    expect(world.started[0].signal.aborted).toBe(false);
    expect(world.outcomes()).toEqual([null]);

    await world.advance(1);

    expect(world.started[0].signal.aborted).toBe(true);
    expect(world.outcomes()).toEqual([null, "unreachable"]);

    await world.advance(4_999);
    expect(world.started).toHaveLength(1);
    await world.advance(1);
    expect(world.starts()).toEqual([0, 9_000]);
  });

  it("a timeout while the browser reports offline is 'no network'", async () => {
    const world = new FakeWorld();

    world.onlineHint = false;
    world.behave = () => ({ hang: true });
    await boot(world);
    await world.advance(LIVE_CHECK_TIMEOUT_MS);

    expect(world.outcomes()).toEqual([null, "no_network"]);
  });

  it("an aborted request that is slow to settle blocks the next start until it actually settles", async () => {
    const world = new FakeWorld();

    // Aborted at 4s but only settles 20s later (e.g. stuck before fetch).
    world.behave = (i) => (i === 0 ? { hang: true, settleOnAbortAfterMs: 20_000 } : { result: OK });
    await boot(world);
    await world.advance(23_999);

    expect(world.started).toHaveLength(1);
    expect(world.inFlight).toBe(1);

    await world.advance(1);

    // Settled at 24s; the deferred 5s backoff (due at 9s) runs as soon as it is free.
    expect(world.starts()).toEqual([0, 24_000]);
    expect(world.maxInFlight).toBe(1);
  });

  it("the late answer of a timed-out check is ignored", async () => {
    const world = new FakeWorld();

    // Answers OK only after 6s: the 4s timeout has already reported a failure.
    world.behave = (i) => (i === 0 ? { result: OK, latencyMs: 6_000 } : { result: DOWN });
    await boot(world);
    await world.advance(6_000);

    expect(world.outcomes()).toEqual([null, "unreachable"]);
  });

  it("a check that throws synchronously is a transport failure, not a crash", async () => {
    const world = new FakeWorld();
    const host = world.host();

    startServerReachability(
      {
        ...host,
        check: () => {
          throw new Error("boom");
        },
      },
      { expectedDeviceId: DEVICE }
    );
    await world.advance(0);

    expect(world.outcomes()).toEqual([null, "unreachable"]);
  });
});

describe("failure backoff", () => {
  it("5s, 10s, 20s, then 30s; a success resets it", async () => {
    const world = new FakeWorld();

    world.behave = (i) => (i < 6 ? { result: DOWN } : { result: OK });
    await boot(world);
    await world.advance(200_000);

    const s = world.starts();

    expect(s.slice(0, 8)).toEqual([0, 5_000, 15_000, 35_000, 65_000, 95_000, 125_000, 130_000]);
    expect(world.outcomes().slice(1, 8)).toEqual([
      "unreachable",
      "unreachable",
      "unreachable",
      "unreachable",
      "unreachable",
      "unreachable",
      "reachable",
    ]);
  });

  it("after a success, the next failure starts the backoff again at 5s", async () => {
    const world = new FakeWorld();

    world.behave = (i) => (i < 4 ? { result: DOWN } : i === 4 ? { result: OK } : { result: DOWN });
    await boot(world);
    await world.advance(90_000);

    // 4 failures (0, 5, 15, 35s), success at 65s, failure at 70s, then 5s -> 75s, 10s -> 85s.
    expect(world.starts().slice(0, 8)).toEqual([0, 5_000, 15_000, 35_000, 65_000, 70_000, 75_000, 85_000]);
  });

  it("server errors and device/sign-in problems back off the same way", async () => {
    const world = new FakeWorld();

    world.behave = () => ({ result: ERROR_500 });
    await boot(world);
    await world.advance(65_000);

    expect(world.starts()).toEqual([0, 5_000, 15_000, 35_000, 65_000]);
    expect(new Set(world.outcomes().slice(1))).toEqual(new Set(["server_error"]));
  });

  it("budget: a one-hour outage costs at most 1 + 3 + 3600/30 starts", async () => {
    const world = new FakeWorld();

    world.behave = () => ({ result: DOWN });
    await boot(world);
    await world.advance(3_600_000);

    expect(world.started.length).toBeLessThanOrEqual(1 + 3 + 120);
    expect(world.started.length).toBeGreaterThanOrEqual(118);
  });
});

describe("lifecycle: hidden, resume, pause, focus and event storms", () => {
  it("hiding aborts the in-flight check, ignores its answer, and stops checking", async () => {
    const world = new FakeWorld();

    world.behave = (i) => (i === 0 ? { result: OK } : { result: OK, latencyMs: 2_000 });
    await boot(world);
    await world.advance(5_500);
    expect(world.started).toHaveLength(2);

    world.visible = false;
    world.handlers!.visibility();
    await world.advance(0);

    expect(world.started[1].signal.aborted).toBe(true);

    await world.advance(3_600_000);

    expect(world.started).toHaveLength(2);
    expect(world.outcomes()).toEqual([null, "reachable"]);
  });

  it("resume reports 'no current evidence' and checks at once (spacing permitting)", async () => {
    const world = new FakeWorld();

    await boot(world);
    world.visible = false;
    world.handlers!.visibility();
    await world.advance(60_000);

    world.visible = true;
    world.handlers!.visibility();
    await world.advance(0);

    expect(world.reports.at(-2)).toEqual({ t: 60_000, evidence: null });
    expect(world.starts()).toEqual([0, 60_000]);
  });

  it("a quick hide/show inside 5s cannot beat the spacing", async () => {
    const world = new FakeWorld();

    await boot(world);
    await world.advance(1_000);
    world.visible = false;
    world.handlers!.visibility();
    world.visible = true;
    world.handlers!.visibility();
    await world.advance(10_000);

    expect(world.starts()).toEqual([0, 5_000, 10_000]);
  });

  it("focus while already visible adds no request (it is not a resume)", async () => {
    const world = new FakeWorld();

    world.behave = (i) => (i === 0 ? { result: DOWN } : { result: OK });
    await boot(world);

    for (let i = 0; i < 50; i += 1) world.handlers!.visibility();

    await world.advance(4_999);

    expect(world.started).toHaveLength(1);
  });

  it("focus storms cannot cut a long failure backoff short", async () => {
    const world = new FakeWorld();

    world.behave = () => ({ result: DOWN });
    await boot(world);
    await world.advance(16_000);
    // Failures at 0, 5s, 15s: the next attempt is due 20s after the third, at 35s.
    expect(world.starts()).toEqual([0, 5_000, 15_000]);

    for (let i = 0; i < 200; i += 1) {
      world.handlers!.visibility();
      await world.advance(90);
    }

    await world.advance(35_000 - 1 - world.t);
    expect(world.starts()).toEqual([0, 5_000, 15_000]);
    await world.advance(1);
    expect(world.starts()).toEqual([0, 5_000, 15_000, 35_000]);
  });

  it("an event storm (1,000 online/focus/visibility events in 2s) costs at most one extra start", async () => {
    const world = new FakeWorld();

    await boot(world);
    await world.advance(100);

    for (let i = 0; i < 1_000; i += 1) {
      world.handlers![(["online", "visibility"] as const)[i % 2]]();
      if (i % 100 === 0) await world.advance(200);
    }

    await world.advance(5_000 - world.t);

    expect(world.starts()).toEqual([0, 5_000]);
    expect(world.maxInFlight).toBe(1);
  });

  it("setPaused behaves like hidden/visible", async () => {
    const world = new FakeWorld();
    const control = await boot(world);

    control.setPaused(true);
    await world.advance(120_000);
    expect(world.started).toHaveLength(1);

    control.setPaused(false);
    await world.advance(0);

    expect(world.starts()).toEqual([0, 120_000]);
    expect(world.reports.at(-2)?.evidence).toBeNull();
  });
});

describe("network events", () => {
  it("offline: reported at once, in-flight aborted, its late success ignored, next probe after 30s", async () => {
    const world = new FakeWorld();

    world.behave = (i) => (i === 0 ? { result: OK } : { result: OK, latencyMs: 3_000 });
    await boot(world);
    await world.advance(5_500);

    world.onlineHint = false;
    world.handlers!.offline();
    await world.advance(10_000);

    expect(world.started[1].signal.aborted).toBe(true);
    expect(world.outcomes()).toEqual([null, "reachable", "no_network"]);
    expect(world.reports.at(-1)?.t).toBe(5_500);

    await world.advance(20_000);
    expect(world.starts()).toEqual([0, 5_000, 35_500]);
  });

  it("online after offline: an immediate check (spacing permitting), backoff reset", async () => {
    const world = new FakeWorld();

    await boot(world);
    await world.advance(2_000);
    world.onlineHint = false;
    world.handlers!.offline();
    await world.advance(10_000);

    world.onlineHint = true;
    world.handlers!.online();
    await world.advance(0);

    expect(world.starts()).toEqual([0, 12_000]);
    expect(world.outcomes().at(-1)).toBe("reachable");
  });

  it("a result that started before an offline event can never overwrite it", async () => {
    const world = new FakeWorld();

    world.behave = () => ({ result: OK, latencyMs: 1_000 });
    await boot(world);
    await world.advance(500);
    world.onlineHint = false;
    world.handlers!.offline();
    await world.advance(2_000);

    expect(world.outcomes()).toEqual([null, "no_network"]);
  });
});

describe("late results from a check that ignores its abort signal", () => {
  it("after an offline event: its late success is discarded", async () => {
    const world = new FakeWorld();

    world.behave = () => ({ result: OK, latencyMs: 2_000, ignoreAbort: true });
    await boot(world);
    await world.advance(2_000);
    await world.advance(3_500);
    world.onlineHint = false;
    world.handlers!.offline();
    await world.advance(3_000);

    expect(world.outcomes()).toEqual([null, "reachable", "no_network"]);
  });

  it("after a hide: its late success is discarded and nothing reports while hidden", async () => {
    const world = new FakeWorld();

    world.behave = () => ({ result: OK, latencyMs: 2_000, ignoreAbort: true });
    await boot(world);
    await world.advance(1_000);
    world.visible = false;
    world.handlers!.visibility();
    await world.advance(60_000);

    expect(world.outcomes()).toEqual([null]);
  });

  it("a hide during a hung request: that request's own 4s timeout does not report", async () => {
    const world = new FakeWorld();

    // Hangs; once aborted it takes 20s to settle, so its timeout timer is still armed.
    world.behave = () => ({ hang: true, settleOnAbortAfterMs: 20_000 });
    await boot(world);
    await world.advance(1_000);
    world.visible = false;
    world.handlers!.visibility();
    await world.advance(60_000);

    expect(world.outcomes()).toEqual([null]);
  });

  it("after stop(): nothing reports", async () => {
    const world = new FakeWorld();

    world.behave = () => ({ result: OK, latencyMs: 2_000, ignoreAbort: true });
    const control = await boot(world);

    await world.advance(1_000);
    control.stop();
    await world.advance(60_000);

    expect(world.outcomes()).toEqual([null]);
  });

  it("after pause then resume: the old answer cannot masquerade as the new check", async () => {
    const world = new FakeWorld();

    world.behave = (i) =>
      i === 0 ? { result: OK, latencyMs: 3_000, ignoreAbort: true } : { result: DOWN, latencyMs: 100 };
    const control = await boot(world);

    await world.advance(1_000);
    control.setPaused(true);
    control.setPaused(false);
    await world.advance(10_000);

    // The first check's OK lands at 3s, after the resume: it must not report.
    expect(world.outcomes()).toEqual([null, null, "unreachable", "unreachable"]);
  });
});

describe("stop and pairing changes", () => {
  it("stop() aborts, clears timers, unsubscribes, and nothing reports afterwards", async () => {
    const world = new FakeWorld();

    world.behave = () => ({ result: OK, latencyMs: 2_000 });
    const control = await boot(world);

    control.stop();
    await world.advance(3_600_000);

    expect(world.started).toHaveLength(1);
    expect(world.started[0].signal.aborted).toBe(true);
    expect(world.unsubscribed).toBe(1);
    expect(world.outcomes()).toEqual([null]);

    control.stop();
    control.setPaused(false);
    expect(world.unsubscribed).toBe(1);
  });

  it("a response for a different device is a device problem, never Online", async () => {
    const world = new FakeWorld();

    await boot(world, "d0000000-0000-4000-8000-0000000000ff");

    expect(world.outcomes()).toEqual([null, "device_problem"]);
  });
});

describe("request budget across mixed triggers", () => {
  it("start-up, failures, recoveries, hides, resumes, focus and network events: every gap >= 5s", async () => {
    const world = new FakeWorld();
    let rng = 7;
    const random = () => {
      rng = (rng * 1_103_515_245 + 12_345) % 2_147_483_648;
      return rng / 2_147_483_648;
    };

    world.behave = () => {
      const r = random();
      if (r < 0.15) return { hang: true, settleOnAbortAfterMs: Math.floor(random() * 8_000) };
      if (r < 0.35) return { result: DOWN, latencyMs: Math.floor(random() * 3_000) };
      if (r < 0.4) return { result: ERROR_500 };
      return { result: OK, latencyMs: Math.floor(random() * 1_500) };
    };
    await boot(world);

    for (let step = 0; step < 3_000; step += 1) {
      const r = random();

      if (r < 0.05) {
        world.visible = !world.visible;
        world.handlers!.visibility();
      } else if (r < 0.1) {
        world.handlers!.visibility();
      } else if (r < 0.13) {
        world.onlineHint = false;
        world.handlers!.offline();
      } else if (r < 0.18) {
        world.onlineHint = true;
        world.handlers!.online();
      }

      await world.advance(Math.floor(random() * 2_400));
    }

    const hours = world.t / 3_600_000;

    expect(world.maxInFlight).toBe(1);
    expect(world.minGap()).toBeGreaterThanOrEqual(LIVE_CHECK_MIN_SPACING_MS);
    expect(world.started.length).toBeLessThanOrEqual(Math.floor(world.t / 5_000) + 1);
    expect(hours).toBeGreaterThan(0.9);
  });
});
