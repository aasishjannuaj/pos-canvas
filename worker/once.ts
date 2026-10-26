// Feature 15.5/15.6 — the standalone build worker's one-shot entrypoint.
// Run via `npm run worker:once -- --target android` (see package.json —
// `node --env-file=.env.local --import tsx worker/once.ts`). Performs
// exactly one claim attempt and exits; no continuous polling loop exists
// yet (deliberately deferred).
//
// Feature 15.6 flow: parse --target -> generate a worker id ->
// claim_next_build_job -> (nothing claimed: exit cleanly) -> second
// trusted read of config_snapshot (now also owner_id/project_id, needed
// for the artifact's storage path) -> validate its integrity -> generate
// a real json_config artifact -> checksum it -> heartbeat -> upload to
// the private build-artifacts bucket -> read the object back and verify
// it -> atomically record the artifact and mark the job succeeded via
// finalize_build_job_with_artifact. This worker never calls
// complete_build_job directly — finalize_build_job_with_artifact is the
// only path to 'succeeded', and only after a verified artifact exists.
//
// Argument parsing (parseArgs) happens before any Supabase client is
// created, so an invalid/missing --target (or --help) is reported and the
// process exits WITHOUT ever touching the database or claiming a real
// job — this is what makes `parseArgs` itself safely testable/callable
// without a live Supabase project.
//
// OFF-2-EXACT-CLAIM-1 — EXACT-JOB MODE. `--job <uuid> --project <uuid>`
// (both, together, with the usual explicit --target) replaces the global
// claim_next_build_job with claim_build_job_by_id: one named job of one
// named business, only while it is still queued (migration
// 20261016120000). Everything after the claim — the scoped ownership
// re-read, heartbeat, upload, read-back verification and finalize — is the
// same code path, with one extra condition on the re-read: the row's
// project must be the one named. Exact mode NEVER falls back to the global
// claim; a job that is missing, unavailable or mismatched stops the run
// (exit 1) without building anything. Without the two flags the worker is
// exactly what it was.
import { pathToFileURL } from "node:url";
import type { BuildTarget } from "@/lib/buildJobs";
import {
  DEFAULT_LEASE_SECONDS,
  decideFinalizeFailureDisposition,
  decideRpcTransitionOutcome,
  decideSecondReadOutcome,
  generateWorkerId,
  parseBuildTargetArg,
  validateBuildJobSnapshot,
} from "@/lib/buildJobs.worker";
import {
  BUILD_ARTIFACTS_BUCKET,
  JSON_CONFIG_ARTIFACT_MIME_TYPE,
  JSON_CONFIG_ARTIFACT_TYPE,
  computeArtifactChecksum,
  createBuildJobArtifactStoragePath,
  createGeneratedPosArtifactBytes,
  decideArtifactFinalizeOutcome,
  decideArtifactVerification,
  decideCleanupOutcome,
  mapArtifactFailureReason,
} from "@/lib/buildJobs.artifact";
import type { ArtifactFailureReason } from "@/lib/buildJobs.artifact";
import { createGeneratedPosConfigFilename } from "@/lib/generatedPosConfig";
import { createWorkerAdminClient } from "@/worker/supabase";

/** OFF-2-EXACT-CLAIM-1 — the one job, of the one business, exact mode may claim. */
export type ExactJobSelection = { jobId: string; projectId: string };

export type ParsedWorkerArgs =
  | { ok: true; target: BuildTarget; exact?: ExactJobSelection }
  | {
      ok: false;
      reason:
        | "help_requested"
        | "missing_target"
        | "invalid_target"
        | "exact_job_incomplete"
        | "exact_flag_repeated"
        | "invalid_job_id"
        | "invalid_project_id";
    };

const TARGET_FLAG = "--target";
const JOB_FLAG = "--job";
const PROJECT_FLAG = "--project";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every occurrence of `--flag value` or `--flag=value`. A bare flag, or one
 * followed by another flag, contributes `null` — present but valueless, which
 * the caller treats as malformed rather than as absent.
 */
