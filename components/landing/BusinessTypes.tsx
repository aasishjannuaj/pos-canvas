import SectionHeading from "./SectionHeading";

const businessTypes = [
  "Restaurants",
  "Coffee Shops",
  "Retail Stores",
  "Liquor Stores",
  "Food Trucks",
  "Salons",
  "Barbers",
  "Convenience Stores",
];

export default function BusinessTypes() {
  return (
    <section className="mx-auto max-w-4xl px-6 py-16">
      <SectionHeading
        eyebrow="Business Types"
        title="Built for every kind of business"
      />

      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        {businessTypes.map((type) => (
          <span
            key={type}
            className="rounded-full border border-neutral-200 px-5 py-2 text-sm font-medium text-neutral-700 transition-colors hover:border-blue-600 hover:text-blue-600"
          >
            {type}
          </span>
        ))}
      </div>
    </section>
  );
}
