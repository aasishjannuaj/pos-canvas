// Feature 23.6 — the Windows release contract, and the gate that keeps it shut.
//
// THE GATE. Windows is NOT publicly downloadable in this phase, because the
// installer is unsigned and an unsigned installer is not a customer-ready
// download: SmartScreen warns strongly on it and Smart App Control or enterprise
// policy can block it outright. `CURRENT_WINDOWS_RELEASE` is therefore null, and
// these guards assert that the whole product still renders "Coming soon" as a
// result — not because a constant says so, but because there is no release.
//
// WHAT CHANGED ANYWAY. The metadata architecture, the shared release type and
// the download model are all built and tested, so populating one verified
// object is the only remaining step once signing is decided. Nothing about that
// architecture may invent a URL in the meantime, which is what most of this file
// is about.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CURRENT_WINDOWS_RELEASE,
  WINDOWS_MIN_VERSION_LABEL,
  WINDOWS_RELEASE_TAG_PREFIX,
  isWindowsRelease,
} from "@/lib/windowsRelease";
import { CURRENT_ANDROID_RELEASE, isAndroidRelease } from "@/lib/androidRelease";
import {
  PRERELEASE_BADGE_LABEL,
  isPlatformRelease,
  formatReleaseSize,
} from "@/lib/platformRelease";
import {
  getPlatformDownloads,
  getWindowsDownload,
  getAndroidDownload,
  isDownloadable,
} from "@/lib/platformDownloads";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf-8");
}

/** Strips comments so explanatory prose never trips a guard. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** A shape that would be valid IF it were ever published. Never used as real. */
const HYPOTHETICAL: unknown = {
  versionName: "1.0.0",
  downloadUrl:
    "https://github.com/aasishjannuaj/pos-canvas/releases/download/windows-v1.0.0/POS-Canvas-Windows-v1.0.0.exe",
  checksum: "49f2985c4d3d141dd37d66379c5cfa9510d250b6dee167b46fb65a109d634716",
  fileSizeBytes: 99637032,
  releasedAt: "2026-08-15T20:00:00Z",
};

// ---------------------------------------------------------------------------
// The release gate
// ---------------------------------------------------------------------------

