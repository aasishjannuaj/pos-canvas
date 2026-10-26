-- G-1-SERVER-1 — recovering an uncertain sale WITHOUT changing who rang it.
--
-- THE PROBLEM. A device that dispatched a sale and never heard back holds the
-- sale's request id and nothing else it can trust. complete_sale_v5 is the only
-- way to learn whether that sale committed, and it CREATES the order when it did
-- not. A creation made later, by whoever is signed in by then, is attributed to
-- THAT employee and register — not the ones that rang the sale (W-02 finding G-1).
--
-- WHAT THIS MIGRATION ADDS, and nothing else. complete_sale_v5 and every other
-- existing object are left exactly as they are; installed clients keep working.
--
--   1. public.sale_recovery_device_hash — INTERNAL. The canonical device-sale
--      hash, computed exactly as complete_sale_v5 computes it. Nobody may call it
--      directly; the two functions below use it.
--
--   2. public.get_device_sale_by_request_id — RETRIEVAL. Genuinely read-only
--      (STABLE: PostgreSQL itself refuses any write). Scoped to the calling
--      device AND its project. Compares the complete canonical identity. A
--      payload that does not match returns NO order details. "not_found" is
--      reported as exactly that: an earlier request may still commit later.
--
--   3. public.complete_sale_recovery_v1 — STRICT CREATION OR REPLAY. Takes the
--      ORIGINAL employee POS session and register as claims, verifies both
--      belong to the calling device and project (the employee is derived from
--      the session, never asserted), then:
--        * existing order, matching payload, matching attribution -> replayed;
--        * existing order, matching payload, DIFFERENT attribution (e.g. a
--          legacy v5 call won and stored the current employee, or NULL) ->
--          'attribution_conflict', with no receipt and no change;
--        * no order -> complete_sale_v5 creates it, and the stored employee and
--          register are checked against the originals BEFORE commit. Anything
--          else raises, which rolls back the whole transaction: no order, no
--          items, no inventory movement, no order number.
--
-- HOW "DID THIS CALL CREATE IT?" IS DECIDED — explicitly, not from xmin. Every
-- order-insert path (complete_sale, complete_sale_v2, v3, v4 and v5) takes the
-- project row FOR UPDATE before it inserts, and orders are unique on
-- (project_id, sale_request_id). complete_sale_recovery_v1 takes the SAME locks,
-- in the SAME order and modes as complete_sale_v5 (device row FOR SHARE, then the
-- project row FOR UPDATE), BEFORE it looks for the order. While it holds that
-- project lock no other transaction can insert an order for the project, so the
-- existence check it makes is the state complete_sale_v5 will see. The nested
-- complete_sale_v5 call re-acquires locks this transaction already holds, which
-- never waits and never upgrades a lock mode, so no new deadlock is introduced.
--
-- WHAT THIS DOES NOT DO. It does not repair an order a legacy complete_sale_v5
-- call already stored with substituted or NULL attribution; it reports it. It
-- cannot stop an installed client from calling complete_sale_v5 directly — that
-- needs client rollout control (see the checkpoint report).

-- ===========================================================================
-- 1. The canonical device-sale hash (internal)
-- ===========================================================================

create or replace function public.sale_recovery_device_hash(
  p_project_id uuid,
  p_payment_method text,
  p_tip_amount numeric,
  p_items jsonb
)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $function$
declare
  -- Copied from complete_sale_v5 (20261012120000). The database test suite
  -- proves this function returns the hash complete_sale_v5 STORES for the same
  -- payload, so a divergence cannot go unnoticed.
  c_max_items        constant integer := 200;
  c_max_quantity     constant integer := 10000;
  c_max_mod_groups   constant integer := 10;
  c_max_mod_options  constant integer := 20;
  c_max_mod_selected constant integer := 50;

  v_item           jsonb;
  v_item_id        text;
  v_qty_num        numeric;
  v_quantity       integer;
  v_mods           jsonb;
  v_mod_text       text;
  v_line_identity  text;
  v_norm           jsonb := '[]'::jsonb;
  v_items_text     text;
  v_canonical      text;
  v_count          integer;
  v_distinct       integer;
  v_selected_total integer;
