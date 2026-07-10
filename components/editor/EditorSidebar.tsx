"use client";

import type { EditorSection } from "./EditorShell";

const sections: { label: EditorSection; icon: string }[] = [
  { label: "Menu", icon: "🍽" },
  { label: "Branding", icon: "🎨" },
  { label: "Taxes", icon: "🧾" },
  { label: "Settings", icon: "⚙️" },
];

type EditorSidebarProps = {
  editorSection: EditorSection;
  setEditorSection: (section: EditorSection) => void;
};

export default function EditorSidebar({
  editorSection,
  setEditorSection,
}: EditorSidebarProps) {
  return (
    <aside className="flex w-60 flex-none flex-col gap-1 border-r border-neutral-200 bg-white p-4">
      {sections.map((section) => {
        const isActive = editorSection === section.label;

        return (
          <button
            key={section.label}
            type="button"
            onClick={() => setEditorSection(section.label)}
            className={`flex items-center gap-3 rounded-xl px-4 py-3 text-left text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
              isActive
                ? "bg-blue-600 text-white"
                : "text-neutral-700 hover:bg-neutral-100"
            }`}
          >
            <span className="text-base">{section.icon}</span>
            {section.label}
          </button>
        );
      })}
    </aside>
  );
}
