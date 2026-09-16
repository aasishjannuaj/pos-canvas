import Navbar from "@/components/landing/Navbar";
import Hero from "@/components/landing/Hero";
import Templates from "@/components/landing/Templates";
import BusinessTypes from "@/components/landing/BusinessTypes";
import Features from "@/components/landing/Features";
import HowItWorks from "@/components/landing/HowItWorks";
import PlatformAvailability from "@/components/landing/PlatformAvailability";
import CTASection from "@/components/landing/CTASection";
import LearnDiscovery from "@/components/landing/LearnDiscovery";
import Footer from "@/components/landing/Footer";
import type { Metadata } from "next";
import {
  absoluteUrl,
  buildOpenGraph,
  buildSoftwareApplicationJsonLd,
  buildWebSiteJsonLd,
} from "@/lib/seo";

// Lane 3 Task 2 — the page ground is the design system's cream rather than
// bg-neutral-50, so the gap under a short page and the seam at every section
// boundary are the site's own colour instead of a cool grey that belonged to
// no palette. The section ORDER is unchanged, and
// lib/platformDiscoverability.guards.test.ts asserts part of it:
// PlatformAvailability sits between HowItWorks and CTASection.
//
// The sections alternate deliberately — cream hero, white templates, cream
// explanation, white features, mint walkthrough, white platforms, teal call to
// action, cream footer — so a visitor can tell where one idea ends and the next
// begins without a rule between them.
// Lane 3 Task 3 — the homepage's own metadata.
//
// `title.absolute` rather than a plain string: the root layout's template
// appends " · POS Canvas" to every page title, which is right for /templates
// and wrong here — the homepage would read "POS Canvas — ... · POS Canvas".
// absolute opts this one page out of the template.
//
// The description is the product, in the order an owner meets it, and nothing
// else. No pricing, no trial, no counts, no v1.3 capability. It is the same
// claim the page itself makes, which is the only description worth writing:
// a snippet that promises something the page does not deliver is a bounce.
export const metadata: Metadata = {
  title: {
    absolute: "POS Canvas — Customizable POS software for small businesses",
  },
  description:
    "Choose a template, customize your products, prices and branding, then " +
    "publish. Install POS Canvas on Android or Windows and pair a device to " +
    "start selling.",
  alternates: { canonical: absoluteUrl("/") },
  openGraph: buildOpenGraph({
    title: "POS Canvas — Customizable POS software for small businesses",
    description:
      "Choose a template, customize it for your business, publish, then pair " +
      "an Android or Windows device to start selling.",
    path: "/",
  }),
};

export default function Home() {
  return (
    <main className="min-h-screen bg-brand-cream">
      {/* Structured data for the site and the product. Both are built in
          lib/seo.ts from values that already exist — the brand module and the
          release model — so neither can claim a platform the product does not
          ship on. There is deliberately no Organization block and no pricing,
          rating or review field; lib/seo.ts records why.

          `application/ld+json` is data, not executable script, and the content
          is a constant built at render time from repository values — no user
          input reaches it, so there is nothing here to escape. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify([
            buildWebSiteJsonLd(),
            buildSoftwareApplicationJsonLd(),
          ]),
        }}
      />

      <Navbar />
      <Hero />
      <Templates />
      <BusinessTypes />
      <Features />
      <HowItWorks />
      <PlatformAvailability />
      {/* Lane 3 Task 3C — Learn discovery, between the platform answer and the
          call to action. A reader who has just learned what they would install
          is the one most likely to want to read further before committing, and
          it keeps lib/platformDiscoverability.guards.test.ts's ordering intact:
          PlatformAvailability still sits between HowItWorks and CTASection. */}
      <LearnDiscovery />
      <CTASection />
      <Footer />
    </main>
  );
}
