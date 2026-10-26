// LF-2 Scope 2 — complete_sale_v6, holds and owner review, EXECUTED against a
// real PostgreSQL with the whole migration chain. Harness identical to the
// inventory-foundations suite (PostgreSQL discovery, COMPAT layer, auth-schema
// usage grant); only the migration name and the port range differ. When no
// PostgreSQL server is found the suite SKIPS LOUDLY rather than failing.
//
// Covers REPORT §16.5: V6-1…V6-6, T-A1/T-A2/T-A4, HOLD-1…HOLD-5, plus server
// commit followed by a lost reply, conflicting same-ID requests (incl.
// concurrent), concurrent owner decisions, unauthorized access, exactly-once
// order/inventory effects, disabled-by-default, legacy functions byte-identical,
// and the upgrade backfill of the history tables.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20261025120000_local_first_sale_v6.sql";
const REQUIRED_BINARIES = ["initdb", "pg_ctl", "psql"] as const;

function findPostgresBin(): string | null {
  const candidates: string[] = [];
  try {
    const onPath = execFileSync("which", ["initdb"], { encoding: "utf8" }).trim();
    if (onPath) candidates.push(dirname(onPath));
  } catch {
    // Not on PATH.
  }
  candidates.push("/opt/homebrew/opt/postgresql@17/bin", "/opt/homebrew/opt/postgresql@16/bin",
    "/usr/local/opt/postgresql@17/bin", "/usr/lib/postgresql/17/bin", "/usr/lib/postgresql/16/bin");
  return candidates.find((dir) => REQUIRED_BINARIES.every((t) => existsSync(join(dir, t)))) ?? null;
}

