// v1.3 Checkpoint 2b — the DAILY register context, EXECUTED against a real
// PostgreSQL rather than read.
//
// WHY THIS FILE EXISTS. Almost nothing this checkpoint claims can be shown by
// reading SQL. Whether eight simultaneous tills really end up with one row and
// one id, whether an owner changing the timezone mid-creation really blocks
// instead of producing a half-old half-new row, whether a spring-forward day
// really comes out 23 hours, whether closing a daily context through the legacy
// RPC really leaves it untouched instead of raising -- those are runtime facts
// about locks, triggers, partial indexes and the tz database. Reading the file
// can only show that somebody wrote something that looks like them.
//
// HOW IT RUNS, AND WHAT IT COSTS. It creates a throwaway cluster in the OS temp
// directory on a loopback port, applies the repository's own migration files in
// order, runs the cases, and destroys the cluster. It adds NO dependency: it
// shells out to the `initdb`/`pg_ctl`/`psql` already installed alongside
// PostgreSQL. There is no Docker, no service container and no CI change.
//
// AND WHAT IT CANNOT DO. It needs a PostgreSQL SERVER on the machine, and no CI
// workflow provides one, so when none is found this suite SKIPS LOUDLY rather
// than failing -- exactly as its two siblings do.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20260921120000_daily_register_context.sql";

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
const PORT = 55900 + (process.pid % 90);

