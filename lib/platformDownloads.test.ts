// Feature 22 Phase 3 — behavioral tests for the platform download model.
//
// The property that matters most is negative: a coming-soon platform must have
// no way to carry a download URL. The type system enforces it at compile time;
// these assert it at runtime too, because a `as any` cast or a JSON round trip
// would slip past the compiler.
import { describe, expect, it } from "vitest";
import {
  getWindowsDownload,
  getAndroidDownload,
  getPlatformDownloads,
  isDownloadable,
} from "@/lib/platformDownloads";
import { CURRENT_ANDROID_RELEASE } from "@/lib/androidRelease";
import { CURRENT_WINDOWS_RELEASE } from "@/lib/windowsRelease";
import type { AndroidRelease } from "@/lib/androidRelease";

const FAKE_RELEASE: AndroidRelease = {
  versionName: "9.9.9",
  versionCode: 99,
  downloadUrl: "https://github.com/example/repo/releases/download/v9.9.9/app.apk",
  checksum: "f".repeat(64),
  fileSizeBytes: 1_234_567,
  releasedAt: "2026-01-01T00:00:00Z",
};

describe("Android availability derives from the release metadata", () => {
  it("is available when a release exists", () => {
    const android = getAndroidDownload(FAKE_RELEASE);

    expect(android.status).toBe("available");
    expect(isDownloadable(android)).toBe(true);
  });

  it("carries the release itself rather than a copied URL or version", () => {
    // One source of truth: a duplicated string here could drift from the
    // published artifact without anything noticing.
    const android = getAndroidDownload(FAKE_RELEASE);

    expect(isDownloadable(android) && android.release).toBe(FAKE_RELEASE);
    expect(isDownloadable(android) && android.release.downloadUrl).toBe(
      FAKE_RELEASE.downloadUrl
    );
  });

  it("is UNAVAILABLE when no release is published", () => {
    const android = getAndroidDownload(null);

    expect(android.status).toBe("unavailable");
    expect(isDownloadable(android)).toBe(false);
  });

  it("exposes no release object at all when unavailable", () => {
    // Half-known state must not be renderable as a link.
    expect(Object.keys(getAndroidDownload(null))).not.toContain("release");
  });

  it("uses the real published release by default", () => {
    const android = getAndroidDownload();

    expect(android.status).toBe("available");
    expect(isDownloadable(android) && android.release).toEqual(
      CURRENT_ANDROID_RELEASE
    );
  });

  it("states the Android version requirement", () => {
    const android = getAndroidDownload(FAKE_RELEASE);
    expect(isDownloadable(android) && android.requirement).toBe(
      "Android 7.0 or newer"
    );
  });
});

describe("Windows carries a download only when a real release exists", () => {
  // Feature 23.6 replaced the hardcoded coming-soon constant with
  // getWindowsDownload(release). The invariant it protected is unchanged and is
  // now asserted against the null branch: no release, no URL, nowhere to put one.
  const comingSoon = getWindowsDownload(null);

  it("is coming_soon while no release is published", () => {
    expect(comingSoon.status).toBe("coming_soon");
    expect(comingSoon.platform).toBe("windows");
  });

  it("has NO url, href or release field of any kind", () => {
    const keys = Object.keys(comingSoon);

    expect(keys).toEqual(["platform", "status", "label", "description"]);
    for (const banned of ["release", "downloadUrl", "url", "href", "checksum"]) {
      expect(keys).not.toContain(banned);
    }
  });

  it("carries no URL-shaped value in any field", () => {
    // Belt and braces: not merely "no url key", but no url anywhere.
    const serialized = JSON.stringify(comingSoon);

    expect(serialized).not.toContain("http");
    expect(serialized).not.toContain(".exe");
    expect(serialized).not.toContain(".msi");
    expect(serialized).not.toContain("github");
  });

  it("is never downloadable while null", () => {
    expect(isDownloadable(comingSoon)).toBe(false);
  });

  it("describes the same universal app, not a different product", () => {
    expect(comingSoon.description).toBe("POS Canvas for Windows");
  });

  it("is available today, from the published pre-release", () => {
    // The live default. Feature 23.6 published windows-v1.0.0, so every surface
    // now renders a real download — and it is labelled as an unsigned
    // pre-release, because it is one.
    const live = getWindowsDownload();

    expect(live.status).toBe("available");
    expect(CURRENT_WINDOWS_RELEASE).not.toBeNull();
    expect(isDownloadable(live) && live.release.isPrerelease).toBe(true);
  });

  it("becomes a real download when a verified release is supplied", () => {
    const release = {
      versionName: "1.0.0",
      downloadUrl:
        "https://github.com/aasishjannuaj/pos-canvas/releases/download/windows-v1.0.0/POS-Canvas-Windows-v1.0.0.exe",
      checksum: "a".repeat(64),
      fileSizeBytes: 99637032,
      releasedAt: "2026-08-15T20:00:00Z",
    };

    const download = getWindowsDownload(release);

    expect(download.status).toBe("available");
    expect(isDownloadable(download)).toBe(true);
    expect(isDownloadable(download) && download.release.downloadUrl).toBe(
      release.downloadUrl
    );
    expect(isDownloadable(download) && download.requirement).toBe(
      "Windows 10 or newer \u00b7 x64"
    );
  });

  it("restates no version or URL of its own", () => {
    // Everything renderable comes from the release object, so a surface can
    // never disagree with the published artifact.
    const release = {
      versionName: "2.5.1",
      downloadUrl:
        "https://github.com/aasishjannuaj/pos-canvas/releases/download/windows-v2.5.1/POS-Canvas-Windows-v2.5.1.exe",
      checksum: "b".repeat(64),
      fileSizeBytes: 1234,
      releasedAt: "2026-09-01T00:00:00Z",
    };

    const download = getWindowsDownload(release);
    expect(isDownloadable(download) && download.release).toBe(release);
  });
});

describe("the platform list", () => {
  it("offers Android then Windows", () => {
    expect(getPlatformDownloads().map((d) => d.platform)).toEqual([
      "android",
      "windows",
    ]);
  });

  it("keeps the two platforms independent", () => {
    // Android unavailable must not affect Windows, and vice versa: they are
    // separate binaries on separate release lines.
    const [android, windows] = getPlatformDownloads(null);

    expect(android.status).toBe("unavailable");
    expect(windows.status).toBe("available");

    const [android2, windows2] = getPlatformDownloads(CURRENT_ANDROID_RELEASE, null);

    expect(android2.status).toBe("available");
    expect(windows2.status).toBe("coming_soon");
  });

  it("both platforms are downloadable today", () => {
    expect(getPlatformDownloads().filter(isDownloadable)).toHaveLength(2);
  });
});

describe("the app download is universal, never project-derived", () => {
  it("takes no project, build, or pairing input", () => {
    // getPlatformDownloads' only parameter is an optional release override for
    // tests. There is nowhere to pass a project id.
    expect(getPlatformDownloads.length).toBeLessThanOrEqual(1);
    expect(getAndroidDownload.length).toBeLessThanOrEqual(1);
  });

  it("returns the same URL regardless of how many times it is called", () => {
    const first = getPlatformDownloads()[0];
    const second = getPlatformDownloads()[0];

    expect(isDownloadable(first) && first.release.downloadUrl).toBe(
      isDownloadable(second) && second.release.downloadUrl
    );
  });

  it("serializes no project or build identifier", () => {
    const serialized = JSON.stringify(getPlatformDownloads());

    for (const banned of ["projectId", "project_id", "buildJob", "build_job", "artifact"]) {
      expect(serialized).not.toContain(banned);
    }
  });
});
