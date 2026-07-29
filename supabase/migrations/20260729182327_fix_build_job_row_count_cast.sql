-- Feature 15.5 correction — fixes a real runtime bug in
-- heartbeat_build_job/complete_build_job/fail_build_job discovered during
-- the first live worker test against an already-applied
-- 20260729175512_build_job_worker_claiming.sql. This is a NEW migration;
-- it does not edit that already-applied one.
--
-- Root cause: each of those three functions declared
--
--   declare
--     v_updated boolean;
--   begin
--     ...
--     update build_jobs set ... where ...;
--     get diagnostics v_updated = row_count;
--     return v_updated > 0;
--
-- ROW_COUNT (from GET DIAGNOSTICS) is an integer, but v_updated was
-- declared boolean. PostgreSQL has no cast — implicit, assignment, or
-- explicit — between integer and boolean (`select 1::boolean` itself
-- fails with "cannot cast type integer to boolean"), so the
-- `get diagnostics v_updated = row_count` assignment raised that error on
-- every single call, regardless of whether the preceding UPDATE matched a
-- row. Because a PL/pgSQL function body executes as a single unit, that
-- runtime error aborted and rolled back the ENTIRE function invocation —
-- including the UPDATE that had already run moments earlier — so the
-- affected build_jobs row was left exactly as it was before the call
-- (still 'building', claim/lease fields untouched), while the client
-- received a genuine RPC error. worker/once.ts's existing
-- `if (failError || !failResult)` branch could not distinguish "a real
-- RPC error occurred" from "zero rows matched the ownership predicate",
-- so it logged the same misleading "did not apply — may have lost its
-- lease" message either way; a second, separate correction in
-- worker/once.ts/lib/buildJobs.worker.ts now reports these two cases
-- distinctly (see decideRpcTransitionOutcome).
--
-- claim_next_build_job is unaffected: it is a `returns table (...)`
-- function using `return query ...` directly, with no GET DIAGNOSTICS
-- boolean variable at all — which is exactly why claiming worked
-- correctly in the live test while the terminal transition did not.
--
-- Fix: declare the row-count variable as `integer` (matching ROW_COUNT's
-- actual type) in all three functions; `return v_updated > 0` already
-- produces the correct boolean return value once that assignment no
-- longer errors. CREATE OR REPLACE FUNCTION preserves each function's
-- existing EXECUTE privileges when its signature is unchanged (it is,
-- here), but the REVOKE/GRANT statements are restated below anyway for a
-- self-contained, defensively-explicit migration.
--
-- This migration is NOT applied automatically — review, then apply
-- manually, exactly like the two before it.

create or replace function heartbeat_build_job(
  p_build_job_id uuid,
  p_claim_token uuid,
  p_lease_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_updated integer;
begin
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'heartbeat_build_job: lease seconds out of range';
  end if;

  update build_jobs
  set heartbeat_at = now(),
      lease_expires_at = now() + (p_lease_seconds || ' seconds')::interval,
      updated_at = now()
  where id = p_build_job_id
    and status = 'building'
    and claim_token = p_claim_token
    and lease_expires_at > now();

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

revoke all on function heartbeat_build_job(uuid, uuid, integer) from public;
revoke execute on function heartbeat_build_job(uuid, uuid, integer) from anon, authenticated;
grant execute on function heartbeat_build_job(uuid, uuid, integer) to service_role;

create or replace function complete_build_job(
  p_build_job_id uuid,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_updated integer;
begin
  update build_jobs
  set status = 'succeeded',
      finished_at = now(),
      failure_code = null,
      failure_message = null,
      claimed_by = null,
      claim_token = null,
      heartbeat_at = null,
      lease_expires_at = null,
      updated_at = now()
  where id = p_build_job_id
    and status = 'building'
    and claim_token = p_claim_token
    and lease_expires_at > now();

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

revoke all on function complete_build_job(uuid, uuid) from public;
revoke execute on function complete_build_job(uuid, uuid) from anon, authenticated;
grant execute on function complete_build_job(uuid, uuid) to service_role;

create or replace function fail_build_job(
  p_build_job_id uuid,
  p_claim_token uuid,
  p_failure_code text,
  p_failure_message text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_updated integer;
begin
  if p_failure_code not in (
    'generation_failed',
    'invalid_config',
    'worker_timeout',
    'worker_crashed',
    'signing_failed',
    'artifact_upload_failed'
  ) then
    raise exception 'fail_build_job: unsupported failure code';
  end if;

  update build_jobs
  set status = 'failed',
      finished_at = now(),
      failure_code = p_failure_code,
      failure_message = p_failure_message,
      claimed_by = null,
      claim_token = null,
      heartbeat_at = null,
      lease_expires_at = null,
      updated_at = now()
  where id = p_build_job_id
    and status = 'building'
    and claim_token = p_claim_token
    and lease_expires_at > now();

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

revoke all on function fail_build_job(uuid, uuid, text, text) from public;
revoke execute on function fail_build_job(uuid, uuid, text, text) from anon, authenticated;
grant execute on function fail_build_job(uuid, uuid, text, text) to service_role;
