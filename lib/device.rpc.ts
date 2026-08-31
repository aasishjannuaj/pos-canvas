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
import { getDeviceSupabaseClient, DEVICE_AUTH_STORAGE_KEY } from "@/lib/supabase/deviceClient";
import { classifyDeviceFailure, isDatabaseRejection } from "@/lib/deviceConnectivity";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import type { DeviceFailureKind } from "@/lib/deviceConnectivity";
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

/**
 * Feature 24.5G — attaches the HTTP status supabase-js reports alongside the error.
 *
 * WHY THIS IS NEEDED. `.rpc()` resolves to `{ data, error, status, statusText }`,
 * and every call site here destructured `{ data, error }` — throwing the status
 * away. But the PostgrestError object carries NO status of its own (verified by
 * executing a real failing call), so the classifier was left judging a reply on
 * `details`/`hint`, which postgrest fabricates during a pure fetch failure.
 *
 * Passing the status through gives the classifier the one signal that genuinely
 * separates the two cases: a real response has a positive status, and a
 * synthesized fetch failure reports 0. It also makes a non-JSON gateway error —
 * a bare 502/503 HTML page, which arrives as `{ message }` and nothing else —
 * correctly readable as an answer rather than as an unknown.
 *
 * Purely additive: the original error's own fields are untouched.
 */
function withStatus(error: unknown, status: number | undefined): unknown {
  if (error === null || typeof error !== "object" || typeof status !== "number") {
    return error;
  }

  return { ...(error as Record<string, unknown>), status };
}

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

export type DeviceSessionResult =
  | { ok: true; userId: string }
  // Feature 24.5A — `failure` is present only when the attempt actually errored.
  // A simple "no session stored" is not a failure and carries nothing.
  | { ok: false; failure?: DeviceFailureKind };

/**
 * Returns the existing anonymous session, if the browser still holds a usable one.
 *
 * Feature 24.5G — THE FAILURE IS NOW CLASSIFIED, and that is the whole fix.
 *
 * This used to collapse every outcome into `{ ok: false }`, which threw away the
 * one distinction that matters at cold start: "this device has never signed in"
 * versus "the network stopped us validating a session we already have". Those
 * demand opposite behaviour, and conflating them is why a paired till with a
 * perfect offline cache showed "This device is offline" on a zero-network start.
 *
 * WHY THIS CALL TOUCHES THE NETWORK AT ALL. supabase-js reads the session from
 * storage, but once the access token is inside its 90s expiry margin it attempts
 * a token refresh before answering. Offline that refresh fails, and past the
 * token's real expiry getSession returns `session: null` — so on any cold start
 * more than an access-token lifetime after the last online contact, an offline
 * device has no session here. That is expected and safe; what the caller must
 * not do is treat it as "this device cannot operate".
 */
export async function getDeviceSession(): Promise<DeviceSessionResult> {
  try {
    const { data, error } = await getDeviceSupabaseClient().auth.getSession();

    if (error) {
      return { ok: false, failure: classifyAuthFailure(error) };
    }

    // No error and no session means nothing was ever stored. NOT a failure, and
    // deliberately carries no failure kind: there is nothing to fall back to.
    if (!data.session?.user?.id) {
      return { ok: false };
    }

    return { ok: true, userId: data.session.user.id };
  } catch (thrown) {
    return { ok: false, failure: classifyAuthFailure(thrown) };
  }
}

/**
 * Classifies an auth-js error, using the SAME vocabulary every other call here
 * uses rather than a second parallel classifier.
 *
 * The one addition is `isAuthRetryableFetchError`, which is auth-js's own public
 * predicate for "this did not reach the server". It is consulted FIRST because
 * auth-js wraps a fetch failure in an AuthError whose status is 0 and whose
 * message varies by engine — classifyDeviceFailure would usually still reach
 * "transport" through its message table, but "usually" is not good enough when
 * the answer decides whether a till can open in the morning.
 */
function classifyAuthFailure(error: unknown): DeviceFailureKind {
  return isAuthRetryableFetchError(error) ? "transport" : classifyDeviceFailure(error);
}

