-- Feature 15.5 — Build Worker Architecture and Safe Job Claiming.
--
-- This is a NEW migration; it does not edit either already-applied
-- migration (20260729151600_build_jobs_and_artifacts.sql or
-- 20260729155238_drop_build_jobs_insert_policy.sql). Like both of those,
-- it is NOT applied automatically by any tooling in this codebase —
-- review, then apply manually, when ready.
--
-- Adds the columns and trusted RPC functions a standalone build worker
-- needs to safely claim, hold a time-bounded lease on, and terminate a
-- build_jobs row — without ever giving an ordinary authenticated browser
-- session (RLS-scoped, anon/authenticated roles) any path to do the same.
-- build_jobs' existing RLS policy set is untouched by this migration:
-- authenticated users can still only SELECT their own rows; there remains
-- no browser-facing INSERT/UPDATE/DELETE policy at all. The four
-- functions below bypass RLS entirely (SECURITY DEFINER), which is
-- exactly why revoking EXECUTE from anon/authenticated below is the real
-- gate keeping ordinary Builder users out — RLS on the table alone would
-- not stop a SECURITY DEFINER function from writing rows on their behalf.

-- ----------------------------------------------------------------------------
-- Columns
-- ----------------------------------------------------------------------------

alter table build_jobs
  add column if not exists claimed_by text,
  add column if not exists claim_token uuid,
  add column if not exists heartbeat_at timestamptz,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists attempt_count integer not null default 0;

