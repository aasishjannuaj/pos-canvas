// Feature 24.2 — the Android brand assets.
//
// WHY THESE ARE STRUCTURAL, NOT VISUAL: nothing in this repository can look at a
// PNG and judge whether it is the approved mark. What it CAN do is assert the
// things that silently break a launcher icon — a missing density, a wrong
// canvas size, artwork that is really still the toolchain default, an adaptive
// foreground with no transparent margin (which circular masks clip), or a
// monochrome layer declared in XML but absent on disk. Every one of those ships
// an app that looks broken on someone's home screen and fails no other test.
//
// THE SEPARATION THIS ALSO PROTECTS: these are POS CANVAS's marks. A customer's
// own logo lives in their project configuration and belongs only inside their
// till. Neither may become the other.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BRAND } from "@/lib/brand";
import { CURRENT_ANDROID_RELEASE } from "@/lib/androidRelease";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const RES = "android/app/src/main/res";

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf-8");
}

/**
 * Strips comments so explanatory prose never trips a guard.
 *
 * Needed because MainActivity DOCUMENTS the things it must not do — "not
 * System.currentTimeMillis()", "nothing sleeps" — and a raw text search finds
 * the explanation as readily as a violation. The same convention the Windows
 * shell guards use.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function exists(relativePath: string): boolean {
  return existsSync(join(repoRoot, relativePath));
}

function bytes(relativePath: string): number {
  return statSync(join(repoRoot, relativePath)).size;
}

/** Reads a PNG's dimensions from its IHDR header — no image library needed. */
function pngSize(relativePath: string): { width: number; height: number } {
  const buffer = readFileSync(join(repoRoot, relativePath));

  expect(buffer.subarray(1, 4).toString()).toBe("PNG");

  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const DENSITIES = ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"] as const;

/** Canvas sizes Capacitor's Android project already uses. */
const LEGACY_SIZE = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const ADAPTIVE_SIZE = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };

// ---------------------------------------------------------------------------
// Identity is untouched by artwork
// ---------------------------------------------------------------------------

describe("Android identity still matches the shared brand", () => {
  it("the display name is POS Canvas", () => {
    expect(read(`${RES}/values/strings.xml`)).toContain(
      `<string name="app_name">${BRAND.productName}</string>`
    );
  });

  it("the application id is unchanged", () => {
    const gradle = read("android/app/build.gradle");

    expect(gradle).toContain(`applicationId "${BRAND.appId}"`);
    expect(gradle).toContain(`namespace = "${BRAND.appId}"`);
  });

  it("the version is untouched by branding", () => {
    // 24.2 is artwork. A version bump belongs to a release, not an icon.
    //
    // Feature 25.7 — anchored to the SHAPE, not to 1.0.0. Pinning the literal
    // made an ordinary release bump fail an artwork guard, which says nothing
    // about artwork. What must stay true is that build.gradle carries a plain
    // versionCode/versionName pair and derives neither from anywhere else;
    // lib/releaseVersion.guards.test.ts owns the actual values.
    const gradle = read("android/app/build.gradle");

    expect(gradle).toMatch(/^\s*versionCode\s+\d+\s*$/m);
    expect(gradle).toMatch(/^\s*versionName\s+"\d+\.\d+\.\d+"\s*$/m);
  });

  it("the published release metadata is unchanged", () => {
    expect(CURRENT_ANDROID_RELEASE).toEqual({
      versionName: "1.0.0",
      versionCode: 1,
      downloadUrl:
        "https://github.com/aasishjannuaj/pos-canvas/releases/download/v1.0.0/POS-Canvas-v1.0.0.apk",
      checksum: "aded13d8db6eaed8a4fdeb5e56cf1a12036df24b64f54eec8f98ff2feb910125",
      fileSizeBytes: 3169762,
      releasedAt: "2026-08-14T23:52:46Z",
    });
  });
});

// ---------------------------------------------------------------------------
// Launcher icons
// ---------------------------------------------------------------------------

