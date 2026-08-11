// Milestone 18, Feature 18.1 — static guards for the modifier migration.
//
// These assert the SQL text and structure, following the convention every
// migration in this directory uses. They cannot execute the migration; what
// they protect is that it still SAYS what it must — which for a money function
// is most of the risk, because the dangerous failure mode is a security step
// quietly disappearing during a rewrite.
//
// The central worry this file exists to answer: complete_sale_v3 was produced
// from complete_sale_v2's audited body by targeted replacement. If a step was
// dropped in that process, the function would still run and still sell things,
// just without an authorization or bound it used to have.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  join(here, "20260810120000_modifier_contract_and_complete_sale_v3.sql"),
  "utf-8"
);
const v2Migration = readFileSync(
  join(here, "20260803250000_complete_sale_v2.sql"),
  "utf-8"
);

/** SQL with `--` comment lines stripped, so prose never satisfies a guard. */
const executable = migration
  .split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n");

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`create or replace function public.${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("$function$;", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

const v3 = functionBody(executable, "complete_sale_v3");
const v2New = functionBody(executable, "complete_sale_v2");
const v2Original = functionBody(
  v2Migration.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n"),
  "complete_sale_v2"
);

describe("atomicity", () => {
  // The verification block is the LAST statement, and everything before it
  // includes a create-or-replace of complete_sale_v2 — the function every live
  // till calls. Without an enclosing transaction a verification failure would
  // leave production carrying a half-applied migration. This guard exists
  // because "fails loudly" is not "fails safely".
  it("is wrapped in an explicit transaction", () => {
    const statements = executable
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");

    expect(statements[0]).toBe("begin;");
    expect(statements[statements.length - 1]).toBe("commit;");
  });

  it("opens the transaction before any schema or function change", () => {
    expect(executable.indexOf("begin;")).toBeLessThan(executable.indexOf("alter table"));
    expect(executable.indexOf("begin;")).toBeLessThan(
      executable.indexOf("create or replace function")
    );
  });

  it("commits only after the verification block", () => {
    expect(executable.lastIndexOf("commit;")).toBeGreaterThan(
      executable.lastIndexOf("18.1: complete_sale_v2 canonical format changed")
    );
  });

  it("contains nothing that cannot run inside a transaction", () => {
    expect(executable).not.toMatch(/create\s+index\s+concurrently/i);
    expect(executable).not.toMatch(/\bvacuum\b/i);
    expect(executable).not.toMatch(/alter\s+type\s+\S+\s+add\s+value/i);
  });

  it("uses exactly one transaction, never a nested or partial one", () => {
    expect([...executable.matchAll(/^begin;$/gm)]).toHaveLength(1);
    expect([...executable.matchAll(/^commit;$/gm)]).toHaveLength(1);
    expect(executable).not.toMatch(/^rollback;$/m);
  });
});

describe("the modifier snapshot column", () => {
  it("is added additively, defaulted and not null", () => {
    expect(executable).toContain(
      "add column if not exists modifiers jsonb not null default '[]'::jsonb"
    );
  });

  it("is constrained to a JSON array", () => {
    expect(executable).toContain("order_items_modifiers_is_array_check");
    expect(executable).toContain("check (jsonb_typeof(modifiers) = 'array')");
  });

  it("never rewrites existing rows", () => {
    // A DEFAULT satisfies every historical row without an UPDATE. An UPDATE
    // over order_items would rewrite committed sales history.
    expect(executable).not.toMatch(/update\s+public\.order_items/i);
    expect(executable).not.toMatch(/delete\s+from\s+public\.order_items/i);
  });

  it("drops nothing", () => {
    expect(executable).not.toMatch(/drop\s+(table|function|column|constraint|policy)/i);
  });
});

describe("complete_sale_v2 survives with only the fail-closed guard added", () => {
  it("still exists and is still granted to authenticated", () => {
    expect(executable).toContain("create or replace function public.complete_sale_v2(");
    expect(executable).toContain(
      "grant execute on function public.complete_sale_v2(uuid, text, numeric, jsonb, uuid) to authenticated;"
    );
  });

  it("refuses a product that carries modifier groups", () => {
    expect(v2New).toContain("jsonb_typeof(v_price_item -> 'modifierGroups') = 'array'");
    expect(v2New).toContain("jsonb_array_length(v_price_item -> 'modifierGroups') > 0");
    expect(v2New).toContain("This item now has options. Please refresh the POS and try again.");
  });

  it("keeps its own canonical format, so a stale tab still hashes identically", () => {
    expect(v2New).toContain("'posc.sale.v1'");
    expect(v2New).not.toContain("posc.sale.v2");
  });

  it("differs from the original ONLY by the guard", () => {
    // Byte-compare the two bodies with the guard removed. Anything else that
    // changed in v2 would show up here, which is the point: v2 is production
    // code that every stale tab still calls.
    const guardStart = v2New.indexOf("      if jsonb_typeof(v_price_item -> 'modifierGroups')");
    const guardEnd = v2New.indexOf("end if;", guardStart) + "end if;".length;
    expect(guardStart).toBeGreaterThan(-1);

    const withoutGuard = (v2New.slice(0, guardStart) + v2New.slice(guardEnd))
      .replace(/\s+/g, " ")
      .trim();

    expect(withoutGuard).toBe(v2Original.replace(/\s+/g, " ").trim());
  });

  it("still keeps its duplicate-item rule, which v3 replaces rather than inherits", () => {
    expect(v2New).toContain("The same item appears more than once in this order");
  });
});

describe("complete_sale_v3 preserves every security property of v2", () => {
  const required: [string, string][] = [
    ["authentication", "v_caller := auth.uid();"],
    ["missing-auth rejection", "raise exception 'Authentication required'"],
    ["mandatory request id", "raise exception 'A sale request ID is required'"],
    ["all-zero request id rejection", "'00000000-0000-0000-0000-000000000000'::uuid"],
    ["payment method allowlist", "p_payment_method not in ('cash', 'card')"],
    ["item count cap", "jsonb_array_length(p_items) > c_max_items"],
    ["owner resolution", "v_owner_id := public.resolve_sale_owner(p_project_id);"],
    ["project row lock", "for update"],
    ["device revocation check", "and d.revoked_at is null"],
    ["pinned build authorization", "b.status = 'succeeded'"],
    ["device tip rejection", "Tips are not supported on this device"],
    ["quantity bounds", "v_qty_num > c_max_quantity"],
    ["idempotency lookup", "o.sale_request_id = p_sale_request_id"],
    ["hash mismatch rejection", "Sale request ID was already used for a different order"],
    ["live-config inventory source", "v_live_items"],
    ["insufficient stock rejection", "raise exception 'Insufficient inventory for %'"],
    ["money bound", "c_max_money"],
    ["unit price bound", "c_max_unit_price"],
    ["special-numeric predicate", "in ('NaN', 'Infinity', '-Infinity')"],
    ["order counter allocation", "update public.project_order_counters"],
    ["counter exhaustion guard", "Order number sequence exhausted for this project"],
    ["owner stamping on orders", "v_owner_id, p_project_id, v_order_number"],
    ["append-only inventory audit", "insert into public.inventory_transactions"],
    ["unique-violation replay backstop", "when unique_violation then"],
    ["single payload construction", "into v_payload"],
  ];

  for (const [label, needle] of required) {
    it(`retains ${label}`, () => {
      expect(v3).toContain(needle);
    });
  }

  it("keeps the same signature and posture as v2", () => {
    expect(executable).toContain(`create or replace function public.complete_sale_v3(
  p_project_id uuid,
  p_payment_method text,
  p_tip_amount numeric,
  p_items jsonb,
  p_sale_request_id uuid
)`);
    expect(v3).toContain("security definer");
    expect(v3).toContain("set search_path to public, pg_temp");
    expect(v3).toContain("returns jsonb");
  });

  it("never trusts a client-supplied price, name or total", () => {
    for (const field of ["'price'", "'unitPrice'", "'lineTotal'", "'subtotal'", "'total'", "'name'"]) {
      // The request is p_items; these keys may only ever be read from the
      // authorized config (v_price_item / v_source), never from p_items.
      expect(v3).not.toContain(`p_items -> ${field}`);
      expect(v3).not.toContain(`v_item ->> ${field}`);
    }
  });
});

describe("complete_sale_v3 modifier validation", () => {
  const rules: [string, string][] = [
    ["group must belong to the product", "does not have that option group"],
    ["product with no groups accepts no selections", "does not have options"],
    ["option must belong to the group", "That option is not available for %"],
    ["single choice enforced", "Only one option may be chosen for %"],
    ["maxSelections enforced", "Too many options chosen for %"],
    ["required groups enforced", "Please choose % for %"],
    ["duplicate group rejected", "The same option group appears more than once for an item"],
    ["duplicate option rejected", "The same option appears more than once for an item"],
    ["payload size capped", "Too many options for an order item"],
    ["duplicate line rejected", "The same item and options appear more than once in this order"],
  ];

  for (const [label, needle] of rules) {
    it(`enforces: ${label}`, () => {
      expect(v3).toContain(needle);
    });
  }

  it("reads modifier definitions only from the authorized config", () => {
    expect(v3).toContain("v_mod_groups := coalesce(v_price_item -> 'modifierGroups', '[]'::jsonb);");
  });

  it("bounds every option adjustment with the same money rules as the base price", () => {
    expect(v3).toContain("v_mod_adjust > c_max_unit_price");
    expect(v3).toContain("v_mod_adjust < 0");
  });

  it("re-bounds the combined unit price after adding adjustments", () => {
    expect(v3).toContain("v_unit_price := round(v_unit_price + v_mod_total, 2);");
  });

  it("declares the payload caps as constants rather than inline literals", () => {
    expect(v3).toContain("c_max_mod_groups   constant integer := 10;");
    expect(v3).toContain("c_max_mod_options  constant integer := 20;");
    expect(v3).toContain("c_max_mod_selected constant integer := 50;");
  });
});

describe("complete_sale_v3 canonical identity and hash", () => {
  it("uses a new preimage header and never reuses v1's", () => {
    expect(v3).toContain("'posc.sale.v2'");
    expect(v3).not.toContain("'posc.sale.v1'");
  });

  it("length-prefixes group and option ids, matching v2's item-id technique", () => {
    expect(v3).toContain("octet_length(g.gid)::text");
    expect(v3).toContain("octet_length(o.value)::text");
    expect(v3).toContain("octet_length(v_item_id)::text");
  });

  it("sorts deterministically at every level under byte order", () => {
    expect(v3).toContain(`order by g.gid collate "C"`);
    expect(v3).toContain(`order by o.value collate "C"`);
    expect(v3).toContain(`order by (e.value ->> 'key') collate "C"`);
  });

  it("keys the sale hash on the line identity, not on the item id alone", () => {
    expect(v3).toContain("(e.value ->> 'key') || '=' || (e.value ->> 'qty')");
  });

  it("drops empty groups before building the identity", () => {
    expect(v3).toContain("jsonb_array_length(coalesce(m.value -> 'optionIds', '[]'::jsonb)) > 0");
  });
});

describe("complete_sale_v3 persistence and payload", () => {
  it("persists the historical snapshot on the order line", () => {
    expect(v3).toContain("order_id, item_id, item_name, unit_price, quantity, line_total, modifiers");
    expect(v3).toContain("coalesce(line -> 'modifiers', '[]'::jsonb)");
  });

  it("builds the snapshot from authorized definitions, not from the request", () => {
    expect(v3).toContain("'groupName', coalesce(v_mod_group ->> 'name', '')");
    expect(v3).toContain("'optionName', coalesce(v_mod_option ->> 'name', '')");
    expect(v3).toContain("'priceAdjustment', round(v_mod_adjust, 2)::text");
  });

  it("returns the snapshot on the authoritative receipt", () => {
    expect(v3).toContain("'modifiers', coalesce(oi.modifiers, '[]'::jsonb)");
  });

  it("reuses the existing idempotency columns rather than adding new ones", () => {
    expect(executable).not.toMatch(/add column .*sale_request/i);
    expect(v3).toContain("sale_request_id, sale_request_hash");
  });
});

describe("grants and hardening", () => {
  it("revokes v3 from public, anon and service_role", () => {
    for (const role of ["public", "anon", "service_role"]) {
      expect(executable).toContain(
        `revoke all on function public.complete_sale_v3(uuid, text, numeric, jsonb, uuid) from ${role};`
      );
    }
  });

  it("grants v3 to authenticated only", () => {
    expect(executable).toContain(
      "grant execute on function public.complete_sale_v3(uuid, text, numeric, jsonb, uuid) to authenticated;"
    );
  });

  it("widens no table grant and touches no policy or trigger", () => {
    expect(executable).not.toMatch(/grant\s+(all|select|insert|update|delete)\s+on\s+table/i);
    expect(executable).not.toMatch(/create\s+(or replace\s+)?policy/i);
    expect(executable).not.toMatch(/create\s+(or replace\s+)?trigger/i);
    expect(executable).not.toMatch(/alter\s+table\s+\S+\s+(enable|disable)\s+row level security/i);
  });

  it("modifies no other function", () => {
    const created = [...executable.matchAll(/create or replace function public\.(\w+)/g)].map(
      (m) => m[1]
    );
    expect(created.sort()).toEqual(["complete_sale_v2", "complete_sale_v3"]);
  });
});

describe("verification block", () => {
  it("asserts the column, the constraint and no null rows", () => {
    expect(executable).toContain("18.1: order_items.modifiers is missing or nullable");
    expect(executable).toContain("18.1: order_items_modifiers_is_array_check is missing");
    expect(executable).toContain("18.1: an order_items row has a null modifiers value");
  });

  it("asserts v3 posture and grants", () => {
    for (const message of [
      "18.1: complete_sale_v3 must be SECURITY DEFINER",
      "18.1: complete_sale_v3 must be owned by postgres",
      "18.1: complete_sale_v3 must lock search_path",
      "18.1: authenticated must hold EXECUTE on complete_sale_v3",
      "18.1: anon must not hold EXECUTE on complete_sale_v3",
      "18.1: service_role must not hold EXECUTE on complete_sale_v3",
    ]) {
      expect(executable).toContain(message);
    }
  });

  it("asserts v2 survives, stays guarded, and keeps its canonical format", () => {
    expect(executable).toContain("18.1: complete_sale_v2 must remain available");
    expect(executable).toContain("18.1: complete_sale_v2 is missing the modifier fail-closed guard");
    expect(executable).toContain("18.1: complete_sale_v2 canonical format changed");
  });

  it("asserts v1 is untouched", () => {
    expect(executable).toContain("18.1: complete_sale v1 must remain available");
  });

  it("asserts v3 did not lose a security step during the port", () => {
    for (const message of [
      "18.1: complete_sale_v3 lost its authorization step",
      "18.1: complete_sale_v3 lost the project lock",
      "18.1: complete_sale_v3 lost the device revocation check",
      "18.1: complete_sale_v3 lost idempotency",
    ]) {
      expect(executable).toContain(message);
    }
  });
});
