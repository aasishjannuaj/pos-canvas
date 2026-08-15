// Feature 22 Phase 1 — the trusted origin a password-recovery link may return to.
//
// WHY AN ALLOW-LIST RATHER THAN window.location.origin.
//
// resetPasswordForEmail sends whatever `redirectTo` it is given, and Supabase
// will honour any value that matches its own Redirect URL allow-list. Passing
// the browser's current origin unchecked would mean the redirect target is
// decided by wherever the page happens to be served from — a preview
// deployment, a proxied copy, or an attacker-controlled host that managed to
// render this app. The recovery link is the single most sensitive email this
// product sends, so its destination is chosen from a fixed list here and
// nowhere else.
//
// This list must stay in sync with Supabase's own Redirect URLs setting
// (Authentication -> URL Configuration). Supabase enforces its list
// independently; this one exists so a bad value never leaves the browser in
// the first place. Two independent checks, both of which must pass.
//
// Dependency-free: no React, no Supabase, no process.env, so the rule is
// unit-testable and identical on every surface.

/** The canonical production origin. */
export const PRODUCTION_SITE_ORIGIN = "https://pos-canvas.vercel.app";

/** Local development. Present so `npm run dev` can exercise recovery end to end. */
export const DEVELOPMENT_SITE_ORIGIN = "http://localhost:3000";

/**
 * Every origin a recovery link may return to.
 *
 * Deliberately short. Adding a preview-deployment origin here would mean
 * production password-reset emails could be pointed at a preview build, so any
 * addition is a security decision, not a convenience one.
 */
export const ALLOWED_SITE_ORIGINS: readonly string[] = [
  PRODUCTION_SITE_ORIGIN,
  DEVELOPMENT_SITE_ORIGIN,
];

/** The path Supabase returns the recovery code to. */
export const AUTH_CALLBACK_PATH = "/auth/callback";

export function isAllowedSiteOrigin(value: unknown): value is string {
  return typeof value === "string" && ALLOWED_SITE_ORIGINS.includes(value);
}

/**
 * Resolves the origin to use for an auth redirect.
 *
 * Falls back to production for ANY unrecognised value — including undefined,
 * a preview URL, or a hostile one. Failing closed to production is safe: the
 * worst outcome is that a developer on an unlisted origin receives a link that
 * lands on the production site, which is confusing but never dangerous. The
 * inverse (defaulting to whatever was supplied) would let a recovery link be
 * aimed anywhere Supabase's own list permitted.
 */
export function resolveSiteOrigin(candidate?: string | null): string {
  return isAllowedSiteOrigin(candidate) ? candidate : PRODUCTION_SITE_ORIGIN;
}

/**
 * The full `redirectTo` handed to Supabase for a password-recovery email.
 *
 * `next` is NOT taken from user input anywhere — it is a fixed internal path,
 * and the callback route independently re-validates it against its own
 * allow-list before redirecting. See app/auth/callback/route.ts.
 */
export function createAuthCallbackUrl(input: {
  origin?: string | null;
  next: string;
}): string {
  const origin = resolveSiteOrigin(input.origin);

  return `${origin}${AUTH_CALLBACK_PATH}?next=${encodeURIComponent(input.next)}`;
}
