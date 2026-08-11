-- Milestone 18, Feature 18.1 — Modifier contract and complete_sale_v3.
--
-- SCOPE: one additive column, one new function, and one fail-closed guard on
-- an existing function. No table is dropped, no grant is widened, no policy
-- changes, no trigger changes, and no existing migration file is touched.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES
-- ----------------------------------------------------------------------------
--   1. order_items.modifiers  — a defaulted JSONB snapshot column, so an order
--      line records what the customer chose and what it cost AT SALE TIME.
--
--   2. complete_sale_v3       — a modifier-aware checkout. Built from v2's
--      audited body by targeted replacement, so every part not listed below is
--      byte-identical to the function that has been in production since D3.
--
--   3. complete_sale_v2       — UNCHANGED except for one added guard that
--      refuses a product carrying modifier groups. v2 stays callable so a
--      stale browser tab and a device on an old pinned build keep working.
--
-- ----------------------------------------------------------------------------
-- WHY v2 MUST BE GUARDED RATHER THAN LEFT ALONE
-- ----------------------------------------------------------------------------
-- v2 prices from `menuItems[].price` and knows nothing about modifierGroups.
-- Left untouched, it would happily sell a burger with three paid add-ons at the
-- plain burger price, and the kitchen would never learn the customer wanted
-- bacon. That is a silent undercharge and a wrong order, which is strictly
-- worse than a refusal. The guard cannot reject anything v2 was going to price
-- correctly: it fires only when modifierGroups is a non-empty array, which no
-- pre-Feature-18 config contains.
--
-- ----------------------------------------------------------------------------
-- EXACTLY WHAT DIFFERS BETWEEN v2 AND v3
-- ----------------------------------------------------------------------------
--   * section 1  — modifier payload shape and size caps; v2's duplicate-itemId
--                  rule removed (it is replaced, not dropped — see section 5).
--   * section 5  — canonical LINE identity (item + selection), duplicate-line
--                  rejection, and the new 'posc.sale.v2' preimage header.
--   * section 8  — modifier resolution, validation and pricing from the
--                  authorized config; snapshot construction.
--   * section 11 — the snapshot is persisted on order_items.
--   * section 12 — the snapshot is returned in the authoritative receipt.
--
-- Everything else — auth resolution, resolve_sale_owner, the project FOR UPDATE
-- lock, the device revocation check, pinned-build authorization, tip rules,
-- idempotency lookup and hash-mismatch rejection, live-config inventory
-- validation, order-number allocation, the atomic write, append-only inventory
-- audit rows, money bounds, tax modes and rounding points, and the single
-- payload construction path — is carried over unmodified.

-- ----------------------------------------------------------------------------
-- ATOMICITY — READ THIS BEFORE APPLYING
-- ----------------------------------------------------------------------------
-- This migration is wrapped in an EXPLICIT transaction, unlike every earlier
-- migration in this repository.
--
-- Why the change: the verification block is the LAST statement, and everything
-- before it includes `create or replace function public.complete_sale_v2` —
-- the checkout function every live till calls right now. Without an enclosing
-- transaction, a verification failure would leave production carrying a
-- modified v2, a new v3 and a new column, with nothing rolled back. "Fails
-- loudly" is not the same as "fails safely".
--
-- Earlier migrations relied on the SQL Editor running a submission as one
-- SESSION (which is all their temp-table baselines needed). That is a weaker
-- guarantee than one TRANSACTION, and it is not one this migration can lean on,
-- because this migration mutates a function that is in production use.
--
-- Every statement here is transaction-safe: no CREATE INDEX CONCURRENTLY, no
-- VACUUM, no ALTER TYPE ... ADD VALUE. The ADD COLUMN uses a constant default,
-- so PostgreSQL records it in the catalog without rewriting the table and the
-- ACCESS EXCLUSIVE lock is held only briefly.
--
-- If your tool already opens a transaction for the submission, remove the
-- BEGIN/COMMIT below rather than nesting them.
-- ----------------------------------------------------------------------------

begin;

