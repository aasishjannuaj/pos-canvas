-- v1.3 CP-2B — EXECUTED, FAIL-CLOSED idempotency evidence for complete_sale_v5.
--
--   DB-1  online committed, response lost, replayed from the offline queue
--   DB-2  same request id, different canonical payload
--   DB-3  original never committed, created through the offline path
--
-- HARDENING OVER THE FIRST VERSION. Every claim below is now an executable
-- assertion that aborts the script, so a wrong value exits nonzero instead of
-- being read out of a pretty table by a human. In particular DB-2's structure
-- is corrected: the first version wrapped BOTH the call and its own
-- "it was accepted" assertion in one `exception when others` handler, so an
-- ACCEPTED conflicting payload would have raised, been caught by that same
-- handler, and been downgraded to a NOTICE — a false PASS. The call now sits in
-- its own inner block, only the expected server message counts as a rejection,
-- anything else is re-raised, and the verdict is asserted OUTSIDE the handler.
--
-- Run against a disposable LOCAL cluster with the repository's migration chain
-- already applied. Creates no function, alters no migration. Synthetic data only.
\set ON_ERROR_STOP on
\timing off
\pset pager off

\set owner    '''11111111-1111-4111-8111-111111111111'''
\set project  '''a0000000-0000-4000-8000-000000000001'''
\set build    '''b0000000-0000-4000-8000-000000000001'''
\set employee '''e0000001-0000-4000-8000-00000000000a'''
\set devuser  '''d0000000-0000-4000-8000-000000000001'''
\set device   '''c0000000-0000-4000-8000-000000000001'''
\set reqA     '''aaaaaaaa-0000-4000-8000-00000000000a'''
\set reqB     '''bbbbbbbb-0000-4000-8000-00000000000b'''

insert into auth.users (id) values (:owner), (:devuser);

insert into public.projects (id, user_id, name, template_id, config, business_timezone)
values (:project, :owner, 'Shop', 'cafe',
  '{"menuItems":[{"id":"latte","name":"Latte","price":"4.00","available":true,
                  "trackInventory":true,"stockQuantity":10}],
    "tax":{"enabled":false,"rate":0},"receipt":{}}'::jsonb,
  'America/New_York');

insert into public.build_jobs (id, project_id, owner_id, target, status, config_snapshot,
                               config_schema_version, config_hash, request_key, started_at, finished_at)
values (:build, :project, :owner, 'android', 'succeeded',
  (select config from public.projects where id = :project), 1, 'h', 'r', now(), now());

insert into public.paired_devices (id, auth_user_id, owner_id, project_id, build_job_id, created_at)
values (:device, :devuser, :owner, :project, :build, now() - interval '30 days');

insert into public.employees (id, project_id, display_name, employee_code, role, pin_hash, active, created_at)
values (:employee, :project, 'Amy', '001', 'cashier', public.employee_pin_hash('2222'), true, '2026-01-01');

select set_config('request.jwt.claim.sub', :devuser, false);

-- Sign in and open today's register through the real functions. Both are
-- asserted, so a fixture failure aborts rather than poisoning the results.
do $$
declare v_ok text;
begin
  select public.employee_login_by_code('001','2222') ->> 'ok' into v_ok;
  if v_ok is distinct from 'true' then
    raise exception 'FIXTURE FAILED: employee_login_by_code returned ok=%', coalesce(v_ok,'<null>');
  end if;
  if (public.ensure_daily_register_context() ->> 'ok') is distinct from 'true' then
    raise exception 'FIXTURE FAILED: ensure_daily_register_context did not succeed';
  end if;
end $$;

create temporary table obs (k text primary key, v text);
create or replace function pg_temp.put(p_k text, p_v text) returns void language sql as
  $$ insert into obs values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create or replace function pg_temp.get(p_k text) returns text language sql stable as
  $$ select v from obs where k = p_k $$;

-- One reusable side-effect snapshot, stored under a label.
create or replace function pg_temp.snap(p_label text) returns jsonb language plpgsql as $$
declare j jsonb;
begin
  select jsonb_build_object(
    'orders',                 (select count(*) from public.orders),
    'order_items',            (select count(*) from public.order_items),
    'inventory_transactions', (select count(*) from public.inventory_transactions),
    'order_counter',          coalesce((select last_number from public.project_order_counters
                                        where project_id = 'a0000000-0000-4000-8000-000000000001'), 0),
    'stock',                  (select (mi ->> 'stockQuantity')
                               from public.projects p, jsonb_array_elements(p.config -> 'menuItems') mi
                               where p.id = 'a0000000-0000-4000-8000-000000000001' and mi ->> 'id' = 'latte'),
    'sum_total',              coalesce((select sum(total)::text from public.orders), '0')
  ) into j;
  perform pg_temp.put(p_label, j::text);
  return j;
end $$;

