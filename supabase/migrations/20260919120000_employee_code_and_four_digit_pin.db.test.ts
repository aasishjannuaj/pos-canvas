// v1.3 Feature 1B-RUNTIME checkpoint 1 — the migration EXECUTED against a real
// PostgreSQL, not read.
//
// WHY THIS FILE EXISTS. Its sibling `.test.ts` parses the SQL and asserts what
// it declares. That cannot show a single one of the behaviours this feature was
// actually specified in terms of: whether the backfill's tie-breaker really
// falls to the UUID, whether 1000 active employees fail ATOMICALLY, whether a
// reissued Employee ID really refuses a reactivation, or whether an unknown ID
// and a wrong PIN really come back indistinguishable. Those are runtime facts.
// Reading text can only ever assert that somebody wrote something that looks
// like them.
//
// HOW IT RUNS, AND WHAT IT COSTS. It creates a throwaway cluster in the OS temp
// directory on a loopback port, applies the repository's own migration files in
// order, runs the cases, and destroys the cluster. It adds NO dependency: it
// shells out to the `initdb`/`pg_ctl`/`psql` already installed alongside
// PostgreSQL. There is no Docker, no service container and no CI change.
//
// AND WHAT IT CANNOT DO. It needs a PostgreSQL SERVER on the machine. The repo
// has never had a test that touches a database — every other migration test is
// static — and no CI workflow runs the suite or provides PostgreSQL. So when no
// server is found this suite SKIPS LOUDLY rather than failing, and `npm test`
// stays runnable on a machine without PostgreSQL, exactly as it is today.
// Guaranteeing it always runs needs a CI test job with a PostgreSQL service,
// which is infrastructure to be authorized separately.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20260919120000_employee_code_and_four_digit_pin.sql";

// ---------------------------------------------------------------------------
// Finding PostgreSQL
// ---------------------------------------------------------------------------

/**
 * The bin directory holding initdb, pg_ctl and psql, or null.
 *
 * PATH first, because a developer who put PostgreSQL on their PATH meant it.
 * The rest are the ordinary install prefixes on the platforms this repository
 * is developed on; none of them is treated as authoritative, and a miss is not
 * an error.
 */
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

  // ALL THREE, not just initdb and psql: the cluster is started and stopped
  // with pg_ctl, so a directory missing it would be accepted here and then fail
  // in beforeAll with something far less obvious than "no PostgreSQL found".
  return candidates.find(isCompletePostgresBin) ?? null;
}

const PG_BIN = findPostgresBin();
const PORT = 55500 + (process.pid % 400);

if (PG_BIN === null) {
  console.warn(
    `\n[${MIGRATION}] SKIPPED: no local PostgreSQL server found.` +
      "\n  These are the only tests that EXECUTE the migration; the static guards" +
      "\n  in the sibling .test.ts still ran. Install PostgreSQL 16+ to run them.\n"
  );
}

// ---------------------------------------------------------------------------
// The compatibility layer: ONLY what Supabase provides and vanilla does not
// ---------------------------------------------------------------------------

const COMPAT = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

-- Supabase's default privileges on public. This matters: it is why a new table
-- is born with ALL granted to the three roles, which is exactly what every
-- migration's revokes exist to undo. Without it the revokes are no-ops and the
-- migrations' own assertions would pass trivially.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create schema auth;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  created_at timestamptz not null default now()
);

-- auth.uid() as Supabase defines it: it reads the request JWT claim, which is
-- how these tests choose who is calling.
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

-- pgcrypto in "extensions", the same placement staging has, and the reason the
-- migration discovers the extension's schema instead of hardcoding it.
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

