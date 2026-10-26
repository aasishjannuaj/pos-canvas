-- Batch A — Inventory foundations (REPORT.md §16, Scope 1). Negative-stock
-- activation stays OFF: no path writes inventory_transactions.allow_negative = true,
-- and no sale function's inventory logic is changed.
--
-- WHAT THIS ADDS
--   * Non-spoofable transaction stamps (txid, stamp_seq) on the ledger, orders and
--     the new inventory_actions table: a BEFORE INSERT trigger overwrites any
--     supplied value; stamps (and the ledger) are append-only; the ledger insert
--     grant is narrowed to the columns restock_inventory/adjust_inventory write.
--   * The projects stock guard (lf_projects_guard): a stock change on an existing
--     item is accepted only when this transaction's stamped ledger rows explain it
--     as one contiguous chain, consumed once by watermark; a tracking change only
--     when a stamped tracking action row authorizes it. A change with no evidence
--     (a stale or direct whole-config save) is restored to the live value. Role is
--     never the authorization.
--   * Commit-time completeness: a ledger row that never reached live stock fails
--     the transaction (deferred constraint trigger).
--   * Catalog version, tombstones and retired item ids: stale structural saves are
--     refused, deleted ids cannot be resurrected; opening stock for new items and
--     new projects is recorded (AFTER INSERT for projects, so the ledger's foreign
--     key is satisfied).
--   * Owner-only, request-bound "Received +N" (inventory_receive), "Counted = N"
--     (inventory_count) and set_item_tracking; request ids are bound to business,
--     action, item and input; authorization happens before any replay.
--   * Signed-quantity readiness: allow_negative (default false), line_index and a
--     partial unique index; the >= 0 ledger checks become "(>= 0) or allow_negative".
--
-- VALIDATED BEFORE ADOPTION: identical definitions passed 92/92 checks against the
-- accepted 1.3.3 migrations on disposable PostgreSQL 17 (stamps, permissions,
-- multi-update, savepoints, tracking, opening stock, stale saves, request binding,
-- concurrency, all five sale functions + restock/adjust compatibility, latency at
-- 1,000/5,000 items). Evidence: pos-canvas-localfirst-analysis/evidence/inventory.
-- "lf_" = local-first inventory foundations.


-- ---------------------------------------------------------------------------
-- F-1a  Non-spoofable stamps
-- ---------------------------------------------------------------------------
create sequence public.inventory_stamp_seq;
revoke all on sequence public.inventory_stamp_seq from public, anon, authenticated, service_role;

alter table public.inventory_transactions
  add column txid bigint,
  add column stamp_seq bigint,
  add column allow_negative boolean not null default false,
  add column line_index integer;
update public.inventory_transactions set txid = 0, stamp_seq = 0 where txid is null;
alter table public.inventory_transactions
  alter column txid set not null,
  alter column stamp_seq set not null;

alter table public.orders add column txid bigint, add column stamp_seq bigint;
update public.orders set txid = 0, stamp_seq = 0 where txid is null;
alter table public.orders alter column txid set not null, alter column stamp_seq set not null;

create table public.inventory_actions (
  request_id   uuid primary key,
  project_id   uuid not null references public.projects(id) on delete cascade,
  action       text not null check (action in ('receive', 'count', 'tracking')),
  item_id      text not null,
  input        jsonb not null,
  binding_hash text not null,
  actor        uuid not null,
  note         text,
  result       jsonb not null,
  created_at   timestamptz not null default now(),
  txid         bigint not null,
  stamp_seq    bigint not null
);
alter table public.inventory_actions enable row level security;
revoke all on table public.inventory_actions from public, anon, authenticated, service_role;

create or replace function public.lf_stamp()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Unconditional overwrite: a client- or function-supplied value is discarded.
  new.txid := txid_current();
  new.stamp_seq := nextval('public.inventory_stamp_seq');
  return new;
end $$;
revoke all on function public.lf_stamp() from public, anon, authenticated, service_role;

-- Named zzz_ so it fires LAST among BEFORE INSERT row triggers (alphabetical order).
create trigger zzz_lf_stamp before insert on public.inventory_transactions for each row execute function public.lf_stamp();
create trigger zzz_lf_stamp before insert on public.orders                 for each row execute function public.lf_stamp();
create trigger zzz_lf_stamp before insert on public.inventory_actions      for each row execute function public.lf_stamp();

