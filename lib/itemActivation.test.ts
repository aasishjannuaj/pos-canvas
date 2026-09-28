// v1.3 Feature 1E-A — the shared activation decision.
//
// WHAT THIS REPLACES. The cart's add path used to return nothing and refuse a
// stock-exhausted item by silently handing back the previous cart. "The cart
// did not change" is not evidence of why, so any caller that needed to report a
// reason had to guess. These tests pin the three outcomes it can now state.
//
// AND WHAT IT MUST NOT BECOME. Every rule here is an existing rule called, not
// restated. If this module ever disagreed with lib/cart.ts about stock, or with
// the layout wrapper about modifiers, a scanned item would start behaving
// differently from a tapped one.
import { describe, expect, it } from "vitest";
import { canActivateItem, resolveItemActivation } from "@/lib/itemActivation";
import { canAddItemQuantity, createCartItem, getItemQuantityInCart } from "@/lib/cart";
import type { CartItem } from "@/lib/cart";
import type { MenuItem } from "@/lib/projectConfig";

const item = (over: Partial<MenuItem> = {}): MenuItem => ({
  id: "item-1",
  name: "Vodka 750ml",
  price: 19.99,
  category: "Spirits",
  trackInventory: false,
  stockQuantity: 0,
  ...over,
});

const withModifiers = (over: Partial<MenuItem> = {}): MenuItem =>
  item({
    modifierGroups: [
      {
        id: "g1",
        name: "Size",
        selection: "single",
        required: true,
        maxSelections: null,
        options: [{ id: "o1", name: "750ml", priceAdjustment: 0 }],
      },
    ],
    ...over,
  });

const cartOf = (menuItem: MenuItem, quantity: number): CartItem[] =>
  quantity === 0 ? [] : [{ ...createCartItem(menuItem, []), quantity }];

describe("modifiers come first", () => {
  it("reports modifiers-required before considering stock", () => {
    const product = withModifiers({ trackInventory: true, stockQuantity: 0 });

    // Out of stock AND needing options: the operator has not finished asking,
    // so refusing for stock here would report the wrong reason.
    expect(resolveItemActivation({ item: product, cart: [] })).toEqual({
      status: "modifiers-required",
    });
  });

  it("stops reporting modifiers-required once selections are resolved", () => {
    const product = withModifiers();

    expect(
      resolveItemActivation({ item: product, cart: [], selectionsResolved: true })
    ).toEqual({ status: "added" });
  });

  // NEGATIVE CONTROL ON THE MODIFIER RULE. The live product path decides on
  // normalizeModifierGroups(...).length, NOT on the raw array. An item carrying
  // only a malformed group normalizes to none and must sell directly — using
  // the raw array here would open a selector with nothing in it.
  it("uses the normalized groups, like the product path does", () => {
    const malformed = item({
      // No id, no name, no options: normalizeGroup drops it entirely.
      modifierGroups: [
        { id: "", name: "", selection: "single", required: false, maxSelections: null, options: [] },
      ],
    } as never);

    expect(resolveItemActivation({ item: malformed, cart: [] })).toEqual({ status: "added" });
  });

  it("an item with no groups at all sells directly", () => {
    expect(resolveItemActivation({ item: item(), cart: [] })).toEqual({ status: "added" });
    expect(resolveItemActivation({ item: item({ modifierGroups: [] }), cart: [] })).toEqual({
      status: "added",
    });
  });
});

describe("the stock decision is the cart's own", () => {
  it("allows an untracked product without limit", () => {
    const product = item({ trackInventory: false });

    expect(canActivateItem(product, cartOf(product, 999))).toBe(true);
  });

  it("refuses at the ceiling and allows below it", () => {
    const product = item({ trackInventory: true, stockQuantity: 2 });

    expect(resolveItemActivation({ item: product, cart: cartOf(product, 1) })).toEqual({
      status: "added",
    });
    expect(resolveItemActivation({ item: product, cart: cartOf(product, 2) })).toEqual({
      status: "refused-stock",
    });
  });

  it("refuses a tracked product with zero stock", () => {
    const product = item({ trackInventory: true, stockQuantity: 0 });

    expect(resolveItemActivation({ item: product, cart: [] })).toEqual({
      status: "refused-stock",
    });
  });

  // Stock is held against the PRODUCT while cart lines are keyed on lineKey, so
  // two modifier selections are two lines of one product. Counting one line
  // would let a cashier exceed stock by choosing different options.
  it("counts every line carrying the product, not just one", () => {
    const product = item({ trackInventory: true, stockQuantity: 2 });
    const cart: CartItem[] = [
      { ...createCartItem(product, []), quantity: 1 },
      { ...createCartItem(product, []), lineKey: "other-line", quantity: 1 },
    ];

    expect(getItemQuantityInCart(cart, product.id)).toBe(2);
    expect(resolveItemActivation({ item: product, cart })).toEqual({
      status: "refused-stock",
    });
  });

  // THE ANTI-DRIFT CONTROL. This asserts the shared decision IS the cart's
  // predicate, across the whole interesting range — so the two cannot diverge
  // without a test failing.
  it("agrees with canAddItemQuantity for every quantity around the ceiling", () => {
    const product = item({ trackInventory: true, stockQuantity: 3 });

    for (const quantity of [0, 1, 2, 3, 4, 10]) {
      const cart = cartOf(product, quantity);
      const expected = canAddItemQuantity({
        item: product,
        currentQuantity: getItemQuantityInCart(cart, product.id),
        addQuantity: 1,
      });

      expect(`q=${quantity}: ${canActivateItem(product, cart)}`).toBe(`q=${quantity}: ${expected}`);
    }
  });
});
