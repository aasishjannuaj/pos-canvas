// Feature 16.4A — the device's typed RPC boundary.
//
// The ONLY module that pairs a Supabase client with the pure decisions in
// lib/deviceSession.ts. Every call here goes through the dedicated device
// client (localStorage-namespaced, never cookie-backed), so no device
// operation can touch an owner session.
//
// IMPORT DISCIPLINE, ENFORCED BY lib/device.guards.test.ts:
//   * never lib/supabase/client.ts   (cookie-backed — would clobber the owner)
//   * never lib/supabase/server.ts   (server-only, needs next/headers)
//   * never lib/supabase/admin.ts    (service-role)
//   * never lib/orders.ts            (creates the cookie client internally)
//   * never lib/projects.ts          (owner-RLS reads a device cannot do)
//
// ERROR DISCIPLINE: redemption failures are collapsed by the database on
// purpose — wrong, expired, cancelled, already-consumed and attempt-locked
// codes all return the single `invalid_code`, so a caller cannot use the
// error as an oracle for whether a code exists. This module maps through the
// EXISTING getRedeemErrorMessage table and never surfaces a raw Postgres
// message, so the UI cannot reintroduce the distinction the backend removed.
import { getDeviceSupabaseClient } from "@/lib/supabase/deviceClient";
import {
  getRedeemErrorMessage,
  isValidPairingCodeShape,
  normalizePairingCode,
} from "@/lib/devicePairing";
import type { RedeemErrorCode, RedeemPairingResult } from "@/lib/devicePairing";
import { isCompletedSaleReceipt } from "@/lib/completedSale";
import type { CompletedSaleReceipt } from "@/lib/completedSale";
import { parseDeviceConfig, parsePairingState } from "@/lib/deviceSession";
import type {
  DeviceConfigResult,
  DeviceIdentity,
  PairingStateResult,
} from "@/lib/deviceSession";

const REDEEM_ERROR_CODES: RedeemErrorCode[] = [
  "not_authenticated",
  "not_anonymous",
  "invalid_code",
  "already_paired",
  "unavailable",
];

function toRedeemErrorCode(value: unknown): RedeemErrorCode {
  return REDEEM_ERROR_CODES.includes(value as RedeemErrorCode)
    ? (value as RedeemErrorCode)
    : "unavailable";
}

