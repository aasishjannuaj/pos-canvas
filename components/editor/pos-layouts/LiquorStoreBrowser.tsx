"use client";

import { useMemo, useState } from "react";
import { buildBarcodeIndex } from "@/lib/barcode";
import { useProductCategories } from "./useProductCategories";
import { resolveBarcodeActivation, resolveCatalogItems } from "./shared";
import type { ProductBrowserProps } from "./shared";
import type { MenuItem } from "@/components/editor/EditorShell";

// v1.3 Lane 2 Task 2 — the Liquor Store PRESENTATION variant.
//
// WHAT THIS IS. A fourth product browser, selected by templateId in
// ./index.tsx. It is a presentation only: it renders the same MenuItem[] every
// other browser renders and calls the same onSelect/onAddToCart the shared
// ProductBrowser hands it, so cart mutation, the modifier interception, stock
// ceilings, tax, checkout and persistence are all exactly the shared engine's,
// untouched and unduplicated.
//
// WHAT IT IS NOT. It is not a new layout: liquor-store is still
// layout: "product-grid" in the registry, and Retail still resolves to
// ProductGridBrowser. Nothing here is liquor-specific as BUSINESS logic — there
// is no age rule, no liquor tax, no liquor inventory behavior, and no category
// name is hardcoded (Beer/Wine/Spirits are starter data, nothing more).
//
// WHY IT LOOKS DIFFERENT FROM RETAIL. ProductGridBrowser's type scale was
// tuned for the Builder's ~384px phone mock and is reused unscaled on a 1280px
// till: 11px names and 9px stock badges, three fixed columns however wide the
// screen. A liquor counter is a high-volume register read at arm's length, so
// this trades that for a 15px name, a 20px price and a container-driven grid
// that actually densifies with width.
//
// SCANNING, AS OF v1.3 Feature 1E-B. The one search field below doubles as the
// scan field. There is no scanner engine here and there is not meant to be: a
// wedge scanner is a keyboard that types fast and presses Enter, so the whole
// integration is an Enter handler ON THAT INPUT. No global listener, no timing
// heuristic, no scanner-source detection, no prefix framing, no buffer — none
// of which could work reliably anyway, and all of which would make an ordinary
// cashier's Enter behave differently from a scanner's.
//
// TYPING IS NEVER SCANNING. onChange stays pure manual search. Only an accepted
// Enter consults the barcode index, and only an EXACT hit activates anything.
//
// A MISS IS SILENT ON PURPOSE. A cashier typing "vodka" and pressing Enter and
// an unknown scanned value both reach the same branch, and neither gets a
// barcode error — the two are intentionally indistinguishable, so the field
// simply stays as ordinary search showing its ordinary results.

function stockBadgeLabel(item: MenuItem): string {
  if (!item.trackInventory) {
    return "Not tracked";
  }

  if (item.stockQuantity <= 0) {
    return "Out of stock";
  }

  return `${item.stockQuantity} in stock`;
}

// The same three states ProductGridBrowser distinguishes, from the same two
// existing fields. No new threshold and no new inventory concept is introduced
// here — a "low stock" rule would be a business rule, and this is presentation.
function stockBadgeClassName(item: MenuItem): string {
  if (!item.trackInventory) {
    return "bg-neutral-100 text-neutral-500";
  }

  if (item.stockQuantity <= 0) {
    return "bg-red-50 text-red-700";
  }

  return "bg-emerald-50 text-emerald-700";
}

/**
 * v1.3 Feature 1E-B — the ALREADY-RESOLVED answer to "may this project scan?".
 *
 * A BOOLEAN, NEVER ProjectFeatures. The feature model's compatibility rule
 * (absence means enabled, only a literal false disables) lives in
 * lib/projectFeatures.ts and is applied by whoever owns the configuration —
 * PosRuntime for a till, EditorShell for the Builder. Presentation interpreting
 * that model would be a second copy of the rule, free to drift from the first.
 *
 * It is also NOT derived from templateId. The capability belongs to the
 * project: a convenience store may scan, and a liquor store with no scanner may
 * not. Deriving it from the template would make both impossible.
 */
type LiquorStoreBrowserProps = ProductBrowserProps & {
  barcodeScanningEnabled: boolean;
};

