-- v1.3 Feature 1A.1 — Employee selector and single-hash employee login.
--
-- FORWARD MIGRATION. 20260914120000_employee_identity_and_pos_sessions.sql has
-- been applied to staging and is immutable; every change to the employee
-- contract lands here instead. Nothing in this file edits, re-creates or
-- depends on the internals of that migration beyond the objects it created.
--
-- This migration is NOT applied automatically -- review, then apply manually,
-- as ONE SQL Editor submission (one session): the baseline temporary tables
-- below are compared against at the end.
--
-- ----------------------------------------------------------------------------
-- WHAT WAS WRONG WITH 1A, MEASURED
-- ----------------------------------------------------------------------------
-- employee_login(p_pin text) had to discover WHO was signing in by verifying the
-- submitted PIN against every active salted hash in the project, one bcrypt at a
-- time. Staging measured ~59 ms per active employee scanned: ~65 ms for the
-- first employee in scan order, ~2971 ms for the last one -- and for every wrong
-- PIN -- at a roster of 50. One device reaching lockout burned ~15 s of database
-- execution time.
--
-- The duplicate-PIN rule existed ONLY because the PIN was the identifier: if two
-- people shared a PIN, the scan could not tell them apart. create_employee and
-- set_employee_pin paid for that rule with a verification against every
-- employee in the project, active or not, which no ceiling bounded.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES
-- ----------------------------------------------------------------------------
--   1. list_login_employees()               -- the till's selector.
--   2. employee_login(uuid, text)           -- verifies exactly ONE hash.
--   3. drops employee_login(text)           -- no compatibility wrapper; the
--                                              contract is unreleased and the
--                                              only caller is lib/employee.rpc.ts.
--   4. drops employee_login_note_failure    -- its only caller was (3).
--   5. retires employee_login_attempts      -- device-only lockout; five typos
--                                              closed a whole store for 15 min.
--                                              Dropped ONLY if empty.
--   6. two-layer limiter:
--        employee_login_employee_attempts   -- per (device, employee) lockout
--        employee_login_device_failures     -- per-device rolling failure log
--        employee_login_device_throttles    -- per-device short cooldown
--   7. create_employee / set_employee_pin   -- duplicate-PIN scan removed.
--   8. drops employee_project_pin_taken     -- the last O(n) bcrypt path.
--
-- WHY DUPLICATE PINS ARE NOW HARMLESS. With a selector the PIN no longer
-- identifies anyone; it proves an identity the operator has already chosen.
-- Two employees sharing 1234 are each verified against their OWN hash only, and
-- guessing is per employee. No deterministic digest, lookup index, plaintext or
-- reversible form of any PIN is introduced to replace the retired rule.
--
-- THE 50 ACTIVE-EMPLOYEE CEILING IS DELIBERATELY UNCHANGED. It remains a
-- provisional engineering safety value pending staging benchmark evidence for
-- this new login path. It is not a product limit. The verification block below
-- asserts it is still present in create_employee and set_employee_active.
--
-- ----------------------------------------------------------------------------
-- THE LIMITER, AND WHY IT HAS TWO LAYERS
-- ----------------------------------------------------------------------------
-- Layer 1 -- (paired_device_id, employee_id) lockout, the approved ladder:
--     failures 1-4 no lock; 5 -> 30 s; 6 -> 60 s; 7 -> 120 s; 8 -> 300 s;
--     9 and above -> 900 s.
--   Blast radius: one person at one till. Only a wrong PIN for a VALID ACTIVE
--   selected employee counts here -- that is the only case where a hash was
--   actually tested. Cleared by that person's successful login at that till,
--   and by nothing else.
--
-- Layer 2 -- per-device throttle over a TRUE rolling 300-second window.
--   Every counted failure of any kind writes one event. After writing it, the
--   events with failed_at >= now - 300 s (inclusive) are counted:
--     1-14 no cooldown; 15-19 -> 15 s; 20-24 -> 30 s; 25+ -> 60 s.
--   The whole-till cooldown never exceeds 60 s. It stops guess rotation across
--   many employees on one till without ever taking a store down for minutes.
--
-- Counted failures:
--   valid active employee + wrong PIN     -> layer 1 AND one layer-2 event
--   malformed PIN                          -> one layer-2 event only
--   nonexistent / other-project / inactive -> one layer-2 event only
-- Not counted anywhere:
--   any request refused because layer 1 or layer 2 is already in force.
-- A cooldown is established or renewed ONLY by a new counted failure; old events
-- lingering inside the window never extend it on their own.
--
-- WHY A MALFORMED PIN DOES NOT TOUCH LAYER 1. No hash is tested, so it is not a
-- guess against that person -- and letting garbage input lock a NAMED colleague
-- would be a cheap, targeted denial of service. It still costs a layer-2 event,
-- so it is never a free probe.
--
-- ----------------------------------------------------------------------------
-- SERIALIZATION
-- ----------------------------------------------------------------------------
-- employee_login locks the caller's paired_devices row FOR UPDATE before it
-- reads or writes ANY limiter state, then (when an employee is selected) that
-- employee's attempt row. Every login on one till therefore runs one at a time:
-- two concurrent failures cannot both observe count 14 and both claim #15, a
-- call arriving during a cooldown always sees it, and login-as-switch cannot
-- leave two open sessions. The clock is read with clock_timestamp() AFTER the
-- lock is granted, so a waiting call never judges the window against a time
-- earlier than the failures committed ahead of it. The partial unique index
-- employee_pos_sessions_one_open_per_device remains the database backstop.
--
-- ----------------------------------------------------------------------------
-- EXPIRY WITHOUT A SCHEDULER
-- ----------------------------------------------------------------------------
-- No cron, background worker or scheduled job is introduced. Events older than
-- the window are ignored immediately by every security decision; physical
-- deletion is opportunistic and scoped to the device being written:
--   * device failure events older than 24 h are deleted when that device next
--     records a failure;
--   * an unlocked employee attempt row whose last failure is older than 24 h is
--     deleted at the same moment;
--   * an expired throttle row is deleted on a successful login once no failure
--     remains inside the window.
--
-- Every function below: SECURITY DEFINER, search_path exactly public, pg_temp
-- (never widened), and an explicit revoke from service_role -- Supabase's
-- default privileges give every new public function an EXPLICIT service_role
-- EXECUTE entry that `revoke ... from public` does not remove. That exact gap
-- aborted the first staging apply of 20260914120000.

