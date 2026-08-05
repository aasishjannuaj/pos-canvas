-- Milestone 16, Feature 16.3 — Migration D2
-- Order counter and idempotency schema scaffold.
--
-- BEHAVIOR-NEUTRAL BY CONSTRUCTION. This migration adds storage and constraints
-- only. It replaces no function, changes no RPC, alters no privilege on any
-- existing table, and writes nothing to orders. Until D3 ships
-- complete_sale_v2, the counter table stays untouched and every order continues
-- to be inserted by complete_sale v1 with number_source defaulting to 'client'.
--
-- ----------------------------------------------------------------------------
-- EXISTING-DATA ASSUMPTIONS (established by live inspection before D1)
-- ----------------------------------------------------------------------------
--   * orders.project_id is NULLABLE, with ON DELETE SET NULL from projects.
--   * order_number is NOT NULL text with no unique constraint.
--   * ONE duplicate (project_id, order_number) pair already exists — 'ORD-1001'
--     twice in one project, 101 seconds apart. It must NOT be renamed.
--   * One project's history spans three prefixes (ORD-, ORDER, A1-) against a
--     configured prefix of A1-, so the counter must NOT be derived from the
--     configured prefix, from a lexicographic max, or from an order count.
--   * Every live order currently ends in digits; max suffixes observed were
--     1001-1011.
--   * Three display numbers are reused across DIFFERENT projects. That stays
--     legal — uniqueness is per project.
--
-- ----------------------------------------------------------------------------
-- ON project_id NULL + sale_request_id NOT NULL — PROHIBITED, WITH A CAVEAT
-- ----------------------------------------------------------------------------
-- Idempotency is meaningless unscoped: the partial unique index below is keyed
-- on (project_id, sale_request_id), so a row with a null project_id would fall
-- OUTSIDE the index and could be duplicated without limit under one request id.
-- orders_sale_request_requires_project_check therefore forbids the combination.
--
-- CONSEQUENCE WORTH KNOWING BEFORE APPLYING: orders.project_id carries
-- ON DELETE SET NULL. Once D3 writes orders with a sale_request_id, deleting
-- that project will attempt to null project_id on those rows and will FAIL the
-- check, blocking the delete. That is currently unreachable — D1 removed DELETE
-- on projects from authenticated, and no application flow deletes a project —
-- but a future delete-project feature must first clear those request ids or the
-- FK must be revisited. Recorded as an unresolved risk rather than silently
-- accepted.

-- ----------------------------------------------------------------------------
-- B. orders.number_source
--
-- Historical rows take the DEFAULT and become 'client'. No order number is
-- rewritten and no UPDATE is issued against orders anywhere in this migration.
-- complete_sale v1 does not mention this column, so its inserts keep working
-- untouched and keep receiving 'client'. D3's complete_sale_v2 will write
-- 'server' explicitly.
-- ----------------------------------------------------------------------------
alter table public.orders
  add column if not exists number_source text not null default 'client';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'orders_number_source_check'
  ) then
    alter table public.orders
      add constraint orders_number_source_check
      check (number_source in ('client', 'server'));
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- C. Idempotency storage.
--
-- Both columns are nullable and stay null for every historical row. Nothing is
-- computed or backfilled here, and there is deliberately NO default on
-- sale_request_id: the value must come from the client in D3, so a
-- server-generated default would defeat the whole mechanism.
-- ----------------------------------------------------------------------------
alter table public.orders
  add column if not exists sale_request_id uuid;

alter table public.orders
  add column if not exists sale_request_hash text;

