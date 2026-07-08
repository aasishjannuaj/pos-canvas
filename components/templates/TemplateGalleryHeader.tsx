const filters = ["All", "Restaurant", "Cafe", "Retail", "Salon", "Food Truck"];

export default function TemplateGalleryHeader() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2 text-center">
        <h1 className="text-4xl font-semibold tracking-tight text-neutral-900">
          Template Gallery
        </h1>
        <p className="mx-auto max-w-xl text-base text-neutral-600 md:text-lg">
          Browse ready-made POS templates for every kind of business, and
          start building in seconds.
        </p>
      </div>

      <div className="flex flex-col items-center gap-4">
        <div className="relative w-full max-w-xl">
          <span className="pointer-events-none absolute inset-y-0 left-4 flex items-center text-neutral-400">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </span>

          <input
            type="text"
            placeholder="Search templates..."
            className="w-full rounded-full border border-neutral-200 bg-white py-3 pl-12 pr-5 text-sm text-neutral-900 placeholder-neutral-400 transition-colors focus:border-blue-600 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          />
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3">
          {filters.map((filter, index) => (
            <button
              key={filter}
              type="button"
              className={`rounded-full border px-5 py-2 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
                index === 0
                  ? "border-blue-600 bg-blue-600 text-white"
                  : "border-neutral-200 bg-white text-neutral-700 hover:border-blue-600 hover:text-blue-600"
              }`}
            >
              {filter}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
