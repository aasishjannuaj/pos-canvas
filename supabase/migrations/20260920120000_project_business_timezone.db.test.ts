// v1.3 Feature 1B-RUNTIME CP2a — the business timezone, EXECUTED against a
// real PostgreSQL.
//
// WHY THIS FILE EXISTS. Its sibling `.test.ts` parses the SQL and asserts what
// it declares. That cannot show a single one of the behaviours this feature was
// actually specified in terms of: whether the backfill's tie-breaker really
// falls to the UUID, whether 1000 active employees fail ATOMICALLY, whether a
// reissued Employee ID really refuses a reactivation, or whether an unknown ID
// and a wrong PIN really come back indistinguishable. Those are runtime facts.
// Reading text can only ever assert that somebody wrote something that looks
// like them.
//
// HOW IT RUNS, AND WHAT IT COSTS. It creates a throwaway cluster in the OS temp
// directory on a loopback port, applies the repository's own migration files in
// order, runs the cases, and destroys the cluster. It adds NO dependency: it
// shells out to the `initdb`/`pg_ctl`/`psql` already installed alongside
// PostgreSQL. There is no Docker, no service container and no CI change.
//
// AND WHAT IT CANNOT DO. It needs a PostgreSQL SERVER on the machine. The repo
// has never had a test that touches a database — every other migration test is
// static — and no CI workflow runs the suite or provides PostgreSQL. So when no
// server is found this suite SKIPS LOUDLY rather than failing, and `npm test`
// stays runnable on a machine without PostgreSQL, exactly as it is today.
// Guaranteeing it always runs needs a CI test job with a PostgreSQL service,
// which is infrastructure to be authorized separately.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20260920120000_project_business_timezone.sql";

// ---------------------------------------------------------------------------
// Finding PostgreSQL
// ---------------------------------------------------------------------------

/**
 * The bin directory holding initdb, pg_ctl and psql, or null.
 *
 * PATH first, because a developer who put PostgreSQL on their PATH meant it.
 * The rest are the ordinary install prefixes on the platforms this repository
 * is developed on; none of them is treated as authoritative, and a miss is not
 * an error.
 */
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

  // ALL THREE, not just initdb and psql: the cluster is started and stopped
  // with pg_ctl, so a directory missing it would be accepted here and then fail
  // in beforeAll with something far less obvious than "no PostgreSQL found".
  return candidates.find(isCompletePostgresBin) ?? null;
}

const PG_BIN = findPostgresBin();
const PORT = 55500 + (process.pid % 400);

if (PG_BIN === null) {
  console.warn(
    `\n[${MIGRATION}] SKIPPED: no local PostgreSQL server found.` +
      "\n  These are the only tests that EXECUTE the migration; the static guards" +
      "\n  in the sibling .test.ts still ran. Install PostgreSQL 16+ to run them.\n"
  );
}

// ---------------------------------------------------------------------------
// The compatibility layer: ONLY what Supabase provides and vanilla does not
// ---------------------------------------------------------------------------

const COMPAT = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

-- Supabase's default privileges on public. This matters: it is why a new table
-- is born with ALL granted to the three roles, which is exactly what every
-- migration's revokes exist to undo. Without it the revokes are no-ops and the
-- migrations' own assertions would pass trivially.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create schema auth;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  created_at timestamptz not null default now()
);

-- auth.uid() as Supabase defines it: it reads the request JWT claim, which is
-- how these tests choose who is calling.
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

-- pgcrypto in "extensions", the same placement staging has, and the reason the
-- migration discovers the extension's schema instead of hardcoding it.
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

/** Runs SQL in `db` and returns unaligned, tuples-only output. */
function sql(db: string, statement: string): string {
  return pg("psql", [
    "-h", "127.0.0.1", "-p", String(PORT), "-U", "postgres", "-d", db,
    "-v", "ON_ERROR_STOP=1", "-Atq", "-c", statement,
  ]).trim();
}

/** Runs SQL and returns the error text instead of throwing. */
function sqlExpectingFailure(db: string, statement: string): string {
  try {
    sql(db, statement);
    return "";
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    return (err.stderr ?? err.message ?? "").toString();
  }
}

