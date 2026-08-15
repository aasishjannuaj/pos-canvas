// Feature 22 Phase 3 — the platforms the universal POS Canvas app runs on.
//
// ONE APP, EVERY CUSTOMER. Nothing in this module takes a project id, a build
// id, or any project-derived value, and there is nowhere to put one. That is
// the whole point: publishing freezes a project's business configuration, while
// the POS Canvas app is a single universal binary that becomes a specific
// business's till by PAIRING at runtime. Three surfaces render this model
// (landing, dashboard, editor) and all three read exactly the same values.
//
// WHY A DISCRIMINATED UNION RATHER THAN A `status` FLAG ON ONE SHAPE:
// a shared shape would carry an optional `release`/`downloadUrl` on every
// platform, which means a Windows entry could be given a URL by a one-line
// edit and nothing would complain. Here `coming_soon` has no such field to
// assign — a fake Windows download is not discouraged, it is unrepresentable.
// Windows ships for real in Feature 23; until then it is a roadmap statement.
//
// Dependency-free (no React, no Supabase, no process.env) so the model is
// unit-testable and identical on the server and in the browser.
import { CURRENT_ANDROID_RELEASE, ANDROID_MIN_VERSION_LABEL } from "@/lib/androidRelease";
import type { AndroidRelease } from "@/lib/androidRelease";

export type PlatformId = "android" | "windows";

/**
 * A platform whose app can be downloaded right now.
 *
 * Carries the release itself rather than a copied URL/version, so there is one
 * source of truth (lib/androidRelease.ts) and no opportunity for a stale
 * duplicate to drift out of sync with the published artifact.
 */
export type AvailablePlatformDownload = {
  platform: PlatformId;
  status: "available";
  label: string;
  description: string;
  /** Extra reassurance under the button, e.g. the minimum OS version. */
  requirement: string;
  release: AndroidRelease;
};

/**
 * A platform whose app exists but cannot currently be offered.
 *
 * Reached when CURRENT_ANDROID_RELEASE is null — between releases, or before
 * the first one. Deliberately has no `release`, so a caller cannot render a
 * link from a half-known state.
 */
export type UnavailablePlatformDownload = {
  platform: PlatformId;
  status: "unavailable";
  label: string;
  description: string;
};

/**
 * A platform that is announced but not yet built.
 *
 * NO `release`, NO `downloadUrl`, NO `href`. Adding one is a type error, which
 * is exactly the protection this variant exists to provide.
 */
export type ComingSoonPlatformDownload = {
  platform: PlatformId;
  status: "coming_soon";
  label: string;
  description: string;
};

export type PlatformDownload =
  | AvailablePlatformDownload
  | UnavailablePlatformDownload
  | ComingSoonPlatformDownload;

const ANDROID_LABEL = "Android";
const WINDOWS_LABEL = "Windows";

/**
 * Android, derived entirely from the published release metadata.
 *
 * The version and download URL are never restated here — they come from
 * CURRENT_ANDROID_RELEASE, which Feature 21 verified against the real GitHub
 * artifact. A null release yields the `unavailable` variant rather than a
 * broken link.
 */
export function getAndroidDownload(
  release: AndroidRelease | null = CURRENT_ANDROID_RELEASE
): AvailablePlatformDownload | UnavailablePlatformDownload {
  if (release === null) {
    return {
      platform: "android",
      status: "unavailable",
      label: ANDROID_LABEL,
      description: "POS Canvas for Android",
    };
  }

  return {
    platform: "android",
    status: "available",
    label: ANDROID_LABEL,
    description: "POS Canvas for Android",
    requirement: ANDROID_MIN_VERSION_LABEL,
    release,
  };
}

/**
 * Windows — announced, not built.
 *
 * A plain constant rather than a function: there is no input that could change
 * the answer while Feature 23 is outstanding, and a function would invite a
 * future parameter that made it conditional.
 */
export const WINDOWS_DOWNLOAD: ComingSoonPlatformDownload = {
  platform: "windows",
  status: "coming_soon",
  label: WINDOWS_LABEL,
  description: "POS Canvas for Windows",
};

/**
 * Every platform, in the order the UI shows them.
 *
 * Android first because it is the one an owner can act on today.
 */
export function getPlatformDownloads(
  release: AndroidRelease | null = CURRENT_ANDROID_RELEASE
): PlatformDownload[] {
  return [getAndroidDownload(release), WINDOWS_DOWNLOAD];
}

/**
 * Narrowing helper — the only sanctioned way to reach a download URL.
 *
 * Callers that ask "can I render a link?" get a typed yes/no instead of
 * reaching for an optional field that may not exist, so a coming-soon platform
 * can never reach an <a href>.
 */
export function isDownloadable(
  download: PlatformDownload
): download is AvailablePlatformDownload {
  return download.status === "available";
}
