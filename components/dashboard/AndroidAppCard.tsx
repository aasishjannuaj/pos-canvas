import {
  ANDROID_MIN_VERSION_LABEL,
  CURRENT_ANDROID_RELEASE,
  formatReleaseSize,
} from "@/lib/androidRelease";

// Feature 21 — the customer-facing Android download.
//
// WHY THIS LIVES ON THE ACCOUNT DASHBOARD RATHER THAN INSIDE A PROJECT: the
// APK is UNIVERSAL. One binary, byte-identical for every customer, containing
// no project id, no configuration and no branding. Placing it inside a
// project's build section — next to that project's json_config artifact —
// would imply the app was generated for that project, which is precisely the
// confusion this product cannot afford:
//
//   Project Build      -> freezes THIS business's configuration (per project)
//   Android App        -> the universal POS Canvas application (one for all)
//
// A till becomes a specific business's till through PAIRING at runtime, never
// through the binary it runs.
//
// This component is deliberately a server component with no props: it reads a
// module constant and renders. It touches no project, no build job, no artifact
// URL and no Supabase client, so there is structurally no way for a
// project-specific value to reach it.

/** Numbered install guidance. Plain, non-alarming, and honest about the prompt. */
const INSTALL_STEPS = [
  "Download the APK to your Android device.",
  "Android will ask for permission to install apps from your browser or files app — allow it for that app.",
  "Open the downloaded file and install POS Canvas.",
  "Open POS Canvas on the device.",
  "Enter the pairing code from your project's Devices section.",
];

export default function AndroidAppCard() {
  const release = CURRENT_ANDROID_RELEASE;

  return (
    <section>
      <div className="mb-6">
        <h2 className="text-xl font-semibold tracking-tight text-neutral-900">
          POS Canvas for Android
        </h2>
      </div>

      <div className="rounded-2xl border border-neutral-200 bg-white p-6">
        {release === null ? (
          /* Feature 21 — the safe unavailable state, preserved even though a
             release exists today. A missing release must never render a broken
             or fabricated link; it renders this instead. */
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-neutral-900">
              Android release is not available yet.
            </p>
            <p className="text-sm text-neutral-500">
              The Android app will appear here once the first version is
              published.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex flex-col gap-1.5">
                <p className="text-sm text-neutral-600">
                  Install the POS Canvas app on your Android device, then pair it
                  with a Ready project build.
                </p>

                <p className="text-xs text-neutral-500">
                  Universal app — your business configuration is loaded securely
                  after pairing.
                </p>

                <p className="mt-1 text-xs text-neutral-400">
                  Version {release.versionName} ·{" "}
                  {formatReleaseSize(release.fileSizeBytes)} ·{" "}
                  {ANDROID_MIN_VERSION_LABEL}
                </p>
              </div>

              {/*
                A plain link straight to the GitHub Release asset.

                No server action, no Vercel proxy, no Supabase copy, and no APK
                in this repository: the binary is served by GitHub, and the
                browser downloads it directly. `rel="noopener noreferrer"` is
                set because the link opens a new tab to an external origin.
              */}
              <a
                href={release.downloadUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-none rounded-full bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
              >
                Download Android APK
              </a>
            </div>

            <div className="border-t border-neutral-200 pt-4">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-400">
                Installing
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
                Build your latest configuration first, then pair the Android app
                from that project&apos;s Devices section.
              </p>
            </div>

            {/* Technical detail, collapsed by default. An owner installing a
                till does not need a digest; someone verifying a download does,
                and hiding it entirely would make that impossible. */}
            <details className="border-t border-neutral-200 pt-4">
              <summary className="cursor-pointer text-xs font-medium text-neutral-500 transition-colors hover:text-neutral-900">
                Advanced details
              </summary>

              <dl className="mt-3 flex flex-col gap-2 text-xs text-neutral-500">
                <div className="flex flex-col gap-0.5">
                  <dt className="font-medium text-neutral-600">SHA-256</dt>
                  <dd className="break-all font-mono">{release.checksum}</dd>
                </div>
                <div className="flex flex-col gap-0.5">
                  <dt className="font-medium text-neutral-600">Version code</dt>
                  <dd className="font-mono">{release.versionCode}</dd>
                </div>
              </dl>
            </details>
          </div>
        )}
      </div>
    </section>
  );
}
