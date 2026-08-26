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
import {
  evaluateLease,
  readPairingAssertion,
  readPinnedConfig,
} from "@/lib/deviceOfflineCache";
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
  | "reconnect_required"
  | "error";

/**
 * Why the device cannot proceed. Never carries a raw database message.
 *
 * Feature 25.4 — `startup_failed` exists because `offline` was being told for
 * two different facts. A fresh install whose sign-in the SERVER REFUSED — the
 * anonymous provider switched off, for instance — was reported as "No
 * connection" on a machine with perfect connectivity, which cost a full
 * debugging cycle and would send an operator to check a router that is working.
 *
 * The three are separated by what is KNOWN, not by what went wrong:
 *
 *   offline        — nothing answered. A transport failure, positively
 *                    classified; the network is the thing to check.
 *   startup_failed — something answered and refused, or the failure could not
 *                    be proven to be transport. The network is not the lead.
 *   unavailable    — a reply arrived and could not be understood. Unchanged,
 *                    and still only reachable from decidePairingState.
 */
export type DeviceErrorKind = "offline" | "startup_failed" | "unavailable";

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
  // Feature 24.5A — `offline` is OPTIONAL and absent for an online start, so
  // every existing construction of this state is unchanged. Its presence is
  // what makes the runtime read-only.
  | {
      status: "ready";
      pairing: DevicePairing;
      config: GeneratedPosConfig;
      offline?: OfflineRuntimeInfo | null;
    }
  | { status: "revoked"; pairing: DevicePairing }
  | { status: "config_unavailable"; pairing: DevicePairing | null }
  // Feature 24.5A — the device is offline AND cannot use its cache: no cache,
  // an expired 7-day lease, a corrupt record, or an identity that no longer
  // matches. Deliberately NOT an "error": nothing is broken, the till simply
  // needs the network before it can be trusted again.
  | { status: "reconnect_required"; reason: OfflineBlockedReason }
  | { status: "error"; kind: DeviceErrorKind; message: string };

// ---------------------------------------------------------------------------
// Feature 24.5A — offline read-only mode
// ---------------------------------------------------------------------------

/**
 * How the runtime is currently running.
 *
 * An EXPLICIT mode, never inferred from navigator.onLine: that property reports
 * "online" behind a captive portal and on a machine with a live NIC and no
 * route. The mode is set by which cold-start branch actually opened the POS.
 *
 * RENAMED IN 24.5E, from "offline_read_only". The value had always meant "this
 * session opened from the cache rather than from the server", but its name also
 * asserted what such a session was allowed to DO — and 24.5E changed that: a
 * cached session with a valid lease may now complete sales into the durable
 * queue. A constant that says read-only while sales are being taken is the kind
 * of drift that misleads the next reader, so the name now describes the fact it
 * has always described and nothing more.
 */
export type DeviceRuntimeMode = "online" | "offline";

/** What the operator is told while running from cache. */
export type OfflineRuntimeInfo = {
  /** ISO — when the server last confirmed this device. */
  lastVerifiedAt: string;
  /** ISO — when the 7-day lease runs out. */
  leaseExpiresAt: string;
  /** Within the warning window, so the UI can say "reconnect soon". */
  expiringSoon: boolean;
};

/** Why a cached start was refused. Every value means "require the network". */
export type OfflineBlockedReason =
  | "no_cache"
  | "identity_mismatch"
  | "lease_expired"
  | "clock_invalid"
  | "cache_corrupt"
  | "storage_unavailable";

/**
 * The whole of what an operator is shown, titles included.
 *
 * NOTHING HERE NAMES A MECHANISM. No provider, no vendor, no HTTP status, no
 * auth or PostgREST vocabulary, and never a raw server message — a cashier
 * reads these, and a sentence naming the thing that refused is one they cannot
 * act on. What differs between them is only which action is worth trying.
 */
export const DEVICE_ERROR_TITLES: Record<DeviceErrorKind, string> = {
  offline: "No connection",
  startup_failed: "Unable to start this device",
  unavailable: "Something went wrong",
};

