// Feature 24.1 — the platform identity, and the line between it and a
// customer's own branding.
//
// TWO SUBJECTS.
//
// 1. ONE IDENTITY, DECLARED ONCE. The product name and application id are typed
//    into five files that no mechanism previously connected: the Capacitor
//    config, the Android string resources and Gradle, the Windows package
//    manifest, and the Electron main process. They agreed by luck. These guards
//    compare each one against lib/brand.ts, so a rename in one place is a
//    failing test rather than a shell whose window says one thing and whose
//    Start Menu entry says another.
//
// 2. PLATFORM BRANDING IS NOT CUSTOMER BRANDING. POS Canvas's mark identifies
//    the app; a business's logo and accent colour identify the business and are
//    frozen into a published GeneratedPosConfig. Crossing them would be a bug in
//    both directions — a customer's logo becoming the launcher icon, or the POS
//    Canvas mark being baked into a customer's published configuration.
//
// The identity values are IMPORTED and compared, not scanned for as substrings,
// so these guards say what the values must be rather than merely that some file
// mentions them.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BRAND, BRAND_APP_SUMMARY, BRAND_TAGLINE } from "@/lib/brand";
import { getAppInformation } from "@/lib/appInformation";
import { getPlatformDownloads } from "@/lib/platformDownloads";
import { CURRENT_ANDROID_RELEASE } from "@/lib/androidRelease";
import { CURRENT_WINDOWS_RELEASE } from "@/lib/windowsRelease";

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

// ---------------------------------------------------------------------------
// The locked identity
// ---------------------------------------------------------------------------

describe("the platform identity is exactly what was approved", () => {
  it("productName is POS Canvas", () => {
    expect(BRAND.productName).toBe("POS Canvas");
  });

  it("shortName is POS Canvas", () => {
    expect(BRAND.shortName).toBe("POS Canvas");
  });

  it("companyDisplayName is POS Canvas", () => {
    expect(BRAND.companyDisplayName).toBe("POS Canvas");
  });

  it("appId is com.poscanvas.app", () => {
    expect(BRAND.appId).toBe("com.poscanvas.app");
  });

  it("websiteName is POS Canvas", () => {
    expect(BRAND.websiteName).toBe("POS Canvas");
  });
});

