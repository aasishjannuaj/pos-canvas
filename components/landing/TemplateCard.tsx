import Link from "next/link";
import { createTemplateEditorHref } from "@/lib/landingNav";

type TemplateCardProps = {
  templateId: string;
  icon: string;
  title: string;
};

// Navigation fix — "View Template" was a <button type="button"> with no
// onClick and no href, so clicking it silently did nothing. It is now a real
// Link to /editor/{templateId}, matching the canonical destination
// components/templates/TemplateGalleryCard.tsx and
// components/template-detail/TemplateActionPanel.tsx already use.
//
// templateId is now a required prop: previously this component received only
// an icon and a title, so it had no id to navigate to at all — the caller
// (Templates.tsx) held a hardcoded list with no ids. That list now comes
// from the canonical registry instead.
//
// The whole card is the link (not just the inner pill), so the entire
// hover-elevated surface is clickable, matching TemplateGalleryCard. Styling
// is unchanged; the inner element is a <span> styled exactly as the old
// button was.
export default function TemplateCard({
  templateId,
  icon,
  title,
}: TemplateCardProps) {
  return (
    <Link
      href={createTemplateEditorHref(templateId)}
      className="group flex flex-col items-center gap-4 rounded-2xl border border-neutral-200 bg-white p-8 text-center transition-all duration-200 hover:-translate-y-1 hover:shadow-lg hover:shadow-neutral-200/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
    >
      <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-neutral-100 text-3xl transition-colors duration-200 group-hover:bg-blue-600">
        <span className="transition-transform duration-200 group-hover:scale-110">
          {icon}
        </span>
      </div>

      <h3 className="text-lg font-semibold text-neutral-900">{title}</h3>

      <span className="rounded-full border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 transition-colors group-hover:border-blue-600 group-hover:text-blue-600">
        View Template
      </span>
    </Link>
  );
}
