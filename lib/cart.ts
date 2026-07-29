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

export type CartItem = {
  itemId: string;
  name: string;
  price: number;
  quantity: number;
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
