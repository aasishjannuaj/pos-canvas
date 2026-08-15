// Feature 23.4 — the Windows installer and the workflow that builds it.
//
// THE ONE THAT MATTERS MOST: an installed customer app must resolve production
// WITHOUT anyone setting an environment variable. On a customer's machine the
// variable is absent — that is the normal state, not an edge case — so a build
// whose release-ness depended on it would quietly load a development URL on
// every till. `app.isPackaged` decides instead, and no environment value can
// push a packaged app back into development. That property is executed here,
// not merely read, because it is the difference between a working till and one
// that shows an offline screen forever with no way to re-point it.
//
// THE SECOND: identity is permanent. appId and productName determine the
// Windows uninstall registry entry and the %APPDATA% directory that holds the
// paired session. Changing either after customers install means a second app
// beside the first and every till unpaired. They are pinned by assertion.
//
// WHAT THIS PHASE DELIBERATELY DOES NOT DO: no signing, no GitHub Release, no
// release metadata, no change to Windows's "Coming Soon" status anywhere in the
// product. The installer is an unsigned engineering artifact until Feature 23.5
// has validated it on real Windows and Feature 23.6 signs and publishes it.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
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
    .replace(/^#.*$/gm, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const SHELL_PACKAGE = "windows-shell/package.json";
const MAIN = "windows-shell/main.mjs";
const WORKFLOW = ".github/workflows/windows-app.yml";

type ShellPackage = {
  name: string;
  productName: string;
  version: string;
  main: string;
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
  build: {
    appId: string;
    productName: string;
    directories: { output: string };
    files: string[];
    win: { target: { target: string; arch: string[] }[]; artifactName: string };
    nsis: Record<string, unknown>;
  };
};

const shellPackage = JSON.parse(read(SHELL_PACKAGE)) as ShellPackage;
const workflow = read(WORKFLOW);

// ---------------------------------------------------------------------------
// Packaged release mode — the hard requirement
// ---------------------------------------------------------------------------

describe("a packaged app is a release build, structurally", () => {
  it("is a release with no environment at all", () => {
    // The customer's machine: no POS_CANVAS_* variables anywhere.
    expect(isDesktopReleaseBuild({}, { isPackaged: true })).toBe(true);
    expect(readDesktopServerUrl({}, { isPackaged: true }).url).toBe(
      PRODUCTION_DESKTOP_SERVER_URL
    );
  });

  it("cannot be pushed back into development by any environment value", () => {
    // Absent, empty, "0", "false", or hostile — a packaged build ignores all of
    // it. This is the failure mode that would ship a till pointed at localhost.
    for (const flag of [undefined, "", "0", "false", "no", "development"]) {
      const env: Record<string, string | undefined> = {
        POS_CANVAS_DESKTOP_RELEASE: flag,
        POS_CANVAS_DESKTOP_SERVER_URL: "http://localhost:3000/device",
      };

      expect(`flag ${JSON.stringify(flag)}`).toBe(`flag ${JSON.stringify(flag)}`);
      expect(isDesktopReleaseBuild(env, { isPackaged: true })).toBe(true);
      expect(readDesktopServerUrl(env, { isPackaged: true }).url).toBe(
        PRODUCTION_DESKTOP_SERVER_URL
      );
    }
  });

  it("ignores a hostile server override when packaged", () => {
    for (const hostile of [
      "http://evil.example/device",
      "https://pos-canvas.vercel.app.evil.example/device",
      "https://user:pass@pos-canvas.vercel.app/device",
      "file:///tmp/device",
      "not a url",
    ]) {
      const resolved = readDesktopServerUrl(
        { POS_CANVAS_DESKTOP_SERVER_URL: hostile },
        { isPackaged: true }
      );

      expect(`hostile ${hostile}`).toBe(`hostile ${hostile}`);
      expect(resolved.url).toBe(PRODUCTION_DESKTOP_SERVER_URL);
      expect(resolved.isRelease).toBe(true);
    }
  });

  it("still lets an UNPACKAGED checkout run in development", () => {
    // `npm start` on a Mac must keep working against localhost.
    const resolved = readDesktopServerUrl(
      { POS_CANVAS_DESKTOP_SERVER_URL: "http://localhost:3000/device" },
      { isPackaged: false }
    );

    expect(resolved.url).toBe("http://localhost:3000/device");
    expect(resolved.isRelease).toBe(false);
  });

  it("still honours the env flag for npm run start:production", () => {
    expect(
      readDesktopServerUrl(
        { POS_CANVAS_DESKTOP_RELEASE: "1" },
        { isPackaged: false }
      ).url
    ).toBe(PRODUCTION_DESKTOP_SERVER_URL);
  });

  it("treats a missing options object as unpackaged, not packaged", () => {
    // Fails safe in the direction that cannot ship a bad till: an unpackaged
    // default can only ever affect a developer's own checkout.
    expect(isDesktopReleaseBuild({})).toBe(false);
    expect(isDesktopReleaseBuild({}, {})).toBe(false);
  });

  it("only the literal boolean true counts as packaged", () => {
    for (const value of [1, "true", "yes", {}, [], null, undefined]) {
      expect(
        isDesktopReleaseBuild({}, { isPackaged: value as unknown as boolean })
      ).toBe(false);
    }
  });

  it("the main process supplies app.isPackaged", () => {
    const main = code(read(MAIN));
    expect(main).toContain("readDesktopServerUrl(process.env, {");
    expect(main).toContain("isPackaged: app.isPackaged,");
  });

  it("the release URL contract itself is unchanged", () => {
    // https, exact host, /device, no credentials — all still enforced.
    const parsed = new URL(PRODUCTION_DESKTOP_SERVER_URL);

    expect(parsed.protocol).toBe("https:");
    expect(parsed.hostname).toBe("pos-canvas.vercel.app");
    expect(parsed.pathname.startsWith("/device")).toBe(true);
    expect(parsed.username).toBe("");

    const source = code(read("windows-shell/serverUrl.mjs"));
    expect(source).toContain('parsed.protocol !== "https:"');
    expect(source).toContain("parsed.hostname !== PRODUCTION_HOST");
    expect(source).toContain("parsed.pathname.startsWith(DEVICE_PATH_PREFIX)");
    expect(source).toContain("assertNoUserInfo(parsed, label)");
  });
});

// ---------------------------------------------------------------------------
// Application identity — permanent after first release
// ---------------------------------------------------------------------------

describe("the packaged identity matches the locked design", () => {
  it("appId is com.poscanvas.app", () => {
    expect(shellPackage.build.appId).toBe("com.poscanvas.app");
  });

  it("productName is POS Canvas, in both places", () => {
    // electron-builder reads build.productName; app.setName in main.mjs must
    // agree, because %APPDATA%\<name> is derived from it and holds the session.
    expect(shellPackage.build.productName).toBe("POS Canvas");
    expect(shellPackage.productName).toBe("POS Canvas");
    expect(code(read(MAIN))).toContain('app.setName("POS Canvas")');
  });

  it("version is 1.0.0", () => {
    expect(shellPackage.version).toBe("1.0.0");
  });

  it("Electron and electron-builder are pinned exactly", () => {
    expect(shellPackage.devDependencies.electron).toBe("43.4.0");
    expect(shellPackage.devDependencies["electron-builder"]).toBe("26.15.3");

    for (const version of Object.values(shellPackage.devDependencies)) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(version).not.toMatch(/[\^~*x]|latest|>|</);
    }
  });

  it("the lockfile resolves those same versions", () => {
    const lock = JSON.parse(read("windows-shell/package-lock.json")) as {
      packages: Record<string, { version?: string }>;
    };

    expect(lock.packages["node_modules/electron"]?.version).toBe("43.4.0");
    expect(lock.packages["node_modules/electron-builder"]?.version).toBe("26.15.3");
  });
});

