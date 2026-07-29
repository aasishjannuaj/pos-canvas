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