/**
 * The ONLY predecessors this harness is allowed to skip, named exactly.
 *
 * Both create Supabase Storage buckets and policies on `storage.objects`, a
 * schema the Supabase platform provides and a vanilla cluster does not have.
 * Neither touches employees, projects, devices, registers or orders, so their
 * absence cannot affect anything asserted in this file.
 *
 * EXACT FILENAMES, NOT A SUBSTRING MATCH. "contains the word storage" would
 * also match 20260803240000_order_counter_and_idempotency_scaffold.sql, which
 * applies perfectly well and whose failure must never be ignored.
 */
export const STORAGE_ONLY_MIGRATIONS = new Set([
  "20260729190422_build_artifact_storage.sql",
  "20260813120000_project_logo_storage.sql",
]);

/**
 * Applies one .sql file. THROWS on any failure, deliberately.
 *
 * There is no catch here and no catch at the call site. A predecessor that
 * fails leaves an incomplete schema, and every behavioural assertion below
 * would then be measuring the wrong database while reporting success -- which
 * is worse than no coverage, because it looks like coverage.
 */
function runSqlFile(db: string, file: string): void {
  pg("psql", [
    "-h", "127.0.0.1", "-p", String(PORT), "-U", "postgres", "-d", db,
    "-v", "ON_ERROR_STOP=1", "-q", "-f", file,
  ]);
}

/**
 * A database with every accepted migration applied and NOT the new one.
 */
function freshDatabase(name: string, withMigration: boolean): void {
  sql("postgres", `drop database if exists ${name}`);
  sql("postgres", `create database ${name}`);
  pg("psql", ["-h", "127.0.0.1", "-p", String(PORT), "-U", "postgres", "-d", name, "-q", "-f", "-"], COMPAT);

  const files = execFileSync("ls", [migrationsDir], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (file === MIGRATION && !withMigration) continue;

    // Skipped BEFORE it is attempted, by exact name. Anything else that fails
    // propagates and fails the suite.
    if (STORAGE_ONLY_MIGRATIONS.has(file)) continue;

    runSqlFile(name, join(migrationsDir, file));
    sql(name,
      `insert into supabase_migrations.schema_migrations(version, name)
       values ('${file.split("_")[0]}', '${file}') on conflict do nothing`);
  }
}

/** Applies ONLY the new migration, as the CLI does: one transaction. */
function applyMigration(db: string): { ok: boolean; error: string } {
  try {
    pg("psql", [
      "-h", "127.0.0.1", "-p", String(PORT), "-U", "postgres", "-d", db,
      "-v", "ON_ERROR_STOP=1", "--single-transaction", "-q",
      "-f", join(migrationsDir, MIGRATION),
    ]);
    return { ok: true, error: "" };
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    return { ok: false, error: (err.stderr ?? err.message ?? "").toString() };
  }
}

const OWNER = "11111111-1111-4111-8111-111111111111";

/** One project, with no timezone — the state every existing project is in. */
function seedProject(db: string, project: string, name: string): void {
  sql(db, `
    insert into auth.users (id) values ('${OWNER}') on conflict do nothing;
    insert into public.projects (id, user_id, name, template_id, config)
    values ('${project}', '${OWNER}', '${name}', 'cafe', '{}'::jsonb) on conflict do nothing;
  `);
}

const run = PG_BIN === null ? describe.skip : describe;

beforeAll(() => {
  if (PG_BIN === null) return;

  dataDir = mkdtempSync(join(tmpdir(), "pos-canvas-pg-"));
  pg("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust"]);
  pg("pg_ctl", [
    "-D", dataDir, "-l", join(dataDir, "server.log"), "-w", "start",
    "-o", `-c listen_addresses=127.0.0.1 -c port=${PORT} -c unix_socket_directories=''`,
  ]);
}, 180_000);

afterAll(() => {
  if (PG_BIN === null || dataDir === "") return;

  try {
    pg("pg_ctl", ["-D", dataDir, "-m", "immediate", "-w", "stop"]);
  } catch {
    // Already gone; the directory removal below is what matters.
  }

  rmSync(dataDir, { recursive: true, force: true });
}, 60_000);

