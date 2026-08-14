// Feature 18.2 — cart line-identity and modifier tests.
import { describe, expect, it } from "vitest";
import {
  createCartItem,
  createHistoricalCartItem,
  describeCartModifiers,
  getItemQuantityInCart,
  toModifierSelections,
  calculateCartSummary,
} from "@/lib/cart";
import type { CartItem, CartModifierSelection } from "@/lib/cart";
import { createSaleFingerprint } from "@/lib/saleRequest";
import type { MenuItem, TaxSettings } from "@/lib/projectConfig";

const TURKEY: MenuItem = {
  id: "turkey", name: "Turkey Grinder", price: 10.99, category: "Subs",
  trackInventory: false, stockQuantity: 0,
};
const TRACKED: MenuItem = { ...TURKEY, id: "tracked", trackInventory: true, stockQuantity: 3 };

const bacon: CartModifierSelection = {
  groupId: "addons", groupName: "Add-ons",
  options: [{ id: "bacon", name: "Bacon", priceAdjustment: 2 }],
};
const cheese: CartModifierSelection = {
  groupId: "addons", groupName: "Add-ons",
  options: [{ id: "cheese", name: "Extra Cheese", priceAdjustment: 1 }],
};
const both: CartModifierSelection = {
  groupId: "addons", groupName: "Add-ons",
  options: [
    { id: "cheese", name: "Extra Cheese", priceAdjustment: 1 },
    { id: "bacon", name: "Bacon", priceAdjustment: 2 },
  ],
};
const large: CartModifierSelection = {
  groupId: "size", groupName: "Size",
  options: [{ id: "lg", name: "Large", priceAdjustment: 2 }],
};

const TAX: TaxSettings = { enabled: false, rate: 0, pricesIncludeTax: false, showTaxSeparately: true };

describe("createCartItem", () => {
  it("leaves a no-modifier product exactly as before", () => {
    const line = createCartItem(TURKEY, []);
    expect(line.itemId).toBe("turkey");
    expect(line.price).toBe(10.99);
    expect(line.basePrice).toBe(10.99);
    expect(line.modifiers).toEqual([]);
    expect(line.quantity).toBe(1);
  });

  it("adds selected adjustments to the client estimate", () => {
    expect(createCartItem(TURKEY, [bacon]).price).toBeCloseTo(12.99, 2);
    expect(createCartItem(TURKEY, [both]).price).toBeCloseTo(13.99, 2);
    expect(createCartItem(TURKEY, [large, both]).price).toBeCloseTo(15.99, 2);
  });

  it("keeps basePrice separate so the cart can show a breakdown", () => {
    const line = createCartItem(TURKEY, [bacon]);
    expect(line.basePrice).toBe(10.99);
    expect(line.price - line.basePrice).toBeCloseTo(2, 2);
  });
});

describe("lineKey identity", () => {
  it("distinguishes the same product with different selections", () => {
    expect(createCartItem(TURKEY, [bacon]).lineKey)
      .not.toBe(createCartItem(TURKEY, [cheese]).lineKey);
  });

  it("merges the same product with the same selection", () => {
    expect(createCartItem(TURKEY, [bacon]).lineKey)
      .toBe(createCartItem(TURKEY, [bacon]).lineKey);
  });

  it("is independent of option order within a group", () => {
    const reversed: CartModifierSelection = {
      ...both, options: [...both.options].reverse(),
    };
    expect(createCartItem(TURKEY, [both]).lineKey)
      .toBe(createCartItem(TURKEY, [reversed]).lineKey);
  });

  it("is independent of group order", () => {
    expect(createCartItem(TURKEY, [large, both]).lineKey)
      .toBe(createCartItem(TURKEY, [both, large]).lineKey);
  });

  it("distinguishes a plain line from a modified one", () => {
    expect(createCartItem(TURKEY, []).lineKey)
      .not.toBe(createCartItem(TURKEY, [bacon]).lineKey);
  });

  it("distinguishes different products", () => {
    expect(createCartItem(TURKEY, [bacon]).lineKey)
      .not.toBe(createCartItem(TRACKED, [bacon]).lineKey);
  });
});

describe("toModifierSelections — the checkout payload shape", () => {
  it("emits identifiers only, never names or prices", () => {
    const payload = toModifierSelections([large, both]);
    expect(payload).toEqual([
      { groupId: "size", optionIds: ["lg"] },
      { groupId: "addons", optionIds: ["cheese", "bacon"] },
    ]);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("Large");
    expect(serialized).not.toContain("priceAdjustment");
    expect(serialized).not.toContain("groupName");
  });

  it("drops a group with no selected options", () => {
    expect(toModifierSelections([{ groupId: "g", groupName: "G", options: [] }])).toEqual([]);
  });

  it("emits nothing for a plain product", () => {
    expect(toModifierSelections([])).toEqual([]);
  });
});

describe("getItemQuantityInCart — stock is per PRODUCT, not per line", () => {
  it("sums every line carrying the same itemId", () => {
    const cart: CartItem[] = [
      { ...createCartItem(TURKEY, [bacon]), quantity: 2 },
      { ...createCartItem(TURKEY, [cheese]), quantity: 3 },
      { ...createCartItem(TRACKED, []), quantity: 1 },
    ];
    expect(getItemQuantityInCart(cart, "turkey")).toBe(5);
    expect(getItemQuantityInCart(cart, "tracked")).toBe(1);
    expect(getItemQuantityInCart(cart, "absent")).toBe(0);
  });
});

