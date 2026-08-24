// Feature 25.3 — the device's view of recent sales, as a pure model.
//
// WHAT THIS IS NOT. Not analytics, not a report, not a queue. It is the last few
// completed sales this business made, so a cashier can find one and reprint it.
//
// THE SHAPE IS DELIBERATELY THE RECEIPT SHAPE. get_device_recent_orders builds
// each row with the same jsonb construction complete_sale_v4 uses for its
// authoritative payload, so a history row IS a CompletedSaleReceipt with two
// extra fields. That is what lets this file validate with the existing
// isCompletedSaleReceipt and render through the existing toCompletedOrder and
// Receipt — no second pricing path, no second money formatter, and no
// opportunity for a history receipt to disagree with the one printed at the till.
//
// HISTORICAL VALUES COME FROM THE ORDER, NEVER FROM TODAY'S MENU. Every price,
// name and modifier here was stored at sale time by the server. Re-pricing a
// past sale from the current configuration would rewrite what a customer paid
// every time the menu changed.
//
// PURE. No network, no storage, no clock.

import { isCompletedSaleReceipt } from "@/lib/completedSale";
import type { CompletedSaleReceipt } from "@/lib/completedSale";

/**
 * One completed sale, exactly as the server recorded it.
 *
 * Extends the receipt contract rather than redefining it, so a value of this
 * type is usable anywhere a CompletedSaleReceipt is.
 */
export type DeviceHistoryOrder = CompletedSaleReceipt & {
  /**
   * When the money changed hands, for a sale that was queued offline.
   *
   * NULL ON EVERY ORDER PREDATING THE OFFLINE CONTRACT, and null rather than
   * defaulted: the column was added without a backfill, so there is no sale time
   * on record for those and inventing one would be writing history nobody kept.
   */
  occurredAt: string | null;
  source: string;
};

/** Both halves, always. See the note on parseDeviceHistoryPage. */
export type DeviceHistoryCursor = {
  createdAt: string;
  id: string;
};

export type DeviceHistoryPage = {
  orders: DeviceHistoryOrder[];
  /** null when this is the last page. */
  nextCursor: DeviceHistoryCursor | null;
};

export type DeviceHistoryFailure =
  | "not_authenticated"
  | "not_paired"
  | "invalid_cursor"
  | "unreadable";

export type DeviceHistoryResult =
  | { ok: true; page: DeviceHistoryPage }
  | { ok: false; reason: DeviceHistoryFailure };

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];

  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function parseCursor(value: unknown): DeviceHistoryCursor | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;

  const raw = value as Record<string, unknown>;
  const createdAt = readString(raw, "createdAt");
  const id = readString(raw, "id");

  // HALF A CURSOR IS NOT A CURSOR. created_at alone cannot separate two orders
  // written in the same instant, so a partial cursor would silently skip or
  // repeat rows. Treated as "no more pages" rather than as a usable position:
  // stopping early is recoverable, losing a sale from the list is not.
  return createdAt !== null && id !== null ? { createdAt, id } : null;
}

function parseOrder(value: unknown): DeviceHistoryOrder | null {
  // The receipt contract does the real work — money formats, item shapes,
  // payment method — so history cannot accept anything the till would refuse.
  if (!isCompletedSaleReceipt(value)) return null;

  const raw = value as unknown as Record<string, unknown>;
  const occurredAt = readString(raw, "occurredAt");
  const source = readString(raw, "source");

  return {
    ...(value as CompletedSaleReceipt),
    occurredAt,
    // A row with no source is readable but not classifiable; "online" is the
    // same default the column itself carries for pre-offline orders.
    source: source ?? "online",
  };
}

/**
 * Parses one page from get_device_recent_orders.
 *
 * A MALFORMED ROW FAILS THE PAGE rather than being skipped. Dropping one sale
 * from a list a cashier is using to find a sale is the one behaviour this must
 * not have: an incomplete list looks exactly like a complete one.
 */
export function parseDeviceHistoryPage(value: unknown): DeviceHistoryResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "unreadable" };
  }

  const raw = value as Record<string, unknown>;

  if (raw.ok !== true) {
    const error = readString(raw, "error");

    if (error === "not_authenticated" || error === "not_paired" || error === "invalid_cursor") {
      return { ok: false, reason: error };
    }

    return { ok: false, reason: "unreadable" };
  }

  if (!Array.isArray(raw.orders)) {
    return { ok: false, reason: "unreadable" };
  }

  const orders: DeviceHistoryOrder[] = [];

  for (const entry of raw.orders) {
    const order = parseOrder(entry);

    if (order === null) return { ok: false, reason: "unreadable" };

    orders.push(order);
  }

  return { ok: true, page: { orders, nextCursor: parseCursor(raw.nextCursor) } };
}

/**
 * The instant to show against a sale.
 *
 * occurred_at when the server has one — that is when the customer paid, which
 * for a sale queued offline can be hours before it was recorded. created_at
 * otherwise, which every order has.
 */
export function historyDisplayTime(order: DeviceHistoryOrder): string {
  return order.occurredAt ?? order.createdAt;
}

/**
 * The receipt for one historical sale.
 *
 * Exists as a named function rather than a cast so the reuse is visible: the
 * caller passes this to the SAME toCompletedOrder the live checkout path uses.
 */
export function toHistoryReceipt(order: DeviceHistoryOrder): CompletedSaleReceipt {
  return order;
}

/** The cursor to request the page after this one, or null at the end. */
export function nextPageCursor(page: DeviceHistoryPage): DeviceHistoryCursor | null {
  return page.nextCursor;
}