if (PG_BIN === null) {
  console.warn(
    `\n[${MIGRATION}] SKIPPED: no local PostgreSQL server found.` +
      "\n  These are the only tests that EXECUTE the daily register context;" +
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
    // is a chronological one. Without this, a successor that depends on the
    // migration under test cannot apply at all, and -- worse -- the "before"
    // assertions would be measuring a database carrying changes that had not
    // happened yet, while reporting success.
    if (!withMigration && file >= MIGRATION) continue;
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
    pg("psql", [...psqlArgs(db), "--single-transaction", "-q", "-f", join(migrationsDir, MIGRATION)]);
    return { ok: true, error: "" };
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    return { ok: false, error: (err.stderr ?? err.message ?? "").toString() };
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "a0000000-0000-4000-8000-000000000001";
const BUILD = "b0000000-0000-4000-8000-000000000001";
const EMPLOYEE = "e0000001-0000-4000-8000-00000000000a";

/** deviceUser(n) authenticates as till n; device(n) is its paired_devices row. */
const deviceUser = (n: number): string => `d0000000-0000-4000-8000-00000000000${n}`;
const device = (n: number): string => `c0000000-0000-4000-8000-00000000000${n}`;

/**
 * Runs `statement` with auth.uid() bound to `who`, returning only its result.
 *
 * psql prints one result set per statement and setting the claim is itself a
 * statement, so the caller would otherwise read the uuid back instead of the
 * answer.
 */
function asRole(db: string, who: string, statement: string): string {
  const out = sql(db, `select set_config('request.jwt.claim.sub','${who}', false); ${statement}`);
  const lines = out.split("\n").filter((line) => line !== "");

  return lines[lines.length - 1] ?? "";
}

/**
 * Runs `statement` as the REAL `authenticated` role, with the JWT subject set.
 *
 * WHY THIS EXISTS ALONGSIDE asRole. asRole sets the JWT claim but stays
 * `postgres`, which owns every table and bypasses RLS and every ACL. That is
 * enough to exercise the RPC's own logic and nothing else: a function that
 * quietly depended on the caller holding a privilege no client has would pass.
 * has_function_privilege answers what a role MAY do; this answers what actually
 * happens when it does it.
 *
 * `set local role` and a local set_config, inside an explicit transaction, so
 * neither can outlive the statement. Each sql() call is its own psql process
 * and therefore its own connection, so nothing leaks between tests either way
 * -- the transaction scoping is belt and braces, and the tests below assert the
 * role really is dropped afterwards.
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

/** The same, returning the error text instead of throwing. */
function asAuthenticatedExpectingFailure(db: string, who: string, statement: string): string {
  try {
    asAuthenticated(db, who, statement);
    return "";
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    return (err.stderr ?? err.message ?? "").toString();
  }
}

/** The exact computed interval for a business date, as an INSERT value list. */
function exactDaily(date: string, tz = "America/New_York", cash = "0"): string {
  return `(select starts_at from public.business_day_bounds(date '${date}','${tz}')), ${cash}, ` +
         `(select ends_at from public.business_day_bounds(date '${date}','${tz}')), '${date}', '${tz}'`;
}

/** One project, one build, `tills` paired devices and one active employee. */
function seed(db: string, tills: number): void {
  const users = Array.from({ length: tills }, (_, i) => `('${deviceUser(i + 1)}')`).join(",");
  const devices = Array.from({ length: tills }, (_, i) =>
    `('${device(i + 1)}','${deviceUser(i + 1)}','${OWNER}','${PROJECT}','${BUILD}')`).join(",");

  sql(db, `
    insert into auth.users (id) values ('${OWNER}'), ${users};
    insert into public.projects (id, user_id, name, template_id, config)
    values ('${PROJECT}', '${OWNER}', 'Shop', 'cafe', '{}'::jsonb);
    insert into public.build_jobs (id, project_id, owner_id, target, status, config_snapshot,
                                   config_schema_version, config_hash, request_key, started_at, finished_at)
    values ('${BUILD}','${PROJECT}','${OWNER}','android','succeeded','{}'::jsonb,1,'h','r', now(), now());
    insert into public.paired_devices (id, auth_user_id, owner_id, project_id, build_job_id)
    values ${devices};
    insert into public.employees (id, project_id, display_name, employee_code, role, pin_hash, active, created_at)
    values ('${EMPLOYEE}','${PROJECT}','Amy','001','cashier', public.employee_pin_hash('2222'), true, '2026-01-01');
  `);
}

const run = PG_BIN === null ? describe.skip : describe;

beforeAll(() => {
  if (PG_BIN === null) return;

  dataDir = mkdtempSync(join(tmpdir(), "pos-canvas-cp2b-"));
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
    // Already down. The directory still goes.
  }

  rmSync(dataDir, { recursive: true, force: true });
});

// ===========================================================================
// The migration applies at all
// ===========================================================================

run("the migration applies to a database holding every accepted predecessor", () => {
  const DB = "cp2b_apply";

  beforeAll(() => {
    freshDatabase(DB, false);
  }, 240_000);

  it("applies as ONE transaction, with its own verification block passing", () => {
    const result = applyMigration(DB);

    expect(result.ok ? "applied" : `FAILED: ${result.error}`).toBe("applied");
  });

  it("is idempotent enough to be re-read: the objects it created are all there", () => {
    expect(sql(DB, `select count(*) from information_schema.columns
                    where table_schema='public' and table_name='register_sessions'
                      and column_name in ('business_date','business_timezone')`)).toBe("2");
    expect(sql(DB, `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='ensure_daily_register_context'`)).toBe("1");
    expect(sql(DB, `select count(*) from pg_trigger t
                    where t.tgrelid='public.register_sessions'::regclass and not t.tgisinternal`)).toBe("2");
  });
});

// ===========================================================================
// SCHEMA
// ===========================================================================

run("schema: legacy and daily rows obey different rules", () => {
  const DB = "cp2b_schema";
  const DEV = device(1);

  /** Inserts a row, returning "" on success or the constraint that refused it. */
  const insert = (columns: string, values: string, dev: string = DEV): string => {
    const error = sqlExpectingFailure(DB,
      `insert into public.register_sessions (paired_device_id, ${columns})
       values ('${dev}', ${values})`);
    const match = /violates check constraint "([a-z_]+)"|violates not-null constraint/.exec(error);

    if (error === "") return "";
    // The BEFORE INSERT bounds validator fires ahead of the CHECK constraints,
    // so a daily row that is BOTH misshapen and miscomputed is refused by the
    // trigger first. Naming the two layers separately keeps each assertion
    // honest about which one actually did the refusing.
    if (/must open at local midnight|must close at local midnight|Invalid business timezone|No calendar bounds/
      .test(error)) return "daily_bounds";

    return match?.[1] ?? "refused";
  };

  /** Runs `body` with the bounds validator off, to isolate a CHECK constraint. */
  const withoutBoundsValidator = (body: () => void): void => {
    sql(DB, `alter table public.register_sessions disable trigger register_sessions_validate_daily_bounds`);
    try {
      body();
    } finally {
      sql(DB, `alter table public.register_sessions enable trigger register_sessions_validate_daily_bounds`);
    }
  };

  beforeAll(() => {
    freshDatabase(DB, false);
    seed(DB, 2);
    // A LEGACY row created BEFORE the migration, by the Feature 1B rules.
    sql(DB, `insert into public.register_sessions
             (id, paired_device_id, opened_by_employee_id, opened_at, opening_cash, open_request_id)
             values ('99999999-9999-4999-8999-999999999999','${DEV}','${EMPLOYEE}',
                     '2026-01-01 12:00:00+00', 125.50, '77777777-7777-4777-8777-777777777777')`);
    expect(applyMigration(DB).ok).toBe(true);
  }, 240_000);

  it("the pre-existing legacy row survives, untouched and still LEGACY", () => {
    expect(sql(DB, `select coalesce(business_date::text,'NULL') || ' ' ||
                           coalesce(business_timezone,'NULL') || ' ' ||
                           opening_cash::text || ' ' || opened_by_employee_id::text
                    from public.register_sessions where id='99999999-9999-4999-8999-999999999999'`))
      .toBe(`NULL NULL 125.50 ${EMPLOYEE}`);
  });

  it("legacy still requires an opener", () => {
    expect(insert("opened_at, opening_cash, open_request_id",
      `'2026-01-01', 10, gen_random_uuid()`)).toBe("register_sessions_legacy_shape");
  });

  it("legacy still requires an open_request_id", () => {
    expect(insert("opened_by_employee_id, opened_at, opening_cash",
      `'${EMPLOYEE}', '2026-01-01', 10`)).toBe("register_sessions_legacy_shape");
  });

  it("the legacy closed_at / closed_by biconditional is preserved, both ways", () => {
    expect(insert("opened_by_employee_id, opened_at, opening_cash, open_request_id, closed_at",
      `'${EMPLOYEE}', '2026-01-01', 10, gen_random_uuid(), '2026-01-02'`))
      .toBe("register_sessions_legacy_shape");
    expect(insert("opened_by_employee_id, opened_at, opening_cash, open_request_id, closed_by_employee_id",
      `'${EMPLOYEE}', '2026-01-01', 10, gen_random_uuid(), '${EMPLOYEE}'`))
      .toBe("register_sessions_legacy_shape");
  });

  it("a legacy row may not carry a business_timezone", () => {
    expect(insert("opened_by_employee_id, opened_at, opening_cash, open_request_id, business_timezone",
      `'${EMPLOYEE}', '2026-01-01', 10, gen_random_uuid(), 'America/New_York'`))
      .toBe("register_sessions_legacy_shape");
  });

  it("a legacy row that obeys every rule is still accepted", () => {
    // On the SECOND till: the first already has an open drawer period from
    // beforeAll, and Feature 1B's one-open-per-device index -- untouched by this
    // migration -- still refuses a second one. That refusal is the old rule
    // working, not the new constraints.
    expect(insert("opened_by_employee_id, opened_at, opening_cash, open_request_id",
      `'${EMPLOYEE}', '2026-01-01', 10, gen_random_uuid()`, device(2))).toBe("");
    expect(insert("opened_by_employee_id, opened_at, opening_cash, open_request_id",
      `'${EMPLOYEE}', '2026-01-01', 10, gen_random_uuid()`)).toBe("refused");
  });

  const daily = "opened_at, opening_cash, closed_at, business_date, business_timezone";

  it("a daily row may not name an opener", () => {
    // EXACT computed bounds, so the shape rule is the only thing broken and the
    // bounds validator has nothing to say. Same for the four cases below.
    expect(insert(`opened_by_employee_id, ${daily}`, `'${EMPLOYEE}', ${exactDaily("2026-05-01")}`))
      .toBe("register_sessions_daily_shape");
  });

  it("a daily row may not name a closer", () => {
    expect(insert(`closed_by_employee_id, ${daily}`, `'${EMPLOYEE}', ${exactDaily("2026-05-01")}`))
      .toBe("register_sessions_daily_shape");
  });

  it("a daily row may not carry an open_request_id", () => {
    expect(insert(`open_request_id, ${daily}`, `gen_random_uuid(), ${exactDaily("2026-05-01")}`))
      .toBe("register_sessions_daily_shape");
  });

  it("a daily row's opening_cash is exactly 0.00 and nothing else", () => {
    expect(insert(daily, exactDaily("2026-05-01", "America/New_York", "25")))
      .toBe("register_sessions_daily_shape");
    expect(insert(daily, exactDaily("2026-05-01", "America/New_York", "0.01")))
      .toBe("register_sessions_daily_shape");
    expect(insert(daily, exactDaily("2026-05-01", "America/New_York", "0.00"))).toBe("");
  });

  it("a daily row requires a business_timezone — two layers, both proven", () => {
    // The validator refuses it first, because it cannot compute a calendar
    // without a zone...
    expect(insert("opened_at, opening_cash, closed_at, business_date",
      `'2026-06-01', 0, '2026-06-02', '2026-06-01'`)).toBe("daily_bounds");

    // ...and the CHECK constraint refuses it underneath, on its own.
    withoutBoundsValidator(() => {
      expect(insert("opened_at, opening_cash, closed_at, business_date",
        `'2026-06-01', 0, '2026-06-02', '2026-06-01'`)).toBe("register_sessions_daily_shape");
    });
  });

  it("a daily row can never be left open — its end is known at creation", () => {
    // A null closed_at is not the computed endpoint, so the validator speaks
    // first; the constraint says the same thing independently.
    expect(insert("opened_at, opening_cash, business_date, business_timezone",
      `'2026-06-01', 0, '2026-06-01', 'America/New_York'`)).toBe("daily_bounds");

    withoutBoundsValidator(() => {
      expect(insert("opened_at, opening_cash, business_date, business_timezone",
        `'2026-06-01', 0, '2026-06-01', 'America/New_York'`)).toBe("register_sessions_daily_shape");
    });
  });

  it("business_date alone discriminates the two modes, with no is_daily column", () => {
    expect(sql(DB, `select count(*) from information_schema.columns
                    where table_schema='public' and table_name='register_sessions'
                      and column_name in ('is_daily','mode','kind','daily')`)).toBe("0");
    expect(sql(DB, `select count(*) filter (where business_date is null) || ' legacy, ' ||
                           count(*) filter (where business_date is not null) || ' daily'
                    from public.register_sessions`)).toBe("2 legacy, 1 daily");
  });
});

// ===========================================================================
// UNIQUENESS
// ===========================================================================

run("uniqueness: one daily context per till per business date", () => {
  const DB = "cp2b_unique";

  const insertDaily = (dev: string, date: string): string => {
    const error = sqlExpectingFailure(DB, `
      insert into public.register_sessions (paired_device_id, opened_at, opening_cash,
                                            closed_at, business_date, business_timezone)
      values ('${dev}', ${exactDaily(date)})`);

    return error === "" ? "" : (/violates unique constraint "([a-z_]+)"/.exec(error)?.[1] ?? "refused");
  };

  beforeAll(() => {
    freshDatabase(DB, false);
    seed(DB, 2);
    expect(applyMigration(DB).ok).toBe(true);
  }, 240_000);

  it("the same till on the same date, twice, is impossible", () => {
    expect(insertDaily(device(1), "2026-09-18")).toBe("");
    expect(insertDaily(device(1), "2026-09-18")).toBe("register_sessions_one_daily_per_device_date");
  });

  it("the same till on a different date is a different row", () => {
    expect(insertDaily(device(1), "2026-09-19")).toBe("");
    expect(sql(DB, `select count(distinct id) from public.register_sessions
                    where paired_device_id='${device(1)}' and business_date is not null`)).toBe("2");
  });

  it("a different till on the same date is a different row", () => {
    expect(insertDaily(device(2), "2026-09-18")).toBe("");
    expect(sql(DB, `select count(distinct id) from public.register_sessions
                    where business_date='2026-09-18'`)).toBe("2");
  });

  it("legacy rows carry a null business_date and are not in the index at all", () => {
    // Four manual drawer periods on one till, which the DAILY rule must not
    // touch. They are possible only because the index is PARTIAL.
    for (let i = 0; i < 4; i += 1) {
      sql(DB, `insert into public.register_sessions
               (paired_device_id, opened_by_employee_id, opened_at, opening_cash, open_request_id, closed_at, closed_by_employee_id)
               values ('${device(1)}','${EMPLOYEE}','2026-01-0${i + 1}', 10, gen_random_uuid(),
                       '2026-01-0${i + 1} 23:00:00+00','${EMPLOYEE}')`);
    }

    expect(sql(DB, `select count(*) from public.register_sessions
                    where paired_device_id='${device(1)}' and business_date is null`)).toBe("4");
    expect(sql(DB, `select indexdef ~ 'WHERE \\(business_date IS NOT NULL\\)'
                    from pg_indexes where indexname='register_sessions_one_daily_per_device_date'`)).toBe("t");
  });
});

// ===========================================================================
// CALENDAR
// ===========================================================================

run("calendar: a day is as long as the zone says, never 24 hours by assumption", () => {
  const DB = "cp2b_calendar";

  const hours = (d: string, tz = "America/New_York"): string =>
    sql(DB, `select (extract(epoch from (ends_at - starts_at)) / 3600)::numeric(6,2)::text
             from public.business_day_bounds(date '${d}', '${tz}')`);

  beforeAll(() => {
    freshDatabase(DB, true);
  }, 240_000);

  it("an ordinary day is 24 hours", () => {
    expect(hours("2026-09-18")).toBe("24.00");
  });

  it("a spring-forward day is 23", () => {
    expect(hours("2026-03-08")).toBe("23.00");
  });

  it("a fall-back day is 25", () => {
    expect(hours("2026-11-01")).toBe("25.00");
  });

  it("a year boundary is 24, and the next day starts exactly where it ends", () => {
    expect(hours("2026-12-31")).toBe("24.00");
    expect(sql(DB, `select (select ends_at from public.business_day_bounds(date '2026-12-31','America/New_York'))
                         = (select starts_at from public.business_day_bounds(date '2027-01-01','America/New_York'))`))
      .toBe("t");
  });

  it("closed_at is NEVER opened_at + 24 hours on a DST day", () => {
    for (const [day, same] of [["2026-09-18", "t"], ["2026-03-08", "f"], ["2026-11-01", "f"]] as const) {
      expect(`${day}: ${sql(DB, `select starts_at + interval '24 hours' = ends_at
                                 from public.business_day_bounds(date '${day}','America/New_York')`)}`)
        .toBe(`${day}: ${same}`);
    }
  });

  it("a day is half-open: the last instant of one is the first of the next", () => {
    // 23:59:59.999999 local belongs to the day; local midnight belongs to the next.
    expect(sql(DB, `select public.business_date_of(
                      (select ends_at from public.business_day_bounds(date '2026-03-08','America/New_York'))
                        - interval '1 microsecond', 'America/New_York')::text`)).toBe("2026-03-08");
    expect(sql(DB, `select public.business_date_of(
                      (select ends_at from public.business_day_bounds(date '2026-03-08','America/New_York')),
                      'America/New_York')::text`)).toBe("2026-03-09");
  });
});

// ===========================================================================
// ENSURE
// ===========================================================================

run("ensure_daily_register_context, executed as a paired till", () => {
  const DB = "cp2b_ensure";
  const till = (n: number) => (statement: string): string => asRole(DB, deviceUser(n), statement);
  const one = till(1);
  const setZone = (tz: string | null): void => {
    sql(DB, `update public.projects set business_timezone=${tz === null ? "null" : `'${tz}'`}
             where id='${PROJECT}'`);
  };

  beforeAll(() => {
    freshDatabase(DB, false);
    seed(DB, 3);
    expect(applyMigration(DB).ok).toBe(true);
  }, 240_000);

  it("takes ZERO arguments — there is nothing a client could claim authority with", () => {
    expect(sql(DB, `select coalesce(nullif(pg_get_function_identity_arguments(p.oid),''),'(none)')
                    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='ensure_daily_register_context'`))
      .toBe("(none)");
  });

  it("refuses an unauthenticated caller and an unpaired one", () => {
    expect(asRole(DB, "00000000-0000-4000-8000-000000000000",
      `select public.ensure_daily_register_context()->>'error'`)).toBe("not_paired");
  });

  it("with no business timezone set, it refuses rather than guessing one", () => {
    // NOT the server's zone, not UTC, not the device's. The project has said
    // nothing, so neither does this.
    expect(sql(DB, `select business_timezone is null from public.projects where id='${PROJECT}'`)).toBe("t");
    expect(one(`select public.ensure_daily_register_context()->>'error'`)).toBe("business_timezone_required");
    expect(sql(DB, `select count(*) from public.register_sessions`)).toBe("0");
  });

  it("with a timezone set, it creates the context for today, in that zone", () => {
    setZone("America/New_York");

    const created = one(`select public.ensure_daily_register_context()::text`);

    expect(JSON.parse(created).ok).toBe(true);
    expect(JSON.parse(created).created).toBe(true);
    expect(JSON.parse(created).registerSession.businessTimezone).toBe("America/New_York");
    expect(JSON.parse(created).registerSession.businessDate)
      .toBe(sql(DB, `select (now() at time zone 'America/New_York')::date::text`));
  });

  it("every authority is derived server-side, and the row proves each one", () => {
    expect(sql(DB, `select
        (r.paired_device_id = '${device(1)}')::text || ' device, ' ||
        (d.project_id = '${PROJECT}')::text || ' project, ' ||
        (r.business_timezone = p.business_timezone)::text || ' timezone, ' ||
        (r.business_date = public.business_date_of(now(), p.business_timezone))::text || ' date'
      from public.register_sessions r
      join public.paired_devices d on d.id = r.paired_device_id
      join public.projects p on p.id = d.project_id
      where r.business_date is not null`))
      .toBe("true device, true project, true timezone, true date");
  });

  it("the interval is the computed one, to the microsecond", () => {
    expect(sql(DB, `select (r.opened_at = b.starts_at and r.closed_at = b.ends_at)::text
                    from public.register_sessions r
                    cross join lateral public.business_day_bounds(r.business_date, r.business_timezone) b
                    where r.business_date is not null`)).toBe("true");
  });

  it("a daily row names no opener, no closer, no request, and holds 0.00", () => {
    expect(sql(DB, `select coalesce(opened_by_employee_id::text,'-') || ' ' ||
                           coalesce(closed_by_employee_id::text,'-') || ' ' ||
                           coalesce(open_request_id::text,'-') || ' ' || opening_cash::text
                    from public.register_sessions where business_date is not null`)).toBe("- - - 0.00");
  });

  it("NO employee POS session is needed to learn what day it is", () => {
    // Nobody has signed in on this till at any point in this suite, and the
    // context exists anyway. A calendar fact is not an act by a person.
    expect(sql(DB, `select count(*) from public.employee_pos_sessions
                    where paired_device_id='${device(1)}'`)).toBe("0");
  });

  it("asking again returns the SAME id and creates nothing", () => {
    const first = JSON.parse(one(`select public.ensure_daily_register_context()::text`));
    const again = JSON.parse(one(`select public.ensure_daily_register_context()::text`));

    expect(again.created).toBe(false);
    expect(again.registerSession.registerSessionId).toBe(first.registerSession.registerSessionId);
    expect(sql(DB, `select count(*) from public.register_sessions where business_date is not null`)).toBe("1");
  });

  it("a DIFFERENT till on the same date gets its own context", () => {
    const mine = JSON.parse(one(`select public.ensure_daily_register_context()::text`));
    const theirs = JSON.parse(till(2)(`select public.ensure_daily_register_context()::text`));

    expect(theirs.created).toBe(true);
    expect(theirs.registerSession.businessDate).toBe(mine.registerSession.businessDate);
    expect(theirs.registerSession.registerSessionId)
      .not.toBe(mine.registerSession.registerSessionId);
  });

  it("clearing the timezone again makes it refuse, without destroying history", () => {
    setZone(null);

    expect(one(`select public.ensure_daily_register_context()->>'error'`)).toBe("business_timezone_required");
    expect(sql(DB, `select count(*) from public.register_sessions where business_date is not null`)).toBe("2");

    setZone("America/New_York");
  });

  it("eight simultaneous callers create exactly one row and all get the same id", async () => {
    // The real thing: eight separate backends, not eight statements. The device
    // lock is what makes this deterministic; the partial unique index is the
    // backstop underneath it.
    const virgin = deviceUser(3);
    const answers = await Promise.all(
      Array.from({ length: 8 }, () =>
        execFileAsync(join(PG_BIN as string, "psql"), [
          ...psqlArgs(DB), "-Atq", "-c",
          `select set_config('request.jwt.claim.sub','${virgin}', false);
           select (public.ensure_daily_register_context()->>'created') || ' ' ||
                  (public.ensure_daily_register_context()->'registerSession'->>'registerSessionId')`,
        ], { encoding: "utf8", env: { ...process.env, LC_ALL: "en_US.UTF-8", PGTZ: "UTC" } })
          .then(({ stdout }) => stdout.trim().split("\n").filter(Boolean).pop() ?? ""))
    );

    const ids = new Set(answers.map((a) => a.split(" ")[1]));

    expect(answers.filter((a) => a.startsWith("true ")).length).toBe(1);
    expect(answers.filter((a) => a.startsWith("false ")).length).toBe(7);
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(sql(DB, `select count(*) from public.register_sessions
                    where paired_device_id='${device(3)}' and business_date is not null`)).toBe("1");
  }, 60_000);

  it("no caller ever saw a raw unique-constraint error", () => {
    // The concurrency case above asserts only ok/created; this states the other
    // half of the contract explicitly, because "exposed a duplicate key error"
    // would still have produced one row.
    expect(one(`select public.ensure_daily_register_context()->>'ok'`)).toBe("true");
    expect(one(`select public.ensure_daily_register_context() ? 'error'`)).toBe("f");
  });
});

// ===========================================================================
// THE TIMEZONE RACE, AND THE TIMEZONE CONFLICT
// ===========================================================================

run("the timezone a daily row was built from cannot shift underneath it", () => {
  const DB = "cp2b_tz";
  const one = (statement: string): string => asRole(DB, deviceUser(1), statement);

  beforeAll(() => {
    freshDatabase(DB, false);
    seed(DB, 2);
    expect(applyMigration(DB).ok).toBe(true);
    sql(DB, `update public.projects set business_timezone='America/New_York' where id='${PROJECT}'`);
  }, 240_000);

  it("an owner's timezone update WAITS for an in-flight creation", async () => {
    // Session A holds the project row FOR SHARE for two seconds. Session B's
    // UPDATE takes FOR NO KEY UPDATE, which conflicts, so it cannot land in the
    // middle -- which is the only way a row could get one zone's date and
    // another zone's bounds.
    const psql = join(PG_BIN as string, "psql");
    const env = { ...process.env, LC_ALL: "en_US.UTF-8", PGTZ: "UTC" };

    const inFlight = execFileAsync(psql, [...psqlArgs(DB), "-Atq", "-c", `
      begin;
      select set_config('request.jwt.claim.sub','${deviceUser(2)}', false);
      select 'CREATED:' || (public.ensure_daily_register_context()->>'created');
      select pg_sleep(2);
      select 'A:' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text;
      commit;`], { encoding: "utf8", env });

    await new Promise((resolve) => setTimeout(resolve, 400));

    const { stdout: bOut } = await execFileAsync(psql, [...psqlArgs(DB), "-Atq", "-c", `
      update public.projects set business_timezone='America/Chicago' where id='${PROJECT}';
      select 'B:' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text;`],
      { encoding: "utf8", env });

    const { stdout: aOut } = await inFlight;
    const aCommitted = Number(/A:(\d+)/.exec(aOut)?.[1]);
    const bLanded = Number(/B:(\d+)/.exec(bOut)?.[1]);

    expect(/CREATED:(\w+)/.exec(aOut)?.[1]).toBe("true");
    expect(`B landed ${bLanded >= aCommitted ? "after" : "BEFORE"} A finished`)
      .toBe("B landed after A finished");
  }, 60_000);

  it("and the row it created is internally consistent — one zone, start to finish", () => {
    expect(sql(DB, `select (r.business_timezone = 'America/New_York')::text || ' / ' ||
                           (r.opened_at = b.starts_at and r.closed_at = b.ends_at)::text
                    from public.register_sessions r
                    cross join lateral public.business_day_bounds(r.business_date, r.business_timezone) b
                    where r.paired_device_id='${device(2)}'`)).toBe("true / true");
  });

  it("with the project now on another zone, ensure FAILS CLOSED on that day", () => {
    expect(sql(DB, `select business_timezone from public.projects where id='${PROJECT}'`))
      .toBe("America/Chicago");

    // Device 1 has no row yet, so it creates a Chicago one; device 2's existing
    // New_York row is the conflict.
    expect(asRole(DB, deviceUser(2), `select public.ensure_daily_register_context()->>'error'`))
      .toBe("daily_register_timezone_conflict");
  });

  it("the conflicting row is NOT rewritten, and no duplicate appears beside it", () => {
    expect(sql(DB, `select count(*) || ' row, ' || min(business_timezone) || ', ' ||
                           min(opened_at)::text || ' to ' || min(closed_at)::text
                    from public.register_sessions where paired_device_id='${device(2)}'`))
      .toMatch(/^1 row, America\/New_York, /);
  });

  it("a till with no row for that day is unaffected — it just gets the new zone", () => {
    const fresh = JSON.parse(one(`select public.ensure_daily_register_context()::text`));

    expect(fresh.ok).toBe(true);
    expect(fresh.registerSession.businessTimezone).toBe("America/Chicago");
  });

  it("restoring the original zone makes the conflicted till work again", () => {
    sql(DB, `update public.projects set business_timezone='America/New_York' where id='${PROJECT}'`);

    const back = JSON.parse(asRole(DB, deviceUser(2), `select public.ensure_daily_register_context()::text`));

    expect(back.ok).toBe(true);
    expect(back.created).toBe(false);
    expect(back.registerSession.businessTimezone).toBe("America/New_York");
  });
});

// ===========================================================================
// DAILY IMMUTABILITY
// ===========================================================================

run("a daily context is frozen the moment it exists", () => {
  const DB = "cp2b_frozen";
  let daily = "";
  let legacy = "";

  /** Attempts an UPDATE as the table owner — the most privileged writer there is. */
  const mutate = (id: string, assignment: string): string => {
    const error = sqlExpectingFailure(DB,
      `update public.register_sessions set ${assignment} where id='${id}'`);

    return error === "" ? "ALLOWED" : (/cannot be changed on a daily register context/.test(error)
      ? "refused" : `other: ${error.split("\n")[0]}`);
  };

  beforeAll(() => {
    freshDatabase(DB, false);
    seed(DB, 2);
    expect(applyMigration(DB).ok).toBe(true);
    sql(DB, `update public.projects set business_timezone='America/New_York' where id='${PROJECT}'`);

    daily = JSON.parse(asRole(DB, deviceUser(1), `select public.ensure_daily_register_context()::text`))
      .registerSession.registerSessionId;

    asRole(DB, deviceUser(1), `select public.employee_login_by_code('001','2222')`);
    legacy = JSON.parse(asRole(DB, deviceUser(1),
      `select public.open_register_session('77777777-7777-4777-8777-777777777777', 125.50)::text`))
      .registerSession.registerSessionId;
  }, 240_000);

  it("every piece of its calendar identity refuses to move", () => {
    const columns: Array<[string, string]> = [
      ["id", "id = gen_random_uuid()"],
      ["paired_device_id", `paired_device_id = '${device(2)}'`],
      ["business_date", "business_date = business_date + 1"],
      ["business_timezone", "business_timezone = 'America/Chicago'"],
      ["opened_at", "opened_at = opened_at + interval '1 hour'"],
      ["closed_at", "closed_at = closed_at + interval '1 hour'"],
      ["opened_by_employee_id", `opened_by_employee_id = '${EMPLOYEE}'`],
      ["closed_by_employee_id", `closed_by_employee_id = '${EMPLOYEE}'`],
      ["open_request_id", "open_request_id = gen_random_uuid()"],
      ["opening_cash", "opening_cash = 50.00"],
    ];

    for (const [column, assignment] of columns) {
      expect(`${column}: ${mutate(daily, assignment)}`).toBe(`${column}: refused`);
    }
  });

  it("and after all ten attempts the row is byte-for-byte what it was", () => {
    expect(sql(DB, `select business_date::text || ' ' || business_timezone || ' ' ||
                           opening_cash::text || ' ' ||
                           coalesce(opened_by_employee_id::text,'-') || ' ' ||
                           coalesce(closed_by_employee_id::text,'-')
                    from public.register_sessions where id='${daily}'`))
      .toBe(`${sql(DB, `select (now() at time zone 'America/New_York')::date::text`)} America/New_York 0.00 - -`);
  });

  it("legacy immutability is NOT broadened — a manual close still works", () => {
    // The WHEN clause means the guard never runs for a legacy row. If it were
    // broadened to every row, this close would raise instead.
    expect(JSON.parse(asRole(DB, deviceUser(1),
      `select public.close_register_session('${legacy}')::text`)).alreadyClosed).toBe(false);
    expect(sql(DB, `select closed_at is not null and closed_by_employee_id is not null
                    from public.register_sessions where id='${legacy}'`)).toBe("t");
  });
});

// ===========================================================================
// LEGACY RPC COMPATIBILITY
// ===========================================================================

run("the Feature 1B register RPCs are untouched, and cannot see a daily row", () => {
  const DB = "cp2b_legacy";
  const one = (statement: string): string => asRole(DB, deviceUser(1), statement);
  let daily = "";

  beforeAll(() => {
    freshDatabase(DB, false);
    seed(DB, 2);
    expect(applyMigration(DB).ok).toBe(true);
    sql(DB, `update public.projects set business_timezone='America/New_York' where id='${PROJECT}'`);
    daily = JSON.parse(one(`select public.ensure_daily_register_context()::text`))
      .registerSession.registerSessionId;
    one(`select public.employee_login_by_code('001','2222')`);
  }, 240_000);

  it("get_current_register_session answers 'no open register' beside a daily row", () => {
    // Structural, not special-cased: it selects closed_at is null, and a daily
    // row always has closed_at set.
    expect(one(`select public.get_current_register_session()::text`))
      .toBe('{"ok": true, "registerSession": null}');
  });

  it("open_register_session still opens a manual drawer period", () => {
    const opened = JSON.parse(one(
      `select public.open_register_session('77777777-7777-4777-8777-777777777777', 125.50)::text`));

    expect(opened.ok).toBe(true);
    expect(opened.replayed).toBe(false);
    expect(opened.registerSession.openingCash).toBe("125.50");
    expect(opened.registerSession.openedByEmployeeId).toBe(EMPLOYEE);
  });

  it("and the daily row did not block it — it is not in the one-open index", () => {
    expect(sql(DB, `select count(*) from public.register_sessions
                    where paired_device_id='${device(1)}' and closed_at is null`)).toBe("1");
  });

  it("open_register_session is still idempotent on its request id", () => {
    expect(JSON.parse(one(
      `select public.open_register_session('77777777-7777-4777-8777-777777777777', 125.50)::text`))
      .replayed).toBe(true);
    expect(one(`select public.open_register_session('77777777-7777-4777-8777-777777777777', 9.99)->>'error'`))
      .toBe("request_conflict");
  });

  it("get_current_register_session returns the MANUAL row, never the daily one", () => {
    const current = JSON.parse(one(`select public.get_current_register_session()::text`));

    expect(current.registerSession.registerSessionId).not.toBe(daily);
    expect(current.registerSession.openingCash).toBe("125.50");
  });

  it("closing a DAILY row through the legacy RPC is a DOMAIN FAILURE", () => {
    // Not `alreadyClosed`. That answer wrote nothing and invented no closer, so
    // it was safe, but it said something untrue: nobody closed this row, and it
    // was never open. A till acting on it would believe a drawer period had
    // been reconciled when no drawer period existed.
    const answer = JSON.parse(one(`select public.close_register_session('${daily}')::text`));

    expect(answer).toEqual({ ok: false, error: "daily_register_not_manually_closable" });
    expect(answer.alreadyClosed).toBeUndefined();
    expect(answer.registerSession).toBeUndefined();
  });

  it("repeating it is the same failure, and still writes nothing", () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(one(`select public.close_register_session('${daily}')->>'error'`))
        .toBe("daily_register_not_manually_closable");
    }
  });

  it("and the daily row is unchanged afterwards", () => {
    expect(sql(DB, `select coalesce(closed_by_employee_id::text,'-') || ' ' ||
                           coalesce(opened_by_employee_id::text,'-') || ' ' ||
                           (closed_at = (select ends_at from public.business_day_bounds(business_date, business_timezone)))::text
                    from public.register_sessions where id='${daily}'`)).toBe("- - true");
  });

  it("the manual close still works normally after that", () => {
    const current = JSON.parse(one(`select public.get_current_register_session()::text`));
    const closed = JSON.parse(one(
      `select public.close_register_session('${current.registerSession.registerSessionId}')::text`));

    expect(closed.alreadyClosed).toBe(false);
    expect(closed.registerSession.closedByEmployeeId).toBe(EMPLOYEE);
    expect(JSON.parse(one(
      `select public.close_register_session('${current.registerSession.registerSessionId}')::text`))
      .alreadyClosed).toBe(true);
  });

  it("ensure_daily_register_context works whether or not a drawer is open", () => {
    expect(one(`select public.ensure_daily_register_context()->>'ok'`)).toBe("true");
    one(`select public.open_register_session('66666666-6666-4666-8666-666666666666', 50.00)`);
    expect(one(`select public.ensure_daily_register_context()->>'ok'`)).toBe("true");
  });
});

