import ArticleCard from "./ArticleCard";
import type { LearnArticle } from "@/lib/learn";

// Renders nothing when there is nothing related — which is the honest state of
// a one-article library, and better than a "Related" heading over an empty row.
export default function RelatedArticles({ articles }: { articles: LearnArticle[] }) {
  if (articles.length === 0) return null;

  return (
    <section aria-labelledby="related" className="mt-14">
      <h2 id="related" className="text-pc-title font-semibold tracking-tight text-ink">
        Keep reading
      </h2>

      <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2">
        {articles.map((article) => (
          <ArticleCard key={article.slug} article={article} />
        ))}
      </div>
    </section>
  );
}