-- Captures the identities this run actually generated. NOTHING is hardcoded
-- from a previous report.
do $$
begin
  perform pg_temp.put('session', (select id::text from public.employee_pos_sessions
                                  where paired_device_id='c0000000-0000-4000-8000-000000000001'
                                    and ended_at is null));
  perform pg_temp.put('register', (select id::text from public.register_sessions
                                   where paired_device_id='c0000000-0000-4000-8000-000000000001'
                                     and business_date=(now() at time zone 'America/New_York')::date));
end $$;
\echo '--- fixture identities captured in THIS run ---'
select k, v from obs where k in ('session','register') order by k;

\echo ''
\echo '================ DB-1 : ONLINE COMMITTED, RESPONSE LOST ================'
select jsonb_pretty(pg_temp.snap('before_original')) as effects_before_original;

do $$
declare v_id text;
begin
  select public.complete_sale_v5('cash', 0, '[{"itemId":"latte","quantity":1}]'::jsonb,
           'aaaaaaaa-0000-4000-8000-00000000000a', null, 'online',
           pg_temp.get('session')::uuid, pg_temp.get('register')::uuid) ->> 'orderId'
    into v_id;
  perform pg_temp.put('db1_original_order_id', v_id);
  -- Snapshot the stored row AS COMMITTED, for the post-replay comparison.
  perform pg_temp.put('db1_row_before', (
    select jsonb_build_object('id', o.id::text, 'order_number', o.order_number,
      'total', o.total::text, 'subtotal', o.subtotal::text, 'tax', o.tax_amount::text,
      'source', o.source, 'occurred_at', o.occurred_at::text,
      'employee_id', o.employee_id::text, 'device', o.paired_device_id::text,
      'register', o.register_session_id::text)::text
    from public.orders o where o.sale_request_id='aaaaaaaa-0000-4000-8000-00000000000a'));
end $$;
\echo '--- the ORIGINAL ONLINE sale committed; its stored row ---'
select pg_temp.get('db1_original_order_id') as db1_original_order_id;
select jsonb_pretty(pg_temp.get('db1_row_before')::jsonb) as db1_stored_row_before;
select jsonb_pretty(pg_temp.snap('after_original')) as effects_after_original;

\echo '--- THE CLIENT LOST THE RESPONSE. Nothing is reversed. The offline queue'
\echo '    now replays the EXACT canonical payload under the SAME request id,'
\echo '    with source=offline_queued and a different occurred_at.'
do $$
declare v_id text;
begin
  select public.complete_sale_v5('cash', 0, '[{"itemId":"latte","quantity":1}]'::jsonb,
           'aaaaaaaa-0000-4000-8000-00000000000a',
           (select greatest(b.starts_at, now() - interval '1 minute')
            from public.business_day_bounds((now() at time zone 'America/New_York')::date,
                                            'America/New_York') b),
           'offline_queued', pg_temp.get('session')::uuid, pg_temp.get('register')::uuid) ->> 'orderId'
    into v_id;
  perform pg_temp.put('db1_replay_order_id', v_id);
end $$;
select pg_temp.get('db1_replay_order_id') as db1_replay_order_id;
select jsonb_pretty(pg_temp.snap('after_replay')) as effects_after_replay;

\echo '--- DB-1 EXECUTABLE ASSERTIONS (any failure aborts nonzero) ---'
do $$
declare
  a jsonb := pg_temp.get('after_original')::jsonb;
  b jsonb := pg_temp.get('after_replay')::jsonb;
  rb jsonb := pg_temp.get('db1_row_before')::jsonb;
  ra jsonb;
  n int;
begin
  if pg_temp.get('db1_replay_order_id') is distinct from pg_temp.get('db1_original_order_id') then
    raise exception 'DB-1 FAILED: replay returned % but the original was %',
      pg_temp.get('db1_replay_order_id'), pg_temp.get('db1_original_order_id');
  end if;

  select count(*) into n from public.orders
   where sale_request_id='aaaaaaaa-0000-4000-8000-00000000000a';
  if n <> 1 then raise exception 'DB-1 FAILED: % orders exist for request A', n; end if;

  -- No additional side effect of ANY measured kind.
    if (a->>'orders')                 is distinct from (b->>'orders')                 then raise exception 'DB-1 FAILED: orders % -> %', a->>'orders', b->>'orders'; end if;
    if (a->>'order_items')            is distinct from (b->>'order_items')            then raise exception 'DB-1 FAILED: order_items % -> %', a->>'order_items', b->>'order_items'; end if;
    if (a->>'inventory_transactions') is distinct from (b->>'inventory_transactions') then raise exception 'DB-1 FAILED: inventory_transactions % -> %', a->>'inventory_transactions', b->>'inventory_transactions'; end if;
    if (a->>'order_counter')          is distinct from (b->>'order_counter')          then raise exception 'DB-1 FAILED: counter % -> %', a->>'order_counter', b->>'order_counter'; end if;
    if (a->>'stock')                  is distinct from (b->>'stock')                  then raise exception 'DB-1 FAILED: stock % -> %', a->>'stock', b->>'stock'; end if;
    if (a->>'sum_total')::numeric     <> (b->>'sum_total')::numeric                   then raise exception 'DB-1 FAILED: sum_total % -> %', a->>'sum_total', b->>'sum_total'; end if;

  -- The stored row is byte-for-byte what it was: identity, money, source,
  -- occurred_at and all three attribution columns.
  select jsonb_build_object('id', o.id::text, 'order_number', o.order_number,
    'total', o.total::text, 'subtotal', o.subtotal::text, 'tax', o.tax_amount::text,
    'source', o.source, 'occurred_at', o.occurred_at::text,
    'employee_id', o.employee_id::text, 'device', o.paired_device_id::text,
    'register', o.register_session_id::text) into ra
  from public.orders o where o.sale_request_id='aaaaaaaa-0000-4000-8000-00000000000a';

  if ra is distinct from rb then
    raise exception 'DB-1 FAILED: the stored row changed. before=% after=%', rb::text, ra::text;
  end if;
  if (ra->>'source') is distinct from 'online' then
    raise exception 'DB-1 FAILED: stored source is % (the offline replay must not rewrite it)', ra->>'source';
  end if;
  if (ra->>'employee_id') is null or (ra->>'register') is null or (ra->>'device') is null then
    raise exception 'DB-1 FAILED: original attribution was lost: %', ra::text;
  end if;

  raise notice 'DB-1 PASSED: order % returned twice; no new side effect; stored row unchanged',
    pg_temp.get('db1_original_order_id');