describe("every launcher density is present and correctly sized", () => {
  for (const density of DENSITIES) {
    it(`${density} legacy icons are ${LEGACY_SIZE[density]}px square`, () => {
      for (const name of ["ic_launcher", "ic_launcher_round"]) {
        const path = `${RES}/mipmap-${density}/${name}.png`;

        expect(`${path} missing`).toBe(`${path} missing`);
        expect(exists(path)).toBe(true);
        expect(pngSize(path)).toEqual({
          width: LEGACY_SIZE[density],
          height: LEGACY_SIZE[density],
        });
      }
    });

    it(`${density} adaptive layers are ${ADAPTIVE_SIZE[density]}px square`, () => {
      for (const name of ["ic_launcher_foreground", "ic_launcher_monochrome"]) {
        const path = `${RES}/mipmap-${density}/${name}.png`;

        expect(`${path} missing`).toBe(`${path} missing`);
        expect(exists(path)).toBe(true);
        expect(pngSize(path)).toEqual({
          width: ADAPTIVE_SIZE[density],
          height: ADAPTIVE_SIZE[density],
        });
      }
    });
  }
});

describe("the adaptive icon is fully declared", () => {
  for (const name of ["ic_launcher", "ic_launcher_round"]) {
    it(`${name}.xml declares background, foreground and monochrome`, () => {
      const xml = read(`${RES}/mipmap-anydpi-v26/${name}.xml`);

      expect(xml).toContain("<background android:drawable=\"@color/ic_launcher_background\"/>");
      expect(xml).toContain("<foreground android:drawable=\"@mipmap/ic_launcher_foreground\"/>");
      expect(xml).toContain("<monochrome android:drawable=\"@mipmap/ic_launcher_monochrome\"/>");
    });
  }

  it("every drawable the XML references exists at every density", () => {
    // A monochrome tag pointing at a missing mipmap is a build failure on
    // Android 13+ only — exactly the kind of thing that escapes a debug run.
    for (const density of DENSITIES) {
      for (const name of ["ic_launcher_foreground", "ic_launcher_monochrome"]) {
        expect(exists(`${RES}/mipmap-${density}/${name}.png`)).toBe(true);
      }
    }
  });

  it("the background colour is the approved ground, not the default white", () => {
    const xml = read(`${RES}/values/ic_launcher_background.xml`);

    expect(xml).toContain('<color name="ic_launcher_background">#FBF8F3</color>');
  });
});

// ---------------------------------------------------------------------------
// Splash
// ---------------------------------------------------------------------------

