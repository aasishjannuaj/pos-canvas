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
import { shouldWarnNoMatch as liquorShouldWarnNoMatch } from "./LiquorStoreBrowser";

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

    // RC-polish Lane 2B — onChange also retires the no-match warning, and
    // does nothing else.
    const onChange = browser.slice(browser.indexOf("onChange={"), browser.indexOf("onKeyDown={"));
    expect(onChange).toContain("setSearchTerm(event.target.value);");
    expect(onChange).toContain("setNoMatchWarning(false);");
    expect([...onChange.matchAll(/set\w+\(/g)].map((m) => m[0]).sort()).toEqual([
      "setNoMatchWarning(",
      "setSearchTerm(",
    ]);
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
    ]) {
      expect(`${banned} is absent`).toBe(`${banned} is absent`);
      expect(browser).not.toContain(banned);
    }
  });

  it("RC-polish: the one effect in this file installs nothing and only focuses", () => {
    // NARROWED, NOT DROPPED. `useEffect` used to be banned outright, as a
    // proxy for "no global listener is ever installed". The listener bans
    // above are the actual protection and they stay; what is permitted now is
    // exactly one effect whose entire body focuses the field.
    expect([...browser.matchAll(/useEffect\(/g)]).toHaveLength(1);

    const effect = browser.slice(browser.indexOf("useEffect("));
    const body = effect.slice(0, effect.indexOf("}, ["));

    expect(body).toContain("searchInputRef.current?.focus()");
    for (const banned of ["addEventListener", "setInterval", "setTimeout", "requestAnimationFrame"]) {
      expect(`effect: ${banned}`).toBe(`effect: ${banned}`);
      expect(body).not.toContain(banned);
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
    expect(handler).toContain("onAddToCart(activation.item);");
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

  /**
   * The three outcomes, asserted as outcomes.
   *
   * WHY NOT `toBeNull()` ANY MORE. The RC-polish contract replaced one `null`
   * that meant three different things with a named union, and the whole point
   * is that `not_found` ("this value is not in the catalogue") and
   * `unavailable` ("the catalogue could not be asked safely") are no longer
   * interchangeable. Asserting only "nothing activated" would pass for either
   * and would not notice them swapping, which is exactly the regression the
   * split exists to prevent.
   */
  const activated = (value: string, menuItems: MenuItem[] = CODED, idx = index) => {
    const result = resolveBarcodeActivation({ menuItems, index: idx, value });

    expect(result.status).toBe("activated");

    // Narrowing for the caller; the assertion above is what actually fails.
    if (result.status !== "activated") throw new Error("unreachable");

    return result.item;
  };

  const statusOf = (value: string, menuItems: MenuItem[] = CODED, idx = index) =>
    resolveBarcodeActivation({ menuItems, index: idx, value }).status;

  it("resolves an exact hit to the current item", () => {
    expect(activated("012345678905").id).toBe("b1");
  });

  it("preserves leading zeros — the zero-stripped value is a different code", () => {
    // NOT_FOUND, specifically: the index was perfectly usable and this is
    // simply a different code. Reporting it as `unavailable` would hide a
    // genuine "no such product".
    expect(statusOf("12345678905")).toBe("not_found");
  });

  it("is case-sensitive, because Code 39/128 alphabets are", () => {
    expect(activated("A1b2").id).toBe("b2");
    expect(statusOf("a1B2")).toBe("not_found");
    expect(statusOf("a1b2")).toBe("not_found");
  });

  it("does not activate on a prefix", () => {
    expect(statusOf("01234567890")).toBe("not_found");
  });

  it("does not activate on a partial or extended value", () => {
    for (const value of ["2345678905", "0123456789051", "0123 45678905"]) {
      expect(`${value} is not found`).toBe(`${value} is not found`);
      expect(statusOf(value)).toBe("not_found");
    }
  });

  it("does not activate on a manual-search match", () => {
    // "IPA" finds a product in the search box; it is not that product's code.
    // This is THE case that must stay silent in presentation, and it is
    // `not_found` — which is why `not_found` alone may never drive a warning.
    expect(statusOf("IPA")).toBe("not_found");
    expect(statusOf("lager")).toBe("not_found");
  });

  it("reports not_found for an empty or whitespace value", () => {
    for (const value of ["", "   "]) {
      expect(`${JSON.stringify(value)} is not found`).toBe(`${JSON.stringify(value)} is not found`);
      expect(statusOf(value)).toBe("not_found");
    }
  });

  it("resolves the DURABLE id against the CURRENT catalogue, not the indexed one", () => {
    // Index built from the old catalogue; the item is then re-priced. The
    // object returned must be the current one.
    const repriced = CODED.map((i) =>
      i.id === "b1" ? { ...i, price: 99.99, name: "Domestic Lager 6-Pack (new)" } : i
    );
    const hit = activated("012345678905", repriced);

    expect(hit.price).toBe(99.99);
    expect(hit).toBe(repriced[0]); // the current object, not the indexed one
  });

  it("is UNAVAILABLE, not not_found, when the id no longer exists", () => {
    // THE DISTINCTION THAT MATTERS. The value DID match a barcode; the product
    // behind it has gone. Calling that "no matching product" would send a
    // cashier hunting for a typo that is not there.
    const without = CODED.filter((i) => i.id !== "b1");

    expect(statusOf("012345678905", without)).toBe("unavailable");
  });

  it("FAILS SAFE as UNAVAILABLE on a duplicated catalogue rather than picking a winner", () => {
    const dupes: MenuItem[] = [
      item({ id: "d1", name: "Cheap", price: 1, barcode: "999" }),
      item({ id: "d2", name: "Expensive", price: 99, barcode: "999" }),
    ];
    const refused = buildBarcodeIndex(dupes);

    expect(refused.ok).toBe(false);
    // A configuration fault, never reported to the cashier as a missing
    // product: one of these would sell at the other's price.
    expect(statusOf("999", dupes, refused)).toBe("unavailable");
  });

  it("activates nothing when the capability is disabled", () => {
    // The builder yields an EMPTY BUT USABLE index when disabled, so the
    // honest answer here is not_found: this function cannot tell "switched
    // off" from "no product has a barcode", and lib/barcode.ts is unchanged.
    // Nothing activates either way, and the component's own
    // `barcodeScanningEnabled` reject (asserted separately) is what actually
    // enforces the capability — this is defence in depth behind it.
    const off = buildBarcodeIndex(CODED, { enabled: false });

    expect(statusOf("012345678905", CODED, off)).not.toBe("activated");
    expect(statusOf("012345678905", CODED, off)).toBe("not_found");
  });

  it("ignores an item with no barcode", () => {
    expect(statusOf("b4")).toBe("not_found");
  });

  it("returns one of exactly three statuses, and nothing else", () => {
    const seen = new Set<string>();

    for (const value of ["012345678905", "A1b2", "nope", "", "IPA"]) {
      seen.add(statusOf(value));
    }
    seen.add(statusOf("012345678905", CODED.filter((i) => i.id !== "b1")));

    for (const status of seen) {
      expect(["activated", "not_found", "unavailable"]).toContain(status);
    }
    // All three are actually reachable from this catalogue.
    expect(seen).toEqual(new Set(["activated", "not_found", "unavailable"]));
  });

  it("never mutates its inputs", () => {
    const snapshot = JSON.parse(JSON.stringify(CODED));
    resolveBarcodeActivation({ menuItems: CODED, index, value: "012345678905" });
    expect(CODED).toEqual(snapshot);
  });
});

describe("a miss is named in logic, and only the approved warning is shown", () => {
  const raw = read(BROWSER);
  const browser = code(raw);

  it("shows no barcode error wording anywhere", () => {
    // RC-polish Lane 2B — "Ready to scan" left this list: it is now the
    // approved readiness copy, shown only while the field has focus (asserted
    // in the Lane 2B block below). Every barcode- or device-claiming phrase
    // stays banned, including "Barcode not found".
    for (const banned of [
      "Barcode not found",
      "barcode not found",
      "Unknown barcode",
      "No barcode",
      "Scan failed",
      "Not recognized",
      "Scanner connected",
      "Scanner ready",
      "Scanner detected",
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
      handler.indexOf('if (activation.status !== "activated")'),
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

  /**
   * RC-polish narrowed this rule from "never focuses itself" to "never steals
   * focus", which is what it always meant.
   *
   * The field may be focused when the HOST asks — on activation, and once after
   * a completed sale. What stays forbidden is every mechanism that could take
   * focus at a moment the cashier did not choose: autoFocus (fires on any
   * mount, including the Builder's), polling, a timer, a listener, reading
   * document.activeElement, or re-asserting focus from onFocus/onBlur.
   */
  it("never steals focus", () => {
    for (const banned of [
      "autoFocus",
      "createRef",
      "tabIndex={-1}",
      "document.activeElement",
      "setInterval",
      "setTimeout",
      "requestAnimationFrame",
      "blur()",
    ]) {
      expect(`${banned} is absent`).toBe(`${banned} is absent`);
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

  it("holds exactly one ref, for the Search / Scan input, and never shares it", () => {
    expect([...browser.matchAll(/useRef[(<]/g)]).toHaveLength(1);
    expect(browser).toContain("const searchInputRef = useRef<HTMLInputElement>(null)");
    expect(browser).toContain("ref={searchInputRef}");

    // The ref must not escape: no forwarding, no imperative handle, no
    // callback that hands the element or a focus function to a parent.
    for (const banned of [
      "forwardRef",
      "useImperativeHandle",
      "onFocusRequest",
      "onSearchRef",
      "inputRef={",
    ]) {
      expect(`${banned} is absent`).toBe(`${banned} is absent`);
      expect(browser).not.toContain(banned);
    }
  });

  it("focuses exactly once, from the nonce effect only", () => {
    expect([...browser.matchAll(/\.focus\(\)/g)]).toHaveLength(1);
    // The dependency is the nonce — not [] (which could never fire again) and
    // not a value that changes on ordinary renders.
    expect(browser).toContain("}, [scanFocusRequest]);");
  });

  it("does nothing when the host does not ask — this is what keeps the Builder still", () => {
    // An ABSENT prop, not a device or environment check. EditorPreview simply
    // omits it, so the effect returns before touching focus.
    expect(browser).toContain("if (scanFocusRequest === undefined) {");

    const effect = browser.slice(browser.indexOf("useEffect("));
    const body = effect.slice(0, effect.indexOf("}, ["));

    expect(body.indexOf("scanFocusRequest === undefined")).toBeLessThan(
      body.indexOf("searchInputRef.current?.focus()")
    );

    for (const banned of ["isCapacitor", "navigator.", "ontouchstart", "matchMedia", "userAgent"]) {
      expect(`${banned} is absent`).toBe(`${banned} is absent`);
      expect(browser).not.toContain(banned);
    }
  });

  it("the focus request is an inbound number and nothing else", () => {
    expect(browser).toContain("scanFocusRequest?: number;");
    // No local state drives focus: the browser cannot ask for it itself.
    expect(browser).not.toContain("setScanFocusRequest");
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
    expect(retail).toContain("@xl:flex-col");
    expect(liquor).not.toContain("@xl:flex-col");
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
      warn: liquorShouldWarnNoMatch({ activation: activation.status, searching, resultCount: items.length }),
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
          expect(liquorShouldWarnNoMatch({ activation, searching, resultCount })).toBe(expected);
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
