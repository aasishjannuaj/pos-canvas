"use client";

import { useState } from "react";
import EditorTopBar from "./EditorTopBar";
import EditorSidebar from "./EditorSidebar";
import EditorPreview from "./EditorPreview";
import EditorPropertiesPanel from "./EditorPropertiesPanel";
import { saveNewProject, updateProject, getProjectConfig } from "@/lib/projects";
import { completeSaleOrder } from "@/lib/orders";
import type { InventoryTransaction } from "@/lib/inventory.types";

export const MENU_CATEGORIES = ["Breakfast", "Lunch", "Drinks"] as const;

export type MenuCategory = (typeof MENU_CATEGORIES)[number];

export type MenuItem = {
  id: string;
  name: string;
  price: number;
  category: MenuCategory;
  trackInventory: boolean;
  stockQuantity: number;
};

export type EditorSection = "Menu" | "Branding" | "Taxes" | "Settings";

export type Currency = "USD" | "CAD" | "EUR" | "GBP";

export const CURRENCY_SYMBOLS: Record<Currency, string> = {
  USD: "$",
  CAD: "CA$",
  EUR: "€",
  GBP: "£",
};

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

type TaxSettings = {
  enabled: boolean;
  rate: number;
  pricesIncludeTax: boolean;
  showTaxSeparately: boolean;
};

type ReceiptSettings = {
  currency: Currency;
  footer: string;
  orderPrefix: string;
  tipsEnabled: boolean;
};

type BrandingSettings = {
  businessName: string;
  accentColor: string;
};

export type ProjectConfig = {
  menuItems: MenuItem[];
  branding: BrandingSettings;
  tax: TaxSettings;
  receipt: ReceiptSettings;
};

const initialMenuItems: MenuItem[] = [
  {
    id: "1",
    name: "Bacon Egg & Cheese",
    price: 6.49,
    category: "Breakfast",
    trackInventory: true,
    stockQuantity: 20,
  },
  {
    id: "2",
    name: "Egg & Cheese",
    price: 4.99,
    category: "Breakfast",
    trackInventory: true,
    stockQuantity: 20,
  },
  {
    id: "3",
    name: "Hash Browns",
    price: 2.49,
    category: "Breakfast",
    trackInventory: true,
    stockQuantity: 20,
  },
  {
    id: "4",
    name: "Coffee",
    price: 2.25,
    category: "Breakfast",
    trackInventory: true,
    stockQuantity: 20,
  },
  {
    id: "5",
    name: "Turkey Grinder",
    price: 8.95,
    category: "Lunch",
    trackInventory: true,
    stockQuantity: 20,
  },
  {
    id: "6",
    name: "Roast Beef",
    price: 9.25,
    category: "Lunch",
    trackInventory: true,
    stockQuantity: 20,
  },
  {
    id: "7",
    name: "Chicken Grinder",
    price: 8.75,
    category: "Lunch",
    trackInventory: true,
    stockQuantity: 20,
  },
  {
    id: "8",
    name: "Coke",
    price: 1.99,
    category: "Drinks",
    trackInventory: true,
    stockQuantity: 20,
  },
  {
    id: "9",
    name: "Sprite",
    price: 1.99,
    category: "Drinks",
    trackInventory: true,
    stockQuantity: 20,
  },
  {
    id: "10",
    name: "Water",
    price: 1.49,
    category: "Drinks",
    trackInventory: true,
    stockQuantity: 20,
  },
];

const initialProjectConfig: ProjectConfig = {
  menuItems: initialMenuItems,
  branding: {
    businessName: "Restaurant POS",
    accentColor: "#2563EB",
  },
  tax: {
    enabled: true,
    rate: 6.35,
    pricesIncludeTax: false,
    showTaxSeparately: true,
  },
  receipt: {
    currency: "USD",
    footer: "Thank you for visiting!",
    orderPrefix: "ORD-",
    tipsEnabled: false,
  },
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

function normalizeProjectConfig(config: ProjectConfig): ProjectConfig {
  return {
    ...config,
    menuItems: config.menuItems.map(normalizeMenuItem),
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
};

export default function EditorShell({
  projectName,
  templateId,
  initialConfig,
  initialProjectId,
  initialCompletedOrders,
  initialInventoryTransactions,
}: EditorShellProps) {
  const [projectConfig, setProjectConfig] = useState<ProjectConfig>(() =>
    normalizeProjectConfig(initialConfig ?? initialProjectConfig)
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

  // Feature 8.3/9.3 — persistence status for the current checkout attempt.
  // After a successful sale, saleSaveError may hold a non-blocking inventory
  // refresh WARNING even while saleSaveStatus stays "success" — it is not
  // reused to mean "the sale failed" in that case.
  const [saleSaveStatus, setSaleSaveStatus] = useState<SaleSaveStatus>("idle");
  const [saleSaveError, setSaleSaveError] = useState<string | null>(null);

  // Feature 7.4/8.4 — completed orders & receipts. Seeded from server-loaded
  // history when available (newest first); new sales are prepended so the
  // ordering convention stays consistent throughout.
  const [completedOrders, setCompletedOrders] = useState<CompletedOrder[]>(
    initialCompletedOrders ?? []
  );
  const [selectedReceiptId, setSelectedReceiptId] = useState<string | null>(null);

  // Feature 9.4 — inventory activity log (newest first), seeded from
  // server-loaded history only. Revised: the client never fabricates local
  // entries for a just-completed sale (see completeSale for why), so this
  // never changes locally — only a fresh server load (mount or reload)
  // can update it.
  const inventoryTransactions = initialInventoryTransactions ?? [];

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

    // Feature 9.4 (revised) — inventoryTransactions is deliberately left
    // unchanged here. The refreshed config only carries final stock
    // quantities, not the authoritative inventory_transactions row ids, and
    // can't reliably reconstruct one row per sold line — especially if the
    // same item appears in more than one cart line. Inventing rows with
    // client-generated ids risked showing data that doesn't match what the
    // database actually recorded. The sale itself succeeded normally, so no
    // warning is shown for this; the activity log simply catches up the
    // next time the project is loaded or reloaded.
    setSaleSaveStatus("success");
  }

  function openReceipt(orderId: string) {
    setSelectedReceiptId(orderId);
  }

  function closeReceipt() {
    setSelectedReceiptId(null);
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
        />
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
        />
      </div>
    </div>
  );
}
