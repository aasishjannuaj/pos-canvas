-- Feature 16.3, schema baseline -- capture the live operational tables into
-- version control.
--
-- PURPOSE: bring public.projects, public.orders, public.order_items and
-- public.inventory_transactions under source control with ZERO behavioral
-- change. This is a reproducibility migration, not a redesign.
--
-- ORDERING: this file is timestamped to sort BEFORE
-- 20260803201210_capture_checkout_inventory_functions.sql, so that applying
-- the chain to an empty database creates these tables before the
-- checkout/inventory functions that reference them.
--
-- PROVENANCE: transcribed from a read-only inspection of the live database
-- on 2026-08-03 (information_schema.columns, pg_constraint, pg_indexes,
-- pg_policies, pg_class.relrowsecurity/relforcerowsecurity and
-- information_schema.role_table_grants).
--
-- DELIBERATELY PRESERVED AS-IS -- every one of these is a known observation,
-- not an oversight. Hardening belongs exclusively to Migration D:
--   * orders.project_id is NULLABLE with ON DELETE SET NULL, while
--     inventory_transactions.project_id is NOT NULL with ON DELETE CASCADE.
--     Deleting a project therefore orphans orders but destroys inventory
--     history. Inconsistent, and reproduced faithfully.
--   * NO unique constraint on (project_id, order_number). Duplicate order
--     numbers are currently possible. Not added here.
--   * inventory_transactions keeps its UPDATE and DELETE policies, so the
--     audit log remains mutable by the audited user. Not changed here.
--   * inventory_transactions_project_id_idx is redundant with
--     inventory_transactions_project_created_at_idx. Not dropped here.
--   * anon holds ALL privileges on inventory_transactions (and only that
--     table), and authenticated holds ALL -- including TRUNCATE, which RLS
--     does not restrict -- on all four tables. Reproduced exactly.
--
-- IDEMPOTENCY vs FIDELITY: IF NOT EXISTS / guarded DO blocks are used so this
-- is a no-op against the live database. Because IF NOT EXISTS would otherwise
-- silently accept a materially different existing object, the final section
-- re-verifies the critical shape (columns, nullability, constraints, RLS,
-- policies) and RAISES if production does not match what is declared here.
--
-- TRIGGERS: the trigger inspection query returned no rows, so no triggers are
-- declared. The verification block asserts that no user triggers exist on
-- these four tables, which will fail loudly if that reading was wrong.
--
-- This migration is NOT applied automatically -- review, then apply manually.

-- gen_random_uuid() comes from pgcrypto; declared idempotently so an empty
-- database can apply this chain standalone.
create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- projects  (created first: orders and inventory_transactions reference it)
-- ----------------------------------------------------------------------------
create table if not exists public.projects (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  template_id text not null,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_pkey primary key (id)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'projects_user_id_fkey') then
    alter table public.projects
      add constraint projects_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete cascade;
  end if;
end $$;

create index if not exists projects_user_id_idx on public.projects using btree (user_id);

alter table public.projects enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='projects'
                 and policyname='Users can view their own projects') then
    create policy "Users can view their own projects" on public.projects
      for select to authenticated using ((select auth.uid()) = user_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='projects'
                 and policyname='Users can create their own projects') then
    create policy "Users can create their own projects" on public.projects
      for insert to authenticated with check ((select auth.uid()) = user_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='projects'
                 and policyname='Users can update their own projects') then
    create policy "Users can update their own projects" on public.projects
      for update to authenticated
      using ((select auth.uid()) = user_id)
      with check ((select auth.uid()) = user_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='projects'
                 and policyname='Users can delete their own projects') then
    create policy "Users can delete their own projects" on public.projects
      for delete to authenticated using ((select auth.uid()) = user_id);
  end if;
end $$;

grant all on table public.projects to authenticated;
grant all on table public.projects to service_role;

