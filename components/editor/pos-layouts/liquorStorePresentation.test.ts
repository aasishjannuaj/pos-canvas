// v1.3 Lane 2 Task 2 — Liquor Store presentation foundation.
//
// Two kinds of assertion, deliberately separated:
//
//   1. REAL behavior tests over the pure functions in shared.ts. The
//      search/category interaction rule is the one thing here a cashier can
//      actually be hurt by getting wrong, so it is extracted from the component
//      and tested as a function rather than asserted as a string.
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
  LIQUOR_STORE_TEMPLATE_ID,
  matchesProductSearch,
  normalizeSearchTerm,
  resolveCatalogItems,
} from "./shared";
import { getTemplateById, templates } from "@/data/templates";
import type { MenuItem } from "@/lib/projectConfig";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p: string) => readFileSync(join(repoRoot, p), "utf-8");
const code = (src: string) =>
  src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const BROWSER = "components/editor/pos-layouts/LiquorStoreBrowser.tsx";
const SWITCH = "components/editor/pos-layouts/index.tsx";
const PREVIEW = "components/editor/EditorPreview.tsx";
const SHELL = "components/editor/EditorShell.tsx";
const RUNTIME = "components/runtime/PosRuntime.tsx";

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

const CATALOG: MenuItem[] = [
  item({ id: "1", name: "Domestic Lager 6-Pack", category: "Beer" }),
  item({ id: "2", name: "IPA 6-Pack", category: "Beer" }),
  item({ id: "3", name: "House Red Wine", category: "Wine" }),
  item({ id: "4", name: "Vodka 750ml", category: "Spirits" }),
];

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe("the Liquor Store presentation is selected by templateId, not by layout", () => {
  it("the routing constant is a real registered template", () => {
    // Pins the string in shared.ts to the canonical registry without the UI
    // layer importing it at runtime.
    expect(getTemplateById(LIQUOR_STORE_TEMPLATE_ID)).toBeDefined();
  });

  it("liquor-store and retail BOTH still resolve to layout product-grid", () => {
    // The architecture rule: templateId chose a presentation, layout did not
    // change. A new PosLayout would have altered every liquor-store project's
    // generated-config hash.
    expect(getTemplateById(LIQUOR_STORE_TEMPLATE_ID)?.layout).toBe("product-grid");
    expect(getTemplateById("retail")?.layout).toBe("product-grid");
  });

  it("no new PosLayout value was introduced", () => {
    const known = new Set(["menu-grid", "product-grid", "service-grid"]);
    for (const template of templates) {
      expect(known.has(template.layout)).toBe(true);
    }
  });

  it("the switch checks templateId BEFORE the layout family", () => {
    const source = code(read(SWITCH));
    expect(source).toContain("if (templateId === LIQUOR_STORE_TEMPLATE_ID)");
    expect(source).toContain("<LiquorStoreBrowser {...layoutProps} />");

    expect(source.indexOf("LIQUOR_STORE_TEMPLATE_ID")).toBeLessThan(
      source.indexOf("switch (layout)")
    );
  });

  it("retail keeps resolving through the untouched layout switch", () => {
    const source = code(read(SWITCH));
    // The product-grid arm still points at ProductGridBrowser, and the liquor
    // branch is an addition above it rather than a replacement inside it.
    expect(source).toContain('case "product-grid":');
    expect(source).toContain("<ProductGridBrowser {...layoutProps} />");
    expect(source).not.toContain('case "liquor-grid"');
  });

  it("an unknown or legacy templateId falls through to today's behavior", () => {
    // The branch is an equality check against one id, so anything else reaches
    // the switch, whose menu-grid default is unchanged.
    const source = code(read(SWITCH));
    expect(source).toContain('case "menu-grid":');
    expect(source).toContain("default:");
    expect(source).toContain("<MenuGridBrowser {...layoutProps} />");
    // templateId is optional, so a caller that omits it is layout-only.
    expect(source).toContain("templateId?: string");
  });

  it("ProductGridBrowser is untouched by this feature", () => {
    const source = code(read("components/editor/pos-layouts/ProductGridBrowser.tsx"));
    expect(source).not.toContain("templateId");
    expect(source).not.toContain("liquor");
    expect(source).toContain("grid-cols-3");
  });
});

