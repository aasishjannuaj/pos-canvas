// Feature 25.3 Phase 2 — the pure decisions behind the Sales history screen.
//
// Kept out of the components because this repository tests React by reading its
// source: anything with a rule worth asserting belongs somewhere a real test can
// execute it. Appending a page and choosing a label are exactly that.
//
// PURE. No React, no network, no clock.

import { historyDisplayTime } from "@/lib/deviceOrders";
import type { DeviceHistoryCursor, DeviceHistoryOrder, DeviceHistoryPage } from "@/lib/deviceOrders";

/** What a cashier reads, not what the column stores. */
export function paymentMethodLabel(method: DeviceHistoryOrder["paymentMethod"]): string {
  return method === "card" ? "Card" : "Cash";
}

/**
 * The loaded list plus whatever is needed to ask for more.
 *
 * `cursor` is the server's own nextCursor, carried untouched. The client never
 * constructs one: created_at alone cannot separate two orders written in the
 * same instant, so a cursor this code assembled could skip or repeat rows.
 */
export type SalesHistoryList = {
  orders: DeviceHistoryOrder[];
  cursor: DeviceHistoryCursor | null;
};

export const emptySalesHistoryList: SalesHistoryList = { orders: [], cursor: null };

/**
 * Adds a page to what is already on screen.
 *
 * APPENDS, NEVER REPLACES. "Load more" that reset to page one would be a button
 * that loses the cashier's place.
 *
 * DEDUPES ON orderId, defensively. The server's tuple cursor already prevents
 * an overlap, but an order number is only unique WITHIN a project — so orderId
 * is the only sound identity here, and a list that showed one sale twice would
 * read as two sales. Order numbers are deliberately not used for this.
 */
export function appendHistoryPage(
  existing: SalesHistoryList,
  page: DeviceHistoryPage
): SalesHistoryList {
  const seen = new Set(existing.orders.map((order) => order.orderId));
  const added = page.orders.filter((order) => !seen.has(order.orderId));

  return {
    // Server order is preserved exactly: created_at DESC, id DESC. Re-sorting
    // by occurredAt here would disagree with the cursor the next page is asked
    // for, which is how a list starts skipping rows.
    orders: [...existing.orders, ...added],
    cursor: page.nextCursor,
  };
}

/** True while there is another page to ask for. */
export function hasMoreHistory(list: SalesHistoryList): boolean {
  return list.cursor !== null;
}

/**
 * The one-line summary for a row.
 *
 * Time comes from historyDisplayTime — occurredAt when the server has one,
 * because for a sale queued offline that is when the customer actually paid.
 */
export function describeHistoryRow(order: DeviceHistoryOrder): {
  orderNumber: string;
  time: string;
  total: string;
  payment: string;
} {
  return {
    orderNumber: order.orderNumber,
    time: historyDisplayTime(order),
    total: order.total,
    payment: paymentMethodLabel(order.paymentMethod),
  };
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------
//
// NOTHING HERE NAMES A MECHANISM. No RPC, no SQL, no PostgREST code, no
// build-job vocabulary — a cashier reads these, and an error that mentions a
// function name is an error they cannot act on.

export const HISTORY_TITLE = "Recent sales";
export const HISTORY_LOADING = "Loading recent sales…";
export const HISTORY_EMPTY = "No completed sales yet.";
export const HISTORY_OFFLINE =
  "Recent sales are unavailable while this device is offline.";
export const HISTORY_ERROR =
  "Recent sales could not be loaded right now.";
export const HISTORY_NOT_PAIRED =
  "This device is no longer paired, so recent sales are unavailable.";
export const HISTORY_LOAD_MORE = "Load more";
export const HISTORY_LOAD_MORE_FAILED =
  "The next page could not be loaded. The sales above are still here.";
export const HISTORY_RETRY = "Try again";
export const REPRINT_ACTION = "Reprint receipt";