describe("Windows is published as an unsigned pre-release", () => {
  it("CURRENT_WINDOWS_RELEASE holds the verified published values", () => {
    // Every field was verified against the published GitHub asset: the API's
    // reported size, the downloaded bytes' sha-256, and its own .sha256 file.
    expect(CURRENT_WINDOWS_RELEASE).toEqual({
      versionName: "1.0.0",
      downloadUrl:
        "https://github.com/aasishjannuaj/pos-canvas/releases/download/windows-v1.0.0/POS-Canvas-Windows-v1.0.0.exe",
      checksum: "03b88e35d12b01ffbf62116519817c554b18f8a8e51c21064b9f6e82a748855d",
      fileSizeBytes: 99637338,
      releasedAt: "2026-08-16T15:24:22Z",
      isPrerelease: true,
    });
  });

  it("it validates through the real guard", () => {
    expect(isWindowsRelease(CURRENT_WINDOWS_RELEASE)).toBe(true);
  });

  it("is published under the windows-v tag, never Android's", () => {
    const url = CURRENT_WINDOWS_RELEASE?.downloadUrl ?? "";

    expect(url).toContain("/releases/download/windows-v1.0.0/");
    expect(url).not.toMatch(/\/releases\/download\/v1\.0\.0\//);
  });

  it("points at the exact installer filename", () => {
    expect(CURRENT_WINDOWS_RELEASE?.downloadUrl.endsWith(
      "/POS-Canvas-Windows-v1.0.0.exe"
    )).toBe(true);
  });

  it("carries a 64-character lowercase sha-256", () => {
    expect(CURRENT_WINDOWS_RELEASE?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records the CI artifact size, not the macOS cross-build", () => {
    // The local cross-build is 99637032 bytes. Only the CI artifact was
    // published, and the sizes differing is how that stays checkable.
    expect(CURRENT_WINDOWS_RELEASE?.fileSizeBytes).toBe(99637338);
    expect(CURRENT_WINDOWS_RELEASE?.fileSizeBytes).not.toBe(99637032);
  });

  it("records a valid release timestamp", () => {
    const at = CURRENT_WINDOWS_RELEASE?.releasedAt ?? "";

    expect(at).toBe("2026-08-16T15:24:22Z");
    expect(Number.isNaN(new Date(at).getTime())).toBe(false);
  });

  it("is served over https", () => {
    expect(new URL(CURRENT_WINDOWS_RELEASE?.downloadUrl ?? "").protocol).toBe("https:");
  });

  it("every surface now renders it as a real download", () => {
    const [, windows] = getPlatformDownloads();

    expect(windows.platform).toBe("windows");
    expect(windows.status).toBe("available");
    expect(isDownloadable(windows)).toBe(true);
  });

  it("no surface hardcodes the installer URL", () => {
    // The release object is the single source; components read the model.
    for (const surface of [
      "lib/platformDownloads.ts",
      "components/platform/PlatformDownloadRow.tsx",
      "components/dashboard/AndroidAppCard.tsx",
      "components/landing/PlatformAvailability.tsx",
      "components/devices/RunYourPosPanel.tsx",
    ]) {
      const source = code(read(surface));

      expect(`${surface}: ${source}`).not.toContain("POS-Canvas-Windows-v");
      expect(`${surface}: ${source}`).not.toContain(".exe");
      expect(`${surface}: ${source}`).not.toContain("releases/download");
    }
  });

  it("the URL appears exactly once in the whole repository", () => {
    // Duplication is how a stale link survives a version bump.
    const occurrences = [
      "lib/windowsRelease.ts",
      "lib/platformDownloads.ts",
      "lib/platformRelease.ts",
      "lib/androidRelease.ts",
    ].filter((f) =>
      read(f).includes(
        "releases/download/windows-v1.0.0/POS-Canvas-Windows-v1.0.0.exe"
      )
    );

    expect(occurrences).toEqual(["lib/windowsRelease.ts"]);
  });
});

// ---------------------------------------------------------------------------
// Release integrity — what a real release must look like
// ---------------------------------------------------------------------------

describe("a Windows release must be structurally verifiable", () => {
  it("accepts a well-formed release", () => {
    expect(isWindowsRelease(HYPOTHETICAL)).toBe(true);
  });

  it("requires the windows-v tag in the URL", () => {
    // Android's tag is `v1.0.0`; Windows must never be published under it.
    expect(WINDOWS_RELEASE_TAG_PREFIX).toBe("windows-v");

    expect(
      isWindowsRelease({
        ...(HYPOTHETICAL as object),
        downloadUrl:
          "https://github.com/aasishjannuaj/pos-canvas/releases/download/v1.0.0/POS-Canvas-Windows-v1.0.0.exe",
      })
    ).toBe(false);
  });

  it("requires the exact installer filename", () => {
    for (const wrongName of [
      "POS-Canvas-v1.0.0.apk",
      "POS-Canvas-Windows.exe",
      "POS-Canvas-Windows-v1.0.0.msi",
      "setup.exe",
    ]) {
      expect(
        isWindowsRelease({
          ...(HYPOTHETICAL as object),
          downloadUrl: `https://github.com/aasishjannuaj/pos-canvas/releases/download/windows-v1.0.0/${wrongName}`,
        })
      ).toBe(false);
    }
  });

  it("requires the filename version to match the release version", () => {
    // A v1.0.1 release pointing at the v1.0.0 asset is the kind of copy-paste
    // slip that ships the wrong binary.
    expect(
      isWindowsRelease({
        ...(HYPOTHETICAL as object),
        versionName: "1.0.1",
      })
    ).toBe(false);
  });

  it("requires https", () => {
    expect(
      isWindowsRelease({
        ...(HYPOTHETICAL as object),
        downloadUrl:
          "http://github.com/aasishjannuaj/pos-canvas/releases/download/windows-v1.0.0/POS-Canvas-Windows-v1.0.0.exe",
      })
    ).toBe(false);
  });

  it("requires a 64-character lowercase hex checksum", () => {
    for (const bad of [
      "",
      "abc",
      "A".repeat(64),
      "g".repeat(64),
      "a".repeat(63),
      "a".repeat(65),
    ]) {
      expect(isWindowsRelease({ ...(HYPOTHETICAL as object), checksum: bad })).toBe(
        false
      );
    }
  });

  it("requires a positive integer file size", () => {
    for (const bad of [0, -1, 1.5, "99637032", null]) {
      expect(
        isWindowsRelease({ ...(HYPOTHETICAL as object), fileSizeBytes: bad })
      ).toBe(false);
    }
  });

  it("requires a semver version and a parseable date", () => {
    expect(isWindowsRelease({ ...(HYPOTHETICAL as object), versionName: "1.0" })).toBe(
      false
    );
    expect(
      isWindowsRelease({ ...(HYPOTHETICAL as object), releasedAt: "not a date" })
    ).toBe(false);
  });

  it("rejects a non-object outright", () => {
    for (const bad of [null, undefined, 0, "release", [], true]) {
      expect(isWindowsRelease(bad)).toBe(false);
    }
  });

  it("carries no versionCode — Windows has no install-ordering rule", () => {
    const source = code(read("lib/windowsRelease.ts"));
    expect(source).not.toContain("versionCode");
  });
});

// ---------------------------------------------------------------------------
// The pre-release policy (owner-approved, Feature 23.6)
// ---------------------------------------------------------------------------

describe("an unsigned build must be labelled pre-release", () => {
  it("the published release IS marked pre-release", () => {
    // The owner-approved policy: an unsigned build is downloadable during
    // development ONLY while labelled as such. When signing lands, this guard is
    // updated deliberately alongside the signed release — never switched off
    // quietly to make an unsigned build look finished.
    expect(CURRENT_WINDOWS_RELEASE).not.toBeNull();
    expect(CURRENT_WINDOWS_RELEASE?.isPrerelease).toBe(true);
  });

  it("the release object carries the flag through validation", () => {
    expect(isWindowsRelease({ ...(HYPOTHETICAL as object), isPrerelease: true })).toBe(
      true
    );
    // A non-boolean would silently mislabel the build.
    expect(
      isWindowsRelease({ ...(HYPOTHETICAL as object), isPrerelease: "yes" })
    ).toBe(false);
  });

  it("the badge is honest and claims nothing about trust", () => {
    expect(PRERELEASE_BADGE_LABEL).toBe("Pre-release · Unsigned build");

    for (const overclaim of [
      "Securely signed",
      "Verified publisher",
      "Production signed",
      "SmartScreen trusted",
      "Trusted",
      "Verified",
    ]) {
      expect(PRERELEASE_BADGE_LABEL).not.toContain(overclaim);
    }
  });

  it("the badge lives in the shared model, not in three components", () => {
    for (const surface of [
      "components/landing/PlatformAvailability.tsx",
      "components/dashboard/AndroidAppCard.tsx",
      "components/devices/RunYourPosPanel.tsx",
    ]) {
      const source = code(read(surface));
      expect(`${surface}: ${source}`).not.toContain("Pre-release");
      expect(`${surface}: ${source}`).not.toContain("Unsigned");
    }

    const row = code(read("components/platform/PlatformDownloadRow.tsx"));
    expect(row).toContain("PRERELEASE_BADGE_LABEL");
    expect(row).toContain("download.release.isPrerelease === true");
  });

  it("Android is never labelled pre-release", () => {
    // The flag is optional and absent on Android's stable release, so the badge
    // cannot appear there by construction.
    expect(CURRENT_ANDROID_RELEASE?.isPrerelease).toBeUndefined();
    expect(getAndroidDownload().status).toBe("available");
  });

  it("a stable release renders no badge", () => {
    const stable = { ...(HYPOTHETICAL as object) } as Record<string, unknown>;
    delete stable.isPrerelease;

    expect(isPlatformRelease(stable)).toBe(true);
    expect((stable as { isPrerelease?: boolean }).isPrerelease).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The shared base
// ---------------------------------------------------------------------------

describe("the shared platform release type", () => {
  it("Android still validates exactly as before", () => {
    expect(isAndroidRelease(CURRENT_ANDROID_RELEASE)).toBe(true);
  });

  it("Android still requires its versionCode", () => {
    const withoutCode = { ...(CURRENT_ANDROID_RELEASE as object) } as Record<
      string,
      unknown
    >;
    delete withoutCode.versionCode;

    expect(isPlatformRelease(withoutCode)).toBe(true);
    expect(isAndroidRelease(withoutCode)).toBe(false);
  });

  it("a Windows release is NOT a valid Android release", () => {
    // The base is shared; the platform-specific requirement still separates them.
    expect(isAndroidRelease(HYPOTHETICAL)).toBe(false);
  });

  it("one size formatter serves both platforms", () => {
    expect(formatReleaseSize(99637032)).toBe("95.0 MB");
    expect(formatReleaseSize(3169762)).toBe("3.0 MB");
    expect(formatReleaseSize(0)).toBe("");
  });

  it("the Android module re-exports it rather than keeping a copy", () => {
    const android = code(read("lib/androidRelease.ts"));
    expect(android).toContain('export { formatReleaseSize } from "@/lib/platformRelease"');
    // The duplicated validation helpers are gone.
    expect(android).not.toContain("function isHttpsUrl");
    expect(android).not.toContain("const SHA256_HEX");
  });
});

// ---------------------------------------------------------------------------
// Android is untouched
// ---------------------------------------------------------------------------

describe("the Android release is unchanged", () => {
  it("still points at the same verified artifact", () => {
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

  it("still renders as a real download", () => {
    const android = getAndroidDownload();

    expect(android.status).toBe("available");
    expect(isDownloadable(android)).toBe(true);
  });

  it("keeps its own tag, separate from Windows", () => {
    // Independent cadence: a Windows release must never force an Android bump.
    const url = CURRENT_ANDROID_RELEASE?.downloadUrl ?? "";

    expect(url).toContain("/releases/download/v1.0.0/");
    expect(url).not.toContain("windows-v");
  });
});

// ---------------------------------------------------------------------------
// Universal-app invariant
// ---------------------------------------------------------------------------

describe("the Windows release is account-level, never per project", () => {
  it("the metadata module takes no project, build, or customer value", () => {
    const source = code(read("lib/windowsRelease.ts"));

    for (const banned of [
      "projectId",
      "project_id",
      "buildJob",
      "build_jobs",
      "buildJobId",
      "build_artifacts",
      "GeneratedPosConfig",
      "config_snapshot",
      "businessName",
      "ownerId",
      "customerId",
      "BuildTarget",
    ]) {
      expect(`windowsRelease.ts: ${source}`).not.toContain(banned);
    }
  });

  it("getWindowsDownload takes only a release", () => {
    // No second parameter could introduce a per-project variant.
    expect(getWindowsDownload.length).toBeLessThanOrEqual(1);
  });

  it("the download model stays free of project coupling", () => {
    const source = code(read("lib/platformDownloads.ts"));

    for (const banned of ["projectId", "buildJob", "GeneratedPosConfig", "BuildTarget"]) {
      expect(`platformDownloads.ts: ${source}`).not.toContain(banned);
    }
  });

  it("the requirement label is accurate and platform-level", () => {
    expect(WINDOWS_MIN_VERSION_LABEL).toBe("Windows 10 or newer · x64");
    expect(WINDOWS_MIN_VERSION_LABEL).not.toContain("Desktop");
  });
});

// ---------------------------------------------------------------------------
// Surfaces read one source
// ---------------------------------------------------------------------------

describe("no surface hardcodes a Windows URL or version", () => {
  const surfaces = [
    "components/landing/PlatformAvailability.tsx",
    "components/dashboard/AndroidAppCard.tsx",
    "components/devices/RunYourPosPanel.tsx",
  ];

  for (const surface of surfaces) {
    it(`${surface} reads the shared model only`, () => {
      const source = code(read(surface));

      expect(source).toContain("getPlatformDownloads");
      expect(source).not.toContain("CURRENT_WINDOWS_RELEASE");
      expect(source).not.toContain("windowsRelease");
      expect(source).not.toMatch(/href=["']https?:/);
      expect(source).not.toMatch(/\b\d+\.\d+\.\d+\b/);
    });
  }

  it("the row renders a link only for an available platform", () => {
    const row = code(read("components/platform/PlatformDownloadRow.tsx"));

    expect(row).toContain("isDownloadable(download) ? (");
    expect(row).toContain("href={download.release.downloadUrl}");
    expect(row).toContain('download.status === "coming_soon"');
    // Still no disabled control for the not-yet-built state.
    expect(row).not.toMatch(/<button[^>]*disabled/);
  });
});

// ---------------------------------------------------------------------------
// Signing and publication remain out
// ---------------------------------------------------------------------------

describe("nothing in this phase signs or publishes", () => {
  it("the shell configures no signing", () => {
    const shellPackage = read("windows-shell/package.json");

    for (const banned of [
      "certificateFile",
      "certificatePassword",
      "azureSignOptions",
      "signtool",
      "CSC_LINK",
      ".pfx",
    ]) {
      expect(`package.json: ${shellPackage}`).not.toContain(banned);
    }
  });

  it("the workflow publishes no GitHub Release and needs no secret", () => {
    // YAML comments need stripping too, or the workflow's own explanation of
    // why it does NOT need `contents: write` trips the guard checking for it.
    const raw = read(".github/workflows/windows-app.yml");
    const workflow = raw.replace(/^\s*#.*$/gm, "");

    expect(raw).toContain("permissions:\n  contents: read");

    // Feature 25.6 — the job now reads two PUBLIC client values so it can build
    // the device runtime before packaging. What must stay true is the scope of
    // this workflow: it uploads an artifact and publishes nothing.
    expect(workflow).not.toContain("contents: write");
    expect(workflow).not.toContain("gh release create");
    expect(workflow).not.toContain("softprops/action-gh-release");
    expect(workflow).not.toContain("GITHUB_TOKEN");

    // Scoped to what the job is GIVEN, not to any mention of the words. The
    // verify step deliberately names SUPABASE_SERVICE_ROLE_KEY as a banned
    // string to search the built bundle for — asserting on the whole file would
    // fail the guard that exists to prevent exactly this leak.
    for (const line of workflow.split("\n")) {
      if (!/\$\{\{\s*(secrets|vars)\./.test(line)) continue;

      expect(`workflow input: ${line.trim()}`).not.toContain("SERVICE_ROLE");
    }
  });

  it("no auto-updater was introduced", () => {
    const shellPackage = read("windows-shell/package.json");

    expect(shellPackage).not.toContain("electron-updater");
    expect(shellPackage).not.toContain("autoUpdater");
    expect(existsSync(join(repoRoot, "windows-shell/dev-app-update.yml"))).toBe(false);
  });
});