export const DEVICE_ERROR_MESSAGES: Record<DeviceErrorKind, string> = {
  offline:
    "POS Canvas couldn't reach the service. Check your internet connection and try again.",
  // Says only what is true in every case that reaches it. The suggested wording
  // opened with "reached the service", which is proven for a refused reply and
  // NOT proven for a failure that could not be classified — and both land here.
  // Claiming it would reintroduce, in the other direction, exactly the kind of
  // confident-but-wrong sentence this feature exists to remove.
  startup_failed:
    "POS Canvas couldn't start this device. Try again, and contact support if the problem continues.",
  unavailable: "POS Canvas could not be reached. Please try again.",
};

export function createDeviceError(kind: DeviceErrorKind): DeviceState {
  return { status: "error", kind, message: DEVICE_ERROR_MESSAGES[kind] };
}

// ---------------------------------------------------------------------------
// get_device_pairing_state — parsing and the decision it drives
// ---------------------------------------------------------------------------

export type PairingStateResult =
  /**
   * Feature 25.1 — `unpaired` is distinct from `not_paired` on purpose.
   *
   * Both send the operator to the pairing screen, but only `unpaired` means a
   * STALE LOCAL SESSION is still on this device. The client has to clear it:
   * redeem_device_pairing_token keys on auth_user_id, so re-pairing under the
   * old anonymous user would find the old row and answer `already_paired`,
   * leaving the till unable to pair again.
   */
  | { paired: false; reason: "not_authenticated" | "not_paired" | "unpaired" }
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
      reason:
        raw.reason === "not_authenticated"
          ? "not_authenticated"
          : raw.reason === "unpaired"
            ? "unpaired"
            : "not_paired",
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

  // Feature 25.1 — the same screen for both. A device that removed itself and a
  // device that was never paired are in the same place from here: they need a
  // pairing code. What differs is the session cleanup the caller performs, which
  // is a side effect and not a screen.
  if (result.reason === "not_paired" || result.reason === "unpaired") {
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

export type DevicePlatform = "android" | "windows" | "web";

export type DeviceIdentity = {
  deviceName: string;
  platform: DevicePlatform;
};

/**
 * Which shells the caller detected. Feature 23.3 widened this from a single
 * boolean.
 *
 * A NAMED OBJECT RATHER THAN TWO POSITIONAL BOOLEANS, on purpose. D4c freezes
 * paired_devices.platform at insert and provides no writer afterwards, so a
 * transposed pair of arguments would permanently mislabel every till it touched
 * with no way to correct it. `resolveDeviceIdentity(a, b)` makes that a typo;
 * this shape makes it impossible.
 */
export type DeviceShellSignals = {
  /** Capacitor's own isNativePlatform() — see lib/nativeShell.ts. */
  isNativeShell: boolean;
  /** The Electron preload's identity bridge — see lib/windowsShell.ts. */
  isWindowsShell: boolean;
};

/**
 * Builds the identity sent to redeem_device_pairing_token.
 *
 * Pure: the caller supplies the already-detected booleans, so this stays
 * testable under plain Node with no DOM, no Capacitor global and no Electron.
 *
 * PRIORITY IS EXPLICIT, AND ANDROID WINS. A device inside the Capacitor shell is
 * an Android till, full stop — that is established by Capacitor's own native
 * bridge, which nothing else can produce. The desktop signal is only consulted
 * when the native one is absent, so an unexpected or spoofed
 * `window.posCanvasDesktop` inside the Android WebView cannot relabel a real
 * Android till as Windows. Neither signal present means `web`, exactly as
 * before.
 *
 * "android" is correct for the only native shell that exists today; the
 * Capacitor project is Android-only (there is no ios/ directory), so a native
 * platform cannot currently be anything else. "windows" is likewise the only
 * desktop platform this product ships — macOS and Linux builds are explicit
 * non-goals of Feature 23.
 */
export function resolveDeviceIdentity(signals: DeviceShellSignals): DeviceIdentity {
  return {
    deviceName: DEVICE_NAME,
    platform: signals.isNativeShell
      ? "android"
      : signals.isWindowsShell
        ? "windows"
        : "web",
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


// ---------------------------------------------------------------------------
// Feature 24.5A — the cached cold-start decision
// ---------------------------------------------------------------------------

/**
 * The single place that decides whether a cached POS may open.
 *
 * PURE AND EXHAUSTIVE ON PURPOSE. Storage I/O happens in the caller and its
 * results are passed in as raw values, so every refusal path is reachable in a
 * test under plain Node — including the ones that are almost impossible to
 * produce on a real device (a tampered digest, a clock in the future, a record
 * from another business).
 *
 * THIS FUNCTION IS ONLY EVER REACHED AFTER A TRANSPORT FAILURE. Classification
 * lives in lib/deviceConnectivity.ts, and a server that answered — revoked,
 * unpaired, unusable build — never gets here. That separation is what stops a
 * revoked till from trading on cache.
 *
 * Every failure is the same outcome for the operator: reconnect required. The
 * distinct reasons exist so the refusal can be explained and tested, not so
 * some of them can be treated leniently.
 */
export async function decideOfflineFallback(input: {
  now: number;
  sessionUserId: string;
  assertionRecord: unknown;
  configRecord: unknown;
  leaseMs?: number;
}): Promise<
  | {
      ok: true;
      pairing: DevicePairing;
      config: GeneratedPosConfig;
      offline: OfflineRuntimeInfo;
    }
  | { ok: false; reason: OfflineBlockedReason }
> {
  const assertion = readPairingAssertion(input.assertionRecord, input.sessionUserId);

  if (!assertion.ok) {
    if (assertion.reason === "identity_mismatch") {
      return { ok: false, reason: "identity_mismatch" };
    }

    // A record written by a newer envelope, or a malformed one, is corrupt for
    // our purposes: unusable and not to be guessed at.
    return {
      ok: false,
      reason: assertion.reason === "missing" ? "no_cache" : "cache_corrupt",
    };
  }

  const lease = evaluateLease(
    assertion.assertion.lastVerifiedAt,
    input.now,
    input.leaseMs
  );

  if (!lease.ok) {
    if (lease.reason === "expired") {
      return { ok: false, reason: "lease_expired" };
    }

    // "future", "unparseable" and "missing" all mean the recorded time cannot
    // be reasoned about. Refuse rather than assume, so a wrong clock can never
    // be used to extend a lease.
    return { ok: false, reason: "clock_invalid" };
  }

  const config = await readPinnedConfig(input.configRecord, {
    deviceAuthUserId: assertion.assertion.deviceAuthUserId,
    projectId: assertion.assertion.projectId,
    buildJobId: assertion.assertion.buildJobId,
  });

  if (!config.ok) {
    if (config.reason === "missing") {
      return { ok: false, reason: "no_cache" };
    }

    if (config.reason === "identity_mismatch") {
      return { ok: false, reason: "identity_mismatch" };
    }

    return { ok: false, reason: "cache_corrupt" };
  }

  return {
    ok: true,
    pairing: {
      deviceId: assertion.assertion.deviceId,
      projectId: assertion.assertion.projectId,
      buildJobId: assertion.assertion.buildJobId,
      deviceName: assertion.assertion.deviceName,
      platform: assertion.assertion.platform,
      // Not cached: neither is needed to run, and storing a stale revokedAt
      // would invite treating it as an authorization answer. Offline
      // authorization is the lease, and nothing else.
      createdAt: null,
      revokedAt: null,
    },
    config: config.record.configSnapshot,
    offline: {
      lastVerifiedAt: assertion.assertion.lastVerifiedAt,
      leaseExpiresAt: new Date(lease.expiresAt).toISOString(),
      expiringSoon: lease.expiringSoon,
    },
  };
}

/** The runtime mode a resolved state implies. Never guessed from the network. */
export function getDeviceRuntimeMode(state: DeviceState): DeviceRuntimeMode {
  return state.status === "ready" && state.offline ? "offline" : "online";
}

/** Copy for every refusal. One sentence of what, one of what to do. */
export const OFFLINE_BLOCKED_MESSAGES: Record<OfflineBlockedReason, string> = {
  no_cache:
    "This till has not been set up for offline use yet. Connect to the internet once to finish setting it up.",
  identity_mismatch:
    "This till's saved setup does not match the device it is paired to. Connect to the internet to set it up again.",
  lease_expired:
    "This till has been offline for more than 7 days. Connect to the internet to confirm it is still active.",
  clock_invalid:
    "This device's date and time could not be confirmed. Check the clock, then connect to the internet.",
  cache_corrupt:
    "This till's saved setup could not be read. Connect to the internet to load it again.",
  storage_unavailable:
    "This till cannot save its setup on this device. Connect to the internet to keep using it.",
};
