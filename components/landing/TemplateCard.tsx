import Link from "next/link";
import { createTemplateEditorHref } from "@/lib/landingNav";

type TemplateCardProps = {
  templateId: string;
  icon: string;
  title: string;
  category: string;
  description: string;
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
// The whole card is the link, so the entire hover-elevated surface is
// clickable, matching TemplateGalleryCard.
//
// Lane 3 Task 2 — the card now carries the registry's own CATEGORY and
// DESCRIPTION rather than a name alone. Both come from data/templates.ts and
// neither is retyped here: those descriptions were written in Feature 12.1 to
// be honest about the shared engine ("the same checkout, tax, inventory,
// receipt, and reporting tools"), and showing them is what keeps the section
// from implying that each template is a different product. A second,
// marketing-flavoured description typed into this component would be a second
// source of truth about what a template is, and the first one to drift.
export default function TemplateCard({
  templateId,
  icon,
  title,
  category,
  description,
}: TemplateCardProps) {
  return (
    <Link
      href={createTemplateEditorHref(templateId)}
      className="pc-card pc-card--interactive pc-focusable group flex flex-col gap-4 p-6"
    >
      <span
        aria-hidden="true"
        className="flex h-14 w-14 flex-none items-center justify-center rounded-pc-md bg-surface-mint text-3xl"
      >
        {icon}
      </span>

      <div className="flex flex-col gap-1.5">
        <span className="text-pc-meta font-semibold uppercase tracking-wider text-brand-teal-deep">
          {category}
        </span>

        <h3 className="text-lg font-semibold tracking-tight text-ink">
          {title}
        </h3>
      </div>

      <p className="text-pc-meta leading-relaxed text-ink-muted">
        {description}
      </p>

      {/* Presentational: the card itself is the link, so this must not read as
          a second control to a screen reader. */}
      <span
        aria-hidden="true"
        className="mt-auto pt-2 text-pc-meta font-semibold text-brand-teal-deep"
      >
        Open in the builder &rarr;
      </span>
    </Link>
  );
}
