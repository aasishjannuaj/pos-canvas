// Feature 24.5F — the durable record of an online sale whose outcome is unknown.
//
// WHAT THIS PROTECTS, stated once. complete_sale_v3 is dispatched; the response
// never arrives; the process dies. The order MAY exist on the server, and the
// only thing that can ever prove it — or safely replay it — is the
// sale_request_id that request carried. Held in React state, that key dies with
// the process, and the cashier rings the customer up again under a NEW key,
// which the server has no way to recognise as the same sale. Two orders, one
// customer.
//
// So the key is written to disk BEFORE the request leaves, and it survives
// anything short of the storage itself being destroyed.
//
// PURE. No IndexedDB, no React, no Supabase — lib/deviceOfflineStore.ts moves
// the bytes and lib/uncertainSaleSession.ts joins the two, exactly as
// lib/saleQueue.ts / lib/saleQueueSession.ts already do for queued sales.
//
// WHAT IT HOLDS AND WHAT IT MUST NEVER HOLD: identifiers, quantities, modifier
// selections, a "cash"/"card" LABEL, timestamps, and the identity of the till
// that owns it. No price of any kind — the server prices the sale on the
// original attempt and on the replay alike. No card number, CVV, expiry or
// cardholder name; POS Canvas never receives any of those. No session token and
// no Supabase credential. lib/offlineCheckout.guards.test.ts asserts all of it.
import type { PaymentMethod } from "@/lib/cart";
import { isValidSaleRequestId } from "@/lib/saleRequest";
import type { SaleSubmissionItem, UncertainSale } from "@/lib/saleSubmission";
import { parseIsoTime } from "@/lib/deviceOfflineCache";

/**
 * Version of THIS envelope. Separate from the cache and queue versions, which
 * change for unrelated reasons. A record written by a newer envelope is refused
 * rather than read optimistically — but see readUncertainSaleRecord for why a
 * refusal here still blocks the till instead of freeing it.
 */
export const UNCERTAIN_SALE_SCHEMA_VERSION = 1 as const;

/** The one key this record lives under, in the existing device-cache store. */
export const UNCERTAIN_SALE_KEY = "uncertain-online-sale" as const;

/**
 * The identity that must match for a record to belong to the running session.
 *
 * A device can be unpaired and re-paired without the page reloading, and the
 * new pairing is a different anonymous auth user with a different project. Its
 * checkout must not inherit — or be blocked by — another pairing's outstanding
 * request in a way that silently mixes the two.
 */
export type UncertainSaleIdentity = {
  deviceAuthUserId: string;
  deviceId: string;
  projectId: string;
  buildJobId: string;
};

export type PersistedUncertainSale = {
  schemaVersion: number;
  /** The idempotency key the dispatched request carried. Never regenerated. */
  saleRequestId: string;
  deviceAuthUserId: string;
  deviceId: string;
  projectId: string;
  buildJobId: string;
  paymentMethod: PaymentMethod;
  tipAmount: number;
  items: SaleSubmissionItem[];
  /** The fingerprint AS SUBMITTED — what a later attempt is compared against. */
  fingerprint: string;
  /** ISO, device clock: when the request was about to leave. */
  dispatchedAt: string;
};

export function buildUncertainSaleRecord(input: {
  sale: UncertainSale;
  identity: UncertainSaleIdentity;
  dispatchedAt: string;
}): PersistedUncertainSale {
  return {
    schemaVersion: UNCERTAIN_SALE_SCHEMA_VERSION,
    saleRequestId: input.sale.saleRequestId,
    deviceAuthUserId: input.identity.deviceAuthUserId,
    deviceId: input.identity.deviceId,
    projectId: input.sale.projectId,
    buildJobId: input.identity.buildJobId,
    paymentMethod: input.sale.paymentMethod,
    // Devices may not tip. Stored to keep the shape honest and comparable.
    tipAmount: input.sale.tipAmount,
    items: input.sale.items.map((item) => ({
      itemId: item.itemId,
      quantity: item.quantity,
      modifiers: item.modifiers.map((group) => ({
        groupId: group.groupId,
        optionIds: [...group.optionIds],
      })),
    })),
    fingerprint: input.sale.fingerprint,
    dispatchedAt: input.dispatchedAt,
  };
}

export type UncertainSaleReadFailure = "missing" | "malformed" | "unsupported_schema";

