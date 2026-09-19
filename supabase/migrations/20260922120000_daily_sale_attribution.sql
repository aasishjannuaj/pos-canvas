-- v1.3 Checkpoint 2c — daily attribution for sales, online and queued.
--
-- FORWARD MIGRATION. Every earlier migration is accepted and immutable and
-- nothing here redefines any object any of them created, with ONE authorized
-- exception: complete_sale_v5, whose section 6d is replaced. This file adds:
--
--   * daily_register_context_for_sale(uuid, timestamptz)   (NEW, internal)
--   * complete_sale_v5(...)                                (section 6d only)
--
-- The signature, the security posture and the grants of complete_sale_v5 are
-- unchanged, and the verification block proves each of those against a baseline
-- captured in this same transaction. Pricing, tax, tip, modifiers, inventory,
-- the canonical hash, the idempotency lookup, every occurred_at bound and the
-- payload are untouched.
--
-- Apply manually, as ONE SQL Editor submission (one session).
--
-- ----------------------------------------------------------------------------
-- WHAT A TILL KNOWS, AND WHAT THE SERVER DECIDES
-- ----------------------------------------------------------------------------
-- CP2b gave each till a daily register context: a business date and the exact
-- interval it covers. Until now nothing attributed a sale to one. This does.
--
-- The rule underneath every branch below is the same one: the ids a client
-- sends are never authority. Online they are concurrency EXPECTATIONS, and the
-- server compares them with what it computes. Offline they are historical
-- CLAIMS, and the server validates or discards them. CP2c adds one more thing
-- a claim can mean -- "this record was taken under the daily model" -- and that
-- is all it is allowed to mean. Which day a sale belongs to is derived, every
-- time, from an instant the server trusts.
--
-- ----------------------------------------------------------------------------
-- MIDNIGHT IS NOT AN INCIDENT
-- ----------------------------------------------------------------------------
-- A till left running overnight is the ordinary life of a till. Before this
-- change, an online sale whose expected register no longer matched the server's
-- was refused with "The register session changed" and the cashier had to
-- recover. Applied to a calendar that is exactly what would happen at 00:00,
-- every night, to every shop -- a queue of customers stopped by a clock.
--
-- So an expectation that names an OLDER business day of this same till is
-- accepted and rolled forward. Nobody logs out, nobody re-authenticates,
-- nobody opens anything. What is NOT accepted is an expectation that names a
-- LATER day than the server's own calendar, or a different row for the same
-- day: those are stale state or tampering, and they still refuse.
--
-- ----------------------------------------------------------------------------
-- REPLAY STILL COMES FIRST, AND THAT IS LOAD-BEARING
-- ----------------------------------------------------------------------------
-- Section 6's idempotency lookup is BEFORE section 6b's occurred_at rules and
-- before section 6d's attribution, and this migration does not move it. A sale
-- that already completed replays from its stored row: it does not resolve
-- today's daily context, does not create one, does not care that midnight has
-- passed, that the timezone has since been cleared, or that nobody is signed
-- in. Exactly-once is preserved because the second call never reaches any of
-- the code this migration touches.
--
-- ----------------------------------------------------------------------------
-- NOT IN THIS FILE
-- ----------------------------------------------------------------------------
-- No DeviceApp change, no cart change, no client midnight timer, no queue
-- schema or version change, no IndexedDB change, no financial hash change, no
-- employee-attribution redesign, and no new client parameter. Those are CP2d,
-- or they are not happening at all.

-- ----------------------------------------------------------------------------
-- 0. Self-capturing baselines, recorded BEFORE any DDL.
-- ----------------------------------------------------------------------------
create temporary table cp2c_proc_baseline as
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

-- complete_sale_v5 verbatim, so A5 can compare the replaced definition against
-- the accepted one line by line rather than as a digest.
create temporary table cp2c_v5_baseline as
select pg_get_functiondef(
         'public.complete_sale_v5(text,numeric,jsonb,uuid,timestamptz,text,uuid,uuid)'::regprocedure) as def,
       pg_get_function_identity_arguments(
         'public.complete_sale_v5(text,numeric,jsonb,uuid,timestamptz,text,uuid,uuid)'::regprocedure) as args;

create temporary table cp2c_pol_baseline as
select tablename, policyname, cmd, qual, with_check, roles::text as roles
from pg_policies
where schemaname = 'public';

create temporary table cp2c_priv_baseline as
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

create temporary table cp2c_con_baseline as
select c.conrelid::regclass::text as tbl, c.conname, c.contype::text as contype,
       pg_get_constraintdef(c.oid) as def
from pg_constraint c
join pg_namespace n on n.oid = c.connamespace
where n.nspname = 'public'
  and c.contype in ('c', 'f', 'p', 'u', 'x');

create temporary table cp2c_idx_baseline as
select tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public';