export default function LiquorStoreBrowser({
  menuItems,
  selectedItemId,
  editorMode,
  branding,
  currencySymbol,
  onSelect,
  onAddToCart,
  barcodeScanningEnabled,
}: LiquorStoreBrowserProps) {
  // includeAll is the ONLY behavioral difference this browser asks of the
  // shared hook. Every other caller omits it and is unchanged.
  const { categories, activeCategory, setActiveCategory, visibleItems } =
    useProductCategories(menuItems, { includeAll: true });

  const [searchTerm, setSearchTerm] = useState("");

  // The category/search interaction rule lives in shared.ts as a pure function
  // so it is actually tested — this repository has no DOM test environment.
  const { items, searching } = resolveCatalogItems({
    menuItems,
    categoryItems: visibleItems,
    searchTerm,
  });

  // Built from the CURRENT menuItems, by the shared builder, so a configuration
  // change reindexes and there is exactly one index implementation in the
  // product. `enabled` is handed to the builder as well as checked below: a
  // disabled project therefore has an EMPTY index, so even a mistake in the
  // handler could not resolve anything.
  const barcodeIndex = useMemo(
    () => buildBarcodeIndex(menuItems, { enabled: barcodeScanningEnabled }),
    [menuItems, barcodeScanningEnabled]
  );

  /**
   * The entire barcode integration.
   *
   * THE REJECTS COME FIRST, and each is a real failure mode rather than
   * defensive noise:
   *
   *   disabled    — the project said no; Enter must do nothing barcode-shaped,
   *                 and in particular must not clear the field.
   *   composing   — an IME uses Enter to accept a candidate. A cashier writing
   *                 Japanese would otherwise activate a product mid-word.
   *   repeat      — a held Enter autorepeats. One press must mean one add.
   *   not Enter   — every other key is ordinary typing.
   *
   * Then resolveBarcodeActivation decides, against the COMPLETE, untouched
   * searchTerm. It refuses a duplicated catalogue, looks the value up exactly
   * through lib/barcode.ts — trim only, case preserved, leading zeros preserved,
   * deliberately NOT manual-search normalization, because "A1b2" and "a1B2" are
   * two different products in a case-sensitive symbology — and resolves the
   * durable id it gets back against the catalogue as it is now.
   */
  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!barcodeScanningEnabled) {
      return;
    }

    if (event.nativeEvent.isComposing) {
      return;
    }

    if (event.repeat) {
      return;
    }

    if (event.key !== "Enter") {
      return;
    }

    // The COMPLETE, untouched field value. One shared decision covers the
    // duplicate refusal, the exact lookup and the current-catalogue
    // resolution — and null covers every way this can decline: a refused
    // index, a miss, or an id the catalogue no longer has.
    const currentItem = resolveBarcodeActivation({
      menuItems,
      index: barcodeIndex,
      value: searchTerm,
    });

    if (currentItem === null) {
      // Stay ordinary search: keep the query, keep the filtered results, say
      // nothing about barcodes.
      return;
    }

    // The ONE activation, through the ONE shared path. ProductBrowser
    // intercepts this and opens ModifierSelector when the product needs it;
    // PosRuntime's updater remains the authoritative stock decision.
    //
    // CLEARING IS NOT A RECEIPT. The field clears because the cashier is
    // finished with that value, not because the add succeeded — addToCart
    // returns void and cannot truthfully say. An exact hit that the
    // authoritative updater later refuses for stock still clears, and that is
    // accepted for v1.3.
    setSearchTerm("");
    onAddToCart(currentItem);
  }

  // An empty menu yields zero categories. Same meaning as every other browser's
  // empty state: there is nothing configured yet, and the Builder is where that
  // is fixed.
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
      {/* Search row — ONE field, for both typing and scanning.
          A second "scan" input, a scan mode, or a scanner overlay would each
          force the cashier to decide which box to be in before they know what
          they are holding. */}
      <div className="flex-none border-b border-neutral-200 bg-white px-3 py-2.5">
        <div className="relative">
          <svg
            viewBox="0 0 20 20"
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <circle cx="9" cy="9" r="6" />
            <path d="m14 14 4 4" />
          </svg>

          <input
            type="text"
            inputMode="search"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={
              barcodeScanningEnabled
                ? "Search products or scan barcode"
                : "Search products…"
            }
            aria-label={
              barcodeScanningEnabled
                ? "Search products or scan barcode"
                : "Search products"
            }
            className="h-11 w-full rounded-lg border border-neutral-200 bg-neutral-50 pl-9 pr-10 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:bg-white focus:outline-none"
          />

          {searchTerm !== "" && (
            <button
              type="button"
              onClick={() => setSearchTerm("")}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              {/* Drawn, not typed: a glyph renders differently across the
                  Android WebView and Electron. */}
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="m5 5 10 10M15 5 5 15" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Category rail. Scrolls horizontally rather than wrapping or
          compressing, so six categories behave the same on a 411px till as on
          a 1280px register. Names come from the project's own menuItems. */}
      <div className="flex flex-none gap-2 overflow-x-auto border-b border-neutral-200 bg-white px-3 py-2">
        {categories.map((category) => {
          // While a search is active no pill is "the current view", because the
          // search is deliberately showing the whole catalog instead.
          const isActive = !searching && category === activeCategory;

          return (
            <button
              key={category}
              type="button"
              onClick={() => {
                // Picking a category exits search. Leaving the query in place
                // would make the tap appear to do nothing, since an active
                // search intentionally ignores the category.
                setSearchTerm("");
                setActiveCategory(category);
              }}
              className={`flex min-h-[40px] flex-none items-center rounded-full px-4 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
                isActive
                  ? "text-white"
                  : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200"
              }`}
              style={isActive ? { backgroundColor: branding.accentColor } : undefined}
            >
              {category}
            </button>
          );
        })}
      </div>

      {/* Catalog. Owns the vertical scrolling for this panel. */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
            <p className="text-sm font-medium text-neutral-600">
              {searching
                ? `No products match “${searchTerm.trim()}”`
                : "Nothing in this category"}
            </p>
            {searching && (
              <button
                type="button"
                onClick={() => setSearchTerm("")}
                className="rounded-full bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                Clear search
              </button>
            )}
          </div>
        ) : (
          // Container-driven, not a breakpoint ladder: auto-fill decides the
          // column count from the width this panel actually has, which is the
          // only thing that matters once a 384px cart sits beside it. One
          // number tunes it, and it is correct in the Builder's compact frame,
          // on a 411px till and on a 1280px register alike.
          <div className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-3">
            {items.map((item) => {
              const isSelected =
                editorMode === "edit" && selectedItemId === item.id;
              // Unchanged predicate, deliberately identical to every other
              // browser: stock only fences selling, never editing.
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
                      // The SHARED path. ProductBrowser intercepts this to open
                      // the modifier selector when the product has groups, so
                      // there is no second add-to-cart anywhere in here.
                      onAddToCart(item);
                    }
                  }}
                  className={`flex min-h-[116px] flex-col justify-between gap-2 rounded-lg border p-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
                    isSelected
                      ? "text-white"
                      : "border-neutral-200 bg-white hover:border-neutral-400 hover:bg-neutral-50"
                  } ${
                    isOutOfStock
                      ? "cursor-not-allowed border-neutral-200 bg-neutral-50 opacity-60"
                      : // Transient press acknowledgement only. No persistent
                        // runtime selection concept is introduced.
                        "active:border-neutral-500 active:bg-neutral-100"
                  }`}
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
                    className={`line-clamp-2 text-[15px] font-semibold leading-snug ${
                      isSelected ? "text-white" : "text-neutral-900"
                    }`}
                  >
                    {item.name}
                  </span>

                  <span className="flex flex-col gap-1.5">
                    <span
                      className="text-xl font-bold tabular-nums leading-none"
                      style={{ color: isSelected ? "#FFFFFF" : branding.accentColor }}
                    >
                      {currencySymbol}
                      {item.price.toFixed(2)}
                    </span>

                    <span
                      className={`w-fit rounded px-1.5 py-0.5 text-[11px] font-medium ${
                        isSelected ? "bg-white/20 text-white" : stockBadgeClassName(item)
                      }`}
                    >
                      {stockBadgeLabel(item)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
