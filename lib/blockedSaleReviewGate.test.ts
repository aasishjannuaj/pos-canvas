// v1.3 CP-2B item C — the reviewer gate lifecycle.
//
// These prove the DEADLOCK is gone and cannot come back: an owner who opens the
// screen gets permission without having to press a control that permission
// hides, and no answer can authorise a question nobody asked.

import { describe, expect, it } from "vitest";

import { decideBlockedSaleReviewer } from "@/lib/blockedSaleReview";
import {
  IDLE_REVIEWER_GATE,
  closeReviewerGate,
  isReviewerGateChecking,
  openReviewerGate,
  reviewerGateAllows,
  reviewerGateMessage,
  reviewerGateReviewer,
  settleReviewerGate,
} from "@/lib/blockedSaleReviewGate";

const OWNER = { employeeId: "e1", displayName: "Olive", role: "owner" as const };
const MANAGER = { employeeId: "e2", displayName: "Mira", role: "manager" as const };
const CASHIER = { employeeId: "e3", displayName: "Cass", role: "cashier" as const };

const decide = decideBlockedSaleReviewer;

describe("a shut screen authorises nothing", () => {
  it("starts idle and denies", () => {
    expect(IDLE_REVIEWER_GATE.status).toBe("idle");
    expect(reviewerGateAllows(IDLE_REVIEWER_GATE)).toBe(false);
    expect(isReviewerGateChecking(IDLE_REVIEWER_GATE)).toBe(false);
    // Nothing to say: there has been no answer to report.
    expect(reviewerGateMessage(IDLE_REVIEWER_GATE)).toBeNull();
    expect(reviewerGateReviewer(IDLE_REVIEWER_GATE)).toBeNull();
  });

  it("denies for anything that is not a gate", () => {
    for (const value of [null, undefined, {}, "owner", 7, []]) {
      expect(reviewerGateAllows(value as never)).toBe(false);
      expect(reviewerGateReviewer(value as never)).toBeNull();
    }
  });
});

describe("opening the screen resolves permission without any action (FIX 1)", () => {
  it("an owner who opens the screen ends up permitted", () => {
    // THE DEADLOCK, AS A TEST. Previously the only thing that refreshed identity
    // was an action the screen hid while identity was unknown. Opening is now
    // enough.
    const opened = openReviewerGate(IDLE_REVIEWER_GATE);

    expect(isReviewerGateChecking(opened)).toBe(true);
    expect(reviewerGateAllows(opened)).toBe(false);

    const settled = settleReviewerGate(opened, opened.request, decide(OWNER));

    expect(reviewerGateAllows(settled)).toBe(true);
    expect(reviewerGateReviewer(settled)).toEqual(OWNER);
    expect(reviewerGateMessage(settled)).toBeNull();
  });

  it("a manager likewise", () => {
    const opened = openReviewerGate(IDLE_REVIEWER_GATE);

    expect(reviewerGateAllows(settleReviewerGate(opened, opened.request, decide(MANAGER)))).toBe(true);
  });

  it("while checking it shows neither controls nor an accusation", () => {
    const opened = openReviewerGate(IDLE_REVIEWER_GATE);

    expect(reviewerGateAllows(opened)).toBe(false);
    expect(reviewerGateMessage(opened)).toBeNull();
    expect(isReviewerGateChecking(opened)).toBe(true);
  });

  it("a cashier is refused, with words", () => {
    const opened = openReviewerGate(IDLE_REVIEWER_GATE);
    const settled = settleReviewerGate(opened, opened.request, decide(CASHIER));

    expect(reviewerGateAllows(settled)).toBe(false);
    expect(reviewerGateMessage(settled)).toBe(
      "Only an owner or a manager can review a sale that could not be recorded."
    );
  });

  it("a missing or unreadable session is refused, not assumed", () => {
    for (const session of [null, undefined, {}, { role: "owner" }, { employeeId: "e", displayName: "D", role: "chef" }]) {
      const opened = openReviewerGate(IDLE_REVIEWER_GATE);
      const settled = settleReviewerGate(opened, opened.request, decide(session));

      expect(reviewerGateAllows(settled)).toBe(false);
      expect(reviewerGateMessage(settled)).not.toBeNull();
    }
  });

  it("a malformed decision becomes a refusal, never permission", () => {
    const opened = openReviewerGate(IDLE_REVIEWER_GATE);

    for (const bad of [null, undefined, "allowed", 1, true]) {
      const settled = settleReviewerGate(opened, opened.request, bad as never);

      expect(reviewerGateAllows(settled)).toBe(false);
    }
  });
});

