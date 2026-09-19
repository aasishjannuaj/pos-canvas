-- v1.3 Checkpoint 2b — the DAILY register context.
--
-- FORWARD MIGRATION, ADDITIVE ONLY. Every earlier migration is accepted and
-- immutable; nothing here redefines any object any of them created, and the
-- verification block at the end proves it by comparing self-captured baselines.
-- This file adds:
--
--   * register_sessions.business_date / business_timezone   (new, nullable)
--   * conditional integrity replacing three physical rules
--   * register_sessions_one_daily_per_device_date           (partial unique)
--   * register_sessions_guard_daily_immutable               (trigger)
--   * ensure_daily_register_context()                       (NEW, device-only)
--
-- It does NOT redefine open_register_session, get_current_register_session,
-- close_register_session or complete_sale_v5. Not one of them changes, and
-- that is a design claim this file makes on purpose -- see "WHY THE LEGACY
-- RPCS NEED NO CHANGE" below.
--
-- Apply manually, as ONE SQL Editor submission (one session): the baseline
-- temporary tables below are compared against at the end.
--
-- ----------------------------------------------------------------------------
-- WHAT A DAILY ROW IS
-- ----------------------------------------------------------------------------
-- A business day, for one till, as an interval the database can hand to
-- anything that needs to ask "which day does this sale belong to".
--
-- It is NOT a drawer period. Nobody opens it, nobody closes it, no cash is
-- counted into or out of it, and no employee is attributed to it. It is a
-- calendar fact about a paired device, created on demand and then frozen.
--
-- MODE DISCRIMINATOR: business_date.
--   business_date IS NULL      -> LEGACY/MANUAL (Feature 1B, unchanged)
--   business_date IS NOT NULL  -> DAILY
--
-- There is no is_daily column. business_date carries the distinction because
-- it is the thing that actually differs: a manual drawer period has no
-- business date, and a daily context is nothing but one. A boolean beside it
-- could disagree with it, and then something would have to decide which of the
-- two is telling the truth.
--
-- ----------------------------------------------------------------------------
-- THE INTERVAL IS COMPUTED, NEVER ASSUMED
-- ----------------------------------------------------------------------------
--   opened_at = local midnight starting business_date
--   closed_at = local midnight starting the NEXT LOCAL CALENDAR DATE
--   the day is [opened_at, closed_at)
--
-- NEVER opened_at + interval '24 hours'. A spring-forward day is 23 hours, a
-- fall-back day is 25, and a business that closes at 2am on the wrong one of
-- those would have an hour of sales land on the wrong day. Both endpoints come
-- from the accepted CP2a helper business_day_bounds, which converts each local
-- midnight independently, so the length of the day is whatever the zone says
-- it is and is never arithmetic on the other endpoint.
--
-- ----------------------------------------------------------------------------
-- WHY business_timezone IS STORED ON THE ROW
-- ----------------------------------------------------------------------------
-- It is a historical snapshot, not a setting. It records which zone was used to
-- compute THIS row's endpoints. A business that changes its timezone does not
-- retroactively change what "Tuesday" meant for the sales already attributed to
-- it, so the row keeps the zone it was built from, forever, and a later
-- disagreement is reported rather than resolved -- see section 6.
--
-- ----------------------------------------------------------------------------
-- WHY THE LEGACY RPCS NEED NO CHANGE
-- ----------------------------------------------------------------------------
-- A DAILY row always has closed_at set, at creation, because its end is known
-- before its beginning has arrived. Three existing behaviours fall out of that
-- single fact, structurally, with no code edited and no special case written:
--
--   get_current_register_session  selects `closed_at is null`  -> never a DAILY row
--   open_register_session         selects `closed_at is null`  -> never blocked by one
--   complete_sale_v5 (online)     selects `closed_at is null`  -> never attributes to one
--   register_sessions_one_open_per_device is partial on the same predicate,
--                                                              -> DAILY rows are not in it
--
-- And close_register_session, handed a DAILY id, takes its "already closed"
-- branch -- which returns the stored row after nothing but authentication and
-- ownership: no lock, no employee lookup, no write. A manual close of a daily
-- context is therefore a safe no-op that invents no closer, rather than a
-- constraint violation or a corrupted row.
--
-- The verification block and the sibling test suite both assert these rather
-- than trusting the reasoning.
--
-- ----------------------------------------------------------------------------
-- NOT IN THIS FILE
-- ----------------------------------------------------------------------------
-- No complete_sale_v5 change, no online daily rollover, no offline daily
-- derivation, no queue schema change, no DeviceApp change, no backfill of
-- existing rows, no cron, no scheduler and no midnight job. A DAILY row already
-- carries its own end; midnight is not an event, it is just when the next
-- business date starts answering. Rollover at sale time is CP2c.

-- ----------------------------------------------------------------------------
-- 0. Self-capturing baselines, recorded BEFORE any DDL.
-- ----------------------------------------------------------------------------
create temporary table cp2b_proc_baseline as
select p.oid as fn_oid,
       p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       md5(pg_get_functiondef(p.oid)) as body,
       p.prosecdef,
       p.provolatile::text as volatile,
       coalesce(p.proconfig, array[]::text[]) as config,
       coalesce(p.proacl::text, 'default') as acl
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f';

create temporary table cp2b_pol_baseline as
select tablename, policyname, cmd, qual, with_check, roles::text as roles
from pg_policies
where schemaname = 'public';

create temporary table cp2b_priv_baseline as
select r.rolname, t.relname as tablename, p.priv,
       has_table_privilege(r.rolname, t.oid, p.priv) as held