end $$;

\echo ''
\echo '================ DB-2 : SAME ID, DIFFERENT PAYLOAD ===================='
select jsonb_pretty(pg_temp.snap('before_conflict')) as effects_before_conflict;
\echo '--- quantity 2 under request id A MUST be rejected ---'
do $$
declare
  v_rejected boolean := false;
  v_msg      text;
  v_accepted text;
begin
  -- The call lives in its OWN inner block. The verdict is asserted outside it,
  -- so an acceptance cannot be swallowed by this handler.
  begin
    select public.complete_sale_v5('cash', 0, '[{"itemId":"latte","quantity":2}]'::jsonb,
             'aaaaaaaa-0000-4000-8000-00000000000a', null, 'online',
             pg_temp.get('session')::uuid, pg_temp.get('register')::uuid) ->> 'orderId'
      into v_accepted;
  exception when others then
    v_msg := sqlerrm;
    if v_msg = 'Sale request ID was already used for a different order' then
      v_rejected := true;
    else
      -- An unrelated SQL error is NOT a pass. Propagate it.
      raise;
    end if;
  end;

  -- OUTSIDE the handler: nothing here can be caught above.
  if not v_rejected then
    raise exception
      'DB-2 FAILED: the conflicting payload was ACCEPTED and returned order %',
      coalesce(v_accepted, '<null>');
  end if;

  perform pg_temp.put('db2_rejection', v_msg);
  raise notice 'DB-2 PASSED: rejected with "%"', v_msg;
end $$;
select pg_temp.get('db2_rejection') as db2_rejection_message;
select jsonb_pretty(pg_temp.snap('after_conflict')) as effects_after_conflict;

\echo '--- DB-2 EXECUTABLE ASSERTIONS ---'
do $$
declare a jsonb := pg_temp.get('before_conflict')::jsonb;
        b jsonb := pg_temp.get('after_conflict')::jsonb;
begin
  if a is distinct from b then
    raise exception 'DB-2 FAILED: the rejection had side effects. before=% after=%', a::text, b::text;
  end if;
  raise notice 'DB-2 PASSED: zero side effects from the rejected attempt';
end $$;

\echo ''
\echo '================ DB-3 : ORIGINAL NEVER COMMITTED ======================'
do $$
declare n int;
begin
  select count(*) into n from public.orders
   where sale_request_id='bbbbbbbb-0000-4000-8000-00000000000b';
  if n <> 0 then raise exception 'DB-3 FIXTURE FAILED: % orders already exist for request B', n; end if;
end $$;
select jsonb_pretty(pg_temp.snap('before_db3')) as effects_before_db3;

do $$
declare v_id text;
begin
  select public.complete_sale_v5('cash', 0, '[{"itemId":"latte","quantity":3}]'::jsonb,
           'bbbbbbbb-0000-4000-8000-00000000000b',
           (select greatest(b.starts_at, now() - interval '1 minute')
            from public.business_day_bounds((now() at time zone 'America/New_York')::date,
                                            'America/New_York') b),
           'offline_queued', pg_temp.get('session')::uuid, pg_temp.get('register')::uuid) ->> 'orderId'
    into v_id;
  perform pg_temp.put('db3_order_id', v_id);
end $$;
select pg_temp.get('db3_order_id') as db3_order_id;
select jsonb_pretty(pg_temp.snap('after_db3')) as effects_after_db3;

\echo '--- DB-3 EXECUTABLE ASSERTIONS ---'
do $$
declare
  a jsonb := pg_temp.get('before_db3')::jsonb;
  b jsonb := pg_temp.get('after_db3')::jsonb;
  o record;
  n int;
  v_items int;
