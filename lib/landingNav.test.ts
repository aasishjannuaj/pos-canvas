// Navigation regression tests for the landing page.
//
// This repository has no React Testing Library (verified: no
// testing-library dependency in package.json), so components are not
// rendered here. Instead these tests cover the two things that actually
// broke — the destinations themselves, and whether those destinations are
// real routes — plus a source-level assertion that the landing page's
// primary calls to action are genuine links rather than handler-less
// <button> elements, which is exactly the defect that made every one of
// them silently do nothing.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LANDING_ROUTES,
  LANDING_SECTION_ANCHORS,
  LANDING_SECTION_IDS,
  createTemplateEditorHref,
  getLandingPrimaryAction,
  getLandingSignInAction,
} from "@/lib/landingNav";
import { templates } from "@/data/templates";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function appPathExists(...segments: string[]): boolean {
  return existsSync(join(repoRoot, "app", ...segments, "page.tsx"));
}

function readLandingComponent(name: string): string {
  return readFileSync(join(repoRoot, "components", "landing", name), "utf-8");
}

// The "no dead <button>" assertions below must look at rendered markup only.
// These components deliberately carry comments explaining the old
// handler-less <button> defect (quoting both "<button" and the affected
// labels), so matching against the raw file would flag the very
// documentation of the fix. Stripping comments first keeps the assertion
// about the JSX that actually renders.
function readLandingMarkup(name: string): string {
  return readLandingComponent(name)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("LANDING_ROUTES point at routes that actually exist", () => {
  it("maps /templates to app/templates/page.tsx", () => {
    expect(LANDING_ROUTES.templates).toBe("/templates");
    expect(appPathExists("templates")).toBe(true);
  });

  it("maps /login to app/login/page.tsx", () => {
    expect(LANDING_ROUTES.login).toBe("/login");
    expect(appPathExists("login")).toBe(true);
  });

  it("maps /signup to app/signup/page.tsx", () => {
    expect(LANDING_ROUTES.signup).toBe("/signup");
    expect(appPathExists("signup")).toBe(true);
  });

  it("maps /dashboard to app/dashboard/page.tsx", () => {
    expect(LANDING_ROUTES.dashboard).toBe("/dashboard");
    expect(appPathExists("dashboard")).toBe(true);
  });

  it("has no placeholder, empty, or hash-only destination", () => {
    for (const href of Object.values(LANDING_ROUTES)) {
      expect(href).not.toBe("");
      expect(href).not.toBe("#");
      expect(href.startsWith("/")).toBe(true);
    }
  });
});

describe("createTemplateEditorHref", () => {
  it("targets the dynamic editor route, which exists", () => {
    expect(createTemplateEditorHref("restaurant")).toBe("/editor/restaurant");
    expect(appPathExists("editor", "[id]")).toBe(true);
  });

  it("produces a resolvable href for every template in the registry", () => {
    expect(templates.length).toBeGreaterThan(0);

    for (const template of templates) {
      const href = createTemplateEditorHref(template.id);

      expect(href).toBe(`/editor/${template.id}`);
      expect(template.id.trim()).not.toBe("");
      // An id with a slash would break out of the intended route segment.
      expect(template.id).not.toContain("/");
    }
  });
});

describe("landing section anchors match the ids the sections render", () => {
  it("derives anchors from the shared section ids", () => {
    expect(LANDING_SECTION_ANCHORS.templates).toBe(
      `#${LANDING_SECTION_IDS.templates}`
    );
    expect(LANDING_SECTION_ANCHORS.features).toBe(
      `#${LANDING_SECTION_IDS.features}`
    );
    expect(LANDING_SECTION_ANCHORS.howItWorks).toBe(
      `#${LANDING_SECTION_IDS.howItWorks}`
    );
  });

  it("has a real target section for each anchor", () => {
    expect(readLandingComponent("Templates.tsx")).toContain(
      "LANDING_SECTION_IDS.templates"
    );
    expect(readLandingComponent("Features.tsx")).toContain(
      `id="${LANDING_SECTION_IDS.features}"`
    );
    expect(readLandingComponent("HowItWorks.tsx")).toContain(
      `id="${LANDING_SECTION_IDS.howItWorks}"`
    );
  });
});

describe("header primary action respects auth state", () => {
  it("sends a signed-out visitor to sign-up", () => {
    expect(getLandingPrimaryAction(false)).toEqual({
      label: "Get Started",
      href: "/signup",
    });
  });

  it("sends a signed-in visitor to the dashboard, not an auth page", () => {
    const action = getLandingPrimaryAction(true);

    expect(action).toEqual({ label: "Dashboard", href: "/dashboard" });
    expect(action.href).not.toBe(LANDING_ROUTES.login);
    expect(action.href).not.toBe(LANDING_ROUTES.signup);
  });

  it("offers a sign-in destination, which the landing page previously lacked entirely", () => {
    expect(getLandingSignInAction()).toEqual({
      label: "Sign In",
      href: "/login",
    });
  });
});

// Source-level guards against the exact regression: a primary call to action
// rendered as a <button> with no handler navigates nowhere and fails
// silently. These assert the fixed elements are links.
describe("landing calls to action are real links, not dead buttons", () => {
  it("Hero 'Start Building' is a Link to /templates", () => {
    const source = readLandingMarkup("Hero.tsx");

    expect(source).toContain("LANDING_ROUTES.templates");
    expect(source).toContain("<Link");
    expect(source).not.toMatch(/<button[\s\S]*?Start Building/);
  });

  it("CTASection 'Start Building' is a Link to /templates", () => {
    const source = readLandingMarkup("CTASection.tsx");

    expect(source).toContain("LANDING_ROUTES.templates");
    expect(source).toContain("<Link");
    expect(source).not.toMatch(/<button[\s\S]*?Start Building/);
  });

  it("TemplateCard 'View Template' is a Link built from a templateId", () => {
    const source = readLandingMarkup("TemplateCard.tsx");

    expect(source).toContain("createTemplateEditorHref");
    expect(source).toContain("<Link");
    expect(source).not.toMatch(/<button[\s\S]*?View Template/);
  });

  it("Navbar renders links for the primary and sign-in actions", () => {
    const source = readLandingMarkup("Navbar.tsx");

    expect(source).toContain("primaryAction.href");
    expect(source).toContain("signInAction.href");
    expect(source).not.toMatch(/<button[\s\S]*?Get Started/);
  });

  it("no landing component contains a hash-only or empty href", () => {
    const components = [
      "Navbar.tsx",
      "Hero.tsx",
      "Templates.tsx",
      "TemplateCard.tsx",
      "CTASection.tsx",
      "Footer.tsx",
    ];

    for (const name of components) {
      const source = readLandingMarkup(name);

      expect(source).not.toContain('href="#"');
      expect(source).not.toContain('href=""');
    }
  });
});

describe("landing templates come from the canonical registry", () => {
  it("Templates.tsx consumes data/templates instead of a hardcoded list", () => {
    const source = readLandingMarkup("Templates.tsx");

    expect(source).toContain('from "@/data/templates"');
    // The old drifted hardcoded titles must not reappear.
    expect(source).not.toContain('title: "Restaurant"');
    expect(source).not.toContain('title: "Cafe"');
  });

  it("passes a real registry id to every card", () => {
    const source = readLandingComponent("Templates.tsx");

    expect(source).toContain("templateId={template.id}");
    expect(source).toContain("title={template.name}");
  });
});
