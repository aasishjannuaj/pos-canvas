-- OFF-2-EXACT-CLAIM-1 — claim ONE named build job, and nothing else.
--
-- SCOPE: one new function, its grants, and a self-verification block. No
-- table, column, constraint, trigger, policy or grant on any existing object
-- changes; no existing function is redefined.
--
-- ----------------------------------------------------------------------------
-- WHY
-- ----------------------------------------------------------------------------
-- claim_next_build_job (20260729175512) is the only way a worker obtains a
-- job, and it is GLOBAL by design: it takes the OLDEST eligible job of a
-- target from ANY business, reclaims stale 'building' jobs, and in the same
-- statement fails other businesses' exhausted stale jobs. That is right for
-- the queue worker and wrong for a controlled test that must build exactly
-- one known job: a check followed by a global claim always leaves a race, and
-- a post-check only detects an unwanted write after it happened.
--
-- claim_build_job_by_id is the exact counterpart. It is ONE statement keyed by
-- the primary key, so it can write AT MOST ONE row, and only when that row is
-- the named job, of the named business, for the named target, still 'queued',
-- and within the attempt limit. No scan, no reclaim, no failover, no other
-- row. claim_next_build_job is untouched and remains the default path.
--
-- ----------------------------------------------------------------------------
-- WHAT IS PRESERVED
-- ----------------------------------------------------------------------------
--   * Status: only queued -> building, the transition
--     build_jobs_guard_immutable_columns (20260803260000) already enforces.
--     That trigger is unchanged and still runs on this UPDATE.
--   * Attempt limit: attempt_count < 3, the same cap claim_next_build_job
--     applies before any claim.
--   * Bookkeeping: identical to claim_next_build_job's claim branch —
--     claimed_by, a fresh random claim_token, started_at (first claim only),
--     heartbeat_at, lease_expires_at, attempt_count + 1, failure fields
--     cleared, updated_at.
--   * Lease: the same 30..3600 second bound. heartbeat_build_job,
--     finalize_build_job_with_artifact and fail_build_job still require the
--     exact claim_token and an unexpired lease; they are not touched.
--   * Privilege: service_role only, exactly like claim_next_build_job.
--   * Return shape: identical to claim_next_build_job, so the worker's
--     post-claim path is shared, not duplicated.
--
-- CONCURRENCY. The UPDATE takes the row lock. A competing claimer that already
-- holds the row (this function or claim_next_build_job) makes this statement
-- wait; on its commit PostgreSQL re-evaluates the WHERE clause against the new
-- row version, status is no longer 'queued', and nothing is updated. Two
-- claimers therefore can never both obtain a claim token for one job.
--
-- A job that is missing, of another business or target, not queued, or over
-- the attempt limit yields ZERO ROWS, not an error — exactly how
-- claim_next_build_job reports "nothing to claim" — and the worker stops
-- without building. Malformed arguments RAISE before any row is read.

create or replace function public.claim_build_job_by_id(
  p_build_job_id uuid,
  p_project_id uuid,
  p_target text,
  p_worker_id text,
  p_lease_seconds integer
)
returns table (
  id uuid,
  target text,
  claim_token uuid,
  lease_expires_at timestamptz,
  attempt_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_build_job_id is null then
    raise exception 'claim_build_job_by_id: build job id is required';
  end if;

  if p_project_id is null then
    raise exception 'claim_build_job_by_id: project id is required';
  end if;

  if p_target is null or p_target not in ('android', 'desktop') then
    raise exception 'claim_build_job_by_id: unsupported build target';
  end if;

  if p_worker_id is null or length(trim(p_worker_id)) = 0 then
    raise exception 'claim_build_job_by_id: worker id is required';
  end if;

  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'claim_build_job_by_id: lease seconds out of range';
  end if;

  return query
  update build_jobs
  set status = 'building',
      claimed_by = p_worker_id,
      claim_token = gen_random_uuid(),
      started_at = coalesce(build_jobs.started_at, now()),
      heartbeat_at = now(),
      lease_expires_at = now() + (p_lease_seconds || ' seconds')::interval,
      attempt_count = build_jobs.attempt_count + 1,
      failure_code = null,
      failure_message = null,
      updated_at = now()
  where build_jobs.id = p_build_job_id
    and build_jobs.project_id = p_project_id
    and build_jobs.target = p_target
    and build_jobs.status = 'queued'
    and build_jobs.attempt_count < 3
  returning build_jobs.id, build_jobs.target, build_jobs.claim_token,
            build_jobs.lease_expires_at, build_jobs.attempt_count;
end;
$$;

revoke all on function public.claim_build_job_by_id(uuid, uuid, text, text, integer) from public;
revoke execute on function public.claim_build_job_by_id(uuid, uuid, text, text, integer) from anon, authenticated;
grant execute on function public.claim_build_job_by_id(uuid, uuid, text, text, integer) to service_role;

-- ----------------------------------------------------------------------------
-- Self-verification: fail the whole migration if the function is not exactly
-- what this file says.
-- ----------------------------------------------------------------------------
do $$
declare
  v_fn oid := 'public.claim_build_job_by_id(uuid, uuid, text, text, integer)'::regprocedure;
begin
  if not (select p.prosecdef from pg_proc p where p.oid = v_fn) then
    raise exception 'OFF-2-EXACT-CLAIM-1: claim_build_job_by_id must be SECURITY DEFINER';
  end if;

  if (select p.proconfig from pg_proc p where p.oid = v_fn) is distinct from array['search_path=public, pg_temp'] then
    raise exception 'OFF-2-EXACT-CLAIM-1: claim_build_job_by_id must pin search_path';
  end if;

  if has_function_privilege('anon', v_fn, 'EXECUTE')
     or has_function_privilege('authenticated', v_fn, 'EXECUTE')
     or not has_function_privilege('service_role', v_fn, 'EXECUTE') then
    raise exception 'OFF-2-EXACT-CLAIM-1: claim_build_job_by_id must be executable by service_role only';
  end if;

  if exists (
    select 1 from aclexplode((select p.proacl from pg_proc p where p.oid = v_fn)) a where a.grantee = 0
  ) then
    raise exception 'OFF-2-EXACT-CLAIM-1: claim_build_job_by_id must not be granted to PUBLIC';
  end if;

  raise notice 'OFF-2-EXACT-CLAIM-1 verified: claim_build_job_by_id added (exact job, service_role only); nothing else changed.';
end;
$$;
