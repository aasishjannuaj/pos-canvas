// Feature 23.1 — guards for the Windows shell foundation.
//
// TWO SUBJECTS, both of which fail silently without these assertions.
//
// 1. THE PRODUCTION URL. A shell built while an operator's terminal held a
//    development URL installs, launches, and shows the offline page forever on
//    a customer's till, with no server-side way to re-point it. Nothing else in
//    this repository would fail. The Android equivalent
//    (lib/androidRelease.guards.test.ts) exists for exactly this reason and is
//    the model followed here.
//
// 2. DEPENDENCY ISOLATION. Electron in the root package.json would add hundreds
//    of megabytes to every Vercel build — devDependencies are installed at
//    build time — and would couple the web app's dependency tree to a desktop
//    binary it has nothing to do with. The separation is architectural, so it
//    is asserted rather than remembered.
//
// The URL contract is imported and EXECUTED here, not merely read as text:
// readDesktopServerUrl takes its environment as a parameter precisely so the
// whole contract can be exercised under plain Node without launching Electron.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_RELEASE_ENV_VAR,
  DESKTOP_SERVER_URL_ENV_VAR,
  DEVELOPMENT_DEFAULT_SERVER_URL,
  PRODUCTION_DESKTOP_SERVER_URL,
  isDesktopReleaseBuild,
  readDesktopServerUrl,
} from "../windows-shell/serverUrl.mjs";

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

const SHELL_DIR = "windows-shell";
const SHELL_PACKAGE = "windows-shell/package.json";
const SHELL_LOCK = "windows-shell/package-lock.json";
const SERVER_URL = "windows-shell/serverUrl.mjs";
const MAIN = "windows-shell/main.mjs";
const PRELOAD = "windows-shell/preload.js";
const OFFLINE = "windows-shell/offline.html";

const RELEASE_ENV = { [DESKTOP_RELEASE_ENV_VAR]: "1" };

// ---------------------------------------------------------------------------
// The production URL
// ---------------------------------------------------------------------------

describe("the production URL is pinned in tracked code", () => {
  it("is exactly the production device runtime", () => {
    expect(PRODUCTION_DESKTOP_SERVER_URL).toBe("https://pos-canvas.vercel.app/device");
  });

  it("resolves to that URL in release mode", () => {
    const resolved = readDesktopServerUrl(RELEASE_ENV);

    expect(resolved.url).toBe("https://pos-canvas.vercel.app/device");
    expect(resolved.isRelease).toBe(true);
    expect(resolved.source).toBe("release");
  });

  it("loads the till runtime, never the owner application at the site root", () => {
    const parsed = new URL(PRODUCTION_DESKTOP_SERVER_URL);

    expect(parsed.protocol).toBe("https:");
    expect(parsed.hostname).toBe("pos-canvas.vercel.app");
    expect(parsed.pathname.startsWith("/device")).toBe(true);
    expect(parsed.username).toBe("");
    expect(parsed.password).toBe("");
  });
});

