import { createClient } from "./client";
import { createAuthCallbackUrl } from "@/lib/siteOrigin";

export async function signUp(email: string, password: string) {
  const supabase = createClient();
  const { data, error } = await supabase.auth.signUp({ email, password });
  return { data, error };
}

export async function signIn(email: string, password: string) {
  const supabase = createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  return { data, error };
}

export async function signOut() {
  const supabase = createClient();
  const { error } = await supabase.auth.signOut();
  return { error };
}

// ---------------------------------------------------------------------------
// Feature 22 Phase 1 — password recovery
// ---------------------------------------------------------------------------

/** The only destination a recovery callback may resolve to. */
export const PASSWORD_RESET_PATH = "/reset-password";

/**
 * Sends a password-recovery email.
 *
 * TWO THINGS ARE DELIBERATE HERE.
 *
 * 1. The redirect target comes from lib/siteOrigin.ts's allow-list, not from
 *    window.location.origin directly. The browser's origin is offered as a
 *    CANDIDATE and is used only if it is one of the two known origins;
 *    anything else falls back to production. See that module for why.
 *
 * 2. The caller is not told whether the address exists. This function returns
 *    the raw result for logging-free internal use, but every UI caller must
 *    render the same neutral message regardless — see
 *    PASSWORD_RESET_REQUEST_RESULT in lib/authErrors.ts. A reset form that
 *    behaves differently for known and unknown addresses is an account-
 *    enumeration oracle.
 *
 * Called from the BROWSER client on purpose: @supabase/ssr stores the PKCE code
 * verifier in a cookie, which is what lets the server-side callback route
 * exchange the returned code for a session.
 */
export async function requestPasswordReset(email: string) {
  const supabase = createClient();

  const redirectTo = createAuthCallbackUrl({
    origin: typeof window === "undefined" ? null : window.location.origin,
    next: PASSWORD_RESET_PATH,
  });

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo,
  });

  return { error };
}

/**
 * Sets a new password for the CURRENT session.
 *
 * Requires an active recovery session, established by the callback route's code
 * exchange. Supabase rejects the call otherwise, and the reset page checks for a
 * session before rendering the form at all — so a dead form is never shown.
 */
export async function updatePassword(password: string) {
  const supabase = createClient();
  const { error } = await supabase.auth.updateUser({ password });
  return { error };
}

/** Whether a usable session exists right now (used by the reset page). */
export async function getCurrentSession() {
  const supabase = createClient();
  const { data, error } = await supabase.auth.getSession();
  return { session: data.session, error };
}
