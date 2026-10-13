// v1.3 D-1 — what a menu item price may be, and what the editor refuses.
import { describe, expect, it } from "vitest";

import {
  findItemsWithInvalidPrice,
  getPriceSaveBlockerMessage,
  isValidMenuItemPrice,
} from "@/lib/menuItemPricing";
import { defaultProjectConfig, type MenuItem, type ProjectConfig } from "@/lib/projectConfig";

function item(overrides: Partial<MenuItem>): MenuItem {
  return {
    id: "i1",
    name: "Latte",
    price: 4.25,
    category: "Coffee",
    trackInventory: false,
    stockQuantity: 0,
    ...overrides,
  };
}

function configWith(items: MenuItem[]): ProjectConfig {
  return { ...defaultProjectConfig, menuItems: items };
}

describe("isValidMenuItemPrice", () => {
  it("accepts ordinary prices", () => {
    for (const price of [0.01, 1, 4.25, 999.99, 1000000]) {
      expect(`${price}: ${isValidMenuItemPrice(price)}`).toBe(`${price}: true`);
    }
  });

  it("accepts 0.00, because a free item is a real thing to sell", () => {
    expect(isValidMenuItemPrice(0)).toBe(true);
  });

  it("rejects every negative price, including the smallest one", () => {
    for (const price of [-0.01, -1, -5, -1000000]) {
      expect(`${price}: ${isValidMenuItemPrice(price)}`).toBe(`${price}: false`);
    }
  });

  it("treats -0 as the zero it is, not as a negative", () => {
    // -0 >= 0 is true in JavaScript. Documented rather than left to be
    // rediscovered: a price of -0 is $0.00 and is allowed to save.
    expect(isValidMenuItemPrice(-0)).toBe(true);
  });

  it("rejects NaN and the infinities", () => {
    expect(isValidMenuItemPrice(Number.NaN)).toBe(false);
    expect(isValidMenuItemPrice(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidMenuItemPrice(Number.NEGATIVE_INFINITY)).toBe(false);
  });

  it("rejects anything that is not a number at all", () => {
    for (const price of ["4.25", null, undefined, {}, []]) {
      expect(`${String(price)}: ${isValidMenuItemPrice(price)}`).toBe(`${String(price)}: false`);
    }
  });
});

describe("findItemsWithInvalidPrice", () => {
  it("finds nothing in a healthy menu", () => {
    expect(findItemsWithInvalidPrice(configWith([item({}), item({ id: "i2", price: 0 })]))).toEqual([]);
  });

  it("finds only the offending items, in menu order", () => {
    const found = findItemsWithInvalidPrice(
      configWith([
        item({ id: "ok", price: 3 }),
        item({ id: "bad1", name: "Broken A", price: -1 }),
        item({ id: "ok2", price: 0 }),
        item({ id: "bad2", name: "Broken B", price: Number.NaN }),
      ])
    );

    expect(found.map((found) => found.id)).toEqual(["bad1", "bad2"]);
  });

  it("finds nothing in the shipped default config", () => {
    // A template must never ship a menu the editor would refuse to save.
    expect(findItemsWithInvalidPrice(defaultProjectConfig)).toEqual([]);
  });
});

describe("getPriceSaveBlockerMessage", () => {
  it("returns null when every price is valid", () => {
    expect(getPriceSaveBlockerMessage(configWith([item({}), item({ id: "i2", price: 0 })]))).toBeNull();
  });

  it("names the single offending item and says what to do", () => {
    expect(getPriceSaveBlockerMessage(configWith([item({ name: "Espresso", price: -5 })]))).toBe(
      "Espresso has a price that is not a valid amount. Enter 0 or more before saving."
    );
  });

  it("names every offending item when there is more than one", () => {
    const message = getPriceSaveBlockerMessage(
      configWith([
        item({ id: "a", name: "Espresso", price: -5 }),
        item({ id: "b", name: "Mocha", price: -1 }),
      ])
    );

    expect(message).toBe(
      "2 items have a price that is not a valid amount (Espresso, Mocha). " +
        "Enter 0 or more for each before saving."
    );
  });

  it("calls an unnamed item something an owner can still find", () => {
    expect(getPriceSaveBlockerMessage(configWith([item({ name: "   ", price: -5 })]))).toBe(
      "Untitled item has a price that is not a valid amount. Enter 0 or more before saving."
    );
  });

  it("does not mention a valid item that happens to sit beside a broken one", () => {
    const message = getPriceSaveBlockerMessage(
      configWith([item({ id: "a", name: "Fine", price: 2 }), item({ id: "b", name: "Broken", price: -2 })])
    );

    expect(message).toContain("Broken");
    expect(message).not.toContain("Fine");
  });
});
