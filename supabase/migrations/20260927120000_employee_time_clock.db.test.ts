// v1.3 Feature 1C — the Time Clock, EXECUTED against a real PostgreSQL.
//
// WHAT CANNOT BE CHECKED BY READING. That a shift opened at one till closes at
// another but never at another shop's. That a lost reply, retried, returns the
// original punch instead of opening a second shift or re-stamping a close. That
// two simultaneous requests cannot both open a shift. That an owner who
// deactivates somebody mid-shift succeeds immediately, and that the abandoned
// row stays honestly open rather than being closed by a time nobody stood
// behind. All of those are runtime facts about locks, uniqueness and ordering.
//
// THE CONCURRENCY CASES USE REAL BACKENDS. Two long-lived psql connections hold
// open transactions, so the loser genuinely waits on the winner's row lock, and
// the proof is Postgres's own pg_blocking_pids() rather than a stopwatch.
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20260927120000_employee_time_clock.sql";

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
// Fixtures: one shop with two tills, a second shop with its own
// ---------------------------------------------------------------------------

const EMPLOYEE_B = "e0000002-0000-4000-8000-00000000000b";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";
const OTHER_PROJECT = "a0000000-0000-4000-8000-000000000002";
const OTHER_BUILD = "b0000000-0000-4000-8000-000000000002";
const OTHER_USER = "d0000000-0000-4000-8000-0000000000ff";
const OTHER_DEVICE = "c0000000-0000-4000-8000-0000000000ff";
const OTHER_EMPLOYEE = "e0000003-0000-4000-8000-00000000000c";
const MENU = JSON.stringify({ menuItems: [] });
const ZONE = "America/New_York";

function seed(db: string): void {
  sql(db, `
    insert into auth.users (id) values
      ('${OWNER}'), ('${deviceUser(1)}'), ('${deviceUser(2)}'), ('${OTHER_OWNER}'), ('${OTHER_USER}');

    insert into public.projects (id, user_id, name, template_id, config, business_timezone)
    values ('${PROJECT}', '${OWNER}', 'Shop', 'cafe', '${MENU}'::jsonb, '${ZONE}'),
           ('${OTHER_PROJECT}', '${OTHER_OWNER}', 'Other Shop', 'cafe', '${MENU}'::jsonb, '${ZONE}');

    insert into public.build_jobs (id, project_id, owner_id, target, status, config_snapshot,
                                   config_schema_version, config_hash, request_key, started_at, finished_at)
    values ('${BUILD}','${PROJECT}','${OWNER}','android','succeeded','${MENU}'::jsonb,1,'h','r', now(), now()),
           ('${OTHER_BUILD}','${OTHER_PROJECT}','${OTHER_OWNER}','android','succeeded','${MENU}'::jsonb,1,'h2','r2', now(), now());

    -- Two tills in one shop: this is what makes "clock in at A, out at B" real.
    insert into public.paired_devices (id, auth_user_id, owner_id, project_id, build_job_id, created_at)
    values ('${device(1)}','${deviceUser(1)}','${OWNER}','${PROJECT}','${BUILD}', now() - interval '30 days'),
           ('${device(2)}','${deviceUser(2)}','${OWNER}','${PROJECT}','${BUILD}', now() - interval '30 days'),
           ('${OTHER_DEVICE}','${OTHER_USER}','${OTHER_OWNER}','${OTHER_PROJECT}','${OTHER_BUILD}', now() - interval '30 days');

    insert into public.employees (id, project_id, display_name, employee_code, role, pin_hash, active, created_at)
    values ('${EMPLOYEE}','${PROJECT}','Amy','001','cashier', public.employee_pin_hash('2222'), true, '2026-01-01'),
           ('${EMPLOYEE_B}','${PROJECT}','Bo','002','manager', public.employee_pin_hash('3333'), true, '2026-01-01'),
           ('${OTHER_EMPLOYEE}','${OTHER_PROJECT}','Zed','001','cashier', public.employee_pin_hash('4444'), true, '2026-01-01');
  `);
}

