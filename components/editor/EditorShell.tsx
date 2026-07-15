"use client";

import { useState } from "react";
import EditorTopBar from "./EditorTopBar";
import EditorSidebar from "./EditorSidebar";
import EditorPreview from "./EditorPreview";
import EditorPropertiesPanel from "./EditorPropertiesPanel";
import { saveNewProject, updateProject } from "@/lib/projects";

export const MENU_CATEGORIES = ["Breakfast", "Lunch", "Drinks"] as const;

export type MenuCategory = (typeof MENU_CATEGORIES)[number];

export type MenuItem = {
  id: string;
  name: string;
  price: number;
  category: MenuCategory;
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
  { id: "1", name: "Bacon Egg & Cheese", price: 6.49, category: "Breakfast" },
  { id: "2", name: "Egg & Cheese", price: 4.99, category: "Breakfast" },
  { id: "3", name: "Hash Browns", price: 2.49, category: "Breakfast" },
  { id: "4", name: "Coffee", price: 2.25, category: "Breakfast" },
  { id: "5", name: "Turkey Grinder", price: 8.95, category: "Lunch" },
  { id: "6", name: "Roast Beef", price: 9.25, category: "Lunch" },
  { id: "7", name: "Chicken Grinder", price: 8.75, category: "Lunch" },
  { id: "8", name: "Coke", price: 1.99, category: "Drinks" },
  { id: "9", name: "Sprite", price: 1.99, category: "Drinks" },
  { id: "10", name: "Water", price: 1.49, category: "Drinks" },
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
};

export default function EditorShell({
  projectName,
  templateId,
  initialConfig,
  initialProjectId,
}: EditorShellProps) {
  const [projectConfig, setProjectConfig] = useState<ProjectConfig>(
    initialConfig ?? initialProjectConfig
  );

  // UI-only state — not part of the saved project, so it stays outside projectConfig.
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [editorSection, setEditorSection] = useState<EditorSection>("Menu");

  // Feature 7.1 — edit/preview mode (UI-only, does not affect saved data)
  const [editorMode, setEditorMode] = useState<EditorMode>("edit");

  // Feature 7.2 — preview-only cart (never saved with the project)
  const [cart, setCart] = useState<CartItem[]>([]);

  // Feature 7.3 — preview-only checkout (never saved with the project, no transactions persisted)
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [selectedPaymentMethod, setSelectedPaymentMethod] =
    useState<PaymentMethod | null>(null);
  const [checkoutStatus, setCheckoutStatus] = useState<CheckoutStatus>("idle");

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
  }

  function handleAddItem() {
    markUnsaved();

    const newItem: MenuItem = {
      id: createId(),
      name: "New Item",
      price: 0,
      category: "Breakfast",
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
      prev.map((cartItem) =>
        cartItem.itemId === itemId
          ? { ...cartItem, quantity: cartItem.quantity + 1 }
          : cartItem
      )
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
  }

  function selectPaymentMethod(method: PaymentMethod) {
    setSelectedPaymentMethod(method);
  }

  function completeSale() {
    if (!selectedPaymentMethod) {
      return;
    }

    // Show the success state first — closing is a separate, explicit action
    // (the "Done" button in the checkout panel) so the message stays visible.
    setCheckoutStatus("success");
    clearCart();
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
        />
      </div>
    </div>
  );
}
