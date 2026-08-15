// Feature 20 — behavioral tests for the Android release metadata contract.
import { describe, expect, it } from "vitest";
import {
  ANDROID_MIN_SDK,
  ANDROID_MIN_VERSION_LABEL,
  CURRENT_ANDROID_RELEASE,
  formatReleaseSize,
  isAndroidRelease,
} from "@/lib/androidRelease";
import type { AndroidRelease } from "@/lib/androidRelease";

const VALID: AndroidRelease = {
  versionName: "1.0.0",
  versionCode: 1,
  downloadUrl:
    "https://github.com/aasishjannu4/pos-canvas/releases/download/android-v1.0.0/pos-canvas-1.0.0.apk",
  checksum: "a".repeat(64),
  fileSizeBytes: 4_400_000,
  releasedAt: "2026-08-14T10:00:00.000Z",
};

// ---------------------------------------------------------------------------
// Feature 21 — the FIRST published release.
//
// Every value asserted here was verified against the real artifact: the GitHub
// Releases API supplied the tag, asset name, size and published_at; the APK was
// downloaded and hashed locally; aapt2 and apksigner confirmed the package,
// version and signer certificate. These tests pin that verification so a later
// edit cannot quietly point owners at a different or unverified binary.
// ---------------------------------------------------------------------------

const PUBLISHED_CHECKSUM =
  "aded13d8db6eaed8a4fdeb5e56cf1a12036df24b64f54eec8f98ff2feb910125";

describe("CURRENT_ANDROID_RELEASE — the published v1.0.0 release", () => {
  it("is no longer null", () => {
    expect(CURRENT_ANDROID_RELEASE).not.toBeNull();
  });

  it("passes its own validator", () => {
    expect(isAndroidRelease(CURRENT_ANDROID_RELEASE)).toBe(true);
  });

  it("is version 1.0.0 / code 1", () => {
    expect(CURRENT_ANDROID_RELEASE?.versionName).toBe("1.0.0");
    expect(CURRENT_ANDROID_RELEASE?.versionName).toMatch(/^\d+\.\d+\.\d+$/);
    expect(CURRENT_ANDROID_RELEASE?.versionCode).toBe(1);
  });

  it("downloads over https from GitHub Releases", () => {
    const url = new URL(CURRENT_ANDROID_RELEASE!.downloadUrl);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("github.com");
    expect(url.pathname).toContain("/aasishjannuaj/pos-canvas/releases/download/");
  });

  it("targets the VERIFIED tag v1.0.0", () => {
    // Confirmed against the GitHub API after the release was re-tagged: this
    // URL serves the APK, and the earlier `v.1.0.0` form now returns 404.
    expect(CURRENT_ANDROID_RELEASE!.downloadUrl).toContain("/download/v1.0.0/");
  });

  it("carries no trace of the retired v.1.0.0 tag", () => {
    // Belt and braces. The assertion above already excludes the stray-dot form
    // (`/download/v.1.0.0/` does not contain `/download/v1.0.0/`), but stating
    // the retired tag by name makes the intent legible to the next reader and
    // catches it anywhere else in the URL.
    expect(CURRENT_ANDROID_RELEASE!.downloadUrl).not.toContain("v.1.0.0");
  });

  it("names the published asset exactly", () => {
    expect(CURRENT_ANDROID_RELEASE!.downloadUrl.endsWith("/POS-Canvas-v1.0.0.apk")).toBe(
      true
    );
  });

  it("carries the approved checksum, byte for byte", () => {
    // Matches both the locally computed sha-256 of the downloaded APK and
    // GitHub's own recorded asset digest.
    expect(CURRENT_ANDROID_RELEASE?.checksum).toBe(PUBLISHED_CHECKSUM);
  });

  it("records the real published file size", () => {
    expect(CURRENT_ANDROID_RELEASE?.fileSizeBytes).toBe(3169762);
    expect(CURRENT_ANDROID_RELEASE!.fileSizeBytes).toBeGreaterThan(0);
  });

  it("records the real GitHub publish timestamp", () => {
    expect(CURRENT_ANDROID_RELEASE?.releasedAt).toBe("2026-08-14T23:52:46Z");
    expect(Number.isNaN(new Date(CURRENT_ANDROID_RELEASE!.releasedAt).getTime())).toBe(
      false
    );
  });

  it("states only the device requirement the APK actually declares", () => {
    // minSdkVersion 24 was read from the published binary, not chosen.
    expect(ANDROID_MIN_SDK).toBe(24);
    expect(ANDROID_MIN_VERSION_LABEL).toBe("Android 7.0 or newer");
  });

  it("formats its size for display", () => {
    expect(formatReleaseSize(CURRENT_ANDROID_RELEASE!.fileSizeBytes)).toBe("3.0 MB");
  });
});

