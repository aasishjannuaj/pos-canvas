"use client";

import type { MenuCategory, MenuItem } from "./EditorShell";

const categoryOptions: MenuCategory[] = ["Breakfast", "Lunch", "Drinks"];

type EditorPropertiesPanelProps = {
  selectedItem: MenuItem | null;
  onUpdate: (id: string, changes: Partial<MenuItem>) => void;
};

export default function EditorPropertiesPanel({
  selectedItem,
  onUpdate,
}: EditorPropertiesPanelProps) {
  return (
    <aside className="flex w-80 flex-none flex-col gap-4 border-l border-neutral-200 bg-white p-6">
      <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
        Properties
      </h2>

      {selectedItem ? (
        <div className="flex flex-col gap-4">
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
    </aside>
  );
}