-- ----------------------------------------------------------------------------
-- orders
-- ----------------------------------------------------------------------------
create table if not exists public.orders (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  -- Nullable + ON DELETE SET NULL: deleting a project keeps its orders.
  project_id uuid,
  order_number text not null,
  payment_method text not null,
  subtotal numeric(12,2) not null,
  tax_amount numeric(12,2) not null default 0,
  tip_amount numeric(12,2) not null default 0,
  total numeric(12,2) not null,
  created_at timestamptz not null default now(),
  constraint orders_pkey primary key (id),
  constraint orders_payment_method_check check ((payment_method = any (array['cash'::text, 'card'::text]))),
  constraint orders_subtotal_check check ((subtotal >= (0)::numeric)),
  constraint orders_tax_amount_check check ((tax_amount >= (0)::numeric)),
  constraint orders_tip_amount_check check ((tip_amount >= (0)::numeric)),
  constraint orders_total_check check ((total >= (0)::numeric))
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_user_id_fkey') then
    alter table public.orders
      add constraint orders_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'orders_project_id_fkey') then
    alter table public.orders
      add constraint orders_project_id_fkey
      foreign key (project_id) references public.projects(id) on delete set null;
  end if;
end $$;

create index if not exists orders_created_at_idx on public.orders using btree (created_at desc);
create index if not exists orders_project_id_idx on public.orders using btree (project_id);
create index if not exists orders_user_id_idx on public.orders using btree (user_id);

alter table public.orders enable row level security;

-- Only SELECT and INSERT policies exist. UPDATE and DELETE are therefore
-- denied by default for authenticated users, making orders append-only at the
-- row level. Reproduced exactly -- no UPDATE/DELETE policy is added.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='orders'
                 and policyname='Users can view their own orders') then
    create policy "Users can view their own orders" on public.orders
      for select to authenticated using ((select auth.uid()) = user_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='orders'
                 and policyname='Users can create their own orders') then
    create policy "Users can create their own orders" on public.orders
      for insert to authenticated with check ((select auth.uid()) = user_id);
  end if;
end $$;

grant all on table public.orders to authenticated;
grant all on table public.orders to service_role;

-- ----------------------------------------------------------------------------
-- order_items
-- ----------------------------------------------------------------------------
create table if not exists public.order_items (
  id uuid not null default gen_random_uuid(),
  order_id uuid not null,
  item_id text not null,
  item_name text not null,
  unit_price numeric(12,2) not null,
  quantity integer not null,
  line_total numeric(12,2) not null,
  created_at timestamptz not null default now(),
  constraint order_items_pkey primary key (id),
  constraint order_items_line_total_check check ((line_total >= (0)::numeric)),
  constraint order_items_quantity_check check ((quantity > 0)),
  constraint order_items_unit_price_check check ((unit_price >= (0)::numeric))
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'order_items_order_id_fkey') then
    alter table public.order_items
      add constraint order_items_order_id_fkey
      foreign key (order_id) references public.orders(id) on delete cascade;
  end if;
end $$;

create index if not exists order_items_order_id_idx on public.order_items using btree (order_id);

alter table public.order_items enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='order_items'
                 and policyname='Users can view their own order items') then
    create policy "Users can view their own order items" on public.order_items
      for select to authenticated
      using (exists (
        select 1 from public.orders
        where orders.id = order_items.order_id
          and orders.user_id = (select auth.uid())
      ));
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='order_items'
                 and policyname='Users can create items for their own orders') then
    create policy "Users can create items for their own orders" on public.order_items
      for insert to authenticated
      with check (exists (
        select 1 from public.orders
        where orders.id = order_items.order_id
          and orders.user_id = (select auth.uid())
      ));
  end if;
end $$;

grant all on table public.order_items to authenticated;
grant all on table public.order_items to service_role;

