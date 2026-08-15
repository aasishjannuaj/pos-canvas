// Feature 23.1 — the single source of truth for the Windows shell's runtime URL.
//
// Modelled directly on android-shell/serverUrl.mjs, which has already survived a
// real release. The failure it prevents is identical and silent: a shell built
// while an operator's terminal happened to hold a development URL would install,
// launch, and point a customer's till at a machine that does not exist — with no
// way to re-point it from the server side, because the URL is inside the binary.
//
// RELEASE MODE IGNORES THE ENVIRONMENT COMPLETELY. Setting
// POS_CANVAS_DESKTOP_RELEASE=1 does not merely change a default; it stops
// consulting POS_CANVAS_DESKTOP_SERVER_URL at all. No amount of environment
// contamination — a stale export, a CI variable, a hostile wrapper script — can
// redirect a release build, because in that mode there is no code path that
// reads a variable.
//
// WHY THIS FILE IS PURE AND ENV-INJECTABLE: every function takes `env` as a
// parameter, so the whole contract is unit-testable from the root Vitest suite
// without launching Electron. See lib/windowsShell.guards.test.ts.
//
// NO SECRET BELONGS HERE. The URL is a plain origin embedded in the binary in
// cleartext by definition. Supabase credentials reach the browser only from the
// hosted page's own NEXT_PUBLIC_* values, never through this shell.
//
// NOTHING PROJECT-SPECIFIC BELONGS HERE EITHER. There is no project id, no build
// id, no configuration and no branding in this file or anywhere in the shell.
// ONE Windows binary serves every business; a till becomes a specific business's
// till by PAIRING at runtime.

export const DESKTOP_SERVER_URL_ENV_VAR = "POS_CANVAS_DESKTOP_SERVER_URL";
export const DESKTOP_RELEASE_ENV_VAR = "POS_CANVAS_DESKTOP_RELEASE";

/**
 * The one URL a production Windows build may ever load.
 *
 * Tracked, reviewable and greppable — which is the entire point. A guard test
 * asserts this exact string, so changing where released tills connect requires a
 * visible code change rather than an environment tweak.
 *
 * The /device path matters: it is the paired-till runtime. The site root is the
 * OWNER application and must never be what a customer's till loads.
 */
export const PRODUCTION_DESKTOP_SERVER_URL = "https://pos-canvas.vercel.app/device";

/**
 * The development fallback, used only when no override is supplied.
 *
 * DELIBERATELY DIFFERENT FROM ANDROID, which throws instead. Android has no
 * single correct development URL — an emulator needs 10.0.2.2, a physical device
 * needs the Mac's LAN IP — so guessing would be wrong more often than right. The
 * desktop shell runs on the same machine as `npm run dev`, so localhost:3000 is
 * correct essentially always, and failing the launch to make a point would be
 * friction with no safety benefit.
 *
 * This default can never reach a release: release mode does not consult it.
 */
export const DEVELOPMENT_DEFAULT_SERVER_URL = "http://localhost:3000/device";

/** The one host a release build is permitted to reach. */
const PRODUCTION_HOST = "pos-canvas.vercel.app";

/** The one path prefix a till may load. */
const DEVICE_PATH_PREFIX = "/device";

/**
 * True when this run is a release build.
 *
 * TWO INDEPENDENT WAYS TO BE A RELEASE, and the packaged one is decisive.
 *
 * 1. `isPackaged` — Electron's own answer to "am I running from an installed
 *    application rather than from a checkout". Feature 23.4 made this the
 *    primary signal, because an installed customer app CANNOT be asked to set
 *    an environment variable. A packaged build is a release, full stop.
 * 2. The environment flag — retained for `npm run start:production`, so a
 *    developer can exercise the real production URL from an unpackaged
 *    checkout on a Mac.
 *
 * THE ORDER MATTERS AND THE OR IS DELIBERATE. `isPackaged` short-circuits, so a
 * packaged app cannot be pushed back into development mode by any environment
 * value — absent, empty, "0", or hostile. The failure this prevents is the one
 * that would matter most: an installed till silently reading a dev URL because a
 * variable was missing. Missing is the normal state on a customer's machine.
 *
 * The environment flag still requires exactly "1", for the reason Android
 * records: NODE_ENV is frequently unset or inherited from an unrelated context,
 * so treating ambient state as a release signal would make the production URL
 * depend on it. A stray empty string, "true", or "false" all read as
 * development, which fails safe in an UNPACKAGED build only.
 *
 * The `@param` tags are load-bearing, not decoration: without them TypeScript
 * infers `env` from the default value as ProcessEnv, and every caller that
 * passes a plain object — which is the entire point of injecting the
 * environment — fails type checking.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {{ isPackaged?: boolean }} [options]
 */