function readFlagValues(argv: string[], flag: string): (string | null)[] {
  const values: (string | null)[] = [];

  argv.forEach((arg, index) => {
    if (arg === flag) {
      const next = argv[index + 1];

      values.push(next === undefined || next.startsWith("--") ? null : next);
    } else if (arg.startsWith(`${flag}=`)) {
      values.push(arg.slice(flag.length + 1));
    }
  });

  return values;
}

// Feature 15.5 — pure, dependency-free argument parsing: no Supabase, no
// process.exit, no I/O. Accepts either `--target android` or
// `--target=android`. Reuses parseBuildTargetArg (which itself reuses
// isSupportedBuildTarget from lib/buildJobs.ts) rather than re-declaring
// the allowed target set here.
export function parseArgs(argv: string[]): ParsedWorkerArgs {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { ok: false, reason: "help_requested" };
  }

  const equalsForm = argv.find((arg) => arg.startsWith(`${TARGET_FLAG}=`));

  if (equalsForm) {
    const target = parseBuildTargetArg(equalsForm.slice(TARGET_FLAG.length + 1));
    return target ? withExactSelection(argv, target) : { ok: false, reason: "invalid_target" };
  }

  const flagIndex = argv.indexOf(TARGET_FLAG);

  if (flagIndex === -1) {
    return { ok: false, reason: "missing_target" };
  }

  const target = parseBuildTargetArg(argv[flagIndex + 1]);
  return target ? withExactSelection(argv, target) : { ok: false, reason: "invalid_target" };
}

/**
 * OFF-2-EXACT-CLAIM-1 — layered on a target that already parsed. No --job and
 * no --project returns exactly what parseArgs always returned. Otherwise both
 * must be present, once each, and both must be UUIDs; anything else is
 * refused here, before any Supabase client exists.
 */
function withExactSelection(argv: string[], target: BuildTarget): ParsedWorkerArgs {
  const jobs = readFlagValues(argv, JOB_FLAG);
  const projects = readFlagValues(argv, PROJECT_FLAG);

  if (jobs.length === 0 && projects.length === 0) {
    return { ok: true, target };
  }

  if (jobs.length === 0 || projects.length === 0) {
    return { ok: false, reason: "exact_job_incomplete" };
  }

  if (jobs.length > 1 || projects.length > 1) {
    return { ok: false, reason: "exact_flag_repeated" };
  }

  const [jobId] = jobs;
  const [projectId] = projects;

  if (jobId === null || !UUID_PATTERN.test(jobId)) {
    return { ok: false, reason: "invalid_job_id" };
  }

  if (projectId === null || !UUID_PATTERN.test(projectId)) {
    return { ok: false, reason: "invalid_project_id" };
  }

  return { ok: true, target, exact: { jobId: jobId.toLowerCase(), projectId: projectId.toLowerCase() } };
}

export const HELP_TEXT = `Usage: npm run worker:once -- --target <android|desktop>
       npm run worker:once -- --target <android|desktop> --job <uuid> --project <uuid>

Claims at most one queued (or reclaimable stale) build job for the given
target, generates a real json_config artifact, uploads it to private
storage, verifies it, and marks the job succeeded only after that
succeeds. Does not generate APKs, desktop installers, or any signed
artifact — see the approved Feature 15.6 scope.

With --job and --project (both required together), claims ONLY that build
job of that project, and only while it is still queued. It never falls
back to claiming any other job; if that job cannot be claimed, the run
stops with exit code 1 and builds nothing.`;

