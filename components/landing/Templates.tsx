import SectionHeading from "./SectionHeading";
import TemplateCard from "./TemplateCard";
import { templates } from "@/data/templates";
import { LANDING_SECTION_IDS } from "@/lib/landingNav";

// Navigation fix — this section previously held its own hardcoded list of
// four templates with no ids, which meant its cards had nothing to link to
// (and so "View Template" was a dead button). It also carried titles that
// had drifted from the registry ("Restaurant" vs "Classic Restaurant",
// "Cafe" vs "Cozy Cafe", ...) and silently omitted two real templates.
//
// It now consumes the single canonical registry (data/templates.ts) exactly
// as components/templates/TemplateGrid.tsx already does — the same
// correction Feature 12.1 made for the gallery, which this landing section
// was left out of. The landing page still shows a shortlist rather than the
// full gallery, so it takes the first four registry entries; /templates
// remains the place that lists all of them.
const LANDING_TEMPLATE_COUNT = 4;

const featuredTemplates = templates.slice(0, LANDING_TEMPLATE_COUNT);

export default function Templates() {
  return (
    <section
      id={LANDING_SECTION_IDS.templates}
      className="mx-auto max-w-6xl px-6 py-24"
    >
      <SectionHeading
        eyebrow="Templates"
        title="Popular Templates"
        subtitle="Start from a template built for your business, then make it your own."
      />

      <div className="mt-12 grid grid-cols-2 gap-6 md:grid-cols-4">
        {featuredTemplates.map((template) => (
          <TemplateCard
            key={template.id}
            templateId={template.id}
            icon={template.icon}
            title={template.name}
          />
        ))}
      </div>
    </section>
  );
}
