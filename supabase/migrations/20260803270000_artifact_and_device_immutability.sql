-- Milestone 16, Feature 16.3 — Migration D4c
-- build_artifact immutability and paired-device identity hardening.
--
-- SCOPE: two trigger functions and two triggers. No grant, no policy, no
-- ALTER FUNCTION, no composite key, no DELETE trigger, no build_jobs change,
-- no checkout / pairing / worker RPC change, no data write.
--
-- ----------------------------------------------------------------------------
-- WHY
-- ----------------------------------------------------------------------------
-- A paired device derives its authorization from owner_id, project_id and
-- build_job_id on its own row, and prices every sale from the config_snapshot
-- of that pinned build. D4b froze the build's identity and config. This closes
-- the remaining half: the row that POINTS at the build.
--
-- Reassigning a live device's owner_id or project_id would make it transact on
-- another tenant's behalf; reassigning build_job_id would silently change the
-- prices it charges. Nothing in the code does any of that today — the only
-- UPDATE in the pairing layer is revoke_paired_device setting revoked_at and
-- revoked_by — but nothing prevents it either.
--
-- build_artifacts is stricter still: it has exactly ONE writer in the entire
-- system (the INSERT inside finalize_build_job_with_artifact) and ZERO update
-- paths. Rejecting every UPDATE is therefore the SMALLEST rule compatible with
-- real code, not the broadest — a per-column list would enumerate ten columns
-- to say the same thing while implying some were writable. expires_at is
-- included: the partial index on it anticipates a retention job that does not
-- exist, and no writer for it exists anywhere.
--
-- ----------------------------------------------------------------------------
-- WHY NO DELETE TRIGGER
-- ----------------------------------------------------------------------------
-- After D1 no role can delete from either table: authenticated holds SELECT
-- only, anon and service_role hold nothing, and neither table has a DELETE
-- policy. A BEFORE DELETE trigger would add nothing and would actively BREAK
-- legitimate cascades — build_artifacts cascades from build_jobs, and
-- paired_devices cascades from auth.users, projects and build_jobs. Blocking
-- those would break project deletion, user deletion and every cascade-based
-- cleanup path this milestone relies on.

-- ----------------------------------------------------------------------------
-- Self-capturing baseline, recorded BEFORE any DDL so the verification block
-- compares real values rather than hardcoded ones. Requires the whole file to
-- run as ONE SQL Editor submission (one session), as every migration here has.
--
-- Fingerprints coalesce to 'empty' so a table with zero rows compares equal to
-- itself rather than yielding NULL.
-- ----------------------------------------------------------------------------
create temporary table d4c_tbl_baseline as
select 'build_artifacts' as tbl,
       (select count(*) from public.build_artifacts) as n,
       (select coalesce(md5(string_agg(md5(a::text), '|' order by a.id::text)), 'empty')
        from public.build_artifacts a) as fp
union all
select 'paired_devices',
       (select count(*) from public.paired_devices),
       (select coalesce(md5(string_agg(md5(d::text), '|' order by d.id::text)), 'empty')
        from public.paired_devices d)
union all
select 'build_jobs',
       (select count(*) from public.build_jobs),
       (select coalesce(md5(string_agg(md5(b::text), '|' order by b.id::text)), 'empty')
        from public.build_jobs b);

create temporary table d4c_trg_baseline as
select c.relname, t.tgname, t.tgtype, t.tgenabled, p.proname
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_proc p on p.oid = t.tgfoid
where n.nspname = 'public' and not t.tgisinternal;

create temporary table d4c_pol_baseline as
select tablename, policyname, cmd, qual, with_check, roles::text as roles
from pg_policies
where schemaname = 'public'
  and tablename in ('build_artifacts', 'paired_devices', 'build_jobs');

create temporary table d4c_priv_baseline as
select r.rolname, t.tablename, p.priv,
       has_table_privilege(r.rolname, format('public.%I', t.tablename), p.priv) as granted
