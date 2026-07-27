"use client";

import { useState } from "react";
import EditorTopBar from "./EditorTopBar";
import EditorSidebar from "./EditorSidebar";
import EditorPreview from "./EditorPreview";
import EditorPropertiesPanel from "./EditorPropertiesPanel";
import { saveNewProject, updateProject, getProjectConfig } from "@/lib/projects";
import { completeSaleOrder } from "@/lib/orders";
import { restockInventory, adjustInventory } from "@/lib/inventory";
import type { InventoryTransaction } from "@/lib/inventory.types";
import type { OrderTotal } from "@/lib/dashboard.types";
import ProjectDashboard from "@/components/dashboard/ProjectDashboard";
import SalesReport from "@/components/dashboard/SalesReport";
import ProductPerformance from "@/components/dashboard/ProductPerformance";
import InventorySummary from "@/components/dashboard/InventorySummary";
import ReceiptPreview from "./ReceiptPreview";
import {
  MENU_CATEGORIES,
  CURRENCY_SYMBOLS,
  defaultProjectConfig,
} from "@/lib/projectConfig";
import type {
  MenuCategory,
  MenuItem,
  Currency,
  TaxSettings,
  ReceiptSettings,
  BrandingSettings,
  ProjectConfig,
} from "@/lib/projectConfig";

// Feature 12.1 — ProjectConfig and its nested types/defaults now live in the
// neutral lib/projectConfig.ts (so the template registry in data/templates.ts
// can reference them without depending on this "use client" component, and
// without a circular import back to it). Re-exported here unchanged so every
// existing `import ... from "@/components/editor/EditorShell"` call site
// elsewhere in the app keeps working exactly as before.
export {
  MENU_CATEGORIES,
  CURRENCY_SYMBOLS,
};
export type {
  MenuCategory,
  MenuItem,
  Currency,
  ProjectConfig,
};

export type EditorSection =
  | "Menu"
  | "Branding"
  | "Taxes"
  | "Settings"
  | "Dashboard"
  | "Sales Report"
  | "Product Performance"
  | "Inventory Summary";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

export type EditorMode = "edit" | "preview";

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

export type RestockStatus = "idle" | "saving" | "success" | "error";

export type AdjustStatus = "idle" | "saving" | "success" | "error";

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

// Static preview-only figure — the builder has no real payment/tip math yet.
const STATIC_TIP = 3;

function calculateCartSummary(
  cart: CartItem[],
  tax: TaxSettings,
  tipsEnabled: boolean
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

  const tip = tipsEnabled ? STATIC_TIP : 0;

  return {
    itemCount,
    subtotal,
    taxAmount,
    tip,
    total: totalBeforeTip + tip,
  };
}

// Feature 7.5 — normalize menu items loaded from older saved projects that
// predate stockQuantity/trackInventory, so the app never crashes on missing fields.
function normalizeMenuItem(item: MenuItem): MenuItem {
  return {
    ...item,
    trackInventory:
      typeof item.trackInventory === "boolean" ? item.trackInventory : false,
    stockQuantity:
      typeof item.stockQuantity === "number" && Number.isFinite(item.stockQuantity)
        ? item.stockQuantity
        : 0,
  };
}

// Feature 11.1 — normalize receipt settings loaded from older saved projects
// that predate these fields, so the app never crashes on missing values and
// existing valid values are always preserved as-is. Mirrors
// normalizeMenuItem's convention above.
function normalizeReceiptSettings(receipt: ReceiptSettings): ReceiptSettings {
  return {
    ...receipt,
    showBusinessName:
      typeof receipt.showBusinessName === "boolean"
        ? receipt.showBusinessName
        : true,
    businessAddress:
      typeof receipt.businessAddress === "string" ? receipt.businessAddress : "",
    businessPhone:
      typeof receipt.businessPhone === "string" ? receipt.businessPhone : "",
    headerMessage:
      typeof receipt.headerMessage === "string" ? receipt.headerMessage : "",
    showTaxLine:
      typeof receipt.showTaxLine === "boolean" ? receipt.showTaxLine : true,
    showTipLine:
      typeof receipt.showTipLine === "boolean" ? receipt.showTipLine : true,
    showPaymentMethod:
      typeof receipt.showPaymentMethod === "boolean"
        ? receipt.showPaymentMethod
        : true,
    showOrderNumber:
      typeof receipt.showOrderNumber === "boolean"
        ? receipt.showOrderNumber
        : true,
  };
}

