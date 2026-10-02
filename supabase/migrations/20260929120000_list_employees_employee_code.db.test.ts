// v1.3 Lane 1 Task 5B correction — list_employees with employeeCode, EXECUTED
// against a real PostgreSQL, not read.
//
// WHAT IS PROVEN HERE THAT TEXT CANNOT PROVE: that "001" leaves the database as
// the string "001"; that each code is on its own employee's row; that every
// accepted field, ordering and refusal is byte-identical to the accepted
// function; and that list_employees is the ONLY thing in the schema that moved.
// The last two compare this migration's database against one built from every
// migration BEFORE it, seeded identically.
//
// The harness (PostgreSQL discovery, the Supabase compatibility layer, the
// cluster and the migration chain) is the one the Feature 1F suite uses,
// reproduced unchanged; only the migration name and port range differ. When no
// PostgreSQL server is found the suite SKIPS LOUDLY rather than failing.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20260929120000_list_employees_employee_code.sql";

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
const PORT = 56500 + (process.pid % 90);

if (PG_BIN === null) {
  console.warn(
    `\n[${MIGRATION}] SKIPPED: no local PostgreSQL server found.` +
      "\n  These are the only tests that EXECUTE list_employees with employeeCode;" +
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
    // AND "WITH the migration" means the database as it was right AFTER it --
    // so every LATER migration is skipped as well. Without this the
    // "nothing else in the schema moved" comparison below measures every
    // migration added after this one, and fails the moment the next one lands
    // (first exposed by Cash Drawer 1B, 20261002120000). Narrowed, not weakened:
    // it still proves exactly what this migration changed.
    if (withMigration && file > MIGRATION) continue;
    if (STORAGE_ONLY_MIGRATIONS.has(file)) continue;

    runSqlFile(name, join(migrationsDir, file));
    sql(name,
      `insert into supabase_migrations.schema_migrations(version, name)
       values ('${file.split("_")[0]}', '${file}') on conflict do nothing`);
  }
}

// ---------------------------------------------------------------------------
// Callers
// ---------------------------------------------------------------------------

/**
 * Runs `statement` as the REAL `authenticated` role, with the JWT subject set.
 * An empty `who` leaves auth.uid() null -- an unauthenticated request.
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
// Fixtures: one shop whose codes are chosen to catch the likely mistakes, and
// a second shop that reuses `001` so a cross-wired code has somewhere to come from
// ---------------------------------------------------------------------------

const OWNER_USER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "a0000000-0000-4000-8000-000000000001";
const BUILD = "b0000000-0000-4000-8000-000000000001";
const DEVICE_USER = "d0000000-0000-4000-8000-000000000001";
const DEVICE = "c0000000-0000-4000-8000-000000000001";

const OTHER_OWNER_USER = "22222222-2222-4222-8222-222222222222";
const OTHER_PROJECT = "a0000000-0000-4000-8000-000000000002";

/**
 * Owns a project AND is the auth user of that project's paired till. The only
 * caller for whom the paired-device refusal is load-bearing: every other till
 * is also refused by the owner check, so removing the device check would go
 * unnoticed without this one.
 */
const DUAL_USER = "44444444-4444-4444-8444-444444444444";
const DUAL_PROJECT = "a0000000-0000-4000-8000-000000000004";
const DUAL_BUILD = "b0000000-0000-4000-8000-000000000004";
const DUAL_DEVICE = "c0000000-0000-4000-8000-000000000004";
const DUAL_EMPLOYEE = "e0000008-0000-4000-8000-000000000008";

/** Authenticated, owns nothing, is not a till. */
const STRANGER = "33333333-3333-4333-8333-333333333333";

// `AMY` and `FAY` share a created_at, so the accepted `order by created_at, id`
// tie-break is exercised too.
const AMY = "e0000001-0000-4000-8000-00000000000a";
const FAY = "e0000002-0000-4000-8000-00000000000b";
const BO = "e0000003-0000-4000-8000-00000000000c";
const CLEO = "e0000004-0000-4000-8000-00000000000d";
/** Deactivated, keeps its historical code. */
const DEE = "e0000005-0000-4000-8000-00000000000e";
/** Left before Employee IDs existed: inactive, and legitimately no code. */
const ED = "e0000006-0000-4000-8000-00000000000f";
const ZED = "e0000009-0000-4000-8000-000000000009";

const EXPECTED_CODES: Record<string, string | null> = {
  [AMY]: "001",
  [FAY]: "002",
  [BO]: "025",
  [CLEO]: "999",
  [DEE]: "010",
  [ED]: null,
};

const MENU = JSON.stringify({ menuItems: [] });

