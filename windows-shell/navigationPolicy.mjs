// Feature 23.2 — what this window is allowed to navigate to, as pure functions.
//
// WHY THIS IS A SEPARATE, ELECTRON-FREE MODULE: a navigation policy is exactly
// the kind of code that looks right and is wrong. Origin comparison has sharp
// edges — a lookalike host, a userinfo prefix, a scheme swap, a redirect — and
// none of them fail loudly. Keeping the decision pure means every one of those
// cases is exercised by the root Vitest suite under plain Node, with no Electron
// process, no window, and no network. main.mjs is then only wiring.
//
// THE RULE THIS ENCODES: the POS shell is an application, not a browser. It
// displays one origin. Everything else — every other host, every other scheme,
// every popup — is refused rather than sandboxed, because there is no legitimate
// reason for a till to reach anything else, and "deny unless listed" is the only
// version of this policy that stays correct as the product grows.
import { PRODUCTION_DESKTOP_SERVER_URL } from "./serverUrl.mjs";

/**
 * The one origin a release build may ever display.
 *
 * Derived from the pinned URL rather than restated, so the navigation policy and
 * the loaded URL cannot drift apart.
 */
export const PRODUCTION_ORIGIN = new URL(PRODUCTION_DESKTOP_SERVER_URL).origin;

/** The only schemes a page may ever navigate the main window to. */
const NAVIGABLE_PROTOCOLS = new Set(["https:", "http:"]);

function parseOrNull(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Decides whether page-initiated navigation to `url` may proceed.
 *
 * FOUR CHECKS, EACH FOR A REAL CASE:
 *
 *   1. Parseable — a malformed URL is refused rather than guessed at.
 *   2. Scheme — `javascript:`, `data:`, `file:`, `about:` and every other
 *      scheme are refused before origin is even considered. Their origin is
 *      the opaque "null", so an origin check alone would already reject them,
 *      but stating the scheme rule explicitly means the refusal survives any
 *      future change to how origins are compared.
 *   3. Embedded credentials — `https://user:pass@pos-canvas.vercel.app/` has
 *      the SAME origin as the real site, so an origin check passes it. This is
 *      the one case where the obvious implementation is quietly wrong.
 *   4. Exact origin match — scheme + host + port together. A lookalike such as
 *      `https://pos-canvas.vercel.app.evil.example` is a different origin, and
 *      `http://pos-canvas.vercel.app` is a different origin from the https one,
 *      so cleartext is refused in production without a separate rule.
 *
 * @param {string} url
 * @param {readonly string[]} allowedOrigins
 */
export function isAllowedNavigation(url, allowedOrigins) {
  const parsed = parseOrNull(url);

  if (parsed === null) {
    return false;
  }

  if (!NAVIGABLE_PROTOCOLS.has(parsed.protocol)) {
    return false;
  }

  if (parsed.username !== "" || parsed.password !== "") {
    return false;
  }

  return allowedOrigins.includes(parsed.origin);
}

/**
 * Decides what happens when the page tries to open a new window.
 *
 * ALWAYS DENY. Today `/device` contains no external link of any kind, so there
 * is nothing to open and no benefit to weigh against the cost — and the cost is
 * real: a shell that will hand an arbitrary URL to the system browser is a
 * one-call phishing primitive for any script running on the page, and a shell
 * that opens a second Electron window has just become a browser.
 *
 * The argument is accepted and ignored on purpose. When `/device` one day needs
 * a genuine external link, this function grows an explicit allow-list for that
 * specific destination — a visible, reviewable change — rather than a general
 * "https is fine" rule that nobody revisits.
 *
 * @param {string} [url]
 */
export function decideWindowOpen(url) {
  void url;
  return { action: "deny" };
}

/**
 * Builds the policy for one resolved runtime URL.
 *
 * The production origin is allowed unconditionally, and the resolved runtime
 * origin is added ONLY outside release mode. That asymmetry is the point: in a
 * release build the development origin is not merely absent from the list, it
 * cannot be added, so no environment can widen what a shipped till will display.
 *
 * @param {{ runtimeUrl: string, isRelease: boolean }} input
 */
export function createNavigationPolicy({ runtimeUrl, isRelease }) {
  const allowedOrigins = [PRODUCTION_ORIGIN];

  if (!isRelease) {
    const parsed = parseOrNull(runtimeUrl);

    if (parsed !== null && !allowedOrigins.includes(parsed.origin)) {
      allowedOrigins.push(parsed.origin);
    }
  }

  return {
    allowedOrigins,
    /** @param {string} url */
    isAllowedNavigation: (url) => isAllowedNavigation(url, allowedOrigins),
    decideWindowOpen,
  };
}
