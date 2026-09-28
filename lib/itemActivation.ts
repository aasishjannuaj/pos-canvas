/**
 * v1.3 Feature 1E-A — what happens when a product is activated.
 *
 * "ACTIVATION" IS THE THING A TAP AND A SCAN HAVE IN COMMON. A cashier tapping
 * a card and a barcode resolving to an item are the same request — put this
 * product in the cart — and they must reach the cart through one decision, or
 * the two paths will drift and a scanned item will eventually behave unlike a
 * tapped one.
 *
 * WHY THIS EXISTS AT ALL: THE CALLER COULD NOT TELL WHAT HAPPENED. Until now
 * the cart's add path returned nothing and refused a stock-exhausted item by
 * silently returning the previous cart. That is defensible for a tap — the
 * cashier watched the card not respond — and indefensible for anything that
 * needs to report, because "the cart did not change" is not evidence of why.
 * Inferring a reason from an unchanged cart is exactly the guess this module
 * exists to remove.
 *
 * IT DECIDES NOTHING OF ITS OWN. Every rule here is an existing rule, called
 * rather than restated: `normalizeModifierGroups` from lib/modifiers.ts owns
 * what counts as needing a selection, and `canAddItemQuantity` /
 * `getItemQuantityInCart` from lib/cart.ts own the stock ceiling. This module
 * only names the outcome. There is deliberately no second stock policy and no
 * second modifier policy in this repository.
 *
 * NOT `hasModifiers`, AND THAT IS NOT A STYLE CHOICE. `hasModifiers` reports on
 * the RAW array, while the live product path (components/editor/pos-layouts)
 * decides on `normalizeModifierGroups(...).length`. Those two disagree for an
 * item carrying a malformed group that normalization drops: raw says "needs a
 * selection", normalized says "sells directly". Using the raw form here would
 * have created a second modifier rule that diverges from the one actually
 * controlling the UI — so this calls the same normalizer the UI does.
 *
 * PURE. No DOM, no React, no template, and nothing about barcodes — a barcode
 * is one of the callers, not a concept this module knows.
 */

import { canAddItemQuantity, getItemQuantityInCart } from "@/lib/cart";
import type { CartItem } from "@/lib/cart";
import { normalizeModifierGroups } from "@/lib/modifiers";
import type { MenuItem } from "@/lib/projectConfig";

/**
 * The outcome of asking for one unit of a product.
 *
 * `modifiers-required` is not a refusal — it means the request is legitimate
 * and cannot complete until somebody chooses options. The existing
 * ModifierSelector is what resolves it; activation resumes afterwards with the
 * chosen selections.
 *
 * `refused-stock` is the only refusal this version can state truthfully,
 * because the stock ceiling is the only rule that can turn a valid request
 * away.
 */
export type ItemActivationStatus = "added" | "modifiers-required" | "refused-stock";

export type ItemActivationResult = { status: ItemActivationStatus };

/**
 * Would adding one unit of this product succeed right now?
 *
 * THE STOCK QUESTION IS ASKED ACROSS THE WHOLE PRODUCT, not one cart line:
 * stock is held against the product, while cart lines are keyed on lineKey so
 * one product with two modifier selections is two lines. Counting a single line
 * would let a cashier exceed stock by choosing different options — which is why
 * this calls getItemQuantityInCart, exactly as the cart's own add path does.
 */
export function canActivateItem(item: MenuItem, cart: readonly CartItem[]): boolean {
  return canAddItemQuantity({
    item,
    currentQuantity: getItemQuantityInCart(cart, item.id),
    addQuantity: 1,
  });
}

/**
 * The full activation decision for a product against the current cart.
 *
 * ORDER MATTERS, AND MODIFIERS COME FIRST. An item whose options have not been
 * chosen yet is not refused for stock, because the cashier has not finished
 * asking: the selector opens, and the stock ceiling is applied when the real
 * add happens with the chosen selections. Checking stock first would refuse a
 * product before the operator had a chance to configure it, and would report
 * "out of stock" for something the selector was about to make addable.
 *
 * `selectionsResolved: true` says the caller is past the selector — either the
 * product never needed one, or one has been completed — so only stock remains.
 */
export function resolveItemActivation(input: {
  item: MenuItem;
  cart: readonly CartItem[];
  selectionsResolved?: boolean;
}): ItemActivationResult {
  const { item, cart } = input;

  if (
    input.selectionsResolved !== true &&
    normalizeModifierGroups(item.modifierGroups).length > 0
  ) {
    return { status: "modifiers-required" };
  }

  return canActivateItem(item, cart) ? { status: "added" } : { status: "refused-stock" };
}