/**
 * Feature 24.5G — the previously persisted device auth user id, read LOCALLY.
 *
 * WHAT IT IS FOR, and just as importantly what it is not. Offline authorization
 * in this design is the cached pairing assertion plus the 7-day lease; it has
 * never been the auth token. But `decideOfflineFallback` still has to know WHICH
 * device the cached evidence belongs to, and until now that identity could only
 * come from a validated session — which is exactly what a device with no network
 * cannot obtain. This returns that identity, and nothing else.
 *
 * IT IS NOT A CREDENTIAL. It is an ownership selector for evidence this device
 * already holds, and it can authorize nothing on its own: the assertion must
 * still match it, the pinned config must still pass its digest, and the lease
 * must still be inside 7 days. Every online path still validates through
 * Supabase, and the offline sync RPC still enforces the revocation window when
 * a queued sale is finally submitted.
 *
 * NO NETWORK, NO TOKENS. It reads one key, extracts one field, and returns a
 * string. The access token and refresh token in that same blob are never read,
 * never returned and never logged.
 *
 * MALFORMED STORAGE FAILS SAFE AND IS LEFT ALONE. Anything unparseable returns
 * null — the device then behaves exactly as it did before, requiring the
 * network — and the stored value is NOT deleted. It may be the only remaining
 * trace of a session, and destroying evidence to tidy up a parse failure is the
 * opposite of what this feature is for.
 */
