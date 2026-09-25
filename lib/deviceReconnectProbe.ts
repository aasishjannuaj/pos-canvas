/**
 * v1.3 CP2e follow-up — the automatic reconnect probe schedule.
 *
 * THE DEFECT THIS CLOSES. A till that lost its backend kept believing it was
 * offline forever whenever the link itself never dropped. The reconnect path
 * (returnOnlineFromReconnect) was already correct and already authoritative;
 * its ONLY trigger was the browser's `online` event, and that event never
 * fires when the NIC stayed up and only the backend was unreachable — a
 * captive portal, an ISP outage, a backend that was down. navigator.onLine
 * reported true the entire time, so nothing ever asked the server again. The
 * queue drained only when a cashier pressed Sync now, and a changed employee
 * POS-session was never noticed.
 *
 * WHY A SCHEDULE AND NOT AN INTERVAL. The first attempt is deliberately soon
 * (5s), because the overwhelmingly common outage is seconds long and a cashier
 * is standing there. Each failure then waits longer, settling at a minute, so
 * a till parked in a dead zone for an hour makes ~60 attempts rather than
 * ~720. The curve is the whole policy, which is why it lives here as data a
 * test can assert rather than as arithmetic buried in an effect.
 *
 * THIS MODULE DECIDES NOTHING ABOUT AUTHORITY. It answers one question — how
 * long until the next attempt — and holds no clock, no timer and no state.
 * Whether the backend is reachable, whether the device is still paired,
 * whether the employee POS-session survived and which business day it is are
 * all the existing reconnect path's questions, and it keeps them.
 */

/**
 * Consecutive-failure backoff, in milliseconds.
 *
 * Locked by Control Room for v1.3: 5s, 10s, 20s, 30s, then 60s forever. No
 * jitter — a single till is not a thundering herd, and jitter would make the
 * schedule untestable without buying anything back at this scale.
 */
export const RECONNECT_PROBE_BACKOFF_MS: readonly number[] = [
  5_000, 10_000, 20_000, 30_000, 60_000,
];

/** The interval the curve settles at, and never exceeds. */
export const RECONNECT_PROBE_MAX_MS = 60_000;

/**
 * How long to wait before the probe numbered `consecutiveFailures`.
 *
 * `0` is the first attempt of an offline episode, so a fresh episode always
 * waits 5s and never inherits the previous episode's position on the curve.
 * Out-of-range and non-finite inputs clamp rather than throw: a caller that
 * has lost count must still get a sane delay, because the alternative is a
 * till that stops probing entirely.
 */
export function nextReconnectProbeDelayMs(consecutiveFailures: number): number {
  if (!Number.isFinite(consecutiveFailures)) {
    return RECONNECT_PROBE_MAX_MS;
  }

  const index = Math.min(
    Math.max(Math.trunc(consecutiveFailures), 0),
    RECONNECT_PROBE_BACKOFF_MS.length - 1
  );

  return RECONNECT_PROBE_BACKOFF_MS[index];
}

/** Whatever the host's timer function returns. Never inspected, only cleared. */
export type ReconnectProbeTimer = unknown;

/**
 * Everything the probe loop needs from its host, injected so the loop itself
 * is testable with fake timers and without a DOM.
 *
 * `onForeground` subscribes to the host's lifecycle signals and returns its own
 * teardown. DeviceApp wires BOTH `visibilitychange` and `focus` through this
 * one hook precisely so the loop cannot tell them apart — they are the same
 * event as far as the policy is concerned, and collapsing them here is what
 * stops a single foreground from producing two backend attempts.
 */
export type ReconnectProbeHost = {
  isVisible: () => boolean;
  onForeground: (handler: () => void) => () => void;
  setTimer: (run: () => void, delayMs: number) => ReconnectProbeTimer;
  clearTimer: (timer: ReconnectProbeTimer) => void;
};

/**
 * Runs the automatic reconnect probe loop until the returned stop is called.
 *
 * `attempt` is the EXISTING reconnect path, passed in whole. This loop decides
 * only WHEN to call it — never what reachability means, never whether the
 * employee is still authorized, never whether to unlock anything. A caller
 * stops the loop when the till leaves offline mode, which is what makes a
 * successful attempt terminal: nothing here inspects the result.
 *
 * WHY FAILURE IS INFERRED RATHER THAN REPORTED. `attempt` resolves either way —
 * the reconnect path deliberately swallows a transport failure and changes
 * nothing. So the loop treats "still running after the attempt" as failure and
 * advances the backoff. A successful attempt tears the loop down before that
 * matters, and the worst case of getting it wrong is one extra probe.
 */
export function startReconnectProbe(
  host: ReconnectProbeHost,
  attempt: () => Promise<void>
): () => void {
  let consecutiveFailures = 0;
  let timer: ReconnectProbeTimer = null;
  let inFlight = false;
  let cancelled = false;

  const clearPending = (): void => {
    if (timer !== null) {
      host.clearTimer(timer);
      timer = null;
    }
  };

  function schedule(): void {
    clearPending();

    // A hidden till does not probe. Returning to the foreground restarts it.
    if (cancelled || !host.isVisible()) {
      return;
    }

    timer = host.setTimer(probe, nextReconnectProbeDelayMs(consecutiveFailures));
  }

  function probe(): void {
    timer = null;

    // inFlight is the single-flight: two lifecycle signals for one foreground
    // must not become two concurrent backend attempts.
    if (cancelled || inFlight) {
      return;
    }

    inFlight = true;

    void (async () => {
      try {
        await attempt();
      } finally {
        inFlight = false;
      }

      if (!cancelled) {
        consecutiveFailures += 1;
        schedule();
      }
    })();
  }

  const unsubscribe = host.onForeground(() => {
    if (!host.isVisible()) {
      clearPending();
      return;
    }

    clearPending();
    probe();
  });

  schedule();

  return () => {
    cancelled = true;
    clearPending();
    unsubscribe();
  };
}