describe("calculateCartSummary with modified lines", () => {
  it("uses the line price, which already includes adjustments", () => {
    const cart: CartItem[] = [
      { ...createCartItem(TURKEY, [bacon]), quantity: 2 },
      createCartItem(TURKEY, [cheese]),
    ];
    // (10.99 + 2) * 2 + (10.99 + 1) = 25.98 + 11.99 = 37.97
    expect(calculateCartSummary(cart, TAX, 0).subtotal).toBeCloseTo(37.97, 2);
    expect(calculateCartSummary(cart, TAX, 0).itemCount).toBe(3);
  });
});

describe("sale fingerprint — modifier awareness", () => {
  const fp = (cart: CartItem[]) =>
    createSaleFingerprint({ projectId: "p", paymentMethod: "cash", tipAmount: 0, items: cart });

  it("is identical for the same semantic cart reordered", () => {
    const a = [createCartItem(TURKEY, [large, both]), createCartItem(TRACKED, [])];
    const b = [createCartItem(TRACKED, []), createCartItem(TURKEY, [both, large])];
    expect(fp(a)).toBe(fp(b));
  });

  it("changes when a modifier changes", () => {
    expect(fp([createCartItem(TURKEY, [bacon])]))
      .not.toBe(fp([createCartItem(TURKEY, [cheese])]));
  });

  it("changes when quantity changes", () => {
    expect(fp([createCartItem(TURKEY, [bacon])]))
      .not.toBe(fp([{ ...createCartItem(TURKEY, [bacon]), quantity: 2 }]));
  });

  it("treats two lines of the same product as distinct entries", () => {
    const two = fp([createCartItem(TURKEY, [bacon]), createCartItem(TURKEY, [cheese])]);
    const one = fp([createCartItem(TURKEY, [bacon])]);
    expect(two).not.toBe(one);
  });

  it("is unchanged for a plain cart, preserving pre-18.2 behavior", () => {
    expect(fp([createCartItem(TURKEY, [])])).toBe(fp([createCartItem(TURKEY, [])]));
  });
});

describe("describeCartModifiers", () => {
  it("flattens groups into display lines", () => {
    expect(describeCartModifiers(createCartItem(TURKEY, [large, both])).map((o) => o.name))
      .toEqual(["Large", "Extra Cheese", "Bacon"]);
  });

  it("is empty for a plain line", () => {
    expect(describeCartModifiers(createCartItem(TURKEY, []))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Feature 18.2 Phase 5A — createHistoricalCartItem
//
// The one mapping from a server-recorded line back to a display line. Shared by
// lib/orders.server.ts (persisted order_items rows) and lib/saleSubmission.ts (a
// live complete_sale_v3 receipt), so a reprinted receipt and a just-completed
// one describe the same sale identically.
// ---------------------------------------------------------------------------

describe("createHistoricalCartItem", () => {
  const SNAPSHOT = [
    {
      groupId: "addons",
      groupName: "Add-ons",
      optionId: "bacon",
      optionName: "Bacon",
      priceAdjustment: "2.00",
    },
    {
      groupId: "addons",
      groupName: "Add-ons",
      optionId: "cheese",
      optionName: "Extra Cheese",
      priceAdjustment: "1.00",
    },
  ];

  it("groups a flat snapshot back into per-group selections", () => {
    const line = createHistoricalCartItem({
      itemId: "turkey",
      itemName: "Turkey Grinder",
      unitPrice: 13.99,
      quantity: 2,
      snapshot: SNAPSHOT,
    });

    expect(line.modifiers).toEqual([
      {
        groupId: "addons",
        groupName: "Add-ons",
        options: [
          { id: "bacon", name: "Bacon", priceAdjustment: 2 },
          { id: "cheese", name: "Extra Cheese", priceAdjustment: 1 },
        ],
      },
    ]);
  });

  it("derives basePrice out of the recorded adjustments", () => {
    const line = createHistoricalCartItem({
      itemId: "turkey",
      itemName: "Turkey Grinder",
      unitPrice: 13.99,
      quantity: 1,
      snapshot: SNAPSHOT,
    });

    expect(line.price).toBe(13.99);
    expect(line.basePrice).toBeCloseTo(10.99, 10);
  });

  it("uses the SNAPSHOT's names, not the current menu's", () => {
    // The whole point of the stored snapshot: renaming an option later must not
    // rewrite what a customer already bought.
    const line = createHistoricalCartItem({
      itemId: "turkey",
      itemName: "Turkey Grinder (2024 recipe)",
      unitPrice: 12.99,
      quantity: 1,
      snapshot: [{ ...SNAPSHOT[0], optionName: "Applewood Bacon" }],
    });

    expect(line.name).toBe("Turkey Grinder (2024 recipe)");
    expect(line.modifiers[0].options[0].name).toBe("Applewood Bacon");
  });

  it("produces the same lineKey a live cart would", () => {
    const historical = createHistoricalCartItem({
      itemId: "turkey",
      itemName: "Turkey Grinder",
      unitPrice: 13.99,
      quantity: 1,
      snapshot: SNAPSHOT,
    });

    expect(historical.lineKey).toBe(createCartItem(TURKEY, [both]).lineKey);
  });

  it("reads an old order with no modifiers as a plain line", () => {
    // BACKWARD COMPATIBILITY. Every order placed before Feature 18.1 has an
    // empty snapshot, and rows written before the column existed default to [].
    for (const snapshot of [[], null, undefined, "not-an-array", 0]) {
      const line = createHistoricalCartItem({
        itemId: "turkey",
        itemName: "Turkey Grinder",
        unitPrice: 10.99,
        quantity: 3,
        snapshot,
      });

      expect(line.modifiers).toEqual([]);
      expect(line.basePrice).toBe(10.99);
      expect(line.price).toBe(10.99);
      expect(line.quantity).toBe(3);
      expect(line.lineKey).toBe(createCartItem(TURKEY, []).lineKey);
    }
  });
});
