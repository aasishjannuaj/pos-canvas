-- Feature 25.2/25.3 — recent sales history for a paired device.
--
-- WHAT A CASHIER NEEDS. To look up the sale from ten minutes ago and reprint it.
-- Not analytics, not reports, not a date range: the last few sales this shop
-- made, and the receipt for one of them.
--
-- WHY AN RPC RATHER THAN AN RLS POLICY. `orders` is readable under
-- `auth.uid() = user_id`, and user_id is the OWNER — a device's anonymous
-- identity never matches, so a paired device sees nothing today. The fix could
-- be a device policy on `orders`, and that is exactly what this avoids: a policy
-- is evaluated for every reader forever, would have to restate the
-- active-pairing rule in a second place, and one mistake exposes another
-- business's takings. A definer function puts the same logic in one auditable
-- place with an explicit grant, which is the pattern every other device-facing
-- read in this schema already uses.
--
-- PROJECT-SCOPED, NOT DEVICE-SCOPED, and honestly so. `orders` has no device
-- column and never has; the only device-attributable link is sale_request_id,
-- which exists solely for sales this device queued offline. Pretending to offer
-- per-device history would mean inventing an attribution the data cannot
-- support. What this returns is "recent sales for this business", which is what
-- the schema can prove and what a cashier actually asks for.
--
-- READ-ONLY IN EVERY SENSE. `stable`, no writes, and deliberately does not touch
-- last_seen_at: looking at history is not a heartbeat, and a read path that
-- mutates a row is a read path that can fail.

-- ----------------------------------------------------------------------------
-- 1. The index the query needs.
--
-- orders already has orders_project_id_idx and orders_created_at_idx, but they
-- are separate single-column indexes: scoping to a project and then ordering by
-- date would filter on one and sort the result. This composite matches the
-- access pattern exactly, including the id tiebreak the cursor depends on.
--
-- No column change, no backfill, no constraint. Adding an index is the whole of
-- this migration's effect on existing data.
-- ----------------------------------------------------------------------------
create index if not exists orders_project_recent_idx
  on public.orders (project_id, created_at desc, id desc);

-- ----------------------------------------------------------------------------
-- 2. get_device_recent_orders — one page of this project's completed sales.
--
-- NO p_project_id ARGUMENT, AND THERE MUST NEVER BE ONE. The project is read
-- from the caller's own pairing row. An argument would make cross-project
-- access a matter of passing a different uuid, which is the single most
-- dangerous thing this function could offer; its absence is what makes the scope
-- a property of the signature rather than of a check.
--
-- ONE CALL SERVES LIST AND DETAIL. Each row carries its full item detail, so
-- tapping a sale needs no second round trip. A page of 25 is a few kilobytes,
-- and the shape is byte-for-byte what complete_sale_v4 already returns — so the
-- client validates it with isCompletedSaleReceipt and renders it with the
-- existing receipt component, with no mapping written for this feature.
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

-- Authenticated only. service_role is revoked deliberately: nothing server-side
-- reads a device's history, and a privileged caller has no project to resolve.
revoke all on function public.get_device_recent_orders(integer, timestamptz, uuid) from public;
revoke all on function public.get_device_recent_orders(integer, timestamptz, uuid) from anon;
revoke all on function public.get_device_recent_orders(integer, timestamptz, uuid) from service_role;
grant execute on function public.get_device_recent_orders(integer, timestamptz, uuid) to authenticated;
