// Lane 3 Task 3 — the public site's search-engine facts, in one place.
//
// WHERE THE ORIGIN COMES FROM, AND WHY IT IS IMPORTED RATHER THAN RETYPED.
//
// lib/siteOrigin.ts already declares https://pos-canvas.vercel.app as
// PRODUCTION_SITE_ORIGIN. That module is a SECURITY allow-list: it decides
// which origin a password-recovery link may return to, and its rules are about
// failing closed, not about marketing. Retyping the origin here would create a
// second place for the deployment domain to live, and the two would disagree
// the first time the site moved.
//
// So the dependency runs ONE WAY: SEO reads the security module's constant as
// a fact. lib/siteOrigin.ts must never import from here — its allow-list must
// not be widened by anything a metadata change does. The concerns stay
// separate; only the string is shared, because there is only one domain.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO. It does not decide access. A
// route is private because proxy.ts redirects it and RLS scopes its data;
// `noindex` and a robots.txt Disallow are search-visibility hints and nothing
// more. Neither is a security control, and neither is treated as one here.
//
// Dependency-free of React and Supabase, so the classification and the
// structured data are unit-testable.
import type { Metadata } from "next";
import { BRAND, BRAND_TAGLINE } from "@/lib/brand";
import { LANDING_PAGE_PATHS } from "@/lib/landingPages";
import type { LandingPage } from "@/lib/landingPages";
import { getPlatformDownloads, isDownloadable } from "@/lib/platformDownloads";
import { PRODUCTION_SITE_ORIGIN } from "@/lib/siteOrigin";

/** The canonical public origin, re-exported so callers need not reach past it. */
export const SITE_ORIGIN = PRODUCTION_SITE_ORIGIN;

/** `metadataBase` for the root layout: makes every relative URL absolute. */
export const SITE_URL = new URL(SITE_ORIGIN);

/**
 * An absolute URL for a site path.
 *
 * Normalises the leading slash and strips a trailing one (except for the root)
 * so "/templates" and "templates/" cannot produce two canonicals for one page.
 */
export function absoluteUrl(path: string): string {
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  const trimmed =
    withSlash.length > 1 && withSlash.endsWith("/")
      ? withSlash.slice(0, -1)
      : withSlash;

  return `${SITE_ORIGIN}${trimmed}`;
}

// ---------------------------------------------------------------------------
// Route classification
// ---------------------------------------------------------------------------

/**
 * Public pages that SHOULD compete in search.
 *
 * Only pages with content a searcher could actually want. Every one of these
 * canonicalises to itself, appears in the sitemap, and is crawlable.
 *
 * Template DETAIL pages are included per template id rather than as a pattern,
 * because they are generated from the canonical registry (data/templates.ts) —
 * six real pages with a name, a description, a starter catalogue and a preview,
 * not an open-ended dynamic space.
 */
export const INDEXABLE_PATHS = [
  "/",
  "/templates",
  "/learn",
  // Lane 3 Task 4 — the SEO landing pages, read from their registry so a
  // page cannot be indexable here under one path and live under another.
  ...LANDING_PAGE_PATHS,
] as const;

/**
 * Publicly reachable pages that should NOT compete in search.
 *
 * These exist for a person who already decided to use the product. A search
 * result landing on a bare sign-in form helps nobody, and a password-reset
 * screen in an index is worse than useless.
 *
 * They are NOT disallowed in robots.txt: a crawler has to be able to FETCH a
 * page to see its `noindex`. Blocking them in robots.txt and marking them
 * noindex at the same time is the classic mistake — the directive never gets
 * read, and the URL can still surface from inbound links.
 */
export const NOINDEX_PUBLIC_PATHS = [
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/device",
] as const;

/**
 * Application surfaces behind the proxy.
 *
 * proxy.ts redirects an unauthenticated request for these to /login, so a
 * crawler never reaches content in the first place. They are disallowed in
 * robots.txt to save the crawl, and they ALSO carry `noindex` — belt and
 * braces, so the intent survives a change to the proxy's matcher.
 */
