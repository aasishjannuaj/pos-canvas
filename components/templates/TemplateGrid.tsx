import TemplateGalleryCard from "./TemplateGalleryCard";
import { templates } from "@/data/templates";

// Feature 12.1 — consumes the single canonical template registry instead of
// its own hardcoded list. The registry only has the 6 templates with
// consistent representation elsewhere in the app (see data/templates.ts);
// two extra cards that used to appear only here ("Barber Shop", "Corner
// Convenience") were dropped rather than fabricated to match.
export default function TemplateGrid() {
  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
      {templates.map((template) => (
        <TemplateGalleryCard
          key={template.id}
          templateId={template.id}
          icon={template.icon}
          name={template.name}
          category={template.category}
          description={template.description}
        />
      ))}
    </div>
  );
}
