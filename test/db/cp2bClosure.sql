-- v1.3 CP-2B CLOSURE — executed, fail-closed evidence for the three open issues.
--
--   A  offline sales across midnight, and late sync after a register closes
--   B  the business-timezone conflict: is the state reachable, and what happens
--   D  zero side effects on rejection, and original-ID idempotency
--
-- EVERY CLAIM IS AN EXECUTABLE ASSERTION that aborts the script. Nothing here is
-- read out of a pretty table by a human and called a pass.
--
-- NO SAFEGUARD IS BYPASSED. Section B drives the timezone change through the
-- real projects_validate_business_timezone trigger and ALSO asserts that the
-- same change is REFUSED where the guard applies. Register windows are created
-- by the real business_day_bounds, and today's context by the real
-- ensure_daily_register_context.
--
-- Run against a disposable LOCAL cluster with the whole migration chain applied.
-- Creates no function, alters no migration. Synthetic data only.
\set ON_ERROR_STOP on
\timing off
\pset pager off

\set owner    '''11111111-1111-4111-8111-111111111111'''
\set p1       '''a0000000-0000-4000-8000-000000000001'''
\set p2       '''a0000000-0000-4000-8000-000000000002'''
\set build1   '''b0000000-0000-4000-8000-000000000001'''
\set build2   '''b0000000-0000-4000-8000-000000000002'''
\set emp1     '''e0000001-0000-4000-8000-00000000000a'''
\set emp2     '''e0000002-0000-4000-8000-00000000000b'''
\set du1      '''d0000000-0000-4000-8000-000000000001'''
\set du2      '''d0000000-0000-4000-8000-000000000002'''
\set dev1     '''c0000000-0000-4000-8000-000000000001'''
\set dev2     '''c0000000-0000-4000-8000-000000000002'''
\set ZONE     '''America/New_York'''

insert into auth.users (id) values (:owner), (:du1), (:du2);

insert into public.projects (id, user_id, name, template_id, config, business_timezone)
values
  (:p1, :owner, 'Shop One', 'cafe',
   '{"menuItems":[{"id":"latte","name":"Latte","price":"4.00","available":true,
                   "trackInventory":true,"stockQuantity":50}],
     "tax":{"enabled":false,"rate":0},"receipt":{}}'::jsonb, :ZONE),
  (:p2, :owner, 'Shop Two', 'cafe',
   '{"menuItems":[{"id":"latte","name":"Latte","price":"4.00","available":true,
                   "trackInventory":true,"stockQuantity":50}],
     "tax":{"enabled":false,"rate":0},"receipt":{}}'::jsonb, :ZONE);

insert into public.build_jobs (id, project_id, owner_id, target, status, config_snapshot,
                               config_schema_version, config_hash, request_key, started_at, finished_at)
values
  (:build1, :p1, :owner, 'android', 'succeeded', (select config from public.projects where id = :p1), 1, 'h1', 'r1', now(), now()),
  (:build2, :p2, :owner, 'android', 'succeeded', (select config from public.projects where id = :p2), 1, 'h2', 'r2', now(), now());

insert into public.paired_devices (id, auth_user_id, owner_id, project_id, build_job_id, created_at)
values
  (:dev1, :du1, :owner, :p1, :build1, now() - interval '30 days'),
  (:dev2, :du2, :owner, :p2, :build2, now() - interval '30 days');

insert into public.employees (id, project_id, display_name, employee_code, role, pin_hash, active, created_at)
values
  (:emp1, :p1, 'Amy', '001', 'cashier', public.employee_pin_hash('2222'), true, '2026-01-01'),
  (:emp2, :p2, 'Bo',  '002', 'cashier', public.employee_pin_hash('3333'), true, '2026-01-01');

create temporary table obs (k text primary key, v text);
create or replace function pg_temp.put(p_k text, p_v text) returns void language sql as
  $$ insert into obs values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create or replace function pg_temp.get(p_k text) returns text language sql stable as
  $$ select v from obs where k = p_k $$;

