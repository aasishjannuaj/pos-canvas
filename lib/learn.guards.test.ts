// POS Canvas Learn — the rules that keep the library honest.
//
// Two kinds of test here, deliberately. The selectors and the publication rule
// are exercised BEHAVIOURALLY against synthetic articles, because that is the
// only way to prove a draft is excluded without shipping a draft. The route and
// schema decisions are checked at source level, because a page module cannot be
// rendered under this suite.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import sitemap from "@/app/sitemap";
import { learnArticles } from "@/data/learn";
import {
  TOPICS,
  findFalseCapabilityClaims,
  isPubliclyVisible,
  isTruthEligible,
  featuredArticle,
  findPublishedArticle,
  publishedArticles,
  recentArticles,
  relatedArticles,
  shouldShowTopicNav,
  visibleTopics,
  type LearnArticle,
} from "@/lib/learn";
import { absoluteUrl, buildArticleJsonLd, buildBreadcrumbJsonLd } from "@/lib/seo";

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

/** A minimal valid article, for rules that need one that is not in the library. */
function article(overrides: Partial<LearnArticle> = {}): LearnArticle {
  return {
    slug: "synthetic",
    title: "Synthetic",
    deck: "A synthetic article used only by these guards.",
    topic: "pos-basics",
    contentType: "article",
    status: "published",
    publishedAt: "2026-01-01",
    body: [{ kind: "paragraph", text: "Body." }],
    productTruth: "shipped-product",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Product truth — the rule this whole model exists for
// ---------------------------------------------------------------------------

describe("product truth decides what may be public, and status does not", () => {
  it("shipped-product may be public", () => {
    expect(isTruthEligible(article({ productTruth: "shipped-product" }))).toBe(true);
  });

  it("general-education may be public even where POS Canvas does not implement it", () => {
    // THE TASK 3C CORRECTION. Task 3B allowed only "shipped", which made Learn
    // incapable of publishing the general small-business education it exists
    // for: an article about counting stock is not a claim that POS Canvas
    // counts stock.
    expect(isTruthEligible(article({ productTruth: "general-education" }))).toBe(true);
  });

  it("implemented-not-released may NOT be public", () => {
    // v1.3 is building employee, barcode and register features right now. This
    // is the case the field exists for.
    expect(
      isTruthEligible(article({ productTruth: "implemented-not-released" }))
    ).toBe(false);
  });

  it("planned may NOT be public", () => {
    expect(isTruthEligible(article({ productTruth: "planned" }))).toBe(false);
  });

  it("status and truth are independent, in both directions", () => {
    // A draft about unreleased work is legitimate and stays private.
    const draftAboutUnreleased = article({
      status: "draft",
      productTruth: "implemented-not-released",
    });
    expect(isTruthEligible(draftAboutUnreleased)).toBe(false);
    expect(isPubliclyVisible(draftAboutUnreleased)).toBe(false);

    // An eligible subject still is not public until an editor says so.
    const eligibleDraft = article({ status: "draft", productTruth: "general-education" });
    expect(isTruthEligible(eligibleDraft)).toBe(true);
    expect(isPubliclyVisible(eligibleDraft)).toBe(false);

    // And an editor saying so is not enough on its own.
    const publishedIneligible = article({
      status: "published",
      productTruth: "planned",
    });
    expect(publishedIneligible.status).toBe("published");
    expect(isPubliclyVisible(publishedIneligible)).toBe(false);
  });

  it("the public library drops an ineligible article even if marked published", () => {
    // BELT AND BRACES: `status` is the editor's intent, truth is the rule about
    // the world. A mistake in the first is corrected by the second.
    const library = [
      article({ slug: "ok" }),
      article({
        slug: "leaky",
        status: "published",
        productTruth: "implemented-not-released",
      }),
    ];

    expect(publishedArticles(library).map((a) => a.slug)).toEqual(["ok"]);
    expect(findPublishedArticle(library, "leaky")).toBeNull();
  });

  it("every article actually in the library obeys its own declaration", () => {
    for (const a of learnArticles) {
      expect(`${a.slug} status/basis`).toBe(`${a.slug} status/basis`);
      if (a.status === "published") expect(isTruthEligible(a)).toBe(true);
    }
  });

  it("no published article claims POS Canvas provides an unreleased capability", () => {
    // CORRECTED. This used to ban a VOCABULARY — no published article could
    // contain "barcode" or "employee" at all — which made the general-education
    // class unpublishable: an article explaining how barcode scanning works in
    // a shop is exactly what Learn is for. What is forbidden is attributing the
    // capability to POS Canvas, not discussing it. See
    // findFalseCapabilityClaims in lib/learn.ts, and the fixtures in
    // lib/learnPackage.guards.test.ts.
    for (const a of publishedArticles(learnArticles)) {
      expect(`${a.slug} claims`).toBe(`${a.slug} claims`);
      expect(findFalseCapabilityClaims(a)).toEqual([]);
    }
  });

  it("no published article resurrects the per-business build", () => {
    for (const a of publishedArticles(learnArticles)) {
      const prose = JSON.stringify([a.title, a.deck, a.body]).toLowerCase();

      for (const claim of ["your own apk", "custom apk", "one apk", "we generate", "custom executable"]) {
        expect(`${a.slug}: ${claim}`).toBe(`${a.slug}: ${claim}`);
        expect(prose).not.toContain(claim);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

describe("a draft has no public surface at all", () => {
  const library = [article({ slug: "live" }), article({ slug: "wip", status: "draft" })];

  it("is excluded from the library listing", () => {
    expect(publishedArticles(library).map((a) => a.slug)).toEqual(["live"]);
  });

  it("is not reachable by slug", () => {
    expect(findPublishedArticle(library, "wip")).toBeNull();
  });

  it("is not prerendered", () => {
    // generateStaticParams maps published articles only, so a draft has no
    // route to be fetched at.
    const route = code(read("app/learn/[slug]/page.tsx"));
    expect(route).toContain("publishedArticles(learnArticles).map");
  });

  it("cannot reach the sitemap", () => {
    const urls = sitemap().map((entry) => entry.url);

    for (const a of learnArticles) {
      if (a.status === "published" && isTruthEligible(a)) continue;
      expect(`sitemap leaks ${a.slug}`).toBe(`sitemap leaks ${a.slug}`);
      expect(urls.some((url) => url.endsWith(`/learn/${a.slug}`))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Sitemap
// ---------------------------------------------------------------------------

describe("the sitemap lists Learn truthfully", () => {
  const urls = sitemap().map((entry) => entry.url);

  it("includes the hub", () => {
    expect(urls).toContain(absoluteUrl("/learn"));
  });

  it("includes exactly the published articles", () => {
    const published = publishedArticles(learnArticles);

    for (const a of published) {
      expect(`sitemap has ${a.slug}`).toBe(`sitemap has ${a.slug}`);
      expect(urls).toContain(absoluteUrl(`/learn/${a.slug}`));
    }

    const learnUrls = urls.filter((url) => url.includes("/learn"));
    expect(learnUrls).toHaveLength(published.length + 1);
  });

  it("invents no category or archive URL", () => {
    // No /learn/topic/... hierarchy exists, so none may be advertised.
    for (const fake of ["/learn/topic", "/learn/category", "/learn/page", "/learn/tag", "/learn/archive"]) {
      expect(`sitemap has ${fake}`).toBe(`sitemap has ${fake}`);
      expect(urls.some((url) => url.includes(fake))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Routes and indexability
// ---------------------------------------------------------------------------

describe("the Learn routes index the right things", () => {
  it("both routes exist", () => {
    expect(existsSync(join(repoRoot, "app/learn/page.tsx"))).toBe(true);
    expect(existsSync(join(repoRoot, "app/learn/[slug]/page.tsx"))).toBe(true);
  });

  it("the hub canonicalises to itself and is indexable", () => {
    const hub = code(read("app/learn/page.tsx"));

    expect(hub).toContain('canonical: absoluteUrl("/learn")');
    expect(hub).toContain("buildOpenGraph");
    expect(hub).not.toContain("NOINDEX_ROBOTS");
  });

  it("an article canonicalises to its own URL", () => {
    const route = code(read("app/learn/[slug]/page.tsx"));

    expect(route).toContain("absoluteUrl(path)");
    expect(route).toContain("buildOpenGraph");
  });

  it("an unknown slug 404s rather than rendering an indexable page", () => {
    // THE SOFT-404 RULE. /templates/[id] renders an unavailable state at 200 by
    // design and is marked noindex; this route has no such requirement and
    // takes the better behaviour instead.
    const route = code(read("app/learn/[slug]/page.tsx"));

    expect(route).toContain('import { notFound } from "next/navigation"');
    expect(route).toContain("if (!article) notFound();");
  });

  it("is reachable from the footer, and not from the header", () => {
    // The header's section nav is three in-page anchors whose responsive
    // behaviour is the released 1.2.0 behaviour Task 1 was corrected to
    // preserve. A fourth item there would reopen that decision.
    const footer = code(read("components/landing/Footer.tsx"));
    const navbar = code(read("components/landing/Navbar.tsx"));

    expect(footer).toContain('href="/learn"');
    expect(navbar).not.toContain("/learn");
    expect(navbar).not.toContain("Learn");
  });
});

// ---------------------------------------------------------------------------
// Structured data
// ---------------------------------------------------------------------------

describe("Learn structured data claims nothing it cannot back", () => {
  const blob = JSON.stringify([
    buildArticleJsonLd({
      title: "T",
      description: "D",
      path: "/learn/x",
      publishedAt: "2026-01-01",
    }),
    buildBreadcrumbJsonLd([
      { name: "Home", path: "/" },
      { name: "Learn", path: "/learn" },
    ]),
  ]);

  it("emits Article and BreadcrumbList", () => {
    expect(blob).toContain('"Article"');
    expect(blob).toContain('"BreadcrumbList"');
  });

  it("invents no author, publisher, rating or review", () => {
    // There is no approved author identity and no legal entity to publish
    // under — lib/brand.ts holds null for legalCompanyName.
    for (const banned of [
      "author",
      "publisher",
      "Organization",
      "aggregateRating",
      "ratingValue",
      "review",
      "sameAs",
    ]) {
      expect(`article schema: ${banned}`).toBe(`article schema: ${banned}`);
      expect(blob).not.toContain(banned);
    }
  });

  it("omits dateModified when nothing was modified", () => {
    expect(
      JSON.stringify(
        buildArticleJsonLd({ title: "T", description: "D", path: "/learn/x", publishedAt: "2026-01-01" })
      )
    ).not.toContain("dateModified");
  });

  it("emits no VideoObject while no real video exists", () => {
    // The type is defined so a real video carries name, uploadDate, duration
    // and thumbnail. No builder exists, so a placeholder cannot produce one.
    expect(code(read("lib/seo.ts"))).not.toContain("VideoObject");

    for (const a of learnArticles) {
      expect(`${a.slug} video`).toBe(`${a.slug} video`);
      if (a.video) {
        // If one ever is added, it must be complete rather than a stub.
        expect(a.video.id.length).toBeGreaterThan(0);
        expect(a.video.uploadDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(a.video.durationSeconds).toBeGreaterThan(0);
      }
    }
  });

  it("the article route emits no video payload when there is no video", () => {
    const route = code(read("app/learn/[slug]/page.tsx"));

    expect(route).not.toContain("youtube.com/embed");
    expect(route).not.toContain("<iframe");
  });
});

// ---------------------------------------------------------------------------
// Content model integrity
// ---------------------------------------------------------------------------

describe("the library is internally consistent", () => {
  it("every slug is unique and URL-safe", () => {
    const slugs = learnArticles.map((a) => a.slug);

    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(`slug ${slug}`).toBe(`slug ${slug}`);
      expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it("every topic exists in the taxonomy", () => {
    for (const a of learnArticles) {
      expect(`${a.slug} topic`).toBe(`${a.slug} topic`);
      expect(Object.keys(TOPICS)).toContain(a.topic);
    }
  });

  it("the taxonomy is exactly the approved one", () => {
    // NAMED, NOT COUNTED — and the difference matters.
    //
    // This used to assert `Object.keys(TOPICS).length <= 4`, which protected
    // nothing worth protecting: a fourth topic nobody approved could be added
    // silently and still pass, while a legitimate fifth would fail purely on
    // arithmetic. A ceiling cannot tell an approved taxonomy from an
    // unapproved one, because it never looks at what the topics ARE.
    //
    // Asserting the exact ids means every taxonomy change — adding, removing
    // or renaming — is a deliberate edit to this list alongside the edit to
    // lib/learn.ts, reviewed in the same diff. There is no maximum: when Learn
    // genuinely needs a fourth or a sixth topic, the taxonomy and this guard
    // change together as one product decision.
    //
    // IDS, NOT LABELS. The id is what a URL, an article record and this guard
    // all key on; a label is copy and may be reworded without changing the
    // taxonomy at all.
    expect(Object.keys(TOPICS).sort()).toEqual(
      ["pos-basics", "pos-canvas-guides", "running-your-business"].sort()
    );
  });

  it("an empty topic never renders", () => {
    // Separate from the taxonomy itself: a topic may legitimately exist with
    // nothing in it yet, and simply must not be offered as a filter.
    const used = new Set(publishedArticles(learnArticles).map((a) => a.topic));

    for (const topic of visibleTopics(learnArticles)) {
      expect(`topic ${topic} has content`).toBe(`topic ${topic} has content`);
      expect(used.has(topic)).toBe(true);
    }
  });

  it("topic navigation appears only once it would filter something", () => {
    expect(shouldShowTopicNav([article({ slug: "a", topic: "pos-basics" })])).toBe(false);
    expect(
      shouldShowTopicNav([
        article({ slug: "a", topic: "pos-basics" }),
        article({ slug: "b", topic: "pos-canvas-guides" }),
      ])
    ).toBe(true);
  });

  it("every date is a real ISO date, and updates are not before publication", () => {
    for (const a of learnArticles) {
      expect(`${a.slug} publishedAt`).toBe(`${a.slug} publishedAt`);

      // A DRAFT MAY HAVE NO PUBLICATION DATE — it has not been published, and
      // the only dates available to invent from (when the workflow ran, when
      // the file was created) are not publication events.
      if (a.status === "published") {
        expect(a.publishedAt).toBeDefined();
      }

      if (a.publishedAt) {
        expect(a.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(Number.isNaN(Date.parse(a.publishedAt))).toBe(false);
      }

      if (a.updatedAt) {
        expect(a.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(a.publishedAt).toBeDefined();
        expect(a.updatedAt >= a.publishedAt!).toBe(true);
      }
    }
  });

  it("every article has exactly one H1, supplied by the page not the body", () => {
    // The page renders the title as the only <h1>; body blocks can only be h2
    // or h3, so an article cannot introduce a second one or skip a level.
    const route = read("app/learn/[slug]/page.tsx");
    expect((route.match(/<h1/g) ?? []).length).toBe(1);

    for (const a of learnArticles) {
      for (const block of a.body) {
        if (block.kind !== "heading") continue;
        expect(`${a.slug} heading level`).toBe(`${a.slug} heading level`);
        expect([2, 3]).toContain(block.level);
      }
    }
  });

  it("every heading has a unique anchor id", () => {
    for (const a of learnArticles) {
      const ids = a.body.flatMap((b) => (b.kind === "heading" ? [b.id] : []));
      expect(`${a.slug} heading ids`).toBe(`${a.slug} heading ids`);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("every referenced diagram is a real component", () => {
    const registry = read("components/learn/ArticleBody.tsx");

    for (const a of learnArticles) {
      for (const block of a.body) {
        if (block.kind !== "diagram") continue;
        expect(`${a.slug} diagram ${block.name}`).toBe(`${a.slug} diagram ${block.name}`);
        expect(registry).toContain(`"${block.name}"`);
      }
    }
  });

  it("every image declares real dimensions and honest alt text", () => {
    for (const a of learnArticles) {
      const images = [
        ...(a.hero ? [a.hero] : []),
        ...a.body.flatMap((b) => (b.kind === "figure" ? [b.image] : [])),
      ];

      for (const image of images) {
        expect(`${a.slug} image ${image.src}`).toBe(`${a.slug} image ${image.src}`);
        // Dimensions are required so nothing shifts as the page loads.
        expect(image.width).toBeGreaterThan(0);
        expect(image.height).toBeGreaterThan(0);
        // Decorative means alt=""; informative means alt says something.
        if (!image.decorative) expect(image.alt.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("every source has a title and a resolvable URL", () => {
    for (const a of learnArticles) {
      for (const source of a.sources ?? []) {
        expect(`${a.slug} source`).toBe(`${a.slug} source`);
        expect(source.title.trim().length).toBeGreaterThan(0);
        expect(source.url).toMatch(/^https?:\/\//);
      }
    }
  });

  it("related articles resolve, and nothing relates to itself", () => {
    for (const a of publishedArticles(learnArticles)) {
      const resolved = relatedArticles(learnArticles, a);
      expect(`${a.slug} related`).toBe(`${a.slug} related`);
      expect(resolved.some((r) => r.slug === a.slug)).toBe(false);
      expect(resolved.length).toBeLessThanOrEqual((a.related ?? []).length);
    }
  });

  it("a CTA points at a route that exists", () => {
    for (const a of learnArticles) {
      if (!a.cta) continue;
      expect(`${a.slug} cta ${a.cta.href}`).toBe(`${a.slug} cta ${a.cta.href}`);
      expect(a.cta.href.startsWith("/")).toBe(true);

      const segment = a.cta.href.replace(/^\//, "").split("/")[0];
      expect(existsSync(join(repoRoot, "app", segment, "page.tsx"))).toBe(true);
    }
  });

  it("every article has real substance, however many there are", () => {
    // NO ARTICLE-COUNT CEILING, DELIBERATELY.
    //
    // An earlier version of this test asserted the library held at most six
    // articles, on the theory that a sudden jump in count was the shape mass
    // AI filler would take. That was the wrong instrument: Learn exists for
    // long-term content growth, and a ceiling means the repository starts
    // failing the day a legitimate seventh article is written. A number that
    // has to be raised every time the product succeeds is not a safeguard, it
    // is a speed bump with a false positive built in.
    //
    // What replaces it is PER-ARTICLE and therefore scale-independent: every
    // article, at any library size, must carry a real body rather than a stub.
    // Filler is caught by being thin, not by being numerous — and the actual
    // defence against mass generated content is the editorial workflow
    // (draft/published, productTruthBasis, human-controlled publication), not
    // a collection size.
    for (const a of learnArticles) {
      const words = JSON.stringify(a.body).split(/\s+/).length;
      expect(`${a.slug} length`).toBe(`${a.slug} length`);
      expect(words).toBeGreaterThan(120);
    }
  });

  it("scales past six articles without failing on count alone", () => {
    // THE NEGATIVE CONTROL FOR THE REMOVED CAP. Eight valid published
    // articles — more than the old ceiling — must flow through every selector
    // untouched. Fixtures, not real content: proving the system scales must
    // not require manufacturing seven public articles, which is the very thing
    // the editorial rules exist to prevent.
    const many = Array.from({ length: 8 }, (_, i) =>
      article({
        slug: `fixture-${i}`,
        title: `Fixture ${i}`,
        // Descending dates, so ordering is observable rather than incidental.
        publishedAt: `2026-0${i + 1}-01`,
        topic: i % 2 === 0 ? "pos-basics" : "running-your-business",
      })
    );

    const published = publishedArticles(many);

    expect(published).toHaveLength(8);
    expect(published.every((a) => isTruthEligible(a))).toBe(true);
    // Newest first, and the featured slot is simply the newest.
    expect(published[0].slug).toBe("fixture-7");
    expect(featuredArticle(many)?.slug).toBe("fixture-7");
    expect(recentArticles(many, "fixture-7")).toHaveLength(7);
    // Every one is reachable; none is dropped for being the seventh or eighth.
    for (const a of many) {
      expect(`reachable ${a.slug}`).toBe(`reachable ${a.slug}`);
      expect(findPublishedArticle(many, a.slug)?.slug).toBe(a.slug);
    }
    // Two topics in use, so topic navigation switches itself on by content.
    expect(visibleTopics(many).sort()).toEqual(["pos-basics", "running-your-business"]);
    expect(shouldShowTopicNav(many)).toBe(true);
  });

  it("filters on status and truth, never on collection size", () => {
    // Seven drafts. Not one of them reaches the public library, the featured
    // slot, or a slug lookup — and the reason is their STATUS, not how many
    // there are. A library of a thousand published articles would behave
    // identically; a library of one draft would too.
    const sevenDrafts = Array.from({ length: 7 }, (_, i) =>
      article({ slug: `draft-${i}`, status: "draft" })
    );

    expect(publishedArticles(sevenDrafts)).toEqual([]);
    expect(featuredArticle(sevenDrafts)).toBeNull();
    expect(visibleTopics(sevenDrafts)).toEqual([]);
    expect(shouldShowTopicNav(sevenDrafts)).toBe(false);
    for (const d of sevenDrafts) {
      expect(`draft ${d.slug} hidden`).toBe(`draft ${d.slug} hidden`);
      expect(findPublishedArticle(sevenDrafts, d.slug)).toBeNull();
    }

    // Mixed: drafts and unreleased-basis articles are dropped at ANY size,
    // and the published ones are unaffected by how much is hidden beside them.
    const mixed = [
      ...sevenDrafts,
      article({ slug: "live-1", publishedAt: "2026-01-01" }),
      article({ slug: "live-2", publishedAt: "2026-02-01" }),
      article({
        slug: "unreleased",
        status: "published",
        productTruth: "implemented-not-released",
      }),
    ];

    expect(publishedArticles(mixed).map((a) => a.slug)).toEqual(["live-2", "live-1"]);
  });

  it("the sitemap would exclude seven drafts by the same rule it already uses", () => {
    // app/sitemap.ts maps publishedArticles(learnArticles) — asserted below and
    // in lib/seo.guards.test.ts — so proving the RULE excludes drafts at any
    // count proves the sitemap does, without shipping seven drafts to prove it.
    const sevenDrafts = Array.from({ length: 7 }, (_, i) =>
      article({ slug: `draft-${i}`, status: "draft" })
    );

    expect(publishedArticles(sevenDrafts).map((a) => `/learn/${a.slug}`)).toEqual([]);

    // The sitemap derives from that rule rather than from its own list.
    const source = code(read("app/sitemap.ts"));
    expect(source).toContain("publishedArticles(learnArticles)");
    expect(source).not.toMatch(/learnArticles\.map/);

    // And behaviourally, today: the live sitemap's Learn entries are exactly
    // the published ones, no more and no fewer.
    const urls = sitemap().map((entry) => entry.url);
    const learnArticleUrls = urls.filter((u) => u.includes("/learn/"));
    expect(learnArticleUrls).toEqual(
      publishedArticles(learnArticles).map((a) => absoluteUrl(`/learn/${a.slug}`))
    );
  });

  it("featured is the newest published article", () => {
    const featured = featuredArticle(learnArticles);
    const published = publishedArticles(learnArticles);

    expect(featured?.slug).toBe(published[0]?.slug ?? undefined);
  });

  it("no autonomous publisher exists", () => {
    // Future automation proposes DRAFTS. Nothing in the repository may flip an
    // article to published on its own.
    for (const file of ["lib/learn.ts", "data/learn.ts", "app/learn/page.tsx"]) {
      const source = code(read(file));
      expect(`${file} autopublish`).toBe(`${file} autopublish`);
      expect(source).not.toContain('status = "published"');
      expect(source).not.toContain("autoPublish");
      expect(source).not.toContain("publishNow");
    }
  });
});