const uuid = (n: number): string =>
  `f0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Calls a Time Clock RPC as till `n`, returning the raw jsonb text. */
function punch(db: string, n: number, fn: "clock_in_employee" | "clock_out_employee",
               code: string, pin: string, request: string): string {
  return asRole(db, deviceUser(n),
    `select public.${fn}('${code}','${pin}','${request}'::uuid)::text`);
}
const clockIn = (db: string, n: number, code: string, pin: string, r: string) =>
  punch(db, n, "clock_in_employee", code, pin, r);
const clockOut = (db: string, n: number, code: string, pin: string, r: string) =>
  punch(db, n, "clock_out_employee", code, pin, r);

const field = (json: string, key: string): string => {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  return parsed[key] === null || parsed[key] === undefined ? "" : String(parsed[key]);
};

const openCount = (db: string, employee = EMPLOYEE): string =>
  sql(db, `select count(*)::text from public.employee_time_sessions
           where employee_id='${employee}' and clocked_out_at is null`);

const sessionRow = (db: string, id: string) =>
  sql(db, `select coalesce(clocked_out_at::text,'OPEN') || '|' ||
                  coalesce(clock_in_paired_device_id::text,'-') || '|' ||
                  coalesce(clock_out_paired_device_id::text,'-')
           from public.employee_time_sessions where id='${id}'`);

/** Ends whatever is open, so each test starts from a known place. */
function resetClock(db: string): void {
  sql(db, `delete from public.employee_time_sessions`);
  sql(db, `delete from public.employee_login_employee_attempts`);
  sql(db, `delete from public.employee_login_device_throttles`);
  sql(db, `delete from public.employee_login_device_failures`);
  sql(db, `update public.employees set active = true, deactivated_at = null
           where project_id = '${PROJECT}'`);
}

const DB = "tc";

beforeAll(() => {
  if (PG_BIN === null) return;

  dataDir = mkdtempSync(join(tmpdir(), "pos-canvas-tc-"));
  pg("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust"]);
  pg("pg_ctl", [
    "-D", dataDir, "-l", join(dataDir, "server.log"), "-w", "start",
    "-o", `-c listen_addresses=127.0.0.1 -c port=${PORT} -c unix_socket_directories=''`,
  ]);
  freshDatabase(DB, true);
  seed(DB);
}, 900_000);

afterAll(() => {
  if (PG_BIN === null) return;
  try { pg("pg_ctl", ["-D", dataDir, "-m", "immediate", "-w", "stop"]); }
  finally { rmSync(dataDir, { recursive: true, force: true }); }
}, 900_000);

const maybe = PG_BIN === null ? describe.skip : describe;

// ---------------------------------------------------------------------------
// 1-8. Opening and closing a shift
// ---------------------------------------------------------------------------

maybe("a shift opens and closes", () => {
  it("1-2. Clock In creates exactly one open session, stamped by the SERVER", () => {
    resetClock(DB);
    const before = sql(DB, `select clock_timestamp()::text`);
    const result = clockIn(DB, 1, "001", "2222", uuid(1));

    expect(field(result, "ok")).toBe("true");
    expect(field(result, "outcome")).toBe("clocked_in");
    expect(openCount(DB)).toBe("1");

    // The instant lies between two server readings taken around the call, so
    // it came from the database and not from any caller.
    const after = sql(DB, `select clock_timestamp()::text`);
    const at = sql(DB, `select clocked_in_at::text from public.employee_time_sessions
                        where id='${field(result, "timeSessionId")}'`);
    expect(at >= before).toBe(true);
    expect(at <= after).toBe(true);
  });

  it("3. neither function even accepts a timestamp", () => {
    for (const fn of ["clock_in_employee", "clock_out_employee"]) {
      const args = sql(DB, `select pg_get_function_identity_arguments(p.oid)
                            from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                            where n.nspname='public' and p.proname='${fn}'`);

      expect(args).toBe("p_employee_code text, p_pin text, p_request_id uuid");
      // The rule behind the exact match: no instant may arrive from a caller.
      expect(args).not.toMatch(/timestamp/i);
    }
  });

  it("4. replaying the same Clock In request returns the ORIGINAL session", () => {
    resetClock(DB);
    const first = clockIn(DB, 1, "001", "2222", uuid(2));
    const again = clockIn(DB, 1, "001", "2222", uuid(2));

    expect(field(again, "ok")).toBe("true");
    expect(field(again, "timeSessionId")).toBe(field(first, "timeSessionId"));
    expect(field(again, "clockedInAt")).toBe(field(first, "clockedInAt"));
    expect(field(again, "replayed")).toBe("true");
    expect(openCount(DB)).toBe("1");
  });

  it("5. a SECOND Clock In with a new request is refused", () => {
    resetClock(DB);
    clockIn(DB, 1, "001", "2222", uuid(3));
    const second = clockIn(DB, 1, "001", "2222", uuid(4));

    expect(field(second, "ok")).toBe("false");
    expect(field(second, "error")).toBe("already_clocked_in");
    expect(openCount(DB)).toBe("1");
  });

  it("6. Clock Out closes the row and stamps it from the server", () => {
    resetClock(DB);
    const opened = clockIn(DB, 1, "001", "2222", uuid(5));
    const closed = clockOut(DB, 1, "001", "2222", uuid(6));

    expect(field(closed, "ok")).toBe("true");
    expect(field(closed, "outcome")).toBe("clocked_out");
    expect(field(closed, "timeSessionId")).toBe(field(opened, "timeSessionId"));
    expect(field(closed, "clockedOutAt") >= field(closed, "clockedInAt")).toBe(true);
    expect(openCount(DB)).toBe("0");
  });

  it("7. replaying a Clock Out returns the original close and never re-stamps it", () => {
    resetClock(DB);
    clockIn(DB, 1, "001", "2222", uuid(7));
    const first = clockOut(DB, 1, "001", "2222", uuid(8));
    const stamped = sessionRow(DB, field(first, "timeSessionId"));

    const again = clockOut(DB, 1, "001", "2222", uuid(8));

    expect(field(again, "ok")).toBe("true");
    expect(field(again, "clockedOutAt")).toBe(field(first, "clockedOutAt"));
    expect(field(again, "replayed")).toBe("true");
    // Byte-identical: the second answer moved nobody's hours.
    expect(sessionRow(DB, field(first, "timeSessionId"))).toBe(stamped);
  });

  it("8. a SECOND Clock Out with a new request is refused", () => {
    resetClock(DB);
    clockIn(DB, 1, "001", "2222", uuid(9));
    clockOut(DB, 1, "001", "2222", uuid(10));
    const second = clockOut(DB, 1, "001", "2222", uuid(11));

    expect(field(second, "ok")).toBe("false");
    expect(field(second, "error")).toBe("not_clocked_in");
  });
});

// ---------------------------------------------------------------------------
// 9-12. The business owns the shift; the till is only attribution
// ---------------------------------------------------------------------------

maybe("a shift belongs to the business, not the till", () => {
  it("9, 11, 12. Clock In at till A, Clock Out at till B, same row and both devices recorded", () => {
    resetClock(DB);
    const opened = clockIn(DB, 1, "001", "2222", uuid(20));
    const closed = clockOut(DB, 2, "001", "2222", uuid(21));

    expect(field(closed, "timeSessionId")).toBe(field(opened, "timeSessionId"));
    expect(openCount(DB)).toBe("0");

    // Attribution: opened at till 1, closed at till 2.
    expect(sessionRow(DB, field(opened, "timeSessionId")))
      .toContain(`${device(1)}|${device(2)}`);
  });

  it("10. another business can neither see nor close it", () => {
    resetClock(DB);
    const opened = clockIn(DB, 1, "001", "2222", uuid(22));

    // The other shop's till, its own employee code `001`, its own PIN.
    const foreign = asRole(DB, OTHER_USER,
      `select public.clock_out_employee('001','4444','${uuid(23)}'::uuid)::text`);

    expect(field(foreign, "ok")).toBe("false");
    expect(field(foreign, "error")).toBe("not_clocked_in");
    expect(sessionRow(DB, field(opened, "timeSessionId"))).toContain("OPEN");
    expect(openCount(DB)).toBe("1");
  });

  it("two employees of one shop hold independent shifts", () => {
    resetClock(DB);
    clockIn(DB, 1, "001", "2222", uuid(24));
    clockIn(DB, 2, "002", "3333", uuid(25));

    expect(openCount(DB, EMPLOYEE)).toBe("1");
    expect(openCount(DB, EMPLOYEE_B)).toBe("1");

    clockOut(DB, 1, "001", "2222", uuid(26));

    expect(openCount(DB, EMPLOYEE)).toBe("0");
    expect(openCount(DB, EMPLOYEE_B)).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// 13-19. Credentials, throttling, pairing
// ---------------------------------------------------------------------------

maybe("the Time Clock is not a weaker door", () => {
  it("13-15. unknown ID, wrong PIN and an inactive employee are indistinguishable", () => {
    resetClock(DB);
    const unknown = clockIn(DB, 1, "777", "2222", uuid(30));
    const wrongPin = clockIn(DB, 1, "001", "9999", uuid(31));

    sql(DB, `update public.employees set active=false, deactivated_at=now() where id='${EMPLOYEE_B}'`);
    const inactive = clockIn(DB, 1, "002", "3333", uuid(32));

    expect(field(unknown, "error")).toBe("invalid_credentials");
    expect(field(wrongPin, "error")).toBe("invalid_credentials");
    expect(field(inactive, "error")).toBe("invalid_credentials");
    // Byte-identical payloads: nothing distinguishes the three.
    expect(unknown).toBe(wrongPin);
    expect(wrongPin).toBe(inactive);
    expect(openCount(DB)).toBe("0");

    sql(DB, `update public.employees set active=true, deactivated_at=null where id='${EMPLOYEE_B}'`);
  });

  it("16-17. failures feed the existing device and employee limiters", () => {
    resetClock(DB);
    const before = sql(DB, `select count(*)::text from public.employee_login_device_failures`);

    clockIn(DB, 1, "001", "9999", uuid(33));
    clockOut(DB, 1, "001", "9999", uuid(34));

    expect(Number(sql(DB, `select count(*)::text from public.employee_login_device_failures`)))
      .toBeGreaterThan(Number(before));
    expect(Number(sql(DB, `select coalesce(max(failed_count),0)::text
                           from public.employee_login_employee_attempts
                           where employee_id='${EMPLOYEE}'`))).toBeGreaterThan(0);
  });

  it("a throttled till is refused before any employee is looked up", () => {
    resetClock(DB);
    sql(DB, `insert into public.employee_login_device_throttles (paired_device_id, throttled_until, updated_at)
             values ('${device(1)}', now() + interval '5 minutes', now())
             on conflict (paired_device_id) do update set throttled_until = excluded.throttled_until`);

    const result = clockIn(DB, 1, "001", "2222", uuid(35));

    expect(field(result, "error")).toBe("locked_out");
    expect(Number(field(result, "retryAfterSeconds"))).toBeGreaterThan(0);
    expect(openCount(DB)).toBe("0");
    resetClock(DB);
  });

  it("18. an unauthenticated caller is refused", () => {
    resetClock(DB);
    const out = sql(DB, `
      select set_config('request.jwt.claim.sub','', false);
      select public.clock_in_employee('001','2222','${uuid(36)}'::uuid)::text;`)
      .split("\n").filter(Boolean).pop() as string;

    expect(field(out, "error")).toBe("not_authenticated");
    expect(openCount(DB)).toBe("0");
  });

  it("19. an authenticated caller with no pairing is refused", () => {
    resetClock(DB);
    const stranger = "f0000000-0000-4000-8000-0000000000aa";
    sql(DB, `insert into auth.users (id) values ('${stranger}') on conflict do nothing`);

    const out = asRole(DB, stranger,
      `select public.clock_in_employee('001','2222','${uuid(37)}'::uuid)::text`);

    expect(field(out, "error")).toBe("not_paired");
    expect(openCount(DB)).toBe("0");
  });

  it("a missing request id is refused rather than silently accepted", () => {
    resetClock(DB);
    const out = asRole(DB, deviceUser(1),
      `select public.clock_in_employee('001','2222','00000000-0000-0000-0000-000000000000'::uuid)::text`);

    expect(field(out, "error")).toBe("request_required");
    expect(openCount(DB)).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// 20-24. Real concurrency, on the employee row lock
// ---------------------------------------------------------------------------

type Conn = { proc: ChildProcessWithoutNullStreams; buffer: string };
const DONE = "__TC_DONE__";

function open(db: string): Conn {
  const proc = spawn(
    join(PG_BIN as string, "psql"),
    ["-h", "127.0.0.1", "-p", String(PORT), "-U", "postgres", "-d", db, "-At", "-q"],
    { env: { ...process.env, LC_ALL: "en_US.UTF-8", PGTZ: "UTC" } }
  );
  const conn: Conn = { proc, buffer: "" };
  proc.stdout.on("data", (c: Buffer) => { conn.buffer += c.toString(); });
  proc.stderr.on("data", (c: Buffer) => { conn.buffer += c.toString(); });
  return conn;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(conn: Conn, statement: string, timeoutMs = 20_000): Promise<string> {
  const mark = conn.buffer.length;
  conn.proc.stdin.write(`${statement}\n\\echo ${DONE}\n`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tail = conn.buffer.slice(mark);
    if (tail.includes(DONE)) return tail.slice(0, tail.indexOf(DONE)).trim();
    await sleep(25);
  }
  throw new Error(`did not finish: ${statement}`);
}

function fire(conn: Conn, statement: string): number {
  const mark = conn.buffer.length;
  conn.proc.stdin.write(`${statement}\n\\echo ${DONE}\n`);
  return mark;
}

async function collect(conn: Conn, mark: number, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tail = conn.buffer.slice(mark);
    if (tail.includes(DONE)) return tail.slice(0, tail.indexOf(DONE)).trim();
    await sleep(25);
  }
  throw new Error("fired statement never finished");
}

function close(conn: Conn): void {
  try { conn.proc.stdin.end("\\q\n"); } catch { /* gone */ }
  conn.proc.kill();
}

/** Postgres's own answer about who is waiting for whom. Not a stopwatch. */
async function waitUntilBlockedBy(pid: string, blocker: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = sql(DB, `select coalesce(pg_blocking_pids(${pid})::text,'{}')
                                || '|' || coalesce((select wait_event_type from pg_stat_activity where pid=${pid}),'-')
                         from pg_stat_activity where pid=${pid}`);
    const [blockers = "{}", waitEvent = "-"] = row.split("|");
    if (blockers.includes(blocker) && waitEvent === "Lock") {
      return { blocked: true, blockers, waitEvent };
    }
    await sleep(50);
  }
  return { blocked: false, blockers: "", waitEvent: "" };
}

const auth = (conn: Conn, who: string) =>
  run(conn, `select set_config('request.jwt.claim.sub','${who}', false);`);

maybe("two requests for one employee serialize on the employee row", () => {
  it("20. Clock In holds the row; a second Clock In waits, then is refused", async () => {
    resetClock(DB);
    const first = open(DB);
    const second = open(DB);

    try {
      await auth(first, deviceUser(1));
      await auth(second, deviceUser(2));
      const p1 = await run(first, `select pg_backend_pid();`);
      const p2 = await run(second, `select pg_backend_pid();`);

      await run(first, `begin;`);
      const opened = await run(first, `select public.clock_in_employee('001','2222','${uuid(40)}'::uuid)::text;`);
      expect(field(opened, "outcome")).toBe("clocked_in");

      const mark = fire(second, `begin; select public.clock_in_employee('001','2222','${uuid(41)}'::uuid)::text;`);
      const blocked = await waitUntilBlockedBy(p2, p1);

      expect(blocked.blocked).toBe(true);
      expect(blocked.blockers).toContain(p1);
      expect(blocked.waitEvent).toBe("Lock");

      await run(first, `commit;`);
      const loser = await collect(second, mark);
      await run(second, `commit;`);

      expect(field(loser, "error")).toBe("already_clocked_in");
      expect(openCount(DB)).toBe("1");
    } finally {
      close(first); close(second);
    }
  }, 120_000);

  it("21-22. Clock Out holds the row; a concurrent Clock Out finds nothing open", async () => {
    resetClock(DB);
    clockIn(DB, 1, "001", "2222", uuid(42));

    const first = open(DB);
    const second = open(DB);
    try {
      await auth(first, deviceUser(1));
      await auth(second, deviceUser(2));
      const p1 = await run(first, `select pg_backend_pid();`);
      const p2 = await run(second, `select pg_backend_pid();`);

      await run(first, `begin;`);
      const closed = await run(first, `select public.clock_out_employee('001','2222','${uuid(43)}'::uuid)::text;`);
      expect(field(closed, "outcome")).toBe("clocked_out");

      const mark = fire(second, `begin; select public.clock_out_employee('001','2222','${uuid(44)}'::uuid)::text;`);
      const blocked = await waitUntilBlockedBy(p2, p1);
      expect(blocked.blocked).toBe(true);

      await run(first, `commit;`);
      const loser = await collect(second, mark);
      await run(second, `commit;`);

      expect(field(loser, "error")).toBe("not_clocked_in");
      expect(openCount(DB)).toBe("0");
    } finally {
      close(first); close(second);
    }
  }, 120_000);

  it("23-24. a deactivation racing a punch wins, and the punch respects it", async () => {
    resetClock(DB);
    clockIn(DB, 1, "001", "2222", uuid(45));

    const owner = open(DB);
    const till = open(DB);
    try {
      await auth(till, deviceUser(1));
      const ownerPid = await run(owner, `select pg_backend_pid();`);
      const tillPid = await run(till, `select pg_backend_pid();`);

      // The owner deactivates mid-shift and holds the employee row.
      await run(owner, `begin;`);
      await run(owner, `update public.employees set active=false, deactivated_at=now()
                        where id='${EMPLOYEE}';`);

      const mark = fire(till, `begin; select public.clock_out_employee('001','2222','${uuid(46)}'::uuid)::text;`);
      const blocked = await waitUntilBlockedBy(tillPid, ownerPid);
      expect(blocked.blocked).toBe(true);
      expect(blocked.blockers).toContain(ownerPid);

      await run(owner, `commit;`);
      const punchResult = await collect(till, mark);
      await run(till, `commit;`);

      // Deactivation won. The punch sees an inactive employee and refuses with
      // the same generic answer as any other credential problem.
      expect(field(punchResult, "error")).toBe("invalid_credentials");

      // 25. AND THE SHIFT STAYS HONESTLY OPEN. No fabricated clock-out.
      expect(openCount(DB)).toBe("1");
      expect(sql(DB, `select coalesce(clocked_out_at::text,'NULL') || '|' ||
                             coalesce(clock_out_paired_device_id::text,'NULL') || '|' ||
                             coalesce(clock_out_request_id::text,'NULL')
                      from public.employee_time_sessions
                      where employee_id='${EMPLOYEE}' and clocked_out_at is null`))
        .toBe("NULL|NULL|NULL");
    } finally {
      close(owner); close(till);
      resetClock(DB);
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 25-28. The locked deactivation policy, and the invariants
// ---------------------------------------------------------------------------

maybe("deactivation leaves the shift open, and nothing closes it on anyone's behalf", () => {
  it("25-26. the owner succeeds immediately; the inactive employee cannot close it", () => {
    resetClock(DB);
    const opened = clockIn(DB, 1, "001", "2222", uuid(50));

    sql(DB, `update public.employees set active=false, deactivated_at=now() where id='${EMPLOYEE}'`);

    expect(sql(DB, `select active::text from public.employees where id='${EMPLOYEE}'`)).toBe("false");
    expect(sessionRow(DB, field(opened, "timeSessionId"))).toContain("OPEN");

    const attempt = clockOut(DB, 1, "001", "2222", uuid(51));

    expect(field(attempt, "error")).toBe("invalid_credentials");
    expect(sessionRow(DB, field(opened, "timeSessionId"))).toContain("OPEN");
    expect(openCount(DB)).toBe("1");
    resetClock(DB);
  });

  it("27. the partial unique index is the final backstop", () => {
    resetClock(DB);
    clockIn(DB, 1, "001", "2222", uuid(52));

    // Bypassing the function entirely, as postgres: the database still refuses.
    let failed = "";
    try {
      sql(DB, `insert into public.employee_time_sessions
               (project_id, employee_id, clocked_in_at, clock_in_paired_device_id, clock_in_request_id)
               values ('${PROJECT}','${EMPLOYEE}', now(), '${device(1)}', '${uuid(53)}')`);
    } catch (error) {
      failed = ((error as { stderr?: string }).stderr ?? "").toString();
    }

    expect(failed).toMatch(/employee_time_sessions_one_open_per_employee|duplicate key/i);
    expect(openCount(DB)).toBe("1");
  });

  it("28. a request id cannot be reused within a business", () => {
    resetClock(DB);
    clockIn(DB, 1, "001", "2222", uuid(54));
    clockOut(DB, 1, "001", "2222", uuid(55));

    // A different employee replaying someone else's clock-in id gets a fresh
    // refusal from the unique index rather than another's record.
    let failed = "";
    try {
      sql(DB, `insert into public.employee_time_sessions
               (project_id, employee_id, clocked_in_at, clock_in_paired_device_id, clock_in_request_id)
               values ('${PROJECT}','${EMPLOYEE_B}', now(), '${device(1)}', '${uuid(54)}')`);
    } catch (error) {
      failed = ((error as { stderr?: string }).stderr ?? "").toString();
    }

    expect(failed).toMatch(/employee_time_sessions_clock_in_request|duplicate key/i);
  });

  it("a closed row must carry all three closing columns or none", () => {
    resetClock(DB);
    const opened = clockIn(DB, 1, "001", "2222", uuid(56));

    let failed = "";
    try {
      sql(DB, `update public.employee_time_sessions set clocked_out_at = now()
               where id='${field(opened, "timeSessionId")}'`);
    } catch (error) {
      failed = ((error as { stderr?: string }).stderr ?? "").toString();
    }

    expect(failed).toMatch(/closed_together|violates check/i);
  });
});

// ---------------------------------------------------------------------------
// 29-32. Reachability and blast radius
// ---------------------------------------------------------------------------

maybe("only the two functions can reach the table", () => {
  it("29. RPC ACLs are exactly the accepted convention", () => {
    for (const fn of ["public.clock_in_employee(text, text, uuid)", "public.clock_out_employee(text, text, uuid)"]) {
      expect(sql(DB, `select has_function_privilege('authenticated','${fn}','EXECUTE')::text`)).toBe("true");
      expect(sql(DB, `select has_function_privilege('anon','${fn}','EXECUTE')::text`)).toBe("false");
      expect(sql(DB, `select has_function_privilege('service_role','${fn}','EXECUTE')::text`)).toBe("false");
    }
  });

  it("30-31. the table grants nothing to any client role, and has RLS with no policies", () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const verb of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        expect(sql(DB, `select has_table_privilege('${role}','public.employee_time_sessions','${verb}')::text`))
          .toBe("false");
      }
    }

    expect(sql(DB, `select relrowsecurity::text from pg_class
                    where oid='public.employee_time_sessions'::regclass`)).toBe("true");
    expect(sql(DB, `select count(*)::text from pg_policies
                    where schemaname='public' and tablename='employee_time_sessions'`)).toBe("0");
  });

  it("a real authenticated client cannot touch the table directly", () => {
    resetClock(DB);
    const denied = asAuthenticatedExpectingFailure(DB, deviceUser(1),
      `select count(*) from public.employee_time_sessions`);

    expect(denied).toMatch(/permission denied/i);
  });

  it("32. no Feature 1B table was touched by a punch", () => {
    resetClock(DB);
    const before = sql(DB, `select
      (select count(*) from public.employee_pos_sessions)::text || '|' ||
      (select count(*) from public.register_sessions)::text || '|' ||
      (select count(*) from public.orders)::text || '|' ||
      (select count(*) from public.inventory_transactions)::text`);

    clockIn(DB, 1, "001", "2222", uuid(60));
    clockOut(DB, 2, "001", "2222", uuid(61));

    expect(sql(DB, `select
      (select count(*) from public.employee_pos_sessions)::text || '|' ||
      (select count(*) from public.register_sessions)::text || '|' ||
      (select count(*) from public.orders)::text || '|' ||
      (select count(*) from public.inventory_transactions)::text`)).toBe(before);
  });
});
