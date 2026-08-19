// Feature 24.5D — the drain loop.
//
// WHAT THIS DOES: takes queued sales that are due, submits them one at a time
// oldest-first, and moves each to its final state. It owns no persistence of
// its own — every read and write goes through the 24.5C queue API — and no
// classification of its own; lib/saleSyncClassifier.ts decides what a failure
// means. This file owns sequencing, and nothing else.
//
// WHAT IT DOES NOT DO: enqueue. Nothing here creates a sale, and offline
// checkout is still fenced in PosRuntime. 24.5D drains a queue that, today,
// only a test ever fills.
//
// SUBMISSION AND CLOCK ARE INJECTED so a test can model a lost response, a
// revoked device or a five-minute backoff without a network or a real timer.
// Production callers use the defaults and get the real adapter.
import {
  getQueueSummary,
  listDueSales,
  markAttempt,
  markSynced,
  recoverInterruptedSyncs,
  updateQueueState,
} from "@/lib/saleQueueSession";
import { parseIsoTime } from "@/lib/deviceOfflineCache";
import type { QueueSummary } from "@/lib/saleQueue";
import type { QueuedSale } from "@/lib/saleQueue";
import { classifySubmissionFailure, nextAttemptAtFrom } from "@/lib/saleSyncClassifier";
import { submitQueuedSale } from "@/lib/offlineSaleRpc";
import type { OfflineSaleSubmission } from "@/lib/offlineSaleRpc";

export type SyncDeps = {
  submit: (record: QueuedSale) => Promise<OfflineSaleSubmission>;
  now: () => number;
};

const defaultDeps: SyncDeps = {
  submit: submitQueuedSale,
  now: () => Date.now(),
};

export type SyncedOutcome = {
  queueRecordId: string;
  result: "synced" | "retry" | "needs_attention" | "permanent_failure" | "skipped";
  code: string | null;
  orderNumber: string | null;
};

export type SyncRunReport = {
  attempted: number;
  synced: number;
  retrying: number;
  needsAttention: number;
  permanentFailure: number;
  outcomes: SyncedOutcome[];
  summary: QueueSummary | null;
  /** ISO instant of the last sale this run recorded, if any. */
  lastSyncedAt: string | null;
};

const emptyReport = (): SyncRunReport => ({
  attempted: 0,
  synced: 0,
  retrying: 0,
  needsAttention: 0,
  permanentFailure: 0,
  outcomes: [],
  summary: null,
  lastSyncedAt: null,
});

// ---------------------------------------------------------------------------
// Single flight
// ---------------------------------------------------------------------------

export type SyncStatus = {
  running: boolean;
  summary: QueueSummary | null;
};

export type SaleSyncEngine = {
  /** Drains every due sale. A concurrent caller joins the run already going. */
  run: (deps?: Partial<SyncDeps>) => Promise<SyncRunReport>;
  isRunning: () => boolean;
  getStatus: () => Promise<SyncStatus>;
  /** Test seam: forget any in-flight run. Never called by product code. */
  reset: () => void;
};

/**
 * Creates an engine with its OWN single-flight state.
 *
 * WHY PER-INSTANCE RATHER THAN PER-MODULE. Two concurrent drains would both
 * read the same pending record, both try to claim it and both submit. The
 * idempotency key means the server still records one sale — but the client
 * would double-count attempts, race its own writes, and could mark a record
 * synced from one call while another is still retrying it.
 *
 * The first version of this held `activeRun` at module scope, which made the
 * guard accidentally global: two engines created for genuinely independent
 * reasons would have blocked each other purely because they imported the same
 * file. Scoping it to the instance keeps the protection exactly where the
 * requirement put it — per engine — and leaves the shared singleton below as an
 * ordinary caller of the same construct.
 *
 * TWO ENGINES DRAINING ONE QUEUE ARE STILL SAFE, and not by luck: claiming a
 * record is a `pending -> syncing` transition read from storage, so whichever
 * engine gets there second reads `syncing`, finds the transition illegal, and
 * skips. The queue is the arbiter; single-flight is the optimisation that stops
 * them competing in the first place.
 *
 * This is NOT a substitute for disabling a button; it is what makes disabling a
 * button unnecessary.
 */
