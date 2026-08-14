import { canonicalLineIdentity } from "@/lib/modifiers";
import type { ModifierSnapshotEntry } from "@/lib/modifiers";
// Feature 14.3 — the shared cart/checkout/order primitives, moved here
// (unchanged in behavior) from components/editor/EditorShell.tsx. None of
// them ever depended on React — they're plain type aliases and one pure
// function — so their previous location was incidental, not required,
// exactly like the normalize* functions extracted to lib/projectConfig.ts
// in Feature 14.1. This module has no React, Supabase, or browser-API
// dependency, so both EditorShell.tsx (the Builder) and
// components/runtime/PosRuntime.tsx (the standalone runtime) can import
// from here directly, and lib/orders.ts/lib/orders.server.ts/
// lib/dashboard.types.ts/lib/dashboard.server.ts no longer need to reach
// into a "use client" component file for their own type signatures.
import type { MenuItem, TaxSettings } from "@/lib/projectConfig";

// Feature 18.2 — one selected modifier option, carried for DISPLAY only.
// The checkout payload sends ids alone; complete_sale_v3 resolves names and
// prices from the authorized config and is the sole authority on both.
export type CartModifierOption = {
  id: string;
  name: string;
  /** Client estimate for the running total. The server recomputes it. */
  priceAdjustment: number;
};

export type CartModifierSelection = {
  groupId: string;
  groupName: string;
  options: CartModifierOption[];
};

export type CartItem = {
  // Feature 18.2 — the LINE identity: product plus canonical selection.
  // "Turkey + Bacon" and "Turkey + Cheese" are different lines of the same
  // product, so every cart operation keys on this rather than on itemId.
  //
  // CLIENT-SIDE ONLY. The server never receives it and would not trust it if
  // it did: complete_sale_v3 recomputes the same identity from the request to
  // detect duplicate lines.
  lineKey: string;
  itemId: string;
  name: string;
  /** base + selected adjustments. A client estimate; the receipt is final. */
  price: number;
  /** The unmodified menu price, kept so the cart can show the breakdown. */
  basePrice: number;
  quantity: number;
  modifiers: CartModifierSelection[];
};

export type CartSummary = {
  itemCount: number;
  subtotal: number;
  taxAmount: number;
  tip: number;
  total: number;
};

export type PaymentMethod = "cash" | "card";

export type CheckoutStatus = "idle" | "success";

export type SaleSaveStatus = "idle" | "saving" | "success" | "error";

export type CompletedOrder = {
  id: string;
  orderNumber: string;
  items: CartItem[];
  subtotal: number;
  taxAmount: number;
  tip: number;
  total: number;
  paymentMethod: PaymentMethod;
  createdAt: string;
};

// Feature 14.3 money safeguard — tip is now an explicit input, never a
// hardcoded assumption baked into this shared function (the previous
// EditorShell-local version accepted `tipsEnabled: boolean` and always
// resolved a true value to a hardcoded sample of 3). This function is used
// by both the Builder — which may still choose to pass a clearly-labeled,
// preview-only sample amount, kept entirely as EditorShell's own local
// constant — and the real runtime, which must always pass a real amount
// (0 in this MVP, since no tip-entry UI exists yet). Neither caller may
// invent a nonzero tip inside this function; a non-finite or negative
// tipAmount is treated the same as no tip at all.
export function calculateCartSummary(
  cart: CartItem[],
  tax: TaxSettings,
  tipAmount: number
): CartSummary {
  const itemCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

  const safeRate = Number.isFinite(tax.rate) && tax.rate > 0 ? tax.rate : 0;

  let taxAmount = 0;
  let totalBeforeTip = subtotal;

  if (tax.enabled) {
    if (tax.pricesIncludeTax) {
      taxAmount = subtotal - subtotal / (1 + safeRate / 100);
      totalBeforeTip = subtotal;
    } else {
      taxAmount = subtotal * (safeRate / 100);
      totalBeforeTip = subtotal + taxAmount;
    }
  }

  const tip = Number.isFinite(tipAmount) && tipAmount > 0 ? tipAmount : 0;

  return {
    itemCount,
    subtotal,
    taxAmount,
    tip,
    total: totalBeforeTip + tip,
  };
}


// ---------------------------------------------------------------------------
// Feature 18.2 — line identity and modifier helpers
// ---------------------------------------------------------------------------

/**
 * Builds a cart line from a menu item and a selection.
 *
 * `price` is the client's running estimate (base + adjustments). It exists so
 * the cart can show a total before the server answers; it is never sent.
 */
export function createCartItem(
  item: MenuItem,
  selections: CartModifierSelection[],
  quantity = 1
): CartItem {
  const adjustments = selections.reduce(
    (sum, group) => sum + group.options.reduce((g, option) => g + option.priceAdjustment, 0),
    0
  );

  return {
    lineKey: canonicalLineIdentity(item.id, toModifierSelections(selections)),
    itemId: item.id,
    name: item.name,
    basePrice: item.price,
    price: item.price + adjustments,
    quantity,
    modifiers: selections,
  };
}

