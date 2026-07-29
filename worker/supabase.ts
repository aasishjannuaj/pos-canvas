// Feature 15.5 — the standalone build worker's own service-role Supabase
// client. Deliberately does NOT import lib/supabase/admin.ts: that file
// begins with `import "server-only"`, and the real "server-only" package
// (node_modules/server-only/index.js) throws unconditionally unless
// resolved under Next.js's "react-server" export condition. This worker
// runs as a plain Node process (via `tsx`, started with
// `npm run worker:once`), never through Next's bundler, so importing
// lib/supabase/admin.ts here would crash on the very first line. Instead,
// this module duplicates the small amount of client-construction logic
// lib/supabase/admin.ts also has, sharing only the env-validation piece
// (lib/supabase/adminConfig.ts, which has no "server-only" import and
// creates no client) so the two files can never disagree about which two
// environment variables this credential comes from.
//
// Same privileged-credential rules as lib/supabase/admin.ts apply here:
// this client bypasses RLS entirely, so every query issued through it
// (in worker/once.ts) must be scoped by the exact job id/claim token the
// worker already holds — there is no RLS safety net.
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getAdminSupabaseConfig } from "@/lib/supabase/adminConfig";

export function createWorkerAdminClient() {
  const { supabaseUrl, serviceRoleKey } = getAdminSupabaseConfig();

  return createSupabaseClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
