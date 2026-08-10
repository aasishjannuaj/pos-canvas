// Feature 16.4A — the paired device's OWN Supabase browser client.
//
// WHY THIS FILE EXISTS AT ALL, AND WHY IT MUST NOT BE lib/supabase/client.ts:
//
// lib/supabase/client.ts uses @supabase/ssr's createBrowserClient, whose
// storage adapter is COOKIE-backed (createStorageFromOptions in
// @supabase/ssr/dist/main/createBrowserClient.js). That cookie is the very
// same session lib/supabase/server.ts and proxy.ts read. Calling
// signInAnonymously() on that client would therefore OVERWRITE the owner's
// session cookie and silently sign them out of their own browser — an owner
// opening /device on their laptop would lose their Builder session.
//
// This client is deliberately built on @supabase/supabase-js directly, with
// its own localStorage namespace, so an anonymous device session and an
// owner cookie session can coexist in one browser profile and never touch
// each other. Nothing here reads or writes a cookie.
//
// CREDENTIALS: the public URL + anon key only. SUPABASE_SERVICE_ROLE_KEY is
// never referenced — it is server-only and would be a catastrophic leak in a
// browser bundle. Every device capability is granted to `authenticated` in
// SQL and constrained by RLS plus the pairing RPCs' own auth.uid() checks.
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The device session's localStorage key.
 *
 * MUST differ from the owner cookie name. lib/deviceSession.test.ts asserts
 * they are distinct, because a collision would reintroduce exactly the
 * session-clobbering bug this whole module exists to prevent.
 */
export const DEVICE_AUTH_STORAGE_KEY = "pos-canvas-device-auth";

let cachedClient: SupabaseClient | null = null;

/**
 * Returns the device client, creating it once per browser session.
 *
 * Cached deliberately: a second GoTrueClient on the same storage key would
 * race the first over token refresh. Safe under Next.js client rendering
 * because it is only ever called from an effect/event handler in a
 * "use client" component, never during a server render.
 */
export function getDeviceSupabaseClient(): SupabaseClient {
  if (cachedClient !== null) {
    return cachedClient;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Missing Supabase environment variables.");
  }

  cachedClient = createSupabaseClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      // The anonymous session is the ONLY thing this feature persists. The
      // pinned config is deliberately never written to storage — see
      // lib/deviceSession.ts — because a cached config would let a revoked
      // device keep rendering a working POS.
      persistSession: true,
      autoRefreshToken: true,
      // No OAuth/magic-link flow reaches this route, and leaving this on
      // would make the client parse fragments out of arbitrary URLs.
      detectSessionInUrl: false,
      storageKey: DEVICE_AUTH_STORAGE_KEY,
    },
  });

  return cachedClient;
}

/**
 * Drops the cached client. Used by the reset flow so the next call builds a
 * fresh GoTrueClient rather than reusing one holding a signed-out session.
 * Exported for tests; not part of the normal device flow.
 */
export function resetDeviceSupabaseClientCache(): void {
  cachedClient = null;
}
