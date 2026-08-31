// Feature 23.6 — the fields every published platform release shares.
//
// WHY A BASE TYPE RATHER THAN TWO INDEPENDENT SHAPES: the download row renders
// a version, a size and a URL identically for every platform, and
// `AvailablePlatformDownload` has to carry exactly one release type. Before this
// it carried `AndroidRelease`, which meant a Windows release could not be
// represented at all without either widening that field to a union (and pushing
// a narrowing decision into every consumer) or duplicating the row.
//
// WHY `versionCode` IS NOT HERE: it is an Android install-ordering rule —
// Android refuses to install an APK whose versionCode is lower than the
// installed one. Windows has no equivalent; NSIS compares version strings. A
// field that means something on one platform and nothing on the other belongs to
// the platform that needs it, so AndroidRelease extends this base with it and
// WindowsRelease uses the base as-is.
//
// Dependency-free (no React, no Supabase, no node builtins) so the same
// validation runs in a server component, in the browser, and under Vitest.

/**
 * A published, downloadable binary.
 *
 * Every field describes a real artifact that exists at a real URL. There is no
 * partially-known state: a release either exists and all of this is verifiable,
 * or it does not exist and the value is null.
 */
export type PlatformRelease = {
  /** User-facing, e.g. "1.0.0". */
  versionName: string;
  /** The GitHub Release asset URL. */
  downloadUrl: string;
  /** Lowercase sha-256 hex of the published file. */
  checksum: string;
  fileSizeBytes: number;
  /** ISO 8601. */
  releasedAt: string;
  /**
   * Feature 23.6 — true for a development build published before the product's
   * public launch.
   *
   * OPTIONAL, AND ABSENT MEANS STABLE. Making it required would have meant
   * editing CURRENT_ANDROID_RELEASE to add `isPrerelease: false`, and Android's
   * published release is deliberately untouched by this feature. Absent is the
   * safe default in the direction that matters: a release is only ever labelled
   * pre-release when someone says so explicitly.
   *
   * It exists so the three download surfaces render the same qualifier from one
   * place instead of hardcoding the same sentence three times.
   */
  isPrerelease?: boolean;
  /**
   * Feature 25.7 — true when the published binary carries no code signature.
   *
   * A SEPARATE FACT FROM `isPrerelease`, and separated because conflating them
   * caused a real regression. 1.0.0 was an unsigned pre-release, so one flag
   * carried both meanings and one badge said both things. When 1.1.0 shipped as
   * a full release, setting `isPrerelease: false` was correct — GitHub says
   * prerelease=false — and it silently removed the only warning that the
   * installer is unsigned. The installer had not changed at all.
   *
   * The two vary independently: a release can be stable-and-unsigned (Windows
   * 1.1.0 today), pre-release-and-unsigned (Windows 1.0.0), or stable-and-signed
   * (Android, which is signed with the release keystore). Nothing may derive one
   * from the other again.
   *
   * OPTIONAL, AND ABSENT MEANS SIGNED — the same shape as `isPrerelease`, where
   * the badge appears only when someone says so explicitly. Android omits it and
   * is unaffected. A guard asserts the current Windows release declares it, so
   * the field cannot be dropped by accident while the build is still unsigned.
   */
  isUnsigned?: boolean;
};

/**
 * The qualifier shown beside a pre-release download.
 *
 * Feature 25.7 — this used to read "Pre-release · Unsigned build", carrying two
 * independent facts in one string. It now says only what its own flag means, so
 * a stable-but-unsigned release gets the unsigned warning and no misleading
 * "Pre-release", and a pre-release that is eventually signed loses the unsigned
 * warning without losing this one.
 */
export const PRERELEASE_BADGE_LABEL = "Pre-release";

/**
 * The qualifier shown beside a download with no code signature.
 *
 * Deliberately short and plain. It has to be honest — Windows will say so in its
 * own way, and an owner who is not warned first will read SmartScreen as the app
 * being broken — without being the kind of developer jargon that makes them
 * afraid to install it. It names the consequence they will actually see.
 *
 * It must never be softened into a claim this build cannot support: nothing here
 * says "verified", "securely signed" or "trusted publisher", because none of
 * that is true yet.
 */
export const UNSIGNED_BADGE_LABEL =
  "Unsigned · Windows may show a SmartScreen warning";

export const SHA256_HEX = /^[0-9a-f]{64}$/;
export const SEMVER = /^\d+\.\d+\.\d+$/;

/** A download must be https: a binary served over cleartext is trivially swapped. */
export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Structural guard for the shared fields.
 *
 * Rejects rather than coerces, matching lib/completedSale.ts: a malformed
 * release would hand a customer a broken or unverifiable download, which is
 * worse than showing nothing.
 */
export function isPlatformRelease(value: unknown): value is PlatformRelease {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const release = value as Record<string, unknown>;

  return (
    typeof release.versionName === "string" &&
    SEMVER.test(release.versionName) &&
    typeof release.downloadUrl === "string" &&
    isHttpsUrl(release.downloadUrl) &&
    typeof release.checksum === "string" &&
    SHA256_HEX.test(release.checksum) &&
    typeof release.fileSizeBytes === "number" &&
    Number.isInteger(release.fileSizeBytes) &&
    release.fileSizeBytes > 0 &&
    typeof release.releasedAt === "string" &&
    !Number.isNaN(new Date(release.releasedAt).getTime()) &&
    // Optional, but if present it must be a real boolean — a truthy string
    // would silently label a stable release as pre-release, or worse, fail to
    // label a pre-release one.
    (release.isPrerelease === undefined || typeof release.isPrerelease === "boolean") &&
    (release.isUnsigned === undefined || typeof release.isUnsigned === "boolean")
  );
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