const PARSE_FAILURE_MESSAGES: Record<Exclude<Extract<ParsedWorkerArgs, { ok: false }>["reason"], "help_requested">, string> = {
  missing_target: "Missing required --target argument.",
  invalid_target: 'Invalid --target argument (expected "android" or "desktop").',
  exact_job_incomplete: "--job and --project must be given together.",
  exact_flag_repeated: "--job and --project may each be given only once.",
  invalid_job_id: "Invalid --job argument (expected a build job UUID).",
  invalid_project_id: "Invalid --project argument (expected a project UUID).",
};

// ---------------------------------------------------------------------------
// OFF-2-EXACT-CLAIM-1 — which claim RPC runs, and what its answer means.
// Pure: no Supabase, no I/O. main() calls exactly these, so the routing the
// tests prove is the routing that runs.
// ---------------------------------------------------------------------------

export type ClaimPlan =
  | {
      mode: "queue";
      rpc: "claim_next_build_job";
      args: { p_target: BuildTarget; p_worker_id: string; p_lease_seconds: number };
    }
  | {
      mode: "exact";
      rpc: "claim_build_job_by_id";
      exact: ExactJobSelection;
      args: {
        p_build_job_id: string;
        p_project_id: string;
        p_target: BuildTarget;
        p_worker_id: string;
        p_lease_seconds: number;
      };
    };

export function planClaim(
  parsed: Extract<ParsedWorkerArgs, { ok: true }>,
  workerId: string,
  leaseSeconds: number = DEFAULT_LEASE_SECONDS
): ClaimPlan {
  if (parsed.exact === undefined) {
    return {
      mode: "queue",
      rpc: "claim_next_build_job",
      args: { p_target: parsed.target, p_worker_id: workerId, p_lease_seconds: leaseSeconds },
    };
  }

  return {
    mode: "exact",
    rpc: "claim_build_job_by_id",
    exact: parsed.exact,
    args: {
      p_build_job_id: parsed.exact.jobId,
      p_project_id: parsed.exact.projectId,
      p_target: parsed.target,
      p_worker_id: workerId,
      p_lease_seconds: leaseSeconds,
    },
  };
}

export type ClaimOutcome =
  /** Proceed with the shared post-claim path. */
  | { kind: "claimed" }
  /** Queue mode only: an empty queue is a normal, successful run (exit 0). */
  | { kind: "no_job_available" }
  /** Exact mode: the named job could not be claimed. Stop, build nothing (exit 1). */
  | { kind: "exact_job_unavailable" }
  /** Exact mode: the claim answered with a different job or target. Stop, build nothing (exit 1). */
  | { kind: "exact_job_mismatch" };

export function decideClaimOutcome(
  plan: ClaimPlan,
  claimed: { id?: unknown; target?: unknown } | null | undefined
): ClaimOutcome {
  if (plan.mode === "queue") {
    return claimed ? { kind: "claimed" } : { kind: "no_job_available" };
  }

  if (!claimed) {
    return { kind: "exact_job_unavailable" };
  }

  const id = typeof claimed.id === "string" ? claimed.id.toLowerCase() : null;

  return id === plan.exact.jobId && claimed.target === plan.args.p_target
    ? { kind: "claimed" }
    : { kind: "exact_job_mismatch" };
}

// Feature 15.5 — a single structured, single-line log record per step:
// workerId, jobId (once known), target, event, and (on the final step)
// durationMs — never the config snapshot, never the claim token, never
// any credential. Matches the approved "no persistent log artifact yet"
// scope: console only.
function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...fields }));
}

type ClaimedJob = {
  id: string;
  target: string;
  claim_token: string;
  lease_expires_at: string;
  attempt_count: number;
};

