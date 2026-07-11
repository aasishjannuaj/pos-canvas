"use client";

import { useState } from "react";
import EditorTopBar from "./EditorTopBar";
import EditorSidebar from "./EditorSidebar";
import EditorPreview from "./EditorPreview";
import EditorPropertiesPanel from "./EditorPropertiesPanel";

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

function createId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  // Fallback for environments without crypto.randomUUID (still collision-resistant enough for local state).
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

type EditorShellProps = {
  projectName: string;
};

export default function EditorShell({ projectName }: EditorShellProps) {
  const [projectConfig, setProjectConfig] = useState<ProjectConfig>(initialProjectConfig);

  // UI-only state — not part of the saved project, so it stays outside projectConfig.
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [editorSection, setEditorSection] = useState<EditorSection>("Menu");

  const selectedItem =
    projectConfig.menuItems.find((item) => item.id === selectedItemId) ?? null;

  function handleUpdateItem(id: string, changes: Partial<MenuItem>) {
    setProjectConfig((prev) => ({
      ...prev,
      menuItems: prev.menuItems.map((item) =>
        item.id === id ? { ...item, ...changes } : item
      ),
    }));
  }

  function handleAddItem() {
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

    setProjectConfig((prev) => ({
      ...prev,
      menuItems: prev.menuItems.filter((item) => item.id !== selectedItem.id),
    }));
    setSelectedItemId(null);
  }

  function handleBrandingChange(changes: Partial<BrandingSettings>) {
    setProjectConfig((prev) => ({
      ...prev,
      branding: { ...prev.branding, ...changes },
    }));
  }

  function handleTaxChange(changes: Partial<TaxSettings>) {
    setProjectConfig((prev) => ({
      ...prev,
      tax: { ...prev.tax, ...changes },
    }));
  }

  function handleReceiptChange(changes: Partial<ReceiptSettings>) {
    setProjectConfig((prev) => ({
      ...prev,
      receipt: { ...prev.receipt, ...changes },
    }));
  }

  return (
    <div className="flex h-screen flex-col bg-neutral-50">
      <EditorTopBar projectName={projectName} />

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
        />
      </div>
    </div>
  );
}
