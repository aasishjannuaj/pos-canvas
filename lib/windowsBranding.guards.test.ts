// Feature 24.3 — the Windows brand assets and the branded startup screen.
//
// WHY THESE ARE STRUCTURAL, NOT VISUAL: nothing in this repository can look at
// an ICO and judge whether it is the approved mark. What it CAN do is assert the
// things that silently ship a broken-looking Windows app — a missing size in the
// icon directory (Windows then scales a neighbour and the taskbar goes muddy),
// an 8bpp frame whose 1-bit mask turns the mark's soft edge into a jagged
// cut-out, an installer bitmap at the wrong dimensions for MUI, a splash that
// quietly acquired a bridge or a customer's name, or a startup screen that
// collapsed into the offline page. Every one of those looks fine in a diff.
//
// THE SEPARATION THIS ALSO PROTECTS, exactly as on Android: these are POS
// CANVAS's marks. A customer's own logo lives in their project configuration and
// belongs only inside their till. Neither may become the other.
//
// The ICO is parsed here rather than trusted: the file is read as bytes and its
// directory decoded, so "contains 16px" means the icon directory really has that
// entry, not that a filename looked right.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BRAND } from "@/lib/brand";
import { CURRENT_WINDOWS_RELEASE } from "@/lib/windowsRelease";
import { CURRENT_ANDROID_RELEASE } from "@/lib/androidRelease";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf-8");
}

function bytes(relativePath: string): Buffer {
  return readFileSync(join(repoRoot, relativePath));
}

function exists(relativePath: string): boolean {
  return existsSync(join(repoRoot, relativePath));
}

/** Strips comments so explanatory prose never trips a guard. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const BUILD = "windows-shell/build";
const ICON = `${BUILD}/icon.ico`;
const HEADER = `${BUILD}/installerHeader.bmp`;
const SIDEBAR = `${BUILD}/installerSidebar.bmp`;
const SPLASH = "windows-shell/splash.html";
const SPLASH_ART = "windows-shell/splash-mark.png";
const OFFLINE = "windows-shell/offline.html";
const MAIN = "windows-shell/main.mjs";
const PRELOAD = "windows-shell/preload.js";
const SHELL_PACKAGE = "windows-shell/package.json";
const GENERATOR = "assets/brand/generate-windows-assets.sh";

interface IconEntry {
  width: number;
  height: number;
  bitsPerPixel: number;
  isPng: boolean;
}

/**
 * Decodes an ICO's directory.
 *
 * The format stores 256 as a zero byte, which is the detail a naive reader gets
 * wrong — it would report the largest icon as 0x0 and a "has 256" assertion
 * would fail on a correct file.
 */
function readIconDirectory(relativePath: string): IconEntry[] {
  const buffer = bytes(relativePath);

  expect(buffer.readUInt16LE(0)).toBe(0); // reserved
  expect(buffer.readUInt16LE(2)).toBe(1); // 1 = icon, 2 = cursor

  const count = buffer.readUInt16LE(4);
  const entries: IconEntry[] = [];

  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    const dataOffset = buffer.readUInt32LE(offset + 12);

    entries.push({
      width: buffer.readUInt8(offset) || 256,
      height: buffer.readUInt8(offset + 1) || 256,
      bitsPerPixel: buffer.readUInt16LE(offset + 6),
      isPng: buffer.subarray(dataOffset, dataOffset + 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      ),
    });
  }

  return entries;
}

/** Reads a BMP's dimensions from its DIB header. */
function bmpSize(relativePath: string): { width: number; height: number } {
  const buffer = bytes(relativePath);

  expect(buffer.subarray(0, 2).toString()).toBe("BM");

  return { width: buffer.readInt32LE(18), height: buffer.readInt32LE(22) };
}

// ---------------------------------------------------------------------------
// The application icon
// ---------------------------------------------------------------------------

