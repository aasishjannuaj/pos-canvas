// Milestone 24, Feature 24.5B — static guards for the offline sale contract.
//
// These assert the SQL text and structure, following the convention every
// migration in this directory uses. They cannot execute the migration; what
// they protect is that it still SAYS what it must — which for a money function
// is most of the risk, because the dangerous failure mode is an authorization
// or a bound quietly disappearing during a rewrite.
//
// The central worry this file answers: complete_sale_v4 was produced from
// complete_sale_v3's audited body by targeted replacement, and v4 deliberately
// RELAXES one thing v3 enforced — it resolves a revoked device instead of
// refusing it outright. Everything below exists to prove that relaxation is
// bounded to the two cases the owner approved, and that nothing else moved.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function load(file: string): string {
  return readFileSync(join(here, file), "utf-8");
}

/** SQL with `--` comment lines stripped, so prose never satisfies a guard. */
function executable(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");
}

const migration = load("20260819120000_offline_sale_contract_and_complete_sale_v4.sql");
const v3Migration = load("20260810120000_modifier_contract_and_complete_sale_v3.sql");

const sql = executable(migration);
const v3Sql = executable(v3Migration);

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`create or replace function public.${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("$function$;", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

const v4 = functionBody(sql, "complete_sale_v4");
const v3 = functionBody(v3Sql, "complete_sale_v3");

// ---------------------------------------------------------------------------
// Atomicity and safety
// ---------------------------------------------------------------------------

describe("the migration is atomic and additive", () => {
  it("is wrapped in an explicit transaction", () => {
    const statements = sql
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");

    expect(statements[0]).toBe("begin;");
    expect(statements[statements.length - 1]).toBe("commit;");
  });

  it("adds columns and never drops or rewrites one", () => {
    for (const destructive of [
      "drop table",
      "drop column",
      "drop function public.complete_sale_v3",
      "truncate",
      "delete from public.orders",
    ]) {
      expect(`migration contains: ${destructive}`).toBe(`migration contains: ${destructive}`);
      expect(sql).not.toContain(destructive);
    }
  });

  it("uses add column if not exists throughout, so a rerun is safe", () => {
    const adds = sql.match(/alter table public\.\w+\s+add column/g) ?? [];
    const guarded = sql.match(/add column if not exists/g) ?? [];

    expect(adds.length).toBeGreaterThan(0);
    expect(guarded.length).toBe(adds.length);
  });

  it("contains no CONCURRENTLY or other transaction-unsafe statement", () => {
    for (const unsafe of ["concurrently", "vacuum", "alter type"]) {
      expect(`migration contains: ${unsafe}`).toBe(`migration contains: ${unsafe}`);
      expect(sql.toLowerCase()).not.toContain(unsafe);
    }
  });

  it("ends with a verification block that fails loudly", () => {
    expect(sql).toContain("raise exception 'complete_sale_v3 disappeared'");
    expect(sql).toContain("raise exception 'complete_sale_v4 was not created'");
    expect(sql).toContain("raise exception 'orders.occurred_at was not fully backfilled'");
  });
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("the schema additions", () => {
  it("adds occurred_at and backfills it from created_at", () => {
    expect(sql).toContain("add column if not exists occurred_at timestamptz");
    expect(sql).toContain(
      "update public.orders set occurred_at = created_at where occurred_at is null"
    );
    expect(sql).toContain("alter column occurred_at set not null");
  });

  it("leaves created_at completely alone", () => {
    // created_at remains the server's record of when the row was committed.
    expect(sql).not.toContain("alter column created_at");
    expect(sql).not.toContain("drop default");
    expect(v4).not.toContain("created_at =");
  });

  it("adds source as a CHECKED text column, not an enum", () => {
    // ALTER TYPE ... ADD VALUE cannot run in a transaction, which would break
    // this migration's atomicity and every future one that adds a source.
    expect(sql).toContain("add column if not exists source text not null default 'online'");
    expect(sql).toContain("orders_source_check");
    expect(sql).toContain("array['online'::text, 'offline_queued'::text]");
    expect(sql).not.toContain("create type");
  });

  it("backfills historical rows as online", () => {
    // The default does the backfill: every pre-existing order was made online.
    expect(sql).toContain("source text not null default 'online'");
  });

  it("records the shortfall per line, bounded by the quantity sold", () => {
    expect(sql).toContain("add column if not exists inventory_shortfall integer not null default 0");
    expect(sql).toContain("inventory_shortfall >= 0 and inventory_shortfall <= quantity");
  });

  it("adds an order-level flag and an index to find it", () => {
    expect(sql).toContain("add column if not exists has_inventory_shortfall boolean not null default false");
    expect(sql).toContain("orders_inventory_shortfall_idx");
  });
});

// ---------------------------------------------------------------------------
// v3 is untouched
// ---------------------------------------------------------------------------

describe("complete_sale_v3 survives unchanged", () => {
  it("this migration never redefines v3", () => {
    expect(sql).not.toContain("create or replace function public.complete_sale_v3");
    expect(sql).not.toContain("drop function public.complete_sale_v3");
  });

  it("v3 still exists in its own migration, unedited", () => {
    // If v4's construction had been done by editing v3 in place, this anchor
    // and the ones below would have moved with it.
    expect(v3).toContain("v_owner_id := public.resolve_sale_owner(p_project_id)");
    expect(v3).toContain("and d.revoked_at is null");
    expect(v3).toContain("raise exception 'Insufficient inventory for %', v_item_name");
  });

  it("v3 knows nothing about the new contract", () => {
    for (const added of ["p_occurred_at", "p_source", "offline_queued", "inventory_shortfall"]) {
      expect(`v3 contains ${added}`).toBe(`v3 contains ${added}`);
      expect(v3).not.toContain(added);
    }
  });
});

// ---------------------------------------------------------------------------
// v4 signature, grants, source
// ---------------------------------------------------------------------------

describe("complete_sale_v4's shape", () => {
  it("extends v3's signature with two defaulted parameters", () => {
    expect(v4).toContain("p_occurred_at timestamptz default null");
    expect(v4).toContain("p_source text default 'online'");

    for (const carried of [
      "p_project_id uuid",
      "p_payment_method text",
      "p_tip_amount numeric",
      "p_items jsonb",
      "p_sale_request_id uuid",
    ]) {
      expect(`v4 signature missing ${carried}`).toBe(`v4 signature missing ${carried}`);
      expect(v4).toContain(carried);
    }
  });

  it("keeps v3's security posture exactly", () => {
    expect(v4).toContain("security definer");
    expect(v4).toContain("set search_path to public, pg_temp");

    const grants = "complete_sale_v4(uuid, text, numeric, jsonb, uuid, timestamptz, text)";

    expect(sql).toContain(`revoke all on function public.${grants} from public`);
    expect(sql).toContain(`revoke all on function public.${grants} from anon`);
    expect(sql).toContain(`revoke all on function public.${grants} from service_role`);
    expect(sql).toContain(`grant execute on function public.${grants} to authenticated`);
  });

  it("validates source against a closed set before anything reads it", () => {
    expect(v4).toContain("v_sale_source not in ('online', 'offline_queued')");
    expect(v4).toContain("raise exception 'Invalid sale source'");

    const check = v4.indexOf("v_sale_source not in");
    const auth = v4.indexOf("select p.user_id into v_owner_id");

    expect(check).toBeLessThan(auth);
  });

  it("refuses an owner claiming offline semantics", () => {
    // Otherwise an owner would have a path that skips the inventory rejection
    // every online sale is subject to.
    expect(v4).toContain("if v_is_owner and v_sale_source <> 'online' then");
    expect(v4).toContain("raise exception 'Only a paired device can record an offline sale'");
  });
});

// ---------------------------------------------------------------------------
// occurred_at validation
// ---------------------------------------------------------------------------

describe("the device clock is validated, never trusted", () => {
  it("an online sale may not declare its own time", () => {
    expect(v4).toContain("raise exception 'An online sale cannot declare its own sale time'");
    expect(v4).toContain("v_occurred_at := now();");
  });

  it("an offline sale must declare one", () => {
    expect(v4).toContain("raise exception 'An offline sale must declare when it happened'");
  });

  it("refuses a future time beyond a documented skew allowance", () => {
    expect(v4).toContain("c_clock_skew     constant interval := interval '5 minutes'");
    expect(v4).toContain("if p_occurred_at > now() + c_clock_skew then");
    expect(v4).toContain("raise exception 'Offline sale time is in the future'");
  });

  it("refuses a time predating the device's own pairing", () => {
    // paired_devices.created_at is a SERVER timestamp, so this floor cannot be
    // moved by the device. It is the principled bound on backdating.
    expect(v4).toContain("p_occurred_at < v_device_paired_at - c_clock_skew");
    expect(v4).toContain("raise exception 'Offline sale time predates this device'");
  });

  it("stores the validated value, never the raw parameter", () => {
    expect(v4).toContain("v_occurred_at, v_sale_source, v_has_shortfall");
    expect(v4).not.toContain("p_occurred_at, v_sale_source");
  });

  it("keeps occurred_at OUT of the idempotency hash", () => {
    // A retry whose clock moved a few seconds must be the SAME sale, not a
    // hash conflict. The canonical preimage must not mention it.
    const preimage = v4.slice(v4.indexOf("v_canonical :="), v4.indexOf("v_hash :="));

    expect(preimage).not.toContain("occurred");
    expect(preimage).not.toContain("source");
  });
});

// ---------------------------------------------------------------------------
// Idempotency and revocation
// ---------------------------------------------------------------------------

describe("replay and revocation", () => {
  it("the idempotency lookup still precedes every side effect", () => {
    const lookup = v4.indexOf("where o.project_id = p_project_id");
    const counter = v4.indexOf("insert into public.project_order_counters");
    const insert = v4.indexOf("insert into public.orders (");
    const inventory = v4.indexOf("insert into public.inventory_transactions");

    expect(lookup).toBeGreaterThan(-1);
    expect(counter).toBeGreaterThan(lookup);
    expect(insert).toBeGreaterThan(lookup);
    expect(inventory).toBeGreaterThan(lookup);
  });

  it("a replay returns before occurred_at or revocation is ever considered", () => {
    // THE POINT OF THE RESTRUCTURE: a sale committed while the device was still
    // authorized must replay successfully after the owner revokes it.
    const lookup = v4.indexOf("v_order_id := v_existing.id;");
    const clock = v4.indexOf("if v_sale_source = 'online' then");
    const revocation = v4.indexOf("if not v_is_owner and v_device_revoked_at is not null then");

    expect(lookup).toBeGreaterThan(-1);
    expect(clock).toBeGreaterThan(lookup);
    expect(revocation).toBeGreaterThan(lookup);
  });

  it("a hash conflict is still rejected", () => {
    expect(v4).toContain(
      "raise exception 'Sale request ID was already used for a different order'"
    );
  });

  it("resolves the device without the revoked filter, and says why", () => {
    expect(v4).toContain("from public.paired_devices d");
    expect(v4).toContain("into v_owner_id, v_build_job_id, v_device_revoked_at, v_device_paired_at");

    // The relaxation is bounded: an UNPAIRED caller is still refused outright.
    expect(v4).toContain("raise exception 'Project not found or access denied'");
    expect(v4).not.toContain("v_owner_id := public.resolve_sale_owner(p_project_id)");
  });

  it("a revoked device gets no new ONLINE sale", () => {
    const window = v4.slice(v4.indexOf("if not v_is_owner and v_device_revoked_at is not null then"));

    expect(window).toContain("if v_sale_source <> 'offline_queued' then");
    expect(window).toContain("raise exception 'Project not found or access denied'");
  });

  it("an offline sale before revocation is recorded and after it is refused", () => {
    expect(v4).toContain("if v_occurred_at >= v_device_revoked_at then");
    expect(v4).toContain(
      "raise exception 'Offline sale occurred after this device was revoked'"
    );
  });

  it("the revocation comparison uses the validated time, not the parameter", () => {
    const compare = v4.indexOf("if v_occurred_at >= v_device_revoked_at then");
    const validated = v4.indexOf("v_occurred_at := p_occurred_at;");

    expect(validated).toBeGreaterThan(-1);
    expect(compare).toBeGreaterThan(validated);
  });
});

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

describe("pricing authority is unchanged", () => {
  it("a device still prices from its pinned immutable build", () => {
    expect(v4).toContain("select b.config_snapshot into v_source");
    expect(v4).toContain("where b.id = v_build_job_id");
    expect(v4).toContain("and b.status = 'succeeded'");
  });

  it("source never reaches the pricing branch", () => {
    // source participates in validation and audit. It must not change a price.
    const pricing = v4.slice(
      v4.indexOf("7. New sale. Resolve the authorized pricing source."),
      v4.indexOf("9. Order-level money")
    );

    expect(pricing).not.toContain("v_sale_source");
  });

  it("the client still supplies identifiers and quantities only", () => {
    // Scoped to the section that CONSUMES p_items. 'unitPrice' and 'lineTotal'
    // legitimately appear later as RESPONSE field names — v3 returns them too —
    // so a whole-function search would have banned the output for the input's
    // sake.
    // Sliced on CODE anchors: the section headings are comments, and
    // executable() strips those.
    const normalize = v4.slice(
      v4.indexOf("for v_item in select value from jsonb_array_elements(p_items)"),
      v4.indexOf("select o.id, o.sale_request_hash into v_existing")
    );

    expect(normalize.length).toBeGreaterThan(200);

    for (const clientPrice of ["price", "unit_price", "total", "amount"]) {
      expect(`normalization reads ${clientPrice}`).toBe(`normalization reads ${clientPrice}`);
      expect(normalize).not.toContain(`'${clientPrice}'`);
    }

    // What it DOES read from the request: identifiers and a quantity.
    expect(normalize).toContain("v_item ->> 'itemId'");
    expect(normalize).toContain("v_item ->> 'quantity'");
  });

  it("tax, modifiers and money bounds are carried over from v3", () => {
    for (const carried of [
      "c_max_money      constant numeric := 9999999999.99",
      "v_tax_inclusive",
      "v_mod_snapshot",
      "raise exception 'Tips are not supported on this device'",
    ]) {
      expect(`v4 missing ${carried}`).toBe(`v4 missing ${carried}`);
      expect(v4).toContain(carried);
    }
  });

  it("payment methods are still exactly cash and card", () => {
    expect(v4).toContain("v_method");
    for (const banned of ["pan", "cvv", "card_number", "gateway", "authorize"]) {
      expect(`v4 mentions ${banned}`).toBe(`v4 mentions ${banned}`);
      expect(v4.toLowerCase()).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

describe("inventory", () => {
  it("an ONLINE sale still hard-rejects insufficient stock", () => {
    expect(v4).toContain("if v_sale_source <> 'offline_queued' then");
    expect(v4).toContain("raise exception 'Insufficient inventory for %', v_item_name");
  });

  it("an OFFLINE sale floors stock at 0 instead of vanishing", () => {
    expect(v4).toContain("v_shortfall := v_quantity - v_stock_before;");
    expect(v4).toContain("v_has_shortfall := true;");
    expect(v4).toContain("v_stock_after := 0;");
  });

  it("stock is still taken from the LIVE locked config, not the pinned build", () => {
    // Asserted as CODE, not as the comment above it: executable() strips
    // comments precisely so prose cannot satisfy a guard.
    expect(v4).toContain("v_live_items := coalesce(v_config -> 'menuItems', '[]'::jsonb)");
    expect(v4).toContain("v_live_item := v_live_items -> v_live_index;");
    expect(v4).toContain("(v_live_item ->> 'stockQuantity')::numeric");

    // And the prices still come from the pinned snapshot, which is a different
    // variable entirely.
    expect(v4).toContain("v_price_items := coalesce(v_source -> 'menuItems', '[]'::jsonb)");
  });

  it("the audit row records the ACTUAL decrement, not the requested quantity", () => {
    // inventory_transactions carries quantity_after = quantity_before +
    // quantity_change. Once stock can floor, the requested quantity would
    // violate it.
    expect(v4).toContain(
      "-((line ->> 'stock_before')::integer - (line ->> 'stock_after')::integer)"
    );
    expect(v4).not.toContain("-(line ->> 'quantity')::integer,");
  });

  it("writes no audit row when nothing actually moved", () => {
    expect(v4).toContain(
      "and (line ->> 'stock_before')::integer <> (line ->> 'stock_after')::integer"
    );
  });

  it("the shortfall reaches the line it belongs to", () => {
    expect(v4).toContain("coalesce((line ->> 'shortfall')::integer, 0)");
  });

  it("inventory is only ever mutated on the new-sale path", () => {
    expect(v4).toContain("if not exists (\n      select 1 from public.order_items oi where oi.order_id = v_order_id\n    ) then");
  });
});

// ---------------------------------------------------------------------------
// Order numbers and payload
// ---------------------------------------------------------------------------

describe("order numbers and the response", () => {
  it("the counter system is untouched", () => {
    expect(v4).toContain("insert into public.project_order_counters (project_id, last_number)");
    expect(v4).toContain("set last_number = last_number + 1");
    expect(v4).toContain("v_order_number := v_prefix || v_suffix::text;");
    expect(v4).toContain("'server', p_sale_request_id, v_hash");
  });

  it("no receipt number is preallocated or client-supplied", () => {
    for (const banned of ["p_order_number", "preallocat", "reserve_order_number"]) {
      expect(`v4 mentions ${banned}`).toBe(`v4 mentions ${banned}`);
      expect(v4).not.toContain(banned);
    }
  });

  it("the payload is additive — nothing v3 returned was renamed", () => {
    for (const field of [
      "'orderId'",
      "'orderNumber'",
      "'paymentMethod'",
      "'subtotal'",
      "'taxAmount'",
      "'tipAmount'",
      "'total'",
      "'createdAt'",
      "'items'",
    ]) {
      expect(`payload missing ${field}`).toBe(`payload missing ${field}`);
      expect(v4).toContain(field);
      expect(v3).toContain(field);
    }
  });

  it("the payload gains exactly what offline handling needs", () => {
    expect(v4).toContain("'occurredAt'");
    expect(v4).toContain("'source', o.source");
    expect(v4).toContain("'hasInventoryShortfall', o.has_inventory_shortfall");
    expect(v4).toContain("'inventoryShortfall', coalesce(oi.inventory_shortfall, 0)");
  });

  it("still leaks no internal identifier", () => {
    const payload = v4.slice(v4.indexOf("select jsonb_build_object("));

    for (const secret of ["sale_request_hash", "config_snapshot", "user_id", "build_job_id"]) {
      expect(`payload leaks ${secret}`).toBe(`payload leaks ${secret}`);
      expect(payload).not.toContain(secret);
    }
  });
});

// ---------------------------------------------------------------------------
// The offline age bound (24.5B review fix)
//
// A device paired months ago satisfies `occurred_at >= paired_at` for ANY date
// since, so the pairing floor alone let a submission created today be backdated
// months — and slid in front of a revoked_at set last week. The revocation
// window compares against occurred_at, so an unbounded past was an unbounded
// bypass of it.
//
// These tests read the interval constants OUT of the migration and do the
// boundary arithmetic against them, rather than restating the numbers. If
// someone widens c_offline_max_age, the boundaries below move with it and the
// guard that pins it to the client lease is what fails.
// ---------------------------------------------------------------------------

/** Pulls an `interval 'N unit'` constant out of the function body. */
function intervalMs(name: string): number {
  const match = v4.match(new RegExp(`${name}\\s+constant interval := interval '([^']+)'`));

  expect(match).not.toBeNull();

  const [, literal] = match as RegExpMatchArray;
  const [amount, unit] = literal.split(/\s+/);
  const scale: Record<string, number> = {
    minute: 60_000,
    minutes: 60_000,
    hour: 3_600_000,
    hours: 3_600_000,
    day: 86_400_000,
    days: 86_400_000,
  };

  expect(scale[unit]).toBeDefined();

  return Number(amount) * scale[unit];
}