from (values ('anon'), ('authenticated'), ('service_role')) as r(rolname)
cross join (
  select c.oid, c.relname
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
) as t
cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
                   ('REFERENCES'), ('TRIGGER')) as p(priv);

create temporary table cp2b_rls_baseline as
select c.relname, c.relrowsecurity, c.relforcerowsecurity
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r';

create temporary table cp2b_con_baseline as
select c.conrelid::regclass::text as tbl, c.conname, c.contype::text as contype,
       pg_get_constraintdef(c.oid) as def
from pg_constraint c
join pg_namespace n on n.oid = c.connamespace
where n.nspname = 'public'
  and c.contype in ('c', 'f', 'p', 'u', 'x');

create temporary table cp2b_idx_baseline as
select tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public';

create temporary table cp2b_col_baseline as
select table_name, column_name, ordinal_position, data_type,
       is_nullable, coalesce(column_default, '') as column_default
from information_schema.columns
where table_schema = 'public';

-- NO BACKFILL. Every register_sessions row that exists now must come out of
-- this migration byte-identical, with business_date and business_timezone null.
create temporary table cp2b_row_baseline as
select (select count(*) from public.register_sessions) as registers,
       (select coalesce(md5(string_agg(md5(r::text), '|' order by r.id::text)), 'empty')
        from public.register_sessions r) as registers_fp,
       (select count(*) from public.orders) as orders,
       (select coalesce(md5(string_agg(md5(o::text), '|' order by o.id::text)), 'empty')
        from public.orders o) as orders_fp;

-- ----------------------------------------------------------------------------
-- 1. The two new columns.
--
-- NULLABLE, NO DEFAULT, NO BACKFILL. Every existing row is a LEGACY/MANUAL
-- drawer period and stays one. A default on business_date would silently
-- reclassify all of them; nullability is what makes the mode discriminator
-- honest about history rather than rewriting it.
-- ----------------------------------------------------------------------------
alter table public.register_sessions
  add column business_date date,
  add column business_timezone text;

comment on column public.register_sessions.business_date is
  'v1.3 CP2b -- the business date this DAILY context covers, in the business''s own '
  'zone. NULL means this row is a LEGACY/MANUAL drawer period (Feature 1B). This '
  'column is the only mode discriminator; there is no is_daily flag. Never backfilled.';

comment on column public.register_sessions.business_timezone is
  'v1.3 CP2b -- the IMMUTABLE HISTORICAL SNAPSHOT of projects.business_timezone that '
  'was used to compute this row''s opened_at and closed_at. Not a setting and not a '
  'live reference: changing the project''s timezone never rewrites it. NULL on every '
  'LEGACY/MANUAL row.';

-- ----------------------------------------------------------------------------
-- 2. Conditional integrity, replacing three physical rules.
--
-- The physical rules being relaxed were correct for a world where every row was
-- opened by a person. They cannot express "opened by nobody, because nobody
-- opened it", which is precisely what a calendar fact is. They are replaced by
-- two constraints that say the same things they said, conditioned on the mode,
-- and that ALSO say what a DAILY row must look like.
--
-- LEGACY INTEGRITY IS NOT WEAKENED. Every rule a legacy row obeyed before this
-- migration it still obeys afterwards, including the closed_at /
-- closed_by_employee_id biconditional, which moves inside
-- register_sessions_legacy_shape unchanged. The verification block proves an
-- existing row cannot be edited into any of the shapes the old NOT NULLs used
-- to forbid.
--
-- The opening_cash rules (>= 0, finite, two decimal places) are NOT touched:
-- they apply to every row, and 0.00 satisfies all three.
-- ----------------------------------------------------------------------------
alter table public.register_sessions
  alter column opened_by_employee_id drop not null,
  alter column open_request_id drop not null;

alter table public.register_sessions
  drop constraint register_sessions_closed_state;

alter table public.register_sessions
  add constraint register_sessions_legacy_shape
    check (
      business_date is not null
      or (
        business_timezone is null
        and opened_by_employee_id is not null
        and open_request_id is not null
        -- The Feature 1B biconditional, preserved verbatim in meaning: a closed
        -- drawer period always says who closed it, an open one never does.
        and (closed_at is null) = (closed_by_employee_id is null)
      )
    ),
  add constraint register_sessions_daily_shape
    check (
      business_date is null
      or (
        business_timezone is not null
        and opened_by_employee_id is null
        and closed_by_employee_id is null
        and open_request_id is null
        and opening_cash = 0
        and closed_at is not null
      )
    );

-- ----------------------------------------------------------------------------
-- 3. One DAILY context per till per business date.
--
-- PARTIAL, on business_date is not null. Uniqueness is a DAILY rule only:
-- legacy rows all carry a null business_date and are not in this index at all,
-- so no number of manual drawer periods on a till can collide with each other
-- or with a daily context.
--
-- Two devices in the same shop on the same date get two rows, deliberately: the
-- register identity is the paired device, and a sale is attributed to the till
-- that took it.
-- ----------------------------------------------------------------------------
create unique index register_sessions_one_daily_per_device_date
  on public.register_sessions using btree (paired_device_id, business_date)
  where business_date is not null;

