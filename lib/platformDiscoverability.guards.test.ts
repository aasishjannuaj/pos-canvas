// Feature 22 Phase 3 — static guards for the three app-discovery surfaces.
//
// THE INVARIANT ALL THREE SHARE:
//
//   ONE universal POS Canvas app, for every customer and every project.
//
// Publishing freezes a project's business configuration into a json_config
// snapshot; the app is a separate universal binary. If any of these surfaces
// ever derived its download from a project, a build job, or an artifact, the
// download would silently become project-shaped — and nothing would fail except
// the customer's understanding of what they installed.
//
// The second invariant is Windows: it is announced, not built. No href, no
// disabled button, no placeholder asset, until Feature 23 ships a real binary.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf-8");
}

/** Strips comments so explanatory prose never trips a guard. */
function code(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const MODEL = "lib/platformDownloads.ts";
const ROW = "components/platform/PlatformDownloadRow.tsx";
const LANDING = "components/landing/PlatformAvailability.tsx";
const LANDING_PAGE = "app/page.tsx";
const DASHBOARD_CARD = "components/dashboard/AndroidAppCard.tsx";
const DEVICES_PANEL = "components/devices/RunYourPosPanel.tsx";
const DEVICES_HOST = "components/devices/DeviceManagementPanel.tsx";
const PUBLISH_PANEL = "components/editor/EditorPropertiesPanel.tsx";

/** Every surface that renders the universal app. */
const DISCOVERY_SURFACES = [LANDING, DASHBOARD_CARD, DEVICES_PANEL];

// ---------------------------------------------------------------------------
// Universal app invariant
// ---------------------------------------------------------------------------

describe("the app download is universal on every surface", () => {
  for (const surface of DISCOVERY_SURFACES) {
    it(`${surface} consumes no project, build job, or artifact`, () => {
      const source = code(read(surface));

      for (const banned of [
        "projectId",
        "project.id",
        "build_jobs",
        "buildJob",
        "buildJobId",
        "build_artifacts",
        "artifact",
        "GeneratedPosConfig",
        "config_snapshot",
      ]) {
        expect(`${surface}: ${source}`).not.toContain(banned);
      }
    });

    it(`${surface} builds no URL of its own`, () => {
      const source = code(read(surface));

      // Every href comes from the shared model, which derives it from the
      // verified release metadata.
      expect(source).not.toMatch(/href=["']https?:/);
      expect(source).not.toContain(".apk");
      expect(source).not.toContain("github.com");
      expect(source).toContain("getPlatformDownloads");
    });

    it(`${surface} touches no database or server action`, () => {
      const source = code(read(surface));
      for (const banned of ["supabase", "createClient", "use server", "fetch("]) {
        expect(source).not.toContain(banned);
      }
    });
  }

  it("only the shared model names the release", () => {
    // One import point for CURRENT_ANDROID_RELEASE across the whole feature.
    expect(code(read(MODEL))).toContain("CURRENT_ANDROID_RELEASE");

    for (const surface of DISCOVERY_SURFACES) {
      expect(code(read(surface))).not.toContain("CURRENT_ANDROID_RELEASE");
    }
  });

  it("no version string is hardcoded on any surface", () => {
    for (const surface of [...DISCOVERY_SURFACES, ROW]) {
      expect(code(read(surface))).not.toMatch(/\b1\.0\.0\b/);
    }
  });

  it("the release metadata stays uncoupled from build jobs", () => {
    const release = code(read("lib/androidRelease.ts"));
    for (const banned of ["build_jobs", "buildJob", "projectId", "GeneratedPosConfig"]) {
      expect(release).not.toContain(banned);
    }
  });

  it("no APK URL was added to the generated project config", () => {
    const generated = code(read("lib/generatedPosConfig.ts"));
    expect(generated).not.toContain(".apk");
    expect(generated).not.toContain("androidRelease");
    expect(generated).not.toContain("downloadUrl");
  });
});

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

describe("Windows is coming soon, never downloadable", () => {
  it("the model gives coming_soon no URL-bearing field", () => {
    const model = code(read(MODEL));
    const comingSoon = model.slice(
      model.indexOf("export type ComingSoonPlatformDownload"),
      model.indexOf("export type PlatformDownload")
    );

    for (const banned of ["release", "downloadUrl", "url", "href"]) {
      expect(comingSoon).not.toContain(banned);
    }
  });

  it("the row renders coming_soon as a badge, not a control", () => {
    // A disabled button or an <a> without a usable href is announced
    // inconsistently and reads as broken rather than as not-yet-built.
    const row = code(read(ROW));

    expect(row).toContain('download.status === "coming_soon"');
    expect(row).not.toMatch(/<button[^>]*disabled/);
    expect(row).not.toMatch(/<a[^>]*aria-disabled/);
    expect(row).not.toMatch(/href=\{[^}]*\?\?/);
  });

  it("only a downloadable platform can reach an anchor", () => {
    const row = code(read(ROW));
    expect(row).toContain("isDownloadable(download) ? (");
    expect(row).toContain("href={download.release.downloadUrl}");
  });

  it("no Windows installer artifact is referenced anywhere", () => {
    for (const surface of [...DISCOVERY_SURFACES, ROW, MODEL]) {
      const source = code(read(surface));
      for (const banned of [".exe", ".msi", "windows-download", "waitlist"]) {
        expect(`${surface}: ${source}`).not.toContain(banned);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

describe("landing placement", () => {
  const page = code(read(LANDING_PAGE));

  it("renders PlatformAvailability", () => {
    expect(page).toContain("<PlatformAvailability />");
  });

  it("sits between HowItWorks and CTASection", () => {
    const howItWorks = page.indexOf("<HowItWorks />");
    const platforms = page.indexOf("<PlatformAvailability />");
    const cta = page.indexOf("<CTASection />");

    expect(howItWorks).toBeGreaterThan(-1);
    expect(platforms).toBeGreaterThan(howItWorks);
    expect(cta).toBeGreaterThan(platforms);
  });

  it("uses the landing section heading and the required title", () => {
    const landing = read(LANDING);
    expect(landing).toContain("Run POS Canvas on your devices");
    expect(landing).toContain("SectionHeading");
  });

  it("needs no authentication to render", () => {
    // Platform availability must be visible to a logged-out visitor.
    const landing = code(read(LANDING));
    expect(landing).not.toContain("getClaims");
    expect(landing).not.toContain("auth");
  });

  it("makes no Play Store or pricing claim", () => {
    // Comment-stripped: this file's own header explains WHY Play Store language
    // is banned, and that explanation must not trip the guard whose subject is
    // rendered copy.
    const landing = code(read(LANDING));
    for (const banned of ["Play Store", "Google Play", "sideload", "trial", "per month"]) {
      expect(landing).not.toContain(banned);
    }
  });
});

describe("dashboard placement", () => {
  it("still renders the app download at account level", () => {
    expect(code(read("app/dashboard/page.tsx"))).toContain("<AndroidAppCard />");
  });

  it("shows both platforms through the shared row", () => {
    const card = code(read(DASHBOARD_CARD));
    expect(card).toContain("getPlatformDownloads");
    expect(card).toContain("PlatformDownloadRow");
  });

  it("is not rendered inside a project route", () => {
    for (const file of ["app/editor/[id]/page.tsx", "app/runtime/[id]/page.tsx"]) {
      expect(code(read(file))).not.toContain("AndroidAppCard");
    }
  });
});

describe("editor placement", () => {
  it("RunYourPosPanel is rendered inside the Devices experience", () => {
    expect(code(read(DEVICES_HOST))).toContain("<RunYourPosPanel");
  });

  it("shows the four-step sequence", () => {
    const panel = read(DEVICES_PANEL);
    for (const step of [
      "Save your changes",
      "Publish your configuration",
      "Install POS Canvas",
      "Pair your device",
    ]) {
      expect(panel).toContain(step);
    }
  });

  it("is NOT placed beside the publish artifact download", () => {
    // "Download configuration" (this project's json_config) and
    // "Download Android App" (the universal binary) must never share a surface.
    const publish = code(read(PUBLISH_PANEL));

    expect(publish).toContain("Download configuration");
    expect(publish).not.toContain("RunYourPosPanel");
    expect(publish).not.toContain("PlatformDownloadRow");
    expect(publish).not.toContain("getPlatformDownloads");
  });

  it("mints no pairing code and reads no pairing record", () => {
    const panel = code(read(DEVICES_PANEL));
    expect(panel).not.toContain("requestDevicePairingToken");
    expect(panel).not.toContain("create_device_pairing_token");
    expect(panel).not.toContain("pairedDevices");
  });

  it("takes only readiness, never a project or build id", () => {
    const panel = code(read(DEVICES_PANEL));
    expect(panel).toContain("readiness: PairingReadiness");
    expect(panel).not.toContain("projectId");
  });
});

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

describe("Phase 2 vocabulary is preserved on the new surfaces", () => {
  function customerFacingSources(): string[] {
    function walk(dir: string): string[] {
      return readdirSync(join(repoRoot, dir)).flatMap((entry) => {
        const relative = join(dir, entry);
        if (statSync(join(repoRoot, relative)).isDirectory()) return walk(relative);
        return /\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry) ? [relative] : [];
      });
    }

    return [...walk("app"), ...walk("components")];
  }

  it("no surface reintroduces per-project app language", () => {
    for (const file of customerFacingSources()) {
      const source = code(read(file));
      for (const banned of [
        "Build Application",
        "build your app",
        "your custom app",
        "generate APK",
        "Generate APK",
        "desktop build",
        "Download your app",
        "Export your POS",
      ]) {
        expect(`${file}: ${source}`).not.toContain(banned);
      }
    }
  });

  it("the new surfaces describe one universal app", () => {
    expect(read(LANDING)).toContain("universal POS Canvas app");
    expect(read(DASHBOARD_CARD)).toContain("universal POS Canvas app");
    expect(read(DEVICES_PANEL)).toContain("same for every business");
  });

  it("the shared component and model exist where expected", () => {
    expect(existsSync(join(repoRoot, ROW))).toBe(true);
    expect(existsSync(join(repoRoot, MODEL))).toBe(true);
  });
});
