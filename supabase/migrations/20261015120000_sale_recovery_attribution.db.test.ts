// G-1-SERVER-1 — migration 20261015120000, EXECUTED against a real PostgreSQL.
//
// Proven here by running it, not by reading it:
//   * the lookup is read-only, scoped to the calling device AND project, and a
//     payload that does not match discloses no order details;
//   * strict recovery creates an order ONLY under the original, verified
//     employee and register, and a refusal writes nothing at all;
//   * an existing order is replayed when its attribution matches and reported
//     as a conflict — unchanged, without a receipt — when it does not;
//   * concurrent strict recoveries, and complete_sale_v5 racing strict recovery
//     in both commit orders, leave exactly one order with the expected
//     attribution and exactly one set of inventory side effects;
//   * complete_sale_v5 is byte-for-byte unchanged, and the new functions carry
//     the intended security settings and grants (non-vacuously).
//
// The harness (PostgreSQL discovery, the Supabase compatibility layer, the
// cluster lifecycle including `pg_ctl -l`, and the migration chain with its
// "with migration" upper bound) is reproduced from the accepted
// 20261012120000 suite; only the migration name, the port range and the
// interactive-session helper for concurrency are new. When no PostgreSQL server
// is found the suite SKIPS LOUDLY rather than failing.
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20261015120000_sale_recovery_attribution.sql";

// ---------------------------------------------------------------------------
// Finding PostgreSQL (unchanged from the accepted harness)
// ---------------------------------------------------------------------------

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

// A port range no other db suite uses.
const PORT = 57100 + (process.pid % 90);

if (PG_BIN === null) {
  console.warn(
    `\n[${MIGRATION}] SKIPPED: no local PostgreSQL server found.` +
      "\n  These are the only tests that EXECUTE sale recovery; install PostgreSQL 16+.\n"
  );
}

// ---------------------------------------------------------------------------
// The compatibility layer (unchanged from the accepted harness)
// ---------------------------------------------------------------------------

const COMPAT = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

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
// Cluster lifecycle and migrations (unchanged from the accepted harness)
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

function sql(db: string, statement: string): string {
  return pg("psql", [...psqlArgs(db), "-Atq", "-c", statement]).trim();
}

export const STORAGE_ONLY_MIGRATIONS = new Set([
  "20260729190422_build_artifact_storage.sql",
  "20260813120000_project_logo_storage.sql",
]);

function runSqlFile(db: string, file: string): void {
  pg("psql", [...psqlArgs(db), "-q", "-f", file]);
}

function freshDatabase(name: string, withMigration: boolean): void {
  sql("postgres", `drop database if exists ${name}`);
  sql("postgres", `create database ${name}`);
  pg("psql", ["-h", "127.0.0.1", "-p", String(PORT), "-U", "postgres", "-d", name, "-q", "-f", "-"], COMPAT);

  const files = execFileSync("ls", [migrationsDir], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (!withMigration && file >= MIGRATION) continue;
    if (withMigration && file > MIGRATION) continue;
    if (STORAGE_ONLY_MIGRATIONS.has(file)) continue;

    runSqlFile(name, join(migrationsDir, file));
    sql(name,
      `insert into supabase_migrations.schema_migrations(version, name)
       values ('${file.split("_")[0]}', '${file}') on conflict do nothing`);
  }
}

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
// Interactive sessions for deterministic concurrency
// ---------------------------------------------------------------------------

/**
 * One long-lived psql connection. Statements are sent one at a time and the
 * session is NOT required to finish them: a statement blocked on a lock simply
 * leaves its promise pending until the lock is released. Whether it is blocked
 * is observed from a separate connection through pg_stat_activity, never
 * inferred from elapsed time.
 */
class Session {
  private proc: ChildProcessWithoutNullStreams;
  private out = "";
  private err = "";
  private seq = 0;

  constructor(db: string, readonly app: string) {
    this.proc = spawn(join(PG_BIN as string, "psql"), [...psqlArgs(db), "-At", "-v", "ON_ERROR_STOP=0"], {
      env: { ...process.env, PGAPPNAME: app, PGTZ: "UTC", LC_ALL: "en_US.UTF-8" },
    });
    this.proc.stdout.on("data", (chunk) => (this.out += chunk.toString()));
    this.proc.stderr.on("data", (chunk) => (this.err += chunk.toString()));
  }

  /** Sends a statement; resolves with its stdout and stderr once it completes. */
  run(statement: string, timeoutMs = 30_000): Promise<{ out: string; err: string }> {
    const marker = `__w02_done_${++this.seq}__`;
    const outStart = this.out.length;
    const errStart = this.err.length;

    // TERMINATED: without the semicolon psql only buffers the statement, and
    // the \\echo marker would come back before the statement ever ran.
    const terminated = statement.trim().endsWith(";") ? statement.trim() : `${statement.trim()};`;

    this.proc.stdin.write(`${terminated}\n\\echo ${marker}\n`);

    return new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        const idx = this.out.indexOf(marker, outStart);

        if (idx >= 0) {
          clearInterval(poll);
          resolve({ out: this.out.slice(outStart, idx).trim(), err: this.err.slice(errStart).trim() });
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(poll);
          reject(new Error(`[${this.app}] statement did not complete within ${timeoutMs} ms: ${statement.slice(0, 120)}`));
        }
      }, 20);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.proc.on("exit", () => resolve());
      this.proc.stdin.write("\\q\n");
      this.proc.stdin.end();
      setTimeout(() => {
        this.proc.kill("SIGKILL");
        resolve();
      }, 5_000);
    });
  }
}

/** Waits (bounded) until `app` is blocked on a lock, as the server reports it. */
async function waitUntilBlocked(db: string, app: string, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const n = sql(db, `select count(*) from pg_stat_activity
                       where application_name = '${app}' and wait_event_type = 'Lock'`);

    if (n === "1") return;
    await new Promise((r) => setTimeout(r, 25));
  }

  throw new Error(`${app} never blocked on a lock within ${timeoutMs} ms`);
}

/** The last non-empty output line, which is the statement's own result. */
const lastLine = (text: string): string => text.split("\n").filter((l) => l !== "").at(-1) ?? "";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER = "11111111-1111-4111-8111-111111111111";
const OWNER_2 = "22222222-2222-4222-8222-222222222222";
const PROJECT = "a0000000-0000-4000-8000-000000000001";
const PROJECT_2 = "a0000000-0000-4000-8000-000000000002";
const BUILD = "b0000000-0000-4000-8000-000000000001";
const BUILD_2 = "b0000000-0000-4000-8000-000000000002";
const AMY = "e0000001-0000-4000-8000-00000000000a";
const BEN = "e0000002-0000-4000-8000-00000000000b";
const CARA = "e0000003-0000-4000-8000-00000000000c";

