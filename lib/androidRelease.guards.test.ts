// Feature 20 — static guards for the Android release configuration.
//
// Source-level assertions, following this repository's existing guard
// convention. Gradle, the manifest and the Capacitor config cannot be executed
// under Vitest, and the failures they protect against are all silent: an APK
// pointed at localhost installs and launches, a debug-signed release installs,
// a committed keystore breaks nothing until it is exploited. None of these
// produce a test failure anywhere else.
//
// Two properties here are irreversible once a customer installs a signed build
// — the applicationId and the signing identity — which is why they are pinned
// by assertion rather than left to review.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ANDROID_RELEASE_ENV_VAR,
  ANDROID_SERVER_URL_ENV_VAR,
  PRODUCTION_ANDROID_SERVER_URL,
  isAndroidReleaseBuild,
  readAndroidServerUrl,
} from "../android-shell/serverUrl.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf-8");
}

/** Strips // and /* *\/ comments so explanatory prose never trips a guard. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Strips XML comments, for the manifest and network-security config. */
function xml(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, "");
}

const APP_ID = "com.poscanvas.app";
const OLD_APP_ID = "com.poscanvas.dev";

const GRADLE = "android/app/build.gradle";
const MANIFEST = "android/app/src/main/AndroidManifest.xml";
const STRINGS = "android/app/src/main/res/values/strings.xml";
const NETWORK = "android/app/src/main/res/xml/network_security_config.xml";
const NETWORK_DEBUG = "android/app/src/debug/res/xml/network_security_config.xml";
const CAP_CONFIG = "capacitor.config.ts";
const SERVER_URL = "android-shell/serverUrl.mjs";
const MAIN_ACTIVITY = "android/app/src/main/java/com/poscanvas/app/MainActivity.java";

// ---------------------------------------------------------------------------
// Identity — permanent once distributed
// ---------------------------------------------------------------------------

