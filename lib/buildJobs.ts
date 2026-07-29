// Feature 15.2 — Build Job domain types and pure, dependency-free helpers.
// No React, Supabase, browser API, or Node-only (e.g. node:crypto)
// dependency — safe to import from anywhere, including a future client
// component, without risking a Node-only module ending up in a browser
// bundle. The one thing in this domain that genuinely needs node:crypto
// (hashing) lives in lib/buildJobs.server.ts instead — see that file for
// why the split matters.
import type { GeneratedPosConfig } from "@/lib/generatedPosConfig";

// Feature 15.2 — approved target set. "web" is deliberately not included:
// the existing /runtime/project-{id} viewer already serves "run this POS
// on the web" with no build step at all, so a future "web build" would
// need its own, still-undefined meaning before it belongs in this union.
export type BuildTarget = "android" | "desktop";

export const BUILD_TARGETS: readonly BuildTarget[] = ["android", "desktop"];

// Feature 15.2 — approved status set. queued -> building -> succeeded|failed
// only; see isValidBuildStatusTransition below for the enforced state
// machine. No "preparing" or "cancelled" status exists yet — both were
// deliberately deferred in the approved architecture.
export type BuildStatus = "queued" | "building" | "succeeded" | "failed";

export const BUILD_STATUSES: readonly BuildStatus[] = [
  "queued",
  "building",
  "succeeded",
  "failed",
];

export const TERMINAL_BUILD_STATUSES: readonly BuildStatus[] = [
  "succeeded",
  "failed",
];

// Feature 15.2 — approved failure codes. No "cancelled_by_user": there is
// no cancellation concept in the current status model, so a failure code
// implying one would be misleading.
export type BuildFailureCode =
  | "generation_failed"
  | "invalid_config"
  | "worker_timeout"
  | "worker_crashed"
  | "signing_failed"
  | "artifact_upload_failed";

export function isSupportedBuildTarget(value: unknown): value is BuildTarget {
  return (
    typeof value === "string" &&
    (BUILD_TARGETS as readonly string[]).includes(value)
  );
}

export function isBuildStatus(value: unknown): value is BuildStatus {
  return (
    typeof value === "string" &&
    (BUILD_STATUSES as readonly string[]).includes(value)
  );
}

export function isTerminalBuildStatus(status: BuildStatus): boolean {
  return (TERMINAL_BUILD_STATUSES as readonly BuildStatus[]).includes(status);
}

export const BUILD_FAILURE_CODES: readonly BuildFailureCode[] = [
  "generation_failed",
  "invalid_config",
  "worker_timeout",
  "worker_crashed",
  "signing_failed",
  "artifact_upload_failed",
];

export function isBuildFailureCode(value: unknown): value is BuildFailureCode {
  return (
    typeof value === "string" &&
    (BUILD_FAILURE_CODES as readonly string[]).includes(value)
  );
}

// Feature 15.3 — a small, generic non-empty-string guard, reused for every
// id-shaped input (projectId, retriedFromJobId, buildJobId) rather than
// repeating the same typeof/trim check at each call site.
export function isNonEmptyId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

const MAX_REQUEST_KEY_LENGTH = 200;

// Feature 15.3 — validates and trims a client-supplied idempotency key.
// Returns null (never throws) for anything that fails validation, so
// callers can treat "invalid request key" the same way they treat any
// other malformed input. The max length is a sanity bound, not a security
// boundary — request_key is never interpreted as anything other than an
// opaque comparison token.
export function normalizeRequestKey(value: string): string | null {
  const trimmed = value.trim();

  if (trimmed === "" || trimmed.length > MAX_REQUEST_KEY_LENGTH) {
    return null;
  }

  return trimmed;
}

// Feature 15.2 — the single finite set of valid status transitions,
// matching the approved model exactly. A terminal status (succeeded/failed)
// maps to an empty array: it can never transition to anything else — a
// retry creates a new job row (build_jobs.retried_from_job_id), it never
// reopens this one. A same-status "transition" (e.g. queued -> queued) is
// also rejected here, since it never appears in its own outbound list.
const VALID_TRANSITIONS: Record<BuildStatus, readonly BuildStatus[]> = {
  queued: ["building"],
  building: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
};

export function isValidBuildStatusTransition(
  from: BuildStatus,
  to: BuildStatus
): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

// ============================================================================
// Feature 15.3 — server-side build job creation: browser-safe result types,
// the internal DB row shape + mapper, and pure decision helpers. Everything
// below is still dependency-free (no React/Supabase/Node) — the actual
// Supabase access lives exclusively in lib/buildJobs.server.ts, which
// imports from this file rather than duplicating any of this.
// ============================================================================

