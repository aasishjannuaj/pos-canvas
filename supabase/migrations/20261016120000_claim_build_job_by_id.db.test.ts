// OFF-2-EXACT-CLAIM-1 — claim_build_job_by_id EXECUTED against a real
// PostgreSQL, not read.
//
// WHAT IS PROVEN HERE THAT TEXT CANNOT PROVE: that only the named job changes
// even when an OLDER queued job and STUCK jobs of other businesses exist (the
// exact rows claim_next_build_job would take or fail — shown on an identical
// copy); that a wrong project, target, status, attempt count or a malformed
// argument claims nothing and changes nothing; that two competing claimers can
// never both hold a claim; that the existing transition guard and privilege
// restrictions still bind; that the claim token it mints works with the
// unchanged heartbeat and lease checks; and that nothing else in the schema
// moved, compared with a database built from every migration before this one.
//
// The harness (PostgreSQL discovery, the Supabase compatibility layer, the
// cluster and the migration chain) is the one the earlier suites use, reproduced
// unchanged (20261002120000_device_cash_drawer_enablement.db.test.ts); only the
// migration name, port range and fixtures differ. When no PostgreSQL server is
// found the suite SKIPS LOUDLY rather than failing.
//
// NOT EXECUTED HERE: finalize_build_job_with_artifact and the current
// fail_build_job live in 20260729190422_build_artifact_storage.sql, a
// storage-only migration this harness skips because vanilla PostgreSQL has no
// Supabase `storage` schema. Neither is changed by this migration; both still
// require the exact claim token and an unexpired lease (read, not run).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20261016120000_claim_build_job_by_id.sql";

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
const PORT = 57100 + (process.pid % 90);

if (PG_BIN === null) {
  console.warn(
    `\n[${MIGRATION}] SKIPPED: no local PostgreSQL server found.` +
      "\n  These are the only tests that EXECUTE claim_build_job_by_id;" +
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

const pgEnv = () => ({ ...process.env, LC_ALL: "en_US.UTF-8", PGTZ: "UTC" });

function pg(tool: string, args: string[], input?: string): string {
  return execFileSync(join(PG_BIN as string, tool), args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    env: pgEnv(),
  });
}

const psqlArgs = (db: string): string[] => [
  "-h", "127.0.0.1", "-p", String(PORT), "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1",
];

/** Runs SQL in `db` and returns unaligned, tuples-only output. */
function sql(db: string, statement: string): string {
  return pg("psql", [...psqlArgs(db), "-Atq", "-c", statement]).trim();
}

/** The same, asynchronously, for a session that must stay open while another runs. */
function sqlAsync(db: string, statement: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(join(PG_BIN as string, "psql"), [...psqlArgs(db), "-Atq", "-c", statement], { env: pgEnv() });
    let out = "";
    let err = "";

    child.stdout.on("data", (chunk) => { out += String(chunk); });
    child.stderr.on("data", (chunk) => { err += String(chunk); });
    child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err))));
  });
}

/**
 * The ONLY predecessors this harness is allowed to skip, named exactly.
 *
 * Both create Supabase Storage buckets and policies on `storage.objects`, a
 * schema the Supabase platform provides and a vanilla cluster does not have.
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
    // "WITHOUT the migration" is the database as it was BEFORE it; "WITH" is
    // the database as it was right AFTER it. Filenames begin with a fixed-width
    // timestamp, so a lexicographic compare is a chronological one.
    if (!withMigration && file >= MIGRATION) continue;
    if (withMigration && file > MIGRATION) continue;
    if (STORAGE_ONLY_MIGRATIONS.has(file)) continue;

    runSqlFile(name, join(migrationsDir, file));
    sql(name,
      `insert into supabase_migrations.schema_migrations(version, name)
       values ('${file.split("_")[0]}', '${file}') on conflict do nothing`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures: OUR job, plus every kind of job claim_next_build_job would touch
// ---------------------------------------------------------------------------

const OWNER = "11111111-1111-4111-8111-111111111111";
const P = (n: string) => `a0000000-0000-4000-8000-0000000000${n}`;
const J = (n: string) => `b0000000-0000-4000-8000-0000000000${n}`;

const OURS = P("01");
const OTHER_PROJECTS = ["02", "03", "04", "05", "06", "07", "08"].map(P);

type Job = {
  id: string;
  project: string;
  target: "android" | "desktop";
  status: "queued" | "building" | "succeeded" | "failed";
  created: string;
  attempts: number;
  /** For 'building': is the lease still live? */
  leaseLive?: boolean;
};

