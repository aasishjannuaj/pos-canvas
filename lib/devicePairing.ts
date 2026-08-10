// Feature 16.3, Migration B — pure device-pairing domain logic.
//
// Dependency-free except node:crypto (same pattern as lib/buildJobs.hash.ts):
// no React, no Supabase, no "server-only" guard, so this stays unit-testable
// and importable from any server context. The Supabase access lives in
// lib/devicePairing.server.ts.
//
// SECURITY NOTE: a plaintext pairing code exists only inside this module's
// return value and the single HTTP response that carries it to the owner. It
// is never stored (only its SHA-256 digest reaches the database), never
// logged, and never persisted to browser storage or analytics.
import { createHash, randomInt } from "node:crypto";

// Crockford Base32: the standard 32-character alphabet with I, L, O and U
// removed. I/L/O are excluded because they are visually confusable with 1/1/0
// when an owner reads a code aloud to a store employee; U is excluded by the
// Crockford spec to avoid accidental profanity.
export const PAIRING_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const PAIRING_CODE_LENGTH = 8;

// 10 minutes. Informational only for UI countdowns: expiry is FIXED inside
// create_device_pairing_token (now() + interval '10 minutes') and is not a
// parameter, so this constant cannot influence the real lifetime.
export const PAIRING_TOKEN_TTL_SECONDS = 600;

export const PAIRING_MAX_ATTEMPTS = 5;

// Bounded retries when a freshly generated code's SHA-256 collides with an
// existing token_hash (the unique index spans every row, including expired and
// consumed ones). Three is ample at 2^40: it exists so a collision degrades
// into one more attempt rather than an opaque error, not because collisions
// are expected.
export const PAIRING_CODE_GENERATION_ATTEMPTS = 3;

// 8 characters from a 32-symbol alphabet is 32^8 = 2^40 (~1.1e12)
// possibilities inside a 10-minute window. Exported so a test can assert the
// entropy budget rather than leaving it as a claim in a comment.
export const PAIRING_CODE_ENTROPY_BITS = 40;

/**
 * Generates a cryptographically secure pairing code.
 *
 * Uses crypto.randomInt (a CSPRNG with rejection sampling) rather than
 * Math.random or a modulo of randomBytes, so the distribution over the
 * alphabet is uniform and unbiased.
 */
export function generatePairingCode(): string {
  let code = "";

  for (let i = 0; i < PAIRING_CODE_LENGTH; i += 1) {
    code += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
  }

  return code;
}

/**
 * Formats a raw code for display as XXXX-XXXX. The hyphen is presentation
 * only — normalizePairingCode strips it, so a user may type it either way.
 */
