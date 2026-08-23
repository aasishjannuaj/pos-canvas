// Feature 24.5D — deciding what a failed submission MEANS, and when to try again.
//
// PURE. No network, no storage, no timers. The engine asks two questions of
// this module — "should I retry, or does a person need to look at this?" and
// "when?" — and both answers are computed from values, so every branch is
// reachable in a test under plain Node.
//
// THE DEFAULT IS RETRY, and that is the opposite of the default in
// lib/deviceConnectivity.ts. The difference is what a wrong guess costs. There,
// an unknown meant "should this device open a cached POS?" and guessing yes
// would let a revoked till trade, so unknown failed closed. Here an unknown
// means "did that submission land?", and retrying is FREE because the sale
// carries a durable idempotency key: complete_sale_v4 resolves it before
// allocating an order number, mutating inventory or writing an audit row. So
// the expensive mistake is the other one — abandoning a sale that was never
// recorded. Unknown therefore retries, bounded by an attempt cap.
import { classifyDeviceFailure } from "@/lib/deviceConnectivity";

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

/**
 * Delay before attempt N+1, in milliseconds.
 *
 * 5s, 15s, 45s, 2m 15s, 6m 45s, then capped at 15 minutes. A x3 curve reaches a
 * sensible ceiling in five steps without hammering a server that is already
 * struggling, and the first step is short enough that an ordinary blip clears
 * before an operator notices.
 *
 * NO JITTER, deliberately. Jitter matters when many clients retry against one
 * server in lockstep; a till is one client with a handful of records, and the
 * cost here would be non-deterministic tests for a thundering herd that cannot
 * form. If fleet-wide retry storms ever become real, this is the one function
 * to change.
 */
export const SYNC_BACKOFF_BASE_MS = 5_000;
export const SYNC_BACKOFF_FACTOR = 3;
export const SYNC_BACKOFF_MAX_MS = 15 * 60 * 1000;

/**
 * How many attempts before a record stops retrying and asks for a person.
 *
 * At the curve above, ten attempts spans roughly an hour and a half of real
 * outage. Past that the problem is not a blip, and silently retrying forever
 * would hide a sale that needs attention behind a spinner.
 */
export const SYNC_MAX_ATTEMPTS = 10;

export function backoffDelayMs(attemptCount: number): number {
  if (attemptCount <= 0) return SYNC_BACKOFF_BASE_MS;

  const raw = SYNC_BACKOFF_BASE_MS * Math.pow(SYNC_BACKOFF_FACTOR, attemptCount - 1);

  return Math.min(raw, SYNC_BACKOFF_MAX_MS);
}

/** The ISO instant a record becomes eligible again. */
export function nextAttemptAtFrom(attemptCount: number, now: number): string {
  return new Date(now + backoffDelayMs(attemptCount)).toISOString();
}

// ---------------------------------------------------------------------------
// Known server answers
// ---------------------------------------------------------------------------

/**
 * EXACT server messages, not substrings.
 *
 * complete_sale_v4 raises business errors as message text rather than stable
 * SQLSTATEs, so this table is matched by equality against the strings the
 * migration actually raises. Every one below was observed on real PostgreSQL
 * during 24.5B staging validation.
 *
 * WHY NOT SUBSTRING MATCHING: several of v4's messages carry a `%` placeholder
 * interpolated at runtime ("Menu item burger is not available"). A substring
 * rule broad enough to catch those would also catch messages it was never
 * meant to, and mis-filing a sale is worse than not filing it — an unmatched
 * message falls through to needs_attention, which is safe.
 *
 * THIS IS TECHNICAL DEBT, recorded rather than hidden. A stable error-code
 * contract on the server would replace this table entirely; see
 * docs/OFFLINE_ARCHITECTURE.md.
 */
export const KNOWN_SERVER_ERRORS: Readonly<Record<string, string>> = {
  // Clock and lease — the device's own state is wrong, a person must resolve it.
  "Offline sale time is in the future": "clock_future",
  "Offline sale time predates this device": "clock_before_pairing",
  "Offline sale time is older than the offline limit": "lease_expired",
  "An offline sale must declare when it happened": "missing_occurred_at",
  "An online sale cannot declare its own sale time": "source_mismatch",

  // Authorization — the device is no longer allowed to record this.
  "Offline sale occurred after this device was revoked": "post_revocation",
  // Feature 25.1 — the device removed itself, and the server refused a NEW sale
  // because of it. A DEFINITE business answer, so needs_attention rather than a
  // retry: sending it again gets the same reply, and the pairing is gone.
  //
  // Deliberately its own code and NOT post_revocation. They look similar and
  // mean different things: post_revocation is the owner cutting a till off,
  // which is why it earns the temporal window and the local discard flow. This
  // one has neither, and must never inherit either by sharing a code.
  "This device is no longer paired": "device_unpaired",
  "Only a paired device can record an offline sale": "not_a_paired_device",
  "Project not found or access denied": "not_authorized",
  "This device is not linked to a usable build": "build_unavailable",
  "Authentication required": "not_authenticated",

  // Contract — the request itself is not acceptable.
  "Invalid sale source": "invalid_source",
  "Sale request ID was already used for a different order": "hash_conflict",
  "Tips are not supported on this device": "tip_rejected",
  "Invalid payment method": "invalid_payment_method",
  "A sale request ID is required": "missing_request_id",
  "Project ID is required": "missing_project_id",
  "At least one order item is required": "missing_items",
  "Invalid order item": "invalid_item",
  "Invalid quantity for an order item": "invalid_quantity",
  "Too many order items": "too_many_items",
  "Too many options for an order item": "too_many_options",
  "The same item and options appear more than once in this order": "duplicate_line",
  "Project configuration is invalid": "config_invalid",
  "Pricing configuration is invalid": "pricing_invalid",
} as const;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type SyncOutcome =
  | { outcome: "retry"; code: string }
  | { outcome: "needs_attention"; code: string }
  | { outcome: "permanent_failure"; code: string };

