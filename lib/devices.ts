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
  /** The PINNED build. What this till currently prices from. */
  buildJobId: string;
  deviceName: string | null;
  platform: string | null;
  status: PairedDeviceStatus;
  createdAt: string;
  lastSeenAt: string | null;
  unpairedAt: string | null;
  revokedAt: string | null;
  /**
   * Feature 26.3 — the build the owner has OFFERED, if any.
   *
   * Not a pin and not a promise: the till decides whether and when to apply it
   * (Feature 26.2), and until it does, `buildJobId` above is still what every
   * sale prices from. Both fields are safe for the owner's own browser — they
   * name builds the owner already owns and can already list.
   */
  offeredBuildJobId: string | null;
  offeredAt: string | null;
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
  // Feature 26.3 — optional for the same reason unpaired_at is: a query written
  // before these columns existed simply omits them, and must keep reading as
  // "no offer" rather than becoming unmappable.
  offered_build_job_id?: string | null;
  offered_at?: string | null;
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
    // An empty string is not an offer. Normalised here so no caller has to
    // decide whether "" means anything.
    offeredBuildJobId: isNonEmptyString(row.offered_build_job_id)
      ? row.offered_build_job_id
      : null,
    offeredAt: isNonEmptyString(row.offered_at) ? row.offered_at : null,
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

// ---------------------------------------------------------------------------
// Feature 26.3 — what the owner may do about this device's configuration
// ---------------------------------------------------------------------------

/**
 * The four answers, only one of which is actionable.
 *
 * `none` is not "up to date" — it is "this row has no configuration story to
 * tell", which is true of a revoked or unpaired device and of a project with no
 * succeeded build yet. Keeping it separate from `up_to_date` stops the list
 * reassuring an owner about a till that is not running at all.
 */
export type DeviceUpdateState =
  | "none"
  | "up_to_date"
  | "update_available"
  | "update_offered";

/**
 * Derived, never stored. Given the device and the build the owner would offer,
 * says which of the four states this row is in.
 *
 * THE BOUNDARY IS THE SERVER'S OWN. offer_device_config_update reports
 * `already_offered` when — and only when — the offered build equals the one
 * being offered again, and overwrites the offer otherwise. So `update_offered`
 * means exactly "offering again would be a no-op", and every other case where
 * the pin is behind is actionable. That includes a device holding a STALE offer
 * (offered B2 while B3 is now latest): the owner can re-point it at B3, which
 * is what the RPC does, rather than being stranded until the till applies an
 * offer they have already superseded.
 *
 * Inactive devices are `none` before anything else is considered. The server
 * refuses to offer to them (revoked_at or unpaired_at set), so showing an
 * action would be showing a button that cannot work.
 */
export function resolveDeviceUpdateState(
  device: PairedDeviceSummary,
  latestBuildJobId: string | null
): DeviceUpdateState {
  if (!isPairedDeviceActive(device)) {
    return "none";
  }

  if (!isNonEmptyString(latestBuildJobId)) {
    return "none";
  }

  if (device.buildJobId === latestBuildJobId) {
    return "up_to_date";
  }

  return device.offeredBuildJobId === latestBuildJobId
    ? "update_offered"
    : "update_available";
}

/** True only for the one state that has a button. */
export function canOfferDeviceUpdate(
  device: PairedDeviceSummary,
  latestBuildJobId: string | null
): boolean {
  return resolveDeviceUpdateState(device, latestBuildJobId) === "update_available";
}

const DEVICE_UPDATE_STATE_LABELS: Record<DeviceUpdateState, string | null> = {
  none: null,
  up_to_date: "Up to date",
  update_available: "Update available",
  update_offered: "Update offered",
};

/** null means render no configuration chip at all for this row. */
export function getDeviceUpdateStateLabel(state: DeviceUpdateState): string | null {
  return DEVICE_UPDATE_STATE_LABELS[state];
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
