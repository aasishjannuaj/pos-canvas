// Feature 25.3 — the pure history model.
//
// The property that matters most here is that a history receipt is the SAME
// receipt the till printed. Every price, name and modifier comes from the stored
// order; nothing is recomputed from today's menu, and nothing is re-formatted by
// a second money path.

import { describe, expect, it } from "vitest";

import {
  historyDisplayTime,
  nextPageCursor,
  parseDeviceHistoryPage,
  toHistoryReceipt,
} from "@/lib/deviceOrders";
import { isCompletedSaleReceipt } from "@/lib/completedSale";
import { toCompletedOrder } from "@/lib/saleSubmission";

function order(patch: Record<string, unknown> = {}) {
  return {
    orderId: "11111111-1111-4111-8111-111111111111",
    orderNumber: "ORD-1042",
    paymentMethod: "cash",
    subtotal: "17.00",
    taxAmount: "1.37",
    tipAmount: "0.00",
    total: "18.37",
    createdAt: "2026-08-23T18:42:00Z",
    occurredAt: "2026-08-23T18:40:00Z",
    source: "offline_queued",
    items: [
      {
        itemId: "1",
        itemName: "Bacon Egg & Cheese",
        unitPrice: "6.49",
        quantity: 2,
        lineTotal: "12.98",
        modifiers: [
          {
            groupId: "g1",
            groupName: "Bread",
            optionId: "o1",
            optionName: "Bagel",
            priceAdjustment: "0.00",
          },
        ],
      },
    ],
    ...patch,
  };
}

const page = (patch: Record<string, unknown> = {}) => ({
  ok: true,
  orders: [order()],
  nextCursor: null,
  ...patch,
});

describe("parsing a page", () => {
  it("accepts a well-formed page", () => {
    const result = parseDeviceHistoryPage(page());

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.page.orders).toHaveLength(1);
      expect(result.page.orders[0].orderNumber).toBe("ORD-1042");
      expect(result.page.nextCursor).toBeNull();
    }
  });

  it("reads a complete cursor", () => {
    const result = parseDeviceHistoryPage(
      page({ nextCursor: { createdAt: "2026-08-23T18:00:00Z", id: "abc" } })
    );

    expect(result.ok && result.page.nextCursor).toEqual({
      createdAt: "2026-08-23T18:00:00Z",
      id: "abc",
    });
  });

  it("treats HALF a cursor as no cursor, never as a position", () => {
    // created_at alone cannot separate two orders written in the same instant,
    // so honouring it would skip or repeat rows. Stopping early is recoverable;
    // losing a sale from the list is not.
    for (const bad of [
      { createdAt: "2026-08-23T18:00:00Z" },
      { id: "abc" },
      { createdAt: "", id: "abc" },
      {},
    ]) {
      const result = parseDeviceHistoryPage(page({ nextCursor: bad }));

      expect(result.ok && result.page.nextCursor).toBeNull();
    }
  });

  it("fails the whole page on a malformed row rather than dropping it", () => {
    // An incomplete list looks exactly like a complete one to the person using
    // it to find a sale.
    const result = parseDeviceHistoryPage(
      page({ orders: [order(), { ...order(), total: "18.4" }] })
    );

    expect(result).toEqual({ ok: false, reason: "unreadable" });
  });

  it("rejects money that is not a fixed two-decimal string", () => {
    for (const bad of [{ total: 18.37 }, { subtotal: "17" }, { taxAmount: null }]) {
      expect(parseDeviceHistoryPage(page({ orders: [order(bad)] })).ok).toBe(false);
    }
  });

  it("passes the server's own refusals through unchanged", () => {
    for (const error of ["not_authenticated", "not_paired", "invalid_cursor"]) {
      expect(parseDeviceHistoryPage({ ok: false, error })).toEqual({ ok: false, reason: error });
    }
  });

  it("treats an unrecognised answer as unreadable", () => {
    for (const bad of [null, undefined, [], "nope", { ok: false, error: "surprise" }, { ok: true }]) {
      expect(parseDeviceHistoryPage(bad).ok).toBe(false);
    }
  });

  it("accepts an empty page as success, not as a failure", () => {
    const result = parseDeviceHistoryPage(page({ orders: [] }));

    expect(result.ok).toBe(true);
    expect(result.ok && result.page.orders).toEqual([]);
  });
});

