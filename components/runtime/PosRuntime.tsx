"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { GeneratedPosConfig } from "@/lib/generatedPosConfig";
import { CURRENCY_SYMBOLS } from "@/lib/projectConfig";
import type { MenuItem } from "@/lib/projectConfig";
import {
  calculateCartSummary,
  canAddItemQuantity,
  createCartItem,
  getItemQuantityInCart,
} from "@/lib/cart";
import type {
  CartItem,
  CartModifierSelection,
  CheckoutStatus,
  PaymentMethod,
  SaleSaveStatus,
} from "@/lib/cart";
import type { CompletedSaleReceipt } from "@/lib/completedSale";
import { isSubmitBlocked } from "@/lib/saleRequest";
import type { SaleRequestState } from "@/lib/saleRequest";
import { SALE_UNCONFIRMED_MESSAGE, planSaleSubmission } from "@/lib/saleSubmission";
import { OFFLINE_RECEIPT_UNAVAILABLE_NOTE } from "@/lib/provisionalReceipt";
import type { ProvisionalReceipt } from "@/lib/provisionalReceipt";
import AuthoritativeReceipt from "@/components/runtime/AuthoritativeReceipt";
import OfflineReceipt from "@/components/runtime/OfflineReceipt";
import PosHeader from "@/components/runtime/PosHeader";
import ProductBrowser from "@/components/editor/pos-layouts";
import PosCheckoutPanel from "@/components/runtime/PosCheckoutPanel";
import type {
  PosRuntimeCompleteSale,
  PosRuntimeHomeLink,
  PosRuntimeLogoBaseUrl,
  PosRuntimeDiscardOfflineSaleDraft,
  PosRuntimeOnSaleRejected,
  PosRuntimeQueueOfflineSale,
  PosRuntimeRefreshStock,
} from "@/lib/posRuntimeHost";

type PosRuntimeProps = {
  // Feature 14.3 — the immutable generated contract. No ProjectConfig, no raw
  // project row, no Supabase client.
  config: GeneratedPosConfig;

  // Feature 16.4A — host-injected behavior. Previously this component imported
  // lib/orders.ts and lib/projects.ts directly, which hardwired it to the
  // cookie-backed owner client and to an owner-RLS read of `projects`. A paired
  // device can do neither: its session lives in its own localStorage namespace,
  // and `projects` is invisible to it under RLS.
  //
  // These are REQUIRED rather than optional-with-owner-defaults on purpose. A
  // default would keep an owner-session code path compiled into the device
  // bundle, where a bug could transact a device sale through whatever owner
  // cookie happened to exist in the same browser. Injection makes that
  // structurally impossible. components/runtime/OwnerPosRuntime.tsx supplies
  // the owner implementations, unchanged.
  submitSale: PosRuntimeCompleteSale;

  // null = this host has no live stock source (paired device).
  refreshStock: PosRuntimeRefreshStock | null;

  // null = render no exit link (a till has nowhere to go back to).
  homeLink: PosRuntimeHomeLink | null;

  // Feature 19 — the origin a stored logo path resolves against, supplied by
  // the host so this component never names Supabase. null = no logo rendering.
  logoBaseUrl: PosRuntimeLogoBaseUrl;

  // Optional: lets a host re-check its own authorization after a rejected sale.
  onSaleRejected?: PosRuntimeOnSaleRejected;

  /**
   * Feature 24.5A — when set, completing a sale is IMPOSSIBLE and this string
   * says why.
   *
   * A reason rather than a boolean, so the panel can explain itself and so the
   * only way to disable checkout is to state a cause. Null means the ordinary
   * online runtime, unchanged in every respect.
   *
   * Browsing, the cart, modifiers and totals all keep working — the fence is
   * around the one action that writes money.
   *
   * Feature 24.5E DID NOT WEAKEN THIS. It is still the first statement in
   * completeSale and still the only fence that matters; what changed is that a
   * device with a validated offline session now passes null here and supplies
   * queueOfflineSale instead, so "offline" and "cannot sell" stopped being the
   * same sentence.
   */
  checkoutBlockedReason?: string | null;

  /**
   * Feature 24.5E — when set, this runtime completes sales LOCALLY.
   *
   * Non-null means the host has already validated everything that makes an
   * offline sale safe (pairing assertion, 7-day lease, pinned configuration and
   * its integrity, identity, durable storage) and will make the sale durable
   * before it answers. The runtime then submits nothing: no RPC is called, no
   * server receipt exists, and the customer gets a provisional one.
   *
   * null — the default, and what the owner runtime and the Builder Preview both
   * pass — leaves the online complete_sale_v3 path byte-identical to before.
   */
  queueOfflineSale?: PosRuntimeQueueOfflineSale | null;

  /**
   * Feature 24.5E — tells the host this checkout attempt is over.
   *
   * Supplied together with queueOfflineSale, by the same host, under the same
   * condition. It is what bounds the reuse of a sale's identity to a single
   * attempt: see PosRuntimeDiscardOfflineSaleDraft for why an unbounded reuse
   * would record a later customer's sale at an earlier customer's time.
   */
  discardOfflineSaleDraft?: PosRuntimeDiscardOfflineSaleDraft | null;
};

