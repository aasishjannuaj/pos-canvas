-- ============================================================================
-- v1.3 Feature 1F — owner/admin reporting contracts.
--
-- WHAT THIS EXISTS TO SOLVE. Every operational table added by v1.3 is locked
-- twice over: `revoke all` from public, anon, authenticated AND service_role,
-- plus RLS enabled with zero policies. That is a deliberate, good posture --
-- but it means the project's own owner cannot read a single row of their time
-- clock, their cash movements or their register sessions, from anywhere. This
-- migration opens exactly four doors, each the narrowest shape that answers one
-- owner question, and closes nothing else.
--
-- WHAT IT DELIBERATELY IS NOT. There is no generic reporting framework here, no
-- view over an operational table, no new grant on any table, and no new table.
-- Four functions and one replaced trigger body. Adding a fifth door later
-- should feel like a decision, not a formality.
--
-- NOTHING IS REWRITTEN. No backfill, no historical update, no change to any
-- prior migration. Every v1.2/legacy order, employee, time session, cash
-- movement and register session remains exactly as it was.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- project_has_covering_daily_register -- the ONE shared DAILY predicate.
--
-- THIS IS NOT A NEW RULE. It is the accepted step-4a predicate from
-- ensure_daily_register_context (20260921120000), lifted verbatim and widened
-- from one till to every till in a project:
--
--     where r.paired_device_id = v_device.id
--       and r.business_date is not null
--       and r.opened_at <= v_now
--       and v_now < r.closed_at
--
-- WHY THAT PREDICATE IS EXACTLY THE RIGHT ONE FOR A TIMEZONE CHANGE, and not an
-- approximation of it. When such a row is found, the accepted function refuses
-- with daily_register_timezone_conflict if ANY of business_date,
-- business_timezone, opened_at or closed_at disagrees with what the CURRENT
-- project timezone would produce. A stored row necessarily holds the OLD zone,
-- so the moment the project's timezone actually changes, `business_timezone is
-- distinct from v_timezone` is true and that row is guaranteed to conflict on
-- the very next sale. "A covering context exists" and "this change would break
-- selling" are therefore the same statement, not two similar ones.
--
-- That equivalence is what the guard below relies on, and it is proved
-- behaviourally in the .db.test.ts rather than asserted here.
--
-- STABLE, not immutable: it reads tables.
-- ----------------------------------------------------------------------------
create or replace function public.project_has_covering_daily_register(
  p_project_id uuid,
  p_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select exists (
    select 1
    from public.register_sessions r
    join public.paired_devices d on d.id = r.paired_device_id
    where d.project_id = p_project_id
      and r.business_date is not null
      and r.opened_at <= p_at
      and p_at < r.closed_at
  );
$function$;

-- A helper, not an RPC. Nobody calls this from a client.
revoke all on function public.project_has_covering_daily_register(uuid, timestamptz) from public;
revoke all on function public.project_has_covering_daily_register(uuid, timestamptz) from anon;
revoke all on function public.project_has_covering_daily_register(uuid, timestamptz) from authenticated;
revoke all on function public.project_has_covering_daily_register(uuid, timestamptz) from service_role;

-- ----------------------------------------------------------------------------
-- projects_validate_business_timezone -- REPLACED, to refuse an unsafe change.
--
-- THE HOLE THIS CLOSES. Until now the only trigger on projects validated the
-- VALUE; the safety check lived on the SALE path (ensure_daily_register_context
-- and daily_register_context_for_sale). So an owner could change the timezone
-- successfully and discover the consequence later, as a till that refuses to
-- sell with daily_register_timezone_conflict. A warning in the UI cannot fix
-- that: the UI is not the authority, and an owner editing settings from a
-- laptop cannot see what a till across the shop is in the middle of.
--
-- WHY A TRIGGER RATHER THAN A SETTER RPC. The trigger cannot be bypassed. It
-- covers the plain RLS UPDATE that lib/projects.ts already uses, any future
-- write path, and a direct SQL edit. A setter RPC would only guard callers who
-- chose to use it, and the client's write path is precisely the RLS UPDATE.
-- That also means Feature 1F adds no new grant and no new client authority for
-- timezone: the existing "Users can update their own projects" policy is still
-- the whole authorization story.
--
-- ORDER OF CHECKS, and why. The unchanged-value short-circuit stays first so a
-- no-op save is free and can never be blocked. Value validation stays second,
-- because a malformed timezone should be reported as malformed whether or not a
-- till is open. The new refusal is third: it is about whether the operation is
-- PERMITTED, which is only a meaningful question once the value is well-formed.
--
-- The accepted 20260920120000 body is otherwise reproduced unchanged, including
-- its search_path (pg_catalog is required: is_valid_business_timezone reads
-- pg_catalog.pg_timezone_names).
-- ----------------------------------------------------------------------------
create or replace function public.projects_validate_business_timezone()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $function$
begin
  -- Unchanged value: nothing to validate and nothing to refuse.
  if tg_op = 'UPDATE'
     and old.business_timezone is not distinct from new.business_timezone then
    return new;
  end if;

  -- NULL is allowed and means "not set yet". It is not an error, and it is not
  -- a licence to guess: the daily-context work refuses instead.
  if new.business_timezone is not null
     and not public.is_valid_business_timezone(new.business_timezone) then
    raise exception
      'Invalid business timezone %. Use an IANA Region/City name such as America/New_York.',
      new.business_timezone
      using errcode = 'invalid_parameter_value';
  end if;

  -- v1.3 Feature 1F — an ACTUAL change, while a DAILY context covers this
  -- instant, is refused.
  --
  -- BOTH DIRECTIONS ARE GUARDED, including clearing the timezone back to NULL.
  -- Setting it to NULL under an open context does not merely shift the business
  -- day, it removes the answer entirely: require_business_timezone then raises
  -- business_timezone_required and the till stops selling. Refusing that is the
  -- same protection, not a wider one.
  --
  -- INSERT can never reach here with a covering context -- a brand new project
  -- has no register sessions -- so this is scoped to UPDATE and stays cheap.
  if tg_op = 'UPDATE'
     and public.project_has_covering_daily_register(new.id, now()) then
    raise exception 'business_timezone_change_blocked_open_register'
      using errcode = 'invalid_parameter_value';
  end if;

  return new;
end;
$function$;

-- EXECUTE TO NOBODY, INCLUDING authenticated. It is a trigger body, not an RPC.
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE on every new function to
-- anon, authenticated and service_role, so the authenticated grant has to be
-- revoked explicitly or it survives by default.
revoke all on function public.projects_validate_business_timezone() from public;
revoke all on function public.projects_validate_business_timezone() from anon;
revoke all on function public.projects_validate_business_timezone() from authenticated;
revoke all on function public.projects_validate_business_timezone() from service_role;

-- The trigger BINDING from 20260920120000 is deliberately not re-created: a
-- create-or-replace of the function body takes effect under the existing
-- trigger, and dropping/recreating the trigger would be a change to accepted
-- wiring for no benefit.

-- ----------------------------------------------------------------------------
-- list_employee_time_sessions -- the owner's Time Clock read.
--
-- employee_time_sessions IS THE ONLY SOURCE. employee_pos_sessions answers a
-- different question -- "who is signed in at this till" -- and its duration is
-- not worked time. Nothing in this function touches it, and a guard test holds
-- that line, because the two are easy to confuse and expensive to confuse.
--
-- NO DURATION IS RETURNED. It is clocked_out_at - clocked_in_at, and computing
-- it here would create a second source of truth for the same fact. The caller
-- subtracts two authoritative instants.
--
-- AN OPEN SHIFT IS RETURNED OPEN: clockedOutAt is null and isOpen is true. It
-- is never a zero duration and never elapsed-until-now, both of which would be
-- inventions about a shift that has not ended.
--
-- A SESSION CROSSING MIDNIGHT IS ONE ROW. Feature 1F does no payroll-style day
-- splitting, and this table stores no business date or timezone to split on.
-- ----------------------------------------------------------------------------
create or replace function public.list_employee_time_sessions(
  p_project_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller uuid;
  v_project_owner uuid;
  v_rows jsonb;
begin
  v_caller := auth.uid();

  if v_caller is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  -- A paired device authenticates as a real Supabase user. It must never
  -- satisfy an owner contract, and it learns nothing from the refusal.
  if exists (select 1 from public.paired_devices d where d.auth_user_id = v_caller) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if p_project_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  select p.user_id into v_project_owner
  from public.projects p
  where p.id = p_project_id;

  -- A project owned by someone else is indistinguishable from one that does not
  -- exist.
  if not found or v_project_owner is distinct from v_caller then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'timeSessionId', t.id,
        'employeeId', t.employee_id,
        'displayName', e.display_name,
        'clockedInAt', t.clocked_in_at,
        'clockedOutAt', t.clocked_out_at,
        'isOpen', t.clocked_out_at is null,
        'clockInPairedDeviceId', t.clock_in_paired_device_id,
        'clockOutPairedDeviceId', t.clock_out_paired_device_id
      )
      order by t.clocked_in_at desc, t.id
    ),
    '[]'::jsonb
  )
  into v_rows
  from public.employee_time_sessions t
  join public.employees e on e.id = t.employee_id
  where t.project_id = p_project_id
    -- An inclusive-start, exclusive-end window over the clock-in instant. An
    -- open shift that began inside the window is included; a shift that began
    -- before it is not, which is the honest reading of "sessions in this range"
    -- and avoids inventing a partial session.
    and (p_from is null or t.clocked_in_at >= p_from)
    and (p_to is null or t.clocked_in_at < p_to);

  return jsonb_build_object('ok', true, 'timeSessions', v_rows);
end;
$function$;

revoke all on function public.list_employee_time_sessions(uuid, timestamptz, timestamptz) from public;
revoke all on function public.list_employee_time_sessions(uuid, timestamptz, timestamptz) from anon;
revoke all on function public.list_employee_time_sessions(uuid, timestamptz, timestamptz) from service_role;
grant execute on function public.list_employee_time_sessions(uuid, timestamptz, timestamptz) to authenticated;

-- ----------------------------------------------------------------------------
-- list_cash_movements -- the owner's Cash Activity read.
--
-- SOURCE EVENTS ONLY. This returns what was recorded: three movement kinds, an
-- amount, who, which till, which register, when, and a note. It returns no sum,
-- no balance, and nothing about what the drawer should contain.
--
-- WHY NO EXPECTED / ACTUAL / OVER-SHORT, stated once and permanently. Those
-- figures do not exist to be reported: close_register_session takes only a
-- session id and captures no counted cash, and register_sessions has no counted
-- or variance column.
--
-- AND opening_cash IS NOT ONE FIGURE, which is worth stating precisely because
-- it is easy to get wrong in both directions. A register opened explicitly
-- through open_register_session carries a cashier-entered amount -- the "Cash in
-- the drawer" field in components/device/PosGates.tsx. A DAILY context created
-- by ensure_daily_register_context carries a STRUCTURAL 0 (20260921120000
-- requires opening_cash = 0 on that path and forbids changing it afterwards),
-- which is not a count of anything. Reporting either one as a starting drawer
-- balance would be wrong: the first is only the drawer at the moment it opened,
-- and the second is not a drawer figure at all.
--
-- Either way an opening figure plus movements is not a closing position, and
-- presenting it as one would be arithmetic over a count nobody took.
-- opening_cash is therefore deliberately NOT returned here.
--
-- businessDate IS JOINED, NOT DERIVED. cash_movements.register_session_id is
-- NOT NULL, so every movement has an authoritative stored business date.
-- Recomputing it from occurred_at and the CURRENT project timezone would
-- silently disagree with the register's own record after any timezone change.
-- Only that one column is taken from register_sessions.
-- ----------------------------------------------------------------------------
create or replace function public.list_cash_movements(
  p_project_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller uuid;
  v_project_owner uuid;
  v_rows jsonb;
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

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'movementId', m.id,
        'movementType', m.movement_type,
        'amount', m.amount,
        'employeeId', m.employee_id,
        'displayName', e.display_name,
        'pairedDeviceId', m.paired_device_id,
        'registerSessionId', m.register_session_id,
        'businessDate', r.business_date,
        'occurredAt', m.occurred_at,
        'note', m.note
      )
      order by m.occurred_at desc, m.id
    ),
    '[]'::jsonb
  )
  into v_rows
  from public.cash_movements m
  join public.employees e on e.id = m.employee_id
  join public.register_sessions r on r.id = m.register_session_id
  -- Belt and braces: the register session must belong to a till of the SAME
  -- project. It cannot disagree today; this makes that a checked fact.
  join public.paired_devices d
    on d.id = r.paired_device_id
   and d.project_id = p_project_id
  where m.project_id = p_project_id
    and (p_from is null or m.occurred_at >= p_from)
    and (p_to is null or m.occurred_at < p_to);

  return jsonb_build_object('ok', true, 'cashMovements', v_rows);
end;
$function$;

revoke all on function public.list_cash_movements(uuid, timestamptz, timestamptz) from public;
revoke all on function public.list_cash_movements(uuid, timestamptz, timestamptz) from anon;
revoke all on function public.list_cash_movements(uuid, timestamptz, timestamptz) from service_role;
grant execute on function public.list_cash_movements(uuid, timestamptz, timestamptz) to authenticated;

-- ----------------------------------------------------------------------------
-- list_order_business_dates -- the authoritative business date for REGISTERED
-- sales, and nothing else about a register.
--
-- WHY THIS EXISTS AT ALL. orders has no business_date column, and the
-- authoritative value lives on register_sessions, which is revoked from
-- authenticated and RLS-denied. Orders themselves are already readable by their
-- owner (RLS policy plus a table-level SELECT grant), so this function
-- deliberately does NOT return orders -- it returns the one field the client
-- cannot otherwise reach, keyed by order id, and the caller joins it to the
-- orders it already reads. That keeps the existing, well-tested RLS path as the
-- single route to money fields.
--
-- WHY NOT A POLICY ON register_sessions. Granting SELECT to expose one column
-- would expose opening_cash, the open/close instants and the opening employee
-- along with it. A narrow projection is the smaller door.
--
-- AN ORDER WITH NO register_session_id SIMPLY HAS NO ROW HERE. Nothing is
-- fabricated for it: no register id, no date, no guessed historical timezone.
-- The caller falls back to presentation bucketing, and that fallback is the
-- caller's to label.
-- ----------------------------------------------------------------------------
create or replace function public.list_order_business_dates(
  p_project_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller uuid;
  v_project_owner uuid;
  v_rows jsonb;
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

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'orderId', o.id,
        'businessDate', r.business_date
      )
      order by o.created_at desc, o.id
    ),
    '[]'::jsonb
  )
  into v_rows
  from public.orders o
  -- An INNER join, on purpose: an unregistered order is absent, not null-dated.
  join public.register_sessions r on r.id = o.register_session_id
  join public.paired_devices d
    on d.id = r.paired_device_id
   and d.project_id = p_project_id
  where o.project_id = p_project_id
    and r.business_date is not null
    and (p_from is null or o.created_at >= p_from)
    and (p_to is null or o.created_at < p_to);

  return jsonb_build_object('ok', true, 'orderBusinessDates', v_rows);
end;
$function$;

revoke all on function public.list_order_business_dates(uuid, timestamptz, timestamptz) from public;
revoke all on function public.list_order_business_dates(uuid, timestamptz, timestamptz) from anon;
revoke all on function public.list_order_business_dates(uuid, timestamptz, timestamptz) from service_role;
grant execute on function public.list_order_business_dates(uuid, timestamptz, timestamptz) to authenticated;

-- ----------------------------------------------------------------------------
-- set_employee_role -- the one missing employee mutator.
--
-- Role was settable only at create_employee; there was no way to change it
-- afterwards. This is modelled directly on set_employee_active
-- (20260914120000): same caller checks, same refusal vocabulary, same shape of
-- return.
--
-- IT UPDATES CURRENT ROLE ONLY. orders, employee_time_sessions, cash_movements
-- and register_sessions attribute by employee_id, never by a copied role, so no
-- historical row is touched and none needs to be. There is no backfill here and
-- there must never be one: what an employee's role was when a sale happened is
-- not something this product records, and inventing it retroactively would be
-- worse than not having it.
--
-- IT CANNOT ESCALATE THE CALLER. The caller is a platform account verified
-- against projects.user_id; the row being changed is a POS employee inside a
-- project they already own. A POS role of 'owner' grants no platform authority
-- whatsoever -- it cannot call this function or any other owner contract.
--
-- ON ROLE DOWNGRADE, AND WHY NOTHING ELSE IS NEEDED HERE. employee_pos_sessions
-- stores NO role, and get_current_employee_session resolves role by joining
-- employees live (and requires e.active). So the new role is in force at the
-- next authoritative resolution, with no session versioning, no forced Ring
-- Out, no revocation and no snapshot -- none of which this feature adds.
-- ----------------------------------------------------------------------------
create or replace function public.set_employee_role(
  p_employee_id uuid,
  p_role text
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

  select e.id, e.project_id into v_employee
  from public.employees e
  where e.id = p_employee_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  select p.user_id into v_project_owner
  from public.projects p
  where p.id = v_employee.project_id;

  if not found or v_project_owner is distinct from v_caller then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  -- The same three roles employees_role_check enforces. Stated here so the
  -- caller gets a named refusal rather than a constraint violation.
  if p_role is null or p_role not in ('owner', 'manager', 'cashier') then
    return jsonb_build_object('ok', false, 'error', 'invalid_role');
  end if;

  update public.employees e
  set role = p_role,
      updated_at = now()
  where e.id = p_employee_id
  returning e.id, e.display_name, e.role, e.active into v_updated;

  return jsonb_build_object(
    'ok', true,
    'employeeId', v_updated.id,
    'displayName', v_updated.display_name,
    'role', v_updated.role,
    'active', v_updated.active
  );
end;
$function$;

revoke all on function public.set_employee_role(uuid, text) from public;
revoke all on function public.set_employee_role(uuid, text) from anon;
revoke all on function public.set_employee_role(uuid, text) from service_role;
grant execute on function public.set_employee_role(uuid, text) to authenticated;
