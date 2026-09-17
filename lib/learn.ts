// POS Canvas Learn — the content model, and the rules that keep it honest.
//
// NO CMS, NO DATABASE, ON PURPOSE. Articles are typed data in data/learn.ts.
// That makes the whole library reviewable in a pull request, diffable, and
// testable by the same guards that protect the rest of the marketing surface —
// which matters more than authoring convenience while the library is small and
// while a future automated writer will be proposing drafts into it.
//
// THE RULES THIS MODULE EXISTS TO ENFORCE. v1.3 is building employee, barcode
// and register features RIGHT NOW, which is exactly the situation where an
// article gets written about something a reader cannot yet use. Two separate
// mechanisms address that, and neither substitutes for the other:
//
//   1. Every article declares a ProductTruth — what its claims rest on. Only
//      shipped-product and general-education may be public (isTruthEligible).
//
//   2. Whatever the class, no publicly visible article may ATTRIBUTE an
//      unreleased capability to POS Canvas (findFalseCapabilityClaims). That
//      is about attribution, not vocabulary: an article may explain how
//      barcode scanning works in a shop; it may not say POS Canvas does it.
//
// Both are floors. Neither can read prose, which is why product-truth review
// by a human remains a required editorial stage — see
// docs/LEARN_EDITORIAL_CONTRACT.md.
//
// Dependency-free (no React, no Supabase, no node builtins) so every selector
// and every rule below is unit-testable.

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

// DELIBERATELY THREE. The brief listed eight candidate topics; encoding all
// eight for a library this size would produce mostly empty shelves, and an
// empty category is a worse page than no category. These three are the smallest
// set that can hold the material the product can honestly write about today,
// and `visibleTopics()` below means an unused one never renders. Adding a
// fourth is a one-line change when an article needs it.
export const TOPICS = {
  "pos-basics": {
    label: "POS Basics",
    description: "How a point of sale actually works, in plain language.",
  },
  "pos-canvas-guides": {
    label: "POS Canvas Guides",
    description: "Using POS Canvas: templates, publishing, devices.",
  },
  "running-your-business": {
    label: "Running Your Business",
    description: "Day-to-day decisions behind the counter.",
  },
} as const;

export type TopicId = keyof typeof TOPICS;

// The five the brief named. `video` and `build-insight` exist as types even
// with no instance yet, because the card and the article template both branch
// on them and a type that appears later would be a silent rendering gap.
export type ContentType = "guide" | "article" | "tutorial" | "video" | "build-insight";

export const CONTENT_TYPE_LABELS: Record<ContentType, string> = {
  guide: "Guide",
  article: "Article",
  tutorial: "Tutorial",
  video: "Video",
  "build-insight": "Build Insight",
};

/**
 * DRAFT and PUBLISHED only. A third status would need a behaviour to justify it.
 *
 * STATUS IS NOT TRUTH. This is the editor's intent — "I consider this ready".
 * ProductTruth below is a statement about the WORLD — "what this article's
 * claims rest on". They are deliberately separate fields with separate rules,
 * because merging them would mean an editor could publish unreleased product
 * claims by changing one word, and a truth reclassification could silently
 * publish a draft.
 */
export type ArticleStatus = "draft" | "published";

/**
 * What an article's claims rest on.
 *
 * CORRECTED IN TASK 3C. Task 3B modelled this as "the product states the
 * project reasons in" and allowed publication only when an article rested
 * entirely on SHIPPED functionality. That was too narrow: it made Learn
 * incapable of publishing the general small-business education it exists to
 * publish — how inventory counts work, how cash handling works — because those
 * subjects are not POS Canvas features at all and could never be classified
 * "shipped".
 *
 *   shipped-product            About POS Canvas functionality that is
 *                              RELEASED. Publishable after editorial approval.
 *
 *   general-education          About point-of-sale, retail or small-business
 *                              practice generally. Publishable after editorial
 *                              approval EVEN WHERE POS CANVAS DOES NOT
 *                              IMPLEMENT THE CONCEPT — an article about
 *                              counting stock does not become a claim that POS
 *                              Canvas counts stock for you. What it may never
 *                              do is imply POS Canvas supports something
 *                              unreleased; any POS Canvas capability it does
 *                              mention must be released behaviour, and the
 *                              vocabulary guards enforce that against every
 *                              publicly visible article regardless of class.
 *
 *   implemented-not-released   Built, not released. Must never be represented
 *                              publicly as available.
 *
 *   planned                    Future work. Same rule.
 */
