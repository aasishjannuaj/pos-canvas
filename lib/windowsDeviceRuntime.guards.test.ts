// Feature 24.5F — the Windows shell's LOCALLY PACKAGED device runtime.
//
// SAME DEFECT ANDROID HAD, and it was found the same way: the shell loaded
// /device from a hosted URL, so a PC with no network could not execute the
// runtime at all — Electron fell to a static "no internet" page and every
// offline capability sat behind it, unreachable. Android's fix is hardware
// proven; this is the same bundle, served from app://poscanvas.
//
// Two halves are tested here. The pure protocol resolver is exercised
// BEHAVIOURALLY — it is the piece most likely to grow a path-traversal bug, and
// it is pure precisely so that can be tested under plain Node. The wiring around
// it is asserted STRUCTURALLY, because "the scheme is registered before app
// ready" is not something a unit test can observe.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APP_HOST,
  APP_ORIGIN,
  APP_SCHEME,
  isAppRuntimeUrl,
  resolveAppAssetPath,
} from "../windows-shell/appProtocol.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf-8");
}

function exists(relativePath: string): boolean {
  return existsSync(join(repoRoot, relativePath));
}

function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const MAIN = "windows-shell/main.mjs";
const POLICY = "windows-shell/navigationPolicy.mjs";
const PROTOCOL = "windows-shell/appProtocol.mjs";
const SHELL_PACKAGE = "windows-shell/package.json";

/** A stand-in runtime root. Path handling must not depend on it existing. */
const ROOT = resolve("/opt/pos-canvas/runtime");

// ---------------------------------------------------------------------------
// The origin
// ---------------------------------------------------------------------------

describe("the Windows device origin is app://poscanvas", () => {
  it("pins the scheme and the host as permanent constants", () => {
    expect(APP_SCHEME).toBe("app");
    expect(APP_HOST).toBe("poscanvas");
    expect(APP_ORIGIN).toBe("app://poscanvas");
  });

  it("accepts only that exact scheme and host", () => {
    expect(isAppRuntimeUrl("app://poscanvas/index.html")).toBe(true);
    expect(isAppRuntimeUrl("app://poscanvas/assets/index-abc.js")).toBe(true);

    for (const hostile of [
      "app://evil/index.html",
      "app://poscanvas.evil.example/index.html",
      "app://poscanvasevil/index.html",
      "app://poscanvas.localhost/index.html",
      "appx://poscanvas/index.html",
      "https://poscanvas/index.html",
      "file:///C:/runtime/index.html",
      "app://user:pass@poscanvas/index.html",
      "not a url",
      "",
    ]) {
      expect(`accepts ${hostile}`).toBe(`accepts ${hostile}`);
      expect(isAppRuntimeUrl(hostile)).toBe(false);
    }
  });

  it("never decides anything by comparing origins", () => {
    // THE TRAP. `app:` is not a special scheme, so Node reports origin "null"
    // for EVERY app:// URL — an origin allow-list would match nothing, and
    // "fixing" it with "null" would match every host at once.
    expect(new URL("app://poscanvas/x").origin).toBe("null");
    expect(new URL("app://evil/x").origin).toBe("null");

    const protocolSource = code(read(PROTOCOL));

    expect(protocolSource).toContain("parsed.host === APP_HOST");
    expect(protocolSource).not.toMatch(/parsed\.origin\s*===/);
  });
});

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

