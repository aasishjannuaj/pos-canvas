// v1.3 CP3.1 — expectation-bound employee-session termination, EXECUTED.
//
// WHAT CANNOT BE CHECKED BY READING THE SQL. That a stale till naming session A
// cannot end replacement session B is a claim about locks and ordering, not
// about text. So is the claim that the old zero-argument logout is genuinely
// unreachable by a product role rather than merely unused by product code. Both
// are executed here, against a real PostgreSQL, as the real `authenticated`
// role.
//
// THE FAILURE THIS PINS. employee_logout() ends whatever session is open on the
// caller's device and takes no device lock. A till holding an expectation the
// server has already moved past therefore signs out whoever took over. CP3
// validation showed the stale till usually locks itself first, via a refused
// sale — but that is luck, and CP4's Auto-Lock is a timer with no such luck.
//
// IT CARRIES NEGATIVE CONTROLS. The migration's own function is deliberately
// broken — the expectation dropped from the UPDATE, and the device FOR UPDATE
// removed — and the tests are re-run to prove they FAIL. A test that passes
// against a broken implementation was not testing anything.
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20260926120000_employee_session_safe_termination.sql";

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
// Fixtures
// ---------------------------------------------------------------------------

const EMPLOYEE_B = "e0000002-0000-4000-8000-00000000000b";
const MENU = JSON.stringify({ menuItems: [] });
const ZONE = "America/New_York";

/** Two tills on one project, two employees. Till 2 exists to be "another device". */
function seedTills(db: string): void {
  sql(db, `
    insert into auth.users (id) values ('${OWNER}'), ('${deviceUser(1)}'), ('${deviceUser(2)}');
    insert into public.projects (id, user_id, name, template_id, config, business_timezone)
    values ('${PROJECT}', '${OWNER}', 'Shop', 'cafe', '${MENU}'::jsonb, '${ZONE}');
    insert into public.build_jobs (id, project_id, owner_id, target, status, config_snapshot,
                                   config_schema_version, config_hash, request_key, started_at, finished_at)
    values ('${BUILD}','${PROJECT}','${OWNER}','android','succeeded','${MENU}'::jsonb,1,'h','r', now(), now());
    insert into public.paired_devices (id, auth_user_id, owner_id, project_id, build_job_id, created_at)
    values ('${device(1)}','${deviceUser(1)}','${OWNER}','${PROJECT}','${BUILD}', now() - interval '30 days'),
           ('${device(2)}','${deviceUser(2)}','${OWNER}','${PROJECT}','${BUILD}', now() - interval '30 days');
    insert into public.employees (id, project_id, display_name, employee_code, role, pin_hash, active, created_at)
    values ('${EMPLOYEE}','${PROJECT}','Amy','001','cashier', public.employee_pin_hash('2222'), true, '2026-01-01'),
           ('${EMPLOYEE_B}','${PROJECT}','Bo','002','cashier', public.employee_pin_hash('3333'), true, '2026-01-01');
  `);
}

/** Signs an employee in on till `n` and returns the new POS session id. */
function signIn(db: string, n: number, code = "001", pin = "2222"): string {
  expect(asRole(db, deviceUser(n), `select public.employee_login_by_code('${code}','${pin}')->>'ok'`)).toBe("true");

  return sql(db, `select id::text from public.employee_pos_sessions
                  where paired_device_id='${device(n)}' and ended_at is null`);
}

/** Calls the new termination as till `n`, returning the raw jsonb text. */
function endSession(db: string, n: number, expected: string): string {
  return asRole(
    db,
    deviceUser(n),
    `select public.end_employee_pos_session('${expected}'::uuid)::text`
  );
}

const field = (json: string, key: string): string => {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  return parsed[key] === null || parsed[key] === undefined ? "" : String(parsed[key]);
};

const sessionRow = (db: string, id: string) =>
  sql(db, `select coalesce(ended_at::text,'OPEN') || '|' || coalesce(end_reason,'-')
           from public.employee_pos_sessions where id='${id}'`);

// ---------------------------------------------------------------------------
// Cluster lifecycle
// ---------------------------------------------------------------------------

const DB = "cp31";

