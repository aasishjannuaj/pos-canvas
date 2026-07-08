type TemplatePreviewProps = {
  icon: string;
};

export default function TemplatePreview({ icon }: TemplatePreviewProps) {
  return (
    <div className="flex aspect-video w-full items-center justify-center rounded-2xl border border-neutral-200 bg-white">
      <span className="text-7xl">{icon}</span>
    </div>
  );
}
