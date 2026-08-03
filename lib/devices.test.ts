import { describe, expect, it } from "vitest";
import {
  getPairedDeviceDisplayName,
  getPairedDeviceStatusLabel,
  isPairedDeviceActive,
  mapPairedDeviceRow,
} from "@/lib/devices";
import type { PairedDeviceRow, PairedDeviceSummary } from "@/lib/devices";

function makeRow(overrides: Partial<PairedDeviceRow> = {}): PairedDeviceRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    project_id: "22222222-2222-4222-8222-222222222222",
    build_job_id: "33333333-3333-4333-8333-333333333333",
    device_name: "Front Till",
    platform: "android",
    created_at: "2026-08-03T12:00:00.000Z",
    last_seen_at: null,
    revoked_at: null,
    ...overrides,
  };
}

describe("mapPairedDeviceRow", () => {
  it("maps an active device", () => {
    const device = mapPairedDeviceRow(makeRow());

    expect(device).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      buildJobId: "33333333-3333-4333-8333-333333333333",
      deviceName: "Front Till",
      platform: "android",
      status: "active",
      createdAt: "2026-08-03T12:00:00.000Z",
      lastSeenAt: null,
      revokedAt: null,
    });
  });

  it("derives revoked status from revoked_at", () => {
    const device = mapPairedDeviceRow(
      makeRow({ revoked_at: "2026-08-03T13:00:00.000Z" })
    );

    expect(device?.status).toBe("revoked");
    expect(device && isPairedDeviceActive(device)).toBe(false);
  });

  it("normalizes blank optional fields to null", () => {
    const device = mapPairedDeviceRow(
      makeRow({ device_name: "   ", platform: "" })
    );

    expect(device?.deviceName).toBeNull();
    expect(device?.platform).toBeNull();
  });

  it("rejects a row missing a core identity field", () => {
    expect(mapPairedDeviceRow(makeRow({ id: "" }))).toBeNull();
    expect(mapPairedDeviceRow(makeRow({ project_id: "" }))).toBeNull();
    expect(mapPairedDeviceRow(makeRow({ build_job_id: "" }))).toBeNull();
    expect(mapPairedDeviceRow(makeRow({ created_at: "" }))).toBeNull();
  });

  // The browser-facing shape must never carry these, so there is no field for
  // them to leak through even if a caller widened the select.
  it("never exposes auth_user_id, owner_id or revoked_by", () => {
    const device = mapPairedDeviceRow(makeRow()) as PairedDeviceSummary;

    expect(Object.keys(device).sort()).toEqual([
      "buildJobId",
      "createdAt",
      "deviceName",
      "id",
      "lastSeenAt",
      "platform",
      "projectId",
      "revokedAt",
      "status",
    ]);
    expect(device).not.toHaveProperty("authUserId");
    expect(device).not.toHaveProperty("ownerId");
    expect(device).not.toHaveProperty("revokedBy");
  });
});

describe("display helpers", () => {
  it("labels status for the owner UI", () => {
    expect(getPairedDeviceStatusLabel("active")).toBe("Active");
    expect(getPairedDeviceStatusLabel("revoked")).toBe("Revoked");
  });

  it("falls back to a platform-aware name when the device is unnamed", () => {
    const named = mapPairedDeviceRow(makeRow()) as PairedDeviceSummary;
    const unnamed = mapPairedDeviceRow(
      makeRow({ device_name: null })
    ) as PairedDeviceSummary;
    const bare = mapPairedDeviceRow(
      makeRow({ device_name: null, platform: null })
    ) as PairedDeviceSummary;

    expect(getPairedDeviceDisplayName(named)).toBe("Front Till");
    expect(getPairedDeviceDisplayName(unnamed)).toBe("Unnamed android device");
    expect(getPairedDeviceDisplayName(bare)).toBe("Unnamed device");
  });
});
