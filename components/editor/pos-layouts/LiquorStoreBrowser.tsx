"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { buildBarcodeIndex } from "@/lib/barcode";
import { useProductCategories } from "./useProductCategories";
import { resolveBarcodeActivation, resolveCatalogItems } from "./shared";
import type { BarcodeActivation, ProductBrowserProps } from "./shared";
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
// A MISS IS NO LONGER NAMELESS. As of the RC-polish contract,
// resolveBarcodeActivation says WHICH way it declined — `not_found` or
// `unavailable` — and either way the field stays as ordinary search showing its
// ordinary results.
//
// WHY THE SEMANTIC SPLIT EXISTS AT ALL. A cashier typing "vodka" and an unknown
// scanned value are still the SAME EVENT to this handler, and no scanner-source
// detection will ever be added to tell them apart. So "not in the index" can
// never by itself justify a warning. The approved presentation rule combines it
// with a second fact this module already has — whether ordinary search found
// anything — and warns only when BOTH say nothing matched. That keeps "vodka"
// with vodka in stock silent, and is why the outcome is named rather than
// reported.
//
// RC-POLISH LANE 2B APPLIES THAT RULE. shouldWarnNoMatch below is the whole
// decision; the component shows "No matching product found" and plays one
// short tone only when it says so. `unavailable` never warns: it is a
// configuration fault, and calling it "no matching product" would hide it.

/**
 * RC-polish Lane 2B — does this accepted Enter deserve the no-match warning?
 *
 * BOTH FACTS, OR NOTHING. `not_found` alone is also what "vodka" produces, and
 * a cashier with vodka on the shelf must hear nothing. So the warning needs the
 * ordinary search for the SAME value — resolveCatalogItems, the one search rule
 * — to be an active search that found zero products.
 *
 * `unavailable` and `activated` are never a no-match. The wording is "No
 * matching product found", never "barcode": nothing here can know whether the
 * value was scanned, typed or pasted.
 *
 * Pure and exported so the rule is tested as behavior. RetailStoreBrowser
 * carries the same function, and a parity test runs one table through both.
 */
export function shouldWarnNoMatch(input: {
  activation: BarcodeActivation["status"];
  /** resolveCatalogItems' `searching` for the submitted value. */
  searching: boolean;
  /** resolveCatalogItems' item count for the submitted value. */
  resultCount: number;
}): boolean {
  return input.activation === "not_found" && input.searching && input.resultCount === 0;
}

/**
 * One short, quiet tone for the no-match warning.
 *
 * GENERATED, NOT LOADED: no audio file and no network asset. A fresh context
 * per call that closes itself when the tone ends, so nothing persists between
 * warnings and nothing listens. EVERY failure is swallowed — no Web Audio, a
 * suspended context, a throwing node — because a missing beep must never block
 * a search or a sale.
 */
