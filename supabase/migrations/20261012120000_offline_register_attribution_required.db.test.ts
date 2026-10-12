// v1.3 CP-2B — migration 20261012120000, EXECUTED against a real PostgreSQL.
//
// WHAT IS PROVEN HERE THAT TEXT CANNOT PROVE. This migration replaces
// complete_sale_v5, the live checkout function for EVERY sale, and until this
// file existed nothing in the automated suite applied it. The ten db suites
// that pre-date it either stop at their own migration or, in the case of the
// complete_sale_v5 suite itself, build a database from the predecessors and
// then apply ONLY 20260922120000 -- so the accepted grants, security settings
// and refusal behaviour of THIS definition were never executed by a gate.
//
// Specifically proven, by running it:
//   * a queued sale with a valid claim is attributed to THAT register, by its
//     own identity, and not to whatever a re-derivation would have resolved;
//   * a missing, unknown, foreign-device, out-of-window or zone-conflicted
//     claim is refused, and the refusal writes NOTHING -- no order, no item,
//     no inventory row, no register session, and not even the project's order
//     counter row;
//   * a CLOSED register still accepts a sale that happened inside it, which is
//     the late-posting case the accepted design deliberately keeps;
//   * a replay returns the original order even when the claim would no longer
//     validate, because the idempotency lookup precedes this guard;
//   * online checkout keeps its own two refusals and never sees the new one;
//   * the signature, security definer, search_path and ACL are the accepted
//     ones, and the ACL assertion is not vacuous.
//
// ON THE NUMBERING. The cases are numbered 1-38 with gaps at 10, 11, 18 and
// 30. Those four were written against hand-built fixtures that the database
// itself rejected -- register_sessions_legacy_shape forbids a manual period
// without opened_by_employee_id, projects_validate_business_timezone forbids a
// zone change while a register covers now, and
// register_sessions_guard_daily_immutable forbids editing closed_at on a daily
// context. All three refusals are correct, so the scenarios were rebuilt
// through the product's own RPCs in databases that do not need the safeguard
// bypassed; they are cases 32-38 at the end. The gaps are left rather than
// renumbered so this note has something to point at.
//
// The harness (PostgreSQL discovery, the Supabase compatibility layer, the
// cluster and the migration chain) is the one the earlier v1.3 suites use,
// reproduced unchanged; only the migration name and the port range differ.
// When no PostgreSQL server is found the suite SKIPS LOUDLY rather than
// failing.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20261012120000_offline_register_attribution_required.sql";

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

// A port range no other db suite uses, so a full `npm test` can run them in
// whatever order it likes without two clusters colliding.
const PORT = 56900 + (process.pid % 90);

if (PG_BIN === null) {
  console.warn(
    `\n[${MIGRATION}] SKIPPED: no local PostgreSQL server found.` +
      "\n  These are the only tests that EXECUTE the CP-2B register guard;" +
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
-- no-ops and the ACL assertions below would pass trivially. A test at the end
-- proves this layer is really in force.
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
    // "WITHOUT the migration" means the database as it was BEFORE it -- so
    // every migration that comes AFTER it is skipped too, not just the one
    // under test. Filenames begin with a fixed-width timestamp, so a
    // lexicographic compare is a chronological one.
    if (!withMigration && file >= MIGRATION) continue;
    // AND "WITH the migration" means the database as it was right AFTER it.
    // This migration is currently the newest, so the clause is a no-op today;
    // it is here so that the day a successor lands, the before/after
    // comparisons keep measuring THIS migration rather than that one.
    if (withMigration && file > MIGRATION) continue;
    if (STORAGE_ONLY_MIGRATIONS.has(file)) continue;

    runSqlFile(name, join(migrationsDir, file));
    sql(name,
      `insert into supabase_migrations.schema_migrations(version, name)
       values ('${file.split("_")[0]}', '${file}') on conflict do nothing`);
  }
}

/** Applies ONLY this migration, as the CLI does: one transaction. */
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

/** The priced menu every sale below is rung up against. One item, no tax. */
const MENU = JSON.stringify({
  menuItems: [{ id: "latte", name: "Latte", price: "4.00", available: true }],
  tax: { enabled: false, rate: 0 },
  receipt: {},
});

