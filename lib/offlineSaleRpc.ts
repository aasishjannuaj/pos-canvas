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
 * How long one submission may take before this device stops waiting.
 *
 * WHY THIRTY SECONDS. The floor is set by how slow a legitimate call can be:
 * complete_sale_v4 takes a project-level FOR UPDATE lock, so a busy shop can
 * genuinely serialize behind another till, and a phone on poor mobile data adds
 * seconds of round trip on top. Anything under about ten seconds would start
 * abandoning calls that were going to succeed, and every abandoned call costs an
 * idempotent replay and one of the ten attempts a record gets.
 *
 * The ceiling is set by what a person can stand. A till whose queue is wedged is
 * a till that cannot be reset or re-paired, and thirty seconds is roughly the
 * longest a cashier will watch a spinner before deciding the software is broken.
 *
 * There is no correct number here, only a band — and inside that band the cost of
 * being slightly too generous (a longer stuck window, bounded) is much lower than
 * the cost of being too eager (needless unknown outcomes on a working network).
 */
export const SALE_SUBMISSION_TIMEOUT_MS = 30_000;

/**
 * The message stored against a timed-out attempt.
 *
 * NOTHING EVER PARSES THIS. The timeout is identified by the `timedOut` flag on
 * the failure, set by the one timer that can cause it — see the note in
 * submitQueuedSale about why message text must not be the signal.
 */
export const SALE_TIMEOUT_MESSAGE = "The sale request timed out on this device";

/** The shape submitQueuedSale needs from PostgREST, so a test can supply one. */
export type SaleRpcCall = (
  args: Record<string, unknown>,
  signal: AbortSignal
) => Promise<{ data: unknown; error: unknown }>;

/**
 * The real call. `.abortSignal()` is PostgREST's own per-request hook, verified
 * against @supabase/postgrest-js: the builder passes it straight to fetch as
 * `signal`. Deliberately NOT a custom global fetch on the Supabase client — that
 * would also bound token refresh and every other device request, and an auth
 * refresh has no business sharing a sale's deadline.
 */
const defaultRpc: SaleRpcCall = async (args, signal) => {
  const { data, error } = await getDeviceSupabaseClient()
    .rpc("complete_sale_v4", args)
    .abortSignal(signal);

  return { data, error };
};

/**
 * Submits one queued sale.
 *
 * IDEMPOTENT BY CONSTRUCTION. The persisted saleRequestId is passed straight
 * through, so a retry after a lost response returns the order the server
 * already created rather than making a second one. That is the same contract
 * the online path relies on, reached from a durable record instead of React
 * state — which is the entire point of 24.5C having stored it.
 */
export async function submitQueuedSale(
  record: QueuedSale,
  options: { timeoutMs?: number; rpc?: SaleRpcCall } = {}
): Promise<OfflineSaleSubmission> {
  const timeoutMs = options.timeoutMs ?? SALE_SUBMISSION_TIMEOUT_MS;
  const rpc = options.rpc ?? defaultRpc;

  const controller = new AbortController();

  // THE SENTINEL. Set by the one timer below and by nothing else, so "did WE
  // give up?" is answered by a variable this function owns rather than by
  // reading an error message.
  //
  // Message text cannot be trusted for this. TRANSPORT_MESSAGE_FRAGMENTS in
  // lib/deviceConnectivity.ts already matches "aborterror", "signal timed out"
  // and "timeout", so an aborted request routed through the ordinary classifier
  // comes back as `transport` — a definite claim that the request never reached
  // the server. That claim is FALSE for a timeout, and expensively so: it is the
  // evidence enterOfflineFromTransportFailure uses to put the till into offline
  // mode, so our own impatience could take a shop offline over a sale the server
  // had already committed.
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const { data, error } = await rpc(
      {
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
        // THE PERSISTED KEY, UNCHANGED. A timeout does not mint a new one and
        // neither does anything else: this is read from the durable record every
        // attempt, so a replay after a lost response is the same request as far
        // as complete_sale_v4's idempotency lookup is concerned.
        p_sale_request_id: record.saleRequestId,
        p_occurred_at: record.occurredAt,
        p_source: record.source,
      },
      controller.signal
    );

    // CHECKED BEFORE `error` IS EVEN LOOKED AT. postgrest-js does not rethrow an
    // aborted request to us — it catches it and synthesizes an error object, so
    // an abort arrives down the ORDINARY error path looking like any other
    // failure. Testing the sentinel first is what keeps it out of the classifier.
    if (timedOut) {
      return { ok: false, failure: timeoutFailure() };
    }

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
    // The same check on the throwing path, for any host whose fetch rejects an
    // aborted request outright rather than resolving it.
    return { ok: false, failure: timedOut ? timeoutFailure() : toSubmissionFailure(thrown) };
  } finally {
    // Always. A settled request must not leave a timer alive that would abort
    // nothing and keep the event loop busy.
    clearTimeout(timer);
  }
}

/**
 * What our own timeout means: WE DO NOT KNOW.
 *
 * Not `transport`, which asserts the request never arrived, and not
 * `server_rejected`, which asserts it was refused. The server may have committed
 * this sale and lost the response to us, or may never have seen it — and the
 * only honest classification of that is the one the idempotency key exists to
 * resolve on the next attempt.
 */
function timeoutFailure(): SubmissionFailure {
  return { transport: "unknown", message: SALE_TIMEOUT_MESSAGE, timedOut: true };
}
