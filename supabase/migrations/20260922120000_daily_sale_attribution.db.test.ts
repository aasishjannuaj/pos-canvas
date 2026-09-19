// v1.3 Checkpoint 2c — daily sale attribution, EXECUTED against a real
// PostgreSQL rather than read.
//
// WHAT THIS FILE IS FOR. CP2c makes three promises that cannot be checked by
// reading SQL: that a till left running over midnight keeps selling and its
// sales land on the new day; that a queued sale lands on the day it actually
// happened rather than the day its retained id names; and that a sale which
// already completed replays untouched afterwards, even with the timezone
// cleared and nobody signed in. Those are runtime facts about ordering, locks
// and a calendar.
//
// IT ALSO CARRIES NEGATIVE CONTROLS. Near the end, the migration's own
// complete_sale_v5 is deliberately broken -- rollover disabled, currentness
// reverted to `closed_at is null`, yesterday's claim honoured, replay made to
// resolve today's context -- and the tests above are re-run to prove they
// FAIL. A test that passes against a broken implementation was not testing
// anything.
//
// HOW IT RUNS. A throwaway cluster in the OS temp directory on a loopback
// port, the repository's own migrations applied in order, then destroyed. No
// Docker, no new dependency, and a loud SKIP when no PostgreSQL is installed.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20260922120000_daily_sale_attribution.sql";

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
const PORT = 56100 + (process.pid % 90);

if (PG_BIN === null) {
  console.warn(
    `\n[${MIGRATION}] SKIPPED: no local PostgreSQL server found.` +
      "\n  These are the only tests that EXECUTE daily sale attribution;" +
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


// ---------------------------------------------------------------------------
// The sale fixture
// ---------------------------------------------------------------------------

/** The priced menu every sale below is rung up against. One item, no tax. */
const MENU = JSON.stringify({
  menuItems: [{ id: "latte", name: "Latte", price: "4.00", available: true }],
  tax: { enabled: false, rate: 0 },
  receipt: {},
});

const ONE_LATTE = `'[{"itemId":"latte","quantity":1}]'::jsonb`;
const ZONE = "America/New_York";

/**
 * One project (with a timezone), one build, `tills` paired devices, one
 * employee. Devices are paired 30 days ago so an offline sale's
 * "predates this device" guard is never what refuses a test by accident.
 */
function seedSales(db: string, tills: number): void {
  const users = Array.from({ length: tills }, (_, i) => `('${deviceUser(i + 1)}')`).join(",");
  const devices = Array.from({ length: tills }, (_, i) =>
    `('${device(i + 1)}','${deviceUser(i + 1)}','${OWNER}','${PROJECT}','${BUILD}', now() - interval '30 days')`)
    .join(",");

  sql(db, `
    insert into auth.users (id) values ('${OWNER}'), ${users};
    insert into public.projects (id, user_id, name, template_id, config, business_timezone)
    values ('${PROJECT}', '${OWNER}', 'Shop', 'cafe', '${MENU}'::jsonb, '${ZONE}');
    insert into public.build_jobs (id, project_id, owner_id, target, status, config_snapshot,
                                   config_schema_version, config_hash, request_key, started_at, finished_at)
    values ('${BUILD}','${PROJECT}','${OWNER}','android','succeeded','${MENU}'::jsonb,1,'h','r', now(), now());
    insert into public.paired_devices (id, auth_user_id, owner_id, project_id, build_job_id, created_at)
    values ${devices};
    insert into public.employees (id, project_id, display_name, employee_code, role, pin_hash, active, created_at)
    values ('${EMPLOYEE}','${PROJECT}','Amy','001','cashier', public.employee_pin_hash('2222'), true, '2026-01-01');
  `);
}

/** Signs Amy in on till `n` and returns the POS session id. */
function signIn(db: string, n: number): string {
  expect(asRole(db, deviceUser(n), `select public.employee_login_by_code('001','2222')->>'ok'`)).toBe("true");

  return sql(db, `select id::text from public.employee_pos_sessions
                  where paired_device_id='${device(n)}' and ended_at is null`);
}

type SaleArgs = {
  request: string;
  session: string | null;
  register: string | null;
  source?: "online" | "offline_queued";
  /** A SQL expression for occurred_at, or null. */
  at?: string;
  quantity?: number;
};

/** Calls complete_sale_v5 as till `n`, returning the raw jsonb text. */
function sale(db: string, n: number, a: SaleArgs): string {
  const items = a.quantity === undefined
    ? ONE_LATTE
    : `'[{"itemId":"latte","quantity":${a.quantity}}]'::jsonb`;

  return asRole(db, deviceUser(n), `
    select public.complete_sale_v5(
      'cash', 0, ${items}, '${a.request}',
      ${a.at ?? "null"}, '${a.source ?? "online"}',
      ${a.session === null ? "null" : `'${a.session}'`},
      ${a.register === null ? "null" : `'${a.register}'`}
    )::text`);
}

/** The same, returning the error text instead of throwing. */
function saleExpectingFailure(db: string, n: number, a: SaleArgs): string {
  try {
    sale(db, n, a);
    return "";
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    return (/ERROR:\s*(.*)/.exec((err.stderr ?? err.message ?? "").toString())?.[1] ?? "").trim();
  }
}

/** Today's business date, as the server and the project's zone see it. */
function today(db: string): string {
  return sql(db, `select (now() at time zone '${ZONE}')::date::text`);
}

/**
 * A DAILY context for till `n` on `today + offsetDays`, with exact CP2a bounds.
 *
 * Offsets are relative to the SERVER's current business date, never to a fixed
 * calendar date, so "yesterday" is yesterday whenever the suite happens to run.
 */
function dailyRow(db: string, n: number, offsetDays: number): string {
  const date = `((now() at time zone '${ZONE}')::date + ${offsetDays})`;

  return sql(db, `
    insert into public.register_sessions (paired_device_id, opened_at, opening_cash,
                                          closed_at, business_date, business_timezone)
    select '${device(n)}', b.starts_at, 0, b.ends_at, ${date}, '${ZONE}'
    from public.business_day_bounds(${date}, '${ZONE}') b
    returning id::text`);
}

/** An instant inside the business day `offsetDays` from today, at `hours` local. */
function instantIn(offsetDays: number, hours: string): string {
  return `(select b.starts_at + interval '${hours}'
           from public.business_day_bounds((now() at time zone '${ZONE}')::date + ${offsetDays}, '${ZONE}') b)`;
}

/** The business date a stored order was filed under, or "NULL". */
function filedUnder(db: string, request: string): string {
  return sql(db, `select coalesce(r.business_date::text,'NULL')
                  from public.orders o
                  left join public.register_sessions r on r.id = o.register_session_id
                  where o.sale_request_id = '${request}'`);
}

// ---------------------------------------------------------------------------
// Negative controls: breaking the migration's own function on purpose
// ---------------------------------------------------------------------------

const CP2C_SQL = readFileSync(join(migrationsDir, MIGRATION), "utf8");

/** complete_sale_v5 exactly as this migration defines it. */
function v5Definition(): string {
  const start = CP2C_SQL.indexOf("create or replace function public.complete_sale_v5(");
  const end = CP2C_SQL.indexOf("\n$function$;", start);

  if (start < 0 || end < 0) throw new Error("complete_sale_v5 not found in the migration");

  return CP2C_SQL.slice(start, end) + "\n$function$;";
}

/**
 * Installs a DELIBERATELY BROKEN complete_sale_v5, runs `body`, and restores it.
 *
 * Every anchor is asserted UNIQUE before the replacement, so a mutation that
 * silently stopped applying -- or landed on the wrong occurrence -- fails
 * loudly instead of quietly turning the control into a no-op.
 */
function withBrokenV5(db: string, edits: Array<[string, string]>, body: () => void): void {
  let definition = v5Definition();

  for (const [from, to] of edits) {
    // UNIQUE, not merely present. A substring that occurs twice would silently
    // mutate whichever came first -- which is exactly how the replay control
    // below first "passed" while patching the unique_violation backstop
    // instead, and a negative control that mutates the wrong line proves
    // nothing at all.
    const occurrences = definition.split(from).length - 1;

    if (occurrences !== 1) {
      throw new Error(
        `negative control anchor occurs ${occurrences} times, expected exactly 1: ${from.slice(0, 80)}`);
    }

    definition = definition.replace(from, to);
  }

  pg("psql", [...psqlArgs(db), "-q", "-f", "-"], definition);
  try {
    body();
  } finally {
    pg("psql", [...psqlArgs(db), "-q", "-f", "-"], v5Definition());
  }
}

/** Stable request ids, one per scenario, so a failure names itself. */
const SALES = {
  today:     "10000000-0000-4000-8000-000000000001",
  rolled:    "10000000-0000-4000-8000-000000000002",
  slept:     "10000000-0000-4000-8000-000000000003",
  future:    "10000000-0000-4000-8000-000000000004",
  foreign:   "10000000-0000-4000-8000-000000000005",
  nullreg:   "10000000-0000-4000-8000-000000000006",
  staleEmp:  "10000000-0000-4000-8000-000000000007",
  preMid:    "20000000-0000-4000-8000-000000000001",
  postMid:   "20000000-0000-4000-8000-000000000002",
  nullClaim: "20000000-0000-4000-8000-000000000003",
  legacyOld: "20000000-0000-4000-8000-000000000004",
  legacyIn:  "20000000-0000-4000-8000-000000000005",
  foreignCl: "20000000-0000-4000-8000-000000000006",
  noZone:    "30000000-0000-4000-8000-000000000001",
  conflict:  "30000000-0000-4000-8000-000000000002",
  replay:    "40000000-0000-4000-8000-000000000001",
  snapshot:  "60000000-0000-4000-8000-000000000001",
  snapNeg:   "60000000-0000-4000-8000-000000000002",
} as const;

const run = PG_BIN === null ? describe.skip : describe;

beforeAll(() => {
  if (PG_BIN === null) return;

  dataDir = mkdtempSync(join(tmpdir(), "pos-canvas-cp2c-"));
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
// The migration applies, and changes nothing it said it would not
// ===========================================================================

run("the migration applies to a database holding every accepted predecessor", () => {
  const DB = "cp2c_apply";

  beforeAll(() => {
    freshDatabase(DB, false);
  }, 300_000);

  it("applies as ONE transaction, with its own verification block passing", () => {
    const result = applyMigration(DB);

    expect(result.ok ? "applied" : `FAILED: ${result.error}`).toBe("applied");
  });

  it("46. complete_sale_v5 gained no client authority parameter", () => {
    expect(sql(DB, `select pg_get_function_identity_arguments(p.oid)
                    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='complete_sale_v5'`))
      .toBe("p_payment_method text, p_tip_amount numeric, p_items jsonb, p_sale_request_id uuid, " +
            "p_occurred_at timestamp with time zone, p_source text, " +
            "p_employee_pos_session_id uuid, p_register_session_id uuid");
  });

  it("47. the private historical helper is executable by no client role", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(`${role}: ${sql(DB, `select has_function_privilege('${role}',
        'public.daily_register_context_for_sale(uuid,timestamptz)', 'EXECUTE')::text`)}`)
        .toBe(`${role}: false`);
    }
  });

  it("48-49. complete_sale_v5 keeps its grants and its locked search_path", () => {
    expect(sql(DB, `select p.prosecdef::text || ' ' || array_to_string(p.proconfig, ',')
                    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='complete_sale_v5'`))
      .toBe("true search_path=public, pg_temp");

    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(`${role}: ${sql(DB, `select has_function_privilege('${role}',
        'public.complete_sale_v5(text,numeric,jsonb,uuid,timestamptz,text,uuid,uuid)', 'EXECUTE')::text`)}`)
        .toBe(`${role}: ${role === "authenticated" ? "true" : "false"}`);
    }
  });

  it("50. register_sessions is still reachable through RPCs only", () => {
    // orders is deliberately NOT in this list: the browser has always read its
    // own orders through RLS, and CP2c did not touch that. The regression suite
    // proves the whole privilege matrix is identical to the pre-migration one;
    // this states the one table that must hold no client privilege at all.
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        expect(`${role} ${priv}: ${sql(DB,
          `select has_table_privilege('${role}','public.register_sessions','${priv}')::text`)}`)
          .toBe(`${role} ${priv}: false`);
      }
    }
  });

  it("32. no queue-facing schema moved: orders columns are exactly as they were", () => {
    // The queue's server contract is complete_sale_v5's arguments plus the
    // columns an order is made of. Neither changed, so a device holding queued
    // records written before this migration can still sync them unaltered.
    expect(sql(DB, `select string_agg(column_name, ',' order by ordinal_position)
                    from information_schema.columns
                    where table_schema='public' and table_name='orders'
                      and column_name in ('sale_request_id','sale_request_hash','source',
                                          'occurred_at','employee_id','paired_device_id',
                                          'register_session_id')`))
      .toBe("sale_request_id,sale_request_hash,occurred_at,source,employee_id,paired_device_id,register_session_id");
  });
});