export type ProductTruth =
  | "shipped-product"
  | "general-education"
  | "implemented-not-released"
  | "planned";

/** The classes an article may be publicly visible under. */
export const PUBLICLY_ELIGIBLE_TRUTH: readonly ProductTruth[] = [
  "shipped-product",
  "general-education",
] as const;

// ---------------------------------------------------------------------------
// Authorship policy
// ---------------------------------------------------------------------------

/**
 * The v1.3 authorship policy, decided by the Control Room (Option A).
 *
 * Learn articles carry NO named author or byline, and Article structured data
 * carries no `author` and no `publisher`. Not because either is technically
 * impossible — Google's Article documentation accepts a Person or an
 * Organization as author, and Organization's `legalName` is optional — but
 * because POS Canvas has no approved editorial identity, and an invented
 * writer, editor, credential or biography is the most common fabrication on a
 * content site.
 *
 * A truthful process or AI-assistance disclosure is still allowed, and is what
 * `LearnArticle.editorialNote` is for.
 *
 * THIS IS A v1.3 POLICY, NOT A PERMANENT PROHIBITION. Named authorship remains
 * architecturally possible: the decision that has not been made is who is
 * publicly accountable for this content, not whether the schema could express
 * it. Changing the policy means changing this constant, the guard that reads
 * it, and docs/LEARN_EDITORIAL_CONTRACT.md together — deliberately, in one
 * reviewed change.
 */
export const LEARN_AUTHORSHIP_POLICY = "no-named-author" as const;

export type LearnAuthorshipPolicy = typeof LEARN_AUTHORSHIP_POLICY;

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

/**
 * WHERE AN IMAGE CAME FROM — a required, machine-readable decision.
 *
 * Task 3B carried an optional `isProductScreenshot?: boolean`, which is the
 * wrong shape for the one distinction that actually matters: absence read as
 * "not a screenshot", so forgetting the flag was indistinguishable from
 * deciding it. Provenance is REQUIRED, so an editorial package cannot omit the
 * decision, and a mockup cannot drift into being presented as the product.
 *
 *   real-product-screenshot   Captured from the running POS Canvas product.
 *                             Nothing else may claim this, ever — not a
 *                             mockup, not a recreated interface, not a
 *                             generated image, not a redrawn "clean" version.
 *   illustration             Drawn or generated artwork.
 *   diagram                  Explains a relationship rather than depicting a
 *                            screen. (Reviewed inline diagrams use the
 *                            `diagram` BLOCK instead; this is for diagram
 *                            images.)
 *   photograph               A real photograph of the world.
 */
export type MediaProvenance =
  | "real-product-screenshot"
  | "illustration"
  | "diagram"
  | "photograph";

/**
 * Where and when a real screenshot was taken.
 *
 * REQUIRED for `real-product-screenshot` and forbidden for everything else, so
 * the claim carries its own evidence: a reviewer can tell which surface and
 * which build it came from without asking the author.
 *
 * WHAT MUST NOT BE IN A SCREENSHOT: credentials, tokens, API keys, real
 * customer names or contact details, real order data, or anything visible only
 * in staging. `surface` describes the screen, not the account.
 */
/**
 * The surface a screenshot was ACTUALLY taken on.
 *
 * Recorded because the same product renders on several: a Builder capture is
 * not the till, and a till captured in a browser at /device is not the Android
 * app. A decorative frame around a screenshot must never contradict this.
 */
export type ScreenshotPlatform = "web-builder" | "web-device" | "android" | "windows";

export const SCREENSHOT_PLATFORMS: readonly ScreenshotPlatform[] = [
  "web-builder",
  "web-device",
  "android",
  "windows",
] as const;

/**
 * INTERNAL provenance for a real product screenshot. Never rendered.
 *
 * STRENGTHENED IN TASK 3D, WHEN THE FIRST REAL ASSET ARRIVED. The Task 3C shape
 * carried only a surface, a date and an optional version, and the first genuine
 * capture showed that is not enough to defend the claim "this is the shipped
 * product": it did not say which PLATFORM the pixels came from, which RELEASE
 * they represent, or that anyone had checked them. Each of those is now
 * required, and the two reviews are LITERAL "passed" types, so a record cannot
 * be written at all without attesting to them.
 *
 * Public text lives on the image (`alt`, `caption`). Nothing here is shown to a
 * reader.
 */
