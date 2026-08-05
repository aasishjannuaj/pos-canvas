// Milestone 16, Feature 16.3 — Migration D1 static guards.
//
// SCOPE: TEXT-level assertions. They prove the migration declares the intended
// privilege matrix and removes the two audit-log policies. They do NOT prove
// effective privilege on a live database — has_table_privilege in the
// migration's own DO block does that at apply time, and the live test plan
// exercises the real flows.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(migrationsDir, "20260803230000_privilege_and_audit_hardening.sql"),
  "utf-8"
);

const executable = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

const TABLES = [
  "projects",
  "orders",
  "order_items",
  "inventory_transactions",
  "build_jobs",
  "build_artifacts",
  "device_pairing_tokens",
  "paired_devices",
] as const;

const RESET_ROLES = ["public", "anon", "authenticated", "service_role"] as const;

// The approved minimum, traced to source in the migration header. Nothing here
// is granted for a hypothetical future caller: `service_role` appears on
// build_jobs only, and `projects` carries no DELETE because no call site exists.
const EXPECTED_AUTHENTICATED: Record<string, string> = {
  projects: "select, insert, update",
  orders: "select",
  order_items: "select",
  inventory_transactions: "select, insert",
  build_jobs: "select",
  build_artifacts: "select",
  device_pairing_tokens: "select",
  paired_devices: "select",
};

// The ONLY service_role table grant in the migration.
const SERVICE_ROLE_TABLE = "build_jobs";
const SERVICE_ROLE_GRANT = "select, insert";

describe("migration ordering", () => {
  it("sorts after the Migration C checkout migration", () => {
    expect(
      "20260803220000_secure_checkout_recomputation.sql" <
        "20260803230000_privilege_and_audit_hardening.sql"
    ).toBe(true);
  });
});

describe("deterministic privilege reset", () => {
  it("revokes all four roles on all eight tables", () => {
    for (const table of TABLES) {
      for (const role of RESET_ROLES) {
        expect(executable).toContain(
          `revoke all privileges on table public.${table} from ${role};`
        );
      }
    }
  });

  it("issues exactly 32 revokes — 8 tables x 4 roles, none missed", () => {
    const revokes = executable.match(/revoke all privileges on table public\.\w+ from \w+;/g) ?? [];
    expect(revokes.length).toBe(32);
    expect(new Set(revokes).size).toBe(32);
  });

  it("revokes from PUBLIC before granting, on every table", () => {
    // A PUBLIC grant reaches every current and future role, so revoking it
    // after the grants would be a no-op against the wrong target.
    for (const table of TABLES) {
      const revokePublic = executable.indexOf(
        `revoke all privileges on table public.${table} from public;`
      );
      const firstGrant = executable.indexOf(`on table public.${table} to `);
      expect(revokePublic).toBeGreaterThan(-1);
      expect(revokePublic).toBeLessThan(firstGrant);
    }
  });
});

