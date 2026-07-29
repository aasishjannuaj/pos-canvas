"use client";

import { useEffect, useState } from "react";
import type { EditorSection } from "@/components/editor/EditorShell";

// Feature 13.3 — the single, shared definition of every onboarding step.
// Both the hook (completion/persistence logic) and OnboardingChecklist
// (presentation) import from here, so the seven steps are never defined
// twice.
export type OnboardingStepId =
  | "business"
  | "menu"
  | "branding"
  | "taxes"
  | "receipt"
  | "preview"
  | "save";

export type OnboardingStep = {
  id: OnboardingStepId;
  label: string;
  description: string;
  // Feature 13.3 — "save" is observational only (see the approved plan):
  // the checklist never turns it into a clickable navigation target, and
  // this hook never calls handleSave or any other Builder mutation for it.
  navigable: boolean;
};

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: "business",
    label: "Business",
    description: "Add your business name and contact details.",
    navigable: true,
  },
  {
    id: "menu",
    label: "Menu",
    description: "Add or review your menu items and categories.",
    navigable: true,
  },
  {
    id: "branding",
    label: "Branding",
    description: "Set your accent color.",
    navigable: true,
  },
  {
    id: "taxes",
    label: "Taxes",
    description: "Configure your tax rate and settings.",
    navigable: true,
  },
  {
    id: "receipt",
    label: "Receipt",
    description: "Customize receipt content and printing.",
    navigable: true,
  },
  {
    id: "preview",
    label: "Preview",
    description: "See how your POS looks and works for a customer.",
    navigable: true,
  },
  {
    id: "save",
    label: "Save project",
    description: "Save your project when you're ready.",
    navigable: false,
  },
];

const KNOWN_STEP_IDS: readonly OnboardingStepId[] = ONBOARDING_STEPS.map(
  (step) => step.id
);

function isOnboardingStepId(value: unknown): value is OnboardingStepId {
  return (
    typeof value === "string" &&
    (KNOWN_STEP_IDS as readonly string[]).includes(value)
  );
}

// Feature 13.3 — maps a Builder section to the onboarding step it
// corresponds to. Exported so EditorShell's own event handlers (sidebar
// clicks) can record a visit directly, rather than this hook watching
// editorSection through an effect. Sections with no onboarding step
// (Dashboard, Sales Report, Product Performance, Inventory Summary) resolve
// to null and are simply not tracked.
export function sectionToOnboardingStepId(
  section: EditorSection
): OnboardingStepId | null {
  switch (section) {
    case "Business":
      return "business";
    case "Menu":
      return "menu";
    case "Branding":
      return "branding";
    case "Taxes":
      return "taxes";
    case "Settings":
      return "receipt";
    default:
      return null;
  }
}

const STORAGE_KEY_PREFIX = "pos-canvas:onboarding:";

type PersistedOnboardingState = {
  dismissed: boolean;
  visitedSteps: OnboardingStepId[];
};

// Feature 13.3 — defensive parsing: rejects anything that isn't the exact
// expected shape rather than trying to coerce it, and silently drops any
// unknown/malformed step id rather than failing the whole parse. Never
// throws — a corrupted or unexpected value simply behaves like "nothing was
// ever persisted."
function parsePersistedState(raw: string): PersistedOnboardingState | null {
  try {
    const parsed: unknown = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const candidate = parsed as Record<string, unknown>;

    if (typeof candidate.dismissed !== "boolean") {
      return null;
    }

    if (!Array.isArray(candidate.visitedSteps)) {
      return null;
    }

    return {
      dismissed: candidate.dismissed,
      visitedSteps: candidate.visitedSteps.filter(isOnboardingStepId),
    };
  } catch {
    return null;
  }
}

// Feature 13.3 — every localStorage access is wrapped so a blocked/disabled
// storage API (private browsing, restrictive browser settings, storage
// quota errors) degrades to "nothing persisted"/"write silently skipped"
// rather than crashing the Builder.
function readPersistedState(projectId: string): PersistedOnboardingState | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }

    const raw = window.localStorage.getItem(`${STORAGE_KEY_PREFIX}${projectId}`);

    if (raw === null) {
      return null;
    }

    return parsePersistedState(raw);
  } catch {
    return null;
  }
}

function writePersistedState(
  projectId: string,
  state: PersistedOnboardingState
): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }

    window.localStorage.setItem(
      `${STORAGE_KEY_PREFIX}${projectId}`,
      JSON.stringify(state)
    );
  } catch {
    // Storage unavailable/full/blocked — fall back to in-memory-only
    // behavior for the rest of this session.
  }
}

type UseOnboardingProgressArgs = {
  // Feature 13.3 — the *initial* project id (stable for the life of this
  // EditorShell mount), used only to decide (a) whether this session should
  // auto-open onboarding at all, (b) whether "menu" starts pre-visited, and
  // (c) whether a one-time localStorage read is needed on mount. Never
  // re-read after mount.
  initialProjectId: string | null;
  // The *live* project id — null until first save, then the real id for the
  // rest of the session. Drives ongoing persistence and Save-step
  // completion.
  projectId: string | null;
};

type UseOnboardingProgressResult = {
  steps: OnboardingStep[];
  isStepComplete: (id: OnboardingStepId) => boolean;
  completedCount: number;
  totalCount: number;
  isOpen: boolean;
  dismiss: () => void;
  reopen: () => void;
  markStepVisited: (id: OnboardingStepId) => void;
  persistProgressForProject: (projectId: string) => void;
};

