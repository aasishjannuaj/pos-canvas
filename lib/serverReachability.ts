// IND-1 — the display-only server reachability loop.
//
// WHAT IT IS ALLOWED TO DO: decide WHEN to run one read (get_device_pairing_state,
// via the injected `check`), cancel it, classify it, and report the result to
// the indicator. That is all.
//
// WHAT IT MUST NEVER DO: submit a sale, run the sync engine, retry a queued
// sale, enter or leave offline mode, touch checkout authority, pairing or any
// employee/register session. It has no import that could; the guard test
// (lib/liveStatus.guards.test.ts) holds that line.
//
// THE RULES, all enforced here so a host cannot get them wrong:
//   - at most ONE underlying request in flight. A timed-out request is aborted
//     at once, but the next one waits until the aborted one has actually settled;
//   - every start is at least LIVE_CHECK_MIN_SPACING_MS after the previous start,
//     whatever triggered it — so no event storm can exceed one request per 5s;
//   - healthy: next start 5s after the previous start;
//   - failing: 5s, 10s, 20s, then 30s after the failure;
//   - hidden or paused: no checks; the in-flight check is cancelled;
//   - resume (hidden -> visible), the `online` event and start-up ask for an
//     immediate check, subject to the spacing; they are coalesced into one;
//   - `offline` event: reported at once, the in-flight check cancelled, and
//     probing drops to the 30s backoff (the browser's hint can be wrong);
//   - a result that arrives after a newer offline event, a hide, a pause, a
//     restart or stop() is discarded — it can never overwrite newer evidence.
import {
  LIVE_CHECK_INTERVAL_MS,
  LIVE_CHECK_MIN_SPACING_MS,
  LIVE_CHECK_TIMEOUT_MS,
  LIVE_CHECK_FAILURE_BACKOFF_MS,
  classifyReachability,
  nextFailureDelayMs,
} from "@/lib/liveStatus";
import type { LiveEvidence, ReachabilityProbeResult } from "@/lib/liveStatus";

/** Whatever the host's timer function returns. Never inspected, only cleared. */
export type ReachabilityTimer = unknown;

export type ReachabilityHost = {
  now: () => number;
  isVisible: () => boolean;
  readOnlineHint: () => boolean | null;
  setTimer: (run: () => void, delayMs: number) => ReachabilityTimer;
  clearTimer: (timer: ReachabilityTimer) => void;
  /**
   * Subscribes to the lifecycle signals and returns the teardown. `visibility`
   * fires for visibilitychange AND focus — the loop reads isVisible() itself, so
   * the two are the same event to it.
   */
  subscribe: (handlers: {
    visibility: () => void;
    online: () => void;
    offline: () => void;
  }) => () => void;
  /** Runs ONE read. Must honour `signal` (abort the underlying request). */
  check: (signal: AbortSignal) => Promise<ReachabilityProbeResult>;
  /**
   * New evidence, or null to say "previous evidence is no longer current"
   * (resume, pause). Never called after stop().
   */
  report: (evidence: LiveEvidence | null) => void;
};

export type ReachabilityControl = {
  /** Pause (true) or resume (false), e.g. while an overlay covers the header. */
  setPaused: (paused: boolean) => void;
  stop: () => void;
};

