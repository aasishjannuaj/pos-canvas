// Feature 24.5E — what the cashier is told about saved sales, and when this
// device may be reset.
//
// PURE. Counts in, sentences out. The counts themselves come from
// lib/saleQueue.ts's summarizeQueue plus the quarantined list
// lib/saleQueueSession.ts already reports; nothing here reads storage.
//
// TWO RULES SHAPE EVERY LINE OF COPY BELOW.
//
// First, NO TECHNICAL VOCABULARY. A cashier does not have "records in
// needs_attention" or "a queue"; they have sales that are saved and sales that
// someone needs to look at. The words "queue", "sync engine", "IndexedDB",
// "record" and "state" do not appear in anything an operator reads.
//
// Second, NOTHING IS PRESENTED AS DONE UNTIL THE SERVER SAYS SO. A sale that
// needs attention is never counted as synced, never folded into a reassuring
// total, and never hidden — see docs/OFFLINE_ARCHITECTURE.md §17.
import type { QueueSummary, QueuedSale } from "@/lib/saleQueue";
import { parseIsoTime } from "@/lib/deviceOfflineCache";

export type OfflineSaleStatus = {
  /** Saved here, still on its way to the server. Nothing is wrong with these. */
  waiting: number;
  /** Someone has to look at these. Includes records that no longer read back. */
  needsAttention: number;
  /** Accepted by the server. */
  synced: number;
  /** Everything not yet in the books — the number that governs reset safety. */
  unsynced: number;
  total: number;
  /**
   * Feature 24.5F (DEF-02) — ISO instant of the earliest PERSISTED retry, or
   * null when nothing is scheduled. What a host schedules one timer against.
   */
  nextRetryAt: string | null;
  /**
   * Feature 24.5F — an ONLINE request was dispatched and never answered, and
   * its idempotency key is still on disk unresolved.
   *
   * Not a queue record and deliberately not counted as one: it is not waiting
   * to sync, and telling a cashier "1 sale waiting" about a sale that may
   * already be in the books would be a different lie from the one it prevents.
   * It governs reset safety, because that key may be the only proof an order
   * exists.
   */
  uncertainOnlineSale: boolean;
};

/**
 * Folds the queue's own summary, plus anything that failed to parse, into the
 * three numbers an operator can act on.
 *
 * A QUARANTINED RECORD COUNTS AS NEEDING ATTENTION, not as lost. It is money
 * someone took, sitting in a row this device can no longer read; the honest
 * thing is to say a sale needs attention, and the dangerous thing would be to
 * let it vanish from every count and therefore from every safeguard.
 */
export function toOfflineSaleStatus(
  summary: QueueSummary,
  quarantined: number = 0,
  nextRetryAt: string | null = null,
  uncertainOnlineSale: boolean = false
): OfflineSaleStatus {
  const waiting = summary.pending + summary.syncing;
  const needsAttention = summary.needsAttention + summary.permanentFailure + quarantined;

  return {
    waiting,
    needsAttention,
    synced: summary.synced,
    unsynced: waiting + needsAttention,
    total: summary.total + quarantined,
    nextRetryAt,
    uncertainOnlineSale,
  };
}

/**
 * The earliest moment a queued sale is due to be tried again.
 *
 * ONLY RECORDS THAT HAVE ALREADY FAILED COUNT, and that restriction is the
 * whole design. A freshly queued sale has nextAttemptAt = null, meaning "try
 * whenever you next drain" — it has no due time, and treating null as "due now"
 * would wake the engine the instant a sale is taken. On a till that is still
 * offline that is a guaranteed failed submission, burning one of the ten
 * attempts against a network everyone knows is down. Fresh records are reached
 * by the startup, reconnect and manual triggers, which is exactly right: those
 * fire when something actually changed.
 *
 * `syncing` records are excluded too — one is in flight, and a timer for it
 * would be a second submission of the same sale. needs_attention,
 * permanent_failure and synced have nothing to retry by definition.
 *
 * Pure, so a host can schedule against it and a test can assert it without a
 * clock, a timer or a database.
 */
