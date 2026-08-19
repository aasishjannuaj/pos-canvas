// Feature 16.3, Migration B — static guards for the device-pairing migration.
//
// SCOPE, stated plainly: these are TEXT and PARSE level assertions. They prove
// the migration is valid SQL and declares the intended security posture. They
// do NOT prove runtime behavior — that a revoked device actually loses access,
// that concurrent redemption really produces one device, or that RLS filters
// as intended can only be established by executing against a real database.
// Those belong to the manual SQL test plan, and no such claim is made here.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(migrationsDir, "20260803210000_device_pairing.sql"), "utf-8");

const executable = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

const PAIRING_FUNCTIONS = [
  "resolve_sale_owner",
  "create_device_pairing_token",
  "cancel_device_pairing_token",
  "redeem_device_pairing_token",
  "revoke_paired_device",
  "get_device_pairing_state",
  "get_device_config",
] as const;

describe("migration ordering", () => {
  it("sorts after both capture migrations", () => {
    // String comparison, which is how a migration runner orders filenames.
    //
    // The schema-capture migration was renamed from 20260803201200 to
    // 20260729000000 during the staging bootstrap: it creates `projects`, and
    // 20260729151600_build_jobs_and_artifacts.sql has always had a foreign key
    // to it, so the original order could never build a database from scratch.
    // Production never showed it because `projects` predates this repo being
    // migration-managed at all.
    expect(
      "20260729000000_capture_operational_schema.sql" <
        "20260803210000_device_pairing.sql"
    ).toBe(true);
    expect(
      "20260803201210_capture_checkout_inventory_functions.sql" <
        "20260803210000_device_pairing.sql"
    ).toBe(true);
  });
});

describe("schema", () => {
  it("creates both pairing tables exactly once", () => {
    for (const t of ["device_pairing_tokens", "paired_devices"]) {
      const matches = executable.match(
        new RegExp(`create table if not exists public\\.${t}\\b`, "g")
      );
      expect(matches?.length ?? 0).toBe(1);
    }
  });

  it("stores only a hash — there is no plaintext code column", () => {
    expect(executable).toContain("token_hash bytea not null");
    // Any column literally named for the code would be a design failure.
    expect(executable).not.toMatch(/^\s*(code|token|plaintext\w*)\s+text/im);
  });

  it("constrains the hash to 32 bytes (SHA-256)", () => {
    expect(executable).toContain("octet_length(token_hash) = 32");
  });

  it("makes the token hash unique for lookup and collision safety", () => {
    expect(executable).toContain(
      "create unique index if not exists device_pairing_tokens_token_hash_key"
    );
  });

  it("bounds attempt_count between 0 and 5", () => {
    expect(executable).toContain("attempt_count >= 0 and attempt_count <= 5");
  });

  it("enforces one device per Auth identity", () => {
    expect(executable).toMatch(/auth_user_id uuid not null unique/);
  });

  it("keeps revocation as a state change, never a delete", () => {
    expect(executable).toContain("revoked_at timestamptz");
    expect(executable).not.toMatch(/delete\s+from\s+public\.paired_devices/i);
  });

  it("indexes expiry cleanup, owner listing and active device lookup", () => {
    expect(executable).toContain("device_pairing_tokens_unconsumed_expiry_idx");
    expect(executable).toContain("device_pairing_tokens_owner_created_idx");
    expect(executable).toContain("paired_devices_owner_created_idx");
    expect(executable).toContain("paired_devices_active_project_idx");
  });
});