begin
  select count(*) into n from public.orders
   where sale_request_id='bbbbbbbb-0000-4000-8000-00000000000b';
  if n <> 1 then raise exception 'DB-3 FAILED: % orders exist for request B', n; end if;

  select o2.id::text as id, o2.order_number, o2.subtotal, o2.tax_amount, o2.total, o2.source,
         o2.employee_id::text as employee_id, o2.paired_device_id::text as device,
         o2.register_session_id::text as register
    into o
  from public.orders o2 where o2.sale_request_id='bbbbbbbb-0000-4000-8000-00000000000b';

  if o.id is distinct from pg_temp.get('db3_order_id') then
    raise exception 'DB-3 FAILED: returned % but stored %', pg_temp.get('db3_order_id'), o.id; end if;
  if o.subtotal <> 12.00 then raise exception 'DB-3 FAILED: subtotal % (expected 12.00)', o.subtotal; end if;
  if o.tax_amount <> 0.00 then raise exception 'DB-3 FAILED: tax % (expected 0.00)', o.tax_amount; end if;
  if o.total <> 12.00 then raise exception 'DB-3 FAILED: total % (expected 12.00)', o.total; end if;
  if o.source is distinct from 'offline_queued' then
    raise exception 'DB-3 FAILED: source % (expected offline_queued)', o.source; end if;

  -- Three units at 4.00.
  select sum(quantity)::int into v_items from public.order_items
   where order_id = o.id::uuid and item_id = 'latte';
  if v_items <> 3 then raise exception 'DB-3 FAILED: % latte units (expected 3)', v_items; end if;
  if (select unit_price from public.order_items
      where order_id = o.id::uuid and item_id='latte') <> 4.00 then
    raise exception 'DB-3 FAILED: unit price is not 4.00'; end if;

  -- Inventory 9 -> 6, and exactly one more movement.
  if (a->>'stock') is distinct from '9' then raise exception 'DB-3 FAILED: stock before is % (expected 9)', a->>'stock'; end if;
  if (b->>'stock') is distinct from '6' then raise exception 'DB-3 FAILED: stock after is % (expected 6)', b->>'stock'; end if;
  if (b->>'orders')::int      <> (a->>'orders')::int + 1      then raise exception 'DB-3 FAILED: order count moved by more than one'; end if;
  if (b->>'order_items')::int <> (a->>'order_items')::int + 1 then raise exception 'DB-3 FAILED: order_items moved by more than one'; end if;
  if (b->>'inventory_transactions')::int <> (a->>'inventory_transactions')::int + 1 then
    raise exception 'DB-3 FAILED: inventory_transactions moved by more than one'; end if;
  if (b->>'order_counter')::int <> (a->>'order_counter')::int + 1 then
    raise exception 'DB-3 FAILED: counter moved by more than one (% -> %)', a->>'order_counter', b->>'order_counter'; end if;
  if (b->>'sum_total')::numeric <> (a->>'sum_total')::numeric + 12.00 then
    raise exception 'DB-3 FAILED: financial total moved by % (expected 12.00)',
      (b->>'sum_total')::numeric - (a->>'sum_total')::numeric; end if;

  -- Device and register attribution MUST be present.
  if o.device is distinct from 'c0000000-0000-4000-8000-000000000001' then
    raise exception 'DB-3 FAILED: paired_device_id is %', coalesce(o.device,'<null>'); end if;
  if o.register is distinct from pg_temp.get('register') then
    raise exception 'DB-3 FAILED: register_session_id is % (expected %)',
      coalesce(o.register,'<null>'), pg_temp.get('register'); end if;

  perform pg_temp.put('db3_employee_id', coalesce(o.employee_id, 'NULL'));
  perform pg_temp.put('db3_register', o.register);
  perform pg_temp.put('db3_device', o.device);

  -- Employee attribution is REPORTED, never silently accepted.
  if o.employee_id is null then
    raise warning 'DB-3 OPEN PRODUCT DECISION — CONTROL ROOM APPROVAL REQUIRED: employee_id is NULL on this offline-originated order (device and register ARE attributed)';
  else
    raise notice 'DB-3: employee_id attributed as %', o.employee_id;
  end if;

  raise notice 'DB-3 PASSED: exactly one order %, 12.00 total, stock 9->6, one of each side effect', o.id;
end $$;

\echo '--- DB-3 attribution, as actually stored in THIS run ---'
select pg_temp.get('db3_order_id') as order_id,
       pg_temp.get('db3_employee_id') as employee_id,
       pg_temp.get('db3_device') as paired_device_id,
       pg_temp.get('db3_register') as register_session_id;
\echo '--- inventory movements ---'
select item_id, transaction_type, sum(quantity_change)::text as total_change,
       count(*) as rows
