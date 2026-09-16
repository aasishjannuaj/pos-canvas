import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Navbar from "@/components/landing/Navbar";
import Footer from "@/components/landing/Footer";
import ArticleBody from "@/components/learn/ArticleBody";
import ArticleMeta from "@/components/learn/ArticleMeta";
import RelatedArticles from "@/components/learn/RelatedArticles";
import SourceList from "@/components/learn/SourceList";
import { learnArticles } from "@/data/learn";
import {
  articleOgDescription,
  articleOgTitle,
  articlePath,
  articleSeoDescription,
  articleSeoTitle,
  findPublishedArticle,
  publishedArticles,
  relatedArticles,
} from "@/lib/learn";
import {
  absoluteUrl,
  buildArticleJsonLd,
  buildBreadcrumbJsonLd,
  buildOpenGraph,
} from "@/lib/seo";

// One Learn article.
//
// UNKNOWN AND DRAFT SLUGS BOTH 404 — a real 404, not a styled "not found" page
// returning 200. /templates/[id] deliberately renders an unavailable state at
// 200 because Feature 12.1 wanted a way back; this route has no such
// requirement, so it takes the better search behaviour instead. notFound()
// gives Next's not-found page with an HTTP 404, which is not indexable and
// cannot become an unlimited supply of thin pages.
//
// A DRAFT IS INDISTINGUISHABLE FROM A TYPO, and that is intentional.
// findPublishedArticle only ever returns published articles, so a draft has no
// public URL at all — not a preview, not a 200, nothing to leak or to index.
// Reviewing a draft happens in the pull request, where the content lives.

/**
 * Only published articles are prerendered.
 *
 * Six template pages are dynamic because their ids come from a registry that a
 * project can extend; the Learn library is fully known at build time, so every
 * article is static and a request for anything else falls through to notFound().
 */
export function generateStaticParams() {
  return publishedArticles(learnArticles).map((article) => ({
    slug: article.slug,
  }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const article = findPublishedArticle(learnArticles, slug);

  // Next renders the 404 for this case; the metadata is only what the
  // not-found response carries.
  if (!article) return { title: "Not found" };

  // Every value DERIVED from the article unless the package overrode it, so an
  // editor never retypes the same sentence into four fields. The canonical is
  // not overridable at all: it comes from the slug and the one approved origin.
  const path = articlePath(article);

  return {
    title: articleSeoTitle(article),
    description: articleSeoDescription(article),
    alternates: { canonical: absoluteUrl(path) },
    openGraph: buildOpenGraph({
      title: articleOgTitle(article),
      description: articleOgDescription(article),
      path,
    }),
  };
}

export default async function LearnArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const article = findPublishedArticle(learnArticles, slug);

  if (!article) notFound();

  const path = articlePath(article);
  const related = relatedArticles(learnArticles, article);

  return (
    <main className="min-h-screen bg-brand-cream">
      {/* Article + BreadcrumbList. Both describe things that are true of this
          page: the article's own metadata, and the trail the reader can
          actually walk back up. No VideoObject — this article has no video,
          and lib/seo.ts has no builder to emit one from nothing. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify([
            buildArticleJsonLd({
              // The same derived values the page renders and the metadata
              // declares — schema that disagrees with the visible page is the
              // thing structured-data penalties exist for.
              title: articleSeoTitle(article),
              description: articleSeoDescription(article),
              path,
              publishedAt: article.publishedAt,
              updatedAt: article.updatedAt,
            }),
            buildBreadcrumbJsonLd([
              { name: "Home", path: "/" },
              { name: "Learn", path: "/learn" },
              { name: article.title, path },
            ]),
          ]),
        }}
      />

      <Navbar />

      <article className="bg-brand-cream">
        {/* The reading column is CENTRED, not left-aligned in a 1440px
            container. Left-aligned, the article sat against the left gutter
            with two-thirds of a desktop screen empty beside it — measured, in
            the 1440px capture. `.pc-prose` still caps the line length at 68ch;
            this only decides where that column sits. */}
        <div className="pc-container pc-section mx-auto max-w-3xl">
          {/* The visible breadcrumb the schema describes. */}
          <nav aria-label="Breadcrumb" className="mb-8">
            <Link href="/learn" className="pc-textlink text-pc-meta">
              &larr; All of Learn
            </Link>
          </nav>

          <header className="flex max-w-pc-prose flex-col gap-5">
            <ArticleMeta article={article} />

            <h1 className="text-pc-display font-semibold text-balance text-ink">
              {article.title}
            </h1>

            <p className="text-pc-lead text-pretty text-ink-muted">
              {article.deck}
            </p>
          </header>

          <div className="mt-12">
            <ArticleBody blocks={article.body} />
          </div>

          {article.editorialNote ? (
            /* AI-transparency disclosure, rendered only when the package
               carries one. Google's guidance is that AI should not get an
               author byline, while an automation disclosure is useful where a
               reader might ask "how was this made?". No invented person. */
            <p className="mt-12 max-w-pc-prose text-pc-meta text-ink-subtle">
              {article.editorialNote}
            </p>
          ) : null}

          <SourceList sources={article.sources} />

          {article.cta ? (
            <aside className="pc-panel mt-14 flex max-w-pc-prose flex-col items-start gap-4 p-7">
              <p className="text-pc-body font-semibold text-ink">
                See how it works for your own products.
              </p>
              <Link
                href={article.cta.href}
                className="pc-button pc-button--primary"
              >
                {article.cta.label}
              </Link>
            </aside>
          ) : null}

          <RelatedArticles articles={related} />
        </div>
      </article>

      <Footer />
    </main>
  );
}