create temporary table cp2c_trg_baseline as
select c.relname, t.tgname, pg_get_triggerdef(t.oid) as def
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and not t.tgisinternal;

create temporary table cp2c_col_baseline as
select table_name, column_name, ordinal_position, data_type,
       is_nullable, coalesce(column_default, '') as column_default
from information_schema.columns
where table_schema = 'public';

-- NOTHING IS WRITTEN BY THIS MIGRATION. Not an order, not a register session,
-- not an order item.
create temporary table cp2c_row_baseline as
select (select count(*) from public.orders) as orders,
       (select coalesce(md5(string_agg(md5(o::text), '|' order by o.id::text)), 'empty')
        from public.orders o) as orders_fp,
       (select count(*) from public.order_items) as order_items,
       (select count(*) from public.register_sessions) as registers,
       (select coalesce(md5(string_agg(md5(r::text), '|' order by r.id::text)), 'empty')
        from public.register_sessions r) as registers_fp,
       (select count(*) from public.inventory_transactions) as inventory;

-- ----------------------------------------------------------------------------
-- 1. daily_register_context_for_sale(paired_device_id, at)
--
-- The daily context an instant falls inside, for one till -- found, or created
-- if this is the first sale of that business day.
--
-- WHY THIS EXISTS RATHER THAN A CALL TO CP2b's PUBLIC ensure. Two independent
-- reasons, either of which alone would be enough:
--
--   1. LOCK ORDER. ensure_daily_register_context() takes the device row FOR
--      UPDATE. complete_sale_v5 already holds that row FOR SHARE from its step
--      1, so calling it would be a lock UPGRADE -- and two concurrent sales on
--      the same till, each holding FOR SHARE and each wanting FOR UPDATE, is a
--      textbook deadlock. This helper takes NO device lock at all. It cannot:
--      see the precondition below.
--
--   2. IT WOULD ANSWER THE WRONG QUESTION. ensure uses clock_timestamp(). A
--      queued sale needs the day its occurred_at fell inside, which may be
--      yesterday, or last week. An instant has to be an argument.
--
-- IT IS NOT A WEAKER IMPLEMENTATION. The calendar helpers are CP2a's, the
-- find-or-create is CP2b's -- current-instant interval first, then by date --
-- the failure vocabulary is CP2b's, the uniqueness rule is CP2b's index, and
-- every row it writes goes through CP2b's BEFORE INSERT bounds validator like
-- any other. The sibling test suite asserts that this and the public ensure
-- return the SAME context for the same instant.
--
-- PRECONDITION, AND THE CALLER IS RESPONSIBLE FOR IT: the caller already holds
-- the paired_devices row (at least FOR SHARE) and the projects row. In
-- complete_sale_v5 those are steps 1 and 2, taken before anything here runs.
-- The project lock is FOR UPDATE there, which is strictly stronger than the
-- FOR SHARE CP2b uses: it pins the timezone for the whole call AND serializes
-- every sale in the project, so two concurrent sales cannot both be creating
-- the same daily row. The unique_violation branch below is the backstop
-- anyway, because a precondition stated in a comment is not a guarantee.
--
-- NO CLIENT AUTHORITY. Both arguments are server-derived at the only call site
-- there is -- the device from auth.uid(), the instant from now() or from an
-- occurred_at that section 6b has already validated -- and EXECUTE is granted
-- to nobody, so no client can reach it with anything at all.
--
-- SECURITY INVOKER, for the CP2a/CP2b reason: its only caller is already
-- running as this function's owner, so elevation would buy nothing and would
-- create another privileged entry point. The locked search_path stays.
-- ----------------------------------------------------------------------------
create or replace function public.daily_register_context_for_sale(
  p_paired_device_id uuid,
  p_at timestamptz,
  out register_session_id uuid,
  out failure text
)
language plpgsql
set search_path = public, pg_catalog, pg_temp
as $function$
declare
  v_project_id uuid;
  v_timezone text;
  v_business_date date;
  v_bounds record;
  v_existing record;
