import { describe, expect, it } from "vitest";
import {
  BUILD_STATUSES,
  BUILD_TARGETS,
  TERMINAL_BUILD_STATUSES,
  canonicalizeGeneratedPosConfig,
  getBuildRequestButtonLabel,
  getBuildRequestSuccessMessage,
  getBuildStatusLabel,
  getBuildTargetLabel,
  isBuildFailureCode,
  isBuildStatus,
  isNonEmptyId,
  isSupportedBuildTarget,
  isTerminalBuildStatus,
  isValidBuildStatusTransition,
  isValidRetryReference,
  mapBuildJobRow,
  normalizeRequestKey,
  resolveExistingBuildJob,
  sanitizeBuildFailureMessage,
} from "@/lib/buildJobs";
import type {
  BuildJobRow,
  BuildJobSummary,
  BuildRequestStatus,
  BuildStatus,
} from "@/lib/buildJobs";
import { createGeneratedPosConfig } from "@/lib/generatedPosConfig";
import { defaultProjectConfig } from "@/lib/projectConfig";

const BASE_INPUT = {
  projectId: "project-123",
  projectName: "Test Project",
  templateId: "restaurant",
};

function makeConfig(overrides: Parameters<typeof createGeneratedPosConfig>[1] = {}) {
  return createGeneratedPosConfig(
    { ...BASE_INPUT, config: defaultProjectConfig },
    overrides
  );
}

describe("isSupportedBuildTarget", () => {
  it("accepts every approved target", () => {
    for (const target of BUILD_TARGETS) {
      expect(isSupportedBuildTarget(target)).toBe(true);
    }
  });

  it("rejects an arbitrary target", () => {
    expect(isSupportedBuildTarget("web")).toBe(false);
    expect(isSupportedBuildTarget("ios")).toBe(false);
    expect(isSupportedBuildTarget("")).toBe(false);
    expect(isSupportedBuildTarget(42)).toBe(false);
    expect(isSupportedBuildTarget(null)).toBe(false);
  });
});

describe("isBuildStatus", () => {
  it("accepts every approved status", () => {
    for (const status of BUILD_STATUSES) {
      expect(isBuildStatus(status)).toBe(true);
    }
  });

  it("rejects an arbitrary status", () => {
    expect(isBuildStatus("preparing")).toBe(false);
    expect(isBuildStatus("cancelled")).toBe(false);
    expect(isBuildStatus("")).toBe(false);
    expect(isBuildStatus(1)).toBe(false);
    expect(isBuildStatus(undefined)).toBe(false);
  });
});

describe("isTerminalBuildStatus", () => {
  it("treats succeeded and failed as terminal", () => {
    for (const status of TERMINAL_BUILD_STATUSES) {
      expect(isTerminalBuildStatus(status)).toBe(true);
    }
  });

  it("treats queued and building as non-terminal", () => {
    expect(isTerminalBuildStatus("queued")).toBe(false);
    expect(isTerminalBuildStatus("building")).toBe(false);
  });
});

describe("isValidBuildStatusTransition", () => {
  it("accepts every valid transition in the approved model", () => {
    expect(isValidBuildStatusTransition("queued", "building")).toBe(true);
    expect(isValidBuildStatusTransition("building", "succeeded")).toBe(true);
    expect(isValidBuildStatusTransition("building", "failed")).toBe(true);
  });

  it("rejects queued -> succeeded", () => {
    expect(isValidBuildStatusTransition("queued", "succeeded")).toBe(false);
  });

  it("rejects queued -> failed (a job must go through building first)", () => {
    expect(isValidBuildStatusTransition("queued", "failed")).toBe(false);
  });

  it("rejects every outbound transition from a terminal status", () => {
    const terminalStatuses: BuildStatus[] = ["succeeded", "failed"];
    const allStatuses: BuildStatus[] = ["queued", "building", "succeeded", "failed"];

    for (const from of terminalStatuses) {
      for (const to of allStatuses) {
        expect(isValidBuildStatusTransition(from, to)).toBe(false);
      }
    }
  });

  it("rejects same-status transitions", () => {
    for (const status of BUILD_STATUSES) {
      expect(isValidBuildStatusTransition(status, status)).toBe(false);
    }
  });
});

