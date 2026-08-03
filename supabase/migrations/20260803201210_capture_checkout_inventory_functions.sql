-- Feature 16.3, Migration A — capture the live checkout/inventory functions
-- into version control.
--
-- PURPOSE: bring three functions that exist ONLY in the live database under
-- source control, with ZERO behavioral change. This migration is a faithful
-- transcription, not a redesign. Every device-authorization, pricing, and
-- integrity change is deliberately deferred to later migrations (C and D).
--
-- PROVENANCE: each body below is the verbatim output of
--   SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n
--     ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname IN ('complete_sale','restock_inventory','adjust_inventory');
-- exported from the Supabase SQL editor on 2026-08-03 and transcribed
-- programmatically (CSV-parsed, so the export's doubled quotation marks are
-- correctly unescaped back to single quotes — see adjust_inventory's
-- "Menu item not found" comment).
--
-- SECURITY POSTURE PRESERVED EXACTLY (verified against pg_proc / pg_get_userbyid
-- / information_schema.routine_privileges):
--   * SECURITY INVOKER for all three. INVOKER is PostgreSQL's default and is
--     therefore ABSENT from pg_get_functiondef output — its absence below is
--     correct and load-bearing. Do NOT add SECURITY DEFINER here; converting
--     complete_sale to DEFINER is Migration C's job, reviewed separately.
--     Because these run as INVOKER, the RLS policies on projects / orders /
--     order_items / inventory_transactions are part of their observable
--     behavior.
--   * SET search_path TO 'public' on all three (guards against search-path
--     hijack).
--   * Owner: postgres. Volatility: VOLATILE. Return types unchanged
--     (complete_sale -> uuid, restock_inventory -> jsonb,
--     adjust_inventory -> jsonb).
--
-- WHY CREATE OR REPLACE IS SAFE HERE: no signature or return type changes, so
-- REPLACE cannot fail on an incompatible-result-type error. On the live
-- database this is a no-op replacement of identical source; on a fresh
-- rebuild it creates the functions.
--
-- WHY THE GRANTS ARE RESTATED: CREATE OR REPLACE preserves existing privileges
-- when replacing, but a fresh CREATE grants EXECUTE to PUBLIC by default.
-- Restating the revokes/grants makes this migration produce the same posture
-- in both cases. Observed live posture is EXECUTE for authenticated, postgres
-- and service_role only -- no anon, no PUBLIC. Both authenticated and
-- service_role are granted explicitly below so the posture is fully declared
-- in source rather than inherited from Supabase role defaults. postgres is
-- the function owner and holds EXECUTE implicitly, so it needs no grant.
--
-- This migration is NOT applied automatically -- review, then apply manually,
-- exactly like every other migration in this directory.

