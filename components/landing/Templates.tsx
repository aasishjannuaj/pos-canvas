import SectionHeading from "./SectionHeading";
import TemplateCard from "./TemplateCard";

const templates = [
  { icon: "🍔", title: "Restaurant" },
  { icon: "☕", title: "Cafe" },
  { icon: "🛍", title: "Retail" },
  { icon: "🍺", title: "Liquor Store" },
];

export default function Templates() {
  return (
    <section id="templates" className="mx-auto max-w-6xl px-6 py-24">
      <SectionHeading
        eyebrow="Templates"
        title="Popular Templates"
        subtitle="Start from a template built for your business, then make it your own."
      />

      <div className="mt-12 grid grid-cols-2 gap-6 md:grid-cols-4">
        {templates.map((template) => (
          <TemplateCard
            key={template.title}
            icon={template.icon}
            title={template.title}
          />
        ))}
      </div>
    </section>
  );
}
