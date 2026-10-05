// Feature 16.2 — regression guard for the Android layout fix.
//
// The runtime's product/cart split was desktop-only: an unconditional
// flex-row with a fixed 24rem (w-96) `flex-none` cart. Measured at the
// Android emulator's viewport (411 x 866 CSS px) that left the product panel
// 27px wide, which is what made it read as "the left section does not
// scroll".
//
// This repository has no React Testing Library (verified: no
// testing-library dependency in package.json), so the layout is asserted at
// the source level — enough to catch the specific regression of the
// responsive breakpoint being dropped or the fixed width becoming
// unconditional again.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "PosRuntime.tsx"),
  "utf-8"
);

// Strip comments so the explanatory notes (which quote the old classes) are
// not mistaken for live markup.
const markup = source
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("PosRuntime panel layout is responsive", () => {
  it("stacks the panels by default and only becomes a row at md and above", () => {
    expect(markup).toContain("flex flex-1 flex-col overflow-hidden md:flex-row");
  });

  it("never applies the fixed cart width unconditionally", () => {
    // w-96 must always be breakpoint-scoped (md:w-96); a bare `w-96` on the
    // aside is the exact regression that collapsed the product panel.
    expect(markup).toContain("md:w-96");
    expect(markup).toMatch(/w-full[^"]*md:w-96|md:w-96[^"]*w-full/);
    expect(markup).not.toMatch(/className="[^"]*\bflex w-96\b/);
  });

  it("gives the cart a bounded share of the height on narrow screens only", () => {
    expect(markup).toContain("h-[45%]");
    expect(markup).toContain("md:h-auto");
  });

  it("moves the divider border to the top when stacked", () => {
    expect(markup).toContain("border-t");
    expect(markup).toContain("md:border-l");
    expect(markup).toContain("md:border-t-0");
  });

  it("keeps the product panel a bounded flex column that can host a scroller", () => {
    expect(markup).toContain("flex min-h-0 flex-1 flex-col overflow-hidden");
  });

  it("keeps the cart panel overflow-hidden at every width, since its overlays are absolute inset-0", () => {
    // The checkout and receipt overlays depend on this element remaining
    // their positioning context; switching it to a scroll container would
    // let them scroll away.
    expect(markup).toMatch(/aside[\s\S]*?overflow-hidden/);
    expect(markup).not.toMatch(/aside[\s\S]*?md:overflow-visible/);
  });

  it("still bounds the whole runtime to the viewport rather than scrolling the page", () => {
    // 100vh measured exactly equal to window.innerHeight in the Android
    // WebView (866 = 866), so h-screen is correct and deliberately kept.
    expect(markup).toContain("flex h-screen flex-col");
  });
});

describe("the intended scroll container still owns vertical scrolling", () => {
  it("each layout browser keeps flex-1 overflow-y-auto on its content region", () => {
    const layoutsDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "editor",
      "pos-layouts"
    );

    for (const file of [
      "MenuGridBrowser.tsx",
      "ProductGridBrowser.tsx",
      "ServiceGridBrowser.tsx",
      // v1.3 Lane 2 Task 2 — the Liquor Store variant has a search row and a
      // category rail above its catalog, so it is MORE important, not less,
      // that the catalog is the element that scrolls.
      "LiquorStoreBrowser.tsx",
      // v1.3 Lane 2 Retail Store — the same, and more so: Retail also puts the
      // rail BESIDE the catalog at md, so the catalog must still be the
      // scroller rather than the row that contains it.
      "RetailStoreBrowser.tsx",
    ]) {
      const layoutSource = readFileSync(join(layoutsDir, file), "utf-8");

      expect(layoutSource).toContain("flex-1 overflow-y-auto");
    }
  });
});

// ---------------------------------------------------------------------------
// v1.3 RC-polish — the Search / Scan focus request
//
// SOURCE-LEVEL, AND THAT IS A REAL LIMIT. This repository has no DOM test
// environment, so none of these prove that a caret moved. What they prove is
// the thing that was actually at risk: that focus is requested at exactly two
// moments and cannot be requested at any other, which is a property of where
// the increment sits rather than of the browser's behaviour.
// ---------------------------------------------------------------------------

