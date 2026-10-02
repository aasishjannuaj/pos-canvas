// v1.3 Cash Drawer Checkpoint 1B — set_device_cash_drawer_enabled and the
// cash_drawer_enabled key of get_device_pairing_state, EXECUTED against a real
// PostgreSQL, not read.
//
// WHAT IS PROVEN HERE THAT TEXT CANNOT PROVE: that the owner can set it and
// nobody else can; that a till is refused even when its auth user owns the
// project; that revoked, unpaired and non-Windows targets are refused for
// enable; that the pairing-state answer is the accepted one plus exactly one
// gated key; that existing rows read false after the upgrade; and that nothing
// else in the schema moved. The last comparisons run against a database built
// from every migration BEFORE this one, seeded identically.
//
// The harness (PostgreSQL discovery, the Supabase compatibility layer, the
// cluster and the migration chain) is the one the earlier v1.3 suites use,
// reproduced unchanged; only the migration name and port range differ. When no
// PostgreSQL server is found the suite SKIPS LOUDLY rather than failing.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20261002120000_device_cash_drawer_enablement.sql";

// ---------------------------------------------------------------------------
// Finding PostgreSQL
// ---------------------------------------------------------------------------

/** Every binary this harness actually invokes. A partial install is not usable. */
export const REQUIRED_BINARIES = ["initdb", "pg_ctl", "psql"] as const;

export function isCompletePostgresBin(dir: string): boolean {
  return REQUIRED_BINARIES.every((tool) => existsSync(join(dir, tool)));
}

function findPostgresBin(): string | null {
  const candidates: string[] = [];

  try {
    const onPath = execFileSync("which", ["initdb"], { encoding: "utf8" }).trim();

    if (onPath) candidates.push(dirname(onPath));
  } catch {
    // Not on PATH. Perfectly normal.
  }

  candidates.push(
    "/opt/homebrew/opt/postgresql@17/bin",
    "/opt/homebrew/opt/postgresql@16/bin",
    "/usr/local/opt/postgresql@17/bin",
    "/usr/lib/postgresql/17/bin",
    "/usr/lib/postgresql/16/bin"
  );

  return candidates.find(isCompletePostgresBin) ?? null;
}

const PG_BIN = findPostgresBin();
const PORT = 56700 + (process.pid % 90);

if (PG_BIN === null) {
  console.warn(
    `\n[${MIGRATION}] SKIPPED: no local PostgreSQL server found.` +
      "\n  These are the only tests that EXECUTE set_device_cash_drawer_enabled;" +
      "\n  install PostgreSQL 16+ to run them.\n"
  );
}

// ---------------------------------------------------------------------------
// The compatibility layer: ONLY what Supabase provides and vanilla does not
// ---------------------------------------------------------------------------

const COMPAT = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

-- Supabase's default privileges on public. This matters: it is why a new
-- function is born with EXECUTE granted to the three roles, which is exactly
-- what this migration's revokes exist to undo. Without it the revokes are
-- no-ops and the assertions below would pass trivially.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create schema auth;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  created_at timestamptz not null default now()
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create schema extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists supabase_migrations;

