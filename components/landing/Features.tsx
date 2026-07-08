import SectionHeading from "./SectionHeading";
import FeatureCard from "./FeatureCard";

const features = [
  {
    icon: "🧩",
    title: "No Code Required",
    description:
      "Customize layouts, menus, and pricing without touching a single line of code.",
  },
  {
    icon: "🎨",
    title: "Fully Customizable",
    description:
      "Adjust colors, items, and categories so your POS looks and feels like your business.",
  },
  {
    icon: "⬇️",
    title: "Instant Download",
    description:
      "Export your finished POS app and start using it right away, no waiting required.",
  },
];

export default function Features() {
  return (
    <section id="features" className="mx-auto max-w-6xl px-6 py-24">
      <SectionHeading
        eyebrow="Features"
        title="Everything you need to launch"
        subtitle="POS Canvas handles the setup, so you can focus on running your business."
      />

      <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-3">
        {features.map((feature) => (
          <FeatureCard
            key={feature.title}
            icon={feature.icon}
            title={feature.title}
            description={feature.description}
          />
        ))}
      </div>
    </section>
  );
}
