-- Milestone 16, Feature 16.3 — Migration D4b
-- build_jobs immutability and status-transition guard.
--
-- SCOPE: one new trigger function, one new trigger, and one ALTER FUNCTION that
-- adds a locked search_path to the existing updated-at function without
-- touching its body. No composite keys, no artifact or paired-device trigger,
-- no grant, no policy, no data change, no checkout or pairing RPC change.
--
-- ----------------------------------------------------------------------------
-- WHY
-- ----------------------------------------------------------------------------
-- A paired device is pinned to exactly one build_jobs row and prices every sale
-- from that row's config_snapshot. Nothing in the current code updates a
-- snapshot — verified against every live write path — but nothing stops it
-- either. A snapshot rewritten under a paired device would silently change what
-- that device charges customers, with no audit trail. The same argument applies
-- to project_id and owner_id: moving a build to another project would re-point
-- every device pinned to it.
--
-- This migration turns "no code does that" into "the database will not permit
-- it", which is the difference between an invariant and a convention.
--
-- ----------------------------------------------------------------------------
-- ALLOWED STATUS TRANSITIONS — derived from the live WHERE clauses, not docs
-- ----------------------------------------------------------------------------
--   queued    -> building    claim_next_build_job (claim branch)
--   building  -> building    stale re-claim: lease expired, attempt_count < 3.
--                            This is a same-status update, so the transition
--                            rule below never fires for it. There is NO
--                            building -> queued path anywhere in the system and
--                            none is introduced here.
--   building  -> succeeded   complete_build_job, finalize_build_job_with_artifact
--   building  -> failed      fail_build_job; stale-exhaust inside
--                            claim_next_build_job (attempt_count >= 3)
--
-- succeeded and failed are TERMINAL. A retry creates a new row linked by
-- retried_from_job_id; it never reopens the old one.
--
-- The transition rule is evaluated ONLY when the status actually changes, so an
-- ordinary heartbeat (building -> building, touching only heartbeat_at,
-- lease_expires_at and updated_at) is unaffected. The immutable-column checks
-- run on EVERY update regardless.

-- ----------------------------------------------------------------------------
-- Baseline capture.
--
-- Temp tables recorded BEFORE any DDL, so the verification block at the end can
-- compare real values instead of hardcoded ones. The repository has never
-- recorded a post-Migration-C body hash for the checkout functions, and
-- guessing one produced a false failure earlier in this milestone — capturing
-- in-session avoids that class of error entirely.
--
-- Requires the whole file to be run as ONE submission (one session), which is
-- how every migration in this project has been applied.
-- ----------------------------------------------------------------------------
create temporary table d4b_fn_baseline as
select
  p.proname,
  md5(p.prosrc)                              as body_md5,
  p.prosecdef                                as security_definer,
  coalesce(p.proconfig, array[]::text[])     as config,
  pg_get_userbyid(p.proowner)                as owner,
  has_function_privilege('service_role', p.oid, 'EXECUTE')  as svc_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_execute,
  has_function_privilege('anon', p.oid, 'EXECUTE')          as anon_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'set_build_jobs_updated_at',
    'claim_next_build_job',
    'heartbeat_build_job',
    'complete_build_job',
    'fail_build_job',
    'finalize_build_job_with_artifact',
    'complete_sale',
    'complete_sale_v2'
  );

create temporary table d4b_jobs_baseline as
select b.id, md5(b::text) as row_md5
from public.build_jobs b;

create temporary table d4b_priv_baseline as
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