// ---------------------------------------------------------------------------
// Builder / runtime parity
// ---------------------------------------------------------------------------

describe("Builder and runtime render the SAME Liquor Store component", () => {
  it("only one module defines the presentation", () => {
    // A Builder-only mockup is exactly what Feature 19 removed for the header;
    // it must not come back for the catalog.
    expect(code(read(BROWSER))).toContain("export default function LiquorStoreBrowser");
    expect(code(read(SWITCH))).toContain('from "./LiquorStoreBrowser"');
  });

  it("templateId reaches the runtime's ProductBrowser from the pinned config", () => {
    const source = code(read(RUNTIME));
    expect(source).toContain("templateId={config.project.templateId}");
  });

  it("templateId reaches the Builder's ProductBrowser through EditorPreview", () => {
    expect(code(read(SHELL))).toContain("templateId={templateId}");

    const preview = code(read(PREVIEW));
    expect(preview).toContain("templateId: string");
    expect(preview).toContain("templateId={templateId}");
  });

  it("neither surface invents a second source of template identity", () => {
    // No fetch, no new persisted field: the runtime reads the pinned contract
    // and the Builder reads the prop it already had.
    const preview = code(read(PREVIEW));
    expect(preview).not.toContain("getTemplateById");
    expect(preview).not.toContain("fetch(");
    expect(code(read(RUNTIME))).not.toContain("getTemplateById");
  });
});

// ---------------------------------------------------------------------------
// Shared engine
// ---------------------------------------------------------------------------