describe("approved minimum privileges", () => {
  it("grants authenticated exactly the approved set per table", () => {
    for (const table of TABLES) {
      expect(executable).toContain(
        `grant ${EXPECTED_AUTHENTICATED[table]} on table public.${table} to authenticated;`
      );
    }
  });

  it("never grants DELETE on projects to authenticated", () => {
    // No call site exists anywhere in the application. The delete policy stays
    // in place but becomes unreachable: RLS narrows a privilege, never confers
    // one. A future delete-project feature must grant this explicitly.
    expect(executable).toContain(
      "grant select, insert, update on table public.projects to authenticated;"
    );
    expect(executable).not.toMatch(/grant[^;]*delete[^;]*on table public\.projects/i);
  });

  it("grants service_role privileges on build_jobs and nowhere else", () => {
    expect(executable).toContain(
      `grant ${SERVICE_ROLE_GRANT} on table public.${SERVICE_ROLE_TABLE} to service_role;`
    );
    const serviceGrants = executable.match(/grant [\w, ]+ on table public\.(\w+) to service_role;/g) ?? [];
    expect(serviceGrants.length).toBe(1);
    for (const table of TABLES) {
      if (table === SERVICE_ROLE_TABLE) continue;
      expect(executable).not.toContain(`on table public.${table} to service_role;`);
    }
  });

  it("withdraws the Migration B service_role pairing grants", () => {
    // They anticipated an expired-token cleanup job that does not exist in the
    // repository. A future cleanup task must introduce its own capability.
    expect(executable).not.toMatch(/on table public\.device_pairing_tokens to service_role/i);
    expect(executable).not.toMatch(/on table public\.paired_devices to service_role/i);
  });

  it("issues exactly 9 grants — 8 authenticated plus 1 service_role", () => {
    const grants = executable.match(/grant [\w, ]+ on table public\.\w+ to \w+;/g) ?? [];
    expect(grants.length).toBe(9);
    expect(grants.filter((g) => g.endsWith("to authenticated;")).length).toBe(8);
    expect(grants.filter((g) => g.endsWith("to service_role;")).length).toBe(1);
  });

  it("grants nothing at all to anon or PUBLIC", () => {
    expect(executable).not.toMatch(/grant[^;]*on table[^;]*to anon;/i);
    expect(executable).not.toMatch(/grant[^;]*on table[^;]*to public;/i);
  });

  it("never grants TRUNCATE, REFERENCES or TRIGGER to anyone", () => {
    const grants = executable.match(/grant [\w, ]+ on table[^;]*;/gi) ?? [];
    for (const g of grants) {
      expect(g.toLowerCase()).not.toContain("truncate");
      expect(g.toLowerCase()).not.toContain("references");
      expect(g.toLowerCase()).not.toContain("trigger");
      expect(g.toLowerCase()).not.toContain("all on table");
      expect(g.toLowerCase()).not.toContain("all privileges on table");
    }
  });

  it("preserves the INSERT that the SECURITY INVOKER inventory RPCs require", () => {
    // restock_inventory and adjust_inventory INSERT INTO
    // public.inventory_transactions as the CALLING user. Losing this breaks
    // both owner RPCs — the single most dangerous over-revoke in this file.
    expect(executable).toContain(
      "grant select, insert on table public.inventory_transactions to authenticated;"
    );
  });

  it("preserves the service_role reads and inserts the build worker performs", () => {
    // worker/once.ts:261,471 read build_jobs directly (not through an RPC), and
    // createBuildJob inserts through the admin client at
    // lib/buildJobs.server.ts:351. Every worker WRITE is a DEFINER RPC.
    expect(executable).toContain(
      "grant select, insert on table public.build_jobs to service_role;"
    );
  });

  it("keeps every authenticated read the application actually performs", () => {
    // One assertion per traced read path, so an over-zealous future revoke
    // fails here rather than in production.
    expect(executable).toContain("grant select on table public.orders to authenticated;");
    expect(executable).toContain("grant select on table public.order_items to authenticated;");
    expect(executable).toContain("grant select on table public.build_jobs to authenticated;");
    expect(executable).toContain("grant select on table public.build_artifacts to authenticated;");
    expect(executable).toContain(
      "grant select on table public.device_pairing_tokens to authenticated;"
    );
    expect(executable).toContain("grant select on table public.paired_devices to authenticated;");
  });
});

describe("audit log becomes append-only", () => {
  it("drops the UPDATE and DELETE policies on inventory_transactions", () => {
    expect(executable).toContain(
      'drop policy if exists "Users can update their inventory transactions"'
    );
    expect(executable).toContain(
      'drop policy if exists "Users can delete their inventory transactions"'
    );
  });

  it("drops no other policy", () => {
    const drops = executable.match(/drop policy[^;]*;/gi) ?? [];
    expect(drops.length).toBe(2);
    for (const d of drops) expect(d).toContain("inventory_transactions");
  });

  it("creates no policy and leaves SELECT and INSERT in place", () => {
    expect(executable).not.toMatch(/create policy/i);
    expect(executable).toContain("lost its SELECT policy");
    expect(executable).toContain("lost the INSERT policy restock/adjust need");
  });
});

