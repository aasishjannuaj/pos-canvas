"use client";

import type { MenuCategory, MenuItem } from "./EditorShell";

const sectionOrder: MenuCategory[] = ["Breakfast", "Lunch", "Drinks"];

type EditorPreviewProps = {
  menuItems: MenuItem[];
  selectedItemId: string | null;
  onSelect: (id: string) => void;
  businessName: string;
  accentColor: string;
};

export default function EditorPreview({
  menuItems,
  selectedItemId,
  onSelect,
  businessName,
  accentColor,
}: EditorPreviewProps) {
  return (
    <div className="flex flex-1 items-center justify-center overflow-auto bg-neutral-100 p-10">
      <div className="flex aspect-[9/16] w-full max-w-sm flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
        {/* POS Header */}
        <div
          className="flex-none px-4 py-3"
          style={{ backgroundColor: accentColor }}
        >
          <span className="text-sm font-semibold tracking-tight text-white">
            {businessName}
          </span>
        </div>

        {/* Section Tabs */}
        <div className="flex flex-none gap-2 border-b border-neutral-200 bg-white px-3 py-2">
          {sectionOrder.map((section, index) => (
            <span
              key={section}
              className={
                index === 0
                  ? "rounded-full px-3 py-1.5 text-xs font-medium text-white"
                  : "rounded-full bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-600"
              }
              style={index === 0 ? { backgroundColor: accentColor } : undefined}
            >
              {section}
            </span>
          ))}
        </div>

        {/* Menu Content */}
        <div className="flex-1 overflow-y-auto px-3 py-3">
          <div className="flex flex-col gap-4">
            {sectionOrder.map((section) => {
              const sectionItems = menuItems.filter(
                (item) => item.category === section
              );

              if (sectionItems.length === 0) {
                return null;
              }

              return (
                <div key={section} className="flex flex-col gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                    {section}
                  </span>

                  <div className="grid grid-cols-2 gap-2">
                    {sectionItems.map((item) => {
                      const isSelected = selectedItemId === item.id;

                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => onSelect(item.id)}
                          className={`flex flex-col justify-between gap-2 rounded-lg border p-2.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
                            isSelected
                              ? "text-white"
                              : "border-neutral-200 bg-neutral-50 hover:border-neutral-300"
                          }`}
                          style={
                            isSelected
                              ? {
                                  backgroundColor: accentColor,
                                  borderColor: accentColor,
                                }
                              : undefined
                          }
                        >
                          <span
                            className={`text-xs font-medium leading-tight ${
                              isSelected ? "text-white" : "text-neutral-900"
                            }`}
                          >
                            {item.name}
                          </span>
                          <span
                            className="text-xs font-semibold"
                            style={{
                              color: isSelected ? "#FFFFFF" : accentColor,
                            }}
                          >
                            ${item.price.toFixed(2)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
