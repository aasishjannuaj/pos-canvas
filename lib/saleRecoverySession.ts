// G-1-CLIENT-1 — finishing an uncertain sale under its ORIGINAL identity and
// attribution: the glue between the marker, the queue and the server.
//
// Thin, like lib/saleQueueSession.ts and lib/uncertainSaleSession.ts. Every
// rule lives in lib/saleRecovery.ts; every byte of storage in the session
// modules; every request in lib/saleRecoveryRpc.ts. The network calls are
// INJECTED so a test can model a lost response, a missing function or an
// unreadable answer without a server.
//
// THE ONE SEQUENCE THIS MODULE OWNS, and why it is this way round:
//
//   online:  lookup -> decide -> (recorded | online strict | queue strict)
//   offline:          decide -> (queue strict | protected)
//
// and in every branch the marker is cleared ONLY after an authoritative
// resolution (a validated receipt, a validated lookup match) or a VERIFIED,
// durable transfer of its protection to the matching strict queue record.
// Anything else leaves it exactly where it is.
import {
  RECOVERY_PROTECTED_MESSAGES,
  decideAfterLookup,
  decideOfflineRecovery,
  strictClaimsFromMarker,
  verifyQueueTransfer,
} from "@/lib/saleRecovery";
import type {
  CurrentOperator,
  LookupOrderSummary,
  ProtectedReason,
  RecoveryStep,
} from "@/lib/saleRecovery";
import { lookupDeviceSale, submitSaleRecovery } from "@/lib/saleRecoveryRpc";
import type { RecoveryCallFailure } from "@/lib/saleRecoveryRpc";
import { enqueueSale, getSaleByRequestId } from "@/lib/saleQueueSession";
import type { QueuedSale } from "@/lib/saleQueue";
import { resolveUncertainSale } from "@/lib/uncertainSaleSession";
import type { PersistedUncertainSale } from "@/lib/uncertainSaleRecord";
import type { CompletedSaleReceipt } from "@/lib/completedSale";
import { classifySaleAttributionFailure } from "@/lib/posGate";
import { createSaleRequestId } from "@/lib/saleRequest";

// ---------------------------------------------------------------------------
// Transfer into the queue
// ---------------------------------------------------------------------------

export type QueueTransferResult =
  | { ok: true; record: QueuedSale; markerCleared: boolean }
  | { ok: false; reason: "legacy" | "transfer_failed" | "transfer_conflict" };

/**
 * Moves a marker's protection into a STRICT-RECOVERY queue record.
 *
 *   1. enqueue — the original id, the original payload exactly as it was
 *      dispatched, the original session, register and first-attempt time;
 *   2. read it back and VERIFY it is that transfer (lib/saleRecovery.ts);
 *   3. only then clear the marker.
 *
 * NO LOSS WINDOW. Until step 2 passes the marker is untouched, so a crash, a
 * refused write or a mismatched existing record leaves the sale exactly as
 * protected as it was. A crash between 2 and 3 leaves both; startup
 * reconciliation runs the same verification and clears the marker then.
 *
 * IDEMPOTENT. A second transfer of the same marker finds its own verified
 * record and succeeds without writing; a DIFFERENT record holding the key is a
 * conflict and nothing is changed.
 */
export async function transferUncertainSaleToQueue(input: {
  marker: PersistedUncertainSale;
  queueRecordId: string;
  now: string;
}): Promise<QueueTransferResult> {
  const claims = strictClaimsFromMarker(input.marker);

  // A legacy marker has no originals. It is never queued under anybody else's.
  if (claims === null) {
    return { ok: false, reason: "legacy" };
  }

  const marker = input.marker;

  const enqueued = await enqueueSale({
    saleRequestId: marker.saleRequestId,
    queueRecordId: input.queueRecordId,
    deviceAuthUserId: marker.deviceAuthUserId,
    deviceId: marker.deviceId,
    projectId: marker.projectId,
    buildJobId: marker.buildJobId,
    paymentMethod: marker.paymentMethod,
    items: marker.items,
    occurredAt: claims.originalAttemptAt,
    now: input.now,
    strictRecovery: claims,
  });

  if (!enqueued.ok && enqueued.reason !== "duplicate_sale_request") {
    return { ok: false, reason: "transfer_failed" };
  }

  // THE READ-BACK IS THE PROOF, for a fresh write and a duplicate alike. A
  // write that reported success is verified as stored; a key that was already
  // taken is accepted only if what holds it is this exact transfer.
  const stored = await getSaleByRequestId(marker.saleRequestId);

  if (!stored.ok) {
    return { ok: false, reason: "transfer_failed" };
  }

  if (!verifyQueueTransfer(marker, stored.value).ok) {
    return { ok: false, reason: enqueued.ok ? "transfer_failed" : "transfer_conflict" };
  }

  const markerCleared = await resolveUncertainSale();

  return { ok: true, record: stored.value, markerCleared };
}

