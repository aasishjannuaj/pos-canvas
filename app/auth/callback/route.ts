import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Feature 22 Phase 1 — the password-recovery callback.
//
// Supabase sends the recovery email to its own verify endpoint, which redirects
// here with a one-time `code`. This route exchanges that code for a session
// (setting the auth cookies) and then sends the owner to the reset form.
//
// OPEN-REDIRECT PROTECTION IS THE POINT OF THIS FILE.
//
// `next` arrives in the query string, so it is untrusted input. It is NOT
// appended to a redirect, NOT parsed as a URL, and NOT checked with
// startsWith("/") — that last one is the classic near-miss, since "//evil.com"
// and "/\evil.com" both pass it and both navigate off-site. Instead the value
// is looked up in a fixed map of known paths, and anything absent from that map
// is discarded entirely. The redirect target is therefore always a string this
// file contains, never a string the request supplied.
//
// Every failure — missing code, exchange rejected, unknown destination — lands
// on the same recovery page with a neutral reason. No provider error, code or
// status ever reaches the browser.

/**
 * The complete set of destinations a callback may resolve to.
 *
 * One entry today. A future flow (email confirmation, magic link) adds its path
 * here explicitly rather than relaxing the check.
 */
const ALLOWED_NEXT_DESTINATIONS = new Map<string, string>([
  ["/reset-password", "/reset-password"],
]);

const DEFAULT_DESTINATION = "/reset-password";
const RECOVERY_FAILED_PATH = "/forgot-password?reason=invalid-or-expired";

/**
 * Resolves untrusted `next` input to a known internal path.
 *
 * Returns the DEFAULT for anything unrecognised rather than failing, because an
 * owner who clicked a valid link should still reach the reset form even if the
 * query string was mangled in transit by an email client.
 */
export function resolveNextDestination(next: string | null): string {
  if (next === null) {
    return DEFAULT_DESTINATION;
  }

  return ALLOWED_NEXT_DESTINATIONS.get(next) ?? DEFAULT_DESTINATION;
}

export async function GET(request: NextRequest) {
  // `origin` is the origin this request actually reached, so redirecting
  // relative to it keeps the owner on the same host they started on. The path
  // is always one of ours, so this cannot leave the site.
  const { searchParams, origin } = new URL(request.url);

  const code = searchParams.get("code");
  const destination = resolveNextDestination(searchParams.get("next"));

  // No code means the link was truncated, already consumed, or hand-typed.
  if (!code) {
    return NextResponse.redirect(new URL(RECOVERY_FAILED_PATH, origin));
  }

  const supabase = await createClient();

  // Consumes the one-time code and writes the session cookies. An expired,
  // reused or forged code fails here — all three are the same outcome to the
  // owner, and deliberately so: distinguishing them would leak whether a given
  // code had ever been valid.
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(new URL(RECOVERY_FAILED_PATH, origin));
  }

  return NextResponse.redirect(new URL(destination, origin));
}
