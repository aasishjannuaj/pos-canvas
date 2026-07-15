import Link from "next/link";
import type { EditorMode, SaveStatus } from "./EditorShell";

type EditorTopBarProps = {
  projectName: string;
  onSave: () => void;
  saveStatus: SaveStatus;
  saveError: string | null;
  editorMode: EditorMode;
  onToggleEditorMode: () => void;
};

const SAVE_BUTTON_LABEL: Record<SaveStatus, string> = {
  idle: "Save",
  saving: "Saving...",
  saved: "Saved",
  error: "Try Again",
};

export default function EditorTopBar({
  projectName,
  onSave,
  saveStatus,
  saveError,
  editorMode,
  onToggleEditorMode,
}: EditorTopBarProps) {
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
          onClick={onToggleEditorMode}
          className="rounded-full border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:border-blue-600 hover:text-blue-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          {editorMode === "edit" ? "Preview" : "Back to Edit"}
        </button>

        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            onClick={onSave}
            disabled={saveStatus === "saving"}
            className="rounded-full bg-blue-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {SAVE_BUTTON_LABEL[saveStatus]}
          </button>

          {saveError && <span className="text-xs text-red-600">{saveError}</span>}
        </div>
      </div>
    </header>
  );
}
