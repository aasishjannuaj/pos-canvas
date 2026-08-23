"use client";

// Feature 24.5E — the cashier's answer to "did those sales go through?".
//
// DELIBERATELY ONE LINE. The approved scope is a minimal status plus a manual
// trigger, not a queue console: no per-sale list, no timestamps, no error
// codes, no retry-per-record. Anything richer belongs to the owner-facing work
// and to a later phase, and building it here would put a database view in front
// of someone whose job is to serve the next customer.
//
// IT RENDERS NOTHING WHEN THERE IS NOTHING TO SAY. A till with an empty queue
// shows no badge at all — the normal case must not nag
// (docs/OFFLINE_ARCHITECTURE.md §17).
//
// COUNTS, NEVER PERCENTAGES. "3 sales waiting to sync" is a real quantity; a
// synthetic progress bar over three records would be an invention.
import { describeOfflineSaleStatus } from "@/lib/offlineSaleStatus";
import type { OfflineSaleStatus } from "@/lib/offlineSaleStatus";

type DeviceSyncStatusProps = {
  status: OfflineSaleStatus;
  /** True while a drain is in flight, so the copy stops promising a fresh one. */
  syncing: boolean;
  /**
   * Null hides the button entirely — while the device is offline there is
   * nothing a press could achieve, and a control that visibly does nothing
   * teaches operators to distrust the UI.
   */
  onSyncNow: (() => void) | null;
  /**
   * Feature 24.5F — opens the unresolved-sale review.
   *
   * Null hides it. A sale that needs attention must be REACHABLE from the
   * screen that reports it: Windows hardware found a paired, working till whose
   * only sign of an unresolved sale was this strip, with no control anywhere
   * that could act on it — and reset could not clear it either, because that
   * sale was what blocked reset.
   */
  onReview?: (() => void) | null;
};

export default function DeviceSyncStatus({
  status,
  syncing,
  onSyncNow,
  onReview = null,
}: DeviceSyncStatusProps) {
  const lines = describeOfflineSaleStatus(status);

  if (lines.length === 0) {
    return null;
  }

  const attention = status.needsAttention > 0;

  return (
    <div
      role="status"
      className={`flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b px-4 py-1.5 text-center text-xs ${
        attention
          ? "border-amber-200 bg-amber-50 text-amber-900"
          : "border-neutral-200 bg-neutral-50 text-neutral-700"
      }`}
    >
      {lines.map((line, index) => (
        <span key={line} className={index === 0 ? "font-semibold" : undefined}>
          {line}
        </span>
      ))}

      {syncing && <span className="text-neutral-500">Syncing…</span>}

      {onReview !== null && (
        <button
          type="button"
          onClick={onReview}
          className="rounded-full border border-current px-2.5 py-0.5 text-[11px] font-semibold transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        >
          {status.needsAttention === 1 ? "Review sale" : "Review sales"}
        </button>
      )}

      {onSyncNow !== null && !syncing && (
        <button
          type="button"
          onClick={onSyncNow}
          className="rounded-full border border-current px-2.5 py-0.5 text-[11px] font-semibold transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        >
          Sync now
        </button>
      )}
    </div>
  );
}
