import type { Metadata } from "next";
import Link from "next/link";
import Navbar from "@/components/landing/Navbar";
import Footer from "@/components/landing/Footer";
import ArticleCard from "@/components/learn/ArticleCard";
import { learnArticles } from "@/data/learn";
import {
  TOPICS,
  featuredArticle,
  publishedArticles,
  recentArticles,
  shouldShowTopicNav,
  visibleTopics,
} from "@/lib/learn";
import { absoluteUrl, buildOpenGraph } from "@/lib/seo";

// POS Canvas Learn — the hub.
//
// A SERVER COMPONENT WITH NO CLIENT JAVASCRIPT. The library is typed data, the
// filtering is pure functions, and the page is links. There is no search box,
// no filter state and no dependency, which is why /learn adds nothing to the
// client bundle.
//
// NO SEARCH, NO FILTERS, AND THAT IS A DECISION. The brief allowed them only
// if justified by the amount of content. With one published article a search
// box filters nothing and a topic filter offers one option — the same dead
// control Feature 22 deleted from the template gallery, where a filter that
// appeared to do nothing read as a broken product. Topic navigation appears on
// its own once two topics actually have articles (shouldShowTopicNav), so the
// control arrives with the content that needs it.
export const metadata: Metadata = {
  title: "Learn",
  description:
    "Practical guides to running a point of sale, and how POS Canvas works: " +
    "templates, publishing, devices and pairing.",
  alternates: { canonical: absoluteUrl("/learn") },
  openGraph: buildOpenGraph({
    title: "POS Canvas Learn",
    description:
      "Practical guides to running a point of sale, and how POS Canvas works.",
    path: "/learn",
  }),
};

export default function LearnPage() {
  const published = publishedArticles(learnArticles);
  const featured = featuredArticle(learnArticles);
  const rest = featured ? recentArticles(learnArticles, featured.slug) : [];
  const showTopics = shouldShowTopicNav(learnArticles);

  return (
    <main className="min-h-screen bg-brand-cream">
      <Navbar />

      <section className="bg-brand-cream">
        <div className="pc-container pc-section">
          <div className="flex max-w-pc-narrow flex-col gap-5">
            <p className="pc-eyebrow">Learn</p>

            <h1 className="text-pc-display font-semibold text-balance text-ink">
              Working out how to run a till
            </h1>

            <p className="max-w-pc-prose text-pc-lead text-pretty text-ink-muted">
              Practical writing for people opening and running small
              businesses — how a point of sale actually works, and how POS
              Canvas does it.
            </p>
          </div>

          {showTopics ? (
            <nav aria-label="Topics" className="mt-10 flex flex-wrap gap-2.5">
              {visibleTopics(learnArticles).map((topic) => (
                <span key={topic} className="pc-chip">
                  {TOPICS[topic].label}
                </span>
              ))}
            </nav>
          ) : null}
        </div>
      </section>

      <section className="bg-surface-raised">
        <div className="pc-container pc-section">
          {published.length === 0 ? (
            /* THE SPARSE STATE IS A REAL STATE, not a placeholder grid. An
               empty library says so and sends the reader somewhere useful,
               rather than filling the page with cards for articles that do
               not exist. */
            <div className="pc-panel mx-auto flex max-w-pc-prose flex-col items-start gap-4 p-8">
              <h2 className="text-pc-title font-semibold tracking-tight text-ink">
                Nothing published yet
              </h2>
              <p className="text-pc-body text-ink-muted">
                The first guides are being written. In the meantime, the
                templates are the quickest way to see how POS Canvas works.
              </p>
              <Link href="/templates" className="pc-button pc-button--primary">
                Browse the templates
              </Link>
            </div>
          ) : (
            <>
              {featured ? (
                <>
                  <h2 className="text-pc-meta font-semibold uppercase tracking-wider text-ink-subtle">
                    Latest
                  </h2>
                  <div className="mt-5">
                    <ArticleCard article={featured} featured />
                  </div>
                </>
              ) : null}

              {rest.length > 0 ? (
                <>
                  <h2 className="mt-14 text-pc-meta font-semibold uppercase tracking-wider text-ink-subtle">
                    More from Learn
                  </h2>
                  <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                    {rest.map((article) => (
                      <ArticleCard key={article.slug} article={article} />
                    ))}
                  </div>
                </>
              ) : null}
            </>
          )}
        </div>
      </section>

      <Footer />
    </main>
  );
}
