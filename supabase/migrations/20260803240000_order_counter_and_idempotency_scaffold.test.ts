// Milestone 16, Feature 16.3 — Migration D2 static guards.
//
// SCOPE: TEXT-level assertions plus the parser. They prove D2 declares only the
// approved schema objects and is behavior-neutral. They do NOT prove runtime
// behavior — and note that libpg-query parses a DO block's body as an opaque
// string, so plpgsql logic inside the verification block is NOT statically
// validated. That block is self-checking at apply time and aborts the migration
// on any failure.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(migrationsDir, "20260803240000_order_counter_and_idempotency_scaffold.sql"),
  "utf-8"
);

const executable = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

describe("migration ordering", () => {
  it("sorts after the D1 privilege migration", () => {
    expect(
      "20260803230000_privilege_and_audit_hardening.sql" <
        "20260803240000_order_counter_and_idempotency_scaffold.sql"
    ).toBe(true);
  });
});

describe("orders.number_source", () => {
  it("is added NOT NULL with a client default", () => {
    expect(executable).toContain(
      "add column if not exists number_source text not null default 'client';"
    );
  });

  it("constrains the value to exactly client and server", () => {
    expect(executable).toContain("add constraint orders_number_source_check");
    expect(executable).toContain("check (number_source in ('client', 'server'));");
  });
});

describe("idempotency columns", () => {
  it("adds sale_request_id and sale_request_hash as nullable", () => {
    expect(executable).toContain("add column if not exists sale_request_id uuid;");
    expect(executable).toContain("add column if not exists sale_request_hash text;");
    // Nullable means no NOT NULL on either.
    expect(executable).not.toMatch(/sale_request_id uuid not null/i);
    expect(executable).not.toMatch(/sale_request_hash text not null/i);
  });

  it("gives sale_request_id no default — the client must supply it in D3", () => {
    expect(executable).not.toMatch(/sale_request_id uuid[^;]*default/i);
    expect(executable).not.toMatch(/gen_random_uuid\(\)/i);
  });

  it("requires the id and hash to be both null or both set", () => {
    expect(executable).toContain("add constraint orders_sale_request_pair_check");
    expect(executable).toContain(
      "check ((sale_request_id is null) = (sale_request_hash is null));"
    );
  });

  it("requires a lowercase 64-character hex hash", () => {
    expect(executable).toContain("add constraint orders_sale_request_hash_format_check");
    expect(executable).toContain("sale_request_hash ~ '^[0-9a-f]{64}$'");
    // Uppercase must not be accepted, so no case-insensitive operator or A-F.
    expect(executable).not.toContain("[0-9a-fA-F]{64}");
    expect(executable).not.toMatch(/sale_request_hash\s+~\*/);
  });

  it("requires a non-null project whenever a request id is present", () => {
    expect(executable).toContain("add constraint orders_sale_request_requires_project_check");
    expect(executable).toContain(
      "check (sale_request_id is null or project_id is not null);"
    );
  });

  it("computes and backfills no hashes", () => {
    expect(executable).not.toMatch(/sha256|digest\(|encode\(/i);
  });
});

describe("project_order_counters", () => {
  it("declares the exact approved shape", () => {
    expect(executable).toContain("create table if not exists public.project_order_counters (");
    expect(executable).toContain("project_id uuid primary key");
    expect(executable).toContain("references public.projects(id) on delete cascade");
    expect(executable).toContain("last_number bigint not null default 1000");
    expect(executable).toContain("updated_at timestamptz not null default now()");
  });

  it("floors last_number at 1000", () => {
    expect(executable).toContain("constraint project_order_counters_last_number_check");
    expect(executable).toContain("check (last_number >= 1000)");
  });

  it("introduces no PostgreSQL sequence", () => {
    // A sequence would gap on every rolled-back sale; allocation must be
    // transactional.
    expect(executable).not.toMatch(/create\s+sequence|nextval|serial|identity/i);
  });

  it("enables RLS and creates no policy", () => {
    expect(executable).toContain(
      "alter table public.project_order_counters enable row level security;"
    );
    expect(executable).not.toMatch(/create policy/i);
  });

  it("revokes all four roles and grants nothing back", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(executable).toContain(
        `revoke all privileges on table public.project_order_counters from ${role};`
      );
    }
    expect(executable).not.toMatch(/grant[^;]*on table public\.project_order_counters/i);
  });

  it("accounts for Supabase default privileges rather than assuming privacy", () => {
    const revokes =
      executable.match(/revoke all privileges on table public\.project_order_counters from \w+;/g) ?? [];
    expect(revokes.length).toBe(4);
  });
});

