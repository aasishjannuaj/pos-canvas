// Batch B — cross-tab coordination for the sale queue, over the Web Locks API.
//
// WHY. Two tabs (or windows) of one origin share one IndexedDB sale queue and
// one uncertain-sale marker, but every in-memory guard — the strict-recovery
// counter in lib/recoveryCheckoutCoordinator.ts, the startup latch in
// lib/saleSyncEngine.ts — exists once PER TAB. Batch A demonstrated two races
// with the real modules (REPORT §BA.5, evidence/multitab/FINDINGS.md):
//
//   M1  tab B's checkout gate read "clear", tab A then filed a protected
//       recovery conflict, and tab B's synchronous check still said
//       "unchanged" — tab B would have dispatched a new sale.
//   M2  tab B's startup recovery returned tab A's IN-FLIGHT strict row to
//       `pending`, so tab B's gate read "clear" mid-recovery.
//
// navigator.locks is shared by every tab of an origin and released by the
// browser when the holding tab dies, so it can carry what the in-memory
// counters cannot:
//
//   GATE_LOCK            held by a checkout from BEFORE its durable read until
//                        the synchronous continuation after it has run (its
//                        final check and the start of its action), and by the
//                        engine around a STRICT row's claim. Neither side holds
//                        it across a network call.
//   submissionLock(id)   held by whichever tab is submitting that queue row,
//                        from before its claim until after its final write.
//                        Startup recovery never touches a `syncing` row whose
//                        submission lock is held: a live tab owns it.
//
// UNAVAILABLE LOCKS FAIL CLOSED. Every shipped runtime is a secure context with
// navigator.locks (the web app on https, Capacitor on https://localhost, the
// Windows shell's privileged app://poscanvas scheme), so a missing LockManager
// is an unexpected platform. There the callers refuse what they cannot
// coordinate: checkout refuses while any unsettled strict row exists, and
// startup recovery leaves strict `syncing` rows alone (see their call sites).
//
// A lock is NEVER permission on its own. Permission still requires the fresh
// durable read; the locks only make the read-then-act windows exclusive.

export const GATE_LOCK = "pos-canvas:recovery-gate";

export function submissionLock(queueRecordId: string): string {
  return `pos-canvas:submission:${queueRecordId}`;
}

/** How long a caller waits for a lock another tab holds before giving up. */
export const LOCK_WAIT_MS = 5_000;

/** The subset of the Web Locks LockManager this module uses. */
export type LockManagerLike = {
  request(
    name: string,
    options: { mode?: "exclusive" | "shared"; ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<unknown> | unknown
  ): Promise<unknown>;
  query(): Promise<{ held?: { name?: string }[]; pending?: { name?: string }[] }>;
};

let override: LockManagerLike | null | undefined;

/** The LockManager in use, or null when this runtime has none. */
export function lockManager(): LockManagerLike | null {
  if (override !== undefined) return override;

  const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;

  return nav && nav.locks && typeof nav.locks.request === "function" ? nav.locks : null;
}

/** Test seam: inject a LockManager, or null for "unavailable". undefined restores the real one. */
export function setLockManagerForTests(manager: LockManagerLike | null | undefined): void {
  override = manager;
}

export type HeldLock = {
  /** Idempotent. */
  release: () => void;
  /** False once released (or if the browser dropped the lock). */
  isHeld: () => boolean;
};

/**
 * Acquire `name` exclusively and keep it until release() — or until the tab
 * dies, when the browser releases it. Resolves null if the lock could not be
 * obtained within `waitMs` (or immediately, with `ifAvailable`), or if the
 * request failed. Never throws.
 */
export function acquireLock(
  manager: LockManagerLike,
  name: string,
  options: { waitMs?: number; ifAvailable?: boolean } = {}
): Promise<HeldLock | null> {
  return new Promise((resolve) => {
    let settled = false;
    let held = false;
    let releaseHold: () => void = () => undefined;
    const hold = new Promise<void>((r) => {
      releaseHold = r;
    });
    const controller = options.ifAvailable ? null : new AbortController();
    const timer =
      controller === null
        ? null
        : setTimeout(() => controller.abort(), options.waitMs ?? LOCK_WAIT_MS);

    const finish = (value: HeldLock | null) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(value);
    };

    const handle: HeldLock = {
      release: () => {
        held = false;
        releaseHold();
      },
      isHeld: () => held,
    };

    let request: Promise<unknown>;

    try {
      request = manager.request(
        name,
        options.ifAvailable
          ? { mode: "exclusive", ifAvailable: true }
          : { mode: "exclusive", signal: controller!.signal },
        async (lock) => {
          if (lock === null || settled) {
            // ifAvailable and taken — or we already gave up waiting.
            finish(null);
            return;
          }
          held = true;
          finish(handle);
          await hold;
          held = false;
        }
      );
    } catch {
      finish(null);
      return;
    }

    request.then(
      () => finish(null),
      () => {
        held = false;
        finish(null);
      }
    );
  });
}

/**
 * Is `name` currently held by any tab of this origin? null when it cannot be
 * determined (no LockManager, or the query failed) — callers treat null as
 * "possibly held".
 */
export async function isLockHeld(manager: LockManagerLike | null, name: string): Promise<boolean | null> {
  if (manager === null) return null;

  try {
    const snapshot = await manager.query();

    return (snapshot.held ?? []).some((lock) => lock.name === name);
  } catch {
    return null;
  }
}

/**
 * Release `lock` on the next macrotask — i.e. after every microtask already
 * queued has run. A caller that did `const x = await f()` where `f` acquired the
 * lock therefore runs its entire synchronous continuation (up to its next real
 * await) while the lock is still held.
 */
export function releaseAfterCurrentTurn(lock: HeldLock): void {
  setTimeout(lock.release, 0);
}
