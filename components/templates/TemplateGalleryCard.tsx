import Link from "next/link";

type TemplateGalleryCardProps = {
  templateId: string;
  icon: string;
  name: string;
  category: string;
  description: string;
};

// Feature 12.1 — templateId now comes directly from the template registry
// (data/templates.ts) instead of being derived by slugifying the category
// label, which could silently produce an id that didn't match anything.
export default function TemplateGalleryCard({
  templateId,
  icon,
  name,
  category,
  description,
}: TemplateGalleryCardProps) {
  return (
    <Link
      href={`/editor/${templateId}`}
      className="group flex flex-col gap-4 rounded-2xl border border-neutral-200 bg-white p-6 transition-all hover:-translate-y-1 hover:shadow-lg hover:shadow-neutral-200/60"
    >
      <div className="flex items-center justify-between">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-neutral-100 text-2xl transition-colors group-hover:bg-blue-600">
          <span className="transition-transform group-hover:scale-110">
            {icon}
          </span>
        </div>

        <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
          {category}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <h3 className="text-lg font-semibold text-neutral-900">{name}</h3>
        <p className="text-sm leading-relaxed text-neutral-600">
          {description}
        </p>
      </div>

      <span className="mt-2 w-full rounded-full border border-neutral-200 px-4 py-2 text-center text-sm font-medium text-neutral-700 transition-colors group-hover:border-blue-600 group-hover:bg-blue-600 group-hover:text-white">
        Use Template
      </span>
    </Link>
  );
}
