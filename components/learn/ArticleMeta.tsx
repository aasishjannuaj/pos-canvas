import {
  CONTENT_TYPE_LABELS,
  TOPICS,
  formatArticleDate,
  type LearnArticle,
} from "@/lib/learn";

// The byline row. NO AUTHOR: there is no approved author identity for POS
// Canvas content, and inventing one — a name, a job title, a photo — is the
// single most common fabrication on a content site. What is shown here is
// what is actually known: topic, type, and dates.
export default function ArticleMeta({ article }: { article: LearnArticle }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-pc-meta text-ink-subtle">
      <span className="font-semibold uppercase tracking-wider text-brand-teal-deep">
        {TOPICS[article.topic].label}
      </span>
      <span aria-hidden="true">·</span>
      <span>{CONTENT_TYPE_LABELS[article.contentType]}</span>
      {article.publishedAt ? (
        <>
          <span aria-hidden="true">·</span>
          <time dateTime={article.publishedAt}>
            {formatArticleDate(article.publishedAt)}
          </time>
        </>
      ) : null}
      {article.updatedAt ? (
        <>
          <span aria-hidden="true">·</span>
          <span>
            Updated{" "}
            <time dateTime={article.updatedAt}>
              {formatArticleDate(article.updatedAt)}
            </time>
          </span>
        </>
      ) : null}
    </div>
  );
}