do $$
begin
  -- Both null or both non-null. A request id without its canonical hash could
  -- not be checked for a mismatch, which is exactly the D3 behavior these
  -- columns exist to support.
  if not exists (
    select 1 from pg_constraint where conname = 'orders_sale_request_pair_check'
  ) then
    alter table public.orders
      add constraint orders_sale_request_pair_check
      check ((sale_request_id is null) = (sale_request_hash is null));
  end if;

  -- Lowercase SHA-256 hex, exactly 64 characters. Uppercase is rejected so the
  -- stored form is canonical and comparison never needs normalization.
  if not exists (
    select 1 from pg_constraint where conname = 'orders_sale_request_hash_format_check'
  ) then
    alter table public.orders
      add constraint orders_sale_request_hash_format_check
      check (sale_request_hash is null or sale_request_hash ~ '^[0-9a-f]{64}$');
  end if;

  -- See the caveat above.
  if not exists (
    select 1 from pg_constraint where conname = 'orders_sale_request_requires_project_check'
  ) then
    alter table public.orders
      add constraint orders_sale_request_requires_project_check
      check (sale_request_id is null or project_id is not null);
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- D. Per-project counter.
--
-- last_number is the most recently ALLOCATED suffix, so a fresh project moves
-- 1000 -> 1001 on its first sale. D3 allocates with
--   update ... set last_number = last_number + 1 returning last_number
-- inside the same transaction as the order, under the project row's existing
-- FOR UPDATE lock. A PostgreSQL sequence is deliberately NOT used: nextval is
-- non-transactional and would leave a gap on every rolled-back sale.
-- ----------------------------------------------------------------------------
create table if not exists public.project_order_counters (
  project_id uuid primary key
    references public.projects(id) on delete cascade,
  last_number bigint not null default 1000,
  updated_at timestamptz not null default now(),

  constraint project_order_counters_last_number_check
    check (last_number >= 1000)
);

alter table public.project_order_counters enable row level security;

-- Deterministic privilege posture, matching D1. Supabase applies
-- ALTER DEFAULT PRIVILEGES to new public tables, so this table is NOT born
-- private — it starts with ALL granted to anon, authenticated and service_role.
-- Every one of those is revoked and NOTHING is granted back: the only intended
-- accessor is a postgres-owned SECURITY DEFINER checkout function in D3, which
-- bypasses both RLS and table privileges.
revoke all privileges on table public.project_order_counters from public;
revoke all privileges on table public.project_order_counters from anon;
revoke all privileges on table public.project_order_counters from authenticated;
revoke all privileges on table public.project_order_counters from service_role;

-- No policies are created. RLS is on with zero policies, so even if a privilege
-- were somehow granted later, every row would still be invisible.

-- ----------------------------------------------------------------------------
-- E. Seed counters from history.
--
-- Defensive pre-check FIRST: a trailing digit run longer than 18 characters
-- could overflow bigint on cast. bigint tops out at 9223372036854775807 (19
-- digits), so 18 digits is unconditionally safe. If any row exceeds that, the
-- migration ABORTS rather than clamping a corrupt value — and the message names
-- only the project, never the order number itself.
-- ----------------------------------------------------------------------------
do $$
declare
  v_project uuid;
begin
  select o.project_id
  into v_project
  from public.orders o
  where o.project_id is not null
    and substring(o.order_number from '([0-9]+)$') is not null
    and length(substring(o.order_number from '([0-9]+)$')) > 18
  limit 1;

  if v_project is not null then
    raise exception
      'Migration D2: project % has an order number whose trailing numeric suffix is too long to seed safely; seed that counter manually before applying',
      v_project;
  end if;
end $$;

-- One row per existing project.
--
--   * digits are parsed ONLY from the very end of order_number, so the
--     historical prefix (ORD-, ORDER, A1-) is irrelevant.
--   * every historical order for the project is considered.
--   * orders with a null project_id cannot seed any project and are excluded.
--   * a project with no orders — or none with a parseable suffix — seeds to 1000.
--   * ON CONFLICT DO NOTHING makes a partial retry safe and, critically, never
--     overwrites a counter row that later behavior may already have advanced.
insert into public.project_order_counters (project_id, last_number)
select
  p.id,
  greatest(
    1000,
    coalesce(
      (
        select max((substring(o.order_number from '([0-9]+)$'))::bigint)
        from public.orders o
        where o.project_id = p.id
          and substring(o.order_number from '([0-9]+)$') is not null
          and length(substring(o.order_number from '([0-9]+)$')) <= 18
      ),
      1000
    )
  )
