"use client";

import { CURRENCY_SYMBOLS, MENU_CATEGORIES } from "./EditorShell";
import type {
  CartItem,
  CartSummary,
  CheckoutStatus,
  CompletedOrder,
  EditorMode,
  MenuItem,
  PaymentMethod,
  ProjectConfig,
  SaleSaveStatus,
} from "./EditorShell";

// Static preview-only figures used only for the unchanged edit-mode mock below.
const STATIC_TIP = 3;
const STATIC_SUBTOTAL = 20;

type EditorPreviewProps = {
  menuItems: MenuItem[];
  selectedItemId: string | null;
  onSelect: (id: string) => void;
  branding: ProjectConfig["branding"];
  tax: ProjectConfig["tax"];
  receipt: ProjectConfig["receipt"];
  editorMode: EditorMode;
  cart: CartItem[];
  cartSummary: CartSummary;
  onAddToCart: (menuItem: MenuItem) => void;
  onIncreaseQuantity: (itemId: string) => void;
  onDecreaseQuantity: (itemId: string) => void;
  onRemoveFromCart: (itemId: string) => void;
  onClearCart: () => void;
  checkoutOpen: boolean;
  selectedPaymentMethod: PaymentMethod | null;
  checkoutStatus: CheckoutStatus;
  onOpenCheckout: () => void;
  onCloseCheckout: () => void;
  onSelectPaymentMethod: (method: PaymentMethod) => void;
  onCompleteSale: () => void;
  saleSaveStatus: SaleSaveStatus;
  saleSaveError: string | null;
  completedOrders: CompletedOrder[];
  selectedReceiptId: string | null;
  onOpenReceipt: (orderId: string) => void;
  onCloseReceipt: () => void;
};

function calculateOrderSummary(tax: {
  enabled: boolean;
  rate: number;
  pricesIncludeTax: boolean;
}) {
  const subtotal = STATIC_SUBTOTAL;
  const safeRate = Number.isFinite(tax.rate) && tax.rate > 0 ? tax.rate : 0;

  if (!tax.enabled) {
    return { subtotal, taxAmount: 0, total: subtotal };
  }

  if (tax.pricesIncludeTax) {
    const taxAmount = subtotal - subtotal / (1 + safeRate / 100);
    return { subtotal, taxAmount, total: subtotal };
  }

  const taxAmount = subtotal * (safeRate / 100);
  return { subtotal, taxAmount, total: subtotal + taxAmount };
}