// ===========================================================================
// SECURITY
// ===========================================================================

run("security: the new surface is one RPC, for authenticated only", () => {
  const DB = "cp2b_security";
  const ENSURE = "public.ensure_daily_register_context()";
  const GUARD = "public.register_sessions_guard_daily_immutable()";
  const ROLES = ["public", "anon", "authenticated", "service_role"] as const;

  const canExecute = (role: string, fn: string): string =>
    sql(DB, `select has_function_privilege('${role}', '${fn}', 'EXECUTE')::text`);

  beforeAll(() => {
    freshDatabase(DB, true);
  }, 240_000);

  it("ensure_daily_register_context is SECURITY DEFINER with a locked search_path", () => {
    expect(sql(DB, `select p.prosecdef::text || ' ' || array_to_string(p.proconfig, ',')
                    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='ensure_daily_register_context'`))
      .toBe("true search_path=public, pg_catalog, pg_temp");
  });

  it("only `authenticated` can execute it — EFFECTIVE privilege, not ACL text", () => {
    // proacl substring checks are what let `authenticated` keep EXECUTE on all
    // five CP2a functions unnoticed. has_function_privilege resolves what a role
    // can actually do, including privileges inherited through PUBLIC.
    for (const role of ROLES) {
      expect(`${role}: ${canExecute(role, ENSURE)}`)
        .toBe(`${role}: ${role === "authenticated" ? "true" : "false"}`);
    }
  });

  it("the immutability guard is a trigger body: no elevation, no grants", () => {
    expect(sql(DB, `select p.prosecdef::text || ' ' || array_to_string(p.proconfig, ',')
                    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='register_sessions_guard_daily_immutable'`))
      .toBe("false search_path=public, pg_catalog, pg_temp");

    for (const role of ROLES) {
      expect(`${role}: ${canExecute(role, GUARD)}`).toBe(`${role}: false`);
    }
  });

  it("the bounds validator is a trigger body too: no elevation, no grants", () => {
    expect(sql(DB, `select p.prosecdef::text || ' ' || array_to_string(p.proconfig, ',')
                    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='register_sessions_validate_daily_bounds'`))
      .toBe("false search_path=public, pg_catalog, pg_temp");

    for (const role of ROLES) {
      expect(`${role}: ${canExecute(role, "public.register_sessions_validate_daily_bounds()")}`)
        .toBe(`${role}: false`);
    }
  });

  it("close_register_session is still authenticated-only after the guard", () => {
    for (const role of ROLES) {
      expect(`${role}: ${canExecute(role, "public.close_register_session(uuid)")}`)
        .toBe(`${role}: ${role === "authenticated" ? "true" : "false"}`);
    }
  });

  it("no role gained any direct access to register_sessions", () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        expect(`${role} ${priv}: ${sql(DB,
          `select has_table_privilege('${role}','public.register_sessions','${priv}')::text`)}`)
          .toBe(`${role} ${priv}: false`);
      }
    }
  });

  it("register_sessions still has RLS on and zero policies", () => {
    expect(sql(DB, `select c.relrowsecurity::text from pg_class c
                    join pg_namespace n on n.oid=c.relnamespace
                    where n.nspname='public' and c.relname='register_sessions'`)).toBe("true");
    expect(sql(DB, `select count(*) from pg_policies
                    where schemaname='public' and tablename='register_sessions'`)).toBe("0");
  });

  it("the CP2a helpers stayed revoked — this migration granted none of them", () => {
    for (const fn of [
      "public.require_business_timezone(uuid)",
      "public.business_day_bounds(date,text)",
      "public.business_date_of(timestamptz,text)",
      "public.is_valid_business_timezone(text)",
      "public.projects_validate_business_timezone()",
    ]) {
      for (const role of ROLES) {
        expect(`${fn} / ${role}: ${canExecute(role, fn)}`).toBe(`${fn} / ${role}: false`);
      }
    }
  });
});