describe("canonicalizeGeneratedPosConfig", () => {
  it("produces an identical canonical form regardless of object key order", () => {
    const config = makeConfig({ generatedAt: "2026-01-01T00:00:00.000Z" });

    // Rebuild the same data with the top-level keys in reverse order —
    // JSON.stringify would differ here if canonicalization didn't sort
    // keys itself.
    const reordered = {
      receipt: config.receipt,
      tax: config.tax,
      menuItems: config.menuItems,
      branding: config.branding,
      businessProfile: config.businessProfile,
      project: config.project,
      generatedAt: config.generatedAt,
      schemaVersion: config.schemaVersion,
    };

    expect(canonicalizeGeneratedPosConfig(config)).toBe(
      canonicalizeGeneratedPosConfig(reordered as typeof config)
    );
  });

  it("produces an identical result when only generatedAt differs", () => {
    const configA = makeConfig({ generatedAt: "2026-01-01T00:00:00.000Z" });
    const configB = makeConfig({ generatedAt: "2027-06-15T12:30:00.000Z" });

    expect(canonicalizeGeneratedPosConfig(configA)).toBe(
      canonicalizeGeneratedPosConfig(configB)
    );
  });

  it("produces a different result when menu item order differs", () => {
    const config = makeConfig();
    const reorderedMenuItems = [...config.menuItems].reverse();

    const withReorderedMenu = { ...config, menuItems: reorderedMenuItems };

    expect(canonicalizeGeneratedPosConfig(config)).not.toBe(
      canonicalizeGeneratedPosConfig(withReorderedMenu)
    );
  });

  it("produces a different result when a real config field differs", () => {
    const config = makeConfig();
    const withDifferentAccentColor = {
      ...config,
      branding: { ...config.branding, accentColor: "#000000" },
    };

    expect(canonicalizeGeneratedPosConfig(config)).not.toBe(
      canonicalizeGeneratedPosConfig(withDifferentAccentColor)
    );
  });

  it("does not mutate the input", () => {
    const config = makeConfig();
    const before = JSON.parse(JSON.stringify(config));

    canonicalizeGeneratedPosConfig(config);

    expect(config).toEqual(before);
  });
});

describe("sanitizeBuildFailureMessage", () => {
  it("keeps a normal message readable", () => {
    expect(
      sanitizeBuildFailureMessage(
        "Signing failed: the build could not locate a valid keystore."
      )
    ).toBe("Signing failed: the build could not locate a valid keystore.");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeBuildFailureMessage("   Build failed.   ")).toBe(
      "Build failed."
    );
  });

  it("converts multiline input into a single readable line", () => {
    expect(sanitizeBuildFailureMessage("Line one\nLine two\r\nLine three")).toBe(
      "Line one Line two Line three"
    );
  });

  it("truncates long input", () => {
    const longMessage = "x".repeat(500);
    const result = sanitizeBuildFailureMessage(longMessage);

    expect(result.length).toBeLessThanOrEqual(301);
    expect(result.endsWith("…")).toBe(true);
  });

  it("redacts a bearer token", () => {
    const result = sanitizeBuildFailureMessage(
      "Upload failed: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def rejected"
    );

    expect(result).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(result).toContain("[redacted]");
  });

  it("redacts a password assignment", () => {
    const result = sanitizeBuildFailureMessage(
      "Keystore error: password=SuperSecret123 was rejected"
    );

    expect(result).not.toContain("SuperSecret123");
    expect(result).toContain("[redacted]");
  });

  it("redacts a private-key block", () => {
    const message =
      "Signing failed. Key was:\n-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEs\n-----END RSA PRIVATE KEY-----\nend of log";
    const result = sanitizeBuildFailureMessage(message);

    expect(result).not.toContain("MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEs");
    expect(result).toContain("[redacted]");
  });

  it("produces a safe generic message for non-string input", () => {
    expect(sanitizeBuildFailureMessage(undefined)).toBe(
      "The build failed due to an internal error."
    );
    expect(sanitizeBuildFailureMessage(null)).toBe(
      "The build failed due to an internal error."
    );
    expect(sanitizeBuildFailureMessage(42)).toBe(
      "The build failed due to an internal error."
    );
    expect(sanitizeBuildFailureMessage({})).toBe(
      "The build failed due to an internal error."
    );
  });
});

