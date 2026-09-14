import Link from "next/link";
import { LANDING_ROUTES } from "@/lib/landingNav";

// Navigation fix — this bottom "Start Building" call to action was a
// <button type="button"> with no onClick and no href, so it silently did
// nothing. Now a real Link to /templates, matching the Hero CTA's
// destination so the same label always goes to the same place.
//
// Lane 3 Task 2 — the band was `bg-blue-600` with white text, which is the
// single most generic thing a SaaS landing page can do and had no relationship
// to the product's palette. It is now the approved primary teal with ink text
// (6.97:1), the one full-bleed brand-coloured surface on the page, and the
// button is the design system's inverse variant so it reads as the loudest
// element on the loudest section.
//
// The focus ring comes with the surface: `.pc-surface-teal` overrides
// --pc-focus-color to ink, because the site-wide deep-teal ring carries only
// 1.37:1 against this background and would be effectively invisible here.
//
// DESTINATION UNCHANGED, AND DELIBERATELY NOT AUTH-AWARE. /templates is public
// and is the right next step for a signed-out visitor and a signed-in owner
// alike. The header already resolves auth state through
// getLandingPrimaryAction(); adding a second, independent notion of "where
// should this person go" down here would be a second auth-dependent path to
// keep in sync, for no gain.
//
// NO PRICING, NO TRIAL TERMS, NO GUARANTEES, NO COUNTS. None of those exist as
// product facts, so none of them appears — see lib/brand.ts, which holds null
// rather than a plausible-looking placeholder for exactly this reason.
export default function CTASection() {
  return (
    <section className="pc-surface-teal">
      <div className="pc-container pc-section flex flex-col items-center gap-6 text-center">
        <h2 className="max-w-pc-narrow text-pc-title font-semibold text-balance text-ink">
          Your point of sale is a template away
        </h2>

        <p className="max-w-pc-prose text-pc-lead text-pretty text-ink">
          Open a template in the builder and change it until it looks like your
          business. Nothing is installed until you want it to be.
        </p>

        <Link
          href={LANDING_ROUTES.templates}
          className="pc-button pc-button--inverse pc-button--lg mt-2"
        >
          Start Building
        </Link>
      </div>
    </section>
  );
}
