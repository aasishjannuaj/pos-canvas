import SectionHeading from "./SectionHeading";
import { templates } from "@/data/templates";

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
          subtitle="POS Canvas is a single product. A template decides what your screen starts with — the products, the categories, the layout — and everything after that is yours to change. Checkout, receipts and reporting work the same way whichever one you start from."
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
      </div>
    </section>
  );
}
