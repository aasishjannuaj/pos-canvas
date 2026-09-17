import type { Metadata } from "next";
import Link from "next/link";
import Navbar from "@/components/landing/Navbar";
import Footer from "@/components/landing/Footer";
import SectionHeading from "@/components/landing/SectionHeading";
import LandingClosing from "@/components/seo-landing/LandingClosing";
import RelatedPages from "@/components/seo-landing/RelatedPages";
import { templates } from "@/data/templates";
import {
  CUSTOMIZABLE_POS_PAGE,
  NO_CODE_POS_BUILDER_PAGE,
  POS_FOR_SMALL_BUSINESS_PAGE,
} from "@/lib/landingPages";
import { getPlatformDownloads, isDownloadable } from "@/lib/platformDownloads";
import { buildLandingPageMetadata } from "@/lib/seo";

// Lane 3 Task 4 — /pos-for-small-business.
//
// THE QUESTION: "I run (or am about to open) a small business — is this a
// practical POS for me, and what would getting started involve?" So the page is
// practical before it is descriptive: what you need, the steps in order, what
// works on the first day, which template to pick, and an honest fit check that
// names what the product does not do.
//
// WHAT IT DELIBERATELY DOES NOT DO: list every customizable setting (that is
// /customizable-pos) or explain the architecture (that is
// /no-code-pos-builder).
//
// PRODUCT TRUTH, checked against the 1.2.0 source:
//   - the device requirements are read from the release model, not typed;
//   - the pairing-code lifetime is 10 minutes (PAIRING_TOKEN_TTL_SECONDS,
//     asserted by lib/landingPages.guards.test.ts);
//   - the app download lives in the Builder's Devices section
//     (RunYourPosPanel);
//   - receipts are shown on screen — printing is not claimed, because the
//     Android app shows a notice instead of printing;
//   - card payments are recorded, never processed, and there are no refunds
//     or voids and no iPhone/iPad app. Saying so is the point of the fit
//     section: an owner should learn it here, not after setting up.
//   - Task 4 product-truth correction. Barcode and staff/time-tracking
//     ABSENCES are deliberately not stated: both are active v1.3 scope, and an
//     evergreen denial would go stale this release cycle. Nothing positive is
//     said about either, because neither has shipped.
//   - No stock-ENFORCEMENT statement is made. Paired devices do not block a
//     product at zero, and how a sale with too little stock is settled depends
//     on how it was recorded; the restock and inventory-summary line is the
//     page's whole inventory claim.
//   - Offline selling is deliberately not mentioned on this page, per the
//     Task 4 brief.

export const metadata: Metadata = buildLandingPageMetadata(POS_FOR_SMALL_BUSINESS_PAGE);

const GETTING_STARTED: readonly { title: string; detail: string }[] = [
  {
    title: "Create your account",
    detail: "Sign up with an email address and a password.",
  },
  {
    title: "Open a template",
    detail:
      "Choose the one closest to your business and open it in the Builder. Saving it creates your project.",
  },
  {
    title: "Put in what you sell",
    detail:
      "Replace the starter products with your own, set your prices and tax, and check what the receipt will say.",
  },
  {
    title: "Publish",
    detail:
      "Once your changes are saved, publish them. The published version is the one your devices run.",
  },
  {
    title: "Install POS Canvas",
    detail:
      "The Builder’s Devices section has the download for Android and Windows. Every business installs the same app.",
  },
  {
    title: "Pair and start selling",
    detail:
      "Create a pairing code in Devices and type it into the app. A code expires after 10 minutes, so create it with the device in front of you.",
  },
];

const AT_THE_COUNTER: readonly string[] = [
  "Ring up a sale by tapping products, with their add-ons.",
  "Record whether each sale was paid in cash or by card.",
  "Show the customer the receipt on screen.",
  "Look back through earlier sales on the device.",
];

const IN_THE_BUILDER: readonly string[] = [
  "Check a sales report, product performance and an inventory summary.",
  "Record restocks, and see how much stock sold, was restocked or was adjusted.",
  "Pair more than one device to the same business.",
];