const LEAVE_CONFIRM_MESSAGE = "Your current cart will be lost. Leave the POS?";

// Feature 14.3 — the standalone runtime viewer. Treats `config` as
// immutable startup configuration: every session concern (cart, checkout,
// payment method, receipt, order count, a local stock-refreshable copy of
// menuItems) lives in its own local state here, never written back onto
// `config` or any of its nested objects. Reuses the same ProductBrowser,
// PosCheckoutPanel, and Receipt components the Builder's own preview mode
// uses — this is the shared POS engine's real runtime, not a rebuild of it.
export default function PosRuntime({
  config,
  submitSale,
  refreshStock,
  homeLink,
  logoBaseUrl,
  onSaleRejected,
  checkoutBlockedReason = null,
  queueOfflineSale = null,
  discardOfflineSaleDraft = null,
}: PosRuntimeProps) {
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
  // D3 — the completed sale is the SERVER payload, never a locally assembled
  // object. Nothing from the cart survives past a successful checkout.
  const [lastCompletedReceipt, setLastCompletedReceipt] =
    useState<CompletedSaleReceipt | null>(null);

  // Feature 24.5E — the offline equivalent, kept in a SEPARATE slot rather than
  // widened into the one above. The two receipt models mean different things
  // (one has a server order number, one deliberately has none), and a single
  // union-typed slot is how a provisional total eventually gets rendered by the
  // authoritative component. Only one is ever non-null: each success path
  // clears the other, so a stale receipt of the wrong kind cannot be reopened.
  const [lastProvisionalReceipt, setLastProvisionalReceipt] =
    useState<ProvisionalReceipt | null>(null);

  // One id per logical checkout attempt; reused across retries of the same
  // intent so a lost response replays instead of double-selling.
  const [saleRequest, setSaleRequest] = useState<SaleRequestState | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);

  // Feature 14.3 — seeded from the server-loaded starting count
  // (getProjectOrders().orders.length, capped at 20 — see
  // app/runtime/[id]/page.tsx for the known MVP limitation this carries),
  // incremented once per locally confirmed sale for the rest of this
  // session. Never re-fetched mid-session.
  const currencySymbol = CURRENCY_SYMBOLS[config.receipt.currency];

  // Feature 14.3 money safeguard — the tip amount is always 0 here. There
  // is no tip-entry UI in this MVP, so a nonzero tip must never be
  // fabricated regardless of config.receipt.tipsEnabled; calculateCartSummary
  // itself also independently guards against a non-finite/negative value,
  // but the explicit 0 below is what guarantees no hardcoded sample amount
  // (the Builder-preview-only 3 in EditorShell.tsx) can ever reach this
  // real, persisted checkout path.
  const cartSummary = calculateCartSummary(cart, config.tax, 0);

  const shownReceipt = receiptOpen ? lastCompletedReceipt : null;
  const shownProvisionalReceipt = receiptOpen ? lastProvisionalReceipt : null;

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

  // Feature 18.2 — every cart operation keys on lineKey, not itemId, so the
  // same product with two different modifier selections stays two independent
  // lines. Stock, by contrast, is held against the PRODUCT, so the quantity
  // checks below count every line carrying that itemId.
  function addToCart(menuItem: MenuItem, selections: CartModifierSelection[] = []) {
    setCart((prev) => {
      const line = createCartItem(menuItem, selections);
      const existing = prev.find((cartItem) => cartItem.lineKey === line.lineKey);

      if (
        !canAddItemQuantity({
          item: menuItem,
          // Across ALL lines of this product, not just this one.
          currentQuantity: getItemQuantityInCart(prev, menuItem.id),
          addQuantity: 1,
        })
      ) {
        return prev;
      }

      if (existing) {
        return prev.map((cartItem) =>
          cartItem.lineKey === line.lineKey
            ? { ...cartItem, quantity: cartItem.quantity + 1 }
            : cartItem
        );
      }

      return [...prev, line];
    });
  }

  function increaseQuantity(lineKey: string) {
    setCart((prev) =>
      prev.map((cartItem) => {
        if (cartItem.lineKey !== lineKey) {
          return cartItem;
        }

        const menuItem = menuItems.find((item) => item.id === cartItem.itemId);

        if (
          menuItem &&
          !canAddItemQuantity({
            item: menuItem,
            currentQuantity: getItemQuantityInCart(prev, cartItem.itemId),
            addQuantity: 1,
          })
        ) {
          return cartItem;
        }

        return { ...cartItem, quantity: cartItem.quantity + 1 };
      })
    );
  }

  function decreaseQuantity(lineKey: string) {
    setCart((prev) =>
      prev
        .map((cartItem) =>
          cartItem.lineKey === lineKey
            ? { ...cartItem, quantity: cartItem.quantity - 1 }
            : cartItem
        )
        .filter((cartItem) => cartItem.quantity > 0)
    );
  }

  function removeFromCart(lineKey: string) {
    setCart((prev) => prev.filter((cartItem) => cartItem.lineKey !== lineKey));
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

    // Feature 24.5E — THE ATTEMPT IS OVER, whether it succeeded, failed, or was
    // cancelled. Any sale identity the host is still holding for a retry is
    // void from here: the next Complete Sale is a different sale, even if the
    // cart that reaches it looks identical.
    discardOfflineSaleDraft?.();
  }

  function selectPaymentMethod(method: PaymentMethod) {
    setSelectedPaymentMethod(method);
  }

  // Feature 24.5E — one opener for both receipt kinds. A provisional sale is
  // addressed by its durable queue record id, which is the only stable handle
  // it has: it has no order number, and it must not be given one.
  function openReceipt(receiptId: string) {
    if (
      lastCompletedReceipt?.orderId === receiptId ||
      lastProvisionalReceipt?.queueRecordId === receiptId
    ) {
      setReceiptOpen(true);
    }
  }

  function closeReceipt() {
    setReceiptOpen(false);
  }

  async function completeSale() {
    // Feature 24.5A — THE OFFLINE FENCE, and it is deliberately the very first
    // statement in this function.
    //
    // Placed ahead of every other guard so there is no ordering in which a
    // blocked runtime reaches planSaleSubmission, submitSale or the durable
    // enqueue below. A disabled button is a UI affordance; this is the actual
    // boundary, and it is what guarantees no sale RPC is called, no request id
    // is minted and no record is written when a sale must not happen.
    //
    // 24.5E DID NOT MOVE OR WEAKEN THIS. What changed is who sets the reason: a
    // device with a validated cache and a live lease now passes null and
    // supplies queueOfflineSale, while a device that fails any part of that
    // check still lands here with a message saying which part.
    if (checkoutBlockedReason !== null) {
      setSaleSaveStatus("error");
      setSaleSaveError(checkoutBlockedReason);
      return;
    }

    if (cart.length === 0 || !selectedPaymentMethod || checkoutStatus === "success") {
      return;
    }

    // Double-submit guard: a second Pay press while a request is in flight must
    // never start a second attempt.
    if (isSubmitBlocked(saleSaveStatus)) {
      return;
    }

    setSaleSaveStatus("saving");
    setSaleSaveError(null);

    // Feature 24.5E — THE OFFLINE BRANCH, and the ordering below is the whole
    // safety property of this feature:
    //
    //   await the host's durable write
    //     -> if it failed, STOP. The cart is untouched, nothing says "saved",
    //        and no receipt is produced. There is no memory-only fallback and
    //        no optimistic success anywhere on this path.
    //     -> only once it succeeded: keep the receipt, clear the cart, and
    //        show the success view.
    //
    // Nothing here submits. The host has already made the sale durable; the
    // sync engine sends it to complete_sale_v4 later, from storage, on its own
    // schedule. This component has never heard of that RPC.
    if (queueOfflineSale !== null) {
      const saved = await queueOfflineSale({
        paymentMethod: selectedPaymentMethod,
        // The same literal-0 tip the online path uses. There is still no
        // tip-entry UI, and complete_sale_v4 rejects a device tip outright.
        tipAmount: cartSummary.tip,
        cart,
      });

      if (!saved.ok) {
        // The sale did NOT happen. The cart survives so the cashier can retry
        // before handing anything over — see docs/OFFLINE_ARCHITECTURE.md §18
        // case 15, which requires this failure to be loud and blocking.
        setSaleSaveStatus("error");
        setSaleSaveError(saved.message);
        return;
      }

      // Past this line the sale is on disk.
      setLastCompletedReceipt(null);
      setLastProvisionalReceipt(saved.receipt);
      clearCart();
      setCheckoutStatus("success");
      setSaleSaveStatus("success");
      // Informational only, on the success screen: the sale is saved either
      // way, and this says nothing about whether it was recorded.
      setSaleSaveError(saved.receipt === null ? OFFLINE_RECEIPT_UNAVAILABLE_NOTE : null);
      return;
    }

    // Feature 18.2 Phase 5A — the stock re-check, the request-id decision and
    // the payload build all moved to lib/saleSubmission.ts, unchanged in
    // behavior, so the Builder Preview's own v3 checkout runs the exact same
    // rules rather than a second copy of them. See that module's header for why
    // sharing these three specifically is what matters.
    const plan = planSaleSubmission({
      projectId: config.project.projectId,
      paymentMethod: selectedPaymentMethod,
      tipAmount: cartSummary.tip,
      cart,
      menuItems,
      current: saleRequest,
    });

    if (!plan.ok) {
      setSaleSaveStatus("error");
      setSaleSaveError(plan.error);
      return;
    }

    setSaleRequest(plan.request);

    const { receipt, error } = await submitSale({
      projectId: config.project.projectId,
      paymentMethod: selectedPaymentMethod,
      tipAmount: cartSummary.tip,
      // Identifiers and quantities only. buildSaleRequestItems (inside the plan)
      // strips every display name and price adjustment, so there is nowhere in
      // this payload for a client-supplied amount to sit.
      items: plan.items,
      saleRequestId: plan.request.id,
    });

    if (error || !receipt) {
      // The cart is preserved and the request id is retained, so pressing Pay
      // again retries the SAME attempt. A transport failure may already have
      // committed server-side, so the message must not claim the sale failed —
      // the retry will return the original receipt if it did.
      setSaleSaveStatus("error");
      setSaleSaveError(error ?? SALE_UNCONFIRMED_MESSAGE);

      // Feature 16.4A — the host decides what a rejection means for its own
      // authorization. A paired device re-resolves its pairing state here, so a
      // revocation that landed mid-shift moves it to the revoked screen instead
      // of leaving a dead Pay button. The engine itself draws no conclusion.
      onSaleRejected?.(error);
      return;
    }

    // Success: the authoritative payload is the ONLY record kept. The cart is
    // discarded and the request id cleared, so the next sale gets a new id.
    setLastCompletedReceipt(receipt);
    // Feature 24.5E — a device that reconnects mid-shift must not be able to
    // reopen the previous offline sale's provisional receipt from the success
    // screen of an online one.
    setLastProvisionalReceipt(null);
    setSaleRequest(null);
    clearCart();

    // Lock the UI into the success view *before* attempting the reload, so
    // there is no window where Complete Sale could be clicked again for a
    // sale that already succeeded — mirrors EditorShell's completeSale.
    setCheckoutStatus("success");

    // Feature 16.4A — a host with no live stock source (a paired device, which
    // cannot read `projects` under RLS) passes null. The sale is complete and
    // authoritative either way; there is simply nothing to refresh, so the
    // operator is not shown a warning about something they cannot fix.
    if (refreshStock === null) {
      setSaleSaveStatus("success");
      return;
    }

    const { menuItems: latestMenuItems, error: reloadError } = await refreshStock(
      config.project.projectId
    );

    if (reloadError || !latestMenuItems) {
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
        const dbItem = latestMenuItems.find(
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
      {/* Feature 19 — the shared header, identical here and in the Builder's
          preview. Serves the owner runtime and the paired device alike, since
          both render this component. */}
      <PosHeader
        businessProfile={config.businessProfile}
        branding={config.branding}
        logoBaseUrl={logoBaseUrl ?? undefined}
        size="full"
        trailing={
          /* Feature 16.4A — a paired device passes null: a till has nowhere to
             go back to, and must not offer a route into the owner app. */
          homeLink !== null ? (
            <Link
              href={homeLink.href}
              onClick={(event) => {
                if (cart.length > 0 && !window.confirm(LEAVE_CONFIRM_MESSAGE)) {
                  event.preventDefault();
                }
              }}
              className="flex-none text-sm font-medium text-white/90 transition-colors hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              {homeLink.label}
            </Link>
          ) : undefined
        }
      />

      {/* Feature 16.2 Android fix — this row was unconditionally
          `flex-row` with a fixed 24rem (384px) cart beside a flex-1 product
          panel, which is a desktop-only assumption. Measured on the Android
          emulator (411 x 866 CSS px, the Medium_Phone AVD at 420dpi): the
          384px `flex-none` cart consumed 93% of the width, leaving the
          product panel 27px wide with its 2-column grid overflowing
          horizontally (scrollerW=27 vs gridScrollW=51). The panel was
          technically still scrollable, but 27px is unusable — which is why
          it read as "the left section does not scroll".
          Notably NOT the cause: 100vh measured exactly equal to
          window.innerHeight (866 = 866), and the flex/overflow chain
          already produced a correctly bounded scroll container, because
          `overflow: hidden`/`overflow-y: auto` zero out the automatic
          minimum size. So no 100dvh change and no scroll-container
          restructuring were needed.
          Below `md` the panels now stack vertically, each keeping its own
          independent scroll (the page itself still does not scroll). At
          `md` and above every value is byte-identical to before —
          verified: leftW=896, cartW=384, flex-direction row, scroller
          height 693 in both. */}
      <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white">
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

        {/* Below `md` the cart becomes a full-width bottom panel with a
            bounded share of the height, so the product panel above keeps
            the majority of the screen. `overflow-hidden` is retained
            unchanged at every width because the checkout and receipt
            overlays inside this panel are `absolute inset-0` and depend on
            this element staying their positioning context. */}
        <aside className="relative flex h-[45%] min-h-0 w-full flex-none flex-col overflow-hidden border-t border-neutral-200 bg-neutral-50 md:h-auto md:w-96 md:border-l md:border-t-0">
          <PosCheckoutPanel
            menuItems={menuItems}
            cart={cart}
            cartSummary={cartSummary}
            currencySymbol={currencySymbol}
            orderNumber=""
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
            checkoutBlockedReason={checkoutBlockedReason}
            saleSaveStatus={saleSaveStatus}
            saleSaveError={saleSaveError}
            recentOrders={[]}
            lastCompletedOrderId={
              lastCompletedReceipt?.orderId ??
              lastProvisionalReceipt?.queueRecordId ??
              null
            }
            lastOfflineReference={lastProvisionalReceipt?.offlineReference ?? null}
            onOpenReceipt={openReceipt}
            selectedOrder={null}
            authoritativeReceipt={shownReceipt}
            provisionalReceipt={shownProvisionalReceipt}
            onCloseReceipt={closeReceipt}
          />
        </aside>
      </div>

      {/* Print-only copy — see app/globals.css's .receipt-print-area rules
          and PosCheckoutPanel's own comment for why this must be a
          top-level sibling of the overflow-hidden layout above rather than
          nested inside it. */}
      {shownReceipt && (
        <div className="receipt-print-area">
          <AuthoritativeReceipt
            receipt={shownReceipt}
            businessProfile={config.businessProfile}
            receiptSettings={config.receipt}
            currencySymbol={currencySymbol}
          />
        </div>
      )}

      {/* Feature 24.5E — the same print mechanism, a different document. The
          existing Print Receipt button and the existing .receipt-print-area
          stylesheet are reused unchanged; no second printing stack exists. What
          is printed carries the OFFLINE RECEIPT banner and no order number. */}
      {shownProvisionalReceipt && (
        <div className="receipt-print-area">
          <OfflineReceipt
            receipt={shownProvisionalReceipt}
            businessProfile={config.businessProfile}
            receiptSettings={config.receipt}
            currencySymbol={currencySymbol}
          />
        </div>
      )}
    </div>
  );
}
