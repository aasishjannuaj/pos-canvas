import { describe, expect, it } from "vitest";
import { calculateCartSummary, canAddItemQuantity } from "@/lib/cart";
import type { CartItem } from "@/lib/cart";
import type { MenuItem, TaxSettings } from "@/lib/projectConfig";

const TAXED_ITEM: CartItem = {
  itemId: "1",
  name: "Coffee",
  price: 4,
  quantity: 2,
};

function makeTax(overrides: Partial<TaxSettings> = {}): TaxSettings {
  return {
    enabled: true,
    rate: 10,
    pricesIncludeTax: false,
    showTaxSeparately: true,
    ...overrides,
  };
}

function makeMenuItem(overrides: Partial<MenuItem> = {}): MenuItem {
  return {
    id: "1",
    name: "Coffee",
    price: 4,
    category: "Drinks",
    trackInventory: true,
    stockQuantity: 5,
    ...overrides,
  };
}

describe("calculateCartSummary", () => {
  it("computes tax-exclusive math (tax added on top of subtotal)", () => {
    const result = calculateCartSummary([TAXED_ITEM], makeTax({ pricesIncludeTax: false }), 0);

    expect(result.subtotal).toBe(8);
    expect(result.taxAmount).toBeCloseTo(0.8);
    expect(result.total).toBeCloseTo(8.8);
  });

  it("computes tax-inclusive math (tax extracted from subtotal, total unchanged)", () => {
    const result = calculateCartSummary([TAXED_ITEM], makeTax({ pricesIncludeTax: true }), 0);

    expect(result.subtotal).toBe(8);
    expect(result.taxAmount).toBeCloseTo(8 - 8 / 1.1);
    expect(result.total).toBe(8);
  });

  it("charges no tax when tax is disabled", () => {
    const result = calculateCartSummary([TAXED_ITEM], makeTax({ enabled: false }), 0);

    expect(result.taxAmount).toBe(0);
    expect(result.total).toBe(8);
  });

  it("forces tip to 0 when the caller passes 0, regardless of tax settings", () => {
    const result = calculateCartSummary([TAXED_ITEM], makeTax(), 0);
    expect(result.tip).toBe(0);
  });

  it("never fabricates a tip from a non-finite or negative tipAmount", () => {
    expect(calculateCartSummary([TAXED_ITEM], makeTax(), Number.NaN).tip).toBe(0);
    expect(calculateCartSummary([TAXED_ITEM], makeTax(), -5).tip).toBe(0);
    expect(calculateCartSummary([TAXED_ITEM], makeTax(), Infinity).tip).toBe(0);
  });

  it("passes through a real explicit positive tip", () => {
    const result = calculateCartSummary([TAXED_ITEM], makeTax(), 3);
    expect(result.tip).toBe(3);
    expect(result.total).toBeCloseTo(8.8 + 3);
  });

  it("does not mutate its inputs", () => {
    const cart = [{ ...TAXED_ITEM }];
    const tax = makeTax();
    const cartBefore = JSON.parse(JSON.stringify(cart));
    const taxBefore = JSON.parse(JSON.stringify(tax));

    calculateCartSummary(cart, tax, 0);

    expect(cart).toEqual(cartBefore);
    expect(tax).toEqual(taxBefore);
  });
});

describe("canAddItemQuantity", () => {
  it("always allows an untracked item", () => {
    const item = makeMenuItem({ trackInventory: false, stockQuantity: 0 });
    expect(
      canAddItemQuantity({ item, currentQuantity: 0, addQuantity: 1 })
    ).toBe(true);
  });

  it("allows a tracked item within stock", () => {
    const item = makeMenuItem({ stockQuantity: 5 });
    expect(
      canAddItemQuantity({ item, currentQuantity: 2, addQuantity: 1 })
    ).toBe(true);
  });

  it("allows exactly reaching the stock limit", () => {
    const item = makeMenuItem({ stockQuantity: 5 });
    expect(
      canAddItemQuantity({ item, currentQuantity: 4, addQuantity: 1 })
    ).toBe(true);
  });

  it("rejects exceeding the stock limit", () => {
    const item = makeMenuItem({ stockQuantity: 5 });
    expect(
      canAddItemQuantity({ item, currentQuantity: 5, addQuantity: 1 })
    ).toBe(false);
  });

  it("rejects any addition when stockQuantity is 0", () => {
    const item = makeMenuItem({ stockQuantity: 0 });
    expect(
      canAddItemQuantity({ item, currentQuantity: 0, addQuantity: 1 })
    ).toBe(false);
  });

  it("rejects a zero or negative addQuantity", () => {
    const item = makeMenuItem({ stockQuantity: 5 });
    expect(
      canAddItemQuantity({ item, currentQuantity: 0, addQuantity: 0 })
    ).toBe(false);
    expect(
      canAddItemQuantity({ item, currentQuantity: 0, addQuantity: -1 })
    ).toBe(false);
  });

  it("rejects a negative or non-finite currentQuantity", () => {
    const item = makeMenuItem({ stockQuantity: 5 });
    expect(
      canAddItemQuantity({ item, currentQuantity: -1, addQuantity: 1 })
    ).toBe(false);
    expect(
      canAddItemQuantity({ item, currentQuantity: Number.NaN, addQuantity: 1 })
    ).toBe(false);
  });

  it("remains addable for an untracked salon-style service regardless of quantity requested", () => {
    const service = makeMenuItem({
      name: "Haircut",
      trackInventory: false,
      stockQuantity: 0,
    });

    expect(
      canAddItemQuantity({ item: service, currentQuantity: 10, addQuantity: 5 })
    ).toBe(true);
  });

  it("does not mutate the passed-in item", () => {
    const item = makeMenuItem({ stockQuantity: 5 });
    const before = { ...item };

    canAddItemQuantity({ item, currentQuantity: 2, addQuantity: 1 });

    expect(item).toEqual(before);
  });
});