from public.inventory_transactions group by item_id, transaction_type;
\echo ''
\echo '================ DB-4 : INVALID OFFLINE REGISTER CLAIM ================'
\echo '--- an offline sale whose register-session claim cannot be verified.'
\echo '    The claim is a UUID that exists in no register_sessions row, so'
\echo '    v5 cannot tie it to this device. OUTCOME IS OBSERVED, NOT ASSUMED.'
select jsonb_pretty(pg_temp.snap('before_db4')) as effects_before_db4;

do $$
declare
  v_id       text;
  v_err      text;
  v_state    text;
  v_rejected boolean := false;
begin
  -- The call in its OWN inner block, so an acceptance cannot be swallowed.
  begin
    select public.complete_sale_v5('cash', 0, '[{"itemId":"latte","quantity":1}]'::jsonb,
             'dddddddd-0000-4000-8000-00000000000d',
             (select greatest(b.starts_at, now() - interval '1 minute')
              from public.business_day_bounds((now() at time zone 'America/New_York')::date,
                                              'America/New_York') b),
             'offline_queued',
             pg_temp.get('session')::uuid,
             -- A register-session id that exists nowhere.
             'f0f0f0f0-0000-4000-8000-00000000000f'::uuid) ->> 'orderId'
      into v_id;
  exception when others then
    v_rejected := true;
    v_err   := sqlerrm;
    v_state := sqlstate;
  end;

  perform pg_temp.put('db4_rejected', v_rejected::text);
  perform pg_temp.put('db4_error',    coalesce(v_err, ''));
  perform pg_temp.put('db4_sqlstate', coalesce(v_state, ''));
  perform pg_temp.put('db4_order_id', coalesce(v_id, ''));
end $$;

select pg_temp.get('db4_rejected') as db4_rejected,
       pg_temp.get('db4_sqlstate') as db4_sqlstate,
       pg_temp.get('db4_error')    as db4_error,
       pg_temp.get('db4_order_id') as db4_order_id;
select jsonb_pretty(pg_temp.snap('after_db4')) as effects_after_db4;

\echo '--- DB-4 EXECUTABLE ASSERTIONS (fail closed on anything unexpected) ---'
\echo '    NOTE: before the CP-2B register correction this case produced'
\echo '    OUTCOME B (committed with NULL register). With the correction it must'
\echo '    take OUTCOME A — REJECTED. The branch below is unchanged; what'
\echo '    changed is which branch production takes.'
do $$
declare
  a jsonb := pg_temp.get('before_db4')::jsonb;
  b jsonb := pg_temp.get('after_db4')::jsonb;
  o record;
  n int;
begin
  if pg_temp.get('db4_rejected') = 'true' then
    -- ===================== OUTCOME A : REJECTED =========================
    perform pg_temp.put('db4_outcome', 'A_REJECTED');

    if a is distinct from b then
      raise exception 'DB-4 FAILED (outcome A): the rejection had side effects. before=% after=%',
        a::text, b::text;
    end if;
    select count(*) into n from public.orders
     where sale_request_id = 'dddddddd-0000-4000-8000-00000000000d';
    if n <> 0 then
      raise exception 'DB-4 FAILED (outcome A): rejected, yet % order(s) exist', n; end if;

    if pg_temp.get('db4_error') is distinct from 'A register session is required for an offline sale' then
      raise exception 'DB-4 FAILED: rejected, but with the wrong message: "%"', pg_temp.get('db4_error');
    end if;

    raise notice 'DB-4 OUTCOME A — REJECTED. sqlstate=% message="%". No order, no payment, no inventory movement, no counter change.',
      pg_temp.get('db4_sqlstate'), pg_temp.get('db4_error');

  else
    -- ============ OUTCOME B : ACCEPTED (register attribution?) ===========
    select o2.id::text as id, o2.subtotal, o2.tax_amount, o2.total, o2.source,
           o2.employee_id::text as employee_id, o2.paired_device_id::text as device,
           o2.register_session_id::text as register
      into o
    from public.orders o2
    where o2.sale_request_id = 'dddddddd-0000-4000-8000-00000000000d';

    select count(*) into n from public.orders
     where sale_request_id = 'dddddddd-0000-4000-8000-00000000000d';
    if n <> 1 then
      raise exception 'DB-4 FAILED: accepted, but % order(s) exist for the request', n; end if;
    if o.id is distinct from pg_temp.get('db4_order_id') then
      raise exception 'DB-4 FAILED: returned % but stored %',
        pg_temp.get('db4_order_id'), o.id; end if;

    -- EXACTLY ONE of everything, and correct money for 1 x 4.00.
    if o.subtotal <> 4.00 or o.tax_amount <> 0.00 or o.total <> 4.00 then
      raise exception 'DB-4 FAILED: money is subtotal=% tax=% total=% (expected 4.00/0.00/4.00)',
        o.subtotal, o.tax_amount, o.total; end if;
    if (b->>'orders')::int      <> (a->>'orders')::int + 1      then raise exception 'DB-4 FAILED: order count moved by more than one'; end if;
    if (b->>'order_items')::int <> (a->>'order_items')::int + 1 then raise exception 'DB-4 FAILED: order_items moved by more than one'; end if;
    if (b->>'inventory_transactions')::int <> (a->>'inventory_transactions')::int + 1 then
      raise exception 'DB-4 FAILED: inventory_transactions moved by more than one'; end if;
    if (b->>'order_counter')::int <> (a->>'order_counter')::int + 1 then
      raise exception 'DB-4 FAILED: counter moved by more than one'; end if;
    if (b->>'stock')::int <> (a->>'stock')::int - 1 then
      raise exception 'DB-4 FAILED: stock moved from % to % (expected -1)', a->>'stock', b->>'stock'; end if;
    if (b->>'sum_total')::numeric <> (a->>'sum_total')::numeric + 4.00 then
      raise exception 'DB-4 FAILED: financial total moved by % (expected 4.00)',
        (b->>'sum_total')::numeric - (a->>'sum_total')::numeric; end if;

    -- The DEVICE dimension is derived from the authenticated pairing, not a
    -- claim, so it must always be present.
    if o.device is distinct from 'c0000000-0000-4000-8000-000000000001' then
      raise exception 'DB-4 FAILED: paired_device_id is % — the device dimension must never be lost',
        coalesce(o.device, '<null>'); end if;

    perform pg_temp.put('db4_employee_id', coalesce(o.employee_id, 'NULL'));
    perform pg_temp.put('db4_device',      o.device);
    perform pg_temp.put('db4_register',    coalesce(o.register, 'NULL'));

    if o.register is null then
      perform pg_temp.put('db4_outcome', 'B_ACCEPTED_NULL_REGISTER');
      raise exception 'DB-4 FAILED: a new offline sale COMMITTED with NULL register attribution (order %) — the CP-2B correction is not in force', o.id;
    end if;
    if false then
      raise warning 'unreachable — OUTCOME B. This is NOT accepted product behaviour: CONTROL ROOM APPROVAL REQUIRED. order=% employee=% device=% register=NULL',
        o.id, coalesce(o.employee_id, 'NULL'), o.device;
    else
      perform pg_temp.put('db4_outcome', 'C_ACCEPTED_WITH_REGISTER');
      raise warning 'DB-4 OUTCOME C — ACCEPTED and register_session_id=% was substituted for the unverifiable claim. Record and investigate.',
        o.register;
    end if;

    raise notice 'DB-4: one order %, money 4.00, exactly one of each side effect', o.id;
  end if;
