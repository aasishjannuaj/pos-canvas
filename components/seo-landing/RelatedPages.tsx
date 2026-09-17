import Link from "next/link";

// Lane 3 Task 4 — "keep reading" links at the foot of an SEO landing page.
//
// CHOSEN PER PAGE, NOT GENERATED. Each page passes the few pages that answer
// the reader's likely next question, with a sentence saying why. A block that
// listed every landing page on every landing page would be the link dump the
// task ruled out, and it would tell a crawler nothing about how the pages
// relate.
//
// A named navigation landmark, because it is a set of links to other pages.
// The link is the title alone, so its accessible name is short and descriptive;
// the sentence under it is supporting text, not part of the link.

export type RelatedPage = {
  href: string;
  title: string;
  description: string;
};

type RelatedPagesProps = {
  pages: readonly RelatedPage[];
};

export default function RelatedPages({ pages }: RelatedPagesProps) {
  if (pages.length === 0) {
    return null;
  }

  return (
    <nav aria-labelledby="related-pages-heading" className="bg-brand-cream">
      <div className="pc-container pc-section">
        <h2
          id="related-pages-heading"
          className="text-pc-meta font-semibold uppercase tracking-wider text-ink-subtle"
        >
          Keep reading
        </h2>

        <ul className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-2">
          {pages.map((page) => (
            <li key={page.href} className="pc-card flex flex-col gap-2 p-6">
              <Link
                href={page.href}
                className="pc-textlink text-lg font-semibold tracking-tight"
              >
                {page.title}
              </Link>
              <p className="text-pc-meta leading-relaxed text-ink-muted">
                {page.description}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