export function readPersistedDeviceUserId(
  // Injected for tests; production reads the browser's own storage.
  storage: Pick<Storage, "getItem"> | null | undefined = globalThis.localStorage
): string | null {
  if (!storage || typeof storage.getItem !== "function") {
    return null;
  }

  try {
    const raw = storage.getItem(DEVICE_AUTH_STORAGE_KEY);

    if (raw === null) {
      return null;
    }

    const parsed: unknown = JSON.parse(raw);

    if (parsed === null || typeof parsed !== "object") {
      return null;
    }

    const user = (parsed as { user?: unknown }).user;

    if (user === null || typeof user !== "object") {
      return null;
    }

    const id = (user as { id?: unknown }).id;

    // Shape-checked so a truncated or hand-edited blob cannot supply an
    // identity that would then be compared against a cached assertion.
    return typeof id === "string" && DEVICE_USER_ID_PATTERN.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** A Supabase auth user id is a UUID. Format only; proves nothing about trust. */
const DEVICE_USER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      // Feature 25.4 — classifyAuthFailure, the SAME predicate getDeviceSession
      // uses, rather than the generic classifier this line used to call. Both
      // are auth-js errors and both decide what an operator is told, so they
      // must be read by the same rules; the auth-specific one consults auth-js's
      // own isAuthRetryableFetchError first, which is the only thing that can
      // state authoritatively that a request never reached the server.
      return { ok: false, failure: classifyAuthFailure(error) };
    }

    return { ok: true, userId: data.user.id };
  } catch (thrown) {
    return { ok: false, failure: classifyAuthFailure(thrown) };
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
export type UnpairOwnDeviceResult =
  | { ok: true }
  /**
   * The server did not confirm. `retryable` separates "we could not reach it"
   * from "it refused": only the first is worth pressing again, and neither may
   * clear local pairing — an unconfirmed unpair that wiped the device would
   * leave exactly the ghost Active row this feature exists to prevent.
   */
  | { ok: false; retryable: boolean; message: string };

export const UNPAIR_UNREACHABLE_MESSAGE =
  "This device could not reach POS Canvas to unpair. Check the connection and try again.";

export const UNPAIR_REFUSED_MESSAGE =
  "POS Canvas could not unpair this device. Try again, or remove it from the owner dashboard.";

/**
 * Feature 25.1 — tells the server this device has removed itself.
 *
 * IDEMPOTENT ON BOTH SIDES. unpair_own_device coalesces the timestamp, so a
 * retry after a lost response is safe and reports the original instant. That is
 * what lets the caller treat an unreachable server as "try again" rather than as
 * an ambiguous state it has to reason about.
 *
 * NOT REVOCATION. This sets unpaired_at only. revoked_at and revoked_by are
 * left alone, and so is every rule the offline sale contract derives from them —
 * this module deliberately names no sale RPC at all.
 */
export async function unpairOwnDevice(): Promise<UnpairOwnDeviceResult> {
  try {
    const { error } = await getDeviceSupabaseClient().rpc("unpair_own_device");

    if (error) {
      // A transport failure is worth retrying; an answer from the server is not
      // going to change on the next press.
      const kind = classifyDeviceFailure(error);

      return kind === "transport"
        ? { ok: false, retryable: true, message: UNPAIR_UNREACHABLE_MESSAGE }
        : { ok: false, retryable: false, message: UNPAIR_REFUSED_MESSAGE };
    }

    return { ok: true };
  } catch (thrown) {
    return classifyDeviceFailure(thrown) === "transport"
      ? { ok: false, retryable: true, message: UNPAIR_UNREACHABLE_MESSAGE }
      : { ok: false, retryable: false, message: UNPAIR_REFUSED_MESSAGE };
  }
}

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

/**
 * Feature 24.5A — the failure now carries WHY.
 *
 * The success shape is byte-for-byte what it always was. What changed is that a
 * failure reports whether the request reached a server, because that is the
 * only thing separating "the shop's internet is down" from "the server told
 * this device no" — and only the first may open a cached POS.
 *
 * Nothing about the EXISTING behaviour depends on the new field: every caller
 * that only checks `ok` behaves exactly as before.
 */
export async function fetchDevicePairingState(): Promise<
  { ok: true; state: PairingStateResult } | { ok: false; failure: DeviceFailureKind }
> {
  try {
    const { data, error, status } =
      await getDeviceSupabaseClient().rpc("get_device_pairing_state");

    if (error) {
      return { ok: false, failure: classifyDeviceFailure(withStatus(error, status)) };
    }

    return { ok: true, state: parsePairingState(data) };
  } catch (thrown) {
    return { ok: false, failure: classifyDeviceFailure(thrown) };
  }
}

// ---------------------------------------------------------------------------
// Feature 26.2 — applying an offered configuration update
// ---------------------------------------------------------------------------

/** Every server-side refusal apply_device_config_update can return. */
export type ApplyConfigUpdateError =
  | "not_authenticated"
  | "not_paired"
  | "no_update_offered"
  | "offer_unusable"
  /** The response did not match the contract. Treated as a refusal, never a success. */
  | "unreadable";

export type ApplyConfigUpdateResult =
  | {
      ok: true;
      /**
       * The pin AFTER the move, straight from the server. Reported for logging
       * and tests; the till still re-fetches get_device_config rather than
       * building a configuration around this id.
       */
      buildJobId: string;
      previousBuildJobId: string | null;
    }
  /** The server answered and said no. Pressing again will not change that. */
  | { ok: false; retryable: false; error: ApplyConfigUpdateError }
  /** We never got an answer. The pin may or may not have moved — see below. */
  | { ok: false; retryable: true; error: "transport" };

/**
 * Feature 26.2 — the device adopts the build its owner offered it.
 *
 * ZERO ARGUMENTS, ON PURPOSE. apply_device_config_update() takes none: it
 * resolves the device from auth.uid() and the build from that device's own
 * offer row. There is no device id, build id or project id for a caller to
 * supply and therefore none for a caller to get wrong or to forge. This wrapper
 * keeps that property visible by having no parameters either.
 *
 * TRANSPORT FAILURE IS NOT A REFUSAL. If the request never lands, the pin may
 * already have moved server-side. `retryable: true` says only "ask again" — and
 * a retry is safe because a second apply of a consumed offer answers
 * `no_update_offered`, which the caller resolves by refreshing state rather
 * than by assuming anything.
 *
 * NOTHING LOCAL CHANGES HERE. This function returns; it does not touch the
 * cache, the config or the pairing. That sequencing belongs to the caller,
 * which is the only place that can order it correctly.
 */
export async function applyDeviceConfigUpdate(): Promise<ApplyConfigUpdateResult> {
  try {
    const { data, error, status } =
      await getDeviceSupabaseClient().rpc("apply_device_config_update");

    if (error) {
      const kind = classifyDeviceFailure(withStatus(error, status));

      return kind === "transport"
        ? { ok: false, retryable: true, error: "transport" }
        : { ok: false, retryable: false, error: "unreadable" };
    }

    return parseApplyConfigUpdate(data);
  } catch (thrown) {
    return classifyDeviceFailure(thrown) === "transport"
      ? { ok: false, retryable: true, error: "transport" }
      : { ok: false, retryable: false, error: "unreadable" };
  }
}

/**
 * Reads the RPC's jsonb.
 *
 * An unrecognized payload is `unreadable` and NEVER a success: a device must not
 * repin itself on the strength of a shape it does not understand, and the cost
 * of being wrong here is selling at the wrong price.
 */
export function parseApplyConfigUpdate(value: unknown): ApplyConfigUpdateResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, retryable: false, error: "unreadable" };
  }

  const raw = value as Record<string, unknown>;

  if (raw.ok === true) {
    const buildJobId = raw.build_job_id;

    if (typeof buildJobId !== "string" || buildJobId.trim() === "") {
      return { ok: false, retryable: false, error: "unreadable" };
    }

    const previous = raw.previous_build_job_id;

    return {
      ok: true,
      buildJobId,
      previousBuildJobId: typeof previous === "string" && previous !== "" ? previous : null,
    };
  }

  const known: readonly ApplyConfigUpdateError[] = [
    "not_authenticated",
    "not_paired",
    "no_update_offered",
    "offer_unusable",
  ];

  const error = known.find((candidate) => candidate === raw.error) ?? "unreadable";

  return { ok: false, retryable: false, error };
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