// ---------------------------------------------------------------------------
// Target and installer
// ---------------------------------------------------------------------------

describe("the Windows target is x64 NSIS and nothing else", () => {
  it("builds exactly one target", () => {
    expect(shellPackage.build.win.target).toHaveLength(1);
    expect(shellPackage.build.win.target[0].target).toBe("nsis");
  });

  it("builds x64 only", () => {
    expect(shellPackage.build.win.target[0].arch).toEqual(["x64"]);
  });

  it("builds no MSI, portable, or ARM64 artifact", () => {
    const raw = read(SHELL_PACKAGE);

    for (const banned of ["msi", "portable", "arm64", "ia32", "squirrel", "appx"]) {
      expect(`package.json: ${raw}`).not.toContain(banned);
    }
  });

  it("produces the predictable installer filename", () => {
    expect(shellPackage.build.win.artifactName).toBe(
      "POS-Canvas-Windows-v${version}.${ext}"
    );

    // The name the workflow and the future release metadata both expect.
    const resolved = shellPackage.build.win.artifactName
      .replace("${version}", shellPackage.version)
      .replace("${ext}", "exe");

    expect(resolved).toBe("POS-Canvas-Windows-v1.0.0.exe");
  });

  it("outputs to a predictable directory", () => {
    expect(shellPackage.build.directories.output).toBe("dist");
  });

  it("never publishes from the npm script", () => {
    expect(shellPackage.scripts["build:windows"]).toBe(
      "electron-builder --win --x64 --publish never"
    );
    expect(shellPackage.scripts["build:windows"]).toContain("--publish never");
  });
});