/** Runs SQL in `db` and returns unaligned, tuples-only output. */
function sql(db: string, statement: string): string {
  return pg("psql", [
    "-h", "127.0.0.1", "-p", String(PORT), "-U", "postgres", "-d", db,
    "-v", "ON_ERROR_STOP=1", "-Atq", "-c", statement,
  ]).trim();
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
 * Neither touches employees, projects, devices, registers or orders, so their
 * absence cannot affect anything asserted in this file.
 *
 * EXACT FILENAMES, NOT A SUBSTRING MATCH. "contains the word storage" would
 * also match 20260803240000_order_counter_and_idempotency_scaffold.sql, which
 * applies perfectly well and whose failure must never be ignored.
 */
export const STORAGE_ONLY_MIGRATIONS = new Set([
  "20260729190422_build_artifact_storage.sql",
  "20260813120000_project_logo_storage.sql",
]);

/**
 * Applies one .sql file. THROWS on any failure, deliberately.
 *
 * There is no catch here and no catch at the call site. A predecessor that
 * fails leaves an incomplete schema, and every behavioural assertion below
 * would then be measuring the wrong database while reporting success -- which
 * is worse than no coverage, because it looks like coverage.
 */
function runSqlFile(db: string, file: string): void {
  pg("psql", [
    "-h", "127.0.0.1", "-p", String(PORT), "-U", "postgres", "-d", db,
    "-v", "ON_ERROR_STOP=1", "-q", "-f", file,
  ]);
}

/**
 * A database with every accepted migration applied and NOT the new one.
 */
function freshDatabase(name: string, withMigration: boolean): void {
  sql("postgres", `drop database if exists ${name}`);
  sql("postgres", `create database ${name}`);
  pg("psql", ["-h", "127.0.0.1", "-p", String(PORT), "-U", "postgres", "-d", name, "-q", "-f", "-"], COMPAT);

  const files = execFileSync("ls", [migrationsDir], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (file === MIGRATION && !withMigration) continue;

    // Skipped BEFORE it is attempted, by exact name. Anything else that fails
    // propagates and fails the suite.
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
    pg("psql", [
      "-h", "127.0.0.1", "-p", String(PORT), "-U", "postgres", "-d", db,
      "-v", "ON_ERROR_STOP=1", "--single-transaction", "-q",
      "-f", join(migrationsDir, MIGRATION),
    ]);
    return { ok: true, error: "" };
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    return { ok: false, error: (err.stderr ?? err.message ?? "").toString() };
  }
}

const OWNER = "11111111-1111-4111-8111-111111111111";

/**
 * Runs `statement` with auth.uid() bound to `who`, returning only its result.
 *
 * psql prints one result set per statement, and setting the claim is itself a
 * statement, so the caller would otherwise read the uuid back instead of the
 * answer. Taking the last line is what makes "call this RPC as that person"
 * read as one thing.
 */
function asRole(db: string, who: string, statement: string): string {
  const out = sql(db, `select set_config('request.jwt.claim.sub','${who}', false); ${statement}`);
  const lines = out.split("\n").filter((line) => line !== "");

  return lines[lines.length - 1] ?? "";
}

/** One project with `count` active employees, created one second apart. */
function seedProject(db: string, project: string, count: number, prefix = "E"): void {
  sql(db, `
    insert into auth.users (id) values ('${OWNER}') on conflict do nothing;
    insert into public.projects (id, user_id, name, template_id, config)
    values ('${project}', '${OWNER}', 'P', 'cafe', '{}'::jsonb) on conflict do nothing;
    insert into public.employees (project_id, display_name, role, pin_hash, active, created_at)
    select '${project}', '${prefix}' || g, 'cashier',
           public.employee_pin_hash('1234'), true,
           timestamptz '2026-01-01 00:00:00+00' + (g || ' seconds')::interval
    from generate_series(1, ${count}) g;
  `);
}

const run = PG_BIN === null ? describe.skip : describe;

beforeAll(() => {
  if (PG_BIN === null) return;

  dataDir = mkdtempSync(join(tmpdir(), "pos-canvas-pg-"));
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
    // Already gone; the directory removal below is what matters.
  }

  rmSync(dataDir, { recursive: true, force: true });
}, 60_000);

// ===========================================================================
// The harness itself
// ===========================================================================