export const APPLICATION_PATH_PREFIXES = [
  "/dashboard",
  "/editor",
  "/runtime",
] as const;

/** Not a page at all — the Supabase recovery handler. */
export const NON_PAGE_PATH_PREFIXES = ["/auth"] as const;

/**
 * The robots directive for everything that must stay out of the index.
 *
 * `follow` stays TRUE: these pages link back to real public pages, and there is
 * no reason to throw that away. It is the indexing that is unwanted, not the
 * crawling.
 */
export const NOINDEX_ROBOTS = {
  index: false,
  follow: true,
  googleBot: { index: false, follow: true },
} as const;

// ---------------------------------------------------------------------------
// Open Graph
// ---------------------------------------------------------------------------

/**
 * A complete Open Graph block for one page.
 *
 * WHY A BUILDER RATHER THAN INHERITANCE. Next merges metadata field by field,
 * and `openGraph` is one field: a page that sets `openGraph.title` REPLACES the
 * layout's entire object rather than extending it. The root layout declares
 * siteName, type and locale, and setting a per-page og:title silently dropped
 * all three — verified against the rendered HTML, where og:site_name was
 * present on the noindex pages (which set no openGraph of their own) and
 * missing from the homepage, the gallery and every template page.
 *
 * That is the kind of defect source inspection cannot find, so the shared
 * fields live here and every page spreads the whole block.
 */
export function buildOpenGraph(input: {
  title: string;
  description: string;
  path: string;
}) {
  return {
    title: input.title,
    description: input.description,
    url: absoluteUrl(input.path),
    siteName: BRAND.websiteName,
    type: "website" as const,
    locale: "en_US",
  };
}

/**
 * The complete metadata for one SEO landing page (Lane 3 Task 4).
 *
 * ONE BUILDER FOR THE THREE PAGES, so the parts that must never differ cannot:
 * each page canonicalises to its own registry path, its og:url is that same
 * path, and none of them carries a robots directive — they are meant to index.
 * The title is a plain string, so the root layout's " · POS Canvas" template
 * applies, as it does on /templates and /learn.
 *
 * No `images`: no approved social card exists (lib/seo.guards.test.ts), and no
 * structured data is returned — a landing page is not a Product, an Offer, an
 * FAQ or a review, and claiming any of those would be invented.
 */
export function buildLandingPageMetadata(page: LandingPage): Metadata {
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: absoluteUrl(page.path) },
    openGraph: buildOpenGraph({
      title: page.title,
      description: page.socialDescription,
      path: page.path,
    }),
  };
}

// ---------------------------------------------------------------------------
// Structured data
// ---------------------------------------------------------------------------

/**
 * The operating systems the product ACTUALLY ships on, read from the release
 * model rather than typed here.
 *
 * getPlatformDownloads() derives availability from the release modules, so a
 * platform that is between releases or not yet shipped drops out of the schema
 * on its own. Claiming an OS the product cannot be installed on is exactly the
 * kind of thing structured data gets penalised for.
 */
export function supportedOperatingSystems(): string[] {
  return getPlatformDownloads().filter(isDownloadable).map((d) => d.label);
}

/**
 * WebSite — the safe one.
 *
 * Name and URL, both of which are facts. No SearchAction: this site has no
 * search endpoint, and declaring one that does not exist is a lie a crawler
 * will try and fail to use.
 */
export function buildWebSiteJsonLd(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: BRAND.websiteName,
    url: absoluteUrl("/"),
    description: BRAND_TAGLINE,
  };
}