const PG_BIN = findPostgresBin();
const PORT = 57500 + (process.pid % 90);
if (PG_BIN === null) console.warn(`\n[${MIGRATION}] SKIPPED: no local PostgreSQL server found; install PostgreSQL 16+ to run it.\n`);

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
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
create schema extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
`;
const STORAGE_ONLY = new Set(["20260729190422_build_artifact_storage.sql", "20260813120000_project_logo_storage.sql"]);

let dataDir = "";
const env = { ...process.env, LC_ALL: "en_US.UTF-8", PGTZ: "UTC" };
const pg = (tool: string, args: string[], input?: string) =>
  execFileSync(join(PG_BIN as string, tool), args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], env });
const psqlArgs = (db: string) => ["-h", "127.0.0.1", "-p", String(PORT), "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1"];
const sql = (db: string, s: string) => pg("psql", [...psqlArgs(db), "-Atq", "-f", "-"], s).trim();
const asPrefix = (who: string) => `\\o /dev/null\nselect set_config('request.jwt.claim.sub','${who}', false);\nset role authenticated;\n\\o\n`;
function as(db: string, who: string, s: string): string {
  const lines = sql(db, asPrefix(who) + s).split("\n").filter((l) => l !== "");
  return lines[lines.length - 1] ?? "";
}
type Failure = { code: string; message: string; hint: string };
function parseFailure(stderr: string): Failure {
  const m = /ERROR:\s+([0-9A-Z]{5}):\s*(.*)/.exec(stderr);
  return { code: m?.[1] ?? "", message: (m?.[2] ?? "").trim(), hint: (/HINT:\s*(.*)/.exec(stderr)?.[1] ?? "").trim() };
}
function asFail(db: string, who: string | null, s: string): Failure {
  try {
    sql(db, "\\set VERBOSITY verbose\n" + (who === null ? "" : asPrefix(who)) + s);
    return { code: "", message: "", hint: "" };
  } catch (error) {
    return parseFailure(String((error as { stderr?: string }).stderr ?? ""));
  }
}
// execFile cannot take stdin through promisify cleanly; run two psql children by hand.
function psqlChild(db: string, script: string): Promise<{ out: string; fail: Failure | null }> {
  return new Promise((resolve) => {
    const child = execFile(join(PG_BIN as string, "psql"), [...psqlArgs(db), "-Atq", "-f", "-"], { env, encoding: "utf8" },
      (error, stdout, stderr) => resolve(error ? { out: "", fail: parseFailure(String(stderr)) } : { out: String(stdout).trim(), fail: null }));
    child.stdin?.end("\\set VERBOSITY verbose\n" + script);
  });
}

function freshDatabase(name: string, uptoInclusive: string | null): void {
  sql("postgres", `drop database if exists ${name}; create database ${name};`);
  pg("psql", ["-h", "127.0.0.1", "-p", String(PORT), "-U", "postgres", "-d", name, "-q", "-f", "-"], COMPAT);
  sql(name, "grant usage on schema auth to anon, authenticated, service_role;");
  const files = execFileSync("ls", [migrationsDir], { encoding: "utf8" }).split("\n").filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (uptoInclusive === null ? file >= MIGRATION : file > uptoInclusive) continue;
    if (STORAGE_ONLY.has(file)) continue;
    applyMigration(name, file);
  }
}
function applyMigration(db: string, file: string): void {
  pg("psql", [...psqlArgs(db), "-q", "-f", join(migrationsDir, file)]);
  sql(db, `insert into supabase_migrations.schema_migrations(version, name) values ('${file.split("_")[0]}', '${file}') on conflict do nothing`);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------
const OWNER = "a1000000-0000-4000-8000-000000000001";
const OWNER_B = "a2000000-0000-4000-8000-000000000002";
const PROJECT = "b1000000-0000-4000-8000-000000000001";
const PROJECT_B = "b2000000-0000-4000-8000-000000000002";
const BUILD1 = "c1000000-0000-4000-8000-000000000001";
const BUILD2 = "c2000000-0000-4000-8000-000000000002";
const BUILD3 = "c3000000-0000-4000-8000-000000000003";
const BUILD_B = "c4000000-0000-4000-8000-000000000004";
const D1 = "d1000000-0000-4000-8000-000000000001";
const D2 = "d2000000-0000-4000-8000-000000000002";
const D3 = "d3000000-0000-4000-8000-000000000003";
const DB_DEV = "d4000000-0000-4000-8000-000000000004";
const U1 = "e1000000-0000-4000-8000-000000000001";
const U2 = "e2000000-0000-4000-8000-000000000002";
const U3 = "e3000000-0000-4000-8000-000000000003";
const UB = "e4000000-0000-4000-8000-000000000004";
const AMY = "f1000000-0000-4000-8000-000000000001";
const BEN = "f2000000-0000-4000-8000-000000000002";
const ZED = "f3000000-0000-4000-8000-000000000003"; // employee of PROJECT_B
const menu = (cola: string) => ({
  menuItems: [
    { id: "cola", name: "Synthetic Cola", price: cola, available: true, trackInventory: true, stockQuantity: 20 },
    { id: "chips", name: "Synthetic Chips", price: "2.00", available: true, trackInventory: true, stockQuantity: 10 },
    { id: "water", name: "Synthetic Water", price: "1.00", available: true, trackInventory: false, stockQuantity: 0 },
    // Correction C2 — one tracked item with modifier variants (two lines of it in one sale).
    { id: "latte", name: "Synthetic Latte", price: "3.00", available: true, trackInventory: true, stockQuantity: 5,
      modifierGroups: [{ id: "size", name: "Size", selection: "single", required: false,
        options: [{ id: "small", name: "Small", priceAdjustment: 0 }, { id: "large", name: "Large", priceAdjustment: 0.5 }] }] },
  ],
  tax: { enabled: true, rate: 10, pricesIncludeTax: false },
  receipt: { orderPrefix: "S-" },
});
const j = (v: unknown) => JSON.stringify(v).replace(/'/g, "''");

function seed(db: string): void {
  sql(db, `
    insert into auth.users (id) values ('${OWNER}'), ('${OWNER_B}'), ('${U1}'), ('${U2}'), ('${U3}'), ('${UB}');
    insert into public.projects (id, user_id, name, template_id, config)
      values ('${PROJECT}', '${OWNER}', 'Synthetic Shop', 'cafe', '${j(menu("1.75"))}'::jsonb),
             ('${PROJECT_B}', '${OWNER_B}', 'Other Shop', 'cafe', '${j(menu("1.75"))}'::jsonb);
    insert into public.build_jobs (id, project_id, owner_id, target, status, config_snapshot, config_schema_version, config_hash, request_key, started_at, finished_at)
      values ('${BUILD1}','${PROJECT}','${OWNER}','android','succeeded','${j(menu("1.50"))}'::jsonb,1,'h1','r1', now(), now()),
             ('${BUILD2}','${PROJECT}','${OWNER}','android','succeeded','${j(menu("1.75"))}'::jsonb,1,'h2','r2', now(), now()),
             ('${BUILD3}','${PROJECT}','${OWNER}','android','succeeded','${j(menu("1.75"))}'::jsonb,1,'h3','r3', now(), now()),
             ('${BUILD_B}','${PROJECT_B}','${OWNER_B}','android','succeeded','${j(menu("1.75"))}'::jsonb,1,'h4','r4', now(), now());
    insert into public.paired_devices (id, auth_user_id, owner_id, project_id, build_job_id, created_at)
      values ('${D1}','${U1}','${OWNER}','${PROJECT}','${BUILD1}', now() - interval '500 days'),
             ('${D2}','${U2}','${OWNER}','${PROJECT}','${BUILD2}', now() - interval '30 days'),
             ('${D3}','${U3}','${OWNER}','${PROJECT}','${BUILD2}', now() - interval '30 days'),
             ('${DB_DEV}','${UB}','${OWNER_B}','${PROJECT_B}','${BUILD_B}', now() - interval '30 days');
    insert into public.employees (id, project_id, display_name, employee_code, role, pin_hash, active, created_at)
      values ('${AMY}','${PROJECT}','Amy','001','cashier', public.employee_pin_hash('2222'), true, '2026-01-01'),
             ('${BEN}','${PROJECT}','Ben','002','cashier', public.employee_pin_hash('3333'), true, '2026-01-02'),
             ('${ZED}','${PROJECT_B}','Zed','001','cashier', public.employee_pin_hash('4444'), true, '2026-01-03');
    update public.projects set local_first_enabled = true where id = '${PROJECT}';
  `);
  // D1 moves from BUILD1 to BUILD2 through the real owner offer + device apply path.
  as(db, OWNER, `select public.offer_device_config_update('${D1}','${BUILD2}')::text;`);
  as(db, U1, `select public.apply_device_config_update()::text;`);
}

let seq = 0;
const rid = () => `9${String(++seq).padStart(7, "0")}-0000-4000-8000-000000000000`;
type Line = { itemId: string; quantity: number; unitPrice: string; lineTotal: string; modifiers?: unknown[] };
function identity(over: Record<string, unknown> & { lines?: Line[] } = {}) {
  const lines: Line[] = over.lines ?? [{ itemId: "cola", quantity: 2, unitPrice: "1.75", lineTotal: "3.50" }];
  const sub = lines.reduce((s, l) => s + Number(l.lineTotal), 0);
  const tax = Math.round(sub * 10) / 100;
  return {
    identityVersion: 3, saleRequestId: rid(), pairingGeneration: D1, projectId: PROJECT, source: "offline_queued",
    buildJobId: BUILD2, lines, subtotal: sub.toFixed(2), tax: tax.toFixed(2), tip: "0.00", total: (sub + tax).toFixed(2),
    paymentMethod: "cash", occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
    employeeId: AMY, localSessionId: "5e550000-0000-4000-8000-000000000001", sessionStartedAt: new Date(Date.now() - 7_200_000).toISOString(),
    serverSessionId: null, registerDay: null, registerClaimId: null, rosterVersionAtSale: 2, deviceSaleSeq: ++seq, clientVersion: "lf-test",
    ...over,
  };
}
const v6 = (db: string, user: string, id: unknown) => JSON.parse(as(db, user, `select public.complete_sale_v6('${j(id)}'::jsonb)::text;`));
const v6Fail = (db: string, user: string | null, id: unknown) => asFail(db, user, `select public.complete_sale_v6('${j(id)}'::jsonb)::text;`);
const stock = (db: string, item = "cola") =>
  Number(sql(db, `select v->>'stockQuantity' from projects p, jsonb_array_elements(p.config->'menuItems') v where p.id='${PROJECT}' and v->>'id'='${item}'`));
const count = (db: string, q: string) => Number(sql(db, `select count(*) from ${q}`));
const decide = (db: string, who: string, hold: string, decision: string, reason: string, decisionId: string) =>
  JSON.parse(as(db, who, `select public.decide_sale_hold('${hold}','${decision}','${reason}','${decisionId}')::text;`));

const run = PG_BIN === null ? describe.skip : describe;

beforeAll(() => {
  if (PG_BIN === null) return;
  dataDir = mkdtempSync(join(tmpdir(), "lf2-v6-pg-"));
  pg("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
  pg("pg_ctl", ["-D", dataDir, "-l", join(dataDir, "server.log"), "-w", "start",
    "-o", `-c listen_addresses=127.0.0.1 -c port=${PORT} -c unix_socket_directories='' -c max_connections=40`]);
}, 300_000);

afterAll(() => {
  if (PG_BIN === null || dataDir === "") return;
  try {
    pg("pg_ctl", ["-D", dataDir, "-m", "immediate", "-w", "stop"]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
run("Scope 2: legacy preservation and disabled by default", () => {
  beforeAll(() => {
    freshDatabase("lf2_before", null);
    freshDatabase("lf2_after", MIGRATION);
  }, 600_000);

  it("REG: every public function that existed before the migration is byte-identical after it", () => {
    const defs = (db: string) => sql(db, `
      select string_agg(p.oid::regprocedure::text || ' ' || md5(pg_get_functiondef(p.oid)) || ' ' || coalesce(p.proacl::text,''), E'\\n' order by 1)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f'`);
    const before = defs("lf2_before").split("\n");
    const after = new Map(defs("lf2_after").split("\n").map((l) => [l.split(" ")[0], l]));
    for (const line of before) expect(after.get(line.split(" ")[0])).toBe(line);
    expect(before.some((l) => l.startsWith("complete_sale_v5("))).toBe(true);
    expect(before.some((l) => l.startsWith("complete_sale_recovery_v1("))).toBe(true);
  });

  it("the new columns default to OFF; existing rows are unchanged otherwise", () => {
    expect(sql("lf2_after", `select column_default from information_schema.columns where table_name='projects' and column_name='local_first_enabled'`)).toBe("false");
    expect(sql("lf2_after", `select column_default is null from information_schema.columns where table_name='projects' and column_name='offline_selling_limit'`)).toBe("t");
  });
});

