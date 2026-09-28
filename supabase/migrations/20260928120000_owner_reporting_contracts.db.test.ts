import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20260928120000_owner_reporting_contracts.sql";

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
const PORT = 56300 + (process.pid % 90);

if (PG_BIN === null) {
  console.warn(
    `\n[${MIGRATION}] SKIPPED: no local PostgreSQL server found.` +
      "\n  These are the only tests that EXECUTE the owner contracts;" +
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
    if (STORAGE_ONLY_MIGRATIONS.has(file)) continue;

    runSqlFile(name, join(migrationsDir, file));
    sql(name,
      `insert into supabase_migrations.schema_migrations(version, name)
       values ('${file.split("_")[0]}', '${file}') on conflict do nothing`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures: one shop with two tills and all three roles, plus a second shop
// ---------------------------------------------------------------------------

const OWNER_USER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "a0000000-0000-4000-8000-000000000001";
const BUILD = "b0000000-0000-4000-8000-000000000001";

/** One employee per role, so the role matrix can be exercised for real. */
const CASHIER = "e0000001-0000-4000-8000-00000000000a";
const MANAGER = "e0000002-0000-4000-8000-00000000000b";
const OWNER_EMP = "e0000003-0000-4000-8000-00000000000c";

const OTHER_OWNER_USER = "22222222-2222-4222-8222-222222222222";
const OTHER_PROJECT = "a0000000-0000-4000-8000-000000000002";
const OTHER_BUILD = "b0000000-0000-4000-8000-000000000002";
const OTHER_USER = "d0000000-0000-4000-8000-0000000000ff";
const OTHER_DEVICE = "c0000000-0000-4000-8000-0000000000ff";
const OTHER_EMPLOYEE = "e0000004-0000-4000-8000-00000000000d";

// A third shop with a till but NO register session, so "no DAILY context covers
// now" can be exercised without fighting the accepted daily-immutability guard.
const SAFE_OWNER_USER = "33333333-3333-4333-8333-333333333333";
const SAFE_PROJECT = "a0000000-0000-4000-8000-000000000003";
const SAFE_BUILD = "b0000000-0000-4000-8000-000000000003";
const SAFE_DEVICE_USER = "d0000000-0000-4000-8000-0000000000ee";
const SAFE_DEVICE = "c0000000-0000-4000-8000-0000000000ee";
const SAFE_EMPLOYEE = "e0000005-0000-4000-8000-00000000000e";

const deviceUser = (n: number): string => `d0000000-0000-4000-8000-00000000000${n}`;
const device = (n: number): string => `c0000000-0000-4000-8000-00000000000${n}`;

const MENU = JSON.stringify({ menuItems: [] });
const ZONE = "America/New_York";

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
// Fixtures
// ---------------------------------------------------------------------------

function seed(db: string): void {
  sql(db, `
    insert into auth.users (id) values
      ('${OWNER_USER}'), ('${deviceUser(1)}'), ('${deviceUser(2)}'),
      ('${OTHER_OWNER_USER}'), ('${OTHER_USER}'), ('${SAFE_OWNER_USER}'), ('${SAFE_DEVICE_USER}');

    insert into public.projects (id, user_id, name, template_id, config, business_timezone)
    values ('${PROJECT}', '${OWNER_USER}', 'Shop', 'cafe', '${MENU}'::jsonb, '${ZONE}'),
           ('${OTHER_PROJECT}', '${OTHER_OWNER_USER}', 'Other Shop', 'cafe', '${MENU}'::jsonb, '${ZONE}'),
           ('${SAFE_PROJECT}', '${SAFE_OWNER_USER}', 'Quiet Shop', 'cafe', '${MENU}'::jsonb, '${ZONE}');

    insert into public.build_jobs (id, project_id, owner_id, target, status, config_snapshot,
                                   config_schema_version, config_hash, request_key, started_at, finished_at)
    values ('${BUILD}','${PROJECT}','${OWNER_USER}','android','succeeded','${MENU}'::jsonb,1,'h','r', now(), now()),
           ('${OTHER_BUILD}','${OTHER_PROJECT}','${OTHER_OWNER_USER}','android','succeeded','${MENU}'::jsonb,1,'h2','r2', now(), now()),
           ('${SAFE_BUILD}','${SAFE_PROJECT}','${SAFE_OWNER_USER}','android','succeeded','${MENU}'::jsonb,1,'h3','r3', now(), now());

    insert into public.paired_devices (id, auth_user_id, owner_id, project_id, build_job_id, created_at)
    values ('${device(1)}','${deviceUser(1)}','${OWNER_USER}','${PROJECT}','${BUILD}', now() - interval '30 days'),
           ('${device(2)}','${deviceUser(2)}','${OWNER_USER}','${PROJECT}','${BUILD}', now() - interval '30 days'),
           ('${OTHER_DEVICE}','${OTHER_USER}','${OTHER_OWNER_USER}','${OTHER_PROJECT}','${OTHER_BUILD}', now() - interval '30 days'),
           ('${SAFE_DEVICE}','${SAFE_DEVICE_USER}','${SAFE_OWNER_USER}','${SAFE_PROJECT}','${SAFE_BUILD}', now() - interval '30 days');

    insert into public.employees (id, project_id, display_name, employee_code, role, pin_hash, active, created_at)
    values ('${CASHIER}','${PROJECT}','Amy','001','cashier', public.employee_pin_hash('2222'), true, '2026-01-01'),
           ('${MANAGER}','${PROJECT}','Bo','002','manager', public.employee_pin_hash('3333'), true, '2026-01-01'),
           ('${OWNER_EMP}','${PROJECT}','Cleo','003','owner', public.employee_pin_hash('4444'), true, '2026-01-01'),
           ('${OTHER_EMPLOYEE}','${OTHER_PROJECT}','Zed','001','owner', public.employee_pin_hash('5555'), true, '2026-01-01'),
           ('${SAFE_EMPLOYEE}','${SAFE_PROJECT}','Quinn','001','owner', public.employee_pin_hash('6666'), true, '2026-01-01');
  `);
}

/** Opens the DAILY context for a till through the ACCEPTED path, and returns its id. */
function ensureDaily(db: string, n: number): string {
  return JSON.parse(
    asRole(db, deviceUser(n), `select public.ensure_daily_register_context()::text`)
  ).registerSession.registerSessionId as string;
}

const DB = "ownerrpt";
let DAILY = "";
let OTHER_DAILY = "";

beforeAll(() => {
  if (PG_BIN === null) return;

  dataDir = mkdtempSync(join(tmpdir(), "pos-canvas-1f-"));
  pg("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust"]);
  pg("pg_ctl", [
    "-D", dataDir, "-l", join(dataDir, "server.log"), "-w", "start",
    "-o", `-c listen_addresses=127.0.0.1 -c port=${PORT} -c unix_socket_directories=''`,
  ]);
  freshDatabase(DB, true);
  seed(DB);
  DAILY = ensureDaily(DB, 1);
  OTHER_DAILY = JSON.parse(
    asRole(DB, OTHER_USER, `select public.ensure_daily_register_context()::text`)
  ).registerSession.registerSessionId as string;

  // Operational rows to report on. Inserted directly: this suite tests the READ
  // contracts, and the write paths have their own accepted suites.
  sql(DB, `
    insert into public.employee_time_sessions
      (id, project_id, employee_id, clocked_in_at, clocked_out_at,
       clock_in_paired_device_id, clock_out_paired_device_id,
       clock_in_request_id, clock_out_request_id)
    values
      ('11110000-0000-4000-8000-000000000001','${PROJECT}','${CASHIER}',
       '2026-09-20T13:00:00Z','2026-09-20T21:00:00Z','${device(1)}','${device(1)}',
       gen_random_uuid(), gen_random_uuid()),
      -- An OPEN shift: no clock-out, no closing device, no closing request id.
      ('11110000-0000-4000-8000-000000000002','${PROJECT}','${MANAGER}',
       '2026-09-21T13:00:00Z', null, '${device(1)}', null,
       gen_random_uuid(), null),
      ('11110000-0000-4000-8000-000000000003','${OTHER_PROJECT}','${OTHER_EMPLOYEE}',
       '2026-09-20T13:00:00Z', null, '${OTHER_DEVICE}', null,
       gen_random_uuid(), null);

    insert into public.cash_movements
      (id, project_id, paired_device_id, register_session_id, employee_id,
       movement_type, amount, note, occurred_at, request_id)
    values
      ('22220000-0000-4000-8000-000000000001','${PROJECT}','${device(1)}','${DAILY}','${CASHIER}',
       'cash_drop', 100.00, 'to safe', now(), gen_random_uuid()),
      ('22220000-0000-4000-8000-000000000002','${PROJECT}','${device(1)}','${DAILY}','${MANAGER}',
       'paid_out', 12.50, 'milk', now(), gen_random_uuid()),
      ('22220000-0000-4000-8000-000000000003','${OTHER_PROJECT}','${OTHER_DEVICE}','${OTHER_DAILY}','${OTHER_EMPLOYEE}',
       'paid_in', 5.00, 'float top-up', now(), gen_random_uuid());

    -- One REGISTERED sale and one LEGACY sale with no register at all.
    insert into public.orders
      (id, user_id, project_id, order_number, payment_method, subtotal, tax_amount,
       tip_amount, total, created_at, employee_id, paired_device_id, register_session_id)
    values
      ('33330000-0000-4000-8000-000000000001','${OWNER_USER}','${PROJECT}','ORD-1','cash',
       10.00, 0.63, 0, 10.63, now(), '${CASHIER}', '${device(1)}', '${DAILY}'),
      ('33330000-0000-4000-8000-000000000002','${OWNER_USER}','${PROJECT}','ORD-2','card',
       20.00, 1.27, 0, 21.27, '2026-01-05T18:00:00Z', null, null, null);
  `);
}, 900_000);

afterAll(() => {
  if (PG_BIN === null) return;
  try { pg("pg_ctl", ["-D", dataDir, "-m", "immediate", "-w", "stop"]); }
  finally { rmSync(dataDir, { recursive: true, force: true }); }
}, 900_000);

const maybe = PG_BIN === null ? describe.skip : describe;

/** Calls an owner RPC as the real `authenticated` role and parses the jsonb. */
function callAs(who: string, statement: string): Record<string, unknown> {
  return JSON.parse(asAuthenticated(DB, who, `select (${statement})::text`));
}

// ---------------------------------------------------------------------------
// Owner Time Clock reporting
// ---------------------------------------------------------------------------

maybe("owner Time Clock reporting", () => {
  const call = (who: string, project: string) =>
    callAs(who, `public.list_employee_time_sessions('${project}', null, null)`);

  it("the project owner reads their own time records", () => {
    const result = call(OWNER_USER, PROJECT);
    expect(result.ok).toBe(true);

    const rows = result.timeSessions as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.displayName).sort()).toEqual(["Amy", "Bo"]);
  });

  it("a non-owner is refused, and learns nothing", () => {
    expect(call(OTHER_OWNER_USER, PROJECT)).toEqual({ ok: false, error: "not_found" });
  });

  it("a wrong-project read returns only that project's rows", () => {
    const rows = call(OTHER_OWNER_USER, OTHER_PROJECT).timeSessions as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].displayName).toBe("Zed");
  });

  it("a PAIRED DEVICE is refused even though it is authenticated", () => {
    expect(call(deviceUser(1), PROJECT)).toEqual({ ok: false, error: "not_found" });
  });

  it("an unauthenticated caller is refused", () => {
    const out = JSON.parse(sql(DB, `
      select (public.list_employee_time_sessions('${PROJECT}', null, null))::text`));
    expect(out).toEqual({ ok: false, error: "not_authenticated" });
  });

  it("an OPEN shift stays open: null clock-out, no invented duration", () => {
    const rows = call(OWNER_USER, PROJECT).timeSessions as Record<string, unknown>[];
    const open = rows.find((r) => r.displayName === "Bo") as Record<string, unknown>;

    expect(open.clockedOutAt).toBeNull();
    expect(open.isOpen).toBe(true);
    expect(open.clockOutPairedDeviceId).toBeNull();
    // No duration field exists at all -- it is two instants, subtracted by the
    // caller, never a number this contract invents.
    expect(Object.keys(open)).not.toContain("durationMs");
    expect(Object.keys(open)).not.toContain("workedMinutes");
  });

  it("exposes no request ids or credential material", () => {
    const rows = call(OWNER_USER, PROJECT).timeSessions as Record<string, unknown>[];

    for (const key of Object.keys(rows[0])) {
      expect(key.toLowerCase()).not.toContain("request");
      expect(key.toLowerCase()).not.toContain("pin");
      expect(key.toLowerCase()).not.toContain("code");
    }
  });

  it("POS employee-session data is NOT substituted for worked time", () => {
    // A POS session exists for the same employee with a different span. If the
    // contract ever read employee_pos_sessions, these instants would move.
    sql(DB, `
      insert into public.employee_pos_sessions (employee_id, paired_device_id, started_at)
      values ('${CASHIER}', '${device(1)}', '2026-09-20T09:00:00Z')
      on conflict do nothing;`);

    const rows = call(OWNER_USER, PROJECT).timeSessions as Record<string, unknown>[];
    const amy = rows.find((r) => r.displayName === "Amy") as Record<string, unknown>;

    expect(String(amy.clockedInAt)).toContain("13:00:00");
    expect(String(amy.clockedInAt)).not.toContain("09:00:00");
  });
});