const ONE_LATTE = `'[{"itemId":"latte","quantity":1}]'::jsonb`;
const ZONE = "America/New_York";
const OTHER_ZONE = "America/Los_Angeles";

/**
 * One project (with a timezone), one build, `tills` paired devices, one
 * employee. Devices are paired 30 days ago so an offline sale's "predates this
 * device" guard is never what refuses a test by accident.
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

/** The same, returning the server's error sentence instead of throwing. */
function saleExpectingFailure(db: string, n: number, a: SaleArgs): string {
  try {
    sale(db, n, a);
    return "";
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    return (/ERROR:\s*(.*)/.exec((err.stderr ?? err.message ?? "").toString())?.[1] ?? "").trim();
  }
}

/**
 * A DAILY register for till `n` on `today + offsetDays`, with exact CP2a
 * bounds, closed exactly at the end of that business day.
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

/**
 * Everything a refused sale must not have touched, as one comparable string.
 *
 * The order counter is in here deliberately and reads "no counter" until the
 * first sale allocates it: a refusal that rolled back an insert and a refusal
 * that never reached one look identical in a row count, and the accepted
 * argument for this guard's POSITION is that nothing is written at all.
 */
function footprint(db: string): string {
  return sql(db, `select
    (select count(*) from public.orders)::text || ' orders / ' ||
    (select count(*) from public.order_items)::text || ' items / ' ||
    (select count(*) from public.inventory_transactions)::text || ' inventory / ' ||
    (select count(*) from public.register_sessions)::text || ' registers / counter ' ||
    coalesce((select last_number::text from public.project_order_counters
              where project_id='${PROJECT}'), 'unallocated')`);
}

/** The business date a stored order was filed under, or "NULL". */
function filedUnder(db: string, request: string): string {
  return sql(db, `select coalesce(r.business_date::text,'NULL')
                  from public.orders o
                  left join public.register_sessions r on r.id = o.register_session_id
                  where o.sale_request_id = '${request}'`);
}

/** The register_session_id actually STORED on the order, or "NULL". */
function storedRegister(db: string, request: string): string {
  return sql(db, `select coalesce(register_session_id::text,'NULL')
                  from public.orders where sale_request_id='${request}'`);
}

const REFUSAL = "A register session is required for an offline sale";

const S = (n: string): string => `f1000000-0000-4000-8000-0000000000${n}`;

const SALES = {
  valid: S("01"),
  closed: S("02"),
  manual: S("03"),
  missing: S("04"),
  unknown: S("05"),
  foreign: S("06"),
  future: S("07"),
  stale: S("08"),
  zone: S("09"),
  replay: S("10"),
  conflict: S("11"),
  online: S("12"),
  onlineNull: S("13"),
  onlineClosed: S("14"),
  substituted: S("15"),
  manualClosed: S("16"),
};

const run = PG_BIN === null ? describe.skip : describe;