// ===========================================================================
// The column
// ===========================================================================

run("the column, executed", () => {
  const DB = "cp2a_column";
  const LEGACY = "aaaa0001-0000-4000-8000-000000000001";

  beforeAll(() => {
    freshDatabase(DB, false);
    // A project created BEFORE this migration, exactly as every real one was.
    seedProject(DB, LEGACY, "Legacy");
    expect(applyMigration(DB).ok).toBe(true);
  }, 180_000);

  it("is text, nullable, and has no default", () => {
    expect(sql(DB, `select data_type || '|' || is_nullable || '|' || coalesce(column_default,'<none>')
                    from information_schema.columns
                    where table_schema='public' and table_name='projects'
                      and column_name='business_timezone'`)).toBe("text|YES|<none>");
  });

  it("an existing project survives the migration with NULL", () => {
    // No guess was made from UTC, the server clock, the address or anything
    // else. An absence can be detected later; a guess cannot.
    expect(sql(DB, `select coalesce(business_timezone,'<NULL>') from public.projects
                    where id='${LEGACY}'`)).toBe("<NULL>");
  });

  it("a valid timezone is accepted and stored VERBATIM", () => {
    sql(DB, `update public.projects set business_timezone='America/New_York' where id='${LEGACY}'`);

    expect(sql(DB, `select business_timezone from public.projects where id='${LEGACY}'`))
      .toBe("America/New_York");
  });

  it("and can be set back to NULL", () => {
    sql(DB, `update public.projects set business_timezone=null where id='${LEGACY}'`);
    expect(sql(DB, `select coalesce(business_timezone,'<NULL>') from public.projects
                    where id='${LEGACY}'`)).toBe("<NULL>");
    sql(DB, `update public.projects set business_timezone='America/New_York' where id='${LEGACY}'`);
  });

  it("an ordinary project update that never mentions it still works", () => {
    sql(DB, `update public.projects set name='Renamed' where id='${LEGACY}'`);

    expect(sql(DB, `select name || '|' || business_timezone from public.projects
                    where id='${LEGACY}'`)).toBe("Renamed|America/New_York");
  });
});

// ===========================================================================
// Validation — the database refuses, not the client
// ===========================================================================