describe("verification block", () => {
  it("tests EFFECTIVE privilege, not explicit ACL rows", () => {
    // has_table_privilege resolves grants inherited through PUBLIC and through
    // role membership; a scan of information_schema alone would miss those.
    expect(executable).toContain("has_table_privilege(");
    expect(executable).toContain("c_privs constant text[]");
    for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
      expect(executable).toContain(`'${p}'`);
    }
  });

  it("checks PUBLIC separately, because it has no role oid", () => {
    expect(executable).toContain("grantee = 'PUBLIC'");
    expect(executable).toContain("raise exception 'D1: PUBLIC still holds");
  });

  it("asserts anon holds nothing on every table", () => {
    expect(executable).toContain("has_table_privilege('anon'");
    expect(executable).toContain("D1: anon still holds % on public.%");
  });

  it("asserts the exact expected set for both roles", () => {
    for (const table of TABLES) expect(executable).toContain(`('${table}',`);
    expect(executable).toContain("if v_has <> v_should then");
    // service_role expects an EMPTY set on the seven non-build tables.
    const empties = executable.match(/'service_role',  '\{\}'::text\[\]/g) ?? [];
    expect(empties.length).toBe(7);
    expect(executable).toContain("'service_role',  array['SELECT','INSERT']");
    expect(executable).toContain("'authenticated', array['SELECT','INSERT','UPDATE']");
  });

  it("asserts authenticated lacks DELETE/TRUNCATE/REFERENCES/TRIGGER on projects", () => {
    expect(executable).toContain(
      "foreach v_priv in array array['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']"
    );
    expect(executable).toContain(
      "D1: authenticated must not hold % on public.projects"
    );
  });

  it("asserts service_role holds nothing outside build_jobs", () => {
    expect(executable).toContain("if v_table <> 'build_jobs' then");
    expect(executable).toContain("D1: service_role must hold nothing on public.%, found %");
  });

  it("calls out TRUNCATE separately for both browser-reachable roles", () => {
    expect(executable).toContain("D1: authenticated still holds TRUNCATE on public.%");
    expect(executable).toContain("D1: service_role still holds TRUNCATE on public.%");
  });

  it("confirms RLS is still enabled everywhere", () => {
    expect(executable).toContain("c.relrowsecurity");
    expect(executable).toContain("row level security is not enabled");
  });

  it("confirms the checkout and inventory functions kept their posture", () => {
    expect(executable).toContain("D1: complete_sale must remain SECURITY DEFINER");
    expect(executable).toContain("D1: restock_inventory must remain SECURITY INVOKER");
    expect(executable).toContain("D1: adjust_inventory must remain SECURITY INVOKER");
    // Resolved by exact overload, never by an identity-arguments string.
    expect(executable).toContain("to_regprocedure(");
    expect(executable).not.toMatch(/pg_get_function_identity_arguments/i);
  });
});

describe("scope containment", () => {
  it("contains no table DDL", () => {
    expect(executable).not.toMatch(/create\s+table/i);
    expect(executable).not.toMatch(/alter\s+table/i);
    expect(executable).not.toMatch(/drop\s+(table|column|index)/i);
    expect(executable).not.toMatch(/create\s+(index|trigger|sequence)/i);
  });

  it("replaces no function body and changes no EXECUTE grant", () => {
    expect(executable).not.toMatch(/create\s+or\s+replace\s+function/i);
    expect(executable).not.toMatch(/drop\s+function/i);
    expect(executable).not.toMatch(/(grant|revoke)[^;]*on function/i);
  });

  it("writes no data", () => {
    expect(executable).not.toMatch(/^\s*insert\s+into/im);
    expect(executable).not.toMatch(/^\s*update\s+public\./im);
    expect(executable).not.toMatch(/^\s*delete\s+from/im);
    // A TRUNCATE *statement*, not the word — 'TRUNCATE' appears legitimately in
    // the verification block as a privilege name being asserted absent.
    expect(executable).not.toMatch(/^\s*truncate\s+/im);
  });

  it("does not touch complete_sale, restock_inventory or adjust_inventory", () => {
    for (const fn of ["complete_sale", "restock_inventory", "adjust_inventory"]) {
      expect(executable).not.toMatch(new RegExp(`create or replace function public\\.${fn}`, "i"));
      expect(executable).not.toMatch(new RegExp(`(grant|revoke)[^;]*function[^;]*${fn}`, "i"));
    }
  });

  it("touches exactly the eight approved tables and no others", () => {
    const touched = new Set(
      [...executable.matchAll(/on table public\.(\w+)/g)].map((m) => m[1])
    );
    expect([...touched].sort()).toEqual([...TABLES].sort());
  });
});