// ===========================================================================
// ONLINE
// ===========================================================================

run("online sales, and the midnight nobody should notice", () => {
  const DB = "cp2c_online";
  let session = "";
  let todayDaily = "";

  beforeAll(() => {
    freshDatabase(DB, false);
    seedSales(DB, 2);
    expect(applyMigration(DB).ok).toBe(true);
    session = signIn(DB, 1);
    todayDaily = JSON.parse(asRole(DB, deviceUser(1),
      `select public.ensure_daily_register_context()::text`)).registerSession.registerSessionId;
  }, 300_000);

  it("1-2. today's correct DAILY expectation succeeds, and is what gets stored", () => {
    const answer = JSON.parse(sale(DB, 1, { request: SALES.today, session, register: todayDaily }));

    expect(answer.attribution.registerSessionId).toBe(todayDaily);
    expect(answer.attribution.pairedDeviceId).toBe(device(1));
    expect(answer.attribution.employeeId).toBe(EMPLOYEE);
    expect(filedUnder(DB, SALES.today)).toBe(today(DB));
  });

  it("12. a DAILY row's populated closed_at does not make it look closed", () => {
    // The legacy currentness test is `closed_at is null`, and a daily row
    // always has closed_at set. If that test were still being used, the sale
    // above could not have succeeded at all.
    expect(sql(DB, `select (closed_at is not null)::text from public.register_sessions
                    where id='${todayDaily}'`)).toBe("true");
    expect(sql(DB, `select count(*) from public.register_sessions
                    where paired_device_id='${device(1)}' and closed_at is null`)).toBe("0");
  });

  it("3, 5, 6. yesterday's expectation auto-rolls: no re-login, no recovery", () => {
    const yesterday = dailyRow(DB, 1, -1);
    const answer = JSON.parse(sale(DB, 1, { request: SALES.rolled, session, register: yesterday }));

    // It rolled forward to today, and it did NOT attribute to yesterday.
    expect(answer.attribution.registerSessionId).toBe(todayDaily);
    expect(answer.attribution.registerSessionId).not.toBe(yesterday);
    expect(filedUnder(DB, SALES.rolled)).toBe(today(DB));

    // Nobody was logged out and the same POS session took the sale.
    expect(answer.attribution.employeeId).toBe(EMPLOYEE);
    expect(sql(DB, `select id::text from public.employee_pos_sessions
                    where paired_device_id='${device(1)}' and ended_at is null`)).toBe(session);
  });

  it("4. a till that slept for days rolls straight to today, inventing no gap", () => {
    const longAgo = dailyRow(DB, 1, -4);
    const before = sql(DB, `select count(*) from public.register_sessions
                            where paired_device_id='${device(1)}' and business_date is not null`);

    expect(JSON.parse(sale(DB, 1, { request: SALES.slept, session, register: longAgo }))
      .attribution.registerSessionId).toBe(todayDaily);
    expect(filedUnder(DB, SALES.slept)).toBe(today(DB));

    // The intervening days were NOT manufactured to bridge the gap.
    expect(sql(DB, `select count(*) from public.register_sessions
                    where paired_device_id='${device(1)}' and business_date is not null`)).toBe(before);
  });

  it("8. a FUTURE daily expectation is refused — the future is not a rollover", () => {
    expect(saleExpectingFailure(DB, 1,
      { request: SALES.future, session, register: dailyRow(DB, 1, 5) }))
      .toBe("The register session changed");
  });

  it("9. another device's daily context is refused by the existing authority rule", () => {
    const theirs = JSON.parse(asRole(DB, deviceUser(2),
      `select public.ensure_daily_register_context()::text`)).registerSession.registerSessionId;

    // Not a daily decision at all: the row is not this device's register, so
    // Feature 1B's own answer stands. This till has no open manual drawer.
    expect(saleExpectingFailure(DB, 1, { request: SALES.foreign, session, register: theirs }))
      .toBe("The register is not open");
  });

  it("10. a NULL online register expectation is still refused", () => {
    expect(saleExpectingFailure(DB, 1, { request: SALES.nullreg, session, register: null }))
      .toBe("This sale must name the signed-in employee and the open register");
    expect(saleExpectingFailure(DB, 1, { request: SALES.nullreg, session: null, register: todayDaily }))
      .toBe("This sale must name the signed-in employee and the open register");
  });

  it("and no failed attempt left an order behind", () => {
    expect(sql(DB, `select count(*) from public.orders
                    where sale_request_id in ('${SALES.future}','${SALES.foreign}','${SALES.nullreg}')`))
      .toBe("0");
  });

  it("17-part. a stale EMPLOYEE expectation is still refused, rollover or not", () => {
    // The daily branch must not have weakened the employee half of 6d.
    expect(saleExpectingFailure(DB, 1, {
      request: SALES.staleEmp,
      session: "99999999-9999-4999-8999-999999999999",
      register: todayDaily,
    })).toBe("The signed-in employee changed");
  });
});

