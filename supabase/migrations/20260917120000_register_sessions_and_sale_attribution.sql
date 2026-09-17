-- v1.3 Feature 1B-SERVER — Register Sessions and Sale Attribution.
--
-- FORWARD MIGRATION, ADDITIVE ONLY. 20260914120000, 20260916120000 and
-- 20260916130000 are applied to staging and immutable; nothing here redefines
-- any of their objects. This file creates:
--
--   * public.register_sessions                 (new table, RPC-only)
--   * orders.employee_id / paired_device_id / register_session_id
--                                              (new nullable columns)
--   * open_register_session(uuid, numeric)
--   * get_current_register_session()
--   * close_register_session(uuid)
--   * complete_sale_v5(...)                    (NEW, device-only)
--
-- It does NOT redefine complete_sale, complete_sale_v2, complete_sale_v3 or
-- complete_sale_v4, and the verification block proves every pre-existing
-- function is byte-identical afterwards. Those four keep writing orders with
-- all three attribution columns NULL, because their contracts know nothing
-- about employees or registers.
--
-- It is NOT applied automatically -- review, then apply manually, as ONE SQL
-- Editor submission (one session): the baseline temporary tables below are
-- compared against at the end.
--
-- ----------------------------------------------------------------------------
-- THREE DIFFERENT THINGS, KEPT SEPARATE
-- ----------------------------------------------------------------------------
--   employee POS session  (Feature 1A)  who is signed in at a till
--   register session      (this file)   one drawer period of one till
--   time-clock entry      (future)      hours worked -- not modelled here
--
-- Signing in, switching or signing out an employee never opens, closes or
-- otherwise touches a register session, and closing a register never ends an
-- employee's POS session.
--
-- The register identity is paired_devices.id. There is no registers table.
--
-- ----------------------------------------------------------------------------
-- HISTORY IS NEVER DELETED BY A FOREIGN KEY
-- ----------------------------------------------------------------------------
-- Every new foreign key is ON DELETE NO ACTION. No product path deletes a
-- project, a paired device or an employee: authenticated holds no DELETE on
-- projects (20260803230000), SELECT only on paired_devices, and nothing at all
-- on employees (20260914120000); revocation, unpair and deactivation are state
-- changes. The only physical deletes are administrative cascades, and a
-- cascade that would orphan an order's or a register's attribution now fails
-- instead of erasing or nulling it -- the same choice, for the same reason, as
-- orders.build_job_id in 20260831120000. CASCADE could delete financial
-- history; SET NULL would silently destroy trustworthy attribution.
--
-- ----------------------------------------------------------------------------
-- LOCK ORDER (every function below follows it; nothing takes it in reverse)
-- ----------------------------------------------------------------------------
--   1. paired_devices row        sale: FOR SHARE   open/close: FOR UPDATE
--   2. projects row              sale only: FOR UPDATE (unchanged from v4)
--   3. employee_pos_sessions row FOR SHARE
--   4. employees row             FOR SHARE (conflicts with set_employee_active)
--   5. register_sessions row     sale: FOR SHARE   close: FOR UPDATE
--   6. v4's counter, order, item, inventory and project writes, unchanged
--
-- No existing function locks projects and then paired_devices, or the
-- reverse: every device RPC (employee_login, revoke, unpair, config offer and
-- apply) locks or updates only the device row, and every sale function before
-- v5 reads the device row unlocked.
--
-- ----------------------------------------------------------------------------
-- NOT IN THIS FILE
-- ----------------------------------------------------------------------------
-- Cash movements, expected/counted cash, variance, financial close, clock,
-- barcode, refunds, employee snapshots, attribution_source, any runtime
-- cutover. No existing client calls anything created here.

-- ----------------------------------------------------------------------------
-- 0. Self-capturing baselines, recorded BEFORE any DDL.
-- ----------------------------------------------------------------------------
create temporary table f1b_proc_baseline as
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

create temporary table f1b_pol_baseline as
select tablename, policyname, cmd, qual, with_check, roles::text as roles
from pg_policies
where schemaname = 'public';

create temporary table f1b_priv_baseline as
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

create temporary table f1b_rls_baseline as
select c.relname, c.relrowsecurity, c.relforcerowsecurity
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r';

create temporary table f1b_trg_baseline as
select c.relname, t.tgname, t.tgtype, t.tgenabled, pr.proname
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_proc pr on pr.oid = t.tgfoid
where n.nspname = 'public' and not t.tgisinternal;

create temporary table f1b_idx_baseline as
select tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public';

create temporary table f1b_con_baseline as
select c.conrelid::regclass::text as tbl, c.conname, c.contype::text as contype,
       pg_get_constraintdef(c.oid) as def
from pg_constraint c
join pg_namespace n on n.oid = c.connamespace
where n.nspname = 'public'
  and c.contype in ('c', 'f', 'p', 'u', 'x');

create temporary table f1b_col_baseline as
select table_name, column_name, ordinal_position, data_type,
       is_nullable, coalesce(column_default, '') as column_default
from information_schema.columns
where table_schema = 'public';

create temporary table f1b_row_baseline as
select (select count(*) from public.orders) as orders,
       (select coalesce(md5(string_agg(md5((to_jsonb(o)
                  - array['employee_id', 'paired_device_id', 'register_session_id'])::text),
                  '|' order by o.id::text)), 'empty')
        from public.orders o) as orders_fp,
       (select count(*) from public.order_items) as order_items,
       (select coalesce(md5(string_agg(md5(i::text), '|' order by i.id::text)), 'empty')
        from public.order_items i) as order_items_fp,
       (select count(*) from public.inventory_transactions) as inventory_transactions,
       (select count(*) from public.project_order_counters) as counters,
       (select coalesce(md5(string_agg(md5(c::text), '|' order by c.project_id::text)), 'empty')
        from public.project_order_counters c) as counters_fp,
       (select coalesce(md5(string_agg(md5(p::text), '|' order by p.id::text)), 'empty')
        from public.projects p) as projects_fp,
       (select coalesce(md5(string_agg(md5(d::text), '|' order by d.id::text)), 'empty')
        from public.paired_devices d) as devices_fp,
       (select coalesce(md5(string_agg(md5(e::text), '|' order by e.id::text)), 'empty')
        from public.employees e) as employees_fp,
       (select coalesce(md5(string_agg(md5(s::text), '|' order by s.id::text)), 'empty')
        from public.employee_pos_sessions s) as sessions_fp;

-- ----------------------------------------------------------------------------
-- 1. register_sessions
--
-- One drawer period of one till. Opened and closed by the device itself,
-- through the RPCs below, by whichever employee is signed in there.
--
-- NO project_id: paired_device_id resolves the project through a column the
-- immutability trigger freezes (paired_devices.project_id), and the NO ACTION
-- foreign key means that device row cannot disappear while a register session
-- names it. A stored copy could only ever drift from the authoritative one --
-- the same reasoning 20260914120000 applied to employee_pos_sessions.
--
-- NO employee_pos_session_id, close_reason, owner_id or any cash-control
-- column: primitive lifecycle only. Expected cash, counted cash, variance and
-- cash movements belong to Cash Control.
--
-- opening_cash CHECKS. numeric(12,2) matches every money column in orders, but
-- a typmod ROUNDS on assignment -- 12.345 would be stored as 12.35 -- so the
-- typmod is not the scale guard. open_register_session rejects the original
-- argument before it is ever assigned. The scale CHECK below cannot catch a
-- rounded value either; it is defence in depth that keeps the rule if the
-- column type is ever relaxed. NaN can be stored in a constrained numeric
-- (and sorts above every number, so >= 0 does not exclude it), hence the
-- explicit finiteness CHECK.
-- ----------------------------------------------------------------------------
create table public.register_sessions (
  id uuid primary key default gen_random_uuid(),

  paired_device_id uuid not null,
  opened_by_employee_id uuid not null,
  opened_at timestamptz not null,
  opening_cash numeric(12,2) not null,
  open_request_id uuid not null,
  closed_at timestamptz,
  closed_by_employee_id uuid,

  constraint register_sessions_paired_device_id_fkey
    foreign key (paired_device_id)
    references public.paired_devices (id) on delete no action,

  constraint register_sessions_opened_by_employee_id_fkey
    foreign key (opened_by_employee_id)
    references public.employees (id) on delete no action,

  constraint register_sessions_closed_by_employee_id_fkey
    foreign key (closed_by_employee_id)
    references public.employees (id) on delete no action,

  constraint register_sessions_opening_cash_nonnegative
    check (opening_cash >= 0),

  constraint register_sessions_opening_cash_finite
    check (opening_cash <> 'NaN'::numeric
           and opening_cash <> 'Infinity'::numeric
           and opening_cash <> '-Infinity'::numeric),

  constraint register_sessions_opening_cash_scale
    check (opening_cash = trunc(opening_cash, 2)),

  -- Biconditional: a closed session always says who closed it, and an open
  -- one never does.
  constraint register_sessions_closed_state
    check ((closed_at is null) = (closed_by_employee_id is null)),

  constraint register_sessions_closed_after_opened
    check (closed_at is null or closed_at >= opened_at),

  -- Open-request idempotency, per till.
  constraint register_sessions_device_request_key
    unique (paired_device_id, open_request_id),

  -- The target of the orders composite foreign key: an order can only name a
  -- register session that belongs to the SAME paired device it names.
  constraint register_sessions_id_device_key
    unique (id, paired_device_id)
);

comment on table public.register_sessions is
  'v1.3 Feature 1B -- one drawer period of one paired device (the register). '
  'Not an employee POS session and not a time clock. No role holds any privilege on '
  'this table; all access is through SECURITY DEFINER RPCs.';

comment on column public.register_sessions.opening_cash is
  'Cash in the drawer when the session opened, exact to the cent. Validated by '
  'open_register_session BEFORE assignment, so an over-precise value is refused, '
  'never rounded.';

-- THE INVARIANT: at most ONE open register session per paired device. The RPCs
-- serialize on the device row; this index is the backstop.
create unique index register_sessions_one_open_per_device
  on public.register_sessions using btree (paired_device_id)
  where closed_at is null;

-- ----------------------------------------------------------------------------
-- 2. Row level security and privileges -- the Feature 1A posture.
--
-- Supabase's ALTER DEFAULT PRIVILEGES would give a new table ALL to anon,
-- authenticated and service_role. Revoke everything, grant nothing, and enable
-- RLS with zero policies so even a future accidental grant yields no rows.
-- ----------------------------------------------------------------------------
alter table public.register_sessions enable row level security;

revoke all privileges on table public.register_sessions from public;
revoke all privileges on table public.register_sessions from anon;
revoke all privileges on table public.register_sessions from authenticated;
revoke all privileges on table public.register_sessions from service_role;

-- ----------------------------------------------------------------------------
-- 3. Sale attribution columns on orders.
--
-- NULLABLE, NO DEFAULT, NO BACKFILL. Every existing order stays NULL: nothing
-- recorded which till or employee took it, and build_job_id is shared by every
-- device on a build, so no honest value can be derived. complete_sale through
-- complete_sale_v4 do not name these columns and keep writing NULL.
-- Nullable is the v1.3 compatibility rollout posture, not a permanent promise.
--
-- REGISTER/DEVICE CONSISTENCY is structural: the composite foreign key makes an
-- order's register session belong to the order's own paired device. A MATCH
-- SIMPLE composite key skips the check when ANY column is null, so the CHECK
-- forbids a register session without a device. A device without a register
-- session (and with or without an employee) is valid: partial offline
-- attribution.
-- ----------------------------------------------------------------------------
alter table public.orders
  add column employee_id uuid,
  add column paired_device_id uuid,
  add column register_session_id uuid,
  add constraint orders_employee_id_fkey
    foreign key (employee_id)
    references public.employees (id) on delete no action,
  add constraint orders_paired_device_id_fkey
    foreign key (paired_device_id)
    references public.paired_devices (id) on delete no action,
  add constraint orders_register_session_device_fkey
    foreign key (register_session_id, paired_device_id)
    references public.register_sessions (id, paired_device_id) on delete no action,
  add constraint orders_register_session_requires_device
    check (register_session_id is null or paired_device_id is not null);

comment on column public.orders.employee_id is
  'v1.3 Feature 1B -- the employee who took this sale, derived by complete_sale_v5 '
  'from the server-side POS session. Null for every sale written by v1-v4, and for '
  'an offline sale whose historical claim did not validate. Never backfilled.';

comment on column public.orders.paired_device_id is
  'v1.3 Feature 1B -- the register (paired device) that took this sale, derived by '
  'complete_sale_v5 from the authenticated device. Null for every sale written by '
  'v1-v4. Never backfilled.';

comment on column public.orders.register_session_id is
  'v1.3 Feature 1B -- the register session this sale belongs to, derived by '
  'complete_sale_v5. Always a session of this order''s own paired device. Null for '
  'every sale written by v1-v4, and for an offline sale whose historical claim did '
  'not validate. Never backfilled.';

-- Reporting foundation, and the referencing-side index each NO ACTION check
-- needs. Partial: every pre-existing row is null and always will be.
create index orders_employee_created_idx
  on public.orders using btree (employee_id, created_at desc)
  where employee_id is not null;

create index orders_paired_device_created_idx
  on public.orders using btree (paired_device_id, created_at desc)
  where paired_device_id is not null;

