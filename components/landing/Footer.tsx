import Link from "next/link";
import PosCanvasLockup from "@/components/brand/PosCanvasLockup";
import { BRAND, BRAND_TAGLINE } from "@/lib/brand";
import { LANDING_ROUTES, LANDING_SECTION_ANCHORS } from "@/lib/landingNav";

// Footer links were already working in-page anchors; they reference the shared
// anchor constants so they cannot drift from the section ids the landing
// sections actually render.
//
// Lane 3 Task 2 — brought into the Concept D system, and deliberately kept
// SHORT.
//
// WHAT IS HERE: the platform lockup and tagline from lib/brand.ts, the three
// in-page sections the header also offers, the public template gallery, the two
// real auth routes, and a copyright line built from BRAND.companyDisplayName.
// Every one of those resolves to something that exists.
//
// WHAT IS DELIBERATELY ABSENT, AND WHY. No social accounts, no address, no
// phone number, no support email, no legal entity, no customer numbers, no
// founding year. lib/brand.ts holds `null` for legalCompanyName, supportEmail
// and websiteUrl precisely because none of them has a truthful value yet, and
// lib/brand.guards.test.ts asserts that no legal suffix is ever invented. A
// footer that looks "complete" by inventing those is a footer that lies, and
// the legal ones are the fields a signing certificate, a privacy policy and a
// terms page would all have to agree with.
//
// NO LEGAL LINKS. There is no app/terms, app/privacy or app/eula route in this
// repository — checked, not assumed — and linking to pages that do not exist
// is worse than omitting them. Creating those pages is not this task.
export default function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-hairline bg-brand-cream">
      <div className="pc-container flex flex-col gap-10 py-14">
        <div className="flex flex-col gap-10 md:flex-row md:items-start md:justify-between">
          <div className="flex max-w-xs flex-col items-start gap-3">
            <Link href="/" className="pc-focusable inline-flex rounded-pc-sm">
              <PosCanvasLockup size="sm" />
            </Link>

            <p className="text-pc-meta text-ink-muted">{BRAND_TAGLINE}</p>
          </div>

          <div className="flex flex-col gap-8 sm:flex-row sm:gap-16">
            {/* `py-1` on each link, not decoration: without it these render
                23px tall, one pixel under the 24x24 CSS px minimum target
                size, which is the kind of thing only a measurement catches. */}
            <nav aria-label="Explore" className="flex flex-col gap-2">
              <h2 className="text-pc-meta font-semibold uppercase tracking-wider text-ink">
                Explore
              </h2>

              <a href={LANDING_SECTION_ANCHORS.templates} className="pc-navlink py-1">
                Templates
              </a>

              <a href={LANDING_SECTION_ANCHORS.features} className="pc-navlink py-1">
                Features
              </a>

              <a href={LANDING_SECTION_ANCHORS.howItWorks} className="pc-navlink py-1">
                How It Works
              </a>
            </nav>

            <nav aria-label="Get started" className="flex flex-col gap-2">
              <h2 className="text-pc-meta font-semibold uppercase tracking-wider text-ink">
                Get started
              </h2>

              <Link href={LANDING_ROUTES.templates} className="pc-navlink py-1">
                Browse templates
              </Link>

              <Link href={LANDING_ROUTES.signup} className="pc-navlink py-1">
                Create an account
              </Link>

              <Link href={LANDING_ROUTES.login} className="pc-navlink py-1">
                Sign in
              </Link>
            </nav>
          </div>
        </div>

        <p className="border-t border-hairline pt-6 text-pc-meta text-ink-subtle">
          © {year} {BRAND.companyDisplayName}
        </p>
      </div>
    </footer>
  );
}