// ---------------------------------------------------------------------------
// Owner Cash Activity reporting
// ---------------------------------------------------------------------------

maybe("owner Cash Activity reporting", () => {
  const call = (who: string, project: string) =>
    callAs(who, `public.list_cash_movements('${project}', null, null)`);

  it("the project owner reads their own activity", () => {
    const rows = call(OWNER_USER, PROJECT).cashMovements as Record<string, unknown>[];

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.movementType).sort()).toEqual(["cash_drop", "paid_out"]);
  });

  it("only the three accepted movement types can appear", () => {
    const rows = call(OWNER_USER, PROJECT).cashMovements as Record<string, unknown>[];

    for (const row of rows) {
      expect(["cash_drop", "paid_in", "paid_out"]).toContain(row.movementType);
    }
  });

  it("exposes the STORED register business date, not a recomputed one", () => {
    const rows = call(OWNER_USER, PROJECT).cashMovements as Record<string, unknown>[];
    const stored = sql(DB, `select business_date::text from public.register_sessions where id = '${DAILY}'`);

    expect(stored).not.toBe("");
    for (const row of rows) expect(row.businessDate).toBe(stored);
  });

  it("exposes NO drawer position: no opening cash, expected, actual or variance", () => {
    const rows = call(OWNER_USER, PROJECT).cashMovements as Record<string, unknown>[];

    for (const key of Object.keys(rows[0])) {
      for (const banned of ["opening", "expected", "actual", "counted", "variance", "over", "short", "balance"]) {
        expect(key.toLowerCase()).not.toContain(banned);
      }
    }
  });

  it("a wrong-project owner sees only their own movements", () => {
    const rows = call(OTHER_OWNER_USER, OTHER_PROJECT).cashMovements as Record<string, unknown>[];

    expect(rows).toHaveLength(1);
    expect(rows[0].movementType).toBe("paid_in");
  });

  it("a non-owner is refused", () => {
    expect(call(OTHER_OWNER_USER, PROJECT)).toEqual({ ok: false, error: "not_found" });
  });

  it("a PAIRED DEVICE is refused", () => {
    expect(call(deviceUser(1), PROJECT)).toEqual({ ok: false, error: "not_found" });
  });
});