describe("isAndroidRelease", () => {
  it("accepts a well-formed release", () => {
    expect(isAndroidRelease(VALID)).toBe(true);
  });

  it("rejects a non-object", () => {
    for (const bad of [null, undefined, "", 0, [], "release"]) {
      expect(isAndroidRelease(bad)).toBe(false);
    }
  });

  it("requires a semver-like versionName", () => {
    for (const versionName of ["1.0", "v1.0.0", "1", "", "1.0.0-beta", "latest"]) {
      expect(isAndroidRelease({ ...VALID, versionName })).toBe(false);
    }
  });

  it("requires a positive integer versionCode", () => {
    // Android orders releases by this value and refuses to install a lower one
    // over a higher one, so a non-integer or zero is meaningless.
    for (const versionCode of [0, -1, 1.5, NaN, Infinity, "1"]) {
      expect(isAndroidRelease({ ...VALID, versionCode })).toBe(false);
    }
  });

  it("requires an https download URL", () => {
    // An APK served over cleartext can be swapped in transit for one signed by
    // an attacker's key.
    for (const downloadUrl of [
      "http://example.com/app.apk",
      "ftp://example.com/app.apk",
      "/relative/app.apk",
      "not a url",
      "",
    ]) {
      expect(isAndroidRelease({ ...VALID, downloadUrl })).toBe(false);
    }
  });

  it("requires a lowercase sha-256 checksum", () => {
    for (const checksum of ["", "abc", "A".repeat(64), "g".repeat(64), "a".repeat(63)]) {
      expect(isAndroidRelease({ ...VALID, checksum })).toBe(false);
    }
  });

  it("requires a positive integer file size", () => {
    for (const fileSizeBytes of [0, -1, 1.5, NaN, "4400000"]) {
      expect(isAndroidRelease({ ...VALID, fileSizeBytes })).toBe(false);
    }
  });

  it("requires a parseable releasedAt", () => {
    for (const releasedAt of ["", "not-a-date", "13/45/2026"]) {
      expect(isAndroidRelease({ ...VALID, releasedAt })).toBe(false);
    }
  });

  it("rejects a partially filled record", () => {
    for (const key of Object.keys(VALID) as (keyof AndroidRelease)[]) {
      const partial = { ...VALID };
      delete partial[key];
      expect(isAndroidRelease(partial)).toBe(false);
    }
  });
});

describe("formatReleaseSize", () => {
  it("formats megabytes to one decimal", () => {
    expect(formatReleaseSize(4_400_000)).toBe("4.2 MB");
    expect(formatReleaseSize(1024 * 1024)).toBe("1.0 MB");
  });

  it("falls back to kilobytes below a megabyte", () => {
    expect(formatReleaseSize(512 * 1024)).toBe("512 KB");
    expect(formatReleaseSize(2048)).toBe("2 KB");
  });

  it("never reports zero KB for a tiny non-zero file", () => {
    expect(formatReleaseSize(1)).toBe("1 KB");
  });

  it("returns an empty string for a nonsensical size", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(formatReleaseSize(bad)).toBe("");
    }
  });
});
