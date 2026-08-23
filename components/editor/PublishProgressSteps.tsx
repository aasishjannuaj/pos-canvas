"use client";

// Feature 24.6 — the publishing stepper.
//
// A vertical timeline of the four stages, sized for the existing properties
// panel. Presentational only: it renders what lib/publishProgress.ts decides and
// owns no state, no timers and no network.
//
// NEVER COLOUR ALONE. Each row carries a shape (filled check, pulsing ring,
// hollow dot, muted dash) AND a visually-hidden word naming its state, so the
// stepper reads the same to someone who cannot distinguish the colours or is
// listening to it rather than looking at it.
//
// NO PERCENTAGES, and no progress bar that implies one. The animation says
// "working", which is all we can honestly claim between two status polls.

import {
  PUBLISH_STAGES,
  PUBLISH_STAGE_LABELS,
  describePublishStageState,
} from "@/lib/publishProgress";
import type { PublishProgress, PublishStageState } from "@/lib/publishProgress";

const STATE_WORDS: Record<PublishStageState, string> = {
  complete: "done",
  active: "in progress",
  pending: "not started",
  stopped: "stopped",
};

function StageMarker({ state }: { state: PublishStageState }) {
  if (state === "complete") {
    return (
      <span
        aria-hidden="true"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white"
      >
        <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M3.5 8.5l3 3 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }

  if (state === "active") {
    return (
      <span aria-hidden="true" className="relative flex h-5 w-5 shrink-0 items-center justify-center">
        <span className="absolute inline-flex h-5 w-5 animate-ping rounded-full bg-blue-400 opacity-60" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-blue-600" />
      </span>
    );
  }

  if (state === "stopped") {
    return (
      <span
        aria-hidden="true"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-neutral-300"
      >
        <span className="h-0.5 w-2 rounded-full bg-neutral-400" />
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-neutral-200"
    />
  );
}

export default function PublishProgressSteps({ progress }: { progress: PublishProgress }) {
  // Nothing to show before anything has been requested — the panel must not nag
  // an owner who has not pressed anything.
  if (progress.kind === "idle") {
    return null;
  }

  return (
    <ol className="flex flex-col gap-0">
      {PUBLISH_STAGES.map((stage, index) => {
        const state = describePublishStageState(stage, progress);
        const isLast = index === PUBLISH_STAGES.length - 1;

        return (
          <li key={stage} className="flex gap-2.5">
            <div className="flex flex-col items-center">
              <StageMarker state={state} />

              {/* The connector, tinted only as far as work has actually got. */}
              {!isLast && (
                <span
                  aria-hidden="true"
                  className={`w-0.5 flex-1 ${
                    state === "complete" ? "bg-emerald-200" : "bg-neutral-200"
                  }`}
                />
              )}
            </div>

            <p
              className={`pb-3 text-xs leading-5 ${
                state === "active"
                  ? "font-medium text-neutral-900"
                  : state === "complete"
                    ? "text-neutral-600"
                    : "text-neutral-400"
              }`}
            >
              {PUBLISH_STAGE_LABELS[stage]}
              <span className="sr-only"> — {STATE_WORDS[state]}</span>
            </p>
          </li>
        );
      })}
    </ol>
  );
}
