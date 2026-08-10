// Feature 16.4A — the paired device's PURE state model.
//
// Dependency-free except for type imports and the existing generated-config
// validator: no React, no Supabase, no browser API. Every decision the device
// app makes about which screen to show lives here so it can be unit-tested
// under plain Node, exactly like lib/devicePairing.ts and lib/buildJobs.ts.
//
// The effectful half (sign-in, RPC calls) lives in lib/device.rpc.ts, which
// owns the Supabase client. This module never imports it.
//
// NOTHING HERE PERSISTS ANYTHING. The pinned config is held in React state
// only: writing it to localStorage would let a revoked device keep rendering a
// working POS after the server has already cut it off, which is precisely the
// guarantee get_device_config provides by filtering `revoked_at is null` on
// every call.
import { isGeneratedPosConfig } from "@/lib/generatedPosConfig";
import type { GeneratedPosConfig } from "@/lib/generatedPosConfig";
import type { MenuItem } from "@/lib/projectConfig";

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

export type DeviceStatus =
  | "checking"
  | "signing_in"
  | "unpaired"
  | "redeeming"
  | "loading_config"
  | "ready"
  | "revoked"
  | "config_unavailable"
  | "error";

/** Why the device cannot proceed. Never carries a raw database message. */
export type DeviceErrorKind = "offline" | "unavailable";

export type DevicePairing = {
  deviceId: string;
  projectId: string;
  buildJobId: string;
  deviceName: string | null;
  platform: string | null;
  createdAt: string | null;
  revokedAt: string | null;
};

export type DeviceState =
  | { status: "checking" }
  | { status: "signing_in" }
  | { status: "unpaired"; notice: string | null }
  | { status: "redeeming" }
  | { status: "loading_config"; pairing: DevicePairing }
  | { status: "ready"; pairing: DevicePairing; config: GeneratedPosConfig }
  | { status: "revoked"; pairing: DevicePairing }
  | { status: "config_unavailable"; pairing: DevicePairing | null }
  | { status: "error"; kind: DeviceErrorKind; message: string };

export const DEVICE_ERROR_MESSAGES: Record<DeviceErrorKind, string> = {
  offline:
    "This device is offline. POS Canvas needs a network connection to take payments.",
  unavailable: "POS Canvas could not be reached. Please try again.",
};

export function createDeviceError(kind: DeviceErrorKind): DeviceState {
  return { status: "error", kind, message: DEVICE_ERROR_MESSAGES[kind] };
}

// ---------------------------------------------------------------------------
// get_device_pairing_state — parsing and the decision it drives
// ---------------------------------------------------------------------------

export type PairingStateResult =
  | { paired: false; reason: "not_authenticated" | "not_paired" }
  | { paired: true; pairing: DevicePairing; active: boolean }
  | { paired: false; reason: "unreadable" };

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Parses the jsonb from get_device_pairing_state.
 *
 * An unrecognized payload becomes `unreadable` rather than throwing or being
 * coerced into "paired": a device must never be treated as authorized on the
 * strength of a shape it does not understand.
 */
export function parsePairingState(value: unknown): PairingStateResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { paired: false, reason: "unreadable" };
  }

  const raw = value as Record<string, unknown>;

  if (raw.paired === false) {
    return {
      paired: false,
      reason: raw.reason === "not_authenticated" ? "not_authenticated" : "not_paired",
    };
  }

  if (raw.paired !== true) {
    return { paired: false, reason: "unreadable" };
  }

  const deviceId = readString(raw, "device_id");
  const projectId = readString(raw, "project_id");
  const buildJobId = readString(raw, "build_job_id");

  if (deviceId === null || projectId === null || buildJobId === null) {
    return { paired: false, reason: "unreadable" };
  }

  const revokedAt = readString(raw, "revoked_at");

  return {
    paired: true,
    pairing: {
      deviceId,
      projectId,
      buildJobId,
      deviceName: readString(raw, "device_name"),
      platform: readString(raw, "platform"),
      createdAt: readString(raw, "created_at"),
      revokedAt,
    },
    // `active` is derived from revoked_at rather than trusted from the
    // payload's own boolean, so the two can never disagree in the device's
    // favour.
    active: revokedAt === null,
  };
}

/**
 * The cold-start decision: given a parsed pairing state, which screen?
 *
 * Deliberately total — every branch returns a state, so there is no path
 * where an unrecognized result leaves the device on a stale screen.
 */
export function decidePairingState(result: PairingStateResult): DeviceState {
  if (result.paired) {
    return result.active
      ? { status: "loading_config", pairing: result.pairing }
      : { status: "revoked", pairing: result.pairing };
  }

  if (result.reason === "not_paired") {
    return { status: "unpaired", notice: null };
  }

  // not_authenticated: the session vanished or was never established. Sending
  // the operator back to sign-in (rather than the pairing form) keeps the two
  // failure modes distinct.
  if (result.reason === "not_authenticated") {
    return { status: "signing_in" };
  }

  return createDeviceError("unavailable");
}

// ---------------------------------------------------------------------------
// get_device_config — parsing and validation
// ---------------------------------------------------------------------------