describe("the Windows icon is a real multi-resolution ICO", () => {
  it("exists at the path electron-builder resolves by convention", () => {
    // directories.buildResources defaults to "build", and app-builder-lib's
    // iconConverter appends "icon.ico" to its candidate list. This exact path is
    // therefore the whole wiring — see the package.json guard below.
    expect(exists(ICON)).toBe(true);
    expect(statSync(join(repoRoot, ICON)).size).toBeGreaterThan(1000);
  });

  it("contains every size Windows asks for", () => {
    // 16 taskbar/title bar, 24 tree views, 32 desktop + alt-tab, 48 large
    // shortcut, 64/128 intermediate scale factors, 256 the Explorer extra-large
    // view and the installer. A missing entry is not a hard failure — Windows
    // scales a neighbour — which is exactly why it needs a guard: the symptom is
    // "looks slightly wrong", never a build error.
    const sizes = readIconDirectory(ICON).map((entry) => entry.width);

    for (const required of [16, 24, 32, 48, 64, 128, 256]) {
      expect(`icon.ico is missing ${required}px`).toBe(`icon.ico is missing ${required}px`);
      expect(sizes).toContain(required);
    }
  });

  it("is square at every size", () => {
    for (const entry of readIconDirectory(ICON)) {
      expect(`${entry.width}x${entry.height}`).toBe(`${entry.width}x${entry.width}`);
    }
  });

  it("carries full alpha at every size, not a 1-bit mask", () => {
    // THE FAILURE THIS CATCHES: ImageMagick palettises any frame that fits 256
    // colours, and at 16x16 the mark uses 209. An 8bpp ICO frame has a 1-bit
    // transparency mask, so the mark's anti-aliased edge becomes a hard jagged
    // cut-out at the smallest and least forgiving size. The generator pins the
    // type at ICO-encode time; this proves it stuck.
    for (const entry of readIconDirectory(ICON)) {
      expect(`${entry.width}px is ${entry.bitsPerPixel}bpp`).toBe(`${entry.width}px is 32bpp`);
    }
  });

  it("stores the 256px frame PNG-compressed", () => {
    // A raw 256x256 BGRA frame is 256 KB on its own. PNG compression for that
    // one entry is the documented convention and every Windows since Vista
    // reads it.
    const largest = readIconDirectory(ICON).find((entry) => entry.width === 256);

    expect(largest?.isPng).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// How the icon is wired
// ---------------------------------------------------------------------------

describe("the icon reaches every Windows surface", () => {
  const shellPackage = JSON.parse(read(SHELL_PACKAGE));

  it("is wired by convention, with no path duplicated into config", () => {
    // electron-builder finds build/icon.ico by itself, and that ONE file becomes
    // the executable icon, the taskbar and Start Menu icon, the desktop shortcut
    // icon, the Apps-and-Features entry, and — because nsis.installerIcon and
    // nsis.uninstallerIcon both default to the application icon — the installer
    // and uninstaller icons too. Naming a path here would add a second source of
    // truth for something already unambiguous.
    const raw = read(SHELL_PACKAGE);

    expect(raw).not.toContain('"icon"');
    expect(raw).not.toContain("installerIcon");
    expect(raw).not.toContain("uninstallerIcon");
    expect(exists(ICON)).toBe(true);
  });

  it("keeps the identity the icon is attached to", () => {
    expect(shellPackage.build.appId).toBe(BRAND.appId);
    expect(shellPackage.build.productName).toBe(BRAND.productName);
    expect(shellPackage.productName).toBe(BRAND.productName);
    expect(shellPackage.build.nsis.shortcutName).toBe(BRAND.productName);
  });

  it("does not touch the version branding was never allowed to move", () => {
    // Feature 25.7 — the point is that ARTWORK does not move the version, not
    // that the version is forever 1.0.0. Asserted as a semver rather than a
    // literal so a release bump is not blocked by an icon guard.
    expect(shellPackage.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// ---------------------------------------------------------------------------
// Installer artwork
// ---------------------------------------------------------------------------

describe("the NSIS wizard bitmaps match what MUI expects", () => {
  it("the sidebar is 164x314", () => {
    // MEASURED FROM THE TOOLCHAIN, not from a blog post: NSIS 3.0.4.1's own
    // Contrib/Graphics/Wizard/nsis3-metro.bmp — the file electron-builder falls
    // back to — is exactly this size. MUI does not scale it; a wrong size is
    // drawn wrong.
    expect(bmpSize(SIDEBAR)).toEqual({ width: 164, height: 314 });
  });

  it("the header is 150x57", () => {
    expect(bmpSize(HEADER)).toEqual({ width: 150, height: 57 });
  });

  it("both are BMP, which is the only format MUI reads", () => {
    for (const asset of [HEADER, SIDEBAR]) {
      expect(`${asset} is not a BMP`).toBe(`${asset} is not a BMP`);
      expect(bytes(asset).subarray(0, 2).toString()).toBe("BM");
    }
  });

  it("no uninstaller sidebar is duplicated", () => {
    // electron-builder defaults uninstallerSidebar to installerSidebar. A second
    // identical file would be one more thing to keep in sync for no gain.
    expect(exists(`${BUILD}/uninstallerSidebar.bmp`)).toBe(false);
  });

  it("adds no custom NSIS script for cosmetics", () => {
    // Inspected as KEYS, not as substrings of the file: "script" is a substring
    // of the perfectly ordinary top-level "scripts" block, so a text search here
    // asserts nothing and fails for the wrong reason. These are the
    // electron-builder options that inject raw NSIS — the fragile path this
    // feature deliberately did not take for artwork.
    const nsisKeys = Object.keys(JSON.parse(read(SHELL_PACKAGE)).build.nsis);

    for (const fragile of [
      "include",
      "script",
      "customNsisBinary",
      "warningsAsErrors",
    ]) {
      expect(`nsis.${fragile}`).toBe(`nsis.${fragile}`);
      expect(nsisKeys).not.toContain(fragile);
    }
  });
});

// ---------------------------------------------------------------------------
// The startup screen
// ---------------------------------------------------------------------------

describe("the splash is platform branding and nothing else", () => {
  const splash = read(SPLASH);

  it("exists and is packaged", () => {
    const shellPackage = JSON.parse(read(SHELL_PACKAGE));

    expect(exists(SPLASH)).toBe(true);
    expect(exists(SPLASH_ART)).toBe(true);
    expect(shellPackage.build.files).toContain("splash.html");
    expect(shellPackage.build.files).toContain("splash-mark.png");
  });

  it("carries no customer, project, or business identity", () => {
    // The shell does not know any of these at startup, and this screen is
    // byte-identical on every till in the world. If one of these words ever
    // appears here, the universal-app invariant has been broken.
    for (const banned of [
      "businessName",
      "projectId",
      "project_id",
      "project-logos",
      "customerId",
      "ownerId",
      "GeneratedPosConfig",
      "accentColor",
    ]) {
      expect(`splash.html: ${banned}`).toBe(`splash.html: ${banned}`);
      expect(splash).not.toContain(banned);
    }
  });

  it("runs no script and reaches no network", () => {
    // No script means no capability can be used even if one were exposed; no
    // remote reference means the brand screen cannot itself be the thing waiting
    // on the network it exists to paper over.
    const markup = code(splash);

    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("http://");
    expect(markup).not.toContain("https://");
    expect(markup).not.toContain("posCanvasShell");
    expect(markup).not.toContain("posCanvasDesktop");
  });

  it("shows the approved mark from the generated local asset", () => {
    expect(splash).toContain('src="splash-mark.png"');
    expect(splash).toContain('alt="POS Canvas"');
  });

  it("uses the brand ground, matched by the window's first painted frame", () => {
    // Two places have to agree or the operator sees a flash of the wrong colour
    // before the brand screen: the BrowserWindow backgroundColor Chromium paints
    // before any document exists, and this page's own background.
    expect(splash).toContain("#fbfdfd");
    expect(code(read(MAIN))).toContain('backgroundColor: "#FBFDFD"');
  });
});

describe("the splash and the offline fallback stay separate", () => {
  it("both files exist, as different pages", () => {
    expect(exists(SPLASH)).toBe(true);
    expect(exists(OFFLINE)).toBe(true);
  });

  it("the main process loads each from its own constant", () => {
    const main = code(read(MAIN));

    expect(main).toContain('SPLASH_PAGE = fileURLToPath(new URL("./splash.html"');
    expect(main).toContain('OFFLINE_PAGE = fileURLToPath(new URL("./offline.html"');
    expect(main).toContain("window.loadFile(SPLASH_PAGE)");
    expect(main).toContain("window.loadFile(OFFLINE_PAGE)");
  });

  it("the splash never offers retry and the fallback still does", () => {
    // Collapsing them would either accuse the network before anything failed, or
    // make a failure look like normal loading.
    // code() strips comments: splash.html EXPLAINS the distinction in prose, and
    // the guard is about the rendered page, not the essay above it.
    expect(code(read(SPLASH))).not.toContain("Retry");
    expect(code(read(OFFLINE))).toContain("posCanvasShell");
  });

  it("the splash is shown first, held briefly, and never blocks the runtime", () => {
    // UPDATED BY 24.5F. The property is unchanged — a branded screen must never
    // become the reason a till does not start — but the mechanism moved: the
    // runtime is now local and resolves in milliseconds, so without a minimum
    // hold the 1.4s animation was replaced before a single cycle could play.
    //
    // `.catch(() => undefined)` replaces `.finally(...)` and keeps the same
    // guarantee: a splash that fails to load still lets the runtime through.
    const main = code(read(MAIN));

    expect(main).toContain("window.loadFile(SPLASH_PAGE).catch(() => undefined)");
    expect(main).toContain("delay(SPLASH_MINIMUM_VISIBLE_MS)");
    expect(main).toContain("loadDeviceRuntime(window);");
    expect(main).not.toContain("loadFile(SPLASH_PAGE).finally(");
  });

  it("adds no second BrowserWindow", () => {
    // One window means the splash inherits every Feature 23 control rather than
    // needing a second copy that could drift, and a second-instance activation
    // can never leave an orphan splash on screen.
    const main = code(read(MAIN));

    expect((main.match(/new BrowserWindow\(/g) ?? []).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Splash security
// ---------------------------------------------------------------------------

describe("the splash weakens no Feature 23 control", () => {
  const main = code(read(MAIN));

  it("the single window still sets all four locked webPreferences", () => {
    expect(main).toContain("contextIsolation: true");
    expect(main).toContain("nodeIntegration: false");
    expect(main).toContain("sandbox: true");
    expect(main).toContain("webviewTag: false");
  });

  it("no branding change negated one of them", () => {
    for (const banned of [
      "contextIsolation: false",
      "nodeIntegration: true",
      "sandbox: false",
      "webviewTag: true",
      "webSecurity: false",
      "allowRunningInsecureContent",
      "experimentalFeatures",
    ]) {
      expect(`main.mjs: ${banned}`).toBe(`main.mjs: ${banned}`);
      expect(main).not.toContain(banned);
    }
  });

  it("the deny-by-default handlers still apply to the one window", () => {
    expect(main).toContain("applySecurityPolicy(window)");
    expect(main).toContain('webContents.on("will-navigate", blockDisallowedNavigation)');
    expect(main).toContain('webContents.on("will-redirect", blockDisallowedNavigation)');
    expect(main).toContain("setWindowOpenHandler");
    expect(main).toContain("session.setPermissionRequestHandler");
    expect(main).toContain("session.setPermissionCheckHandler");
    expect(main).toContain('session.on("will-download"');
  });

  it("the splash is given no bridge at all", () => {
    // THE SUBSTANTIVE 24.3 SECURITY CHANGE. Until now "protocol is file:" was
    // the same question as "am I the offline page", because the fallback was the
    // only local document. splash.html made that false, so the retry capability
    // is now gated on the fallback BY NAME — the splash is local, has no Retry
    // button, and is not the hosted page, so it receives neither bridge.
    const preload = code(read(PRELOAD));

    expect(preload).toContain('window.location.pathname.endsWith("/offline.html")');
    expect(preload).toContain("if (isOfflineFallbackPage) {");

    // Still exactly two exposures, still mutually exclusive.
    expect((preload.match(/exposeInMainWorld\(/g) ?? []).length).toBe(2);
  });

  it("still pins the production URL and the DevTools rule", () => {
    // Feature 24.5F — the window now loads the PACKAGED runtime, not a hosted
    // URL. The DevTools rule is untouched and still keyed on the release flag.
    expect(main).toContain("window.loadURL(RUNTIME_ENTRY)");
    expect(main).toContain("devTools: !resolvedServer.isRelease");
    expect(main).not.toContain("devTools: true");
    expect(main).not.toContain("openDevTools");
  });

  it("still holds the single-instance lock", () => {
    expect(main).toContain("app.requestSingleInstanceLock()");
    expect(main).toContain('app.on("second-instance"');
    expect(main).toContain("focusExistingWindow()");
  });
});

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

describe("every Windows asset is regenerable from the approved master", () => {
  const generator = read(GENERATOR);

  it("is committed, so a re-render is repeatable", () => {
    expect(exists(GENERATOR)).toBe(true);
    expect(generator).toContain("icon.ico");
    expect(generator).toContain("installerHeader.bmp");
    expect(generator).toContain("installerSidebar.bmp");
    expect(generator).toContain("splash-mark.png");
  });

  it("derives from the same Concept D masters as Android, not a new drawing", () => {
    expect(generator).toContain("assets/brand/icon-mark-master.png");
    expect(generator).toContain("assets/brand/wordmark-master.png");
    expect(exists("assets/brand/icon-mark-master.png")).toBe(true);
    expect(exists("assets/brand/concept-d-brand-board.png")).toBe(true);
  });

  it("reaches no network and adds no runtime dependency", () => {
    for (const banned of ["curl", "wget", "npm install", "npx ", "https://"]) {
      expect(`generator: ${banned}`).toBe(`generator: ${banned}`);
      expect(generator).not.toContain(banned);
    }
  });

  it("every asset it claims to write is on disk", () => {
    for (const asset of [ICON, HEADER, SIDEBAR, SPLASH_ART]) {
      expect(`${asset} missing`).toBe(`${asset} missing`);
      expect(exists(asset)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Regression — what 24.3 must not have touched
// ---------------------------------------------------------------------------

describe("Feature 24.3 changes artwork and nothing else", () => {
  it("the published Windows release is untouched", () => {
    // 24.3 prepares the NEXT installer. The v1.0.0 asset already on GitHub is
    // the older pre-branding binary and must keep describing itself accurately.
    expect(CURRENT_WINDOWS_RELEASE).toEqual({
      versionName: "1.1.0",
      downloadUrl:
        "https://github.com/aasishjannuaj/pos-canvas/releases/download/windows-v1.1.0/POS-Canvas-Windows-v1.1.0.exe",
      checksum: "c8f1fa82c2e95bdaa06adc3360275c58b57dd8737b2a98f287990f0193b827fe",
      fileSizeBytes: 100260898,
      releasedAt: "2026-08-31T18:12:54Z",
      isPrerelease: false,
      isUnsigned: true,
    });
  });

  it("the Android release is untouched", () => {
    // Typed nullable because a release may not exist yet; 24.3 must not be the
    // thing that removes one, so the presence is asserted before the values.
    expect(CURRENT_ANDROID_RELEASE).not.toBeNull();
    expect(CURRENT_ANDROID_RELEASE?.versionName).toBe("1.1.0");
    expect(CURRENT_ANDROID_RELEASE?.versionCode).toBe(2);
    expect(CURRENT_ANDROID_RELEASE?.checksum).toBe(
      "00763a36d8ddcba676ec0f0afec477a2784579c0d9968b28eaaea91510af1df1"
    );
  });

  it("no signing configuration appeared", () => {
    // Signing is a launch requirement, not a branding one. An unsigned installer
    // that LOOKS finished is exactly the thing that makes it easy to forget.
    const raw = read(SHELL_PACKAGE);

    for (const banned of [
      "certificateFile",
      "certificateSubjectName",
      "azureSignOptions",
      "signtool",
      "signingHashAlgorithms",
      "publisherName",
      "CSC_LINK",
    ]) {
      expect(`package.json: ${banned}`).toBe(`package.json: ${banned}`);
      expect(raw).not.toContain(banned);
    }
  });

  it("the target is still one x64 NSIS installer", () => {
    const shellPackage = JSON.parse(read(SHELL_PACKAGE));

    expect(shellPackage.build.win.target).toHaveLength(1);
    expect(shellPackage.build.win.target[0].target).toBe("nsis");
    expect(shellPackage.build.win.target[0].arch).toEqual(["x64"]);
    expect(shellPackage.build.win.artifactName).toBe(
      "POS-Canvas-Windows-v${version}.${ext}"
    );
  });

  it("the installer still preserves the paired session", () => {
    const shellPackage = JSON.parse(read(SHELL_PACKAGE));

    expect(shellPackage.build.nsis.deleteAppDataOnUninstall).toBe(false);
    expect(shellPackage.build.nsis.oneClick).toBe(false);
    expect(shellPackage.build.nsis.perMachine).toBe(false);
  });

  it("Android branding was not edited by this feature", () => {
    // The masters are shared; the generated trees are not.
    expect(exists("android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml")).toBe(true);
    expect(read("android/app/src/main/res/values/ic_launcher_background.xml")).toContain(
      "#FBF8F3"
    );
    expect(read("android/app/src/main/res/values/styles.xml")).toContain(
      '<item name="windowSplashScreenBackground">@color/ic_launcher_background</item>'
    );
  });

  it("no offline capability and no publish-progress work began", () => {
    // 24.4/24.5/24.6. The startup splash is NOT offline capability: it carries no
    // cached menu, no prices and no configuration, and it is replaced by the
    // honest failure page when the network is not there.
    expect(exists("lib/offline.ts")).toBe(false);
    // FEATURE 24.6 HAS NOW STARTED, with owner approval, so lib/publishProgress.ts
    // exists deliberately and asserting its absence would only pin this file to a
    // past that has moved on. The boundary it protected is still real, so it is
    // restated rather than dropped: publish progress is an OWNER-EDITOR concern
    // and must not reach into the device, offline or branding surfaces.
    expect(read("lib/publishProgress.ts")).not.toContain("@/lib/device");
    expect(read("lib/publishProgress.ts")).not.toContain("@/lib/saleQueue");
    expect(read("lib/publishProgress.ts")).not.toContain("@/lib/brand");
    expect(read(SPLASH)).not.toContain("cache");
    expect(read(SPLASH)).not.toContain("serviceWorker");
  });
});
