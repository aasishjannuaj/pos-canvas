// Milestone 16, Feature 16.3 — Migration D3 static guards.
//
// TEXT-level assertions over the migration. libpg-query parses a DO block's
// body as an opaque string, so the plpgsql inside is not statically validated;
// the migration's own verification block is self-checking at apply time.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(migrationsDir, "20260803250000_complete_sale_v2.sql"),
  "utf-8"
);

const executable = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

const V2 = "public.complete_sale_v2(uuid, text, numeric, jsonb, uuid)";
const at = (needle: string) => executable.indexOf(needle);

describe("migration ordering", () => {
  it("sorts after the D2 scaffold", () => {
    expect(
      "20260803240000_order_counter_and_idempotency_scaffold.sql" <
        "20260803250000_complete_sale_v2.sql"
    ).toBe(true);
  });
});

describe("v1 is untouched", () => {
  it("is never replaced, dropped, granted or revoked", () => {
    expect(executable).not.toMatch(
      /create\s+or\s+replace\s+function\s+public\.complete_sale\s*\(/i
    );
    expect(executable).not.toMatch(/drop\s+function[^;]*complete_sale\b(?!_v2)/i);
    expect(executable).not.toMatch(
      /(grant|revoke)[^;]*on function public\.complete_sale\(uuid, ?text, ?text/i
    );
  });

  it("declares exactly one function, and it is v2", () => {
    const created = executable.match(/create or replace function public\.(\w+)/g) ?? [];
    expect(created).toEqual(["create or replace function public.complete_sale_v2"]);
  });

  it("asserts v1 survives with its posture and return type", () => {
    expect(executable).toContain("D3: complete_sale v1 must remain available");
    expect(executable).toContain("D3: complete_sale v1 must remain SECURITY DEFINER");
    expect(executable).toContain("D3: complete_sale v1 must keep EXECUTE for authenticated");
    expect(executable).toContain("D3: complete_sale v1 must still return uuid");
  });

  it("does not touch restock_inventory or adjust_inventory", () => {
    for (const fn of ["restock_inventory", "adjust_inventory"]) {
      expect(executable).not.toMatch(
        new RegExp(`create or replace function public\\.${fn}`, "i")
      );
    }
    expect(executable).toContain("D3: restock_inventory must remain SECURITY INVOKER");
    expect(executable).toContain("D3: adjust_inventory must remain SECURITY INVOKER");
  });
});

describe("v2 signature and security posture", () => {
  it("has the exact approved signature and jsonb return", () => {
    expect(executable).toContain("create or replace function public.complete_sale_v2(");
    for (const p of [
      "p_project_id uuid",
      "p_payment_method text",
      "p_tip_amount numeric",
      "p_items jsonb",
      "p_sale_request_id uuid",
    ]) {
      expect(executable).toContain(p);
    }
    expect(executable).toContain("returns jsonb");
    // No client order number and no client totals exist in the contract.
    expect(executable).not.toMatch(/p_order_number|p_subtotal|p_tax_amount|p_total\b/);
  });

  it("is SECURITY DEFINER with a locked search_path", () => {
    expect(executable).toContain("security definer");
    expect(executable).toContain("set search_path to public, pg_temp");
    expect(executable).toContain("language plpgsql");
  });

  it("grants EXECUTE to authenticated only", () => {
    expect(executable).toContain(`revoke all on function ${V2} from public;`);
    expect(executable).toContain(`revoke all on function ${V2} from anon;`);
    expect(executable).toContain(`revoke all on function ${V2} from service_role;`);
    expect(executable).toContain(`grant execute on function ${V2} to authenticated;`);
    const grants = executable.match(/grant execute on function[^;]*;/gi) ?? [];
    expect(grants.length).toBe(1);
  });
});

describe("canonical request", () => {
  it("covers project, payment method, tip and sorted item id + quantity", () => {
    expect(executable).toContain("'posc.sale.v1'");
    expect(executable).toContain("'project=' || p_project_id::text");
    expect(executable).toContain("'payment=' || v_method");
    expect(executable).toContain("'tip=' || v_tip_amount::text");
    expect(executable).toContain("order by (e.value ->> 'id') collate \"C\"");
    expect(executable).toContain("octet_length(e.value ->> 'id')::text");
  });

  it("excludes every server-derived value from the preimage", () => {
    const canonical = executable.slice(
      at("v_canonical :="),
      at("v_hash := encode(")
    );
    for (const forbidden of [
      "item_name",
      "unit_price",
      "v_subtotal",
      "v_tax_amount",
      "v_total",
      "order_number",
      "v_price_item",
    ]) {
      expect(canonical).not.toContain(forbidden);
    }
  });

  it("uses locale-independent numeric text and core sha256", () => {
    expect(executable).toContain("encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex')");
    // to_char's decimal separator follows lc_numeric; numeric::text does not.
    expect(executable).not.toMatch(/to_char\s*\(\s*v_tip_amount/i);
  });

  it("rejects duplicate item ids before anything is hashed", () => {
    expect(at("The same item appears more than once in this order")).toBeLessThan(
      at("v_hash := encode(")
    );
  });
});

describe("idempotency", () => {
  it("looks up by project and request id", () => {
    expect(executable).toContain("where o.project_id = p_project_id\n    and o.sale_request_id = p_sale_request_id;");
  });

  it("runs after authorization and the lock, before every mutation", () => {
    const lookup = at("select o.id, o.sale_request_hash into v_existing");
    expect(at("v_owner_id := public.resolve_sale_owner(p_project_id);")).toBeLessThan(lookup);
    expect(at("for update;")).toBeLessThan(lookup);
    // before pricing/menu validation, counter allocation and every insert
    expect(lookup).toBeLessThan(at("select b.config_snapshot into v_source"));
    expect(lookup).toBeLessThan(at("insert into public.project_order_counters"));
    expect(lookup).toBeLessThan(at("update public.project_order_counters"));
    expect(lookup).toBeLessThan(at("insert into public.orders"));
    expect(lookup).toBeLessThan(at("insert into public.order_items"));
    expect(lookup).toBeLessThan(at("insert into public.inventory_transactions"));
    expect(lookup).toBeLessThan(at("jsonb_set(v_config, '{menuItems}'"));
  });

  it("raises the approved controlled error on a hash mismatch", () => {
    expect(executable).toContain(
      "raise exception 'Sale request ID was already used for a different order'"
    );
    expect(executable).toContain("v_existing.sale_request_hash is distinct from v_hash");
  });

  it("requires a non-null, non-zero request id with no server fallback", () => {
    expect(executable).toContain("if p_sale_request_id is null then");
    expect(executable).toContain("'00000000-0000-0000-0000-000000000000'::uuid");
    expect(executable).not.toMatch(/p_sale_request_id\s*:?=\s*gen_random_uuid/i);
  });

  it("keeps the unique index as a backstop, not the primary path", () => {
    expect(executable).toContain("when unique_violation then");
    // The handler re-reads and re-applies the SAME comparison.
    const handler = executable.slice(at("when unique_violation then"), at("-- Only write the rest"));
    expect(handler).toContain("sale_request_hash is distinct from v_hash");
    expect(handler).toContain("Could not allocate a unique order number");
  });
});

describe("counter allocation", () => {
  it("lazily creates the row, locks it, guards overflow, then allocates", () => {
    expect(executable).toContain("insert into public.project_order_counters (project_id, last_number)\n    values (p_project_id, 1000)\n    on conflict (project_id) do nothing;");
    expect(executable).toContain("where c.project_id = p_project_id\n    for update;");
    expect(executable).toContain("if v_suffix >= c_max_suffix then");
    expect(executable).toContain("Order number sequence exhausted for this project");
    expect(executable).toContain("set last_number = last_number + 1,");
    expect(executable).toContain("returning last_number into v_suffix;");
    expect(at("for update;")).toBeLessThan(at("set last_number = last_number + 1,"));
  });

  it("introduces no sequence", () => {
    expect(executable).not.toMatch(/create\s+sequence|nextval|serial|generated\s+always\s+as\s+identity/i);
  });

  it("derives the prefix from the authorized source and normalizes it", () => {
    expect(executable).toContain("v_receipt ->> 'orderPrefix'");
    expect(executable).toContain("regexp_replace(v_prefix, '[[:cntrl:]]', '', 'g')");
    expect(executable).toContain("left(v_prefix, c_max_prefix_len)");
    expect(executable).toContain("v_order_number := v_prefix || v_suffix::text;");
  });
});

describe("order row", () => {
  it("stamps number_source server plus the request id and hash", () => {
    expect(executable).toContain("'server', p_sale_request_id, v_hash");
    expect(executable).toContain("number_source, sale_request_id, sale_request_hash");
  });

  it("stamps the resolved owner, never the caller", () => {
    expect(executable).toMatch(/insert into public\.orders[\s\S]*?values \(\n        v_owner_id,/);
    expect(executable).toMatch(/insert into public\.inventory_transactions[\s\S]*?select v_owner_id,/);
    expect(executable.match(/auth\.uid\(\)/g)?.length).toBe(1);
  });
});

describe("authoritative payload", () => {
  it("is built from stored orders and order_items, in one path", () => {
    expect(executable).toContain("from public.orders o\n  where o.id = v_order_id;");
    expect(executable).toContain("from public.order_items oi\n             where oi.order_id = o.id");
    // Exactly one payload construction, shared by both branches.
    expect((executable.match(/'orderNumber', o\.order_number/g) ?? []).length).toBe(1);
  });

  it("returns money as fixed two-decimal strings", () => {
    for (const f of ["subtotal", "tax_amount", "tip_amount", "total"]) {
      expect(executable).toContain(`o.${f}::text`);
    }
    expect(executable).toContain("oi.unit_price::text");
    expect(executable).toContain("oi.line_total::text");
    expect(executable).toContain("'quantity', oi.quantity");
  });

  it("leaks no internal field", () => {
    const payload = executable.slice(at("select jsonb_build_object(\n           'orderId'"), at("if v_payload is null"));
    for (const forbidden of ["user_id", "sale_request_id", "sale_request_hash", "build_job", "stock_before", "stock_after", "config_snapshot"]) {
      expect(payload).not.toContain(forbidden);
    }
  });
});

describe("Migration C protections are retained", () => {
  it("keeps authorization, locking and the pricing branch", () => {
    expect(executable).toContain("v_owner_id := public.resolve_sale_owner(p_project_id);");
    expect(executable).toContain("where p.id = p_project_id and p.user_id = v_owner_id\n  for update;");
    expect(executable).toContain("where id = p_project_id and user_id = v_owner_id;");
    expect(executable).toContain("from public.paired_devices d");
    expect(executable).toContain("and d.revoked_at is null");
    expect(executable).toContain("and b.status = 'succeeded'");
  });

  it("keeps server derivation, bounds, special-value and tax rules", () => {
    expect(executable).toContain("v_item_name := btrim(coalesce(v_price_item ->> 'name', ''));");
    expect(executable).toContain("v_unit_price := (v_price_item ->> 'price')::numeric;");
    expect(executable).toContain("v_live_item ->> 'stockQuantity'");
    expect(executable).toContain("Insufficient inventory for %");
    expect(executable).toContain("c_max_money      constant numeric := 9999999999.99;");
    const guards = executable.match(/::text in \('NaN', 'Infinity', '-Infinity'\)/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(10);
    expect(executable).toContain("round(v_subtotal - v_subtotal / (1 + v_rate / 100), 2)");
    expect(executable).toContain("round(v_subtotal * v_rate / 100, 2)");
    expect(executable).toContain("Tips are not supported on this device");
  });

  it("never reads a client name, price or total", () => {
    expect(executable).not.toContain("v_item ->> 'name'");
    expect(executable).not.toContain("v_item ->> 'price'");
    const reads = [...executable.matchAll(/v_item ->> '(\w+)'/g)].map((m) => m[1]);
    expect([...new Set(reads)].sort()).toEqual(["id", "itemId", "quantity", "qty"].sort());
  });
});

describe("scope containment", () => {
  it("makes no table or privilege change", () => {
    expect(executable).not.toMatch(/create\s+table|alter\s+table|drop\s+(table|column|index|policy)/i);
    expect(executable).not.toMatch(/(grant|revoke)[^;]*on table/i);
    expect(executable).not.toMatch(/create\s+(policy|index|trigger)/i);
  });

  it("re-asserts the D2 counter posture", () => {
    expect(executable).toContain(
      "D3: project_order_counters must remain unreachable by application roles"
    );
  });
});
