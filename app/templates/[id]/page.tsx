import Link from "next/link";
import PageContainer from "@/components/common/PageContainer";
import TemplateDetailHeader from "@/components/template-detail/TemplateDetailHeader";
import TemplatePreview from "@/components/template-detail/TemplatePreview";
import TemplateFeatures from "@/components/template-detail/TemplateFeatures";
import TemplateActionPanel from "@/components/template-detail/TemplateActionPanel";
import { getTemplateById } from "@/data/templates";

export default async function TemplateDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const template = getTemplateById(id);

  // Feature 12.1 correction — an unknown id must never render the normal
  // "Use Template" action or link to /editor/{id}. Previously this silently
  // substituted a generic placeholder template, which still let a project
  // be created under an unsupported id. Now it's a clear unavailable state
  // with a way back to the real template list, and nothing that creates a
  // project.
  if (!template) {
    return (
      <main className="min-h-screen bg-neutral-50">
        <PageContainer>
          <div className="flex flex-col items-center gap-4 py-24 text-center">
            <span className="text-4xl">🧭</span>
            <h1 className="text-2xl font-semibold text-neutral-900">
              Template Unavailable
            </h1>
            <p className="max-w-md text-sm text-neutral-500">
              We couldn&apos;t find a template matching &quot;{id}&quot;.
              Browse the templates that are available today.
            </p>
            <Link
              href="/templates"
              className="rounded-full bg-blue-600 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
            >
              Back to Templates
            </Link>
          </div>
        </PageContainer>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-neutral-50">
      <PageContainer>
        <div className="flex flex-col gap-10">
          <TemplateDetailHeader
            name={template.name}
            category={template.category}
            description={template.description}
          />

          <div className="grid grid-cols-1 gap-10 lg:grid-cols-3">
            <div className="flex flex-col gap-10 lg:col-span-2">
              <TemplatePreview icon={template.icon} />
              <TemplateFeatures features={template.features} />
            </div>

            <div className="lg:col-span-1">
              <TemplateActionPanel templateId={id} />
            </div>
          </div>
        </div>
      </PageContainer>
    </main>
  );
}
