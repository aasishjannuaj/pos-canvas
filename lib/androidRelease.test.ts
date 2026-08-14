// Feature 20 — behavioral tests for the Android release metadata contract.
import { describe, expect, it } from "vitest";
import {
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

describe("CURRENT_ANDROID_RELEASE", () => {
  it("is null until a real signed APK exists", () => {
    // Feature 20 stops before keystore creation, so there is no binary to
    // describe. A fabricated URL would 404 and a fabricated checksum could
    // never match — null is the only honest value.
    expect(CURRENT_ANDROID_RELEASE).toBeNull();
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
