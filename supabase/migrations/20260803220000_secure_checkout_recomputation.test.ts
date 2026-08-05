// Milestone 16, Feature 16.3 — Migration C static guards.
//
// SCOPE, stated plainly: these are TEXT-level assertions plus a pure model of
// the money algorithm. They prove the migration declares the intended posture
// and that the pinned rounding vectors are self-consistent. They do NOT prove
// runtime behavior — that a device sale is actually authorized, that a fake
// price is actually ignored, or that inventory actually decrements can only be
// established by executing against a real database. That is the live test plan.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(migrationsDir, "20260803220000_secure_checkout_recomputation.sql"),
  "utf-8"
);

const executable = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

// Everything after `returns uuid`, i.e. the body and the statements that follow
// it. Used to prove the ignored parameters are never READ, as distinct from
// never being declared — they must stay in the signature for compatibility.
const afterSignature = executable.slice(executable.indexOf("returns uuid"));

const SIGNATURE =
  "public.complete_sale(uuid, text, text, numeric, numeric, numeric, numeric, jsonb)";

describe("migration ordering", () => {
  it("sorts after the device-pairing migration", () => {
    expect(
      "20260803210000_device_pairing.sql" <
        "20260803220000_secure_checkout_recomputation.sql"
    ).toBe(true);
  });
});

describe("signature and return compatibility", () => {
  it("replaces the exact existing overload with the same 8 parameters", () => {
    expect(executable).toContain("create or replace function public.complete_sale(");
    for (const param of [
      "p_project_id uuid",
      "p_order_number text",
      "p_payment_method text",
      "p_subtotal numeric",
      "p_tax_amount numeric",
      "p_tip_amount numeric",
      "p_total numeric",
      "p_items jsonb",
    ]) {
      expect(executable).toContain(param);
    }
  });

  it("keeps the uuid return type", () => {
    expect(executable).toContain("returns uuid");
    expect(executable).not.toMatch(/returns\s+(jsonb|json|table|record|setof)/i);
  });

  it("never renames a parameter (CREATE OR REPLACE cannot rename inputs)", () => {
    // A rename would fail at apply time with "cannot change name of input
    // parameter", so the names above are load-bearing, not cosmetic.
    expect(executable).not.toMatch(/p_items_v2|p_lines|p_cart\b/);
  });

  it("declares exactly one function", () => {
    expect(executable.match(/create or replace function/gi)?.length).toBe(1);
  });
});

describe("security posture", () => {
  it("is SECURITY DEFINER with a locked search_path", () => {
    expect(executable).toContain("security definer");
    expect(executable).toContain("set search_path to public, pg_temp");
  });

  it("stays LANGUAGE plpgsql", () => {
    expect(executable).toContain("language plpgsql");
  });

  it("revokes from PUBLIC, anon and service_role, and grants only authenticated", () => {
    expect(executable).toContain(`revoke all on function ${SIGNATURE} from public;`);
    expect(executable).toContain(`revoke all on function ${SIGNATURE} from anon;`);
    expect(executable).toContain(
      `revoke all on function ${SIGNATURE} from service_role;`
    );
    expect(executable).toContain(`grant execute on function ${SIGNATURE} to authenticated;`);
  });

  it("grants EXECUTE to no role other than authenticated", () => {
    const grants = executable.match(/grant execute on function[^;]*;/gi) ?? [];
    expect(grants.length).toBe(1);
    expect(grants[0]).toContain("to authenticated");
    expect(executable).not.toMatch(/grant execute on function[^;]*to service_role/i);
    expect(executable).not.toMatch(/grant execute on function[^;]*to (anon|public)/i);
  });

  it("verifies its own posture at apply time", () => {
    for (const check of [
      "to_regprocedure(\n    'public.complete_sale(uuid,text,text,numeric,numeric,numeric,numeric,jsonb)'\n  )",
      "raise exception 'Migration C: complete_sale must be SECURITY DEFINER'",
      "raise exception 'Migration C: complete_sale must lock search_path to public, pg_temp'",
      "raise exception 'Migration C: service_role must not hold EXECUTE on complete_sale'",
    ]) {
      expect(executable).toContain(check);
    }
    // Never the identity-arguments string comparison that produced a false
    // failure during Migration B.
    expect(executable).not.toMatch(/pg_get_function_identity_arguments/i);
  });
});

