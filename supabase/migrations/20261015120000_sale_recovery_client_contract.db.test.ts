// G-1-CLIENT-1 — the CLIENT against the accepted server contract, EXECUTED
// against a real, local, disposable PostgreSQL with migration 20261015120000.
//
// Everything on the client side is the real code: the RPC adapters
// (lib/saleRecoveryRpc.ts, lib/offlineSaleRpc.ts), the response validators and
// decision table (lib/saleRecovery.ts), the recovery orchestration
// (lib/saleRecoverySession.ts), the durable marker and queue
// (lib/uncertainSaleSession.ts, lib/saleQueueSession.ts) on fake-indexeddb, and
// the sequential sync engine (lib/saleSyncEngine.ts). The ONLY substitution is
// the transport: instead of PostgREST over HTTP, each call is executed as the
// paired device with psql, and its result or its raised error is handed back in
// PostgREST's { data, error, status } shape.
//
// WHAT THIS CANNOT PROVE: PostgREST's own behaviour. In particular a missing
// function is reported by PostgREST as PGRST202; locally PostgreSQL reports
// 42883. Both are asserted to leave the sale protected (the PGRST202 mapping is
// exercised with mocked responses in lib/saleRecoverySession.test.ts).
//
// The cluster harness is reproduced from the accepted G1-SERVER-1A suite
// (20261015120000_sale_recovery_attribution.db.test.ts); only the port range,
// the data-directory prefix and the transport are new. No PostgreSQL -> skip.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { lookupDeviceSale, submitSaleRecovery } from "@/lib/saleRecoveryRpc";
import type { RecoveryRpcCall } from "@/lib/saleRecoveryRpc";
import { submitQueuedSale } from "@/lib/offlineSaleRpc";
import type { SaleRpcCall } from "@/lib/offlineSaleRpc";
import { decideAfterLookup, parseSaleLookupAnswer } from "@/lib/saleRecovery";
import { recoverOutstandingSale } from "@/lib/saleRecoverySession";
import { armUncertainSale, readOutstandingUncertainRecord, readUncertainSale } from "@/lib/uncertainSaleSession";
import { createUncertainSale } from "@/lib/saleSubmission";
import { enqueueSale, getSaleByRequestId } from "@/lib/saleQueueSession";
import { createSaleSyncEngine, resetSyncEngineForTests } from "@/lib/saleSyncEngine";
import { classifySubmissionFailure } from "@/lib/saleSyncClassifier";
import type { PersistedUncertainSale } from "@/lib/uncertainSaleRecord";

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20261015120000_sale_recovery_attribution.sql";

// ---------------------------------------------------------------------------
// The accepted harness (PostgreSQL discovery, compatibility layer, cluster)
// ---------------------------------------------------------------------------

const REQUIRED_BINARIES = ["initdb", "pg_ctl", "psql"] as const;

function findPostgresBin(): string | null {
  const candidates: string[] = [];

  try {
    const onPath = execFileSync("which", ["initdb"], { encoding: "utf8" }).trim();

    if (onPath) candidates.push(dirname(onPath));
  } catch {
    // Not on PATH.
  }

  candidates.push(
    "/opt/homebrew/opt/postgresql@17/bin",
    "/opt/homebrew/opt/postgresql@16/bin",
    "/usr/local/opt/postgresql@17/bin",
    "/usr/lib/postgresql/17/bin",
    "/usr/lib/postgresql/16/bin"
  );

  return candidates.find((dir) => REQUIRED_BINARIES.every((tool) => existsSync(join(dir, tool)))) ?? null;
}

const PG_BIN = findPostgresBin();

// A port range no other db suite uses (G1-SERVER-1A uses 57100-57189).
const PORT = 57200 + (process.pid % 90);

if (PG_BIN === null) {
  console.warn(`\n[G-1-CLIENT-1 client contract] SKIPPED: no local PostgreSQL server found.\n`);
}

