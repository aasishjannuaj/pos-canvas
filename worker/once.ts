// Feature 15.5 — the standalone build worker's one-shot entrypoint.
// Run via `npm run worker:once -- --target android` (see package.json —
// `node --env-file=.env.local --import tsx worker/once.ts`). Performs
// exactly one claim attempt and exits; no continuous polling loop exists
// yet (deliberately deferred — see the approved Feature 15.5 plan).
//
// Flow: parse --target -> generate a worker id -> claim_next_build_job ->
// (nothing claimed: exit cleanly) -> second trusted read of
// config_snapshot -> validate its integrity -> deliberately fail the job
// with a placeholder result (invalid_config or generation_failed). This
// worker must NEVER call complete_build_job — no real artifact generation
// exists yet, and marking a job succeeded without one would be a fake
// success the Builder UI would misreport as "Ready".
//
// Argument parsing (parseArgs) happens before any Supabase client is
// created, so an invalid/missing --target (or --help) is reported and the
// process exits WITHOUT ever touching the database or claiming a real
// job — this is what makes `parseArgs` itself safely testable/callable
// without a live Supabase project.
import { pathToFileURL } from "node:url";
import type { BuildTarget } from "@/lib/buildJobs";
import {
  DEFAULT_LEASE_SECONDS,
  decidePlaceholderBuildOutcome,
  decideRpcTransitionOutcome,
  decideSecondReadOutcome,
  generateWorkerId,
  parseBuildTargetArg,
  validateBuildJobSnapshot,
} from "@/lib/buildJobs.worker";
import { createWorkerAdminClient } from "@/worker/supabase";

export type ParsedWorkerArgs =
  | { ok: true; target: BuildTarget }
  | {
      ok: false;
      reason: "help_requested" | "missing_target" | "invalid_target";
    };

const TARGET_FLAG = "--target";

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
    return target ? { ok: true, target } : { ok: false, reason: "invalid_target" };
  }

  const flagIndex = argv.indexOf(TARGET_FLAG);

  if (flagIndex === -1) {
    return { ok: false, reason: "missing_target" };
  }

  const target = parseBuildTargetArg(argv[flagIndex + 1]);
  return target ? { ok: true, target } : { ok: false, reason: "invalid_target" };
}

export const HELP_TEXT = `Usage: npm run worker:once -- --target <android|desktop>

Claims at most one queued (or reclaimable stale) build job for the given
target, validates its config snapshot, and deliberately fails it with a
placeholder result. This feature does not generate real build artifacts
yet — it only proves the claim -> validate -> transition pipeline.`;

// Feature 15.5 — a single structured, single-line log record per step:
// workerId, jobId (once known), target, event, and (on the final step)
// durationMs — never the config snapshot, never any credential. Matches
// the approved "no persistent log artifact yet" scope: console only.
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

export async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  if (!parsed.ok) {
    if (parsed.reason === "help_requested") {
      console.log(HELP_TEXT);
      process.exitCode = 0;
      return;
    }

    console.error(
      parsed.reason === "missing_target"
        ? `Missing required --target argument.\n\n${HELP_TEXT}`
        : `Invalid --target argument (expected "android" or "desktop").\n\n${HELP_TEXT}`
    );
    process.exitCode = 1;
    return;
  }

  const { target } = parsed;
  const workerId = generateWorkerId();
  const startedAt = Date.now();

  // Feature 15.5 — createWorkerAdminClient() only ever runs after argument
  // validation has already passed, so a malformed CLI invocation never
  // even attempts to read Supabase env/create a service-role client.
  const admin = createWorkerAdminClient();

  log({ workerId, target, event: "claim_attempt" });

  const { data: claimRows, error: claimError } = await admin.rpc(
    "claim_next_build_job",
    {
      p_target: target,
      p_worker_id: workerId,
      p_lease_seconds: DEFAULT_LEASE_SECONDS,
    }
  );

  if (claimError) {
    console.error("claim_next_build_job failed:", claimError.message);
    process.exitCode = 1;
    return;
  }

  const claimed = (Array.isArray(claimRows) ? claimRows[0] : claimRows) as
    | ClaimedJob
    | null
    | undefined;

  if (!claimed) {
    log({
      workerId,
      target,
      event: "no_job_available",
      durationMs: Date.now() - startedAt,
    });
    return;
  }

  const buildJobId = claimed.id;
  const claimToken = claimed.claim_token;

  log({ workerId, target, jobId: buildJobId, event: "claimed" });

  // Feature 15.5 hardening correction — the second trusted read is scoped
  // by every one of: id, status = 'building', claim_token = the exact
  // token this claim returned, and lease still valid (lease_expires_at >
  // now) — not by id alone. A row that no longer matches all four filters
  // means this worker's claim has already been lost (superseded by a
  // reclaim after a lease expiry, or otherwise finalized) between the
  // claim RPC and this read. `.maybeSingle()` (not `.single()`) so "zero
  // rows matched" comes back as data: null, error: null — a clean,
  // distinguishable outcome from a genuine query error.
  const { data: jobRow, error: readError } = await admin
    .from("build_jobs")
    .select("config_snapshot, config_schema_version, config_hash")
    .eq("id", buildJobId)
    .eq("status", "building")
    .eq("claim_token", claimToken)
    .gt("lease_expires_at", new Date().toISOString())
    .maybeSingle();

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

  // Feature 15.5 — the approved placeholder outcome. This worker never
  // calls complete_build_job: a validation pass here proves the job's
  // *input* is trustworthy, not that a build was produced.
  const outcome = decidePlaceholderBuildOutcome(validation);

  const { data: failResult, error: failError } = await admin.rpc(
    "fail_build_job",
    {
      p_build_job_id: buildJobId,
      p_claim_token: claimToken,
      p_failure_code: outcome.failureCode,
      p_failure_message: outcome.failureMessage,
    }
  );

  // Feature 15.5 correction — an incident during the first live worker
  // test showed the previous `if (failError || !failResult)` check
  // reporting a genuine RPC error (the fail_build_job GET-DIAGNOSTICS
  // type-cast bug this correction also fixes at the SQL level) with the
  // exact same "did not apply — may have lost its lease" message as an
  // ordinary "0 rows matched" outcome, which made root-causing the real
  // bug harder than it needed to be. decideRpcTransitionOutcome keeps
  // these distinguishable. The error message is logged to the local
  // console only (never into the job's own failure_message, never the
  // claim token itself).
  const failOutcome = decideRpcTransitionOutcome(failResult, failError);

  if (!failOutcome.applied) {
    if (failOutcome.reason === "rpc_error") {
      console.error("fail_build_job raised an error:", failOutcome.message);
    } else {
      console.error(
        "fail_build_job did not apply — 0 rows matched (ownership may have been lost)."
      );
    }
    process.exitCode = 1;
    return;
  }

  log({
    workerId,
    target,
    jobId: buildJobId,
    event: "failed",
    failureCode: outcome.failureCode,
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
