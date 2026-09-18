-- v1.3 Feature 1B-RUNTIME revision, checkpoint 1 — Employee ID + 4-digit PIN.
--
-- WHAT THIS CHANGES, IN ONE LINE: a cashier signs in by typing a three-digit
-- Employee ID and a four-digit PIN, instead of picking their name from a roster.
--
-- WHY A NEW MIGRATION RATHER THAN AN EDIT. 20260914120000, 20260916120000,
-- 20260916130000 and 20260917120000 are applied and accepted. Nothing here
-- touches them; every function this file changes is re-created with
-- `create or replace`, which is exactly how 20260916120000 re-contracted
-- employee_login before it. That precedent is the whole reason this is safe.
--
-- THE UUID IS STILL THE IDENTITY. employee_code is a LOOKUP KEY, scoped to one
-- project, reusable after an employee leaves. employees.id remains the primary
-- key, the FK target for sessions and orders, and the thing sale attribution is
-- written against. Nothing in this file lets a code reach a sale.
--
--   Employee ID  identifies   -- three digits, typed, reusable, per project
--   PIN          authenticates -- four digits, bcrypt, never stored in clear
--
-- WHY employee_code IS text AND NOT AN INTEGER. The user-facing contract is
-- that `001` displays as `001`. An integer column cannot hold that: it would
-- store 1, and every read path would have to remember to pad it back. One place
-- forgetting is a cashier told their ID is `1` when their card says `001`.
--
-- ACTIVE-ONLY UNIQUENESS, ENFORCED BY THE DATABASE. A partial unique index --
-- not an RPC pre-check -- because two owners assigning `101` in the same second
-- is a real race, and only the index can lose it safely. An employee who leaves
-- KEEPS their historical code so old sessions still read sensibly, and that
-- retained code does not reserve the number: the next hire may have `101`.
--
-- AND SO REACTIVATION CAN FAIL. If `101` was reissued while someone was
-- inactive, bringing them back must refuse rather than renumber anybody. That
-- refusal is a catalogued business error, not a raw 23505 leaking out.

-- ----------------------------------------------------------------------------
-- 1. The column, the backfill, and the rules -- in that order, deliberately.
--
-- The constraints are added AFTER the backfill because a table with existing
-- active employees cannot satisfy "every active employee has a code" until they
-- have one. All of it is one transaction: if the 999 guard below fires, the
-- column is never added.
-- ----------------------------------------------------------------------------
alter table public.employees
  add column if not exists employee_code text;

-- 999 ACTIVE EMPLOYEES IS THE NAMESPACE, AND IT IS A HARD STOP.
--
-- Three digits, minus `000`, is 999 codes. A project with more active employees
-- than that cannot be numbered, and the only honest response is to refuse the
-- whole migration. Silently widening to four digits, wrapping, or truncating
-- would each produce a live till where two people share an Employee ID.
--
-- INACTIVE EMPLOYEES DO NOT COUNT. They keep a historical code but hold no
-- reservation, so a project with 5,000 leavers and 40 staff is fine.
do $do$
declare
  v_project uuid;
  v_count integer;
begin
  select e.project_id, count(*)
  into v_project, v_count
  from public.employees e
  where e.active
  group by e.project_id
  having count(*) > 999
  order by count(*) desc
  limit 1;

  if found then
    raise exception
      'Project % has % active employees; the three-digit Employee ID namespace holds 999.',
      v_project, v_count
      using errcode = 'check_violation';
  end if;
end;
$do$;

-- DETERMINISTIC BACKFILL: created_at, then id.
--
-- created_at is the order people actually joined, which is the order a business
-- would number them in. It is not unique -- a scripted import can give a whole
-- team the same timestamp -- so `id` is the tie-breaker, and between them the
-- result is total and reproducible. Ordering by display_name or role would
-- renumber everyone the next time somebody is renamed or promoted.
--
-- ACTIVE ONLY. An inactive employee is given nothing, so it cannot occupy a
-- number that a working cashier needs.
update public.employees e
set employee_code = numbered.code
from (
  select
    e2.id,
    lpad(
      row_number() over (
        partition by e2.project_id
        order by e2.created_at asc, e2.id asc
      )::text,
      3,
      '0'
    ) as code
  from public.employees e2
  where e2.active
) as numbered
where e.id = numbered.id
  and e.employee_code is null;

