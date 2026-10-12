// Feature 24.5F — storage glue for reviewing and resolving a rejected sale.
//
// The decision lives in lib/rejectedSaleResolution.ts, which is pure. This file
// is the part that touches IndexedDB: it reads the durable record, rebuilds the
// receipt from the pinned configuration, and — only after re-running the policy
// against what storage says RIGHT NOW — writes the terminal disposition.
//
// WHY THE POLICY RUNS TWICE. The screen runs it to decide what to offer; this
// module runs it again immediately before the write. Between those two moments
// a sync could have completed, an uncertain sale could have been armed, or the
// record could have moved on. A confirmation dialog is not a lock, so the only
// decision that counts is the one made against freshly read storage — the same
// reasoning handleReset already applies to the reset guard.

import { buildProvisionalReceipt } from "@/lib/provisionalReceipt";
import type { ProvisionalReceipt } from "@/lib/provisionalReceipt";
import { readPinnedConfig } from "@/lib/deviceOfflineCache";
import {
  openOfflineDb,
  readPinnedConfigRecord,
  withQueueRecordMutation,
} from "@/lib/deviceOfflineStore";
import { readQueuedSale, transitionQueuedSale } from "@/lib/saleQueue";
import {
  UNCERTAIN_SALE_KEY,
  ownsUncertainSale,
  readUncertainSaleRecord,
  toUncertainSale,
} from "@/lib/uncertainSaleRecord";
import {
  getQueuedSale,
  listQueuedSales,
  startOperatorRetry,
  updateQueueState,
} from "@/lib/saleQueueSession";
import type { QueuedSale } from "@/lib/saleQueue";
import { REGISTER_BLOCKED_ERROR_CODE } from "@/lib/saleQueueSession";
import { readUncertainSale } from "@/lib/uncertainSaleSession";
import {
  decideRejectedSaleDiscardSafety,
  decideRejectedSaleRetrySafety,
  describeRejectedSaleReason,
} from "@/lib/rejectedSaleResolution";
import type {
  RejectedSaleDiscardRefusal,
  RejectedSaleRetryRefusal,
  UncertainSaleEvidence,
} from "@/lib/rejectedSaleResolution";

/**
 * Everything the review screen shows.
 *
 * `receipt` is nullable ON PURPOSE. The itemised breakdown is rebuilt from the
 * pinned configuration, and a device whose cache has been cleared no longer has
 * one. That must not hide the sale — the record itself is the evidence, and the
 * reference, time, payment method and status all come straight off it. A
 * missing receipt costs the operator the line items, not the sale.
 */
export type RejectedSaleReview = {
  record: QueuedSale;
  receipt: ProvisionalReceipt | null;
  reason: string;
  discard: { allowed: true } | { allowed: false; reason: RejectedSaleDiscardRefusal };
  retry: { allowed: true } | { allowed: false; reason: RejectedSaleRetryRefusal };
};

export type RejectedSaleReviewResult =
  | { ok: true; review: RejectedSaleReview }
  | { ok: false; reason: "not_found" | "storage_unavailable" };

/**
 * Reads the outstanding online request and reduces it to what the policy needs.
 *
 * Anything unreadable or belonging to another pairing becomes
 * `saleRequestId: null`, which the policy treats as "this might be about the
 * sale in front of you" and refuses. Failing safe is the whole job here.
 */
async function readUncertainEvidence(record: QueuedSale): Promise<UncertainSaleEvidence> {
  const state = await readUncertainSale({
    deviceAuthUserId: record.deviceAuthUserId,
    deviceId: record.deviceId,
    projectId: record.projectId,
    buildJobId: record.buildJobId,
  });

  if (state.status === "none") {
    return { present: false };
  }

  return state.status === "outstanding"
    ? { present: true, saleRequestId: state.sale.saleRequestId }
    : { present: true, saleRequestId: null };
}

/**
 * Rebuilds the receipt, or returns null if the pinned config cannot be trusted.
 *
 * IDENTITY COMES FROM THE SALE, not from session state: the config is accepted
 * only if it belongs to the same device, project and build the sale was rung up
 * under, which is exactly the guarantee that makes the prices on this screen the
 * prices the customer was charged. Note this deliberately does NOT check the
 * offline lease — a lease governs whether a till may keep TRADING, and a sale
 * that already happened stays reviewable long after trading has stopped.
 */
async function rebuildReceipt(record: QueuedSale): Promise<ProvisionalReceipt | null> {
  const opened = await openOfflineDb();

  if (!opened.ok) return null;

  const db = opened.value;
  let raw: unknown = null;

  try {
    const stored = await readPinnedConfigRecord(db);

    if (!stored.ok) return null;

    raw = stored.value;
  } finally {
    db.close();
  }

  const config = await readPinnedConfig(raw, {
    deviceAuthUserId: record.deviceAuthUserId,
    projectId: record.projectId,
    buildJobId: record.buildJobId,
  });

  if (!config.ok) return null;

  const built = buildProvisionalReceipt({ record, config: config.record.configSnapshot });

  return built.ok ? built.receipt : null;
}

