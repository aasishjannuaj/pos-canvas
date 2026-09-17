// Lane 3 Task 1 — the website design system, and the three things about it
// that would silently rot.
//
// WHAT THESE GUARD, AND WHY EACH ONE EXISTS:
//
// 1. THE FONT. app/layout.tsx has loaded Geist since Feature 24.1, and
//    app/globals.css then overrode the whole document with Arial — so for
//    months the font the site DECLARED was not the font the site RENDERED, and
//    nothing failed. A rule with no test is exactly how that happened twice.
//
// 2. THE PALETTE HAS ONE HOME. Before this task, Navbar and Hero each carried
//    their own `bg-blue-600` / `text-neutral-600` / focus-ring string. That is
//    not a palette, it is repeated opinions, and it is why the site looked
//    like default Tailwind rather than like Concept D. These assert the
//    approved swatches are declared once, in the design system, and that the
//    two proof surfaces reach for tokens rather than typing colours.
//
// 3. PLATFORM BRANDING IS NOT CUSTOMER BRANDING. The new lockup renders the
//    POS Canvas mark. A merchant's own logo lives in ProjectConfig.branding
//    and belongs in their till, never in the website's header.
//    lib/brand.guards.test.ts states the boundary for the identity module;
//    this states it for the new presentation layer.
//
// Source-level, like every other guard here: this repository has no React
// Testing Library (verified — no testing-library dependency in package.json),
// so components are read, not rendered.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf-8");
}

