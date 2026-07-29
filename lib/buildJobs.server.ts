import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getProjectById } from "@/lib/projects.server";
import { isProjectConfig } from "@/lib/projectConfig";
import {
  createGeneratedPosConfig,
  isGeneratedPosConfig,
} from "@/lib/generatedPosConfig";
import type { GeneratedPosConfig } from "@/lib/generatedPosConfig";
import { computeGeneratedPosConfigHash } from "@/lib/buildJobs.hash";
import {
  BUILD_JOB_COLUMNS,
  isBuildStatus,
  isNonEmptyId,
  isSupportedBuildTarget,
  mapBuildJobRow,
  normalizeRequestKey,
  resolveExistingBuildJob,
  isValidRetryReference,
} from "@/lib/buildJobs";
import type {
  BuildJobRow,
  BuildJobSummary,
  BuildTarget,
  CreateBuildJobInput,
  CreateBuildJobResult,
} from "@/lib/buildJobs";

// Feature 15.5 — the implementation now lives in lib/buildJobs.hash.ts
// (no "server-only" import), specifically so worker/once.ts can compute
// the same hash without pulling in this file's own "server-only" guard.
// Re-exported here unchanged so every existing caller/test that imports
// computeGeneratedPosConfigHash from "@/lib/buildJobs.server" keeps
// working with no change.
export { computeGeneratedPosConfigHash };

const GENERIC_DATABASE_ERROR_MESSAGE =
  "Something went wrong while requesting the build.";

// Feature 15.3 — extracts the authenticated user's id from the decoded JWT
// claims returned by supabase.auth.getClaims() (the same call
// lib/projects.server.ts/lib/orders.server.ts already use to check "is
// anyone signed in"). `sub` is the standard JWT/OIDC claim for the
// subject's id, and is what Postgres's auth.uid() resolves to under RLS —
// this is the one and only source of owner_id; it is never accepted from
// the browser.
function extractUserId(claims: unknown): string | null {
  if (!claims || typeof claims !== "object") {
    return null;
  }

  const sub = (claims as Record<string, unknown>).sub;

  return typeof sub === "string" && sub.trim() !== "" ? sub : null;
}

type AdminSupabaseClient = ReturnType<typeof createAdminClient>;