export type ScreenshotCapture = {
  /** The product surface and state, e.g. "Builder (/editor/cafe) — Menu tab". */
  surface: string;
  /** Where the pixels actually came from. */
  platform: ScreenshotPlatform;
  /** ISO date the capture was taken. */
  capturedAt: string;
  /** The released product this represents: a version AND the commit it shipped as. */
  shippedBasis: { version: string; commit: string };
  /** How it was captured and processed. */
  context: string;
  /** What the screenshot shows a reader, for a reviewer's benefit. */
  demonstrates: string;
  /** Human attestations. Literal types: there is no way to record "not checked". */
  reviews: {
    unreleasedFeatures: "passed";
    sensitiveInformation: "passed";
  };
};

/**
 * An image with its real dimensions.
 *
 * width/height are REQUIRED so every image reserves its space and cannot shift
 * the page as it loads. `decorative` drives alt="" rather than inviting a
 * keyword-stuffed description of a flourish — and a real product screenshot may
 * never be decorative, because it is evidence.
 */
export type ArticleImage = {
  src: string;
  alt: string;
  width: number;
  height: number;
  provenance: MediaProvenance;
  decorative?: boolean;
  caption?: string;
  /** Required when provenance is real-product-screenshot; otherwise omitted. */
  capture?: ScreenshotCapture;
};

/**
 * Diagrams are NAMED, not embedded.
 *
 * An article references a diagram that exists as a real component; it cannot
 * ship a blob of markup. That keeps SVG out of the data layer, keeps it out of
 * dangerouslySetInnerHTML, and means a future automated writer can only point
 * at drawings a human has already built and reviewed.
 */
export type DiagramName = "publish-and-pair";

/**
 * A real video. NEVER a placeholder.
 *
 * If this is present the article renders an embed and emits VideoObject; if it
 * is absent, neither happens and no video payload is loaded. There is no
 * "coming soon" state, because a video that does not exist has no URL, no
 * duration and no upload date to be truthful about.
 */
export type ArticleVideo = {
  provider: "youtube";
  id: string;
  title: string;
  /** ISO 8601 date the video was published. Required by VideoObject. */
  uploadDate: string;
  durationSeconds: number;
  thumbnail: ArticleImage;
  transcript?: string;
};

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

/**
 * Motion, with a static fallback that is not optional.
 *
 *   animated-webp / video-loop   A real asset. `poster` is REQUIRED: it is what
 *                                a reader sees before the asset loads, if it
 *                                fails, and when they have asked for reduced
 *                                motion.
 *   component                    A reviewed CSS/SVG animation component,
 *                                referenced by name for the same reason
 *                                diagrams are — nothing arbitrary enters
 *                                through article data.
 *
 * `description` is REQUIRED and is the accessible description. An animation
 * that cannot be described in a sentence is decoration, and decoration is not
 * what this field is for.
 */
export type ArticleAnimation =
  | {
      kind: "animated-webp" | "video-loop";
      src: string;
      width: number;
      height: number;
      description: string;
      poster: ArticleImage;
      caption?: string;
      loading?: "lazy" | "eager";
    }
  | {
      kind: "component";
      name: AnimationName;
      width: number;
      height: number;
      description: string;
      caption?: string;
    };

/**
 * Reviewed animation components, by name.
 *
 * `never` today: no article needs one, and inventing one to populate the type
 * would be decoration. A real component adds its name here and to the renderer
 * registry in the same change.
 */
export type AnimationName = never;

export type ArticleBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; level: 2 | 3; id: string; text: string }
  | { kind: "list"; ordered?: boolean; items: string[] }
  | { kind: "callout"; tone: "note" | "caution"; title?: string; text: string }
  | { kind: "diagram"; name: DiagramName; caption: string }
  | { kind: "figure"; image: ArticleImage; caption?: string }
  | { kind: "animation"; animation: ArticleAnimation };

/**
 * Search metadata OVERRIDES, all optional.
 *
 * Everything here is DERIVED from the article when absent — the title becomes
 * the SEO title, the deck becomes the meta description and the Open Graph
 * description. A package that repeats the same sentence four times gives it
 * four places to drift, so the contract asks for an override only where an
 * author actually wants one (a title too long for a result page, say).
 *
 * The canonical URL is NOT here and is not overridable: it derives from the
 * slug and the one approved origin, which is the only way it can be right.
 */
export type ArticleSeo = {
  title?: string;
  description?: string;
  ogTitle?: string;
  ogDescription?: string;
};

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

/**
 * A source. Optional fields stay optional BECAUSE they are often unknown —
 * an invented "accessed" date is still an invention.
 */
export type ArticleSource = {
  title: string;
  url: string;
  publisher?: string;
  publishedAt?: string;
  accessedAt?: string;
};

