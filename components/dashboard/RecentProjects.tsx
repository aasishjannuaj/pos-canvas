import Link from "next/link";
import type { SavedProject } from "@/lib/projects";
import { getTemplateById } from "@/data/templates";
import {
  CREATE_PROJECT_LABEL,
  CREATE_PROJECT_PATH,
  type DashboardProjectsState,
} from "@/lib/dashboardState";

type RecentProjectsProps = {
  projects: SavedProject[];
  state: DashboardProjectsState;
};

const THUMBNAIL_COLORS = ["bg-blue-100", "bg-amber-100", "bg-emerald-100", "bg-rose-100"];

// Feature 12.1 — last-resort fallback for a legacy/unrecognized template_id
// that doesn't match any registered template. Display-only: never blocks a
// project from loading, and never touches the project's own saved config.
function formatFallbackTemplateName(templateId: string): string {
  return templateId
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatTemplateName(templateId: string): string {
  return getTemplateById(templateId)?.name ?? formatFallbackTemplateName(templateId);
}

function formatUpdatedAt(updatedAt: string): string {
  return new Date(updatedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function RecentProjects({ projects, state }: RecentProjectsProps) {
  return (
    <section>
      <div className="mb-6">
        <h2 className="text-xl font-semibold tracking-tight text-neutral-900">
          Your Projects
        </h2>
      </div>

      {/* Feature 22 Phase 4 — three states, and only three. The "unavailable"
          branch exists so a failed load is never dressed up as a new account:
          the empty state below invites someone to create their first project,
          which is the wrong thing to say to an owner whose ten projects simply
          did not load. No provider error is shown either way. */}
      {state === "unavailable" ? (
        <div className="rounded-2xl border border-neutral-200 bg-white p-10 text-center">
          <p className="text-sm font-medium text-neutral-900">
            We couldn&apos;t load your projects.
          </p>
          <p className="mt-1 text-sm text-neutral-500">
            Refresh the page to try again. Nothing has been lost.
          </p>
        </div>
      ) : state === "empty" ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-neutral-200 bg-white p-10 text-center">
          <p className="text-sm font-medium text-neutral-900">No projects yet.</p>

          <p className="max-w-md text-sm text-neutral-500">
            Start from a template — you can change every item, price and layout
            afterwards.
          </p>

          <Link
            href={CREATE_PROJECT_PATH}
            className="mt-1 rounded-full bg-blue-600 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            {CREATE_PROJECT_LABEL}
          </Link>
        </div>
      ) : (
        // Feature 22 Phase 4 — every project is listed, not the first four.
        // This section used to slice to 4 behind a "View all" button that had
        // no destination; removing the dead button without removing the slice
        // would have stranded a fifth project with no way to reach it.
        <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
          {projects.map((project, index) => (
            <Link
              key={project.id}
              href={`/editor/project-${project.id}`}
              className="flex flex-col gap-3 rounded-2xl border border-neutral-200 bg-white p-3 transition-shadow hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
            >
              <div
                className={`aspect-video w-full rounded-xl ${
                  THUMBNAIL_COLORS[index % THUMBNAIL_COLORS.length]
                }`}
              />

              <div className="flex flex-col gap-0.5 px-1 pb-1">
                <span className="text-sm font-medium text-neutral-900">
                  {project.name}
                </span>
                <span className="text-xs text-neutral-500">
                  {formatTemplateName(project.template_id)} · Edited{" "}
                  {formatUpdatedAt(project.updated_at)}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
