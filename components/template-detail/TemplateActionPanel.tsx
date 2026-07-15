import Link from "next/link";

type TemplateActionPanelProps = {
  templateId: string;
};

export default function TemplateActionPanel({
  templateId,
}: TemplateActionPanelProps) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-neutral-200 bg-white p-6">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-neutral-500">
          Ready to go
        </span>
        <span className="text-lg font-semibold text-neutral-900">
          Included with POS Canvas
        </span>
      </div>

      <Link
        href={`/editor/${templateId}`}
        className="w-full rounded-full bg-blue-600 px-6 py-3 text-center text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
      >
        Use Template
      </Link>

      <p className="text-xs leading-relaxed text-neutral-500">
        You can customize items, pricing, and layout after you start building.
      </p>
    </div>
  );
}