describe("authorization", () => {
  it("calls public.resolve_sale_owner exactly once", () => {
    const calls = executable.match(/public\.resolve_sale_owner\(p_project_id\)/g) ?? [];
    expect(calls.length).toBe(1);
    expect(executable).toContain("v_owner_id := public.resolve_sale_owner(p_project_id);");
  });

  it("never authorizes by comparing auth.uid() to projects.user_id directly", () => {
    // auth.uid() is captured once as the caller identity; it must never stand in
    // for the business owner.
    expect(executable).toContain("v_caller := auth.uid();");
    expect(executable.match(/auth\.uid\(\)/g)?.length).toBe(1);
    // Word-boundary anchored so this does NOT match the legitimate device
    // lookup `d.auth_user_id = v_caller` — `_` is a word character, so \b
    // cannot fire inside `auth_user_id`. What it does catch is a
    // `projects.user_id = v_caller` ownership shortcut, which would bypass
    // resolve_sale_owner and silently lock devices out again.
    expect(executable).not.toMatch(/\buser_id\s*=\s*v_caller/);
    expect(executable).toContain("d.auth_user_id = v_caller");
  });

  it("keeps the ownership predicate on the locked SELECT and the final UPDATE", () => {
    expect(executable).toContain(
      "where p.id = p_project_id\n    and p.user_id = v_owner_id\n  for update;"
    );
    expect(executable).toContain(
      "where id = p_project_id\n    and user_id = v_owner_id;"
    );
  });

  it("preserves the FOR UPDATE project lock", () => {
    expect(executable).toContain("for update;");
    // The lock must be taken before any pricing or stock read.
    expect(executable.indexOf("for update;")).toBeLessThan(
      executable.indexOf("v_price_items :=")
    );
  });

  it("derives the device build id from paired_devices, never from a parameter", () => {
    expect(executable).toContain("select d.build_job_id");
    expect(executable).toContain("from public.paired_devices d");
    expect(executable).toContain("where d.auth_user_id = v_caller");
    expect(executable).toContain("and d.project_id = p_project_id");
    expect(executable).toContain("and d.revoked_at is null");
    // No parameter could ever supply a build id — none exists in the signature.
    expect(executable).not.toMatch(/p_build_job_id|p_build_id|p_snapshot/);
  });

  it("requires the device's pinned build to still be succeeded", () => {
    expect(executable).toContain("where b.id = v_build_job_id");
    expect(executable).toContain("and b.project_id = p_project_id");
    expect(executable).toContain("and b.status = 'succeeded'");
  });

  it("stamps the resolved owner id on both owner-bearing inserts", () => {
    // orders
    expect(executable).toMatch(
      /insert into public\.orders[\s\S]*?values \(\n    v_owner_id,/
    );
    // inventory_transactions
    expect(executable).toMatch(
      /insert into public\.inventory_transactions[\s\S]*?select\n    v_owner_id,/
    );
  });
});

describe("client input is never trusted", () => {
  it("never reads the client's item name or price", () => {
    expect(executable).not.toContain("v_cart_item ->> 'name'");
    expect(executable).not.toContain("v_cart_item ->> 'price'");
    expect(executable).not.toContain("v_cart_item->>'name'");
    expect(executable).not.toContain("v_cart_item->>'price'");
  });

  it("reads only itemId and quantity from each client item", () => {
    const reads = [...executable.matchAll(/v_cart_item ->> '(\w+)'/g)].map((m) => m[1]);
    expect([...new Set(reads)].sort()).toEqual(["itemId", "quantity"]);
  });

  it("never uses p_subtotal, p_tax_amount or p_total after the signature", () => {
    for (const param of ["p_subtotal", "p_tax_amount", "p_total"]) {
      expect(afterSignature).not.toContain(param);
    }
  });

  it("derives name and price from the authorized pricing source", () => {
    expect(executable).toContain("v_item_name := btrim(coalesce(v_price_item ->> 'name', ''));");
    expect(executable).toContain("v_unit_price := (v_price_item ->> 'price')::numeric;");
  });

  it("derives stock and trackInventory from the live locked config", () => {
    expect(executable).toContain("v_track := coalesce((v_live_item ->> 'trackInventory')::boolean, false);");
    expect(executable).toContain("v_stock_num := coalesce((v_live_item ->> 'stockQuantity')::numeric, 0);");
  });
});

describe("item validation", () => {
  it("rejects duplicate item ids", () => {
    expect(executable).toContain("count(distinct btrim(e.value ->> 'itemId'))");
    expect(executable).toContain(
      "raise exception 'The same item appears more than once in this order'"
    );
  });

  it("rejects an empty itemId", () => {
    expect(executable).toContain("where coalesce(btrim(e.value ->> 'itemId'), '') = ''");
  });

  it("requires quantity to be a whole number from 1 to the maximum", () => {
    expect(executable).toContain("v_qty_num <> trunc(v_qty_num)");
    expect(executable).toContain("or v_qty_num < 1");
    expect(executable).toContain("or v_qty_num > c_max_quantity");
    expect(executable).toContain("raise exception 'Invalid quantity for an order item'");
  });

  it("rejects an item missing from either the price source or the live config", () => {
    const misses = executable.match(/raise exception 'Menu item % is not available', v_item_id;/g) ?? [];
    expect(misses.length).toBeGreaterThanOrEqual(3);
  });

  it("bounds the number of items in one order", () => {
    // Whitespace-insensitive: alignment in the DECLARE block is cosmetic and
    // must never be what a security assertion depends on.
    expect(executable).toMatch(/c_max_items\s+constant integer := 200;/);
    expect(executable).toContain("raise exception 'Too many order items'");
  });

  it("still rejects overselling a tracked item", () => {
    expect(executable).toContain("if v_stock_before < v_quantity then");
    expect(executable).toContain("raise exception 'Insufficient inventory for %', v_item_name");
  });
});

describe("numeric range safety", () => {
  it("defines the numeric(12,2) ceiling and per-item bounds", () => {
    expect(executable).toMatch(/c_max_money\s+constant numeric := 9999999999\.99;/);
    expect(executable).toMatch(/c_max_unit_price\s+constant numeric := 1000000\.00;/);
    expect(executable).toMatch(/c_max_quantity\s+constant integer := 10000;/);
    expect(executable).toMatch(/c_max_stock\s+constant numeric := 1000000000;/);
  });

  it("bounds every value that reaches a numeric(12,2) column", () => {
    // line_total and the running subtotal, inside the loop
    expect(executable).toContain("if v_line_total > c_max_money then");
    expect(executable).toContain("if v_subtotal > c_max_money then");
    // the final gate before any INSERT
    expect(executable).toContain(
      "if v_subtotal > c_max_money\n     or v_tax_amount > c_max_money\n     or v_tip_amount > c_max_money\n     or v_total > c_max_money then"
    );
    const tooLarge = executable.match(/raise exception 'Order amount is too large'/g) ?? [];
    expect(tooLarge.length).toBeGreaterThanOrEqual(4);
  });

  it("bounds unit price and stock before they are used", () => {
    expect(executable).toContain("or v_unit_price > c_max_unit_price");
    expect(executable).toContain("or v_stock_num > c_max_stock");
  });

  it("rejects negative money", () => {
    expect(executable).toContain("if v_subtotal < 0 or v_total < 0 then");
    expect(executable).toContain("raise exception 'Order amounts cannot be negative'");
  });

  it("guards every cast so no raw cast error can reach the client", () => {
    // One per guarded cast: tax.enabled, tax.pricesIncludeTax, tax.rate,
    // quantity, unit price, trackInventory, stockQuantity.
    const guards = executable.match(/when invalid_text_representation then/g) ?? [];
    expect(guards.length).toBe(7);
  });
});

// ============================================================================
// NULL and special numeric values.
//
// PostgreSQL numeric accepts NaN, Infinity and -Infinity, and orders NaN as
// GREATER than every finite value while treating NaN = NaN as TRUE. A bounds
// check is therefore not proof of finiteness, and the IEEE-754 `v <> v` idiom
// does not port. Each guard below must use the explicit canonical-text
// predicate.
// ============================================================================
describe("special numeric values", () => {
  const PREDICATE = "::text in ('NaN', 'Infinity', '-Infinity')";

  it("uses the canonical-text predicate, not a self-inequality float idiom", () => {
    expect(executable).toContain(PREDICATE);
    // `v <> v` would be a no-op for numeric NaN.
    expect(executable).not.toMatch(/v_\w+\s*<>\s*v_\1\b/);
    // isnan()/isinf() do not exist for numeric.
    expect(executable).not.toMatch(/\bisnan\s*\(|\bisinf\s*\(/i);
  });

  it("rejects a NaN, Infinity or -Infinity tip before the owner/device branch", () => {
    expect(executable).toContain(
      "if p_tip_amount is not null\n     and p_tip_amount::text in ('NaN', 'Infinity', '-Infinity') then"
    );
    // Must precede the TIP branch, or the device path would report NaN <> 0 as
    // a tip that was set rather than a value that was never a number.
    // `if v_is_owner then` appears twice — the pricing-source branch first,
    // the tip branch second — so this anchors on the last one.
    expect(executable.match(/if v_is_owner then/g)?.length).toBe(2);
    expect(executable.indexOf("p_tip_amount::text in")).toBeLessThan(
      executable.lastIndexOf("if v_is_owner then")
    );
    expect(executable).toContain("raise exception 'Order amounts are not valid'");
  });

  it("treats a NULL tip as zero rather than rejecting it", () => {
    expect(executable).toContain("round(coalesce(p_tip_amount, 0), 2)");
    expect(executable).toContain("if coalesce(p_tip_amount, 0) <> 0 then");
  });

  it("rejects a NaN or Infinity menu price from the pricing source", () => {
    expect(executable).toContain(
      "if v_unit_price is null\n       or v_unit_price::text in ('NaN', 'Infinity', '-Infinity')"
    );
  });

  it("falls a malformed tax rate back to 0, never to the 100 clamp", () => {
    // The defect this pins: NaN > 100 is TRUE, so a clamp-only rule would turn
    // a corrupt rate into a 100% tax charge.
    expect(executable).toContain(
      "if v_rate is null or v_rate::text in ('NaN', 'Infinity', '-Infinity') then\n    v_rate := 0;"
    );
    expect(executable.indexOf("v_rate::text in")).toBeLessThan(
      executable.indexOf("elsif v_rate > 100 then")
    );
  });

  it("rejects a NaN or Infinity quantity before the ::integer cast", () => {
    expect(executable).toContain(
      "if v_qty_num is null\n       or v_qty_num::text in ('NaN', 'Infinity', '-Infinity')"
    );
    expect(executable.indexOf("v_qty_num::text in")).toBeLessThan(
      executable.indexOf("v_quantity := v_qty_num::integer;")
    );
  });

  it("rejects a malformed stockQuantity before the ::integer cast", () => {
    expect(executable).toContain(
      "if v_stock_num is null\n         or v_stock_num::text in ('NaN', 'Infinity', '-Infinity')"
    );
    expect(executable.indexOf("v_stock_num::text in")).toBeLessThan(
      executable.indexOf("v_stock_before := v_stock_num::integer;")
    );
  });

  it("asserts finiteness of every computed money value before any INSERT", () => {
    expect(executable).toContain(
      "if v_line_total is null\n       or v_line_total::text in ('NaN', 'Infinity', '-Infinity') then"
    );
    for (const v of ["v_subtotal", "v_tax_amount", "v_tip_amount", "v_total"]) {
      expect(executable).toContain(`or ${v}::text in ('NaN', 'Infinity', '-Infinity')`);
      // v_subtotal opens the condition with `if`; the rest continue with `or`.
      expect(executable).toMatch(
        new RegExp(`(if|or) ${v} is null`)
      );
    }
    // Finiteness must be asserted before the magnitude bound, since NaN would
    // otherwise be reported as "too large".
    expect(executable.indexOf("raise exception 'Order amount is not valid'")).toBeLessThan(
      executable.lastIndexOf("raise exception 'Order amount is too large'")
    );
  });

  it("covers all ten guarded values", () => {
    const guards = executable.match(/::text in \('NaN', 'Infinity', '-Infinity'\)/g) ?? [];
    expect(guards.length).toBe(10);
  });
});

describe("NULL handling for required inputs", () => {
  it("rejects a NULL p_items, a non-array, and an empty array", () => {
    expect(executable).toContain(
      "if p_items is null\n     or jsonb_typeof(p_items) <> 'array'\n     or jsonb_array_length(p_items) = 0 then"
    );
  });

  it("rejects a non-object array element", () => {
    expect(executable).toContain("where jsonb_typeof(e.value) <> 'object'");
  });

  it("rejects a null, empty or whitespace-only itemId", () => {
    expect(executable).toContain("where coalesce(btrim(e.value ->> 'itemId'), '') = ''");
  });

  it("rejects a null quantity", () => {
    expect(executable).toContain("if v_qty_num is null");
  });

  it("rejects a null or blank authorized item name", () => {
    expect(executable).toContain("v_item_name := btrim(coalesce(v_price_item ->> 'name', ''));");
    expect(executable).toContain("if v_item_name = '' then");
  });

  it("rejects a null authorized item price", () => {
    expect(executable).toContain("if v_unit_price is null");
  });

  it("rejects a null or blank order number and payment method", () => {
    expect(executable).toContain("if p_order_number is null or btrim(p_order_number) = '' then");
    expect(executable).toContain(
      "if p_payment_method is null or p_payment_method not in ('cash', 'card') then"
    );
  });

  it("requires both menuItems collections to be arrays", () => {
    expect(executable).toContain("if jsonb_typeof(v_live_items) <> 'array' then");
    expect(executable).toContain("if jsonb_typeof(v_price_items) <> 'array' then");
  });

  it("documents the malformed-tax fallback for enabled and pricesIncludeTax", () => {
    expect(executable).toContain("v_tax_enabled := true;");
    expect(executable).toContain("v_tax_inclusive := false;");
  });

  it("guards the inclusive-tax divisor against zero", () => {
    // rate is clamped to 0..100, so (1 + rate/100) is in [1, 2].
    expect(executable).toContain("v_subtotal / (1 + v_rate / 100)");
    expect(executable).toContain("elsif v_rate > 100 then\n    v_rate := 100;");
  });
});

describe("tips", () => {
  it("rejects any non-zero tip from a paired device", () => {
    expect(executable).toContain("if coalesce(p_tip_amount, 0) <> 0 then");
    expect(executable).toContain("raise exception 'Tips are not supported on this device'");
  });

  it("preserves a non-negative owner tip", () => {
    expect(executable).toContain("v_tip_amount := round(coalesce(p_tip_amount, 0), 2);");
    expect(executable).toContain("if v_tip_amount < 0 then");
  });
});

describe("additive only — nothing else is modified", () => {
  it("contains no table DDL", () => {
    expect(executable).not.toMatch(/create\s+table/i);
    expect(executable).not.toMatch(/alter\s+table/i);
    expect(executable).not.toMatch(/drop\s+(table|column|index|policy)/i);
    expect(executable).not.toMatch(/create\s+(policy|index|trigger)/i);
    expect(executable).not.toMatch(/\btruncate\b/i);
  });

  it("does not redefine restock_inventory or adjust_inventory", () => {
    for (const fn of ["restock_inventory", "adjust_inventory"]) {
      expect(executable).not.toMatch(
        new RegExp(`create or replace function public\\.${fn}\\(`, "i")
      );
    }
  });

  it("asserts those two remain SECURITY INVOKER", () => {
    expect(executable).toContain(
      "raise exception 'Migration C: restock_inventory must remain SECURITY INVOKER'"
    );
    expect(executable).toContain(
      "raise exception 'Migration C: adjust_inventory must remain SECURITY INVOKER'"
    );
  });

  it("does not touch device_pairing_tokens or paired_devices beyond one read", () => {
    expect(executable).not.toMatch(/insert into public\.(paired_devices|device_pairing_tokens)/i);
    expect(executable).not.toMatch(/update public\.(paired_devices|device_pairing_tokens)/i);
    expect(executable).not.toMatch(/delete from public\.(paired_devices|device_pairing_tokens)/i);
  });

  it("writes exactly the four intended targets", () => {
    const writes = [
      ...(executable.match(/insert into public\.(\w+)/g) ?? []),
      ...(executable.match(/update public\.(\w+)/g) ?? []),
    ].map((s) => s.split(".")[1]);
    expect([...new Set(writes)].sort()).toEqual([
      "inventory_transactions",
      "order_items",
      "orders",
      "projects",
    ]);
  });

  it("leaves order numbering to Migration D", () => {
    expect(executable).not.toMatch(/order_number_seq|nextval|unique.*order_number/i);
    expect(executable).toContain("p_order_number,");
  });
});

// ============================================================================
// Money algorithm — pinned vectors.
//
// Computed with exact scaled-integer arithmetic, NOT IEEE-754 doubles, because
// double arithmetic is precisely what this migration stops trusting. round2()
// implements PostgreSQL numeric rounding (half away from zero), which is where
// it diverges from JavaScript's toFixed on binary-inexact values like 1.005.
//
// These vectors model the algorithm; they are pinned here so the live database
// test plan has exact expected values to assert against. They are not a
// substitute for running them on PostgreSQL.
// ============================================================================
const SCALE = 30n;
const UNIT = 10n ** SCALE;

const dec = (s: string): bigint => {
  const neg = s.startsWith("-");
  const [whole, frac = ""] = (neg ? s.slice(1) : s).split(".");
  const padded = (frac + "0".repeat(Number(SCALE))).slice(0, Number(SCALE));
  const v = BigInt(whole) * UNIT + BigInt(padded || "0");
  return neg ? -v : v;
};

const mul = (a: bigint, b: bigint): bigint => (a * b) / UNIT;
const div = (a: bigint, b: bigint): bigint => (a * UNIT) / b;

/** PostgreSQL `round(numeric, 2)` — half away from zero. */
const round2 = (a: bigint): bigint => {
  const step = 10n ** (SCALE - 2n);
  const q = a / step;
  const r = a % step;
  const bump = 2n * (r < 0n ? -r : r) >= step ? (a < 0n ? -1n : 1n) : 0n;
  return (q + bump) * step;
};

const fmt = (a: bigint): string => {
  const step = 10n ** (SCALE - 2n);
  const cents = a / step;
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  return `${neg ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
};

type Line = { price: string; quantity: number };

function computeSale(
  lines: Line[],
  tax: { enabled: boolean; rate: string; pricesIncludeTax: boolean },
  tip = "0"
) {
  let subtotal = 0n;
  const lineTotals: string[] = [];

  for (const line of lines) {
    const lineTotal = round2(dec(line.price) * BigInt(line.quantity));
    lineTotals.push(fmt(lineTotal));
    subtotal += lineTotal;
  }
  subtotal = round2(subtotal);

  const rate = dec(tax.rate);
  let taxAmount = 0n;
  let totalBeforeTip = subtotal;

  if (tax.enabled) {
    if (tax.pricesIncludeTax) {
      taxAmount = round2(subtotal - div(subtotal, UNIT + div(rate, dec("100"))));
      totalBeforeTip = subtotal;
    } else {
      taxAmount = round2(div(mul(subtotal, rate), dec("100")));
      totalBeforeTip = subtotal + taxAmount;
    }
  }

  const tipAmount = round2(dec(tip));
  return {
    lineTotals,
    subtotal: fmt(subtotal),
    taxAmount: fmt(taxAmount),
    tipAmount: fmt(tipAmount),
    total: fmt(round2(totalBeforeTip + tipAmount)),
  };
}

const NO_TAX = { enabled: false, rate: "0", pricesIncludeTax: false };
const EXCL_635 = { enabled: true, rate: "6.35", pricesIncludeTax: false };
const INCL_635 = { enabled: true, rate: "6.35", pricesIncludeTax: true };

describe("pinned money vectors", () => {
  it("1.005 rounds UP to 1.01 (PostgreSQL half-away-from-zero)", () => {
    const r = computeSale([{ price: "1.005", quantity: 1 }], NO_TAX);
    expect(r.lineTotals).toEqual(["1.01"]);
    expect(r.subtotal).toBe("1.01");
    expect(r.total).toBe("1.01");
    // JavaScript disagrees: 1.005 is stored as 1.00499999999999989...
    expect((1.005).toFixed(2)).toBe("1.00");
  });

  it("2.675 rounds UP to 2.68, where JavaScript gives 2.67", () => {
    const r = computeSale([{ price: "2.675", quantity: 1 }], NO_TAX);
    expect(r.subtotal).toBe("2.68");
    expect((2.675).toFixed(2)).toBe("2.67");
  });

  it("multiple quantities round once, at the line", () => {
    const r = computeSale([{ price: "4.999", quantity: 3 }], NO_TAX);
    expect(r.lineTotals).toEqual(["15.00"]);
    expect(r.subtotal).toBe("15.00");
  });

  it("per-line rounding is what makes two half-cent lines differ from the client", () => {
    const r = computeSale(
      [
        { price: "0.005", quantity: 1 },
        { price: "0.005", quantity: 1 },
      ],
      NO_TAX
    );
    // Server: each line rounds to 0.01, so subtotal is 0.02.
    expect(r.lineTotals).toEqual(["0.01", "0.01"]);
    expect(r.subtotal).toBe("0.02");
    // Client sums first (0.005 + 0.005 = 0.01) and would have stored 0.01.
    expect((0.005 + 0.005).toFixed(2)).toBe("0.01");
  });

  it("6.35% exclusive tax on a half-cent boundary", () => {
    const r = computeSale([{ price: "10.00", quantity: 1 }], EXCL_635);
    expect(r.subtotal).toBe("10.00");
    expect(r.taxAmount).toBe("0.64"); // 0.635 -> half away from zero
    expect(r.total).toBe("10.64");
  });

  it("6.35% exclusive tax on a larger half-cent boundary", () => {
    const r = computeSale([{ price: "30.00", quantity: 1 }], EXCL_635);
    expect(r.taxAmount).toBe("1.91"); // 1.905 -> 1.91
    expect(r.total).toBe("31.91");
  });

  it("inclusive tax leaves the total equal to the subtotal", () => {
    const r = computeSale([{ price: "10.00", quantity: 1 }], INCL_635);
    expect(r.subtotal).toBe("10.00");
    expect(r.taxAmount).toBe("0.60"); // 10 - 10/1.0635 = 0.59708...
    expect(r.total).toBe("10.00");
  });

  it("disabled tax contributes nothing", () => {
    const r = computeSale([{ price: "3.33", quantity: 3 }], NO_TAX);
    expect(r.lineTotals).toEqual(["9.99"]);
    expect(r.subtotal).toBe("9.99");
    expect(r.taxAmount).toBe("0.00");
    expect(r.total).toBe("9.99");
  });

  it("an owner tip is rounded before it is added", () => {
    const r = computeSale([{ price: "10.00", quantity: 1 }], EXCL_635, "2.005");
    expect(r.tipAmount).toBe("2.01");
    expect(r.total).toBe("12.65"); // 10.00 + 0.64 + 2.01
  });

  it("the per-item ceilings can exceed numeric(12,2), which is why the bound exists", () => {
    // 1000000.00 * 10000 = 10000000000.00, one cent above 9999999999.99.
    const overflow = dec("1000000.00") * 10000n;
    expect(fmt(round2(overflow))).toBe("10000000000.00");
    expect(round2(overflow) > dec("9999999999.99")).toBe(true);
  });
});
