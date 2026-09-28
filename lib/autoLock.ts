/**
 * v1.3 CP4 — the till locks itself after ten minutes with nobody at it.
 *
 * WHAT THIS IS FOR. A cashier walks away mid-shift. The POS stays signed in,
 * and anyone who picks it up is that cashier as far as the register is
 * concerned: their name on the sales, their session on the money. Ring Out
 * fixes this only when somebody remembers to press it, which is exactly the
 * case that fails. So the till stops trusting an operator it has not heard
 * from.
 *
 * THE DEADLINE IS THE STATE; THE TIMER IS A CONVENIENCE. Correctness rests on
 * an absolute instant, and `setTimeout` is only how the loop wakes up near it.
 * That distinction is the whole design, because a JavaScript timer is not a
 * clock: a backgrounded tab has its timers throttled, and a sleeping machine
 * suspends them outright. A till asleep for an hour must lock the moment it
 * wakes, not an hour later when a stale timer finally fires — so every resume
 * compares the wall clock against the deadline before anything else.
 *
 * HIDDEN TIME COUNTS. Being backgrounded is not activity; it is the most
 * likely thing to be happening while a till is unattended. Neither
 * `visibilitychange` nor `focus` may extend the deadline, and coming back
 * early continues the REMAINING time rather than granting a fresh ten minutes.
 *
 * ONLY A PERSON RESETS IT. The deadline answers "when did a human last touch
 * this till", so nothing the app does to itself counts: not a queue drain, not
 * a reconnect probe, not a config refresh, not a sale's own response, not a
 * render. `isTrusted` is what separates a finger from a script, and it is
 * required rather than assumed.
 *
 * IT DECIDES NOTHING ABOUT AUTHORITY. This module owns one question — has the
 * deadline passed — and calls back when it has. Capturing the session id,
 * clearing local authority, locking the POS and terminating the server session
 * all belong to the shared lock path in DeviceApp, which Ring Out already uses
 * and which CP3.1 made expectation-bound.
 */

/**
 * Ten minutes, fixed for v1.3.
 *
 * Not configurable, and deliberately not a setting: a till with a "Never"
 * option is a till that will be set to Never. If a future checkpoint makes it
 * per-business, the value arrives here and every caller keeps working.
 */
export const AUTO_LOCK_TIMEOUT_MS = 600_000;

/** What the operator is told when the till locked itself. */
export const AUTO_LOCK_MESSAGE = "Locked after 10 minutes of inactivity.";

/**
 * The events that count as a human being present.
 *
 * `pointerdown` covers mouse, touch and pen in one event, on every shell.
 * `keydown` covers typing — and, incidentally, a future keyboard-wedge
 * scanner, which will flow through this seam without CP4 knowing anything
 * about barcodes. `wheel` covers deliberate scrolling.
 *
 * `mousemove` is NOT here and must not be added: a cat, a delivery van's
 * vibration, or a cursor resting under a shop fan would hold the till open
 * indefinitely. Neither is `focus` or `visibilitychange` — a window coming
 * forward is not a person, and treating it as one would let a background tab
 * refresh the deadline forever.
 */
export const AUTO_LOCK_ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel"] as const;

export type AutoLockActivityEvent = (typeof AUTO_LOCK_ACTIVITY_EVENTS)[number];

/** The shape this module needs from an event. Not the DOM's full Event. */
export type ObservedActivity = { type: string; isTrusted: boolean };

/**
 * Whether an observed event may push the deadline out.
 *
 * BOTH CONDITIONS, ALWAYS. The type has to be one a person produces, AND the
 * event has to be real. `dispatchEvent` and `element.click()` produce
 * `isTrusted: false`, so a script — or a well-meaning bit of the app poking
 * the UI — cannot hold a till open on an empty counter.
 */
export function isTrustedActivity(event: ObservedActivity): boolean {
  if (event.isTrusted !== true) {
    return false;
  }

  return (AUTO_LOCK_ACTIVITY_EVENTS as readonly string[]).includes(event.type);
}

