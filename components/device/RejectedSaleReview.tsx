"use client";

// Feature 24.5F — the screen a person uses to resolve an authoritatively
// rejected sale.
//
// DELIBERATELY NOT SALES HISTORY. This shows the sales that are blocking the
// till right now and offers the one action that can clear them. There is no
// browsing, no filtering, no synced sales and no generic delete — the future
// owner-facing history feature is a different thing built on different rules.
//
// TWO STEPS, ALWAYS. Reviewing and discarding are separate screens: the review
// answers "what is this sale", the confirmation answers "do you accept that the
// money is now yours to reconcile". Collapsing them into one tap is exactly how
// takings get thrown away by someone trying to clear a badge.

import { useState } from "react";

import type { RejectedSaleReview as Review } from "@/lib/rejectedSaleSession";
import {
  DISCARD_REJECTED_SALE_ACTION,
  RETRY_REJECTED_SALE_ACTION,
  RETRY_REJECTED_SALE_REFUSALS,
  DISCARD_REJECTED_SALE_CONFIRMATION_LINES,
  DISCARD_REJECTED_SALE_CONFIRM_ACTION,
  DISCARD_REJECTED_SALE_REFUSALS,
  REJECTED_SALE_STATUS_LABEL,
} from "@/lib/rejectedSaleResolution";

type RejectedSaleReviewProps = {
  reviews: readonly Review[];
  /** Resolves to an error message, or null when the discard succeeded. */
  onDiscard: (queueRecordId: string) => Promise<string | null>;
  /** Resolves to an error message, or null when the retry was accepted. */
  onRetry: (queueRecordId: string) => Promise<string | null>;
  onClose: () => void;
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="text-xs text-neutral-500">{label}</span>
      <span className="text-sm font-medium text-neutral-900">{value}</span>
    </div>
  );
}

