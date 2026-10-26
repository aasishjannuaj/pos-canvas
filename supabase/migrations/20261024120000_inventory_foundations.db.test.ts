// Batch A — Inventory foundations, EXECUTED against a real PostgreSQL.
//
// The harness (PostgreSQL discovery, the Supabase compatibility layer, the
// cluster and the migration chain) is the one the earlier v1.3 suites use,
// reproduced unchanged; only the migration name and the port range differ.
// When no PostgreSQL server is found the suite SKIPS LOUDLY rather than failing.
//
// The full mechanism validation (92 checks, incl. concurrency and latency) lives
// in pos-canvas-localfirst-analysis/evidence/inventory; this suite is the
// in-repository regression for the contract that matters most.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20261024120000_inventory_foundations.sql";

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
const PORT = 57400 + (process.pid % 90);

if (PG_BIN === null) {
  console.warn(`\n[${MIGRATION}] SKIPPED: no local PostgreSQL server found; install PostgreSQL 16+ to run it.\n`);
}

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
  return pg("psql", [...psqlArgs(db), "-Atq", "-f", "-"], statement).trim();
}

/** Same statement, but the error sentence instead of a throw. */
function sqlError(db: string, statement: string): string {
  try {
    sql(db, statement);
    return "";
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    return (/ERROR:\s*(.*)/.exec((err.stderr ?? err.message ?? "").toString())?.[1] ?? "").trim();
  }
}

/** Runs as role `authenticated` with auth.uid() bound to `who`; returns the last result line. */
function as(db: string, who: string, statement: string): string {
  const out = sql(db, `\\o /dev/null\nselect set_config('request.jwt.claim.sub','${who}', false);\nset role authenticated;\n\\o\n${statement}`);
  const lines = out.split("\n").filter((l) => l !== "");
  return lines[lines.length - 1] ?? "";
}

function asError(db: string, who: string, statement: string): string {
  return sqlError(db, `\\o /dev/null\nselect set_config('request.jwt.claim.sub','${who}', false);\nset role authenticated;\n\\o\n${statement}`);
}

export const STORAGE_ONLY_MIGRATIONS = new Set([
  "20260729190422_build_artifact_storage.sql",
  "20260813120000_project_logo_storage.sql",
]);

