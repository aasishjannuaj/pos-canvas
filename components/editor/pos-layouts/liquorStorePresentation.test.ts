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
  resolveBarcodeActivation,
  resolveCatalogItems,
} from "./shared";
import { buildBarcodeIndex } from "@/lib/barcode";
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

    // The element and the intercepted spread, asserted separately: 1E-B added
    // a prop and split this across lines, and pinning the exact one-line JSX
    // was testing the formatter, not the routing.
    expect(source).toContain("<LiquorStoreBrowser");
    const liquorBranch = source.slice(
      source.indexOf("if (templateId === LIQUOR_STORE_TEMPLATE_ID)"),
      source.indexOf("switch (layout)")
    );
    expect(liquorBranch).toContain("{...layoutProps}");

    expect(source.indexOf("LIQUOR_STORE_TEMPLATE_ID")).toBeLessThan(
      source.indexOf("switch (layout)")
    );
  });

  // v1.3 Lane 2 Retail Store — this test used to be called "retail keeps
  // resolving through the untouched layout switch". Every assertion in it still
  // passed after Retail gained a dedicated presentation, but the NAME had become
  // false, and a test whose name asserts the opposite of reality is worse than
  // no test because the next reader trusts the name.
  //
  // The generic fallback property it really protects is kept intact and the
  // dedicated branches are now asserted alongside it, so this is strictly more
  // than was checked before.
  it("the generic product-grid arm is still intact and still ProductGridBrowser", () => {
    const source = code(read(SWITCH));
    // The product-grid arm still points at ProductGridBrowser, and both
    // dedicated branches are additions above it rather than replacements
    // inside it.
    expect(source).toContain('case "product-grid":');
    expect(source).toContain("<ProductGridBrowser {...layoutProps} />");
    expect(source).not.toContain('case "liquor-grid"');
    expect(source).not.toContain('case "retail-grid"');
  });

  it("both dedicated presentation branches exist and precede the generic switch", () => {
    const source = code(read(SWITCH));

    expect(source).toContain("if (templateId === LIQUOR_STORE_TEMPLATE_ID)");
    expect(source).toContain("if (templateId === RETAIL_STORE_TEMPLATE_ID)");

    const liquorAt = source.indexOf("if (templateId === LIQUOR_STORE_TEMPLATE_ID)");
    const retailAt = source.indexOf("if (templateId === RETAIL_STORE_TEMPLATE_ID)");
    const switchAt = source.indexOf("switch (layout)");

    expect(liquorAt).toBeGreaterThan(-1);
    expect(retailAt).toBeGreaterThan(-1);
    expect(liquorAt).toBeLessThan(switchAt);
    expect(retailAt).toBeLessThan(switchAt);
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

// ---------------------------------------------------------------------------
// v1.3 Feature 1E-B — barcode scanning through the one search field
// ---------------------------------------------------------------------------

describe("barcode enablement is a resolved project capability", () => {
  it("is resolved through the shared rule at each configuration owner", () => {
    // The till owns GeneratedPosConfig; the Builder owns ProjectConfig. Each
    // applies lib/projectFeatures.ts's rule itself, so there is one rule.
    expect(code(read(RUNTIME))).toContain(
      "barcodeScanningEnabled={isBarcodeScanningEnabled(config.features)}"
    );
    expect(code(read(SHELL))).toContain(
      "barcodeScanningEnabled={isBarcodeScanningEnabled(projectConfig.features)}"
    );
  });

  it("reaches the browser as a BOOLEAN, never as the feature model", () => {
    const browser = code(read(BROWSER));
    expect(browser).toContain("barcodeScanningEnabled: boolean");
    // Presentation must not interpret the model or restate its defaults.
    expect(browser).not.toContain("ProjectFeatures");
    expect(browser).not.toContain("isBarcodeScanningEnabled");
    expect(browser).not.toContain("@/lib/projectFeatures");
    expect(browser).not.toContain("barcodeScanning?.");
  });

  it("is required, so no host can omit it into a duplicated default", () => {
    const sw = code(read(SWITCH));
    expect(sw).toContain("barcodeScanningEnabled: boolean;");
    expect(sw).not.toContain("barcodeScanningEnabled?: boolean");
    expect(code(read(BROWSER))).not.toContain("barcodeScanningEnabled = ");
  });

  it("is never derived from templateId", () => {
    const browser = code(read(BROWSER));
    expect(browser).not.toContain("templateId");
    expect(browser).not.toContain("liquor-store");

    // The switch uses templateId only to choose a presentation. The capability
    // must be FORWARDED, never computed from the template there.
    //
    // The first spelling of this guard used [^{]* between the `=` and
    // `templateId`, which could never cross the opening brace of a JSX
    // expression — so `barcodeScanningEnabled={templateId === ...}` sailed
    // past it. A negative control caught that; this asserts the forwarded
    // expression exactly, and separately refuses any templateId inside it.
    const sw = code(read(SWITCH));
    expect(sw).toContain("barcodeScanningEnabled={barcodeScanningEnabled}");

    for (const match of sw.matchAll(/barcodeScanningEnabled=\{([^}]*)\}/g)) {
      expect(match[1]).toBe("barcodeScanningEnabled");
      expect(match[1]).not.toContain("templateId");
    }
  });

  it("the Builder and the till hand the same prop to the same component", () => {
    for (const file of [RUNTIME, PREVIEW]) {
      expect(code(read(file))).toContain("barcodeScanningEnabled={");
    }
    expect(code(read(PREVIEW))).toContain("barcodeScanningEnabled: boolean");
  });
});

describe("there is exactly one Search / Scan field", () => {
  const browser = code(read(BROWSER));

  it("renders a single input", () => {
    expect([...browser.matchAll(/<input\b/g)]).toHaveLength(1);
  });

  it("has no scan mode, overlay, modal or hidden capture field", () => {
    for (const banned of [
      'type="hidden"',
      "scanMode",
      "scannerOpen",
      "ScannerOverlay",
      "ScannerModal",
      "showScanner",
    ]) {
      expect(browser).not.toContain(banned);
    }
  });

  it("keeps searchTerm as the one field value, fed by ordinary onChange", () => {
    expect(browser).toContain("value={searchTerm}");
    expect(browser).toContain("onChange={(event) => setSearchTerm(event.target.value)}");
  });

  it("does not activate anything from typing — only from the key handler", () => {
    // onChange must do nothing but set state. If activation ever moved into
    // it, typing "012345678905" would sell an item mid-keystroke.
    const onChange = browser.slice(
      browser.indexOf("onChange={"),
      browser.indexOf("onKeyDown={")
    );
    expect(onChange).not.toContain("onAddToCart");
    expect(onChange).not.toContain("resolveBarcodeActivation");
  });

  it("shows the scan-capable placeholder only when the capability is on", () => {
    expect(browser).toContain('"Search products or scan barcode"');
    expect(browser).toContain('"Search products…"');
    expect(browser).toContain("barcodeScanningEnabled\n                ? \"Search products or scan barcode\"");
  });
});

describe("Enter is handled on the field, and only on the field", () => {
  const browser = code(read(BROWSER));
  const handler = browser.slice(
    browser.indexOf("function handleSearchKeyDown"),
    browser.indexOf("if (categories.length === 0)")
  );

  it("is wired to the input, not to the document or window", () => {
    expect(browser).toContain("onKeyDown={handleSearchKeyDown}");
    for (const banned of [
      "document.addEventListener",
      "window.addEventListener",
      "addEventListener",
      "useEffect",
    ]) {
      expect(browser).not.toContain(banned);
    }
  });

  it("does nothing at all when the capability is off", () => {
    expect(handler).toContain("if (!barcodeScanningEnabled) {");
    // And it is the FIRST reject, so a disabled project cannot even reach the
    // field-clearing branch.
    expect(handler.indexOf("!barcodeScanningEnabled")).toBeLessThan(
      handler.indexOf("event.key !== \"Enter\"")
    );
  });

  it("ignores an Enter that is confirming an IME composition", () => {
    expect(handler).toContain("event.nativeEvent.isComposing");
  });

  it("ignores an autorepeating held Enter, so one press is one add", () => {
    expect(handler).toContain("event.repeat");
  });

  it("ignores every key that is not Enter", () => {
    expect(handler).toContain('event.key !== "Enter"');
  });

  it("runs no scan-timing, scan-source or prefix-framing detection", () => {
    for (const banned of [
      "setTimeout",
      "setInterval",
      "Date.now",
      "performance.now",
      "scanSource",
      "scannerAvailability",
      "prefix",
      "buffer",
    ]) {
      expect(browser).not.toContain(banned);
    }
  });
});

describe("an accepted Enter activates through the shared path exactly once", () => {
  const browser = code(read(BROWSER));
  const handler = browser.slice(
    browser.indexOf("function handleSearchKeyDown"),
    browser.indexOf("if (categories.length === 0)")
  );

  it("clears the field and calls the normal onAddToCart, once", () => {
    expect(handler).toContain("setSearchTerm(\"\");");
    expect(handler).toContain("onAddToCart(currentItem);");
    expect([...handler.matchAll(/onAddToCart\(/g)]).toHaveLength(1);
  });

  it("runs no second activation preflight and mutates no cart directly", () => {
    for (const banned of [
      "resolveItemActivation",
      "canActivateItem",
      "setCart",
      "createCartItem",
      "calculateCartSummary",
      "getItemQuantityInCart",
    ]) {
      expect(browser).not.toContain(banned);
    }
  });

  it("duplicates no stock policy and shows no barcode stock refusal", () => {
    const raw = read(BROWSER);
    for (const banned of [
      "Cannot add",
      "out of stock —",
      "Out of stock —",
      "stockQuantity <= 0 &&",
    ]) {
      expect(raw).not.toContain(banned);
    }
    // addToCart stays void-returning upstream; nothing here reads a result.
    expect(browser).not.toContain("const added");
    expect(browser).not.toContain("await onAddToCart");
  });

  it("reaches ModifierSelector through the existing shared interception", () => {
    // The browser itself knows nothing about modifiers; ProductBrowser wraps
    // the handler it passes down, so a scanned modifier product opens the
    // selector by the same route a tapped one does.
    expect(browser).not.toContain("ModifierSelector");
    expect(browser).not.toContain("modifierGroups");

    const sw = code(read(SWITCH));
    expect(sw).toContain("const layoutProps = { ...props, onAddToCart: handleAddToCart };");
    expect(sw).toContain("<LiquorStoreBrowser");
    expect(sw).toContain("{...layoutProps}");
    expect(sw).toContain("ModifierSelector");
  });
});

describe("the barcode index is the shared one, built from current items", () => {
  const browser = code(read(BROWSER));

  it("uses buildBarcodeIndex over the current menuItems", () => {
    expect(browser).toContain("buildBarcodeIndex(menuItems, { enabled: barcodeScanningEnabled })");
    expect(browser).toContain("[menuItems, barcodeScanningEnabled]");
  });

  it("implements no normalizer, matcher, index or duplicate detector of its own", () => {
    for (const banned of [
      "normalizeBarcode",
      "normalizeOptionalBarcode",
      "findDuplicateBarcode",
      "new Map",
      "toLowerCase",
      "startsWith",
      "includes(",
      "padStart",
      "parseInt",
      "Number(",
    ]) {
      expect(browser).not.toContain(banned);
    }
  });

  it("hands the untouched field value to the shared resolver", () => {
    expect(browser).toContain("value: searchTerm,");
    // Not the manual-search normalization, which lowercases.
    expect(browser).not.toContain("normalizeSearchTerm(searchTerm)");
  });
});

// --- REAL behavior, over the pure resolver -------------------------------

describe("resolveBarcodeActivation", () => {
  const CODED: MenuItem[] = [
    item({ id: "b1", name: "Domestic Lager 6-Pack", barcode: "012345678905" }),
    item({ id: "b2", name: "IPA 6-Pack", barcode: "A1b2" }),
    item({ id: "b3", name: "House Red Wine", barcode: "5901234123457" }),
    item({ id: "b4", name: "Loose Candy" }), // no barcode
  ];
  const index = buildBarcodeIndex(CODED);

  it("resolves an exact hit to the current item", () => {
    const hit = resolveBarcodeActivation({ menuItems: CODED, index, value: "012345678905" });
    expect(hit?.id).toBe("b1");
  });

  it("preserves leading zeros — the zero-stripped value is a different code", () => {
    expect(
      resolveBarcodeActivation({ menuItems: CODED, index, value: "12345678905" })
    ).toBeNull();
  });

  it("is case-sensitive, because Code 39/128 alphabets are", () => {
    expect(resolveBarcodeActivation({ menuItems: CODED, index, value: "A1b2" })?.id).toBe("b2");
    expect(resolveBarcodeActivation({ menuItems: CODED, index, value: "a1B2" })).toBeNull();
    expect(resolveBarcodeActivation({ menuItems: CODED, index, value: "a1b2" })).toBeNull();
  });

  it("does not activate on a prefix", () => {
    expect(
      resolveBarcodeActivation({ menuItems: CODED, index, value: "01234567890" })
    ).toBeNull();
  });

  it("does not activate on a partial or extended value", () => {
    for (const value of ["2345678905", "0123456789051", "0123 45678905"]) {
      expect(resolveBarcodeActivation({ menuItems: CODED, index, value })).toBeNull();
    }
  });

  it("does not activate on a manual-search match", () => {
    // "IPA" finds a product in the search box; it is not that product's code.
    expect(resolveBarcodeActivation({ menuItems: CODED, index, value: "IPA" })).toBeNull();
    expect(resolveBarcodeActivation({ menuItems: CODED, index, value: "lager" })).toBeNull();
  });

  it("returns null for an empty or whitespace value", () => {
    for (const value of ["", "   "]) {
      expect(resolveBarcodeActivation({ menuItems: CODED, index, value })).toBeNull();
    }
  });

  it("resolves the DURABLE id against the CURRENT catalogue, not the indexed one", () => {
    // Index built from the old catalogue; the item is then re-priced. The
    // object returned must be the current one.
    const repriced = CODED.map((i) =>
      i.id === "b1" ? { ...i, price: 99.99, name: "Domestic Lager 6-Pack (new)" } : i
    );
    const hit = resolveBarcodeActivation({
      menuItems: repriced,
      index,
      value: "012345678905",
    });
    expect(hit?.price).toBe(99.99);
    expect(hit).toBe(repriced[0]); // the current object, not the indexed one
  });

  it("activates nothing when the id no longer exists in the catalogue", () => {
    const without = CODED.filter((i) => i.id !== "b1");
    expect(
      resolveBarcodeActivation({ menuItems: without, index, value: "012345678905" })
    ).toBeNull();
  });

  it("FAILS SAFE on a duplicated catalogue rather than picking a winner", () => {
    const dupes: MenuItem[] = [
      item({ id: "d1", name: "Cheap", price: 1, barcode: "999" }),
      item({ id: "d2", name: "Expensive", price: 99, barcode: "999" }),
    ];
    const refused = buildBarcodeIndex(dupes);
    expect(refused.ok).toBe(false);
    expect(
      resolveBarcodeActivation({ menuItems: dupes, index: refused, value: "999" })
    ).toBeNull();
  });

  it("resolves nothing at all when the capability is disabled", () => {
    const off = buildBarcodeIndex(CODED, { enabled: false });
    expect(
      resolveBarcodeActivation({ menuItems: CODED, index: off, value: "012345678905" })
    ).toBeNull();
  });

  it("ignores an item with no barcode", () => {
    expect(resolveBarcodeActivation({ menuItems: CODED, index, value: "b4" })).toBeNull();
  });

  it("never mutates its inputs", () => {
    const snapshot = JSON.parse(JSON.stringify(CODED));
    resolveBarcodeActivation({ menuItems: CODED, index, value: "012345678905" });
    expect(CODED).toEqual(snapshot);
  });
});

describe("a miss is indistinguishable from ordinary search", () => {
  const raw = read(BROWSER);
  const browser = code(raw);

  it("shows no barcode error wording anywhere", () => {
    for (const banned of [
      "Barcode not found",
      "barcode not found",
      "Unknown barcode",
      "No barcode",
      "Scan failed",
      "Not recognized",
      "Ready to scan",
      "Scanner connected",
      "Scan successful",
      "Barcode recognized",
      "Scanner unavailable",
    ]) {
      expect(raw).not.toContain(banned);
    }
  });

  it("keeps searchTerm and the filtered results on a miss", () => {
    const handler = browser.slice(
      browser.indexOf("function handleSearchKeyDown"),
      browser.indexOf("if (categories.length === 0)")
    );
    // The miss branch is a bare return: it clears nothing and sets nothing.
    const missBranch = handler.slice(
      handler.indexOf("if (currentItem === null)"),
      handler.indexOf("setSearchTerm(\"\");")
    );
    expect(missBranch).toContain("return;");
    expect(missBranch).not.toContain("setSearchTerm");
    expect(missBranch).not.toContain("setActiveCategory");
    expect(missBranch).not.toContain("onAddToCart");
  });

  it("leaves the accepted manual-search behavior untouched", () => {
    // Barcode normalization is separate from search normalization.
    const sharedSrc = code(read("components/editor/pos-layouts/shared.ts"));
    expect(sharedSrc).toContain("return term.trim().toLowerCase();");
    expect(sharedSrc).toContain("input.menuItems.filter((item) => matchesProductSearch");
  });
});

describe("no focus stealing and no global scanner architecture", () => {
  const browser = code(read(BROWSER));

  it("never focuses itself", () => {
    for (const banned of ["autoFocus", ".focus()", "useRef", "createRef", "tabIndex={-1}"]) {
      expect(browser).not.toContain(banned);
    }
  });

  it("installs no global listener and no scanner engine", () => {
    for (const banned of [
      "window.addEventListener",
      "document.addEventListener",
      "addEventListener",
      "IndexedDB",
      "indexedDB",
      "getUserMedia",
      "BarcodeDetector",
      "fetch(",
    ]) {
      expect(browser).not.toContain(banned);
    }
  });
});

describe("the SHARED model supports barcode — that is Lane 1's, and is not denied here", () => {
  it("MenuItem carries the optional barcode field 1E-A added", () => {
    const config = code(read("lib/projectConfig.ts"));
    const type = config.slice(
      config.indexOf("export type MenuItem"),
      config.indexOf("export type Currency")
    );
    expect(type).toContain("barcode?: string");
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

// v1.3 Lane 2 Retail Store — this block used to call ProductGridBrowser
// "generic Retail" and bind it to a variable named `retail`. Both assertions
// still pass, because the generic grid genuinely still has those properties —
// but "retail" no longer RENDERS this browser, so the block was documenting a
// falsehood while staying green. The binding and the wording are corrected;
// every existing assertion is kept, and a Retail-vs-Liquor block is added
// below, which is a property nothing guarded before.
describe("the Liquor Store catalog is visibly distinct from the generic product grid", () => {
  const liquor = code(read(BROWSER));
  const generic = code(read("components/editor/pos-layouts/ProductGridBrowser.tsx"));

  it("uses a container-driven grid instead of the generic fixed three columns", () => {
    expect(generic).toContain("grid-cols-3");
    expect(liquor).not.toContain("grid-cols-3");
    expect(liquor).toContain("grid-cols-[repeat(auto-fill,minmax(148px,1fr))]");
  });

  it("sets product names substantially larger than the generic 11px", () => {
    expect(generic).toContain("text-[11px]");
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

// ---------------------------------------------------------------------------
// Retail and Liquor are two presentations, not one
// ---------------------------------------------------------------------------

describe("the two dedicated presentations are distinct implementations", () => {
  const liquor = code(read(BROWSER));
  const retail = code(read("components/editor/pos-layouts/RetailStoreBrowser.tsx"));
  const generic = code(read("components/editor/pos-layouts/ProductGridBrowser.tsx"));

  it("only Retail moves its category rail beside the catalog at md", () => {
    expect(retail).toContain("md:flex-col");
    expect(liquor).not.toContain("md:flex-col");
  });

  it("both rails still scroll horizontally when stacked", () => {
    expect(retail).toContain("overflow-x-auto");
    expect(liquor).toContain("overflow-x-auto");
  });

  it("they use different adaptive grid minimums", () => {
    expect(liquor).toContain("minmax(148px,1fr)");
    expect(retail).toContain("minmax(140px,1fr)");
  });

  it("neither dedicated presentation falls back to the generic fixed columns", () => {
    expect(generic).toContain("grid-cols-3");
    expect(liquor).not.toContain("grid-cols-3");
    expect(retail).not.toContain("grid-cols-3");
  });
});
