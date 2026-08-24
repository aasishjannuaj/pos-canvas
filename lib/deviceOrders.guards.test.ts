// Feature 25.3 — the sales-history server contract.
//
// THE RISK THIS GUARDS. A definer function bypasses RLS, so the project scope is
// enforced by the function's own predicate and by nothing else. If the project
// ever became an argument, reading another business's takings would be a matter
// of passing a different uuid. Its ABSENCE from the signature is the security
// property, and that is what these assert.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf-8");

const MIGRATION = "supabase/migrations/20260823130000_device_sales_history.sql";
const V4 = "supabase/migrations/20260819120000_offline_sale_contract_and_complete_sale_v4.sql";
const RPC_CLIENT = "lib/deviceOrders.rpc.ts";
const MODEL = "lib/deviceOrders.ts";

const sql = () => read(MIGRATION);

/** The function body, without the trailing grants. */
function body(): string {
  const s = sql();
  return s.slice(
    s.indexOf("create or replace function public.get_device_recent_orders"),
    s.indexOf("revoke all on function public.get_device_recent_orders")
  );
}

describe("the project can only ever be the caller's own", () => {
  it("has NO project_id argument", () => {
    // The single most dangerous thing this function could offer.
    expect(sql()).toContain("get_device_recent_orders(\n  p_limit integer default 25,");
    expect(body()).not.toContain("p_project_id");
  });

  it("resolves the project from paired_devices and nowhere else", () => {
    const b = body();

    expect(b).toContain("select d.project_id into v_project_id");
    expect(b).toContain("from public.paired_devices d");
    expect(b).toContain("where d.auth_user_id = v_caller");
    expect(b).toContain("where o.project_id = v_project_id");
  });

  it("requires an ACTIVE pairing — the Feature 25.1 rule", () => {
    const b = body();

    expect(b).toContain("and d.revoked_at is null");
    expect(b).toContain("and d.unpaired_at is null");
  });

  it("refuses an unauthenticated caller before touching anything", () => {
    const b = body();
    const auth = b.indexOf("if v_caller is null then");
    const query = b.indexOf("from public.orders o");

    expect(auth).toBeGreaterThan(-1);
    expect(auth).toBeLessThan(query);
    expect(b).toContain("'error', 'not_authenticated'");
    expect(b).toContain("'error', 'not_paired'");
  });
});

describe("the page is bounded and deterministically ordered", () => {
  it("clamps the limit server-side, including a null", () => {
    expect(body()).toContain("least(greatest(coalesce(p_limit, 25), 1), 50)");
  });

  it("orders by created_at DESC then id DESC", () => {
    const b = body();

    expect(b).toContain("order by o.created_at desc, o.id desc");
  });

  it("paginates on BOTH cursor components as a row comparison", () => {
    // created_at alone cannot separate two orders written in the same instant,
    // so a timestamp-only predicate skips or repeats rows.
    expect(body()).toContain("(o.created_at, o.id) < (p_before_created_at, p_before_id)");
  });

  it("REJECTS a half cursor rather than normalising it", () => {
    const b = body();

    expect(b).toContain("if (p_before_created_at is null) <> (p_before_id is null) then");
    expect(b).toContain("'error', 'invalid_cursor'");
  });

  it("returns a cursor carrying both halves", () => {
    const b = body();

    expect(b).toContain("'createdAt'");
    expect(b).toContain("'id',");
    expect(b).toContain("'nextCursor'");
  });
});

describe("the payload says only what a receipt needs", () => {
  it("returns the receipt contract plus occurredAt and source", () => {
    const b = body();

    for (const field of [
      "'orderId'", "'orderNumber'", "'paymentMethod'", "'subtotal'",
      "'taxAmount'", "'tipAmount'", "'total'", "'createdAt'",
      "'occurredAt'", "'source'", "'items'",
      "'itemId'", "'itemName'", "'unitPrice'", "'quantity'", "'lineTotal'", "'modifiers'",
    ]) {
      expect(`payload contains ${field}`).toBe(`payload contains ${field}`);
      expect(b).toContain(field);
    }
  });

  it("leaks no owner or internal field", () => {
    const b = body();

    for (const forbidden of ["'userId'", "'projectId'", "'saleRequestHash'", "'numberSource'", "'saleRequestId'"]) {
      expect(b).not.toContain(forbidden);
    }
    // The project id is used as a predicate, never emitted.
    expect(b).not.toContain("'project_id', o.project_id");
    expect(b).not.toContain("o.user_id");
  });

  it("omits inventory shortfall — an owner signal, not a cashier one", () => {
    expect(body()).not.toContain("inventory_shortfall");
    expect(body()).not.toContain("hasInventoryShortfall");
  });

  it("formats money exactly as the sale contract does", () => {
    // Same ::text on numeric(12,2), so a history receipt cannot disagree with
    // the one the till printed.
    expect(body()).toContain("o.subtotal::text");
    expect(body()).toContain("oi.unit_price::text");
  });
});

describe("privileges and blast radius", () => {
  it("is definer, stable, and search_path pinned", () => {
    const b = body();

    expect(b).toContain("security definer");
    expect(b).toContain("stable");
    expect(b).toContain("set search_path = public, pg_temp");
  });

  it("is granted to authenticated only", () => {
    const s = sql();

    expect(s).toContain("from anon;");
    expect(s).toContain("from service_role;");
    expect(s).toContain("grant execute on function public.get_device_recent_orders(integer, timestamptz, uuid) to authenticated;");
  });

  it("writes nothing at all", () => {
    const b = body();

    for (const write of ["insert into", "update public.", "delete from", "last_seen_at ="]) {
      expect(b).not.toContain(write);
    }
  });

  it("changes no RLS policy and no existing function", () => {
    const s = sql();

    expect(s).not.toContain("create policy");
    expect(s).not.toContain("drop policy");
    expect(s).not.toContain("alter table");
    expect(s).not.toContain("create or replace function public.complete_sale");
    expect(s).not.toContain("resolve_sale_owner");
  });

  it("adds an index matching project_id + created_at + id, and no column", () => {
    const s = sql();

    expect(s).toContain("on public.orders (project_id, created_at desc, id desc)");
    expect(s).not.toContain("add column");
  });

  it("leaves complete_sale_v4 untouched", () => {
    const v4 = read(V4);

    expect(v4).toContain("if v_occurred_at >= v_device_revoked_at then");
    expect(v4).not.toContain("get_device_recent_orders");
  });
});

describe("no destructive behaviour is introduced", () => {
  it("offers no delete, void or refund anywhere", () => {
    for (const file of [MIGRATION, RPC_CLIENT, MODEL]) {
      const source = read(file);

      for (const forbidden of ["delete from public.orders", "voidOrder", "refund", "deleteOrder"]) {
        expect(`${file}: ${forbidden}`).toBe(`${file}: ${forbidden}`);
        expect(source.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    }
  });

  it("history is reachable from exactly one client adapter", () => {
    const client = read(RPC_CLIENT);

    expect(client).toContain('rpc("get_device_recent_orders"');
    // The pure model never touches a network.
    expect(read(MODEL)).not.toContain("supabase");
    expect(read(MODEL)).not.toContain("rpc(");
  });

  it("the client never builds half a cursor", () => {
    const client = read(RPC_CLIENT);

    expect(client).toContain("p_before_created_at: cursor?.createdAt ?? null");
    expect(client).toContain("p_before_id: cursor?.id ?? null");
  });
});