describe("the NSIS installer is assisted, per-user, and keeps user data", () => {
  const nsis = shellPackage.build.nsis;

  it("is an assisted installer, not one-click", () => {
    expect(nsis.oneClick).toBe(false);
  });

  it("installs per user and needs no administrator", () => {
    expect(nsis.perMachine).toBe(false);
    expect(nsis.allowElevation).toBe(false);
  });

  it("NEVER deletes application data on uninstall", () => {
    // The single most load-bearing installer setting. %APPDATA%\POS Canvas holds
    // the localStorage entry carrying the paired device session; deleting it on
    // upgrade would unpair every till. Feature 23.5 must still prove the upgrade
    // path empirically — this asserts the intent, not the outcome.
    expect(nsis.deleteAppDataOnUninstall).toBe(false);
  });

  it("creates the expected shortcuts", () => {
    expect(nsis.createStartMenuShortcut).toBe(true);
    expect(nsis.createDesktopShortcut).toBe(true);
    expect(nsis.shortcutName).toBe("POS Canvas");
  });
});

// ---------------------------------------------------------------------------
// The universal-app invariant, at packaging time
// ---------------------------------------------------------------------------

describe("the packaged binary is universal", () => {
  it("packages only the shell's own files", () => {
    // An explicit allow-list. Nothing from the web app, no configuration, no
    // asset that could vary per customer.
    expect(shellPackage.build.files.sort()).toEqual([
      "main.mjs",
      "navigationPolicy.mjs",
      "offline.html",
      "package.json",
      "preload.js",
      "serverUrl.mjs",
    ]);
  });

  it("carries no project, customer, or build identity", () => {
    const raw = read(SHELL_PACKAGE);

    for (const banned of [
      "projectId",
      "project_id",
      "buildJobId",
      "build_jobs",
      "build_artifacts",
      "GeneratedPosConfig",
      "config_snapshot",
      "customerId",
      "businessName",
      "ownerId",
    ]) {
      expect(`package.json: ${raw}`).not.toContain(banned);
    }
  });

  it("does not reuse the unrelated BuildTarget desktop concept", () => {
    // build_jobs.target models per-project configuration publishing. Nothing in
    // the Windows binary may touch it.
    const raw = read(SHELL_PACKAGE);
    expect(raw).not.toContain("BuildTarget");
    expect(code(read(WORKFLOW))).not.toContain("build_jobs");
    expect(code(read(WORKFLOW))).not.toContain("--target android");
  });

  it("the workflow takes no per-customer input", () => {
    // workflow_dispatch with no `inputs:` block — there is nothing to vary.
    expect(code(workflow)).toContain("workflow_dispatch:");
    expect(code(workflow)).not.toContain("inputs:");
  });

  it("the only hosted runtime is the pinned production origin", () => {
    expect(PRODUCTION_DESKTOP_SERVER_URL).toBe("https://pos-canvas.vercel.app/device");
  });
});

// ---------------------------------------------------------------------------
// The workflow
// ---------------------------------------------------------------------------