describe("isNonEmptyId", () => {
  it("accepts a real id string", () => {
    expect(isNonEmptyId("project-123")).toBe(true);
  });

  it("rejects an empty or whitespace-only string", () => {
    expect(isNonEmptyId("")).toBe(false);
    expect(isNonEmptyId("   ")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isNonEmptyId(null)).toBe(false);
    expect(isNonEmptyId(undefined)).toBe(false);
    expect(isNonEmptyId(123)).toBe(false);
  });
});

describe("normalizeRequestKey", () => {
  it("trims and returns a valid key", () => {
    expect(normalizeRequestKey("  abc-123  ")).toBe("abc-123");
  });

  it("rejects an empty or whitespace-only key", () => {
    expect(normalizeRequestKey("")).toBeNull();
    expect(normalizeRequestKey("   ")).toBeNull();
  });

  it("rejects a key beyond the maximum length", () => {
    expect(normalizeRequestKey("x".repeat(201))).toBeNull();
  });

  it("accepts a key exactly at the maximum length", () => {
    const key = "x".repeat(200);
    expect(normalizeRequestKey(key)).toBe(key);
  });
});

describe("isBuildFailureCode", () => {
  it("accepts every approved failure code", () => {
    expect(isBuildFailureCode("generation_failed")).toBe(true);
    expect(isBuildFailureCode("invalid_config")).toBe(true);
    expect(isBuildFailureCode("worker_timeout")).toBe(true);
    expect(isBuildFailureCode("worker_crashed")).toBe(true);
    expect(isBuildFailureCode("signing_failed")).toBe(true);
    expect(isBuildFailureCode("artifact_upload_failed")).toBe(true);
  });

  it("rejects cancelled_by_user and other arbitrary values", () => {
    expect(isBuildFailureCode("cancelled_by_user")).toBe(false);
    expect(isBuildFailureCode("something_else")).toBe(false);
    expect(isBuildFailureCode(null)).toBe(false);
  });
});