// ---------------------------------------------------------------------------
// Registered-order business date
// ---------------------------------------------------------------------------

maybe("registered-order business date", () => {
  const call = (who: string, project: string) =>
    callAs(who, `public.list_order_business_dates('${project}', null, null)`);

  it("a registered order reports the STORED register business date", () => {
    const rows = call(OWNER_USER, PROJECT).orderBusinessDates as Record<string, unknown>[];
    const stored = sql(DB, `select business_date::text from public.register_sessions where id = '${DAILY}'`);

    expect(rows).toHaveLength(1);
    expect(rows[0].orderId).toBe("33330000-0000-4000-8000-000000000001");
    expect(rows[0].businessDate).toBe(stored);
  });

  it("an UNREGISTERED order is absent -- no fabricated register date", () => {
    const rows = call(OWNER_USER, PROJECT).orderBusinessDates as Record<string, unknown>[];

    expect(rows.map((r) => r.orderId)).not.toContain("33330000-0000-4000-8000-000000000002");
  });

  it("does not recompute from created_at", () => {
    // The legacy order's created_at is in January; if anything derived a date
    // from created_at, a 2026-01 row would appear. It does not.
    const rows = call(OWNER_USER, PROJECT).orderBusinessDates as Record<string, unknown>[];

    for (const row of rows) expect(String(row.businessDate)).not.toContain("2026-01");
  });

  it("returns nothing beyond the order id and the date", () => {
    const rows = call(OWNER_USER, PROJECT).orderBusinessDates as Record<string, unknown>[];

    expect(Object.keys(rows[0]).sort()).toEqual(["businessDate", "orderId"]);
  });

  it("a non-owner is refused, and a paired device is refused", () => {
    expect(call(OTHER_OWNER_USER, PROJECT)).toEqual({ ok: false, error: "not_found" });
    expect(call(deviceUser(1), PROJECT)).toEqual({ ok: false, error: "not_found" });
  });
});