/** Tills 1, 2 and 4 belong to PROJECT; till 3 to PROJECT_2; till 4 is unpaired. */
const deviceUser = (n: number): string => `d0000000-0000-4000-8000-00000000000${n}`;
const device = (n: number): string => `c0000000-0000-4000-8000-00000000000${n}`;

const ZONE = "America/New_York";

/** Inventory-tracked items with one single- and one multiple-choice group. */
const MENU = JSON.stringify({
  menuItems: [
    {
      id: "latte", name: "Latte", price: "4.00", available: true,
      trackInventory: true, stockQuantity: 50,
      modifierGroups: [
        { id: "milk", name: "Milk", selection: "single", required: false,
          options: [{ id: "oat", name: "Oat", priceAdjustment: "0.50" }, { id: "whole", name: "Whole", priceAdjustment: "0.00" }] },
        { id: "extras", name: "Extras", selection: "multiple", maxSelections: 3, required: false,
          options: [{ id: "shot", name: "Shot", priceAdjustment: "1.00" }, { id: "syrup", name: "Syrup", priceAdjustment: "0.75" }] },
      ],
    },
    { id: "muffin", name: "Muffin", price: "3.00", available: true, trackInventory: true, stockQuantity: 50 },
  ],
  tax: { enabled: false, rate: 0 },
  receipt: {},
});

const LATTE = `'[{"itemId":"latte","quantity":1}]'::jsonb`;
const LATTE_X2 = `'[{"itemId":"latte","quantity":2}]'::jsonb`;

function asRole(db: string, who: string, statement: string): string {
  const out = sql(db, `select set_config('request.jwt.claim.sub','${who}', false); ${statement}`);

  return lastLine(out);
}

function failureOf(run: () => unknown): string {
  try {
    run();
    return "";
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    return (/ERROR:\s*(.*)/.exec((err.stderr ?? err.message ?? "").toString())?.[1] ?? "").trim();
  }
}

function seed(db: string): void {
  sql(db, `
    insert into auth.users (id) values ('${OWNER}'), ('${OWNER_2}'),
      ('${deviceUser(1)}'), ('${deviceUser(2)}'), ('${deviceUser(3)}'), ('${deviceUser(4)}');
    insert into public.projects (id, user_id, name, template_id, config, business_timezone) values
      ('${PROJECT}', '${OWNER}', 'Shop', 'cafe', '${MENU}'::jsonb, '${ZONE}'),
      ('${PROJECT_2}', '${OWNER_2}', 'Other', 'cafe', '${MENU}'::jsonb, '${ZONE}');
    insert into public.build_jobs (id, project_id, owner_id, target, status, config_snapshot,
                                   config_schema_version, config_hash, request_key, started_at, finished_at) values
      ('${BUILD}','${PROJECT}','${OWNER}','android','succeeded','${MENU}'::jsonb,1,'h','r1', now(), now()),
      ('${BUILD_2}','${PROJECT_2}','${OWNER_2}','android','succeeded','${MENU}'::jsonb,1,'h','r2', now(), now());
    insert into public.paired_devices (id, auth_user_id, owner_id, project_id, build_job_id, created_at) values
      ('${device(1)}','${deviceUser(1)}','${OWNER}','${PROJECT}','${BUILD}', now() - interval '30 days'),
      ('${device(2)}','${deviceUser(2)}','${OWNER}','${PROJECT}','${BUILD}', now() - interval '30 days'),
      ('${device(3)}','${deviceUser(3)}','${OWNER_2}','${PROJECT_2}','${BUILD_2}', now() - interval '30 days'),
      ('${device(4)}','${deviceUser(4)}','${OWNER}','${PROJECT}','${BUILD}', now() - interval '30 days');
    insert into public.employees (id, project_id, display_name, employee_code, role, pin_hash, active, created_at) values
      ('${AMY}','${PROJECT}','Amy','001','cashier', public.employee_pin_hash('2222'), true, '2026-01-01'),
      ('${BEN}','${PROJECT}','Ben','002','cashier', public.employee_pin_hash('3333'), true, '2026-01-01'),
      ('${CARA}','${PROJECT_2}','Cara','001','cashier', public.employee_pin_hash('4444'), true, '2026-01-01');
  `);
}

/** Signs `code` in on till `n`; returns the new POS session id. */
function signIn(db: string, n: number, code: string, pin: string): string {
  expect(asRole(db, deviceUser(n), `select public.employee_login_by_code('${code}','${pin}')->>'ok'`)).toBe("true");

  return sql(db, `select id::text from public.employee_pos_sessions
                  where paired_device_id='${device(n)}' and ended_at is null`);
}

/** Today's daily register for till `n` (the product's own RPC). */
function dailyRegister(db: string, n: number): string {
  return JSON.parse(asRole(db, deviceUser(n), `select public.ensure_daily_register_context()::text`))
    .registerSession.registerSessionId;
}

/** Yesterday's daily register for till `n`, built exactly as the accepted suite does. */
function yesterdayRegister(db: string, n: number): string {
  const date = `((now() at time zone '${ZONE}')::date - 1)`;

  return sql(db, `
    insert into public.register_sessions (paired_device_id, opened_at, opening_cash,
                                          closed_at, business_date, business_timezone)
    select '${device(n)}', b.starts_at, 0, b.ends_at, ${date}, '${ZONE}'
    from public.business_day_bounds(${date}, '${ZONE}') b
    returning id::text`);
}

/** A SQL expression for the midpoint of a (closed) POS session. */
const midpointOf = (session: string): string =>
  `(select started_at + (ended_at - started_at) / 2 from public.employee_pos_sessions where id='${session}')`;

type RecoverArgs = {
  request: string;
  source: "online" | "offline_queued";
  original: string | null;
  register: string | null;
  at?: string | null;
  current?: string | null;
  items?: string;
  payment?: string;
};

const recoverSql = (a: RecoverArgs): string => `select public.complete_sale_recovery_v1(
  '${a.payment ?? "cash"}', 0, ${a.items ?? LATTE}, '${a.request}', '${a.source}',
  ${a.original === null ? "null" : `'${a.original}'`},
  ${a.register === null ? "null" : `'${a.register}'`},
  ${a.at ?? "null"},
  ${a.current === undefined || a.current === null ? "null" : `'${a.current}'`}
)::text`;

function recover(db: string, n: number, a: RecoverArgs): Record<string, unknown> {
  return JSON.parse(asRole(db, deviceUser(n), recoverSql(a)));
}

type LookupArgs = { request: string; items?: string; payment?: string; original?: string; register?: string };