/** Strips comments from TSX so explanatory prose never trips a guard. */
function code(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/**
 * The same, for CSS — and deliberately NOT the function above.
 *
 * That one opens with a JSX-specific rule that deletes `{ ... }` when the
 * braces wrap nothing but a comment. CSS is full of `{ ... }`, and the rule is
 * lazy: pointed at app/design-system.css it matched from the first comment
 * inside `@theme {` all the way to the last comment before that block's closing
 * brace, and silently deleted the entire palette it was supposed to be reading.
 * A guard that deletes its own subject passes for the wrong reason, so CSS gets
 * a stripper that only removes comments.
 */
function cssCode(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

const SYSTEM = "app/design-system.css";
const GLOBALS = "app/globals.css";
const LOCKUP = "components/brand/PosCanvasLockup.tsx";
const NAVBAR = "components/landing/Navbar.tsx";
const HERO = "components/landing/Hero.tsx";

/** The block of app/globals.css that styles <body>, comments removed. */
function bodyRule(): string {
  const css = cssCode(read(GLOBALS));
  const start = css.indexOf("body {");

  expect(start, "the body rule moved or was renamed").toBeGreaterThan(-1);

  return css.slice(start, css.indexOf("}", start) + 1);
}

// ---------------------------------------------------------------------------
// The font the site declares is the font the site uses
// ---------------------------------------------------------------------------

describe("Geist actually governs the site", () => {
  it("the root layout still loads Geist and exposes it as a variable", () => {
    const layout = code(read("app/layout.tsx"));

    expect(layout).toContain('from "next/font/google"');
    expect(layout).toContain('variable: "--font-geist-sans"');
    expect(layout).toContain("geistSans.variable");
  });

  it("--font-sans still resolves to the loaded face", () => {
    // This is the link Tailwind's preflight follows to set the document font:
    // html { font-family: --theme(--default-font-family) }, and
    // --default-font-family resolves through --font-sans.
    expect(cssCode(read(GLOBALS))).toContain("--font-sans: var(--font-geist-sans)");
  });

  it("body declares no font-family of its own", () => {
    // THE NEGATIVE CONTROL, and the whole point of this block. Putting any
    // font-family back on body — Arial or otherwise — silently overrides the
    // face the layout loads, which is the defect this task fixed.
    expect(bodyRule()).not.toContain("font-family");
  });

  it("no sans-serif stack is reintroduced outside the print rules", () => {
    const css = cssCode(read(GLOBALS));
    const screenCss = css.slice(0, css.indexOf("@media print"));

    expect(screenCss).not.toContain("Arial");
    expect(screenCss).not.toContain("Helvetica");
  });
});

// ---------------------------------------------------------------------------
// Printed receipts did not change because the website's font did
// ---------------------------------------------------------------------------

describe("fixing the website font left printed receipts alone", () => {
  it("the print area pins the stack the document used before", () => {
    // components/editor/Receipt.tsx sets no family and inherited Arial from
    // body. Without this pin it would have started printing in Geist, moving
    // the wrap points on an 80mm roll — a change to the slip a customer is
    // handed, made as a side effect of a website change.
    const css = cssCode(read(GLOBALS));
    const print = css.slice(css.indexOf("@media print"));

    expect(print).toContain("font-family: Arial, Helvetica, sans-serif;");
  });

  it("the live checkout receipts still set their own monospace", () => {
    for (const receipt of [
      "components/runtime/AuthoritativeReceipt.tsx",
      "components/runtime/OfflineReceipt.tsx",
    ]) {
      expect(`${receipt}`).toBe(receipt);
      expect(code(read(receipt))).toContain("font-mono");
    }
  });
});

// ---------------------------------------------------------------------------
// Concept D, declared once
// ---------------------------------------------------------------------------

describe("the approved palette has exactly one home", () => {
  // Transcribed from assets/brand/README.md, which records what the owner
  // approved. Concept D is TEMPORARY branding: when it is replaced, this list
  // and the design system change together, and nothing else has to.
  const CONCEPT_D = [
    "#0fa7a6",
    "#2bcbc4",
    "#7fe6db",
    "#ffc7a3",
    "#ff7f68",
    "#ffe9de",
    "#fbf8f3",
    "#000119",
  ];

  it("the design system declares every approved swatch", () => {
    const css = cssCode(read(SYSTEM)).toLowerCase();

    for (const hex of CONCEPT_D) {
      expect(`${SYSTEM} declares ${hex}`).toBe(`${SYSTEM} declares ${hex}`);
      expect(css).toContain(hex);
    }
  });

  it("the approved swatches still match the brand contract", () => {
    // The README is the record of what was approved. If the two ever disagree,
    // one of them is wrong and this says so before a release does.
    const contract = read("assets/brand/README.md").toLowerCase();

    for (const hex of CONCEPT_D) {
      expect(`README declares ${hex}`).toBe(`README declares ${hex}`);
      expect(contract).toContain(hex);
    }
  });

  it("the proof surfaces type no colour of their own", () => {
    // Not a colour snapshot — a rule. A hex or a stock Tailwind palette class
    // in a component is a value that lives outside the system, which is how
    // the site ended up with a blue it never chose.
    for (const surface of [NAVBAR, HERO]) {
      const source = code(read(surface));

      expect(`${surface}`).toBe(surface);
      expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);

      for (const stock of ["blue-", "neutral-", "gray-", "slate-", "zinc-"]) {
        expect(`${surface}: ${stock}`).toBe(`${surface}: ${stock}`);
        expect(source).not.toContain(stock);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Focus is replaced, never removed
// ---------------------------------------------------------------------------

describe("keyboard focus stays visible", () => {
  const css = cssCode(read(SYSTEM));

  it("the system defines one focus treatment", () => {
    expect(css).toContain(":focus-visible");
    expect(css).toContain("outline: var(--pc-focus-width)");
    expect(css).toContain("outline-offset: var(--pc-focus-offset)");
  });

  it("nothing suppresses the browser's own outline", () => {
    expect(css).not.toContain("outline: none");
    expect(css).not.toContain("outline: 0");
  });

  it("both proof surfaces route their interactive elements through it", () => {
    // Every focusable thing in the header and hero carries a class the focus
    // rule selects: pc-button, pc-navlink, pc-textlink or pc-focusable.
    for (const surface of [NAVBAR, HERO]) {
      const source = code(read(surface));

      expect(`${surface}`).toBe(surface);
      expect(source).toMatch(/pc-(button|navlink|textlink|focusable)/);
    }
  });
});

// ---------------------------------------------------------------------------
// Navbar — presentation changed, session handling did not
// ---------------------------------------------------------------------------

describe("the header still decides what to show the way it did", () => {
  const navbar = code(read(NAVBAR));

  it("reads the session with the same client and call", () => {
    expect(navbar).toContain('from "@/lib/supabase/server"');
    expect(navbar).toContain("await supabase.auth.getClaims()");
    expect(navbar).toContain("isAuthenticated = !error && Boolean(data?.claims)");
  });

  it("a failed session lookup still falls back to the signed-out header", () => {
    // The safe default: offer sign-in rather than assume access. A public
    // landing page must not break because an auth call did.
    const fallback = navbar.slice(navbar.indexOf("} catch {"));

    expect(navbar).toContain("} catch {");
    expect(fallback).toContain("isAuthenticated = false;");
  });

  it("both actions still come from the shared helpers", () => {
    expect(navbar).toContain("getLandingPrimaryAction(isAuthenticated)");
    expect(navbar).toContain("getLandingSignInAction()");
    expect(navbar).toContain("primaryAction.href");
    expect(navbar).toContain("signInAction.href");
  });

  it("Sign In is still shown only to a signed-out visitor", () => {
    expect(navbar).toContain("{!isAuthenticated && (");
  });

  it("every section anchor still comes from the shared constants", () => {
    // Lane 3 Task 4 — the root-qualified form ("/#features"), because the
    // header also renders on routes that have no such section. Still the
    // shared constants, never literals; lib/landingNav.test.ts checks that
    // each one lands on a section the homepage renders.
    for (const anchor of [
      "LANDING_HOME_SECTION_LINKS.templates",
      "LANDING_HOME_SECTION_LINKS.features",
      "LANDING_HOME_SECTION_LINKS.howItWorks",
    ]) {
      expect(`${NAVBAR}: ${anchor}`).toBe(`${NAVBAR}: ${anchor}`);
      expect(navbar).toContain(anchor);
    }
    expect(navbar).not.toContain("LANDING_SECTION_ANCHORS");
  });

  it("the released responsive behaviour is preserved, not redesigned", () => {
    // 1.2.0 showed the section nav from md up and hid it below, and a
    // design-system pass is not where that decision changes. An earlier draft
    // of this task added a second row exposing those three destinations on
    // phones; it was withdrawn as an unapproved navigation UX change. These
    // assert exactly one section nav, gated at the released breakpoint, with
    // no second one hiding above it.
    expect((navbar.match(/<nav/g) ?? []).length).toBe(1);
    expect(navbar).toContain('className="hidden items-center gap-8 md:flex"');
    expect(navbar).not.toContain("md:hidden");
  });
});

// ---------------------------------------------------------------------------
// Hero — destinations and claims
// ---------------------------------------------------------------------------

describe("the hero points where it always pointed", () => {
  const hero = code(read(HERO));

  it("Start Building still routes through the templates route", () => {
    expect(hero).toContain("LANDING_ROUTES.templates");
    expect(hero).toContain("<Link");
  });

  it("See Templates is still the in-page section anchor", () => {
    expect(hero).toContain("LANDING_SECTION_ANCHORS.templates");
  });

  it("advertises nothing that has not shipped", () => {
    // v1.3 workforce, liquor and catalog work is not released. A hero is
    // exactly where a not-yet-built capability gets promised by accident.
    for (const unreleased of [
      "employee",
      "Employee",
      "workforce",
      "Workforce",
      "time clock",
      "Time Clock",
      "payroll",
      "Payroll",
      "barcode",
      "Barcode",
      "scanner",
      "Scanner",
      "cash drawer",
    ]) {
      expect(`${HERO}: ${unreleased}`).toBe(`${HERO}: ${unreleased}`);
      expect(hero).not.toContain(unreleased);
    }
  });
});

// ---------------------------------------------------------------------------
// The lockup is platform branding, from the approved masters
// ---------------------------------------------------------------------------

describe("the website identity is the approved artwork, and only that", () => {
  const lockup = code(read(LOCKUP));

  it("renders the committed masters rather than a redrawn mark", () => {
    expect(lockup).toContain("assets/brand/icon-mark-master.png");
    expect(lockup).toContain("assets/brand/wordmark-master.png");
  });

  it("takes its accessible name from the shared brand module", () => {
    expect(lockup).toContain('from "@/lib/brand"');
    expect(lockup).toContain("BRAND.productName");
  });

  it("knows nothing about a customer's branding", () => {
    // The other direction of the boundary lib/brand.guards.test.ts holds: a
    // merchant's logo, accent colour and business name must never reach the
    // POS Canvas website's own identity.
    for (const banned of [
      "ProjectConfig",
      "BrandingSettings",
      "GeneratedPosConfig",
      "project-logos",
      "businessName",
      "accentColor",
      "supabase",
    ]) {
      expect(`${LOCKUP}: ${banned}`).toBe(`${LOCKUP}: ${banned}`);
      expect(lockup).not.toContain(banned);
    }
  });

  it("the design system is not driven by project configuration either", () => {
    const css = cssCode(read(SYSTEM));

    for (const banned of ["ProjectConfig", "branding", "project-logos", "accent"]) {
      expect(`${SYSTEM}: ${banned}`).toBe(`${SYSTEM}: ${banned}`);
      expect(css).not.toContain(banned);
    }
  });

  it("the customer logo pipeline still knows nothing about the lockup", () => {
    for (const file of [
      "lib/logoUpload.ts",
      "components/editor/BrandingLogoField.tsx",
    ]) {
      const source = code(read(file));

      expect(`${file}`).toBe(file);
      expect(source).not.toContain("PosCanvasLockup");
      expect(source).not.toContain("assets/brand");
    }
  });
});