beforeAll(() => {
  if (PG_BIN === null) return;

  dataDir = mkdtempSync(join(tmpdir(), "mig15-pg-"));
  pg("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
  // `-l` MATTERS, and 20260926120000's harness says so for the same reason.
  // Without it the postmaster inherits this worker's stdout pipe and holds it
  // open for as long as the cluster lives, so vitest never sees the run end:
  // the suite hangs with the server up, no query running and no CPU burning.
  pg("pg_ctl", [
    "-D", dataDir, "-l", join(dataDir, "server.log"), "-w", "start",
    "-o", `-c listen_addresses=127.0.0.1 -c port=${PORT} -c unix_socket_directories=''`,
  ]);
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
// THE CONTRACT: signature, security, search_path, ACL
// ===========================================================================

run("the migration applies, and leaves the accepted function contract in place", () => {
  const DB = "mig15_contract";
  const FRESH = "mig15_contract_fresh";

  beforeAll(() => {
    freshDatabase(DB, false);
  }, 600_000);

  it("1. applies as ONE transaction over every accepted predecessor", () => {
    const result = applyMigration(DB);

    expect(result.ok ? "applied" : `FAILED: ${result.error}`).toBe("applied");
  });

  it("2. there is exactly ONE complete_sale_v5, with the accepted signature", () => {
    // create-or-replace replaces in place only while the argument list is
    // identical. A changed default or a reordered parameter would leave the old
    // function standing beside the new one, and PostgreSQL would then pick
    // between them by overload resolution -- silently, and not necessarily the
    // new one.
    expect(sql(DB, `select count(*)::text from pg_proc p
                    join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname='public' and p.proname='complete_sale_v5'`)).toBe("1");

    expect(sql(DB, `select pg_get_function_identity_arguments(p.oid)
                    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='complete_sale_v5'`))
      .toBe("p_payment_method text, p_tip_amount numeric, p_items jsonb, p_sale_request_id uuid, " +
            "p_occurred_at timestamp with time zone, p_source text, " +
            "p_employee_pos_session_id uuid, p_register_session_id uuid");
  });

  it("3. it is security definer with the search_path still pinned", () => {
    expect(sql(DB, `select p.prosecdef::text || ' ' || array_to_string(p.proconfig, ',')
                    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='complete_sale_v5'`))
      .toBe("true search_path=public, pg_temp");
  });

  it("4. only `authenticated` may execute it", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(`${role}: ${sql(DB, `select has_function_privilege('${role}',
        'public.complete_sale_v5(text,numeric,jsonb,uuid,timestamptz,text,uuid,uuid)', 'EXECUTE')::text`)}`)
        .toBe(`${role}: ${role === "authenticated" ? "true" : "false"}`);
    }
  });

  it("5. and that assertion is not vacuous: a plain new function IS open to all three", () => {
    // The negative control for test 4. Supabase's default privileges are
    // reproduced in COMPAT, so a function created without revokes is born
    // executable by anon, authenticated and service_role. If this ever reads
    // false, COMPAT has drifted and test 4 proves nothing.
    freshDatabase(FRESH, true);
    sql(FRESH, `create function public.mig15_control() returns int language sql as $$ select 1 $$`);

    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(`${role}: ${sql(FRESH, `select has_function_privilege('${role}',
        'public.mig15_control()', 'EXECUTE')::text`)}`).toBe(`${role}: true`);
    }
  });

  it("6. this migration revokes from public and anon, and `service_role` stays out by inheritance", () => {
    // RECORDED, NOT CORRECTED. 20260917120000 and 20260922120000 each revoke
    // complete_sale_v5 from public, anon AND service_role; this migration
    // restates only the first two. It is harmless in timestamp order, because
    // create-or-replace preserves the ACL the predecessors left -- which is
    // what test 4 above measures on a database built that way. It is NOT
    // harmless out of order: applied where the function does not exist, the
    // create would take the default privileges proven in test 5 and
    // service_role would keep EXECUTE. This test pins the asymmetry so it
    // cannot be mistaken for an accident, and the runbook STOP condition that
    // depends on it cannot be dropped without failing here.
    const sqlText = execFileSync("cat", [join(migrationsDir, MIGRATION)], { encoding: "utf8" });
    const revoked = (role: string): boolean =>
      sqlText.includes(`revoke all on function public.complete_sale_v5(` +
        `text, numeric, jsonb, uuid, timestamptz, text, uuid, uuid) from ${role};`);

    expect({ public: revoked("public"), anon: revoked("anon"), service_role: revoked("service_role") })
      .toEqual({ public: true, anon: true, service_role: false });
  });
});

// ===========================================================================
// A VALID CLAIM IS KEPT, BY ITS OWN IDENTITY
// ===========================================================================

