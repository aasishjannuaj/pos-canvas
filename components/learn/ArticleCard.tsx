import Link from "next/link";
import {
  CONTENT_TYPE_LABELS,
  TOPICS,
  formatArticleDate,
  type LearnArticle,
} from "@/lib/learn";

// One article, as a card. `featured` is a size, not a different component, so
// the index cannot drift into two ways of representing the same thing.
export default function ArticleCard({
  article,
  featured = false,
}: {
  article: LearnArticle;
  featured?: boolean;
}) {
  return (
    <Link
      href={`/learn/${article.slug}`}
      className={`pc-card pc-card--interactive pc-focusable flex flex-col gap-3 ${
        featured ? "p-7 sm:p-9" : "p-6"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-pc-meta font-semibold uppercase tracking-wider text-brand-teal-deep">
          {TOPICS[article.topic].label}
        </span>
        <span aria-hidden="true" className="text-ink-subtle">
          ·
        </span>
        <span className="text-pc-meta text-ink-subtle">
          {CONTENT_TYPE_LABELS[article.contentType]}
          {/* Only real video gets the indicator — there is no placeholder state. */}
          {article.video ? " · Video" : ""}
        </span>
      </div>

      <h3
        className={`font-semibold tracking-tight text-balance text-ink ${
          featured ? "text-pc-title" : "text-lg"
        }`}
      >
        {article.title}
      </h3>

      <p
        className={`text-pretty leading-relaxed text-ink-muted ${
          featured ? "max-w-pc-prose text-pc-lead" : "text-pc-meta"
        }`}
      >
        {article.deck}
      </p>

      {/* Only publicly visible articles reach a card, and those always carry a
          publication date — but the type no longer guarantees it, and rendering
          "Invalid Date" would be worse than rendering nothing. */}
      {article.publishedAt ? (
        <time
          dateTime={article.publishedAt}
          className="mt-auto pt-2 text-pc-meta text-ink-subtle"
        >
          {formatArticleDate(article.publishedAt)}
        </time>
      ) : null}
    </Link>
  );
}