run("validation, executed", () => {
  const DB = "cp2a_validation";
  const P = "aaaa0002-0000-4000-8000-000000000001";

  beforeAll(() => {
    freshDatabase(DB, false);
    seedProject(DB, P, "Validated");
    expect(applyMigration(DB).ok).toBe(true);
  }, 180_000);

  for (const zone of [
    "America/New_York",
    "America/Indiana/Indianapolis",
    "Europe/London",
    "Australia/Sydney",
    "Pacific/Auckland",
    "Asia/Kolkata",
    "US/Eastern",
  ]) {
    it(`accepts the real zone ${zone}`, () => {
      sql(DB, `update public.projects set business_timezone='${zone}' where id='${P}'`);
      expect(sql(DB, `select business_timezone from public.projects where id='${P}'`)).toBe(zone);
    });
  }

  for (const [zone, why] of [
    ["EST", "fixed offset, observes no DST"],
    ["MST", "fixed offset"],
    ["CET", "fixed offset"],
    ["UTC", "not a business's local calendar"],
    ["GMT", "not a business's local calendar"],
    ["Etc/GMT+5", "fixed offset AND sign-inverted"],
    ["Etc/UTC", "fixed offset"],
    ["Japan", "bare legacy name"],
    ["Not/AZone", "not a timezone at all"],
    ["america/new_york", "wrong case; tz names are case-sensitive"],
    ["America/New_York ", "trailing space"],
    ["", "empty"],
  ] as const) {
    it(`refuses ${JSON.stringify(zone)} — ${why}`, () => {
      const error = sqlExpectingFailure(DB,
        `update public.projects set business_timezone='${zone}' where id='${P}'`);

      expect(error).toContain("Invalid business timezone");
    });
  }

  it("a refusal leaves the previous value intact", () => {
    sql(DB, `update public.projects set business_timezone='Europe/London' where id='${P}'`);
    sqlExpectingFailure(DB, `update public.projects set business_timezone='EST' where id='${P}'`);

    expect(sql(DB, `select business_timezone from public.projects where id='${P}'`))
      .toBe("Europe/London");
  });

  it("an INSERT with an invalid zone is refused too", () => {
    const error = sqlExpectingFailure(DB, `
      insert into public.projects (id, user_id, name, template_id, config, business_timezone)
      values ('aaaa0003-0000-4000-8000-000000000001','${OWNER}','Bad','cafe','{}'::jsonb,'EST')`);

    expect(error).toContain("Invalid business timezone");
    expect(sql(DB, `select count(*) from public.projects where name='Bad'`)).toBe("0");
  });

  it("WHY those zones are refused: they do not move with DST", () => {
    // The measurement the rule rests on, not an assumption.
    expect(sql(DB, `
      select (timestamptz '2026-01-15 12:00:00+00' at time zone 'America/New_York')::time::text
          || ' -> ' ||
             (timestamptz '2026-07-15 12:00:00+00' at time zone 'America/New_York')::time::text`))
      .toBe("07:00:00 -> 08:00:00");

    expect(sql(DB, `
      select (timestamptz '2026-01-15 12:00:00+00' at time zone 'EST')::time::text
          || ' -> ' ||
             (timestamptz '2026-07-15 12:00:00+00' at time zone 'EST')::time::text`))
      .toBe("07:00:00 -> 07:00:00");
  });

  it("the validator is reachable as a function, and refuses NULL as invalid", () => {
    expect(sql(DB, `select public.is_valid_business_timezone('America/New_York')::text`)).toBe("true");
    expect(sql(DB, `select coalesce(public.is_valid_business_timezone(null)::text,'null')`)).toBe("false");
  });
});

// ===========================================================================
// The calendar foundation
// ===========================================================================

