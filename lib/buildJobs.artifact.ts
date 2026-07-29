// Feature 15.6 — the build artifact pipeline's pure/server-safe domain
// logic: byte generation, path construction, checksums, and the decision
// functions worker/once.ts uses to interpret Storage/RPC results. No
// React or browser-only API — this module is never imported by client
// bundles (only worker/once.ts does), so unlike lib/buildJobs.ts it does
// not need to stay import-safe from a hypothetical future client
// component; it uses node:crypto directly, exactly like
// lib/buildJobs.hash.ts. Kept out of lib/buildJobs.server.ts (which has
// `import "server-only"`) so worker/once.ts — a plain Node process that
// never runs through Next's bundler — can import it safely (the same
// reasoning that produced lib/buildJobs.hash.ts and
// lib/supabase/adminConfig.ts during Feature 15.5/15.5-hardening).
import { createHash } from "node:crypto";
import type { BuildFailureCode } from "@/lib/buildJobs";
import type { GeneratedPosConfig } from "@/lib/generatedPosConfig";

// ============================================================================
// Artifact type — mirrors build_artifacts_type_check exactly.
// ============================================================================

export type BuildArtifactType =
  | "apk"
  | "desktop_installer"
  | "zip"
  | "json_config"
  | "log";

export const BUILD_ARTIFACT_TYPES: readonly BuildArtifactType[] = [
  "apk",
  "desktop_installer",
  "zip",
  "json_config",
  "log",
];

export function isSupportedBuildArtifactType(
  value: unknown
): value is BuildArtifactType {
  return (
    typeof value === "string" &&
    (BUILD_ARTIFACT_TYPES as readonly string[]).includes(value)
  );
}

// Feature 15.6 — the only artifact type this feature's worker ever
// produces. A named constant (not a bare string literal at each call
// site) so the one real producer and any future test/consumer can never
// drift on the exact spelling.
export const JSON_CONFIG_ARTIFACT_TYPE: BuildArtifactType = "json_config";

export const JSON_CONFIG_ARTIFACT_MIME_TYPE = "application/json";

// Feature 15.6 — the fixed, internal storage filename. Deliberately not
// derived from the project name (unlike original_filename, which is
// user-facing) — the storage path's filename segment is purely a path
// component, never seen by a user, so it stays constant across every job
// rather than depending on data that could contain unsafe characters.
export const GENERATED_POS_ARTIFACT_STORAGE_FILENAME =
  "generated-pos-config.json";

export const BUILD_ARTIFACTS_BUCKET = "build-artifacts";

// ============================================================================
// Artifact bytes — reuses the exact convention already established for
// the Builder's manual JSON export (EditorShell.tsx's handleExport):
// `${JSON.stringify(config, null, 2)}\n`, UTF-8. TextEncoder (not
// Buffer.from) is used specifically because it is a spec-guaranteed
// UTF-8 encoder available in both Node and any hypothetical future
// browser context, rather than relying on Node's own Buffer semantics.
// ============================================================================

// Feature 15.6 — pure: never mutates `config`, and JSON.stringify never
// mutates its input either. Deterministic by construction: the same
// config object (an already-immutable build_jobs.config_snapshot, never
// regenerated after job creation) always serializes to the exact same
// key order/spacing/content, so identical input always yields identical
// bytes — no special determinism engineering needed beyond reusing a
// fixed serialization convention.
export function createGeneratedPosArtifactBytes(
  config: GeneratedPosConfig
): Uint8Array {
  const jsonText = `${JSON.stringify(config, null, 2)}\n`;
  return new TextEncoder().encode(jsonText);
}

// ============================================================================
// Checksum — SHA-256 over the exact artifact bytes, lowercase hex.
// node:crypto only; no new hashing dependency.
// ============================================================================

const ARTIFACT_CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;

export function computeArtifactChecksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isValidArtifactChecksum(value: unknown): value is string {
  return typeof value === "string" && ARTIFACT_CHECKSUM_PATTERN.test(value);
}