export function createSaleSyncEngine(defaults: Partial<SyncDeps> = {}): SaleSyncEngine {
  let activeRun: Promise<SyncRunReport> | null = null;

  const run = (deps: Partial<SyncDeps> = {}): Promise<SyncRunReport> => {
    if (activeRun !== null) {
      return activeRun;
    }

    const resolved: SyncDeps = { ...defaultDeps, ...defaults, ...deps };

    activeRun = drain(resolved).finally(() => {
      activeRun = null;
    });

    return activeRun;
  };

  return {
    run,
    isRunning: () => activeRun !== null,
    reset: () => {
      activeRun = null;
    },
    getStatus: async () => {
      const summary = await getQueueSummary();

      return { running: activeRun !== null, summary: summary.ok ? summary.value : null };
    },
  };
}

/**
 * The engine the application uses.
 *
 * One per browsing context, because there is one IndexedDB queue per origin.
 * Everything below is a thin delegation, kept so callers that do not need to
 * own an engine do not have to construct one.
 */
const sharedEngine = createSaleSyncEngine();

export function resetSyncEngineForTests(): void {
  sharedEngine.reset();
}

export function isSyncRunning(): boolean {
  return sharedEngine.isRunning();
}

export function runSaleSync(deps: Partial<SyncDeps> = {}): Promise<SyncRunReport> {
  return sharedEngine.run(deps);
}

// ---------------------------------------------------------------------------
// The drain
// ---------------------------------------------------------------------------

async function drain(deps: SyncDeps): Promise<SyncRunReport> {
  const report = emptyReport();

  // NO RECOVERY HERE — and this is a correction, not an omission.
  //
  // An earlier version recovered stranded `syncing` records at the top of every
  // drain. That is wrong for any drain but the first: recovery cannot tell "a
  // dead process left this behind" from "another engine is submitting it right
  // now", so a second drain would un-claim work that was still in flight and
  // submit it again. A test caught exactly that.
  //
  // Reclaiming orphans is a STARTUP concern, so it lives on the startup
  // trigger. Within a drain, the only thing that may move a record out of
  // `pending` is the claim below.
  const due = await listDueSales(deps.now());

  if (!due.ok) {
    return report;
  }

  // FIFO, and STRICTLY SEQUENTIAL. Financial writes are not parallelised: a
  // burst of concurrent submissions buys nothing on a till with a handful of
  // sales and makes failure attribution much harder.
  for (const record of due.value) {
    const outcome = await syncOne(record, deps);

    report.attempted += 1;
    report.outcomes.push(outcome);

    if (outcome.result === "synced") {
      report.synced += 1;
      report.lastSyncedAt = new Date(deps.now()).toISOString();
    } else if (outcome.result === "retry") {
      report.retrying += 1;
    } else if (outcome.result === "needs_attention") {
      report.needsAttention += 1;
    } else if (outcome.result === "permanent_failure") {
      report.permanentFailure += 1;
    }

    // NOTHING BREAKS THE LOOP. A sale that needs attention, or has failed
    // permanently, or is backing off, must never hold up the sales behind it —
    // a malformed record from three days ago cannot be allowed to strand this
    // morning's takings.
  }

  const summary = await getQueueSummary();

  report.summary = summary.ok ? summary.value : null;

  return report;
}