/** The instant a till last touched at `activityMs` stops being trusted. */
export function autoLockDeadlineFrom(activityMs: number): number {
  return activityMs + AUTO_LOCK_TIMEOUT_MS;
}

/**
 * How long is left, never negative.
 *
 * Zero means expired, which is why the caller compares with `<= 0` rather than
 * trusting a timer that may have been suspended past its own firing time.
 */
export function autoLockRemainingMs(deadlineMs: number, nowMs: number): number {
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(nowMs)) {
    return 0;
  }

  return Math.max(0, deadlineMs - nowMs);
}

/** Expired the instant the deadline is reached, not a millisecond after. */
export function hasAutoLockExpired(deadlineMs: number, nowMs: number): boolean {
  return autoLockRemainingMs(deadlineMs, nowMs) <= 0;
}

/** Whatever the host's timer function returns. Never inspected, only cleared. */
export type AutoLockTimer = unknown;

/**
 * Everything the loop needs from its host, injected so the policy is testable
 * with fake timers and without a DOM.
 *
 * `onActivity` and `onResume` each subscribe and return their own teardown.
 * They are separate because they mean opposite things: activity EXTENDS the
 * deadline, resume only CHECKS it.
 */
export type AutoLockHost = {
  now: () => number;
  setTimer: (run: () => void, delayMs: number) => AutoLockTimer;
  clearTimer: (timer: AutoLockTimer) => void;
  onActivity: (handler: (event: ObservedActivity) => void) => () => void;
  onResume: (handler: () => void) => () => void;
};

/**
 * Runs one authority episode's inactivity deadline until the returned stop is
 * called, or until it expires.
 *
 * `onExpire` fires AT MOST ONCE. The loop stops itself first, so a resume that
 * arrives in the same tick as the timer cannot produce a second lock — and,
 * with the shared single-flight in DeviceApp, cannot produce a second server
 * termination either.
 *
 * The caller mounts this per employee session and tears it down when authority
 * ends, so "a new login gets a fresh ten minutes" needs no special case: it is
 * simply a new episode.
 */
export function startAutoLock(host: AutoLockHost, onExpire: () => void): () => void {
  let deadlineMs = autoLockDeadlineFrom(host.now());
  let timer: AutoLockTimer = null;
  let finished = false;

  const clearPending = (): void => {
    if (timer !== null) {
      host.clearTimer(timer);
      timer = null;
    }
  };

  function schedule(): void {
    clearPending();

    if (finished) {
      return;
    }

    // Only ever ONE scheduled expiry per episode: the clear above is what
    // keeps a burst of activity from stacking timers.
    timer = host.setTimer(wake, autoLockRemainingMs(deadlineMs, host.now()));
  }

  /** Ends the episode. Idempotent, because two wake sources can coincide. */
  function expire(): void {
    if (finished) {
      return;
    }

    finished = true;
    clearPending();
    onExpire();
  }

  function wake(): void {
    timer = null;

    if (finished) {
      return;
    }

    // THE CLOCK DECIDES, NOT THE TIMER. A throttled or suspended timer can
    // fire early or late; either way the answer is the same comparison.
    if (hasAutoLockExpired(deadlineMs, host.now())) {
      expire();
      return;
    }

    schedule();
  }

  const stopActivity = host.onActivity((event) => {
    if (finished || !isTrustedActivity(event)) {
      return;
    }

    deadlineMs = autoLockDeadlineFrom(host.now());
    schedule();
  });

  // Resume CHECKS, it never extends. Synchronous on purpose: an expired till
  // must lose its authority before the operator's next interaction can rely
  // on it.
  const stopResume = host.onResume(() => {
    if (finished) {
      return;
    }

    if (hasAutoLockExpired(deadlineMs, host.now())) {
      expire();
      return;
    }

    // Not expired: continue the REMAINING time, not a fresh ten minutes.
    schedule();
  });

  schedule();

  return () => {
    finished = true;
    clearPending();
    stopActivity();
    stopResume();
  };
}