-- ----------------------------------------------------------------------------
-- The guard.
--
-- Reads no table and writes no table: it compares OLD and NEW only, so it
-- cannot recurse, cannot deadlock, and adds no I/O to the worker's hot path.
-- IS DISTINCT FROM is used throughout so a NULL on either side behaves
-- correctly (retried_from_job_id and config_hash can legitimately be NULL-ish
-- shapes across rows).
--
-- SECURITY DEFINER with a locked search_path so its behavior cannot be altered
-- by a caller's search_path, and so it is unaffected by whichever role the
-- build worker connects as.
--
-- Error messages name only the COLUMN or the two status literals. They never
-- interpolate an id, a config value, a request_key or a claim_token.
-- ----------------------------------------------------------------------------
create or replace function public.build_jobs_guard_immutable_columns()
returns trigger
language plpgsql
security definer
set search_path to public, pg_temp
as $function$
begin
  -- ---- immutable identity and configuration, checked on EVERY update -------
  if new.project_id is distinct from old.project_id then
    raise exception 'build_jobs.project_id cannot be changed after creation';
  end if;

  if new.owner_id is distinct from old.owner_id then
    raise exception 'build_jobs.owner_id cannot be changed after creation';
  end if;

  if new.request_key is distinct from old.request_key then
    raise exception 'build_jobs.request_key cannot be changed after creation';
  end if;

  if new.target is distinct from old.target then
    raise exception 'build_jobs.target cannot be changed after creation';
  end if;

  if new.config_snapshot is distinct from old.config_snapshot then
    raise exception 'build_jobs.config_snapshot cannot be changed after creation';
  end if;

  if new.config_schema_version is distinct from old.config_schema_version then
    raise exception 'build_jobs.config_schema_version cannot be changed after creation';
  end if;

  if new.config_hash is distinct from old.config_hash then
    raise exception 'build_jobs.config_hash cannot be changed after creation';
  end if;

  if new.retried_from_job_id is distinct from old.retried_from_job_id then
    raise exception 'build_jobs.retried_from_job_id cannot be changed after creation';
  end if;

  -- ---- status transitions, only when the status actually changes -----------
  -- A same-status update (the stale re-claim building -> building, and every
  -- heartbeat) skips this block entirely and is always permitted, subject to
  -- the immutable checks above.
  if new.status is distinct from old.status then
    if not (
      (old.status = 'queued' and new.status = 'building')
      or (old.status = 'building' and new.status in ('succeeded', 'failed'))
    ) then
      raise exception
        'build_jobs status cannot change from % to %', old.status, new.status;
    end if;
  end if;

  return new;
end;
$function$;

-- Trigger name is deliberately chosen so it fires BEFORE the existing
-- build_jobs_set_updated_at: PostgreSQL runs BEFORE ROW triggers in name order,
-- and 'build_jobs_guard_immutable' < 'build_jobs_set_updated_at' because 'g'
-- sorts before 's'. A rejection therefore happens before updated_at is stamped.
--
-- CREATE OR REPLACE TRIGGER requires PostgreSQL 14+; this project runs 15+.
create or replace trigger build_jobs_guard_immutable
  before update on public.build_jobs
  for each row
  execute function public.build_jobs_guard_immutable_columns();

-- ----------------------------------------------------------------------------
-- Harden the pre-existing updated-at function.
--
-- ALTER FUNCTION ... SET search_path attaches the setting WITHOUT touching the
-- body, so prosrc — and therefore its md5 — is unchanged. It stays SECURITY
-- INVOKER: it only stamps NEW.updated_at and has no reason to run as postgres.
-- This closes the one function in the schema still lacking a locked path.
-- ----------------------------------------------------------------------------
alter function public.set_build_jobs_updated_at() set search_path to public, pg_temp;

-- ----------------------------------------------------------------------------
-- Verification.
-- ----------------------------------------------------------------------------
do $$
declare
  v_guard oid;
  v_trg record;
  v_row record;
  v_count integer;
