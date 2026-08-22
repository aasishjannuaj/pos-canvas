"use client";

import type { ReactNode } from "react";

// Feature 16.4A — every non-POS device screen: loading, offline, revoked and
// configuration-unavailable. One layout, so a till never jumps between visual
// languages while it is resolving its own state.

type DeviceStatusScreenProps = {
  title: string;
  message: string;
  /** Shown while the device is resolving state; suppresses the actions. */
  busy?: boolean;
  onRetry?: () => void;
  retryLabel?: string;
  onReset?: () => void;
  /**
   * Feature 24.5F — renders Reset as unavailable when the caller already knows
   * this device holds unresolved financial evidence.
   *
   * AN AFFORDANCE, NOT THE GUARD. handleReset re-reads durable storage and
   * refuses on its own authority; this only stops the button from inviting a
   * press that will be refused. Never move the safety decision here: React
   * state can be stale, and IndexedDB is the only thing that knows what this
   * device is actually holding.
   */
  resetDisabled?: boolean;
  /** Explains what Reset does — never shown without it. */
  resetNote?: string;
  /** Feature 24.5F — opens the unresolved-sale review. */
  onReview?: () => void;
  reviewLabel?: string;
  /**
   * Feature 24.5E — the outcome of the LAST action taken on this screen.
   *
   * Exists so a refused reset can say why in the place the operator pressed the
   * button, rather than failing silently. Rendered as a notice rather than an
   * error: refusing to reset a device holding unsynced sales is the system
   * working, not breaking.
   */
  actionNotice?: string | null;
  /**
   * Feature 24.5F — a slot for the queue's own status, above the actions.
   *
   * WHY A SLOT RATHER THAN MORE PROPS. The revoked screen has to show what this
   * device still owes — the waiting and needs-attention counts, and a Sync now
   * control — and that is already a component. Re-describing it through four
   * more props here would produce a second rendering of the same facts, which
   * is exactly how two screens start disagreeing about how many sales are
   * waiting.
   *
   * It exists because the revoked screen told operators to "let it sync" while
   * rendering nothing that could sync: DeviceSyncStatus lived only in the
   * `ready` branch, so a revoked till with a queued sale had no visible count
   * and no button, and reset stayed blocked forever.
   */
  statusSlot?: ReactNode;
};

export default function DeviceStatusScreen({
  title,
  message,
  busy = false,
  onRetry,
  retryLabel = "Try again",
  onReset,
  resetDisabled = false,
  resetNote,
  onReview,
  reviewLabel = "Review sale",
  actionNotice = null,
  statusSlot = null,
}: DeviceStatusScreenProps) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-neutral-50 px-6 py-12">
      <div className="w-full max-w-md text-center">
        <p className="text-xs font-semibold uppercase tracking-widest text-neutral-400">
          POS Canvas
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-neutral-900">
          {title}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-neutral-500">{message}</p>

        {busy && (
          <p className="mt-6 text-sm text-neutral-400" role="status">
            Working…
          </p>
        )}

        {/* Feature 24.5F — above the actions on purpose: what the device still
            owes is the reason Reset may refuse, so an operator reads it before
            reaching for the button rather than after being told no. */}
        {!busy && statusSlot !== null && (
          <div className="mt-6 text-left">{statusSlot}</div>
        )}

        {!busy && (onRetry || onReset || onReview) && (
          <div className="mt-8 flex flex-col gap-3">
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="rounded-xl bg-neutral-900 px-4 py-3.5 text-sm font-semibold text-white transition-colors hover:bg-neutral-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
              >
                {retryLabel}
              </button>
            )}

            {onReview && (
              <button
                type="button"
                onClick={onReview}
                className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3.5 text-sm font-semibold text-amber-900 transition-colors hover:bg-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
              >
                {reviewLabel}
              </button>
            )}

            {onReset && (
              <button
                type="button"
                onClick={onReset}
                disabled={resetDisabled}
                aria-disabled={resetDisabled}
                className="rounded-xl border border-neutral-200 bg-white px-4 py-3.5 text-sm font-semibold text-neutral-700 transition-colors hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white"
              >
                Reset this device
              </button>
            )}
          </div>
        )}

        {!busy && actionNotice !== null && (
          <p
            aria-live="polite"
            className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900"
          >
            {actionNotice}
          </p>
        )}

        {!busy && onReset && resetNote && (
          <p className="mt-4 text-xs leading-relaxed text-neutral-400">
            {resetNote}
          </p>
        )}
      </div>
    </div>
  );
}