const COMPAT = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, created_at timestamptz not null default now());
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
create schema extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
`;

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
  // So a raised error carries its SQLSTATE, as PostgREST's error body does.
  "-v", "VERBOSITY=verbose",
];

function sql(db: string, statement: string): string {
  return pg("psql", [...psqlArgs(db), "-Atq", "-c", statement]).trim();
}

const STORAGE_ONLY_MIGRATIONS = new Set([
  "20260729190422_build_artifact_storage.sql",
  "20260813120000_project_logo_storage.sql",
]);

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

    pg("psql", [...psqlArgs(name), "-q", "-f", join(migrationsDir, file)]);
    sql(name, `insert into supabase_migrations.schema_migrations(version, name)
               values ('${file.split("_")[0]}', '${file}') on conflict do nothing`);
  }
}

const lastLine = (text: string): string => text.split("\n").filter((l) => l !== "").at(-1) ?? "";

// ---------------------------------------------------------------------------
// Fixtures (the accepted suite's)
// ---------------------------------------------------------------------------

const OWNER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "a0000000-0000-4000-8000-000000000001";
const BUILD = "b0000000-0000-4000-8000-000000000001";
const AMY = "e0000001-0000-4000-8000-00000000000a";
const BEN = "e0000002-0000-4000-8000-00000000000b";
const deviceUser = (n: number): string => `d0000000-0000-4000-8000-00000000000${n}`;
const device = (n: number): string => `c0000000-0000-4000-8000-00000000000${n}`;
const ZONE = "America/New_York";

const MENU = JSON.stringify({
  menuItems: [
    { id: "latte", name: "Latte", price: "4.00", available: true, trackInventory: true, stockQuantity: 50 },
    { id: "muffin", name: "Muffin", price: "3.00", available: true, trackInventory: true, stockQuantity: 50 },
  ],
  tax: { enabled: false, rate: 0 },
  receipt: {},
});

const LATTE = [{ itemId: "latte", quantity: 1, modifiers: [] as { groupId: string; optionIds: string[] }[] }];

function asRole(db: string, who: string, statement: string): string {
  return lastLine(sql(db, `select set_config('request.jwt.claim.sub','${who}', false); ${statement}`));
}

function seed(db: string): void {
  sql(db, `
    insert into auth.users (id) values ('${OWNER}'), ('${deviceUser(1)}'), ('${deviceUser(2)}');
    insert into public.projects (id, user_id, name, template_id, config, business_timezone) values
      ('${PROJECT}', '${OWNER}', 'Shop', 'cafe', '${MENU}'::jsonb, '${ZONE}');
    insert into public.build_jobs (id, project_id, owner_id, target, status, config_snapshot,
                                   config_schema_version, config_hash, request_key, started_at, finished_at) values
      ('${BUILD}','${PROJECT}','${OWNER}','android','succeeded','${MENU}'::jsonb,1,'h','r1', now(), now());
    insert into public.paired_devices (id, auth_user_id, owner_id, project_id, build_job_id, created_at) values
      ('${device(1)}','${deviceUser(1)}','${OWNER}','${PROJECT}','${BUILD}', now() - interval '30 days'),
      ('${device(2)}','${deviceUser(2)}','${OWNER}','${PROJECT}','${BUILD}', now() - interval '30 days');
    insert into public.employees (id, project_id, display_name, employee_code, role, pin_hash, active, created_at) values
      ('${AMY}','${PROJECT}','Amy','001','cashier', public.employee_pin_hash('2222'), true, '2026-01-01'),
      ('${BEN}','${PROJECT}','Ben','002','cashier', public.employee_pin_hash('3333'), true, '2026-01-01');
  `);
}

function signIn(db: string, n: number, code: string, pin: string): string {
  expect(asRole(db, deviceUser(n), `select public.employee_login_by_code('${code}','${pin}')->>'ok'`)).toBe("true");

  return sql(db, `select id::text from public.employee_pos_sessions where paired_device_id='${device(n)}' and ended_at is null`);
}

function dailyRegister(db: string, n: number): string {
  return JSON.parse(asRole(db, deviceUser(n), `select public.ensure_daily_register_context()::text`)).registerSession
    .registerSessionId;
}

function yesterdayRegister(db: string, n: number): string {
  const date = `((now() at time zone '${ZONE}')::date - 1)`;

  return sql(db, `
    insert into public.register_sessions (paired_device_id, opened_at, opening_cash, closed_at, business_date, business_timezone)
    select '${device(n)}', b.starts_at, 0, b.ends_at, ${date}, '${ZONE}'
    from public.business_day_bounds(${date}, '${ZONE}') b
    returning id::text`);
}

/** A local instant on the business day `offsetDays` from today, as ISO UTC. */
function instantIso(db: string, offsetDays: number, hours: string): string {
  return sql(db, `select to_char((b.starts_at + interval '${hours}') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                  from public.business_day_bounds((now() at time zone '${ZONE}')::date + ${offsetDays}, '${ZONE}') b`);
}

function footprint(db: string): string {
  return sql(db, `select
    (select count(*) from public.orders)::text || ' orders / ' ||
    (select count(*) from public.order_items)::text || ' items / ' ||
    (select count(*) from public.inventory_transactions)::text || ' inventory'`);
}

function orderOf(db: string, request: string): Record<string, string> {
  const row = sql(db, `select json_build_object('employee', coalesce(employee_id::text,'NULL'),
                         'register', coalesce(register_session_id::text,'NULL'),
                         'device', coalesce(paired_device_id::text,'NULL'), 'source', source,
                         'occurredAt', to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                         'count', (select count(*) from public.orders x where x.sale_request_id = o.sale_request_id))
                       from public.orders o where sale_request_id='${request}'`);

  return row === "" ? {} : JSON.parse(row);
}

const R = (n: string): string => `f3000000-0000-4000-8000-0000000000${n}`;

// ---------------------------------------------------------------------------
// THE TRANSPORT: a call executed as the paired device, returned PostgREST-shaped
// ---------------------------------------------------------------------------

const TYPES: Record<string, string> = {
  p_sale_request_id: "uuid",
  p_original_employee_pos_session_id: "uuid",
  p_original_register_session_id: "uuid",
  p_current_employee_pos_session_id: "uuid",
  p_employee_pos_session_id: "uuid",
  p_register_session_id: "uuid",
  p_original_attempt_at: "timestamptz",
  p_occurred_at: "timestamptz",
  p_items: "jsonb",
  p_tip_amount: "numeric",
  p_payment_method: "text",
  p_source: "text",
};

function literal(key: string, value: unknown): string {
  const type = TYPES[key] ?? "text";

  if (value === null || value === undefined) return `null::${type}`;

  const text = typeof value === "string" ? value : JSON.stringify(value);

  return `'${text.replace(/'/g, "''")}'::${type}`;
}

