-- Feature 15.6 — Build Artifact Storage and Real Success Criteria.
--
-- This is a NEW migration; it does not edit any already-applied migration
-- (20260729151600, 20260729155238, 20260729175512, 20260729182327). Like
-- all of those, it is NOT applied automatically — review, then apply
-- manually, when ready.
--
-- Verified before writing this migration (read-only query against the
-- real project, via the worker's own service-role client): build_artifacts
-- currently has ZERO rows. Every constraint below that tightens an
-- existing nullable column to NOT NULL / adds a new CHECK is therefore
-- applied directly (not NOT VALID + a later VALIDATE CONSTRAINT step) —
-- there is no existing data that could violate it.
--
-- Note on the approved plan's wording: the plan described this migration
-- as updating "the build_jobs failure_code check constraint." No such
-- table-level CHECK constraint exists — failure_code's approved value
-- set has only ever been enforced inside fail_build_job's own
-- `if p_failure_code not in (...) then raise exception` guard (added in
-- 20260729175512, still present after the 20260729182327 row-count-cast
-- fix). This migration achieves the intended effect by re-declaring
-- fail_build_job (CREATE OR REPLACE, same signature) with
-- 'artifact_verification_failed' added to that list — the actual
-- enforcement mechanism, not a table constraint that never existed.

-- ----------------------------------------------------------------------------
-- fail_build_job — re-declared solely to extend the approved failure-code
-- list with 'artifact_verification_failed'. Body otherwise identical to
-- the 20260729182327 version (same ownership predicate, same
-- integer-typed row-count variable — no GET-DIAGNOSTICS-into-boolean bug
-- reintroduced here).
-- ----------------------------------------------------------------------------
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
    'artifact_upload_failed',
    'artifact_verification_failed'
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
-- build_artifacts — uniqueness and stronger metadata constraints.
-- ----------------------------------------------------------------------------

-- Feature 15.6 — one primary artifact per type per job (allows a future
-- json_config + log on the same job; rejects two json_config rows for the
-- same job) and a globally unique storage path (defense in depth: the
-- worker's own path builder already namespaces by buildJobId, so this
-- should never collide in practice, but the constraint makes "no
-- overwrite, ever" a database-enforced guarantee rather than an
-- application-level assumption).
alter table build_artifacts
  add constraint build_artifacts_job_type_unique
    unique (build_job_id, artifact_type);

alter table build_artifacts
  add constraint build_artifacts_storage_path_unique
    unique (storage_path);

-- Feature 15.6 — storage_path/original_filename/mime_type were already
-- NOT NULL (20260729151600) but not guaranteed non-empty (an empty string
-- satisfies NOT NULL). These three CHECKs close that gap.
alter table build_artifacts
  add constraint build_artifacts_storage_path_not_empty
    check (length(trim(storage_path)) > 0);

alter table build_artifacts
  add constraint build_artifacts_original_filename_not_empty
    check (length(trim(original_filename)) > 0);

alter table build_artifacts
  add constraint build_artifacts_mime_type_not_empty
    check (length(trim(mime_type)) > 0);

-- Feature 15.6 — file_size_bytes and checksum were nullable in
-- 20260729151600 (before any artifact existed, "unknown yet" was a valid
-- state). Now that a real artifact-producing path exists, both are
-- required and validated: file_size_bytes must be a genuine positive
-- byte count, checksum must be a lowercase sha-256 hex digest (matching
-- the same shape convention build_jobs.config_hash already uses).
-- Confirmed safe (0 existing rows) above — direct ALTER, not NOT VALID.
alter table build_artifacts
  drop constraint build_artifacts_file_size_non_negative;

alter table build_artifacts
  alter column file_size_bytes set not null;

alter table build_artifacts
  add constraint build_artifacts_file_size_positive
    check (file_size_bytes > 0);

alter table build_artifacts
  alter column checksum set not null;

alter table build_artifacts
  add constraint build_artifacts_checksum_format
    check (checksum ~ '^[0-9a-f]{64}$');

-- ----------------------------------------------------------------------------
-- Storage bucket — private, idempotent creation.
-- ----------------------------------------------------------------------------

-- Feature 15.6 correction — `on conflict (id) do nothing` was insufficient:
-- if this bucket already existed (e.g. created out-of-band via the
-- Supabase dashboard, possibly as public — a real, plausible
-- misconfiguration this migration must not silently tolerate), "do
-- nothing" would leave whatever `public` value that pre-existing row
-- already had untouched. This is a deliberate `do update ... set public =
-- false` instead: re-applying this migration against a bucket that is
-- somehow already public corrects it back to private every time, rather
-- than only enforcing privacy on first creation. `name` is re-asserted
-- for the same idempotent-and-self-correcting reason; no other bucket
-- setting (file_size_limit, allowed_mime_types, owner, etc.) is touched,
-- since this migration has no opinion on those and must not silently
-- overwrite a value it doesn't itself own.
insert into storage.buckets (id, name, public)
values ('build-artifacts', 'build-artifacts', false)
on conflict (id) do update
set
  name = excluded.name,
  public = false;

-- Feature 15.6 — deliberately NO storage.objects policy is added for
-- anon or authenticated here. storage.objects has row-level security
-- enabled by default in a Supabase project; with no policy granting
-- those roles any access to this bucket's objects, Postgres's own
-- deny-by-default RLS behavior (the same mechanism build_jobs/
-- build_artifacts already rely on) means browser roles get zero list/
-- read/write/delete access — not because of anything this migration
-- actively restricts, but because nothing here grants it. All access
-- goes through this feature's service-role worker (which bypasses RLS
-- entirely by Supabase's own design) or, in Feature 15.7, a server-side
-- signed-URL flow using the same service-role credential. Manually
-- confirm no other, unrelated policy on this project already grants
-- anon/authenticated broader storage.objects access than intended — this
-- migration cannot detect or override a pre-existing permissive policy
-- it doesn't itself create.

-- ----------------------------------------------------------------------------
-- finalize_build_job_with_artifact — the atomic "record artifact + mark
-- succeeded" entry point. One data-modifying CTE chain (return query),
-- deliberately NOT the GET-DIAGNOSTICS-into-a-mistyped-variable pattern
-- that caused the Feature 15.5 incident: a `returns table (...)` function
-- with `return query` over a WITH chain has no row-count variable to get
-- wrong in the first place.
--
-- Ownership predicate (owned_job) is identical to complete_build_job's:
-- status = 'building', claim_token matches, lease still valid. If that
-- CTE selects zero rows (lost claim, wrong token, expired lease, or the
-- job was already terminal), the insert_artifact CTE's `from owned_job`
-- also produces zero rows, nothing is inserted, completed_job's `where id
-- in (select ...)` matches nothing, and the final SELECT returns zero
-- rows — the whole call is a no-op, exactly like claim_next_build_job's
-- own "nothing eligible" case.
--
-- If the artifact insert fails because of build_artifacts_job_type_unique
-- or build_artifacts_storage_path_unique (a duplicate finalize attempt
-- for the same job — expected to be rare/defensive, since a job that
-- already has a json_config artifact is already 'succeeded' and therefore
-- already excluded by owned_job's own status = 'building' filter), that
-- constraint violation raises an error partway through this single
-- statement, aborting and rolling back the ENTIRE statement — including
-- the not-yet-reached completed_job UPDATE. The job is left exactly as it
-- was: still 'building', no artifact row added, no upsert/overwrite/
-- delete-and-replace of any kind.
create or replace function finalize_build_job_with_artifact(
  p_build_job_id uuid,
  p_claim_token uuid,
  p_artifact_type text,
  p_storage_path text,
  p_original_filename text,
  p_mime_type text,
  p_file_size_bytes bigint,
  p_checksum text,
  p_expires_at timestamptz default null
)
returns table (artifact_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_artifact_type not in ('apk', 'desktop_installer', 'zip', 'json_config', 'log') then
    raise exception 'finalize_build_job_with_artifact: unsupported artifact type';
  end if;

  if p_storage_path is null or length(trim(p_storage_path)) = 0 then
    raise exception 'finalize_build_job_with_artifact: storage path is required';
  end if;

  if p_original_filename is null or length(trim(p_original_filename)) = 0 then
    raise exception 'finalize_build_job_with_artifact: original filename is required';
  end if;

  if p_mime_type is null or length(trim(p_mime_type)) = 0 then
    raise exception 'finalize_build_job_with_artifact: mime type is required';
  end if;

  if p_file_size_bytes is null or p_file_size_bytes <= 0 then
    raise exception 'finalize_build_job_with_artifact: file size must be a positive number';
  end if;

  if p_checksum is null or p_checksum !~ '^[0-9a-f]{64}$' then
    raise exception 'finalize_build_job_with_artifact: checksum must be a lowercase sha-256 hex digest';
  end if;

  return query
  with owned_job as (
    select id
    from build_jobs
    where id = p_build_job_id
      and status = 'building'
      and claim_token = p_claim_token
      and lease_expires_at > now()
    for update
  ),
  inserted_artifact as (
    insert into build_artifacts (
      build_job_id, artifact_type, storage_path, original_filename,
      mime_type, file_size_bytes, checksum, expires_at
    )
    select
      owned_job.id, p_artifact_type, p_storage_path, p_original_filename,
      p_mime_type, p_file_size_bytes, p_checksum, p_expires_at
    from owned_job
    returning id, build_job_id
  ),
  completed_job as (
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
    where id in (select build_job_id from inserted_artifact)
    returning id
  )
  select inserted_artifact.id as artifact_id
  from inserted_artifact
  join completed_job on completed_job.id = inserted_artifact.build_job_id;
end;
$$;

revoke all on function finalize_build_job_with_artifact(uuid, uuid, text, text, text, text, bigint, text, timestamptz) from public;
revoke execute on function finalize_build_job_with_artifact(uuid, uuid, text, text, text, text, bigint, text, timestamptz) from anon, authenticated;
grant execute on function finalize_build_job_with_artifact(uuid, uuid, text, text, text, text, bigint, text, timestamptz) to service_role;