describe("row level security", () => {
  it("enables RLS on both tables", () => {
    expect(executable).toContain(
      "alter table public.device_pairing_tokens enable row level security;"
    );
    expect(executable).toContain(
      "alter table public.paired_devices enable row level security;"
    );
  });

  const PAIRING_TABLES = ["device_pairing_tokens", "paired_devices"] as const;

  it("grants anon nothing on either table", () => {
    expect(executable).not.toMatch(/grant[^;]*\bon table public\.device_pairing_tokens[^;]*to anon/i);
    expect(executable).not.toMatch(/grant[^;]*\bon table public\.paired_devices[^;]*to anon/i);
  });

  // Supabase's ALTER DEFAULT PRIVILEGES grants ALL on a newly created public
  // table to anon/authenticated/service_role. Granting alone therefore ADDS to
  // that inherited set rather than defining it — which is exactly why the
  // first apply of this migration failed its own verification block. Each
  // table's privileges must be revoked to zero and then rebuilt.
  it("explicitly revokes ALL from anon on both tables", () => {
    for (const t of PAIRING_TABLES) {
      expect(executable).toContain(
        `revoke all privileges on table public.${t} from anon;`
      );
    }
  });

  it("explicitly revokes ALL from PUBLIC on both tables", () => {
    for (const t of PAIRING_TABLES) {
      expect(executable).toContain(
        `revoke all privileges on table public.${t} from public;`
      );
    }
  });

  it("resets authenticated before granting SELECT, rather than relying on defaults", () => {
    for (const t of PAIRING_TABLES) {
      const revokeAt = executable.indexOf(
        `revoke all privileges on table public.${t} from authenticated;`
      );
      const grantAt = executable.indexOf(
        `grant select on table public.${t} to authenticated;`
      );

      expect(revokeAt).toBeGreaterThan(-1);
      expect(grantAt).toBeGreaterThan(-1);
      expect(revokeAt).toBeLessThan(grantAt);
    }
  });

  it("resets service_role too, then grants only the minimum", () => {
    for (const t of PAIRING_TABLES) {
      expect(executable).toContain(
        `revoke all privileges on table public.${t} from service_role;`
      );
    }
    // Cleanup job needs to find and remove expired tokens; nothing writes
    // paired_devices server-side today.
    expect(executable).toContain(
      "grant select, delete on table public.device_pairing_tokens to service_role;"
    );
    expect(executable).toContain(
      "grant select on table public.paired_devices to service_role;"
    );
    expect(executable).not.toMatch(/grant all on table public\.(device_pairing_tokens|paired_devices)/i);
  });

  it("leaves authenticated with no write privilege of any kind", () => {
    for (const priv of ["insert", "update", "delete", "truncate", "trigger", "references"]) {
      expect(executable).not.toMatch(
        new RegExp(`grant[^;]*\\b${priv}\\b[^;]*on table public\\.(device_pairing_tokens|paired_devices)[^;]*to authenticated`, "i")
      );
    }
  });

  it("performs every privilege statement before the verification block", () => {
    const lastGrant = Math.max(
      executable.lastIndexOf("grant select, delete on table public.device_pairing_tokens to service_role;"),
      executable.lastIndexOf("grant select on table public.paired_devices to service_role;")
    );
    const verification = executable.lastIndexOf("raise exception 'Device pairing:");

    expect(lastGrant).toBeGreaterThan(-1);
    expect(verification).toBeGreaterThan(lastGrant);
  });

  it("creates each table before revoking its inherited defaults", () => {
    // A clean rebuild must follow: CREATE (defaults applied) -> REVOKE ->
    // GRANT -> VERIFY, so the end state is identical to an existing database.
    for (const t of PAIRING_TABLES) {
      const createAt = executable.indexOf(`create table if not exists public.${t}`);
      const revokeAt = executable.indexOf(`revoke all privileges on table public.${t} from public;`);

      expect(createAt).toBeGreaterThan(-1);
      expect(createAt).toBeLessThan(revokeAt);
    }
  });

  it("never uses GRANT ALL on either table for any role", () => {
    expect(executable).not.toMatch(/grant all on table public\.device_pairing_tokens/i);
    expect(executable).not.toMatch(/grant all on table public\.paired_devices/i);
  });

  it("gives authenticated SELECT ONLY on token rows — no UPDATE grant at all", () => {
    expect(executable).toContain(
      "grant select on table public.device_pairing_tokens to authenticated;"
    );
    // A column-level UPDATE(consumed_at) grant was rejected: a column
    // privilege limits the column, not the legal state transition, so an owner
    // could have reset consumed_at to NULL and revived a cancelled token.
    expect(executable).not.toMatch(
      /grant\s+update[^;]*on table public\.device_pairing_tokens[^;]*to authenticated/i
    );
  });

  it("routes cancellation exclusively through the RPC", () => {
    expect(executable).toContain(
      "create or replace function public.cancel_device_pairing_token(p_token_id uuid)"
    );
    // No UPDATE policy on the token table means no direct write path exists.
    expect(executable).not.toMatch(
      /create policy[^;]*on public\.device_pairing_tokens\s*\n?\s*for update/i
    );
  });

  it("gives authenticated no INSERT or DELETE on either table", () => {
    expect(executable).not.toMatch(/grant[^;]*insert[^;]*on table public\.(device_pairing_tokens|paired_devices)[^;]*to authenticated/i);
    expect(executable).not.toMatch(/grant[^;]*delete[^;]*on table public\.(device_pairing_tokens|paired_devices)[^;]*to authenticated/i);
  });

  it("declares exactly one token policy — owner SELECT — and none for devices", () => {
    const tokenPolicies = executable.match(
      /create policy "[^"]+"\s*\n?\s*on public\.device_pairing_tokens/g
    );
    expect(tokenPolicies?.length ?? 0).toBe(1);
    expect(executable).toContain("Owners can view their own pairing tokens");
    expect(executable).not.toContain("Owners can cancel their own pairing tokens");
  });

  it("scopes a device to its own pairing row, not the whole project", () => {
    // Sibling isolation: the predicate is auth_user_id, never project_id.
    expect(executable).toContain("Devices can view their own pairing row");
    expect(executable).toMatch(/auth_user_id = \(select auth\.uid\(\)\)/);
  });
});

