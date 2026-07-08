export default function DashboardHeader() {
  return (
    <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight text-neutral-900">
          Welcome back
        </h1>
        <p className="text-base text-neutral-600">
          Pick up where you left off, or start something new.
        </p>
      </div>

      <div className="flex items-center gap-4">
        <button
          type="button"
          className="rounded-full bg-blue-600 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          New Project
        </button>

        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-neutral-200 text-sm font-semibold text-neutral-700">
          PC
        </div>
      </div>
    </div>
  );
}
