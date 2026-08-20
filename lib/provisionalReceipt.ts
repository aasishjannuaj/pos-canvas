// Feature 24.5E — the provisional offline receipt, and the reconciliation model
// that survives its sync.
//
// WHAT THIS MODULE IS: the receipt a cashier hands a customer for a sale that
// has been saved on this device and not yet recorded by the server, expressed
// as pure functions with no IndexedDB, no React and no Supabase. Every value it
// produces is derived from two inputs and nothing else — the durable queue
// record, and the pinned immutable configuration the sale was priced against.
//
// WHY THAT PAIR IS THE WHOLE DESIGN. The queue deliberately stores no prices
// (see lib/saleQueue.ts), so a receipt cannot be reconstructed from the record
// alone; and the cart is gone the moment the sale completes, so it cannot be
// reconstructed from React state either. Deriving it from (record + pinned
// config) means the receipt shown at the counter and the receipt rebuilt after
// a restart three days later are produced by the same function from the same
// bytes — which is what makes "the provisional receipt is reconstructable"
// a property rather than a hope.
//
// THE TOTALS HERE ARE DISPLAY, NOT AUTHORITY. complete_sale_v4 prices the sale
// from the same pinned build snapshot when it syncs, and its answer is the one
// that reaches the books. These numbers exist so the customer sees what they
// paid and so a disagreement can be noticed; they are never sent anywhere.
//
// NO ORDER NUMBER IS INVENTED. The server allocates order numbers, once, at
// sync (docs/OFFLINE_ARCHITECTURE.md §8, decision D). Everything on a
// provisional receipt that looks like an identifier is an OFFLINE REFERENCE,
// deliberately shaped so it cannot be mistaken for one.
import { calculateCartSummary, createCartItem } from "@/lib/cart";
import type { CartItem, CartModifierSelection, PaymentMethod } from "@/lib/cart";
import { buildModifierSnapshot } from "@/lib/modifiers";
import type { ModifierGroup, ModifierSnapshotEntry } from "@/lib/modifiers";
import type { GeneratedPosConfig } from "@/lib/generatedPosConfig";
import type { QueueState, QueuedSale } from "@/lib/saleQueue";

// ---------------------------------------------------------------------------
// The approved wording
//
// APPROVED BY THE OWNER at the Feature 24.4 review (docs/OFFLINE_ARCHITECTURE.md
// §8 and §22 decision 6) and reproduced here EXACTLY. Constants rather than
// inline JSX strings so the component cannot drift from the approved text and
// so a test can pin every character of it.
//
// WHAT THE WORDING DELIBERATELY AVOIDS, restated because a future edit will be
// tempted: "not yet recorded", "provisional", "unconfirmed" and "pending" all
// read to a customer as *your payment may not have gone through*. The sale is
// real and complete. Only its receipt number is still to come.
// ---------------------------------------------------------------------------

export const OFFLINE_RECEIPT_BANNER = "OFFLINE RECEIPT";

export const OFFLINE_RECEIPT_REFERENCE_LABEL = "Ref:";

export const OFFLINE_RECEIPT_EXPLANATION_LINES = [
  "This sale is saved on this device",
  "and will sync when internet is restored.",
  "A final receipt number will be created after sync.",
] as const;

/** The explanatory paragraph as one string, for tests and for plain-text print. */
export const OFFLINE_RECEIPT_EXPLANATION =
  OFFLINE_RECEIPT_EXPLANATION_LINES.join("\n");

/**
 * Shown when a sale is saved but its paper copy could not be drawn — a pinned
 * configuration that no longer describes an item on the record, which cannot
 * happen for a sale this device just took.
 *
 * Informational, never an error: the sale IS saved, and the one thing that
 * failed is the printout.
 */
