"use client";

import type { OnboardingStep, OnboardingStepId } from "./useOnboardingProgress";

type OnboardingChecklistProps = {
  steps: OnboardingStep[];
  isStepComplete: (id: OnboardingStepId) => boolean;
  completedCount: number;
  totalCount: number;
  isOpen: boolean;
  projectId: string | null;
  onDismiss: () => void;
  onReopen: () => void;
  onNavigateToStep: (id: OnboardingStepId) => void;
};

function StepStatusIcon({ complete }: { complete: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex h-4 w-4 flex-none items-center justify-center rounded-full border text-[10px] leading-none ${
        complete
          ? "border-emerald-600 bg-emerald-600 text-white"
          : "border-neutral-300 text-transparent"
      }`}
    >
      ✓
    </span>
  );
}

// Feature 13.3 — non-blocking floating setup checklist. Pure presentation +
// navigation dispatch: no form fields, no ProjectConfig access, no
// markDirty/handleSave calls anywhere in this file. Collapses to a small
// "Setup Guide" pill when closed; expands to the full checklist when open.
// Not a modal — no overlay, no focus trap — so it never interferes with
// direct Builder use or with the existing beforeunload/Back-link
// protections, which key off isDirty alone and have no awareness of this
// component.
export default function OnboardingChecklist({
  steps,
  isStepComplete,
  completedCount,
  totalCount,
  isOpen,
  projectId,
  onDismiss,
  onReopen,
  onNavigateToStep,
}: OnboardingChecklistProps) {
  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={onReopen}
        className="fixed bottom-4 right-4 z-40 rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-lg transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
      >
        Setup Guide
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-40 flex max-h-[calc(100vh-2rem)] w-80 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-xl">
      <div className="flex flex-none items-start justify-between gap-2 border-b border-neutral-200 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
            Setup Guide
          </h2>
          <p className="text-xs text-neutral-500">
            {completedCount} of {totalCount} complete
          </p>
        </div>

        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss setup guide"
          className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          ×
        </button>
      </div>

      <p className="flex-none px-4 pt-3 text-xs text-neutral-500">
        Work through these steps to get your POS ready — in any order, at
        your own pace.
      </p>

      <ul className="flex flex-col gap-1 overflow-y-auto px-2 py-3">
        {steps.map((step) => {
          const complete = isStepComplete(step.id);

          if (!step.navigable) {
            return (
              <li
                key={step.id}
                className="flex flex-col gap-1 rounded-xl px-2 py-2"
              >
                <div className="flex items-center gap-2">
                  <StepStatusIcon complete={complete} />
                  <span className="text-sm font-medium text-neutral-900">
                    {step.label}
                  </span>
                </div>
                <p className="pl-6 text-xs text-neutral-500">
                  {projectId !== null ? "Saved." : "Not saved yet."} Use the
                  Save button in the top bar when you&apos;re ready.
                </p>
              </li>
            );
          }

          return (
            <li key={step.id}>
              <button
                type="button"
                onClick={() => onNavigateToStep(step.id)}
                className="flex w-full flex-col gap-1 rounded-xl px-2 py-2 text-left transition-colors hover:bg-neutral-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
              >
                <span className="flex items-center gap-2">
                  <StepStatusIcon complete={complete} />
                  <span className="text-sm font-medium text-neutral-900">
                    {step.label}
                  </span>
                </span>
                <span className="pl-6 text-xs text-neutral-500">
                  {step.description}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