// ============================================================================
// Storage path — {ownerId}/{projectId}/{buildJobId}/{filename}. Every
// segment is validated as a "safe" path segment before being joined:
// non-empty, no "/" or "\", not literally "..", no control characters.
// Rejects rather than sanitizes — an unsafe segment means something
// upstream is already wrong (a malformed id), so this returns null rather
// than silently stripping characters into a still-plausible-looking but
// wrong path.
// ============================================================================

const UNSAFE_PATH_SEGMENT_CONTROL_CHARS = /[\x00-\x1F\x7F]/;

export function isSafePathSegment(value: unknown): value is string {
  if (typeof value !== "string" || value === "") {
    return false;
  }

  if (value === "..") {
    return false;
  }

  if (value.includes("/") || value.includes("\\")) {
    return false;
  }

  if (UNSAFE_PATH_SEGMENT_CONTROL_CHARS.test(value)) {
    return false;
  }

  return true;
}

export function createBuildJobArtifactStoragePath(input: {
  ownerId: string;
  projectId: string;
  buildJobId: string;
  filename?: string;
}): string | null {
  const filename = input.filename ?? GENERATED_POS_ARTIFACT_STORAGE_FILENAME;
  const segments = [input.ownerId, input.projectId, input.buildJobId, filename];

  if (!segments.every((segment) => isSafePathSegment(segment))) {
    return null;
  }

  return segments.join("/");
}

// ============================================================================
// Finalize-input validation — a pure mirror of what
// finalize_build_job_with_artifact validates in SQL, independently
// testable without a database round-trip (same pattern as
// lib/buildJobs.worker.ts's hasConsistentClaimFields/ownsClaim).
// ============================================================================

export type ArtifactFinalizeInput = {
  artifactType: unknown;
  storagePath: unknown;
  originalFilename: unknown;
  mimeType: unknown;
  fileSizeBytes: unknown;
  checksum: unknown;
};

export type ArtifactFinalizeValidationResult =
  | { valid: true }
  | {
      valid: false;
      reason:
        | "invalid_artifact_type"
        | "invalid_storage_path"
        | "invalid_filename"
        | "invalid_mime_type"
        | "invalid_file_size"
        | "invalid_checksum";
    };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function validateArtifactFinalizeInput(
  input: ArtifactFinalizeInput
): ArtifactFinalizeValidationResult {
  if (!isSupportedBuildArtifactType(input.artifactType)) {
    return { valid: false, reason: "invalid_artifact_type" };
  }

  if (!isNonEmptyString(input.storagePath)) {
    return { valid: false, reason: "invalid_storage_path" };
  }

  if (!isNonEmptyString(input.originalFilename)) {
    return { valid: false, reason: "invalid_filename" };
  }

  if (!isNonEmptyString(input.mimeType)) {
    return { valid: false, reason: "invalid_mime_type" };
  }

  if (
    typeof input.fileSizeBytes !== "number" ||
    !Number.isFinite(input.fileSizeBytes) ||
    input.fileSizeBytes <= 0
  ) {
    return { valid: false, reason: "invalid_file_size" };
  }

  if (!isValidArtifactChecksum(input.checksum)) {
    return { valid: false, reason: "invalid_checksum" };
  }

  return { valid: true };
}

// ============================================================================
// Verification decision — after upload, the worker reads the object back
// and must confirm it actually matches what was generated. Pure: takes
// the two already-computed values on each side rather than performing
// any I/O itself.
// ============================================================================

export type ArtifactVerificationResult =
  | { verified: true }
  | { verified: false; reason: "length_mismatch" | "checksum_mismatch" };

export function decideArtifactVerification(input: {
  expectedByteLength: number;
  expectedChecksum: string;
  actualByteLength: number;
  actualChecksum: string;
}): ArtifactVerificationResult {
  if (input.expectedByteLength !== input.actualByteLength) {
    return { verified: false, reason: "length_mismatch" };
  }

  if (input.expectedChecksum !== input.actualChecksum) {
    return { verified: false, reason: "checksum_mismatch" };
  }

  return { verified: true };
}