const MAX_AGE_MS = intervalMs("c_offline_max_age");
const SKEW_MS = intervalMs("c_clock_skew");

/**
 * The rule as the SQL states it, evaluated for a given age.
 *
 * Deliberately expressed from the SAME three comparisons the function runs, in
 * the same direction, so this is a reading of the migration rather than a
 * second implementation of it.
 */
function offlineSaleAccepted(input: {
  occurredAt: number;
  now: number;
  pairedAt: number;
}): boolean {
  if (input.occurredAt > input.now + SKEW_MS) return false;
  if (input.occurredAt < input.pairedAt - SKEW_MS) return false;
  if (input.occurredAt < input.now - MAX_AGE_MS - SKEW_MS) return false;

  return true;
}

describe("a new offline sale is bounded by the 7-day lease", () => {
  const NOW = Date.parse("2026-08-19T12:00:00.000Z");
  const DAY = 86_400_000;
  // Paired well before every date exercised below, so the pairing floor is
  // never the reason a case is rejected — the age bound has to be.
  const PAIRED_LONG_AGO = NOW - 400 * DAY;

  it("the server bound is the SAME 7 days as the client lease", () => {
    // OFFLINE_DEVICE_LEASE_MS in lib/deviceOfflineCache.ts. If these ever
    // disagree, one half of the owner-approved policy is unenforced.
    expect(MAX_AGE_MS).toBe(7 * DAY);
    expect(SKEW_MS).toBe(5 * 60_000);
  });

  it("a six-day-old offline sale succeeds", () => {
    expect(
      offlineSaleAccepted({ occurredAt: NOW - 6 * DAY, now: NOW, pairedAt: PAIRED_LONG_AGO })
    ).toBe(true);
  });

  it("a sale just inside the seven-day boundary succeeds", () => {
    expect(
      offlineSaleAccepted({
        occurredAt: NOW - MAX_AGE_MS + 1,
        now: NOW,
        pairedAt: PAIRED_LONG_AGO,
      })
    ).toBe(true);
  });

  it("the tolerance band around the boundary is still accepted", () => {
    // Exactly 7 days plus a minute of drift is inside the allowance.
    expect(
      offlineSaleAccepted({
        occurredAt: NOW - MAX_AGE_MS - 60_000,
        now: NOW,
        pairedAt: PAIRED_LONG_AGO,
      })
    ).toBe(true);
  });

  it("a sale older than seven days plus tolerance is rejected", () => {
    expect(
      offlineSaleAccepted({
        occurredAt: NOW - MAX_AGE_MS - SKEW_MS - 1,
        now: NOW,
        pairedAt: PAIRED_LONG_AGO,
      })
    ).toBe(false);
  });

  it("a device paired months ago still cannot submit a months-old sale", () => {
    // THE REVIEW FINDING. The pairing floor passes for every one of these.
    for (const days of [8, 30, 90, 200]) {
      const occurredAt = NOW - days * DAY;

      expect(`${days} days old passes the pairing floor`).toBe(
        `${days} days old passes the pairing floor`
      );
      expect(occurredAt).toBeGreaterThan(PAIRED_LONG_AGO);
      expect(offlineSaleAccepted({ occurredAt, now: NOW, pairedAt: PAIRED_LONG_AGO })).toBe(false);
    }
  });

  it("backdating cannot reach in front of a later revocation", () => {
    // A revocation set 14 days ago is now unreachable: anything early enough to
    // precede it is already outside the age bound, so 6c can never be satisfied
    // by a backdated submission.
    const revokedAt = NOW - 14 * DAY;
    const reachable = [15, 20, 60, 200]
      .map((days) => NOW - days * DAY)
      .filter((occurredAt) => occurredAt < revokedAt)
      .filter((occurredAt) =>
        offlineSaleAccepted({ occurredAt, now: NOW, pairedAt: PAIRED_LONG_AGO })
      );

    expect(reachable).toEqual([]);
  });

  it("the future bound is unchanged", () => {
    expect(
      offlineSaleAccepted({ occurredAt: NOW + SKEW_MS + 1, now: NOW, pairedAt: PAIRED_LONG_AGO })
    ).toBe(false);
    expect(
      offlineSaleAccepted({ occurredAt: NOW + 60_000, now: NOW, pairedAt: PAIRED_LONG_AGO })
    ).toBe(true);
  });

  it("the pairing floor still applies independently of the age bound", () => {
    // A recently paired device cannot claim a sale from before it existed, even
    // though that date is comfortably inside seven days.
    const pairedYesterday = NOW - DAY;

    expect(
      offlineSaleAccepted({ occurredAt: NOW - 3 * DAY, now: NOW, pairedAt: pairedYesterday })
    ).toBe(false);
  });
});

