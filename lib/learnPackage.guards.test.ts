// POS Canvas Learn — the editorial package contract.
//
// Task 3B guarded the library. This guards the BOUNDARY: what an editorial
// workflow may hand the repository, what the repository refuses, and what it
// derives rather than asking anyone to retype.
//
// Everything here is exercised against FIXTURES rather than public content.
// Proving that an unreleased-feature article is refused must not require
// publishing one, and proving the homepage scales must not require inventing
// filler articles — which is the behaviour the editorial rules exist to
// prevent in the first place.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { learnArticles } from "@/data/learn";
import { buildArticleJsonLd } from "@/lib/seo";
import {
  CONTENT_TYPE_LABELS,
  PUBLICLY_ELIGIBLE_TRUTH,
  TOPICS,
  articleOgDescription,
  articleOgTitle,
  articlePath,
  articleSeoDescription,
  articleSeoTitle,
  findFalseCapabilityClaims,
  isPubliclyVisible,
  isTruthEligible,
  publishedArticles,
  validateArticle,
  validateLibrary,
  type ArticleImage,
  type LearnArticle,
  type ProductTruth,
} from "@/lib/learn";

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

/** A well-formed package. Overridden per test to introduce exactly one fault. */
function pkg(overrides: Partial<LearnArticle> = {}): LearnArticle {
  return {
    slug: "fixture-article",
    title: "Fixture article",
    deck: "A fixture used by the contract guards.",
    topic: "pos-basics",
    contentType: "article",
    status: "published",
    publishedAt: "2026-02-01",
    body: [{ kind: "paragraph", text: "Body." }],
    productTruth: "general-education",
    ...overrides,
  };
}

function image(overrides: Partial<ArticleImage> = {}): ArticleImage {
  return {
    src: "/fixture.png",
    alt: "A fixture image",
    width: 1200,
    height: 800,
    provenance: "illustration",
    ...overrides,
  };
}

const problems = (a: LearnArticle, library: LearnArticle[] = [a]) =>
  validateArticle(a, library).map((i) => `${i.field}: ${i.problem}`);

// ---------------------------------------------------------------------------
// The library itself
// ---------------------------------------------------------------------------

