import { lookupBarcode } from "@/lib/barcode";
import type { BarcodeIndexResult } from "@/lib/barcode";
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

// ---------------------------------------------------------------------------
// v1.3 Lane 2 Task 2 — Liquor Store presentation support
// ---------------------------------------------------------------------------

// The template id that selects the Liquor Store PRESENTATION variant (see
// components/editor/pos-layouts/index.tsx).
//
// WHY A CONSTANT HERE AND NOT AN IMPORT FROM data/templates.ts. This layer is
// the UI-side layout registry; data/templates.ts is the canonical data registry
// and deliberately depends on nothing in components/. Reaching into it from a
// browser component would invert that. The value is instead pinned by a guard
// (liquorStorePresentation.guards.test.ts) that asserts this string really is a
// registered template AND that its layout is still "product-grid" — so the two
// cannot drift apart silently.
//
// NOTE WHAT THIS IS NOT: it selects a presentation, never a behavior. Nothing
// downstream of this constant prices, taxes, discounts, or persists anything.
export const LIQUOR_STORE_TEMPLATE_ID = "liquor-store";

// v1.3 Lane 2 Retail Store — the template id that selects the Retail Store
// PRESENTATION variant, for exactly the same reason and by exactly the same
// mechanism as the Liquor constant above.
//
// THE RETAIL TEMPLATE IS BEING UPGRADED, NOT REPLACED. "retail" is the id this
// project has always carried and its layout is still "product-grid": nothing is
// added to the registry, no seventh template exists, and no PosLayout value is
// introduced — a new layout would change the canonical hash of every existing
// retail project for a purely visual change.
//
// Pinned by the same kind of guard as the Liquor constant
// (retailStorePresentation.test.ts), which asserts this string really is a
// registered template AND that its layout remains "product-grid", so the UI
// registry and data/templates.ts cannot drift apart silently.
export const RETAIL_STORE_TEMPLATE_ID = "retail";

// The pseudo-category meaning "do not filter". Deliberately NOT derived from
// menuItems, so it exists even for an empty menu.
//
// A merchant category genuinely named "All" collapses into this one pill (see
// useProductCategories), which shows every product — the same thing that
// merchant would expect that pill to do.
export const ALL_CATEGORY = "All";

/**
 * Search input reduced to the form matching compares against.
 *
 * Trimmed and lowercased, so "  VODKA " and "vodka" are the same query and a
 * cashier who fat-fingers a leading space still gets results.
 */
export function normalizeSearchTerm(term: string): string {
  return term.trim().toLowerCase();
}

/**
 * Does this product match an already-normalized query?
 *
 * Substring, over the product NAME and its CATEGORY — category included because
 * "wine" is how a cashier asks for the wine shelf, and requiring them to notice
 * that wine is a category rather than a word in a name is a worse register.
 *
 * Matches only what is already loaded. There is no barcode field on MenuItem in
 * this version, so nothing here searches one, and no query leaves the browser.
 */
export function matchesProductSearch(item: MenuItem, normalizedTerm: string): boolean {
  if (normalizedTerm === "") {
    return true;
  }

  return (
    item.name.toLowerCase().includes(normalizedTerm) ||
    displayCategory(item.category).toLowerCase().includes(normalizedTerm)
  );
}

/**
 * What the catalog should show right now, given a category selection AND a
 * search box.
 *
 * THE ONE RULE THAT MATTERS: an active search searches the WHOLE loaded
 * catalog and ignores the selected category. The alternative — intersecting
 * them — produces the single worst outcome at a register: a cashier types a
 * product they can see on the shelf, gets "no results" because a category pill
 * they forgot about is still active, and concludes the product is not in the
 * system.
 *
 * The category selection is not cleared, only bypassed, so clearing the search
 * returns to exactly the category the cashier was browsing.
 *
 * Pure and separated from the component precisely so this rule is testable —
 * this repository has no DOM test environment.
 */
export function resolveCatalogItems(input: {
  /** Every loaded product, for search. */
  menuItems: MenuItem[];
  /** The category-filtered subset, for browsing. */
  categoryItems: MenuItem[];
  /** Raw, un-normalized search box contents. */
  searchTerm: string;
}): { items: MenuItem[]; searching: boolean } {
  const normalized = normalizeSearchTerm(input.searchTerm);

  if (normalized === "") {
    return { items: input.categoryItems, searching: false };
  }

  return {
    items: input.menuItems.filter((item) => matchesProductSearch(item, normalized)),
    searching: true,
  };
}


/**
 * v1.3 Feature 1E-B — which product, if any, does this scanned/typed value
 * activate?
 *
 * PURE, AND SEPARATED FROM THE COMPONENT FOR THE SAME REASON
 * resolveCatalogItems is: this repository has no DOM test environment, and
 * these are the rules where being wrong costs money — an exact match, a
 * case-sensitive one, one that keeps leading zeros, one that refuses a
 * duplicated catalogue, and one that resolves against the catalogue as it is
 * NOW. Asserting those by grepping a component is not proving them.
 *
 * IT IMPLEMENTS NO BARCODE RULE OF ITS OWN. Normalization, matching and the
 * duplicate refusal all belong to lib/barcode.ts; this composes them. There is
 * no second normalizer, index, parser or duplicate detector here, and there
 * must never be — `value` is handed to lookupBarcode exactly as received, so
 * manual-search normalization can never leak into barcode matching.
 *
 * Returns the CURRENT MenuItem, never one captured when the index was built:
 * lookupBarcode yields a durable id, and that id is resolved against the
 * menuItems passed in. A stale or removed id resolves to null rather than to
 * whatever now sits in that position.
 */
export type BarcodeActivation =
  /** An exact, usable match. `item` is the CURRENT catalogue entry. */
  | { status: "activated"; item: MenuItem }
  /**
   * The index was usable and this value is simply not in it.
   *
   * THE ONLY OUTCOME A CALLER MAY EVER REPORT TO THE CASHIER, and even then
   * only together with a fact this function does not have — see the note below
   * about why "not in the index" is not the same as "worth complaining about".
   */
  | { status: "not_found" }
  /**
   * The question could not be answered safely, so nothing was activated.
   *
   * Covers a catalogue the shared builder refused (a duplicated barcode) and an
   * id the catalogue no longer has. Deliberately NOT merged with `not_found`:
   * a duplicate is a configuration fault that would sell one product at
   * another's price, and telling a cashier "no matching product" about it would
   * be a lie that hides a real problem.
   */
  | { status: "unavailable" };

export function resolveBarcodeActivation(input: {
  /** The catalogue as it is now. */
  menuItems: readonly MenuItem[];
  /** The shared index, already built from that catalogue. */
  index: BarcodeIndexResult;
  /** The complete, untouched field value. */
  value: string;
}): BarcodeActivation {
  // FAIL SAFE on a catalogue the shared builder refused. A duplicated barcode
  // resolves to two products, and picking either sells one at the other's
  // price based on array order nobody can see.
  if (!input.index.ok) {
    return { status: "unavailable" };
  }

  const itemId = lookupBarcode(input.index.lookup, input.value);

  if (itemId === null) {
    return { status: "not_found" };
  }

  const item = input.menuItems.find((candidate) => candidate.id === itemId);

  // A durable id the catalogue no longer has. Unsafe rather than missing: the
  // value DID match a barcode, so "not found" would send the cashier looking
  // for a typo that is not there.
  return item === undefined ? { status: "unavailable" } : { status: "activated", item };
}
