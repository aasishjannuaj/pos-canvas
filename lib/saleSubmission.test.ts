// Feature 18.2 Phase 5A — behavioral tests for the shared checkout-submission
// rules.
//
// These are the rules the Builder Preview and the POS runtime now provably
// share. Everything here is pure, so it runs under plain Node exactly like
// lib/cart.test.ts and lib/saleRequest.test.ts.
import { describe, expect, it } from "vitest";
import {
  SALE_INSECURE_BROWSER_MESSAGE,
  SALE_INSUFFICIENT_STOCK_MESSAGE,
  SALE_UNCONFIRMED_MESSAGE,
  buildSaleRequestItems,
  hasInsufficientStock,
  planSaleSubmission,
  toCompletedOrder,
} from "@/lib/saleSubmission";
import { createCartItem } from "@/lib/cart";
import type { CartItem, CartModifierSelection } from "@/lib/cart";
import type { CompletedSaleReceipt } from "@/lib/completedSale";
import type { MenuItem } from "@/lib/projectConfig";
import type { SaleRequestState } from "@/lib/saleRequest";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function menuItem(overrides: Partial<MenuItem> = {}): MenuItem {
  return {
    id: "item-1",
    name: "Latte",
    price: 4,
    category: "Drinks",
    trackInventory: false,
    stockQuantity: 0,
    modifierGroups: [],
    ...overrides,
  } as MenuItem;
}

const MILK: CartModifierSelection = {
  groupId: "group-milk",
  groupName: "Milk",
  options: [{ id: "option-oat", name: "Oat", priceAdjustment: 0.6 }],
};

const SYRUP: CartModifierSelection = {
  groupId: "group-syrup",
  groupName: "Syrup",
  options: [
    { id: "option-vanilla", name: "Vanilla", priceAdjustment: 0.5 },
    { id: "option-hazelnut", name: "Hazelnut", priceAdjustment: 0.5 },
  ],
};

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const REQUEST_ID = "22222222-2222-2222-2222-222222222222";

// ---------------------------------------------------------------------------
// buildSaleRequestItems — the money-safety boundary
// ---------------------------------------------------------------------------

describe("buildSaleRequestItems sends identifiers only", () => {
  it("carries itemId, quantity and modifier ids, and nothing else", () => {
    const cart = [createCartItem(menuItem(), [MILK, SYRUP], 2)];

    expect(buildSaleRequestItems(cart)).toEqual([
      {
        itemId: "item-1",
        quantity: 2,
        modifiers: [
          { groupId: "group-milk", optionIds: ["option-oat"] },
          { groupId: "group-syrup", optionIds: ["option-vanilla", "option-hazelnut"] },
        ],
      },
    ]);
  });

  it("drops every display name and price adjustment", () => {
    const payload = JSON.stringify(buildSaleRequestItems([
      createCartItem(menuItem(), [MILK, SYRUP]),
    ]));

    // The exact leak this whole contract exists to prevent: a client-chosen
    // amount, or a name the server would otherwise have to trust.
    for (const leaked of ["Oat", "Vanilla", "Milk", "Syrup", "Latte", "0.6", "priceAdjustment"]) {
      expect(payload).not.toContain(leaked);
    }
  });

  it("never sends the client's unit price, base price or line identity", () => {
    const cart = [createCartItem(menuItem({ price: 4 }), [MILK])];
    const [line] = buildSaleRequestItems(cart);

    // lineKey is client-side cart identity; complete_sale_v3 recomputes the
    // canonical identity from the request and would not trust a supplied one.
    expect(Object.keys(line).sort()).toEqual(["itemId", "modifiers", "quantity"]);
    expect(cart[0].price).toBe(4.6);
  });

  it("omits a group with no chosen options", () => {
    const empty: CartModifierSelection = {
      groupId: "group-size",
      groupName: "Size",
      options: [],
    };

    expect(buildSaleRequestItems([createCartItem(menuItem(), [empty, MILK])])).toEqual([
      { itemId: "item-1", quantity: 1, modifiers: [{ groupId: "group-milk", optionIds: ["option-oat"] }] },
    ]);
  });

  it("a plain item still sends an empty modifier list", () => {
    // Backward compatibility: a product authored before Feature 18 must submit
    // exactly as it always did, with `modifiers` present but empty.
    expect(buildSaleRequestItems([createCartItem(menuItem(), [])])).toEqual([
      { itemId: "item-1", quantity: 1, modifiers: [] },
    ]);
  });

  it("keeps two selections of one product as two independent lines", () => {
    const cart = [
      createCartItem(menuItem(), [MILK]),
      createCartItem(menuItem(), [SYRUP]),
    ];

    const payload = buildSaleRequestItems(cart);
    expect(payload).toHaveLength(2);
    expect(payload[0].itemId).toBe(payload[1].itemId);
    expect(payload[0].modifiers).not.toEqual(payload[1].modifiers);
  });
});