describe("counter seeding", () => {
  it("parses digits only at the very end of order_number", () => {
    expect(executable).toContain("substring(o.order_number from '([0-9]+)$')");
    // Never the configured prefix, a lexicographic max, or a row count.
    expect(executable).not.toMatch(/orderPrefix|receipt->>|order_prefix/i);
    expect(executable).not.toMatch(/max\(o\.order_number\)/i);
    expect(executable).not.toMatch(/count\(\*\)[^;]*from public\.orders o\s*\n\s*where o\.project_id = p\.id/i);
  });

  it("floors the seed at 1000 and casts to bigint", () => {
    expect(executable).toContain("greatest(\n    1000,");
    expect(executable).toContain("(substring(o.order_number from '([0-9]+)$'))::bigint");
    expect(executable).toContain("), 1000)");
  });

  it("excludes orders with a null project_id", () => {
    expect(executable).toContain("where o.project_id = p.id");
  });

  it("guards against bigint overflow before casting", () => {
    // 18 digits is unconditionally below bigint's 19-digit ceiling.
    expect(executable).toContain(
      "length(substring(o.order_number from '([0-9]+)$')) > 18"
    );
    expect(executable).toContain(
      "length(substring(o.order_number from '([0-9]+)$')) <= 18"
    );
  });

  it("aborts on an unsafe suffix instead of silently clamping", () => {
    expect(executable).toContain("raise exception");
    expect(executable).toContain("too long to seed safely");
    // The message names only the project, never the order number.
    expect(executable).not.toMatch(/too long to seed safely[^;]*order_number/i);
  });

  it("is safe to retry and never overwrites an advanced counter", () => {
    expect(executable).toContain("on conflict (project_id) do nothing;");
  });

  it("seeds with INSERT ... SELECT over projects", () => {
    expect(executable).toContain("insert into public.project_order_counters (project_id, last_number)");
    expect(executable).toContain("from public.projects p");
  });
});

