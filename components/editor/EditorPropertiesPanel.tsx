"use client";

import type { EditorSection, MenuCategory, MenuItem } from "./EditorShell";

const categoryOptions: MenuCategory[] = ["Breakfast", "Lunch", "Drinks"];

type EditorPropertiesPanelProps = {
  editorSection: EditorSection;
  selectedItem: MenuItem | null;
  onUpdate: (id: string, changes: Partial<MenuItem>) => void;
  onAdd: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  businessName: string;
  setBusinessName: (value: string) => void;
  accentColor: string;
  setAccentColor: (value: string) => void;
};

export default function EditorPropertiesPanel({
  editorSection,
  selectedItem,
  onUpdate,
  onAdd,
  onDuplicate,
  onDelete,
  businessName,
  setBusinessName,
  accentColor,
  setAccentColor,
}: EditorPropertiesPanelProps) {
  return (
    <aside className="flex w-80 flex-none flex-col gap-4 border-l border-neutral-200 bg-white p-6">
      <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
        {editorSection}
      </h2>

      {editorSection === "Menu" && (
        <>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={onAdd}
              className="w-full rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
            >
              + Add Item
            </button>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={onDuplicate}
                disabled={!selectedItem}
                className="flex-1 rounded-full border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:border-blue-600 hover:text-blue-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:border-neutral-100 disabled:text-neutral-300 disabled:hover:border-neutral-100 disabled:hover:text-neutral-300"
              >
                Duplicate Item
              </button>

              <button
                type="button"
                onClick={onDelete}
                disabled={!selectedItem}
                className="flex-1 rounded-full border border-neutral-200 px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:border-red-600 hover:bg-red-600 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 disabled:cursor-not-allowed disabled:border-neutral-100 disabled:text-neutral-300 disabled:hover:border-neutral-100 disabled:hover:bg-transparent disabled:hover:text-neutral-300"
              >
                Delete Item
              </button>
            </div>
          </div>

          {selectedItem ? (
            <div className="flex flex-col gap-4 border-t border-neutral-200 pt-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                  Item Name
                </label>
                <input
                  type="text"
                  value={selectedItem.name}
                  onChange={(event) =>
                    onUpdate(selectedItem.id, { name: event.target.value })
                  }
                  className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                  Price
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={selectedItem.price}
                  onChange={(event) =>
                    onUpdate(selectedItem.id, {
                      price: Number(event.target.value) || 0,
                    })
                  }
                  className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                  Category
                </label>
                <select
                  value={selectedItem.category}
                  onChange={(event) =>
                    onUpdate(selectedItem.id, {
                      category: event.target.value as MenuCategory,
                    })
                  }
                  className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none"
                >
                  {categoryOptions.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-neutral-200 p-6 text-center">
              <span className="text-2xl">🧩</span>
              <p className="text-sm text-neutral-500">
                Select an item in the preview to edit its properties.
              </p>
            </div>
          )}
        </>
      )}

      {editorSection === "Branding" && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Business Name
            </label>
            <input
              type="text"
              value={businessName}
              onChange={(event) => setBusinessName(event.target.value)}
              className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Accent Color
            </label>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={accentColor}
                onChange={(event) => setAccentColor(event.target.value)}
                className="h-10 w-14 cursor-pointer rounded-lg border border-neutral-200 p-1"
              />
              <span className="text-sm text-neutral-600">{accentColor}</span>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Logo
            </label>
            <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-neutral-200 p-6 text-center">
              <span className="text-2xl">🖼️</span>
              <p className="text-sm text-neutral-500">
                Logo upload coming soon
              </p>
            </div>
          </div>
        </div>
      )}

      {editorSection === "Taxes" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-neutral-200 p-6 text-center">
          <span className="text-2xl">🧾</span>
          <p className="text-sm text-neutral-500">
            Tax settings coming soon
          </p>
        </div>
      )}

      {editorSection === "Settings" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-neutral-200 p-6 text-center">
          <span className="text-2xl">⚙️</span>
          <p className="text-sm text-neutral-500">
            Settings coming soon
          </p>
        </div>
      )}
    </aside>
  );
}
