-- v1.3 CP3.1 — employee-session termination that names the session it ends.
--
-- THE HOLE THIS CLOSES. employee_logout() takes no arguments. It ends whatever
-- employee POS-session is currently open on the caller's paired device, and it
-- takes no lock on the device row while doing it. So a client holding a stale
-- expectation — session A, already replaced by session B through a legitimate
-- login — ends B instead. The operator standing at the till, who signed in
-- seconds ago, is silently signed out by somebody else's stale tab.
--
-- CP3 validation proved the mechanism on staging and showed why it has not bitten
-- yet: a stale till usually discovers it is stale through a refused sale, which
-- locks it before it can ring out. That is luck, not a guarantee, and it runs
-- out the moment termination stops being a human pressing a button. CP4's
-- Auto-Lock is a TIMER. A timer that fires after a legitimate handover would
-- end the new operator's session, and no amount of client care prevents it,
-- because the client cannot say which session it means.
--
-- So the fix is to let it say so. The client names the session it believes it
-- holds; the server ends that session or none.
--
-- THE EXPECTATION IS NOT AUTHORITY. It is the same distinction complete_sale_v5
-- already draws about its own two expectation ids: authority comes from
-- auth.uid() and the paired device row, and the expectation only decides
-- whether the caller is still talking about the world it thinks it is in. A
-- caller cannot name another device's session and have anything happen, and
-- cannot learn anything by trying.
--
-- WHY BOTH HALVES SHIP TOGETHER. Adding a safe function while the unsafe one
-- stays executable closes nothing: a stale client could still call the old one.
-- So this migration also revokes ordinary execution of employee_logout(). The
-- function itself is left physically present — its own migration is accepted
-- and immutable, and its tests keep their subject — but no product role can
-- reach it. Feature 1B is unreleased (origin/main contains no reference to
-- employee_logout or employee_pos_sessions), so nothing in the field breaks.
--
-- THIS MIGRATION CHANGES NO TABLE. No column, no index, no trigger, no policy,
-- no accepted function body. One new function, and two ACL changes.

