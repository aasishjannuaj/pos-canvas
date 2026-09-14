import SectionHeading from "./SectionHeading";
import PlatformDownloadRow from "@/components/platform/PlatformDownloadRow";
import { getPlatformDownloads } from "@/lib/platformDownloads";

// Feature 22 Phase 3 — the public answer to "what do I actually run this on?".
//
// Sits between HowItWorks and CTASection: the narrative explains choosing a
// template and customising a POS, and this is where a visitor learns the app is
// a real thing they can install today.
//
// PUBLIC AND UNAUTHENTICATED. It renders from a module constant with no session,
// no project and no database call, so platform availability is visible to
// anyone — which is the point of putting it on the landing page rather than
// behind sign-in.
//
// No pricing claim and no app-store language. The universal app is described as
// exactly that.
//
// Lane 3 Task 2 — presentation only. Every fact on this section still comes
// from getPlatformDownloads(), which derives version, size, requirement and URL
// from the release modules; nothing here restates one. The rows render through
// the shared components/platform/PlatformDownloadRow so the landing page cannot
// grow a second way of deciding whether a platform is downloadable — that
// decision is a type narrowing (isDownloadable), and duplicating it here is
// precisely how a link to an unbuilt platform would appear. The row is asked
// for its "site" tone, which changes colours only.
//
// WHAT THIS SECTION DELIBERATELY DOES NOT SAY. No store listing of any kind,
// because neither exists. No payment-terminal, card-reader, printer or scanner
// ecosystem claim, because none of that is a shipped integration. No suggestion
// that a business gets its own binary — the whole point of the sentence below
// is that it does not.
//
// AND NO CLAIM ABOUT HOW MANY. The closing line used to read "Run as many
// devices as you need on one published configuration", which is not an
// architecture statement at all — it is an unbounded scalability and
// commercial-support promise, and no such promise has been established or
// approved. Pairing many devices to one configuration is how the system is
// SHAPED; whether an owner may run an unlimited number of them is a product
// and support decision nobody has made. The line now states the shape and
// stops. lib/homepageTruth.guards.test.ts fails if a quantity, a limit, a
// tier or a location claim reappears anywhere on the page.

export default function PlatformAvailability() {
  const downloads = getPlatformDownloads();

  return (
    <section className="bg-surface-raised">
      <div className="pc-container pc-section">
        <SectionHeading
          eyebrow="Platforms"
          title="Run POS Canvas on your devices"
          subtitle="Install the universal POS Canvas app, then pair it with your published business configuration. The download is the same for every business — pairing is what makes a device yours."
        />

        <div className="mx-auto mt-12 flex max-w-3xl flex-col gap-3">
          {downloads.map((download) => (
            <PlatformDownloadRow
              key={download.platform}
              download={download}
              tone="site"
            />
          ))}
        </div>

        <p className="mx-auto mt-6 max-w-pc-prose text-center text-pc-meta text-ink-subtle">
          Pair your devices with the same published business configuration.
        </p>
      </div>
    </section>
  );
}