/**
 * Feature 24.5F (DEF-01) — shown when an online sale died on the wire and the
 * till has just come up in offline mode holding the same cart.
 *
 * THREE THINGS IT MUST DO, and the wording is load-bearing for each. It must
 * not claim the sale failed: the request may have reached the server, and the
 * customer may already be recorded. It must tell the cashier what to do, which
 * is simply to press Pay again. And it must answer the question that press
 * raises — "will they be charged twice?" — because a cashier who fears that
 * will not press, and will hand over goods with no record at all.
 *
 * The last sentence is TRUE by construction, not reassurance: the retry carries
 * the failed attempt's own sale_request_id, so complete_sale_v4 resolves it to
 * the order v3 already created rather than making a second one. See
 * PosRuntimeQueueOfflineSale.inheritedRequest.
 */
export const OFFLINE_AVAILABLE_AFTER_CONNECTION_LOST =
  "The internet connection was lost, so this sale is not confirmed. Press Pay again to save it on this device — if it already reached the server, pressing Pay again will not create a second sale.";

export const OFFLINE_RECEIPT_UNAVAILABLE_NOTE =
  "This sale is saved on this device. A printed receipt could not be produced for it.";

// ---------------------------------------------------------------------------
// The offline reference
// ---------------------------------------------------------------------------

/**
 * Crockford Base32 — the standard alphabet with I, L, O and U removed.
 *
 * DECLARED HERE RATHER THAN IMPORTED from lib/devicePairing.ts, which owns the
 * identical constant: that module imports node:crypto and therefore cannot be
 * pulled into a browser bundle. Copying 32 characters is the smaller cost.
 */
const OFFLINE_REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Marks a reference as an offline one at a glance. Never "ORD". */
export const OFFLINE_REFERENCE_PREFIX = "OFF";

const UUID_HEX = /^[0-9a-f]{32}$/;

/**
 * A short, human-readable handle for a queued sale.
 *
 * DERIVED, NOT GENERATED. The whole value is a function of the persisted
 * saleRequestId, so it is identical every time it is computed — at the counter,
 * after a reload, after a process kill, and after the sale has synced. There is
 * no second identifier to keep in step and nothing extra to store.
 *
 * The whole id is folded to 40 bits and rendered as eight Crockford Base32
 * characters: enough for staff to match a paper slip against a queued sale on
 * one till, and visibly a different SHAPE from a real order number
 * (`ORD1042`), which is the property that stops it being read as one.
 *
 * FOLDED RATHER THAN TRUNCATED, deliberately. Slicing the first ten hex
 * characters would be simpler and is fine for a real v4 UUID, whose leading
 * bits are random — but it makes the reference depend on WHERE the entropy in
 * an id happens to sit, and two ids differing only in their tail would render
 * identically. A fold over every character removes that assumption, and costs
 * one loop.
 *
 * It is NOT a security token and is not treated as one: it is a short digest of
 * a random id, shown on a receipt, used to look a sale up on the device that
 * already holds it. Two references colliding would confuse a lookup on one
 * till; it could never merge two sales, because nothing keys on this value.
 */
export function toOfflineReference(saleRequestId: string): string | null {
  const hex = saleRequestId.replace(/-/g, "").toLowerCase();

  if (!UUID_HEX.test(hex)) {
    return null;
  }

  // 40 bits, whose largest value is far inside the exact integer range of a
  // double, so this needs no BigInt.
  let value = fold(hex, 0x811c9dc5) * 256 + (fold(hex, 0x01000193) & 0xff);
  const characters: string[] = [];

  for (let index = 0; index < 8; index += 1) {
    characters.unshift(OFFLINE_REFERENCE_ALPHABET[value % 32]);
    value = Math.floor(value / 32);
  }

  const body = characters.join("");

  return `${OFFLINE_REFERENCE_PREFIX}-${body.slice(0, 4)}-${body.slice(4)}`;
}

/** FNV-1a, 32-bit. Chosen for being short, deterministic and dependency-free. */
function fold(input: string, seed: number): number {
  let hash = seed;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }

  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// The receipt