run("online LEGACY registers behave exactly as Feature 1B left them", () => {
  const DB = "cp2c_legacy_online";
  let session = "";
  let legacy = "";

  beforeAll(() => {
    freshDatabase(DB, false);
    seedSales(DB, 1);
    expect(applyMigration(DB).ok).toBe(true);
    session = signIn(DB, 1);
    legacy = JSON.parse(asRole(DB, deviceUser(1),
      `select public.open_register_session('77777777-7777-4777-8777-777777777777', 125.50)::text`))
      .registerSession.registerSessionId;
  }, 300_000);

  it("11. a sale naming the open manual drawer period is attributed to it", () => {
    expect(JSON.parse(sale(DB, 1, { request: SALES.today, session, register: legacy }))
      .attribution.registerSessionId).toBe(legacy);
  });

  it("11b. a manual register is NOT reinterpreted as daily, whatever the calendar says", () => {
    expect(sql(DB, `select coalesce(business_date::text,'NULL') from public.register_sessions
                    where id='${legacy}'`)).toBe("NULL");
    expect(sql(DB, `select count(*) from public.register_sessions where business_date is not null`))
      .toBe("0");
  });

  it("11c. a closed manual register still refuses, with the accepted message", () => {
    asRole(DB, deviceUser(1), `select public.close_register_session('${legacy}')`);

    expect(saleExpectingFailure(DB, 1, { request: SALES.rolled, session, register: legacy }))
      .toBe("The register is not open");
  });

  it("11d. an open manual register plus a stale expectation is still 'changed'", () => {
    const reopened = JSON.parse(asRole(DB, deviceUser(1),
      `select public.open_register_session('66666666-6666-4666-8666-666666666666', 10.00)::text`))
      .registerSession.registerSessionId;

    expect(reopened).not.toBe(legacy);
    expect(saleExpectingFailure(DB, 1, { request: SALES.rolled, session, register: legacy }))
      .toBe("The register session changed");
  });
});

// ===========================================================================
// REPLAY
// ===========================================================================

run("a completed sale replays untouched, whatever has happened since", () => {
  const DB = "cp2c_replay";
  let session = "";
  let yesterday = "";
  let todayOnline = "";
  let queuedTotal = "";
  let queuedEmployee: string | null = null;

  beforeAll(() => {
    freshDatabase(DB, false);
    seedSales(DB, 1);
    expect(applyMigration(DB).ok).toBe(true);
    session = signIn(DB, 1);

    // A sale that happened YESTERDAY and synced then, so its stored attribution
    // names yesterday's context. Midnight has since passed for this till -- the
    // legitimate way to reach that state, since a daily row is immutable and
    // cannot be dragged backwards.
    yesterday = dailyRow(DB, 1, -1);
    const queued = JSON.parse(sale(DB, 1, {
      request: SALES.replay, session, register: yesterday,
      source: "offline_queued", at: instantIn(-1, "10 hours"),
    }));

    queuedTotal = queued.total;
    // Whatever the employee claim validated to at the time -- null here,
    // because the POS session started today and the sale happened yesterday,
    // which is the accepted validate-or-NULL rule doing its job. The claim
    // being replayed is that a replay returns what was STORED.
    queuedEmployee = queued.attribution.employeeId;

    // And a sale taken online today, against today's context.
    todayOnline = JSON.parse(asRole(DB, deviceUser(1),
      `select public.ensure_daily_register_context()::text`)).registerSession.registerSessionId;
    sale(DB, 1, { request: SALES.today, session, register: todayOnline });
  }, 300_000);

  it("13-14. after midnight it replays with its ORIGINAL order and attribution", () => {
    // Everything a replay could have been made to depend on is now gone: the
    // business has no timezone at all, and nobody is signed in.
    sql(DB, `update public.projects set business_timezone = null where id='${PROJECT}'`);
    asRole(DB, deviceUser(1), `select public.employee_logout()`);

    const replayed = JSON.parse(sale(DB, 1, {
      request: SALES.replay, session, register: yesterday,
      source: "offline_queued", at: instantIn(-1, "10 hours"),
    }));

    expect(replayed.total).toBe(queuedTotal);
    expect(replayed.attribution.registerSessionId).toBe(yesterday);
    expect(replayed.attribution.employeeId).toBe(queuedEmployee);
    expect(filedUnder(DB, SALES.replay))
      .toBe(sql(DB, `select ((now() at time zone '${ZONE}')::date - 1)::text`));
  });

  it("16-17. the ONLINE replay ignores the missing timezone and the empty till", () => {
    const replayed = JSON.parse(sale(DB, 1, { request: SALES.today, session, register: todayOnline }));

    expect(replayed.attribution.registerSessionId).toBe(todayOnline);
    expect(replayed.attribution.employeeId).toBe(EMPLOYEE);
    expect(sql(DB, `select business_timezone is null from public.projects where id='${PROJECT}'`)).toBe("t");
    expect(sql(DB, `select count(*) from public.employee_pos_sessions
                    where paired_device_id='${device(1)}' and ended_at is null`)).toBe("0");
  });

  it("and a NEW sale in that same state is refused — replay is what is special", () => {
    expect(saleExpectingFailure(DB, 1, { request: SALES.rolled, session, register: todayOnline }))
      .toBe("An employee must be signed in on this register");
  });

  it("15. no replay created a daily context, and none was changed", () => {
    expect(sql(DB, `select count(*) from public.register_sessions
                    where paired_device_id='${device(1)}'`)).toBe("2");
    expect(sql(DB, `select string_agg(business_date::text, ',' order by business_date)
                    from public.register_sessions where paired_device_id='${device(1)}'`))
      .toBe(sql(DB, `select ((now() at time zone '${ZONE}')::date - 1)::text || ',' ||
                            (now() at time zone '${ZONE}')::date::text`));
  });

  it("19. and wrote no second order, item or inventory transaction", () => {
    expect(sql(DB, `select count(*) from public.orders`)).toBe("2");
    expect(sql(DB, `select count(*) from public.order_items`)).toBe("2");
  });

  it("18. a DIFFERENT payload under the same request id is still a conflict", () => {
    sql(DB, `update public.projects set business_timezone='${ZONE}' where id='${PROJECT}'`);

    expect(saleExpectingFailure(DB, 1, {
      request: SALES.replay, session, register: yesterday,
      source: "offline_queued", at: instantIn(-1, "10 hours"), quantity: 2,
    })).toBe("Sale request ID was already used for a different order");
  });

  it("41-45. the stored order's money, source and hash are exactly what they were", () => {
    expect(sql(DB, `select subtotal::text || ' ' || tax_amount::text || ' ' ||
                           tip_amount::text || ' ' || total::text || ' ' || source
                    from public.orders where sale_request_id='${SALES.replay}'`))
      .toBe("4.00 0.00 0.00 4.00 offline_queued");
    expect(sql(DB, `select (sale_request_hash is not null)::text from public.orders
                    where sale_request_id='${SALES.replay}'`)).toBe("true");
  });
});

// ===========================================================================
// OFFLINE
// ===========================================================================