export function earliestRetryAt(records: readonly QueuedSale[]): string | null {
  let earliest: string | null = null;

  for (const record of records) {
    if (record.state !== "pending" || record.nextAttemptAt === null) {
      continue;
    }

    // Unparseable is not scheduled here. isDueForAttempt already treats such a
    // record as due, so a drain will pick it up; inventing a timer instant from
    // a value nobody can read would be worse than leaving it to that.
    if (parseIsoTime(record.nextAttemptAt) === null) {
      continue;
    }

    if (earliest === null || record.nextAttemptAt < earliest) {
      earliest = record.nextAttemptAt;
    }
  }

  return earliest;
}

function pluralSales(count: number): string {
  return count === 1 ? "1 sale" : `${count} sales`;
}

/**
 * The cashier's status lines, in priority order. Empty when there is nothing
 * to say — the normal case must not nag.
 *
 * Counts, never percentages: a number of sales is a real quantity, and a
 * synthetic progress bar over a handful of records would be an invention
 * (docs/OFFLINE_ARCHITECTURE.md §17).
 */
export function describeOfflineSaleStatus(status: OfflineSaleStatus): string[] {
  const lines: string[] = [];

  if (status.waiting > 0) {
    lines.push(`${pluralSales(status.waiting)} waiting to sync`);
  }

  if (status.needsAttention > 0) {
    lines.push(
      status.needsAttention === 1 ? "1 sale needs attention" : `${status.needsAttention} sales need attention`
    );
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Reset / unpair safety
// ---------------------------------------------------------------------------

export type DeviceResetSafety =
  | { allowed: true }
  | { allowed: false; unsynced: number; message: string };

/**
 * Whether this device may be reset back to the pairing screen.
 *
 * APPROVED RULE (owner, Feature 24.4 review, docs/OFFLINE_ARCHITECTURE.md §15):
 * a reset is BLOCKED while any sale on this device has not reached the server.
 * Queued sales are never silently deleted, and a reset that quietly dropped
 * them would be the worst bug this feature could ship — so it is ruled out by
 * a decision rather than left to care.
 *
 * SYNCED SALES ALONE DO NOT BLOCK. Once the server has recorded a sale, this
 * device is holding a copy, not the only copy, and reconciliation data
 * (the order number and the server's timestamp) is stored alongside it.
 *
 * SALES THAT NEED ATTENTION BLOCK HARDEST. They are the ones a person still has
 * to resolve, and they are exactly the evidence a reset would destroy.
 *
 * The message NAMES THE COUNT, deliberately: §15 requires that any path near
 * discarding sales states how many there are. A future explicit "discard N
 * unsynced sales" confirmation is out of scope here and stays deferred; this
 * function only ever refuses.
 */
export function decideDeviceResetSafety(status: OfflineSaleStatus): DeviceResetSafety {
  // Feature 24.5F — an unresolved online request blocks a reset on its own.
  //
  // It is not a queued sale and there is no count to quote, but it is the same
  // category of thing: the only copy of an idempotency key for money that may
  // already have moved. Resetting past it would leave a possibly-committed
  // order with nothing on this device able to identify it, and the next sale
  // free to duplicate it.
  //
  // Checked FIRST so its message is the one shown; a till in this state needs a
  // connection, not a count.
  if (status.uncertainOnlineSale) {
    return {
      allowed: false,
      unsynced: status.unsynced,
      message:
        "A sale on this device may already have gone through, and this device still holds the only record of it. Connect to the internet and finish that sale before resetting.",
    };
  }

  if (status.unsynced === 0) {
    return { allowed: true };
  }

  return {
    allowed: false,
    unsynced: status.unsynced,
    message: `This device still has ${pluralSales(
      status.unsynced
    )} saved on it that ${status.unsynced === 1 ? "has" : "have"} not reached POS Canvas yet. Connect to the internet and let ${
      status.unsynced === 1 ? "it" : "them"
    } sync before resetting this device.`,
  };
}
