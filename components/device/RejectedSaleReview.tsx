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

import {
  isReviewerGateChecking,
  reviewerGateAllows,
  reviewerGateMessage,
  reviewerGateReviewer,
} from "@/lib/blockedSaleReviewGate";
import type { ReviewerGate } from "@/lib/blockedSaleReviewGate";
import { REGISTER_BLOCKED_ERROR_CODE } from "@/lib/saleQueueSession";
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
  /**
   * v1.3 CP-2B item C — where the host has got to in establishing who this is.
   *
   * THREE STATES, NOT TWO. "Still checking" is rendered as neither controls nor
   * a refusal: telling someone they lack permission before anything has been
   * read is both wrong and, when it hides the only control that would have
   * refreshed their identity, a deadlock. That was the defect.
   *
   * PRESENTATION ONLY. Hiding a control is a courtesy, not a guard: every
   * action below is re-checked against the live session inside DeviceApp before
   * anything is written, so a stale gate here cannot authorise anything.
   */
  reviewerGate: ReviewerGate;
  /** Records an owner/manager decision. Resolves to a message, or null. */
  onReviewDecision: (
    queueRecordId: string,
    action: "acknowledged" | "escalated"
  ) => Promise<string | null>;
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
  reviewerGate,
  onReviewDecision,
  onDiscard,
  onRetry,
  onClose,
}: RejectedSaleReviewProps) {
  const [confirming, setConfirming] = useState<string | null>(null);

  // v1.3 CP-2B item C — the outcome of the last recorded decision, per sale.
  const allowed = reviewerGateAllows(reviewerGate);
  const checking = isReviewerGateChecking(reviewerGate);
  const refusal = reviewerGateMessage(reviewerGate);
  const signedInReviewer = reviewerGateReviewer(reviewerGate);

  const [decisionBusy, setDecisionBusy] = useState<string | null>(null);
  const [decisionFor, setDecisionFor] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [decisionSaved, setDecisionSaved] = useState<string | null>(null);

  /**
   * Runs one decision and reports exactly what happened.
   *
   * A REFUSAL IS NEVER SHOWN AS A SAVE. onReviewDecision resolves to a message
   * when nothing was written -- including when the history is full -- and that
   * message is what the reviewer reads. Only a null means recorded.
   */
  async function run(queueRecordId: string, action: "acknowledged" | "escalated") {
    setDecisionBusy(queueRecordId);
    setDecisionFor(queueRecordId);
    setDecisionSaved(null);
    setDecisionError(null);

    const message = await onReviewDecision(queueRecordId, action);

    setDecisionError(message);
    setDecisionSaved(message === null ? queueRecordId : null);
    setDecisionBusy(null);
  }
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
                {/* v1.3 CP-2B item C — the ORIGINAL identity and the CLAIM.
                    Both are shown verbatim: the sale id is the one the server
                    will replay under, and the register is what this till
                    claimed, never something resolved here. */}
                <Row label="Sale ID" value={record.saleRequestId} />
                <Row
                  label="Claimed register"
                  value={record.registerSessionId ?? "None recorded"}
                />
                {/* HONEST ABOUT THE PAYMENT, AND ONLY THAT. The device knows
                    which method the cashier selected. It does NOT know whether
                    cash was actually taken or counted, so the wording says
                    "recorded as" and the note below says what is unverified. */}
                <Row
                  label="Payment"
                  value={
                    record.paymentMethod === "cash"
                      ? "Recorded as cash"
                      : "Recorded as card"
                  }
                />
                {record.paymentMethod === "cash" && (
                  <p className="mt-2 text-xs leading-relaxed text-amber-800" data-cash-note>
                    This sale was recorded as a cash payment. POS Canvas cannot confirm whether
                    the cash was taken or counted — check the drawer before deciding.
                  </p>
                )}

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

              {/* ================================================================
                  v1.3 CP-2B item C — OWNER / MANAGER REVIEW.
                  Only for a sale held back by the register check, and only for
                  a permitted role. A cashier sees the facts and the reason, and
                  no control that could record a decision or discard the sale.
                  ================================================================ */}
              {record.lastErrorCode === REGISTER_BLOCKED_ERROR_CODE && (
                <div className="mt-4 border-t border-neutral-100 pt-3" data-blocked-review>
                  {checking ? (
                    <p className="text-xs leading-relaxed text-neutral-500" data-review-checking>
                      Checking your permissions...
                    </p>
                  ) : allowed ? (
                    <>
                      <p className="text-xs leading-relaxed text-neutral-600">
                        Recording a decision does not record the sale. It stays here until it
                        is retried or discarded.
                      </p>

                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={decisionBusy !== null}
                          onClick={() => run(record.queueRecordId, "acknowledged")}
                          className="rounded-full border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 disabled:opacity-50"
                          data-acknowledge
                        >
                          Acknowledge
                        </button>
                        <button
                          type="button"
                          disabled={decisionBusy !== null}
                          onClick={() => run(record.queueRecordId, "escalated")}
                          className="rounded-full border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 disabled:opacity-50"
                          data-escalate
                        >
                          Escalate
                        </button>
                      </div>

                      {signedInReviewer !== null && (
                        <p className="mt-2 text-xs text-neutral-500">
                          Signed in as {signedInReviewer.displayName} ({signedInReviewer.role}).
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-xs leading-relaxed text-neutral-600" data-review-denied>
                      {refusal}
                    </p>
                  )}

                  {decisionError !== null && decisionFor === record.queueRecordId && (
                    <p className="mt-2 text-xs leading-relaxed text-red-700" data-decision-error>
                      {decisionError}
                    </p>
                  )}

                  {decisionSaved === record.queueRecordId && decisionError === null && (
                    <p className="mt-2 text-xs leading-relaxed text-green-700" data-decision-saved>
                      Decision recorded. This sale is still unresolved.
                    </p>
                  )}

                  {(record.blockedSaleReviews ?? []).length > 0 && (
                    <div className="mt-3 border-t border-neutral-100 pt-3" data-decision-trail>
                      <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                        Recorded decisions
                      </p>
                      {(record.blockedSaleReviews ?? []).map((decision, index) => (
                        <p
                          key={`${decision.atIso}-${index}`}
                          className="mt-1 text-xs text-neutral-600"
                        >
                          {decision.action === "escalated" ? "Escalated" : "Acknowledged"} by{" "}
                          {decision.byDisplayName} ({decision.byRole}) ·{" "}
                          {new Date(decision.atIso).toLocaleString()}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}

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
              {!isConfirming &&
                !review.retry.allowed &&
                (!review.discard.allowed ||
                  (record.lastErrorCode === REGISTER_BLOCKED_ERROR_CODE && !allowed)) && (
                <p className="mt-5 rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs leading-relaxed text-neutral-600">
                  {RETRY_REJECTED_SALE_REFUSALS[review.retry.reason]}
                </p>
              )}

              {/* v1.3 CP-2B item C — a register-blocked sale may only be
                  discarded by an owner or a manager. handleDiscard re-checks
                  the live session regardless, so this is the courtesy and that
                  is the guard; both are needed, because a visible control
                  invites an attempt that will only be refused. */}
              {!isConfirming &&
                review.discard.allowed &&
                (record.lastErrorCode !== REGISTER_BLOCKED_ERROR_CODE || allowed) && (
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