// ---------------------------------------------------------------------------

export type ProvisionalReceiptItem = {
  itemId: string;
  itemName: string;
  /** Fixed two decimals, like every money value on a receipt in this codebase. */
  unitPrice: string;
  quantity: number;
  lineTotal: string;
  /** Names and adjustments resolved from the PINNED config, never a live menu. */
  modifiers: ModifierSnapshotEntry[];
};

/**
 * A sale saved on this device.
 *
 * DELIBERATELY CARRIES NO SERVER FIELD. There is no orderId, no orderNumber and
 * no createdAt here — not even nullable ones — because a nullable server field
 * on this type is exactly the shape that eventually gets filled in with
 * something invented. The server's identity lives in SaleReconciliation below,
 * which only ever comes from a record the server has actually answered for.
 */
export type ProvisionalReceipt = {
  /** Discriminates this from CompletedSaleReceipt at a glance and in a switch. */
  status: "offline_pending";
  offlineReference: string;
  /** This device's handle on the durable record, so the receipt can be reopened. */
  queueRecordId: string;
  saleRequestId: string;
  /** When the customer paid. The device clock; the server validates it at sync. */
  occurredAt: string;
  paymentMethod: PaymentMethod;
  subtotal: string;
  taxAmount: string;
  tipAmount: string;
  total: string;
  items: ProvisionalReceiptItem[];
};

export type ProvisionalReceiptFailure = "unknown_item" | "invalid_reference";

export type ProvisionalReceiptResult =
  | { ok: true; receipt: ProvisionalReceipt }
  | { ok: false; reason: ProvisionalReceiptFailure };

/** Two decimals, exactly as the SQL side produces for an authoritative receipt. */
function money(value: number): string {
  return (Number.isFinite(value) ? value : 0).toFixed(2);
}

/**
 * Rebuilds the display selection for one line from the AUTHORIZED groups.
 *
 * Names and price adjustments come from the pinned config, never from the
 * queued record — the record stores identifiers only, which is what stops a
 * hand-edited database row from changing what a receipt claims was charged.
 * An unknown group or option is skipped, matching calculateModifiedUnitPrice.
 */
function toCartSelections(
  groups: readonly ModifierGroup[],
  selections: readonly { groupId: string; optionIds: string[] }[]
): CartModifierSelection[] {
  const resolved: CartModifierSelection[] = [];

  for (const selection of selections) {
    const group = groups.find((candidate) => candidate.id === selection.groupId);

    if (group === undefined) {
      continue;
    }

    const options = group.options
      .filter((option) => selection.optionIds.includes(option.id))
      .map((option) => ({
        id: option.id,
        name: option.name,
        priceAdjustment: option.priceAdjustment,
      }));

    if (options.length === 0) {
      continue;
    }

    resolved.push({ groupId: group.id, groupName: group.name, options });
  }

  return resolved;
}

/**
 * Builds the provisional receipt for a queued sale.
 *
 * THE PRICING PATH IS THE EXISTING ONE, not a second implementation:
 * createCartItem resolves a line's unit price exactly as the live cart does,
 * and calculateCartSummary applies the same tax rules the POS applies to every
 * other sale. Feeding those two functions a cart rebuilt from the durable
 * record is what guarantees the printed total equals the total the cashier saw.
 *
 * A record naming an item the pinned config does not contain is refused rather
 * than partially rendered. It cannot happen for a sale this device just took —
 * the cart was built from this very config — and if it ever did, a receipt
 * missing a line is worse than no receipt at all. The SALE is unaffected: it is
 * already durable, and this failure only means the paper copy cannot be drawn.
 */