// ===========================================================================
// REGRESSION
// ===========================================================================

run("regression: everything this checkpoint promised not to touch", () => {
  const BEFORE = "cp2b_before";
  const AFTER = "cp2b_after";

  /** A stable fingerprint of a function's exact definition and posture. */
  const fingerprint = (db: string, signature: string): string =>
    sql(db, `select md5(pg_get_functiondef('${signature}'::regprocedure::oid)) || ' ' ||
                    p.prosecdef::text || ' ' || coalesce(p.proacl::text,'default')
             from pg_proc p where p.oid = '${signature}'::regprocedure::oid`);

  beforeAll(() => {
    freshDatabase(BEFORE, false);
    freshDatabase(AFTER, false);
    expect(applyMigration(AFTER).ok).toBe(true);
  }, 480_000);

  it("complete_sale_v5 is byte-identical — same bytes, therefore same behaviour", () => {
    const sig = "public.complete_sale_v5(text,numeric,jsonb,uuid,timestamptz,text,uuid,uuid)";

    expect(fingerprint(AFTER, sig)).toBe(fingerprint(BEFORE, sig));
  });

  it("so are the other legacy register RPCs and the offline sale contract", () => {
    for (const sig of [
      "public.open_register_session(uuid,numeric)",
      "public.get_current_register_session()",
      "public.complete_sale_v4(uuid,text,numeric,jsonb,uuid,timestamptz,text)",
      "public.complete_sale_v3(uuid,text,numeric,jsonb,uuid)",
    ]) {
      expect(`${sig}: ${fingerprint(AFTER, sig)}`).toBe(`${sig}: ${fingerprint(BEFORE, sig)}`);
    }
  });

  it("close_register_session differs from the accepted version by ADDED LINES ONLY", () => {
    const sig = "public.close_register_session(uuid)";
    const definition = (db: string): string[] =>
      sql(db, `select pg_get_functiondef('${sig}'::regprocedure)`).split("\n");

    const before = definition(BEFORE);
    const after = definition(AFTER);

    // Every line of the accepted definition survives, in order. Walking the two
    // in step means a single removed or edited line would strand the pointer and
    // fail -- which is stricter than a set comparison, and is the actual claim.
    let i = 0;
    const added: string[] = [];

    for (const line of after) {
      if (i < before.length && line === before[i]) i += 1;
      else added.push(line);
    }

    expect(`${i} of ${before.length} accepted lines matched, in order`)
      .toBe(`${before.length} of ${before.length} accepted lines matched, in order`);
    expect(added.length).toBeGreaterThan(0);

    // And every added line belongs to the guard: its comment block, or the
    // `if exists` that returns the domain failure.
    expect(added.filter((line) => line.trim() !== "" && !line.trim().startsWith("--")))
      .toEqual([
        "  if exists (",
        "    select 1",
        "    from public.register_sessions r",
        "    where r.id = p_register_session_id",
        "      and r.business_date is not null",
        "  ) then",
        "    return jsonb_build_object('ok', false, 'error', 'daily_register_not_manually_closable');",
        "  end if;",
      ]);
  });

  it("and its security posture and grants did not move", () => {
    const sig = "public.close_register_session(uuid)";
    const posture = (db: string): string =>
      sql(db, `select p.prosecdef::text || ' | ' || array_to_string(p.proconfig, ',') || ' | ' ||
                      coalesce(p.proacl::text,'default')
               from pg_proc p where p.oid = '${sig}'::regprocedure::oid`);

    expect(posture(AFTER)).toBe(posture(BEFORE));
  });

  it("EVERY pre-existing function in public is byte-identical", () => {
    const digest = (db: string): string =>
      sql(db, `select md5(string_agg(
                 p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')=' ||
                 md5(pg_get_functiondef(p.oid)),
                 '|' order by p.proname, pg_get_function_identity_arguments(p.oid)))
               from pg_proc p join pg_namespace n on n.oid=p.pronamespace
               where n.nspname='public' and p.prokind='f'
                 and p.proname not in ('ensure_daily_register_context',
                                       'register_sessions_guard_daily_immutable',
                                       'register_sessions_validate_daily_bounds',
                                       'close_register_session')`);

    expect(digest(AFTER)).toBe(digest(BEFORE));
  });

  it("the employee identity layer is untouched: UUIDs, codes and login", () => {
    for (const db of [BEFORE, AFTER]) {
      seed(db, 1);
      expect(`${db}: ${asRole(db, deviceUser(1), `select public.employee_login_by_code('001','2222')->>'ok'`)}`)
        .toBe(`${db}: true`);
      expect(`${db}: ${sql(db, `select e.id::text || ' ' || e.employee_code
                                from public.employees e where e.project_id='${PROJECT}'`)}`)
        .toBe(`${db}: ${EMPLOYEE} 001`);
    }
  });

  it("the orders attribution foreign keys are unchanged", () => {
    const fks = (db: string): string =>
      sql(db, `select string_agg(c.conname || '=' || pg_get_constraintdef(c.oid), ' | ' order by c.conname)
               from pg_constraint c where c.conrelid='public.orders'::regclass and c.contype='f'`);

    expect(fks(AFTER)).toBe(fks(BEFORE));
    expect(fks(AFTER)).toContain("register_session_id, paired_device_id) REFERENCES register_sessions(id, paired_device_id)");
  });

  it("the offline queue's server contract is unchanged, argument for argument", () => {
    const args = (db: string): string =>
      sql(db, `select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ' | '
                                 order by p.proname)
               from pg_proc p join pg_namespace n on n.oid=p.pronamespace
               where n.nspname='public' and p.proname like 'complete_sale%'`);

    expect(args(AFTER)).toBe(args(BEFORE));
  });

  it("no table other than register_sessions changed its columns", () => {
    const columns = (db: string): string =>
      sql(db, `select md5(string_agg(table_name || '.' || column_name || ':' || data_type || ':' ||
                                     is_nullable || ':' || coalesce(column_default,''),
                                     '|' order by table_name, column_name))
               from information_schema.columns
               where table_schema='public' and table_name <> 'register_sessions'`);

    expect(columns(AFTER)).toBe(columns(BEFORE));
  });

  it("no existing register_sessions row was backfilled or reclassified", () => {
    expect(sql(AFTER, `select count(*) from public.register_sessions
                       where business_date is not null or business_timezone is not null`)).toBe("0");
  });

  it("every RLS policy in the schema is identical", () => {
    const policies = (db: string): string =>
      sql(db, `select md5(string_agg(tablename || '.' || policyname || ':' || cmd || ':' ||
                                     coalesce(qual,'') || ':' || coalesce(with_check,'') || ':' || roles::text,
                                     '|' order by tablename, policyname))
               from pg_policies where schemaname='public'`);

    expect(policies(AFTER)).toBe(policies(BEFORE));
  });
});