function seed(db: string): void {
  sql(db, `
    insert into auth.users (id) values
      ('${OWNER_USER}'), ('${DEVICE_USER}'), ('${OTHER_OWNER_USER}'), ('${STRANGER}'), ('${DUAL_USER}');

    insert into public.projects (id, user_id, name, template_id, config)
    values ('${PROJECT}', '${OWNER_USER}', 'Shop', 'cafe', '${MENU}'::jsonb),
           ('${OTHER_PROJECT}', '${OTHER_OWNER_USER}', 'Other Shop', 'cafe', '${MENU}'::jsonb),
           ('${DUAL_PROJECT}', '${DUAL_USER}', 'Dual Shop', 'cafe', '${MENU}'::jsonb);

    insert into public.build_jobs (id, project_id, owner_id, target, status, config_snapshot,
                                   config_schema_version, config_hash, request_key, started_at, finished_at)
    values ('${BUILD}','${PROJECT}','${OWNER_USER}','android','succeeded','${MENU}'::jsonb,1,'h','r', now(), now()),
           ('${DUAL_BUILD}','${DUAL_PROJECT}','${DUAL_USER}','android','succeeded','${MENU}'::jsonb,1,'h4','r4', now(), now());

    insert into public.paired_devices (id, auth_user_id, owner_id, project_id, build_job_id, created_at)
    values ('${DEVICE}','${DEVICE_USER}','${OWNER_USER}','${PROJECT}','${BUILD}', now() - interval '30 days'),
           ('${DUAL_DEVICE}','${DUAL_USER}','${DUAL_USER}','${DUAL_PROJECT}','${DUAL_BUILD}', now() - interval '30 days');

    insert into public.employees
      (id, project_id, display_name, employee_code, role, pin_hash, active, created_at, deactivated_at)
    values
      ('${AMY}','${PROJECT}','Amy','001','cashier', public.employee_pin_hash('2222'), true,  '2026-01-01T09:00:00Z', null),
      ('${FAY}','${PROJECT}','Fay','002','cashier', public.employee_pin_hash('2323'), true,  '2026-01-01T09:00:00Z', null),
      ('${BO}','${PROJECT}','Bo','025','manager',   public.employee_pin_hash('3333'), true,  '2026-01-02T09:00:00Z', null),
      ('${CLEO}','${PROJECT}','Cleo','999','owner', public.employee_pin_hash('4444'), true,  '2026-01-03T09:00:00Z', null),
      ('${DEE}','${PROJECT}','Dee','010','cashier', public.employee_pin_hash('5555'), false, '2026-01-04T09:00:00Z', '2026-02-01T17:00:00Z'),
      ('${ED}','${PROJECT}','Ed', null,'cashier',   public.employee_pin_hash('6666'), false, '2025-06-01T09:00:00Z', '2025-08-01T17:00:00Z'),
      ('${ZED}','${OTHER_PROJECT}','Zed','001','owner', public.employee_pin_hash('7777'), true, '2026-01-01T09:00:00Z', null),
      ('${DUAL_EMPLOYEE}','${DUAL_PROJECT}','Dua','001','owner', public.employee_pin_hash('9999'), true, '2026-01-01T09:00:00Z', null);
  `);
}

const DB = "listcode";
/** The same fixtures, with every migration BEFORE this one applied. */
const DB_BEFORE = "listcodebefore";

beforeAll(() => {
  if (PG_BIN === null) return;

  dataDir = mkdtempSync(join(tmpdir(), "pos-canvas-5b-"));
  pg("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust"]);
  pg("pg_ctl", [
    "-D", dataDir, "-l", join(dataDir, "server.log"), "-w", "start",
    "-o", `-c listen_addresses=127.0.0.1 -c port=${PORT} -c unix_socket_directories=''`,
  ]);
  freshDatabase(DB, true);
  freshDatabase(DB_BEFORE, false);
  seed(DB);
  seed(DB_BEFORE);
}, 900_000);

afterAll(() => {
  if (PG_BIN === null) return;
  try { pg("pg_ctl", ["-D", dataDir, "-m", "immediate", "-w", "stop"]); }
  finally { rmSync(dataDir, { recursive: true, force: true }); }
}, 900_000);

const maybe = PG_BIN === null ? describe.skip : describe;

type Row = Record<string, unknown>;

/** The raw jsonb text list_employees returns, called as the real `authenticated` role. */
function listText(db: string, who: string, project: string | null): string {
  const arg = project === null ? "null" : `'${project}'`;

  return asAuthenticated(db, who, `select (public.list_employees(${arg}))::text`);
}