run("a queued sale lands on the day it happened, not the day its claim names", () => {
  const DB = "cp2c_offline";
  let session = "";
  let claim = "";

  beforeAll(() => {
    freshDatabase(DB, false);
    seedSales(DB, 2);
    expect(applyMigration(DB).ok).toBe(true);
    session = signIn(DB, 1);
    // The retained claim: TODAY's context, which is what a till that queued
    // sales across midnight would still be holding.
    claim = JSON.parse(asRole(DB, deviceUser(1),
      `select public.ensure_daily_register_context()::text`)).registerSession.registerSessionId;
  }, 300_000);

  it("20-21, 26. ONE retained claim, two instants, two different business days", () => {
    // 23:58 on the day before yesterday, and 00:07 the morning after it. Both
    // safely in the past, so no accepted occurred_at guard is what decides this.
    sale(DB, 1, {
      request: SALES.preMid, session, register: claim,
      source: "offline_queued", at: instantIn(-2, "23 hours 58 minutes"),
    });
    sale(DB, 1, {
      request: SALES.postMid, session, register: claim,
      source: "offline_queued", at: instantIn(-1, "7 minutes"),
    });

    const day = (n: number): string =>
      sql(DB, `select ((now() at time zone '${ZONE}')::date + ${n})::text`);

    expect(`pre: ${filedUnder(DB, SALES.preMid)}`).toBe(`pre: ${day(-2)}`);
    expect(`post: ${filedUnder(DB, SALES.postMid)}`).toBe(`post: ${day(-1)}`);

    // 26. Yesterday's retained id controlled neither of them.
    expect(sql(DB, `select count(*) from public.orders
                    where sale_request_id in ('${SALES.preMid}','${SALES.postMid}')
                      and register_session_id = '${claim}'`)).toBe("0");
  });

  it("22-23. the historical contexts were created, with exact bounds and zone", () => {
    expect(sql(DB, `select count(*) from public.register_sessions
                    where paired_device_id='${device(1)}' and business_date is not null`)).toBe("3");
    expect(sql(DB, `select count(*) from public.register_sessions r
                    cross join lateral public.business_day_bounds(r.business_date, r.business_timezone) b
                    where r.business_date is not null
                      and (r.opened_at <> b.starts_at or r.closed_at <> b.ends_at
                           or r.business_timezone <> '${ZONE}')`)).toBe("0");
  });

  it("27. device attribution stayed server-derived throughout", () => {
    expect(sql(DB, `select count(*) from public.orders
                    where sale_request_id in ('${SALES.preMid}','${SALES.postMid}')
                      and paired_device_id = '${device(1)}'`)).toBe("2");
  });

  it("24. re-syncing the same queued record changes nothing", () => {
    const before = sql(DB, `select md5(string_agg(md5(o::text), '|' order by o.id::text))
                            from public.orders o`);

    const again = JSON.parse(sale(DB, 1, {
      request: SALES.postMid, session, register: claim,
      source: "offline_queued", at: instantIn(-1, "7 minutes"),
    }));

    expect(again.attribution.registerSessionId)
      .toBe(sql(DB, `select register_session_id::text from public.orders
                     where sale_request_id='${SALES.postMid}'`));
    expect(sql(DB, `select md5(string_agg(md5(o::text), '|' order by o.id::text))
                    from public.orders o`)).toBe(before);
  });

  it("25. concurrent historical derivation for the same day creates ONE context", async () => {
    // Six backends syncing six queued sales that all happened on the same past
    // business day, none of which has a context yet.
    const requests = Array.from({ length: 6 }, (_, i) =>
      `50000000-0000-4000-8000-00000000000${i + 1}`);

    await Promise.all(requests.map((request, i) =>
      execFileAsync(join(PG_BIN as string, "psql"), [
        ...psqlArgs(DB), "-Atq", "-c",
        `select set_config('request.jwt.claim.sub','${deviceUser(1)}', false);
         select public.complete_sale_v5('cash', 0, ${ONE_LATTE}, '${request}',
           ${instantIn(-5, `${9 + i} hours`)}, 'offline_queued', '${session}', '${claim}')::text`,
      ], { encoding: "utf8", env: { ...process.env, LC_ALL: "en_US.UTF-8", PGTZ: "UTC" } })));

    const day = sql(DB, `select ((now() at time zone '${ZONE}')::date - 5)::text`);

    expect(sql(DB, `select count(*) from public.register_sessions
                    where paired_device_id='${device(1)}' and business_date='${day}'`)).toBe("1");
    expect(sql(DB, `select count(distinct register_session_id) from public.orders
                    where sale_request_id in (${requests.map((r) => `'${r}'`).join(",")})`)).toBe("1");
    expect(sql(DB, `select count(*) from public.orders
                    where sale_request_id in (${requests.map((r) => `'${r}'`).join(",")})`)).toBe("6");
  }, 90_000);
});

run("old and legacy queued records are not reinterpreted", () => {
  const DB = "cp2c_offline_compat";
  let session = "";
  let legacy = "";
  let daily = "";

  beforeAll(() => {
    freshDatabase(DB, false);
    seedSales(DB, 2);
    expect(applyMigration(DB).ok).toBe(true);
    session = signIn(DB, 1);
    legacy = JSON.parse(asRole(DB, deviceUser(1),
      `select public.open_register_session('77777777-7777-4777-8777-777777777777', 125.50)::text`))
      .registerSession.registerSessionId;
    daily = JSON.parse(asRole(DB, deviceUser(1),
      `select public.ensure_daily_register_context()::text`)).registerSession.registerSessionId;
  }, 300_000);

  it("29-30. a NULL claim from an old queue syncs, and invents no attribution", () => {
    const answer = JSON.parse(sale(DB, 1, {
      request: SALES.nullClaim, session: null, register: null,
      source: "offline_queued", at: instantIn(-1, "10 hours"),
    }));

    expect(answer.total).toBe("4.00");
    expect(answer.attribution.registerSessionId).toBeNull();
    expect(answer.attribution.employeeId).toBeNull();
    // Server-derived device attribution is still recorded.
    expect(answer.attribution.pairedDeviceId).toBe(device(1));
  });

  it("30b. and no daily context was created for that day on its behalf", () => {
    const day = sql(DB, `select ((now() at time zone '${ZONE}')::date - 1)::text`);

    expect(sql(DB, `select count(*) from public.register_sessions
                    where paired_device_id='${device(1)}' and business_date='${day}'`)).toBe("0");
  });

  it("28. a LEGACY claim is validated against its own interval, exactly as before", () => {
    // Outside the manual register's interval: unprovable, stored NULL.
    expect(JSON.parse(sale(DB, 1, {
      request: SALES.legacyOld, session, register: legacy,
      source: "offline_queued", at: instantIn(-1, "10 hours"),
    })).attribution.registerSessionId).toBeNull();

    // Inside it: validated and stored.
    expect(JSON.parse(sale(DB, 1, {
      request: SALES.legacyIn, session, register: legacy,
      source: "offline_queued", at: "now()",
    })).attribution.registerSessionId).toBe(legacy);
  });

  it("28b. and a legacy claim never derives a daily context", () => {
    expect(sql(DB, `select count(*) from public.register_sessions
                    where paired_device_id='${device(1)}' and business_date is not null`)).toBe("1");
    expect(sql(DB, `select business_date::text from public.register_sessions
                    where id='${daily}'`)).toBe(today(DB));
  });

  it("31. another device's DAILY id cannot signal daily mode for this till", () => {
    const theirs = JSON.parse(asRole(DB, deviceUser(2),
      `select public.ensure_daily_register_context()::text`)).registerSession.registerSessionId;
    const before = sql(DB, `select count(*) from public.register_sessions
                            where paired_device_id='${device(1)}'`);

    expect(JSON.parse(sale(DB, 1, {
      request: SALES.foreignCl, session, register: theirs,
      source: "offline_queued", at: instantIn(-1, "10 hours"),
    })).attribution.registerSessionId).toBeNull();

    // And it manufactured nothing for this device.
    expect(sql(DB, `select count(*) from public.register_sessions
                    where paired_device_id='${device(1)}'`)).toBe(before);
  });
});

// ===========================================================================
// QUEUED MONEY
// ===========================================================================

