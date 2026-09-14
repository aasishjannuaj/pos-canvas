import PublishAndPairDiagram from "./diagrams/PublishAndPairDiagram";
import type { ArticleBlock, DiagramName } from "@/lib/learn";
import Image from "next/image";

// The block renderer.
//
// WHY BLOCKS RATHER THAN MARKDOWN OR MDX. Both would have meant a dependency,
// and MDX would have meant arbitrary JSX inside content — which is the wrong
// shape entirely for a library a future automated writer will be proposing
// drafts into. A typed block union is something a machine can emit and a guard
// can check, and every block maps to a design-system primitive rather than to
// free-form markup.
//
// Diagrams are looked up by NAME in this registry, so an article can only
// reference a drawing that exists as a reviewed component.
const DIAGRAMS: Record<DiagramName, () => React.JSX.Element> = {
  "publish-and-pair": PublishAndPairDiagram,
};

export default function ArticleBody({ blocks }: { blocks: ArticleBlock[] }) {
  return (
    <div className="pc-prose">
      {blocks.map((block, index) => {
        const key = `${block.kind}-${index}`;

        switch (block.kind) {
          case "paragraph":
            return <p key={key}>{block.text}</p>;

          case "heading":
            // The level comes from the data, so the document outline is the
            // author's decision rather than a side effect of what looked right.
            return block.level === 2 ? (
              <h2 key={key} id={block.id}>
                {block.text}
              </h2>
            ) : (
              <h3 key={key} id={block.id}>
                {block.text}
              </h3>
            );

          case "list":
            return block.ordered ? (
              <ol key={key}>
                {block.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ol>
            ) : (
              <ul key={key}>
                {block.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            );

          case "callout":
            return (
              <aside
                key={key}
                className={`pc-callout ${
                  block.tone === "caution" ? "pc-callout--caution" : ""
                }`}
              >
                {block.title ? (
                  <p className="text-pc-meta font-semibold uppercase tracking-wider text-brand-teal-deep">
                    {block.title}
                  </p>
                ) : null}
                <p className="mt-1 text-pc-meta leading-relaxed text-ink">
                  {block.text}
                </p>
              </aside>
            );

          case "diagram": {
            const Diagram = DIAGRAMS[block.name];

            // figure/figcaption, so the caption is programmatically tied to the
            // drawing rather than being a paragraph that happens to sit under it.
            return (
              <figure key={key} className="pc-card p-5">
                <Diagram />
                <figcaption className="mt-4 text-pc-meta text-ink-subtle">
                  {block.caption}
                </figcaption>
              </figure>
            );
          }

          case "figure":
            return (
              <figure key={key} className="pc-card overflow-hidden p-0">
                <Image
                  src={block.image.src}
                  alt={block.image.decorative ? "" : block.image.alt}
                  width={block.image.width}
                  height={block.image.height}
                  className="h-auto w-full"
                  sizes="(min-width: 768px) 68ch, 100vw"
                />
                {block.caption ? (
                  <figcaption className="border-t border-hairline px-5 py-3 text-pc-meta text-ink-subtle">
                    {block.caption}
                  </figcaption>
                ) : null}
              </figure>
            );
        }
      })}
    </div>
  );
}
