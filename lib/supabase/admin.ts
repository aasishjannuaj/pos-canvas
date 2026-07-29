import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

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
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    // Feature 15.3 correction — a fixed, secret-free message: it never
    // echoes which specific variable is missing beyond this, and there is
    // no secret *value* here to leak in the first place (both variables
    // are either present or undefined at this point).
    throw new Error(
      "createAdminClient: required Supabase server configuration is missing."
    );
  }

  return createSupabaseClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
