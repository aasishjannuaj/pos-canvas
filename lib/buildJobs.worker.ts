// Feature 15.5 — pure, dependency-free worker-domain decision logic. No
// React, Supabase, or Node-only *import* (crypto.randomUUID() below reads
// off the global `crypto` object — available in both Node 19+ and Vitest
// without an explicit "node:crypto" import — so this file stays
// importable/testable exactly like lib/buildJobs.ts).
// Mirrors, in application code, the same decisions the trusted SQL RPCs
// (claim_next_build_job/heartbeat_build_job/complete_build_job/
// fail_build_job — see the Feature 15.5 migration) enforce in the
// database — kept here as an independently-testable spec of that
// behavior, not as a substitute for the database's own enforcement.
import {
  isSupportedBuildTarget,
  isNonEmptyId,
} from "@/lib/buildJobs";
import type { BuildStatus, BuildTarget } from "@/lib/buildJobs";
import { isGeneratedPosConfig } from "@/lib/generatedPosConfig";
import type { GeneratedPosConfig } from "@/lib/generatedPosConfig";
import { computeGeneratedPosConfigHash } from "@/lib/buildJobs.hash";

// Feature 15.5 — approved lease bounds: matches the same bounds
// claim_next_build_job enforces in SQL. Exported so worker/once.ts can
// validate/clamp its own --lease-seconds input (if ever added) against
// the identical bounds the database will enforce anyway, rather than
// discovering a mismatch only via a rejected RPC call.
export const MIN_LEASE_SECONDS = 30;
export const MAX_LEASE_SECONDS = 3600;
export const DEFAULT_LEASE_SECONDS = 300;

export const MAX_BUILD_JOB_ATTEMPTS = 3;

export function isValidLeaseSeconds(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_LEASE_SECONDS &&
    value <= MAX_LEASE_SECONDS
  );
}

export function isValidWorkerId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

// Feature 15.5 — one worker id generated once per process at startup
// (worker/once.ts), not a fixed/reused name — avoids two instances of a
// same-named worker ever colliding on ownership. Uses the global
// `crypto.randomUUID()` rather than importing "node:crypto" so this
// module never needs a Node-only import for it.
export function generateWorkerId(): string {
  return crypto.randomUUID();
}

// Feature 15.5 — the worker's own --target CLI argument validation,
// reusing isSupportedBuildTarget rather than re-declaring the allowed set.
export function parseBuildTargetArg(value: unknown): BuildTarget | null {
  return isSupportedBuildTarget(value) ? value : null;
}

// Feature 15.5 — mirrors the stale-job predicate the claim RPC's
// candidate CTE evaluates in SQL (status = 'building' and
// lease_expires_at < now()). Takes `now` as an explicit parameter (rather
// than reading Date.now() internally) so this stays a pure function that
// tests can call with fixed clock values.
export function isLeaseExpired(leaseExpiresAt: string, now: Date): boolean {
  return new Date(leaseExpiresAt).getTime() < now.getTime();
}

// Feature 15.5 — mirrors claim_next_build_job's reclaim-eligibility check:
// a stale building job is only reclaimable while attempt_count is still
// below the approved cap (3 total attempts, including the original claim).
export function canReclaimStaleJob(attemptCount: number): boolean {
  return attemptCount < MAX_BUILD_JOB_ATTEMPTS;
}

// Feature 15.5 — mirrors claim_next_build_job's exhaustion branch: once a
// stale building job has reached the attempt cap, it must be finalized as
// failed (worker_timeout) instead of reclaimed again.
export function isExhaustedStaleJob(
  attemptCount: number,
  leaseExpiresAt: string,
  now: Date
): boolean {
  return (
    !canReclaimStaleJob(attemptCount) && isLeaseExpired(leaseExpiresAt, now)
  );
}

// Feature 15.5 — mirrors the ownership check complete_build_job/
// fail_build_job/heartbeat_build_job all enforce in SQL: the caller must
// present the exact claim_token currently stored on the job. A worker that
// lost its lease (superseded by a reclaim, which always mints a fresh
// token) can never satisfy this again.
export function ownsClaim(
  job: { claimToken: string | null },
  claimToken: string
): boolean {
  return isNonEmptyId(claimToken) && job.claimToken === claimToken;
}

// Feature 15.5 hardening correction — mirrors the strengthened
// build_jobs_claim_fields_only_while_building CHECK constraint: a
// 'building' row must carry COMPLETE claim ownership metadata (a
// non-null, non-empty-after-trim claimed_by; a non-null claim_token,
// heartbeat_at, lease_expires_at; and attempt_count > 0), and any
// non-'building' row must carry NONE of those fields. The original,
// weaker form of this invariant (status = 'building' OR all-fields-null)
// would still have permitted a 'building' row with, say, a null
// claim_token — unclaimable by any worker RPC's ownership check, and
// therefore stranded forever. Exported so this invariant has an
// independently-testable spec, matching what the database itself now
// enforces.
export type BuildJobClaimFields = {
  status: BuildStatus;
  claimedBy: string | null;
  claimToken: string | null;
  heartbeatAt: string | null;
  leaseExpiresAt: string | null;
  attemptCount: number;
};

export function hasConsistentClaimFields(job: BuildJobClaimFields): boolean {
  if (job.status === "building") {
    return (
      job.claimedBy !== null &&
      job.claimedBy.trim() !== "" &&
      job.claimToken !== null &&
      job.heartbeatAt !== null &&
      job.leaseExpiresAt !== null &&
      job.attemptCount > 0
    );
  }

  return (
    job.claimedBy === null &&
    job.claimToken === null &&
    job.heartbeatAt === null &&
    job.leaseExpiresAt === null
  );
}

