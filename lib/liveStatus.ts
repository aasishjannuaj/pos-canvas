// IND-1 — the live status indicator's decisions, as pure functions.
//
// TWO SEPARATE QUESTIONS, NEVER MERGED.
//
//   1. Connection: can this till reach POS Canvas right now? Answered by a
//      display-only read (get_device_pairing_state, see lib/serverReachability.ts)
//      plus the browser's network hint. A successful read proves the network,
//      the gateway, this device's sign-in and one database read worked. It says
//      NOTHING about whether any sale reached the database.
//
//   2. Sales: what does THIS device still hold? Answered only by the existing
//      saved-sale status (lib/offlineSaleStatus.ts). The connection result never
//      feeds it, so a green connection can never make "No pending sales" appear.
//
// DISPLAY ONLY. Nothing in this module is read by checkout authority, offline
// entry, reconnect, sync, retries, pairing or employee sessions. It holds no
// clock, no timer and no I/O; callers pass `now`.
import { parsePairingState } from "@/lib/deviceSession";
import type { OfflineSaleStatus } from "@/lib/offlineSaleStatus";

// ---------------------------------------------------------------------------
// Policy (Control Room IND-1)
// ---------------------------------------------------------------------------

/** A healthy till checks no more often than this. */
export const LIVE_CHECK_INTERVAL_MS = 5_000;

/** Each check is cancelled (fetch aborted) after this long. */
export const LIVE_CHECK_TIMEOUT_MS = 4_000;

/**
 * Minimum gap between the START of any two checks, whatever triggered them.
 * Equal to the healthy interval, so no mix of events can exceed one request per
 * five seconds.
 */
export const LIVE_CHECK_MIN_SPACING_MS = 5_000;

/** Consecutive-failure backoff: 5s, 10s, 20s, then 30s forever. */
export const LIVE_CHECK_FAILURE_BACKOFF_MS: readonly number[] = [5_000, 10_000, 20_000, 30_000];

/** A success older than this no longer supports "Online". */
export const LIVE_SUCCESS_FRESH_MS = 15_000;

/** How long to wait before the next check after `consecutiveFailures` failures (1-based). */
export function nextFailureDelayMs(consecutiveFailures: number): number {
  if (!Number.isFinite(consecutiveFailures) || consecutiveFailures < 1) {
    return LIVE_CHECK_FAILURE_BACKOFF_MS[0];
  }

  const index = Math.min(Math.trunc(consecutiveFailures), LIVE_CHECK_FAILURE_BACKOFF_MS.length) - 1;

  return LIVE_CHECK_FAILURE_BACKOFF_MS[index];
}

// ---------------------------------------------------------------------------
// Classifying one check
// ---------------------------------------------------------------------------

/** What the read helper observed, before any interpretation. */
export type ReachabilityProbeResult =
  | {
      type: "response";
      status: number;
      /** The response body; null when the server returned an error. */
      data: unknown;
      errorCode: string | null;
    }
  /** The request never produced an HTTP response (no network, DNS, refused, reset). */
  | { type: "transport" }
  /** Our own timeout aborted it. */
  | { type: "timeout" }
  /** Cancelled by cleanup, hide or a newer event. Never displayed. */
  | { type: "aborted" };

export type ReachabilityOutcome =
  | "reachable"
  | "no_network"
  | "unreachable"
  | "server_error"
  | "sign_in_problem"
  | "device_problem";

/** PostgREST codes that mean the caller's credentials were refused. */
const AUTH_ERROR_CODES = new Set(["PGRST301", "PGRST302", "PGRST303", "42501"]);

/**
 * Interprets one check. `aborted` has no outcome (null): a cancelled check is not
 * evidence of anything.
 *
 * ONLY ONE PATH RETURNS "reachable": a 2xx response with no error whose body
 * parses as THIS device, paired and active. Anything malformed, unexpected or
 * for another device is a failure of some kind — never Online.
 */
export function classifyReachability(
  result: ReachabilityProbeResult,
  context: { onlineHint: boolean | null; expectedDeviceId: string }
): ReachabilityOutcome | null {
  if (result.type === "aborted") {
    return null;
  }

  if (result.type === "transport" || result.type === "timeout") {
    return context.onlineHint === false ? "no_network" : "unreachable";
  }

  const { status, data, errorCode } = result;

  if (!Number.isInteger(status) || status === 0) {
    // postgrest-js reports a fetch that never got a response as status 0.
    return context.onlineHint === false ? "no_network" : "unreachable";
  }

  if (status === 401 || status === 403 || (errorCode !== null && AUTH_ERROR_CODES.has(errorCode))) {
    return "sign_in_problem";
  }

  if (status >= 500) {
    return "server_error";
  }

  if (status < 200 || status >= 300 || errorCode !== null) {
    return "server_error";
  }

  const state = parsePairingState(data);

  if (state.paired === false) {
    if (state.reason === "not_authenticated") {
      return "sign_in_problem";
    }

    if (state.reason === "unreadable") {
      return "server_error";
    }

    return "device_problem";
  }

  if (!state.active || state.pairing.deviceId !== context.expectedDeviceId) {
    return "device_problem";
  }

  return "reachable";
}

