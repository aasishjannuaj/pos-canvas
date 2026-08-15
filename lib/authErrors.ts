// Feature 22 Phase 1 — customer-facing auth copy.
//
// Before this, /login and /signup rendered `error.message` straight from
// Supabase. Those strings are the provider's, not the product's: they vary
// between GoTrue versions, use inconsistent capitalisation, and occasionally
// name internals ("AuthApiError", "invalid_grant", a status code). This module
// is the single translation point.
//
// WHAT NEVER REACHES A CUSTOMER: the words Supabase or GoTrue, a provider error
// code, an HTTP status, a stack-like string, or a raw message this module does
// not recognise. An unrecognised failure collapses to one generic sentence
// rather than being passed through, because a message nobody wrote is a message
// nobody has checked for leakage.
//
// Dependency-free (no React, no Supabase import) so the mapping is
// unit-testable and identical on every auth surface.

export type AuthErrorContext = "sign_in" | "sign_up" | "update_password";

/** Everything a caller may hand us: Supabase returns an object, not a string. */
type UnknownAuthError = {
  message?: unknown;
  code?: unknown;
  status?: unknown;
} | null | undefined;

export const AUTH_ERROR_MESSAGES = {
  invalidCredentials: "The email or password is incorrect.",
  emailAlreadyRegistered:
    "An account already exists with this email. Try signing in instead.",
  weakPassword: "Your password does not meet the minimum requirements.",
  rateLimited: "Too many attempts. Please wait a moment and try again.",
  invalidEmail: "Enter a valid email address.",
  sessionExpired:
    "This password reset link has expired or has already been used.",
  unknown: "Something went wrong. Please try again.",
} as const;

/**
 * Supabase's minimum. Mirrored here so the client can say so BEFORE a round
 * trip; the server remains the authority and will reject independently.
 *
 * Kept at 6 to match the Supabase default rather than inventing a stricter
 * rule this product does not otherwise enforce.
 */
export const MIN_PASSWORD_LENGTH = 6;

function readText(error: UnknownAuthError): string {
  if (!error || typeof error !== "object") {
    return "";
  }

  const parts = [error.message, error.code].filter(
    (part): part is string => typeof part === "string"
  );

  return parts.join(" ").toLowerCase();
}

function readStatus(error: UnknownAuthError): number | null {
  return error && typeof error.status === "number" ? error.status : null;
}

/**
 * Maps a provider error to product copy.
 *
 * Matching is on lowercase substrings rather than exact codes because GoTrue
 * has changed both its codes and its wording across versions; substrings of the
 * stable, human-meaningful part survive that. Anything unmatched returns the
 * generic message — never the original text.
 */
export function getAuthErrorMessage(
  error: UnknownAuthError,
  context: AuthErrorContext
): string {
  const text = readText(error);
  const status = readStatus(error);

  // Rate limiting is checked first: it can occur in every context and its
  // remedy (wait) differs from every other message's remedy.
  if (status === 429 || text.includes("rate limit") || text.includes("too many")) {
    return AUTH_ERROR_MESSAGES.rateLimited;
  }

  if (text.includes("already registered") || text.includes("already exists")) {
    return AUTH_ERROR_MESSAGES.emailAlreadyRegistered;
  }

  if (
    text.includes("password should be") ||
    text.includes("weak password") ||
    text.includes("password is too short") ||
    text.includes("minimum length")
  ) {
    return AUTH_ERROR_MESSAGES.weakPassword;
  }

  if (text.includes("invalid email") || text.includes("unable to validate email")) {
    return AUTH_ERROR_MESSAGES.invalidEmail;
  }

  if (
    text.includes("invalid login credentials") ||
    text.includes("invalid credentials") ||
    text.includes("invalid_grant")
  ) {
    return AUTH_ERROR_MESSAGES.invalidCredentials;
  }

  if (
    context === "update_password" &&
    (text.includes("session") || text.includes("jwt") || status === 401)
  ) {
    return AUTH_ERROR_MESSAGES.sessionExpired;
  }

  // A sign-in failure with no recognised marker is overwhelmingly a wrong
  // password; saying so is more useful than "something went wrong" and reveals
  // nothing an attacker could not already test directly.
  if (context === "sign_in" && status === 400) {
    return AUTH_ERROR_MESSAGES.invalidCredentials;
  }

  return AUTH_ERROR_MESSAGES.unknown;
}

/**
 * Client-side password validation, shared by the reset form.
 *
 * Returns product copy or null. The server still enforces its own rule; this
 * exists so an obviously-too-short password is refused without a round trip.
 */
export function validateNewPassword(
  password: string,
  confirmation: string
): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Your password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }

  if (password !== confirmation) {
    return "Both passwords must match.";
  }

  return null;
}

/**
 * The one response a reset REQUEST may ever produce.
 *
 * Deliberately identical whether the address has an account, has no account, or
 * the request failed outright. Any branch here would turn this form into an
 * account-existence oracle, which is the specific attack a reset form invites.
 */
export const PASSWORD_RESET_REQUEST_RESULT =
  "If an account exists for that email, we've sent a password reset link.";
