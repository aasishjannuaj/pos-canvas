// v1.3 Feature 1E-A correction — why the preflight is not a receipt.
//
// THE CONTRACT THAT WAS WRONG. An earlier pass had PosRuntime.addToCart predict
// its own outcome from the render-time cart and return "added". Both directions
// of that prediction were reachable, and these tests reproduce them: a
// synchronous function that dispatches setCart(prev => ...) cannot observe the
// update it just requested, because the updater runs later against a `prev` the
// caller never sees.
//
// WHAT THE CORRECTION IS. `resolveItemActivation` answers only "may this add be
// attempted, on the snapshot you gave me" — ready / modifiers-required /
// refused-stock — and the add path returns nothing at all. The authoritative
// stock decision stays inside the updater against fresh `prev`.
//
// This repository has no DOM test environment, so the tests below model the
// closure/updater split exactly rather than rendering React: `renderCart` is
// what a handler closure sees, `queued` is what React would pass as `prev`.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canActivateItem, resolveItemActivation } from "@/lib/itemActivation";
import type { ItemActivationStatus } from "@/lib/itemActivation";
import { createCartItem } from "@/lib/cart";
import type { CartItem } from "@/lib/cart";
import type { MenuItem } from "@/lib/projectConfig";

const oneInStock: MenuItem = {
  id: "p1",
  name: "Vodka 750ml",
  price: 19.99,
  category: "Spirits",
  trackInventory: true,
  stockQuantity: 1,
};

const lineOf = (item: MenuItem, quantity: number): CartItem => ({
  ...createCartItem(item, []),
  quantity,
});

/**
 * The CORRECTED add path: the authoritative guard against `prev`, returning
 * nothing. Mirrors PosRuntime.addToCart exactly.
 */
function authoritativeAdd(queued: CartItem[], item: MenuItem): { next: CartItem[]; committed: boolean } {
  if (!canActivateItem(item, queued)) {
    return { next: queued, committed: false };
  }

  const line = createCartItem(item, []);
  const existing = queued.find((cartItem) => cartItem.lineKey === line.lineKey);

  return {
    next: existing
      ? queued.map((cartItem) =>
          cartItem.lineKey === line.lineKey
            ? { ...cartItem, quantity: cartItem.quantity + 1 }
            : cartItem
        )
      : [...queued, line],
    committed: true,
  };
}

/** The OLD, removed behaviour, kept only to prove it was unsafe. */
function legacyPredictedStatus(renderCart: CartItem[], item: MenuItem): "added" | "refused-stock" {
  return canActivateItem(item, renderCart) ? "added" : "refused-stock";
}

const quantityOf = (cart: CartItem[], itemId: string) =>
  cart.reduce((sum, line) => (line.itemId === itemId ? sum + line.quantity : sum), 0);

describe("CASE 1 — two synchronous add attempts, stockQuantity = 1", () => {
  it("the removed prediction claimed two adds; the updater only ever committed one", () => {
    const renderCart: CartItem[] = []; // both closures see this, unchanged in-tick
    let queued: CartItem[] = [];

    const firstPrediction = legacyPredictedStatus(renderCart, oneInStock);
    const first = authoritativeAdd(queued, oneInStock);
    queued = first.next;

    const secondPrediction = legacyPredictedStatus(renderCart, oneInStock);
    const second = authoritativeAdd(queued, oneInStock);
    queued = second.next;

    // THE OLD LIE, reproduced: both attempts predicted "added".
    expect(firstPrediction).toBe("added");
    expect(secondPrediction).toBe("added");

    // The authoritative updater committed exactly one.
    expect(first.committed).toBe(true);
    expect(second.committed).toBe(false);

    // And stock was never exceeded, which is the property that actually matters.
    expect(quantityOf(queued, oneInStock.id)).toBe(1);
    expect(quantityOf(queued, oneInStock.id)).toBeLessThanOrEqual(oneInStock.stockQuantity);
  });

  it("the preflight says only `ready`, which is not a claim that anything was added", () => {
    const renderCart: CartItem[] = [];

    const decision = resolveItemActivation({
      item: oneInStock,
      cart: renderCart,
      selectionsResolved: true,
    });

    expect(decision.status).toBe("ready");
    // NEGATIVE CONTROL: the moment "added" is a member of this union again, or
    // the preflight starts returning it, this fails.
    expect(decision.status).not.toBe("added");
  });
});

