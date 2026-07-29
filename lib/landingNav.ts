// Landing-page navigation destinations, in one dependency-free place.
//
// Exists so the landing page's destinations are unit-testable: this
// repository has no React Testing Library (verified — no testing-library
// dependency in package.json), so component rendering is not tested. Keeping
// the hrefs here means a test can assert both the exact destinations and
// that each one corresponds to a real route in app/, which is what actually
// regressed: every primary landing button was a <button> with no handler and
// no href, so it silently did nothing.
//
// In-page section anchors (#templates/#features/#how-it-works) are included
// so a test can confirm they match the ids the sections actually render.

export const LANDING_ROUTES = {
  templates: "/templates",
  login: "/login",
  signup: "/signup",
  dashboard: "/dashboard",
} as const;

export const LANDING_SECTION_IDS = {
  templates: "templates",
  features: "features",
  howItWorks: "how-it-works",
} as const;

export const LANDING_SECTION_ANCHORS = {
  templates: `#${LANDING_SECTION_IDS.templates}`,
  features: `#${LANDING_SECTION_IDS.features}`,
  howItWorks: `#${LANDING_SECTION_IDS.howItWorks}`,
} as const;

// The editor is the canonical "use this template" destination, matching what
// components/templates/TemplateGalleryCard.tsx and
// components/template-detail/TemplateActionPanel.tsx already link to. Note
// /editor is proxy-protected (see proxy.ts), so an unauthenticated visitor
// is redirected to /login — that is expected, not a broken link.
export function createTemplateEditorHref(templateId: string): string {
  return `/editor/${templateId}`;
}

export type LandingPrimaryAction = {
  label: string;
  href: string;
};

// The header's primary action depends on auth state so a signed-in visitor
// is not pushed toward sign-up (and, after signing in, is not bounced back
// to an auth page). Signed out gets both a Sign In and a Get Started entry;
// previously the landing page offered neither, and had no route to /login at
// all.
export function getLandingPrimaryAction(
  isAuthenticated: boolean
): LandingPrimaryAction {
  return isAuthenticated
    ? { label: "Dashboard", href: LANDING_ROUTES.dashboard }
    : { label: "Get Started", href: LANDING_ROUTES.signup };
}

export function getLandingSignInAction(): LandingPrimaryAction {
  return { label: "Sign In", href: LANDING_ROUTES.login };
}
