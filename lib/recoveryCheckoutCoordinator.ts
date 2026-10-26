// G-1-CLIENT-1B — coordination between STRICT-RECOVERY SUBMISSION and a NEW
// checkout's final action (online dispatch or offline queue acceptance).
//
// THE GAP THIS CLOSES (demonstrated by G1-CLIENT-1A-TIMING): sync committed a
// strict-recovery conflict to IndexedDB, but checkout still trusted the cached
// "clear" recovery authority until DeviceApp's post-sync refresh ran, and a new
// online order was created in between.
//
// THE RULE, in two parts, applied at both final gates:
//
//   1. A FRESH DURABLE READ (readQueueRecoveryProtection) must say "clear": no
//      protected strict record, no strict record currently `syncing`, nothing
//      unreadable, and the read itself succeeded.
//   2. NO STRICT RECOVERY STARTED OR FINISHED DURING THAT READ. The sync engine
//      holds this counter around every strict submission — taken synchronously
//      BEFORE it claims the record, released in a `finally` AFTER its final
//      write has committed. Checkout marks the counter before its read and,
//      after the read, requires (synchronously, with no await before its
//      dispatch/save) that nothing is in flight and the counter did not move.
//
// So a recovery that starts — or files a conflict — between checkout's read and
// its action necessarily moves the counter, and checkout refuses. A recovery
// that starts AFTER the action began is the other valid ordering: that sale was
// authorized while no conflict existed and no strict submission was running.
//
// CHECKOUT HOLDS NOTHING, so there is nothing for a checkout to release on
// success, failure or cancellation. Only the engine holds the counter, and only
// inside a try/finally. The counter is in memory and starts at zero on every
// process start, so it can never GRANT permission: permission always requires a
// fresh durable read. A strict record a dead process left in `syncing` is
// refused by part 1 until startup recovery returns it to pending.
//
// BATCH B — ACROSS TABS. The counter is per tab, so two tabs of one origin did
// not see each other's strict submissions (Batch A, M1). Part 1 now also takes
// the cross-tab GATE lock (lib/tabLocks.ts) before the durable read and keeps it
// until the caller's synchronous continuation has run — its part-2 check and
// the start of its action — then releases it on the next macrotask. The engine
// claims a strict row only while holding the same lock. So another tab's strict
// claim lands either before this read (the read then sees `recovering`) or after
// this checkout's action began (the valid ordering above). CHECKOUT STILL HOLDS
// NOTHING IT MUST RELEASE: the release is scheduled here, on every path, and the
// browser drops the lock if the tab dies. Without a LockManager the read fails
// closed instead: any unsettled strict row refuses.
import { readQueueRecoveryProtection } from "@/lib/saleQueueSession";
import { GATE_LOCK, acquireLock, lockManager, releaseAfterCurrentTurn } from "@/lib/tabLocks";
import type { HeldLock } from "@/lib/tabLocks";

let inFlight = 0;
let epoch = 0;

/**
 * Held by the sync engine around ONE strict-recovery submission. Returns the
 * release, which is idempotent. Call before the record is claimed; release in a
 * finally after the final state write has committed.
 */
export function beginStrictRecoverySubmission(): () => void {
  inFlight += 1;
  epoch += 1;

  let released = false;

  return () => {
    if (released) return;

    released = true;
    inFlight -= 1;
    epoch += 1;
  };
}

/** True while a strict-recovery submission is running in this process. */
export function isStrictRecoveryInFlight(): boolean {
  return inFlight > 0;
}

export type RecoveryActivityMark = {
  readonly epoch: number;
  /** Batch B — the cross-tab gate held for this clearance; null when this runtime has no LockManager. */
  readonly gate?: HeldLock | null;
};

export type CheckoutRecoveryRefusal =
  | "recovery_conflict"
  | "recovery_in_progress"
  | "unreadable_recovery_record"
  | "read_failed";

export type CheckoutRecoveryClearance =
  | { ok: true; mark: RecoveryActivityMark }
  | { ok: false; reason: CheckoutRecoveryRefusal };

/**
 * Part 1 (async): the durable read, bracketed by the activity mark.
 *
 * The mark is taken BEFORE the read so that any strict submission beginning or
 * ending while the read is outstanding is visible to the final check.
 */
export async function readCheckoutRecoveryClearance(): Promise<CheckoutRecoveryClearance> {
  const markedEpoch = epoch;

  if (inFlight > 0) {
    return { ok: false, reason: "recovery_in_progress" };
  }

  const manager = lockManager();
  let gate: HeldLock | null = null;

  if (manager !== null) {
    gate = await acquireLock(manager, GATE_LOCK);

    // Another tab kept the gate past the wait: something is claiming or
    // checking out right now. Refuse rather than read without it.
    if (gate === null) return { ok: false, reason: "recovery_in_progress" };
  }

  try {
    const durable = await readQueueRecoveryProtection({ unsettledStrictBlocks: manager === null });

    switch (durable) {
      case "clear":
      // v1.3.4 owner decision: a set-aside conflict does not stop new sales.
      // It is preserved and never auto-submitted (see readQueueRecoveryProtection).
      case "isolated":
        return { ok: true, mark: { epoch: markedEpoch, gate } };
      case "recovering":
        return { ok: false, reason: "recovery_in_progress" };
      case "unreadable":
        return { ok: false, reason: "unreadable_recovery_record" };
      case "read_failed":
        return { ok: false, reason: "read_failed" };
    }

    return { ok: false, reason: "read_failed" }; // unreachable: the switch is exhaustive
  } catch {
    return { ok: false, reason: "read_failed" };
  } finally {
    if (gate !== null) releaseAfterCurrentTurn(gate);
  }
}

/**
 * Part 2 (sync): still clear at the instant of the action? Must be called with
 * NO await between it and the dispatch/save it authorizes.
 */
export function isRecoveryActivityUnchanged(mark: RecoveryActivityMark): boolean {
  // Batch B — and the cross-tab gate taken for this clearance is still held, so
  // no other tab can have claimed a strict row since the read. (A clearance
  // granted without a gate came from a fail-closed read on a runtime with no
  // LockManager.)
  const gateHeld = mark.gate === undefined || mark.gate === null || mark.gate.isHeld();

  return inFlight === 0 && epoch === mark.epoch && gateHeld;
}

/** The cashier-facing sentence for each refusal. */
export const CHECKOUT_RECOVERY_REFUSAL_MESSAGES: Readonly<Record<CheckoutRecoveryRefusal, string>> = {
  recovery_conflict:
    "An earlier sale on this till could not be recorded under the employee and register that rang it. It is kept on this till. Ask the account owner to review it before taking new sales.",
  recovery_in_progress:
    "An earlier sale is being sent to the server right now. The items are still in the cart — try again in a moment.",
  unreadable_recovery_record:
    "This device cannot confirm whether an earlier sale finished. Reconnect before selling.",
  read_failed: "This device cannot confirm whether an earlier sale finished. Reconnect before selling.",
};

/** Test seam: forget all activity. Never called by product code. */
export function resetRecoveryCoordinatorForTests(): void {
  inFlight = 0;
  epoch = 0;
}