run("business-day boundaries, executed", () => {
  const DB = "cp2a_calendar";
  const NY = "America/New_York";

  beforeAll(() => {
    freshDatabase(DB, false);
    expect(applyMigration(DB).ok).toBe(true);
  }, 180_000);

  /** The measured length of one business day, in hours. */
  const hours = (date: string, zone = NY): number =>
    Number(sql(DB, `select (extract(epoch from (ends_at - starts_at))/3600)::numeric(6,2)
                    from public.business_day_bounds(date '${date}', '${zone}')`));

  it("1. an ordinary day is 24 hours", () => {
    expect(hours("2026-09-18")).toBe(24);
  });

  it("2. the spring-forward day is 23 hours — NOT forced to 24", () => {
    expect(hours("2026-03-08")).toBe(23);
  });

  it("3. the fall-back day is 25 hours — NOT forced to 24", () => {
    expect(hours("2026-11-01")).toBe(25);
  });

  it("4. the year boundary is ordinary, and the days touch exactly", () => {
    expect(hours("2026-12-31")).toBe(24);
    expect(hours("2027-01-01")).toBe(24);

    expect(sql(DB, `
      select (a.ends_at = b.starts_at)::text
      from public.business_day_bounds(date '2026-12-31','${NY}') a,
           public.business_day_bounds(date '2027-01-01','${NY}') b`)).toBe("true");
  });

  it("PROOF it is calendar arithmetic, not + interval '24 hours'", () => {
    // If the end were computed by adding a day-length, the spring-forward day
    // would end an hour into the next one and its last local hour would be
    // filed under the wrong business date, every year.
    expect(sql(DB, `
      select (b.ends_at = b.starts_at + interval '24 hours')::text
      from public.business_day_bounds(date '2026-03-08','${NY}') b`)).toBe("false");

    expect(sql(DB, `
      select (b.ends_at = b.starts_at + interval '24 hours')::text
      from public.business_day_bounds(date '2026-11-01','${NY}') b`)).toBe("false");
  });

  it("the UTC offset really changes across the spring-forward boundary", () => {
    // Asserted as the offsets themselves rather than as rendered text, which
    // psql prints in the SESSION timezone and would not show the local one.
    expect(sql(DB, `
      select (b.starts_at at time zone '${NY}')::text || ' local starts, offset '
          || to_char(b.starts_at at time zone '${NY}' - b.starts_at, 'HH24:MI')
      from public.business_day_bounds(date '2026-03-08','${NY}') b`))
      .toBe("2026-03-08 00:00:00 local starts, offset -05:00");
  });

  it("a southern-hemisphere zone shifts the other way", () => {
    // Sydney's DST runs opposite to New York's, so the short day is in October.
    expect(hours("2026-10-04", "Australia/Sydney")).toBe(23);
    expect(hours("2026-04-05", "Australia/Sydney")).toBe(25);
  });

  it("a zone without DST has 24-hour days all year", () => {
    expect(hours("2026-03-08", "Asia/Kolkata")).toBe(24);
    expect(hours("2026-11-01", "Asia/Kolkata")).toBe(24);
  });

  it("business_date_of is the exact inverse", () => {
    // The last instant of a day belongs to it; the first instant of the next
    // does not. That is what makes every sale land in exactly one day.
    expect(sql(DB, `
      select public.business_date_of(b.starts_at, '${NY}')::text
          || '|' || public.business_date_of(b.ends_at - interval '1 microsecond', '${NY}')::text
          || '|' || public.business_date_of(b.ends_at, '${NY}')::text
      from public.business_day_bounds(date '2026-09-18','${NY}') b`))
      .toBe("2026-09-18|2026-09-18|2026-09-19");
  });

  it("an invalid zone yields nothing rather than a wrong answer", () => {
    expect(sql(DB, `select count(*) from public.business_day_bounds(date '2026-09-18','Not/AZone')`))
      .toBe("0");
    expect(sql(DB, `select count(*) from public.business_day_bounds(date '2026-09-18','EST')`))
      .toBe("0");
    expect(sql(DB, `select coalesce(public.business_date_of(now(),'EST')::text,'<null>')`))
      .toBe("<null>");
  });
});

// ===========================================================================
// The domain failure CP2b will rely on
// ===========================================================================

run("require_business_timezone, executed", () => {
  const DB = "cp2a_require";
  const SET = "aaaa0004-0000-4000-8000-000000000001";
  const UNSET = "aaaa0005-0000-4000-8000-000000000001";

  beforeAll(() => {
    freshDatabase(DB, false);
    seedProject(DB, SET, "HasZone");
    seedProject(DB, UNSET, "NoZone");
    expect(applyMigration(DB).ok).toBe(true);
    sql(DB, `update public.projects set business_timezone='America/New_York' where id='${SET}'`);
  }, 180_000);

  it("returns the zone when one is set", () => {
    expect(sql(DB, `select public.require_business_timezone('${SET}')`)).toBe("America/New_York");
  });

  it("raises business_timezone_required when none is set", () => {
    expect(sqlExpectingFailure(DB, `select public.require_business_timezone('${UNSET}')`))
      .toContain("business_timezone_required");
  });

  it("and says the same thing for a project that does not exist", () => {
    // A caller holding an id it has no right to must not learn whether the
    // project is real.
    expect(sqlExpectingFailure(DB,
      `select public.require_business_timezone('aaaa9999-0000-4000-8000-000000000001')`))
      .toContain("business_timezone_required");
  });
});

// ===========================================================================
// Scope: CP2a adds no register behaviour
// ===========================================================================

const CP2A_FUNCTIONS = [
  "public.is_valid_business_timezone(text)",
  "public.business_day_bounds(date,text)",
  "public.business_date_of(timestamptz,text)",
  "public.require_business_timezone(uuid)",
  "public.projects_validate_business_timezone()",
] as const;

