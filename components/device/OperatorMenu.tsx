"use client";

// Feature 25.3 Phase 2 — the till's one operator control.
//
// WHY A MENU AND NOT TWO PILLS. The Android viewport measured in Feature 16.2 is
// 411 CSS px. Minus the header's padding that leaves roughly 363px for the logo,
// the business name and any controls; two full pills would take most of it and
// squeeze the business name to nothing. One compact control costs a fixed ~40px
// and has room for a third entry later.
//
// IT IS NOT A ROUTE OUT OF THE TILL. Feature 16.4A's rule stands: a paired
// device has nowhere to go back to and must not offer a way into the owner app.
// Everything here is device-local.

import { useEffect, useRef, useState } from "react";

export const OPERATOR_MENU_LABEL = "Till options";
export const OPERATOR_MENU_HISTORY = "Sales history";
export const OPERATOR_MENU_SETTINGS = "Device settings";

type OperatorMenuProps = {
  onOpenHistory: () => void;
  onOpenSettings: () => void;
};

export default function OperatorMenu({ onOpenHistory, onOpenSettings }: OperatorMenuProps) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  // Dismissible without a modal: a tap anywhere else, or Escape, closes it. A
  // full-screen overlay for two menu items would cover the POS for no reason.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div ref={container} className="relative flex-none">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={OPERATOR_MENU_LABEL}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-9 w-9 items-center justify-center rounded-full border border-white/30 text-white/90 transition-colors hover:border-white/60 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      >
        {/* Three dots, drawn rather than typed: a glyph renders differently
            across the Android WebView and Electron, and a control this small
            cannot afford to be ambiguous. */}
        <svg viewBox="0 0 20 20" className="h-5 w-5" fill="currentColor" aria-hidden="true">
          <circle cx="10" cy="4" r="1.6" />
          <circle cx="10" cy="10" r="1.6" />
          <circle cx="10" cy="16" r="1.6" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          aria-label={OPERATOR_MENU_LABEL}
          className="absolute right-0 z-40 mt-2 w-48 overflow-hidden rounded-xl border border-neutral-200 bg-white py-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => choose(onOpenHistory)}
            className="block w-full px-4 py-2.5 text-left text-sm font-medium text-neutral-800 transition-colors hover:bg-neutral-100 focus-visible:bg-neutral-100 focus-visible:outline-none"
          >
            {OPERATOR_MENU_HISTORY}
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => choose(onOpenSettings)}
            className="block w-full px-4 py-2.5 text-left text-sm font-medium text-neutral-800 transition-colors hover:bg-neutral-100 focus-visible:bg-neutral-100 focus-visible:outline-none"
          >
            {OPERATOR_MENU_SETTINGS}
          </button>
        </div>
      )}
    </div>
  );
}