create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  statements text[],
  name text
);
`;

// ---------------------------------------------------------------------------
// Cluster lifecycle
// ---------------------------------------------------------------------------
let dataDir = "";

function pg(tool: string, args: string[], input?: string): string {
  return execFileSync(join(PG_BIN as string, tool), args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, LC_ALL: "en_US.UTF-8", PGTZ: "UTC" },
  });
}

const psqlArgs = (db: string): string[] => [
  "-h", "127.0.0.1", "-p", String(PORT), "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1",
];

/** Runs SQL in `db` and returns unaligned, tuples-only output. */
function sql(db: string, statement: string): string {
  return pg("psql", [...psqlArgs(db), "-Atq", "-c", statement]).trim();
}

/**
 * The ONLY predecessors this harness is allowed to skip, named exactly.
 *
 * Both create Supabase Storage buckets and policies on `storage.objects`, a
 * schema the Supabase platform provides and a vanilla cluster does not have.
 * Neither touches registers, devices, projects or orders.
 */
export const STORAGE_ONLY_MIGRATIONS = new Set([
  "20260729190422_build_artifact_storage.sql",
  "20260813120000_project_logo_storage.sql",
]);

/**
 * Applies one .sql file. THROWS on any failure, deliberately: a predecessor
 * that fails leaves an incomplete schema, and every assertion below would then
 * be measuring the wrong database while reporting success.
 */
function runSqlFile(db: string, file: string): void {
  pg("psql", [...psqlArgs(db), "-q", "-f", file]);
}

/** A database with every accepted migration applied, and this one optional. */
function freshDatabase(name: string, withMigration: boolean): void {
  sql("postgres", `drop database if exists ${name}`);
  sql("postgres", `create database ${name}`);
  pg("psql", ["-h", "127.0.0.1", "-p", String(PORT), "-U", "postgres", "-d", name, "-q", "-f", "-"], COMPAT);

  const files = execFileSync("ls", [migrationsDir], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    // "WITHOUT the migration" means the database as it was BEFORE it -- so every
    // migration that comes AFTER it is skipped too, not just the one under test.
    // Filenames begin with a fixed-width timestamp, so a lexicographic compare
    // is a chronological one.
    if (!withMigration && file >= MIGRATION) continue;
    // AND "WITH the migration" means the database as it was right AFTER it --
    // so every LATER migration is skipped as well. Without this the
    // "nothing else in the schema moved" comparison below measures every
    // migration added after this one, and fails the moment the next one lands
    // (first exposed by Cash Drawer 1B, 20261002120000). Narrowed, not weakened:
    // it still proves exactly what this migration changed.
    if (withMigration && file > MIGRATION) continue;
    if (STORAGE_ONLY_MIGRATIONS.has(file)) continue;

    runSqlFile(name, join(migrationsDir, file));
    sql(name,
      `insert into supabase_migrations.schema_migrations(version, name)
       values ('${file.split("_")[0]}', '${file}') on conflict do nothing`);
  }
}

// ---------------------------------------------------------------------------
// Callers
// ---------------------------------------------------------------------------

/**
 * Runs `statement` as the REAL `authenticated` role, with the JWT subject set.
 * An empty `who` leaves auth.uid() null -- an unauthenticated request.
 */
function asAuthenticated(db: string, who: string, statement: string): string {
  const out = sql(db, `
    begin;
    set local role authenticated;
    select set_config('request.jwt.claim.sub','${who}', true);
    ${statement};
    commit;`);
  const lines = out.split("\n").filter((line) => line !== "");

  return lines[lines.length - 1] ?? "";
}

// ---------------------------------------------------------------------------
// Fixtures: one owner with a till of every relevant kind, a second owner, a
// till whose auth user also owns a project, and a stranger
// ---------------------------------------------------------------------------

const OWNER_USER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "a0000000-0000-4000-8000-000000000001";
const BUILD = "b0000000-0000-4000-8000-000000000001";

const OTHER_OWNER_USER = "22222222-2222-4222-8222-222222222222";
const OTHER_PROJECT = "a0000000-0000-4000-8000-000000000002";
const OTHER_BUILD = "b0000000-0000-4000-8000-000000000002";

/** Authenticated, owns nothing, is not a till. */
const STRANGER = "33333333-3333-4333-8333-333333333333";

/**
 * Owns a project AND is the auth user of that project's paired Windows till.
 * The only caller for whom the paired-device refusal is load-bearing: the
 * owner match alone would admit it.
 */
const DUAL_USER = "44444444-4444-4444-8444-444444444444";
const DUAL_PROJECT = "a0000000-0000-4000-8000-000000000004";
const DUAL_BUILD = "b0000000-0000-4000-8000-000000000004";
const DUAL_DEVICE = "c0000000-0000-4000-8000-0000000000d4";

type Till = { id: string; user: string; owner: string; project: string; build: string; platform: string | null; state: "active" | "revoked" | "unpaired" };

const T = (n: string, platform: string | null, state: Till["state"] = "active", owner = OWNER_USER, project = PROJECT, build = BUILD): Till => ({
  id: `c0000000-0000-4000-8000-0000000000${n}`,
  user: `d0000000-0000-4000-8000-0000000000${n}`,
  owner, project, build, platform, state,
});

const WIN = T("01", "windows");
const WIN_2 = T("02", "windows");
const ANDROID = T("03", "android");
const WEB = T("04", "web");
const NO_PLATFORM = T("05", null);
const REVOKED = T("06", "windows", "revoked");
const UNPAIRED = T("07", "windows", "unpaired");
const FOREIGN = T("08", "windows", "active", OTHER_OWNER_USER, OTHER_PROJECT, OTHER_BUILD);

const TILLS = [WIN, WIN_2, ANDROID, WEB, NO_PLATFORM, REVOKED, UNPAIRED, FOREIGN];

const MENU = JSON.stringify({ menuItems: [] });

function seed(db: string): void {
  const users = [OWNER_USER, OTHER_OWNER_USER, STRANGER, DUAL_USER, ...TILLS.map((t) => t.user)];
  const tills = TILLS.map((t) =>
    `('${t.id}','${t.user}','${t.owner}','${t.project}','${t.build}', 'Till', ${t.platform === null ? "null" : `'${t.platform}'`},
      '2026-08-01T09:00:00Z',
      ${t.state === "revoked" ? "'2026-09-01T09:00:00Z'" : "null"},
      ${t.state === "unpaired" ? "'2026-09-01T09:00:00Z'" : "null"})`
  ).join(",\n");

  sql(db, `
    insert into auth.users (id) values ${users.map((u) => `('${u}')`).join(", ")};

    insert into public.projects (id, user_id, name, template_id, config)
    values ('${PROJECT}', '${OWNER_USER}', 'Shop', 'cafe', '${MENU}'::jsonb),
           ('${OTHER_PROJECT}', '${OTHER_OWNER_USER}', 'Other Shop', 'cafe', '${MENU}'::jsonb),
           ('${DUAL_PROJECT}', '${DUAL_USER}', 'Dual Shop', 'cafe', '${MENU}'::jsonb);

    insert into public.build_jobs (id, project_id, owner_id, target, status, config_snapshot,
                                   config_schema_version, config_hash, request_key, started_at, finished_at)
    values ('${BUILD}','${PROJECT}','${OWNER_USER}','desktop','succeeded','${MENU}'::jsonb,1,'h','r', now(), now()),
           ('${OTHER_BUILD}','${OTHER_PROJECT}','${OTHER_OWNER_USER}','desktop','succeeded','${MENU}'::jsonb,1,'h2','r2', now(), now()),
           ('${DUAL_BUILD}','${DUAL_PROJECT}','${DUAL_USER}','desktop','succeeded','${MENU}'::jsonb,1,'h4','r4', now(), now());

    insert into public.paired_devices
      (id, auth_user_id, owner_id, project_id, build_job_id, device_name, platform, created_at, revoked_at, unpaired_at)
    values ${tills},
      ('${DUAL_DEVICE}','${DUAL_USER}','${DUAL_USER}','${DUAL_PROJECT}','${DUAL_BUILD}', 'Till', 'windows',
       '2026-08-01T09:00:00Z', null, null);
  `);
}

const DB = "cashdrawer";
/** The same fixtures, with every migration BEFORE this one applied. */
const DB_BEFORE = "cashdrawerbefore";
/** Seeded BEFORE this migration, then upgraded: what an existing project sees. */
const DB_UPGRADED = "cashdrawerupgraded";

beforeAll(() => {
  if (PG_BIN === null) return;

  dataDir = mkdtempSync(join(tmpdir(), "pos-canvas-1b-"));
  pg("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust"]);
  pg("pg_ctl", [
    "-D", dataDir, "-l", join(dataDir, "server.log"), "-w", "start",
    "-o", `-c listen_addresses=127.0.0.1 -c port=${PORT} -c unix_socket_directories=''`,
  ]);
  freshDatabase(DB, true);
  freshDatabase(DB_BEFORE, false);
  freshDatabase(DB_UPGRADED, false);
  seed(DB);
  seed(DB_BEFORE);
  seed(DB_UPGRADED);
  runSqlFile(DB_UPGRADED, join(migrationsDir, MIGRATION));
}, 900_000);

afterAll(() => {
  if (PG_BIN === null) return;
  try { pg("pg_ctl", ["-D", dataDir, "-m", "immediate", "-w", "stop"]); }
  finally { rmSync(dataDir, { recursive: true, force: true }); }
}, 900_000);

const maybe = PG_BIN === null ? describe.skip : describe;

type Row = Record<string, unknown>;
type Attempt = { value: Row } | { error: string };

/** Calls the setter as the real `authenticated` role; a raise becomes `error`. */
function setEnabled(db: string, who: string, device: string | null, enabled: boolean | null): Attempt {
  const d = device === null ? "null" : `'${device}'`;
  const e = enabled === null ? "null" : String(enabled);

  try {
    return { value: JSON.parse(asAuthenticated(db, who, `select (public.set_device_cash_drawer_enabled(${d}, ${e}))::text`)) };
  } catch (error) {
    return { error: String((error as { stderr?: unknown }).stderr ?? error) };
  }
}

const stored = (db: string, device: string): string =>
  sql(db, `select cash_drawer_enabled from public.paired_devices where id = '${device}'`);

/** Superuser reset, so each case starts from a known value. */
const force = (db: string, device: string, value: boolean): void => {
  sql(db, `update public.paired_devices set cash_drawer_enabled = ${value} where id = '${device}'`);
};

const pairingText = (db: string, who: string): string =>
  asAuthenticated(db, who, `select (public.get_device_pairing_state())::text`);

const pairing = (db: string, who: string): Row => JSON.parse(pairingText(db, who));

const DENIED = "Device not found or access denied";

// ---------------------------------------------------------------------------
// The column
// ---------------------------------------------------------------------------

maybe("paired_devices.cash_drawer_enabled", () => {
  it("is boolean, NOT NULL, DEFAULT false", () => {
    expect(sql(DB, `
      select data_type || '|' || is_nullable || '|' || column_default
      from information_schema.columns
      where table_schema = 'public' and table_name = 'paired_devices' and column_name = 'cash_drawer_enabled'`))
      .toBe("boolean|NO|false");
  });

  it("every row that existed before the upgrade reads false", () => {
    expect(sql(DB_UPGRADED, `select count(*) from public.paired_devices`)).toBe(String(TILLS.length + 1));
    expect(sql(DB_UPGRADED, `select count(*) from public.paired_devices where cash_drawer_enabled is not false`)).toBe("0");
  });

  it("no role gained UPDATE on paired_devices, and the browser still cannot write it directly", () => {
    for (const role of ["authenticated", "anon", "service_role"]) {
      expect(sql(DB, `select has_table_privilege('${role}', 'public.paired_devices', 'update')`)).toBe("f");
      expect(sql(DB, `select has_column_privilege('${role}', 'public.paired_devices', 'cash_drawer_enabled', 'update')`)).toBe("f");
    }

    expect(() =>
      asAuthenticated(DB, OWNER_USER, `update public.paired_devices set cash_drawer_enabled = true where id = '${WIN.id}'`)
    ).toThrow(/permission denied/);
    expect(stored(DB, WIN.id)).toBe("f");
  });

  it("the immutability trigger is not broadened: identical to before, and it does not name the column", () => {
    const guard = (db: string) =>
      sql(db, `select md5(pg_get_functiondef('public.paired_devices_guard_immutable_columns()'::regprocedure))`);

    expect(guard(DB)).toBe(guard(DB_BEFORE));
    expect(sql(DB, `select pg_get_functiondef('public.paired_devices_guard_immutable_columns()'::regprocedure)`))
      .not.toContain("cash_drawer_enabled");
  });
});

// ---------------------------------------------------------------------------
// The setter
// ---------------------------------------------------------------------------

maybe("set_device_cash_drawer_enabled — who may call it", () => {
  it("is SECURITY DEFINER with a pinned search_path, owned by postgres", () => {
    expect(sql(DB, `
      select p.prosecdef || '|' || array_to_string(p.proconfig, ',') || '|' || pg_get_userbyid(p.proowner)
      from pg_proc p where p.oid = 'public.set_device_cash_drawer_enabled(uuid, boolean)'::regprocedure`))
      .toBe("true|search_path=public, pg_temp|postgres");
  });

  it("EXECUTE is authenticated only: not anon, not service_role, not PUBLIC", () => {
    const privilege = (role: string) =>
      sql(DB, `select has_function_privilege('${role}', 'public.set_device_cash_drawer_enabled(uuid, boolean)', 'execute')`);

    expect(privilege("authenticated")).toBe("t");
    expect(privilege("anon")).toBe("f");
    expect(privilege("service_role")).toBe("f");
    expect(sql(DB, `
      select exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                     where p.oid = 'public.set_device_cash_drawer_enabled(uuid, boolean)'::regprocedure
                       and a.grantee = 0)`)).toBe("f");
  });

  it("an unauthenticated caller is refused", () => {
    const result = setEnabled(DB, "", WIN.id, true);

    expect("error" in result && result.error).toContain("Authentication required");
    expect(stored(DB, WIN.id)).toBe("f");
  });

  it("a paired till is refused, including one of this owner's own project", () => {
    for (const till of [WIN, ANDROID]) {
      const result = setEnabled(DB, till.user, till.id, true);

      expect("error" in result && result.error).toContain(DENIED);
    }

    expect(stored(DB, WIN.id)).toBe("f");
  });

  it("a till is refused EVEN WHEN its auth user owns the project and the device", () => {
    // Sanity: the owner match alone would admit this caller.
    expect(sql(DB, `select owner_id from public.paired_devices where id = '${DUAL_DEVICE}'`)).toBe(DUAL_USER);

    const result = setEnabled(DB, DUAL_USER, DUAL_DEVICE, true);

    expect("error" in result && result.error).toContain(DENIED);
    expect(stored(DB, DUAL_DEVICE)).toBe("f");
  });

  it("another owner's device is refused exactly like one that does not exist", () => {
    const foreign = setEnabled(DB, OWNER_USER, FOREIGN.id, true);
    const missing = setEnabled(DB, OWNER_USER, "c0000000-0000-4000-8000-0000000000ff", true);

    expect("error" in foreign && foreign.error).toContain(DENIED);
    expect("error" in missing && missing.error).toContain(DENIED);
    expect(stored(DB, FOREIGN.id)).toBe("f");
  });

  it("an authenticated stranger is refused", () => {
    const result = setEnabled(DB, STRANGER, WIN.id, true);

    expect("error" in result && result.error).toContain(DENIED);
  });

  it("null arguments are refused", () => {
    for (const [device, enabled] of [[null, true], [WIN.id, null]] as const) {
      const result = setEnabled(DB, OWNER_USER, device, enabled);

      expect("error" in result && result.error).toContain("required");
    }
  });
});

maybe("set_device_cash_drawer_enabled — what it does", () => {
  it("the owner enables an active Windows till, idempotently", () => {
    force(DB, WIN.id, false);

    expect(setEnabled(DB, OWNER_USER, WIN.id, true)).toEqual({
      value: { ok: true, device_id: WIN.id, cash_drawer_enabled: true, changed: true },
    });
    expect(stored(DB, WIN.id)).toBe("t");
    expect(setEnabled(DB, OWNER_USER, WIN.id, true)).toEqual({
      value: { ok: true, device_id: WIN.id, cash_drawer_enabled: true, changed: false },
    });
    expect(stored(DB, WIN.id)).toBe("t");
  });

  it("the owner disables it, idempotently", () => {
    force(DB, WIN.id, true);

    expect(setEnabled(DB, OWNER_USER, WIN.id, false)).toEqual({
      value: { ok: true, device_id: WIN.id, cash_drawer_enabled: false, changed: true },
    });
    expect(setEnabled(DB, OWNER_USER, WIN.id, false)).toEqual({
      value: { ok: true, device_id: WIN.id, cash_drawer_enabled: false, changed: false },
    });
    expect(stored(DB, WIN.id)).toBe("f");
  });

  it("it writes ONLY that column on ONLY that row", () => {
    force(DB, WIN.id, false);
    const snapshot = (db: string) => sql(db, `
      select md5(string_agg(to_jsonb(d)::text, ',' order by d.id))
      from (select * from public.paired_devices) d`);
    const others = (db: string) => sql(db, `
      select md5(string_agg((to_jsonb(d) - 'cash_drawer_enabled')::text, ',' order by d.id))
      from public.paired_devices d`);
    const beforeAll = snapshot(DB);
    const beforeOthers = others(DB);

    setEnabled(DB, OWNER_USER, WIN.id, true);

    expect(snapshot(DB)).not.toBe(beforeAll);
    expect(others(DB)).toBe(beforeOthers);
    expect(sql(DB, `select count(*) from public.paired_devices where cash_drawer_enabled`)).toBe("1");
    force(DB, WIN.id, false);
  });

  it("enable is refused for every non-Windows platform, with its own message", () => {
    for (const till of [ANDROID, WEB, NO_PLATFORM]) {
      const result = setEnabled(DB, OWNER_USER, till.id, true);

      expect("error" in result && result.error).toContain("Cash drawer is only supported on Windows devices");
      expect(stored(DB, till.id)).toBe("f");
    }
  });

  it("disable is allowed on an active non-Windows till", () => {
    force(DB, ANDROID.id, true);

    expect(setEnabled(DB, OWNER_USER, ANDROID.id, false)).toEqual({
      value: { ok: true, device_id: ANDROID.id, cash_drawer_enabled: false, changed: true },
    });
    expect(setEnabled(DB, OWNER_USER, WEB.id, false)).toEqual({
      value: { ok: true, device_id: WEB.id, cash_drawer_enabled: false, changed: false },
    });
  });

  it("a revoked or self-unpaired till is refused, for enable and disable alike", () => {
    for (const till of [REVOKED, UNPAIRED]) {
      for (const enabled of [true, false]) {
        const result = setEnabled(DB, OWNER_USER, till.id, enabled);

        expect("error" in result && result.error).toContain(DENIED);
      }

      expect(stored(DB, till.id)).toBe("f");
    }
  });

  it("no other function in the schema mentions the column — no device RPC can write it", () => {
    const mentions = sql(DB, `
      select string_agg(p.oid::regprocedure::text, ',' order by p.oid::regprocedure::text)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f' and pg_get_functiondef(p.oid) like '%cash_drawer_enabled%'`);

    expect(mentions).toBe("get_device_pairing_state(),set_device_cash_drawer_enabled(uuid,boolean)");
  });
});

