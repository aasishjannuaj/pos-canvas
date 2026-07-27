"use client";

import { useProductCategories } from "./useProductCategories";
import type { ProductBrowserProps } from "./shared";

// Feature 12.3 (bug fix) — Service Grid layout (salon). Category tabs are
// now real buttons backed by useProductCategories, which owns derivation/
// active-category fallback/filtering — this component only owns card
// size/spacing. Stock is never shown here by design (safeguard: de-emphasize
// stock for services) — but the out-of-stock gate below still runs the
// exact same trackInventory/stockQuantity check as every other layout, so a
// tracked item rendered under this layout (not just untracked Salon starter
// items) still behaves correctly in preview mode; it's just never labeled
// with a stock line. No appointment scheduling, employee assignment, or
// booking UI anywhere — add-to-cart is the same generic action as every
// other layout.
export default function ServiceGridBrowser({
  menuItems,
  selectedItemId,
  editorMode,
  branding,
  currencySymbol,
  onSelect,
  onAddToCart,
}: ProductBrowserProps) {
  const { categories, activeCategory, setActiveCategory, visibleItems } =
    useProductCategories(menuItems);

  if (categories.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 py-10 text-center">
        <p className="text-sm font-medium text-neutral-600">
          No services yet
        </p>
        <p className="text-xs text-neutral-400">
          Add a service in the Menu section.
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Section Tabs */}
      <div className="flex flex-none flex-wrap gap-2 border-b border-neutral-200 bg-white px-4 py-3">
        {categories.map((category) => {
          const isActive = category === activeCategory;

          return (
            <button
              key={category}
              type="button"
              onClick={() => setActiveCategory(category)}
              className={
                isActive
                  ? "rounded-full px-4 py-2 text-sm font-medium text-white"
                  : "rounded-full bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-600 transition-colors hover:bg-neutral-200"
              }
              style={isActive ? { backgroundColor: branding.accentColor } : undefined}
            >
              {category}
            </button>
          );
        })}
      </div>

      {/* Service Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {visibleItems.map((item) => {
            const isSelected =
              editorMode === "edit" && selectedItemId === item.id;
            const isOutOfStock =
              editorMode === "preview" &&
              item.trackInventory &&
              item.stockQuantity <= 0;

            return (
              <button
                key={item.id}
                type="button"
                disabled={isOutOfStock}
                onClick={() => {
                  if (editorMode === "edit") {
                    onSelect(item.id);
                  } else if (!isOutOfStock) {
                    onAddToCart(item);
                  }
                }}
                className={`flex min-h-[64px] flex-col justify-center gap-1.5 rounded-xl border p-4 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
                  isSelected
                    ? "text-white"
                    : "border-neutral-200 bg-neutral-50 hover:border-neutral-300"
                } ${isOutOfStock ? "cursor-not-allowed opacity-40" : ""}`}
                style={
                  isSelected
                    ? {
                        backgroundColor: branding.accentColor,
                        borderColor: branding.accentColor,
                      }
                    : undefined
                }
              >
                <span
                  className={`text-sm font-semibold leading-tight ${
                    isSelected ? "text-white" : "text-neutral-900"
                  }`}
                >
                  {item.name}
                </span>
                <span
                  className="text-base font-bold"
                  style={{
                    color: isSelected ? "#FFFFFF" : branding.accentColor,
                  }}
                >
                  {currencySymbol}
                  {item.price.toFixed(2)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
