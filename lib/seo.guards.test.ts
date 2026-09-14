// Lane 3 Task 3 — the search-facing facts, guarded.
//
// SEO is a category where a mistake is silent, slow and expensive: nothing
// throws, no test goes red, and you find out months later that every page
// canonicalised to the homepage or that the sitemap advertised a page that
// 404s. These guards cover the specific ways that happens.
//
// They are BEHAVIOURAL where they can be: the sitemap and robots modules are
// imported and executed, so what is asserted is what Next will emit, not what
// the source appears to say. Only the per-route metadata is checked at source
// level, because a page module cannot be rendered under this suite.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import sitemap from "@/app/sitemap";
import robots from "@/app/robots";
import {
  APPLICATION_PATH_PREFIXES,
  INDEXABLE_PATHS,
  NOINDEX_PUBLIC_PATHS,
  SITE_ORIGIN,
  absoluteUrl,
  buildSoftwareApplicationJsonLd,
  buildWebSiteJsonLd,
  supportedOperatingSystems,
} from "@/lib/seo";
import { PRODUCTION_SITE_ORIGIN } from "@/lib/siteOrigin";
import { templates } from "@/data/templates";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf-8");
}

function code(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const APPROVED_ORIGIN = "https://pos-canvas.vercel.app";

// ---------------------------------------------------------------------------
// One origin, one home
// ---------------------------------------------------------------------------

describe("the canonical origin is the approved one, declared once", () => {
  it("is the approved production origin", () => {
    expect(SITE_ORIGIN).toBe(APPROVED_ORIGIN);
  });

  it("is READ from the security module, not retyped", () => {
    // lib/siteOrigin.ts owns the string because it is a security allow-list for
    // password-recovery redirects. SEO borrows it. Two copies would disagree
    // the first time the domain moved.
    expect(SITE_ORIGIN).toBe(PRODUCTION_SITE_ORIGIN);
    expect(code(read("lib/seo.ts"))).toContain(
      'import { PRODUCTION_SITE_ORIGIN } from "@/lib/siteOrigin"'
    );
  });

  it("appears as a literal in exactly one source file", () => {
    for (const file of ["lib/seo.ts", "app/sitemap.ts", "app/robots.ts", "app/layout.tsx", "app/page.tsx"]) {
      expect(`${file} hardcodes the origin`).toBe(`${file} hardcodes the origin`);
      expect(code(read(file))).not.toContain(APPROVED_ORIGIN);
    }

    expect(read("lib/siteOrigin.ts")).toContain(APPROVED_ORIGIN);
  });

  it("the security module does not depend on the SEO module", () => {
    // THE DIRECTION MATTERS. A metadata change must never be able to widen the
    // set of origins a recovery link may return to.
    const origin = code(read("lib/siteOrigin.ts"));

    expect(origin).not.toContain("@/lib/seo");
    expect(origin).not.toContain("metadata");
  });

  it("absoluteUrl produces one URL per page, not two", () => {
    // A trailing slash is how the same page gets two canonicals.
    expect(absoluteUrl("/templates")).toBe(`${APPROVED_ORIGIN}/templates`);
    expect(absoluteUrl("/templates/")).toBe(`${APPROVED_ORIGIN}/templates`);
    expect(absoluteUrl("templates")).toBe(`${APPROVED_ORIGIN}/templates`);
    expect(absoluteUrl("/")).toBe(`${APPROVED_ORIGIN}/`);
  });
});

// ---------------------------------------------------------------------------
// Sitemap — executed, not read
// ---------------------------------------------------------------------------

describe("the sitemap advertises only real, public, indexable pages", () => {
  const urls = sitemap().map((entry) => entry.url);

  it("lists the homepage, the gallery and every registry template", () => {
    expect(urls).toContain(absoluteUrl("/"));
    expect(urls).toContain(absoluteUrl("/templates"));

    for (const template of templates) {
      expect(`sitemap has ${template.id}`).toBe(`sitemap has ${template.id}`);
      expect(urls).toContain(absoluteUrl(`/templates/${template.id}`));
    }

    expect(urls).toHaveLength(2 + templates.length);
  });

  it("excludes every application and private surface", () => {
    for (const secret of [
      "/dashboard",
      "/editor",
      "/runtime",
      "/device",
      "/login",
      "/signup",
      "/forgot-password",
      "/reset-password",
      "/auth",
    ]) {
      expect(`sitemap leaks ${secret}`).toBe(`sitemap leaks ${secret}`);
      expect(urls.some((url) => url.includes(secret))).toBe(false);
    }
  });

  it("excludes the four SEO landing pages that do not exist yet", () => {
    // PLAN ONLY as of Task 3. A sitemap entry for an unbuilt route is a
    // self-inflicted crawl error, and the fastest way to teach a crawler to
    // distrust the file.
    for (const planned of [
      "customizable-pos",
      "pos-for-small-business",
      "liquor-store-pos",
      "no-code-pos-builder",
    ]) {
      expect(`sitemap has unbuilt ${planned}`).toBe(`sitemap has unbuilt ${planned}`);
      expect(urls.some((url) => url.includes(planned))).toBe(false);
      expect(existsSync(join(repoRoot, "app", planned, "page.tsx"))).toBe(false);
    }
  });

  it("every listed page has a route that actually exists", () => {
    expect(existsSync(join(repoRoot, "app/page.tsx"))).toBe(true);
    expect(existsSync(join(repoRoot, "app/templates/page.tsx"))).toBe(true);
    expect(existsSync(join(repoRoot, "app/templates/[id]/page.tsx"))).toBe(true);
  });

  it("invents no freshness or priority signal", () => {
    // There is no per-page content timestamp in this repository. A build-time
    // date would tell crawlers every page changed on every deploy.
    for (const entry of sitemap()) {
      expect(entry.lastModified).toBeUndefined();
      expect(entry.priority).toBeUndefined();
      expect(entry.changeFrequency).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Robots — executed, not read
// ---------------------------------------------------------------------------

describe("robots.txt asks for the right things and is not treated as a fence", () => {
  const result = robots();
  const rules = Array.isArray(result.rules) ? result.rules[0] : result.rules;
  const disallow = ([] as string[]).concat(rules?.disallow ?? []);

  it("allows the public site", () => {
    expect(rules?.allow).toBe("/");
    expect(disallow).not.toContain("/");
  });

  it("disallows every application prefix, as a bare prefix", () => {
    // Bare, because robots.txt matching is a prefix match: "/dashboard/" would
    // silently fail to cover the /dashboard page itself.
    for (const prefix of APPLICATION_PATH_PREFIXES) {
      expect(`robots disallows ${prefix}`).toBe(`robots disallows ${prefix}`);
      expect(disallow).toContain(prefix);
      expect(disallow).not.toContain(`${prefix}/`);
    }
  });

  it("does NOT disallow the pages that rely on a noindex directive", () => {
    // THE CLASSIC MISTAKE. A crawler must be able to fetch a page to read its
    // `noindex`. Blocking these here would hide the very instruction that keeps
    // them out of the index, and the URLs could still be indexed from links.
    for (const path of NOINDEX_PUBLIC_PATHS) {
      expect(`robots blocks ${path}`).toBe(`robots blocks ${path}`);
      expect(disallow).not.toContain(path);
    }
  });

  it("points at the sitemap on the approved origin", () => {
    expect(result.sitemap).toBe(`${APPROVED_ORIGIN}/sitemap.xml`);
  });

  it("is not relied on as access control", () => {
    // The real gate is proxy.ts. If this ever stops being true, the comment in
    // app/robots.ts is a lie and so is this test's name.
    const proxy = code(read("proxy.ts"));

    expect(proxy).toContain('const PROTECTED_PREFIXES = ["/dashboard", "/editor", "/runtime"]');
  });
});

// ---------------------------------------------------------------------------
// Canonicals and indexability, per route
// ---------------------------------------------------------------------------

describe("each route canonicalises to itself, and only the right ones index", () => {
  it("the root layout declares NO canonical", () => {
    // THE MOST DAMAGING INHERITANCE BUG AVAILABLE. Metadata inherits, so a
    // canonical on the root layout would give every page the homepage's
    // canonical and collapse the whole site into one URL.
    const layout = code(read("app/layout.tsx"));

    expect(layout).toContain("metadataBase");
    expect(layout).not.toContain("canonical");
  });

  it("each indexable page canonicalises to its own path", () => {
    expect(code(read("app/page.tsx"))).toContain('canonical: absoluteUrl("/")');
    expect(code(read("app/templates/page.tsx"))).toContain(
      'canonical: absoluteUrl("/templates")'
    );
    expect(code(read("app/templates/[id]/page.tsx"))).toContain(
      "absoluteUrl(`/templates/${template.id}`)"
    );
  });

  it("every publicly reachable non-content page carries noindex", () => {
    const sources: Record<string, string> = {
      "/login": "app/login/layout.tsx",
      "/signup": "app/signup/layout.tsx",
      "/forgot-password": "app/forgot-password/layout.tsx",
      "/reset-password": "app/reset-password/layout.tsx",
      "/device": "app/device/page.tsx",
    };

    for (const path of NOINDEX_PUBLIC_PATHS) {
      const file = sources[path];
      expect(`${path} -> ${file}`).toBe(`${path} -> ${file}`);
      expect(existsSync(join(repoRoot, file))).toBe(true);
      expect(code(read(file))).toContain("NOINDEX_ROBOTS");
    }
  });

  it("every application route carries noindex as well as the proxy", () => {
    for (const file of [
      "app/dashboard/page.tsx",
      "app/editor/[id]/page.tsx",
      "app/runtime/[id]/page.tsx",
    ]) {
      expect(`${file}`).toBe(file);
      expect(code(read(file))).toContain("NOINDEX_ROBOTS");
    }
  });

  it("the unknown-template page is noindex, so a soft 404 cannot be indexed", () => {
    // /templates/anything returns HTTP 200 with an "unavailable" state by
    // design. Without this, the route is an unlimited supply of near-identical
    // indexable dead pages.
    const detail = code(read("app/templates/[id]/page.tsx"));
    const unknownBranch = detail.slice(detail.indexOf("if (!template)"));

    expect(unknownBranch).toContain("NOINDEX_ROBOTS");
  });

  it("no indexable page was accidentally marked noindex", () => {
    for (const file of ["app/page.tsx", "app/templates/page.tsx"]) {
      expect(`${file}`).toBe(file);
      expect(code(read(file))).not.toContain("NOINDEX_ROBOTS");
    }

    expect(INDEXABLE_PATHS).toContain("/");
    expect(INDEXABLE_PATHS).toContain("/templates");
  });
});

// ---------------------------------------------------------------------------
// Structured data
// ---------------------------------------------------------------------------

describe("structured data claims nothing the product cannot back", () => {
  const blob = JSON.stringify([
    buildWebSiteJsonLd(),
    buildSoftwareApplicationJsonLd(),
  ]);

  it("declares WebSite and SoftwareApplication, both truthfully typed", () => {
    expect(buildWebSiteJsonLd()["@type"]).toBe("WebSite");
    expect(buildSoftwareApplicationJsonLd()["@type"]).toBe("SoftwareApplication");
  });

  it("invents no rating, review, price or download count", () => {
    // The fields most commonly faked, and the ones search engines penalise.
    for (const banned of [
      "aggregateRating",
      "ratingValue",
      "reviewCount",
      "review",
      "offers",
      "price",
      "priceCurrency",
      "downloadCount",
      "interactionCount",
    ]) {
      expect(`schema: ${banned}`).toBe(`schema: ${banned}`);
      expect(blob).not.toContain(banned);
    }
  });

  it("declares no Organization", () => {
    // lib/brand.ts holds null for legalCompanyName, supportEmail and
    // websiteUrl. Organization is the type that asserts who is legally
    // responsible for the software, and that is the one claim this repository
    // has consistently refused to guess.
    expect(blob).not.toContain("Organization");
    expect(blob).not.toContain("legalName");
    expect(blob).not.toContain("sameAs");
    expect(blob).not.toContain("contactPoint");
    expect(blob).not.toContain("address");
  });

  it("names only operating systems the product actually ships on", () => {
    // Derived from the release model, so a platform that stops shipping drops
    // out of the schema on its own rather than lingering as a claim.
    const os = supportedOperatingSystems();

    expect(os).toContain("Android");
    expect(os).toContain("Windows");
    expect(code(read("lib/seo.ts"))).toContain("getPlatformDownloads");
  });

  it("declares no search endpoint, because there is no site search", () => {
    expect(blob).not.toContain("SearchAction");
    expect(blob).not.toContain("potentialAction");
  });
});

// ---------------------------------------------------------------------------
// Breadth of support
// ---------------------------------------------------------------------------

describe("no public surface claims coverage the product does not have", () => {
  // THE REGRESSION THIS EXISTS FOR, IN FULL.
  //
  // Task 2 deleted "Built for every kind of business" from the Business Types
  // section because it asserted breadth nothing backs: there are SIX canonical
  // templates in data/templates.ts, not a template for every trade. One task
  // later the /templates metadata shipped "POS templates for every kind of
  // business" — the same claim, moved into the one place nobody reads in a
  // design review, where it would have become the page's search-result title.
  //
  // TWO LISTS, BECAUSE "every business" IS NOT ALWAYS A COVERAGE CLAIM.
  //
  // "The download is the same for every business" is architecture, not
  // breadth: one universal binary, specialised by pairing. It is TRUE, it is
  // load-bearing product copy, and lib/homepageTruth.guards.test.ts asserts
  // that PlatformAvailability still contains it. A blanket ban on the substring
  // would fail that guard and delete a true sentence to prevent a false one.
  //
  // So: the unambiguous coverage phrases are banned EVERYWHERE on public
  // marketing surfaces, and the ambiguous "every/any business" pair is banned
  // only in SEO METADATA, where the sentence is a positioning claim rather than
  // an explanation of how distribution works.

  /** Never true of this product, in body copy or metadata. */
  const COVERAGE_CLAIMS = [
    "every kind of business",
    "any kind of business",
    "every type of business",
    "any type of business",
    "all kinds of business",
    "every industry",
    "any industry",
    "all industries",
    "all businesses",
    "every trade",
  ];

  /** Fine as architecture in body copy; a breadth claim in a page title. */
  const METADATA_ONLY_CLAIMS = ["every business", "any business"];

  /** The files whose strings become titles, descriptions and social cards. */
  const METADATA_SURFACES = [
    "app/layout.tsx",
    "app/page.tsx",
    "app/templates/page.tsx",
    "app/templates/[id]/page.tsx",
    "lib/seo.ts",
  ];

  /** Public marketing copy a searcher or visitor actually reads. */
  const PUBLIC_COPY_SURFACES = [
    "components/templates/TemplateGalleryHeader.tsx",
    "components/templates/TemplateGalleryCard.tsx",
    "components/landing/Templates.tsx",
    "components/landing/TemplateCard.tsx",
    "components/landing/BusinessTypes.tsx",
    "components/landing/Hero.tsx",
  ];

  /**
   * Comment-stripped source, with concatenated string literals JOINED and
   * whitespace collapsed.
   *
   * BOTH STEPS ARE LOAD-BEARING, and the first draft of this guard was wrong
   * without them. Long metadata strings are written as `"... liquor " +
   * "stores, food trucks ..."`, so the source text contains `liquor " + "stores`
   * and a naive substring search for "liquor store" finds nothing that is
   * plainly there in the rendered page. Joining the literals matches what a
   * reader actually sees rather than how it happens to be wrapped.
   */
  function copy(relativePath: string): string {
    return code(read(relativePath))
      .replace(/"\s*\+\s*"/g, "")
      .replace(/\s+/g, " ")
      .toLowerCase();
  }

  /**
   * Whole-phrase match.
   *
   * ALSO LOAD-BEARING: "small businesses" ends in the letters "all businesses",
   * so a substring check flagged the corrected title as the very claim it was
   * written to remove. Word boundaries keep the guard aimed at the phrase
   * rather than at a coincidence of spelling.
   */
  function claims(source: string, phrase: string): boolean {
    return new RegExp(`\\b${phrase.replace(/ /g, "\\s+")}\\b`).test(source);
  }

  for (const surface of [...METADATA_SURFACES, ...PUBLIC_COPY_SURFACES]) {
    it(`${surface} claims no universal business coverage`, () => {
      const source = copy(surface);

      for (const claim of COVERAGE_CLAIMS) {
        expect(`${surface}: ${claim}`).toBe(`${surface}: ${claim}`);
        expect(claims(source, claim)).toBe(false);
      }
    });
  }

  for (const surface of METADATA_SURFACES) {
    it(`${surface} metadata positions without an "every business" claim`, () => {
      const source = copy(surface);

      for (const claim of METADATA_ONLY_CLAIMS) {
        expect(`${surface}: ${claim}`).toBe(`${surface}: ${claim}`);
        expect(claims(source, claim)).toBe(false);
      }
    });
  }

  it("no public surface promises how long setup takes", () => {
    // ADDED AFTER THE SECOND REGRESSION OF THE SAME SENTENCE. The gallery
    // sub-headline read "start building in seconds"; the /pos-for-small-business
    // strategy drafted "set up in an afternoon". No setup-duration guarantee
    // has been established for this product, and a duration is the easiest
    // claim in marketing to write and the hardest to honour.
    //
    // "available today" is deliberately NOT banned: it bounds WHICH templates
    // exist, which is a fact, rather than how fast anything happens.
    const DURATION_CLAIMS = [
      "in seconds",
      "in minutes",
      "in hours",
      "in an afternoon",
      "within minutes",
      "instantly",
      "instant setup",
      "immediately ready",
      "up and running in",
      "ready in",
      "takes just",
    ];

    for (const surface of [...METADATA_SURFACES, ...PUBLIC_COPY_SURFACES]) {
      const source = copy(surface);

      for (const claim of DURATION_CLAIMS) {
        expect(`${surface}: ${claim}`).toBe(`${surface}: ${claim}`);
        expect(claims(source, claim)).toBe(false);
      }
    }
  });

  it("the true architectural sentence is left alone", () => {
    // THE CONTROL THAT KEEPS THIS GUARD HONEST. If a future tightening starts
    // banning "every business" in body copy, this fails and says why.
    expect(read("components/landing/PlatformAvailability.tsx")).toContain(
      "same for every business"
    );
  });

  it("the gallery description names every template that exists", () => {
    // SLICED TO THE DESCRIPTION FIELD, not matched against the whole file.
    //
    // The first version of this test searched the entire source, and a
    // negative control proved it could not fail: removing "liquor" from the
    // meta description still left the og:description naming it four lines
    // below, so the file matched and the guard passed on copy that had lost a
    // real category. The assertion now reads only the field it is about.
    const source = copy("app/templates/page.tsx");
    const start = source.indexOf("description:");
    const end = source.indexOf("alternates:");

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const description = source.slice(start, end);

    // A seventh template, or a renamed category, makes this fail rather than
    // leaving the page quietly under-reporting what it shows.
    for (const template of templates) {
      const category = template.category.toLowerCase();
      expect(`meta description names ${category}`).toBe(
        `meta description names ${category}`
      );
      expect(description).toContain(category);
    }
  });

  it("the social description names them too", () => {
    // The other half of the same fact. Split out so one can fail without
    // masking the other — which is exactly what the first version did.
    //
    // ANCHORED ON THE USAGE, NOT THE IDENTIFIER. Slicing from the first
    // "buildopengraph" landed on the IMPORT at the top of the file, so the
    // slice still contained the meta description and the test passed while the
    // og description had lost a category. Anchoring on "opengraph:" starts the
    // slice at the field being asserted.
    const source = copy("app/templates/page.tsx");
    const start = source.indexOf("opengraph: buildopengraph");
    expect(start).toBeGreaterThan(-1);

    const og = source.slice(start);

    for (const template of templates) {
      const category = template.category.toLowerCase();
      expect(`og description names ${category}`).toBe(
        `og description names ${category}`
      );
      expect(og).toContain(category);
    }
  });
});

// ---------------------------------------------------------------------------
// Metadata copy
// ---------------------------------------------------------------------------

describe("search metadata markets only what has shipped", () => {
  const METADATA_SOURCES = [
    "app/layout.tsx",
    "app/page.tsx",
    "app/templates/page.tsx",
    "app/templates/[id]/page.tsx",
    "lib/seo.ts",
  ];

  it("names no unreleased v1.3 capability", () => {
    for (const file of METADATA_SOURCES) {
      const source = code(read(file));

      for (const claim of [
        "barcode",
        "Barcode",
        "scanner",
        "scanning",
        "employee",
        "Employee",
        "time clock",
        "clock-in",
        "register session",
        "cash drawer",
        "age verification",
      ]) {
        expect(`${file}: ${claim}`).toBe(`${file}: ${claim}`);
        expect(source).not.toContain(claim);
      }
    }
  });

  it("invents no store listing, price or social proof", () => {
    for (const file of METADATA_SOURCES) {
      const source = code(read(file));

      for (const claim of [
        "Play Store",
        "Google Play",
        "App Store",
        "Microsoft Store",
        "free trial",
        "pricing",
        "per month",
        "guarantee",
        "trusted by",
        "#1",
        "best POS",
      ]) {
        expect(`${file}: ${claim}`).toBe(`${file}: ${claim}`);
        expect(source).not.toContain(claim);
      }
    }
  });

  it("does not describe the superseded per-business build", () => {
    for (const file of METADATA_SOURCES) {
      const source = code(read(file));

      for (const claim of ["your own app", "custom APK", "one APK", "we generate", "custom executable"]) {
        expect(`${file}: ${claim}`).toBe(`${file}: ${claim}`);
        expect(source).not.toContain(claim);
      }
    }
  });

  it("declares no social handle that does not exist", () => {
    // POS Canvas has no Twitter/X account. A `site` or `creator` handle would
    // point a card at somebody else's profile.
    const layout = code(read("app/layout.tsx"));

    expect(layout).toContain('card: "summary"');
    expect(layout).not.toContain("site:");
    expect(layout).not.toContain("creator:");
  });

  it("declares no Open Graph image while no approved asset exists", () => {
    // DELIBERATE FENCE, not an oversight. assets/brand/ holds a 376x372 mark, a
    // 424x63 wordmark and a reference board — none is a 1200x630 social card,
    // and compositing one is improvised brand artwork, which
    // assets/brand/README.md reserves as an owner decision. When an approved
    // card exists, this test is the thing that has to be updated on purpose.
    for (const file of METADATA_SOURCES) {
      const source = code(read(file));

      expect(`${file}: og image`).toBe(`${file}: og image`);
      expect(source).not.toContain("images:");
      expect(source).not.toContain("opengraph-image");
    }

    expect(existsSync(join(repoRoot, "app/opengraph-image.png"))).toBe(false);
    expect(existsSync(join(repoRoot, "app/opengraph-image.tsx"))).toBe(false);
  });
});
