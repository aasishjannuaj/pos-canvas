import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import Navbar from "@/components/landing/Navbar";
import Footer from "@/components/landing/Footer";
import SectionHeading from "@/components/landing/SectionHeading";
import LandingClosing from "@/components/seo-landing/LandingClosing";
import RelatedPages from "@/components/seo-landing/RelatedPages";
import { templates } from "@/data/templates";
import { BUILDER_CAFE_PRODUCTS } from "@/data/productMedia";
import {
  CUSTOMIZABLE_POS_PAGE,
  NO_CODE_POS_BUILDER_PAGE,
  POS_FOR_SMALL_BUSINESS_PAGE,
} from "@/lib/landingPages";
import type { PosLayout } from "@/lib/posLayout";
import { buildLandingPageMetadata } from "@/lib/seo";

// Lane 3 Task 4 — /customizable-pos.
//
// THE QUESTION: "can I make a POS fit my business, and what does that mean?"
// The answer is an inventory, so the page is built around one: every
// customizable area, named after the Builder section it lives in, with the
// settings that section really has in the released 1.2.0 product. It then says
// where the template fits, shows the Builder, follows a change from the Builder
// to a paired device, and ends by saying plainly where customization stops.
//
// WHAT IT DELIBERATELY DOES NOT DO: walk through getting started (that is
// /pos-for-small-business) or explain the no-code architecture (that is
// /no-code-pos-builder). It links to both instead of repeating them.
//
// PRODUCT TRUTH. Every item below was checked against the 1.2.0 source
// (lib/projectConfig.ts, EditorSidebar, EditorPropertiesPanel, the device
// update flow). Receipt PRINTING is not claimed: the Android app shows a notice
// instead of printing. The layout is not offered as a setting because it is
// not one — it is derived from the template.
//
// Task 4 product-truth correction. TIPS are not mentioned: the Builder has an
// Enable Tips setting, but the released checkout has no tip-entry UI and always
// records a tip of 0. STOCK is not claimed on the till: paired devices hide
// stock (lib/deviceSession.ts toDeviceDisplayConfig). The settings list is
// described as the MAIN settings, because it does not name every field-level
// option.

export const metadata: Metadata = buildLandingPageMetadata(CUSTOMIZABLE_POS_PAGE);

type CustomizableArea = {
  title: string;
  section: string;
  settings: readonly string[];
};

// In the order an owner meets them in the Builder's sidebar, apart from the
// business details, which sit with branding because both are "who you are".
const AREAS: readonly CustomizableArea[] = [
  {
    title: "Products and categories",
    section: "Menu",
    settings: [
      "Add, rename and remove products, and sort them into categories you name.",
      "Give each product its own price.",
      "Track stock on the products you count, and leave it off for the ones you don’t.",
      "Attach add-on groups, single or multiple choice and required or optional, with options that can change the price.",
    ],
  },
  {
    title: "Taxes",
    section: "Taxes",
    settings: [
      "Turn tax on or off and set the rate.",
      "Say whether your prices already include tax.",
      "Choose whether tax appears as its own line.",
    ],
  },
  {
    title: "Receipts and currency",
    section: "Settings",
    settings: [
      "Choose US dollars, Canadian dollars, euros or pounds sterling.",
      "Write the receipt’s header message and footer, and set the prefix for order numbers.",
      "Pick which lines the receipt shows, including business name, tax, payment method and order number.",
    ],
  },
  {
    title: "Business details",
    section: "Business",
    settings: [
      "Enter your business name, address, phone number, email and website once.",
      "The receipt shows the details you fill in and leaves out the ones you don’t.",
    ],
  },
  {
    title: "Your look",
    section: "Branding",
    settings: [
      "Upload your logo for the top of the POS screen.",
      "Pick the accent colour the POS uses for its buttons and highlights.",
    ],
  },
];

// The three layouts that exist (lib/posLayout.ts), described as a person at
// the counter sees them. Which templates use each is read from the registry.
const LAYOUTS: readonly { layout: PosLayout; name: string; description: string }[] = [
  {
    layout: "menu-grid",
    name: "Menu grid",
    description: "Item cards under category tabs, the way a menu reads.",
  },
  {
    layout: "product-grid",
    name: "Product grid",
    description: "A denser grid of product cards for retail-style selling.",
  },
  {
    layout: "service-grid",
    name: "Service grid",
    description: "Services under category tabs, with no stock shown.",
  },
];