describe("a stale answer cannot authorise anything (FIX 1)", () => {
  it("is ignored after the screen closed", () => {
    const opened = openReviewerGate(IDLE_REVIEWER_GATE);
    const closed = closeReviewerGate(opened);

    // The owner read finally comes back -- for a screen that is shut.
    const settled = settleReviewerGate(closed, opened.request, decide(OWNER));

    expect(settled).toEqual(closed);
    expect(reviewerGateAllows(settled)).toBe(false);
  });

  it("is ignored after the screen was reopened", () => {
    const first = openReviewerGate(IDLE_REVIEWER_GATE);
    const closed = closeReviewerGate(first);
    const second = openReviewerGate(closed);

    // The FIRST read (an owner) lands while the SECOND question is open.
    const settled = settleReviewerGate(second, first.request, decide(OWNER));

    expect(settled).toEqual(second);
    expect(reviewerGateAllows(settled)).toBe(false);

    // Only the answer to the current question counts, and here it is a cashier.
    const correct = settleReviewerGate(second, second.request, decide(CASHIER));

    expect(reviewerGateAllows(correct)).toBe(false);
  });

  it("does not overwrite an answer that already landed", () => {
    const opened = openReviewerGate(IDLE_REVIEWER_GATE);
    const settled = settleReviewerGate(opened, opened.request, decide(CASHIER));
    const again = settleReviewerGate(settled, opened.request, decide(OWNER));

    // Two reads raced; the gate keeps the one it already answered with rather
    // than upgrading itself.
    expect(again).toEqual(settled);
    expect(reviewerGateAllows(again)).toBe(false);
  });

  it("request numbers only ever increase, across any sequence", () => {
    let gate = IDLE_REVIEWER_GATE;
    const seen = [gate.request];

    for (let i = 0; i < 25; i += 1) {
      gate = i % 3 === 0 ? closeReviewerGate(gate) : openReviewerGate(gate);
      seen.push(gate.request);
    }

    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    }
  });

  it("recovers from a corrupted request number instead of stalling", () => {
    for (const broken of [NaN, Infinity, -1, 1.5, "3"]) {
      const gate = openReviewerGate({ status: "idle", request: broken as never });

      expect(Number.isSafeInteger(gate.request)).toBe(true);
      expect(gate.request).toBeGreaterThan(0);
    }
  });
});

describe("closing clears permission (FIX 1)", () => {
  it("drops a resolved owner so the next person is not authorised by it", () => {
    const opened = openReviewerGate(IDLE_REVIEWER_GATE);
    const asOwner = settleReviewerGate(opened, opened.request, decide(OWNER));

    expect(reviewerGateAllows(asOwner)).toBe(true);

    const closed = closeReviewerGate(asOwner);

    expect(closed.status).toBe("idle");
    expect(reviewerGateAllows(closed)).toBe(false);
    expect(reviewerGateReviewer(closed)).toBeNull();
  });

  it("open, close and reopen never carries permission across", () => {
    const first = openReviewerGate(IDLE_REVIEWER_GATE);
    const owner = settleReviewerGate(first, first.request, decide(OWNER));
    const closed = closeReviewerGate(owner);
    const reopened = openReviewerGate(closed);

    // Reopened and still checking: permission did not survive the close.
    expect(reviewerGateAllows(reopened)).toBe(false);
    expect(isReviewerGateChecking(reopened)).toBe(true);
  });
});

describe("the gate never throws", () => {
  it("survives hostile input on every function", () => {
    for (const value of [null, undefined, NaN, Symbol("s"), () => {}, [], {}, "x", 0]) {
      expect(() => openReviewerGate(value as never)).not.toThrow();
      expect(() => closeReviewerGate(value as never)).not.toThrow();
      expect(() => settleReviewerGate(value as never, 1, decide(OWNER))).not.toThrow();
      expect(() => reviewerGateAllows(value as never)).not.toThrow();
      expect(() => reviewerGateMessage(value as never)).not.toThrow();
      expect(() => reviewerGateReviewer(value as never)).not.toThrow();
      expect(() => isReviewerGateChecking(value as never)).not.toThrow();
    }
  });
});
