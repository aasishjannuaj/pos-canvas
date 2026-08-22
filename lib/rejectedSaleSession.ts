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
import { openOfflineDb, readPinnedConfigRecord } from "@/lib/deviceOfflineStore";
import { getQueuedSale, listQueuedSales, updateQueueState } from "@/lib/saleQueueSession";
import type { QueuedSale } from "@/lib/saleQueue";
import { readUncertainSale } from "@/lib/uncertainSaleSession";
import {
  decideRejectedSaleDiscardSafety,
  describeRejectedSaleReason,
} from "@/lib/rejectedSaleResolution";
import type {
  RejectedSaleDiscardRefusal,
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
    },
  };
}

export type DiscardRejectedSaleResult =
  | { ok: true; record: QueuedSale }
  | { ok: false; reason: RejectedSaleDiscardRefusal | "not_found" | "storage_unavailable" };

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
export async function discardRejectedSale(
  queueRecordId: string
): Promise<DiscardRejectedSaleResult> {
  const stored = await getQueuedSale(queueRecordId);

  if (!stored.ok) {
    return { ok: false, reason: stored.reason === "not_found" ? "not_found" : "storage_unavailable" };
  }

  const record = stored.value;
  const safety = decideRejectedSaleDiscardSafety({
    record,
    uncertain: await readUncertainEvidence(record),
  });

  if (!safety.allowed) {
    return { ok: false, reason: safety.reason };
  }

  // THE REJECTION CODE IS CARRIED FORWARD EXPLICITLY. transitionQueuedSale
  // resets lastErrorCode, lastErrorMessage and nextAttemptAt to null whenever
  // the patch omits them — right for a retry, which must not inherit a stale
  // error, and wrong here: the code is the reason this record was resolvable at
  // all, and a discarded sale with nothing explaining why is not evidence. Only
  // nextAttemptAt is allowed to fall to null, because a resolved record must
  // never carry a retry instant.
  const moved = await updateQueueState(queueRecordId, "discarded", new Date().toISOString(), {
    lastErrorCode: record.lastErrorCode,
    lastErrorMessage: record.lastErrorMessage,
  });

  return moved.ok
    ? { ok: true, record: moved.value }
    : { ok: false, reason: "storage_unavailable" };
}

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
    });
  }

  return reviews;
}
