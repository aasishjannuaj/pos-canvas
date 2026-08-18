// Feature 24.5A — the durable offline cache's PURE core.
//
// WHAT THIS MODULE IS: every rule that decides whether a locally cached
// configuration may be trusted, expressed as functions with no IndexedDB, no
// React and no Supabase. lib/deviceOfflineStore.ts does the storage I/O and
// nothing else; this file does the thinking and is exercised end to end under
// plain Node.
//
// THE PROPERTY EVERY RULE HERE PROTECTS: a till may reopen from cache ONLY when
// the cache provably belongs to the device holding it, provably has not been
// altered, and was provably verified by the server recently enough. Any doubt
// resolves to "reconnect required" — see docs/OFFLINE_ARCHITECTURE.md §4.
//
// WHAT IS DELIBERATELY NOT HERE, and belongs to 24.5B-F: no sale, no queue, no
// idempotency key persistence, no receipt, no inventory. 24.5A caches a
// configuration and opens it read-only.
import { isGeneratedPosConfig } from "@/lib/generatedPosConfig";
import type { GeneratedPosConfig } from "@/lib/generatedPosConfig";

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/**
 * The version of THIS cache's envelope — the record shapes below.
 *
 * Deliberately separate from GENERATED_POS_CONFIG_SCHEMA_VERSION, which
 * versions the configuration's own data contract. The two change for unrelated
 * reasons: adding a field to CachedPairingAssertion has nothing to do with the
 * menu format. A record written by a newer envelope is DISCARDED rather than
 * read optimistically, exactly as isGeneratedPosConfig treats an unknown
 * config version.
 */
export const OFFLINE_CACHE_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// The lease
// ---------------------------------------------------------------------------

/**
 * How long a device may reopen offline after its last authoritative contact.
 *
 * SEVEN DAYS, approved by the owner at the Feature 24.4 review. The tradeoff is
 * recorded in docs/OFFLINE_ARCHITECTURE.md §4.3: no lease lets a stolen till
 * take cash indefinitely, while an hours-long lease bricks a real shop during a
 * genuine outage — the likelier and worse failure. Seven days covers a long
 * holiday weekend plus a slow repair.
 *
 * ONE named constant on purpose, so revisiting the number is a one-line change.
 */
export const OFFLINE_DEVICE_LEASE_MS = 7 * 24 * 60 * 60 * 1000;

/** How close to expiry the operator starts being told to reconnect. */
export const OFFLINE_LEASE_WARNING_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** Object-store keys. Explicit constants so a typo cannot silently miss a record. */
export const PAIRING_ASSERTION_KEY = "pairing-assertion" as const;
export const PINNED_CONFIG_KEY = "pinned-config" as const;

/**
 * The last time the SERVER confirmed this device is paired and not revoked.
 *
 * Written only after a successful authoritative `get_device_pairing_state`.
 * Never written from cache, and never refreshed by an offline reopen — the
 * lease measures time since the server last vouched for the device, so
 * extending it locally would defeat its only purpose.
 */
export type CachedPairingAssertion = {
  cacheSchemaVersion: number;
  deviceAuthUserId: string;
  /** The paired_devices row id, so an offline reopen rebuilds a REAL pairing
   *  rather than a synthesized one with a placeholder identifier. */
  deviceId: string;
  projectId: string;
  buildJobId: string;
  deviceName: string | null;
  platform: string | null;
  /**
   * ISO-8601, currently the CLIENT's receipt time.
   *
   * HONEST LIMITATION, recorded rather than hidden: `get_device_pairing_state`
   * returns no server timestamp today, so this is when the browser observed a
   * successful authoritative response — not when the server produced it. A
   * device with a badly wrong clock therefore gets a badly measured lease. That
   * is acceptable for 24.5A because the failure is bounded and fail-safe in the
   * direction that matters (a fast clock SHORTENS the lease), and because
   * lengthening it requires a device to hold a valid session while lying about
   * time, which buys an attacker with physical possession nothing they did not
   * already have.
   *
   * 24.5B adds a server-issued verification time along with `occurred_at`
   * (docs/OFFLINE_ARCHITECTURE.md §6.1 and §12); this field becomes
   * server-sourced then, and evaluateLease already refuses nonsense values.
   */
  lastVerifiedAt: string;
};

