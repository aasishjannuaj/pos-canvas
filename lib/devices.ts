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
  /**
   * Cash Drawer 1B/1D — the owner's per-register automatic-drawer setting.
   *
   * CONFIGURATION, NOT HARDWARE, AND NOT A PROMISE. It says what the owner has
   * asked for on this ONE register; whether a drawer can physically be reached
   * is a different question, answered on the device and never substituted for
   * this one. The authoritative value is `paired_devices.cash_drawer_enabled`,
   * which the accepted 1B migration created NOT NULL DEFAULT false — so a
   * register nobody has configured reads false, which is also the locked
   * product default.
   *
   * Boolean rather than nullable because there is no third state. A row that
   * cannot tell us — a query written before the column existed — reads false,
   * the safe answer, rather than becoming unmappable.
   */
  cashDrawerEnabled: boolean;
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
  // Cash Drawer 1D — optional for the same reason the offer columns are: a
  // query written before the column existed simply omits it, and must keep
  // reading as OFF rather than becoming unmappable.
  cash_drawer_enabled?: boolean | null;
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
    // STRICT === true, not truthiness. The column is NOT NULL DEFAULT false in
    // the accepted 1B migration, so anything that is not literally true — an
    // absent column, a null, a surprise — is OFF. Automatic drawer opening
    // must never be switched on by a value we could not read properly.
    cashDrawerEnabled: row.cash_drawer_enabled === true,
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

/**
 * Feature 26.4 — the devices a bulk offer would actually act on.
 *
 * DERIVED FROM THE SAME PREDICATE as the per-device button, deliberately. The
 * count shown next to "Offer update to all" and the set the server loops over
 * must never be two different ideas of "eligible", or the owner is told one
 * number and something else happens.
 *
 * Everything not `update_available` is skipped, which by construction means an
 * up-to-date device is not re-offered, a device already holding this exact
 * offer is not re-offered, and a revoked or unpaired device is not touched at
 * all. A device with a STALE offer — offered B2 while B3 is now latest — IS
 * eligible, because re-pointing it at B3 is precisely what the owner wants.
 */
export function selectOfferableDevices(
  devices: readonly PairedDeviceSummary[],
  latestBuildJobId: string | null
): PairedDeviceSummary[] {
  return devices.filter((device) => canOfferDeviceUpdate(device, latestBuildJobId));
}

/**
 * Feature 26.4 — what the owner is told after a bulk offer.
 *
 * SAYS BOTH NUMBERS WHENEVER THEY DIFFER. "Update offered to 5 of 6 devices"
 * is the honest sentence; "Update offered" alone would hide a device that did
 * not get one, and an owner who believes every till was reached is exactly the
 * person who will not check.
 *
 * Pure and separate from the component so the wording is testable against
 * counts rather than only readable in a browser.
 */