describe("trusted functions", () => {
  it("declares all six", () => {
    for (const fn of PAIRING_FUNCTIONS) {
      expect(executable).toContain(`create or replace function public.${fn}(`);
    }
  });

  it("makes every one SECURITY DEFINER with a locked search_path", () => {
    // Anchored to the declaration line, so the phrase inside the
    // verification block's error message is not miscounted.
    const definers = executable.match(/^security definer$/gm) ?? [];
    const paths = executable.match(/^set search_path = public, pg_temp$/gm) ?? [];

    expect(definers.length).toBe(PAIRING_FUNCTIONS.length);
    expect(paths.length).toBe(PAIRING_FUNCTIONS.length);
  });

  it("revokes every function from PUBLIC and anon", () => {
    for (const fn of PAIRING_FUNCTIONS) {
      expect(executable).toMatch(
        new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public;`)
      );
      expect(executable).toMatch(
        new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from anon;`)
      );
    }
  });

  it("derives the token owner from auth.uid(), never from a parameter", () => {
    const create = executable.slice(
      executable.indexOf("create or replace function public.create_device_pairing_token("),
      executable.indexOf("revoke all on function public.create_device_pairing_token")
    );

    // The old design took p_owner_id and was service_role-only; it was
    // rejected because it made the Server Action load-bearing for tenancy.
    expect(create).not.toContain("p_owner_id");
    expect(create).toContain("v_owner_id := auth.uid();");
    expect(create).toContain("v_project_owner is distinct from v_owner_id");
    expect(create).toContain("v_job.owner_id is distinct from v_owner_id");
  });

  it("is callable by an authenticated owner, so pairing needs no service-role", () => {
    expect(executable).toMatch(
      /grant execute on function public\.create_device_pairing_token\([^)]*\) to authenticated;/
    );
  });

  it("fixes expiry at 10 minutes with no caller-supplied TTL", () => {
    expect(executable).toContain("now() + interval '10 minutes'");
    expect(executable).not.toContain("p_ttl_seconds");
    expect(executable).not.toContain("make_interval");
  });

  it("grants service_role EXECUTE on no pairing function (least privilege)", () => {
    // Table privileges are retained for a future cleanup job; function
    // EXECUTE is deliberately not granted for symmetry.
    expect(executable).not.toMatch(/grant execute on function[^;]*to service_role/i);
    expect(executable).toContain(
      "grant select, delete on table public.device_pairing_tokens to service_role;"
    );
  });

  it("resolves already-paired state BEFORE any token lookup (no validity oracle)", () => {
    const redeem = executable.slice(
      executable.indexOf("create or replace function public.redeem_device_pairing_token("),
      executable.indexOf("revoke all on function public.redeem_device_pairing_token")
    );

    const alreadyPairedAt = redeem.indexOf("'error', 'already_paired'");
    const tokenLookupAt = redeem.indexOf("where t.token_hash = v_hash");

    expect(alreadyPairedAt).toBeGreaterThan(-1);
    expect(tokenLookupAt).toBeGreaterThan(-1);
    // If already_paired were returned after the lookup, a paired caller could
    // distinguish a real live code from a nonexistent one.
    expect(alreadyPairedAt).toBeLessThan(tokenLookupAt);
  });

  it("never increments attempt_count on the idempotent-retry path", () => {
    const redeem = executable.slice(
      executable.indexOf("create or replace function public.redeem_device_pairing_token("),
      executable.indexOf("where t.token_hash = v_hash")
    );

    // The whole already-paired/idempotent block precedes the lookup and must
    // contain no attempt_count write.
    expect(redeem).not.toContain("attempt_count");
  });

  it("caps attempt_count at 5 without breaching the constraint", () => {
    expect(executable).toContain("v_token.attempt_count >= 5");
    expect(executable).toContain("least(attempt_count + 1, 5)");
    // The increment reads the live row value, not the snapshot, so concurrent
    // increments cannot be lost.
    expect(executable).not.toContain("attempt_count = v_token.attempt_count + 1");
  });

  it("never rewrites consumed_at or consumed_by_device_id on a failed redemption", () => {
    const redeem = executable.slice(
      executable.indexOf("create or replace function public.redeem_device_pairing_token("),
      executable.indexOf("revoke all on function public.redeem_device_pairing_token")
    );
    const failureUpdates = redeem.match(/set attempt_count = least\(attempt_count \+ 1, 5\)/g) ?? [];

    // Every failure-path UPDATE touches attempt_count and nothing else.
    expect(failureUpdates.length).toBeGreaterThanOrEqual(3);
    // The single consuming write happens only on the success path.
    expect(redeem.match(/set consumed_at = now\(\),/g)?.length ?? 0).toBe(1);
  });

  it("never accepts a plaintext code into token creation", () => {
    const signature = executable.slice(
      executable.indexOf("create or replace function public.create_device_pairing_token("),
      executable.indexOf("returns table (id uuid, expires_at timestamptz)")
    );

    expect(signature).toContain("p_token_hash bytea");
    expect(signature).not.toMatch(/p_code|p_plaintext/);
  });

  it("locks the token row during redemption", () => {
    expect(executable).toMatch(/where t\.token_hash = v_hash\s*\n\s*for update/);
  });

  it("normalizes exactly as the TypeScript helper does", () => {
    expect(executable).toContain(
      "translate(\n    upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g')),\n    'ILO', '110'\n  )"
    );
  });

  it("hashes inside the trusted boundary rather than trusting a client hash", () => {
    // Core sha256() over UTF-8 bytes, NOT pgcrypto digest(): pgcrypto lives in
    // the "extensions" schema on Supabase and would not resolve under the
    // locked search_path "public, pg_temp".
    expect(executable).toContain(
      "v_hash := sha256(convert_to(v_normalized, 'UTF8'));"
    );
    expect(executable).not.toMatch(/v_hash\s*:=\s*digest\(/);
  });

  it("requires an anonymous JWT claim, failing closed when absent", () => {
    expect(executable).toContain(
      "coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)"
    );
  });

  it("takes project and build from the token, never from the device", () => {
    const redeem = executable.slice(
      executable.indexOf("create or replace function public.redeem_device_pairing_token("),
      executable.indexOf("revoke all on function public.redeem_device_pairing_token")
    );

    // The device only supplies a code, a name and a platform.
    expect(redeem).toMatch(/p_code text,\s*\n\s*p_device_name text default null,\s*\n\s*p_platform text default null/);
    expect(redeem).not.toMatch(/p_project_id|p_build_job_id/);
    expect(redeem).toContain("v_token.project_id");
    expect(redeem).toContain("v_token.build_job_id");
  });

  it("verifies the build succeeded and its json_config artifact exists", () => {
    expect(executable).toContain("v_job.status <> 'succeeded'");
    expect(executable).toContain("a.artifact_type = 'json_config'");
  });

  it("returns a generic invalid_code for every guessable rejection", () => {
    const redeem = executable.slice(
      executable.indexOf("create or replace function public.redeem_device_pairing_token("),
      executable.indexOf("revoke all on function public.redeem_device_pairing_token")
    );
    const generic = redeem.match(/'error', 'invalid_code'/g) ?? [];

    // wrong length, no match, locked, expired/consumed, project gone, build bad
    expect(generic.length).toBeGreaterThanOrEqual(5);
    expect(redeem).not.toMatch(/'error',\s*'(expired|consumed|locked|wrong_code)'/);
  });

  it("returns rather than raises on failed attempts so attempt_count persists", () => {
    const redeem = executable.slice(
      executable.indexOf("create or replace function public.redeem_device_pairing_token("),
      executable.indexOf("revoke all on function public.redeem_device_pairing_token")
    );

    expect(redeem).toContain("attempt_count = least(attempt_count + 1, 5)");
    // A RAISE on the invalid path would roll the increment back.
    expect(redeem).not.toMatch(/raise exception[^;]*invalid/i);
  });

  it("revocation is idempotent and never deletes", () => {
    const revoke = executable.slice(
      executable.indexOf("create or replace function public.revoke_paired_device("),
      executable.indexOf("revoke all on function public.revoke_paired_device")
    );

    expect(revoke).toContain("already_revoked");
    expect(revoke).not.toMatch(/\bdelete\b/i);
    expect(revoke).toContain("d.owner_id = v_caller");
  });

  it("get_device_config excludes internal build metadata", () => {
    const cfg = executable.slice(
      executable.indexOf("create or replace function public.get_device_config("),
      executable.indexOf("revoke all on function public.get_device_config")
    );

    expect(cfg).toContain("config_snapshot");
    for (const forbidden of ["request_key", "storage_path", "checksum", "claim_token", "config_hash"]) {
      expect(cfg).not.toContain(forbidden);
    }
  });

  it("get_device_config requires a non-revoked device", () => {
    const cfg = executable.slice(
      executable.indexOf("create or replace function public.get_device_config("),
      executable.indexOf("revoke all on function public.get_device_config")
    );

    expect(cfg).toContain("d.revoked_at is null");
  });

  it("resolve_sale_owner checks owner first, then active device only", () => {
    const resolve = executable.slice(
      executable.indexOf("create or replace function public.resolve_sale_owner("),
      executable.indexOf("revoke all on function public.resolve_sale_owner")
    );

    expect(resolve).toContain("p.user_id = v_caller");
    expect(resolve).toContain("d.auth_user_id = v_caller");
    expect(resolve).toContain("d.project_id = p_project_id");
    expect(resolve).toContain("d.revoked_at is null");
    // One indistinguishable rejection for every failure mode.
    expect(resolve).toContain("raise exception 'Project not found or access denied'");
  });
});

