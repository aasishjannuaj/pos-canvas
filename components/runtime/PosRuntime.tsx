"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { GeneratedPosConfig } from "@/lib/generatedPosConfig";
import { CURRENCY_SYMBOLS } from "@/lib/projectConfig";
import type { MenuItem } from "@/lib/projectConfig";
import {
  calculateCartSummary,
  canAddItemQuantity,
} from "@/lib/cart";
import type {
  CartItem,
  CheckoutStatus,
  CompletedOrder,
  PaymentMethod,
  SaleSaveStatus,
} from "@/lib/cart";
import { completeSaleOrder } from "@/lib/orders";
import { getProjectConfig } from "@/lib/projects";
import ProductBrowser from "@/components/editor/pos-layouts";
import PosCheckoutPanel from "@/components/runtime/PosCheckoutPanel";
import Receipt from "@/components/editor/Receipt";

type PosRuntimeProps = {
  // Feature 14.3 — the only two props this component receives, per the
  // approved architecture: the immutable generated contract, and the one
  // piece of minimal server-loaded metadata (an order-number starting
  // point) that can't be derived from the contract itself. No
  // ProjectConfig, no raw project row, no Supabase client.
  config: GeneratedPosConfig;
  initialOrderCount: number;
};

const LEAVE_CONFIRM_MESSAGE = "Your current cart will be lost. Leave the POS?";

