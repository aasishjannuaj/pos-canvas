import Link from "next/link";
import PageContainer from "@/components/common/PageContainer";
import TemplateGalleryHeader from "@/components/templates/TemplateGalleryHeader";
import TemplateGrid from "@/components/templates/TemplateGrid";
import type { Metadata } from "next";
import { POS_FOR_SMALL_BUSINESS_PAGE } from "@/lib/landingPages";
import { absoluteUrl, buildOpenGraph } from "@/lib/seo";

// Lane 3 Task 3 — an indexable public page, canonicalising to itself.
//
// This is the second page worth finding in search: someone looking for a POS
// for their kind of business lands on the list of starting points.
//
// THE TITLE IS BOUNDED, AND THAT IS THE POINT. It read "POS templates for
// every kind of business", which is a breadth-of-support claim this product
// cannot back: there are SIX canonical templates, not a template for every
// trade. Task 2 had already deleted exactly that sentence from the Business
// Types section ("Built for every kind of business") and this metadata quietly
// reintroduced it one task later — which is precisely why the guard in
// lib/seo.guards.test.ts now fails on the phrase rather than trusting anyone
// to remember.
//
// The description names the six REAL categories instead of promising all of
// them. Those names are checked against data/templates.ts by that same guard,
// so a seventh template or a renamed category makes this description a test
// failure rather than a quiet inaccuracy.
export const metadata: Metadata = {
  title: "Customizable POS templates for small businesses",
  description:
    "Browse ready-made POS templates for restaurants, cafes, retail, liquor " +
    "stores, food trucks and salons. Each one is the same point of sale, " +
    "ready to customize.",
  alternates: { canonical: absoluteUrl("/templates") },
  openGraph: buildOpenGraph({
    title: "Customizable POS templates for small businesses",
    description:
      "Ready-made POS templates for restaurants, cafes, retail, liquor " +
      "stores, food trucks and salons.",
    path: "/templates",
  }),
};

export default function TemplatesPage() {
  return (
    <main className="min-h-screen bg-neutral-50">
      <PageContainer>
        <div className="flex flex-col gap-12">
          <TemplateGalleryHeader />
          <TemplateGrid />

          {/* Lane 3 Task 4 — the one way into the SEO landing pages from the
              existing site. Someone comparing templates may really be asking
              whether POS Canvas suits a small or new business; this answers
              that, and the page it opens links on to the other two. One
              contextual sentence, in the gallery's own neutral styling, with
              the site-wide focus ring — not a directory of SEO pages. */}
          <p className="text-center text-sm text-neutral-600">
            Setting up a point of sale for a small or new business?{" "}
            <Link
              href={POS_FOR_SMALL_BUSINESS_PAGE.path}
              className="pc-focusable rounded-sm font-medium text-neutral-900 underline underline-offset-4 hover:text-neutral-700"
            >
              See how POS Canvas works for a small business
            </Link>
          </p>
        </div>
      </PageContainer>
    </main>
  );
}