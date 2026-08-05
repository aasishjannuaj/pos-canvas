-- Milestone 16, Feature 16.3 — Migration D1
-- Privilege and audit-log hardening.
--
-- SCOPE: privileges and two RLS policies. No schema change, no data write, no
-- function body replaced, no function EXECUTE grant altered.
--
-- ----------------------------------------------------------------------------
-- WHY THIS IS NEEDED — three holes confirmed against the live database
-- ----------------------------------------------------------------------------
--
-- 1. anon holds ALL on inventory_transactions. Granted explicitly in
--    20260803201200 ("grant all on table public.inventory_transactions to
--    anon") and confirmed live: an unauthenticated anon-key client can SELECT
--    the table. TRUNCATE is NOT subject to RLS, so this is a real privilege on
--    an operational table, not a theoretical one.
--
-- 2. anon can SELECT build_jobs and build_artifacts. Neither table was ever
--    granted explicitly, so Supabase's ALTER DEFAULT PRIVILEGES on the public
--    schema applied and both were born with ALL granted to anon, authenticated
--    and service_role. Confirmed live.
--
-- 3. inventory_transactions is owner-mutable. It carries UPDATE and DELETE
--    policies for authenticated (auth.uid() = user_id), so an owner can rewrite
--    or erase their own inventory history. An audit log that its subject can
--    edit is not an audit log. complete_sale, restock_inventory and
--    adjust_inventory only ever INSERT here — nothing legitimate updates or
--    deletes a row.
--
-- projects, orders, order_items, device_pairing_tokens and paired_devices
-- already deny anon (verified live: 42501), but all four operational tables
-- carry "grant all to authenticated", which includes TRUNCATE — again not
-- restricted by RLS.
--
-- ----------------------------------------------------------------------------
-- THE MINIMUM MATRIX, TRACED TO SOURCE
--
-- Nothing below is granted for a hypothetical future caller. Every privilege
-- corresponds to a statement that exists in the repository today; anything a
-- future task needs must be introduced by that task, preferably as a narrowly
-- scoped RPC rather than a table grant.
-- ----------------------------------------------------------------------------
--
-- Only THREE direct write statements exist in the entire application. Every
-- other mutation goes through an RPC:
--   projects   INSERT  lib/projects.ts:31          (browser, authenticated)
--   projects   UPDATE  lib/projects.ts:74          (browser, authenticated)
--   build_jobs INSERT  lib/buildJobs.server.ts:351 (admin client, service_role)
--
-- authenticated:
--   projects               SELECT, INSERT, UPDATE   -- NO DELETE
--     SELECT  lib/projects.server.ts:24,52; lib/projects.ts:114;
--             lib/devicePairing.server.ts:79
--     INSERT  lib/projects.ts:31
--     UPDATE  lib/projects.ts:74, and both SECURITY INVOKER inventory
--             functions (restock_inventory line 140, adjust_inventory line 169
--             in 20260803201210) which UPDATE public.projects as the CALLER.
--     DELETE  DELIBERATELY NOT GRANTED. No call site exists anywhere in the
--             application. The "Users can delete their own projects" RLS
--             policy is left in place untouched, but it is now unreachable:
--             RLS narrows a privilege, it never confers one. If a delete-project
--             feature is ever built, it must grant this explicitly.
--   orders                 SELECT only
--     lib/orders.server.ts:65,129; lib/dashboard.server.ts:81. Sales no longer
--     insert here from the browser — complete_sale is SECURITY DEFINER and
--     writes as postgres. The orders INSERT policy is left in place but is now
--     unreachable without the privilege.
--   order_items            SELECT only
--     Never accessed directly; read as a PostgREST embedded resource inside
--     the orders select (lib/orders.server.ts:65), which still requires SELECT.
--   inventory_transactions SELECT, INSERT
--     SELECT  lib/inventory.server.ts:64
--     INSERT  REQUIRED — restock_inventory (line 114) and adjust_inventory
--             (line 143) are SECURITY INVOKER and INSERT INTO
--             public.inventory_transactions as the calling role. Revoking
--             INSERT here would break both owner RPCs. complete_sale does not
--             need it (DEFINER, writes as postgres).
--   build_jobs             SELECT only   lib/buildJobs.server.ts:300,342;
--                                        lib/devicePairing.server.ts:96
--   build_artifacts        SELECT only   lib/buildJobs.server.ts:600, which
--                                        runs on the RLS cookie client; the
--                                        admin client appears later in that
--                                        function only for storage
--                                        createSignedUrl, never for this table.
--   device_pairing_tokens  SELECT only   (owner reads their own tokens)
--   paired_devices         SELECT only   lib/devicePairing.server.ts:200
--
-- service_role: build_jobs ONLY.
--   build_jobs             SELECT, INSERT
--     INSERT  lib/buildJobs.server.ts:351 (createBuildJob, admin client)
--     SELECT  worker/once.ts:261 and :471 — the worker reads build_jobs
--             DIRECTLY, not through an RPC. Every worker WRITE goes through a
--             SECURITY DEFINER RPC (claim_next_build_job, heartbeat_build_job,
--             fail_build_job, finalize_build_job_with_artifact), which runs as
--             postgres and therefore needs no service_role table privilege.
--   Every other table: NONE. Verified by source inspection:
--     projects        createBuildJob reads it through getProjectById
--                     (lib/buildJobs.server.ts:206), which uses the cookie
--                     client — createAdminClient() is not called until line 219.
--     build_artifacts read on the cookie client (see above); the worker never
--                     touches the table, using finalize_build_job_with_artifact
--                     and the storage API instead.
--     device_pairing_tokens / paired_devices
--                     the Migration B grants anticipated an expired-token
--                     cleanup job. No such job exists in the repository, so the
--                     grants are withdrawn here. A future cleanup task must
--                     introduce its own narrowly scoped capability.
--     orders / order_items / inventory_transactions
--                     no service-role code reads or writes them.
--
-- anon and PUBLIC: nothing, on all eight tables.
-- postgres: table owner; its implicit rights are not altered here.

-- ----------------------------------------------------------------------------
-- Deterministic privilege reset.
--
-- Revoke from PUBLIC first (a PUBLIC grant applies to every current and future
-- role, so revoking it from a named role alone would leave the privilege
-- reachable), then from each named role, then grant back exactly the approved
-- set. This ordering also makes a clean rebuild deterministic and is the same
-- pattern proven in Migration B.
-- ----------------------------------------------------------------------------

-- projects --------------------------------------------------------------------
revoke all privileges on table public.projects from public;
revoke all privileges on table public.projects from anon;
revoke all privileges on table public.projects from authenticated;
revoke all privileges on table public.projects from service_role;

grant select, insert, update on table public.projects to authenticated;

-- orders ----------------------------------------------------------------------
revoke all privileges on table public.orders from public;
revoke all privileges on table public.orders from anon;
revoke all privileges on table public.orders from authenticated;
revoke all privileges on table public.orders from service_role;

grant select on table public.orders to authenticated;

-- order_items -----------------------------------------------------------------
revoke all privileges on table public.order_items from public;
revoke all privileges on table public.order_items from anon;
revoke all privileges on table public.order_items from authenticated;
revoke all privileges on table public.order_items from service_role;

grant select on table public.order_items to authenticated;

-- inventory_transactions ------------------------------------------------------
revoke all privileges on table public.inventory_transactions from public;
revoke all privileges on table public.inventory_transactions from anon;
revoke all privileges on table public.inventory_transactions from authenticated;
revoke all privileges on table public.inventory_transactions from service_role;

-- INSERT is load-bearing: restock_inventory and adjust_inventory are SECURITY
-- INVOKER and write this table as the calling user.
grant select, insert on table public.inventory_transactions to authenticated;

-- build_jobs ------------------------------------------------------------------
revoke all privileges on table public.build_jobs from public;
revoke all privileges on table public.build_jobs from anon;
revoke all privileges on table public.build_jobs from authenticated;
revoke all privileges on table public.build_jobs from service_role;

grant select on table public.build_jobs to authenticated;

-- The ONLY service_role table grant in this migration.
grant select, insert on table public.build_jobs to service_role;

-- build_artifacts -------------------------------------------------------------
revoke all privileges on table public.build_artifacts from public;
revoke all privileges on table public.build_artifacts from anon;
revoke all privileges on table public.build_artifacts from authenticated;
revoke all privileges on table public.build_artifacts from service_role;

grant select on table public.build_artifacts to authenticated;

-- device_pairing_tokens -------------------------------------------------------
revoke all privileges on table public.device_pairing_tokens from public;
revoke all privileges on table public.device_pairing_tokens from anon;
revoke all privileges on table public.device_pairing_tokens from authenticated;
revoke all privileges on table public.device_pairing_tokens from service_role;

grant select on table public.device_pairing_tokens to authenticated;

-- paired_devices --------------------------------------------------------------
revoke all privileges on table public.paired_devices from public;
revoke all privileges on table public.paired_devices from anon;
revoke all privileges on table public.paired_devices from authenticated;
revoke all privileges on table public.paired_devices from service_role;

grant select on table public.paired_devices to authenticated;

-- ----------------------------------------------------------------------------
-- Make inventory_transactions append-only for ordinary users.
--
-- The SELECT policy ("Users can view their inventory transactions") and the
-- INSERT policy ("Users can create their inventory transactions") are both
-- retained: the INSERT policy is what lets restock_inventory and
-- adjust_inventory write as the calling user, and it already verifies both
-- auth.uid() = user_id AND that the project belongs to the caller.
--
-- Rows written by complete_sale are unaffected either way — it is SECURITY
-- DEFINER and runs as postgres, which bypasses RLS entirely.
-- ----------------------------------------------------------------------------
drop policy if exists "Users can update their inventory transactions"
  on public.inventory_transactions;

drop policy if exists "Users can delete their inventory transactions"
  on public.inventory_transactions;

-- ----------------------------------------------------------------------------
-- Verification.
--
-- Uses has_table_privilege, which resolves EFFECTIVE privilege — it accounts
-- for grants inherited through PUBLIC and through role membership, which a scan
-- of explicit ACL rows in information_schema would miss. PUBLIC has no role oid
-- and cannot be passed to has_table_privilege, so it is checked separately
-- against information_schema.table_privileges.
--
-- The expected sets below are EXACT: a privilege that is present but not listed
-- fails just as loudly as one that is missing.
-- ----------------------------------------------------------------------------
do $$
declare
  c_tables constant text[] := array[
    'projects', 'orders', 'order_items', 'inventory_transactions',
    'build_jobs', 'build_artifacts', 'device_pairing_tokens', 'paired_devices'
  ];
  c_privs constant text[] := array[
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
  ];
  v_table text;
  v_priv text;
  v_expected record;
  v_has boolean;
  v_should boolean;
  v_count integer;
begin
  -- 1. anon holds nothing, anywhere.
  foreach v_table in array c_tables
  loop
    foreach v_priv in array c_privs
    loop
      if has_table_privilege('anon', format('public.%I', v_table), v_priv) then
        raise exception 'D1: anon still holds % on public.%', v_priv, v_table;
      end if;
    end loop;
  end loop;

  -- 2. PUBLIC holds nothing, anywhere. A PUBLIC grant would reach every role,
  --    including anon, so this must be checked independently of step 1.
  select count(*) into v_count
  from information_schema.table_privileges
  where table_schema = 'public'
    and table_name = any(c_tables)
    and grantee = 'PUBLIC';

  if v_count > 0 then
    raise exception 'D1: PUBLIC still holds % table privilege(s)', v_count;
  end if;

  -- 3. authenticated and service_role hold EXACTLY the approved set.
  for v_expected in
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
        v_expected.role_name, format('public.%I', v_expected.tbl), v_priv
      );
      v_should := v_priv = any(v_expected.allowed);

      if v_has <> v_should then
        raise exception
          'D1: % on public.% for % is %, expected %',
          v_priv, v_expected.tbl, v_expected.role_name, v_has, v_should;
      end if;
    end loop;
  end loop;

  -- 4. projects specifically: authenticated must NOT be able to delete a
  --    project, truncate the table, create a foreign key against it, or attach
  --    a trigger. Stated explicitly rather than relying on the loop above,
  --    because "no DELETE on projects" is a deliberate product decision that a
  --    future edit must not quietly reverse.
  foreach v_priv in array array['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
  loop
    if has_table_privilege('authenticated', 'public.projects', v_priv) then
      raise exception 'D1: authenticated must not hold % on public.projects', v_priv;
    end if;
  end loop;

  -- 5. service_role holds privileges on build_jobs and NOWHERE ELSE.
  foreach v_table in array c_tables
  loop
    if v_table <> 'build_jobs' then
      foreach v_priv in array c_privs
      loop
        if has_table_privilege('service_role', format('public.%I', v_table), v_priv) then
          raise exception 'D1: service_role must hold nothing on public.%, found %',
            v_table, v_priv;
        end if;
      end loop;
    end if;
  end loop;

  -- 6. No role a browser or server key can reach holds TRUNCATE anywhere.
  --    Stated separately because TRUNCATE is the one privilege RLS does not
  --    restrict, which is what made the pre-D1 "grant all" genuinely dangerous.
  foreach v_table in array c_tables
  loop
    if has_table_privilege('authenticated', format('public.%I', v_table), 'TRUNCATE') then
      raise exception 'D1: authenticated still holds TRUNCATE on public.%', v_table;
    end if;
    if has_table_privilege('service_role', format('public.%I', v_table), 'TRUNCATE') then
      raise exception 'D1: service_role still holds TRUNCATE on public.%', v_table;
    end if;
  end loop;

  -- 7. inventory_transactions is append-only for ordinary users.
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'inventory_transactions'
      and cmd in ('UPDATE', 'DELETE')
  ) then
    raise exception 'D1: inventory_transactions still has an UPDATE or DELETE policy';
  end if;

  -- ... but still readable and still writable by the two INVOKER RPCs.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'inventory_transactions'
      and cmd = 'SELECT'
  ) then
    raise exception 'D1: inventory_transactions lost its SELECT policy';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'inventory_transactions'
      and cmd = 'INSERT'
  ) then
    raise exception 'D1: inventory_transactions lost the INSERT policy restock/adjust need';
  end if;

  -- 8. RLS is still enabled on every table this migration touched.
  foreach v_table in array c_tables
  loop
    if not exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_table and c.relrowsecurity
    ) then
      raise exception 'D1: row level security is not enabled on public.%', v_table;
    end if;
  end loop;

  -- 9. The checkout and inventory functions were not touched by this migration
  --    and must still hold their Migration C posture.
  if not (
    select p.prosecdef from pg_proc p
    where p.oid = to_regprocedure(
      'public.complete_sale(uuid,text,text,numeric,numeric,numeric,numeric,jsonb)'
    )
  ) then
    raise exception 'D1: complete_sale must remain SECURITY DEFINER';
  end if;

  if (
    select p.prosecdef from pg_proc p
    where p.oid = to_regprocedure('public.restock_inventory(uuid,text,integer)')
  ) then
    raise exception 'D1: restock_inventory must remain SECURITY INVOKER';
  end if;

  if (
    select p.prosecdef from pg_proc p
    where p.oid = to_regprocedure('public.adjust_inventory(uuid,text,integer)')
  ) then
    raise exception 'D1: adjust_inventory must remain SECURITY INVOKER';
  end if;
end $$;
