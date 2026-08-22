// Feature 24.5C — the durable offline sale queue's PURE core.
//
// WHAT THIS MODULE IS: the shape of a queued sale, the rules for what a valid
// one looks like, and the state machine it moves through — all as functions
// with no IndexedDB, no React and no Supabase. lib/deviceOfflineStore.ts does
// the storage I/O; lib/saleQueueSession.ts joins the two. Every rule here is
// exercised under plain Node.
//
// WHAT A QUEUED SALE IS: a financial record of money that has already changed
// hands. It is NOT a draft, NOT a cart, and NOT editable. Once enqueued its
// contents are frozen — editing one would change the canonical preimage
// complete_sale_v4 hashes, which is the same thing as voiding a sale and
// creating a different one.
//
// WHAT 24.5C DOES NOT DO, and 24.5D will: submit anything. Nothing here opens a
// network connection, and no client enqueues yet — the offline checkout fence
// from 24.5A is untouched. This feature builds the durable floor that a sync
// engine can later stand on.
import type { PaymentMethod } from "@/lib/cart";
import { isValidSaleRequestId } from "@/lib/saleRequest";
import { parseIsoTime } from "@/lib/deviceOfflineCache";

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/**
 * The version of the queued-record envelope below.
 *
 * Separate from OFFLINE_CACHE_SCHEMA_VERSION, which versions the config cache,
 * and separate again from the IndexedDB version. They change for unrelated
 * reasons. A record written by a NEWER envelope is refused rather than read
 * optimistically — a half-understood sale must never be submitted.
 */
export const SALE_QUEUE_SCHEMA_VERSION = 1 as const;

/**
 * The shape of the request this record will eventually be submitted as.
 *
 * Pinned separately from the envelope because it tracks the SERVER contract
 * (complete_sale_v4's parameters), not this file's storage format. If the RPC
 * ever gains a parameter, records queued under the old payload version must be
 * recognisable as such rather than silently sent with a missing field.
 */
export const SALE_REQUEST_PAYLOAD_VERSION = 4 as const;

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/** One cart line, in exactly the shape complete_sale_v4 accepts. */
export type QueuedSaleItem = {
  itemId: string;
  quantity: number;
  modifiers: { groupId: string; optionIds: string[] }[];
};

export type QueueState =
  | "pending"
  | "syncing"
  | "synced"
  | "needs_attention"
  /**
   * Feature 24.5F — an authoritatively REJECTED sale an operator has resolved
   * by hand, on purpose.
   *
   * NOT A DELETE, and not a synonym for "synced". The record stays on the
   * device with everything it always held; what changes is that it stops being
   * unresolved, so it no longer blocks a reset and no longer asks a cashier to
   * do something about it. The distinction matters because "synced" asserts the
   * server has this sale — and the whole point of a discarded record is that
   * the server refused it and never will.
   *
   * Reachable ONLY from needs_attention, and only through the policy in
   * lib/rejectedSaleResolution.ts.
   */
  | "discarded"
  | "permanent_failure";

export const QUEUE_STATES: readonly QueueState[] = [
  "pending",
  "syncing",
  "synced",
  "needs_attention",
  "discarded",
  "permanent_failure",
] as const;

/**
 * A sale that happened offline and is waiting to reach the server.
 *
 * EVERY FIELD NEEDED TO CALL complete_sale_v4 IS HERE, deliberately. 24.5D must
 * be able to submit this record without consulting a cart, a React state tree
 * or anything else mutable — the money was taken at a particular moment with a
 * particular menu, and nothing that happens afterwards may change what is sent.
 *
 * WHAT IS DELIBERATELY ABSENT: prices. Not the unit price, not the line total,
 * not the order total. complete_sale_v4 prices from the pinned build snapshot
 * and ignores anything a client sends, so storing an amount here would create a
 * number that looks authoritative, is never used, and would eventually be
 * trusted by someone. A provisional receipt in 24.5E recomputes from the cached
 * pinned config — the same single source of truth the server uses.
 *
 * ALSO ABSENT, and permanently: any card data. See the security note in the
 * module header of lib/saleQueueSession.ts.
 */