describe("the Windows build workflow", () => {
  it("exists at the expected path", () => {
    expect(existsSync(join(repoRoot, WORKFLOW))).toBe(true);
  });

  it("runs on windows-latest", () => {
    expect(workflow).toContain("runs-on: windows-latest");
    expect(workflow).not.toContain("runs-on: ubuntu");
    expect(workflow).not.toContain("runs-on: macos");
  });

  it("is manual only — no tag or push trigger yet", () => {
    expect(code(workflow)).toContain("workflow_dispatch:");
    expect(code(workflow)).not.toContain("push:");
    expect(code(workflow)).not.toContain("tags:");
    expect(code(workflow)).not.toContain("schedule:");
    expect(code(workflow)).not.toContain("pull_request");
  });

  it("uses Node 24 and caches the shell lockfile", () => {
    expect(workflow).toContain('node-version: "24"');
    expect(workflow).toContain("cache-dependency-path: windows-shell/package-lock.json");
  });

  it("installs with npm ci inside windows-shell", () => {
    expect(workflow).toContain("working-directory: windows-shell");
    expect(workflow).toContain("run: npm ci");
  });

  it("checks out without persisting credentials", () => {
    expect(workflow).toContain("persist-credentials: false");
  });

  it("proves the Electron binary exists before building", () => {
    // npm ci has been observed to defer Electron's postinstall download; a
    // build that silently packages nothing must fail loudly instead.
    expect(workflow).toContain("Verify the Electron binary is present");
    expect(workflow).toContain("Electron binary missing");
  });

  it("builds through the shell's own script", () => {
    expect(workflow).toContain("run: npm run build:windows");
  });

  it("verifies the exact filename and a plausible size", () => {
    expect(workflow).toContain("POS-Canvas-Windows-v$version.exe");
    expect(workflow).toContain("Test-Path $path");
    expect(workflow).toContain("40MB");
    expect(workflow).toContain("exit 1");
  });

  it("generates a SHA-256 checksum file", () => {
    expect(workflow).toContain("Get-FileHash $path -Algorithm SHA256");
    expect(workflow).toContain(".sha256");
  });

  it("uploads both the installer and the checksum", () => {
    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(workflow).toContain("windows-shell/dist/POS-Canvas-Windows-v*.exe");
    expect(workflow).toContain("windows-shell/dist/POS-Canvas-Windows-v*.exe.sha256");
    expect(workflow).toContain("if-no-files-found: error");
  });

  it("uses least-privilege permissions", () => {
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(code(workflow)).not.toContain("contents: write");
    expect(code(workflow)).not.toContain("id-token:");
    expect(code(workflow)).not.toContain("packages: write");
  });

  it("creates no GitHub Release", () => {
    for (const banned of [
      "softprops/action-gh-release",
      "actions/create-release",
      "gh release create",
      "--publish always",
      "--publish onTag",
      "GITHUB_TOKEN",
    ]) {
      expect(`workflow: ${code(workflow)}`).not.toContain(banned);
    }
  });

  it("references no secret at all", () => {
    // The shell is a static wrapper with no credentials. A build that needs no
    // secret cannot leak one.
    expect(code(workflow)).not.toContain("secrets.");
    expect(code(workflow)).not.toContain("${{ secrets");
  });
});

// ---------------------------------------------------------------------------
// No signing, no release, no discoverability change
// ---------------------------------------------------------------------------

describe("Feature 23.4 stops where it was scoped to stop", () => {
  it("configures no code signing anywhere", () => {
    for (const file of [SHELL_PACKAGE, WORKFLOW]) {
      const source = read(file);

      for (const banned of [
        "certificateFile",
        "certificatePassword",
        "certificateSubjectName",
        "certificateSha1",
        "signingHashAlgorithms",
        "signtool",
        "azureSignOptions",
        "CSC_LINK",
        "CSC_KEY_PASSWORD",
        "WINDOWS_SIGN",
        ".pfx",
      ]) {
        expect(`${file}: ${source}`).not.toContain(banned);
      }
    }
  });

  it("adds no Windows release metadata", () => {
    expect(existsSync(join(repoRoot, "lib/windowsRelease.ts"))).toBe(false);
    expect(code(read("lib/platformDownloads.ts"))).not.toContain("windowsRelease");
  });

  it("leaves Windows as Coming Soon in the product", () => {
    const model = code(read("lib/platformDownloads.ts"));

    expect(model).toContain("export const WINDOWS_DOWNLOAD: ComingSoonPlatformDownload");
    expect(model).toContain('status: "coming_soon"');
    expect(model).not.toContain("getWindowsDownload");
    // No installer URL has been published, so none may appear anywhere.
    expect(model).not.toContain(".exe");
  });

  it("no customer-facing surface mentions a Windows download", () => {
    for (const file of [
      "components/platform/PlatformDownloadRow.tsx",
      "components/dashboard/AndroidAppCard.tsx",
      "components/landing/PlatformAvailability.tsx",
    ]) {
      const source = code(read(file));
      expect(`${file}: ${source}`).not.toContain(".exe");
      expect(`${file}: ${source}`).not.toContain("POS-Canvas-Windows");
    }
  });

  it("commits no build output", () => {
    expect(read(".gitignore")).toContain("/windows-shell/node_modules");
    // dist/ is produced by every build and must never be tracked.
    expect(read(".gitignore")).toContain("/windows-shell/dist");
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
      expect(name).not.toMatch(/^app-builder/);
    }
  });

  it("leaves the Android build pipeline untouched", () => {
    // Two independent binaries with independent cadences.
    expect(code(read("android-shell/serverUrl.mjs"))).toContain(
      'export const PRODUCTION_ANDROID_SERVER_URL = "https://pos-canvas.vercel.app/device"'
    );
    expect(code(read(WORKFLOW))).not.toContain("android");
    expect(code(read(WORKFLOW))).not.toContain("gradle");
  });
});
