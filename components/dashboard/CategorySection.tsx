const categories = [
  "Restaurants",
  "Coffee Shops",
  "Retail Stores",
  "Liquor Stores",
  "Food Trucks",
  "Salons",
  "Barbers",
  "Convenience Stores",
];

export default function CategorySection() {
  return (
    <section>
      <h2 className="mb-6 text-xl font-semibold tracking-tight text-neutral-900">
        Browse by Category
      </h2>

      <div className="flex flex-wrap gap-3">
        {categories.map((category) => (
          <button
            key={category}
            type="button"
            className="rounded-full border border-neutral-200 bg-white px-5 py-2 text-sm font-medium text-neutral-700 transition-colors hover:border-blue-600 hover:text-blue-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            {category}
          </button>
        ))}
      </div>
    </section>
  );
}
