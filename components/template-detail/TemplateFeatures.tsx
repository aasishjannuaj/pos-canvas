type TemplateFeaturesProps = {
  features: string[];
};

export default function TemplateFeatures({ features }: TemplateFeaturesProps) {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold tracking-tight text-neutral-900">
        What&apos;s included
      </h2>

      <ul className="flex flex-col gap-3">
        {features.map((feature) => (
          <li key={feature} className="flex items-start gap-3">
            <span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full bg-blue-600 text-white">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-3 w-3"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>

            <span className="text-sm leading-relaxed text-neutral-700 md:text-base">
              {feature}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