describe("every splash density is present and correctly sized", () => {
  const PORTRAIT = {
    mdpi: [320, 480],
    hdpi: [480, 800],
    xhdpi: [720, 1280],
    xxhdpi: [960, 1600],
    xxxhdpi: [1280, 1920],
  };
  const LANDSCAPE = {
    mdpi: [480, 320],
    hdpi: [800, 480],
    xhdpi: [1280, 720],
    xxhdpi: [1600, 960],
    xxxhdpi: [1920, 1280],
  };

  for (const density of DENSITIES) {
    it(`${density} portrait and landscape splashes keep their dimensions`, () => {
      const [pw, ph] = PORTRAIT[density];
      const [lw, lh] = LANDSCAPE[density];

      expect(pngSize(`${RES}/drawable-port-${density}/splash.png`)).toEqual({
        width: pw,
        height: ph,
      });
      expect(pngSize(`${RES}/drawable-land-${density}/splash.png`)).toEqual({
        width: lw,
        height: lh,
      });
    });
  }

  it("the fallback splash exists", () => {
    expect(pngSize(`${RES}/drawable/splash.png`)).toEqual({ width: 480, height: 320 });
  });

  it("the splash theme still points at the same drawable", () => {
    // 24.2 replaces artwork, never the boot architecture.
    expect(read(`${RES}/values/styles.xml`)).toContain(
      "<item name=\"android:background\">@drawable/splash</item>"
    );
  });

  it("the cold-start window is pinned to the brand, not the device theme", () => {
    // REGRESSION GUARD. Theme.SplashScreen leaves both of these unset, and the
    // defaults are wrong in opposite directions: the background falls through
    // to the platform's ?android:colorBackground (Material You - it followed
    // the emulator's light/dark setting instead of the brand ground), and on
    // API 24-30 the compat icon falls through to the stock Android robot.
    // Neither failure is visible to any other test in this repository.
    const styles = read(`${RES}/values/styles.xml`);

    expect(styles).toContain(
      '<item name="windowSplashScreenBackground">@color/ic_launcher_background</item>'
    );
    expect(styles).toContain(
      '<item name="windowSplashScreenAnimatedIcon">@drawable/pos_canvas_splash_icon</item>'
    );
  });

  // -------------------------------------------------------------------------
  // 24.2 polish pass — sharpness and brand visibility
  //
  // Owner feedback from a real phone: the startup mark looked blurry and
  // vanished too fast to register. Both causes are structural and neither is
  // visible in a diff, which is why they are pinned here.
  // -------------------------------------------------------------------------

  it("the splash icon is NOT the launcher icon", () => {
    // THE BLUR. @mipmap/ic_launcher's adaptive foreground is the 376px master
    // downscaled into a 66dp safe zone — 198px at xxhdpi — which the platform
    // then upscaled to ~504px on a 420dpi screen. A 2.5x upscale of an already
    // degraded image. Pointing the splash back at the launcher icon would
    // silently reintroduce exactly that.
    const styles = read(`${RES}/values/styles.xml`);
    const launchTheme = styles.slice(styles.indexOf("AppTheme.NoActionBarLaunch"));

    expect(code(launchTheme)).not.toContain('windowSplashScreenAnimatedIcon">@mipmap/');
    expect(styles).toContain(
      '<item name="windowSplashScreenAnimatedIcon">@drawable/pos_canvas_splash_icon</item>'
    );
  });

  it("the dedicated splash icon exists as an adaptive icon with a high-res foreground", () => {
    // VERIFIED ON A REAL API 36 DEVICE, not assumed: a plain PNG in
    // windowSplashScreenAnimatedIcon renders as NOTHING — cream background, no
    // mark, no error in logcat. The adaptive path is what the platform draws,
    // so this must stay an adaptive-icon XML.
    const xml = read(`${RES}/drawable-anydpi-v26/pos_canvas_splash_icon.xml`);

    expect(xml).toContain("<adaptive-icon");
    expect(xml).toContain('<background android:drawable="@color/ic_launcher_background"/>');
    expect(xml).toContain('<foreground android:drawable="@drawable/pos_canvas_splash_foreground"/>');

    // The API 24-25 fallback, where adaptive icons do not exist.
    expect(exists(`${RES}/drawable-nodpi/pos_canvas_splash_icon.png`)).toBe(true);
  });

  it("the splash foreground is high enough resolution to be DOWNSCALED on screen", () => {
    // The whole point of the fix. The platform asks for roughly 504px of mark
    // on a 420dpi phone and 576px on a 3x one; a source below that is an
    // upscale, which is the blur coming back.
    const path = `${RES}/drawable-nodpi/pos_canvas_splash_foreground.png`;

    expect(exists(path)).toBe(true);
    expect(pngSize(path)).toEqual({ width: 972, height: 972 });

    // 972 x 66/108 = 594px of actual mark inside the adaptive safe zone.
    expect(bytes(path)).toBeGreaterThan(50_000);
  });

  it("the launcher icon chain is untouched by the splash fix", () => {
    // The approved launcher artwork must not move because the SPLASH needed
    // sharpening. Separate resources, separate concerns.
    const launcher = read(`${RES}/mipmap-anydpi-v26/ic_launcher.xml`);

    expect(launcher).toContain('<foreground android:drawable="@mipmap/ic_launcher_foreground"/>');
    expect(launcher).toContain('<monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>');
    expect(launcher).not.toContain("pos_canvas_splash");

    for (const density of DENSITIES) {
      expect(exists(`${RES}/mipmap-${density}/ic_launcher.png`)).toBe(true);
      expect(exists(`${RES}/mipmap-${density}/ic_launcher_foreground.png`)).toBe(true);
      expect(exists(`${RES}/mipmap-${density}/ic_launcher_monochrome.png`)).toBe(true);
    }
  });

  it("the brand stays on screen long enough to register, without blocking", () => {
    // THE SECOND COMPLAINT. On a fast device the splash was dismissed the
    // instant the first frame was ready.
    const main = code(read("android/app/src/main/java/com/poscanvas/app/MainActivity.java"));

    expect(main).toContain("SplashScreen.installSplashScreen(this)");
    expect(main).toContain("setKeepOnScreenCondition");

    const declared = main.match(/MINIMUM_BRAND_VISIBLE_MS\s*=\s*(\d+)L/);

    expect(declared).not.toBeNull();

    const ms = Number(declared?.[1]);

    expect(ms).toBeGreaterThanOrEqual(1200);
    expect(ms).toBeLessThanOrEqual(1500);
  });

  it("nothing sleeps, blocks, or fakes progress on the startup path", () => {
    // A minimum display time implemented by sleeping would freeze the UI thread
    // and stall the WebView load it is supposed to overlap.
    const main = code(read("android/app/src/main/java/com/poscanvas/app/MainActivity.java"));

    for (const banned of [
      "Thread.sleep",
      "SystemClock.sleep",
      "await(",
      "Handler(",
      "postDelayed",
      "setProgress",
      "ProgressBar",
      "%",
    ]) {
      expect(`MainActivity: ${banned}`).toBe(`MainActivity: ${banned}`);
      expect(main).not.toContain(banned);
    }

    // Monotonic time: a wall clock can jump backwards and strand the splash.
    expect(main).toContain("SystemClock.uptimeMillis()");
    expect(main).not.toContain("System.currentTimeMillis()");
  });

  it("the handover from splash to runtime stays on the brand ground", () => {
    // Measured on device: at the WebView's default the sequence was
    // cream splash -> WHITE -> POS. Both halves of the fix are asserted, since
    // either alone leaves the flash.
    expect(read(`${RES}/values/styles.xml`)).toContain(
      '<item name="android:windowBackground">@color/ic_launcher_background</item>'
    );
    expect(read("capacitor.config.ts")).toContain('backgroundColor: "#FBF8F3"');
  });

  it("the splash carries no customer or project identity", () => {
    for (const file of [
      `${RES}/values/styles.xml`,
      `${RES}/drawable-anydpi-v26/pos_canvas_splash_icon.xml`,
    ]) {
      const source = read(file);

      expect(`${file}`).toBe(file);
      expect(source).not.toContain("project-logos");
      expect(source).not.toContain("businessName");
    }
  });

  it("the splash background is the same ground as the icon, so the mark has no halo", () => {
    // These two must not drift apart: the adaptive icon is rendered against
    // its own background colour, and the cold-start screen sits directly
    // behind it. A mismatch shows up as a ring around the mark.
    expect(read(`${RES}/values/ic_launcher_background.xml`)).toContain("#FBF8F3");
    expect(read(`${RES}/values/styles.xml`)).toContain(
      '<item name="windowSplashScreenBackground">@color/ic_launcher_background</item>'
    );
  });
});