/** The job OFF-2 wants: our business, android, queued, and the NEWEST queued android job. */
const TARGET_JOB: Job = { id: J("01"), project: OURS, target: "android", status: "queued", created: "2026-10-16T12:00:00Z", attempts: 0 };
/** Same business, other target, queued. */
const OURS_DESKTOP: Job = { id: J("02"), project: OURS, target: "desktop", status: "queued", created: "2026-10-02T12:00:00Z", attempts: 0 };
/** Same business, an earlier finished android build. */
const OURS_OLD_SUCCEEDED: Job = { id: J("03"), project: OURS, target: "android", status: "succeeded", created: "2026-09-01T12:00:00Z", attempts: 1 };
/** Another business, android, queued and OLDER than ours: claim_next_build_job takes this first. */
const OLDER_QUEUED: Job = { id: J("04"), project: P("02"), target: "android", status: "queued", created: "2026-10-01T12:00:00Z", attempts: 0 };
/** Another business, stuck, out of attempts: claim_next_build_job FAILS this as a side effect. */
const STUCK_EXHAUSTED: Job = { id: J("05"), project: P("03"), target: "android", status: "building", created: "2026-09-20T12:00:00Z", attempts: 3, leaseLive: false };
/** Another business, stuck, attempts left: claim_next_build_job would RECLAIM this. */
const STUCK_RECLAIMABLE: Job = { id: J("06"), project: P("04"), target: "android", status: "building", created: "2026-09-21T12:00:00Z", attempts: 1, leaseLive: false };
/** Another business, being built right now. */
const LIVE_BUILDING: Job = { id: J("07"), project: P("05"), target: "android", status: "building", created: "2026-09-22T12:00:00Z", attempts: 1, leaseLive: true };
const SUCCEEDED: Job = { id: J("08"), project: P("06"), target: "android", status: "succeeded", created: "2026-09-23T12:00:00Z", attempts: 1 };
const FAILED: Job = { id: J("09"), project: P("07"), target: "android", status: "failed", created: "2026-09-24T12:00:00Z", attempts: 3 };
/** Another business, queued but already at the attempt cap. */
const QUEUED_AT_CAP: Job = { id: J("10"), project: P("08"), target: "android", status: "queued", created: "2026-10-03T12:00:00Z", attempts: 3 };

const ALL_JOBS = [TARGET_JOB, OURS_DESKTOP, OURS_OLD_SUCCEEDED, OLDER_QUEUED, STUCK_EXHAUSTED, STUCK_RECLAIMABLE, LIVE_BUILDING, SUCCEEDED, FAILED, QUEUED_AT_CAP];

const MENU = JSON.stringify({ menuItems: [] });

function jobValues(job: Job, n: number): string {
  const building = job.status === "building";
  const terminal = job.status === "succeeded" || job.status === "failed";
  const lease = job.leaseLive ? "now() + interval '10 minutes'" : "now() - interval '10 minutes'";

  return `('${job.id}','${job.project}','${OWNER}','${job.target}','${job.status}','${MENU}'::jsonb,1,'hash-${n}','req-${n}',
    '${job.created}'::timestamptz, ${job.attempts},
    ${building || terminal ? `'${job.created}'::timestamptz + interval '1 minute'` : "null"},
    ${terminal ? `'${job.created}'::timestamptz + interval '2 minutes'` : "null"},
    ${building ? "'other-worker'" : "null"},
    ${building ? "gen_random_uuid()" : "null"},
    ${building ? "now() - interval '11 minutes'" : "null"},
    ${building ? lease : "null"},
    ${job.status === "failed" ? "'worker_timeout'" : "null"},
    ${job.status === "failed" ? "'Build processing stopped before completion.'" : "null"})`;
}

