// Feature 16.2 — generates the Capacitor `webDir` for the Android shell.
//
// In this feature the shell loads the hosted runtime over the network
// (server.url in capacitor.config.ts), so these local files are NOT the POS
// runtime and must never be mistaken for it. They exist for two reasons:
//   1. Capacitor requires a non-empty webDir to sync.
//   2. offline.html is the shell's honest failure screen (server.errorPath),
//      shown when the hosted runtime cannot be reached.
//
// The offline page's Retry button is generated with the configured server
// URL baked in, so it actually re-attempts the real runtime rather than
// reloading the error page itself — a button that appears to retry but
// cannot is worse than no button.
//
// Regenerated on every `npm run android:sync`, so the URL can never go
// stale relative to capacitor.config.ts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readAndroidServerUrl } from "./serverUrl.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const wwwDir = join(here, "www");
const networkSecurityConfigPath = join(
  here,
  "..",
  "android",
  "app",
  "src",
  "main",
  "res",
  "xml",
  "network_security_config.xml"
);

const { url, hostname, isCleartext } = readAndroidServerUrl();

// Feature 16.2 — fail loudly at sync time if the configured URL uses http
// against a host that Android's network-security config does not permit
// cleartext for. Without this check the build succeeds and the app fails at
// runtime with a confusing blank/error screen
// (net::ERR_CLEARTEXT_NOT_PERMITTED), which is exactly the kind of silent
// misconfiguration this feature is supposed to avoid.
//
// Skipped when the android/ project has not been generated yet, so this
// script still works standalone.
if (isCleartext && existsSync(networkSecurityConfigPath)) {
  const configXml = readFileSync(networkSecurityConfigPath, "utf-8");
  const permittedHosts = [
    ...configXml.matchAll(/<domain[^>]*>([^<]+)<\/domain>/g),
  ].map((match) => match[1].trim());

  if (!permittedHosts.includes(hostname)) {
    throw new Error(
      `POS_CANVAS_ANDROID_SERVER_URL uses cleartext http for host "${hostname}", ` +
        `but Android's network security config only permits cleartext for: ` +
        `${permittedHosts.join(", ") || "(none)"}.\n\n` +
        `Android blocks all other cleartext traffic from API 28 onward, so the ` +
        `app would fail at runtime with net::ERR_CLEARTEXT_NOT_PERMITTED.\n\n` +
        `Options:\n` +
        `  - Use the emulator and http://10.0.2.2:3000 (recommended; 10.0.2.2 is\n` +
        `    unroutable off this machine).\n` +
        `  - Use an https URL, which needs no cleartext permission at all.\n` +
        `  - For physical-device testing only, add "${hostname}" to\n` +
        `    android/app/src/main/res/xml/network_security_config.xml, understanding\n` +
        `    that this permits cleartext to a routable LAN address.\n`
    );
  }
}

// Escaped for safe embedding in an HTML attribute/JS string literal. The
// value is developer-supplied via an environment variable rather than
// user-supplied, but escaping it costs nothing and keeps the generated file
// well-formed for any legal URL.
function escapeForHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const safeUrl = escapeForHtml(url);

const SHARED_STYLE = `
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #fafafa;
      color: #171717;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #0a0a0a; color: #fafafa; }
      .card { background: #171717 !important; border-color: #262626 !important; }
      .muted { color: #a3a3a3 !important; }
    }
    .card {
      width: 100%;
      max-width: 22rem;
      background: #fff;
      border: 1px solid #e5e5e5;
      border-radius: 16px;
      padding: 28px 24px;
      text-align: center;
    }
    h1 { margin: 0 0 8px; font-size: 1.05rem; font-weight: 600; }
    p { margin: 0; font-size: 0.875rem; line-height: 1.5; }
    .muted { color: #737373; }
    button {
      margin-top: 20px;
      width: 100%;
      padding: 11px 16px;
      font-size: 0.875rem;
      font-weight: 500;
      color: #fff;
      background: #171717;
      border: 0;
      border-radius: 999px;
      cursor: pointer;
    }
    button:active { opacity: 0.85; }
`;

// Feature 16.2 — the honest offline/failure screen. Deliberately states a
// network requirement plainly and does NOT imply any offline capability:
// this shell has none, by design, in this feature.
const offlineHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>POS Canvas</title>
    <style>${SHARED_STYLE}</style>
  </head>
  <body>
    <main class="card">
      <h1>POS Canvas needs an internet connection.</h1>
      <p class="muted">
        The POS runtime could not be reached. Check this device's connection,
        then try again.
      </p>
      <button type="button" id="retry">Try again</button>
    </main>
    <script>
      // Navigates to the real configured runtime, not a reload of this
      // page — so the button genuinely retries.
      document.getElementById("retry").addEventListener("click", function () {
        window.location.replace("${safeUrl}");
      });
    </script>
  </body>
</html>
`;

// Feature 16.2 — only reachable if server.url is removed from the config
// (i.e. a future bundled-runtime mode). Says exactly that, so it can never
// be mistaken for a broken POS runtime.
const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>POS Canvas</title>
    <style>${SHARED_STYLE}</style>
  </head>
  <body>
    <main class="card">
      <h1>Loading POS Canvas…</h1>
      <p class="muted">
        This developer shell loads the POS runtime over the network. No POS
        runtime is bundled into this build.
      </p>
    </main>
  </body>
</html>
`;

mkdirSync(wwwDir, { recursive: true });
writeFileSync(join(wwwDir, "offline.html"), offlineHtml, "utf-8");
writeFileSync(join(wwwDir, "index.html"), indexHtml, "utf-8");

console.log(
  JSON.stringify({
    event: "android_shell_www_generated",
    wwwDir,
    serverUrl: url,
    files: ["index.html", "offline.html"],
  })
);
