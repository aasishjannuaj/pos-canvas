"use client";

import { useProductCategories } from "./useProductCategories";
import type { ProductBrowserProps } from "./shared";
import type { MenuItem } from "@/components/editor/EditorShell";

// Feature 12.3 — Product Grid's own stock-badge wording (not shared with
// MenuGridBrowser's getStockLabel/edit-mode-only convention): safeguard #3
// requires untracked items show a neutral "Not tracked" treatment here,
// never a numeric quantity, and this badge is visible in both edit and
// preview mode (stronger stock visibility), unlike Menu Grid's edit-mode-only
// stock line. Same underlying trackInventory/stockQuantity fields — this is
// presentation only, no new logic.
function stockBadgeLabel(item: MenuItem): string {
  if (!item.trackInventory) {
    return "Not tracked";
  }

  if (item.stockQuantity <= 0) {
    return "Out of stock";
  }

  return `${item.stockQuantity} in stock`;
}

function stockBadgeClassName(item: MenuItem): string {
  if (!item.trackInventory) {
    return "bg-neutral-100 text-neutral-400";
  }

  if (item.stockQuantity <= 0) {
    return "bg-red-50 text-red-600";
  }

  return "bg-neutral-100 text-neutral-600";
}

// Feature 12.3 (bug fix) — Product Grid layout (retail, liquor-store).
// Category tabs are now real buttons backed by useProductCategories, which
// owns derivation/active-category fallback/filtering — this component only
// owns density/typography/stock-badge presentation. Calls the exact same
// onSelect/onAddToCart callbacks as every other layout — no barcode
// scanning or age-verification UI anywhere.
export default function ProductGridBrowser({
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
        <p className="text-sm font-medium text-neutral-600">No products yet</p>
        <p className="text-xs text-neutral-400">
          Add a product in the Menu section.
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Section Tabs */}
      <div className="flex flex-none gap-1.5 border-b border-neutral-200 bg-white px-3 py-2">
        {categories.map((category) => {
          const isActive = category === activeCategory;

          return (
            <button
              key={category}
              type="button"
              onClick={() => setActiveCategory(category)}
              className={
                isActive
                  ? "rounded-full px-2.5 py-1 text-[11px] font-medium text-white"
                  : "rounded-full bg-neutral-100 px-2.5 py-1 text-[11px] font-medium text-neutral-600 transition-colors hover:bg-neutral-200"
              }
              style={isActive ? { backgroundColor: branding.accentColor } : undefined}
            >
              {category}
            </button>
          );
        })}
      </div>

      {/* Product Content */}
      <div className="flex-1 overflow-y-auto px-2.5 py-2.5">
        <div className="grid grid-cols-3 gap-1.5">
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
                className={`flex flex-col justify-between gap-1 rounded-md border p-1.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
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
                  className={`text-[11px] font-medium leading-tight ${
                    isSelected ? "text-white" : "text-neutral-900"
                  }`}
                >
                  {item.name}
                </span>
                <span
                  className="text-sm font-bold"
                  style={{
                    color: isSelected ? "#FFFFFF" : branding.accentColor,
                  }}
                >
                  {currencySymbol}
                  {item.price.toFixed(2)}
                </span>
                <span
                  className={`w-fit rounded px-1 py-0.5 text-[9px] font-medium ${
                    isSelected ? "bg-white/20 text-white" : stockBadgeClassName(item)
                  }`}
                >
                  {stockBadgeLabel(item)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
