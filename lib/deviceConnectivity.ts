// Feature 24.5A — telling "the network is down" apart from "the server said no".
//
// WHY THIS MODULE EXISTS AT ALL, stated once because everything else depends on
// it: a cached POS may open ONLY when the device could not reach the server. If
// the server DID answer and refused — revoked, unpaired, unusable build — then
// falling back to cache would let a revoked till keep trading by ignoring the
// very answer it asked for. That is the single worst bug this feature could
// ship, and the whole defence is the classification below.
//
// THE DEFAULT IS "NOT OFFLINE". Every branch that cannot prove a transport
// failure returns `server_rejected` or `unknown`, and only `transport` unlocks
// the cache. docs/OFFLINE_ARCHITECTURE.md §G: if uncertain, do not grant
// offline access. A device that wrongly shows "reconnect required" is an
// inconvenience; a device that wrongly opens is a security failure.
//
// WHAT MAKES THIS DECIDABLE: supabase-js surfaces a PostgREST/Postgres error
// with a `code` (and usually a `status`) when the server answered, and a bare
// fetch failure with neither when it did not. The presence of EITHER is proof
// the request reached something that replied.

/**
 * How a failed device RPC should be interpreted.
 *
 *   transport       nothing answered. Cached offline mode is permitted.
 *   server_rejected something answered and it was not success. Never cached.
 *   unknown         indeterminate. Treated exactly like server_rejected for
 *                   access decisions, but kept distinct so the difference is
 *                   visible in tests and in any future telemetry.
 */
export type DeviceFailureKind = "transport" | "server_rejected" | "unknown";

/**
 * Message fragments that indicate a request never completed.
 *
 * Matched case-insensitively and ONLY when no status and no Postgres code are
 * present. Browsers disagree on the wording — Chromium says "Failed to fetch",
 * Firefox "NetworkError when attempting to fetch resource", WebKit "Load
 * failed" — and undici (which Electron's main process and Node use) adds
 * "fetch failed" with an ENOTFOUND/ECONNREFUSED cause.
 */
const TRANSPORT_MESSAGE_FRAGMENTS = [
  "failed to fetch",
  "fetch failed",
  "networkerror",
  "network error",
  "load failed",
  "network request failed",
  "err_internet_disconnected",
  "err_name_not_resolved",
  "err_connection_refused",
  "err_address_unreachable",
  "enotfound",
  "econnrefused",
  "eai_again",
  "econnreset",
  "etimedout",
  "the internet connection appears to be offline",
  "aborterror",
  "signal timed out",
  "timeout",
];

/** Anything with one of these has demonstrably reached a server. */
function hasServerResponseEvidence(error: Record<string, unknown>): boolean {
  const status = error.status;

  if (typeof status === "number" && Number.isFinite(status) && status > 0) {
    return true;
  }

  // PostgREST returns a Postgres SQLSTATE ("P0001" for a raise, "42501" for a
  // permission denial) or its own code. Either way, SQL ran.
  const code = error.code;

  if (typeof code === "string" && code.trim() !== "") {
    // undici/Node put OS-level socket codes in the same field. Those are the
    // opposite conclusion, so they are excluded explicitly rather than being
    // mistaken for a database answer.
    const normalized = code.trim().toUpperCase();
    const socketCodes = [
      "ENOTFOUND",
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "EPIPE",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET",
    ];

    return !socketCodes.includes(normalized);
  }

  // A PostgREST error body carries these even when a code is absent.
  return (
    typeof error.details === "string" ||
    typeof error.hint === "string"
  );
}

function messageOf(error: Record<string, unknown>): string {
  const parts: string[] = [];

  if (typeof error.message === "string") parts.push(error.message);
  if (typeof error.name === "string") parts.push(error.name);

  const cause = error.cause;

  if (cause !== null && typeof cause === "object") {
    const causeRecord = cause as Record<string, unknown>;
    if (typeof causeRecord.message === "string") parts.push(causeRecord.message);
    if (typeof causeRecord.code === "string") parts.push(causeRecord.code);
  }

  return parts.join(" ").toLowerCase();
}

/**
 * Classifies a supabase-js error object or a thrown value.
 *
 * `null`/`undefined` means "there was no error", which is not this function's
 * question; it returns `unknown` so a caller that reaches here by mistake still
 * gets the safe answer rather than the permissive one.
 */
export function classifyDeviceFailure(error: unknown): DeviceFailureKind {
  if (error === null || error === undefined) {
    return "unknown";
  }

  if (typeof error !== "object") {
    return "unknown";
  }

  const record = error as Record<string, unknown>;

  // Evidence of a reply wins over any message text. A 401 whose body happens to
  // contain the word "network" is still a rejection.
  if (hasServerResponseEvidence(record)) {
    return "server_rejected";
  }

  const message = messageOf(record);

  if (message === "") {
    return "unknown";
  }

  for (const fragment of TRANSPORT_MESSAGE_FRAGMENTS) {
    if (message.includes(fragment)) {
      return "transport";
    }
  }

  return "unknown";
}

/** The one place that decides whether cached offline mode may be considered. */
export function permitsOfflineFallback(kind: DeviceFailureKind): boolean {
  return kind === "transport";
}

/**
 * A coarse hint, used ONLY to decide whether to retry sooner or to word a
 * message — never to grant access.
 *
 * navigator.onLine lies routinely: a captive portal reports online, and a
 * machine with a live NIC and no route reports online too. It is a hint and is
 * treated as one.
 */
export function readOnlineHint(
  navigatorLike: { onLine?: boolean } | null | undefined = globalThis.navigator
): boolean | null {
  if (!navigatorLike || typeof navigatorLike.onLine !== "boolean") {
    return null;
  }

  return navigatorLike.onLine;
}