function freshDatabase(name: string, withMigration: boolean): void {
  sql("postgres", `drop database if exists ${name}; create database ${name};`);
  // As the accepted harness does: no ON_ERROR_STOP here, because roles are
  // cluster-wide and the second database's `create role` is expected to fail.
  pg("psql", ["-h", "127.0.0.1", "-p", String(PORT), "-U", "postgres", "-d", name, "-q", "-f", "-"], COMPAT);
  // Supabase grants the API roles USAGE on the auth schema; the accepted COMPAT
  // layer does not model it, which would make the SECURITY INVOKER stock
  // functions (restock_inventory, adjust_inventory) fail identically in both
  // databases and never be exercised.
  sql(name, "grant usage on schema auth to anon, authenticated, service_role;");

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

const OWNER = "a1000000-0000-4000-8000-000000000001";
const OWNER_B = "a2000000-0000-4000-8000-000000000002";
const PROJECT = "b1000000-0000-4000-8000-000000000001";
const PROJECT_B = "b2000000-0000-4000-8000-000000000002";
const MENU = JSON.stringify({
  menuItems: [
    { id: "cola", name: "Synthetic Cola", price: "1.50", available: true, trackInventory: true, stockQuantity: 20 },
    { id: "chips", name: "Synthetic Chips", price: "2.00", available: true, trackInventory: true, stockQuantity: 10 },
  ],
  tax: { enabled: false, rate: 0 },
  receipt: {},
});

function seed(db: string): void {
  sql(db, `
    insert into auth.users (id) values ('${OWNER}'), ('${OWNER_B}');
    insert into public.projects (id, user_id, name, template_id, config)
      values ('${PROJECT}', '${OWNER}', 'Synthetic Shop', 'cafe', '${MENU}'::jsonb),
             ('${PROJECT_B}', '${OWNER_B}', 'Other Shop', 'cafe', '${MENU}'::jsonb);
  `);
}

const stock = (db: string, item = "cola") =>
  sql(db, `select v->>'stockQuantity' from projects p, jsonb_array_elements(p.config->'menuItems') v where p.id='${PROJECT}' and v->>'id'='${item}'`);
const tracked = (db: string, item = "cola") =>
  sql(db, `select v->>'trackInventory' from projects p, jsonb_array_elements(p.config->'menuItems') v where p.id='${PROJECT}' and v->>'id'='${item}'`);
const version = (db: string) => Number(sql(db, `select catalog_version from projects where id='${PROJECT}'`));
const req = (n: number) => `9${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`;
const saleV2 = (db: string, r: string, qty = 1) =>
  as(db, OWNER, `select public.complete_sale_v2('${PROJECT}','cash',0,'[{"itemId":"cola","quantity":${qty}}]'::jsonb,'${r}')::text;`);
function ownerSave(db: string, mutate: (cfg: { menuItems: Array<Record<string, unknown>> }) => void, base: number | null): string {
  const cfg = JSON.parse(sql(db, `select config::text from projects where id='${PROJECT}'`));
  mutate(cfg);
  const lit = JSON.stringify(cfg).replace(/'/g, "''");
  return asError(db, OWNER, `update public.projects set config='${lit}'::jsonb, base_catalog_version=${base === null ? "null" : base} where id='${PROJECT}';`);
}

const run = PG_BIN === null ? describe.skip : describe;

beforeAll(() => {
  if (PG_BIN === null) return;

  dataDir = mkdtempSync(join(tmpdir(), "inv-found-pg-"));
  pg("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
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

run("inventory foundations: contract and permissions", () => {
  const DB = "inv_contract";

  beforeAll(() => {
    freshDatabase(DB, true);
    seed(DB);
  }, 300_000);

  it("the owner RPCs are security definer, callable by authenticated, not by anon", () => {
    for (const fn of [
      "public.inventory_receive(uuid,text,integer,uuid,text)",
      "public.inventory_count(uuid,text,integer,uuid,text)",
      "public.set_item_tracking(uuid,text,boolean,uuid,text)",
    ]) {
      expect(sql(DB, `select has_function_privilege('authenticated','${fn}','EXECUTE')`)).toBe("t");
      expect(sql(DB, `select has_function_privilege('anon','${fn}','EXECUTE')`)).toBe("f");
      expect(sql(DB, `select prosecdef from pg_proc where oid='${fn}'::regprocedure`)).toBe("t");
    }
  });

  it("internal functions and new tables are not reachable by API roles", () => {
    expect(sql(DB, `select has_function_privilege('authenticated','public.lf_owner_action(uuid,text,text,jsonb,uuid,text)','EXECUTE')`)).toBe("f");
    expect(sql(DB, `select count(*) from information_schema.role_table_grants
      where table_name in ('inventory_actions','inventory_stock_reconciliations','menu_item_tombstones')
        and grantee in ('anon','authenticated')`)).toBe("0");
  });

  it("an explicit client txid is refused by column privilege; a widened grant is still overwritten", () => {
    expect(asError(DB, OWNER, `insert into inventory_transactions (user_id,project_id,item_id,item_name,transaction_type,quantity_change,quantity_before,quantity_after,txid)
      values ('${OWNER}','${PROJECT}','cola','x','restock',1,20,21,1);`)).toMatch(/permission denied/i);
    const out = sql(DB, `begin; grant insert (txid) on inventory_transactions to authenticated;
      set role authenticated; select set_config('request.jwt.claim.sub','${OWNER}',true);
      insert into inventory_transactions (user_id,project_id,item_id,item_name,transaction_type,quantity_change,quantity_before,quantity_after,txid)
        values ('${OWNER}','${PROJECT}','cola','x','restock',1,20,21,1);
      reset role; select (txid = txid_current())::text from inventory_transactions where item_name='x'; rollback;`);
    expect(out.split("\n").pop()).toBe("true");
  });

  it("a forged direct ledger insert fails at commit and stores nothing", () => {
    expect(asError(DB, OWNER, `insert into inventory_transactions (user_id,project_id,item_id,item_name,transaction_type,quantity_change,quantity_before,quantity_after)
      values ('${OWNER}','${PROJECT}','cola','forged','restock',5,20,25);`)).toMatch(/unreconciled_ledger_row/);
    expect(sql(DB, `select count(*) from inventory_transactions where item_name='forged'`)).toBe("0");
  });

  it("ledger rows are append-only", () => {
    expect(sqlError(DB, `update inventory_transactions set quantity_after = 1`)).toMatch(/append-only/);
  });
});

run("inventory foundations: stale saves, actions, tracking, catalog", () => {
  const DB = "inv_behaviour";

  beforeAll(() => {
    freshDatabase(DB, true);
    seed(DB);
  }, 300_000);

  it("a stale save cannot overwrite live stock (and a direct stock edit is ignored)", () => {
    const base = version(DB);
    const staleCfg = sql(DB, `select config::text from projects where id='${PROJECT}'`);
    saleV2(DB, req(1)); saleV2(DB, req(2)); saleV2(DB, req(3));
    const lit = staleCfg.replace(/'/g, "''").replace('"Synthetic Cola"', '"Renamed Cola"');
    expect(asError(DB, OWNER, `update projects set config='${lit}'::jsonb, base_catalog_version=${base} where id='${PROJECT}';`)).toBe("");
    expect(stock(DB)).toBe("17");
    expect(sql(DB, `select config::text like '%Renamed Cola%' from projects where id='${PROJECT}'`)).toBe("t");
    expect(ownerSave(DB, (c) => { c.menuItems[0].stockQuantity = 50; }, version(DB))).toBe("");
    expect(stock(DB)).toBe("17");
  });

  it("Received +N adds N; Counted = N sets the count; both audited and request-bound", () => {
    expect(JSON.parse(as(DB, OWNER, `select public.inventory_receive('${PROJECT}','cola',10,'${req(10)}')::text;`))).toMatchObject({ before: 17, after: 27 });
    expect(JSON.parse(as(DB, OWNER, `select public.inventory_receive('${PROJECT}','cola',10,'${req(10)}')::text;`))).toMatchObject({ after: 27, replayed: true });
    expect(stock(DB)).toBe("27");
    expect(asError(DB, OWNER, `select public.inventory_receive('${PROJECT}','cola',11,'${req(10)}');`)).toMatch(/request_conflict/);
    expect(asError(DB, OWNER_B, `select public.inventory_receive('${PROJECT_B}','cola',10,'${req(10)}');`)).toMatch(/request_conflict/);
    expect(asError(DB, OWNER_B, `select public.inventory_receive('${PROJECT}','cola',1,'${req(11)}');`)).toMatch(/access denied/);
    expect(JSON.parse(as(DB, OWNER, `select public.inventory_count('${PROJECT}','cola',5,'${req(12)}')::text;`))).toMatchObject({ before: 27, after: 5 });
    expect(stock(DB)).toBe("5");
    expect(sql(DB, `select count(*) from inventory_actions where project_id='${PROJECT}'`)).toBe("2");
  });

  it("tracking changes only through set_item_tracking; a save cannot flip it", () => {
    expect(ownerSave(DB, (c) => { c.menuItems[0].trackInventory = false; }, version(DB))).toBe("");
    expect(tracked(DB)).toBe("true");
    const v = version(DB);
    as(DB, OWNER, `select public.set_item_tracking('${PROJECT}','cola',false,'${req(20)}');`);
    expect(tracked(DB)).toBe("false");
    expect(version(DB)).toBe(v + 1);
    expect(stock(DB)).toBe("5");
  });

  it("receive then sale in ONE transaction: each update reconciles only its own rows", () => {
    as(DB, OWNER, `select public.set_item_tracking('${PROJECT}','cola',true,'${req(21)}');`);
    sql(DB, `begin; select set_config('request.jwt.claim.sub','${OWNER}',true);
      select public.inventory_receive('${PROJECT}','cola',5,'${req(22)}');
      select public.complete_sale_v2('${PROJECT}','cash',0,'[{"itemId":"cola","quantity":2}]'::jsonb,'${req(23)}');
      commit;`);
    expect(stock(DB)).toBe("8");
  });

  it("deletion is tombstoned; stale structural saves and retired ids are refused; a new id recreates", () => {
    const stale = version(DB);
    expect(ownerSave(DB, (c) => { c.menuItems = c.menuItems.filter((i) => i.id !== "chips"); }, version(DB))).toBe("");
    expect(sql(DB, `select count(*) from menu_item_tombstones where item_id='chips'`)).toBe("1");
    expect(ownerSave(DB, (c) => { c.menuItems.push({ id: "x1", name: "X", price: "1.00", available: true, trackInventory: true, stockQuantity: 1 }); }, stale)).toMatch(/catalog_conflict/);
    expect(ownerSave(DB, (c) => { c.menuItems.push({ id: "chips", name: "Chips", price: "2.00", available: true, trackInventory: true, stockQuantity: 3 }); }, version(DB))).toMatch(/item_id_retired/);
    expect(ownerSave(DB, (c) => { c.menuItems.push({ id: "chips2", name: "Synthetic Chips", price: "2.00", available: true, trackInventory: true, stockQuantity: 12 }); }, version(DB))).toBe("");
    expect(stock(DB, "chips2")).toBe("12");
    expect(sql(DB, `select quantity_before||'>'||quantity_after from inventory_transactions where item_id='chips2'`)).toBe("0>12");
  });

  it("a new project records opening stock after insert (foreign-key order) and passes the commit check", () => {
    const P3 = "b3000000-0000-4000-8000-000000000003";
    expect(asError(DB, OWNER, `insert into projects (id,user_id,name,template_id,config) values ('${P3}','${OWNER}','New','cafe','${MENU}'::jsonb);`)).toBe("");
    expect(sql(DB, `select count(*) from inventory_transactions where project_id='${P3}'`)).toBe("2");
  });
});

run("inventory foundations: legacy sale and stock functions are unchanged", () => {
  const BASE = "inv_legacy_base";
  const WITH = "inv_legacy_with";

  beforeAll(() => {
    freshDatabase(BASE, false);
    freshDatabase(WITH, true);
    seed(BASE);
    seed(WITH);
  }, 600_000);

  const steps = (db: string): string[] => {
    const norm = (s: string) => s.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "*").replace(/"createdAt": "[^"]+"/g, "*");
    const out: string[] = [];
    const step = (s: string) => {
      try {
        out.push(`ok ${norm(as(db, OWNER, s))}`);
      } catch (error) {
        const err = error as { stderr?: string; message?: string };
        out.push(`refused ${(/ERROR:\s*(.*)/.exec((err.stderr ?? err.message ?? "").toString())?.[1] ?? "").trim()}`);
      }
      out.push(`cola=${stock(db)} chips=${stock(db, "chips")}`);
    };
    step(`select public.complete_sale('${PROJECT}','ORD-1','cash',1.50,0,0,1.50,'[{"itemId":"cola","quantity":1}]'::jsonb);`);
    step(`select public.complete_sale_v2('${PROJECT}','cash',0,'[{"itemId":"cola","quantity":1}]'::jsonb,'${req(30)}');`);
    step(`select public.complete_sale_v2('${PROJECT}','cash',0,'[{"itemId":"cola","quantity":1}]'::jsonb,'${req(30)}');`);
    step(`select public.complete_sale_v2('${PROJECT}','cash',0,'[{"itemId":"cola","quantity":999}]'::jsonb,'${req(31)}');`);
    step(`select public.complete_sale_v3('${PROJECT}','card',0,'[{"itemId":"chips","quantity":2}]'::jsonb,'${req(32)}');`);
    step(`select public.restock_inventory('${PROJECT}','cola',7);`);
    step(`select public.adjust_inventory('${PROJECT}','chips',3);`);
    return out;
  };

  it("identical outcomes and stock with and without the migration", () => {
    const base = steps(BASE);

    expect(steps(WITH)).toEqual(base);
    // The sequence really exercised success, replay and refusal paths.
    expect(base.filter((l) => l.startsWith("ok ")).length).toBe(6);
    expect(base.some((l) => l.startsWith("refused ") && l.includes("Insufficient inventory"))).toBe(true);
  });
});

run("inventory foundations: Batch B — malformed catalogs, authoritative versions, owner history", () => {
  const DB = "inv_batch_b";

  beforeAll(() => {
    freshDatabase(DB, true);
    seed(DB);
  }, 300_000);

  it("malformed catalogs are refused without touching stock or history", () => {
    const before = sql(DB, `select config::text from projects where id='${PROJECT}'`);
    const ledger = sql(DB, `select count(*) from inventory_transactions where project_id='${PROJECT}'`);
    for (const expr of [
      `jsonb_set(config,'{menuItems}','{"a":1}')`,
      `config - 'menuItems'`,
      `jsonb_set(config,'{menuItems,0}','5')`,
      `jsonb_set(config,'{menuItems,0}', (config->'menuItems'->0) - 'id')`,
      `jsonb_set(config,'{menuItems,1,id}','"cola"')`,
    ]) {
      expect(asError(DB, OWNER, `update projects set config = ${expr}, base_catalog_version = ${version(DB)} where id='${PROJECT}';`)).toMatch(/invalid_catalog/);
    }
    expect(sql(DB, `select config::text from projects where id='${PROJECT}'`)).toBe(before);
    expect(sql(DB, `select count(*) from inventory_transactions where project_id='${PROJECT}'`)).toBe(ledger);
  });

  it("actions return authoritative versions (no-op and replay included)", () => {
    const v = version(DB);
    const a = JSON.parse(as(DB, OWNER, `select public.set_item_tracking('${PROJECT}','chips',false,'${req(50)}')::text;`));
    expect([a.catalogVersionBefore, a.catalogVersion]).toEqual([v, v + 1]);
    const noop = JSON.parse(as(DB, OWNER, `select public.set_item_tracking('${PROJECT}','chips',false,'${req(51)}')::text;`));
    expect([noop.catalogVersionBefore, noop.catalogVersion]).toEqual([v + 1, v + 1]);
    const replay = JSON.parse(as(DB, OWNER, `select public.set_item_tracking('${PROJECT}','chips',false,'${req(50)}')::text;`));
    expect([replay.replayed, replay.catalogVersionBefore, replay.catalogVersion]).toEqual([true, null, v + 1]);
  });

  it("owner history shows zero-change counts, tracking actions and deleted items; others are refused", () => {
    as(DB, OWNER, `select public.inventory_count('${PROJECT}','cola',20,'${req(52)}');`);
    expect(ownerSave(DB, (c) => { c.menuItems = c.menuItems.filter((i) => i.id !== "chips"); }, version(DB))).toBe("");
    const h = JSON.parse(as(DB, OWNER, `select public.inventory_history('${PROJECT}')::text;`));
    expect(h.some((e: { kind: string; action?: string; zeroChange?: boolean }) => e.kind === "action" && e.action === "count" && e.zeroChange)).toBe(true);
    expect(h.some((e: { kind: string; action?: string }) => e.kind === "action" && e.action === "tracking")).toBe(true);
    expect(h.some((e: { kind: string; itemId?: string }) => e.kind === "deletion" && e.itemId === "chips")).toBe(true);
    expect(asError(DB, OWNER_B, `select public.inventory_history('${PROJECT}');`)).toMatch(/access denied/);
  });
});