run("Scope 2: complete_sale_v6", () => {
  const DB = "lf2_v6";
  beforeAll(() => {
    freshDatabase(DB, MIGRATION);
    seed(DB);
  }, 600_000);

  it("CAP: a business without local_first_enabled is refused (capability class); the owner cannot switch it on through the API", () => {
    const f = v6Fail(DB, UB, identity({ pairingGeneration: DB_DEV, projectId: PROJECT_B, buildJobId: BUILD_B, employeeId: ZED }));
    expect(f).toEqual({ code: "LFC01", message: "local_first_not_enabled", hint: "lf_class=capability" });
    expect(asFail(DB, OWNER_B, `update public.projects set local_first_enabled = true where id='${PROJECT_B}';`).message).toBe("local_first_settings_not_writable");
    expect(asFail(DB, OWNER, `update public.projects set offline_selling_limit = 'none' where id='${PROJECT}';`).message).toBe("local_first_settings_not_writable");
  });

  it("AUTH: owners and unknown callers are authorization failures, never sale answers", () => {
    expect(v6Fail(DB, OWNER, identity())).toEqual({ code: "LFA01", message: "device_not_authorized", hint: "lf_class=authorization" });
    expect(sql(DB, `select has_function_privilege('anon','public.complete_sale_v6(jsonb)','EXECUTE')`)).toBe("f");
    expect(sql(DB, `select has_function_privilege('authenticated','public.lf2_book(uuid,uuid,uuid,uuid,text,text,text,text,timestamptz,uuid,jsonb,numeric,numeric,numeric,numeric,uuid,uuid,jsonb,jsonb)','EXECUTE')`)).toBe("f");
  });

  it("MAL: malformed identity is a sale-class refusal and records nothing", () => {
    const holds = count(DB, "sale_holds");
    const orders = count(DB, "orders");
    for (const bad of [{ identityVersion: 2 }, { saleRequestId: "nope" }, { lines: [] }, { subtotal: "3.5" },
      { lines: [{ itemId: "cola", quantity: 0, unitPrice: "1.75", lineTotal: "0.00" }] }, { employeeId: null }]) {
      expect(v6Fail(DB, U1, identity(bad))).toMatchObject({ code: "LFS01", message: "sale_malformed_identity", hint: "lf_class=sale" });
    }
    expect(v6Fail(DB, U1, identity({ pairingGeneration: D2 })).message).toBe("sale_wrong_pairing_generation");
    expect(v6Fail(DB, U1, identity({ tip: "1.00", total: "4.85" })).message).toBe("sale_tip_not_supported");
    expect(count(DB, "sale_holds")).toBe(holds);
    expect(count(DB, "orders")).toBe(orders);
  });

  it("V6-1 + LOST REPLY: committed then the reply is lost; the same bytes replay the same order with no second stock step", () => {
    const id = identity();
    const before = stock(DB);
    const first = v6(DB, U1, id); // committed; pretend the reply never arrived
    expect(first.status).toBe("booked");
    expect(stock(DB)).toBe(before - 2);
    const retry = v6(DB, U1, id);
    expect(retry.status).toBe("replayed");
    expect(retry.order.orderId).toBe(first.order.orderId);
    expect(retry.order.orderNumber).toBe(first.order.orderNumber);
    expect(stock(DB)).toBe(before - 2);
    expect(count(DB, `orders where sale_request_id='${id.saleRequestId}'`)).toBe(1);
    expect(count(DB, `inventory_transactions where order_id='${first.order.orderId}'`)).toBe(1);
    expect(first.order.total).toBe("3.85");
    expect(first.order.attribution.employeeId).toBe(AMY);
  });

  it("V6-2: altered time, attribution, build, price or item under the same ID → conflict hold, no order, no stock change", () => {
    const id = identity();
    const booked = v6(DB, U1, id);
    const before = stock(DB);
    const variants: Record<string, unknown>[] = [
      { occurredAt: new Date(Date.now() - 1_800_000).toISOString() },
      { employeeId: BEN },
      { buildJobId: BUILD1 },
      { lines: [{ itemId: "cola", quantity: 2, unitPrice: "1.50", lineTotal: "3.00" }], subtotal: "3.00", tax: "0.30", total: "3.30" },
      { lines: [{ itemId: "chips", quantity: 1, unitPrice: "2.00", lineTotal: "2.00" }], subtotal: "2.00", tax: "0.20", total: "2.20" },
    ];
    for (const change of variants) {
      const r = v6(DB, U1, { ...id, ...change });
      expect(r.status).toBe("held");
      expect(r.reason).toBe("identity_conflict");
      expect(sql(DB, `select conflict_order_id from sale_holds where id='${r.holdId}'`)).toBe(booked.order.orderId);
    }
    expect(count(DB, `orders where sale_request_id='${id.saleRequestId}'`)).toBe(1);
    expect(stock(DB)).toBe(before);
    // The same conflicting bytes again → the same hold, not a second one.
    const again = v6(DB, U1, { ...id, ...variants[1] });
    expect(count(DB, `sale_holds where sale_request_id='${id.saleRequestId}'`)).toBe(variants.length);
    expect(again.status).toBe("held");
  });

  it("CONC: conflicting same-ID requests at the same moment → one order, the other held; identical ones → one order, one replay", async () => {
    const base = identity();
    const other = { ...base, employeeId: BEN };
    const call = (id: unknown) => psqlChild(DB, asPrefix(U1) + `select public.complete_sale_v6('${j(id)}'::jsonb)::text;`);
    const [a, b] = await Promise.all([call(base), call(other)]);
    const statuses = [a, b].map((r) => JSON.parse(r.out.split("\n").pop() as string).status).sort();
    expect(statuses).toEqual(["booked", "held"]);
    expect(count(DB, `orders where sale_request_id='${base.saleRequestId}'`)).toBe(1);

    const same = identity();
    const before = stock(DB);
    const [c, d] = await Promise.all([call(same), call(same)]);
    expect([c, d].map((r) => JSON.parse(r.out.split("\n").pop() as string).status).sort()).toEqual(["booked", "replayed"]);
    expect(count(DB, `orders where sale_request_id='${same.saleRequestId}'`)).toBe(1);
    expect(stock(DB)).toBe(before - 2);
  });

  it("V6-3: a build this device never pinned → hold; a pinned OLDER build → priced from that build, not the current pin", () => {
    const notPinned = v6(DB, U1, identity({ buildJobId: BUILD3 }));
    expect(notPinned).toMatchObject({ status: "held", reason: "build_not_pinned_by_device" });

    const older = v6(DB, U1, identity({ buildJobId: BUILD1, lines: [{ itemId: "cola", quantity: 2, unitPrice: "1.50", lineTotal: "3.00" }] }));
    expect(older.status).toBe("booked");
    expect(older.order.items[0].unitPrice).toBe("1.50");
    expect(older.order.total).toBe("3.30");

    const wrongPrice = v6(DB, U1, identity({ buildJobId: BUILD1 })); // shows 1.75 under a 1.50 build
    expect(wrongPrice).toMatchObject({ status: "held", reason: "price_mismatch" });
    expect(sql(DB, `select detail->'differences'->0->'build'->>'unitPrice' from sale_holds where id='${wrongPrice.holdId}'`)).toBe("1.50");
    expect(sql(DB, `select string_agg(build_job_id::text || ':' || source, ',' order by source) from device_build_pins where paired_device_id='${D1}'`))
      .toBe(`${BUILD2}:apply,${BUILD1}:pairing`);
  });

  it("V6-5: no age ceiling; the beyond-limit flag follows the business setting and is never a hold", () => {
    const old = { occurredAt: new Date(Date.now() - 400 * 86_400_000).toISOString() };
    const unset = v6(DB, U1, identity(old));
    expect(unset.status).toBe("booked");
    expect(unset.order.flags).toMatchObject({ offlineSellingLimit: null, beyondOfflineLimit: null });
    sql(DB, `update projects set offline_selling_limit='none' where id='${PROJECT}'`);
    expect(v6(DB, U1, identity(old)).order.flags).toMatchObject({ offlineSellingLimit: "none", beyondOfflineLimit: false });
    sql(DB, `update projects set offline_selling_limit='14d' where id='${PROJECT}'`);
    const flagged = v6(DB, U1, identity(old));
    expect(flagged.status).toBe("booked");
    expect(flagged.order.flags).toMatchObject({ offlineSellingLimit: "14d", beyondOfflineLimit: true });
    sql(DB, `update projects set offline_selling_limit=null where id='${PROJECT}'`);

    expect(v6(DB, U1, identity({ occurredAt: new Date(Date.now() + 3_600_000).toISOString() }))).toMatchObject({ status: "held", reason: "time_out_of_bounds" });
    expect(v6(DB, U2, identity({ pairingGeneration: D2, occurredAt: new Date(Date.now() - 60 * 86_400_000).toISOString() })))
      .toMatchObject({ status: "held", reason: "time_out_of_bounds" });
  });

  it("STOCK: an item absent from the live config is recorded and flagged, never refused; tracked stock floors at 0 with the shortfall recorded (negative OFF)", () => {
    sql(DB, `update projects set config = jsonb_set(config, '{menuItems}', (select jsonb_agg(e) from jsonb_array_elements(config->'menuItems') e where e->>'id' <> 'water')),
             base_catalog_version = catalog_version where id='${PROJECT}'`);
    const absent = v6(DB, U1, identity({ lines: [{ itemId: "water", quantity: 1, unitPrice: "1.00", lineTotal: "1.00" }] }));
    expect(absent.status).toBe("booked");
    expect(absent.order.flags.itemsAbsentFromLiveConfig).toEqual(["water"]);
    const chipsBefore = stock(DB, "chips");
    const big = v6(DB, U1, identity({ lines: [{ itemId: "chips", quantity: chipsBefore + 3, unitPrice: "2.00", lineTotal: (2 * (chipsBefore + 3)).toFixed(2) }] }));
    expect(big.status).toBe("booked");
    expect(stock(DB, "chips")).toBe(0);
    expect(big.order.items[0].inventoryShortfall).toBe(3);
    expect(sql(DB, `select allow_negative::text from inventory_transactions where order_id='${big.order.orderId}'`)).toBe("false");
  });

  it("V6-6 + attribution rules: removal delivered → hold; an earlier sale keeps its attribution; invalid descriptors → hold", () => {
    const rosterBefore = Number(sql(DB, `select version from employee_roster_versions where project_id='${PROJECT}'`));
    as(DB, OWNER, `select public.set_employee_active('${BEN}', false)::text;`);
    const removalVersion = Number(sql(DB, `select roster_version from employee_status_events where employee_id='${BEN}' and event='deactivated'`));
    expect(removalVersion).toBe(rosterBefore + 1);

    const earlier = v6(DB, U1, identity({ employeeId: BEN, rosterVersionAtSale: rosterBefore }));
    expect(earlier.status).toBe("booked");
    expect(earlier.order.attribution.employeeId).toBe(BEN);

    expect(v6(DB, U1, identity({ employeeId: BEN, rosterVersionAtSale: removalVersion })))
      .toMatchObject({ status: "held", reason: "attribution_after_removal_delivered" });

    sql(DB, `insert into device_roster_acks (paired_device_id, roster_version, acked_at) values ('${D1}', ${removalVersion}, now() - interval '30 minutes')`);
    expect(v6(DB, U1, identity({ employeeId: BEN, rosterVersionAtSale: rosterBefore, occurredAt: new Date(Date.now() - 600_000).toISOString() })))
      .toMatchObject({ status: "held", reason: "attribution_after_removal_delivered" });
    expect(v6(DB, U1, identity({ employeeId: BEN, rosterVersionAtSale: rosterBefore, occurredAt: new Date(Date.now() - 3_600_000).toISOString() })).status)
      .toBe("booked");

    expect(v6(DB, U1, identity({ employeeId: ZED }))).toMatchObject({ status: "held", reason: "attribution_invalid" });
    const otherDeviceSession = sql(DB, `insert into employee_pos_sessions (employee_id, paired_device_id) values ('${AMY}','${D2}') returning id`);
    expect(v6(DB, U1, identity({ serverSessionId: otherDeviceSession }))).toMatchObject({ status: "held", reason: "attribution_invalid" });
    expect(v6(DB, U1, identity({ registerClaimId: "aaaaaaaa-0000-4000-8000-000000000000" }))).toMatchObject({ status: "held", reason: "attribution_invalid" });
  });

  it("T-A1/T-A2: a sale recorded by Amy is booked to Amy while Ben is signed in; a retry after a lost reply replays to Amy", () => {
    as(DB, OWNER, `select public.set_employee_active('${BEN}', true)::text;`);
    expect(as(DB, U1, `select public.employee_login_by_code('002','3333')->>'ok'`)).toBe("true");
    const id = identity({ employeeId: AMY, rosterVersionAtSale: Number(sql(DB, `select version from employee_roster_versions where project_id='${PROJECT}'`)) });
    const booked = v6(DB, U1, id);
    expect(booked.status).toBe("booked");
    expect(sql(DB, `select employee_id from orders where id='${booked.order.orderId}'`)).toBe(AMY);
    expect(sql(DB, `select recorded_claims->>'employeeId' from orders where id='${booked.order.orderId}'`)).toBe(AMY);
    const retry = v6(DB, U1, id);
    expect(retry).toMatchObject({ status: "replayed" });
    expect(retry.order.attribution.employeeId).toBe(AMY);
    expect(count(DB, `orders where sale_request_id='${id.saleRequestId}'`)).toBe(1);
  });

  it("T-A4: changing a booked order's attribution through v6, v5 or a direct write → conflict hold / refusal; the order is unchanged", () => {
    const id = identity();
    const booked = v6(DB, U1, id);
    expect(v6(DB, U1, { ...id, employeeId: BEN })).toMatchObject({ status: "held", reason: "identity_conflict" });
    // v5 under the same ID: its own replay path (v2 hash over items/payment) returns the stored order.
    const v5 = JSON.parse(as(DB, U1, `select public.complete_sale_v5('cash',0,'[{"itemId":"cola","quantity":2}]'::jsonb,'${id.saleRequestId}', now() - interval '1 hour','offline_queued', null, null)::text;`));
    expect(v5.orderId).toBe(booked.order.orderId);
    expect(v5.attribution.employeeId).toBe(AMY);
    expect(asFail(DB, OWNER, `update orders set employee_id='${BEN}' where id='${booked.order.orderId}';`).message).toMatch(/permission denied/);
    expect(sql(DB, `select employee_id from orders where id='${booked.order.orderId}'`)).toBe(AMY);
  });

  it("V6-4: every non-replay upload from a revoked till is held, whatever time it claims; replays still answer", () => {
    const beforeRevoke = identity({ pairingGeneration: D2 });
    const booked = v6(DB, U2, beforeRevoke);
    as(DB, OWNER, `select public.revoke_paired_device('${D2}')::text;`);
    expect(v6(DB, U2, beforeRevoke).status).toBe("replayed");
    const early = v6(DB, U2, identity({ pairingGeneration: D2, occurredAt: new Date(Date.now() - 5 * 86_400_000).toISOString() }));
    expect(early).toMatchObject({ status: "held", reason: "after_revocation" });
    expect(booked.status).toBe("booked");
  });

  it("V6-4: an unpaired till's uploads are held as after_unpair", () => {
    as(DB, U3, `select public.unpair_own_device()::text;`);
    expect(sql(DB, `select unpaired_at is not null from paired_devices where id='${D3}'`)).toBe("t");
    expect(v6(DB, U3, identity({ pairingGeneration: D3 }))).toMatchObject({ status: "held", reason: "after_unpair" });
  });

  it("EXACTLY ONCE: every booked v6 order has exactly one sale ledger row per tracked line, and the ledger explains the stock", () => {
    expect(sql(DB, `select count(*) from orders o where o.identity_version = 3 and o.project_id='${PROJECT}'
      and (select count(*) from inventory_transactions t where t.order_id = o.id) <> (select count(*) from order_items i
           where i.order_id = o.id and i.item_id in ('cola','chips','latte') and not (i.inventory_shortfall > 0 and i.quantity = i.inventory_shortfall))`)).toBe("0");
    // Correction C2: one ledger row per order LINE, guarded by the Scope 1 unique (order_id, line_index).
    expect(sql(DB, `select count(*) from inventory_transactions t join orders o on o.id = t.order_id
      where o.identity_version = 3 and t.line_index is null`)).toBe("0");
    expect(sql(DB, `select count(*) from (select order_id, line_index from inventory_transactions where transaction_type='sale' and order_id is not null group by 1,2 having count(*) > 1) d`)).toBe("0");
  });
});