type Wire = { data: unknown; error: unknown; status: number };

function callAsDevice(db: string, n: number, name: string, args: Record<string, unknown>): Wire {
  const params = Object.entries(args)
    .map(([key, value]) => `${key} => ${literal(key, value)}`)
    .join(", ");

  try {
    return { data: JSON.parse(asRole(db, deviceUser(n), `select public.${name}(${params})::text`)), error: null, status: 200 };
  } catch (error) {
    const stderr = ((error as { stderr?: string }).stderr ?? String(error)).toString();
    const raised = /ERROR:\s+([0-9A-Z]{5}):\s*(.*)/.exec(stderr);

    return {
      data: null,
      error: { code: raised?.[1] ?? "", message: (raised?.[2] ?? stderr).trim(), details: null, hint: null },
      status: raised?.[1] === "42883" ? 404 : 400,
    };
  }
}

function dbTransport(db: string, n: number) {
  const calls: string[] = [];
  const recovery: RecoveryRpcCall = async (name, args) => {
    calls.push(name);
    return callAsDevice(db, n, name, args);
  };
  // complete_sale_v5 must NEVER be reached on these paths.
  const v5: SaleRpcCall = async () => {
    calls.push("complete_sale_v5");
    throw new Error("complete_sale_v5 must not be called on a strict-recovery path");
  };

  return { calls, recovery, v5 };
}