export async function readRejectedSaleReview(
  queueRecordId: string
): Promise<RejectedSaleReviewResult> {
  const stored = await getQueuedSale(queueRecordId);

  if (!stored.ok) {
    return { ok: false, reason: stored.reason === "not_found" ? "not_found" : "storage_unavailable" };
  }

  const record = stored.value;
  const uncertain = await readUncertainEvidence(record);

  return {
    ok: true,
    review: {
      record,
      receipt: await rebuildReceipt(record),
      reason: describeRejectedSaleReason(record.lastErrorCode),
      discard: decideRejectedSaleDiscardSafety({ record, uncertain }),
      retry: decideRejectedSaleRetrySafety({ record, uncertain }),
    },
  };
}

export type DiscardRejectedSaleResult =
  | { ok: true; record: QueuedSale }
  | {
      ok: false;
      reason:
        | RejectedSaleDiscardRefusal
        | "not_found"
        | "storage_unavailable"
        | "corrupt_record"
        /** The record was register-blocked and the reviewer was not permitted. */
        | "reviewer_not_permitted";
    };

/**
 * Marks a rejected sale resolved. THE ONLY WRITER OF THE `discarded` STATE.
 *
 * NOTHING IS DELETED. The record keeps its idempotency key, its items, its time
 * and its rejection code; it simply stops counting as unresolved. That is what
 * lets the reset guard clear while the device still holds a full account of what
 * happened — and it is why a discarded sale can never come back as pending:
 * `discarded` is terminal in QUEUE_TRANSITIONS, so the transition machine itself
 * refuses to move it, restart or no restart.
 *
 * NO SERVER CALL. complete_sale_v4 is not invoked, no order is created, and no
 * order number is invented. The server already gave its answer; this records
 * that a person accepted it.
 */
/**
 * Discards ONE authoritatively rejected sale.
 *
 * THE AUTHORIZATION IS DECIDED AGAINST THE RECORD BEING MUTATED, in the same
 * transaction, and that is the correction. Previously the caller asked whether
 * the sale was register-blocked, got an answer, and THEN called this — which
 * re-read the record and discarded it without re-checking the role. A record
 * that became register-blocked in that window was discarded on the strength of
 * a check taken when it was something else. Independent review found it.
 *
 * So the caller no longer decides whether authorization applies. It always
 * passes the CURRENT reviewer decision, and this function — holding the record
 * it is about to write — decides whether that decision was needed. The two
 * cannot diverge, because there is no longer a moment between them.
 *
 * THE CASHIER POLICY IS UNCHANGED FOR EVERYTHING ELSE. The role is consulted
 * only when the stored reason is the register one; every other rejected sale
 * discards exactly as it did before, for whoever is signed in.
 *
 * EVERYTHING ELSE IS THE ACCEPTED POLICY, UNMOVED. decideRejectedSaleDiscardSafety
 * still runs, against the same read; the sale identity, the payload, the
 * register claim and the state machine are untouched; the rejection code is
 * still carried forward so a discarded record still says why.
 */
