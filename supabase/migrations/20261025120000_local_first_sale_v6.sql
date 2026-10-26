-- LF-2 Scope 2 (REPORT §16.4/§16.5) — immutable sale identity, own-build pricing,
-- original attribution, held uploads with owner review, device hold status.
--
-- DISABLED BY DEFAULT. Every new entry point refuses unless the business has
-- projects.local_first_enabled = true, which defaults to false and cannot be
-- changed through the API (trigger below). No existing business, client or
-- legacy RPC behaves differently after this migration:
--   * complete_sale, complete_sale_v2..v5, complete_sale_recovery_v1 and
--     get_device_sale_by_request_id are NOT redefined; their signatures,
--     grants and bodies are untouched.
--   * New orders columns are nullable and written only by complete_sale_v6 and
--     decide_sale_hold.
--   * The history tables are filled by AFTER triggers that never change the
--     row being written, plus a one-time backfill.
--
-- NOT DECIDED HERE (stated, not invented):
--   * R-5 default offline-selling limit: projects.offline_selling_limit has NO
--     default. NULL = "not set": no beyond-limit flag is computed, and the order
--     records that the policy was unset.
--   * R-4 re-linking of a till whose credential is invalid: nothing here binds
--     a new auth user to an existing pairing generation.
--   * R-2 security policy / offline authentication: no PINs, verifiers or local
--     sessions are provisioned. device_roster_acks exists for the removal rule
--     (§6.3) but has no writer RPC; ack_roster belongs to Scope 4.
--   * Negative stock stays OFF: the inventory step floors tracked stock at 0
--     and records the shortfall, exactly as complete_sale_v5 does offline.
--
-- STRUCTURED FAILURES (§11, K-4). Refusals raise with
--   message = a stable code, hint = 'lf_class=<class>', errcode =
--     LFS01  sale      — about this sale's content (O2: isolate this sale)
--     LFA01  authorization — about the device/caller, never about a sale (A2)
--     LFC01  capability — the business has not enabled this contract
-- A hold is not an error: it is returned as { status: 'held', ... }.

-- ============================================================================
-- 0. Feature switch and offline-limit setting (no API writer).
-- ============================================================================
alter table public.projects
  add column local_first_enabled boolean not null default false,
  add column offline_selling_limit text;

alter table public.projects
  add constraint projects_offline_selling_limit_check
  check (offline_selling_limit is null
         or offline_selling_limit = 'none'
         or offline_selling_limit ~ '^[1-9][0-9]{0,3}d$');

comment on column public.projects.local_first_enabled is
  'LF-2 Scope 2 — enables complete_sale_v6 and the held-sales RPCs for this business. '
  'Default false; not writable through the API (lf2_projects_switch_guard).';
comment on column public.projects.offline_selling_limit is
  'LF-2 Scope 2 — ''none'' or ''<N>d''. NULL = not set (R-5 open): no beyond-limit flag.';

create or replace function public.lf2_projects_switch_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- An API caller (any request with a JWT subject) may not turn the contract on
  -- or set the limit. Activation is a release step, not an owner toggle (yet).
  if auth.uid() is not null then
    if tg_op = 'INSERT' then
      if new.local_first_enabled or new.offline_selling_limit is not null then
        raise exception 'local_first_settings_not_writable'
          using errcode = 'LFC01', hint = 'lf_class=capability';
      end if;
    elsif new.local_first_enabled is distinct from old.local_first_enabled
       or new.offline_selling_limit is distinct from old.offline_selling_limit then
      raise exception 'local_first_settings_not_writable'
        using errcode = 'LFC01', hint = 'lf_class=capability';
    end if;
  end if;
  return new;
end;
$$;

create trigger lf2_projects_switch_guard
  before insert or update on public.projects
  for each row execute function public.lf2_projects_switch_guard();

-- ============================================================================
-- 1. orders: identity v3 and recorded facts (nullable; legacy rows untouched).
-- ============================================================================
alter table public.orders
  add column identity_version smallint,
  add column sale_identity_hash text,
  add column recorded_claims jsonb,
  add column lf_flags jsonb;

alter table public.orders
  add constraint orders_identity_v3_check
  check ((identity_version is null and sale_identity_hash is null)
         or (identity_version = 3 and sale_identity_hash ~ '^[0-9a-f]{64}$'));

-- ============================================================================
-- 2. History: device build pins, employee status, roster acknowledgements.
--    Append-only. A direct DELETE is refused; a cascade from the parent row
--    (which arrives through a referential-integrity trigger, depth > 0) is not.
-- ============================================================================
create or replace function public.lf2_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- A referential action (ON DELETE CASCADE / SET NULL from a parent row) arrives
  -- through an RI trigger, so it runs at depth > 1; a direct statement does not.
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception '% is append-only', tg_table_name;
end;
$$;

create table public.device_build_pins (
  paired_device_id uuid not null references public.paired_devices(id) on delete cascade,
  build_job_id uuid not null references public.build_jobs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  first_pinned_at timestamptz not null default now(),
  source text not null check (source in ('pairing', 'apply', 'backfill_current', 'backfill_order_history')),
  primary key (paired_device_id, build_job_id)
);

create table public.employee_roster_versions (
  project_id uuid primary key references public.projects(id) on delete cascade,
  version bigint not null default 0 check (version >= 0)
);

create table public.employee_status_events (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  event text not null check (event in ('baseline_active', 'baseline_inactive', 'created', 'deactivated', 'reactivated')),
  roster_version bigint not null check (roster_version > 0),
  occurred_at timestamptz not null default now(),
  unique (project_id, roster_version)
);
create index employee_status_events_employee_idx on public.employee_status_events (employee_id, roster_version);

create table public.device_roster_acks (
  paired_device_id uuid not null references public.paired_devices(id) on delete cascade,
  roster_version bigint not null check (roster_version > 0),
  acked_at timestamptz not null default now(),
  primary key (paired_device_id, roster_version)
);

create trigger lf2_append_only before update or delete on public.device_build_pins
  for each row execute function public.lf2_append_only();
create trigger lf2_append_only before update or delete on public.employee_status_events
  for each row execute function public.lf2_append_only();
create trigger lf2_append_only before update or delete on public.device_roster_acks
  for each row execute function public.lf2_append_only();

create or replace function public.lf2_record_build_pin()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' or new.build_job_id is distinct from old.build_job_id then
    insert into public.device_build_pins (paired_device_id, build_job_id, project_id, source)
    values (new.id, new.build_job_id, new.project_id, case when tg_op = 'INSERT' then 'pairing' else 'apply' end)
    on conflict (paired_device_id, build_job_id) do nothing;
  end if;
  return null;
end;
$$;

create trigger lf2_record_build_pin
  after insert or update of build_job_id on public.paired_devices
  for each row execute function public.lf2_record_build_pin();

create or replace function public.lf2_next_roster_version(p_project_id uuid)
returns bigint
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.employee_roster_versions as v (project_id, version)
  values (p_project_id, 1)
  on conflict (project_id) do update set version = v.version + 1
  returning version;
$$;

create or replace function public.lf2_record_employee_status()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.employee_status_events (project_id, employee_id, event, roster_version)
    values (new.project_id, new.id, case when new.active then 'created' else 'baseline_inactive' end,
            public.lf2_next_roster_version(new.project_id));
  elsif new.active is distinct from old.active then
    insert into public.employee_status_events (project_id, employee_id, event, roster_version)
    values (new.project_id, new.id, case when new.active then 'reactivated' else 'deactivated' end,
            public.lf2_next_roster_version(new.project_id));
  end if;
  return null;
end;
$$;

create trigger lf2_record_employee_status
  after insert or update of active on public.employees
  for each row execute function public.lf2_record_employee_status();

-- Backfill. Pins: the current pin, plus every build this device's own orders
-- were priced from (server-recorded evidence of earlier pins). Pins replaced
-- before this migration left no record and cannot be recovered.
insert into public.device_build_pins (paired_device_id, build_job_id, project_id, first_pinned_at, source)
select d.id, d.build_job_id, d.project_id, d.created_at, 'backfill_current'
from public.paired_devices d
on conflict do nothing;

insert into public.device_build_pins (paired_device_id, build_job_id, project_id, first_pinned_at, source)
select o.paired_device_id, o.build_job_id, o.project_id, min(o.created_at), 'backfill_order_history'
from public.orders o
join public.paired_devices d on d.id = o.paired_device_id and d.project_id = o.project_id
join public.build_jobs b on b.id = o.build_job_id and b.project_id = o.project_id
where o.paired_device_id is not null and o.build_job_id is not null
group by o.paired_device_id, o.build_job_id, o.project_id
on conflict do nothing;

-- Employee baseline: one event per existing employee, versions 1..n per project.
with ordered as (
  select e.id, e.project_id, e.active,
         row_number() over (partition by e.project_id order by e.created_at, e.id) as n
  from public.employees e
)
insert into public.employee_status_events (project_id, employee_id, event, roster_version, occurred_at)
select project_id, id, case when active then 'baseline_active' else 'baseline_inactive' end, n, now()
from ordered;

insert into public.employee_roster_versions (project_id, version)
select project_id, max(roster_version) from public.employee_status_events group by project_id
on conflict (project_id) do update set version = excluded.version;

