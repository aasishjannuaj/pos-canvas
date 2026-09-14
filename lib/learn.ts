// POS Canvas Learn — the content model, and the rules that keep it honest.
//
// NO CMS, NO DATABASE, ON PURPOSE. Articles are typed data in data/learn.ts.
// That makes the whole library reviewable in a pull request, diffable, and
// testable by the same guards that protect the rest of the marketing surface —
// which matters more than authoring convenience while the library is small and
// while a future automated writer will be proposing drafts into it.
//
// THE ONE RULE THIS MODULE EXISTS TO ENFORCE. POS Canvas has three product
// states: SHIPPED, IMPLEMENTED BUT NOT RELEASED, and PLANNED. v1.3 is building
// employee, barcode and register features RIGHT NOW, which is exactly the
// situation where an article gets written about something a reader cannot yet
// use. Every article declares which state(s) its claims rest on, and
// `canPublish` refuses to publish one that rests on anything but SHIPPED. It is
// a small field and a three-line function, and it is the difference between an
// editorial process that catches that and one that hopes.
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

/** DRAFT and PUBLISHED only. A third status would need a behaviour to justify it. */
export type ArticleStatus = "draft" | "published";

/** The three product states the whole project already reasons in. */
export type ProductTruthState = "shipped" | "implemented-not-released" | "planned";

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

/**
 * An image with its real dimensions.
 *
 * width/height are REQUIRED so every image reserves its space and cannot shift
 * the page as it loads. `decorative` drives alt="" rather than inviting a
 * keyword-stuffed description of a flourish.
 */
export type ArticleImage = {
  src: string;
  alt: string;
  width: number;
  height: number;
  decorative?: boolean;
  /** Set for real product screenshots so the template can caption them as such. */
  isProductScreenshot?: boolean;
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

export type ArticleBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; level: 2 | 3; id: string; text: string }
  | { kind: "list"; ordered?: boolean; items: string[] }
  | { kind: "callout"; tone: "note" | "caution"; title?: string; text: string }
  | { kind: "diagram"; name: DiagramName; caption: string }
  | { kind: "figure"; image: ArticleImage; caption?: string };

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
  /** ISO date (YYYY-MM-DD). */
  publishedAt: string;
  updatedAt?: string;
  hero?: ArticleImage;
  body: ArticleBlock[];
  sources?: ArticleSource[];
  /** Slugs. Resolved against the library, so a typo renders nothing rather than a broken link. */
  related?: string[];
  cta?: { label: string; href: string };
  video?: ArticleVideo;
  /**
   * THE EDITORIAL SAFEGUARD. Which product states this article's claims rest
   * on. A published article may rest only on "shipped" — see canPublish.
   */
  productTruthBasis: ProductTruthState[];
  /** Optional free text for a reviewer: what was checked, and against what. */
  releaseTruthNotes?: string;
};

// ---------------------------------------------------------------------------
// Rules and selectors — pure, so the guards can exercise them directly
// ---------------------------------------------------------------------------

/**
 * May this article be published?
 *
 * A published article may rest ONLY on shipped functionality. An article about
 * employee PINs or barcode scanning declares "implemented-not-released" and is
 * refused publication by this function until the release changes that — which
 * is the whole point: the refusal is mechanical rather than remembered.
 */
export function canPublish(article: LearnArticle): boolean {
  return (
    article.productTruthBasis.length > 0 &&
    article.productTruthBasis.every((state) => state === "shipped")
  );
}

/**
 * The public library.
 *
 * Two filters, not one. `status === "published"` is the editor's intent;
 * `canPublish` is the product-truth rule. An article marked published that
 * rests on unreleased work is dropped here rather than trusted — so the
 * mistake is invisible to the public instead of live on the site. The guards
 * fail on it separately, so it is not silently swallowed either.
 */
export function publishedArticles(articles: readonly LearnArticle[]): LearnArticle[] {
  return articles
    .filter((article) => article.status === "published" && canPublish(article))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
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