export function describeBulkOfferOutcome(input: {
  eligible: number;
  offered: number;
  failed: number;
}): string {
  const attempted = input.offered + input.failed;
  const remaining = Math.max(0, input.eligible - attempted);
  const devices = (n: number) => (n === 1 ? "1 device" : `${n} devices`);

  if (attempted === 0) {
    return "No devices needed this update.";
  }

  const sentences: string[] = [
    input.failed === 0
      ? `Update offered to ${devices(input.offered)}.`
      : `Update offered to ${input.offered} of ${devices(attempted)}.`,
  ];

  if (input.failed > 0) {
    sentences.push(
      `${devices(input.failed)} could not be updated. Refresh to see the current state.`
    );
  }

  // The batch cap, stated rather than hidden. Pressing again finishes the job.
  if (remaining > 0) {
    sentences.push(`${devices(remaining)} still need this update — offer again.`);
  }

  return sentences.join(" ");
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

// ---------------------------------------------------------------------------
// Cash Drawer 1D — which registers the owner may configure a drawer on
// ---------------------------------------------------------------------------

/**
 * What the owner is told when the setting could not be written.
 *
 * SAYS THAT NOTHING CHANGED, because nothing did: the write is the only thing
 * that moves the value, and a failed write leaves the register exactly as it
 * was. An owner who is not told that will reasonably assume the opposite and
 * walk away believing a drawer will open when it will not.
 *
 * One definition, shared by the server wrapper and the screen, so the two can
 * never tell the owner different things about the same failure.
 */
export const CASH_DRAWER_UPDATE_FAILED_MESSAGE =
  "Cash drawer setting could not be updated. Nothing changed. Refresh and try again.";

/**
 * What the owner is told when the write succeeded but the re-read did not.
 *
 * THE ONE CASE WHERE WE GENUINELY DO NOT KNOW. The register was changed, and
 * then the authoritative list could not be fetched, so the value on screen is
 * the OLD one and we cannot say what the new one is. Guessing would be the
 * worst available answer, so the row says so and refuses another change until
 * a Refresh re-establishes the truth.
 */
export const CASH_DRAWER_STALE_MESSAGE =
  "Saved, but the device list could not be reloaded, so the setting shown may be out of date. Refresh before changing it again.";

/**
 * The one quiet note about how a register learns of a change.
 *
 * NO PUSH, NO POLLING, NO REALTIME exists in this product, so the copy must
 * not imply any of them. A till reads its settings when it next refreshes
 * them, and an offline till keeps what it last saved until it reconnects or
 * its offline authorization expires — which is the behaviour the accepted 1B
 * pairing cache actually has.
 */
export const CASH_DRAWER_PROPAGATION_NOTE =
  "Changes take effect the next time this register refreshes its device settings. If it is offline, it may keep its last saved setting until it reconnects or its offline authorization expires.";

/**
 * The one platform with an automatic drawer path in v1.3.
 *
 * DELIBERATELY NOT IMPORTED FROM lib/cashDrawer.ts, and that is an
 * architectural rule rather than a convenience. An accepted Checkpoint 1A
 * guard pins the importers of the runtime coordinator to exactly the device
 * runtime — "the owner runtime and the Builder never reach it" — so the
 * Builder's device list may not reach into the till's sale path to ask this
 * question. The two agree on the answer today and are tested separately,
 * because they are different questions: the coordinator asks whether to open a
 * drawer after a sale, and this asks whether to offer the owner a switch.
 */
const CASH_DRAWER_PLATFORM = "windows";

/**
 * Is this register one the owner may turn automatic opening ON for?
 *
 * TWO CONDITIONS, BOTH REQUIRED. The register must be ACTIVE — a revoked or
 * unpaired till has no operational settings to change, and offering a switch
 * there would imply it still takes sales — and it must be a Windows register,
 * because Android and an ordinary browser till have no automatic drawer path
 * at all in v1.3.
 *
 * `platform` is compared case-insensitively after trimming because it is text
 * the device reported, not an enum this table constrains.
 */
export function canConfigureCashDrawer(device: PairedDeviceSummary): boolean {
  return (
    isPairedDeviceActive(device) &&
    isNonEmptyString(device.platform) &&
    device.platform.trim().toLowerCase() === CASH_DRAWER_PLATFORM
  );
}

/**
 * Why a register has no drawer switch — so the screen can say the true reason.
 *
 * FOUR ANSWERS, AND ONLY ONE HAS A CONTROL. They are kept apart because they
 * are different facts and an owner acts differently on each:
 *
 *   * `configurable` — an active Windows register. The only switch.
 *   * `unsupported_platform` — an active Android or browser till. A platform
 *     fact the owner cannot change, and explicitly NOT a permissions problem.
 *   * `revoked` — the owner cut this register off. Settings are moot, and the
 *     stored value must not be presented as if it still governed anything.
 *   * `none` — an UNPAIRED register, which renders no drawer block at all.
 *     Feature 25.1 is emphatic that revoked and unpaired are different events;
 *     showing the revoked sentence here would tell an owner their till was cut
 *     off when it simply removed itself. Saying nothing is the honest option,
 *     and it invents no new treatment for the unpaired row.
 */
export type CashDrawerConfigState =
  | "configurable"
  | "unsupported_platform"
  | "revoked"
  | "none";

export function resolveCashDrawerConfigState(
  device: PairedDeviceSummary
): CashDrawerConfigState {
  if (device.status === "revoked") return "revoked";
  if (device.status === "unpaired") return "none";

  return canConfigureCashDrawer(device) ? "configurable" : "unsupported_platform";
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
