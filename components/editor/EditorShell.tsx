import EditorTopBar from "./EditorTopBar";
import EditorSidebar from "./EditorSidebar";
import EditorPreview from "./EditorPreview";
import EditorPropertiesPanel from "./EditorPropertiesPanel";

type EditorShellProps = {
  projectName: string;
};

export default function EditorShell({ projectName }: EditorShellProps) {
  return (
    <div className="flex h-screen flex-col bg-neutral-50">
      <EditorTopBar projectName={projectName} />

      <div className="flex flex-1 overflow-hidden">
        <EditorSidebar />
        <EditorPreview />
        <EditorPropertiesPanel />
      </div>
    </div>
  );
}