begin
  if p_project_id is null then
    raise exception 'Project not found or access denied';
  end if;

  if p_payment_method is null or p_payment_method not in ('cash', 'card') then
    raise exception 'Invalid payment method';
  end if;

  -- A device sale never carries a tip; complete_sale_v5 refuses one and hashes
  -- the tip as 0.00.
  if p_tip_amount is not null
     and p_tip_amount::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'Order amounts are not valid';
  end if;

  if coalesce(p_tip_amount, 0) <> 0 then
    raise exception 'Tips are not supported on this device';
  end if;

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

  select count(*) into v_count
  from jsonb_array_elements(p_items) e,
       jsonb_array_elements(coalesce(e.value -> 'modifiers', '[]'::jsonb)) m,
       jsonb_array_elements(coalesce(m.value -> 'optionIds', '[]'::jsonb)) o
  where jsonb_typeof(o.value) <> 'string'
     or coalesce(btrim(o.value #>> '{}'), '') = '';
  if v_count > 0 then
    raise exception 'Invalid order item';
  end if;

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

    select coalesce(jsonb_agg(m.value order by btrim(m.value ->> 'groupId') collate "C"), '[]'::jsonb)
    into v_mods
    from jsonb_array_elements(v_mods) m
    where jsonb_array_length(coalesce(m.value -> 'optionIds', '[]'::jsonb)) > 0;

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

    select count(*) into v_count
    from jsonb_array_elements(v_mods) m
    where (select count(*) from jsonb_array_elements_text(m.value -> 'optionIds')) <>
          (select count(distinct o.value) from jsonb_array_elements_text(m.value -> 'optionIds') o);
    if v_count > 0 then
      raise exception 'The same option appears more than once for an item';
    end if;

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

    v_norm := v_norm || jsonb_build_object('qty', v_quantity, 'key', v_line_identity);
  end loop;

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

  v_canonical :=
    'posc.sale.v2' || E'\n' ||
    'project=' || p_project_id::text || E'\n' ||
    'payment=' || p_payment_method || E'\n' ||
    'tip=' || round(0::numeric, 2)::text || E'\n' ||
    'items=' || jsonb_array_length(v_norm)::text ||
    case when v_items_text is null then '' else E'\n' || v_items_text end;

  return encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');
end;
$function$;

-- Internal: no role may call it directly. The SECURITY DEFINER functions below
-- run as the owner, who keeps EXECUTE.
revoke all on function public.sale_recovery_device_hash(uuid, text, numeric, jsonb) from public;
revoke all on function public.sale_recovery_device_hash(uuid, text, numeric, jsonb) from anon;
revoke all on function public.sale_recovery_device_hash(uuid, text, numeric, jsonb) from authenticated;
revoke all on function public.sale_recovery_device_hash(uuid, text, numeric, jsonb) from service_role;

-- ===========================================================================
-- 2. Retrieval: is there already an order for this sale, on THIS device?
-- ===========================================================================

create or replace function public.get_device_sale_by_request_id(
  p_sale_request_id uuid,
  p_payment_method text,
  p_items jsonb,
  p_tip_amount numeric default 0,
  p_original_employee_pos_session_id uuid default null,
  p_original_register_session_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller            uuid;
  v_device_id         uuid;
  v_project_id        uuid;
  v_unpaired_at       timestamptz;
  v_hash              text;
  v_order             record;
  v_original_employee uuid;
  v_register_ok       boolean;
  v_attribution       text;
begin
  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'Authentication required';
  end if;

  if p_sale_request_id is null
     or p_sale_request_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception 'A sale request ID is required';
  end if;

  select d.id, d.project_id, d.unpaired_at
    into v_device_id, v_project_id, v_unpaired_at
  from public.paired_devices d
  where d.auth_user_id = v_caller;

  if not found then
    raise exception 'Project not found or access denied';
  end if;

  if v_unpaired_at is not null then
    raise exception 'This device is no longer paired';
  end if;

  v_hash := public.sale_recovery_device_hash(v_project_id, p_payment_method, p_tip_amount, p_items);

  select o.id, o.order_number, o.sale_request_hash, o.total, o.payment_method,
         o.created_at, o.occurred_at, o.source, o.employee_id,
         o.register_session_id, o.paired_device_id
    into v_order
  from public.orders o
  where o.project_id = v_project_id
    and o.sale_request_id = p_sale_request_id;

  -- NOT PROOF OF ABSENCE. An earlier request carrying this id may still be in
  -- flight and commit after this read. The caller must keep its evidence.
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Another till's order is not this device's to inspect. Nothing about it is
  -- disclosed beyond the fact that the id is not this device's.
  if v_order.paired_device_id is distinct from v_device_id then
    return jsonb_build_object('status', 'not_this_device');
  end if;

  -- A different sale under the same id: NO order details of any kind.
  if v_order.sale_request_hash is distinct from v_hash then
    return jsonb_build_object('status', 'payload_mismatch');
  end if;

  if p_original_employee_pos_session_id is null or p_original_register_session_id is null then
    v_attribution := 'unverified';
  else
    select s.employee_id into v_original_employee
    from public.employee_pos_sessions s
    join public.employees e on e.id = s.employee_id
    where s.id = p_original_employee_pos_session_id
      and s.paired_device_id = v_device_id
      and e.project_id = v_project_id;

    v_register_ok := exists (
      select 1 from public.register_sessions r
      where r.id = p_original_register_session_id
        and r.paired_device_id = v_device_id
    );

    if v_original_employee is null or not v_register_ok then
      v_attribution := 'claims_unverifiable';
    elsif v_order.employee_id is not distinct from v_original_employee
          and v_order.register_session_id is not distinct from p_original_register_session_id then
      v_attribution := 'verified';
    else
      v_attribution := 'conflict';
    end if;
  end if;

  return jsonb_build_object(
    'status', 'match',
    'attribution', v_attribution,
    'order', jsonb_build_object(
      'orderId', v_order.id::text,
      'orderNumber', v_order.order_number,
      'total', v_order.total::text,
      'paymentMethod', v_order.payment_method,
      'createdAt', to_char(v_order.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'occurredAt', to_char(v_order.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'source', v_order.source,
      'employeeId', v_order.employee_id,
      'registerSessionId', v_order.register_session_id
    )
  );
end;
$function$;

revoke all on function public.get_device_sale_by_request_id(uuid, text, jsonb, numeric, uuid, uuid) from public;
revoke all on function public.get_device_sale_by_request_id(uuid, text, jsonb, numeric, uuid, uuid) from anon;
revoke all on function public.get_device_sale_by_request_id(uuid, text, jsonb, numeric, uuid, uuid) from service_role;
grant execute on function public.get_device_sale_by_request_id(uuid, text, jsonb, numeric, uuid, uuid) to authenticated;

-- ===========================================================================
-- 3. Strict recovery: create or replay under the ORIGINAL attribution only
-- ===========================================================================

create or replace function public.complete_sale_recovery_v1(
  p_payment_method text,
  p_tip_amount numeric,
  p_items jsonb,
  p_sale_request_id uuid,
  p_source text,
  p_original_employee_pos_session_id uuid,
  p_original_register_session_id uuid,
  p_original_attempt_at timestamptz default null,
  p_current_employee_pos_session_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller            uuid;
  v_source            text;
  v_device_id         uuid;
  v_project_id        uuid;
  v_owner_id          uuid;
  v_unpaired_at       timestamptz;
  v_original_employee uuid;
  v_current_employee  uuid;
  v_hash              text;
  v_existing          record;
  v_created           record;
  v_receipt           jsonb;
begin
  -- -------------------------------------------------------------------------
  -- Request shape. Every refusal here happens before any lock or write.
  -- -------------------------------------------------------------------------
  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'Authentication required';
  end if;

  if p_sale_request_id is null
     or p_sale_request_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception 'A sale request ID is required';
  end if;

  v_source := lower(btrim(coalesce(p_source, '')));
  if v_source not in ('online', 'offline_queued') then
    raise exception 'Invalid sale source';
  end if;

  if p_original_employee_pos_session_id is null or p_original_register_session_id is null then
    raise exception 'Recovery requires the original employee session and register';
  end if;

  if v_source = 'offline_queued' and p_original_attempt_at is null then
    raise exception 'Recovery requires the original attempt time';
  end if;

  if v_source = 'online' and p_original_attempt_at is not null then
    raise exception 'An online recovery cannot declare its own sale time';
  end if;

  if v_source = 'online' and p_current_employee_pos_session_id is null then
    raise exception 'Online recovery requires the signed-in employee session';
  end if;

  -- -------------------------------------------------------------------------
  -- Locks: the SAME statements, order and modes as complete_sale_v5.
  -- -------------------------------------------------------------------------
  select d.id, d.project_id, d.owner_id, d.unpaired_at
    into v_device_id, v_project_id, v_owner_id, v_unpaired_at
  from public.paired_devices d
  where d.auth_user_id = v_caller
  for share;

  if not found then
    raise exception 'Project not found or access denied';
  end if;

  if v_unpaired_at is not null then
    raise exception 'This device is no longer paired';
  end if;

  perform 1
  from public.projects p
  where p.id = v_project_id and p.user_id = v_owner_id
  for update;

  if not found then
    raise exception 'Project not found or access denied';
  end if;

  -- -------------------------------------------------------------------------
  -- The original claims, VERIFIED. The employee is derived from the session;
  -- it is never accepted from the caller.
  -- -------------------------------------------------------------------------
  select s.employee_id into v_original_employee
  from public.employee_pos_sessions s
  join public.employees e on e.id = s.employee_id
  where s.id = p_original_employee_pos_session_id
    and s.paired_device_id = v_device_id
    and e.project_id = v_project_id;

  if not found then
    raise exception 'The original employee session could not be verified';
  end if;

  perform 1
  from public.register_sessions r
  where r.id = p_original_register_session_id
    and r.paired_device_id = v_device_id;

  if not found then
    raise exception 'The original register could not be verified';
  end if;

  v_hash := public.sale_recovery_device_hash(v_project_id, p_payment_method, p_tip_amount, p_items);

  -- -------------------------------------------------------------------------
  -- Existing order? Authoritative: this transaction holds the project lock that
  -- every order-insert path takes before inserting.
  -- -------------------------------------------------------------------------
  select o.id, o.order_number, o.sale_request_hash, o.employee_id,
         o.register_session_id, o.paired_device_id
    into v_existing
  from public.orders o
  where o.project_id = v_project_id
    and o.sale_request_id = p_sale_request_id;

  if found then
    -- G-1-SERVER-1A — ANOTHER TILL'S ORDER IS REFUSED FIRST, before its payload
    -- hash is compared and before anything about it is returned. A NULL
    -- paired_device_id (e.g. an owner sale, or a device sale from before
    -- Feature 1B) is outside this device's scope too. The answer carries no
    -- order id, number, receipt, employee, register, device, and does not
    -- reveal whether the payload matches.
    if v_existing.paired_device_id is distinct from v_device_id then
      return jsonb_build_object('status', 'not_this_device');
    end if;

    if v_existing.sale_request_hash is distinct from v_hash then
      raise exception 'Sale request ID was already used for a different order';
    end if;

    -- THIS till's same sale, stored under DIFFERENT attribution. Reported,
    -- never changed, and never presented as a successful recovery.
    if v_existing.employee_id is distinct from v_original_employee
       or v_existing.register_session_id is distinct from p_original_register_session_id then
      return jsonb_build_object(
        'status', 'attribution_conflict',
        'orderId', v_existing.id::text,
        'orderNumber', v_existing.order_number,
        'stored', jsonb_build_object(
          'employeeId', v_existing.employee_id,
          'registerSessionId', v_existing.register_session_id,
          'pairedDeviceId', v_existing.paired_device_id
        ),
        'expected', jsonb_build_object(
          'employeeId', v_original_employee,
          'registerSessionId', p_original_register_session_id,
          'pairedDeviceId', v_device_id
        )
      );
    end if;

    -- Matching sale and attribution: complete_sale_v5 replays it (no writes).
    v_receipt := public.complete_sale_v5(
      p_payment_method, p_tip_amount, p_items, p_sale_request_id,
      case when v_source = 'offline_queued' then p_original_attempt_at else null end,
      v_source,
      case when v_source = 'online' then p_current_employee_pos_session_id
           else p_original_employee_pos_session_id end,
      p_original_register_session_id
    );

    return jsonb_build_object('status', 'replayed', 'receipt', v_receipt);
  end if;

  -- -------------------------------------------------------------------------
  -- Creation.
  -- -------------------------------------------------------------------------
  if v_source = 'online' then
    -- Online, complete_sale_v5 attributes the sale to the CURRENTLY signed-in
    -- session. That is only the original attribution if the signed-in employee
    -- IS the original employee; anyone else must recover through the
    -- historical-claim path.
    select s.employee_id into v_current_employee
    from public.employee_pos_sessions s
    where s.id = p_current_employee_pos_session_id
      and s.paired_device_id = v_device_id
      and s.ended_at is null;

    if not found or v_current_employee is distinct from v_original_employee then
      raise exception 'Only the original employee can recover this sale online';
    end if;

    v_receipt := public.complete_sale_v5(
      p_payment_method, p_tip_amount, p_items, p_sale_request_id,
      null, 'online',
      p_current_employee_pos_session_id, p_original_register_session_id
    );
  else
    v_receipt := public.complete_sale_v5(
      p_payment_method, p_tip_amount, p_items, p_sale_request_id,
      p_original_attempt_at, 'offline_queued',
      p_original_employee_pos_session_id, p_original_register_session_id
    );
  end if;

  select o.employee_id, o.register_session_id, o.paired_device_id
    into v_created
  from public.orders o
  where o.project_id = v_project_id
    and o.sale_request_id = p_sale_request_id;

  if not found then
    raise exception 'The recovered sale was not recorded';
  end if;

  -- THE ATTRIBUTION GUARD. complete_sale_v5 stores NULL for an employee claim it
  -- cannot prove; this refuses that (and any other substitution) by raising,
  -- which rolls back everything complete_sale_v5 wrote in this transaction.
  if v_created.paired_device_id is distinct from v_device_id
     or v_created.employee_id is distinct from v_original_employee
     or v_created.register_session_id is distinct from p_original_register_session_id then
    raise exception 'The original employee and register could not be proven for this sale';
  end if;

  return jsonb_build_object('status', 'created', 'receipt', v_receipt);
end;
$function$;

revoke all on function public.complete_sale_recovery_v1(text, numeric, jsonb, uuid, text, uuid, uuid, timestamptz, uuid) from public;
revoke all on function public.complete_sale_recovery_v1(text, numeric, jsonb, uuid, text, uuid, uuid, timestamptz, uuid) from anon;
revoke all on function public.complete_sale_recovery_v1(text, numeric, jsonb, uuid, text, uuid, uuid, timestamptz, uuid) from service_role;
grant execute on function public.complete_sale_recovery_v1(text, numeric, jsonb, uuid, text, uuid, uuid, timestamptz, uuid) to authenticated;
