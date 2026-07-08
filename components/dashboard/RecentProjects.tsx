const recentProjects = [
  { name: "Downtown Cafe POS", updated: "Edited 2 hours ago", color: "bg-blue-100" },
  { name: "Riverside Diner", updated: "Edited yesterday", color: "bg-amber-100" },
  { name: "Main St. Retail", updated: "Edited 3 days ago", color: "bg-emerald-100" },
  { name: "Corner Liquor Shop", updated: "Edited 1 week ago", color: "bg-rose-100" },
];

export default function RecentProjects() {
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

      <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
        {recentProjects.map((project) => (
          <div
            key={project.name}
            className="flex flex-col gap-3 rounded-2xl border border-neutral-200 bg-white p-3 transition-shadow hover:shadow-md"
          >
            <div className={`aspect-video w-full rounded-xl ${project.color}`} />

            <div className="flex flex-col gap-0.5 px-1 pb-1">
              <span className="text-sm font-medium text-neutral-900">
                {project.name}
              </span>
              <span className="text-xs text-neutral-500">
                {project.updated}
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