// ---------------------------------------------------------------------------
// The article
// ---------------------------------------------------------------------------

export type LearnArticle = {
  slug: string;
  title: string;
  /** The deck: one or two sentences, and the meta description. */
  deck: string;
  topic: TopicId;
  contentType: ContentType;
  status: ArticleStatus;
  /**
   * ISO date (YYYY-MM-DD) — the date the article was ACTUALLY PUBLISHED.
   *
   * OPTIONAL ON A DRAFT, REQUIRED ONCE PUBLISHED. A draft has not been
   * published, so forcing it to carry a date would mean inventing one, and the
   * only dates available to invent from are the wrong ones: when the editorial
   * workflow happened to run, when the file was created, when the research was
   * done. None of those is a publication event.
   *
   * A scheduled editorial opportunity is not a publication. The repository has
   * no scheduling metadata at all, and this field must never be derived from
   * any.
   */
  publishedAt?: string;
  /** ISO date. Meaningless before publication; never earlier than publishedAt. */
  updatedAt?: string;
  hero?: ArticleImage;
  body: ArticleBlock[];
  sources?: ArticleSource[];
  /** Slugs. Resolved against the library, so a typo renders nothing rather than a broken link. */
  related?: string[];
  cta?: { label: string; href: string };
  video?: ArticleVideo;
  /** Search overrides. Everything in it is derived from the article when absent. */
  seo?: ArticleSeo;
  /**
   * Repository-local paths the article links to, declared so they can be
   * checked. Local paths only — the contract does not pretend to verify the
   * rest of the internet, which is what `sources` is for.
   */
  internalLinks?: string[];
  /**
   * THE EDITORIAL SAFEGUARD. What this article's claims rest on.
   * See ProductTruth, and isTruthEligible below.
   */
  productTruth: ProductTruth;
  /** Free text for a reviewer: what was checked, and against what. */
  releaseTruthNotes?: string;
  /**
   * How this article came to exist, in plain words. Rendered verbatim when
   * present.
   *
   * Exists because Google's guidance is that AI should NOT be given an author
   * byline, while an automation disclosure IS useful where a reader might
   * reasonably ask "how was this made?". This is that disclosure — a sentence
   * of fact, never an invented person.
   */
  editorialNote?: string;
};

// ---------------------------------------------------------------------------
// Rules and selectors — pure, so the guards can exercise them directly
// ---------------------------------------------------------------------------

/**
 * Is this article's SUBJECT allowed to be public?
 *
 * Truth only — it says nothing about whether an editor considers the article
 * ready. An article about employee PINs classifies as
 * "implemented-not-released" and is refused here until a release changes that,
 * mechanically rather than by memory. An article about counting stock
 * classifies as "general-education" and is allowed, because teaching a concept
 * is not claiming to implement it.
 */
export function isTruthEligible(article: LearnArticle): boolean {
  return PUBLICLY_ELIGIBLE_TRUTH.includes(article.productTruth);
}

/**
 * Is this article actually public?
 *
 * BOTH CONDITIONS, AND THEY ARE INDEPENDENT. `status` is the editor's intent;
 * `isTruthEligible` is the rule about the world. Either one alone is
 * insufficient, and neither can be used to bypass the other: marking an
 * unreleased-feature article "published" does not publish it, and
 * reclassifying a draft's truth does not either.
 */
export function isPubliclyVisible(article: LearnArticle): boolean {
  return article.status === "published" && isTruthEligible(article);
}

// ---------------------------------------------------------------------------
// Derived values — one source of truth per fact
// ---------------------------------------------------------------------------

/** The article's path. Never authored; always derived from the slug. */
export function articlePath(article: LearnArticle): string {
  return `/learn/${article.slug}`;
}

/** The <title>. Derived from the article title unless explicitly overridden. */
export function articleSeoTitle(article: LearnArticle): string {
  return article.seo?.title ?? article.title;
}

/** The meta description. Derived from the deck unless explicitly overridden. */
export function articleSeoDescription(article: LearnArticle): string {
  return article.seo?.description ?? article.deck;
}

/** og:title. Falls back through the SEO title to the article title. */
export function articleOgTitle(article: LearnArticle): string {
  return article.seo?.ogTitle ?? articleSeoTitle(article);
}

/** og:description. Falls back through the SEO description to the deck. */
export function articleOgDescription(article: LearnArticle): string {
  return article.seo?.ogDescription ?? articleSeoDescription(article);
}

