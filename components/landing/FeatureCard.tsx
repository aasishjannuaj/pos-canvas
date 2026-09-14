type FeatureCardProps = {
  icon: string;
  title: string;
  description: string;
};

// Lane 3 Task 2 — the same card, drawn from the design system. The icon sits
// on a mint tile rather than a grey one, the surface and radius come from
// `.pc-card`, and the type comes from the scale. The icon is decorative: it
// repeats the title and nothing more, so it is hidden from assistive
// technology rather than announced as an emoji name.
export default function FeatureCard({
  icon,
  title,
  description,
}: FeatureCardProps) {
  return (
    <div className="pc-card flex flex-col items-start gap-4 p-6">
      <span
        aria-hidden="true"
        className="flex h-12 w-12 flex-none items-center justify-center rounded-pc-md bg-surface-mint text-2xl"
      >
        {icon}
      </span>

      <h3 className="text-lg font-semibold tracking-tight text-ink">{title}</h3>

      <p className="text-pc-meta leading-relaxed text-ink-muted">
        {description}
      </p>
    </div>
  );
}
