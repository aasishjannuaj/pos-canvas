// Feature 23.2 — the Windows shell's security posture.
//
// TWO KINDS OF ASSERTION HERE, and the split is deliberate.
//
// 1. THE NAVIGATION POLICY IS EXECUTED, not read. Origin comparison is the part
//    of this feature most likely to be subtly wrong — a lookalike host, a
//    userinfo prefix, a scheme swap — and every one of those failures is silent.
//    windows-shell/navigationPolicy.mjs is Electron-free precisely so the real
//    decision function can be called here with real URLs under plain Node.
//
// 2. THE WIRING IS ASSERTED AS SOURCE. Whether main.mjs actually attaches that
//    policy to will-navigate, denies every permission, and cancels downloads
//    cannot be executed without launching Electron, which this repository has no
//    harness for. Those are structural assertions, and they are the ones a
//    reviewer would otherwise have to take on trust.
//
// The posture being protected: a POS till displays ONE origin and asks the
// operating system for NOTHING. Every control below is deny-by-default, because
// the alternative — allow, then enumerate the bad cases — has to be re-audited
// every time the hosted page changes.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PRODUCTION_ORIGIN,
  createNavigationPolicy,
  decideWindowOpen,
  isAllowedNavigation,
} from "../windows-shell/navigationPolicy.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf-8");
}

