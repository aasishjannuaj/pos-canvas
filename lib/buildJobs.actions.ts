"use server";

import {
  BUILD_PROCESSING_RETRY_FAILED_MESSAGE,
  isNonEmptyId,
  isSupportedBuildTarget,
  isValidUuid,
  needsBuildProcessing,
  normalizeRequestKey,
} from "@/lib/buildJobs";
import type {
  BuildJobSummary,
  BuildProcessingState,
  RequestBuildJobResult,
  StartBuildProcessingResult,
} from "@/lib/buildJobs";
import { dispatchBuildWorkerWorkflow } from "@/lib/githubBuildWorker.server";
import { createDownloadArtifactFailure } from "@/lib/buildJobs.download";
import type { DownloadArtifactResult } from "@/lib/buildJobs.download";
import {
  createBuildArtifactDownloadUrl,
  createBuildJob,
  getBuildJobById,
  getProjectBuildJobs,
} from "@/lib/buildJobs.server";

// Feature 15.4 — the only server boundary the browser can reach for build
// requests. Next.js compiles this file's exports into server-action
// references for any client component that imports them — the actual
// implementation (and everything it calls, including
// lib/buildJobs.server.ts's Supabase/service-role/node:crypto access)
// never ships in the client bundle. A thin wrapper: minimal defensive
// shape-checks on the exact three fields a caller may ever supply, then a
// direct delegation to createBuildJob, which performs every
// authentication/ownership/config-generation step itself and already
// returns a fully sanitized CreateBuildJobResult. Nothing here ever
// accepts or forwards ownerId, a config snapshot, its hash/schemaVersion, a
// status, or any timestamp — createBuildJob derives all of that itself,
// and this function's own input type has no field for any of it in the
// first place.
//
// Feature 17.2 — after (and only after) the database has accepted the build,
// this action also asks GitHub to start a worker run. See
// triggerBuildProcessing below for why that ordering is the whole design.
export async function requestBuildJob(input: {
  projectId: string;
  target: unknown;
  requestKey: string;
}): Promise<RequestBuildJobResult> {
  if (!isNonEmptyId(input.projectId)) {
    return {
      ok: false,
      errorCode: "invalid_project",
      message: "A valid project is required to request a build.",
    };
  }

  if (!isSupportedBuildTarget(input.target)) {
    return {
      ok: false,
      errorCode: "invalid_target",
      message: "That build target isn't supported.",
    };
  }

  const requestKey = normalizeRequestKey(input.requestKey);

  if (requestKey === null) {
    return {
      ok: false,
      errorCode: "invalid_request",
      message: "A valid request key is required to request a build.",
    };
  }

  const result = await createBuildJob({
    projectId: input.projectId,
    target: input.target,
    requestKey,
  });

  if (!result.ok) {
    // Nothing was queued, so there is nothing for a worker to do. No dispatch,
    // and the failure shape is passed through byte-for-byte — createBuildJob's
    // messages are already sanitized and this action adds no field to them.
    return result;
  }

  return {
    ok: true,
    job: result.job,
    reusedExisting: result.reusedExisting,
    processing: await triggerBuildProcessing(result.job.status),
  };
}

// Feature 17.2 — the one place a queued build turns into a worker run.
//
// ORDERING IS THE DESIGN: the build_jobs row is committed before this runs, and
// its fate never depends on the outcome here. A dispatch failure leaves a
// perfectly valid queued build in the database — it is NOT deleted, NOT failed,
// and NOT marked in any way. The only consequence is that the caller is told
// `unavailable`, so the Builder can offer "Retry processing" for that same row.
// Doing it the other way round (dispatch first, or roll the row back on a
// dispatch failure) would make GitHub's availability an input to whether a
// customer's build exists, which it must never be.
//
// The status gate is needsBuildProcessing, shared with the retry path so the
// two can never disagree about what "still needs a worker" means.
async function triggerBuildProcessing(
  status: BuildJobSummary["status"]
): Promise<BuildProcessingState> {
  if (!needsBuildProcessing(status)) {
    return "not_needed";
  }

  const dispatch = await dispatchBuildWorkerWorkflow();

  // Only ok/not-ok crosses this line. dispatch.reason is an operator
  // diagnostic; it was already logged server-side and is dropped here so it
  // cannot reach a browser through the action's return value.
  return dispatch.ok ? "started" : "unavailable";
}