run("a paid queued sale is never lost to an attribution question", () => {
  const DB = "cp2c_money";
  let session = "";
  let claim = "";

  beforeAll(() => {
    freshDatabase(DB, false);
    seedSales(DB, 1);
    expect(applyMigration(DB).ok).toBe(true);
    session = signIn(DB, 1);
    claim = JSON.parse(asRole(DB, deviceUser(1),
      `select public.ensure_daily_register_context()::text`)).registerSession.registerSessionId;
  }, 300_000);

  it("33-35. no timezone: the sale completes, the register is NULL, money is intact", () => {
    sql(DB, `update public.projects set business_timezone = null where id='${PROJECT}'`);

    const answer = JSON.parse(sale(DB, 1, {
      request: SALES.noZone, session, register: claim,
      source: "offline_queued", at: "now()",
    }));

    expect(answer.total).toBe("4.00");
    expect(answer.attribution.registerSessionId).toBeNull();
    expect(answer.attribution.pairedDeviceId).toBe(device(1));
    // 35. The employee claim is validated on its own and still holds.
    expect(answer.attribution.employeeId).toBe(EMPLOYEE);
  });

  it("33b. a timezone CONFLICT does the same: preserved, unattributed, no rewrite", () => {
    // Restore a DIFFERENT zone, so today's existing context conflicts with it.
    sql(DB, `update public.projects set business_timezone='America/Chicago' where id='${PROJECT}'`);

    const before = sql(DB, `select md5(string_agg(md5(r::text), '|' order by r.id::text))
                            from public.register_sessions r`);
    const answer = JSON.parse(sale(DB, 1, {
      request: SALES.conflict, session, register: claim,
      source: "offline_queued", at: "now()",
    }));

    expect(answer.total).toBe("4.00");
    expect(answer.attribution.registerSessionId).toBeNull();

    // Nothing historical was rewritten, and no overlapping row was created.
    expect(sql(DB, `select md5(string_agg(md5(r::text), '|' order by r.id::text))
                    from public.register_sessions r`)).toBe(before);
  });

  it("but the ONLINE path refuses a NEW sale it cannot place on a day", () => {
    expect(saleExpectingFailure(DB, 1, { request: SALES.today, session, register: claim }))
      .toBe("daily_register_timezone_conflict");

    sql(DB, `update public.projects set business_timezone = null where id='${PROJECT}'`);
    expect(saleExpectingFailure(DB, 1, { request: SALES.today, session, register: claim }))
      .toBe("business_timezone_required");

    sql(DB, `update public.projects set business_timezone='${ZONE}' where id='${PROJECT}'`);
  });

  it("36-40. the fallback excuses nothing financial or temporal", () => {
    const cases: Array<[string, SaleArgs, string]> = [
      ["37. future occurred_at", {
        request: SALES.rolled, session, register: claim, source: "offline_queued",
        at: "now() + interval '20 minutes'",
      }, "Offline sale time is in the future"],
      ["39. older than the offline limit", {
        request: SALES.slept, session, register: claim, source: "offline_queued",
        at: "now() - interval '9 days'",
      }, "Offline sale time is older than the offline limit"],
      ["39b. older than the device itself", {
        request: SALES.future, session, register: claim, source: "offline_queued",
        at: "now() - interval '40 days'",
      }, "Offline sale time predates this device"],
      ["36. hash conflict", {
        request: SALES.noZone, session, register: claim, source: "offline_queued",
        at: "now()", quantity: 3,
      }, "Sale request ID was already used for a different order"],
      ["offline without a time", {
        request: SALES.foreign, session, register: claim, source: "offline_queued",
      }, "An offline sale must declare when it happened"],
    ];

    for (const [label, args, message] of cases) {
      expect(`${label}: ${saleExpectingFailure(DB, 1, args)}`).toBe(`${label}: ${message}`);
    }
  });

  it("38. the pairing temporal guard is unchanged", () => {
    // A till paired two days ago cannot have taken a sale three days ago. The
    // age limit is seven days, so this bound is only reachable with a device
    // young enough for it to be the FIRST rule the timestamp breaks.
    sql(DB, `
      insert into auth.users (id) values ('${deviceUser(9)}');
      insert into public.paired_devices (id, auth_user_id, owner_id, project_id, build_job_id, created_at)
      values ('${device(9)}','${deviceUser(9)}','${OWNER}','${PROJECT}','${BUILD}', now() - interval '2 days');
    `);

    expect(saleExpectingFailure(DB, 9, {
      request: SALES.staleEmp, session: null, register: null,
      source: "offline_queued", at: "now() - interval '3 days'",
    })).toBe("Offline sale time predates this device");
  });

  it("40b. a clock inside the skew allowance is still accepted", () => {
    expect(JSON.parse(sale(DB, 1, {
      request: SALES.foreign, session, register: claim,
      source: "offline_queued", at: "now() + interval '2 minutes'",
    })).total).toBe("4.00");
  });
});

// ===========================================================================
// THE CLAIM'S TIMEZONE SNAPSHOT
// ===========================================================================

run("a queued sale is never reinterpreted under a timezone it never knew", () => {
  const DB = "cp2c_snapshot";
  let session = "";
  let claim = "";
  let claimRow = "";
  let occurredAt = "";
  let pastDay = "";

  beforeAll(() => {
    freshDatabase(DB, false);
    seedSales(DB, 1);
    expect(applyMigration(DB).ok).toBe(true);
    session = signIn(DB, 1);

    // 1-2. A real daily claim of THIS device, taken under New York.
    claim = JSON.parse(asRole(DB, deviceUser(1),
      `select public.ensure_daily_register_context()::text`)).registerSession.registerSessionId;
    claimRow = sql(DB, `select md5(r::text) from public.register_sessions r where r.id='${claim}'`);

    // 3. A past business date that has NO context at all. That is what makes
    //    this case different from the conflict the helper can already see:
    //    with nothing covering the instant, the helper would happily CREATE a
    //    context under whatever zone is current.
    occurredAt = instantIn(-3, "9 hours");
    pastDay = sql(DB, `select ((now() at time zone '${ZONE}')::date - 3)::text`);
  }, 300_000);

  it("the target day genuinely has no context, and the claim is a New York one", () => {
    expect(sql(DB, `select business_timezone from public.register_sessions where id='${claim}'`))
      .toBe(ZONE);
    expect(sql(DB, `select count(*) from public.register_sessions
                    where paired_device_id='${device(1)}' and business_date='${pastDay}'`)).toBe("0");
    expect(sql(DB, `select count(*) from public.register_sessions
                    where paired_device_id='${device(1)}'`)).toBe("1");
  });

  it("4-5. with the business now on Chicago, the sale completes and is UNATTRIBUTED", () => {
    sql(DB, `update public.projects set business_timezone='America/Chicago' where id='${PROJECT}'`);

    const answer = JSON.parse(sale(DB, 1, {
      request: SALES.snapshot, session, register: claim,
      source: "offline_queued", at: occurredAt,
    }));

    // Financially whole.
    expect(answer.total).toBe("4.00");
    expect(answer.subtotal).toBe("4.00");
    // Register attribution unprovable.
    expect(answer.attribution.registerSessionId).toBeNull();
    // Device attribution stays server-derived.
    expect(answer.attribution.pairedDeviceId).toBe(device(1));
  });

  it("exactly one order, with the register NULL and the device intact", () => {
    expect(sql(DB, `select count(*) from public.orders
                    where sale_request_id='${SALES.snapshot}'`)).toBe("1");
    expect(sql(DB, `select coalesce(register_session_id::text,'NULL') || ' | ' ||
                           coalesce(paired_device_id::text,'NULL') || ' | ' || total::text
                    from public.orders where sale_request_id='${SALES.snapshot}'`))
      .toBe(`NULL | ${device(1)} | 4.00`);
  });

  it("NO Chicago historical context was created — this is the whole point", () => {
    // If the snapshot comparison were absent, the helper would have created a
    // context for this instant under America/Chicago and attributed the sale
    // to it. Nothing was created at all.
    expect(sql(DB, `select count(*) from public.register_sessions
                    where paired_device_id='${device(1)}'`)).toBe("1");
    expect(sql(DB, `select count(*) from public.register_sessions
                    where business_timezone <> '${ZONE}'`)).toBe("0");
  });

  it("and the NULL is because of the SNAPSHOT, not the overlap protection", () => {
    // Stated explicitly, because the two produce the same stored result. The
    // helper's conflict check only fires when an existing interval covers the
    // instant; there is no such interval here, and the claim's own interval is
    // nowhere near this occurred_at.
    expect(sql(DB, `select count(*) from public.register_sessions r
                    where r.paired_device_id='${device(1)}'
                      and r.business_date is not null
                      and r.opened_at <= ${occurredAt} and ${occurredAt} < r.closed_at`)).toBe("0");
    expect(sql(DB, `select (r.business_timezone is distinct from p.business_timezone)::text
                    from public.register_sessions r
                    cross join public.projects p
                    where r.id='${claim}' and p.id='${PROJECT}'`)).toBe("true");
  });

  it("8. the original New York claim row is byte-for-byte unchanged", () => {
    expect(sql(DB, `select md5(r::text) from public.register_sessions r where r.id='${claim}'`))
      .toBe(claimRow);
  });

  it("7. employee attribution still followed its own independent validation", () => {
    // The POS session started today; the sale happened three days ago, so the
    // claim does not validate and is NULL -- by the accepted Feature 1B rule,
    // not by anything this correction added.
    expect(sql(DB, `select coalesce(employee_id::text,'NULL') from public.orders
                    where sale_request_id='${SALES.snapshot}'`)).toBe("NULL");

    const inSession = JSON.parse(sale(DB, 1, {
      request: SALES.snapNeg, session, register: claim,
      source: "offline_queued", at: "now()",
    }));

    // Same snapshot mismatch, so the register is still NULL -- but the
    // employee claim is inside its session and is recorded.
    expect(inSession.attribution.registerSessionId).toBeNull();
    expect(inSession.attribution.employeeId).toBe(EMPLOYEE);
  });

  it("restoring the original zone makes derivation possible again", () => {
    sql(DB, `update public.projects set business_timezone='${ZONE}' where id='${PROJECT}'`);

    const answer = JSON.parse(sale(DB, 1, {
      request: SALES.rolled, session, register: claim,
      source: "offline_queued", at: occurredAt,
    }));

    expect(answer.attribution.registerSessionId).not.toBeNull();
    expect(filedUnder(DB, SALES.rolled)).toBe(pastDay);
  });
});