// Feature 15.3 — the browser-safe, sanitized shape of a build job. No
// ownerId, no config_snapshot, no request_key — none of those are ever
// meant to reach a client, so they simply have no field to leak through
// here in the first place.
export type BuildJobSummary = {
  id: string;
  projectId: string;
  target: BuildTarget;
  status: BuildStatus;
  configSchemaVersion: number;
  configHash: string;
  retriedFromJobId: string | null;
  failureCode: BuildFailureCode | null;
  failureMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateBuildJobInput = {
  projectId: string;
  target: unknown;
  requestKey: string;
  retriedFromJobId?: string | null;
};

// Feature 15.3 — "invalid_request" is one addition beyond the originally
// suggested error-code list, for a malformed requestKey/retriedFromJobId or
// an invalid retry reference — none of the other codes fit that
// caller-input-shape case cleanly. "active_job_exists" is kept for API
// completeness/future use (e.g. a future caller that wants to fail instead
// of silently reusing an active job) but is never returned by the current
// createBuildJob, whose approved behavior always resolves an active job by
// reuse rather than rejection. "request_conflict" is returned only in the
// rare case an insert fails (almost certainly due to the unique
// constraints protecting against a race) and the recovery re-query still
// can't find the row that caused the conflict.
export type CreateBuildJobErrorCode =
  | "not_authenticated"
  | "invalid_project"
  | "invalid_target"
  | "invalid_config"
  | "invalid_request"
  | "active_job_exists"
  | "request_conflict"
  | "database_error";

export type CreateBuildJobResult =
  | {
      ok: true;
      job: BuildJobSummary;
      reusedExisting: boolean;
    }
  | {
      ok: false;
      errorCode: CreateBuildJobErrorCode;
      message: string;
    };

// Feature 15.3 — the exact narrow row shape lib/buildJobs.server.ts selects
// from build_jobs for every read path (request-key lookup, active-job
// lookup, the insert's own return value, and the two read helpers).
// Deliberately excludes owner_id, config_snapshot, and request_key — none
// of those are needed to produce a BuildJobSummary, so they're simply
// never selected in the first place rather than selected-and-discarded.
export type BuildJobRow = {
  id: string;
  project_id: string;
  target: string;
  status: string;
  config_schema_version: number;
  config_hash: string;
  retried_from_job_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

export const BUILD_JOB_COLUMNS =
  "id, project_id, target, status, config_schema_version, config_hash, retried_from_job_id, failure_code, failure_message, started_at, finished_at, created_at, updated_at";

// Feature 15.3 — never trusts a raw Supabase row directly. target/status
// are core identity/integrity fields enforced by database CHECK
// constraints — an unrecognized value here indicates a genuine data
// problem, not legacy data to coerce, so the whole row is rejected (returns
// null) rather than silently normalized to a possibly-misleading default.
// failureCode is treated more leniently (defensively normalized to null
// rather than rejecting the row) since it's supplementary diagnostic data,
// not core identity.
export function mapBuildJobRow(row: BuildJobRow): BuildJobSummary | null {
  if (!isSupportedBuildTarget(row.target)) {
    return null;
  }

  if (!isBuildStatus(row.status)) {
    return null;
  }

  if (!isNonEmptyId(row.id) || !isNonEmptyId(row.project_id)) {
    return null;
  }

  if (
    !Number.isInteger(row.config_schema_version) ||
    row.config_schema_version <= 0
  ) {
    return null;
  }

  if (!isNonEmptyId(row.config_hash)) {
    return null;
  }

  return {
    id: row.id,
    projectId: row.project_id,
    target: row.target,
    status: row.status,
    configSchemaVersion: row.config_schema_version,
    configHash: row.config_hash,
    retriedFromJobId: row.retried_from_job_id,
    failureCode: isBuildFailureCode(row.failure_code) ? row.failure_code : null,
    failureMessage:
      typeof row.failure_message === "string" ? row.failure_message : null,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Feature 15.3 — the pure decision logic behind requirements C and D,
// separated from any Supabase query so it's testable without a database.
// Request-key match always wins when present, regardless of its own
// status or target (a request-key retry must never create a second job,
// and must never be reinterpreted just because the target differs) — the
// active-job-for-this-target lookup is only ever consulted as a fallback
// when no request-key match exists.
export function resolveExistingBuildJob(lookup: {
  byRequestKey: BuildJobSummary | null;
  activeForTarget: BuildJobSummary | null;
}): BuildJobSummary | null {
  if (lookup.byRequestKey) {
    return lookup.byRequestKey;
  }

  return lookup.activeForTarget;
}

// Feature 15.3 — the pure retry-validation logic behind requirement E,
// again separated from any Supabase query. A retry reference is valid only
// when the referenced job exists, belongs to the same owner, the same
// project, the same target (the approved, safer choice over allowing a
// cross-target retry), and has already reached a terminal status. Every
// failure mode (missing, wrong owner, wrong project, wrong target,
// non-terminal) is treated identically by the caller — this function only
// returns a boolean, never a reason — so a caller can never distinguish
// "doesn't exist" from "belongs to someone else" from the outside.
export function isValidRetryReference(input: {
  retriedFromJob: {
    ownerId: string;
    projectId: string;
    target: BuildTarget;
    status: BuildStatus;
  } | null;
  requestOwnerId: string;
  requestProjectId: string;
  requestTarget: BuildTarget;
}): boolean {
  const { retriedFromJob } = input;

  if (retriedFromJob === null) {
    return false;
  }

  return (
    retriedFromJob.ownerId === input.requestOwnerId &&
    retriedFromJob.projectId === input.requestProjectId &&
    retriedFromJob.target === input.requestTarget &&
    isTerminalBuildStatus(retriedFromJob.status)
  );
}

// Feature 15.2 — deterministic canonical JSON serialization of a
// GeneratedPosConfig, for hashing (lib/buildJobs.server.ts) and for any
// other future content-identity comparison. Excludes only generatedAt —
// the one field expected to legitimately differ between two otherwise-
// identical generations (see lib/generatedPosConfig.ts's own documentation
// of that field) — every other field, at every depth, participates.
// Object keys are sorted recursively so incidental key-insertion-order
// differences can never change the canonical string for the same content;
// array order and values are preserved exactly, since array order is
// meaningful data (e.g. menuItems order), not incidental structure. Pure —
// builds a brand-new plain object rather than mutating config, and never
// writes back into any nested value either.
export function canonicalizeGeneratedPosConfig(
  config: GeneratedPosConfig
): string {
  const configWithoutGeneratedAt: Omit<GeneratedPosConfig, "generatedAt"> = {
    schemaVersion: config.schemaVersion,
    project: config.project,
    businessProfile: config.businessProfile,
    branding: config.branding,
    menuItems: config.menuItems,
    tax: config.tax,
    receipt: config.receipt,
  };

  return stableStringify(configWithoutGeneratedAt);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort();
    const entries = sortedKeys.map(
      (key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`
    );
    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value);
}

const MAX_FAILURE_MESSAGE_LENGTH = 300;
const GENERIC_FAILURE_MESSAGE = "The build failed due to an internal error.";

// Feature 15.2 — a best-effort redaction pass, not a guarantee of complete
// secret detection. Each pattern targets an obviously secret-shaped
// substring (never a full-message heuristic), so the surrounding sentence
// stays readable once the matched span is replaced. Detailed raw logs
// (which may contain other, less obviously-shaped secrets) must never be
// stored in failure_message at all — that's what build_artifacts' 'log'
// artifact type is for, per the approved architecture; this sanitizer only
// ever needs to handle a short, human-authored failure summary.
const REDACTION_PATTERNS: RegExp[] = [
  /bearer\s+[a-z0-9._-]+/gi,
  /authorization\s*:\s*.+/gi,
  /service[_-]?role[_-]?key\s*[:=]\s*\S+/gi,
  /(password|passwd|pwd)\s*[:=]\s*\S+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
];

export function sanitizeBuildFailureMessage(value: unknown): string {
  if (typeof value !== "string") {
    return GENERIC_FAILURE_MESSAGE;
  }

  let sanitized = value;

  for (const pattern of REDACTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[redacted]");
  }

  // Collapse line breaks/control characters into single spaces so a
  // multi-line message can't smuggle formatting or hide content below the
  // visible fold; trimmed afterward in case that collapsing left leading/
  // trailing whitespace.
  sanitized = sanitized.replace(/[\r\n\t\x00-\x1F\x7F]+/g, " ").trim();

  if (sanitized === "") {
    return GENERIC_FAILURE_MESSAGE;
  }

  if (sanitized.length > MAX_FAILURE_MESSAGE_LENGTH) {
    sanitized = `${sanitized.slice(0, MAX_FAILURE_MESSAGE_LENGTH).trim()}…`;
  }

  return sanitized;
}