run("CP2a stays inside its scope", () => {
  const DB = "cp2a_scope";

  beforeAll(() => {
    freshDatabase(DB, false);
    expect(applyMigration(DB).ok).toBe(true);
  }, 180_000);

  it("adds no daily-register columns", () => {
    expect(sql(DB, `select count(*) from information_schema.columns
                    where table_schema='public' and table_name='register_sessions'
                      and column_name in ('business_date','business_timezone','is_daily')`)).toBe("0");
  });

  it("creates no ensure_daily_register_context", () => {
    expect(sql(DB, `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='ensure_daily_register_context'`)).toBe("0");
  });

  it("leaves register_sessions and complete_sale_v5 exactly as they were", () => {
    expect(sql(DB, `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname in
                      ('complete_sale_v5','open_register_session','close_register_session',
                       'get_current_register_session')`)).toBe("4");
    expect(sql(DB, `select count(*) from pg_indexes where schemaname='public'
                    and indexname='register_sessions_one_open_per_device'`)).toBe("1");
  });

  it("no CP2a function is executable by ANY client role", () => {
    // EFFECTIVE privileges, via has_function_privilege — not a substring search
    // of proacl. The first draft of this suite checked the ACL text for `anon`
    // and `service_role` and passed while `authenticated` held EXECUTE on all
    // five, granted by Supabase's ALTER DEFAULT PRIVILEGES rather than by the
    // migration. A privilege you did not grant is still a privilege.
    for (const fn of CP2A_FUNCTIONS) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(`${role} can execute ${fn}: ${sql(DB, `select has_function_privilege('${role}','${fn}','EXECUTE')::text`)}`)
          .toBe(`${role} can execute ${fn}: false`);
      }
    }
  });

  it("only the two that need elevation are SECURITY DEFINER", () => {
    // require_business_timezone reads an RLS-protected table; the trigger body
    // must run as its owner so it can call the revoked validator.
    for (const fn of ["require_business_timezone", "projects_validate_business_timezone"]) {
      expect(`${fn} prosecdef: ${sql(DB, `select p.prosecdef::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='${fn}'`)}`)
        .toBe(`${fn} prosecdef: true`);
    }

    // The three pure helpers read only pg_timezone_names, which every role may
    // read. Elevating them would be a privileged entry point bought for nothing.
    for (const fn of ["is_valid_business_timezone", "business_day_bounds", "business_date_of"]) {
      expect(`${fn} prosecdef: ${sql(DB, `select p.prosecdef::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='${fn}'`)}`)
        .toBe(`${fn} prosecdef: false`);
    }
  });

  it("all five still pin their search_path", () => {
    expect(sql(DB, `
      select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public'
        and p.proname in ('is_valid_business_timezone','business_day_bounds',
                          'business_date_of','require_business_timezone',
                          'projects_validate_business_timezone')
        and p.proconfig @> array['search_path=public, pg_catalog, pg_temp']`)).toBe("5");
  });

  it("projects RLS is untouched — four owner-scoped policies", () => {
    expect(sql(DB, `select count(*) from pg_policies
                    where schemaname='public' and tablename='projects'`)).toBe("4");
    expect(sql(DB, `select relrowsecurity::text from pg_class
                    where oid='public.projects'::regclass`)).toBe("true");
  });
});

// ===========================================================================
// Real authorization scenarios, executed as the roles themselves
// ===========================================================================