/**
 * The public library.
 *
 * Two independent conditions, not one — see isPubliclyVisible. An article
 * marked published whose subject is not eligible is dropped here rather than
 * trusted, so the mistake is invisible to the public instead of live on the
 * site. The guards fail on it separately, so it is not silently swallowed
 * either.
 */
export function publishedArticles(articles: readonly LearnArticle[]): LearnArticle[] {
  return articles
    .filter(isPubliclyVisible)
    // Only publicly visible articles reach this, and validation requires a
    // publication date on those — the fallback keeps the comparator total for
    // the type rather than papering over a real absence.
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
}

/** Newest first; the index features the first and lists the rest. */
export function featuredArticle(articles: readonly LearnArticle[]): LearnArticle | null {
  return publishedArticles(articles)[0] ?? null;
}

export function recentArticles(
  articles: readonly LearnArticle[],
  excludeSlug?: string
): LearnArticle[] {
  return publishedArticles(articles).filter((a) => a.slug !== excludeSlug);
}

/**
 * Only a PUBLISHED article is reachable by slug.
 *
 * Drafts return null, so /learn/[slug] calls notFound() for them and a draft
 * has no public URL at all — not a 200, not a soft 404, nothing to index.
 */
export function findPublishedArticle(
  articles: readonly LearnArticle[],
  slug: string
): LearnArticle | null {
  return publishedArticles(articles).find((a) => a.slug === slug) ?? null;
}

/**
 * Topics that actually have something in them.
 *
 * An empty category is a thin page and a wasted click. The index renders topic
 * navigation from this, so a topic with no published article simply is not
 * offered.
 */
export function visibleTopics(articles: readonly LearnArticle[]): TopicId[] {
  const used = new Set(publishedArticles(articles).map((a) => a.topic));
  return (Object.keys(TOPICS) as TopicId[]).filter((id) => used.has(id));
}

/**
 * Should the index render topic navigation at all?
 *
 * One topic means the control filters nothing. A sparse library reads better
 * with no chrome than with controls that do nothing, which is the same reason
 * Feature 22 deleted the gallery's dead search box.
 */
export function shouldShowTopicNav(articles: readonly LearnArticle[]): boolean {
  return visibleTopics(articles).length >= 2;
}

/** Related articles, resolved to real published ones. A bad slug yields nothing. */
export function relatedArticles(
  articles: readonly LearnArticle[],
  article: LearnArticle
): LearnArticle[] {
  const published = publishedArticles(articles);
  return (article.related ?? [])
    .map((slug) => published.find((a) => a.slug === slug))
    .filter((a): a is LearnArticle => Boolean(a) && a!.slug !== article.slug);
}

/** For display: "14 September 2026". Fixed locale so server and client agree. */
export function formatArticleDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ---------------------------------------------------------------------------
// The validation gate
// ---------------------------------------------------------------------------

/**
 * Every deterministic thing that can be wrong with an article package.
 *
 * WHY A LIST OF ISSUES RATHER THAN A BOOLEAN. A package arriving from the
 * editorial workflow needs to be told WHAT is wrong so it can be fixed without
 * a round of guessing. The guards assert this returns empty for everything in
 * the library, so a malformed package fails the build with its own explanation.
 *
 * WHAT THIS DELIBERATELY DOES NOT CHECK: anything subjective. There is no word
 * count, no keyword density, no source quota, no "SEO score", and no graphics
 * quota. Those are editorial judgements, and a number standing in for one is
 * just a number that can be gamed. This function checks facts.
 */
export type ArticleIssue = { slug: string; field: string; problem: string };

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Repository-local paths an article may link to.
 *
 * Deterministically checkable, which is the whole point: `/templates` either
 * is a route or it is not. Anything external belongs in `sources`, where it is
 * a citation rather than a promise that a page exists.
 */
export const KNOWN_INTERNAL_PATHS: readonly string[] = [
  "/",
  "/learn",
  "/templates",
  "/login",
  "/signup",
] as const;

function isKnownInternalPath(
  path: string,
  articles: readonly LearnArticle[]
): boolean {
  if (KNOWN_INTERNAL_PATHS.includes(path)) return true;
  // A Learn article path is valid if it resolves to a publicly visible article.
  const learnSlug = path.startsWith("/learn/") ? path.slice("/learn/".length) : null;
  if (learnSlug) return articles.some((a) => a.slug === learnSlug && isPubliclyVisible(a));
  // Template detail pages are generated from the registry, which this module
  // deliberately does not import; the shape is checked, the id is not.
  return /^\/templates\/[a-z0-9-]+$/.test(path);
}