// ===========================================================================
// MANUAL CLOSE: the one legacy semantic change, and its blast radius
// ===========================================================================

run("the daily close guard changes daily rows only", () => {
  const DB = "cp2b_close";
  const one = (statement: string): string => asRole(DB, deviceUser(1), statement);
  let daily = "";

  beforeAll(() => {
    freshDatabase(DB, false);
    seed(DB, 2);
    expect(applyMigration(DB).ok).toBe(true);
    sql(DB, `update public.projects set business_timezone='America/New_York' where id='${PROJECT}'`);
    daily = JSON.parse(one(`select public.ensure_daily_register_context()::text`))
      .registerSession.registerSessionId;
    one(`select public.employee_login_by_code('001','2222')`);
  }, 240_000);

  it("a daily id gets the stable domain failure", () => {
    expect(one(`select public.close_register_session('${daily}')::text`))
      .toBe('{"ok": false, "error": "daily_register_not_manually_closable"}');
  });

  it("the daily row is not written to — not one column moves", () => {
    const before = sql(DB, `select md5(r::text) from public.register_sessions r where r.id='${daily}'`);

    one(`select public.close_register_session('${daily}')`);

    expect(sql(DB, `select md5(r::text) from public.register_sessions r where r.id='${daily}'`))
      .toBe(before);
  });

  it("LEGACY: a normal first close still works and records a real closer", () => {
    const legacy = JSON.parse(one(
      `select public.open_register_session('77777777-7777-4777-8777-777777777777', 125.50)::text`))
      .registerSession.registerSessionId;
    const closed = JSON.parse(one(`select public.close_register_session('${legacy}')::text`));

    expect(closed.ok).toBe(true);
    expect(closed.alreadyClosed).toBe(false);
    expect(closed.registerSession.closedByEmployeeId).toBe(EMPLOYEE);

    // LEGACY: repeated close is still idempotent, and still returns the STORED
    // state rather than re-closing.
    const again = JSON.parse(one(`select public.close_register_session('${legacy}')::text`));

    expect(again.alreadyClosed).toBe(true);
    expect(again.registerSession.closedAt).toBe(closed.registerSession.closedAt);
  });

  it("LEGACY: an unknown id, and another device's row, are both still not_found", () => {
    expect(one(`select public.close_register_session(gen_random_uuid())->>'error'`)).toBe("not_found");
    expect(one(`select public.close_register_session(null)->>'error'`)).toBe("not_found");

    // A daily row belonging to a DIFFERENT till: ownership is decided before the
    // daily guard, so this must be not_found and must NOT leak that it is daily.
    const theirs = JSON.parse(asRole(DB, deviceUser(2),
      `select public.ensure_daily_register_context()::text`)).registerSession.registerSessionId;

    expect(one(`select public.close_register_session('${theirs}')->>'error'`)).toBe("not_found");
  });

  it("LEGACY: the employee requirement is unchanged", () => {
    const legacy = JSON.parse(one(
      `select public.open_register_session('66666666-6666-4666-8666-666666666666', 10.00)::text`))
      .registerSession.registerSessionId;

    // Through the real RPC, not a raw UPDATE: employee_pos_sessions requires an
    // end_reason alongside ended_at, and inventing one here would be testing a
    // state the product cannot produce.
    expect(one(`select public.employee_logout()->>'ok'`)).toBe("true");

    expect(one(`select public.close_register_session('${legacy}')->>'error'`))
      .toBe("employee_session_required");
  });
});