export type UncertainSaleReadResult =
  | { ok: true; record: PersistedUncertainSale }
  | { ok: false; reason: UncertainSaleReadFailure };

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Validates a record read back from storage.
 *
 * NOTHING IS INVENTED, exactly as readQueuedSale refuses to default a missing
 * financial field. A record whose key or payload cannot be read is not a record
 * that can safely resolve anything.
 *
 * BUT AN UNREADABLE RECORD IS NOT AN ABSENT ONE. `missing` means the key was
 * never written; `malformed` and `unsupported_schema` mean SOMETHING is there
 * and we cannot understand it. The session layer treats the latter two as
 * "there is an outstanding sale we cannot resolve", which blocks checkout and
 * blocks reset rather than freeing the till — the same instinct that quarantines
 * a corrupt queue row instead of dropping it.
 */
export function readUncertainSaleRecord(value: unknown): UncertainSaleReadResult {
  if (value === null || value === undefined) {
    return { ok: false, reason: "missing" };
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "malformed" };
  }

  const raw = value as Record<string, unknown>;

  if (raw.schemaVersion !== UNCERTAIN_SALE_SCHEMA_VERSION) {
    return { ok: false, reason: "unsupported_schema" };
  }

  const deviceAuthUserId = nonEmptyString(raw.deviceAuthUserId);
  const deviceId = nonEmptyString(raw.deviceId);
  const projectId = nonEmptyString(raw.projectId);
  const buildJobId = nonEmptyString(raw.buildJobId);
  const fingerprint = nonEmptyString(raw.fingerprint);
  const dispatchedAt =
    typeof raw.dispatchedAt === "string" && parseIsoTime(raw.dispatchedAt) !== null
      ? raw.dispatchedAt
      : null;

  if (
    deviceAuthUserId === null ||
    deviceId === null ||
    projectId === null ||
    buildJobId === null ||
    fingerprint === null ||
    dispatchedAt === null
  ) {
    return { ok: false, reason: "malformed" };
  }

  // The same validator the online path and the queue already use. A key the
  // server would refuse cannot resolve anything, so it is not a usable record.
  if (!isValidSaleRequestId(raw.saleRequestId)) {
    return { ok: false, reason: "malformed" };
  }

  if (raw.paymentMethod !== "cash" && raw.paymentMethod !== "card") {
    return { ok: false, reason: "malformed" };
  }

  if (typeof raw.tipAmount !== "number" || !Number.isFinite(raw.tipAmount)) {
    return { ok: false, reason: "malformed" };
  }

  const items = readItems(raw.items);

  if (items === null) {
    return { ok: false, reason: "malformed" };
  }

  return {
    ok: true,
    record: {
      schemaVersion: UNCERTAIN_SALE_SCHEMA_VERSION,
      saleRequestId: raw.saleRequestId,
      deviceAuthUserId,
      deviceId,
      projectId,
      buildJobId,
      paymentMethod: raw.paymentMethod,
      tipAmount: raw.tipAmount,
      items,
      fingerprint,
      dispatchedAt,
    },
  };
}

function readItems(value: unknown): SaleSubmissionItem[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  const items: SaleSubmissionItem[] = [];

  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;

    const raw = entry as Record<string, unknown>;
    const itemId = nonEmptyString(raw.itemId);

    if (
      itemId === null ||
      typeof raw.quantity !== "number" ||
      !Number.isInteger(raw.quantity) ||
      raw.quantity <= 0
    ) {
      return null;
    }

    const modifiers = readModifiers(raw.modifiers);

    if (modifiers === null) return null;

    items.push({ itemId, quantity: raw.quantity, modifiers });
  }

  return items;
}

function readModifiers(value: unknown): { groupId: string; optionIds: string[] }[] | null {
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

/**
 * Does this record belong to the session now running?
 *
 * A MISMATCH IS NOT A LICENCE TO DELETE. It means another pairing left an
 * outstanding request behind on this hardware, which is still evidence of money
 * that may have moved. The session layer neither applies it to the new session
 * (it would block the wrong sales, under a key the new project cannot use) nor
 * removes it — it is preserved, and it still blocks a destructive reset.
 */
export function ownsUncertainSale(
  record: PersistedUncertainSale,
  identity: UncertainSaleIdentity
): boolean {
  return (
    record.deviceAuthUserId === identity.deviceAuthUserId &&
    record.deviceId === identity.deviceId &&
    record.projectId === identity.projectId &&
    record.buildJobId === identity.buildJobId
  );
}

/** The in-memory model the checkout gate compares against. */
export function toUncertainSale(record: PersistedUncertainSale): UncertainSale {
  return {
    saleRequestId: record.saleRequestId,
    projectId: record.projectId,
    paymentMethod: record.paymentMethod,
    tipAmount: record.tipAmount,
    items: record.items,
    fingerprint: record.fingerprint,
  };
}
