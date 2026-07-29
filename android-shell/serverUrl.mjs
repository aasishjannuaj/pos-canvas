// Feature 16.2 — the single source of truth for the Android shell's hosted
// runtime URL. Read by both capacitor.config.ts (to configure the WebView)
// and generateWww.mjs (to bake a working Retry target into the offline
// fallback page), so the two can never disagree about which URL the shell
// points at.
//
// The URL is deliberately NOT hardcoded and NOT committed: it differs per
// developer machine (emulator loopback alias vs LAN IP) and no production
// URL has been approved yet. Anything missing or malformed fails loudly at
// sync/build time rather than producing a shell that silently points
// somewhere unintended.
//
// No secret ever belongs in this value or anywhere in the Capacitor
// configuration: it is a plain origin, embedded in the APK in cleartext by
// definition. Supabase credentials continue to reach the browser only via
// the hosted page's own NEXT_PUBLIC_* values (see the report's secret-scan
// section), never through the shell.
export const ANDROID_SERVER_URL_ENV_VAR = "POS_CANVAS_ANDROID_SERVER_URL";

export function readAndroidServerUrl() {
  const raw = process.env[ANDROID_SERVER_URL_ENV_VAR];

  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(
      `${ANDROID_SERVER_URL_ENV_VAR} is not set.\n\n` +
        `The Android shell loads the POS Canvas runtime over the network, so it\n` +
        `needs an explicit origin. Examples:\n` +
        `  Android emulator -> http://10.0.2.2:3000   (10.0.2.2 is the emulator's\n` +
        `                                              alias for this Mac's loopback)\n` +
        `  Physical device  -> http://<this-mac-LAN-IP>:3000\n\n` +
        `Set it for the command, e.g.:\n` +
        `  ${ANDROID_SERVER_URL_ENV_VAR}=http://10.0.2.2:3000 npm run android:sync\n`
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
    // server has no TLS. It is scoped to this exact hostname (see the
    // generated network_security_config.xml) and never enabled globally.
    isCleartext: parsed.protocol === "http:",
  };
}
