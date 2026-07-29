import { describe, expect, it } from "vitest";
import {
  BUILD_ARTIFACT_TYPES,
  BUILD_ARTIFACTS_BUCKET,
  GENERATED_POS_ARTIFACT_STORAGE_FILENAME,
  JSON_CONFIG_ARTIFACT_MIME_TYPE,
  JSON_CONFIG_ARTIFACT_TYPE,
  computeArtifactChecksum,
  createBuildJobArtifactStoragePath,
  createGeneratedPosArtifactBytes,
  decideArtifactFinalizeOutcome,
  decideArtifactVerification,
  decideCleanupOutcome,
  isSafePathSegment,
  isSupportedBuildArtifactType,
  isValidArtifactChecksum,
  mapArtifactFailureReason,
  validateArtifactFinalizeInput,
} from "@/lib/buildJobs.artifact";
import { createGeneratedPosConfig } from "@/lib/generatedPosConfig";
import { defaultProjectConfig } from "@/lib/projectConfig";

const BASE_INPUT = {
  projectId: "project-123",
  projectName: "Test Project",
  templateId: "restaurant",
};

function makeConfig(overrides: Parameters<typeof createGeneratedPosConfig>[1] = {}) {
  return createGeneratedPosConfig({ ...BASE_INPUT, config: defaultProjectConfig }, overrides);
}

describe("isSupportedBuildArtifactType", () => {
  it("accepts every approved artifact type", () => {
    for (const type of BUILD_ARTIFACT_TYPES) {
      expect(isSupportedBuildArtifactType(type)).toBe(true);
    }
  });

  it("rejects unsupported or malformed values", () => {
    expect(isSupportedBuildArtifactType("exe")).toBe(false);
    expect(isSupportedBuildArtifactType("")).toBe(false);
    expect(isSupportedBuildArtifactType(null)).toBe(false);
    expect(isSupportedBuildArtifactType(undefined)).toBe(false);
  });

  it("json_config, the one type this feature's worker produces, is approved", () => {
    expect(JSON_CONFIG_ARTIFACT_TYPE).toBe("json_config");
    expect(isSupportedBuildArtifactType(JSON_CONFIG_ARTIFACT_TYPE)).toBe(true);
  });
});

describe("createGeneratedPosArtifactBytes", () => {
  it("reuses the established export convention: JSON.stringify(config, null, 2) + newline", () => {
    const config = makeConfig();
    const bytes = createGeneratedPosArtifactBytes(config);
    const text = new TextDecoder().decode(bytes);

    expect(text).toBe(`${JSON.stringify(config, null, 2)}\n`);
  });

  it("ends with exactly one trailing newline", () => {
    const bytes = createGeneratedPosArtifactBytes(makeConfig());
    const text = new TextDecoder().decode(bytes);

    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });

  it("produces valid UTF-8 bytes that round-trip to the exact original text", () => {
    const config = makeConfig();
    const bytes = createGeneratedPosArtifactBytes(config);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);

    expect(decoded).toContain(config.project.projectId);
  });

  it("produces identical bytes for an identical config, every call", () => {
    const config = makeConfig();
    const first = createGeneratedPosArtifactBytes(config);
    const second = createGeneratedPosArtifactBytes(config);

    expect(Array.from(first)).toEqual(Array.from(second));
  });

  it("produces different bytes when a real config field changes", () => {
    const config = makeConfig();
    const changed = { ...config, tax: { ...config.tax, rate: config.tax.rate + 1 } };

    const bytesA = createGeneratedPosArtifactBytes(config);
    const bytesB = createGeneratedPosArtifactBytes(changed);

    expect(Array.from(bytesA)).not.toEqual(Array.from(bytesB));
  });

  it("does not mutate the input config", () => {
    const config = makeConfig();
    const before = JSON.parse(JSON.stringify(config));

    createGeneratedPosArtifactBytes(config);

    expect(config).toEqual(before);
  });
});

describe("computeArtifactChecksum / isValidArtifactChecksum", () => {
  it("returns a lowercase 64-character hex digest", () => {
    const bytes = createGeneratedPosArtifactBytes(makeConfig());
    const checksum = computeArtifactChecksum(bytes);

    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(isValidArtifactChecksum(checksum)).toBe(true);
  });

  it("matches a known fixture hash for fixed input bytes", () => {
    const bytes = new TextEncoder().encode("hello world\n");
    const checksum = computeArtifactChecksum(bytes);

    // sha256("hello world\n") — independently verified via `node -e
    // "console.log(require('crypto').createHash('sha256').update('hello world\\n').digest('hex'))"`.
    expect(checksum).toBe(
      "a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447"
    );
  });

  it("produces a different checksum when a single byte differs", () => {
    const bytesA = createGeneratedPosArtifactBytes(makeConfig());
    const changed = { ...makeConfig(), tax: { ...makeConfig().tax, rate: makeConfig().tax.rate + 1 } };
    const bytesB = createGeneratedPosArtifactBytes(changed);

    expect(computeArtifactChecksum(bytesA)).not.toBe(computeArtifactChecksum(bytesB));
  });

  it("rejects uppercase hex, wrong length, or non-string values", () => {
    expect(isValidArtifactChecksum("A".repeat(64))).toBe(false);
    expect(isValidArtifactChecksum("0".repeat(63))).toBe(false);
    expect(isValidArtifactChecksum("0".repeat(65))).toBe(false);
    expect(isValidArtifactChecksum(null)).toBe(false);
    expect(isValidArtifactChecksum(12345)).toBe(false);
  });
});

