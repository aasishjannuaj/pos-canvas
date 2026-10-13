// v1.3 D-1 — a saved menu item price must be a real, non-negative amount.
//
// WHY THIS EXISTS. The Price input already carries min="0", so the browser's
// own constraint API reports rangeUnderflow the moment a negative value is
// typed. But a number input does not PREVENT typing one, and nothing read that
// verdict: "-5" was accepted, rendered as $-5.00 in the preview, saved, and was
// still there after a reload.
//
// WHY A SAVE BLOCKER AND NOT A CLAMP. Silently rewriting -5 to 0 would change
// the merchant's entered price without telling them, which is how an item ends
// up quietly selling for nothing. This refuses the save and names the item
// instead, using the identical mechanism as the modifier authoring boundary
// (getModifierSaveBlockerMessage) and the empty-project-name check beside it —
// so it introduces no new blocking concept into the editor.
//
// $0.00 REMAINS VALID, deliberately. A free item is a legitimate thing to put
// on a menu, and the checkout RPCs accept it.
//
// THIS IS A SECOND LINE, NOT THE ONLY ONE. complete_sale_v3, v4 and v5 each
// re-price every line from the authorized configuration and already raise
// 'Menu item % has an invalid price' on a negative unit price, so no negative
// price has ever been sellable. What was missing was telling the merchant
// BEFORE they saved a menu their till would later refuse.
import type { MenuItem, ProjectConfig } from "@/lib/projectConfig";

/**
 * Is this a price a menu item may actually be saved with?
 *
 * Finite and at or above zero. NaN and the infinities are rejected explicitly
 * rather than left to `>= 0`, which NaN fails and -Infinity passes in neither
 * direction usefully.
 */
export function isValidMenuItemPrice(price: unknown): boolean {
  return typeof price === "number" && Number.isFinite(price) && price >= 0;
}

/** Every item whose price would be refused, in menu order. */
export function findItemsWithInvalidPrice(config: ProjectConfig): MenuItem[] {
  return config.menuItems.filter((item) => !isValidMenuItemPrice(item.price));
}

/**
 * The sentence the editor shows instead of saving, or null when every price is
 * fine.
 *
 * Names the offending items, because "a price is invalid" on a 40-item menu is
 * not something an owner can act on.
 */
export function getPriceSaveBlockerMessage(config: ProjectConfig): string | null {
  const items = findItemsWithInvalidPrice(config);

  if (items.length === 0) {
    return null;
  }

  const names = items.map((item) => item.name.trim() || "Untitled item");

  if (names.length === 1) {
    return `${names[0]} has a price that is not a valid amount. Enter 0 or more before saving.`;
  }

  return `${names.length} items have a price that is not a valid amount (${names.join(", ")}). Enter 0 or more for each before saving.`;
}
