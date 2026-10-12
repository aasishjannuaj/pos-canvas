// v1.3 CP-2B item C — the lifecycle of "who is allowed to review", as a value.
//
// WHY THIS EXISTS AT ALL. The first wiring initialised the reviewer as DENIED
// and only refreshed it inside the two actions — but the screen hides those
// actions while the reviewer is denied. An owner opening the review screen could
// therefore never reach the thing that would have recognised them. That was a
// deadlock, and it was invisible to a browser check that handed the component an
// already-authorised reviewer as a prop.
//
// The fix needs more than "read the session on open". It needs a state that can
// say NOT YET as distinct from NO, and it needs to refuse an answer that arrives
// for a question nobody is asking any more — a read in flight when the screen is
// closed, or reopened under a different employee. That sequencing is what lives
// here, as pure values, so it can be tested without a DOM.
//
// PURE. No React, no clock, no storage, no session read. The host does the
// reading; this decides what the answer is allowed to change.

import { decideBlockedSaleReviewer } from "@/lib/blockedSaleReview";
import type { BlockedSaleReviewerDecision } from "@/lib/blockedSaleReview";

/**
 * THREE STATES, AND THE MIDDLE ONE IS THE POINT.
 *
 *   idle      the screen is shut. Nobody is authorised, and any answer still in
 *             flight is for a question that no longer exists.
 *   checking  the screen is open and the session is being read. NOT a refusal:
 *             the screen must not accuse the person of lacking permission before
 *             it has looked. It is also not permission.
 *   resolved  an answer arrived for THIS request.
 *
 * `request` is carried by every state and only ever increases. It is what makes
 * a stale answer identifiable.
 */
export type ReviewerGate =
  | { status: "idle"; request: number }
  | { status: "checking"; request: number }
  | { status: "resolved"; request: number; decision: BlockedSaleReviewerDecision };

/** Shut, and authorising nothing. The only correct initial value. */
export const IDLE_REVIEWER_GATE: ReviewerGate = Object.freeze({ status: "idle", request: 0 });

function nextRequest(gate: ReviewerGate | null | undefined): number {
  // NON-NEGATIVE, not merely a safe integer: a negative counter would hand back
  // 0 or less, and a request number that does not advance is how a stale answer
  // becomes indistinguishable from the current one. Its own test caught that.
  const current =
    typeof gate?.request === "number" && Number.isSafeInteger(gate.request) && gate.request >= 0
      ? gate.request
      : 0;

  return current + 1;
}

/**
 * The screen opened: start a new question.
 *
 * ALWAYS A NEW REQUEST NUMBER, even if one was already in flight. Reopening is a
 * different question — the employee may have changed — and the earlier answer
 * must not be able to land on it.
 */
export function openReviewerGate(gate: ReviewerGate | null | undefined): ReviewerGate {
  return { status: "checking", request: nextRequest(gate) };
}

/**
 * The screen closed: forget the permission.
 *
 * THE PERMISSION IS DROPPED, NOT PARKED. A resolved "owner" left lying around is
 * exactly what would authorise the next person to open the screen. The request
 * number advances too, so an answer still in flight cannot settle onto this.
 */
export function closeReviewerGate(gate: ReviewerGate | null | undefined): ReviewerGate {
  return { status: "idle", request: nextRequest(gate) };
}

/**
 * An answer arrived. It is accepted only if it answers the CURRENT question.
 *
 * REJECTED WHEN: the screen is shut, the screen already settled, or the number
 * does not match — which covers a slow read landing after a close, after a
 * reopen, or out of order against a faster one. In every one of those cases the
 * gate is returned UNCHANGED, so nothing is authorised by accident.
 */
export function settleReviewerGate(
  gate: ReviewerGate | null | undefined,
  request: number,
  decision: BlockedSaleReviewerDecision
): ReviewerGate {
  if (gate === null || gate === undefined) return IDLE_REVIEWER_GATE;
  if (gate.status !== "checking") return gate;
  if (gate.request !== request) return gate;
  if (decision === null || decision === undefined || typeof decision !== "object") {
    // An unreadable answer is a refusal, never permission.
    return { status: "resolved", request, decision: decideBlockedSaleReviewer(null) };
  }

  return { status: "resolved", request, decision };
}

/**
 * May this gate authorise a review right now?
 *
 * ONLY A RESOLVED, PERMITTED ANSWER. `idle` and `checking` are both false, so a
 * screen that has not finished looking authorises nothing.
 */
export function reviewerGateAllows(gate: ReviewerGate | null | undefined): boolean {
  return gate?.status === "resolved" && gate.decision.allowed === true;
}

/** Is the gate still looking? The screen shows neither controls nor a refusal. */
export function isReviewerGateChecking(gate: ReviewerGate | null | undefined): boolean {
  return gate?.status === "checking";
}

/**
 * What to tell the person, or null when there is nothing to say yet.
 *
 * Null while idle or checking: there is no refusal to report until an answer has
 * actually come back.
 */
export function reviewerGateMessage(gate: ReviewerGate | null | undefined): string | null {
  if (gate?.status !== "resolved") return null;
  if (gate.decision.allowed) return null;

  return gate.decision.message;
}

/**
 * The resolved decision, for a caller that needs the reviewer's identity.
 *
 * Null unless resolved AND permitted — nothing downstream should be handed a
 * reviewer it must not act for.
 */
export function reviewerGateReviewer(
  gate: ReviewerGate | null | undefined
): { employeeId: string; displayName: string; role: string } | null {
  if (gate?.status !== "resolved" || !gate.decision.allowed) return null;

  return gate.decision.reviewer;
}
