// Feature 16.4B — pure owner-side logic tests. Node-only, matching this
// repository's Vitest setup (no DOM, no React Testing Library).
import { describe, expect, it } from "vitest";
import {
  PAIRING_CODE_TTL_LABEL,
  formatDeviceDate,
  formatDevicePlatform,
  formatPairingCountdown,
  getPairingCodeRemainingSeconds,
  isPairingCodeExpired,
  resolvePairingReadiness,
  selectLatestSucceededBuild,
} from "@/lib/devicePairing.owner";
import type { BuildJobSummary } from "@/lib/buildJobs";
import { mapPairedDeviceRow } from "@/lib/devices";

const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

function build(overrides: Partial<BuildJobSummary>): BuildJobSummary {
  return {
    id: "b0000000-0000-4000-8000-000000000001",
    projectId: PROJECT_ID,
    target: "android",
    status: "succeeded",
    configSchemaVersion: 1,
    configHash: "a".repeat(64),
    retriedFromJobId: null,
    failureCode: null,
    failureMessage: null,
    startedAt: null,
    finishedAt: null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

describe("selectLatestSucceededBuild", () => {
  it("returns null when there are no builds at all", () => {
    expect(selectLatestSucceededBuild([])).toBeNull();
  });

  it("returns null when no build has succeeded", () => {
    const jobs = [
      build({ id: "a", status: "queued" }),
      build({ id: "b", status: "failed" }),
      build({ id: "c", status: "building" }),
    ];

    expect(selectLatestSucceededBuild(jobs)).toBeNull();
  });

  it("ignores queued, building and failed builds", () => {
    const jobs = [
      build({ id: "queued", status: "queued", createdAt: "2026-08-09T00:00:00Z" }),
      build({ id: "failed", status: "failed", createdAt: "2026-08-08T00:00:00Z" }),
      build({ id: "ok", status: "succeeded", createdAt: "2026-08-01T00:00:00Z" }),
    ];

    expect(selectLatestSucceededBuild(jobs)?.id).toBe("ok");
  });

  it("picks the newest succeeded build by createdAt, not by array order", () => {
    // Deliberately shuffled: the pinned build sets the prices a till charges,
    // so "latest" must come from the data rather than from fetch order.
    const jobs = [
      build({ id: "old", createdAt: "2026-08-01T00:00:00Z" }),
      build({ id: "newest", createdAt: "2026-08-05T00:00:00Z" }),
      build({ id: "middle", createdAt: "2026-08-03T00:00:00Z" }),
    ];

    expect(selectLatestSucceededBuild(jobs)?.id).toBe("newest");
  });
});

describe("resolvePairingReadiness", () => {
  it("reports an unsaved project", () => {
    const readiness = resolvePairingReadiness({ projectId: null, jobs: [] });

    if (readiness.state !== "unsaved_project") {
      throw new Error(`expected unsaved_project, got ${readiness.state}`);
    }

    expect(readiness.message).toMatch(/save this project/i);
  });

  it("treats a blank project id as unsaved", () => {
    expect(
      resolvePairingReadiness({ projectId: "   ", jobs: [] }).state
    ).toBe("unsaved_project");
  });

  it("reports a saved project with no succeeded build", () => {
    const readiness = resolvePairingReadiness({
      projectId: PROJECT_ID,
      jobs: [build({ status: "failed" })],
    });

    if (readiness.state !== "no_succeeded_build") {
      throw new Error(`expected no_succeeded_build, got ${readiness.state}`);
    }

    expect(readiness.message).toMatch(/publish this configuration/i);
  });

  it("is ready when a succeeded build exists, and selects it automatically", () => {
    const readiness = resolvePairingReadiness({
      projectId: PROJECT_ID,
      jobs: [
        build({ id: "older", createdAt: "2026-08-01T00:00:00Z" }),
        build({ id: "newer", createdAt: "2026-08-04T00:00:00Z" }),
      ],
    });

    expect(readiness).toEqual({
      state: "ready",
      buildJobId: "newer",
      buildCreatedAt: "2026-08-04T00:00:00Z",
    });
  });

  it("checks the project before the build, so an unsaved project never reads as buildless", () => {
    expect(
      resolvePairingReadiness({ projectId: null, jobs: [build({})] }).state
    ).toBe("unsaved_project");
  });
});

describe("pairing code expiry", () => {
  const NOW = Date.parse("2026-08-10T12:00:00Z");

  it("counts whole seconds remaining", () => {
    expect(
      getPairingCodeRemainingSeconds("2026-08-10T12:10:00Z", NOW)
    ).toBe(600);
    expect(getPairingCodeRemainingSeconds("2026-08-10T12:00:30Z", NOW)).toBe(30);
  });

  it("floors at zero once past the expiry", () => {
    expect(getPairingCodeRemainingSeconds("2026-08-10T11:59:59Z", NOW)).toBe(0);
    expect(getPairingCodeRemainingSeconds("2026-08-10T11:00:00Z", NOW)).toBe(0);
  });

  it("treats an unparseable expiry as already expired", () => {
    // Fail closed: a code whose lifetime cannot be read must not appear live.
    expect(getPairingCodeRemainingSeconds("not-a-date", NOW)).toBe(0);
    expect(isPairingCodeExpired("not-a-date", NOW)).toBe(true);
  });

  it("reports expiry consistently with the remaining count", () => {
    expect(isPairingCodeExpired("2026-08-10T12:00:01Z", NOW)).toBe(false);
    expect(isPairingCodeExpired("2026-08-10T12:00:00Z", NOW)).toBe(true);
  });

  it("documents the fixed server-side lifetime", () => {
    expect(PAIRING_CODE_TTL_LABEL).toBe("10 minutes");
  });
});

describe("formatPairingCountdown", () => {
  it("renders M:SS", () => {
    expect(formatPairingCountdown(600)).toBe("10:00");
    expect(formatPairingCountdown(65)).toBe("1:05");
    expect(formatPairingCountdown(9)).toBe("0:09");
    expect(formatPairingCountdown(0)).toBe("0:00");
  });

  it("never renders a negative or non-finite countdown", () => {
    expect(formatPairingCountdown(-5)).toBe("0:00");
    expect(formatPairingCountdown(Number.NaN)).toBe("0:00");
    expect(formatPairingCountdown(Number.POSITIVE_INFINITY)).toBe("0:00");
  });
});

describe("device row presentation", () => {
  it("formats a paired/revoked date and tolerates null or malformed input", () => {
    expect(formatDeviceDate(null)).toBe("—");
    expect(formatDeviceDate("nonsense")).toBe("—");
    expect(formatDeviceDate("2026-08-01T00:00:00Z")).toMatch(/2026/);
  });

  it("labels the platforms 16.4A actually records", () => {
    expect(formatDevicePlatform("android")).toBe("Android");
    expect(formatDevicePlatform("windows")).toBe("Windows");
    expect(formatDevicePlatform("web")).toBe("Web");
    // Case-insensitive, as the existing mapping already was.
    expect(formatDevicePlatform("Windows")).toBe("Windows");
    expect(formatDevicePlatform("WINDOWS")).toBe("Windows");
    expect(formatDevicePlatform(null)).toBe("Unknown platform");
    expect(formatDevicePlatform("  ")).toBe("Unknown platform");
    // An unrecognized value is shown as-is rather than hidden.
    expect(formatDevicePlatform("ios")).toBe("ios");
  });
});

describe("paired device mapping feeding the list", () => {
  const row = {
    id: "d0000000-0000-4000-8000-000000000001",
    project_id: PROJECT_ID,
    build_job_id: "b0000000-0000-4000-8000-000000000001",
    device_name: "POS Device",
    platform: "android",
    created_at: "2026-08-01T00:00:00Z",
    last_seen_at: null,
    revoked_at: null,
  };

  it("maps an active device", () => {
    const device = mapPairedDeviceRow(row);

    expect(device?.status).toBe("active");
    expect(device?.deviceName).toBe("POS Device");
    expect(device?.platform).toBe("android");
  });

  it("maps a revoked device and keeps its revocation date", () => {
    const device = mapPairedDeviceRow({
      ...row,
      revoked_at: "2026-08-05T00:00:00Z",
    });

    expect(device?.status).toBe("revoked");
    expect(device?.revokedAt).toBe("2026-08-05T00:00:00Z");
  });

  it("exposes no identity field the owner list could leak", () => {
    const device = mapPairedDeviceRow(row);

    // `id` is the paired_devices row id — required by revokeDevice and not an
    // identity field. What must never appear is the auth user, the owner, or
    // who performed the revocation.
    expect(Object.keys(device ?? {}).sort()).toEqual([
      "buildJobId",
      "createdAt",
      "deviceName",
      "id",
      "lastSeenAt",
      "platform",
      "projectId",
      "revokedAt",
      "status",
      "unpairedAt",
    ]);
    expect(device).not.toHaveProperty("auth_user_id");
    expect(device).not.toHaveProperty("owner_id");
    expect(device).not.toHaveProperty("revoked_by");
  });
});