-- ----------------------------------------------------------------------------
-- 0. Self-capturing baselines, recorded BEFORE any DDL.
--
-- Functions this migration replaces or drops are excluded from the function
-- baseline by name; every other public function must come out byte-identical.
-- ----------------------------------------------------------------------------
create temporary table f1a1_proc_baseline as
select p.oid as fn_oid,
       p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       md5(pg_get_functiondef(p.oid)) as body,
       p.prosecdef,
       coalesce(p.proconfig, array[]::text[]) as config,
       coalesce(p.proacl::text, 'default') as acl
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f'
  and p.proname not in (
    'employee_login',
    'employee_login_note_failure',
    'employee_project_pin_taken',
    'create_employee',
    'set_employee_pin'
  );

create temporary table f1a1_pol_baseline as
select tablename, policyname, cmd, qual, with_check, roles::text as roles
from pg_policies
where schemaname = 'public';

create temporary table f1a1_priv_baseline as
select r.rolname, t.tablename, p.priv,
       has_table_privilege(r.rolname, format('public.%I', t.tablename), p.priv) as held
from (values ('anon'), ('authenticated'), ('service_role')) as r(rolname)
cross join (values ('paired_devices'), ('device_pairing_tokens'), ('projects'),
                   ('orders'), ('order_items'), ('inventory_transactions'),
                   ('build_jobs'), ('build_artifacts'),
                   ('employees'), ('employee_pos_sessions')) as t(tablename)
cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
                   ('REFERENCES'), ('TRIGGER')) as p(priv);

create temporary table f1a1_trg_baseline as
select c.relname, t.tgname, t.tgtype, t.tgenabled, pr.proname
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_proc pr on pr.oid = t.tgfoid
where n.nspname = 'public' and not t.tgisinternal;

-- Employee and session HISTORY must survive untouched: same rows, same columns.
create temporary table f1a1_row_baseline as
select (select count(*) from public.paired_devices) as devices,
       (select coalesce(md5(string_agg(md5(d::text), '|' order by d.id::text)), 'empty')
        from public.paired_devices d) as devices_fp,
       (select count(*) from public.employees) as employees,
       (select coalesce(md5(string_agg(md5(e::text), '|' order by e.id::text)), 'empty')
        from public.employees e) as employees_fp,
       (select count(*) from public.employee_pos_sessions) as sessions,
       (select coalesce(md5(string_agg(md5(s::text), '|' order by s.id::text)), 'empty')
        from public.employee_pos_sessions s) as sessions_fp,
       (select md5(string_agg(table_name || '.' || column_name || ':' || data_type, ','
                              order by table_name, ordinal_position))
        from information_schema.columns
        where table_schema = 'public'
          and table_name in ('employees', 'employee_pos_sessions')) as history_columns;

-- ----------------------------------------------------------------------------
-- 1. Retire the PIN-only login path.
--
-- No compatibility wrapper. Two authentication entry points would be two places
-- for an authorization defect to live, and nothing released calls this one.
-- DROP without CASCADE: if anything had come to depend on it, this fails loudly.
-- ----------------------------------------------------------------------------
drop function public.employee_login(text);

-- Its only caller was the function above. It writes to the table retired next.
drop function public.employee_login_note_failure(uuid, timestamptz);

-- ----------------------------------------------------------------------------
-- 2. Retire the device-only attempt table -- but never with live state in it.
--
-- Its semantics (one counter for a whole till) are superseded by section 3. It
-- holds only transient lockout state, never history, but a non-empty table means
-- a till is mid-lockout somewhere; dropping that silently would be a quiet
-- security reset. So this refuses instead, and the whole migration rolls back.
-- ----------------------------------------------------------------------------
do $do$
begin
  if exists (select 1 from public.employee_login_attempts) then
    raise exception
      'F1A.1: employee_login_attempts still holds limiter state; refusing to drop it';
  end if;
end
$do$;

drop table public.employee_login_attempts;

-- ----------------------------------------------------------------------------
-- 3. The two-layer limiter.
-- ----------------------------------------------------------------------------

-- Layer 1: one row per (till, employee) that has failed there and not since
-- succeeded. A row exists only because a failure happened, so failed_count >= 1.
create table if not exists public.employee_login_employee_attempts (
  paired_device_id uuid not null
    references public.paired_devices(id) on delete cascade,
  employee_id uuid not null
    references public.employees(id) on delete cascade,

  failed_count integer not null,
  first_failed_at timestamptz not null,
  last_failed_at timestamptz not null,
  locked_until timestamptz,
  updated_at timestamptz not null default now(),

  constraint employee_login_employee_attempts_pkey
    primary key (paired_device_id, employee_id),
  constraint employee_login_employee_attempts_failed_count_check
    check (failed_count >= 1),
  constraint employee_login_employee_attempts_failure_order_check
    check (last_failed_at >= first_failed_at)
);

comment on table public.employee_login_employee_attempts is
  'v1.3 Feature 1A.1 -- per (paired device, employee) failed-login state and lockout. '
  'Only a wrong PIN for a valid active selected employee increments it.';

-- The primary key serves device-first lookups; this serves the employee FK
-- cascade, which would otherwise scan the table.
create index if not exists employee_login_employee_attempts_employee_idx
  on public.employee_login_employee_attempts using btree (employee_id);

-- Layer 2a: the rolling failure log. uuid key rather than an identity column
-- on purpose: an identity creates a sequence, and Supabase's default privileges
-- would hand that sequence to anon and authenticated.
create table if not exists public.employee_login_device_failures (
  id uuid primary key default gen_random_uuid(),
  paired_device_id uuid not null
    references public.paired_devices(id) on delete cascade,
  failed_at timestamptz not null
);