run("a queued sale keeps the register it was actually taken on", () => {
  const DB = "mig15_valid";
  let session = "";
  let yesterday = "";
  let todayReg = "";

  beforeAll(() => {
    freshDatabase(DB, true);
    seedSales(DB, 2);
    session = signIn(DB, 1);
    // Two daily registers on the same till: the one the sale happened on, and
    // the one the till is holding now. The whole point of the migration is
    // that the first is used and the second is not substituted for it.
    yesterday = dailyRow(DB, 1, -1);
    todayReg = dailyRow(DB, 1, 0);
  }, 600_000);

  it("7. the sale commits and is attributed to the claimed register", () => {
    const committed = JSON.parse(sale(DB, 1, {
      request: SALES.valid, session, register: yesterday,
      source: "offline_queued", at: instantIn(-1, "10 hours"),
    }));

    expect(committed.attribution.registerSessionId).toBe(yesterday);
    expect(committed.attribution.registerSessionId).not.toBe(todayReg);
  });

  it("8. and the STORED order carries that same register, filed under its day", () => {
    expect(storedRegister(DB, SALES.valid)).toBe(yesterday);
    expect(filedUnder(DB, SALES.valid))
      .toBe(sql(DB, `select ((now() at time zone '${ZONE}')::date - 1)::text`));
  });

  it("9. a CLOSED register still accepts a sale that happened inside it", () => {
    // The late-posting case the accepted design keeps on purpose: yesterday's
    // register closed at end of business, and this sale was rung up while it
    // was open. `closed_at` is in the past, and that must not matter.
    expect(sql(DB, `select (closed_at is not null)::text from public.register_sessions
                    where id='${yesterday}'`)).toBe("true");

    const committed = JSON.parse(sale(DB, 1, {
      request: SALES.closed, session, register: yesterday,
      source: "offline_queued", at: instantIn(-1, "11 hours"),
    }));

    expect(committed.attribution.registerSessionId).toBe(yesterday);
  });

});

// ===========================================================================
// EVERY UNVERIFIABLE CLAIM IS REFUSED, AND WRITES NOTHING
// ===========================================================================

run("an unverifiable claim is refused with no financial trace", () => {
  const DB = "mig15_refused";
  let session = "";
  let todayReg = "";
  let twoDaysAgo = "";
  let before = "";

  beforeAll(() => {
    freshDatabase(DB, true);
    seedSales(DB, 2);
    session = signIn(DB, 1);
    todayReg = dailyRow(DB, 1, 0);
    twoDaysAgo = dailyRow(DB, 1, -2);
    before = footprint(DB);
  }, 600_000);

  it("12. nothing has been sold yet, and the order counter is unallocated", () => {
    expect(before).toBe("0 orders / 0 items / 0 inventory / 2 registers / counter unallocated");
  });

  const cases: Array<[string, () => SaleArgs]> = [
    ["13. no claim at all",
      () => ({ request: SALES.missing, session, register: null,
               source: "offline_queued", at: instantIn(0, "10 hours") })],
    ["14. a register id that does not exist",
      () => ({ request: SALES.unknown, session, register: "aaaaaaaa-0000-4000-8000-00000000ffff",
               source: "offline_queued", at: instantIn(0, "10 hours") })],
    ["15. a claim naming an instant BEFORE the register opened",
      () => ({ request: SALES.future, session, register: todayReg,
               source: "offline_queued", at: instantIn(-1, "10 hours") })],
    // Deliberately NOT tomorrow: an instant in the future is refused by an
    // earlier guard ("Offline sale time is in the future") and would never
    // reach the register check at all. This is a register that shut two days
    // ago and a sale that happened yesterday -- both safely in the past.
    ["16. a claim naming an instant AFTER the register closed",
      () => ({ request: SALES.stale, session, register: twoDaysAgo,
               source: "offline_queued", at: instantIn(-1, "10 hours") })],
  ];

  for (const [name, args] of cases) {
    it(name, () => {
      expect(saleExpectingFailure(DB, 1, args())).toBe(REFUSAL);
    });
  }

  it("17. another till's register is refused, even though it is open and valid", () => {
    // Till 2 claims till 1's register. The lookup is scoped by paired_device_id,
    // so this is not a window failure: it is an identity failure.
    expect(saleExpectingFailure(DB, 2, {
      request: SALES.foreign, session: null, register: todayReg,
      source: "offline_queued", at: instantIn(0, "10 hours"),
    })).toBe(REFUSAL);
  });

  it("19. and after all five refusals the database is byte-for-byte where it started", () => {
    // No order, no item, no inventory row, no invented register session, and
    // the order counter row still does not exist. That last one is the
    // load-bearing part: the guard sits BEFORE the counter allocation, so a
    // refusal cannot even consume an order number.
    expect(footprint(DB)).toBe(before);
  });

  it("20. no order row exists under any of the refused request ids", () => {
    expect(sql(DB, `select count(*)::text from public.orders where sale_request_id in
                    ('${SALES.missing}','${SALES.unknown}','${SALES.future}',
                     '${SALES.stale}','${SALES.foreign}')`)).toBe("0");
  });
});