describe("what a sale shows", () => {
  it("prefers occurred_at — when the customer actually paid", () => {
    const result = parseDeviceHistoryPage(page());

    expect(result.ok && historyDisplayTime(result.page.orders[0])).toBe("2026-08-23T18:40:00Z");
  });

  it("falls back to created_at for orders predating the offline contract", () => {
    const result = parseDeviceHistoryPage(page({ orders: [order({ occurredAt: null })] }));

    expect(result.ok && result.page.orders[0].occurredAt).toBeNull();
    expect(result.ok && historyDisplayTime(result.page.orders[0])).toBe("2026-08-23T18:42:00Z");
  });

  it("defaults a missing source to online, as the column itself does", () => {
    const result = parseDeviceHistoryPage(page({ orders: [order({ source: undefined })] }));

    expect(result.ok && result.page.orders[0].source).toBe("online");
  });
});

describe("a history row IS a receipt", () => {
  it("satisfies the receipt contract the till uses", () => {
    const result = parseDeviceHistoryPage(page());

    expect(result.ok && isCompletedSaleReceipt(toHistoryReceipt(result.page.orders[0]))).toBe(true);
  });

  it("maps through toCompletedOrder losslessly", () => {
    const result = parseDeviceHistoryPage(page());

    if (!result.ok) throw new Error("expected a page");

    const completed = toCompletedOrder(toHistoryReceipt(result.page.orders[0]));

    expect(completed.orderNumber).toBe("ORD-1042");
    expect(completed.paymentMethod).toBe("cash");
    expect(completed.subtotal).toBe(17);
    expect(completed.taxAmount).toBe(1.37);
    expect(completed.tip).toBe(0);
    expect(completed.total).toBe(18.37);
    expect(completed.items).toHaveLength(1);
    expect(completed.items[0].quantity).toBe(2);
  });

  it("preserves the item name and unit price AS RECORDED", () => {
    const result = parseDeviceHistoryPage(page());

    if (!result.ok) throw new Error("expected a page");

    const item = toCompletedOrder(toHistoryReceipt(result.page.orders[0])).items[0];

    // Not looked up in today's menu — a repriced past sale rewrites what a
    // customer paid every time the menu changes.
    expect(item.name).toBe("Bacon Egg & Cheese");
    // CartItem calls it `price` — the combined unit price the server charged.
    expect(item.price).toBe(6.49);
  });

  it("preserves modifiers", () => {
    const result = parseDeviceHistoryPage(page());

    if (!result.ok) throw new Error("expected a page");

    // `modifiers` is OPTIONAL on the item contract — complete_sale_v2 never
    // emitted the key, so its absence must read as "no modifiers" rather than as
    // a contract break. Narrowed here rather than asserted non-null, because a
    // pre-v3 order legitimately arrives without it.
    const raw = result.page.orders[0].items[0].modifiers ?? [];

    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({ groupName: "Bread", optionName: "Bagel" });
  });

  it("keeps a card sale labelled card", () => {
    const result = parseDeviceHistoryPage(page({ orders: [order({ paymentMethod: "card" })] }));

    expect(result.ok && result.page.orders[0].paymentMethod).toBe("card");
  });
});

describe("pagination helper", () => {
  it("returns the cursor to ask for the next page", () => {
    const result = parseDeviceHistoryPage(
      page({ nextCursor: { createdAt: "2026-08-23T18:00:00Z", id: "abc" } })
    );

    expect(result.ok && nextPageCursor(result.page)).toEqual({
      createdAt: "2026-08-23T18:00:00Z",
      id: "abc",
    });
  });

  it("returns null at the end", () => {
    const result = parseDeviceHistoryPage(page());

    expect(result.ok && nextPageCursor(result.page)).toBeNull();
  });
});