-- ----------------------------------------------------------------------------
-- 4. A DAILY row is frozen the moment it exists.
--
-- Its whole value is that it is the same answer every time it is asked. If the
-- interval could move, every sale already attributed to it would silently
-- change which day it belonged to, and no reader could tell that had happened.
--
-- NARROWEST MECHANISM AVAILABLE: a row-level BEFORE UPDATE trigger with a WHEN
-- clause on old.business_date. A legacy row never invokes the function at all
-- -- PostgreSQL evaluates the WHEN clause before calling it -- so this adds no
-- behaviour and no cost to the Feature 1B path. Legacy immutability is exactly
-- what it was before this migration: closing a drawer period still works.
--
-- SECURITY INVOKER: it compares OLD and NEW and reads nothing. The locked
-- search_path stays, because that is what matters for a function reached from a
-- trigger. EXECUTE is granted to nobody; firing a trigger does not check the
-- invoking user's EXECUTE privilege.
-- ----------------------------------------------------------------------------
create or replace function public.register_sessions_guard_daily_immutable()
returns trigger
language plpgsql
set search_path = public, pg_catalog, pg_temp
as $function$
begin
  if new.id is distinct from old.id then
    raise exception 'register_sessions.id cannot be changed on a daily register context';
  end if;

  if new.paired_device_id is distinct from old.paired_device_id then
    raise exception 'register_sessions.paired_device_id cannot be changed on a daily register context';
  end if;

  if new.business_date is distinct from old.business_date then
    raise exception 'register_sessions.business_date cannot be changed on a daily register context';
  end if;

  if new.business_timezone is distinct from old.business_timezone then
    raise exception 'register_sessions.business_timezone cannot be changed on a daily register context';
  end if;

  if new.opened_at is distinct from old.opened_at then
    raise exception 'register_sessions.opened_at cannot be changed on a daily register context';
  end if;

  if new.closed_at is distinct from old.closed_at then
    raise exception 'register_sessions.closed_at cannot be changed on a daily register context';
  end if;

  if new.opened_by_employee_id is distinct from old.opened_by_employee_id then
    raise exception 'register_sessions.opened_by_employee_id cannot be changed on a daily register context';
  end if;

  if new.closed_by_employee_id is distinct from old.closed_by_employee_id then
    raise exception 'register_sessions.closed_by_employee_id cannot be changed on a daily register context';
  end if;

  if new.open_request_id is distinct from old.open_request_id then
    raise exception 'register_sessions.open_request_id cannot be changed on a daily register context';
  end if;

  if new.opening_cash is distinct from old.opening_cash then
    raise exception 'register_sessions.opening_cash cannot be changed on a daily register context';
  end if;

  return new;
end;
$function$;

revoke all on function public.register_sessions_guard_daily_immutable() from public;
revoke all on function public.register_sessions_guard_daily_immutable() from anon;
revoke all on function public.register_sessions_guard_daily_immutable() from authenticated;
revoke all on function public.register_sessions_guard_daily_immutable() from service_role;

create trigger register_sessions_guard_daily_immutable
  before update on public.register_sessions
  for each row
  when (old.business_date is not null)
  execute function public.register_sessions_guard_daily_immutable();

-- ----------------------------------------------------------------------------
-- 5. ensure_daily_register_context()
--
-- ZERO ARGUMENTS, AND THAT IS THE WHOLE POINT. There is nothing a client could
-- pass that would not be an authority claim: a project id, a device id, a
-- business date, a timestamp, a timezone. Every one of them is derived here,
-- from auth.uid() outwards, so a till cannot name a day, a shop or a zone it
-- has no right to and cannot get a different answer by lying about the time.
--
--   auth.uid() -> paired device -> project -> projects.business_timezone
--              -> clock_timestamp() -> business_date -> calendar bounds
--              -> find or create the DAILY row
--
-- NO EMPLOYEE IS REQUIRED OR RECORDED. A calendar fact is not an act by a
-- person. Requiring a POS session to learn what day it is would make the
-- business day depend on who happened to be signed in, and attributing an
-- opener would be inventing a person who did nothing.
--
-- LOCK ORDER, the established one, in the established direction:
--   1. paired_devices  FOR UPDATE  -- serializes every ensure on this till
--   2. projects        FOR SHARE   -- pins the timezone for this transaction
--   3. register_sessions           -- read, then insert
--
-- THE TIMEZONE RACE, and why step 2 exists. The zone is read once and used for
-- three things: the business date, both interval endpoints, and the snapshot
-- stored on the row. If a concurrent owner update could land between any two of
-- those, the row could be written with one zone's date, another zone's bounds,
-- and a third value snapshotted -- a row that is internally inconsistent and
-- frozen that way forever. FOR SHARE on the project row makes the four reads
-- one read: an owner's UPDATE takes FOR NO KEY UPDATE, which conflicts, so it
-- waits until this transaction commits. This does not redesign timezone
-- settings; it borrows the row for the length of one insert.
--
-- IDEMPOTENT BY LOCK AND BY INDEX, BOTH. The device lock means a second caller
-- physically cannot reach the insert until the first has committed, so it finds
-- the row and returns the same id. The partial unique index is the backstop for
-- a path that does not hold the lock. Neither is trusted alone, and a
-- unique_violation is answered with the winning row rather than an error.
-- ----------------------------------------------------------------------------
create or replace function public.ensure_daily_register_context()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $function$
declare
  v_caller uuid;
  v_device record;
  v_timezone text;
  v_now timestamptz;
  v_business_date date;
  v_bounds record;
  v_register record;