-- --------------------------------------------------------------------------
-- complete_sale -- the runtime checkout path (browser anon-key client ->
-- supabase.rpc('complete_sale', ...) from lib/orders.ts).
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_sale(p_project_id uuid, p_order_number text, p_payment_method text, p_subtotal numeric, p_tax_amount numeric, p_tip_amount numeric, p_total numeric, p_items jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid;
  v_order_id uuid;

  v_config jsonb;
  v_menu_items jsonb;
  v_updated_menu_items jsonb;

  v_cart_item jsonb;
  v_menu_item jsonb;

  v_item_id text;
  v_item_name text;
  v_unit_price numeric;
  v_quantity integer;
  v_line_total numeric;

  v_track_inventory boolean;
  v_stock_before integer;
  v_stock_after integer;

  v_found boolean;
  i integer;
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if p_project_id is null then
    raise exception 'Project ID is required';
  end if;

  if p_order_number is null or btrim(p_order_number) = '' then
    raise exception 'Order number is required';
  end if;

  if p_payment_method not in ('cash', 'card') then
    raise exception 'Invalid payment method';
  end if;

  if p_subtotal < 0
     or p_tax_amount < 0
     or p_tip_amount < 0
     or p_total < 0 then
    raise exception 'Order amounts cannot be negative';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one order item is required';
  end if;

  /*
   * Lock the project row so concurrent sales cannot deduct from
   * the same inventory quantity at the same time.
   */
  select config
  into v_config
  from public.projects
  where id = p_project_id
    and user_id = v_user_id
  for update;

  if not found then
    raise exception 'Project not found or access denied';
  end if;

  v_menu_items := coalesce(v_config->'menuItems', '[]'::jsonb);
  v_updated_menu_items := v_menu_items;

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
    v_user_id,
    p_project_id,
    p_order_number,
    p_payment_method,
    round(p_subtotal, 2),
    round(p_tax_amount, 2),
    round(p_tip_amount, 2),
    round(p_total, 2)
  )
  returning id into v_order_id;

  for v_cart_item in
    select value
    from jsonb_array_elements(p_items)
  loop
    v_item_id := v_cart_item->>'itemId';
    v_item_name := v_cart_item->>'name';

    if coalesce(v_item_id, '') = ''
       or coalesce(v_item_name, '') = '' then
      raise exception 'Invalid order item';
    end if;

    begin
      v_quantity := (v_cart_item->>'quantity')::integer;
      v_unit_price := (v_cart_item->>'price')::numeric;
    exception
      when invalid_text_representation then
        raise exception 'Invalid quantity or price for %', v_item_name;
    end;

    if v_quantity <= 0 or v_unit_price < 0 then
      raise exception 'Invalid order item quantity or price';
    end if;

    v_line_total := round(v_unit_price * v_quantity, 2);
    v_found := false;

    /*
     * Search the project's current menu configuration.
     * v_updated_menu_items is used so duplicate cart lines for the
     * same item see the quantity deducted by earlier lines.
     */
    if jsonb_array_length(v_updated_menu_items) > 0 then
      for i in 0 .. jsonb_array_length(v_updated_menu_items) - 1
      loop
        v_menu_item := v_updated_menu_items->i;

        if v_menu_item->>'id' = v_item_id then
          v_found := true;

          v_track_inventory :=
            coalesce((v_menu_item->>'trackInventory')::boolean, false);

          if v_track_inventory then
            begin
              v_stock_before :=
                coalesce((v_menu_item->>'stockQuantity')::integer, 0);
            exception
              when invalid_text_representation then
                raise exception 'Invalid inventory quantity for %', v_item_name;
            end;

            if v_stock_before < v_quantity then
              raise exception 'Insufficient inventory for %', v_item_name;
            end if;

            v_stock_after := v_stock_before - v_quantity;

            v_updated_menu_items := jsonb_set(
              v_updated_menu_items,
              array[i::text, 'stockQuantity'],
              to_jsonb(v_stock_after),
              true
            );

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
            values (
              v_user_id,
              p_project_id,
              v_order_id,
              v_item_id,
              v_item_name,
              'sale',
              -v_quantity,
              v_stock_before,
              v_stock_after
            );
          end if;

          exit;
        end if;
      end loop;
    end if;

    /*
     * Do not allow a stale or deleted menu item to be sold.
     * Otherwise an order could be recorded without inventory handling.
     */
    if not v_found then
      raise exception 'Menu item not found for %', v_item_name;
    end if;

    insert into public.order_items (
      order_id,
      item_id,
      item_name,
      unit_price,
      quantity,
      line_total
    )
    values (
      v_order_id,
      v_item_id,
      v_item_name,
      round(v_unit_price, 2),
      v_quantity,
      v_line_total
    );
  end loop;

  update public.projects
  set config = jsonb_set(
        v_config,
        '{menuItems}',
        v_updated_menu_items,
        true
      ),
      updated_at = now()
  where id = p_project_id
    and user_id = v_user_id;

  if not found then
    raise exception 'Failed to update project inventory';
  end if;

  return v_order_id;
end;
$function$;

revoke all on function public.complete_sale(uuid, text, text, numeric, numeric, numeric, numeric, jsonb) from public;
revoke all on function public.complete_sale(uuid, text, text, numeric, numeric, numeric, numeric, jsonb) from anon;
grant execute on function public.complete_sale(uuid, text, text, numeric, numeric, numeric, numeric, jsonb) to authenticated;
grant execute on function public.complete_sale(uuid, text, text, numeric, numeric, numeric, numeric, jsonb) to service_role;