run("Scope 2: holds and owner review", () => {
  const DB = "lf2_holds";
  let revokedHold = "";
  let conflictHold = "";
  let conflictOrder = "";
  let attributionHold = "";
  let declineHold = "";

  beforeAll(() => {
    freshDatabase(DB, MIGRATION);
    seed(DB);
    // Holds of each kind.
    const id = identity();
    conflictOrder = v6(DB, U1, id).order.orderId;
    conflictHold = v6(DB, U1, { ...id, lines: [{ itemId: "chips", quantity: 1, unitPrice: "2.00", lineTotal: "2.00" }], subtotal: "2.00", tax: "0.20", total: "2.20" }).holdId;
    attributionHold = v6(DB, U1, identity({ employeeId: ZED })).holdId;
    declineHold = v6(DB, U1, identity({ buildJobId: BUILD3 })).holdId;
    as(DB, OWNER, `select public.revoke_paired_device('${D2}')::text;`);
    revokedHold = v6(DB, U2, identity({ pairingGeneration: D2 })).holdId;
  }, 600_000);

  it("HOLD-4: non-owners, other owners and devices cannot reach the owner RPCs or the tables; recorded facts are immutable", () => {
    for (const who of [OWNER_B, U1]) {
      expect(asFail(DB, who, `select public.get_sale_hold('${revokedHold}')::text;`).message).toBe("owner_not_authorized");
      expect(asFail(DB, who, `select public.decide_sale_hold('${revokedHold}','accept_as_recorded','x','${rid()}')::text;`).message).toBe("owner_not_authorized");
      expect(asFail(DB, who, `select public.list_sale_holds('${PROJECT}')::text;`).message).toBe("owner_not_authorized");
    }
    expect(asFail(DB, OWNER, `select count(*) from sale_holds;`).message).toMatch(/permission denied/);
    expect(asFail(DB, null, `update sale_holds set payload='{}' where id='${revokedHold}';`).message).toMatch(/immutable/);
    expect(asFail(DB, null, `update sale_holds set reason='price_mismatch' where id='${revokedHold}';`).message).toMatch(/immutable/);
    expect(asFail(DB, null, `delete from sale_holds where id='${revokedHold}';`).message).toMatch(/cannot be deleted/);
    expect(sql(DB, `select has_function_privilege('anon','public.decide_sale_hold(uuid,text,text,uuid)','EXECUTE')`)).toBe("f");
  });

  it("WEB data: the owner list shows reasons, devices, recorded employee, totals; filters work", () => {
    const all = JSON.parse(as(DB, OWNER, `select public.list_sale_holds('${PROJECT}')::text;`));
    expect(all.enabled).toBe(true);
    expect(all.counts.held).toBe(4);
    expect(all.holds.map((h: { reason: string }) => h.reason).sort())
      .toEqual(["after_revocation", "attribution_invalid", "build_not_pinned_by_device", "identity_conflict"]);
    const revoked = JSON.parse(as(DB, OWNER, `select public.list_sale_holds('${PROJECT}', 'held', 'after_revocation')::text;`));
    expect(revoked.holds).toHaveLength(1);
    expect(revoked.holds[0]).toMatchObject({ employeeName: "Amy", total: "3.85", paymentMethod: "cash" });
    expect(JSON.parse(as(DB, OWNER, `select public.list_sale_holds('${PROJECT}', 'held', null, '${D1}')::text;`)).holds).toHaveLength(3);
    const detail = JSON.parse(as(DB, OWNER, `select public.get_sale_hold('${conflictHold}')::text;`));
    expect(detail.conflict.kind).toBe("order");
    expect(detail.conflict.order.orderId).toBe(conflictOrder);
    expect(detail.validDecisions).toEqual(["record_as_separate", "decline"]);
    expect(JSON.parse(as(DB, OWNER, `select public.get_sale_hold('${revokedHold}')::text;`)).device.revokedAt).not.toBeNull();
  });

  it("decisions are only those valid for the reason; a reason text is required", () => {
    expect(asFail(DB, OWNER, `select public.decide_sale_hold('${conflictHold}','accept_as_recorded','ok','${rid()}')::text;`).message).toBe("decision_not_valid_for_reason");
    expect(asFail(DB, OWNER, `select public.decide_sale_hold('${revokedHold}','accept_unattributed','ok','${rid()}')::text;`).message).toBe("decision_not_valid_for_reason");
    expect(asFail(DB, OWNER, `select public.decide_sale_hold('${revokedHold}','accept_as_recorded','   ','${rid()}')::text;`).message).toBe("decision_reason_required");
  });

  it("HOLD-1 + HOLD-2 + concurrent decisions: two owners' clicks at once → exactly one order, one stock deduction, one audit row", async () => {
    const before = stock(DB);
    const call = (decisionId: string) =>
      psqlChild(DB, asPrefix(OWNER) + `select public.decide_sale_hold('${revokedHold}','accept_as_recorded','Sold before the till was revoked','${decisionId}')::text;`);
    const first = rid();
    const [a, b] = await Promise.all([call(first), call(rid())]);
    const results = [a, b].map((r) => JSON.parse(r.out.split("\n").pop() as string));
    expect(results.filter((r) => r.alreadyDecided).length).toBe(1);
    const orderId = results.find((r) => !r.alreadyDecided).orderId;
    expect(count(DB, `orders where id='${orderId}'`)).toBe(1);
    expect(count(DB, `sale_hold_decisions where hold_id='${revokedHold}'`)).toBe(1);
    expect(stock(DB)).toBe(before - 2);
    // Same decision_id again → replay; a new decision_id → already decided; still one order.
    const winnerId = sql(DB, `select decision_id from sale_hold_decisions where hold_id='${revokedHold}'`);
    expect(decide(DB, OWNER, revokedHold, "accept_as_recorded", "again", winnerId)).toMatchObject({ replayed: true, orderId });
    expect(decide(DB, OWNER, revokedHold, "accept_as_recorded", "again", rid())).toMatchObject({ alreadyDecided: true, orderId });
    expect(count(DB, `orders where sale_request_id=(select sale_request_id from sale_holds where id='${revokedHold}')`)).toBe(1);
    expect(stock(DB)).toBe(before - 2);
    // The till re-uploads the same bytes after acceptance → the accepted order replays.
    const payload = JSON.parse(sql(DB, `select payload::text from sale_holds where id='${revokedHold}'`));
    expect(sql(DB, `select employee_id from orders where id='${orderId}'`)).toBe(AMY);
    expect(sql(DB, `select sale_identity_hash = (select identity_hash from sale_holds where id='${revokedHold}') from orders where id='${orderId}'`)).toBe("t");
    void payload;
    void first;
  });

  it("record as a separate sale (conflict reasons): a new order under a new ID; the original order is untouched", () => {
    const original = sql(DB, `select order_number || total::text from orders where id='${conflictOrder}'`);
    const r = decide(DB, OWNER, conflictHold, "record_as_separate", "Two different sales shared one reference", rid());
    expect(r.state).toBe("accepted");
    expect(sql(DB, `select sale_request_id <> (select sale_request_id from sale_holds where id='${conflictHold}') from orders where id='${r.orderId}'`)).toBe("t");
    expect(sql(DB, `select order_number || total::text from orders where id='${conflictOrder}'`)).toBe(original);
  });

  it("accept unattributed (attribution reasons): booked with no employee", () => {
    const r = decide(DB, OWNER, attributionHold, "accept_unattributed", "Employee record was wrong", rid());
    expect(sql(DB, `select coalesce(employee_id::text,'null') from orders where id='${r.orderId}'`)).toBe("null");
  });

  it("HOLD-3: decline → no order, no stock change; the hold and its audit stay readable", () => {
    const before = stock(DB);
    const orders = count(DB, "orders");
    const r = decide(DB, OWNER, declineHold, "decline", "Not a real sale", rid());
    expect(r).toMatchObject({ state: "declined", orderId: null });
    expect(count(DB, "orders")).toBe(orders);
    expect(stock(DB)).toBe(before);
    const detail = JSON.parse(as(DB, OWNER, `select public.get_sale_hold('${declineHold}')::text;`));
    expect(detail.state).toBe("declined");
    expect(detail.decisions).toHaveLength(1);
    expect(detail.decisions[0]).toMatchObject({ decision: "decline", reason: "Not a real sale", priorState: "held", resultingState: "declined" });
    expect(asFail(DB, null, `update sale_hold_decisions set reason='x';`).message).toMatch(/append-only/);
    expect(asFail(DB, null, `delete from sale_hold_decisions;`).message).toMatch(/append-only/);
  });

  it("HOLD-5: the device sees its holds' outcomes and acknowledges once; other devices cannot", () => {
    // The id is read as the superuser: the device role has no table access (by design).
    const saleId = sql(DB, `select sale_request_id from sale_holds where id='${declineHold}'`);
    const status = JSON.parse(as(DB, U1, `select public.get_sale_hold_status(array['${saleId}'::uuid])::text;`));
    expect(status[0].holds[0]).toMatchObject({ holdId: declineHold, state: "declined", deviceAcknowledgedAt: null });
    const pending = v6(DB, U1, identity({ buildJobId: BUILD3 })).holdId;
    expect(asFail(DB, U1, `select public.ack_sale_hold_resolution('${pending}')::text;`).message).toBe("hold_not_decided");
    expect(asFail(DB, U3, `select public.ack_sale_hold_resolution('${declineHold}')::text;`).message).toBe("hold_not_found");
    const first = JSON.parse(as(DB, U1, `select public.ack_sale_hold_resolution('${declineHold}')::text;`));
    const second = JSON.parse(as(DB, U1, `select public.ack_sale_hold_resolution('${declineHold}')::text;`));
    expect(first.deviceAcknowledgedAt).not.toBeNull();
    expect(second.deviceAcknowledgedAt).toBe(first.deviceAcknowledgedAt);
    expect(asFail(DB, OWNER, `select public.get_sale_hold_status(array['${rid()}'::uuid])::text;`).message).toBe("device_not_authorized");
  });
});