describe("the shipped library satisfies its own contract", () => {
  it("validates clean", () => {
    expect(validateLibrary(learnArticles)).toEqual([]);
  });

  it("the pilot is classified truthfully", () => {
    const pilot = learnArticles.find((a) => a.slug === "one-app-not-one-per-business");

    // It is ABOUT POS Canvas and every claim is released behaviour, so it is
    // shipped-product rather than general-education.
    expect(pilot?.productTruth).toBe("shipped-product");
    expect(isPubliclyVisible(pilot!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Truth classes
// ---------------------------------------------------------------------------

describe("publication eligibility follows the corrected truth model", () => {
  const cases: [ProductTruth, boolean][] = [
    ["shipped-product", true],
    ["general-education", true],
    ["implemented-not-released", false],
    ["planned", false],
  ];

  for (const [truth, eligible] of cases) {
    it(`${truth} is ${eligible ? "" : "not "}publicly eligible`, () => {
      expect(isTruthEligible(pkg({ productTruth: truth }))).toBe(eligible);
    });
  }

  it("the eligible set is exactly the two approved classes", () => {
    expect([...PUBLICLY_ELIGIBLE_TRUTH].sort()).toEqual(
      ["general-education", "shipped-product"].sort()
    );
  });

  it("a general-education article publishes even though POS Canvas lacks the feature", () => {
    // THE TASK 3C CORRECTION, stated as behaviour: an article teaching stock
    // counts is not a claim that POS Canvas counts stock.
    const teaching = pkg({
      slug: "counting-stock",
      title: "How small shops count stock",
      productTruth: "general-education",
      body: [{ kind: "paragraph", text: "Counting stock by hand, and why it drifts." }],
    });

    expect(isPubliclyVisible(teaching)).toBe(true);
    expect(problems(teaching)).toEqual([]);
  });

  it("publishing an ineligible class is a validation failure, not a silent drop", () => {
    // Both must be true: the article is invisible AND the package is reported
    // as wrong. Silent correction would hide an editorial mistake.
    const leaked = pkg({ status: "published", productTruth: "implemented-not-released" });

    expect(isPubliclyVisible(leaked)).toBe(false);
    expect(problems(leaked).join(" ")).toContain("cannot be published");
  });

  it("a DRAFT about unreleased work is legitimate and is not a failure", () => {
    // The workflow must be able to hold work in progress without the build
    // complaining. Only claiming PUBLIC visibility for it is an error.
    const draft = pkg({ status: "draft", productTruth: "implemented-not-released" });

    expect(problems(draft)).toEqual([]);
    expect(isPubliclyVisible(draft)).toBe(false);
  });

  it("eligibility depends on nothing but the class", () => {
    // Not length, not sources, not media, not how many articles exist.
    const bare = pkg({ sources: undefined, related: undefined, hero: undefined });
    expect(isTruthEligible(bare)).toBe(true);
    expect(problems(bare)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// False capability claims — terminology vs attribution
// ---------------------------------------------------------------------------

describe("general education may discuss what POS Canvas does not do", () => {
  /** An article whose single paragraph is the sentence under test. */
  const saying = (text: string, overrides: Partial<LearnArticle> = {}) =>
    pkg({
      productTruth: "general-education",
      deck: "A fixture sentence.",
      body: [{ kind: "paragraph", text }],
      ...overrides,
    });

  const ALLOWED = [
    "Barcode scanning can help retail stores enter products quickly.",
    "Many POS systems use employee PINs to identify staff.",
    "Age verification is an important consideration for some regulated retailers.",
    "A cash drawer count at close of trade is standard practice in most shops.",
    "Time clock software is how many small employers record hours.",
    "A register session groups the sales taken on one till between counts.",
  ];

  for (const sentence of ALLOWED) {
    it(`allows: ${sentence.slice(0, 52)}…`, () => {
      // THE CORRECTION. None of these attributes anything to POS Canvas, so
      // none is a false product claim — they are the subject matter Learn
      // exists to write about.
      const article = saying(sentence);

      expect(findFalseCapabilityClaims(article)).toEqual([]);
      expect(problems(article)).toEqual([]);
      expect(isPubliclyVisible(article)).toBe(true);
    });
  }

  const BLOCKED: [string, string][] = [
    ["POS Canvas includes barcode scanning.", "barcode scanning"],
    ["POS Canvas supports employee PIN login.", "employee pin"],
    ["POS Canvas provides age verification.", "age verification"],
    ["POS Canvas has a built-in time clock.", "time clock"],
    ["With POS Canvas you can open a register session at the start of a shift.", "register session"],
  ];

  for (const [sentence, capability] of BLOCKED) {
    it(`blocks: ${sentence.slice(0, 52)}…`, () => {
      const article = saying(sentence);
      const claims = findFalseCapabilityClaims(article);

      expect(claims.map((c) => c.capability)).toContain(capability);
      // And it is a validation failure, not just a detector result.
      expect(problems(article).join(" ")).toContain("which is not released");
    });
  }

  it("allows a truthful denial", () => {
    // "POS Canvas" and "barcode" in one sentence is not automatically a claim.
    // A negation makes the detector stand down, because blocking this true and
    // useful sentence would be worse than the construction it lets through.
    for (const sentence of [
      "POS Canvas does not currently provide barcode scanning.",
      "POS Canvas has no employee PIN login today.",
      "You cannot scan a barcode with POS Canvas yet.",
    ]) {
      const article = saying(sentence);
      expect(`denial: ${sentence}`).toBe(`denial: ${sentence}`);
      expect(findFalseCapabilityClaims(article)).toEqual([]);
      expect(problems(article)).toEqual([]);
    }
  });

  it("holds shipped-product articles to the same rule", () => {
    // The class widens what SUBJECTS may be published. It never widens what may
    // be claimed about the product.
    const article = saying("POS Canvas includes barcode scanning.", {
      productTruth: "shipped-product",
    });

    expect(findFalseCapabilityClaims(article)).toHaveLength(1);
    expect(problems(article).join(" ")).toContain("which is not released");
  });

  it("checks every surface a reader reads, not only paragraphs", () => {
    const inHeading = pkg({
      productTruth: "general-education",
      body: [
        { kind: "heading", level: 2, id: "h", text: "POS Canvas includes barcode scanning" },
      ],
    });
    const inList = pkg({
      productTruth: "general-education",
      body: [{ kind: "list", items: ["POS Canvas supports employee PIN login."] }],
    });
    const inCallout = pkg({
      productTruth: "general-education",
      body: [
        { kind: "callout", tone: "note", text: "POS Canvas provides age verification." },
      ],
    });

    for (const article of [inHeading, inList, inCallout]) {
      expect(findFalseCapabilityClaims(article).length).toBeGreaterThan(0);
    }

    // The title and deck too.
    expect(
      findFalseCapabilityClaims(pkg({ title: "POS Canvas includes barcode scanning" }))
    ).toHaveLength(1);
  });

  it("does not police a DRAFT's prose", () => {
    // A draft is work in progress; publication is what makes a claim. The
    // detector still reports, but validation does not fail the package.
    const draft = saying("POS Canvas includes barcode scanning.", { status: "draft" });

    expect(findFalseCapabilityClaims(draft)).toHaveLength(1);
    expect(problems(draft)).toEqual([]);
  });

  it("states its own limits, so a green test is not mistaken for approval", () => {
    // The guard that keeps the human stage honest: the code must say, in
    // writing, that it cannot understand prose and that product-truth review
    // remains required.
    // Comment markers AND whitespace normalised: these sentences are wrapped
    // across lines with `*` and `//` prefixes, so a naive collapse leaves
    // "a floor, not a * ceiling". A guard that breaks when a comment is
    // rewrapped teaches people to delete the guard rather than keep the
    // comment.
    const prose = (text: string) =>
      text
        .replace(/^\s*(?:\/\/|\*)\s?/gm, "")
        .replace(/\s+/g, " ");

    const source = prose(read("lib/learn.ts"));

    expect(source).toContain(
      "PRODUCT-TRUTH REVIEW BY A HUMAN REMAINS A REQUIRED EDITORIAL STAGE"
    );
    expect(source).toContain("It is a floor, not a ceiling");
    expect(source).toContain(
      "product-truth review by a human remains a required editorial stage"
    );

    const contract = read("docs/LEARN_EDITORIAL_CONTRACT.md");
    expect(contract).toContain("PRODUCT-TRUTH REVIEW");
  });
});

// ---------------------------------------------------------------------------
// Publication dates
// ---------------------------------------------------------------------------

describe("a publication date records a publication, not a schedule", () => {
  it("a draft needs no publication date", () => {
    const draft = pkg({ status: "draft", publishedAt: undefined });

    expect(problems(draft)).toEqual([]);
    expect(isPubliclyVisible(draft)).toBe(false);
  });

  it("a published article without one is a failure", () => {
    const published = pkg({ status: "published", publishedAt: undefined });

    expect(problems(published).join(" ")).toContain("required once an article is published");
  });

  it("a published article with a valid date passes", () => {
    expect(problems(pkg({ status: "published", publishedAt: "2026-03-04" }))).toEqual([]);
  });

  it("rejects an update earlier than publication", () => {
    expect(
      problems(pkg({ publishedAt: "2026-03-04", updatedAt: "2026-03-01" })).join(" ")
    ).toContain("cannot be before publishedAt");
  });

  it("rejects an update with no publication at all", () => {
    // "Updated" before it was ever published is not a state that means anything.
    expect(
      problems(pkg({ status: "draft", publishedAt: undefined, updatedAt: "2026-03-01" })).join(" ")
    ).toContain("cannot exist without a publishedAt");
  });

  it("derives the date from nothing — there is no schedule to derive it from", () => {
    // A scheduled editorial opportunity is not a publication event, and the
    // repository holds no scheduling metadata at all to confuse it with one.
    const source = code(read("lib/learn.ts"));

    for (const banned of ["Date.now", "new Date()", "createdAt", "scheduledAt", "runAt", "generatedAt"]) {
      expect(`learn.ts: ${banned}`).toBe(`learn.ts: ${banned}`);
      expect(source).not.toContain(banned);
    }
  });

  it("omits datePublished from schema rather than inventing it", () => {
    const schema = JSON.stringify(
      buildArticleJsonLd({ title: "T", description: "D", path: "/learn/x" })
    );

    expect(schema).not.toContain("datePublished");
  });
});

// ---------------------------------------------------------------------------
// Derived values
// ---------------------------------------------------------------------------

describe("derived values are derived, not retyped", () => {
  it("SEO values fall back through the article", () => {
    const plain = pkg();

    expect(articleSeoTitle(plain)).toBe(plain.title);
    expect(articleSeoDescription(plain)).toBe(plain.deck);
    expect(articleOgTitle(plain)).toBe(plain.title);
    expect(articleOgDescription(plain)).toBe(plain.deck);
    expect(articlePath(plain)).toBe(`/learn/${plain.slug}`);
  });

  it("an override wins, and cascades where it should", () => {
    const overridden = pkg({
      seo: { title: "Shorter title", description: "Shorter description." },
    });

    expect(articleSeoTitle(overridden)).toBe("Shorter title");
    // og:title falls back to the SEO title, not to the article title.
    expect(articleOgTitle(overridden)).toBe("Shorter title");
    expect(articleOgDescription(overridden)).toBe("Shorter description.");

    const ogOnly = pkg({ seo: { ogTitle: "Social only" } });
    expect(articleSeoTitle(ogOnly)).toBe(ogOnly.title);
    expect(articleOgTitle(ogOnly)).toBe("Social only");
  });

  it("the canonical is not authorable", () => {
    // The single most damaging field a content system can hand an author.
    const source = code(read("lib/learn.ts"));
    expect(source).not.toMatch(/canonical\??:/);

    const route = code(read("app/learn/[slug]/page.tsx"));
    expect(route).toContain("canonical: absoluteUrl(path)");
    expect(route).toContain("articlePath(article)");
  });

  it("structured data uses the same derived values the page renders", () => {
    const route = code(read("app/learn/[slug]/page.tsx"));
    const jsonLd = route.slice(route.indexOf("buildArticleJsonLd"));

    expect(jsonLd).toContain("articleSeoTitle(article)");
    expect(jsonLd).toContain("articleSeoDescription(article)");
  });
});

// ---------------------------------------------------------------------------
// Validation gates
// ---------------------------------------------------------------------------

describe("malformed packages are refused, field by field", () => {
  it("accepts a well-formed package", () => {
    expect(problems(pkg())).toEqual([]);
  });

  it("rejects a bad slug", () => {
    expect(problems(pkg({ slug: "Not A Slug" })).join(" ")).toContain("hyphen-separated");
  });

  it("rejects a duplicate slug", () => {
    const a = pkg({ slug: "twice" });
    const b = pkg({ slug: "twice", title: "Other" });
    expect(problems(a, [a, b]).join(" ")).toContain("not unique");
  });

  it("rejects an unknown topic and content type", () => {
    expect(
      problems(pkg({ topic: "made-up" as keyof typeof TOPICS })).join(" ")
    ).toContain("not an approved topic");
    expect(
      problems(pkg({ contentType: "podcast" as keyof typeof CONTENT_TYPE_LABELS })).join(" ")
    ).toContain("not a known content type");
  });

  it("rejects empty copy", () => {
    expect(problems(pkg({ title: "   " })).join(" ")).toContain("title: is empty");
    expect(problems(pkg({ deck: "" })).join(" ")).toContain("deck: is empty");
  });

  it("rejects bad dates and impossible update ordering", () => {
    expect(problems(pkg({ publishedAt: "01/02/2026" })).join(" ")).toContain("ISO date");
    expect(
      problems(pkg({ publishedAt: "2026-02-01", updatedAt: "2026-01-01" })).join(" ")
    ).toContain("cannot be before publishedAt");
  });

  it("does not invent a freshness rule", () => {
    // An old article is not a broken one.
    expect(problems(pkg({ publishedAt: "2019-01-01" }))).toEqual([]);
  });

  it("rejects duplicate heading anchors", () => {
    const dupes = pkg({
      body: [
        { kind: "heading", level: 2, id: "same", text: "One" },
        { kind: "heading", level: 2, id: "same", text: "Two" },
      ],
    });
    expect(problems(dupes).join(" ")).toContain("unique");
  });

  it("rejects broken relationships", () => {
    const self = pkg({ slug: "me", related: ["me"] });
    expect(problems(self, [self]).join(" ")).toContain("cannot relate to itself");

    const dupe = pkg({ related: ["a", "a"] });
    expect(problems(dupe).join(" ")).toContain("duplicate");

    const missing = pkg({ related: ["nope"] });
    expect(problems(missing).join(" ")).toContain("not in the library");

    const draftTarget = pkg({ slug: "wip", status: "draft" });
    const linker = pkg({ slug: "linker", related: ["wip"] });
    expect(problems(linker, [linker, draftTarget]).join(" ")).toContain(
      "not publicly visible"
    );
  });

  it("rejects internal links that do not resolve", () => {
    expect(problems(pkg({ internalLinks: ["/nope"] })).join(" ")).toContain(
      "does not resolve"
    );
    expect(problems(pkg({ internalLinks: ["https://example.com"] })).join(" ")).toContain(
      "local path"
    );
    expect(problems(pkg({ internalLinks: ["/templates", "/learn", "/"] }))).toEqual([]);
  });

  it("rejects a CTA pointing nowhere", () => {
    expect(
      problems(pkg({ cta: { label: "Go", href: "/does-not-exist" } })).join(" ")
    ).toContain("does not resolve");
    expect(problems(pkg({ cta: { label: "Go", href: "/templates" } }))).toEqual([]);
  });

  it("rejects malformed sources without inventing citation rules", () => {
    expect(
      problems(pkg({ sources: [{ title: "", url: "https://x.test" }] })).join(" ")
    ).toContain("is empty");
    expect(
      problems(pkg({ sources: [{ title: "T", url: "not-a-url" }] })).join(" ")
    ).toContain("absolute");
    // No minimum number of sources — that is an editorial judgement.
    expect(problems(pkg({ sources: [] }))).toEqual([]);
  });

  it("rejects an incomplete video rather than emitting a stub", () => {
    const bad = pkg({
      video: {
        provider: "youtube",
        id: "",
        title: "",
        uploadDate: "nope",
        durationSeconds: 0,
        thumbnail: image(),
      },
    });
    const found = problems(bad).join(" ");

    expect(found).toContain("video.id");
    expect(found).toContain("video.uploadDate");
    expect(found).toContain("video.durationSeconds");
  });

  it("imposes no word, graphics, source or article quota", () => {
    // Every one of these would be a number standing in for editorial judgement.
    const source = read("lib/learn.ts");

    for (const banned of ["wordCount", "minWords", "keywordDensity", "seoScore", "minGraphics", "minSources"]) {
      expect(`validator: ${banned}`).toBe(`validator: ${banned}`);
      expect(source).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

describe("a mockup can never be presented as the product", () => {
  it("a real screenshot must carry capture evidence", () => {
    const noEvidence = pkg({
      body: [{ kind: "figure", image: image({ provenance: "real-product-screenshot" }) }],
    });
    expect(problems(noEvidence).join(" ")).toContain("capture details");
  });

  it("a real screenshot with evidence is accepted", () => {
    const good = pkg({
      body: [
        {
          kind: "figure",
          image: image({
            provenance: "real-product-screenshot",
            alt: "The Builder's products panel",
            capture: {
              surface: "Builder — products panel",
              capturedAt: "2026-09-01",
              appVersion: "1.2.0",
            },
          }),
        },
      ],
    });
    expect(problems(good)).toEqual([]);
  });

  it("a real screenshot may not be decorative or unlabelled", () => {
    const decorative = pkg({
      body: [
        {
          kind: "figure",
          image: image({
            provenance: "real-product-screenshot",
            decorative: true,
            alt: "",
            capture: { surface: "Builder", capturedAt: "2026-09-01" },
          }),
        },
      ],
    });
    const found = problems(decorative).join(" ");

    expect(found).toContain("cannot be decorative");
    expect(found).toContain("needs alt text");
  });

  it("an illustration may NOT borrow capture metadata", () => {
    // Capture details on a drawing would make a mockup look like evidence.
    const faking = pkg({
      body: [
        {
          kind: "figure",
          image: image({
            provenance: "illustration",
            capture: { surface: "Builder", capturedAt: "2026-09-01" },
          }),
        },
      ],
    });
    expect(problems(faking).join(" ")).toContain("only a real-product-screenshot");
  });

  it("the article marks a real screenshot as one, visibly", () => {
    const renderer = code(read("components/learn/ArticleBody.tsx"));
    expect(renderer).toContain('block.image.provenance === "real-product-screenshot"');
    expect(renderer).toContain("POS Canvas screenshot");
  });

  it("every image declares dimensions and describes itself", () => {
    expect(problems(pkg({ hero: image({ width: 0 }) })).join(" ")).toContain(
      "width and height"
    );
    expect(problems(pkg({ hero: image({ alt: "" }) })).join(" ")).toContain("alt text");
    // Decorative is a legitimate answer, and then alt is deliberately empty.
    expect(problems(pkg({ hero: image({ alt: "", decorative: true }) }))).toEqual([]);
  });

  it("the library ships no fabricated screenshot", () => {
    for (const a of learnArticles) {
      const images = [
        ...(a.hero ? [a.hero] : []),
        ...a.body.flatMap((b) => (b.kind === "figure" ? [b.image] : [])),
      ];
      for (const img of images) {
        expect(`${a.slug} image`).toBe(`${a.slug} image`);
        // If anything ever claims to be a screenshot, it must have evidence.
        if (img.provenance === "real-product-screenshot") expect(img.capture).toBeTruthy();
      }
    }
  });
});

describe("animation carries a still, and reduced motion gets it", () => {
  const animated = (overrides = {}) =>
    pkg({
      body: [
        {
          kind: "animation",
          animation: {
            kind: "animated-webp",
            src: "/fixture.webp",
            width: 800,
            height: 450,
            description: "A cart total updating as items are added.",
            poster: image({ alt: "A cart with three items" }),
            ...overrides,
          },
        },
      ],
    });

  it("accepts a complete animation", () => {
    expect(problems(animated())).toEqual([]);
  });

  it("requires an accessible description", () => {
    expect(problems(animated({ description: "  " })).join(" ")).toContain(
      "accessible description"
    );
  });

  it("requires dimensions and a source", () => {
    expect(problems(animated({ width: 0 })).join(" ")).toContain("width and height");
    expect(problems(animated({ src: "" })).join(" ")).toContain("needs a source");
  });

  it("validates the poster as a real image", () => {
    expect(
      problems(animated({ poster: image({ alt: "", decorative: false }) })).join(" ")
    ).toContain("alt text");
  });

  it("swaps motion for the still under prefers-reduced-motion, without JS", () => {
    const css = read("app/design-system.css");
    const reduced = css.slice(css.indexOf("prefers-reduced-motion: reduce"));

    expect(reduced).toContain(".pc-animation__motion");
    expect(reduced).toContain("display: none");
    expect(reduced).toContain(".pc-animation__still");

    const renderer = read("components/learn/ArticleBody.tsx");
    expect(renderer).not.toContain('"use client"');
    // Muted, never audio.
    expect(renderer).toContain("muted");
    expect(renderer).not.toContain("autoPlay\n        controls");
  });

  it("ships no animation in the public library", () => {
    for (const a of learnArticles) {
      expect(`${a.slug} animation`).toBe(`${a.slug} animation`);
      expect(a.body.some((b) => b.kind === "animation")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Homepage discovery
// ---------------------------------------------------------------------------

describe("the homepage Learn surface shows only legitimate articles", () => {
  const section = code(read("components/landing/LearnDiscovery.tsx"));

  it("reuses the shared filter rather than writing its own", () => {
    // A second filter written locally is exactly how a draft leaks onto the
    // busiest page on the site.
    expect(section).toContain("publishedArticles(learnArticles)");
    expect(section).not.toMatch(/status\s*===/);
    expect(section).not.toContain("productTruth");
  });

  it("renders nothing when the library is empty", () => {
    expect(section).toContain("if (articles.length === 0) return null;");
  });

  it("is mounted on the homepage and links into Learn", () => {
    const page = code(read("app/page.tsx"));

    expect(page).toContain("<LearnDiscovery />");
    expect(section).toContain('href="/learn"');
  });

  it("does not turn the homepage into a feed", () => {
    expect(section).toContain("HOMEPAGE_ARTICLE_LIMIT = 3");
    expect(section).not.toContain("pagination");
    expect(section).not.toContain("Load more");
  });

  it("scales from one article to several", () => {
    // Fixtures, not public filler: proving the multi-article state must not
    // require publishing articles nobody asked for.
    const one = [pkg({ slug: "one" })];
    const several = [
      pkg({ slug: "a", publishedAt: "2026-01-01" }),
      pkg({ slug: "b", publishedAt: "2026-02-01" }),
      pkg({ slug: "c", publishedAt: "2026-03-01" }),
      pkg({ slug: "d", publishedAt: "2026-04-01" }),
    ];

    expect(publishedArticles(one)).toHaveLength(1);
    // Newest first, and the homepage takes the first three of them.
    expect(publishedArticles(several).slice(0, 3).map((a) => a.slug)).toEqual([
      "d",
      "c",
      "b",
    ]);
  });

  it("excludes drafts and ineligible articles at any size", () => {
    const mixed = [
      pkg({ slug: "live" }),
      ...Array.from({ length: 5 }, (_, i) => pkg({ slug: `draft-${i}`, status: "draft" })),
      pkg({ slug: "unreleased", productTruth: "implemented-not-released" }),
      pkg({ slug: "planned", productTruth: "planned" }),
    ];

    expect(publishedArticles(mixed).map((a) => a.slug)).toEqual(["live"]);
  });

  it("adds no Learn link to the Navbar", () => {
    // Task 1's released mobile navigation behaviour stays closed.
    const navbar = code(read("components/landing/Navbar.tsx"));

    expect(navbar).not.toContain("/learn");
    expect(navbar).not.toContain("Learn");
  });
});

// ---------------------------------------------------------------------------
// The handoff boundary
// ---------------------------------------------------------------------------

describe("the repository knows nothing about editorial scheduling", () => {
  it("contains no scheduler, cron or publishing queue", () => {
    // PUBLISHING-SPECIFIC IDENTIFIERS, not loose words. A first draft of this
    // banned the bare word "queue" and fired on the pilot article's own prose
    // — "they queue on the device and sync once it returns" — which is true
    // product language about offline sales, nothing to do with publishing. A
    // guard that flags legitimate copy is a guard somebody eventually deletes.
    for (const file of [
      "lib/learn.ts",
      "data/learn.ts",
      "app/learn/page.tsx",
      "components/landing/LearnDiscovery.tsx",
    ]) {
      const source = code(read(file));

      for (const banned of [
        "cron",
        "setInterval",
        "setTimeout",
        "autoPublish",
        "publishNow",
        "publishQueue",
        "editorialQueue",
        "scheduledPublish",
        "scheduleArticle",
      ]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("ties no counter to how often editorial runs", () => {
    // "Two opportunities a day" must never become "two articles a day".
    // Comment-stripped: this module's own prose explains that it imposes no
    // quota, and the explanation must not trip the rule it describes.
    const source = code(read("lib/learn.ts"));

    for (const banned of ["runsPerDay", "quota", "articlesPerRun", "publishTarget"]) {
      expect(`learn.ts: ${banned}`).toBe(`learn.ts: ${banned}`);
      expect(source).not.toContain(banned);
    }
  });

  it("documents the contract outside TypeScript", () => {
    const doc = "docs/LEARN_EDITORIAL_CONTRACT.md";
    expect(existsSync(join(repoRoot, doc))).toBe(true);

    const contract = read(doc);

    // The parts a future workflow must be able to read without the codebase.
    expect(contract).toContain("NO ARTICLE — QUALITY THRESHOLD NOT MET");
    expect(contract).toContain("REQUIRED");
    expect(contract).toContain("DERIVED");
    expect(contract).toContain("general-education");
    expect(contract).toContain("real-product-screenshot");
    expect(contract).toContain("HUMAN-CONTROLLED PUBLICATION");

    // Every enum the contract names must still exist in the implementation.
    for (const topic of Object.keys(TOPICS)) expect(contract).toContain(topic);
    for (const type of Object.keys(CONTENT_TYPE_LABELS)) expect(contract).toContain(type);
  });
});
