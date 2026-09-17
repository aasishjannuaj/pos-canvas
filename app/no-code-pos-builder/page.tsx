import type { Metadata } from "next";
import Link from "next/link";
import Navbar from "@/components/landing/Navbar";
import Footer from "@/components/landing/Footer";
import SectionHeading from "@/components/landing/SectionHeading";
import LandingClosing from "@/components/seo-landing/LandingClosing";
import RelatedPages from "@/components/seo-landing/RelatedPages";
import { learnArticles } from "@/data/learn";
import {
  CUSTOMIZABLE_POS_PAGE,
  NO_CODE_POS_BUILDER_PAGE,
  POS_FOR_SMALL_BUSINESS_PAGE,
} from "@/lib/landingPages";
import { articlePath, findPublishedArticle } from "@/lib/learn";
import { buildLandingPageMetadata } from "@/lib/seo";

// Lane 3 Task 4 — /no-code-pos-builder.
//
// THE QUESTION: "can I create a POS without writing code, and what would that
// actually be?" The honest answer is an architecture, so the page leads with
// it — a template, the owner's business configuration, and one shared POS
// platform — then lists what the owner does instead of coding, and spends a
// whole section on what "no-code" does NOT mean here.
//
// THE RISK THIS PAGE EXISTS TO AVOID is over-claiming scope. POS Canvas is not
// a general app builder, it does not generate software, it has no visual
// programming or workflow editor, it creates no features, and it does not
// produce an app per business. The no-code statement is scoped to the owner's
// experience: configuring, previewing, publishing and pairing need no code.
//
// Task 4 product-truth correction. Publishing DOES store something for the
// business — its configuration — so the page says that plainly and denies only
// what is true to deny: no separate app is compiled or packaged. Publishing
// alone does not move an already-paired device; every update sentence names
// the offer/apply step.
//
// WHAT IT DELIBERATELY DOES NOT DO: itemise every setting (/customizable-pos)
// or walk a small business through getting started (/pos-for-small-business).
// The longer architectural argument already exists as a Learn article, so this
// page links to it rather than restating it.

export const metadata: Metadata = buildLandingPageMetadata(NO_CODE_POS_BUILDER_PAGE);

const ONE_APP_ARTICLE_SLUG = "one-app-not-one-per-business";

const PIECES: readonly { title: string; detail: string }[] = [
  {
    title: "A template",
    detail:
      "A starting point for a kind of business: starter products and settings, and the layout the POS uses to show them.",
  },
  {
    title: "Your business configuration",
    detail:
      "Everything you enter in the Builder: products, prices, add-ons, taxes, receipt text, business details and branding.",
  },
  {
    title: "The shared POS Canvas app",
    detail:
      "One app for Android and one for Windows, the same download for every business. It runs the published configuration of whichever project a device is paired to.",
  },
];

const INSTEAD_OF_CODE: readonly { action: string; detail: string }[] = [
  {
    action: "Choose a template",
    detail: "The layout and a set of starter products come with it.",
  },
  {
    action: "Fill in the Builder",
    detail:
      "Products, prices, add-on options, tax, receipt text and your logo are all forms and lists.",
  },
  {
    action: "Check the preview",
    detail: "The Builder shows your POS beside the settings as you change them.",
  },
  {
    action: "Press Publish",
    detail:
      "Publishing creates a new configuration version. For an already-paired device, offer the update in Devices and apply it from that device’s settings.",
  },
  {
    action: "Pair a device",
    detail:
      "Type a pairing code into the POS Canvas app. No separate app is compiled or packaged for your business. Publishing stores your project’s configuration so the shared POS Canvas app can run it.",
  },
];

const IT_MEANS: readonly string[] = [
  "You can configure, preview, publish and pair your POS without writing code.",
  "A new price or product starts as an edit in the Builder. Save and publish the change; for already-paired devices, offer and apply the new configuration.",
  "Adding a device means installing the same POS Canvas app and pairing it.",
];

// Each is a full sentence carrying its own negation.
const IT_DOES_NOT_MEAN: readonly string[] = [
  "POS Canvas isn’t a general-purpose app builder, and it doesn’t generate software for your business.",
  "There isn’t a drag-and-drop screen designer; the layout comes from your template.",
  "You can’t create your own workflows, automations or features.",
  "No separate app is built for each business, and there’s no per-business installer.",
  "It doesn’t mean there’s no code at all: POS Canvas is software, and you don’t have to write any of it.",
];

