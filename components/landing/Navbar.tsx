import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  LANDING_SECTION_ANCHORS,
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
    <header className="sticky top-0 z-50 border-b border-neutral-200 bg-white/80 backdrop-blur-sm">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link
          href="/"
          className="text-lg font-semibold tracking-tight text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          POS Canvas
        </Link>

        <nav className="hidden items-center gap-8 md:flex">
          <a
            href={LANDING_SECTION_ANCHORS.templates}
            className="text-sm text-neutral-600 transition-colors hover:text-neutral-900"
          >
            Templates
          </a>

          <a
            href={LANDING_SECTION_ANCHORS.features}
            className="text-sm text-neutral-600 transition-colors hover:text-neutral-900"
          >
            Features
          </a>

          <a
            href={LANDING_SECTION_ANCHORS.howItWorks}
            className="text-sm text-neutral-600 transition-colors hover:text-neutral-900"
          >
            How It Works
          </a>
        </nav>

        <div className="flex items-center gap-3">
          {/* Only shown when signed out: a signed-in visitor already has a
              session, so a Sign In link would be pointless (and the proxy
              would bounce them off /login back to /dashboard anyway). */}
          {!isAuthenticated && (
            <Link
              href={signInAction.href}
              className="text-sm font-medium text-neutral-600 transition-colors hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
            >
              {signInAction.label}
            </Link>
          )}

          <Link
            href={primaryAction.href}
            className="inline-flex items-center justify-center rounded-full bg-neutral-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            {primaryAction.label}
          </Link>
        </div>
      </div>
    </header>
  );
}