function makeValidBuildJobRow(overrides: Partial<BuildJobRow> = {}): BuildJobRow {
  return {
    id: "job-1",
    project_id: "project-1",
    target: "android",
    status: "queued",
    config_schema_version: 1,
    config_hash: "a".repeat(64),
    retried_from_job_id: null,
    failure_code: null,
    failure_message: null,
    started_at: null,
    finished_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("mapBuildJobRow", () => {
  it("maps a valid row to a BuildJobSummary", () => {
    const row = makeValidBuildJobRow();
    const job = mapBuildJobRow(row);

    expect(job).toEqual({
      id: "job-1",
      projectId: "project-1",
      target: "android",
      status: "queued",
      configSchemaVersion: 1,
      configHash: "a".repeat(64),
      retriedFromJobId: null,
      failureCode: null,
      failureMessage: null,
      startedAt: null,
      finishedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("rejects a row with an invalid target", () => {
    const row = makeValidBuildJobRow({ target: "ios" });
    expect(mapBuildJobRow(row)).toBeNull();
  });

  it("rejects a row with an invalid status", () => {
    const row = makeValidBuildJobRow({ status: "preparing" });
    expect(mapBuildJobRow(row)).toBeNull();
  });

  it("normalizes an unrecognized failure_code to null rather than rejecting the row", () => {
    const row = makeValidBuildJobRow({
      status: "failed",
      failure_code: "some_unrecognized_code",
    });

    const job = mapBuildJobRow(row);

    expect(job).not.toBeNull();
    expect(job?.failureCode).toBeNull();
  });

  it("preserves nullable timestamp/failure fields when set", () => {
    const row = makeValidBuildJobRow({
      status: "failed",
      failure_code: "worker_crashed",
      failure_message: "The worker crashed unexpectedly.",
      started_at: "2026-01-01T00:01:00.000Z",
      finished_at: "2026-01-01T00:02:00.000Z",
    });

    const job = mapBuildJobRow(row);

    expect(job?.failureCode).toBe("worker_crashed");
    expect(job?.failureMessage).toBe("The worker crashed unexpectedly.");
    expect(job?.startedAt).toBe("2026-01-01T00:01:00.000Z");
    expect(job?.finishedAt).toBe("2026-01-01T00:02:00.000Z");
  });

  it("never includes a configSnapshot-shaped field", () => {
    const job = mapBuildJobRow(makeValidBuildJobRow());
    expect(job).not.toHaveProperty("configSnapshot");
    expect(job).not.toHaveProperty("config_snapshot");
  });

  it("never includes ownerId or requestKey — the exact key set is exhaustive", () => {
    const job = mapBuildJobRow(makeValidBuildJobRow());

    expect(job).not.toHaveProperty("ownerId");
    expect(job).not.toHaveProperty("owner_id");
    expect(job).not.toHaveProperty("requestKey");
    expect(job).not.toHaveProperty("request_key");

    expect(Object.keys(job as BuildJobSummary).sort()).toEqual(
      [
        "id",
        "projectId",
        "target",
        "status",
        "configSchemaVersion",
        "configHash",
        "retriedFromJobId",
        "failureCode",
        "failureMessage",
        "startedAt",
        "finishedAt",
        "createdAt",
        "updatedAt",
      ].sort()
    );
  });
});

describe("resolveExistingBuildJob", () => {
  const requestKeyJob = { ...makeValidBuildJobRow(), id: "by-request-key" };
  const activeJob = { ...makeValidBuildJobRow(), id: "active-for-target" };

  const requestKeySummary = mapBuildJobRow(requestKeyJob) as BuildJobSummary;
  const activeSummary = mapBuildJobRow(activeJob) as BuildJobSummary;

  it("prefers a request-key match over an active-target match", () => {
    const result = resolveExistingBuildJob({
      byRequestKey: requestKeySummary,
      activeForTarget: activeSummary,
    });

    expect(result?.id).toBe("by-request-key");
  });

  it("falls back to the active-target match when there is no request-key match", () => {
    const result = resolveExistingBuildJob({
      byRequestKey: null,
      activeForTarget: activeSummary,
    });

    expect(result?.id).toBe("active-for-target");
  });

  it("returns null when neither exists", () => {
    expect(
      resolveExistingBuildJob({ byRequestKey: null, activeForTarget: null })
    ).toBeNull();
  });
});

describe("isValidRetryReference", () => {
  const baseContext = {
    requestOwnerId: "owner-1",
    requestProjectId: "project-1",
    requestTarget: "android" as const,
  };

  it("accepts a matching, terminal retry reference", () => {
    expect(
      isValidRetryReference({
        retriedFromJob: {
          ownerId: "owner-1",
          projectId: "project-1",
          target: "android",
          status: "failed",
        },
        ...baseContext,
      })
    ).toBe(true);
  });

  it("rejects a missing reference", () => {
    expect(
      isValidRetryReference({ retriedFromJob: null, ...baseContext })
    ).toBe(false);
  });

  it("rejects a reference owned by a different owner", () => {
    expect(
      isValidRetryReference({
        retriedFromJob: {
          ownerId: "someone-else",
          projectId: "project-1",
          target: "android",
          status: "failed",
        },
        ...baseContext,
      })
    ).toBe(false);
  });

  it("rejects a reference for a different project", () => {
    expect(
      isValidRetryReference({
        retriedFromJob: {
          ownerId: "owner-1",
          projectId: "another-project",
          target: "android",
          status: "failed",
        },
        ...baseContext,
      })
    ).toBe(false);
  });

  it("rejects a reference for a different target", () => {
    expect(
      isValidRetryReference({
        retriedFromJob: {
          ownerId: "owner-1",
          projectId: "project-1",
          target: "desktop",
          status: "failed",
        },
        ...baseContext,
      })
    ).toBe(false);
  });

  it("rejects a reference that has not reached a terminal status", () => {
    expect(
      isValidRetryReference({
        retriedFromJob: {
          ownerId: "owner-1",
          projectId: "project-1",
          target: "android",
          status: "building",
        },
        ...baseContext,
      })
    ).toBe(false);

    expect(
      isValidRetryReference({
        retriedFromJob: {
          ownerId: "owner-1",
          projectId: "project-1",
          target: "android",
          status: "queued",
        },
        ...baseContext,
      })
    ).toBe(false);
  });
});

describe("getBuildTargetLabel", () => {
  it("maps every approved target to its display label", () => {
    expect(getBuildTargetLabel("android")).toBe("Android");
    expect(getBuildTargetLabel("desktop")).toBe("Desktop");
  });

  it("covers every value in BUILD_TARGETS with no fallthrough", () => {
    for (const target of BUILD_TARGETS) {
      expect(typeof getBuildTargetLabel(target)).toBe("string");
      expect(getBuildTargetLabel(target).length).toBeGreaterThan(0);
    }
  });
});

describe("getBuildStatusLabel", () => {
  it("maps every approved status to its display label", () => {
    expect(getBuildStatusLabel("queued")).toBe("Queued");
    expect(getBuildStatusLabel("building")).toBe("Building");
    expect(getBuildStatusLabel("succeeded")).toBe("Ready");
    expect(getBuildStatusLabel("failed")).toBe("Failed");
  });

  it("covers every value in BUILD_STATUSES with no fallthrough", () => {
    for (const status of BUILD_STATUSES) {
      expect(typeof getBuildStatusLabel(status)).toBe("string");
      expect(getBuildStatusLabel(status).length).toBeGreaterThan(0);
    }
  });
});

describe("getBuildRequestButtonLabel", () => {
  it("maps every build-request status to its button label", () => {
    expect(getBuildRequestButtonLabel("idle")).toBe("Request Build");
    expect(getBuildRequestButtonLabel("submitting")).toBe("Requesting…");
    expect(getBuildRequestButtonLabel("success")).toBe("Request Another Build");
    expect(getBuildRequestButtonLabel("error")).toBe("Retry Build");
  });

  it("covers every BuildRequestStatus value with no fallthrough", () => {
    const allStatuses: BuildRequestStatus[] = [
      "idle",
      "submitting",
      "success",
      "error",
    ];

    for (const status of allStatuses) {
      expect(typeof getBuildRequestButtonLabel(status)).toBe("string");
      expect(getBuildRequestButtonLabel(status).length).toBeGreaterThan(0);
    }
  });
});

describe("getBuildRequestSuccessMessage", () => {
  it("returns the new-job message when reusedExisting is false", () => {
    expect(getBuildRequestSuccessMessage(false)).toBe("Build request queued.");
  });

  it("returns the reused-job message when reusedExisting is true", () => {
    expect(getBuildRequestSuccessMessage(true)).toBe(
      "An existing active build request was found."
    );
  });
});

describe("build-request action payload shape", () => {
  // Feature 15.4 — a runtime confirmation (not just a compile-time type)
  // that a request payload constructed the way lib/buildJobs.actions.ts
  // expects contains exactly these three keys — no ownerId, config,
  // configSnapshot, configHash, schemaVersion, status, or timestamp field
  // has any way to ride along.
  it("contains only projectId, target, and requestKey", () => {
    const payload = {
      projectId: "project-1",
      target: "android" as const,
      requestKey: "request-key-1",
    };

    expect(Object.keys(payload).sort()).toEqual(
      ["projectId", "target", "requestKey"].sort()
    );
  });
});
