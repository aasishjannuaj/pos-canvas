-- Milestone 28 — Receipt Fidelity.
--
-- ----------------------------------------------------------------------------
-- WHAT WAS WRONG
-- ----------------------------------------------------------------------------
-- Every money value on a receipt was already frozen: item_name, unit_price,
-- quantity, line_total, the modifier name/price snapshot, subtotal, tax, tip,
-- total and payment_method are all persisted at sale time and replayed. Nothing
-- in this migration changes any of them, and no figure is recomputed anywhere.
--
-- What was NOT frozen was everything printed AROUND those numbers, and the
-- order the lines came back in:
--
--   1. The business name, address, contact lines, header, footer, currency and
--      the show/hide toggles were read from TODAY'S configuration. Editing them
--      re-headed every receipt already issued; on a paired till, Feature 26's
--      Apply Update moved the pinned build and did the same thing.
--
--   2. order_items had no line ordinal, and the payload ordered by item_id.
--      Two lines of the same product with different options tie on that key, so
--      their relative order was whatever the planner chose — the slip handed to
--      the customer and the reprint could list the same sale differently.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES
-- ----------------------------------------------------------------------------
--   1. orders.receipt_snapshot      — the sale-time businessProfile + receipt
--                                     settings, for OWNER sales only.
--   2. order_items.line_position    — the position this line held in the cart.
--   3. complete_sale, _v2, _v3, _v4 — write both. Each body below is the
--      CURRENT deployed definition (as replaced by Feature 26.1) with only the
--      tokens those two columns need. No pricing, validation, locking, hashing,
--      ordering, inventory or idempotency logic is touched.
--   4. get_device_recent_orders     — returns the sale-time presentation and
--      the deterministic line order.
--
-- ----------------------------------------------------------------------------
-- WHY DEVICE SALES GET NO receipt_snapshot
-- ----------------------------------------------------------------------------
-- Because they already have one. Feature 26.1 records orders.build_job_id, and
-- build_jobs.config_snapshot is immutable and carries the same businessProfile
-- and receipt objects; ON DELETE NO ACTION guarantees that build still exists
-- for as long as the order does. A second copy would be a second answer to one
-- question, and the two would eventually disagree. Owner sales price from live
-- project config, no build prices them, and so they are the only case with
-- nothing to point at.
--
-- ----------------------------------------------------------------------------
-- MIGRATION DEPENDENCY — READ BEFORE DEPLOYING
-- ----------------------------------------------------------------------------
-- This migration REQUIRES 20260831120000_device_config_update_offer.sql
-- (Feature 26.1), which created orders.build_job_id and last replaced all four
-- complete_sale* functions. The bodies below are built from that file's
-- definitions, and get_device_recent_orders reads orders.build_job_id directly.
-- 26.1 is applied to staging and is STILL OUTSTANDING IN PRODUCTION. This
-- migration must not reach production before it.
--
-- ----------------------------------------------------------------------------
-- SAFE FOR EXISTING ROWS
-- ----------------------------------------------------------------------------
-- Both columns are nullable with no default and no backfill. A sale taken
-- before this migration has no recorded presentation and no recorded cart
-- order, and neither is recoverable — so neither is invented. Those rows read
-- as null and the client falls back explicitly. The one CHECK added is NOT
-- VALID, so no existing row is scanned and no table is rewritten.
--
-- ----------------------------------------------------------------------------
-- NO PRIVILEGE CHANGE
-- ----------------------------------------------------------------------------
-- Every function keeps its exact signature, so CREATE OR REPLACE preserves the
-- existing ACL. No grant or revoke is issued, no SECURITY DEFINER posture
-- changes, and no search_path is touched.
--
-- ----------------------------------------------------------------------------
-- ATOMICITY
-- ----------------------------------------------------------------------------
-- One explicit transaction, with the verification block last: a failure must
-- not leave the database carrying new columns and half the functions. Every
-- statement here is transaction-safe.
-- ----------------------------------------------------------------------------

begin;

-- ----------------------------------------------------------------------------
-- 1. Columns.
-- ----------------------------------------------------------------------------
alter table public.orders
  add column if not exists receipt_snapshot jsonb;

comment on column public.orders.receipt_snapshot is
  'Feature 28C — {businessProfile, receipt} as configured when this sale was '
  'taken, so a reprint is not re-headed by today''s configuration. Written for '
  'OWNER sales only: a device sale records build_job_id instead, and that '
  'build''s immutable config_snapshot holds the same two objects. Null on every '
  'device sale and on every order predating this column. Never backfilled — the '
  'configuration in force at the time was not recorded before now.';

alter table public.order_items
  add column if not exists line_position integer;

comment on column public.order_items.line_position is
  'Feature 28C — 1-based position of this line in the cart that was rung up. '
  'Null on every row predating this column, where the cart order was never '
  'recorded and cannot be derived: order_items.id is a random uuid and '
  'created_at is identical across the single INSERT that writes an order. Those '
  'rows fall back to (item_id, id), which is deterministic but is not the cart '
  'order and is not presented as one.';

-- NOT VALID: pins the contract for every new row without scanning the existing
-- ones, which are all null and would pass anyway. No rewrite, no long lock.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'order_items_line_position_check'
  ) then
    alter table public.order_items
      add constraint order_items_line_position_check
      check (line_position is null or line_position > 0) not valid;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2. complete_sale, complete_sale_v2, complete_sale_v3, complete_sale_v4.