-- ----------------------------------------------------------------------------
-- inventory_transactions
-- ----------------------------------------------------------------------------
create table if not exists public.inventory_transactions (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  project_id uuid not null,
  order_id uuid,
  item_id text not null,
  item_name text not null,
  transaction_type text not null,
  quantity_change integer not null,
  quantity_before integer not null,
  quantity_after integer not null,
  created_at timestamptz not null default now(),
  constraint inventory_transactions_pkey primary key (id),
  constraint inventory_transactions_after_check check ((quantity_after >= 0)),
  constraint inventory_transactions_before_check check ((quantity_before >= 0)),
  constraint inventory_transactions_change_check check ((quantity_change <> 0)),
  constraint inventory_transactions_quantity_math_check check ((quantity_after = (quantity_before + quantity_change))),
  constraint inventory_transactions_type_check check ((transaction_type = any (array['sale'::text, 'restock'::text, 'adjustment'::text])))
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'inventory_transactions_user_id_fkey') then
    alter table public.inventory_transactions
      add constraint inventory_transactions_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'inventory_transactions_project_id_fkey') then
    alter table public.inventory_transactions
      add constraint inventory_transactions_project_id_fkey
      foreign key (project_id) references public.projects(id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'inventory_transactions_order_id_fkey') then
    alter table public.inventory_transactions
      add constraint inventory_transactions_order_id_fkey
      foreign key (order_id) references public.orders(id) on delete set null;
  end if;
end $$;

create index if not exists inventory_transactions_order_id_idx
  on public.inventory_transactions using btree (order_id);
-- Redundant with inventory_transactions_project_created_at_idx below.
-- Preserved deliberately; removal belongs to Migration D.
create index if not exists inventory_transactions_project_id_idx
  on public.inventory_transactions using btree (project_id);
create index if not exists inventory_transactions_project_created_at_idx
  on public.inventory_transactions using btree (project_id, created_at desc);
create index if not exists inventory_transactions_user_id_idx
  on public.inventory_transactions using btree (user_id);

alter table public.inventory_transactions enable row level security;

-- Unlike orders, this table DOES expose UPDATE and DELETE policies, so the
-- audit log is mutable by the user it audits. Preserved exactly; making it
-- append-only belongs to Migration D. Note these four policies use plain
-- auth.uid() rather than (select auth.uid()) -- matching production.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='inventory_transactions'
                 and policyname='Users can view their inventory transactions') then
    create policy "Users can view their inventory transactions" on public.inventory_transactions
      for select to authenticated using (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='inventory_transactions'
                 and policyname='Users can create their inventory transactions') then
    create policy "Users can create their inventory transactions" on public.inventory_transactions
      for insert to authenticated
      with check (
        (auth.uid() = user_id)
        and exists (
          select 1 from public.projects
          where projects.id = inventory_transactions.project_id
            and projects.user_id = auth.uid()
        )
      );
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='inventory_transactions'
                 and policyname='Users can update their inventory transactions') then
    create policy "Users can update their inventory transactions" on public.inventory_transactions
      for update to authenticated
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='inventory_transactions'
                 and policyname='Users can delete their inventory transactions') then
    create policy "Users can delete their inventory transactions" on public.inventory_transactions
      for delete to authenticated using (auth.uid() = user_id);
  end if;
end $$;

-- anon holds ALL privileges here and ONLY here. RLS still denies anon every
-- row (all four policies target `authenticated`), but the grant itself is an
-- anomaly relative to the other three tables. Reproduced faithfully; revoking
-- it belongs to Migration D.
grant all on table public.inventory_transactions to anon;
grant all on table public.inventory_transactions to authenticated;
grant all on table public.inventory_transactions to service_role;

-- ----------------------------------------------------------------------------
-- Verification -- this is what stops IF NOT EXISTS from silently accepting a
-- materially different production schema. Every check RAISES rather than
-- warning, so a mismatch aborts the migration instead of leaving source
-- control disagreeing with production.
-- ----------------------------------------------------------------------------
do $$
declare
  v_missing text;
  v_count int;