export type SubmissionFailure = {
  /** What lib/deviceConnectivity.ts made of the transport. */
  transport: "transport" | "server_rejected" | "unknown";
  message: string | null;
  /**
   * Feature 24.5F — THIS DEVICE stopped waiting. Set only by the submission
   * adapter's own timer (lib/offlineSaleRpc.ts) and never inferred from text.
   *
   * A flag rather than a fourth `transport` value because it does not describe
   * the transport at all: it says nothing about whether the request arrived,
   * which is precisely the point. `transport` is already "unknown" alongside it;
   * this only records WHY it is unknown, so a timed-out attempt can be told apart
   * from a genuinely unreadable answer in a queue record and in a log.
   */
  timedOut?: boolean;
};

/**
 * Decides what to do with a failed submission.
 *
 * ORDER MATTERS. Transport is checked first: if nothing answered, the message
 * text is meaningless and the sale is simply not delivered yet. Only once a
 * server has demonstrably replied does the message become evidence.
 *
 * NOTHING HERE RETURNS permanent_failure. Every server answer either retries or
 * asks for a person, because "retry and review cannot make this valid" is a
 * claim the server never actually makes — even a hash conflict is resolvable by
 * someone confirming the original order exists. permanent_failure is reserved
 * for a LOCAL structural impossibility, which the engine detects itself; see
 * classifyUnreadableRecord.
 */
export function classifySubmissionFailure(
  failure: SubmissionFailure,
  attemptCount: number,
  /**
   * Feature 24.5F — was this attempt asked for by a PERSON?
   *
   * A manual attempt may not be the one that escalates a no-answer failure into
   * needs_attention. SYNC_MAX_ATTEMPTS exists to detect a SUSTAINED OUTAGE — ten
   * attempts is roughly seventy minutes of the backoff curve — and that is a
   * statement about time, not about how many times a finger touched glass.
   *
   * Windows hardware found the hole: once manual Sync now was allowed to skip
   * the backoff, ten taps during an outage burned the entire budget in seconds
   * and filed a perfectly good sale as needing attention. The backoff had been
   * the only thing rate-limiting attempts, and nothing replaced it.
   *
   * IT DOES NOT MEAN "IGNORE THE SERVER". Only the three exhaustion families
   * below are affected. A business answer — post_revocation, invalid_item,
   * hash_conflict — classifies identically however it was triggered, because
   * that is the server deciding, not a counter running out.
   */
  options: { manual?: boolean } = {}
): SyncOutcome {
  const exhausted = attemptCount >= SYNC_MAX_ATTEMPTS && options.manual !== true;

  // FEATURE 24.5F — OUR OWN TIMEOUT, CHECKED FIRST AND ON ITS OWN FLAG.
  //
  // Deliberately ahead of every other branch, including the message table, so no
  // future edit to KNOWN_SERVER_ERRORS can reroute it. A timeout is an UNKNOWN
  // OUTCOME: the sale may be committed on the server with the response lost, or
  // may never have arrived. Retrying under the SAME persisted saleRequestId is
  // exactly what resolves that — complete_sale_v4 replays the existing order if
  // there is one and creates exactly one if there is not.
  //
  // Note what it is NOT: not `transport`, which would assert the request never
  // reached the server and is the evidence the offline-mode switch runs on.
  if (failure.timedOut === true) {
    return exhausted
      ? { outcome: "needs_attention", code: "timeout_attempts_exhausted" }
      : { outcome: "retry", code: "sale_timeout" };
  }

  if (failure.transport === "transport") {
    return exhausted
      ? { outcome: "needs_attention", code: "transport_attempts_exhausted" }
      : { outcome: "retry", code: "transport" };
  }

  const message = failure.message?.trim() ?? "";
  const known = message === "" ? undefined : KNOWN_SERVER_ERRORS[message];

  if (known !== undefined) {
    return { outcome: "needs_attention", code: known };
  }

  // The server answered with something not on the list, OR we could not tell
  // whether it answered at all.
  //
  // An unrecognised SERVER answer is a business error we have not catalogued —
  // filing it as needs_attention keeps the sale and surfaces it, which is the
  // conservative choice the message-text limitation forces.
  //
  // An UNKNOWN transport is the lost-response case, and retrying it is exactly
  // what the durable idempotency key exists for.
  if (failure.transport === "unknown") {
    return exhausted
      ? { outcome: "needs_attention", code: "unknown_attempts_exhausted" }
      : { outcome: "retry", code: "unknown_outcome" };
  }

  return { outcome: "needs_attention", code: "unrecognised_server_error" };
}

/**
 * The ONE case that is genuinely permanent.
 *
 * A stored record that no longer parses cannot be submitted — there is no
 * request to make — and no retry or review can turn unreadable bytes back into
 * a sale. It is still never deleted; permanent_failure means "stop trying",
 * not "discard".
 */
export function classifyUnreadableRecord(): SyncOutcome {
  return { outcome: "permanent_failure", code: "record_unreadable" };
}

/** Convenience: turn a thrown/returned RPC error into a SubmissionFailure. */
export function toSubmissionFailure(error: unknown): SubmissionFailure {
  const message =
    error !== null && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
      ? ((error as { message: string }).message)
      : null;

  return { transport: classifyDeviceFailure(error), message };
}