// ---------------------------------------------------------------------------
// get_device_pairing_state
// ---------------------------------------------------------------------------

maybe("get_device_pairing_state is the accepted answer plus one gated key", () => {
  it("every accepted key is present with the same value, and cash_drawer_enabled is the only addition", () => {
    for (const till of TILLS.filter((t) => t.state !== "unpaired")) {
      force(DB, till.id, false);
      const before = pairing(DB_BEFORE, till.user);
      const after = pairing(DB, till.user);
      const { cash_drawer_enabled: added, ...rest } = after;

      expect(Object.keys(after).sort()).toEqual([...Object.keys(before), "cash_drawer_enabled"].sort());
      expect(rest).toEqual(before);
      expect(added).toBe(false);
    }
  });

  it("an active Windows till whose owner turned it on reads true", () => {
    setEnabled(DB, OWNER_USER, WIN.id, true);

    expect(pairing(DB, WIN.user).cash_drawer_enabled).toBe(true);
    // A strict JSON boolean on the wire.
    expect(pairingText(DB, WIN.user)).toContain(`"cash_drawer_enabled": true`);
    force(DB, WIN.id, false);
  });

  it("stored ON reads false for a revoked till", () => {
    force(DB, REVOKED.id, true);

    const state = pairing(DB, REVOKED.user);

    expect(state.active).toBe(false);
    expect(state.cash_drawer_enabled).toBe(false);
    force(DB, REVOKED.id, false);
  });

  it("stored ON reads false for every non-Windows till", () => {
    for (const till of [ANDROID, WEB, NO_PLATFORM]) {
      force(DB, till.id, true);

      expect(pairing(DB, till.user).cash_drawer_enabled).toBe(false);
      force(DB, till.id, false);
    }
  });

  it("revoking an enabled till turns the answer false without touching the stored value", () => {
    force(DB, WIN_2.id, true);
    expect(pairing(DB, WIN_2.user).cash_drawer_enabled).toBe(true);

    sql(DB, `update public.paired_devices set revoked_at = now() where id = '${WIN_2.id}'`);

    expect(pairing(DB, WIN_2.user).cash_drawer_enabled).toBe(false);
    expect(stored(DB, WIN_2.id)).toBe("t");
  });

  it("the unpaired, not-paired and unauthenticated answers are byte-identical to before", () => {
    force(DB, UNPAIRED.id, true);

    for (const who of [UNPAIRED.user, STRANGER, ""]) {
      expect(pairingText(DB, who)).toBe(pairingText(DB_BEFORE, who));
    }

    expect(pairing(DB, UNPAIRED.user)).toEqual({ paired: false, reason: "unpaired" });
    force(DB, UNPAIRED.id, false);
  });

  it("its security posture and grants are identical to before", () => {
    const posture = (db: string) => sql(db, `
      select p.prosecdef, p.provolatile, p.prorettype::regtype, p.proconfig, p.proacl, pg_get_userbyid(p.proowner)
      from pg_proc p where p.oid = 'public.get_device_pairing_state()'::regprocedure`);

    expect(posture(DB)).toBe(posture(DB_BEFORE));
  });
});