// ===========================================================================
// THE INTERNAL HELPER IS NOT A SECOND, WEAKER IMPLEMENTATION
// ===========================================================================

run("the private helper and CP2b's public ensure agree", () => {
  const DB = "cp2c_helper";

  beforeAll(() => {
    freshDatabase(DB, false);
    seedSales(DB, 2);
    expect(applyMigration(DB).ok).toBe(true);
  }, 300_000);

  it("15-item. for the same instant they return the SAME context", () => {
    const viaPublic = JSON.parse(asRole(DB, deviceUser(1),
      `select public.ensure_daily_register_context()::text`)).registerSession.registerSessionId;
    const viaHelper = sql(DB, `select register_session_id::text
                               from public.daily_register_context_for_sale('${device(1)}', now())`);

    expect(viaHelper).toBe(viaPublic);
  });

  it("it obeys CP2b's calendar: exact bounds, from CP2a, on a DST day", () => {
    // A past spring-forward instant, derived rather than asserted: whatever
    // day it lands on, the row it creates must match business_day_bounds.
    sql(DB, `select register_session_id from public.daily_register_context_for_sale(
               '${device(2)}', (now() at time zone '${ZONE}')::date - 3)`);

    expect(sql(DB, `select count(*) from public.register_sessions r
                    cross join lateral public.business_day_bounds(r.business_date, r.business_timezone) b
                    where r.paired_device_id='${device(2)}'
                      and (r.opened_at <> b.starts_at or r.closed_at <> b.ends_at)`)).toBe("0");
  });

  it("it reports CP2b's failures rather than inventing its own", () => {
    sql(DB, `update public.projects set business_timezone = null where id='${PROJECT}'`);
    expect(sql(DB, `select failure from public.daily_register_context_for_sale('${device(1)}', now())`))
      .toBe("business_timezone_required");

    sql(DB, `update public.projects set business_timezone='America/Chicago' where id='${PROJECT}'`);
    expect(sql(DB, `select failure from public.daily_register_context_for_sale('${device(1)}', now())`))
      .toBe("daily_register_timezone_conflict");

    sql(DB, `update public.projects set business_timezone='${ZONE}' where id='${PROJECT}'`);
    expect(sql(DB, `select coalesce(failure,'none')
                    from public.daily_register_context_for_sale('${device(1)}', now())`)).toBe("none");
  });

  it("and it never bridges a gap: one day per call, nothing in between", () => {
    const before = Number(sql(DB, `select count(*) from public.register_sessions
                                   where paired_device_id='${device(1)}'`));

    sql(DB, `select register_session_id from public.daily_register_context_for_sale(
               '${device(1)}', now() - interval '4 days')`);

    expect(Number(sql(DB, `select count(*) from public.register_sessions
                           where paired_device_id='${device(1)}'`))).toBe(before + 1);
  });
});

// ===========================================================================
// REGRESSION
// ===========================================================================

run("regression: everything CP2c promised not to touch", () => {
  const BEFORE = "cp2c_before";
  const AFTER = "cp2c_after";

  const fingerprint = (db: string, signature: string): string =>
    sql(db, `select md5(pg_get_functiondef('${signature}'::regprocedure::oid)) || ' ' ||
                    p.prosecdef::text || ' ' || coalesce(p.proacl::text,'default')
             from pg_proc p where p.oid = '${signature}'::regprocedure::oid`);

  beforeAll(() => {
    freshDatabase(BEFORE, false);
    freshDatabase(AFTER, false);
    expect(applyMigration(AFTER).ok).toBe(true);
  }, 600_000);

  it("24. the financial hash function and its inputs are untouched", () => {
    // complete_sale_v5's canonical preimage lives in its own body; every OTHER
    // function that participates in pricing or hashing is byte-identical.
    const digest = (db: string): string =>
      sql(db, `select md5(string_agg(
                 p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')=' ||
                 md5(pg_get_functiondef(p.oid)),
                 '|' order by p.proname, pg_get_function_identity_arguments(p.oid)))
               from pg_proc p join pg_namespace n on n.oid=p.pronamespace
               where n.nspname='public' and p.prokind='f'
                 and p.proname not in ('complete_sale_v5', 'daily_register_context_for_sale')`);

    expect(digest(AFTER)).toBe(digest(BEFORE));
  });

  it("every accepted sale function before v5 is byte-identical", () => {
    for (const sig of [
      "public.complete_sale_v4(uuid,text,numeric,jsonb,uuid,timestamptz,text)",
      "public.complete_sale_v3(uuid,text,numeric,jsonb,uuid)",
      "public.complete_sale_v2(uuid,text,numeric,jsonb,uuid)",
    ]) {
      expect(`${sig}: ${fingerprint(AFTER, sig)}`).toBe(`${sig}: ${fingerprint(BEFORE, sig)}`);
    }
  });

  it("so are the register RPCs, CP2a's calendar and CP2b's guards", () => {
    for (const sig of [
      "public.open_register_session(uuid,numeric)",
      "public.get_current_register_session()",
      "public.close_register_session(uuid)",
      "public.ensure_daily_register_context()",
      "public.require_business_timezone(uuid)",
      "public.business_day_bounds(date,text)",
      "public.business_date_of(timestamptz,text)",
      "public.register_sessions_guard_daily_immutable()",
      "public.register_sessions_validate_daily_bounds()",
    ]) {
      expect(`${sig}: ${fingerprint(AFTER, sig)}`).toBe(`${sig}: ${fingerprint(BEFORE, sig)}`);
    }
  });

  it("5. complete_sale_v5's signature, posture and grants did not move", () => {
    const contract = (db: string): string =>
      sql(db, `select pg_get_function_identity_arguments(p.oid) || ' | ' ||
                      p.prosecdef::text || ' | ' || array_to_string(p.proconfig, ',') || ' | ' ||
                      coalesce(p.proacl::text,'default')
               from pg_proc p join pg_namespace n on n.oid=p.pronamespace
               where n.nspname='public' and p.proname='complete_sale_v5'`);

    expect(contract(AFTER)).toBe(contract(BEFORE));
  });

  it("its body differs from the accepted one by ADDED LINES ONLY", () => {
    // The legacy blocks moved inside an `else`, so their indentation changed.
    // Comparing trimmed lines in step is the real claim: every accepted line
    // still there, in order, with pricing, hashing, idempotency, occurred_at,
    // inventory and the payload among them.
    const body = (db: string): string[] =>
      sql(db, `select pg_get_functiondef(
                 'public.complete_sale_v5(text,numeric,jsonb,uuid,timestamptz,text,uuid,uuid)'::regprocedure)`)
        .split("\n").map((line) => line.trim());

    const before = body(BEFORE);
    const after = body(AFTER);
    let i = 0;

    for (const line of after) {
      if (i < before.length && line === before[i]) i += 1;
    }

    expect(`${i} of ${before.length} accepted lines survived, in order`)
      .toBe(`${before.length} of ${before.length} accepted lines survived, in order`);
    expect(after.length).toBeGreaterThan(before.length);
  });

  it("11. replay ordering is unchanged in the text: idempotency before both", () => {
    const at = (db: string, needle: string): number => Number(sql(db, `
      select min(i) from generate_subscripts(
        string_to_array(pg_get_functiondef(
          'public.complete_sale_v5(text,numeric,jsonb,uuid,timestamptz,text,uuid,uuid)'::regprocedure),
          chr(10)), 1) i
      where (string_to_array(pg_get_functiondef(
        'public.complete_sale_v5(text,numeric,jsonb,uuid,timestamptz,text,uuid,uuid)'::regprocedure),
        chr(10)))[i] like '${needle}'`));

    for (const db of [BEFORE, AFTER]) {
      const lookup = at(db, "%and o.sale_request_id = p_sale_request_id%");
      const occurred = at(db, "%6b. Feature 24.5B%");
      const attribution = at(db, "%6d. v1.3 Feature 1B%");

      expect(`${db}: lookup ${lookup < occurred ? "before" : "AFTER"} occurred_at`)
        .toBe(`${db}: lookup before occurred_at`);
      expect(`${db}: lookup ${lookup < attribution ? "before" : "AFTER"} attribution`)
        .toBe(`${db}: lookup before attribution`);
    }
  });

  it("26. no schema object changed: columns, constraints, indexes, triggers", () => {
    const shape = (db: string): string =>
      sql(db, `select md5(
        (select coalesce(string_agg(table_name||'.'||column_name||':'||data_type||':'||is_nullable||':'||
                                    coalesce(column_default,''), '|' order by table_name, column_name), '')
         from information_schema.columns where table_schema='public') ||
        (select coalesce(string_agg(c.conrelid::regclass::text||'.'||c.conname||'='||pg_get_constraintdef(c.oid),
                                    '|' order by c.conrelid::regclass::text, c.conname), '')
         from pg_constraint c join pg_namespace n on n.oid=c.connamespace
         where n.nspname='public' and c.contype in ('c','f','p','u','x')) ||
        (select coalesce(string_agg(indexname||'='||indexdef, '|' order by indexname), '')
         from pg_indexes where schemaname='public') ||
        (select coalesce(string_agg(t.tgname||'='||pg_get_triggerdef(t.oid), '|' order by t.tgname), '')
         from pg_trigger t join pg_class cl on cl.oid=t.tgrelid
         join pg_namespace n on n.oid=cl.relnamespace
         where n.nspname='public' and not t.tgisinternal))`);

    expect(shape(AFTER)).toBe(shape(BEFORE));
  });

  it("27. privileges and RLS policies are identical", () => {
    const posture = (db: string): string =>
      sql(db, `select md5(
        (select coalesce(string_agg(r.rolname||' '||t.relname||' '||p.priv||'='||
                                    has_table_privilege(r.rolname, t.oid, p.priv)::text,
                                    '|' order by r.rolname, t.relname, p.priv), '')
         from (values ('anon'),('authenticated'),('service_role')) r(rolname)
         cross join (select c.oid, c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
                     where n.nspname='public' and c.relkind='r') t
         cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) p(priv)) ||
        (select coalesce(string_agg(tablename||'.'||policyname||':'||cmd||':'||coalesce(qual,'')||':'||
                                    coalesce(with_check,'')||':'||roles::text,
                                    '|' order by tablename, policyname), '')
         from pg_policies where schemaname='public'))`);

    expect(posture(AFTER)).toBe(posture(BEFORE));
  });

  it("23. the employee identity layer still works end to end", () => {
    for (const db of [BEFORE, AFTER]) {
      seedSales(db, 1);
      expect(`${db}: ${asRole(db, deviceUser(1),
        `select public.employee_login_by_code('001','2222')->>'employeeId'`)}`)
        .toBe(`${db}: ${EMPLOYEE}`);
    }
  });
});