// ---------------------------------------------------------------------------
// The recovery itself
// ---------------------------------------------------------------------------

export type SaleRecoveryOutcome =
  /** The server created or replayed it under the original attribution. */
  | { kind: "completed"; receipt: CompletedSaleReceipt; markerCleared: boolean }
  /** The server already had it, for this device and payload. No receipt. */
  | { kind: "recorded"; order: LookupOrderSummary; markerCleared: boolean }
  /** Durably transferred to a strict queue record. */
  | { kind: "queued"; record: QueuedSale; markerCleared: boolean }
  /** Nothing could be done safely. The marker is untouched. */
  | {
      kind: "protected";
      reason: ProtectedReason;
      message: string;
      /** ONLY a positively classified transport failure. */
      connectionLost: boolean;
    };

export type SaleRecoveryDeps = {
  lookup: typeof lookupDeviceSale;
  recover: typeof submitSaleRecovery;
  transfer: typeof transferUncertainSaleToQueue;
  resolveMarker: () => Promise<boolean>;
  newQueueRecordId: () => string;
  now: () => string;
};

const defaultDeps: SaleRecoveryDeps = {
  lookup: lookupDeviceSale,
  recover: submitSaleRecovery,
  transfer: transferUncertainSaleToQueue,
  resolveMarker: resolveUncertainSale,
  // The same generator every other sale identity comes from: it throws rather
  // than fall back to anything weaker. A local handle only; never sent.
  newQueueRecordId: () => createSaleRequestId(),
  now: () => new Date().toISOString(),
};

function protectedOutcome(reason: ProtectedReason, connectionLost = false): SaleRecoveryOutcome {
  return {
    kind: "protected",
    reason,
    message: RECOVERY_PROTECTED_MESSAGES[reason],
    connectionLost,
  };
}

/** A call that produced no validated answer, as a protected outcome. */
function fromCallFailure(failure: RecoveryCallFailure): SaleRecoveryOutcome {
  if (failure.failure === "missing") return protectedOutcome("recovery_unavailable");
  if (failure.failure === "transport" && !failure.timedOut) {
    return protectedOutcome("connection_lost", true);
  }
  if (failure.failure === "rejected" && !failure.timedOut) {
    return protectedOutcome("server_rejected");
  }

  return protectedOutcome("unknown_outcome");
}

/**
 * The online refusals that mean "this context moved", not "this sale is bad":
 * the employee or register the online path needs is no longer the one open.
 * Proven harmless only because PostgreSQL raised (nothing committed), and the
 * answer to them is the historical-claim path under the same originals.
 */
const ONLINE_ROUTE_REFUSALS = new Set(["Only the original employee can recover this sale online"]);

function isContextMovedRefusal(failure: RecoveryCallFailure): boolean {
  if (failure.failure !== "rejected" || !failure.rolledBack || failure.message === null) {
    return false;
  }

  return (
    ONLINE_ROUTE_REFUSALS.has(failure.message) ||
    classifySaleAttributionFailure(failure.message) !== null
  );
}

/**
 * Finishes an outstanding uncertain sale, or explains why it cannot.
 *
 * NEVER MINTS AN ID and NEVER CALLS complete_sale_v5. Attribution is the
 * marker's originals throughout; `current` only decides whether the online
 * path is available, which the server itself enforces again.
 */