begin
  v_caller := auth.uid();

  if v_caller is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  -- Step 1: the device, FOR UPDATE. The same lock open_register_session and
  -- close_register_session take, in the same direction, so a daily context is
  -- never created while a drawer period is opening or closing on this till.
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

  -- Step 2: the project, FOR SHARE. Taken BEFORE the timezone is read and held
  -- for the rest of the transaction. Not inside the exception block below: a
  -- subtransaction that aborts releases the locks it took, and this one must
  -- survive.
  perform 1
  from public.projects p
  where p.id = v_device.project_id
  for share;

  -- The CP2a contract, called as the owner of both functions. It is revoked
  -- from every client role; this is the caller it was written for.
  begin
    v_timezone := public.require_business_timezone(v_device.project_id);
  exception
    when invalid_parameter_value then
      if sqlerrm <> 'business_timezone_required' then
        raise;
      end if;

      return jsonb_build_object('ok', false, 'error', 'business_timezone_required');
  end;

  -- Step 3: the calendar, from the server's clock and nothing else.
  v_now := clock_timestamp();
  v_business_date := public.business_date_of(v_now, v_timezone);

  if v_business_date is null then
    -- The stored zone no longer resolves. is_valid_business_timezone is STABLE
    -- rather than IMMUTABLE precisely because the tz database can change under
    -- us between releases, and CP2a said so. A business whose zone the server
    -- can no longer interpret has, for every practical purpose, not told us
    -- what day it is -- so it gets the same answer as one that never did, and
    -- the fix is the same: set the timezone again.
    return jsonb_build_object('ok', false, 'error', 'business_timezone_required');
  end if;

  select b.starts_at, b.ends_at
  into v_bounds
  from public.business_day_bounds(v_business_date, v_timezone) b;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'business_timezone_required');
  end if;

  -- Step 4: an existing context for this till and this date. The device lock
  -- already excludes a concurrent ensure, so a plain read is authoritative.
  select r.id, r.business_date, r.business_timezone, r.opened_at, r.closed_at,
         r.opening_cash
  into v_register
  from public.register_sessions r
  where r.paired_device_id = v_device.id
    and r.business_date = v_business_date;

  if found then
    -- THE SNAPSHOT DISAGREES WITH THE PROJECT. The business changed its
    -- timezone after this day's context was created, or the tz database moved
    -- underneath it. Rewriting the row would retroactively change which day
    -- existing sales belong to; creating a second row for the same date would
    -- make "which day is it" ambiguous; reinterpreting the stored bounds would
    -- be a guess. All three destroy history, so none of them happens: the call
    -- fails closed and a person decides.
    if v_register.business_timezone is distinct from v_timezone
       or v_register.opened_at is distinct from v_bounds.starts_at
       or v_register.closed_at is distinct from v_bounds.ends_at then
      return jsonb_build_object('ok', false, 'error', 'daily_register_timezone_conflict');
    end if;

    return jsonb_build_object(
      'ok', true,
      'created', false,
      'registerSession', jsonb_build_object(
        'registerSessionId', v_register.id,
        'businessDate', v_register.business_date,
        'businessTimezone', v_register.business_timezone,
        'openedAt', v_register.opened_at,
        'closedAt', v_register.closed_at,
        'openedByEmployeeId', null::uuid,
        'closedByEmployeeId', null::uuid,
        'openingCash', v_register.opening_cash::text
      )
    );
  end if;

  begin
    insert into public.register_sessions (
      paired_device_id, opened_by_employee_id, opened_at, opening_cash,
      open_request_id, closed_at, closed_by_employee_id,
      business_date, business_timezone
    )
    values (
      v_device.id, null, v_bounds.starts_at, 0.00,
      null, v_bounds.ends_at, null,
      v_business_date, v_timezone
    )
    returning id, business_date, business_timezone, opened_at, closed_at, opening_cash
    into v_register;
  exception
    when unique_violation then
      -- Unreachable while the device lock is held, and answered anyway. A
      -- caller that asked for today's context and lost a race still wants
      -- today's context, not a report that somebody else created it first.
      select r.id, r.business_date, r.business_timezone, r.opened_at, r.closed_at,
             r.opening_cash
      into v_register
      from public.register_sessions r
      where r.paired_device_id = v_device.id
        and r.business_date = v_business_date;

      if not found then
        raise;
      end if;

      if v_register.business_timezone is distinct from v_timezone
         or v_register.opened_at is distinct from v_bounds.starts_at
         or v_register.closed_at is distinct from v_bounds.ends_at then
        return jsonb_build_object('ok', false, 'error', 'daily_register_timezone_conflict');
      end if;

      return jsonb_build_object(
        'ok', true,
        'created', false,
        'registerSession', jsonb_build_object(
          'registerSessionId', v_register.id,
          'businessDate', v_register.business_date,
          'businessTimezone', v_register.business_timezone,
          'openedAt', v_register.opened_at,
          'closedAt', v_register.closed_at,
          'openedByEmployeeId', null::uuid,
          'closedByEmployeeId', null::uuid,
          'openingCash', v_register.opening_cash::text
        )
      );
  end;

  return jsonb_build_object(
    'ok', true,
    'created', true,
    'registerSession', jsonb_build_object(
      'registerSessionId', v_register.id,
      'businessDate', v_register.business_date,
      'businessTimezone', v_register.business_timezone,
      'openedAt', v_register.opened_at,
      'closedAt', v_register.closed_at,
      'openedByEmployeeId', null::uuid,
      'closedByEmployeeId', null::uuid,
      'openingCash', v_register.opening_cash::text
    )
  );
end;
$function$;

revoke all on function public.ensure_daily_register_context() from public;
revoke all on function public.ensure_daily_register_context() from anon;
revoke all on function public.ensure_daily_register_context() from service_role;
grant execute on function public.ensure_daily_register_context() to authenticated;

