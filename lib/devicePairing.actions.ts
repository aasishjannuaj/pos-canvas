"use server";

import { isValidUuid } from "@/lib/buildJobs";
import type { CreatePairingTokenResult } from "@/lib/devicePairing";
import { createPairingFailure } from "@/lib/devicePairing";
import type { PairedDeviceSummary } from "@/lib/devices";
import {
  cancelDevicePairingToken,
  createDevicePairingToken,
  getProjectPairedDevices,
  offerDeviceConfigUpdate,
  offerDeviceConfigUpdateToAll,
  revokePairedDevice,
} from "@/lib/devicePairing.server";
import type { BulkOfferResult } from "@/lib/devicePairing.server";

// Feature 16.3, Migration B — the only server boundary the browser can reach
// for device pairing. Same thin-wrapper convention as
// lib/buildJobs.actions.ts: minimal shape checks on the exact fields a caller
// may supply, then delegation to a .server.ts function that performs every
// authentication and ownership step itself and returns an already-sanitized
// result.
//
// Nothing here ever accepts an owner id, a token hash, or a build snapshot —
// these functions' input types have no field for any of them. The service-role
// client is never touched in this file; it exists only inside
// lib/devicePairing.server.ts, which is "server-only" guarded.

function isNonEmptyId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Creates a one-time pairing code for a project's succeeded build.
 *
 * The returned `code` is the ONLY time the plaintext exists outside the
 * generating process. The caller must display it once and must not persist it
 * to localStorage, a URL, analytics, or a log.
 */
export async function requestDevicePairingToken(input: {
  projectId: string;
  buildJobId: string;
}): Promise<CreatePairingTokenResult> {
  if (!isNonEmptyId(input?.projectId) || !isNonEmptyId(input?.buildJobId)) {
    return createPairingFailure("invalid_request");
  }

  return createDevicePairingToken({
    projectId: input.projectId,
    buildJobId: input.buildJobId,
  });
}

/**
 * Lists devices paired to a project the caller owns. RLS scopes the read, so
 * a project belonging to another owner returns an empty list rather than an
 * error that would confirm its existence.
 */
export async function listProjectPairedDevices(
  projectId: string
): Promise<
  { ok: true; devices: PairedDeviceSummary[] } | { ok: false; message: string }
> {
  if (!isNonEmptyId(projectId)) {
    return { ok: false, message: "A valid project is required." };
  }

  const { devices, error } = await getProjectPairedDevices(projectId);

  if (error) {
    return { ok: false, message: error };
  }

  return { ok: true, devices };
}

/**
 * Revokes a paired device. Idempotent — revoking an already-revoked device
 * succeeds. Ownership is enforced in the database function, so a device
 * belonging to another owner is reported exactly like one that does not exist.
 */
export async function revokeDevice(
  deviceId: string
): Promise<{ ok: true; alreadyRevoked: boolean } | { ok: false; message: string }> {
  if (!isNonEmptyId(deviceId)) {
    return { ok: false, message: "A valid device is required." };
  }

  return revokePairedDevice(deviceId);
}

/**
 * Feature 26.3 — offers a published configuration to one paired device.
 *
 * Takes the two ids a caller is allowed to name and nothing else: no owner id,
 * no project id, no configuration. Both are re-checked against the caller's own
 * ownership inside offer_device_config_update, so these shape checks exist to
 * fail early, not to authorize.
 *
 * An offer changes no prices. The device applies it, or does not.
 */
export async function offerDeviceUpdate(input: {
  deviceId: string;
  buildJobId: string;
}): Promise<
  { ok: true; alreadyOffered: boolean } | { ok: false; message: string }
> {
  // Both columns are uuid. A malformed value would otherwise reach Postgres as
  // an invalid-input-syntax error rather than as a row that does not match —
  // the same correction Feature 15.7 applied to downloadBuildArtifact. It fails
  // closed either way; this keeps a typo from becoming a database round trip.
  if (!isValidUuid(input?.deviceId) || !isValidUuid(input?.buildJobId)) {
    return { ok: false, message: "A valid device and configuration are required." };
  }

  return offerDeviceConfigUpdate({
    deviceId: input.deviceId,
    buildJobId: input.buildJobId,
  });
}

/**
 * Feature 26.4 — offers the latest published configuration to every eligible
 * paired device on a project.
 *
 * Takes ONE argument, and it is not a device list. The server resolves both the
 * latest build and the eligible devices from the database, so a caller cannot
 * name a device it should not touch, cannot name a build that is not current,
 * and cannot be told a count that differs from what was acted on.
 *
 * Partial success is a success: the counts say what happened.
 */
export async function offerDeviceUpdateToAll(
  projectId: string
): Promise<BulkOfferResult> {
  if (!isValidUuid(projectId)) {
    return { ok: false, message: "A valid project is required." };
  }

  return offerDeviceConfigUpdateToAll(projectId);
}

/**
 * Cancels a pairing code the owner no longer wants to use.
 *
 * Idempotent. A code already redeemed by a device cannot be cancelled — the
 * correct action there is revoking the resulting device.
 */
export async function cancelPairingToken(
  tokenId: string
): Promise<
  { ok: true; alreadyCancelled: boolean } | { ok: false; message: string }
> {
  if (!isNonEmptyId(tokenId)) {
    return { ok: false, message: "A valid pairing code is required." };
  }

  return cancelDevicePairingToken(tokenId);
}