from (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
cross join (values
  ('projects'), ('orders'), ('order_items'), ('inventory_transactions'),
  ('build_jobs'), ('build_artifacts'), ('device_pairing_tokens'),
  ('paired_devices'), ('project_order_counters')
) t(tablename)
cross join (values
  ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
  ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
) p(priv);

create temporary table d4c_fn_baseline as
select p.proname,
       md5(p.prosrc)                          as body_md5,
       p.prosecdef                            as security_definer,
       coalesce(p.proconfig, array[]::text[]) as config,
       pg_get_userbyid(p.proowner)            as owner,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  as svc,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
       has_function_privilege('anon', p.oid, 'EXECUTE')          as anon
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'create_device_pairing_token', 'cancel_device_pairing_token',
    'redeem_device_pairing_token', 'revoke_paired_device',
    'complete_sale', 'complete_sale_v2',
    'claim_next_build_job', 'heartbeat_build_job', 'complete_build_job',
    'fail_build_job', 'finalize_build_job_with_artifact',
    'set_build_jobs_updated_at', 'build_jobs_guard_immutable_columns'
  );

-- Every public function name, so the block can prove EXACTLY two are new.
create temporary table d4c_allfn_baseline as
select p.proname
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public';

-- ----------------------------------------------------------------------------
-- 1. build_artifacts — reject every UPDATE.
--
-- Reads and writes nothing, so it cannot recurse and adds no I/O. The message
-- is a fixed literal: no path, checksum, filename, build id or row id is ever
-- interpolated, because an artifact's storage_path is the one field that could
-- help someone locate a private object.
-- ----------------------------------------------------------------------------
create or replace function public.build_artifacts_guard_immutable_updates()
returns trigger
language plpgsql
security definer
set search_path to public, pg_temp
as $function$
begin
  raise exception 'build_artifacts rows cannot be updated after creation';
end;
$function$;

create or replace trigger build_artifacts_guard_immutable
  before update on public.build_artifacts
  for each row
  execute function public.build_artifacts_guard_immutable_updates();

-- ----------------------------------------------------------------------------
-- 2. paired_devices — freeze identity and operational fields; allow revocation.
--
-- revoked_at and revoked_by are deliberately absent from the checks below:
-- revoke_paired_device (20260803210000:819) sets exactly those two columns and
-- is the only legitimate UPDATE in the pairing layer.
--
-- device_name, platform and last_seen_at are frozen because no writer exists
-- for any of them. A future rename or heartbeat feature needs a new RPC and
-- therefore a migration regardless; relaxing this guard at that point is one
-- line, whereas leaving them mutable now would be protection given up on
-- speculation.
-- ----------------------------------------------------------------------------
create or replace function public.paired_devices_guard_immutable_columns()
returns trigger
language plpgsql
security definer
set search_path to public, pg_temp
as $function$
begin
  if new.auth_user_id is distinct from old.auth_user_id then
    raise exception 'paired_devices.auth_user_id cannot be changed after creation';
  end if;

  if new.owner_id is distinct from old.owner_id then
    raise exception 'paired_devices.owner_id cannot be changed after creation';
  end if;

  if new.project_id is distinct from old.project_id then
    raise exception 'paired_devices.project_id cannot be changed after creation';
  end if;

  if new.build_job_id is distinct from old.build_job_id then
    raise exception 'paired_devices.build_job_id cannot be changed after creation';
  end if;

  if new.device_name is distinct from old.device_name then
    raise exception 'paired_devices.device_name cannot be changed after creation';
  end if;

  if new.platform is distinct from old.platform then
    raise exception 'paired_devices.platform cannot be changed after creation';
  end if;

  if new.created_at is distinct from old.created_at then
    raise exception 'paired_devices.created_at cannot be changed after creation';
  end if;

  if new.last_seen_at is distinct from old.last_seen_at then
    raise exception 'paired_devices.last_seen_at cannot be changed after creation';
  end if;

  return new;
end;
$function$;

create or replace trigger paired_devices_guard_immutable
  before update on public.paired_devices
  for each row
  execute function public.paired_devices_guard_immutable_columns();

-- ----------------------------------------------------------------------------
-- Verification.
-- ----------------------------------------------------------------------------
do $$
declare
  v_row record;
  v_name text;
  v_count integer;
  v_new text[];