describe("isSafePathSegment", () => {
  it("accepts ordinary uuid/string segments", () => {
    expect(isSafePathSegment("11111111-1111-1111-1111-111111111111")).toBe(true);
    expect(isSafePathSegment(GENERATED_POS_ARTIFACT_STORAGE_FILENAME)).toBe(true);
  });

  it("rejects an empty segment", () => {
    expect(isSafePathSegment("")).toBe(false);
  });

  it("rejects a segment containing a forward slash", () => {
    expect(isSafePathSegment("a/b")).toBe(false);
  });

  it("rejects a segment containing a backslash", () => {
    expect(isSafePathSegment("a\\b")).toBe(false);
  });

  it("rejects a literal '..' segment", () => {
    expect(isSafePathSegment("..")).toBe(false);
  });

  it("rejects a segment containing control characters", () => {
    const withNewline = "abc" + String.fromCharCode(10) + "def";
    const withNullByte = "abc" + String.fromCharCode(0) + "def";
    const withDel = "abc" + String.fromCharCode(127) + "def";

    expect(isSafePathSegment(withNewline)).toBe(false);
    expect(isSafePathSegment(withNullByte)).toBe(false);
    expect(isSafePathSegment(withDel)).toBe(false);
  });

  it("allows an ordinary space and plain alphanumeric text", () => {
    const withSpace = "abc" + String.fromCharCode(32) + "def";

    expect(isSafePathSegment(withSpace)).toBe(true);
    expect(isSafePathSegment("plainsegment")).toBe(true);
  });

  it("rejects non-string values", () => {
    expect(isSafePathSegment(null)).toBe(false);
    expect(isSafePathSegment(123)).toBe(false);
  });
});

describe("createBuildJobArtifactStoragePath", () => {
  const validInput = {
    ownerId: "owner-1",
    projectId: "project-1",
    buildJobId: "job-1",
  };

  it("builds the expected {ownerId}/{projectId}/{buildJobId}/{filename} path", () => {
    expect(createBuildJobArtifactStoragePath(validInput)).toBe(
      `owner-1/project-1/job-1/${GENERATED_POS_ARTIFACT_STORAGE_FILENAME}`
    );
  });

  it("defaults the filename to the fixed internal storage filename", () => {
    const path = createBuildJobArtifactStoragePath(validInput);

    expect(path?.endsWith(`/${GENERATED_POS_ARTIFACT_STORAGE_FILENAME}`)).toBe(true);
  });

  it("returns null when any identifier is an unsafe segment", () => {
    expect(createBuildJobArtifactStoragePath({ ...validInput, ownerId: "" })).toBeNull();
    expect(createBuildJobArtifactStoragePath({ ...validInput, projectId: "../etc" })).toBeNull();
    expect(createBuildJobArtifactStoragePath({ ...validInput, buildJobId: "a/b" })).toBeNull();
    expect(
      createBuildJobArtifactStoragePath({ ...validInput, filename: "a\\b" })
    ).toBeNull();
  });
});

describe("validateArtifactFinalizeInput", () => {
  const validInput = {
    artifactType: "json_config",
    storagePath: "owner-1/project-1/job-1/generated-pos-config.json",
    originalFilename: "pos-canvas-test-v1.json",
    mimeType: "application/json",
    fileSizeBytes: 1024,
    checksum: "0".repeat(64),
  };

  it("accepts fully valid input", () => {
    expect(validateArtifactFinalizeInput(validInput)).toEqual({ valid: true });
  });

  it("rejects an unsupported artifact type", () => {
    expect(validateArtifactFinalizeInput({ ...validInput, artifactType: "exe" })).toEqual({
      valid: false,
      reason: "invalid_artifact_type",
    });
  });

  it("rejects an empty/blank storage path", () => {
    expect(validateArtifactFinalizeInput({ ...validInput, storagePath: "   " })).toEqual({
      valid: false,
      reason: "invalid_storage_path",
    });
  });

  it("rejects an empty original filename", () => {
    expect(validateArtifactFinalizeInput({ ...validInput, originalFilename: "" })).toEqual({
      valid: false,
      reason: "invalid_filename",
    });
  });

  it("rejects an empty mime type", () => {
    expect(validateArtifactFinalizeInput({ ...validInput, mimeType: "" })).toEqual({
      valid: false,
      reason: "invalid_mime_type",
    });
  });

  it("rejects a zero, negative, or non-numeric file size", () => {
    expect(validateArtifactFinalizeInput({ ...validInput, fileSizeBytes: 0 })).toEqual({
      valid: false,
      reason: "invalid_file_size",
    });
    expect(validateArtifactFinalizeInput({ ...validInput, fileSizeBytes: -5 })).toEqual({
      valid: false,
      reason: "invalid_file_size",
    });
    expect(validateArtifactFinalizeInput({ ...validInput, fileSizeBytes: "1024" })).toEqual({
      valid: false,
      reason: "invalid_file_size",
    });
  });

  it("rejects a malformed checksum", () => {
    expect(validateArtifactFinalizeInput({ ...validInput, checksum: "not-a-hash" })).toEqual({
      valid: false,
      reason: "invalid_checksum",
    });
  });
});