// ---------------------------------------------------------------------------
// Employee role mutation, and the downgrade
// ---------------------------------------------------------------------------

maybe("employee role mutation", () => {
  const setRole = (who: string, employee: string, role: string) =>
    callAs(who, `public.set_employee_role('${employee}', '${role}')`);

  it("the project owner changes a role", () => {
    const result = setRole(OWNER_USER, CASHIER, "manager");

    expect(result.ok).toBe(true);
    expect(result.role).toBe("manager");
    expect(sql(DB, `select role from public.employees where id = '${CASHIER}'`)).toBe("manager");

    setRole(OWNER_USER, CASHIER, "cashier");
  });

  it("an invalid role is refused by name", () => {
    expect(setRole(OWNER_USER, CASHIER, "supervisor")).toEqual({ ok: false, error: "invalid_role" });
  });

  it("a wrong-project owner cannot mutate", () => {
    expect(setRole(OTHER_OWNER_USER, CASHIER, "manager")).toEqual({ ok: false, error: "not_found" });
    expect(sql(DB, `select role from public.employees where id = '${CASHIER}'`)).toBe("cashier");
  });

  it("a PAIRED DEVICE cannot mutate, even its own project's employee", () => {
    expect(setRole(deviceUser(1), CASHIER, "manager")).toEqual({ ok: false, error: "not_found" });
    expect(sql(DB, `select role from public.employees where id = '${CASHIER}'`)).toBe("cashier");
  });

  it("an unauthenticated caller cannot mutate", () => {
    const out = JSON.parse(sql(DB, `select (public.set_employee_role('${CASHIER}','manager'))::text`));
    expect(out).toEqual({ ok: false, error: "not_authenticated" });
  });

  it("HISTORICAL attribution is untouched by a role change", () => {
    const before = sql(DB, `
      select md5(string_agg(x, '|' order by x)) from (
        select o.id::text || coalesce(o.employee_id::text,'-') as x from public.orders o
        union all
        select t.id::text || t.employee_id::text from public.employee_time_sessions t
        union all
        select m.id::text || m.employee_id::text from public.cash_movements m
      ) s`);

    setRole(OWNER_USER, MANAGER, "cashier");

    const after = sql(DB, `
      select md5(string_agg(x, '|' order by x)) from (
        select o.id::text || coalesce(o.employee_id::text,'-') as x from public.orders o
        union all
        select t.id::text || t.employee_id::text from public.employee_time_sessions t
        union all
        select m.id::text || m.employee_id::text from public.cash_movements m
      ) s`);

    expect(after).toBe(before);
    setRole(OWNER_USER, MANAGER, "manager");
  });

  it("employee_pos_sessions carries NO role snapshot to go stale", () => {
    const cols = sql(DB, `
      select coalesce(string_agg(column_name, ',' order by column_name), '')
      from information_schema.columns
      where table_schema='public' and table_name='employee_pos_sessions'`);

    expect(cols).not.toContain("role");
  });

  it("changes the role of an employee who has NO POS session", () => {
    // OWNER_EMP has never signed in on a till. If the mutation resolved the
    // employee through a session table it would silently do nothing here.
    sql(DB, `delete from public.employee_pos_sessions`);

    expect(setRole(OWNER_USER, OWNER_EMP, "manager").ok).toBe(true);
    expect(sql(DB, `select role from public.employees where id = '${OWNER_EMP}'`)).toBe("manager");

    setRole(OWNER_USER, OWNER_EMP, "owner");
  });

  it("THE DOWNGRADE: the live session resolution reports the NEW role", () => {
    // A real manager session, opened through the accepted login path.
    sql(DB, `delete from public.employee_pos_sessions`);
    const login = JSON.parse(asRole(DB, deviceUser(1),
      `select (public.employee_login_by_code('002','3333'))::text`));
    expect(login.ok).toBe(true);
    expect(login.role).toBe("manager");

    // The owner downgrades while that session is still open.
    expect(setRole(OWNER_USER, MANAGER, "cashier").ok).toBe(true);

    // The session is still open -- nothing was revoked, versioned or rung out.
    expect(sql(DB, `select count(*) from public.employee_pos_sessions where ended_at is null`)).toBe("1");

    // And the authoritative resolution now reports cashier, because it joins
    // employees live rather than reading a snapshot.
    const now = JSON.parse(asRole(DB, deviceUser(1),
      `select (public.get_current_employee_session())::text`));
    expect(now.ok).toBe(true);
    expect(now.session.role).toBe("cashier");

    setRole(OWNER_USER, MANAGER, "manager");
  });
});