function validateImage(
  slug: string,
  field: string,
  image: ArticleImage,
  issues: ArticleIssue[]
): void {
  if (image.width <= 0 || image.height <= 0)
    issues.push({ slug, field, problem: "image needs real width and height" });

  if (!image.decorative && image.alt.trim() === "")
    issues.push({ slug, field, problem: "non-decorative image needs alt text" });

  if (image.provenance === "real-product-screenshot") {
    // The claim has to carry its evidence.
    if (!image.capture)
      issues.push({ slug, field, problem: "real screenshot needs capture details" });
    else {
      const capture = image.capture;
      if (capture.surface.trim() === "")
        issues.push({ slug, field, problem: "screenshot capture needs a surface" });
      if (!ISO_DATE.test(capture.capturedAt))
        issues.push({ slug, field, problem: "screenshot capturedAt must be an ISO date" });
      if (!SCREENSHOT_PLATFORMS.includes(capture.platform))
        issues.push({ slug, field, problem: "screenshot needs a known platform" });
      // The release it represents: a version a reader would recognise, and the
      // exact commit that version shipped as.
      if (!capture.shippedBasis || capture.shippedBasis.version.trim() === "")
        issues.push({ slug, field, problem: "screenshot needs a shipped version" });
      if (!capture.shippedBasis || !/^[0-9a-f]{40}$/.test(capture.shippedBasis.commit))
        issues.push({ slug, field, problem: "screenshot needs the full shipped commit" });
      if (!capture.context || capture.context.trim() === "")
        issues.push({ slug, field, problem: "screenshot needs its capture context" });
      if (!capture.demonstrates || capture.demonstrates.trim() === "")
        issues.push({ slug, field, problem: "screenshot needs to say what it demonstrates" });
      // Typed as literals, but data can be cast — check at runtime too.
      if (capture.reviews?.unreleasedFeatures !== "passed")
        issues.push({ slug, field, problem: "screenshot lacks an unreleased-feature review" });
      if (capture.reviews?.sensitiveInformation !== "passed")
        issues.push({ slug, field, problem: "screenshot lacks a sensitive-information review" });
    }
    // Evidence is never decoration.
    if (image.decorative)
      issues.push({ slug, field, problem: "a real screenshot cannot be decorative" });
    if (image.alt.trim() === "")
      issues.push({ slug, field, problem: "a real screenshot needs alt text" });
  } else if (image.capture) {
    // Capture metadata on a drawing would make a mockup look like evidence.
    issues.push({
      slug,
      field,
      problem: "only a real-product-screenshot may carry capture details",
    });
  }
}

/**
 * Validate one image that is used OUTSIDE a Learn article — on the homepage,
 * say — against the same rules an article figure obeys. One contract for media,
 * wherever it is shown.
 */
export function validateMediaImage(label: string, image: ArticleImage): ArticleIssue[] {
  const issues: ArticleIssue[] = [];
  validateImage(label, "image", image, issues);
  return issues;
}

/**
 * Validate one package against the library it is joining.
 *
 * Returns [] when the package is well formed. Never throws: the caller decides
 * what a failure means, and in this repository the caller is a test.
 */