-- ----------------------------------------------------------------------------
-- 1. Historical modifier snapshot.
--
-- JSONB rather than a child table: this data is only ever read alongside its
-- parent line, never queried independently. A separate table would need its own
-- RLS policies, its own grants, its own D1 privilege-matrix entry and a join in
-- every history query, to store something that is conceptually part of the line.
--
-- NOT NULL DEFAULT '[]' means every historical row becomes a valid no-modifier
-- line without being rewritten, and no reader has to handle NULL.
-- ----------------------------------------------------------------------------
alter table public.order_items
  add column if not exists modifiers jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'order_items_modifiers_is_array_check'
  ) then
    alter table public.order_items
      add constraint order_items_modifiers_is_array_check
      check (jsonb_typeof(modifiers) = 'array');
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2. complete_sale_v2 — fail-closed for modifier-bearing products.
-- ----------------------------------------------------------------------------
create or replace function public.complete_sale_v2(
  p_project_id uuid,
  p_payment_method text,
  p_tip_amount numeric,
  p_items jsonb,
  p_sale_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to public, pg_temp
as $function$
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
        number_source, sale_request_id, sale_request_hash
      )
      values (
        v_owner_id, p_project_id, v_order_number, v_method,
        v_subtotal, v_tax_amount, v_tip_amount, v_total,
        'server', p_sale_request_id, v_hash
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
        order_id, item_id, item_name, unit_price, quantity, line_total
      )
      select v_order_id, line ->> 'item_id', line ->> 'item_name',
             (line ->> 'unit_price')::numeric, (line ->> 'quantity')::integer,
             (line ->> 'line_total')::numeric
      from jsonb_array_elements(v_lines) as line;

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
                      order by oi.item_id collate "C"
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
revoke all on function public.complete_sale_v2(uuid, text, numeric, jsonb, uuid) from public;
revoke all on function public.complete_sale_v2(uuid, text, numeric, jsonb, uuid) from anon;
revoke all on function public.complete_sale_v2(uuid, text, numeric, jsonb, uuid) from service_role;
grant execute on function public.complete_sale_v2(uuid, text, numeric, jsonb, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 3. complete_sale_v3 — modifier-aware checkout.
-- ----------------------------------------------------------------------------
create or replace function public.complete_sale_v3(
  p_project_id uuid,
  p_payment_method text,
  p_tip_amount numeric,
  p_items jsonb,
  p_sale_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to public, pg_temp
as $function$
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
        number_source, sale_request_id, sale_request_hash
      )
      values (
        v_owner_id, p_project_id, v_order_number, v_method,
        v_subtotal, v_tax_amount, v_tip_amount, v_total,
        'server', p_sale_request_id, v_hash
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
        order_id, item_id, item_name, unit_price, quantity, line_total, modifiers
      )
      select v_order_id, line ->> 'item_id', line ->> 'item_name',
             (line ->> 'unit_price')::numeric, (line ->> 'quantity')::integer,
             (line ->> 'line_total')::numeric,
             coalesce(line -> 'modifiers', '[]'::jsonb)
      from jsonb_array_elements(v_lines) as line;

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
                      order by oi.item_id collate "C"
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
-- Identical posture to v2: SECURITY DEFINER, locked search_path, executable by
-- authenticated only. service_role is revoked deliberately — the worker and
-- every other privileged path must never be able to complete a sale.
revoke all on function public.complete_sale_v3(uuid, text, numeric, jsonb, uuid) from public;
revoke all on function public.complete_sale_v3(uuid, text, numeric, jsonb, uuid) from anon;
revoke all on function public.complete_sale_v3(uuid, text, numeric, jsonb, uuid) from service_role;
grant execute on function public.complete_sale_v3(uuid, text, numeric, jsonb, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 4. Verification — fails loudly rather than leaving a half-applied checkout.
-- ----------------------------------------------------------------------------
do $$
declare
  v_v3 oid;
  v_v2 oid;
  v_v1 oid;
begin
  -- ---- the modifier column exists, is defaulted, and is array-constrained ---
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_items'
      and column_name = 'modifiers' and data_type = 'jsonb'
      and is_nullable = 'NO'
  ) then
    raise exception '18.1: order_items.modifiers is missing or nullable';
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'order_items_modifiers_is_array_check'
  ) then
    raise exception '18.1: order_items_modifiers_is_array_check is missing';
  end if;

  -- Every pre-existing row must have become an empty array, not NULL.
  if exists (select 1 from public.order_items where modifiers is null) then
    raise exception '18.1: an order_items row has a null modifiers value';
  end if;

  -- ---- v3 exists with the required posture ---------------------------------
  v_v3 := to_regprocedure('public.complete_sale_v3(uuid,text,numeric,jsonb,uuid)');
  if v_v3 is null then
    raise exception '18.1: complete_sale_v3 was not created';
  end if;

  if (select pg_get_function_result(v_v3)) <> 'jsonb' then
    raise exception '18.1: complete_sale_v3 must return jsonb';
  end if;
  if not (select p.prosecdef from pg_proc p where p.oid = v_v3) then
    raise exception '18.1: complete_sale_v3 must be SECURITY DEFINER';
  end if;
  if (select pg_get_userbyid(p.proowner) from pg_proc p where p.oid = v_v3) <> 'postgres' then
    raise exception '18.1: complete_sale_v3 must be owned by postgres';
  end if;
  if not exists (
    select 1 from pg_proc p, unnest(coalesce(p.proconfig, array[]::text[])) cfg
    where p.oid = v_v3 and cfg like 'search_path=%public%pg_temp%'
  ) then
    raise exception '18.1: complete_sale_v3 must lock search_path';
  end if;
  if not has_function_privilege('authenticated', v_v3, 'EXECUTE') then
    raise exception '18.1: authenticated must hold EXECUTE on complete_sale_v3';
  end if;
  if has_function_privilege('anon', v_v3, 'EXECUTE') then
    raise exception '18.1: anon must not hold EXECUTE on complete_sale_v3';
  end if;
  if has_function_privilege('service_role', v_v3, 'EXECUTE') then
    raise exception '18.1: service_role must not hold EXECUTE on complete_sale_v3';
  end if;

  -- ---- v2 survives, still executable, still guarded -------------------------
  v_v2 := to_regprocedure('public.complete_sale_v2(uuid,text,numeric,jsonb,uuid)');
  if v_v2 is null then
    raise exception '18.1: complete_sale_v2 must remain available';
  end if;
  if not has_function_privilege('authenticated', v_v2, 'EXECUTE') then
    raise exception '18.1: authenticated must still hold EXECUTE on complete_sale_v2';
  end if;
  if has_function_privilege('service_role', v_v2, 'EXECUTE') then
    raise exception '18.1: service_role must not hold EXECUTE on complete_sale_v2';
  end if;
  if (select p.prosrc from pg_proc p where p.oid = v_v2) not like '%This item now has options%' then
    raise exception '18.1: complete_sale_v2 is missing the modifier fail-closed guard';
  end if;

  -- ---- v1 is untouched ------------------------------------------------------
  v_v1 := to_regprocedure(
    'public.complete_sale(uuid,text,text,numeric,numeric,numeric,numeric,jsonb)'
  );
  if v_v1 is null then
    raise exception '18.1: complete_sale v1 must remain available';
  end if;

  -- ---- v3 carries the properties that make it safe --------------------------
  if (select p.prosrc from pg_proc p where p.oid = v_v3) not like '%posc.sale.v2%' then
    raise exception '18.1: complete_sale_v3 must use the v2 canonical preimage';
  end if;
  if (select p.prosrc from pg_proc p where p.oid = v_v3) like '%posc.sale.v1%' then
    raise exception '18.1: complete_sale_v3 must not reuse the v1 preimage';
  end if;
  if (select p.prosrc from pg_proc p where p.oid = v_v3) not like '%resolve_sale_owner%' then
    raise exception '18.1: complete_sale_v3 lost its authorization step';
  end if;
  if (select p.prosrc from pg_proc p where p.oid = v_v3) not like '%for update%' then
    raise exception '18.1: complete_sale_v3 lost the project lock';
  end if;
  if (select p.prosrc from pg_proc p where p.oid = v_v3) not like '%revoked_at is null%' then
    raise exception '18.1: complete_sale_v3 lost the device revocation check';
  end if;
  if (select p.prosrc from pg_proc p where p.oid = v_v3) not like '%sale_request_hash%' then
    raise exception '18.1: complete_sale_v3 lost idempotency';
  end if;

  -- ---- v1/v2 canonical format is untouched ----------------------------------
  if (select p.prosrc from pg_proc p where p.oid = v_v2) not like '%posc.sale.v1%' then
    raise exception '18.1: complete_sale_v2 canonical format changed';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- Nothing above this line is durable until COMMIT. A raise inside the
-- verification block aborts the transaction and leaves production exactly as it
-- was: original v2, no v3, no modifiers column.
-- ----------------------------------------------------------------------------
commit;
