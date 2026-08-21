// Feature 24.5F — the app://poscanvas scheme, as pure functions.
//
// WHY A SEPARATE, ELECTRON-FREE MODULE, exactly as navigationPolicy.mjs is: a
// protocol handler that maps a URL onto the filesystem is the classic place to
// ship a path-traversal bug, and none of its failure modes are loud. Keeping the
// decision pure means every case — an encoded `..`, a foreign host, a missing
// file, a query string — is exercised by the root Vitest suite under plain Node,
// with no Electron process and no window. main.mjs is only wiring.
//
// THE ORIGIN THIS SERVES IS PERMANENT: app://poscanvas. IndexedDB and
// localStorage are origin-scoped, so changing the scheme or the host later would
// strand a till's pairing, its pinned config and — worst of all — its queued
// sales. See docs/OFFLINE_ARCHITECTURE.md §16.
import { normalize, resolve, sep } from "node:path";

/** The one scheme this application serves its own runtime from. */
export const APP_SCHEME = "app";

/** The one host. Anything else is a different application as far as we care. */
export const APP_HOST = "poscanvas";

/** The origin as Chromium reports it once the scheme is registered as standard. */
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** Served when a request names a directory, or the app's own root. */
export const APP_INDEX = "index.html";

/**
 * WHY ORIGIN COMPARISON IS NOT USED ANYWHERE HERE, stated once because it is the
 * trap this file exists to avoid.
 *
 * `app:` is not a "special" scheme to the WHATWG URL parser, so
 * `new URL("app://poscanvas/x").origin` is the string "null" — and so is
 * `new URL("app://evil/x").origin`. An allow-list of origins would therefore
 * either match nothing or, if somebody "fixed" it by adding "null", match every
 * host in existence. Chromium reports a real origin for the registered scheme
 * inside the renderer, but the main process and these tests use Node's parser,
 * which does not. Scheme and host are compared explicitly instead.
 *
 * @param {string} url
 */
export function isAppRuntimeUrl(url) {
  const parsed = parseOrNull(url);

  if (parsed === null) {
    return false;
  }

  // Embedded credentials: `app://user:pass@poscanvas/x` has the same host and
  // would otherwise pass. Refused for the same reason the navigation policy
  // refuses them on https.
  if (parsed.username !== "" || parsed.password !== "") {
    return false;
  }

  return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST;
}

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
 * Maps an app:// request onto a file inside the packaged runtime.
 *
 * Returns an absolute path, or null when the request must not be served. Null
 * is deliberately the answer for BOTH "not ours" and "outside the root": the
 * caller answers 404 either way, so a probe learns nothing about which it was.
 *
 * THE CONTAINMENT CHECK IS THE REAL DEFENCE, not the URL parser. The parser
 * collapses a literal `/../`, but it does NOT collapse a percent-encoded one:
 * `app://poscanvas/assets/..%2f..%2fsecret` arrives with its pathname intact and
 * decodes to `/assets/../../secret`. So this decodes first, resolves against the
 * root, and then requires the result to still be inside that root — a check that
 * holds regardless of what future encoding someone invents.
 *
 * QUERY AND HASH ARE IGNORED, because they address nothing on a filesystem. A
 * cache-busted `?v=2` must serve the same asset rather than 404.
 *
 * @param {string} url          the full request URL
 * @param {string} runtimeRoot  absolute path to the packaged runtime directory
 * @returns {string | null}
 */
export function resolveAppAssetPath(url, runtimeRoot) {
  if (!isAppRuntimeUrl(url)) {
    return null;
  }

  const parsed = parseOrNull(url);

  if (parsed === null) {
    return null;
  }

  let decoded;

  try {
    decoded = decodeURIComponent(parsed.pathname);
  } catch {
    // A malformed escape sequence is not a path.
    return null;
  }

  // A NUL byte truncates a path in some system calls. Refuse outright.
  if (decoded.includes("\0")) {
    return null;
  }

  // Always rooted, so the `.` prefix below reliably turns it into a relative
  // path. A URL with no path at all yields "", which would otherwise resolve to
  // ".index.html" — a sibling file, not the entry document.
  const rooted = decoded.startsWith("/") ? decoded : `/${decoded}`;

  // The root, or any directory-looking request, serves the SPA document. This is
  // what makes a reload of app://poscanvas/ work.
  const relative = rooted === "/" || rooted.endsWith("/") ? `${rooted}${APP_INDEX}` : rooted;

  const root = resolve(runtimeRoot);
  const candidate = resolve(root, `.${normalize(relative)}`);

  // Containment. `startsWith(root + sep)` rather than `startsWith(root)`, so a
  // sibling directory whose name merely begins with the root's name — say
  // `/app/runtime-evil` beside `/app/runtime` — cannot pass.
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    return null;
  }

  return candidate;
}