begin
  -- ---- table counts and fingerprints unchanged ------------------------------
  for v_row in select * from d4c_tbl_baseline loop
    if v_row.tbl = 'build_artifacts' then
      select count(*) into v_count from public.build_artifacts;
    elsif v_row.tbl = 'paired_devices' then
      select count(*) into v_count from public.paired_devices;
    else
      select count(*) into v_count from public.build_jobs;
    end if;

    if v_count <> v_row.n then
      raise exception 'D4c: % row count changed from % to %', v_row.tbl, v_row.n, v_count;
    end if;
  end loop;

  if (select coalesce(md5(string_agg(md5(a::text), '|' order by a.id::text)), 'empty')
      from public.build_artifacts a)
     is distinct from (select fp from d4c_tbl_baseline where tbl = 'build_artifacts') then
    raise exception 'D4c: build_artifacts rows changed';
  end if;

  if (select coalesce(md5(string_agg(md5(d::text), '|' order by d.id::text)), 'empty')
      from public.paired_devices d)
     is distinct from (select fp from d4c_tbl_baseline where tbl = 'paired_devices') then
    raise exception 'D4c: paired_devices rows changed';
  end if;

  if (select coalesce(md5(string_agg(md5(b::text), '|' order by b.id::text)), 'empty')
      from public.build_jobs b)
     is distinct from (select fp from d4c_tbl_baseline where tbl = 'build_jobs') then
    raise exception 'D4c: build_jobs rows changed';
  end if;

  -- REPLAYABILITY REPAIR (found bootstrapping a fresh staging database).
  --
  -- This pair used to read:
  --     if v_count <> 5 ...
  --     if (...) <> c_build_jobs_fp ...
  -- where 5 and the fingerprint were production's build_jobs state on the day
  -- D4c was authored. That made this migration impossible to replay: an empty
  -- database correctly has zero rows and failed the count outright, which is
  -- exactly what happened on the first staging push.
  --
  -- The fingerprint half was quietly worse. It compared with `<>` against
  -- md5(string_agg(...)), which is NULL over zero rows, and `NULL <> constant`
  -- is NULL rather than true — so on an empty table it did not fail, it did
  -- nothing at all. A check that cannot fire is not a check.
  --
  -- The invariant D4c actually needs is "this migration disturbed no
  -- pre-existing build_jobs row". d4c_tbl_baseline already captured exactly
  -- that, before any mutation, using the same coalesce(...,'empty') sentinel so
  -- an empty table compares equal to itself. Reading it from there holds on
  -- production, where the five rows still exist, and on a fresh database, where
  -- zero rows must equal zero rows. Nothing is weakened: an unexpected mutation
  -- still fails, and now it fails on any database rather than only on one.
  select count(*) into v_count from public.build_jobs;
  if v_count <> (select n from d4c_tbl_baseline where tbl = 'build_jobs') then
    raise exception 'D4c: build_jobs row count changed from % to %',
      (select n from d4c_tbl_baseline where tbl = 'build_jobs'), v_count;
  end if;

  if (select coalesce(md5(string_agg(md5(b::text), '|' order by b.id::text)), 'empty')
      from public.build_jobs b)
     is distinct from (select fp from d4c_tbl_baseline where tbl = 'build_jobs') then
    raise exception 'D4c: build_jobs fingerprint does not match the migration-start baseline';
  end if;

  -- ---- existing functions untouched ----------------------------------------
  for v_row in select * from d4c_fn_baseline loop
    if not exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = v_row.proname
        and md5(p.prosrc) = v_row.body_md5
        and p.prosecdef = v_row.security_definer
        and coalesce(p.proconfig, array[]::text[]) = v_row.config
        and pg_get_userbyid(p.proowner) = v_row.owner
        and has_function_privilege('service_role', p.oid, 'EXECUTE') = v_row.svc
        and has_function_privilege('authenticated', p.oid, 'EXECUTE') = v_row.auth
        and has_function_privilege('anon', p.oid, 'EXECUTE') = v_row.anon
    ) then
      raise exception 'D4c: function % changed body, posture, owner or grants', v_row.proname;
    end if;
  end loop;

  -- ---- exactly two NEW functions, with the approved names -------------------
  select array_agg(p.proname order by p.proname) into v_new
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname not in (select proname from d4c_allfn_baseline);

  if v_new is distinct from array[
    'build_artifacts_guard_immutable_updates',
    'paired_devices_guard_immutable_columns'
  ] then
    raise exception 'D4c: unexpected set of new functions: %',
      coalesce(array_to_string(v_new, ', '), 'none');
  end if;

  -- ---- new function posture -------------------------------------------------
  foreach v_name in array array[
    'build_artifacts_guard_immutable_updates',
    'paired_devices_guard_immutable_columns'
  ]
  loop
    if not exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_name
        and p.prosecdef
        and pg_get_userbyid(p.proowner) = 'postgres'
        and exists (
          select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg
          where cfg like 'search_path=%public%pg_temp%'
        )
    ) then
      raise exception
        'D4c: % must be postgres-owned, SECURITY DEFINER and search_path-locked',
        v_name;
    end if;
  end loop;

  -- ---- exactly two NEW triggers, with the approved names --------------------
  select array_agg(t.tgname order by t.tgname) into v_new
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not t.tgisinternal
    and t.tgname not in (select tgname from d4c_trg_baseline);

  if v_new is distinct from array[
    'build_artifacts_guard_immutable',
    'paired_devices_guard_immutable'
  ] then
    raise exception 'D4c: unexpected set of new triggers: %',
      coalesce(array_to_string(v_new, ', '), 'none');
  end if;

  -- ---- new triggers are BEFORE UPDATE, row-level and enabled ---------------
  -- tgtype bit 0 = ROW, bit 1 = BEFORE, bit 4 = UPDATE.
  for v_row in
    select t.tgname, t.tgtype, t.tgenabled, c.relname
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not t.tgisinternal
      and t.tgname in ('build_artifacts_guard_immutable', 'paired_devices_guard_immutable')
  loop
    if (v_row.tgtype & 1) = 0 then
      raise exception 'D4c: % must be FOR EACH ROW', v_row.tgname;
    end if;
    if (v_row.tgtype & 2) = 0 then
      raise exception 'D4c: % must be BEFORE', v_row.tgname;
    end if;
    if (v_row.tgtype & 16) = 0 then
      raise exception 'D4c: % must fire on UPDATE', v_row.tgname;
    end if;
    -- bits 3 (DELETE) and 2 (INSERT) must be clear: no DELETE trigger was added.
    if (v_row.tgtype & 8) <> 0 then
      raise exception 'D4c: % must not fire on DELETE', v_row.tgname;
    end if;
    if (v_row.tgtype & 4) <> 0 then
      raise exception 'D4c: % must not fire on INSERT', v_row.tgname;
    end if;
    if v_row.tgenabled <> 'O' then
      raise exception 'D4c: % must be enabled', v_row.tgname;
    end if;
  end loop;

  -- ---- the two build_jobs triggers are untouched ----------------------------
  if exists (
    select 1 from d4c_trg_baseline b
    where not exists (
      select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_proc p on p.oid = t.tgfoid
      where n.nspname = 'public' and not t.tgisinternal
        and c.relname = b.relname and t.tgname = b.tgname
        and t.tgtype = b.tgtype and t.tgenabled = b.tgenabled
        and p.proname = b.proname
    )
  ) then
    raise exception 'D4c: a pre-existing trigger changed or disappeared';
  end if;

  -- ---- policies unchanged ---------------------------------------------------
  select count(*) into v_count from d4c_pol_baseline;
  if v_count <> (
    select count(*) from pg_policies
    where schemaname = 'public'
      and tablename in ('build_artifacts', 'paired_devices', 'build_jobs')
  ) then
    raise exception 'D4c: the number of RLS policies changed';
  end if;

  if exists (
    select 1 from d4c_pol_baseline b
    where not exists (
      select 1 from pg_policies p
      where p.schemaname = 'public' and p.tablename = b.tablename
        and p.policyname = b.policyname and p.cmd = b.cmd
        and p.qual is not distinct from b.qual
        and p.with_check is not distinct from b.with_check
        and p.roles::text = b.roles
    )
  ) then
    raise exception 'D4c: an RLS policy definition changed';
  end if;

  -- ---- D1 privilege matrix unchanged ---------------------------------------
  if exists (
    select 1 from d4c_priv_baseline z
    where has_table_privilege(z.rolname, format('public.%I', z.tablename), z.priv) <> z.granted
  ) then
    raise exception 'D4c: the D1 table privilege matrix changed';
  end if;
end $$;

drop table if exists d4c_tbl_baseline;
drop table if exists d4c_trg_baseline;
drop table if exists d4c_pol_baseline;
drop table if exists d4c_priv_baseline;
drop table if exists d4c_fn_baseline;
drop table if exists d4c_allfn_baseline;
