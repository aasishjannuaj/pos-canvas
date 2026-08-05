-- Milestone 16, Feature 16.3 — Migration C
-- Secure owner/device checkout and server-side money recomputation.
--
-- WHAT THIS CHANGES
--
-- complete_sale keeps its exact 8-argument signature and its `returns uuid`
-- contract, so the deployed web client (lib/orders.ts) and the Android shell —
-- which loads that same hosted web app — keep working with no code change. What
-- changes is what the function TRUSTS:
--
--   before: item name, unit price, subtotal, tax_amount and total all came from
--           the browser and were stored verbatim. A tampered client could book a
--           $0.01 sale for a $50 item.
--   after:  every one of those values is derived inside PostgreSQL from an
--           authorized configuration. The corresponding parameters
--           (p_subtotal, p_tax_amount, p_total) and the per-item `name`/`price`
--           keys are read by NO code path below. They remain in the signature
--           only so existing callers keep compiling; a later migration
--           introduces the clean signature and drops them.
--
-- Authorization moves from "projects.user_id = auth.uid()" to
-- public.resolve_sale_owner(p_project_id), so an ACTIVE PAIRED DEVICE can now
-- sell on behalf of its owner. That is the entire point of Milestone 16.
--
-- SECURITY DEFINER — WHY, AND WHAT IT COSTS
--
-- A paired device is an anonymous auth user. It owns no project, so every RLS
-- policy on projects / orders / order_items / inventory_transactions denies it.
-- Those policies cannot be relaxed without also letting a device write rows
-- directly, bypassing this function entirely. SECURITY DEFINER is therefore the
-- mechanism: the function runs as postgres, RLS no longer applies to it, and
-- authorization becomes this function's own responsibility.
--
-- No table has FORCE ROW LEVEL SECURITY, so postgres bypasses RLS on all four
-- tables. Every policy that used to be a backstop is replaced by an explicit
-- check below:
--
--   projects RLS (auth.uid() = user_id)
--     -> the `and p.user_id = v_owner_id` predicate on the locked SELECT, and
--        the identical predicate on the final UPDATE.
--   orders INSERT RLS (auth.uid() = user_id)
--     -> user_id is set from v_owner_id, which comes only from
--        resolve_sale_owner. It is never taken from auth.uid() directly and
--        never from a parameter.
--   order_items INSERT RLS (order belongs to caller)
--     -> rows are only ever inserted against v_order_id, created in this call.
--   inventory_transactions INSERT RLS (auth.uid() = user_id AND project owned)
--     -> user_id is v_owner_id and project_id is the already-authorized
--        p_project_id.
--
-- CALLING resolve_sale_owner FROM A DEFINER FUNCTION IS SAFE
--
-- auth.uid() reads the request.jwt.claims GUC. SECURITY DEFINER changes
-- current_user, not GUCs, so the nested call still sees the real end user
-- rather than postgres. postgres owns resolve_sale_owner and holds EXECUTE
-- implicitly. Each function carries its own SET search_path, applied on entry
-- and restored on exit, so nesting cannot leak a path. resolve_sale_owner is
-- STABLE, which a VOLATILE function may call. Its RAISE propagates and aborts
-- this transaction, which is the correct response to an authorization failure.
--
-- PRICING SOURCE
--
--   owner  -> the LOCKED live projects.config. Preserves today's behavior
--             exactly: a price edited in the Builder applies to the owner's own
--             POS on the next page load.
--   device -> the pinned build_jobs.config_snapshot of the build the device was
--             paired to. The build id is read from the device's paired_devices
--             row, never from a parameter, so a device cannot reach any other
--             build. The build must still be 'succeeded'.
--
-- INVENTORY SOURCE — the locked live projects.config for BOTH callers. Stock is
-- live operational state; it must never come from a frozen snapshot.
--
-- A deliberate consequence: while a device is pinned to an older build, owner
-- and device can transact the same item at different prices until the owner
-- rebuilds. That is inherent to pinning and was accepted in review.
--
-- ROUNDING — see the migration test for the pinned vectors. All arithmetic is
-- `numeric`; the tax rate is cast with ::numeric and never ::float8, so 6.35
-- stays exact.
--
--   line_total = round(unit_price * quantity, 2)
--   subtotal   = round(sum(line_total), 2)          -- sum of ROUNDED lines, so
--                                                      the stored subtotal always
--                                                      equals the sum of the
--                                                      printed line totals
--   tax disabled : tax_amount = 0
--                  total_before_tip = subtotal
--   tax inclusive: tax_amount = round(subtotal - subtotal/(1 + rate/100), 2)
--                  total_before_tip = subtotal
--   tax exclusive: tax_amount = round(subtotal * rate / 100, 2)
--                  total_before_tip = subtotal + tax_amount
--   total      = round(total_before_tip + tip, 2)
--
-- This is NOT bit-identical to the browser's display math in lib/cart.ts, which
-- rounds nothing at all (its .toFixed(2) calls are render-only, in
-- PosCheckoutPanel and Receipt). With prices carrying two decimals or fewer the
-- two agree exactly; with a price carrying more than two decimals they can
-- differ by a cent. The server value is authoritative and is what gets stored.
--
-- NUMERIC RANGE SAFETY
--
-- Every money column is numeric(12,2), whose ceiling is 9999999999.99. All
-- intermediate arithmetic happens in unconstrained `numeric` (which cannot
-- overflow at these magnitudes), and every value is bounds-checked BEFORE it
-- reaches an INSERT, so a caller can never trigger a raw
-- numeric_value_out_of_range (22003) error. Note the bound is load-bearing
-- rather than decorative: the per-item ceilings alone permit
-- 1000000.00 * 10000 = 10000000000.00, which is one cent over the column limit.
--
-- SAFE NUMERIC PREDICATE — WHY RANGE CHECKS ARE NOT ENOUGH
--
-- PostgreSQL `numeric` accepts NaN, and since v14 also Infinity and -Infinity.
-- Two of its comparison rules make bounds checking alone unsound:
--
--   * NaN sorts GREATER than every non-NaN value. So `NaN > c_max_money` is
--     TRUE — a not-a-number reaches the "too large" branch and is reported as
--     an oversized order rather than an invalid one, and any check written as
--     `if v < 0` silently passes it.
--   * NaN = NaN is TRUE (unlike IEEE-754 float). So neither `v <> v` nor
--     `v <> trunc(v)` detects NaN, and the usual float idiom does not port.
--
-- Every guard below therefore uses an explicit predicate on the CANONICAL TEXT
-- form:
--
--     v is null or v::text in ('NaN', 'Infinity', '-Infinity')
--
-- numeric_out emits exactly those three spellings regardless of how the value
-- was written, so 'nan', 'NAN', 'inf', '+inf', '+Infinity', 'INFINITY' and any
-- surrounding whitespace all normalize into one of them and are rejected
-- consistently. This form also works unchanged on PostgreSQL 13 and earlier,
-- where the literal 'Infinity'::numeric would itself raise — so the guard can
-- never become the error it is meant to prevent.
--
-- These values ARE transportable from a client: JSON has no NaN or Infinity
-- literal (JSON.stringify(NaN) yields null), but a JSON STRING survives
-- PostgREST's cast — {"p_tip_amount": "NaN"} and {"quantity": "Infinity"} both
-- arrive as real special numerics. A project's own config JSONB can likewise
-- hold "price": "NaN", since an owner may write projects.config directly under
-- RLS. Defended in SQL regardless of what any client is believed to send.
--
-- NOT IN SCOPE: order-number uniqueness (Migration D), restock_inventory and
-- adjust_inventory (unchanged, still SECURITY INVOKER, still owner-only — both
-- derive auth.uid() and filter `AND user_id = v_user_id` themselves, so a device
-- calling them fails), and any Android or pairing UI change.

