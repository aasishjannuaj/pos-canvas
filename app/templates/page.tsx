import PageContainer from "@/components/common/PageContainer";
import TemplateGalleryHeader from "@/components/templates/TemplateGalleryHeader";
import TemplateGrid from "@/components/templates/TemplateGrid";

export default function TemplatesPage() {
  return (
    <main className="min-h-screen bg-neutral-50">
      <PageContainer>
        <div className="flex flex-col gap-12">
          <TemplateGalleryHeader />
          <TemplateGrid />
        </div>
      </PageContainer>
    </main>
  );
}