from public.projects p
on conflict (project_id) do nothing;

-- ----------------------------------------------------------------------------
-- F. Uniqueness backstops.
--
-- Both are PARTIAL. The server-number index covers only rows this system
-- allocates, so the pre-existing duplicate client pair remains valid and
-- readable — no historical customer-facing number is rewritten. Neither index
-- is global: project A and project B may both display ORD-1001.
-- ----------------------------------------------------------------------------
create unique index if not exists orders_server_number_unique
  on public.orders (project_id, order_number)
  where number_source = 'server' and project_id is not null;

create unique index if not exists orders_sale_request_unique
  on public.orders (project_id, sale_request_id)
  where sale_request_id is not null and project_id is not null;

-- ----------------------------------------------------------------------------
-- H. Verification.
--
-- Catalog and semantic checks only — no rendered-definition length or md5 of a
-- deparsed function, both of which produced false failures earlier in this
-- milestone.
--
-- NOTE ON complete_sale: this block asserts its POSTURE (definer, search_path,
-- language, grants, signature) but NOT a body hash. The post-Migration-C body
-- hash is not recorded anywhere in this repository, so hardcoding one here would
-- be a guess. Capture it with the pre-apply query and compare it with the
-- post-apply query instead.
-- ----------------------------------------------------------------------------
do $$
declare
  v_att record;
  v_count integer;
  v_expected bigint;
  v_actual bigint;
  v_project uuid;
  v_priv text;
  v_expected_priv record;
  v_has boolean;
  v_should boolean;
  c_privs constant text[] := array[
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
  ];
