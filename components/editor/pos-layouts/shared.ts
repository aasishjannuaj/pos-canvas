import type {
  EditorMode,
  MenuItem,
  ProjectConfig,
} from "@/components/editor/EditorShell";

// Feature 12.3 — the one shared interface every product-browser layout
// implements. Only presentation differs between layouts (see
// MenuGridBrowser/ProductGridBrowser/ServiceGridBrowser) — every layout
// calls the exact same onSelect/onAddToCart callbacks and reads the exact
// same MenuItem data, so cart/checkout/inventory behavior can never diverge
// per layout.
export type ProductBrowserProps = {
  menuItems: MenuItem[];
  selectedItemId: string | null;
  editorMode: EditorMode;
  branding: ProjectConfig["branding"];
  currencySymbol: string;
  onSelect: (id: string) => void;
  onAddToCart: (menuItem: MenuItem) => void;
};

// Feature 12.2 — category tabs/sections are derived from the project's own
// menuItems rather than a fixed global list. Trimmed so a stray whitespace
// difference in a locally-edited category can never look like a duplicate
// tab; blank/whitespace-only categories fall back to "General". Moved here
// (from EditorPreview.tsx) since only the product-browser layouts need it
// now — the shared shell no longer renders items directly.
export function displayCategory(category: string): string {
  const trimmed = category.trim();
  return trimmed === "" ? "General" : trimmed;
}

// Feature 12.3 — categories present in the current menu, in first-seen
// order. An empty menu yields an empty array — callers render zero tabs and
// zero sections in that case, never a crash or a placeholder category.
export function deriveCategories(menuItems: MenuItem[]): string[] {
  return Array.from(new Set(menuItems.map((item) => displayCategory(item.category))));
}

// Feature 9.5/12.3 — moved here from EditorPreview.tsx unchanged. Used by
// MenuGridBrowser/ProductGridBrowser for their stock displays; ServiceGrid
// intentionally never calls this (services de-emphasize stock entirely).
export function getStockLabel(item: MenuItem): string {
  if (!item.trackInventory) {
    return "Inventory off";
  }

  if (item.stockQuantity <= 0) {
    return "Out of stock";
  }

  return `Stock: ${item.stockQuantity}`;
}
