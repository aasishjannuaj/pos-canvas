// Feature 18.2 Phase 5A — the ONE description of what a checkout attempt sends,
// and of what comes back.
//
// WHY THIS MODULE EXISTS. Before Phase 5A there were two checkout
// implementations: components/runtime/PosRuntime.tsx (owner runtime + paired
// device, complete_sale_v3) and components/editor/EditorShell.tsx (Builder
// Preview, still complete_sale v1 with client-supplied totals). Phase 3 made the
// Builder Preview cart modifier-bearing, so the second implementation could
// persist modifier-adjusted money that v1 neither recomputed nor recorded.
//
// Migrating the Builder to v3 by copying PosRuntime's completeSale body would
// have replaced one divergence with another, slower one. Instead the parts that
// must be identical on every surface — what leaves the browser, when an attempt
// is allowed to start, and which request id it carries — live here, once, as
// pure functions. Each host keeps only what genuinely differs: its transport
// (owner cookie client vs device client) and what it does with the receipt
// afterwards (the runtime shows one; the Builder also updates its dashboards).
//
// Dependency-free in the same sense as lib/cart.ts and lib/saleRequest.ts: no
// React, no Supabase, no browser API beyond the crypto injection lib/saleRequest
// already isolates. Every rule below is therefore unit-testable under plain Node.
//
// TRUST MODEL, restated because this module is where it is enforced: the payload
// carries identifiers and quantities ONLY. There is deliberately nowhere in
// SaleSubmissionItem to put a name, a price, a tax amount or a total.
// complete_sale_v3 resolves all of them from the authorized config, and the
// receipt it returns is the only record of what was actually charged.
import {
  canAddItemQuantity,
  createHistoricalCartItem,
  getItemQuantityInCart,
  toModifierSelections,
} from "@/lib/cart";
import type { CartItem, CompletedOrder, PaymentMethod } from "@/lib/cart";
import type { CompletedSaleReceipt } from "@/lib/completedSale";
import type { MenuItem } from "@/lib/projectConfig";
import {
  createSaleFingerprint,
  resolveSaleRequest,
} from "@/lib/saleRequest";
import type { SaleRequestState } from "@/lib/saleRequest";

// ---------------------------------------------------------------------------
// Messages
//
// Exported constants rather than inline strings so both hosts say the same
// thing, and so a test can pin the wording of the one message that must never
// claim a sale failed.
// ---------------------------------------------------------------------------

export const SALE_INSUFFICIENT_STOCK_MESSAGE =
  "One or more items are no longer available in the requested quantity.";

export const SALE_INSECURE_BROWSER_MESSAGE =
  "This browser cannot complete a secure sale. Please use a different browser.";

/**
 * The retry message for a failed or lost response.
 *
 * It must NOT assert that the sale did not happen: a transport failure may have
 * committed server-side, and pressing Pay again replays the same request id and
 * returns the original receipt.
 */
export const SALE_UNCONFIRMED_MESSAGE =
  "The sale could not be confirmed. Press Pay again to retry — if it already went through, the original receipt will be shown.";

// ---------------------------------------------------------------------------
// The request payload
// ---------------------------------------------------------------------------

/**
 * One line as it crosses the wire. Identifiers and a quantity, nothing else.
 *
 * Structurally identical to the item shape in CompleteSaleV3Request and
 * PosRuntimeCompleteSale — deliberately, so a host cannot widen one of them
 * without the mismatch surfacing at the type level.
 */
export type SaleSubmissionItem = {
  itemId: string;
  quantity: number;
  modifiers: { groupId: string; optionIds: string[] }[];
};

/**
 * Builds the checkout payload from the cart.
 *
 * toModifierSelections drops every display name and price adjustment, and every
 * other CartItem field (name, price, basePrice, lineKey) is simply not read. A
 * cart line therefore cannot leak a client-chosen amount into the request even
 * if one were somehow set.
 *
 * lineKey in particular is NOT sent: complete_sale_v3 recomputes the canonical
 * line identity from the request it actually received, and would not trust a
 * client-supplied one.
 */
export function buildSaleRequestItems(
  cart: readonly CartItem[]
): SaleSubmissionItem[] {
  return cart.map((cartItem) => ({
    itemId: cartItem.itemId,
    quantity: cartItem.quantity,
    modifiers: toModifierSelections(cartItem.modifiers),
  }));
}

// ---------------------------------------------------------------------------
// The pre-submit stock re-check
// ---------------------------------------------------------------------------

