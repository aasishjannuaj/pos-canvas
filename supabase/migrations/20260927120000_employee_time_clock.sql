-- v1.3 Feature 1C — the Time Clock: what hours somebody worked.
--
-- THREE THINGS THAT LOOK ALIKE AND ARE NOT. An employee POS-session says who is
-- operating this till right now. A DAILY register says which business day this
-- device's money belongs to. A Time Clock session says when a person was at
-- work. They share an employee and nothing else, and the whole value of this
-- feature is that they stay apart: a cashier hands the till to a colleague and
-- keeps working; a cashier finishes their shift while the till stays open for
-- the next person. Couple any two of them and one of those ordinary days
-- becomes impossible to record truthfully.
--
-- So nothing here reads or writes employee_pos_sessions or register_sessions.
-- Clocking in does not unlock a POS. Ringing out does not end a shift.
--
-- WORK STATUS BELONGS TO THE BUSINESS, NOT TO A TILL. A shop has several
-- registers and people move between them: clock in at the stockroom till,
-- clock out at the front counter. So the open-session rule is scoped to
-- (project, employee), and the device is recorded on each action as audit
-- attribution rather than ownership. A device-scoped rule would let one person
-- hold an open session per till and double-count their own hours.
--
-- THE SERVER OWNS THE CLOCK. Neither function takes a timestamp. A till whose
-- clock is wrong -- or whose operator set it deliberately -- cannot change what
-- payroll sees, for the same reason CP2a refused to let a browser decide the
-- business date.
--
-- AND IT NEVER INVENTS A PUNCH. If an employee is deactivated while clocked in,
-- the session stays open with a null clock-out. Writing a time nobody stood
-- behind would be a payroll falsification, and blocking the deactivation would
-- hold a security control hostage to a timesheet. The row is left honestly
-- unresolved for a human to correct later, which Feature 1C deliberately does
-- not build.

-- ----------------------------------------------------------------------------
-- 1. The table.
-- ----------------------------------------------------------------------------
create table if not exists public.employee_time_sessions (
  id                         uuid primary key default gen_random_uuid(),
  project_id                 uuid not null references public.projects(id) on delete cascade,
  employee_id                uuid not null references public.employees(id),
  clocked_in_at              timestamptz not null,
  clocked_out_at             timestamptz,
  clock_in_paired_device_id  uuid not null references public.paired_devices(id),
  clock_out_paired_device_id uuid references public.paired_devices(id),
  clock_in_request_id        uuid not null,
  clock_out_request_id       uuid,

  -- A shift cannot end before it began. Equality is allowed: a clock-in and an
  -- immediate correction-free clock-out in the same instant is odd but honest.
  constraint employee_time_sessions_interval_check
    check (clocked_out_at is null or clocked_out_at >= clocked_in_at),

  -- The two closing columns move together or not at all. A row with a
  -- clock-out time but no device, or vice versa, would be a record nobody
  -- could explain.
  constraint employee_time_sessions_closed_together_check
    check (
      (clocked_out_at is null and clock_out_paired_device_id is null and clock_out_request_id is null)
      or
      (clocked_out_at is not null and clock_out_paired_device_id is not null and clock_out_request_id is not null)
    )
);

comment on table public.employee_time_sessions is
  'v1.3 Feature 1C -- when an employee was at work. Independent of '
  'employee_pos_sessions (who operates a till) and register_sessions (which '
  'business day a device''s money belongs to). Open means clocked_out_at is '
  'null. Timestamps are the SERVER''s; no client may supply one. Scoped to the '
  'business, so a shift opened at one till closes at another; the device '
  'columns are audit attribution only.';

-- ----------------------------------------------------------------------------
-- 2. The invariants, enforced by the database rather than by hope.
-- ----------------------------------------------------------------------------

-- AT MOST ONE OPEN SHIFT PER PERSON PER BUSINESS. This is the backstop behind
-- the employee row lock in the functions: even if two requests somehow reached
-- the insert together, only one can land.
create unique index if not exists employee_time_sessions_one_open_per_employee
  on public.employee_time_sessions (project_id, employee_id)
  where clocked_out_at is null;