-- ----------------------------------------------------------------------------
-- 1. The expectation-bound termination.
-- ----------------------------------------------------------------------------
create or replace function public.end_employee_pos_session(
  p_expected_employee_pos_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $function$
declare
  v_caller     uuid;
  v_device_id  uuid;
  v_expected   record;
  v_open_id    uuid;
  v_ended_id   uuid;
begin
  v_caller := auth.uid();

  if v_caller is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  -- ==========================================================================
  -- LOCK ORDER, step 1 of the Feature 1B global order: the paired device row,
  -- FOR UPDATE, before anything else and before any session row is read.
  --
  -- THIS LOCK IS THE WHOLE CONCURRENCY ARGUMENT. employee_login and
  -- employee_login_by_code both take THIS row FOR UPDATE and hold it across
  -- end-then-insert, so replacement cannot interleave with the classification
  -- below: whichever of the two arrives second sees the other's committed
  -- result and decides against it. complete_sale_v5 holds the same row FOR
  -- SHARE, which conflicts with FOR UPDATE, so a sale in flight and a
  -- termination cannot overlap either.
  --
  -- Nothing here locks the project row, so this is a prefix of the global
  -- order (device -> project -> session -> employee -> register) and adds no
  -- cycle.
  -- ==========================================================================
  select d.id
    into v_device_id
  from public.paired_devices d
  where d.auth_user_id = v_caller
    and d.revoked_at is null
    and d.unpaired_at is null
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_paired');
  end if;

  -- ==========================================================================
  -- Is the named session one this device may speak about at all?
  --
  -- BOTH PREDICATES, ALWAYS. `paired_device_id = v_device_id` is what makes a
  -- session id from another till meaningless here: it is not refused with a
  -- different error, it simply is not found. An unknown uuid and another
  -- shop's real session id produce the SAME answer, so this function cannot be
  -- used to discover whether a session id exists.
  -- ==========================================================================
  select s.id, s.ended_at
    into v_expected
  from public.employee_pos_sessions s
  where s.id = p_expected_employee_pos_session_id
    and s.paired_device_id = v_device_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'session_not_found');
  end if;

  -- What, if anything, is open on this device right now. Read under the device
  -- lock, so it cannot change under the branch below. At most one row can
  -- qualify: employee_pos_sessions_one_open_per_device is a unique partial
  -- index on (paired_device_id) where ended_at is null.
  --
  -- THIS IS A CLASSIFICATION READ, NOT A MUTATION TARGET. If it finds a
  -- replacement, that replacement's id is used to decide an answer and is
  -- never written to.
  select s.id
    into v_open_id
  from public.employee_pos_sessions s
  where s.paired_device_id = v_device_id
    and s.ended_at is null;

  if v_expected.ended_at is null then
    -- ========================================================================
    -- The named session is the one that is open. End IT.
    --
    -- The predicate names the expected id explicitly and additionally requires
    -- the device and the still-open state. There is deliberately no form of
    -- this statement that means "end whatever is open": were the id to be
    -- dropped from the WHERE clause, this function would become the very thing
    -- it exists to replace.
    -- ========================================================================
    update public.employee_pos_sessions s
    set ended_at   = now(),
        end_reason = 'logout'
    where s.id = p_expected_employee_pos_session_id
      and s.paired_device_id = v_device_id
      and s.ended_at is null
    returning s.id into v_ended_id;

    return jsonb_build_object(
      'ok', true,
      'outcome', 'ended',
      'endedSessionId', v_ended_id
    );
  end if;

  if v_open_id is null then
    -- Already ended, and nobody took the till afterwards. The caller's
    -- intention is satisfied and nothing needs doing, so a retry that lost its
    -- first reply gets a clean success rather than an error it cannot act on.
    --
    -- This success is only reachable because the lookup above already proved
    -- the row belongs to THIS device. It is not a blanket "unknown ids are
    -- fine".
    return jsonb_build_object(
      'ok', true,
      'outcome', 'already_ended',
      'endedSessionId', null
    );
  end if;

  -- Already ended, and somebody else is on the till now. This is the case the
  -- whole function exists for: the caller is stale, and the session it would
  -- have ended under the old zero-argument contract belongs to an operator who
  -- is standing there. Refuse, and touch nothing.
  return jsonb_build_object('ok', false, 'error', 'session_replaced');
end;
$function$;

comment on function public.end_employee_pos_session(uuid) is
  'v1.3 CP3.1 -- ends the employee POS session the caller NAMES, on the '
  'caller''s own paired device, or nothing. Authority comes from auth.uid() '
  'and the paired_devices row taken FOR UPDATE; the argument is a concurrency '
  'expectation, never authority. A session replaced by a newer login is '
  'reported as session_replaced and is never mutated. Unknown ids and other '
  'devices'' ids share one session_not_found answer, so this is not an '
  'existence oracle. Replaces zero-argument employee_logout(), whose ordinary '
  'execution this migration revokes.';

