-- Feature 15.2 — Build Job Architecture and Data Model.
--
-- This is the first migration file tracked in this repository. It is NOT
-- applied automatically by any tooling in this codebase — review it, then
-- apply it manually (Supabase dashboard SQL editor, or `supabase db push`
-- once the Supabase CLI is configured for this project) when ready.
--
-- ============================================================================
-- CONFIRMATION NEEDED BEFORE APPLYING — see the build_jobs_insert_own policy
-- below. This migration assumes the existing `projects` table has a
-- `user_id` column identifying its owner. That assumption is inferred from
-- application code (lib/projects.ts's saveNewProject calls
-- `.insert({ user_id: user.id, ... })`, where `user` comes from
-- `supabase.auth.getUser()`), NOT verified against the real `projects`
-- table DDL — no other migrations exist in this repository to confirm it
-- against directly. Please confirm `projects.user_id` is the actual,
-- current ownership column (and that it is populated with the owning
-- auth.users.id) before applying this migration.
-- ============================================================================

-- gen_random_uuid() is provided by pgcrypto; kept as an explicit, idempotent
-- "if not exists" so this migration doesn't assume the extension is already
-- enabled on the target project.
create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- build_jobs
--
-- One row per requested build. Immutable in spirit: config_snapshot is
-- written once, at job-creation time, and never regenerated or overwritten
-- afterward — a project rename or menu edit after a job is queued must
-- never change what that job builds. A retry creates a brand-new row
-- (linked via retried_from_job_id); a terminal row (succeeded/failed) is
-- never reopened or reused.
-- ----------------------------------------------------------------------------
create table if not exists build_jobs (
  id uuid primary key default gen_random_uuid(),

  -- Feature 15.2 — deleting a project cascades to its build jobs. Decision
  -- and reasoning: a build job has no independent meaning once the project
  -- it was built from no longer exists — there is nothing left to rebuild,
  -- retry, or reference, and keeping orphaned job rows around (pointing at
  -- a project_id that can never resolve again) would only accumulate dead
  -- weight with no product value. This mirrors how deleting the source
  -- project already makes every other project-scoped concept (orders,
  -- inventory transactions) meaningless too.
  project_id uuid not null references projects(id) on delete cascade,

  -- Feature 15.2 — explicit, not RLS-inferred. Every other table in this
  -- app relies purely on RLS + auth.getClaims()/auth.getUser() for
  -- ownership, because every existing reader is an interactive, session-
  -- authenticated request. A future build worker has no such session — it
  -- runs under its own service-role credential and needs a plain column to
  -- reason about "whose job is this" (storage-path namespacing, quotas,
  -- notifications) entirely outside of RLS's reach. References auth.users
  -- directly, which is standard/safe in any Supabase project (unlike the
  -- projects.user_id assumption above, this is not specific to this app's
  -- own schema).
  owner_id uuid not null references auth.users(id) on delete cascade,

  target text not null,
  status text not null default 'queued',

  config_snapshot jsonb not null,
  config_schema_version integer not null,
  config_hash text not null,
  request_key text not null,

  -- Feature 15.2 — a retry is a new row, never a mutation of the old one;
  -- this self-reference is purely a historical breadcrumb ("this job is a
  -- retry attempt of that earlier one"), not a workflow mechanism.
  retried_from_job_id uuid references build_jobs(id),

  failure_code text,
  failure_message text,

  started_at timestamptz,
  finished_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint build_jobs_target_check
    check (target in ('android', 'desktop')),

  constraint build_jobs_status_check
    check (status in ('queued', 'building', 'succeeded', 'failed')),

  constraint build_jobs_config_schema_version_positive
    check (config_schema_version > 0),

  constraint build_jobs_config_hash_not_empty
    check (length(trim(config_hash)) > 0),

  constraint build_jobs_request_key_not_empty
    check (length(trim(request_key)) > 0),

  -- Feature 15.2 — idempotency guard #2 (see build_jobs_active_target_unique
  -- below for guard #1): a client-generated key deduplicates a request that
  -- was retried at the network layer (e.g. a timed-out fetch silently
  -- retried by the browser) even after the original request already fully
  -- resolved, which the "active job" check alone would no longer catch.
  constraint build_jobs_project_request_key_unique
    unique (project_id, request_key),

  -- Feature 15.2 — status/timestamp consistency, kept intentionally simple
  -- (no full workflow engine in SQL, per the approved plan):
  --   - a queued job has not started or finished yet.
  --   - a terminal job (succeeded/failed) must record when it finished.
  --   - failure_code/failure_message are only meaningful on a failed job.
  constraint build_jobs_queued_has_no_timestamps
    check (status <> 'queued' or (started_at is null and finished_at is null)),

  constraint build_jobs_terminal_has_finished_at
    check (status not in ('succeeded', 'failed') or finished_at is not null),

  constraint build_jobs_failure_fields_only_on_failed
    check (status = 'failed' or (failure_code is null and failure_message is null))
);

-- Feature 15.2 — idempotency guard #1: at most one active (queued or
-- building) job per project+target at a time. This is a partial unique
-- index, not a plain unique constraint, specifically so multiple *terminal*
-- rows (past succeeded/failed builds, and retries) for the same
-- project+target can coexist freely — only concurrent in-flight requests
-- are prevented. Enforced at the database level (not just in application
-- code) so this holds even under concurrent requests racing each other.
create unique index if not exists build_jobs_active_target_unique
  on build_jobs (project_id, target)
  where status in ('queued', 'building');

