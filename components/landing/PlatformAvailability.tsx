import SectionHeading from "./SectionHeading";
import PlatformDownloadRow from "@/components/platform/PlatformDownloadRow";
import { getPlatformDownloads } from "@/lib/platformDownloads";

// Feature 22 Phase 3 — the public answer to "what do I actually run this on?".
//
// Sits between HowItWorks and CTASection: the narrative explains choosing a
// template and customising a POS, and this is where a visitor learns the app is
// a real thing they can install today on Android, with Windows coming.
//
// PUBLIC AND UNAUTHENTICATED. It renders from a module constant with no session,
// no project and no database call, so platform availability is visible to
// anyone — which is the point of putting it on the landing page rather than
// behind sign-in.
//
// No pricing claim, no Play Store language, and no Windows link. The universal
// app is described as exactly that.

export default function PlatformAvailability() {
  const downloads = getPlatformDownloads();

  return (
    <section className="mx-auto max-w-6xl px-6 py-24">
      <SectionHeading
        eyebrow="Platforms"
        title="Run POS Canvas on your devices"
        subtitle="Install the universal POS Canvas app, then pair it with your published business configuration."
      />

      <div className="mx-auto mt-12 flex max-w-2xl flex-col gap-3">
        {downloads.map((download) => (
          <PlatformDownloadRow key={download.platform} download={download} />
        ))}
      </div>
    </section>
  );
}