export function isDesktopReleaseBuild(env = process.env, options = {}) {
  if (options.isPackaged === true) {
    return true;
  }

  return env[DESKTOP_RELEASE_ENV_VAR] === "1";
}

/** Parses, or throws with the offending value named. */
function parseUrl(value, label) {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${label} is not a valid absolute URL: "${value}".`);
  }
}

/**
 * Embedded credentials are refused everywhere, development included.
 *
 * A URL of the form https://user:pass@host is a credential written into a
 * command line, a shell history and a process list. There is no legitimate use
 * for one here, so it is rejected rather than stripped — silently dropping the
 * userinfo would load a *different* URL than the operator asked for.
 */
function assertNoUserInfo(parsed, label) {
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(
      `${label} must not contain embedded credentials. ` +
        `Remove the "user:password@" portion of the URL.`
    );
  }
}

/**
 * Verifies the production constant is what a release is allowed to ship.
 *
 * Runs against the constant itself, not against user input, so it can only fire
 * if someone edits the constant to something unsafe. That is precisely when a
 * loud failure is wanted: a typo here would be baked into every future
 * installer.
 */
function assertProductionUrl(url) {
  const label = "PRODUCTION_DESKTOP_SERVER_URL";
  const parsed = parseUrl(url, label);

  if (parsed.protocol !== "https:") {
    throw new Error(
      `A release build must use https. ${label} is "${url}".\n` +
        `A cleartext production URL would put a live till's session on the wire.`
    );
  }

  if (parsed.hostname !== PRODUCTION_HOST) {
    throw new Error(
      `A release build must point at ${PRODUCTION_HOST}. ${label} is "${url}".\n` +
        `This also rejects localhost, a LAN address and any preview deployment.`
    );
  }

  if (!parsed.pathname.startsWith(DEVICE_PATH_PREFIX)) {
    throw new Error(
      `A release build must load the paired-device runtime at ${DEVICE_PATH_PREFIX}. ` +
        `${label} is "${url}".\n` +
        `The site root is the OWNER application and must never be what a till loads.`
    );
  }

  assertNoUserInfo(parsed, label);

  return parsed;
}

/**
 * Resolves the URL the Windows shell will load.
 *
 * Returns the resolved url, its hostname, whether this is a release, and which
 * of the three sources decided it.
 *
 * `options.isPackaged` is threaded through rather than read here, so this module
 * stays free of any Electron import and the whole contract remains testable
 * under plain Node. main.mjs supplies `app.isPackaged`.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {{ isPackaged?: boolean }} [options]
 */
export function readDesktopServerUrl(env = process.env, options = {}) {
  // -------------------------------------------------------------------------
  // Release: the environment variable is not consulted at all.
  // -------------------------------------------------------------------------
  if (isDesktopReleaseBuild(env, options)) {
    const parsed = assertProductionUrl(PRODUCTION_DESKTOP_SERVER_URL);

    return {
      url: PRODUCTION_DESKTOP_SERVER_URL,
      hostname: parsed.hostname,
      isRelease: true,
      source: "release",
    };
  }

  // -------------------------------------------------------------------------
  // Development.
  // -------------------------------------------------------------------------
  const raw = env[DESKTOP_SERVER_URL_ENV_VAR];

  if (typeof raw !== "string" || raw.trim() === "") {
    const parsed = parseUrl(DEVELOPMENT_DEFAULT_SERVER_URL, "DEVELOPMENT_DEFAULT_SERVER_URL");

    return {
      url: DEVELOPMENT_DEFAULT_SERVER_URL,
      hostname: parsed.hostname,
      isRelease: false,
      source: "development-default",
    };
  }

  const trimmed = raw.trim();
  const parsed = parseUrl(trimmed, DESKTOP_SERVER_URL_ENV_VAR);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `${DESKTOP_SERVER_URL_ENV_VAR} must use http or https (got "${parsed.protocol}").`
    );
  }

  assertNoUserInfo(parsed, DESKTOP_SERVER_URL_ENV_VAR);

  return {
    url: trimmed,
    hostname: parsed.hostname,
    isRelease: false,
    source: "environment",
  };
}
