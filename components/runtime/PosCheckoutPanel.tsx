"use client";

import { useState } from "react";
import type {
  CartItem,
  CartSummary,
  CheckoutStatus,
  CompletedOrder,
  PaymentMethod,
  SaleSaveStatus,
} from "@/lib/cart";
import type { MenuItem, ProjectConfig } from "@/lib/projectConfig";
import {
  NATIVE_PRINT_UNAVAILABLE_MESSAGE,
  isCapacitorNativeShell,
} from "@/lib/nativeShell";
import Receipt from "@/components/editor/Receipt";
import AuthoritativeReceipt from "@/components/runtime/AuthoritativeReceipt";
import { describeCartModifiers, getItemQuantityInCart } from "@/lib/cart";
import type { CompletedSaleReceipt } from "@/lib/completedSale";

// Feature 14.3 — the shared cart/checkout/receipt UI, extracted from
// EditorPreview.tsx's preview-mode branch so it isn't duplicated between
// the Builder's own live preview and the standalone runtime
// (components/runtime/PosRuntime.tsx). Both callers render the exact same
// markup/behavior here; only the Builder's edit-mode-only static mock
// (STATIC_TIP/STATIC_SUBTOTAL and the non-interactive summary footer)
// stayed behind in EditorPreview.tsx, since that's a Builder-only concept
// this panel has no reason to know about.
//
// Deliberately receives a focused set of primitives/callbacks, never the
// whole EditorShell or ProjectConfig — menuItems/tax/receipt/businessProfile/
// branding are the same neutral nested types already used throughout the
// Builder's own prop typing convention (ProjectConfig["..."] as a type
// annotation only, not the object itself being threaded through).
type PosCheckoutPanelProps = {
  menuItems: MenuItem[];
  cart: CartItem[];
  cartSummary: CartSummary;
  currencySymbol: string;
  orderNumber: string;
  tax: ProjectConfig["tax"];
  receipt: ProjectConfig["receipt"];
  businessProfile: ProjectConfig["businessProfile"];
  branding: ProjectConfig["branding"];

  onIncreaseQuantity: (itemId: string) => void;
  onDecreaseQuantity: (itemId: string) => void;
  onRemoveFromCart: (itemId: string) => void;
  onClearCart: () => void;

  checkoutOpen: boolean;
  onOpenCheckout: () => void;
  onCloseCheckout: () => void;
  selectedPaymentMethod: PaymentMethod | null;
  onSelectPaymentMethod: (method: PaymentMethod) => void;
  checkoutStatus: CheckoutStatus;
  onCompleteSale: () => void;
  saleSaveStatus: SaleSaveStatus;
  saleSaveError: string | null;

  // Feature 14.3 — deliberately the caller's own already-sliced list, not a
  // full order-history prop: EditorPreview passes its real
  // completedOrders.slice(0, 5) (unchanged Builder behavior); PosRuntime
  // passes an empty array, since the runtime intentionally doesn't carry a
  // growing order history (recent-orders reprint isn't required by the
  // receipt flow itself — only viewing the order just completed is).
  recentOrders: CompletedOrder[];
  lastCompletedOrderId: string | null;
  onOpenReceipt: (orderId: string) => void;
  selectedOrder: CompletedOrder | null;
  // Feature 16.3 D3 — when set, the overlay renders the AUTHORITATIVE
  // server receipt instead of the preview model. EditorPreview never passes
  // it, so the Builder preview path is byte-identical to before.
  authoritativeReceipt?: CompletedSaleReceipt | null;
  onCloseReceipt: () => void;
};

