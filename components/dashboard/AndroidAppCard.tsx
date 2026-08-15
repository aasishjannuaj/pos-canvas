import PlatformDownloadRow from "@/components/platform/PlatformDownloadRow";
import { getPlatformDownloads } from "@/lib/platformDownloads";

// Feature 21 / Feature 22 Phase 3 — the customer-facing app download.
//
// WHY THIS LIVES ON THE ACCOUNT DASHBOARD RATHER THAN INSIDE A PROJECT: the
// app is UNIVERSAL. One binary, byte-identical for every customer, containing
// no project id, no configuration and no branding. Placing it inside a
// project's publish section — next to that project's json_config artifact —
// would imply the app was generated for that project, which is precisely the
// confusion this product cannot afford:
//
//   Publish configuration -> freezes THIS business's configuration (per project)
//   POS Canvas app        -> the universal application (one for all)
//
// A till becomes a specific business's till through PAIRING at runtime, never
// through the binary it runs.
//
// Phase 3 — the release version, size and URL are no longer read here at all.
// They come from lib/platformDownloads.ts, which derives them from
// CURRENT_ANDROID_RELEASE, so this card, the landing page and the editor panel
// cannot disagree about what is published. This component is a server component
// with no props: there is structurally nowhere for a project value to enter.

/** Numbered install guidance. Plain, non-alarming, and honest about the prompt. */
const INSTALL_STEPS = [
  "Download the app to your Android device.",
  "Android will ask for permission to install apps from your browser or files app — allow it for that app.",
  "Open the downloaded file and install POS Canvas.",
  "Open POS Canvas on the device.",
  "Enter the pairing code from your project's Devices section.",
];

export default function AndroidAppCard() {
  const downloads = getPlatformDownloads();

  return (
    <section>
      <div className="mb-6">
        <h2 className="text-xl font-semibold tracking-tight text-neutral-900">
          Run POS Canvas
        </h2>
      </div>

      <div className="rounded-2xl border border-neutral-200 bg-white p-6">
        <div className="flex flex-col gap-5">
          <p className="text-sm text-neutral-600">
            Install the universal POS Canvas app, then pair it with a published
            configuration.
          </p>

          <div className="flex flex-col gap-3">
            {downloads.map((download) => (
              <PlatformDownloadRow
                key={download.platform}
                download={download}
                size="compact"
              />
            ))}
          </div>

          <div className="border-t border-neutral-200 pt-4">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-400">
              Installing on Android
            </p>

            <ol className="flex list-decimal flex-col gap-1.5 pl-4 text-sm text-neutral-600">
              {INSTALL_STEPS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>

            {/* Feature 21 — the ordering that actually matters, stated once.
                Downloading the app does NOT create a pairing code; the owner
                requests one from the project's Devices section when ready. */}
            <p className="mt-3 text-xs text-neutral-500">
              Publish your latest configuration first, then pair the app from
              that project&apos;s Devices section.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