// Feature 15.5 hardening correction — the worker's second trusted read
// (worker/once.ts) is now scoped by id + status='building' +
// claim_token=<the token this exact claim returned> + lease still valid,
// not by id alone. A row that no longer matches every one of those
// filters means this worker's claim has already been lost (reclaimed by
// another worker after a lease expiry, or the job was otherwise
// finalized) — the worker must not process the snapshot, and must not
// call complete_build_job/fail_build_job with an ownership token it can
// no longer prove it holds (both would simply be rejected by the RPCs'
// own ownership predicate anyway, but this decision is made explicit and
// pure here so it has its own test coverage independent of the database
// round-trip). `jobRow` is `unknown` because the only fact this function
// needs is whether the scoped query returned a row at all.
export type SecondReadOutcome = "owned" | "claim_lost";

export function decideSecondReadOutcome(jobRow: unknown): SecondReadOutcome {
  return jobRow ? "owned" : "claim_lost";
}

// Feature 15.6 correction — the specific decision worker/once.ts makes
// after finalize_build_job_with_artifact fails (RPC error, zero rows, or
// malformed data): before ever calling fail_build_job, the worker
// performs its own fresh scoped ownership read (identical shape to the
// second read above — id + status='building' + claim_token match + lease
// still valid) rather than relying solely on fail_build_job's own
// ownership predicate to no-op safely. This function takes only that
// read's outcome (SecondReadOutcome — never a claim token, never any
// other identifying value) and decides which of exactly two paths to
// take. Its signature makes it structurally impossible for a claim token
// to reach this decision, let alone any logging derived from it — the
// function has no parameter through which one could flow.
export type FinalizeFailureDisposition =
  | "report_failure"
  | "claim_lost_after_finalize";

export function decideFinalizeFailureDisposition(
  ownershipCheck: SecondReadOutcome
): FinalizeFailureDisposition {
  return ownershipCheck === "owned" ? "report_failure" : "claim_lost_after_finalize";
}

// Feature 15.5 correction — the fix for a real incident: worker/once.ts's
// original `if (failError || !failResult)` check reported a genuine
// Postgrest/RPC error (e.g. the fail_build_job GET-DIAGNOSTICS-into-a-
// boolean-variable bug this correction also fixes at the SQL level) with
// the exact same "did not apply — may have lost its lease" message as an
// ordinary "0 rows matched the ownership predicate" outcome — actively
// misleading during that incident's diagnosis. This function makes the
// two cases distinct and pure/testable: a transition RPC (complete/fail/
// heartbeat_build_job) either applied, hit a real error (message
// preserved for local-console-only logging — never written to a build
// job's own failure_message, and the worker must still never log the
// claim token itself), or genuinely matched no row.
export type RpcTransitionOutcome =
  | { applied: true }
  | { applied: false; reason: "rpc_error"; message: string }
  | { applied: false; reason: "not_applied" };

export function decideRpcTransitionOutcome(
  data: boolean | null | undefined,
  error: { message: string } | null | undefined
): RpcTransitionOutcome {
  if (error) {
    return { applied: false, reason: "rpc_error", message: error.message };
  }

  if (data === true) {
    return { applied: true };
  }

  return { applied: false, reason: "not_applied" };
}

// ============================================================================
// Snapshot integrity validation — Feature 15.5's "before processing" check.
// ============================================================================

export type SnapshotValidationResult =
  | { valid: true; config: GeneratedPosConfig }
  | { valid: false; reason: "invalid_shape" | "schema_version_mismatch" | "hash_mismatch" };

// Feature 15.5 — the exact three checks specified in the approved plan,
// composed into one pure function: isGeneratedPosConfig, an exact
// schemaVersion match against the job row's own recorded
// config_schema_version, and a recomputed config_hash comparison. Any
// failure is reported as `valid: false` with a specific (but still
// internal-only) reason — worker/once.ts maps every `valid: false` case to
// the same public-facing message ("The saved build configuration is
// invalid."), never surfacing which specific check failed to the failed
// job's own failure_message.
export function validateBuildJobSnapshot(input: {
  snapshot: unknown;
  configSchemaVersion: number;
  configHash: string;
}): SnapshotValidationResult {
  if (!isGeneratedPosConfig(input.snapshot)) {
    return { valid: false, reason: "invalid_shape" };
  }

  if (input.snapshot.schemaVersion !== input.configSchemaVersion) {
    return { valid: false, reason: "schema_version_mismatch" };
  }

  const recomputedHash = computeGeneratedPosConfigHash(input.snapshot);

  if (recomputedHash !== input.configHash) {
    return { valid: false, reason: "hash_mismatch" };
  }

  return { valid: true, config: input.snapshot };
}

// Feature 15.6 — Feature 15.5's decidePlaceholderBuildOutcome (a snapshot
// that failed validation failed with invalid_config; one that passed
// still deliberately failed with generation_failed, since no real
// artifact pipeline existed yet) has been removed: the worker no longer
// deliberately fails after a valid snapshot — it proceeds to generate a
// real artifact instead. The invalid-snapshot case, and every real
// pipeline failure case (generation/upload/verification/finalize), are
// now mapped by lib/buildJobs.artifact.ts's mapArtifactFailureReason,
// which covers the full artifact pipeline rather than just this one
// placeholder branch.
