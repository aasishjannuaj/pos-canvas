type TemplateDetailHeaderProps = {
  name: string;
  category: string;
  description: string;
};

export default function TemplateDetailHeader({
  name,
  category,
  description,
}: TemplateDetailHeaderProps) {
  return (
    <div className="flex flex-col gap-4">
      <span className="text-sm font-medium text-neutral-500">
        Templates / {category}
      </span>

      <div className="flex flex-col gap-3">
        <span className="w-fit rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
          {category}
        </span>

        <h1 className="text-4xl font-semibold tracking-tight text-neutral-900 md:text-5xl">
          {name}
        </h1>

        <p className="max-w-2xl text-base text-neutral-600 md:text-lg">
          {description}
        </p>
      </div>
    </div>
  );
}