/**
 * Feature 24.5A — a transport failure is reported as such.
 *
 * `config_unavailable` previously covered both "the build is gone" and "there is
 * no network", which are opposite situations: the first must send the operator
 * to the re-pair screen, the second may open the cache. The reason values are
 * unchanged; `failure` is additive and only set when the call itself failed.
 */
export async function fetchDeviceConfig(): Promise<
  DeviceConfigResult & { failure?: DeviceFailureKind }
> {
  try {
    const { data, error, status } = await getDeviceSupabaseClient().rpc("get_device_config");

    if (error) {
      return {
        ok: false,
        reason: "config_unavailable",
        failure: classifyDeviceFailure(withStatus(error, status)),
      };
    }

    return parseDeviceConfig(data);
  } catch (thrown) {
    return {
      ok: false,
      reason: "config_unavailable",
      failure: classifyDeviceFailure(thrown),
    };
  }
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

// Feature 18.2 — the v3 device path. completeDeviceSale (v2) below is kept so a
// device still running an older bundle continues to work; v3 is what the
// current runtime calls. complete_sale_v2 now refuses any product carrying
// modifier groups, so an old bundle fails closed rather than underselling.
export type DeviceSaleV3Request = {
  projectId: string;
  paymentMethod: "cash" | "card";
  items: {
    itemId: string;
    quantity: number;
    modifiers: { groupId: string; optionIds: string[] }[];
  }[];
  saleRequestId: string;
};

/**
 * Feature 24.5F (DEF-01) — the failure KIND travels with the message.
 *
 * The classification already existed; it was simply thrown away here, leaving
 * the host with display text and no way to tell "the shop's internet died" from
 * "the server refused this sale". That is exactly the distinction that decides
 * whether a till may fall back to its cache, so it is now returned rather than
 * re-derived from the message by whoever needs it. No new classification logic:
 * this is the same classifyDeviceFailure every other call in this module uses.
 */
export async function completeDeviceSaleV3(request: DeviceSaleV3Request): Promise<{
  receipt: CompletedSaleReceipt | null;
  error: string | null;
  failure?: DeviceFailureKind;
  /**
   * Feature 24.5F — PostgreSQL raised, so THIS invocation committed nothing.
   *
   * Strictly narrower than `failure === "server_rejected"`, which also covers a
   * proxy 502 or a gateway 504 — either of which can arrive after the database
   * has already committed. See isDatabaseRejection.
   */
  rolledBack?: boolean;
}> {
  try {
    const { data, error, status } = await getDeviceSupabaseClient().rpc("complete_sale_v3", {
      p_project_id: request.projectId,
      p_payment_method: request.paymentMethod,
      // Still hardcoded: complete_sale_v3 rejects any nonzero tip from a device,
      // exactly as v2 did, and the runtime has no tip-entry UI.
      p_tip_amount: 0,
      // Identifiers only — no name, price, tax or total has a home here.
      p_items: request.items.map((item) => ({
        itemId: item.itemId,
        quantity: item.quantity,
        modifiers: item.modifiers.map((group) => ({
          groupId: group.groupId,
          optionIds: group.optionIds,
        })),
      })),
      p_sale_request_id: request.saleRequestId,
    });

    if (error) {
      const withHttpStatus = withStatus(error, status);

      return {
        receipt: null,
        error: error.message,
        failure: classifyDeviceFailure(withHttpStatus),
        // Unchanged input on purpose: a rollback is proven by a SQLSTATE, and an
        // HTTP status neither adds to nor detracts from that.
        rolledBack: isDatabaseRejection(error),
      };
    }

    if (!isCompletedSaleReceipt(data)) {
      // A malformed body is proof the server ANSWERED. It is never a transport
      // failure, and must never unlock the cache.
      return {
        receipt: null,
        error: "The sale response could not be read.",
        failure: "server_rejected",
      };
    }

    return { receipt: data, error: null };
  } catch (thrown) {
    return {
      receipt: null,
      error: "The sale could not be completed. Check the connection and try again.",
      failure: classifyDeviceFailure(thrown),
    };
  }
}

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
 * Recognizes the message the checkout functions raise when a device is no longer
 * authorized for the project — the same message an unknown project produces,
 * because resolve_sale_owner deliberately does not distinguish them. Wording is
 * identical in v2 and v3, both of which resolve ownership through that function,
 * so this matcher serves the live v3 path unchanged.
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
