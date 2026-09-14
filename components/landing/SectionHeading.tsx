// Lane 3 Task 2 — every homepage section's heading, drawn from the design
// system rather than from its own opinion.
//
// This used to hardcode `text-blue-600`, `text-neutral-900` and
// `text-neutral-600`, which is where most of the page's "default Tailwind"
// look came from: six sections inherited a palette nobody had chosen. It now
// uses the Task 1 tokens, so the eyebrow, the heading and the subtitle move
// with the design system instead of against it.

type SectionHeadingProps = {
  eyebrow: string;
  title: string;
  subtitle?: string;
  align?: "center" | "left";
};

export default function SectionHeading({
  eyebrow,
  title,
  subtitle,
  align = "center",
}: SectionHeadingProps) {
  const alignment =
    align === "center" ? "items-center text-center" : "items-start text-left";

  return (
    <div className={`flex flex-col gap-4 ${alignment}`}>
      <span className="pc-eyebrow">{eyebrow}</span>

      <h2 className="text-pc-title font-semibold text-balance text-ink">
        {title}
      </h2>

      {subtitle ? (
        <p className="max-w-pc-prose text-pc-lead text-pretty text-ink-muted">
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}