const list = (db: string, who: string, project: string | null): Row =>
  JSON.parse(listText(db, who, project));

const rowsOf = (result: Row): Row[] => result.employees as Row[];

const byId = (rows: Row[], id: string): Row => {
  const row = rows.find((r) => r.employeeId === id);

  if (row === undefined) throw new Error(`no row for ${id}`);

  return row;
};

// ---------------------------------------------------------------------------
// 1-4. The owner reads each employee's code, as text, on the right row
// ---------------------------------------------------------------------------

maybe("the owner's roster carries each employee's Employee ID", () => {
  it("returns employeeCode on every row of the owner's project", () => {
    const result = list(DB, OWNER_USER, PROJECT);

    expect(result.ok).toBe(true);
    expect(rowsOf(result)).toHaveLength(6);

    for (const row of rowsOf(result)) {
      expect(Object.keys(row)).toContain("employeeCode");
    }
  });

  it('"001" stays the STRING "001" -- in the parsed value and on the wire', () => {
    const text = listText(DB, OWNER_USER, PROJECT);
    const amy = byId(rowsOf(JSON.parse(text)), AMY);

    expect(amy.employeeCode).toBe("001");
    expect(typeof amy.employeeCode).toBe("string");
    expect(amy.employeeCode).not.toBe(1);
    // The jsonb text itself, so a numeric coercion cannot hide behind JSON.parse.
    expect(text).toContain(`"employeeCode": "001"`);
    expect(text).not.toMatch(/"employeeCode": \d/);
    expect(byId(rowsOf(JSON.parse(text)), BO).employeeCode).toBe("025");
  });

  it("every code is on its own employee's row, and no other", () => {
    const rows = rowsOf(list(DB, OWNER_USER, PROJECT));
    const actual = Object.fromEntries(rows.map((r) => [r.employeeId, r.employeeCode]));

    expect(actual).toEqual(EXPECTED_CODES);
    // And it agrees with the table, row by row, rather than with this file.
    const stored = sql(DB, `
      select string_agg(id::text || '=' || coalesce(employee_code, 'NULL'), ',' order by id)
      from public.employees where project_id = '${PROJECT}'`);
    const returned = [...rows]
      .sort((a, b) => String(a.employeeId).localeCompare(String(b.employeeId)))
      .map((r) => `${r.employeeId}=${r.employeeCode ?? "NULL"}`)
      .join(",");

    expect(returned).toBe(stored);
  });

  it("a deactivated employee keeps showing their historical code", () => {
    const dee = byId(rowsOf(list(DB, OWNER_USER, PROJECT)), DEE);

    expect(dee.active).toBe(false);
    expect(dee.employeeCode).toBe("010");
  });

  it("a pre-Employee-ID leaver is JSON null -- not blank, not invented", () => {
    const text = listText(DB, OWNER_USER, PROJECT);
    const ed = byId(rowsOf(JSON.parse(text)), ED);

    expect(ed.active).toBe(false);
    expect(ed.employeeCode).toBeNull();
    expect(text).not.toContain(`"employeeCode": ""`);
  });
});

// ---------------------------------------------------------------------------
// 9. Every existing field is exactly what it was
// ---------------------------------------------------------------------------

maybe("the existing list fields are unchanged", () => {
  it("each row has exactly the six accepted keys plus employeeCode", () => {
    for (const row of rowsOf(list(DB, OWNER_USER, PROJECT))) {
      expect(Object.keys(row).sort()).toEqual(
        ["active", "createdAt", "deactivatedAt", "displayName", "employeeCode", "employeeId", "role"]
      );
    }
  });

  it("minus employeeCode, the answer is identical to the accepted function's -- values and order", () => {
    const before = list(DB_BEFORE, OWNER_USER, PROJECT);
    const after = list(DB, OWNER_USER, PROJECT);

    // Sanity: the BEFORE database really is the accepted contract.
    for (const row of rowsOf(before)) expect(Object.keys(row)).not.toContain("employeeCode");

    const stripped = rowsOf(after).map((row) =>
      Object.fromEntries(Object.entries(row).filter(([key]) => key !== "employeeCode"))
    );

    expect(stripped).toEqual(rowsOf(before));
    expect(rowsOf(after).map((r) => r.employeeId)).toEqual([ED, AMY, FAY, BO, CLEO, DEE]);
  });

  it("every refusal is byte-identical to the accepted function's", () => {
    for (const [who, project] of [
      ["", PROJECT],
      [DEVICE_USER, PROJECT],
      [STRANGER, PROJECT],
      [OTHER_OWNER_USER, PROJECT],
      [OWNER_USER, null],
      [OWNER_USER, "a0000000-0000-4000-8000-0000000000ff"],
    ] as const) {
      expect(listText(DB, who, project)).toBe(listText(DB_BEFORE, who, project));
    }
  });
});