export function useOnboardingProgress({
  initialProjectId,
  projectId,
}: UseOnboardingProgressArgs): UseOnboardingProgressResult {
  // Feature 13.3 — auto-open only when this session began as a brand-new,
  // unsaved template project (approved rule 1). Computed once from the
  // stable initialProjectId prop, identically on server and client, so
  // there is no localStorage-driven first-render mismatch here.
  const [isOpen, setIsOpen] = useState(initialProjectId === null);
  const [dismissed, setDismissed] = useState(false);

  // Feature 13.3 correction — the Menu section is what's actually on screen
  // the instant the Builder mounts for a brand-new unsaved project, so this
  // is the true initial state (computed in the lazy initializer, never an
  // effect-driven side effect) rather than something inferred after the
  // fact. An existing saved project starts empty until its real persisted
  // progress is hydrated below. Never reads localStorage here — only
  // initialProjectId, a plain prop identical on server and client, so
  // there's no hydration mismatch risk.
  const [visitedSteps, setVisitedSteps] = useState<Set<OnboardingStepId>>(() =>
    initialProjectId === null
      ? new Set<OnboardingStepId>(["menu"])
      : new Set<OnboardingStepId>()
  );

  // Feature 13.3 correction — a brand-new project has no persisted state to
  // read at all, so hydration is trivially already complete for it and the
  // effect below simply never runs its read for that case. Only an
  // existing saved project needs to wait for the effect to actually
  // resolve.
  const [hasHydrated, setHasHydrated] = useState(initialProjectId === null);

  function markStepVisited(id: OnboardingStepId): void {
    setVisitedSteps((prev) => {
      if (prev.has(id)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }

  // Feature 13.3 correction — external-system synchronization (reading
  // localStorage), which is exactly what an effect is for; this is
  // different from the step-completion effects that were removed (those
  // derived Builder state from Builder state, which belongs in event
  // handlers instead). react-hooks/set-state-in-effect flags a *synchronous*
  // setState call in an effect body, so the read + setState pair is queued
  // as a microtask instead of running immediately — no arbitrary delay, no
  // suppressed lint rule. The `cancelled` flag is checked before every
  // setState so a microtask that resolves after this effect's own cleanup
  // (a fast unmount) can never touch state on an unmounted component. Only
  // runs its read for a project that already had a saved id when this
  // session began — a brand-new session has no key to read yet (and
  // hasHydrated already starts true for it, above).
  useEffect(() => {
    if (initialProjectId === null) {
      return;
    }

    let cancelled = false;

    queueMicrotask(() => {
      if (cancelled) {
        return;
      }

      const persisted = readPersistedState(initialProjectId);

      if (persisted) {
        setVisitedSteps(new Set(persisted.visitedSteps));
        setDismissed(persisted.dismissed);
      }

      setHasHydrated(true);
    });

    return () => {
      cancelled = true;
    };
  }, [initialProjectId]);

  // Feature 13.3 — keeps localStorage in sync with in-memory state
  // whenever a real projectId exists. Covers both required transitions:
  // (1) an existing saved project's entry staying current as the user
  // visits more steps, and (2) a brand-new project's pre-save,
  // in-memory-only progress being flushed to its new key once projectId
  // first becomes non-null (as a backstop — the first-save flow itself
  // calls persistProgressForProject synchronously before that can matter;
  // see below). Gated on hasHydrated so it can never fire before the
  // hydration effect above has had a chance to apply an existing saved
  // project's real state — without that guard, this effect would otherwise
  // write the pre-hydration default state and clobber whatever was just
  // read.
  useEffect(() => {
    if (projectId === null || !hasHydrated) {
      return;
    }

    writePersistedState(projectId, {
      dismissed,
      visitedSteps: Array.from(visitedSteps),
    });
  }, [projectId, dismissed, visitedSteps, hasHydrated]);

  function isStepComplete(id: OnboardingStepId): boolean {
    // Feature 13.3 — Save completion is derived from projectId directly,
    // never stored inside visitedSteps, so it always reflects the current
    // save state immediately when projectId changes.
    if (id === "save") {
      return projectId !== null;
    }

    return visitedSteps.has(id);
  }

  const completedCount = ONBOARDING_STEPS.filter((step) =>
    isStepComplete(step.id)
  ).length;

  function dismiss(): void {
    setIsOpen(false);
    setDismissed(true);
  }

  function reopen(): void {
    setIsOpen(true);
    setDismissed(false);
  }

  // Feature 13.3 correction — a synchronous escape hatch for the first-save
  // flow. The ordinary projectId-dependent persistence effect above only
  // runs after a commit, which is not guaranteed to happen before
  // EditorShell's router.replace call triggers a route transition (this
  // hook does not assume router.replace can't remount EditorShell). Calling
  // this directly, before router.replace, guarantees the current progress
  // is written to the new project's key immediately — using the exact same
  // validated writePersistedState helper (same try/catch guard, same
  // shape) as every other write in this hook, so a storage failure here
  // behaves identically: silently skipped, never thrown, and never able to
  // fail the project save that already succeeded before this is called.
  function persistProgressForProject(targetProjectId: string): void {
    writePersistedState(targetProjectId, {
      dismissed,
      visitedSteps: Array.from(visitedSteps),
    });
  }

  return {
    steps: ONBOARDING_STEPS,
    isStepComplete,
    completedCount,
    totalCount: ONBOARDING_STEPS.length,
    isOpen,
    dismiss,
    reopen,
    markStepVisited,
    persistProgressForProject,
  };
}
