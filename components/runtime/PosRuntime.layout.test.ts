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
    ]) {
      const layoutSource = readFileSync(join(layoutsDir, file), "utf-8");

      expect(layoutSource).toContain("flex-1 overflow-y-auto");
    }
  });
});
