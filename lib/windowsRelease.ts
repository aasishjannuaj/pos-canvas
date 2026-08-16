// Feature 23.6 — the Windows installer release contract.
//
// WHAT THIS IS FOR: describing the ONE universal signed installer that owners
// download and run on a till. It is the Windows counterpart of
// lib/androidRelease.ts and deliberately mirrors its shape and its discipline.
//
// WHAT IT IS NOT COUPLED TO: build_jobs. That table models PER-PROJECT
// configuration generation and produces `json_config` artifacts. The installer
// is universal — one binary for every customer, containing no project id, no
// configuration and no branding, verified byte-for-byte in Feature 23.4 against
// the packaged app.asar. A till becomes a specific business's till through
// PAIRING at runtime, not through the binary it runs.
//
// NO versionCode. Android needs one because the OS refuses to install an APK
// whose versionCode is lower than the installed one; NSIS compares version
// strings and has no equivalent concept. Inventing a field Windows does not use
// would be a value nobody maintains and nobody checks.
//
// Dependency-free, so the same validation runs on the server, in the browser,
// and under Vitest.
import { isPlatformRelease } from "@/lib/platformRelease";
import type { PlatformRelease } from "@/lib/platformRelease";

/**
 * A published Windows release.
 *
 * Uses the shared shape unchanged — there is currently nothing Windows needs
 * that every platform does not.
 */
export type WindowsRelease = PlatformRelease;

/**
 * The current published release, or null when none exists yet.
 *
 * Feature 23.6 — populated with the first real Windows release. Every value
 * below was VERIFIED against the published artifact rather than transcribed,
 * exactly as Feature 21 did for Android:
 *
 *   - the GitHub Releases API was queried for the tag `windows-v1.0.0`; it
 *     reports prerelease=true, draft=false, published_at 2026-08-16T15:24:22Z,
 *     and both assets;
 *   - the published installer was downloaded and its sha-256 computed locally;
 *   - it verified against the published .sha256 file (`shasum -c` -> OK);
 *   - fileSizeBytes is the byte count of the downloaded file and matches the
 *     size the API reports;
 *   - the downloaded bytes are byte-identical to the CI artifact, and differ
 *     from a local macOS cross-build (99637032 bytes) — which is how "did CI
 *     build this?" stays checkable;
 *   - the PE certificate table is empty, confirming the binary is UNSIGNED.
 *
 * THIS RELEASE IS AN UNSIGNED PRE-RELEASE, BY OWNER DECISION. POS Canvas is not
 * publicly launched, and distributing an unsigned development build is an
 * accepted trade for that stage — which is why `isPrerelease` is true and every
 * surface renders "Pre-release · Unsigned build" beside the download. Windows
 * will show a SmartScreen "Unknown publisher" warning, and enterprise policy or
 * Smart App Control may block it outright.
 *
 * CODE SIGNING REMAINS REQUIRED BEFORE THE TRUE PUBLIC LAUNCH. It is deferred,
 * not cancelled. When it lands, the signed artifact replaces this one and every
 * value here — url, checksum, size, releasedAt — is re-verified against the new
 * published bytes, because signing changes the file.
 *
 * Windows uses its own tag line (`windows-v<semver>`), never Android's
 * `v<semver>`: the two binaries have independent release cadence and a shared
 * tag would force meaningless version churn on one whenever the other shipped.
 *
 * MAY BE SET BACK TO NULL AT ANY TIME. Callers all handle it, and the download
 * then renders as "Coming soon" rather than as a broken link.
 */
export const CURRENT_WINDOWS_RELEASE: WindowsRelease | null = {
  versionName: "1.0.0",
  downloadUrl:
    "https://github.com/aasishjannuaj/pos-canvas/releases/download/windows-v1.0.0/POS-Canvas-Windows-v1.0.0.exe",
  checksum: "03b88e35d12b01ffbf62116519817c554b18f8a8e51c21064b9f6e82a748855d",
  fileSizeBytes: 99637338,
  releasedAt: "2026-08-16T15:24:22Z",
  isPrerelease: true,
};

/**
 * The minimum Windows version the installer actually supports.
 *
 * Read from Electron 43.4.0's own documentation ("Windows 10 and up"), not
 * chosen for marketing. Support for Windows 7/8/8.1 was removed in Electron 23.
 * The build targets x64 only, so the architecture is part of the requirement
 * rather than an implementation detail an owner can ignore.
 */
export const WINDOWS_MIN_VERSION_LABEL = "Windows 10 or newer · x64";

/** The release tag this platform publishes under. */
export const WINDOWS_RELEASE_TAG_PREFIX = "windows-v";

/**
 * Structural guard for a release record.
 *
 * Adds Windows-specific structure on top of the shared check: the asset must be
 * the expected installer filename under the expected tag, so a release object
 * pointing at the Android APK — or at any other asset — is rejected rather than
 * rendered.
 */
export function isWindowsRelease(value: unknown): value is WindowsRelease {
  if (!isPlatformRelease(value)) {
    return false;
  }

  const expectedFilename = `POS-Canvas-Windows-v${value.versionName}.exe`;

  return (
    value.downloadUrl.endsWith(`/${expectedFilename}`) &&
    value.downloadUrl.includes(`/${WINDOWS_RELEASE_TAG_PREFIX}${value.versionName}/`)
  );
}