create index if not exists build_jobs_owner_created_idx
  on build_jobs (owner_id, created_at desc);

create index if not exists build_jobs_project_created_idx
  on build_jobs (project_id, created_at desc);

create index if not exists build_jobs_project_target_status_idx
  on build_jobs (project_id, target, status);

create index if not exists build_jobs_config_hash_idx
  on build_jobs (config_hash);

create index if not exists build_jobs_retried_from_idx
  on build_jobs (retried_from_job_id);

-- Feature 15.2 — a narrowly named trigger function scoped to build_jobs
-- only. No existing updated_at trigger/function was found anywhere in this
-- repository (no other migrations exist to inspect), so this is created
-- fresh rather than assumed to already exist.
create or replace function set_build_jobs_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger build_jobs_set_updated_at
  before update on build_jobs
  for each row
  execute function set_build_jobs_updated_at();

alter table build_jobs enable row level security;

-- Authenticated owners can read only their own build jobs.
create policy build_jobs_select_own
  on build_jobs
  for select
  using (owner_id = auth.uid());

-- Feature 15.2 — see the CONFIRMATION NEEDED note at the top of this file.
-- This policy lets an authenticated user create a queued build job for
-- themselves only when they also own the referenced project. If
-- `projects.user_id` is not the real ownership column, this policy will
-- either fail to compile or (worse) silently allow/deny the wrong rows —
-- confirm before applying.
create policy build_jobs_insert_own
  on build_jobs
  for insert
  with check (
    owner_id = auth.uid()
    and exists (
      select 1
      from projects
      where projects.id = build_jobs.project_id
        and projects.user_id = auth.uid()
    )
  );

-- Feature 15.2 — deliberately no update or delete policy for ordinary
-- authenticated users. Postgres RLS denies by default when no policy
-- grants an operation, so status transitions, failure fields, the
-- snapshot/hash, and timestamps can never be written by a normal browser
-- session — only by a future trusted worker using a service-role
-- credential, which bypasses RLS entirely by Supabase's design. No
-- service-role secret is introduced by this migration or anywhere in this
-- repository; that credential belongs solely in the future worker's own
-- execution environment. Deletion by ordinary users is also not permitted
-- yet — out of scope for this feature.

-- ----------------------------------------------------------------------------
-- build_artifacts
--
-- Zero-to-many files produced by a single build job (an APK, an installer,
-- a log, etc.). Kept separate from build_jobs so one job can have multiple
-- artifacts without repeated/array columns on the job row.
-- ----------------------------------------------------------------------------
create table if not exists build_artifacts (
  id uuid primary key default gen_random_uuid(),
  build_job_id uuid not null references build_jobs(id) on delete cascade,

  artifact_type text not null,
  storage_path text not null,
  original_filename text not null,
  mime_type text not null,
  file_size_bytes bigint,
  checksum text,
  expires_at timestamptz,

  created_at timestamptz not null default now(),

  constraint build_artifacts_type_check
    check (artifact_type in ('apk', 'desktop_installer', 'zip', 'json_config', 'log')),

  constraint build_artifacts_file_size_non_negative
    check (file_size_bytes is null or file_size_bytes >= 0)

  -- Feature 15.2 — deliberately no public URL, signing credential, worker
  -- secret, or raw auth information anywhere on this table. storage_path is
  -- a bucket-relative path, never a baked-in public URL; a real download
  -- link is generated on demand (signed/time-limited) by future code that
  -- isn't part of this feature.
);

create index if not exists build_artifacts_build_job_idx
  on build_artifacts (build_job_id);

create index if not exists build_artifacts_expires_at_idx
  on build_artifacts (expires_at)
  where expires_at is not null;

alter table build_artifacts enable row level security;

-- Authenticated owners can read only artifacts belonging to their own build
-- jobs (transitively their own projects).
create policy build_artifacts_select_own
  on build_artifacts
  for select
  using (
    exists (
      select 1
      from build_jobs
      where build_jobs.id = build_artifacts.build_job_id
        and build_jobs.owner_id = auth.uid()
    )
  );

-- Feature 15.2 — no insert/update/delete policy for ordinary authenticated
-- users; denied by default. Artifact rows are only ever written by the
-- future trusted worker via a service-role credential, never from the
-- browser.
