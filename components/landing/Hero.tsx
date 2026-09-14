import Link from "next/link";
import { BRAND_TAGLINE } from "@/lib/brand";
import { LANDING_JOURNEY_SHORT } from "@/lib/landingJourney";
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

// Lane 3 Task 2 — the strip is now the SAME journey HowItWorks renders, read
// from lib/landingJourney.ts.
//
// It used to be four labels typed here while the section below was headed
// "in three steps" and listed three, so the page told a visitor two different
// stories about the same product. Neither list could notice the other. One
// module now owns the steps; this renders their short labels and the section
// renders the full ones, and a step added in one place appears in both.
//
// Still unnumbered here: the numerals belong to the walkthrough, and repeating
// them in the hero would make the strip look like a competing list rather than
// a preview of the same one.

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
              which is also why they are dropped below lg, where six chips wrap
              and a chevron would end up opening a line. */}
          <ol className="mt-6 flex flex-wrap items-center justify-center gap-x-2 gap-y-2">
            {LANDING_JOURNEY_SHORT.map((step, index) => (
              <li key={step} className="flex items-center gap-2">
                {index > 0 && (
                  <span aria-hidden="true" className="hidden text-brand-teal-deep lg:inline">
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