describe("no legal entity is invented", () => {
  it("legalCompanyName is null, not a guess", () => {
    // No company has been established. A display name in a legal position would
    // be a false claim about who is responsible for the software, and it is the
    // field a signing certificate subject would have to match.
    expect(BRAND.legalCompanyName).toBeNull();
  });

  it("no legal suffix appears in any identity value", () => {
    // flatMap rather than a filtered predicate: BRAND is `as const`, so
    // Object.values is a union of string literals and null, and a
    // `value is string` predicate is not assignable to that parameter type.
    const identityStrings: string[] = Object.values(BRAND).flatMap((value) =>
      typeof value === "string" ? [value] : []
    );

    for (const value of [...identityStrings, BRAND_TAGLINE, BRAND_APP_SUMMARY]) {
      for (const suffix of [
        "Inc.",
        "Inc ",
        "LLC",
        "Ltd",
        "Limited",
        "GmbH",
        "Technologies",
        "Corporation",
        "Corp.",
        "Holdings",
        "Pty",
      ]) {
        expect(`"${value}" contains ${suffix}`).toBe(`"${value}" contains ${suffix}`);
        expect(value).not.toContain(suffix);
      }
    }
  });

  it("invents no support address or marketing URL", () => {
    expect(BRAND.supportEmail).toBeNull();
    expect(BRAND.websiteUrl).toBeNull();
  });

  it("no identity value is an empty or whitespace string", () => {
    for (const [key, value] of Object.entries(BRAND)) {
      if (typeof value !== "string") continue;
      expect(`${key} is blank`).toBe(`${key} is blank`);
      expect(value.trim()).not.toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
// Every shell agrees with the shared declaration
// ---------------------------------------------------------------------------

describe("Android declares the shared identity", () => {
  it("the Capacitor appName matches", () => {
    expect(code(read("capacitor.config.ts"))).toContain(
      `appName: "${BRAND.productName}"`
    );
  });

  it("the Capacitor appId matches", () => {
    expect(code(read("capacitor.config.ts"))).toContain(`appId: "${BRAND.appId}"`);
  });

  it("the Android display name matches", () => {
    expect(read("android/app/src/main/res/values/strings.xml")).toContain(
      `<string name="app_name">${BRAND.productName}</string>`
    );
  });

  it("the Gradle applicationId and namespace match", () => {
    const gradle = read("android/app/build.gradle");

    expect(gradle).toContain(`namespace = "${BRAND.appId}"`);
    expect(gradle).toContain(`applicationId "${BRAND.appId}"`);
  });

  it("no stale or provisional package id survives", () => {
    // com.poscanvas.dev was the provisional id before Feature 20.
    for (const file of [
      "capacitor.config.ts",
      "android/app/build.gradle",
      "android/app/src/main/res/values/strings.xml",
    ]) {
      expect(`${file}`).toBe(file);
      expect(code(read(file))).not.toContain("com.poscanvas.dev");
    }
  });
});

describe("Windows declares the shared identity", () => {
  const shellPackage = JSON.parse(read("windows-shell/package.json")) as {
    productName: string;
    build: { appId: string; productName: string; nsis: { shortcutName: string } };
  };

  it("productName matches in both manifest positions", () => {
    expect(shellPackage.productName).toBe(BRAND.productName);
    expect(shellPackage.build.productName).toBe(BRAND.productName);
  });

  it("appId matches", () => {
    expect(shellPackage.build.appId).toBe(BRAND.appId);
  });

  it("the Start Menu shortcut name matches", () => {
    expect(shellPackage.build.nsis.shortcutName).toBe(BRAND.shortName);
  });

  it("the Electron process and window name match", () => {
    const main = code(read("windows-shell/main.mjs"));

    expect(main).toContain(`app.setName("${BRAND.productName}")`);
    expect(main).toContain(`title: "${BRAND.productName}"`);
  });
});

// ---------------------------------------------------------------------------
// Web metadata
// ---------------------------------------------------------------------------

describe("the website identifies itself", () => {
  const layout = code(read("app/layout.tsx"));

  it("no longer ships the create-next-app default", () => {
    // This was the browser tab title for the landing page, the dashboard and
    // the editor.
    expect(layout).not.toContain("Create Next App");
    expect(layout).not.toContain("Generated by create next app");
  });

  it("takes its title and description from the brand module", () => {
    expect(layout).toContain("BRAND.productName");
    expect(layout).toContain("BRAND_TAGLINE");
  });

  it("the device route keeps its own title", () => {
    expect(code(read("app/device/page.tsx"))).toContain("POS Canvas");
  });
});

// ---------------------------------------------------------------------------
// Copy consistency
// ---------------------------------------------------------------------------

describe("the product name is spelled one way", () => {
  const surfaces = [
    "app/layout.tsx",
    "components/landing/Footer.tsx",
    "components/landing/PlatformAvailability.tsx",
    "components/dashboard/AndroidAppCard.tsx",
    "components/devices/RunYourPosPanel.tsx",
    "components/platform/PlatformDownloadRow.tsx",
    "components/editor/EditorPropertiesPanel.tsx",
  ];

  for (const surface of surfaces) {
    it(`${surface} carries no misspelling or casing variant`, () => {
      const source = read(surface);

      for (const wrong of ["POS Canvs", "Pos Canvas", "POSCanvas", "Poscanvas"]) {
        expect(`${surface}: ${wrong}`).toBe(`${surface}: ${wrong}`);
        expect(source).not.toContain(wrong);
      }
    });
  }

  it("the locked platform vocabulary is not reintroduced", () => {
    for (const surface of surfaces) {
      const source = code(read(surface));

      for (const banned of [
        "desktop app",
        "Desktop app",
        "Windows desktop build",
        "custom Windows app",
        "custom Android APK",
        "custom app",
      ]) {
        expect(`${surface}: ${source}`).not.toContain(banned);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// About / app information
// ---------------------------------------------------------------------------

describe("the About panel composes rather than restates", () => {
  const info = getAppInformation();

  it("reports the shared identity", () => {
    expect(info.productName).toBe(BRAND.productName);
    expect(info.companyDisplayName).toBe(BRAND.companyDisplayName);
    expect(info.legalCompanyName).toBeNull();
  });

  it("derives each platform's version from the release metadata", () => {
    const android = info.platforms.find((p) => p.label === "Android");
    const windows = info.platforms.find((p) => p.label === "Windows");

    expect(android?.versionName).toBe(CURRENT_ANDROID_RELEASE?.versionName ?? null);
    expect(windows?.versionName).toBe(CURRENT_WINDOWS_RELEASE?.versionName ?? null);
  });

  it("carries the pre-release status through", () => {
    const windows = info.platforms.find((p) => p.label === "Windows");
    expect(windows?.isPrerelease).toBe(CURRENT_WINDOWS_RELEASE?.isPrerelease === true);

    const android = info.platforms.find((p) => p.label === "Android");
    expect(android?.isPrerelease).toBe(false);
  });

  it("renders nothing for a platform with no release", () => {
    // The unavailable branch must produce nulls, never a fabricated version.
    const [android] = getPlatformDownloads(null);
    const info = getAppInformation([android]);

    expect(info.platforms[0].versionName).toBeNull();
    expect(info.platforms[0].requirement).toBeNull();
  });

  it("duplicates no release object", () => {
    // Version, URL and requirement all live in the release modules. This one
    // must read them, never restate them.
    const source = code(read("lib/appInformation.ts"));

    expect(source).not.toContain("1.0.0");
    expect(source).not.toContain("releases/download");
    expect(source).not.toContain("Windows 10");
    expect(source).not.toContain("Android 7");
  });

  it("exposes no technical internals to the customer", () => {
    const source = code(read("lib/appInformation.ts"));
    const panel = code(read("components/editor/EditorPropertiesPanel.tsx"));

    // True of all of these, and useful to none of them.
    for (const internal of [
      "Supabase",
      "Electron",
      "Capacitor",
      "Vercel",
      "GitHub",
      "build_jobs",
      "com.poscanvas.app",
    ]) {
      expect(`appInformation: ${internal}`).toBe(`appInformation: ${internal}`);
      expect(source).not.toContain(internal);
    }

    // The About panel itself must not print the application id.
    const about = panel.slice(panel.indexOf("function AboutPosCanvas"));
    expect(about).not.toContain("appId");
    expect(about).not.toContain("com.poscanvas");
  });

  it("shows no legal company line while none exists", () => {
    const panel = code(read("components/editor/EditorPropertiesPanel.tsx"));
    const about = panel.slice(panel.indexOf("function AboutPosCanvas"));

    expect(about).not.toContain("legalCompanyName");
  });
});

// ---------------------------------------------------------------------------
// Platform branding vs customer branding
// ---------------------------------------------------------------------------

describe("platform branding never becomes customer branding", () => {
  it("the published configuration gains no platform-brand field", () => {
    const generated = code(read("lib/generatedPosConfig.ts"));

    for (const banned of ["BRAND", "productName", "companyDisplayName", "appId"]) {
      expect(`generatedPosConfig: ${banned}`).toBe(`generatedPosConfig: ${banned}`);
      expect(generated).not.toContain(banned);
    }
  });

  it("the generated config's branding is still the CUSTOMER's", () => {
    // BrandingSettings is accent colour + the business's own uploaded logo.
    const generated = code(read("lib/generatedPosConfig.ts"));

    expect(generated).toContain("branding: BrandingSettings");
    expect(code(read("lib/projectConfig.ts"))).toContain("export type BrandingSettings");
  });

  it("the brand module knows nothing about projects or customers", () => {
    const brand = code(read("lib/brand.ts"));

    for (const banned of [
      "projectId",
      "project_id",
      "ProjectConfig",
      "BrandingSettings",
      "GeneratedPosConfig",
      "businessName",
      "logo",
      "project-logos",
      "supabase",
    ]) {
      expect(`brand.ts: ${banned}`).toBe(`brand.ts: ${banned}`);
      expect(brand).not.toContain(banned);
    }
  });

  it("the customer logo pipeline knows nothing about platform branding", () => {
    for (const file of ["lib/logoUpload.ts", "components/editor/BrandingLogoField.tsx"]) {
      const source = code(read(file));

      expect(`${file}`).toBe(file);
      expect(source).not.toContain("@/lib/brand");
      expect(source).not.toContain("BRAND.");
    }
  });

  it("the customer logo bucket is untouched", () => {
    expect(code(read("lib/logoUpload.ts"))).toContain('LOGO_BUCKET = "project-logos"');
  });
});

// ---------------------------------------------------------------------------
// Scope — 24.2 / 24.3 artwork not started
// ---------------------------------------------------------------------------

describe("brand assets are approved artwork, in one place", () => {
  it("the asset contract is documented", () => {
    expect(existsSync(join(repoRoot, "assets/brand/README.md"))).toBe(true);
  });

  it("the artwork is the owner-approved reference, not something improvised", () => {
    // Feature 24.2 replaced the 24.1 fence that asserted NO artwork existed.
    // What survives is the rule that mattered: every mark traces to an approved
    // board committed alongside it, and nothing was invented, downloaded or
    // AI-improvised in its place. lib/androidBranding.guards.test.ts asserts the
    // generated targets.
    expect(existsSync(join(repoRoot, "assets/brand/concept-d-brand-board.png"))).toBe(true);
    expect(existsSync(join(repoRoot, "assets/brand/icon-mark-master.png"))).toBe(true);

    const contract = read("assets/brand/README.md");
    expect(contract).toContain("TEMPORARY");
    expect(contract).toContain("Concept D");
  });

  it("no second asset tree appeared", () => {
    // One home for masters. public/ serves files to browsers and is not it.
    expect(existsSync(join(repoRoot, "public/brand"))).toBe(false);
  });

  it("the Windows icon reaches electron-builder by convention, not by config", () => {
    // Feature 24.3 replaced the 24.1 fence that asserted NO Windows icon
    // existed. What survives is the reason the fence read the way it did: there
    // is still no "icon" key in windows-shell/package.json, because
    // electron-builder resolves build/icon.ico from its buildResources
    // directory on its own (app-builder-lib's iconConverter appends
    // "icon.ico" to the candidate list). Adding a path would be a second place
    // for the same fact to live, and a second place to get it wrong.
    const shellPackage = read("windows-shell/package.json");
    expect(shellPackage).not.toContain('"icon"');
    expect(existsSync(join(repoRoot, "windows-shell/build/icon.ico"))).toBe(true);
  });

  it("release metadata is untouched by branding", () => {
    // Identity and release engineering stay separate concerns.
    for (const file of ["lib/androidRelease.ts", "lib/windowsRelease.ts"]) {
      expect(`${file}`).toBe(file);
      expect(code(read(file))).not.toContain("@/lib/brand");
    }
  });

  it("the Android release is unchanged", () => {
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

  it("the Windows release and its pre-release status are unchanged", () => {
    expect(CURRENT_WINDOWS_RELEASE?.checksum).toBe(
      "03b88e35d12b01ffbf62116519817c554b18f8a8e51c21064b9f6e82a748855d"
    );
    expect(CURRENT_WINDOWS_RELEASE?.fileSizeBytes).toBe(99637338);
    expect(CURRENT_WINDOWS_RELEASE?.isPrerelease).toBe(true);
  });

  it("no signing configuration appeared", () => {
    const shellPackage = read("windows-shell/package.json");

    for (const banned of ["certificateFile", "azureSignOptions", "signtool", ".pfx"]) {
      expect(`package.json: ${banned}`).toBe(`package.json: ${banned}`);
      expect(shellPackage).not.toContain(banned);
    }
  });

  it("no offline or publish-progress work began", () => {
    // 24.4 / 24.5 / 24.6.
    expect(existsSync(join(repoRoot, "lib/offline.ts"))).toBe(false);
    expect(existsSync(join(repoRoot, "lib/publishProgress.ts"))).toBe(false);
    expect(code(read("windows-shell/offline.html"))).not.toContain("localStorage");
  });
});