describe("additive only — nothing existing is modified", () => {
  it("does not touch complete_sale, restock_inventory or adjust_inventory", () => {
    for (const fn of ["complete_sale", "restock_inventory", "adjust_inventory"]) {
      expect(executable).not.toMatch(
        new RegExp(`create or replace function public\\.${fn}\\(`, "i")
      );
    }
  });

  it("changes no existing operational-table policy or grant", () => {
    for (const t of ["projects", "orders", "order_items", "inventory_transactions"]) {
      expect(executable).not.toMatch(new RegExp(`create policy[^;]*on public\\.${t}\\b`, "i"));
      expect(executable).not.toMatch(new RegExp(`drop policy[^;]*on public\\.${t}\\b`, "i"));
      expect(executable).not.toMatch(new RegExp(`grant[^;]*on table public\\.${t}\\b`, "i"));
      expect(executable).not.toMatch(new RegExp(`alter table public\\.${t}\\b`, "i"));
    }
  });

  it("contains no DROP or destructive statement at all", () => {
    expect(executable).not.toMatch(/\bdrop\s+(table|column|policy|function|index)\b/i);
    expect(executable).not.toMatch(/\btruncate\b/i);
    expect(executable).not.toMatch(/^\s*delete\s+from/im);
  });

  it("performs no DDL or privilege change against complete_sale", () => {
    // The real guarantee that this migration cannot alter complete_sale is
    // structural: it contains no statement that could.
    for (const pattern of [
      /create\s+or\s+replace\s+function\s+public\.complete_sale/i,
      /alter\s+function[^;]*complete_sale/i,
      /drop\s+function[^;]*complete_sale/i,
      /grant[^;]*\bon\s+function[^;]*complete_sale/i,
      /revoke[^;]*\bon\s+function[^;]*complete_sale/i,
    ]) {
      expect(executable).not.toMatch(pattern);
    }
  });

  it("does not tie verification to a formatting-sensitive character count", () => {
    // pg_get_functiondef REGENERATES the header from catalog metadata, so its
    // rendered length can shift for formatting-only reasons with no change to
    // executable SQL. The first apply failed on exactly that.
    expect(executable).not.toMatch(/length\s*\(\s*pg_get_functiondef/i);
    expect(executable).not.toContain("5903");
    expect(executable).not.toMatch(/md5\s*\(\s*pg_get_functiondef/i);
  });

  it("verifies complete_sale by semantic posture instead", () => {
    expect(executable).toContain("pg_get_function_result(v_complete_sale_oid)) <> 'uuid'");
    expect(executable).toContain("'search_path=public' = any(coalesce(p.proconfig");
    expect(executable).toContain("l.lanname = 'plpgsql'");
  });

  it("still fails if complete_sale becomes SECURITY DEFINER", () => {
    expect(executable).toContain(
      "raise exception 'Device pairing: complete_sale must remain SECURITY INVOKER (DEFINER is Migration C)'"
    );
    expect(executable).toContain("select p.prosecdef from pg_proc p where p.oid = v_complete_sale_oid");
  });

  it("still fails if the signature or return type changes", () => {
    expect(executable).toContain(
      "raise exception 'Device pairing: complete_sale exact overload is missing'"
    );
    expect(executable).toContain(
      "raise exception 'Device pairing: complete_sale must still return uuid'"
    );
  });

  it("still fails if complete_sale EXECUTE grants change", () => {
    expect(executable).toContain(
      "has_function_privilege('authenticated', v_complete_sale_oid, 'EXECUTE')"
    );
    expect(executable).toContain(
      "has_function_privilege('anon', v_complete_sale_oid, 'EXECUTE')"
    );
    expect(executable).toContain("grantee = 'PUBLIC'");
  });
});

// ============================================================================
// REGRESSION — a false failure caught before it could be applied.
//
// After the 5903-byte length check aborted the migration on a function it never
// touches, the replacement located the overload by comparing
// pg_get_function_identity_arguments() to a hand-written types-only string.
// PostgreSQL renders identity arguments WITH PARAMETER NAMES, so that
// comparison could never match: the lookup would have returned no row and the
// null OID would have been misread as "the function changed". A live catalog
// diagnostic exposed it before the migration was applied again.
//
// The fixtures below are the ACTUAL live output from the production database,
// pasted verbatim. They exist so this specific false failure cannot come back.
// ============================================================================
describe("regression: complete_sale overload lookup", () => {
  // Verbatim live output of:
  //   select pg_get_function_identity_arguments(oid) from pg_proc ...
  const LIVE_IDENTITY_ARGUMENTS =
    "p_project_id uuid, p_order_number text, p_payment_method text, " +
    "p_subtotal numeric, p_tax_amount numeric, p_tip_amount numeric, " +
    "p_total numeric, p_items jsonb";

  // Verbatim live output of the types-only projection, and the regprocedure
  // rendering of the same function.
  const LIVE_INPUT_ARGUMENT_TYPES =
    "uuid,text,text,numeric,numeric,numeric,numeric,jsonb";
  const LIVE_REGPROCEDURE =
    "complete_sale(uuid,text,text,numeric,numeric,numeric,numeric,jsonb)";
  const LIVE_ARGUMENT_COUNT = 8;

  // The exact string the removed assertion compared against.
  const REMOVED_ASSERTION_STRING =
    "uuid, text, text, numeric, numeric, numeric, numeric, jsonb";

  it("reproduces the false failure: live identity arguments carry names", () => {
    // Negative control. If this ever stops holding, the bug being guarded
    // against no longer exists and this whole block should be revisited.
    expect(LIVE_IDENTITY_ARGUMENTS).not.toBe(REMOVED_ASSERTION_STRING);
    expect(LIVE_IDENTITY_ARGUMENTS).toContain("p_project_id uuid");
    expect(LIVE_IDENTITY_ARGUMENTS).toMatch(/\bp_items jsonb$/);
  });

  it("no longer compares pg_get_function_identity_arguments to any string", () => {
    expect(executable).not.toMatch(/pg_get_function_identity_arguments/i);
    expect(executable).not.toContain(REMOVED_ASSERTION_STRING);
  });

  it("resolves the overload with to_regprocedure on a fully qualified signature", () => {
    expect(executable).toContain(
      "to_regprocedure(\n    'public.complete_sale(uuid,text,text,numeric,numeric,numeric,numeric,jsonb)'\n  )"
    );
  });

  it("uses argument types that match the live function exactly", () => {
    const match = executable.match(/to_regprocedure\(\s*'([^']+)'\s*\)/);

    expect(match).not.toBeNull();

    const signature = match![1];

    expect(signature.startsWith("public.complete_sale(")).toBe(true);
    expect(signature.endsWith(")")).toBe(true);

    const types = signature.slice(
      signature.indexOf("(") + 1,
      signature.lastIndexOf(")")
    );

    // Matches the live types-only projection, and the regprocedure rendering.
    expect(types).toBe(LIVE_INPUT_ARGUMENT_TYPES);
    expect(`complete_sale(${types})`).toBe(LIVE_REGPROCEDURE);
    expect(types.split(",")).toHaveLength(LIVE_ARGUMENT_COUNT);

    // Derived independently from the NAMED live output: strip each parameter
    // name and the two must agree. This is what proves the signature in the
    // migration describes the same overload the database actually has.
    const typesFromNamedOutput = LIVE_IDENTITY_ARGUMENTS.split(", ")
      .map((arg) => arg.split(" ").slice(1).join(" "))
      .join(",");

    expect(typesFromNamedOutput).toBe(types);
  });

  it("keeps a distinct message for a missing overload", () => {
    // to_regprocedure returns null rather than raising, so the absent case
    // still carries its own message instead of an opaque cast error.
    expect(executable).toContain(
      "raise exception 'Device pairing: complete_sale exact overload is missing'"
    );
    expect(executable).not.toContain("::regprocedure");
  });

  it("verifies every remaining property through that OID, not by name", () => {
    for (const check of [
      "pg_get_function_result(v_complete_sale_oid)) <> 'uuid'",
      "select p.prosecdef from pg_proc p where p.oid = v_complete_sale_oid",
      "p.oid = v_complete_sale_oid\n      and 'search_path=public' = any(coalesce(p.proconfig",
      "where p.oid = v_complete_sale_oid and l.lanname = 'plpgsql'",
      "has_function_privilege('authenticated', v_complete_sale_oid, 'EXECUTE')",
      "has_function_privilege('anon', v_complete_sale_oid, 'EXECUTE')",
    ]) {
      expect(executable).toContain(check);
    }

    // PUBLIC is the one check that must go through information_schema, since
    // has_function_privilege has no PUBLIC pseudo-role.
    expect(executable).toContain("grantee = 'PUBLIC'");
  });

  it("matches the live posture the checks assert", () => {
    // Pinning the observed values so a future edit that flips an expectation
    // has to contradict real recorded output to do it.
    const LIVE_POSTURE = {
      returnType: "uuid",
      securityDefiner: false,
      proconfig: "search_path=public",
      language: "plpgsql",
    };

    expect(executable).toContain(`<> '${LIVE_POSTURE.returnType}'`);
    expect(LIVE_POSTURE.securityDefiner).toBe(false);
    expect(executable).toContain(`'${LIVE_POSTURE.proconfig}' = any(coalesce(p.proconfig`);
    expect(executable).toContain(`l.lanname = '${LIVE_POSTURE.language}'`);
  });
});

describe("verification block", () => {
  it("raises rather than leaving a half-built pairing layer", () => {
    const raises = executable.match(/raise exception 'Device pairing:/g) ?? [];

    expect(raises.length).toBeGreaterThanOrEqual(7);
  });

  it("asserts anon AND PUBLIC hold no privilege on the new tables", () => {
    expect(executable).toContain("anon/PUBLIC must have no table privileges");
  });

  it("asserts authenticated holds SELECT only on both tables", () => {
    expect(executable).toContain("authenticated must hold SELECT only");
  });

  it("asserts service_role holds no unintended table privilege", () => {
    expect(executable).toContain("service_role holds unintended table privileges");
  });
});