// ---------------------------------------------------------------------------
// Nothing else moved
// ---------------------------------------------------------------------------

maybe("nothing else in the schema moved", () => {
  it("one function added, one redefined, every other definition identical", () => {
    const definitions = (db: string) => sql(db, `
      select string_agg(p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid)), E'\\n'
                        order by p.oid::regprocedure::text)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f'`);
    const toMap = (text: string) => new Map(text.split("\n").map((l) => l.split(":") as [string, string]));

    const before = toMap(definitions(DB_BEFORE));
    const after = toMap(definitions(DB));
    const added = [...after.keys()].filter((k) => !before.has(k));
    const removed = [...before.keys()].filter((k) => !after.has(k));
    const changed = [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k));

    expect(added).toEqual(["set_device_cash_drawer_enabled(uuid,boolean)"]);
    expect(removed).toEqual([]);
    expect(changed).toEqual(["get_device_pairing_state()"]);
  });

  it("the only table change is the one column; constraints, grants, RLS, policies, indexes and triggers are identical", () => {
    const shape = (db: string) => sql(db, `
      select md5(string_agg(x, E'\\n' order by x)) from (
        select 'col:' || table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') as x
          from information_schema.columns
          where table_schema = 'public' and not (table_name = 'paired_devices' and column_name = 'cash_drawer_enabled')
        union all
        select 'con:' || conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid)
          from pg_constraint where connamespace = 'public'::regnamespace
        union all
        select 'rel:' || c.relname || ':' || coalesce(c.relacl::text, '') || ':' || c.relrowsecurity::text || ':' || c.relforcerowsecurity::text
          from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'p')
        union all
        select 'pol:' || tablename || ':' || policyname || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '') from pg_policies where schemaname = 'public'
        union all
        select 'idx:' || indexname || ':' || indexdef from pg_indexes where schemaname = 'public'
        union all
        select 'trg:' || tgrelid::regclass::text || ':' || tgname || ':' || tgfoid::regprocedure::text
          from pg_trigger where not tgisinternal
      ) s`);

    expect(shape(DB)).toBe(shape(DB_BEFORE));
    expect(sql(DB, `
      select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'paired_devices'`))
      .toBe(String(Number(sql(DB_BEFORE, `
        select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'paired_devices'`)) + 1));
  });
});