-- The shape. `000` is excluded because it reads as "no employee" on a keypad
-- and is the single most likely accidental entry.
alter table public.employees
  drop constraint if exists employees_employee_code_shape_check;

alter table public.employees
  add constraint employees_employee_code_shape_check
  check (
    employee_code is null
    or (employee_code ~ '^[0-9]{3}$' and employee_code <> '000')
  );

-- An ACTIVE employee must be reachable by the thing a cashier types. An
-- inactive one may legitimately have none: every employee who existed before
-- this migration and had already left is in exactly that state.
alter table public.employees
  drop constraint if exists employees_active_requires_code_check;

alter table public.employees
  add constraint employees_active_requires_code_check
  check (not active or employee_code is not null);

-- THE RACE-SAFE PART. Partial, so leavers' retained codes are simply not in the
-- index and cannot collide with anyone.
create unique index if not exists employees_active_project_code_key
  on public.employees (project_id, employee_code)
  where active;

-- ----------------------------------------------------------------------------
-- 2. The PIN is now EXACTLY four digits, everywhere.
--
-- 4-6 was the old contract and it is gone, with no compatibility branch: a
-- range means two tills in the same shop disagree about how many boxes to draw.
-- Existing bcrypt hashes are NOT touched -- a hash does not record its input
-- length, and rehashing would require the plaintext nobody has. What changes is
-- what may be SET and what may be SUBMITTED from here.
-- ----------------------------------------------------------------------------
-- DISCOVERED, NOT HARDCODED -- exactly as 20260914120000 built it.
--
-- Supabase installs pgcrypto into `extensions`, but that is a deployment
-- detail, not a guarantee: outside Supabase it can legitimately land in
-- `public`. The original refused to guess, and so does this. Hardcoding
-- `extensions.crypt` here would have worked on staging and failed on somebody
-- else's database, which is the worst possible place to learn it.
--
-- The rebuilt body differs from the original in ONE character class:
-- '^[0-9]{4,6}$' becomes '^[0-9]{4}$'. search_path, security, cost factor and
-- the fully-qualified call are reproduced unchanged.
do $do$
declare
  v_schema text;