comment on table public.employee_login_device_failures is
  'v1.3 Feature 1A.1 -- one row per counted failed employee login on a paired device. '
  'Only rows inside the rolling 300-second window affect any security decision.';

-- Exactly the shape of the window query: device equality, then a time range.
create index if not exists employee_login_device_failures_device_time_idx
  on public.employee_login_device_failures using btree (paired_device_id, failed_at);

-- Layer 2b: the cooldown itself. At most one row per till.
create table if not exists public.employee_login_device_throttles (
  paired_device_id uuid primary key
    references public.paired_devices(id) on delete cascade,
  throttled_until timestamptz not null,
  updated_at timestamptz not null default now()
);

comment on table public.employee_login_device_throttles is
  'v1.3 Feature 1A.1 -- short whole-device login cooldown, never longer than 60 seconds.';

-- ----------------------------------------------------------------------------
-- 4. RLS and privileges -- the same zero-grant posture as the 1A tables.
--
-- Revoke first: Supabase default privileges give every new table ALL to anon,
-- authenticated and service_role, and TRUNCATE ignores RLS. Nothing is granted
-- back to anyone. RLS is on with no policy, so even a future accidental grant
-- would still read zero rows.
-- ----------------------------------------------------------------------------
alter table public.employee_login_employee_attempts enable row level security;
alter table public.employee_login_device_failures enable row level security;
alter table public.employee_login_device_throttles enable row level security;

revoke all privileges on table public.employee_login_employee_attempts from public;
revoke all privileges on table public.employee_login_employee_attempts from anon;
revoke all privileges on table public.employee_login_employee_attempts from authenticated;
revoke all privileges on table public.employee_login_employee_attempts from service_role;

revoke all privileges on table public.employee_login_device_failures from public;
revoke all privileges on table public.employee_login_device_failures from anon;
revoke all privileges on table public.employee_login_device_failures from authenticated;
revoke all privileges on table public.employee_login_device_failures from service_role;

revoke all privileges on table public.employee_login_device_throttles from public;
revoke all privileges on table public.employee_login_device_throttles from anon;
revoke all privileges on table public.employee_login_device_throttles from authenticated;
revoke all privileges on table public.employee_login_device_throttles from service_role;

-- ----------------------------------------------------------------------------
-- 5. Private helpers -- granted to nobody.
--
-- The two constant tables are separate immutable functions so that the exact
-- tiers are callable, provable at apply time, and testable from the SQL source
-- itself rather than from a copy of it.
-- ----------------------------------------------------------------------------

-- Layer 1 ladder, applied to the NEW failure count.
create or replace function public.employee_login_employee_lock_seconds(p_failed_count integer)
returns integer
language sql
immutable
security definer
set search_path = public, pg_temp
as $function$
  select case
    when p_failed_count >= 9 then 900
    when p_failed_count = 8 then 300
    when p_failed_count = 7 then 120
    when p_failed_count = 6 then 60
    when p_failed_count = 5 then 30
    else 0
  end
$function$;

revoke all on function public.employee_login_employee_lock_seconds(integer) from public;
revoke all on function public.employee_login_employee_lock_seconds(integer) from anon;
revoke all on function public.employee_login_employee_lock_seconds(integer) from authenticated;
revoke all on function public.employee_login_employee_lock_seconds(integer) from service_role;

-- Layer 2 tiers, applied to the rolling count INCLUDING the failure just written.
-- 60 s is the ceiling for a whole till; there is no longer tier.
create or replace function public.employee_login_device_cooldown_seconds(p_recent_failures integer)
returns integer
language sql
immutable
security definer
set search_path = public, pg_temp
as $function$
  select case
    when p_recent_failures >= 25 then 60
    when p_recent_failures >= 20 then 30
    when p_recent_failures >= 15 then 15
    else 0
  end
$function$;

revoke all on function public.employee_login_device_cooldown_seconds(integer) from public;
revoke all on function public.employee_login_device_cooldown_seconds(integer) from anon;
revoke all on function public.employee_login_device_cooldown_seconds(integer) from authenticated;
revoke all on function public.employee_login_device_cooldown_seconds(integer) from service_role;

