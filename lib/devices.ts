// Feature 16.3, Migration B — browser-safe paired-device types and pure
// mappers. Dependency-free (no React, Supabase, or Node import), so this is
// safe to import from a future Builder client component that renders the
// device list.
//
// Deliberately has no field for auth_user_id, owner_id, revoked_by, or any
// token material: those are never meant to reach a browser, so there is
// simply nowhere for them to leak through.

export type PairedDeviceStatus = "active" | "revoked";

export type PairedDeviceSummary = {
  id: string;
  projectId: string;
  buildJobId: string;
  deviceName: string | null;
  platform: string | null;
  status: PairedDeviceStatus;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
};

// The exact narrow row shape lib/devicePairing.server.ts selects. Note the
// absence of auth_user_id and owner_id — they are never selected, rather than
// selected and discarded.
export type PairedDeviceRow = {
  id: string;
  project_id: string;
  build_job_id: string;
  device_name: string | null;
  platform: string | null;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

// Never trusts a raw row: an unusable identity field means a genuine data
// problem, so the whole row is rejected (null) rather than rendered with
// placeholder values.
export function mapPairedDeviceRow(
  row: PairedDeviceRow
): PairedDeviceSummary | null {
  if (
    !isNonEmptyString(row.id) ||
    !isNonEmptyString(row.project_id) ||
    !isNonEmptyString(row.build_job_id) ||
    !isNonEmptyString(row.created_at)
  ) {
    return null;
  }

  return {
    id: row.id,
    projectId: row.project_id,
    buildJobId: row.build_job_id,
    deviceName: isNonEmptyString(row.device_name) ? row.device_name : null,
    platform: isNonEmptyString(row.platform) ? row.platform : null,
    status: row.revoked_at === null ? "active" : "revoked",
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

export function isPairedDeviceActive(device: PairedDeviceSummary): boolean {
  return device.status === "active";
}

const DEVICE_STATUS_LABELS: Record<PairedDeviceStatus, string> = {
  active: "Active",
  revoked: "Revoked",
};

export function getPairedDeviceStatusLabel(status: PairedDeviceStatus): string {
  return DEVICE_STATUS_LABELS[status];
}

// A device with no name is still identifiable in the owner's list.
export function getPairedDeviceDisplayName(device: PairedDeviceSummary): string {
  if (device.deviceName !== null) {
    return device.deviceName;
  }

  return device.platform !== null
    ? `Unnamed ${device.platform} device`
    : "Unnamed device";
}
