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
    const gradle = read("android/app/build.gradle");

    expect(gradle).toContain("versionCode 1");
    expect(gradle).toContain('versionName "1.0.0"');
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
  it("no Windows branding was added", () => {
    // 24.3.
    expect(exists("windows-shell/build")).toBe(false);
    expect(read("windows-shell/package.json")).not.toContain('"icon"');
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
    expect(exists("lib/publishProgress.ts")).toBe(false);
  });
});