const lookupSql = (a: LookupArgs): string => `select public.get_device_sale_by_request_id(
  '${a.request}', '${a.payment ?? "cash"}', ${a.items ?? LATTE}, 0,
  ${a.original ? `'${a.original}'` : "null"}, ${a.register ? `'${a.register}'` : "null"}
)::text`;

function lookup(db: string, n: number, a: LookupArgs): Record<string, unknown> {
  return JSON.parse(asRole(db, deviceUser(n), lookupSql(a)));
}

/** complete_sale_v5 directly, as an installed (legacy-path) client would call it. */
const v5Sql = (request: string, source: "online" | "offline_queued", session: string | null, register: string | null, at: string | null = null, items = LATTE): string =>
  `select public.complete_sale_v5('cash', 0, ${items}, '${request}', ${at ?? "null"}, '${source}',
     ${session === null ? "null" : `'${session}'`}, ${register === null ? "null" : `'${register}'`})::text`;

/** Every financial side effect, as one comparable string. */
function footprint(db: string): string {
  return sql(db, `select
    (select count(*) from public.orders)::text || ' orders / ' ||
    (select count(*) from public.order_items)::text || ' items / ' ||
    (select count(*) from public.inventory_transactions)::text || ' inventory / counter ' ||
    coalesce((select last_number::text from public.project_order_counters where project_id='${PROJECT}'), 'unallocated') ||
    ' / latte stock ' || (select (config -> 'menuItems' -> 0 ->> 'stockQuantity') from public.projects where id='${PROJECT}')`);
}

function orderOf(db: string, request: string): Record<string, string> {
  const row = sql(db, `select json_build_object('id', id, 'employee', coalesce(employee_id::text,'NULL'),
                         'register', coalesce(register_session_id::text,'NULL'),
                         'device', coalesce(paired_device_id::text,'NULL'), 'source', source,
                         'items', (select count(*) from public.order_items i where i.order_id = o.id),
                         'inventory', (select count(*) from public.inventory_transactions t where t.order_id = o.id))
                       from public.orders o where sale_request_id='${request}'`);

  return row === "" ? {} : JSON.parse(row);
}

/**
 * READ-ONLY evidence: every order of PROJECT with its attribution and side-effect
 * counts, written beside the logs before the disposable cluster is destroyed.
 */
function dumpEvidence(db: string, name: string): void {
  const rows = sql(db, `select coalesce(json_agg(json_build_object(
      'saleRequestId', o.sale_request_id, 'orderNumber', o.order_number, 'source', o.source,
      'employeeId', o.employee_id,
      'employee', (select display_name from public.employees e where e.id = o.employee_id),
      'registerSessionId', o.register_session_id, 'pairedDeviceId', o.paired_device_id,
      'items', (select count(*) from public.order_items i where i.order_id = o.id),
      'inventoryTransactions', (select count(*) from public.inventory_transactions t where t.order_id = o.id)
    ) order by o.sale_request_id), '[]'::json) from public.orders o where o.project_id='${PROJECT}'`);
  const dir = join(migrationsDir, "..", "..", ".g1-server-1a", "evidence");

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({ database: db, footprint: footprint(db), orders: JSON.parse(rows) }, null, 2));
}

const R = (n: string): string => `f2000000-0000-4000-8000-0000000000${n}`;

const run = PG_BIN === null ? describe.skip : describe;