const run = PG_BIN === null ? describe.skip : describe;

beforeAll(() => {
  if (PG_BIN === null) return;

  dataDir = mkdtempSync(join(tmpdir(), "g1client-pg-"));
  pg("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
  pg("pg_ctl", [
    "-D", dataDir, "-l", join(dataDir, "server.log"), "-w", "start",
    "-o", `-c listen_addresses=127.0.0.1 -c port=${PORT} -c unix_socket_directories=''`,
  ]);

  // LOCAL AND DISPOSABLE, verified rather than assumed.
  expect(sql("postgres", "show listen_addresses")).toBe("127.0.0.1");
  expect(sql("postgres", "show data_directory")).toContain("g1client-pg-");
  expect(sql("postgres", "select host(inet_server_addr())")).toBe("127.0.0.1");
}, 300_000);

afterAll(() => {
  if (PG_BIN === null || dataDir === "") return;

  try {
    pg("pg_ctl", ["-D", dataDir, "-m", "immediate", "-w", "stop"]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetSyncEngineForTests();
});

const IDENTITY = {
  deviceAuthUserId: deviceUser(1),
  deviceId: device(1),
  projectId: PROJECT,
  buildJobId: BUILD,
};

async function armMarker(request: string, original: PersistedUncertainSale["originalAttribution"]) {
  const sale = createUncertainSale({
    saleRequestId: request,
    projectId: PROJECT,
    paymentMethod: "cash",
    tipAmount: 0,
    items: LATTE,
    fingerprint: `fp-${request}`,
  });

  expect(
    await armUncertainSale({
      sale,
      identity: IDENTITY,
      dispatchedAt: original?.attemptedAt ?? new Date().toISOString(),
      originalAttribution: original,
    })
  ).toBe(true);

  const marker = await readOutstandingUncertainRecord(IDENTITY, { saleRequestId: request, fingerprint: `fp-${request}` });

  if (marker === null) throw new Error("marker unreadable");

  return marker;
}

function writeEvidence(db: string, name: string, extra: Record<string, unknown>) {
  const rows = sql(db, `select coalesce(json_agg(json_build_object(
      'saleRequestId', o.sale_request_id, 'orderNumber', o.order_number, 'source', o.source,
      'employee', (select display_name from public.employees e where e.id = o.employee_id),
      'registerSessionId', o.register_session_id, 'pairedDeviceId', o.paired_device_id,
      'occurredAt', o.occurred_at) order by o.sale_request_id), '[]'::json) from public.orders o`);
  const dir = join(migrationsDir, "..", "..", ".g1-client-1", "evidence");

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({ database: db, footprint: footprint(db), orders: JSON.parse(rows), ...extra }, null, 2));
}

// ===========================================================================

run("G1C client contract: real database answers through the real client code", () => {
  const DB = "g1c_contract";
  let amyYesterday = "";
  let yesterday = "";
  let today = "";
  let ben = "";
  let attemptedYesterday = "";
  const transcript: Record<string, unknown>[] = [];

  beforeAll(() => {
    freshDatabase(DB, true);
    seed(DB);

    // The accepted historical fixture (TEST-ONLY): Amy's CLOSED session on
    // till 1 from 10:00 to 18:00 local yesterday, and yesterday's register.
    const start = instantIso(DB, -1, "10 hours");
    const end = instantIso(DB, -1, "18 hours");

    amyYesterday = sql(DB, `insert into public.employee_pos_sessions (employee_id, paired_device_id, started_at, ended_at, end_reason)
      values ('${AMY}', '${device(1)}', '${start}', '${end}', 'logout') returning id::text`);
    yesterday = yesterdayRegister(DB, 1);
    attemptedYesterday = instantIso(DB, -1, "14 hours");

    // Today: Ben is signed in on till 1 and today's register is open.
    ben = signIn(DB, 1, "002", "3333");
    today = dailyRegister(DB, 1);
  }, 600_000);

  afterAll(() => {
    if (PG_BIN !== null) writeEvidence(DB, "client-contract-orders", { transcript });
  });

  const amyOriginal = () => ({
    employeeId: AMY,
    employeePosSessionId: amyYesterday,
    registerSessionId: yesterday,
    attemptedAt: attemptedYesterday,
  });

  it("C1. the lookup's real 'not_found' validates, and decides — it never clears a marker", async () => {
    const t = dbTransport(DB, 1);
    const looked = await lookupDeviceSale(
      { saleRequestId: R("01"), paymentMethod: "cash", tipAmount: 0, items: LATTE, originalEmployeePosSessionId: amyYesterday, originalRegisterSessionId: yesterday },
      { rpc: t.recovery }
    );

    expect(looked).toEqual({ kind: "answer", answer: { status: "not_found" } });
    transcript.push({ case: "C1", looked });
  });

  it("C2. SAME-ID RECOVERY AFTER EMPLOYEE CHANGE AND REGISTER ROLLOVER: marker -> strict queue -> sync -> Amy, yesterday, original time", async () => {
    const before = footprint(DB);
    const marker = await armMarker(R("02"), amyOriginal());
    const t = dbTransport(DB, 1);
    const current = { employeeId: BEN, employeePosSessionId: ben, registerSessionId: today };

    // Ben is at the till today. The lookup finds nothing, and because Ben is
    // not the original employee the sale goes to the strict queue under Amy.
    const outcome = await recoverOutstandingSale(
      { marker, online: true, current },
      {
        lookup: (input) => lookupDeviceSale(input, { rpc: t.recovery }),
        recover: (input) => submitSaleRecovery(input, { rpc: t.recovery }),
      }
    );

    expect(outcome.kind).toBe("queued");
    expect((await readUncertainSale(IDENTITY)).status).toBe("none");
    expect(footprint(DB)).toBe(before);

    // The ordinary sequential engine submits it — through strict recovery only.
    const report = await createSaleSyncEngine({
      submit: (record) => submitQueuedSale(record, { rpc: t.v5, recoveryRpc: t.recovery }),
      now: () => Date.now(),
    }).run();

    expect(report.synced).toBe(1);
    expect(t.calls).toEqual(["get_device_sale_by_request_id", "complete_sale_recovery_v1"]);
    expect(t.calls).not.toContain("complete_sale_v5");

    const order = orderOf(DB, R("02"));

    expect(order).toMatchObject({ employee: AMY, register: yesterday, device: device(1), source: "offline_queued", count: 1 });
    expect(order.occurredAt).toBe(attemptedYesterday);

    const synced = await getSaleByRequestId(R("02"));

    expect(synced.ok && synced.value.state).toBe("synced");
    transcript.push({ case: "C2", outcome: outcome.kind, calls: t.calls, order });
  });

  it("C3. replay of the same strict record returns the SAME order; still exactly one", async () => {
    const t = dbTransport(DB, 1);
    const enqueued = await enqueueSale({
      saleRequestId: R("02"),
      queueRecordId: "q-replay",
      ...IDENTITY,
      paymentMethod: "cash",
      items: LATTE,
      occurredAt: attemptedYesterday,
      now: new Date().toISOString(),
      strictRecovery: {
        originalEmployeeId: AMY,
        originalEmployeePosSessionId: amyYesterday,
        originalRegisterSessionId: yesterday,
        originalAttemptAt: attemptedYesterday,
      },
    });

    if (!enqueued.ok) throw new Error("seed");

    const result = await submitQueuedSale(enqueued.value, { rpc: t.v5, recoveryRpc: t.recovery });

    expect(result.ok).toBe(true);
    expect(orderOf(DB, R("02")).count).toBe(1);
    transcript.push({ case: "C3", ok: result.ok, orderNumber: result.ok ? result.receipt.orderNumber : null });
  });

  it("C4. lookup with the original claims: a REAL 'match / verified' validates field by field and resolves", async () => {
    const t = dbTransport(DB, 1);
    const looked = await lookupDeviceSale(
      { saleRequestId: R("02"), paymentMethod: "cash", tipAmount: 0, items: LATTE, originalEmployeePosSessionId: amyYesterday, originalRegisterSessionId: yesterday },
      { rpc: t.recovery }
    );

    expect(looked.kind).toBe("answer");
    if (looked.kind !== "answer") return;

    expect(looked.answer).toMatchObject({ status: "match", attribution: "verified", order: { employeeId: AMY, registerSessionId: yesterday, source: "offline_queued" } });

    const marker = await armMarker(R("02"), amyOriginal());

    expect(decideAfterLookup(marker, looked.answer, null).step).toBe("resolve_recorded");
    transcript.push({ case: "C4", looked });
  });

  it("C5. LEGACY marker: the real lookup without claims answers 'unverified', the exact clearance evidence", async () => {
    const t = dbTransport(DB, 1);
    const marker = await armMarker(R("02"), null);
    const outcome = await recoverOutstandingSale(
      { marker, online: true, current: null },
      { lookup: (input) => lookupDeviceSale(input, { rpc: t.recovery }) }
    );

    expect(outcome.kind).toBe("recorded");
    expect(t.calls).toEqual(["get_device_sale_by_request_id"]);
    expect((await readUncertainSale(IDENTITY)).status).toBe("none");
    // The order is untouched: still Amy, still one.
    expect(orderOf(DB, R("02"))).toMatchObject({ employee: AMY, count: 1 });
    transcript.push({ case: "C5", outcome: outcome.kind });
  });

  it("C6. a legacy v5 call stored BEN: the real conflict keeps the marker protected and the queue in needs_attention", async () => {
    // An installed client's legacy online call, as Ben, today.
    callAsDevice(DB, 1, "complete_sale_v5", {
      p_payment_method: "cash", p_tip_amount: 0, p_items: LATTE, p_sale_request_id: R("06"),
      p_occurred_at: null, p_source: "online", p_employee_pos_session_id: ben, p_register_session_id: today,
    });
    expect(orderOf(DB, R("06"))).toMatchObject({ employee: BEN, count: 1 });

    const before = footprint(DB);
    const t = dbTransport(DB, 1);
    const marker = await armMarker(R("06"), amyOriginal());
    const outcome = await recoverOutstandingSale(
      { marker, online: true, current: { employeeId: BEN, employeePosSessionId: ben, registerSessionId: today } },
      { lookup: (input) => lookupDeviceSale(input, { rpc: t.recovery }) }
    );

    expect(outcome.kind === "protected" && outcome.reason).toBe("attribution_conflict");
    expect((await readUncertainSale(IDENTITY)).status).toBe("outstanding");

    // And the strict queue path gets the same real answer, filed for a person.
    const enqueued = await enqueueSale({
      saleRequestId: R("06"), queueRecordId: "q-conflict", ...IDENTITY, paymentMethod: "cash", items: LATTE,
      occurredAt: attemptedYesterday, now: new Date().toISOString(),
      strictRecovery: { originalEmployeeId: AMY, originalEmployeePosSessionId: amyYesterday, originalRegisterSessionId: yesterday, originalAttemptAt: attemptedYesterday },
    });

    if (!enqueued.ok) throw new Error("seed");

    const submitted = await submitQueuedSale(enqueued.value, { rpc: t.v5, recoveryRpc: t.recovery });

    expect(submitted.ok).toBe(false);
    if (!submitted.ok) {
      expect(classifySubmissionFailure(submitted.failure, 1)).toEqual({ outcome: "needs_attention", code: "attribution_conflict" });
    }

    expect(footprint(DB)).toBe(before);
    expect(orderOf(DB, R("06"))).toMatchObject({ employee: BEN, count: 1 });
    expect(t.calls).not.toContain("complete_sale_v5");
    transcript.push({ case: "C6", outcome, submitted });
  });

  it("C7. an owner sale (NO device) under the id: the real 'not_this_device' discloses nothing and protects", async () => {
    asRole(DB, OWNER, `select public.complete_sale_v3('${PROJECT}', 'cash', 0, '[{"itemId":"latte","quantity":1}]'::jsonb, '${R("07")}')::text`);

    const t = dbTransport(DB, 1);
    const looked = await lookupDeviceSale(
      { saleRequestId: R("07"), paymentMethod: "cash", tipAmount: 0, items: LATTE, originalEmployeePosSessionId: amyYesterday, originalRegisterSessionId: yesterday },
      { rpc: t.recovery }
    );
    const recovered = await submitSaleRecovery(
      { saleRequestId: R("07"), paymentMethod: "cash", tipAmount: 0, items: LATTE, originalEmployeePosSessionId: amyYesterday, originalRegisterSessionId: yesterday, source: "offline_queued", originalAttemptAt: attemptedYesterday },
      { rpc: t.recovery }
    );

    expect(looked).toEqual({ kind: "answer", answer: { status: "not_this_device" } });
    expect(recovered).toEqual({ kind: "answer", answer: { status: "not_this_device" } });
    transcript.push({ case: "C7", looked, recovered });
  });

  it("C8. a different payload under the id: the real 'payload_mismatch' validates and protects", async () => {
    const t = dbTransport(DB, 1);
    const looked = await lookupDeviceSale(
      { saleRequestId: R("02"), paymentMethod: "cash", tipAmount: 0, items: [{ itemId: "latte", quantity: 2, modifiers: [] }], originalEmployeePosSessionId: null, originalRegisterSessionId: null },
      { rpc: t.recovery }
    );

    expect(looked).toEqual({ kind: "answer", answer: { status: "payload_mismatch" } });
    expect(parseSaleLookupAnswer({ status: "payload_mismatch" })).toEqual({ status: "payload_mismatch" });
  });

  it("C9. unprovable claims (attempt after Amy's session ended): the real refusal is filed, with NO partial writes", async () => {
    const before = footprint(DB);
    const t = dbTransport(DB, 1);
    const enqueued = await enqueueSale({
      saleRequestId: R("09"), queueRecordId: "q-unproven", ...IDENTITY, paymentMethod: "cash", items: LATTE,
      occurredAt: instantIso(DB, -1, "20 hours"), now: new Date().toISOString(),
      strictRecovery: { originalEmployeeId: AMY, originalEmployeePosSessionId: amyYesterday, originalRegisterSessionId: yesterday, originalAttemptAt: instantIso(DB, -1, "20 hours") },
    });

    if (!enqueued.ok) throw new Error("seed");

    await createSaleSyncEngine({
      submit: (record) => submitQueuedSale(record, { rpc: t.v5, recoveryRpc: t.recovery }),
      now: () => Date.now(),
    }).run();

    const record = await getSaleByRequestId(R("09"));

    expect(record.ok && record.value.state).toBe("needs_attention");
    expect(record.ok && record.value.lastErrorCode).toBe("recovery_attribution_unproven");
    expect(footprint(DB)).toBe(before);
    expect(orderOf(DB, R("09"))).toEqual({});
    expect(t.calls).not.toContain("complete_sale_v5");
    transcript.push({ case: "C9", state: record.ok ? record.value.state : null, code: record.ok ? record.value.lastErrorCode : null });
  });

  it("C10. ONLINE strict for the original employee on the original register: created under the current session's employee", async () => {
    // Amy signs back in today; today's register is open.
    const amyToday = signIn(DB, 1, "001", "2222");
    const marker = await armMarker(R("10"), { employeeId: AMY, employeePosSessionId: amyToday, registerSessionId: today, attemptedAt: new Date().toISOString() });
    const t = dbTransport(DB, 1);
    const outcome = await recoverOutstandingSale(
      { marker, online: true, current: { employeeId: AMY, employeePosSessionId: amyToday, registerSessionId: today } },
      {
        lookup: (input) => lookupDeviceSale(input, { rpc: t.recovery }),
        recover: (input) => submitSaleRecovery(input, { rpc: t.recovery }),
      }
    );

    expect(outcome.kind).toBe("completed");
    expect(t.calls).toEqual(["get_device_sale_by_request_id", "complete_sale_recovery_v1"]);
    expect(orderOf(DB, R("10"))).toMatchObject({ employee: AMY, register: today, source: "online", count: 1 });
    expect((await readUncertainSale(IDENTITY)).status).toBe("none");
    transcript.push({ case: "C10", outcome: outcome.kind, order: orderOf(DB, R("10")) });

    // Restore today's operator for any later case.
    ben = signIn(DB, 1, "002", "3333");
  });

  it("C11. online strict refused because the online context moved: the SAME sale goes to the strict queue and syncs", async () => {
    // The marker says Amy on today's register in her (now ended) session; the
    // client believes Amy is still current, but the server has Ben.
    const amyEnded = sql(DB, `select id::text from public.employee_pos_sessions
                              where employee_id='${AMY}' and paired_device_id='${device(1)}' and ended_at is not null
                              order by started_at desc limit 1`);
    const attemptedDuring = sql(DB, `select to_char((started_at + (ended_at - started_at) / 2) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                                     from public.employee_pos_sessions where id='${amyEnded}'`);
    const marker = await armMarker(R("11"), { employeeId: AMY, employeePosSessionId: amyEnded, registerSessionId: today, attemptedAt: attemptedDuring });
    const t = dbTransport(DB, 1);
    const outcome = await recoverOutstandingSale(
      { marker, online: true, current: { employeeId: AMY, employeePosSessionId: amyEnded, registerSessionId: today } },
      {
        lookup: (input) => lookupDeviceSale(input, { rpc: t.recovery }),
        recover: (input) => submitSaleRecovery(input, { rpc: t.recovery }),
      }
    );

    expect(t.calls).toEqual(["get_device_sale_by_request_id", "complete_sale_recovery_v1"]);
    expect(outcome.kind).toBe("queued");

    await createSaleSyncEngine({
      submit: (record) => submitQueuedSale(record, { rpc: t.v5, recoveryRpc: t.recovery }),
      now: () => Date.now(),
    }).run();

    expect(orderOf(DB, R("11"))).toMatchObject({ employee: AMY, register: today, source: "offline_queued", count: 1 });
    expect(t.calls).not.toContain("complete_sale_v5");
    transcript.push({ case: "C11", outcome: outcome.kind, order: orderOf(DB, R("11")) });
  });
});

run("G1C missing function: a database WITHOUT the migration keeps the sale protected", () => {
  const DB = "g1c_missing";

  beforeAll(() => {
    freshDatabase(DB, false);
    seed(DB);
  }, 600_000);

  it("M1. the real undefined-function error is a refusal; nothing is created and v5 is never tried", async () => {
    const t = dbTransport(DB, 1);
    const marker = await armMarker(R("91"), {
      employeeId: AMY,
      employeePosSessionId: "5e550000-0000-4000-8000-000000000001",
      registerSessionId: "f0000000-0000-4000-8000-000000000001",
      attemptedAt: new Date().toISOString(),
    });
    const outcome = await recoverOutstandingSale(
      { marker, online: true, current: null },
      { lookup: (input) => lookupDeviceSale(input, { rpc: t.recovery }) }
    );

    expect(outcome.kind).toBe("protected");
    expect(t.calls).toEqual(["get_device_sale_by_request_id"]);
    expect(t.calls).not.toContain("complete_sale_v5");
    expect((await readUncertainSale(IDENTITY)).status).toBe("outstanding");
    expect(sql(DB, "select count(*) from public.orders")).toBe("0");

    const raw = callAsDevice(DB, 1, "get_device_sale_by_request_id", { p_sale_request_id: R("91"), p_payment_method: "cash", p_items: LATTE });

    expect((raw.error as { code: string }).code).toBe("42883");
    writeEvidence(DB, "client-missing-function", { outcome, rawError: raw.error });
  });
});