describe("release mode ignores the environment completely", () => {
  it("ignores a development override", () => {
    const resolved = readDesktopServerUrl({
      ...RELEASE_ENV,
      [DESKTOP_SERVER_URL_ENV_VAR]: "http://localhost:3000/device",
    });

    expect(resolved.url).toBe(PRODUCTION_DESKTOP_SERVER_URL);
  });

  it("ignores a hostile override", () => {
    // The documented threat: a wrapper script, a stale export, or a poisoned CI
    // variable trying to redirect a released till.
    for (const hostile of [
      "http://evil.example/device",
      "https://evil.example/device",
      "https://pos-canvas.vercel.app.evil.example/device",
      "https://user:pass@evil.example/device",
      "file:///tmp/device",
      "javascript:alert(1)",
      "not a url at all",
      "",
      "   ",
    ]) {
      const resolved = readDesktopServerUrl({
        ...RELEASE_ENV,
        [DESKTOP_SERVER_URL_ENV_VAR]: hostile,
      });

      expect(`override ${hostile}`).toBe(`override ${hostile}`);
      expect(resolved.url).toBe(PRODUCTION_DESKTOP_SERVER_URL);
    }
  });

  it("can never resolve to localhost or a loopback address in release", () => {
    for (const loopback of [
      "http://localhost:3000/device",
      "http://127.0.0.1:3000/device",
      "http://[::1]:3000/device",
      "http://10.0.2.2:3000/device",
      "http://192.168.1.10:3000/device",
    ]) {
      const resolved = readDesktopServerUrl({
        ...RELEASE_ENV,
        [DESKTOP_SERVER_URL_ENV_VAR]: loopback,
      });

      expect(resolved.url).toBe(PRODUCTION_DESKTOP_SERVER_URL);
      expect(resolved.hostname).toBe("pos-canvas.vercel.app");
    }
  });

  it("is an explicit flag, never NODE_ENV and never a truthy string", () => {
    expect(isDesktopReleaseBuild({ [DESKTOP_RELEASE_ENV_VAR]: "1" })).toBe(true);

    for (const value of ["", "0", "true", "false", "yes", "release", " 1", "1 "]) {
      expect(`value ${JSON.stringify(value)}`).toBe(`value ${JSON.stringify(value)}`);
      expect(isDesktopReleaseBuild({ [DESKTOP_RELEASE_ENV_VAR]: value })).toBe(false);
    }

    expect(isDesktopReleaseBuild({})).toBe(false);
    expect(isDesktopReleaseBuild({ NODE_ENV: "production" })).toBe(false);
  });
});

describe("the production constant itself is validated", () => {
  // These fire only if someone edits the constant to something unsafe — which is
  // exactly when a loud failure is wanted, because the value would otherwise be
  // baked into every future installer.
  const source = code(read(SERVER_URL));

  it("checks the scheme, the host, the path and the userinfo", () => {
    expect(source).toContain('parsed.protocol !== "https:"');
    expect(source).toContain("parsed.hostname !== PRODUCTION_HOST");
    expect(source).toContain("parsed.pathname.startsWith(DEVICE_PATH_PREFIX)");
    expect(source).toContain("assertNoUserInfo(parsed, label)");
  });

  it("pins the host and path as constants, not as inline literals", () => {
    expect(source).toContain('const PRODUCTION_HOST = "pos-canvas.vercel.app"');
    expect(source).toContain('const DEVICE_PATH_PREFIX = "/device"');
  });

  it("rejects a malformed URL rather than coercing it", () => {
    expect(source).toContain("is not a valid absolute URL");
  });
});

// ---------------------------------------------------------------------------
// Development
// ---------------------------------------------------------------------------

describe("development mode", () => {
  it("accepts an explicit localhost device URL", () => {
    const resolved = readDesktopServerUrl({
      [DESKTOP_SERVER_URL_ENV_VAR]: "http://localhost:3000/device",
    });

    expect(resolved.url).toBe("http://localhost:3000/device");
    expect(resolved.hostname).toBe("localhost");
    expect(resolved.isRelease).toBe(false);
    expect(resolved.source).toBe("environment");
  });

  it("falls back to a safe local default when nothing is supplied", () => {
    const resolved = readDesktopServerUrl({});

    expect(resolved.url).toBe(DEVELOPMENT_DEFAULT_SERVER_URL);
    expect(resolved.url).toBe("http://localhost:3000/device");
    expect(resolved.source).toBe("development-default");
  });

  it("the development default is loopback only", () => {
    // A default pointing anywhere else would be a silent network call from a
    // developer machine to a host nobody chose.
    expect(new URL(DEVELOPMENT_DEFAULT_SERVER_URL).hostname).toBe("localhost");
  });

  it("rejects a non-http(s) scheme", () => {
    for (const bad of ["file:///tmp/device", "javascript:alert(1)", "ftp://x/device"]) {
      expect(() =>
        readDesktopServerUrl({ [DESKTOP_SERVER_URL_ENV_VAR]: bad })
      ).toThrow();
    }
  });

  it("rejects embedded credentials even in development", () => {
    expect(() =>
      readDesktopServerUrl({
        [DESKTOP_SERVER_URL_ENV_VAR]: "http://user:pass@localhost:3000/device",
      })
    ).toThrow(/credentials/i);
  });

  it("rejects a malformed URL", () => {
    expect(() =>
      readDesktopServerUrl({ [DESKTOP_SERVER_URL_ENV_VAR]: "not a url" })
    ).toThrow(DESKTOP_SERVER_URL_ENV_VAR);
  });
});