-- Layer 1 write. Called ONLY for a valid active selected employee whose single
-- hash verification failed, and only while the caller holds the device lock.
create or replace function public.employee_login_record_employee_failure(
  p_paired_device_id uuid,
  p_employee_id uuid,
  p_now timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_count integer;
  v_lock integer;
begin
  insert into public.employee_login_employee_attempts as a
    (paired_device_id, employee_id, failed_count, first_failed_at, last_failed_at,
     locked_until, updated_at)
  values
    (p_paired_device_id, p_employee_id, 1, p_now, p_now, null, p_now)
  on conflict (paired_device_id, employee_id) do update
    set failed_count = a.failed_count + 1,
        last_failed_at = p_now,
        updated_at = p_now
  returning failed_count into v_count;

  v_lock := public.employee_login_employee_lock_seconds(v_count);

  update public.employee_login_employee_attempts a
  set locked_until = case when v_lock > 0
                          then p_now + make_interval(secs => v_lock)
                          else null
                     end
  where a.paired_device_id = p_paired_device_id
    and a.employee_id = p_employee_id;
end;
$function$;

revoke all on function public.employee_login_record_employee_failure(uuid, uuid, timestamptz) from public;
revoke all on function public.employee_login_record_employee_failure(uuid, uuid, timestamptz) from anon;
revoke all on function public.employee_login_record_employee_failure(uuid, uuid, timestamptz) from authenticated;
revoke all on function public.employee_login_record_employee_failure(uuid, uuid, timestamptz) from service_role;

-- Layer 2 write. Exactly one event per call; the count is taken AFTER the insert
-- so it includes this failure; a cooldown is set only from that fresh count.
-- greatest() means a new failure can never SHORTEN a cooldown -- though under the
-- device lock none can arrive while one is active, because such requests are
-- refused before reaching here.
create or replace function public.employee_login_record_device_failure(
  p_paired_device_id uuid,
  p_now timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_recent integer;
  v_cooldown integer;
begin
  insert into public.employee_login_device_failures (paired_device_id, failed_at)
  values (p_paired_device_id, p_now);

  select count(*) into v_recent
  from public.employee_login_device_failures f
  where f.paired_device_id = p_paired_device_id
    and f.failed_at >= p_now - interval '300 seconds';

  v_cooldown := public.employee_login_device_cooldown_seconds(v_recent);

  if v_cooldown > 0 then
    insert into public.employee_login_device_throttles as t
      (paired_device_id, throttled_until, updated_at)
    values
      (p_paired_device_id, p_now + make_interval(secs => v_cooldown), p_now)
    on conflict (paired_device_id) do update
      set throttled_until = greatest(t.throttled_until, excluded.throttled_until),
          updated_at = excluded.updated_at;
  end if;

  -- Opportunistic expiry, this device only.
  delete from public.employee_login_device_failures f
  where f.paired_device_id = p_paired_device_id
    and f.failed_at < p_now - interval '24 hours';

  delete from public.employee_login_employee_attempts a
  where a.paired_device_id = p_paired_device_id
    and (a.locked_until is null or a.locked_until <= p_now)
    and a.last_failed_at < p_now - interval '24 hours';
end;
$function$;

revoke all on function public.employee_login_record_device_failure(uuid, timestamptz) from public;
revoke all on function public.employee_login_record_device_failure(uuid, timestamptz) from anon;
revoke all on function public.employee_login_record_device_failure(uuid, timestamptz) from authenticated;
revoke all on function public.employee_login_record_device_failure(uuid, timestamptz) from service_role;

-- ----------------------------------------------------------------------------
-- 6. list_login_employees -- the till's selector.
--
-- Zero arguments: the project is read off the caller's own ACTIVE pairing row,
-- never supplied. Active employees only. Each entry is exactly employeeId and
-- displayName.
--
-- ROLE IS DELIBERATELY ABSENT. Nothing on the till needs it before a person has
-- authenticated, and listing who the managers are on a counter-facing screen is
-- free reconnaissance. Role is returned only after successful login.
--
-- Ordered by display_name then id -- stable for presentation, and NOT by
-- created_at, which would disclose hire order. Two employees may share a
-- display name; both are returned, distinguished only by employeeId.
-- ----------------------------------------------------------------------------
create or replace function public.list_login_employees()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller uuid;
  v_project_id uuid;
  v_employees jsonb;
begin
  v_caller := auth.uid();

  if v_caller is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  select d.project_id
  into v_project_id
  from public.paired_devices d
  where d.auth_user_id = v_caller
    and d.revoked_at is null
    and d.unpaired_at is null;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_paired');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object('employeeId', e.id, 'displayName', e.display_name)
      order by e.display_name, e.id
    ),
    '[]'::jsonb
  )
  into v_employees
  from public.employees e
  where e.project_id = v_project_id
    and e.active;

  return jsonb_build_object('ok', true, 'employees', v_employees);
end;
$function$;

revoke all on function public.list_login_employees() from public;
revoke all on function public.list_login_employees() from anon;
revoke all on function public.list_login_employees() from service_role;
grant execute on function public.list_login_employees() to authenticated;

