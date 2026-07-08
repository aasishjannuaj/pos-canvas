const trendingTemplates = [
  { icon: "🍔", title: "Restaurant" },
  { icon: "☕", title: "Cafe" },
  { icon: "🛍", title: "Retail" },
  { icon: "🍺", title: "Liquor Store" },
  { icon: "💇", title: "Salon" },
  { icon: "🏪", title: "Convenience Store" },
];

export default function TrendingTemplates() {
  return (
    <section>
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-xl font-semibold tracking-tight text-neutral-900">
          Trending Templates
        </h2>

        <button
          type="button"
          className="text-sm font-medium text-neutral-600 transition-colors hover:text-blue-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          View all
        </button>
      </div>

      <div className="grid grid-cols-2 gap-5 md:grid-cols-3 lg:grid-cols-6">
        {trendingTemplates.map((template) => (
          <div
            key={template.title}
            className="group flex flex-col items-center gap-3 rounded-2xl border border-neutral-200 bg-white p-6 text-center transition-all hover:-translate-y-1 hover:shadow-md"
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-neutral-100 text-2xl transition-colors group-hover:bg-blue-600">
              <span className="transition-transform group-hover:scale-110">
                {template.icon}
              </span>
            </div>

            <span className="text-sm font-medium text-neutral-900">
              {template.title}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