create or replace function public.complete_sale(
  p_project_id uuid,
  p_order_number text,
  p_payment_method text,
  p_subtotal numeric,
  p_tax_amount numeric,
  p_tip_amount numeric,
  p_total numeric,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path to public, pg_temp
as $function$
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
    total
  )
  values (
    v_owner_id,          -- the RESOLVED owner, never the caller, never a device
    p_project_id,
    p_order_number,
    p_payment_method,
    v_subtotal,
    v_tax_amount,
    v_tip_amount,
    v_total
  )
  returning id into v_order_id;

  -- Exactly one row per requested item, guaranteed by the duplicate rejection.
  insert into public.order_items (
    order_id,
    item_id,
    item_name,
    unit_price,
    quantity,
    line_total
  )
  select
    v_order_id,
    line ->> 'item_id',
    line ->> 'item_name',
    (line ->> 'unit_price')::numeric,
    (line ->> 'quantity')::integer,
    (line ->> 'line_total')::numeric
  from jsonb_array_elements(v_lines) as line;

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

-- ----------------------------------------------------------------------------
-- Privileges.
--
-- CREATE OR REPLACE preserves the privileges of the function it replaces, so
-- these are restated rather than assumed. service_role's EXECUTE is REVOKED: no
-- server-side code calls complete_sale (lib/orders.ts uses the browser client),
-- and a postgres-owned SECURITY DEFINER function reachable by service_role is a
-- privilege-amplification path with no consumer. This is a deliberate reduction
-- from the posture captured in 20260803201210.
-- ----------------------------------------------------------------------------
revoke all on function public.complete_sale(uuid, text, text, numeric, numeric, numeric, numeric, jsonb) from public;
revoke all on function public.complete_sale(uuid, text, text, numeric, numeric, numeric, numeric, jsonb) from anon;
revoke all on function public.complete_sale(uuid, text, text, numeric, numeric, numeric, numeric, jsonb) from service_role;
grant execute on function public.complete_sale(uuid, text, text, numeric, numeric, numeric, numeric, jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- Verification — fails loudly rather than leaving a half-converted checkout.
--
-- The overload is resolved with to_regprocedure, NOT by comparing
-- pg_get_function_identity_arguments() to a hand-written string: identity
-- arguments are rendered WITH PARAMETER NAMES, and that mistake already cost one
-- false failure during Migration B.
-- ----------------------------------------------------------------------------
do $$
declare
  v_oid oid;
begin
  v_oid := to_regprocedure(
    'public.complete_sale(uuid,text,text,numeric,numeric,numeric,numeric,jsonb)'
  );

  if v_oid is null then
    raise exception 'Migration C: complete_sale exact overload is missing';
  end if;

  if (select pg_get_function_result(v_oid)) <> 'uuid' then
    raise exception 'Migration C: complete_sale must still return uuid';
  end if;

  if not (select p.prosecdef from pg_proc p where p.oid = v_oid) then
    raise exception 'Migration C: complete_sale must be SECURITY DEFINER';
  end if;

  -- Matched with LIKE so the assertion cannot break on how the deparser spaces
  -- the SET clause.
  if not exists (
    select 1
    from pg_proc p,
         unnest(coalesce(p.proconfig, array[]::text[])) as cfg
    where p.oid = v_oid
      and cfg like 'search_path=%public%pg_temp%'
  ) then
    raise exception 'Migration C: complete_sale must lock search_path to public, pg_temp';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_language l on l.oid = p.prolang
    where p.oid = v_oid and l.lanname = 'plpgsql'
  ) then
    raise exception 'Migration C: complete_sale must remain LANGUAGE plpgsql';
  end if;

  if not has_function_privilege('authenticated', v_oid, 'EXECUTE') then
    raise exception 'Migration C: authenticated must hold EXECUTE on complete_sale';
  end if;

  if has_function_privilege('anon', v_oid, 'EXECUTE') then
    raise exception 'Migration C: anon must not hold EXECUTE on complete_sale';
  end if;

  if has_function_privilege('service_role', v_oid, 'EXECUTE') then
    raise exception 'Migration C: service_role must not hold EXECUTE on complete_sale';
  end if;

  if exists (
    select 1 from information_schema.routine_privileges
    where specific_schema = 'public'
      and routine_name = 'complete_sale'
      and grantee = 'PUBLIC'
      and privilege_type = 'EXECUTE'
  ) then
    raise exception 'Migration C: complete_sale must not be executable by PUBLIC';
  end if;

  -- resolve_sale_owner must still exist and stay SECURITY DEFINER, since this
  -- function's entire authorization model delegates to it.
  if to_regprocedure('public.resolve_sale_owner(uuid)') is null then
    raise exception 'Migration C: resolve_sale_owner is missing';
  end if;

  if not (
    select p.prosecdef from pg_proc p
    where p.oid = to_regprocedure('public.resolve_sale_owner(uuid)')
  ) then
    raise exception 'Migration C: resolve_sale_owner must remain SECURITY DEFINER';
  end if;

  -- restock_inventory and adjust_inventory must be untouched by this migration.
  if (select p.prosecdef from pg_proc p
      where p.oid = to_regprocedure('public.restock_inventory(uuid,text,integer)')) then
    raise exception 'Migration C: restock_inventory must remain SECURITY INVOKER';
  end if;

  if (select p.prosecdef from pg_proc p
      where p.oid = to_regprocedure('public.adjust_inventory(uuid,text,integer)')) then
    raise exception 'Migration C: adjust_inventory must remain SECURITY INVOKER';
  end if;
end $$;
