// Feature 16.2 / Feature 20 — the single source of truth for the Android
// shell's hosted runtime URL. Read by both capacitor.config.ts (to configure
// the WebView) and generateWww.mjs (to bake a working Retry target into the
// offline fallback page), so the two can never disagree about which URL the
// shell points at.
//
// FEATURE 20 — RELEASE MODE.
//
// Until now the URL came exclusively from POS_CANVAS_ANDROID_SERVER_URL, baked
// into android/app/src/main/assets/capacitor.config.json at sync time. That is
// correct for development and dangerous for a release: nothing distinguished a
// release build, so syncing for the emulator and then assembling a release
// would ship an APK pointed at http://10.0.2.2:3000. It would install, launch,
// and show the offline screen forever, on a customer's till, with no way to
// re-point it from the server side.
//
// Setting POS_CANVAS_ANDROID_RELEASE=1 now makes the production URL a property
// of THIS TRACKED FILE rather than of the operator's shell. In release mode the
// environment variable is ignored completely — not merely defaulted — so no
// amount of environment contamination can redirect a release build.
//
// No secret ever belongs in this value or anywhere in the Capacitor
// configuration: it is a plain origin, embedded in the APK in cleartext by
// definition. Supabase credentials continue to reach the browser only via the
// hosted page's own NEXT_PUBLIC_* values, never through the shell.

export const ANDROID_SERVER_URL_ENV_VAR = "POS_CANVAS_ANDROID_SERVER_URL";
export const ANDROID_RELEASE_ENV_VAR = "POS_CANVAS_ANDROID_RELEASE";

/**
 * The one URL a production APK may ever point at.
 *
 * Tracked, reviewable and greppable — which is the entire point. A guard test
 * asserts this exact string, so changing where released tills connect requires
 * a visible code change rather than an environment tweak.
 *
 * The /device path matters: it is the paired-till runtime. The site root is the
 * OWNER application and must never be what a customer's till loads.
 */
export const PRODUCTION_ANDROID_SERVER_URL = "https://pos-canvas.vercel.app/device";

/** The host a release build is permitted to reach. */
const PRODUCTION_HOST = "pos-canvas.vercel.app";

/**
 * True when this sync is producing a release artifact.
 *
 * Deliberately an explicit opt-in flag rather than NODE_ENV. `cap sync` is a
 * CLI invocation, not a bundler build: NODE_ENV is frequently unset or
 * inherited from an unrelated context, so treating it as a release signal would
 * make the production URL depend on ambient state. Exactly "1" is required —
 * a stray empty string or "false" reads as development, which fails safe.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function isAndroidReleaseBuild(env = process.env) {
  return env[ANDROID_RELEASE_ENV_VAR] === "1";
}

/**
 * Verifies the production constant is what a release is allowed to ship.
 *
 * Runs against the constant itself, not against user input, so it can only fire
 * if someone edits the constant to something unsafe. That is precisely when a
 * loud failure is wanted: a typo here would be baked into every future APK.
 */
function assertProductionUrl(url) {
  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `PRODUCTION_ANDROID_SERVER_URL is not a valid absolute URL: "${url}".`
    );
  }

  if (parsed.protocol !== "https:") {
    throw new Error(
      `A release build must use https. PRODUCTION_ANDROID_SERVER_URL is "${url}".\n` +
        `A cleartext production URL would also be blocked by Android's network\n` +
        `security config, which permits cleartext only for debuggable builds.`
    );
  }

  if (parsed.hostname !== PRODUCTION_HOST) {
    throw new Error(
      `A release build must point at ${PRODUCTION_HOST}. ` +
        `PRODUCTION_ANDROID_SERVER_URL is "${url}".`
    );
  }

  if (!parsed.pathname.startsWith("/device")) {
    throw new Error(
      `A release build must load the paired-device runtime at /device. ` +
        `PRODUCTION_ANDROID_SERVER_URL is "${url}".\n` +
        `The site root is the OWNER application and must never be what a till loads.`
    );
  }
}

/**
 * Resolves the URL the Android shell will load.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function readAndroidServerUrl(env = process.env) {
  // ---------------------------------------------------------------------
  // Release: the environment variable is not consulted at all.
  // ---------------------------------------------------------------------
  if (isAndroidReleaseBuild(env)) {
    assertProductionUrl(PRODUCTION_ANDROID_SERVER_URL);

    const parsed = new URL(PRODUCTION_ANDROID_SERVER_URL);

    return {
      url: PRODUCTION_ANDROID_SERVER_URL,
      hostname: parsed.hostname,
      // https by assertion above, so cleartext is never enabled for a release.
      isCleartext: false,
      isRelease: true,
    };
  }

  // ---------------------------------------------------------------------
  // Development: unchanged from Feature 16.2.
  // ---------------------------------------------------------------------
  const raw = env[ANDROID_SERVER_URL_ENV_VAR];

  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(
      `${ANDROID_SERVER_URL_ENV_VAR} is not set.\n\n` +
        `The Android shell loads the POS Canvas runtime over the network, so it\n` +
        `needs an explicit origin. Examples:\n` +
        `  Android emulator -> http://10.0.2.2:3000   (10.0.2.2 is the emulator's\n` +
        `                                              alias for this Mac's loopback)\n` +
        `  Physical device  -> http://<this-mac-LAN-IP>:3000\n\n` +
        `Set it for the command, e.g.:\n` +
        `  ${ANDROID_SERVER_URL_ENV_VAR}=http://10.0.2.2:3000 npm run android:sync\n\n` +
        `For a PRODUCTION release, do not set this at all — run\n` +
        `  npm run android:release:sync\n` +
        `which pins the release URL in tracked code instead.\n`
    );
  }

  const trimmed = raw.trim();

  let parsed;

  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `${ANDROID_SERVER_URL_ENV_VAR} is not a valid absolute URL. ` +
        `Expected something like http://10.0.2.2:3000`
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `${ANDROID_SERVER_URL_ENV_VAR} must use http or https (got "${parsed.protocol}").`
    );
  }

  return {
    url: trimmed.replace(/\/$/, ""),
    hostname: parsed.hostname,
    // Feature 16.2 — cleartext is only ever enabled because a local dev
    // server has no TLS. It is scoped to this exact hostname by
    // src/debug/res/xml/network_security_config.xml — a DEBUG build-type
    // resource override, so the exception cannot reach a release APK — and is
    // never enabled globally.
    isCleartext: parsed.protocol === "http:",
    isRelease: false,
  };
}
