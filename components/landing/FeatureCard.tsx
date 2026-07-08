type FeatureCardProps = {
  icon: string;
  title: string;
  description: string;
};

export default function FeatureCard({
  icon,
  title,
  description,
}: FeatureCardProps) {
  return (
    <div className="flex flex-col items-start gap-4 rounded-2xl border border-neutral-200 bg-white p-8">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-neutral-100 text-2xl">
        {icon}
      </div>

      <h3 className="text-lg font-semibold text-neutral-900">{title}</h3>

      <p className="text-sm leading-relaxed text-neutral-600">
        {description}
      </p>
    </div>
  );
}