export type DeviceConfigResult =
  | { ok: true; projectId: string; buildJobId: string; config: GeneratedPosConfig }
  | { ok: false; reason: "not_paired" | "config_unavailable" };

/**
 * Parses get_device_config and validates the snapshot against the SAME
 * contract the owner runtime uses (isGeneratedPosConfig). A snapshot that
 * fails validation is treated as unavailable rather than rendered partially:
 * a POS with a half-understood price list must not open.
 */
export function parseDeviceConfig(value: unknown): DeviceConfigResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "config_unavailable" };
  }

  const raw = value as Record<string, unknown>;

  if (raw.ok !== true) {
    return {
      ok: false,
      reason: raw.error === "not_paired" ? "not_paired" : "config_unavailable",
    };
  }

  const projectId = readString(raw, "project_id");
  const buildJobId = readString(raw, "build_job_id");

  if (projectId === null || buildJobId === null) {
    return { ok: false, reason: "config_unavailable" };
  }

  if (!isGeneratedPosConfig(raw.config)) {
    return { ok: false, reason: "config_unavailable" };
  }

  return { ok: true, projectId, buildJobId, config: raw.config };
}

/** The state a config load resolves to. */
export function decideConfigState(
  result: DeviceConfigResult,
  pairing: DevicePairing
): DeviceState {
  if (result.ok) {
    return { status: "ready", pairing, config: result.config };
  }

  // not_paired here means the device was revoked between the state check and
  // the config load — get_device_config filters `revoked_at is null`, so the
  // row simply stops matching. Treat it as revocation, not as a config fault.
  if (result.reason === "not_paired") {
    return { status: "revoked", pairing };
  }

  return { status: "config_unavailable", pairing };
}

// ---------------------------------------------------------------------------
// Device menu presentation — Feature 16.4A decision 6
// ---------------------------------------------------------------------------

/**
 * Strips stock tracking from a pinned snapshot for device display.
 *
 * The snapshot's stockQuantity was frozen when the build was created and is
 * NOT live inventory. Rendering it would tell a cashier "7 in stock" from a
 * number that may be weeks old, and would let the client-side gate in
 * lib/cart.ts block or allow a sale on stale data.
 *
 * Setting trackInventory to false on the DISPLAY copy is the smallest change
 * that achieves both: every layout (MenuGridBrowser, ProductGridBrowser,
 * ServiceGridBrowser) hides its stock line and its out-of-stock state when
 * trackInventory is false, and canAddItemQuantity stops gating.
 *
 * Inventory remains fully enforced where it is authoritative: complete_sale_v2
 * validates every line against the LIVE project config inside the sale
 * transaction and rejects with "Insufficient inventory for X".
 *
 * The pricing side of the snapshot is untouched — prices, tax and the receipt
 * prefix stay exactly as pinned.
 */
export function toDeviceDisplayConfig(
  config: GeneratedPosConfig
): GeneratedPosConfig {
  return {
    ...config,
    menuItems: config.menuItems.map(
      (item): MenuItem => ({
        ...item,
        trackInventory: false,
        stockQuantity: 0,
      })
    ),
  };
}

// ---------------------------------------------------------------------------
// Device identity, sent ONCE at redemption
//
// D4c freezes paired_devices.device_name and .platform at insert: there is no
// rename RPC and no writer for either column afterwards. Redemption is
// therefore the single opportunity to record them, and sending nulls (as the
// first 16.4A pass did) would leave every till permanently listed as
// "Unnamed device" in the owner's device list.
//
// Deliberately NOT included: any owner-specific or per-store name, any device
// serial, any hardware identifier, and anything derived from auth_user_id. A
// fixed product name plus a coarse platform is the minimum that makes a row
// identifiable, and it is all the owner list needs.
// ---------------------------------------------------------------------------

/** The one name every paired till is created with. */
export const DEVICE_NAME = "POS Device";

export type DevicePlatform = "android" | "web";

export type DeviceIdentity = {
  deviceName: string;
  platform: DevicePlatform;
};

/**
 * Builds the identity sent to redeem_device_pairing_token.
 *
 * Pure: the caller supplies the already-detected native-shell boolean (from
 * lib/nativeShell.ts's isCapacitorNativeShell), so this stays testable under
 * plain Node with no DOM and no Capacitor global.
 *
 * "android" is correct for the only native shell that exists today; the
 * Capacitor project is Android-only (there is no ios/ directory), so a native
 * platform cannot currently be anything else.
 */
export function resolveDeviceIdentity(isNativeShell: boolean): DeviceIdentity {
  return {
    deviceName: DEVICE_NAME,
    platform: isNativeShell ? "android" : "web",
  };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export function getDeviceDisplayName(pairing: DevicePairing): string {
  if (pairing.deviceName !== null) {
    return pairing.deviceName;
  }

  return pairing.platform !== null
    ? `Unnamed ${pairing.platform} device`
    : "This device";
}

/** True when the POS may accept input. Nothing else may open the till. */
export function isDeviceOperational(state: DeviceState): boolean {
  return state.status === "ready";
}