create or replace function pg_temp.snap(p_label text) returns jsonb language plpgsql as $$
declare j jsonb;
begin
  select jsonb_build_object(
    'orders',                 (select count(*) from public.orders),
    'order_items',            (select count(*) from public.order_items),
    'inventory_transactions', (select count(*) from public.inventory_transactions),
    'counters',               coalesce((select sum(last_number) from public.project_order_counters), 0),
    'stock_p1',               (select (mi ->> 'stockQuantity')
                               from public.projects p, jsonb_array_elements(p.config -> 'menuItems') mi
                               where p.id = 'a0000000-0000-4000-8000-000000000001' and mi ->> 'id' = 'latte'),
    'stock_p2',               (select (mi ->> 'stockQuantity')
                               from public.projects p, jsonb_array_elements(p.config -> 'menuItems') mi
                               where p.id = 'a0000000-0000-4000-8000-000000000002' and mi ->> 'id' = 'latte'),
    'sum_total',              coalesce((select sum(total)::text from public.orders), '0')
  ) into j;
  perform pg_temp.put(p_label, j::text);
  return j;
end $$;

-- A rejection helper: runs the call, demands the EXPECTED message, re-raises
-- anything else, and asserts the verdict OUTSIDE the handler so an ACCEPTED
-- sale can never be downgraded to a notice.
create or replace function pg_temp.expect_refusal(
  p_req uuid, p_at timestamptz, p_session uuid, p_register uuid, p_label text
) returns void language plpgsql as $$
declare v_accepted text; v_rejected boolean := false; v_msg text; v_state text;
begin
  begin
    select public.complete_sale_v5('cash', 0, '[{"itemId":"latte","quantity":1}]'::jsonb,
             p_req, p_at, 'offline_queued', p_session, p_register) ->> 'orderId'
      into v_accepted;
  exception when others then
    v_msg := sqlerrm; v_state := sqlstate;
    if v_msg = 'A register session is required for an offline sale' then
      v_rejected := true;
      perform pg_temp.put(p_label || '_sqlstate', v_state);
      perform pg_temp.put(p_label || '_message', v_msg);
    else
      raise;
    end if;
  end;

  if not v_rejected then
    raise exception '% FAILED: the sale was ACCEPTED and returned orderId %', p_label, v_accepted;
  end if;
end $$;

\echo ''
\echo '############ FIXTURE: today''s daily register, via the real RPC ############'
select set_config('request.jwt.claim.sub', :du1, false);
do $$
declare v_ok text;
begin
  if (public.employee_login_by_code('001','2222') ->> 'ok') is distinct from 'true' then
    raise exception 'FIXTURE FAILED: employee_login_by_code';
  end if;
  if (public.ensure_daily_register_context() ->> 'ok') is distinct from 'true' then
    raise exception 'FIXTURE FAILED: ensure_daily_register_context';
  end if;
  perform pg_temp.put('sess1', (select id::text from public.employee_pos_sessions
                                where paired_device_id = 'c0000000-0000-4000-8000-000000000001'
                                  and ended_at is null));
  perform pg_temp.put('reg_today', (select id::text from public.register_sessions
                                    where paired_device_id = 'c0000000-0000-4000-8000-000000000001'
                                      and business_date is not null));
end $$;

-- The window the REAL function gave today's register. Everything in section A
-- is expressed relative to these two instants, never to a literal.
select r.business_date, r.business_timezone, r.opened_at, r.closed_at
from public.register_sessions r where r.id = pg_temp.get('reg_today')::uuid;

do $$
declare r record;
begin
  select * into r from public.register_sessions where id = pg_temp.get('reg_today')::uuid;
  perform pg_temp.put('today_open',  r.opened_at::text);
  perform pg_temp.put('today_close', r.closed_at::text);
  if r.closed_at is null then
    raise exception 'FIXTURE FAILED: a daily register must carry a scheduled close';
  end if;
end $$;

\echo ''
\echo '================ A1 : LATE SYNC, INSIDE THE CLAIMED WINDOW ================'
\echo '--- an offline sale taken during today, synced now ---'
select jsonb_pretty(pg_temp.snap('a1_before')) as before;

do $$
declare v_id text;
begin
  select public.complete_sale_v5('cash', 0, '[{"itemId":"latte","quantity":1}]'::jsonb,
           '11110000-0000-4000-8000-00000000000a'::uuid,
           pg_temp.get('today_open')::timestamptz + interval '1 hour',
           'offline_queued', pg_temp.get('sess1')::uuid, pg_temp.get('reg_today')::uuid) ->> 'orderId'
    into v_id;
  perform pg_temp.put('a1_order', v_id);
end $$;

do $$
declare o record;
begin
  select * into o from public.orders where sale_request_id = '11110000-0000-4000-8000-00000000000a';
  if o.id is null then raise exception 'A1 FAILED: no order was created'; end if;
  if o.register_session_id is distinct from pg_temp.get('reg_today')::uuid then
    raise exception 'A1 FAILED: attributed to %, expected the CLAIMED register %',
      coalesce(o.register_session_id::text,'<null>'), pg_temp.get('reg_today');
  end if;
  if o.source <> 'offline_queued' then raise exception 'A1 FAILED: source %', o.source; end if;
  raise notice 'A1 PASS: order % attributed to the claimed register %', o.id, o.register_session_id;
