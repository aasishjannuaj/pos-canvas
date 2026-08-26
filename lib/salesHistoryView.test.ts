// Feature 25.3 Phase 2 — the pure decisions behind the history screen.

import { describe, expect, it } from "vitest";

import {
  appendHistoryPage,
  describeHistoryRow,
  emptySalesHistoryList,
  hasMoreHistory,
  paymentMethodLabel,
} from "@/lib/salesHistoryView";
import type { DeviceHistoryOrder } from "@/lib/deviceOrders";

function order(patch: Partial<DeviceHistoryOrder> = {}): DeviceHistoryOrder {
  return {
    orderId: "id-1",
    orderNumber: "ORD-1001",
    paymentMethod: "cash",
    subtotal: "10.00",
    taxAmount: "0.80",
    tipAmount: "0.00",
    total: "10.80",
    createdAt: "2026-08-23T18:42:00Z",
    occurredAt: "2026-08-23T18:40:00Z",
    source: "offline_queued",
    items: [],
    ...patch,
  } as DeviceHistoryOrder;
}

describe("cashier-facing labels", () => {
  it("says Cash and Card, not the stored value", () => {
    expect(paymentMethodLabel("cash")).toBe("Cash");
    expect(paymentMethodLabel("card")).toBe("Card");
  });
});

describe("building the list", () => {
  it("appends a page rather than replacing it", () => {
    const first = appendHistoryPage(emptySalesHistoryList, {
      orders: [order({ orderId: "a", orderNumber: "ORD-1002" })],
      nextCursor: { createdAt: "t1", id: "a" },
    });
    const second = appendHistoryPage(first, {
      orders: [order({ orderId: "b", orderNumber: "ORD-1001" })],
      nextCursor: null,
    });

    // "Load more" that reset to page one would lose the cashier's place.
    expect(second.orders.map((o) => o.orderNumber)).toEqual(["ORD-1002", "ORD-1001"]);
  });

  it("preserves SERVER order and never re-sorts by occurredAt", () => {
    // These two disagree: the later createdAt has the earlier occurredAt. The
    // list must follow the server, because the cursor is built from created_at
    // and re-sorting here is how a list starts skipping rows.
    const page = {
      orders: [
        order({ orderId: "a", orderNumber: "ORD-1002", createdAt: "2026-08-23T19:00:00Z", occurredAt: "2026-08-23T10:00:00Z" }),
        order({ orderId: "b", orderNumber: "ORD-1001", createdAt: "2026-08-23T18:00:00Z", occurredAt: "2026-08-23T17:00:00Z" }),
      ],
      nextCursor: null,
    };

    expect(appendHistoryPage(emptySalesHistoryList, page).orders.map((o) => o.orderNumber))
      .toEqual(["ORD-1002", "ORD-1001"]);
  });

  it("dedupes on orderId, never on order number", () => {
    // Order numbers are unique only WITHIN a project, so two projects each have
    // an ORD-1001 — deduping on the number would drop a real sale.
    const first = appendHistoryPage(emptySalesHistoryList, {
      orders: [order({ orderId: "a", orderNumber: "ORD-1001" })],
      nextCursor: { createdAt: "t", id: "a" },
    });
    const withDuplicateId = appendHistoryPage(first, {
      orders: [order({ orderId: "a", orderNumber: "ORD-1001" })],
      nextCursor: null,
    });

    expect(withDuplicateId.orders).toHaveLength(1);
  });

  it("keeps two different sales that share an order number", () => {
    const first = appendHistoryPage(emptySalesHistoryList, {
      orders: [order({ orderId: "a", orderNumber: "ORD-1001" })],
      nextCursor: { createdAt: "t", id: "a" },
    });
    const second = appendHistoryPage(first, {
      orders: [order({ orderId: "b", orderNumber: "ORD-1001" })],
      nextCursor: null,
    });

    expect(second.orders).toHaveLength(2);
  });

  it("carries the server's cursor untouched", () => {
    const list = appendHistoryPage(emptySalesHistoryList, {
      orders: [order()],
      nextCursor: { createdAt: "2026-08-23T18:00:00Z", id: "abc" },
    });

    expect(list.cursor).toEqual({ createdAt: "2026-08-23T18:00:00Z", id: "abc" });
    expect(hasMoreHistory(list)).toBe(true);
  });

  it("reports no more pages when the cursor is null", () => {
    expect(hasMoreHistory(appendHistoryPage(emptySalesHistoryList, { orders: [order()], nextCursor: null })))
      .toBe(false);
  });
});

describe("what a row shows", () => {
  it("prefers occurredAt — when the customer actually paid", () => {
    expect(describeHistoryRow(order()).time).toBe("2026-08-23T18:40:00Z");
  });

  it("falls back to createdAt when the sale time was never recorded", () => {
    expect(describeHistoryRow(order({ occurredAt: null })).time).toBe("2026-08-23T18:42:00Z");
  });

  it("shows number, total and a friendly payment label", () => {
    expect(describeHistoryRow(order({ paymentMethod: "card" }))).toEqual({
      orderNumber: "ORD-1001",
      time: "2026-08-23T18:40:00Z",
      total: "10.80",
      payment: "Card",
    });
  });
});