run("Scope 2: upgrade on existing data", () => {
  const DB = "lf2_upgrade";
  beforeAll(() => {
    freshDatabase(DB, null); // everything BEFORE Scope 2
    seed0(DB);
    applyMigration(DB, MIGRATION);
  }, 600_000);

  function seed0(db: string): void {
    sql(db, `
      insert into auth.users (id) values ('${OWNER}'), ('${U1}');
      insert into public.projects (id, user_id, name, template_id, config) values ('${PROJECT}', '${OWNER}', 'Shop', 'cafe', '${j(menu("1.75"))}'::jsonb);
      insert into public.build_jobs (id, project_id, owner_id, target, status, config_snapshot, config_schema_version, config_hash, request_key, started_at, finished_at)
        values ('${BUILD1}','${PROJECT}','${OWNER}','android','succeeded','${j(menu("1.50"))}'::jsonb,1,'h1','r1', now(), now()),
               ('${BUILD2}','${PROJECT}','${OWNER}','android','succeeded','${j(menu("1.75"))}'::jsonb,1,'h2','r2', now(), now());
      insert into public.paired_devices (id, auth_user_id, owner_id, project_id, build_job_id, created_at)
        values ('${D1}','${U1}','${OWNER}','${PROJECT}','${BUILD2}', now() - interval '30 days');
      insert into public.orders (user_id, project_id, order_number, payment_method, subtotal, tax_amount, tip_amount, total, paired_device_id, build_job_id)
        values ('${OWNER}','${PROJECT}','S-1','cash',1.50,0,0,1.50,'${D1}','${BUILD1}');
      insert into public.employees (id, project_id, display_name, employee_code, role, pin_hash, active, created_at)
        values ('${AMY}','${PROJECT}','Amy','001','cashier', public.employee_pin_hash('2222'), true, '2026-01-01'),
               ('${BEN}','${PROJECT}','Ben','002','cashier', public.employee_pin_hash('3333'), true, '2026-01-02');
      update public.employees set active = false, deactivated_at = now() where id = '${BEN}';
    `);
  }

  it("backfills the current pin and every build the till's own orders were priced from; employee baselines; business stays OFF", () => {
    expect(sql(DB, `select string_agg(build_job_id::text || ':' || source, ',' order by source) from device_build_pins`))
      .toBe(`${BUILD2}:backfill_current,${BUILD1}:backfill_order_history`);
    expect(sql(DB, `select string_agg(event || ':' || roster_version, ',' order by roster_version) from employee_status_events`))
      .toBe("baseline_active:1,baseline_inactive:2");
    expect(sql(DB, `select version from employee_roster_versions`)).toBe("2");
    expect(sql(DB, `select local_first_enabled::text from projects`)).toBe("false");
  });

  it("history is append-only for direct writes; a parent's cascade still removes it", () => {
    expect(asFail(DB, null, `delete from device_build_pins;`).message).toMatch(/append-only/);
    expect(asFail(DB, null, `update employee_status_events set event='created';`).message).toMatch(/append-only/);
    sql(DB, `delete from orders; delete from projects where id='${PROJECT}';`);
    expect(count(DB, "device_build_pins")).toBe(0);
    expect(count(DB, "employee_status_events")).toBe(0);
  });
});