// ---------------------------------------------------------------------------
// 5-7. Authorization is exactly what it was
// ---------------------------------------------------------------------------

maybe("authorization is unchanged", () => {
  const refused = { ok: false, error: "not_found" };

  it("another project's owner is refused, and learns nothing", () => {
    expect(list(DB, OTHER_OWNER_USER, PROJECT)).toEqual(refused);
  });

  it("a project owner sees only their own project's codes", () => {
    const rows = rowsOf(list(DB, OTHER_OWNER_USER, OTHER_PROJECT));

    expect(rows.map((r) => [r.employeeId, r.employeeCode])).toEqual([[ZED, "001"]]);
    // Same code, different shop: the owner's own `001` is still Amy.
    expect(byId(rowsOf(list(DB, OWNER_USER, PROJECT)), AMY).employeeCode).toBe("001");
    expect(rowsOf(list(DB, OWNER_USER, PROJECT)).map((r) => r.employeeId)).not.toContain(ZED);
  });

  it("an authenticated stranger is refused", () => {
    expect(list(DB, STRANGER, PROJECT)).toEqual(refused);
  });

  it("a PAIRED DEVICE of this very project is refused", () => {
    expect(list(DB, DEVICE_USER, PROJECT)).toEqual(refused);
  });

  it("a till is refused EVEN WHEN its auth user owns the project", () => {
    // Sanity: the owner check alone would admit this caller.
    expect(sql(DB, `select user_id from public.projects where id = '${DUAL_PROJECT}'`)).toBe(DUAL_USER);
    expect(list(DB, DUAL_USER, DUAL_PROJECT)).toEqual(refused);
    expect(listText(DB, DUAL_USER, DUAL_PROJECT)).toBe(listText(DB_BEFORE, DUAL_USER, DUAL_PROJECT));
  });

  it("an unauthenticated caller is refused", () => {
    expect(list(DB, "", PROJECT)).toEqual({ ok: false, error: "not_authenticated" });
  });

  it("a null or unknown project is refused", () => {
    expect(list(DB, OWNER_USER, null)).toEqual(refused);
    expect(list(DB, OWNER_USER, "a0000000-0000-4000-8000-0000000000ff")).toEqual(refused);
  });

  it("EXECUTE is authenticated only: not anon, not service_role, not PUBLIC", () => {
    const privilege = (role: string) =>
      sql(DB, `select has_function_privilege('${role}', 'public.list_employees(uuid)', 'execute')`);

    expect(privilege("authenticated")).toBe("t");
    expect(privilege("anon")).toBe("f");
    expect(privilege("service_role")).toBe("f");
    expect(sql(DB, `
      select exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                     where p.oid = 'public.list_employees(uuid)'::regprocedure and a.grantee = 0)`)).toBe("f");
  });

  it("the function's security posture is identical before and after", () => {
    const posture = (db: string) => sql(db, `
      select p.prosecdef, p.provolatile, p.prorettype::regtype, p.proconfig, p.proacl, pg_get_userbyid(p.proowner)
      from pg_proc p where p.oid = 'public.list_employees(uuid)'::regprocedure`);

    expect(posture(DB)).toBe(posture(DB_BEFORE));
    expect(posture(DB)).toBe("t|s|jsonb|{\"search_path=public, pg_temp\"}|{postgres=X/postgres,authenticated=X/postgres}|postgres");
    expect(sql(DB, `select count(*) from pg_proc where proname = 'list_employees'`)).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// 8. No credential material
// ---------------------------------------------------------------------------

maybe("no PIN or PIN hash is exposed", () => {
  it("no key names a PIN, a hash or a secret", () => {
    for (const row of rowsOf(list(DB, OWNER_USER, PROJECT))) {
      for (const key of Object.keys(row)) {
        expect(key.toLowerCase()).not.toMatch(/pin|hash|secret|salt|crypt/);
      }
    }
  });

  it("no stored hash appears anywhere in the answer", () => {
    const text = listText(DB, OWNER_USER, PROJECT);
    const hashes = sql(DB, `select pin_hash from public.employees where project_id = '${PROJECT}'`)
      .split("\n")
      .filter((h) => h !== "");

    expect(hashes).toHaveLength(6);
    for (const hash of hashes) expect(text).not.toContain(hash);
    expect(text).not.toContain("$2");
    // And the plaintext PINs, which the database never had to begin with.
    for (const pin of ["2222", "2323", "3333", "4444", "5555", "6666"]) expect(text).not.toContain(pin);
  });
});

// ---------------------------------------------------------------------------
// The migration touched this one function and nothing else
// ---------------------------------------------------------------------------

maybe("nothing else in the schema moved", () => {
  it("list_employees is the ONLY public function whose definition changed", () => {
    const definitions = (db: string) => sql(db, `
      select string_agg(p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid)), E'\\n'
                        order by p.oid::regprocedure::text)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f'`);
    const toMap = (text: string) => new Map(text.split("\n").map((l) => l.split(":") as [string, string]));

    const before = toMap(definitions(DB_BEFORE));
    const after = toMap(definitions(DB));
    const changed = [...after.keys()].filter((k) => before.get(k) !== after.get(k));

    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    expect(changed).toEqual(["list_employees(uuid)"]);
  });

  it("no table, column, constraint, table grant or RLS setting changed", () => {
    const shape = (db: string) => sql(db, `
      select md5(string_agg(x, E'\\n' order by x)) from (
        select 'col:' || table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') as x
          from information_schema.columns where table_schema = 'public'
        union all
        select 'con:' || conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid)
          from pg_constraint where connamespace = 'public'::regnamespace
        union all
        select 'rel:' || c.relname || ':' || coalesce(c.relacl::text, '') || ':' || c.relrowsecurity::text || ':' || c.relforcerowsecurity::text
          from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'p')
        union all
        select 'pol:' || tablename || ':' || policyname || ':' || coalesce(qual, '') from pg_policies where schemaname = 'public'
        union all
        select 'idx:' || indexname || ':' || indexdef from pg_indexes where schemaname = 'public'
      ) s`);

    expect(shape(DB)).toBe(shape(DB_BEFORE));
    expect(sql(DB, `select has_table_privilege('authenticated', 'public.employees', 'select')`)).toBe("f");
    expect(sql(DB, `select relrowsecurity from pg_class where oid = 'public.employees'::regclass`)).toBe("t");
  });
});

// ---------------------------------------------------------------------------
// 10. create_employee and set_employee_code behave as they did, and the list
//     reflects them. LAST, because it adds and renumbers employees.
// ---------------------------------------------------------------------------

maybe("create_employee and set_employee_code are intact and visible through the list", () => {
  const GUS_CODE = "007";

  const call = (who: string, statement: string): Row =>
    JSON.parse(asAuthenticated(DB, who, `select (${statement})::text`));

  let gus = "";

  it("create_employee still returns the code it stored, as text", () => {
    const created = call(OWNER_USER,
      `public.create_employee('${PROJECT}', 'Gus', 'cashier', '${GUS_CODE}', '8888')`);

    expect(created.ok).toBe(true);
    expect(created.employeeCode).toBe(GUS_CODE);
    gus = created.employeeId as string;
  });

  it("and a fresh list load now shows that code on that employee", () => {
    expect(byId(rowsOf(list(DB, OWNER_USER, PROJECT)), gus).employeeCode).toBe(GUS_CODE);
  });

  it("set_employee_code reassigns, and the list follows -- for that employee only", () => {
    const set = call(OWNER_USER, `public.set_employee_code('${gus}', '070')`);

    expect(set).toMatchObject({ ok: true, employeeId: gus, employeeCode: "070" });

    const rows = rowsOf(list(DB, OWNER_USER, PROJECT));

    expect(byId(rows, gus).employeeCode).toBe("070");
    for (const [id, code] of Object.entries(EXPECTED_CODES)) expect(byId(rows, id).employeeCode).toBe(code);
  });

  it("the accepted refusals are unchanged", () => {
    expect(call(OWNER_USER, `public.set_employee_code('${gus}', '001')`))
      .toEqual({ ok: false, error: "employee_code_taken" });
    expect(call(OWNER_USER, `public.set_employee_code('${gus}', '000')`))
      .toEqual({ ok: false, error: "invalid_employee_code" });
    expect(call(OWNER_USER, `public.create_employee('${PROJECT}', 'Hal', 'cashier', '000', '1234')`))
      .toEqual({ ok: false, error: "invalid_employee_code" });
    expect(call(DEVICE_USER, `public.set_employee_code('${gus}', '071')`))
      .toEqual({ ok: false, error: "not_found" });
    expect(call(OTHER_OWNER_USER, `public.set_employee_code('${gus}', '071')`))
      .toEqual({ ok: false, error: "not_found" });
    expect(byId(rowsOf(list(DB, OWNER_USER, PROJECT)), gus).employeeCode).toBe("070");
  });
});