/** Strips comments so explanatory prose never trips a guard. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const MAIN = "windows-shell/main.mjs";
const PRELOAD = "windows-shell/preload.js";
const POLICY = "windows-shell/navigationPolicy.mjs";

const PRODUCTION = "https://pos-canvas.vercel.app/device";
const DEV_RUNTIME = "http://localhost:3000/device";

const releasePolicy = createNavigationPolicy({
  runtimeUrl: PRODUCTION,
  isRelease: true,
});

const developmentPolicy = createNavigationPolicy({
  runtimeUrl: DEV_RUNTIME,
  isRelease: false,
});

// ---------------------------------------------------------------------------
// Navigation — the executed policy
// ---------------------------------------------------------------------------

describe("the trusted origin is navigable", () => {
  it("allows the production device runtime", () => {
    expect(releasePolicy.isAllowedNavigation(PRODUCTION)).toBe(true);
  });

  it("allows other paths on the same origin", () => {
    // The device runtime is a single-page app; in-app routing must not be
    // mistaken for an escape attempt.
    for (const url of [
      "https://pos-canvas.vercel.app/device",
      "https://pos-canvas.vercel.app/device?code=abc",
      "https://pos-canvas.vercel.app/device#receipt",
      "https://pos-canvas.vercel.app/",
    ]) {
      expect(`${url}`).toBe(url);
      expect(releasePolicy.isAllowedNavigation(url)).toBe(true);
    }
  });

  it("derives its origin from the pinned URL rather than restating it", () => {
    expect(PRODUCTION_ORIGIN).toBe("https://pos-canvas.vercel.app");
    expect(code(read(POLICY))).toContain(
      "new URL(PRODUCTION_DESKTOP_SERVER_URL).origin"
    );
  });
});

describe("everything else is refused", () => {
  const blocked = [
    ["a different host", "https://evil.example/device"],
    ["a lookalike host", "https://pos-canvas.vercel.app.evil.example/device"],
    ["a lookalike with a hyphen", "https://pos-canvas-vercel.app/device"],
    ["a subdomain", "https://staging.pos-canvas.vercel.app/device"],
    ["a preview deployment", "https://pos-canvas-git-main.vercel.app/device"],
    ["cleartext on the right host", "http://pos-canvas.vercel.app/device"],
    ["embedded credentials", "https://user:pass@pos-canvas.vercel.app/device"],
    ["a password-only userinfo", "https://:pass@pos-canvas.vercel.app/device"],
    ["javascript:", "javascript:alert(document.cookie)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["file:", "file:///etc/passwd"],
    ["a local file page", "file:///Users/someone/windows-shell/offline.html"],
    ["about:blank", "about:blank"],
    ["a custom scheme", "pos-canvas://open"],
    ["an ftp URL", "ftp://pos-canvas.vercel.app/device"],
    ["a malformed URL", "not a url"],
    ["an empty string", ""],
    ["whitespace", "   "],
    ["a non-default port", "https://pos-canvas.vercel.app:8443/device"],
  ] as const;

  for (const [label, url] of blocked) {
    it(`blocks ${label} in release`, () => {
      expect(releasePolicy.isAllowedNavigation(url)).toBe(false);
    });

    it(`blocks ${label} in development too`, () => {
      // Development is more permissive about ONE extra origin, never about these.
      expect(developmentPolicy.isAllowedNavigation(url)).toBe(false);
    });
  }
});

describe("localhost is a development-only privilege", () => {
  it("is navigable when the shell resolved a localhost runtime", () => {
    expect(developmentPolicy.isAllowedNavigation(DEV_RUNTIME)).toBe(true);
    expect(developmentPolicy.isAllowedNavigation("http://localhost:3000/device?x=1")).toBe(
      true
    );
  });

  it("is refused in release, whatever the runtime URL claims", () => {
    // Even if a release build were somehow handed a localhost runtime URL, the
    // policy still refuses it: release allows the production origin and nothing
    // else, by construction rather than by check.
    const tampered = createNavigationPolicy({
      runtimeUrl: DEV_RUNTIME,
      isRelease: true,
    });

    expect(tampered.allowedOrigins).toEqual([PRODUCTION_ORIGIN]);
    expect(tampered.isAllowedNavigation(DEV_RUNTIME)).toBe(false);
  });

  it("a release policy never carries a second origin", () => {
    expect(releasePolicy.allowedOrigins).toHaveLength(1);
    expect(releasePolicy.allowedOrigins).toEqual(["https://pos-canvas.vercel.app"]);
  });

  it("a development policy carries production plus exactly one dev origin", () => {
    expect(developmentPolicy.allowedOrigins).toEqual([
      "https://pos-canvas.vercel.app",
      "http://localhost:3000",
    ]);
  });

  it("only the resolved dev origin is allowed, not localhost generally", () => {
    // A different port is a different origin. Nothing grants "localhost".
    expect(developmentPolicy.isAllowedNavigation("http://localhost:9999/device")).toBe(
      false
    );
    expect(developmentPolicy.isAllowedNavigation("http://127.0.0.1:3000/device")).toBe(
      false
    );
  });

  it("localhost is never hardcoded as a production allowance", () => {
    const policy = code(read(POLICY));
    expect(policy).not.toContain("localhost");
    expect(policy).not.toContain("127.0.0.1");
  });
});

describe("the raw decision function is total", () => {
  it("refuses everything when the allow-list is empty", () => {
    expect(isAllowedNavigation(PRODUCTION, [])).toBe(false);
  });

  it("handles non-string input without throwing", () => {
    for (const value of [null, undefined, 0, {}, []]) {
      expect(() =>
        isAllowedNavigation(value as unknown as string, [PRODUCTION_ORIGIN])
      ).not.toThrow();
      expect(isAllowedNavigation(value as unknown as string, [PRODUCTION_ORIGIN])).toBe(
        false
      );
    }
  });
});

// ---------------------------------------------------------------------------
// New windows
// ---------------------------------------------------------------------------

describe("new windows are denied unconditionally", () => {
  it("denies every URL, trusted ones included", () => {
    for (const url of [
      PRODUCTION,
      "https://pos-canvas.vercel.app/device",
      "https://evil.example",
      "http://evil.example",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,x",
      "https://user:pass@example.com",
      undefined,
    ]) {
      expect(`${url}`).toBe(String(url));
      expect(decideWindowOpen(url as string).action).toBe("deny");
    }
  });

  it("opens nothing in the system browser", () => {
    // shell.openExternal would let any script on the page launch the operator's
    // browser at a URL of its choosing. There is no external link on /device, so
    // there is nothing to weigh against that.
    const policy = code(read(POLICY));
    const main = code(read(MAIN));

    for (const source of [policy, main]) {
      expect(source).not.toContain("openExternal");
      expect(source).not.toContain('action: "allow"');
    }
  });

  it("is wired to the window open handler", () => {
    const main = code(read(MAIN));
    expect(main).toContain("setWindowOpenHandler");
    expect(main).toContain("navigationPolicy.decideWindowOpen(url)");
  });
});

// ---------------------------------------------------------------------------
// Wiring — asserted as source
// ---------------------------------------------------------------------------

describe("the policy is actually attached", () => {
  const main = code(read(MAIN));

  it("guards will-navigate AND will-redirect", () => {
    // A 302 off the trusted origin never re-emits will-navigate. Handling only
    // the first event would let the trusted server walk the window away.
    expect(main).toContain('webContents.on("will-navigate", blockDisallowedNavigation)');
    expect(main).toContain('webContents.on("will-redirect", blockDisallowedNavigation)');
  });

  it("refuses by preventing the default, not by rewriting the URL", () => {
    expect(main).toContain("event.preventDefault()");
    expect(main).toContain("navigationPolicy.isAllowedNavigation(url)");
  });

  it("builds the policy from the resolved runtime, once", () => {
    expect(main).toContain("createNavigationPolicy({");
    expect(main).toContain("runtimeUrl: resolvedServer.url");
    expect(main).toContain("isRelease: resolvedServer.isRelease");
  });
});

describe("single instance", () => {
  const main = code(read(MAIN));

  it("takes the lock", () => {
    expect(main).toContain("app.requestSingleInstanceLock()");
  });

  it("quits a second process instead of opening a second window", () => {
    expect(main).toContain("if (!hasSingleInstanceLock)");
    expect(main).toContain("app.quit()");
  });

  it("focuses and un-minimises the existing window", () => {
    expect(main).toContain('app.on("second-instance"');
    expect(main).toContain("focusExistingWindow()");
    expect(main).toContain("existing.isMinimized()");
    expect(main).toContain("existing.restore()");
    expect(main).toContain("existing.focus()");
  });

  it("creates windows only when it holds the lock", () => {
    // Otherwise the losing process would build a window before quitting.
    const guarded = main.slice(main.indexOf("if (hasSingleInstanceLock) {"));
    expect(guarded).toContain("app.whenReady()");
    expect(guarded).toContain("createWindow()");
  });

  it("preserves macOS activate behaviour", () => {
    expect(main).toContain('app.on("activate"');
    expect(main).toContain("BrowserWindow.getAllWindows().length === 0");
  });
});

describe("permissions are denied by default", () => {
  const main = code(read(MAIN));

  it("denies requests", () => {
    expect(main).toContain("session.setPermissionRequestHandler");
    expect(main).toContain("callback(false)");
    expect(main).not.toContain("callback(true)");
  });

  it("denies synchronous checks too", () => {
    // navigator.permissions.query and some getUserMedia paths take this route;
    // leaving it at the default would make the answer depend on the path.
    expect(main).toContain("session.setPermissionCheckHandler");
    expect(main).toContain("return false;");
  });

  it("enumerates no allowed permission anywhere", () => {
    for (const permission of [
      "media",
      "camera",
      "microphone",
      "geolocation",
      "notifications",
      "midi",
      "clipboard-read",
      "clipboard-sanitized-write",
      "hid",
      "serial",
      "usb",
    ]) {
      expect(`main.mjs allows ${permission}`).toBe(`main.mjs allows ${permission}`);
      expect(main).not.toContain(`"${permission}"`);
    }
  });
});

describe("downloads are cancelled", () => {
  const main = code(read(MAIN));

  it("cancels every download", () => {
    expect(main).toContain('session.on("will-download"');
    expect(main).toContain("event.preventDefault()");
  });

  it("carves out no exception", () => {
    // Configuration download belongs to the OWNER editor, behind owner auth, on
    // a surface this shell never loads.
    expect(main).not.toContain("setSavePath");
    expect(main).not.toContain("item.resume");
    expect(main).not.toContain("downloadURL");
  });
});

describe("DevTools are absent from a release build", () => {
  const main = code(read(MAIN));

  it("ties the webPreference to the release flag", () => {
    expect(main).toContain("devTools: !resolvedServer.isRelease");
    // Never unconditionally on.
    expect(main).not.toContain("devTools: true");
  });

  it("closes the keyboard path in release as well", () => {
    expect(main).toContain("if (resolvedServer.isRelease)");
    expect(main).toContain('webContents.on("before-input-event"');
    expect(main).toContain('key === "f12"');
  });

  it("never opens DevTools on its own", () => {
    expect(main).not.toContain("openDevTools");
  });
});

// ---------------------------------------------------------------------------
// TLS and web security — fail closed
// ---------------------------------------------------------------------------

describe("TLS failures are never bypassed", () => {
  it("no certificate error is ever approved", () => {
    // Electron's default is to reject. The only reason to add a handler here
    // would be to override that, so there is no handler at all.
    for (const file of [MAIN, PRELOAD, POLICY, "windows-shell/serverUrl.mjs"]) {
      const source = code(read(file));

      for (const banned of [
        "certificate-error",
        "ignore-certificate-errors",
        "setCertificateVerifyProc",
        "rejectUnauthorized",
        "NODE_TLS_REJECT_UNAUTHORIZED",
      ]) {
        expect(`${file}: ${source}`).not.toContain(banned);
      }
    }
  });

  it("no command-line switch weakens the browser", () => {
    const main = code(read(MAIN));

    for (const banned of [
      "commandLine.appendSwitch",
      "appendArgument",
      "disable-web-security",
      "allow-running-insecure-content",
      "--no-sandbox",
    ]) {
      expect(`main.mjs: ${main}`).not.toContain(banned);
    }
  });
});

describe("the locked webPreferences survive 23.2", () => {
  const main = code(read(MAIN));

  it("still sets all four", () => {
    expect(main).toContain("contextIsolation: true");
    expect(main).toContain("nodeIntegration: false");
    expect(main).toContain("sandbox: true");
    expect(main).toContain("webviewTag: false");
  });

  it("never negates them, and never disables webSecurity", () => {
    for (const banned of [
      "contextIsolation: false",
      "nodeIntegration: true",
      "sandbox: false",
      "webviewTag: true",
      "webSecurity: false",
      "allowRunningInsecureContent",
      "experimentalFeatures",
      "nodeIntegrationInWorker",
      "nodeIntegrationInSubFrames",
      "enableRemoteModule",
    ]) {
      expect(`main.mjs: ${main}`).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// The renderer-visible surface
// ---------------------------------------------------------------------------

describe("the bridge is invisible to the hosted page", () => {
  const preload = code(read(PRELOAD));

  it("exposes the bridge only on the local fallback document", () => {
    expect(preload).toContain('window.location.protocol === "file:"');
    expect(preload).toContain("if (isLocalFallbackPage) {");

    // The exposure must be INSIDE the conditional, not merely near it.
    const gate = preload.indexOf("if (isLocalFallbackPage)");
    const exposure = preload.indexOf("exposeInMainWorld");
    expect(gate).toBeGreaterThan(-1);
    expect(exposure).toBeGreaterThan(gate);
  });

  it("still exposes exactly one key, carrying nothing", () => {
    expect((preload.match(/exposeInMainWorld\(/g) ?? []).length).toBe(1);
    expect(preload).toContain('exposeInMainWorld("posCanvasShell"');
    expect(preload).toContain('ipcRenderer.send("pos-canvas-shell:retry")');
    // No second argument means no destination can cross.
    expect(preload).not.toMatch(/send\([^)]*,[^)]*\)/);
  });

  it("hands the page no general IPC or Node access", () => {
    expect(preload).not.toContain("ipcRenderer.invoke");
    expect(preload).not.toMatch(/exposeInMainWorld\(\s*["']ipc/);
    expect(preload).not.toMatch(/require\(["'](fs|path|child_process|os|net)["']\)/);
    expect(preload).not.toContain("process.env");
  });

  it("adds no desktop identity signal — that is Feature 23.3", () => {
    for (const premature of ["platform", "isDesktop", "DevicePlatform"]) {
      expect(`preload: ${preload}`).not.toContain(premature);
    }
  });
});

describe("retry cannot be driven by the hosted page", () => {
  const main = code(read(MAIN));

  it("accepts no destination through the channel", () => {
    // The handler takes only the event. There is no URL parameter to abuse.
    expect(main).toContain("ipcMain.on(RETRY_CHANNEL, (event) => {");
    expect(main).not.toMatch(/ipcMain\.on\(RETRY_CHANNEL,\s*\([^)]*,[^)]*\)/);
    expect(main).toContain("loadDeviceRuntime(window)");
  });

  it("ignores any sender that is not the local fallback", () => {
    expect(main).toContain('senderUrl.startsWith("file://")');
    expect(main).toContain("return;");
  });

  it("navigates only to the already-resolved URL", () => {
    expect(main).toContain("window.loadURL(resolvedServer.url)");
    expect(main).not.toMatch(/loadURL\(["'`]http/);
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("the device session's storage is left alone", () => {
  const main = code(read(MAIN));
  const shellFiles = [MAIN, PRELOAD, POLICY, "windows-shell/serverUrl.mjs"];

  it("uses the default persistent session, not an ephemeral partition", () => {
    // fromPartition("...") without a "persist:" prefix is an in-memory session:
    // the device would forget its pairing on every quit.
    for (const file of shellFiles) {
      const source = code(read(file));
      expect(`${file}: ${source}`).not.toContain("fromPartition");
      expect(`${file}: ${source}`).not.toContain("partition:");
    }
  });

  it("clears no storage, ever", () => {
    for (const file of shellFiles) {
      const source = code(read(file));

      for (const banned of [
        "clearStorageData",
        "clearCache",
        "clearAuthCache",
        "clearHostResolverCache",
        "localStorage.clear",
        "localStorage.removeItem",
        "sessionStorage.clear",
        "indexedDB.deleteDatabase",
      ]) {
        expect(`${file}: ${source}`).not.toContain(banned);
      }
    }
  });

  it("never relocates or deletes the user-data directory", () => {
    for (const banned of ["setPath(", "rmSync", "unlinkSync", "rmdir", "mkdtemp"]) {
      expect(`main.mjs: ${main}`).not.toContain(banned);
    }
  });

  it("pins the product name the storage path derives from", () => {
    // Renaming this moves %APPDATA%\POS Canvas and unpairs every till. This is a
    // NECESSARY condition for pairing to survive an upgrade, not a sufficient
    // one — the installer must preserve that directory too, which only real
    // Windows can demonstrate (Feature 23.5).
    expect(main).toContain('app.setName("POS Canvas")');

    const shellPackage = JSON.parse(read("windows-shell/package.json")) as {
      productName: string;
    };
    expect(shellPackage.productName).toBe("POS Canvas");
  });

  it("the session it must not disturb is still a localStorage entry", () => {
    // If the device client ever moved to cookies or IndexedDB, the Electron
    // persistence story would need re-checking rather than silently changing.
    const client = code(read("lib/supabase/deviceClient.ts"));

    expect(client).toContain('DEVICE_AUTH_STORAGE_KEY = "pos-canvas-device-auth"');
    expect(client).toContain("persistSession: true");
    expect(client).toContain("storageKey: DEVICE_AUTH_STORAGE_KEY");
  });
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

describe("Feature 23.2 stops where it was scoped to stop", () => {
  it("adds no 23.3 device identity", () => {
    expect(code(read("lib/deviceSession.ts"))).toContain(
      'export type DevicePlatform = "android" | "web"'
    );
    expect(code(read(MAIN))).not.toContain("DevicePlatform");
  });

  it("leaves Windows as coming_soon", () => {
    const model = code(read("lib/platformDownloads.ts"));
    expect(model).toContain("export const WINDOWS_DOWNLOAD: ComingSoonPlatformDownload");
    expect(model).toContain('status: "coming_soon"');
    expect(model).not.toContain("getWindowsDownload");
  });

  it("adds no packaging, CI, release, or signing work", () => {
    const shellPackage = read("windows-shell/package.json");

    for (const banned of ["electron-builder", "electron-forge", "nsis", "sign"]) {
      expect(`package.json: ${shellPackage}`).not.toContain(banned);
    }
  });

  it("leaves the root dependency tree untouched", () => {
    const rootPackage = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    for (const name of Object.keys({
      ...rootPackage.dependencies,
      ...rootPackage.devDependencies,
    })) {
      expect(name).not.toMatch(/^electron($|-)/);
      expect(name).not.toMatch(/^@electron\//);
    }
  });
});