describe("the harness cannot quietly test an incomplete schema", () => {
  it("skips exactly two predecessors, both Storage-only, named in full", () => {
    expect([...STORAGE_ONLY_MIGRATIONS].sort()).toEqual([
      "20260729190422_build_artifact_storage.sql",
      "20260813120000_project_logo_storage.sql",
    ]);
  });

  it("both named files exist, so the allowlist cannot rot into a no-op", () => {
    for (const file of STORAGE_ONLY_MIGRATIONS) {
      expect(existsSync(join(migrationsDir, file))).toBe(true);
    }
  });

  it("no migration carrying product behaviour is on the list", () => {
    // Including the one a substring match on "storage" would have caught by
    // mistake: it applies fine, and ignoring its failure would be a hole.
    for (const file of [
      "20260803240000_order_counter_and_idempotency_scaffold.sql",
      "20260914120000_employee_identity_and_pos_sessions.sql",
      "20260916120000_employee_selector_single_hash_login.sql",
      "20260916130000_remove_active_employee_engineering_ceiling.sql",
      "20260917120000_register_sessions_and_sale_attribution.sql",
      MIGRATION,
    ]) {
      expect(`${file} skipped: ${STORAGE_ONLY_MIGRATIONS.has(file)}`).toBe(`${file} skipped: false`);
    }
  });

  it("the loop has no catch, so nothing else can be swallowed", () => {
    // Read from this file's own source: a future edit that reintroduces a
    // try/catch around the predecessor loop fails here.
    const source = readFileSync(fileURLToPath(import.meta.url), "utf-8");
    const loop = source.slice(
      source.indexOf("function freshDatabase("),
      source.indexOf("/** Applies ONLY the new migration")
    );

    expect(loop).not.toContain("catch");
    expect(loop).toContain("STORAGE_ONLY_MIGRATIONS.has(file)");
  });

  it("a failing predecessor really does throw", () => {
    if (PG_BIN === null) return;

    // The proof, executed: a deliberately broken .sql run through the same
    // helper the loop uses must raise, not return.
    const broken = join(tmpdir(), `f1brt-broken-${process.pid}.sql`);

    writeFileSync(broken, "select * from a_table_that_does_not_exist;\n");

    try {
      sql("postgres", "select 1");
      expect(() => runSqlFile("postgres", broken)).toThrow();
    } finally {
      rmSync(broken, { force: true });
    }
  });

  it("a complete PostgreSQL install needs all three binaries", () => {
    expect([...REQUIRED_BINARIES]).toEqual(["initdb", "pg_ctl", "psql"]);
    // A directory with none of them is never accepted.
    expect(isCompletePostgresBin(tmpdir())).toBe(false);
  });
});

// ===========================================================================
// 1-6. The backfill, and the namespace it has to fit inside
// ===========================================================================

run("the backfill, executed", () => {
  const DB = "f1brt_backfill";
  const A = "aaaa0001-0000-4000-8000-000000000001";
  const B = "aaaa0002-0000-4000-8000-000000000001";

  beforeAll(() => {
    freshDatabase(DB, false);

    // Project A: Zoe and Amy share a created_at so the UUID tie-breaker is
    // genuinely exercised, Bob is later, and a leaver predates all of them.
    sql(DB, `
      insert into auth.users (id) values ('${OWNER}') on conflict do nothing;
      insert into public.projects (id, user_id, name, template_id, config) values
        ('${A}', '${OWNER}', 'A', 'cafe', '{}'::jsonb),
        ('${B}', '${OWNER}', 'B', 'cafe', '{}'::jsonb);
      insert into public.employees (id, project_id, display_name, role, pin_hash, active, deactivated_at, created_at) values
        ('e0000001-0000-4000-8000-00000000000b','${A}','Zoe','cashier', public.employee_pin_hash('1111'), true, null, '2026-01-01 10:00:00+00'),
        ('e0000001-0000-4000-8000-00000000000a','${A}','Amy','cashier', public.employee_pin_hash('2222'), true, null, '2026-01-01 10:00:00+00'),
        ('e0000001-0000-4000-8000-00000000000c','${A}','Bob','manager', public.employee_pin_hash('3333'), true, null, '2026-02-01 10:00:00+00'),
        ('e0000001-0000-4000-8000-00000000000d','${A}','Gone','cashier', public.employee_pin_hash('4444'), false, now(), '2025-01-01 10:00:00+00'),
        ('e0000002-0000-4000-8000-00000000000a','${B}','Cy','cashier', public.employee_pin_hash('5555'), true, null, '2026-03-01 10:00:00+00'),
        ('e0000002-0000-4000-8000-00000000000b','${B}','Di','cashier', public.employee_pin_hash('6666'), true, null, '2026-03-02 10:00:00+00');
    `);

    expect(applyMigration(DB).ok).toBe(true);
  }, 180_000);

  it("1. numbers by created_at, then by id — the UUID really is the tie-breaker", () => {
    // Amy and Zoe share a timestamp. Amy's id sorts first, so Amy is 001. Had
    // this ordered by display_name the answer would be the same by accident, so
    // Bob (later created_at, alphabetically second) is what proves it is not
    // alphabetical.
    expect(sql(DB, `select display_name || '=' || employee_code from public.employees
                    where project_id='${A}' and active order by employee_code`))
      .toBe("Amy=001\nZoe=002\nBob=003");
  });

  it("2. numbering restarts per project", () => {
    expect(sql(DB, `select display_name || '=' || employee_code from public.employees
                    where project_id='${B}' and active order by employee_code`))
      .toBe("Cy=001\nDi=002");
  });

  it("3. the leading zero survives — it is text, not a number", () => {
    expect(sql(DB, `select employee_code from public.employees where display_name='Amy'`)).toBe("001");
    expect(sql(DB, `select pg_typeof(employee_code)::text from public.employees where display_name='Amy'`)).toBe("text");
  });

  it("an inactive leaver is given no code, so it reserves no number", () => {
    expect(sql(DB, `select coalesce(employee_code,'<none>') from public.employees where display_name='Gone'`))
      .toBe("<none>");
  });
});