function seed(db: string, jobs: Job[] = ALL_JOBS): void {
  sql(db, `
    insert into auth.users (id) values ('${OWNER}');
    insert into public.projects (id, user_id, name, template_id, config)
    select p, '${OWNER}', 'Shop ' || p, 'cafe', '${MENU}'::jsonb
    from unnest(array['${[OURS, ...OTHER_PROJECTS].join("','")}']::uuid[]) p;
    insert into public.build_jobs (id, project_id, owner_id, target, status, config_snapshot,
      config_schema_version, config_hash, request_key, created_at, attempt_count,
      started_at, finished_at, claimed_by, claim_token, heartbeat_at, lease_expires_at,
      failure_code, failure_message)
    values ${jobs.map(jobValues).join(",\n")};
  `);
}

const DB = "exactclaim";
/** The same fixtures, with every migration BEFORE this one applied. */
const DB_BEFORE = "exactclaimbefore";
/** The same fixtures, used ONLY to show what the GLOBAL claim does with them. */
const DB_CONTRAST = "exactclaimcontrast";
/** Only our job is eligible: lets the global claim and the exact claim compete for the SAME row. */
const DB_RACE = "exactclaimrace";

beforeAll(() => {
  if (PG_BIN === null) return;

  dataDir = mkdtempSync(join(tmpdir(), "pos-canvas-exact-claim-"));
  pg("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust"]);
  pg("pg_ctl", [
    "-D", dataDir, "-l", join(dataDir, "server.log"), "-w", "start",
    "-o", `-c listen_addresses=127.0.0.1 -c port=${PORT} -c unix_socket_directories=''`,
  ]);
  freshDatabase(DB, true);
  freshDatabase(DB_BEFORE, false);
  freshDatabase(DB_CONTRAST, true);
  freshDatabase(DB_RACE, true);
  seed(DB);
  seed(DB_BEFORE);
  seed(DB_CONTRAST);
}, 900_000);

afterAll(() => {
  if (PG_BIN === null) return;
  try { pg("pg_ctl", ["-D", dataDir, "-m", "immediate", "-w", "stop"]); }
  finally { rmSync(dataDir, { recursive: true, force: true }); }
}, 900_000);

const maybe = PG_BIN === null ? describe.skip : describe;

// ---------------------------------------------------------------------------
// Callers and observers
// ---------------------------------------------------------------------------

type Claimed = { id: string; target: string; claim_token: string; lease_expires_at: string; attempt_count: number };
type Attempt = { rows: Claimed[] } | { error: string };

const lit = (v: string | number | null) => (v === null ? "null" : typeof v === "number" ? String(v) : `'${v}'`);

function exactCall(job: string | null, project: string | null, target: string | null, worker: string | null = "worker-1", lease: number | null = 300): string {
  return `public.claim_build_job_by_id(${lit(job)}::uuid, ${lit(project)}::uuid, ${lit(target)}, ${lit(worker)}, ${lit(lease)})`;
}

/** Calls `fnCall` as `role` and returns its rows as JSON; a raise becomes `error`. */
function callAs(db: string, role: string, fnCall: string): Attempt {
  try {
    const out = sql(db, `
      begin;
      set local role ${role};
      select coalesce(json_agg(c), '[]') from ${fnCall} c;
      commit;`);
    const lines = out.split("\n").filter((l) => l !== "");

    return { rows: JSON.parse(lines[lines.length - 1] ?? "[]") as Claimed[] };
  } catch (error) {
    return { error: String((error as { stderr?: unknown }).stderr ?? error) };
  }
}

const claimExact = (db: string, job: string | null, project: string | null, target: string | null, worker?: string | null, lease?: number | null) =>
  callAs(db, "service_role", exactCall(job, project, target, worker, lease));