function formatOrderTime(createdAt: string): string {
  return new Date(createdAt).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function PosCheckoutPanel({
  menuItems,
  cart,
  cartSummary,
  currencySymbol,
  orderNumber,
  tax,
  receipt,
  businessProfile,
  branding,
  onIncreaseQuantity,
  onDecreaseQuantity,
  onRemoveFromCart,
  onClearCart,
  checkoutOpen,
  onOpenCheckout,
  onCloseCheckout,
  selectedPaymentMethod,
  onSelectPaymentMethod,
  checkoutStatus,
  onCompleteSale,
  saleSaveStatus,
  saleSaveError,
  recentOrders,
  lastCompletedOrderId,
  onOpenReceipt,
  selectedOrder,
  authoritativeReceipt = null,
  onCloseReceipt,
}: PosCheckoutPanelProps) {
  // Feature 16.2 — only ever set inside the Android shell, where printing
  // is unavailable. Stored alongside the order it was raised for and then
  // matched during render, so a notice from a previous receipt is simply
  // not displayed once a different receipt is opened. This derives the
  // reset instead of clearing it from an effect (which React flags via
  // react-hooks/set-state-in-effect, and which would be an extra render for
  // no benefit).
  const [printNotice, setPrintNotice] = useState<{
    orderId: string;
    message: string;
  } | null>(null);

  // One id for either receipt model, so the print notice keys correctly.
  const shownReceiptId = authoritativeReceipt?.orderId ?? selectedOrder?.id ?? null;
  const receiptVisible = authoritativeReceipt !== null || selectedOrder !== null;

  const activePrintNotice =
    printNotice !== null && printNotice.orderId === shownReceiptId
      ? printNotice.message
      : null;

  function handlePrintReceipt() {
    if (shownReceiptId === null) {
      return;
    }

    if (isCapacitorNativeShell()) {
      setPrintNotice({
        orderId: shownReceiptId,
        message: NATIVE_PRINT_UNAVAILABLE_MESSAGE,
      });
      return;
    }

    setPrintNotice(null);
    window.print();
  }

  return (
    <>
      {/* Order Summary / Cart */}
      <div className="flex-none border-t border-neutral-200 bg-neutral-50 px-4 py-3">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
            Order {orderNumber}
          </span>
          {cart.length > 0 && (
            <button
              type="button"
              onClick={onClearCart}
              className="text-[11px] font-medium text-neutral-500 transition-colors hover:text-red-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
            >
              Clear Cart
            </button>
          )}
        </div>

        {cart.length === 0 ? (
          <div className="flex flex-col items-center gap-1 py-4 text-center">
            <p className="text-xs font-medium text-neutral-600">Cart is empty</p>
            <p className="text-xs text-neutral-400">Tap a menu item to add it.</p>
          </div>
        ) : (
          <div className="mb-2 flex max-h-28 flex-col gap-2 overflow-y-auto">
            {cart.map((cartItem) => {
              const menuItem = menuItems.find((item) => item.id === cartItem.itemId);
              const atStockLimit =
                // Feature 18.2 — stock is held against the PRODUCT, so two
                // lines of the same item with different modifiers share one
                // pool and must be counted together.
                !!menuItem?.trackInventory &&
                getItemQuantityInCart(cart, cartItem.itemId) >= menuItem.stockQuantity;

              return (
                <div
                  key={cartItem.lineKey}
                  className="flex items-center justify-between gap-2 text-xs text-neutral-600"
                >
                  <span className="flex-1 truncate text-neutral-900">
                    {cartItem.name}
                    {/* Feature 18.2 — the chosen options, shown under the
                        product. A plain line renders nothing extra, so a
                        pre-modifier cart looks exactly as it always did. */}
                    {cartItem.modifiers.length > 0 && (
                      <span className="mt-0.5 flex flex-col gap-0.5">
                        {describeCartModifiers(cartItem).map((option) => (
                          <span
                            key={option.id}
                            className="flex items-baseline justify-between gap-2 text-[11px] font-normal text-neutral-500"
                          >
                            <span>{option.name}</span>
                            {option.priceAdjustment > 0 && (
                              <span className="tabular-nums">
                                +{currencySymbol}
                                {option.priceAdjustment.toFixed(2)}
                              </span>
                            )}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onDecreaseQuantity(cartItem.lineKey)}
                      aria-label={`Decrease ${cartItem.name} quantity`}
                      className="flex h-5 w-5 items-center justify-center rounded-full border border-neutral-200 text-neutral-600 transition-colors hover:border-blue-600 hover:text-blue-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                    >
                      −
                    </button>
                    <span className="w-4 text-center text-neutral-900">
                      {cartItem.quantity}
                    </span>
                    <button
                      type="button"
                      onClick={() => onIncreaseQuantity(cartItem.lineKey)}
                      disabled={atStockLimit}
                      aria-label={`Increase ${cartItem.name} quantity`}
                      className={`flex h-5 w-5 items-center justify-center rounded-full border border-neutral-200 text-neutral-600 transition-colors hover:border-blue-600 hover:text-blue-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
                        atStockLimit ? "cursor-not-allowed opacity-40" : ""
                      }`}
                    >
                      +
                    </button>
                  </div>

                  <span className="w-12 text-right font-medium text-neutral-900">
                    {currencySymbol}
                    {(cartItem.price * cartItem.quantity).toFixed(2)}
                  </span>

                  <button
                    type="button"
                    onClick={() => onRemoveFromCart(cartItem.lineKey)}
                    aria-label={`Remove ${cartItem.name} from cart`}
                    className="text-neutral-400 transition-colors hover:text-red-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex flex-col gap-1 border-t border-neutral-200 pt-2">
          <div className="flex items-center justify-between text-xs text-neutral-600">
            <span>Subtotal</span>
            <span>
              {currencySymbol}
              {cartSummary.subtotal.toFixed(2)}
            </span>
          </div>

          {tax.enabled && tax.showTaxSeparately && (
            <div className="flex items-center justify-between text-xs text-neutral-600">
              <span>Tax</span>
              <span>
                {currencySymbol}
                {cartSummary.taxAmount.toFixed(2)}
              </span>
            </div>
          )}

          {receipt.tipsEnabled && (
            <div className="flex items-center justify-between text-xs text-neutral-600">
              <span>Tip</span>
              <span>
                {currencySymbol}
                {cartSummary.tip.toFixed(2)}
              </span>
            </div>
          )}

          <div className="flex items-center justify-between border-t border-neutral-200 pt-1 text-sm font-semibold text-neutral-900">
            <span>Total</span>
            <span>
              {currencySymbol}
              {cartSummary.total.toFixed(2)}
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={onOpenCheckout}
          disabled={cart.length === 0}
          className="mt-2 w-full rounded-full bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Checkout
        </button>

        <p className="mt-2 text-center text-[11px] text-neutral-400">
          {receipt.footer}
        </p>

        {recentOrders.length > 0 && (
          <div className="mt-3 border-t border-neutral-200 pt-3">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
              Recent Orders
            </p>

            <div className="flex max-h-24 flex-col gap-1 overflow-y-auto">
              {recentOrders.map((order) => (
                <button
                  key={order.id}
                  type="button"
                  onClick={() => onOpenReceipt(order.id)}
                  className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                >
                  <span className="font-medium text-neutral-900">
                    {order.orderNumber}
                  </span>
                  <span className="text-neutral-500">
                    {order.paymentMethod === "cash" ? "Cash" : "Card"}
                  </span>
                  <span className="text-neutral-400">
                    {formatOrderTime(order.createdAt)}
                  </span>
                  <span className="font-medium text-neutral-900">
                    {currencySymbol}
                    {order.total.toFixed(2)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Checkout overlay */}
      {checkoutOpen && (
        <div className="absolute inset-0 z-10 flex flex-col justify-between bg-white p-4">
          {checkoutStatus === "success" ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
              <span className="text-2xl">✅</span>
              <p className="text-sm font-semibold text-neutral-900">
                Sale completed
              </p>
              <p className="text-xs text-neutral-500">The cart has been cleared.</p>

              {/* Feature 9.3 — non-blocking inventory refresh warning. The
                  sale already succeeded; this is informational only, never
                  styled or worded as a failure. */}
              {saleSaveError && (
                <p className="mt-1 max-w-[220px] text-xs text-amber-600">
                  {saleSaveError}
                </p>
              )}

              <div className="mt-4 flex w-full flex-col gap-2">
                {/* Feature 11.1 — opens the same receipt overlay used for
                    reprinting from Recent Orders, targeting the exact
                    order this checkout just confirmed. The user still has
                    to explicitly tap Print Receipt from there — this does
                    not trigger window.print() itself. */}
                {lastCompletedOrderId && (
                  <button
                    type="button"
                    onClick={() => onOpenReceipt(lastCompletedOrderId)}
                    className="w-full rounded-full border border-neutral-200 px-5 py-2 text-sm font-medium text-neutral-700 transition-colors hover:border-blue-600 hover:text-blue-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                  >
                    View Receipt
                  </button>
                )}

                <button
                  type="button"
                  onClick={onCloseCheckout}
                  className="w-full rounded-full bg-blue-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-4">
                <p className="text-sm font-semibold text-neutral-900">Checkout</p>

                <div className="flex items-center justify-between rounded-xl border border-neutral-200 px-4 py-3">
                  <span className="text-sm text-neutral-600">Order Total</span>
                  <span className="text-lg font-semibold text-neutral-900">
                    {currencySymbol}
                    {cartSummary.total.toFixed(2)}
                  </span>
                </div>

                <div className="flex flex-col gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                    Payment Method
                  </span>

                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => onSelectPaymentMethod("cash")}
                      className={`rounded-xl border px-4 py-3 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
                        selectedPaymentMethod === "cash"
                          ? "text-white"
                          : "border-neutral-200 text-neutral-700 hover:border-blue-600 hover:text-blue-600"
                      }`}
                      style={
                        selectedPaymentMethod === "cash"
                          ? {
                              backgroundColor: branding.accentColor,
                              borderColor: branding.accentColor,
                            }
                          : undefined
                      }
                    >
                      Cash
                    </button>

                    <button
                      type="button"
                      onClick={() => onSelectPaymentMethod("card")}
                      className={`rounded-xl border px-4 py-3 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
                        selectedPaymentMethod === "card"
                          ? "text-white"
                          : "border-neutral-200 text-neutral-700 hover:border-blue-600 hover:text-blue-600"
                      }`}
                      style={
                        selectedPaymentMethod === "card"
                          ? {
                              backgroundColor: branding.accentColor,
                              borderColor: branding.accentColor,
                            }
                          : undefined
                      }
                    >
                      Card
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                {saleSaveStatus === "saving" && (
                  <p className="text-center text-xs text-neutral-500">
                    Saving sale...
                  </p>
                )}

                {saleSaveStatus === "error" && saleSaveError && (
                  <p className="text-center text-xs text-red-600">
                    {saleSaveError}
                  </p>
                )}

                <button
                  type="button"
                  onClick={onCompleteSale}
                  disabled={!selectedPaymentMethod || saleSaveStatus === "saving"}
                  className="w-full rounded-full bg-blue-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saleSaveStatus === "saving" ? "Saving..." : "Complete Sale"}
                </button>

                <button
                  type="button"
                  onClick={onCloseCheckout}
                  className="w-full rounded-full border border-neutral-200 px-5 py-2.5 text-sm font-medium text-neutral-700 transition-colors hover:border-neutral-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Receipt preview overlay. Feature 14.3 — deliberately does NOT also
          render the print-only .receipt-print-area copy here: that element
          needs to be a top-level sibling of whatever overflow-hidden
          container this panel is mounted inside (the Builder's phone
          mockup, or the runtime's own layout), since an ancestor's
          `overflow: hidden` can clip an absolutely-positioned descendant
          even under the print stylesheet. Each host (EditorPreview,
          PosRuntime) renders its own print-only copy outside that
          container, using the same selectedOrder/businessProfile/receipt
          it already passes in here — see app/globals.css's
          .receipt-print-area rules for why the DOM position matters. */}
      {receiptVisible && (
        <div className="absolute inset-0 z-10 flex flex-col bg-white p-4">
          <div className="flex-1 overflow-y-auto">
            {authoritativeReceipt ? (
              <AuthoritativeReceipt
                receipt={authoritativeReceipt}
                businessProfile={businessProfile}
                receiptSettings={receipt}
                currencySymbol={currencySymbol}
              />
            ) : (
              <Receipt order={selectedOrder!} businessProfile={businessProfile} receipt={receipt} />
            )}
          </div>

          <div className="flex flex-col gap-2 pt-3">
            {/* Feature 16.2 — inside the Capacitor Android shell,
                window.print() does not reach a print dialog, so the button
                previously appeared to work while doing nothing. It now
                reports that truthfully instead. Detection uses Capacitor's
                own isNativePlatform() (see lib/nativeShell.ts), not
                user-agent guessing. Ordinary browsers are unaffected and
                still call window.print(); the on-screen receipt above stays
                available in both cases. Native printing is deliberately not
                implemented in this feature. */}
            <button
              type="button"
              onClick={handlePrintReceipt}
              className="w-full rounded-full border border-neutral-200 px-5 py-2.5 text-sm font-medium text-neutral-700 transition-colors hover:border-blue-600 hover:text-blue-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
            >
              Print Receipt
            </button>

            {activePrintNotice && (
              <p
                aria-live="polite"
                className="text-center text-xs text-neutral-500"
              >
                {activePrintNotice}
              </p>
            )}

            <button
              type="button"
              onClick={onCloseReceipt}
              className="w-full rounded-full bg-blue-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
}
