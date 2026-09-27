// v1.3 Feature 1D — cash movements, EXECUTED against a real PostgreSQL.
//
// WHAT CANNOT BE CHECKED BY READING. That a cashier may drop cash but not pay it
// out, and that the refusal comes from the SERVER rather than from a hidden
// button. That an amount with three decimals is refused rather than rounded into
// the books. That a lost reply, retried, returns the original movement instead of
// moving the money twice -- and that the SAME request id presented by a different
// employee, on a different business day, or for a different action reveals
// nothing and changes nothing. That a movement never brings a business day into
// existence. All of those are runtime facts about constraints, privileges,
// ordering and locks.
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
const MIGRATION = "20260927130000_cash_movements.sql";

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
      "\n  These are the only tests that EXECUTE cash movements;" +
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

function seed(db: string): void {
  sql(db, `
    insert into auth.users (id) values
      ('${OWNER_USER}'), ('${deviceUser(1)}'), ('${deviceUser(2)}'),
      ('${OTHER_OWNER_USER}'), ('${OTHER_USER}');

    insert into public.projects (id, user_id, name, template_id, config, business_timezone)
    values ('${PROJECT}', '${OWNER_USER}', 'Shop', 'cafe', '${MENU}'::jsonb, '${ZONE}'),
           ('${OTHER_PROJECT}', '${OTHER_OWNER_USER}', 'Other Shop', 'cafe', '${MENU}'::jsonb, '${ZONE}');

    insert into public.build_jobs (id, project_id, owner_id, target, status, config_snapshot,
                                   config_schema_version, config_hash, request_key, started_at, finished_at)
    values ('${BUILD}','${PROJECT}','${OWNER_USER}','android','succeeded','${MENU}'::jsonb,1,'h','r', now(), now()),
           ('${OTHER_BUILD}','${OTHER_PROJECT}','${OTHER_OWNER_USER}','android','succeeded','${MENU}'::jsonb,1,'h2','r2', now(), now());

    -- Two tills in one shop: this is what makes a per-device DAILY real.
    insert into public.paired_devices (id, auth_user_id, owner_id, project_id, build_job_id, created_at)
    values ('${device(1)}','${deviceUser(1)}','${OWNER_USER}','${PROJECT}','${BUILD}', now() - interval '30 days'),
           ('${device(2)}','${deviceUser(2)}','${OWNER_USER}','${PROJECT}','${BUILD}', now() - interval '30 days'),
           ('${OTHER_DEVICE}','${OTHER_USER}','${OTHER_OWNER_USER}','${OTHER_PROJECT}','${OTHER_BUILD}', now() - interval '30 days');

    insert into public.employees (id, project_id, display_name, employee_code, role, pin_hash, active, created_at)
    values ('${CASHIER}','${PROJECT}','Amy','001','cashier', public.employee_pin_hash('2222'), true, '2026-01-01'),
           ('${MANAGER}','${PROJECT}','Bo','002','manager', public.employee_pin_hash('3333'), true, '2026-01-01'),
           ('${OWNER_EMP}','${PROJECT}','Cleo','003','owner', public.employee_pin_hash('4444'), true, '2026-01-01'),
           ('${OTHER_EMPLOYEE}','${OTHER_PROJECT}','Zed','001','owner', public.employee_pin_hash('5555'), true, '2026-01-01');
  `);
}

