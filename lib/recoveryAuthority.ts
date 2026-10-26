// v1.3 CP-2B — "the store did not answer" is not "the store is empty".
//
// WHY THIS EXISTS BESIDE lib/uncertainSaleSession.ts RATHER THAN INSIDE IT.
// readUncertainSale reports storage trouble as `{ status: "none" }`, and its own
// comment says so deliberately: a device with no IndexedDB cannot have armed
// anything, so for the question that function answers, nothing is missed.
//
// That reasoning does not carry to the question asked here. Authorizing a NEW
// sale needs proof that no earlier request is outstanding, and a read that
// failed proves nothing at all. Collapsing the two is exactly how a till sells
// again over an order that may already exist on the server.
//
// SAME STORE, SAME RECORD, SAME IDENTITY, SAME PARSER. This is not a second
// recovery system and it owns no state: it composes the very primitives
// uncertainSaleSession composes, in the same order, and differs only in what it
// does with a failure. uncertainSaleSession is unchanged.
//
// READ-ONLY, ABSOLUTELY. Nothing here writes, deletes, resolves, enqueues,
// arms or dispatches. It opens the database, reads one key, closes it, and
// returns a verdict.

import { openOfflineDb, readUncertainSaleRecordRaw } from "@/lib/deviceOfflineStore";
import { readQueueRecoveryProtection } from "@/lib/saleQueueSession";
import {
  ownsUncertainSale,
  readUncertainSaleRecord,
  toUncertainSale,
} from "@/lib/uncertainSaleRecord";
import type { UncertainSaleIdentity } from "@/lib/uncertainSaleRecord";
import type { UncertainSale } from "@/lib/saleSubmission";

/**
 * Why a recovery read cannot authorize a sale.
 *
 * Each of these was `{ status: "none" }` before, and `none` read as permission.
 */
export type RecoveryBlockedReason =
  /** The database could not be opened at all. */
  | "storage_unavailable"
  /** It opened, but the record read did not succeed. */
  | "read_failed"
  /** Something IS stored and cannot be understood. Not absence. */
  | "unreadable"
  /** A record belonging to a different pairing, project or build. */
  | "identity_mismatch"
  /**
   * G-1-CLIENT-1A — a strict-recovery queue record carries an unresolved
   * conflict (recoveryProtection). The marker may be long gone — the sale was
   * transferred — but the conflict is not resolved, so no new checkout.
   */
  | "recovery_conflict"
  /** G-1-CLIENT-1A — a queue row that looks like strict recovery state cannot be read. */
  | "unreadable_recovery_record";

/**
 * What the durable recovery store actually said.
 *
 * `pending` IS NOT `verified_clear`, AND THAT IS THE WHOLE TYPE. Before this
 * module the runtime received a nullable UncertainSale, so "not read yet",
 * "read, and empty", "read failed" and "belongs to someone else" all arrived as
 * `null`. Only `verified_clear` is permission to start a new sale, and it is
 * produced by exactly one path: a successful read that found nothing.
 */
export type RecoveryAuthority =
  | { status: "pending" }
  | { status: "verified_clear" }
  | { status: "outstanding"; sale: UncertainSale }
  | { status: "blocked"; reason: RecoveryBlockedReason };

/** The value a host should hold before its first read completes. */
export const PENDING_RECOVERY_AUTHORITY: RecoveryAuthority = { status: "pending" };

/**
 * May a genuinely new sale begin?
 *
 * Pure, and separate from the read so the fencing rule can be proven without a
 * database. `outstanding` is NOT decided here: decideUncertainSale already owns
 * that, keyed on the sale fingerprint, and a second authority on one question
 * is how a till ends up both blocked and sellable.
 */
export function recoveryPermitsNewSale(authority: RecoveryAuthority): boolean {
  return authority.status === "verified_clear";
}

/**
 * Reads the outstanding request for one pairing, without collapsing failures.
 *
 * ONE READ, NOT TWO. Probing storage health separately and then reading would
 * be two observations of something that can change between them; a single read
 * reports what was true at one instant.
 */
export async function readRecoveryAuthority(
  identity: UncertainSaleIdentity
): Promise<RecoveryAuthority> {
  const marker = await readMarkerAuthority(identity);

  // Anything the marker already refuses stays refused.
  if (marker.status === "blocked") return marker;

  // G-1-CLIENT-1A — THE QUEUE IS THE SECOND SOURCE OF PROTECTION. After a
  // verified transfer the marker is deleted, so the marker alone would read
  // verified_clear while the transferred sale sits in an unresolved recovery
  // conflict. The fence now also requires the queue to hold no such conflict —
  // and, as everywhere in this file, a read that failed is not "nothing there".
  const queue = await readQueueRecoveryProtection();

  if (queue === "protected") return { status: "blocked", reason: "recovery_conflict" };
  // G-1-CLIENT-1B — a strict submission IN FLIGHT is deliberately NOT cached
  // here. This answer is cached until the next refresh, and a transient state
  // cached that way goes stale the moment the submission ends (it showed a
  // "being sent" refusal after the recovery had already filed its conflict).
  // In-flight activity is enforced where it is re-read every time: the final
  // checkout gates (lib/recoveryCheckoutCoordinator.ts).
  if (queue === "unreadable") return { status: "blocked", reason: "unreadable_recovery_record" };
  if (queue === "read_failed") return { status: "blocked", reason: "read_failed" };

  return marker;
}

async function readMarkerAuthority(identity: UncertainSaleIdentity): Promise<RecoveryAuthority> {
  const opened = await openOfflineDb();

  if (!opened.ok) {
    return { status: "blocked", reason: "storage_unavailable" };
  }

  try {
    const raw = await readUncertainSaleRecordRaw(opened.value);

    // THE LINE THIS MODULE EXISTS FOR. readUncertainSale returns "none" here.
    if (!raw.ok) {
      return { status: "blocked", reason: "read_failed" };
    }

    const parsed = readUncertainSaleRecord(raw.value);

    if (!parsed.ok) {
      // "missing" is the ONLY proof of absence accepted anywhere in this file.
      // A malformed or unsupported record means something is there.
      return parsed.reason === "missing"
        ? { status: "verified_clear" }
        : { status: "blocked", reason: "unreadable" };
    }

    // The FULL pairing identity, not just the device: a record from another
    // project or another build is not this till's to act on, and never this
    // till's to delete either.
    if (!ownsUncertainSale(parsed.record, identity)) {
      return { status: "blocked", reason: "identity_mismatch" };
    }

    // The original saleRequestId travels through untouched. A recovered sale
    // must be replayed under the key that was dispatched, never a fresh one.
    return { status: "outstanding", sale: toUncertainSale(parsed.record) };
  } catch {
    // A throw mid-transaction is a failed read, not an empty store.
    return { status: "blocked", reason: "read_failed" };
  } finally {
    opened.value.close();
  }
}