beforeAll(() => {
  if (PG_BIN === null) return;

  dataDir = mkdtempSync(join(tmpdir(), "pos-canvas-cp31-"));
  pg("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust"]);
  // `-l` MATTERS. Without it the postmaster inherits pg_ctl's stdout pipe and
  // never closes it, so execFileSync waits for an EOF that cannot come and the
  // whole suite hangs before its first assertion.
  pg("pg_ctl", [
    "-D", dataDir, "-l", join(dataDir, "server.log"), "-w", "start",
    "-o", `-c listen_addresses=127.0.0.1 -c port=${PORT} -c unix_socket_directories=''`,
  ]);
  freshDatabase(DB, true);
  seedTills(DB);
}, 900_000);

afterAll(() => {
  if (PG_BIN === null) return;

  try {
    pg("pg_ctl", ["-D", dataDir, "-m", "immediate", "-w", "stop"]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 900_000);

const maybe = PG_BIN === null ? describe.skip : describe;

// ---------------------------------------------------------------------------
// 1-2. The ordinary case, and its retry
// ---------------------------------------------------------------------------

maybe("the named session is the one that ends", () => {
  it("1. ends session A and records it as a logout", () => {
    const a = signIn(DB, 1);

    const result = endSession(DB, 1, a);

    expect(field(result, "ok")).toBe("true");
    expect(field(result, "outcome")).toBe("ended");
    expect(field(result, "endedSessionId")).toBe(a);
    expect(sessionRow(DB, a)).toMatch(/^2\d{3}-.*\|logout$/);
  });

  it("2. a repeat is idempotent and writes nothing further", () => {
    const a = signIn(DB, 1);
    endSession(DB, 1, a);
    const endedAt = sessionRow(DB, a);

    const again = endSession(DB, 1, a);

    expect(field(again, "ok")).toBe("true");
    expect(field(again, "outcome")).toBe("already_ended");
    expect(field(again, "endedSessionId")).toBe("");
    // Byte-identical: no second write moved ended_at.
    expect(sessionRow(DB, a)).toBe(endedAt);
  });
});

// ---------------------------------------------------------------------------
// 3-5. The whole point: a replacement is never touched
// ---------------------------------------------------------------------------

maybe("a replacement session is never terminated", () => {
  it("3. a stale request naming A refuses, and B stays open", () => {
    const a = signIn(DB, 1);
    const b = signIn(DB, 1, "002", "3333"); // legitimate replacement

    expect(b).not.toBe(a);
    expect(sessionRow(DB, a)).toMatch(/\|switched$/);

    const result = endSession(DB, 1, a);

    expect(field(result, "ok")).toBe("false");
    expect(field(result, "error")).toBe("session_replaced");
    expect(sessionRow(DB, b)).toBe("OPEN|-");
  });

  it("4. the SAME employee signing back in is still a new session B, untouched", () => {
    const a = signIn(DB, 1);
    const b = signIn(DB, 1); // Amy again -- new session id

    expect(b).not.toBe(a);

    expect(field(endSession(DB, 1, a), "error")).toBe("session_replaced");
    expect(sessionRow(DB, b)).toBe("OPEN|-");
  });

  it("5. a different employee's session B is untouched", () => {
    const a = signIn(DB, 1);
    const b = signIn(DB, 1, "002", "3333");

    expect(field(endSession(DB, 1, a), "error")).toBe("session_replaced");
    expect(
      sql(DB, `select employee_id::text from public.employee_pos_sessions where id='${b}'`)
    ).toBe(EMPLOYEE_B);
    expect(sessionRow(DB, b)).toBe("OPEN|-");
  });
});

// ---------------------------------------------------------------------------
// 6-7. Another till's session, and an id that never existed
// ---------------------------------------------------------------------------

maybe("a session this till does not own is not even acknowledged", () => {
  it("6. another device's real session is session_not_found, and survives", () => {
    const other = signIn(DB, 2);

    const result = endSession(DB, 1, other);

    expect(field(result, "ok")).toBe("false");
    expect(field(result, "error")).toBe("session_not_found");
    expect(sessionRow(DB, other)).toBe("OPEN|-");
  });

  it("7. an unknown uuid gives the SAME answer, so this is no existence oracle", () => {
    const other = signIn(DB, 2);
    const unknown = "99999999-9999-4999-8999-999999999999";

    expect(field(endSession(DB, 1, other), "error")).toBe(
      field(endSession(DB, 1, unknown), "error")
    );
    expect(field(endSession(DB, 1, unknown), "error")).toBe("session_not_found");
  });
});

// ---------------------------------------------------------------------------
// 8-9. No caller, no device
// ---------------------------------------------------------------------------

maybe("callers without standing get nothing", () => {
  it("8. an unauthenticated caller is refused", () => {
    const a = signIn(DB, 1);
    const result = sql(DB, `
      select set_config('request.jwt.claim.sub','', false);
      select public.end_employee_pos_session('${a}'::uuid)::text;`)
      .split("\n").filter(Boolean).pop() as string;

    expect(field(result, "error")).toBe("not_authenticated");
    expect(sessionRow(DB, a)).toBe("OPEN|-");
  });

  it("9. an authenticated caller with no paired device is refused", () => {
    const a = signIn(DB, 1);
    const stranger = "f0000000-0000-4000-8000-0000000000ff";
    sql(DB, `insert into auth.users (id) values ('${stranger}') on conflict do nothing`);

    const result = asRole(
      DB,
      stranger,
      `select public.end_employee_pos_session('${a}'::uuid)::text`
    );

    expect(field(result, "error")).toBe("not_paired");
    expect(sessionRow(DB, a)).toBe("OPEN|-");
  });
});

// ---------------------------------------------------------------------------
// 10. Concurrency — the device lock is the whole argument
// ---------------------------------------------------------------------------

maybe("termination and replacement serialize through the paired-device row", () => {
  // 10a WAS a stopwatch: it held the device row from another backend and
  // inferred blocking from elapsed milliseconds. That is precisely the shape
  // that turns into a flake on a loaded laptop, and it did. The two tests at
  // the end of this file replace it with the real thing -- the actual login
  // and the actual termination, contending, with pg_blocking_pids() naming who
  // waits for whom. What remains here is the sequential classification, which
  // is deterministic and worth keeping on its own.

  it("10b. a login replacing A commits FIRST, and the stale termination then refuses", () => {
    const a = signIn(DB, 1);

    // Replacement wins the row. Termination, arriving after, must classify
    // against the committed world rather than end whatever it finds.
    const b = signIn(DB, 1, "002", "3333");
    const result = endSession(DB, 1, a);

    expect(field(result, "error")).toBe("session_replaced");
    expect(sessionRow(DB, b)).toBe("OPEN|-");
  });

  it("10c. termination commits FIRST, and the later login opens a fresh session", () => {
    const a = signIn(DB, 1);

    expect(field(endSession(DB, 1, a), "outcome")).toBe("ended");

    const b = signIn(DB, 1, "002", "3333");

    expect(b).not.toBe(a);
    expect(sessionRow(DB, a)).toMatch(/\|logout$/);
    expect(sessionRow(DB, b)).toBe("OPEN|-");
    // The unique partial index is what makes "at most one open" a fact.
    expect(sql(DB, `select count(*)::text from public.employee_pos_sessions
                    where paired_device_id='${device(1)}' and ended_at is null`)).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// 11-15. Reachability: what a real client role may actually do
// ---------------------------------------------------------------------------

maybe("the unsafe path is closed and the safe one is open", () => {
  it("11. authenticated CANNOT execute the zero-argument logout any more", () => {
    expect(sql(DB, `select has_function_privilege('authenticated',
      'public.employee_logout()', 'EXECUTE')::text`)).toBe("false");

    const a = signIn(DB, 1);
    const error = asAuthenticatedExpectingFailure(
      DB, deviceUser(1), `select public.employee_logout()`
    );

    expect(error).toMatch(/permission denied/i);
    expect(sessionRow(DB, a)).toBe("OPEN|-");
  });

  it("12. authenticated CAN execute the expectation-bound termination", () => {
    const a = signIn(DB, 1);

    expect(sql(DB, `select has_function_privilege('authenticated',
      'public.end_employee_pos_session(uuid)', 'EXECUTE')::text`)).toBe("true");

    const out = asAuthenticated(
      DB, deviceUser(1),
      `select public.end_employee_pos_session('${a}'::uuid)::text`
    );

    expect(field(out, "outcome")).toBe("ended");
  });

  it("13. anon can execute neither", () => {
    for (const fn of ["public.end_employee_pos_session(uuid)", "public.employee_logout()"]) {
      expect(sql(DB, `select has_function_privilege('anon','${fn}','EXECUTE')::text`)).toBe("false");
    }
  });

  it("14. service_role can execute neither", () => {
    for (const fn of ["public.end_employee_pos_session(uuid)", "public.employee_logout()"]) {
      expect(sql(DB, `select has_function_privilege('service_role','${fn}','EXECUTE')::text`))
        .toBe("false");
    }
  });

  it("15. the table itself grants no client any way around the functions", () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const verb of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        expect(
          sql(DB, `select has_table_privilege('${role}','public.employee_pos_sessions','${verb}')::text`)
        ).toBe("false");
      }
    }

    expect(sql(DB, `select relrowsecurity::text from pg_class
                    where oid='public.employee_pos_sessions'::regclass`)).toBe("true");
    expect(sql(DB, `select count(*)::text from pg_policies
                    where schemaname='public' and tablename='employee_pos_sessions'`)).toBe("0");
  });

  it("16. the migration is SECURITY DEFINER with a pinned search_path", () => {
    expect(sql(DB, `select prosecdef::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='end_employee_pos_session'`)).toBe("true");
    expect(sql(DB, `select proconfig::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='end_employee_pos_session'`))
      .toContain("search_path=public, pg_catalog, pg_temp");
  });

  it("16b. employee_logout survives physically, body untouched", () => {
    expect(sql(DB, `select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='employee_logout'`)).toBe("1");
    expect(sql(DB, `select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='employee_logout'`))
      .toContain("end_reason");
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROLS
//
// The migration is rewritten into the two shapes that would look correct in
// review and be wrong in production, applied to a throwaway database, and the
// assertions above re-run against it. If they still pass, they were not
// testing anything.
// ---------------------------------------------------------------------------

maybe("the tests above fail against a broken implementation", () => {
  const BROKEN = "cp31_broken";

  /** Applies every migration except this one, then a mutated version of it. */
  function withBroken(mutate: (sql: string) => string): void {
    const original = readFileSync(join(migrationsDir, MIGRATION), "utf8");
    const mutated = mutate(original);

    // A mutation that changed nothing would make the control vacuous.
    expect(mutated).not.toBe(original);

    freshDatabase(BROKEN, false);
    pg("psql", [...psqlArgs(BROKEN), "--single-transaction", "-q", "-c", mutated]);
    seedTills(BROKEN);
  }

  it("NC1. dropping the expected id from the UPDATE lets a stale call end B", () => {
    withBroken((source) => {
      const anchor = `    where s.id = p_expected_employee_pos_session_id
      and s.paired_device_id = v_device_id
      and s.ended_at is null`;
      expect(source.split(anchor).length).toBe(2); // anchor must be unique

      // "end whatever is open" -- the pre-CP3.1 behaviour, reintroduced.
      return source.split(anchor).join(`    where s.paired_device_id = v_device_id
      and s.ended_at is null`)
        // and let the branch be reached even when the expectation is stale
        .replace("if v_expected.ended_at is null then", "if true then");
    });

    const a = signIn(BROKEN, 1);
    const b = signIn(BROKEN, 1, "002", "3333");

    const result = asRole(
      BROKEN, deviceUser(1),
      `select public.end_employee_pos_session('${a}'::uuid)::text`
    );

    // THE DEFECT, REPRODUCED: the stale call reports success and B is closed.
    expect(field(result, "ok")).toBe("true");
    expect(
      sql(BROKEN, `select coalesce(ended_at::text,'OPEN') from public.employee_pos_sessions where id='${b}'`)
    ).not.toBe("OPEN");

    // Which is exactly what test 3 asserts must NOT happen.
  });

  it("NC2. a migration that forgets the revoke REFUSES TO APPLY", () => {
    // Stronger than the control originally written for this. The intent was to
    // apply the migration without the revoke and watch the old contract close
    // the wrong session. The migration will not let that happen: its own
    // verification block checks the effective privilege and aborts, so the
    // unsafe state is unreachable rather than merely untested.
    const original = readFileSync(join(migrationsDir, MIGRATION), "utf8");
    const mutated = original.replace(
      "revoke all on function public.employee_logout() from authenticated;",
      "-- revoke intentionally omitted for this negative control"
    );

    expect(mutated).not.toBe(original);

    freshDatabase(BROKEN, false);

    let failure = "";
    try {
      pg("psql", [...psqlArgs(BROKEN), "--single-transaction", "-q", "-c", mutated]);
    } catch (error) {
      const err = error as { stderr?: string; message?: string };
      failure = (err.stderr ?? err.message ?? "").toString();
    }

    expect(failure).toContain("employee_logout is still executable by authenticated");

    // And because it ran in one transaction, the half-applied state is gone:
    // the new function does not exist either.
    expect(
      sql(BROKEN, `select count(*)::text from pg_proc p
                   join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname='public' and p.proname='end_employee_pos_session'`)
    ).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// REAL CONCURRENCY — the two actual functions, racing
//
// The sequential cases above show the classification is right once the dust
// settles. They do NOT show that the device lock is what settles it, because
// nothing in them ever contends: each call had the row to itself.
//
// These do. Two long-lived psql backends hold open transactions, so the loser
// is genuinely parked on the winner's row lock, and the proof of that is
// pg_blocking_pids() naming the winner — not elapsed time, which would make
// the test a stopwatch and eventually a flake.
// ---------------------------------------------------------------------------

type Conn = { proc: ChildProcessWithoutNullStreams; buffer: string };

const DONE = "__CP31_DONE__";

/**
 * A psql backend that stays up, so a transaction can be held open across steps.
 *
 * The caller is bound once, at SESSION scope, exactly as PostgREST binds it per
 * request: these functions derive every bit of authority from auth.uid(), so a
 * connection without it is simply not_authenticated.
 */
function open(db: string): Conn {
  const proc = spawn(
    join(PG_BIN as string, "psql"),
    ["-h", "127.0.0.1", "-p", String(PORT), "-U", "postgres", "-d", db, "-At", "-q"],
    { env: { ...process.env, LC_ALL: "en_US.UTF-8", PGTZ: "UTC" } }
  );
  const conn: Conn = { proc, buffer: "" };

  proc.stdout.on("data", (chunk: Buffer) => { conn.buffer += chunk.toString(); });
  proc.stderr.on("data", (chunk: Buffer) => { conn.buffer += chunk.toString(); });

  return conn;
}

/** Binds auth.uid() for the life of this connection. */
async function authenticate(conn: Conn, who: string): Promise<void> {
  await run(conn, `select set_config('request.jwt.claim.sub','${who}', false);`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sends SQL and waits for it to finish, returning what it printed. */
async function run(conn: Conn, statement: string, timeoutMs = 20_000): Promise<string> {
  const mark = conn.buffer.length;
  conn.proc.stdin.write(`${statement}\n\\echo ${DONE}\n`);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tail = conn.buffer.slice(mark);
    if (tail.includes(DONE)) return tail.slice(0, tail.indexOf(DONE)).trim();
    await sleep(25);
  }

  throw new Error(`statement did not finish in ${timeoutMs}ms: ${statement}`);
}

/** Sends SQL and does NOT wait — for the call that is meant to block. */
function fire(conn: Conn, statement: string): number {
  const mark = conn.buffer.length;
  conn.proc.stdin.write(`${statement}\n\\echo ${DONE}\n`);
  return mark;
}

/** Whatever the fired statement eventually printed. */
async function collect(conn: Conn, mark: number, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tail = conn.buffer.slice(mark);
    if (tail.includes(DONE)) return tail.slice(0, tail.indexOf(DONE)).trim();
    await sleep(25);
  }
  throw new Error(`fired statement never finished in ${timeoutMs}ms`);
}

function close(conn: Conn): void {
  try { conn.proc.stdin.end("\\q\n"); } catch { /* already gone */ }
  conn.proc.kill();
}

/**
 * Waits until `pid` is genuinely parked on a lock held by `blocker`.
 *
 * THE ASSERTION IS pg_blocking_pids, NOT THE CLOCK. The loop only decides how
 * long to keep looking; what it returns is Postgres's own answer about who is
 * waiting for whom.
 */
async function waitUntilBlockedBy(pid: string, blocker: string, timeoutMs = 15_000): Promise<{
  blocked: boolean; blockers: string; waitEvent: string;
}> {
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

/** Ends everything open on till n, then signs Amy in. Returns session A. */
function resetTill(db: string, n: number): string {
  sql(db, `update public.employee_pos_sessions set ended_at = now(), end_reason='logout'
           where paired_device_id='${device(n)}' and ended_at is null`);
  return signIn(db, n);
}

const openCount = (db: string, n: number): string =>
  sql(db, `select count(*)::text from public.employee_pos_sessions
           where paired_device_id='${device(n)}' and ended_at is null`);

maybe("the real functions serialize on the paired-device row", () => {
  it("A. termination holds the lock; a real login for B waits, then opens a NEW session", async () => {
    const a = resetTill(DB, 1);
    const terminator = open(DB);
    const login = open(DB);

    try {
      await authenticate(terminator, deviceUser(1));
      await authenticate(login, deviceUser(1));

      const tPid = await run(terminator, `select pg_backend_pid();`);
      const lPid = await run(login, `select pg_backend_pid();`);

      // Termination runs for real and keeps the device row locked by not
      // committing yet.
      await run(terminator, `begin;`);
      const terminated = await run(
        terminator,
        `select public.end_employee_pos_session('${a}'::uuid)::text;`
      );

      expect(field(terminated, "outcome")).toBe("ended");

      // The REAL login, concurrently. It must not proceed.
      const mark = fire(login, `begin; select public.employee_login_by_code('002','3333')::text;`);
      const blocked = await waitUntilBlockedBy(lPid, tPid);

      expect(blocked.blocked).toBe(true);
      expect(blocked.blockers).toContain(tPid);
      expect(blocked.waitEvent).toBe("Lock");

      // Read from a THIRD backend, so this is the committed world: the
      // terminator has not committed, so A still reads as open, and the login
      // has not run at all, so B does not exist. The open session is still A.
      expect(
        sql(DB, `select id::text from public.employee_pos_sessions
                 where paired_device_id='${device(1)}' and ended_at is null`)
      ).toBe(a);

      await run(terminator, `commit;`);

      const loggedIn = await collect(login, mark);
      expect(field(loggedIn, "ok")).toBe("true");
      await run(login, `commit;`);

      const b = sql(DB, `select id::text from public.employee_pos_sessions
                         where paired_device_id='${device(1)}' and ended_at is null`);

      expect(b).not.toBe(a);
      expect(sessionRow(DB, a)).toMatch(/\|logout$/); // ONLY A, and as a logout
      expect(sessionRow(DB, b)).toBe("OPEN|-");
      expect(openCount(DB, 1)).toBe("1");
    } finally {
      close(terminator);
      close(login);
    }
  }, 120_000);

  it("B. a real login holds the lock; termination of A waits, then refuses", async () => {
    const a = resetTill(DB, 1);
    const login = open(DB);
    const terminator = open(DB);

    try {
      await authenticate(login, deviceUser(1));
      await authenticate(terminator, deviceUser(1));

      const lPid = await run(login, `select pg_backend_pid();`);
      const tPid = await run(terminator, `select pg_backend_pid();`);

      // The REAL login replaces A with B and holds the device row.
      await run(login, `begin;`);
      const loggedIn = await run(login, `select public.employee_login_by_code('002','3333')::text;`);
      expect(field(loggedIn, "ok")).toBe("true");

      // Termination of the now-stale A, concurrently.
      const mark = fire(terminator, `begin; select public.end_employee_pos_session('${a}'::uuid)::text;`);
      const blocked = await waitUntilBlockedBy(tPid, lPid);

      expect(blocked.blocked).toBe(true);
      expect(blocked.blockers).toContain(lPid);
      expect(blocked.waitEvent).toBe("Lock");

      await run(login, `commit;`);

      const terminated = await collect(terminator, mark);
      await run(terminator, `commit;`);

      // THE WHOLE POINT: it woke into a world where A was already replaced,
      // and refused rather than closing whoever is on the till now.
      expect(field(terminated, "ok")).toBe("false");
      expect(field(terminated, "error")).toBe("session_replaced");

      const b = sql(DB, `select id::text from public.employee_pos_sessions
                         where paired_device_id='${device(1)}' and ended_at is null`);

      expect(b).not.toBe(a);
      expect(sessionRow(DB, a)).toMatch(/\|switched$/); // A untouched by the termination
      expect(
        sql(DB, `select coalesce(ended_at::text,'NULL') || '|' || coalesce(end_reason,'NULL')
                 from public.employee_pos_sessions where id='${b}'`)
      ).toBe("NULL|NULL"); // B: both columns still null
      expect(openCount(DB, 1)).toBe("1");
    } finally {
      close(login);
      close(terminator);
    }
  }, 120_000);
});