-- REPLAY KEYS, SCOPED TO THE BUSINESS. A request id is only ever looked up
-- alongside its project, so one business's retry can never resolve to another's
-- row -- and a caller cannot probe for a request id it does not own.
create unique index if not exists employee_time_sessions_clock_in_request
  on public.employee_time_sessions (project_id, clock_in_request_id);

create unique index if not exists employee_time_sessions_clock_out_request
  on public.employee_time_sessions (project_id, clock_out_request_id)
  where clock_out_request_id is not null;

-- Reporting will ask "who is clocked in" and "what did this person work"; both
-- read this way round. Not unique: a person has many past shifts.
create index if not exists employee_time_sessions_employee_started_idx
  on public.employee_time_sessions (employee_id, clocked_in_at desc);

-- ----------------------------------------------------------------------------
-- 3. No client touches this table directly.
-- ----------------------------------------------------------------------------
alter table public.employee_time_sessions enable row level security;

revoke all on table public.employee_time_sessions from public;
revoke all on table public.employee_time_sessions from anon;
revoke all on table public.employee_time_sessions from authenticated;
revoke all on table public.employee_time_sessions from service_role;

-- ----------------------------------------------------------------------------
-- 4. Clock In.
-- ----------------------------------------------------------------------------
create or replace function public.clock_in_employee(
  p_employee_code text,
  p_pin text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $function$
declare
  -- One answer for every credential problem, exactly as employee_login_by_code
  -- does it: an unknown Employee ID, a wrong PIN and a deactivated employee are
  -- indistinguishable from outside.
  v_generic_failure constant jsonb :=
    jsonb_build_object('ok', false, 'error', 'invalid_credentials');
  v_dummy_hash constant text :=
    '$2a$10$Qw5T.qSV4YJ11CVkf2oUruuburfRGbD4bIoXiMvaWpYs4p6MIwzSG';
  v_caller          uuid;
  v_device          record;
  v_now             timestamptz;
  v_throttled_until timestamptz;
  v_employee        record;
  v_locked_until    timestamptz;
  v_existing        record;
  v_open            record;
  v_session_id      uuid;
  v_started_at      timestamptz;
begin
  v_caller := auth.uid();

  if v_caller is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  if p_request_id is null
     or p_request_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return jsonb_build_object('ok', false, 'error', 'request_required');
  end if;

  -- LOCK ORDER, step 1: the paired device, FOR SHARE. Shared rather than
  -- exclusive because nothing here changes the device, and a punch must not
  -- block a sale on a busy till.
  select d.id, d.project_id
    into v_device
  from public.paired_devices d
  where d.auth_user_id = v_caller
    and d.revoked_at is null
    and d.unpaired_at is null
  for share;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_paired');
  end if;

  v_now := clock_timestamp();

  -- The device cooldown is checked BEFORE anything is looked up, so a
  -- throttled till cannot be used to probe for Employee IDs at all.
  select t.throttled_until
    into v_throttled_until
  from public.employee_login_device_throttles t
  where t.paired_device_id = v_device.id;

  if v_throttled_until is not null and v_throttled_until > v_now then
    return jsonb_build_object(
      'ok', false,
      'error', 'locked_out',
      'retryAfterSeconds', ceil(extract(epoch from (v_throttled_until - v_now)))::integer
    );
  end if;

  -- A malformed code spends a bcrypt anyway, so timing does not separate
  -- "badly typed" from "does not exist".
  if p_employee_code is null or p_employee_code !~ '^[0-9]{3}$' or p_employee_code = '000' then
    perform public.employee_pin_verify(coalesce(p_pin, '0000'), v_dummy_hash);
    perform public.employee_login_record_device_failure(v_device.id, v_now);
    return v_generic_failure;
  end if;

  -- THE PROJECT COMES FROM THE DEVICE, NEVER THE CLIENT. `001` at one business
  -- and `001` at another are different people.
  select e.id, e.pin_hash
    into v_employee
  from public.employees e
  where e.project_id = v_device.project_id
    and e.employee_code = p_employee_code
    and e.active;

  if not found then
    perform public.employee_pin_verify(coalesce(p_pin, '0000'), v_dummy_hash);
    perform public.employee_login_record_device_failure(v_device.id, v_now);
    return v_generic_failure;
  end if;

  select a.locked_until
    into v_locked_until
  from public.employee_login_employee_attempts a
  where a.paired_device_id = v_device.id
    and a.employee_id = v_employee.id;

  if v_locked_until is not null and v_locked_until > v_now then
    return jsonb_build_object(
      'ok', false,
      'error', 'locked_out',
      'retryAfterSeconds', ceil(extract(epoch from (v_locked_until - v_now)))::integer
    );
  end if;

  if p_pin is null or p_pin !~ '^[0-9]{4}$' then
    perform public.employee_pin_verify('0000', v_dummy_hash);
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

  -- ==========================================================================
  -- LOCK ORDER, step 4: the employee row, FOR UPDATE.
  --
  -- Taken AFTER the bcrypt, deliberately: holding a row lock across a password
  -- hash would let one slow verification stall this person's every other
  -- action. From here it serialises Clock In against Clock In, against Clock
  -- Out, and against set_employee_active's UPDATE.
  -- ==========================================================================
  select e.id, e.active, e.project_id
    into v_employee
  from public.employees e
  where e.id = v_employee.id
  for update;

  -- REVALIDATED UNDER THE LOCK. A deactivation that committed while the bcrypt
  -- ran is visible now, and wins.
  if not found or not v_employee.active or v_employee.project_id is distinct from v_device.project_id then
    return v_generic_failure;
  end if;

  -- A retry whose first reply was lost gets its ORIGINAL answer, not a second
  -- shift.
  --
  -- OWNERSHIP IS PART OF THE REPLAY, NOT AN AFTERTHOUGHT. A request id is
  -- unique per business, so it identifies a row -- but it says nothing about
  -- WHOSE row. Matching on the id alone would hand the next employee to
  -- authenticate somebody else's session id and punch times as their own
  -- success, simply for presenting a uuid they happened to have. So the row
  -- must also belong to the employee who just proved who they are; anything
  -- else is a conflict that changes nothing and reveals nothing.
  select s.id, s.employee_id, s.clocked_in_at
    into v_existing
  from public.employee_time_sessions s
  where s.project_id = v_device.project_id
    and s.clock_in_request_id = p_request_id;

  if found then
    if v_existing.employee_id is distinct from v_employee.id then
      return jsonb_build_object('ok', false, 'error', 'request_conflict');
    end if;

    return jsonb_build_object(
      'ok', true,
      'outcome', 'clocked_in',
      'timeSessionId', v_existing.id,
      'clockedInAt', v_existing.clocked_in_at,
      'replayed', true
    );
  end if;

  select s.id, s.clocked_in_at
    into v_open
  from public.employee_time_sessions s
  where s.project_id = v_device.project_id
    and s.employee_id = v_employee.id
    and s.clocked_out_at is null;

  if found then
    return jsonb_build_object(
      'ok', false,
      'error', 'already_clocked_in',
      'timeSessionId', v_open.id,
      'clockedInAt', v_open.clocked_in_at
    );
  end if;

  -- THE SERVER'S CLOCK, and there is no argument through which a device could
  -- offer its own.
  v_started_at := clock_timestamp();

  -- THE INDEXES ARE THE LAST WORD. The employee row lock serialises the
  -- ordinary case, but a request that arrived against a different employee row
  -- -- somebody else's id, replayed -- never took this lock at all. Catching
  -- the violation re-resolves it rather than letting a raw constraint error
  -- reach a till.
  begin
    insert into public.employee_time_sessions (
      project_id, employee_id, clocked_in_at, clock_in_paired_device_id, clock_in_request_id
    )
    values (
      v_device.project_id, v_employee.id, v_started_at, v_device.id, p_request_id
    )
    returning id into v_session_id;
  exception
    when unique_violation then
      select s.id, s.employee_id, s.clocked_in_at
        into v_existing
      from public.employee_time_sessions s
      where s.project_id = v_device.project_id
        and s.clock_in_request_id = p_request_id;

      if found then
        if v_existing.employee_id is distinct from v_employee.id then
          return jsonb_build_object('ok', false, 'error', 'request_conflict');
        end if;

        return jsonb_build_object(
          'ok', true,
          'outcome', 'clocked_in',
          'timeSessionId', v_existing.id,
          'clockedInAt', v_existing.clocked_in_at,
          'replayed', true
        );
      end if;

      -- The other index, then: this employee already has an open shift.
      return jsonb_build_object('ok', false, 'error', 'already_clocked_in');
  end;

  return jsonb_build_object(
    'ok', true,
    'outcome', 'clocked_in',
    'timeSessionId', v_session_id,
    'clockedInAt', v_started_at,
    'replayed', false
  );
end;
$function$;

comment on function public.clock_in_employee(text, text, uuid) is
  'v1.3 Feature 1C -- opens a business-level Time Clock session for an active '
  'employee who presents their Employee ID and PIN. Touches no POS session and '
  'no register. clocked_in_at is the SERVER''s clock. Idempotent per '
  '(project, request id).';

-- ----------------------------------------------------------------------------
-- 5. Clock Out.
-- ----------------------------------------------------------------------------
create or replace function public.clock_out_employee(
  p_employee_code text,
  p_pin text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $function$
declare
  v_generic_failure constant jsonb :=
    jsonb_build_object('ok', false, 'error', 'invalid_credentials');
  v_dummy_hash constant text :=
    '$2a$10$Qw5T.qSV4YJ11CVkf2oUruuburfRGbD4bIoXiMvaWpYs4p6MIwzSG';
  v_caller          uuid;
  v_device          record;
  v_now             timestamptz;
  v_throttled_until timestamptz;
  v_employee        record;
  v_locked_until    timestamptz;
  v_existing        record;
  v_open            record;
  v_ended_at        timestamptz;
begin
  v_caller := auth.uid();

  if v_caller is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  if p_request_id is null
     or p_request_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return jsonb_build_object('ok', false, 'error', 'request_required');
  end if;

  select d.id, d.project_id
    into v_device
  from public.paired_devices d
  where d.auth_user_id = v_caller
    and d.revoked_at is null
    and d.unpaired_at is null
  for share;

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
      'retryAfterSeconds', ceil(extract(epoch from (v_throttled_until - v_now)))::integer
    );
  end if;

  if p_employee_code is null or p_employee_code !~ '^[0-9]{3}$' or p_employee_code = '000' then
    perform public.employee_pin_verify(coalesce(p_pin, '0000'), v_dummy_hash);
    perform public.employee_login_record_device_failure(v_device.id, v_now);
    return v_generic_failure;
  end if;

  select e.id, e.pin_hash
    into v_employee
  from public.employees e
  where e.project_id = v_device.project_id
    and e.employee_code = p_employee_code
    and e.active;

  if not found then
    perform public.employee_pin_verify(coalesce(p_pin, '0000'), v_dummy_hash);
    perform public.employee_login_record_device_failure(v_device.id, v_now);
    return v_generic_failure;
  end if;

  select a.locked_until
    into v_locked_until
  from public.employee_login_employee_attempts a
  where a.paired_device_id = v_device.id
    and a.employee_id = v_employee.id;

  if v_locked_until is not null and v_locked_until > v_now then
    return jsonb_build_object(
      'ok', false,
      'error', 'locked_out',
      'retryAfterSeconds', ceil(extract(epoch from (v_locked_until - v_now)))::integer
    );
  end if;

  if p_pin is null or p_pin !~ '^[0-9]{4}$' then
    perform public.employee_pin_verify('0000', v_dummy_hash);
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

  select e.id, e.active, e.project_id
    into v_employee
  from public.employees e
  where e.id = v_employee.id
  for update;

  if not found or not v_employee.active or v_employee.project_id is distinct from v_device.project_id then
    return v_generic_failure;
  end if;

  -- A replayed close returns the ORIGINAL close. It must never re-stamp
  -- clocked_out_at: the second answer would move somebody's recorded hours.
  --
  -- AND IT MUST BE THIS EMPLOYEE'S CLOSE. The request id identifies a row
  -- within the business; it does not prove whose. Without the ownership check
  -- the next person to authenticate could present somebody else's uuid and be
  -- handed their shift times as a successful clock-out of their own.
  select s.id, s.employee_id, s.clocked_in_at, s.clocked_out_at
    into v_existing
  from public.employee_time_sessions s
  where s.project_id = v_device.project_id
    and s.clock_out_request_id = p_request_id;

  if found then
    if v_existing.employee_id is distinct from v_employee.id then
      return jsonb_build_object('ok', false, 'error', 'request_conflict');
    end if;

    return jsonb_build_object(
      'ok', true,
      'outcome', 'clocked_out',
      'timeSessionId', v_existing.id,
      'clockedInAt', v_existing.clocked_in_at,
      'clockedOutAt', v_existing.clocked_out_at,
      'replayed', true
    );
  end if;

  -- THE BUSINESS'S OPEN SHIFT, NOT THIS TILL'S. A shift opened at another
  -- register of the same shop closes here; another business's never appears,
  -- because project_id comes from this caller's own pairing.
  select s.id, s.clocked_in_at
    into v_open
  from public.employee_time_sessions s
  where s.project_id = v_device.project_id
    and s.employee_id = v_employee.id
    and s.clocked_out_at is null;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_clocked_in');
  end if;

  v_ended_at := clock_timestamp();

  -- Same last word as the insert: a request id already spent by another
  -- employee's close must not become this one's, even in a race.
  begin
    update public.employee_time_sessions s
    set clocked_out_at             = v_ended_at,
        clock_out_paired_device_id = v_device.id,
        clock_out_request_id       = p_request_id
    where s.id = v_open.id
      and s.clocked_out_at is null;
  exception
    when unique_violation then
      return jsonb_build_object('ok', false, 'error', 'request_conflict');
  end;

  return jsonb_build_object(
    'ok', true,
    'outcome', 'clocked_out',
    'timeSessionId', v_open.id,
    'clockedInAt', v_open.clocked_in_at,
    'clockedOutAt', v_ended_at,
    'replayed', false
  );
end;
$function$;

comment on function public.clock_out_employee(text, text, uuid) is
  'v1.3 Feature 1C -- closes the caller''s business open Time Clock session, '
  'whichever till opened it. Touches no POS session and no register. '
  'clocked_out_at is the SERVER''s clock. A replayed request returns the '
  'original close and never re-stamps it.';

-- ----------------------------------------------------------------------------
-- 6. Privileges. Supabase grants EXECUTE on new functions by default, so every
--    grant here is written revoke-then-grant, matching CP2b, CP2c and CP3.1.
-- ----------------------------------------------------------------------------
revoke all on function public.clock_in_employee(text, text, uuid) from public;
revoke all on function public.clock_in_employee(text, text, uuid) from anon;
revoke all on function public.clock_in_employee(text, text, uuid) from service_role;
grant execute on function public.clock_in_employee(text, text, uuid) to authenticated;

revoke all on function public.clock_out_employee(text, text, uuid) from public;
revoke all on function public.clock_out_employee(text, text, uuid) from anon;
revoke all on function public.clock_out_employee(text, text, uuid) from service_role;
grant execute on function public.clock_out_employee(text, text, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 7. Verify what this migration claims, against the live catalog.
-- ----------------------------------------------------------------------------
do $do$
declare
  v_in  oid;
  v_out oid;
begin
  select p.oid into v_in from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'clock_in_employee';
  select p.oid into v_out from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'clock_out_employee';

  if v_in is null or v_out is null then
    raise exception '1C: a Time Clock function was not created.';
  end if;

  -- NO TIMESTAMP ARGUMENT, EITHER SIDE. This is the rule that keeps a tampered
  -- device clock out of payroll, so it is asserted rather than assumed.
  if pg_get_function_identity_arguments(v_in)
       <> 'p_employee_code text, p_pin text, p_request_id uuid'
     or pg_get_function_identity_arguments(v_out)
       <> 'p_employee_code text, p_pin text, p_request_id uuid' then
    raise exception '1C: a Time Clock function accepts an unexpected argument.';
  end if;

  -- Said twice, on purpose: the exact-signature check above would also fail for
  -- a harmless rename, so this states the rule that actually matters.
  if pg_get_function_identity_arguments(v_in) ~* 'timestamp'
     or pg_get_function_identity_arguments(v_out) ~* 'timestamp' then
    raise exception '1C: a Time Clock function accepts a client timestamp.';
  end if;

  if not (select p.prosecdef from pg_proc p where p.oid = v_in)
     or not (select p.prosecdef from pg_proc p where p.oid = v_out) then
    raise exception '1C: Time Clock functions must be SECURITY DEFINER.';
  end if;

  if not exists (select 1 from pg_proc p where p.oid = v_in
                  and p.proconfig @> array['search_path=public, pg_catalog, pg_temp'])
     or not exists (select 1 from pg_proc p where p.oid = v_out
                  and p.proconfig @> array['search_path=public, pg_catalog, pg_temp']) then
    raise exception '1C: a Time Clock function has no pinned search_path.';
  end if;

  -- Effective privileges, not a proacl substring.
  if has_function_privilege('anon', v_in, 'EXECUTE')
     or has_function_privilege('anon', v_out, 'EXECUTE')
     or has_function_privilege('service_role', v_in, 'EXECUTE')
     or has_function_privilege('service_role', v_out, 'EXECUTE') then
    raise exception '1C: a Time Clock function is executable by anon or service_role.';
  end if;

  if not has_function_privilege('authenticated', v_in, 'EXECUTE')
     or not has_function_privilege('authenticated', v_out, 'EXECUTE') then
    raise exception '1C: authenticated must execute both Time Clock functions.';
  end if;

  -- The table is reachable only through those functions.
  if has_table_privilege('authenticated', 'public.employee_time_sessions', 'SELECT')
     or has_table_privilege('authenticated', 'public.employee_time_sessions', 'INSERT')
     or has_table_privilege('authenticated', 'public.employee_time_sessions', 'UPDATE')
     or has_table_privilege('authenticated', 'public.employee_time_sessions', 'DELETE')
     or has_table_privilege('anon', 'public.employee_time_sessions', 'SELECT')
     or has_table_privilege('service_role', 'public.employee_time_sessions', 'UPDATE') then
    raise exception '1C: employee_time_sessions is directly reachable by a client role.';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.employee_time_sessions'::regclass) then
    raise exception '1C: employee_time_sessions must have RLS enabled.';
  end if;

  if (select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'employee_time_sessions') <> 0 then
    raise exception '1C: employee_time_sessions must have no policies.';
  end if;

  if not exists (select 1 from pg_indexes where schemaname = 'public'
                  and indexname = 'employee_time_sessions_one_open_per_employee') then
    raise exception '1C: the one-open-session-per-employee index is missing.';
  end if;

  -- NOTHING IN FEATURE 1B MOVED. The Time Clock is a new table and two new
  -- functions; if either existing contract changed, this migration did more
  -- than it claims.
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in
         ('complete_sale_v5', 'employee_login_by_code', 'end_employee_pos_session',
          'ensure_daily_register_context')) <> 4 then
    raise exception '1C: an accepted Feature 1B function is missing.';
  end if;

  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'complete_sale_v5'
         and p.prosrc ~ 'employee_time_sessions') <> 0 then
    raise exception '1C: complete_sale_v5 was made aware of the Time Clock.';
  end if;

  -- THE REPLAY OWNERSHIP RULE, asserted rather than trusted to review: both
  -- functions must compare the replayed row's employee against the caller.
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('clock_in_employee', 'clock_out_employee')
         and p.prosrc ~ 'v_existing\.employee_id is distinct from v_employee\.id') <> 2 then
    raise exception '1C: a Time Clock replay does not prove row ownership.';
  end if;

  raise notice '1C verified: employee_time_sessions plus two Time Clock functions, and nothing else moved.';
end;
$do$;