create or replace function public.lf_ledger_append_only()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'Inventory ledger rows are append-only';
end $$;
create trigger lf_ledger_append_only before update on public.inventory_transactions
  for each row execute function public.lf_ledger_append_only();

create or replace function public.lf_stamp_immutable()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.txid is distinct from old.txid or new.stamp_seq is distinct from old.stamp_seq then
    raise exception 'Transaction stamps are immutable';
  end if;
  return new;
end $$;
create trigger lf_stamp_immutable before update on public.orders
  for each row execute function public.lf_stamp_immutable();
create or replace function public.lf_actions_immutable()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'Inventory actions are append-only';
end $$;
create trigger lf_actions_immutable before update on public.inventory_actions
  for each row execute function public.lf_actions_immutable();

-- Column-level insert grant: only the columns restock_inventory/adjust_inventory
-- (SECURITY INVOKER) write. Stamp and signed-readiness columns are excluded.
revoke insert on table public.inventory_transactions from authenticated;
grant insert (user_id, project_id, order_id, item_id, item_name, transaction_type,
              quantity_change, quantity_before, quantity_after)
  on table public.inventory_transactions to authenticated;

-- ---------------------------------------------------------------------------
-- F-4  Signed quantities prepared, not activated
-- ---------------------------------------------------------------------------
alter table public.inventory_transactions
  drop constraint inventory_transactions_before_check,
  drop constraint inventory_transactions_after_check,
  add constraint lf_ledger_sign_check
    check ((quantity_before >= 0 and quantity_after >= 0) or allow_negative),
  add constraint lf_ledger_range_check
    check (quantity_before between -1000000000 and 1000000000
           and quantity_after between -1000000000 and 1000000000);
create unique index lf_ledger_sale_line_uniq on public.inventory_transactions (order_id, line_index)
  where transaction_type = 'sale' and line_index is not null;

-- ---------------------------------------------------------------------------
-- F-1b / F-1c / F-3  Registers
-- ---------------------------------------------------------------------------
create index lf_ledger_tx_lookup on public.inventory_transactions (txid, project_id, item_id, stamp_seq);
create index lf_actions_tx_lookup on public.inventory_actions (txid, project_id, item_id, stamp_seq);

create table public.inventory_stock_reconciliations (
  id                     bigserial primary key,
  txid                   bigint not null,
  project_id             uuid not null references public.projects(id) on delete cascade,
  item_id                text not null,
  kind                   text not null check (kind in ('stock', 'tracking', 'opening')),
  reconciled_through_seq bigint not null,
  old_value              jsonb,
  new_value              jsonb,
  at                     timestamptz not null default now()
);
create index lf_recon_lookup on public.inventory_stock_reconciliations (txid, project_id, item_id, kind);
alter table public.inventory_stock_reconciliations enable row level security;
revoke all on table public.inventory_stock_reconciliations from public, anon, authenticated, service_role;
revoke all on sequence public.inventory_stock_reconciliations_id_seq from public, anon, authenticated, service_role;

create table public.menu_item_tombstones (
  project_id   uuid not null references public.projects(id) on delete cascade,
  item_id      text not null,
  deleted_at   timestamptz not null default now(),
  deleted_by   uuid,
  last_stock   jsonb,
  last_tracked boolean,
  primary key (project_id, item_id)
);
alter table public.menu_item_tombstones enable row level security;
revoke all on table public.menu_item_tombstones from public, anon, authenticated, service_role;

alter table public.projects
  add column catalog_version integer not null default 0,
  add column base_catalog_version integer;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.lf_int_or_null(p jsonb)
returns integer language plpgsql immutable as $$
begin
  if p is null or jsonb_typeof(p) <> 'number' then return null; end if;
  if (p::text)::numeric <> trunc((p::text)::numeric) then return null; end if;
  return (p::text)::numeric::integer;
exception when others then return null;
end $$;

create or replace function public.lf_tracked(p jsonb)
returns boolean language sql immutable as $$
  select coalesce(case when jsonb_typeof(p -> 'trackInventory') = 'boolean'
                       then (p ->> 'trackInventory')::boolean end, false)