end $$;

\echo ''
\echo '--- FIXTURE: yesterday''s context, created with the REAL business_day_bounds ---'
do $$
declare v_yd date; b record; v_reg uuid := '77770000-0000-4000-8000-00000000000a';
begin
  v_yd := (now() at time zone 'America/New_York')::date - 1;
  select * into b from public.business_day_bounds(v_yd, 'America/New_York');

  -- CLONED FROM THE ROW ensure_daily_register_context JUST CREATED, with only
  -- the identity and the window overridden. Cloning rather than hand-listing
  -- columns means every NOT NULL column this table has is populated exactly as
  -- the real function populates it, and a new column cannot silently break this
  -- fixture into something unrepresentative.
  insert into public.register_sessions
  select (r).*
  from (
    select (r #= hstore(array['id','business_date','opened_at','closed_at'],
                        array[v_reg::text, v_yd::text, b.starts_at::text, b.ends_at::text])) as r
    from public.register_sessions r
    where r.id = pg_temp.get('reg_today')::uuid
  ) q;

  perform pg_temp.put('reg_yest', v_reg::text);
  perform pg_temp.put('yest_open', b.starts_at::text);
  perform pg_temp.put('yest_close', b.ends_at::text);

  if b.ends_at >= now() then
    raise exception 'FIXTURE FAILED: yesterday''s window has not closed yet (%).', b.ends_at;
  end if;
end $$;
select pg_temp.get('reg_yest') as yesterday_register,
       pg_temp.get('yest_open') as opened_at, pg_temp.get('yest_close') as closed_at;

\echo ''
\echo '============ A2 : ACROSS MIDNIGHT -- SOLD AFTER THE WINDOW ENDED ============'
\echo '--- The till was offline through yesterday evening and kept selling past'
\echo '--- local midnight, still carrying YESTERDAY''s register claim. Those'
\echo '--- post-midnight sales fall outside the claimed window and must NOT be'
\echo '--- attributed to it. Timestamped five minutes after yesterday''s close,'
\echo '--- which is early today -- in the PAST, as an offline sale must be.'
select jsonb_pretty(pg_temp.snap('a2_before')) as before;

select pg_temp.expect_refusal(
  '11110000-0000-4000-8000-00000000000b'::uuid,
  pg_temp.get('yest_close')::timestamptz + interval '5 minutes',
  pg_temp.get('sess1')::uuid,
  pg_temp.get('reg_yest')::uuid,
  'A2');

select jsonb_pretty(pg_temp.snap('a2_after')) as after;
do $$
begin
  if pg_temp.get('a2_before') is distinct from pg_temp.get('a2_after') then
    raise exception 'A2 FAILED: side effects. before=% after=%',
      pg_temp.get('a2_before'), pg_temp.get('a2_after');
  end if;
  if exists (select 1 from public.orders where sale_request_id = '11110000-0000-4000-8000-00000000000b') then
    raise exception 'A2 FAILED: an order exists for the refused request';
  end if;
  raise notice 'A2 PASS: refused (%), ledger byte-identical, no order',
    pg_temp.get('A2_sqlstate');
end $$;

\echo ''
\echo '====== A3 : REGISTER ALREADY CLOSED, SALE INSIDE ITS WINDOW, LATE SYNC ======'
do $$
declare v_id text; o record;
begin
  select public.complete_sale_v5('cash', 0, '[{"itemId":"latte","quantity":1}]'::jsonb,
           '11110000-0000-4000-8000-00000000000c'::uuid,
           pg_temp.get('yest_open')::timestamptz + interval '10 hours',
           'offline_queued', pg_temp.get('sess1')::uuid, pg_temp.get('reg_yest')::uuid) ->> 'orderId'
    into v_id;
  perform pg_temp.put('a3_order', v_id);

  select * into o from public.orders where sale_request_id = '11110000-0000-4000-8000-00000000000c';
  if o.register_session_id is distinct from pg_temp.get('reg_yest')::uuid then
    raise exception 'A3 FAILED: attributed to %, expected the closed-but-covering register %',
      coalesce(o.register_session_id::text,'<null>'), pg_temp.get('reg_yest');
  end if;
  raise notice 'A3 PASS: late sync after close accepted, attributed to the ORIGINAL register %',
    o.register_session_id;
