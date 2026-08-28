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
  isValidUuid,
  mapBuildJobRow,
  normalizeRequestKey,
  decideExistingBuildJob,
  PUBLISH_IN_PROGRESS_MESSAGE,
  isValidRetryReference,
} from "@/lib/buildJobs";
import type {
  BuildJobRow,
  BuildJobSummary,
  BuildTarget,
  CreateBuildJobInput,
  CreateBuildJobResult,
} from "@/lib/buildJobs";
import {
  BUILD_ARTIFACTS_DOWNLOAD_BUCKET,
  DOWNLOAD_SIGNED_URL_SECONDS,
  JSON_CONFIG_DOWNLOAD_ARTIFACT_TYPE,
  createDownloadArtifactFailure,
  createUnexpectedDownloadFailure,
  decideBuildArtifactDownloadEligibility,
} from "@/lib/buildJobs.download";
import type { DownloadArtifactResult } from "@/lib/buildJobs.download";

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
): Promise<{
  byRequestKey: BuildJobSummary | null;
  activeForTarget: BuildJobSummary | null;
  error: string | null;
}> {
  const { data: requestKeyRow, error: requestKeyError } = await admin
    .from("build_jobs")
    .select(BUILD_JOB_COLUMNS)
    .eq("owner_id", args.ownerId)
    .eq("project_id", args.projectId)
    .eq("request_key", args.requestKey)
    .maybeSingle();

  if (requestKeyError) {
    return { byRequestKey: null, activeForTarget: null, error: GENERIC_DATABASE_ERROR_MESSAGE };
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
    return { byRequestKey: null, activeForTarget: null, error: GENERIC_DATABASE_ERROR_MESSAGE };
  }

  // Feature 25.6 — BOTH arms are returned, where this used to collapse them
  // into one job. decideExistingBuildJob needs to know which matched: a
  // request-key match is the same request arriving twice and is always
  // reusable, while an active job for the target is only reusable when it
  // carries the same configuration.
  return {
    byRequestKey: requestKeyRow ? mapBuildJobRow(requestKeyRow as BuildJobRow) : null,
    activeForTarget: activeRow ? mapBuildJobRow(activeRow as BuildJobRow) : null,
    error: null,
  };
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

  // Feature 25.6 — the hash is not known yet, so this can only settle the
  // cases that do not need it. A repeated request key still short-circuits
  // here without paying for config generation, exactly as before; an active
  // job for this target falls through to the comparison below, which is the
  // one case where the answer genuinely depends on the configuration.
  const earlyDecision = decideExistingBuildJob({
    byRequestKey: earlyLookup.byRequestKey,
    activeForTarget: earlyLookup.activeForTarget,
    submittedConfigHash: null,
  });

  if (earlyDecision.outcome === "reuse") {
    return { ok: true, job: earlyDecision.job, reusedExisting: true };
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

  // Feature 25.6 — THE STALE-PUBLISH REFUSAL.
  //
  // The early pass deferred this because the hash did not exist yet. Now it
  // does: if the active job carries the same configuration, this is a duplicate
  // publish of identical content and reusing it is correct. If it carries a
  // different one, the owner has changed something since that job was created,
  // and returning it would report Published for a snapshot that does not
  // contain their change. Refuse instead — the stale job is left running,
  // untouched and unmodified.
  if (earlyDecision.outcome === "hash_required") {
    const settled = decideExistingBuildJob({
      byRequestKey: null,
      activeForTarget: earlyDecision.job,
      submittedConfigHash: configHash,
    });

    if (settled.outcome === "reuse") {
      return { ok: true, job: settled.job, reusedExisting: true };
    }

    return {
      ok: false,
      errorCode: "active_job_exists",
      message: PUBLISH_IN_PROGRESS_MESSAGE,
    };
  }

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

    // Feature 25.6 — the same rule as above, and it matters just as much here:
    // this is the race where another request won the active-job index between
    // the early lookup and this insert. Reusing the winner is right only if it
    // is publishing the same configuration.
    const recovered = decideExistingBuildJob({
      byRequestKey: recovery.byRequestKey,
      activeForTarget: recovery.activeForTarget,
      submittedConfigHash: configHash,
    });

    if (recovered.outcome === "reuse") {
      return { ok: true, job: recovered.job, reusedExisting: true };
    }

    if (recovered.outcome === "publish_in_progress") {
      return {
        ok: false,
        errorCode: "active_job_exists",
        message: PUBLISH_IN_PROGRESS_MESSAGE,
      };
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

// ============================================================================
// Feature 15.7 — Secure Artifact Download.
// ============================================================================

// Feature 15.7 — sanitized, structured, server-console-only logging for
// the two internal failure classes worth diagnosing. Deliberately logs
// only the buildJobId (already known to the authenticated owner who just
// asked for it) plus a fixed category string — never the signed URL, the
// storage path, the bucket, a Supabase/Storage error object, a cookie, an
// access token, or the service-role key. The raw error is not passed in
// at all, so there is nothing here that *could* leak one.
function logDownloadFailure(
  event: "artifact_download_sign_failed" | "artifact_download_query_failed",
  buildJobId: string,
  category: "storage_signing_failed" | "database_read_failed"
): void {
  console.error(JSON.stringify({ event, buildJobId, category }));
}

// Feature 15.7 — the server-authoritative download path. The browser
// supplies exactly one value (buildJobId) and every other input is either
// derived here or a server-side constant: the artifact type
// (JSON_CONFIG_DOWNLOAD_ARTIFACT_TYPE), the bucket
// (BUILD_ARTIFACTS_DOWNLOAD_BUCKET), the signed-URL lifetime
// (DOWNLOAD_SIGNED_URL_SECONDS), the storage path and the download
// filename (both read from the trusted build_artifacts row, never from
// the caller).
//
// The security boundary is the ordering, and it is load-bearing:
// authentication and BOTH ownership reads go through the normal
// cookie-based, RLS-scoped client (createClient) — the admin client is
// not constructed until every one of those checks has already passed, and
// its only use is the single privileged operation RLS structurally cannot
// grant to an authenticated browser role (createSignedUrl on a bucket
// with no anon/authenticated storage.objects policy at all). The admin
// client never re-reads build_jobs or build_artifacts, so it can never
// stand in for the ownership proof.
export async function createBuildArtifactDownloadUrl(
  buildJobId: string
): Promise<DownloadArtifactResult> {
  // Feature 15.7 correction — the same isValidUuid guard the Server Action
  // wrapper (downloadBuildArtifact) already applies, repeated here as
  // defense in depth: this function is exported, so a future internal
  // caller could reach it without going through that wrapper, and
  // build_jobs.id / build_artifacts.build_job_id are PostgreSQL uuid
  // columns where a malformed value becomes an invalid-input-syntax error
  // rather than an empty result set. Both boundaries deliberately use the
  // one shared helper (lib/buildJobs.ts's isValidUuid) so they can never
  // drift apart, and both report the identical generic not_found result.
  if (!isValidUuid(buildJobId)) {
    return createDownloadArtifactFailure("not_found");
  }

  try {
    const supabase = await createClient();

    const { data: claimsData, error: claimsError } =
      await supabase.auth.getClaims();
    const claims = claimsData?.claims ?? null;

    if (claimsError || !claims) {
      return createDownloadArtifactFailure("unauthenticated");
    }

    // Feature 15.7 — ownership proof #1, via RLS only. build_jobs_select_own
    // (owner_id = auth.uid()) means a job belonging to another user comes
    // back identically to one that does not exist: `data` is null for
    // both, so "not found" and "not yours" are indistinguishable here by
    // construction, with no special-casing needed to make them look alike.
    const { data: jobRow, error: jobError } = await supabase
      .from("build_jobs")
      .select("id, status")
      .eq("id", buildJobId)
      .maybeSingle();

    if (jobError) {
      logDownloadFailure(
        "artifact_download_query_failed",
        buildJobId,
        "database_read_failed"
      );
      return createUnexpectedDownloadFailure();
    }

    if (!jobRow) {
      return createDownloadArtifactFailure("not_found");
    }

    if (!isBuildStatus(jobRow.status)) {
      // A status the domain doesn't recognize is a real data anomaly, not
      // legacy data to coerce — treated as "not ready" rather than
      // guessed at, matching mapBuildJobRow's own reject-rather-than-
      // normalize stance on this exact column.
      return createDownloadArtifactFailure("not_ready");
    }

    // Feature 15.7 — ownership proof #2, again via RLS only.
    // build_artifacts_select_own scopes this through the parent job's
    // owner_id, so this row is only visible to its owner. artifact_type is
    // pinned to the server-side json_config constant here — it is never a
    // parameter of this function, so no caller (including the Server
    // Action wrapper) can widen the download to a future log/apk/
    // desktop_installer artifact. Feature 15.6's
    // UNIQUE (build_job_id, artifact_type) guarantees at most one match.
    const { data: artifactRow, error: artifactError } = await supabase
      .from("build_artifacts")
      .select("artifact_type, storage_path, original_filename, expires_at")
      .eq("build_job_id", buildJobId)
      .eq("artifact_type", JSON_CONFIG_DOWNLOAD_ARTIFACT_TYPE)
      .maybeSingle();

    if (artifactError) {
      logDownloadFailure(
        "artifact_download_query_failed",
        buildJobId,
        "database_read_failed"
      );
      return createUnexpectedDownloadFailure();
    }

    if (!artifactRow) {
      return createDownloadArtifactFailure("not_found");
    }

    const storagePath = artifactRow.storage_path;
    const originalFilename = artifactRow.original_filename;

    // Feature 15.7 — trusted-field validation. These columns are written
    // only by the worker's finalize RPC (and constrained NOT NULL /
    // non-empty by the Feature 15.6 migration), so a failure here means
    // the row is malformed rather than the request being wrong — reported
    // as not_found rather than inventing a new public error code for an
    // anomaly a user can neither cause nor fix.
    if (
      artifactRow.artifact_type !== JSON_CONFIG_DOWNLOAD_ARTIFACT_TYPE ||
      typeof storagePath !== "string" ||
      storagePath.trim() === "" ||
      typeof originalFilename !== "string" ||
      originalFilename.trim() === ""
    ) {
      return createDownloadArtifactFailure("not_found");
    }

    const eligibility = decideBuildArtifactDownloadEligibility({
      buildStatus: jobRow.status,
      expiresAt: artifactRow.expires_at ?? null,
      now: new Date(),
    });

    if (eligibility !== "eligible") {
      return createDownloadArtifactFailure(eligibility);
    }

    // Feature 15.7 — every ownership and eligibility check has now
    // passed. This is the first and only point at which the privileged
    // client exists in this function's scope.
    let admin: AdminSupabaseClient;

    try {
      admin = createAdminClient();
    } catch {
      // Missing/misconfigured service-role configuration. No variable
      // name or value is ever included in the returned message.
      logDownloadFailure(
        "artifact_download_sign_failed",
        buildJobId,
        "storage_signing_failed"
      );
      return createDownloadArtifactFailure("unavailable");
    }

    // Feature 15.7 — the one privileged call. `download:
    // originalFilename` makes Supabase Storage itself set
    // Content-Disposition on the signed response, so the browser saves
    // the file under the server-trusted filename with no Route Handler
    // and no manually constructed header anywhere in this codebase. The
    // filename comes from build_artifacts.original_filename (generated
    // server-side at build time by createGeneratedPosConfigFilename) —
    // never from the client.
    const { data: signed, error: signError } = await admin.storage
      .from(BUILD_ARTIFACTS_DOWNLOAD_BUCKET)
      .createSignedUrl(storagePath, DOWNLOAD_SIGNED_URL_SECONDS, {
        download: originalFilename,
      });

    if (signError || !signed?.signedUrl) {
      // Feature 15.7 — the artifact row is valid but the object could not
      // be signed (missing/inaccessible in Storage). Deliberately does
      // NOT change the build's status and does NOT delete the artifact
      // row — this is a transient-or-operational condition to be
      // investigated, not something to auto-remediate by mutating
      // already-terminal, already-verified records.
      logDownloadFailure(
        "artifact_download_sign_failed",
        buildJobId,
        "storage_signing_failed"
      );
      return createDownloadArtifactFailure("unavailable");
    }

    // Feature 15.7 — the signed URL is returned to the caller and never
    // logged, never written to any table, and never retained here.
    return { ok: true, url: signed.signedUrl, filename: originalFilename };
  } catch {
    // Feature 15.7 — no stack trace, no internal message, no error object
    // is surfaced or logged from here; the thrown value is deliberately
    // not even bound to a variable.
    return createUnexpectedDownloadFailure();
  }
}
