// Feature 21 — static guards for the Android download surface.
//
// Source-level assertions, following this repository's convention: there is no
// DOM environment, and the properties below are structural rather than
// behavioural. The one that matters most cannot be caught by any behavioural
// test at all —
//
//   THE APK IS UNIVERSAL.
//
// One binary, byte-identical for every customer, carrying no project id, no
// configuration and no branding. A till becomes a specific business's till
// through PAIRING at runtime. If this UI ever consumed a build artifact, a
// build_jobs row, or a project config, the download would silently become
// project-shaped — and nothing would fail except the customer's understanding
// of what they installed.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

const CARD = "components/dashboard/AndroidAppCard.tsx";
const PAGE = "app/dashboard/page.tsx";
const METADATA = "lib/androidRelease.ts";

describe("the APK is universal, not project-specific", () => {
  const card = code(read(CARD));

  it("consumes no build artifact, build job, or project config", () => {
    // build_jobs models PER-PROJECT configuration snapshots and produces
    // json_config artifacts. The APK has nothing to do with either.
    for (const banned of [
      "build_jobs",
      "buildJobs",
      "buildJob",
      "artifact",
      "Artifact",
      "GeneratedPosConfig",
      "config_snapshot",
      "downloadBuildArtifact",
      "createBuildArtifactDownloadUrl",
    ]) {
      expect(card).not.toContain(banned);
    }
  });

  it("takes no project identifier of any kind", () => {
    // No prop, no param, no lookup. The component cannot vary by project even
    // if a caller wanted it to.
    for (const banned of ["projectId", "project.id", "projectName", "props", "params"]) {
      expect(card).not.toContain(banned);
    }
  });

  it("touches no database, server action, or Supabase client", () => {
    for (const banned of ["supabase", "createClient", "use server", "@/lib/projects"]) {
      expect(card).not.toContain(banned);
    }
  });

  it("reads its URL only from the shared release constant", () => {
    // One constant, one URL, every owner. The download link cannot be
    // assembled from anything project-derived.
    expect(card).toContain("CURRENT_ANDROID_RELEASE");
    expect(card).toContain("release.downloadUrl");
    // No hand-built URL anywhere in the component.
    expect(card).not.toMatch(/href="https?:\/\//);
    expect(card).not.toMatch(/\.apk["'`]/);
  });

  it("uses no project-specific language in its copy", () => {
    // Wording is the other half of the invariant: copy implying the binary was
    // generated for this project would mislead even with correct code.
    for (const phrase of [
      "your app",
      "your build",
      "generated for",
      "custom app",
      "your APK",
      "this project's app",
    ]) {
      expect(card.toLowerCase()).not.toContain(phrase.toLowerCase());
    }

    // And the positive statement is present.
    expect(card).toContain("Universal app");
  });

  it("lives at account level, not inside a project route", () => {
    // app/dashboard is account-scoped; app/editor/[id] is project-scoped.
    expect(code(read(PAGE))).toContain("<AndroidAppCard />");

    const projectScoped = ["app/editor/[id]/page.tsx", "app/runtime/[id]/page.tsx"];
    for (const file of projectScoped) {
      expect(code(read(file))).not.toContain("AndroidAppCard");
    }
  });

  it("is not rendered inside the project build or devices panels", () => {
    for (const file of [
      "components/editor/EditorPropertiesPanel.tsx",
      "components/devices/DeviceManagementPanel.tsx",
    ]) {
      expect(code(read(file))).not.toContain("AndroidAppCard");
      expect(code(read(file))).not.toContain("CURRENT_ANDROID_RELEASE");
    }
  });
});

describe("the download is external, direct, and safe", () => {
  const card = code(read(CARD));

  it("links straight to the GitHub asset over https", () => {
    const url = new URL(
      (
        read(METADATA).match(
          /downloadUrl:\s*\n?\s*"([^"]+)"/
        ) ?? []
      )[1] ?? ""
    );

    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("github.com");
  });

  it("opens the external link with safe rel attributes", () => {
    expect(card).toContain('target="_blank"');
    expect(card).toContain('rel="noopener noreferrer"');
  });

  it("does not proxy the binary through this app", () => {
    // No route handler, no server action, no fetch of the APK bytes. The
    // browser talks to GitHub directly.
    for (const banned of ["fetch(", "route.ts", "NextResponse", "arrayBuffer"]) {
      expect(card).not.toContain(banned);
    }
  });

  it("no APK is committed into the web app's public assets", () => {
    // Serving the binary from this repo would bloat it and couple app releases
    // to web deploys.
    function walk(dir: string): string[] {
      const absolute = join(repoRoot, dir);
      try {
        return readdirSync(absolute).flatMap((entry) => {
          const relative = join(dir, entry);
          return statSync(join(repoRoot, relative)).isDirectory()
            ? walk(relative)
            : [relative];
        });
      } catch {
        return [];
      }
    }

    expect(walk("public").filter((f) => /\.(apk|aab)$/i.test(f))).toEqual([]);
  });
});

describe("the unavailable state stays safe", () => {
  const card = code(read(CARD));

  it("handles a null release explicitly", () => {
    // Preserved even though v1.0.0 exists: a future gap must never render a
    // broken link or a fabricated one.
    expect(card).toContain("release === null");
    expect(card).toContain("Android release is not available yet.");
  });

  it("renders the download only when a release exists", () => {
    // The link sits in the non-null branch, after the null check.
    expect(card.indexOf("release === null")).toBeLessThan(
      card.indexOf("release.downloadUrl")
    );
  });
});

describe("scope stays where it was locked", () => {
  const card = code(read(CARD));

  it("claims no Play Store availability", () => {
    for (const phrase of ["Play Store", "Google Play", "play.google.com"]) {
      expect(card).not.toContain(phrase);
    }
  });

  it("adds no auto-update behaviour", () => {
    // Feature 21 is a download link. Update checking is not in scope.
    for (const banned of [
      "autoUpdate",
      "auto-update",
      "checkForUpdate",
      "updateAvailable",
      "setInterval",
      "useEffect",
    ]) {
      expect(card).not.toContain(banned);
    }
  });

  it("states only the device requirement the APK declares", () => {
    // minSdkVersion 24 was read from the published binary. No invented
    // hardware requirement.
    expect(card).toContain("ANDROID_MIN_VERSION_LABEL");
    for (const invented of ["camera", "Bluetooth", "NFC", "printer", "RAM", "GB"]) {
      expect(card).not.toContain(invented);
    }
  });

  it("uses no alarming install wording", () => {
    for (const scary of ["warning", "Warning", "danger", "risk", "unsafe", "untrusted"]) {
      expect(card).not.toContain(scary);
    }
  });
});

describe("the owner-facing copy is present and correct", () => {
  const card = read(CARD);

  it("shows the version", () => {
    expect(card).toContain("release.versionName");
    expect(card).toContain("Version {release.versionName}");
  });

  it("offers the download action", () => {
    expect(card).toContain("Download Android APK");
  });

  it("states the Android version requirement", () => {
    expect(read(METADATA)).toContain('ANDROID_MIN_VERSION_LABEL = "Android 7.0 or newer"');
  });

  it("gives pairing guidance without creating a pairing code", () => {
    expect(card).toContain("pairing code");
    expect(card).toContain("Build your latest configuration first");
    // Downloading must never mint a token.
    expect(code(card)).not.toContain("requestDevicePairingToken");
    expect(code(card)).not.toContain("create_device_pairing_token");
  });

  it("keeps the two concepts distinct for the owner", () => {
    // Project Build freezes a business configuration; the Android app is the
    // universal application. The copy must not blur them.
    expect(card).toContain("pair it");
    expect(card).toContain("after pairing");
  });
});
