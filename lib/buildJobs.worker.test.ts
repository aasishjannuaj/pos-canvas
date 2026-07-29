import { describe, expect, it } from "vitest";
import {
  MAX_BUILD_JOB_ATTEMPTS,
  MAX_LEASE_SECONDS,
  MIN_LEASE_SECONDS,
  canReclaimStaleJob,
  decidePlaceholderBuildOutcome,
  decideRpcTransitionOutcome,
  decideSecondReadOutcome,
  generateWorkerId,
  hasConsistentClaimFields,
  isExhaustedStaleJob,
  isLeaseExpired,
  isValidLeaseSeconds,
  isValidWorkerId,
  ownsClaim,
  parseBuildTargetArg,
  validateBuildJobSnapshot,
} from "@/lib/buildJobs.worker";
import { computeGeneratedPosConfigHash } from "@/lib/buildJobs.hash";
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

describe("isValidLeaseSeconds", () => {
  it("accepts values within the approved bounds", () => {
    expect(isValidLeaseSeconds(MIN_LEASE_SECONDS)).toBe(true);
    expect(isValidLeaseSeconds(MAX_LEASE_SECONDS)).toBe(true);
    expect(isValidLeaseSeconds(300)).toBe(true);
  });

  it("rejects values outside the approved bounds", () => {
    expect(isValidLeaseSeconds(MIN_LEASE_SECONDS - 1)).toBe(false);
    expect(isValidLeaseSeconds(MAX_LEASE_SECONDS + 1)).toBe(false);
    expect(isValidLeaseSeconds(0)).toBe(false);
    expect(isValidLeaseSeconds(-300)).toBe(false);
  });

  it("rejects non-integer and non-number values", () => {
    expect(isValidLeaseSeconds(300.5)).toBe(false);
    expect(isValidLeaseSeconds("300")).toBe(false);
    expect(isValidLeaseSeconds(null)).toBe(false);
    expect(isValidLeaseSeconds(undefined)).toBe(false);
  });
});

describe("isValidWorkerId", () => {
  it("accepts a non-empty string", () => {
    expect(isValidWorkerId("11111111-1111-1111-1111-111111111111")).toBe(true);
  });

  it("rejects empty/whitespace-only or non-string values", () => {
    expect(isValidWorkerId("")).toBe(false);
    expect(isValidWorkerId("   ")).toBe(false);
    expect(isValidWorkerId(123)).toBe(false);
    expect(isValidWorkerId(null)).toBe(false);
  });
});