// ===========================================================================
// NEGATIVE CONTROLS
// ===========================================================================

run("the tests above fail against a deliberately broken complete_sale_v5", () => {
  const DB = "cp2c_negative";
  let session = "";
  let todayDaily = "";

  /** Runs `probe` under a broken v5 and returns what it observed, or its error. */
  const broken = (edits: Array<[string, string]>, probe: () => string): string => {
    let observed = "";

    withBrokenV5(DB, edits, () => {
      try {
        observed = probe();
      } catch (error) {
        const err = error as { stderr?: string; message?: string };
        observed = (/ERROR:\s*(.*)/.exec((err.stderr ?? err.message ?? "").toString())?.[1] ?? "threw")
          .trim();
      }
    });

    return observed;
  };

  beforeAll(() => {
    freshDatabase(DB, false);
    seedSales(DB, 2);
    expect(applyMigration(DB).ok).toBe(true);
    session = signIn(DB, 1);
    todayDaily = JSON.parse(asRole(DB, deviceUser(1),
      `select public.ensure_daily_register_context()::text`)).registerSession.registerSessionId;
  }, 300_000);

  it("the mutation machinery really does install and restore the function", () => {
    const original = sql(DB, `select md5(pg_get_functiondef(
      'public.complete_sale_v5(text,numeric,jsonb,uuid,timestamptz,text,uuid,uuid)'::regprocedure))`);

    withBrokenV5(DB, [[
      "        and r.business_date is not null\n      for share;",
      "        and r.closed_at is null\n      for share;",
    ]], () => {
      expect(sql(DB, `select md5(pg_get_functiondef(
        'public.complete_sale_v5(text,numeric,jsonb,uuid,timestamptz,text,uuid,uuid)'::regprocedure))`))
        .not.toBe(original);
    });

    expect(sql(DB, `select md5(pg_get_functiondef(
      'public.complete_sale_v5(text,numeric,jsonb,uuid,timestamptz,text,uuid,uuid)'::regprocedure))`))
      .toBe(original);
  });

  it("CONTROL 1: reverting daily currentness to `closed_at is null` breaks today's sale", () => {
    // A daily row always has closed_at set, so the legacy test can never find
    // one. If the real implementation used it, test 1 above could not pass.
    const observed = broken(
      [["        and r.business_date is not null\n      for share;",
        "        and r.closed_at is null\n      for share;"]],
      () => JSON.parse(sale(DB, 1, { request: SALES.today, session, register: todayDaily }))
        .attribution.registerSessionId);

    expect(observed).toBe("The register is not open");
  });

  it("CONTROL 2: disabling the rollover branch breaks the midnight test", () => {
    const yesterday = dailyRow(DB, 1, -1);
    const observed = broken(
      [["        if v_expected_daily.business_date < v_business_date then",
        "        if false then"]],
      () => JSON.parse(sale(DB, 1, { request: SALES.rolled, session, register: yesterday }))
        .attribution.registerSessionId);

    expect(observed).toBe("The register session changed");

    // And with the function restored, the same call succeeds and rolls.
    expect(JSON.parse(sale(DB, 1, { request: SALES.rolled, session, register: yesterday }))
      .attribution.registerSessionId).toBe(todayDaily);
  });

  it("CONTROL 3: honouring the retained claim files a post-midnight sale on the wrong day", () => {
    const observed = broken(
      [["            v_register_session_id := v_daily.register_session_id;\n          end if;",
        "            v_register_session_id := v_daily_claim.id;\n          end if;"]],
      () => {
        sale(DB, 1, {
          request: SALES.postMid, session, register: todayDaily,
          source: "offline_queued", at: instantIn(-1, "7 minutes"),
        });
        return filedUnder(DB, SALES.postMid);
      });

    // Yesterday's retained id, wrongly honoured: the sale lands on TODAY.
    expect(observed).toBe(today(DB));

    // The real implementation files the same sale on the day it happened.
    sql(DB, `delete from public.order_items where order_id in
               (select id from public.orders where sale_request_id='${SALES.postMid}');
             delete from public.orders where sale_request_id='${SALES.postMid}'`);
    sale(DB, 1, {
      request: SALES.postMid, session, register: todayDaily,
      source: "offline_queued", at: instantIn(-1, "7 minutes"),
    });

    expect(filedUnder(DB, SALES.postMid))
      .toBe(sql(DB, `select ((now() at time zone '${ZONE}')::date - 1)::text`));
  });

  it("CONTROL 4: making replay resolve today's context breaks the replay test", () => {
    // A sale that happened yesterday, synced then. Its replay today must not
    // resolve -- let alone create -- today's context.
    const session2 = signIn(DB, 2);
    const yesterday = dailyRow(DB, 2, -1);

    sale(DB, 2, {
      request: SALES.replay, session: session2, register: yesterday,
      source: "offline_queued", at: instantIn(-1, "10 hours"),
    });

    expect(sql(DB, `select count(*) from public.register_sessions
                    where paired_device_id='${device(2)}'`)).toBe("1");

    const observed = broken(
      [["\n    v_order_id := v_existing.id;\n",
        "\n    v_order_id := v_existing.id;\n    perform public.daily_register_context_for_sale(v_device_id, now());\n"]],
      () => {
        sale(DB, 2, {
          request: SALES.replay, session: session2, register: yesterday,
          source: "offline_queued", at: instantIn(-1, "10 hours"),
        });
        return sql(DB, `select count(*) from public.register_sessions
                        where paired_device_id='${device(2)}'`);
      });

    // The broken replay created today's context. The real one does not.
    expect(observed).toBe("2");
  });

  it("CONTROL 5: letting a NULL claim reach the daily path invents attribution", () => {
    const observed = broken(
      [["      if p_register_session_id is not null then\n        -- ==================================================================\n        -- v1.3 CP2c -- THE CLAIM SIGNALS THE MODEL, NEVER THE ATTRIBUTION.",
        "      if true then\n        -- ==================================================================\n        -- v1.3 CP2c -- THE CLAIM SIGNALS THE MODEL, NEVER THE ATTRIBUTION."],
       ["        if found then\n          -- ================================================================\n          -- THE SNAPSHOT IS PART OF THE CLAIM, AND IT IS CHECKED FIRST.",
        "        if true then\n          -- ================================================================\n          -- THE SNAPSHOT IS PART OF THE CLAIM, AND IT IS CHECKED FIRST."],
       // The daily path has TWO gates now: the claim must be found, and its
       // snapshot must still match. Opening only one would leave a null claim
       // refused by the other, and the control would prove nothing.
       ["          if v_daily_claim.business_timezone is distinct from v_current_zone then",
        "          if false then"]],
      () => JSON.parse(sale(DB, 1, {
        request: SALES.nullClaim, session: null, register: null,
        source: "offline_queued", at: "now() - interval '1 minute'",
      })).attribution.registerSessionId ?? "NULL");

    expect(observed).toBe(todayDaily);

    // The real implementation stores nothing for an old queue record.
    sql(DB, `delete from public.order_items where order_id in
               (select id from public.orders where sale_request_id='${SALES.nullClaim}');
             delete from public.orders where sale_request_id='${SALES.nullClaim}'`);

    expect(JSON.parse(sale(DB, 1, {
      request: SALES.nullClaim, session: null, register: null,
      source: "offline_queued", at: "now() - interval '1 minute'",
    })).attribution.registerSessionId).toBeNull();
  });

  it("CONTROL 7: bypassing the snapshot check files the sale under the NEW timezone", () => {
    // The defect this correction fixes. A past day with no context, a claim
    // taken under New York, and a business that has since moved to Chicago:
    // without the comparison, the helper CREATES a Chicago context and
    // attributes a completed sale to a calendar the till never used.
    const claim = JSON.parse(asRole(DB, deviceUser(1),
      `select public.ensure_daily_register_context()::text`)).registerSession.registerSessionId;
    const at = instantIn(-6, "9 hours");
    const day = sql(DB, `select ((now() at time zone '${ZONE}')::date - 6)::text`);

    expect(sql(DB, `select business_timezone from public.register_sessions where id='${claim}'`))
      .toBe(ZONE);
    expect(sql(DB, `select count(*) from public.register_sessions
                    where paired_device_id='${device(1)}' and business_date='${day}'`)).toBe("0");

    sql(DB, `update public.projects set business_timezone='America/Chicago' where id='${PROJECT}'`);

    const observed = broken(
      [["          if v_daily_claim.business_timezone is distinct from v_current_zone then",
        "          if false then"]],
      () => {
        sale(DB, 1, {
          request: SALES.snapshot, session, register: claim,
          source: "offline_queued", at,
        });

        return sql(DB, `select coalesce(r.business_timezone,'NULL')
                        from public.orders o
                        left join public.register_sessions r on r.id = o.register_session_id
                        where o.sale_request_id='${SALES.snapshot}'`);
      });

    // Filed under a Chicago context that did not exist before this sale.
    expect(observed).toBe("America/Chicago");
    expect(sql(DB, `select count(*) from public.register_sessions
                    where paired_device_id='${device(1)}' and business_date='${day}'
                      and business_timezone='America/Chicago'`)).toBe("1");

    // The real implementation refuses to derive, and creates nothing.
    sql(DB, `delete from public.order_items where order_id in
               (select id from public.orders where sale_request_id='${SALES.snapNeg}');
             delete from public.orders where sale_request_id='${SALES.snapNeg}'`);

    const before = sql(DB, `select count(*) from public.register_sessions
                            where paired_device_id='${device(1)}'`);

    expect(JSON.parse(sale(DB, 1, {
      request: SALES.snapNeg, session, register: claim,
      source: "offline_queued", at: instantIn(-5, "9 hours"),
    })).attribution.registerSessionId).toBeNull();

    expect(sql(DB, `select count(*) from public.register_sessions
                    where paired_device_id='${device(1)}'`)).toBe(before);

    sql(DB, `update public.projects set business_timezone='${ZONE}' where id='${PROJECT}'`);
  });

  it("CONTROL 6: dropping the device scope lets another till's daily id authorize a sale", () => {
    const theirs = sql(DB, `select id::text from public.register_sessions
                            where paired_device_id='${device(2)}' and business_date is not null
                            order by business_date desc limit 1`);

    const observed = broken(
      [["      where r.id = p_register_session_id\n        and r.paired_device_id = v_device_id\n        and r.business_date is not null\n      for share;",
        "      where r.id = p_register_session_id\n        and r.business_date is not null\n      for share;"]],
      () => JSON.parse(sale(DB, 1, { request: SALES.foreign, session, register: theirs }))
        .attribution.registerSessionId ?? "NULL");

    // Accepted, when it must not be. The real implementation refuses.
    expect(observed).not.toBe("The register is not open");

    // A FRESH request id: the broken run above consumed SALES.foreign, and
    // re-sending it would replay rather than exercise the restored function.
    expect(saleExpectingFailure(DB, 1, { request: SALES.conflict, session, register: theirs }))
      .toBe("The register is not open");
  });
});