// ---------------------------------------------------------------------------
// Business timezone change guard
// ---------------------------------------------------------------------------

maybe("business timezone change guard", () => {
  const setZone = (project: string, zone: string | null) =>
    sql(DB, `update public.projects set business_timezone = ${zone === null ? "null" : `'${zone}'`} where id = '${project}'`);

  const trySetZone = (project: string, zone: string | null): string => {
    try { setZone(project, zone); return ""; }
    catch (error) {
      const err = error as { stderr?: string; message?: string };
      return (err.stderr ?? err.message ?? "").toString();
    }
  };

  it("setting the SAME timezone is a no-op and is never blocked", () => {
    // PROJECT has an open DAILY context, so this proves the short-circuit runs
    // before the refusal.
    expect(trySetZone(PROJECT, ZONE)).toBe("");
  });

  it("an ACTUAL change is REFUSED while a DAILY context covers now", () => {
    const err = trySetZone(PROJECT, "America/Los_Angeles");

    expect(err).toContain("business_timezone_change_blocked_open_register");
    expect(sql(DB, `select business_timezone from public.projects where id = '${PROJECT}'`)).toBe(ZONE);
  });

  it("CLEARING the timezone is refused too -- it removes the answer entirely", () => {
    expect(trySetZone(PROJECT, null)).toContain("business_timezone_change_blocked_open_register");
  });

  it("an invalid timezone is still refused as invalid, not as blocked", () => {
    expect(trySetZone(PROJECT, "Nowhere/Fake")).toContain("Invalid business timezone");
  });

  it("the guard and the SALE path agree: covering context <=> conflict", () => {
    // The accepted sale-path invariant, asked directly.
    const covering = sql(DB, `select public.project_has_covering_daily_register('${PROJECT}', now())::text`);
    expect(covering).toBe("true");

    // And with that context present, the accepted sale path does refuse a
    // changed zone. Proven by pointing ensure_daily_register_context at a
    // project whose stored context was written under a different zone.
    const conflict = JSON.parse(asRole(DB, deviceUser(1), `
      select (public.ensure_daily_register_context())::text`));
    // Same zone as stored => no conflict today.
    expect(conflict.ok).toBe(true);
  });

  it("a SAFE change is ALLOWED when no context covers now", () => {
    // A shop whose till has never opened a register. No accepted row is touched
    // to create this state, and the daily-immutability guard is never fought.
    expect(sql(DB, `select public.project_has_covering_daily_register('${SAFE_PROJECT}', now())::text`)).toBe("false");

    expect(trySetZone(SAFE_PROJECT, "America/Los_Angeles")).toBe("");
    expect(sql(DB, `select business_timezone from public.projects where id = '${SAFE_PROJECT}'`))
      .toBe("America/Los_Angeles");
  });

  it("the HISTORICAL register keeps its own business_date and business_timezone", () => {
    const row = sql(DB, `
      select business_date::text || '|' || business_timezone
      from public.register_sessions where id = '${DAILY}'`);

    expect(row).toContain("|" + ZONE);
    expect(row).not.toContain("America/Los_Angeles");
  });

  it("a NEW register context uses the NEW project timezone", () => {
    const created = JSON.parse(asRole(DB, SAFE_DEVICE_USER, `
      select (public.ensure_daily_register_context())::text`));

    expect(created.ok).toBe(true);
    expect(created.registerSession.businessTimezone).toBe("America/Los_Angeles");
  });

  it("and that new context now blocks a further change on ITS project", () => {
    // The guard is not a one-off: the shop that has just opened a day is now
    // protected exactly as the first one was.
    expect(sql(DB, `select public.project_has_covering_daily_register('${SAFE_PROJECT}', now())::text`)).toBe("true");
    expect(trySetZone(SAFE_PROJECT, "America/Chicago"))
      .toContain("business_timezone_change_blocked_open_register");
  });
});