export async function discardRejectedSale(
  queueRecordId: string,
  reviewer: { allowed: boolean }
): Promise<DiscardRejectedSaleResult> {
  const db = await openOfflineDb();

  if (!db.ok) return { ok: false, reason: "storage_unavailable" };

  const now = new Date().toISOString();

  // v1.3 CP-2D — the connection is closed in the `finally` below.
  //
  // IT CANNOT AFFECT ATOMICITY. withQueueRecordMutation resolves on the
  // transaction's own `oncomplete`/`onabort`, so the transaction has already
  // settled before this function continues; and IDBDatabase.close() is defined
  // to wait for outstanding transactions before it takes effect, so even an
  // early close could not tear one in half. The single readwrite transaction,
  // and everything decided inside it, is untouched.
  const outcome = await withQueueRecordMutation<DiscardRejectedSaleResult>(
    db.value,
    queueRecordId,
    UNCERTAIN_SALE_KEY,
    ({ queued, uncertain }) => {
      const refuse = (
        reason: Exclude<DiscardRejectedSaleResult, { ok: true }>["reason"]
      ): QueueMutationDecisionOf => ({ commit: false, value: { ok: false, reason } });

      if (queued === undefined || queued === null) return refuse("not_found");

      const parsed = readQueuedSale(queued);

      if (!parsed.ok) return refuse("corrupt_record");

      const record = parsed.record;

      // ================================================================
      // THE GATE, ON THE RECORD AS IT IS RIGHT NOW. Not as the screen
      // rendered it, and not as a previous call reported it.
      // ================================================================
      if (record.lastErrorCode === REGISTER_BLOCKED_ERROR_CODE && reviewer?.allowed !== true) {
        return refuse("reviewer_not_permitted");
      }

      // The accepted safety policy, against the same read. The uncertain-sale
      // evidence comes from this transaction too, so it cannot have moved
      // either.
      const parsedUncertain = readUncertainSaleRecord(uncertain);
      const evidence: UncertainSaleEvidence = !parsedUncertain.ok
        ? parsedUncertain.reason === "missing"
          ? { present: false }
          : { present: true, saleRequestId: null }
        : ownsUncertainSale(parsedUncertain.record, {
              deviceAuthUserId: record.deviceAuthUserId,
              deviceId: record.deviceId,
              projectId: record.projectId,
              buildJobId: record.buildJobId,
            })
          ? { present: true, saleRequestId: toUncertainSale(parsedUncertain.record).saleRequestId }
          : { present: true, saleRequestId: null };

      const safety = decideRejectedSaleDiscardSafety({ record, uncertain: evidence });

      if (!safety.allowed) return refuse(safety.reason);

      // THE REJECTION CODE IS CARRIED FORWARD EXPLICITLY. transitionQueuedSale
      // resets lastErrorCode, lastErrorMessage and nextAttemptAt to null
      // whenever the patch omits them — right for a retry, which must not
      // inherit a stale error, and wrong here: the code is the reason this
      // record was resolvable at all, and a discarded sale with nothing
      // explaining why is not evidence.
      const moved = transitionQueuedSale(record, "discarded", now, {
        lastErrorCode: record.lastErrorCode,
        lastErrorMessage: record.lastErrorMessage,
      });

      if (!moved.ok) return refuse("storage_unavailable");

      return { commit: true, record: moved.record, value: { ok: true, record: moved.record } };
    }
  );

  try {
    return outcome.ok ? outcome.value : { ok: false, reason: "storage_unavailable" };
  } finally {
    db.value.close();
  }
}

type QueueMutationDecisionOf = {
  commit: false;
  value: DiscardRejectedSaleResult;
};

/**
 * Every sale currently asking a person to resolve it.
 *
 * Only `needs_attention` qualifies. permanent_failure is excluded because this
 * feature has no resolution for it, and offering a review with no action would
 * be worse than the silence — that case is still surfaced in the counts and is
 * still enough to block a reset.
 */
export async function listRejectedSaleReviews(): Promise<RejectedSaleReview[]> {
  const listing = await listQueuedSales();

  if (!listing.ok) return [];

  const reviews: RejectedSaleReview[] = [];

  for (const record of listing.value.sales) {
    if (record.state !== "needs_attention") continue;

    const uncertain = await readUncertainEvidence(record);

    reviews.push({
      record,
      receipt: await rebuildReceipt(record),
      reason: describeRejectedSaleReason(record.lastErrorCode),
      discard: decideRejectedSaleDiscardSafety({ record, uncertain }),
      retry: decideRejectedSaleRetrySafety({ record, uncertain }),
    });
  }

  return reviews;
}

export type RetryRejectedSaleResult =
  | { ok: true; record: QueuedSale }
  | { ok: false; reason: RejectedSaleRetryRefusal | "not_found" | "storage_unavailable" };

/**
 * Starts a fresh sync cycle for a sale that gave up. THE ONLY OPERATOR RETRY.
 *
 * Re-reads the record and the uncertainty evidence from storage and re-runs the
 * policy before writing anything, so a record that changed while the review was
 * on screen is refused by the same rule that offered the button — a stale React
 * render cannot talk this into acting.
 *
 * DOES NOT SUBMIT. It returns the record to `pending` with a clean budget and
 * leaves the existing engine to do what it already does; there is no second
 * submission path, and nothing here touches complete_sale_v4. The caller
 * triggers a manual drain afterwards.
 */
export async function retryRejectedSale(
  queueRecordId: string
): Promise<RetryRejectedSaleResult> {
  const stored = await getQueuedSale(queueRecordId);

  if (!stored.ok) {
    return { ok: false, reason: stored.reason === "not_found" ? "not_found" : "storage_unavailable" };
  }

  const record = stored.value;
  const safety = decideRejectedSaleRetrySafety({
    record,
    uncertain: await readUncertainEvidence(record),
  });

  if (!safety.allowed) {
    return { ok: false, reason: safety.reason };
  }

  const moved = await startOperatorRetry(queueRecordId, new Date().toISOString());

  return moved.ok
    ? { ok: true, record: moved.value }
    : { ok: false, reason: "storage_unavailable" };
}