function normalizeProjectConfig(config: ProjectConfig): ProjectConfig {
  return {
    ...config,
    menuItems: config.menuItems.map(normalizeMenuItem),
    receipt: normalizeReceiptSettings(config.receipt),
  };
}

function createId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  // Fallback for environments without crypto.randomUUID (still collision-resistant enough for local state).
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

type EditorShellProps = {
  projectName: string;
  templateId: string;
  initialConfig?: ProjectConfig;
  initialProjectId?: string | null;
  initialCompletedOrders?: CompletedOrder[];
  initialInventoryTransactions?: InventoryTransaction[];
  initialInventoryTransactionsError?: string | null;
  initialOrderTotals?: OrderTotal[];
  initialOrderTotalsError?: string | null;
};

export default function EditorShell({
  projectName,
  templateId,
  initialConfig,
  initialProjectId,
  initialCompletedOrders,
  initialInventoryTransactions,
  initialInventoryTransactionsError,
  initialOrderTotals,
  initialOrderTotalsError,
}: EditorShellProps) {
  const [projectConfig, setProjectConfig] = useState<ProjectConfig>(() =>
    normalizeProjectConfig(initialConfig ?? defaultProjectConfig)
  );

  // UI-only state — not part of the saved project, so it stays outside projectConfig.
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [editorSection, setEditorSection] = useState<EditorSection>("Menu");

  // Feature 7.1 — edit/preview mode (UI-only, does not affect saved data)
  const [editorMode, setEditorMode] = useState<EditorMode>("edit");

  // Feature 7.2 — preview-only cart (never saved with the project)
  const [cart, setCart] = useState<CartItem[]>([]);

  // Feature 7.3 — preview-only checkout (never saved with the project)
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [selectedPaymentMethod, setSelectedPaymentMethod] =
    useState<PaymentMethod | null>(null);
  const [checkoutStatus, setCheckoutStatus] = useState<CheckoutStatus>("idle");

  // Feature 11.1 — the exact order id the success screen's "View Receipt"
  // button should open. Set alongside setCompletedOrders in completeSale(),
  // so it always names the order that RPC call actually confirmed — never
  // inferred from completedOrders[0], which would be fragile if that array's
  // update ordering ever changed.
  const [lastCompletedOrderId, setLastCompletedOrderId] = useState<
    string | null
  >(null);

  // Feature 8.3/9.3 — persistence status for the current checkout attempt.
  // After a successful sale, saleSaveError may hold a non-blocking inventory
  // refresh WARNING even while saleSaveStatus stays "success" — it is not
  // reused to mean "the sale failed" in that case.
  const [saleSaveStatus, setSaleSaveStatus] = useState<SaleSaveStatus>("idle");
  const [saleSaveError, setSaleSaveError] = useState<string | null>(null);

  // Feature 9.6 — restock status for the current restock attempt.
  const [restockStatus, setRestockStatus] = useState<RestockStatus>("idle");
  const [restockError, setRestockError] = useState<string | null>(null);
  const [restockSuccessMessage, setRestockSuccessMessage] = useState<
    string | null
  >(null);

  // Feature 9.7B — manual inventory adjustment status for the current attempt.
  const [adjustStatus, setAdjustStatus] = useState<AdjustStatus>("idle");
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [adjustSuccessMessage, setAdjustSuccessMessage] = useState<
    string | null
  >(null);

  // Feature 7.4/8.4 — completed orders & receipts. Seeded from server-loaded
  // history when available (newest first); new sales are prepended so the
  // ordering convention stays consistent throughout.
  const [completedOrders, setCompletedOrders] = useState<CompletedOrder[]>(
    initialCompletedOrders ?? []
  );
  const [selectedReceiptId, setSelectedReceiptId] = useState<string | null>(null);

  // Feature 9.4/10.4 — inventory activity log (newest first), seeded from
  // server-loaded history. Unlike its original design, this now *does* need
  // local updates: a sale, restock, or adjustment made this session must
  // show up in both the Inventory Activity panel and Inventory Summary
  // immediately, without a page reload. completeSale/handleRestock/
  // handleInventoryAdjustment each append a locally-confirmed entry below —
  // never a re-fetch, so nothing here risks double-counting.
  const [inventoryTransactions, setInventoryTransactions] = useState<
    InventoryTransaction[]
  >(initialInventoryTransactions ?? []);

  // Same rationale as orderTotalsError: no client-side retry for this
  // read-only reporting query, so a load failure (if any) is fixed for the
  // session.
  const inventoryTransactionsError = initialInventoryTransactionsError ?? null;

  // Feature 10.1 — dashboard order totals, seeded from server-loaded history.
  // Unlike inventoryTransactions, this *does* need a local update: a sale
  // completed in the current session must show up on the Dashboard tab
  // immediately, without a page reload. completeSale() appends the newly
  // confirmed order's totals below — it never refetches from the server, so
  // there is no risk of double-counting the same sale.
  const [orderTotals, setOrderTotals] = useState<OrderTotal[]>(
    initialOrderTotals ?? []
  );

  // The initial load either succeeded (possibly with zero orders, a real
  // "no sales yet" state) or failed outright. There is no client-side retry
  // for this read-only reporting query, so the error — if any — is fixed
  // for the session, same as the other server-seeded history above.
  const orderTotalsError = initialOrderTotalsError ?? null;

  // Feature 6.4/6.5.2/6.5.3 — save state
  const [projectId, setProjectId] = useState<string | null>(initialProjectId ?? null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  const selectedItem =
    projectConfig.menuItems.find((item) => item.id === selectedItemId) ?? null;

  const cartSummary = calculateCartSummary(
    cart,
    projectConfig.tax,
    projectConfig.receipt.tipsEnabled
  );

  // Once a save has succeeded, any further edit to persisted project data
  // reverts the button back to "Save" — no autosave, just a status reset.
  function markUnsaved() {
    setSaveStatus((prev) => (prev === "saved" ? "idle" : prev));
  }

  function handleToggleEditorMode() {
    setEditorMode((prev) => (prev === "edit" ? "preview" : "edit"));
  }

  function handleUpdateItem(id: string, changes: Partial<MenuItem>) {
    markUnsaved();

    setProjectConfig((prev) => ({
      ...prev,
      menuItems: prev.menuItems.map((item) =>
        item.id === id ? { ...item, ...changes } : item
      ),
    }));

    // Feature 7.5 — if inventory fields changed, clamp/remove any cart
    // quantity that now exceeds the new stock level (simple, no extra effects).
    if ("stockQuantity" in changes || "trackInventory" in changes) {
      setCart((prev) => {
        const oldItem = projectConfig.menuItems.find((item) => item.id === id);
        if (!oldItem) {
          return prev;
        }

        const updatedItem: MenuItem = { ...oldItem, ...changes };

        if (!updatedItem.trackInventory) {
          return prev;
        }

        return prev
          .map((cartItem) =>
            cartItem.itemId === id
              ? {
                  ...cartItem,
                  quantity: Math.min(cartItem.quantity, updatedItem.stockQuantity),
                }
              : cartItem
          )
          .filter((cartItem) => cartItem.quantity > 0);
      });
    }
  }

  function handleAddItem() {
    markUnsaved();

    const newItem: MenuItem = {
      id: createId(),
      name: "New Item",
      price: 0,
      category: "Breakfast",
      trackInventory: true,
      stockQuantity: 0,
    };

    setProjectConfig((prev) => ({
      ...prev,
      menuItems: [...prev.menuItems, newItem],
    }));
    setSelectedItemId(newItem.id);
  }

  function handleDuplicateItem() {
    if (!selectedItem) {
      return;
    }

    markUnsaved();

    const duplicatedItem: MenuItem = {
      ...selectedItem,
      id: createId(),
    };

    setProjectConfig((prev) => ({
      ...prev,
      menuItems: [...prev.menuItems, duplicatedItem],
    }));
    setSelectedItemId(duplicatedItem.id);
  }

  function handleDeleteItem() {
    if (!selectedItem) {
      return;
    }

    markUnsaved();

    setProjectConfig((prev) => ({
      ...prev,
      menuItems: prev.menuItems.filter((item) => item.id !== selectedItem.id),
    }));

    // A deleted menu item can't be left behind as an orphaned line in the
    // preview cart (no matching item to look up, no inventory to deduct from).
    setCart((prev) =>
      prev.filter((cartItem) => cartItem.itemId !== selectedItem.id)
    );

    setSelectedItemId(null);
  }

  function handleBrandingChange(changes: Partial<BrandingSettings>) {
    markUnsaved();
    setProjectConfig((prev) => ({
      ...prev,
      branding: { ...prev.branding, ...changes },
    }));
  }

  function handleTaxChange(changes: Partial<TaxSettings>) {
    markUnsaved();
    setProjectConfig((prev) => ({
      ...prev,
      tax: { ...prev.tax, ...changes },
    }));
  }

  function handleReceiptChange(changes: Partial<ReceiptSettings>) {
    markUnsaved();
    setProjectConfig((prev) => ({
      ...prev,
      receipt: { ...prev.receipt, ...changes },
    }));
  }

  function addToCart(menuItem: MenuItem) {
    setCart((prev) => {
      const existing = prev.find((cartItem) => cartItem.itemId === menuItem.id);
      const currentQuantity = existing?.quantity ?? 0;

      if (menuItem.trackInventory && currentQuantity >= menuItem.stockQuantity) {
        // Already at (or beyond) available stock — do nothing.
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

        const menuItem = projectConfig.menuItems.find((item) => item.id === itemId);

        if (menuItem?.trackInventory && cartItem.quantity >= menuItem.stockQuantity) {
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

  async function completeSale() {
    // Preserve the existing guards — unchanged from before Feature 8.3.
    if (cart.length === 0 || !selectedPaymentMethod || checkoutStatus === "success") {
      return;
    }

    setSaleSaveStatus("saving");
    setSaleSaveError(null);

    // A sale can only be persisted against a project that actually has a
    // database row. Fail fast with a clear, actionable message instead of
    // letting this surface as an opaque RPC error.
    if (projectId === null) {
      setSaleSaveStatus("error");
      setSaleSaveError("Save this project before completing a sale.");
      return;
    }

    const orderNumber = `${projectConfig.receipt.orderPrefix}${1001 + completedOrders.length}`;

    const { orderId, error } = await completeSaleOrder({
      projectId,
      orderNumber,
      paymentMethod: selectedPaymentMethod,
      subtotal: cartSummary.subtotal,
      taxAmount: cartSummary.taxAmount,
      tipAmount: cartSummary.tip,
      total: cartSummary.total,
      items: cart,
    });

    if (error || !orderId) {
      // RPC failed — the sale did not happen. Nothing local changes, so the
      // cashier can safely retry: cart, checkout, and inventory are untouched.
      setSaleSaveStatus("error");
      setSaleSaveError(error ?? "Something went wrong while completing the sale.");
      return;
    }

    // RPC succeeded — the sale is now real. complete_sale (9.2) already
    // validated and deducted inventory and recorded inventory_transactions
    // atomically; the client does none of that math anymore.
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

    setCompletedOrders((prev) => [order, ...prev]);

    // Feature 11.1 — the exact confirmed order id for this sale, so the
    // success screen's "View Receipt" button can open it directly.
    setLastCompletedOrderId(order.id);

    // Feature 10.1/10.2/10.3 — reuse the same confirmed values used for the
    // receipt above (order.orderNumber/subtotal/taxAmount/tip/total/
    // paymentMethod/createdAt/items) so the Dashboard, Sales Report, and
    // Product Performance all reflect this sale immediately, without a page
    // reload or a second fetch. itemCount/items are computed from
    // order.items rather than the cart state directly since clearCart()
    // runs right after this. lineTotal is derived as price * quantity —
    // the real order_items.line_total isn't known client-side until the
    // next server reload, but this matches how the DB itself would compute
    // it for a plain per-unit price with no discounts. This is a local
    // append only; the server-side order totals query is never re-run, so
    // the sale can't be double-counted there.
    setOrderTotals((prev) => [
      {
        id: order.id,
        orderNumber: order.orderNumber,
        subtotal: order.subtotal,
        taxAmount: order.taxAmount,
        tip: order.tip,
        total: order.total,
        paymentMethod: order.paymentMethod,
        itemCount: order.items.reduce(
          (sum, item) => sum + item.quantity,
          0
        ),
        items: order.items.map((item) => ({
          itemId: item.itemId,
          itemName: item.name,
          quantity: item.quantity,
          lineTotal: item.price * item.quantity,
        })),
        createdAt: order.createdAt,
      },
      ...prev,
    ]);

    // Feature 10.4 — append one synthetic "sale" inventory transaction per
    // tracked cart line, so Inventory Summary (and the Inventory Activity
    // panel, which reads this same state) reflect this sale's stock
    // deduction immediately. quantityBefore is read from
    // projectConfig.menuItems as it stands right here — nothing has
    // decremented it locally yet, the only update happens later via the
    // getProjectConfig() reload below — so this is the exact pre-sale
    // snapshot, not an inferred value. Untracked items are skipped (no
    // stock concept to record, matching what complete_sale's own inventory
    // bookkeeping already does). This only runs after completeSaleOrder has
    // already succeeded above, so a failed sale never produces phantom
    // transactions. Each id is deterministic (orderId + itemId + line
    // index) so React keys and activity rows can't collide even if this
    // were ever called twice for the same order.
    const saleInventoryTransactions: InventoryTransaction[] = order.items
      .map((item, index): InventoryTransaction | null => {
        const menuItem = projectConfig.menuItems.find(
          (candidate) => candidate.id === item.itemId
        );

        if (!menuItem || !menuItem.trackInventory) {
          return null;
        }

        const quantityBefore = menuItem.stockQuantity;
        const quantityChange = -item.quantity;

        return {
          id: `sale-${order.id}-${item.itemId}-${index}`,
          orderId: order.id,
          itemId: item.itemId,
          itemName: item.name,
          transactionType: "sale",
          quantityChange,
          quantityBefore,
          quantityAfter: quantityBefore + quantityChange,
          createdAt: order.createdAt,
        };
      })
      .filter((transaction): transaction is InventoryTransaction => transaction !== null);

    if (saleInventoryTransactions.length > 0) {
      setInventoryTransactions((prev) => [...saleInventoryTransactions, ...prev]);
    }

    clearCart();

    // Lock the UI into the success view *before* attempting the reload, so
    // there is no window where Complete Sale could be clicked again for a
    // sale that already succeeded.
    setCheckoutStatus("success");

    const { config: latestConfig, error: reloadError } =
      await getProjectConfig(projectId);

    if (reloadError || !latestConfig) {
      // The sale already happened — this is a read-only refresh failure,
      // not a failed sale. Show a warning, not an error, and do not retry.
      setSaleSaveStatus("success");
      setSaleSaveError(
        "Sale completed, but inventory could not be refreshed. Reload the project to see the latest stock."
      );
      return;
    }

    // Merge only stockQuantity/trackInventory per matching item id from the
    // database-confirmed config — never overwrite unrelated unsaved local
    // edits (name/price/category, or branding/tax/receipt) with the whole
    // database config. No markUnsaved() here: this reconciles already-
    // persisted inventory, it is not a new local edit that needs saving.
    setProjectConfig((prev) => ({
      ...prev,
      menuItems: prev.menuItems.map((item) => {
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
      }),
    }));

    // inventoryTransactions was already updated above (Feature 10.4), before
    // this reload — this reconciliation only concerns stockQuantity/
    // trackInventory on projectConfig.menuItems, not the transaction log.
    setSaleSaveStatus("success");
  }

  function openReceipt(orderId: string) {
    setSelectedReceiptId(orderId);
  }

  function closeReceipt() {
    setSelectedReceiptId(null);
  }

  // Feature 9.6 — restock an inventory-tracked item via the atomic
  // restock_inventory RPC. The RPC's returned quantityAfter is authoritative;
  // this handler never computes a new stock number itself.
  async function handleRestock(itemId: string, quantity: number) {
    if (restockStatus === "saving") {
      return;
    }

    if (projectId === null) {
      setRestockStatus("error");
      setRestockError("Save this project before restocking inventory.");
      setRestockSuccessMessage(null);
      return;
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      setRestockStatus("error");
      setRestockError("Quantity must be a positive whole number.");
      setRestockSuccessMessage(null);
      return;
    }

    setRestockStatus("saving");
    setRestockError(null);
    setRestockSuccessMessage(null);

    const { result, error } = await restockInventory({
      projectId,
      itemId,
      quantity,
    });

    if (error || !result) {
      // RPC failed — nothing local changes, so this can be retried freely.
      setRestockStatus("error");
      setRestockError(error ?? "Something went wrong while restocking.");
      return;
    }

    // Use the RPC's authoritative quantityAfter directly — no client math,
    // and no markUnsaved(): the database already persisted this change, so
    // there is nothing new for Save to do. Any other unsaved edits (or lack
    // thereof) are left exactly as they were.
    setProjectConfig((prev) => ({
      ...prev,
      menuItems: prev.menuItems.map((item) =>
        item.id === result.itemId
          ? { ...item, stockQuantity: result.quantityAfter }
          : item
      ),
    }));

    // Feature 10.4 — use the RPC's own transaction id and before/change/
    // after values directly (no client math), so Inventory Summary and the
    // Inventory Activity panel reflect this restock immediately.
    setInventoryTransactions((prev) => [
      {
        id: result.transactionId,
        orderId: null,
        itemId: result.itemId,
        itemName: result.itemName,
        transactionType: "restock",
        quantityChange: result.quantityChange,
        quantityBefore: result.quantityBefore,
        quantityAfter: result.quantityAfter,
        createdAt: new Date().toISOString(),
      },
      ...prev,
    ]);

    setRestockStatus("success");
    setRestockSuccessMessage(
      `${result.itemName} restocked by ${result.quantityChange}. New stock: ${result.quantityAfter}.`
    );
  }

  // Feature 9.7B — manually adjust an inventory-tracked item's stock to an
  // exact final value via the atomic adjust_inventory RPC. The RPC's
  // returned quantityAfter is authoritative; this handler never computes a
  // new stock number itself. Mirrors handleRestock's conventions.
  async function handleInventoryAdjustment(itemId: string, newQuantity: number) {
    if (adjustStatus === "saving") {
      return;
    }

    if (projectId === null) {
      setAdjustStatus("error");
      setAdjustError("Save this project before adjusting inventory.");
      setAdjustSuccessMessage(null);
      return;
    }

    if (!Number.isInteger(newQuantity) || newQuantity < 0) {
      setAdjustStatus("error");
      setAdjustError("New stock must be a whole number of 0 or more.");
      setAdjustSuccessMessage(null);
      return;
    }

    setAdjustStatus("saving");
    setAdjustError(null);
    setAdjustSuccessMessage(null);

    const { result, error } = await adjustInventory({
      projectId,
      itemId,
      newQuantity,
    });

    if (error || !result) {
      // RPC failed — nothing local changes, so this can be retried freely.
      setAdjustStatus("error");
      setAdjustError(error ?? "Something went wrong while adjusting inventory.");
      return;
    }

    // Use the RPC's authoritative quantityAfter directly — no client math,
    // and no markUnsaved(): the database already persisted this change, so
    // there is nothing new for Save to do. Any other unsaved edits (or lack
    // thereof) are left exactly as they were.
    setProjectConfig((prev) => ({
      ...prev,
      menuItems: prev.menuItems.map((item) =>
        item.id === result.itemId
          ? { ...item, stockQuantity: result.quantityAfter }
          : item
      ),
    }));

    // Feature 10.4 — use the RPC's own transaction id and before/change/
    // after values directly (no client math), so Inventory Summary and the
    // Inventory Activity panel reflect this adjustment immediately.
    setInventoryTransactions((prev) => [
      {
        id: result.transactionId,
        orderId: null,
        itemId: result.itemId,
        itemName: result.itemName,
        transactionType: "adjustment",
        quantityChange: result.quantityChange,
        quantityBefore: result.quantityBefore,
        quantityAfter: result.quantityAfter,
        createdAt: new Date().toISOString(),
      },
      ...prev,
    ]);

    setAdjustStatus("success");
    setAdjustSuccessMessage(
      `${result.itemName} adjusted from ${result.quantityBefore} to ${result.quantityAfter}.`
    );
  }

  async function handleSave() {
    setSaveStatus("saving");
    setSaveError(null);

    if (projectId === null) {
      const { project, error } = await saveNewProject({
        name: projectName,
        templateId,
        config: projectConfig,
      });

      if (error || !project) {
        setSaveStatus("error");
        setSaveError(error ?? "Something went wrong while saving.");
        return;
      }

      setProjectId(project.id);
      setSaveStatus("saved");
      return;
    }

    const { project, error } = await updateProject({
      projectId,
      name: projectName,
      config: projectConfig,
    });

    if (error || !project) {
      setSaveStatus("error");
      setSaveError(error ?? "Something went wrong while saving.");
      return;
    }

    setSaveStatus("saved");
  }

  return (
    <div className="flex h-screen flex-col bg-neutral-50">
      <EditorTopBar
        projectName={projectName}
        onSave={handleSave}
        saveStatus={saveStatus}
        saveError={saveError}
        editorMode={editorMode}
        onToggleEditorMode={handleToggleEditorMode}
      />

      <div className="flex flex-1 overflow-hidden">
        <EditorSidebar
          editorSection={editorSection}
          setEditorSection={setEditorSection}
        />
        {editorMode === "edit" && editorSection === "Dashboard" ? (
          <ProjectDashboard
            orderTotals={orderTotals}
            orderTotalsError={orderTotalsError}
            menuItems={projectConfig.menuItems}
            currency={projectConfig.receipt.currency}
          />
        ) : editorMode === "edit" && editorSection === "Sales Report" ? (
          <SalesReport
            orderTotals={orderTotals}
            orderTotalsError={orderTotalsError}
            currency={projectConfig.receipt.currency}
          />
        ) : editorMode === "edit" && editorSection === "Product Performance" ? (
          <ProductPerformance
            orderTotals={orderTotals}
            orderTotalsError={orderTotalsError}
            currency={projectConfig.receipt.currency}
          />
        ) : editorMode === "edit" && editorSection === "Inventory Summary" ? (
          <InventorySummary
            menuItems={projectConfig.menuItems}
            inventoryTransactions={inventoryTransactions}
            inventoryTransactionsError={inventoryTransactionsError}
          />
        ) : editorMode === "edit" && editorSection === "Settings" ? (
          <ReceiptPreview
            branding={projectConfig.branding}
            receipt={projectConfig.receipt}
          />
        ) : (
          <EditorPreview
            menuItems={projectConfig.menuItems}
            selectedItemId={selectedItemId}
            onSelect={setSelectedItemId}
            branding={projectConfig.branding}
            tax={projectConfig.tax}
            receipt={projectConfig.receipt}
            editorMode={editorMode}
            cart={cart}
            cartSummary={cartSummary}
            onAddToCart={addToCart}
            onIncreaseQuantity={increaseQuantity}
            onDecreaseQuantity={decreaseQuantity}
            onRemoveFromCart={removeFromCart}
            onClearCart={clearCart}
            checkoutOpen={checkoutOpen}
            selectedPaymentMethod={selectedPaymentMethod}
            checkoutStatus={checkoutStatus}
            onOpenCheckout={openCheckout}
            onCloseCheckout={closeCheckout}
            onSelectPaymentMethod={selectPaymentMethod}
            onCompleteSale={completeSale}
            saleSaveStatus={saleSaveStatus}
            saleSaveError={saleSaveError}
            completedOrders={completedOrders}
            selectedReceiptId={selectedReceiptId}
            onOpenReceipt={openReceipt}
            onCloseReceipt={closeReceipt}
            lastCompletedOrderId={lastCompletedOrderId}
          />
        )}
        <EditorPropertiesPanel
          editorSection={editorSection}
          selectedItem={selectedItem}
          onUpdate={handleUpdateItem}
          onAdd={handleAddItem}
          onDuplicate={handleDuplicateItem}
          onDelete={handleDeleteItem}
          branding={projectConfig.branding}
          onBrandingChange={handleBrandingChange}
          tax={projectConfig.tax}
          onTaxChange={handleTaxChange}
          receipt={projectConfig.receipt}
          onReceiptChange={handleReceiptChange}
          editorMode={editorMode}
          cartSummary={cartSummary}
          selectedPaymentMethod={selectedPaymentMethod}
          checkoutStatus={checkoutStatus}
          completedOrders={completedOrders}
          inventoryTransactions={inventoryTransactions}
          menuItems={projectConfig.menuItems}
          projectId={projectId}
          restockStatus={restockStatus}
          restockError={restockError}
          restockSuccessMessage={restockSuccessMessage}
          onRestock={handleRestock}
          adjustStatus={adjustStatus}
          adjustError={adjustError}
          adjustSuccessMessage={adjustSuccessMessage}
          onAdjust={handleInventoryAdjustment}
        />
      </div>
    </div>
  );
}