/** A fingerprint of every build_jobs row, keyed by id. */
function rowFingerprints(db: string): Map<string, string> {
  const out = sql(db, "select id || ':' || md5(b::text) from public.build_jobs b order by id");

  return new Map(out.split("\n").filter(Boolean).map((l) => l.split(":") as [string, string]));
}

function changedRows(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...after.keys()].filter((id) => before.get(id) !== after.get(id)).sort();
}

const statusOf = (db: string, id: string) => sql(db, `select status from public.build_jobs where id = '${id}'`);

// ---------------------------------------------------------------------------
// 1. Only the selected job changes
// ---------------------------------------------------------------------------

maybe("claim_build_job_by_id claims ONLY the named job", () => {
  it("the fixture is hostile: the GLOBAL claim fails a stuck job and takes three other businesses' jobs before ours", () => {
    const before = rowFingerprints(DB_CONTRAST);
    const globalClaim = () => {
      const result = callAs(DB_CONTRAST, "service_role", "public.claim_next_build_job('android', 'global-worker', 300)");

      return "rows" in result ? result.rows.map((r) => r.id) : result;
    };

    // First call: reclaims the OLDEST eligible row (another business's stuck
    // job) and, in the same statement, fails another business's exhausted job.
    expect(globalClaim()).toEqual([STUCK_RECLAIMABLE.id]);
    expect(statusOf(DB_CONTRAST, STUCK_EXHAUSTED.id)).toBe("failed");
    expect(changedRows(before, rowFingerprints(DB_CONTRAST))).toEqual([STUCK_EXHAUSTED.id, STUCK_RECLAIMABLE.id].sort());

    // Then, oldest first: an older queued job, then a queued job already at the
    // attempt cap (the global claim does not cap queued jobs), and only then ours.
    expect(globalClaim()).toEqual([OLDER_QUEUED.id]);
    expect(globalClaim()).toEqual([QUEUED_AT_CAP.id]);
    expect(statusOf(DB_CONTRAST, TARGET_JOB.id)).toBe("queued");
    expect(globalClaim()).toEqual([TARGET_JOB.id]);
  });

  it("claims the named job, with full bookkeeping, and changes NO other row", () => {
    const before = rowFingerprints(DB);
    const result = claimExact(DB, TARGET_JOB.id, OURS, "android", "exact-worker", 300);

    expect("rows" in result && result.rows).toHaveLength(1);

    const [claimed] = (result as { rows: Claimed[] }).rows;

    expect(claimed).toMatchObject({ id: TARGET_JOB.id, target: "android", attempt_count: 1 });
    expect(claimed.claim_token).toMatch(/^[0-9a-f-]{36}$/);
    expect(changedRows(before, rowFingerprints(DB))).toEqual([TARGET_JOB.id]);

    const row = JSON.parse(sql(DB, `
      select json_build_object('status', status, 'claimed_by', claimed_by, 'token', claim_token,
        'started', started_at is not null, 'heartbeat', heartbeat_at is not null,
        'lease_s', round(extract(epoch from lease_expires_at - now())), 'attempts', attempt_count,
        'failure', coalesce(failure_code, failure_message), 'finished', finished_at)
      from public.build_jobs where id = '${TARGET_JOB.id}'`));

    expect(row).toMatchObject({ status: "building", claimed_by: "exact-worker", token: claimed.claim_token, started: true, heartbeat: true, attempts: 1, failure: null, finished: null });
    expect(row.lease_s).toBeGreaterThan(290);
    expect(row.lease_s).toBeLessThanOrEqual(300);

    // The rows the global claim would have taken or failed are untouched.
    for (const job of [OLDER_QUEUED, STUCK_EXHAUSTED, STUCK_RECLAIMABLE]) expect(statusOf(DB, job.id)).toBe(job.status);
  });

  it("a second exact claim of the same job gets nothing and changes nothing", () => {
    const before = rowFingerprints(DB);

    expect(claimExact(DB, TARGET_JOB.id, OURS, "android", "second-worker")).toEqual({ rows: [] });
    expect(changedRows(before, rowFingerprints(DB))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Refusals
// ---------------------------------------------------------------------------

maybe("everything that is not exactly the named, queued job is refused", () => {
  it.each([
    ["another business's project id", () => [OLDER_QUEUED.id, OURS, "android"]],
    ["our job id with another business's project id", () => [OURS_DESKTOP.id, P("02"), "desktop"]],
    ["the wrong target", () => [OURS_DESKTOP.id, OURS, "android"]],
    ["a job that does not exist", () => ["b0000000-0000-4000-8000-0000000000ff", OURS, "android"]],
    ["a job being built (live lease)", () => [LIVE_BUILDING.id, LIVE_BUILDING.project, "android"]],
    ["a stuck job with attempts left (no reclaim)", () => [STUCK_RECLAIMABLE.id, STUCK_RECLAIMABLE.project, "android"]],
    ["a stuck job out of attempts (no failover)", () => [STUCK_EXHAUSTED.id, STUCK_EXHAUSTED.project, "android"]],
    ["a succeeded job", () => [SUCCEEDED.id, SUCCEEDED.project, "android"]],
    ["a failed job", () => [FAILED.id, FAILED.project, "android"]],
    ["a queued job at the attempt cap", () => [QUEUED_AT_CAP.id, QUEUED_AT_CAP.project, "android"]],
  ])("%s: zero rows, nothing changed", (_label, args) => {
    const [job, project, target] = args();
    const before = rowFingerprints(DB);

    expect(claimExact(DB, job, project, target)).toEqual({ rows: [] });
    expect(changedRows(before, rowFingerprints(DB))).toEqual([]);
  });

  it.each([
    ["a null job id", [null, OURS, "android", "w", 300], "build job id is required"],
    ["a null project id", [OURS_DESKTOP.id, null, "desktop", "w", 300], "project id is required"],
    ["an unsupported target", [OURS_DESKTOP.id, OURS, "web", "w", 300], "unsupported build target"],
    ["a null target", [OURS_DESKTOP.id, OURS, null, "w", 300], "unsupported build target"],
    ["an empty worker id", [OURS_DESKTOP.id, OURS, "desktop", "", 300], "worker id is required"],
    ["a blank worker id", [OURS_DESKTOP.id, OURS, "desktop", "   ", 300], "worker id is required"],
    ["a null worker id", [OURS_DESKTOP.id, OURS, "desktop", null, 300], "worker id is required"],
    ["a lease below 30 s", [OURS_DESKTOP.id, OURS, "desktop", "w", 29], "lease seconds out of range"],
    ["a lease above 3600 s", [OURS_DESKTOP.id, OURS, "desktop", "w", 3601], "lease seconds out of range"],
    ["a null lease", [OURS_DESKTOP.id, OURS, "desktop", "w", null], "lease seconds out of range"],
  ] as const)("%s raises before any row is touched", (_label, args, message) => {
    const before = rowFingerprints(DB);
    const result = claimExact(DB, ...(args as unknown as [string | null, string | null, string | null, string | null, number | null]));

    expect(result).toEqual({ error: expect.stringContaining(message) });
    expect(changedRows(before, rowFingerprints(DB))).toEqual([]);
    expect(statusOf(DB, OURS_DESKTOP.id)).toBe("queued");
  });

  it("a malformed uuid is refused by the type itself", () => {
    expect(callAs(DB, "service_role", "public.claim_build_job_by_id('not-a-uuid', null, 'android', 'w', 300)")).toEqual({
      error: expect.stringContaining("invalid input syntax for type uuid"),
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Competing claims
// ---------------------------------------------------------------------------

/** Waits until a session is sleeping inside its transaction, i.e. holding the row lock. */
async function waitForHolder(db: string, marker: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const n = sql(db, `select count(*) from pg_stat_activity where wait_event = 'PgSleep' and query like '%${marker}%'`);

    if (n !== "0") return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the holder never took the lock");
}

const holderStatement = (fnCall: string, marker: string) => `
  begin;
  set local role service_role;
  select coalesce(json_agg(c), '[]') from ${fnCall} c;
  select pg_sleep(1.5) /* ${marker} */;
  commit;`;

const lastJson = (out: string) => JSON.parse(out.split("\n").filter(Boolean).filter((l) => l.startsWith("["))[0] ?? "[]") as Claimed[];

maybe("competing claims can never both obtain a valid claim", () => {
  const RACE_JOB: Job = { ...TARGET_JOB };

  async function race(holderCall: string, contenderCall: string, marker: string) {
    sql(DB_RACE, "truncate public.build_jobs, public.projects, auth.users cascade");
    seed(DB_RACE, [RACE_JOB]);

    const holder = sqlAsync(DB_RACE, holderStatement(holderCall, marker));

    await waitForHolder(DB_RACE, marker);

    const started = Date.now();
    const contender = callAs(DB_RACE, "service_role", contenderCall);
    const waitedMs = Date.now() - started;
    const holderRows = lastJson(await holder);
    const final = JSON.parse(sql(DB_RACE, `
      select json_build_object('status', status, 'token', claim_token, 'attempts', attempt_count)
      from public.build_jobs where id = '${RACE_JOB.id}'`));

    return { holderRows, contender, waitedMs, final };
  }

  it("exact vs exact: the second waits for the lock, then gets nothing", async () => {
    const call = exactCall(RACE_JOB.id, OURS, "android", "racer");
    const { holderRows, contender, waitedMs, final } = await race(call, call, "exact-exact");

    expect(holderRows).toHaveLength(1);
    expect(contender).toEqual({ rows: [] });
    expect(waitedMs).toBeGreaterThan(500);
    expect(final).toEqual({ status: "building", token: holderRows[0].claim_token, attempts: 1 });
  });

  it("global holds the job, exact contends: exact gets nothing", async () => {
    const { holderRows, contender, final } = await race(
      "public.claim_next_build_job('android', 'global-racer', 300)",
      exactCall(RACE_JOB.id, OURS, "android", "exact-racer"),
      "global-exact"
    );

    expect(holderRows).toEqual([expect.objectContaining({ id: RACE_JOB.id })]);
    expect(contender).toEqual({ rows: [] });
    expect(final).toEqual({ status: "building", token: holderRows[0].claim_token, attempts: 1 });
  });

  it("exact holds the job, global contends: global skips the locked row and gets nothing", async () => {
    const { holderRows, contender, final } = await race(
      exactCall(RACE_JOB.id, OURS, "android", "exact-racer"),
      "public.claim_next_build_job('android', 'global-racer', 300)",
      "exact-global"
    );

    expect(holderRows).toEqual([expect.objectContaining({ id: RACE_JOB.id })]);
    expect(contender).toEqual({ rows: [] });
    expect(final).toEqual({ status: "building", token: holderRows[0].claim_token, attempts: 1 });
  });

  it("only the winner's token passes the unchanged heartbeat/lease check", async () => {
    const call = exactCall(RACE_JOB.id, OURS, "android", "racer");
    const { holderRows } = await race(call, call, "exact-heartbeat");
    const token = holderRows[0].claim_token;
    const beat = (t: string) => sql(DB_RACE, `
      begin; set local role service_role;
      select public.heartbeat_build_job('${RACE_JOB.id}', '${t}', 300);
      commit;`).split("\n").filter(Boolean).pop();

    expect(beat(token)).toBe("t");
    expect(beat("00000000-0000-4000-8000-000000000000")).toBe("f");

    // An expired lease defeats even the right token (lease protection intact).
    sql(DB_RACE, `update public.build_jobs set lease_expires_at = now() - interval '1 second' where id = '${RACE_JOB.id}'`);
    expect(beat(token)).toBe("f");
  });
});

// ---------------------------------------------------------------------------
// 4. Existing guards and privileges
// ---------------------------------------------------------------------------

maybe("existing transition guards and privilege restrictions remain effective", () => {
  it("the transition guard still rejects illegal moves on a job this function claimed", () => {
    // TARGET_JOB was claimed in section 1, so it is 'building' here.
    expect(statusOf(DB, TARGET_JOB.id)).toBe("building");
    expect(() => sql(DB, `update public.build_jobs set status = 'queued', claimed_by = null, claim_token = null, heartbeat_at = null, lease_expires_at = null where id = '${TARGET_JOB.id}'`))
      .toThrow(/build_jobs status cannot change from building to queued/);
    expect(() => sql(DB, `update public.build_jobs set project_id = '${P("02")}' where id = '${TARGET_JOB.id}'`))
      .toThrow(/project_id cannot be changed/);
    expect(() => sql(DB, `update public.build_jobs set status = 'queued', finished_at = null, started_at = null where id = '${SUCCEEDED.id}'`))
      .toThrow(/build_jobs status cannot change from succeeded to queued/);
  });

  it("anon and authenticated cannot execute it; service_role can; PUBLIC holds no grant", () => {
    // OURS_DESKTOP is still queued: every earlier case refused it.
    expect(statusOf(DB, OURS_DESKTOP.id)).toBe("queued");

    for (const role of ["anon", "authenticated"]) {
      expect(callAs(DB, role, exactCall(OURS_DESKTOP.id, OURS, "desktop"))).toEqual({ error: expect.stringContaining("permission denied for function claim_build_job_by_id") });
    }

    expect(statusOf(DB, OURS_DESKTOP.id)).toBe("queued");
    expect(sql(DB, `
      select string_agg(coalesce(r.rolname, 'PUBLIC') || ':' || a.privilege_type, ',' order by r.rolname)
      from pg_proc p, aclexplode(p.proacl) a left join pg_roles r on r.oid = a.grantee
      where p.oid = 'public.claim_build_job_by_id(uuid,uuid,text,text,integer)'::regprocedure`))
      .toBe("postgres:EXECUTE,service_role:EXECUTE");
    expect(sql(DB, `select prosecdef::text || ' ' || array_to_string(proconfig, ',')
      from pg_proc where oid = 'public.claim_build_job_by_id(uuid,uuid,text,text,integer)'::regprocedure`))
      .toBe("true search_path=public, pg_temp");
    expect(claimExact(DB, OURS_DESKTOP.id, OURS, "desktop")).toEqual({ rows: [expect.objectContaining({ id: OURS_DESKTOP.id })] });
  });

  it("the existing claim functions keep their privileges", () => {
    const acl = (db: string, fn: string) => sql(db, `select proacl::text from pg_proc where oid = '${fn}'::regprocedure`);

    for (const fn of [
      "public.claim_next_build_job(text,text,integer)",
      "public.heartbeat_build_job(uuid,uuid,integer)",
    ]) {
      expect(acl(DB, fn)).toBe(acl(DB_BEFORE, fn));
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Nothing else in the schema moved
// ---------------------------------------------------------------------------

maybe("nothing else in the schema moved", () => {
  it("one function added; every other definition identical", () => {
    const definitions = (db: string) => sql(db, `
      select string_agg(p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid)), E'\\n'
                        order by p.oid::regprocedure::text)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f'`);
    const toMap = (text: string) => new Map(text.split("\n").map((l) => l.split(":") as [string, string]));

    const before = toMap(definitions(DB_BEFORE));
    const after = toMap(definitions(DB));

    expect([...after.keys()].filter((k) => !before.has(k))).toEqual(["claim_build_job_by_id(uuid,uuid,text,text,integer)"]);
    expect([...before.keys()].filter((k) => !after.has(k))).toEqual([]);
    expect([...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k))).toEqual([]);
  });

  it("tables, constraints, grants, RLS, policies, indexes and triggers are identical", () => {
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
        select 'pol:' || tablename || ':' || policyname || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '') from pg_policies where schemaname = 'public'
        union all
        select 'idx:' || indexname || ':' || indexdef from pg_indexes where schemaname = 'public'
        union all
        select 'trg:' || tgrelid::regclass::text || ':' || tgname || ':' || tgfoid::regprocedure::text || ':' || tgenabled::text
          from pg_trigger where not tgisinternal
      ) s`);

    expect(shape(DB)).toBe(shape(DB_BEFORE));
  });
});