run("the 999 namespace, executed", () => {
  it("4. 999 active employees succeed, numbered 001..999 with no duplicates", () => {
    const DB = "f1brt_999";

    freshDatabase(DB, false);
    seedProject(DB, "aaaa0999-0000-4000-8000-000000000001", 999);

    expect(applyMigration(DB).ok).toBe(true);
    expect(sql(DB, `select min(employee_code) || '..' || max(employee_code) || ' n=' || count(*)
                    from public.employees where active`)).toBe("001..999 n=999");
    expect(sql(DB, `select count(*) from (
                      select employee_code from public.employees where active
                      group by project_id, employee_code having count(*) > 1) d`)).toBe("0");
  }, 300_000);

  it("5 + 6. 1000 fails, and the schema is not half-applied", () => {
    const DB = "f1brt_1000";

    freshDatabase(DB, false);
    seedProject(DB, "aaaa1000-0000-4000-8000-000000000001", 1000);

    const result = applyMigration(DB);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("three-digit Employee ID namespace holds 999");

    // ATOMICITY: the column is added before the guard fires, so if the failure
    // were not atomic it would survive. It must not.
    expect(sql(DB, `select count(*) from information_schema.columns
                    where table_schema='public' and table_name='employees'
                      and column_name='employee_code'`)).toBe("0");
    expect(sql(DB, `select count(*) from pg_indexes
                    where schemaname='public' and indexname='employees_active_project_code_key'`)).toBe("0");
    expect(sql(DB, `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='employee_login_by_code'`)).toBe("0");
  }, 300_000);
});