begin
  select n.nspname into v_schema
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pgcrypto';

  if v_schema is null then
    raise exception
      'Employee PIN hashing requires the pgcrypto extension; it is not installed';
  end if;

  if to_regprocedure(format('%I.crypt(text, text)', v_schema)) is null then
    raise exception
      'pgcrypto is installed in schema %, but crypt(text, text) is not present there', v_schema;
  end if;

  if to_regprocedure(format('%I.gen_salt(text, integer)', v_schema)) is null then
    raise exception
      'pgcrypto is installed in schema %, but gen_salt(text, integer) is not present there', v_schema;
  end if;

  -- Cost factor 10, unchanged. It is the per-guess floor that makes a four
  -- digit PIN space impractical to walk, and the device backoff bounds how much
  -- of that work an attacker can force.
  execute format($ddl$
create or replace function public.employee_pin_hash(p_pin text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then
    raise exception 'A 4 digit numeric PIN is required';
  end if;

  return %I.crypt(p_pin, %I.gen_salt('bf', 10));
end;
$fn$;
$ddl$, v_schema, v_schema);
end;
$do$;

revoke all on function public.employee_pin_hash(text) from public;
revoke all on function public.employee_pin_hash(text) from anon;
revoke all on function public.employee_pin_hash(text) from service_role;

-- ----------------------------------------------------------------------------
-- 3. THE NEW PRIMARY LOGIN: Employee ID + PIN.
--
-- The client sends two things a person typed. It sends no project, no employee
-- UUID and no device id, because it is not the authority on any of them: the
-- server reads auth.uid(), finds the paired device, takes the project from that
-- device's pairing row, and only then looks a code up INSIDE that project. A
-- till cannot log somebody into a business it is not paired to.
--
-- WHY THE DUMMY VERIFY MATTERS. The older employee_login returns immediately
-- when the employee row is missing, so an unknown UUID answers measurably
-- faster than a wrong PIN. A UUID is unguessable, so that leaked little. A
-- three-digit code is guessable in 999 tries, and the same shortcut would turn
-- "which IDs exist here" into a timing measurement. So an unresolved code burns
-- one bcrypt verification against a fixed hash before returning the same
-- generic failure. It equalises the dominant cost; it is not a constant-time
-- guarantee, and it is not claimed as one.
--
-- THE DEVICE LIMITER STILL COUNTS UNKNOWN CODES. That is what actually bounds
-- enumeration: 999 codes are cheap to try, and only the per-device throttle
-- makes trying them expensive.
create or replace function public.employee_login_by_code(p_employee_code text, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  -- One failure surface for every credential problem. An unknown Employee ID
  -- and a wrong PIN are indistinguishable to the caller, by construction.
  v_generic_failure constant jsonb :=
    jsonb_build_object('ok', false, 'error', 'invalid_credentials');
  -- A real bcrypt hash of a value nobody is told, used only to spend time.
  v_dummy_hash constant text :=
    '$2a$10$Qw5T.qSV4YJ11CVkf2oUruuburfRGbD4bIoXiMvaWpYs4p6MIwzSG';
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

  -- FOR UPDATE serialises concurrent logins on one till, exactly as
  -- employee_login does, so two presses cannot both open a session.
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

  -- The device-wide cooldown is checked BEFORE anything is looked up, so a
  -- throttled till cannot be used to probe for codes at all.
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

  -- A malformed code is a credential failure like any other. It is NOT told
  -- apart from a well-formed one that happens not to exist.
  if p_employee_code is null or p_employee_code !~ '^[0-9]{3}$' or p_employee_code = '000' then
    perform public.employee_pin_verify(coalesce(p_pin, '0000'), v_dummy_hash);
    perform public.employee_login_record_device_failure(v_device.id, v_now);
    return v_generic_failure;
  end if;

  -- THE PROJECT COMES FROM THE DEVICE, NEVER THE CLIENT. `001` at one business
  -- and `001` at another are different people, and this join is what keeps them
  -- that way.
  select e.id, e.display_name, e.role, e.pin_hash
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

  -- The per-employee lockout is keyed to the DURABLE UUID, not to the code. A
  -- reissued code must not inherit the previous holder's failure history, and a
  -- renumbered employee must not shed their own.
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

  delete from public.employee_login_device_throttles t
  where t.paired_device_id = v_device.id
    and t.throttled_until <= v_now
    and not exists (
      select 1
      from public.employee_login_device_failures f
      where f.paired_device_id = v_device.id
        and f.failed_at >= v_now - interval '300 seconds'
    );

  -- Signing in ends whoever was on this till. The register is NOT touched:
  -- employee sessions and drawer periods are independent lifecycles, and one
  -- open register spans many operators.
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

revoke all on function public.employee_login_by_code(text, text) from public;
revoke all on function public.employee_login_by_code(text, text) from anon;
revoke all on function public.employee_login_by_code(text, text) from service_role;
grant execute on function public.employee_login_by_code(text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 4. employee_login(uuid, text) -- kept, PIN tightened to four.
--
-- The roster/selector path stays for secondary and administrative use, so it is
-- not dropped. What it may accept converges with everything else: one PIN
-- contract, no second opinion about what a valid PIN is.
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

  -- CHANGED BY THIS MIGRATION: exactly four, was '^[0-9]{4,6}$'.
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then
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
-- 5. create_employee -- now requires an Employee ID.
--
-- A NEW SIGNATURE, AND THE OLD ONE IS DROPPED. Keeping the four-argument form
-- would leave a way to create an active employee with no code, which the new
-- check constraint forbids: the call would fail with a raw constraint error
-- instead of a catalogued one. No TypeScript calls it -- lib/employee.rpc.ts
-- says so explicitly -- so there is no client to migrate.
-- ----------------------------------------------------------------------------
drop function if exists public.create_employee(uuid, text, text, text);

create or replace function public.create_employee(
  p_project_id uuid,
  p_display_name text,
  p_role text,
  p_employee_code text,
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

  if p_employee_code is null or p_employee_code !~ '^[0-9]{3}$' or p_employee_code = '000' then
    return jsonb_build_object('ok', false, 'error', 'invalid_employee_code');
  end if;

  if p_pin is null or p_pin !~ '^[0-9]{4}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_pin');
  end if;

  -- The index is the authority; this is the catalogued answer for the caller.
  -- Between the two, a race that loses the insert still returns
  -- employee_code_taken rather than a 23505.
  begin
    insert into public.employees (project_id, display_name, role, employee_code, pin_hash)
    values (
      p_project_id,
      btrim(p_display_name),
      p_role,
      p_employee_code,
      public.employee_pin_hash(p_pin)
    )
    returning id, display_name, role, employee_code, active, created_at into v_employee;
  exception
    when unique_violation then
      return jsonb_build_object('ok', false, 'error', 'employee_code_taken');
  end;

  return jsonb_build_object(
    'ok', true,
    'employeeId', v_employee.id,
    'displayName', v_employee.display_name,
    'role', v_employee.role,
    'employeeCode', v_employee.employee_code,
    'active', v_employee.active,
    'createdAt', v_employee.created_at
  );
end;
$function$;

revoke all on function public.create_employee(uuid, text, text, text, text) from public;
revoke all on function public.create_employee(uuid, text, text, text, text) from anon;
revoke all on function public.create_employee(uuid, text, text, text, text) from service_role;
grant execute on function public.create_employee(uuid, text, text, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 6. set_employee_code -- reassigning an Employee ID.
--
-- CHANGES THE CODE AND NOTHING ELSE. The UUID is untouched, so every past
-- session, every order and every audit row still points at the same person. An
-- Employee ID is a label on a person, not the person.
-- ----------------------------------------------------------------------------
create or replace function public.set_employee_code(
  p_employee_id uuid,
  p_employee_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller uuid;
  v_employee record;
  v_updated record;
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

  -- The join to projects is the authorization: an employee of a project the
  -- caller does not own is indistinguishable from one that does not exist.
  select e.id, e.project_id
  into v_employee
  from public.employees e
  join public.projects p on p.id = e.project_id
  where e.id = p_employee_id
    and p.user_id = v_caller;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if p_employee_code is null or p_employee_code !~ '^[0-9]{3}$' or p_employee_code = '000' then
    return jsonb_build_object('ok', false, 'error', 'invalid_employee_code');
  end if;

  begin
    update public.employees e
    set employee_code = p_employee_code
    where e.id = v_employee.id
    returning e.id, e.display_name, e.role, e.employee_code, e.active into v_updated;
  exception
    when unique_violation then
      return jsonb_build_object('ok', false, 'error', 'employee_code_taken');
  end;

  return jsonb_build_object(
    'ok', true,
    'employeeId', v_updated.id,
    'displayName', v_updated.display_name,
    'role', v_updated.role,
    'employeeCode', v_updated.employee_code,
    'active', v_updated.active
  );
end;
$function$;

revoke all on function public.set_employee_code(uuid, text) from public;
revoke all on function public.set_employee_code(uuid, text) from anon;
revoke all on function public.set_employee_code(uuid, text) from service_role;
grant execute on function public.set_employee_code(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 7. set_employee_pin -- exactly four digits.
-- ----------------------------------------------------------------------------
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

  -- CHANGED BY THIS MIGRATION: exactly four, was '^[0-9]{4,6}$'.
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then
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
-- 8. set_employee_active -- reactivation can now fail, and must.
--
-- THE CASE THIS EXISTS FOR: Ada leaves holding `101`. She keeps it, because her
-- old sessions should still read sensibly. Bo is hired and given `101`, which
-- is allowed -- a leaver holds no reservation. Ada comes back. There is now no
-- correct silent answer: renumbering Ada picks a number nobody chose,
-- renumbering Bo changes a working cashier's ID mid-shift, and allowing both is
-- two people with one Employee ID on the same till.
--
-- So it refuses, with a catalogued error, and a human picks the new number.
--
-- Deactivation never fails: leaving always works, and the retained code drops
-- out of the partial index on its way out.
-- ----------------------------------------------------------------------------
create or replace function public.set_employee_active(
  p_employee_id uuid,
  p_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller uuid;
  v_employee record;
  v_updated record;
begin
  v_caller := auth.uid();

  if v_caller is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  if exists (select 1 from public.paired_devices d where d.auth_user_id = v_caller) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if p_employee_id is null or p_active is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  select e.id, e.project_id, e.active, e.employee_code
  into v_employee
  from public.employees e
  join public.projects p on p.id = e.project_id
  where e.id = p_employee_id
    and p.user_id = v_caller;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  -- An employee who predates this migration and was already inactive has no
  -- code at all. Reactivating them needs one, and only a human can choose it.
  if p_active and not v_employee.active and v_employee.employee_code is null then
    return jsonb_build_object('ok', false, 'error', 'employee_code_required');
  end if;

  begin
    update public.employees e
    set active = p_active,
        deactivated_at = case when p_active then null else coalesce(e.deactivated_at, now()) end
    where e.id = p_employee_id
    returning e.id, e.display_name, e.role, e.employee_code, e.active, e.deactivated_at
    into v_updated;
  exception
    when unique_violation then
      -- Their old Employee ID belongs to somebody working today.
      return jsonb_build_object('ok', false, 'error', 'employee_code_taken');
  end;

  return jsonb_build_object(
    'ok', true,
    'employeeId', v_updated.id,
    'displayName', v_updated.display_name,
    'role', v_updated.role,
    'employeeCode', v_updated.employee_code,
    'active', v_updated.active,
    'deactivatedAt', v_updated.deactivated_at
  );
end;
$function$;

revoke all on function public.set_employee_active(uuid, boolean) from public;
revoke all on function public.set_employee_active(uuid, boolean) from anon;
revoke all on function public.set_employee_active(uuid, boolean) from service_role;
grant execute on function public.set_employee_active(uuid, boolean) to authenticated;

-- ----------------------------------------------------------------------------
-- 9. list_login_employees is deliberately NOT touched.
--
-- The roster remains available as the secondary/administrative path, exactly as
-- it is. Adding employeeCode to it would change a client-facing contract that
-- checkpoint 1 does not need: nothing in Employee ID login reads the roster,
-- and an owner-facing list that shows the code belongs with the management UI,
-- which is a later checkpoint. Not changing it keeps this migration to the one
-- thing it is for.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- 10. Verification -- fails loudly, and the whole migration rolls back with it.
--
--   A. what this migration built is exactly as intended;
--   B. what it was meant to leave alone is still there.
-- ----------------------------------------------------------------------------
do $do$
declare
  v_count integer;
  v_text text;
  v_row record;
begin
  -- A1. The column exists and is text. An integer here would have destroyed the
  -- leading zero, which is the whole user-facing contract.
  select data_type into v_text
  from information_schema.columns
  where table_schema = 'public' and table_name = 'employees' and column_name = 'employee_code';

  if v_text is distinct from 'text' then
    raise exception 'employee_code must be text, found %.', coalesce(v_text, '<missing>');
  end if;

  -- A2. Both check constraints are present.
  for v_text in
    select unnest(array[
      'employees_employee_code_shape_check',
      'employees_active_requires_code_check'
    ])
  loop
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.employees'::regclass and conname = v_text
    ) then
      raise exception 'Missing constraint %.', v_text;
    end if;
  end loop;

  -- A3. The uniqueness is a PARTIAL unique index KEYED ON EXACTLY
  -- (project_id, employee_code), IN THAT ORDER, over active rows only.
  --
  -- READ FROM pg_index, NOT FROM pg_get_indexdef's TEXT. The definition string
  -- would satisfy a loose match while the actual keys were wrong -- and the
  -- statement that created it says `if not exists`, so an index of the same
  -- name created by something else would be silently adopted. This resolves the
  -- real column numbers and compares them, which is the only way to tell the
  -- intended index from one that merely shares its name.
  --
  -- Every failure below is fatal: a wrong index here is a live till letting two
  -- people share an Employee ID.
  if to_regclass('public.employees_active_project_code_key') is null then
    raise exception 'Missing index employees_active_project_code_key.';
  end if;

  select i.indisunique,
         i.indpred is not null as is_partial,
         i.indnatts,
         i.indnkeyatts,
         array(
           select a.attname::text
           from unnest(i.indkey::smallint[]) with ordinality as k(attnum, ord)
           join pg_attribute a
             on a.attrelid = i.indrelid and a.attnum = k.attnum
           order by k.ord
         ) as key_columns,
         pg_get_expr(i.indpred, i.indrelid) as predicate
  into v_row
  from pg_index i
  where i.indexrelid = 'public.employees_active_project_code_key'::regclass;

  if not v_row.indisunique then
    raise exception 'employees_active_project_code_key is not UNIQUE.';
  end if;

  if not v_row.is_partial then
    raise exception
      'employees_active_project_code_key is not partial; a leaver''s retained code would block the next hire.';
  end if;

  -- Exactly two key columns, in this order. More, fewer, or swapped is a
  -- different invariant wearing the right name.
  if v_row.key_columns <> array['project_id', 'employee_code'] then
    raise exception
      'employees_active_project_code_key must be keyed on (project_id, employee_code), found (%).',
      array_to_string(v_row.key_columns, ', ');
  end if;

  if v_row.indnatts <> 2 or v_row.indnkeyatts <> 2 then
    raise exception
      'employees_active_project_code_key must have exactly two columns and no INCLUDE, found % (% key).',
      v_row.indnatts, v_row.indnkeyatts;
  end if;

  -- The predicate must be exactly "active", not merely mention it. `active or
  -- true` would contain the word and index everything.
  if btrim(coalesce(v_row.predicate, ''), '()') <> 'active' then
    raise exception
      'employees_active_project_code_key must be WHERE active, found WHERE %.',
      coalesce(v_row.predicate, '<none>');
  end if;

  -- And it must really be on employees, not a same-named index elsewhere that
  -- happened to be adopted by `if not exists`.
  if (select i.indrelid from pg_index i
      where i.indexrelid = 'public.employees_active_project_code_key'::regclass)
     <> 'public.employees'::regclass then
    raise exception 'employees_active_project_code_key is not an index on public.employees.';
  end if;

  -- A4. Every ACTIVE employee has a valid code, and no project has duplicates.
  select count(*) into v_count
  from public.employees e
  where e.active
    and (e.employee_code is null or e.employee_code !~ '^[0-9]{3}$' or e.employee_code = '000');

  if v_count > 0 then
    raise exception '% active employees have no valid Employee ID after backfill.', v_count;
  end if;

  select count(*) into v_count
  from (
    select e.project_id, e.employee_code
    from public.employees e
    where e.active
    group by e.project_id, e.employee_code
    having count(*) > 1
  ) as duplicates;

  if v_count > 0 then
    raise exception '% duplicate active Employee IDs survived the backfill.', v_count;
  end if;

  -- A5. The backfill numbered from 001 upward, per project, with no gaps and no
  -- wrap. Checked by comparing each project's codes against the expected run.
  for v_row in
    select e.project_id,
           count(*) as active_count,
           min(e.employee_code) as lowest,
           max(e.employee_code) as highest
    from public.employees e
    where e.active
    group by e.project_id
  loop
    if v_row.lowest <> '001' then
      raise exception 'Project % starts at % rather than 001.', v_row.project_id, v_row.lowest;
    end if;

    if v_row.highest <> lpad(v_row.active_count::text, 3, '0') then
      raise exception
        'Project % has % active employees but its highest Employee ID is %.',
        v_row.project_id, v_row.active_count, v_row.highest;
    end if;
  end loop;

  -- B1. The new login exists and the old one SURVIVES: the roster path is
  -- secondary, not deleted.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'employee_login_by_code'
  ) then
    raise exception 'employee_login_by_code is missing.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'employee_login'
      and pg_get_function_identity_arguments(p.oid) = 'p_employee_id uuid, p_pin text'
  ) then
    raise exception 'employee_login(uuid, text) must survive as the secondary path.';
  end if;

  -- B2. NO credential path still accepts 5 or 6 digits. Read from the live
  -- definitions, so a function left behind on the old rule is caught here.
  for v_text in
    select unnest(array[
      'employee_pin_hash',
      'employee_login',
      'employee_login_by_code',
      'create_employee',
      'set_employee_pin'
    ])
  loop
    for v_row in
      -- COMMENTS STRIPPED FIRST. pg_get_functiondef returns the body verbatim,
      -- comments included, and the bodies above deliberately quote the OLD
      -- '[0-9]{4,6}' rule while explaining what replaced it. Matching the raw
      -- text would fail on the explanation rather than on the code -- the same
      -- trap the Feature 1B migration's A8b assertion hit.
      select regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') as def,
             pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_text
    loop
      if v_row.def ~ '\[0-9\]\{4,6\}' then
        raise exception '%(%) still accepts a 4-6 digit PIN.', v_text, v_row.args;
      end if;

      if v_row.def !~ '\[0-9\]\{4\}' then
        raise exception '%(%) does not enforce an exactly-4-digit PIN.', v_text, v_row.args;
      end if;
    end loop;
  end loop;

  -- B3. The four-argument create_employee is gone, so nothing can create an
  -- active employee without an Employee ID.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_employee'
      and pg_get_function_identity_arguments(p.oid) = 'p_project_id uuid, p_display_name text, p_role text, p_pin text'
  ) then
    raise exception 'The codeless create_employee(uuid, text, text, text) still exists.';
  end if;

  -- B4. Every function this migration defines is SECURITY DEFINER with a locked
  -- search_path, and is executable by `authenticated` only.
  for v_text in
    select unnest(array[
      'employee_login_by_code',
      'set_employee_code',
      'create_employee',
      'set_employee_pin',
      'set_employee_active'
    ])
  loop
    for v_row in
      select p.prosecdef, p.proconfig, p.proacl, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_text
    loop
      if not v_row.prosecdef then
        raise exception '%(%) is not SECURITY DEFINER.', v_text, v_row.args;
      end if;

      if v_row.proconfig is null
         or not (v_row.proconfig @> array['search_path=public, pg_temp']
                 or v_row.proconfig @> array['search_path=public, extensions, pg_temp']) then
        raise exception '%(%) has no locked search_path.', v_text, v_row.args;
      end if;

      if array_to_string(v_row.proacl, ',') ~ '(anon|service_role)=' then
        raise exception '%(%) is still granted to anon or service_role.', v_text, v_row.args;
      end if;
    end loop;
  end loop;

  -- B5. Untouched by this migration, and asserted so a careless edit is loud:
  -- the tables and functions that carry sale attribution.
  for v_text in
    select unnest(array['complete_sale_v5', 'open_register_session', 'close_register_session'])
  loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_text
    ) then
      raise exception '% must still exist.', v_text;
    end if;
  end loop;

  -- B6. employees.id is still the primary key, and still what sessions and
  -- orders point at. The Employee ID never became the identity.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.employees'::regclass
      and contype = 'p'
      and pg_get_constraintdef(oid) = 'PRIMARY KEY (id)'
  ) then
    raise exception 'employees.id is no longer the primary key.';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.employee_pos_sessions'::regclass
      and contype = 'f'
      and pg_get_constraintdef(oid) like '%REFERENCES employees(id)%'
  ) then
    raise exception 'employee_pos_sessions no longer references employees(id).';
  end if;
end;
$do$;
