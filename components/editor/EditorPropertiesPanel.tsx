export default function EditorPropertiesPanel() {
  return (
    <aside className="flex w-80 flex-none flex-col gap-4 border-l border-neutral-200 bg-white p-6">
      <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
        Properties
      </h2>

      <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-neutral-200 p-6 text-center">
        <span className="text-2xl">🧩</span>
        <p className="text-sm text-neutral-500">
          Select an item in the preview to edit its properties.
        </p>
      </div>
    </aside>
  );
}