run("the live index really is the intended one", () => {
  // `create unique index IF NOT EXISTS` will happily adopt an index that
  // already carries the name. These prove the migration's own verification
  // refuses every wrong shape rather than inheriting it.
  const DECOYS: Array<[string, string]> = [
    [
      "keyed on the wrong columns",
      `create unique index employees_active_project_code_key
         on public.employees (project_id, display_name) where active`,
    ],
    [
      "keyed in the wrong order",
      `create unique index employees_active_project_code_key
         on public.employees (employee_code, project_id) where active`,
    ],
    [
      "not partial, so a leaver's code would block the next hire",
      `create unique index employees_active_project_code_key
         on public.employees (project_id, employee_code)`,
    ],
    [
      "partial on the wrong predicate",
      `create unique index employees_active_project_code_key
         on public.employees (project_id, employee_code) where not active`,
    ],
    [
      "not unique at all",
      `create index employees_active_project_code_key
         on public.employees (project_id, employee_code) where active`,
    ],
  ];

  for (const [label, decoy] of DECOYS) {
    it(`rejects a same-named index ${label}`, () => {
      const DB = `f1brt_decoy_${DECOYS.findIndex(([l]) => l === label)}`;

      freshDatabase(DB, false);
      seedProject(DB, "aaaa0007-0000-4000-8000-000000000001", 2);
      // The decoy needs the column to exist, so it is planted in the same shape
      // the migration would find it: column present, index already named.
      sql(DB, `alter table public.employees add column employee_code text`);
      sql(DB, `update public.employees e set employee_code = n.code
               from (select id, lpad(row_number() over (order by created_at, id)::text, 3, '0') as code
                     from public.employees) n where e.id = n.id`);
      sql(DB, decoy);

      const result = applyMigration(DB);

      expect(`${label}: ${result.ok}`).toBe(`${label}: false`);
      expect(result.error).toContain("employees_active_project_code_key");
    }, 300_000);
  }

  it("and accepts the real one", () => {
    const DB = "f1brt_index_ok";

    freshDatabase(DB, false);
    seedProject(DB, "aaaa0008-0000-4000-8000-000000000001", 2);

    expect(applyMigration(DB).ok).toBe(true);
    expect(sql(DB, `select array_to_string(array(
                      select a.attname::text
                      from pg_index i
                      join unnest(i.indkey::smallint[]) with ordinality as k(attnum, ord) on true
                      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
                      where i.indexrelid = 'public.employees_active_project_code_key'::regclass
                      order by k.ord), ',')`)).toBe("project_id,employee_code");
  }, 300_000);
});

// ===========================================================================
// 7-10. Uniqueness and lifecycle
// ===========================================================================

run("uniqueness and lifecycle, executed", () => {
  const DB = "f1brt_unique";
  const A = "aaaa0001-0000-4000-8000-000000000001";
  const B = "aaaa0002-0000-4000-8000-000000000001";
  const LEAVER = "e0000001-0000-4000-8000-00000000000d";

  beforeAll(() => {
    freshDatabase(DB, false);
    sql(DB, `
      insert into auth.users (id) values ('${OWNER}') on conflict do nothing;
      insert into public.projects (id, user_id, name, template_id, config) values
        ('${A}', '${OWNER}', 'A', 'cafe', '{}'::jsonb),
        ('${B}', '${OWNER}', 'B', 'cafe', '{}'::jsonb);
      insert into public.employees (id, project_id, display_name, role, pin_hash, active, deactivated_at) values
        ('e0000001-0000-4000-8000-00000000000a','${A}','Amy','cashier', public.employee_pin_hash('2222'), true, null),
        ('e0000001-0000-4000-8000-00000000000b','${A}','Zoe','cashier', public.employee_pin_hash('1111'), true, null),
        ('${LEAVER}','${A}','Gone','cashier', public.employee_pin_hash('4444'), false, now()),
        ('e0000002-0000-4000-8000-00000000000a','${B}','Cy','cashier', public.employee_pin_hash('5555'), true, null);
    `);
    expect(applyMigration(DB).ok).toBe(true);
  }, 180_000);

  it("7. a duplicate ACTIVE code in one project is refused by the database", () => {
    // The index, not an RPC pre-check: this is a direct UPDATE.
    const error = sqlExpectingFailure(DB,
      `update public.employees set employee_code='002' where display_name='Amy'`);

    expect(error).toMatch(/duplicate key value|unique constraint/);
    expect(error).toContain("employees_active_project_code_key");
  });

  it("8. the same code in a different project is fine", () => {
    expect(sql(DB, `select count(*) from public.employees
                    where employee_code='001' and active`)).toBe("2");
    expect(sql(DB, `select count(distinct project_id) from public.employees
                    where employee_code='001' and active`)).toBe("2");
  });

  it("9. a leaver's historical code does not block a new active employee", () => {
    // Give the leaver a code, then hand the same code to somebody new.
    sql(DB, `update public.employees set employee_code='007' where id='${LEAVER}'`);

    expect(asRole(DB, OWNER,
      `select public.create_employee('${A}','New Hire','cashier','007','4321')->>'ok'`)).toBe("true");
  });

  it("10. reactivation onto a taken code returns the catalogued failure", () => {
    expect(asRole(DB, OWNER,
      `select public.set_employee_active('${LEAVER}', true)->>'error'`)).toBe("employee_code_taken");

    // Nobody was renumbered and nobody was deactivated to make room.
    expect(sql(DB, `select display_name || '=' || employee_code from public.employees
                    where employee_code='007' and active`)).toBe("New Hire=007");
  });

  it("and reactivation works once a free code is chosen — the UUID never moved", () => {
    expect(asRole(DB, OWNER, `select public.set_employee_code('${LEAVER}','050')->>'ok'`)).toBe("true");
    expect(asRole(DB, OWNER, `select public.set_employee_active('${LEAVER}', true)->>'ok'`)).toBe("true");
    expect(sql(DB, `select id || ' ' || employee_code || ' ' || active
                    from public.employees where id='${LEAVER}'`)).toBe(`${LEAVER} 050 true`);
  });
});