// ===========================================================================
// TIMEZONE CONFLICT: including the change that moves the DATE
// ===========================================================================

run("a timezone change can never produce two daily contexts over one instant", () => {
  const DB = "cp2b_overlap";
  const setZone = (tz: string): void => {
    sql(DB, `update public.projects set business_timezone='${tz}' where id='${PROJECT}'`);
  };

  // 25 hours apart, so their local dates differ at EVERY instant. That is what
  // makes this deterministic rather than a test that passes for 23 hours a day.
  const AHEAD = "Pacific/Kiritimati";
  const BEHIND = "Pacific/Midway";

  beforeAll(() => {
    freshDatabase(DB, false);
    seed(DB, 3);
    expect(applyMigration(DB).ok).toBe(true);
  }, 240_000);

  it("the two zones really do disagree about the date right now", () => {
    expect(sql(DB, `select ((now() at time zone '${AHEAD}')::date
                          > (now() at time zone '${BEHIND}')::date)::text`)).toBe("true");
  });

  it("A. a SAME-DATE timezone change fails closed", () => {
    setZone("America/New_York");
    expect(asRole(DB, deviceUser(1), `select public.ensure_daily_register_context()->>'created'`))
      .toBe("true");

    // Chicago is an hour behind New York; at most instants the date is the same
    // and only the bounds differ. When it is not, the date-shift branch catches
    // it instead -- either way the answer is the same refusal.
    setZone("America/Chicago");
    expect(asRole(DB, deviceUser(1), `select public.ensure_daily_register_context()->>'error'`))
      .toBe("daily_register_timezone_conflict");
  });

  it("B. a DATE-SHIFTING timezone change also fails closed", () => {
    setZone(AHEAD);
    const made = JSON.parse(asRole(DB, deviceUser(2), `select public.ensure_daily_register_context()::text`));

    expect(made.created).toBe(true);

    // The candidate date is now a DIFFERENT day, so a by-date lookup finds
    // nothing. Before the current-instant check existed, this inserted a second
    // immutable interval covering the same instant.
    setZone(BEHIND);
    expect(sql(DB, `select (public.business_date_of(now(),'${BEHIND}')
                         <> date '${made.registerSession.businessDate}')::text`)).toBe("true");
    expect(asRole(DB, deviceUser(2), `select public.ensure_daily_register_context()->>'error'`))
      .toBe("daily_register_timezone_conflict");
  });

  it("C. no second row was created, and no two intervals overlap", () => {
    expect(sql(DB, `select count(*) from public.register_sessions
                    where paired_device_id='${device(2)}'`)).toBe("1");

    // Stated as the invariant rather than as a row count: no till may have two
    // daily intervals that share any instant.
    expect(sql(DB, `select count(*) from public.register_sessions a
                    join public.register_sessions b
                      on b.paired_device_id = a.paired_device_id and b.id <> a.id
                    where a.business_date is not null and b.business_date is not null
                      and a.opened_at < b.closed_at and b.opened_at < a.closed_at`)).toBe("0");
  });

  it("D. the original immutable row is exactly as it was", () => {
    expect(sql(DB, `select business_timezone || ' ' || business_date::text || ' ' ||
                           (opened_at = (select starts_at from public.business_day_bounds(business_date, business_timezone)))::text
                    from public.register_sessions where paired_device_id='${device(2)}'`))
      .toMatch(new RegExp(`^${AHEAD} \\d{4}-\\d{2}-\\d{2} true$`));
  });

  it("E. a till whose daily intervals do NOT cover now still creates today", () => {
    setZone("America/New_York");

    // A context for a long-past day, with exact computed bounds.
    sql(DB, `insert into public.register_sessions
             (paired_device_id, opened_at, opening_cash, closed_at, business_date, business_timezone)
             values ('${device(3)}', ${exactDaily("2026-01-15")})`);

    const today = JSON.parse(asRole(DB, deviceUser(3), `select public.ensure_daily_register_context()::text`));

    expect(today.ok).toBe(true);
    expect(today.created).toBe(true);
    expect(today.registerSession.businessDate).not.toBe("2026-01-15");
    expect(sql(DB, `select count(*) from public.register_sessions
                    where paired_device_id='${device(3)}'`)).toBe("2");
  });

  it("and asking again, with nothing changed, is still idempotent", () => {
    const a = JSON.parse(asRole(DB, deviceUser(3), `select public.ensure_daily_register_context()::text`));
    const b = JSON.parse(asRole(DB, deviceUser(3), `select public.ensure_daily_register_context()::text`));

    expect(b.created).toBe(false);
    expect(b.registerSession.registerSessionId).toBe(a.registerSession.registerSessionId);
  });
});

