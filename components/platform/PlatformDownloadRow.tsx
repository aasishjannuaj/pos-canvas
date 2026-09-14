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

// Lane 3 Task 2 — a `tone`, added rather than a restyle.
//
// The public homepage now draws itself from the Concept D design system, and
// this row was the one thing inside it still painted in stock Tailwind blue.
// Recolouring the component outright was the wrong fix: it is also mounted by
// components/dashboard/AndroidAppCard.tsx and components/devices/
// RunYourPosPanel.tsx, which are signed-in application surfaces that no
// approved task covers, and they would have been restyled as a side effect of
// a marketing change.
//
// So the tone is a parameter with the existing look as its default. Both app
// surfaces render byte-identically to before; only the landing page asks for
// "site". What the tone changes is colour and nothing else — the three states,
// the narrowing that decides which of them renders, and the accessible name
// are shared by both, because those are the parts that must not diverge.

type PlatformDownloadRowProps = {
  download: PlatformDownload;
  /** Landing uses a roomier treatment than the narrower app panels. */
  size?: "comfortable" | "compact";
  /**
   * "app" (default) is the signed-in application look, unchanged.
   * "site" is the public homepage's Concept D look.
   */
  tone?: "app" | "site";
};

const COMING_SOON_LABEL = "Coming soon";

/**
 * Colour only. Every string is a complete literal so Tailwind's scanner emits
 * it — never build one of these by concatenation.
 */
const TONES = {
  app: {
    container: "rounded-xl border border-neutral-200 bg-white",
    label: "text-neutral-900",
    description: "text-neutral-500",
    meta: "text-neutral-400",
    qualifier: "text-amber-700",
    action:
      "rounded-full bg-blue-600 font-semibold text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600",
    comingSoon:
      "rounded-full border border-neutral-200 bg-neutral-50 px-4 py-2 text-xs font-medium text-neutral-500",
    unavailable: "text-xs text-neutral-500",
  },
  site: {
    container: "pc-card rounded-pc-lg",
    label: "text-ink",
    description: "text-ink-muted",
    meta: "text-ink-subtle",
    // NOT the approved coral: #FF7F68 is 2.47:1 on white, and this line is the
    // installer warning — the one piece of text on the row that most needs
    // reading. The darkened coral is 6.28:1.
    qualifier: "text-brand-coral-deep",
    action: "pc-button pc-button--primary",
    comingSoon: "pc-chip",
    unavailable: "text-xs text-ink-subtle",
  },
} as const;

export default function PlatformDownloadRow({
  download,
  size = "comfortable",
  tone = "app",
}: PlatformDownloadRowProps) {
  const isCompact = size === "compact";
  const palette = TONES[tone];

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 ${
        palette.container
      } ${isCompact ? "px-4 py-3" : "px-5 py-4"}`}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span
          className={`font-semibold ${palette.label} ${
            isCompact ? "text-sm" : "text-base"
          }`}
        >
          {download.label}
        </span>

        <span className={`text-xs ${palette.description}`}>
          {download.description}
        </span>

        {/* Version, size and OS requirement come from the release itself, so
            nothing here restates a value that could drift. */}
        {isDownloadable(download) && (
          <span className={`text-xs ${palette.meta}`}>
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
          <span className={`text-xs font-medium ${palette.qualifier}`}>
            {PRERELEASE_BADGE_LABEL}
          </span>
        )}

        {isDownloadable(download) && download.release.isUnsigned === true && (
          <span className={`text-xs font-medium ${palette.qualifier}`}>
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
          className={`flex-none ${palette.action} ${
            isCompact ? "px-4 py-2 text-xs" : "px-5 py-2.5 text-sm"
          }`}
        >
          Download {download.label} App
        </a>
      ) : download.status === "coming_soon" ? (
        /* A badge, not a control. Nothing to click, nothing to focus, and the
           words carry the meaning rather than the colour. */
        <span className={`flex-none ${palette.comingSoon}`}>
          {COMING_SOON_LABEL}
        </span>
      ) : (
        <span className={`flex-none ${palette.unavailable}`}>
          Temporarily unavailable
        </span>
      )}
    </div>
  );
}
