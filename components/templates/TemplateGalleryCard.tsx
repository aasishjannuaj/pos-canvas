type TemplateGalleryCardProps = {
  icon: string;
  name: string;
  category: string;
  description: string;
};

export default function TemplateGalleryCard({
  icon,
  name,
  category,
  description,
}: TemplateGalleryCardProps) {
  return (
    <div className="group flex flex-col gap-4 rounded-2xl border border-neutral-200 bg-white p-6 transition-all hover:-translate-y-1 hover:shadow-lg hover:shadow-neutral-200/60">
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

      <button
        type="button"
        className="mt-2 w-full rounded-full border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:border-blue-600 hover:bg-blue-600 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
      >
        Use Template
      </button>
    </div>
  );
}