end $$;

-- The owner-reporting join must file it under YESTERDAY, not today.
do $$
declare v_date date;
begin
  select r.business_date into v_date
  from public.orders o join public.register_sessions r on r.id = o.register_session_id
  where o.sale_request_id = '11110000-0000-4000-8000-00000000000c';
  if v_date is distinct from (now() at time zone 'America/New_York')::date - 1 then
    raise exception 'A3 FAILED: reported business_date % is not yesterday', v_date;
  end if;
  raise notice 'A3 PASS: owner reporting files it under business_date %', v_date;
end $$;

\echo ''
\echo '============== A4 : ORIGINAL-ID IDEMPOTENCY OF THE LATE SALE =============='
select jsonb_pretty(pg_temp.snap('a4_before')) as before;
do $$
declare v_again text;
begin
  select public.complete_sale_v5('cash', 0, '[{"itemId":"latte","quantity":1}]'::jsonb,
           '11110000-0000-4000-8000-00000000000c'::uuid,
           pg_temp.get('yest_open')::timestamptz + interval '10 hours',
           'offline_queued', pg_temp.get('sess1')::uuid, pg_temp.get('reg_yest')::uuid) ->> 'orderId'
    into v_again;
  if v_again is distinct from pg_temp.get('a3_order') then
    raise exception 'A4 FAILED: replay returned % but the original was %',
      v_again, pg_temp.get('a3_order');
  end if;
end $$;
select jsonb_pretty(pg_temp.snap('a4_after')) as after;
do $$
begin
  if pg_temp.get('a4_before') is distinct from pg_temp.get('a4_after') then
    raise exception 'A4 FAILED: the replay had side effects';
  end if;
  raise notice 'A4 PASS: replay returned the SAME order id and changed nothing';
end $$;

\echo ''
\echo '################## B : THE BUSINESS-TIMEZONE CONFLICT ##################'
\echo '--- B0: the guard REFUSES the change where it applies (not bypassed) ---'
-- Project One has a daily context covering now(), because the fixture opened
-- today's register through the real RPC. The change must be refused.
do $$
declare v_blocked boolean := false; v_msg text;
begin
  if not public.project_has_covering_daily_register('a0000000-0000-4000-8000-000000000001', now()) then
    raise exception 'B0 FAILED: expected a covering daily context on Project One';
  end if;

  begin
    update public.projects set business_timezone = 'America/Los_Angeles'
    where id = 'a0000000-0000-4000-8000-000000000001';
  exception when others then
    v_msg := sqlerrm;
    if v_msg = 'business_timezone_change_blocked_open_register' then v_blocked := true;
    else raise; end if;
  end;

  if not v_blocked then
    raise exception 'B0 FAILED: the timezone change was PERMITTED under a covering context';
  end if;
  raise notice 'B0 PASS: guard refused the change (business_timezone_change_blocked_open_register)';
end $$;

\echo ''
\echo '--- B1: Project Two has only YESTERDAY''s context, so the change is allowed ---'
-- This is the reachability question. Yesterday's context is created with the
-- real business_day_bounds; nothing covers now(), because the till has not
-- opened today yet. That is an ordinary morning.
do $$
declare v_yd date; b record; v_reg uuid := '88880000-0000-4000-8000-00000000000b';
begin
  v_yd := (now() at time zone 'America/New_York')::date - 1;
  select * into b from public.business_day_bounds(v_yd, 'America/New_York');

  -- Same clone-and-override, retargeted to device two.
  insert into public.register_sessions
  select (r).*
  from (
    select (r #= hstore(array['id','paired_device_id','business_date','opened_at','closed_at'],
                        array[v_reg::text, 'c0000000-0000-4000-8000-000000000002',
                              v_yd::text, b.starts_at::text, b.ends_at::text])) as r
    from public.register_sessions r
    where r.id = pg_temp.get('reg_today')::uuid
  ) q;

  perform pg_temp.put('reg2_yest', v_reg::text);
  perform pg_temp.put('yest2_open', b.starts_at::text);
end $$;

do $$
begin
  if public.project_has_covering_daily_register('a0000000-0000-4000-8000-000000000002', now()) then
    raise exception 'B1 FAILED: Project Two unexpectedly has a covering context';
  end if;
  raise notice 'B1: no daily context covers now() on Project Two -- the guard does not apply';
end $$;

