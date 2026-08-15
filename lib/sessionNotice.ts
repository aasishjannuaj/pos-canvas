// Feature 22 Phase 4 — the one reason code a protected route may hand the
// sign-in page.
//
// THE PROBLEM THIS SOLVES: when an owner's session expired mid-session, the
// proxy bounced them to a bare sign-in page. Nothing said why. The owner had
// just clicked a project and landed on a login form, which reads as "the app
// logged me out" or "the app is broken" rather than "your session ended".
//
// WHY A FIXED REASON CODE AND NOT A MESSAGE OR A DESTINATION:
//
//   1. The banner text lives HERE, not in the URL. A `?message=` parameter
//      would let anyone put arbitrary text on this product's sign-in page —
//      "Verify your card to continue" is a phishing page with our own domain
//      in the address bar. The URL may only carry an opaque code, and an
//      unrecognised code renders nothing at all.
//   2. There is deliberately NO return-to parameter in this phase. A `next=`
//      value is an open-redirect the moment it is followed without validation,
//      and the safe version of it (an allow-list, as lib/siteOrigin.ts does for
//      recovery) is more surface than a "send me back where I was" nicety is
//      worth right now. Sign-in continues to land on the dashboard.
//
// Dependency-free (no React, no Supabase, no next/*) so the proxy — which runs
// in the edge runtime — and the sign-in page share one definition, and so the
// rule stays unit-testable.

/** The query parameter a protected-route bounce may set. The only one. */
export const LOGIN_REASON_PARAM = "reason";

/** The only value that parameter may carry. */
export const SESSION_EXPIRED_REASON = "session-expired";

/**
 * The banner copy.
 *
 * Says what happened and what to do, and names nothing about how sessions are
 * stored, which provider issues them, or why this one ended.
 */
export const SESSION_EXPIRED_NOTICE =
  "Your session expired. Sign in again to continue.";

/**
 * Maps a URL reason code to sign-in page copy.
 *
 * Returns null for a direct visit (no parameter), for an unknown code, and for
 * anything else a URL can contain — so the sign-in page renders a banner only
 * for a value this module itself defines, never for text supplied by whoever
 * built the link.
 */
export function getLoginNotice(reason: string | null | undefined): string | null {
  return reason === SESSION_EXPIRED_REASON ? SESSION_EXPIRED_NOTICE : null;
}