begin
  register_session_id := null;
  failure := null;

  select d.project_id into v_project_id
  from public.paired_devices d
  where d.id = p_paired_device_id;

  if not found then
    -- Unreachable from complete_sale_v5, which resolved this device row itself.
    failure := 'not_paired';
    return;
  end if;

  -- CP2a's contract, called as the owner of both functions.
  begin
    v_timezone := public.require_business_timezone(v_project_id);
  exception
    when invalid_parameter_value then
      if sqlerrm <> 'business_timezone_required' then
        raise;
      end if;

      failure := 'business_timezone_required';
      return;
  end;

  v_business_date := public.business_date_of(p_at, v_timezone);

  if v_business_date is null then
    failure := 'business_timezone_required';
    return;
  end if;

  select b.starts_at, b.ends_at
  into v_bounds
  from public.business_day_bounds(v_business_date, v_timezone) b;

  if not found then
    failure := 'business_timezone_required';
    return;
  end if;

  -- CP2b's order: the interval containing the instant first, because a timezone
  -- change can move the DATE as well as the bounds and a by-date search would
  -- then miss an existing context and overlap it.
  select r.id, r.business_date, r.business_timezone, r.opened_at, r.closed_at
  into v_existing
  from public.register_sessions r
  where r.paired_device_id = p_paired_device_id
    and r.business_date is not null
    and r.opened_at <= p_at
    and p_at < r.closed_at;

  if found then
    if v_existing.business_date is distinct from v_business_date
       or v_existing.business_timezone is distinct from v_timezone
       or v_existing.opened_at is distinct from v_bounds.starts_at
       or v_existing.closed_at is distinct from v_bounds.ends_at then
      failure := 'daily_register_timezone_conflict';
      return;
    end if;

    register_session_id := v_existing.id;
    return;
  end if;

  select r.id, r.business_date, r.business_timezone, r.opened_at, r.closed_at
  into v_existing
  from public.register_sessions r
  where r.paired_device_id = p_paired_device_id
    and r.business_date = v_business_date;

  if found then
    if v_existing.business_timezone is distinct from v_timezone
       or v_existing.opened_at is distinct from v_bounds.starts_at
       or v_existing.closed_at is distinct from v_bounds.ends_at then
      failure := 'daily_register_timezone_conflict';
      return;
    end if;

    register_session_id := v_existing.id;
    return;
  end if;

  -- ONE DAY, NOT A BRIDGE. Only the day the instant falls inside is created. A
  -- till that slept from the 18th to the 20th gets the 20th; the 19th is not
  -- manufactured, because no sale happened on the 19th.
  begin
    insert into public.register_sessions (
      paired_device_id, opened_by_employee_id, opened_at, opening_cash,
      open_request_id, closed_at, closed_by_employee_id,
      business_date, business_timezone
    )
    values (
      p_paired_device_id, null, v_bounds.starts_at, 0.00,
      null, v_bounds.ends_at, null,
      v_business_date, v_timezone
    )
    returning id into register_session_id;
  exception
    when unique_violation then
      -- Another transaction created this day's context first. It wanted the
      -- same context, so its row is the answer, not an error.
      select r.id, r.business_date, r.business_timezone, r.opened_at, r.closed_at
      into v_existing
      from public.register_sessions r
      where r.paired_device_id = p_paired_device_id
        and r.business_date = v_business_date;

      if not found then
        raise;
      end if;

      if v_existing.business_timezone is distinct from v_timezone
         or v_existing.opened_at is distinct from v_bounds.starts_at
         or v_existing.closed_at is distinct from v_bounds.ends_at then
        failure := 'daily_register_timezone_conflict';
        register_session_id := null;
        return;
      end if;

      register_session_id := v_existing.id;
  end;
end;
$function$;

revoke all on function public.daily_register_context_for_sale(uuid, timestamptz) from public;
revoke all on function public.daily_register_context_for_sale(uuid, timestamptz) from anon;
revoke all on function public.daily_register_context_for_sale(uuid, timestamptz) from authenticated;
revoke all on function public.daily_register_context_for_sale(uuid, timestamptz) from service_role;

comment on function public.daily_register_context_for_sale(uuid, timestamptz) is
  'v1.3 CP2c -- INTERNAL. The daily register context an instant falls inside for one '
  'till, found or created under CP2b''s rules. Callable by no client role. Its caller '
  'must already hold the paired_devices row (>= FOR SHARE) and the projects row; it '
  'takes neither, because complete_sale_v5 holds both and upgrading the device lock '
  'would deadlock two concurrent sales on the same till.';