$$;

-- Records an opening-stock ledger row (if > 0) and its reconciliation, for a new
-- tracked item. Called from the projects guard (UPDATE) and the AFTER INSERT trigger.
create or replace function public.lf_record_opening(p_project uuid, p_owner uuid, p_item jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_n integer := public.lf_int_or_null(p_item -> 'stockQuantity');
  v_seq bigint := 0;
begin
  if v_n is null or v_n < 0 or v_n > 1000000000 then
    raise exception 'invalid_opening_stock for item %', p_item ->> 'id';
  end if;
  if v_n > 0 then
    insert into public.inventory_transactions (user_id, project_id, order_id, item_id, item_name,
      transaction_type, quantity_change, quantity_before, quantity_after)
    values (p_owner, p_project, null, p_item ->> 'id', coalesce(nullif(p_item ->> 'name', ''), p_item ->> 'id'),
      'adjustment', v_n, 0, v_n)
    returning stamp_seq into v_seq;
  end if;
  insert into public.inventory_stock_reconciliations (txid, project_id, item_id, kind,
    reconciled_through_seq, old_value, new_value)
  values (txid_current(), p_project, p_item ->> 'id', 'opening', v_seq, null, to_jsonb(v_n));
end $$;
revoke all on function public.lf_record_opening(uuid, uuid, jsonb) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- F-1 / F-3  The projects guard (BEFORE UPDATE)
-- ---------------------------------------------------------------------------
-- Batch B — catalog shape. NULL when acceptable; otherwise the problem.
create or replace function public.lf_catalog_problem(p_items jsonb)
returns text language sql immutable as $$
  select case
    when p_items is null or jsonb_typeof(p_items) <> 'array' then 'menuItems must be an array'
    when exists (select 1 from jsonb_array_elements(p_items) e where jsonb_typeof(e) <> 'object') then 'every item must be an object'
    when exists (select 1 from jsonb_array_elements(p_items) e
                 where jsonb_typeof(e -> 'id') <> 'string' or btrim(e ->> 'id') = '' or length(e ->> 'id') > 200)
      then 'every item needs a non-empty id'
    when (select count(*) from jsonb_array_elements(p_items)) <> (select count(distinct e ->> 'id') from jsonb_array_elements(p_items) e)
      then 'item ids must be unique'
  end
$$;
revoke all on function public.lf_catalog_problem(jsonb) from public, anon, authenticated, service_role;

create or replace function public.lf_projects_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
-- v2 (after run 1): set-based change detection; only items that changed or have
-- unconsumed evidence in this transaction are examined; fast path otherwise.
declare
  v_tx        bigint := txid_current();
  v_base      integer := new.base_catalog_version;
  v_old_items jsonb := coalesce(old.config -> 'menuItems', '[]'::jsonb);
  v_new_items jsonb := coalesce(new.config -> 'menuItems', '[]'::jsonb);
  v_added     text[];
  v_removed   text[];
  v_structural boolean := false;
  v_c         record;
  v_rows      record;
  v_w         bigint;
  v_first     boolean;
  v_prev_after integer;
  v_last_seq  bigint;
  v_old_stock integer;
  v_new_stock integer;
  v_cnt       integer;
  v_seq       bigint;
  v_input     jsonb;
  v_cfg       jsonb := new.config;
  v_evidence  text[];
  v_problem   text;
begin
  new.catalog_version := old.catalog_version;
  new.base_catalog_version := null;

  -- Batch B — no bypass through a malformed catalog. A non-array or dropped
  -- menuItems used to return early, skipping every check below (and a later
  -- save against a non-array OLD could then set any stock). Now the shape is
  -- validated first; a refusal rolls the whole statement back, so neither stock
  -- nor history is touched.
  if new.config is null or jsonb_typeof(new.config) <> 'object' then
    raise exception 'invalid_catalog: configuration must be an object';
  end if;
  if not (new.config ? 'menuItems') then
    if jsonb_typeof(old.config -> 'menuItems') = 'array' then
      raise exception 'invalid_catalog: menuItems is missing';
    end if;
    return new; -- no catalog has ever existed here; nothing to protect
  end if;
  v_new_items := new.config -> 'menuItems';
  v_old_items := case when jsonb_typeof(old.config -> 'menuItems') = 'array'
                      then old.config -> 'menuItems' else '[]'::jsonb end;
  if jsonb_typeof(v_new_items) <> 'array' then
    raise exception 'invalid_catalog: menuItems must be an array';
  end if;
  -- One pass each: if the ordered item-id list is unchanged (every sale-function
  -- stock write), no NEW malformation can have been introduced — a pre-existing
  -- one on legacy data is tolerated so sales are never blocked. Only a changed id
  -- list (an owner edit adding/removing/renaming ids) pays for the full check.
  if (select jsonb_agg(e -> 'id') from jsonb_array_elements(v_new_items) e)
     is distinct from (select jsonb_agg(e -> 'id') from jsonb_array_elements(v_old_items) e) then
    v_problem := public.lf_catalog_problem(v_new_items);
    if v_problem is not null then
      raise exception 'invalid_catalog: %', v_problem;
    end if;
  end if;

  -- Fast path: identical catalogs and no evidence in this transaction.
  if v_new_items = v_old_items
     and not exists (select 1 from public.inventory_transactions t where t.txid = v_tx and t.project_id = new.id)
     and not exists (select 1 from public.inventory_actions a where a.txid = v_tx and a.project_id = new.id) then
    return new;
  end if;

  select coalesce(array_agg(n.id) filter (where o.id is null), '{}'),
         coalesce(array_agg(o.id) filter (where n.id is null), '{}')
    into v_added, v_removed
  from (select e ->> 'id' id from jsonb_array_elements(v_new_items) e) n
  full join (select e ->> 'id' id from jsonb_array_elements(v_old_items) e) o using (id);
  -- (hash full join; n.id / o.id are null on the missing side)

  if cardinality(v_added) > 0 or cardinality(v_removed) > 0 then
    if v_base is null or v_base <> old.catalog_version then
      raise exception 'catalog_conflict: reload before saving';
    end if;
    if exists (select 1 from public.menu_item_tombstones t
               where t.project_id = new.id and t.item_id = any (v_added)) then
      raise exception 'item_id_retired';
    end if;
    v_structural := true;
  end if;

  -- Items with any evidence (ledger rows or tracking actions) in this transaction.
  select coalesce(array_agg(distinct x.item_id), '{}') into v_evidence from (
    select t.item_id from public.inventory_transactions t where t.txid = v_tx and t.project_id = new.id
    union all
    select a.item_id from public.inventory_actions a where a.txid = v_tx and a.project_id = new.id and a.action = 'tracking') x;

  -- Opening stock for new tracked items.
  for v_c in
    select n.e from jsonb_array_elements(v_new_items) n(e) where (n.e ->> 'id') = any (v_added)
  loop
    if public.lf_tracked(v_c.e) then
      perform public.lf_record_opening(new.id, new.user_id, v_c.e);
    end if;
  end loop;

  -- Existing items that changed, or that have unconsumed evidence in this transaction.
  for v_c in
    with n as (select e, (ord - 1)::int idx from jsonb_array_elements(v_new_items) with ordinality t(e, ord)),
         o as (select e from jsonb_array_elements(v_old_items) t(e)),
         j as (select n.idx, n.e new_e, o.e old_e, n.e ->> 'id' id from n join o on o.e ->> 'id' = n.e ->> 'id')
    select * from j
    where (j.new_e -> 'stockQuantity') is distinct from (j.old_e -> 'stockQuantity')
       or public.lf_tracked(j.new_e) <> public.lf_tracked(j.old_e)
       or j.id = any (v_evidence)
  loop
    -- ---- F-1c tracking ----
    if public.lf_tracked(v_c.new_e) <> public.lf_tracked(v_c.old_e) then
      select coalesce(max(r.reconciled_through_seq), 0) into v_w
      from public.inventory_stock_reconciliations r
      where r.txid = v_tx and r.project_id = new.id and r.item_id = v_c.id and r.kind = 'tracking';
      select count(*), max(a.stamp_seq), (array_agg(a.input order by a.stamp_seq))[1]
        into v_cnt, v_seq, v_input
      from public.inventory_actions a
      where a.txid = v_tx and a.project_id = new.id and a.item_id = v_c.id
        and a.action = 'tracking' and a.stamp_seq > v_w;
      if v_cnt = 1 and (v_input ->> 'enabled')::boolean = public.lf_tracked(v_c.new_e) then
        insert into public.inventory_stock_reconciliations (txid, project_id, item_id, kind,
          reconciled_through_seq, old_value, new_value)
        values (v_tx, new.id, v_c.id, 'tracking', v_seq,
                to_jsonb(public.lf_tracked(v_c.old_e)), to_jsonb(public.lf_tracked(v_c.new_e)));
        v_structural := true;
      else
        v_cfg := jsonb_set(v_cfg, array['menuItems', v_c.idx::text, 'trackInventory'],
                           coalesce(v_c.old_e -> 'trackInventory', 'false'::jsonb), true);
      end if;
    end if;

    -- ---- F-1b stock ----
    select coalesce(max(r.reconciled_through_seq), 0) into v_w
    from public.inventory_stock_reconciliations r
    where r.txid = v_tx and r.project_id = new.id and r.item_id = v_c.id and r.kind in ('stock', 'opening');
    v_first := true;
    v_last_seq := null;
    v_old_stock := public.lf_int_or_null(v_c.old_e -> 'stockQuantity');
    for v_rows in
      select t.* from public.inventory_transactions t
      where t.txid = v_tx and t.project_id = new.id and t.item_id = v_c.id and t.stamp_seq > v_w
      order by t.stamp_seq
    loop
      if v_first then
        if v_rows.quantity_before is distinct from v_old_stock then
          raise exception 'stock_chain_mismatch: first row before % <> old stock % (item %)',
            v_rows.quantity_before, v_old_stock, v_c.id;
        end if;
        v_first := false;
      elsif v_rows.quantity_before <> v_prev_after then
        raise exception 'stock_chain_gap: % <> % (item %)', v_rows.quantity_before, v_prev_after, v_c.id;
      end if;
      if v_rows.transaction_type = 'sale' and not exists (
           select 1 from public.orders o
           where o.id = v_rows.order_id and o.txid = v_tx and o.project_id = new.id) then
        raise exception 'sale_row_without_same_transaction_order (item %)', v_c.id;
      end if;
      v_prev_after := v_rows.quantity_after;
      v_last_seq := v_rows.stamp_seq;
    end loop;

    v_new_stock := public.lf_int_or_null(v_c.new_e -> 'stockQuantity');
    if v_last_seq is null then
      if (v_c.new_e -> 'stockQuantity') is distinct from (v_c.old_e -> 'stockQuantity') then
        if v_c.old_e ? 'stockQuantity' then
          v_cfg := jsonb_set(v_cfg, array['menuItems', v_c.idx::text, 'stockQuantity'], v_c.old_e -> 'stockQuantity', true);
        else
          v_cfg := v_cfg #- array['menuItems', v_c.idx::text, 'stockQuantity'];
        end if;
      end if;
    else
      if v_prev_after is distinct from v_new_stock then
        raise exception 'stock_chain_mismatch: last row after % <> new stock % (item %)',
          v_prev_after, v_new_stock, v_c.id;
      end if;
      insert into public.inventory_stock_reconciliations (txid, project_id, item_id, kind,
        reconciled_through_seq, old_value, new_value)
      values (v_tx, new.id, v_c.id, 'stock', v_last_seq, v_c.old_e -> 'stockQuantity', v_c.new_e -> 'stockQuantity');
    end if;
  end loop;

  if cardinality(v_removed) > 0 then
    insert into public.menu_item_tombstones (project_id, item_id, deleted_by, last_stock, last_tracked)
    select new.id, o.e ->> 'id', auth.uid(), o.e -> 'stockQuantity', public.lf_tracked(o.e)
    from jsonb_array_elements(v_old_items) o(e)
    where (o.e ->> 'id') = any (v_removed)
    on conflict (project_id, item_id) do nothing;
  end if;

  if v_structural then
    new.catalog_version := old.catalog_version + 1;
  end if;
  new.config := v_cfg;
  return new;
end $$;
revoke all on function public.lf_projects_guard() from public, anon, authenticated, service_role;
create trigger lf_projects_guard before update on public.projects
  for each row execute function public.lf_projects_guard();

-- Project creation (E2): catalog columns forced; opening stock AFTER INSERT so the
-- ledger's foreign key to projects is satisfied.
create or replace function public.lf_projects_before_insert()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.catalog_version := 0;
  new.base_catalog_version := null;
  if new.config is not null and new.config ? 'menuItems'
     and public.lf_catalog_problem(new.config -> 'menuItems') is not null then
    raise exception 'invalid_catalog: %', public.lf_catalog_problem(new.config -> 'menuItems');
  end if;
  return new;
end $$;
create trigger lf_projects_before_insert before insert on public.projects
  for each row execute function public.lf_projects_before_insert();

create or replace function public.lf_projects_after_insert()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_item jsonb;
begin
  if jsonb_typeof(new.config -> 'menuItems') = 'array' then
    for v_item in select value from jsonb_array_elements(new.config -> 'menuItems') loop
      if public.lf_tracked(v_item) then
        perform public.lf_record_opening(new.id, new.user_id, v_item);
      end if;
    end loop;
  end if;
  return null;
end $$;
revoke all on function public.lf_projects_after_insert() from public, anon, authenticated, service_role;
create trigger lf_projects_after_insert after insert on public.projects
  for each row execute function public.lf_projects_after_insert();

-- ---------------------------------------------------------------------------
-- F-1b  Commit-time completeness
-- ---------------------------------------------------------------------------
create or replace function public.lf_ledger_completeness()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (
    select 1 from public.inventory_stock_reconciliations r
    where r.txid = new.txid and r.project_id = new.project_id and r.item_id = new.item_id
      and r.kind in ('stock', 'opening') and r.reconciled_through_seq >= new.stamp_seq) then
    raise exception 'unreconciled_ledger_row % (item %)', new.id, new.item_id;
  end if;
  return null;
end $$;
revoke all on function public.lf_ledger_completeness() from public, anon, authenticated, service_role;
create constraint trigger lf_ledger_completeness after insert on public.inventory_transactions
  deferrable initially deferred for each row execute function public.lf_ledger_completeness();

-- ---------------------------------------------------------------------------
-- F-2  Request-bound owner actions
-- ---------------------------------------------------------------------------
create or replace function public.lf_item_index(p_items jsonb, p_item_id text)
returns integer language sql immutable as $$
  select (o - 1)::integer from jsonb_array_elements(p_items) with ordinality as e(v, o)
  where v ->> 'id' = p_item_id limit 1
$$;

create or replace function public.lf_owner_action(
  p_project_id uuid, p_action text, p_item_id text, p_input jsonb, p_request_id uuid, p_note text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user   uuid := auth.uid();
  v_proj   record;
  v_hash   text;
  v_prev   record;
  v_items  jsonb;
  v_idx    integer;
  v_item   jsonb;
  v_before integer;
  v_after  integer;
  v_qty    integer;
  v_result jsonb;
  v_enabled boolean;
  v_cv     integer;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_request_id is null then raise exception 'request_id is required'; end if;
  if p_item_id is null or btrim(p_item_id) = '' then raise exception 'Item id is required'; end if;

  -- Input shape validated BEFORE authorization would leak nothing either way.
  if p_action = 'receive' then
    v_qty := public.lf_int_or_null(p_input -> 'quantity');
    if v_qty is null or v_qty < 1 or v_qty > 1000000 then raise exception 'Quantity must be 1 to 1000000'; end if;
  elsif p_action = 'count' then
    v_qty := public.lf_int_or_null(p_input -> 'counted');
    if v_qty is null or v_qty < 0 or v_qty > 1000000000 then raise exception 'Counted must be 0 to 1000000000'; end if;
  elsif p_action = 'tracking' then
    if jsonb_typeof(p_input -> 'enabled') <> 'boolean' then raise exception 'enabled must be true or false'; end if;
    v_enabled := (p_input ->> 'enabled')::boolean;
  else
    raise exception 'Unknown action';
  end if;

  -- 3. Authorize and lock BEFORE any request-id lookup.
  select * into v_proj from public.projects where id = p_project_id and user_id = v_user for update;
  if not found then raise exception 'Project not found or access denied'; end if;

  -- 4. Bound request id.
  v_hash := encode(sha256(convert_to(p_project_id::text || '|' || p_action || '|' || p_item_id || '|' || p_input::text, 'UTF8')), 'hex');
  select * into v_prev from public.inventory_actions where request_id = p_request_id;
  if found then
    if v_prev.project_id = p_project_id and v_prev.binding_hash = v_hash then
      -- Batch B — the CURRENT authoritative catalog version, never a stored one.
      return v_prev.result || jsonb_build_object('replayed', true, 'catalogVersionBefore', null,
                                                 'catalogVersion', v_proj.catalog_version);
    end if;
    raise exception 'request_conflict';
  end if;

  -- 5. Act.
  v_items := v_proj.config -> 'menuItems';
  v_idx := public.lf_item_index(v_items, p_item_id);
  if v_idx is null then raise exception 'Menu item not found'; end if;
  v_item := v_items -> v_idx;

  if p_action in ('receive', 'count') then
    if not public.lf_tracked(v_item) then raise exception 'Turn on stock tracking first'; end if;
    v_before := public.lf_int_or_null(v_item -> 'stockQuantity');
    if v_before is null then raise exception 'Stock value is invalid'; end if;
    v_after := case when p_action = 'receive' then v_before + v_qty else v_qty end;
    v_result := jsonb_build_object('action', p_action, 'itemId', p_item_id, 'before', v_before, 'after', v_after);
    insert into public.inventory_actions (request_id, project_id, action, item_id, input, binding_hash, actor, note, result)
    values (p_request_id, p_project_id, p_action, p_item_id, p_input, v_hash, v_user, p_note, v_result);
    if v_after <> v_before then
      insert into public.inventory_transactions (user_id, project_id, order_id, item_id, item_name,
        transaction_type, quantity_change, quantity_before, quantity_after)
      values (v_user, p_project_id, null, p_item_id, coalesce(nullif(v_item ->> 'name', ''), p_item_id),
        case when p_action = 'receive' then 'restock' else 'adjustment' end, v_after - v_before, v_before, v_after);
      update public.projects
        set config = jsonb_set(v_proj.config, array['menuItems', v_idx::text, 'stockQuantity'], to_jsonb(v_after), true),
            updated_at = now()
        where id = p_project_id;
    end if;
  else
    v_result := jsonb_build_object('action', 'tracking', 'itemId', p_item_id,
                                   'before', public.lf_tracked(v_item), 'after', v_enabled);
    insert into public.inventory_actions (request_id, project_id, action, item_id, input, binding_hash, actor, note, result)
    values (p_request_id, p_project_id, 'tracking', p_item_id, p_input, v_hash, v_user, p_note, v_result);
    if public.lf_tracked(v_item) <> v_enabled then
      update public.projects
        set config = jsonb_set(v_proj.config, array['menuItems', v_idx::text, 'trackInventory'], to_jsonb(v_enabled), true),
            updated_at = now()
        where id = p_project_id;
    end if;
  end if;
  -- Batch B — authoritative versions: before = at authorization (locked row),
  -- after = as committed by this transaction (incl. no-op answers).
  select p.catalog_version into v_cv from public.projects p where p.id = p_project_id;
  return v_result || jsonb_build_object('replayed', false, 'catalogVersionBefore', v_proj.catalog_version,
                                        'catalogVersion', v_cv);
end $$;
revoke all on function public.lf_owner_action(uuid, text, text, jsonb, uuid, text) from public, anon, authenticated, service_role;

create or replace function public.inventory_receive(p_project_id uuid, p_item_id text, p_quantity integer, p_request_id uuid, p_note text default null)
returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select public.lf_owner_action(p_project_id, 'receive', p_item_id, jsonb_build_object('quantity', p_quantity), p_request_id, p_note)
$$;
create or replace function public.inventory_count(p_project_id uuid, p_item_id text, p_counted integer, p_request_id uuid, p_note text default null)
returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select public.lf_owner_action(p_project_id, 'count', p_item_id, jsonb_build_object('counted', p_counted), p_request_id, p_note)
$$;
create or replace function public.set_item_tracking(p_project_id uuid, p_item_id text, p_enabled boolean, p_request_id uuid, p_note text default null)
returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select public.lf_owner_action(p_project_id, 'tracking', p_item_id, jsonb_build_object('enabled', p_enabled), p_request_id, p_note)
$$;
revoke all on function public.inventory_receive(uuid, text, integer, uuid, text) from public, anon;
revoke all on function public.inventory_count(uuid, text, integer, uuid, text) from public, anon;
revoke all on function public.set_item_tracking(uuid, text, boolean, uuid, text) from public, anon;
grant execute on function public.inventory_receive(uuid, text, integer, uuid, text) to authenticated;
grant execute on function public.inventory_count(uuid, text, integer, uuid, text) to authenticated;
grant execute on function public.set_item_tracking(uuid, text, boolean, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Batch B — owner-only inventory audit / history
-- ---------------------------------------------------------------------------
-- One feed for the owner: every owner action (receive, count — including counts
-- that changed nothing — and tracking switches, with actor and note), every
-- ledger row (sales, opening stock, legacy restock/adjust; a row written by an
-- action carries that action's request id so the UI need not show it twice), and
-- every deleted item (tombstone with its last stock). Newest first; p_before
-- pages backwards. Devices and other owners are refused before anything is read.
create or replace function public.inventory_history(
  p_project_id uuid, p_limit integer default 200, p_before timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_user  uuid := auth.uid();
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 1000);
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if not exists (select 1 from public.projects p where p.id = p_project_id and p.user_id = v_user) then
    raise exception 'Project not found or access denied';
  end if;

  return coalesce((
    select jsonb_agg(ev order by (ev ->> 'at') desc, (ev ->> 'seq')::bigint desc)
    from (
      select * from (
        select jsonb_build_object(
          'kind', 'action', 'at', a.created_at, 'seq', a.stamp_seq, 'requestId', a.request_id,
          'action', a.action, 'itemId', a.item_id, 'input', a.input, 'result', a.result,
          'note', a.note, 'actor', a.actor,
          'zeroChange', (a.result -> 'before') = (a.result -> 'after'),
          'itemDeleted', exists (select 1 from public.menu_item_tombstones t
                                 where t.project_id = a.project_id and t.item_id = a.item_id)) ev
        from public.inventory_actions a
        where a.project_id = p_project_id and (p_before is null or a.created_at < p_before)
        union all
        select jsonb_build_object(
          'kind', 'ledger', 'at', t.created_at, 'seq', t.stamp_seq, 'transactionType', t.transaction_type,
          'itemId', t.item_id, 'itemName', t.item_name, 'orderId', t.order_id,
          'before', t.quantity_before, 'after', t.quantity_after, 'change', t.quantity_change,
          'actionRequestId', (select a.request_id from public.inventory_actions a
                              where a.txid = t.txid and a.project_id = t.project_id and a.item_id = t.item_id
                                and a.stamp_seq < t.stamp_seq order by a.stamp_seq desc limit 1),
          'itemDeleted', exists (select 1 from public.menu_item_tombstones x
                                 where x.project_id = t.project_id and x.item_id = t.item_id))
        from public.inventory_transactions t
        where t.project_id = p_project_id and (p_before is null or t.created_at < p_before)
        union all
        select jsonb_build_object(
          'kind', 'deletion', 'at', d.deleted_at, 'seq', 0, 'itemId', d.item_id,
          'lastStock', d.last_stock, 'lastTracked', d.last_tracked, 'actor', d.deleted_by)
        from public.menu_item_tombstones d
        where d.project_id = p_project_id and (p_before is null or d.deleted_at < p_before)
      ) all_events
      order by (ev ->> 'at') desc, (ev ->> 'seq')::bigint desc
      limit v_limit
    ) q
  ), '[]'::jsonb);
end $$;
revoke all on function public.inventory_history(uuid, integer, timestamptz) from public, anon;
grant execute on function public.inventory_history(uuid, integer, timestamptz) to authenticated;

-- Helpers are internal: no API role may call them directly.
revoke all on function public.lf_int_or_null(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.lf_tracked(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.lf_item_index(jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.lf_ledger_append_only() from public, anon, authenticated, service_role;
revoke all on function public.lf_stamp_immutable() from public, anon, authenticated, service_role;
revoke all on function public.lf_actions_immutable() from public, anon, authenticated, service_role;
revoke all on function public.lf_projects_before_insert() from public, anon, authenticated, service_role;