describe("app:// requests map safely onto the packaged runtime", () => {
  it("serves the entry document for the root and for directories", () => {
    expect(resolveAppAssetPath("app://poscanvas/", ROOT)).toBe(join(ROOT, "index.html"));
    expect(resolveAppAssetPath("app://poscanvas", ROOT)).toBe(join(ROOT, "index.html"));
    expect(resolveAppAssetPath("app://poscanvas/assets/", ROOT)).toBe(
      join(ROOT, "assets", "index.html")
    );
  });

  it("maps ordinary asset paths", () => {
    expect(resolveAppAssetPath("app://poscanvas/index.html", ROOT)).toBe(
      join(ROOT, "index.html")
    );
    expect(resolveAppAssetPath("app://poscanvas/assets/index-abc123.js", ROOT)).toBe(
      join(ROOT, "assets", "index-abc123.js")
    );
  });

  it("ignores query and hash, which address nothing on a filesystem", () => {
    // A cache-busted asset must serve the file, not 404.
    expect(resolveAppAssetPath("app://poscanvas/assets/a.js?v=2", ROOT)).toBe(
      join(ROOT, "assets", "a.js")
    );
    expect(resolveAppAssetPath("app://poscanvas/index.html#receipt", ROOT)).toBe(
      join(ROOT, "index.html")
    );
  });

  it("REFUSES every escape from the runtime directory", () => {
    for (const hostile of [
      "app://poscanvas/../secret",
      "app://poscanvas/../../etc/passwd",
      // The one the URL parser does NOT collapse: percent-encoded separators
      // survive parsing and only reveal themselves after decoding.
      "app://poscanvas/assets/..%2f..%2fsecret",
      "app://poscanvas/assets/..%2F..%2Fsecret",
      "app://poscanvas/%2e%2e%2f%2e%2e%2fsecret",
      "app://poscanvas/assets/%2e%2e/%2e%2e/secret",
    ]) {
      const resolved = resolveAppAssetPath(hostile, ROOT);

      expect(`escaped with ${hostile}`).toBe(`escaped with ${hostile}`);

      if (resolved !== null) {
        // Whatever it resolved to, it must still be inside the root.
        expect(resolved.startsWith(`${ROOT}${sep}`)).toBe(true);
      }
    }
  });

  it("refuses a sibling directory whose name merely starts with the root's", () => {
    // `/opt/pos-canvas/runtime-evil` must not pass a naive startsWith(root).
    const resolved = resolveAppAssetPath("app://poscanvas/..%2fruntime-evil%2fx", ROOT);

    if (resolved !== null) {
      expect(resolved.startsWith(`${ROOT}${sep}`)).toBe(true);
    }
  });

  it("refuses a NUL byte and a malformed escape", () => {
    expect(resolveAppAssetPath("app://poscanvas/a%00.js", ROOT)).toBeNull();
    expect(resolveAppAssetPath("app://poscanvas/%E0%A4%A", ROOT)).toBeNull();
  });

  it("refuses anything that is not ours, with the same answer", () => {
    // Null for BOTH "not ours" and "outside the root", so a probe cannot tell
    // the two apart from the 404 the caller returns.
    expect(resolveAppAssetPath("app://evil/index.html", ROOT)).toBeNull();
    expect(resolveAppAssetPath("file:///etc/passwd", ROOT)).toBeNull();
    expect(resolveAppAssetPath("https://pos-canvas.vercel.app/device", ROOT)).toBeNull();
  });

  it("resolves a missing file to a path — existence is the caller's 404", () => {
    // Separation of concerns: this function decides WHICH file, not whether it
    // is there. main.mjs answers 404 when the read fails.
    expect(resolveAppAssetPath("app://poscanvas/nope.js", ROOT)).toBe(
      join(ROOT, "nope.js")
    );
  });
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

describe("the shell serves its own runtime and needs no network to boot", () => {
  const main = code(read(MAIN));

  it("registers the scheme as privileged before app ready", () => {
    // CORRECTED: this guard previously asserted `registerSchemeAsPrivileged` —
    // singular, and not a function Electron has. It passed while the packaged
    // app could not start at all, because a source string cannot know whether
    // an API exists. The name is checked against Electron's real export list in
    // lib/windowsStartup.smoke.test.ts; what is checked HERE is the ordering,
    // which no unit test can observe.
    expect(main).toContain("protocol.registerSchemesAsPrivileged([");
    expect(main).not.toContain("registerSchemeAsPrivileged(");

    const register = main.indexOf("protocol.registerSchemesAsPrivileged([");
    const ready = main.indexOf("app.whenReady()");

    expect(register).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(register);
  });

  it("grants only the privileges the POS actually needs", () => {
    const block = main.slice(
      main.indexOf("protocol.registerSchemesAsPrivileged(["),
      main.indexOf("app.whenReady()")
    );

    // standard  -> a real origin, so IndexedDB/localStorage have somewhere to live
    // secure    -> a secure context, so crypto.subtle exists for the config digest
    expect(block).toContain("standard: true");
    expect(block).toContain("secure: true");
    expect(block).toContain("supportFetchAPI: true");

    for (const banned of ["bypassCSP", "allowServiceWorkers", "corsEnabled", "stream"]) {
      expect(`grants ${banned}`).toBe(`grants ${banned}`);
      expect(block).not.toContain(banned);
    }
  });

  it("loads the packaged runtime, never a hosted URL", () => {
    expect(main).toContain("window.loadURL(RUNTIME_ENTRY)");
    expect(main).toContain("const RUNTIME_ENTRY = `${APP_ORIGIN}/index.html`");
    expect(main).not.toContain("loadURL(resolvedServer.url)");
    expect(main).not.toMatch(/loadURL\(["'`]http/);
  });

  it("serves through the tested resolver rather than its own path logic", () => {
    expect(main).toContain("resolveAppAssetPath(request.url, RUNTIME_ROOT)");
    expect(main).toContain("protocol.handle(APP_SCHEME");
    // A null answer is a 404, and the file read failing is a 404 too.
    expect(main).toContain('new Response("Not found", { status: 404 })');
    // No hand-rolled path arithmetic in the main process.
    expect(main).not.toContain("path.join(RUNTIME_ROOT");
    expect(main).not.toContain("__dirname + ");
  });

  it("removes the stock application menu without touching the window frame", () => {
    // The tester saw File / Edit / View / Window: Electron installs a default
    // menu when none is set, and this shell never set one.
    expect(main).toContain("Menu.setApplicationMenu(null)");
    expect(main).toContain("autoHideMenuBar: true");

    // Removed, not merely hidden — so Alt cannot summon it either.
    const removal = main.indexOf("Menu.setApplicationMenu(null)");
    const created = main.indexOf("new BrowserWindow(");

    expect(removal).toBeGreaterThan(-1);
    expect(created).toBeGreaterThan(-1);

    // And the window keeps its normal controls.
    expect(main).not.toContain("frame: false");
    expect(main).not.toContain("titleBarStyle:");
  });

  it("calls the removal before any window exists", () => {
    const call = main.indexOf("removeApplicationMenu();");
    const create = main.indexOf("createWindow();");

    expect(call).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(call);
  });

  it("holds the splash long enough to be seen, then loads the runtime", () => {
    // The local runtime resolves in milliseconds, so without a floor the brand
    // animation was replaced before a single 1.4s cycle could play.
    expect(main).toContain("const SPLASH_MINIMUM_VISIBLE_MS = 1400");

    const splash = main.indexOf("window.loadFile(SPLASH_PAGE)");
    const hold = main.indexOf("delay(SPLASH_MINIMUM_VISIBLE_MS)");
    const runtime = main.indexOf("loadDeviceRuntime(window);", splash);

    expect(splash).toBeGreaterThan(-1);
    expect(hold).toBeGreaterThan(splash);
    expect(runtime).toBeGreaterThan(hold);

    // Concurrent, not sequential: startup costs max(load, hold), not the sum.
    expect(main).toContain("Promise.all([");
    // A splash that fails to load must never stop the till starting.
    expect(main).toContain("window.loadFile(SPLASH_PAGE).catch(() => undefined)");
    expect(main).not.toContain("loadFile(SPLASH_PAGE).finally(");
  });

  it("keeps every Electron security default intact", () => {
    expect(main).toContain("contextIsolation: true");
    expect(main).toContain("nodeIntegration: false");
    expect(main).toContain("sandbox: true");
    expect(main).not.toContain("webSecurity: false");
    expect(main).not.toContain("allowRunningInsecureContent");
    expect(main).not.toContain("devTools: true");
  });

  it("does not need the hosted origin to boot", () => {
    // serverUrl.mjs survives only for the release flag that governs DevTools.
    expect(main).not.toContain("loadURL(resolvedServer.url)");

    const policy = code(read(POLICY));

    expect(policy).toContain("export const PRODUCTION_ORIGIN = APP_ORIGIN;");
    expect(policy).not.toContain("PRODUCTION_DESKTOP_SERVER_URL");
  });
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

describe("navigation is pinned to the app's own scheme and host", () => {
  const policy = code(read(POLICY));

  it("matches the app scheme on scheme AND host, never on origin", () => {
    expect(policy).toContain("parsed.protocol === `${APP_SCHEME}:`");
    expect(policy).toContain("isAppRuntimeUrl(url)");
  });

  it("does not add a bare scheme to a broad allow-list", () => {
    // `NAVIGABLE_PROTOCOLS` gates the scheme, but the host check is what
    // actually decides — adding "app:" alone would admit every app:// host.
    expect(policy).not.toMatch(/allowedOrigins\.push\(["'`]app:/);
    expect(policy).not.toContain('"app://"');
  });

  it("file: is not navigable", () => {
    expect(policy).toContain('const NAVIGABLE_PROTOCOLS = new Set(["https:", "http:", `${APP_SCHEME}:`])');
    expect(policy).not.toContain('"file:"');
  });
});

// ---------------------------------------------------------------------------
// Packaging
// ---------------------------------------------------------------------------

describe("the installer carries the runtime and nothing customer-specific", () => {
  it("packages the built runtime directory", () => {
    const shellPackage = JSON.parse(read(SHELL_PACKAGE));

    expect(shellPackage.build.files).toContain("runtime/**/*");
    expect(shellPackage.build.files).toContain("appProtocol.mjs");
  });

  it("builds that runtime from the SAME source Android uses", () => {
    const manifest = JSON.parse(read("package.json"));

    // Feature 25.6 P0-1 — the scripts now go through native-device/build.mjs
    // rather than naming the vite config directly, because a POSIX inline env
    // assignment cannot run under cmd.exe on the Windows CI runner. The property
    // guarded here is unchanged: the runtime is built from the ONE shared
    // native-device config, so there is no android copy and no windows copy.
    expect(manifest.scripts["windows:runtime"]).toContain("native-device/build.mjs");
    expect(manifest.scripts["android:runtime"]).toContain("native-device/build.mjs");
    expect(read("native-device/build.mjs")).toContain('resolve(here, "vite.config.mts")');
    // One source, two output directories — no android copy and no windows copy.
    expect(manifest.scripts["windows:runtime"]).toContain("windows-shell/runtime");
  });

  it("windows-shell holds no POS or financial logic of its own", () => {
    const walk = (relative: string): string[] => {
      const out: string[] = [];

      for (const name of readdirSync(join(repoRoot, relative))) {
        const next = `${relative}/${name}`;

        if (["runtime", "node_modules", "dist", "build"].includes(name)) continue;
        if (statSync(join(repoRoot, next)).isDirectory()) {
          out.push(...walk(next));
          continue;
        }
        if (/\.(mjs|js|cjs)$/.test(name)) out.push(next);
      }

      return out;
    };

    const sources = walk("windows-shell");

    expect(sources.length).toBeGreaterThan(0);

    for (const file of sources) {
      const source = code(read(file));

      for (const banned of [
        "calculateCartSummary",
        "buildSaleRequestItems",
        "enqueueSale",
        "complete_sale",
        "createCartItem",
        "sale_request_id",
        "supabase",
      ]) {
        expect(`${file} duplicates ${banned}`).toBe(`${file} duplicates ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("the built runtime, when present, is the real POS", () => {
    if (!exists("windows-shell/runtime/assets")) return;

    const assets = readdirSync(join(repoRoot, "windows-shell/runtime/assets"));
    const js = assets.filter((name) => name.endsWith(".js"));

    expect(js).toHaveLength(1);

    const bundle = read(`windows-shell/runtime/assets/${js[0]}`);

    for (const marker of [
      "pos-canvas-device",
      "sale-queue",
      "uncertain-online-sale",
      "OFFLINE RECEIPT",
      "complete_sale_v3",
      "complete_sale_v4",
    ]) {
      expect(`runtime missing ${marker}`).toBe(`runtime missing ${marker}`);
      expect(bundle).toContain(marker);
    }

    for (const banned of [
      "vercel.app",
      "service_role",
      "node:crypto",
      "It should only be used from a Server Component",
    ]) {
      expect(`runtime contains ${banned}`).toBe(`runtime contains ${banned}`);
      expect(bundle).not.toContain(banned);
    }
  });

  it("the offline database schema is unchanged", () => {
    const store = code(read("lib/deviceOfflineStore.ts"));

    expect(store).toContain("export const OFFLINE_DB_VERSION = 2");
    expect(store).toContain('export const CACHE_STORE = "device-cache"');
    expect(store).toContain('export const SALE_QUEUE_STORE = "sale-queue"');
  });

  it("secure-context hashing is still SHA-256", () => {
    expect(code(read("lib/deviceOfflineCache.ts"))).toContain(
      'subtle.digest("SHA-256", bytes)'
    );
  });

  it("v3 stays online checkout and v4 stays queue-sync only", () => {
    const rpc = code(read("lib/device.rpc.ts"));

    expect(rpc).toContain('rpc("complete_sale_v3"');
    expect(rpc).not.toContain("complete_sale_v4");
    expect(code(read("lib/offlineSaleRpc.ts"))).toContain('rpc("complete_sale_v4"');
  });
});