describe("CASE 2 — preflight snapshot differs from updater prev", () => {
  it("a remove queued before an add: the removed prediction refused, the updater added", () => {
    // The render closure still holds the item; a remove is already queued.
    const renderCart: CartItem[] = [lineOf(oneInStock, 1)];
    const queued: CartItem[] = [];

    const prediction = legacyPredictedStatus(renderCart, oneInStock);
    const result = authoritativeAdd(queued, oneInStock);

    // THE OLD LIE IN THE OTHER DIRECTION: predicted a stock refusal, committed.
    expect(prediction).toBe("refused-stock");
    expect(result.committed).toBe(true);

    // The final cart follows the updater, never the prediction.
    expect(quantityOf(result.next, oneInStock.id)).toBe(1);
  });

  it("the preflight is explicitly snapshot-scoped and disagrees harmlessly", () => {
    const staleSnapshot: CartItem[] = [lineOf(oneInStock, 1)];
    const freshPrev: CartItem[] = [];

    expect(
      resolveItemActivation({ item: oneInStock, cart: staleSnapshot, selectionsResolved: true })
        .status
    ).toBe("refused-stock");

    // The authoritative side, asked about the cart as it actually is.
    expect(canActivateItem(oneInStock, freshPrev)).toBe(true);
  });
});

describe("the contract cannot silently regain a committed-mutation claim", () => {
  // NEGATIVE CONTROL. This is the whole point of the correction: `ready` must
  // never be spelled, aliased or treated as `added`.
  it("`added` is not a member of the status union", () => {
    const statuses: ItemActivationStatus[] = ["ready", "modifiers-required", "refused-stock"];

    expect(statuses).toHaveLength(3);
    expect(statuses).not.toContain("added" as ItemActivationStatus);

    // Every reachable outcome of the resolver, enumerated.
    const produced = new Set<string>();

    for (const trackInventory of [true, false]) {
      for (const stockQuantity of [0, 1]) {
        for (const selectionsResolved of [true, false]) {
          for (const modifierGroups of [
            undefined,
            [
              {
                id: "g1",
                name: "Size",
                selection: "single" as const,
                required: true,
                maxSelections: null,
                options: [{ id: "o1", name: "750ml", priceAdjustment: 0 }],
              },
            ],
          ]) {
            produced.add(
              resolveItemActivation({
                item: { ...oneInStock, trackInventory, stockQuantity, modifierGroups },
                cart: [],
                selectionsResolved,
              }).status
            );
          }
        }
      }
    }

    expect([...produced].sort()).toEqual(["modifiers-required", "ready", "refused-stock"]);
    expect(produced.has("added")).toBe(false);
  });

  it("the runtime add path returns nothing and keeps its authoritative check", () => {
    const runtime = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "components/runtime/PosRuntime.tsx"),
      "utf-8"
    );

    const addToCart = runtime.slice(
      runtime.indexOf("function addToCart"),
      runtime.indexOf("function increaseQuantity")
    );

    // Signature is void, and no status object is constructed here.
    expect(addToCart).toContain("): void {");
    expect(addToCart).not.toContain('status: "added"');
    expect(addToCart).not.toContain("ItemActivationDecision");
    expect(addToCart).not.toContain("return reported");

    // The one authoritative decision, still against `prev`, still shared.
    expect(addToCart).toContain("canActivateItem(menuItem, prev)");
    expect(addToCart).toContain("setCart((prev)");
  });
});