// ---------------------------------------------------------------------------
// The artwork is real, and it is ours
// ---------------------------------------------------------------------------

describe("the assets are the approved mark, not toolchain defaults", () => {
  it("the approved reference board is committed", () => {
    expect(exists("assets/brand/concept-d-brand-board.png")).toBe(true);
  });

  it("the derived masters are committed", () => {
    for (const master of [
      "assets/brand/icon-mark-master.png",
      "assets/brand/icon-monochrome-master.png",
      "assets/brand/wordmark-master.png",
    ]) {
      expect(`${master} missing`).toBe(`${master} missing`);
      expect(exists(master)).toBe(true);
    }
  });

  it("the generator is committed, so a re-render is repeatable", () => {
    const script = read("assets/brand/generate-android-assets.sh");

    expect(script).toContain("ic_launcher_foreground");
    expect(script).toContain("ic_launcher_monochrome");
    expect(script).toContain("splash");
  });

  it("the favicon is no longer the create-next-app default", () => {
    // The default is exactly 25931 bytes.
    expect(exists("app/favicon.ico")).toBe(true);
    expect(bytes("app/favicon.ico")).not.toBe(25931);
  });

  it("every generated asset carries real image data", () => {
    // A zero-length or stub PNG would still satisfy a dimension check.
    for (const density of DENSITIES) {
      for (const name of [
        "ic_launcher",
        "ic_launcher_round",
        "ic_launcher_foreground",
        "ic_launcher_monochrome",
      ]) {
        const path = `${RES}/mipmap-${density}/${name}.png`;
        expect(`${path} too small`).toBe(`${path} too small`);
        expect(bytes(path)).toBeGreaterThan(200);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Platform branding is not customer branding
// ---------------------------------------------------------------------------

describe("customer branding stays out of the app's identity", () => {
  it("no customer logo path reaches the Android resources", () => {
    for (const file of [
      `${RES}/values/strings.xml`,
      `${RES}/values/styles.xml`,
      `${RES}/mipmap-anydpi-v26/ic_launcher.xml`,
    ]) {
      const source = read(file);

      expect(`${file}`).toBe(file);
      expect(source).not.toContain("project-logos");
      expect(source).not.toContain("businessName");
    }
  });

  it("the customer logo pipeline is untouched", () => {
    expect(read("lib/logoUpload.ts")).toContain('LOGO_BUCKET = "project-logos"');
    expect(read("lib/logoUpload.ts")).not.toContain("@/lib/brand");
  });

  it("the published configuration gains no platform artwork field", () => {
    const generated = read("lib/generatedPosConfig.ts");

    for (const banned of ["ic_launcher", "splash", "favicon", "brandMark"]) {
      expect(`generatedPosConfig: ${banned}`).toBe(`generatedPosConfig: ${banned}`);
      expect(generated).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

describe("Feature 24.2 stops at Android", () => {
  it("Windows branding lives on the Windows side, and never reaches Android", () => {
    // Feature 24.3 replaced the 24.2 fence that asserted windows-shell/build
    // did not exist. It exists now. What this guard protects is the boundary
    // that actually matters to 24.2: the two platforms share MASTERS in
    // assets/brand/ and share nothing else. No Android resource may be produced
    // from a Windows target, and no Windows asset may appear in the Android
    // resource tree.
    expect(exists("windows-shell/build/icon.ico")).toBe(true);

    const androidGenerator = read("assets/brand/generate-android-assets.sh");
    expect(androidGenerator).not.toContain("windows-shell");
    expect(androidGenerator).not.toContain(".ico");

    for (const windowsOnly of ["icon.ico", "installerSidebar", "splash-mark"]) {
      expect(`android res: ${windowsOnly}`).toBe(`android res: ${windowsOnly}`);
      expect(exists(`${RES}/mipmap-xxhdpi/${windowsOnly}`)).toBe(false);
    }
  });

  it("the Windows release and its pre-release status are unchanged", () => {
    const windows = read("lib/windowsRelease.ts");

    expect(windows).toContain(
      "03b88e35d12b01ffbf62116519817c554b18f8a8e51c21064b9f6e82a748855d"
    );
    expect(windows).toContain("isPrerelease: true");
  });

  it("no signing configuration appeared", () => {
    const shellPackage = read("windows-shell/package.json");

    for (const banned of ["certificateFile", "azureSignOptions", "signtool"]) {
      expect(`package.json: ${banned}`).toBe(`package.json: ${banned}`);
      expect(shellPackage).not.toContain(banned);
    }
  });

  it("no offline or publish-progress work began", () => {
    expect(exists("lib/offline.ts")).toBe(false);
    // FEATURE 24.6 HAS NOW STARTED, with owner approval, so lib/publishProgress.ts
    // exists deliberately and asserting its absence would only pin this file to a
    // past that has moved on. The boundary it protected is still real, so it is
    // restated rather than dropped: publish progress is an OWNER-EDITOR concern
    // and must not reach into the device, offline or branding surfaces.
    expect(read("lib/publishProgress.ts")).not.toContain("@/lib/device");
    expect(read("lib/publishProgress.ts")).not.toContain("@/lib/saleQueue");
    expect(read("lib/publishProgress.ts")).not.toContain("@/lib/brand");
  });
});
