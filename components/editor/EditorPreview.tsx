"use client";

import { CURRENCY_SYMBOLS } from "./EditorShell";
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
import ProductBrowser from "./pos-layouts";
import type { PosLayout } from "@/lib/posLayout";
import PosCheckoutPanel from "@/components/runtime/PosCheckoutPanel";
import Receipt from "./Receipt";
import AuthoritativeReceipt from "@/components/runtime/AuthoritativeReceipt";
import type { CompletedSaleReceipt } from "@/lib/completedSale";

// Static preview-only figures used only for the unchanged edit-mode mock below.
const STATIC_TIP = 3;
const STATIC_SUBTOTAL = 20;

type EditorPreviewProps = {
  menuItems: MenuItem[];
  selectedItemId: string | null;
  onSelect: (id: string) => void;
  branding: ProjectConfig["branding"];
  businessProfile: ProjectConfig["businessProfile"];
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
  // Feature 18.2 Phase 5A — set only while the receipt being opened is the sale
  // completed in this session, for which complete_sale_v3 returned an
  // authoritative payload. Older orders fall back to the number-typed
  // CompletedOrder model below, which lib/orders.server.ts mapped from the same
  // persisted rows.
  authoritativeReceipt: CompletedSaleReceipt | null;
  onOpenReceipt: (orderId: string) => void;
  onCloseReceipt: () => void;
  lastCompletedOrderId: string | null;
  layout: PosLayout;
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

export default function EditorPreview({
  menuItems,
  selectedItemId,
  onSelect,
  branding,
  businessProfile,
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
  authoritativeReceipt,
  onOpenReceipt,
  onCloseReceipt,
  lastCompletedOrderId,
  layout,
}: EditorPreviewProps) {
  const currencySymbol = CURRENCY_SYMBOLS[receipt.currency];
  const orderNumber = `${receipt.orderPrefix}1001`;

  // Edit-mode summary math — unchanged from before Feature 7.2.
  const editModeSummary = calculateOrderSummary(tax);
  const editModeFinalTotal = receipt.tipsEnabled
    ? editModeSummary.total + STATIC_TIP
    : editModeSummary.total;

  const recentOrders = completedOrders.slice(0, 5);
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
            {businessProfile.businessName.trim()}
          </span>
        </div>

        {/* Feature 12.3 — product browser, selected via layout inside the
            stable ProductBrowser component. Owns category tabs + item grid
            for this template's layout family; everything else in this file
            (header, cart, checkout, receipt, print) is shared across all
            layouts. */}
        <ProductBrowser
          layout={layout}
          menuItems={menuItems}
          selectedItemId={selectedItemId}
          editorMode={editorMode}
          branding={branding}
          currencySymbol={currencySymbol}
          onSelect={onSelect}
          onAddToCart={onAddToCart}
        />

        {editorMode === "preview" ? (
          <PosCheckoutPanel
            menuItems={menuItems}
            cart={cart}
            cartSummary={cartSummary}
            currencySymbol={currencySymbol}
            orderNumber={orderNumber}
            tax={tax}
            receipt={receipt}
            businessProfile={businessProfile}
            branding={branding}
            onIncreaseQuantity={onIncreaseQuantity}
            onDecreaseQuantity={onDecreaseQuantity}
            onRemoveFromCart={onRemoveFromCart}
            onClearCart={onClearCart}
            checkoutOpen={checkoutOpen}
            onOpenCheckout={onOpenCheckout}
            onCloseCheckout={onCloseCheckout}
            selectedPaymentMethod={selectedPaymentMethod}
            onSelectPaymentMethod={onSelectPaymentMethod}
            checkoutStatus={checkoutStatus}
            onCompleteSale={onCompleteSale}
            saleSaveStatus={saleSaveStatus}
            saleSaveError={saleSaveError}
            recentOrders={recentOrders}
            lastCompletedOrderId={lastCompletedOrderId}
            onOpenReceipt={onOpenReceipt}
            selectedOrder={selectedOrder}
            authoritativeReceipt={authoritativeReceipt}
            onCloseReceipt={onCloseReceipt}
          />
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
      </div>

      {/* Feature 11.1 — print-only copy. Invisible on screen (see
          .receipt-print-area in globals.css); revealed by the print
          stylesheet, which also hides everything else in the app so only
          this prints. Kept as a single instance, mounted only while a
          receipt is actually open, so at most one print area ever exists. */}
      {/* Feature 18.2 Phase 5A — the printed copy must be the same receipt the
          overlay is showing, so it follows the same precedence PosCheckoutPanel
          uses: the server's payload when there is one, the history model
          otherwise. Printing a locally projected copy of a sale whose
          authoritative figures are already in hand would be the one place a
          rounding difference could reach paper. */}
      {authoritativeReceipt ? (
        <div className="receipt-print-area">
          <AuthoritativeReceipt
            receipt={authoritativeReceipt}
            businessProfile={businessProfile}
            receiptSettings={receipt}
            currencySymbol={currencySymbol}
          />
        </div>
      ) : (
        selectedOrder && (
          <div className="receipt-print-area">
            <Receipt order={selectedOrder} businessProfile={businessProfile} receipt={receipt} />
          </div>
        )
      )}
    </div>
  );
}