// Feature 15.3 correction — the single query used both for the early
// reuse check (before any config generation/hashing) and again after an
// insert conflict (to recover the row that caused it) — written once so
// both call sites can never drift apart. Runs exclusively through the
// admin client, which bypasses RLS entirely, so every filter here is load
// -bearing: owner_id and project_id scope this to the already-
// authenticated, already-ownership-validated caller, exactly the
// boundaries RLS would otherwise have enforced. Request-key match takes
// priority over the active-job-for-this-target lookup, per
// resolveExistingBuildJob's own documented precedence.
async function lookupExistingBuildJob(
  admin: AdminSupabaseClient,
  args: { ownerId: string; projectId: string; target: BuildTarget; requestKey: string }
): Promise<{ job: BuildJobSummary | null; error: string | null }> {
  const { data: requestKeyRow, error: requestKeyError } = await admin
    .from("build_jobs")
    .select(BUILD_JOB_COLUMNS)
    .eq("owner_id", args.ownerId)
    .eq("project_id", args.projectId)
    .eq("request_key", args.requestKey)
    .maybeSingle();

  if (requestKeyError) {
    return { job: null, error: GENERIC_DATABASE_ERROR_MESSAGE };
  }

  const { data: activeRow, error: activeError } = await admin
    .from("build_jobs")
    .select(BUILD_JOB_COLUMNS)
    .eq("owner_id", args.ownerId)
    .eq("project_id", args.projectId)
    .eq("target", args.target)
    .in("status", ["queued", "building"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (activeError) {
    return { job: null, error: GENERIC_DATABASE_ERROR_MESSAGE };
  }

  const existingJob = resolveExistingBuildJob({
    byRequestKey: requestKeyRow ? mapBuildJobRow(requestKeyRow as BuildJobRow) : null,
    activeForTarget: activeRow ? mapBuildJobRow(activeRow as BuildJobRow) : null,
  });

  return { job: existingJob, error: null };
}

// Feature 15.3 — the server-authoritative build-request entry point. The
// browser may only ever supply projectId/target/requestKey/
// retriedFromJobId — ownerId, the config snapshot, its schema version, its
// hash, the initial status, and every timestamp are all derived here, on
// the server, never trusted from the caller.
//
// Feature 15.3 correction — authentication and project-ownership
// validation happen exclusively through the normal, cookie-based,
// RLS-scoped server client (supabase, below) — never through the admin
// client. The admin client (createAdminClient(), which uses the
// service-role key and bypasses RLS entirely) is only created *after*
// that succeeds, and every query issued through it below is explicitly
// filtered by the already-validated ownerId/project.id — there is no RLS
// safety net once it's in use. This is what closes the hole where a
// browser could otherwise bypass this function and INSERT a build_jobs
// row directly with fabricated values (the corrective migration also
// removes the browser-facing INSERT policy that made that possible).
export async function createBuildJob(
  input: CreateBuildJobInput
): Promise<CreateBuildJobResult> {
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

  const target = input.target;

  const requestKey = normalizeRequestKey(input.requestKey);

  if (requestKey === null) {
    return {
      ok: false,
      errorCode: "invalid_request",
      message: "A valid request key is required to request a build.",
    };
  }

  const retriedFromJobId = input.retriedFromJobId ?? null;

  if (retriedFromJobId !== null && !isNonEmptyId(retriedFromJobId)) {
    return {
      ok: false,
      errorCode: "invalid_request",
      message: "The referenced build job is invalid.",
    };
  }

  const supabase = await createClient();

  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const claims = claimsData?.claims ?? null;

  if (claimsError || !claims) {
    return {
      ok: false,
      errorCode: "not_authenticated",
      message: "You must be signed in to request a build.",
    };
  }

  const ownerId = extractUserId(claims);

  if (ownerId === null) {
    return {
      ok: false,
      errorCode: "not_authenticated",
      message: "You must be signed in to request a build.",
    };
  }

  // Feature 15.3 — reuses getProjectById exactly as the Builder/runtime
  // viewer already do, rather than duplicating a project query here. RLS
  // (via the normal client) means a project this user doesn't own comes
  // back identical to a project that doesn't exist at all
  // ({project: null}), so this can never reveal whether another user owns
  // projectId.
  const { project, error: projectError } = await getProjectById(input.projectId);

  if (projectError || !project) {
    return {
      ok: false,
      errorCode: "invalid_project",
      message: "That project is unavailable.",
    };
  }

  let admin: AdminSupabaseClient;

  try {
    admin = createAdminClient();
  } catch {
    // Feature 15.3 correction — SUPABASE_SERVICE_ROLE_KEY missing/
    // misconfigured. No environment variable names or values are ever
    // included in this returned message.
    return {
      ok: false,
      errorCode: "database_error",
      message: GENERIC_DATABASE_ERROR_MESSAGE,
    };
  }

  // Feature 15.3 correction — resolved as early as possible, before any
  // config generation/hashing: both a repeated request key and an
  // already-active job for this target are handled identically here,
  // regardless of whether a retry was requested, so a duplicate/retry
  // click never pays for regenerating a config it isn't going to use.
  const earlyLookup = await lookupExistingBuildJob(admin, {
    ownerId,
    projectId: project.id,
    target,
    requestKey,
  });

  if (earlyLookup.error) {
    return {
      ok: false,
      errorCode: "database_error",
      message: earlyLookup.error,
    };
  }

  if (earlyLookup.job) {
    return { ok: true, job: earlyLookup.job, reusedExisting: true };
  }

  if (!isProjectConfig(project.config)) {
    return {
      ok: false,
      errorCode: "invalid_config",
      message: "This project's configuration isn't valid for a build.",
    };
  }

  let generatedConfig: GeneratedPosConfig;

  try {
    // Feature 15.3 — generated fresh, right now, server-side — never the
    // browser's own copy. A project rename or menu edit after this point
    // never affects this job, since nothing after this line ever re-reads
    // project.config again.
    generatedConfig = createGeneratedPosConfig({
      projectId: project.id,
      projectName: project.name,
      templateId: project.template_id,
      config: project.config,
    });
  } catch {
    return {
      ok: false,
      errorCode: "invalid_config",
      message: "This project's configuration isn't valid for a build.",
    };
  }

  if (!isGeneratedPosConfig(generatedConfig)) {
    return {
      ok: false,
      errorCode: "invalid_config",
      message: "This project's configuration isn't valid for a build.",
    };
  }

  if (retriedFromJobId !== null) {
    // Feature 15.3 correction — filtered by owner_id AND project_id at the
    // query level, not just in the pure isValidRetryReference check below:
    // since the admin client bypasses RLS entirely, this query could
    // otherwise return a row belonging to a different user or project.
    // Filtering here means it structurally never can, regardless of
    // isValidRetryReference's own logic.
    const { data: retriedFromRow, error: retriedFromError } = await admin
      .from("build_jobs")
      .select("id, owner_id, project_id, target, status")
      .eq("id", retriedFromJobId)
      .eq("owner_id", ownerId)
      .eq("project_id", project.id)
      .maybeSingle();

    if (retriedFromError) {
      return {
        ok: false,
        errorCode: "database_error",
        message: GENERIC_DATABASE_ERROR_MESSAGE,
      };
    }

    const retriedFromJob =
      retriedFromRow &&
      isSupportedBuildTarget(retriedFromRow.target) &&
      isBuildStatus(retriedFromRow.status)
        ? {
            ownerId: retriedFromRow.owner_id as string,
            projectId: retriedFromRow.project_id as string,
            target: retriedFromRow.target,
            status: retriedFromRow.status,
          }
        : null;

    // Feature 15.3 — every failure mode (missing, wrong owner, wrong
    // project, wrong target, non-terminal) is reported with the exact same
    // generic message, so this can never reveal another user's build-job
    // existence — see isValidRetryReference's own documentation.
    if (
      !isValidRetryReference({
        retriedFromJob,
        requestOwnerId: ownerId,
        requestProjectId: project.id,
        requestTarget: target,
      })
    ) {
      return {
        ok: false,
        errorCode: "invalid_request",
        message: "The referenced build job is invalid.",
      };
    }
  }

  const configHash = computeGeneratedPosConfigHash(generatedConfig);

  const { data: insertedRow, error: insertError } = await admin
    .from("build_jobs")
    .insert({
      project_id: project.id,
      owner_id: ownerId,
      target,
      status: "queued",
      config_snapshot: generatedConfig,
      config_schema_version: generatedConfig.schemaVersion,
      config_hash: configHash,
      request_key: requestKey,
      retried_from_job_id: retriedFromJobId,
    })
    .select(BUILD_JOB_COLUMNS)
    .single();

  if (insertError) {
    // Feature 15.3 — the database's own unique indexes (the partial
    // active-job index and the project_id+request_key constraint) are the
    // final race-condition protection: if another request created a
    // conflicting row between the lookup above and this insert, Postgres
    // rejects this insert rather than allowing a duplicate. Re-query
    // (still owner/project-scoped) rather than ever surface the raw
    // constraint-violation error.
    const recovery = await lookupExistingBuildJob(admin, {
      ownerId,
      projectId: project.id,
      target,
      requestKey,
    });

    if (recovery.job) {
      return { ok: true, job: recovery.job, reusedExisting: true };
    }

    // Feature 15.3 — reached only if the insert failed (almost certainly
    // due to one of the unique constraints above) but the recovery
    // re-query still couldn't find the row that caused the conflict — an
    // unexpected, unlikely state, reported distinctly from a generic
    // database_error so it's diagnosable if it ever actually happens.
    return {
      ok: false,
      errorCode: "request_conflict",
      message: "This build request could not be completed right now. Please try again.",
    };
  }

  const job = mapBuildJobRow(insertedRow as BuildJobRow);

  if (!job) {
    return {
      ok: false,
      errorCode: "database_error",
      message: GENERIC_DATABASE_ERROR_MESSAGE,
    };
  }

  return { ok: true, job, reusedExisting: false };
}

// Feature 15.3 — read helper: this project's own build history, newest
// first, capped at 20 rows. Relies on the same RLS-only ownership pattern
// every other .server.ts read function in this codebase already uses
// (getProjectOrders, getProjectOrderCount) — deliberately still the normal
// client, not the admin client: these are ordinary user-facing reads, and
// RLS already scopes them correctly. Never selects config_snapshot
// (BUILD_JOB_COLUMNS excludes it entirely, so there's nothing to
// accidentally leak even internally).
export async function getProjectBuildJobs(projectId: string): Promise<{
  jobs: BuildJobSummary[];
  error: string | null;
}> {
  if (!isNonEmptyId(projectId)) {
    return { jobs: [], error: "A valid project is required." };
  }

  const supabase = await createClient();

  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const claims = claimsData?.claims ?? null;

  if (claimsError || !claims) {
    return { jobs: [], error: "You must be signed in to view build history." };
  }

  const { data, error } = await supabase
    .from("build_jobs")
    .select(BUILD_JOB_COLUMNS)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    return { jobs: [], error: "Unable to load build history for this project." };
  }

  const jobs = (data ?? [])
    .map((row) => mapBuildJobRow(row as BuildJobRow))
    .filter((job): job is BuildJobSummary => job !== null);

  return { jobs, error: null };
}

// Feature 15.3 — read helper: a single build job by id. Deliberately still
// the normal client, not the admin client — an ordinary user-facing read,
// correctly scoped by RLS. A missing job and one that exists but belongs
// to another owner are indistinguishable here by construction — RLS
// simply never returns the row in either case, so `data` is null
// identically for both, with no special-case code needed to make them
// "look the same."
export async function getBuildJobById(buildJobId: string): Promise<{
  job: BuildJobSummary | null;
  error: string | null;
}> {
  if (!isNonEmptyId(buildJobId)) {
    return { job: null, error: "A valid build job is required." };
  }

  const supabase = await createClient();

  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const claims = claimsData?.claims ?? null;

  if (claimsError || !claims) {
    return { job: null, error: "You must be signed in to view this build." };
  }

  const { data, error } = await supabase
    .from("build_jobs")
    .select(BUILD_JOB_COLUMNS)
    .eq("id", buildJobId)
    .maybeSingle();

  if (error) {
    return { job: null, error: "Unable to load this build." };
  }

  if (!data) {
    return { job: null, error: null };
  }

  const job = mapBuildJobRow(data as BuildJobRow);

  return { job, error: job ? null : "Unable to load this build." };
}