/** The immutable pinned snapshot, plus what proves it is unaltered and ours. */
export type CachedPinnedConfig = {
  cacheSchemaVersion: number;
  configSchemaVersion: number;
  deviceAuthUserId: string;
  projectId: string;
  buildJobId: string;
  configSnapshot: GeneratedPosConfig;
  /** Lowercase hex SHA-256 of canonicalize(configSnapshot). */
  integrity: string;
  fetchedAt: string;
  lastVerifiedAt: string;
};

/** The identity a cached record must match to be usable. */
export type DeviceCacheIdentity = {
  deviceAuthUserId: string;
  projectId: string;
  buildJobId: string;
};

// ---------------------------------------------------------------------------
// Canonicalization + digest
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON: object keys sorted recursively, arrays left in order.
 *
 * WHY NOT JSON.stringify ALONE: property order in JavaScript objects follows
 * insertion, so the same configuration parsed from two different responses can
 * serialize to two different strings and produce two different digests. The
 * cache would then reject a perfectly good snapshot. Array order is meaningful
 * (menu ordering) and is preserved.
 *
 * `undefined` members are dropped, matching JSON.stringify, so a snapshot that
 * round-trips through storage digests identically to the one that was fetched.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  const source = value as Record<string, unknown>;

  return Object.keys(source)
    .sort()
    .reduce<Record<string, unknown>>((accumulator, key) => {
      if (source[key] !== undefined) {
        accumulator[key] = sortValue(source[key]);
      }

      return accumulator;
    }, {});
}

/**
 * SHA-256 of a canonicalized value, lowercase hex.
 *
 * Uses Web Crypto, which both shells have: the Android WebView and Electron's
 * Chromium both serve the runtime over https, and SubtleCrypto requires a
 * secure context. Node 18+ exposes the identical API, so this is testable
 * without a browser.
 *
 * This is an INTEGRITY check, not a security control. It detects a truncated
 * write, a partially-applied upgrade or a corrupted record — the realistic
 * failures. It does not stop someone with developer tools from rewriting both
 * the snapshot and its digest, and it is not claimed to: what makes that
 * pointless is that a device never prices a sale itself (§7 of the design).
 */