// Feature 15.6 — best-effort cleanup of an orphaned upload (attempted
// when verification or finalization fails after a successful upload).
// Failure here is logged internally only and never substituted into, or
// allowed to overwrite, the caller's own sanitized user-facing failure
// message — a cleanup failure is a housekeeping concern, not a build
// failure reason in its own right.
async function attemptCleanup(
  admin: ReturnType<typeof createWorkerAdminClient>,
  storagePath: string,
  context: { workerId: string; target: BuildTarget; jobId: string }
): Promise<void> {
  const { error } = await admin.storage.from(BUILD_ARTIFACTS_BUCKET).remove([storagePath]);
  const outcome = decideCleanupOutcome(error);

  log({ ...context, event: "cleanup_attempted", outcome });

  if (outcome === "cleanup_failed") {
    // Feature 15.6 — internal diagnostic only; never surfaced to any
    // build_jobs.failure_message, and the raw storage error is never
    // logged in full (its .message is a Storage-generated string, not a
    // credential, but this still keeps the log shape consistent with the
    // rest of the worker's sanitized-logging convention).
    console.error("Cleanup of an orphaned artifact upload failed.");
  }
}

// Feature 15.6 — every real-pipeline failure funnels through this single
// path: map the reason to its approved {failureCode, failureMessage}
// (lib/buildJobs.artifact.ts's mapArtifactFailureReason), call
// fail_build_job, and log the true outcome — including the case where
// fail_build_job itself doesn't apply (the claim was already lost by the
// time this ran). fail_build_job's own ownership predicate (status =
// 'building', claim_token matches, lease still valid) is what actually
// prevents any stale-ownership mutation — calling it is always safe, even
// if ownership already lapsed, since it is then simply a no-op.
async function reportFailure(
  admin: ReturnType<typeof createWorkerAdminClient>,
  reason: ArtifactFailureReason,
  context: { workerId: string; target: BuildTarget; jobId: string; claimToken: string; startedAt: number }
): Promise<void> {
  const outcome = mapArtifactFailureReason(reason);

  const { data, error } = await admin.rpc("fail_build_job", {
    p_build_job_id: context.jobId,
    p_claim_token: context.claimToken,
    p_failure_code: outcome.failureCode,
    p_failure_message: outcome.failureMessage,
  });

  const transition = decideRpcTransitionOutcome(data, error);

  if (!transition.applied) {
    if (transition.reason === "rpc_error") {
      console.error("fail_build_job raised an error:", transition.message);
    } else {
      log({
        workerId: context.workerId,
        target: context.target,
        jobId: context.jobId,
        event: "claim_lost",
        durationMs: Date.now() - context.startedAt,
      });
    }
    process.exitCode = 1;
    return;
  }

  log({
    workerId: context.workerId,
    target: context.target,
    jobId: context.jobId,
    event: "failed",
    failureCode: outcome.failureCode,
    durationMs: Date.now() - context.startedAt,
  });
  process.exitCode = 1;
}

