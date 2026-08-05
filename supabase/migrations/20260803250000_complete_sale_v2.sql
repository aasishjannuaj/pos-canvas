-- Milestone 16, Feature 16.3 — Migration D3
-- complete_sale_v2: transactional order numbers, idempotent checkout, and an
-- authoritative receipt payload.
--
-- ADDITIVE ONLY. complete_sale v1 is not replaced, altered, granted or revoked
-- anywhere in this file, so the currently deployed web app and any stale open
-- tab keep working unchanged. restock_inventory and adjust_inventory are
-- untouched. No table privilege changes; the only new grant is EXECUTE on v2.
--
-- WHAT v2 ADDS OVER v1
--   * The client no longer supplies an order number. The server derives the
--     prefix from the authorized pricing source and allocates the numeric
--     suffix from project_order_counters inside the same transaction.
--   * Idempotency: a client-generated p_sale_request_id plus a server-computed
--     canonical hash. Same id + same hash replays the original receipt; same id
--     + different hash is a controlled error, never someone else's receipt.
--   * The return value is the authoritative receipt payload, so the printed
--     receipt can no longer disagree with what was stored.
--
-- WHAT v2 KEEPS FROM MIGRATION C, UNCHANGED
--   auth.uid() read once as the caller; resolve_sale_owner as the only
--   authorization; the project ownership predicate on the locked SELECT and the
--   final UPDATE; owner -> locked live config, device -> pinned succeeded
--   snapshot; inventory always from the locked live config; duplicate item
--   rejection; quantity bounds; server-derived names and prices; the
--   canonical-text special-numeric predicate; money bounds against
--   numeric(12,2); all three tax modes and the same rounding points; owner tip
--   support and device tip rejection; owner stamping on orders and
--   inventory_transactions; one atomic transaction; controlled errors only.
--
-- CANONICAL REQUEST FORMAT (preimage of sale_request_hash)
--
--   posc.sale.v1\n
--   project=<uuid>\n
--   payment=<cash|card>\n
--   tip=<round(tip,2)::text>\n
--   items=<count>[\n<octet_length(id)>:<id>=<qty> ...]
--
--   Item lines are ordered by item id under COLLATE "C" (byte order), so the
--   same cart in any submission order yields the same preimage. Each id carries
--   an explicit octet-length prefix, which makes the concatenation injective —
--   an id containing '=', ':' or a newline cannot be re-read as a different
--   (id, quantity) pairing. numeric::text is used rather than to_char because
--   numeric output is locale-independent; to_char's decimal separator is not.
--
--   The hash covers ONLY client-authoritative intent: project, payment method,
--   normalized tip, and the normalized item ids and quantities. It deliberately
--   excludes every server-derived value — item names, unit prices, line totals,
--   subtotal, tax, total and the generated order number — so a replay is
--   recognised as the same intent even after the menu or its prices change.
--
--   lib/saleCanonical.ts models this format and pins cross-checked fixtures.

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
-- Verification.
-- ----------------------------------------------------------------------------
do $$
declare
  v_v2 oid;
  v_v1 oid;
begin
  v_v2 := to_regprocedure('public.complete_sale_v2(uuid,text,numeric,jsonb,uuid)');
  if v_v2 is null then
    raise exception 'D3: complete_sale_v2 was not created';
  end if;

  if (select pg_get_function_result(v_v2)) <> 'jsonb' then
    raise exception 'D3: complete_sale_v2 must return jsonb';
  end if;
  if not (select p.prosecdef from pg_proc p where p.oid = v_v2) then
    raise exception 'D3: complete_sale_v2 must be SECURITY DEFINER';
  end if;
  if not exists (
    select 1 from pg_proc p, unnest(coalesce(p.proconfig, array[]::text[])) cfg
    where p.oid = v_v2 and cfg like 'search_path=%public%pg_temp%'
  ) then
    raise exception 'D3: complete_sale_v2 must lock search_path';
  end if;
  if not has_function_privilege('authenticated', v_v2, 'EXECUTE') then
    raise exception 'D3: authenticated must hold EXECUTE on complete_sale_v2';
  end if;
  if has_function_privilege('anon', v_v2, 'EXECUTE') then
    raise exception 'D3: anon must not hold EXECUTE on complete_sale_v2';
  end if;
  if has_function_privilege('service_role', v_v2, 'EXECUTE') then
    raise exception 'D3: service_role must not hold EXECUTE on complete_sale_v2';
  end if;

  -- v1 must still exist, unchanged in posture, and still executable.
  v_v1 := to_regprocedure(
    'public.complete_sale(uuid,text,text,numeric,numeric,numeric,numeric,jsonb)'
  );
  if v_v1 is null then
    raise exception 'D3: complete_sale v1 must remain available';
  end if;
  if not (select p.prosecdef from pg_proc p where p.oid = v_v1) then
    raise exception 'D3: complete_sale v1 must remain SECURITY DEFINER';
  end if;
  if not has_function_privilege('authenticated', v_v1, 'EXECUTE') then
    raise exception 'D3: complete_sale v1 must keep EXECUTE for authenticated';
  end if;
  if (select pg_get_function_result(v_v1)) <> 'uuid' then
    raise exception 'D3: complete_sale v1 must still return uuid';
  end if;

  if (select p.prosecdef from pg_proc p
      where p.oid = to_regprocedure('public.restock_inventory(uuid,text,integer)')) then
    raise exception 'D3: restock_inventory must remain SECURITY INVOKER';
  end if;
  if (select p.prosecdef from pg_proc p
      where p.oid = to_regprocedure('public.adjust_inventory(uuid,text,integer)')) then
    raise exception 'D3: adjust_inventory must remain SECURITY INVOKER';
  end if;

  if has_table_privilege('authenticated', 'public.project_order_counters', 'SELECT')
     or has_table_privilege('service_role', 'public.project_order_counters', 'SELECT')
     or has_table_privilege('anon', 'public.project_order_counters', 'SELECT') then
    raise exception 'D3: project_order_counters must remain unreachable by application roles';
  end if;
end $$;