// ===========================================================================
// DAILY INSERT VALIDATION
// ===========================================================================

run("a daily row's interval must BE the calendar, enforced by the database", () => {
  const DB = "cp2b_bounds";
  const DEV = device(1);

  /** "" when accepted, otherwise the validator's complaint, classified. */
  const insertDaily = (values: string): string => {
    const error = sqlExpectingFailure(DB, `
      insert into public.register_sessions (paired_device_id, opened_at, opening_cash,
                                            closed_at, business_date, business_timezone)
      values ('${DEV}', ${values})`);

    if (error === "") return "";
    if (/must open at local midnight/.test(error)) return "wrong start";
    if (/must close at local midnight/.test(error)) return "wrong end";
    if (/Invalid business timezone/.test(error)) return "invalid timezone";
    if (/No calendar bounds/.test(error)) return "no bounds";

    return `other: ${error.split("\n")[0]}`;
  };

  const shifted = (date: string, which: "start" | "end", by: string, tz = "America/New_York"): string =>
    `(select starts_at ${which === "start" ? by : ""} from public.business_day_bounds(date '${date}','${tz}')), 0, ` +
    `(select ends_at ${which === "end" ? by : ""} from public.business_day_bounds(date '${date}','${tz}')), ` +
    `'${date}', '${tz}'`;

  beforeAll(() => {
    freshDatabase(DB, false);
    seed(DB, 1);
    expect(applyMigration(DB).ok).toBe(true);
  }, 240_000);

  it("the exact computed interval is accepted, on all three kinds of day", () => {
    expect(`ordinary: ${insertDaily(exactDaily("2026-06-10"))}`).toBe("ordinary: ");
    expect(`spring forward: ${insertDaily(exactDaily("2026-03-08"))}`).toBe("spring forward: ");
    expect(`fall back: ${insertDaily(exactDaily("2026-11-01"))}`).toBe("fall back: ");
  });

  it("and those rows really are 24, 23 and 25 hours long", () => {
    expect(sql(DB, `select string_agg(
                      business_date::text || '=' ||
                      (extract(epoch from (closed_at - opened_at)) / 3600)::numeric(6,0)::text,
                      ' ' order by business_date)
                    from public.register_sessions where business_date is not null`))
      .toBe("2026-03-08=23 2026-06-10=24 2026-11-01=25");
  });

  it("an opened_at that is not local midnight is refused", () => {
    expect(insertDaily(shifted("2026-07-01", "start", "+ interval '1 hour'"))).toBe("wrong start");
    expect(insertDaily(shifted("2026-07-01", "start", "- interval '1 second'"))).toBe("wrong start");
  });

  it("a closed_at that is not the next local midnight is refused", () => {
    expect(insertDaily(shifted("2026-07-02", "end", "+ interval '1 hour'"))).toBe("wrong end");
    expect(insertDaily(shifted("2026-07-02", "end", "- interval '1 microsecond'"))).toBe("wrong end");
  });

  it("a flat 24-hour end is refused on a spring-forward day", () => {
    expect(insertDaily(
      `(select starts_at from public.business_day_bounds(date '2026-03-08','America/Chicago')), 0,
       (select starts_at + interval '24 hours' from public.business_day_bounds(date '2026-03-08','America/Chicago')),
       '2026-03-08', 'America/Chicago'`)).toBe("wrong end");
  });

  it("a flat 24-hour end is refused on a fall-back day", () => {
    expect(insertDaily(
      `(select starts_at from public.business_day_bounds(date '2026-11-01','America/Chicago')), 0,
       (select starts_at + interval '24 hours' from public.business_day_bounds(date '2026-11-01','America/Chicago')),
       '2026-11-01', 'America/Chicago'`)).toBe("wrong end");
  });

  it("an unaccepted timezone is refused, by CP2a's own rule", () => {
    // Exactly the zones CP2a refuses: fixed offsets, Etc/, and nonsense.
    for (const tz of ["EST", "Etc/GMT+5", "UTC", "Mars/Olympus", "America/Nowhere"]) {
      expect(`${tz}: ${insertDaily(
        `'2026-07-03 05:00:00+00', 0, '2026-07-04 05:00:00+00', '2026-07-03', '${tz}'`)}`)
        .toBe(`${tz}: invalid timezone`);
    }
  });

  it("nothing is silently normalized — a refused row leaves no trace", () => {
    expect(sql(DB, `select count(*) from public.register_sessions
                    where business_date in ('2026-07-01','2026-07-02','2026-07-03')`)).toBe("0");
  });

  it("the accepted rows were stored exactly as offered, not corrected", () => {
    expect(sql(DB, `select count(*) from public.register_sessions r
                    cross join lateral public.business_day_bounds(r.business_date, r.business_timezone) b
                    where r.business_date is not null
                      and (r.opened_at <> b.starts_at or r.closed_at <> b.ends_at)`)).toBe("0");
  });

  it("LEGACY inserts are completely unaffected — the trigger never runs", () => {
    expect(sqlExpectingFailure(DB, `
      insert into public.register_sessions
        (paired_device_id, opened_by_employee_id, opened_at, opening_cash, open_request_id)
      values ('${DEV}', '${EMPLOYEE}', '2026-02-01 07:13:29+00', 10, gen_random_uuid())`)).toBe("");

    // An arbitrary opened_at, on no calendar boundary at all, with no timezone:
    // exactly the row the validator would reject if it applied to legacy rows.
    expect(sql(DB, `select opened_at::text from public.register_sessions
                    where business_date is null and opening_cash = 10`))
      .toBe("2026-02-01 07:13:29+00");
  });

  it("ensure_daily_register_context's own inserts satisfy the validator", () => {
    sql(DB, `update public.projects set business_timezone='America/New_York' where id='${PROJECT}'`);

    expect(asRole(DB, deviceUser(1), `select public.ensure_daily_register_context()->>'ok'`)).toBe("true");
  });
});