export async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  if (!parsed.ok) {
    if (parsed.reason === "help_requested") {
      console.log(HELP_TEXT);
      process.exitCode = 0;
      return;
    }

    console.error(`${PARSE_FAILURE_MESSAGES[parsed.reason]}\n\n${HELP_TEXT}`);
    process.exitCode = 1;
    return;
  }

  const { target } = parsed;
  const workerId = generateWorkerId();
  const startedAt = Date.now();
  const plan = planClaim(parsed, workerId);

  // Feature 15.5 — createWorkerAdminClient() only ever runs after argument
  // validation has already passed, so a malformed CLI invocation never
  // even attempts to read Supabase env/create a service-role client.
  const admin = createWorkerAdminClient();

  log(
    plan.mode === "exact"
      ? { workerId, target, mode: "exact", jobId: plan.exact.jobId, event: "claim_attempt" }
      : { workerId, target, event: "claim_attempt" }
  );

  // OFF-2-EXACT-CLAIM-1 — ONE claim call, chosen by planClaim. There is no
  // second call: exact mode cannot fall through to the global claim.
  const { data: claimRows, error: claimError } = await admin.rpc(plan.rpc, plan.args);

  if (claimError) {
    console.error(`${plan.rpc} failed:`, claimError.message);
    process.exitCode = 1;
    return;
  }

  const claimed = (Array.isArray(claimRows) ? claimRows[0] : claimRows) as
    | ClaimedJob
    | null
    | undefined;

  const claimOutcome = decideClaimOutcome(plan, claimed);

  if (claimOutcome.kind === "no_job_available") {
    log({
      workerId,
      target,
      event: "no_job_available",
      durationMs: Date.now() - startedAt,
    });
    return;
  }

  if (claimOutcome.kind !== "claimed" || !claimed) {
    // Exact mode only. Nothing is built, uploaded or finalized. A mismatched
    // claim (which the SQL cannot produce) is deliberately left alone rather
    // than failed: this worker cannot prove the row it would touch is its own.
    log({
      workerId,
      target,
      mode: "exact",
      jobId: plan.mode === "exact" ? plan.exact.jobId : undefined,
      event: claimOutcome.kind,
      durationMs: Date.now() - startedAt,
    });
    process.exitCode = 1;
    return;
  }

  const buildJobId = claimed.id;
  const claimToken = claimed.claim_token;

  log({ workerId, target, jobId: buildJobId, event: "claimed" });

  // Feature 15.6 — now also selects owner_id/project_id (needed to build
  // the artifact's storage path) alongside the existing three integrity
  // fields. Still scoped by every one of: id, status = 'building',
  // claim_token = the exact token this claim returned, and lease still
  // valid — the same trust boundary as Feature 15.5, just reading two
  // more columns from that same already-authorized row.
  //
  // OFF-2-EXACT-CLAIM-1 — in exact mode the row must ALSO belong to the
  // project that was named, so even a row returned by mistake could not be
  // built under another business.
  let ownedRowQuery = admin
    .from("build_jobs")
    .select("config_snapshot, config_schema_version, config_hash, owner_id, project_id")
    .eq("id", buildJobId)
    .eq("status", "building")
    .eq("claim_token", claimToken)
    .gt("lease_expires_at", new Date().toISOString());

  if (plan.mode === "exact") {
    ownedRowQuery = ownedRowQuery.eq("project_id", plan.exact.projectId);
  }

  const { data: jobRow, error: readError } = await ownedRowQuery.maybeSingle();

  if (readError) {
    // Feature 15.5 hardening correction — a genuine query error, not a
    // "claim lost" result: ownership could not be verified either way, so
    // this worker must not speculatively call fail_build_job/
    // complete_build_job with a token it can no longer confirm it owns.
    console.error("Unable to verify claim ownership before processing.");
    process.exitCode = 1;
    return;
  }

  // Feature 15.5 hardening correction — never log claimToken itself, in
  // this branch or any other; only jobId/workerId/target/event identify
  // the situation. The `!jobRow` conjunct is redundant with
  // decideSecondReadOutcome's own "claim_lost" result (by construction,
  // they can never disagree) but lets TypeScript narrow `jobRow` to
  // non-null for every use below, since the function call alone can't.
  if (decideSecondReadOutcome(jobRow) === "claim_lost" || !jobRow) {
    log({
      workerId,
      target,
      jobId: buildJobId,
      event: "claim_lost",
      durationMs: Date.now() - startedAt,
    });
    process.exitCode = 1;
    return;
  }

  const validation = validateBuildJobSnapshot({
    snapshot: jobRow.config_snapshot,
    configSchemaVersion: jobRow.config_schema_version,
    configHash: jobRow.config_hash,
  });

  const failureContext = { workerId, target, jobId: buildJobId, claimToken, startedAt };

  if (!validation.valid) {
    await reportFailure(admin, "invalid_config", failureContext);
    return;
  }

  const { config } = validation;

  // Feature 15.6 — real artifact generation. Deliberately synchronous/
  // in-memory (a JSON serialization, not a network/OS-level build step),
  // so a heartbeat before this point isn't needed — only before the one
  // real network step (upload), below.
  let bytes: Uint8Array;

  try {
    bytes = createGeneratedPosArtifactBytes(config);
  } catch {
    await reportFailure(admin, "generation_failed", failureContext);
    return;
  }

  const checksum = computeArtifactChecksum(bytes);

  const storagePath = createBuildJobArtifactStoragePath({
    ownerId: jobRow.owner_id,
    projectId: jobRow.project_id,
    buildJobId,
  });

  // Feature 15.6 — ownerId/projectId/buildJobId are all trusted uuid
  // database columns, never raw user input, so createBuildJobArtifactStoragePath
  // returning null here should be unreachable in practice. Treated as a
  // generation failure (the pipeline could not produce a valid artifact
  // target), not a distinct failure code — defensive only.
  if (storagePath === null) {
    await reportFailure(admin, "generation_failed", failureContext);
    return;
  }

  const originalFilename = createGeneratedPosConfigFilename(
    config.project.projectName,
    config.schemaVersion
  );

  // Feature 15.6 — one heartbeat immediately before the one real network
  // step. Still requires status = 'building', claim_token match, and an
  // unexpired lease — the exact same ownership predicate every other
  // transition RPC enforces. Any failure here (error or "0 rows matched")
  // means this worker's claim is no longer trustworthy: it must not
  // upload, must not finalize, and must not call any terminal RPC with
  // ownership it can no longer prove.
  const { data: heartbeatData, error: heartbeatError } = await admin.rpc(
    "heartbeat_build_job",
    {
      p_build_job_id: buildJobId,
      p_claim_token: claimToken,
      p_lease_seconds: DEFAULT_LEASE_SECONDS,
    }
  );

  const heartbeatOutcome = decideRpcTransitionOutcome(heartbeatData, heartbeatError);

  if (!heartbeatOutcome.applied) {
    if (heartbeatOutcome.reason === "rpc_error") {
      console.error("heartbeat_build_job raised an error:", heartbeatOutcome.message);
    }
    log({
      workerId,
      target,
      jobId: buildJobId,
      event: "claim_lost",
      durationMs: Date.now() - startedAt,
    });
    process.exitCode = 1;
    return;
  }

  log({ workerId, target, jobId: buildJobId, event: "heartbeat_ok" });

  // Feature 15.6 — upload to the private build-artifacts bucket.
  // upsert: false — this worker must never overwrite an existing object;
  // the deterministic, job-scoped storage path means a collision here
  // would indicate something unexpected, not a legitimate retry (a retry
  // is always a new build_jobs row, hence a new, non-colliding path).
  const { error: uploadError } = await admin.storage
    .from(BUILD_ARTIFACTS_BUCKET)
    .upload(storagePath, bytes, {
      contentType: JSON_CONFIG_ARTIFACT_MIME_TYPE,
      upsert: false,
    });

  if (uploadError) {
    await reportFailure(admin, "upload_failed", failureContext);
    return;
  }

  log({ workerId, target, jobId: buildJobId, event: "uploaded" });

  // Feature 15.6 — verification: read the exact object back and confirm
  // it matches what was generated, rather than trusting the upload call's
  // own success response alone.
  const { data: downloadedBlob, error: downloadError } = await admin.storage
    .from(BUILD_ARTIFACTS_BUCKET)
    .download(storagePath);

  if (downloadError || !downloadedBlob) {
    await attemptCleanup(admin, storagePath, { workerId, target, jobId: buildJobId });
    await reportFailure(admin, "verification_failed", failureContext);
    return;
  }

  const downloadedBytes = new Uint8Array(await downloadedBlob.arrayBuffer());
  const downloadedChecksum = computeArtifactChecksum(downloadedBytes);

  const verification = decideArtifactVerification({
    expectedByteLength: bytes.length,
    expectedChecksum: checksum,
    actualByteLength: downloadedBytes.length,
    actualChecksum: downloadedChecksum,
  });

  if (!verification.verified) {
    await attemptCleanup(admin, storagePath, { workerId, target, jobId: buildJobId });
    await reportFailure(admin, "verification_failed", failureContext);
    return;
  }

  log({ workerId, target, jobId: buildJobId, event: "verified" });

  // Feature 15.6 — the atomic finalize call: records the artifact and
  // marks the job succeeded in one transaction. This worker never calls
  // complete_build_job directly.
  const { data: finalizeRows, error: finalizeError } = await admin.rpc(
    "finalize_build_job_with_artifact",
    {
      p_build_job_id: buildJobId,
      p_claim_token: claimToken,
      p_artifact_type: JSON_CONFIG_ARTIFACT_TYPE,
      p_storage_path: storagePath,
      p_original_filename: originalFilename,
      p_mime_type: JSON_CONFIG_ARTIFACT_MIME_TYPE,
      p_file_size_bytes: bytes.length,
      p_checksum: checksum,
      p_expires_at: null,
    }
  );

  const finalizeOutcome = decideArtifactFinalizeOutcome(finalizeRows, finalizeError);

  if (!finalizeOutcome.finalized) {
    // Feature 15.6 correction — a good, verified upload whose finalize
    // call didn't apply (RPC error, zero rows, or malformed data). Rather
    // than relying solely on fail_build_job's own ownership predicate to
    // no-op safely, this worker now performs its own fresh scoped
    // ownership read first — identical shape to the second read earlier
    // in this file (id + status='building' + claim_token match + lease
    // still valid) — and only calls fail_build_job when that read
    // confirms the claim is still genuinely held. If it doesn't, this is
    // classified as claim_lost_after_finalize: no fail_build_job call, no
    // complete_build_job call, no claim token in any log line.
    if (finalizeOutcome.reason === "rpc_error") {
      console.error("finalize_build_job_with_artifact raised an error:", finalizeOutcome.message);
    }

    await attemptCleanup(admin, storagePath, { workerId, target, jobId: buildJobId });

    const { data: ownershipRow, error: ownershipError } = await admin
      .from("build_jobs")
      .select("id")
      .eq("id", buildJobId)
      .eq("status", "building")
      .eq("claim_token", claimToken)
      .gt("lease_expires_at", new Date().toISOString())
      .maybeSingle();

    if (ownershipError) {
      // Feature 15.6 correction — a genuine query error, not a confirmed
      // "claim lost" result: ownership could not be verified either way,
      // so fail_build_job must not be called speculatively.
      console.error("Unable to verify claim ownership after a failed finalize attempt.");
      process.exitCode = 1;
      return;
    }

    const disposition = decideFinalizeFailureDisposition(
      decideSecondReadOutcome(ownershipRow)
    );

    if (disposition === "claim_lost_after_finalize") {
      log({
        workerId,
        target,
        jobId: buildJobId,
        event: "claim_lost_after_finalize",
        durationMs: Date.now() - startedAt,
      });
      process.exitCode = 1;
      return;
    }

    // Feature 15.6 correction — ownership confirmed still held; safe to
    // report through the normal failure path. fail_build_job independently
    // re-enforces its own claim_token/lease check regardless — this
    // precheck narrows the window, it doesn't replace that enforcement.
    await reportFailure(admin, "finalize_failed", failureContext);
    return;
  }

  log({
    workerId,
    target,
    jobId: buildJobId,
    event: "succeeded",
    artifactId: finalizeOutcome.artifactId,
    durationMs: Date.now() - startedAt,
  });
}

// Feature 15.5 — ESM equivalent of `require.main === module`: main() only
// runs when this file is the process's actual entrypoint (the `tsx
// worker/once.ts` invocation), never when it's merely imported — e.g. by
// worker/once.test.ts, which imports parseArgs/HELP_TEXT without wanting
// main() to execute and attempt a real Supabase connection.
const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((error) => {
    console.error(
      "worker:once crashed:",
      error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
  });
}