--
-- ALL FOUR, for the reason Feature 26.1 gave when it last replaced them: every
-- one inserts into public.orders, and every one is still called by shipping
-- client code (lib/orders.ts calls v1/v2/v3, lib/device.rpc.ts calls v2/v3,
-- lib/offlineSaleRpc.ts calls v4). Filling the columns on one path only would
-- produce an audit trail that is silently incomplete, where a null stops
-- meaning "before this feature" and starts meaning "maybe, depending on which
-- RPC the client happened to use".
--
-- REPLAY IS UNAFFECTED. The sale_request_id lookup returns the stored order
-- before any INSERT is reached, so a replay neither creates a row nor rewrites
-- an existing snapshot or line position. Both are written once, by the insert
-- that actually created the order.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.complete_sale(p_project_id uuid, p_order_number text, p_payment_method text, p_subtotal numeric, p_tax_amount numeric, p_tip_amount numeric, p_total numeric, p_items jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  -- numeric(12,2) ceiling. Every stored money value is checked against this.
  c_max_money      constant numeric := 9999999999.99;
  -- Per-item ceilings. Deliberately far below c_max_money so a single absurd
  -- line is rejected with a clear message rather than by an overflow error.
  c_max_unit_price constant numeric := 1000000.00;
  c_max_quantity   constant integer := 10000;
  c_max_items      constant integer := 200;
  -- stockQuantity must fit int4 with room to spare (the column is integer).
  c_max_stock      constant numeric := 1000000000;

  v_caller        uuid;
  v_owner_id      uuid;
  v_is_owner      boolean;

  v_build_job_id  uuid;
  -- Feature 28C — the business identity and receipt settings to print this
  -- sale's receipt with, frozen at sale time. Set on the OWNER branch only: a
  -- device sale already records build_job_id, whose config_snapshot is
  -- immutable and holds the same two objects, so storing a second copy would
  -- create two answers to one question.
  v_receipt_snapshot jsonb;
  v_snapshot      jsonb;

  v_config        jsonb;
  v_live_items    jsonb;
  v_price_items   jsonb;
  v_tax           jsonb;

  v_tax_enabled   boolean;
  v_tax_inclusive boolean;
  v_rate          numeric;

  v_order_id      uuid;
  v_lines         jsonb := '[]'::jsonb;

  v_cart_item     jsonb;
  v_item_id       text;
  v_qty_num       numeric;
  v_quantity      integer;
  v_price_item    jsonb;
  v_live_item     jsonb;
  v_live_index    integer;
  v_item_name     text;
  v_unit_price    numeric;
  v_line_total    numeric;

  v_track         boolean;
  v_stock_num     numeric;
  v_stock_before  integer;
  v_stock_after   integer;

  v_subtotal      numeric := 0;
  v_tax_amount    numeric := 0;
  v_tip_amount    numeric := 0;
  v_total_before_tip numeric := 0;
  v_total         numeric := 0;

  v_item_count    integer;
  v_distinct_count integer;
  i               integer;
begin
  -- ==========================================================================
  -- 1. Caller identity and request shape. Nothing here touches the database.
  -- ==========================================================================
  v_caller := auth.uid();

  if v_caller is null then
    raise exception 'Authentication required';
  end if;

  if p_project_id is null then
    raise exception 'Project ID is required';
  end if;

  if p_order_number is null or btrim(p_order_number) = '' then
    raise exception 'Order number is required';
  end if;

  if p_payment_method is null or p_payment_method not in ('cash', 'card') then
    raise exception 'Invalid payment method';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one order item is required';
  end if;

  if jsonb_array_length(p_items) > c_max_items then
    raise exception 'Too many order items';
  end if;

  -- Every element must be a JSON OBJECT. jsonb's ->> returns NULL rather than
  -- raising when applied to a scalar or an array, so a payload like
  -- [1, "x", []] would otherwise slip through to the itemId test below and be
  -- reported as a missing id rather than a malformed request.
  select count(*) into v_item_count
  from jsonb_array_elements(p_items) e
  where jsonb_typeof(e.value) <> 'object';

  if v_item_count > 0 then
    raise exception 'Invalid order item';
  end if;

  -- Every element must carry a usable itemId before the duplicate check below
  -- can mean anything (count(distinct ...) ignores nulls). btrim collapses a
  -- whitespace-only id to '', so it is rejected here too.
  select count(*) into v_item_count
  from jsonb_array_elements(p_items) e
  where coalesce(btrim(e.value ->> 'itemId'), '') = '';

  if v_item_count > 0 then
    raise exception 'Invalid order item';
  end if;

  -- Duplicate item ids are REJECTED rather than aggregated. The web client
  -- already merges repeat additions into one line (PosRuntime.addToCart), so
  -- this costs nothing real, and it is what lets each item below be priced,
  -- decremented and audited exactly once.
  select count(*), count(distinct btrim(e.value ->> 'itemId'))
  into v_item_count, v_distinct_count
  from jsonb_array_elements(p_items) e;

  if v_item_count <> v_distinct_count then
    raise exception 'The same item appears more than once in this order';
  end if;

  -- ==========================================================================
  -- 2. Authorization. The ONLY place the acting business owner is established.
  --    Raises 'Project not found or access denied' for a non-owner, an unpaired
  --    caller, a revoked device, and a device paired to a different project —
  --    all indistinguishable by design.
  -- ==========================================================================
  v_owner_id := public.resolve_sale_owner(p_project_id);

  if v_owner_id is null then
    raise exception 'Project not found or access denied';
  end if;

  v_is_owner := (v_caller = v_owner_id);

  -- ==========================================================================
  -- 3. Lock the project row. This is the single serialization point for
  --    concurrent sales, and it is taken BEFORE any price or stock is read so
  --    the whole read set is consistent.
  -- ==========================================================================
  select p.config
  into v_config
  from public.projects p
  where p.id = p_project_id
    and p.user_id = v_owner_id
  for update;

  if not found then
    raise exception 'Project not found or access denied';
  end if;

  v_live_items := coalesce(v_config -> 'menuItems', '[]'::jsonb);

  if jsonb_typeof(v_live_items) <> 'array' then
    raise exception 'Project configuration is invalid';
  end if;

  -- ==========================================================================
  -- 4. Resolve the authorized PRICING source.
  -- ==========================================================================
  if v_is_owner then
    -- Owner: the live configuration just locked above. Prices and stock come
    -- from one atomic read, so no skew between them is possible.
    v_price_items := v_live_items;
    v_tax := coalesce(v_config -> 'tax', '{}'::jsonb);
    -- Feature 28C — captured from the SAME v_config this sale is being priced
    -- from, inside the same project lock, so the header on the receipt and the
    -- prices on it can never come from two different reads.
    v_receipt_snapshot := jsonb_build_object(
      'businessProfile', coalesce(v_config -> 'businessProfile', '{}'::jsonb),
      'receipt', coalesce(v_config -> 'receipt', '{}'::jsonb)
    );
  else
    -- Device: the build id comes from the device's own pairing row. It is never
    -- a parameter, so a device cannot request another build's snapshot.
    select d.build_job_id
    into v_build_job_id
    from public.paired_devices d
    where d.auth_user_id = v_caller
      and d.project_id = p_project_id
      and d.revoked_at is null;

    if not found then
      raise exception 'Project not found or access denied';
    end if;

    select b.config_snapshot
    into v_snapshot
    from public.build_jobs b
    where b.id = v_build_job_id
      and b.project_id = p_project_id
      and b.status = 'succeeded';

    if not found then
      raise exception 'This device is not linked to a usable build';
    end if;

    v_price_items := coalesce(v_snapshot -> 'menuItems', '[]'::jsonb);
    v_tax := coalesce(v_snapshot -> 'tax', '{}'::jsonb);
  end if;

  if jsonb_typeof(v_price_items) <> 'array' then
    raise exception 'Pricing configuration is invalid';
  end if;

  -- ==========================================================================
  -- 5. Tip. A paired device may never book a tip: there is no tip-entry UI on
  --    a device, so any non-zero value is either a stale client or tampering.
  --    The owner's non-negative tip is preserved — receipt.tipsEnabled is a
  --    supported setting and removing it would be an unrelated regression.
  -- ==========================================================================
  -- SPECIAL VALUES ARE REJECTED BEFORE THE OWNER/DEVICE BRANCH, for both
  -- callers identically. A range check alone would NOT be proof of finiteness:
  -- PostgreSQL orders NaN as GREATER than every finite numeric, so `NaN > max`
  -- is true and a not-a-number tip would be misreported as "too large", while
  -- on the device branch `NaN <> 0` would misreport it as a tip that was set.
  -- See the SAFE NUMERIC PREDICATE note above the DECLARE block.
  if p_tip_amount is not null
     and p_tip_amount::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'Order amounts are not valid';
  end if;

  if v_is_owner then
    v_tip_amount := round(coalesce(p_tip_amount, 0), 2);

    if v_tip_amount < 0 then
      raise exception 'Order amounts cannot be negative';
    end if;

    if v_tip_amount > c_max_money then
      raise exception 'Order amount is too large';
    end if;
  else
    if coalesce(p_tip_amount, 0) <> 0 then
      raise exception 'Tips are not supported on this device';
    end if;

    v_tip_amount := 0;
  end if;

  -- ==========================================================================
  -- 6. Tax settings, read from the authorized pricing source. Every cast is
  --    guarded: malformed configuration must produce a controlled message, not
  --    a raw cast error.
  -- ==========================================================================
  begin
    v_tax_enabled := coalesce((v_tax ->> 'enabled')::boolean, true);
  exception
    when invalid_text_representation then
      v_tax_enabled := true;
  end;

  begin
    v_tax_inclusive := coalesce((v_tax ->> 'pricesIncludeTax')::boolean, false);
  exception
    when invalid_text_representation then
      v_tax_inclusive := false;
  end;

  begin
    v_rate := coalesce((v_tax ->> 'rate')::numeric, 0);
  exception
    when invalid_text_representation then
      v_rate := 0;
  end;

  -- DOCUMENTED FALLBACK RULE, mirroring toRuntimeSafeTax in
  -- lib/generatedPosConfig.ts: a rate that is missing, unparseable, NULL, or a
  -- special value falls back to 0; a finite rate is clamped to 0..100.
  --
  -- The special-value test MUST come before the clamp. NaN compares greater
  -- than every finite numeric in PostgreSQL, so `elsif v_rate > 100` alone
  -- would silently turn a corrupt rate into a 100% tax charge — the customer
  -- would be billed double. Falling back to 0 matches the TypeScript rule
  -- (Number.isFinite(rate) ? clamp : 0) exactly.
  if v_rate is null or v_rate::text in ('NaN', 'Infinity', '-Infinity') then
    v_rate := 0;
  elsif v_rate < 0 then
    v_rate := 0;
  elsif v_rate > 100 then
    v_rate := 100;
  end if;

  -- ==========================================================================
  -- 7. Per-item validation and server-side pricing.
  --
  --    Only `itemId` and `quantity` are read from the client. The client's
  --    `name` and `price` keys are never referenced anywhere in this function.
  -- ==========================================================================
  for v_cart_item in
    select value
    from jsonb_array_elements(p_items)
  loop
    v_item_id := btrim(v_cart_item ->> 'itemId');

    -- Quantity: a positive whole number within bounds. Parsed as numeric first
    -- so a fractional value like 1.5 is REJECTED rather than silently truncated
    -- by an ::integer cast.
    begin
      v_qty_num := (v_cart_item ->> 'quantity')::numeric;
    exception
      when invalid_text_representation then
        raise exception 'Invalid quantity for an order item';
    end;

    -- The special-value test is not redundant with the range test: NaN = NaN is
    -- TRUE for numeric, so `v_qty_num <> trunc(v_qty_num)` does NOT reject NaN,
    -- and NaN would then reach the ::integer cast below and raise a raw
    -- "cannot convert NaN to integer".
    if v_qty_num is null
       or v_qty_num::text in ('NaN', 'Infinity', '-Infinity')
       or v_qty_num <> trunc(v_qty_num)
       or v_qty_num < 1
       or v_qty_num > c_max_quantity then
      raise exception 'Invalid quantity for an order item';
    end if;

    v_quantity := v_qty_num::integer;

    -- Locate the item in the AUTHORIZED pricing source.
    v_price_item := null;

    for i in 0 .. jsonb_array_length(v_price_items) - 1
    loop
      if v_price_items -> i ->> 'id' = v_item_id then
        v_price_item := v_price_items -> i;
        exit;
      end if;
    end loop;

    -- A stale or deleted item must never be sellable. Reports the id, never a
    -- client-supplied name, so an error message cannot echo attacker input.
    if v_price_item is null then
      raise exception 'Menu item % is not available', v_item_id;
    end if;

    v_item_name := btrim(coalesce(v_price_item ->> 'name', ''));

    if v_item_name = '' then
      raise exception 'Menu item % is not available', v_item_id;
    end if;

    begin
      v_unit_price := (v_price_item ->> 'price')::numeric;
    exception
      when invalid_text_representation then
        raise exception 'Menu item % has an invalid price', v_item_id;
    end;

    -- A JSON string price of "NaN", "Infinity" or "-Infinity" casts to a valid
    -- numeric without raising, so the special-value test is what stops it —
    -- not the range test, which NaN passes by comparing greater than the bound
    -- and thus produces the wrong error.
    if v_unit_price is null
       or v_unit_price::text in ('NaN', 'Infinity', '-Infinity')
       or v_unit_price < 0
       or v_unit_price > c_max_unit_price then
      raise exception 'Menu item % has an invalid price', v_item_id;
    end if;

    v_line_total := round(v_unit_price * v_quantity, 2);

    if v_line_total is null
       or v_line_total::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'Order amount is not valid';
    end if;

    if v_line_total > c_max_money then
      raise exception 'Order amount is too large';
    end if;

    v_subtotal := v_subtotal + v_line_total;

    -- Checked inside the loop, not only at the end, so a runaway order is
    -- rejected as early as possible.
    if v_subtotal > c_max_money then
      raise exception 'Order amount is too large';
    end if;

    -- Inventory always comes from the LIVE locked config, never the snapshot.
    v_live_index := null;

    for i in 0 .. jsonb_array_length(v_live_items) - 1
    loop
      if v_live_items -> i ->> 'id' = v_item_id then
        v_live_index := i;
        exit;
      end if;
    end loop;

    -- Present in a pinned snapshot but deleted from the live project: not
    -- sellable, because its stock can no longer be tracked.
    if v_live_index is null then
      raise exception 'Menu item % is not available', v_item_id;
    end if;

    v_live_item := v_live_items -> v_live_index;

    begin
      v_track := coalesce((v_live_item ->> 'trackInventory')::boolean, false);
    exception
      when invalid_text_representation then
        raise exception 'Inventory configuration for % is invalid', v_item_id;
    end;

    v_stock_before := 0;
    v_stock_after := 0;

    if v_track then
      begin
        v_stock_num := coalesce((v_live_item ->> 'stockQuantity')::numeric, 0);
      exception
        when invalid_text_representation then
          raise exception 'Inventory configuration for % is invalid', v_item_id;
      end;

      if v_stock_num is null
         or v_stock_num::text in ('NaN', 'Infinity', '-Infinity')
         or v_stock_num <> trunc(v_stock_num)
         or v_stock_num < 0
         or v_stock_num > c_max_stock then
        raise exception 'Inventory configuration for % is invalid', v_item_id;
      end if;

      v_stock_before := v_stock_num::integer;

      if v_stock_before < v_quantity then
        raise exception 'Insufficient inventory for %', v_item_name;
      end if;

      v_stock_after := v_stock_before - v_quantity;

      v_live_items := jsonb_set(
        v_live_items,
        array[v_live_index::text, 'stockQuantity'],
        to_jsonb(v_stock_after),
        true
      );
    end if;

    -- Accumulated rather than inserted here: the order row does not exist yet,
    -- because its totals are not known until every line has been priced.
    v_lines := v_lines || jsonb_build_object(
      'item_id', v_item_id,
      'item_name', v_item_name,
      'unit_price', v_unit_price,
      'quantity', v_quantity,
      'line_total', v_line_total,
      'track', v_track,
      'stock_before', v_stock_before,
      'stock_after', v_stock_after
    );
  end loop;

  -- ==========================================================================
  -- 8. Order-level money. Recomputed entirely from the values derived above;
  --    p_subtotal, p_tax_amount and p_total are not read.
  -- ==========================================================================
  v_subtotal := round(v_subtotal, 2);

  if not v_tax_enabled then
    v_tax_amount := 0;
    v_total_before_tip := v_subtotal;
  elsif v_tax_inclusive then
    v_tax_amount := round(v_subtotal - v_subtotal / (1 + v_rate / 100), 2);
    v_total_before_tip := v_subtotal;
  else
    v_tax_amount := round(v_subtotal * v_rate / 100, 2);
    v_total_before_tip := v_subtotal + v_tax_amount;
  end if;

  if v_tax_amount < 0 then
    v_tax_amount := 0;
  end if;

  v_total := round(v_total_before_tip + v_tip_amount, 2);

  -- Final gate before any INSERT. Finiteness is asserted BEFORE the magnitude
  -- bound, because a NaN would pass the ">" test as "too large" and a NULL
  -- would pass every comparison as UNKNOWN and then hit a not-null constraint
  -- as a raw 23502. Every one of these four values is destined for a
  -- numeric(12,2) NOT NULL column.
  if v_subtotal is null
     or v_tax_amount is null
     or v_tip_amount is null
     or v_total is null
     or v_subtotal::text in ('NaN', 'Infinity', '-Infinity')
     or v_tax_amount::text in ('NaN', 'Infinity', '-Infinity')
     or v_tip_amount::text in ('NaN', 'Infinity', '-Infinity')
     or v_total::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'Order amount is not valid';
  end if;

  if v_subtotal > c_max_money
     or v_tax_amount > c_max_money
     or v_tip_amount > c_max_money
     or v_total > c_max_money then
    raise exception 'Order amount is too large';
  end if;

  if v_subtotal < 0 or v_total < 0 then
    raise exception 'Order amounts cannot be negative';
  end if;

  -- ==========================================================================
  -- 9. Atomic write. orders -> order_items -> inventory_transactions ->
  --    projects.config, all inside this one transaction. Any raise above or
  --    below rolls the whole thing back.
  -- ==========================================================================
  insert into public.orders (
    user_id,
    project_id,
    order_number,
    payment_method,
    subtotal,
    tax_amount,
    tip_amount,
    total,
    build_job_id,
    receipt_snapshot
  )
  values (
    v_owner_id,          -- the RESOLVED owner, never the caller, never a device
    p_project_id,
    p_order_number,
    p_payment_method,
    v_subtotal,
    v_tax_amount,
    v_tip_amount,
    v_total,
    v_build_job_id,
    v_receipt_snapshot
  )
  returning id into v_order_id;

  -- Exactly one row per requested item, guaranteed by the duplicate rejection.
  insert into public.order_items (
    order_id,
    item_id,
    item_name,
    unit_price,
    quantity,
    line_total,
    -- Feature 28C — the position this line held in the cart.
    line_position
  )
  select
    v_order_id,
    line ->> 'item_id',
    line ->> 'item_name',
    (line ->> 'unit_price')::numeric,
    (line ->> 'quantity')::integer,
    (line ->> 'line_total')::numeric,
    line_no::integer
  from jsonb_array_elements(v_lines) with ordinality as t(line, line_no);

  -- Exactly one row per TRACKED item, stamped with the resolved owner so a
  -- device's anonymous uid never appears in the audit trail.
  insert into public.inventory_transactions (
    user_id,
    project_id,
    order_id,
    item_id,
    item_name,
    transaction_type,
    quantity_change,
    quantity_before,
    quantity_after
  )
  select
    v_owner_id,
    p_project_id,
    v_order_id,
    line ->> 'item_id',
    line ->> 'item_name',
    'sale',
    -(line ->> 'quantity')::integer,
    (line ->> 'stock_before')::integer,
    (line ->> 'stock_after')::integer
  from jsonb_array_elements(v_lines) as line
  where (line ->> 'track')::boolean;

  update public.projects
  set config = jsonb_set(v_config, '{menuItems}', v_live_items, true),
      updated_at = now()
  where id = p_project_id
    and user_id = v_owner_id;

  if not found then
    raise exception 'Failed to update project inventory';
  end if;

  return v_order_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.complete_sale_v2(p_project_id uuid, p_payment_method text, p_tip_amount numeric, p_items jsonb, p_sale_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  c_max_money      constant numeric := 9999999999.99;
  c_max_unit_price constant numeric := 1000000.00;
  c_max_quantity   constant integer := 10000;
  c_max_items      constant integer := 200;
  c_max_stock      constant numeric := 1000000000;
  c_max_suffix     constant bigint  := 999999999999999;
  c_max_prefix_len constant integer := 32;

  v_caller        uuid;
  v_owner_id      uuid;
  v_is_owner      boolean;
  v_build_job_id  uuid;
  -- Feature 28C — the business identity and receipt settings to print this
  -- sale's receipt with, frozen at sale time. Set on the OWNER branch only: a
  -- device sale already records build_job_id, whose config_snapshot is
  -- immutable and holds the same two objects, so storing a second copy would
  -- create two answers to one question.
  v_receipt_snapshot jsonb;
  v_source        jsonb;
  v_price_items   jsonb;
  v_tax           jsonb;
  v_receipt       jsonb;

  v_config        jsonb;
  v_live_items    jsonb;

  v_method        text;
  v_tip_amount    numeric := 0;
  v_norm          jsonb := '[]'::jsonb;
  v_items_text    text;
  v_canonical     text;
  v_hash          text;

  v_order_id      uuid;
  v_existing      record;
  v_payload       jsonb;

  v_tax_enabled   boolean;
  v_tax_inclusive boolean;
  v_rate          numeric;

  v_lines         jsonb := '[]'::jsonb;
  v_item          jsonb;
  v_item_id       text;
  v_qty_num       numeric;
  v_quantity      integer;
  v_price_item    jsonb;
  v_live_item     jsonb;
  v_live_index    integer;
  v_item_name     text;
  v_unit_price    numeric;
  v_line_total    numeric;
  v_track         boolean;
  v_stock_num     numeric;
  v_stock_before  integer;
  v_stock_after   integer;

  v_subtotal      numeric := 0;
  v_tax_amount    numeric := 0;
  v_total_before_tip numeric := 0;
  v_total         numeric := 0;

  v_prefix        text;
  v_suffix        bigint;
  v_order_number  text;

  v_count         integer;
  v_distinct      integer;
  i               integer;
begin
  -- ==========================================================================
  -- 1. Caller and request shape.
  -- ==========================================================================
  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'Authentication required';
  end if;

  if p_project_id is null then
    raise exception 'Project ID is required';
  end if;

  -- A client-generated request id is mandatory. There is deliberately no
  -- server-side fallback: a generated id would make every retry look like a new
  -- sale, which is the exact failure this parameter exists to prevent. The
  -- all-zero uuid is rejected as an obvious uninitialised placeholder. Version
  -- and variant nibbles are NOT checked — any distinct uuid is a valid key, and
  -- rejecting v1/v7 ids would break clients for no security benefit.
  if p_sale_request_id is null then
    raise exception 'A sale request ID is required';
  end if;
  if p_sale_request_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception 'A sale request ID is required';
  end if;

  if p_payment_method is null or p_payment_method not in ('cash', 'card') then
    raise exception 'Invalid payment method';
  end if;
  v_method := p_payment_method;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one order item is required';
  end if;
  if jsonb_array_length(p_items) > c_max_items then
    raise exception 'Too many order items';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(p_items) e
  where jsonb_typeof(e.value) <> 'object';
  if v_count > 0 then
    raise exception 'Invalid order item';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(p_items) e
  where coalesce(btrim(e.value ->> 'itemId'), '') = '';
  if v_count > 0 then
    raise exception 'Invalid order item';
  end if;

  -- Duplicates are rejected BEFORE hashing, so two requests that differ only in
  -- how a repeated item was split across lines can never canonicalize alike.
  select count(*), count(distinct btrim(e.value ->> 'itemId'))
  into v_count, v_distinct
  from jsonb_array_elements(p_items) e;
  if v_count <> v_distinct then
    raise exception 'The same item appears more than once in this order';
  end if;

  -- ==========================================================================
  -- 2. Authorization — the only place the acting owner is established.
  -- ==========================================================================
  v_owner_id := public.resolve_sale_owner(p_project_id);
  if v_owner_id is null then
    raise exception 'Project not found or access denied';
  end if;
  v_is_owner := (v_caller = v_owner_id);

  -- ==========================================================================
  -- 3. Lock the project row. Single serialization point per project, taken
  --    before any pricing, stock, idempotency or counter access.
  -- ==========================================================================
  select p.config into v_config
  from public.projects p
  where p.id = p_project_id and p.user_id = v_owner_id
  for update;
  if not found then
    raise exception 'Project not found or access denied';
  end if;

  v_live_items := coalesce(v_config -> 'menuItems', '[]'::jsonb);
  if jsonb_typeof(v_live_items) <> 'array' then
    raise exception 'Project configuration is invalid';
  end if;

  -- Device branch: resolved here because a revoked device must be rejected even
  -- on a replay. Only the build id is read now; the snapshot itself is fetched
  -- later, so an idempotent replay never depends on it.
  if not v_is_owner then
    select d.build_job_id into v_build_job_id
    from public.paired_devices d
    where d.auth_user_id = v_caller
      and d.project_id = p_project_id
      and d.revoked_at is null;
    if not found then
      raise exception 'Project not found or access denied';
    end if;
  end if;

  -- ==========================================================================
  -- 4. Tip. Rejected for special values before the owner/device branch, since
  --    NaN sorts above every finite numeric and would otherwise be misreported.
  -- ==========================================================================
  if p_tip_amount is not null
     and p_tip_amount::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'Order amounts are not valid';
  end if;

  if v_is_owner then
    v_tip_amount := round(coalesce(p_tip_amount, 0), 2);
    if v_tip_amount < 0 then
      raise exception 'Order amounts cannot be negative';
    end if;
    if v_tip_amount > c_max_money then
      raise exception 'Order amount is too large';
    end if;
  else
    if coalesce(p_tip_amount, 0) <> 0 then
      raise exception 'Tips are not supported on this device';
    end if;
    v_tip_amount := round(0::numeric, 2);
  end if;

  -- ==========================================================================
  -- 5. Normalize items, then build the canonical preimage and its hash.
  -- ==========================================================================
  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_item_id := btrim(v_item ->> 'itemId');

    begin
      v_qty_num := (v_item ->> 'quantity')::numeric;
    exception
      when invalid_text_representation then
        raise exception 'Invalid quantity for an order item';
    end;

    if v_qty_num is null
       or v_qty_num::text in ('NaN', 'Infinity', '-Infinity')
       or v_qty_num <> trunc(v_qty_num)
       or v_qty_num < 1
       or v_qty_num > c_max_quantity then
      raise exception 'Invalid quantity for an order item';
    end if;

    v_quantity := v_qty_num::integer;

    v_norm := v_norm || jsonb_build_object('id', v_item_id, 'qty', v_quantity);
  end loop;

  select string_agg(
           octet_length(e.value ->> 'id')::text || ':' ||
           (e.value ->> 'id') || '=' || (e.value ->> 'qty'),
           E'\n' order by (e.value ->> 'id') collate "C"
         )
  into v_items_text
  from jsonb_array_elements(v_norm) e;

  v_canonical :=
    'posc.sale.v1' || E'\n' ||
    'project=' || p_project_id::text || E'\n' ||
    'payment=' || v_method || E'\n' ||
    'tip=' || v_tip_amount::text || E'\n' ||
    'items=' || jsonb_array_length(v_norm)::text ||
    case when v_items_text is null then '' else E'\n' || v_items_text end;

  v_hash := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');

  -- ==========================================================================
  -- 6. Idempotency lookup — after authorization and the lock, BEFORE counter
  --    allocation, order insert, inventory mutation and audit inserts.
  --
  --    Placed here deliberately: a replay must succeed even if the item was
  --    since renamed, repriced, removed from the menu, or has since run out of
  --    stock. The payload is rebuilt from the stored order, never recomputed.
  -- ==========================================================================
  select o.id, o.sale_request_hash into v_existing
  from public.orders o
  where o.project_id = p_project_id
    and o.sale_request_id = p_sale_request_id;

  if found then
    if v_existing.sale_request_hash is distinct from v_hash then
      raise exception 'Sale request ID was already used for a different order';
    end if;
    v_order_id := v_existing.id;
  else
    -- ========================================================================
    -- 7. New sale. Resolve the authorized pricing source.
    -- ========================================================================
    if v_is_owner then
      v_source := v_config;
      -- Feature 28C — captured from the SAME v_config this sale is being priced
      -- from, inside the same project lock, so the header on the receipt and the
      -- prices on it can never come from two different reads.
      v_receipt_snapshot := jsonb_build_object(
        'businessProfile', coalesce(v_config -> 'businessProfile', '{}'::jsonb),
        'receipt', coalesce(v_config -> 'receipt', '{}'::jsonb)
      );
    else
      select b.config_snapshot into v_source
      from public.build_jobs b
      where b.id = v_build_job_id
        and b.project_id = p_project_id
        and b.status = 'succeeded';
      if not found then
        raise exception 'This device is not linked to a usable build';
      end if;
    end if;

    v_price_items := coalesce(v_source -> 'menuItems', '[]'::jsonb);
    v_tax := coalesce(v_source -> 'tax', '{}'::jsonb);
    v_receipt := coalesce(v_source -> 'receipt', '{}'::jsonb);

    if jsonb_typeof(v_price_items) <> 'array' then
      raise exception 'Pricing configuration is invalid';
    end if;

    -- Tax settings. Malformed values fall back exactly as toRuntimeSafeTax
    -- does: a special or unparseable rate becomes 0, NOT the 100 clamp.
    begin
      v_tax_enabled := coalesce((v_tax ->> 'enabled')::boolean, true);
    exception when invalid_text_representation then v_tax_enabled := true;
    end;
    begin
      v_tax_inclusive := coalesce((v_tax ->> 'pricesIncludeTax')::boolean, false);
    exception when invalid_text_representation then v_tax_inclusive := false;
    end;
    begin
      v_rate := coalesce((v_tax ->> 'rate')::numeric, 0);
    exception when invalid_text_representation then v_rate := 0;
    end;

    if v_rate is null or v_rate::text in ('NaN', 'Infinity', '-Infinity') then
      v_rate := 0;
    elsif v_rate < 0 then
      v_rate := 0;
    elsif v_rate > 100 then
      v_rate := 100;
    end if;

    -- ========================================================================
    -- 8. Per-item server pricing and live-stock validation.
    -- ========================================================================
    for v_item in select value from jsonb_array_elements(v_norm)
    loop
      v_item_id := v_item ->> 'id';
      v_quantity := (v_item ->> 'qty')::integer;

      v_price_item := null;
      for i in 0 .. jsonb_array_length(v_price_items) - 1
      loop
        if v_price_items -> i ->> 'id' = v_item_id then
          v_price_item := v_price_items -> i;
          exit;
        end if;
      end loop;

      if v_price_item is null then
        raise exception 'Menu item % is not available', v_item_id;
      end if;

      v_item_name := btrim(coalesce(v_price_item ->> 'name', ''));
      if v_item_name = '' then
        raise exception 'Menu item % is not available', v_item_id;
      end if;

      -- ----------------------------------------------------------------
      -- Feature 18.1 — FAIL-CLOSED against stale clients.
      --
      -- v2 has no concept of modifiers. If it sold a product that now carries
      -- modifier groups, it would charge the BASE price and silently drop
      -- every option the customer asked for — an undercharge and a wrong
      -- order, produced by code that looks like it succeeded.
      --
      -- v2 therefore refuses such a product outright. This is the only change
      -- to v2's behavior, and it can only ever reject a sale that v2 was going
      -- to price incorrectly.
      --
      -- It covers BOTH branches automatically because v_price_item comes from
      -- v_source, which section 7 resolved to the owner's locked live config
      -- or to the device's pinned build snapshot. A device on an old pinned
      -- build has no modifierGroups in its snapshot and is unaffected; a
      -- device on a new pinned build is stopped here exactly like a stale
      -- browser tab.
      --
      -- Idempotent replays are unaffected: section 6 returns the stored
      -- receipt before any pricing runs, so a sale that already succeeded
      -- still replays cleanly.
      -- ----------------------------------------------------------------
      if jsonb_typeof(v_price_item -> 'modifierGroups') = 'array'
         and jsonb_array_length(v_price_item -> 'modifierGroups') > 0 then
        raise exception
          'This item now has options. Please refresh the POS and try again.';
      end if;

      begin
        v_unit_price := (v_price_item ->> 'price')::numeric;
      exception when invalid_text_representation then
        raise exception 'Menu item % has an invalid price', v_item_id;
      end;

      if v_unit_price is null
         or v_unit_price::text in ('NaN', 'Infinity', '-Infinity')
         or v_unit_price < 0
         or v_unit_price > c_max_unit_price then
        raise exception 'Menu item % has an invalid price', v_item_id;
      end if;

      v_line_total := round(v_unit_price * v_quantity, 2);
      if v_line_total is null
         or v_line_total::text in ('NaN', 'Infinity', '-Infinity') then
        raise exception 'Order amount is not valid';
      end if;
      if v_line_total > c_max_money then
        raise exception 'Order amount is too large';
      end if;

      v_subtotal := v_subtotal + v_line_total;
      if v_subtotal > c_max_money then
        raise exception 'Order amount is too large';
      end if;

      -- Inventory always from the LIVE locked config.
      v_live_index := null;
      for i in 0 .. jsonb_array_length(v_live_items) - 1
      loop
        if v_live_items -> i ->> 'id' = v_item_id then
          v_live_index := i;
          exit;
        end if;
      end loop;
      if v_live_index is null then
        raise exception 'Menu item % is not available', v_item_id;
      end if;
      v_live_item := v_live_items -> v_live_index;

      begin
        v_track := coalesce((v_live_item ->> 'trackInventory')::boolean, false);
      exception when invalid_text_representation then
        raise exception 'Inventory configuration for % is invalid', v_item_id;
      end;

      v_stock_before := 0;
      v_stock_after := 0;

      if v_track then
        begin
          v_stock_num := coalesce((v_live_item ->> 'stockQuantity')::numeric, 0);
        exception when invalid_text_representation then
          raise exception 'Inventory configuration for % is invalid', v_item_id;
        end;

        if v_stock_num is null
           or v_stock_num::text in ('NaN', 'Infinity', '-Infinity')
           or v_stock_num <> trunc(v_stock_num)
           or v_stock_num < 0
           or v_stock_num > c_max_stock then
          raise exception 'Inventory configuration for % is invalid', v_item_id;
        end if;

        v_stock_before := v_stock_num::integer;
        if v_stock_before < v_quantity then
          raise exception 'Insufficient inventory for %', v_item_name;
        end if;
        v_stock_after := v_stock_before - v_quantity;

        v_live_items := jsonb_set(
          v_live_items, array[v_live_index::text, 'stockQuantity'],
          to_jsonb(v_stock_after), true
        );
      end if;

      v_lines := v_lines || jsonb_build_object(
        'item_id', v_item_id, 'item_name', v_item_name,
        'unit_price', v_unit_price, 'quantity', v_quantity,
        'line_total', v_line_total, 'track', v_track,
        'stock_before', v_stock_before, 'stock_after', v_stock_after
      );
    end loop;

    -- ========================================================================
    -- 9. Order-level money — identical rules and rounding points to Migration C.
    -- ========================================================================
    v_subtotal := round(v_subtotal, 2);

    if not v_tax_enabled then
      v_tax_amount := 0;
      v_total_before_tip := v_subtotal;
    elsif v_tax_inclusive then
      v_tax_amount := round(v_subtotal - v_subtotal / (1 + v_rate / 100), 2);
      v_total_before_tip := v_subtotal;
    else
      v_tax_amount := round(v_subtotal * v_rate / 100, 2);
      v_total_before_tip := v_subtotal + v_tax_amount;
    end if;

    if v_tax_amount < 0 then
      v_tax_amount := 0;
    end if;

    v_total := round(v_total_before_tip + v_tip_amount, 2);

    if v_subtotal is null or v_tax_amount is null
       or v_tip_amount is null or v_total is null
       or v_subtotal::text in ('NaN', 'Infinity', '-Infinity')
       or v_tax_amount::text in ('NaN', 'Infinity', '-Infinity')
       or v_tip_amount::text in ('NaN', 'Infinity', '-Infinity')
       or v_total::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'Order amount is not valid';
    end if;

    if v_subtotal > c_max_money or v_tax_amount > c_max_money
       or v_tip_amount > c_max_money or v_total > c_max_money then
      raise exception 'Order amount is too large';
    end if;

    if v_subtotal < 0 or v_total < 0 then
      raise exception 'Order amounts cannot be negative';
    end if;

    -- ========================================================================
    -- 10. Order number. Prefix from the SAME authorized source as the prices,
    --     so a device's receipt prefix matches the build it is pinned to.
    -- ========================================================================
    v_prefix := btrim(coalesce(v_receipt ->> 'orderPrefix', ''));
    v_prefix := regexp_replace(v_prefix, '[[:cntrl:]]', '', 'g');
    if length(v_prefix) > c_max_prefix_len then
      v_prefix := left(v_prefix, c_max_prefix_len);
    end if;

    -- Lazily create the counter: D2 seeded only the projects that existed then,
    -- so any project created afterwards gets its row here, on first sale.
    insert into public.project_order_counters (project_id, last_number)
    values (p_project_id, 1000)
    on conflict (project_id) do nothing;

    select c.last_number into v_suffix
    from public.project_order_counters c
    where c.project_id = p_project_id
    for update;

    if v_suffix is null then
      raise exception 'Order number could not be allocated';
    end if;
    if v_suffix >= c_max_suffix then
      raise exception 'Order number sequence exhausted for this project';
    end if;

    -- Transactional allocation. Not a sequence: nextval is non-transactional
    -- and would leave a permanent gap on every rolled-back sale.
    update public.project_order_counters
    set last_number = last_number + 1,
        updated_at = now()
    where project_id = p_project_id
    returning last_number into v_suffix;

    v_order_number := v_prefix || v_suffix::text;

    -- ========================================================================
    -- 11. Atomic write.
    -- ========================================================================
    begin
      insert into public.orders (
        user_id, project_id, order_number, payment_method,
        subtotal, tax_amount, tip_amount, total,
        number_source, sale_request_id, sale_request_hash,
        build_job_id,
        receipt_snapshot
      )
      values (
        v_owner_id, p_project_id, v_order_number, v_method,
        v_subtotal, v_tax_amount, v_tip_amount, v_total,
        'server', p_sale_request_id, v_hash,
        v_build_job_id,
        v_receipt_snapshot
      )
      returning id into v_order_id;
    exception
      when unique_violation then
        -- The project FOR UPDATE lock serializes every sale for this project,
        -- so this should be unreachable. It is kept as a final backstop rather
        -- than a primary path: re-read the winning row and apply the SAME hash
        -- comparison, so a racing duplicate replays instead of double-selling.
        -- The subtransaction rollback has already undone this INSERT; no
        -- inventory row or config update has been written yet.
        select o.id, o.sale_request_hash into v_existing
        from public.orders o
        where o.project_id = p_project_id
          and o.sale_request_id = p_sale_request_id;

        if not found then
          raise exception 'Could not allocate a unique order number';
        end if;
        if v_existing.sale_request_hash is distinct from v_hash then
          raise exception 'Sale request ID was already used for a different order';
        end if;
        v_order_id := v_existing.id;
    end;

    -- Only write the rest when this call actually created the order.
    if not exists (
      select 1 from public.order_items oi where oi.order_id = v_order_id
    ) then
      insert into public.order_items (
        order_id, item_id, item_name, unit_price, quantity, line_total,
        line_position
      )
      select v_order_id, line ->> 'item_id', line ->> 'item_name',
             (line ->> 'unit_price')::numeric, (line ->> 'quantity')::integer,
             (line ->> 'line_total')::numeric,
             line_no::integer
      from jsonb_array_elements(v_lines) with ordinality as t(line, line_no);

      insert into public.inventory_transactions (
        user_id, project_id, order_id, item_id, item_name,
        transaction_type, quantity_change, quantity_before, quantity_after
      )
      select v_owner_id, p_project_id, v_order_id, line ->> 'item_id',
             line ->> 'item_name', 'sale',
             -(line ->> 'quantity')::integer,
             (line ->> 'stock_before')::integer,
             (line ->> 'stock_after')::integer
      from jsonb_array_elements(v_lines) as line
      where (line ->> 'track')::boolean;

      update public.projects
      set config = jsonb_set(v_config, '{menuItems}', v_live_items, true),
          updated_at = now()
      where id = p_project_id and user_id = v_owner_id;

      if not found then
        raise exception 'Failed to update project inventory';
      end if;
    end if;
  end if;

  -- ==========================================================================
  -- 12. Authoritative payload — ONE construction path, used by both the new-sale
  --     and the idempotent-replay branch, always rebuilt from the stored rows.
  --
  --     Money is returned as fixed two-decimal STRINGS. numeric(12,2)::text is
  --     exact; a JSON number would be parsed into an IEEE-754 double by the
  --     browser and could render a cent differently from what is stored.
  --     Deliberately absent: user_id, sale_request_id, sale_request_hash,
  --     build id, device id, config snapshot and inventory before/after values.
  -- ==========================================================================
  select jsonb_build_object(
           'orderId', o.id::text,
           'orderNumber', o.order_number,
           'paymentMethod', o.payment_method,
           'subtotal', o.subtotal::text,
           'taxAmount', o.tax_amount::text,
           'tipAmount', o.tip_amount::text,
           'total', o.total::text,
           'createdAt', to_char(o.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'items', coalesce((
             select jsonb_agg(
                      jsonb_build_object(
                        'itemId', oi.item_id,
                        'itemName', oi.item_name,
                        'unitPrice', oi.unit_price::text,
                        'quantity', oi.quantity,
                        'lineTotal', oi.line_total::text
                      )
                      -- Feature 28C — cart order for a sale written since this
                      -- feature, and a DETERMINISTIC fallback for every older row,
                      -- whose line_position is null and always will be. item_id
                      -- alone is not a total order: two lines of the same product
                      -- with different options tie on it, and a tie left to the
                      -- planner can order the slip and the reprint differently.
                      order by oi.line_position nulls last,
                               oi.item_id collate "C",
                               oi.id
                    )
             from public.order_items oi
             where oi.order_id = o.id
           ), '[]'::jsonb)
         )
  into v_payload
  from public.orders o
  where o.id = v_order_id;

  if v_payload is null then
    raise exception 'Order could not be loaded';
  end if;

  return v_payload;
end;
$function$;

CREATE OR REPLACE FUNCTION public.complete_sale_v3(p_project_id uuid, p_payment_method text, p_tip_amount numeric, p_items jsonb, p_sale_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  c_max_money      constant numeric := 9999999999.99;
  c_max_unit_price constant numeric := 1000000.00;
  c_max_quantity   constant integer := 10000;
  c_max_items      constant integer := 200;
  c_max_stock      constant numeric := 1000000000;
  c_max_suffix     constant bigint  := 999999999999999;
  c_max_prefix_len constant integer := 32;

  v_caller        uuid;
  v_owner_id      uuid;
  v_is_owner      boolean;
  v_build_job_id  uuid;
  -- Feature 28C — the business identity and receipt settings to print this
  -- sale's receipt with, frozen at sale time. Set on the OWNER branch only: a
  -- device sale already records build_job_id, whose config_snapshot is
  -- immutable and holds the same two objects, so storing a second copy would
  -- create two answers to one question.
  v_receipt_snapshot jsonb;
  v_source        jsonb;
  v_price_items   jsonb;
  v_tax           jsonb;
  v_receipt       jsonb;

  v_config        jsonb;
  v_live_items    jsonb;

  v_method        text;
  v_tip_amount    numeric := 0;
  v_norm          jsonb := '[]'::jsonb;
  v_items_text    text;
  v_canonical     text;
  v_hash          text;

  v_order_id      uuid;
  v_existing      record;
  v_payload       jsonb;

  v_tax_enabled   boolean;
  v_tax_inclusive boolean;
  v_rate          numeric;

  v_lines         jsonb := '[]'::jsonb;
  v_item          jsonb;
  v_item_id       text;
  v_qty_num       numeric;
  v_quantity      integer;
  v_price_item    jsonb;
  v_live_item     jsonb;
  v_live_index    integer;
  v_item_name     text;
  v_unit_price    numeric;
  v_line_total    numeric;
  v_track         boolean;
  v_stock_num     numeric;
  v_stock_before  integer;
  v_stock_after   integer;

  v_subtotal      numeric := 0;
  v_tax_amount    numeric := 0;
  v_total_before_tip numeric := 0;
  v_total         numeric := 0;

  v_prefix        text;
  v_suffix        bigint;
  v_order_number  text;

  v_count         integer;
  v_distinct      integer;
  i               integer;

  -- Feature 18.1 — modifier state. Everything here is derived from the
  -- AUTHORIZED config; the request contributes identifiers only.
  c_max_mod_groups   constant integer := 10;
  c_max_mod_options  constant integer := 20;
  c_max_mod_selected constant integer := 50;

  v_mods          jsonb;
  v_mod_groups    jsonb;
  v_mod_sel       jsonb;
  v_mod_group     jsonb;
  v_mod_option    jsonb;
  v_mod_opt_id    text;
  v_group_id      text;
  v_group_found   boolean;
  v_option_found  boolean;
  v_mod_adjust    numeric;
  v_mod_total     numeric;
  v_mod_snapshot  jsonb;
  v_mod_count     integer;
  v_sel_count     integer;
  v_selected_total integer;
  v_line_identity text;
  v_mod_text      text;
  v_required_ok   boolean;
  j               integer;
  k               integer;
begin
  -- ==========================================================================
  -- 1. Caller and request shape.
  -- ==========================================================================
  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'Authentication required';
  end if;

  if p_project_id is null then
    raise exception 'Project ID is required';
  end if;

  -- A client-generated request id is mandatory. There is deliberately no
  -- server-side fallback: a generated id would make every retry look like a new
  -- sale, which is the exact failure this parameter exists to prevent. The
  -- all-zero uuid is rejected as an obvious uninitialised placeholder. Version
  -- and variant nibbles are NOT checked — any distinct uuid is a valid key, and
  -- rejecting v1/v7 ids would break clients for no security benefit.
  if p_sale_request_id is null then
    raise exception 'A sale request ID is required';
  end if;
  if p_sale_request_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception 'A sale request ID is required';
  end if;

  if p_payment_method is null or p_payment_method not in ('cash', 'card') then
    raise exception 'Invalid payment method';
  end if;
  v_method := p_payment_method;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one order item is required';
  end if;
  if jsonb_array_length(p_items) > c_max_items then
    raise exception 'Too many order items';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(p_items) e
  where jsonb_typeof(e.value) <> 'object';
  if v_count > 0 then
    raise exception 'Invalid order item';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(p_items) e
  where coalesce(btrim(e.value ->> 'itemId'), '') = '';
  if v_count > 0 then
    raise exception 'Invalid order item';
  end if;

  -- Feature 18.1 — the v2 duplicate-itemId rule cannot survive verbatim: the
  -- same product with two different modifier selections is two legitimate
  -- lines. It is replaced by a duplicate-LINE rule in section 5, which
  -- compares the canonical (item + selection) identity and therefore keeps the
  -- exact property v2's rule protected — two requests that differ only in how
  -- one line was split can still never canonicalize alike.

  -- Modifier payload shape. Checked here, before any config is loaded, so a
  -- malformed or oversized request never reaches the pricing loop.
  select count(*) into v_count
  from jsonb_array_elements(p_items) e
  where e.value ? 'modifiers'
    and jsonb_typeof(e.value -> 'modifiers') <> 'array';
  if v_count > 0 then
    raise exception 'Invalid order item';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(p_items) e
  where jsonb_array_length(coalesce(e.value -> 'modifiers', '[]'::jsonb)) > c_max_mod_groups;
  if v_count > 0 then
    raise exception 'Too many options for an order item';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(p_items) e,
       jsonb_array_elements(coalesce(e.value -> 'modifiers', '[]'::jsonb)) m
  where jsonb_typeof(m.value) <> 'object'
     or coalesce(btrim(m.value ->> 'groupId'), '') = ''
     or (m.value ? 'optionIds' and jsonb_typeof(m.value -> 'optionIds') <> 'array');
  if v_count > 0 then
    raise exception 'Invalid order item';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(p_items) e,
       jsonb_array_elements(coalesce(e.value -> 'modifiers', '[]'::jsonb)) m
  where jsonb_array_length(coalesce(m.value -> 'optionIds', '[]'::jsonb)) > c_max_mod_options;
  if v_count > 0 then
    raise exception 'Too many options for an order item';
  end if;

  -- Every option id must be a non-empty string. jsonb_array_elements_text
  -- renders a non-string element as its text form, so the type is checked
  -- explicitly rather than inferred.
  select count(*) into v_count
  from jsonb_array_elements(p_items) e,
       jsonb_array_elements(coalesce(e.value -> 'modifiers', '[]'::jsonb)) m,
       jsonb_array_elements(coalesce(m.value -> 'optionIds', '[]'::jsonb)) o
  where jsonb_typeof(o.value) <> 'string'
     or coalesce(btrim(o.value #>> '{}'), '') = '';
  if v_count > 0 then
    raise exception 'Invalid order item';
  end if;

  -- ==========================================================================
  -- 2. Authorization — the only place the acting owner is established.
  -- ==========================================================================
  v_owner_id := public.resolve_sale_owner(p_project_id);
  if v_owner_id is null then
    raise exception 'Project not found or access denied';
  end if;
  v_is_owner := (v_caller = v_owner_id);

  -- ==========================================================================
  -- 3. Lock the project row. Single serialization point per project, taken
  --    before any pricing, stock, idempotency or counter access.
  -- ==========================================================================
  select p.config into v_config
  from public.projects p
  where p.id = p_project_id and p.user_id = v_owner_id
  for update;
  if not found then
    raise exception 'Project not found or access denied';
  end if;

  v_live_items := coalesce(v_config -> 'menuItems', '[]'::jsonb);
  if jsonb_typeof(v_live_items) <> 'array' then
    raise exception 'Project configuration is invalid';
  end if;

  -- Device branch: resolved here because a revoked device must be rejected even
  -- on a replay. Only the build id is read now; the snapshot itself is fetched
  -- later, so an idempotent replay never depends on it.
  if not v_is_owner then
    select d.build_job_id into v_build_job_id
    from public.paired_devices d
    where d.auth_user_id = v_caller
      and d.project_id = p_project_id
      and d.revoked_at is null
      -- Feature 25.1 — stated explicitly here as well as inside
      -- resolve_sale_owner. Two predicates that mean the same thing must say the
      -- same thing, or they drift apart silently.
      and d.unpaired_at is null;
    if not found then
      raise exception 'Project not found or access denied';
    end if;
  end if;

  -- ==========================================================================
  -- 4. Tip. Rejected for special values before the owner/device branch, since
  --    NaN sorts above every finite numeric and would otherwise be misreported.
  -- ==========================================================================
  if p_tip_amount is not null
     and p_tip_amount::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'Order amounts are not valid';
  end if;

  if v_is_owner then
    v_tip_amount := round(coalesce(p_tip_amount, 0), 2);
    if v_tip_amount < 0 then
      raise exception 'Order amounts cannot be negative';
    end if;
    if v_tip_amount > c_max_money then
      raise exception 'Order amount is too large';
    end if;
  else
    if coalesce(p_tip_amount, 0) <> 0 then
      raise exception 'Tips are not supported on this device';
    end if;
    v_tip_amount := round(0::numeric, 2);
  end if;

  -- ==========================================================================
  -- 5. Normalize items, then build the canonical preimage and its hash.
  -- ==========================================================================
  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_item_id := btrim(v_item ->> 'itemId');

    begin
      v_qty_num := (v_item ->> 'quantity')::numeric;
    exception
      when invalid_text_representation then
        raise exception 'Invalid quantity for an order item';
    end;

    if v_qty_num is null
       or v_qty_num::text in ('NaN', 'Infinity', '-Infinity')
       or v_qty_num <> trunc(v_qty_num)
       or v_qty_num < 1
       or v_qty_num > c_max_quantity then
      raise exception 'Invalid quantity for an order item';
    end if;

    v_quantity := v_qty_num::integer;

    v_mods := coalesce(v_item -> 'modifiers', '[]'::jsonb);

    -- A group carrying no options selects nothing, so it is dropped before the
    -- identity is built. Keeping it would make {g:[]} and an omitted g two
    -- different identities for the same cart.
    select coalesce(jsonb_agg(m.value order by btrim(m.value ->> 'groupId') collate "C"), '[]'::jsonb)
    into v_mods
    from jsonb_array_elements(v_mods) m
    where jsonb_array_length(coalesce(m.value -> 'optionIds', '[]'::jsonb)) > 0;

    -- Duplicate group ids inside one line would make the identity ambiguous.
    select count(*), count(distinct btrim(m.value ->> 'groupId'))
    into v_count, v_distinct
    from jsonb_array_elements(v_mods) m;
    if v_count <> v_distinct then
      raise exception 'The same option group appears more than once for an item';
    end if;

    select count(*) into v_selected_total
    from jsonb_array_elements(v_mods) m,
         jsonb_array_elements_text(m.value -> 'optionIds') o;
    if v_selected_total > c_max_mod_selected then
      raise exception 'Too many options for an order item';
    end if;

    -- Duplicate option ids inside one group: same reasoning.
    select count(*) into v_count
    from jsonb_array_elements(v_mods) m
    where (select count(*) from jsonb_array_elements_text(m.value -> 'optionIds')) <>
          (select count(distinct o.value) from jsonb_array_elements_text(m.value -> 'optionIds') o);
    if v_count > 0 then
      raise exception 'The same option appears more than once for an item';
    end if;

    -- CANONICAL LINE IDENTITY.
    --   <len(itemId)>:<itemId>[<groups>]<group>*
    --   group  := <len(gid)>:<gid>(<options>)<option>*
    --   option := <len(oid)>:<oid>
    -- Every id is byte-length-prefixed and every repeat carries an explicit
    -- count, so the string parses back unambiguously — a delimiter inside an id
    -- cannot shift the reading. Groups sort by group id and options by option
    -- id, so the order a cashier tapped them in cannot change the identity.
    -- This is the same injectivity technique v2 uses for item ids, extended one
    -- level down.
    select coalesce(string_agg(
             octet_length(g.gid)::text || ':' || g.gid ||
             '(' || g.optcount::text || ')' || g.opts,
             '' order by g.gid collate "C"), '')
    into v_mod_text
    from (
      select btrim(m.value ->> 'groupId') as gid,
             (select count(*) from jsonb_array_elements_text(m.value -> 'optionIds')) as optcount,
             (select coalesce(string_agg(
                       octet_length(o.value)::text || ':' || o.value,
                       '' order by o.value collate "C"), '')
              from jsonb_array_elements_text(m.value -> 'optionIds') o) as opts
      from jsonb_array_elements(v_mods) m
    ) g;

    v_line_identity :=
      octet_length(v_item_id)::text || ':' || v_item_id ||
      '[' || jsonb_array_length(v_mods)::text || ']' || v_mod_text;

    v_norm := v_norm || jsonb_build_object(
      'id', v_item_id,
      'qty', v_quantity,
      'mods', v_mods,
      'key', v_line_identity
    );
  end loop;

  -- Duplicate LINES — the modifier-aware replacement for v2's duplicate-item
  -- rule. The same product with different selections is allowed; the identical
  -- product-and-selection twice is not.
  select count(*), count(distinct e.value ->> 'key')
  into v_count, v_distinct
  from jsonb_array_elements(v_norm) e;
  if v_count <> v_distinct then
    raise exception 'The same item and options appear more than once in this order';
  end if;

  select string_agg(
           (e.value ->> 'key') || '=' || (e.value ->> 'qty'),
           E'\n' order by (e.value ->> 'key') collate "C"
         )
  into v_items_text
  from jsonb_array_elements(v_norm) e;

  -- A NEW canonical format. v1 keyed a line on item id alone, so two different
  -- modifier selections of one product would collide. complete_sale_v2's own
  -- preimage is deliberately left untouched, so a stale tab still hashes
  -- exactly as it always did.
  v_canonical :=
    'posc.sale.v2' || E'\n' ||
    'project=' || p_project_id::text || E'\n' ||
    'payment=' || v_method || E'\n' ||
    'tip=' || v_tip_amount::text || E'\n' ||
    'items=' || jsonb_array_length(v_norm)::text ||
    case when v_items_text is null then '' else E'\n' || v_items_text end;

  v_hash := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');

  -- ==========================================================================
  -- 6. Idempotency lookup — after authorization and the lock, BEFORE counter
  --    allocation, order insert, inventory mutation and audit inserts.
  --
  --    Placed here deliberately: a replay must succeed even if the item was
  --    since renamed, repriced, removed from the menu, or has since run out of
  --    stock. The payload is rebuilt from the stored order, never recomputed.
  -- ==========================================================================
  select o.id, o.sale_request_hash into v_existing
  from public.orders o
  where o.project_id = p_project_id
    and o.sale_request_id = p_sale_request_id;

  if found then
    if v_existing.sale_request_hash is distinct from v_hash then
      raise exception 'Sale request ID was already used for a different order';
    end if;
    v_order_id := v_existing.id;
  else
    -- ========================================================================
    -- 7. New sale. Resolve the authorized pricing source.
    -- ========================================================================
    if v_is_owner then
      v_source := v_config;
      -- Feature 28C — captured from the SAME v_config this sale is being priced
      -- from, inside the same project lock, so the header on the receipt and the
      -- prices on it can never come from two different reads.
      v_receipt_snapshot := jsonb_build_object(
        'businessProfile', coalesce(v_config -> 'businessProfile', '{}'::jsonb),
        'receipt', coalesce(v_config -> 'receipt', '{}'::jsonb)
      );
    else
      select b.config_snapshot into v_source
      from public.build_jobs b
      where b.id = v_build_job_id
        and b.project_id = p_project_id
        and b.status = 'succeeded';
      if not found then
        raise exception 'This device is not linked to a usable build';
      end if;
    end if;

    v_price_items := coalesce(v_source -> 'menuItems', '[]'::jsonb);
    v_tax := coalesce(v_source -> 'tax', '{}'::jsonb);
    v_receipt := coalesce(v_source -> 'receipt', '{}'::jsonb);

    if jsonb_typeof(v_price_items) <> 'array' then
      raise exception 'Pricing configuration is invalid';
    end if;

    -- Tax settings. Malformed values fall back exactly as toRuntimeSafeTax
    -- does: a special or unparseable rate becomes 0, NOT the 100 clamp.
    begin
      v_tax_enabled := coalesce((v_tax ->> 'enabled')::boolean, true);
    exception when invalid_text_representation then v_tax_enabled := true;
    end;
    begin
      v_tax_inclusive := coalesce((v_tax ->> 'pricesIncludeTax')::boolean, false);
    exception when invalid_text_representation then v_tax_inclusive := false;
    end;
    begin
      v_rate := coalesce((v_tax ->> 'rate')::numeric, 0);
    exception when invalid_text_representation then v_rate := 0;
    end;

    if v_rate is null or v_rate::text in ('NaN', 'Infinity', '-Infinity') then
      v_rate := 0;
    elsif v_rate < 0 then
      v_rate := 0;
    elsif v_rate > 100 then
      v_rate := 100;
    end if;

    -- ========================================================================
    -- 8. Per-item server pricing and live-stock validation.
    -- ========================================================================
    for v_item in select value from jsonb_array_elements(v_norm)
    loop
      v_item_id := v_item ->> 'id';
      v_quantity := (v_item ->> 'qty')::integer;
      v_mods := coalesce(v_item -> 'mods', '[]'::jsonb);

      v_price_item := null;
      for i in 0 .. jsonb_array_length(v_price_items) - 1
      loop
        if v_price_items -> i ->> 'id' = v_item_id then
          v_price_item := v_price_items -> i;
          exit;
        end if;
      end loop;

      if v_price_item is null then
        raise exception 'Menu item % is not available', v_item_id;
      end if;

      v_item_name := btrim(coalesce(v_price_item ->> 'name', ''));
      if v_item_name = '' then
        raise exception 'Menu item % is not available', v_item_id;
      end if;

      begin
        v_unit_price := (v_price_item ->> 'price')::numeric;
      exception when invalid_text_representation then
        raise exception 'Menu item % has an invalid price', v_item_id;
      end;

      if v_unit_price is null
         or v_unit_price::text in ('NaN', 'Infinity', '-Infinity')
         or v_unit_price < 0
         or v_unit_price > c_max_unit_price then
        raise exception 'Menu item % has an invalid price', v_item_id;
      end if;

      -- ----------------------------------------------------------------
      -- Feature 18.1 — modifier resolution, validation and pricing.
      --
      -- Every value used below comes from v_price_item, which is the
      -- AUTHORIZED source resolved in section 7 (the owner's locked live
      -- config, or the device's pinned build snapshot). The request supplied
      -- identifiers and nothing else; there is no field in it for a name or a
      -- price, so none can be trusted by accident.
      -- ----------------------------------------------------------------
      v_mod_groups := coalesce(v_price_item -> 'modifierGroups', '[]'::jsonb);
      if jsonb_typeof(v_mod_groups) <> 'array' then
        v_mod_groups := '[]'::jsonb;
      end if;

      v_mod_total := 0;
      v_mod_snapshot := '[]'::jsonb;

      -- A product with no groups accepts no selections. This is what stops an
      -- option being attached to a plain item, or borrowed from another product.
      if jsonb_array_length(v_mod_groups) = 0 and jsonb_array_length(v_mods) > 0 then
        raise exception 'Menu item % does not have options', v_item_id;
      end if;

      for j in 0 .. jsonb_array_length(v_mods) - 1
      loop
        v_mod_sel := v_mods -> j;
        v_group_id := btrim(v_mod_sel ->> 'groupId');

        -- The group must belong to THIS product.
        v_mod_group := null;
        for k in 0 .. jsonb_array_length(v_mod_groups) - 1
        loop
          if v_mod_groups -> k ->> 'id' = v_group_id then
            v_mod_group := v_mod_groups -> k;
            exit;
          end if;
        end loop;

        if v_mod_group is null then
          raise exception 'Menu item % does not have that option group', v_item_id;
        end if;

        v_sel_count := jsonb_array_length(coalesce(v_mod_sel -> 'optionIds', '[]'::jsonb));

        -- A single-choice group accepts at most one option.
        if coalesce(v_mod_group ->> 'selection', 'single') = 'single' and v_sel_count > 1 then
          raise exception 'Only one option may be chosen for %', coalesce(v_mod_group ->> 'name', v_group_id);
        end if;

        -- maxSelections applies to multiple-choice groups only, and only when set.
        if coalesce(v_mod_group ->> 'selection', 'single') = 'multiple'
           and v_mod_group -> 'maxSelections' is not null
           and jsonb_typeof(v_mod_group -> 'maxSelections') = 'number'
           and v_sel_count > (v_mod_group ->> 'maxSelections')::integer then
          raise exception 'Too many options chosen for %', coalesce(v_mod_group ->> 'name', v_group_id);
        end if;

        for k in 0 .. v_sel_count - 1
        loop
          v_mod_opt_id := btrim(v_mod_sel -> 'optionIds' ->> k);

          -- The option must belong to THIS group, not merely to the product.
          v_mod_option := null;
          for i in 0 .. jsonb_array_length(coalesce(v_mod_group -> 'options', '[]'::jsonb)) - 1
          loop
            if v_mod_group -> 'options' -> i ->> 'id' = v_mod_opt_id then
              v_mod_option := v_mod_group -> 'options' -> i;
              exit;
            end if;
          end loop;

          if v_mod_option is null then
            raise exception 'That option is not available for %', coalesce(v_mod_group ->> 'name', v_group_id);
          end if;

          begin
            v_mod_adjust := (v_mod_option ->> 'priceAdjustment')::numeric;
          exception when invalid_text_representation then
            raise exception 'An option for % has an invalid price', v_item_id;
          end;

          -- Same money discipline as the base price: MVP adjustments are
          -- non-negative, finite, and bounded by the per-unit ceiling.
          if v_mod_adjust is null
             or v_mod_adjust::text in ('NaN', 'Infinity', '-Infinity')
             or v_mod_adjust < 0
             or v_mod_adjust > c_max_unit_price then
            raise exception 'An option for % has an invalid price', v_item_id;
          end if;

          v_mod_total := v_mod_total + v_mod_adjust;

          -- The historical snapshot: names and prices as they are RIGHT NOW,
          -- so a receipt reprinted after a menu change still shows what the
          -- customer actually bought and paid.
          v_mod_snapshot := v_mod_snapshot || jsonb_build_object(
            'groupId', v_group_id,
            'groupName', coalesce(v_mod_group ->> 'name', ''),
            'optionId', v_mod_opt_id,
            'optionName', coalesce(v_mod_option ->> 'name', ''),
            'priceAdjustment', round(v_mod_adjust, 2)::text
          );
        end loop;
      end loop;

      -- Required groups must be satisfied. Checked over the PRODUCT's groups
      -- rather than the submission, so an omitted group is caught as readily as
      -- an empty one.
      for k in 0 .. jsonb_array_length(v_mod_groups) - 1
      loop
        if (v_mod_groups -> k ->> 'required')::boolean is true then
          v_required_ok := false;

          for j in 0 .. jsonb_array_length(v_mods) - 1
          loop
            if btrim(v_mods -> j ->> 'groupId') = (v_mod_groups -> k ->> 'id')
               and jsonb_array_length(coalesce(v_mods -> j -> 'optionIds', '[]'::jsonb)) > 0 then
              v_required_ok := true;
              exit;
            end if;
          end loop;

          if not v_required_ok then
            raise exception 'Please choose % for %',
              coalesce(v_mod_groups -> k ->> 'name', 'an option'), v_item_name;
          end if;
        end if;
      end loop;

      -- The line's unit price is the base plus every selected adjustment. It is
      -- re-bounded because the sum can exceed the per-unit ceiling even when
      -- each part is individually valid.
      v_unit_price := round(v_unit_price + v_mod_total, 2);

      if v_unit_price is null
         or v_unit_price::text in ('NaN', 'Infinity', '-Infinity')
         or v_unit_price < 0
         or v_unit_price > c_max_unit_price then
        raise exception 'Menu item % has an invalid price', v_item_id;
      end if;

      v_line_total := round(v_unit_price * v_quantity, 2);
      if v_line_total is null
         or v_line_total::text in ('NaN', 'Infinity', '-Infinity') then
        raise exception 'Order amount is not valid';
      end if;
      if v_line_total > c_max_money then
        raise exception 'Order amount is too large';
      end if;

      v_subtotal := v_subtotal + v_line_total;
      if v_subtotal > c_max_money then
        raise exception 'Order amount is too large';
      end if;

      -- Inventory always from the LIVE locked config.
      v_live_index := null;
      for i in 0 .. jsonb_array_length(v_live_items) - 1
      loop
        if v_live_items -> i ->> 'id' = v_item_id then
          v_live_index := i;
          exit;
        end if;
      end loop;
      if v_live_index is null then
        raise exception 'Menu item % is not available', v_item_id;
      end if;
      v_live_item := v_live_items -> v_live_index;

      begin
        v_track := coalesce((v_live_item ->> 'trackInventory')::boolean, false);
      exception when invalid_text_representation then
        raise exception 'Inventory configuration for % is invalid', v_item_id;
      end;

      v_stock_before := 0;
      v_stock_after := 0;

      if v_track then
        begin
          v_stock_num := coalesce((v_live_item ->> 'stockQuantity')::numeric, 0);
        exception when invalid_text_representation then
          raise exception 'Inventory configuration for % is invalid', v_item_id;
        end;

        if v_stock_num is null
           or v_stock_num::text in ('NaN', 'Infinity', '-Infinity')
           or v_stock_num <> trunc(v_stock_num)
           or v_stock_num < 0
           or v_stock_num > c_max_stock then
          raise exception 'Inventory configuration for % is invalid', v_item_id;
        end if;

        v_stock_before := v_stock_num::integer;
        if v_stock_before < v_quantity then
          raise exception 'Insufficient inventory for %', v_item_name;
        end if;
        v_stock_after := v_stock_before - v_quantity;

        v_live_items := jsonb_set(
          v_live_items, array[v_live_index::text, 'stockQuantity'],
          to_jsonb(v_stock_after), true
        );
      end if;

      v_lines := v_lines || jsonb_build_object(
        'item_id', v_item_id, 'item_name', v_item_name,
        'unit_price', v_unit_price, 'quantity', v_quantity,
        'line_total', v_line_total, 'track', v_track,
        'stock_before', v_stock_before, 'stock_after', v_stock_after,
        'modifiers', v_mod_snapshot
      );
    end loop;

    -- ========================================================================
    -- 9. Order-level money — identical rules and rounding points to Migration C.
    -- ========================================================================
    v_subtotal := round(v_subtotal, 2);

    if not v_tax_enabled then
      v_tax_amount := 0;
      v_total_before_tip := v_subtotal;
    elsif v_tax_inclusive then
      v_tax_amount := round(v_subtotal - v_subtotal / (1 + v_rate / 100), 2);
      v_total_before_tip := v_subtotal;
    else
      v_tax_amount := round(v_subtotal * v_rate / 100, 2);
      v_total_before_tip := v_subtotal + v_tax_amount;
    end if;

    if v_tax_amount < 0 then
      v_tax_amount := 0;
    end if;

    v_total := round(v_total_before_tip + v_tip_amount, 2);

    if v_subtotal is null or v_tax_amount is null
       or v_tip_amount is null or v_total is null
       or v_subtotal::text in ('NaN', 'Infinity', '-Infinity')
       or v_tax_amount::text in ('NaN', 'Infinity', '-Infinity')
       or v_tip_amount::text in ('NaN', 'Infinity', '-Infinity')
       or v_total::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'Order amount is not valid';
    end if;

    if v_subtotal > c_max_money or v_tax_amount > c_max_money
       or v_tip_amount > c_max_money or v_total > c_max_money then
      raise exception 'Order amount is too large';
    end if;

    if v_subtotal < 0 or v_total < 0 then
      raise exception 'Order amounts cannot be negative';
    end if;

    -- ========================================================================
    -- 10. Order number. Prefix from the SAME authorized source as the prices,
    --     so a device's receipt prefix matches the build it is pinned to.
    -- ========================================================================
    v_prefix := btrim(coalesce(v_receipt ->> 'orderPrefix', ''));
    v_prefix := regexp_replace(v_prefix, '[[:cntrl:]]', '', 'g');
    if length(v_prefix) > c_max_prefix_len then
      v_prefix := left(v_prefix, c_max_prefix_len);
    end if;

    -- Lazily create the counter: D2 seeded only the projects that existed then,
    -- so any project created afterwards gets its row here, on first sale.
    insert into public.project_order_counters (project_id, last_number)
    values (p_project_id, 1000)
    on conflict (project_id) do nothing;

    select c.last_number into v_suffix
    from public.project_order_counters c
    where c.project_id = p_project_id
    for update;

    if v_suffix is null then
      raise exception 'Order number could not be allocated';
    end if;
    if v_suffix >= c_max_suffix then
      raise exception 'Order number sequence exhausted for this project';
    end if;

    -- Transactional allocation. Not a sequence: nextval is non-transactional
    -- and would leave a permanent gap on every rolled-back sale.
    update public.project_order_counters
    set last_number = last_number + 1,
        updated_at = now()
    where project_id = p_project_id
    returning last_number into v_suffix;

    v_order_number := v_prefix || v_suffix::text;

    -- ========================================================================
    -- 11. Atomic write.
    -- ========================================================================
    begin
      insert into public.orders (
        user_id, project_id, order_number, payment_method,
        subtotal, tax_amount, tip_amount, total,
        number_source, sale_request_id, sale_request_hash,
        build_job_id,
        receipt_snapshot
      )
      values (
        v_owner_id, p_project_id, v_order_number, v_method,
        v_subtotal, v_tax_amount, v_tip_amount, v_total,
        'server', p_sale_request_id, v_hash,
        v_build_job_id,
        v_receipt_snapshot
      )
      returning id into v_order_id;
    exception
      when unique_violation then
        -- The project FOR UPDATE lock serializes every sale for this project,
        -- so this should be unreachable. It is kept as a final backstop rather
        -- than a primary path: re-read the winning row and apply the SAME hash
        -- comparison, so a racing duplicate replays instead of double-selling.
        -- The subtransaction rollback has already undone this INSERT; no
        -- inventory row or config update has been written yet.
        select o.id, o.sale_request_hash into v_existing
        from public.orders o
        where o.project_id = p_project_id
          and o.sale_request_id = p_sale_request_id;

        if not found then
          raise exception 'Could not allocate a unique order number';
        end if;
        if v_existing.sale_request_hash is distinct from v_hash then
          raise exception 'Sale request ID was already used for a different order';
        end if;
        v_order_id := v_existing.id;
    end;

    -- Only write the rest when this call actually created the order.
    if not exists (
      select 1 from public.order_items oi where oi.order_id = v_order_id
    ) then
      insert into public.order_items (
        order_id, item_id, item_name, unit_price, quantity, line_total, modifiers,
        line_position
      )
      select v_order_id, line ->> 'item_id', line ->> 'item_name',
             (line ->> 'unit_price')::numeric, (line ->> 'quantity')::integer,
             (line ->> 'line_total')::numeric,
             coalesce(line -> 'modifiers', '[]'::jsonb),
             line_no::integer
      from jsonb_array_elements(v_lines) with ordinality as t(line, line_no);

      insert into public.inventory_transactions (
        user_id, project_id, order_id, item_id, item_name,
        transaction_type, quantity_change, quantity_before, quantity_after
      )
      select v_owner_id, p_project_id, v_order_id, line ->> 'item_id',
             line ->> 'item_name', 'sale',
             -(line ->> 'quantity')::integer,
             (line ->> 'stock_before')::integer,
             (line ->> 'stock_after')::integer
      from jsonb_array_elements(v_lines) as line
      where (line ->> 'track')::boolean;

      update public.projects
      set config = jsonb_set(v_config, '{menuItems}', v_live_items, true),
          updated_at = now()
      where id = p_project_id and user_id = v_owner_id;

      if not found then
        raise exception 'Failed to update project inventory';
      end if;
    end if;
  end if;

  -- ==========================================================================
  -- 12. Authoritative payload — ONE construction path, used by both the new-sale
  --     and the idempotent-replay branch, always rebuilt from the stored rows.
  --
  --     Money is returned as fixed two-decimal STRINGS. numeric(12,2)::text is
  --     exact; a JSON number would be parsed into an IEEE-754 double by the
  --     browser and could render a cent differently from what is stored.
  --     Deliberately absent: user_id, sale_request_id, sale_request_hash,
  --     build id, device id, config snapshot and inventory before/after values.
  -- ==========================================================================
  select jsonb_build_object(
           'orderId', o.id::text,
           'orderNumber', o.order_number,
           'paymentMethod', o.payment_method,
           'subtotal', o.subtotal::text,
           'taxAmount', o.tax_amount::text,
           'tipAmount', o.tip_amount::text,
           'total', o.total::text,
           'createdAt', to_char(o.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'items', coalesce((
             select jsonb_agg(
                      jsonb_build_object(
                        'itemId', oi.item_id,
                        'itemName', oi.item_name,
                        'unitPrice', oi.unit_price::text,
                        'quantity', oi.quantity,
                        'lineTotal', oi.line_total::text,
                        'modifiers', coalesce(oi.modifiers, '[]'::jsonb)
                      )
                      -- Feature 28C — cart order for a sale written since this
                      -- feature, and a DETERMINISTIC fallback for every older row,
                      -- whose line_position is null and always will be. item_id
                      -- alone is not a total order: two lines of the same product
                      -- with different options tie on it, and a tie left to the
                      -- planner can order the slip and the reprint differently.
                      order by oi.line_position nulls last,
                               oi.item_id collate "C",
                               oi.id
                    )
             from public.order_items oi
             where oi.order_id = o.id
           ), '[]'::jsonb)
         )
  into v_payload
  from public.orders o
  where o.id = v_order_id;

  if v_payload is null then
    raise exception 'Order could not be loaded';
  end if;

  return v_payload;
end;
$function$;

CREATE OR REPLACE FUNCTION public.complete_sale_v4(p_project_id uuid, p_payment_method text, p_tip_amount numeric, p_items jsonb, p_sale_request_id uuid, p_occurred_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_source text DEFAULT 'online'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  c_max_money      constant numeric := 9999999999.99;
  c_max_unit_price constant numeric := 1000000.00;
  c_max_quantity   constant integer := 10000;
  c_max_items      constant integer := 200;
  c_max_stock      constant numeric := 1000000000;
  c_max_suffix     constant bigint  := 999999999999999;
  c_max_prefix_len constant integer := 32;

  -- Feature 24.5B — clock skew allowance for a device-reported sale time.
  -- FIVE MINUTES, matching OFFLINE_CLOCK_TOLERANCE_MS in
  -- lib/deviceOfflineCache.ts so the client and the server agree on what
  -- "close enough" means. Wide enough to absorb ordinary drift and an NTP
  -- correction; far too narrow to backdate a sale past a revocation.
  c_clock_skew     constant interval := interval '5 minutes';

  -- Feature 24.5B — the maximum age of a NEW offline sale.
  --
  -- SEVEN DAYS, the same number as OFFLINE_DEVICE_LEASE_MS in
  -- lib/deviceOfflineCache.ts. The client refuses to OPEN offline past that
  -- lease; without the same bound here the server would still accept a sale
  -- claiming to be from outside it, and the two halves of one owner-approved
  -- policy would disagree.
  --
  -- WHY THIS IS A SECURITY BOUND AND NOT HOUSEKEEPING: the pairing floor below
  -- is not sufficient on its own. A till paired months ago satisfies
  -- `occurred_at >= paired_at` for any date since, so without an age ceiling a
  -- device could backdate a sale created TODAY to a moment months ago — and
  -- slide it in front of a revoked_at set last week. The revocation window in
  -- 6c compares against occurred_at, so an unbounded past is an unbounded
  -- bypass of it. This closes that.
  c_offline_max_age constant interval := interval '7 days';

  v_caller        uuid;
  v_owner_id      uuid;
  v_is_owner      boolean;
  v_build_job_id  uuid;
  -- Feature 28C — the business identity and receipt settings to print this
  -- sale's receipt with, frozen at sale time. Set on the OWNER branch only: a
  -- device sale already records build_job_id, whose config_snapshot is
  -- immutable and holds the same two objects, so storing a second copy would
  -- create two answers to one question.
  v_receipt_snapshot jsonb;

  -- Feature 24.5B. NOTE the name: v_source is already taken by the pricing
  -- CONFIG below, which is a different thing entirely.
  v_sale_source   text;
  v_occurred_at   timestamptz;
  v_device_revoked_at timestamptz;
  -- Feature 25.1 — the device removed itself. Administrative, never temporal:
  -- this value is NEVER compared against occurred_at.
  v_device_unpaired_at timestamptz;
  v_device_paired_at  timestamptz;
  v_shortfall     integer;
  v_has_shortfall boolean := false;
  v_source        jsonb;
  v_price_items   jsonb;
  v_tax           jsonb;
  v_receipt       jsonb;

  v_config        jsonb;
  v_live_items    jsonb;

  v_method        text;
  v_tip_amount    numeric := 0;
  v_norm          jsonb := '[]'::jsonb;
  v_items_text    text;
  v_canonical     text;
  v_hash          text;

  v_order_id      uuid;
  v_existing      record;
  v_payload       jsonb;

  v_tax_enabled   boolean;
  v_tax_inclusive boolean;
  v_rate          numeric;

  v_lines         jsonb := '[]'::jsonb;
  v_item          jsonb;
  v_item_id       text;
  v_qty_num       numeric;
  v_quantity      integer;
  v_price_item    jsonb;
  v_live_item     jsonb;
  v_live_index    integer;
  v_item_name     text;
  v_unit_price    numeric;
  v_line_total    numeric;
  v_track         boolean;
  v_stock_num     numeric;
  v_stock_before  integer;
  v_stock_after   integer;

  v_subtotal      numeric := 0;
  v_tax_amount    numeric := 0;
  v_total_before_tip numeric := 0;
  v_total         numeric := 0;

  v_prefix        text;
  v_suffix        bigint;
  v_order_number  text;

  v_count         integer;
  v_distinct      integer;
  i               integer;

  -- Feature 18.1 — modifier state. Everything here is derived from the
  -- AUTHORIZED config; the request contributes identifiers only.
  c_max_mod_groups   constant integer := 10;
  c_max_mod_options  constant integer := 20;
  c_max_mod_selected constant integer := 50;

  v_mods          jsonb;
  v_mod_groups    jsonb;
  v_mod_sel       jsonb;
  v_mod_group     jsonb;
  v_mod_option    jsonb;
  v_mod_opt_id    text;
  v_group_id      text;
  v_group_found   boolean;
  v_option_found  boolean;
  v_mod_adjust    numeric;
  v_mod_total     numeric;
  v_mod_snapshot  jsonb;
  v_mod_count     integer;
  v_sel_count     integer;
  v_selected_total integer;
  v_line_identity text;
  v_mod_text      text;
  v_required_ok   boolean;
  j               integer;
  k               integer;
begin
  -- ==========================================================================
  -- 1. Caller and request shape.
  -- ==========================================================================
  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'Authentication required';
  end if;

  if p_project_id is null then
    raise exception 'Project ID is required';
  end if;

  -- A client-generated request id is mandatory. There is deliberately no
  -- server-side fallback: a generated id would make every retry look like a new
  -- sale, which is the exact failure this parameter exists to prevent. The
  -- all-zero uuid is rejected as an obvious uninitialised placeholder. Version
  -- and variant nibbles are NOT checked — any distinct uuid is a valid key, and
  -- rejecting v1/v7 ids would break clients for no security benefit.
  if p_sale_request_id is null then
    raise exception 'A sale request ID is required';
  end if;
  if p_sale_request_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception 'A sale request ID is required';
  end if;

  if p_payment_method is null or p_payment_method not in ('cash', 'card') then
    raise exception 'Invalid payment method';
  end if;
  v_method := p_payment_method;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one order item is required';
  end if;
  if jsonb_array_length(p_items) > c_max_items then
    raise exception 'Too many order items';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(p_items) e
  where jsonb_typeof(e.value) <> 'object';
  if v_count > 0 then
    raise exception 'Invalid order item';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(p_items) e
  where coalesce(btrim(e.value ->> 'itemId'), '') = '';
  if v_count > 0 then
    raise exception 'Invalid order item';
  end if;

  -- Feature 18.1 — the v2 duplicate-itemId rule cannot survive verbatim: the
  -- same product with two different modifier selections is two legitimate
  -- lines. It is replaced by a duplicate-LINE rule in section 5, which
  -- compares the canonical (item + selection) identity and therefore keeps the
  -- exact property v2's rule protected — two requests that differ only in how
  -- one line was split can still never canonicalize alike.

  -- Modifier payload shape. Checked here, before any config is loaded, so a
  -- malformed or oversized request never reaches the pricing loop.
  select count(*) into v_count
  from jsonb_array_elements(p_items) e
  where e.value ? 'modifiers'
    and jsonb_typeof(e.value -> 'modifiers') <> 'array';
  if v_count > 0 then
    raise exception 'Invalid order item';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(p_items) e
  where jsonb_array_length(coalesce(e.value -> 'modifiers', '[]'::jsonb)) > c_max_mod_groups;
  if v_count > 0 then
    raise exception 'Too many options for an order item';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(p_items) e,
       jsonb_array_elements(coalesce(e.value -> 'modifiers', '[]'::jsonb)) m
  where jsonb_typeof(m.value) <> 'object'
     or coalesce(btrim(m.value ->> 'groupId'), '') = ''
     or (m.value ? 'optionIds' and jsonb_typeof(m.value -> 'optionIds') <> 'array');
  if v_count > 0 then
    raise exception 'Invalid order item';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(p_items) e,
       jsonb_array_elements(coalesce(e.value -> 'modifiers', '[]'::jsonb)) m
  where jsonb_array_length(coalesce(m.value -> 'optionIds', '[]'::jsonb)) > c_max_mod_options;
  if v_count > 0 then
    raise exception 'Too many options for an order item';
  end if;

  -- Every option id must be a non-empty string. jsonb_array_elements_text
  -- renders a non-string element as its text form, so the type is checked
  -- explicitly rather than inferred.
  select count(*) into v_count
  from jsonb_array_elements(p_items) e,
       jsonb_array_elements(coalesce(e.value -> 'modifiers', '[]'::jsonb)) m,
       jsonb_array_elements(coalesce(m.value -> 'optionIds', '[]'::jsonb)) o
  where jsonb_typeof(o.value) <> 'string'
     or coalesce(btrim(o.value #>> '{}'), '') = '';
  if v_count > 0 then
    raise exception 'Invalid order item';
  end if;

  -- Feature 24.5B — the sale source. A CLOSED set, checked before anything
  -- else reads it: an unbounded text column would let a caller invent a
  -- category that every later filter and report silently ignores.
  v_sale_source := lower(btrim(coalesce(p_source, 'online')));
  if v_sale_source not in ('online', 'offline_queued') then
    raise exception 'Invalid sale source';
  end if;

  -- ==========================================================================
  -- 2. Authorization.
  --
  -- FEATURE 24.5B DELIBERATELY DOES NOT CALL resolve_sale_owner FOR A DEVICE,
  -- and this is the one place v4 relaxes something v3 enforced. Read carefully.
  --
  -- resolve_sale_owner filters `revoked_at is null`, so under v3 a revoked
  -- device is refused at the very first step — before the idempotency lookup.
  -- That means a sale the device COMPLETED while it was still authorized can
  -- never be recorded once the owner revokes it, and an already-committed sale
  -- can never be replayed. For an offline till that is not a security control,
  -- it is silent destruction of takings that physically happened.
  --
  -- v4 therefore resolves the device itself, WITHOUT the revoked filter, and
  -- moves the revocation decision to the two places where it actually belongs:
  --
  --   * an idempotent REPLAY of an existing order is allowed regardless of
  --     revocation. It allocates nothing, mutates nothing, and returns only an
  --     order this same caller already created.
  --   * a NEW sale from a revoked device is refused, except for an offline sale
  --     whose validated occurred_at is strictly before revoked_at — the
  --     owner-approved window (docs/OFFLINE_ARCHITECTURE.md §13).
  --
  -- A device with NO pairing row for this project is still refused outright,
  -- with the same non-probing message resolve_sale_owner uses.
  -- ==========================================================================
  select p.user_id into v_owner_id
  from public.projects p
  where p.id = p_project_id and p.user_id = v_caller;

  v_is_owner := found;

  if not v_is_owner then
    select d.owner_id, d.build_job_id, d.revoked_at, d.created_at, d.unpaired_at
      into v_owner_id, v_build_job_id, v_device_revoked_at, v_device_paired_at,
           v_device_unpaired_at
    from public.paired_devices d
    where d.auth_user_id = v_caller
      and d.project_id = p_project_id;

    if not found then
      raise exception 'Project not found or access denied';
    end if;
  end if;

  -- Feature 24.5B — only a paired device may claim offline semantics. An owner
  -- calling from the browser is, by definition, online; letting an owner post
  -- offline_queued would hand them a path that skips the inventory rejection
  -- every online sale is subject to.
  if v_is_owner and v_sale_source <> 'online' then
    raise exception 'Only a paired device can record an offline sale';
  end if;

  -- ==========================================================================
  -- 3. Lock the project row. Single serialization point per project, taken
  --    before any pricing, stock, idempotency or counter access.
  -- ==========================================================================
  select p.config into v_config
  from public.projects p
  where p.id = p_project_id and p.user_id = v_owner_id
  for update;
  if not found then
    raise exception 'Project not found or access denied';
  end if;

  v_live_items := coalesce(v_config -> 'menuItems', '[]'::jsonb);
  if jsonb_typeof(v_live_items) <> 'array' then
    raise exception 'Project configuration is invalid';
  end if;

  -- The device's pinned build id was read in section 2, together with its
  -- revocation state. Nothing else about the device is needed until a NEW sale
  -- is being priced, so an idempotent replay still never depends on it.

  -- ==========================================================================
  -- 4. Tip. Rejected for special values before the owner/device branch, since
  --    NaN sorts above every finite numeric and would otherwise be misreported.
  -- ==========================================================================
  if p_tip_amount is not null
     and p_tip_amount::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'Order amounts are not valid';
  end if;

  if v_is_owner then
    v_tip_amount := round(coalesce(p_tip_amount, 0), 2);
    if v_tip_amount < 0 then
      raise exception 'Order amounts cannot be negative';
    end if;
    if v_tip_amount > c_max_money then
      raise exception 'Order amount is too large';
    end if;
  else
    if coalesce(p_tip_amount, 0) <> 0 then
      raise exception 'Tips are not supported on this device';
    end if;
    v_tip_amount := round(0::numeric, 2);
  end if;

  -- ==========================================================================
  -- 5. Normalize items, then build the canonical preimage and its hash.
  -- ==========================================================================
  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_item_id := btrim(v_item ->> 'itemId');

    begin
      v_qty_num := (v_item ->> 'quantity')::numeric;
    exception
      when invalid_text_representation then
        raise exception 'Invalid quantity for an order item';
    end;

    if v_qty_num is null
       or v_qty_num::text in ('NaN', 'Infinity', '-Infinity')
       or v_qty_num <> trunc(v_qty_num)
       or v_qty_num < 1
       or v_qty_num > c_max_quantity then
      raise exception 'Invalid quantity for an order item';
    end if;

    v_quantity := v_qty_num::integer;

    v_mods := coalesce(v_item -> 'modifiers', '[]'::jsonb);

    -- A group carrying no options selects nothing, so it is dropped before the
    -- identity is built. Keeping it would make {g:[]} and an omitted g two
    -- different identities for the same cart.
    select coalesce(jsonb_agg(m.value order by btrim(m.value ->> 'groupId') collate "C"), '[]'::jsonb)
    into v_mods
    from jsonb_array_elements(v_mods) m
    where jsonb_array_length(coalesce(m.value -> 'optionIds', '[]'::jsonb)) > 0;

    -- Duplicate group ids inside one line would make the identity ambiguous.
    select count(*), count(distinct btrim(m.value ->> 'groupId'))
    into v_count, v_distinct
    from jsonb_array_elements(v_mods) m;
    if v_count <> v_distinct then
      raise exception 'The same option group appears more than once for an item';
    end if;

    select count(*) into v_selected_total
    from jsonb_array_elements(v_mods) m,
         jsonb_array_elements_text(m.value -> 'optionIds') o;
    if v_selected_total > c_max_mod_selected then
      raise exception 'Too many options for an order item';
    end if;

    -- Duplicate option ids inside one group: same reasoning.
    select count(*) into v_count
    from jsonb_array_elements(v_mods) m
    where (select count(*) from jsonb_array_elements_text(m.value -> 'optionIds')) <>
          (select count(distinct o.value) from jsonb_array_elements_text(m.value -> 'optionIds') o);
    if v_count > 0 then
      raise exception 'The same option appears more than once for an item';
    end if;

    -- CANONICAL LINE IDENTITY.
    --   <len(itemId)>:<itemId>[<groups>]<group>*
    --   group  := <len(gid)>:<gid>(<options>)<option>*
    --   option := <len(oid)>:<oid>
    -- Every id is byte-length-prefixed and every repeat carries an explicit
    -- count, so the string parses back unambiguously — a delimiter inside an id
    -- cannot shift the reading. Groups sort by group id and options by option
    -- id, so the order a cashier tapped them in cannot change the identity.
    -- This is the same injectivity technique v2 uses for item ids, extended one
    -- level down.
    select coalesce(string_agg(
             octet_length(g.gid)::text || ':' || g.gid ||
             '(' || g.optcount::text || ')' || g.opts,
             '' order by g.gid collate "C"), '')
    into v_mod_text
    from (
      select btrim(m.value ->> 'groupId') as gid,
             (select count(*) from jsonb_array_elements_text(m.value -> 'optionIds')) as optcount,
             (select coalesce(string_agg(
                       octet_length(o.value)::text || ':' || o.value,
                       '' order by o.value collate "C"), '')
              from jsonb_array_elements_text(m.value -> 'optionIds') o) as opts
      from jsonb_array_elements(v_mods) m
    ) g;

    v_line_identity :=
      octet_length(v_item_id)::text || ':' || v_item_id ||
      '[' || jsonb_array_length(v_mods)::text || ']' || v_mod_text;

    v_norm := v_norm || jsonb_build_object(
      'id', v_item_id,
      'qty', v_quantity,
      'mods', v_mods,
      'key', v_line_identity
    );
  end loop;

  -- Duplicate LINES — the modifier-aware replacement for v2's duplicate-item
  -- rule. The same product with different selections is allowed; the identical
  -- product-and-selection twice is not.
  select count(*), count(distinct e.value ->> 'key')
  into v_count, v_distinct
  from jsonb_array_elements(v_norm) e;
  if v_count <> v_distinct then
    raise exception 'The same item and options appear more than once in this order';
  end if;

  select string_agg(
           (e.value ->> 'key') || '=' || (e.value ->> 'qty'),
           E'\n' order by (e.value ->> 'key') collate "C"
         )
  into v_items_text
  from jsonb_array_elements(v_norm) e;

  -- A NEW canonical format. v1 keyed a line on item id alone, so two different
  -- modifier selections of one product would collide. complete_sale_v2's own
  -- preimage is deliberately left untouched, so a stale tab still hashes
  -- exactly as it always did.
  v_canonical :=
    'posc.sale.v2' || E'\n' ||
    'project=' || p_project_id::text || E'\n' ||
    'payment=' || v_method || E'\n' ||
    'tip=' || v_tip_amount::text || E'\n' ||
    'items=' || jsonb_array_length(v_norm)::text ||
    case when v_items_text is null then '' else E'\n' || v_items_text end;

  v_hash := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');

  -- ==========================================================================
  -- 6. Idempotency lookup — after authorization and the lock, BEFORE counter
  --    allocation, order insert, inventory mutation and audit inserts.
  --
  --    Placed here deliberately: a replay must succeed even if the item was
  --    since renamed, repriced, removed from the menu, or has since run out of
  --    stock. The payload is rebuilt from the stored order, never recomputed.
  -- ==========================================================================
  select o.id, o.sale_request_hash into v_existing
  from public.orders o
  where o.project_id = p_project_id
    and o.sale_request_id = p_sale_request_id;

  if found then
    if v_existing.sale_request_hash is distinct from v_hash then
      raise exception 'Sale request ID was already used for a different order';
    end if;
    v_order_id := v_existing.id;
  else
    -- ========================================================================
    -- 6b. Feature 24.5B — WHEN did this sale happen, and was the device still
    --     allowed to make it?
    --
    --     NEW SALES ONLY, deliberately. A replay returned above without ever
    --     reading p_occurred_at, which is also why occurred_at is NOT part of
    --     the canonical preimage in section 5: a retry whose clock has moved a
    --     few seconds must be the SAME sale, not a hash conflict.
    --
    --     created_at is untouched by all of this. It remains the server clock,
    --     recording when the row was committed. occurred_at records when the
    --     money physically changed hands. Neither is derivable from the other
    --     once a sale can be queued for hours.
    -- ========================================================================
    if v_sale_source = 'online' then
      -- An online sale happens now, by definition. A caller-supplied time is
      -- refused rather than ignored, so nobody can backdate an online sale and
      -- believe it worked.
      if p_occurred_at is not null then
        raise exception 'An online sale cannot declare its own sale time';
      end if;

      v_occurred_at := now();
    else
      -- THE DEVICE CLOCK IS NOT AUTHORITATIVE. Every bound below is checked
      -- against server time or against a server-recorded fact, and each one
      -- raises a DISTINCT message so the sync engine can tell an operator
      -- problem from a tampering attempt.
      if p_occurred_at is null then
        raise exception 'An offline sale must declare when it happened';
      end if;

      -- Not in the future. A clock running fast is ordinary; a clock running
      -- fast by more than the skew allowance is either broken or being used to
      -- reach past a revocation.
      if p_occurred_at > now() + c_clock_skew then
        raise exception 'Offline sale time is in the future';
      end if;

      -- Not before this device existed. paired_devices.created_at is a server
      -- timestamp, so this bound cannot be moved by the device. It is one of
      -- the two floors on backdating, and on its own it is NOT enough: a device
      -- paired months ago satisfies it for any date since.
      if v_device_paired_at is not null
         and p_occurred_at < v_device_paired_at - c_clock_skew then
        raise exception 'Offline sale time predates this device';
      end if;

      -- Not older than the offline lease. THE SECOND FLOOR, and the one that
      -- makes the revocation window in 6c enforceable: an unbounded past would
      -- let a new submission be backdated in front of any later revoked_at.
      --
      -- REJECTED, NEVER CLAMPED. Silently moving the timestamp to the boundary
      -- would write a sale time nobody reported, into the books, to make a
      -- validation pass — the exact rewriting of financial history this
      -- contract exists to prevent. The sale stays in the device queue for a
      -- person to resolve.
      if p_occurred_at < now() - c_offline_max_age - c_clock_skew then
        raise exception 'Offline sale time is older than the offline limit';
      end if;

      v_occurred_at := p_occurred_at;
    end if;

    -- ========================================================================
    -- 6c. The revocation window (docs/OFFLINE_ARCHITECTURE.md §13).
    --
    --     Owner-approved policy, and the reason section 2 stopped filtering
    --     revoked devices out: a sale that happened BEFORE the owner revoked
    --     the till is real money and is recorded; a sale claiming to have
    --     happened after it is refused and reported. The comparison uses the
    --     server-validated occurred_at above, never the raw parameter.
    -- ========================================================================
    -- ==========================================================================
    -- 6c-i. Feature 25.1 — the device removed itself.
    --
    --     UNCONDITIONAL, AND DELIBERATELY NOT A WINDOW. There is no
    --     `occurred_at < unpaired_at` exception here and there must never be
    --     one. Revocation earns its temporal comparison because an owner can
    --     revoke remotely while a till is offline, so sales taken before that
    --     moment are real money the device could not have known about. A
    --     voluntary unpair is the opposite: it is initiated ON the device, and
    --     only after decideDeviceResetSafety has proven the queue holds nothing
    --     pending, syncing, needing attention, or uncertain. There is no
    --     legitimate sale left for a window to admit.
    --
    --     PLACED INSIDE THE NEW-SALE BRANCH, after the section 6 idempotency
    --     lookup returned nothing. A REPLAY of an already-committed order never
    --     reaches this line and is still answered exactly as before: it
    --     allocates nothing, mutates nothing, and returns the order this same
    --     caller already created. Refusing a replay would protect nothing and
    --     would throw away the one guarantee that exists for the case where our
    --     model of reality turns out to be wrong.
    -- ==========================================================================
    if not v_is_owner and v_device_unpaired_at is not null then
      raise exception 'This device is no longer paired';
    end if;

    if not v_is_owner and v_device_revoked_at is not null then
      if v_sale_source <> 'offline_queued' then
        -- A revoked device gets no NEW online sale. It has already reconnected
        -- by definition, so it has already learned it was revoked.
        raise exception 'Project not found or access denied';
      end if;

      if v_occurred_at >= v_device_revoked_at then
        raise exception 'Offline sale occurred after this device was revoked';
      end if;
    end if;

    -- ========================================================================
    -- 7. New sale. Resolve the authorized pricing source.
    -- ========================================================================
    if v_is_owner then
      v_source := v_config;
      -- Feature 28C — captured from the SAME v_config this sale is being priced
      -- from, inside the same project lock, so the header on the receipt and the
      -- prices on it can never come from two different reads.
      v_receipt_snapshot := jsonb_build_object(
        'businessProfile', coalesce(v_config -> 'businessProfile', '{}'::jsonb),
        'receipt', coalesce(v_config -> 'receipt', '{}'::jsonb)
      );
    else
      select b.config_snapshot into v_source
      from public.build_jobs b
      where b.id = v_build_job_id
        and b.project_id = p_project_id
        and b.status = 'succeeded';
      if not found then
        raise exception 'This device is not linked to a usable build';
      end if;
    end if;

    v_price_items := coalesce(v_source -> 'menuItems', '[]'::jsonb);
    v_tax := coalesce(v_source -> 'tax', '{}'::jsonb);
    v_receipt := coalesce(v_source -> 'receipt', '{}'::jsonb);

    if jsonb_typeof(v_price_items) <> 'array' then
      raise exception 'Pricing configuration is invalid';
    end if;

    -- Tax settings. Malformed values fall back exactly as toRuntimeSafeTax
    -- does: a special or unparseable rate becomes 0, NOT the 100 clamp.
    begin
      v_tax_enabled := coalesce((v_tax ->> 'enabled')::boolean, true);
    exception when invalid_text_representation then v_tax_enabled := true;
    end;
    begin
      v_tax_inclusive := coalesce((v_tax ->> 'pricesIncludeTax')::boolean, false);
    exception when invalid_text_representation then v_tax_inclusive := false;
    end;
    begin
      v_rate := coalesce((v_tax ->> 'rate')::numeric, 0);
    exception when invalid_text_representation then v_rate := 0;
    end;

    if v_rate is null or v_rate::text in ('NaN', 'Infinity', '-Infinity') then
      v_rate := 0;
    elsif v_rate < 0 then
      v_rate := 0;
    elsif v_rate > 100 then
      v_rate := 100;
    end if;

    -- ========================================================================
    -- 8. Per-item server pricing and live-stock validation.
    -- ========================================================================
    for v_item in select value from jsonb_array_elements(v_norm)
    loop
      v_item_id := v_item ->> 'id';
      v_quantity := (v_item ->> 'qty')::integer;
      v_mods := coalesce(v_item -> 'mods', '[]'::jsonb);

      v_price_item := null;
      for i in 0 .. jsonb_array_length(v_price_items) - 1
      loop
        if v_price_items -> i ->> 'id' = v_item_id then
          v_price_item := v_price_items -> i;
          exit;
        end if;
      end loop;

      if v_price_item is null then
        raise exception 'Menu item % is not available', v_item_id;
      end if;

      v_item_name := btrim(coalesce(v_price_item ->> 'name', ''));
      if v_item_name = '' then
        raise exception 'Menu item % is not available', v_item_id;
      end if;

      begin
        v_unit_price := (v_price_item ->> 'price')::numeric;
      exception when invalid_text_representation then
        raise exception 'Menu item % has an invalid price', v_item_id;
      end;

      if v_unit_price is null
         or v_unit_price::text in ('NaN', 'Infinity', '-Infinity')
         or v_unit_price < 0
         or v_unit_price > c_max_unit_price then
        raise exception 'Menu item % has an invalid price', v_item_id;
      end if;

      -- ----------------------------------------------------------------
      -- Feature 18.1 — modifier resolution, validation and pricing.
      --
      -- Every value used below comes from v_price_item, which is the
      -- AUTHORIZED source resolved in section 7 (the owner's locked live
      -- config, or the device's pinned build snapshot). The request supplied
      -- identifiers and nothing else; there is no field in it for a name or a
      -- price, so none can be trusted by accident.
      -- ----------------------------------------------------------------
      v_mod_groups := coalesce(v_price_item -> 'modifierGroups', '[]'::jsonb);
      if jsonb_typeof(v_mod_groups) <> 'array' then
        v_mod_groups := '[]'::jsonb;
      end if;

      v_mod_total := 0;
      v_mod_snapshot := '[]'::jsonb;

      -- A product with no groups accepts no selections. This is what stops an
      -- option being attached to a plain item, or borrowed from another product.
      if jsonb_array_length(v_mod_groups) = 0 and jsonb_array_length(v_mods) > 0 then
        raise exception 'Menu item % does not have options', v_item_id;
      end if;

      for j in 0 .. jsonb_array_length(v_mods) - 1
      loop
        v_mod_sel := v_mods -> j;
        v_group_id := btrim(v_mod_sel ->> 'groupId');

        -- The group must belong to THIS product.
        v_mod_group := null;
        for k in 0 .. jsonb_array_length(v_mod_groups) - 1
        loop
          if v_mod_groups -> k ->> 'id' = v_group_id then
            v_mod_group := v_mod_groups -> k;
            exit;
          end if;
        end loop;

        if v_mod_group is null then
          raise exception 'Menu item % does not have that option group', v_item_id;
        end if;

        v_sel_count := jsonb_array_length(coalesce(v_mod_sel -> 'optionIds', '[]'::jsonb));

        -- A single-choice group accepts at most one option.
        if coalesce(v_mod_group ->> 'selection', 'single') = 'single' and v_sel_count > 1 then
          raise exception 'Only one option may be chosen for %', coalesce(v_mod_group ->> 'name', v_group_id);
        end if;

        -- maxSelections applies to multiple-choice groups only, and only when set.
        if coalesce(v_mod_group ->> 'selection', 'single') = 'multiple'
           and v_mod_group -> 'maxSelections' is not null
           and jsonb_typeof(v_mod_group -> 'maxSelections') = 'number'
           and v_sel_count > (v_mod_group ->> 'maxSelections')::integer then
          raise exception 'Too many options chosen for %', coalesce(v_mod_group ->> 'name', v_group_id);
        end if;

        for k in 0 .. v_sel_count - 1
        loop
          v_mod_opt_id := btrim(v_mod_sel -> 'optionIds' ->> k);

          -- The option must belong to THIS group, not merely to the product.
          v_mod_option := null;
          for i in 0 .. jsonb_array_length(coalesce(v_mod_group -> 'options', '[]'::jsonb)) - 1
          loop
            if v_mod_group -> 'options' -> i ->> 'id' = v_mod_opt_id then
              v_mod_option := v_mod_group -> 'options' -> i;
              exit;
            end if;
          end loop;

          if v_mod_option is null then
            raise exception 'That option is not available for %', coalesce(v_mod_group ->> 'name', v_group_id);
          end if;

          begin
            v_mod_adjust := (v_mod_option ->> 'priceAdjustment')::numeric;
          exception when invalid_text_representation then
            raise exception 'An option for % has an invalid price', v_item_id;
          end;

          -- Same money discipline as the base price: MVP adjustments are
          -- non-negative, finite, and bounded by the per-unit ceiling.
          if v_mod_adjust is null
             or v_mod_adjust::text in ('NaN', 'Infinity', '-Infinity')
             or v_mod_adjust < 0
             or v_mod_adjust > c_max_unit_price then
            raise exception 'An option for % has an invalid price', v_item_id;
          end if;

          v_mod_total := v_mod_total + v_mod_adjust;

          -- The historical snapshot: names and prices as they are RIGHT NOW,
          -- so a receipt reprinted after a menu change still shows what the
          -- customer actually bought and paid.
          v_mod_snapshot := v_mod_snapshot || jsonb_build_object(
            'groupId', v_group_id,
            'groupName', coalesce(v_mod_group ->> 'name', ''),
            'optionId', v_mod_opt_id,
            'optionName', coalesce(v_mod_option ->> 'name', ''),
            'priceAdjustment', round(v_mod_adjust, 2)::text
          );
        end loop;
      end loop;

      -- Required groups must be satisfied. Checked over the PRODUCT's groups
      -- rather than the submission, so an omitted group is caught as readily as
      -- an empty one.
      for k in 0 .. jsonb_array_length(v_mod_groups) - 1
      loop
        if (v_mod_groups -> k ->> 'required')::boolean is true then
          v_required_ok := false;

          for j in 0 .. jsonb_array_length(v_mods) - 1
          loop
            if btrim(v_mods -> j ->> 'groupId') = (v_mod_groups -> k ->> 'id')
               and jsonb_array_length(coalesce(v_mods -> j -> 'optionIds', '[]'::jsonb)) > 0 then
              v_required_ok := true;
              exit;
            end if;
          end loop;

          if not v_required_ok then
            raise exception 'Please choose % for %',
              coalesce(v_mod_groups -> k ->> 'name', 'an option'), v_item_name;
          end if;
        end if;
      end loop;

      -- The line's unit price is the base plus every selected adjustment. It is
      -- re-bounded because the sum can exceed the per-unit ceiling even when
      -- each part is individually valid.
      v_unit_price := round(v_unit_price + v_mod_total, 2);

      if v_unit_price is null
         or v_unit_price::text in ('NaN', 'Infinity', '-Infinity')
         or v_unit_price < 0
         or v_unit_price > c_max_unit_price then
        raise exception 'Menu item % has an invalid price', v_item_id;
      end if;

      v_line_total := round(v_unit_price * v_quantity, 2);
      if v_line_total is null
         or v_line_total::text in ('NaN', 'Infinity', '-Infinity') then
        raise exception 'Order amount is not valid';
      end if;
      if v_line_total > c_max_money then
        raise exception 'Order amount is too large';
      end if;

      v_subtotal := v_subtotal + v_line_total;
      if v_subtotal > c_max_money then
        raise exception 'Order amount is too large';
      end if;

      -- Inventory always from the LIVE locked config.
      v_live_index := null;
      for i in 0 .. jsonb_array_length(v_live_items) - 1
      loop
        if v_live_items -> i ->> 'id' = v_item_id then
          v_live_index := i;
          exit;
        end if;
      end loop;
      if v_live_index is null then
        raise exception 'Menu item % is not available', v_item_id;
      end if;
      v_live_item := v_live_items -> v_live_index;

      begin
        v_track := coalesce((v_live_item ->> 'trackInventory')::boolean, false);
      exception when invalid_text_representation then
        raise exception 'Inventory configuration for % is invalid', v_item_id;
      end;

      v_stock_before := 0;
      v_stock_after := 0;
      v_shortfall := 0;

      if v_track then
        begin
          v_stock_num := coalesce((v_live_item ->> 'stockQuantity')::numeric, 0);
        exception when invalid_text_representation then
          raise exception 'Inventory configuration for % is invalid', v_item_id;
        end;

        if v_stock_num is null
           or v_stock_num::text in ('NaN', 'Infinity', '-Infinity')
           or v_stock_num <> trunc(v_stock_num)
           or v_stock_num < 0
           or v_stock_num > c_max_stock then
          raise exception 'Inventory configuration for % is invalid', v_item_id;
        end if;

        v_stock_before := v_stock_num::integer;

        -- Feature 24.5B — the online rule is UNCHANGED: refuse, so the cashier
        -- can still act on it while the customer is standing there.
        --
        -- An offline queued sale is the opposite situation. The food is gone
        -- and the cash is in the drawer; the only question left is whether the
        -- books reflect it. Refusing here would delete a real financial record
        -- to protect a stock number, so the sale is accepted, tracked stock
        -- floors at 0 — the live config's own check rejects a negative — and
        -- the shortfall is recorded per line for the owner to reconcile.
        if v_stock_before < v_quantity then
          if v_sale_source <> 'offline_queued' then
            raise exception 'Insufficient inventory for %', v_item_name;
          end if;

          v_shortfall := v_quantity - v_stock_before;
          v_has_shortfall := true;
          v_stock_after := 0;
        else
          v_shortfall := 0;
          v_stock_after := v_stock_before - v_quantity;
        end if;

        v_live_items := jsonb_set(
          v_live_items, array[v_live_index::text, 'stockQuantity'],
          to_jsonb(v_stock_after), true
        );
      end if;

      v_lines := v_lines || jsonb_build_object(
        'item_id', v_item_id, 'item_name', v_item_name,
        'unit_price', v_unit_price, 'quantity', v_quantity,
        'line_total', v_line_total, 'track', v_track,
        'stock_before', v_stock_before, 'stock_after', v_stock_after,
        'shortfall', coalesce(v_shortfall, 0),
        'modifiers', v_mod_snapshot
      );
    end loop;

    -- ========================================================================
    -- 9. Order-level money — identical rules and rounding points to Migration C.
    -- ========================================================================
    v_subtotal := round(v_subtotal, 2);

    if not v_tax_enabled then
      v_tax_amount := 0;
      v_total_before_tip := v_subtotal;
    elsif v_tax_inclusive then
      v_tax_amount := round(v_subtotal - v_subtotal / (1 + v_rate / 100), 2);
      v_total_before_tip := v_subtotal;
    else
      v_tax_amount := round(v_subtotal * v_rate / 100, 2);
      v_total_before_tip := v_subtotal + v_tax_amount;
    end if;

    if v_tax_amount < 0 then
      v_tax_amount := 0;
    end if;

    v_total := round(v_total_before_tip + v_tip_amount, 2);

    if v_subtotal is null or v_tax_amount is null
       or v_tip_amount is null or v_total is null
       or v_subtotal::text in ('NaN', 'Infinity', '-Infinity')
       or v_tax_amount::text in ('NaN', 'Infinity', '-Infinity')
       or v_tip_amount::text in ('NaN', 'Infinity', '-Infinity')
       or v_total::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'Order amount is not valid';
    end if;

    if v_subtotal > c_max_money or v_tax_amount > c_max_money
       or v_tip_amount > c_max_money or v_total > c_max_money then
      raise exception 'Order amount is too large';
    end if;

    if v_subtotal < 0 or v_total < 0 then
      raise exception 'Order amounts cannot be negative';
    end if;

    -- ========================================================================
    -- 10. Order number. Prefix from the SAME authorized source as the prices,
    --     so a device's receipt prefix matches the build it is pinned to.
    -- ========================================================================
    v_prefix := btrim(coalesce(v_receipt ->> 'orderPrefix', ''));
    v_prefix := regexp_replace(v_prefix, '[[:cntrl:]]', '', 'g');
    if length(v_prefix) > c_max_prefix_len then
      v_prefix := left(v_prefix, c_max_prefix_len);
    end if;

    -- Lazily create the counter: D2 seeded only the projects that existed then,
    -- so any project created afterwards gets its row here, on first sale.
    insert into public.project_order_counters (project_id, last_number)
    values (p_project_id, 1000)
    on conflict (project_id) do nothing;

    select c.last_number into v_suffix
    from public.project_order_counters c
    where c.project_id = p_project_id
    for update;

    if v_suffix is null then
      raise exception 'Order number could not be allocated';
    end if;
    if v_suffix >= c_max_suffix then
      raise exception 'Order number sequence exhausted for this project';
    end if;

    -- Transactional allocation. Not a sequence: nextval is non-transactional
    -- and would leave a permanent gap on every rolled-back sale.
    update public.project_order_counters
    set last_number = last_number + 1,
        updated_at = now()
    where project_id = p_project_id
    returning last_number into v_suffix;

    v_order_number := v_prefix || v_suffix::text;

    -- ========================================================================
    -- 11. Atomic write.
    -- ========================================================================
    begin
      insert into public.orders (
        user_id, project_id, order_number, payment_method,
        subtotal, tax_amount, tip_amount, total,
        number_source, sale_request_id, sale_request_hash,
        -- Feature 24.5B. created_at is deliberately NOT listed: it keeps its
        -- now() default, so the server clock still records when this row was
        -- committed no matter what the device said about occurred_at.
        occurred_at, source, has_inventory_shortfall,
        build_job_id,
        receipt_snapshot
      )
      values (
        v_owner_id, p_project_id, v_order_number, v_method,
        v_subtotal, v_tax_amount, v_tip_amount, v_total,
        'server', p_sale_request_id, v_hash,
        v_occurred_at, v_sale_source, v_has_shortfall,
        v_build_job_id,
        v_receipt_snapshot
      )
      returning id into v_order_id;
    exception
      when unique_violation then
        -- The project FOR UPDATE lock serializes every sale for this project,
        -- so this should be unreachable. It is kept as a final backstop rather
        -- than a primary path: re-read the winning row and apply the SAME hash
        -- comparison, so a racing duplicate replays instead of double-selling.
        -- The subtransaction rollback has already undone this INSERT; no
        -- inventory row or config update has been written yet.
        select o.id, o.sale_request_hash into v_existing
        from public.orders o
        where o.project_id = p_project_id
          and o.sale_request_id = p_sale_request_id;

        if not found then
          raise exception 'Could not allocate a unique order number';
        end if;
        if v_existing.sale_request_hash is distinct from v_hash then
          raise exception 'Sale request ID was already used for a different order';
        end if;
        v_order_id := v_existing.id;
    end;

    -- Only write the rest when this call actually created the order.
    if not exists (
      select 1 from public.order_items oi where oi.order_id = v_order_id
    ) then
      insert into public.order_items (
        order_id, item_id, item_name, unit_price, quantity, line_total, modifiers,
        inventory_shortfall, line_position
      )
      select v_order_id, line ->> 'item_id', line ->> 'item_name',
             (line ->> 'unit_price')::numeric, (line ->> 'quantity')::integer,
             (line ->> 'line_total')::numeric,
             coalesce(line -> 'modifiers', '[]'::jsonb),
             coalesce((line ->> 'shortfall')::integer, 0),
             line_no::integer
      from jsonb_array_elements(v_lines) with ordinality as t(line, line_no);

      insert into public.inventory_transactions (
        user_id, project_id, order_id, item_id, item_name,
        transaction_type, quantity_change, quantity_before, quantity_after
      )
      -- Feature 24.5B — the change is stock_before minus stock_after, NOT the
      -- requested quantity. Once an offline sale can floor at 0 those two
      -- differ, and inventory_transactions carries its own
      -- `quantity_after = quantity_before + quantity_change` check that would
      -- reject the row. The shortfall lives on order_items, where it can be
      -- expressed without breaking that arithmetic.
      select v_owner_id, p_project_id, v_order_id, line ->> 'item_id',
             line ->> 'item_name', 'sale',
             -((line ->> 'stock_before')::integer - (line ->> 'stock_after')::integer),
             (line ->> 'stock_before')::integer,
             (line ->> 'stock_after')::integer
      from jsonb_array_elements(v_lines) as line
      where (line ->> 'track')::boolean
        and (line ->> 'stock_before')::integer <> (line ->> 'stock_after')::integer;

      update public.projects
      set config = jsonb_set(v_config, '{menuItems}', v_live_items, true),
          updated_at = now()
      where id = p_project_id and user_id = v_owner_id;

      if not found then
        raise exception 'Failed to update project inventory';
      end if;
    end if;
  end if;

  -- ==========================================================================
  -- 12. Authoritative payload — ONE construction path, used by both the new-sale
  --     and the idempotent-replay branch, always rebuilt from the stored rows.
  --
  --     Money is returned as fixed two-decimal STRINGS. numeric(12,2)::text is
  --     exact; a JSON number would be parsed into an IEEE-754 double by the
  --     browser and could render a cent differently from what is stored.
  --     Deliberately absent: user_id, sale_request_id, sale_request_hash,
  --     build id, device id, config snapshot and inventory before/after values.
  -- ==========================================================================
  select jsonb_build_object(
           'orderId', o.id::text,
           'orderNumber', o.order_number,
           'paymentMethod', o.payment_method,
           'subtotal', o.subtotal::text,
           'taxAmount', o.tax_amount::text,
           'tipAmount', o.tip_amount::text,
           'total', o.total::text,
           'createdAt', to_char(o.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           -- Feature 24.5B — ADDITIVE ONLY. Every field v3 returned keeps its
           -- name and its type, so a client reading a v4 payload with v3's
           -- parser is unaffected.
           'occurredAt', to_char(o.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'source', o.source,
           'hasInventoryShortfall', o.has_inventory_shortfall,
           'items', coalesce((
             select jsonb_agg(
                      jsonb_build_object(
                        'itemId', oi.item_id,
                        'itemName', oi.item_name,
                        'unitPrice', oi.unit_price::text,
                        'quantity', oi.quantity,
                        'lineTotal', oi.line_total::text,
                        'modifiers', coalesce(oi.modifiers, '[]'::jsonb),
                        'inventoryShortfall', coalesce(oi.inventory_shortfall, 0)
                      )
                      -- Feature 28C — cart order for a sale written since this
                      -- feature, and a DETERMINISTIC fallback for every older row,
                      -- whose line_position is null and always will be. item_id
                      -- alone is not a total order: two lines of the same product
                      -- with different options tie on it, and a tie left to the
                      -- planner can order the slip and the reprint differently.
                      order by oi.line_position nulls last,
                               oi.item_id collate "C",
                               oi.id
                    )
             from public.order_items oi
             where oi.order_id = o.id
           ), '[]'::jsonb)
         )
  into v_payload
  from public.orders o
  where o.id = v_order_id;

  if v_payload is null then
    raise exception 'Order could not be loaded';
  end if;

  return v_payload;
end;
$function$;

-- ----------------------------------------------------------------------------
-- 3. get_device_recent_orders — the same page, plus the sale-time presentation.
--
-- ADDITIVE ONLY. Every field the previous definition returned keeps its name
-- and its type; `presentation` is new and nullable. A client reading this
-- payload with the previous parser is unaffected.
--
-- The body below is the CURRENT deployed definition from
-- 20260823130000_device_sales_history.sql with two changes: the item ordering,
-- and the presentation object. Nothing about pairing, scoping, the cursor
-- contract or the page limit is touched — in particular there is still no
-- p_project_id argument, and there must never be one.
-- ----------------------------------------------------------------------------

create or replace function public.get_device_recent_orders(
  p_limit integer default 25,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller     uuid;
  v_project_id uuid;
  v_limit      integer;
  v_rows       jsonb;
  v_count      integer;
  v_orders     jsonb;
  v_next       jsonb;
begin
  v_caller := auth.uid();

  if v_caller is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  -- THE FEATURE 25.1 ACTIVE-PAIRING RULE, restated here because this is a new
  -- operational surface: neither a revoked device nor one that unpaired itself
  -- may read anything. Both simply stop matching, exactly as they do in
  -- get_device_config, and neither is told which of the two it is.
  select d.project_id into v_project_id
  from public.paired_devices d
  where d.auth_user_id = v_caller
    and d.revoked_at is null
    and d.unpaired_at is null;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_paired');
  end if;

  -- LIMIT IS NORMALISED, NOT REJECTED. A page size is a display preference, and
  -- failing a cashier's history screen over one would be a worse answer than
  -- quietly giving them a sensible page. The clamp is server-side, so no caller
  -- can ask for an unbounded read however the argument arrives — including null.
  v_limit := least(greatest(coalesce(p_limit, 25), 1), 50);

  -- THE CURSOR IS REJECTED, NOT NORMALISED, and the asymmetry is deliberate.
  -- A half cursor is not a preference, it is a bug: created_at alone cannot
  -- separate two orders written in the same instant, so honouring a
  -- timestamp-only cursor would silently skip or repeat rows — a history list
  -- that loses a sale. Both parts or neither.
  if (p_before_created_at is null) <> (p_before_id is null) then
    return jsonb_build_object('ok', false, 'error', 'invalid_cursor');
  end if;

  -- One extra row is fetched to learn whether another page exists, then
  -- trimmed. Cheaper and more honest than a second count query, which could
  -- disagree with the page under concurrent writes.
  select jsonb_agg(row_payload order by ord_created_at desc, ord_id desc)
    into v_rows
  from (
    select
      o.id          as ord_id,
      o.created_at  as ord_created_at,
      jsonb_build_object(
        'orderId', o.id::text,
        'orderNumber', o.order_number,
        'paymentMethod', o.payment_method,
        'subtotal', o.subtotal::text,
        'taxAmount', o.tax_amount::text,
        'tipAmount', o.tip_amount::text,
        'total', o.total::text,
        'createdAt', to_char(o.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        -- occurred_at is null on every order written before the offline
        -- contract existed. Returned as null rather than defaulted: the client
        -- falls back to createdAt for display, and inventing a sale time would
        -- be writing history nobody recorded.
        'occurredAt', to_char(o.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'source', o.source,
        -- Feature 28C — the business identity and receipt settings AS THEY WERE
        -- when this sale was taken, so a reprint is not re-headed by whatever
        -- the shop has configured today.
        --
        -- A DEVICE SALE reads them from the build that priced it: build_job_id
        -- is written by complete_sale*, build_jobs.config_snapshot is immutable,
        -- and ON DELETE NO ACTION means that build still exists. An OWNER SALE
        -- has no build and reads its own receipt_snapshot. An order older than
        -- either mechanism has neither, and returns null — the client then
        -- falls back to current configuration and says so. Nothing is invented.
        'presentation', coalesce(
          (select case
                    when b.config_snapshot ? 'businessProfile'
                     and b.config_snapshot ? 'receipt'
                    then jsonb_build_object(
                           'businessProfile', b.config_snapshot -> 'businessProfile',
                           'receipt', b.config_snapshot -> 'receipt'
                         )
                  end
           from public.build_jobs b
           where b.id = o.build_job_id),
          o.receipt_snapshot
        ),
        'items', coalesce((
          select jsonb_agg(
                   jsonb_build_object(
                     'itemId', oi.item_id,
                     'itemName', oi.item_name,
                     'unitPrice', oi.unit_price::text,
                     'quantity', oi.quantity,
                     'lineTotal', oi.line_total::text,
                     'modifiers', coalesce(oi.modifiers, '[]'::jsonb)
                   )
                   -- Feature 28C — cart order where it was recorded, and a
                   -- deterministic fallback for older rows. Must stay identical
                   -- to the ordering complete_sale* returns, or the reprint and
                   -- the original slip would list the same sale differently.
                   order by oi.line_position nulls last,
                            oi.item_id collate "C",
                            oi.id
                 )
          from public.order_items oi
          where oi.order_id = o.id
        ), '[]'::jsonb)
      ) as row_payload
    from public.orders o
    where o.project_id = v_project_id
      -- Row comparison, so the tiebreak is part of the predicate rather than
      -- something the sort has to clean up afterwards.
      and (
        p_before_created_at is null
        or (o.created_at, o.id) < (p_before_created_at, p_before_id)
      )
    order by o.created_at desc, o.id desc
    limit v_limit + 1
  ) page;

  v_rows  := coalesce(v_rows, '[]'::jsonb);
  v_count := jsonb_array_length(v_rows);

  if v_count > v_limit then
    v_orders := jsonb_path_query_array(v_rows, ('$[0 to ' || (v_limit - 1) || ']')::jsonpath);
    v_next := jsonb_build_object(
      'createdAt', v_orders -> (v_limit - 1) ->> 'createdAt',
      'id',        v_orders -> (v_limit - 1) ->> 'orderId'
    );
  else
    v_orders := v_rows;
    v_next := null;
  end if;

  return jsonb_build_object('ok', true, 'orders', v_orders, 'nextCursor', v_next);
end;
$function$;

-- ----------------------------------------------------------------------------
-- 4. Verification — fails loudly rather than leaving a half-applied contract.
-- ----------------------------------------------------------------------------
do $$
declare
  v_missing text;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name = 'receipt_snapshot'
  ) then
    raise exception 'Feature 28C: orders.receipt_snapshot was not created';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_items'
      and column_name = 'line_position'
  ) then
    raise exception 'Feature 28C: order_items.line_position was not created';
  end if;

  -- Every sale path must write both, or a null stops being a date and starts
  -- being a coin flip.
  select string_agg(p.proname, ', ') into v_missing
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('complete_sale', 'complete_sale_v2',
                      'complete_sale_v3', 'complete_sale_v4')
    and (pg_get_functiondef(p.oid) not like '%receipt_snapshot%'
      or pg_get_functiondef(p.oid) not like '%line_position%');

  if v_missing is not null then
    raise exception 'Feature 28C: these sale functions do not record the receipt snapshot or line position: %', v_missing;
  end if;

  -- And the reprint must order lines the same way the original slip did.
  if pg_get_functiondef('public.get_device_recent_orders(integer, timestamptz, uuid)'::regprocedure)
     not like '%line_position nulls last%' then
    raise exception 'Feature 28C: get_device_recent_orders does not use the deterministic line order';
  end if;

  if pg_get_functiondef('public.get_device_recent_orders(integer, timestamptz, uuid)'::regprocedure)
     not like '%presentation%' then
    raise exception 'Feature 28C: get_device_recent_orders does not return the sale-time presentation';
  end if;
end $$;

commit;
