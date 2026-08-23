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
      unpairedAt: null,
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
      "unpairedAt",
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

describe("the three-state device lifecycle (Feature 25.1)", () => {
  /** mapPairedDeviceRow is nullable; every row below is valid by construction. */
  function mapped(overrides: Partial<PairedDeviceRow> = {}): PairedDeviceSummary {
    const device = mapPairedDeviceRow(makeRow(overrides));

    if (device === null) {
      throw new Error("fixture row failed to map");
    }

    return device;
  }

  it("maps Active when neither timestamp is set", () => {
    expect(mapped({ unpaired_at: null }).status).toBe("active");
  });

  it("maps Unpaired when the device removed itself", () => {
    const device = mapped({ unpaired_at: "2026-08-23T12:00:00.000Z" });

    expect(device.status).toBe("unpaired");
    expect(device.unpairedAt).toBe("2026-08-23T12:00:00.000Z");
    expect(device.revokedAt).toBeNull();
  });

  it("maps Revoked when the owner cut it off", () => {
    expect(mapped({ revoked_at: "2026-08-23T13:00:00.000Z" }).status).toBe("revoked");
  });

  it("REVOKED WINS if both timestamps somehow exist", () => {
    // The owner made the stronger statement, and it is the one with financial
    // consequences — a device that unpaired and was then revoked must not read
    // as merely Unpaired.
    expect(
      mapped({
        revoked_at: "2026-08-23T13:00:00.000Z",
        unpaired_at: "2026-08-23T12:00:00.000Z",
      }).status
    ).toBe("revoked");
  });

  it("reads Active when the column is absent entirely", () => {
    // A query written before this column existed omits it, and `undefined` must
    // not read as "unpaired" — that would relabel every device in the list.
    expect(mapped().status).toBe("active");
  });

  it("re-pairing leaves the old row Unpaired and the new row Active", () => {
    const oldRow = mapped({
      id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
      unpaired_at: "2026-08-23T12:00:00.000Z",
    });
    const newRow = mapped({
      id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
      created_at: "2026-08-23T12:05:00.000Z",
      unpaired_at: null,
    });

    // The owner list must never show two Active rows for one physical device.
    expect(oldRow.status).toBe("unpaired");
    expect(newRow.status).toBe("active");
    expect([oldRow, newRow].filter((d) => d.status === "active")).toHaveLength(1);
  });

  it("labels all three states for an owner", () => {
    expect(getPairedDeviceStatusLabel("active")).toBe("Active");
    expect(getPairedDeviceStatusLabel("unpaired")).toBe("Unpaired");
    expect(getPairedDeviceStatusLabel("revoked")).toBe("Revoked");
  });

  it("treats only Active as active, so no Revoke action is offered otherwise", () => {
    // DeviceRow gates its Revoke button on isPairedDeviceActive.
    expect(isPairedDeviceActive(mapped({ unpaired_at: "2026-08-23T12:00:00.000Z" }))).toBe(false);
    expect(isPairedDeviceActive(mapped({ revoked_at: "2026-08-23T13:00:00.000Z" }))).toBe(false);
    expect(isPairedDeviceActive(mapped())).toBe(true);
  });
});