describe("application identity is com.poscanvas.app everywhere", () => {
  it("the Capacitor appId matches", () => {
    expect(code(read(CAP_CONFIG))).toContain(`appId: "${APP_ID}"`);
  });

  it("the Gradle namespace and applicationId match", () => {
    const gradle = code(read(GRADLE));
    expect(gradle).toContain(`namespace = "${APP_ID}"`);
    expect(gradle).toContain(`applicationId "${APP_ID}"`);
  });

  it("MainActivity lives in the matching package", () => {
    // Android treats a different applicationId as a different app, so the
    // declared package and the applicationId must not drift apart.
    expect(existsSync(join(repoRoot, MAIN_ACTIVITY))).toBe(true);
    expect(read(MAIN_ACTIVITY)).toContain(`package ${APP_ID};`);
  });

  it("the string resources match", () => {
    const strings = read(STRINGS);
    expect(strings).toContain(`<string name="package_name">${APP_ID}</string>`);
    expect(strings).toContain(`<string name="custom_url_scheme">${APP_ID}</string>`);
  });

  it("the display name is POS Canvas, with no (Dev) suffix", () => {
    const strings = read(STRINGS);
    expect(strings).toContain('<string name="app_name">POS Canvas</string>');
    expect(strings).toContain('<string name="title_activity_main">POS Canvas</string>');
    expect(strings).not.toContain("(Dev)");
    expect(code(read(CAP_CONFIG))).toContain('appName: "POS Canvas"');
    expect(code(read(CAP_CONFIG))).not.toContain("(Dev)");
  });

  it("no tracked file still references the provisional com.poscanvas.dev", () => {
    // Comment-stripped, per this repository's standing guard convention: the
    // migration comments in MainActivity.java and capacitor.config.ts name the
    // old id precisely to record why the new one is permanent, and that
    // explanation must not be mistaken for a live reference.
    const tracked = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf-8" })
      .split("\n")
      .filter(Boolean);

    const offenders = tracked.filter((file) => {
      const absolute = join(repoRoot, file);
      if (!existsSync(absolute) || statSync(absolute).isDirectory()) return false;
      if (/\.(jar|png|jpg|webp|ico)$/.test(file)) return false;

      // Test files are excluded because a guard asserting the ABSENCE of the
      // old id must necessarily name it. This file itself is the case in
      // point: it began failing the moment it became tracked, on its own
      // OLD_APP_ID constant. The property being protected is that no SHIPPING
      // source references the provisional package.
      if (/\.test\.tsx?$/.test(file)) return false;

      const source = readFileSync(absolute, "utf-8");
      const executable = /\.(xml|html)$/.test(file) ? xml(source) : code(source);

      return executable.includes(OLD_APP_ID);
    });

    expect(offenders).toEqual([]);
  });

  it("the old package directory is gone, not merely unused", () => {
    // A leftover source tree would still compile into the APK.
    expect(existsSync(join(repoRoot, "android/app/src/main/java/com/poscanvas/dev"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

describe("versioning", () => {
  const gradle = code(read(GRADLE));

  it("versionCode is a positive integer", () => {
    const match = gradle.match(/versionCode\s+(\d+)/);
    expect(match).not.toBeNull();

    const versionCode = Number(match?.[1]);
    expect(Number.isInteger(versionCode)).toBe(true);
    expect(versionCode).toBeGreaterThan(0);
  });

  it("versionName is semver-like x.y.z", () => {
    const match = gradle.match(/versionName\s+"([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match?.[1]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("the canonical version lives in build.gradle, not package.json", () => {
    // The web app deploys continuously while the APK ships rarely; deriving one
    // from the other would force meaningless version churn.
    const pkg = JSON.parse(read("package.json")) as Record<string, unknown>;
    expect(gradle).toMatch(/versionCode\s+\d+/);
    expect(JSON.stringify(pkg.scripts)).not.toContain("versionCode");
  });
});

// ---------------------------------------------------------------------------
// Release URL
// ---------------------------------------------------------------------------

describe("the release URL is pinned in tracked code", () => {
  it("the production constant is exactly the production device runtime", () => {
    expect(PRODUCTION_ANDROID_SERVER_URL).toBe("https://pos-canvas.vercel.app/device");
  });

  it("release mode IGNORES the development override entirely", () => {
    // The exact hazard this exists to close: sync for the emulator, then
    // assemble a release, and ship an APK pointed at localhost.
    const resolved = readAndroidServerUrl({
      [ANDROID_RELEASE_ENV_VAR]: "1",
      [ANDROID_SERVER_URL_ENV_VAR]: "http://10.0.2.2:3000",
    });

    expect(resolved.url).toBe(PRODUCTION_ANDROID_SERVER_URL);
    expect(resolved.isRelease).toBe(true);
    expect(resolved.isCleartext).toBe(false);
  });

  it("no release resolution can produce localhost, 10.0.2.2 or 127.0.0.1", () => {
    for (const contaminant of [
      "http://localhost:3000",
      "http://10.0.2.2:3000",
      "http://127.0.0.1:3000",
      "https://staging.example.com/device",
      "https://evil.example/device",
    ]) {
      const resolved = readAndroidServerUrl({
        [ANDROID_RELEASE_ENV_VAR]: "1",
        [ANDROID_SERVER_URL_ENV_VAR]: contaminant,
      });

      expect(resolved.url).toBe(PRODUCTION_ANDROID_SERVER_URL);
    }
  });

  it("the release URL is https and targets /device, not the site root", () => {
    const parsed = new URL(PRODUCTION_ANDROID_SERVER_URL);
    expect(parsed.protocol).toBe("https:");
    expect(parsed.hostname).toBe("pos-canvas.vercel.app");
    // The site root is the OWNER app; a till must never load it.
    expect(parsed.pathname).toBe("/device");
  });

  it("release detection is an explicit flag, never NODE_ENV", () => {
    // `cap sync` is a CLI invocation, not a bundler build: NODE_ENV is often
    // unset or inherited from an unrelated context.
    expect(code(read(SERVER_URL))).not.toContain("NODE_ENV");
    expect(isAndroidReleaseBuild({ [ANDROID_RELEASE_ENV_VAR]: "1" })).toBe(true);
    for (const value of ["", "0", "false", "true", undefined]) {
      expect(isAndroidReleaseBuild({ [ANDROID_RELEASE_ENV_VAR]: value })).toBe(false);
    }
  });

  it("development behaviour is preserved", () => {
    const resolved = readAndroidServerUrl({
      [ANDROID_SERVER_URL_ENV_VAR]: "http://10.0.2.2:3000",
    });

    expect(resolved.url).toBe("http://10.0.2.2:3000");
    expect(resolved.isCleartext).toBe(true);
    expect(resolved.isRelease).toBe(false);
  });

  it("a missing development URL still fails loudly", () => {
    expect(() => readAndroidServerUrl({})).toThrow(ANDROID_SERVER_URL_ENV_VAR);
  });

  it("the release sync builds the runtime that ships in the APK", () => {
    // SUPERSEDED BY 24.5G. This used to assert that the release sync sets
    // POS_CANVAS_ANDROID_RELEASE, a flag whose only job was to pin the REMOTE
    // server URL for a release build. There is no remote server URL any more —
    // the app carries its own runtime — so the flag has nothing left to pin.
    //
    // What must be true now is stronger: the sync that produces a release APK
    // BUILDS the device runtime first, so an APK can never be assembled around
    // a stale or missing bundle.
    const manifest = JSON.parse(read("package.json"));

    expect(manifest.scripts["android:runtime"]).toContain("native-device/vite.config.mts");
    expect(manifest.scripts["android:sync"]).toContain("android:runtime");
    expect(manifest.scripts["android:sync"]).toContain("cap sync android");
    expect(manifest.scripts["android:release:sync"]).toContain("android:sync");
  });
});

describe("WebView debugging is off for release", () => {
  it("is off unconditionally", () => {
    // NARROWED BY 24.5G. It was previously tied to the release flag derived
    // from the server URL; with no server URL there is no flag. Off in every
    // build is strictly safer than off in release builds, and a till now
    // carries both its whole runtime and a live paired session.
    const config = read("capacitor.config.ts");

    expect(config).toContain("webContentsDebuggingEnabled: false");
    expect(config).not.toContain("webContentsDebuggingEnabled: true");
    expect(config).not.toMatch(/webContentsDebuggingEnabled:\s*!/);
  });
});

// ---------------------------------------------------------------------------
// Release build configuration
// ---------------------------------------------------------------------------

describe("the release buildType", () => {
  const gradle = code(read(GRADLE));
  const releaseBlock = gradle.slice(
    gradle.indexOf("release {", gradle.indexOf("buildTypes"))
  );

  it("is not debuggable", () => {
    expect(releaseBlock).toContain("debuggable false");
  });

  it("keeps minification and resource shrinking off", () => {
    // R8 on a Capacitor WebView shell risks stripping reflectively-reached
    // bridge classes for no meaningful size win.
    expect(releaseBlock).toContain("minifyEnabled false");
    expect(releaseBlock).toContain("shrinkResources false");
  });

  it("keeps the default ProGuard files unchanged", () => {
    expect(releaseBlock).toContain("getDefaultProguardFile('proguard-android.txt')");
    expect(releaseBlock).toContain("'proguard-rules.pro'");
  });

  it("wires the release signing config", () => {
    expect(releaseBlock).toContain("signingConfig signingConfigs.release");
  });

  it("never falls back to the debug signing key", () => {
    // AGP's historical default signed release with the debug keystore — a key
    // every Android developer already has. Shipping that is worse than nothing.
    expect(gradle).not.toMatch(/signingConfig\s+signingConfigs\.debug/);
  });
});

describe("signing configuration is conditional and credential-free", () => {
  const gradle = code(read(GRADLE));

  it("loads from the untracked local properties file", () => {
    expect(gradle).toContain('rootProject.file("keystore.properties")');
    expect(gradle).toContain("keystorePropertiesFile.exists()");
  });

  it("reads every value from that file, never from a literal", () => {
    for (const key of ["storeFile", "storePassword", "keyAlias", "keyPassword"]) {
      expect(gradle).toContain(`keystoreProperties['${key}']`);
    }
  });

  it("a missing keystore file does not break non-release builds", () => {
    // A fresh clone, CI, and any machine without signing material must still
    // run assembleDebug and the test tasks.
    expect(gradle).toContain("def hasReleaseSigning = keystorePropertiesFile.exists()");
    expect(gradle).toContain("if (hasReleaseSigning) {");
  });

  it("a release build WITHOUT signing material fails explicitly", () => {
    // packageRelease is matched too: it runs first and would otherwise write
    // app-release-unsigned.apk before the guard fired.
    expect(gradle).toMatch(/\^\(assemble\|bundle\|package\)Release/);
    expect(gradle).toContain("Release signing is not configured.");
  });

  it("contains no literal credential, alias or keystore path", () => {
    const allGradle = [
      read(GRADLE),
      read("android/build.gradle"),
      read("android/gradle.properties"),
      read("android/variables.gradle"),
    ].join("\n");

    // An assignment of a literal value to any signing property.
    expect(allGradle).not.toMatch(/storePassword\s*[=\s]\s*["'][^"']+["']/);
    expect(allGradle).not.toMatch(/keyPassword\s*[=\s]\s*["'][^"']+["']/);
    expect(allGradle).not.toMatch(/keyAlias\s*[=\s]\s*["'][^"']+["']/);
    expect(allGradle).not.toMatch(/storeFile\s+file\(\s*["'][^"']+["']\s*\)/);
    // No absolute developer path anywhere.
    expect(allGradle).not.toMatch(/\/Users\/[^\s"']+\.(jks|keystore)/);
    expect(allGradle).not.toMatch(/\.(jks|keystore)["']/);
  });

  it("gradle.properties carries no signing values", () => {
    const properties = read("android/gradle.properties");
    for (const key of ["storeFile", "storePassword", "keyAlias", "keyPassword", "RELEASE_"]) {
      expect(properties).not.toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// Git safety
// ---------------------------------------------------------------------------

describe("signing material can never be committed", () => {
  /** git check-ignore against a path that need not exist. */
  function isIgnored(path: string): boolean {
    try {
      execFileSync("git", ["check-ignore", "--no-index", "-q", path], { cwd: repoRoot });
      return true;
    } catch {
      return false;
    }
  }

  const MUST_BE_IGNORED = [
    "android/release.jks",
    "android/app/release.keystore",
    "android/keystore.properties",
    "keystore.properties",
    "pos-canvas-release.jks",
    "upload.keystore",
    "signing.p12",
    "android/upload.pepk",
  ];

  for (const path of MUST_BE_IGNORED) {
    it(`${path} is gitignored`, () => {
      expect(isIgnored(path)).toBe(true);
    });
  }

  it("no keystore or signing properties file is tracked", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf-8" });
    expect(tracked).not.toMatch(/\.(jks|keystore|p12|pepk)$/m);
    expect(tracked).not.toMatch(/(^|\/)keystore\.properties$/m);
  });

  it("any signing material present locally is ignored and untracked", () => {
    // This assertion originally read "no signing material exists yet", which
    // was correct only while Feature 20 deliberately stopped short of keystore
    // creation. Once the real keystore was created that premise expired, and
    // the guard fired — correctly — on the operator's own android/
    // keystore.properties.
    //
    // The property that ENDURES is the one asserted here: signing material may
    // exist on a developer's machine, but every instance of it must be
    // gitignored, and none of it may ever be tracked. That stays true for the
    // life of the project rather than for one phase of one feature.
    const found = execFileSync(
      "bash",
      [
        "-c",
        `find . -path ./node_modules -prune -o \\( -name '*.jks' -o -name '*.keystore' -o -name '*.p12' -o -name 'keystore.properties' \\) -print 2>/dev/null || true`,
      ],
      { cwd: repoRoot, encoding: "utf-8" }
    )
      .split("\n")
      .map((line) => line.replace(/^\.\//, "").trim())
      .filter(Boolean);

    const unprotected = found.filter((path) => !isIgnored(path));

    expect(unprotected).toEqual([]);
  });

  it("the real keystore itself lives OUTSIDE the repository", () => {
    // keystore.properties may sit in android/ (it is gitignored). The .jks it
    // points at must not be inside the repo at all — a second line of defence
    // beyond the ignore rules, since a file that is not here cannot be
    // committed by any mistake, including a forced add.
    const keystores = execFileSync(
      "bash",
      [
        "-c",
        `find . -path ./node_modules -prune -o \\( -name '*.jks' -o -name '*.keystore' \\) -print 2>/dev/null || true`,
      ],
      { cwd: repoRoot, encoding: "utf-8" }
    ).trim();

    expect(keystores).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe("the manifest", () => {
  const manifest = xml(read(MANIFEST));

  it("disables backup", () => {
    // A paired till's session lives in WebView localStorage inside the app's
    // private data dir; backup could restore it onto different hardware.
    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).not.toContain('android:allowBackup="true"');
  });

  it("requests INTERNET and nothing else", () => {
    const permissions = [...manifest.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g)]
      .map((match) => match[1]);

    expect(permissions).toEqual(["android.permission.INTERNET"]);
  });

  it("declares no cleartext escape hatch", () => {
    expect(manifest).not.toContain("usesCleartextTraffic");
  });

  it("still points at the hand-written network security config", () => {
    expect(manifest).toContain('android:networkSecurityConfig="@xml/network_security_config"');
  });
});

describe("network security", () => {
  // Feature 20 — TWO files. src/main is what a release packages; src/debug
  // overrides it for the debug build type only, so its cleartext exceptions are
  // physically absent from a release APK.
  //
  // (The first attempt used a single file with a <debug-overrides> block.
  // Android's lint rejects that — <debug-overrides> accepts only
  // <trust-anchors> — and lintVitalRelease failed the build. The build-type
  // resource override is the supported mechanism.)
  const releaseConfig = xml(read(NETWORK));
  const debugConfig = xml(read(NETWORK_DEBUG));

  it("the release config denies cleartext and grants NO exception", () => {
    // The property that actually matters for a customer's till, and the reason
    // two files are acceptable: drift can only be dangerous in this direction.
    expect(releaseConfig).toContain('<base-config cleartextTrafficPermitted="false" />');
    expect(releaseConfig).not.toContain('cleartextTrafficPermitted="true"');
    expect(releaseConfig).not.toContain("<domain");
    expect(releaseConfig).not.toContain("10.0.2.2");
    expect(releaseConfig).not.toContain("localhost");
  });

  it("the debug config still permits the emulator and adb-reverse hosts", () => {
    expect(debugConfig).toContain('<base-config cleartextTrafficPermitted="false" />');
    expect(debugConfig).toContain("10.0.2.2");
    expect(debugConfig).toContain("localhost");
  });

  it("the debug override lives under src/debug, not src/main", () => {
    expect(NETWORK_DEBUG).toContain("/src/debug/");
    expect(existsSync(join(repoRoot, NETWORK_DEBUG))).toBe(true);
  });

  it("no <debug-overrides> block remains — Android lint rejects nesting there", () => {
    expect(releaseConfig).not.toContain("<debug-overrides>");
    expect(debugConfig).not.toContain("<debug-overrides>");
  });

  it("no cleartext origin can reach the runtime, because there is no remote origin", () => {
    // SUPERSEDED BY 24.5G. The old check guarded a sync-time validation in
    // android-shell/generateWww.mjs, which existed to stop a release pointing
    // at an http:// dev server. That file is gone: the runtime is bundled, so
    // there is no configurable origin to get wrong and no cleartext exposure to
    // validate. The release config's HTTPS-only posture is unchanged.
    expect(existsSync(join(repoRoot, "android-shell/generateWww.mjs"))).toBe(false);

    const config = read("capacitor.config.ts");

    expect(config).not.toContain("cleartext");
    expect(config).not.toContain("server:");

    // The main (release) network-security config stays HTTPS-only.
    const mainConfig = read("android/app/src/main/res/xml/network_security_config.xml");

    expect(mainConfig).not.toContain("cleartextTrafficPermitted=\"true\"");
  });
});

// ---------------------------------------------------------------------------
// Release metadata contract
// ---------------------------------------------------------------------------

describe("the release metadata contract", () => {
  const source = code(read("lib/androidRelease.ts"));

  it("is not coupled to build_jobs", () => {
    // build_jobs models PER-PROJECT config generation; the APK is universal.
    for (const banned of ["build_jobs", "buildJobs", "GeneratedPosConfig", "projectId"]) {
      expect(source).not.toContain(banned);
    }
  });

  it("keeps the nullable contract, so 'no release' stays representable", () => {
    // Feature 20 asserted this constant WAS null, which was correct only while
    // no signed APK existed. Feature 21 published v1.0.0 and that premise
    // expired. What endures is the TYPE: consumers must always handle null, so
    // a future gap between releases renders an honest unavailable state rather
    // than a broken or fabricated link.
    expect(source).toContain("CURRENT_ANDROID_RELEASE: AndroidRelease | null");
  });

  it("declares a release only with VERIFIED values, never fabricated ones", () => {
    // The anti-fabrication property moved rather than disappeared. Every field
    // is now pinned to a value checked against the published artifact — the
    // GitHub API for the URL, size and timestamp; a local sha-256 of the
    // downloaded bytes for the checksum — and lib/androidRelease.test.ts
    // asserts each one exactly. A drive-by edit to any of them fails there.
    const behavioural = read("lib/androidRelease.test.ts");

    expect(behavioural).toContain("carries the approved checksum, byte for byte");
    expect(behavioural).toContain("records the real published file size");
    expect(behavioural).toContain("records the real GitHub publish timestamp");
    expect(behavioural).toContain("targets the VERIFIED tag");
  });

  it("any declared download URL is https and points at GitHub Releases", () => {
    const urls = [...source.matchAll(/downloadUrl:\s*\n?\s*"([^"]+)"/g)].map((m) => m[1]);

    for (const url of urls) {
      const parsed = new URL(url);
      expect(parsed.protocol).toBe("https:");
      expect(parsed.hostname).toBe("github.com");
      expect(parsed.pathname).toContain("/releases/download/");
      expect(parsed.pathname.endsWith(".apk")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Regression — earlier features must be untouched
// ---------------------------------------------------------------------------

describe("earlier device/checkout/branding paths are unchanged", () => {
  it("the device route is still /device", () => {
    expect(existsSync(join(repoRoot, "app/device/page.tsx"))).toBe(true);
    expect(PRODUCTION_ANDROID_SERVER_URL.endsWith("/device")).toBe(true);
  });

  it("Feature 16 pairing transport is untouched", () => {
    const rpc = code(read("lib/device.rpc.ts"));
    expect(rpc).toContain("redeemDevicePairingCode");
    expect(rpc).toContain("get_device_config");
  });

  it("Feature 18.2 v3 checkout is untouched", () => {
    expect(code(read("lib/device.rpc.ts"))).toContain('rpc("complete_sale_v3"');
    expect(code(read("components/device/DeviceApp.tsx"))).toContain("completeDeviceSaleV3");
  });

  it("Feature 19 logo rendering is untouched", () => {
    expect(code(read("components/runtime/PosHeader.tsx"))).toContain("createLogoPublicUrl");
    expect(code(read("components/device/DeviceApp.tsx"))).toContain("logoBaseUrl");
  });

  it("no Android change reached the web application code", () => {
    // Feature 20 is release engineering. Nothing in lib/ or components/ should
    // know about the APK beyond the release metadata contract.
    function walk(dir: string): string[] {
      return readdirSync(join(repoRoot, dir)).flatMap((entry) => {
        const relative = join(dir, entry);
        if (statSync(join(repoRoot, relative)).isDirectory()) return walk(relative);
        return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [relative] : [];
      });
    }

    const webSources = ["lib", "components", "app"].flatMap(walk);

    // Feature 24.1 — lib/brand.ts joined the allow-list, deliberately. The
    // application id is the platform's IDENTITY, shared by both shells, and
    // centralising it is precisely what that module exists for: the Android and
    // Windows configs are now checked against one declaration instead of being
    // trusted to agree. That is a different category from APK release
    // engineering, which is what this guard was written to keep out and still
    // does — the list is two files, not "anywhere".
    const permitted = ["lib/androidRelease.ts", "lib/brand.ts"];

    const offenders = webSources.filter(
      (file) => !permitted.includes(file) && code(read(file)).includes("poscanvas.app")
    );

    expect(offenders).toEqual([]);
  });
});