const uuid = (n: number): string =>
  `f0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** The DAILY this till is on right now, established the ordinary way. */
function ensureDaily(db: string, n: number): string {
  const result = asRole(db, deviceUser(n), `select public.ensure_daily_register_context()::text`);
  const parsed = JSON.parse(result) as { registerSession?: { registerSessionId?: string } };
  const id = parsed.registerSession?.registerSessionId;

  expect(id).toBeTruthy();

  return id as string;
}

type Kind = "cash_drop" | "paid_in" | "paid_out";

const RPC: Record<Kind, string> = {
  cash_drop: "record_cash_drop",
  paid_in: "record_paid_in",
  paid_out: "record_paid_out",
};

/** One cash-movement call as till `n`. `amount` and `note` go as SQL literals. */
function move(
  db: string,
  n: number,
  kind: Kind,
  code: string,
  pin: string,
  amount: string,
  note: string | null,
  expected: string,
  request: string
): string {
  return asRole(
    db,
    deviceUser(n),
    `select public.${RPC[kind]}('${code}','${pin}',${amount},` +
      `${note === null ? "null" : `'${note.replace(/'/g, "''")}'`},` +
      `'${expected}'::uuid,'${request}'::uuid)::text`
  );
}

const field = (json: string, key: string): string => {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  return parsed[key] === null || parsed[key] === undefined ? "" : String(parsed[key]);
};

const movementCount = (db: string): string =>
  sql(db, `select count(*)::text from public.cash_movements`);

const row = (db: string, id: string): string =>
  sql(db, `select movement_type || '|' || amount::text || '|' || coalesce(note,'<NULL>')
                  || '|' || employee_id::text || '|' || project_id::text
                  || '|' || paired_device_id::text || '|' || register_session_id::text
           from public.cash_movements where id = '${id}'`);

/** Each test starts from a known place: no movements, no throttles, all active. */
function reset(db: string): void {
  sql(db, `delete from public.cash_movements`);
  sql(db, `delete from public.employee_login_employee_attempts`);
  sql(db, `delete from public.employee_login_device_throttles`);
  sql(db, `delete from public.employee_login_device_failures`);
  sql(db, `update public.employees set active = true, deactivated_at = null
           where project_id = '${PROJECT}'`);
  sql(db, `update public.paired_devices set revoked_at = null, unpaired_at = null
           where project_id = '${PROJECT}'`);
}

const DB = "cm";
let DAILY = "";
let DAILY_2 = "";
let OTHER_DAILY = "";

beforeAll(() => {
  if (PG_BIN === null) return;

  dataDir = mkdtempSync(join(tmpdir(), "pos-canvas-cm-"));
  pg("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust"]);
  pg("pg_ctl", [
    "-D", dataDir, "-l", join(dataDir, "server.log"), "-w", "start",
    "-o", `-c listen_addresses=127.0.0.1 -c port=${PORT} -c unix_socket_directories=''`,
  ]);
  freshDatabase(DB, true);
  seed(DB);
  DAILY = ensureDaily(DB, 1);
  DAILY_2 = ensureDaily(DB, 2);
  OTHER_DAILY = JSON.parse(
    asRole(DB, OTHER_USER, `select public.ensure_daily_register_context()::text`)
  ).registerSession.registerSessionId as string;
}, 900_000);

afterAll(() => {
  if (PG_BIN === null) return;
  try { pg("pg_ctl", ["-D", dataDir, "-m", "immediate", "-w", "stop"]); }
  finally { rmSync(dataDir, { recursive: true, force: true }); }
}, 900_000);

const maybe = PG_BIN === null ? describe.skip : describe;

// ---------------------------------------------------------------------------
// 1-9. The role matrix, enforced by the SERVER
// ---------------------------------------------------------------------------

maybe("who may move cash", () => {
  // A cashier must be able to drop: requiring a manager would leave tills sitting
  // on more money than they need to, which is the exact risk dropping reduces.
  it("1-3. every role may record a Cash Drop", () => {
    reset(DB);

    for (const [i, [code, pin]] of ([["001", "2222"], ["002", "3333"], ["003", "4444"]] as const).entries()) {
      const result = move(DB, 1, "cash_drop", code, pin, "20.00", null, DAILY, uuid(100 + i));

      expect(field(result, "ok")).toBe("true");
      expect(field(result, "movementType")).toBe("cash_drop");
    }

    expect(movementCount(DB)).toBe("3");
  });

  // Money moving in or out for a non-sale reason is where abuse concentrates, so
  // it is worth a second person.
  it("4-5. a cashier may NOT record a Paid In or a Paid Out", () => {
    reset(DB);

    for (const [i, kind] of (["paid_in", "paid_out"] as const).entries()) {
      const result = move(DB, 1, kind, "001", "2222", "20.00", "milk", DAILY, uuid(110 + i));

      expect(field(result, "ok")).toBe("false");
      expect(field(result, "error")).toBe("not_permitted");
    }

    // NO FINANCIAL MUTATION. The refusal is not a rollback of something written.
    expect(movementCount(DB)).toBe("0");
  });

  it("6-9. a manager and an owner may record both", () => {
    reset(DB);
    let n = 120;

    for (const [code, pin] of [["002", "3333"], ["003", "4444"]] as const) {
      for (const kind of ["paid_in", "paid_out"] as const) {
        const result = move(DB, 1, kind, code, pin, "7.25", "reason", DAILY, uuid(n));
        n += 1;

        expect(field(result, "ok")).toBe("true");
        expect(field(result, "movementType")).toBe(kind);
      }
    }

    expect(movementCount(DB)).toBe("4");
  });

  // NEGATIVE CONTROL: the refusal must name no role, or an unattended till with
  // one valid PIN becomes a way to read the staff's permissions.
  it("the role refusal says nothing about roles", () => {
    reset(DB);
    const result = move(DB, 1, "paid_out", "001", "2222", "5.00", "x", DAILY, uuid(130));

    expect(Object.keys(JSON.parse(result) as object).sort()).toEqual(["error", "ok"]);
    expect(result).not.toMatch(/owner|manager|cashier|role/i);
  });

  // ROLE IS CHECKED AFTER THE PIN. A wrong PIN from a cashier attempting a
  // paid-out must look exactly like a wrong PIN, not like a role refusal --
  // otherwise the two answers together reveal who is a cashier.
  it("a wrong PIN outranks the role gate, so the two cannot be told apart", () => {
    reset(DB);
    const result = move(DB, 1, "paid_out", "001", "9999", "5.00", "x", DAILY, uuid(131));

    expect(field(result, "error")).toBe("invalid_credentials");
    expect(movementCount(DB)).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// 10-15. The reason
// ---------------------------------------------------------------------------

maybe("the reason", () => {
  it("10-11. a Cash Drop takes no reason, and whitespace is stored as NULL", () => {
    reset(DB);
    const bare = move(DB, 1, "cash_drop", "001", "2222", "5.00", null, DAILY, uuid(140));
    const blank = move(DB, 1, "cash_drop", "001", "2222", "5.00", "   ", DAILY, uuid(141));

    expect(field(bare, "ok")).toBe("true");
    expect(field(blank, "ok")).toBe("true");

    // ONE SPELLING OF "NO REASON". Both rows are NULL, so "no note" cannot be two
    // different things in the data.
    expect(sql(DB, `select count(*)::text from public.cash_movements where note is null`)).toBe("2");
    expect(sql(DB, `select count(*)::text from public.cash_movements where note = ''`)).toBe("0");
  });

  it("12-13. a Paid In or Paid Out with no reason is refused", () => {
    reset(DB);

    for (const [i, kind] of (["paid_in", "paid_out"] as const).entries()) {
      for (const [j, note] of ([null, "", "   ", "\t "] as const).entries()) {
        const result = move(DB, 1, kind, "002", "3333", "5.00", note, DAILY, uuid(150 + i * 10 + j));

        expect(field(result, "error")).toBe("note_required");
      }
    }

    expect(movementCount(DB)).toBe("0");
  });

  it("14-15. 200 characters is accepted; 201 is REFUSED, never truncated", () => {
    reset(DB);
    const at = "x".repeat(200);
    const over = "y".repeat(201);

    const ok = move(DB, 1, "paid_out", "002", "3333", "5.00", at, DAILY, uuid(170));
    expect(field(ok, "ok")).toBe("true");
    expect(field(ok, "note")).toHaveLength(200);

    const refused = move(DB, 1, "paid_out", "002", "3333", "5.00", over, DAILY, uuid(171));
    expect(field(refused, "error")).toBe("invalid_note");

    // NOTHING SHORTENED. A silently truncated reason is a different reason, and
    // the clause that gets cut is the one that explained the money.
    expect(movementCount(DB)).toBe("1");
    expect(sql(DB, `select count(*)::text from public.cash_movements
                    where note like 'y%'`)).toBe("0");
    expect(sql(DB, `select length(note)::text from public.cash_movements`)).toBe("200");
  });

  it("trims the reason rather than storing the keystrokes", () => {
    reset(DB);
    const result = move(DB, 1, "paid_in", "002", "3333", "5.00", "  float top-up  ", DAILY, uuid(180));

    expect(field(result, "note")).toBe("float top-up");
    expect(sql(DB, `select note from public.cash_movements`)).toBe("float top-up");
  });

  // Trailing whitespace is not content, so a 200-character reason with a stray
  // space still fits -- it is measured after trimming.
  it("measures the trimmed reason against the limit", () => {
    reset(DB);
    const padded = `  ${"z".repeat(200)}  `;

    expect(field(move(DB, 1, "paid_in", "002", "3333", "5.00", padded, DAILY, uuid(181)), "ok")).toBe("true");
  });

  // REGRESSION, AND IT WAS A REAL DEFECT. PostgreSQL's bare btrim() strips SPACES
  // ONLY, so a reason of one tab survived it, read as present, and satisfied a
  // required note with content nobody can see -- while the client's .trim(), which
  // strips all whitespace, called the same input blank. The two disagreed.
  it("treats a tab or a newline as blank, exactly as the client does", () => {
    reset(DB);

    for (const [i, note] of ["\t", "\t ", "\n", " \r\n\t "].entries()) {
      // Required: invisible whitespace is not a reason.
      expect(field(move(DB, 1, "paid_in", "002", "3333", "5.00", note, DAILY, uuid(184 + i * 2)), "error"))
        .toBe("note_required");

      // Optional: it becomes NULL, not an invisible note.
      const drop = move(DB, 1, "cash_drop", "002", "3333", "5.00", note, DAILY, uuid(185 + i * 2));
      expect(field(drop, "ok")).toBe("true");
      expect(field(drop, "note")).toBe("");
    }

    expect(sql(DB, `select count(*)::text from public.cash_movements where note is not null`)).toBe("0");
  });

  // NEGATIVE CONTROL AT THE SCHEMA LEVEL: the constraint is what actually holds,
  // so a row that bypassed the function could not exist either.
  it("the database itself refuses a note-less Paid Out and an untrimmed note", () => {
    reset(DB);

    for (const [note, why] of [
      ["null", "note_required"],
      ["'  x  '", "note_shape"],
      ["''", "note_shape"],
      // A tab-only note: the CHECK uses the same explicit whitespace set the
      // function does, so a row that bypassed the function could not exist either.
      [String.raw`E'\t'`, "note_shape"],
    ] as const) {
      let failed = "";

      try {
        sql(DB, `insert into public.cash_movements
                 (project_id, paired_device_id, register_session_id, employee_id,
                  movement_type, amount, note, occurred_at, request_id)
                 values ('${PROJECT}','${device(1)}','${DAILY}','${MANAGER}',
                         'paid_out', 5.00, ${note}, now(), '${uuid(190)}')`);
      } catch (error) {
        failed = ((error as { stderr?: string }).stderr ?? "").toString();
      }

      expect(failed).toContain("cash_movements_" + why);
    }

    expect(movementCount(DB)).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// 16-22. The money, and the clock
// ---------------------------------------------------------------------------

maybe("the money", () => {
  it("16. an exact amount is stored exactly", () => {
    reset(DB);

    for (const [i, amount] of ["0.01", "1.05", "25.00", "9999999999.99"].entries()) {
      const result = move(DB, 1, "cash_drop", "001", "2222", amount, null, DAILY, uuid(200 + i));

      expect(field(result, "ok")).toBe("true");
      // The reply and the stored row agree, to the cent, with what was sent.
      expect(field(result, "amount")).toBe(amount);
      expect(sql(DB, `select amount::text from public.cash_movements
                      where id='${field(result, "movementId")}'`)).toBe(amount);
    }
  });

  it("17-21. zero, negative, three decimals, over-maximum and non-finite are refused", () => {
    reset(DB);

    // NON-FINITE IS FIRST FOR A REASON. NaN sorts ABOVE every number in numeric,
    // so `amount <= 0` would let it through, and trunc('NaN',2) is NaN which
    // equals itself, so the scale test would too.
    for (const [i, amount] of [
      "0", "0.00", "-5.00", "-0.01", "12.345", "0.001",
      "10000000000.00", "'NaN'::numeric", "'Infinity'::numeric", "'-Infinity'::numeric", "null",
    ].entries()) {
      const result = move(DB, 1, "cash_drop", "001", "2222", amount, null, DAILY, uuid(210 + i));

      expect(field(result, "error")).toBe("invalid_amount");
    }

    expect(movementCount(DB)).toBe("0");
  });

  // NEGATIVE CONTROL, AND THE WHOLE REASON THE RPC CHECKS THE ARGUMENT. A
  // numeric(12,2) typmod ROUNDS on assignment -- 12.345 would land as 12.35 --
  // so the column type cannot be the scale guard. The function refuses the value
  // before it is ever assigned, and the CHECK is the backstop underneath.
  it("three decimals are REFUSED, not rounded into the books", () => {
    reset(DB);
    move(DB, 1, "cash_drop", "001", "2222", "12.345", null, DAILY, uuid(230));

    expect(movementCount(DB)).toBe("0");
    expect(sql(DB, `select count(*)::text from public.cash_movements where amount = 12.35`)).toBe("0");

    let failed = "";
    try {
      sql(DB, `insert into public.cash_movements
               (project_id, paired_device_id, register_session_id, employee_id,
                movement_type, amount, note, occurred_at, request_id)
               values ('${PROJECT}','${device(1)}','${DAILY}','${CASHIER}',
                       'cash_drop', 0, null, now(), '${uuid(231)}')`);
    } catch (error) {
      failed = ((error as { stderr?: string }).stderr ?? "").toString();
    }

    expect(failed).toContain("cash_movements_amount_positive");
  });

  it("22. the timestamp is the SERVER's, and no function accepts one", () => {
    reset(DB);
    const before = sql(DB, `select clock_timestamp()::text`);
    const result = move(DB, 1, "cash_drop", "001", "2222", "5.00", null, DAILY, uuid(240));
    const after = sql(DB, `select clock_timestamp()::text`);

    const at = sql(DB, `select occurred_at::text from public.cash_movements
                        where id='${field(result, "movementId")}'`);

    // The instant lies between two server readings taken around the call, so it
    // came from the database and not from any caller.
    expect(at >= before).toBe(true);
    expect(at <= after).toBe(true);

    // The reply carries that SAME instant. Compared as timestamps rather than as
    // text: jsonb renders timestamptz in ISO-8601 ("...T19:52:33.447075+00:00")
    // and ::text uses Postgres's space form, so the two spellings differ while
    // the value does not.
    expect(
      sql(DB, `select ('${field(result, "occurredAt")}'::timestamptz = '${at}'::timestamptz)::text`)
    ).toBe("true");

    for (const fn of ["record_cash_drop", "record_paid_in", "record_paid_out"]) {
      const args = sql(DB, `select pg_get_function_identity_arguments(p.oid)
                            from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                            where n.nspname='public' and p.proname='${fn}'`);

      expect(args).toBe(
        "p_employee_code text, p_pin text, p_amount numeric, p_note text, " +
          "p_expected_register_session_id uuid, p_request_id uuid"
      );
      // The rule behind the exact match: no instant, and no movement type, may
      // arrive from a caller.
      expect(args).not.toMatch(/timestamp/i);
      expect(args).not.toMatch(/movement_type/i);
    }
  });
});

// ---------------------------------------------------------------------------
// 23-29. What a movement is attached to
// ---------------------------------------------------------------------------

maybe("a movement is attached to the right shop, till, employee and day", () => {
  it("23-26. project, device, employee and DAILY all come from the server", () => {
    reset(DB);
    const result = move(DB, 2, "cash_drop", "002", "3333", "9.99", null, DAILY_2, uuid(250));

    expect(field(result, "ok")).toBe("true");
    expect(row(DB, field(result, "movementId"))).toBe(
      `cash_drop|9.99|<NULL>|${MANAGER}|${PROJECT}|${device(2)}|${DAILY_2}`
    );
  });

  // The 23:59:59 case: the operator confirms on one business day and the server
  // commits on the next. Without this the money is filed, permanently, under the
  // wrong day.
  it("27. an expectation that does not match today's DAILY is refused", () => {
    reset(DB);

    for (const [i, expected] of [DAILY_2, OTHER_DAILY, uuid(900), "00000000-0000-0000-0000-000000000000"].entries()) {
      const result = move(DB, 1, "cash_drop", "001", "2222", "5.00", null, expected, uuid(260 + i));

      // A nil uuid is a malformed request rather than a changed day; both refuse.
      expect(["daily_changed", "invalid_request"]).toContain(field(result, "error"));
    }

    expect(movementCount(DB)).toBe("0");
  });

  // A till with no business day has nothing for this money to belong to, and a
  // cash movement may not bring one into existence -- otherwise an unattended
  // till could open a business day by itself.
  it("28-29. with no DAILY the movement is refused, and NO DAILY is created", () => {
    reset(DB);
    const dailyRows = () =>
      sql(DB, `select count(*)::text from public.register_sessions
               where paired_device_id='${device(1)}' and business_date is not null`);

    sql(DB, `delete from public.register_sessions where paired_device_id='${device(1)}'`);
    expect(dailyRows()).toBe("0");

    const result = move(DB, 1, "cash_drop", "001", "2222", "5.00", null, DAILY, uuid(270));

    expect(field(result, "error")).toBe("no_daily_context");
    expect(movementCount(DB)).toBe("0");
    // THE RULE: still zero. The movement did not quietly ensure a context to
    // give itself something to attach to.
    expect(dailyRows()).toBe("0");

    // Put the day back the ordinary way, and the same call now works.
    DAILY = ensureDaily(DB, 1);
    expect(field(move(DB, 1, "cash_drop", "001", "2222", "5.00", null, DAILY, uuid(271)), "ok")).toBe("true");
  });

  it("a till cannot record against another shop's employee, day or till", () => {
    reset(DB);

    // '001' exists in both shops and is a DIFFERENT person. The PIN that works
    // there must not work here.
    expect(field(move(DB, 1, "cash_drop", "001", "5555", "5.00", null, DAILY, uuid(280)), "error"))
      .toBe("invalid_credentials");
    // And the other shop's own till lands on its own project and day.
    const theirs = asRole(DB, OTHER_USER,
      `select public.record_cash_drop('001','5555',5.00,null,'${OTHER_DAILY}'::uuid,'${uuid(281)}'::uuid)::text`);

    expect(field(theirs, "ok")).toBe("true");
    expect(row(DB, field(theirs, "movementId"))).toContain(`${OTHER_PROJECT}|${OTHER_DEVICE}|${OTHER_DAILY}`);
  });
});

// ---------------------------------------------------------------------------
// 30-33. The credential door
// ---------------------------------------------------------------------------

maybe("authorizing a movement", () => {
  it("30-32. a deactivated employee, an unknown ID and a wrong PIN are ONE answer", () => {
    reset(DB);
    sql(DB, `update public.employees set active = false, deactivated_at = now()
             where id = '${MANAGER}'`);

    const answers = [
      // Deactivated, correct PIN.
      move(DB, 1, "cash_drop", "002", "3333", "5.00", null, DAILY, uuid(300)),
      // Unknown Employee ID.
      move(DB, 1, "cash_drop", "009", "3333", "5.00", null, DAILY, uuid(301)),
      // Real employee, wrong PIN.
      move(DB, 1, "cash_drop", "001", "9999", "5.00", null, DAILY, uuid(302)),
      // Malformed ID.
      move(DB, 1, "cash_drop", "000", "2222", "5.00", null, DAILY, uuid(303)),
    ];

    // INDISTINGUISHABLE. Byte-identical answers, or the panel becomes a way to
    // find out who works here and who has been let go.
    for (const answer of answers) {
      expect(answer).toBe('{"ok": false, "error": "invalid_credentials"}');
    }

    expect(movementCount(DB)).toBe("0");
    reset(DB);
  });

  it("33. the existing device throttle is reused, not reimplemented", () => {
    reset(DB);

    // A throttled till cannot be used to probe for Employee IDs at all: the
    // cooldown is checked BEFORE anything is looked up.
    sql(DB, `insert into public.employee_login_device_throttles (paired_device_id, throttled_until)
             values ('${device(1)}', clock_timestamp() + interval '5 minutes')
             on conflict (paired_device_id) do update set throttled_until = excluded.throttled_until`);

    const result = move(DB, 1, "cash_drop", "001", "2222", "5.00", null, DAILY, uuid(310));

    expect(field(result, "error")).toBe("locked_out");
    expect(Number(field(result, "retryAfterSeconds"))).toBeGreaterThan(0);
    expect(movementCount(DB)).toBe("0");

    // And a wrong PIN feeds that same shared counter rather than a private one.
    reset(DB);
    move(DB, 1, "cash_drop", "001", "9999", "5.00", null, DAILY, uuid(311));

    expect(
      sql(DB, `select count(*)::text from public.employee_login_employee_attempts
               where paired_device_id='${device(1)}' and employee_id='${CASHIER}'`)
    ).toBe("1");
    reset(DB);
  });
});

// ---------------------------------------------------------------------------
// 34-39. Idempotency, and the Feature 1C replay-ownership lesson
// ---------------------------------------------------------------------------

maybe("a retry returns the original movement, and only to its owner", () => {
  it("34-35. replaying the same request returns the ORIGINAL and moves no money twice", () => {
    reset(DB);
    const first = move(DB, 1, "cash_drop", "001", "2222", "25.00", null, DAILY, uuid(400));
    const again = move(DB, 1, "cash_drop", "001", "2222", "25.00", null, DAILY, uuid(400));

    expect(field(again, "ok")).toBe("true");
    expect(field(again, "movementId")).toBe(field(first, "movementId"));
    expect(field(again, "amount")).toBe(field(first, "amount"));
    expect(field(again, "occurredAt")).toBe(field(first, "occurredAt"));
    expect(field(again, "replayed")).toBe("true");
    expect(field(first, "replayed")).toBe("false");

    // ONE ROW. The money moved once.
    expect(movementCount(DB)).toBe("1");
  });

  // A replay must answer from the ORIGINAL row, so a different amount presented
  // with the same id cannot change what was recorded.
  it("a replay ignores a changed amount rather than recording it", () => {
    reset(DB);
    const first = move(DB, 1, "cash_drop", "001", "2222", "25.00", null, DAILY, uuid(401));
    const again = move(DB, 1, "cash_drop", "001", "2222", "999.00", null, DAILY, uuid(401));

    expect(field(again, "amount")).toBe("25.00");
    expect(field(again, "movementId")).toBe(field(first, "movementId"));
    expect(movementCount(DB)).toBe("1");
    expect(sql(DB, `select amount::text from public.cash_movements`)).toBe("25.00");
  });

  // =========================================================================
  // 36-38. THE NEGATIVE CONTROLS THAT REPRODUCE THE FEATURE 1C DEFECT.
  //
  // A request id is unique per business, so it identifies a ROW -- but it says
  // nothing about whose row, which day it belonged to, or what kind of event it
  // was. Matching on the id alone would hand the next employee to authenticate
  // somebody else's cash record as their own success, simply for presenting a
  // uuid they happened to have. Each case below proves the ownership and context
  // comparisons are load-bearing, and that the refusal leaks nothing.
  // =========================================================================
  it("36. the SAME request id presented by a DIFFERENT employee conflicts and leaks nothing", () => {
    reset(DB);
    const amy = move(DB, 1, "cash_drop", "001", "2222", "25.00", null, DAILY, uuid(410));
    expect(field(amy, "ok")).toBe("true");

    // Bo authenticates correctly and supplies Amy's request id.
    const bo = move(DB, 1, "cash_drop", "002", "3333", "25.00", null, DAILY, uuid(410));

    expect(field(bo, "ok")).toBe("false");
    expect(field(bo, "error")).toBe("request_conflict");

    // NOT A LEAK. No movement id, no amount, no reason, no instant, no name --
    // otherwise a request id becomes a way to read another employee's record.
    expect(Object.keys(JSON.parse(bo) as object).sort()).toEqual(["error", "ok"]);
    expect(bo).not.toContain(field(amy, "movementId"));
    expect(bo).not.toContain("25.00");
    expect(bo).not.toContain("Amy");

    // And nothing was written or changed.
    expect(movementCount(DB)).toBe("1");
    expect(row(DB, field(amy, "movementId"))).toContain(CASHIER);
  });

  it("37. the SAME request id on a DIFFERENT business day conflicts", () => {
    reset(DB);
    // One shop, two tills, two DAILY rows. Bo drops on till 1, then presents the
    // same id on till 2 -- a different business day row.
    const one = move(DB, 1, "cash_drop", "002", "3333", "8.00", null, DAILY, uuid(420));
    expect(field(one, "ok")).toBe("true");

    const two = move(DB, 2, "cash_drop", "002", "3333", "8.00", null, DAILY_2, uuid(420));

    expect(field(two, "error")).toBe("request_conflict");
    expect(Object.keys(JSON.parse(two) as object).sort()).toEqual(["error", "ok"]);
    expect(movementCount(DB)).toBe("1");
  });

  it("38. the SAME request id for a DIFFERENT action conflicts", () => {
    reset(DB);
    // Bo may do both, so this isolates the ACTION check from the role gate.
    const paidIn = move(DB, 1, "paid_in", "002", "3333", "8.00", "float", DAILY, uuid(430));
    expect(field(paidIn, "ok")).toBe("true");

    const asDrop = move(DB, 1, "cash_drop", "002", "3333", "8.00", null, DAILY, uuid(430));
    const asPaidOut = move(DB, 1, "paid_out", "002", "3333", "8.00", "float", DAILY, uuid(430));

    // A drop is not a paid-in, and a paid-out is not either. Returning the
    // original as if it were this action would report money as banked when it was
    // spent, or the reverse.
    expect(field(asDrop, "error")).toBe("request_conflict");
    expect(field(asPaidOut, "error")).toBe("request_conflict");
    expect(movementCount(DB)).toBe("1");
    expect(sql(DB, `select movement_type from public.cash_movements`)).toBe("paid_in");
  });

  it("39. the same uuid in ANOTHER shop is a different movement entirely", () => {
    reset(DB);
    const ours = move(DB, 1, "cash_drop", "001", "2222", "4.00", null, DAILY, uuid(440));
    const theirs = asRole(DB, OTHER_USER,
      `select public.record_cash_drop('001','5555',4.00,null,'${OTHER_DAILY}'::uuid,'${uuid(440)}'::uuid)::text`);

    // Scoped per business, so one shop's retry can never resolve to another's row
    // -- and a caller cannot probe for a request id it does not own.
    expect(field(ours, "ok")).toBe("true");
    expect(field(theirs, "ok")).toBe("true");
    expect(field(theirs, "movementId")).not.toBe(field(ours, "movementId"));
    expect(field(theirs, "replayed")).toBe("false");
    expect(movementCount(DB)).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// 44-52. Security, and what did not move
// ---------------------------------------------------------------------------

maybe("the table is reachable only through the three actions", () => {
  it("44-45. RLS is on and there are no policies", () => {
    expect(sql(DB, `select relrowsecurity::text from pg_class
                    where oid='public.cash_movements'::regclass`)).toBe("true");
    expect(sql(DB, `select count(*)::text from pg_policies
                    where schemaname='public' and tablename='cash_movements'`)).toBe("0");
  });

  it("46, 50-51. no client role may select, insert, update or delete", () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        expect(
          sql(DB, `select has_table_privilege('${role}','public.cash_movements','${privilege}')::text`)
        ).toBe("false");
      }
    }

    // And what actually happens when the real role tries it, not just what the
    // catalog says it may do.
    expect(asAuthenticatedExpectingFailure(DB, deviceUser(1),
      `select count(*) from public.cash_movements`)).toContain("permission denied");
    expect(asAuthenticatedExpectingFailure(DB, deviceUser(1),
      `delete from public.cash_movements`)).toContain("permission denied");
    expect(asAuthenticatedExpectingFailure(DB, deviceUser(1),
      `update public.cash_movements set amount = 1`)).toContain("permission denied");
  });

  it("47-49. the three actions are executable by authenticated and by nobody else", () => {
    const args = "text, text, numeric, text, uuid, uuid";

    for (const fn of ["record_cash_drop", "record_paid_in", "record_paid_out"]) {
      expect(sql(DB, `select has_function_privilege('authenticated','public.${fn}(${args})','EXECUTE')::text`)).toBe("true");
      expect(sql(DB, `select has_function_privilege('anon','public.${fn}(${args})','EXECUTE')::text`)).toBe("false");
      expect(sql(DB, `select has_function_privilege('service_role','public.${fn}(${args})','EXECUTE')::text`)).toBe("false");
    }
  });

  // THE POINT OF HAVING THREE WRAPPERS. The one function that takes a movement
  // type must be unreachable, or a till could name the kind of financial event it
  // creates and walk past the role gate.
  it("the shared contract is executable by NO client role, and really is not callable", () => {
    const args = "text, text, text, numeric, text, uuid, uuid";

    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(sql(DB, `select has_function_privilege('${role}','public.cash_movement_append(${args})','EXECUTE')::text`)).toBe("false");
    }

    reset(DB);
    const denied = asAuthenticatedExpectingFailure(DB, deviceUser(1),
      `select public.cash_movement_append('paid_out','001','2222',5.00,'x','${DAILY}'::uuid,'${uuid(500)}'::uuid)`);

    expect(denied).toContain("permission denied for function cash_movement_append");
    expect(movementCount(DB)).toBe("0");
  });

  // The real role, end to end: not `postgres` bypassing every ACL.
  it("a real authenticated till CAN record a drop through the public action", () => {
    reset(DB);
    const result = asAuthenticated(DB, deviceUser(1),
      `select public.record_cash_drop('001','2222',3.50,null,'${DAILY}'::uuid,'${uuid(501)}'::uuid)::text`);

    expect(field(result, "ok")).toBe("true");
    expect(field(result, "amount")).toBe("3.50");
    expect(movementCount(DB)).toBe("1");
  });

  // 50. No history RPC exists to grant a read path to.
  it("50. there is no runtime read contract at all", () => {
    // Exactly one function carries the shared contract's name, and it is the
    // internal one no client may execute.
    expect(sql(DB, `select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname ~ 'cash_movement'`)).toBe("1");
    // Feature 1D added exactly these four and nothing else -- in particular, no
    // list/get/read function, because reading a financial table is Lane 3's
    // contract and will arrive with its own.
    expect(sql(DB, `select string_agg(p.proname, ',' order by p.proname)
                    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public'
                      and p.proname in ('cash_movement_append','record_cash_drop',
                                        'record_paid_in','record_paid_out')`))
      .toBe("cash_movement_append,record_cash_drop,record_paid_in,record_paid_out");

    expect(sql(DB, `select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public'
                      and p.proname ~ '(list|get|fetch|read|history)_?cash'`)).toBe("0");

    // And nothing outside those four so much as names the table.
    expect(sql(DB, `select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.prosrc ~ 'cash_movements'
                      and p.proname <> 'cash_movement_append'`)).toBe("0");
  });

  it("52. no Feature 1B or 1C contract was touched, and none learned about cash", () => {
    // Every accepted function still exists.
    expect(sql(DB, `select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname in
                      ('complete_sale_v5','employee_login_by_code','end_employee_pos_session',
                       'ensure_daily_register_context','clock_in_employee','clock_out_employee')`)).toBe("6");

    // And none of them mentions cash movements.
    expect(sql(DB, `select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.prosrc ~ 'cash_movements'
                      and p.proname <> 'cash_movement_append'`)).toBe("0");
  });

  // NEGATIVE CONTROL ON THE OTHER DIRECTION: recording a movement must leave the
  // POS session, the Time Clock, the register and the orders exactly as they were.
  it("recording a movement creates no POS session, no punch, no order and no register", () => {
    reset(DB);
    const counts = () =>
      sql(DB, `select (select count(*) from public.employee_pos_sessions)::text || '|' ||
                      (select count(*) from public.employee_time_sessions)::text || '|' ||
                      (select count(*) from public.orders)::text || '|' ||
                      (select count(*) from public.register_sessions)::text`);

    const before = counts();
    expect(field(move(DB, 1, "paid_out", "003", "4444", "6.00", "bin bags", DAILY, uuid(510)), "ok")).toBe("true");

    expect(counts()).toBe(before);
    expect(movementCount(DB)).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// 40-43. Real concurrency, on real backends
//
// Two long-lived psql connections hold open transactions, so the loser genuinely
// waits on the winner's lock. The proof that it waited is Postgres's own
// pg_blocking_pids(), not a stopwatch: a timing-based test would pass on a fast
// machine whatever the lock order was.
// ---------------------------------------------------------------------------

type Conn = { proc: ChildProcessWithoutNullStreams; buffer: string };
const DONE = "__CM_DONE__";

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

const lastLine = (out: string): string => {
  const lines = out.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  return lines[lines.length - 1] ?? "";
};

maybe("movements that race each other", () => {
  // 40. TWO REQUESTS CARRYING THE SAME ID, neither of which saw the other's row.
  // Nothing they lock serializes them, so the unique index is the last word --
  // and the loser must re-resolve through the SAME ownership checks rather than
  // letting a raw constraint error reach a till.
  it("40. a request-id collision resolves through replay, not a constraint error", async () => {
    reset(DB);
    const a = open(DB);
    const b = open(DB);

    try {
      await auth(a, deviceUser(1));
      await auth(b, deviceUser(1));
      const pa = await run(a, `select pg_backend_pid();`);
      const pb = await run(b, `select pg_backend_pid();`);

      await run(a, `begin;`);
      const first = lastLine(await run(a,
        `select public.record_cash_drop('001','2222',12.00,null,'${DAILY}'::uuid,'${uuid(600)}'::uuid)::text;`));
      expect(field(first, "ok")).toBe("true");

      // B's pre-check sees nothing (A is uncommitted), so it reaches the insert
      // and blocks on the unique index.
      const mark = fire(b,
        `begin; select public.record_cash_drop('001','2222',12.00,null,'${DAILY}'::uuid,'${uuid(600)}'::uuid)::text;`);
      const blocked = await waitUntilBlockedBy(pb, pa);

      expect(blocked.blocked).toBe(true);
      expect(blocked.blockers).toContain(pa);
      expect(blocked.waitEvent).toBe("Lock");

      await run(a, `commit;`);
      const loser = lastLine(await collect(b, mark));
      await run(b, `commit;`);

      // Same employee, same day, same action -- so it is a legitimate replay of
      // A's row, and no raw error reached the caller.
      expect(loser).not.toContain("duplicate key");
      expect(field(loser, "ok")).toBe("true");
      expect(field(loser, "replayed")).toBe("true");
      expect(field(loser, "movementId")).toBe(field(first, "movementId"));

      // ONE ROW. The money moved once.
      expect(movementCount(DB)).toBe("1");
    } finally {
      close(a); close(b);
    }
  }, 120_000);

  // The same race, but the loser is a DIFFERENT employee. The unique-violation
  // path must apply the ownership check too, or the race leaks exactly what the
  // ordinary path refuses.
  it("40b. a colliding request from another employee conflicts, and leaks nothing", async () => {
    reset(DB);
    const a = open(DB);
    const b = open(DB);

    try {
      await auth(a, deviceUser(1));
      await auth(b, deviceUser(1));
      const pa = await run(a, `select pg_backend_pid();`);
      const pb = await run(b, `select pg_backend_pid();`);

      await run(a, `begin;`);
      const amy = lastLine(await run(a,
        `select public.record_cash_drop('001','2222',12.00,null,'${DAILY}'::uuid,'${uuid(610)}'::uuid)::text;`));
      expect(field(amy, "ok")).toBe("true");

      const mark = fire(b,
        `begin; select public.record_cash_drop('002','3333',12.00,null,'${DAILY}'::uuid,'${uuid(610)}'::uuid)::text;`);
      expect((await waitUntilBlockedBy(pb, pa)).blocked).toBe(true);

      await run(a, `commit;`);
      const loser = lastLine(await collect(b, mark));
      await run(b, `commit;`);

      expect(field(loser, "error")).toBe("request_conflict");
      expect(Object.keys(JSON.parse(loser) as object).sort()).toEqual(["error", "ok"]);
      expect(loser).not.toContain(field(amy, "movementId"));
      expect(loser).not.toContain("duplicate key");
      expect(movementCount(DB)).toBe("1");
    } finally {
      close(a); close(b);
    }
  }, 120_000);

  // 41. THE MIDNIGHT ROLLOVER. ensure_daily_register_context takes the device
  // FOR UPDATE; a movement takes it FOR SHARE. They conflict, so a movement can
  // never interleave with a day changing underneath it -- it waits, then sees the
  // committed truth and refuses on the expectation it was given.
  it("41. a DAILY rollover and a movement serialize on the device row", async () => {
    reset(DB);
    const a = open(DB);
    const b = open(DB);

    try {
      await auth(a, deviceUser(2));
      await auth(b, deviceUser(2));
      const pa = await run(a, `select pg_backend_pid();`);
      const pb = await run(b, `select pg_backend_pid();`);

      // A holds the device row exclusively, exactly as a rollover would.
      await run(a, `begin;`);
      await run(a, `select public.ensure_daily_register_context()::text;`);

      const mark = fire(b,
        `begin; select public.record_cash_drop('001','2222',5.00,null,'${DAILY_2}'::uuid,'${uuid(620)}'::uuid)::text;`);
      const blocked = await waitUntilBlockedBy(pb, pa);

      // THE PROOF: the movement genuinely waited on the register work, so it
      // cannot land on a day that was being replaced.
      expect(blocked.blocked).toBe(true);
      expect(blocked.blockers).toContain(pa);
      expect(blocked.waitEvent).toBe("Lock");

      await run(a, `commit;`);
      const after = lastLine(await collect(b, mark));
      await run(b, `commit;`);

      // Today's day is unchanged, so it proceeds -- having waited.
      expect(field(after, "ok")).toBe("true");
      expect(row(DB, field(after, "movementId"))).toContain(DAILY_2);
      expect(movementCount(DB)).toBe("1");
    } finally {
      close(a); close(b);
    }
  }, 120_000);

  // 42. A DEACTIVATION THAT COMMITS BESIDE A MOVEMENT MUST WIN. The employee row
  // is revalidated under a share lock taken after the bcrypt, so the movement
  // sees the committed deactivation rather than the row it read a moment earlier.
  it("42. deactivating an employee beats a movement they are authorizing", async () => {
    reset(DB);
    const a = open(DB);
    const b = open(DB);

    try {
      await auth(a, OWNER_USER);
      await auth(b, deviceUser(1));
      const pa = await run(a, `select pg_backend_pid();`);
      const pb = await run(b, `select pg_backend_pid();`);

      // The owner deactivates Amy, and holds the row.
      await run(a, `begin;`);
      const off = lastLine(await run(a, `select public.set_employee_active('${CASHIER}', false)::text;`));
      expect(field(off, "ok")).toBe("true");

      const mark = fire(b,
        `begin; select public.record_cash_drop('001','2222',5.00,null,'${DAILY}'::uuid,'${uuid(630)}'::uuid)::text;`);
      const blocked = await waitUntilBlockedBy(pb, pa);

      expect(blocked.blocked).toBe(true);
      expect(blocked.blockers).toContain(pa);

      await run(a, `commit;`);
      const loser = lastLine(await collect(b, mark));
      await run(b, `commit;`);

      // The security control wins, and says nothing more than it ever says.
      expect(field(loser, "error")).toBe("invalid_credentials");
      expect(movementCount(DB)).toBe("0");
    } finally {
      close(a); close(b);
      reset(DB);
    }
  }, 120_000);

  // 43. A REVOKED OR UNPAIRED TILL HAS NO AUTHORITY AT ALL, and the device lock
  // is what makes that decision current rather than stale.
  it("43. a device revoked beside a movement refuses it", async () => {
    reset(DB);
    const a = open(DB);
    const b = open(DB);

    try {
      await auth(b, deviceUser(1));
      const pa = await run(a, `select pg_backend_pid();`);
      const pb = await run(b, `select pg_backend_pid();`);

      await run(a, `begin;`);
      await run(a, `update public.paired_devices set revoked_at = now() where id = '${device(1)}';`);

      const mark = fire(b,
        `begin; select public.record_cash_drop('001','2222',5.00,null,'${DAILY}'::uuid,'${uuid(640)}'::uuid)::text;`);
      const blocked = await waitUntilBlockedBy(pb, pa);

      expect(blocked.blocked).toBe(true);
      expect(blocked.blockers).toContain(pa);

      await run(a, `commit;`);
      const loser = lastLine(await collect(b, mark));
      await run(b, `commit;`);

      expect(field(loser, "error")).toBe("not_paired");
      expect(movementCount(DB)).toBe("0");
    } finally {
      close(a); close(b);
      reset(DB);
    }
  }, 120_000);

  // Two DIFFERENT movements by the SAME employee are both legitimate and
  // independent, so they must NOT serialize -- which is why the employee row is
  // locked FOR SHARE rather than FOR UPDATE. A manager dropping cash twice should
  // not have the second wait on the first.
  it("two distinct movements by one employee do not block each other", async () => {
    reset(DB);
    const a = open(DB);
    const b = open(DB);

    try {
      await auth(a, deviceUser(1));
      await auth(b, deviceUser(1));

      await run(a, `begin;`);
      const first = lastLine(await run(a,
        `select public.record_cash_drop('002','3333',5.00,null,'${DAILY}'::uuid,'${uuid(650)}'::uuid)::text;`));

      // Different request id, so no unique conflict -- and it must complete while
      // A's transaction is still open.
      await run(b, `begin;`);
      const second = lastLine(await run(b,
        `select public.record_cash_drop('002','3333',7.00,null,'${DAILY}'::uuid,'${uuid(651)}'::uuid)::text;`));

      expect(field(first, "ok")).toBe("true");
      expect(field(second, "ok")).toBe("true");

      await run(a, `commit;`);
      await run(b, `commit;`);

      expect(movementCount(DB)).toBe("2");
    } finally {
      close(a); close(b);
    }
  }, 120_000);
});