describe("uniqueness backstops", () => {
  it("declares the server-number partial unique index with the exact predicate", () => {
    expect(executable).toContain(
      "create unique index if not exists orders_server_number_unique\n  on public.orders (project_id, order_number)\n  where number_source = 'server' and project_id is not null;"
    );
  });

  it("declares the idempotency partial unique index with the exact predicate", () => {
    expect(executable).toContain(
      "create unique index if not exists orders_sale_request_unique\n  on public.orders (project_id, sale_request_id)\n  where sale_request_id is not null and project_id is not null;"
    );
  });

  it("adds no global uniqueness on order_number or sale_request_id", () => {
    // Both indexes must be partial, so the historical duplicate survives.
    const uniques = executable.match(/create unique index[^;]*;/gi) ?? [];
    expect(uniques.length).toBe(2);
    for (const u of uniques) expect(u).toContain("where ");
    expect(executable).not.toMatch(/add constraint[^;]*unique\s*\(/i);
  });
});

describe("behavior neutrality", () => {
  it("replaces no function and changes no EXECUTE grant", () => {
    expect(executable).not.toMatch(/create\s+or\s+replace\s+function/i);
    expect(executable).not.toMatch(/drop\s+function/i);
    expect(executable).not.toMatch(/(grant|revoke)[^;]*on function/i);
  });

  it("never updates or deletes an order", () => {
    // Historical rows may only change through ADD COLUMN's default.
    expect(executable).not.toMatch(/update\s+public\.orders/i);
    expect(executable).not.toMatch(/delete\s+from\s+public\.orders/i);
    expect(executable).not.toMatch(/^\s*update\s+orders/im);
  });

  it("never rewrites an order number", () => {
    expect(executable).not.toMatch(/set\s+order_number/i);
  });

  it("writes only to project_order_counters", () => {
    const inserts = executable.match(/insert into public\.(\w+)/g) ?? [];
    expect(inserts).toEqual(["insert into public.project_order_counters"]);
  });

  it("changes no privilege on any existing table", () => {
    const touched = new Set(
      [...executable.matchAll(/on table public\.(\w+)/g)].map((m) => m[1])
    );
    expect([...touched]).toEqual(["project_order_counters"]);
  });

  it("alters only orders among existing tables", () => {
    const altered = new Set(
      [...executable.matchAll(/alter table public\.(\w+)/g)].map((m) => m[1])
    );
    expect([...altered].sort()).toEqual(["orders", "project_order_counters"]);
  });

  it("creates only the approved table", () => {
    const created = executable.match(/create table[^(]*\(/gi) ?? [];
    expect(created.length).toBe(1);
    expect(created[0]).toContain("public.project_order_counters");
  });

  it("drops nothing", () => {
    expect(executable).not.toMatch(/\bdrop\s+(table|column|index|policy|constraint)\b/i);
    // A TRUNCATE *statement*, not the word — 'TRUNCATE' appears legitimately in
    // the verification block as a privilege name being asserted absent.
    expect(executable).not.toMatch(/^\s*truncate\s+/im);
  });
});

describe("verification block", () => {
  it("checks the number_source column metadata, not a rendered definition", () => {
    expect(executable).toContain("pg_get_expr(d.adbin, d.adrelid)");
    expect(executable).toContain("D2: orders.number_source must be NOT NULL");
    expect(executable).toContain("D2: orders.number_source must default to client");
    expect(executable).not.toMatch(/length\s*\(\s*pg_get_functiondef/i);
    expect(executable).not.toMatch(/md5\s*\(\s*pg_get_functiondef/i);
  });

  it("checks both idempotency columns and the absence of a default", () => {
    expect(executable).toContain("D2: orders.sale_request_id must be a NULLABLE uuid");
    expect(executable).toContain("D2: orders.sale_request_hash must be NULLABLE text");
    expect(executable).toContain("D2: orders.sale_request_id must not have a default");
  });

  it("checks all five new constraints by name", () => {
    for (const c of [
      "orders_number_source_check",
      "orders_sale_request_pair_check",
      "orders_sale_request_hash_format_check",
      "orders_sale_request_requires_project_check",
      "project_order_counters_last_number_check",
    ]) {
      expect(executable).toContain(`'${c}'`);
    }
  });

  it("checks the counter table shape, RLS, policies and privileges", () => {
    expect(executable).toContain("must have exactly 3 columns");
    expect(executable).toContain("has no primary key");
    expect(executable).toContain("must cascade on project delete");
    expect(executable).toContain("row level security is not enabled on project_order_counters");
    expect(executable).toContain("must have no policies");
    expect(executable).toContain("D2: anon holds % on project_order_counters");
    expect(executable).toContain("D2: authenticated holds % on project_order_counters");
    expect(executable).toContain("D2: service_role holds % on project_order_counters");
    expect(executable).toContain("D2: PUBLIC holds a privilege on project_order_counters");
  });

  it("checks the seeding invariants", () => {
    expect(executable).toContain("expected one counter per project");
    expect(executable).toContain("a seeded counter is below the 1000 floor");
    expect(executable).toContain("but history requires at least");
  });

  it("checks that historical rows were not touched", () => {
    expect(executable).toContain("existing order(s) are not number_source = client");
    expect(executable).toContain("existing order(s) already carry idempotency values");
  });

  it("checks both index predicates", () => {
    expect(executable).toContain("orders_server_number_unique is missing or has the wrong predicate");
    expect(executable).toContain("orders_sale_request_unique is missing or has the wrong predicate");
  });

  it("re-asserts the Migration C and D1 posture", () => {
    expect(executable).toContain("D2: complete_sale must remain SECURITY DEFINER");
    expect(executable).toContain("D2: complete_sale must keep its locked search_path");
    expect(executable).toContain("D2: anon regained SELECT on orders");
    expect(executable).toContain("D2: D1 posture drifted");
    expect(executable).toContain("to_regprocedure(");
    expect(executable).not.toMatch(/pg_get_function_identity_arguments/i);
  });

  it("does not hardcode a complete_sale body hash", () => {
    // The post-Migration-C hash is not recorded anywhere in this repository, so
    // a literal here would be a guess. It is a pre-apply capture instead.
    expect(executable).not.toMatch(/md5\s*\(\s*p?\.?prosrc/i);
    expect(executable).not.toMatch(/\b[0-9a-f]{32}\b/);
  });
});