export async function recoverOutstandingSale(
  input: {
    marker: PersistedUncertainSale;
    online: boolean;
    current: CurrentOperator | null;
  },
  overrides: Partial<SaleRecoveryDeps> = {}
): Promise<SaleRecoveryOutcome> {
  const deps: SaleRecoveryDeps = { ...defaultDeps, ...overrides };
  const marker = input.marker;

  let step: RecoveryStep;

  if (!input.online) {
    step = decideOfflineRecovery(marker);
  } else {
    const looked = await deps.lookup({
      saleRequestId: marker.saleRequestId,
      paymentMethod: marker.paymentMethod,
      tipAmount: marker.tipAmount,
      items: marker.items,
      originalEmployeePosSessionId: marker.originalAttribution?.employeePosSessionId ?? null,
      originalRegisterSessionId: marker.originalAttribution?.registerSessionId ?? null,
    });

    if (looked.kind === "failed") {
      // An attributed marker can still be made safe without the server: the
      // strict queue carries the originals and syncs when it can. A lost
      // connection is the only lookup failure that permits it — anything the
      // server ANSWERED (a refusal, a missing function) is not a reason to
      // route around it.
      if (looked.failure === "transport" && !looked.timedOut && marker.originalAttribution !== null) {
        step = { step: "queue_strict" };
      } else {
        return fromCallFailure(looked);
      }
    } else {
      step = decideAfterLookup(marker, looked.answer, input.current);
    }
  }

  return runStep(step, input, deps);
}

async function runStep(
  step: RecoveryStep,
  input: { marker: PersistedUncertainSale; current: CurrentOperator | null },
  deps: SaleRecoveryDeps
): Promise<SaleRecoveryOutcome> {
  const marker = input.marker;

  switch (step.step) {
    case "protected":
      return protectedOutcome(step.reason);

    case "resolve_recorded": {
      const markerCleared = await deps.resolveMarker();

      return { kind: "recorded", order: step.order, markerCleared };
    }

    case "queue_strict": {
      const transferred = await deps.transfer({
        marker,
        queueRecordId: deps.newQueueRecordId(),
        now: deps.now(),
      });

      if (transferred.ok) {
        return { kind: "queued", record: transferred.record, markerCleared: transferred.markerCleared };
      }

      return protectedOutcome(
        transferred.reason === "legacy"
          ? "legacy_unresolvable"
          : transferred.reason === "transfer_conflict"
            ? "transfer_conflict"
            : "transfer_failed"
      );
    }

    case "online_strict": {
      const original = marker.originalAttribution;
      const current = input.current;

      // decideAfterLookup only routes here with both present; restated so the
      // call below can never be built from anything else.
      if (original === null || current === null) {
        return protectedOutcome("legacy_unresolvable");
      }

      const recovered = await deps.recover({
        saleRequestId: marker.saleRequestId,
        paymentMethod: marker.paymentMethod,
        tipAmount: marker.tipAmount,
        items: marker.items,
        originalEmployeePosSessionId: original.employeePosSessionId,
        originalRegisterSessionId: original.registerSessionId,
        source: "online",
        currentEmployeePosSessionId: current.employeePosSessionId,
      });

      if (recovered.kind === "failed") {
        // PostgreSQL refused because the online context moved (the employee or
        // register is no longer the one open). Nothing committed, so the same
        // sale goes to the historical-claim path under the SAME originals.
        if (isContextMovedRefusal(recovered)) {
          return runStep({ step: "queue_strict" }, input, deps);
        }

        return fromCallFailure(recovered);
      }

      const answer = recovered.answer;

      switch (answer.status) {
        case "created":
        case "replayed": {
          const markerCleared = await deps.resolveMarker();

          return { kind: "completed", receipt: answer.receipt, markerCleared };
        }
        case "attribution_conflict":
          return protectedOutcome("attribution_conflict");
        case "not_this_device":
          return protectedOutcome("not_this_device");
        case "malformed":
          return protectedOutcome("malformed_response");
      }
    }
  }
}
