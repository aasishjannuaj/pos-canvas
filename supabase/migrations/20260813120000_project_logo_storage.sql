-- Feature 19 — Logo & Basic Branding: the project-logos storage bucket.
--
-- This is a NEW migration; it edits no already-applied file. Like every other
-- migration in this directory it is NOT applied automatically — review, then
-- apply manually, when ready.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS BUCKET HOLDS, AND WHY IT IS PUBLIC
-- ----------------------------------------------------------------------------
-- Business logos, rendered in the POS header on three surfaces: the Builder
-- preview, the owner runtime, and a paired device.
--
-- The device is the reason this bucket is public where build-artifacts is
-- private. A paired till authenticates as an anonymous Supabase user that, by
-- the deliberate deny-by-default posture of the 20260729190422 migration, has
-- no storage access whatsoever. It cannot sign a URL, and it reaches Supabase
-- through direct RPC rather than through a server route that could sign one for
-- it. A private bucket would therefore require a new authenticated media route
-- plus server-side verification of the device JWT — substantial machinery to
-- protect an asset that is, by definition, printed on a customer-facing screen.
--
-- Public READ is the whole of the concession. Writes remain impossible for
-- every browser role (see the policy section below).
--
-- ----------------------------------------------------------------------------
-- WHY OBJECTS ARE NEVER OVERWRITTEN
-- ----------------------------------------------------------------------------
-- Object names are content-addressed: {projectId}/{sha256-of-bytes}.{ext}. A
-- build snapshot (build_jobs.config_snapshot, immutable by the D4b trigger)
-- freezes the PATH, so the name and the bytes are bound together permanently.
--
-- That is what makes an old pinned build safe. When an owner replaces their
-- logo, the new bytes hash differently and land at a DIFFERENT path; the old
-- object is neither overwritten nor deleted, so a device pinned to an older
-- build keeps resolving the exact image it was built with. A mutable path such
-- as {projectId}/logo.png would silently rewrite the branding of every
-- historical build the moment an owner uploaded a replacement.
--
-- The application uploads with upsert:false and treats an
-- already-exists collision as successful reuse, which is correct precisely
-- because an identical path can only mean identical bytes.

-- ----------------------------------------------------------------------------
-- Bucket — public read, idempotent, self-correcting.
-- ----------------------------------------------------------------------------

-- Following the 20260729190422 convention exactly: `do update` rather than
-- `do nothing`, so re-applying this migration corrects a bucket that was
-- created out-of-band (e.g. via the Supabase dashboard) with the wrong
-- settings, instead of only enforcing them on first creation.
--
-- file_size_limit and allowed_mime_types are storage-side enforcement of the
-- same two rules lib/logoUpload.ts applies in the application. They are a
-- backstop, not the primary check: the server action already rejects an
-- oversized or wrong-typed file, and additionally verifies MAGIC BYTES and
-- pixel dimensions, neither of which the bucket can see.
--
-- 524288 bytes = 512 KB, matching MAX_LOGO_BYTES.
--
-- image/svg+xml is deliberately absent from allowed_mime_types. SVG is
-- executable content and this application serves no Content-Security-Policy, so
-- hosting owner-supplied SVG on a public origin would be a stored-XSS vector.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'project-logos',
  'project-logos',
  true,
  524288,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
set
  name = excluded.name,
  public = true,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ----------------------------------------------------------------------------
-- Policies — deliberately NONE.
-- ----------------------------------------------------------------------------
-- No storage.objects policy is created here for anon or authenticated, in
-- either direction:
--
--   READ  — a public bucket is served by Storage's public object route without
--           consulting storage.objects RLS at all, so no SELECT policy is
--           needed to make logos load. Adding one would grant listing and
--           metadata access this feature does not require.
--
--   WRITE — storage.objects has row-level security enabled by default in a
--           Supabase project. With no INSERT, UPDATE or DELETE policy naming
--           this bucket, Postgres's own deny-by-default behaviour means anon
--           and authenticated browser roles cannot create, overwrite or remove
--           an object here. That is not something this migration actively
--           forbids; it is the consequence of granting nothing.
--
-- Every write goes through lib/logoUpload.server.ts using the service-role
-- credential, which bypasses RLS by Supabase's own design, and only after
-- lib/logoUpload.actions.ts has independently authenticated the caller and
-- verified they own the target project. The object path is derived server-side
-- from that validated project id, so a browser cannot choose where its bytes
-- land even though it triggers the upload.
--
-- A public bucket makes objects world-READABLE by URL. It does not make them
-- world-writable, and nothing below grants that. As with 20260729190422,
-- manually confirm that no unrelated pre-existing policy on this project
-- already grants anon/authenticated broader storage.objects access than
-- intended — a migration cannot detect or override a permissive policy it does
-- not itself create.

-- ----------------------------------------------------------------------------
-- Verification — fails loudly rather than leaving a half-configured bucket.
-- ----------------------------------------------------------------------------
do $$
declare
  v_bucket record;
  v_write_policies integer;
begin
  select id, public, file_size_limit, allowed_mime_types
  into v_bucket
  from storage.buckets
  where id = 'project-logos';

  if not found then
    raise exception 'project-logos bucket was not created';
  end if;

  if v_bucket.public is distinct from true then
    raise exception 'project-logos must be public for device logo rendering';
  end if;

  if v_bucket.file_size_limit is distinct from 524288 then
    raise exception 'project-logos file_size_limit must be 524288 bytes (512 KB)';
  end if;

  if v_bucket.allowed_mime_types is distinct from
     array['image/png', 'image/jpeg', 'image/webp'] then
    raise exception 'project-logos allowed_mime_types must be png, jpeg and webp only';
  end if;

  -- The invariant that matters most: no browser role may write here. Counted
  -- rather than assumed, so a permissive policy added out-of-band fails this
  -- migration instead of silently surviving it.
  select count(*)
  into v_write_policies
  from pg_policies
  where schemaname = 'storage'
    and tablename = 'objects'
    and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    and qual || ' ' || coalesce(with_check, '') like '%project-logos%';

  if v_write_policies > 0 then
    raise exception
      'project-logos has % browser-facing write polic(ies); uploads must be service-role only',
      v_write_policies;
  end if;
end $$;
