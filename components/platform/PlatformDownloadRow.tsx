import { formatReleaseSize } from "@/lib/androidRelease";
import { PRERELEASE_BADGE_LABEL, UNSIGNED_BADGE_LABEL } from "@/lib/platformRelease";
import { isDownloadable } from "@/lib/platformDownloads";
import type { PlatformDownload } from "@/lib/platformDownloads";

// Feature 22 Phase 3 — one platform, rendered identically everywhere.
//
// Used by the landing page, the dashboard, and the editor's Devices panel, so
// the universal app looks and behaves the same wherever an owner finds it. The
// surrounding copy differs by surface (a logged-out visitor has no project to
// pair with); this row does not.
//
// THREE STATES, AND ONLY ONE OF THEM IS A LINK:
//
//   available   real <a href> to the GitHub Release asset
//   coming_soon a plain badge — NOT a button, NOT a disabled anchor
//   unavailable a plain sentence — no control at all
//
// A disabled <button> or an <a> without a usable href would be worse than
// nothing: both are announced inconsistently by screen readers, and a disabled
// control reads as "broken right now" rather than "not built yet". The
// coming-soon state has nothing to activate, so it is not interactive at all.

type PlatformDownloadRowProps = {
  download: PlatformDownload;
  /** Landing uses a roomier treatment than the narrower app panels. */
  size?: "comfortable" | "compact";
};

const COMING_SOON_LABEL = "Coming soon";

export default function PlatformDownloadRow({
  download,
  size = "comfortable",
}: PlatformDownloadRowProps) {
  const isCompact = size === "compact";

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-200 bg-white ${
        isCompact ? "px-4 py-3" : "px-5 py-4"
      }`}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span
          className={`font-semibold text-neutral-900 ${
            isCompact ? "text-sm" : "text-base"
          }`}
        >
          {download.label}
        </span>

        <span className="text-xs text-neutral-500">{download.description}</span>

        {/* Version, size and OS requirement come from the release itself, so
            nothing here restates a value that could drift. */}
        {isDownloadable(download) && (
          <span className="text-xs text-neutral-400">
            Version {download.release.versionName} ·{" "}
            {formatReleaseSize(download.release.fileSizeBytes)} ·{" "}
            {download.requirement}
          </span>
        )}

        {/* Feature 23.6 — qualifiers read from the release itself, so all three
            surfaces say the same thing without any of them hardcoding it.
            Absent on a stable signed release, so Android is unaffected.
            Rendered as text rather than a coloured warning: these are facts
            about the build, not errors, and an alarming treatment would
            discourage the very testing this build exists for.

            Feature 25.7 — TWO INDEPENDENT FLAGS, TWO INDEPENDENT LINES. They
            used to be one string behind `isPrerelease`, so publishing Windows
            1.1.0 as a full release — which it is — deleted the only warning
            that the installer is unsigned. A release can be stable-and-unsigned,
            pre-release-and-unsigned, or stable-and-signed; each fact now renders
            on its own terms and neither is derived from the other. */}
        {isDownloadable(download) && download.release.isPrerelease === true && (
          <span className="text-xs font-medium text-amber-700">
            {PRERELEASE_BADGE_LABEL}
          </span>
        )}

        {isDownloadable(download) && download.release.isUnsigned === true && (
          <span className="text-xs font-medium text-amber-700">
            {UNSIGNED_BADGE_LABEL}
          </span>
        )}
      </div>

      {isDownloadable(download) ? (
        <a
          href={download.release.downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          // The accessible name carries the platform: screen-reader users often
          // navigate by a list of links, where a bare "Download" is ambiguous.
          aria-label={`Download POS Canvas for ${download.label}, version ${download.release.versionName}`}
          className={`flex-none rounded-full bg-blue-600 font-semibold text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
            isCompact ? "px-4 py-2 text-xs" : "px-5 py-2.5 text-sm"
          }`}
        >
          Download {download.label} App
        </a>
      ) : download.status === "coming_soon" ? (
        /* A badge, not a control. Nothing to click, nothing to focus, and the
           words carry the meaning rather than the colour. */
        <span className="flex-none rounded-full border border-neutral-200 bg-neutral-50 px-4 py-2 text-xs font-medium text-neutral-500">
          {COMING_SOON_LABEL}
        </span>
      ) : (
        <span className="flex-none text-xs text-neutral-500">
          Temporarily unavailable
        </span>
      )}
    </div>
  );
}
