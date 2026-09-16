import PublishAndPairDiagram from "./diagrams/PublishAndPairDiagram";
import type {
  AnimationName,
  ArticleAnimation,
  ArticleBlock,
  ArticleImage,
  DiagramName,
} from "@/lib/learn";
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

/**
 * Reviewed animation components, by name — the same rule as diagrams.
 *
 * Empty, because `AnimationName` is `never`: no article needs a component
 * animation, and adding one to populate the registry would be decoration. A
 * real one is added here and to the type in the same change.
 */
const ANIMATIONS: Record<AnimationName, () => React.JSX.Element> = {};

/** A caption a screen reader associates with its figure, or nothing at all. */
function Caption({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <figcaption className="mt-4 text-pc-meta text-ink-subtle">{text}</figcaption>
  );
}

/**
 * One image, sized and labelled from its own record.
 *
 * A real product screenshot is framed and captioned as one, so a reader can
 * tell evidence from illustration without taking anyone's word for it.
 */
function ArticleFigureImage({ image }: { image: ArticleImage }) {
  const isScreenshot = image.provenance === "real-product-screenshot";

  return (
    <Image
      src={image.src}
      alt={image.decorative ? "" : image.alt}
      width={image.width}
      height={image.height}
      className={`h-auto w-full ${isScreenshot ? "rounded-pc-sm border border-hairline" : ""}`}
      sizes="(min-width: 768px) 68ch, 100vw"
      // Article media sits below the fold by definition — the title and deck
      // are above it — so nothing here competes with the page's own paint.
      loading="lazy"
    />
  );
}

/**
 * Motion, with the static fallback doing real work.
 *
 * BOTH ARE IN THE DOM AND CSS CHOOSES. `.pc-animation` shows the moving asset
 * and hides the poster; under `prefers-reduced-motion: reduce` it swaps them.
 * That keeps the whole thing a Server Component — no client JavaScript decides
 * whether a reader sees motion — and a reader who asked for less gets the
 * still image rather than a paused video.
 *
 * `<video>` rather than an <img> for animated WebP: it takes a poster
 * attribute, it can be muted and looped without controls, and it never carries
 * audio. Nothing here autoplays sound.
 */
function ArticleAnimationFigure({ animation }: { animation: ArticleAnimation }) {
  if (animation.kind === "component") {
    // `AnimationName` is `never` today, so no article can construct this
    // variant and the branch is provably unreachable. It is written out rather
    // than thrown away so that adding a reviewed component animation is one
    // change — a name on the type and an entry in ANIMATIONS — instead of a
    // new code path invented under time pressure.
    const Animation = ANIMATIONS[animation.name] as
      | (() => React.JSX.Element)
      | undefined;
    return Animation ? <Animation /> : null;
  }

  return (
    <div className="pc-animation" style={{ aspectRatio: `${animation.width} / ${animation.height}` }}>
      <video
        className="pc-animation__motion h-auto w-full"
        width={animation.width}
        height={animation.height}
        poster={animation.poster.src}
        aria-label={animation.description}
        autoPlay
        muted
        loop
        playsInline
        preload={animation.loading === "eager" ? "auto" : "none"}
      >
        <source
          src={animation.src}
          type={animation.kind === "animated-webp" ? "image/webp" : "video/mp4"}
        />
      </video>

      {/* What a reduced-motion reader sees, and the fallback if the asset
          fails. It carries the accessible description, so the meaning does not
          depend on the motion playing. */}
      <Image
        className="pc-animation__still h-auto w-full"
        src={animation.poster.src}
        alt={animation.description}
        width={animation.poster.width}
        height={animation.poster.height}
        sizes="(min-width: 768px) 68ch, 100vw"
        loading="lazy"
      />
    </div>
  );
}

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

          case "figure": {
            // The caption may live on the block or on the image record; the
            // block wins, because it is the more specific placement.
            const caption = block.caption ?? block.image.caption;

            return (
              <figure key={key} className="pc-card p-5">
                <ArticleFigureImage image={block.image} />
                {block.image.provenance === "real-product-screenshot" ? (
                  <p className="mt-3 text-pc-meta font-semibold uppercase tracking-wider text-brand-teal-deep">
                    POS Canvas screenshot
                  </p>
                ) : null}
                <Caption text={caption} />
              </figure>
            );
          }

          case "animation":
            return (
              <figure key={key} className="pc-card p-5">
                <ArticleAnimationFigure animation={block.animation} />
                <Caption text={block.animation.caption} />
              </figure>
            );
        }
      })}
    </div>
  );
}