export function formatPairingCode(code: string): string {
  const normalized = normalizePairingCode(code);

  if (normalized.length !== PAIRING_CODE_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

/**
 * Canonicalizes a user-entered code before hashing.
 *
 * MUST stay byte-for-byte equivalent to the SQL in
 * redeem_device_pairing_token, which is:
 *
 *   translate(
 *     upper(regexp_replace(coalesce(p_code,''), '[^0-9A-Za-z]', '', 'g')),
 *     'ILO', '110'
 *   )
 *
 * The three steps, in this exact order:
 *   1. strip every non-alphanumeric character (hyphens, spaces, punctuation)
 *   2. uppercase
 *   3. fold the Crockford-ambiguous characters: I and L to 1, O to 0
 *
 * Order matters — folding before uppercasing would miss lowercase i/l/o.
 * lib/devicePairing.test.ts pins a shared vector so the two implementations
 * cannot drift apart silently.
 */
export function normalizePairingCode(code: string): string {
  return code
    .replace(/[^0-9A-Za-z]/g, "")
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

/**
 * SHA-256 of the normalized code, as raw bytes for a Postgres `bytea`.
 *
 * Matches the SQL side's `sha256(convert_to(<normalized>, 'UTF8'))`. Core
 * PostgreSQL functions are used there rather than pgcrypto's digest(), because
 * pgcrypto lives in the `extensions` schema on Supabase and would not resolve
 * under the pairing functions' locked `search_path`.
 */
export function hashPairingCode(code: string): Buffer {
  return createHash("sha256").update(normalizePairingCode(code), "utf8").digest();
}

/**
 * The same digest as a `\x`-prefixed hex string, which is how a bytea value is
 * passed through PostgREST's JSON boundary.
 */
export function hashPairingCodeForPostgrest(code: string): string {
  return `\\x${hashPairingCode(code).toString("hex")}`;
}

/**
 * Shape-checks a code before it is sent to the database. Rejects anything that
 * cannot possibly be a real code, so an obviously malformed entry never
 * becomes a redemption attempt.
 *
 * Deliberately validates the NORMALIZED form: a user may type lowercase, add
 * a hyphen, or type O for 0, and all are accepted.
 */
export function isValidPairingCodeShape(code: unknown): code is string {
  if (typeof code !== "string") {
    return false;
  }

  const normalized = normalizePairingCode(code);

  if (normalized.length !== PAIRING_CODE_LENGTH) {
    return false;
  }

  return [...normalized].every((char) => PAIRING_CODE_ALPHABET.includes(char));
}

// ============================================================================
// Browser-safe result types. None carries a token hash, a plaintext code
// (except the one-time creation result), an owner id, or any storage path.
// ============================================================================

export type CreatePairingTokenResult =
  | {
      ok: true;
      // Shown to the owner exactly once and never persisted anywhere.
      code: string;
      formattedCode: string;
      expiresAt: string;
      // Feature 16.4B — the token's own id, so the owner can cancel the code
      // they just created. create_device_pairing_token already returns it
      // (returns table (id uuid, expires_at timestamptz)); the wrapper simply
      // discarded it before. It is not secret — it identifies the caller's own
      // token, and cancel_device_pairing_token re-verifies ownership in SQL —
      // and it is NOT the code, the hash, or anything derived from either.
      tokenId: string;
    }
  | { ok: false; error: PairingErrorCode; message: string };

export type PairingErrorCode =
  | "not_authenticated"
  | "invalid_request"
  | "project_not_found"
  | "build_not_ready"
  | "unavailable";

const PAIRING_ERROR_MESSAGES: Record<PairingErrorCode, string> = {
  not_authenticated: "Please sign in again to pair a device.",
  invalid_request: "A valid project and build are required to pair a device.",
  project_not_found: "That project could not be found.",
  build_not_ready:
    "This build is not ready for pairing. Request a build and wait for it to finish.",
  unavailable: "A pairing code could not be created right now.",
};

export function getPairingErrorMessage(code: PairingErrorCode): string {
  return PAIRING_ERROR_MESSAGES[code];
}

export function createPairingFailure(
  code: PairingErrorCode
): Extract<CreatePairingTokenResult, { ok: false }> {
  return { ok: false, error: code, message: getPairingErrorMessage(code) };
}

// ============================================================================
// Device-side redemption result, mirroring redeem_device_pairing_token's jsonb.
// ============================================================================

export type RedeemPairingResult =
  | {
      ok: true;
      deviceId: string;
      projectId: string;
      buildJobId: string;
      alreadyPaired: boolean;
    }
  | { ok: false; error: RedeemErrorCode; message: string };

export type RedeemErrorCode =
  | "not_authenticated"
  | "not_anonymous"
  | "invalid_code"
  | "already_paired"
  | "unavailable";

// Every rejection an attacker can trigger by guessing collapses to the same
// message, so it cannot be used to distinguish "wrong" from "expired",
// "already used" or "locked".
const REDEEM_ERROR_MESSAGES: Record<RedeemErrorCode, string> = {
  not_authenticated: "This device is not signed in.",
  not_anonymous: "This device session cannot be paired.",
  invalid_code: "That pairing code is not valid.",
  already_paired: "This device is already paired.",
  unavailable: "Pairing is unavailable right now.",
};

export function getRedeemErrorMessage(code: RedeemErrorCode): string {
  return REDEEM_ERROR_MESSAGES[code];
}