describe("the Search / Scan focus request", () => {
  const closeCheckout = markup.slice(
    markup.indexOf("function closeCheckout()"),
    markup.indexOf("function selectPaymentMethod(")
  );

  it("is a monotonic counter, not a boolean", () => {
    // A flag already `true` would make the second consecutive sale request
    // nothing. The value is meaningless; only the change matters.
    expect(markup).toContain("const [scanFocusRequest, setScanFocusRequest] = useState(0);");
    expect(closeCheckout).toContain("setScanFocusRequest((previous) => previous + 1);");
  });

  it("is requested from exactly one place in the whole runtime", () => {
    expect([...markup.matchAll(/setScanFocusRequest\(/g)]).toHaveLength(1);
    expect(closeCheckout).toContain("setScanFocusRequest(");
  });

  it("is requested only when a COMPLETED sale is dismissed", () => {
    expect(closeCheckout).toContain('if (checkoutStatus === "success") {');

    // The success check comes first, so no other dismissal path can reach it.
    expect(closeCheckout.indexOf('checkoutStatus === "success"')).toBeLessThan(
      closeCheckout.indexOf("setScanFocusRequest(")
    );
  });

  it("cannot be requested by a cancel", () => {
    // closeCheckout IS the cancel path — the same function the Cancel control
    // calls — so the guard above is what separates the two. The reset to
    // "idle" must happen AFTER the guard, or a cancel would read as a success.
    expect(closeCheckout.indexOf('checkoutStatus === "success"')).toBeLessThan(
      closeCheckout.indexOf('setCheckoutStatus("idle")')
    );
  });

  it("cannot be requested by a failed or errored sale", () => {
    // Nothing on a failure path touches it: the only call site is inside the
    // success-guarded branch asserted above.
    for (const failurePath of [
      "setSaleSaveError",
      "onSaleRejected",
      "setCheckoutStatus(\"error\")",
    ]) {
      const at = markup.indexOf(failurePath);

      if (at === -1) continue;

      const window = markup.slice(at, at + 400);

      expect(`${failurePath} does not request focus`).toBe(
        `${failurePath} does not request focus`
      );
      expect(window).not.toContain("setScanFocusRequest");
    }
  });

  it("is handed to the product browser and nowhere else", () => {
    expect(markup).toContain("scanFocusRequest={scanFocusRequest}");
    expect([...markup.matchAll(/scanFocusRequest=\{/g)]).toHaveLength(1);
  });

  it("is the runtime's only focus mechanism", () => {
    // PosRuntime must not reach into the field itself, and must not acquire a
    // second way to move the caret.
    for (const banned of [
      "autoFocus",
      ".focus()",
      "document.activeElement",
      "forwardRef",
      "useImperativeHandle",
    ]) {
      expect(`${banned} is absent from PosRuntime`).toBe(`${banned} is absent from PosRuntime`);
      expect(markup).not.toContain(banned);
    }
  });

  it("is not polled, timed or re-asserted", () => {
    const stateBlock = markup.slice(
      markup.indexOf("const [scanFocusRequest"),
      markup.indexOf("function closeCheckout()")
    );

    for (const banned of ["setInterval", "requestAnimationFrame"]) {
      expect(`${banned} does not drive focus`).toBe(`${banned} does not drive focus`);
      expect(stateBlock).not.toContain(banned);
    }
  });
});

describe("the Builder preview does not request focus", () => {
  const preview = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "editor", "EditorPreview.tsx"),
    "utf-8"
  );

  it("omits scanFocusRequest entirely, so the owner keeps the caret", () => {
    // ABSENCE, not detection. The browsers' effect returns early when the prop
    // is undefined, so the Builder never pulls focus out of a field the owner
    // is typing in — and no device or environment check exists anywhere.
    expect(preview).not.toContain("scanFocusRequest");
  });
});

describe("Liquor and Retail focus identically", () => {
  const layoutsDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "editor",
    "pos-layouts"
  );

  const browsers = ["LiquorStoreBrowser.tsx", "RetailStoreBrowser.tsx"].map((name) => ({
    name,
    src: readFileSync(join(layoutsDir, name), "utf-8"),
  }));

  it("both declare the same optional inbound prop", () => {
    for (const { name, src } of browsers) {
      expect(`${name} declares scanFocusRequest`).toBe(`${name} declares scanFocusRequest`);
      expect(src).toContain("scanFocusRequest?: number;");
    }
  });

  it("both focus the same way, through their own private ref", () => {
    for (const { name, src } of browsers) {
      expect(`${name} focus mechanism`).toBe(`${name} focus mechanism`);
      expect(src).toContain("const searchInputRef = useRef<HTMLInputElement>(null);");
      expect(src).toContain("ref={searchInputRef}");
      expect(src).toContain("searchInputRef.current?.focus();");
      expect(src).toContain("}, [scanFocusRequest, sellingSurfaceInactive]);");
      expect(src).toContain("if (scanFocusRequest === undefined) {");
    }
  });

  it("the switch forwards the request to both, and only to those two", () => {
    const index = readFileSync(join(layoutsDir, "index.tsx"), "utf-8");

    expect([...index.matchAll(/scanFocusRequest=\{scanFocusRequest\}/g)]).toHaveLength(2);
    // The grids have no Search / Scan field and must not receive it.
    for (const grid of ["ProductGridBrowser", "ServiceGridBrowser", "MenuGridBrowser"]) {
      const at = index.indexOf(`<${grid} {...layoutProps}`);

      expect(`${grid} receives no focus request`).toBe(`${grid} receives no focus request`);
      expect(at).toBeGreaterThan(-1);
      expect(index.slice(at, at + 120)).not.toContain("scanFocusRequest");
    }
  });
});
