// Feature 20 — the Android APK release contract.
//
// WHAT THIS IS FOR: describing the ONE universal signed APK that owners
// download and sideload onto a till. It is what a future Downloads page, or a
// future update check, would read.
//
// WHAT IT IS DELIBERATELY NOT COUPLED TO: build_jobs. That table models
// PER-PROJECT configuration generation — it produces `json_config` artifacts
// containing a GeneratedPosConfig, one per project per build. The APK is
// universal: it contains no project id, no configuration and no branding, and
// is byte-identical for every customer. A till becomes a specific business's
// till through PAIRING, at runtime, not through the binary it runs. Modelling
// the APK as a build_jobs row would conflate two unrelated lifecycles and imply
// a per-customer APK that this product deliberately does not have.
//
// Dependency-free (no React, no Supabase, no node builtins), so the same
// validation runs in a server component, in the browser, and under Vitest.

/**
 * A published Android release.
 *
 * Every field describes a real, existing binary. There is no partially-known
 * state: a release either exists and all of this is knowable, or it does not
 * exist yet and the value is null (see CURRENT_ANDROID_RELEASE).
 */
export type AndroidRelease = {
  /** User-facing, e.g. "1.0.0". Matches versionName in android/app/build.gradle. */
  versionName: string;
  /**
   * Strictly increasing integer. Matches versionCode in build.gradle.
   *
   * Android refuses to install an APK whose versionCode is lower than the
   * installed one, so this is what actually orders releases — versionName is
   * only a label.
   */
  versionCode: number;
  /** The GitHub Release asset URL for the signed APK. */
  downloadUrl: string;
  /** Lowercase sha-256 hex of the APK file, matching build_artifacts.checksum. */
  checksum: string;
  fileSizeBytes: number;
  /** ISO 8601. */
  releasedAt: string;
};

/**
 * The current published release, or null when none exists yet.
 *
 * NULL IS THE HONEST VALUE RIGHT NOW, and this is deliberate. Feature 20
 * establishes the release CONFIGURATION; no keystore exists yet, so no signed
 * APK exists, so there is no download URL, no checksum, no file size and no
 * release date. Inventing plausible-looking values would produce a Downloads
 * link that 404s and a checksum that can never match — worse than an honest
 * "no release yet", which a caller can render as such.
 *
 * Populated by hand, in a normal reviewable commit, once the first signed APK
 * has been built, verified and uploaded to GitHub Releases.
 */
export const CURRENT_ANDROID_RELEASE: AndroidRelease | null = null;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * Structural guard for a release record.
 *
 * Rejects rather than coerces, matching lib/completedSale.ts: a malformed
 * release would hand a customer a broken or unverifiable download, which is
 * worse than showing nothing.
 */
export function isAndroidRelease(value: unknown): value is AndroidRelease {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const release = value as Record<string, unknown>;

  return (
    typeof release.versionName === "string" &&
    SEMVER.test(release.versionName) &&
    typeof release.versionCode === "number" &&
    Number.isInteger(release.versionCode) &&
    release.versionCode > 0 &&
    typeof release.downloadUrl === "string" &&
    isHttpsUrl(release.downloadUrl) &&
    typeof release.checksum === "string" &&
    SHA256_HEX.test(release.checksum) &&
    typeof release.fileSizeBytes === "number" &&
    Number.isInteger(release.fileSizeBytes) &&
    release.fileSizeBytes > 0 &&
    typeof release.releasedAt === "string" &&
    !Number.isNaN(new Date(release.releasedAt).getTime())
  );
}

/** A download must be https: an APK served over cleartext is trivially swapped. */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Formats a byte count for a download button, e.g. "4.2 MB".
 *
 * Presentation only — fileSizeBytes stays the authority, and the checksum is
 * what actually verifies a download.
 */
export function formatReleaseSize(fileSizeBytes: number): string {
  if (!Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0) {
    return "";
  }

  const megabytes = fileSizeBytes / (1024 * 1024);

  return megabytes >= 1
    ? `${megabytes.toFixed(1)} MB`
    : `${Math.max(1, Math.round(fileSizeBytes / 1024))} KB`;
}