// Feature 14.3 — the standalone runtime viewer. Treats `config` as
// immutable startup configuration: every session concern (cart, checkout,
// payment method, receipt, order count, a local stock-refreshable copy of
// menuItems) lives in its own local state here, never written back onto
// `config` or any of its nested objects. Reuses the same ProductBrowser,
// PosCheckoutPanel, and Receipt components the Builder's own preview mode
// uses — this is the shared POS engine's real runtime, not a rebuild of it.
export default function PosRuntime({ config, initialOrderCount }: PosRuntimeProps) {
  // Feature 14.3 — a local, independent copy of the menu, seeded once from
  // config.menuItems. Only ever updated field-by-field (stockQuantity/
  // trackInventory, after a confirmed sale) via a fresh array/object at
  // every step — config.menuItems itself is never touched.
  const [menuItems, setMenuItems] = useState<MenuItem[]>(() =>
    config.menuItems.map((item) => ({ ...item }))
  );

  const [cart, setCart] = useState<CartItem[]>([]);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [selectedPaymentMethod, setSelectedPaymentMethod] =
    useState<PaymentMethod | null>(null);
  const [checkoutStatus, setCheckoutStatus] = useState<CheckoutStatus>("idle");
  const [saleSaveStatus, setSaleSaveStatus] = useState<SaleSaveStatus>("idle");
  const [saleSaveError, setSaleSaveError] = useState<string | null>(null);

  // Feature 14.3 — deliberately a single most-recent order, not a growing
  // history: the receipt flow only ever needs to show/print the sale that
  // just happened, so the runtime doesn't carry a Recent Orders reprint
  // list the way the Builder's preview does.
  const [lastCompletedOrder, setLastCompletedOrder] =
    useState<CompletedOrder | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);

  // Feature 14.3 — seeded from the server-loaded starting count
  // (getProjectOrders().orders.length, capped at 20 — see
  // app/runtime/[id]/page.tsx for the known MVP limitation this carries),
  // incremented once per locally confirmed sale for the rest of this
  // session. Never re-fetched mid-session.
  const [orderCount, setOrderCount] = useState(initialOrderCount);

  const currencySymbol = CURRENCY_SYMBOLS[config.receipt.currency];

  // Feature 14.3 money safeguard — the tip amount is always 0 here. There
  // is no tip-entry UI in this MVP, so a nonzero tip must never be
  // fabricated regardless of config.receipt.tipsEnabled; calculateCartSummary
  // itself also independently guards against a non-finite/negative value,
  // but the explicit 0 below is what guarantees no hardcoded sample amount
  // (the Builder-preview-only 3 in EditorShell.tsx) can ever reach this
  // real, persisted checkout path.
  const cartSummary = calculateCartSummary(cart, config.tax, 0);

  const upcomingOrderNumber = `${config.receipt.orderPrefix}${1001 + orderCount}`;

  const selectedOrder = receiptOpen ? lastCompletedOrder : null;

  // Feature 14.3 — warn only while there's a real, not-yet-checked-out cart
  // to lose; registered/removed as cart.length flips, exactly mirroring
  // EditorShell's own isDirty-keyed beforeunload effect from Feature 13.2.
  useEffect(() => {
    if (cart.length === 0) {
      return;
    }

    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [cart.length]);

  function addToCart(menuItem: MenuItem) {
    setCart((prev) => {
      const existing = prev.find((cartItem) => cartItem.itemId === menuItem.id);
      const currentQuantity = existing?.quantity ?? 0;

      if (
        !canAddItemQuantity({
          item: menuItem,
          currentQuantity,
          addQuantity: 1,
        })
      ) {
        return prev;
      }

      if (existing) {
        return prev.map((cartItem) =>
          cartItem.itemId === menuItem.id
            ? { ...cartItem, quantity: cartItem.quantity + 1 }
            : cartItem
        );
      }

      return [
        ...prev,
        {
          itemId: menuItem.id,
          name: menuItem.name,
          price: menuItem.price,
          quantity: 1,
        },
      ];
    });
  }

  function increaseQuantity(itemId: string) {
    setCart((prev) =>
      prev.map((cartItem) => {
        if (cartItem.itemId !== itemId) {
          return cartItem;
        }

        const menuItem = menuItems.find((item) => item.id === itemId);

        if (
          menuItem &&
          !canAddItemQuantity({
            item: menuItem,
            currentQuantity: cartItem.quantity,
            addQuantity: 1,
          })
        ) {
          return cartItem;
        }

        return { ...cartItem, quantity: cartItem.quantity + 1 };
      })
    );
  }

  function decreaseQuantity(itemId: string) {
    setCart((prev) =>
      prev
        .map((cartItem) =>
          cartItem.itemId === itemId
            ? { ...cartItem, quantity: cartItem.quantity - 1 }
            : cartItem
        )
        .filter((cartItem) => cartItem.quantity > 0)
    );
  }

  function removeFromCart(itemId: string) {
    setCart((prev) => prev.filter((cartItem) => cartItem.itemId !== itemId));
  }

  function clearCart() {
    setCart([]);
  }

  function openCheckout() {
    if (cart.length === 0) {
      return;
    }
    setCheckoutOpen(true);
  }

  function closeCheckout() {
    setCheckoutOpen(false);
    setSelectedPaymentMethod(null);
    setCheckoutStatus("idle");
    setSaleSaveStatus("idle");
    setSaleSaveError(null);
  }

  function selectPaymentMethod(method: PaymentMethod) {
    setSelectedPaymentMethod(method);
  }

  function openReceipt(orderId: string) {
    if (lastCompletedOrder?.id === orderId) {
      setReceiptOpen(true);
    }
  }

  function closeReceipt() {
    setReceiptOpen(false);
  }

  async function completeSale() {
    if (cart.length === 0 || !selectedPaymentMethod || checkoutStatus === "success") {
      return;
    }

    setSaleSaveStatus("saving");
    setSaleSaveError(null);

    // Feature 14.3 — re-check the full requested quantity for every cart
    // line against the current local stock right before submitting (stock
    // may have changed since items were added — e.g. another device
    // completing a sale on the same project in the meantime). Checked
    // against 0 (not the cart's own quantity) so this validates the whole
    // requested amount against current stock, not just an incremental step.
    const hasInsufficientStock = cart.some((cartItem) => {
      const menuItem = menuItems.find((item) => item.id === cartItem.itemId);

      if (!menuItem) {
        return false;
      }

      return !canAddItemQuantity({
        item: menuItem,
        currentQuantity: 0,
        addQuantity: cartItem.quantity,
      });
    });

    if (hasInsufficientStock) {
      setSaleSaveStatus("error");
      setSaleSaveError(
        "One or more items are no longer available in the requested quantity."
      );
      return;
    }

    const orderNumber = upcomingOrderNumber;

    const { orderId, error } = await completeSaleOrder({
      projectId: config.project.projectId,
      orderNumber,
      paymentMethod: selectedPaymentMethod,
      subtotal: cartSummary.subtotal,
      taxAmount: cartSummary.taxAmount,
      tipAmount: cartSummary.tip,
      total: cartSummary.total,
      items: cart,
    });

    if (error || !orderId) {
      // RPC failed — the sale did not happen. Cart, checkout, and
      // inventory are left untouched so the cashier can safely retry.
      setSaleSaveStatus("error");
      setSaleSaveError(error ?? "Something went wrong while completing the sale.");
      return;
    }

    const order: CompletedOrder = {
      id: orderId,
      orderNumber,
      items: [...cart],
      subtotal: cartSummary.subtotal,
      taxAmount: cartSummary.taxAmount,
      tip: cartSummary.tip,
      total: cartSummary.total,
      paymentMethod: selectedPaymentMethod,
      createdAt: new Date().toISOString(),
    };

    setLastCompletedOrder(order);
    setOrderCount((prev) => prev + 1);
    clearCart();

    // Lock the UI into the success view *before* attempting the reload, so
    // there is no window where Complete Sale could be clicked again for a
    // sale that already succeeded — mirrors EditorShell's completeSale.
    setCheckoutStatus("success");

    const { config: latestConfig, error: reloadError } = await getProjectConfig(
      config.project.projectId
    );

    if (reloadError || !latestConfig) {
      // The sale already happened — this is a read-only refresh failure,
      // not a failed sale. Non-blocking warning, not an error.
      setSaleSaveStatus("success");
      setSaleSaveError(
        "Sale completed, but inventory could not be refreshed. Reload the page to see the latest stock."
      );
      return;
    }

    // Merge only stockQuantity/trackInventory per matching item id — never
    // overwrite the rest of the local menuItems copy, and never touch
    // config.menuItems itself.
    setMenuItems((prev) =>
      prev.map((item) => {
        const dbItem = latestConfig.menuItems.find(
          (dbMenuItem) => dbMenuItem.id === item.id
        );

        if (!dbItem) {
          return item;
        }

        return {
          ...item,
          stockQuantity: dbItem.stockQuantity,
          trackInventory: dbItem.trackInventory,
        };
      })
    );

    setSaleSaveStatus("success");
  }

  return (
    <div className="flex h-screen flex-col bg-neutral-50">
      <header
        className="flex h-16 flex-none items-center justify-between px-6"
        style={{ backgroundColor: config.branding.accentColor }}
      >
        <span className="text-sm font-semibold tracking-tight text-white">
          {config.businessProfile.businessName.trim()}
        </span>

        <Link
          href="/dashboard"
          onClick={(event) => {
            if (cart.length > 0 && !window.confirm(LEAVE_CONFIRM_MESSAGE)) {
              event.preventDefault();
            }
          }}
          className="text-sm font-medium text-white/90 transition-colors hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          ← Back to Dashboard
        </Link>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-1 flex-col overflow-hidden bg-white">
          <ProductBrowser
            layout={config.project.layout}
            menuItems={menuItems}
            selectedItemId={null}
            editorMode="preview"
            branding={config.branding}
            currencySymbol={currencySymbol}
            onSelect={() => {}}
            onAddToCart={addToCart}
          />
        </div>

        <aside className="relative flex w-96 flex-none flex-col overflow-hidden border-l border-neutral-200 bg-neutral-50">
          <PosCheckoutPanel
            menuItems={menuItems}
            cart={cart}
            cartSummary={cartSummary}
            currencySymbol={currencySymbol}
            orderNumber={upcomingOrderNumber}
            tax={config.tax}
            receipt={config.receipt}
            businessProfile={config.businessProfile}
            branding={config.branding}
            onIncreaseQuantity={increaseQuantity}
            onDecreaseQuantity={decreaseQuantity}
            onRemoveFromCart={removeFromCart}
            onClearCart={clearCart}
            checkoutOpen={checkoutOpen}
            onOpenCheckout={openCheckout}
            onCloseCheckout={closeCheckout}
            selectedPaymentMethod={selectedPaymentMethod}
            onSelectPaymentMethod={selectPaymentMethod}
            checkoutStatus={checkoutStatus}
            onCompleteSale={completeSale}
            saleSaveStatus={saleSaveStatus}
            saleSaveError={saleSaveError}
            recentOrders={[]}
            lastCompletedOrderId={lastCompletedOrder?.id ?? null}
            onOpenReceipt={openReceipt}
            selectedOrder={selectedOrder}
            onCloseReceipt={closeReceipt}
          />
        </aside>
      </div>

      {/* Print-only copy — see app/globals.css's .receipt-print-area rules
          and PosCheckoutPanel's own comment for why this must be a
          top-level sibling of the overflow-hidden layout above rather than
          nested inside it. */}
      {selectedOrder && (
        <div className="receipt-print-area">
          <Receipt
            order={selectedOrder}
            businessProfile={config.businessProfile}
            receipt={config.receipt}
          />
        </div>
      )}
    </div>
  );
}
