import Link from "next/link";
import { templates } from "@/data/templates";

// Feature 12.1 — consumes the single canonical template registry instead of
// its own hardcoded list (which previously included "convenience-store", an
// id with no matching entry anywhere else in the app).
export default function TrendingTemplates() {
  return (
    <section>
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-xl font-semibold tracking-tight text-neutral-900">
          Trending Templates
        </h2>

        {/* Feature 22 Phase 4 — this was a <button> with no onClick and no
            href. The destination it implied already exists, so it is now the
            link it always looked like. */}
        <Link
          href="/templates"
          className="text-sm font-medium text-neutral-600 transition-colors hover:text-blue-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          View all templates
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-5 md:grid-cols-3 lg:grid-cols-6">
        {templates.map((template) => (
          <Link
            key={template.id}
            href={`/templates/${template.id}`}
            className="group flex flex-col items-center gap-3 rounded-2xl border border-neutral-200 bg-white p-6 text-center transition-all hover:-translate-y-1 hover:shadow-md"
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-neutral-100 text-2xl transition-colors group-hover:bg-blue-600">
              <span className="transition-transform group-hover:scale-110">
                {template.icon}
              </span>
            </div>

            <span className="text-sm font-medium text-neutral-900">
              {template.category}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
