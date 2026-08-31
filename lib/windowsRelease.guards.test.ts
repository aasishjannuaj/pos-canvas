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
  UNSIGNED_BADGE_LABEL,
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

describe("Windows is published as an unsigned full release", () => {
  it("CURRENT_WINDOWS_RELEASE holds the verified published values", () => {
    // Feature 25.7 — moved to 1.1.0. Every field was verified against the bytes
    // GitHub actually SERVES, not a local copy: downloaded from the public URL,
    // sha-256 computed locally, checked against the published .sha256 file, and
    // the size cross-checked with what the Releases API reports.
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

  it("it validates through the real guard", () => {
    expect(isWindowsRelease(CURRENT_WINDOWS_RELEASE)).toBe(true);
  });

  it("is published under the windows-v tag, never Android's", () => {
    const url = CURRENT_WINDOWS_RELEASE?.downloadUrl ?? "";

    expect(url).toContain("/releases/download/windows-v1.1.0/");
    expect(url).not.toMatch(/\/releases\/download\/v1\.1\.0\//);
  });

  it("points at the exact installer filename", () => {
    expect(CURRENT_WINDOWS_RELEASE?.downloadUrl.endsWith(
      "/POS-Canvas-Windows-v1.1.0.exe"
    )).toBe(true);
  });

  it("carries a 64-character lowercase sha-256", () => {
    expect(CURRENT_WINDOWS_RELEASE?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records the size of the SERVED artifact", () => {
    // Feature 25.7 — this is the byte count of the file downloaded from the
    // public URL, which also matches what the Releases API reports for the
    // asset. A local cross-build of the same commit differs in size, which is
    // how "was this really the CI artifact?" stays checkable.
    expect(CURRENT_WINDOWS_RELEASE?.fileSizeBytes).toBe(100260898);
    expect(CURRENT_WINDOWS_RELEASE?.fileSizeBytes).not.toBe(99637338);
  });

  it("records a valid release timestamp", () => {
    const at = CURRENT_WINDOWS_RELEASE?.releasedAt ?? "";

    expect(at).toBe("2026-08-31T18:12:54Z");
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
        "releases/download/windows-v1.1.0/POS-Canvas-Windows-v1.1.0.exe"
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
  it("the pre-release flag matches the GitHub release it describes", () => {
    // Feature 25.7 — windows-v1.1.0 was published with prerelease=false, so this
    // is now false. The original guard existed to stop the flag being flipped
    // quietly; it is re-anchored here rather than deleted, and the check below
    // records what that flip actually costs.
    expect(CURRENT_WINDOWS_RELEASE).not.toBeNull();
    expect(CURRENT_WINDOWS_RELEASE?.isPrerelease).toBe(false);
  });

  it("declares itself unsigned, because the build carries no signature", () => {
    // The claim must match the artifact: windows-shell has no signing config and
    // the workflow passes no certificate, so isUnsigned must be true. If signing
    // ever lands, this fails and is updated in the same change that publishes
    // the signed binary — the flag can never quietly outlive the fact.
    const shell = JSON.parse(read("windows-shell/package.json"));
    const win = (shell.build?.win ?? {}) as Record<string, unknown>;
    const signingKeys = Object.keys(win).filter(
      (k) => k.toLowerCase().includes("cert") || k.toLowerCase().includes("sign")
    );

    expect(signingKeys).toEqual([]);
    expect(CURRENT_WINDOWS_RELEASE?.isUnsigned).toBe(true);
  });

  it("1. a false pre-release flag does NOT hide the unsigned warning", () => {
    // THE REGRESSION. Publishing 1.1.0 as a full release is correct, and it
    // briefly deleted the only warning that the installer is unsigned.
    expect(CURRENT_WINDOWS_RELEASE?.isPrerelease).toBe(false);
    expect(CURRENT_WINDOWS_RELEASE?.isUnsigned).toBe(true);

    const row = read("components/platform/PlatformDownloadRow.tsx");

    expect(row).toContain("download.release.isUnsigned === true");
    expect(row).toContain("UNSIGNED_BADGE_LABEL");
  });

  it("2. a full release is never labelled Pre-release", () => {
    const download = getWindowsDownload();

    expect(isDownloadable(download) && download.release.isPrerelease).toBe(false);
    // The row gates that badge on === true, so false and undefined both hide it.
    expect(read("components/platform/PlatformDownloadRow.tsx")).toContain(
      "download.release.isPrerelease === true"
    );
  });

  it("3. the unsigned warning names the consequence a user will meet", () => {
    expect(UNSIGNED_BADGE_LABEL).toBe(
      "Unsigned · Windows may show a SmartScreen warning"
    );

    for (const overclaim of ["verified", "secure", "trusted", "safe", "official"]) {
      expect(`badge overclaims ${overclaim}`).toBe(`badge overclaims ${overclaim}`);
      expect(UNSIGNED_BADGE_LABEL.toLowerCase()).not.toContain(overclaim);
    }
  });

  it("4. Android's presentation is unchanged", () => {
    const android = getAndroidDownload();

    // Android is signed with the release keystore and is a full release, so it
    // declares neither flag and shows neither badge.
    expect(isDownloadable(android) && android.release.isPrerelease).toBeFalsy();
    expect(isDownloadable(android) && android.release.isUnsigned).toBeFalsy();
    expect(read("lib/androidRelease.ts")).not.toContain("isUnsigned");
    expect(read("lib/androidRelease.ts")).not.toContain("isPrerelease");
  });

  it("5. signing status is never derived from pre-release status", () => {
    const model = code(read("lib/platformDownloads.ts"));
    const row = code(read("components/platform/PlatformDownloadRow.tsx"));
    const info = code(read("lib/appInformation.ts"));

    // Nothing may compute one flag's VALUE from the other. Adjacency in an
    // object literal is not derivation — appInformation legitimately assigns
    // both, one per line, each from its own field — so this matches assignment
    // whose right-hand side mentions the other flag.
    for (const source of [model, row, info]) {
      expect(source).not.toMatch(/isUnsigned\s*[:=][^\n]*isPrerelease/);
      expect(source).not.toMatch(/isPrerelease\s*[:=][^\n]*isUnsigned/);
    }

    // And each is read from its own field.
    expect(row).toContain("download.release.isPrerelease === true");
    expect(row).toContain("download.release.isUnsigned === true");
  });

  it("6. the two flags are independent in the type and the validator", () => {
    const model = read("lib/platformRelease.ts");

    expect(model).toContain("isPrerelease?: boolean;");
    expect(model).toContain("isUnsigned?: boolean;");

    // All four combinations validate — neither implies nor excludes the other.
    for (const combo of [
      { isPrerelease: true, isUnsigned: true },
      { isPrerelease: true, isUnsigned: false },
      { isPrerelease: false, isUnsigned: true },
      { isPrerelease: false, isUnsigned: false },
    ]) {
      expect(`combo ${JSON.stringify(combo)}`).toBe(`combo ${JSON.stringify(combo)}`);
      expect(isWindowsRelease({ ...(HYPOTHETICAL as object), ...combo })).toBe(true);
    }

    // A non-boolean would silently mislabel the build.
    expect(
      isWindowsRelease({ ...(HYPOTHETICAL as object), isUnsigned: "yes" })
    ).toBe(false);
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
    expect(PRERELEASE_BADGE_LABEL).toBe("Pre-release");

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
      versionName: "1.1.0",
      versionCode: 2,
      downloadUrl:
        "https://github.com/aasishjannuaj/pos-canvas/releases/download/v1.1.0/POS-Canvas-v1.1.0.apk",
      checksum: "00763a36d8ddcba676ec0f0afec477a2784579c0d9968b28eaaea91510af1df1",
      fileSizeBytes: 4121584,
      releasedAt: "2026-08-31T18:03:31Z",
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

    expect(url).toContain("/releases/download/v1.1.0/");
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