create index orders_register_session_idx
  on public.orders using btree (register_session_id)
  where register_session_id is not null;

-- ----------------------------------------------------------------------------
-- 4. open_register_session
--
-- The client supplies a request id and an amount -- nothing else. Device,
-- project and employee are derived from auth.uid().
--
-- IDEMPOTENT ON (device, request id). The same request with the same amount
-- returns the ORIGINAL session -- even once it has been closed -- and never
-- opens another. The same request with a different amount is request_conflict.
-- A different request while a session is open is already_open.
--
-- A replay needs only a proven, active device: it creates nothing and answers
-- with what was stored. Opening a NEW session needs the signed-in employee.
-- ----------------------------------------------------------------------------
create or replace function public.open_register_session(
  p_request_id uuid,
  p_opening_cash numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  c_max_money constant numeric := 9999999999.99;
  v_caller uuid;
  v_device record;
  v_employee_session record;
  v_has_employee boolean;
  v_register record;
begin
  v_caller := auth.uid();

  if v_caller is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  if p_request_id is null
     or p_request_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return jsonb_build_object('ok', false, 'error', 'invalid_request');
  end if;

  -- EXACT MONEY, checked on the ORIGINAL argument before it is assigned to any
  -- numeric(12,2) -- which would round it. One rule per statement, so no
  -- evaluation order can matter, and specials are refused before any
  -- arithmetic sees them.
  if p_opening_cash is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_opening_cash');
  end if;

  if p_opening_cash::text in ('NaN', 'Infinity', '-Infinity') then
    return jsonb_build_object('ok', false, 'error', 'invalid_opening_cash');
  end if;

  if p_opening_cash < 0 then
    return jsonb_build_object('ok', false, 'error', 'invalid_opening_cash');
  end if;

  -- More than two decimal places of VALUE. 12.340 is 12.34 and is accepted;
  -- 12.345 would need rounding and is refused.
  if p_opening_cash <> round(p_opening_cash, 2) then
    return jsonb_build_object('ok', false, 'error', 'invalid_opening_cash');
  end if;

  if p_opening_cash > c_max_money then
    return jsonb_build_object('ok', false, 'error', 'invalid_opening_cash');
  end if;

  -- Lock order step 1: the device, FOR UPDATE. Serializes every open and close
  -- on this till, and conflicts with a sale's FOR SHARE.
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

  -- Steps 3-4: the signed-in employee, FOR SHARE on the session and the
  -- employee, so neither logout nor deactivation can pass through this
  -- decision. Recorded now, required only for a NEW session below.
  select s.id, s.employee_id
  into v_employee_session
  from public.employee_pos_sessions s
  join public.employees e on e.id = s.employee_id
  where s.paired_device_id = v_device.id
    and s.ended_at is null
    and e.active
    and e.project_id = v_device.project_id
    and e.role in ('owner', 'manager', 'cashier')
  for share of s, e;

  v_has_employee := found;

  -- Step 5: replay.
  select r.id, r.opened_at, r.opened_by_employee_id, r.opening_cash,
         r.closed_at, r.closed_by_employee_id
  into v_register
  from public.register_sessions r
  where r.paired_device_id = v_device.id
    and r.open_request_id = p_request_id;

  if found then
    if v_register.opening_cash <> p_opening_cash then
      return jsonb_build_object('ok', false, 'error', 'request_conflict');
    end if;

    return jsonb_build_object(
      'ok', true,
      'replayed', true,
      'registerSession', jsonb_build_object(
        'registerSessionId', v_register.id,
        'openedAt', v_register.opened_at,
        'openedByEmployeeId', v_register.opened_by_employee_id,
        'openingCash', v_register.opening_cash::text,
        'closedAt', v_register.closed_at,
        'closedByEmployeeId', v_register.closed_by_employee_id
      )
    );
  end if;

  if not v_has_employee then
    return jsonb_build_object('ok', false, 'error', 'employee_session_required');
  end if;

  -- The device lock already excludes a concurrent open or close, so a plain
  -- read is authoritative here.
  select r.id, r.opened_at, r.opened_by_employee_id, r.opening_cash,
         r.closed_at, r.closed_by_employee_id
  into v_register
  from public.register_sessions r
  where r.paired_device_id = v_device.id
    and r.closed_at is null;

  if found then
    return jsonb_build_object(
      'ok', false,
      'error', 'already_open',
      'registerSession', jsonb_build_object(
        'registerSessionId', v_register.id,
        'openedAt', v_register.opened_at,
        'openedByEmployeeId', v_register.opened_by_employee_id,
        'openingCash', v_register.opening_cash::text,
        'closedAt', v_register.closed_at,
        'closedByEmployeeId', v_register.closed_by_employee_id
      )
    );
  end if;

  begin
    insert into public.register_sessions (
      paired_device_id, opened_by_employee_id, opened_at, opening_cash, open_request_id
    )
    values (
      v_device.id, v_employee_session.employee_id, clock_timestamp(), p_opening_cash, p_request_id
    )
    returning id, opened_at, opened_by_employee_id, opening_cash,
              closed_at, closed_by_employee_id
    into v_register;
  exception
    when unique_violation then
      -- Unreachable while the device lock is held; kept as the backstop for
      -- both unique rules. Nothing was written.
      return jsonb_build_object('ok', false, 'error', 'already_open');
  end;

  return jsonb_build_object(
    'ok', true,
    'replayed', false,
    'registerSession', jsonb_build_object(
      'registerSessionId', v_register.id,
      'openedAt', v_register.opened_at,
      'openedByEmployeeId', v_register.opened_by_employee_id,
      'openingCash', v_register.opening_cash::text,
      'closedAt', v_register.closed_at,
      'closedByEmployeeId', v_register.closed_by_employee_id
    )
  );
end;
$function$;

revoke all on function public.open_register_session(uuid, numeric) from public;
revoke all on function public.open_register_session(uuid, numeric) from anon;
revoke all on function public.open_register_session(uuid, numeric) from service_role;
grant execute on function public.open_register_session(uuid, numeric) to authenticated;

-- ----------------------------------------------------------------------------
-- 5. get_current_register_session
--
-- Zero arguments. The open session of the calling till, or null. Returns only
-- what a till needs to show and to expect at checkout: no device id, no
-- request id, no project id.
-- ----------------------------------------------------------------------------
create or replace function public.get_current_register_session()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller uuid;
  v_device record;
  v_register record;
begin
  v_caller := auth.uid();

  if v_caller is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  select d.id
  into v_device
  from public.paired_devices d
  where d.auth_user_id = v_caller
    and d.revoked_at is null
    and d.unpaired_at is null;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_paired');
  end if;

  select r.id, r.opened_at, r.opened_by_employee_id, r.opening_cash
  into v_register
  from public.register_sessions r
  where r.paired_device_id = v_device.id
    and r.closed_at is null;

  if not found then
    -- No open register is a successful answer, not an error.
    return jsonb_build_object('ok', true, 'registerSession', null);
  end if;

  return jsonb_build_object(
    'ok', true,
    'registerSession', jsonb_build_object(
      'registerSessionId', v_register.id,
      'openedAt', v_register.opened_at,
      'openedByEmployeeId', v_register.opened_by_employee_id,
      'openingCash', v_register.opening_cash::text,
      'closedAt', null::timestamptz,
      'closedByEmployeeId', null::uuid
    )
  );
end;
$function$;

revoke all on function public.get_current_register_session() from public;
revoke all on function public.get_current_register_session() from anon;
revoke all on function public.get_current_register_session() from service_role;
grant execute on function public.get_current_register_session() to authenticated;

-- ----------------------------------------------------------------------------
-- 6. close_register_session -- primitive lifecycle close.
--
-- The argument is a TARGET, not authority: the device is derived, the target
-- must belong to it, and the closer is whoever is signed in there. Sets
-- closed_at and closed_by_employee_id and nothing else -- no cash, no totals.
--
-- NATURALLY IDEMPOTENT, so there is no close request id: a target that is
-- already closed answers with its STORED state and is never rewritten, and a
-- retry naming an old session can never touch the newer one. Only the FIRST
-- close requires a signed-in employee; a completed close does not depend on
-- whoever is signed in now.
-- ----------------------------------------------------------------------------
create or replace function public.close_register_session(
  p_register_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller uuid;
  v_device record;
  v_employee_session record;
  v_has_employee boolean;
  v_register record;
begin
  v_caller := auth.uid();

  if v_caller is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  if p_register_session_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  -- Step 1: the device, FOR UPDATE -- excludes a concurrent sale's FOR SHARE,
  -- and every other open or close on this till.
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

  -- Steps 3-4, before the register row, keeping the global order. Required
  -- only for a first close below.
  select s.id, s.employee_id
  into v_employee_session
  from public.employee_pos_sessions s
  join public.employees e on e.id = s.employee_id
  where s.paired_device_id = v_device.id
    and s.ended_at is null
    and e.active
    and e.project_id = v_device.project_id
    and e.role in ('owner', 'manager', 'cashier')
  for share of s, e;

  v_has_employee := found;

  -- Step 5: the target, FOR UPDATE, and only if it is this till's. Another
  -- device's session is indistinguishable from one that does not exist.
  select r.id, r.opened_at, r.opened_by_employee_id, r.opening_cash,
         r.closed_at, r.closed_by_employee_id
  into v_register
  from public.register_sessions r
  where r.id = p_register_session_id
    and r.paired_device_id = v_device.id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if v_register.closed_at is null then
    if not v_has_employee then
      return jsonb_build_object('ok', false, 'error', 'employee_session_required');
    end if;

    update public.register_sessions r
    set closed_at = clock_timestamp(),
        closed_by_employee_id = v_employee_session.employee_id
    where r.id = v_register.id
      and r.closed_at is null
    returning r.id, r.opened_at, r.opened_by_employee_id, r.opening_cash,
              r.closed_at, r.closed_by_employee_id
    into v_register;

    return jsonb_build_object(
      'ok', true,
      'alreadyClosed', false,
      'registerSession', jsonb_build_object(
        'registerSessionId', v_register.id,
        'openedAt', v_register.opened_at,
        'openedByEmployeeId', v_register.opened_by_employee_id,
        'openingCash', v_register.opening_cash::text,
        'closedAt', v_register.closed_at,
        'closedByEmployeeId', v_register.closed_by_employee_id
      )
    );
  end if;

  -- Already closed: the stored state, unchanged.
  return jsonb_build_object(
    'ok', true,
    'alreadyClosed', true,
    'registerSession', jsonb_build_object(
      'registerSessionId', v_register.id,
      'openedAt', v_register.opened_at,
      'openedByEmployeeId', v_register.opened_by_employee_id,
      'openingCash', v_register.opening_cash::text,
      'closedAt', v_register.closed_at,
      'closedByEmployeeId', v_register.closed_by_employee_id
    )
  );
end;
$function$;

revoke all on function public.close_register_session(uuid) from public;
revoke all on function public.close_register_session(uuid) from anon;
revoke all on function public.close_register_session(uuid) from service_role;
grant execute on function public.close_register_session(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 7. complete_sale_v5 -- NEW, device-only.
--
-- The body is complete_sale_v4's CURRENT definition (20260913120000) with a
-- declared, test-verified set of edits and nothing else:
--
--   * no p_project_id parameter; the project is read from the caller's device
--     row, and every former p_project_id reference reads v_project_id;
--   * authorization resolves ONLY a paired device, locked FOR SHARE before the
--     project (owners stay on v3);
--   * section 6d derives the attribution for a NEW sale, after every v4
--     new-sale gate and before pricing;
--   * the INSERT stores it, and the payload returns the STORED attribution.
--
-- Pricing, tax, tip, modifiers, inventory, shortfall, receipt snapshot, line
-- order, occurred_at and its skew/age/revocation rules, the canonical hash, the
-- idempotency lookup and the unique_violation backstop are v4's, unchanged.
-- The hash does NOT include any identity, so a completed sale replays with its
-- stored attribution whoever is signed in now.
--
-- p_employee_pos_session_id and p_register_session_id:
--   online  (p_source 'online')          REQUIRED concurrency expectations,
--                                         compared with the locked server rows.
--   offline (p_source 'offline_queued')  optional historical CLAIMS, each
--                                         validated independently or stored NULL.
-- They are never copied into the order.
-- ----------------------------------------------------------------------------
create or replace function public.complete_sale_v5(
  p_payment_method text,
  p_tip_amount numeric,
  p_items jsonb,
  p_sale_request_id uuid,
  p_occurred_at timestamptz default null,
  p_source text default 'online',
  p_employee_pos_session_id uuid default null,
  p_register_session_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  c_max_money      constant numeric := 9999999999.99;
  c_max_unit_price constant numeric := 1000000.00;
  c_max_quantity   constant integer := 10000;
  c_max_items      constant integer := 200;
  c_max_stock      constant numeric := 1000000000;
  c_max_suffix     constant bigint  := 999999999999999;
  c_max_prefix_len constant integer := 32;

  -- Feature 24.5B — clock skew allowance for a device-reported sale time.
  -- FIVE MINUTES, matching OFFLINE_CLOCK_TOLERANCE_MS in
  -- lib/deviceOfflineCache.ts so the client and the server agree on what
  -- "close enough" means. Wide enough to absorb ordinary drift and an NTP
  -- correction; far too narrow to backdate a sale past a revocation.
  c_clock_skew     constant interval := interval '5 minutes';

  -- Feature 24.5B — the maximum age of a NEW offline sale.
  --
  -- SEVEN DAYS, the same number as OFFLINE_DEVICE_LEASE_MS in
  -- lib/deviceOfflineCache.ts. The client refuses to OPEN offline past that
  -- lease; without the same bound here the server would still accept a sale
  -- claiming to be from outside it, and the two halves of one owner-approved
  -- policy would disagree.
  --
  -- WHY THIS IS A SECURITY BOUND AND NOT HOUSEKEEPING: the pairing floor below
  -- is not sufficient on its own. A till paired months ago satisfies
  -- `occurred_at >= paired_at` for any date since, so without an age ceiling a
  -- device could backdate a sale created TODAY to a moment months ago — and
  -- slide it in front of a revoked_at set last week. The revocation window in
  -- 6c compares against occurred_at, so an unbounded past is an unbounded
  -- bypass of it. This closes that.
  c_offline_max_age constant interval := interval '7 days';

  v_caller        uuid;
  v_owner_id      uuid;
  v_is_owner      boolean;
  v_build_job_id  uuid;
  -- Feature 28C — the business identity and receipt settings to print this
  -- sale's receipt with, frozen at sale time. Set on the OWNER branch only: a
  -- device sale already records build_job_id, whose config_snapshot is
  -- immutable and holds the same two objects, so storing a second copy would
  -- create two answers to one question.
  v_receipt_snapshot jsonb;

  -- Feature 24.5B. NOTE the name: v_source is already taken by the pricing
  -- CONFIG below, which is a different thing entirely.
  v_sale_source   text;
  v_occurred_at   timestamptz;
  v_device_revoked_at timestamptz;
  -- Feature 25.1 — the device removed itself. Administrative, never temporal:
  -- this value is NEVER compared against occurred_at.
  v_device_unpaired_at timestamptz;
  v_device_paired_at  timestamptz;
  -- v1.3 Feature 1B — every identity below is DERIVED on the server. None of
  -- them is a parameter, and no parameter is ever copied into one.
  v_project_id    uuid;
  v_device_id     uuid;
  v_employee_id   uuid;
  v_register_session_id uuid;
  v_employee_session record;
  v_shortfall     integer;
  v_has_shortfall boolean := false;
  v_source        jsonb;
  v_price_items   jsonb;
  v_tax           jsonb;
  v_receipt       jsonb;

  v_config        jsonb;
  v_live_items    jsonb;

  v_method        text;
  v_tip_amount    numeric := 0;
  v_norm          jsonb := '[]'::jsonb;
  v_items_text    text;
  v_canonical     text;
  v_hash          text;

  v_order_id      uuid;
  v_existing      record;
  v_payload       jsonb;

  v_tax_enabled   boolean;
  v_tax_inclusive boolean;
  v_rate          numeric;

  v_lines         jsonb := '[]'::jsonb;
  v_item          jsonb;
  v_item_id       text;
  v_qty_num       numeric;
  v_quantity      integer;
  v_price_item    jsonb;
  v_live_item     jsonb;
  v_live_index    integer;
  v_item_name     text;
  v_unit_price    numeric;
  v_line_total    numeric;
  v_track         boolean;
  v_stock_num     numeric;
  v_stock_before  integer;
  v_stock_after   integer;

  v_subtotal      numeric := 0;
  v_tax_amount    numeric := 0;
  v_total_before_tip numeric := 0;
  v_total         numeric := 0;

  v_prefix        text;
  v_suffix        bigint;
  v_order_number  text;

  v_count         integer;
  v_distinct      integer;
  i               integer;

  -- Feature 18.1 — modifier state. Everything here is derived from the
  -- AUTHORIZED config; the request contributes identifiers only.
  c_max_mod_groups   constant integer := 10;
  c_max_mod_options  constant integer := 20;
  c_max_mod_selected constant integer := 50;

  v_mods          jsonb;
  v_mod_groups    jsonb;
  v_mod_sel       jsonb;
  v_mod_group     jsonb;
  v_mod_option    jsonb;
  v_mod_opt_id    text;
  v_group_id      text;
  v_group_found   boolean;
  v_option_found  boolean;
  v_mod_adjust    numeric;
  v_mod_total     numeric;
  v_mod_snapshot  jsonb;
  v_mod_count     integer;
  v_sel_count     integer;
  v_selected_total integer;
  v_line_identity text;
  v_mod_text      text;
  v_required_ok   boolean;
  j               integer;
  k               integer;
begin
  -- ==========================================================================
  -- 1. Caller and request shape.
  -- ==========================================================================
  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'Authentication required';
  end if;

  -- A client-generated request id is mandatory. There is deliberately no
  -- server-side fallback: a generated id would make every retry look like a new
  -- sale, which is the exact failure this parameter exists to prevent. The
  -- all-zero uuid is rejected as an obvious uninitialised placeholder. Version
  -- and variant nibbles are NOT checked — any distinct uuid is a valid key, and
  -- rejecting v1/v7 ids would break clients for no security benefit.
  if p_sale_request_id is null then
    raise exception 'A sale request ID is required';
  end if;
  if p_sale_request_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception 'A sale request ID is required';
  end if;

  if p_payment_method is null or p_payment_method not in ('cash', 'card') then
    raise exception 'Invalid payment method';
  end if;
  v_method := p_payment_method;

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

  -- Feature 18.1 — the v2 duplicate-itemId rule cannot survive verbatim: the
  -- same product with two different modifier selections is two legitimate
  -- lines. It is replaced by a duplicate-LINE rule in section 5, which
  -- compares the canonical (item + selection) identity and therefore keeps the
  -- exact property v2's rule protected — two requests that differ only in how
  -- one line was split can still never canonicalize alike.

  -- Modifier payload shape. Checked here, before any config is loaded, so a
  -- malformed or oversized request never reaches the pricing loop.
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

  -- Every option id must be a non-empty string. jsonb_array_elements_text
  -- renders a non-string element as its text form, so the type is checked
  -- explicitly rather than inferred.
  select count(*) into v_count
  from jsonb_array_elements(p_items) e,
       jsonb_array_elements(coalesce(e.value -> 'modifiers', '[]'::jsonb)) m,
       jsonb_array_elements(coalesce(m.value -> 'optionIds', '[]'::jsonb)) o
  where jsonb_typeof(o.value) <> 'string'
     or coalesce(btrim(o.value #>> '{}'), '') = '';
  if v_count > 0 then
    raise exception 'Invalid order item';
  end if;

  -- Feature 24.5B — the sale source. A CLOSED set, checked before anything
  -- else reads it: an unbounded text column would let a caller invent a
  -- category that every later filter and report silently ignores.
  v_sale_source := lower(btrim(coalesce(p_source, 'online')));
  if v_sale_source not in ('online', 'offline_queued') then
    raise exception 'Invalid sale source';
  end if;

  -- ==========================================================================
  -- 2. Authorization — v1.3 Feature 1B: DEVICE ONLY, project DERIVED.
  --
  -- complete_sale_v5 takes no project id. The project is the one the calling
  -- device is paired to, read from the device's own row, so no request can
  -- name another tenant. Owner Web and Builder stay on complete_sale_v3; an
  -- owner's auth user has no paired_devices row and is refused here with the
  -- same non-probing message every other refusal uses.
  --
  -- The device row is resolved WITHOUT the revoked/unpaired filter, exactly as
  -- v4 does and for v4's reason: an idempotent replay of an order this project
  -- already holds must still be answerable after the till is revoked. Both
  -- decisions stay in the new-sale branch (6c), unchanged.
  --
  -- LOCK ORDER, step 1 of the Feature 1B global order: the device row FOR
  -- SHARE, BEFORE the project row. employee_login, register open/close,
  -- revoke, unpair and the config-update pair all take this row FOR UPDATE
  -- (or UPDATE it) and none of them locks projects, so no cycle exists. Taking
  -- it first also means a till's login — which holds this row across a bcrypt
  -- verification — delays only that till's sales, never the whole project's.
  -- Every device fact used later (pinned build, revocation, unpair) comes
  -- from this locked read, so a concurrent config apply cannot slip a
  -- different build under the pricing below.
  -- ==========================================================================
  select d.id, d.project_id, d.owner_id, d.build_job_id, d.revoked_at,
         d.created_at, d.unpaired_at
    into v_device_id, v_project_id, v_owner_id, v_build_job_id,
         v_device_revoked_at, v_device_paired_at, v_device_unpaired_at
  from public.paired_devices d
  where d.auth_user_id = v_caller
  for share;

  if not found then
    raise exception 'Project not found or access denied';
  end if;

  -- Constant. Every owner branch below is unreachable in v5 and is kept only so
  -- the pricing, tax, receipt and inventory code stays byte-for-byte v4's.
  v_is_owner := false;

  -- ==========================================================================
  -- 3. Lock the project row. Single serialization point per project, taken
  --    before any pricing, stock, idempotency or counter access.
  -- ==========================================================================
  select p.config into v_config
  from public.projects p
  where p.id = v_project_id and p.user_id = v_owner_id
  for update;
  if not found then
    raise exception 'Project not found or access denied';
  end if;

  v_live_items := coalesce(v_config -> 'menuItems', '[]'::jsonb);
  if jsonb_typeof(v_live_items) <> 'array' then
    raise exception 'Project configuration is invalid';
  end if;

  -- The device's pinned build id was read in section 2, together with its
  -- revocation state. Nothing else about the device is needed until a NEW sale
  -- is being priced, so an idempotent replay still never depends on it.

  -- ==========================================================================
  -- 4. Tip. Rejected for special values before the owner/device branch, since
  --    NaN sorts above every finite numeric and would otherwise be misreported.
  -- ==========================================================================
  if p_tip_amount is not null
     and p_tip_amount::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'Order amounts are not valid';
  end if;

  if v_is_owner then
    v_tip_amount := round(coalesce(p_tip_amount, 0), 2);
    if v_tip_amount < 0 then
      raise exception 'Order amounts cannot be negative';
    end if;
    if v_tip_amount > c_max_money then
      raise exception 'Order amount is too large';
    end if;
  else
    if coalesce(p_tip_amount, 0) <> 0 then
      raise exception 'Tips are not supported on this device';
    end if;
    v_tip_amount := round(0::numeric, 2);
  end if;

  -- ==========================================================================
  -- 5. Normalize items, then build the canonical preimage and its hash.
  -- ==========================================================================
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

    -- A group carrying no options selects nothing, so it is dropped before the
    -- identity is built. Keeping it would make {g:[]} and an omitted g two
    -- different identities for the same cart.
    select coalesce(jsonb_agg(m.value order by btrim(m.value ->> 'groupId') collate "C"), '[]'::jsonb)
    into v_mods
    from jsonb_array_elements(v_mods) m
    where jsonb_array_length(coalesce(m.value -> 'optionIds', '[]'::jsonb)) > 0;

    -- Duplicate group ids inside one line would make the identity ambiguous.
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

    -- Duplicate option ids inside one group: same reasoning.
    select count(*) into v_count
    from jsonb_array_elements(v_mods) m
    where (select count(*) from jsonb_array_elements_text(m.value -> 'optionIds')) <>
          (select count(distinct o.value) from jsonb_array_elements_text(m.value -> 'optionIds') o);
    if v_count > 0 then
      raise exception 'The same option appears more than once for an item';
    end if;

    -- CANONICAL LINE IDENTITY.
    --   <len(itemId)>:<itemId>[<groups>]<group>*
    --   group  := <len(gid)>:<gid>(<options>)<option>*
    --   option := <len(oid)>:<oid>
    -- Every id is byte-length-prefixed and every repeat carries an explicit
    -- count, so the string parses back unambiguously — a delimiter inside an id
    -- cannot shift the reading. Groups sort by group id and options by option
    -- id, so the order a cashier tapped them in cannot change the identity.
    -- This is the same injectivity technique v2 uses for item ids, extended one
    -- level down.
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

    v_norm := v_norm || jsonb_build_object(
      'id', v_item_id,
      'qty', v_quantity,
      'mods', v_mods,
      'key', v_line_identity
    );
  end loop;

  -- Duplicate LINES — the modifier-aware replacement for v2's duplicate-item
  -- rule. The same product with different selections is allowed; the identical
  -- product-and-selection twice is not.
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

  -- A NEW canonical format. v1 keyed a line on item id alone, so two different
  -- modifier selections of one product would collide. complete_sale_v2's own
  -- preimage is deliberately left untouched, so a stale tab still hashes
  -- exactly as it always did.
  v_canonical :=
    'posc.sale.v2' || E'\n' ||
    'project=' || v_project_id::text || E'\n' ||
    'payment=' || v_method || E'\n' ||
    'tip=' || v_tip_amount::text || E'\n' ||
    'items=' || jsonb_array_length(v_norm)::text ||
    case when v_items_text is null then '' else E'\n' || v_items_text end;

  v_hash := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');

  -- ==========================================================================
  -- 6. Idempotency lookup — after authorization and the lock, BEFORE counter
  --    allocation, order insert, inventory mutation and audit inserts.
  --
  --    Placed here deliberately: a replay must succeed even if the item was
  --    since renamed, repriced, removed from the menu, or has since run out of
  --    stock. The payload is rebuilt from the stored order, never recomputed.
  -- ==========================================================================
  select o.id, o.sale_request_hash into v_existing
  from public.orders o
  where o.project_id = v_project_id
    and o.sale_request_id = p_sale_request_id;

  if found then
    if v_existing.sale_request_hash is distinct from v_hash then
      raise exception 'Sale request ID was already used for a different order';
    end if;
    v_order_id := v_existing.id;
  else
    -- ========================================================================
    -- 6b. Feature 24.5B — WHEN did this sale happen, and was the device still
    --     allowed to make it?
    --
    --     NEW SALES ONLY, deliberately. A replay returned above without ever
    --     reading p_occurred_at, which is also why occurred_at is NOT part of
    --     the canonical preimage in section 5: a retry whose clock has moved a
    --     few seconds must be the SAME sale, not a hash conflict.
    --
    --     created_at is untouched by all of this. It remains the server clock,
    --     recording when the row was committed. occurred_at records when the
    --     money physically changed hands. Neither is derivable from the other
    --     once a sale can be queued for hours.
    -- ========================================================================
    if v_sale_source = 'online' then
      -- An online sale happens now, by definition. A caller-supplied time is
      -- refused rather than ignored, so nobody can backdate an online sale and
      -- believe it worked.
      if p_occurred_at is not null then
        raise exception 'An online sale cannot declare its own sale time';
      end if;

      v_occurred_at := now();
    else
      -- THE DEVICE CLOCK IS NOT AUTHORITATIVE. Every bound below is checked
      -- against server time or against a server-recorded fact, and each one
      -- raises a DISTINCT message so the sync engine can tell an operator
      -- problem from a tampering attempt.
      if p_occurred_at is null then
        raise exception 'An offline sale must declare when it happened';
      end if;

      -- Not in the future. A clock running fast is ordinary; a clock running
      -- fast by more than the skew allowance is either broken or being used to
      -- reach past a revocation.
      if p_occurred_at > now() + c_clock_skew then
        raise exception 'Offline sale time is in the future';
      end if;

      -- Not before this device existed. paired_devices.created_at is a server
      -- timestamp, so this bound cannot be moved by the device. It is one of
      -- the two floors on backdating, and on its own it is NOT enough: a device
      -- paired months ago satisfies it for any date since.
      if v_device_paired_at is not null
         and p_occurred_at < v_device_paired_at - c_clock_skew then
        raise exception 'Offline sale time predates this device';
      end if;

      -- Not older than the offline lease. THE SECOND FLOOR, and the one that
      -- makes the revocation window in 6c enforceable: an unbounded past would
      -- let a new submission be backdated in front of any later revoked_at.
      --
      -- REJECTED, NEVER CLAMPED. Silently moving the timestamp to the boundary
      -- would write a sale time nobody reported, into the books, to make a
      -- validation pass — the exact rewriting of financial history this
      -- contract exists to prevent. The sale stays in the device queue for a
      -- person to resolve.
      if p_occurred_at < now() - c_offline_max_age - c_clock_skew then
        raise exception 'Offline sale time is older than the offline limit';
      end if;

      v_occurred_at := p_occurred_at;
    end if;

    -- ========================================================================
    -- 6c. The revocation window (docs/OFFLINE_ARCHITECTURE.md §13).
    --
    --     Owner-approved policy, and the reason section 2 stopped filtering
    --     revoked devices out: a sale that happened BEFORE the owner revoked
    --     the till is real money and is recorded; a sale claiming to have
    --     happened after it is refused and reported. The comparison uses the
    --     server-validated occurred_at above, never the raw parameter.
    -- ========================================================================
    -- ==========================================================================
    -- 6c-i. Feature 25.1 — the device removed itself.
    --
    --     UNCONDITIONAL, AND DELIBERATELY NOT A WINDOW. There is no
    --     `occurred_at < unpaired_at` exception here and there must never be
    --     one. Revocation earns its temporal comparison because an owner can
    --     revoke remotely while a till is offline, so sales taken before that
    --     moment are real money the device could not have known about. A
    --     voluntary unpair is the opposite: it is initiated ON the device, and
    --     only after decideDeviceResetSafety has proven the queue holds nothing
    --     pending, syncing, needing attention, or uncertain. There is no
    --     legitimate sale left for a window to admit.
    --
    --     PLACED INSIDE THE NEW-SALE BRANCH, after the section 6 idempotency
    --     lookup returned nothing. A REPLAY of an already-committed order never
    --     reaches this line and is still answered exactly as before: it
    --     allocates nothing, mutates nothing, and returns the order this same
    --     caller already created. Refusing a replay would protect nothing and
    --     would throw away the one guarantee that exists for the case where our
    --     model of reality turns out to be wrong.
    -- ==========================================================================
    if not v_is_owner and v_device_unpaired_at is not null then
      raise exception 'This device is no longer paired';
    end if;

    if not v_is_owner and v_device_revoked_at is not null then
      if v_sale_source <> 'offline_queued' then
        -- A revoked device gets no NEW online sale. It has already reconnected
        -- by definition, so it has already learned it was revoked.
        raise exception 'Project not found or access denied';
      end if;

      if v_occurred_at >= v_device_revoked_at then
        raise exception 'Offline sale occurred after this device was revoked';
      end if;
    end if;

    -- ========================================================================
    -- 6d. v1.3 Feature 1B — sale attribution. NEW SALES ONLY.
    --
    --     A replay returned above with the attribution it was stored with; it
    --     never reaches this block, so a completed sale stays replayable after
    --     a switch, logout, deactivation, register close or reopen.
    --
    --     LOCK ORDER, steps 3-5 (the device is step 1 and the project step 2,
    --     both already held): employee POS session, employee, register session.
    -- ========================================================================
    if v_sale_source = 'online' then
      -- ONLINE: current state, compared against what the till expected.
      --
      -- The two ids are CONCURRENCY EXPECTATIONS, never authority. Every
      -- stored identity is read from the locked server row below.
      if p_employee_pos_session_id is null or p_register_session_id is null then
        raise exception 'This sale must name the signed-in employee and the open register';
      end if;

      -- FOR SHARE on BOTH rows. The session lock conflicts with employee_logout's
      -- UPDATE (which takes no device lock); the employee lock conflicts with
      -- set_employee_active's UPDATE. FOR KEY SHARE would NOT: it is compatible
      -- with a non-key UPDATE. If either writer commits first, READ COMMITTED
      -- re-checks this WHERE clause against the new row version, the row stops
      -- qualifying, and the sale is refused. employee_login's switch is excluded
      -- earlier, by the device lock.
      select s.id, s.employee_id
        into v_employee_session
      from public.employee_pos_sessions s
      join public.employees e on e.id = s.employee_id
      where s.paired_device_id = v_device_id
        and s.ended_at is null
        and e.active
        and e.project_id = v_project_id
        and e.role in ('owner', 'manager', 'cashier')
      for share of s, e;

      if not found then
        raise exception 'An employee must be signed in on this register';
      end if;

      if v_employee_session.id is distinct from p_employee_pos_session_id then
        raise exception 'The signed-in employee changed';
      end if;

      -- register_session close takes the device row FOR UPDATE, so the step-1
      -- lock already excludes it; this lock is the backstop for any future
      -- writer of this row.
      select r.id
        into v_register_session_id
      from public.register_sessions r
      where r.paired_device_id = v_device_id
        and r.closed_at is null
      for share;

      if not found then
        raise exception 'The register is not open';
      end if;

      if v_register_session_id is distinct from p_register_session_id then
        raise exception 'The register session changed';
      end if;

      v_employee_id := v_employee_session.employee_id;
    else
      -- OFFLINE: SERVER-VALIDATED HISTORICAL ATTRIBUTION — not cryptographically
      -- proven operator identity.
      --
      -- The two ids are CLAIMS captured at offline checkout. Each dimension is
      -- validated on its own against durable server history for THIS device
      -- and the already-validated occurred_at. A claim that does not validate
      -- is stored as NULL; it never rejects a paid sale, is never filled from
      -- current state, and is never inferred from the other dimension.
      --
      -- KNOWN LIMITATION: Feature 1A keeps no history of active/inactive
      -- intervals — deactivation leaves a session open and reactivation clears
      -- deactivated_at — so the session interval cannot prove the employee was
      -- active at every instant inside it. The claim is validated against the
      -- session interval and the device/project relationship only.
      if p_employee_pos_session_id is not null then
        select s.employee_id
          into v_employee_id
        from public.employee_pos_sessions s
        join public.employees e on e.id = s.employee_id
        where s.id = p_employee_pos_session_id
          and s.paired_device_id = v_device_id
          and e.project_id = v_project_id
          and s.started_at <= v_occurred_at
          and (s.ended_at is null or v_occurred_at < s.ended_at)
        for share of s;

        if not found then
          v_employee_id := null;
        end if;
      end if;

      if p_register_session_id is not null then
        select r.id
          into v_register_session_id
        from public.register_sessions r
        where r.id = p_register_session_id
          and r.paired_device_id = v_device_id
          and r.opened_at <= v_occurred_at
          and (r.closed_at is null or v_occurred_at < r.closed_at)
        for share;

        if not found then
          v_register_session_id := null;
        end if;
      end if;
    end if;

    -- ========================================================================
    -- 7. New sale. Resolve the authorized pricing source.
    -- ========================================================================
    if v_is_owner then
      v_source := v_config;
      -- Feature 28C — captured from the SAME v_config this sale is being priced
      -- from, inside the same project lock, so the header on the receipt and the
      -- prices on it can never come from two different reads.
      v_receipt_snapshot := jsonb_build_object(
        'businessProfile', coalesce(v_config -> 'businessProfile', '{}'::jsonb),
        'receipt', coalesce(v_config -> 'receipt', '{}'::jsonb)
      );
    else
      select b.config_snapshot into v_source
      from public.build_jobs b
      where b.id = v_build_job_id
        and b.project_id = v_project_id
        and b.status = 'succeeded';
      if not found then
        raise exception 'This device is not linked to a usable build';
      end if;
    end if;

    v_price_items := coalesce(v_source -> 'menuItems', '[]'::jsonb);
    v_tax := coalesce(v_source -> 'tax', '{}'::jsonb);
    v_receipt := coalesce(v_source -> 'receipt', '{}'::jsonb);

    if jsonb_typeof(v_price_items) <> 'array' then
      raise exception 'Pricing configuration is invalid';
    end if;

    -- Tax settings. Malformed values fall back exactly as toRuntimeSafeTax
    -- does: a special or unparseable rate becomes 0, NOT the 100 clamp.
    begin
      v_tax_enabled := coalesce((v_tax ->> 'enabled')::boolean, true);
    exception when invalid_text_representation then v_tax_enabled := true;
    end;
    begin
      v_tax_inclusive := coalesce((v_tax ->> 'pricesIncludeTax')::boolean, false);
    exception when invalid_text_representation then v_tax_inclusive := false;
    end;
    begin
      v_rate := coalesce((v_tax ->> 'rate')::numeric, 0);
    exception when invalid_text_representation then v_rate := 0;
    end;

    if v_rate is null or v_rate::text in ('NaN', 'Infinity', '-Infinity') then
      v_rate := 0;
    elsif v_rate < 0 then
      v_rate := 0;
    elsif v_rate > 100 then
      v_rate := 100;
    end if;

    -- ========================================================================
    -- 8. Per-item server pricing and live-stock validation.
    -- ========================================================================
    for v_item in select value from jsonb_array_elements(v_norm)
    loop
      v_item_id := v_item ->> 'id';
      v_quantity := (v_item ->> 'qty')::integer;
      v_mods := coalesce(v_item -> 'mods', '[]'::jsonb);

      v_price_item := null;
      for i in 0 .. jsonb_array_length(v_price_items) - 1
      loop
        if v_price_items -> i ->> 'id' = v_item_id then
          v_price_item := v_price_items -> i;
          exit;
        end if;
      end loop;

      if v_price_item is null then
        raise exception 'Menu item % is not available', v_item_id;
      end if;

      v_item_name := btrim(coalesce(v_price_item ->> 'name', ''));
      if v_item_name = '' then
        raise exception 'Menu item % is not available', v_item_id;
      end if;

      begin
        v_unit_price := (v_price_item ->> 'price')::numeric;
      exception when invalid_text_representation then
        raise exception 'Menu item % has an invalid price', v_item_id;
      end;

      if v_unit_price is null
         or v_unit_price::text in ('NaN', 'Infinity', '-Infinity')
         or v_unit_price < 0
         or v_unit_price > c_max_unit_price then
        raise exception 'Menu item % has an invalid price', v_item_id;
      end if;

      -- ----------------------------------------------------------------
      -- Feature 18.1 — modifier resolution, validation and pricing.
      --
      -- Every value used below comes from v_price_item, which is the
      -- AUTHORIZED source resolved in section 7 (the owner's locked live
      -- config, or the device's pinned build snapshot). The request supplied
      -- identifiers and nothing else; there is no field in it for a name or a
      -- price, so none can be trusted by accident.
      -- ----------------------------------------------------------------
      v_mod_groups := coalesce(v_price_item -> 'modifierGroups', '[]'::jsonb);
      if jsonb_typeof(v_mod_groups) <> 'array' then
        v_mod_groups := '[]'::jsonb;
      end if;

      v_mod_total := 0;
      v_mod_snapshot := '[]'::jsonb;

      -- A product with no groups accepts no selections. This is what stops an
      -- option being attached to a plain item, or borrowed from another product.
      if jsonb_array_length(v_mod_groups) = 0 and jsonb_array_length(v_mods) > 0 then
        raise exception 'Menu item % does not have options', v_item_id;
      end if;

      for j in 0 .. jsonb_array_length(v_mods) - 1
      loop
        v_mod_sel := v_mods -> j;
        v_group_id := btrim(v_mod_sel ->> 'groupId');

        -- The group must belong to THIS product.
        v_mod_group := null;
        for k in 0 .. jsonb_array_length(v_mod_groups) - 1
        loop
          if v_mod_groups -> k ->> 'id' = v_group_id then
            v_mod_group := v_mod_groups -> k;
            exit;
          end if;
        end loop;

        if v_mod_group is null then
          raise exception 'Menu item % does not have that option group', v_item_id;
        end if;

        v_sel_count := jsonb_array_length(coalesce(v_mod_sel -> 'optionIds', '[]'::jsonb));

        -- A single-choice group accepts at most one option.
        if coalesce(v_mod_group ->> 'selection', 'single') = 'single' and v_sel_count > 1 then
          raise exception 'Only one option may be chosen for %', coalesce(v_mod_group ->> 'name', v_group_id);
        end if;

        -- maxSelections applies to multiple-choice groups only, and only when set.
        if coalesce(v_mod_group ->> 'selection', 'single') = 'multiple'
           and v_mod_group -> 'maxSelections' is not null
           and jsonb_typeof(v_mod_group -> 'maxSelections') = 'number'
           and v_sel_count > (v_mod_group ->> 'maxSelections')::integer then
          raise exception 'Too many options chosen for %', coalesce(v_mod_group ->> 'name', v_group_id);
        end if;

        for k in 0 .. v_sel_count - 1
        loop
          v_mod_opt_id := btrim(v_mod_sel -> 'optionIds' ->> k);

          -- The option must belong to THIS group, not merely to the product.
          v_mod_option := null;
          for i in 0 .. jsonb_array_length(coalesce(v_mod_group -> 'options', '[]'::jsonb)) - 1
          loop
            if v_mod_group -> 'options' -> i ->> 'id' = v_mod_opt_id then
              v_mod_option := v_mod_group -> 'options' -> i;
              exit;
            end if;
          end loop;

          if v_mod_option is null then
            raise exception 'That option is not available for %', coalesce(v_mod_group ->> 'name', v_group_id);
          end if;

          begin
            v_mod_adjust := (v_mod_option ->> 'priceAdjustment')::numeric;
          exception when invalid_text_representation then
            raise exception 'An option for % has an invalid price', v_item_id;
          end;

          -- Same money discipline as the base price: MVP adjustments are
          -- non-negative, finite, and bounded by the per-unit ceiling.
          if v_mod_adjust is null
             or v_mod_adjust::text in ('NaN', 'Infinity', '-Infinity')
             or v_mod_adjust < 0
             or v_mod_adjust > c_max_unit_price then
            raise exception 'An option for % has an invalid price', v_item_id;
          end if;

          v_mod_total := v_mod_total + v_mod_adjust;

          -- The historical snapshot: names and prices as they are RIGHT NOW,
          -- so a receipt reprinted after a menu change still shows what the
          -- customer actually bought and paid.
          v_mod_snapshot := v_mod_snapshot || jsonb_build_object(
            'groupId', v_group_id,
            'groupName', coalesce(v_mod_group ->> 'name', ''),
            'optionId', v_mod_opt_id,
            'optionName', coalesce(v_mod_option ->> 'name', ''),
            'priceAdjustment', round(v_mod_adjust, 2)::text
          );
        end loop;
      end loop;

      -- Required groups must be satisfied. Checked over the PRODUCT's groups
      -- rather than the submission, so an omitted group is caught as readily as
      -- an empty one.
      for k in 0 .. jsonb_array_length(v_mod_groups) - 1
      loop
        if (v_mod_groups -> k ->> 'required')::boolean is true then
          v_required_ok := false;

          for j in 0 .. jsonb_array_length(v_mods) - 1
          loop
            if btrim(v_mods -> j ->> 'groupId') = (v_mod_groups -> k ->> 'id')
               and jsonb_array_length(coalesce(v_mods -> j -> 'optionIds', '[]'::jsonb)) > 0 then
              v_required_ok := true;
              exit;
            end if;
          end loop;

          if not v_required_ok then
            raise exception 'Please choose % for %',
              coalesce(v_mod_groups -> k ->> 'name', 'an option'), v_item_name;
          end if;
        end if;
      end loop;

      -- The line's unit price is the base plus every selected adjustment. It is
      -- re-bounded because the sum can exceed the per-unit ceiling even when
      -- each part is individually valid.
      v_unit_price := round(v_unit_price + v_mod_total, 2);

      if v_unit_price is null
         or v_unit_price::text in ('NaN', 'Infinity', '-Infinity')
         or v_unit_price < 0
         or v_unit_price > c_max_unit_price then
        raise exception 'Menu item % has an invalid price', v_item_id;
      end if;

      v_line_total := round(v_unit_price * v_quantity, 2);
      if v_line_total is null
         or v_line_total::text in ('NaN', 'Infinity', '-Infinity') then
        raise exception 'Order amount is not valid';
      end if;
      if v_line_total > c_max_money then
        raise exception 'Order amount is too large';
      end if;

      v_subtotal := v_subtotal + v_line_total;
      if v_subtotal > c_max_money then
        raise exception 'Order amount is too large';
      end if;

      -- Inventory always from the LIVE locked config.
      v_live_index := null;
      for i in 0 .. jsonb_array_length(v_live_items) - 1
      loop
        if v_live_items -> i ->> 'id' = v_item_id then
          v_live_index := i;
          exit;
        end if;
      end loop;
      if v_live_index is null then
        raise exception 'Menu item % is not available', v_item_id;
      end if;
      v_live_item := v_live_items -> v_live_index;

      begin
        v_track := coalesce((v_live_item ->> 'trackInventory')::boolean, false);
      exception when invalid_text_representation then
        raise exception 'Inventory configuration for % is invalid', v_item_id;
      end;

      v_stock_before := 0;
      v_stock_after := 0;
      v_shortfall := 0;

      if v_track then
        begin
          v_stock_num := coalesce((v_live_item ->> 'stockQuantity')::numeric, 0);
        exception when invalid_text_representation then
          raise exception 'Inventory configuration for % is invalid', v_item_id;
        end;

        if v_stock_num is null
           or v_stock_num::text in ('NaN', 'Infinity', '-Infinity')
           or v_stock_num <> trunc(v_stock_num)
           or v_stock_num < 0
           or v_stock_num > c_max_stock then
          raise exception 'Inventory configuration for % is invalid', v_item_id;
        end if;

        v_stock_before := v_stock_num::integer;

        -- Feature 24.5B — the online rule is UNCHANGED: refuse, so the cashier
        -- can still act on it while the customer is standing there.
        --
        -- An offline queued sale is the opposite situation. The food is gone
        -- and the cash is in the drawer; the only question left is whether the
        -- books reflect it. Refusing here would delete a real financial record
        -- to protect a stock number, so the sale is accepted, tracked stock
        -- floors at 0 — the live config's own check rejects a negative — and
        -- the shortfall is recorded per line for the owner to reconcile.
        if v_stock_before < v_quantity then
          if v_sale_source <> 'offline_queued' then
            raise exception 'Insufficient inventory for %', v_item_name;
          end if;

          v_shortfall := v_quantity - v_stock_before;
          v_has_shortfall := true;
          v_stock_after := 0;
        else
          v_shortfall := 0;
          v_stock_after := v_stock_before - v_quantity;
        end if;

        v_live_items := jsonb_set(
          v_live_items, array[v_live_index::text, 'stockQuantity'],
          to_jsonb(v_stock_after), true
        );
      end if;

      v_lines := v_lines || jsonb_build_object(
        'item_id', v_item_id, 'item_name', v_item_name,
        'unit_price', v_unit_price, 'quantity', v_quantity,
        'line_total', v_line_total, 'track', v_track,
        'stock_before', v_stock_before, 'stock_after', v_stock_after,
        'shortfall', coalesce(v_shortfall, 0),
        'modifiers', v_mod_snapshot
      );
    end loop;

    -- ========================================================================
    -- 9. Order-level money — identical rules and rounding points to Migration C.
    -- ========================================================================
    v_subtotal := round(v_subtotal, 2);

    if not v_tax_enabled then
      v_tax_amount := 0;
      v_total_before_tip := v_subtotal;
    elsif v_tax_inclusive then
      v_tax_amount := round(v_subtotal - v_subtotal / (1 + v_rate / 100), 2);
      v_total_before_tip := v_subtotal;
    else
      v_tax_amount := round(v_subtotal * v_rate / 100, 2);
      v_total_before_tip := v_subtotal + v_tax_amount;
    end if;

    if v_tax_amount < 0 then
      v_tax_amount := 0;
    end if;

    v_total := round(v_total_before_tip + v_tip_amount, 2);

    if v_subtotal is null or v_tax_amount is null
       or v_tip_amount is null or v_total is null
       or v_subtotal::text in ('NaN', 'Infinity', '-Infinity')
       or v_tax_amount::text in ('NaN', 'Infinity', '-Infinity')
       or v_tip_amount::text in ('NaN', 'Infinity', '-Infinity')
       or v_total::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'Order amount is not valid';
    end if;

    if v_subtotal > c_max_money or v_tax_amount > c_max_money
       or v_tip_amount > c_max_money or v_total > c_max_money then
      raise exception 'Order amount is too large';
    end if;

    if v_subtotal < 0 or v_total < 0 then
      raise exception 'Order amounts cannot be negative';
    end if;

    -- ========================================================================
    -- 10. Order number. Prefix from the SAME authorized source as the prices,
    --     so a device's receipt prefix matches the build it is pinned to.
    -- ========================================================================
    v_prefix := btrim(coalesce(v_receipt ->> 'orderPrefix', ''));
    v_prefix := regexp_replace(v_prefix, '[[:cntrl:]]', '', 'g');
    if length(v_prefix) > c_max_prefix_len then
      v_prefix := left(v_prefix, c_max_prefix_len);
    end if;

    -- Lazily create the counter: D2 seeded only the projects that existed then,
    -- so any project created afterwards gets its row here, on first sale.
    insert into public.project_order_counters (project_id, last_number)
    values (v_project_id, 1000)
    on conflict (project_id) do nothing;

    select c.last_number into v_suffix
    from public.project_order_counters c
    where c.project_id = v_project_id
    for update;

    if v_suffix is null then
      raise exception 'Order number could not be allocated';
    end if;
    if v_suffix >= c_max_suffix then
      raise exception 'Order number sequence exhausted for this project';
    end if;

    -- Transactional allocation. Not a sequence: nextval is non-transactional
    -- and would leave a permanent gap on every rolled-back sale.
    update public.project_order_counters
    set last_number = last_number + 1,
        updated_at = now()
    where project_id = v_project_id
    returning last_number into v_suffix;

    v_order_number := v_prefix || v_suffix::text;

    -- ========================================================================
    -- 11. Atomic write.
    -- ========================================================================
    begin
      insert into public.orders (
        user_id, project_id, order_number, payment_method,
        subtotal, tax_amount, tip_amount, total,
        number_source, sale_request_id, sale_request_hash,
        -- Feature 24.5B. created_at is deliberately NOT listed: it keeps its
        -- now() default, so the server clock still records when this row was
        -- committed no matter what the device said about occurred_at.
        occurred_at, source, has_inventory_shortfall,
        build_job_id,
        receipt_snapshot,
        -- v1.3 Feature 1B — all three derived above, never from a parameter.
        employee_id, paired_device_id, register_session_id
      )
      values (
        v_owner_id, v_project_id, v_order_number, v_method,
        v_subtotal, v_tax_amount, v_tip_amount, v_total,
        'server', p_sale_request_id, v_hash,
        v_occurred_at, v_sale_source, v_has_shortfall,
        v_build_job_id,
        v_receipt_snapshot,
        v_employee_id, v_device_id, v_register_session_id
      )
      returning id into v_order_id;
    exception
      when unique_violation then
        -- The project FOR UPDATE lock serializes every sale for this project,
        -- so this should be unreachable. It is kept as a final backstop rather
        -- than a primary path: re-read the winning row and apply the SAME hash
        -- comparison, so a racing duplicate replays instead of double-selling.
        -- The subtransaction rollback has already undone this INSERT; no
        -- inventory row or config update has been written yet.
        select o.id, o.sale_request_hash into v_existing
        from public.orders o
        where o.project_id = v_project_id
          and o.sale_request_id = p_sale_request_id;

        if not found then
          raise exception 'Could not allocate a unique order number';
        end if;
        if v_existing.sale_request_hash is distinct from v_hash then
          raise exception 'Sale request ID was already used for a different order';
        end if;
        v_order_id := v_existing.id;
    end;

    -- Only write the rest when this call actually created the order.
    if not exists (
      select 1 from public.order_items oi where oi.order_id = v_order_id
    ) then
      insert into public.order_items (
        order_id, item_id, item_name, unit_price, quantity, line_total, modifiers,
        inventory_shortfall, line_position
      )
      select v_order_id, line ->> 'item_id', line ->> 'item_name',
             (line ->> 'unit_price')::numeric, (line ->> 'quantity')::integer,
             (line ->> 'line_total')::numeric,
             coalesce(line -> 'modifiers', '[]'::jsonb),
             coalesce((line ->> 'shortfall')::integer, 0),
             line_no::integer
      from jsonb_array_elements(v_lines) with ordinality as t(line, line_no);

      insert into public.inventory_transactions (
        user_id, project_id, order_id, item_id, item_name,
        transaction_type, quantity_change, quantity_before, quantity_after
      )
      -- Feature 24.5B — the change is stock_before minus stock_after, NOT the
      -- requested quantity. Once an offline sale can floor at 0 those two
      -- differ, and inventory_transactions carries its own
      -- `quantity_after = quantity_before + quantity_change` check that would
      -- reject the row. The shortfall lives on order_items, where it can be
      -- expressed without breaking that arithmetic.
      select v_owner_id, v_project_id, v_order_id, line ->> 'item_id',
             line ->> 'item_name', 'sale',
             -((line ->> 'stock_before')::integer - (line ->> 'stock_after')::integer),
             (line ->> 'stock_before')::integer,
             (line ->> 'stock_after')::integer
      from jsonb_array_elements(v_lines) as line
      where (line ->> 'track')::boolean
        and (line ->> 'stock_before')::integer <> (line ->> 'stock_after')::integer;

      update public.projects
      set config = jsonb_set(v_config, '{menuItems}', v_live_items, true),
          updated_at = now()
      where id = v_project_id and user_id = v_owner_id;

      if not found then
        raise exception 'Failed to update project inventory';
      end if;
    end if;
  end if;

  -- ==========================================================================
  -- 12. Authoritative payload — ONE construction path, used by both the new-sale
  --     and the idempotent-replay branch, always rebuilt from the stored rows.
  --
  --     Money is returned as fixed two-decimal STRINGS. numeric(12,2)::text is
  --     exact; a JSON number would be parsed into an IEEE-754 double by the
  --     browser and could render a cent differently from what is stored.
  --     Deliberately absent: user_id, sale_request_id, sale_request_hash,
  --     build id, config snapshot and inventory before/after values.
  --     v1.3 Feature 1B — the STORED attribution is returned, read from the
  --     order row, so a replay answers with what was recorded, never with
  --     who happens to be signed in now.
  -- ==========================================================================
  select jsonb_build_object(
           'orderId', o.id::text,
           'orderNumber', o.order_number,
           'paymentMethod', o.payment_method,
           'subtotal', o.subtotal::text,
           'taxAmount', o.tax_amount::text,
           'tipAmount', o.tip_amount::text,
           'total', o.total::text,
           'createdAt', to_char(o.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           -- Feature 24.5B — ADDITIVE ONLY. Every field v3 returned keeps its
           -- name and its type, so a client reading a v4 payload with v3's
           -- parser is unaffected.
           'occurredAt', to_char(o.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'source', o.source,
           'hasInventoryShortfall', o.has_inventory_shortfall,
           'attribution', jsonb_build_object(
             'employeeId', o.employee_id,
             'pairedDeviceId', o.paired_device_id,
             'registerSessionId', o.register_session_id
           ),
           'items', coalesce((
             select jsonb_agg(
                      jsonb_build_object(
                        'itemId', oi.item_id,
                        'itemName', oi.item_name,
                        'unitPrice', oi.unit_price::text,
                        'quantity', oi.quantity,
                        'lineTotal', oi.line_total::text,
                        'modifiers', coalesce(oi.modifiers, '[]'::jsonb),
                        'inventoryShortfall', coalesce(oi.inventory_shortfall, 0)
                      )
                      -- Feature 28C — cart order for a sale written since this
                      -- feature, and a DETERMINISTIC fallback for every older row,
                      -- whose line_position is null and always will be. item_id
                      -- alone is not a total order: two lines of the same product
                      -- with different options tie on it, and a tie left to the
                      -- planner can order the slip and the reprint differently.
                      order by oi.line_position nulls last,
                               oi.item_id collate "C",
                               oi.id
                    )
             from public.order_items oi
             where oi.order_id = o.id
           ), '[]'::jsonb)
         )
  into v_payload
  from public.orders o
  where o.id = v_order_id;

  if v_payload is null then
    raise exception 'Order could not be loaded';
  end if;

  return v_payload;
end;
$function$;

revoke all on function public.complete_sale_v5(text, numeric, jsonb, uuid, timestamptz, text, uuid, uuid) from public;
revoke all on function public.complete_sale_v5(text, numeric, jsonb, uuid, timestamptz, text, uuid, uuid) from anon;
revoke all on function public.complete_sale_v5(text, numeric, jsonb, uuid, timestamptz, text, uuid, uuid) from service_role;
grant execute on function public.complete_sale_v5(text, numeric, jsonb, uuid, timestamptz, text, uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 8. Verification -- fails loudly, and the whole migration rolls back with it.
--
-- Definitions are checked SEMANTICALLY where Postgres would re-render them:
-- every CHECK and the partial-index predicate is evaluated against probe rows
-- instead of being compared as text.
-- ----------------------------------------------------------------------------
do $do$
declare
  v_def text;
  v_text text;
  v_sig text;
  v_oid oid;
  v_row record;
  v_count integer;
  v_role text;
  v_expr text;
  v_ok boolean;
  v_hit boolean;
  v_result jsonb;
  v_names text[];
  v_new_triggers text[];
  v_probe_sub uuid;
  v_t0 timestamptz := '2026-01-01 00:00:00+00';
  v_public_sigs text[] := array[
    'public.open_register_session(uuid,numeric)',
    'public.get_current_register_session()',
    'public.close_register_session(uuid)',
    'public.complete_sale_v5(text,numeric,jsonb,uuid,timestamptz,text,uuid,uuid)'
  ];
  v_legacy_sigs text[] := array[
    'public.complete_sale(uuid,text,text,numeric,numeric,numeric,numeric,jsonb)',
    'public.complete_sale_v2(uuid,text,numeric,jsonb,uuid)',
    'public.complete_sale_v3(uuid,text,numeric,jsonb,uuid)',
    'public.complete_sale_v4(uuid,text,numeric,jsonb,uuid,timestamptz,text)'
  ];
begin
  -- The smoke calls below must not run as whoever applies this migration.
  -- Transaction-local, and restored to "no caller" at the end.
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);

  -- ==========================================================================
  -- A1. Predecessors.
  -- ==========================================================================
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    select count(*) into v_count
    from supabase_migrations.schema_migrations
    where version in ('20260914120000', '20260916120000', '20260916130000');

    if v_count <> 3 then
      raise exception 'F1B: expected 20260914120000, 20260916120000 and 20260916130000 in the ledger, found % of 3', v_count;
    end if;
  end if;

  foreach v_text in array array['employees', 'employee_pos_sessions', 'paired_devices',
                                'projects', 'orders', 'order_items']
  loop
    if to_regclass(format('public.%I', v_text)) is null then
      raise exception 'F1B: prerequisite table % is missing', v_text;
    end if;
  end loop;

  foreach v_sig in array v_legacy_sigs || array['public.employee_login(uuid,text)',
                                                'public.employee_logout()',
                                                'public.set_employee_active(uuid,boolean)']
  loop
    if to_regprocedure(v_sig) is null then
      raise exception 'F1B: prerequisite function % is missing', v_sig;
    end if;
  end loop;

  -- ==========================================================================
  -- A2. register_sessions: exact columns, in order.
  -- ==========================================================================
  select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' ||
                    case when a.attnotnull then 'not null' else 'null' end || ':' ||
                    coalesce(pg_get_expr(d.adbin, d.adrelid), ''),
                    ',' order by a.attnum)
  into v_text
  from pg_attribute a
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attrelid = 'public.register_sessions'::regclass
    and a.attnum > 0
    and not a.attisdropped;

  if v_text is distinct from
     'id:uuid:not null:gen_random_uuid(),'
     'paired_device_id:uuid:not null:,'
     'opened_by_employee_id:uuid:not null:,'
     'opened_at:timestamp with time zone:not null:,'
     'opening_cash:numeric(12,2):not null:,'
     'open_request_id:uuid:not null:,'
     'closed_at:timestamp with time zone:null:,'
     'closed_by_employee_id:uuid:null:' then
    raise exception 'F1B: register_sessions columns are not exactly the approved set: %', v_text;
  end if;

  -- ==========================================================================
  -- A3. register_sessions CHECKs, evaluated.
  -- ==========================================================================
  select array_agg(c.conname::text order by c.conname::text collate "C"), string_agg('((' || pg_get_expr(c.conbin, c.conrelid) || ') is not false)', ' and ')
  into v_names, v_expr
  from pg_constraint c
  where c.conrelid = 'public.register_sessions'::regclass
    and c.contype = 'c';

  if v_names is distinct from array['register_sessions_closed_after_opened',
                                    'register_sessions_closed_state',
                                    'register_sessions_opening_cash_finite',
                                    'register_sessions_opening_cash_nonnegative',
                                    'register_sessions_opening_cash_scale'] then
    raise exception 'F1B: register_sessions CHECK constraints are %', v_names;
  end if;

  -- Unconstrained numeric on purpose: the CHECKs must hold on their own, not
  -- only because the column typmod rounds first. A probe that errors counts as
  -- refused, exactly as the INSERT it stands for would be.
  for v_row in
    select * from (values
      ('0',          v_t0, null::timestamptz,                  null::uuid,                              true),
      ('12.34',      v_t0, null,                               null,                                    true),
      ('12.340',     v_t0, null,                               null,                                    true),
      ('9999999999.99', v_t0, null,                            null,                                    true),
      ('-0.01',      v_t0, null,                               null,                                    false),
      ('12.345',     v_t0, null,                               null,                                    false),
      ('0.001',      v_t0, null,                               null,                                    false),
      ('NaN',        v_t0, null,                               null,                                    false),
      ('Infinity',   v_t0, null,                               null,                                    false),
      ('-Infinity',  v_t0, null,                               null,                                    false),
      ('1',          v_t0, v_t0 + interval '1 hour',           '00000000-0000-0000-0000-00000000000a'::uuid, true),
      ('1',          v_t0, v_t0,                               '00000000-0000-0000-0000-00000000000a'::uuid, true),
      ('1',          v_t0, v_t0 + interval '1 hour',           null,                                    false),
      ('1',          v_t0, null,                               '00000000-0000-0000-0000-00000000000a'::uuid, false),
      ('1',          v_t0, v_t0 - interval '1 second',         '00000000-0000-0000-0000-00000000000a'::uuid, false)
    ) as x(cash, opened, closed, closer, accepted)
  loop
    begin
      execute format(
        'select %s from (select $1::numeric as opening_cash, $2::timestamptz as opened_at, '
        '$3::timestamptz as closed_at, $4::uuid as closed_by_employee_id) as register_sessions',
        v_expr)
      into v_ok
      using v_row.cash, v_row.opened, v_row.closed, v_row.closer;
    exception
      when others then
        v_ok := false;
    end;

    if v_ok is distinct from v_row.accepted then
      raise exception 'F1B: register_sessions CHECKs % the row (cash %, closed %, closer %)',
        case when v_ok then 'accept' else 'refuse' end, v_row.cash, v_row.closed, v_row.closer;
    end if;
  end loop;

  -- ==========================================================================
  -- A4. Keys, foreign keys and the one-open index.
  -- ==========================================================================
  for v_row in
    select * from (values
      ('public.register_sessions', 'register_sessions_pkey', 'p', array['id']),
      ('public.register_sessions', 'register_sessions_device_request_key', 'u', array['paired_device_id', 'open_request_id']),
      ('public.register_sessions', 'register_sessions_id_device_key', 'u', array['id', 'paired_device_id'])
    ) as x(tbl, conname, contype, cols)
  loop
    if not exists (
      select 1 from pg_constraint c
      where c.conrelid = v_row.tbl::regclass
        and c.conname = v_row.conname
        and c.contype::text = v_row.contype
        and array(select a.attname::text
                  from unnest(c.conkey) with ordinality as k(attnum, ord)
                  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
                  order by k.ord) = v_row.cols
    ) then
      raise exception 'F1B: key % is missing or not on %', v_row.conname, v_row.cols;
    end if;
  end loop;

  for v_row in
    select * from (values
      ('public.register_sessions', 'register_sessions_paired_device_id_fkey',
       array['paired_device_id'], 'public.paired_devices', array['id']),
      ('public.register_sessions', 'register_sessions_opened_by_employee_id_fkey',
       array['opened_by_employee_id'], 'public.employees', array['id']),
      ('public.register_sessions', 'register_sessions_closed_by_employee_id_fkey',
       array['closed_by_employee_id'], 'public.employees', array['id']),
      ('public.orders', 'orders_employee_id_fkey',
       array['employee_id'], 'public.employees', array['id']),
      ('public.orders', 'orders_paired_device_id_fkey',
       array['paired_device_id'], 'public.paired_devices', array['id']),
      ('public.orders', 'orders_register_session_device_fkey',
       array['register_session_id', 'paired_device_id'], 'public.register_sessions', array['id', 'paired_device_id'])
    ) as x(tbl, conname, cols, reftbl, refcols)
  loop
    if not exists (
      select 1 from pg_constraint c
      where c.conrelid = v_row.tbl::regclass
        and c.conname = v_row.conname
        and c.contype = 'f'
        and c.confrelid = v_row.reftbl::regclass
        and c.confdeltype = 'a'
        and c.confupdtype = 'a'
        and c.confmatchtype = 's'
        and not c.condeferrable
        and array(select a.attname::text
                  from unnest(c.conkey) with ordinality as k(attnum, ord)
                  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
                  order by k.ord) = v_row.cols
        and array(select a.attname::text
                  from unnest(c.confkey) with ordinality as k(attnum, ord)
                  join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum
                  order by k.ord) = v_row.refcols
    ) then
      raise exception 'F1B: foreign key % is missing, or is not % -> %(%) ON DELETE NO ACTION',
        v_row.conname, v_row.cols, v_row.reftbl, v_row.refcols;
    end if;
  end loop;

  -- No other foreign key anywhere may reference the new table, and the new
  -- table references nothing else.
  select count(*) into v_count
  from pg_constraint c
  where c.contype = 'f'
    and (c.confrelid = 'public.register_sessions'::regclass
         or c.conrelid = 'public.register_sessions'::regclass)
    and c.conname not in ('register_sessions_paired_device_id_fkey',
                          'register_sessions_opened_by_employee_id_fkey',
                          'register_sessions_closed_by_employee_id_fkey',
                          'orders_register_session_device_fkey');

  if v_count <> 0 then
    raise exception 'F1B: % unexpected foreign key(s) touch register_sessions', v_count;
  end if;

  select c.oid into v_oid
  from pg_class c
  where c.oid = to_regclass('public.register_sessions_one_open_per_device');

  if v_oid is null or not exists (
    select 1 from pg_index i
    where i.indexrelid = v_oid
      and i.indrelid = 'public.register_sessions'::regclass
      and i.indisunique
      and i.indnatts = 1
      and (select a.attname from pg_attribute a
           where a.attrelid = i.indrelid and a.attnum = i.indkey[0]) = 'paired_device_id'
      and i.indpred is not null
  ) then
    raise exception 'F1B: register_sessions_one_open_per_device must be UNIQUE on (paired_device_id) and partial';
  end if;

  select pg_get_expr(i.indpred, i.indrelid) into v_expr
  from pg_index i where i.indexrelid = v_oid;

  for v_row in
    select * from (values (null::timestamptz, true), (v_t0, false)) as x(closed, included)
  loop
    execute format('select (%s) is true from (select $1::timestamptz as closed_at) as register_sessions', v_expr)
    into v_ok using v_row.closed;

    if v_ok is distinct from v_row.included then
      raise exception 'F1B: the one-open predicate is not exactly "closed_at is null"';
    end if;
  end loop;

  -- ==========================================================================
  -- A5. orders attribution: nullable, no default, no backfill, structural check.
  -- ==========================================================================
  select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' ||
                    case when a.attnotnull then 'not null' else 'null' end || ':' ||
                    case when a.atthasdef then 'default' else '' end,
                    ',' order by a.attname)
  into v_text
  from pg_attribute a
  where a.attrelid = 'public.orders'::regclass
    and a.attname in ('employee_id', 'paired_device_id', 'register_session_id')
    and not a.attisdropped;

  if v_text is distinct from
     'employee_id:uuid:null:,paired_device_id:uuid:null:,register_session_id:uuid:null:' then
    raise exception 'F1B: orders attribution columns are not nullable, defaultless uuids: %', v_text;
  end if;

  select count(*) into v_count
  from public.orders o
  where o.employee_id is not null
     or o.paired_device_id is not null
     or o.register_session_id is not null;

  if v_count <> 0 then
    raise exception 'F1B: % existing order(s) were given an attribution; nothing may be backfilled', v_count;
  end if;

  select pg_get_expr(c.conbin, c.conrelid) into v_expr
  from pg_constraint c
  where c.conrelid = 'public.orders'::regclass
    and c.conname = 'orders_register_session_requires_device'
    and c.contype = 'c';

  if v_expr is null then
    raise exception 'F1B: orders_register_session_requires_device is missing';
  end if;

  for v_row in
    select * from (values
      (null::uuid, null::uuid, true),
      ('00000000-0000-0000-0000-00000000000b'::uuid, null, true),
      (null, '00000000-0000-0000-0000-00000000000c'::uuid, false),
      ('00000000-0000-0000-0000-00000000000b'::uuid, '00000000-0000-0000-0000-00000000000c'::uuid, true)
    ) as x(device, register, accepted)
  loop
    execute format(
      'select (%s) is not false from (select $1::uuid as paired_device_id, $2::uuid as register_session_id) as orders',
      v_expr)
    into v_ok using v_row.device, v_row.register;

    if v_ok is distinct from v_row.accepted then
      raise exception 'F1B: orders_register_session_requires_device does not mean "no register without a device"';
    end if;
  end loop;

  -- Semantic, not textual: key columns in order, DESC flags, not unique, and a
  -- predicate that is exactly "<column> is not null".
  for v_row in
    select * from (values
      ('orders_employee_created_idx', array['employee_id', 'created_at'], array[0, 1], 'employee_id'),
      ('orders_paired_device_created_idx', array['paired_device_id', 'created_at'], array[0, 1], 'paired_device_id'),
      ('orders_register_session_idx', array['register_session_id'], array[0], 'register_session_id')
    ) as x(idx, cols, descs, predcol)
  loop
    v_oid := to_regclass(format('public.%I', v_row.idx));

    if v_oid is null or not exists (
      select 1 from pg_index i
      where i.indexrelid = v_oid
        and i.indrelid = 'public.orders'::regclass
        and not i.indisunique
        and i.indnatts = cardinality(v_row.cols)
        and i.indexprs is null
        and array(select a.attname::text
                  from unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
                  join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
                  order by k.ord) = v_row.cols
        and array(select (o.opt & 1)::integer
                  from unnest(i.indoption::int2[]) with ordinality as o(opt, ord)
                  order by o.ord) = v_row.descs
        and i.indpred is not null
    ) then
      raise exception 'F1B: index % is missing or not on % with the approved order', v_row.idx, v_row.cols;
    end if;

    select pg_get_expr(i.indpred, i.indrelid) into v_expr
    from pg_index i where i.indexrelid = v_oid;

    foreach v_ok in array array[false, true]
    loop
      execute format('select (%s) is true from (select $1::uuid as %I) as orders', v_expr, v_row.predcol)
      into v_hit
      using case when v_ok then '00000000-0000-0000-0000-00000000000d'::uuid end;

      if v_hit is distinct from v_ok then
        raise exception 'F1B: the predicate of % is not exactly "% is not null"', v_row.idx, v_row.predcol;
      end if;
    end loop;
  end loop;

  -- ==========================================================================
  -- A6. register_sessions is RPC-only.
  -- ==========================================================================
  if not (select c.relrowsecurity from pg_class c
          where c.oid = 'public.register_sessions'::regclass) then
    raise exception 'F1B: row level security is off on register_sessions';
  end if;

  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'register_sessions') then
    raise exception 'F1B: register_sessions must carry no policy';
  end if;

  foreach v_role in array array['anon', 'authenticated', 'service_role']
  loop
    foreach v_text in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
                                  'REFERENCES', 'TRIGGER']
    loop
      if has_table_privilege(v_role, 'public.register_sessions', v_text) then
        raise exception 'F1B: % holds % on register_sessions', v_role, v_text;
      end if;
    end loop;
  end loop;

  if exists (
    select 1
    from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) as a
    where c.oid = 'public.register_sessions'::regclass
      and a.grantee = 0
  ) then
    raise exception 'F1B: PUBLIC holds a privilege on register_sessions';
  end if;

  if exists (
    select 1 from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'register_sessions'
      and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')
  ) then
    raise exception 'F1B: a column privilege exists on register_sessions';
  end if;

  -- ==========================================================================
  -- A7. The four new functions: SECURITY DEFINER, exact search_path,
  -- authenticated only, volatility as designed.
  -- ==========================================================================
  foreach v_sig in array v_public_sigs
  loop
    if to_regprocedure(v_sig) is null then
      raise exception 'F1B: % is missing', v_sig;
    end if;

    v_oid := to_regprocedure(v_sig)::oid;

    if not (select p.prosecdef from pg_proc p where p.oid = v_oid) then
      raise exception 'F1B: % must be SECURITY DEFINER', v_sig;
    end if;

    if (select count(*) from pg_proc p, unnest(coalesce(p.proconfig, array[]::text[])) as cfg
        where p.oid = v_oid) <> 1
       or not exists (
         select 1 from pg_proc p, unnest(p.proconfig) as cfg
         where p.oid = v_oid
           and regexp_replace(cfg, '[\s"]', '', 'g') = 'search_path=public,pg_temp'
       ) then
      raise exception 'F1B: % must lock search_path to exactly public, pg_temp', v_sig;
    end if;

    if (select p.provolatile::text from pg_proc p where p.oid = v_oid)
       is distinct from case when v_sig = 'public.get_current_register_session()' then 's' else 'v' end then
      raise exception 'F1B: % has the wrong volatility', v_sig;
    end if;

    if not has_function_privilege('authenticated', v_oid, 'EXECUTE') then
      raise exception 'F1B: authenticated must be able to execute %', v_sig;
    end if;

    foreach v_role in array array['anon', 'service_role']
    loop
      if has_function_privilege(v_role, v_oid, 'EXECUTE') then
        raise exception 'F1B: % must NOT be able to execute %', v_role, v_sig;
      end if;
    end loop;

    if exists (
      select 1
      from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as a
      where p.oid = v_oid and a.grantee = 0 and a.privilege_type = 'EXECUTE'
    ) then
      raise exception 'F1B: PUBLIC must NOT be able to execute %', v_sig;
    end if;
  end loop;

  -- Exactly one complete_sale_v5, and it takes no project and no employee id.
  select count(*) into v_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'complete_sale_v5';

  if v_count <> 1 then
    raise exception 'F1B: expected exactly one complete_sale_v5, found %', v_count;
  end if;

  if exists (
    select 1 from pg_proc p, unnest(p.proargnames) as arg
    where p.oid = to_regprocedure(v_public_sigs[4])
      and arg in ('p_project_id', 'p_employee_id', 'p_paired_device_id', 'p_device_id', 'p_owner_id')
  ) then
    raise exception 'F1B: complete_sale_v5 accepts an identity it must derive';
  end if;

  -- ==========================================================================
  -- A8. complete_sale_v5 keeps v4's contract and adds exactly the approved one.
  -- ==========================================================================
  v_def := pg_get_functiondef(to_regprocedure(v_public_sigs[4]));

  foreach v_text in array array[
    'where d.auth_user_id = v_caller' || chr(10) || '  for share;',
    'where p.id = v_project_id and p.user_id = v_owner_id' || chr(10) || '  for update;',
    '''posc.sale.v2'' || E''\n'' ||' || chr(10) || '    ''project='' || v_project_id::text || E''\n'' ||',
    'where o.project_id = v_project_id' || chr(10) || '    and o.sale_request_id = p_sale_request_id;',
    'v_is_owner := false;',
    'for share of s, e;',
    'raise exception ''The signed-in employee changed'';',
    'raise exception ''The register session changed'';',
    'raise exception ''The register is not open'';',
    'raise exception ''An employee must be signed in on this register'';',
    'if v_occurred_at >= v_device_revoked_at then',
    'raise exception ''This device is no longer paired'';',
    'c_clock_skew     constant interval := interval ''5 minutes'';',
    'c_offline_max_age constant interval := interval ''7 days'';',
    'v_employee_id, v_device_id, v_register_session_id',
    'order by oi.line_position nulls last,'
  ]
  loop
    if position(v_text in v_def) = 0 then
      raise exception 'F1B: complete_sale_v5 lost or never had: %', v_text;
    end if;
  end loop;

  -- The canonical preimage names no identity beyond the project.
  v_text := substring(v_def from '''posc\.sale\.v2''.*?encode\(sha256');

  if v_text is null
     or v_text ~ '(employee|register|device|session|v_caller|v_owner_id)' then
    raise exception 'F1B: the complete_sale_v5 sale hash must not include attribution';
  end if;

  if position('p_project_id' in v_def) > 0 then
    raise exception 'F1B: complete_sale_v5 still reads a project parameter';
  end if;

  -- Neither claim/expectation parameter is ever written to the order.
  if v_def ~ 'values \([^;]*p_(employee_pos|register)_session_id' then
    raise exception 'F1B: complete_sale_v5 copies a client-supplied id into the order';
  end if;

  -- The replay lookup precedes every attribution requirement.
  if position('select o.id, o.sale_request_hash into v_existing' in v_def)
     > position('for share of s, e;' in v_def) then
    raise exception 'F1B: complete_sale_v5 must look up a replay before requiring any current state';
  end if;

  -- Device lock before project lock.
  if position('for share;' in v_def) > position('for update;' in v_def) then
    raise exception 'F1B: complete_sale_v5 must lock the device before the project';
  end if;

  -- ==========================================================================
  -- A9. Live smoke calls, as a signed-in caller that is NOT a paired device.
  -- Each proves an argument rule runs, and runs before any lookup, without
  -- touching a row.
  -- ==========================================================================
  loop
    v_probe_sub := gen_random_uuid();
    exit when not exists (select 1 from public.paired_devices d where d.auth_user_id = v_probe_sub);
  end loop;

  if public.open_register_session(gen_random_uuid(), 0) ->> 'error' is distinct from 'not_authenticated'
     or public.get_current_register_session() ->> 'error' is distinct from 'not_authenticated'
     or public.close_register_session(gen_random_uuid()) ->> 'error' is distinct from 'not_authenticated' then
    raise exception 'F1B: a register RPC answered an anonymous caller';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_probe_sub::text, 'role', 'authenticated')::text, true);

  if auth.uid() is distinct from v_probe_sub then
    raise exception 'F1B: the smoke-call identity did not take effect';
  end if;

  for v_row in
    select * from (values
      ('12.345', 'invalid_opening_cash'),
      ('0.001', 'invalid_opening_cash'),
      ('-0.01', 'invalid_opening_cash'),
      ('NaN', 'invalid_opening_cash'),
      ('Infinity', 'invalid_opening_cash'),
      ('-Infinity', 'invalid_opening_cash'),
      ('10000000000.00', 'invalid_opening_cash'),
      (null, 'invalid_opening_cash'),
      ('0', 'not_paired'),
      ('12.34', 'not_paired'),
      ('12.340', 'not_paired'),
      ('9999999999.99', 'not_paired')
    ) as x(cash, expected)
  loop
    v_result := public.open_register_session(gen_random_uuid(), v_row.cash::numeric);

    if v_result ->> 'error' is distinct from v_row.expected then
      raise exception 'F1B: open_register_session(%) answered %, expected %', v_row.cash, v_result, v_row.expected;
    end if;
  end loop;

  if public.open_register_session(null, 0) ->> 'error' is distinct from 'invalid_request'
     or public.open_register_session('00000000-0000-0000-0000-000000000000', 0) ->> 'error'
        is distinct from 'invalid_request' then
    raise exception 'F1B: open_register_session accepted a missing request id';
  end if;

  if public.get_current_register_session() ->> 'error' is distinct from 'not_paired'
     or public.close_register_session(null) ->> 'error' is distinct from 'not_found'
     or public.close_register_session(gen_random_uuid()) ->> 'error' is distinct from 'not_paired' then
    raise exception 'F1B: a register RPC did not refuse a caller that is not a paired device';
  end if;

  for v_row in
    select * from (values
      ('bogus', 'Invalid sale source'),
      ('online', 'Project not found or access denied'),
      ('offline_queued', 'Project not found or access denied')
    ) as x(source, expected)
  loop
    begin
      perform public.complete_sale_v5(
        'cash', 0, '[{"itemId":"x","quantity":1}]'::jsonb, gen_random_uuid(),
        null, v_row.source, gen_random_uuid(), gen_random_uuid());
      raise exception 'F1B: complete_sale_v5 accepted a sale from a caller that is not a paired device';
    exception
      when raise_exception then
        if sqlerrm is distinct from v_row.expected then
          raise exception 'F1B: complete_sale_v5 (%) said "%", expected "%"', v_row.source, sqlerrm, v_row.expected;
        end if;
    end;
  end loop;

  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);

  if exists (select 1 from public.register_sessions) then
    raise exception 'F1B: register_sessions must be empty after this migration';
  end if;

  -- ==========================================================================
  -- B1. Every pre-existing function is byte-identical -- complete_sale through
  -- complete_sale_v4 by name -- and exactly four functions are new.
  -- ==========================================================================
  foreach v_sig in array v_legacy_sigs
  loop
    if not exists (select 1 from f1b_proc_baseline b where b.fn_oid = to_regprocedure(v_sig)::oid) then
      raise exception 'F1B: % was created or replaced by this migration', v_sig;
    end if;
  end loop;

  for v_row in select * from f1b_proc_baseline
  loop
    if not exists (select 1 from pg_proc p where p.oid = v_row.fn_oid)
       or (select md5(pg_get_functiondef(p.oid)) from pg_proc p where p.oid = v_row.fn_oid)
          is distinct from v_row.body
       or (select p.prosecdef from pg_proc p where p.oid = v_row.fn_oid)
          is distinct from v_row.prosecdef
       or (select p.provolatile::text from pg_proc p where p.oid = v_row.fn_oid)
          is distinct from v_row.volatile
       or (select coalesce(p.proconfig, array[]::text[]) from pg_proc p where p.oid = v_row.fn_oid)
          is distinct from v_row.config
       or (select coalesce(p.proacl::text, 'default') from pg_proc p where p.oid = v_row.fn_oid)
          is distinct from v_row.acl then
      raise exception 'F1B: function %(%) changed or was dropped', v_row.proname, v_row.args;
    end if;
  end loop;

  select array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text collate "C") into v_names
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f'
    and p.oid not in (select fn_oid from f1b_proc_baseline);

  if v_names is distinct from array(
       select to_regprocedure(s)::regprocedure::text as sig from unnest(v_public_sigs) s
       order by sig collate "C") then
    raise exception 'F1B: new functions are %, expected exactly the four approved RPCs', v_names;
  end if;

  -- ==========================================================================
  -- B2. Policies, table privileges, RLS and triggers are unchanged.
  -- ==========================================================================
  if exists (
    select 1
    from f1b_pol_baseline b
    full outer join (
      select tablename, policyname, cmd, qual, with_check, roles::text as roles
      from pg_policies where schemaname = 'public'
    ) c on c.tablename = b.tablename and c.policyname = b.policyname
    where c.policyname is null or b.policyname is null
       or c.cmd is distinct from b.cmd or c.qual is distinct from b.qual
       or c.with_check is distinct from b.with_check or c.roles is distinct from b.roles
  ) then
    raise exception 'F1B: public policies changed';
  end if;

  for v_row in select * from f1b_priv_baseline
  loop
    if has_table_privilege(v_row.rolname, format('public.%I', v_row.tablename), v_row.priv)
       is distinct from v_row.held then
      raise exception 'F1B: privilege % on % for % changed', v_row.priv, v_row.tablename, v_row.rolname;
    end if;
  end loop;

  if exists (
    select 1
    from f1b_rls_baseline b
    full outer join (
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and c.relname <> 'register_sessions'
    ) c on c.relname = b.relname
    where c.relname is null or b.relname is null
       or c.relrowsecurity is distinct from b.relrowsecurity
       or c.relforcerowsecurity is distinct from b.relforcerowsecurity
  ) then
    raise exception 'F1B: a table other than register_sessions appeared, vanished or changed RLS';
  end if;

  select array_agg(x order by x) into v_new_triggers
  from (
    select c.relname || '.' || t.tgname || ':' || t.tgtype::text || ':' || t.tgenabled::text || ':' || pr.proname as x
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc pr on pr.oid = t.tgfoid
    where n.nspname = 'public' and not t.tgisinternal
    except
    select b.relname || '.' || b.tgname || ':' || b.tgtype::text || ':' || b.tgenabled::text || ':' || b.proname
    from f1b_trg_baseline b
  ) s;

  if v_new_triggers is not null
     or (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and not t.tgisinternal)
        <> (select count(*) from f1b_trg_baseline) then
    raise exception 'F1B: triggers changed';
  end if;

  -- ==========================================================================
  -- B3. Indexes and constraints: every existing one unchanged, and exactly the
  -- approved ones added.
  -- ==========================================================================
  if exists (
    select 1 from f1b_idx_baseline b
    left join pg_indexes c on c.schemaname = 'public' and c.indexname = b.indexname
    where c.indexname is null or c.indexdef is distinct from b.indexdef
  ) then
    raise exception 'F1B: an existing index changed or was dropped';
  end if;

  select array_agg(c.indexname::text order by c.indexname collate "C") into v_names
  from pg_indexes c
  where c.schemaname = 'public'
    and c.indexname not in (select indexname from f1b_idx_baseline);

  if v_names is distinct from array[
       'orders_employee_created_idx',
       'orders_paired_device_created_idx',
       'orders_register_session_idx',
       'register_sessions_device_request_key',
       'register_sessions_id_device_key',
       'register_sessions_one_open_per_device',
       'register_sessions_pkey'] then
    raise exception 'F1B: new indexes are %', v_names;
  end if;

  if exists (
    select 1 from f1b_con_baseline b
    left join (
      select c.conrelid::regclass::text as tbl, c.conname, c.contype::text as contype,
             pg_get_constraintdef(c.oid) as def
      from pg_constraint c join pg_namespace n on n.oid = c.connamespace
      where n.nspname = 'public' and c.contype in ('c', 'f', 'p', 'u', 'x')
    ) c on c.tbl = b.tbl and c.conname = b.conname
    where c.conname is null or c.contype is distinct from b.contype or c.def is distinct from b.def
  ) then
    raise exception 'F1B: an existing constraint changed or was dropped';
  end if;

  select array_agg(cl.relname || '.' || c.conname order by cl.relname || '.' || c.conname collate "C")
  into v_names
  from pg_constraint c
  join pg_namespace n on n.oid = c.connamespace
  join pg_class cl on cl.oid = c.conrelid
  where n.nspname = 'public'
    and c.contype in ('c', 'f', 'p', 'u', 'x')
    and not exists (select 1 from f1b_con_baseline b
                    where b.tbl = c.conrelid::regclass::text and b.conname = c.conname);

  if v_names is distinct from array[
       'orders.orders_employee_id_fkey',
       'orders.orders_paired_device_id_fkey',
       'orders.orders_register_session_device_fkey',
       'orders.orders_register_session_requires_device',
       'register_sessions.register_sessions_closed_after_opened',
       'register_sessions.register_sessions_closed_by_employee_id_fkey',
       'register_sessions.register_sessions_closed_state',
       'register_sessions.register_sessions_device_request_key',
       'register_sessions.register_sessions_id_device_key',
       'register_sessions.register_sessions_opened_by_employee_id_fkey',
       'register_sessions.register_sessions_opening_cash_finite',
       'register_sessions.register_sessions_opening_cash_nonnegative',
       'register_sessions.register_sessions_opening_cash_scale',
       'register_sessions.register_sessions_paired_device_id_fkey',
       'register_sessions.register_sessions_pkey'] then
    raise exception 'F1B: new constraints are %', v_names;
  end if;

  -- ==========================================================================
  -- B4. Columns: only orders gained exactly three, and nothing else moved.
  -- ==========================================================================
  if exists (
    select 1 from f1b_col_baseline b
    left join information_schema.columns c
      on c.table_schema = 'public' and c.table_name = b.table_name and c.column_name = b.column_name
    where c.column_name is null
       or c.ordinal_position is distinct from b.ordinal_position
       or c.data_type is distinct from b.data_type
       or c.is_nullable is distinct from b.is_nullable
       or coalesce(c.column_default, '') is distinct from b.column_default
  ) then
    raise exception 'F1B: an existing column changed or was dropped';
  end if;

  select array_agg((c.table_name || '.' || c.column_name)::text
                   order by (c.table_name || '.' || c.column_name)::text collate "C") into v_names
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name <> 'register_sessions'
    and not exists (select 1 from f1b_col_baseline b
                    where b.table_name = c.table_name and b.column_name = c.column_name);

  if v_names is distinct from array['orders.employee_id', 'orders.paired_device_id',
                                    'orders.register_session_id'] then
    raise exception 'F1B: new columns outside register_sessions are %', v_names;
  end if;

  -- ==========================================================================
  -- B5. Rows: no order, line, stock, counter, project, device, employee or
  -- session row changed.
  -- ==========================================================================
  select * into v_row from f1b_row_baseline;

  if (select count(*) from public.orders) is distinct from v_row.orders
     or (select coalesce(md5(string_agg(md5((to_jsonb(o)
                  - array['employee_id', 'paired_device_id', 'register_session_id'])::text),
                  '|' order by o.id::text)), 'empty')
         from public.orders o) is distinct from v_row.orders_fp
     or (select count(*) from public.order_items) is distinct from v_row.order_items
     or (select coalesce(md5(string_agg(md5(i::text), '|' order by i.id::text)), 'empty')
         from public.order_items i) is distinct from v_row.order_items_fp
     or (select count(*) from public.inventory_transactions) is distinct from v_row.inventory_transactions
     or (select count(*) from public.project_order_counters) is distinct from v_row.counters
     or (select coalesce(md5(string_agg(md5(c::text), '|' order by c.project_id::text)), 'empty')
         from public.project_order_counters c) is distinct from v_row.counters_fp
     or (select coalesce(md5(string_agg(md5(p::text), '|' order by p.id::text)), 'empty')
         from public.projects p) is distinct from v_row.projects_fp
     or (select coalesce(md5(string_agg(md5(d::text), '|' order by d.id::text)), 'empty')
         from public.paired_devices d) is distinct from v_row.devices_fp
     or (select coalesce(md5(string_agg(md5(e::text), '|' order by e.id::text)), 'empty')
         from public.employees e) is distinct from v_row.employees_fp
     or (select coalesce(md5(string_agg(md5(s::text), '|' order by s.id::text)), 'empty')
         from public.employee_pos_sessions s) is distinct from v_row.sessions_fp then
    raise exception 'F1B: existing sale, inventory, project, device, employee or session rows changed';
  end if;

  raise notice 'F1B: register sessions and sale attribution created and verified.';
end
$do$;