beforeAll(() => {
  if (PG_BIN === null) return;

  dataDir = mkdtempSync(join(tmpdir(), "g1server-pg-"));
  pg("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
  // `-l` is load-bearing (see the accepted harness): without it the postmaster
  // holds this worker's stdout open and vitest never sees the run end.
  pg("pg_ctl", [
    "-D", dataDir, "-l", join(dataDir, "server.log"), "-w", "start",
    "-o", `-c listen_addresses=127.0.0.1 -c port=${PORT} -c unix_socket_directories=''`,
  ]);

  // LOCAL AND DISPOSABLE, verified rather than assumed.
  expect(sql("postgres", "show listen_addresses")).toBe("127.0.0.1");
  // macOS reports /private/var for /var; the disposable mkdtemp prefix is the check.
  expect(sql("postgres", "show data_directory")).toContain("g1server-pg-");
}, 300_000);

afterAll(() => {
  if (PG_BIN === null || dataDir === "") return;

  try {
    pg("pg_ctl", ["-D", dataDir, "-m", "immediate", "-w", "stop"]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 1. THE CONTRACT
// ===========================================================================

run("G1S contract: applies, leaves complete_sale_v5 untouched, intended security and grants", () => {
  const DB = "g1s_contract";
  const FRESH = "g1s_contract_fresh";
  let v5Before = "";

  beforeAll(() => {
    freshDatabase(DB, false);
    v5Before = sql(DB, `select md5(pg_get_functiondef('public.complete_sale_v5(text,numeric,jsonb,uuid,timestamptz,text,uuid,uuid)'::regprocedure))`);
  }, 600_000);

  it("1. BASELINE: before the migration none of the three functions exists", () => {
    expect(sql(DB, `select count(*) from pg_proc where proname in
      ('get_device_sale_by_request_id','complete_sale_recovery_v1','sale_recovery_device_hash')`)).toBe("0");
  });

  it("2. applies as ONE transaction over every accepted predecessor", () => {
    const result = applyMigration(DB);

    expect(result.error).toBe("");
    expect(result.ok).toBe(true);
  });

  it("3. complete_sale_v5 is byte-for-byte unchanged, and nothing else in the function list moved", () => {
    expect(sql(DB, `select md5(pg_get_functiondef('public.complete_sale_v5(text,numeric,jsonb,uuid,timestamptz,text,uuid,uuid)'::regprocedure))`)).toBe(v5Before);
    // Exactly one new overload of each name, and no other new public function.
    expect(sql(DB, `select string_agg(proname || '(' || pg_get_function_identity_arguments(oid) || ')', ' | ' order by proname)
                    from pg_proc where pronamespace='public'::regnamespace and proname in
                    ('get_device_sale_by_request_id','complete_sale_recovery_v1','sale_recovery_device_hash')`)).toBe(
      "complete_sale_recovery_v1(p_payment_method text, p_tip_amount numeric, p_items jsonb, p_sale_request_id uuid, p_source text, p_original_employee_pos_session_id uuid, p_original_register_session_id uuid, p_original_attempt_at timestamp with time zone, p_current_employee_pos_session_id uuid)" +
      " | get_device_sale_by_request_id(p_sale_request_id uuid, p_payment_method text, p_items jsonb, p_tip_amount numeric, p_original_employee_pos_session_id uuid, p_original_register_session_id uuid)" +
      " | sale_recovery_device_hash(p_project_id uuid, p_payment_method text, p_tip_amount numeric, p_items jsonb)"
    );
  });

  it("4. security definer, fixed search_path and volatility are the intended ones", () => {
    expect(sql(DB, `select string_agg(proname || ':' || prosecdef::text || ':' || provolatile::text || ':' || array_to_string(proconfig, ','), ' | ' order by proname)
                    from pg_proc where pronamespace='public'::regnamespace and proname in
                    ('get_device_sale_by_request_id','complete_sale_recovery_v1','sale_recovery_device_hash')`)).toBe(
      "complete_sale_recovery_v1:true:v:search_path=public, pg_temp" +
      " | get_device_sale_by_request_id:true:s:search_path=public, pg_temp" +
      " | sale_recovery_device_hash:false:i:search_path=public, pg_temp"
    );
  });

  it("5. grants: lookup and recovery for authenticated only; the hash helper for no role", () => {
    const can = (role: string, fn: string): string =>
      sql(DB, `select has_function_privilege('${role}', '${fn}', 'execute')`);
    const LOOKUP = "public.get_device_sale_by_request_id(uuid,text,jsonb,numeric,uuid,uuid)";
    const RECOVER = "public.complete_sale_recovery_v1(text,numeric,jsonb,uuid,text,uuid,uuid,timestamptz,uuid)";
    const HASH = "public.sale_recovery_device_hash(uuid,text,numeric,jsonb)";

    expect([can("authenticated", LOOKUP), can("anon", LOOKUP), can("service_role", LOOKUP)]).toEqual(["t", "f", "f"]);
    expect([can("authenticated", RECOVER), can("anon", RECOVER), can("service_role", RECOVER)]).toEqual(["t", "f", "f"]);
    expect([can("authenticated", HASH), can("anon", HASH), can("service_role", HASH)]).toEqual(["f", "f", "f"]);
    // PUBLIC holds nothing on any of them.
    expect(sql(DB, `select count(*) from pg_proc p, aclexplode(p.proacl) a
                    where p.proname in ('get_device_sale_by_request_id','complete_sale_recovery_v1','sale_recovery_device_hash')
                      and a.grantee = 0`)).toBe("0");
  });

  it("6. and the grant assertions are not vacuous: a plain new function IS open to all three", () => {
    freshDatabase(FRESH, false);
    sql(FRESH, `create function public.g1s_control() returns int language sql as $$ select 1 $$`);

    expect(sql(FRESH, `select has_function_privilege('anon','public.g1s_control()','execute')`)).toBe("t");
    expect(sql(FRESH, `select has_function_privilege('service_role','public.g1s_control()','execute')`)).toBe("t");
  }, 600_000);
});

// ===========================================================================
// 2. LOOKUP, STRICT RECOVERY, REPLAY, CONFLICT
// ===========================================================================

run("G1S behaviour: lookup and strict recovery", () => {
  const DB = "g1s_main";
  let amy1 = "";
  let today1 = "";
  let yesterday1 = "";

  beforeAll(() => {
    freshDatabase(DB, true);
    seed(DB);
    sql(DB, `update public.paired_devices set unpaired_at = now() where id='${device(4)}'`);
    amy1 = signIn(DB, 1, "001", "2222");
    today1 = dailyRegister(DB, 1);
    // ONE daily row per device per date (register_sessions_one_daily_per_device_date).
    yesterday1 = yesterdayRegister(DB, 1);
  }, 600_000);

  // --- hash parity --------------------------------------------------------

  it("7. the internal hash equals the hash complete_sale_v5 STORES, across payload shapes", () => {
    const shapes: [string, string, string][] = [
      [R("71"), "cash", `'[{"itemId":"latte","quantity":1}]'::jsonb`],
      [R("72"), "card", `'[{"itemId":"latte","quantity":3}]'::jsonb`],
      [R("73"), "cash", `'[{"itemId":"muffin","quantity":2},{"itemId":"latte","quantity":1}]'::jsonb`],
      [R("74"), "cash", `'[{"itemId":" latte ","quantity":1,"modifiers":[{"groupId":"extras","optionIds":["syrup","shot"]},{"groupId":"milk","optionIds":["oat"]}]}]'::jsonb`],
      [R("75"), "card", `'[{"itemId":"latte","quantity":1,"modifiers":[{"groupId":"milk","optionIds":["whole"]},{"groupId":"extras","optionIds":[]}]},{"itemId":"latte","quantity":2}]'::jsonb`],
    ];

    for (const [request, payment, items] of shapes) {
      asRole(DB, deviceUser(1), `select public.complete_sale_v5('${payment}', 0, ${items}, '${request}', null, 'online', '${amy1}', '${today1}')::text`);

      const stored = sql(DB, `select sale_request_hash from public.orders where sale_request_id='${request}'`);
      const computed = sql(DB, `select public.sale_recovery_device_hash('${PROJECT}', '${payment}', 0, ${items})`);

      expect(computed).toBe(stored);
    }
  });

  // --- access control -----------------------------------------------------

  it("8. unauthenticated, unpaired and non-device callers are refused by both functions", () => {
    const noClaim = (statement: string) => failureOf(() => sql(DB, `select set_config('request.jwt.claim.sub','', false); ${statement}`));

    expect(noClaim(lookupSql({ request: R("01") }))).toBe("Authentication required");
    expect(noClaim(recoverSql({ request: R("01"), source: "online", original: amy1, register: today1, current: amy1 }))).toBe("Authentication required");

    expect(failureOf(() => lookup(DB, 4, { request: R("01") }))).toBe("This device is no longer paired");
    expect(failureOf(() => recover(DB, 4, { request: R("01"), source: "online", original: amy1, register: today1, current: amy1 }))).toBe("This device is no longer paired");

    expect(failureOf(() => JSON.parse(asRole(DB, OWNER, lookupSql({ request: R("01") }))))).toBe("Project not found or access denied");
    expect(failureOf(() => JSON.parse(asRole(DB, OWNER, recoverSql({ request: R("01"), source: "online", original: amy1, register: today1, current: amy1 }))))).toBe("Project not found or access denied");
  });

  // --- lookup ---------------------------------------------------------------

  it("9. lookup: an absent id is not_found, and the lookup itself runs in a READ ONLY transaction", () => {
    const before = footprint(DB);
    const out = sql(DB, `begin transaction read only;
      select set_config('request.jwt.claim.sub','${deviceUser(1)}', true);
      ${lookupSql({ request: R("09") })};
      commit;`);

    expect(JSON.parse(lastLine(out))).toEqual({ status: "not_found" });
    expect(footprint(DB)).toBe(before);
  });

  it("10. lookup: a matching order on this device, with attribution verified / unverified / in conflict", () => {
    recover(DB, 1, { request: R("10"), source: "online", original: amy1, register: today1, current: amy1 });

    const verified = lookup(DB, 1, { request: R("10"), original: amy1, register: today1 });

    expect(verified.status).toBe("match");
    expect(verified.attribution).toBe("verified");
    expect((verified.order as Record<string, string>).employeeId).toBe(AMY);
    expect(lookup(DB, 1, { request: R("10") }).attribution).toBe("unverified");
    expect(lookup(DB, 1, { request: R("10"), original: amy1, register: yesterday1 }).attribution).toBe("conflict");
  });

  it("11. lookup: a different payload under the same id discloses NO order details", () => {
    for (const variant of [{ items: LATTE_X2 }, { payment: "card" },
      { items: `'[{"itemId":"latte","quantity":1,"modifiers":[{"groupId":"milk","optionIds":["oat"]}]}]'::jsonb` }]) {
      expect(lookup(DB, 1, { request: R("10"), ...variant })).toEqual({ status: "payload_mismatch" });
    }
  });

  it("12. lookup: another till's order is not disclosed; another project's id is simply not found", () => {
    signIn(DB, 2, "002", "3333");
    const ben2 = sql(DB, `select id::text from public.employee_pos_sessions where paired_device_id='${device(2)}' and ended_at is null`);
    const today2 = dailyRegister(DB, 2);

    asRole(DB, deviceUser(2), v5Sql(R("12"), "online", ben2, today2));

    expect(lookup(DB, 1, { request: R("12") })).toEqual({ status: "not_this_device" });
    expect(lookup(DB, 3, { request: R("10") })).toEqual({ status: "not_found" });
  });

  // --- strict recovery: creation -------------------------------------------

  it("13. online: the ORIGINAL employee recovers; attribution, items, inventory and number are right", () => {
    const before = footprint(DB);
    const result = recover(DB, 1, { request: R("13"), source: "online", original: amy1, register: today1, current: amy1 });

    expect(result.status).toBe("created");
    expect(orderOf(DB, R("13"))).toMatchObject({ employee: AMY, register: today1, device: device(1), source: "online", items: 1, inventory: 1 });
    expect(footprint(DB)).not.toBe(before);
  });

  it("14. online: the same employee after a NEW sign-in still recovers under the same employee", () => {
    const amyAgain = signIn(DB, 1, "001", "2222");

    expect(amyAgain).not.toBe(amy1);

    const result = recover(DB, 1, { request: R("14"), source: "online", original: amy1, register: today1, current: amyAgain });

    expect(result.status).toBe("created");
    expect(orderOf(DB, R("14"))).toMatchObject({ employee: AMY, register: today1 });
    amy1 = amyAgain;
  });

  it("15. online: a DIFFERENT signed-in employee is refused, and nothing is written", () => {
    const ben1 = signIn(DB, 1, "002", "3333");
    const before = footprint(DB);

    expect(failureOf(() => recover(DB, 1, { request: R("15"), source: "online", original: amy1, register: today1, current: ben1 })))
      .toBe("Only the original employee can recover this sale online");
    expect(footprint(DB)).toBe(before);
    expect(orderOf(DB, R("15"))).toEqual({});
  });

  it("16. online: after a register ROLLOVER the original employee is refused (v5's own check), nothing written", () => {
    const amy = signIn(DB, 1, "001", "2222");
    const before = footprint(DB);
    const message = failureOf(() => recover(DB, 1, { request: R("16"), source: "online", original: amy, register: yesterday1, current: amy }));

    expect(message).not.toBe("");
    expect(footprint(DB)).toBe(before);
    expect(orderOf(DB, R("16"))).toEqual({});
    amy1 = amy;
  });

  it("17. historical: Amy rang it, rang out, Ben signed in — recovered under AMY via the original claims", () => {
    const amyOriginal = amy1;

    signIn(DB, 1, "002", "3333"); // Ben replaces Amy; Amy's session ends.
    expect(sql(DB, `select ended_at is not null from public.employee_pos_sessions where id='${amyOriginal}'`)).toBe("t");

    const result = recover(DB, 1, {
      request: R("17"), source: "offline_queued", original: amyOriginal, register: today1, at: midpointOf(amyOriginal),
    });

    expect(result.status).toBe("created");
    expect(orderOf(DB, R("17"))).toMatchObject({ employee: AMY, register: today1, source: "offline_queued", items: 1, inventory: 1 });
  });

  it("18. historical: a claim v5 cannot prove (would store NULL) is REFUSED with no financial writes", () => {
    const ben = sql(DB, `select id::text from public.employee_pos_sessions where paired_device_id='${device(1)}' and ended_at is null`);
    const amyEnded = sql(DB, `select id::text from public.employee_pos_sessions where paired_device_id='${device(1)}'
                              and employee_id='${AMY}' and ended_at is not null order by started_at desc limit 1`);
    const before = footprint(DB);

    // Ben's session as the claim, at an instant inside AMY's session: v5 would
    // store employee_id = NULL. The guard refuses and everything rolls back.
    expect(failureOf(() => recover(DB, 1, {
      request: R("18"), source: "offline_queued", original: ben, register: today1, at: midpointOf(amyEnded),
    }))).toBe("The original employee and register could not be proven for this sale");
    expect(footprint(DB)).toBe(before);
    expect(orderOf(DB, R("18"))).toEqual({});
  });

  it("19. invalid / missing / foreign claims and bad requests are refused before anything is written", () => {
    // Any session on TILL 2 — open or not — is foreign to till 1.
    const ben2 = sql(DB, `select id::text from public.employee_pos_sessions where paired_device_id='${device(2)}' order by started_at desc limit 1`);
    const today2 = dailyRegister(DB, 2);
    const before = footprint(DB);
    const base = { request: R("19"), source: "offline_queued" as const, at: "now()" };

    expect(failureOf(() => recover(DB, 1, { ...base, original: null, register: today1 }))).toBe("Recovery requires the original employee session and register");
    expect(failureOf(() => recover(DB, 1, { ...base, original: amy1, register: null }))).toBe("Recovery requires the original employee session and register");
    expect(failureOf(() => recover(DB, 1, { ...base, original: ben2, register: today1 }))).toBe("The original employee session could not be verified");
    expect(failureOf(() => recover(DB, 1, { ...base, original: amy1, register: today2 }))).toBe("The original register could not be verified");
    expect(failureOf(() => recover(DB, 1, { ...base, original: "99999999-9999-4999-8999-999999999999", register: today1 }))).toBe("The original employee session could not be verified");
    expect(failureOf(() => recover(DB, 1, { request: R("19"), source: "offline_queued", original: amy1, register: today1 }))).toBe("Recovery requires the original attempt time");
    expect(failureOf(() => recover(DB, 1, { request: R("19"), source: "online", original: amy1, register: today1 }))).toBe("Online recovery requires the signed-in employee session");
    expect(failureOf(() => recover(DB, 3, { ...base, original: amy1, register: today1 }))).toBe("The original employee session could not be verified");
    expect(failureOf(() => JSON.parse(asRole(DB, deviceUser(1),
      recoverSql({ ...base, original: amy1, register: today1 }).replace(`'cash', 0,`, `'cash', 1,`))))).toBe("Tips are not supported on this device");
    expect(footprint(DB)).toBe(before);
  });

  // --- replay and conflict --------------------------------------------------

  it("20. a matching replay returns the SAME order and writes nothing", () => {
    const amyOriginal = sql(DB, `select employee_id::text from public.orders where sale_request_id='${R("17")}'`);
    const original = sql(DB, `select id::text from public.orders where sale_request_id='${R("17")}'`);
    // The session R17 was recovered under: the session containing its occurred_at.
    const claim = sql(DB, `select s.id::text from public.employee_pos_sessions s, public.orders o
                           where o.sale_request_id='${R("17")}' and s.employee_id = o.employee_id
                             and s.paired_device_id='${device(1)}'
                             and o.occurred_at >= s.started_at and (s.ended_at is null or o.occurred_at < s.ended_at)`);
    const before = footprint(DB);
    const result = recover(DB, 1, { request: R("17"), source: "offline_queued", original: claim, register: today1, at: "now()" });

    expect(amyOriginal).toBe(AMY);
    expect(result.status).toBe("replayed");
    expect((result.receipt as Record<string, string>).orderId).toBe(original);
    expect(footprint(DB)).toBe(before);
  });

  it("21. an existing order with SUBSTITUTED attribution (legacy v5 by Ben) is a conflict: no receipt, unchanged", () => {
    const ben = sql(DB, `select id::text from public.employee_pos_sessions where paired_device_id='${device(1)}' and ended_at is null`);
    const amyEnded = sql(DB, `select id::text from public.employee_pos_sessions where paired_device_id='${device(1)}'
                              and employee_id='${AMY}' and ended_at is not null order by started_at desc limit 1`);

    asRole(DB, deviceUser(1), v5Sql(R("21"), "online", ben, today1));

    const stored = orderOf(DB, R("21"));
    const before = footprint(DB);
    const result = recover(DB, 1, { request: R("21"), source: "offline_queued", original: amyEnded, register: today1, at: midpointOf(amyEnded) });

    expect(stored.employee).toBe(BEN);
    expect(result.status).toBe("attribution_conflict");
    expect(result.receipt).toBeUndefined();
    expect(result.stored).toMatchObject({ employeeId: BEN });
    expect(result.expected).toMatchObject({ employeeId: AMY });
    expect(orderOf(DB, R("21"))).toEqual(stored);
    expect(footprint(DB)).toBe(before);
  });

  it("22. an existing order with NULL attribution (legacy v5, unprovable claim) is a conflict, unchanged", () => {
    const ben = sql(DB, `select id::text from public.employee_pos_sessions where paired_device_id='${device(1)}' and ended_at is null`);
    const amyEnded = sql(DB, `select id::text from public.employee_pos_sessions where paired_device_id='${device(1)}'
                              and employee_id='${AMY}' and ended_at is not null order by started_at desc limit 1`);

    asRole(DB, deviceUser(1), v5Sql(R("22"), "offline_queued", ben, today1, midpointOf(amyEnded)));

    const stored = orderOf(DB, R("22"));
    const result = recover(DB, 1, { request: R("22"), source: "offline_queued", original: amyEnded, register: today1, at: midpointOf(amyEnded) });

    expect(stored.employee).toBe("NULL");
    expect(result.status).toBe("attribution_conflict");
    expect(result.receipt).toBeUndefined();
    expect(orderOf(DB, R("22"))).toEqual(stored);
  });

  it("23. a DIFFERENT payload under an existing id raises v5's own conflict and returns nothing", () => {
    const amyEnded = sql(DB, `select id::text from public.employee_pos_sessions where paired_device_id='${device(1)}'
                              and employee_id='${AMY}' and ended_at is not null order by started_at desc limit 1`);
    const before = footprint(DB);

    expect(failureOf(() => recover(DB, 1, { request: R("17"), source: "offline_queued", original: amyEnded, register: today1, at: "now()", items: LATTE_X2 })))
      .toBe("Sale request ID was already used for a different order");
    expect(footprint(DB)).toBe(before);
  });

  it("24. G-1-SERVER-1A: another till's order gets the SAME minimal refusal for matching and differing payloads, no writes", () => {
    const amyEnded = sql(DB, `select id::text from public.employee_pos_sessions where paired_device_id='${device(1)}'
                              and employee_id='${AMY}' and ended_at is not null order by started_at desc limit 1`);
    const before = footprint(DB);
    const tillTwoOrder = orderOf(DB, R("12"));
    const matching = recover(DB, 1, { request: R("12"), source: "offline_queued", original: amyEnded, register: today1, at: midpointOf(amyEnded) });
    const differing = recover(DB, 1, { request: R("12"), source: "offline_queued", original: amyEnded, register: today1, at: midpointOf(amyEnded), items: LATTE_X2 });

    // Exactly this object: no order id, number, receipt, employee, register,
    // device, and nothing that distinguishes a matching from a differing payload.
    expect(matching).toEqual({ status: "not_this_device" });
    expect(differing).toEqual({ status: "not_this_device" });
    expect(footprint(DB)).toBe(before);
    expect(orderOf(DB, R("12"))).toEqual(tillTwoOrder);
    // The lookup answers the same way for both payloads.
    expect(lookup(DB, 1, { request: R("12") })).toEqual({ status: "not_this_device" });
    expect(lookup(DB, 1, { request: R("12"), items: LATTE_X2 })).toEqual({ status: "not_this_device" });
  });

  it("24b. G-1-SERVER-1A: an order with NULL paired_device_id (an owner sale) is outside this device's scope", () => {
    const amyEnded = sql(DB, `select id::text from public.employee_pos_sessions where paired_device_id='${device(1)}'
                              and employee_id='${AMY}' and ended_at is not null order by started_at desc limit 1`);

    // The product's own owner checkout stores no paired_device_id.
    asRole(DB, OWNER, `select public.complete_sale_v3('${PROJECT}', 'cash', 0, ${LATTE}, '${R("24")}')::text`);
    expect(orderOf(DB, R("24")).device).toBe("NULL");

    const before = footprint(DB);
    const ownerOrder = orderOf(DB, R("24"));

    expect(recover(DB, 1, { request: R("24"), source: "offline_queued", original: amyEnded, register: today1, at: midpointOf(amyEnded) }))
      .toEqual({ status: "not_this_device" });
    expect(recover(DB, 1, { request: R("24"), source: "offline_queued", original: amyEnded, register: today1, at: midpointOf(amyEnded), items: LATTE_X2 }))
      .toEqual({ status: "not_this_device" });
    expect(lookup(DB, 1, { request: R("24") })).toEqual({ status: "not_this_device" });
    expect(footprint(DB)).toBe(before);
    expect(orderOf(DB, R("24"))).toEqual(ownerOrder);
  });

  it("24c. cross-project isolation is preserved: till 3 (another project) never sees PROJECT's order", () => {
    expect(lookup(DB, 3, { request: R("12") })).toEqual({ status: "not_found" });
  });

  it("24z. evidence: final orders, attribution and side effects of this database", () => {
    dumpEvidence(DB, "behaviour-orders");
    expect(true).toBe(true);
  });
});

// ===========================================================================
// 2b. G-1-SERVER-1A — HISTORICAL REGISTER RECOVERY (a previous business day)
// ===========================================================================

run("G1S historical: a previous business day's session and register", () => {
  const DB = "g1s_historical";
  let amyYesterday = "";
  let yesterday = "";
  let today = "";
  let ben = "";

  /** Local instant on the business day `offsetDays` from today. */
  const instantIn = (offsetDays: number, hours: string): string =>
    `(select b.starts_at + interval '${hours}'
       from public.business_day_bounds((now() at time zone '${ZONE}')::date + ${offsetDays}, '${ZONE}') b)`;

  beforeAll(() => {
    freshDatabase(DB, true);
    seed(DB);

    // TEST-ONLY FIXTURE, consistent with every constraint: a CLOSED POS session
    // for Amy on till 1 from 10:00 to 18:00 local YESTERDAY (end_reason
    // 'logout', ended_at >= started_at, not open, so the one-open-per-device
    // index is untouched), and yesterday's DAILY register for till 1, built
    // exactly as the accepted suite builds it.
    amyYesterday = sql(DB, `insert into public.employee_pos_sessions (employee_id, paired_device_id, started_at, ended_at, end_reason)
      values ('${AMY}', '${device(1)}', ${instantIn(-1, "10 hours")}, ${instantIn(-1, "18 hours")}, 'logout')
      returning id::text`);
    yesterday = yesterdayRegister(DB, 1);

    // TODAY: another employee (Ben) is signed in and today's register is open.
    ben = signIn(DB, 1, "002", "3333");
    today = dailyRegister(DB, 1);
  }, 600_000);

  const original = (at: string, overrides: Partial<RecoverArgs> = {}): RecoverArgs => ({
    request: R("40"), source: "offline_queued", original: amyYesterday, register: yesterday, at, ...overrides,
  });

  it("40. preconditions: Amy's session and register are yesterday's; Ben and today's register are active", () => {
    expect(sql(DB, `select (started_at at time zone '${ZONE}')::date = (now() at time zone '${ZONE}')::date - 1
                    from public.employee_pos_sessions where id='${amyYesterday}'`)).toBe("t");
    expect(sql(DB, `select business_date = (now() at time zone '${ZONE}')::date - 1 from public.register_sessions where id='${yesterday}'`)).toBe("t");
    expect(sql(DB, `select employee_id::text from public.employee_pos_sessions where id='${ben}' and ended_at is null`)).toBe(BEN);
    expect(today).not.toBe(yesterday);
  });

  it("41. invalid historical claims refuse with NO partial writes", () => {
    const before = footprint(DB);
    const otherDeviceSession = sql(DB, `insert into public.employee_pos_sessions (employee_id, paired_device_id, started_at, ended_at, end_reason)
      values ('${AMY}', '${device(2)}', ${instantIn(-1, "10 hours")}, ${instantIn(-1, "18 hours")}, 'logout') returning id::text`);

    // An attempt time AFTER Amy's session ended (still yesterday): v5 would
    // store NULL for the employee; the guard refuses.
    expect(failureOf(() => recover(DB, 1, original(instantIn(-1, "20 hours"), { request: R("41") }))))
      .toBe("The original employee and register could not be proven for this sale");
    // An attempt time TODAY against yesterday's register: v5's own register
    // validation refuses.
    expect(failureOf(() => recover(DB, 1, original(instantIn(0, "1 hour"), { request: R("42") })))).not.toBe("");
    // A session that belongs to another till.
    expect(failureOf(() => recover(DB, 1, original(instantIn(-1, "14 hours"), { request: R("43"), original: otherDeviceSession }))))
      .toBe("The original employee session could not be verified");
    // Today's register with yesterday's attempt time.
    expect(failureOf(() => recover(DB, 1, original(instantIn(-1, "14 hours"), { request: R("44"), register: today })))).not.toBe("");

    expect(footprint(DB)).toBe(before);
    for (const id of ["41", "42", "43", "44"]) expect(orderOf(DB, R(id))).toEqual({});
  });

  it("42. VALID: recovered under Amy, yesterday's register and the ORIGINAL occurred_at, while Ben is signed in", () => {
    const before = footprint(DB);
    const result = recover(DB, 1, original(instantIn(-1, "14 hours")));

    expect(result.status).toBe("created");
    expect(orderOf(DB, R("40"))).toMatchObject({ employee: AMY, register: yesterday, device: device(1), source: "offline_queued", items: 1, inventory: 1 });
    expect(sql(DB, `select occurred_at = ${instantIn(-1, "14 hours")} from public.orders where sale_request_id='${R("40")}'`)).toBe("t");
    expect(sql(DB, `select r.business_date = (now() at time zone '${ZONE}')::date - 1
                    from public.orders o join public.register_sessions r on r.id = o.register_session_id
                    where o.sale_request_id='${R("40")}'`)).toBe("t");
    expect(footprint(DB)).not.toBe(before);
  });

  it("43. replaying the same id (strict, and legacy v5) creates no second order, item or inventory movement", () => {
    const before = footprint(DB);
    const orderId = sql(DB, `select id::text from public.orders where sale_request_id='${R("40")}'`);
    const strict = recover(DB, 1, original(instantIn(-1, "14 hours")));
    const legacy = JSON.parse(asRole(DB, deviceUser(1), v5Sql(R("40"), "offline_queued", amyYesterday, yesterday, instantIn(-1, "14 hours"))));

    expect(strict.status).toBe("replayed");
    expect((strict.receipt as Record<string, string>).orderId).toBe(orderId);
    expect(legacy.orderId).toBe(orderId);
    expect(footprint(DB)).toBe(before);
    expect(sql(DB, `select count(*) from public.orders where sale_request_id='${R("40")}'`)).toBe("1");
    dumpEvidence(DB, "historical-orders");
  });
});

// ===========================================================================
// 3. CONCURRENCY — deterministic, two real connections
// ===========================================================================

run("G1S concurrency: strict vs strict, v5 vs strict in both orders, late commit", () => {
  const DB = "g1s_conc";
  let amy = "";
  let today = "";
  let amyEnded = "";
  let ben = "";

  beforeAll(() => {
    freshDatabase(DB, true);
    seed(DB);
    amy = signIn(DB, 1, "001", "2222");
    today = dailyRegister(DB, 1);
    // A closed Amy session to use as the ORIGINAL claim, and Ben signed in now.
    ben = signIn(DB, 1, "002", "3333");
    amyEnded = amy;
  }, 600_000);

  async function pair(): Promise<[Session, Session]> {
    const a = new Session(DB, `g1s_a_${Date.now()}`);
    const b = new Session(DB, `g1s_b_${Date.now()}`);

    await a.run(`select set_config('request.jwt.claim.sub','${deviceUser(1)}', false);`);
    await b.run(`select set_config('request.jwt.claim.sub','${deviceUser(1)}', false);`);

    return [a, b];
  }

  const strictHistorical = (request: string): string =>
    recoverSql({ request, source: "offline_queued", original: amyEnded, register: today, at: midpointOf(amyEnded) });

  it("25. two concurrent strict recoveries: the second WAITS, then replays the first's order", async () => {
    const [a, b] = await pair();

    try {
      await a.run("begin;");
      const first = JSON.parse(lastLine((await a.run(strictHistorical(R("25")))).out));
      const second = b.run(strictHistorical(R("25")));

      await waitUntilBlocked(DB, b.app);
      await a.run("commit;");

      const secondResult = JSON.parse(lastLine((await second).out));

      expect(first.status).toBe("created");
      expect(secondResult.status).toBe("replayed");
      expect(secondResult.receipt.orderId).toBe(first.receipt.orderId);
      expect(orderOf(DB, R("25"))).toMatchObject({ employee: AMY, register: today, items: 1, inventory: 1 });
      expect(sql(DB, `select count(*) from public.orders where sale_request_id='${R("25")}'`)).toBe("1");
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("26. v5 (legacy, Ben, substituted) COMMITS FIRST: strict waits, then reports the conflict and changes nothing", async () => {
    const [a, b] = await pair();

    try {
      await a.run("begin;");
      await a.run(v5Sql(R("26"), "online", ben, today));
      const strict = b.run(strictHistorical(R("26")));

      await waitUntilBlocked(DB, b.app);
      await a.run("commit;");

      const result = JSON.parse(lastLine((await strict).out));

      expect(result.status).toBe("attribution_conflict");
      expect(result.receipt).toBeUndefined();
      expect(orderOf(DB, R("26"))).toMatchObject({ employee: BEN, items: 1, inventory: 1 });
      expect(sql(DB, `select count(*) from public.orders where sale_request_id='${R("26")}'`)).toBe("1");
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("27. strict COMMITS FIRST: legacy v5 (Ben) waits, then REPLAYS the strict order under Amy — no second order", async () => {
    const [a, b] = await pair();

    try {
      await a.run("begin;");
      const strict = JSON.parse(lastLine((await a.run(strictHistorical(R("27")))).out));
      const legacy = b.run(v5Sql(R("27"), "online", ben, today));

      await waitUntilBlocked(DB, b.app);
      await a.run("commit;");

      const replayed = JSON.parse(lastLine((await legacy).out));

      expect(strict.status).toBe("created");
      expect(replayed.orderId).toBe(strict.receipt.orderId);
      expect(orderOf(DB, R("27"))).toMatchObject({ employee: AMY, items: 1, inventory: 1 });
      expect(sql(DB, `select count(*) from public.orders where sale_request_id='${R("27")}'`)).toBe("1");
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("28. v5 with NULL attribution commits first: strict waits, then reports the conflict", async () => {
    const [a, b] = await pair();

    try {
      await a.run("begin;");
      await a.run(v5Sql(R("28"), "offline_queued", ben, today, midpointOf(amyEnded)));
      const strict = b.run(strictHistorical(R("28")));

      await waitUntilBlocked(DB, b.app);
      await a.run("commit;");

      const result = JSON.parse(lastLine((await strict).out));

      expect(result.status).toBe("attribution_conflict");
      expect(orderOf(DB, R("28"))).toMatchObject({ employee: "NULL", items: 1, inventory: 1 });
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("29. strict holds the lock and ROLLS BACK: the waiting strict call then creates exactly one order", async () => {
    const [a, b] = await pair();

    try {
      await a.run("begin;");
      await a.run(strictHistorical(R("29")));
      const second = b.run(strictHistorical(R("29")));

      await waitUntilBlocked(DB, b.app);
      await a.run("rollback;");

      const result = JSON.parse(lastLine((await second).out));

      expect(result.status).toBe("created");
      expect(orderOf(DB, R("29"))).toMatchObject({ employee: AMY, items: 1, inventory: 1 });
      expect(sql(DB, `select count(*) from public.orders where sale_request_id='${R("29")}'`)).toBe("1");
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("30. lookup absence is NOT proof: an uncommitted original is not_found, then a late commit makes it match", async () => {
    const [a, b] = await pair();

    try {
      // The ORIGINAL request, by Amy, still in flight (uncommitted).
      await a.run("begin;");
      await a.run(v5Sql(R("30"), "offline_queued", amyEnded, today, midpointOf(amyEnded)));

      // The lookup does not block and does not see it.
      const absent = JSON.parse(lastLine((await b.run(lookupSql({ request: R("30") }))).out));

      expect(absent).toEqual({ status: "not_found" });

      await a.run("commit;");

      const present = JSON.parse(lastLine((await b.run(lookupSql({ request: R("30"), original: amyEnded, register: today }))).out));
      const recovered = JSON.parse(lastLine((await b.run(strictHistorical(R("30")))).out));

      expect(present.status).toBe("match");
      expect(present.attribution).toBe("verified");
      expect(recovered.status).toBe("replayed");
      expect(orderOf(DB, R("30"))).toMatchObject({ employee: AMY, items: 1, inventory: 1 });
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("31. stock moved exactly once per order across every race above", () => {
    const orders = Number(sql(DB, `select count(*) from public.orders where project_id='${PROJECT}'`));
    const inventory = Number(sql(DB, `select count(*) from public.inventory_transactions where project_id='${PROJECT}'`));
    const stock = Number(sql(DB, `select config -> 'menuItems' -> 0 ->> 'stockQuantity' from public.projects where id='${PROJECT}'`));

    expect(inventory).toBe(orders);
    expect(stock).toBe(50 - orders);
    expect(ben).not.toBe(amy);
    dumpEvidence(DB, "concurrency-orders");
  });
});
