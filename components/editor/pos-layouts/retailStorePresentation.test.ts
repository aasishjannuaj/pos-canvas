// v1.3 Lane 2 Retail Store — the dedicated Retail presentation.
//
// Two kinds of assertion, deliberately separated, exactly as the accepted
// Liquor suite does:
//
//   1. REAL behavior tests over the pure functions in shared.ts. The
//      search/category interaction and the barcode activation rules are the
//      ones a cashier can actually be hurt by getting wrong, so they are
//      exercised as functions rather than asserted as strings.
//
//   2. Source-level guards for the wiring. This repository has no DOM
//      environment or React Testing Library (vitest.config.ts runs
//      environment: "node"), which is why PosRuntime.layout.test.ts and
//      modifierUx.guards.test.ts already assert component structure this way.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ALL_CATEGORY,
  RETAIL_STORE_TEMPLATE_ID,
  resolveBarcodeActivation,
  resolveCatalogItems,
} from "./shared";
import { buildBarcodeIndex } from "@/lib/barcode";
import { getTemplateById, templates } from "@/data/templates";
import type { MenuItem } from "@/lib/projectConfig";
import { shouldWarnNoMatch as retailShouldWarnNoMatch } from "./RetailStoreBrowser";
import { shouldWarnNoMatch as liquorShouldWarnNoMatch } from "./LiquorStoreBrowser";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p: string) => readFileSync(join(repoRoot, p), "utf-8");
const code = (src: string) =>
  src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const BROWSER = "components/editor/pos-layouts/RetailStoreBrowser.tsx";
const LIQUOR = "components/editor/pos-layouts/LiquorStoreBrowser.tsx";
const GENERIC = "components/editor/pos-layouts/ProductGridBrowser.tsx";
const SWITCH = "components/editor/pos-layouts/index.tsx";
const PREVIEW = "components/editor/EditorPreview.tsx";
const SHELL = "components/editor/EditorShell.tsx";
const RUNTIME = "components/runtime/PosRuntime.tsx";

const browser = code(read(BROWSER));
const sw = code(read(SWITCH));

function item(partial: Partial<MenuItem> & { id: string }): MenuItem {
  return {
    name: "Item",
    price: 1,
    category: "General",
    trackInventory: false,
    stockQuantity: 0,
    ...partial,
  };
}

// Deliberately generic retail names: nothing in the implementation may branch
// on any of these category strings.
const CATALOG: MenuItem[] = [
  item({ id: "1", name: "Paper Towels 6-Roll", category: "Household", barcode: "012345678905" }),
  item({ id: "2", name: "Dish Soap 500ml", category: "Household", barcode: "A1b2" }),
  item({ id: "3", name: "Ground Coffee 1lb", category: "Grocery" }),
  item({ id: "4", name: "AA Batteries 4-Pack", category: "Electronics", barcode: "99887766" }),
];

const INDEX = buildBarcodeIndex(CATALOG, { enabled: true });

// ---------------------------------------------------------------------------
// Routing — 1 to 7
// ---------------------------------------------------------------------------

describe("Retail is selected by templateId, not by layout", () => {
  it("1. retail routes to RetailStoreBrowser", () => {
    expect(sw).toContain("if (templateId === RETAIL_STORE_TEMPLATE_ID)");
    expect(sw).toContain("<RetailStoreBrowser");
    expect(sw).toContain('import RetailStoreBrowser from "./RetailStoreBrowser"');
  });

  it("2. liquor-store still routes to LiquorStoreBrowser", () => {
    expect(sw).toContain("if (templateId === LIQUOR_STORE_TEMPLATE_ID)");
    expect(sw).toContain("<LiquorStoreBrowser");
  });

  it("3. the generic product-grid arm still routes to ProductGridBrowser", () => {
    expect(sw).toContain('case "product-grid":');
    expect(sw).toContain("<ProductGridBrowser {...layoutProps} />");
  });

  it("4. menu-grid and service-grid arms are unchanged", () => {
    expect(sw).toContain('case "service-grid":');
    expect(sw).toContain("<ServiceGridBrowser {...layoutProps} />");
    expect(sw).toContain('case "menu-grid":');
    expect(sw).toContain("default:");
    expect(sw).toContain("<MenuGridBrowser {...layoutProps} />");
  });

  it("5. the routing constant is a real registered template whose layout is still product-grid", () => {
    expect(RETAIL_STORE_TEMPLATE_ID).toBe("retail");
    expect(getTemplateById(RETAIL_STORE_TEMPLATE_ID)).toBeDefined();
    expect(getTemplateById(RETAIL_STORE_TEMPLATE_ID)?.layout).toBe("product-grid");
    // No seventh template was invented for this feature.
    expect(templates.filter((t) => t.id === RETAIL_STORE_TEMPLATE_ID)).toHaveLength(1);
  });

  it("6. no new PosLayout value was introduced", () => {
    // Same registry-driven check the accepted Liquor suite makes...
    const known = new Set(["menu-grid", "product-grid", "service-grid"]);
    for (const template of templates) {
      expect(`${template.id}: ${template.layout}`).toBe(`${template.id}: ${template.layout}`);
      expect(known.has(template.layout)).toBe(true);
    }
    // ...plus the type union itself, so a fourth value cannot be added to
    // lib/posLayout.ts without failing here. A new layout would change the
    // canonical config hash of every existing project on it.
    expect(read("lib/posLayout.ts")).toContain(
      'export type PosLayout = "menu-grid" | "product-grid" | "service-grid";'
    );
    expect(sw).not.toContain('case "retail-grid"');
    expect(sw).not.toContain('"retail-store"');
  });

  it("7. both dedicated branches occur before the generic switch", () => {
    const liquorAt = sw.indexOf("if (templateId === LIQUOR_STORE_TEMPLATE_ID)");
    const retailAt = sw.indexOf("if (templateId === RETAIL_STORE_TEMPLATE_ID)");
    const switchAt = sw.indexOf("switch (layout)");

    expect(liquorAt).toBeGreaterThan(-1);
    expect(retailAt).toBeGreaterThan(-1);
    expect(liquorAt).toBeLessThan(switchAt);
    expect(retailAt).toBeLessThan(switchAt);
  });
});

// ---------------------------------------------------------------------------
// Barcode feature boundary — 8 to 15
// ---------------------------------------------------------------------------

