// Feature 24.6 — the publishing experience, as a pure state model.
//
// WHAT AN OWNER IS WATCHING. They pressed Publish configuration and now want to
// know that something is happening and roughly where it has got to. What the
// backend can actually tell us is four statuses — queued, building, succeeded,
// failed — and nothing else: build_jobs has no progress column, no stage column,
// no event stream, and the worker's heartbeat is never exposed to a client.
//
// SO THE STAGES ARE EXACTLY THOSE FACTS, NAMED IN OWNER LANGUAGE. There is no
// percentage anywhere in this file and there must never be one: a number we
// cannot derive is a number we would be inventing, and an owner who watches
// "43%" sit still for two minutes trusts the next screen less.
//
// The one stage with no server state behind it is "Preparing", which covers the
// moment between the click and the server answering. It is a real thing that is
// really happening — the request is in flight — and it disappears the instant a
// job comes back, so it can never linger as decoration.
//
// PURE. No React, no timers, no network. The panel renders what this decides.

import type { BuildJobSummary, BuildRequestStatus } from "@/lib/buildJobs";

/**
 * How often a running publish is re-read.
 *
 * Two and a half seconds: fast enough that a queue pickup feels immediate, slow
 * enough that a publish sitting queued for ten minutes costs a few hundred cheap
 * reads rather than thousands. There is no backoff because the loop stops on its
 * own at a terminal status, and a hidden tab is skipped entirely.
 */
export const PUBLISH_POLL_INTERVAL_MS = 2_500;

export type PublishStage = "preparing" | "queued" | "publishing" | "published";

/** In order. The UI walks this list; nothing else defines the sequence. */
export const PUBLISH_STAGES: readonly PublishStage[] = [
  "preparing",
  "queued",
  "publishing",
  "published",
];

/**
 * Owner-facing stage names.
 *
 * Deliberately about the CONFIGURATION, never about an app or a build. Nothing
 * here may suggest a binary was produced — publishing freezes a configuration
 * snapshot, and the POS Canvas app that reads it is downloaded separately and is
 * the same app for everyone.
 */
export const PUBLISH_STAGE_LABELS: Record<PublishStage, string> = {
  preparing: "Preparing configuration",
  queued: "Queued for publishing",
  publishing: "Publishing configuration",
  published: "Published",
};

/** How one row in the stepper should read. */
export type PublishStageState = "complete" | "active" | "pending" | "stopped";

export type PublishProgress =
  /** Nothing has been requested in this session. */
  | { kind: "idle" }
  /** A stage is in flight or reached; `stage` is the furthest one true so far. */
  | { kind: "running"; stage: PublishStage }
  /** Terminal success. */
  | { kind: "published" }
  /** Terminal failure, with whatever the server said about it. */
  | { kind: "failed"; message: string | null }
  /**
   * The request itself never landed. Distinct from `failed`, which is a job the
   * server accepted and then could not complete — here there may be no job at
   * all, so the honest thing is to offer the request again rather than to
   * describe a publish that is not happening.
   */
  | { kind: "request_failed"; message: string | null };

/**
 * Where publishing has got to, from the two things the panel already knows.
 *
 * ORDER MATTERS. The job is consulted before the request status, because a job
 * is a server fact and the request status is a client one: once the server has
 * answered, what it said outranks what we were doing when we asked. That is what
 * makes "Preparing" impossible to see after a job exists — the requirement in
 * the approved UX, expressed as a precedence rule rather than as a timer.
 */
export function resolvePublishProgress(input: {
  requestStatus: BuildRequestStatus;
  job: BuildJobSummary | null;
}): PublishProgress {
  const { requestStatus, job } = input;

  if (job !== null) {
    switch (job.status) {
      case "succeeded":
        return { kind: "published" };
      case "failed":
        return { kind: "failed", message: job.failureMessage ?? null };
      case "building":
        return { kind: "running", stage: "publishing" };
      case "queued":
        return { kind: "running", stage: "queued" };
    }
  }

  if (requestStatus === "submitting") {
    return { kind: "running", stage: "preparing" };
  }

  // An error with no job to show: the request did not produce one.
  if (requestStatus === "error") {
    return { kind: "request_failed", message: null };
  }

  return { kind: "idle" };
}

/**
 * How a given row renders, given where things have got to.
 *
 * `stopped` exists so a failure freezes the stepper where it stood instead of
 * pretending the remaining stages are still coming. An owner whose publish
 * failed at "Publishing" should see that, not a hopeful pending row underneath.
 */
export function describePublishStageState(
  stage: PublishStage,
  progress: PublishProgress
): PublishStageState {
  const index = PUBLISH_STAGES.indexOf(stage);

  if (progress.kind === "published") {
    return "complete";
  }

  if (progress.kind === "running") {
    const active = PUBLISH_STAGES.indexOf(progress.stage);

    if (index < active) return "complete";
    if (index === active) return "active";

    return "pending";
  }

  // Both failure kinds stop the run. Nothing is claimed as complete, because a
  // publish that failed did not finish any stage it had not already finished —
  // and we do not know which those were once the server gave up on it.
  return progress.kind === "idle" ? "pending" : "stopped";
}

/** True while the panel should be watching for a change. */
export function isPublishInFlight(progress: PublishProgress): boolean {
  return progress.kind === "running";
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/**
 * The success sentence.
 *
 * NAMES THE CONFIGURATION AND THE APP SEPARATELY, on purpose. "Published" on its
 * own leaves an owner asking "published where?", and any sentence about an app
 * being ready would be a lie — no binary was produced, and the POS Canvas app is
 * the same download for every business.
 */
export const PUBLISH_SUCCESS_MESSAGE =
  "Your configuration is published and ready to pair with the POS Canvas app.";

/**
 * Announced to assistive technology as the stage changes.
 *
 * One short sentence rather than the whole stepper, so a screen reader is not
 * re-read the entire list every few seconds.
 */
export function describePublishProgress(progress: PublishProgress): string | null {
  switch (progress.kind) {
    case "idle":
      return null;
    case "running":
      return `${PUBLISH_STAGE_LABELS[progress.stage]}…`;
    case "published":
      return PUBLISH_SUCCESS_MESSAGE;
    case "failed":
      return progress.message ?? "Publishing could not be completed.";
    case "request_failed":
      return progress.message ?? "The publish request could not be sent.";
  }
}
