import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import PosCanvasLockup from "@/components/brand/PosCanvasLockup";
import {
  LANDING_HOME_SECTION_LINKS,
  getLandingPrimaryAction,
  getLandingSignInAction,
} from "@/lib/landingNav";

// Navigation fix — three problems, all in the header:
//   1. "Get Started" was a <button type="button"> with no onClick and no
//      href, so it silently did nothing.
//   2. The landing page had no route to /login at all, so an existing user
//      could not sign in from the home page.
//   3. There was no auth awareness, so a signed-in visitor was still shown
//      "Get Started" pointing at sign-up.
//
// This is now an async Server Component reading the session with the same
// cookie-based, RLS-scoped client every other server read in this codebase
// uses (lib/supabase/server.ts + auth.getClaims(), the same call
// lib/projects.server.ts and lib/buildJobs.server.ts rely on). No new
// authorization mechanism is introduced: this only decides which link to
// render, never what the visitor may access — the proxy and RLS remain the
// actual gates.
//
// Lane 3 Task 1 — PRESENTATION ONLY. The header draws itself from
// app/design-system.css (cream ground, ink text, one teal primary action, one
// focus ring) and shows the approved Concept D lockup instead of spelling the
// product name out in the page font. The session read, the fallback, the two
// action helpers and the anchors are untouched, because the defect this
// component exists to prevent is a header that renders a destination nothing
// can reach.
//
// THE RESPONSIVE BEHAVIOUR IS DELIBERATELY THE 1.2.0 BEHAVIOUR. The section
// nav is hidden below md and shown from md up, exactly as the released header
// did. An earlier draft of this task exposed those three destinations on
// phones as a second row; that is a navigation UX CHANGE, it was not approved
// as part of a design-system task, and it was withdrawn. Restyling what
// already existed is in scope here; deciding what a phone visitor can reach
// from the header is not. Adding a second row — or a disclosure menu — needs
// its own approval.
//
// Any future mobile navigation work belongs in the gap this leaves, not in a
// visual pass.

// The homepage sections, taken from the shared constants rather than typed as
// literals, so a destination cannot drift away from the section that renders
// it.
//
// Lane 3 Task 4 — ROOT-QUALIFIED ("/#features"), because this header also
// renders on Learn and on the SEO landing pages, where a bare "#features" has
// no target. Only the destination changed; the items, labels and breakpoint are
// the released ones.
const SECTION_LINKS = [
  { label: "Templates", href: LANDING_HOME_SECTION_LINKS.templates },
  { label: "Features", href: LANDING_HOME_SECTION_LINKS.features },
  { label: "How It Works", href: LANDING_HOME_SECTION_LINKS.howItWorks },
] as const;

export default async function Navbar() {
  let isAuthenticated = false;

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getClaims();
    isAuthenticated = !error && Boolean(data?.claims);
  } catch {
    // A session lookup failure must never break the public landing page:
    // fall back to the signed-out header, which is the safe default (it
    // offers sign-in rather than assuming access).
    isAuthenticated = false;
  }

  const primaryAction = getLandingPrimaryAction(isAuthenticated);
  const signInAction = getLandingSignInAction();

  return (
    <header className="sticky top-0 z-50 border-b border-hairline bg-brand-cream/85 backdrop-blur-md">
      <div className="pc-container flex items-center justify-between gap-3 py-3 md:gap-6 md:py-4">
        <Link href="/" className="pc-focusable inline-flex rounded-pc-sm">
          <PosCanvasLockup size="md" priority />
        </Link>

        {/* md and up only — the released breakpoint, preserved. */}
        <nav aria-label="Sections" className="hidden items-center gap-8 md:flex">
          {SECTION_LINKS.map((link) => (
            <a key={link.href} href={link.href} className="pc-navlink">
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex flex-none items-center gap-2 sm:gap-3">
          {/* Only shown when signed out: a signed-in visitor already has a
              session, so a Sign In link would be pointless (and the proxy
              would bounce them off /login back to /dashboard anyway). */}
          {!isAuthenticated && (
            <Link href={signInAction.href} className="pc-navlink px-1 py-2 font-semibold">
              {signInAction.label}
            </Link>
          )}

          <Link href={primaryAction.href} className="pc-button pc-button--primary">
            {primaryAction.label}
          </Link>
        </div>
      </div>
    </header>
  );
}
