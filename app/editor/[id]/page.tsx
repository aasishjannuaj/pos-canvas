import { notFound } from "next/navigation";
import EditorShell from "@/components/editor/EditorShell";
import { getProjectById } from "@/lib/projects.server";
import type { ProjectConfig } from "@/components/editor/EditorShell";

const projectNames: Record<string, string> = {
  restaurant: "Classic Restaurant",
  cafe: "Cozy Cafe",
  retail: "Modern Retail",
  "liquor-store": "Liquor Store Essentials",
  "food-truck": "Street Food Truck",
  salon: "Salon & Spa",
};

function formatFallbackName(id: string): string {
  return id
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const PROJECT_ROUTE_PREFIX = "project-";

function isProjectConfig(value: unknown): value is ProjectConfig {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    Array.isArray(candidate.menuItems) &&
    typeof candidate.branding === "object" &&
    candidate.branding !== null &&
    typeof candidate.tax === "object" &&
    candidate.tax !== null &&
    typeof candidate.receipt === "object" &&
    candidate.receipt !== null
  );
}

export default async function EditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  if (id.startsWith(PROJECT_ROUTE_PREFIX)) {
    const projectId = id.slice(PROJECT_ROUTE_PREFIX.length);
    const { project, error } = await getProjectById(projectId);

    if (error || !project) {
      notFound();
    }

    const initialConfig = isProjectConfig(project.config)
      ? project.config
      : undefined;

    return (
      <EditorShell
        projectName={project.name}
        templateId={project.template_id}
        initialConfig={initialConfig}
        initialProjectId={project.id}
      />
    );
  }

  const projectName = projectNames[id] ?? formatFallbackName(id);

  return <EditorShell projectName={projectName} templateId={id} />;
}
