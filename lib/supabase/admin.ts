import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getAdminSupabaseConfig } from "@/lib/supabase/adminConfig";

// Feature 15.3 correction — the first privileged Supabase credential this
// app has ever used. Every other client in this codebase
// (lib/supabase/client.ts, lib/supabase/server.ts) is backed by the public
// anon key and is therefore subject to the exact same RLS policies as any
// authenticated browser session — including, previously, an authenticated
// INSERT policy on build_jobs, which meant a browser could bypass
// createBuildJob entirely and insert a row with a fabricated
// config_snapshot/status/timestamps/failure fields of its own choosing.
// That policy has been dropped by a corrective migration
// (supabase/migrations/ — see the one after the original Feature 15.2
// migration); build_jobs now has no browser-facing INSERT path at all.
//
// This client uses the service-role key instead, which bypasses RLS
// entirely by Supabase's own design. That makes it a privileged
// credential, not a convenience shortcut:
//
//   - It must only ever be created AFTER a caller has already
//     independently authenticated the requesting user (via the normal
//     cookie-based server client, lib/supabase/server.ts) and validated
//     their ownership of whatever they're about to touch.
//   - Every query issued through this client must explicitly filter by
//     that already-validated owner_id/project_id itself — there is no RLS
//     safety net to fall back on once this client is in use. See
//     lib/buildJobs.server.ts's createBuildJob for the reference flow.
//
// SUPABASE_SERVICE_ROLE_KEY must be set in the server's own environment
// (e.g. .env.local for local development — this repo's .env* files are
// already gitignored) and must never be prefixed with NEXT_PUBLIC_, which
// would bundle it into client-side JavaScript. Get it from the Supabase
// dashboard: Project Settings -> API (or "API Keys" in newer dashboards)
// -> the service_role / secret key, distinct from the anon/public key
// already used by NEXT_PUBLIC_SUPABASE_ANON_KEY. Never commit the real
// value anywhere in this repository.
export function createAdminClient() {
  // Feature 15.5 — env validation itself now lives in
  // lib/supabase/adminConfig.ts (no "server-only" import, no client
  // creation) specifically so worker/supabase.ts — the standalone Node
  // worker process, never bundled through Next.js — can validate/read the
  // same two environment values without importing this "server-only"-
  // guarded file, which would throw unconditionally outside Next's
  // "react-server" bundling condition. Throws the same fixed, secret-free
  // message as before this split if either value is missing.
  const { supabaseUrl, serviceRoleKey } = getAdminSupabaseConfig();

  return createSupabaseClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