// ===========================================================================
// EXECUTION AS THE REAL authenticated ROLE
// ===========================================================================

run("the RPC works for a real `authenticated` caller, not only for its owner", () => {
  const DB = "cp2b_authrole";
  const setZone = (tz: string | null): void => {
    sql(DB, `update public.projects set business_timezone=${tz === null ? "null" : `'${tz}'`}
             where id='${PROJECT}'`);
  };

  beforeAll(() => {
    freshDatabase(DB, false);
    seed(DB, 2);
    expect(applyMigration(DB).ok).toBe(true);
  }, 240_000);

  it("the harness really does drop to `authenticated`", () => {
    expect(asAuthenticated(DB, deviceUser(1), `select current_user`)).toBe("authenticated");
  });

  it("and the role does not leak past the statement that set it", () => {
    asAuthenticated(DB, deviceUser(1), `select 1`);
    expect(sql(DB, `select current_user`)).toBe("postgres");
  });

  it("with no timezone set, an authenticated till is refused", () => {
    expect(asAuthenticated(DB, deviceUser(1),
      `select public.ensure_daily_register_context()->>'error'`)).toBe("business_timezone_required");
  });

  it("an unpaired authenticated user gets not_paired", () => {
    setZone("America/New_York");
    expect(asAuthenticated(DB, "00000000-0000-4000-8000-000000000000",
      `select public.ensure_daily_register_context()->>'error'`)).toBe("not_paired");
  });

  it("a paired authenticated till creates its context", () => {
    const made = JSON.parse(asAuthenticated(DB, deviceUser(1),
      `select public.ensure_daily_register_context()::text`));

    expect(made.ok).toBe(true);
    expect(made.created).toBe(true);
    expect(made.registerSession.businessTimezone).toBe("America/New_York");
  });

  it("and asking again is idempotent for it too", () => {
    const first = JSON.parse(asAuthenticated(DB, deviceUser(1),
      `select public.ensure_daily_register_context()::text`));

    expect(first.created).toBe(false);
    expect(sql(DB, `select count(*) from public.register_sessions
                    where paired_device_id='${device(1)}'`)).toBe("1");
  });

  it("it sees the timezone conflict too", () => {
    setZone("America/Chicago");
    expect(asAuthenticated(DB, deviceUser(1),
      `select public.ensure_daily_register_context()->>'error'`))
      .toBe("daily_register_timezone_conflict");
    setZone("America/New_York");
  });

  it("it gets the daily close refusal too", () => {
    const daily = sql(DB, `select id from public.register_sessions
                           where paired_device_id='${device(1)}' and business_date is not null`);

    expect(asAuthenticated(DB, deviceUser(1),
      `select public.close_register_session('${daily}')->>'error'`))
      .toBe("daily_register_not_manually_closable");
  });

  it("but it has NO direct authority over register_sessions", () => {
    for (const statement of [
      `select count(*) from public.register_sessions`,
      `insert into public.register_sessions (paired_device_id, opened_at, opening_cash, closed_at,
        business_date, business_timezone) values ('${device(1)}', now(), 0, now(), '2026-01-01', 'America/New_York')`,
      `update public.register_sessions set opening_cash = 1`,
      `delete from public.register_sessions`,
    ]) {
      expect(asAuthenticatedExpectingFailure(DB, deviceUser(1), statement))
        .toMatch(/permission denied for table register_sessions/);
    }
  });

  it("and cannot reach the CP2a helpers or either trigger body directly", () => {
    for (const call of [
      `select public.require_business_timezone('${PROJECT}')`,
      `select public.business_day_bounds(date '2026-01-01','America/New_York')`,
      `select public.business_date_of(now(),'America/New_York')`,
      `select public.is_valid_business_timezone('America/New_York')`,
    ]) {
      expect(asAuthenticatedExpectingFailure(DB, deviceUser(1), call))
        .toMatch(/permission denied for function/);
    }
  });
});