-- THE REACHABILITY PROOF. A real UPDATE, through the real trigger, with no
-- session_replication_role trick, no trigger disable, no direct catalog edit.
update public.projects set business_timezone = 'America/Los_Angeles'
where id = 'a0000000-0000-4000-8000-000000000002';

do $$
declare v_now text; v_snap text;
begin
  select business_timezone into v_now from public.projects
   where id = 'a0000000-0000-4000-8000-000000000002';
  select business_timezone into v_snap from public.register_sessions
   where id = pg_temp.get('reg2_yest')::uuid;

  if v_now <> 'America/Los_Angeles' then
    raise exception 'B1 FAILED: the timezone did not change (now %)', v_now;
  end if;
  if v_snap <> 'America/New_York' then
    raise exception 'B1 FAILED: the register snapshot moved (now %)', v_snap;
  end if;
  raise notice 'B1 PASS: REACHABLE. project zone is now %, the claim''s snapshot is still %',
    v_now, v_snap;
end $$;

\echo ''
\echo '--- B2: an offline sale claiming that register must be REFUSED ---'
select set_config('request.jwt.claim.sub', :du2, false);
do $$
begin
  if (public.employee_login_by_code('002','3333') ->> 'ok') is distinct from 'true' then
    raise exception 'FIXTURE FAILED: employee_login_by_code for device two';
  end if;
  perform pg_temp.put('sess2', (select id::text from public.employee_pos_sessions
                                where paired_device_id = 'c0000000-0000-4000-8000-000000000002'
                                  and ended_at is null));
end $$;

select jsonb_pretty(pg_temp.snap('b2_before')) as before;

select pg_temp.expect_refusal(
  '22220000-0000-4000-8000-00000000000a'::uuid,
  pg_temp.get('yest2_open')::timestamptz + interval '10 hours',
  pg_temp.get('sess2')::uuid,
  pg_temp.get('reg2_yest')::uuid,
  'B2');

select jsonb_pretty(pg_temp.snap('b2_after')) as after;
do $$
begin
  if pg_temp.get('b2_before') is distinct from pg_temp.get('b2_after') then
    raise exception 'B2 FAILED: side effects. before=% after=%',
      pg_temp.get('b2_before'), pg_temp.get('b2_after');
  end if;
  if exists (select 1 from public.orders where sale_request_id = '22220000-0000-4000-8000-00000000000a') then
    raise exception 'B2 FAILED: an order exists for the refused request';
  end if;
  raise notice 'B2 PASS: zone conflict refused (%), ledger byte-identical, no order',
    pg_temp.get('B2_sqlstate');
end $$;

\echo ''
\echo '--- B3: the SAME sale is accepted once the zone is put back ---'
-- Proves B2 refused because of the CONFLICT, not because the sale was bad.
update public.projects set business_timezone = 'America/New_York'
where id = 'a0000000-0000-4000-8000-000000000002';

do $$
declare v_id text; o record;
begin
  select public.complete_sale_v5('cash', 0, '[{"itemId":"latte","quantity":1}]'::jsonb,
           '22220000-0000-4000-8000-00000000000a'::uuid,
           pg_temp.get('yest2_open')::timestamptz + interval '10 hours',
           'offline_queued', pg_temp.get('sess2')::uuid, pg_temp.get('reg2_yest')::uuid) ->> 'orderId'
    into v_id;

  select * into o from public.orders where sale_request_id = '22220000-0000-4000-8000-00000000000a';
  if o.register_session_id is distinct from pg_temp.get('reg2_yest')::uuid then
    raise exception 'B3 FAILED: attributed to %, expected %',
      coalesce(o.register_session_id::text,'<null>'), pg_temp.get('reg2_yest');
  end if;
  raise notice 'B3 PASS: with the zone restored the SAME sale is accepted, order %, register %',
    o.id, o.register_session_id;
end $$;

\echo ''
\echo '--- B4: clearing the zone to NULL is also a conflict, and also refused ---'
update public.projects set business_timezone = null
where id = 'a0000000-0000-4000-8000-000000000002';

select pg_temp.expect_refusal(
  '22220000-0000-4000-8000-00000000000b'::uuid,
  pg_temp.get('yest2_open')::timestamptz + interval '11 hours',
  pg_temp.get('sess2')::uuid,
  pg_temp.get('reg2_yest')::uuid,
  'B4');
do $$ begin raise notice 'B4 PASS: a NULL current zone is distinct from the snapshot and refuses'; end $$;

\echo ''
\echo '############################ ALL ASSERTIONS PASSED ############################'
select k, v from obs where k like '%sqlstate' or k like '%message' order by k;