begin
  -- ---- orders.number_source -------------------------------------------------
  select a.attnotnull,
         pg_get_expr(d.adbin, d.adrelid) as default_expr,
         format_type(a.atttypid, a.atttypmod) as coltype
  into v_att
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where n.nspname = 'public' and c.relname = 'orders'
    and a.attname = 'number_source' and a.attnum > 0 and not a.attisdropped;

  if not found then
    raise exception 'D2: orders.number_source is missing';
  end if;
  if not v_att.attnotnull then
    raise exception 'D2: orders.number_source must be NOT NULL';
  end if;
  if v_att.coltype <> 'text' then
    raise exception 'D2: orders.number_source must be text, found %', v_att.coltype;
  end if;
  if v_att.default_expr is null or v_att.default_expr not like '%client%' then
    raise exception 'D2: orders.number_source must default to client, found %',
      coalesce(v_att.default_expr, '<none>');
  end if;

  -- ---- idempotency columns --------------------------------------------------
  select format_type(a.atttypid, a.atttypmod) into v_att
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'orders'
    and a.attname = 'sale_request_id' and a.attnum > 0 and not a.attisdropped;
  if not found then
    raise exception 'D2: orders.sale_request_id is missing';
  end if;

  if not exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'orders'
      and a.attname = 'sale_request_id'
      and format_type(a.atttypid, a.atttypmod) = 'uuid'
      and not a.attnotnull
  ) then
    raise exception 'D2: orders.sale_request_id must be a NULLABLE uuid';
  end if;

  if not exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'orders'
      and a.attname = 'sale_request_hash'
      and format_type(a.atttypid, a.atttypmod) = 'text'
      and not a.attnotnull
  ) then
    raise exception 'D2: orders.sale_request_hash must be NULLABLE text';
  end if;

  -- sale_request_id must carry NO default: D3 requires a client-supplied value.
  if exists (
    select 1
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where n.nspname = 'public' and c.relname = 'orders'
      and a.attname = 'sale_request_id'
  ) then
    raise exception 'D2: orders.sale_request_id must not have a default';
  end if;

  -- ---- constraints ----------------------------------------------------------
  foreach v_priv in array array[
    'orders_number_source_check',
    'orders_sale_request_pair_check',
    'orders_sale_request_hash_format_check',
    'orders_sale_request_requires_project_check',
    'project_order_counters_last_number_check'
  ]
  loop
    if not exists (
      select 1 from pg_constraint where conname = v_priv and contype = 'c'
    ) then
      raise exception 'D2: check constraint % is missing', v_priv;
    end if;
  end loop;

  -- ---- counter table shape --------------------------------------------------
  if to_regclass('public.project_order_counters') is null then
    raise exception 'D2: project_order_counters is missing';
  end if;

  select count(*) into v_count
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'project_order_counters'
    and a.attnum > 0 and not a.attisdropped;
  if v_count <> 3 then
    raise exception 'D2: project_order_counters must have exactly 3 columns, found %', v_count;
  end if;

  if not exists (
    select 1 from pg_index i
    join pg_class c on c.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'project_order_counters' and i.indisprimary
  ) then
    raise exception 'D2: project_order_counters has no primary key';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.project_order_counters'::regclass
      and contype = 'f' and confdeltype = 'c'
  ) then
    raise exception 'D2: project_order_counters must cascade on project delete';
  end if;

  -- ---- counter table security ----------------------------------------------
  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'project_order_counters'
      and c.relrowsecurity
  ) then
    raise exception 'D2: row level security is not enabled on project_order_counters';
  end if;

  select count(*) into v_count
  from pg_policies
  where schemaname = 'public' and tablename = 'project_order_counters';
  if v_count <> 0 then
    raise exception 'D2: project_order_counters must have no policies, found %', v_count;
  end if;

  foreach v_priv in array c_privs
  loop
    if has_table_privilege('anon', 'public.project_order_counters', v_priv) then
      raise exception 'D2: anon holds % on project_order_counters', v_priv;
    end if;
    if has_table_privilege('authenticated', 'public.project_order_counters', v_priv) then
      raise exception 'D2: authenticated holds % on project_order_counters', v_priv;
    end if;
    if has_table_privilege('service_role', 'public.project_order_counters', v_priv) then
      raise exception 'D2: service_role holds % on project_order_counters', v_priv;
    end if;
  end loop;

  if exists (
    select 1 from information_schema.table_privileges
    where table_schema = 'public'
      and table_name = 'project_order_counters'
      and grantee = 'PUBLIC'
  ) then
    raise exception 'D2: PUBLIC holds a privilege on project_order_counters';
  end if;

  -- ---- seeding --------------------------------------------------------------
  select count(*) into v_count from public.projects;
  select count(*) into v_expected from public.project_order_counters;
  if v_count <> v_expected then
    raise exception 'D2: expected one counter per project (% projects, % counters)',
      v_count, v_expected;
  end if;

  if exists (select 1 from public.project_order_counters where last_number < 1000) then
    raise exception 'D2: a seeded counter is below the 1000 floor';
  end if;

  -- Every counter must be at least the safely parsed maximum historical suffix.
  for v_project, v_actual, v_expected in
    select c.project_id,
           c.last_number,
           greatest(
             1000,
             coalesce((
               select max((substring(o.order_number from '([0-9]+)$'))::bigint)
               from public.orders o
               where o.project_id = c.project_id
                 and substring(o.order_number from '([0-9]+)$') is not null
                 and length(substring(o.order_number from '([0-9]+)$')) <= 18
             ), 1000)
           )
    from public.project_order_counters c
  loop
    if v_actual < v_expected then
      raise exception 'D2: counter for project % is % but history requires at least %',
        v_project, v_actual, v_expected;
    end if;
  end loop;

  -- ---- historical rows untouched -------------------------------------------
  select count(*) into v_count from public.orders where number_source <> 'client';
  if v_count <> 0 then
    raise exception 'D2: % existing order(s) are not number_source = client', v_count;
  end if;

  select count(*) into v_count
  from public.orders
  where sale_request_id is not null or sale_request_hash is not null;
  if v_count <> 0 then
    raise exception 'D2: % existing order(s) already carry idempotency values', v_count;
  end if;

  -- ---- indexes with EXACT predicates ---------------------------------------
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'orders'
      and indexname = 'orders_server_number_unique'
      and indexdef like '%UNIQUE%'
      and indexdef like '%project_id, order_number%'
      and indexdef like '%number_source = ''server''%'
      and indexdef like '%project_id IS NOT NULL%'
  ) then
    raise exception 'D2: orders_server_number_unique is missing or has the wrong predicate';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'orders'
      and indexname = 'orders_sale_request_unique'
      and indexdef like '%UNIQUE%'
      and indexdef like '%project_id, sale_request_id%'
      and indexdef like '%sale_request_id IS NOT NULL%'
      and indexdef like '%project_id IS NOT NULL%'
  ) then
    raise exception 'D2: orders_sale_request_unique is missing or has the wrong predicate';
  end if;

  -- ---- complete_sale posture unchanged from Migration C --------------------
  if not (
    select p.prosecdef from pg_proc p
    where p.oid = to_regprocedure(
      'public.complete_sale(uuid,text,text,numeric,numeric,numeric,numeric,jsonb)'
    )
  ) then
    raise exception 'D2: complete_sale must remain SECURITY DEFINER';
  end if;

  if not exists (
    select 1 from pg_proc p, unnest(coalesce(p.proconfig, array[]::text[])) as cfg
    where p.oid = to_regprocedure(
      'public.complete_sale(uuid,text,text,numeric,numeric,numeric,numeric,jsonb)'
    )
      and cfg like 'search_path=%public%pg_temp%'
  ) then
    raise exception 'D2: complete_sale must keep its locked search_path';
  end if;

  if has_table_privilege('anon', 'public.orders', 'SELECT') then
    raise exception 'D2: anon regained SELECT on orders';
  end if;

  -- ---- D1 privilege posture unchanged --------------------------------------
  for v_expected_priv in
    select *
    from (values
      ('projects',               'authenticated', array['SELECT','INSERT','UPDATE']),
      ('projects',               'service_role',  '{}'::text[]),
      ('orders',                 'authenticated', array['SELECT']),
      ('orders',                 'service_role',  '{}'::text[]),
      ('order_items',            'authenticated', array['SELECT']),
      ('order_items',            'service_role',  '{}'::text[]),
      ('inventory_transactions', 'authenticated', array['SELECT','INSERT']),
      ('inventory_transactions', 'service_role',  '{}'::text[]),
      ('build_jobs',             'authenticated', array['SELECT']),
      ('build_jobs',             'service_role',  array['SELECT','INSERT']),
      ('build_artifacts',        'authenticated', array['SELECT']),
      ('build_artifacts',        'service_role',  '{}'::text[]),
      ('device_pairing_tokens',  'authenticated', array['SELECT']),
      ('device_pairing_tokens',  'service_role',  '{}'::text[]),
      ('paired_devices',         'authenticated', array['SELECT']),
      ('paired_devices',         'service_role',  '{}'::text[])
    ) as t(tbl, role_name, allowed)
  loop
    foreach v_priv in array c_privs
    loop
      v_has := has_table_privilege(
        v_expected_priv.role_name, format('public.%I', v_expected_priv.tbl), v_priv
      );
      v_should := v_priv = any(v_expected_priv.allowed);
      if v_has <> v_should then
        raise exception
          'D2: D1 posture drifted — % on public.% for % is %, expected %',
          v_priv, v_expected_priv.tbl, v_expected_priv.role_name, v_has, v_should;
      end if;
    end loop;
  end loop;
end $$;
