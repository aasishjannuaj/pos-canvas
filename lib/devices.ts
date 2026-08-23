// Feature 16.3, Migration B — browser-safe paired-device types and pure
// mappers. Dependency-free (no React, Supabase, or Node import), so this is
// safe to import from a future Builder client component that renders the
// device list.
//
// Deliberately has no field for auth_user_id, owner_id, revoked_by, or any
// token material: those are never meant to reach a browser, so there is
// simply nowhere for them to leak through.

/**
 * Feature 25.1 — three states, because two different things can end a pairing.
 *
 * `revoked` is the OWNER cutting a device off and carries financial meaning:
 * complete_sale_v4 compares revoked_at against a sale's occurred_at. `unpaired`
 * is the DEVICE removing itself — administrative, inert, and read by nothing on
 * the sale path. Collapsing them would tell an owner their tablet was cut off
 * when they simply moved it, and would hide the one case they need to act on.
 */
export type PairedDeviceStatus = "active" | "unpaired" | "revoked";

export type PairedDeviceSummary = {
  id: string;
  projectId: string;
  buildJobId: string;
  deviceName: string | null;
  platform: string | null;
  status: PairedDeviceStatus;
  createdAt: string;
  lastSeenAt: string | null;
  unpairedAt: string | null;
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
  unpaired_at?: string | null;
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
    // REVOKED WINS if both timestamps exist: an owner who revoked a device has
    // made the stronger statement, and it is the one with consequences.
    // NORMALISED WITH ?? null BEFORE COMPARING. `unpaired_at` is optional on the
    // row type — a query written before this column existed simply omits it —
    // and `undefined !== null` is true, so comparing the raw value would label
    // every such row Unpaired. A caller that cannot see the column must read as
    // Active, which is what it was before the column existed.
    status:
      (row.revoked_at ?? null) !== null
        ? "revoked"
        : (row.unpaired_at ?? null) !== null
          ? "unpaired"
          : "active",
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    unpairedAt: row.unpaired_at ?? null,
    revokedAt: row.revoked_at,
  };
}

export function isPairedDeviceActive(device: PairedDeviceSummary): boolean {
  return device.status === "active";
}

const DEVICE_STATUS_LABELS: Record<PairedDeviceStatus, string> = {
  active: "Active",
  unpaired: "Unpaired",
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
