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
//
// Feature 23.6 — the fields Android shares with every other platform now live in
// lib/platformRelease.ts, so the download row can render a Windows release
// through the same contract. Nothing about Android's own values changed.
import { isPlatformRelease } from "@/lib/platformRelease";
import type { PlatformRelease } from "@/lib/platformRelease";

/**
 * A published Android release.
 *
 * Every field describes a real, existing binary. There is no partially-known
 * state: a release either exists and all of this is knowable, or it does not
 * exist yet and the value is null (see CURRENT_ANDROID_RELEASE).
 */
export type AndroidRelease = PlatformRelease & {
  /**
   * Strictly increasing integer. Matches versionCode in build.gradle.
   *
   * Android refuses to install an APK whose versionCode is lower than the
   * installed one, so this is what actually orders releases — versionName is
   * only a label. Windows has no equivalent, which is why this field stays here
   * rather than in the shared PlatformRelease base.
   */
  versionCode: number;
};

/**
 * The current published release, or null when none exists yet.
 *
 * Feature 21 — populated with the first real signed release. Every value below
 * was VERIFIED against the published artifact rather than transcribed:
 *
 *   - the GitHub Releases API was queried for the actual tag and asset;
 *   - the APK was downloaded and its sha-256 computed locally (it matches both
 *     the approved checksum and GitHub's own recorded digest);
 *   - fileSizeBytes is the byte count of that downloaded file;
 *   - releasedAt is the release's published_at from the API;
 *   - aapt2 confirmed package com.poscanvas.app, versionCode 1,
 *     versionName 1.0.0, minSdkVersion 24;
 *   - apksigner confirmed the signer certificate sha-256
 *     7e32ec72c659dfacdab880d7fbe68991cf6104d11434f15d0c516bb9c6525b1b.
 *
 * TAG HISTORY, recorded because it cost a round of verification. The release was
 * first published as `v.1.0.0` — with a stray dot — and has since been re-tagged
 * to the conventional `v1.0.0`. Both URLs were checked against the API: the old
 * one now returns 404 and the new one serves a byte-identical APK (same
 * sha-256, same signer certificate). Future releases use `v<major>.<minor>.<patch>`
 * with no dot after the v.
 *
 * WHEN NO RELEASE EXISTS this must be null rather than a plausible-looking
 * placeholder: a fabricated URL would 404 and a fabricated checksum could never
 * match, which is worse than an honest "not available yet" that callers render
 * as such. Every consumer must handle null.
 */
export const CURRENT_ANDROID_RELEASE: AndroidRelease | null = {
  versionName: "1.0.0",
  versionCode: 1,
  downloadUrl:
    "https://github.com/aasishjannuaj/pos-canvas/releases/download/v1.0.0/POS-Canvas-v1.0.0.apk",
  checksum: "aded13d8db6eaed8a4fdeb5e56cf1a12036df24b64f54eec8f98ff2feb910125",
  fileSizeBytes: 3169762,
  releasedAt: "2026-08-14T23:52:46Z",
};

/**
 * The minimum Android version the published APK actually supports.
 *
 * Read from the APK's own minSdkVersion (24), not chosen for marketing. API 24
 * is Android 7.0 "Nougat". Nothing else is claimed: the app requests only
 * INTERNET and has no hardware requirement to advertise.
 */
export const ANDROID_MIN_SDK = 24;
export const ANDROID_MIN_VERSION_LABEL = "Android 7.0 or newer";

/**
 * Structural guard for a release record.
 *
 * Rejects rather than coerces, matching lib/completedSale.ts: a malformed
 * release would hand a customer a broken or unverifiable download, which is
 * worse than showing nothing.
 */
export function isAndroidRelease(value: unknown): value is AndroidRelease {
  // Feature 23.6 — the shared fields are checked by lib/platformRelease.ts, so
  // Android and Windows cannot drift apart on what "a valid release" means.
  // Everything Android-specific stays here.
  if (!isPlatformRelease(value)) {
    return false;
  }

  const release = value as unknown as Record<string, unknown>;

  return (
    typeof release.versionCode === "number" &&
    Number.isInteger(release.versionCode) &&
    release.versionCode > 0
  );
}

// Feature 23.6 — re-exported from the shared module so every existing importer
// keeps working and there is still exactly one implementation.
export { formatReleaseSize } from "@/lib/platformRelease";