-- claimed_by is diagnostic worker-process identity (observability: "which
-- worker touched this"); claim_token is the sole authoritative ownership
-- proof for one exact claim/reclaim attempt, checked by every worker RPC
-- below. Both are cleared together, always, whenever a job leaves the
-- 'building' state (see the constraint below and every RPC's UPDATE).

alter table build_jobs
  add constraint build_jobs_attempt_count_non_negative
    check (attempt_count >= 0);

-- Feature 15.5 hardening correction — bidirectional: a 'building' row
-- must carry COMPLETE claim ownership metadata (not merely "any of these
-- fields may be set"), and any non-'building' row must carry NONE. The
-- original form of this constraint (status = 'building' OR all-fields-
-- null) still permitted a 'building' row with, say, a null claim_token —
-- which every worker RPC's ownership predicate treats as unclaimable
-- (claim_token = p_claim_token can never match a null column value passed
-- a non-null p_claim_token), silently stranding that row forever with no
-- way to heartbeat/complete/fail it. This mirrors the existing
-- build_jobs_queued_has_no_timestamps / build_jobs_terminal_has_finished_at
-- pattern from the original migration, extended to the new claim columns.
alter table build_jobs
  add constraint build_jobs_claim_fields_only_while_building
    check (
      (
        status = 'building'
        and claimed_by is not null
        and btrim(claimed_by) <> ''
        and claim_token is not null
        and heartbeat_at is not null
        and lease_expires_at is not null
        and attempt_count > 0
      )
      or
      (
        status <> 'building'
        and claimed_by is null
        and claim_token is null
        and heartbeat_at is null
        and lease_expires_at is null
      )
    );

-- ----------------------------------------------------------------------------
-- Indexes
-- ----------------------------------------------------------------------------

-- Feature 15.5 — supports claim_next_build_job's candidate lookup: the
-- oldest eligible (queued, or stale-building) row for a given target.
create index if not exists build_jobs_queue_lookup_idx
  on build_jobs (target, status, created_at, id);

-- Feature 15.5 — supports the same function's stale-job checks (both the
-- reclaim branch and the exhaustion/cleanup branch), which only ever scan
-- 'building' rows.
create index if not exists build_jobs_stale_lookup_idx
  on build_jobs (status, lease_expires_at)
  where status = 'building';

-- ----------------------------------------------------------------------------
-- claim_next_build_job
--
-- The single atomic entry point a worker calls to get one unit of work.
-- One SQL statement (a data-modifying CTE chain), so it is atomic without
-- an explicit transaction block:
--
--   1. expired_exhausted — finalizes any 'building' row for THIS SAME
--      target whose lease has expired and whose attempt_count has already
--      reached the cap (3, including the original claim) as failed,
--      failure_code = 'worker_timeout'. Scoped to p_target so a worker
--      claiming android jobs never touches desktop rows, and vice versa.
--      Accepted MVP limitation: an exhausted stale job is only finalized
--      the next time a worker requests a job for that same target — there
--      is no separate reaper process in this feature.
--   2. candidate — the oldest eligible row for p_target: either 'queued',
--      or 'building' with an expired lease and attempt_count still below
--      the cap. `for update skip locked` means two concurrent callers can
--      never lock, let alone claim, the same row — the second caller's
--      scan simply skips it and moves on to the next eligible row (or
--      finds none).
--   3. the final UPDATE claims exactly that one candidate row.
--
-- Returns only minimal worker-facing data (id, target, claim_token,
-- lease_expires_at, attempt_count) — never config_snapshot. The worker
-- performs its own second, separately-scoped read for that (see
-- worker/once.ts), keeping this function's return shape small and stable.
create or replace function claim_next_build_job(
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
  if p_target is null or p_target not in ('android', 'desktop') then
    raise exception 'claim_next_build_job: unsupported build target';
  end if;

  if p_worker_id is null or length(trim(p_worker_id)) = 0 then
    raise exception 'claim_next_build_job: worker id is required';
  end if;

  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'claim_next_build_job: lease seconds out of range';
  end if;

  return query
  with expired_exhausted as (
    update build_jobs
    set status = 'failed',
        finished_at = now(),
        failure_code = 'worker_timeout',
        failure_message = 'Build processing stopped before completion.',
        claimed_by = null,
        claim_token = null,
        heartbeat_at = null,
        lease_expires_at = null,
        updated_at = now()
    where build_jobs.target = p_target
      and build_jobs.status = 'building'
      and build_jobs.lease_expires_at < now()
      and build_jobs.attempt_count >= 3
    returning build_jobs.id
  ),
  candidate as (
    select bj.id
    from build_jobs bj
    where bj.target = p_target
      and (
        bj.status = 'queued'
        or (
          bj.status = 'building'
          and bj.lease_expires_at < now()
          and bj.attempt_count < 3
        )
      )
    order by bj.created_at asc, bj.id asc
    limit 1
    for update skip locked
  )
  update build_jobs
  set status = 'building',
      claimed_by = p_worker_id,
      claim_token = gen_random_uuid(),
      started_at = coalesce(build_jobs.started_at, now()),
      heartbeat_at = now(),
      lease_expires_at = now() + (p_lease_seconds || ' seconds')::interval,
      attempt_count = build_jobs.attempt_count + 1,
      -- Feature 15.5 — defensive clear: a job being (re)claimed should
      -- never still carry failure fields from some earlier, unrelated
      -- state. In practice this is always already null here (failure
      -- fields are only ever set by fail_build_job, which itself always
      -- leaves the row terminal, and a terminal row is never eligible for
      -- claim), but this keeps the invariant explicit rather than
      -- implicit.
      failure_code = null,
      failure_message = null,
      updated_at = now()
  from candidate
  where build_jobs.id = candidate.id
  returning build_jobs.id, build_jobs.target, build_jobs.claim_token,
            build_jobs.lease_expires_at, build_jobs.attempt_count;
end;
$$;

revoke all on function claim_next_build_job(text, text, integer) from public;
revoke execute on function claim_next_build_job(text, text, integer) from anon, authenticated;
grant execute on function claim_next_build_job(text, text, integer) to service_role;

-- ----------------------------------------------------------------------------
-- heartbeat_build_job
--
-- Extends a currently-held lease. Requires the exact claim_token
-- currently stored on the job AND that the lease has not already expired
-- — an expired claim must not be able to renew itself back to life after
-- the fact, since another worker may already be racing to reclaim it via
-- claim_next_build_job. If the lease already expired, the caller's own
-- claim_token is very likely already stale too (a reclaim always mints a
-- fresh token), but the explicit lease_expires_at > now() check closes the
-- narrow window where it technically hasn't been reclaimed yet but
-- shouldn't be allowed to keep going past its own deadline.
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
  v_updated boolean;
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

-- ----------------------------------------------------------------------------
-- complete_build_job
--
-- Designed now, per the approved Feature 15.5 plan, but the placeholder
-- worker introduced by this feature must never call it — no real artifact
-- exists yet to justify a 'succeeded' status. Same ownership predicate as
-- fail_build_job: status = 'building', claim_token matches, lease still
-- valid. Clears every claim/lease field and defensively nulls the failure
-- fields (a succeeding job was never failed, but this keeps the invariant
-- explicit rather than assumed).
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
  v_updated boolean;
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

-- ----------------------------------------------------------------------------
-- fail_build_job
--
-- Same ownership predicate as complete_build_job. p_failure_code is
-- validated against the exact approved BuildFailureCode set (matching
-- lib/buildJobs.ts's BUILD_FAILURE_CODES) so a caller can never write an
-- arbitrary string into failure_code even though this function bypasses
-- RLS. p_failure_message is stored as given — the worker is expected to
-- have already sanitized it (sanitizeBuildFailureMessage) before calling
-- this function; this function does not re-sanitize, since it has no
-- opinion on message shape beyond the failure_code it validates.
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
  v_updated boolean;
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

-- ----------------------------------------------------------------------------
-- No changes to build_jobs' or build_artifacts' RLS policies. Ordinary
-- authenticated browser users still cannot SELECT claimed_by, claim_token,
-- heartbeat_at, or lease_expires_at through any path this migration adds
-- (those columns are simply new columns on a table whose own SELECT
-- policy is unchanged) — but note BUILD_JOB_COLUMNS in lib/buildJobs.ts
-- does not select them either, so getProjectBuildJobs/getBuildJobById
-- never return them to the browser even incidentally.
-- ----------------------------------------------------------------------------
