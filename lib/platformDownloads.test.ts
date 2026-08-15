// Feature 22 Phase 3 — behavioral tests for the platform download model.
//
// The property that matters most is negative: a coming-soon platform must have
// no way to carry a download URL. The type system enforces it at compile time;
// these assert it at runtime too, because a `as any` cast or a JSON round trip
// would slip past the compiler.
import { describe, expect, it } from "vitest";
import {
  WINDOWS_DOWNLOAD,
  getAndroidDownload,
  getPlatformDownloads,
  isDownloadable,
} from "@/lib/platformDownloads";
import { CURRENT_ANDROID_RELEASE } from "@/lib/androidRelease";
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

describe("Windows is coming soon and cannot carry a download", () => {
  it("is always coming_soon in this feature", () => {
    expect(WINDOWS_DOWNLOAD.status).toBe("coming_soon");
    expect(WINDOWS_DOWNLOAD.platform).toBe("windows");
  });

  it("has NO url, href or release field of any kind", () => {
    // The central invariant. Windows ships in Feature 23; until then there is
    // nothing to download and nowhere to put a link.
    const keys = Object.keys(WINDOWS_DOWNLOAD);

    expect(keys).toEqual(["platform", "status", "label", "description"]);
    for (const banned of ["release", "downloadUrl", "url", "href", "checksum"]) {
      expect(keys).not.toContain(banned);
    }
  });

  it("carries no URL-shaped value in any field", () => {
    // Belt and braces: not merely "no url key", but no url anywhere.
    const serialized = JSON.stringify(WINDOWS_DOWNLOAD);

    expect(serialized).not.toContain("http");
    expect(serialized).not.toContain(".exe");
    expect(serialized).not.toContain(".msi");
    expect(serialized).not.toContain("github");
  });

  it("is never downloadable", () => {
    expect(isDownloadable(WINDOWS_DOWNLOAD)).toBe(false);
  });

  it("describes the same universal app, not a different product", () => {
    expect(WINDOWS_DOWNLOAD.description).toBe("POS Canvas for Windows");
  });
});

describe("the platform list", () => {
  it("offers Android then Windows", () => {
    expect(getPlatformDownloads().map((d) => d.platform)).toEqual([
      "android",
      "windows",
    ]);
  });

  it("shows Windows as coming soon even when Android is unavailable", () => {
    const [android, windows] = getPlatformDownloads(null);

    expect(android.status).toBe("unavailable");
    expect(windows.status).toBe("coming_soon");
  });

  it("contains exactly one downloadable platform today", () => {
    expect(getPlatformDownloads().filter(isDownloadable)).toHaveLength(1);
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
