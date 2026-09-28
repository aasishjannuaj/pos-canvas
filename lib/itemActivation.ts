/**
 * v1.3 Feature 1E-A — what happens when a product is activated.
 *
 * "ACTIVATION" IS THE THING A TAP AND A SCAN HAVE IN COMMON. A cashier tapping
 * a card and a barcode resolving to an item are the same request — put this
 * product in the cart — and they must reach the cart through one decision, or
 * the two paths will drift and a scanned item will eventually behave unlike a
 * tapped one.
 *
 * IT IS A PREFLIGHT, NOT A RECEIPT. This module answers "should this add be
 * attempted, and if not, why" against a cart snapshot the caller hands it. It
 * does not — and cannot — report whether a mutation committed: the cart is
 * React state, the authoritative decision happens later inside
 * `setCart(prev => ...)` against a `prev` this module never sees, and no
 * synchronous answer can observe it.
 *
 * AN EARLIER VERSION OF THIS CONTRACT SAID `added`, AND THAT WAS A LIE. With a
 * stock ceiling of one, two adds dispatched in the same tick both read the same
 * render snapshot: the first committed, the second was refused by the updater,
 * and both were told `added`. The reverse was reachable too — a remove and an
 * add in one tick produced `refused-stock` from a stale snapshot while the
 * updater went on to add. Naming the outcome `ready` is the correction: it says
 * what a preflight can actually know, and nothing beyond it.
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
 * What a caller should do next with this product.
 *
 * `ready` MEANS EXACTLY ONE THING: on the snapshot supplied, this item is
 * eligible to go through the ordinary add path. It does NOT mean the cart
 * changed, that the item entered the cart, that stock was committed, or that a
 * caller may show an "added" message. The add path's own check against a fresh
 * `prev` decides that, and it may still refuse.
 *
 * `modifiers-required` is not a refusal — the request is legitimate and cannot
 * complete until somebody chooses options. The existing ModifierSelector
 * resolves it; activation resumes afterwards with the chosen selections.
 *
 * `refused-stock` means do not issue this add attempt at all. It is the only
 * refusal this version can state, because the stock ceiling is the only rule
 * that turns an otherwise-valid request away.
 *
 * THERE IS DELIBERATELY NO `added` MEMBER, and adding one back would reinstate
 * a claim this module cannot support. See the module note.
 */
export type ItemActivationStatus = "ready" | "modifiers-required" | "refused-stock";

/** The preflight answer. Called a decision, not a result, on purpose. */
export type ItemActivationDecision = { status: ItemActivationStatus };

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
 * The preflight decision for a product against a supplied cart snapshot.
 *
 * THE SNAPSHOT IS THE CALLER'S, AND IT MAY BE STALE. Measured against queued
 * but unapplied React updates this answer can be wrong in both directions. That
 * is accepted, and it is precisely why `ready` is not `added`: the authoritative
 * guard lives in the add path's own updater, which sees a cart this cannot.
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
}): ItemActivationDecision {
  const { item, cart } = input;

  if (
    input.selectionsResolved !== true &&
    normalizeModifierGroups(item.modifierGroups).length > 0
  ) {
    return { status: "modifiers-required" };
  }

  return canActivateItem(item, cart) ? { status: "ready" } : { status: "refused-stock" };
}
