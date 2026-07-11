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
  const [menuItems, setMenuItems] = useState<MenuItem[]>(initialMenuItems);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [editorSection, setEditorSection] = useState<EditorSection>("Menu");
  const [businessName, setBusinessName] = useState("Restaurant POS");
  const [accentColor, setAccentColor] = useState("#2563EB");
  const [taxEnabled, setTaxEnabled] = useState(true);
  const [taxRate, setTaxRate] = useState(6.35);
  const [pricesIncludeTax, setPricesIncludeTax] = useState(false);
  const [showTaxSeparately, setShowTaxSeparately] = useState(true);

  // Feature 5.8 — Settings state
  const [currency, setCurrency] = useState<Currency>("USD");
  const [receiptFooter, setReceiptFooter] = useState("Thank you for visiting!");
  const [orderPrefix, setOrderPrefix] = useState("ORD-");
  const [tipsEnabled, setTipsEnabled] = useState(false);

  const selectedItem =
    menuItems.find((item) => item.id === selectedItemId) ?? null;

  function handleUpdateItem(id: string, changes: Partial<MenuItem>) {
    setMenuItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...changes } : item))
    );
  }

  function handleAddItem() {
    const newItem: MenuItem = {
      id: createId(),
      name: "New Item",
      price: 0,
      category: "Breakfast",
    };

    setMenuItems((prev) => [...prev, newItem]);
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

    setMenuItems((prev) => [...prev, duplicatedItem]);
    setSelectedItemId(duplicatedItem.id);
  }

  function handleDeleteItem() {
    if (!selectedItem) {
      return;
    }

    setMenuItems((prev) => prev.filter((item) => item.id !== selectedItem.id));
    setSelectedItemId(null);
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
          menuItems={menuItems}
          selectedItemId={selectedItemId}
          onSelect={setSelectedItemId}
          businessName={businessName}
          accentColor={accentColor}
          taxEnabled={taxEnabled}
          taxRate={taxRate}
          pricesIncludeTax={pricesIncludeTax}
          showTaxSeparately={showTaxSeparately}
          currency={currency}
          receiptFooter={receiptFooter}
          orderPrefix={orderPrefix}
          tipsEnabled={tipsEnabled}
        />
        <EditorPropertiesPanel
          editorSection={editorSection}
          selectedItem={selectedItem}
          onUpdate={handleUpdateItem}
          onAdd={handleAddItem}
          onDuplicate={handleDuplicateItem}
          onDelete={handleDeleteItem}
          businessName={businessName}
          setBusinessName={setBusinessName}
          accentColor={accentColor}
          setAccentColor={setAccentColor}
          taxEnabled={taxEnabled}
          setTaxEnabled={setTaxEnabled}
          taxRate={taxRate}
          setTaxRate={setTaxRate}
          pricesIncludeTax={pricesIncludeTax}
          setPricesIncludeTax={setPricesIncludeTax}
          showTaxSeparately={showTaxSeparately}
          setShowTaxSeparately={setShowTaxSeparately}
          currency={currency}
          setCurrency={setCurrency}
          receiptFooter={receiptFooter}
          setReceiptFooter={setReceiptFooter}
          orderPrefix={orderPrefix}
          setOrderPrefix={setOrderPrefix}
          tipsEnabled={tipsEnabled}
          setTipsEnabled={setTipsEnabled}
        />
      </div>
    </div>
  );
}
