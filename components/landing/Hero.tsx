import Link from "next/link";
import { BRAND_TAGLINE } from "@/lib/brand";
import { LANDING_ROUTES, LANDING_SECTION_ANCHORS } from "@/lib/landingNav";

// Navigation fix — "Start Building" was a <button type="button"> with no
// onClick and no href, so it silently did nothing. It is now a real Link to
// /templates (the public template gallery), which is the correct entry point
// for starting a build regardless of auth state: /templates is not
// proxy-protected, so a visitor can browse before being asked to sign in at
// the /editor step.
//
// Lane 3 Task 1 — the hero now states WHAT THE PRODUCT IS before asking for a
// click. The previous copy ("Build your own POS system without writing code")
// described a builder and stopped there, so a visitor learned nothing about
// what happens after they customise something. The flow below is the product
// that actually shipped in 1.2.0 and nothing more: publish a configuration,
// install the one universal POS Canvas app, pair the device. No employee,
// workforce, liquor, barcode or reporting capability is named, because none of
// those is released.
//
// Destinations are unchanged. "Start Building" is still LANDING_ROUTES.templates
// and "See Templates" is still the in-page LANDING_SECTION_ANCHORS.templates,
// which is what lib/landingNav.test.ts asserts.

// The shape of the product, in the order an owner meets it. Deliberately not
// numbered: components/landing/HowItWorks.tsx owns the numbered walkthrough,
// and two competing step counts on one page would be worse than one.
const FLOW = ["Choose a template", "Customize", "Publish", "Install & pair"];

export default function Hero() {
  return (
    <section className="bg-brand-cream">
      <div className="pc-container pc-section--hero">
        <div className="mx-auto flex max-w-pc-narrow flex-col items-center gap-6 text-center">
          <p className="pc-eyebrow">{BRAND_TAGLINE}</p>

          <h1 className="text-pc-display font-semibold text-balance text-ink">
            Design your point of sale.
            <br className="hidden sm:block" /> Then run your business on it.
          </h1>

          <p className="max-w-pc-prose text-pc-lead text-pretty text-ink-muted">
            Start from a template built for your kind of business, customize the
            items, pricing and layout, then publish it and pair the POS Canvas
            app on your device. No code anywhere.
          </p>

          <div className="mt-2 flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center">
            <Link
              href={LANDING_ROUTES.templates}
              className="pc-button pc-button--primary pc-button--lg"
            >
              Start Building
            </Link>

            <a
              href={LANDING_SECTION_ANCHORS.templates}
              className="pc-button pc-button--secondary pc-button--lg"
            >
              See Templates
            </a>
          </div>

          {/* A list, not a decorated sentence: a screen reader gets four items
              in order, and the chevrons between them are presentational only —
              which is also why they are dropped below md, where the row wraps
              and a chevron would end up opening a line. */}
          <ol className="mt-6 flex flex-wrap items-center justify-center gap-x-2 gap-y-2">
            {FLOW.map((step, index) => (
              <li key={step} className="flex items-center gap-2">
                {index > 0 && (
                  <span aria-hidden="true" className="hidden text-brand-teal-deep md:inline">
                    &rarr;
                  </span>
                )}
                <span className="pc-chip">{step}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
