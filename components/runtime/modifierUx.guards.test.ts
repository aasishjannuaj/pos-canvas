// Feature 18.2 — Phase 2/3 guards.
//
// This repository has no DOM environment or React Testing Library (verified:
// no testing-library dependency), so component behavior is asserted at the
// source level, exactly as components/runtime/PosRuntime.layout.test.ts does
// for the Android layout fix. The pure rules the selector enforces are tested
// directly in lib/modifiers.test.ts; these guards prove the components are
// wired to those rules rather than restating them.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(repoRoot, p), "utf-8");
const code = (src: string) =>
  src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const selector = code(read("components/runtime/ModifierSelector.tsx"));
const browser = code(read("components/editor/pos-layouts/index.tsx"));
const panel = code(read("components/runtime/PosCheckoutPanel.tsx"));
const authReceipt = code(read("components/runtime/AuthoritativeReceipt.tsx"));
const printReceipt = code(read("components/editor/Receipt.tsx"));
const runtime = code(read("components/runtime/PosRuntime.tsx"));

describe("the interception point is shared, not per-layout", () => {
  it("lives in ProductBrowser, which every surface and layout passes through", () => {
    expect(browser).toContain("ModifierSelector");
    expect(browser).toContain("normalizeModifierGroups(menuItem.modifierGroups)");
  });

  it("a product with no modifier groups keeps the original add-to-cart path", () => {
    expect(browser).toContain("if (groups.length === 0)");
    expect(browser).toContain("props.onAddToCart(menuItem);");
  });

  it("no layout carries modifier logic of its own", () => {
    for (const layout of ["MenuGridBrowser", "ProductGridBrowser", "ServiceGridBrowser"]) {
      const source = code(read(`components/editor/pos-layouts/${layout}.tsx`));
      expect(source).not.toContain("modifierGroups");
      expect(source).not.toContain("ModifierSelector");
    }
  });

  it("all three layouts receive the intercepted handler", () => {
    expect([...browser.matchAll(/\{\.\.\.layoutProps\}/g)]).toHaveLength(3);
  });
});

describe("the selector reuses the 18.1 rules rather than restating them", () => {
  it("validates through validateModifierSelections", () => {
    expect(selector).toContain("validateModifierSelections(groups, selections)");
  });

  it("prices through calculateModifiedUnitPrice", () => {
    expect(selector).toContain("calculateModifiedUnitPrice(item.price, groups, selections)");
  });

  it("contains no hand-written rule that could drift from lib/modifiers", () => {
    expect(selector).not.toMatch(/required\s*&&\s*\w+\.length\s*===\s*0/);
    expect(selector).not.toContain("optionIds.length > 1");
  });
});

describe("selector interaction rules", () => {
  it("single choice replaces rather than accumulates, and can be cleared", () => {
    expect(selector).toContain('if (group.selection === "single")');
    expect(selector).toContain("current[0] === optionId ? [] : [optionId]");
  });

  it("multiple choice refuses the tap that would exceed maxSelections", () => {
    expect(selector).toContain("group.maxSelections !== null && current.length >= group.maxSelections");
    expect(selector).toContain("return prev;");
  });

  it("a maxed group still allows deselecting an already-chosen option", () => {
    // Phase 5A widened atMax to atCapacity, which folds in the per-line
    // ceiling. The property is unchanged: only options NOT already chosen are
    // ever disabled, so a cashier can always undo a selection.
    expect(selector).toContain("const disabled = atCapacity && !isChosen;");
  });

  it("refuses the tap that would exceed the per-line option ceiling", () => {
    // The ceiling comes from the shared constant, never a literal 50, and is
    // enforced the same way a group maximum is: refuse the tap, so Add to Cart
    // never goes dead for a reason the cashier cannot see.
    expect(selector).toContain("MAX_SELECTED_OPTIONS_PER_LINE");
    expect(selector).toContain("countSelectedOptions(entries)");
    expect(selector).toContain("if (isAtLineLimit(prev)) {");
    expect(selector).not.toMatch(/[<>]=?\s*50\b/);
  });

  it("the ceiling check reads the updater's own state, not a render closure", () => {
    // setSelected((prev) => ...) must ask `prev`, or a batched pair of toggles
    // could both see a pre-limit count and push the line over.
    const toggleBody = selector.slice(selector.indexOf("function toggle("));
    expect(toggleBody.slice(0, toggleBody.indexOf("function handleConfirm"))).not.toContain(
      "if (atLineLimit)"
    );
  });

  it("a single-choice group stays usable at the ceiling", () => {
    // Tapping a single-choice option REPLACES, so it cannot grow the total and
    // must not be disabled — otherwise a maxed-out line could no longer change
    // its size.
    expect(selector).toContain('group.selection === "multiple" && atLineLimit');
  });

  it("Add to Cart is disabled until the selection validates", () => {
    expect(selector).toContain("disabled={!validation.ok}");
    expect(selector).toContain("if (!validation.ok) {");
  });

  it("Cancel returns nothing to the cart", () => {
    expect(selector).toContain("onCancel");
    expect(selector).not.toMatch(/onCancel=\{\(\) =>[^}]*onAddToCart/);
  });

  it("shows a running item total and hides zero adjustments", () => {
    expect(selector).toContain("unitPrice.toFixed(2)");
    expect(selector).toContain("option.priceAdjustment > 0 &&");
  });

  it("selection state is local and never persisted", () => {
    expect(selector).toContain("useState<Record<string, string[]>>({})");
    expect(selector).not.toContain("localStorage");
    expect(selector).not.toContain("sessionStorage");
  });
});