-- ----------------------------------------------------------------------------
-- 2. complete_sale_v5 -- SECTION 6d ONLY.
--
-- The accepted definition, reproduced with its section 6d register logic
-- replaced and four declarations added. Everything else is character for
-- character what 20260917120000 created: the same signature, the same
-- SECURITY DEFINER and search_path, the same argument validation, the same
-- canonical preimage and hash, the same idempotency lookup in the same place,
-- the same occurred_at rules, the same pricing, inventory, counter, insert and
-- payload. A5 proves that by comparing the two definitions line by line and
-- requiring every accepted line to survive, in order, modulo indentation.
--
-- The employee half of section 6d is untouched. A daily rollover does not log
-- anyone out, does not sign anyone in, and does not weaken the stale-employee
-- refusal by one comparison.
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

  -- v1.3 CP2c -- the DAILY register context.
  v_expected_daily record;
  v_daily record;
  v_daily_claim record;
  v_business_date date;
  v_current_zone text;
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

      -- ====================================================================
      -- v1.3 CP2c -- IS THE EXPECTATION A DAILY CONTEXT OF THIS DEVICE?
      --
      -- This single lookup decides which of two worlds the sale is in, and it
      -- is deliberately narrow: the row must exist, belong to THIS device, and
      -- carry a business_date. Anything else -- an unknown id, a legacy drawer
      -- period, or ANOTHER device's daily context -- falls through to the
      -- accepted Feature 1B block below and is judged by the rules that were
      -- already there. A daily id from another till therefore authorizes
      -- nothing; it is simply not this device's register.
      -- ====================================================================
      select r.id, r.business_date, r.business_timezone, r.opened_at, r.closed_at
        into v_expected_daily
      from public.register_sessions r
      where r.id = p_register_session_id
        and r.paired_device_id = v_device_id
        and r.business_date is not null
      for share;

      if found then
        -- ==================================================================
        -- DAILY. The till named a business day; the server decides which
        -- business day it actually is.
        --
        -- CURRENTNESS IS NOT closed_at. A daily row is born with its end
        -- already set, so `closed_at is null` -- the legacy test, still used
        -- below -- would say every daily context is closed. What makes a daily
        -- context current is that it is the one the authoritative server
        -- instant falls inside, for this device, in the project's own zone.
        --
        -- SERVER TIME, NOT p_occurred_at. An online sale may not declare when
        -- it happened; section 6b already refused any attempt, and v_occurred_at
        -- is now() for this branch. The day is derived from the same clock.
        -- ==================================================================
        select c.register_session_id, c.failure
          into v_daily
        from public.daily_register_context_for_sale(v_device_id, v_occurred_at) c;

        if v_daily.failure is not null then
          -- The current context cannot be established safely. A NEW online sale
          -- is refused rather than attributed to a day nobody can name. CP2b's
          -- contract strings are raised verbatim so one vocabulary covers the
          -- whole feature; nothing historical is rewritten to make this pass.
          raise exception '%', v_daily.failure;
        end if;

        select r.business_date into v_business_date
        from public.register_sessions r
        where r.id = v_daily.register_session_id;

        if v_expected_daily.business_date > v_business_date then
          -- A FUTURE business day is never a rollover. Time does not run
          -- backwards, so an expectation ahead of the server's own calendar is
          -- a stale-state problem, not a midnight that has passed.
          raise exception 'The register session changed';
        end if;

        if v_expected_daily.business_date < v_business_date then
          -- ================================================================
          -- EXPECTED CALENDAR ROLLOVER. The till has been open across at least
          -- one midnight. That is the normal life of a till, not an incident:
          -- no cashier closed anything, nobody logged out, and there is nothing
          -- for anyone to recover. The sale is attributed to the day it is
          -- actually happening on.
          --
          -- HOW FAR BACK DOES NOT MATTER. A till that slept from the 18th to
          -- the 20th rolls straight to the 20th; the 19th is not manufactured
          -- to bridge the gap, because no sale happened on the 19th and an
          -- empty day invented by a sale would be a lie about the business.
          -- ================================================================
          null;
        elsif v_expected_daily.id is distinct from v_daily.register_session_id then
          -- Same business date, different daily row. Uniqueness on
          -- (paired_device_id, business_date) means this cannot happen today;
          -- it is checked anyway, because "cannot happen" is an argument about
          -- an index that some later migration could relax, and the safe answer
          -- if it ever does happen is to refuse.
          raise exception 'The register session changed';
        end if;

        v_register_session_id := v_daily.register_session_id;
      else
        -- ==================================================================
        -- LEGACY / MANUAL -- the accepted Feature 1B block, unchanged.
        --
        -- register_session close takes the device row FOR UPDATE, so the step-1
        -- lock already excludes it; this lock is the backstop for any future
        -- writer of this row.
        -- ==================================================================
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
        -- ==================================================================
        -- v1.3 CP2c -- THE CLAIM SIGNALS THE MODEL, NEVER THE ATTRIBUTION.
        --
        -- A queued sale carries whatever register id the till held when the
        -- money changed hands. If that id is a DAILY context of THIS device,
        -- it says one thing only: this record was taken under the daily model.
        -- It does NOT say which day the sale belongs to, and it must not,
        -- because a till that queued sales across midnight kept the same
        -- retained id on both sides of it. Honouring the id would file a
        -- 00:07 sale under yesterday.
        --
        -- So the day is DERIVED, from the already-accepted occurred_at and the
        -- project's own zone -- the same calendar rules, reaching a different
        -- day for a different instant. 23:58 and 00:07 on the same retained
        -- claim land on different business dates, which is the entire point.
        --
        -- ANOTHER DEVICE'S DAILY ID IS NOT A SIGNAL. The lookup is scoped to
        -- this device, so a foreign daily id falls through to the accepted
        -- historical validation below, which is scoped the same way and stores
        -- NULL. It can never manufacture attribution for this till.
        --
        -- AND THE ZONE IT WAS TAKEN UNDER MUST STILL BE THE BUSINESS'S ZONE.
        -- Deriving a day is only honest while the calendar has not moved
        -- underneath the sale; see the snapshot comparison below.
        -- ==================================================================
        select r.id, r.business_timezone
          into v_daily_claim
        from public.register_sessions r
        where r.id = p_register_session_id
          and r.paired_device_id = v_device_id
          and r.business_date is not null
        for share;

        if found then
          -- ================================================================
          -- THE SNAPSHOT IS PART OF THE CLAIM, AND IT IS CHECKED FIRST.
          --
          -- The claim carries the zone the till was operating under when the
          -- money changed hands. If the business has since changed zones, the
          -- day this sale belonged to was measured with a ruler nobody uses
          -- any more -- and deriving it now, with the new zone, would be
          -- REINTERPRETING a completed sale rather than recording it.
          --
          -- Waiting for daily_register_context_for_sale to notice is not
          -- enough, and that was the defect. Its conflict check only fires
          -- when an interval already covers the instant; for a past day with
          -- no context yet it would cheerfully CREATE one under the new zone,
          -- which is the incompatible historical row this whole design exists
          -- to prevent. So the comparison happens here, before it is called.
          --
          -- IDENTITY, NOT EQUIVALENCE. CP2a stores the zone verbatim and CP2b
          -- treats any changed snapshot as a conflict. A distinct string is a
          -- conflict here for the same reason: no alias canonicalization, no
          -- offset comparison, no normalization. Two spellings of the same
          -- offset are still two different answers to "what did this business
          -- call that day", and picking one would be inventing an answer.
          --
          -- The project row is already held FOR UPDATE by section 3, so this
          -- is a plain read of a pinned row -- no new lock, no lock order.
          -- A NULL current zone is distinct from the claim's (a daily row
          -- cannot have a null one), so the already-approved "no timezone now
          -- means unprovable" behaviour falls out of the same comparison.
          -- ================================================================
          select p.business_timezone
            into v_current_zone
          from public.projects p
          where p.id = v_project_id;

          if v_daily_claim.business_timezone is distinct from v_current_zone then
            -- UNPROVABLE, NOT INVALID. Nothing is created, nothing is
            -- rewritten, and the claim row is not touched.
            v_register_session_id := null;
          else
            select c.register_session_id, c.failure
              into v_daily
            from public.daily_register_context_for_sale(v_device_id, v_occurred_at) c;

            -- QUEUED MONEY IS NOT LOST TO AN AUDIT QUESTION. This sale was paid
            -- for, offline, before anything here was asked. If the historical day
            -- cannot be established safely -- no timezone now, or a snapshot that
            -- conflicts with one -- the register attribution is unprovable and is
            -- stored NULL, exactly as an unprovable legacy claim already is. The
            -- sale still completes. Nothing historical is rewritten to avoid this,
            -- and this excuses nothing financial: the hash, the totals, the
            -- pairing rules and every occurred_at bound have already been checked
            -- above and are not reached by this decision.
            v_register_session_id := v_daily.register_session_id;
          end if;
        else
          -- ==================================================================
          -- LEGACY / MANUAL, or a claim this device cannot own -- the accepted
          -- Feature 1B validation, unchanged.
          -- ==================================================================
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

