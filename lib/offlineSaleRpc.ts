// Feature 24.5D — the ONLY module in this repository that calls complete_sale_v4.
//
// Deliberately its own file. Keeping the v4 call in one small adapter makes
// "offline submission is reachable only from the sync engine" a property a
// guard can check by listing files, rather than a claim about control flow
// nobody can verify. lib/device.rpc.ts keeps calling complete_sale_v3 for
// ordinary online checkout and knows nothing about this path.
//
// WHAT CROSSES THE WIRE: the queued record's OWN persisted values, unchanged.
// Not a recomputed total, not a fresh timestamp, not a new request id. The
// device sends identifiers, quantities and modifier selections; complete_sale_v4
// prices the sale from the pinned build snapshot and ignores anything else a
// client might send, which is what makes submitting from a queue safe at all.
//
// NO SERVICE-ROLE CREDENTIAL. This goes through the same anonymous device
// client every other device call uses, under the device's own paired session.
import { getDeviceSupabaseClient } from "@/lib/supabase/deviceClient";
import { isCompletedSaleReceipt } from "@/lib/completedSale";
import type { CompletedSaleReceipt } from "@/lib/completedSale";
import { toSubmissionFailure } from "@/lib/saleSyncClassifier";
import type { SubmissionFailure } from "@/lib/saleSyncClassifier";
import type { QueuedSale } from "@/lib/saleQueue";

export type OfflineSaleSubmission =
  | { ok: true; receipt: CompletedSaleReceipt }
  | { ok: false; failure: SubmissionFailure };

/**
 * Submits one queued sale.
 *
 * IDEMPOTENT BY CONSTRUCTION. The persisted saleRequestId is passed straight
 * through, so a retry after a lost response returns the order the server
 * already created rather than making a second one. That is the same contract
 * the online path relies on, reached from a durable record instead of React
 * state — which is the entire point of 24.5C having stored it.
 */
export async function submitQueuedSale(record: QueuedSale): Promise<OfflineSaleSubmission> {
  try {
    const { data, error } = await getDeviceSupabaseClient().rpc("complete_sale_v4", {
      p_project_id: record.projectId,
      p_payment_method: record.paymentMethod,
      p_tip_amount: record.tipAmount,
      // Identifiers and quantities only — buildSaleRequestItems' rule, applied
      // to a stored record. There is nowhere in this payload for an amount.
      p_items: record.items.map((item) => ({
        itemId: item.itemId,
        quantity: item.quantity,
        modifiers: item.modifiers.map((group) => ({
          groupId: group.groupId,
          optionIds: group.optionIds,
        })),
      })),
      p_sale_request_id: record.saleRequestId,
      p_occurred_at: record.occurredAt,
      p_source: record.source,
    });

    if (error) {
      return { ok: false, failure: toSubmissionFailure(error) };
    }

    // A response that is not a receipt is not a success. Treated as an
    // unrecognised server answer rather than assumed good, so a malformed
    // payload can never mark a sale synced.
    if (!isCompletedSaleReceipt(data)) {
      return {
        ok: false,
        failure: { transport: "server_rejected", message: "Malformed sale response" },
      };
    }

    return { ok: true, receipt: data };
  } catch (thrown) {
    return { ok: false, failure: toSubmissionFailure(thrown) };
  }
}