// ============================================================================
// Cleanup decision — after a best-effort delete of an orphaned upload
// (attempted when verification or finalization fails), the worker needs
// to know whether cleanup itself succeeded purely for internal logging;
// it must never affect the user-facing failure message either way.
// ============================================================================

export type ArtifactCleanupOutcome = "cleaned_up" | "cleanup_failed";

export function decideCleanupOutcome(
  deleteError: { message: string } | null | undefined
): ArtifactCleanupOutcome {
  return deleteError ? "cleanup_failed" : "cleaned_up";
}

// ============================================================================
// Finalize-RPC outcome — finalize_build_job_with_artifact returns
// `table (artifact_id uuid)`, so a successful call yields exactly one row
// and a rejected one (lost claim, or a rolled-back duplicate-constraint
// insert) yields zero rows. Deliberately mirrors decideRpcTransitionOutcome's
// three-way shape (applied / rpc_error / not_applied) rather than
// reusing it directly, since this RPC's return shape (a row set, not a
// boolean) is different — the 15.5 incident is exactly why this
// distinction is treated as a first-class, separately-testable decision
// rather than an inline `if` at the call site.
// ============================================================================

export type ArtifactFinalizeOutcome =
  | { finalized: true; artifactId: string }
  | { finalized: false; reason: "rpc_error"; message: string }
  | { finalized: false; reason: "not_applied" };

export function decideArtifactFinalizeOutcome(
  rows: Array<{ artifact_id: unknown }> | null | undefined,
  error: { message: string } | null | undefined
): ArtifactFinalizeOutcome {
  if (error) {
    return { finalized: false, reason: "rpc_error", message: error.message };
  }

  const row = Array.isArray(rows) ? rows[0] : undefined;

  if (row && isNonEmptyString(row.artifact_id)) {
    return { finalized: true, artifactId: row.artifact_id };
  }

  return { finalized: false, reason: "not_applied" };
}

// ============================================================================
// Failure-reason -> {failureCode, failureMessage} mapping — the single
// place every sanitized, user-facing message for this pipeline is
// defined, per the approved Feature 15.6 plan. Every message here is
// fixed and generic; raw Storage/Postgres errors are never substituted
// in (they belong in the worker's local console log only).
// ============================================================================

export type ArtifactFailureReason =
  | "invalid_config"
  | "generation_failed"
  | "upload_failed"
  | "verification_failed"
  | "finalize_failed";

export type ArtifactFailureOutcome = {
  failureCode: BuildFailureCode;
  failureMessage: string;
};

const ARTIFACT_FAILURE_OUTCOMES: Record<
  ArtifactFailureReason,
  ArtifactFailureOutcome
> = {
  invalid_config: {
    failureCode: "invalid_config",
    failureMessage: "The saved build configuration is invalid.",
  },
  generation_failed: {
    failureCode: "generation_failed",
    failureMessage: "The build artifact could not be generated.",
  },
  upload_failed: {
    failureCode: "artifact_upload_failed",
    failureMessage: "The build artifact could not be uploaded.",
  },
  verification_failed: {
    failureCode: "artifact_verification_failed",
    failureMessage: "The uploaded build artifact could not be verified.",
  },
  // Feature 15.6 — approved decision: a good, verified upload whose
  // finalize call didn't apply reuses artifact_upload_failed rather than
  // a dedicated "artifact_record_failed" code (rejected as too
  // implementation-specific for this MVP).
  finalize_failed: {
    failureCode: "artifact_upload_failed",
    failureMessage:
      "The artifact was created, but the build record could not be finalized.",
  },
};

export function mapArtifactFailureReason(
  reason: ArtifactFailureReason
): ArtifactFailureOutcome {
  return ARTIFACT_FAILURE_OUTCOMES[reason];
}