export default function RejectedSaleReview({
  reviews,
  onDiscard,
  onRetry,
  onClose,
}: RejectedSaleReviewProps) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // NO CONFIRMATION STEP, deliberately. A retry is not destructive: it sends a
  // sale this device already holds, under the identity it already has, and the
  // worst case is the same failure again. Putting it behind the same friction as
  // a discard would teach operators to click through both.
  async function requestRetry(queueRecordId: string) {
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const failure = await onRetry(queueRecordId);

      setNotice(failure === null ? "Trying this sale again…" : null);
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDiscard(queueRecordId: string) {
    setBusy(true);
    setError(null);

    try {
      const failure = await onDiscard(queueRecordId);

      if (failure !== null) {
        setError(failure);
        return;
      }

      setConfirming(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-neutral-50 px-6 py-10">
      <div className="mx-auto w-full max-w-md">
        <p className="text-xs font-semibold uppercase tracking-widest text-neutral-400">
          POS Canvas
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-neutral-900">
          {reviews.length === 1 ? "Sale needs attention" : "Sales need attention"}
        </h1>

        {reviews.length === 0 && (
          <p className="mt-4 text-sm text-neutral-600">
            Nothing on this device needs attention any more.
          </p>
        )}

        {reviews.map((review) => {
          const { record, receipt } = review;
          const isConfirming = confirming === record.queueRecordId;

          return (
            <section
              key={record.queueRecordId}
              className="mt-6 rounded-2xl border border-amber-200 bg-white p-5"
            >
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">
                {REJECTED_SALE_STATUS_LABEL}
              </p>

              <p className="mt-2 text-sm leading-relaxed text-neutral-700">{review.reason}</p>

              <div className="mt-4 border-t border-neutral-100 pt-3">
                {receipt !== null && <Row label="Reference" value={receipt.offlineReference} />}
                <Row label="Taken" value={new Date(record.occurredAt).toLocaleString()} />
                <Row label="Payment" value={record.paymentMethod} />

                {receipt === null ? (
                  <p className="mt-3 text-xs leading-relaxed text-neutral-500">
                    The itemised breakdown for this sale is not available on this device any
                    more. The sale itself is unchanged.
                  </p>
                ) : (
                  <>
                    <div className="mt-3 border-t border-neutral-100 pt-3">
                      {receipt.items.map((item) => (
                        <div key={`${item.itemId}-${item.itemName}`} className="py-1">
                          <div className="flex items-baseline justify-between gap-4">
                            <span className="text-sm text-neutral-800">
                              {item.quantity} × {item.itemName}
                            </span>
                            <span className="text-sm font-medium text-neutral-900">
                              {item.lineTotal}
                            </span>
                          </div>
                          {item.modifiers.map((modifier) => (
                            <p
                              key={`${modifier.groupName}-${modifier.optionName}`}
                              className="pl-4 text-xs text-neutral-500"
                            >
                              {modifier.optionName}
                            </p>
                          ))}
                        </div>
                      ))}
                    </div>

                    <div className="mt-3 border-t border-neutral-100 pt-3">
                      <Row label="Subtotal" value={receipt.subtotal} />
                      <Row label="Tax" value={receipt.taxAmount} />
                      {receipt.tipAmount !== "0.00" && (
                        <Row label="Tip" value={receipt.tipAmount} />
                      )}
                      <Row label="Total" value={receipt.total} />
                    </div>
                  </>
                )}
              </div>

              {!isConfirming && review.retry.allowed && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void requestRetry(record.queueRecordId)}
                  className="mt-5 w-full rounded-xl bg-neutral-900 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
                >
                  {busy ? "Sending…" : RETRY_REJECTED_SALE_ACTION}
                </button>
              )}

              {/* A code that is neither retryable nor discardable gets the
                  reason and nothing else — never a control that cannot help. */}
              {!isConfirming && !review.retry.allowed && !review.discard.allowed && (
                <p className="mt-5 rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs leading-relaxed text-neutral-600">
                  {RETRY_REJECTED_SALE_REFUSALS[review.retry.reason]}
                </p>
              )}

              {!isConfirming && review.discard.allowed && (
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setConfirming(record.queueRecordId);
                  }}
                  className="mt-5 w-full rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm font-semibold text-neutral-700 transition-colors hover:bg-neutral-100"
                >
                  {DISCARD_REJECTED_SALE_ACTION}
                </button>
              )}

              {/* Only when discard was the plausible action and was refused.
                  A retryable row already has its own control above. */}
              {!isConfirming && !review.discard.allowed && review.retry.allowed && (
                <p className="mt-3 text-xs leading-relaxed text-neutral-500">
                  {DISCARD_REJECTED_SALE_REFUSALS[review.discard.reason]}
                </p>
              )}

              {isConfirming && (
                <div className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4">
                  {DISCARD_REJECTED_SALE_CONFIRMATION_LINES.map((line) => (
                    <p key={line} className="mb-2 text-xs leading-relaxed text-red-900 last:mb-0">
                      {line}
                    </p>
                  ))}

                  {/* Keep goes FIRST and carries the solid styling: the
                      destructive action must never be the one a thumb finds by
                      default. */}
                  <div className="mt-4 flex flex-col gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setError(null);
                        setConfirming(null);
                      }}
                      className="w-full rounded-xl bg-neutral-900 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
                    >
                      Keep this sale
                    </button>

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void confirmDiscard(record.queueRecordId)}
                      className="w-full rounded-xl border border-red-300 bg-white px-4 py-3 text-sm font-semibold text-red-700 transition-colors hover:bg-red-100 disabled:opacity-50"
                    >
                      {busy ? "Discarding…" : DISCARD_REJECTED_SALE_CONFIRM_ACTION}
                    </button>
                  </div>
                </div>
              )}

              {notice !== null && (
                <p
                  aria-live="polite"
                  className="mt-3 rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs leading-relaxed text-neutral-700"
                >
                  {notice}
                </p>
              )}

              {error !== null && !isConfirming && (
                <p
                  aria-live="polite"
                  className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900"
                >
                  {error}
                </p>
              )}

              {error !== null && isConfirming && (
                <p
                  aria-live="polite"
                  className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900"
                >
                  {error}
                </p>
              )}
            </section>
          );
        })}

        <button
          type="button"
          onClick={onClose}
          className="mt-8 w-full rounded-xl border border-neutral-200 bg-white px-4 py-3.5 text-sm font-semibold text-neutral-700 transition-colors hover:bg-neutral-100"
        >
          Back
        </button>
      </div>
    </div>
  );
}