export type QueuedSale = {
  queueSchemaVersion: number;
  requestPayloadVersion: number;

  /** Primary key. Local to this device; never sent to the server. */
  queueRecordId: string;

  /**
   * The idempotency key, generated ONCE before this record is durable and never
   * regenerated. Unique-indexed so two records cannot claim the same sale.
   */
  saleRequestId: string;

  /** Authorization + pricing identity, captured at enqueue time. */
  deviceAuthUserId: string;
  deviceId: string;
  projectId: string;
  buildJobId: string;

  /** The request itself. */
  paymentMethod: PaymentMethod;
  tipAmount: number;
  items: QueuedSaleItem[];
  occurredAt: string;
  source: "offline_queued";

  /** Sync state. */
  state: QueueState;
  queuedAt: string;
  updatedAt: string;
  attemptCount: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;

  /**
   * Feature 24.5D — the server's identity for this sale, once it has one.
   *
   * ADDITIVE AND OPTIONAL, so the envelope version does not move: a record
   * written before these existed reads back with them null, which is exactly
   * what "not synced yet" means anyway. Nothing has ever enqueued in
   * production, so this costs no migration — but the shape is chosen so it
   * would not have, either.
   *
   * Kept AFTER sync rather than discarded because 24.5E has to reconcile a
   * provisional receipt against the real order number, and the operator holding
   * a paper slip needs that mapping to exist somewhere.
   */
  serverOrderId: string | null;
  serverOrderNumber: string | null;
  serverCreatedAt: string | null;
};

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

/**
 * Legal transitions, exhaustively.
 *
 *   pending          -> syncing                         a sync attempt starts
 *   syncing          -> pending                          retriable failure, or
 *                                                        startup recovery
 *   syncing          -> synced                           the server recorded it
 *   syncing          -> needs_attention                  a person must resolve it
 *   syncing          -> permanent_failure                replay is impossible
 *   needs_attention  -> pending                          manual retry
 *   needs_attention  -> discarded                        operator resolved it
 *   needs_attention  -> permanent_failure                escalated
 *
 * TERMINAL, with no way back:
 *   synced             the server owns this sale now. Re-queueing it would
 *                      invite a second submission of money already recorded.
 *   permanent_failure  a hash conflict or a corrupt record. Retrying blindly
 *                      cannot help and could double-submit.
 *   discarded          the server authoritatively refused this sale and a
 *                      person chose to resolve it locally. Re-queueing it would
 *                      ask the server the question it has already answered.
 *
 * A transition to the SAME state is refused rather than treated as a no-op, so
 * a caller that believes it is advancing the machine always learns it is not.
 */
export const QUEUE_TRANSITIONS: Readonly<Record<QueueState, readonly QueueState[]>> = {
  pending: ["syncing"],
  syncing: ["pending", "synced", "needs_attention", "permanent_failure"],
  needs_attention: ["pending", "discarded", "permanent_failure"],
  synced: [],
  discarded: [],
  permanent_failure: [],
} as const;

/** States a record can never leave. */
export const TERMINAL_QUEUE_STATES: readonly QueueState[] = [
  "synced",
  "discarded",
  "permanent_failure",
];

export function isQueueState(value: unknown): value is QueueState {
  return typeof value === "string" && (QUEUE_STATES as readonly string[]).includes(value);
}

export function canTransition(from: QueueState, to: QueueState): boolean {
  return QUEUE_TRANSITIONS[from].includes(to);
}

export type TransitionResult =
  | { ok: true; record: QueuedSale }
  | { ok: false; reason: "illegal_transition"; from: QueueState; to: QueueState };

/**
 * Applies a state change, returning a NEW record.
 *
 * Immutable on purpose: a caller holding the old record cannot accidentally
 * observe a half-updated one, and the returned value is what gets persisted.
 */
