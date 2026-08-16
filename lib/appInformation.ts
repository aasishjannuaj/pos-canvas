// Feature 24.1 — what the About panel shows.
//
// WHY THIS COMPOSES RATHER THAN RESTATES: the version, the OS requirement and
// the availability of each platform already exist, verified, in
// lib/androidRelease.ts and lib/windowsRelease.ts, and are already shaped for
// rendering by lib/platformDownloads.ts. Copying any of it here would create a
// second place to update at release time and a second place to get wrong — the
// exact failure the shared platform model was built to prevent.
//
// So this module owns nothing but the composition: identity from lib/brand.ts,
// availability from the platform model. It has no values of its own to drift.
//
// WHAT IT DELIBERATELY DOES NOT EXPOSE: Supabase, Electron, Capacitor, Vercel,
// GitHub, build jobs, or the application id. Those are true, and none of them
// help an owner. The one internal-sounding thing it does surface is the
// pre-release status of a platform, because that changes what the owner should
// expect when they install it.
import { BRAND, BRAND_APP_SUMMARY } from "@/lib/brand";
import { getPlatformDownloads, isDownloadable } from "@/lib/platformDownloads";
import type { PlatformDownload } from "@/lib/platformDownloads";

export type AppPlatformInformation = {
  /** "Android" / "Windows", from the shared model. */
  label: string;
  /** "1.0.0", or null when nothing is published for that platform. */
  versionName: string | null;
  /** "Android 7.0 or newer", or null when unavailable. */
  requirement: string | null;
  /** True while the published build is a development pre-release. */
  isPrerelease: boolean;
};

export type AppInformation = {
  productName: string;
  companyDisplayName: string;
  summary: string;
  /**
   * Null until a legal entity exists. A consumer must render nothing rather
   * than a placeholder — see BRAND.legalCompanyName.
   */
  legalCompanyName: string | null;
  platforms: AppPlatformInformation[];
};

function toPlatformInformation(download: PlatformDownload): AppPlatformInformation {
  if (!isDownloadable(download)) {
    return {
      label: download.label,
      versionName: null,
      requirement: null,
      isPrerelease: false,
    };
  }

  return {
    label: download.label,
    versionName: download.release.versionName,
    requirement: download.requirement,
    isPrerelease: download.release.isPrerelease === true,
  };
}

/**
 * Everything the About panel needs, derived from sources that already exist.
 *
 * Takes the platform list as a parameter (defaulting to the live one) purely so
 * the composition can be unit-tested against known releases without reaching
 * into module state.
 */
export function getAppInformation(
  downloads: PlatformDownload[] = getPlatformDownloads()
): AppInformation {
  return {
    productName: BRAND.productName,
    companyDisplayName: BRAND.companyDisplayName,
    summary: BRAND_APP_SUMMARY,
    legalCompanyName: BRAND.legalCompanyName,
    platforms: downloads.map(toPlatformInformation),
  };
}
