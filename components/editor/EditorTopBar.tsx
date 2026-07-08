import Link from "next/link";

type EditorTopBarProps = {
  projectName: string;
};

export default function EditorTopBar({ projectName }: EditorTopBarProps) {
  return (
    <header className="flex h-16 flex-none items-center justify-between border-b border-neutral-200 bg-white px-6">
      <div className="flex items-center gap-4">
        <Link
          href="/dashboard"
          className="text-sm font-medium text-neutral-500 transition-colors hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          ← Back
        </Link>

        <span className="h-5 w-px bg-neutral-200" />

        <span className="text-sm font-semibold text-neutral-900">
          {projectName}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          className="rounded-full border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:border-blue-600 hover:text-blue-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          Preview
        </button>

        <button
          type="button"
          className="rounded-full bg-blue-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          Save
        </button>
      </div>
    </header>
  );
}