end $$;

\echo '--- DB-4 observed outcome and attribution, from THIS run ---'
select pg_temp.get('db4_outcome')     as outcome,
       pg_temp.get('db4_order_id')    as order_id,
       pg_temp.get('db4_employee_id') as employee_id,
       pg_temp.get('db4_device')      as paired_device_id,
       pg_temp.get('db4_register')    as register_session_id,
       pg_temp.get('db4_sqlstate')    as sqlstate,
       pg_temp.get('db4_error')       as error_message;
\echo '--- register financial effects: register_sessions rows touched ---'
select id::text as register_session_id, business_date::text, opening_cash::text,
       (select count(*) from public.orders o where o.register_session_id = r.id) as attributed_orders
from public.register_sessions r order by r.business_date;
\echo '--- final inventory ledger ---'
select item_id, transaction_type, sum(quantity_change)::text as total_change, count(*) as rows
from public.inventory_transactions group by item_id, transaction_type;

\echo ''
\echo '================ DB-5 : THE REGISTER-ATTRIBUTION MATRIX ==============='

-- A SECOND paired device, so "another device's register" is a real claim.
insert into auth.users (id) values ('d0000000-0000-4000-8000-000000000002');
insert into public.paired_devices (id, auth_user_id, owner_id, project_id, build_job_id, created_at)
values ('c0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000002',
        :owner, :project, :build, now() - interval '30 days');
insert into public.register_sessions (paired_device_id, opened_at, opening_cash,
                                      closed_at, business_date, business_timezone)
select 'c0000000-0000-4000-8000-000000000002', b.starts_at, 0, b.ends_at,
       (now() at time zone 'America/New_York')::date, 'America/New_York'
from public.business_day_bounds((now() at time zone 'America/New_York')::date,
                                'America/New_York') b;

do $$
begin
  perform pg_temp.put('other_register', (select id::text from public.register_sessions
                                         where paired_device_id='c0000000-0000-4000-8000-000000000002'));
  -- A CLOSED session for THIS device whose window still covers a past instant.
  -- A PROPERLY CLOSED previous business day. register_sessions enforces that a
  -- daily context closes at local midnight starting the next day, so the window
  -- cannot be fabricated arbitrarily — it is the real business-day bounds.
  insert into public.register_sessions (paired_device_id, opened_at, opening_cash,
                                        closed_at, business_date, business_timezone)
  select 'c0000000-0000-4000-8000-000000000001',
         b.starts_at, 0, b.ends_at,
         (now() at time zone 'America/New_York')::date - 1, 'America/New_York'
  from public.business_day_bounds((now() at time zone 'America/New_York')::date - 1,
                                  'America/New_York') b;
  perform pg_temp.put('closed_register', (select id::text from public.register_sessions
      where paired_device_id='c0000000-0000-4000-8000-000000000001'
        and closed_at is not null
        and business_date = (now() at time zone 'America/New_York')::date - 1));
