import Link from "next/link";
import type { SavedProject } from "@/lib/projects";

type RecentProjectsProps = {
  projects: SavedProject[];
};

const THUMBNAIL_COLORS = ["bg-blue-100", "bg-amber-100", "bg-emerald-100", "bg-rose-100"];

function formatTemplateName(templateId: string): string {
  return templateId
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatUpdatedAt(updatedAt: string): string {
  return new Date(updatedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function RecentProjects({ projects }: RecentProjectsProps) {
  const visibleProjects = projects.slice(0, 4);

  return (
    <section>
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-xl font-semibold tracking-tight text-neutral-900">
          Recent Projects
        </h2>

        <button
          type="button"
          className="text-sm font-medium text-neutral-600 transition-colors hover:text-blue-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          View all
        </button>
      </div>

      {visibleProjects.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-neutral-200 bg-white p-10 text-center">
          <p className="text-sm font-medium text-neutral-900">
            No saved projects yet.
          </p>
          <p className="text-sm text-neutral-500">
            Choose a template to create your first POS.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
          {visibleProjects.map((project, index) => (
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