export function validateArticle(
  article: LearnArticle,
  library: readonly LearnArticle[]
): ArticleIssue[] {
  const issues: ArticleIssue[] = [];
  const slug = article.slug;
  const push = (field: string, problem: string) => issues.push({ slug, field, problem });

  // --- identity ---
  if (!SLUG_PATTERN.test(slug)) push("slug", "must be lower-case, hyphen-separated");
  if (library.filter((a) => a.slug === slug).length > 1) push("slug", "is not unique");
  if (!(article.topic in TOPICS)) push("topic", "is not an approved topic");
  if (!(article.contentType in CONTENT_TYPE_LABELS))
    push("contentType", "is not a known content type");
  if (article.status !== "draft" && article.status !== "published")
    push("status", "must be draft or published");

  // --- copy ---
  if (article.title.trim() === "") push("title", "is empty");
  if (article.deck.trim() === "") push("deck", "is empty");
  if (articleSeoTitle(article).trim() === "") push("seo.title", "is empty");
  if (articleSeoDescription(article).trim() === "") push("seo.description", "is empty");

  // --- dates ---
  // A DRAFT NEED NOT HAVE A PUBLICATION DATE, because it has not been
  // published. A PUBLISHED article must, because the date is the record of a
  // real event rather than a field to fill in.
  if (article.publishedAt !== undefined && !ISO_DATE.test(article.publishedAt))
    push("publishedAt", "must be an ISO date");

  if (article.status === "published" && article.publishedAt === undefined)
    push("publishedAt", "is required once an article is published");

  if (article.updatedAt) {
    if (!ISO_DATE.test(article.updatedAt)) push("updatedAt", "must be an ISO date");
    // "Updated" before it was ever published is not a state that means
    // anything.
    else if (article.publishedAt === undefined)
      push("updatedAt", "cannot exist without a publishedAt");
    else if (article.updatedAt < article.publishedAt)
      push("updatedAt", "cannot be before publishedAt");
  }

  // --- publication truth ---
  // Status and truth are independent, so the only combination that is an ERROR
  // is claiming public visibility for an ineligible subject. A DRAFT about
  // unreleased work is entirely legitimate and must not be flagged.
  if (article.status === "published" && !isTruthEligible(article))
    push(
      "productTruth",
      `"${article.productTruth}" cannot be published; only ${PUBLICLY_ELIGIBLE_TRUTH.join(" or ")} may be public`
    );

  // --- false product-capability claims ---
  // Only for articles that will actually be public. A draft may say anything
  // while it is being worked on; it is publication that makes a claim.
  if (isPubliclyVisible(article)) {
    for (const claim of findFalseCapabilityClaims(article)) {
      push(
        "body",
        `claims POS Canvas provides "${claim.capability}", which is not released: "${claim.sentence}"`
      );
    }
  }

  // --- headings ---
  const headingIds = article.body.flatMap((b) => (b.kind === "heading" ? [b.id] : []));
  if (new Set(headingIds).size !== headingIds.length)
    push("body", "heading anchor ids must be unique");

  // --- media ---
  article.body.forEach((block, index) => {
    if (block.kind === "figure") validateImage(slug, `body[${index}].image`, block.image, issues);
    if (block.kind === "animation") {
      const animation = block.animation;
      if (animation.width <= 0 || animation.height <= 0)
        push(`body[${index}].animation`, "needs real width and height");
      if (animation.description.trim() === "")
        push(`body[${index}].animation`, "needs an accessible description");
      if (animation.kind !== "component") {
        if (animation.src.trim() === "")
          push(`body[${index}].animation`, "needs a source");
        // The static fallback is what reduced-motion readers actually see.
        validateImage(slug, `body[${index}].animation.poster`, animation.poster, issues);
      }
    }
  });
  if (article.hero) validateImage(slug, "hero", article.hero, issues);

  // --- video ---
  if (article.video) {
    const video = article.video;
    if (video.id.trim() === "") push("video.id", "is empty");
    if (!ISO_DATE.test(video.uploadDate)) push("video.uploadDate", "must be an ISO date");
    if (video.durationSeconds <= 0) push("video.durationSeconds", "must be positive");
    if (video.title.trim() === "") push("video.title", "is empty");
  }

  // --- sources ---
  (article.sources ?? []).forEach((source, index) => {
    if (source.title.trim() === "") push(`sources[${index}].title`, "is empty");
    if (!/^https?:\/\//.test(source.url)) push(`sources[${index}].url`, "must be absolute");
  });

  // --- relationships ---
  const related = article.related ?? [];
  if (related.includes(slug)) push("related", "an article cannot relate to itself");
  if (new Set(related).size !== related.length) push("related", "contains a duplicate");
  for (const target of related) {
    const found = library.find((a) => a.slug === target);
    if (!found) push("related", `"${target}" is not in the library`);
    else if (!isPubliclyVisible(found))
      push("related", `"${target}" is not publicly visible`);
  }

  // --- internal links ---
  for (const path of article.internalLinks ?? []) {
    if (!path.startsWith("/")) push("internalLinks", `"${path}" must be a local path`);
    else if (!isKnownInternalPath(path, library))
      push("internalLinks", `"${path}" does not resolve`);
  }

  // --- cta ---
  if (article.cta) {
    if (!article.cta.href.startsWith("/")) push("cta.href", "must be a local path");
    else if (!isKnownInternalPath(article.cta.href, library))
      push("cta.href", `"${article.cta.href}" does not resolve`);
    if (article.cta.label.trim() === "") push("cta.label", "is empty");
  }

  return issues;
}

/** Every issue across a whole library. Empty means the library is well formed. */
export function validateLibrary(library: readonly LearnArticle[]): ArticleIssue[] {
  return library.flatMap((article) => validateArticle(article, library));
}

// ---------------------------------------------------------------------------
// False product-capability claims
// ---------------------------------------------------------------------------

/**
 * THE THING THAT IS ACTUALLY FORBIDDEN, and the correction that named it.
 *
 * Task 3C's first draft banned a vocabulary: no published article could contain
 * "barcode", "employee", "age verification" and so on. That is incompatible
 * with the general-education class the same task introduced — an article
 * explaining how barcode scanning works in a retail shop is exactly the kind of
 * writing Learn exists for, and it was unpublishable.
 *
 * The prohibited thing is not the terminology. It is ATTRIBUTING an unreleased
 * capability TO POS CANVAS:
 *
 *   ALLOWED   "Barcode scanning can help retail stores enter products quickly."
 *   ALLOWED   "Many POS systems use employee PINs to identify staff."
 *   ALLOWED   "POS Canvas does not currently provide barcode scanning."
 *   BLOCKED   "POS Canvas includes barcode scanning."
 *   BLOCKED   "POS Canvas supports employee PIN login."
 *
 * This applies to EVERY publicly visible article regardless of class: a
 * shipped-product article may not claim an unreleased capability either.
 *
 * WHAT THIS CANNOT DO, STATED PLAINLY. It is a sentence-level string check, not
 * a reader. It will not catch a claim spread across two sentences, an implication
 * carried by a heading, or a construction that negates one clause while
 * asserting another ("POS Canvas includes barcode scanning, not employee
 * PINs" — the negation makes this function stand down). It is a floor, not a
 * ceiling, and PRODUCT-TRUTH REVIEW BY A HUMAN REMAINS A REQUIRED EDITORIAL
 * STAGE precisely because deterministic checks cannot understand prose. Anyone
 * tempted to treat a green test as product-truth approval should read this
 * paragraph again.
 */

/** Capabilities that are not released, in the words an article would use. */
const UNRELEASED_CAPABILITIES: readonly string[] = [
  "barcode scanning",
  "barcode scanner",
  "barcode",
  "scanner",
  "employee management",
  "employee pin",
  "employee login",
  "employee accounts",
  "time clock",
  "clock-in",
  "clock in",
  "clock-out",
  "register session",
  "cash drawer",
  "cash movement",
  "age verification",
  "id check",
] as const;

/** How an article refers to the product when making a claim about it. */
const PRODUCT_SUBJECTS: readonly string[] = [
  "pos canvas",
  "poscanvas",
] as const;

/**
 * Words that turn a sentence into a denial or a hypothetical.
 *
 * Deliberately permissive: any of these anywhere in the sentence makes this
 * function stand down. A false negative here is caught by human review; a false
 * POSITIVE would block "POS Canvas does not currently provide barcode
 * scanning", which is a true and useful sentence an article should be able to
 * write.
 */
const NEGATIONS: readonly string[] = [
  "not ",
  "n't",
  " no ",
  "never",
  "cannot",
  "without",
  "lacks",
  "unlike",
  "instead of",
  "other than",
  "yet to",
  "would need",
  "does not",
  "do not",
] as const;

export type CapabilityClaim = { sentence: string; capability: string };

/** Splits prose into sentences. Crude on purpose — the unit is "one claim". */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** All the prose a reader actually sees, as sentences. */
function articleProse(article: LearnArticle): string[] {
  const parts: string[] = [article.title, article.deck];

  for (const block of article.body) {
    if (block.kind === "paragraph") parts.push(block.text);
    if (block.kind === "heading") parts.push(block.text);
    if (block.kind === "list") parts.push(...block.items);
    if (block.kind === "callout") {
      if (block.title) parts.push(block.title);
      parts.push(block.text);
    }
    if (block.kind === "diagram") parts.push(block.caption);
    if (block.kind === "figure" && block.caption) parts.push(block.caption);
  }

  return parts.flatMap(sentences);
}

/**
 * Sentences that attribute an unreleased capability to POS Canvas.
 *
 * Empty means nothing deterministically detectable was found — which is NOT the
 * same as "the article is truthful". See the note above.
 */
export function findFalseCapabilityClaims(article: LearnArticle): CapabilityClaim[] {
  const found: CapabilityClaim[] = [];

  for (const sentence of articleProse(article)) {
    const lower = sentence.toLowerCase();

    // No product subject means no claim ABOUT the product. This is the line
    // that makes general industry writing publishable.
    if (!PRODUCT_SUBJECTS.some((subject) => lower.includes(subject))) continue;

    // A denial or a hypothetical is not a capability claim.
    if (NEGATIONS.some((negation) => lower.includes(negation))) continue;

    for (const capability of UNRELEASED_CAPABILITIES) {
      if (lower.includes(capability)) {
        found.push({ sentence, capability });
        break;
      }
    }
  }

  return found;
}