export default function NoCodePosBuilderPage() {
  const oneAppArticle = findPublishedArticle(learnArticles, ONE_APP_ARTICLE_SLUG);

  return (
    <div className="min-h-screen bg-brand-cream">
      <Navbar />

      <main>
        <section className="bg-brand-cream">
          <div className="pc-container pc-section pc-section--hero flex flex-col items-center gap-5 text-center">
            <p className="pc-eyebrow">No-code POS builder</p>

            <h1 className="max-w-pc-narrow text-pc-display font-semibold text-balance text-ink">
              Build your own point of sale without writing code
            </h1>

            <p className="max-w-pc-prose text-pc-lead text-pretty text-ink-muted">
              In POS Canvas, setting up a till is choosing and filling in, not
              programming. You pick a template, enter your business&rsquo;s
              details, check the preview and publish. The software that runs it
              is one POS Canvas app, shared by everyone who uses it.
            </p>

            <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
              <Link href="/templates" className="pc-button pc-button--primary pc-button--lg">
                Browse templates
              </Link>
              <a href="#what-no-code-means" className="pc-button pc-button--secondary pc-button--lg">
                What no-code means here
              </a>
            </div>
          </div>
        </section>

        <section className="bg-surface-raised">
          <div className="pc-container pc-section">
            <SectionHeading
              eyebrow="How it fits together"
              title="Three pieces make your POS"
              subtitle="Two of them are chosen or filled in by you. The third is the same for everyone."
            />

            {/* A composition, not a sequence, so an unordered list. The "+"
                and "=" glyphs are visual only; the headings carry the
                meaning for a screen reader. */}
            <ul className="mt-12 grid grid-cols-1 gap-10 lg:grid-cols-3 lg:gap-10">
              {PIECES.map((piece, index) => (
                <li key={piece.title} className="pc-card relative flex flex-col gap-3 p-6">
                  {index > 0 ? (
                    <span
                      aria-hidden="true"
                      className="absolute -top-8 left-1/2 flex size-7 -translate-x-1/2 items-center justify-center text-2xl font-semibold text-brand-teal-deep lg:top-1/2 lg:-left-8.5 lg:translate-x-0 lg:-translate-y-1/2"
                    >
                      +
                    </span>
                  ) : null}
                  <h3 className="text-lg font-semibold tracking-tight text-ink">
                    {piece.title}
                  </h3>
                  <p className="text-pc-meta leading-relaxed text-ink-muted">
                    {piece.detail}
                  </p>
                </li>
              ))}
            </ul>

            <div className="mx-auto mt-4 flex max-w-pc-prose flex-col items-center gap-4">
              <span
                aria-hidden="true"
                className="text-2xl font-semibold text-brand-teal-deep"
              >
                =
              </span>
              <div className="pc-surface-teal w-full rounded-pc-lg p-6 text-center">
                <h3 className="text-lg font-semibold tracking-tight text-ink">
                  Your POS
                </h3>
                <p className="mt-2 text-pc-body text-ink">
                  The shared app on your device, running the configuration you
                  published.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="bg-brand-cream">
          <div className="pc-container pc-section grid grid-cols-1 gap-12 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start">
            <SectionHeading
              align="left"
              eyebrow="In practice"
              title="What you do instead of writing code"
              subtitle="Every step is a choice, a form or a button."
            />

            <dl className="pc-card flex flex-col p-2 sm:p-3">
              {INSTEAD_OF_CODE.map((step) => (
                <div
                  key={step.action}
                  className="flex flex-col gap-1 border-t border-hairline px-4 py-4 first:border-t-0 sm:grid sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-6"
                >
                  <dt className="font-semibold text-ink">{step.action}</dt>
                  <dd className="text-pc-body text-pretty text-ink-muted">
                    {step.detail}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section id="what-no-code-means" className="bg-surface-raised">
          <div className="pc-container pc-section">
            <SectionHeading
              eyebrow="Plain terms"
              title="What no-code means here"
              subtitle="No-code describes your side of POS Canvas. It is not a promise that you can make any software you like."
            />

            <div className="mx-auto mt-12 grid max-w-pc-narrow grid-cols-1 gap-5 md:grid-cols-2">
              <div className="pc-card pc-card--flat flex flex-col gap-4 p-6 sm:p-8">
                <h3 className="text-lg font-semibold tracking-tight text-ink">
                  It means
                </h3>
                <ul className="flex list-disc flex-col gap-2.5 pl-5 text-pc-body text-ink-muted marker:text-brand-teal-deep">
                  {IT_MEANS.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>

              <div className="pc-card pc-card--flat flex flex-col gap-4 p-6 sm:p-8">
                <h3 className="text-lg font-semibold tracking-tight text-ink">
                  It doesn&rsquo;t mean
                </h3>
                <ul className="flex list-disc flex-col gap-2.5 pl-5 text-pc-body text-ink-muted marker:text-brand-coral-deep">
                  {IT_DOES_NOT_MEAN.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section className="bg-brand-cream">
          <div className="pc-container pc-section">
            <div className="mx-auto flex max-w-pc-prose flex-col gap-5">
              <h2 className="text-pc-title font-semibold text-balance text-ink">
                Why everyone runs the same app
              </h2>

              <p className="text-pc-body text-pretty text-ink-muted">
                Because every business installs the same POS Canvas app, what
                makes a POS yours is its configuration, not its software. That
                is why setting one up comes down to choices and forms, and why
                changing your menu means publishing a new configuration and
                applying that update rather than installing a new app.
              </p>

              {oneAppArticle ? (
                <p className="text-pc-body text-pretty text-ink-muted">
                  The longer explanation is on POS Canvas Learn:{" "}
                  <Link href={articlePath(oneAppArticle)} className="pc-textlink font-semibold">
                    {oneAppArticle.title}
                  </Link>
                </p>
              ) : null}
            </div>
          </div>
        </section>

        <LandingClosing
          title="Try it on a template"
          primary={{ href: "/templates", label: "Browse templates" }}
          secondary={{ href: "/signup", label: "Create an account" }}
        >
          Open a template in the Builder and change a few things, and the
          preview follows along. You&rsquo;ll need an account to open the
          Builder.
        </LandingClosing>

        <RelatedPages
          pages={[
            {
              href: CUSTOMIZABLE_POS_PAGE.path,
              title: "What you can customize",
              description:
                "A closer look at the main Builder settings and the limits of customization.",
            },
            {
              href: POS_FOR_SMALL_BUSINESS_PAGE.path,
              title: "A POS for a small business",
              description:
                "What you’ll need, how to get started, and whether POS Canvas fits the way you work.",
            },
          ]}
        />
      </main>

      <Footer />
    </div>
  );
}