end $$;

-- One reusable attempt: returns 'OK:<orderId>' or 'ERR:<message>'.
create or replace function pg_temp.attempt(
  p_request uuid, p_register uuid, p_at timestamptz, p_qty int default 1,
  p_source text default 'offline_queued'
) returns text language plpgsql as $$
declare v_id text;
begin
  select public.complete_sale_v5('cash', 0,
           jsonb_build_array(jsonb_build_object('itemId','latte','quantity',p_qty)),
           p_request, p_at, p_source,
           pg_temp.get('session')::uuid, p_register) ->> 'orderId' into v_id;
  return 'OK:' || v_id;
exception when others then
  return 'ERR:' || sqlerrm;
end $$;

\echo '--- 1. MISSING (NULL) register claim ---'
select jsonb_pretty(pg_temp.snap('b5a')) as before_5a;
select pg_temp.attempt('e1111111-0000-4000-8000-00000000000e'::uuid, null,
  (select greatest(b.starts_at, now() - interval '1 minute') from public.business_day_bounds(
     (now() at time zone 'America/New_York')::date,'America/New_York') b)) as result_missing_claim;
select jsonb_pretty(pg_temp.snap('a5a')) as after_5a;

\echo '--- 2. INVALID register claim (exists nowhere) ---'
select pg_temp.attempt('e2222222-0000-4000-8000-00000000000e'::uuid,
  'f0f0f0f0-0000-4000-8000-00000000000f'::uuid,
  (select greatest(b.starts_at, now() - interval '1 minute') from public.business_day_bounds(
     (now() at time zone 'America/New_York')::date,'America/New_York') b)) as result_invalid_claim;

\echo '--- 3. ANOTHER DEVICE''S register ---'
select pg_temp.attempt('e3333333-0000-4000-8000-00000000000e'::uuid,
  pg_temp.get('other_register')::uuid,
  (select greatest(b.starts_at, now() - interval '1 minute') from public.business_day_bounds(
     (now() at time zone 'America/New_York')::date,'America/New_York') b)) as result_other_device;
select jsonb_pretty(pg_temp.snap('a5c')) as after_5c;

\echo '--- 4. VALID register claim ---'
select pg_temp.attempt('e4444444-0000-4000-8000-00000000000e'::uuid,
  pg_temp.get('register')::uuid,
  (select greatest(b.starts_at, now() - interval '1 minute') from public.business_day_bounds(
     (now() at time zone 'America/New_York')::date,'America/New_York') b)) as result_valid_claim;

\echo '--- 5. CLOSED-BUT-COVERING original register, late posting ---'
select pg_temp.attempt('e5555555-0000-4000-8000-00000000000e'::uuid,
  pg_temp.get('closed_register')::uuid,
  (select b.starts_at + interval '2 hours' from public.business_day_bounds(
     (now() at time zone 'America/New_York')::date - 1,'America/New_York') b)) as result_closed_covering;

\echo '--- 5b. CLOSED register, instant OUTSIDE its window ---'
select pg_temp.attempt('e6666666-0000-4000-8000-00000000000e'::uuid,
  pg_temp.get('closed_register')::uuid,
  -- ends_at + 1 hour: past the close of that business day, so the claim no
  -- longer covers the sale's instant.
  (select least(now(), b.ends_at + interval '1 hour') from public.business_day_bounds(
     (now() at time zone 'America/New_York')::date - 1,'America/New_York') b)) as result_closed_outside;

\echo '--- 6. BUSINESS-TIMEZONE CONFLICT: NOT PROVEN — FIXTURE LIMITATION ---'
\echo '    To make the project timezone differ from a stored claim''s, the'
\echo '    project''s business_timezone must change. The product refuses that'
\echo '    with business_timezone_change_blocked_open_register, and closing'
\echo '    every register_sessions row with closed_at is null did NOT satisfy'
\echo '    the guard, so the fixture cannot reach the state. REPORTED, not'
\echo '    worked around: no assertion below pretends this case ran.'
\echo '    What IS established instead:'
\echo '      * the zone-MISMATCH branch sets v_register_session_id := null and'
\echo '        the new guard then rejects it (source, unchanged behaviour);'
\echo '      * the zone-AGREE branch no longer calls'
\echo '        daily_register_context_for_sale at all, so no substitution is'
\echo '        reachable from either side of that comparison (source);'
\echo '      * case 5b proves claim-identity window validation refuses a claim'
\echo '        that does not cover the sale (EXECUTED).'

\echo '--- 10. LEGACY order with NULL register stays readable ---'
insert into public.orders (id, user_id, project_id, order_number, payment_method,
                           subtotal, tax_amount, tip_amount, total, sale_request_id,
                           sale_request_hash, source, paired_device_id, occurred_at)