describe("the age bound is written into the SQL, and only for new sales", () => {
  it("rejects rather than clamping", () => {
    // Clamping would write a sale time nobody reported, to make a validation
    // pass — the exact rewriting of history this contract prevents.
    expect(v4).toContain("if p_occurred_at < now() - c_offline_max_age - c_clock_skew then");
    expect(v4).toContain(
      "raise exception 'Offline sale time is older than the offline limit'"
    );
    expect(v4).not.toContain("v_occurred_at := now() - c_offline_max_age");
    expect(v4).not.toContain("greatest(p_occurred_at");
  });

  it("all three temporal bounds sit AFTER the replay return", () => {
    // THE IDEMPOTENCY RULE. An already-committed sale must replay even when it
    // is now older than seven days, or the device has since been revoked, or
    // the clock has moved far beyond the original sale.
    const replay = v4.indexOf("v_order_id := v_existing.id;");

    for (const bound of [
      "if p_occurred_at > now() + c_clock_skew",
      "p_occurred_at < v_device_paired_at - c_clock_skew",
      "p_occurred_at < now() - c_offline_max_age - c_clock_skew",
      "if not v_is_owner and v_device_revoked_at is not null then",
    ]) {
      expect(`bound before replay: ${bound}`).toBe(`bound before replay: ${bound}`);
      expect(v4.indexOf(bound)).toBeGreaterThan(replay);
    }
  });

  it("a replay allocates no counter and mutates no inventory", () => {
    const replay = v4.indexOf("v_order_id := v_existing.id;");

    for (const sideEffect of [
      "insert into public.project_order_counters",
      "insert into public.orders (",
      "insert into public.order_items (",
      "insert into public.inventory_transactions",
      "update public.projects",
    ]) {
      expect(`side effect before replay: ${sideEffect}`).toBe(
        `side effect before replay: ${sideEffect}`
      );
      expect(v4.indexOf(sideEffect)).toBeGreaterThan(replay);
    }
  });

  it("the age bound never applies to an online sale", () => {
    const onlineBranch = v4.slice(
      v4.indexOf("if v_sale_source = 'online' then"),
      v4.indexOf("else\n      ")
    );

    expect(onlineBranch).not.toContain("c_offline_max_age");
  });
});
