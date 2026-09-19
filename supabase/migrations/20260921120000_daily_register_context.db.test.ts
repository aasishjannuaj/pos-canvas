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

    return error === "" ? "" : (match?.[1] ?? "refused");
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
    expect(insert(`opened_by_employee_id, ${daily}`,
      `'${EMPLOYEE}', '2026-05-01', 0, '2026-05-02', '2026-05-01', 'America/New_York'`))
      .toBe("register_sessions_daily_shape");
  });

  it("a daily row may not name a closer", () => {
    expect(insert(`closed_by_employee_id, ${daily}`,
      `'${EMPLOYEE}', '2026-05-01', 0, '2026-05-02', '2026-05-01', 'America/New_York'`))
      .toBe("register_sessions_daily_shape");
  });

  it("a daily row may not carry an open_request_id", () => {
    expect(insert(`open_request_id, ${daily}`,
      `gen_random_uuid(), '2026-05-01', 0, '2026-05-02', '2026-05-01', 'America/New_York'`))
      .toBe("register_sessions_daily_shape");
  });

  it("a daily row's opening_cash is exactly 0.00 and nothing else", () => {
    expect(insert(daily, `'2026-05-01', 25, '2026-05-02', '2026-05-01', 'America/New_York'`))
      .toBe("register_sessions_daily_shape");
    expect(insert(daily, `'2026-05-01', 0.01, '2026-05-02', '2026-05-01', 'America/New_York'`))
      .toBe("register_sessions_daily_shape");
    expect(insert(daily, `'2026-05-01', 0.00, '2026-05-02', '2026-05-01', 'America/New_York'`)).toBe("");
  });

  it("a daily row requires a business_timezone", () => {
    expect(insert("opened_at, opening_cash, closed_at, business_date",
      `'2026-06-01', 0, '2026-06-02', '2026-06-01'`)).toBe("register_sessions_daily_shape");
  });

  it("a daily row can never be left open — its end is known at creation", () => {
    expect(insert("opened_at, opening_cash, business_date, business_timezone",
      `'2026-06-01', 0, '2026-06-01', 'America/New_York'`)).toBe("register_sessions_daily_shape");
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
      values ('${dev}', '${date} 04:00:00+00', 0, '${date} 04:00:00+00'::timestamptz + interval '1 day',
              '${date}', 'America/New_York')`);

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

  it("closing a DAILY row through the legacy RPC is a safe no-op", () => {
    // ok, not an error; no closer invented; no constraint violation; no write.
    const answer = JSON.parse(one(`select public.close_register_session('${daily}')::text`));

    expect(answer.ok).toBe(true);
    expect(answer.alreadyClosed).toBe(true);
    expect(answer.registerSession.closedByEmployeeId).toBeNull();
    expect(answer.registerSession.openedByEmployeeId).toBeNull();
    expect(answer.registerSession.openingCash).toBe("0.00");
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

  it("so are the three legacy register RPCs and the offline sale contract", () => {
    for (const sig of [
      "public.open_register_session(uuid,numeric)",
      "public.get_current_register_session()",
      "public.close_register_session(uuid)",
      "public.complete_sale_v4(uuid,text,numeric,jsonb,uuid,timestamptz,text)",
      "public.complete_sale_v3(uuid,text,numeric,jsonb,uuid)",
    ]) {
      expect(`${sig}: ${fingerprint(AFTER, sig)}`).toBe(`${sig}: ${fingerprint(BEFORE, sig)}`);
    }
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
                                       'register_sessions_guard_daily_immutable')`);

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
