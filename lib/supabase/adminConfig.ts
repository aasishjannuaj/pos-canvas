// Feature 15.5 — the service-role connection details, split out from
// lib/supabase/admin.ts so they can be read by code that must never import
// "server-only" itself. lib/supabase/admin.ts (Next.js server code) imports
// this; worker/supabase.ts (the standalone Node worker process, which is
// never bundled through Next.js and therefore cannot import "server-only"
// at all — see worker/supabase.ts's own documentation) imports this too.
// This module deliberately has no Supabase import and creates no client —
// it only validates and returns the two raw environment values, so it is
// safe from both a Next.js server context and a plain Node process, and
// stays trivially unit-testable without any Supabase/Node-only dependency.
export type AdminSupabaseConfig = {
  supabaseUrl: string;
  serviceRoleKey: string;
};

// Feature 15.5 — a fixed, secret-free message: it never echoes which
// specific variable is missing, and there is no secret *value* here to
// leak in the first place (both variables are either present or undefined
// at this point). Matches the message lib/supabase/admin.ts already threw
// before this split.
const MISSING_CONFIG_MESSAGE =
  "createAdminClient: required Supabase server configuration is missing.";

export function getAdminSupabaseConfig(
  env: Record<string, string | undefined> = process.env
): AdminSupabaseConfig {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(MISSING_CONFIG_MESSAGE);
  }

  return { supabaseUrl, serviceRoleKey };
}
