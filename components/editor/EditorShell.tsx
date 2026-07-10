"use client";

import { useState } from "react";
import EditorTopBar from "./EditorTopBar";
import EditorSidebar from "./EditorSidebar";
import EditorPreview from "./EditorPreview";
import EditorPropertiesPanel from "./EditorPropertiesPanel";

export type MenuCategory = "Breakfast" | "Lunch" | "Drinks";

export type MenuItem = {
  id: string;
  name: string;
  price: number;
  category: MenuCategory;
};

export type EditorSection = "Menu" | "Branding" | "Taxes" | "Settings";

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
  return Date.now().toString();
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
        />
      </div>
    </div>
  );
}