describe("cart identity and rendering", () => {
  it("every quantity control targets lineKey", () => {
    expect(panel).toContain("onDecreaseQuantity(cartItem.lineKey)");
    expect(panel).toContain("onIncreaseQuantity(cartItem.lineKey)");
    expect(panel).toContain("onRemoveFromCart(cartItem.lineKey)");
    expect(panel).toContain("key={cartItem.lineKey}");
  });

  it("no cart control still keys on itemId", () => {
    expect(panel).not.toContain("onDecreaseQuantity(cartItem.itemId)");
    expect(panel).not.toContain("onIncreaseQuantity(cartItem.itemId)");
    expect(panel).not.toContain("onRemoveFromCart(cartItem.itemId)");
  });

  it("the out-of-stock hint counts the whole product, not one line", () => {
    expect(panel).toContain("getItemQuantityInCart(cart, cartItem.itemId) >= menuItem.stockQuantity");
  });

  it("cart lines render their chosen options", () => {
    expect(panel).toContain("describeCartModifiers(cartItem)");
    expect(panel).toContain("cartItem.modifiers.length > 0 &&");
  });

  it("checkout aggregates stock per product before submitting", () => {
    // Phase 5A moved the pre-submit re-check into lib/saleSubmission.ts so both
    // the runtime and the Builder Preview run it. Per PRODUCT, not per line:
    // two lines of the same item with different modifiers share one pool.
    const submission = code(read("lib/saleSubmission.ts"));
    expect(submission).toContain("getItemQuantityInCart(cart, itemId)");
    expect(submission).toContain("currentQuantity: 0");
    expect(runtime).toContain("getItemQuantityInCart(prev, menuItem.id)");
  });
});

describe("receipts render the authoritative snapshot only", () => {
  it("the authoritative receipt reads modifiers from the server payload", () => {
    expect(authReceipt).toContain("item.modifiers?.map");
    expect(authReceipt).toContain("modifier.optionName");
    expect(authReceipt).toContain("modifier.priceAdjustment");
  });

  it("it never consults the current menu", () => {
    expect(authReceipt).not.toContain("menuItems");
    expect(authReceipt).not.toContain("modifierGroups");
    expect(authReceipt).not.toContain("config");
  });

  it("an older payload with no modifiers key renders nothing extra", () => {
    // Optional chaining is what makes an absent key a no-op rather than a crash.
    expect(authReceipt).toContain("item.modifiers?.");
  });

  it("it does not re-sort what the server returned", () => {
    expect(authReceipt).not.toContain(".sort(");
  });

  it("the print receipt renders modifiers through the shared helper", () => {
    expect(printReceipt).toContain("describeCartModifiers(item)");
    expect(printReceipt).not.toContain("modifierGroups");
  });

  it("neither receipt recomputes a price from a menu lookup", () => {
    for (const source of [authReceipt, printReceipt]) {
      expect(source).not.toContain("calculateModifiedUnitPrice");
      expect(source).not.toContain("normalizeModifierGroups");
    }
  });
});

describe("order history uses the stored snapshot", () => {
  const server = code(read("lib/orders.server.ts"));
  // Phase 5A — the snapshot-to-display-line mapping moved to lib/cart.ts's
  // createHistoricalCartItem, shared with lib/saleSubmission.ts so a reprinted
  // receipt and a just-completed one cannot describe the same sale differently.
  const cart = code(read("lib/cart.ts"));

  it("selects the modifiers column", () => {
    expect(server).toContain("modifiers");
    expect(server).toMatch(/line_total,\s*modifiers/);
  });

  it("builds display data from the snapshot, not the current menu", () => {
    expect(cart).toContain("entry.optionName");
    expect(cart).toContain("entry.priceAdjustment");
    expect(cart).not.toContain("modifierGroups");
    expect(server).not.toContain("modifierGroups");
  });

  it("history and a live receipt share one mapping", () => {
    expect(server).toContain("createHistoricalCartItem(");
    expect(code(read("lib/saleSubmission.ts"))).toContain("createHistoricalCartItem(");
  });

  it("treats a missing or non-array snapshot as no modifiers", () => {
    expect(server).toContain("Array.isArray(orderItem.modifiers) ? orderItem.modifiers : []");
    expect(cart).toContain("Array.isArray(input.snapshot)");
  });
});

describe("checkout still sends identifiers only", () => {
  const submission = code(read("lib/saleSubmission.ts"));

  it("the payload is built from toModifierSelections", () => {
    expect(submission).toContain("toModifierSelections(cartItem.modifiers)");
  });

  it("no display field is placed in the request", () => {
    const payload = submission.slice(submission.indexOf("export function buildSaleRequestItems"));
    const block = payload.slice(0, payload.indexOf("export function hasInsufficientStock"));
    expect(block).not.toContain("groupName");
    expect(block).not.toContain("optionName");
    expect(block).not.toContain("priceAdjustment");
    expect(block).not.toContain("price");
    // lineKey is client-side identity only; complete_sale_v3 recomputes it from
    // the request and would not trust a supplied one.
    expect(block).not.toContain("lineKey");
  });

  it("every host submits the shared payload rather than its own", () => {
    for (const file of [
      "components/runtime/PosRuntime.tsx",
      "components/editor/EditorShell.tsx",
    ]) {
      const host = code(read(file));
      expect(host).toContain("planSaleSubmission({");
      expect(host).toContain("items: plan.items");
    }
  });
});