// Feature 17.2 — "Retry processing".
//
// Exists so a failed dispatch can be retried WITHOUT a second build_jobs row.
// The Builder's Build button would also have worked (the active-job index would
// resolve a second click back to this same job), but only by way of a request
// that reads as "make me another build" — this action says what it means, and
// contains no insert path at all.
//
// Authorization is getBuildJobById's, unchanged: it is owner-scoped, and a job
// belonging to someone else is indistinguishable from one that does not exist.
// A caller therefore cannot use this action to discover another owner's build
// ids, and cannot cause a workflow run by naming one.
export async function startBuildProcessing(
  buildJobId: string
): Promise<StartBuildProcessingResult> {
  if (!isValidUuid(buildJobId)) {
    return { ok: false, message: BUILD_PROCESSING_RETRY_FAILED_MESSAGE };
  }

  const { job, error } = await getBuildJobById(buildJobId);

  if (error || !job) {
    return { ok: false, message: BUILD_PROCESSING_RETRY_FAILED_MESSAGE };
  }

  // A build that finished between the failed dispatch and this retry needs no
  // worker. Reported as a success with the fresh job, so the Builder replaces
  // its stale "could not be started" notice with the real status.
  const processing = await triggerBuildProcessing(job.status);

  return { ok: true, job, processing };
}

// Feature 15.4 — the only server boundary the browser can reach to refresh
// a single build job's status. Never returns a config snapshot or any
// other sensitive field — getBuildJobById already only ever returns a
// BuildJobSummary. A missing job and one that belongs to another owner are
// indistinguishable here, exactly as getBuildJobById itself already
// guarantees; the error strings it returns are already first-party,
// hand-authored, sanitized messages (never a raw Supabase error), so they
// are passed through as-is rather than re-wrapped.
export async function refreshBuildJobStatus(
  buildJobId: string
): Promise<{ ok: true; job: BuildJobSummary } | { ok: false; message: string }> {
  if (!isNonEmptyId(buildJobId)) {
    return { ok: false, message: "A valid build job is required." };
  }

  const { job, error } = await getBuildJobById(buildJobId);

  if (error) {
    return { ok: false, message: error };
  }

  if (!job) {
    return { ok: false, message: "This build could not be found." };
  }

  return { ok: true, job };
}

// Feature 15.7 — the only server boundary the browser can reach to obtain
// a build artifact download URL. A thin wrapper in the same shape as the
// two actions above: one defensive shape-check on the single field a
// caller may ever supply, then a direct delegation to
// createBuildArtifactDownloadUrl, which performs authentication, both
// RLS-scoped ownership reads, eligibility checks, and the signed-URL
// creation itself and already returns a fully sanitized
// DownloadArtifactResult.
//
// buildJobId is the *only* input. There is deliberately no parameter for
// an artifact id, owner id, project id, artifact type, storage path,
// filename, build status, expiration, or bucket name — every one of those
// is either derived server-side or a server-side constant, so a caller
// cannot influence which object gets signed or what it is served as.
//
// Feature 15.7 correction — validated with isValidUuid (not merely
// isNonEmptyId): build_jobs.id is a PostgreSQL uuid column, so a
// malformed value would otherwise reach the database as an
// invalid-input-syntax error rather than simply matching zero rows. A
// malformed id is rejected here, before any Supabase client is created,
// and reported with the exact same generic not_found result as an id that
// is well-formed but unknown or owned by someone else — the failure never
// says "invalid UUID", so this can't be used to probe id validity either.
//
// No admin-client or Storage logic lives in this wrapper; it never
// touches the service-role credential, and Next.js compiles this file's
// exports into server-action references so neither this function's
// implementation nor anything it calls ships in the client bundle.
export async function downloadBuildArtifact(
  buildJobId: string
): Promise<DownloadArtifactResult> {
  if (!isValidUuid(buildJobId)) {
    return createDownloadArtifactFailure("not_found");
  }

  return createBuildArtifactDownloadUrl(buildJobId);
}


// Feature 16.4B — the only server boundary the browser can reach to list a
// project's build jobs. The thinnest possible wrapper around the EXISTING
// getProjectBuildJobs: one shape-check, then delegation. No new query, no
// duplicated column list, no second ordering rule.
//
// Added because the Devices panel must resolve the latest succeeded build to
// pair against, and getProjectBuildJobs had no action exposing it. It returns
// BuildJobSummary values only — the same sanitized shape refreshBuildJobStatus
// already returns, carrying no config snapshot, no owner id, no claim token
// and no storage path.
//
// Ownership is enforced by RLS inside getProjectBuildJobs: a project belonging
// to another owner yields an empty list rather than an error that would
// confirm it exists.
export async function listProjectBuildJobs(
  projectId: string
): Promise<{ ok: true; jobs: BuildJobSummary[] } | { ok: false; message: string }> {
  // projects.id is a uuid column, so a malformed value would otherwise reach
  // the database as an invalid-input-syntax error rather than matching zero
  // rows — the same correction Feature 15.7 applied to downloadBuildArtifact.
  if (!isValidUuid(projectId)) {
    return { ok: false, message: "A valid project is required." };
  }

  const { jobs, error } = await getProjectBuildJobs(projectId);

  if (error) {
    return { ok: false, message: error };
  }

  return { ok: true, jobs };
}