export function transitionQueuedSale(
  record: QueuedSale,
  to: QueueState,
  now: string,
  patch: Partial<
    Pick<QueuedSale, "lastErrorCode" | "lastErrorMessage" | "nextAttemptAt">
  > = {}
): TransitionResult {
  if (!canTransition(record.state, to)) {
    return { ok: false, reason: "illegal_transition", from: record.state, to };
  }

  return {
    ok: true,
    record: {
      ...record,
      state: to,
      updatedAt: now,
      lastErrorCode: patch.lastErrorCode ?? null,
      lastErrorMessage: patch.lastErrorMessage ?? null,
      nextAttemptAt: patch.nextAttemptAt ?? null,
    },
  };
}

/**
 * Records that an attempt was made. Separate from the transition so attempt
 * metadata survives a state change and cannot be reset by one.
 */
export function markQueuedSaleAttempt(record: QueuedSale, now: string): QueuedSale {
  return {
    ...record,
    attemptCount: record.attemptCount + 1,
    lastAttemptAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Startup recovery
// ---------------------------------------------------------------------------

/**
 * A record left in `syncing` when the process died.
 *
 * WHY RETURNING IT TO `pending` IS SAFE, and not a guess: the submission that
 * was in flight carried this record's saleRequestId, and complete_sale_v4 looks
 * that up before allocating an order number, mutating inventory or writing an
 * audit row. So one of two things is true — the server never received it, in
 * which case retrying creates it; or the server DID record it, in which case
 * retrying returns the existing order unchanged. Neither outcome can produce a
 * second sale, which is precisely why the idempotency key had to be durable
 * before the record was (see enqueue in lib/saleQueueSession.ts).
 *
 * Attempt metadata is preserved deliberately: the attempt genuinely happened,
 * and erasing it would let a record that keeps dying mid-sync retry forever
 * without ever reaching its cap.
 */
export function recoverInterruptedSale(record: QueuedSale, now: string): QueuedSale {
  if (record.state !== "syncing") {
    return record;
  }

  return { ...record, state: "pending", updatedAt: now };
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

export type QueueSummary = {
  pending: number;
  syncing: number;
  synced: number;
  needsAttention: number;
  /** Feature 24.5F — rejected sales an operator resolved deliberately. */
  discarded: number;
  permanentFailure: number;
  /** Everything not yet accepted by the server — what an operator cares about. */
  outstanding: number;
  total: number;
};

export function summarizeQueue(records: readonly QueuedSale[]): QueueSummary {
  const counts = {
    pending: 0,
    syncing: 0,
    synced: 0,
    needsAttention: 0,
    discarded: 0,
    permanentFailure: 0,
  };

  // EVERY STATE NAMED EXPLICITLY. This loop used to end in a bare `else` that
  // meant permanent_failure, which would have silently counted the new
  // `discarded` state as a failure needing attention — the exact opposite of
  // what resolving one is for. An exhaustive switch makes the next state
  // addition a compile error instead of a wrong number.
  for (const record of records) {
    switch (record.state) {
      case "pending":
        counts.pending += 1;
        break;
      case "syncing":
        counts.syncing += 1;
        break;
      case "synced":
        counts.synced += 1;
        break;
      case "needs_attention":
        counts.needsAttention += 1;
        break;
      case "discarded":
        counts.discarded += 1;
        break;
      case "permanent_failure":
        counts.permanentFailure += 1;
        break;
    }
  }

  return {
    ...counts,
    // permanent_failure is excluded: it is not waiting for anything, it is
    // waiting for a person. Counting it as "outstanding" would make a status
    // badge that never clears. `discarded` is excluded for the opposite reason
    // — a person has already dealt with it.
    outstanding: counts.pending + counts.syncing + counts.needsAttention,
    total: records.length,
  };
}

/**
 * Is this record due for another attempt?
 *
 * A persisted nextAttemptAt in the future is a backoff window the engine must
 * respect — including across a restart, which is the whole reason it is stored
 * rather than held in a timer. An unparseable value is treated as due, because
 * refusing to ever retry a sale over a bad timestamp would strand money.
 */
export function isDueForAttempt(record: QueuedSale, now: number): boolean {
  if (record.state !== "pending") return false;
  if (record.nextAttemptAt === null) return true;

  const due = Date.parse(record.nextAttemptAt);

  return Number.isFinite(due) ? due <= now : true;
}

/** FIFO: oldest sale first, ties broken by record id so the order is total. */
export function sortQueueFifo(records: readonly QueuedSale[]): QueuedSale[] {
  return [...records].sort((a, b) => {
    if (a.queuedAt !== b.queuedAt) return a.queuedAt < b.queuedAt ? -1 : 1;

    return a.queueRecordId < b.queueRecordId ? -1 : a.queueRecordId > b.queueRecordId ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type QueueReadFailure =
  | "missing"
  | "malformed"
  | "unsupported_schema"
  | "invalid_state"
  | "invalid_items"
  | "invalid_money";

export type QueueReadResult =
  | { ok: true; record: QueuedSale }
  | { ok: false; reason: QueueReadFailure };

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * A timestamp that can actually be reasoned about.
 *
 * Reuses parseIsoTime, the same reader the 24.5A lease uses, rather than a
 * second date parser with its own edge cases. A non-empty string is not enough
 * here: occurredAt is the value complete_sale_v4 checks against the 7-day
 * bound, the pairing floor and revoked_at, so "whenever" would enqueue happily
 * and then be rejected by the server forever.
 */
function isoTimestamp(value: unknown): string | null {
  return typeof value === "string" && parseIsoTime(value) !== null ? value : null;
}

/** Null is a legitimate value here; a present-but-unparseable one is not. */
function nullableIsoTimestamp(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, value: null };

  const parsed = isoTimestamp(value);

  return parsed === null ? { ok: false } : { ok: true, value: parsed };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Validates a record read back from storage.
 *
 * NOTHING IS INVENTED. A record missing a financial field is refused, never
 * defaulted: a sale whose payment method or item list cannot be read is not a
 * sale that can be submitted, and guessing would submit money under terms
 * nobody agreed to. Every refusal is surfaced to 24.5D as needs_attention —
 * see readQueuedSaleOrQuarantine in lib/saleQueueSession.ts.
 */
export function readQueuedSale(value: unknown): QueueReadResult {
  if (value === null || value === undefined) {
    return { ok: false, reason: "missing" };
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "malformed" };
  }

  const raw = value as Record<string, unknown>;

  if (
    raw.queueSchemaVersion !== SALE_QUEUE_SCHEMA_VERSION ||
    raw.requestPayloadVersion !== SALE_REQUEST_PAYLOAD_VERSION
  ) {
    return { ok: false, reason: "unsupported_schema" };
  }

  const queueRecordId = nonEmptyString(raw.queueRecordId);
  const deviceAuthUserId = nonEmptyString(raw.deviceAuthUserId);
  const deviceId = nonEmptyString(raw.deviceId);
  const projectId = nonEmptyString(raw.projectId);
  const buildJobId = nonEmptyString(raw.buildJobId);
  const occurredAt = isoTimestamp(raw.occurredAt);
  const queuedAt = isoTimestamp(raw.queuedAt);
  const updatedAt = isoTimestamp(raw.updatedAt);
  const lastAttemptAt = nullableIsoTimestamp(raw.lastAttemptAt);
  const nextAttemptAt = nullableIsoTimestamp(raw.nextAttemptAt);
  const serverCreatedAt = nullableIsoTimestamp(raw.serverCreatedAt);

  if (
    queueRecordId === null ||
    deviceAuthUserId === null ||
    deviceId === null ||
    projectId === null ||
    buildJobId === null ||
    occurredAt === null ||
    queuedAt === null ||
    updatedAt === null ||
    !lastAttemptAt.ok ||
    !nextAttemptAt.ok ||
    !serverCreatedAt.ok
  ) {
    return { ok: false, reason: "malformed" };
  }

  // THE IDEMPOTENCY KEY MUST BE A KEY THE SERVER WILL ACCEPT.
  // complete_sale_v4 declares p_sale_request_id as uuid and rejects the nil
  // uuid explicitly, so a record carrying anything else is unsubmittable from
  // the moment it is written — it would sit in the queue forever holding money
  // that can never be recorded. Reuses the same validator the online checkout
  // path already uses, rather than a second opinion about what a key is.
  if (!isValidSaleRequestId(raw.saleRequestId)) {
    return { ok: false, reason: "malformed" };
  }

  const saleRequestId = raw.saleRequestId;

  if (raw.source !== "offline_queued") {
    return { ok: false, reason: "malformed" };
  }

  if (!isQueueState(raw.state)) {
    return { ok: false, reason: "invalid_state" };
  }

  if (raw.paymentMethod !== "cash" && raw.paymentMethod !== "card") {
    return { ok: false, reason: "invalid_money" };
  }

  // Devices may not tip; complete_sale_v4 rejects a non-zero device tip
  // outright, so a record carrying one could never be submitted.
  if (typeof raw.tipAmount !== "number" || !Number.isFinite(raw.tipAmount) || raw.tipAmount !== 0) {
    return { ok: false, reason: "invalid_money" };
  }

  if (
    typeof raw.attemptCount !== "number" ||
    !Number.isInteger(raw.attemptCount) ||
    raw.attemptCount < 0
  ) {
    return { ok: false, reason: "malformed" };
  }

  const items = readQueuedItems(raw.items);

  if (items === null) {
    return { ok: false, reason: "invalid_items" };
  }

  return {
    ok: true,
    record: {
      queueSchemaVersion: SALE_QUEUE_SCHEMA_VERSION,
      requestPayloadVersion: SALE_REQUEST_PAYLOAD_VERSION,
      queueRecordId,
      saleRequestId,
      deviceAuthUserId,
      deviceId,
      projectId,
      buildJobId,
      paymentMethod: raw.paymentMethod,
      tipAmount: 0,
      items,
      occurredAt,
      source: "offline_queued",
      state: raw.state,
      queuedAt,
      updatedAt,
      attemptCount: raw.attemptCount,
      lastAttemptAt: lastAttemptAt.value,
      nextAttemptAt: nextAttemptAt.value,
      lastErrorCode: nullableString(raw.lastErrorCode),
      lastErrorMessage: nullableString(raw.lastErrorMessage),
      // Absent means "never synced", which is the ordinary case for every
      // record until the engine confirms one.
      serverOrderId: nullableString(raw.serverOrderId),
      serverOrderNumber: nullableString(raw.serverOrderNumber),
      // Held to the same bar as every other timestamp in this record.
      serverCreatedAt: serverCreatedAt.value,
    },
  };
}

function readQueuedItems(value: unknown): QueuedSaleItem[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const items: QueuedSaleItem[] = [];

  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }

    const raw = entry as Record<string, unknown>;
    const itemId = nonEmptyString(raw.itemId);

    if (itemId === null) return null;

    if (
      typeof raw.quantity !== "number" ||
      !Number.isInteger(raw.quantity) ||
      raw.quantity <= 0
    ) {
      return null;
    }

    const modifiers = readQueuedModifiers(raw.modifiers);

    if (modifiers === null) return null;

    items.push({ itemId, quantity: raw.quantity, modifiers });
  }

  return items;
}

function readQueuedModifiers(
  value: unknown
): { groupId: string; optionIds: string[] }[] | null {
  // Absent means "no modifiers", which is ordinary. Present-but-wrong is not.
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;

  const groups: { groupId: string; optionIds: string[] }[] = [];

  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;

    const raw = entry as Record<string, unknown>;
    const groupId = nonEmptyString(raw.groupId);

    if (groupId === null || !Array.isArray(raw.optionIds)) return null;

    const optionIds: string[] = [];

    for (const option of raw.optionIds) {
      const id = nonEmptyString(option);

      if (id === null) return null;

      optionIds.push(id);
    }

    groups.push({ groupId, optionIds });
  }

  return groups;
}