describe("the Liquor Store browser sells through the shared engine only", () => {
  const source = code(read(BROWSER));

  it("uses the shared onAddToCart / onSelect callbacks", () => {
    expect(source).toContain("onAddToCart(item)");
    expect(source).toContain("onSelect(item.id)");
  });

  it("implements the shared ProductBrowserProps contract", () => {
    expect(source).toContain("ProductBrowserProps");
  });

  it("creates no second selling, modifier, cart or checkout path", () => {
    for (const banned of [
      "ModifierSelector",
      "modifierGroups",
      "calculateCartSummary",
      "createCartItem",
      "completeSale",
      "complete_sale",
      "supabase",
      "fetch(",
      "tax",
      "Checkout",
    ]) {
      expect(source).not.toContain(banned);
    }
  });

  it("reuses the existing stock fields and the existing out-of-stock predicate", () => {
    expect(source).toContain("item.trackInventory");
    expect(source).toContain("item.stockQuantity <= 0");
    expect(source).toContain('editorMode === "preview"');
    // No invented inventory concept.
    expect(source).not.toContain("lowStock");
    expect(source).not.toContain("LOW_STOCK");
  });

  it("owns the vertical scroll on its catalog, not on the search or category rows", () => {
    expect(source).toContain("flex-1 overflow-y-auto");
    // The two chrome rows stay put.
    expect(source.match(/flex-none/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// No faked barcode capability
// ---------------------------------------------------------------------------

describe("no barcode or scanner capability is implied", () => {
  const source = read(BROWSER); // raw, comments INCLUDED

  it("renders no scanner status or scan-event wording anywhere", () => {
    for (const banned of [
      "Ready to scan",
      "Scanner connected",
      "Scan successful",
      "Barcode recognized",
      "Scanner unavailable",
      "Unknown barcode",
    ]) {
      expect(source).not.toContain(banned);
    }
  });

  it("implements no barcode lookup, parsing or keyboard-wedge capture", () => {
    const executable = code(source);
    for (const banned of [
      "barcode",
      "Barcode",
      "onKeyDown",
      "keydown",
      "addEventListener",
      "scannerAvailability",
    ]) {
      expect(executable).not.toContain(banned);
    }
  });

  it("MenuItem still carries no barcode field, so there is nothing to search", () => {
    const config = code(read("lib/projectConfig.ts"));
    const type = config.slice(
      config.indexOf("export type MenuItem"),
      config.indexOf("export type Currency")
    );
    expect(type.toLowerCase()).not.toContain("barcode");
  });
});

// ---------------------------------------------------------------------------
// Search behavior (real tests, pure functions)
// ---------------------------------------------------------------------------

describe("normalizeSearchTerm", () => {
  it("trims and lowercases", () => {
    expect(normalizeSearchTerm("  VODKA ")).toBe("vodka");
  });

  it("reduces a whitespace-only query to empty, which means 'not searching'", () => {
    expect(normalizeSearchTerm("   ")).toBe("");
    expect(normalizeSearchTerm("")).toBe("");
  });
});

describe("matchesProductSearch", () => {
  const lager = CATALOG[0];

  it("matches a product name case-insensitively", () => {
    expect(matchesProductSearch(lager, "lager")).toBe(true);
    expect(matchesProductSearch(lager, "LAGER".toLowerCase())).toBe(true);
  });

  it("matches a substring anywhere in the name", () => {
    expect(matchesProductSearch(lager, "6-pack")).toBe(true);
  });

  it("matches on category, so 'wine' finds the wine shelf", () => {
    expect(matchesProductSearch(CATALOG[2], "wine")).toBe(true);
    expect(matchesProductSearch(CATALOG[3], "spirits")).toBe(true);
  });

  it("does not match an unrelated query", () => {
    expect(matchesProductSearch(lager, "tequila")).toBe(false);
  });

  it("treats an empty query as matching everything", () => {
    expect(matchesProductSearch(lager, "")).toBe(true);
  });

  it("falls back to the General category label for a blank category", () => {
    const blank = item({ id: "x", name: "Mystery", category: "   " });
    expect(matchesProductSearch(blank, "general")).toBe(true);
  });
});

describe("resolveCatalogItems — the search/category interaction rule", () => {
  const beerOnly = CATALOG.filter((i) => i.category === "Beer");

  it("shows the category selection when the search box is empty", () => {
    const result = resolveCatalogItems({
      menuItems: CATALOG,
      categoryItems: beerOnly,
      searchTerm: "",
    });
    expect(result.searching).toBe(false);
    expect(result.items).toEqual(beerOnly);
  });

  it("treats a whitespace-only query as not searching", () => {
    const result = resolveCatalogItems({
      menuItems: CATALOG,
      categoryItems: beerOnly,
      searchTerm: "   ",
    });
    expect(result.searching).toBe(false);
    expect(result.items).toEqual(beerOnly);
  });

  it("SEARCHES THE WHOLE CATALOG, ignoring the selected category", () => {
    // The rule that matters. With Beer selected, searching "vodka" must still
    // find the vodka — otherwise a cashier concludes the product is not in the
    // system because of a pill they forgot about.
    const result = resolveCatalogItems({
      menuItems: CATALOG,
      categoryItems: beerOnly,
      searchTerm: "vodka",
    });
    expect(result.searching).toBe(true);
    expect(result.items.map((i) => i.id)).toEqual(["4"]);
  });

  it("returns an empty list for a query nothing matches", () => {
    const result = resolveCatalogItems({
      menuItems: CATALOG,
      categoryItems: CATALOG,
      searchTerm: "tequila",
    });
    expect(result.searching).toBe(true);
    expect(result.items).toEqual([]);
  });

  it("restores the untouched category selection when the search is cleared", () => {
    const searched = resolveCatalogItems({
      menuItems: CATALOG,
      categoryItems: beerOnly,
      searchTerm: "vodka",
    });
    expect(searched.items).not.toEqual(beerOnly);

    const cleared = resolveCatalogItems({
      menuItems: CATALOG,
      categoryItems: beerOnly,
      searchTerm: "",
    });
    expect(cleared.items).toEqual(beerOnly);
  });

  it("never mutates the inputs", () => {
    const menu = [...CATALOG];
    const category = [...beerOnly];
    resolveCatalogItems({ menuItems: menu, categoryItems: category, searchTerm: "wine" });
    expect(menu).toEqual(CATALOG);
    expect(category).toEqual(beerOnly);
  });
});

// ---------------------------------------------------------------------------
// Category rail
// ---------------------------------------------------------------------------

describe("categories stay merchant-driven", () => {
  const source = code(read(BROWSER));

  it("hardcodes no liquor category name", () => {
    for (const name of ["Beer", "Wine", "Spirits", "Mixers", "Snacks"]) {
      expect(source).not.toContain(`"${name}"`);
    }
  });

  it("renders whatever the shared hook derives from the project's own items", () => {
    expect(source).toContain("useProductCategories(menuItems, { includeAll: true })");
    expect(source).toContain("categories.map(");
  });

  it("gives category buttons a touch-sized target", () => {
    expect(source).toContain("min-h-[40px]");
  });

  it("scrolls the rail horizontally instead of wrapping or compressing", () => {
    expect(source).toContain("overflow-x-auto");
    expect(source).toContain("flex-none");
  });

  it("exposes ALL_CATEGORY as a pseudo-category, not a derived one", () => {
    // It must exist even for an empty menu, so it cannot come from the data.
    expect(ALL_CATEGORY).toBe("All");
  });
});

// ---------------------------------------------------------------------------
// The All option is opt-in, so no existing template changes
// ---------------------------------------------------------------------------

describe("the All category is opt-in and cannot change existing templates", () => {
  const hook = code(read("components/editor/pos-layouts/useProductCategories.ts"));

  it("defaults to off", () => {
    expect(hook).toContain("options?.includeAll === true");
  });

  it("the other three browsers call the hook without options", () => {
    for (const layout of ["MenuGridBrowser", "ProductGridBrowser", "ServiceGridBrowser"]) {
      const source = code(read(`components/editor/pos-layouts/${layout}.tsx`));
      expect(source).toContain("useProductCategories(menuItems)");
      expect(source).not.toContain("includeAll");
    }
  });

  it("folds a merchant category literally named All into the single pill", () => {
    expect(hook).toContain("filter((category) => category !== ALL_CATEGORY)");
  });
});

// ---------------------------------------------------------------------------
// Presentation distinctness
// ---------------------------------------------------------------------------

describe("the Liquor Store catalog is visibly distinct from generic Retail", () => {
  const liquor = code(read(BROWSER));
  const retail = code(read("components/editor/pos-layouts/ProductGridBrowser.tsx"));

  it("uses a container-driven grid instead of Retail's fixed three columns", () => {
    expect(retail).toContain("grid-cols-3");
    expect(liquor).not.toContain("grid-cols-3");
    expect(liquor).toContain("grid-cols-[repeat(auto-fill,minmax(148px,1fr))]");
  });

  it("sets product names substantially larger than Retail's 11px", () => {
    expect(retail).toContain("text-[11px]");
    expect(liquor).toContain("text-[15px]");
  });

  it("makes the price dominant and column-aligned", () => {
    expect(liquor).toContain("text-xl font-bold tabular-nums");
  });

  it("gives cards a real minimum height and padding", () => {
    expect(liquor).toContain("min-h-[116px]");
    expect(liquor).toContain("p-3");
  });

  it("provides hover, transient pressed, and disabled states", () => {
    expect(liquor).toContain("hover:border-neutral-400");
    expect(liquor).toContain("active:bg-neutral-100");
    expect(liquor).toContain("cursor-not-allowed");
    expect(liquor).toContain("disabled={isOutOfStock}");
  });

  it("adds no decorative imagery", () => {
    expect(liquor).not.toContain("<img");
    expect(liquor).not.toContain("background-image");
  });
});