/**
 * SoftwareApplication — truthful subset only.
 *
 * DELIBERATELY ABSENT, each for a reason rather than an oversight:
 *
 *   offers / price          There is no pricing system in this product. An
 *                           invented price is a commercial claim, and "0" is
 *                           itself a claim that the product is free.
 *   aggregateRating/review  No ratings exist. These are the fields most
 *                           commonly faked and most commonly penalised.
 *   downloadUrl             Platform-specific and already rendered truthfully
 *                           by the platform section from release metadata;
 *                           schema cannot express "two, one per OS" here
 *                           without picking one and implying it is the only one.
 *   softwareVersion         Android and Windows version independently. One
 *                           field cannot state two versions honestly, and they
 *                           happen to match today only by coincidence.
 *
 * Search Console may report "missing field offers" for this type. That warning
 * is correct and is the right trade: a missing optional field costs a rich
 * result, an invented price costs trust.
 */
export function buildSoftwareApplicationJsonLd(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: BRAND.productName,
    applicationCategory: "BusinessApplication",
    operatingSystem: supportedOperatingSystems().join(", "),
    url: absoluteUrl("/"),
    description:
      "Point-of-sale software a business owner configures from a template. " +
      "Publish your configuration, install the POS Canvas app, and pair a " +
      "device to turn it into your till.",
  };
}

/**
 * Article — for one real, published Learn article.
 *
 * DELIBERATELY ABSENT:
 *
 *   author      There is no approved author identity for POS Canvas content.
 *               An invented person, or an "author" pointing at a company with
 *               no legal entity (lib/brand.ts holds null for legalCompanyName),
 *               is the most common fabrication on a content site. Omitted
 *               rather than guessed.
 *   publisher   Same reason: publisher wants an Organization, and there is no
 *               truthful Organization to give it.
 *   image       No approved editorial artwork exists. A diagram drawn in the
 *               page is not a social card.
 *
 * What remains — headline, description, the two dates and the canonical URL —
 * is all verifiable from the article itself.
 */
export function buildArticleJsonLd(input: {
  title: string;
  description: string;
  path: string;
  /** Absent only for content that is not published, which never reaches schema. */
  publishedAt?: string;
  updatedAt?: string;
}): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: input.title,
    description: input.description,
    // Omitted rather than invented when absent. An article without a real
    // publication date does not get a made-up one in its structured data.
    ...(input.publishedAt ? { datePublished: input.publishedAt } : {}),
    ...(input.updatedAt ? { dateModified: input.updatedAt } : {}),
    mainEntityOfPage: absoluteUrl(input.path),
    url: absoluteUrl(input.path),
  };
}

/**
 * BreadcrumbList — Home > Learn > Article.
 *
 * Included because it is TRUE of the navigation a reader actually has: the
 * article links back to /learn, and /learn links back to /. A breadcrumb trail
 * that does not exist on the page is the version worth refusing.
 */
export function buildBreadcrumbJsonLd(
  trail: readonly { name: string; path: string }[]
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((step, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: step.name,
      item: absoluteUrl(step.path),
    })),
  };
}

// NO VideoObject HELPER EXISTS YET, AND THAT IS THE DECISION.
//
// VideoObject requires name, description, thumbnailUrl and uploadDate to be
// truthful, and there is no real video in the library. A builder that emitted
// the type from an empty or placeholder configuration would be a schema claim
// about a video that does not exist. LearnArticle.video is typed so that a real
// video carries all four fields; the helper gets written when the first one is
// published, not before.

// NO Organization SCHEMA, AND THIS IS THE DECISION RATHER THAN AN OMISSION.
//
// Organization's useful fields are legalName, address, contactPoint, sameAs
// (social profiles) and logo-with-publisher-identity. lib/brand.ts holds null
// for legalCompanyName, supportEmail and websiteUrl precisely because none of
// them has an approved value, and there are no social accounts to list. What
// would be left is a name and a URL, which WebSite already states truthfully.
//
// An Organization block padded with invented values is worse than no
// Organization block: it is the schema type that asserts who is legally
// responsible for the product, and that is the one claim this repository has
// consistently refused to guess. Revisit when a legal entity exists.
