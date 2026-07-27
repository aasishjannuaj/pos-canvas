import { notFound, redirect } from "next/navigation";
import EditorShell from "@/components/editor/EditorShell";
import { getProjectById } from "@/lib/projects.server";
import { getProjectOrders } from "@/lib/orders.server";
import { getProjectInventoryTransactions } from "@/lib/inventory.server";
import { getProjectOrderTotals } from "@/lib/dashboard.server";
import type { ProjectConfig } from "@/lib/projectConfig";
import { DEFAULT_POS_LAYOUT } from "@/lib/posLayout";
import { getTemplateById, getStarterConfig } from "@/data/templates";

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

    // Order history, inventory-activity history, and dashboard order totals
    // are all independent of the project lookup above — a failure in any of
    // them should never turn a valid project into a 404, it just means the
    // editor opens with an empty list for that section.
    const { orders } = await getProjectOrders(project.id);
    const {
      transactions,
      error: inventoryTransactionsError,
    } = await getProjectInventoryTransactions(project.id);
    const { orderTotals, error: orderTotalsError } = await getProjectOrderTotals(
      project.id
    );

    // Feature 12.3 — layout is derived from the saved template_id, never
    // persisted separately. A legacy or unknown template_id (one that
    // doesn't match any registered template) safely falls back to
    // DEFAULT_POS_LAYOUT — this only affects which product-browser
    // component renders below; it never touches project.config.
    const layout = getTemplateById(project.template_id)?.layout ?? DEFAULT_POS_LAYOUT;

    return (
      <EditorShell
        initialProjectName={project.name}
        templateId={project.template_id}
        initialConfig={initialConfig}
        initialProjectId={project.id}
        initialCompletedOrders={orders}
        initialInventoryTransactions={transactions}
        initialInventoryTransactionsError={inventoryTransactionsError}
        initialOrderTotals={orderTotals}
        initialOrderTotalsError={orderTotalsError}
        layout={layout}
      />
    );
  }

  // Feature 12.1 correction — a brand-new, not-yet-saved project must use a
  // real, known template. Previously an unknown id here silently fell back
  // to the shared default starter configuration while keeping the
  // unrecognized id as templateId — that let an unsupported project get
  // created under an id that isn't actually a template. This restriction is
  // scoped to brand-new URLs only: an existing saved project with a legacy
  // or unknown template_id (branch above) is untouched and always loads
  // with its own persisted config, regardless of whether that id still
  // matches a registered template.
  const template = getTemplateById(id);

  if (!template) {
    redirect("/templates");
  }

  // The registry's starter configuration (already a fresh, safely-cloned
  // copy — see getStarterConfig) seeds this session. Once the project is
  // saved, opening it again always goes through the branch above, which
  // loads the project's own persisted `config` column — the registry is
  // never consulted again, and a saved project's customized data can never
  // be replaced or merged with starter data.
  const starterConfig = getStarterConfig(id);

  return (
    <EditorShell
      initialProjectName={template.name}
      templateId={id}
      initialConfig={starterConfig}
      layout={template.layout}
    />
  );
}
