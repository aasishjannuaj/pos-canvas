"use client";

import { useProductCategories } from "./useProductCategories";
import { getStockLabel } from "./shared";
import type { ProductBrowserProps } from "./shared";

// Feature 12.3 (bug fix) — Menu Grid layout (restaurant, cafe, food-truck).
// Category tabs are now real buttons backed by useProductCategories, which
// owns derivation/active-category fallback/filtering — this component only
// owns how tabs and item cards look. Same markup/classNames as the original
// faithful extraction, just wired to real selection instead of always
// showing every category stacked.
export default function MenuGridBrowser({
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
        <p className="text-sm font-medium text-neutral-600">No items yet</p>
        <p className="text-xs text-neutral-400">
          Add an item in the Menu section.
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Section Tabs */}
      <div className="flex flex-none gap-2 border-b border-neutral-200 bg-white px-3 py-2">
        {categories.map((category) => {
          const isActive = category === activeCategory;

          return (
            <button
              key={category}
              type="button"
              onClick={() => setActiveCategory(category)}
              className={
                isActive
                  ? "rounded-full px-3 py-1.5 text-xs font-medium text-white"
                  : "rounded-full bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-200"
              }
              style={isActive ? { backgroundColor: branding.accentColor } : undefined}
            >
              {category}
            </button>
          );
        })}
      </div>

      {/* Menu Content */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        <div className="grid grid-cols-2 gap-2">
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
                className={`flex flex-col justify-between gap-2 rounded-lg border p-2.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
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
                  className={`text-xs font-medium leading-tight ${
                    isSelected ? "text-white" : "text-neutral-900"
                  }`}
                >
                  {item.name}
                </span>
                <span
                  className="text-xs font-semibold"
                  style={{
                    color: isSelected ? "#FFFFFF" : branding.accentColor,
                  }}
                >
                  {currencySymbol}
                  {item.price.toFixed(2)}
                </span>
                {editorMode === "edit" && (
                  <span className="text-[10px] font-normal text-neutral-400">
                    {getStockLabel(item)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