-- GRANTS RESTATED EXACTLY AS ACCEPTED. `create or replace` preserves the ACL,
-- so these are the posture written down rather than a change; A6 asserts the
-- ACL is identical to the pre-migration one either way.
revoke all on function public.complete_sale_v5(text, numeric, jsonb, uuid, timestamptz, text, uuid, uuid) from public;
revoke all on function public.complete_sale_v5(text, numeric, jsonb, uuid, timestamptz, text, uuid, uuid) from anon;
revoke all on function public.complete_sale_v5(text, numeric, jsonb, uuid, timestamptz, text, uuid, uuid) from service_role;
grant execute on function public.complete_sale_v5(text, numeric, jsonb, uuid, timestamptz, text, uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 3. Verification -- fails loudly, and the whole migration rolls back with it.
-- ----------------------------------------------------------------------------
do $do$
declare
  v_text text;
  v_role text;
  v_count integer;
  v_old text[];
  v_new text[];
  v_i integer;
  v_matched integer;
  v_added text[] := array[]::text[];
  v_line text;
  v_helper_sig constant text := 'public.daily_register_context_for_sale(uuid,timestamptz)';
  v_v5_sig constant text :=
    'public.complete_sale_v5(text,numeric,jsonb,uuid,timestamptz,text,uuid,uuid)';
begin
  -- ==========================================================================
  -- A1. The internal helper: shape, posture, and callable by nobody.
  -- ==========================================================================
  select pg_get_function_identity_arguments(p.oid) into v_text
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'daily_register_context_for_sale';

  -- Both OUT parameters are part of what pg_get_function_identity_arguments
  -- prints for a function whose return type is built from them, so the whole
  -- string is asserted rather than the two inputs alone.
  if v_text is distinct from 'p_paired_device_id uuid, p_at timestamp with time zone, '
                             || 'OUT register_session_id uuid, OUT failure text' then
    raise exception 'CP2c: the helper takes %, not the two server-derived arguments.', v_text;
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'daily_register_context_for_sale'
      and p.prosecdef
  ) then
    raise exception 'CP2c: the helper is SECURITY DEFINER but its only caller already runs as its owner.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'daily_register_context_for_sale'
      and p.proconfig @> array['search_path=public, pg_catalog, pg_temp']
  ) then
    raise exception 'CP2c: the helper does not pin its search_path.';
  end if;

  if has_function_privilege('public', v_helper_sig, 'EXECUTE') then
    raise exception 'CP2c: PUBLIC can execute the internal helper.';
  end if;

  foreach v_role in array array['anon', 'authenticated', 'service_role']
  loop
    if has_function_privilege(v_role, v_helper_sig, 'EXECUTE') then
      raise exception 'CP2c: % can execute the internal helper.', v_role;
    end if;
  end loop;

  -- ==========================================================================
  -- A2. complete_sale_v5's PUBLIC CONTRACT is unchanged: same arguments, in
  -- the same order, with the same types. No client authority was added.
  -- ==========================================================================
  select pg_get_function_identity_arguments(v_v5_sig::regprocedure::oid) into v_text;

  if v_text is distinct from (select args from cp2c_v5_baseline) then
    raise exception 'CP2c: complete_sale_v5 arguments changed from % to %',
      (select args from cp2c_v5_baseline), v_text;
  end if;

  if v_text is distinct from
     'p_payment_method text, p_tip_amount numeric, p_items jsonb, p_sale_request_id uuid, '
     || 'p_occurred_at timestamp with time zone, p_source text, p_employee_pos_session_id uuid, '
     || 'p_register_session_id uuid' then
    raise exception 'CP2c: complete_sale_v5 signature is now %', v_text;
  end if;

  -- Spelled out as well as compared, because "unchanged" is worth failing on
  -- for the specific names this checkpoint was told never to introduce.
  foreach v_text in array array[
    'p_project_id', 'p_paired_device_id', 'p_business_date', 'p_timezone',
    'p_business_timezone', 'p_server_now', 'p_now', 'p_daily'
  ]
  loop
    if pg_get_function_identity_arguments(v_v5_sig::regprocedure::oid) like '%' || v_text || '%' then
      raise exception 'CP2c: complete_sale_v5 gained a client authority parameter: %', v_text;
    end if;
  end loop;

  -- ==========================================================================
  -- A3. Its security posture did not move.
  -- ==========================================================================
  if not exists (
    select 1 from pg_proc p
    where p.oid = v_v5_sig::regprocedure::oid
      and p.prosecdef
      and p.proconfig @> array['search_path=public, pg_temp']
  ) then
    raise exception 'CP2c: complete_sale_v5 is no longer SECURITY DEFINER with its locked search_path.';
  end if;

  if not has_function_privilege('authenticated', v_v5_sig, 'EXECUTE') then
    raise exception 'CP2c: authenticated lost EXECUTE on complete_sale_v5.';
  end if;

  foreach v_role in array array['public', 'anon', 'service_role']
  loop
    if has_function_privilege(v_role, v_v5_sig, 'EXECUTE') then
      raise exception 'CP2c: % gained EXECUTE on complete_sale_v5.', v_role;
    end if;
  end loop;

  if not exists (
    select 1 from cp2c_proc_baseline b
    where b.fn_oid = v_v5_sig::regprocedure::oid
      and b.acl = coalesce((select coalesce(p.proacl::text, 'default')
                            from pg_proc p where p.oid = v_v5_sig::regprocedure::oid), 'default')
      and b.prosecdef
      and b.volatile = (select p.provolatile::text from pg_proc p
                        where p.oid = v_v5_sig::regprocedure::oid)
  ) then
    raise exception 'CP2c: complete_sale_v5''s ACL, volatility or security posture changed.';
  end if;

  -- ==========================================================================
  -- A4. THE REPLAY ORDER IS UNCHANGED, and this is the assertion that matters
  -- most in this file.
  --
  -- The idempotency lookup must still come BEFORE the occurred_at rules and
  -- before the attribution block, in the text of the function, because that
  -- ordering is the only thing that makes a completed sale replayable after
  -- midnight, after a logout, and after the timezone is cleared. Line numbers
  -- rather than behaviour: behaviour is the test suite's job, and this is the
  -- cheap structural guard that fails immediately if anyone reorders it.
  -- ==========================================================================
  v_new := string_to_array(pg_get_functiondef(v_v5_sig::regprocedure::oid), chr(10));

  select min(i) into v_i
  from generate_subscripts(v_new, 1) i
  where v_new[i] like '%and o.sale_request_id = p_sale_request_id%';

  select min(i) into v_count
  from generate_subscripts(v_new, 1) i
  where v_new[i] like '%6b. Feature 24.5B%WHEN did this sale happen%';

  if v_i is null or v_count is null or v_i >= v_count then
    raise exception 'CP2c: the idempotency lookup no longer precedes the occurred_at rules.';
  end if;

  select min(i) into v_count
  from generate_subscripts(v_new, 1) i
  where v_new[i] like '%6d. v1.3 Feature 1B%sale attribution%';

  if v_count is null or v_i >= v_count then
    raise exception 'CP2c: the idempotency lookup no longer precedes the attribution block.';
  end if;

  -- And the daily helper is called only AFTER both, so a replay cannot reach it.
  select min(i) into v_i
  from generate_subscripts(v_new, 1) i
  where v_new[i] like '%daily_register_context_for_sale(v_device_id%';

  if v_i is null or v_i <= v_count then
    raise exception 'CP2c: the daily helper is reachable before the attribution block.';
  end if;

  -- ==========================================================================
  -- A5. EVERY ACCEPTED LINE SURVIVES, IN ORDER, MODULO INDENTATION.
  --
  -- The legacy blocks moved inside an `else`, so their leading whitespace
  -- changed and a byte comparison would be meaningless. Comparing trimmed
  -- lines in step is not: a single deleted or edited line strands the pointer
  -- and fails, which is the actual claim being made about pricing, hashing,
  -- idempotency, occurred_at, inventory and the payload.
  -- ==========================================================================
  v_old := string_to_array((select def from cp2c_v5_baseline), chr(10));
  v_i := 1;

  foreach v_line in array v_new
  loop
    if v_i <= array_length(v_old, 1) and btrim(v_line) = btrim(v_old[v_i]) then
      v_i := v_i + 1;
    else
      v_added := v_added || btrim(v_line);
    end if;
  end loop;

  v_matched := v_i - 1;

  if v_matched <> array_length(v_old, 1) then
    raise exception 'CP2c: only % of % accepted complete_sale_v5 lines survived, in order.',
      v_matched, array_length(v_old, 1);
  end if;

  if array_length(v_added, 1) is null then
    raise exception 'CP2c: complete_sale_v5 was not changed at all.';
  end if;

  -- ==========================================================================
  -- A6. Every OTHER pre-existing function is byte-identical -- every sale
  -- function before v5, both register RPCs, the employee layer, CP2a's
  -- calendar and CP2b's guards.
  -- ==========================================================================
  if exists (
    select 1
    from cp2c_proc_baseline b
    join pg_proc p on p.oid = b.fn_oid
    where p.oid <> v_v5_sig::regprocedure::oid
      and (md5(pg_get_functiondef(p.oid)) is distinct from b.body
       or p.prosecdef is distinct from b.prosecdef
       or p.provolatile::text is distinct from b.volatile
       or coalesce(p.proconfig, array[]::text[]) is distinct from b.config
       or coalesce(p.proacl::text, 'default') is distinct from b.acl)
  ) then
    select string_agg(b.proname || '(' || b.args || ')', ', ')
    into v_text
    from cp2c_proc_baseline b
    join pg_proc p on p.oid = b.fn_oid
    where p.oid <> v_v5_sig::regprocedure::oid
      and (md5(pg_get_functiondef(p.oid)) is distinct from b.body
       or p.prosecdef is distinct from b.prosecdef
       or p.provolatile::text is distinct from b.volatile
       or coalesce(p.proconfig, array[]::text[]) is distinct from b.config
       or coalesce(p.proacl::text, 'default') is distinct from b.acl);

    raise exception 'CP2c: pre-existing functions were modified: %', v_text;
  end if;

  if exists (select 1 from cp2c_proc_baseline b
             where not exists (select 1 from pg_proc p where p.oid = b.fn_oid)) then
    raise exception 'CP2c: a pre-existing function was dropped.';
  end if;

  foreach v_text in array array[
    'public.ensure_daily_register_context()',
    'public.close_register_session(uuid)',
    'public.open_register_session(uuid,numeric)',
    'public.get_current_register_session()',
    'public.require_business_timezone(uuid)',
    'public.business_day_bounds(date,text)',
    'public.business_date_of(timestamptz,text)',
    'public.complete_sale_v4(uuid,text,numeric,jsonb,uuid,timestamptz,text)'
  ]
  loop
    if not exists (
      select 1 from cp2c_proc_baseline b
      where b.fn_oid = v_text::regprocedure::oid
        and b.body = md5(pg_get_functiondef(v_text::regprocedure::oid))
    ) then
      raise exception 'CP2c: % is not byte-identical to its pre-migration definition.', v_text;
    end if;
  end loop;

  -- ==========================================================================
  -- A7. No schema change of any kind. CP2c is function bodies and nothing else.
  -- ==========================================================================
  if exists (
    select 1 from cp2c_con_baseline b
    full outer join (
      select c.conrelid::regclass::text as tbl, c.conname, c.contype::text as contype,
             pg_get_constraintdef(c.oid) as def
      from pg_constraint c
      join pg_namespace n on n.oid = c.connamespace
      where n.nspname = 'public' and c.contype in ('c', 'f', 'p', 'u', 'x')
    ) a on a.tbl = b.tbl and a.conname = b.conname
    where a.conname is null or b.conname is null or a.def is distinct from b.def
  ) then
    raise exception 'CP2c: a constraint changed.';
  end if;

  if exists (
    select 1 from cp2c_idx_baseline b
    full outer join (
      select tablename, indexname, indexdef from pg_indexes where schemaname = 'public'
    ) a on a.tablename = b.tablename and a.indexname = b.indexname
    where a.indexname is null or b.indexname is null or a.indexdef is distinct from b.indexdef
  ) then
    raise exception 'CP2c: an index changed.';
  end if;

  if exists (
    select 1 from cp2c_trg_baseline b
    full outer join (
      select c.relname, t.tgname, pg_get_triggerdef(t.oid) as def
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and not t.tgisinternal
    ) a on a.relname = b.relname and a.tgname = b.tgname
    where a.tgname is null or b.tgname is null or a.def is distinct from b.def
  ) then
    raise exception 'CP2c: a trigger changed.';
  end if;

  if exists (
    select 1 from cp2c_col_baseline b
    full outer join (
      select table_name, column_name, ordinal_position, data_type,
             is_nullable, coalesce(column_default, '') as column_default
      from information_schema.columns where table_schema = 'public'
    ) a on a.table_name = b.table_name and a.column_name = b.column_name
    where a.column_name is null or b.column_name is null
       or a.data_type is distinct from b.data_type
       or a.is_nullable is distinct from b.is_nullable
       or a.column_default is distinct from b.column_default
  ) then
    raise exception 'CP2c: a column changed.';
  end if;

  -- ==========================================================================
  -- A8. Privileges, RLS and policies across the schema are untouched, and no
  -- role gained direct access to register_sessions or orders.
  -- ==========================================================================
  if exists (
    select 1
    from cp2c_priv_baseline b
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
    raise exception 'CP2c: a table privilege changed.';
  end if;

  foreach v_role in array array['anon', 'authenticated', 'service_role']
  loop
    foreach v_text in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE']
    loop
      if has_table_privilege(v_role, 'public.register_sessions', v_text) then
        raise exception 'CP2c: % holds % on register_sessions.', v_role, v_text;
      end if;
    end loop;
  end loop;

  if exists (
    select 1 from cp2c_pol_baseline b
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
    raise exception 'CP2c: an RLS policy changed.';
  end if;

  -- ==========================================================================
  -- A9. NOT ONE ROW WAS WRITTEN. No order, no order item, no register session,
  -- no inventory transaction -- this migration replaces function bodies.
  -- ==========================================================================
  if exists (
    select 1 from cp2c_row_baseline b
    where b.orders is distinct from (select count(*) from public.orders)
       or b.orders_fp is distinct from
          (select coalesce(md5(string_agg(md5(o::text), '|' order by o.id::text)), 'empty')
           from public.orders o)
       or b.order_items is distinct from (select count(*) from public.order_items)
       or b.registers is distinct from (select count(*) from public.register_sessions)
       or b.registers_fp is distinct from
          (select coalesce(md5(string_agg(md5(r::text), '|' order by r.id::text)), 'empty')
           from public.register_sessions r)
       or b.inventory is distinct from (select count(*) from public.inventory_transactions)
  ) then
    raise exception 'CP2c: a row was created, changed or destroyed.';
  end if;

  raise notice 'CP2c verified: daily sale attribution, an unchanged public contract, and replay still first.';
end;
$do$;

drop table cp2c_proc_baseline;
drop table cp2c_v5_baseline;
drop table cp2c_pol_baseline;
drop table cp2c_priv_baseline;
drop table cp2c_con_baseline;
drop table cp2c_idx_baseline;
drop table cp2c_trg_baseline;
drop table cp2c_col_baseline;
drop table cp2c_row_baseline;