describe("decideArtifactVerification", () => {
  const base = {
    expectedByteLength: 100,
    expectedChecksum: "abc123",
    actualByteLength: 100,
    actualChecksum: "abc123",
  };

  it("verifies when both length and checksum match", () => {
    expect(decideArtifactVerification(base)).toEqual({ verified: true });
  });

  it("fails with length_mismatch when byte lengths differ", () => {
    expect(decideArtifactVerification({ ...base, actualByteLength: 99 })).toEqual({
      verified: false,
      reason: "length_mismatch",
    });
  });

  it("fails with checksum_mismatch when checksums differ but length matches", () => {
    expect(decideArtifactVerification({ ...base, actualChecksum: "def456" })).toEqual({
      verified: false,
      reason: "checksum_mismatch",
    });
  });
});

describe("decideCleanupOutcome", () => {
  it("reports cleaned_up when no delete error occurred", () => {
    expect(decideCleanupOutcome(null)).toBe("cleaned_up");
    expect(decideCleanupOutcome(undefined)).toBe("cleaned_up");
  });

  it("reports cleanup_failed when a delete error occurred", () => {
    expect(decideCleanupOutcome({ message: "network error" })).toBe("cleanup_failed");
  });
});

describe("decideArtifactFinalizeOutcome", () => {
  it("reports finalized with the artifact id when a row is returned", () => {
    expect(
      decideArtifactFinalizeOutcome([{ artifact_id: "artifact-1" }], null)
    ).toEqual({ finalized: true, artifactId: "artifact-1" });
  });

  it("reports a distinct rpc_error outcome, preserving the message", () => {
    expect(
      decideArtifactFinalizeOutcome(null, { message: "duplicate key value" })
    ).toEqual({ finalized: false, reason: "rpc_error", message: "duplicate key value" });
  });

  it("reports not_applied when zero rows are returned with no error", () => {
    expect(decideArtifactFinalizeOutcome([], null)).toEqual({
      finalized: false,
      reason: "not_applied",
    });
    expect(decideArtifactFinalizeOutcome(null, null)).toEqual({
      finalized: false,
      reason: "not_applied",
    });
  });

  it("reports not_applied (never crashes) on malformed row data", () => {
    expect(
      decideArtifactFinalizeOutcome([{ artifact_id: 12345 }], null)
    ).toEqual({ finalized: false, reason: "not_applied" });
    expect(decideArtifactFinalizeOutcome([{ artifact_id: "" }], null)).toEqual({
      finalized: false,
      reason: "not_applied",
    });
  });

  it("never conflates rpc_error with not_applied", () => {
    const errorOutcome = decideArtifactFinalizeOutcome(null, { message: "boom" });
    const notAppliedOutcome = decideArtifactFinalizeOutcome([], null);

    expect(errorOutcome).not.toEqual(notAppliedOutcome);
  });
});

describe("mapArtifactFailureReason", () => {
  it("maps invalid_config", () => {
    expect(mapArtifactFailureReason("invalid_config")).toEqual({
      failureCode: "invalid_config",
      failureMessage: "The saved build configuration is invalid.",
    });
  });

  it("maps generation_failed", () => {
    expect(mapArtifactFailureReason("generation_failed").failureCode).toBe(
      "generation_failed"
    );
  });

  it("maps upload_failed to artifact_upload_failed with the approved message", () => {
    expect(mapArtifactFailureReason("upload_failed")).toEqual({
      failureCode: "artifact_upload_failed",
      failureMessage: "The build artifact could not be uploaded.",
    });
  });

  it("maps verification_failed to artifact_verification_failed with the approved message", () => {
    expect(mapArtifactFailureReason("verification_failed")).toEqual({
      failureCode: "artifact_verification_failed",
      failureMessage: "The uploaded build artifact could not be verified.",
    });
  });

  it("maps finalize_failed to artifact_upload_failed (not a dedicated code) with the approved message", () => {
    expect(mapArtifactFailureReason("finalize_failed")).toEqual({
      failureCode: "artifact_upload_failed",
      failureMessage:
        "The artifact was created, but the build record could not be finalized.",
    });
  });
});

describe("module-level constants", () => {
  it("exposes the approved bucket name and mime type", () => {
    expect(BUILD_ARTIFACTS_BUCKET).toBe("build-artifacts");
    expect(JSON_CONFIG_ARTIFACT_MIME_TYPE).toBe("application/json");
  });
});
