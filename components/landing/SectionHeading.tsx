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
  const alignment = align === "center" ? "text-center items-center" : "text-left items-start";

  return (
    <div className={`flex flex-col gap-3 ${alignment}`}>
      <span className="text-xs font-semibold uppercase tracking-wide text-blue-600">
        {eyebrow}
      </span>

      <h2 className="text-3xl md:text-4xl font-semibold tracking-tight text-neutral-900">
        {title}
      </h2>

      {subtitle ? (
        <p className="max-w-2xl text-base md:text-lg text-neutral-600">
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}