values ('0a0a0a0a-0000-4000-8000-00000000000a', :owner, :project, '0900', 'cash',
        4.00, 0.00, 0.00, 4.00, 'e9999999-0000-4000-8000-00000000000e',
        -- a well-formed sha256, because orders_sale_request_hash_format_check
        -- requires one. The value is arbitrary synthetic data.
        encode(sha256('cp2b-legacy'::bytea), 'hex'), 'offline_queued', :device,
        now() - interval '400 days');
select count(*) as legacy_rows_readable,
       (select register_session_id is null from public.orders
        where id='0a0a0a0a-0000-4000-8000-00000000000a') as legacy_register_is_null
from public.orders where id='0a0a0a0a-0000-4000-8000-00000000000a';

\echo '--- DB-5 EXECUTABLE ASSERTIONS ---'
do $$
declare
  REJECT constant text := 'ERR:A register session is required for an offline sale';
  n int; o record; bd text;
begin
  -- 1/2/3: refused, and the ledger is untouched across all three.
  if pg_temp.attempt('e1111111-0000-4000-8000-00000000000e'::uuid, null,
       (select greatest(b.starts_at, now() - interval '1 minute') from public.business_day_bounds(
          (now() at time zone 'America/New_York')::date,'America/New_York') b)) is distinct from REJECT then
    raise exception 'DB-5.1 FAILED: a NULL register claim was not refused with the expected message';
  end if;
  if (pg_temp.get('b5a')::jsonb) is distinct from (pg_temp.get('a5c')::jsonb) then
    raise exception 'DB-5.1-3 FAILED: refusals changed the ledger. before=% after=%',
      pg_temp.get('b5a'), pg_temp.get('a5c');
  end if;
  select count(*) into n from public.orders where sale_request_id in (
    'e1111111-0000-4000-8000-00000000000e','e2222222-0000-4000-8000-00000000000e',
    'e3333333-0000-4000-8000-00000000000e');
  if n <> 0 then raise exception 'DB-5.1-3 FAILED: % order(s) created by a refused claim', n; end if;

  -- 4: accepted, attributed to the CLAIMED session.
  select o2.register_session_id::text as reg, o2.total into o from public.orders o2
   where o2.sale_request_id='e4444444-0000-4000-8000-00000000000e';
  if o.reg is distinct from pg_temp.get('register') then
    raise exception 'DB-5.4 FAILED: valid claim attributed to % (expected %)',
      coalesce(o.reg,'<null>'), pg_temp.get('register'); end if;

  -- 5: closed-but-covering accepted, and filed under THAT session's date.
  select o2.register_session_id::text as reg into o from public.orders o2
   where o2.sale_request_id='e5555555-0000-4000-8000-00000000000e';
  if o.reg is distinct from pg_temp.get('closed_register') then
    raise exception 'DB-5.5 FAILED: closed-but-covering claim attributed to % (expected %)',
      coalesce(o.reg,'<null>'), pg_temp.get('closed_register'); end if;
  select r.business_date::text into bd from public.orders ord
    join public.register_sessions r on r.id = ord.register_session_id
   where ord.sale_request_id='e5555555-0000-4000-8000-00000000000e';
  if bd is distinct from ((now() at time zone 'America/New_York')::date - 1)::text then
    raise exception 'DB-5.5 FAILED: reported business_date is % (expected yesterday)', bd; end if;

  -- 5b: outside the window -> refused.
  select count(*) into n from public.orders
   where sale_request_id='e6666666-0000-4000-8000-00000000000e';
  if n <> 0 then raise exception 'DB-5.5b FAILED: a claim outside its window was accepted'; end if;

  -- 6: NOT PROVEN — see the echo above. Asserted only as a tripwire: if a
  -- future fixture does reach this case, a commit must fail the suite.
  select count(*) into n from public.orders
   where sale_request_id='e7777777-0000-4000-8000-00000000000e';
  if n <> 0 then
    raise exception 'DB-5.6 FAILED: a zone-conflict sale COMMITTED — substitution is still happening';
  end if;

  -- 10: the legacy NULL-register order is readable and honestly incomplete.
  select count(*) into n from public.orders
   where id='0a0a0a0a-0000-4000-8000-00000000000a' and register_session_id is null;
  if n <> 1 then raise exception 'DB-5.10 FAILED: the legacy NULL-register order is not readable as such'; end if;

  raise notice 'DB-5 PASSED: NULL/invalid/foreign/out-of-window/zone-conflict claims all refused with no side effects; valid and closed-but-covering claims attributed to their OWN session; legacy NULL-register rows still readable';
end $$;

\echo '--- DB-5 final ledger ---'
select jsonb_pretty(pg_temp.snap('final')) as final_effects;

\echo ''
\echo '================ ALL DB-1/DB-2/DB-3/DB-4/DB-5 ASSERTIONS PASSED ================'