function redeemFailure(code: RedeemErrorCode): RedeemPairingResult {
  return { ok: false, error: code, message: getRedeemErrorMessage(code) };
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export type DeviceSessionResult = { ok: true; userId: string } | { ok: false };

/** Returns the existing anonymous session, if the browser still holds one. */
export async function getDeviceSession(): Promise<DeviceSessionResult> {
  try {
    const { data, error } = await getDeviceSupabaseClient().auth.getSession();

    if (error || !data.session?.user?.id) {
      return { ok: false };
    }

    return { ok: true, userId: data.session.user.id };
  } catch {
    return { ok: false };
  }
}

/**
 * Creates the device's anonymous session.
 *
 * redeem_device_pairing_token is anonymous-ONLY and fails closed on a missing
 * `is_anonymous` claim, so this is the only session type that can ever pair.
 */
export async function signInDeviceAnonymously(): Promise<DeviceSessionResult> {
  try {
    const { data, error } =
      await getDeviceSupabaseClient().auth.signInAnonymously();

    if (error || !data.user?.id) {
      return { ok: false };
    }

    return { ok: true, userId: data.user.id };
  } catch {
    return { ok: false };
  }
}

/**
 * Signs out ONLY the device client and clears ONLY its storage key.
 *
 * `scope: "local"` keeps this to this browser: it does not invalidate other
 * sessions of the same user elsewhere. It touches no cookie, so an owner
 * signed in in the same browser profile is unaffected.
 *
 * This is a LOCAL RESET, not a revocation — the paired_devices row is
 * untouched and the device stays listed (and revocable) for its owner.
 */
export async function resetDeviceSession(): Promise<void> {
  try {
    await getDeviceSupabaseClient().auth.signOut({ scope: "local" });
  } catch {
    // Ignored on purpose: the storage clear below is what actually returns
    // this device to the pairing screen, and it must happen either way.
  }

  try {
    const { DEVICE_AUTH_STORAGE_KEY } = await import("@/lib/supabase/deviceClient");
    window.localStorage.removeItem(DEVICE_AUTH_STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode, quota). signOut already cleared the
    // in-memory session, so the device still returns to the pairing screen.
  }
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

export async function fetchDevicePairingState(): Promise<
  { ok: true; state: PairingStateResult } | { ok: false }
> {
  try {
    const { data, error } =
      await getDeviceSupabaseClient().rpc("get_device_pairing_state");

    if (error) {
      return { ok: false };
    }

    return { ok: true, state: parsePairingState(data) };
  } catch {
    return { ok: false };
  }
}

/**
 * Redeems a pairing code.
 *
 * The code is normalized with the SHARED normalizePairingCode (never a local
 * copy): lowercase, spaces, hyphens and the Crockford aliases I/L->1, O->0 are
 * all accepted, and the SQL side applies the identical transform. Shape is
 * checked first so a malformed entry never becomes a redemption attempt —
 * which also means it can never consume one of the token's five attempts.
 */
export async function redeemDevicePairingCode(input: {
  code: string;
  /**
   * Recorded on the paired_devices row and frozen there by D4c. Built by
   * resolveDeviceIdentity so the value cannot vary per call site.
   */
  identity: DeviceIdentity;
}): Promise<RedeemPairingResult> {
  if (!isValidPairingCodeShape(input.code)) {
    return redeemFailure("invalid_code");
  }

  try {
    const { data, error } = await getDeviceSupabaseClient().rpc(
      "redeem_device_pairing_token",
      {
        p_code: normalizePairingCode(input.code),
        p_device_name: input.identity.deviceName,
        p_platform: input.identity.platform,
      }
    );

    // A transport/RPC error is never echoed: error.message could name a
    // constraint or function. It collapses to the same generic failure.
    if (error || !data || typeof data !== "object") {
      return redeemFailure("unavailable");
    }

    const raw = data as Record<string, unknown>;

    if (raw.ok !== true) {
      return redeemFailure(toRedeemErrorCode(raw.error));
    }

    const deviceId = raw.device_id;
    const projectId = raw.project_id;
    const buildJobId = raw.build_job_id;

    if (
      typeof deviceId !== "string" ||
      typeof projectId !== "string" ||
      typeof buildJobId !== "string"
    ) {
      return redeemFailure("unavailable");
    }

    return {
      ok: true,
      deviceId,
      projectId,
      buildJobId,
      alreadyPaired: raw.already_paired === true,
    };
  } catch {
    return redeemFailure("unavailable");
  }
}

// ---------------------------------------------------------------------------
// Pinned configuration
// ---------------------------------------------------------------------------

export async function fetchDeviceConfig(): Promise<DeviceConfigResult> {
  try {
    const { data, error } = await getDeviceSupabaseClient().rpc("get_device_config");

    if (error) {
      return { ok: false, reason: "config_unavailable" };
    }

    return parseDeviceConfig(data);
  } catch {
    return { ok: false, reason: "config_unavailable" };
  }
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

export type DeviceSaleRequest = {
  projectId: string;
  paymentMethod: "cash" | "card";
  items: { itemId: string; quantity: number }[];
  saleRequestId: string;
};

/**
 * Completes a sale through complete_sale_v2 on the DEVICE client.
 *
 * Mirrors lib/orders.ts's v2 wrapper deliberately rather than importing it:
 * that module builds the cookie-backed client internally, so importing it
 * here would put an owner-session code path inside the device bundle.
 *
 * The tip is hardcoded to 0 — complete_sale_v2 rejects any nonzero tip from a
 * device ("Tips are not supported on this device"), and the runtime has no
 * tip-entry UI in the first place.
 *
 * Only itemId and quantity leave the device. Names, prices, tax, totals and
 * the order number are all computed server-side from the pinned snapshot;
 * there is nowhere in this payload to put a client-supplied amount.
 */
export async function completeDeviceSale(request: DeviceSaleRequest): Promise<{
  receipt: CompletedSaleReceipt | null;
  error: string | null;
}> {
  try {
    const { data, error } = await getDeviceSupabaseClient().rpc("complete_sale_v2", {
      p_project_id: request.projectId,
      p_payment_method: request.paymentMethod,
      p_tip_amount: 0,
      p_items: request.items.map((item) => ({
        itemId: item.itemId,
        quantity: item.quantity,
      })),
      p_sale_request_id: request.saleRequestId,
    });

    if (error) {
      return { receipt: null, error: error.message };
    }

    if (!isCompletedSaleReceipt(data)) {
      return { receipt: null, error: "The sale response could not be read." };
    }

    return { receipt: data, error: null };
  } catch {
    return {
      receipt: null,
      error: "The sale could not be completed. Check the connection and try again.",
    };
  }
}

/**
 * Recognizes the message complete_sale_v2 raises when a device is no longer
 * authorized for the project — the same message an unknown project produces,
 * because resolve_sale_owner deliberately does not distinguish them.
 *
 * Used to re-resolve pairing state after a failed sale rather than to decide
 * anything on its own: the authoritative answer always comes from a fresh
 * get_device_pairing_state call.
 */
export function isPossibleRevocationError(message: string | null): boolean {
  return (
    message !== null && message.includes("Project not found or access denied")
  );
}