// ---------------------------------------------------------------------------
// Connection label
// ---------------------------------------------------------------------------

export type LiveEvidence = {
  outcome: ReachabilityOutcome;
  /** When this evidence was obtained (ms since epoch). */
  at: number;
};

export type ConnectionLabel =
  | "Checking"
  | "Online"
  | "Offline"
  | "Server error"
  | "Sign-in problem"
  | "Device problem";

export type ConnectionTone = "neutral" | "ok" | "warn" | "bad";

export type ConnectionView = {
  label: ConnectionLabel;
  detail: string;
  tone: ConnectionTone;
};

export type ConnectionInput = {
  now: number;
  /** The latest CURRENT evidence (since startup/resume/pairing change), or null. */
  evidence: LiveEvidence | null;
  /** The device's own runtime mode. Display input only; never changed here. */
  runtimeMode: "online" | "offline";
};

const FAILURE_VIEWS: Record<Exclude<ReachabilityOutcome, "reachable">, ConnectionView> = {
  no_network: { label: "Offline", detail: "No network", tone: "bad" },
  unreachable: { label: "Offline", detail: "Server unreachable", tone: "bad" },
  server_error: { label: "Server error", detail: "POS Canvas is not responding normally", tone: "bad" },
  sign_in_problem: { label: "Sign-in problem", detail: "This till's sign-in was refused", tone: "warn" },
  device_problem: { label: "Device problem", detail: "This till is not recognised as active", tone: "warn" },
};

const CHECKING: ConnectionView = { label: "Checking", detail: "Checking connection…", tone: "neutral" };

/**
 * The connection label, first match wins:
 *   1. no current evidence            -> Checking (startup, resume, new pairing)
 *   2. latest evidence is a failure   -> that failure, however old (a known
 *                                         failure beats a stale-success Checking)
 *   3. success older than 15s         -> Checking
 *   4. fresh success, device offline  -> Checking ("reconnecting"): the server
 *                                         answered but the till has not yet
 *                                         returned online through its own path
 *   5. fresh success, device online   -> Online
 */
export function deriveConnectionView(input: ConnectionInput): ConnectionView {
  const { evidence, now } = input;

  if (evidence === null) {
    return CHECKING;
  }

  if (evidence.outcome !== "reachable") {
    return FAILURE_VIEWS[evidence.outcome];
  }

  if (now - evidence.at > LIVE_SUCCESS_FRESH_MS) {
    return CHECKING;
  }

  if (input.runtimeMode === "offline") {
    return { label: "Checking", detail: "Server reachable — reconnecting", tone: "neutral" };
  }

  return { label: "Online", detail: "Connected", tone: "ok" };
}

/**
 * When the connection label could next change WITHOUT new evidence: the moment a
 * fresh success goes stale. A host sets one timer for this instant and re-renders;
 * it makes no request. Null when nothing can expire.
 */
export function nextConnectionExpiryAt(evidence: LiveEvidence | null): number | null {
  if (evidence === null || evidence.outcome !== "reachable") {
    return null;
  }

  return evidence.at + LIVE_SUCCESS_FRESH_MS + 1;
}

// ---------------------------------------------------------------------------
// Sales label
// ---------------------------------------------------------------------------

export type SalesLabelKind =
  | "checking"
  | "unreadable"
  | "unconfirmed"
  | "attention"
  | "syncing"
  | "waiting"
  | "none";

export type SalesView = {
  kind: SalesLabelKind;
  label: string;
  tone: ConnectionTone;
};

function pluralSales(count: number): string {
  return count === 1 ? "1 sale" : `${count} sales`;
}

/**
 * The saved-sale label, first match wins. "No pending sales" is reachable ONLY
 * when the store was read, nothing is unsynced, nothing needs attention and no
 * online sale is unresolved. It describes this device's records, not the books.
 *
 * "Sale unconfirmed" never claims recovery is running: the header has no
 * recovery-in-progress signal, so it states the fact and nothing more.
 */
export function deriveSalesView(input: {
  status: OfflineSaleStatus;
  /** False until the first saved-sale read has returned. */
  loaded: boolean;
  syncing: boolean;
}): SalesView {
  const { status, loaded, syncing } = input;

  if (!loaded) {
    return { kind: "checking", label: "Checking sales", tone: "neutral" };
  }

  if (status.evidenceReadable !== true) {
    return { kind: "unreadable", label: "Can't check sales", tone: "bad" };
  }

  if (status.uncertainOnlineSale) {
    return { kind: "unconfirmed", label: "Sale unconfirmed", tone: "bad" };
  }

  if (status.needsAttention > 0) {
    return { kind: "attention", label: "Needs attention", tone: "bad" };
  }

  if (syncing) {
    return { kind: "syncing", label: "Syncing", tone: "neutral" };
  }

  if (status.waiting > 0 || status.unsynced > 0) {
    return {
      kind: "waiting",
      label: `${pluralSales(Math.max(status.waiting, status.unsynced))} waiting`,
      tone: "warn",
    };
  }

  return { kind: "none", label: "No pending sales", tone: "ok" };
}