-- --------------------------------------------------------------------------
-- restock_inventory -- Builder-only stock increase. Stays owner-only.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.restock_inventory(p_project_id uuid, p_item_id text, p_quantity integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid;
  v_config jsonb;
  v_menu_items jsonb;
  v_menu_item jsonb;
  v_item_index int;
  v_item_name text;
  v_track_inventory boolean;
  v_stock_before int;
  v_stock_after int;
  v_transaction_id uuid;
  i int;
BEGIN
  -- 2. Authentication
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- 3. Basic input validation
  IF p_project_id IS NULL THEN
    RAISE EXCEPTION 'Project id is required';
  END IF;

  IF p_item_id IS NULL OR btrim(p_item_id) = '' THEN
    RAISE EXCEPTION 'Item id is required';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero';
  END IF;

  -- 4. Lock the project row for the rest of this transaction and confirm
  -- the caller owns it, in one query.
  SELECT config INTO v_config
  FROM public.projects
  WHERE id = p_project_id
    AND user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Project not found or access denied';
  END IF;

  v_menu_items := COALESCE(v_config->'menuItems', '[]'::jsonb);

  -- 5. Find the menu item by id, keeping its array index.
  v_item_index := NULL;

  FOR i IN 0 .. jsonb_array_length(v_menu_items) - 1
  LOOP
    IF (v_menu_items -> i) ->> 'id' = p_item_id THEN
      v_item_index := i;
      v_menu_item := v_menu_items -> i;
      EXIT;
    END IF;
  END LOOP;

  IF v_item_index IS NULL THEN
    RAISE EXCEPTION 'Menu item not found';
  END IF;

  -- 6. Inventory validation (revised: safe casts, no crash on malformed data).
  v_item_name := coalesce(nullif(v_menu_item->>'name', ''), p_item_id);

  begin
    v_track_inventory :=
      coalesce((v_menu_item->>'trackInventory')::boolean, false);
  exception
    when invalid_text_representation then
      raise exception 'Inventory tracking value for % is invalid', v_item_name;
  end;

  if not v_track_inventory then
    raise exception 'Inventory tracking is not enabled for %', v_item_name;
  end if;

  if not (v_menu_item ? 'stockQuantity')
     or v_menu_item->'stockQuantity' = 'null'::jsonb then
    v_stock_before := 0;
  else
    begin
      v_stock_before := (v_menu_item->>'stockQuantity')::integer;
    exception
      when invalid_text_representation
        or numeric_value_out_of_range then
          raise exception 'Stock quantity for % is not a valid whole number',
            v_item_name;
    end;
  end if;

  if v_stock_before < 0 then
    raise exception 'Stock quantity for % cannot be negative', v_item_name;
  end if;

  -- 7. Compute the restock and write it back into the in-memory config
  -- only, touching nothing else in the structure yet.
  v_stock_after := v_stock_before + p_quantity;

  v_menu_items := jsonb_set(
    v_menu_items,
    array[v_item_index::text, 'stockQuantity'],
    to_jsonb(v_stock_after),
    true
  );

  -- 8. Record the inventory transaction.
  INSERT INTO public.inventory_transactions (
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
  VALUES (
    v_user_id,
    p_project_id,
    NULL,
    p_item_id,
    v_item_name,
    'restock',
    p_quantity,
    v_stock_before,
    v_stock_after
  )
  RETURNING id INTO v_transaction_id;

  -- 9. Persist the updated config in a single write, then confirm it
  -- actually took effect.
  update public.projects
  set config = jsonb_set(
        v_config,
        '{menuItems}',
        v_menu_items,
        true
      ),
      updated_at = now()
  where id = p_project_id
    and user_id = v_user_id;

  if not found then
    raise exception 'Failed to update project inventory';
  end if;

  RETURN jsonb_build_object(
    'transaction_id', v_transaction_id,
    'item_id', p_item_id,
    'item_name', v_item_name,
    'quantity_before', v_stock_before,
    'quantity_change', p_quantity,
    'quantity_after', v_stock_after
  );
END;
$function$;

revoke all on function public.restock_inventory(uuid, text, integer) from public;
revoke all on function public.restock_inventory(uuid, text, integer) from anon;
grant execute on function public.restock_inventory(uuid, text, integer) to authenticated;
grant execute on function public.restock_inventory(uuid, text, integer) to service_role;

-- --------------------------------------------------------------------------
-- adjust_inventory -- Builder-only absolute stock set. Stays owner-only.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.adjust_inventory(p_project_id uuid, p_item_id text, p_new_quantity integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid;
  v_config jsonb;
  v_menu_items jsonb;
  v_menu_item jsonb;
  v_item_index int;
  v_item_name text;
  v_track_inventory boolean;
  v_stock_before int;
  v_stock_after int;
  v_quantity_change int;
  v_transaction_id uuid;
  i int;
BEGIN
  -- 2. Authentication
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- 3. Basic input validation
  IF p_project_id IS NULL THEN
    RAISE EXCEPTION 'Project id is required';
  END IF;

  IF p_item_id IS NULL OR btrim(p_item_id) = '' THEN
    RAISE EXCEPTION 'Item id is required';
  END IF;

  IF p_new_quantity IS NULL THEN
    RAISE EXCEPTION 'New quantity is required';
  END IF;

  IF p_new_quantity < 0 THEN
    RAISE EXCEPTION 'New quantity cannot be negative';
  END IF;

  -- 4. Lock the project row for the rest of this transaction and confirm
  -- the caller owns it, in one query.
  SELECT config INTO v_config
  FROM public.projects
  WHERE id = p_project_id
    AND user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Project not found or access denied';
  END IF;

  -- 5. Safely read menuItems — never let a missing/null/non-array value
  -- reach jsonb_array_length and crash. Fall back to an empty array, which
  -- naturally resolves to "Menu item not found" below.
  IF v_config IS NULL THEN
    v_menu_items := '[]'::jsonb;
  ELSIF NOT (v_config ? 'menuItems') THEN
    v_menu_items := '[]'::jsonb;
  ELSIF jsonb_typeof(v_config->'menuItems') IS DISTINCT FROM 'array' THEN
    v_menu_items := '[]'::jsonb;
  ELSE
    v_menu_items := v_config->'menuItems';
  END IF;

  -- 6. Find the menu item by id, keeping its array index.
  v_item_index := NULL;

  FOR i IN 0 .. jsonb_array_length(v_menu_items) - 1
  LOOP
    IF (v_menu_items -> i) ->> 'id' = p_item_id THEN
      v_item_index := i;
      v_menu_item := v_menu_items -> i;
      EXIT;
    END IF;
  END LOOP;

  IF v_item_index IS NULL THEN
    RAISE EXCEPTION 'Menu item not found';
  END IF;

  v_item_name := coalesce(nullif(v_menu_item->>'name', ''), p_item_id);

  -- 7. Validate inventory tracking.
  begin
    v_track_inventory :=
      coalesce((v_menu_item->>'trackInventory')::boolean, false);
  exception
    when invalid_text_representation then
      raise exception 'Inventory tracking value for % is invalid', v_item_name;
  end;

  if not v_track_inventory then
    raise exception 'Inventory tracking is not enabled for %', v_item_name;
  end if;

  -- 8. Safely read existing stock (decimal-validation fix applied).
  if not (v_menu_item ? 'stockQuantity')
     or v_menu_item->'stockQuantity' = 'null'::jsonb then
    v_stock_before := 0;
  else
    if jsonb_typeof(v_menu_item->'stockQuantity') <> 'number'
       or (v_menu_item->>'stockQuantity') !~ '^-?[0-9]+$' then
      raise exception 'Stock quantity for % is not a valid whole number',
        v_item_name;
    end if;
    begin
      v_stock_before := (v_menu_item->>'stockQuantity')::integer;
    exception
      when invalid_text_representation
        or numeric_value_out_of_range then
          raise exception 'Stock quantity for % is not a valid whole number',
            v_item_name;
    end;
  end if;

  if v_stock_before < 0 then
    raise exception 'Stock quantity for % cannot be negative', v_item_name;
  end if;

  -- 9. The database is the sole source of truth for quantity_change — the
  -- caller only ever supplies the exact final quantity.
  v_stock_after := p_new_quantity;
  v_quantity_change := v_stock_after - v_stock_before;

  if v_quantity_change = 0 then
    raise exception 'New quantity must be different from current stock';
  end if;

  -- 10. Write the new value back into the in-memory config only, touching
  -- nothing else in the structure.
  v_menu_items := jsonb_set(
    v_menu_items,
    array[v_item_index::text, 'stockQuantity'],
    to_jsonb(v_stock_after),
    true
  );

  -- 11. Record the inventory transaction.
  INSERT INTO public.inventory_transactions (
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
  VALUES (
    v_user_id,
    p_project_id,
    NULL,
    p_item_id,
    v_item_name,
    'adjustment',
    v_quantity_change,
    v_stock_before,
    v_stock_after
  )
  RETURNING id INTO v_transaction_id;

  -- 12. Persist the updated config in a single write, then confirm it
  -- actually took effect.
  UPDATE public.projects
  SET config = jsonb_set(
        coalesce(v_config, '{}'::jsonb),
        '{menuItems}',
        v_menu_items,
        true
      ),
      updated_at = now()
  WHERE id = p_project_id
    AND user_id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Failed to update project inventory';
  END IF;

  RETURN jsonb_build_object(
    'transaction_id', v_transaction_id,
    'item_id', p_item_id,
    'item_name', v_item_name,
    'quantity_before', v_stock_before,
    'quantity_change', v_quantity_change,
    'quantity_after', v_stock_after
  );
END;
$function$;

revoke all on function public.adjust_inventory(uuid, text, integer) from public;
revoke all on function public.adjust_inventory(uuid, text, integer) from anon;
grant execute on function public.adjust_inventory(uuid, text, integer) to authenticated;
grant execute on function public.adjust_inventory(uuid, text, integer) to service_role;