/**
 * Rebuilds a DISPLAY cart line from a line the server already recorded.
 *
 * Feature 18.2 Phase 5A — one implementation, two readers: lib/orders.server.ts
 * maps persisted order_items rows through it, and lib/saleSubmission.ts maps a
 * freshly returned complete_sale_v3 receipt through it. Both are looking at the
 * same thing — the server's own snapshot of what was sold — so a second copy
 * would eventually let a reprinted receipt and a just-completed one disagree.
 *
 * Everything here comes from the SNAPSHOT, never from the current menu: a
 * renamed or repriced option must not rewrite what a customer already bought.
 *
 * `unitPrice` already includes the adjustments (complete_sale_v3 stores the
 * combined figure), so basePrice is derived by subtracting the recorded
 * adjustments rather than looked up anywhere.
 */
export function createHistoricalCartItem(input: {
  itemId: string;
  itemName: string;
  /** The combined unit price the server charged. */
  unitPrice: number;
  quantity: number;
  /** The order_items.modifiers snapshot. A non-array reads as "no modifiers". */
  snapshot: unknown;
}): CartItem {
  const entries: ModifierSnapshotEntry[] = Array.isArray(input.snapshot)
    ? (input.snapshot as ModifierSnapshotEntry[])
    : [];

  // Grouped in first-seen order, so the cart/receipt shows options in the order
  // the server wrote them rather than in an order re-derived here.
  const grouped = new Map<string, CartModifierSelection>();

  for (const entry of entries) {
    const option: CartModifierOption = {
      id: entry.optionId,
      name: entry.optionName,
      // The snapshot stores money as a fixed two-decimal string. This is the one
      // place it becomes a number, and only because CartItem — the Builder's
      // preview/reporting model — has always been number-typed. The authoritative
      // figure a customer is shown still comes from CompletedSaleReceipt, whose
      // strings are rendered directly and never parsed.
      priceAdjustment: Number(entry.priceAdjustment),
    };

    const existing = grouped.get(entry.groupId);

    if (existing) {
      existing.options.push(option);
    } else {
      grouped.set(entry.groupId, {
        groupId: entry.groupId,
        groupName: entry.groupName,
        options: [option],
      });
    }
  }

  const modifiers = [...grouped.values()];
  const adjustments = modifiers.reduce(
    (sum, group) => sum + group.options.reduce((g, option) => g + option.priceAdjustment, 0),
    0
  );

  return {
    lineKey: canonicalLineIdentity(input.itemId, toModifierSelections(modifiers)),
    itemId: input.itemId,
    name: input.itemName,
    basePrice: input.unitPrice - adjustments,
    price: input.unitPrice,
    quantity: input.quantity,
    modifiers,
  };
}

/** Strips display data down to the identifiers the checkout payload may carry. */
export function toModifierSelections(
  selections: readonly CartModifierSelection[]
): { groupId: string; optionIds: string[] }[] {
  return selections
    .filter((group) => group.options.length > 0)
    .map((group) => ({
      groupId: group.groupId,
      optionIds: group.options.map((option) => option.id),
    }));
}

/**
 * Total quantity of one PRODUCT across every line in the cart.
 *
 * Stock is held against the product, not the line, so "Turkey + Bacon" and
 * "Turkey + Cheese" draw on the same inventory and must be counted together.
 */
export function getItemQuantityInCart(cart: readonly CartItem[], itemId: string): number {
  return cart.reduce((sum, line) => (line.itemId === itemId ? sum + line.quantity : sum), 0);
}

/** The modifier lines shown under a cart entry, in stable display order. */
export function describeCartModifiers(item: CartItem): CartModifierOption[] {
  return item.modifiers.flatMap((group) => group.options);
}

type CanAddItemQuantityInput = {
  item: MenuItem;
  currentQuantity: number;
  addQuantity: number;
};

// Feature 14.3 — the single shared stock-limit predicate, so the Builder's
// cart handlers and the runtime's cart handlers can share one rule instead
// of two hand-written copies that could silently drift apart. Pure — reads
// its inputs only, never mutates the passed-in item.
//   - an untracked item is always allowed (once the quantity arguments
//     themselves are sane).
//   - a tracked item at or below zero stock can never be added to.
//   - a tracked item cannot be pushed past its stockQuantity.
//   - a non-finite, zero, or negative addQuantity is rejected outright, as
//     is a non-finite or negative currentQuantity.
export function canAddItemQuantity({
  item,
  currentQuantity,
  addQuantity,
}: CanAddItemQuantityInput): boolean {
  if (!Number.isFinite(addQuantity) || addQuantity <= 0) {
    return false;
  }

  if (!Number.isFinite(currentQuantity) || currentQuantity < 0) {
    return false;
  }

  if (!item.trackInventory) {
    return true;
  }

  if (item.stockQuantity <= 0) {
    return false;
  }

  return currentQuantity + addQuantity <= item.stockQuantity;
}