// ===========================================================================
// EXECUTION AS THE REAL authenticated ROLE
// ===========================================================================

run("a real `authenticated` till can ring up a daily sale, and nothing more", () => {
  const DB = "cp2c_authrole";
  let session = "";
  let daily = "";

  beforeAll(() => {
    freshDatabase(DB, false);
    seedSales(DB, 1);
    expect(applyMigration(DB).ok).toBe(true);
    session = signIn(DB, 1);
    daily = JSON.parse(asRole(DB, deviceUser(1),
      `select public.ensure_daily_register_context()::text`)).registerSession.registerSessionId;
  }, 300_000);

  it("the harness really drops to `authenticated`, and does not leak it", () => {
    expect(asAuthenticated(DB, deviceUser(1), `select current_user`)).toBe("authenticated");
    expect(sql(DB, `select current_user`)).toBe("postgres");
  });

  it("it completes an online sale and gets the daily attribution back", () => {
    // Not just has_function_privilege: postgres owns every table and bypasses
    // RLS, so a path quietly needing a privilege no client holds would pass
    // every other test in this file.
    const answer = JSON.parse(asAuthenticated(DB, deviceUser(1), `
      select public.complete_sale_v5('cash', 0, ${ONE_LATTE}, '${SALES.today}',
        null, 'online', '${session}', '${daily}')::text`));

    expect(answer.attribution.registerSessionId).toBe(daily);
    expect(answer.attribution.pairedDeviceId).toBe(device(1));
    expect(filedUnder(DB, SALES.today)).toBe(today(DB));
  });

  it("it rolls over across midnight too", () => {
    const yesterday = dailyRow(DB, 1, -1);

    expect(JSON.parse(asAuthenticated(DB, deviceUser(1), `
      select public.complete_sale_v5('cash', 0, ${ONE_LATTE}, '${SALES.rolled}',
        null, 'online', '${session}', '${yesterday}')::text`)).attribution.registerSessionId)
      .toBe(daily);
  });

  it("47. but it cannot reach the private historical helper", () => {
    expect(asAuthenticatedExpectingFailure(DB, deviceUser(1),
      `select public.daily_register_context_for_sale('${device(1)}', now())`))
      .toMatch(/permission denied for function daily_register_context_for_sale/);
  });

  it("50. and it has no direct authority over register_sessions", () => {
    for (const statement of [
      `select count(*) from public.register_sessions`,
      `update public.register_sessions set opening_cash = 1`,
      `delete from public.register_sessions`,
    ]) {
      expect(asAuthenticatedExpectingFailure(DB, deviceUser(1), statement))
        .toMatch(/permission denied for table register_sessions/);
    }
  });
});