// ---------------------------------------------------------------------------
// hasInsufficientStock — per PRODUCT, not per line
// ---------------------------------------------------------------------------

describe("hasInsufficientStock counts the whole product", () => {
  const tracked = menuItem({ trackInventory: true, stockQuantity: 3 });

  it("allows a cart within stock", () => {
    const cart = [createCartItem(tracked, [MILK], 2)];
    expect(hasInsufficientStock(cart, [tracked])).toBe(false);
  });

  it("sums two modifier lines of the same product against one pool", () => {
    // 2 + 2 = 4 against a stock of 3. Validating each line separately would
    // wrongly pass, and the server would then reject the sale.
    const cart = [
      createCartItem(tracked, [MILK], 2),
      createCartItem(tracked, [SYRUP], 2),
    ];

    expect(hasInsufficientStock(cart, [tracked])).toBe(true);
  });

  it("ignores untracked products entirely", () => {
    const untracked = menuItem({ trackInventory: false, stockQuantity: 0 });
    expect(hasInsufficientStock([createCartItem(untracked, [], 99)], [untracked])).toBe(false);
  });

  it("skips a line whose product the local menu no longer knows", () => {
    // The server is the authority and will reject it if genuinely unsellable;
    // blocking locally would strand a cart the operator cannot fix.
    expect(hasInsufficientStock([createCartItem(menuItem(), [])], [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// planSaleSubmission
// ---------------------------------------------------------------------------

describe("planSaleSubmission", () => {
  const tracked = menuItem({ trackInventory: true, stockQuantity: 1 });

  function plan(
    cart: CartItem[],
    current: SaleRequestState | null = null,
    generate: () => string = () => REQUEST_ID
  ) {
    return planSaleSubmission({
      projectId: PROJECT_ID,
      paymentMethod: "cash",
      tipAmount: 0,
      cart,
      menuItems: [tracked],
      current,
      generate,
    });
  }

  it("refuses a cart that exceeds stock, before any id is issued", () => {
    const result = plan([createCartItem(tracked, [], 5)]);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(SALE_INSUFFICIENT_STOCK_MESSAGE);
  });

  it("returns the request id and the identifiers-only payload", () => {
    const result = plan([createCartItem(tracked, [MILK])]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.request.id).toBe(REQUEST_ID);
    expect(result.items).toEqual([
      { itemId: "item-1", quantity: 1, modifiers: [{ groupId: "group-milk", optionIds: ["option-oat"] }] },
    ]);
  });

  it("reuses the id when the cart is unchanged, so a retry replays", () => {
    const first = plan([createCartItem(tracked, [MILK])]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const retry = plan([createCartItem(tracked, [MILK])], first.request, () => {
      throw new Error("must not mint a new id for an unchanged cart");
    });

    expect(retry.ok).toBe(true);
    expect(retry.ok === true && retry.request.id).toBe(REQUEST_ID);
  });

  it("issues a new id when a modifier changes", () => {
    // Under itemId-only fingerprinting, swapping Oat for Vanilla would have
    // reused the id and been rejected by the server as a hash mismatch.
    const first = plan([createCartItem(tracked, [MILK])]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const changed = planSaleSubmission({
      projectId: PROJECT_ID,
      paymentMethod: "cash",
      tipAmount: 0,
      cart: [createCartItem(tracked, [SYRUP])],
      menuItems: [tracked],
      current: first.request,
      generate: () => "33333333-3333-3333-3333-333333333333",
    });

    expect(changed.ok === true && changed.request.id).toBe(
      "33333333-3333-3333-3333-333333333333"
    );
  });

  it("reports an unusable crypto implementation instead of guessing an id", () => {
    const result = plan([createCartItem(tracked, [])], null, () => {
      throw new Error("no randomUUID");
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(SALE_INSECURE_BROWSER_MESSAGE);
  });
});

describe("the unconfirmed-sale message never claims the sale failed", () => {
  it("tells the operator to retry, and that a replay shows the original receipt", () => {
    // A transport failure may already have committed server-side. Wording that
    // asserted failure would invite a second, real sale.
    expect(SALE_UNCONFIRMED_MESSAGE).not.toMatch(/failed|did not|was not/i);
    expect(SALE_UNCONFIRMED_MESSAGE).toMatch(/retry/i);
    expect(SALE_UNCONFIRMED_MESSAGE).toMatch(/original receipt/i);
  });
});

// ---------------------------------------------------------------------------
// toCompletedOrder — reading the server's answer
// ---------------------------------------------------------------------------

const RECEIPT: CompletedSaleReceipt = {
  orderId: "order-1",
  orderNumber: "ORD-1042",
  paymentMethod: "card",
  subtotal: "10.20",
  taxAmount: "0.82",
  tipAmount: "0.00",
  total: "11.02",
  createdAt: "2026-08-13T10:00:00.000Z",
  items: [
    {
      itemId: "item-1",
      itemName: "Latte",
      unitPrice: "5.10",
      quantity: 2,
      lineTotal: "10.20",
      modifiers: [
        {
          groupId: "group-milk",
          groupName: "Milk",
          optionId: "option-oat",
          optionName: "Oat",
          priceAdjustment: "0.60",
        },
        {
          groupId: "group-syrup",
          groupName: "Syrup",
          optionId: "option-vanilla",
          optionName: "Vanilla",
          priceAdjustment: "0.50",
        },
      ],
    },
  ],
};

describe("toCompletedOrder projects the authoritative receipt", () => {
  it("takes every total from the server, never from a cart", () => {
    const order = toCompletedOrder(RECEIPT);

    expect(order.id).toBe("order-1");
    expect(order.orderNumber).toBe("ORD-1042");
    expect(order.subtotal).toBe(10.2);
    expect(order.taxAmount).toBe(0.82);
    expect(order.tip).toBe(0);
    expect(order.total).toBe(11.02);
    expect(order.paymentMethod).toBe("card");
    expect(order.createdAt).toBe("2026-08-13T10:00:00.000Z");
  });

  it("preserves the modifier snapshot, grouped as the server recorded it", () => {
    const [line] = toCompletedOrder(RECEIPT).items;

    expect(line.modifiers).toEqual([
      {
        groupId: "group-milk",
        groupName: "Milk",
        options: [{ id: "option-oat", name: "Oat", priceAdjustment: 0.6 }],
      },
      {
        groupId: "group-syrup",
        groupName: "Syrup",
        options: [{ id: "option-vanilla", name: "Vanilla", priceAdjustment: 0.5 }],
      },
    ]);
  });

  it("derives basePrice by subtracting the recorded adjustments", () => {
    // unit_price already includes them, so the breakdown must come back out of
    // the snapshot rather than from a menu lookup that may since have changed.
    const [line] = toCompletedOrder(RECEIPT).items;

    expect(line.price).toBe(5.1);
    expect(line.basePrice).toBeCloseTo(4, 10);
  });

  it("gives the line the same identity the cart would have produced", () => {
    // This is what lets a reprinted receipt and a live cart line agree.
    const [line] = toCompletedOrder(RECEIPT).items;
    const cartLine = createCartItem(
      menuItem({ id: "item-1", name: "Latte", price: 4 }),
      [
        MILK,
        {
          groupId: "group-syrup",
          groupName: "Syrup",
          options: [{ id: "option-vanilla", name: "Vanilla", priceAdjustment: 0.5 }],
        },
      ]
    );

    expect(line.lineKey).toBe(cartLine.lineKey);
  });

  it("a receipt with no modifiers key reads as a plain line", () => {
    // Backward compatibility: complete_sale_v2 never emitted the key, and
    // orders placed before Feature 18 have none.
    const legacy: CompletedSaleReceipt = {
      ...RECEIPT,
      items: [
        {
          itemId: "item-1",
          itemName: "Latte",
          unitPrice: "4.00",
          quantity: 1,
          lineTotal: "4.00",
        },
      ],
    };

    const [line] = toCompletedOrder(legacy).items;

    expect(line.modifiers).toEqual([]);
    expect(line.basePrice).toBe(4);
    expect(line.price).toBe(4);
    expect(line.lineKey).toBe(createCartItem(menuItem(), []).lineKey);
  });
});