function formatOrderTime(createdAt: string): string {
  return new Date(createdAt).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatReceiptDateTime(createdAt: string): string {
  return new Date(createdAt).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getStockLabel(item: MenuItem): string {
  if (!item.trackInventory) {
    return "Inventory off";
  }

  if (item.stockQuantity <= 0) {
    return "Out of stock";
  }

  return `Stock: ${item.stockQuantity}`;
}

export default function EditorPreview({
  menuItems,
  selectedItemId,
  onSelect,
  branding,
  tax,
  receipt,
  editorMode,
  cart,
  cartSummary,
  onAddToCart,
  onIncreaseQuantity,
  onDecreaseQuantity,
  onRemoveFromCart,
  onClearCart,
  checkoutOpen,
  selectedPaymentMethod,
  checkoutStatus,
  onOpenCheckout,
  onCloseCheckout,
  onSelectPaymentMethod,
  onCompleteSale,
  saleSaveStatus,
  saleSaveError,
  completedOrders,
  selectedReceiptId,
  onOpenReceipt,
  onCloseReceipt,
}: EditorPreviewProps) {
  const currencySymbol = CURRENCY_SYMBOLS[receipt.currency];
  const orderNumber = `${receipt.orderPrefix}1001`;

  // Edit-mode summary math — unchanged from before Feature 7.2.
  const editModeSummary = calculateOrderSummary(tax);
  const editModeFinalTotal = receipt.tipsEnabled
    ? editModeSummary.total + STATIC_TIP
    : editModeSummary.total;

  const recentOrders = completedOrders.slice(-5).reverse();
  const selectedOrder =
    completedOrders.find((order) => order.id === selectedReceiptId) ?? null;

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 overflow-auto bg-neutral-100 p-10">
      {editorMode === "preview" && (
        <span className="rounded-full bg-neutral-900/80 px-3 py-1 text-xs font-medium uppercase tracking-wide text-white">
          Preview Mode
        </span>
      )}

      <div className="relative flex aspect-[9/16] w-full max-w-sm flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
        {/* POS Header */}
        <div
          className="flex-none px-4 py-3"
          style={{ backgroundColor: branding.accentColor }}
        >
          <span className="text-sm font-semibold tracking-tight text-white">
            {branding.businessName}
          </span>
        </div>

        {/* Section Tabs */}
        <div className="flex flex-none gap-2 border-b border-neutral-200 bg-white px-3 py-2">
          {MENU_CATEGORIES.map((section, index) => (
            <span
              key={section}
              className={
                index === 0
                  ? "rounded-full px-3 py-1.5 text-xs font-medium text-white"
                  : "rounded-full bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-600"
              }
              style={index === 0 ? { backgroundColor: branding.accentColor } : undefined}
            >
              {section}
            </span>
          ))}
        </div>

        {/* Menu Content */}
        <div className="flex-1 overflow-y-auto px-3 py-3">
          <div className="flex flex-col gap-4">
            {MENU_CATEGORIES.map((section) => {
              const sectionItems = menuItems.filter(
                (item) => item.category === section
              );

              if (sectionItems.length === 0) {
                return null;
              }

              return (
                <div key={section} className="flex flex-col gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                    {section}
                  </span>

                  <div className="grid grid-cols-2 gap-2">
                    {sectionItems.map((item) => {
                      const isSelected =
                        editorMode === "edit" && selectedItemId === item.id;
                      const isOutOfStock =
                        editorMode === "preview" &&
                        item.trackInventory &&
                        item.stockQuantity <= 0;

                      return (
                        <button
                          key={item.id}
                          type="button"
                          disabled={isOutOfStock}
                          onClick={() => {
                            if (editorMode === "edit") {
                              onSelect(item.id);
                            } else if (!isOutOfStock) {
                              onAddToCart(item);
                            }
                          }}
                          className={`flex flex-col justify-between gap-2 rounded-lg border p-2.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
                            isSelected
                              ? "text-white"
                              : "border-neutral-200 bg-neutral-50 hover:border-neutral-300"
                          } ${isOutOfStock ? "cursor-not-allowed opacity-40" : ""}`}
                          style={
                            isSelected
                              ? {
                                  backgroundColor: branding.accentColor,
                                  borderColor: branding.accentColor,
                                }
                              : undefined
                          }
                        >
                          <span
                            className={`text-xs font-medium leading-tight ${
                              isSelected ? "text-white" : "text-neutral-900"
                            }`}
                          >
                            {item.name}
                          </span>
                          <span
                            className="text-xs font-semibold"
                            style={{
                              color: isSelected ? "#FFFFFF" : branding.accentColor,
                            }}
                          >
                            {currencySymbol}
                            {item.price.toFixed(2)}
                          </span>
                          {editorMode === "edit" && (
                            <span className="text-[10px] font-normal text-neutral-400">
                              {getStockLabel(item)}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Order Summary / Cart */}
        {editorMode === "preview" ? (
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
                  const menuItem = menuItems.find(
                    (item) => item.id === cartItem.itemId
                  );
                  const atStockLimit =
                    !!menuItem?.trackInventory &&
                    cartItem.quantity >= menuItem.stockQuantity;

                  return (
                    <div
                      key={cartItem.itemId}
                      className="flex items-center justify-between gap-2 text-xs text-neutral-600"
                    >
                      <span className="flex-1 truncate text-neutral-900">
                        {cartItem.name}
                      </span>

                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => onDecreaseQuantity(cartItem.itemId)}
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
                          onClick={() => onIncreaseQuantity(cartItem.itemId)}
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
                        onClick={() => onRemoveFromCart(cartItem.itemId)}
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

            {completedOrders.length > 0 && (
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
        ) : (
          <div className="flex-none border-t border-neutral-200 bg-neutral-50 px-4 py-3">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
              Order {orderNumber}
            </div>

            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-xs text-neutral-600">
                <span>Subtotal</span>
                <span>
                  {currencySymbol}
                  {editModeSummary.subtotal.toFixed(2)}
                </span>
              </div>

              {tax.enabled && tax.showTaxSeparately && (
                <div className="flex items-center justify-between text-xs text-neutral-600">
                  <span>Tax</span>
                  <span>
                    {currencySymbol}
                    {editModeSummary.taxAmount.toFixed(2)}
                  </span>
                </div>
              )}

              {receipt.tipsEnabled && (
                <div className="flex items-center justify-between text-xs text-neutral-600">
                  <span>Tip</span>
                  <span>
                    {currencySymbol}
                    {STATIC_TIP.toFixed(2)}
                  </span>
                </div>
              )}

              <div className="flex items-center justify-between border-t border-neutral-200 pt-1 text-sm font-semibold text-neutral-900">
                <span>Total</span>
                <span>
                  {currencySymbol}
                  {editModeFinalTotal.toFixed(2)}
                </span>
              </div>
            </div>

            <p className="mt-2 text-center text-[11px] text-neutral-400">
              {receipt.footer}
            </p>
          </div>
        )}

        {/* Checkout overlay */}
        {editorMode === "preview" && checkoutOpen && (
          <div className="absolute inset-0 z-10 flex flex-col justify-between bg-white p-4">
            {checkoutStatus === "success" ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                <span className="text-2xl">✅</span>
                <p className="text-sm font-semibold text-neutral-900">
                  Sale completed
                </p>
                <p className="text-xs text-neutral-500">The cart has been cleared.</p>

                <button
                  type="button"
                  onClick={onCloseCheckout}
                  className="mt-4 rounded-full bg-blue-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                >
                  Done
                </button>
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

        {/* Receipt preview overlay */}
        {editorMode === "preview" && selectedOrder && (
          <div className="absolute inset-0 z-10 flex flex-col bg-white p-4">
            <div className="flex-1 overflow-y-auto">
              <div className="flex flex-col items-center gap-1 border-b border-neutral-200 pb-3 text-center">
                <p className="text-sm font-semibold text-neutral-900">
                  {branding.businessName}
                </p>
                <p className="text-xs text-neutral-500">{selectedOrder.orderNumber}</p>
                <p className="text-xs text-neutral-400">
                  {formatReceiptDateTime(selectedOrder.createdAt)}
                </p>
              </div>

              <div className="flex flex-col gap-1.5 py-3">
                {selectedOrder.items.map((item) => (
                  <div
                    key={item.itemId}
                    className="flex items-center justify-between text-xs text-neutral-600"
                  >
                    <span className="flex-1 truncate text-neutral-900">
                      {item.quantity} × {item.name}
                    </span>
                    <span className="font-medium text-neutral-900">
                      {currencySymbol}
                      {(item.price * item.quantity).toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>

              <div className="flex flex-col gap-1 border-t border-neutral-200 pt-2 text-xs text-neutral-600">
                <div className="flex items-center justify-between">
                  <span>Subtotal</span>
                  <span>
                    {currencySymbol}
                    {selectedOrder.subtotal.toFixed(2)}
                  </span>
                </div>

                {selectedOrder.taxAmount > 0 && (
                  <div className="flex items-center justify-between">
                    <span>Tax</span>
                    <span>
                      {currencySymbol}
                      {selectedOrder.taxAmount.toFixed(2)}
                    </span>
                  </div>
                )}

                {selectedOrder.tip > 0 && (
                  <div className="flex items-center justify-between">
                    <span>Tip</span>
                    <span>
                      {currencySymbol}
                      {selectedOrder.tip.toFixed(2)}
                    </span>
                  </div>
                )}

                <div className="flex items-center justify-between border-t border-neutral-200 pt-1 text-sm font-semibold text-neutral-900">
                  <span>Total</span>
                  <span>
                    {currencySymbol}
                    {selectedOrder.total.toFixed(2)}
                  </span>
                </div>

                <div className="flex items-center justify-between pt-1">
                  <span>Payment</span>
                  <span className="font-medium text-neutral-900">
                    {selectedOrder.paymentMethod === "cash" ? "Cash" : "Card"}
                  </span>
                </div>
              </div>

              <p className="mt-3 text-center text-[11px] text-neutral-400">
                {receipt.footer}
              </p>
            </div>

            <div className="flex flex-col gap-2 pt-3">
              <button
                type="button"
                disabled
                className="w-full cursor-not-allowed rounded-full border border-neutral-200 px-5 py-2.5 text-sm font-medium text-neutral-400"
              >
                Print Receipt (coming soon)
              </button>

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
      </div>
    </div>
  );
}