begin
  -- 1. All four tables exist.
  select string_agg(t, ', ') into v_missing
  from unnest(array['projects','orders','order_items','inventory_transactions']) t
  where not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = t and c.relkind = 'r'
  );
  if v_missing is not null then
    raise exception 'Schema baseline: missing table(s): %', v_missing;
  end if;

  -- 2. RLS enabled on all four.
  select string_agg(c.relname, ', ') into v_missing
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('projects','orders','order_items','inventory_transactions')
    and c.relrowsecurity is false;
  if v_missing is not null then
    raise exception 'Schema baseline: RLS not enabled on: %', v_missing;
  end if;

  -- 3. Nullability that the checkout functions depend on.
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='orders'
               and column_name='project_id' and is_nullable <> 'YES') then
    raise exception 'Schema baseline: orders.project_id expected NULLABLE';
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='inventory_transactions'
               and column_name='project_id' and is_nullable <> 'NO') then
    raise exception 'Schema baseline: inventory_transactions.project_id expected NOT NULL';
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='projects'
               and column_name='config' and is_nullable <> 'NO') then
    raise exception 'Schema baseline: projects.config expected NOT NULL';
  end if;

  -- 4. Every inspected constraint is present.
  select string_agg(c, ', ') into v_missing
  from unnest(array[
    'projects_pkey','projects_user_id_fkey',
    'orders_pkey','orders_user_id_fkey','orders_project_id_fkey',
    'orders_payment_method_check','orders_subtotal_check','orders_tax_amount_check',
    'orders_tip_amount_check','orders_total_check',
    'order_items_pkey','order_items_order_id_fkey','order_items_line_total_check',
    'order_items_quantity_check','order_items_unit_price_check',
    'inventory_transactions_pkey','inventory_transactions_user_id_fkey',
    'inventory_transactions_project_id_fkey','inventory_transactions_order_id_fkey',
    'inventory_transactions_after_check','inventory_transactions_before_check',
    'inventory_transactions_change_check','inventory_transactions_quantity_math_check',
    'inventory_transactions_type_check'
  ]) c
  where not exists (select 1 from pg_constraint where conname = c);
  if v_missing is not null then
    raise exception 'Schema baseline: missing constraint(s): %', v_missing;
  end if;

  -- 5. Every inspected index is present.
  select string_agg(i, ', ') into v_missing
  from unnest(array[
    'projects_pkey','projects_user_id_idx',
    'orders_pkey','orders_created_at_idx','orders_project_id_idx','orders_user_id_idx',
    'order_items_pkey','order_items_order_id_idx',
    'inventory_transactions_pkey','inventory_transactions_order_id_idx',
    'inventory_transactions_project_id_idx','inventory_transactions_project_created_at_idx',
    'inventory_transactions_user_id_idx'
  ]) i
  where not exists (
    select 1 from pg_indexes where schemaname='public' and indexname = i
  );
  if v_missing is not null then
    raise exception 'Schema baseline: missing index(es): %', v_missing;
  end if;

  -- 6. Policy counts match the inspection exactly (4/2/2/4).
  select count(*) into v_count from pg_policies where schemaname='public' and tablename='projects';
  if v_count <> 4 then raise exception 'Schema baseline: projects expected 4 policies, found %', v_count; end if;

  select count(*) into v_count from pg_policies where schemaname='public' and tablename='orders';
  if v_count <> 2 then raise exception 'Schema baseline: orders expected 2 policies, found %', v_count; end if;

  select count(*) into v_count from pg_policies where schemaname='public' and tablename='order_items';
  if v_count <> 2 then raise exception 'Schema baseline: order_items expected 2 policies, found %', v_count; end if;

  select count(*) into v_count from pg_policies where schemaname='public' and tablename='inventory_transactions';
  if v_count <> 4 then raise exception 'Schema baseline: inventory_transactions expected 4 policies, found %', v_count; end if;

  -- 7. No user triggers on these tables -- the trigger inspection returned no
  -- rows, and this asserts that reading rather than assuming it.
  select string_agg(c.relname || '.' || t.tgname, ', ') into v_missing
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where not t.tgisinternal and n.nspname = 'public'
    and c.relname in ('projects','orders','order_items','inventory_transactions');
  if v_missing is not null then
    raise exception 'Schema baseline: unexpected trigger(s) present: %', v_missing;
  end if;
end $$;