-- ----------------------------------------------------------------------------
-- 6. Verification -- fails loudly, and the whole migration rolls back with it.
--
-- The conditional constraints are EVALUATED against probe rows rather than
-- compared as text: what matters is which rows they accept, not how PostgreSQL
-- chose to re-render the expression. No fixture row is ever inserted into a
-- real table here, which is why the row fingerprints in A12 can be exact.
-- ----------------------------------------------------------------------------
do $do$
declare
  v_text text;
  v_role text;
  v_expr_legacy text;
  v_expr_daily text;
  v_ok boolean;
  v_row record;
  v_count integer;
  v_names text[];
  v_bounds record;
  v_next timestamptz;
  v_hours numeric;
  v_col record;
  v_daily_sig constant text := 'public.ensure_daily_register_context()';
  v_guard_sig constant text := 'public.register_sessions_guard_daily_immutable()';
begin
  -- ==========================================================================
  -- A1. The two new columns: nullable, no default, right types.
  -- ==========================================================================
  for v_row in
    select * from (values ('business_date', 'date'), ('business_timezone', 'text'))
      as x(col, typ)
  loop
    select is_nullable, data_type, coalesce(column_default, '') as def
    into v_col
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'register_sessions'
      and column_name = v_row.col;

    if not found then
      raise exception 'CP2b: register_sessions.% was not added.', v_row.col;
    end if;

    if v_col.is_nullable <> 'YES' then
      raise exception 'CP2b: register_sessions.% must be nullable -- every existing row is legacy.', v_row.col;
    end if;

    if v_col.def <> '' then
      raise exception 'CP2b: register_sessions.% has default %; a default would reclassify history.',
        v_row.col, v_col.def;
    end if;

    if v_col.data_type <> v_row.typ then
      raise exception 'CP2b: register_sessions.% is %, expected %.', v_row.col, v_col.data_type, v_row.typ;
    end if;
  end loop;

  -- ==========================================================================
  -- A2. The two physical NOT NULLs are relaxed, and NOTHING ELSE is.
  -- ==========================================================================
  for v_row in
    select * from (values
      ('opened_by_employee_id', 'YES'),
      ('open_request_id',       'YES'),
      ('paired_device_id',      'NO'),
      ('opened_at',             'NO'),
      ('opening_cash',          'NO'),
      ('id',                    'NO')
    ) as x(col, nullable)
  loop
    select is_nullable into v_text
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'register_sessions'
      and column_name = v_row.col;

    if v_text is distinct from v_row.nullable then
      raise exception 'CP2b: register_sessions.% nullability is %, expected %.',
        v_row.col, v_text, v_row.nullable;
    end if;
  end loop;

  -- ==========================================================================
  -- A3. The CHECK constraints on register_sessions are exactly the approved set.
  -- register_sessions_closed_state is GONE (its rule now lives, conditioned on
  -- mode, inside register_sessions_legacy_shape); the three opening_cash rules
  -- and closed_after_opened are untouched.
  -- ==========================================================================
  select array_agg(c.conname::text order by c.conname)
  into v_names
  from pg_constraint c
  where c.conrelid = 'public.register_sessions'::regclass
    and c.contype = 'c';

  if v_names is distinct from array[
    'register_sessions_closed_after_opened',
    'register_sessions_daily_shape',
    'register_sessions_legacy_shape',
    'register_sessions_opening_cash_finite',
    'register_sessions_opening_cash_nonnegative',
    'register_sessions_opening_cash_scale'
  ] then
    raise exception 'CP2b: register_sessions CHECK constraints are %', v_names;
  end if;

  select pg_get_constraintdef(c.oid) into v_expr_legacy
  from pg_constraint c
  where c.conrelid = 'public.register_sessions'::regclass
    and c.conname = 'register_sessions_legacy_shape';

  select pg_get_constraintdef(c.oid) into v_expr_daily
  from pg_constraint c
  where c.conrelid = 'public.register_sessions'::regclass
    and c.conname = 'register_sessions_daily_shape';

  v_expr_legacy := regexp_replace(v_expr_legacy, '^CHECK\s*\((.*)\)\s*$', '\1');
  v_expr_daily  := regexp_replace(v_expr_daily,  '^CHECK\s*\((.*)\)\s*$', '\1');

  -- ==========================================================================
  -- A4. BOTH constraints, EVALUATED, on every row shape that matters.
  --
  -- A row is accepted only when both hold, which is what the table does. The
  -- legacy cases are the Feature 1B rules restated: relaxing the NOT NULLs must
  -- not have let a legacy row lose its opener, its request id, or its
  -- closed_at / closed_by biconditional.
  -- ==========================================================================
  for v_row in
    select * from (values
      -- label                         bdate         btz        opener  closer  req    cash     closed  accepted
      ('legacy open',                  null::date,   null::text, 'a',   null,   'r',   '125.50', null::text, true),
      ('legacy closed',                null,         null,       'a',   'b',    'r',   '125.50', 't1',       true),
      ('legacy zero cash',             null,         null,       'a',   null,   'r',   '0',      null,       true),
      ('legacy without an opener',     null,         null,       null,  null,   'r',   '10',     null,       false),
      ('legacy without a request id',  null,         null,       'a',   null,   null,  '10',     null,       false),
      ('legacy closed with no closer', null,         null,       'a',   null,   'r',   '10',     't1',       false),
      ('legacy closer with no close',  null,         null,       'a',   'b',    'r',   '10',     null,       false),
      ('legacy carrying a timezone',   null,         'America/New_York', 'a', null, 'r','10',     null,       false),
      ('daily',                        '2026-09-18', 'America/New_York', null, null, null,'0',    't1',       true),
      ('daily without a timezone',     '2026-09-18', null,       null,  null,   null,  '0',      't1',        false),
      ('daily with an opener',         '2026-09-18', 'America/New_York', 'a', null, null,'0',     't1',       false),
      ('daily with a closer',          '2026-09-18', 'America/New_York', null,'b',  null,'0',     't1',       false),
      ('daily with a request id',      '2026-09-18', 'America/New_York', null,null, 'r', '0',     't1',       false),
      ('daily with opening cash',      '2026-09-18', 'America/New_York', null,null, null,'0.01',  't1',       false),
      ('daily left open',              '2026-09-18', 'America/New_York', null,null, null,'0',     null,       false)
    ) as x(label, bdate, btz, opener, closer, req, cash, closed, accepted)
  loop
    begin
      execute format(
        'select (%s) and (%s) from ('
        '  select $1::date as business_date, $2::text as business_timezone,'
        '         $3::uuid as opened_by_employee_id, $4::uuid as closed_by_employee_id,'
        '         $5::uuid as open_request_id, $6::numeric as opening_cash,'
        '         $7::timestamptz as closed_at, timestamptz ''2026-01-01 00:00:00+00'' as opened_at'
        ') as register_sessions',
        v_expr_legacy, v_expr_daily)
      into v_ok
      using v_row.bdate,
            v_row.btz,
            case v_row.opener when 'a' then '00000000-0000-0000-0000-00000000000a'::uuid end,
            case v_row.closer when 'b' then '00000000-0000-0000-0000-00000000000b'::uuid end,
            case v_row.req    when 'r' then '00000000-0000-0000-0000-00000000000c'::uuid end,
            v_row.cash::numeric,
            case v_row.closed when 't1' then timestamptz '2026-01-02 00:00:00+00' end;
    exception
      when others then
        v_ok := false;
    end;

    if v_ok is distinct from v_row.accepted then
      raise exception 'CP2b: conditional integrity % "%"',
        case when v_ok then 'accepts' else 'refuses' end, v_row.label;
    end if;
  end loop;

  -- ==========================================================================
  -- A5. The DAILY uniqueness index: partial, on the right columns, on the right
  -- predicate. Partial is load-bearing -- legacy rows must not be in it at all.
  -- ==========================================================================
  select indexdef into v_text
  from pg_indexes
  where schemaname = 'public'
    and tablename = 'register_sessions'
    and indexname = 'register_sessions_one_daily_per_device_date';

  if v_text is null then
    raise exception 'CP2b: register_sessions_one_daily_per_device_date does not exist.';
  end if;

  if v_text !~ 'CREATE UNIQUE INDEX'
     or v_text !~ '\(paired_device_id, business_date\)'
     or v_text !~ 'WHERE \(business_date IS NOT NULL\)' then
    raise exception 'CP2b: the daily uniqueness index is %', v_text;
  end if;

  -- And the Feature 1B one-open index is untouched, still partial on
  -- closed_at is null -- which is why a DAILY row is not in it.
  select indexdef into v_text
  from pg_indexes
  where schemaname = 'public'
    and tablename = 'register_sessions'
    and indexname = 'register_sessions_one_open_per_device';

  if v_text is null or v_text !~ 'WHERE \(closed_at IS NULL\)' then
    raise exception 'CP2b: register_sessions_one_open_per_device changed: %', v_text;
  end if;

  -- ==========================================================================
  -- A6. The immutability trigger, and its WHEN clause.
  --
  -- The WHEN clause is what keeps this narrow: without it the function would
  -- run on every legacy close, and closing a drawer period would raise.
  -- ==========================================================================
  select pg_get_triggerdef(t.oid) into v_text
  from pg_trigger t
  where t.tgrelid = 'public.register_sessions'::regclass
    and t.tgname = 'register_sessions_guard_daily_immutable'
    and not t.tgisinternal;

  if v_text is null then
    raise exception 'CP2b: the daily immutability trigger does not exist.';
  end if;

  if v_text !~ 'BEFORE UPDATE'
     or v_text !~ 'FOR EACH ROW'
     or v_text !~ 'WHEN \(+old\.business_date IS NOT NULL\)+' then
    raise exception 'CP2b: the daily immutability trigger is %', v_text;
  end if;

  -- register_sessions carries exactly one trigger, the one added here.
  select array_agg(t.tgname::text order by t.tgname)
  into v_names
  from pg_trigger t
  where t.tgrelid = 'public.register_sessions'::regclass
    and not t.tgisinternal;

  if v_names is distinct from array['register_sessions_guard_daily_immutable'] then
    raise exception 'CP2b: register_sessions triggers are %', v_names;
  end if;

  -- ==========================================================================
  -- A7. The calendar, evaluated. A day is whatever the zone says it is.
  -- ==========================================================================
  for v_row in
    select * from (values
      ('ordinary day',    date '2026-09-18', 24.0),
      ('spring forward',  date '2026-03-08', 23.0),
      ('fall back',       date '2026-11-01', 25.0),
      ('year boundary',   date '2026-12-31', 24.0)
    ) as x(label, d, hours)
  loop
    select b.starts_at, b.ends_at into v_bounds
    from public.business_day_bounds(v_row.d, 'America/New_York') b;

    if not found then
      raise exception 'CP2b: no bounds for %', v_row.label;
    end if;

    v_hours := extract(epoch from (v_bounds.ends_at - v_bounds.starts_at)) / 3600.0;

    if v_hours <> v_row.hours then
      raise exception 'CP2b: % is % hours, expected %', v_row.label, v_hours, v_row.hours;
    end if;

    -- The endpoint is local midnight of the NEXT LOCAL DATE, not opened_at
    -- plus 24 hours. On the two DST days those differ, which is the whole
    -- reason this row's closed_at is computed rather than derived.
    if (v_bounds.starts_at + interval '24 hours' = v_bounds.ends_at) <> (v_row.hours = 24.0) then
      raise exception 'CP2b: % was computed as a 24-hour offset.', v_row.label;
    end if;

    -- Half-open and contiguous: the next day begins exactly where this one ends.
    select b.starts_at into v_next
    from public.business_day_bounds(v_row.d + 1, 'America/New_York') b;

    if v_next <> v_bounds.ends_at then
      raise exception 'CP2b: % does not abut the next day.', v_row.label;
    end if;
  end loop;

  -- ==========================================================================
  -- A8. ensure_daily_register_context: shape and security posture.
  -- ==========================================================================
  select pg_get_function_identity_arguments(p.oid) into v_text
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'ensure_daily_register_context';

  if v_text is null then
    raise exception 'CP2b: ensure_daily_register_context does not exist.';
  end if;

  -- ZERO ARGUMENTS. Any argument at all would be a client authority claim.
  if v_text <> '' then
    raise exception 'CP2b: ensure_daily_register_context takes arguments (%); it must take none.', v_text;
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'ensure_daily_register_context'
      and p.prosecdef
      and p.proconfig @> array['search_path=public, pg_catalog, pg_temp']
  ) then
    raise exception 'CP2b: ensure_daily_register_context is not SECURITY DEFINER with a locked search_path.';
  end if;

  -- EFFECTIVE privileges, not ACL text. authenticated and no one else.
  if has_function_privilege('public', v_daily_sig, 'EXECUTE') then
    raise exception 'CP2b: PUBLIC can execute ensure_daily_register_context.';
  end if;

  foreach v_role in array array['anon', 'service_role']
  loop
    if has_function_privilege(v_role, v_daily_sig, 'EXECUTE') then
      raise exception 'CP2b: % can execute ensure_daily_register_context.', v_role;
    end if;
  end loop;

  if not has_function_privilege('authenticated', v_daily_sig, 'EXECUTE') then
    raise exception 'CP2b: authenticated cannot execute ensure_daily_register_context.';
  end if;

  -- The trigger function is a trigger body, not an RPC: nobody holds EXECUTE,
  -- and it needs no elevation because it reads nothing.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'register_sessions_guard_daily_immutable'
      and p.prosecdef
  ) then
    raise exception 'CP2b: the daily guard is SECURITY DEFINER but needs no elevated privilege.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'register_sessions_guard_daily_immutable'
      and p.proconfig @> array['search_path=public, pg_catalog, pg_temp']
  ) then
    raise exception 'CP2b: the daily guard does not pin its search_path.';
  end if;

  if has_function_privilege('public', v_guard_sig, 'EXECUTE') then
    raise exception 'CP2b: PUBLIC can execute the daily guard.';
  end if;

  foreach v_role in array array['anon', 'authenticated', 'service_role']
  loop
    if has_function_privilege(v_role, v_guard_sig, 'EXECUTE') then
      raise exception 'CP2b: % can execute the daily guard.', v_role;
    end if;
  end loop;

  -- ==========================================================================
  -- A9. No new client table access anywhere, and register_sessions in
  -- particular is still zero-grant, RLS-on, zero-policy.
  -- ==========================================================================
  if exists (
    select 1
    from cp2b_priv_baseline b
    join (
      select r.rolname, t.relname as tablename, p.priv,
             has_table_privilege(r.rolname, t.oid, p.priv) as held
      from (values ('anon'), ('authenticated'), ('service_role')) as r(rolname)
      cross join (
        select c.oid, c.relname
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
      ) as t
      cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
                         ('REFERENCES'), ('TRIGGER')) as p(priv)
    ) a
      on a.rolname = b.rolname and a.tablename = b.tablename and a.priv = b.priv
    where a.held is distinct from b.held
  ) then
    raise exception 'CP2b: a table privilege changed.';
  end if;

  foreach v_role in array array['anon', 'authenticated', 'service_role']
  loop
    foreach v_text in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE']
    loop
      if has_table_privilege(v_role, 'public.register_sessions', v_text) then
        raise exception 'CP2b: % holds % on register_sessions.', v_role, v_text;
      end if;
    end loop;
  end loop;

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'register_sessions' and c.relrowsecurity
  ) then
    raise exception 'CP2b: row level security is off on register_sessions.';
  end if;

  select count(*) into v_count
  from pg_policies where schemaname = 'public' and tablename = 'register_sessions';

  if v_count <> 0 then
    raise exception 'CP2b: register_sessions grew % policies.', v_count;
  end if;

  -- ==========================================================================
  -- A10. Every pre-existing function is byte-identical, including all four
  -- sale functions, complete_sale_v5, and all three legacy register RPCs.
  -- ==========================================================================
  if exists (
    select 1
    from cp2b_proc_baseline b
    join pg_proc p on p.oid = b.fn_oid
    where md5(pg_get_functiondef(p.oid)) is distinct from b.body
       or p.prosecdef is distinct from b.prosecdef
       or p.provolatile::text is distinct from b.volatile
       or coalesce(p.proconfig, array[]::text[]) is distinct from b.config
       or coalesce(p.proacl::text, 'default') is distinct from b.acl
  ) then
    select string_agg(b.proname || '(' || b.args || ')', ', ')
    into v_text
    from cp2b_proc_baseline b
    join pg_proc p on p.oid = b.fn_oid
    where md5(pg_get_functiondef(p.oid)) is distinct from b.body
       or p.prosecdef is distinct from b.prosecdef
       or p.provolatile::text is distinct from b.volatile
       or coalesce(p.proconfig, array[]::text[]) is distinct from b.config
       or coalesce(p.proacl::text, 'default') is distinct from b.acl;

    raise exception 'CP2b: pre-existing functions were modified: %', v_text;
  end if;

  if exists (select 1 from cp2b_proc_baseline b
             where not exists (select 1 from pg_proc p where p.oid = b.fn_oid)) then
    raise exception 'CP2b: a pre-existing function was dropped.';
  end if;

  -- Named explicitly, because these four are the ones whose behaviour this
  -- checkpoint is claiming it did not touch.
  foreach v_text in array array[
    'public.open_register_session(uuid,numeric)',
    'public.get_current_register_session()',
    'public.close_register_session(uuid)',
    'public.complete_sale_v5(text,numeric,jsonb,uuid,timestamptz,text,uuid,uuid)'
  ]
  loop
    if not exists (
      select 1 from cp2b_proc_baseline b
      where b.fn_oid = v_text::regprocedure::oid
        and b.body = md5(pg_get_functiondef(v_text::regprocedure::oid))
    ) then
      raise exception 'CP2b: % is not byte-identical to its pre-migration definition.', v_text;
    end if;
  end loop;

  -- ==========================================================================
  -- A11. Policies and RLS across the whole schema are unchanged.
  -- ==========================================================================
  if exists (
    select 1 from cp2b_pol_baseline b
    full outer join (
      select tablename, policyname, cmd, qual, with_check, roles::text as roles
      from pg_policies where schemaname = 'public'
    ) a on a.tablename = b.tablename and a.policyname = b.policyname
    where a.policyname is null
       or b.policyname is null
       or a.cmd is distinct from b.cmd
       or a.qual is distinct from b.qual
       or a.with_check is distinct from b.with_check
       or a.roles is distinct from b.roles
  ) then
    raise exception 'CP2b: an RLS policy changed.';
  end if;

  if exists (
    select 1 from cp2b_rls_baseline b
    join pg_class c on c.relname = b.relname
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    where c.relrowsecurity is distinct from b.relrowsecurity
       or c.relforcerowsecurity is distinct from b.relforcerowsecurity
  ) then
    raise exception 'CP2b: row level security changed on a table.';
  end if;

  -- ==========================================================================
  -- A12. NO BACKFILL, and no row touched anywhere that matters.
  -- ==========================================================================
  if exists (
    select 1 from cp2b_row_baseline b
    where b.registers is distinct from (select count(*) from public.register_sessions)
       or b.orders is distinct from (select count(*) from public.orders)
  ) then
    raise exception 'CP2b: a row was created or destroyed.';
  end if;

  select count(*) into v_count
  from public.register_sessions
  where business_date is not null or business_timezone is not null;

  if v_count <> 0 then
    raise exception 'CP2b: % existing register sessions were reclassified as daily.', v_count;
  end if;

  select count(*) into v_count
  from public.orders o
  where o.register_session_id is not null
    and not exists (select 1 from public.register_sessions r
                    where r.id = o.register_session_id
                      and r.paired_device_id = o.paired_device_id);

  if v_count <> 0 then
    raise exception 'CP2b: % orders lost their register/device attribution.', v_count;
  end if;

  -- ==========================================================================
  -- A13. Constraints and indexes on every OTHER table are untouched. Only
  -- register_sessions was allowed to change here.
  -- ==========================================================================
  if exists (
    select 1 from cp2b_con_baseline b
    full outer join (
      select c.conrelid::regclass::text as tbl, c.conname, c.contype::text as contype,
             pg_get_constraintdef(c.oid) as def
      from pg_constraint c
      join pg_namespace n on n.oid = c.connamespace
      where n.nspname = 'public' and c.contype in ('c', 'f', 'p', 'u', 'x')
    ) a on a.tbl = b.tbl and a.conname = b.conname
    -- regclass::text renders unqualified when public is on the search_path, so the
      -- exclusion is written the same way the baseline rendered it rather than as
      -- a schema-qualified literal that would never match.
      where coalesce(a.tbl, b.tbl) <> 'public.register_sessions'::regclass::text
      and (a.conname is null or b.conname is null or a.def is distinct from b.def)
  ) then
    raise exception 'CP2b: a constraint changed on a table other than register_sessions.';
  end if;

  if exists (
    select 1 from cp2b_idx_baseline b
    full outer join (
      select tablename, indexname, indexdef from pg_indexes where schemaname = 'public'
    ) a on a.tablename = b.tablename and a.indexname = b.indexname
    where coalesce(a.tablename, b.tablename) <> 'register_sessions'
      and (a.indexname is null or b.indexname is null or a.indexdef is distinct from b.indexdef)
  ) then
    raise exception 'CP2b: an index changed on a table other than register_sessions.';
  end if;

  -- Only register_sessions gained columns, and only those two.
  if exists (
    select 1 from (
      select table_name, column_name, ordinal_position, data_type,
             is_nullable, coalesce(column_default, '') as column_default
      from information_schema.columns where table_schema = 'public'
    ) a
    full outer join cp2b_col_baseline b
      on a.table_name = b.table_name and a.column_name = b.column_name
    where coalesce(a.table_name, b.table_name) <> 'register_sessions'
      and (a.column_name is null or b.column_name is null
           or a.data_type is distinct from b.data_type
           or a.is_nullable is distinct from b.is_nullable
           or a.column_default is distinct from b.column_default)
  ) then
    raise exception 'CP2b: a column changed on a table other than register_sessions.';
  end if;

  raise notice 'CP2b verified: daily register context, conditional integrity, and an unchanged Feature 1B.';
end;
$do$;

drop table cp2b_proc_baseline;
drop table cp2b_pol_baseline;
drop table cp2b_priv_baseline;
drop table cp2b_rls_baseline;
drop table cp2b_con_baseline;
drop table cp2b_idx_baseline;
drop table cp2b_col_baseline;
drop table cp2b_row_baseline;