describe("barcode enablement reaches Retail already resolved", () => {
  it("8. Retail receives only the resolved boolean", () => {
    expect(browser).toContain("barcodeScanningEnabled: boolean");
    expect(sw).toContain("barcodeScanningEnabled: boolean;");
    expect(sw).not.toContain("barcodeScanningEnabled?: boolean");
    expect(browser).not.toContain("barcodeScanningEnabled = ");
  });

  it("9. Retail never sees the feature model", () => {
    expect(browser).not.toContain("ProjectFeatures");
    expect(browser).not.toContain("@/lib/projectFeatures");
  });

  it("10. Retail performs no feature interpretation", () => {
    expect(browser).not.toContain("isBarcodeScanningEnabled");
    expect(browser).not.toContain("barcodeScanning?.");
    expect(browser).not.toContain("!== false");
  });

  it("11. templateId does not enable barcode", () => {
    expect(browser).not.toContain("templateId");
    expect(browser).not.toContain(RETAIL_STORE_TEMPLATE_ID);

    // The switch uses templateId ONLY to choose a presentation. The capability
    // must be FORWARDED, never computed from the template there.
    //
    // This asserts the forwarded expression EXACTLY and then refuses any
    // templateId inside every such expression. The first spelling of this
    // guard in the Liquor suite used [^{]* between `=` and `templateId`, which
    // could never cross the opening brace of a JSX expression, so
    // `barcodeScanningEnabled={templateId === "retail"}` sailed past it.
    expect(sw).toContain("barcodeScanningEnabled={barcodeScanningEnabled}");

    const matches = [...sw.matchAll(/barcodeScanningEnabled=\{([^}]*)\}/g)];
    expect(matches.length).toBeGreaterThan(0);

    for (const match of matches) {
      expect(`forwarded: ${match[1]}`).toBe(`forwarded: ${match[1]}`);
      expect(match[1]).not.toContain("templateId");
      expect(match[1].trim()).toBe("barcodeScanningEnabled");
    }
  });

  it("12. Retail implements no barcode normalization of its own", () => {
    for (const banned of [
      "normalizeBarcode",
      "normalizeOptionalBarcode",
      "toLowerCase()",
      "replace(/^0+/",
      "padStart",
    ]) {
      expect(`${BROWSER}: ${banned}`).toBe(`${BROWSER}: ${banned}`);
      expect(browser).not.toContain(banned);
    }
  });

  it("13. Retail builds no index or map of its own", () => {
    expect(browser).toContain("buildBarcodeIndex(menuItems, { enabled: barcodeScanningEnabled })");
    expect(browser).toContain('from "@/lib/barcode"');
    for (const banned of ["new Map", "new Set", "lookup[", "Object.fromEntries"]) {
      expect(`${BROWSER}: ${banned}`).toBe(`${BROWSER}: ${banned}`);
      expect(browser).not.toContain(banned);
    }
  });

  it("14. Retail implements no duplicate detector", () => {
    for (const banned of ["duplicate", "Duplicate", "index.ok", "!index.ok"]) {
      expect(`${BROWSER}: ${banned}`).toBe(`${BROWSER}: ${banned}`);
      expect(browser).not.toContain(banned);
    }
  });

  it("15. Retail implements no parser and calls lookupBarcode only through the shared resolver", () => {
    expect(browser).toContain("resolveBarcodeActivation({");
    expect(browser).not.toContain("lookupBarcode");
    for (const banned of ["parse", "checkDigit", "symbology", "EAN", "UPC"]) {
      expect(`${BROWSER}: ${banned}`).toBe(`${BROWSER}: ${banned}`);
      expect(browser).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// Search / Scan — 16 to 32
// ---------------------------------------------------------------------------

describe("there is exactly one Search / Scan field", () => {
  it("16. renders a single input", () => {
    expect([...browser.matchAll(/<input/g)]).toHaveLength(1);
  });

  it("16b. has no scan mode, overlay, modal or hidden capture field", () => {
    for (const banned of [
      'type="hidden"',
      "scanMode",
      "scanOverlay",
      "ScanOverlay",
      "sr-only",
      "opacity-0",
      "position: absolute; left: -9999",
    ]) {
      expect(`${BROWSER}: ${banned}`).toBe(`${BROWSER}: ${banned}`);
      expect(browser).not.toContain(banned);
    }
  });

  // RC-polish Lane 2B — onChange now also retires the no-match warning. It
  // still sets searchTerm from the field and does nothing else: no
  // activation, no warning, no sound.
  const onChange = browser.slice(browser.indexOf("onChange={"), browser.indexOf("onKeyDown={"));

  it("17. typing only changes searchTerm (and retires the warning)", () => {
    expect(onChange).toContain("setSearchTerm(event.target.value);");
    expect(onChange).toContain("setNoMatchWarning(false);");
    expect([...onChange.matchAll(/set\w+\(/g)].map((m) => m[0]).sort()).toEqual([
      "setNoMatchWarning(",
      "setSearchTerm(",
    ]);
  });

  it("18. typing activates nothing — activation lives only in the key handler", () => {
    const onChangeAt = browser.indexOf("onChange={");
    const handlerAt = browser.indexOf("function handleSearchKeyDown");
    expect(onChangeAt).toBeGreaterThan(-1);
    for (const banned of ["onAddToCart", "resolveBarcodeActivation", "playNoMatchTone", "setNoMatchWarning(true)"]) {
      expect(`onChange: ${banned}`).toBe(`onChange: ${banned}`);
      expect(onChange).not.toContain(banned);
    }
    expect(handlerAt).toBeGreaterThan(-1);
    // resolveBarcodeActivation is referenced exactly once, inside the handler.
    expect([...browser.matchAll(/resolveBarcodeActivation\(/g)]).toHaveLength(1);
  });

  it("19. rejects an Enter that is confirming an IME composition", () => {
    expect(browser).toContain("if (event.nativeEvent.isComposing)");
  });

  it("20. rejects an autorepeating held Enter, so one press is one add", () => {
    expect(browser).toContain("if (event.repeat)");
  });

  it("21. rejects every key that is not Enter", () => {
    expect(browser).toContain('if (event.key !== "Enter")');
  });

  it("21b. rejects in the accepted order: disabled, composing, repeat, not-Enter", () => {
    const order = [
      "if (!barcodeScanningEnabled)",
      "if (event.nativeEvent.isComposing)",
      "if (event.repeat)",
      'if (event.key !== "Enter")',
      "resolveBarcodeActivation({",
    ].map((needle) => {
      const at = browser.indexOf(needle);
      expect(`${needle} present`).toBe(`${needle} present`);
      expect(at).toBeGreaterThan(-1);
      return at;
    });

    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  /**
   * RC-polish: the resolver names its outcome instead of returning null.
   *
   * `not_found` and `unavailable` are asserted apart on purpose — a value that
   * is simply absent and a catalogue that cannot be asked safely are different
   * facts, and only the first could ever justify telling the cashier anything.
   */
  const statusOf = (value: string, menuItems = CATALOG, idx = INDEX) =>
    resolveBarcodeActivation({ menuItems, index: idx, value }).status;

  const activatedItem = (value: string, menuItems = CATALOG, idx = INDEX) => {
    const result = resolveBarcodeActivation({ menuItems, index: idx, value });

    expect(result.status).toBe("activated");

    if (result.status !== "activated") throw new Error("unreachable");

    return result.item;
  };

  it("22. an exact hit activates once, clearing the field first", () => {
    // Behavior, through the shared resolver.
    expect(activatedItem("012345678905")).toBe(CATALOG[0]);

    // Wiring: exactly one onAddToCart call inside the handler, preceded by the
    // field clear.
    const handler = browser.slice(
      browser.indexOf("function handleSearchKeyDown"),
      browser.indexOf("if (categories.length === 0)")
    );
    expect([...handler.matchAll(/onAddToCart\(/g)]).toHaveLength(1);
    expect(handler).toContain('setSearchTerm("");\n    onAddToCart(activation.item);');
  });

  it("23. is case-sensitive, because Code 39/128 alphabets are", () => {
    expect(activatedItem("A1b2")).toBe(CATALOG[1]);
    expect(statusOf("a1B2")).toBe("not_found");
  });

  it("24. preserves leading zeros — the stripped value is a different code", () => {
    expect(statusOf("12345678905")).toBe("not_found");
  });

  it("25. does not activate on a prefix", () => {
    expect(statusOf("01234567890")).toBe("not_found");
  });

  it("26. does not activate on a partial or extended value", () => {
    expect(statusOf("0123456789050")).toBe("not_found");
    expect(statusOf("2345678905")).toBe("not_found");
  });

  it("27. does not activate on a manual-search match", () => {
    // Both are `not_found`, and both must stay silent in presentation. This is
    // why `not_found` alone may never drive a warning.
    expect(statusOf("Paper Towels 6-Roll")).toBe("not_found");
    expect(statusOf("coffee")).toBe("not_found");
  });

  it("28 + 29. an unmatched Enter preserves the query and the manual results", () => {
    // The handler returns BEFORE setSearchTerm("") on a null resolution, so the
    // query and therefore the filtered results survive.
    const handler = browser.slice(
      browser.indexOf("const activation = resolveBarcodeActivation"),
      browser.indexOf('setSearchTerm("");')
    );
    expect(handler).toContain('if (activation.status !== "activated")');
    expect(handler).toContain("return;");
    expect(handler).not.toContain("setSearchTerm");

    // And the manual results for that query are unaffected.
    const { items, searching } = resolveCatalogItems({
      menuItems: CATALOG,
      categoryItems: [CATALOG[2]],
      searchTerm: "soap",
    });
    expect(searching).toBe(true);
    expect(items).toEqual([CATALOG[1]]);
  });

  it("30. shows no barcode-specific error anywhere", () => {
    // RC-polish Lane 2B — the ONE approved warning, removed before the bans
    // run so its "No match…" prefix cannot hide any other wording. It must
    // appear exactly once.
    expect(browser.split("No matching product found").length - 1).toBe(1);
    const withoutApproved = browser.replace("No matching product found", "");

    for (const banned of [
      "not found",
      "Not found",
      "Unknown barcode",
      "No match",
      "Invalid barcode",
      "Barcode not",
      "try again",
    ]) {
      expect(`${BROWSER}: ${banned}`).toBe(`${BROWSER}: ${banned}`);
      expect(withoutApproved).not.toContain(banned);
    }
  });

  it("31. a stale item id fails safely, as UNAVAILABLE not not_found", () => {
    // The value matched a barcode; the product behind it is gone. That is an
    // unsafe activation state, not a missing product.
    const shrunk = [CATALOG[1], CATALOG[2], CATALOG[3]];

    expect(statusOf("012345678905", shrunk)).toBe("unavailable");
  });

  it("31b. a duplicated catalogue fails safe as UNAVAILABLE", () => {
    const dupes = [
      { ...CATALOG[0], id: "dup-a", barcode: "777" },
      { ...CATALOG[1], id: "dup-b", barcode: "777" },
    ];
    const refused = buildBarcodeIndex(dupes);

    expect(refused.ok).toBe(false);
    expect(statusOf("777", dupes, refused)).toBe("unavailable");
  });

  it("31c. returns one of exactly three statuses", () => {
    const seen = new Set([
      statusOf("012345678905"),
      statusOf("nope"),
      statusOf("012345678905", [CATALOG[1], CATALOG[2], CATALOG[3]]),
    ]);

    expect(seen).toEqual(new Set(["activated", "not_found", "unavailable"]));
  });

  it("32. resolves the durable id against the CURRENT catalogue", () => {
    const repriced = CATALOG.map((i) =>
      i.id === "1" ? { ...i, price: 99, name: "Paper Towels 6-Roll (new pack)" } : i
    );
    const resolved = activatedItem("012345678905", repriced);

    expect(resolved.price).toBe(99);
    expect(resolved).not.toBe(CATALOG[0]);
    // The handler hands it the live menuItems, not a captured copy.
    expect(browser).toContain("menuItems,\n      index: barcodeIndex,\n      value: searchTerm,");
  });

  it("32b. hands the untouched field value to the shared resolver", () => {
    expect(browser).toContain("value: searchTerm,");
    expect(browser).not.toContain("value: searchTerm.trim()");
    expect(browser).not.toContain("value: normalizeSearchTerm");
  });

  it("32c. the scan-capable placeholder appears only when the capability is on", () => {
    expect(browser).toContain('? "Search products or scan barcode"');
    expect(browser).toContain(': "Search products…"');
    expect(browser).toContain('aria-label={');
    expect(browser).toContain('barcodeScanningEnabled\n                ? "Search products or scan barcode"');
  });

  it("32d. does nothing barcode-shaped at all when the capability is off", () => {
    const handlerStart = browser.indexOf("function handleSearchKeyDown");
    const firstGuard = browser.indexOf("if (!barcodeScanningEnabled)", handlerStart);
    const resolver = browser.indexOf("resolveBarcodeActivation({", handlerStart);
    expect(firstGuard).toBeGreaterThan(handlerStart);
    expect(firstGuard).toBeLessThan(resolver);

    // A disabled project also gets an EMPTY index, so even a handler mistake
    // could resolve nothing.
    const disabled = buildBarcodeIndex(CATALOG, { enabled: false });

    // Nothing activates. The status is `not_found` rather than `unavailable`
    // because the builder yields an empty-but-usable index and lib/barcode.ts
    // is unchanged — the resolver genuinely cannot tell "switched off" from
    // "no product has a barcode". The handler's own reject above is the gate.
    expect(statusOf("012345678905", CATALOG, disabled)).not.toBe("activated");
    expect(statusOf("012345678905", CATALOG, disabled)).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// Categories — 33 to 40
// ---------------------------------------------------------------------------

describe("Retail categories stay merchant-driven", () => {
  it("33. opts in to the shared All pseudo-category", () => {
    expect(browser).toContain("useProductCategories(menuItems, { includeAll: true })");
  });

  it("34. All is the shared pseudo-category, not a derived one", () => {
    expect(ALL_CATEGORY).toBe("All");
    expect(browser).not.toContain('"All"');
  });

  it("35. renders whatever the shared hook derives from the project's own items", () => {
    expect(browser).toContain("categories.map((category)");
    expect(browser).toContain("setActiveCategory(category)");
    expect(browser).not.toContain("deriveCategories");
    expect(browser).not.toContain("displayCategory");
  });

  it("36. hardcodes no retail business category", () => {
    for (const banned of [
      "Grocery",
      "Household",
      "Apparel",
      "Electronics",
      "Beverages",
      "Produce",
      "Pharmacy",
    ]) {
      expect(`${BROWSER}: ${banned}`).toBe(`${BROWSER}: ${banned}`);
      expect(browser).not.toContain(banned);
    }
  });

  it("37. the narrow rail scrolls horizontally rather than wrapping or compressing", () => {
    expect(browser).toContain("overflow-x-auto");
    expect(browser).toContain("flex-none");
    expect(browser).not.toContain("flex-wrap");
  });

  it("38. the rail becomes vertical once THIS panel is wide enough", () => {
    expect(browser).toContain("@xl:flex-col");
    expect(browser).toContain("@xl:w-40");
    expect(browser).toContain("@xl:overflow-y-auto");
    expect(browser).toContain("@xl:border-r");
    expect(browser).toContain("@xl:border-b-0");
    expect(browser).toContain("@xl:flex-row");
  });

  it("38a. the orientation is a CONTAINER query, never the browser viewport", () => {
    // THE REGRESSION THIS EXISTS FOR, found by rendered validation:
    // `md:*` is a VIEWPORT query. The Builder renders this component inside a
    // ~382px preview frame on a 1280px screen, so a viewport query saw
    // "desktop" and laid out a 160px vertical rail inside a 382px panel —
    // 42% of the width gone and a single product column left.
    //
    // A narrow embedded Retail panel must never switch to the wide layout just
    // because the OUTER browser viewport is desktop-sized. So the panel is a
    // container, and every orientation class is container-relative.
    expect(browser).toContain('className="@container');

    // NOT ONE viewport-width variant may decide this component's layout — of
    // any size, not just the `md:` the defect happened to use.
    //
    // A hand-written ban list cannot express this. A literal "xl:flex-col" is a
    // SUBSTRING of the correct "@xl:flex-col", so such a list bans the fix
    // along with the defect. This matches on the boundary instead: a viewport
    // variant is preceded by start-of-source, whitespace or a quote, while a
    // container variant is preceded by "@" and therefore never matches.
    const viewportVariants = [
      ...browser.matchAll(/(?:^|[\s"'`])(sm|md|lg|xl|2xl):[a-z0-9-]+/gi),
    ].map((m) => m[0].trim());

    expect(`${BROWSER} viewport variants: ${viewportVariants.join(", ")}`).toBe(
      `${BROWSER} viewport variants: `
    );
    expect(viewportVariants).toEqual([]);

    // And the container variants that replaced them are actually present.
    expect(browser).toContain("@xl:flex-col");
    expect(browser).toContain("@xl:w-40");
  });

  it("38b-container. the container is an ANCESTOR, not the queried element itself", () => {
    // An element cannot query its own container, so `@container` must sit on a
    // wrapper above the row that uses `@xl:flex-row`. If they were the same
    // element the rail would silently never switch.
    const containerAt = browser.indexOf('className="@container');
    const rowAt = browser.indexOf("@xl:flex-row");
    expect(containerAt).toBeGreaterThan(-1);
    expect(rowAt).toBeGreaterThan(containerAt);
    expect(browser).not.toMatch(/className="@container[^"]*@xl:flex-row/);
  });

  it("38b. uses ONE category navigation markup, not a desktop and a mobile copy", () => {
    expect([...browser.matchAll(/categories\.map\(/g)]).toHaveLength(1);
    expect([...browser.matchAll(/<nav/g)]).toHaveLength(1);
    expect(browser).not.toContain("hidden @xl:flex");
    expect(browser).not.toContain("@xl:hidden");
  });

  it("39. the selected category stays selected during a search, only bypassed", () => {
    const browsing = resolveCatalogItems({
      menuItems: CATALOG,
      categoryItems: [CATALOG[0], CATALOG[1]],
      searchTerm: "",
    });
    expect(browsing.items).toEqual([CATALOG[0], CATALOG[1]]);
    expect(browsing.searching).toBe(false);

    // An active search searches the WHOLE catalogue, ignoring the category.
    const searching = resolveCatalogItems({
      menuItems: CATALOG,
      categoryItems: [CATALOG[0], CATALOG[1]],
      searchTerm: "coffee",
    });
    expect(searching.items).toEqual([CATALOG[2]]);
    expect(searching.searching).toBe(true);

    // Clearing the search returns to exactly the untouched category selection.
    const cleared = resolveCatalogItems({
      menuItems: CATALOG,
      categoryItems: [CATALOG[0], CATALOG[1]],
      searchTerm: "",
    });
    expect(cleared.items).toEqual([CATALOG[0], CATALOG[1]]);

    // Retail reuses that shared rule rather than restating it.
    expect(browser).toContain("resolveCatalogItems({");
    expect(browser).toContain("categoryItems: visibleItems,");
    expect(browser).not.toContain("matchesProductSearch");
    expect(browser).not.toContain("normalizeSearchTerm");
  });

  it("40. tapping a category during a search clears the search and enters it", () => {
    expect(browser).toContain('setSearchTerm("");\n                  setActiveCategory(category);');
  });

  it("40b. no pill reads as current while a search is active", () => {
    expect(browser).toContain("const isActive = !searching && category === activeCategory;");
  });
});

// ---------------------------------------------------------------------------
// Product cards — 41 to 52
// ---------------------------------------------------------------------------

describe("Retail cards show only truthful MenuItem data", () => {
  it("41. shows the product name with a two-line clamp", () => {
    expect(browser).toContain("{item.name}");
    expect(browser).toContain("line-clamp-2");
    expect(browser).toContain("text-[15px] font-semibold");
  });

  it("42. shows a prominent, column-aligned price in the merchant accent", () => {
    expect(browser).toContain("{currencySymbol}");
    expect(browser).toContain("{item.price.toFixed(2)}");
    expect(browser).toContain("font-bold tabular-nums");
    expect(browser).toContain("branding.accentColor");
  });

  it("43. untracked inventory reads Not tracked", () => {
    expect(browser).toContain('return "Not tracked";');
    expect(browser).toContain("if (!item.trackInventory)");
  });

  it("44. zero or negative tracked stock reads Out of stock", () => {
    expect(browser).toContain('return "Out of stock";');
    expect(browser).toContain("if (item.stockQuantity <= 0)");
  });

  it("45. positive tracked stock reads {N} in stock", () => {
    expect(browser).toContain("return `${item.stockQuantity} in stock`;");
  });

  it("46. does NOT use the shared getStockLabel, whose wording is different", () => {
    // getStockLabel says "Inventory off" and "Stock: N" — Menu Grid's wording.
    // Retail's three strings are the accepted Product-Grid wording and the
    // difference is visible to a cashier, so this must stay local.
    expect(browser).not.toContain("getStockLabel");
    expect(browser).not.toContain("Inventory off");
    expect(browser).not.toContain("Stock: ");
  });

  it("47. introduces no low-stock rule", () => {
    for (const banned of ["Low stock", "low stock", "lowStock", "< 5", "<= 5"]) {
      expect(`${BROWSER}: ${banned}`).toBe(`${BROWSER}: ${banned}`);
      expect(browser).not.toContain(banned);
    }
  });

  it("48. introduces no reorder or threshold concept", () => {
    for (const banned of ["reorder", "Reorder", "threshold", "Threshold", "parLevel", "minQty"]) {
      expect(`${BROWSER}: ${banned}`).toBe(`${BROWSER}: ${banned}`);
      expect(browser).not.toContain(banned);
    }
  });

  it("49. invents no business metadata the shared model has no field for", () => {
    for (const banned of [
      "sku",
      "SKU",
      "supplier",
      "Supplier",
      "vendor",
      "Vendor",
      "item.brand",
      "brandName",
      "wholesale",
      "cost",
      "packageSize",
      "warehouse",
      "<img",
      "background-image",
    ]) {
      expect(`${BROWSER}: ${banned}`).toBe(`${BROWSER}: ${banned}`);
      expect(browser).not.toContain(banned);
    }
  });

  it("50. never prints a barcode value on a card", () => {
    expect(browser).not.toContain("item.barcode");
    expect(browser).not.toContain("{item.barcode");
  });

  it("51. out-of-stock is disabled for selling in preview/runtime only", () => {
    expect(browser).toContain(
      "const isOutOfStock =\n                  editorMode === \"preview\" &&\n                  item.trackInventory &&\n                  item.stockQuantity <= 0;"
    );
    expect(browser).toContain("disabled={isOutOfStock}");
    expect(browser).toContain("cursor-not-allowed");
  });

  it("52. edit mode still selects the product regardless of stock", () => {
    expect(browser).toContain('if (editorMode === "edit") {\n                        onSelect(item.id);');
    expect(browser).toContain("} else if (!isOutOfStock) {");
  });
});

// ---------------------------------------------------------------------------
// Modifier / cart boundary — 53 to 60
// ---------------------------------------------------------------------------

describe("Retail sells through the shared engine only", () => {
  it("53 + 54. both entry points use the same shared onAddToCart", () => {
    expect(browser).toContain("onAddToCart(item);");
    expect(browser).toContain("onAddToCart(activation.item);");
    // The shared contract itself is unchanged, and Retail implements it rather
    // than widening it.
    expect(read("components/editor/pos-layouts/shared.ts")).toContain(
      "onAddToCart: (menuItem: MenuItem) => void;"
    );
    expect(browser).toContain("ProductBrowserProps & {");
  });

  it("55. an accepted Enter contains exactly one activation call", () => {
    const handler = browser.slice(
      browser.indexOf("function handleSearchKeyDown"),
      browser.indexOf("if (categories.length === 0)")
    );
    expect([...handler.matchAll(/onAddToCart\(/g)]).toHaveLength(1);
  });

  it("56. renders no selector of its own", () => {
    expect(browser).not.toContain("ModifierSelector");
    expect(browser).not.toContain("@/components/runtime/ModifierSelector");
  });

  it("57. inspects no modifier groups", () => {
    expect(browser).not.toContain("modifierGroups");
    expect(browser).not.toContain("normalizeModifierGroups");
    expect(browser).not.toContain("@/lib/modifiers");
  });

  it("58. mutates no cart", () => {
    for (const banned of [
      "setCart",
      "useCart",
      "@/lib/cart",
      "CartLine",
      "CartModifierSelection",
      "cartLines",
      "cart.",
      "cart[",
      "props.cart",
    ]) {
      expect(`${BROWSER}: ${banned}`).toBe(`${BROWSER}: ${banned}`);
      expect(browser).not.toContain(banned);
    }
  });

  it("59. runs no second activation preflight", () => {
    expect(browser).not.toContain("resolveItemActivation");
    expect(browser).not.toContain("@/lib/itemActivation");
  });

  it("60. duplicates no stock, tax, checkout or sale policy", () => {
    for (const banned of [
      "stockCeiling",
      "availableStock",
      "taxRate",
      "subtotal",
      "checkout",
      "complete_sale",
      "completeSale",
      "@/lib/inventory",
      "@/lib/tax",
    ]) {
      expect(`${BROWSER}: ${banned}`).toBe(`${BROWSER}: ${banned}`);
      expect(browser).not.toContain(banned);
    }
  });

  it("60b. carries no employee, register, time-clock or cash concept", () => {
    for (const banned of [
      "employee",
      "Employee",
      "register",
      "Register",
      "timeClock",
      "time_session",
      "cashMovement",
      "cash_movement",
      "business_date",
      "businessDate",
      "DAILY",
      "offline",
      "pinned",
    ]) {
      expect(`${BROWSER}: ${banned}`).toBe(`${BROWSER}: ${banned}`);
      expect(browser).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// Scanner / focus boundary — 61 to 69
// ---------------------------------------------------------------------------

describe("no scanner architecture and no focus stealing", () => {
  it("61 + 62 + 63. installs no global key listener", () => {
    // RC-polish Lane 2B — the no-match tone constructs a Web Audio context,
    // which is the ONLY reason `window.` may appear: twice, as
    // `window.AudioContext`, inside playNoMatchTone. Removing exactly those
    // lets `window.` stay banned everywhere else in the file.
    const tone = browser.slice(
      browser.indexOf("function playNoMatchTone"),
      browser.indexOf("function stockBadgeLabel")
    );
    expect(tone.split("window.").length - 1).toBe(browser.split("window.").length - 1);
    expect(tone.split("window.AudioContext").length - 1).toBe(2);
    const outsideTone = browser.split("window.AudioContext").join("");

    for (const banned of [
      "addEventListener",
      "window.",
      "document.",
      "keydown",
      "keypress",
      "keyup",
    ]) {
      expect(`${BROWSER}: ${banned}`).toBe(`${BROWSER}: ${banned}`);
      expect(outsideTone).not.toContain(banned);
    }
    // The ONE handler is a React prop on the field itself.
    expect(browser).toContain("onKeyDown={handleSearchKeyDown}");
    expect([...browser.matchAll(/onKeyDown=/g)]).toHaveLength(1);
  });

  it("64. runs no scan-timing detection", () => {
    for (const banned of ["Date.now", "performance.now", "setTimeout", "setInterval", "elapsed"]) {
      expect(`${BROWSER}: ${banned}`).toBe(`${BROWSER}: ${banned}`);
      expect(browser).not.toContain(banned);
    }
  });

  it("65. runs no scan-source detection", () => {
    for (const banned of ["isScanner", "isTrusted", "inputSource", "scanSource", "detectScanner"]) {
      expect(`${BROWSER}: ${banned}`).toBe(`${BROWSER}: ${banned}`);
      expect(browser).not.toContain(banned);
    }
  });

  it("66. implements no prefix or framing system", () => {
    for (const banned of ["prefix", "Prefix", "terminator", "Terminator", "framing", "STX", "ETX"]) {
      expect(`${BROWSER}: ${banned}`).toBe(`${BROWSER}: ${banned}`);
      expect(browser).not.toContain(banned);
    }
  });

  it("67. keeps no scanner buffer", () => {
    // `useRef` left this list in RC-polish: the ONE ref is the Search / Scan
    // input, asserted below. The buffer bans — which are what this test is
    // actually for — are unchanged.
    for (const banned of ["buffer", "Buffer", "scanBuffer", "interKey"]) {
      expect(`${BROWSER}: ${banned}`).toBe(`${BROWSER}: ${banned}`);
      expect(browser).not.toContain(banned);
    }
  });

  /**
   * RC-polish narrowed "never forces focus" to "never STEALS focus", in
   * parity with Liquor. The field may be focused when the host asks; every
   * mechanism that could take focus unasked stays banned.
   */
  it("68 + 69. never steals focus", () => {
    for (const banned of [
      "autoFocus",
      "createRef",
      "tabIndex",
      "document.activeElement",
      "setInterval",
      "setTimeout",
      "requestAnimationFrame",
      "blur()",
    ]) {
      expect(`${BROWSER}: ${banned}`).toBe(`${BROWSER}: ${banned}`);
      expect(browser).not.toContain(banned);
    }

    // RC-polish Lane 2B — onFocus/onBlur left the list above for the
    // scanner-ready PRESENTATION flag only: one of each, on the field, each
    // only setting that flag. They can observe focus; they cannot move it.
    expect(browser.split("onFocus").length - 1).toBe(1);
    expect(browser.split("onBlur").length - 1).toBe(1);
    expect(browser).toContain("onFocus={() => setSearchScanFocused(true)}");
    expect(browser).toContain("onBlur={() => setSearchScanFocused(false)}");
  });

  it("69a. holds exactly one ref, for the Search / Scan input, and never shares it", () => {
    expect([...browser.matchAll(/useRef[(<]/g)]).toHaveLength(1);
    expect(browser).toContain("const searchInputRef = useRef<HTMLInputElement>(null)");
    expect(browser).toContain("ref={searchInputRef}");

    for (const banned of [
      "forwardRef",
      "useImperativeHandle",
      "onFocusRequest",
      "inputRef={",
    ]) {
      expect(`${BROWSER}: ${banned}`).toBe(`${BROWSER}: ${banned}`);
      expect(browser).not.toContain(banned);
    }
  });

  it("69b. focuses exactly once, from the nonce effect only, installing nothing", () => {
    expect([...browser.matchAll(/\.focus\(\)/g)]).toHaveLength(1);
    expect([...browser.matchAll(/useEffect\(/g)]).toHaveLength(1);
    expect(browser).toContain("}, [scanFocusRequest]);");

    const effect = browser.slice(browser.indexOf("useEffect("));
    const body = effect.slice(0, effect.indexOf("}, ["));

    expect(body).toContain("searchInputRef.current?.focus()");
    expect(body).not.toContain("addEventListener");
  });

  it("69c. does nothing when the host does not ask, with no device detection", () => {
    expect(browser).toContain("if (scanFocusRequest === undefined) {");
    expect(browser).toContain("scanFocusRequest?: number;");
    expect(browser).not.toContain("setScanFocusRequest");

    for (const banned of ["isCapacitor", "navigator.", "ontouchstart", "matchMedia", "userAgent"]) {
      expect(`${BROWSER}: ${banned}`).toBe(`${BROWSER}: ${banned}`);
      expect(browser).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// Responsive / parity — 70 to 77
// ---------------------------------------------------------------------------

describe("Builder and runtime render the SAME Retail component", () => {
  it("70. only one module defines the presentation", () => {
    expect(browser).toContain("export default function RetailStoreBrowser");
    expect([...sw.matchAll(/<RetailStoreBrowser/g)]).toHaveLength(1);
    // No Builder-only variant exists.
    for (const banned of ["RetailStorePreview", "RetailStoreEditor", "RetailPreview"]) {
      expect(`${banned}`).toBe(`${banned}`);
      expect(sw).not.toContain(banned);
      expect(code(read(PREVIEW))).not.toContain(banned);
      expect(code(read(SHELL))).not.toContain(banned);
      expect(code(read(RUNTIME))).not.toContain(banned);
    }
  });

  it("71. both hosts reach it through the same ProductBrowser branch", () => {
    expect(code(read(RUNTIME))).toContain("templateId={config.project.templateId}");
    expect(code(read(RUNTIME))).toContain(
      "barcodeScanningEnabled={isBarcodeScanningEnabled(config.features)}"
    );
    expect(code(read(SHELL))).toContain("templateId={templateId}");
    expect(code(read(SHELL))).toContain(
      "barcodeScanningEnabled={isBarcodeScanningEnabled(projectConfig.features)}"
    );
    const preview = code(read(PREVIEW));
    expect(preview).toContain("templateId: string");
    expect(preview).toContain("templateId={templateId}");
    expect(preview).toContain("barcodeScanningEnabled={barcodeScanningEnabled}");
  });

  it("72. Retail has the container-relative vertical rail", () => {
    expect(browser).toContain("@container");
    expect(browser).toContain("@xl:flex-col");
  });

  it("73. Retail keeps the narrow horizontal rail", () => {
    expect(browser).toContain("overflow-x-auto");
  });

  it("74. uses a container-driven adaptive grid, never fixed columns", () => {
    expect(browser).toContain("grid-cols-[repeat(auto-fill,minmax(140px,1fr))]");
    expect(browser).not.toContain("grid-cols-3");
    expect(browser).not.toContain("grid-cols-2");
    expect(browser).not.toContain("grid-cols-4");
  });

  it("74b. the catalog owns the vertical scroll, not the row that contains it", () => {
    expect(browser).toContain("flex-1 overflow-y-auto");
    expect(browser).toContain("flex min-h-0 flex-1 flex-col @xl:flex-row");
  });

  it("75. renders no header and no branding of its own", () => {
    for (const banned of ["<header", "PosHeader", "logo", "Logo", "businessName"]) {
      expect(`${BROWSER}: ${banned}`).toBe(`${BROWSER}: ${banned}`);
      expect(browser).not.toContain(banned);
    }
  });

  it("76. is a distinct implementation from Liquor", () => {
    const liquor = code(read(LIQUOR));
    expect(browser).toContain("@xl:flex-col");
    expect(liquor).not.toContain("@xl:flex-col");
    // Liquor is horizontal at every width and needs no container at all.
    expect(liquor).not.toContain("@container");
    expect(browser).toContain("minmax(140px,1fr)");
    expect(liquor).toContain("minmax(148px,1fr)");
  });

  it("77. is a distinct implementation from the generic product grid", () => {
    const generic = code(read(GENERIC));
    expect(generic).toContain("grid-cols-3");
    expect(browser).not.toContain("grid-cols-3");
    expect(generic).toContain("text-[11px]");
    expect(browser).toContain("text-[15px]");
    // The generic grid stays untouched by this feature.
    expect(generic).not.toContain("templateId");
    expect(generic).not.toContain("retail");
  });
});

// ---------------------------------------------------------------------------
// Empty states — 78 to 80
// ---------------------------------------------------------------------------

describe("Retail empty states stay truthful", () => {
  it("78. an empty catalogue says nothing is configured yet", () => {
    expect(browser).toContain("No products yet");
    expect(browser).toContain("Add a product in the Menu section.");
    expect(browser).toContain("if (categories.length === 0)");
  });

  it("79. a zero-result search names the query and offers to clear it", () => {
    expect(browser).toContain("No products match ");
    expect(browser).toContain("${searchTerm.trim()}");
    expect(browser).toContain("Clear search");
    expect(browser).toContain("Nothing in this category");
  });

  it("80. the General fallback for a blank category stays shared, not reimplemented", () => {
    // displayCategory owns it; Retail must not restate it.
    expect(browser).not.toContain("General");
    expect(browser).not.toContain("displayCategory");

    const blank = [item({ id: "b1", name: "Unfiled", category: "   " })];
    const { items } = resolveCatalogItems({
      menuItems: blank,
      categoryItems: blank,
      searchTerm: "general",
    });
    expect(items).toEqual(blank);
  });
});

// ---------------------------------------------------------------------------
// RC-polish Lane 2B — scanner readiness, the no-match warning, and its tone
// ---------------------------------------------------------------------------

describe("Lane 2B: the no-match warning decision, as behavior", () => {
  // A catalogue where ordinary search and barcode lookup disagree on purpose.
  const CODED: MenuItem[] = [
    item({ id: "w1", name: "Vodka 750ml", category: "Spirits", barcode: "012345678905" }),
    item({ id: "w2", name: "IPA 6-Pack", category: "Beer", barcode: "A1b2" }),
    item({ id: "w3", name: "House Red Wine", category: "Wine" }),
  ];
  const CODED_INDEX = buildBarcodeIndex(CODED);

  /** The component's decision, composed from the SAME shared functions it calls. */
  const decide = (value: string, menuItems: MenuItem[] = CODED, index = CODED_INDEX) => {
    const activation = resolveBarcodeActivation({ menuItems, index, value });
    const { items, searching } = resolveCatalogItems({ menuItems, categoryItems: menuItems, searchTerm: value });

    return {
      status: activation.status,
      warn: retailShouldWarnNoMatch({ activation: activation.status, searching, resultCount: items.length }),
    };
  };

  it("an exact code activates and does not warn", () => {
    expect(decide("012345678905")).toEqual({ status: "activated", warn: false });
  });

  it("not_found + zero ordinary results warns", () => {
    expect(decide("99999999")).toEqual({ status: "not_found", warn: true });
  });

  it("not_found + ordinary results does NOT warn — 'vodka' with vodka in stock", () => {
    expect(decide("vodka")).toEqual({ status: "not_found", warn: false });
    expect(decide("IPA")).toEqual({ status: "not_found", warn: false });
  });

  it("leading zeros are preserved: the stripped code is a different, unmatched value", () => {
    expect(decide("12345678905")).toEqual({ status: "not_found", warn: true });
  });

  it("case is preserved: a case-swapped code activates nothing", () => {
    expect(decide("A1b2").status).toBe("activated");
    expect(decide("a1B2")).toEqual({ status: "not_found", warn: true });
  });

  it("an empty or whitespace Enter never warns — it is not a search", () => {
    expect(decide("").warn).toBe(false);
    expect(decide("   ").warn).toBe(false);
  });

  it("unavailable is never the no-match warning: a duplicated catalogue", () => {
    const dupes = [
      item({ id: "d1", name: "Cheap", barcode: "777" }),
      item({ id: "d2", name: "Dear", barcode: "777" }),
    ];
    // "777" matches no name or category, so only `unavailable` stands
    // between this and a warning.
    expect(decide("777", dupes, buildBarcodeIndex(dupes))).toEqual({ status: "unavailable", warn: false });
  });

  it("unavailable is never the no-match warning: a vanished id", () => {
    const shrunk = CODED.filter((i) => i.id !== "w1");
    expect(decide("012345678905", shrunk)).toEqual({ status: "unavailable", warn: false });
  });

  it("the rule itself, exhaustively", () => {
    for (const activation of ["activated", "not_found", "unavailable"] as const) {
      for (const searching of [true, false]) {
        for (const resultCount of [0, 1, 3]) {
          const expected = activation === "not_found" && searching && resultCount === 0;
          expect(`${activation}/${searching}/${resultCount}`).toBe(`${activation}/${searching}/${resultCount}`);
          expect(retailShouldWarnNoMatch({ activation, searching, resultCount })).toBe(expected);
        }
      }
    }
  });
});

describe("Lane 2B: the component wires the warning only to an accepted no-match Enter", () => {
  const src = code(read(BROWSER));
  const handler = src.slice(src.indexOf("function handleSearchKeyDown"), src.indexOf("if (categories.length === 0)"));
  const missBranch = handler.slice(
    handler.indexOf('if (activation.status !== "activated")'),
    handler.indexOf("setNoMatchWarning(false);")
  );

  it("decides with the ordinary search for the SAME searchTerm", () => {
    expect(missBranch).toContain(
      "shouldWarnNoMatch({ activation: activation.status, searching, resultCount: items.length })"
    );
    // `searching`/`items` are the render's own resolveCatalogItems over the
    // same searchTerm the activation was given — no second search algorithm.
    expect([...src.matchAll(/resolveCatalogItems\(/g)]).toHaveLength(1);
    expect(src).toContain("value: searchTerm,");
  });

  it("raises the warning and the tone only inside that decision, once each", () => {
    const decision = missBranch.slice(missBranch.indexOf("if (shouldWarnNoMatch("));
    // Up to the branch's own return — the call's object literal has braces.
    const body = decision.slice(0, decision.indexOf("return;"));

    expect(body).toContain("setNoMatchWarning(true);");
    expect(body).toContain("playNoMatchTone();");
    expect(src.split("setNoMatchWarning(true)").length - 1).toBe(1);
    // Declaration + one call: one accepted no-match Enter, one tone.
    expect(src.split("playNoMatchTone(").length - 1).toBe(2);
    // And still behind every reject: disabled, IME, repeat, not-Enter.
    expect(handler.indexOf('event.key !== "Enter"')).toBeLessThan(handler.indexOf("playNoMatchTone();"));
  });

  it("a miss still keeps the query, the category and the cart untouched", () => {
    expect(missBranch).toContain("return;");
    for (const banned of ["setSearchTerm", "setActiveCategory", "onAddToCart"]) {
      expect(`miss: ${banned}`).toBe(`miss: ${banned}`);
      expect(missBranch).not.toContain(banned);
    }
  });

  it("a successful activation clears the warning, then clears the field and adds once", () => {
    const success = handler.slice(handler.indexOf("setNoMatchWarning(false);"));
    expect(success.indexOf("setNoMatchWarning(false);")).toBeLessThan(success.indexOf('setSearchTerm("");'));
    expect(success.indexOf('setSearchTerm("");')).toBeLessThan(success.indexOf("onAddToCart(activation.item);"));
    expect(success).not.toContain("playNoMatchTone");
    expect([...handler.matchAll(/onAddToCart\(/g)]).toHaveLength(1);
  });

  it("any edit to the field clears the warning; typing never warns or sounds", () => {
    const onChange = src.slice(src.indexOf("onChange={"), src.indexOf("onKeyDown={"));
    expect(onChange).toContain("setNoMatchWarning(false);");
    expect(onChange).not.toContain("setNoMatchWarning(true)");
    expect(onChange).not.toContain("playNoMatchTone");
  });

  it("the warning shows only while the search it was raised for is active", () => {
    // Clearing by the X, the empty-state button or a category pill ends the
    // search, which hides it; the next keystroke resets the flag.
    expect(src).toContain("{noMatchWarning && searching ? (");
  });

  it("the copy is exactly 'No matching product found', never a barcode claim", () => {
    const raw = read(BROWSER);
    // Rendered exactly once (comments, which also quote it, are stripped).
    expect(src.split("No matching product found").length - 1).toBe(1);
    for (const banned of ["Barcode not found", "barcode not found", "Unknown barcode", "Scan failed"]) {
      expect(`${BROWSER}: ${banned}`).toBe(`${BROWSER}: ${banned}`);
      expect(raw).not.toContain(banned);
    }
  });

  it("the warning flag is a boolean and the entered value is never logged or persisted", () => {
    expect(src).toContain("const [noMatchWarning, setNoMatchWarning] = useState(false);");
    for (const banned of ["console.", "localStorage", "sessionStorage", "indexedDB", "analytics", "track(", "sendBeacon"]) {
      expect(`${BROWSER}: ${banned}`).toBe(`${BROWSER}: ${banned}`);
      expect(src).not.toContain(banned);
    }
  });
});

describe("Lane 2B: scanner readiness is local presentation of real focus", () => {
  const src = code(read(BROWSER));
  const statusLine = src.slice(
    src.indexOf("{barcodeScanningEnabled && ("),
    src.indexOf("</div>", src.indexOf("Select the search box before scanning"))
  );

  it("focus shows 'Ready to scan'; blur shows the instruction to select the field", () => {
    expect(statusLine).toContain(") : searchScanFocused ? (");
    const ready = statusLine.slice(statusLine.indexOf(") : searchScanFocused ? ("));
    expect(ready.indexOf("Ready to scan")).toBeGreaterThan(-1);
    expect(ready.indexOf("Ready to scan")).toBeLessThan(ready.indexOf("Select the search box before scanning"));
  });

  it("the focus flag is driven only by the input's own onFocus/onBlur", () => {
    expect(src).toContain("const [searchScanFocused, setSearchScanFocused] = useState(false);");
    expect(src.split("setSearchScanFocused(").length - 1).toBe(2);
    const input = src.slice(src.indexOf("<input"), src.indexOf("/>", src.indexOf("<input")));
    expect(input).toContain("onFocus={() => setSearchScanFocused(true)}");
    expect(input).toContain("onBlur={() => setSearchScanFocused(false)}");
  });

  it("scanning disabled presents no readiness at all", () => {
    // Every readiness and warning string lives inside the capability gate.
    const outside = src.replace(statusLine, "");
    for (const copy of ["Ready to scan", "Select the search box before scanning", "No matching product found"]) {
      expect(`${copy} is gated`).toBe(`${copy} is gated`);
      expect(statusLine).toContain(copy);
      expect(outside).not.toContain(copy);
    }
  });

  it("claims nothing about hardware", () => {
    const raw = read(BROWSER);
    for (const banned of ["Scanner connected", "scanner connected", "Scanner detected", "Scanner ready", "Listening"]) {
      expect(`${BROWSER}: ${banned}`).toBe(`${BROWSER}: ${banned}`);
      expect(raw).not.toContain(banned);
    }
  });

  it("adds no focus architecture: the flag never leaves the component or moves focus", () => {
    expect([...src.matchAll(/\.focus\(\)/g)]).toHaveLength(1);
    expect([...src.matchAll(/useEffect\(/g)]).toHaveLength(1);
    const effect = src.slice(src.indexOf("useEffect("));
    expect(effect.slice(0, effect.indexOf("}, ["))).not.toContain("searchScanFocused");
    for (const banned of [
      "searchScanFocused={",
      "noMatchWarning={",
      "onScanReady",
      "onReadyChange",
      "document.activeElement",
      ".blur()",
      "autoFocus",
      "addEventListener",
      "setTimeout",
      "setInterval",
    ]) {
      expect(`${BROWSER}: ${banned}`).toBe(`${BROWSER}: ${banned}`);
      expect(src).not.toContain(banned);
    }
  });
});

describe("Lane 2B: the no-match tone is tiny, local and cannot block anything", () => {
  const src = code(read(BROWSER));
  const tone = src.slice(src.indexOf("function playNoMatchTone"), src.indexOf("function stockBadgeLabel"));

  it("is generated with Web Audio, not loaded", () => {
    expect(tone).toContain("createOscillator()");
    for (const banned of ["new Audio(", ".mp3", ".wav", ".ogg", "fetch(", "http", "decodeAudioData"]) {
      expect(`${BROWSER}: ${banned}`).toBe(`${BROWSER}: ${banned}`);
      expect(src).not.toContain(banned);
    }
  });

  it("is short, stops itself, and closes its context", () => {
    expect(tone).toContain("tone.stop(start + 0.18);");
    expect(tone).toContain("tone.onended = () => {");
    expect(tone).toContain("closing.close()");
    // A context that would never reach onended is closed immediately.
    expect(tone).toContain('if (context.state !== "running") {');
  });

  it("swallows every failure", () => {
    expect(tone).toContain("try {");
    expect(tone).toContain("} catch {");
    expect(tone).toContain('typeof window.AudioContext !== "function"');
  });

  it("keeps no persistent audio object", () => {
    // The only AudioContext reference is inside the helper, held in a local.
    expect(src.replace(tone, "")).not.toContain("AudioContext");
    expect(tone).toContain("let context: AudioContext | null = null;");
  });
});

describe("Lane 2B: Liquor and Retail behave identically", () => {
  it("one decision table, two implementations, the same answers", () => {
    for (const activation of ["activated", "not_found", "unavailable"] as const) {
      for (const searching of [true, false]) {
        for (const resultCount of [0, 1, 7]) {
          const input = { activation, searching, resultCount };
          expect(`${activation}/${searching}/${resultCount}`).toBe(`${activation}/${searching}/${resultCount}`);
          expect(retailShouldWarnNoMatch(input)).toBe(liquorShouldWarnNoMatch(input));
        }
      }
    }
  });

  it("the same readiness, warning, clearing and tone wiring in both files", () => {
    const retail = code(read(BROWSER));
    const liquor = code(read(LIQUOR));
    for (const shared of [
      "const [searchScanFocused, setSearchScanFocused] = useState(false);",
      "const [noMatchWarning, setNoMatchWarning] = useState(false);",
      "onFocus={() => setSearchScanFocused(true)}",
      "onBlur={() => setSearchScanFocused(false)}",
      "shouldWarnNoMatch({ activation: activation.status, searching, resultCount: items.length })",
      "{noMatchWarning && searching ? (",
      ") : searchScanFocused ? (",
      "{barcodeScanningEnabled && (",
      "No matching product found",
      "Ready to scan",
      "Select the search box before scanning",
      "setNoMatchWarning(false);\n    setSearchTerm(\"\");\n    onAddToCart(activation.item);",
    ]) {
      expect(`parity: ${shared}`).toBe(`parity: ${shared}`);
      expect(retail).toContain(shared);
      expect(liquor).toContain(shared);
    }

    // The tone helper and the decision are the same code in both.
    const slice = (src: string) =>
      src
        .slice(src.indexOf("export function shouldWarnNoMatch"), src.indexOf("function stockBadgeLabel"))
        .trimEnd();
    expect(slice(retail)).toBe(slice(liquor));
  });
});