begin
  -- ---- guard function -------------------------------------------------------
  v_guard := to_regprocedure('public.build_jobs_guard_immutable_columns()');
  if v_guard is null then
    raise exception 'D4b: guard function is missing';
  end if;

  if (select pg_get_userbyid(p.proowner) from pg_proc p where p.oid = v_guard) <> 'postgres' then
    raise exception 'D4b: guard function must be owned by postgres';
  end if;

  if not (select p.prosecdef from pg_proc p where p.oid = v_guard) then
    raise exception 'D4b: guard function must be SECURITY DEFINER';
  end if;

  if not exists (
    select 1 from pg_proc p, unnest(coalesce(p.proconfig, array[]::text[])) cfg
    where p.oid = v_guard and cfg like 'search_path=%public%pg_temp%'
  ) then
    raise exception 'D4b: guard function must lock search_path to public, pg_temp';
  end if;

  -- ---- guard trigger --------------------------------------------------------
  select t.tgname, t.tgtype into v_trg
  from pg_trigger t
  where t.tgrelid = 'public.build_jobs'::regclass
    and t.tgname = 'build_jobs_guard_immutable'
    and not t.tgisinternal;
  if not found then
    raise exception 'D4b: guard trigger is missing';
  end if;

  -- tgtype bit 0 = ROW, bit 1 = BEFORE, bit 4 = UPDATE
  if (v_trg.tgtype & 1) = 0 then
    raise exception 'D4b: guard trigger must be FOR EACH ROW';
  end if;
  if (v_trg.tgtype & 2) = 0 then
    raise exception 'D4b: guard trigger must be BEFORE';
  end if;
  if (v_trg.tgtype & 16) = 0 then
    raise exception 'D4b: guard trigger must fire on UPDATE';
  end if;

  if not exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.build_jobs'::regclass
      and t.tgname = 'build_jobs_set_updated_at'
      and not t.tgisinternal
  ) then
    raise exception 'D4b: the pre-existing updated-at trigger is missing';
  end if;

  if not ('build_jobs_guard_immutable' < 'build_jobs_set_updated_at') then
    raise exception 'D4b: guard trigger name must sort before the updated-at trigger';
  end if;

  -- Exactly two row triggers on the table: the guard and the updated-at stamp.
  select count(*) into v_count
  from pg_trigger t
  where t.tgrelid = 'public.build_jobs'::regclass and not t.tgisinternal;
  if v_count <> 2 then
    raise exception 'D4b: expected exactly 2 triggers on build_jobs, found %', v_count;
  end if;

  -- ---- updated-at function --------------------------------------------------
  if (select p.prosecdef from pg_proc p
      where p.oid = to_regprocedure('public.set_build_jobs_updated_at()')) then
    raise exception 'D4b: set_build_jobs_updated_at must remain SECURITY INVOKER';
  end if;

  if not exists (
    select 1 from pg_proc p, unnest(coalesce(p.proconfig, array[]::text[])) cfg
    where p.oid = to_regprocedure('public.set_build_jobs_updated_at()')
      and cfg like 'search_path=%public%pg_temp%'
  ) then
    raise exception 'D4b: set_build_jobs_updated_at must now lock search_path';
  end if;

  -- ---- nothing else changed -------------------------------------------------
  -- Body hashes, posture and EXECUTE grants for every build RPC and both
  -- checkout functions, compared against the in-session baseline. ALTER
  -- FUNCTION ... SET search_path does not touch prosrc, so even
  -- set_build_jobs_updated_at must hash identically; only its config may differ.
  for v_row in
    select b.proname, b.body_md5, b.security_definer, b.owner,
           b.svc_execute, b.auth_execute, b.anon_execute, b.config
    from d4b_fn_baseline b
  loop
    if not exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = v_row.proname
        and md5(p.prosrc) = v_row.body_md5
        and p.prosecdef = v_row.security_definer
        and pg_get_userbyid(p.proowner) = v_row.owner
        and has_function_privilege('service_role', p.oid, 'EXECUTE') = v_row.svc_execute
        and has_function_privilege('authenticated', p.oid, 'EXECUTE') = v_row.auth_execute
        and has_function_privilege('anon', p.oid, 'EXECUTE') = v_row.anon_execute
    ) then
      raise exception 'D4b: function % changed body, posture or grants', v_row.proname;
    end if;

    -- Only set_build_jobs_updated_at may have gained a config entry.
    if v_row.proname <> 'set_build_jobs_updated_at' then
      if not exists (
        select 1 from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = v_row.proname
          and coalesce(p.proconfig, array[]::text[]) = v_row.config
      ) then
        raise exception 'D4b: function % had its configuration changed', v_row.proname;
      end if;
    end if;
  end loop;

  -- ---- build_jobs data untouched -------------------------------------------
  select count(*) into v_count from d4b_jobs_baseline;
  if v_count <> (select count(*) from public.build_jobs) then
    raise exception 'D4b: build_jobs row count changed';
  end if;

  if exists (
    select 1
    from public.build_jobs b
    full join d4b_jobs_baseline z on z.id = b.id
    where b.id is null or z.id is null or md5(b::text) is distinct from z.row_md5
  ) then
    raise exception 'D4b: at least one build_jobs row changed';
  end if;

  -- ---- D1 privilege matrix untouched ---------------------------------------
  if exists (
    select 1
    from d4b_priv_baseline z
    where has_table_privilege(z.rolname, format('public.%I', z.tablename), z.priv) <> z.granted
  ) then
    raise exception 'D4b: the D1 table privilege matrix changed';
  end if;
end $$;

drop table if exists d4b_fn_baseline;
drop table if exists d4b_jobs_baseline;
drop table if exists d4b_priv_baseline;