// Save, publish, pair, update: the path from a setting to the counter. Each
// step names the real control an owner uses.
const PATH_TO_COUNTER: readonly { title: string; detail: string }[] = [
  {
    title: "Save",
    detail:
      "Your changes are stored in your project. Saving alone changes nothing on your devices.",
  },
  {
    title: "Publish",
    detail:
      "Publishing takes a snapshot of your saved settings. That snapshot is what your devices run.",
  },
  {
    title: "Pair",
    detail:
      "Create a pairing code in the Builder’s Devices section and enter it in the POS Canvas app on an Android or Windows device. It stays paired until you unpair it.",
  },
  {
    title: "Update",
    detail:
      "When you change something later, publish again and choose Offer update in Devices. Each device applies the update from its own settings screen.",
  },
];

export default function CustomizablePosPage() {
  return (
    <div className="min-h-screen bg-brand-cream">
      <Navbar />

      <main>
        <section className="bg-brand-cream">
          <div className="pc-container pc-section pc-section--hero">
            <div className="flex max-w-pc-narrow flex-col gap-5">
              <p className="pc-eyebrow">Customizable POS</p>

              <h1 className="text-pc-display font-semibold text-balance text-ink">
                Customize the products, pricing and branding in your point of
                sale
              </h1>

              <p className="max-w-pc-prose text-pc-lead text-pretty text-ink-muted">
                POS Canvas starts you from a template, then hands you the parts
                of a till that should be yours: what you sell, what it costs,
                how it&rsquo;s taxed, what the receipt says, your logo and your
                accent colour. Here are the main settings you can configure
                today, along with the boundaries of that customization.
              </p>

              <div className="mt-2 flex flex-wrap items-center gap-3">
                <Link href="/templates" className="pc-button pc-button--primary pc-button--lg">
                  Browse templates
                </Link>
                <a href="#what-you-can-change" className="pc-button pc-button--secondary pc-button--lg">
                  See what you can change
                </a>
              </div>
            </div>
          </div>
        </section>

        <section id="what-you-can-change" className="bg-surface-raised">
          <div className="pc-container pc-section">
            <SectionHeading
              align="left"
              eyebrow="In the Builder"
              title="What you can change"
              subtitle="Each area below is a section of the POS Canvas Builder. What you set there is saved with your project and becomes part of what your devices run once you publish."
            />

            <div className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
              {AREAS.map((area) => (
                <article key={area.title} className="pc-card pc-card--flat flex flex-col gap-4 p-6">
                  <div className="flex flex-col gap-1">
                    <p className="text-pc-meta font-semibold uppercase tracking-wider text-brand-teal-deep">
                      {area.section} section
                    </p>
                    <h3 className="text-lg font-semibold tracking-tight text-ink">
                      {area.title}
                    </h3>
                  </div>

                  <ul className="flex list-disc flex-col gap-2 pl-5 text-pc-meta leading-relaxed text-ink-muted marker:text-brand-teal-deep">
                    {area.settings.map((setting) => (
                      <li key={setting}>{setting}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="bg-brand-cream">
          <div className="pc-container pc-section grid grid-cols-1 gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-start">
            <div className="flex flex-col gap-5">
              <SectionHeading
                align="left"
                eyebrow="Templates"
                title="A template is your starting point"
              />

              <p className="max-w-pc-prose text-pc-body text-pretty text-ink-muted">
                Every project begins from a template. It brings starter
                products and settings for a kind of business, and the layout
                the POS uses to show them. The starter products are yours to
                replace.
              </p>

              <p className="max-w-pc-prose text-pc-body text-pretty text-ink-muted">
                The layout comes with the template rather than being a separate
                setting, so pick the template closest to how you sell.
              </p>

              <Link href="/templates" className="pc-textlink self-start font-semibold">
                Compare the templates
              </Link>
            </div>

            <ul className="flex flex-col gap-4">
              {LAYOUTS.map((entry) => (
                <li key={entry.layout} className="pc-card flex flex-col gap-2 p-5">
                  <h3 className="text-base font-semibold tracking-tight text-ink">
                    {entry.name}
                  </h3>
                  <p className="text-pc-meta leading-relaxed text-ink-muted">
                    {entry.description}
                  </p>
                  <p className="text-pc-meta text-ink-subtle">
                    Used by{" "}
                    {templates
                      .filter((template) => template.layout === entry.layout)
                      .map((template) => template.name)
                      .join(", ")}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="bg-surface-raised">
          <div className="pc-container pc-section">
            <SectionHeading
              eyebrow="Live preview"
              title="Check your changes as you make them"
              subtitle="The Builder shows a working preview of your POS beside the settings, so a new price or category is visible before anyone at the counter sees it."
            />

            {/* The approved Task 3D capture, reused because this is the page
                about editing: it shows the Menu section and the live preview
                side by side. Rendered from its provenance record, never from a
                typed path, and with the same narrow-screen treatment as the
                homepage — the capture scrolls inside its own focusable
                viewport rather than shrinking until nothing in it is
                readable. It sits below the fold, so next/image loads it
                lazily. */}
            <figure className="pc-card mx-auto mt-12 max-w-5xl p-3 sm:p-4">
              <p
                aria-hidden="true"
                className="mb-2 px-1 text-pc-meta text-ink-subtle lg:hidden"
              >
                Scroll sideways to see the whole screenshot &rarr;
              </p>

              <div
                className="pc-screenshot-viewport pc-focusable"
                tabIndex={0}
                role="region"
                aria-labelledby="customizable-screenshot-caption"
              >
                <Image
                  src={BUILDER_CAFE_PRODUCTS.src}
                  alt={BUILDER_CAFE_PRODUCTS.alt}
                  width={BUILDER_CAFE_PRODUCTS.width}
                  height={BUILDER_CAFE_PRODUCTS.height}
                  sizes="(min-width: 1080px) 1000px, (min-width: 1024px) 94vw, 992px"
                  className="pc-screenshot-viewport__image h-auto w-full"
                />
              </div>

              <figcaption className="mt-3 flex flex-wrap items-center justify-between gap-2 px-1 text-pc-meta text-ink-subtle">
                <span id="customizable-screenshot-caption">
                  {BUILDER_CAFE_PRODUCTS.caption}
                </span>
                <span className="font-semibold uppercase tracking-wider text-brand-teal-deep">
                  POS Canvas screenshot
                </span>
              </figcaption>
            </figure>
          </div>
        </section>

        <section className="bg-brand-cream">
          <div className="pc-container pc-section">
            <SectionHeading
              align="left"
              eyebrow="Publishing"
              title="From saved settings to the POS on your counter"
              subtitle="Customizing happens in the Builder, and your devices don’t change until you publish."
            />

            <ol className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {PATH_TO_COUNTER.map((step, index) => (
                <li key={step.title} className="pc-card flex flex-col gap-3 p-6">
                  <span
                    aria-hidden="true"
                    className="text-pc-meta font-bold tracking-widest text-brand-teal-deep"
                  >
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <h3 className="text-lg font-semibold tracking-tight text-ink">
                    {step.title}
                  </h3>
                  <p className="text-pc-meta leading-relaxed text-ink-muted">
                    {step.detail}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="bg-surface-raised">
          <div className="pc-container pc-section">
            <div className="mx-auto flex max-w-pc-prose flex-col gap-5">
              <h2 className="text-pc-title font-semibold text-balance text-ink">
                Where customization stops
              </h2>

              <p className="text-pc-body text-pretty text-ink-muted">
                You are setting up a POS that already exists, not programming a
                new one, so there are clear limits to what you can change.
              </p>

              <ul className="pc-callout flex list-disc flex-col gap-3 pl-9 text-pc-body text-ink marker:text-brand-teal-deep">
                <li>
                  You can&rsquo;t add screens, write your own rules or create
                  features of your own.
                </li>
                <li>
                  The layout isn&rsquo;t a setting; it comes from the template
                  you start with.
                </li>
                <li>
                  Checkout doesn&rsquo;t connect to a card reader. POS Canvas
                  records whether each sale was paid in cash or by card.
                </li>
                <li>
                  These are the main business-facing settings available in the
                  Builder; some smaller field-level options are not listed
                  here.
                </li>
              </ul>

              <p className="text-pc-body text-pretty text-ink-muted">
                The reason for those limits is the way POS Canvas is put
                together: one shared app, running your published settings.{" "}
                <Link href={NO_CODE_POS_BUILDER_PAGE.path} className="pc-textlink font-semibold">
                  How the no-code builder works
                </Link>
              </p>
            </div>
          </div>
        </section>

        <LandingClosing
          title="Start from the template closest to your business"
          primary={{ href: "/templates", label: "Browse templates" }}
        >
          Open it in the Builder and adjust the supported settings for your
          business. Once you save your project, you can come back later and make
          more changes.
        </LandingClosing>

        <RelatedPages
          pages={[
            {
              href: POS_FOR_SMALL_BUSINESS_PAGE.path,
              title: "Getting a small business started",
              description:
                "What you need, the steps from account to first sale, and what works from day one.",
            },
            {
              href: NO_CODE_POS_BUILDER_PAGE.path,
              title: "What no-code means in POS Canvas",
              description:
                "How a template, your settings and one shared app make up your POS.",
            },
          ]}
        />
      </main>

      <Footer />
    </div>
  );
}
