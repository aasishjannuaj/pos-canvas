import { describe, expect, it } from "vitest";
import {
  BUILD_STATUSES,
  BUILD_TARGETS,
  TERMINAL_BUILD_STATUSES,
  canonicalizeGeneratedPosConfig,
  isBuildStatus,
  isSupportedBuildTarget,
  isTerminalBuildStatus,
  isValidBuildStatusTransition,
  sanitizeBuildFailureMessage,
} from "@/lib/buildJobs";
import type { BuildStatus } from "@/lib/buildJobs";
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