export function buildProvisionalReceipt(input: {
  record: QueuedSale;
  config: GeneratedPosConfig;
}): ProvisionalReceiptResult {
  const offlineReference = toOfflineReference(input.record.saleRequestId);

  if (offlineReference === null) {
    return { ok: false, reason: "invalid_reference" };
  }

  const cart: CartItem[] = [];
  const items: ProvisionalReceiptItem[] = [];

  for (const queued of input.record.items) {
    const menuItem = input.config.menuItems.find((item) => item.id === queued.itemId);

    if (menuItem === undefined) {
      return { ok: false, reason: "unknown_item" };
    }

    const groups = menuItem.modifierGroups ?? [];
    const line = createCartItem(
      menuItem,
      toCartSelections(groups, queued.modifiers),
      queued.quantity
    );

    cart.push(line);

    items.push({
      itemId: menuItem.id,
      itemName: menuItem.name,
      unitPrice: money(line.price),
      quantity: queued.quantity,
      lineTotal: money(line.price * queued.quantity),
      modifiers: buildModifierSnapshot(groups, queued.modifiers),
    });
  }

  // The tip is read from the RECORD rather than assumed: it is validated to be
  // exactly 0 on the way into the queue (devices may not tip), and reading it
  // means no receipt can display an amount the stored sale does not carry.
  const summary = calculateCartSummary(cart, input.config.tax, input.record.tipAmount);

  return {
    ok: true,
    receipt: {
      status: "offline_pending",
      offlineReference,
      queueRecordId: input.record.queueRecordId,
      saleRequestId: input.record.saleRequestId,
      occurredAt: input.record.occurredAt,
      paymentMethod: input.record.paymentMethod,
      subtotal: money(summary.subtotal),
      taxAmount: money(summary.taxAmount),
      tipAmount: money(summary.tip),
      total: money(summary.total),
      items,
    },
  };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * How one sale stands, joining the reference the customer holds to the order
 * number the server allocated.
 *
 * BOTH TIMES ARE KEPT, and neither is derived from the other
 * (docs/OFFLINE_ARCHITECTURE.md §6.1): occurredAt answers "when did the
 * customer pay", serverCreatedAt answers "when did this enter the books". A
 * sale taken at 14:05 and synced at 18:40 has both facts, and overwriting
 * either would destroy the one the daily-takings report is actually asking for.
 */
export type SaleReconciliation = {
  offlineReference: string;
  /** Unchanged from the moment of sale, whatever happens afterwards. */
  occurredAt: string;
  state: QueueState;
  /** True ONLY when the server has recorded this sale. */
  synced: boolean;
  serverOrderId: string | null;
  serverOrderNumber: string | null;
  serverCreatedAt: string | null;
};

export const SYNCED_AS_PREFIX = "Synced as ";

/**
 * Projects a durable record into the reconciliation view.
 *
 * `synced` is derived from the STATE, not from the presence of an order number,
 * so a record that somehow carried one without having reached `synced` still
 * reads as not synced. A needs_attention sale can therefore never present
 * itself as recorded — the single most important property in this function.
 */
export function reconcileQueuedSale(record: QueuedSale): SaleReconciliation | null {
  const offlineReference = toOfflineReference(record.saleRequestId);

  if (offlineReference === null) {
    return null;
  }

  const synced = record.state === "synced";

  return {
    offlineReference,
    occurredAt: record.occurredAt,
    state: record.state,
    synced,
    // Withheld unless the record is genuinely synced, so no caller can render a
    // server identity for a sale the server has not accepted.
    serverOrderId: synced ? record.serverOrderId : null,
    serverOrderNumber: synced ? record.serverOrderNumber : null,
    serverCreatedAt: synced ? record.serverCreatedAt : null,
  };
}

/**
 * "Synced as ORD1042", or null when there is nothing truthful to say.
 *
 * Null rather than a placeholder: a receipt that says "Synced as —" invites the
 * reader to fill in the blank themselves.
 */
export function describeSyncedAs(reconciliation: SaleReconciliation): string | null {
  if (!reconciliation.synced || reconciliation.serverOrderNumber === null) {
    return null;
  }

  return `${SYNCED_AS_PREFIX}${reconciliation.serverOrderNumber}`;
}
