// Lane 3 Task 4 — the SEO landing pages, guarded.
//
// Three pages written to rank for "customizable POS", "POS for small business"
// and "no-code POS builder". Each is a place where marketing pressure pushes
// copy past what the product does, so these guards cover four things:
//
//   1. SET      exactly the approved pages exist, with self-canonical,
//               indexable metadata, listed once in the sitemap;
//   2. SHAPE    one H1, no skipped heading level, real landmarks, no client JS;
//   3. TRUTH    no page attributes an unreleased capability to POS Canvas,
//               mentions offline selling or printing, or invents social proof;
//   4. PLACE    the pages are distinct from each other and from the homepage,
//               every link resolves, and the rest of the site is untouched.
//
// THE TRUTH CHECK REUSES THE TASK 3C PRINCIPLE, ADAPTED. Learn bans ATTRIBUTING
// an unreleased capability to POS Canvas, not the vocabulary, and a Learn
// sentence only counts as a claim when it names the product. On a landing page
// EVERY sentence speaks for the product, so the subject is implicit: a
// capability term may appear only in a sentence that denies it. "It doesn't
// scan barcodes" is allowed and useful; "Scan barcodes at checkout" is not.
//
// Like findFalseCapabilityClaims, this is a sentence-level string check. It
// cannot read, and a denial word anywhere in a sentence makes it stand down.
// It is a floor. HUMAN PRODUCT-TRUTH REVIEW OF THESE PAGES REMAINS REQUIRED.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import sitemap from "@/app/sitemap";
import { templates } from "@/data/templates";
import { learnArticles } from "@/data/learn";
import { BUILDER_CAFE_PRODUCTS } from "@/data/productMedia";
import { PAIRING_TOKEN_TTL_SECONDS } from "@/lib/devicePairing";
import {
  CUSTOMIZABLE_POS_PAGE,
  LANDING_PAGES,
  LANDING_PAGE_PATHS,
  NO_CODE_POS_BUILDER_PAGE,
  POS_FOR_SMALL_BUSINESS_PAGE,
} from "@/lib/landingPages";
import { articlePath, findPublishedArticle, publishedArticles } from "@/lib/learn";
import {
  INDEXABLE_PATHS,
  absoluteUrl,
  buildLandingPageMetadata,
  supportedOperatingSystems,
} from "@/lib/seo";

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

const APPROVED_PATHS = [
  "/customizable-pos",
  "/pos-for-small-business",
  "/no-code-pos-builder",
] as const;

/** Each landing page's route file, and the registry export it must use. */
const PAGE_FILES = [
  { page: CUSTOMIZABLE_POS_PAGE, file: "app/customizable-pos/page.tsx", constant: "CUSTOMIZABLE_POS_PAGE" },
  { page: POS_FOR_SMALL_BUSINESS_PAGE, file: "app/pos-for-small-business/page.tsx", constant: "POS_FOR_SMALL_BUSINESS_PAGE" },
  { page: NO_CODE_POS_BUILDER_PAGE, file: "app/no-code-pos-builder/page.tsx", constant: "NO_CODE_POS_BUILDER_PAGE" },
] as const;

const SHARED_COMPONENTS = [
  "components/seo-landing/LandingClosing.tsx",
  "components/seo-landing/RelatedPages.tsx",
] as const;

/** Components every landing page renders; none may add a second H1. */
const RENDERED_COMPONENTS = [
  ...SHARED_COMPONENTS,
  "components/landing/Navbar.tsx",
  "components/landing/Footer.tsx",
  "components/landing/SectionHeading.tsx",
] as const;

/** Homepage copy a landing page must not repeat sentence for sentence. */
const HOMEPAGE_COPY = [
  "components/landing/Hero.tsx",
  "components/landing/Templates.tsx",
  "components/landing/BusinessTypes.tsx",
  "components/landing/Features.tsx",
  "components/landing/HowItWorks.tsx",
  "components/landing/PlatformAvailability.tsx",
  "components/landing/CTASection.tsx",
  "components/landing/LearnDiscovery.tsx",
] as const;

// ---------------------------------------------------------------------------
// Reading a page the way a visitor does
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&ldquo;": "“",
  "&rdquo;": "”",
  "&amp;": "&",
  "&rarr;": "→",
  "&eacute;": "é",
  "&mdash;": "—",
  "&nbsp;": " ",
};

/**
 * Attributes whose values are never read as prose: class lists, URLs, ids,
 * image hints. Everything else in double quotes (a heading passed as a prop, an
 * array of list items) is visible copy.
 */
const NON_PROSE_ATTRIBUTE =
  /\b(className|href|id|src|sizes|role|tabIndex|key|aria-hidden|aria-labelledby|type|rel|target)=("[^"]*"|\{(?:`[^`]*`|[^{}`]*)\})/g;

/**
 * The prose of a TSX page, as separate fragments.
 *
 * Two sources, because copy lives in two places in these files: JSX text
 * between tags (read only from the rendered part of the component, so a `>`
 * in ordinary code is not mistaken for a tag), and double-quoted strings —
 * headings passed as props and the arrays the page maps into lists. Inline
 * `{expressions}` are removed from text nodes; what is left is what renders
 * around them.
 */