export async function digestConfig(
  value: unknown,
  // `null` is accepted as well as `undefined` so a caller can say "there is no
  // Web Crypto here" explicitly. A default parameter only fires on `undefined`,
  // so without this the absence could not be expressed or tested at all.
  subtle: SubtleCrypto | null | undefined = globalThis.crypto?.subtle
): Promise<string | null> {
  if (!subtle || typeof subtle.digest !== "function") {
    return null;
  }

  try {
    const bytes = new TextEncoder().encode(canonicalize(value));
    const hash = await subtle.digest("SHA-256", bytes);

    return Array.from(new Uint8Array(hash))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** Parses an ISO timestamp, returning null for anything not a finite instant. */
export function parseIsoTime(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const parsed = Date.parse(value);

  return Number.isFinite(parsed) ? parsed : null;
}

export type LeaseEvaluation =
  | { ok: true; expiresAt: number; remainingMs: number; expiringSoon: boolean }
  | { ok: false; reason: "missing" | "unparseable" | "expired" | "future" };

/**
 * Decides whether a lease is still valid, conservatively.
 *
 * THE CLOCK CASES ARE THE POINT. A till's clock can be wrong by years after a
 * dead battery, and it is the same clock that wrote `lastVerifiedAt`:
 *
 *   * unparseable / missing  -> refuse. Nothing is known, so nothing is granted.
 *   * meaningfully in the FUTURE -> refuse. Either the clock moved backwards
 *     since the write, or the record was tampered with to extend the lease.
 *     Both are reasons to require a reconnect, not to trust it.
 *   * older than the lease   -> refuse.
 *
 * A small tolerance absorbs ordinary skew and NTP corrections so a device does
 * not lock itself out over a few seconds.
 */
export const OFFLINE_CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

export function evaluateLease(
  lastVerifiedAt: unknown,
  now: number,
  leaseMs: number = OFFLINE_DEVICE_LEASE_MS
): LeaseEvaluation {
  const verified = parseIsoTime(lastVerifiedAt);

  if (verified === null) {
    return { ok: false, reason: typeof lastVerifiedAt === "string" ? "unparseable" : "missing" };
  }

  if (!Number.isFinite(now)) {
    return { ok: false, reason: "unparseable" };
  }

  if (verified > now + OFFLINE_CLOCK_TOLERANCE_MS) {
    return { ok: false, reason: "future" };
  }

  const expiresAt = verified + leaseMs;

  if (now > expiresAt) {
    return { ok: false, reason: "expired" };
  }

  const remainingMs = expiresAt - now;

  return {
    ok: true,
    expiresAt,
    remainingMs,
    expiringSoon: remainingMs <= OFFLINE_LEASE_WARNING_MS,
  };
}

// ---------------------------------------------------------------------------
// Building records
// ---------------------------------------------------------------------------

export function buildPairingAssertion(input: {
  deviceAuthUserId: string;
  deviceId: string;
  projectId: string;
  buildJobId: string;
  deviceName: string | null;
  platform: string | null;
  verifiedAt: string;
}): CachedPairingAssertion {
  return {
    cacheSchemaVersion: OFFLINE_CACHE_SCHEMA_VERSION,
    deviceAuthUserId: input.deviceAuthUserId,
    deviceId: input.deviceId,
    projectId: input.projectId,
    buildJobId: input.buildJobId,
    deviceName: input.deviceName,
    platform: input.platform,
    lastVerifiedAt: input.verifiedAt,
  };
}

export async function buildPinnedConfigRecord(input: {
  deviceAuthUserId: string;
  projectId: string;
  buildJobId: string;
  config: GeneratedPosConfig;
  verifiedAt: string;
}): Promise<CachedPinnedConfig | null> {
  const integrity = await digestConfig(input.config);

  // No digest means no record. A snapshot stored without one could never be
  // validated on read, so writing it would create a cache that is guaranteed to
  // be rejected later — worse than having none, because it looks like progress.
  if (integrity === null) {
    return null;
  }

  return {
    cacheSchemaVersion: OFFLINE_CACHE_SCHEMA_VERSION,
    configSchemaVersion: input.config.schemaVersion,
    deviceAuthUserId: input.deviceAuthUserId,
    projectId: input.projectId,
    buildJobId: input.buildJobId,
    configSnapshot: input.config,
    integrity,
    fetchedAt: input.verifiedAt,
    lastVerifiedAt: input.verifiedAt,
  };
}

// ---------------------------------------------------------------------------
// Reading records back
// ---------------------------------------------------------------------------

export type AssertionReadFailure =
  | "missing"
  | "malformed"
  | "unsupported_schema"
  | "identity_mismatch";

export type AssertionReadResult =
  | { ok: true; assertion: CachedPairingAssertion }
  | { ok: false; reason: AssertionReadFailure };

/**
 * Validates a stored assertion against the CURRENT device identity.
 *
 * The auth-user check is what stops one business's cache surfacing on a device
 * that has since been re-paired to another: a re-pair produces a new anonymous
 * user, so a stale record can never match. `expected` is deliberately optional
 * only for the auth user — at the point this runs the pairing identity is
 * exactly what we do not yet know, and it is the assertion that supplies it.
 */
export function readPairingAssertion(
  value: unknown,
  expectedAuthUserId: string
): AssertionReadResult {
  if (value === null || value === undefined) {
    return { ok: false, reason: "missing" };
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "malformed" };
  }

  const raw = value as Record<string, unknown>;

  if (raw.cacheSchemaVersion !== OFFLINE_CACHE_SCHEMA_VERSION) {
    return { ok: false, reason: "unsupported_schema" };
  }

  const deviceAuthUserId = readNonEmptyString(raw.deviceAuthUserId);
  const deviceId = readNonEmptyString(raw.deviceId);
  const projectId = readNonEmptyString(raw.projectId);
  const buildJobId = readNonEmptyString(raw.buildJobId);
  const lastVerifiedAt = readNonEmptyString(raw.lastVerifiedAt);

  if (
    deviceAuthUserId === null ||
    deviceId === null ||
    projectId === null ||
    buildJobId === null ||
    lastVerifiedAt === null
  ) {
    return { ok: false, reason: "malformed" };
  }

  if (deviceAuthUserId !== expectedAuthUserId) {
    return { ok: false, reason: "identity_mismatch" };
  }

  return {
    ok: true,
    assertion: {
      cacheSchemaVersion: OFFLINE_CACHE_SCHEMA_VERSION,
      deviceAuthUserId,
      deviceId,
      projectId,
      buildJobId,
      deviceName: readNullableString(raw.deviceName),
      platform: readNullableString(raw.platform),
      lastVerifiedAt,
    },
  };
}

export type ConfigReadFailure =
  | "missing"
  | "malformed"
  | "unsupported_schema"
  | "identity_mismatch"
  | "integrity_mismatch"
  | "invalid_config";

export type ConfigReadResult =
  | { ok: true; record: CachedPinnedConfig }
  | { ok: false; reason: ConfigReadFailure };

/**
 * Validates a stored config record. Every check must pass; there is no partial
 * acceptance, because a POS with a half-understood price list must not open —
 * the same rule parseDeviceConfig already applies to a server response.
 *
 * Order matters: cheap structural checks first, the digest last, so a malformed
 * record does not pay for a hash it was never going to match.
 */
export async function readPinnedConfig(
  value: unknown,
  expected: DeviceCacheIdentity
): Promise<ConfigReadResult> {
  if (value === null || value === undefined) {
    return { ok: false, reason: "missing" };
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "malformed" };
  }

  const raw = value as Record<string, unknown>;

  if (raw.cacheSchemaVersion !== OFFLINE_CACHE_SCHEMA_VERSION) {
    return { ok: false, reason: "unsupported_schema" };
  }

  const deviceAuthUserId = readNonEmptyString(raw.deviceAuthUserId);
  const projectId = readNonEmptyString(raw.projectId);
  const buildJobId = readNonEmptyString(raw.buildJobId);
  const integrity = readNonEmptyString(raw.integrity);
  const fetchedAt = readNonEmptyString(raw.fetchedAt);
  const lastVerifiedAt = readNonEmptyString(raw.lastVerifiedAt);

  if (
    deviceAuthUserId === null ||
    projectId === null ||
    buildJobId === null ||
    integrity === null ||
    fetchedAt === null ||
    lastVerifiedAt === null
  ) {
    return { ok: false, reason: "malformed" };
  }

  if (
    deviceAuthUserId !== expected.deviceAuthUserId ||
    projectId !== expected.projectId ||
    buildJobId !== expected.buildJobId
  ) {
    return { ok: false, reason: "identity_mismatch" };
  }

  // Never trust stored JSON as a configuration. This is the SAME validator the
  // owner runtime and parseDeviceConfig use, so a cached snapshot has to clear
  // exactly the bar a freshly fetched one does.
  if (!isGeneratedPosConfig(raw.configSnapshot)) {
    return { ok: false, reason: "invalid_config" };
  }

  if (raw.configSchemaVersion !== raw.configSnapshot.schemaVersion) {
    return { ok: false, reason: "malformed" };
  }

  const recomputed = await digestConfig(raw.configSnapshot);

  if (recomputed === null || recomputed !== integrity) {
    return { ok: false, reason: "integrity_mismatch" };
  }

  return {
    ok: true,
    record: {
      cacheSchemaVersion: OFFLINE_CACHE_SCHEMA_VERSION,
      configSchemaVersion: raw.configSnapshot.schemaVersion,
      deviceAuthUserId,
      projectId,
      buildJobId,
      configSnapshot: raw.configSnapshot,
      integrity,
      fetchedAt,
      lastVerifiedAt,
    },
  };
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