// ---------------------------------------------------------------------------
// The universal-app invariant
// ---------------------------------------------------------------------------

describe("the shell is universal, not per customer", () => {
  it("no shell file consumes a project, build, or configuration value", () => {
    for (const file of [SERVER_URL, MAIN, PRELOAD, OFFLINE, SHELL_PACKAGE]) {
      const source = code(read(file));

      for (const banned of [
        "projectId",
        "project_id",
        "buildJob",
        "build_jobs",
        "buildJobId",
        "artifact",
        "GeneratedPosConfig",
        "config_snapshot",
        "businessName",
        "menuItems",
      ]) {
        expect(`${file}: ${source}`).not.toContain(banned);
      }
    }
  });

  it("the URL is never assembled from a runtime value", () => {
    const source = code(read(SERVER_URL));

    // Every URL in this module is a tracked literal or the operator's own
    // development override. Nothing is interpolated from deployment state.
    expect(source).not.toContain("VERCEL_URL");
    expect(source).not.toContain("NEXT_PUBLIC_");
    expect(source).not.toContain("process.env.VERCEL");
  });

  it("carries no credential of any kind", () => {
    // Deliberately reads RAW source, comments included: a leaked key pasted into
    // a comment is still a leaked key. That rules out matching English words —
    // these files legitimately discuss secrets in prose ("NO SECRET BELONGS
    // HERE") — so the patterns below match credential SHAPES and exact variable
    // names instead, which prose cannot produce by accident.
    const patterns: [string, RegExp][] = [
      ["service-role key name", /SUPABASE_SERVICE_ROLE_KEY/],
      ["anon key name", /SUPABASE_ANON_KEY/],
      ["a JWT", /eyJ[A-Za-z0-9_-]{10,}/],
      ["an assigned credential", /(secret|api[_-]?key|password|token)\s*[:=]\s*["'`]\S/i],
      ["a bearer header", /Bearer\s+[A-Za-z0-9._-]{10,}/],
    ];

    for (const file of [SERVER_URL, MAIN, PRELOAD, OFFLINE, SHELL_PACKAGE]) {
      const source = read(file);

      for (const [label, pattern] of patterns) {
        expect(`${file} contains ${label}`).toBe(`${file} contains ${label}`);
        expect(pattern.test(source)).toBe(false);
      }
    }
  });

  it("bundles no POS runtime — the fallback page is a message, not a till", () => {
    // Comment-stripped, per this repository's convention: the page's own header
    // explains WHY it carries no cached menu or prices, and that explanation
    // must not trip the guard whose subject is the rendered page.
    const offline = code(read(OFFLINE)).toLowerCase();

    for (const banned of [
      "localstorage",
      "sessionstorage",
      "indexeddb",
      "fetch(",
      "menu",
      "price",
      "cart",
      "checkout",
    ]) {
      expect(`offline.html: ${offline}`).not.toContain(banned);
    }

    // And it does not claim a capability this product does not have.
    expect(offline).not.toMatch(/offline mode|work offline|offline sales/);
  });

  it("the fallback page loads nothing from the network", () => {
    // It is shown precisely when the network is unavailable.
    const offline = code(read(OFFLINE));

    expect(offline).not.toMatch(/<script[^>]+src=/);
    expect(offline).not.toMatch(/<link[^>]+href=/);
    expect(offline).not.toMatch(/<img/);
    expect(offline).not.toContain("https://");
    expect(offline).not.toContain("http://");
  });
});

// ---------------------------------------------------------------------------
// Electron security defaults — present from the first commit
// ---------------------------------------------------------------------------

describe("the main process carries the locked security defaults", () => {
  const main = code(read(MAIN));

  it("sets all four structural webPreferences", () => {
    expect(main).toContain("contextIsolation: true");
    expect(main).toContain("nodeIntegration: false");
    expect(main).toContain("sandbox: true");
    expect(main).toContain("webviewTag: false");
  });

  it("never enables Node integration or disables isolation anywhere", () => {
    expect(main).not.toContain("nodeIntegration: true");
    expect(main).not.toContain("contextIsolation: false");
    expect(main).not.toContain("sandbox: false");
    expect(main).not.toContain("nodeIntegrationInWorker");
    expect(main).not.toContain("enableRemoteModule");
  });

  it("pins the application name, which the storage directory derives from", () => {
    // Renaming this moves %APPDATA%\POS Canvas and unpairs every till.
    expect(main).toContain('app.setName("POS Canvas")');
  });

  it("opens a normal, exitable, resizable window — not a kiosk", () => {
    expect(main).toContain("resizable: true");
    expect(main).toContain("fullscreen: false");
    expect(main).toContain("kiosk: false");
  });

  it("quits on Windows when the last window closes", () => {
    expect(main).toContain('process.platform !== "darwin"');
    expect(main).toContain("app.quit()");
  });

  it("loads the runtime URL through one resolved value", () => {
    expect(main).toContain("readDesktopServerUrl()");
    expect(main).toContain("window.loadURL(resolvedServer.url)");
    // No second, divergent source of the destination.
    expect(main).not.toMatch(/loadURL\(["'`]http/);
  });
});

describe("the preload is minimal and carries no payload", () => {
  const preload = code(read(PRELOAD));

  it("exposes exactly one bridge key", () => {
    const exposures = preload.match(/exposeInMainWorld\(/g) ?? [];
    expect(exposures).toHaveLength(1);
    expect(preload).toContain('exposeInMainWorld("posCanvasShell"');
  });

  it("sends a channel with no arguments", () => {
    expect(preload).toContain('ipcRenderer.send("pos-canvas-shell:retry")');
    // A destination crossing this bridge is the thing being prevented.
    expect(preload).not.toMatch(/send\([^)]*,[^)]*\)/);
  });

  it("does not hand the page ipcRenderer, invoke, or Node", () => {
    expect(preload).not.toContain("exposeInMainWorld(\"ipcRenderer\"");
    expect(preload).not.toContain("ipcRenderer.invoke");
    expect(preload).not.toMatch(/require\(["'](fs|path|child_process|os)["']\)/);
    expect(preload).not.toContain("process.env");
  });

  it("adds no desktop identity signal — that is Feature 23.3", () => {
    for (const premature of ["platform", "isDesktop", "windows", "DevicePlatform"]) {
      expect(`preload: ${preload}`).not.toContain(premature);
    }
  });

  it("the retry handler ignores the remote page", () => {
    const main = code(read(MAIN));
    expect(main).toContain('senderUrl.startsWith("file://")');
  });
});

// ---------------------------------------------------------------------------
// Dependency isolation
// ---------------------------------------------------------------------------

describe("Electron never enters the web application", () => {
  const rootPackage = JSON.parse(read("package.json")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  it("the root package.json declares no Electron dependency", () => {
    const declared = Object.keys({
      ...rootPackage.dependencies,
      ...rootPackage.devDependencies,
    });

    for (const name of declared) {
      expect(name).not.toMatch(/^electron($|-)/);
      expect(name).not.toMatch(/^@electron\//);
    }
  });

  it("the root lockfile gains no Electron package", () => {
    // electron-to-chromium is a browserslist data package with no relation to
    // Electron the runtime, and predates this feature.
    const lock = JSON.parse(read("package-lock.json")) as {
      packages: Record<string, unknown>;
    };

    // The boundary matters: "electron-to-chromium" must NOT match. It is
    // browserslist data with no relation to the Electron runtime, it is a
    // long-standing transitive dependency of the web build, and a guard that
    // flagged it would have to be weakened to pass — which is how a guard stops
    // meaning anything.
    const electronEntries = Object.keys(lock.packages).filter((path) =>
      /(^|\/)node_modules\/(electron|@electron\/[^/]+)(\/|$)/.test(path)
    );

    expect(electronEntries).toEqual([]);
  });

  it("the shell owns its own npm project", () => {
    expect(existsSync(join(repoRoot, SHELL_PACKAGE))).toBe(true);
    expect(existsSync(join(repoRoot, SHELL_LOCK))).toBe(true);
  });

  it("the shell pins an exact Electron version, never a range", () => {
    const shellPackage = JSON.parse(read(SHELL_PACKAGE)) as {
      devDependencies: Record<string, string>;
      dependencies?: Record<string, string>;
    };

    const version = shellPackage.devDependencies.electron;

    expect(version).toBeDefined();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    // A range here would let a Chromium version change arrive silently on a
    // payments surface.
    expect(version).not.toMatch(/[\^~*x]|latest|>|</);
  });

  it("the shell's lockfile resolves that same exact version", () => {
    const lock = JSON.parse(read(SHELL_LOCK)) as {
      packages: Record<string, { version?: string }>;
    };
    const shellPackage = JSON.parse(read(SHELL_PACKAGE)) as {
      devDependencies: Record<string, string>;
    };

    expect(lock.packages["node_modules/electron"]?.version).toBe(
      shellPackage.devDependencies.electron
    );
  });

  it("no packaging tooling was added in this phase", () => {
    // electron-builder, NSIS configuration and the installer belong to 23.4.
    const shellPackage = read(SHELL_PACKAGE);

    expect(shellPackage).not.toContain("electron-builder");
    expect(shellPackage).not.toContain("electron-forge");
    expect(shellPackage).not.toContain("nsis");
    expect(existsSync(join(repoRoot, SHELL_DIR, "electron-builder.yml"))).toBe(false);
    expect(existsSync(join(repoRoot, SHELL_DIR, "build"))).toBe(false);
  });

  it("the shell's node_modules cannot be committed", () => {
    expect(read(".gitignore")).toContain("/windows-shell/node_modules");
  });
});

// ---------------------------------------------------------------------------
// Scope — nothing from a later phase leaked in
// ---------------------------------------------------------------------------

describe("Feature 23.1 stops where it was scoped to stop", () => {
  const main = code(read(MAIN));

  // The 23.1 fence that asserted navigation, window-open, permission, download
  // and single-instance controls were ABSENT was removed when Feature 23.2 added
  // them deliberately. Their presence is now asserted positively in
  // lib/windowsShellSecurity.guards.test.ts, which is where the security posture
  // belongs. `certificate-error` is the one member of that old list that must
  // stay absent forever, and it moved to the same file as a TLS guard rather
  // than remaining here as a phase fence.

  it("adds no 23.3 device identity", () => {
    expect(main).not.toContain("DevicePlatform");
    expect(code(read("lib/deviceSession.ts"))).toContain(
      'export type DevicePlatform = "android" | "web"'
    );
  });

  it("introduces no Windows release metadata", () => {
    expect(existsSync(join(repoRoot, "lib/windowsRelease.ts"))).toBe(false);
    expect(code(read("lib/platformDownloads.ts"))).not.toContain("windowsRelease");
  });

  it("leaves Windows as coming_soon on every surface", () => {
    const model = code(read("lib/platformDownloads.ts"));

    expect(model).toContain("export const WINDOWS_DOWNLOAD: ComingSoonPlatformDownload");
    expect(model).toContain('status: "coming_soon"');
    expect(model).not.toContain("getWindowsDownload");
  });

  it("adds no GitHub Actions workflow", () => {
    expect(existsSync(join(repoRoot, ".github/workflows/windows-app.yml"))).toBe(false);
    expect(existsSync(join(repoRoot, ".github/workflows/windows.yml"))).toBe(false);
  });

  it("leaves the Android shell untouched", () => {
    const android = code(read("android-shell/serverUrl.mjs"));

    expect(android).toContain(
      'export const PRODUCTION_ANDROID_SERVER_URL = "https://pos-canvas.vercel.app/device"'
    );
    expect(android).not.toContain("DESKTOP");
    expect(code(read("capacitor.config.ts"))).toContain('appId: "com.poscanvas.app"');
  });
});