-- ============================================================================
-- 3. Holds and decisions.
-- ============================================================================
create table public.sale_holds (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  paired_device_id uuid not null references public.paired_devices(id) on delete cascade,
  sale_request_id uuid not null,
  identity_hash text not null check (identity_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb not null,
  canonical text not null,
  reason text not null check (reason in (
    'after_revocation', 'after_unpair', 'identity_conflict', 'not_this_device',
    'identity_version_mismatch', 'build_not_pinned_by_device', 'price_mismatch',
    'time_out_of_bounds', 'attribution_after_removal_delivered', 'attribution_invalid',
    'unconfirmed_attempt')),
  detail jsonb not null default '{}'::jsonb,
  conflict_order_id uuid references public.orders(id) on delete set null,
  conflict_hold_id uuid references public.sale_holds(id) on delete set null,
  client_version text,
  received_at timestamptz not null default now(),
  state text not null default 'held' check (state in ('held', 'accepted', 'declined')),
  order_id uuid unique references public.orders(id) on delete set null,
  decided_at timestamptz,
  device_acknowledged_at timestamptz,
  unique (project_id, sale_request_id, identity_hash),
  check ((state = 'held') = (decided_at is null)),
  check (device_acknowledged_at is null or state <> 'held')
);
create index sale_holds_project_state_idx on public.sale_holds (project_id, state, received_at desc);

create table public.sale_hold_decisions (
  id bigint generated always as identity primary key,
  decision_id uuid not null unique,
  hold_id uuid not null references public.sale_holds(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  actor uuid not null,
  decision text not null check (decision in ('accept_as_recorded', 'accept_unattributed', 'record_as_separate', 'decline')),
  reason text not null check (btrim(reason) <> '' and length(reason) <= 1000),
  prior_state text not null,
  resulting_state text not null,
  resulting_order_id uuid references public.orders(id) on delete set null,
  decided_at timestamptz not null default now()
);
create index sale_hold_decisions_hold_idx on public.sale_hold_decisions (hold_id, decided_at);

create or replace function public.lf2_sale_holds_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if pg_trigger_depth() > 1 then
    -- A referential action from a parent row (account or business deletion).
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'sale_holds rows cannot be deleted';
  end if;
  -- Only state, order_id, decided_at and device_acknowledged_at may change.
  if (to_jsonb(new) - array['state', 'order_id', 'decided_at', 'device_acknowledged_at'])
     is distinct from (to_jsonb(old) - array['state', 'order_id', 'decided_at', 'device_acknowledged_at']) then
    raise exception 'sale_holds recorded facts are immutable';
  end if;
  if old.state <> 'held' and new.state is distinct from old.state then
    raise exception 'a decided hold cannot change state';
  end if;
  if old.order_id is not null and new.order_id is distinct from old.order_id then
    raise exception 'a hold''s order cannot change';
  end if;
  if old.device_acknowledged_at is not null and new.device_acknowledged_at is distinct from old.device_acknowledged_at then
    raise exception 'a hold acknowledgement cannot change';
  end if;
  return new;
end;
$$;

create trigger lf2_sale_holds_guard before update or delete on public.sale_holds
  for each row execute function public.lf2_sale_holds_guard();
create trigger lf2_append_only before update or delete on public.sale_hold_decisions
  for each row execute function public.lf2_append_only();

-- No direct access for API roles: everything goes through the RPCs below.
alter table public.device_build_pins enable row level security;
alter table public.employee_roster_versions enable row level security;
alter table public.employee_status_events enable row level security;
alter table public.device_roster_acks enable row level security;
alter table public.sale_holds enable row level security;
alter table public.sale_hold_decisions enable row level security;
revoke all on table public.device_build_pins, public.employee_roster_versions, public.employee_status_events,
  public.device_roster_acks, public.sale_holds, public.sale_hold_decisions from public, anon, authenticated;

-- ============================================================================
-- 4. Helpers (internal; EXECUTE revoked from API roles at the end).
-- ============================================================================
create or replace function public.lf2_fail(p_class text, p_code text, p_detail text default null)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception '%', p_code
    using errcode = case p_class when 'sale' then 'LFS01' when 'authorization' then 'LFA01' else 'LFC01' end,
          hint = 'lf_class=' || p_class,
          detail = coalesce(p_detail, '');
end;
$$;

-- complete_sale_v5's canonical line identity, unchanged (section 5 of v5).
create or replace function public.lf2_line_key(p_item_id text, p_mods jsonb)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select octet_length(p_item_id)::text || ':' || p_item_id ||
         '[' || jsonb_array_length(p_mods)::text || ']' ||
         coalesce((
           select string_agg(
                    octet_length(g.gid)::text || ':' || g.gid ||
                    '(' || g.optcount::text || ')' || g.opts,
                    '' order by g.gid collate "C")
           from (
             select btrim(m.value ->> 'groupId') as gid,
                    (select count(*) from jsonb_array_elements_text(m.value -> 'optionIds')) as optcount,
                    (select coalesce(string_agg(octet_length(o.value)::text || ':' || o.value, '' order by o.value collate "C"), '')
                     from jsonb_array_elements_text(m.value -> 'optionIds') o) as opts
             from jsonb_array_elements(p_mods) m
           ) g), '');
$$;

create or replace function public.lf2_money(p_value jsonb)
returns numeric
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare v numeric;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'string' or (p_value #>> '{}') !~ '^[0-9]{1,10}\.[0-9]{2}$' then
    return null;
  end if;
  v := (p_value #>> '{}')::numeric;
  return v;
end;
$$;

create or replace function public.lf2_uuid(p_value jsonb)
returns uuid
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  if p_value is null or jsonb_typeof(p_value) <> 'string'
     or (p_value #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  return (p_value #>> '{}')::uuid;
end;
$$;

create or replace function public.lf2_time(p_value jsonb)
returns timestamptz
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  if p_value is null or jsonb_typeof(p_value) <> 'string'
     or (p_value #>> '{}') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' then
    return null;
  end if;
  return (p_value #>> '{}')::timestamptz;
exception when others then
  return null;
end;
$$;

-- Validate and normalize an identity record (§7.3). Returns the canonical
-- object; raises sale_malformed_identity (LFS01) on anything malformed.
-- The canonical text is this object's jsonb text form; identity_hash =
-- sha256('posc.sale.v3' || E'\n' || canonical).
create or replace function public.lf2_normalize_identity(p_identity jsonb)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  c_max_items constant integer := 200;
  c_max_quantity constant integer := 10000;
  v_lines jsonb := '[]'::jsonb;
  v_line jsonb;
  v_mods jsonb;
  v_qty numeric;
  v_keys text[] := array[]::text[];
  v_key text;
  v_count integer;
  v_distinct integer;
  v_text text;
  bad text := null;
begin
  if p_identity is null or jsonb_typeof(p_identity) <> 'object' then
    perform public.lf2_fail('sale', 'sale_malformed_identity', 'identity must be an object');
  end if;
  if (p_identity -> 'identityVersion') is distinct from '3'::jsonb then bad := 'identityVersion'; end if;
  if bad is null and public.lf2_uuid(p_identity -> 'saleRequestId') is null then bad := 'saleRequestId'; end if;
  if bad is null and public.lf2_uuid(p_identity -> 'saleRequestId') = '00000000-0000-0000-0000-000000000000'::uuid then bad := 'saleRequestId'; end if;
  if bad is null and public.lf2_uuid(p_identity -> 'pairingGeneration') is null then bad := 'pairingGeneration'; end if;
  if bad is null and public.lf2_uuid(p_identity -> 'projectId') is null then bad := 'projectId'; end if;
  if bad is null and coalesce(p_identity ->> 'source', '') not in ('online', 'offline_queued') then bad := 'source'; end if;
  if bad is null and public.lf2_uuid(p_identity -> 'buildJobId') is null then bad := 'buildJobId'; end if;
  if bad is null and coalesce(p_identity ->> 'paymentMethod', '') not in ('cash', 'card') then bad := 'paymentMethod'; end if;
  if bad is null and public.lf2_time(p_identity -> 'occurredAt') is null then bad := 'occurredAt'; end if;
  if bad is null and public.lf2_uuid(p_identity -> 'employeeId') is null then bad := 'employeeId'; end if;
  if bad is null and public.lf2_uuid(p_identity -> 'localSessionId') is null then bad := 'localSessionId'; end if;
  if bad is null and public.lf2_time(p_identity -> 'sessionStartedAt') is null then bad := 'sessionStartedAt'; end if;
  if bad is null and p_identity ? 'serverSessionId' and jsonb_typeof(p_identity -> 'serverSessionId') <> 'null'
     and public.lf2_uuid(p_identity -> 'serverSessionId') is null then bad := 'serverSessionId'; end if;
  if bad is null and p_identity ? 'registerClaimId' and jsonb_typeof(p_identity -> 'registerClaimId') <> 'null'
     and public.lf2_uuid(p_identity -> 'registerClaimId') is null then bad := 'registerClaimId'; end if;
  if bad is null and p_identity ? 'registerDay' and jsonb_typeof(p_identity -> 'registerDay') <> 'null'
     and coalesce(p_identity ->> 'registerDay', '') !~ '^\d{4}-\d{2}-\d{2}$' then bad := 'registerDay'; end if;
  if bad is null and p_identity ? 'rosterVersionAtSale' and jsonb_typeof(p_identity -> 'rosterVersionAtSale') <> 'null'
     and (jsonb_typeof(p_identity -> 'rosterVersionAtSale') <> 'number'
          or (p_identity ->> 'rosterVersionAtSale') !~ '^[0-9]{1,15}$') then bad := 'rosterVersionAtSale'; end if;
  if bad is null and (jsonb_typeof(p_identity -> 'deviceSaleSeq') is distinct from 'number'
          or (p_identity ->> 'deviceSaleSeq') !~ '^[0-9]{1,15}$') then bad := 'deviceSaleSeq'; end if;
  if bad is null and (jsonb_typeof(p_identity -> 'clientVersion') is distinct from 'string'
          or length(p_identity ->> 'clientVersion') not between 1 and 64) then bad := 'clientVersion'; end if;
  if bad is null then
    foreach v_key in array array['subtotal', 'tax', 'tip', 'total'] loop
      if public.lf2_money(p_identity -> v_key) is null then bad := v_key; exit; end if;
    end loop;
  end if;
  if bad is null and (jsonb_typeof(p_identity -> 'lines') is distinct from 'array'
          or jsonb_array_length(p_identity -> 'lines') = 0
          or jsonb_array_length(p_identity -> 'lines') > c_max_items) then bad := 'lines'; end if;
  if bad is not null then
    perform public.lf2_fail('sale', 'sale_malformed_identity', bad);
  end if;

  for v_line in select value from jsonb_array_elements(p_identity -> 'lines') loop
    if jsonb_typeof(v_line) <> 'object' or coalesce(btrim(v_line ->> 'itemId'), '') = ''
       or length(v_line ->> 'itemId') > 200
       or public.lf2_money(v_line -> 'unitPrice') is null or public.lf2_money(v_line -> 'lineTotal') is null
       or jsonb_typeof(v_line -> 'quantity') is distinct from 'number' then
      perform public.lf2_fail('sale', 'sale_malformed_identity', 'line');
    end if;
    v_qty := (v_line ->> 'quantity')::numeric;
    if v_qty <> trunc(v_qty) or v_qty < 1 or v_qty > c_max_quantity then
      perform public.lf2_fail('sale', 'sale_malformed_identity', 'line.quantity');
    end if;
    v_mods := coalesce(v_line -> 'modifiers', '[]'::jsonb);
    if jsonb_typeof(v_mods) <> 'array' or jsonb_array_length(v_mods) > 10 then
      perform public.lf2_fail('sale', 'sale_malformed_identity', 'line.modifiers');
    end if;
    select count(*) into v_count
    from jsonb_array_elements(v_mods) m
    where jsonb_typeof(m.value) <> 'object' or coalesce(btrim(m.value ->> 'groupId'), '') = ''
       or jsonb_typeof(coalesce(m.value -> 'optionIds', '[]'::jsonb)) <> 'array'
       or jsonb_array_length(coalesce(m.value -> 'optionIds', '[]'::jsonb)) > 20
       or exists (select 1 from jsonb_array_elements(coalesce(m.value -> 'optionIds', '[]'::jsonb)) o
                  where jsonb_typeof(o.value) <> 'string' or coalesce(btrim(o.value #>> '{}'), '') = '');
    if v_count > 0 then
      perform public.lf2_fail('sale', 'sale_malformed_identity', 'line.modifiers');
    end if;
    -- normalize exactly as v5: drop empty groups, sort groups by id; options sorted too.
    select coalesce(jsonb_agg(jsonb_build_object(
             'groupId', btrim(m.value ->> 'groupId'),
             'optionIds', (select jsonb_agg(btrim(o.value) order by btrim(o.value) collate "C")
                           from jsonb_array_elements_text(m.value -> 'optionIds') o))
           order by btrim(m.value ->> 'groupId') collate "C"), '[]'::jsonb)
      into v_mods
    from jsonb_array_elements(v_mods) m
    where jsonb_array_length(coalesce(m.value -> 'optionIds', '[]'::jsonb)) > 0;
    select count(*), count(distinct m.value ->> 'groupId') into v_count, v_distinct from jsonb_array_elements(v_mods) m;
    if v_count <> v_distinct then
      perform public.lf2_fail('sale', 'sale_malformed_identity', 'line.modifiers.duplicateGroup');
    end if;
    select count(*) into v_count from jsonb_array_elements(v_mods) m
    where (select count(*) from jsonb_array_elements_text(m.value -> 'optionIds')) <>
          (select count(distinct o.value) from jsonb_array_elements_text(m.value -> 'optionIds') o);
    if v_count > 0 then
      perform public.lf2_fail('sale', 'sale_malformed_identity', 'line.modifiers.duplicateOption');
    end if;
    v_key := public.lf2_line_key(btrim(v_line ->> 'itemId'), v_mods);
    if v_key = any (v_keys) then
      perform public.lf2_fail('sale', 'sale_malformed_identity', 'line.duplicate');
    end if;
    v_keys := v_keys || v_key;
    v_lines := v_lines || jsonb_build_object(
      'itemId', btrim(v_line ->> 'itemId'),
      'modifiers', v_mods,
      'quantity', v_qty::integer,
      'unitPrice', v_line ->> 'unitPrice',
      'lineTotal', v_line ->> 'lineTotal');
  end loop;

  return jsonb_build_object(
    'identityVersion', 3,
    'saleRequestId', lower(p_identity ->> 'saleRequestId'),
    'pairingGeneration', lower(p_identity ->> 'pairingGeneration'),
    'projectId', lower(p_identity ->> 'projectId'),
    'source', p_identity ->> 'source',
    'buildJobId', lower(p_identity ->> 'buildJobId'),
    'lines', v_lines,
    'subtotal', p_identity ->> 'subtotal',
    'tax', p_identity ->> 'tax',
    'tip', p_identity ->> 'tip',
    'total', p_identity ->> 'total',
    'paymentMethod', p_identity ->> 'paymentMethod',
    'occurredAt', to_char(public.lf2_time(p_identity -> 'occurredAt') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'employeeId', lower(p_identity ->> 'employeeId'),
    'localSessionId', lower(p_identity ->> 'localSessionId'),
    'sessionStartedAt', to_char(public.lf2_time(p_identity -> 'sessionStartedAt') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'serverSessionId', lower(nullif(p_identity ->> 'serverSessionId', '')),
    'registerDay', nullif(p_identity ->> 'registerDay', ''),
    'registerClaimId', lower(nullif(p_identity ->> 'registerClaimId', '')),
    'rosterVersionAtSale', case when jsonb_typeof(p_identity -> 'rosterVersionAtSale') = 'number' then (p_identity ->> 'rosterVersionAtSale')::bigint end,
    'deviceSaleSeq', (p_identity ->> 'deviceSaleSeq')::bigint,
    'clientVersion', p_identity ->> 'clientVersion');
end;
$$;

-- complete_sale_v5's v2 preimage for the same sale, so a legacy call under the
-- same ID gets v5's existing answer (§7.3 "legacy hash too").
create or replace function public.lf2_v2_hash(p_project_id uuid, p_norm jsonb)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select encode(sha256(convert_to(
    'posc.sale.v2' || E'\n' ||
    'project=' || p_project_id::text || E'\n' ||
    'payment=' || (p_norm ->> 'paymentMethod') || E'\n' ||
    'tip=' || round((p_norm ->> 'tip')::numeric, 2)::text || E'\n' ||
    'items=' || jsonb_array_length(p_norm -> 'lines')::text ||
    coalesce(E'\n' || (
      select string_agg(public.lf2_line_key(l.value ->> 'itemId', l.value -> 'modifiers') || '=' || (l.value ->> 'quantity'),
                        E'\n' order by public.lf2_line_key(l.value ->> 'itemId', l.value -> 'modifiers') collate "C")
      from jsonb_array_elements(p_norm -> 'lines') l), ''),
    'UTF8')), 'hex');
$$;

-- Price normalized lines from one build's config_snapshot, with complete_sale_v5's
-- rules and rounding points (sections 7-9 of v5; stock is NOT read here).
-- Returns { ok, lines[{itemId,itemName,unitPrice,lineTotal,quantity,modifiers}],
-- subtotal, tax, tip, total } or { ok:false, error }.
create or replace function public.lf2_price_from_build(p_source jsonb, p_norm jsonb)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  c_max_money constant numeric := 9999999999.99;
  c_max_unit_price constant numeric := 1000000.00;
  v_price_items jsonb := coalesce(p_source -> 'menuItems', '[]'::jsonb);
  v_tax jsonb := coalesce(p_source -> 'tax', '{}'::jsonb);
  v_tax_enabled boolean; v_tax_inclusive boolean; v_rate numeric;
  v_item jsonb; v_item_id text; v_quantity integer; v_mods jsonb;
  v_price_item jsonb; v_item_name text; v_unit_price numeric; v_line_total numeric;
  v_mod_groups jsonb; v_mod_total numeric; v_mod_snapshot jsonb; v_mod_sel jsonb; v_group_id text;
  v_mod_group jsonb; v_sel_count integer; v_mod_opt_id text; v_mod_option jsonb; v_mod_adjust numeric;
  v_required_ok boolean;
  v_lines jsonb := '[]'::jsonb;
  v_subtotal numeric := 0; v_tax_amount numeric; v_total_before_tip numeric; v_tip numeric := 0; v_total numeric;
  i integer; j integer; k integer;
begin
  if jsonb_typeof(v_price_items) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'Pricing configuration is invalid');
  end if;
  begin v_tax_enabled := coalesce((v_tax ->> 'enabled')::boolean, true);
  exception when invalid_text_representation then v_tax_enabled := true; end;
  begin v_tax_inclusive := coalesce((v_tax ->> 'pricesIncludeTax')::boolean, false);
  exception when invalid_text_representation then v_tax_inclusive := false; end;
  begin v_rate := coalesce((v_tax ->> 'rate')::numeric, 0);
  exception when invalid_text_representation then v_rate := 0; end;
  if v_rate is null or v_rate::text in ('NaN', 'Infinity', '-Infinity') then v_rate := 0;
  elsif v_rate < 0 then v_rate := 0;
  elsif v_rate > 100 then v_rate := 100; end if;

  for v_item in select value from jsonb_array_elements(p_norm -> 'lines') loop
    v_item_id := v_item ->> 'itemId';
    v_quantity := (v_item ->> 'quantity')::integer;
    v_mods := coalesce(v_item -> 'modifiers', '[]'::jsonb);
    v_price_item := null;
    for i in 0 .. jsonb_array_length(v_price_items) - 1 loop
      if v_price_items -> i ->> 'id' = v_item_id then v_price_item := v_price_items -> i; exit; end if;
    end loop;
    if v_price_item is null then
      return jsonb_build_object('ok', false, 'error', format('Menu item %s is not in this build', v_item_id));
    end if;
    v_item_name := btrim(coalesce(v_price_item ->> 'name', ''));
    if v_item_name = '' then
      return jsonb_build_object('ok', false, 'error', format('Menu item %s is not available', v_item_id));
    end if;
    begin v_unit_price := (v_price_item ->> 'price')::numeric;
    exception when invalid_text_representation then
      return jsonb_build_object('ok', false, 'error', format('Menu item %s has an invalid price', v_item_id)); end;
    if v_unit_price is null or v_unit_price::text in ('NaN', 'Infinity', '-Infinity') or v_unit_price < 0 or v_unit_price > c_max_unit_price then
      return jsonb_build_object('ok', false, 'error', format('Menu item %s has an invalid price', v_item_id));
    end if;
    v_mod_groups := coalesce(v_price_item -> 'modifierGroups', '[]'::jsonb);
    if jsonb_typeof(v_mod_groups) <> 'array' then v_mod_groups := '[]'::jsonb; end if;
    v_mod_total := 0;
    v_mod_snapshot := '[]'::jsonb;
    if jsonb_array_length(v_mod_groups) = 0 and jsonb_array_length(v_mods) > 0 then
      return jsonb_build_object('ok', false, 'error', format('Menu item %s does not have options', v_item_id));
    end if;
    for j in 0 .. jsonb_array_length(v_mods) - 1 loop
      v_mod_sel := v_mods -> j;
      v_group_id := btrim(v_mod_sel ->> 'groupId');
      v_mod_group := null;
      for k in 0 .. jsonb_array_length(v_mod_groups) - 1 loop
        if v_mod_groups -> k ->> 'id' = v_group_id then v_mod_group := v_mod_groups -> k; exit; end if;
      end loop;
      if v_mod_group is null then
        return jsonb_build_object('ok', false, 'error', format('Menu item %s does not have that option group', v_item_id));
      end if;
      v_sel_count := jsonb_array_length(coalesce(v_mod_sel -> 'optionIds', '[]'::jsonb));
      if coalesce(v_mod_group ->> 'selection', 'single') = 'single' and v_sel_count > 1 then
        return jsonb_build_object('ok', false, 'error', format('Only one option may be chosen for %s', coalesce(v_mod_group ->> 'name', v_group_id)));
      end if;
      if coalesce(v_mod_group ->> 'selection', 'single') = 'multiple'
         and v_mod_group -> 'maxSelections' is not null and jsonb_typeof(v_mod_group -> 'maxSelections') = 'number'
         and v_sel_count > (v_mod_group ->> 'maxSelections')::integer then
        return jsonb_build_object('ok', false, 'error', format('Too many options chosen for %s', coalesce(v_mod_group ->> 'name', v_group_id)));
      end if;
      for k in 0 .. v_sel_count - 1 loop
        v_mod_opt_id := btrim(v_mod_sel -> 'optionIds' ->> k);
        v_mod_option := null;
        for i in 0 .. jsonb_array_length(coalesce(v_mod_group -> 'options', '[]'::jsonb)) - 1 loop
          if v_mod_group -> 'options' -> i ->> 'id' = v_mod_opt_id then v_mod_option := v_mod_group -> 'options' -> i; exit; end if;
        end loop;
        if v_mod_option is null then
          return jsonb_build_object('ok', false, 'error', format('That option is not available for %s', coalesce(v_mod_group ->> 'name', v_group_id)));
        end if;
        begin v_mod_adjust := (v_mod_option ->> 'priceAdjustment')::numeric;
        exception when invalid_text_representation then
          return jsonb_build_object('ok', false, 'error', format('An option for %s has an invalid price', v_item_id)); end;
        if v_mod_adjust is null or v_mod_adjust::text in ('NaN', 'Infinity', '-Infinity') or v_mod_adjust < 0 or v_mod_adjust > c_max_unit_price then
          return jsonb_build_object('ok', false, 'error', format('An option for %s has an invalid price', v_item_id));
        end if;
        v_mod_total := v_mod_total + v_mod_adjust;
        v_mod_snapshot := v_mod_snapshot || jsonb_build_object(
          'groupId', v_group_id, 'groupName', coalesce(v_mod_group ->> 'name', ''),
          'optionId', v_mod_opt_id, 'optionName', coalesce(v_mod_option ->> 'name', ''),
          'priceAdjustment', round(v_mod_adjust, 2)::text);
      end loop;
    end loop;
    for k in 0 .. jsonb_array_length(v_mod_groups) - 1 loop
      if (v_mod_groups -> k ->> 'required')::boolean is true then
        v_required_ok := false;
        for j in 0 .. jsonb_array_length(v_mods) - 1 loop
          if btrim(v_mods -> j ->> 'groupId') = (v_mod_groups -> k ->> 'id')
             and jsonb_array_length(coalesce(v_mods -> j -> 'optionIds', '[]'::jsonb)) > 0 then
            v_required_ok := true; exit;
          end if;
        end loop;
        if not v_required_ok then
          return jsonb_build_object('ok', false, 'error', format('Please choose %s for %s', coalesce(v_mod_groups -> k ->> 'name', 'an option'), v_item_name));
        end if;
      end if;
    end loop;
    v_unit_price := round(v_unit_price + v_mod_total, 2);
    if v_unit_price > c_max_unit_price then
      return jsonb_build_object('ok', false, 'error', format('Menu item %s has an invalid price', v_item_id));
    end if;
    v_line_total := round(v_unit_price * v_quantity, 2);
    if v_line_total > c_max_money then return jsonb_build_object('ok', false, 'error', 'Order amount is too large'); end if;
    v_subtotal := v_subtotal + v_line_total;
    if v_subtotal > c_max_money then return jsonb_build_object('ok', false, 'error', 'Order amount is too large'); end if;
    v_lines := v_lines || jsonb_build_object(
      'itemId', v_item_id, 'itemName', v_item_name, 'quantity', v_quantity,
      'unitPrice', v_unit_price::text, 'lineTotal', v_line_total::text, 'modifiers', v_mod_snapshot);
  end loop;

  v_subtotal := round(v_subtotal, 2);
  if not v_tax_enabled then
    v_tax_amount := 0; v_total_before_tip := v_subtotal;
  elsif v_tax_inclusive then
    v_tax_amount := round(v_subtotal - v_subtotal / (1 + v_rate / 100), 2); v_total_before_tip := v_subtotal;
  else
    v_tax_amount := round(v_subtotal * v_rate / 100, 2); v_total_before_tip := v_subtotal + v_tax_amount;
  end if;
  if v_tax_amount < 0 then v_tax_amount := 0; end if;
  v_total := round(v_total_before_tip + v_tip, 2);
  if v_total > c_max_money then return jsonb_build_object('ok', false, 'error', 'Order amount is too large'); end if;

  return jsonb_build_object('ok', true, 'lines', v_lines,
    'subtotal', round(v_subtotal, 2)::text, 'tax', round(v_tax_amount, 2)::text,
    'tip', round(v_tip, 2)::text, 'total', round(v_total, 2)::text);
end;
$$;

-- The order payload (v5 section 12) plus the v3 identity hash and flags.
create or replace function public.lf2_order_payload(p_order_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
           'orderId', o.id::text,
           'orderNumber', o.order_number,
           'paymentMethod', o.payment_method,
           'subtotal', o.subtotal::text,
           'taxAmount', o.tax_amount::text,
           'tipAmount', o.tip_amount::text,
           'total', o.total::text,
           'createdAt', to_char(o.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'occurredAt', to_char(o.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'source', o.source,
           'hasInventoryShortfall', o.has_inventory_shortfall,
           'identityHash', o.sale_identity_hash,
           'flags', coalesce(o.lf_flags, '{}'::jsonb),
           'attribution', jsonb_build_object(
             'employeeId', o.employee_id,
             'pairedDeviceId', o.paired_device_id,
             'registerSessionId', o.register_session_id),
           'items', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'itemId', oi.item_id, 'itemName', oi.item_name, 'unitPrice', oi.unit_price::text,
                      'quantity', oi.quantity, 'lineTotal', oi.line_total::text,
                      'modifiers', coalesce(oi.modifiers, '[]'::jsonb),
                      'inventoryShortfall', coalesce(oi.inventory_shortfall, 0))
                    order by oi.line_position nulls last, oi.item_id collate "C", oi.id)
             from public.order_items oi where oi.order_id = o.id), '[]'::jsonb))
  from public.orders o
  where o.id = p_order_id;
$$;

-- Book ONE order and its inventory step, once. The caller holds the project row
-- FOR UPDATE (the serialization point every sale function uses) and has passed
-- every booking condition. p_lines carry the prices to record. The inventory
-- step follows complete_sale_v5's offline rule (floor at 0, shortfall recorded);
-- an item absent from the live config is recorded and skipped for stock.
-- Correction C2 — THE inventory step, shared by booking (lf2_book) and the
-- owner's stock preview (get_sale_hold), so the preview can never disagree with
-- what booking does. Lines are applied IN ORDER against a running copy of the
-- live items: two lines of the same item (e.g. modifier variants) see each
-- other's effect. complete_sale_v5's offline rule: tracked stock floors at 0 and
-- the remainder is recorded as that line's shortfall (negative stock OFF). An
-- item absent from the live config, or with an invalid live stock value, is
-- recorded and skipped for stock.
create or replace function public.lf2_inventory_effect(p_live_items jsonb, p_lines jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_live_items jsonb := coalesce(p_live_items, '[]'::jsonb);
  v_line jsonb;
  v_n integer := 0;
  v_live_index integer;
  v_live_item jsonb;
  v_track boolean;
  v_stock_num numeric;
  v_before integer;
  v_after integer;
  v_shortfall integer;
  v_has_shortfall boolean := false;
  v_absent text[] := array[]::text[];
  v_out jsonb := '[]'::jsonb;
  i integer;
begin
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    v_live_index := null;
    for i in 0 .. jsonb_array_length(v_live_items) - 1 loop
      if v_live_items -> i ->> 'id' = v_line ->> 'itemId' then v_live_index := i; exit; end if;
    end loop;
    v_before := 0; v_after := 0; v_shortfall := 0; v_track := false; v_live_item := null;
    if v_live_index is null then
      v_absent := v_absent || (v_line ->> 'itemId');
    else
      v_live_item := v_live_items -> v_live_index;
      begin v_track := coalesce((v_live_item ->> 'trackInventory')::boolean, false);
      exception when invalid_text_representation then v_track := false; end;
      if v_track then
        begin v_stock_num := coalesce((v_live_item ->> 'stockQuantity')::numeric, 0);
        exception when invalid_text_representation then v_stock_num := null; end;
        if v_stock_num is null or v_stock_num <> trunc(v_stock_num) or v_stock_num < 0 then
          v_track := false;
          v_absent := v_absent || (v_line ->> 'itemId');
        else
          v_before := v_stock_num::integer;
          if v_before < (v_line ->> 'quantity')::integer then
            v_shortfall := (v_line ->> 'quantity')::integer - v_before;
            v_has_shortfall := true;
            v_after := 0;
          else
            v_after := v_before - (v_line ->> 'quantity')::integer;
          end if;
          v_live_items := jsonb_set(v_live_items, array[v_live_index::text, 'stockQuantity'], to_jsonb(v_after), true);
        end if;
      end if;
    end if;
    v_out := v_out || jsonb_build_object(
      'lineIndex', v_n, 'itemId', v_line ->> 'itemId',
      'itemName', coalesce(v_line ->> 'itemName', v_live_item ->> 'name'),
      'track', v_track, 'before', v_before, 'after', v_after, 'shortfall', v_shortfall);
  end loop;
  return jsonb_build_object('lines', v_out, 'liveItems', v_live_items,
                            'absent', to_jsonb(v_absent), 'hasShortfall', v_has_shortfall);
end;
$$;

create or replace function public.lf2_book(
  p_project_id uuid, p_owner_id uuid, p_device_id uuid,
  p_sale_request_id uuid, p_v2_hash text, p_identity_hash text,
  p_payment_method text, p_source text, p_occurred_at timestamptz, p_build_job_id uuid,
  p_lines jsonb, p_subtotal numeric, p_tax numeric, p_tip numeric, p_total numeric,
  p_employee_id uuid, p_register_session_id uuid, p_claims jsonb, p_flags jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_max_suffix constant bigint := 999999999999999;
  c_max_prefix_len constant integer := 32;
  v_config jsonb;
  v_live_items jsonb;
  v_build jsonb;
  v_prefix text;
  v_suffix bigint;
  v_order_id uuid;
  v_effect jsonb;
  v_ledger jsonb := '[]'::jsonb;
  v_items jsonb := '[]'::jsonb;
  v_has_shortfall boolean := false;
  v_absent text[] := array[]::text[];
begin
  select p.config into v_config from public.projects p where p.id = p_project_id;
  v_live_items := coalesce(v_config -> 'menuItems', '[]'::jsonb);

  v_effect := public.lf2_inventory_effect(v_live_items, p_lines);
  v_live_items := v_effect -> 'liveItems';
  v_has_shortfall := (v_effect ->> 'hasShortfall')::boolean;
  select coalesce(array_agg(x), array[]::text[]) into v_absent from jsonb_array_elements_text(v_effect -> 'absent') x;
  select coalesce(jsonb_agg(l.value || jsonb_build_object('shortfall', (e.value ->> 'shortfall')::integer) order by l.ordinality), '[]'::jsonb)
    into v_items
  from jsonb_array_elements(p_lines) with ordinality l
  join jsonb_array_elements(v_effect -> 'lines') e on (e.value ->> 'lineIndex')::bigint = l.ordinality;
  select coalesce(jsonb_agg(e.value || jsonb_build_object('itemName', p_lines -> ((e.value ->> 'lineIndex')::integer - 1) ->> 'itemName')), '[]'::jsonb)
    into v_ledger
  from jsonb_array_elements(v_effect -> 'lines') e
  where (e.value ->> 'track')::boolean and (e.value ->> 'before')::integer <> (e.value ->> 'after')::integer;

  select b.config_snapshot into v_build from public.build_jobs b where b.id = p_build_job_id;
  v_prefix := btrim(coalesce(coalesce(v_build, v_config) -> 'receipt' ->> 'orderPrefix', ''));
  v_prefix := regexp_replace(v_prefix, '[[:cntrl:]]', '', 'g');
  if length(v_prefix) > c_max_prefix_len then v_prefix := left(v_prefix, c_max_prefix_len); end if;

  insert into public.project_order_counters (project_id, last_number) values (p_project_id, 1000)
  on conflict (project_id) do nothing;
  select c.last_number into v_suffix from public.project_order_counters c where c.project_id = p_project_id for update;
  if v_suffix is null then raise exception 'Order number could not be allocated'; end if;
  if v_suffix >= c_max_suffix then raise exception 'Order number sequence exhausted for this project'; end if;
  update public.project_order_counters set last_number = last_number + 1, updated_at = now()
  where project_id = p_project_id returning last_number into v_suffix;

  insert into public.orders (
    user_id, project_id, order_number, payment_method, subtotal, tax_amount, tip_amount, total,
    number_source, sale_request_id, sale_request_hash, occurred_at, source, has_inventory_shortfall,
    build_job_id, receipt_snapshot, employee_id, paired_device_id, register_session_id,
    identity_version, sale_identity_hash, recorded_claims, lf_flags
  ) values (
    p_owner_id, p_project_id, v_prefix || v_suffix::text, p_payment_method, p_subtotal, p_tax, p_tip, p_total,
    'server', p_sale_request_id, p_v2_hash, p_occurred_at, p_source, v_has_shortfall,
    p_build_job_id, null, p_employee_id, p_device_id, p_register_session_id,
    case when p_identity_hash is null then null else 3 end, p_identity_hash, p_claims,
    coalesce(p_flags, '{}'::jsonb) || jsonb_build_object(
      'itemsAbsentFromLiveConfig', to_jsonb(v_absent), 'stockShortfall', v_has_shortfall)
  ) returning id into v_order_id;

  insert into public.order_items (order_id, item_id, item_name, unit_price, quantity, line_total, modifiers,
                                  inventory_shortfall, line_position)
  select v_order_id, l ->> 'itemId', l ->> 'itemName', (l ->> 'unitPrice')::numeric, (l ->> 'quantity')::integer,
         (l ->> 'lineTotal')::numeric, coalesce(l -> 'modifiers', '[]'::jsonb), (l ->> 'shortfall')::integer, n::integer
  from jsonb_array_elements(v_items) with ordinality t(l, n);

  -- One ledger row per order LINE (line_index = cart position), so the Scope 1
  -- partial unique index (order_id, line_index) also guards v6 orders.
  insert into public.inventory_transactions (user_id, project_id, order_id, item_id, item_name, transaction_type,
                                             quantity_change, quantity_before, quantity_after, line_index)
  select p_owner_id, p_project_id, v_order_id, l ->> 'itemId', l ->> 'itemName', 'sale',
         (l ->> 'after')::integer - (l ->> 'before')::integer, (l ->> 'before')::integer, (l ->> 'after')::integer,
         (l ->> 'lineIndex')::integer
  from jsonb_array_elements(v_ledger) l;

  if jsonb_array_length(v_ledger) > 0 then
    update public.projects set config = jsonb_set(v_config, '{menuItems}', v_live_items, true), updated_at = now()
    where id = p_project_id;
  end if;

  return v_order_id;
end;
$$;

create or replace function public.lf2_hold(
  p_project_id uuid, p_device_id uuid, p_norm jsonb, p_hash text, p_canonical text, p_payload jsonb,
  p_reason text, p_detail jsonb, p_conflict_order uuid, p_conflict_hold uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_hold public.sale_holds;
begin
  insert into public.sale_holds (project_id, paired_device_id, sale_request_id, identity_hash, payload, canonical,
                                 reason, detail, conflict_order_id, conflict_hold_id, client_version)
  values (p_project_id, p_device_id, (p_norm ->> 'saleRequestId')::uuid, p_hash, p_payload, p_canonical,
          p_reason, coalesce(p_detail, '{}'::jsonb), p_conflict_order, p_conflict_hold, p_norm ->> 'clientVersion')
  on conflict (project_id, sale_request_id, identity_hash) do nothing
  returning * into v_hold;
  if v_hold.id is null then
    select * into v_hold from public.sale_holds
    where project_id = p_project_id and sale_request_id = (p_norm ->> 'saleRequestId')::uuid and identity_hash = p_hash;
  end if;
  return jsonb_build_object('status', 'held', 'holdId', v_hold.id, 'reason', v_hold.reason,
                            'state', v_hold.state, 'identityHash', p_hash);
end;
$$;

-- ============================================================================
-- 5. complete_sale_v6 (device only).
-- ============================================================================
create or replace function public.complete_sale_v6(p_identity jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  c_clock_skew constant interval := interval '5 minutes';
  v_caller uuid := auth.uid();
  v_device record;
  v_project record;
  v_norm jsonb;
  v_canonical text;
  v_hash text;
  v_v2_hash text;
  v_sale_id uuid;
  v_order record;
  v_hold record;
  v_build jsonb;
  v_priced jsonb;
  v_occurred timestamptz;
  v_employee record;
  v_employee_id uuid;
  v_reg uuid;
  v_removed boolean := false;
  v_acked_version bigint;
  v_limit text;
  v_beyond boolean;
  v_flags jsonb;
  v_claims jsonb;
  v_order_id uuid;
  v_diff jsonb := '[]'::jsonb;
  i integer;
begin
  if v_caller is null then
    perform public.lf2_fail('authorization', 'authentication_required');
  end if;

  -- Lock order as complete_sale_v5: device row FOR SHARE, then project FOR UPDATE.
  select d.id, d.project_id, d.owner_id, d.revoked_at, d.unpaired_at, d.created_at
    into v_device
  from public.paired_devices d where d.auth_user_id = v_caller for share;
  if not found then
    perform public.lf2_fail('authorization', 'device_not_authorized');
  end if;

  select p.id, p.user_id, p.local_first_enabled, p.offline_selling_limit into v_project
  from public.projects p where p.id = v_device.project_id and p.user_id = v_device.owner_id for update;
  if not found then
    perform public.lf2_fail('authorization', 'device_not_authorized');
  end if;
  if not v_project.local_first_enabled then
    perform public.lf2_fail('capability', 'local_first_not_enabled');
  end if;

  v_norm := public.lf2_normalize_identity(p_identity);
  if (v_norm ->> 'pairingGeneration')::uuid <> v_device.id then
    perform public.lf2_fail('sale', 'sale_wrong_pairing_generation');
  end if;
  if (v_norm ->> 'projectId')::uuid <> v_project.id then
    perform public.lf2_fail('sale', 'sale_wrong_project');
  end if;
  -- Tips are not supported on a device (complete_sale_v5's rule, unchanged).
  if (v_norm ->> 'tip')::numeric <> 0 then
    perform public.lf2_fail('sale', 'sale_tip_not_supported');
  end if;

  v_canonical := v_norm::text;
  v_hash := encode(sha256(convert_to('posc.sale.v3' || E'\n' || v_canonical, 'UTF8')), 'hex');
  v_v2_hash := public.lf2_v2_hash(v_project.id, v_norm);
  v_sale_id := (v_norm ->> 'saleRequestId')::uuid;
  v_occurred := (v_norm ->> 'occurredAt')::timestamptz;

  -- 1. An order under this ID.
  select o.id, o.paired_device_id, o.sale_identity_hash, o.identity_version into v_order
  from public.orders o where o.project_id = v_project.id and o.sale_request_id = v_sale_id;
  if found then
    if v_order.paired_device_id is distinct from v_device.id then
      return public.lf2_hold(v_project.id, v_device.id, v_norm, v_hash, v_canonical, p_identity,
                             'not_this_device', '{}'::jsonb, v_order.id, null);
    end if;
    if v_order.identity_version is null then
      return public.lf2_hold(v_project.id, v_device.id, v_norm, v_hash, v_canonical, p_identity,
                             'identity_version_mismatch', '{}'::jsonb, v_order.id, null);
    end if;
    if v_order.sale_identity_hash = v_hash then
      return jsonb_build_object('status', 'replayed', 'identityHash', v_hash, 'order', public.lf2_order_payload(v_order.id));
    end if;
    return public.lf2_hold(v_project.id, v_device.id, v_norm, v_hash, v_canonical, p_identity,
                           'identity_conflict', '{}'::jsonb, v_order.id, null);
  end if;

  -- 2. A hold under this ID: the same bytes return that hold; different bytes conflict with it.
  select h.id, h.identity_hash, h.paired_device_id into v_hold
  from public.sale_holds h where h.project_id = v_project.id and h.sale_request_id = v_sale_id and h.identity_hash = v_hash;
  if found then
    return public.lf2_hold(v_project.id, v_device.id, v_norm, v_hash, v_canonical, p_identity, 'identity_conflict', '{}'::jsonb, null, null)
           || jsonb_build_object('replayed', true);
  end if;
  select h.id, h.paired_device_id into v_hold
  from public.sale_holds h where h.project_id = v_project.id and h.sale_request_id = v_sale_id
  order by h.received_at limit 1;
  if found then
    return public.lf2_hold(v_project.id, v_device.id, v_norm, v_hash, v_canonical, p_identity,
                           case when v_hold.paired_device_id <> v_device.id then 'not_this_device' else 'identity_conflict' end,
                           '{}'::jsonb, null, v_hold.id);
  end if;

  -- 3. Device state at upload (OD-2: every non-replay upload from a revoked or unpaired till is held).
  if v_device.unpaired_at is not null then
    return public.lf2_hold(v_project.id, v_device.id, v_norm, v_hash, v_canonical, p_identity, 'after_unpair',
                           jsonb_build_object('unpairedAt', v_device.unpaired_at), null, null);
  end if;
  if v_device.revoked_at is not null then
    return public.lf2_hold(v_project.id, v_device.id, v_norm, v_hash, v_canonical, p_identity, 'after_revocation',
                           jsonb_build_object('revokedAt', v_device.revoked_at), null, null);
  end if;

  -- 4. The build must be one this device was pinned to.
  if not exists (select 1 from public.device_build_pins bp
                 where bp.paired_device_id = v_device.id and bp.build_job_id = (v_norm ->> 'buildJobId')::uuid) then
    return public.lf2_hold(v_project.id, v_device.id, v_norm, v_hash, v_canonical, p_identity,
                           'build_not_pinned_by_device', '{}'::jsonb, null, null);
  end if;

  -- 5. Time bounds: not in the future, not before pairing. No age ceiling (OD-1).
  if v_occurred > now() + c_clock_skew or v_occurred < v_device.created_at - c_clock_skew then
    return public.lf2_hold(v_project.id, v_device.id, v_norm, v_hash, v_canonical, p_identity, 'time_out_of_bounds',
                           jsonb_build_object('pairedAt', v_device.created_at, 'receivedAt', now()), null, null);
  end if;

  -- 6. Prices: from THAT build, compared with what the till showed.
  select b.config_snapshot into v_build from public.build_jobs b
  where b.id = (v_norm ->> 'buildJobId')::uuid and b.project_id = v_project.id and b.status = 'succeeded';
  if not found then
    return public.lf2_hold(v_project.id, v_device.id, v_norm, v_hash, v_canonical, p_identity,
                           'build_not_pinned_by_device', jsonb_build_object('error', 'build is not a succeeded build of this business'), null, null);
  end if;
  v_priced := public.lf2_price_from_build(v_build, v_norm);
  if not (v_priced ->> 'ok')::boolean then
    return public.lf2_hold(v_project.id, v_device.id, v_norm, v_hash, v_canonical, p_identity, 'price_mismatch',
                           jsonb_build_object('error', v_priced ->> 'error'), null, null);
  end if;
  for i in 0 .. jsonb_array_length(v_norm -> 'lines') - 1 loop
    if (v_norm -> 'lines' -> i ->> 'unitPrice')::numeric <> (v_priced -> 'lines' -> i ->> 'unitPrice')::numeric
       or (v_norm -> 'lines' -> i ->> 'lineTotal')::numeric <> (v_priced -> 'lines' -> i ->> 'lineTotal')::numeric then
      v_diff := v_diff || jsonb_build_object('line', i, 'itemId', v_norm -> 'lines' -> i ->> 'itemId',
        'recorded', jsonb_build_object('unitPrice', v_norm -> 'lines' -> i ->> 'unitPrice', 'lineTotal', v_norm -> 'lines' -> i ->> 'lineTotal'),
        'build', jsonb_build_object('unitPrice', v_priced -> 'lines' -> i ->> 'unitPrice', 'lineTotal', v_priced -> 'lines' -> i ->> 'lineTotal'));
    end if;
  end loop;
  if (v_norm ->> 'subtotal')::numeric <> (v_priced ->> 'subtotal')::numeric
     or (v_norm ->> 'tax')::numeric <> (v_priced ->> 'tax')::numeric
     or (v_norm ->> 'total')::numeric <> (v_priced ->> 'total')::numeric then
    v_diff := v_diff || jsonb_build_object('totals', jsonb_build_object(
      'recorded', jsonb_build_object('subtotal', v_norm ->> 'subtotal', 'tax', v_norm ->> 'tax', 'total', v_norm ->> 'total'),
      'build', jsonb_build_object('subtotal', v_priced ->> 'subtotal', 'tax', v_priced ->> 'tax', 'total', v_priced ->> 'total')));
  end if;
  if jsonb_array_length(v_diff) > 0 then
    return public.lf2_hold(v_project.id, v_device.id, v_norm, v_hash, v_canonical, p_identity, 'price_mismatch',
                           jsonb_build_object('differences', v_diff), null, null);
  end if;

  -- 7. Attribution as recorded (§6.3). Raw claims are always stored.
  v_employee_id := (v_norm ->> 'employeeId')::uuid;
  select e.id, e.project_id into v_employee from public.employees e where e.id = v_employee_id;
  if not found or v_employee.project_id <> v_project.id then
    return public.lf2_hold(v_project.id, v_device.id, v_norm, v_hash, v_canonical, p_identity, 'attribution_invalid',
                           jsonb_build_object('field', 'employeeId'), null, null);
  end if;
  if v_norm ->> 'serverSessionId' is not null and not exists (
       select 1 from public.employee_pos_sessions s
       where s.id = (v_norm ->> 'serverSessionId')::uuid and s.paired_device_id = v_device.id and s.employee_id = v_employee_id) then
    return public.lf2_hold(v_project.id, v_device.id, v_norm, v_hash, v_canonical, p_identity, 'attribution_invalid',
                           jsonb_build_object('field', 'serverSessionId'), null, null);
  end if;
  v_reg := null;
  if v_norm ->> 'registerClaimId' is not null then
    select r.id into v_reg from public.register_sessions r
    where r.id = (v_norm ->> 'registerClaimId')::uuid and r.paired_device_id = v_device.id;
    if not found then
      return public.lf2_hold(v_project.id, v_device.id, v_norm, v_hash, v_canonical, p_identity, 'attribution_invalid',
                             jsonb_build_object('field', 'registerClaimId'), null, null);
    end if;
  end if;
  -- Removal delivered: the employee's latest status event the till could have
  -- known — by its own roster version, or by the roster versions it had
  -- acknowledged before the sale — is a removal.
  select (e.event in ('deactivated', 'baseline_inactive')) into v_removed
  from public.employee_status_events e
  where e.employee_id = v_employee_id
    and e.roster_version <= coalesce((v_norm ->> 'rosterVersionAtSale')::bigint, 0)
  order by e.roster_version desc limit 1;
  if not coalesce(v_removed, false) then
    select max(a.roster_version) into v_acked_version
    from public.device_roster_acks a where a.paired_device_id = v_device.id and a.acked_at <= v_occurred;
    if v_acked_version is not null then
      select (e.event in ('deactivated', 'baseline_inactive')) into v_removed
      from public.employee_status_events e
      where e.employee_id = v_employee_id and e.roster_version <= v_acked_version
      order by e.roster_version desc limit 1;
    end if;
  end if;
  if coalesce(v_removed, false) then
    return public.lf2_hold(v_project.id, v_device.id, v_norm, v_hash, v_canonical, p_identity,
                           'attribution_after_removal_delivered',
                           jsonb_build_object('rosterVersionAtSale', v_norm -> 'rosterVersionAtSale', 'ackedVersionAtSale', v_acked_version),
                           null, null);
  end if;

  -- 8. Book. Flags never hold.
  v_limit := v_project.offline_selling_limit;
  v_beyond := case
    when v_limit is null then null
    when v_limit = 'none' then false
    else now() - v_occurred > make_interval(days => left(v_limit, -1)::integer) end;
  v_flags := jsonb_build_object('offlineSellingLimit', v_limit, 'beyondOfflineLimit', v_beyond);
  v_claims := jsonb_build_object(
    'employeeId', v_norm -> 'employeeId', 'localSessionId', v_norm -> 'localSessionId',
    'sessionStartedAt', v_norm -> 'sessionStartedAt', 'serverSessionId', v_norm -> 'serverSessionId',
    'registerDay', v_norm -> 'registerDay', 'registerClaimId', v_norm -> 'registerClaimId',
    'rosterVersionAtSale', v_norm -> 'rosterVersionAtSale', 'deviceSaleSeq', v_norm -> 'deviceSaleSeq',
    'clientVersion', v_norm -> 'clientVersion');

  v_order_id := public.lf2_book(
    v_project.id, v_project.user_id, v_device.id, v_sale_id, v_v2_hash, v_hash,
    v_norm ->> 'paymentMethod', v_norm ->> 'source', v_occurred, (v_norm ->> 'buildJobId')::uuid,
    v_priced -> 'lines', (v_priced ->> 'subtotal')::numeric, (v_priced ->> 'tax')::numeric,
    0, (v_priced ->> 'total')::numeric, v_employee_id, v_reg, v_claims, v_flags);

  return jsonb_build_object('status', 'booked', 'identityHash', v_hash, 'order', public.lf2_order_payload(v_order_id));
end;
$function$;

-- ============================================================================
-- 6. Owner held-sales RPCs.
-- ============================================================================
create or replace function public.lf2_owner_project(p_project_id uuid, p_lock boolean)
returns public.projects
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v public.projects;
begin
  if auth.uid() is null then
    perform public.lf2_fail('authorization', 'authentication_required');
  end if;
  if p_lock then
    select * into v from public.projects where id = p_project_id and user_id = auth.uid() for update;
  else
    select * into v from public.projects where id = p_project_id and user_id = auth.uid();
  end if;
  if v.id is null then
    perform public.lf2_fail('authorization', 'owner_not_authorized');
  end if;
  return v;
end;
$$;

create or replace function public.lf2_hold_summary(h public.sale_holds)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'holdId', h.id, 'saleRequestId', h.sale_request_id, 'reason', h.reason, 'state', h.state,
    'receivedAt', h.received_at, 'decidedAt', h.decided_at, 'deviceAcknowledgedAt', h.device_acknowledged_at,
    'pairedDeviceId', h.paired_device_id,
    'deviceName', (select d.device_name from public.paired_devices d where d.id = h.paired_device_id),
    'employeeId', h.payload ->> 'employeeId',
    'employeeName', (select e.display_name from public.employees e
                     where e.id = public.lf2_uuid(h.payload -> 'employeeId') and e.project_id = h.project_id),
    'total', h.payload ->> 'total', 'paymentMethod', h.payload ->> 'paymentMethod',
    'occurredAt', h.payload ->> 'occurredAt', 'orderId', h.order_id);
$$;

create or replace function public.list_sale_holds(
  p_project_id uuid, p_state text default 'held', p_reason text default null,
  p_device_id uuid default null, p_from timestamptz default null, p_to timestamptz default null,
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v public.projects;
begin
  v := public.lf2_owner_project(p_project_id, false);
  return jsonb_build_object(
    'enabled', v.local_first_enabled,
    'counts', (select jsonb_build_object(
                 'held', count(*) filter (where state = 'held'),
                 'accepted', count(*) filter (where state = 'accepted'),
                 'declined', count(*) filter (where state = 'declined'))
               from public.sale_holds where project_id = p_project_id),
    'holds', coalesce((
      select jsonb_agg(public.lf2_hold_summary(h) order by h.received_at desc)
      from (select * from public.sale_holds h
            where h.project_id = p_project_id
              and (p_state is null or h.state = p_state)
              and (p_reason is null or h.reason = p_reason)
              and (p_device_id is null or h.paired_device_id = p_device_id)
              and (p_from is null or h.received_at >= p_from)
              and (p_to is null or h.received_at < p_to)
            order by h.received_at desc
            limit greatest(1, least(coalesce(p_limit, 100), 500))) h), '[]'::jsonb));
end;
$$;

-- Which decisions are valid for which reason (§12.2). accept_as_recorded books
-- under the held sale's own ID, so it is impossible for the conflict reasons
-- (that ID already names another record); those are booked only as a separate
-- sale. accept_unattributed exists for attribution reasons only.
create or replace function public.lf2_valid_decisions(p_reason text)
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_reason in ('identity_conflict', 'not_this_device', 'identity_version_mismatch')
      then array['record_as_separate', 'decline']
    when p_reason in ('attribution_after_removal_delivered', 'attribution_invalid')
      then array['accept_as_recorded', 'accept_unattributed', 'decline']
    else array['accept_as_recorded', 'decline']
  end;
$$;

create or replace function public.get_sale_hold(p_hold_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  h public.sale_holds;
  v public.projects;
  v_conflict jsonb := null;
  v_preview jsonb;
begin
  select * into h from public.sale_holds where id = p_hold_id;
  if h.id is null then
    perform public.lf2_fail('authorization', 'owner_not_authorized');
  end if;
  v := public.lf2_owner_project(h.project_id, false);

  if h.conflict_order_id is not null then
    v_conflict := jsonb_build_object('kind', 'order', 'order', public.lf2_order_payload(h.conflict_order_id),
      'recordedClaims', (select o.recorded_claims from public.orders o where o.id = h.conflict_order_id));
  elsif h.conflict_hold_id is not null then
    v_conflict := (select jsonb_build_object('kind', 'hold', 'holdId', c.id, 'payload', c.payload, 'receivedAt', c.received_at)
                   from public.sale_holds c where c.id = h.conflict_hold_id);
  end if;

  -- Stock effect preview (Correction C2): the SAME inventory step booking runs
  -- (lf2_inventory_effect), over the held lines in order, folded per item:
  -- stock before the first line, after the last line, and the total shortfall.
  select coalesce(jsonb_agg(jsonb_build_object(
           'itemId', x.item_id, 'itemName', x.item_name, 'lines', x.lines,
           'before', x.first_before, 'after', x.last_after, 'shortfall', x.shortfall) order by x.first_line), '[]'::jsonb)
    into v_preview
  from (
    select e.value ->> 'itemId' as item_id,
           (array_agg(e.value ->> 'itemName' order by (e.value ->> 'lineIndex')::integer))[1] as item_name,
           count(*) as lines,
           min((e.value ->> 'lineIndex')::integer) as first_line,
           (array_agg((e.value ->> 'before')::integer order by (e.value ->> 'lineIndex')::integer))[1] as first_before,
           (array_agg((e.value ->> 'after')::integer order by (e.value ->> 'lineIndex')::integer desc))[1] as last_after,
           sum((e.value ->> 'shortfall')::integer) as shortfall
    from jsonb_array_elements(public.lf2_inventory_effect(
           coalesce(v.config -> 'menuItems', '[]'::jsonb),
           public.lf2_normalize_identity(h.payload) -> 'lines') -> 'lines') e
    where (e.value ->> 'track')::boolean
    group by e.value ->> 'itemId'
  ) x;

  return public.lf2_hold_summary(h) || jsonb_build_object(
    'payload', h.payload,
    'identityHash', h.identity_hash,
    'detail', h.detail,
    'clientVersion', h.client_version,
    'buildJobId', h.payload ->> 'buildJobId',
    'device', (select jsonb_build_object('name', d.device_name, 'platform', d.platform, 'pairedAt', d.created_at,
                                         'revokedAt', d.revoked_at, 'unpairedAt', d.unpaired_at)
               from public.paired_devices d where d.id = h.paired_device_id),
    'conflict', v_conflict,
    'validDecisions', case when h.state = 'held' then to_jsonb(public.lf2_valid_decisions(h.reason)) else '[]'::jsonb end,
    'stockPreview', v_preview,
    'decisions', coalesce((select jsonb_agg(jsonb_build_object(
                   'decisionId', d.decision_id, 'decision', d.decision, 'reason', d.reason, 'actor', d.actor,
                   'priorState', d.prior_state, 'resultingState', d.resulting_state,
                   'resultingOrderId', d.resulting_order_id, 'decidedAt', d.decided_at) order by d.decided_at)
                 from public.sale_hold_decisions d where d.hold_id = h.id), '[]'::jsonb));
end;
$$;

create or replace function public.decide_sale_hold(p_hold_id uuid, p_decision text, p_reason text, p_decision_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  h public.sale_holds;
  v public.projects;
  v_prior public.sale_hold_decisions;
  v_norm jsonb;
  v_order_id uuid := null;
  v_state text;
  v_sale_id uuid;
  v_employee uuid;
  v_reg uuid;
  v_lines jsonb;
  v_build jsonb;
  v_priced jsonb;
begin
  if p_decision_id is null then
    perform public.lf2_fail('sale', 'decision_id_required');
  end if;
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 1000 then
    perform public.lf2_fail('sale', 'decision_reason_required');
  end if;

  select * into h from public.sale_holds where id = p_hold_id;
  if h.id is null then
    perform public.lf2_fail('authorization', 'owner_not_authorized');
  end if;
  -- Same serialization point as every sale: the project row, FOR UPDATE.
  v := public.lf2_owner_project(h.project_id, true);
  select * into h from public.sale_holds where id = p_hold_id for update;

  -- Idempotency: this decision_id already decided something.
  select * into v_prior from public.sale_hold_decisions where decision_id = p_decision_id;
  if v_prior.id is not null then
    if v_prior.hold_id <> h.id then
      perform public.lf2_fail('sale', 'decision_id_reused');
    end if;
    return jsonb_build_object('holdId', h.id, 'state', h.state, 'orderId', h.order_id, 'replayed', true);
  end if;
  if h.state <> 'held' then
    return jsonb_build_object('holdId', h.id, 'state', h.state, 'orderId', h.order_id, 'alreadyDecided', true);
  end if;
  if not (p_decision = any (public.lf2_valid_decisions(h.reason))) then
    perform public.lf2_fail('sale', 'decision_not_valid_for_reason', h.reason);
  end if;

  v_norm := public.lf2_normalize_identity(h.payload);
  if p_decision = 'decline' then
    v_state := 'declined';
  else
    v_state := 'accepted';
    v_sale_id := case when p_decision = 'record_as_separate' then gen_random_uuid() else h.sale_request_id end;
    v_employee := case when p_decision = 'accept_unattributed' then null
                       else (select e.id from public.employees e where e.id = (v_norm ->> 'employeeId')::uuid and e.project_id = h.project_id) end;
    v_reg := case when p_decision = 'accept_unattributed' then null
                  else (select r.id from public.register_sessions r
                        where r.id = (v_norm ->> 'registerClaimId')::uuid and r.paired_device_id = h.paired_device_id) end;
    -- AS RECORDED: the till's own quantities and figures. Names and option
    -- snapshots come from the sale's own build where it can describe them;
    -- otherwise the recorded IDs are kept (never re-priced).
    select b.config_snapshot into v_build from public.build_jobs b
    where b.id = (v_norm ->> 'buildJobId')::uuid and b.project_id = h.project_id;
    v_priced := case when v_build is null then null else public.lf2_price_from_build(v_build, v_norm) end;
    select coalesce(jsonb_agg(jsonb_build_object(
             'itemId', l.value ->> 'itemId',
             'quantity', (l.value ->> 'quantity')::integer,
             'unitPrice', l.value ->> 'unitPrice',
             'lineTotal', l.value ->> 'lineTotal',
             'itemName', coalesce(
               case when (v_priced ->> 'ok')::boolean then v_priced -> 'lines' -> (l.ordinality::integer - 1) ->> 'itemName' end,
               (select btrim(m.value ->> 'name') from jsonb_array_elements(coalesce(v_build -> 'menuItems', '[]'::jsonb)) m
                where m.value ->> 'id' = l.value ->> 'itemId' limit 1),
               l.value ->> 'itemId'),
             'modifiers', coalesce(
               case when (v_priced ->> 'ok')::boolean then v_priced -> 'lines' -> (l.ordinality::integer - 1) -> 'modifiers' end,
               (select coalesce(jsonb_agg(jsonb_build_object('groupId', g.value ->> 'groupId', 'groupName', '',
                                                             'optionId', o.value, 'optionName', '', 'priceAdjustment', null)), '[]'::jsonb)
                from jsonb_array_elements(l.value -> 'modifiers') g, jsonb_array_elements_text(g.value -> 'optionIds') o)))
           order by l.ordinality), '[]'::jsonb)
      into v_lines
    from jsonb_array_elements(v_norm -> 'lines') with ordinality l;
    v_order_id := public.lf2_book(
      h.project_id, v.user_id, h.paired_device_id, v_sale_id, public.lf2_v2_hash(h.project_id, v_norm),
      case when p_decision = 'record_as_separate' then null else h.identity_hash end,
      v_norm ->> 'paymentMethod', v_norm ->> 'source', (v_norm ->> 'occurredAt')::timestamptz,
      case when exists (select 1 from public.build_jobs b where b.id = (v_norm ->> 'buildJobId')::uuid and b.project_id = h.project_id)
           then (v_norm ->> 'buildJobId')::uuid end,
      v_lines, (v_norm ->> 'subtotal')::numeric, (v_norm ->> 'tax')::numeric, (v_norm ->> 'tip')::numeric,
      (v_norm ->> 'total')::numeric, v_employee, v_reg,
      jsonb_build_object('fromHold', h.id, 'decision', p_decision, 'employeeId', v_norm -> 'employeeId',
                         'registerClaimId', v_norm -> 'registerClaimId'),
      jsonb_build_object('acceptedFromHold', h.id, 'decision', p_decision));
  end if;

  insert into public.sale_hold_decisions (decision_id, hold_id, project_id, actor, decision, reason, prior_state,
                                          resulting_state, resulting_order_id)
  values (p_decision_id, h.id, h.project_id, auth.uid(), p_decision, btrim(p_reason), h.state, v_state, v_order_id);

  update public.sale_holds set state = v_state, order_id = v_order_id, decided_at = now() where id = h.id;

  return jsonb_build_object('holdId', h.id, 'state', v_state, 'orderId', v_order_id, 'replayed', false);
end;
$$;

-- ============================================================================
-- 7. Device hold status and acknowledgement.
-- ============================================================================
create or replace function public.get_sale_hold_status(p_sale_request_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_device record;
begin
  if auth.uid() is null then
    perform public.lf2_fail('authorization', 'authentication_required');
  end if;
  select d.id, d.project_id into v_device from public.paired_devices d where d.auth_user_id = auth.uid();
  if not found then
    perform public.lf2_fail('authorization', 'device_not_authorized');
  end if;
  if not (select p.local_first_enabled from public.projects p where p.id = v_device.project_id) then
    perform public.lf2_fail('capability', 'local_first_not_enabled');
  end if;
  if p_sale_request_ids is null or cardinality(p_sale_request_ids) = 0 or cardinality(p_sale_request_ids) > 200 then
    perform public.lf2_fail('sale', 'sale_request_ids_invalid');
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'saleRequestId', ids.id,
      'order', (select jsonb_build_object('orderId', o.id, 'orderNumber', o.order_number)
                from public.orders o where o.project_id = v_device.project_id and o.sale_request_id = ids.id
                  and o.paired_device_id = v_device.id),
      'holds', coalesce((select jsonb_agg(jsonb_build_object(
                 'holdId', h.id, 'reason', h.reason, 'state', h.state, 'decidedAt', h.decided_at,
                 'orderId', h.order_id,
                 'orderNumber', (select o.order_number from public.orders o where o.id = h.order_id),
                 'deviceAcknowledgedAt', h.device_acknowledged_at) order by h.received_at)
               from public.sale_holds h where h.paired_device_id = v_device.id and h.sale_request_id = ids.id), '[]'::jsonb)))
    from (select distinct unnest(p_sale_request_ids) as id) ids), '[]'::jsonb);
end;
$$;

create or replace function public.ack_sale_hold_resolution(p_hold_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_device record;
  h public.sale_holds;
begin
  if auth.uid() is null then
    perform public.lf2_fail('authorization', 'authentication_required');
  end if;
  select d.id, d.project_id into v_device from public.paired_devices d where d.auth_user_id = auth.uid();
  if not found then
    perform public.lf2_fail('authorization', 'device_not_authorized');
  end if;
  select * into h from public.sale_holds where id = p_hold_id and paired_device_id = v_device.id for update;
  if h.id is null then
    perform public.lf2_fail('sale', 'hold_not_found');
  end if;
  if h.state = 'held' then
    perform public.lf2_fail('sale', 'hold_not_decided');
  end if;
  if h.device_acknowledged_at is null then
    update public.sale_holds set device_acknowledged_at = now() where id = h.id returning * into h;
  end if;
  return jsonb_build_object('holdId', h.id, 'state', h.state, 'deviceAcknowledgedAt', h.device_acknowledged_at);
end;
$$;

-- ============================================================================
-- 8. Grants. Internal helpers: no API access. RPCs: authenticated only.
-- ============================================================================
revoke all on function public.lf2_projects_switch_guard() from public, anon, authenticated;
revoke all on function public.lf2_append_only() from public, anon, authenticated;
revoke all on function public.lf2_record_build_pin() from public, anon, authenticated;
revoke all on function public.lf2_next_roster_version(uuid) from public, anon, authenticated;
revoke all on function public.lf2_record_employee_status() from public, anon, authenticated;
revoke all on function public.lf2_sale_holds_guard() from public, anon, authenticated;
revoke all on function public.lf2_fail(text, text, text) from public, anon, authenticated;
revoke all on function public.lf2_line_key(text, jsonb) from public, anon, authenticated;
revoke all on function public.lf2_money(jsonb) from public, anon, authenticated;
revoke all on function public.lf2_uuid(jsonb) from public, anon, authenticated;
revoke all on function public.lf2_time(jsonb) from public, anon, authenticated;
revoke all on function public.lf2_normalize_identity(jsonb) from public, anon, authenticated;
revoke all on function public.lf2_v2_hash(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.lf2_price_from_build(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.lf2_order_payload(uuid) from public, anon, authenticated;
revoke all on function public.lf2_inventory_effect(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.lf2_book(uuid, uuid, uuid, uuid, text, text, text, text, timestamptz, uuid, jsonb, numeric, numeric, numeric, numeric, uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.lf2_hold(uuid, uuid, jsonb, text, text, jsonb, text, jsonb, uuid, uuid) from public, anon, authenticated;
revoke all on function public.lf2_owner_project(uuid, boolean) from public, anon, authenticated;
revoke all on function public.lf2_hold_summary(public.sale_holds) from public, anon, authenticated;
revoke all on function public.lf2_valid_decisions(text) from public, anon, authenticated;

revoke all on function public.complete_sale_v6(jsonb) from public, anon;
revoke all on function public.list_sale_holds(uuid, text, text, uuid, timestamptz, timestamptz, integer) from public, anon;
revoke all on function public.get_sale_hold(uuid) from public, anon;
revoke all on function public.decide_sale_hold(uuid, text, text, uuid) from public, anon;
revoke all on function public.get_sale_hold_status(uuid[]) from public, anon;
revoke all on function public.ack_sale_hold_resolution(uuid) from public, anon;
grant execute on function public.complete_sale_v6(jsonb) to authenticated;
grant execute on function public.list_sale_holds(uuid, text, text, uuid, timestamptz, timestamptz, integer) to authenticated;
grant execute on function public.get_sale_hold(uuid) to authenticated;
grant execute on function public.decide_sale_hold(uuid, text, text, uuid) to authenticated;
grant execute on function public.get_sale_hold_status(uuid[]) to authenticated;
grant execute on function public.ack_sale_hold_resolution(uuid) to authenticated;