async function syncOne(record: QueuedSale, deps: SyncDeps): Promise<SyncedOutcome> {
  const startedAt = new Date(deps.now()).toISOString();

  // pending -> syncing BEFORE the request leaves. If the process dies now, the
  // record is recoverable by exactly the rule that recovered it above.
  const claimed = await updateQueueState(record.queueRecordId, "syncing", startedAt);

  if (!claimed.ok) {
    // Someone else moved it, or it is unreadable. Either way this run does not
    // own it, and forcing the issue would risk a double submission.
    return {
      queueRecordId: record.queueRecordId,
      result: "skipped",
      code: claimed.reason,
      orderNumber: null,
    };
  }

  // The attempt is counted BEFORE the request, so an attempt that never returns
  // still moves the backoff curve forward.
  const attempted = await markAttempt(record.queueRecordId, startedAt);
  const attemptCount = attempted.ok ? attempted.value.attemptCount : record.attemptCount + 1;

  const submission = await deps.submit(claimed.value);

  if (submission.ok) {
    const finishedAt = new Date(deps.now()).toISOString();

    // The adapter already refused anything that is not a receipt, so orderId
    // and orderNumber are present and non-empty by the time we get here.
    // createdAt is only checked to be a STRING by that validator, so it is
    // parsed here before it is kept: an unparseable server timestamp is stored
    // as null rather than as a lie, exactly as the queue treats every other
    // timestamp it cannot read. It never blocks the sale — the sale is
    // recorded, and only this one piece of reconciliation metadata is dropped.
    const serverCreatedAt =
      parseIsoTime(submission.receipt.createdAt) !== null
        ? submission.receipt.createdAt
        : null;

    const synced = await markSynced(
      record.queueRecordId,
      {
        orderId: submission.receipt.orderId,
        orderNumber: submission.receipt.orderNumber,
        createdAt: serverCreatedAt,
      },
      finishedAt
    );

    return synced.ok
      ? {
          queueRecordId: record.queueRecordId,
          result: "synced",
          code: null,
          orderNumber: submission.receipt.orderNumber,
        }
      : {
          queueRecordId: record.queueRecordId,
          result: "skipped",
          code: synced.reason,
          orderNumber: null,
        };
  }

  const decision = classifySubmissionFailure(submission.failure, attemptCount);
  const finishedAt = new Date(deps.now()).toISOString();

  if (decision.outcome === "retry") {
    await updateQueueState(record.queueRecordId, "pending", finishedAt, {
      lastErrorCode: decision.code,
      lastErrorMessage: submission.failure.message,
      nextAttemptAt: nextAttemptAtFrom(attemptCount, deps.now()),
    });

    return {
      queueRecordId: record.queueRecordId,
      result: "retry",
      code: decision.code,
      orderNumber: null,
    };
  }

  await updateQueueState(record.queueRecordId, decision.outcome, finishedAt, {
    lastErrorCode: decision.code,
    lastErrorMessage: submission.failure.message,
  });

  return {
    queueRecordId: record.queueRecordId,
    result: decision.outcome,
    code: decision.code,
    orderNumber: null,
  };
}

// ---------------------------------------------------------------------------
// Integration hooks
// ---------------------------------------------------------------------------

/**
 * Hooks a later phase can wire without this module knowing about the UI.
 *
 * NOTHING CALLS THESE YET. 24.5D ships the engine and its triggers as a
 * library; 24.5E decides where they attach. Registering the `online` listener
 * from here would start draining a queue before anything is allowed to fill it.
 */
export type SyncTrigger = "startup" | "reconnect" | "manual";

export async function triggerSaleSync(
  trigger: SyncTrigger,
  deps: Partial<SyncDeps> = {}
): Promise<SyncRunReport> {
  // STARTUP IS THE ONE TRIGGER THAT DIFFERS, for a reason worth stating: it is
  // the only moment at which a `syncing` record is known to be an orphan rather
  // than another engine's in-flight work. A reconnect or a manual press happens
  // while the app is already running, so reclaiming there could steal a
  // submission that is still on the wire.
  if (trigger === "startup") {
    await recoverInterruptedSyncs(new Date(Date.now()).toISOString());
  }

  return runSaleSync(deps);
}

/**
 * Reclaims records stranded in `syncing` by a process that died mid-submission.
 *
 * Exposed so a host can run it once at startup — see triggerSaleSync. Safe
 * because of server-side idempotency: the interrupted submission carried the
 * record's saleRequestId, so retrying either creates the sale or returns the
 * one already created.
 */
export async function recoverStrandedSales(now: number = Date.now()): Promise<number> {
  const report = await recoverInterruptedSyncs(new Date(now).toISOString());

  return report.ok ? report.value.recovered : 0;
}

/**
 * Subscribes to the browser's own connectivity signal, returning an unsubscribe.
 *
 * navigator.onLine and the `online` event are HINTS — both lie behind a captive
 * portal — so this only nudges a drain that would have been safe to run anyway.
 * It never decides whether a device is authorized; that is
 * lib/deviceConnectivity.ts's job, on a different question.
 */
export function subscribeToReconnect(
  onReconnect: () => void,
  target: { addEventListener?: typeof window.addEventListener; removeEventListener?: typeof window.removeEventListener } | undefined = globalThis.window
): () => void {
  if (!target || typeof target.addEventListener !== "function") {
    return () => undefined;
  }

  const handler = (): void => onReconnect();

  target.addEventListener("online", handler);

  return () => {
    target.removeEventListener?.("online", handler);
  };
}

/** Read-only status for a future indicator. Builds no UI. */
export async function getSyncStatus(): Promise<SyncStatus> {
  return sharedEngine.getStatus();
}
