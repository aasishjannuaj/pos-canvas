import Link from "next/link";
import ArticleCard from "@/components/learn/ArticleCard";
import { learnArticles } from "@/data/learn";
import { publishedArticles, type LearnArticle } from "@/lib/learn";

// Lane 3 Task 3C — Learn, on the homepage.
//
// SMALL BY DESIGN. The homepage is a product page, not a feed. This surfaces
// the most recent writing and a way into the library, and then stops: no
// pagination, no topic rail, no "load more". At most three cards, because a
// fourth starts to read as a blog index bolted onto a landing page.
//
// THE ONE-ARTICLE STATE IS THE STATE WE ACTUALLY HAVE, so it is designed
// rather than tolerated: a single card sits at the width of the reading
// column beside the section's own copy, which looks deliberate. Two or three
// fill a row. The grid is driven by how many articles there are, so nothing
// here needs revisiting when the second one is published.
//
// FILTERING IS NOT REIMPLEMENTED HERE. publishedArticles() is the same
// function /learn, /learn/[slug] and the sitemap use, so a draft or a
// truth-ineligible article cannot appear on the homepage by a route the other
// surfaces do not share. A second filter written locally is exactly how a
// draft leaks onto the busiest page on the site.
//
// RENDERS NOTHING WHEN THE LIBRARY IS EMPTY. An empty "Learn" heading on the
// homepage would be worse than no section at all.
const HOMEPAGE_ARTICLE_LIMIT = 3;

export default function LearnDiscovery() {
  const articles: LearnArticle[] = publishedArticles(learnArticles).slice(
    0,
    HOMEPAGE_ARTICLE_LIMIT
  );

  if (articles.length === 0) return null;

  const isSingle = articles.length === 1;

  return (
    <section className="bg-surface-mint">
      <div className="pc-container pc-section">
        <div
          className={
            isSingle
              ? "flex flex-col gap-10 lg:flex-row lg:items-center lg:gap-16"
              : "flex flex-col gap-10"
          }
        >
          <div className={isSingle ? "flex flex-col gap-4 lg:max-w-sm" : "flex flex-col gap-4"}>
            <p className="pc-eyebrow">Learn</p>

            <h2 className="text-pc-title font-semibold text-balance text-ink">
              Learn from POS Canvas
            </h2>

            <p className="max-w-pc-prose text-pc-body text-pretty text-ink-muted">
              Practical writing for people opening and running small businesses:
              how a point of sale works, and how this one does it.
            </p>

            <Link
              href="/learn"
              className="pc-button pc-button--secondary mt-2 self-start"
            >
              View all Learn content
            </Link>
          </div>

          <div
            className={
              isSingle
                ? "lg:flex-1"
                : "grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3"
            }
          >
            {articles.map((article) => (
              <ArticleCard key={article.slug} article={article} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
