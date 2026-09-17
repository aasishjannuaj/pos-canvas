import Image from "next/image";
import SectionHeading from "./SectionHeading";
import { templates } from "@/data/templates";
import { BUILDER_CAFE_PRODUCTS } from "@/data/productMedia";

// Lane 3 Task 2 — this section used to be a bare list of eight industry names
// under the heading "Built for every kind of business". It asserted breadth
// and explained nothing, and two of the names it listed ("Barbers",
// "Convenience Stores") had no template behind them, so the list quietly
// implied more than the registry contains.
//
// It now does the job the homepage was missing: saying WHAT THE PRODUCT IS.
// The model is one configurable point of sale, not a family of industry
// systems — all six templates run the identical engine and differ only in
// their starter configuration and layout (see the Feature 12.1 correction note
// in data/templates.ts). An owner needs to understand "I start from something
// close to my business, then change it", and that sentence is the section.
//
// THE CHIPS COME FROM THE REGISTRY. Deriving the categories from
// data/templates.ts means this section cannot claim a business type that has
// no template, and a seventh template appears here automatically. The closing
// line is what keeps the list honest for everyone else: starting from the
// nearest template and changing it is genuinely how the product works, so
// saying so is more useful than padding the list with names.

// Set, not map: two templates could share a category, and the chips should
// show it once. Insertion order is the registry's order.
const TEMPLATE_CATEGORIES = [...new Set(templates.map((t) => t.category))];

export default function BusinessTypes() {
  return (
    <section className="bg-brand-cream">
      <div className="pc-container pc-section">
        <SectionHeading
          eyebrow="One platform"
          title="One point of sale, set up differently for every business"
          subtitle="POS Canvas is a single product. A template sets the layout your screen uses. It also fills in a starting catalogue — the products and the categories — and that part is yours to change. Checkout, receipts and reporting work the same way whichever one you start from."
        />

        <ul className="mx-auto mt-10 flex max-w-3xl flex-wrap items-center justify-center gap-2.5">
          {TEMPLATE_CATEGORIES.map((category) => (
            <li key={category} className="pc-chip">
              {category}
            </li>
          ))}
        </ul>

        <p className="mx-auto mt-6 max-w-pc-prose text-center text-pc-meta text-ink-subtle">
          Selling something that is not on this list? Start from the closest
          template and change it until it fits.
        </p>

        {/* Lane 3 Task 3D — the one place a real product screenshot earns its
            space on the homepage. This section says "everything after that is
            yours to change" in prose; the capture shows it: the actual Builder,
            a template's catalogue and prices, and the point of sale beside
            them. It supports the explanation rather than replacing it, which
            is why it sits under the copy and not above it.

            Rendered from the provenance record in data/productMedia.ts, so the
            dimensions, alt text and caption are the reviewed ones. The internal
            capture metadata is never rendered. Lazy by default: this section is
            well below the fold. */}
        <figure className="pc-card mx-auto mt-12 max-w-5xl p-3 sm:p-4">
          {/* Narrow screens only. The screenshot keeps a readable width there
              and scrolls inside its own viewport; this line says so, because
              an image running off the edge otherwise just looks cropped.
              Visual guidance only — a screen reader gets the alt text. */}
          <p
            aria-hidden="true"
            className="mb-2 px-1 text-pc-meta text-ink-subtle lg:hidden"
          >
            Scroll sideways to see the whole screenshot &rarr;
          </p>

          {/* The scroll viewport. Focusable and named, so a keyboard user can
              scroll it with the arrow keys — a scrollable region that cannot
              take focus is unreachable without a pointer. Named by the
              caption rather than by a second string. CSS alone decides when it
              scrolls; there is no client JavaScript here. */}
          <div
            className="pc-screenshot-viewport pc-focusable"
            tabIndex={0}
            role="region"
            aria-labelledby="builder-screenshot-caption"
          >
            <Image
              src={BUILDER_CAFE_PRODUCTS.src}
              alt={BUILDER_CAFE_PRODUCTS.alt}
              width={BUILDER_CAFE_PRODUCTS.width}
              height={BUILDER_CAFE_PRODUCTS.height}
              // Below 1024px the image is held at 992px (62rem) and scrolls,
              // so it must be fetched for that width, not for the viewport.
              sizes="(min-width: 1080px) 1000px, (min-width: 1024px) 94vw, 992px"
              className="pc-screenshot-viewport__image h-auto w-full"
            />
          </div>

          <figcaption className="mt-3 flex flex-wrap items-center justify-between gap-2 px-1 text-pc-meta text-ink-subtle">
            <span id="builder-screenshot-caption">
              {BUILDER_CAFE_PRODUCTS.caption}
            </span>
            <span className="font-semibold uppercase tracking-wider text-brand-teal-deep">
              POS Canvas screenshot
            </span>
          </figcaption>
        </figure>
      </div>
    </section>
  );
}