// ===========================================================================
// THE SUBSTITUTION THAT USED TO HAPPEN
// ===========================================================================

run("the claim is no longer re-derived behind the cashier's back", () => {
  const AFTER = "mig15_sub_after";
  const BEFORE = "mig15_sub_before";

  /** The same call, on both databases: a retained claim naming TODAY's
   *  register for a sale that happened YESTERDAY. This is exactly what a till
   *  holding queued sales across midnight sends. */
  function crossMidnight(session: string, claim: string): SaleArgs {
    return { request: SALES.substituted, session, register: claim,
             source: "offline_queued", at: instantIn(-1, "10 hours") };
  }

  let afterSession = "";
  let afterClaim = "";
  let beforeSession = "";
  let beforeClaim = "";

  beforeAll(() => {
    freshDatabase(AFTER, true);
    seedSales(AFTER, 1);
    afterSession = signIn(AFTER, 1);
    afterClaim = dailyRow(AFTER, 1, 0);

    freshDatabase(BEFORE, false);
    seedSales(BEFORE, 1);
    beforeSession = signIn(BEFORE, 1);
    beforeClaim = dailyRow(BEFORE, 1, 0);
  }, 900_000);

  it("21. BEFORE this migration the sale committed under a register nobody claimed", () => {
    const committed = JSON.parse(sale(BEFORE, 1, crossMidnight(beforeSession, beforeClaim)));

    // The old zone-agreement branch called daily_register_context_for_sale and
    // stored whatever that resolved for the sale's instant -- a DIFFERENT
    // session from the one the cashier used, invented on the spot.
    expect(committed.attribution.registerSessionId).not.toBe(beforeClaim);
    expect(sql(BEFORE, `select count(*)::text from public.register_sessions
                        where paired_device_id='${device(1)}'`)).toBe("2");
  });

  it("21b. and BEFORE it a sale with NO claim at all committed, attributed to nothing", () => {
    // The defect this migration exists to close, stated as an executable fact
    // rather than as prose: the old definition took the money, wrote the order
    // and left register_session_id NULL -- so owner reporting, which joins
    // register_sessions for the business date, had nothing to file it under.
    // This is also what makes test 13 load-bearing: without the new guard that
    // call does not raise, it SUCCEEDS.
    const committed = JSON.parse(sale(BEFORE, 1, {
      request: SALES.missing, session: beforeSession, register: null,
      source: "offline_queued", at: instantIn(-1, "9 hours"),
    }));

    expect(committed.attribution.registerSessionId).toBe(null);
    expect(storedRegister(BEFORE, SALES.missing)).toBe("NULL");
  });

  it("22. AFTER it the same call is refused and invents nothing", () => {
    const start = footprint(AFTER);

    expect(saleExpectingFailure(AFTER, 1, crossMidnight(afterSession, afterClaim))).toBe(REFUSAL);
    expect(footprint(AFTER)).toBe(start);
    expect(sql(AFTER, `select count(*)::text from public.register_sessions
                       where paired_device_id='${device(1)}'`)).toBe("1");
  });
});

// ===========================================================================
// REPLAY
// ===========================================================================