function proseFragments(source: string): string[] {
  const stripped = code(source)
    .replace(/^import[\s\S]*?;$/gm, "")
    .replace(NON_PROSE_ATTRIBUTE, " ");

  const renderStart = stripped.indexOf("return (");
  const rendered = renderStart === -1 ? "" : stripped.slice(renderStart);

  const textNodes = [...rendered.matchAll(/>([^<]*)</g)].map((match) =>
    match[1]
      .replace(/\{[^{}]*\}/g, " ")
      .replace(/\{[^}]*$/, " ")
      .replace(/^[^{]*\}/, " ")
  );

  const strings = [...stripped.matchAll(/"([^"\\]*)"/g)].map((match) => match[1]);

  return [...textNodes, ...strings]
    .map((fragment) =>
      fragment
        .replace(/&[a-z]+;/g, (entity) => ENTITIES[entity] ?? entity)
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter((fragment) => / [a-z]/i.test(fragment) || /^[A-Z][a-z]+$/.test(fragment))
    .filter((fragment) => /[a-z]{2}/i.test(fragment));
}

/** Prose split into sentences; the unit of a claim. */
function sentencesOf(fragments: readonly string[]): string[] {
  return fragments
    .flatMap((fragment) => fragment.split(/(?<=[.!?;])\s+/))
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
}

function words(text: string): string[] {
  return normalise(text).match(/[a-z0-9'-]+/g) ?? [];
}

const pageProse = new Map<string, string[]>(
  PAGE_FILES.map(({ file }) => [file, proseFragments(read(file))])
);

// ---------------------------------------------------------------------------
// The truth rules
// ---------------------------------------------------------------------------

/**
 * Capabilities the released product does not have. On a landing page each may
 * appear ONLY in a sentence that denies it.
 */
const NEEDS_DENIAL: readonly RegExp[] = [
  // Barcodes and workforce are NOT here: see NEVER.
  //
  // Cash management
  /\bregister sessions?\b/,
  /\bcash drawers?\b/,
  /\bcash pickups?\b/,
  /\bsafe drops?\b/,
  // The cash-movement terms, not "paid in cash" or "paid in full".
  /\bpaid[- ](ins?|outs?)\b(?!\s+(cash|full|by|with|advance))/,
  /\bover\/short\b/,
  /\bexpected cash\b/,
  // Age checks
  /\bage verification\b/,
  /\bid checks?\b/,
  /\bverify (a |the )?(customer'?s? )?age\b/,
  // Sale corrections
  /\brefunds?\b/,
  /\bvoids?\b/,
  // Payments
  /\bcard readers?\b/,
  /\b(card|payment) terminals?\b/,
  /\bprocess(es|ing)? (card )?payments?\b/,
  /\bpayment processing\b/,
  /\bintegrated payments?\b/,
  /\btap to pay\b/,
  /\bcontactless\b/,
  /\bstripe\b/,
  /\bsquare\b/,
  /\bpaypal\b/,
  // Platforms
  /\biphone\b/,
  /\bipad\b/,
  /\bios\b/,
  // Arbitrary software and the superseded per-business build
  /\bapp builders?\b/,
  /\bgenerates? (software|apps?|an app)\b/,
  /\bdrag-and-drop\b/,
  /\bvisual programming\b/,
  /\bworkflows?\b/,
  /\bautomations?\b/,
  /\bper-business\b/,
  /\b(separate|custom) apps?\b/,
  /\bapps? (for|per) (each|every) business\b/,
  /\bapks?\b/,
  /\bexe\b/,
];

/** A sentence that contains one of these is a denial, not a claim. */
const DENIAL = /n't\b|\b(not|no|never|nor|cannot)\b/;

/**
 * Never on a landing page, not even denied.
 *
 * OFFLINE: the Task 4 brief rules out presenting offline mode, and a denial
 * would contradict the offline-selling foundation that exists, so the subject is
 * left to the pages that already own it. PRINTING: the 1.2.0 Android app shows
 * a notice instead of printing, so a printing claim is not safe on a page about
 * running the POS. LIQUOR: /liquor-store-pos was not approved, and liquor-
 * specific work is v1.3. The rest is invented proof or pressure.
 */
const NEVER: readonly RegExp[] = [
  /\boffline\b/,
  /\bwithout (a |an )?(internet|connection|network)\b/,
  /\b(connection|network|internet|signal) (drops|goes down|is down|is out)\b/,
  /\bprint(s|ed|ing|er|ers)?\b/,
  /\bliquor\b/,
  /\bunlimited\b/,
  /\d+(\.\d+)?\s?%/,
  /[$£€]\s?\d/,
  /\b\d[\d,]*\+?\s+(businesses|customers|merchants|stores|users|owners|shops)\b/,
  /\btestimonials?\b/,
  /\breviews?\b/,
  /\bratings?\b/,
  /\brated\b/,
  /\bawards?\b/,
  /\btrusted by\b/,
  /#1\b/,
  /\bbest\b/,
  /\bleading\b/,
  /\brevolutionary\b/,
  /\bgame[- ]changing\b/,
  /\bguarantee[ds]?\b/,
  /\broi\b/,
  /\bsave (time|money|\d)/,
  /\blimited time\b/,
  /\bhurry\b/,
  /\bact now\b/,
  /\bfree\b/,
  /\bper month\b/,
  // POS Canvas's OWN pricing, which does not exist. "Product pricing" — what an
  // owner sets in the Builder — is a real feature and stays allowed.
  /\b(our|see|view|compare) pricing\b/,
  /\bpricing (plans?|page|tiers?|options)\b/,
  /\b(subscription|monthly|annual) (plans?|fees?|pricing)\b/,
  /\bplay store\b/,
  /\bgoogle play\b/,
  /\bapp store\b/,
  /\bmicrosoft store\b/,
  /\bthousands of\b/,
  /\bmillions of\b/,
  /\bmost popular\b/,
  /\b(fastest|easiest|simplest)\b/,
  /\byour own app\b/,
  /\bwe (build|generate)\b/,

  // Task 4 human product-truth review — claims found false or overbroad, plus
  // the v1.3-scope absences that must not become evergreen copy. Scoped to
  // these three pages only; general writing elsewhere is not affected.
  //
  // BARCODES AND WORKFORCE: active v1.3 scope. Neither claimed nor denied here —
  // a denial would go stale during this release cycle.
  /\bbarcodes?\b/,
  /\bscan(s|ned|ning|ners?)?\b/,
  /\bemployees?\b/,
  /\bstaff\b/,
  /\bworkforce\b/,
  /\bpin (logins?|codes?)\b/,
  /\bclock(ing)?[- ](in|out)\b/,
  /\btime (clocks?|tracking)\b/,
  /\bshifts?\b/,
  /\bpayroll\b/,
  // TIPS: the Builder has the setting; the released checkout cannot take one.
  /\btip(s|ping|ped)?\b/,
  // STOCK ON THE TILL, AND STOCK ENFORCEMENT. Paired devices hide stock, and
  // how a sale with too little stock is settled depends on how it was
  // recorded, so these pages make neither kind of statement.
  /\bstock\b[^.;]*\b(till|counter|device|checkout)\b/,
  /\b(till|counter|device|checkout)\b[^.;]*\bstock\b/,
  /\b(stock|inventory)\b[^.;]*\b(zero|runs? out|sold out|insufficient|enough|reject(s|ed)?|refus(es|ed)|block(s|ed)?)\b/,
  /\b(out of|insufficient|enough|zero) stock\b/,
  // PUBLISHING STORES THE BUSINESS'S CONFIGURATION, so it is never denied.
  /\b(nothing|no|not|never)\b[^.;]*\b(upload(s|ed)?|stor(es|ed|age))\b/,
  // PUBLISH-ONLY UPDATE WORDING: an already-paired device also needs the
  // update offered and applied.
  /\bbecomes? the version\b/,
  /\bfollowed by a publish\b/,
  /\bpublish(ing)? again rather than\b/,
  // COMPLETENESS: the pages describe the MAIN settings, not every field.
  /\beverything you can (change|customi[sz]e)\b/,
  /\bfull list\b/,
  /\bexactly what you can\b/,
  /\bif a setting isn't listed\b/,
  /\bevery setting\b/,
  /\bthe settings in each builder section\b/,
  // BREADTH: no screen or layout customization, and no promise of a fit.
  /\bhow the screen looks\b/,
  /\baround the way you sell\b/,
  /\buntil it fits\b/,
  /\bexactly the way you want\b/,
  /\b(change|customi[sz]e|choose|pick|switch|design) (the |your )?(layout|screens?)\b/,
];

type Violation = { sentence: string; rule: string };

function findViolations(sentences: readonly string[]): Violation[] {
  const found: Violation[] = [];

  for (const sentence of sentences) {
    const text = normalise(sentence);

    for (const rule of NEVER) {
      if (rule.test(text)) found.push({ sentence, rule: `never ${rule}` });
    }

    if (DENIAL.test(text)) continue;

    for (const rule of NEEDS_DENIAL) {
      if (rule.test(text)) found.push({ sentence, rule: `undenied ${rule}` });
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// 1. SET
// ---------------------------------------------------------------------------

describe("exactly the approved landing pages exist", () => {
  it("the registry holds the three approved paths and nothing else", () => {
    expect([...LANDING_PAGE_PATHS]).toEqual([...APPROVED_PATHS]);
  });

  it("each approved page has its own route file", () => {
    for (const { page, file } of PAGE_FILES) {
      expect(file).toBe(`app${page.path}/page.tsx`);
      expect(existsSync(join(repoRoot, file))).toBe(true);
    }
  });

  it("/liquor-store-pos was not created", () => {
    // Planned in Task 3, NOT approved in Task 4.
    expect(existsSync(join(repoRoot, "app/liquor-store-pos"))).toBe(false);
    expect(LANDING_PAGE_PATHS).not.toContain("/liquor-store-pos");
    expect(sitemap().some((entry) => entry.url.includes("liquor-store-pos"))).toBe(false);
  });

  it("no other top-level page was added alongside them", () => {
    // The complete set of top-level route directories. A new landing page
    // added without approval fails here, not in a search console months later.
    const routes = readdirSync(join(repoRoot, "app"))
      .filter((entry) => statSync(join(repoRoot, "app", entry)).isDirectory())
      .sort();

    expect(routes).toEqual(
      [
        "auth",
        "customizable-pos",
        "dashboard",
        "device",
        "editor",
        "forgot-password",
        "learn",
        "login",
        "no-code-pos-builder",
        "pos-for-small-business",
        "reset-password",
        "runtime",
        "signup",
        "templates",
      ].sort()
    );
  });
});

describe("each landing page has complete, self-canonical, indexable metadata", () => {
  for (const { page, file, constant } of PAGE_FILES) {
    it(`${page.path} builds its metadata from its own registry entry`, () => {
      const source = code(read(file));

      expect(source).toContain(
        `export const metadata: Metadata = buildLandingPageMetadata(${constant});`
      );
      // Nothing may be layered on top of the builder: no robots, no images, no
      // second canonical.
      expect(source.match(/buildLandingPageMetadata\(/g)).toHaveLength(1);
      expect(source).not.toContain("alternates");
      expect(source).not.toContain("robots");
      expect(source).not.toContain("openGraph");
    });

    it(`${page.path} canonicalises to itself on the approved origin`, () => {
      const metadata = buildLandingPageMetadata(page);

      expect(metadata.title).toBe(page.title);
      expect(metadata.description).toBe(page.description);
      expect(metadata.alternates?.canonical).toBe(`${APPROVED_ORIGIN}${page.path}`);
      expect(metadata.alternates?.canonical).toBe(absoluteUrl(page.path));
      expect(metadata.robots).toBeUndefined();
      expect(metadata.other).toBeUndefined();
    });

    it(`${page.path} has a complete Open Graph block and no invented image`, () => {
      const og = buildLandingPageMetadata(page).openGraph as Record<string, unknown>;

      expect(og.title).toBe(page.title);
      expect(og.description).toBe(page.socialDescription);
      expect(og.url).toBe(`${APPROVED_ORIGIN}${page.path}`);
      expect(og.siteName).toBe("POS Canvas");
      expect(og.type).toBe("website");
      expect(og.locale).toBe("en_US");
      expect(og.images).toBeUndefined();
      // The twitter card comes from the root layout, and Next derives its
      // title and description from this block.
      expect(buildLandingPageMetadata(page).twitter).toBeUndefined();
    });
  }

  it("titles, descriptions and social descriptions are all unique", () => {
    const all = LANDING_PAGES.flatMap((page) => [
      page.title,
      page.description,
      page.socialDescription,
    ]).map(normalise);

    expect(new Set(all).size).toBe(all.length);
  });

  it("no landing page reuses a title the site already has", () => {
    for (const page of LANDING_PAGES) {
      const title = normalise(page.title);

      for (const file of [
        "app/page.tsx",
        "app/templates/page.tsx",
        "app/templates/[id]/page.tsx",
        "app/learn/page.tsx",
      ]) {
        expect(`${page.path} vs ${file}`).toBe(`${page.path} vs ${file}`);
        expect(normalise(code(read(file)))).not.toContain(title);
      }
    }
  });

  it("each title names the search intent the page exists for", () => {
    expect(normalise(CUSTOMIZABLE_POS_PAGE.title)).toContain("customizable pos");
    expect(normalise(POS_FOR_SMALL_BUSINESS_PAGE.title)).toMatch(/\bpos\b/);
    expect(normalise(POS_FOR_SMALL_BUSINESS_PAGE.title)).toContain("small");
    expect(normalise(NO_CODE_POS_BUILDER_PAGE.title)).toContain("no-code pos builder");
  });

  it("titles and descriptions fit a search result", () => {
    // Snippet bounds, not a copy target: past these a search engine truncates.
    // The title limit excludes the layout's " · POS Canvas" suffix.
    for (const page of LANDING_PAGES) {
      expect(`${page.path} title`).toBe(`${page.path} title`);
      expect(page.title.length).toBeLessThanOrEqual(60);
      expect(page.description.length).toBeLessThanOrEqual(160);
      expect(page.socialDescription.length).toBeLessThanOrEqual(160);
    }
  });

  it("every landing page is indexable and listed in the sitemap exactly once", () => {
    const urls = sitemap().map((entry) => entry.url);

    for (const page of LANDING_PAGES) {
      expect(`${page.path}`).toBe(page.path);
      expect(INDEXABLE_PATHS).toContain(page.path);
      expect(urls.filter((url) => url === absoluteUrl(page.path))).toHaveLength(1);
    }
  });

  it("existing sitemap entries are preserved", () => {
    const urls = sitemap().map((entry) => entry.url);

    expect(urls).toContain(absoluteUrl("/"));
    expect(urls).toContain(absoluteUrl("/templates"));
    expect(urls).toContain(absoluteUrl("/learn"));
    for (const template of templates) {
      expect(urls).toContain(absoluteUrl(`/templates/${template.id}`));
    }
    for (const article of publishedArticles(learnArticles)) {
      expect(urls).toContain(absoluteUrl(articlePath(article)));
    }
  });
});

// ---------------------------------------------------------------------------
// 2. SHAPE
// ---------------------------------------------------------------------------

describe("each landing page is one well-formed server-rendered document", () => {
  it("the components every page renders contribute no H1 of their own", () => {
    for (const file of RENDERED_COMPONENTS) {
      expect(`${file}`).toBe(file);
      expect(code(read(file))).not.toMatch(/<h1[\s>]/);
    }
  });

  for (const { page, file } of PAGE_FILES) {
    const source = code(read(file));

    it(`${page.path} has exactly one H1`, () => {
      expect(source.match(/<h1[\s>]/g)).toHaveLength(1);
    });

    it(`${page.path} never skips a heading level`, () => {
      // SectionHeading and LandingClosing render an h2; RelatedPages renders an
      // h2 too. Reading them as such gives the real document outline.
      const levels = [
        ...source.matchAll(/<(h[1-6])[\s>]|<(SectionHeading|LandingClosing|RelatedPages)\b/g),
      ].map((match) => (match[1] ? Number(match[1][1]) : 2));

      expect(levels[0]).toBe(1);
      for (let i = 1; i < levels.length; i += 1) {
        expect(`${page.path} heading ${i}: h${levels[i - 1]} -> h${levels[i]}`).toBe(
          `${page.path} heading ${i}: h${levels[i - 1]} -> h${levels[i]}`
        );
        expect(levels[i]).toBeGreaterThanOrEqual(2);
        expect(levels[i]).toBeLessThanOrEqual(levels[i - 1] + 1);
      }
    });

    it(`${page.path} has one main landmark between the header and the footer`, () => {
      expect(source.match(/<main[\s>]/g)).toHaveLength(1);

      const header = source.indexOf("<Navbar />");
      const mainOpen = source.indexOf("<main");
      const mainClose = source.indexOf("</main>");
      const footer = source.indexOf("<Footer />");

      expect(header).toBeGreaterThan(-1);
      expect(header).toBeLessThan(mainOpen);
      expect(mainOpen).toBeLessThan(mainClose);
      expect(mainClose).toBeLessThan(footer);
    });

    it(`${page.path} ships no client JavaScript and no structured data`, () => {
      expect(source).not.toContain("use client");
      expect(source).not.toMatch(/\buse(State|Effect|Reducer|Ref)\b/);
      expect(source).not.toMatch(/\bon[A-Z][a-zA-Z]+=/);
      // No JSON-LD at all: a landing page is not a Product, Offer, FAQ, review
      // or Organization, and inventing one of those is exactly the risk.
      expect(source).not.toContain("ld+json");
      expect(source).not.toContain("dangerouslySetInnerHTML");
      expect(source).not.toContain("@type");
    });

    it(`${page.path} puts no teal text on the mint surface`, () => {
      // Measured, not assumed: brand teal-deep on surface-mint is 4.39:1, under
      // the 4.5:1 minimum for body-size text. Eyebrows, step numbers and links
      // are all teal-deep, so these pages keep them on cream or white. The
      // mint panel and callout they do use hold ink text only (5.98:1 and up).
      expect(source).not.toContain("bg-surface-mint");
    });

    it(`${page.path} loads no image eagerly`, () => {
      // Anything below the hero is lazy by next/image's default; nothing here
      // is allowed to opt out of that.
      expect(source).not.toMatch(/\bpriority\b/);
      expect(source).not.toContain('loading="eager"');
    });
  }

  it("the shared pieces are server components too", () => {
    for (const file of SHARED_COMPONENTS) {
      const source = code(read(file));
      expect(`${file}`).toBe(file);
      expect(source).not.toContain("use client");
      expect(source).not.toMatch(/\buse(State|Effect|Reducer|Ref)\b/);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. TRUTH
// ---------------------------------------------------------------------------

describe("the truth check itself works", () => {
  // Fixtures, so a green run means the detector can see, not that it is blind.
  it("blocks an unreleased capability stated as a fact", () => {
    expect(findViolations(["Scan barcodes at checkout."])).not.toHaveLength(0);
    expect(findViolations(["POS Canvas supports employee PIN login."])).not.toHaveLength(0);
    expect(
      findViolations(["Take card payments through the built-in card reader."])
    ).not.toHaveLength(0);
    expect(findViolations(["Download it for iPhone and Android."])).not.toHaveLength(0);
    expect(findViolations(["Refunds take one tap."])).not.toHaveLength(0);
    expect(findViolations(["Generate an app for your business."])).not.toHaveLength(0);
  });

  it("allows the same vocabulary in a denial", () => {
    expect(findViolations(["POS Canvas doesn’t process card payments or connect to a card reader."])).toEqual([]);
    expect(findViolations(["Refunds and voids aren’t handled in the POS."])).toEqual([]);
    expect(findViolations(["There is no app for iPhone or iPad."])).toEqual([]);
  });

  it("blocks the claims the human review corrected, even when denied", () => {
    for (const sentence of [
      // v1.3-scope absences
      "It doesn’t scan barcodes; products are picked on screen.",
      "There are no individual staff logins and no time tracking.",
      // tips
      "Turn tips on or off.",
      // stock on the till and stock enforcement
      "A denser grid of products that shows stock at the till.",
      "A tracked product can’t be added to a sale once its stock reaches zero.",
      "Paired devices block a product when it is out of stock.",
      "Tracked inventory is checked when a sale is completed, and the sale is rejected if there isn’t enough stock.",
      // publishing
      "Nothing is compiled, packaged or uploaded for your business.",
      "Your saved configuration becomes the version your devices use.",
      "A new price or product is an edit in the Builder followed by a publish.",
      // completeness and breadth
      "Everything you can customize",
      "Want the full list of settings?",
      "Here is exactly what you can change today.",
      "If a setting isn’t listed on this page, it isn’t something you can customize today.",
      "Customize your point of sale around the way you sell",
      "…what the receipt says and how the screen looks.",
      "Open it in the Builder and change it until it fits.",
      "Change the layout to suit your shop.",
    ]) {
      expect(sentence).toBe(sentence);
      expect(findViolations(sentencesOf([sentence]))).not.toHaveLength(0);
    }
  });

  it("blocks offline, printing and invented proof even when denied", () => {
    expect(findViolations(["Keep selling offline."])).not.toHaveLength(0);
    expect(findViolations(["It does not work offline."])).not.toHaveLength(0);
    expect(findViolations(["Print a receipt for every sale."])).not.toHaveLength(0);
    expect(findViolations(["Trusted by 2,000 businesses."])).not.toHaveLength(0);
    expect(findViolations(["Rated 4.9 by owners."])).not.toHaveLength(0);
    expect(findViolations(["Cut checkout time by 30%."])).not.toHaveLength(0);
    expect(findViolations(["The best POS for cafés."])).not.toHaveLength(0);
    expect(findViolations(["See our pricing plans."])).not.toHaveLength(0);
    expect(findViolations(["Start with a monthly plan."])).not.toHaveLength(0);
    // Product pricing is a Builder feature, not a commercial claim.
    expect(findViolations(["Customize the products, pricing and branding in your point of sale"])).toEqual([]);
  });

  it("reads JSX copy, props and list arrays as prose", () => {
    const fixture = [
      'const ITEMS = ["Ring up sales by scanning barcodes."];',
      "export default function Page() {",
      "  return (",
      '    <main><SectionHeading title="Works when the network drops" />',
      "      <p>Accept payments with tap to pay{\" \"}<Link href=\"/x\">now</Link></p>",
      "    </main>",
      "  );",
      "}",
    ].join("\n");
    const found = findViolations(sentencesOf(proseFragments(fixture)));

    expect(found.map((v) => v.sentence)).toEqual(
      expect.arrayContaining([
        "Ring up sales by scanning barcodes.",
        "Works when the network drops",
        "Accept payments with tap to pay",
      ])
    );
  });
});

describe("no landing page claims what the released product does not do", () => {
  for (const { page, file } of PAGE_FILES) {
    it(`${page.path} attributes no unreleased capability and invents nothing`, () => {
      const prose = pageProse.get(file) ?? [];

      // The extraction must actually have found the page's copy.
      expect(prose.length).toBeGreaterThan(20);
      expect(findViolations(sentencesOf(prose))).toEqual([]);
    });
  }

  it("the shared pieces and the registry make no claim either", () => {
    const fragments = [
      ...SHARED_COMPONENTS.flatMap((file) => proseFragments(read(file))),
      ...LANDING_PAGES.flatMap((page) => [
        page.title,
        page.description,
        page.socialDescription,
      ]),
    ];

    expect(findViolations(sentencesOf(fragments))).toEqual([]);
  });

  it("every platform a page names is one the release model ships", () => {
    const shipped = supportedOperatingSystems();

    expect(shipped).toContain("Android");
    expect(shipped).toContain("Windows");
  });

  it("the device requirements come from the release model, not from copy", () => {
    const source = code(read("app/pos-for-small-business/page.tsx"));

    expect(source).toContain("getPlatformDownloads()");
    expect(source).toContain("isDownloadable");
    expect(source).not.toMatch(/Android \d/);
    expect(source).not.toMatch(/Windows \d/);
  });

  it("the stated pairing-code lifetime is the real one", () => {
    const prose = (pageProse.get("app/pos-for-small-business/page.tsx") ?? []).join(" ");

    expect(prose).toContain("expires after 10 minutes");
    expect(PAIRING_TOKEN_TTL_SECONDS).toBe(10 * 60);
  });

  it("the no-code page keeps its scope statement and its denial of generation", () => {
    const prose = normalise((pageProse.get("app/no-code-pos-builder/page.tsx") ?? []).join(" "));

    // The positive controls: absence of a lie is not the presence of the truth.
    expect(prose).toContain("without writing code");
    expect(prose).toContain("isn't a general-purpose app builder");
    expect(prose).toContain("doesn't generate software");
    expect(prose).toContain("no separate app is built for each business");
    // What publishing DOES do is said, and only the app build is denied.
    expect(prose).toContain("no separate app is compiled or packaged for your business");
    expect(prose).toContain("publishing stores your project's configuration");
  });

  it("every sentence about updating names the device-side apply step", () => {
    // Publishing alone does not move an already-paired device: the owner offers
    // the update and the device applies it. A fragment that talks about
    // changing things after setup must say so.
    const UPDATE = /\b(publish(ing)? again|chang(e|es|ing) (something|your menu)|new price or product|new configuration)\b/;
    let checked = 0;

    for (const { file } of PAGE_FILES) {
      for (const fragment of pageProse.get(file) ?? []) {
        const text = normalise(fragment);
        if (!UPDATE.test(text)) continue;
        checked += 1;
        expect(`${file}: ${fragment}`).toBe(`${file}: ${fragment}`);
        expect(text).toMatch(/\bappl(y|ies|ied|ying)\b/);
      }
    }

    // The customizable page's update card, and three places on the no-code page.
    expect(checked).toBeGreaterThanOrEqual(4);

    const publishRow = code(read("app/no-code-pos-builder/page.tsx")).match(
      /action: "Press Publish",\s*detail:\s*"([^"]+)"/
    );
    expect(publishRow).not.toBeNull();
    expect(normalise(publishRow?.[1] ?? "")).toMatch(/\boffer\b/);
    expect(normalise(publishRow?.[1] ?? "")).toMatch(/\bapply\b/);
  });

  it("no call to action promises to open a template", () => {
    // Every template link on these pages goes to the gallery or a template's
    // detail page; opening one in the Builder takes a choice and a sign-in.
    for (const { file } of PAGE_FILES) {
      const source = code(read(file));
      expect(`${file}`).toBe(file);
      expect(source).not.toMatch(/>\s*Open a template\s*</i);
      expect(source).not.toMatch(/label:\s*"Open a template"/i);
    }
  });

  it("the small-business fit check keeps its released limitations", () => {
    const prose = normalise(
      (pageProse.get("app/pos-for-small-business/page.tsx") ?? []).join(" ")
    );

    expect(prose).toContain("doesn't process card payments or connect to a card reader");
    expect(prose).toContain("refunds and voids aren't handled in the pos");
    expect(prose).toContain("there is no app for iphone or ipad");
    expect(prose).toContain("record restocks");
  });

  it("card payments are described as recorded, never as processed", () => {
    for (const file of [
      "app/customizable-pos/page.tsx",
      "app/pos-for-small-business/page.tsx",
    ]) {
      const prose = normalise((pageProse.get(file) ?? []).join(" "));
      expect(`${file}`).toBe(file);
      expect(prose).toMatch(/record[a-z]* (whether|cash)/);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. PLACE
// ---------------------------------------------------------------------------

describe("the three pages answer different questions", () => {
  const MIN_SHARED_WORDS = 6;

  function longSentences(fragments: readonly string[]): Set<string> {
    return new Set(
      sentencesOf(fragments)
        .map((sentence) => words(sentence).join(" "))
        .filter((sentence) => sentence.split(" ").length >= MIN_SHARED_WORDS)
    );
  }

  function trigrams(fragments: readonly string[]): Set<string> {
    const tokens = words(fragments.join(" "));
    const grams = new Set<string>();
    for (let i = 0; i + 2 < tokens.length; i += 1) {
      grams.add(tokens.slice(i, i + 3).join(" "));
    }
    return grams;
  }

  function jaccard(a: Set<string>, b: Set<string>): number {
    const shared = [...a].filter((gram) => b.has(gram)).length;
    return shared / (a.size + b.size - shared);
  }

  const files = PAGE_FILES.map(({ file }) => file);
  const pairs = files.flatMap((a, i) => files.slice(i + 1).map((b) => [a, b] as const));

  it("each page has its own H1 and its own section headings", () => {
    const headings = PAGE_FILES.map(({ file }) => {
      const source = code(read(file));
      return [
        ...source.matchAll(/<h[12][^>]*>\s*([^<{]+?)\s*</g),
        ...source.matchAll(/(?:<SectionHeading|<LandingClosing)[\s\S]*?title="([^"]+)"/g),
      ].map((match) => normalise(match[1].replace(/\s+/g, " ")));
    });

    const all = headings.flat();
    expect(all.length).toBeGreaterThan(12);
    expect(new Set(all).size).toBe(all.length);
  });

  for (const [a, b] of pairs) {
    it(`${a} and ${b} share no sentence`, () => {
      const left = longSentences(pageProse.get(a) ?? []);
      const right = longSentences(pageProse.get(b) ?? []);

      expect([...left].filter((sentence) => right.has(sentence))).toEqual([]);
    });

    it(`${a} and ${b} are not rewordings of one page`, () => {
      // Word-trigram overlap. A cloned page with swapped nouns scores far above
      // this; three pages about one product will always share some phrasing.
      const score = jaccard(
        trigrams(pageProse.get(a) ?? []),
        trigrams(pageProse.get(b) ?? [])
      );

      expect(score).toBeLessThan(0.08);
    });
  }

  // Interface guidance that is MEANT to read the same wherever the same
  // component appears. Copy, not chrome, is what must not repeat.
  const SHARED_UI_HINTS = new Set(["scroll sideways to see the whole screenshot"]);

  it("no landing page repeats a homepage sentence", () => {
    const homepage = longSentences(HOMEPAGE_COPY.flatMap((file) => proseFragments(read(file))));
    expect(homepage.size).toBeGreaterThan(10);

    for (const file of files) {
      const repeated = [...longSentences(pageProse.get(file) ?? [])].filter(
        (sentence) => homepage.has(sentence) && !SHARED_UI_HINTS.has(sentence)
      );
      expect(`${file}: ${repeated.join(" | ")}`).toBe(`${file}: `);
    }
  });
});

describe("every link on a landing page goes somewhere real", () => {
  const STATIC_ROUTES = new Set<string>([
    "/",
    "/templates",
    "/learn",
    "/signup",
    "/login",
    ...LANDING_PAGE_PATHS,
  ]);

  /** href expressions that resolve by construction. Anything else must be added here on purpose. */
  const RESOLVED_EXPRESSIONS = new Set([
    "CUSTOMIZABLE_POS_PAGE.path",
    "POS_FOR_SMALL_BUSINESS_PAGE.path",
    "NO_CODE_POS_BUILDER_PAGE.path",
    "`/templates/${template.id}`",
    "articlePath(oneAppArticle)",
    "primary.href",
    "secondary.href",
    "page.href",
  ]);

  function routeFileFor(path: string): string {
    return path === "/" ? "app/page.tsx" : `app${path}/page.tsx`;
  }

  for (const file of [...PAGE_FILES.map(({ file }) => file), ...SHARED_COMPONENTS]) {
    const source = code(read(file));

    it(`${file}: every literal destination resolves`, () => {
      const literals = [
        ...source.matchAll(/\bhref="([^"]*)"/g),
        ...source.matchAll(/\bhref: "([^"]*)"/g),
      ].map((match) => match[1]);

      for (const href of literals) {
        expect(`${file} -> ${href}`).toBe(`${file} -> ${href}`);

        if (href.startsWith("#")) {
          // An in-page anchor must name an element on the same page.
          expect(source).toContain(`id="${href.slice(1)}"`);
          continue;
        }

        expect(href).not.toMatch(/^https?:/);
        expect(STATIC_ROUTES.has(href)).toBe(true);
        expect(existsSync(join(repoRoot, routeFileFor(href)))).toBe(true);
      }
    });

    it(`${file}: every computed destination is one that resolves by construction`, () => {
      // A template literal, or a plain expression with no braces of its own.
      const expressions = [...source.matchAll(/\bhref=\{(`[^`]*`|[^{}`]*)\}/g)].map((match) =>
        match[1].trim()
      );

      expect(expressions.length).toBeGreaterThan(0);

      for (const expression of expressions) {
        expect(`${file} -> {${expression}}`).toBe(`${file} -> {${expression}}`);
        expect(RESOLVED_EXPRESSIONS.has(expression)).toBe(true);
      }
    });

    it(`${file}: link text says where it goes`, () => {
      expect(normalise(source)).not.toMatch(/>\s*(click here|here|learn more|read more|more)\s*</);
    });
  }

  it("the registry-derived destinations exist", () => {
    for (const page of LANDING_PAGES) {
      expect(existsSync(join(repoRoot, routeFileFor(page.path)))).toBe(true);
    }
    expect(existsSync(join(repoRoot, "app/templates/[id]/page.tsx"))).toBe(true);
    expect(templates.length).toBeGreaterThan(0);
  });

  it("the Learn article the no-code page cites is published", () => {
    // Otherwise the link silently disappears from the page.
    const source = code(read("app/no-code-pos-builder/page.tsx"));
    const slug = source.match(/ONE_APP_ARTICLE_SLUG = "([^"]+)"/)?.[1] ?? "";
    const article = findPublishedArticle(learnArticles, slug);

    expect(article).not.toBeNull();
    expect(existsSync(join(repoRoot, "app/learn/[slug]/page.tsx"))).toBe(true);
  });

  it("each page links to at least one sibling and to the templates", () => {
    for (const { page, file } of PAGE_FILES) {
      const source = code(read(file));
      const siblings = PAGE_FILES.filter((other) => other.page !== page).map(
        (other) => `${other.constant}.path`
      );

      expect(`${page.path}`).toBe(page.path);
      expect(siblings.some((sibling) => source.includes(sibling))).toBe(true);
      expect(source).toContain('href="/templates"');
      // A page linking to itself is noise.
      expect(source).not.toContain(`href: ${PAGE_FILES.find((p) => p.page === page)?.constant}.path`);
    }
  });
});

describe("the landing pages are discoverable from the existing site", () => {
  // Task 4 correction. A page reachable only through the sitemap and its own
  // siblings is an orphan: a crawler weighs it as unimportant, and a visitor
  // can never find it. The approved way in is ONE contextual link from the
  // template gallery to /pos-for-small-business, which links on to the other
  // two.

  const LANDING_CONSTANTS: Record<string, string> = Object.fromEntries(
    PAGE_FILES.map(({ constant, page }) => [constant, page.path])
  );

  /**
   * A page's source plus every component it renders, followed through
   * `@/components/...` imports — so the shared header and footer count as part
   * of every page that uses them.
   */
  function bundle(file: string, seen = new Set<string>()): string {
    if (seen.has(file) || !existsSync(join(repoRoot, file))) return "";
    seen.add(file);
    const source = code(read(file));
    const imports = [...source.matchAll(/from "@\/(components\/[^"]+)"/g)].map(
      (match) => `${match[1]}.tsx`
    );
    return [source, ...imports.map((dependency) => bundle(dependency, seen))].join("\n");
  }

  /** The site paths a source links to, literal or through the landing registry. */
  function linkTargets(source: string): Set<string> {
    const targets = new Set<string>();
    for (const match of source.matchAll(/\bhref(?:=|:\s*)"(\/[^"#?]*)/g)) targets.add(match[1]);
    for (const match of source.matchAll(/\bhref(?:=\{|:\s*)([A-Z_]+_PAGE)\.path\b/g)) {
      if (match[1] in LANDING_CONSTANTS) targets.add(LANDING_CONSTANTS[match[1]]);
    }
    return targets;
  }

  /** Existing public, indexable pages a crawler or visitor already reaches. */
  const EXISTING_ENTRY_PAGES: Record<string, string> = {
    "/": "app/page.tsx",
    "/templates": "app/templates/page.tsx",
    "/learn": "app/learn/page.tsx",
  };

  const LANDING_FILES: Record<string, string> = Object.fromEntries(
    PAGE_FILES.map(({ page, file }) => [page.path, file])
  );

  it("the template gallery links to /pos-for-small-business, and to no other landing page", () => {
    const gallery = bundle("app/templates/page.tsx");

    expect(gallery.match(/href=\{POS_FOR_SMALL_BUSINESS_PAGE\.path\}/g)).toHaveLength(1);
    expect(gallery).toMatch(/<Link\s+href=\{POS_FOR_SMALL_BUSINESS_PAGE\.path\}/);
    expect(gallery).not.toContain("CUSTOMIZABLE_POS_PAGE");
    expect(gallery).not.toContain("NO_CODE_POS_BUILDER_PAGE");
    for (const slug of ["customizable-pos", "no-code-pos-builder"]) {
      expect(gallery).not.toContain(slug);
    }

    // And the gallery is itself a page a crawler is told about.
    expect(INDEXABLE_PATHS).toContain("/templates");
    expect(sitemap().map((entry) => entry.url)).toContain(absoluteUrl("/templates"));
  });

  it("/pos-for-small-business links on to both other landing pages", () => {
    const targets = linkTargets(bundle(`app${POS_FOR_SMALL_BUSINESS_PAGE.path}/page.tsx`));

    expect(targets.size).toBeGreaterThan(0);

    expect(targets.has(CUSTOMIZABLE_POS_PAGE.path)).toBe(true);
    expect(targets.has(NO_CODE_POS_BUILDER_PAGE.path)).toBe(true);
  });

  it("every landing page is reachable from an existing public page", () => {
    // Breadth-first over the static link graph, starting ONLY from pages that
    // existed before Task 4. The landing pages' links to each other count once
    // one of them has been reached from outside — never as the way in.
    const reached = new Set<string>();
    const queue: string[] = [];

    for (const file of Object.values(EXISTING_ENTRY_PAGES)) {
      for (const target of linkTargets(bundle(file))) {
        if (target in LANDING_FILES && !reached.has(target)) {
          reached.add(target);
          queue.push(target);
        }
      }
    }

    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const target of linkTargets(bundle(LANDING_FILES[current]))) {
        if (target in LANDING_FILES && !reached.has(target)) {
          reached.add(target);
          queue.push(target);
        }
      }
    }

    expect([...reached].sort()).toEqual([...LANDING_PAGE_PATHS].sort());
  });

  it("no public source links to the unapproved /liquor-store-pos", () => {
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(repoRoot, dir))) {
        const path = `${dir}/${entry}`;
        if (statSync(join(repoRoot, path)).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) sources.push(path);
      }
    };
    walk("app");
    walk("components");

    expect(sources.length).toBeGreaterThan(20);
    for (const file of sources) {
      expect(`${file}`).toBe(file);
      expect(code(read(file))).not.toContain("liquor-store-pos");
    }
  });
});

describe("the screenshot is reused with its provenance intact", () => {
  it("the page that shows it renders every field from the media record", () => {
    const source = code(read("app/customizable-pos/page.tsx"));

    expect(source).toContain("src={BUILDER_CAFE_PRODUCTS.src}");
    expect(source).toContain("alt={BUILDER_CAFE_PRODUCTS.alt}");
    expect(source).toContain("width={BUILDER_CAFE_PRODUCTS.width}");
    expect(source).toContain("height={BUILDER_CAFE_PRODUCTS.height}");
    expect(source).toContain("{BUILDER_CAFE_PRODUCTS.caption}");
    expect(BUILDER_CAFE_PRODUCTS.provenance).toBe("real-product-screenshot");
  });

  it("it keeps the narrow-screen treatment: a named, focusable scroll viewport", () => {
    const source = code(read("app/customizable-pos/page.tsx"));

    expect(source).toContain('className="pc-screenshot-viewport pc-focusable"');
    expect(source).toContain("tabIndex={0}");
    expect(source).toContain('aria-labelledby="customizable-screenshot-caption"');
    expect(source).toContain('id="customizable-screenshot-caption"');
    expect(source).toContain("pc-screenshot-viewport__image");
    expect(source).toContain('sizes="(min-width: 1080px) 1000px, (min-width: 1024px) 94vw, 992px"');
  });

  it("no landing page types a media path or ships new media", () => {
    for (const { file } of PAGE_FILES) {
      expect(`${file}`).toBe(file);
      expect(code(read(file))).not.toContain("/screenshots/");
    }

    expect(readdirSync(join(repoRoot, "public/screenshots"))).toEqual([
      "builder-cafe-products.webp",
    ]);
  });
});

describe("the rest of the site is left as it was", () => {
  const LANDING_SLUGS = LANDING_PAGE_PATHS.map((path) => path.slice(1));

  it("the header gains no landing page link (a navigation change needs approval)", () => {
    const navbar = code(read("components/landing/Navbar.tsx"));

    for (const slug of LANDING_SLUGS) {
      expect(`Navbar: ${slug}`).toBe(`Navbar: ${slug}`);
      expect(navbar).not.toContain(slug);
      expect(navbar).not.toContain("_PAGE");
    }
  });

  it("the footer is not turned into a landing page link list", () => {
    const footer = code(read("components/landing/Footer.tsx"));

    for (const slug of LANDING_SLUGS) {
      expect(`Footer: ${slug}`).toBe(`Footer: ${slug}`);
      expect(footer).not.toContain(slug);
    }
  });

  it("the homepage sections are unchanged by this task", () => {
    for (const file of ["app/page.tsx", ...HOMEPAGE_COPY]) {
      const source = code(read(file));
      expect(`${file}`).toBe(file);
      for (const slug of LANDING_SLUGS) {
        expect(source).not.toContain(slug);
      }
      expect(source).not.toContain("landingPages");
    }
  });

  it("Learn does not treat the landing pages as articles", () => {
    for (const file of ["lib/learn.ts", "data/learn.ts", "app/learn/page.tsx", "app/learn/[slug]/page.tsx"]) {
      const source = code(read(file));
      expect(`${file}`).toBe(file);
      for (const slug of LANDING_SLUGS) {
        expect(source).not.toContain(slug);
      }
    }

    for (const article of learnArticles) {
      expect(LANDING_SLUGS).not.toContain(article.slug);
    }
  });
});
