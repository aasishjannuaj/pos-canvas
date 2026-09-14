import type { ArticleSource } from "@/lib/learn";

// Citations. Renders nothing when an article has none, rather than an empty
// "Sources" heading implying research that did not happen.
//
// Every optional field is genuinely optional: a publisher or a date that is not
// known is omitted, not guessed. External links carry rel="noopener noreferrer"
// and are described by their own title, so "click here" never appears.
export default function SourceList({ sources }: { sources?: ArticleSource[] }) {
  if (!sources || sources.length === 0) return null;

  return (
    <section aria-labelledby="sources" className="mt-14">
      <h2
        id="sources"
        className="text-pc-meta font-semibold uppercase tracking-wider text-ink"
      >
        Sources
      </h2>

      <ol className="mt-4 flex max-w-pc-prose flex-col gap-3">
        {sources.map((source) => (
          <li key={source.url} className="text-pc-meta leading-relaxed text-ink-muted">
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="pc-textlink"
            >
              {source.title}
            </a>
            {source.publisher ? ` — ${source.publisher}` : ""}
            {source.publishedAt ? ` (${source.publishedAt})` : ""}
            {source.accessedAt ? ` · accessed ${source.accessedAt}` : ""}
          </li>
        ))}
      </ol>
    </section>
  );
}