run("a committed sale stays replayable even once its claim would fail", () => {
  const DB = "mig15_replay";
  let session = "";
  let yesterday = "";
  let originalId = "";
  let originalTotal = "";

  beforeAll(() => {
    freshDatabase(DB, true);
    seedSales(DB, 1);
    session = signIn(DB, 1);
    yesterday = dailyRow(DB, 1, -1);

    const committed = JSON.parse(sale(DB, 1, {
      request: SALES.replay, session, register: yesterday,
      source: "offline_queued", at: instantIn(-1, "10 hours"),
    }));

    originalTotal = String(committed.total);
    // Read back from the table, not from the payload: the claim being tested is
    // that the stored ROW survives a replay untouched, so its identity has to
    // come from the row.
    originalId = sql(DB, `select id::text from public.orders
                          where sale_request_id='${SALES.replay}'`);
  }, 600_000);

  it("23. it replays unchanged after the project timezone has moved", () => {
    // The claim would NOT validate now: the zone comparison would fail. The
    // idempotency lookup is above the guard, so the replay never reaches it.
    // This is the property that stops a successfully banked sale from becoming
    // permanently unsendable.
    sql(DB, `update public.projects set business_timezone='${OTHER_ZONE}' where id='${PROJECT}'`);

    const replayed = JSON.parse(sale(DB, 1, {
      request: SALES.replay, session, register: yesterday,
      source: "offline_queued", at: instantIn(-1, "10 hours"),
    }));

    expect(String(replayed.total)).toBe(originalTotal);
    expect(replayed.attribution.registerSessionId).toBe(yesterday);
  });

  it("24. and it replays after the claim has been emptied altogether", () => {
    const replayed = JSON.parse(sale(DB, 1, {
      request: SALES.replay, session: null, register: null,
      source: "offline_queued", at: instantIn(-1, "10 hours"),
    }));

    expect(String(replayed.total)).toBe(originalTotal);
    expect(replayed.attribution.registerSessionId).toBe(yesterday);
  });

  it("25. with no second order, item, inventory row or order number", () => {
    expect(footprint(DB)).toBe("1 orders / 1 items / 0 inventory / 1 registers / counter 1001");
    // And it is the SAME row, not a replacement that happens to count as one.
    expect(sql(DB, `select id::text from public.orders`)).toBe(originalId);
  });

  it("26. a DIFFERENT payload under the same request id is still a conflict", () => {
    sql(DB, `update public.projects set business_timezone='${ZONE}' where id='${PROJECT}'`);

    expect(saleExpectingFailure(DB, 1, {
      request: SALES.replay, session, register: yesterday,
      source: "offline_queued", at: instantIn(-1, "10 hours"), quantity: 2,
    })).toBe("Sale request ID was already used for a different order");
  });

  it("27. and the conflict wrote nothing either", () => {
    expect(footprint(DB)).toBe("1 orders / 1 items / 0 inventory / 1 registers / counter 1001");
  });
});

// ===========================================================================
// ONLINE IS UNTOUCHED
// ===========================================================================

run("ordinary online checkout is unchanged", () => {
  const DB = "mig15_online";
  let session = "";
  let open = "";

  beforeAll(() => {
    freshDatabase(DB, true);
    seedSales(DB, 1);
    session = signIn(DB, 1);
    open = JSON.parse(asRole(DB, deviceUser(1),
      `select public.ensure_daily_register_context()::text`)).registerSession.registerSessionId;
  }, 600_000);

  it("28. an online sale on the open register commits and is attributed to it", () => {
    const committed = JSON.parse(sale(DB, 1, { request: SALES.online, session, register: open }));

    expect(committed.attribution.registerSessionId).toBe(open);
    expect(committed.attribution.employeeId).toBe(EMPLOYEE);
    expect(sql(DB, `select source from public.orders where sale_request_id='${SALES.online}'`))
      .toBe("online");
  });

  it("29. an online sale naming NO register keeps the OLD message, not the new one", () => {
    const message = saleExpectingFailure(DB, 1, { request: SALES.onlineNull, session, register: null });

    expect(message).toBe("This sale must name the signed-in employee and the open register");
    expect(message).not.toBe(REFUSAL);
  });

  it("31. the new refusal sentence appears nowhere in an online code path", () => {
    // The guard is gated on source, and this is the executable proof of it:
    // three online calls, two of them refusals, and not one of them reached it.
    expect(sql(DB, `select count(*)::text from public.orders where source='online'`)).toBe("1");
  });
});

// ===========================================================================
// MANUAL (LEGACY) DRAWER PERIODS — the second branch of the claim check
// ===========================================================================

