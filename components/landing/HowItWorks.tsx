import SectionHeading from "./SectionHeading";

const steps = [
  {
    number: "01",
    title: "Choose a template",
    description: "Pick the template that matches your business type.",
  },
  {
    number: "02",
    title: "Customize your POS",
    description: "Adjust items, pricing, and layout to fit how you work.",
  },
  {
    number: "03",
    title: "Download your app",
    description: "Export your POS and start taking orders right away.",
  },
];

export default function HowItWorks() {
  return (
    <section id="how-it-works" className="mx-auto max-w-6xl px-6 py-24">
      <SectionHeading
        eyebrow="How It Works"
        title="From template to launch in three steps"
      />

      <div className="mt-12 grid grid-cols-1 gap-8 md:grid-cols-3">
        {steps.map((step) => (
          <div key={step.number} className="flex flex-col items-center gap-3 text-center">
            <span className="text-sm font-semibold tracking-wide text-blue-600">
              {step.number}
            </span>

            <h3 className="text-lg font-semibold text-neutral-900">
              {step.title}
            </h3>

            <p className="max-w-xs text-sm leading-relaxed text-neutral-600">
              {step.description}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
