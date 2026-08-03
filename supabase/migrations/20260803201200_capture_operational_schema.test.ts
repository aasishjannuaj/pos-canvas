// Feature 16.3, schema baseline — guards that the operational-schema capture
// stays a faithful, behavior-preserving transcription of the live database.
//
// This migration's whole value is that applying it to production changes
// nothing. These assertions encode that contract, so a future edit that
// smuggles in a Migration D hardening change (unique order numbers, revoked
// grants, an append-only audit log, dropping the redundant index) fails here
// instead of silently altering production on the next apply.
//
// Same convention as the Feature 15.6 and Migration A tests: this repository
// has no live Postgres test harness, so SQL is asserted at the text level.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = dirname(fileURLToPath(import.meta.url));

const SCHEMA_MIGRATION = "20260803201200_capture_operational_schema.sql";
const FUNCTION_MIGRATION =
  "20260803201210_capture_checkout_inventory_functions.sql";

const sql = readFileSync(join(migrationsDir, SCHEMA_MIGRATION), "utf-8");

const executable = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

const TABLES = [
  "projects",
  "orders",
  "order_items",
  "inventory_transactions",
] as const;

describe("migration ordering", () => {
  it("sorts the schema baseline before the function capture", () => {
    expect(SCHEMA_MIGRATION < FUNCTION_MIGRATION).toBe(true);
  });

  it("both migrations exist on disk", () => {
    const files = readdirSync(migrationsDir);

    expect(files).toContain(SCHEMA_MIGRATION);
    expect(files).toContain(FUNCTION_MIGRATION);
  });

  it("the schema baseline is the earlier of the two by filename sort", () => {
    const ordered = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    expect(ordered.indexOf(SCHEMA_MIGRATION)).toBeLessThan(
      ordered.indexOf(FUNCTION_MIGRATION)
    );
  });

  it("creates projects before the tables that reference it", () => {
    const posProjects = executable.indexOf("create table if not exists public.projects");
    const posOrders = executable.indexOf("create table if not exists public.orders");
    const posItems = executable.indexOf("create table if not exists public.order_items");
    const posInv = executable.indexOf(
      "create table if not exists public.inventory_transactions"
    );

    expect(posProjects).toBeGreaterThan(-1);
    expect(posProjects).toBeLessThan(posOrders);
    expect(posOrders).toBeLessThan(posItems);
    expect(posOrders).toBeLessThan(posInv);
  });
});

describe("captures all four operational tables", () => {
  it("creates each table exactly once", () => {
    for (const t of TABLES) {
      const matches = executable.match(
        new RegExp(`create table if not exists public\\.${t}\\b`, "g")
      );

      expect(matches?.length ?? 0).toBe(1);
    }
  });

  it("enables RLS on every table", () => {
    for (const t of TABLES) {
      expect(executable).toContain(
        `alter table public.${t} enable row level security;`
      );
    }
  });
});

describe("preserves the inspected constraints and nullability", () => {
  it("keeps orders.project_id nullable with ON DELETE SET NULL", () => {
    expect(executable).toMatch(/project_id uuid,/);
    expect(executable).toContain(
      "foreign key (project_id) references public.projects(id) on delete set null"
    );
  });

  it("keeps inventory_transactions.project_id NOT NULL with ON DELETE CASCADE", () => {
    expect(executable).toContain("project_id uuid not null");
    expect(executable).toContain(
      "foreign key (project_id) references public.projects(id) on delete cascade"
    );
  });

  it("captures every inspected check constraint", () => {
    const checks = [
      "orders_payment_method_check",
      "orders_subtotal_check",
      "orders_tax_amount_check",
      "orders_tip_amount_check",
      "orders_total_check",
      "order_items_line_total_check",
      "order_items_quantity_check",
      "order_items_unit_price_check",
      "inventory_transactions_after_check",
      "inventory_transactions_before_check",
      "inventory_transactions_change_check",
      "inventory_transactions_quantity_math_check",
      "inventory_transactions_type_check",
    ];

    for (const c of checks) {
      expect(executable).toContain(c);
    }
  });

  it("captures every inspected index", () => {
    const indexes = [
      "projects_user_id_idx",
      "orders_created_at_idx",
      "orders_project_id_idx",
      "orders_user_id_idx",
      "order_items_order_id_idx",
      "inventory_transactions_order_id_idx",
      "inventory_transactions_project_id_idx",
      "inventory_transactions_project_created_at_idx",
      "inventory_transactions_user_id_idx",
    ];

    for (const i of indexes) {
      expect(executable).toContain(i);
    }
  });
});

describe("preserves the inspected grant posture", () => {
  it("grants ALL to authenticated and service_role on every table", () => {
    for (const t of TABLES) {
      expect(executable).toContain(`grant all on table public.${t} to authenticated;`);
      expect(executable).toContain(`grant all on table public.${t} to service_role;`);
    }
  });

  it("grants to anon on inventory_transactions only — matching production", () => {
    expect(executable).toContain(
      "grant all on table public.inventory_transactions to anon;"
    );

    for (const t of ["projects", "orders", "order_items"]) {
      expect(executable).not.toContain(`grant all on table public.${t} to anon;`);
    }
  });
});

describe("includes no Migration D hardening", () => {
  it("does not add a unique constraint on order numbers", () => {
    expect(executable).not.toMatch(/unique[^;]*order_number/i);
    expect(executable).not.toMatch(/order_number[^;]*unique/i);
  });

  it("does not drop the redundant inventory index", () => {
    expect(executable).not.toMatch(/drop\s+index/i);
  });

  it("does not revoke any grant", () => {
    expect(executable).not.toMatch(/\brevoke\b/i);
  });

  it("keeps inventory_transactions UPDATE and DELETE policies (not append-only yet)", () => {
    expect(executable).toContain("Users can update their inventory transactions");
    expect(executable).toContain("Users can delete their inventory transactions");
  });

  it("does not drop any policy", () => {
    expect(executable).not.toMatch(/drop\s+policy/i);
  });

  it("does not alter or drop any existing column or table", () => {
    expect(executable).not.toMatch(/drop\s+table/i);
    expect(executable).not.toMatch(/drop\s+column/i);
    expect(executable).not.toMatch(/alter\s+column/i);
  });

  it("defines no functions — those belong to the function-capture migration", () => {
    expect(executable).not.toMatch(/create\s+or\s+replace\s+function/i);
  });
});

describe("verification block guards against a divergent production schema", () => {
  it("raises rather than silently accepting mismatches", () => {
    // IF NOT EXISTS alone would accept a materially different existing
    // object; these RAISE checks are what make that safe.
    const raises = executable.match(/raise exception 'Schema baseline:/g);

    expect(raises?.length ?? 0).toBeGreaterThanOrEqual(7);
  });

  it("asserts the inspected policy counts (4/2/2/4)", () => {
    expect(executable).toContain("expected 4 policies");
    expect(executable).toContain("expected 2 policies");
  });

  it("asserts that no user triggers exist", () => {
    expect(executable).toContain("unexpected trigger(s) present");
    expect(executable).toContain("not t.tgisinternal");
  });
});