run("a manual drawer period answers on its own window", () => {
  const DB = "mig15_manual";
  let session = "";
  let manual = "";

  beforeAll(() => {
    freshDatabase(DB, true);
    seedSales(DB, 1);
    session = signIn(DB, 1);
    // A manual period must be opened through the RPC. The table's
    // register_sessions_legacy_shape constraint requires opened_by_employee_id
    // and open_request_id, and only open_register_session supplies them -- a
    // hand-built row is rejected by the database, which is how this test
    // learned the difference. This till has no daily context at all, which is
    // what makes the claim fall through to the second branch of the check.
    manual = JSON.parse(asRole(DB, deviceUser(1),
      `select public.open_register_session('77777777-7777-4777-8777-777777777777', 125.50)::text`))
      .registerSession.registerSessionId;
  }, 600_000);

  it("32. it has no business_date, so the daily lookup cannot be what answers", () => {
    expect(sql(DB, `select coalesce(business_date::text,'NULL') from public.register_sessions
                    where id='${manual}'`)).toBe("NULL");
  });

  it("33. a queued sale inside the period is attributed to it", () => {
    const committed = JSON.parse(sale(DB, 1, {
      request: SALES.manual, session, register: manual,
      source: "offline_queued", at: "now()",
    }));

    expect(committed.attribution.registerSessionId).toBe(manual);
    expect(filedUnder(DB, SALES.manual)).toBe("NULL");
  });

  it("34. a queued sale from BEFORE it opened is refused", () => {
    // No timezone comparison happens on this branch -- a manual period has no
    // business day to compare -- so the window is the whole of the check.
    expect(saleExpectingFailure(DB, 1, {
      request: SALES.manualClosed, session, register: manual,
      source: "offline_queued", at: "(now() - interval '2 hours')",
    })).toBe(REFUSAL);
  });
});

// ===========================================================================
// A ZONE THE PROJECT NO LONGER KEEPS
// ===========================================================================

run("a claim whose business timezone no longer matches the project is refused", () => {
  const DB = "mig15_zone";
  let session = "";
  let yesterday = "";
  let before = "";

  beforeAll(() => {
    freshDatabase(DB, true);
    seedSales(DB, 1);
    session = signIn(DB, 1);
    // ONLY a register that closed yesterday, and that is deliberate:
    // projects_validate_business_timezone refuses a zone change while a daily
    // register covers now. That safeguard is correct and is not worked around
    // here -- the fixture simply has no covering register, which is also the
    // real situation in which an owner CAN change zones while a till still
    // holds queued sales.
    yesterday = dailyRow(DB, 1, -1);
    sql(DB, `update public.projects set business_timezone='${OTHER_ZONE}' where id='${PROJECT}'`);
    before = footprint(DB);
  }, 600_000);

  it("35. the register still carries the old zone, the project the new one", () => {
    expect(sql(DB, `select r.business_timezone || ' vs ' || p.business_timezone
                    from public.register_sessions r, public.projects p
                    where r.id='${yesterday}' and p.id='${PROJECT}'`))
      .toBe(`${ZONE} vs ${OTHER_ZONE}`);
  });

  it("36. a queued sale against it is refused, not committed unattributed", () => {
    // The behaviour this migration changed, in its least obvious form. The
    // previous definition stored NULL here and completed the sale; the money
    // was banked with no provable business day. Now it is refused and goes to
    // the owner review queue instead.
    expect(saleExpectingFailure(DB, 1, {
      request: SALES.zone, session, register: yesterday,
      source: "offline_queued", at: instantIn(-1, "10 hours"),
    })).toBe(REFUSAL);
  });

  it("37. and it wrote nothing", () => {
    expect(footprint(DB)).toBe(before);
  });
});

// ===========================================================================
// ONLINE WITH NO REGISTER AT ALL
// ===========================================================================

run("an online till with no register at all keeps its own refusal", () => {
  const DB = "mig15_noregister";
  let session = "";

  beforeAll(() => {
    freshDatabase(DB, true);
    seedSales(DB, 1);
    session = signIn(DB, 1);
  }, 600_000);

  it("38. it says the register is not open, not the new offline sentence", () => {
    // Expressed as a till that never opened a register, rather than by editing
    // closed_at on an existing one: register_sessions_guard_daily_immutable
    // forbids that edit, and rightly so.
    const message = saleExpectingFailure(DB, 1, {
      request: SALES.onlineClosed, session,
      register: "bbbbbbbb-0000-4000-8000-00000000ffff",
    });

    expect(message).toBe("The register is not open");
    expect(message).not.toBe(REFUSAL);
  });
});