// ===========================================================================
// 11-18. Authentication
// ===========================================================================

run("Employee ID login, executed", () => {
  const DB = "f1brt_login";
  const A = "aaaa0001-0000-4000-8000-000000000001";
  const B = "aaaa0002-0000-4000-8000-000000000001";
  const DEVICE_USER = "d0000000-0000-4000-8000-000000000001";
  const DEVICE = "c0000000-0000-4000-8000-000000000001";

  /** Calls an RPC as the paired till. */
  const asDevice = (statement: string): string => asRole(DB, DEVICE_USER, statement);

  beforeAll(() => {
    freshDatabase(DB, false);
    sql(DB, `
      insert into auth.users (id) values ('${OWNER}'), ('${DEVICE_USER}') on conflict do nothing;
      insert into public.projects (id, user_id, name, template_id, config) values
        ('${A}', '${OWNER}', 'A', 'cafe', '{}'::jsonb),
        ('${B}', '${OWNER}', 'B', 'cafe', '{}'::jsonb);
      insert into public.build_jobs (id, project_id, owner_id, target, status, config_snapshot,
                                     config_schema_version, config_hash, request_key, started_at, finished_at)
      values ('b0000000-0000-4000-8000-000000000001','${A}','${OWNER}','android','succeeded','{}'::jsonb,1,'h','r', now(), now());
      insert into public.paired_devices (id, auth_user_id, owner_id, project_id, build_job_id)
      values ('${DEVICE}','${DEVICE_USER}','${OWNER}','${A}','b0000000-0000-4000-8000-000000000001');
      insert into public.employees (id, project_id, display_name, role, pin_hash, active, deactivated_at, created_at) values
        ('e0000001-0000-4000-8000-00000000000a','${A}','Amy','cashier', public.employee_pin_hash('2222'), true, null, '2026-01-01'),
        ('e0000001-0000-4000-8000-00000000000c','${A}','Bob','manager', public.employee_pin_hash('3333'), true, null, '2026-02-01'),
        ('e0000002-0000-4000-8000-00000000000a','${B}','Cy','cashier', public.employee_pin_hash('5555'), true, null, '2026-03-01');
    `);
    expect(applyMigration(DB).ok).toBe(true);
  }, 180_000);

  it("11. the right Employee ID and PIN open a real server-side session", () => {
    expect(asDevice(`select public.employee_login_by_code('001','2222')->>'ok'`)).toBe("true");

    // The session points at the UUID, not the code.
    expect(sql(DB, `select e.display_name || '/' || e.employee_code
                    from public.employee_pos_sessions s
                    join public.employees e on e.id = s.employee_id
                    where s.paired_device_id='${DEVICE}' and s.ended_at is null`)).toBe("Amy/001");
  });

  it("12-15. every credential failure is the same generic answer", () => {
    const cases: Array<[string, string]> = [
      ["12. wrong PIN", `public.employee_login_by_code('001','9999')`],
      ["13. unknown Employee ID", `public.employee_login_by_code('555','2222')`],
      ["13b. malformed Employee ID", `public.employee_login_by_code('1','2222')`],
      ["13c. reserved 000", `public.employee_login_by_code('000','2222')`],
      ["14. inactive employee", `public.employee_login_by_code('002','3333')`],
      ["15. another project's credentials", `public.employee_login_by_code('001','5555')`],
      ["PIN of the wrong length", `public.employee_login_by_code('001','222')`],
    ];

    // Bob is 002 in project A; deactivate him for case 14.
    asRole(DB, OWNER, `select public.set_employee_active('e0000001-0000-4000-8000-00000000000c', false)`);

    for (const [label, call] of cases) {
      expect(`${label}: ${asDevice(`select ${call}->>'error'`)}`).toBe(`${label}: invalid_credentials`);
    }
  });

  it("15b. project B's 001 exists and still cannot authenticate here", () => {
    // Proves the previous case failed because of the project scope, not because
    // the credentials were wrong.
    expect(sql(DB, `select display_name from public.employees
                    where project_id='${B}' and employee_code='001'`)).toBe("Cy");
  });

  it("16. the project comes from the paired device, and the client cannot supply one", () => {
    expect(sql(DB, `select pg_get_function_identity_arguments(p.oid)
                    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='employee_login_by_code'`))
      .toBe("p_employee_code text, p_pin text");

    // A SECOND till, paired to project B, sends the identical call. It resolves
    // Cy rather than Amy, and nothing in the request said so: paired_devices
    // .project_id is immutable after creation, which is why this needs its own
    // device rather than re-pointing the first.
    const OTHER_USER = "d0000000-0000-4000-8000-000000000002";
    const OTHER_DEVICE = "c0000000-0000-4000-8000-000000000002";

    sql(DB, `
      insert into auth.users (id) values ('${OTHER_USER}') on conflict do nothing;
      insert into public.build_jobs (id, project_id, owner_id, target, status, config_snapshot,
                                     config_schema_version, config_hash, request_key, started_at, finished_at)
      values ('b0000000-0000-4000-8000-000000000002','${B}','${OWNER}','android','succeeded','{}'::jsonb,1,'h2','r2', now(), now());
      insert into public.paired_devices (id, auth_user_id, owner_id, project_id, build_job_id)
      values ('${OTHER_DEVICE}','${OTHER_USER}','${OWNER}','${B}','b0000000-0000-4000-8000-000000000002');
    `);

    expect(asRole(DB, OTHER_USER, `select public.employee_login_by_code('001','5555')->>'displayName'`))
      .toBe("Cy");
    // And the same call on the project-A till still refuses those credentials.
    expect(asDevice(`select public.employee_login_by_code('001','5555')->>'error'`))
      .toBe("invalid_credentials");
  });

  it("17. unknown Employee IDs are counted by the device-wide limiter", () => {
    const before = Number(sql(DB, `select count(*) from public.employee_login_device_failures
                                   where paired_device_id='${DEVICE}'`));

    asDevice(`select public.employee_login_by_code('777','1234')`);

    expect(Number(sql(DB, `select count(*) from public.employee_login_device_failures
                           where paired_device_id='${DEVICE}'`))).toBe(before + 1);
  });

  it("18. the per-employee limiter is keyed to the employee UUID", () => {
    sql(DB, `delete from public.employee_login_employee_attempts`);
    asDevice(`select public.employee_login_by_code('001','9999')`);

    // Recorded against Amy's UUID. A reissued code must not inherit somebody
    // else's failure history, which is why it cannot be keyed to the code.
    expect(sql(DB, `select a.employee_id::text = e.id::text
                    from public.employee_login_employee_attempts a
                    join public.employees e on e.display_name='Amy'
                    where a.paired_device_id='${DEVICE}'`)).toBe("t");
    expect(sql(DB, `select count(*) from information_schema.columns
                    where table_name='employee_login_employee_attempts'
                      and column_name like '%code%'`)).toBe("0");
  });

  it("no PIN is ever stored in clear", () => {
    expect(sql(DB, `select count(*) from public.employees
                    where pin_hash not like '$2%' or length(pin_hash) <> 60`)).toBe("0");
  });
});