describe("generateWorkerId", () => {
  it("returns a v4-shaped UUID", () => {
    const id = generateWorkerId();

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("returns a different value on each call", () => {
    expect(generateWorkerId()).not.toBe(generateWorkerId());
  });
});

describe("parseBuildTargetArg", () => {
  it("accepts supported targets", () => {
    expect(parseBuildTargetArg("android")).toBe("android");
    expect(parseBuildTargetArg("desktop")).toBe("desktop");
  });

  it("rejects unsupported or malformed targets", () => {
    expect(parseBuildTargetArg("web")).toBeNull();
    expect(parseBuildTargetArg("")).toBeNull();
    expect(parseBuildTargetArg(undefined)).toBeNull();
  });
});

describe("isLeaseExpired", () => {
  const now = new Date("2026-01-01T00:10:00.000Z");

  it("returns true when the lease already elapsed", () => {
    expect(isLeaseExpired("2026-01-01T00:00:00.000Z", now)).toBe(true);
  });

  it("returns false when the lease is still active", () => {
    expect(isLeaseExpired("2026-01-01T00:20:00.000Z", now)).toBe(false);
  });
});

describe("canReclaimStaleJob / isExhaustedStaleJob", () => {
  const now = new Date("2026-01-01T00:10:00.000Z");
  const expiredLease = "2026-01-01T00:00:00.000Z";
  const activeLease = "2026-01-01T00:20:00.000Z";

  it("allows reclaim while attempt_count is below the cap", () => {
    expect(canReclaimStaleJob(1)).toBe(true);
    expect(canReclaimStaleJob(2)).toBe(true);
    expect(canReclaimStaleJob(MAX_BUILD_JOB_ATTEMPTS - 1)).toBe(true);
  });

  it("disallows reclaim once the attempt cap is reached", () => {
    expect(canReclaimStaleJob(MAX_BUILD_JOB_ATTEMPTS)).toBe(false);
    expect(canReclaimStaleJob(MAX_BUILD_JOB_ATTEMPTS + 1)).toBe(false);
  });

  it("is exhausted only when stale AND at/above the attempt cap", () => {
    expect(isExhaustedStaleJob(MAX_BUILD_JOB_ATTEMPTS, expiredLease, now)).toBe(true);
    expect(isExhaustedStaleJob(MAX_BUILD_JOB_ATTEMPTS, activeLease, now)).toBe(false);
    expect(isExhaustedStaleJob(1, expiredLease, now)).toBe(false);
  });
});

describe("ownsClaim", () => {
  it("returns true only when the claim token matches exactly", () => {
    expect(ownsClaim({ claimToken: "token-a" }, "token-a")).toBe(true);
  });

  it("returns false on any mismatch, null job token, or empty caller token", () => {
    expect(ownsClaim({ claimToken: "token-a" }, "token-b")).toBe(false);
    expect(ownsClaim({ claimToken: null }, "token-a")).toBe(false);
    expect(ownsClaim({ claimToken: "token-a" }, "")).toBe(false);
  });
});

describe("validateBuildJobSnapshot", () => {
  it("passes for a well-formed, matching snapshot", () => {
    const config = makeConfig();
    const result = validateBuildJobSnapshot({
      snapshot: config,
      configSchemaVersion: config.schemaVersion,
      configHash: computeGeneratedPosConfigHash(config),
    });

    expect(result.valid).toBe(true);
  });

  it("fails with invalid_shape for a structurally invalid snapshot", () => {
    const result = validateBuildJobSnapshot({
      snapshot: { not: "a config" },
      configSchemaVersion: 1,
      configHash: "irrelevant",
    });

    expect(result).toEqual({ valid: false, reason: "invalid_shape" });
  });

  it("fails with schema_version_mismatch when the row's recorded version disagrees", () => {
    const config = makeConfig();
    const result = validateBuildJobSnapshot({
      snapshot: config,
      configSchemaVersion: config.schemaVersion + 1,
      configHash: computeGeneratedPosConfigHash(config),
    });

    expect(result).toEqual({ valid: false, reason: "schema_version_mismatch" });
  });

  it("fails with hash_mismatch when the recomputed hash disagrees", () => {
    const config = makeConfig();
    const result = validateBuildJobSnapshot({
      snapshot: config,
      configSchemaVersion: config.schemaVersion,
      configHash: "0".repeat(64),
    });

    expect(result).toEqual({ valid: false, reason: "hash_mismatch" });
  });
});

describe("decidePlaceholderBuildOutcome", () => {
  it("maps a failed validation to invalid_config with a sanitized public message", () => {
    const outcome = decidePlaceholderBuildOutcome({ valid: false, reason: "hash_mismatch" });

    expect(outcome).toEqual({
      failureCode: "invalid_config",
      failureMessage: "The saved build configuration is invalid.",
    });
  });

  it("maps a passing validation to the deliberate generation_failed placeholder", () => {
    const config = makeConfig();
    const outcome = decidePlaceholderBuildOutcome({ valid: true, config });

    expect(outcome).toEqual({
      failureCode: "generation_failed",
      failureMessage: "Build generation is not implemented yet.",
    });
  });

  it("never returns a failure code implying success", () => {
    const outcome = decidePlaceholderBuildOutcome({ valid: true, config: makeConfig() });

    expect(outcome.failureCode).not.toBe("succeeded");
  });
});

describe("hasConsistentClaimFields", () => {
  const completeClaim = {
    status: "building" as const,
    claimedBy: "worker-1",
    claimToken: "token-1",
    heartbeatAt: "2026-01-01T00:00:00.000Z",
    leaseExpiresAt: "2026-01-01T00:05:00.000Z",
    attemptCount: 1,
  };

  it("requires a 'building' row to carry complete claim metadata", () => {
    expect(hasConsistentClaimFields(completeClaim)).toBe(true);
  });

  it("rejects a 'building' row missing any single claim field", () => {
    expect(hasConsistentClaimFields({ ...completeClaim, claimedBy: null })).toBe(false);
    expect(hasConsistentClaimFields({ ...completeClaim, claimedBy: "   " })).toBe(false);
    expect(hasConsistentClaimFields({ ...completeClaim, claimToken: null })).toBe(false);
    expect(hasConsistentClaimFields({ ...completeClaim, heartbeatAt: null })).toBe(false);
    expect(hasConsistentClaimFields({ ...completeClaim, leaseExpiresAt: null })).toBe(false);
    expect(hasConsistentClaimFields({ ...completeClaim, attemptCount: 0 })).toBe(false);
  });

  it("requires queued/succeeded/failed rows to carry no claim fields", () => {
    const empty = {
      claimedBy: null,
      claimToken: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      attemptCount: 0,
    };

    expect(hasConsistentClaimFields({ status: "queued", ...empty })).toBe(true);
    expect(hasConsistentClaimFields({ status: "succeeded", ...empty })).toBe(true);
    expect(hasConsistentClaimFields({ status: "failed", ...empty })).toBe(true);
  });

  it("rejects a non-'building' row that still carries any claim field", () => {
    const empty = {
      claimedBy: null,
      claimToken: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      attemptCount: 0,
    };

    expect(hasConsistentClaimFields({ status: "failed", ...empty, claimToken: "leftover" })).toBe(
      false
    );
    expect(hasConsistentClaimFields({ status: "queued", ...empty, claimedBy: "worker-1" })).toBe(
      false
    );
  });
});

describe("decideSecondReadOutcome", () => {
  it("returns 'owned' when the scoped read returns a row", () => {
    expect(decideSecondReadOutcome({ config_snapshot: {} })).toBe("owned");
  });

  it("returns 'claim_lost' when the scoped read returns no row", () => {
    expect(decideSecondReadOutcome(null)).toBe("claim_lost");
    expect(decideSecondReadOutcome(undefined)).toBe("claim_lost");
  });
});

// Feature 15.5 correction — regression coverage for the incident where a
// genuine RPC error (the fail_build_job GET-DIAGNOSTICS-into-boolean bug)
// was reported with the exact same message as an ordinary "0 rows
// matched" outcome. These two cases must always stay distinguishable.
describe("decideRpcTransitionOutcome", () => {
  it("reports applied when the RPC returns true with no error", () => {
    expect(decideRpcTransitionOutcome(true, null)).toEqual({ applied: true });
  });

  it("reports a distinct rpc_error outcome, preserving the error message, when the RPC errors — even if data happens to be truthy", () => {
    const outcome = decideRpcTransitionOutcome(true, {
      message: "cannot cast type integer to boolean",
    });

    expect(outcome).toEqual({
      applied: false,
      reason: "rpc_error",
      message: "cannot cast type integer to boolean",
    });
  });

  it("reports not_applied (never rpc_error) when the RPC returns false with no error", () => {
    expect(decideRpcTransitionOutcome(false, null)).toEqual({
      applied: false,
      reason: "not_applied",
    });
  });

  it("reports not_applied when the RPC returns null/undefined with no error", () => {
    expect(decideRpcTransitionOutcome(null, null)).toEqual({
      applied: false,
      reason: "not_applied",
    });
    expect(decideRpcTransitionOutcome(undefined, undefined)).toEqual({
      applied: false,
      reason: "not_applied",
    });
  });

  it("never conflates an rpc_error with not_applied", () => {
    const errorOutcome = decideRpcTransitionOutcome(null, { message: "boom" });
    const falseOutcome = decideRpcTransitionOutcome(false, null);

    expect(errorOutcome).not.toEqual(falseOutcome);
    expect(errorOutcome.applied).toBe(false);
    expect(falseOutcome.applied).toBe(false);
    if (!errorOutcome.applied && !falseOutcome.applied) {
      expect(errorOutcome.reason).toBe("rpc_error");
      expect(falseOutcome.reason).toBe("not_applied");
    }
  });
});
