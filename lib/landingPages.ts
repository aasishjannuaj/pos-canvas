// Lane 3 Task 4 — the SEO landing pages' search-facing facts, in one place.
//
// WHY A REGISTRY FOR THREE PAGES. A landing page's path and title are read in
// four places: the page's own metadata, the sitemap, the indexable-path list in
// lib/seo.ts, and the guards. Typed separately in each, a renamed page is how a
// sitemap ends up advertising a URL that no longer exists, or two pages end up
// with the same title. Here each fact is written once.
//
// WHAT IS DELIBERATELY NOT HERE: the page bodies. Each page is composed by hand
// in its own route file, because the three answer different questions — what
// can I change, how does a small business get started, and what does no-code
// mean — and a shared content template would make them one page three times.
//
// WHAT IS DELIBERATELY NOT A LANDING PAGE. /liquor-store-pos was planned in
// Task 3 and was not approved in Task 4. It must not be added without its own
// approval; lib/landingPages.guards.test.ts asserts the exact set.
//
// Dependency-free, so lib/seo.ts can import it without creating a cycle.

export type LandingPage = {
  /** The route, which is also the canonical path. */
  path: string;
  /**
   * The search question the page exists to answer. Written for the next editor,
   * never rendered: a page that drifts from this is a page competing with its
   * siblings.
   */
  intent: string;
  /** The <title> before the layout's " · POS Canvas" suffix, and the og:title. */
  title: string;
  /** The meta description. */
  description: string;
  /**
   * The og:description. Next.js also derives twitter:description from it, since
   * the root layout declares a twitter card without its own text.
   */
  socialDescription: string;
};

export const CUSTOMIZABLE_POS_PAGE = {
  path: "/customizable-pos",
  intent:
    "An owner who wants a POS that adapts to their business, and needs to know " +
    "what customization means in POS Canvas today and where it ends.",
  title: "Customizable POS for your products, prices and brand",
  description:
    "What you can customize in POS Canvas today: products, categories, " +
    "prices, add-ons, taxes, receipt details and branding, starting from a " +
    "template.",
  socialDescription:
    "Products, prices, add-ons, taxes, receipts and branding: what you can " +
    "change in a POS Canvas template before you publish it.",
} as const satisfies LandingPage;

export const POS_FOR_SMALL_BUSINESS_PAGE = {
  path: "/pos-for-small-business",
  intent:
    "A small or early-stage business owner evaluating a practical POS: what " +
    "they need, how to get started, what works on day one, and whether it fits.",
  title: "POS for small and early-stage businesses",
  description:
    "How a small business gets a point of sale running with POS Canvas: " +
    "choose a template, set up what you sell, publish, and pair an Android " +
    "or Windows device.",
  socialDescription:
    "What you need, the steps to get started, and what works from the first " +
    "day: a point of sale a small business sets up itself.",
} as const satisfies LandingPage;

export const NO_CODE_POS_BUILDER_PAGE = {
  path: "/no-code-pos-builder",
  intent:
    "Someone looking to create a POS without code, who needs to know what " +
    "no-code means here: a template, a business configuration and one shared " +
    "POS platform — not a general software generator.",
  title: "No-code POS builder: set up a POS without code",
  description:
    "Set up a point of sale without writing code. POS Canvas combines a " +
    "template, your business configuration and one shared POS app for " +
    "Android and Windows.",
  socialDescription:
    "A template, your business configuration and one shared app: how POS " +
    "Canvas lets an owner set up a point of sale without writing code.",
} as const satisfies LandingPage;

/** Every landing page, in the order the sitemap lists them. */
export const LANDING_PAGES = [
  CUSTOMIZABLE_POS_PAGE,
  POS_FOR_SMALL_BUSINESS_PAGE,
  NO_CODE_POS_BUILDER_PAGE,
] as const;

export type LandingPagePath = (typeof LANDING_PAGES)[number]["path"];

export const LANDING_PAGE_PATHS: readonly LandingPagePath[] = LANDING_PAGES.map(
  (page) => page.path
);