function playNoMatchTone(): void {
  let context: AudioContext | null = null;

  try {
    if (typeof window === "undefined" || typeof window.AudioContext !== "function") {
      return;
    }

    context = new window.AudioContext();

    // A context that is not running would never reach `onended`, and so would
    // never close. Say nothing rather than leak one per Enter.
    if (context.state !== "running") {
      void context.close().catch(() => undefined);
      return;
    }

    const tone = context.createOscillator();
    const gain = context.createGain();
    const start = context.currentTime;

    tone.type = "sine";
    tone.frequency.setValueAtTime(440, start);
    gain.gain.setValueAtTime(0.12, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);

    tone.connect(gain);
    gain.connect(context.destination);

    const closing = context;
    tone.onended = () => {
      void closing.close().catch(() => undefined);
    };

    tone.start(start);
    tone.stop(start + 0.18);
  } catch {
    try {
      void context?.close().catch(() => undefined);
    } catch {
      // Already closed, or never opened. Nothing to clean up.
    }
  }
}

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
  /**
   * v1.3 RC-polish — a monotonic request to focus the Search / Scan field.
   *
   * See the effect below for the mechanism, and
   * components/editor/pos-layouts/index.tsx for why it is optional.
   */
  scanFocusRequest?: number;
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
  scanFocusRequest,
}: LiquorStoreBrowserProps) {
  // includeAll is the ONLY behavioral difference this browser asks of the
  // shared hook. Every other caller omits it and is unchanged.
  const { categories, activeCategory, setActiveCategory, visibleItems } =
    useProductCategories(menuItems, { includeAll: true });

  const [searchTerm, setSearchTerm] = useState("");

  /**
   * RC-polish Lane 2B — PRESENTATION ONLY. Whether the Search / Scan input
   * currently has focus, as the input itself reports through onFocus/onBlur.
   *
   * It drives the "Ready to scan" line and nothing else: it never focuses or
   * blurs anything, never leaves this component, and is not read by the
   * barcode handler. Lane 1's nonce effect remains the only thing that moves
   * focus.
   */
  const [searchScanFocused, setSearchScanFocused] = useState(false);

  /**
   * RC-polish Lane 2B — set by an accepted Enter that shouldWarnNoMatch
   * accepted; cleared by any edit to the field and by a successful activation.
   * A boolean, never the entered value, and never persisted.
   */
  const [noMatchWarning, setNoMatchWarning] = useState(false);

  /**
   * The Search / Scan field, held privately.
   *
   * NOT FORWARDED, NOT AN IMPERATIVE HANDLE. The ref never leaves this
   * component, so no parent can focus, blur, read or clear the input. The only
   * thing that crosses the boundary is a number.
   */
  const searchInputRef = useRef<HTMLInputElement>(null);

  /**
   * Focus the Search / Scan field when the host asks, and at no other time.
   *
   * THE TWO MOMENTS THIS COVERS, and why one effect is enough for both:
   *
   *   activation — mounting runs the effect once. The live till remounts this
   *                tree whenever the selling surface becomes active again,
   *                because the employee, Auto-Lock and register gates replace
   *                PosRuntime rather than cover it. So unlock, Ring Out and
   *                first load all arrive here as a mount, free.
   *   after a sale — the selling surface does NOT remount when a sale ends;
   *                the checkout is an overlay over a tree that never went
   *                away. There is no mount to hook, which is the entire reason
   *                a nonce exists: PosRuntime increments it when the cashier
   *                dismisses a COMPLETED sale, and the dependency change is
   *                the only other thing that runs this.
   *
   * WHY THIS CANNOT STEAL FOCUS. The dependency is a value that changes at
   * exactly those two moments. Nothing polls, nothing reads
   * document.activeElement, nothing re-asserts focus from a focus or blur
   * event, and nothing re-asserts focus on render. (Lane 2B's onFocus/onBlur
   * only flip the "Ready to scan" presentation flag; they never move focus.) A cashier who tabs into the cart or clicks a
   * product keeps the caret until the next completed sale, because until then
   * no dependency changes and this effect does not run.
   *
   * WHY `undefined` RETURNS. An absent prop means "this host is not a till" —
   * today that is the Builder preview, which must never pull the caret out of
   * whatever field the owner is typing in. Absence, not detection.
   */
  useEffect(() => {
    if (scanFocusRequest === undefined) {
      return;
    }

    searchInputRef.current?.focus();
  }, [scanFocusRequest]);


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
    // resolution, and it NAMES the way it declined rather than collapsing a
    // refused index, a miss and a vanished id into one answer.
    const activation = resolveBarcodeActivation({
      menuItems,
      index: barcodeIndex,
      value: searchTerm,
    });

    // ONE semantic decision per accepted Enter. The three outcomes are
    // exhaustive, and only one of them does anything.
    //
    // `not_found` and `unavailable` both stay ordinary search: keep the query,
    // keep the filtered results, touch nothing. They are kept APART rather than
    // collapsed because they mean different things to whoever reports them —
    // `not_found` is "this value is not in the catalogue", `unavailable` is
    // "the catalogue could not be asked safely" (a duplicated barcode, or an id
    // that has since gone). A later presentation checkpoint shows a warning for
    // `not_found` AND ONLY when ordinary search also found nothing, so a
    // cashier typing "vodka" with vodka in stock stays silent. Nothing here
    // detects a scanner.
    //
    // RC-polish Lane 2B — that checkpoint. A miss still keeps the query and the
    // results; the only addition is the warning and its one tone, and only
    // when the ordinary search for this same value (`searching`/`items`,
    // computed above from this searchTerm) found nothing.
    if (activation.status !== "activated") {
      if (shouldWarnNoMatch({ activation: activation.status, searching, resultCount: items.length })) {
        setNoMatchWarning(true);
        playNoMatchTone();
      }
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
    setNoMatchWarning(false);
    setSearchTerm("");
    onAddToCart(activation.item);
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
            ref={searchInputRef}
            type="text"
            inputMode="search"
            value={searchTerm}
            onChange={(event) => {
              setSearchTerm(event.target.value);
              // Any edit — including clearing — retires the warning. A warning
              // belongs to the value that was submitted, not the next one.
              setNoMatchWarning(false);
            }}
            onKeyDown={handleSearchKeyDown}
            // Presentation only — see searchScanFocused. Neither handler
            // focuses, blurs or reads anything.
            onFocus={() => setSearchScanFocused(true)}
            onBlur={() => setSearchScanFocused(false)}
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

        {/* RC-polish Lane 2B — the scan status line. Only a scan-capable
            project gets one: with scanning off there is nothing to be ready
            for, so nothing is claimed. It describes THIS FIELD, never a device:
            no scanner is detected, and none is said to be connected.

            The warning outranks readiness and shows only while the search it
            was raised for is still active, so clearing the field by any route
            removes it with the query. */}
        {barcodeScanningEnabled && (
          <div className="mt-1.5 flex h-5 items-center gap-1.5 text-xs font-medium">
            {noMatchWarning && searching ? (
              <p role="alert" className="flex items-center gap-1.5 text-red-700">
                <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4 flex-none" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 3 2 17h16L10 3Z" />
                  <path d="M10 8v4M10 14.5v.01" />
                </svg>
                No matching product found
              </p>
            ) : searchScanFocused ? (
              <p className="flex items-center gap-1.5 text-emerald-700">
                <span aria-hidden="true" className="h-2 w-2 flex-none rounded-full bg-emerald-500" />
                Ready to scan
              </p>
            ) : (
              <p className="flex items-center gap-1.5 text-neutral-500">
                <span aria-hidden="true" className="h-2 w-2 flex-none rounded-full border border-neutral-400" />
                Select the search box before scanning
              </p>
            )}
          </div>
        )}
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