/**
 * True when the cart asks for more of some product than local stock allows.
 *
 * Re-checked immediately before submitting because stock may have moved since
 * the items were added (another terminal selling the same project). Counted per
 * PRODUCT, not per line: two lines of the same item with different modifiers
 * draw on one pool, so validating them separately would let a cart through that
 * the server will reject.
 *
 * An item the local menu does not know about is skipped rather than blocked —
 * the server is the authority and will reject it if it is genuinely unsellable.
 */
export function hasInsufficientStock(
  cart: readonly CartItem[],
  menuItems: readonly MenuItem[]
): boolean {
  const productIds = new Set(cart.map((cartItem) => cartItem.itemId));

  for (const itemId of productIds) {
    const menuItem = menuItems.find((item) => item.id === itemId);

    if (menuItem === undefined) {
      continue;
    }

    // Checked against 0 rather than the cart's own quantity, so this validates
    // the WHOLE requested amount against current stock, not an increment.
    if (
      !canAddItemQuantity({
        item: menuItem,
        currentQuantity: 0,
        addQuantity: getItemQuantityInCart(cart, itemId),
      })
    ) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Planning one attempt
// ---------------------------------------------------------------------------

export type SaleSubmissionPlan =
  | { ok: false; error: string }
  | { ok: true; request: SaleRequestState; items: SaleSubmissionItem[] };

/**
 * Everything that must be decided before a checkout request is sent.
 *
 * Returns the request id to use and the exact payload to send, or the message
 * to show instead. Deliberately pure: it performs no I/O, sets no state and
 * makes no decision about what to do with the answer, so a host cannot get a
 * different payload than another host from the same cart.
 *
 * `current` is the host's existing request state. resolveSaleRequest reuses its
 * id when the fingerprint is unchanged (the retry case, which is what makes a
 * lost response replay instead of double-selling) and issues a new one whenever
 * anything the server hashes has changed.
 */
export function planSaleSubmission(input: {
  projectId: string;
  paymentMethod: PaymentMethod;
  tipAmount: number;
  cart: readonly CartItem[];
  menuItems: readonly MenuItem[];
  current: SaleRequestState | null;
  /** Injected only by tests; production always uses createSaleRequestId. */
  generate?: () => string;
}): SaleSubmissionPlan {
  if (hasInsufficientStock(input.cart, input.menuItems)) {
    return { ok: false, error: SALE_INSUFFICIENT_STOCK_MESSAGE };
  }

  const fingerprint = createSaleFingerprint({
    projectId: input.projectId,
    paymentMethod: input.paymentMethod,
    tipAmount: input.tipAmount,
    items: input.cart,
  });

  let request: SaleRequestState;

  try {
    request =
      input.generate === undefined
        ? resolveSaleRequest(input.current, fingerprint)
        : resolveSaleRequest(input.current, fingerprint, input.generate);
  } catch {
    // createSaleRequestId throws rather than falling back to Math.random:
    // colliding ids across two terminals would cross-wire two receipts.
    return { ok: false, error: SALE_INSECURE_BROWSER_MESSAGE };
  }

  return { ok: true, request, items: buildSaleRequestItems(input.cart) };
}

// ---------------------------------------------------------------------------
// Reading the answer
// ---------------------------------------------------------------------------

/**
 * Projects an authoritative receipt into the Builder's number-based
 * CompletedOrder model.
 *
 * WHAT THIS IS FOR, precisely. The Builder's Recent Orders list, Dashboard,
 * Sales Report, Product Performance and Inventory Summary are all seeded from
 * lib/orders.server.ts / lib/dashboard.server.ts, which read numeric columns and
 * hand back JavaScript numbers. A sale completed in the current session has to
 * appear in those panels without a page reload, so it has to enter the same
 * number-typed model they already hold.
 *
 * WHAT IT IS NOT FOR. It is not the receipt. The customer-facing receipt is
 * rendered from CompletedSaleReceipt directly (AuthoritativeReceipt), whose
 * fixed two-decimal strings are printed as-is and never parsed — that
 * representation exists precisely to avoid an IEEE-754 round-trip. The numbers
 * produced here feed reporting panels only, and every one of them originates
 * from the server's own answer rather than from the cart that was submitted.
 */
export function toCompletedOrder(receipt: CompletedSaleReceipt): CompletedOrder {
  return {
    id: receipt.orderId,
    orderNumber: receipt.orderNumber,
    items: receipt.items.map((item) =>
      createHistoricalCartItem({
        itemId: item.itemId,
        itemName: item.itemName,
        unitPrice: Number(item.unitPrice),
        quantity: item.quantity,
        snapshot: item.modifiers,
      })
    ),
    subtotal: Number(receipt.subtotal),
    taxAmount: Number(receipt.taxAmount),
    tip: Number(receipt.tipAmount),
    total: Number(receipt.total),
    paymentMethod: receipt.paymentMethod,
    createdAt: receipt.createdAt,
  };
}