export function startServerReachability(
  host: ReachabilityHost,
  options: { expectedDeviceId: string }
): ReachabilityControl {
  let stopped = false;
  let paused = false;
  let wasActive = false;
  let timer: ReachabilityTimer = null;
  let timerDueAt: number | null = null;
  /** Bumped by anything that makes an in-flight result stale. */
  let generation = 0;
  /** The underlying request has not settled yet (even if aborted or timed out). */
  let underlyingPending = false;
  let controller: AbortController | null = null;
  let lastStartAt: number | null = null;
  let consecutiveFailures = 0;
  /**
   * The earliest start requested while a request was still settling. Kept as a
   * time, not a flag, so a deferred request keeps its own backoff.
   */
  let deferredAt: number | null = null;

  const isActive = (): boolean => !stopped && !paused && host.isVisible();

  function clearTimer(): void {
    if (timer !== null) {
      host.clearTimer(timer);
      timer = null;
      timerDueAt = null;
    }
  }

  function cancelInFlight(): void {
    generation += 1;

    if (controller !== null) {
      controller.abort();
      controller = null;
    }
  }

  /** Schedules a start no earlier than `earliestAt`, keeping an earlier timer if one exists. */
  function scheduleAt(earliestAt: number): void {
    if (!isActive()) {
      return;
    }

    if (underlyingPending) {
      deferredAt = deferredAt === null ? earliestAt : Math.min(deferredAt, earliestAt);
      return;
    }

    const spacingAt = lastStartAt === null ? earliestAt : lastStartAt + LIVE_CHECK_MIN_SPACING_MS;
    const dueAt = Math.max(earliestAt, spacingAt);

    if (timer !== null && timerDueAt !== null && timerDueAt <= dueAt) {
      return;
    }

    clearTimer();
    timerDueAt = dueAt;
    timer = host.setTimer(run, Math.max(0, dueAt - host.now()));
  }

  function run(): void {
    timer = null;
    timerDueAt = null;

    if (!isActive() || underlyingPending) {
      return;
    }

    const myGeneration = generation;
    const ownController = new AbortController();
    let settled = false;
    let timedOut = false;

    controller = ownController;
    underlyingPending = true;
    lastStartAt = host.now();

    const timeout = host.setTimer(() => {
      if (settled) {
        return;
      }

      timedOut = true;
      ownController.abort();
      // Reported now, not when the aborted request finally settles: the timeout
      // IS the evidence. The underlying promise is still awaited below before
      // another request may start.
      finish(myGeneration, { type: "timeout" });
    }, LIVE_CHECK_TIMEOUT_MS);

    let pending: Promise<ReachabilityProbeResult>;

    try {
      pending = host.check(ownController.signal);
    } catch {
      pending = Promise.resolve({ type: "transport" });
    }

    void pending
      .catch((): ReachabilityProbeResult => ({ type: "transport" }))
      .then((result) => {
        settled = true;
        host.clearTimer(timeout);

        if (controller === ownController) {
          controller = null;
        }

        underlyingPending = false;

        if (!timedOut) {
          finish(myGeneration, ownController.signal.aborted ? { type: "aborted" } : result);
        }

        if (deferredAt !== null) {
          const next = deferredAt;

          deferredAt = null;
          scheduleAt(next);
        }
      });
  }

  /** Applies one result if it is still current, then schedules the next start. */
  function finish(myGeneration: number, result: ReachabilityProbeResult): void {
    if (stopped || myGeneration !== generation) {
      return;
    }

    const outcome = classifyReachability(result, {
      onlineHint: host.readOnlineHint(),
      expectedDeviceId: options.expectedDeviceId,
    });

    if (outcome === null) {
      return;
    }

    const at = host.now();

    host.report({ outcome, at });

    if (outcome === "reachable") {
      consecutiveFailures = 0;
      scheduleAt((lastStartAt ?? at) + LIVE_CHECK_INTERVAL_MS);
    } else {
      consecutiveFailures += 1;
      scheduleAt(at + nextFailureDelayMs(consecutiveFailures));
    }
  }

  /** Called on every lifecycle change: becomes active, or stops being active. */
  function reconcile(): void {
    const active = isActive();

    if (active && !wasActive) {
      // Resume or start-up: whatever we knew before is not current.
      wasActive = true;
      host.report(null);
      scheduleAt(host.now());
    } else if (!active && wasActive) {
      wasActive = false;
      clearTimer();
      cancelInFlight();
      deferredAt = null;
    }
  }

  const unsubscribe = host.subscribe({
    visibility: () => {
      if (!stopped) {
        reconcile();
      }
    },
    online: () => {
      if (stopped) {
        return;
      }

      consecutiveFailures = 0;
      scheduleAt(host.now());
    },
    offline: () => {
      if (stopped) {
        return;
      }

      cancelInFlight();
      consecutiveFailures = Math.max(consecutiveFailures, LIVE_CHECK_FAILURE_BACKOFF_MS.length);

      if (isActive()) {
        host.report({ outcome: "no_network", at: host.now() });
        clearTimer();
        scheduleAt(host.now() + nextFailureDelayMs(consecutiveFailures));
      }
    },
  });

  reconcile();

  return {
    setPaused(next: boolean) {
      if (stopped || next === paused) {
        return;
      }

      paused = next;
      reconcile();
    },
    stop() {
      if (stopped) {
        return;
      }

      stopped = true;
      clearTimer();
      cancelInFlight();
      unsubscribe();
    },
  };
}