run("authorization, executed as an authenticated owner", () => {
  const DB = "cp2a_authz";
  const MINE = "aaaa0001-0000-4000-8000-000000000001";
  const THEIRS = "aaaa0002-0000-4000-8000-000000000001";
  const ME = "11111111-1111-4111-8111-111111111111";
  const THEM = "22222222-2222-4222-8222-222222222222";

  /** Runs a statement as the `authenticated` role, with a JWT subject bound. */
  const asOwner = (who: string, statement: string): string =>
    sql(DB, `set role authenticated; set request.jwt.claim.sub='${who}'; ${statement}`)
      .split("\n").filter((l) => l !== "").slice(-1)[0] ?? "";

  const asOwnerExpectingFailure = (who: string, statement: string): string =>
    sqlExpectingFailure(DB, `set role authenticated; set request.jwt.claim.sub='${who}'; ${statement}`);

  beforeAll(() => {
    freshDatabase(DB, false);
    sql(DB, `
      insert into auth.users (id) values ('${ME}'), ('${THEM}') on conflict do nothing;
      insert into public.projects (id, user_id, name, template_id, config) values
        ('${MINE}', '${ME}', 'Mine', 'cafe', '{}'::jsonb),
        ('${THEIRS}', '${THEM}', 'Theirs', 'cafe', '{}'::jsonb);
      grant usage on schema public to authenticated;
    `);
    expect(applyMigration(DB).ok).toBe(true);
  }, 180_000);

  it("1. an owner may set their own project's timezone, NULL -> America/New_York", () => {
    // Through the ordinary RLS-protected table write. No RPC, and no EXECUTE on
    // anything: the trigger fires regardless, because firing a trigger does not
    // check the caller's privilege on the trigger function.
    asOwner(ME, `update public.projects set business_timezone='America/New_York' where id='${MINE}';`);

    expect(sql(DB, `select business_timezone from public.projects where id='${MINE}'`))
      .toBe("America/New_York");
  });

  it("2. an invalid value is refused by the trigger, for that same owner", () => {
    expect(asOwnerExpectingFailure(ME, `update public.projects set business_timezone='EST' where id='${MINE}';`))
      .toContain("Invalid business timezone EST");

    // And the previous value survives the refusal.
    expect(sql(DB, `select business_timezone from public.projects where id='${MINE}'`))
      .toBe("America/New_York");
  });

  it("3. an owner may return it to NULL", () => {
    asOwner(ME, `update public.projects set business_timezone=null where id='${MINE}';`);
    expect(sql(DB, `select coalesce(business_timezone,'<NULL>') from public.projects where id='${MINE}'`))
      .toBe("<NULL>");

    asOwner(ME, `update public.projects set business_timezone='America/New_York' where id='${MINE}';`);
  });

  it("4. one owner cannot touch another owner's timezone", () => {
    // RLS makes the row invisible to the UPDATE, so it affects nothing at all.
    asOwner(ME, `update public.projects set business_timezone='Europe/London' where id='${THEIRS}';`);

    expect(sql(DB, `select coalesce(business_timezone,'<NULL>') from public.projects where id='${THEIRS}'`))
      .toBe("<NULL>");
  });

  it("5. an authenticated client cannot call require_business_timezone directly", () => {
    // The whole point of the correction: it is SECURITY DEFINER over an
    // RLS-protected table and takes a project id as an argument, so EXECUTE
    // would let any client nominate any project and read past the owner policy.
    expect(asOwnerExpectingFailure(ME, `select public.require_business_timezone('${THEIRS}');`))
      .toContain("permission denied for function require_business_timezone");
  });

  it("6. nor the trigger function, which is not an RPC surface", () => {
    expect(asOwnerExpectingFailure(ME, `select public.projects_validate_business_timezone();`))
      .toContain("permission denied for function projects_validate_business_timezone");
  });

  it("6b. nor any of the pure helpers", () => {
    for (const [fn, call] of [
      ["is_valid_business_timezone", `select public.is_valid_business_timezone('America/New_York');`],
      ["business_date_of", `select public.business_date_of(now(),'America/New_York');`],
      ["business_day_bounds", `select * from public.business_day_bounds(current_date,'America/New_York');`],
    ] as const) {
      expect(asOwnerExpectingFailure(ME, call)).toContain(`permission denied for function ${fn}`);
    }
  });

  it("7. internal execution still returns the stored timezone", () => {
    expect(sql(DB, `select public.require_business_timezone('${MINE}')`)).toBe("America/New_York");
  });

  it("8. and still raises business_timezone_required for NULL", () => {
    expect(sqlExpectingFailure(DB, `select public.require_business_timezone('${THEIRS}')`))
      .toContain("business_timezone_required");
  });

  it("the calendar is unchanged by the privilege correction", () => {
    expect(sql(DB, `select (extract(epoch from (ends_at-starts_at))/3600)::numeric(6,2)::text
                    from public.business_day_bounds(date '2026-03-08','America/New_York')`)).toBe("23.00");
  });
});