-- ----------------------------------------------------------------------------
-- 2. Privileges on the new function.
--
-- Supabase ships ALTER DEFAULT PRIVILEGES granting EXECUTE on new functions to
-- anon, authenticated and service_role, so a bare CREATE is world-executable.
-- Every grant below is therefore written as revoke-then-grant, matching CP2b
-- and CP2c: only `authenticated` — a paired till — may call this.
-- ----------------------------------------------------------------------------
revoke all on function public.end_employee_pos_session(uuid) from public;
revoke all on function public.end_employee_pos_session(uuid) from anon;
revoke all on function public.end_employee_pos_session(uuid) from service_role;
grant execute on function public.end_employee_pos_session(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 3. Close the unsafe path.
--
-- employee_logout() stays in the database. Its own migration is accepted and
-- immutable, its tests still have a subject, and dropping it would be a wider
-- change than this needs. What it loses is reachability: after this, no
-- ordinary product role can execute it, so there is no authenticated path that
-- ends an employee session without naming which session it means.
-- ----------------------------------------------------------------------------
revoke all on function public.employee_logout() from public;
revoke all on function public.employee_logout() from anon;
revoke all on function public.employee_logout() from authenticated;
revoke all on function public.employee_logout() from service_role;

-- ----------------------------------------------------------------------------
-- 4. Verify what this migration claims, against the live catalog.
-- ----------------------------------------------------------------------------
do $do$
declare
  v_oid_new oid;
  v_oid_old oid;
  v_src     text;
begin
  select p.oid into v_oid_new
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'end_employee_pos_session';

  if v_oid_new is null then
    raise exception 'CP3.1: end_employee_pos_session was not created.';
  end if;

  select p.oid, p.prosrc into v_oid_old, v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'employee_logout';

  if v_oid_old is null then
    raise exception 'CP3.1: employee_logout vanished; it must remain present.';
  end if;

  -- The new function must be SECURITY DEFINER with a pinned search_path.
  if not (select p.prosecdef from pg_proc p where p.oid = v_oid_new) then
    raise exception 'CP3.1: end_employee_pos_session must be SECURITY DEFINER.';
  end if;

  if not exists (
    select 1 from pg_proc p
    where p.oid = v_oid_new
      and p.proconfig @> array['search_path=public, pg_catalog, pg_temp']
  ) then
    raise exception 'CP3.1: end_employee_pos_session has no pinned search_path.';
  end if;

  -- EFFECTIVE privileges, not a proacl substring: has_function_privilege
  -- accounts for inherited and default grants, which is exactly the trap the
  -- Supabase default privileges set.
  if has_function_privilege('anon', v_oid_new, 'EXECUTE') then
    raise exception 'CP3.1: anon must not execute end_employee_pos_session.';
  end if;

  if has_function_privilege('service_role', v_oid_new, 'EXECUTE') then
    raise exception 'CP3.1: service_role must not execute end_employee_pos_session.';
  end if;

  if not has_function_privilege('authenticated', v_oid_new, 'EXECUTE') then
    raise exception 'CP3.1: authenticated must execute end_employee_pos_session.';
  end if;

  -- THE POINT OF THE WHOLE MIGRATION.
  if has_function_privilege('authenticated', v_oid_old, 'EXECUTE') then
    raise exception 'CP3.1: employee_logout is still executable by authenticated.';
  end if;

  if has_function_privilege('anon', v_oid_old, 'EXECUTE')
     or has_function_privilege('service_role', v_oid_old, 'EXECUTE') then
    raise exception 'CP3.1: employee_logout is still executable by a client role.';
  end if;

  -- employee_logout's BODY is untouched: this migration changes privileges,
  -- not behaviour, and its original migration stays immutable.
  if v_src !~ 'end_reason' or v_src !~ 'employee_pos_sessions' then
    raise exception 'CP3.1: employee_logout''s body was altered.';
  end if;

  -- The table must still be unreachable except through SECURITY DEFINER code.
  if has_table_privilege('authenticated', 'public.employee_pos_sessions', 'UPDATE')
     or has_table_privilege('authenticated', 'public.employee_pos_sessions', 'INSERT')
     or has_table_privilege('authenticated', 'public.employee_pos_sessions', 'DELETE')
     or has_table_privilege('anon', 'public.employee_pos_sessions', 'UPDATE') then
    raise exception 'CP3.1: employee_pos_sessions gained direct client privileges.';
  end if;

  if (select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'employee_pos_sessions') <> 0 then
    raise exception 'CP3.1: employee_pos_sessions gained a policy.';
  end if;

  -- The unique partial index the classification relies on must still exist.
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'employee_pos_sessions'
      and indexname = 'employee_pos_sessions_one_open_per_device'
  ) then
    raise exception 'CP3.1: the one-open-session-per-device index is missing.';
  end if;

  raise notice 'CP3.1 verified: expectation-bound termination added, zero-argument logout closed.';
end;
$do$;
