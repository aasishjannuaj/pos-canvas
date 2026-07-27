import Link from "next/link";
import type { EditorMode, SaveStatus } from "./EditorShell";

type EditorTopBarProps = {
  projectName: string;
  onProjectNameChange: (name: string) => void;
  onSave: () => void;
  isDirty: boolean;
  saveStatus: SaveStatus;
  saveError: string | null;
  editorMode: EditorMode;
  onToggleEditorMode: () => void;
};

// Feature 13.2 — button text only. The separate status label (below) is
// what actually communicates Saved/Unsaved/Saving/Failed — the button
// itself only ever needs to say what clicking it will do.
const SAVE_BUTTON_LABEL: Record<SaveStatus, string> = {
  idle: "Save",
  saving: "Saving…",
  saved: "Save",
  error: "Try Again",
};

const BACK_LINK_CONFIRM_MESSAGE = "You have unsaved changes. Leave this page?";

// Feature 13.2 — the single source of the four required status labels,
// derived from isDirty + saveStatus rather than stored as its own state.
// Priority: an in-flight or just-failed save attempt always wins over
// dirty/clean, since it describes the most recent thing that actually
// happened; otherwise it's purely "is there something to save right now."
function getStatusLabel(isDirty: boolean, saveStatus: SaveStatus): string {
  if (saveStatus === "saving") {
    return "Saving…";
  }

  if (saveStatus === "error") {
    return "Save failed";
  }

  return isDirty ? "Unsaved changes" : "Saved";
}

function getStatusClassName(isDirty: boolean, saveStatus: SaveStatus): string {
  if (saveStatus === "saving") {
    return "text-neutral-500";
  }

  if (saveStatus === "error") {
    return "text-red-600";
  }

  return isDirty ? "text-amber-600" : "text-emerald-600";
}

export default function EditorTopBar({
  projectName,
  onProjectNameChange,
  onSave,
  isDirty,
  saveStatus,
  saveError,
  editorMode,
  onToggleEditorMode,
}: EditorTopBarProps) {
  // Feature 13.2 — disabled while a save is in flight, and disabled when
  // there is nothing to save and no failed attempt to retry. Re-enabled the
  // moment saveStatus is "error" (even if isDirty happens to be false),
  // since a failed save must always be retryable.
  const isSaveDisabled =
    saveStatus === "saving" || (!isDirty && saveStatus !== "error");

  return (
    <header className="flex h-16 flex-none items-center justify-between border-b border-neutral-200 bg-white px-6">
      <div className="flex items-center gap-4">
        <Link
          href="/dashboard"
          onClick={(event) => {
            if (isDirty && !window.confirm(BACK_LINK_CONFIRM_MESSAGE)) {
              event.preventDefault();
            }
          }}
          className="text-sm font-medium text-neutral-500 transition-colors hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          ← Back
        </Link>

        <span className="h-5 w-px bg-neutral-200" />

        {/* Feature 13.2 — project name (internal/dashboard label), kept
            deliberately separate from Business Profile's customer-facing
            business name. Styled to look like the previous static label
            until focused/hovered, when a border appears to signal it's
            editable. */}
        <input
          type="text"
          value={projectName}
          onChange={(event) => onProjectNameChange(event.target.value)}
          aria-label="Project name"
          className="w-48 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-semibold text-neutral-900 transition-colors hover:border-neutral-200 focus:border-blue-600 focus:bg-white focus:outline-none"
        />
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
          <div className="flex items-center gap-3">
            <span
              className={`text-xs font-medium ${getStatusClassName(isDirty, saveStatus)}`}
            >
              {getStatusLabel(isDirty, saveStatus)}
            </span>

            <button
              type="button"
              onClick={onSave}
              disabled={isSaveDisabled}
              className="rounded-full bg-blue-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {SAVE_BUTTON_LABEL[saveStatus]}
            </button>
          </div>

          {saveError && <span className="text-xs text-red-600">{saveError}</span>}
        </div>
      </div>
    </header>
  );
}