const GOOD_FIT: readonly string[] = [
  "You sell from a list of products or services with set prices.",
  "You want to set up the POS yourself, and change it yourself later.",
  "You plan to sell on an Android device or a Windows PC.",
  "You want cash and card sales recorded, with card payments taken outside the POS.",
];

// Each one is a complete sentence with its own negation, so no line can be read
// on its own as a claim that the product does the thing.
const WORTH_KNOWING: readonly string[] = [
  "POS Canvas doesn’t process card payments or connect to a card reader.",
  "Refunds and voids aren’t handled in the POS.",
  "There is no app for iPhone or iPad.",
];

// The first few starter products, read from the registry. "and more" is added
// only when there really are more, so the sentence stays true if a template's
// starter list is ever shortened.
const STARTER_PREVIEW_COUNT = 3;

function starterPreview(names: readonly string[]): string {
  const shown = names.slice(0, STARTER_PREVIEW_COUNT).join(", ");
  return names.length > STARTER_PREVIEW_COUNT ? `${shown}, and more.` : `${shown}.`;
}

export default function PosForSmallBusinessPage() {
  const platforms = getPlatformDownloads().filter(isDownloadable);

  return (
    <div className="min-h-screen bg-brand-cream">
      <Navbar />

      <main>
        <section className="bg-brand-cream">
          <div className="pc-container pc-section pc-section--hero grid grid-cols-1 gap-12 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-center">
            <div className="flex flex-col gap-5">
              <p className="pc-eyebrow">POS for small businesses</p>

              <h1 className="text-pc-display font-semibold text-balance text-ink">
                A point of sale designed for a small business to configure
                itself
              </h1>

              <p className="max-w-pc-prose text-pc-lead text-pretty text-ink-muted">
                If you&rsquo;re opening a shop, café, salon or food
                truck, or rethinking the till you already have, POS Canvas lets
                you set up a point of sale yourself. You start from a template
                and sell on a supported Android or Windows device.
              </p>

              <div className="mt-2 flex flex-wrap items-center gap-3">
                <Link href="/signup" className="pc-button pc-button--primary pc-button--lg">
                  Create an account
                </Link>
                <Link href="/templates" className="pc-button pc-button--secondary pc-button--lg">
                  See the templates
                </Link>
              </div>
            </div>

            <div className="pc-panel flex flex-col gap-4 p-6 sm:p-8">
              <h2 className="text-xl font-semibold tracking-tight text-ink">
                What you&rsquo;ll need
              </h2>

              <ul className="flex list-disc flex-col gap-2.5 pl-5 text-pc-body text-ink-muted marker:text-brand-teal-deep">
                <li>A POS Canvas account.</li>
                <li>Your products or services, with their prices.</li>
                <li>Your sales tax rate, if you charge tax.</li>
                <li>
                  A device to sell on, running one of:
                  <ul className="mt-1.5 flex list-[circle] flex-col gap-1 pl-5">
                    {platforms.map((platform) => (
                      <li key={platform.platform}>{platform.requirement}</li>
                    ))}
                  </ul>
                </li>
                <li>Your logo, if you&rsquo;d like it on the screen.</li>
              </ul>
            </div>
          </div>
        </section>

        <section className="bg-surface-raised">
          <div className="pc-container pc-section">
            <SectionHeading
              eyebrow="Getting started"
              title="From an account to your first sale"
              subtitle="Six steps, in the order you’ll do them."
            />

            <ol className="mx-auto mt-12 flex max-w-pc-narrow flex-col">
              {GETTING_STARTED.map((step, index) => (
                <li
                  key={step.title}
                  className="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-x-4 border-t border-hairline py-6 first:border-t-0 sm:grid-cols-[3.5rem_minmax(0,1fr)]"
                >
                  <span
                    aria-hidden="true"
                    className="flex size-10 items-center justify-center rounded-pc-pill border border-hairline-teal bg-surface-raised text-pc-meta font-bold text-brand-teal-deep sm:size-12"
                  >
                    {index + 1}
                  </span>
                  <div className="flex flex-col gap-1.5">
                    <h3 className="text-lg font-semibold tracking-tight text-ink">
                      {step.title}
                    </h3>
                    <p className="text-pc-body text-pretty text-ink-muted">
                      {step.detail}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="bg-brand-cream">
          <div className="pc-container pc-section">
            <SectionHeading
              align="left"
              eyebrow="Day one"
              title="What works from the first day"
              subtitle="The current released POS and Builder include the capabilities below."
            />

            <div className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-2">
              <div className="pc-card flex flex-col gap-4 p-6 sm:p-8">
                <h3 className="text-lg font-semibold tracking-tight text-ink">
                  At the counter
                </h3>
                <ul className="flex list-disc flex-col gap-2.5 pl-5 text-pc-body text-ink-muted marker:text-brand-teal-deep">
                  {AT_THE_COUNTER.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>

              <div className="pc-card flex flex-col gap-4 p-6 sm:p-8">
                <h3 className="text-lg font-semibold tracking-tight text-ink">
                  In the Builder
                </h3>
                <ul className="flex list-disc flex-col gap-2.5 pl-5 text-pc-body text-ink-muted marker:text-brand-teal-deep">
                  {IN_THE_BUILDER.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                <p className="text-pc-meta text-ink-subtle">
                  Want a closer look at the main Builder settings?{" "}
                  <Link href={CUSTOMIZABLE_POS_PAGE.path} className="pc-textlink font-semibold">
                    See what you can customize
                  </Link>
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="bg-surface-raised">
          <div className="pc-container pc-section">
            <SectionHeading
              align="left"
              eyebrow="Templates"
              title="Choosing a template"
              subtitle="Pick the one whose starter products look most like yours. All of them run the same POS with the same features; what differs is what you start with and how the screen is laid out."
            />

            <ul className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {templates.map((template) => (
                <li key={template.id} className="pc-card pc-card--flat flex flex-col gap-2 p-6">
                  <p className="text-pc-meta font-semibold uppercase tracking-wider text-brand-teal-deep">
                    {template.category}
                  </p>
                  <h3 className="text-lg font-semibold tracking-tight">
                    {/* inline-block + py-0.5: the name alone renders 23px
                        tall, a pixel under the 24px minimum target size. */}
                    <Link href={`/templates/${template.id}`} className="pc-textlink inline-block py-0.5">
                      {template.name}
                    </Link>
                  </h3>
                  <p className="text-pc-meta leading-relaxed text-ink-muted">
                    Starts with{" "}
                    {starterPreview(template.starterConfig.menuItems.map((item) => item.name))}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="bg-brand-cream">
          <div className="pc-container pc-section">
            <SectionHeading
              eyebrow="Fit"
              title="Is POS Canvas the right fit?"
              subtitle="A quick check before you set anything up."
            />

            <div className="mx-auto mt-12 grid max-w-pc-narrow grid-cols-1 gap-5 md:grid-cols-2">
              <div className="pc-card flex flex-col gap-4 p-6 sm:p-8">
                <h3 className="text-lg font-semibold tracking-tight text-ink">
                  It suits you if
                </h3>
                <ul className="flex list-disc flex-col gap-2.5 pl-5 text-pc-body text-ink-muted marker:text-brand-teal-deep">
                  {GOOD_FIT.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>

              <div className="pc-card flex flex-col gap-4 p-6 sm:p-8">
                <h3 className="text-lg font-semibold tracking-tight text-ink">
                  Worth knowing first
                </h3>
                <ul className="flex list-disc flex-col gap-2.5 pl-5 text-pc-body text-ink-muted marker:text-brand-coral-deep">
                  {WORTH_KNOWING.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        <LandingClosing
          title="Set up your POS from a template"
          primary={{ href: "/signup", label: "Create an account" }}
          secondary={{ href: "/templates", label: "See the templates" }}
        >
          Open the template closest to your business, make it yours, and
          publish when you&rsquo;re happy with it.
        </LandingClosing>

        <RelatedPages
          pages={[
            {
              href: CUSTOMIZABLE_POS_PAGE.path,
              title: "Main settings you can customize",
              description:
                "The main settings in each Builder section, plus where customization stops.",
            },
            {
              href: NO_CODE_POS_BUILDER_PAGE.path,
              title: "Setting up a POS without code",
              description:
                "Why an owner never writes code, and what no-code does and doesn’t mean here.",
            },
          ]}
        />
      </main>

      <Footer />
    </div>
  );
}
