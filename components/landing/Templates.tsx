import Link from "next/link";
import SectionHeading from "./SectionHeading";
import TemplateCard from "./TemplateCard";
import { templates } from "@/data/templates";
import { LANDING_ROUTES, LANDING_SECTION_IDS } from "@/lib/landingNav";

// Navigation fix — this section previously held its own hardcoded list of
// four templates with no ids, which meant its cards had nothing to link to
// (and so "View Template" was a dead button). It also carried titles that
// had drifted from the registry ("Restaurant" vs "Classic Restaurant",
// "Cafe" vs "Cozy Cafe", ...) and silently omitted two real templates.
//
// It now consumes the single canonical registry (data/templates.ts) exactly
// as components/templates/TemplateGrid.tsx already does — the same
// correction Feature 12.1 made for the gallery, which this landing section
// was left out of.
//
// Lane 3 Task 2 — the shortlist is gone and the section renders the WHOLE
// registry. There are six templates; showing four of them meant the landing
// page quietly under-reported what exists, which is the same class of defect
// the hardcoded list caused. Nothing is sliced, so adding a seventh template
// to the registry shows it here with no edit to this file.
//
// THE SUBTITLE IS THE ARCHITECTURE, IN AN OWNER'S WORDS. All six templates run
// the identical POS engine and differ only in their starter configuration and
// layout (see the Feature 12.1 correction note in data/templates.ts). Copy
// that implied six different products would be a marketing claim the codebase
// contradicts, so the section says plainly what a template is: a starting
// point, not a separate system.

export default function Templates() {
  return (
    <section
      id={LANDING_SECTION_IDS.templates}
      className="bg-surface-raised"
    >
      <div className="pc-container pc-section">
        <SectionHeading
          eyebrow="Templates"
          title="Start from something that already looks like your business"
          subtitle="Every template is the same point of sale with different products, categories and layout already set up. Pick the closest one and change whatever you like."
        />

        <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => (
            <TemplateCard
              key={template.id}
              templateId={template.id}
              icon={template.icon}
              title={template.name}
              category={template.category}
              description={template.description}
            />
          ))}
        </div>

        <div className="mt-10 flex justify-center">
          <Link
            href={LANDING_ROUTES.templates}
            className="pc-button pc-button--secondary"
          >
            Browse all templates
          </Link>
        </div>
      </div>
    </section>
  );
}