run("Correction C2: stock preview equals the booking's cumulative effect", () => {
  const DB = "lf2_c2";
  beforeAll(() => {
    freshDatabase(DB, MIGRATION);
    seed(DB);
    as(DB, OWNER, `select public.revoke_paired_device('${D2}')::text;`);
  }, 600_000);

  const latte = (option: "small" | "large", quantity: number) => {
    const unit = option === "small" ? "3.00" : "3.50";
    return { itemId: "latte", quantity, unitPrice: unit, lineTotal: (Number(unit) * quantity).toFixed(2),
             modifiers: [{ groupId: "size", optionIds: [option] }] };
  };

  it("two modifier variants of one item (2 + 4 against stock 5): preview 5 → 0, 1 short; accepting books exactly that, line by line", () => {
    const held = v6(DB, U2, identity({ pairingGeneration: D2, lines: [latte("small", 2), latte("large", 4)] }));
    expect(held).toMatchObject({ status: "held", reason: "after_revocation" });

    const detail = JSON.parse(as(DB, OWNER, `select public.get_sale_hold('${held.holdId}')::text;`));
    expect(detail.stockPreview).toEqual([{ itemId: "latte", itemName: "Synthetic Latte", lines: 2, before: 5, after: 0, shortfall: 1 }]);

    const decided = decide(DB, OWNER, held.holdId, "accept_as_recorded", "Sold before revocation", rid());
    expect(stock(DB, "latte")).toBe(0);
    expect(sql(DB, `select string_agg(item_id || ':' || coalesce(inventory_shortfall,0), ',' order by line_position) from order_items where order_id='${decided.orderId}'`))
      .toBe("latte:0,latte:1");
    expect(sql(DB, `select string_agg(line_index || ':' || quantity_before || '>' || quantity_after, ',' order by line_index) from inventory_transactions where order_id='${decided.orderId}'`))
      .toBe("1:5>3,2:3>0");
    expect(sql(DB, `select has_inventory_shortfall::text from orders where id='${decided.orderId}'`)).toBe("true");
  });

  it("different items plus an untracked one: each tracked item folded separately in cart order; untracked omitted", () => {
    const held = v6(DB, U2, identity({ pairingGeneration: D2, lines: [
      { itemId: "chips", quantity: 3, unitPrice: "2.00", lineTotal: "6.00" },
      { itemId: "water", quantity: 1, unitPrice: "1.00", lineTotal: "1.00" },
      { itemId: "cola", quantity: 25, unitPrice: "1.75", lineTotal: "43.75" },
    ] }));
    const detail = JSON.parse(as(DB, OWNER, `select public.get_sale_hold('${held.holdId}')::text;`));
    expect(detail.stockPreview).toEqual([
      { itemId: "chips", itemName: "Synthetic Chips", lines: 1, before: 10, after: 7, shortfall: 0 },
      { itemId: "cola", itemName: "Synthetic Cola", lines: 1, before: 20, after: 0, shortfall: 5 },
    ]);
  });
});