-- ----------------------------------------------------------------------------
-- 7. employee_login(p_employee_id, p_pin) -- exactly one hash verification.
--
-- p_employee_id is an IDENTIFIER, never authorization: the project, the active
-- flag and the hash are all re-read server-side, and an id belonging to another
-- project is indistinguishable from one that does not exist.
--
-- Order, and why it matters:
--   a. caller, then the ACTIVE pairing row, locked -- before any limiter access;
--   b. clock read after the lock is granted;
--   c. whole-device cooldown -- refused with no bcrypt and no writes;
--   d. the selected employee, by primary key, in THIS project, active only --
--      a single row or none, so there is nothing to iterate;
--   e. that employee's lockout at this till -- refused with no bcrypt and no
--      writes;
--   f. PIN shape, never trimmed, padded or repaired;
--   g. one verification;
--   h. success: clear only this (till, employee) state, switch the session.
--
-- Nonexistent, other-project, inactive, malformed and wrong all return the one
-- generic invalid_credentials, held in a single constant so they cannot drift.
-- The body never contains a scan of the roster; the verification block asserts
-- that structurally.
-- ----------------------------------------------------------------------------
create or replace function public.employee_login(p_employee_id uuid, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_generic_failure constant jsonb :=
    jsonb_build_object('ok', false, 'error', 'invalid_credentials');
  v_caller uuid;
  v_device record;
  v_now timestamptz;
  v_throttled_until timestamptz;
  v_employee record;
  v_locked_until timestamptz;
  v_session_id uuid;
begin
  v_caller := auth.uid();

  if v_caller is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  select d.id, d.project_id
  into v_device
  from public.paired_devices d
  where d.auth_user_id = v_caller
    and d.revoked_at is null
    and d.unpaired_at is null
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_paired');
  end if;

  v_now := clock_timestamp();

  select t.throttled_until
  into v_throttled_until
  from public.employee_login_device_throttles t
  where t.paired_device_id = v_device.id;

  if v_throttled_until is not null and v_throttled_until > v_now then
    return jsonb_build_object(
      'ok', false,
      'error', 'locked_out',
      'retryAfterSeconds',
        ceil(extract(epoch from (v_throttled_until - v_now)))::integer
    );
  end if;

  select e.id, e.display_name, e.role, e.pin_hash
  into v_employee
  from public.employees e
  where e.id = p_employee_id
    and e.project_id = v_device.project_id
    and e.active;

  if not found then
    perform public.employee_login_record_device_failure(v_device.id, v_now);
    return v_generic_failure;
  end if;

  select a.locked_until
  into v_locked_until
  from public.employee_login_employee_attempts a
  where a.paired_device_id = v_device.id
    and a.employee_id = v_employee.id
  for update;

  if v_locked_until is not null and v_locked_until > v_now then
    return jsonb_build_object(
      'ok', false,
      'error', 'locked_out',
      'retryAfterSeconds',
        ceil(extract(epoch from (v_locked_until - v_now)))::integer
    );
  end if;

  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then
    perform public.employee_login_record_device_failure(v_device.id, v_now);
    return v_generic_failure;
  end if;

  if not public.employee_pin_verify(p_pin, v_employee.pin_hash) then
    perform public.employee_login_record_employee_failure(v_device.id, v_employee.id, v_now);
    perform public.employee_login_record_device_failure(v_device.id, v_now);
    return v_generic_failure;
  end if;

  delete from public.employee_login_employee_attempts a
  where a.paired_device_id = v_device.id
    and a.employee_id = v_employee.id;

  delete from public.employee_login_device_throttles t
  where t.paired_device_id = v_device.id
    and t.throttled_until <= v_now
    and not exists (
      select 1
      from public.employee_login_device_failures f
      where f.paired_device_id = v_device.id
        and f.failed_at >= v_now - interval '300 seconds'
    );

  update public.employee_pos_sessions s
  set ended_at = v_now,
      end_reason = 'switched'
  where s.paired_device_id = v_device.id
    and s.ended_at is null;

  insert into public.employee_pos_sessions (employee_id, paired_device_id, started_at)
  values (v_employee.id, v_device.id, v_now)
  returning id into v_session_id;

  return jsonb_build_object(
    'ok', true,
    'employeeSessionId', v_session_id,
    'employeeId', v_employee.id,
    'displayName', v_employee.display_name,
    'role', v_employee.role,
    'startedAt', v_now
  );
end;
$function$;

revoke all on function public.employee_login(uuid, text) from public;
revoke all on function public.employee_login(uuid, text) from anon;
revoke all on function public.employee_login(uuid, text) from service_role;
grant execute on function public.employee_login(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 8. create_employee / set_employee_pin -- duplicate-PIN enforcement removed.
--
-- Identical to their 20260914120000 definitions except that the project-wide
-- candidate scan and its error are gone. Every other rule is unchanged,
-- including the provisional 50 active-employee engineering ceiling in
-- create_employee. PINs are still stored only as salted bcrypt.
-- ----------------------------------------------------------------------------
create or replace function public.create_employee(
  p_project_id uuid,
  p_display_name text,
  p_role text,
  p_pin text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller uuid;
  v_project_owner uuid;
  v_active_count integer;
  v_employee record;
begin
  v_caller := auth.uid();

  if v_caller is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  if exists (select 1 from public.paired_devices d where d.auth_user_id = v_caller) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if p_project_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  select p.user_id into v_project_owner
  from public.projects p
  where p.id = p_project_id;

  if not found or v_project_owner is distinct from v_caller then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if p_display_name is null or btrim(p_display_name) = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_display_name');
  end if;

  if p_role is null or p_role not in ('owner', 'manager', 'cashier') then
    return jsonb_build_object('ok', false, 'error', 'invalid_role');
  end if;

  -- Never trimmed or padded into validity.
  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_pin');
  end if;

  select count(*) into v_active_count
  from public.employees e
  where e.project_id = p_project_id
    and e.active;

  -- Provisional engineering ceiling, not a supported limit.
  if v_active_count >= 50 then
    return jsonb_build_object('ok', false, 'error', 'employee_limit_reached');
  end if;

  insert into public.employees (project_id, display_name, role, pin_hash)
  values (p_project_id, btrim(p_display_name), p_role, public.employee_pin_hash(p_pin))
  returning id, display_name, role, active, created_at into v_employee;

  return jsonb_build_object(
    'ok', true,
    'employeeId', v_employee.id,
    'displayName', v_employee.display_name,
    'role', v_employee.role,
    'active', v_employee.active,
    'createdAt', v_employee.created_at
  );
end;
$function$;

revoke all on function public.create_employee(uuid, text, text, text) from public;
revoke all on function public.create_employee(uuid, text, text, text) from anon;
revoke all on function public.create_employee(uuid, text, text, text) from service_role;
grant execute on function public.create_employee(uuid, text, text, text) to authenticated;

create or replace function public.set_employee_pin(
  p_employee_id uuid,
  p_pin text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller uuid;
  v_employee record;
begin
  v_caller := auth.uid();

  if v_caller is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  if exists (select 1 from public.paired_devices d where d.auth_user_id = v_caller) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if p_employee_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  select e.id, e.project_id
  into v_employee
  from public.employees e
  join public.projects p on p.id = e.project_id
  where e.id = p_employee_id
    and p.user_id = v_caller;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_pin');
  end if;

  update public.employees e
  set pin_hash = public.employee_pin_hash(p_pin)
  where e.id = v_employee.id;

  -- Deliberately returns no PIN material of any kind, not even a length.
  return jsonb_build_object('ok', true, 'employeeId', v_employee.id);
end;
$function$;

revoke all on function public.set_employee_pin(uuid, text) from public;
revoke all on function public.set_employee_pin(uuid, text) from anon;
revoke all on function public.set_employee_pin(uuid, text) from service_role;
grant execute on function public.set_employee_pin(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 9. The last O(n) bcrypt path is gone.
--
-- Dropped only after both callers above were replaced. No CASCADE.
-- ----------------------------------------------------------------------------
drop function public.employee_project_pin_taken(uuid, text, uuid);

-- ----------------------------------------------------------------------------
-- 10. Verification -- fails loudly, and the whole migration rolls back with it.
--
--   A. what this migration built or retired is exactly as intended;
--   B. everything it was meant to leave alone is byte-for-byte unchanged.
-- ----------------------------------------------------------------------------
do $do$
declare
  v_def text;
  v_text text;
  v_oid oid;
  v_row record;
  v_count integer;
  v_sig text;
  v_tbl text;
  v_role text;
  v_priv text;
  v_lock_at integer;
  v_first_limiter_at integer;
  v_new_triggers text[];
  -- Callable by an ordinary signed-in caller.
  v_public_sigs text[] := array[
    'public.list_login_employees()',
    'public.employee_login(uuid,text)',
    'public.create_employee(uuid,text,text,text)',
    'public.set_employee_pin(uuid,text)',
    'public.get_current_employee_session()',
    'public.employee_logout()',
    'public.list_employees(uuid)',
    'public.set_employee_active(uuid,boolean)'
  ];
  -- Callable by nobody.
  v_private_sigs text[] := array[
    'public.employee_login_employee_lock_seconds(integer)',
    'public.employee_login_device_cooldown_seconds(integer)',
    'public.employee_login_record_employee_failure(uuid,uuid,timestamptz)',
    'public.employee_login_record_device_failure(uuid,timestamptz)',
    'public.employee_pin_hash(text)',
    'public.employee_pin_verify(text,text)',
    'public.set_employees_updated_at()'
  ];
  v_new_tables text[] := array[
    'employee_login_employee_attempts',
    'employee_login_device_failures',
    'employee_login_device_throttles'
  ];
begin
  -- The smoke calls below must run with NO caller identity, whatever session
  -- this migration is applied from. Transaction-local.
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);

  -- ==========================================================================
  -- A1. The retired objects are gone, and exactly one employee_login remains.
  -- ==========================================================================
  if to_regprocedure('public.employee_login(text)') is not null then
    raise exception 'F1A.1: the PIN-only employee_login(text) still exists';
  end if;

  if to_regprocedure('public.employee_login_note_failure(uuid,timestamptz)') is not null then
    raise exception 'F1A.1: employee_login_note_failure was not retired';
  end if;

  if to_regprocedure('public.employee_project_pin_taken(uuid,text,uuid)') is not null then
    raise exception 'F1A.1: the duplicate-PIN helper employee_project_pin_taken was not retired';
  end if;

  if to_regclass('public.employee_login_attempts') is not null then
    raise exception 'F1A.1: the device-only employee_login_attempts table was not retired';
  end if;

  select count(*) into v_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'employee_login';

  if v_count <> 1 then
    raise exception 'F1A.1: expected exactly one employee_login overload, found %', v_count;
  end if;

  -- ==========================================================================
  -- A2. Every function this contract needs exists, SECURITY DEFINER, with a
  -- search_path of exactly public, pg_temp.
  -- ==========================================================================
  foreach v_sig in array (v_public_sigs || v_private_sigs)
  loop
    if to_regprocedure(v_sig) is null then
      raise exception 'F1A.1: function % is missing', v_sig;
    end if;

    v_oid := to_regprocedure(v_sig)::oid;

    if not (select p.prosecdef from pg_proc p where p.oid = v_oid) then
      raise exception 'F1A.1: % must be SECURITY DEFINER', v_sig;
    end if;

    if not exists (
      select 1 from pg_proc p,
        unnest(coalesce(p.proconfig, array[]::text[])) as cfg
      where p.oid = v_oid
        and regexp_replace(cfg, '[\s"]', '', 'g') = 'search_path=public,pg_temp'
    ) then
      raise exception 'F1A.1: % must lock search_path to exactly public, pg_temp', v_sig;
    end if;
  end loop;

  -- ==========================================================================
  -- A3. EXECUTE: public RPCs to authenticated only; helpers to nobody.
  -- ==========================================================================
  foreach v_sig in array v_public_sigs
  loop
    v_oid := to_regprocedure(v_sig)::oid;

    if not has_function_privilege('authenticated', v_oid, 'EXECUTE') then
      raise exception 'F1A.1: authenticated must be able to execute %', v_sig;
    end if;

    if has_function_privilege('anon', v_oid, 'EXECUTE') then
      raise exception 'F1A.1: anon must NOT be able to execute %', v_sig;
    end if;

    if has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception 'F1A.1: service_role must NOT be able to execute %', v_sig;
    end if;
  end loop;

  foreach v_sig in array v_private_sigs
  loop
    v_oid := to_regprocedure(v_sig)::oid;

    foreach v_role in array array['anon', 'authenticated', 'service_role']
    loop
      if has_function_privilege(v_role, v_oid, 'EXECUTE') then
        raise exception 'F1A.1: % is private and % must not execute it', v_sig, v_role;
      end if;
    end loop;
  end loop;

  -- ==========================================================================
  -- A4. The limiter tables: present, RLS on, no policy, no privilege for anyone.
  -- ==========================================================================
  foreach v_tbl in array v_new_tables
  loop
    if to_regclass(format('public.%I', v_tbl)) is null then
      raise exception 'F1A.1: table % is missing', v_tbl;
    end if;

    if not (select c.relrowsecurity from pg_class c
            where c.oid = to_regclass(format('public.%I', v_tbl))) then
      raise exception 'F1A.1: row level security is not enabled on %', v_tbl;
    end if;

    if exists (select 1 from pg_policies
               where schemaname = 'public' and tablename = v_tbl) then
      raise exception 'F1A.1: % must carry no policy', v_tbl;
    end if;

    foreach v_role in array array['anon', 'authenticated', 'service_role']
    loop
      foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE',
                                    'TRUNCATE', 'REFERENCES', 'TRIGGER']
      loop
        if has_table_privilege(v_role, format('public.%I', v_tbl), v_priv) then
          raise exception 'F1A.1: % holds % on %', v_role, v_priv, v_tbl;
        end if;
      end loop;
    end loop;
  end loop;

  -- ==========================================================================
  -- A5. SINGLE VERIFICATION. employee_login calls the verifier exactly once,
  -- selects the employee by primary key, and contains no iteration at all.
  -- ==========================================================================
  v_def := pg_get_functiondef('public.employee_login(uuid,text)'::regprocedure);

  v_count := (length(v_def) - length(replace(v_def, 'employee_pin_verify(', '')))
             / length('employee_pin_verify(');

  if v_count <> 1 then
    raise exception 'F1A.1: employee_login must verify exactly one hash; found % calls', v_count;
  end if;

  if v_def ~* '\mloop\M' or v_def ~* '\mforeach\M' then
    raise exception 'F1A.1: employee_login must not iterate';
  end if;

  if position('where e.id = p_employee_id' in v_def) = 0 then
    raise exception 'F1A.1: employee_login must resolve the selected employee by id';
  end if;

  -- No other function in the schema verifies a PIN.
  select string_agg(p.oid::regprocedure::text, ', ') into v_text
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
    and p.proname <> 'employee_pin_verify'
    and p.oid <> 'public.employee_login(uuid,text)'::regprocedure
    and position('employee_pin_verify(' in pg_get_functiondef(p.oid)) > 0;

  if v_text is not null then
    raise exception 'F1A.1: only employee_login may verify a PIN; also found in: %', v_text;
  end if;

  -- ==========================================================================
  -- A6. Duplicate-PIN enforcement is gone from both owner RPCs, which still hash.
  -- ==========================================================================
  foreach v_sig in array array['public.create_employee(uuid,text,text,text)',
                               'public.set_employee_pin(uuid,text)']
  loop
    v_def := pg_get_functiondef(v_sig::regprocedure);

    if position('employee_pin_verify' in v_def) > 0
       or position('employee_project_pin_taken' in v_def) > 0
       or position('duplicate_pin' in v_def) > 0 then
      raise exception 'F1A.1: % still performs duplicate-PIN enforcement', v_sig;
    end if;

    if v_def ~* '\mloop\M' then
      raise exception 'F1A.1: % must not iterate', v_sig;
    end if;

    if position('public.employee_pin_hash(p_pin)' in v_def) = 0 then
      raise exception 'F1A.1: % must still store only a salted hash', v_sig;
    end if;
  end loop;

  -- ==========================================================================
  -- A7. The provisional 50 active-employee engineering ceiling is still there.
  -- ==========================================================================
  foreach v_sig in array array['public.create_employee(uuid,text,text,text)',
                               'public.set_employee_active(uuid,boolean)']
  loop
    if position('v_active_count >= 50' in pg_get_functiondef(v_sig::regprocedure)) = 0 then
      raise exception 'F1A.1: the provisional 50 active-employee ceiling is missing from %', v_sig;
    end if;
  end loop;

  -- ==========================================================================
  -- A8. The locked constants, evaluated live -- not pattern-matched.
  -- ==========================================================================
  for v_row in
    select * from (values (0, 0), (1, 0), (4, 0), (5, 30), (6, 60), (7, 120),
                          (8, 300), (9, 900), (10, 900), (50, 900)) as x(n, expected)
  loop
    if public.employee_login_employee_lock_seconds(v_row.n) is distinct from v_row.expected then
      raise exception 'F1A.1: employee lockout for % failures is %, expected %',
        v_row.n, public.employee_login_employee_lock_seconds(v_row.n), v_row.expected;
    end if;
  end loop;

  for v_row in
    select * from (values (0, 0), (1, 0), (14, 0), (15, 15), (19, 15), (20, 30),
                          (24, 30), (25, 60), (26, 60), (1000, 60)) as x(n, expected)
  loop
    if public.employee_login_device_cooldown_seconds(v_row.n) is distinct from v_row.expected then
      raise exception 'F1A.1: device cooldown for % recent failures is %, expected %',
        v_row.n, public.employee_login_device_cooldown_seconds(v_row.n), v_row.expected;
    end if;
  end loop;

  -- ==========================================================================
  -- A9. The rolling window is inclusive and 300 seconds, and the count that
  -- sets a cooldown is taken AFTER the new failure is written.
  -- ==========================================================================
  v_def := pg_get_functiondef(
    'public.employee_login_record_device_failure(uuid,timestamptz)'::regprocedure);

  if position('f.failed_at >= p_now - interval ''300 seconds''' in v_def) = 0 then
    raise exception 'F1A.1: the device window must be failed_at >= now - 300 seconds';
  end if;

  if position('insert into public.employee_login_device_failures' in v_def)
     > position('select count(*) into v_recent' in v_def) then
    raise exception 'F1A.1: the rolling count must include the failure just recorded';
  end if;

  -- ==========================================================================
  -- A10. Lock order: the pairing row is locked, and the clock read, before any
  -- limiter state is touched; malformed PINs are still accounted server-side.
  -- ==========================================================================
  v_def := pg_get_functiondef('public.employee_login(uuid,text)'::regprocedure);
  v_lock_at := position('for update;' in v_def);

  select min(pos) into v_first_limiter_at
  from (values (position('employee_login_device_throttles' in v_def)),
               (position('employee_login_employee_attempts' in v_def)),
               (position('employee_login_record_' in v_def))) as x(pos)
  where pos > 0;

  if v_lock_at = 0 or v_first_limiter_at is null or v_lock_at > v_first_limiter_at then
    raise exception 'F1A.1: employee_login must lock the paired device before any limiter access';
  end if;

  if position('v_now := clock_timestamp();' in v_def) < v_lock_at then
    raise exception 'F1A.1: employee_login must read the clock after the device lock';
  end if;

  if position('p_pin !~ ''^[0-9]{4,6}$''' in v_def) = 0 then
    raise exception 'F1A.1: employee_login must validate PIN shape server-side';
  end if;

  -- ==========================================================================
  -- A11. The one-open-session invariant is still a real partial unique index.
  -- ==========================================================================
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'employee_pos_sessions'
      and indexname = 'employee_pos_sessions_one_open_per_device'
      and indexdef like '%UNIQUE%'
      and indexdef like '%ended_at IS NULL%'
  ) then
    raise exception 'F1A.1: employee_pos_sessions_one_open_per_device is missing or weakened';
  end if;

  -- ==========================================================================
  -- A12. No deterministic PIN material replaced the retired rule.
  -- ==========================================================================
  if exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename in ('employees', 'employee_login_employee_attempts',
                        'employee_login_device_failures', 'employee_login_device_throttles')
      and indexdef ilike '%pin%'
  ) then
    raise exception 'F1A.1: no index may be built on PIN material';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name in ('employees', 'employee_login_employee_attempts',
                         'employee_login_device_failures', 'employee_login_device_throttles')
      and column_name ilike '%pin%'
      and column_name <> 'pin_hash'
  ) then
    raise exception 'F1A.1: no new PIN-bearing column may exist';
  end if;

  -- ==========================================================================
  -- A13. With no caller, both till RPCs refuse before touching anything.
  -- ==========================================================================
  if (public.list_login_employees() ->> 'error') is distinct from 'not_authenticated' then
    raise exception 'F1A.1: list_login_employees must refuse an unauthenticated caller';
  end if;

  if (public.employee_login(null, null) ->> 'error') is distinct from 'not_authenticated' then
    raise exception 'F1A.1: employee_login must refuse an unauthenticated caller';
  end if;

  -- ==========================================================================
  -- B1. Employee and session HISTORY, and every pairing row, are untouched.
  -- ==========================================================================
  select * into v_row from f1a1_row_baseline;

  if (select count(*) from public.paired_devices) is distinct from v_row.devices
     or (select coalesce(md5(string_agg(md5(d::text), '|' order by d.id::text)), 'empty')
         from public.paired_devices d) is distinct from v_row.devices_fp then
    raise exception 'F1A.1: paired_devices changed';
  end if;

  if (select count(*) from public.employees) is distinct from v_row.employees
     or (select coalesce(md5(string_agg(md5(e::text), '|' order by e.id::text)), 'empty')
         from public.employees e) is distinct from v_row.employees_fp then
    raise exception 'F1A.1: employee history changed';
  end if;

  if (select count(*) from public.employee_pos_sessions) is distinct from v_row.sessions
     or (select coalesce(md5(string_agg(md5(s::text), '|' order by s.id::text)), 'empty')
         from public.employee_pos_sessions s) is distinct from v_row.sessions_fp then
    raise exception 'F1A.1: employee session history changed';
  end if;

  if (select md5(string_agg(table_name || '.' || column_name || ':' || data_type, ','
                            order by table_name, ordinal_position))
      from information_schema.columns
      where table_schema = 'public'
        and table_name in ('employees', 'employee_pos_sessions'))
     is distinct from v_row.history_columns then
    raise exception 'F1A.1: the employees or employee_pos_sessions columns changed';
  end if;

  -- ==========================================================================
  -- B2. No privilege moved on any operational, pairing or 1A table.
  -- ==========================================================================
  for v_row in select * from f1a1_priv_baseline
  loop
    if has_table_privilege(v_row.rolname, format('public.%I', v_row.tablename), v_row.priv)
       is distinct from v_row.held then
      raise exception 'F1A.1: privilege % on % for % changed',
        v_row.priv, v_row.tablename, v_row.rolname;
    end if;
  end loop;

  -- ==========================================================================
  -- B3. No policy was added, dropped or rewritten.
  -- ==========================================================================
  if exists (
    select 1
    from f1a1_pol_baseline b
    full outer join (
      select tablename, policyname, cmd, qual, with_check, roles::text as roles
      from pg_policies where schemaname = 'public'
    ) c
      on c.tablename = b.tablename and c.policyname = b.policyname
    where c.policyname is null
       or b.policyname is null
       or c.cmd is distinct from b.cmd
       or c.qual is distinct from b.qual
       or c.with_check is distinct from b.with_check
       or c.roles is distinct from b.roles
  ) then
    raise exception 'F1A.1: the set of public policies changed';
  end if;

  -- ==========================================================================
  -- B4. Every function this migration did not deliberately replace or drop is
  -- byte-identical: complete_sale*, resolve_sale_owner, every pairing RPC, and
  -- the untouched 1A functions alike.
  -- ==========================================================================
  for v_row in select * from f1a1_proc_baseline
  loop
    if not exists (select 1 from pg_proc p where p.oid = v_row.fn_oid) then
      raise exception 'F1A.1: pre-existing function %(%) was dropped', v_row.proname, v_row.args;
    end if;

    if (select md5(pg_get_functiondef(p.oid)) from pg_proc p where p.oid = v_row.fn_oid)
         is distinct from v_row.body
       or (select p.prosecdef from pg_proc p where p.oid = v_row.fn_oid)
         is distinct from v_row.prosecdef
       or (select coalesce(p.proconfig, array[]::text[]) from pg_proc p where p.oid = v_row.fn_oid)
         is distinct from v_row.config
       or (select coalesce(p.proacl::text, 'default') from pg_proc p where p.oid = v_row.fn_oid)
         is distinct from v_row.acl then
      raise exception 'F1A.1: pre-existing function %(%) changed', v_row.proname, v_row.args;
    end if;
  end loop;

  -- ==========================================================================
  -- B5. No trigger changed, and none was added.
  -- ==========================================================================
  for v_row in select * from f1a1_trg_baseline
  loop
    if not exists (
      select 1
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_proc pr on pr.oid = t.tgfoid
      where n.nspname = 'public'
        and not t.tgisinternal
        and c.relname = v_row.relname
        and t.tgname = v_row.tgname
        and t.tgtype = v_row.tgtype
        and t.tgenabled = v_row.tgenabled
        and pr.proname = v_row.proname
    ) then
      raise exception 'F1A.1: trigger %.% changed or was removed', v_row.relname, v_row.tgname;
    end if;
  end loop;

  select array_agg(tgname order by tgname) into v_new_triggers
  from (
    select t.tgname
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not t.tgisinternal
    except
    select b.tgname from f1a1_trg_baseline b
  ) s;

  if v_new_triggers is not null then
    raise exception 'F1A.1: unexpected new triggers: %', array_to_string(v_new_triggers, ', ');
  end if;

  raise notice 'F1A.1: employee selector and single-hash login verified.';
end
$do$;
