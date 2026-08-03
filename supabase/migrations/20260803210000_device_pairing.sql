-- Feature 16.3, Migration B — secure device pairing.
--
-- ADDITIVE ONLY. This migration creates two new tables, their RLS, and six
-- trusted functions. It deliberately does NOT touch complete_sale,
-- restock_inventory, adjust_inventory, or any existing operational-table
-- policy or grant. Amending complete_sale for device authorization is
-- Migration C; privilege hardening is Migration D.
--
-- GOAL: a paired device receives access to exactly one project and one
-- succeeded build job, and never receives the owner's password, the owner's
-- refresh token, the service-role key, or any other server secret. Its only
-- credential is an ordinary Supabase anonymous Auth session that has been
-- bound to a paired_devices row by redeeming a single-use code.
--
-- TRUST MODEL:
--   * Devices get NO direct write privilege on any operational table. In
--     particular they get no UPDATE on projects, because projects.config
--     holds the menu and prices as well as stock, and RLS cannot restrict
--     which JSONB keys an UPDATE touches.
--   * Every device-facing operation goes through a SECURITY DEFINER function
--     with a locked search_path that performs its own explicit checks.
--   * Ownership is never inferred from a client-supplied project id.
--
-- This migration is NOT applied automatically -- review, then apply manually.

-- HASHING DEPENDENCY: this migration deliberately uses only CORE PostgreSQL
-- functions for hashing -- sha256(bytea) (core since PG11) over
-- convert_to(text,'UTF8') (core) -- and NOT pgcrypto's digest().
--
-- Why that matters: every function below locks search_path to
-- "public, pg_temp", but Supabase installs pgcrypto into the "extensions"
-- schema. An unqualified digest() call would therefore NOT resolve at runtime
-- and redemption would fail with "function digest(text, unknown) does not
-- exist". Using core sha256() removes the dependency entirely rather than
-- widening the locked search_path.
--
-- gen_random_uuid() is likewise core since PG13. pgcrypto is still declared
-- here (idempotently, matching the earlier migrations) only so an empty
-- database applying this chain standalone matches production's extension set.
create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- device_pairing_tokens
--
-- Short-lived, single-use codes an owner generates to pair one device.
-- The plaintext code is NEVER stored: only its SHA-256 digest, so a database
-- leak cannot be replayed into a pairing.
-- ----------------------------------------------------------------------------
create table if not exists public.device_pairing_tokens (
  id uuid primary key default gen_random_uuid(),

  -- Owner and scope. All three are derived server-side at creation time from
  -- the authenticated owner; none is ever accepted from a device.
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  build_job_id uuid not null references public.build_jobs(id) on delete cascade,

  -- SHA-256 of the normalized code. 32 bytes, enforced below.
  token_hash bytea not null,

  expires_at timestamptz not null,

  -- Single-use. Set together with consumed_by_device_id on redemption, or
  -- consumed_at alone when an owner cancels the token.
  consumed_at timestamptz,
  consumed_by_device_id uuid,

  -- Failed-redemption counter for a code that resolved to THIS token but was
  -- otherwise unusable. It does NOT limit brute-force guessing -- a wrong code
  -- matches no row at all. See the extended note in
  -- redeem_device_pairing_token.
  attempt_count integer not null default 0,

  created_at timestamptz not null default now(),

  constraint device_pairing_tokens_hash_length_check
    check (octet_length(token_hash) = 32),
  constraint device_pairing_tokens_attempt_count_check
    check (attempt_count >= 0 and attempt_count <= 5),
  constraint device_pairing_tokens_expiry_after_creation_check
    check (expires_at > created_at),
  -- A token consumed by a redemption always records the device it created.
  -- An owner-cancelled token sets consumed_at with no device, so this is a
  -- one-way implication rather than a biconditional.
  constraint device_pairing_tokens_consumed_state_check
    check (consumed_by_device_id is null or consumed_at is not null)
);

-- Unique so a hash collision (or a repeated generated code) can never produce
-- two live tokens, and so redemption lookup is an index probe.
create unique index if not exists device_pairing_tokens_token_hash_key
  on public.device_pairing_tokens using btree (token_hash);

create index if not exists device_pairing_tokens_owner_created_idx
  on public.device_pairing_tokens using btree (owner_id, created_at desc);

create index if not exists device_pairing_tokens_project_idx
  on public.device_pairing_tokens using btree (project_id);

-- Supports expiry cleanup of still-unconsumed tokens.
create index if not exists device_pairing_tokens_unconsumed_expiry_idx
  on public.device_pairing_tokens using btree (expires_at)
  where consumed_at is null;

-- ----------------------------------------------------------------------------
-- paired_devices
--
-- One row per paired device. auth_user_id is UNIQUE, so one anonymous Auth
-- identity maps to exactly one device -- which is what makes redemption
-- retries idempotent after a crash, and what lets revocation be decisive.
-- ----------------------------------------------------------------------------
create table if not exists public.paired_devices (
  id uuid primary key default gen_random_uuid(),

  -- The device's own Supabase Auth user (anonymous). Unique: one device per
  -- identity. ON DELETE CASCADE because a pairing without its identity can
  -- never authorize anything again.
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,

  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,

  -- The pinned immutable build. ON DELETE CASCADE keeps project deletion from
  -- deadlocking against a RESTRICT here; build_jobs has no browser DELETE
  -- policy at all (only SELECT), so in practice only service_role could ever
  -- delete one.
  build_job_id uuid not null references public.build_jobs(id) on delete cascade,

  device_name text,
  platform text,

  created_at timestamptz not null default now(),
  last_seen_at timestamptz,

  -- Revocation is a state change, never a delete: device history is retained.
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,

  constraint paired_devices_device_name_check
    check (device_name is null or btrim(device_name) <> ''),
  constraint paired_devices_platform_check
    check (platform is null or btrim(platform) <> ''),
  -- revoked_by may be null even when revoked (e.g. a future automated
  -- revocation), but it can never be set without a revocation timestamp.
  constraint paired_devices_revocation_state_check
    check (revoked_by is null or revoked_at is not null)
);

create index if not exists paired_devices_owner_created_idx
  on public.paired_devices using btree (owner_id, created_at desc);

create index if not exists paired_devices_project_idx
  on public.paired_devices using btree (project_id);

create index if not exists paired_devices_build_job_idx
  on public.paired_devices using btree (build_job_id);

-- The hot path: resolve an active device for the calling auth user.
create index if not exists paired_devices_active_project_idx
  on public.paired_devices using btree (project_id)
  where revoked_at is null;

-- Late-bound FK so device_pairing_tokens can reference paired_devices without
-- forcing a creation order between the two tables. SET NULL preserves the
-- token's audit row even if a device row is ever removed.
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'device_pairing_tokens_consumed_by_device_id_fkey') then
    alter table public.device_pairing_tokens
      add constraint device_pairing_tokens_consumed_by_device_id_fkey
      foreign key (consumed_by_device_id)
      references public.paired_devices(id) on delete set null;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- Row level security
--
-- Grants are explicit and narrow -- deliberately not GRANT ALL. Neither table
-- is granted to anon at all: an unauthenticated caller has no access whatever,
-- and an authenticated-but-unpaired caller sees zero rows.
-- ----------------------------------------------------------------------------
alter table public.device_pairing_tokens enable row level security;
alter table public.paired_devices enable row level security;

-- Owners may READ their own tokens (to show pairing state and expiry) and
-- nothing else. They have no INSERT, no UPDATE, and no DELETE.
--
-- A column-level UPDATE(consumed_at) grant was considered and REJECTED: a
-- column privilege constrains which column may be written, not which state
-- transition is legal, so an owner could have set consumed_at back to NULL and
-- revived a cancelled token, or stamped an arbitrary timestamp. Cancellation
-- is therefore a state machine enforced inside cancel_device_pairing_token,
-- which is the only path that may ever write this table from a browser
-- session.
-- DETERMINISTIC PRIVILEGE RESET -- revoke first, then grant.
--
-- Supabase applies ALTER DEFAULT PRIVILEGES on the public schema, so a table
-- created here is born with ALL privileges already granted to anon,
-- authenticated and service_role. Granting alone therefore ADDS to that
-- inherited set instead of defining it: without these revokes, anon silently
-- keeps INSERT/UPDATE/DELETE/TRUNCATE on a pairing table. RLS would still deny
-- anon every row, but TRUNCATE is not subject to RLS at all, so this is a real
-- privilege, not a theoretical one.
--
-- Revoking from PUBLIC as well as the named roles matters because a PUBLIC
-- grant would apply to every current and future role.
--
-- This ordering also makes a clean rebuild deterministic: create (defaults
-- applied) -> revoke everything -> grant exactly the intended set -> verify.
revoke all privileges on table public.device_pairing_tokens from public;
revoke all privileges on table public.device_pairing_tokens from anon;
revoke all privileges on table public.device_pairing_tokens from authenticated;
revoke all privileges on table public.device_pairing_tokens from service_role;

grant select on table public.device_pairing_tokens to authenticated;

-- service_role gets the MINIMUM a concrete workflow needs, not ALL. The one
-- planned server-side job is expired-token cleanup, which needs to find rows
-- (SELECT) and remove them (DELETE). It has no reason to INSERT (creation is
-- the owner's RPC), UPDATE (cancellation and redemption are RPC state
-- machines), or TRUNCATE. An earlier draft granted ALL for symmetry; that was
-- wrong, and TRUNCATE in particular is not restricted by RLS.
grant select, delete on table public.device_pairing_tokens to service_role;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='device_pairing_tokens'
                 and policyname='Owners can view their own pairing tokens') then
    create policy "Owners can view their own pairing tokens"
      on public.device_pairing_tokens
      for select to authenticated
      using (owner_id = (select auth.uid()));
  end if;

end $$;

-- Devices never touch this table directly: redemption happens exclusively
-- inside redeem_device_pairing_token (SECURITY DEFINER), which bypasses RLS.
-- There is deliberately no policy granting any device read access to token
-- rows or hashes.

-- Same deterministic reset as above; see that comment for why the revokes are
-- required rather than optional.
revoke all privileges on table public.paired_devices from public;
revoke all privileges on table public.paired_devices from anon;
revoke all privileges on table public.paired_devices from authenticated;
revoke all privileges on table public.paired_devices from service_role;

grant select on table public.paired_devices to authenticated;

-- Read-only for service_role: there is no server-side workflow that writes
-- paired_devices today. Revocation is an owner RPC, and pairing is a device
-- RPC. If an admin/support revocation workflow is ever built it should get
-- UPDATE explicitly at that point.
grant select on table public.paired_devices to service_role;

do $$
begin
  -- Owners see every device paired to a project they own.
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='paired_devices'
                 and policyname='Owners can view devices for their projects') then
    create policy "Owners can view devices for their projects"
      on public.paired_devices
      for select to authenticated
      using (owner_id = (select auth.uid()));
  end if;

  -- A device sees ONLY its own row -- active or revoked, so it can detect
  -- revocation. It cannot enumerate sibling devices, because the predicate is
  -- its own auth_user_id rather than the project.
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='paired_devices'
                 and policyname='Devices can view their own pairing row') then
    create policy "Devices can view their own pairing row"
      on public.paired_devices
      for select to authenticated
      using (auth_user_id = (select auth.uid()));
  end if;
end $$;

-- No INSERT/UPDATE/DELETE policy exists on paired_devices for authenticated:
-- pairing and revocation happen only through the trusted functions below.

-- ----------------------------------------------------------------------------
-- resolve_sale_owner
--
-- Answers "on whose behalf may auth.uid() transact against p_project_id?" and
-- returns that owner's user id.
--
-- CREATED BUT NOT YET WIRED IN: complete_sale is deliberately untouched by
-- this migration and does not call this function. Migration C adopts it.
-- ----------------------------------------------------------------------------
create or replace function public.resolve_sale_owner(p_project_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller uuid;
  v_owner uuid;
begin
  v_caller := auth.uid();

  if v_caller is null then
    raise exception 'Authentication required';
  end if;

  if p_project_id is null then
    raise exception 'Project id is required';
  end if;

  -- 1. The owner path. Authoritative and checked first, so an owner is never
  -- dependent on a paired_devices row.
  select p.user_id into v_owner
  from public.projects p
  where p.id = p_project_id
    and p.user_id = v_caller;

  if found then
    return v_owner;
  end if;

  -- 2. The device path. The project is taken from the pairing row, never from
  -- the caller: p_project_id is only ever a value to MATCH against, which is
  -- what prevents a paired device from transacting on any other project.
  select d.owner_id into v_owner
  from public.paired_devices d
  where d.auth_user_id = v_caller
    and d.project_id = p_project_id
    and d.revoked_at is null;

  if found then
    return v_owner;
  end if;

  -- Deliberately identical for "no such project", "not yours", "not paired",
  -- "paired elsewhere" and "revoked", so this cannot be used to probe which
  -- projects exist.
  raise exception 'Project not found or access denied';
end;
$function$;

revoke all on function public.resolve_sale_owner(uuid) from public;
revoke all on function public.resolve_sale_owner(uuid) from anon;
grant execute on function public.resolve_sale_owner(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- create_device_pairing_token
--
-- Records a pairing token. The PLAINTEXT CODE IS NEVER PASSED IN: the caller
-- generates it and supplies only its SHA-256 digest. Keeping generation in the
-- application means the plaintext never crosses the Postgres wire protocol and
-- so can never surface in query logs or pg_stat_statements.
--
-- TRUST BOUNDARY: the owner is derived from auth.uid() INSIDE this function and
-- is never accepted as a parameter. An earlier design took p_owner_id and was
-- callable only by service_role; it was rejected because a service-role
-- function that trusts a caller-supplied owner id makes the Server Action's
-- correctness load-bearing for tenancy. Deriving the owner here means a bug in
-- the caller cannot mint a token for someone else's project, and lets this be
-- called with the ordinary authenticated client -- so device pairing needs no
-- service-role credential at all.
--
-- Every project/build/artifact relationship is verified here independently,
-- regardless of any check the caller may already have performed.
--
-- EXPIRY IS FIXED at 10 minutes and is not a parameter. A caller-supplied TTL
-- was removed: there is no current need for a variable lifetime, and accepting
-- one would let an ordinary authenticated owner mint a longer-lived code than
-- the approved policy. Reintroduce it only with an explicit clamp if a real
-- requirement appears.
-- ----------------------------------------------------------------------------
create or replace function public.create_device_pairing_token(
  p_project_id uuid,
  p_build_job_id uuid,
  p_token_hash bytea
)
returns table (id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id uuid;
  v_project_owner uuid;
  v_job record;
begin
  v_owner_id := auth.uid();

  if v_owner_id is null then
    raise exception 'Authentication required';
  end if;

  if p_project_id is null or p_build_job_id is null then
    raise exception 'Project and build job are required';
  end if;

  if p_token_hash is null or octet_length(p_token_hash) <> 32 then
    raise exception 'A 32-byte token hash is required';
  end if;

  -- The project must belong to the stated owner.
  select p.user_id into v_project_owner
  from public.projects p
  where p.id = p_project_id;

  if not found or v_project_owner is distinct from v_owner_id then
    raise exception 'Project not found or access denied';
  end if;

  -- The build job must belong to the same project AND owner, and must have
  -- succeeded -- a device may only ever be pinned to an approved build.
  select b.id, b.status, b.owner_id, b.project_id into v_job
  from public.build_jobs b
  where b.id = p_build_job_id;

  if not found
     or v_job.project_id is distinct from p_project_id
     or v_job.owner_id is distinct from v_owner_id then
    raise exception 'Build job not found or access denied';
  end if;

  if v_job.status <> 'succeeded' then
    raise exception 'Build job has not succeeded';
  end if;

  -- A verified immutable configuration artifact must exist, otherwise a paired
  -- device would have nothing to load.
  if not exists (
    select 1 from public.build_artifacts a
    where a.build_job_id = p_build_job_id
      and a.artifact_type = 'json_config'
  ) then
    raise exception 'Build job has no configuration artifact';
  end if;

  return query
  insert into public.device_pairing_tokens (
    owner_id, project_id, build_job_id, token_hash, expires_at
  )
  values (
    v_owner_id, p_project_id, p_build_job_id, p_token_hash,
    now() + interval '10 minutes' 
  )
  returning device_pairing_tokens.id, device_pairing_tokens.expires_at;
end;
$function$;

revoke all on function public.create_device_pairing_token(uuid, uuid, bytea) from public;
revoke all on function public.create_device_pairing_token(uuid, uuid, bytea) from anon;
grant execute on function public.create_device_pairing_token(uuid, uuid, bytea) to authenticated;

-- ----------------------------------------------------------------------------
-- cancel_device_pairing_token
--
-- The ONLY path by which a browser session may write device_pairing_tokens.
-- Owners hold SELECT and nothing else, precisely so cancellation is a state
-- machine rather than a column write:
--
--   unconsumed          -> cancelled        (consumed_at = now())
--   cancelled           -> cancelled        (idempotent, timestamp preserved)
--   redeemed by device  -> REFUSED          (never rewritten)
--
-- A cancelled token can never be revived, because the only write this function
-- performs sets consumed_at from NULL to now(); there is no code path anywhere
-- that sets consumed_at back to NULL. There is no DELETE path either.
-- ----------------------------------------------------------------------------
create or replace function public.cancel_device_pairing_token(p_token_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller uuid;
  v_token record;
begin
  v_caller := auth.uid();

  if v_caller is null then
    raise exception 'Authentication required';
  end if;

  if p_token_id is null then
    raise exception 'Token id is required';
  end if;

  -- Ownership is verified against the token's PROJECT, not just its owner_id
  -- column, so a token whose project has since changed hands cannot be
  -- cancelled by a stale owner reference.
  select t.* into v_token
  from public.device_pairing_tokens t
  join public.projects p on p.id = t.project_id
  where t.id = p_token_id
    and t.owner_id = v_caller
    and p.user_id = v_caller
  for update of t;

  -- A token belonging to another owner is reported exactly like one that does
  -- not exist.
  if not found then
    raise exception 'Pairing token not found or access denied';
  end if;

  -- A token already redeemed by a device is immutable: cancelling it would
  -- imply the pairing could be undone here, which it cannot -- revoking the
  -- resulting device is the correct action.
  if v_token.consumed_by_device_id is not null then
    return jsonb_build_object(
      'ok', false, 'error', 'already_redeemed', 'token_id', v_token.id
    );
  end if;

  -- Idempotent: re-cancelling preserves the original timestamp.
  if v_token.consumed_at is not null then
    return jsonb_build_object(
      'ok', true, 'token_id', v_token.id,
      'cancelled_at', v_token.consumed_at, 'already_cancelled', true
    );
  end if;

  update public.device_pairing_tokens
  set consumed_at = now()
  where id = p_token_id
    and consumed_at is null
    and consumed_by_device_id is null
  returning * into v_token;

  -- Lost a race with a concurrent redemption between the lock and the write.
  if not found then
    return jsonb_build_object(
      'ok', false, 'error', 'already_redeemed', 'token_id', p_token_id
    );
  end if;

  return jsonb_build_object(
    'ok', true, 'token_id', v_token.id,
    'cancelled_at', v_token.consumed_at, 'already_cancelled', false
  );
end;
$function$;

revoke all on function public.cancel_device_pairing_token(uuid) from public;
revoke all on function public.cancel_device_pairing_token(uuid) from anon;
grant execute on function public.cancel_device_pairing_token(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- redeem_device_pairing_token
--
-- Called by the DEVICE, signed in anonymously, with the code the owner read to
-- it. Returns jsonb rather than raising for expected failures, deliberately:
-- a RAISE would roll back the attempt_count increment that records a failed
-- try. Programming-level problems still raise.
--
-- NORMALIZATION must match the application's generator exactly. Both sides
-- strip non-alphanumerics, uppercase, then fold the Crockford-ambiguous
-- characters I and L to 1 and O to 0. Verified cross-language vector:
--   'ABCD-1234' / 'abcd1234' / 'ABCD 1234'
--     -> 'ABCD1234'
--     -> sha256 1635c8525afbae58c37bede3c9440844e9143727cc7c160bed665ec378d8a262
--
-- ON BRUTE FORCE -- READ THIS BEFORE RELYING ON attempt_count:
--
-- attempt_count DOES NOT limit guessing. An arbitrary wrong code hashes to a
-- value matching no row, so there is no row to increment and the counter never
-- moves. This design therefore enforces NO five-attempt limit against
-- brute-force guessing, and must not be described as though it does.
--
-- What attempt_count actually protects: repeated failed redemptions of a code
-- that DOES resolve to a real token -- i.e. someone already holds a valid code
-- but the token is expired, already consumed, or its project/build has become
-- invalid. After 5 such attempts that specific token is locked out. That is a
-- narrow replay backstop, not anti-guessing.
--
-- What actually defends against guessing, and is relied upon deliberately:
--   * 8 Crockford Base32 characters = 32^8 = 2^40 (~1.1e12) possibilities
--   * a 10-minute expiry window
--   * single use
--   * Supabase Auth/platform request rate limits
-- Arbitrary-wrong-code rate limiting is explicitly deferred; see the Feature
-- 16.3 report for the accepted risk and the recommended follow-up.
-- ----------------------------------------------------------------------------
create or replace function public.redeem_device_pairing_token(
  p_code text,
  p_device_name text default null,
  p_platform text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller uuid;
  v_is_anonymous boolean;
  v_normalized text;
  v_hash bytea;
  v_token record;
  v_existing record;
  v_device_id uuid;
  v_job record;
begin
  v_caller := auth.uid();

  if v_caller is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  -- Anonymous-only, fail closed. `is_anonymous` is an optional JWT claim, so a
  -- missing claim is treated as NOT anonymous and rejected. If a deployment
  -- ever needs to relax this, change only this block -- security still rests
  -- on possession of the single-use code, not on account type.
  v_is_anonymous := coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false);

  if not v_is_anonymous then
    return jsonb_build_object('ok', false, 'error', 'not_anonymous');
  end if;

  v_normalized := translate(
    upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g')),
    'ILO', '110'
  );

  if length(v_normalized) <> 8 then
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  -- Core sha256 over the UTF-8 bytes; see the hashing-dependency note above.
  v_hash := sha256(convert_to(v_normalized, 'UTF8'));

  -- ALREADY-PAIRED RESOLUTION HAPPENS BEFORE ANY TOKEN LOOKUP, deliberately.
  --
  -- An earlier ordering returned 'already_paired' only after the token had
  -- been found and checked, which made it an ORACLE: a caller who was already
  -- paired could distinguish "this code is real and live" (already_paired)
  -- from "this code does not exist" (invalid_code), turning a legitimate
  -- client-state error into a validity probe. Resolving it first removes that
  -- signal entirely -- an already-paired caller learns nothing about any code
  -- except the one that created its own device.
  --
  -- The idempotent-retry path lives here too, because it is exactly the case
  -- "I am already paired AND this is the code that paired me" (the app
  -- crashed before storing local state). It is matched by comparing hashes on
  -- the caller's OWN token, never by searching the table for the submitted
  -- hash, so it leaks nothing either. No attempt_count is touched on this
  -- path: an idempotent retry is not a failed attempt.
  select d.* into v_existing
  from public.paired_devices d
  where d.auth_user_id = v_caller;

  if found then
    if exists (
      select 1 from public.device_pairing_tokens t
      where t.consumed_by_device_id = v_existing.id
        and t.token_hash = v_hash
    ) then
      return jsonb_build_object(
        'ok', true,
        'device_id', v_existing.id,
        'project_id', v_existing.project_id,
        'build_job_id', v_existing.build_job_id,
        'already_paired', true
      );
    end if;

    return jsonb_build_object('ok', false, 'error', 'already_paired');
  end if;

  -- Lock the candidate token for the rest of this transaction so two devices
  -- racing on the same code serialize here; the loser re-reads the row after
  -- the winner commits, sees consumed_at set, and fails.
  select * into v_token
  from public.device_pairing_tokens t
  where t.token_hash = v_hash
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  -- Every remaining failure below reports the SAME generic error, so a caller
  -- cannot distinguish "wrong code" from "expired", "cancelled", "already
  -- used" or "locked". Each increments attempt_count, which persists because
  -- this RETURNS rather than raises -- a RAISE would roll the increment back.
  --
  -- The cap is checked before incrementing and the increment itself is
  -- least(attempt_count + 1, 5), so the value can never exceed the
  -- attempt_count <= 5 constraint.
  if v_token.attempt_count >= 5 then
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  -- consumed_at covers BOTH an owner cancellation and a completed redemption;
  -- neither consumed_at nor consumed_by_device_id is ever rewritten here, so
  -- cancellation and redemption audit state is preserved exactly.
  if v_token.consumed_at is not null or v_token.expires_at <= now() then
    update public.device_pairing_tokens
    set attempt_count = least(attempt_count + 1, 5)
    where id = v_token.id;

    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  -- Re-verify the scope at redemption time: the project, the build and its
  -- artifact must all still be valid. A build that was deleted or a project
  -- that vanished between token creation and redemption must not pair.
  if not exists (select 1 from public.projects p where p.id = v_token.project_id) then
    update public.device_pairing_tokens
    set attempt_count = least(attempt_count + 1, 5)
    where id = v_token.id;

    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  select b.status, b.project_id into v_job
  from public.build_jobs b
  where b.id = v_token.build_job_id;

  if not found
     or v_job.status <> 'succeeded'
     or v_job.project_id is distinct from v_token.project_id
     or not exists (
       select 1 from public.build_artifacts a
       where a.build_job_id = v_token.build_job_id
         and a.artifact_type = 'json_config'
     ) then
    update public.device_pairing_tokens
    set attempt_count = least(attempt_count + 1, 5)
    where id = v_token.id;

    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  -- Bind the identity to the project and the pinned build. project_id and
  -- build_job_id come from the TOKEN, never from the device.
  insert into public.paired_devices (
    auth_user_id, owner_id, project_id, build_job_id,
    device_name, platform
  )
  values (
    v_caller, v_token.owner_id, v_token.project_id, v_token.build_job_id,
    nullif(btrim(coalesce(p_device_name, '')), ''),
    nullif(btrim(coalesce(p_platform, '')), '')
  )
  returning id into v_device_id;

  -- Consume exactly once. The FOR UPDATE lock above plus this single write
  -- inside one transaction is what guarantees a token can never create two
  -- devices.
  update public.device_pairing_tokens
  set consumed_at = now(),
      consumed_by_device_id = v_device_id
  where id = v_token.id;

  return jsonb_build_object(
    'ok', true,
    'device_id', v_device_id,
    'project_id', v_token.project_id,
    'build_job_id', v_token.build_job_id,
    'already_paired', false
  );
end;
$function$;

revoke all on function public.redeem_device_pairing_token(text, text, text) from public;
revoke all on function public.redeem_device_pairing_token(text, text, text) from anon;
grant execute on function public.redeem_device_pairing_token(text, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- revoke_paired_device -- owner only, idempotent, never deletes.
-- ----------------------------------------------------------------------------
create or replace function public.revoke_paired_device(p_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller uuid;
  v_device record;
begin
  v_caller := auth.uid();

  if v_caller is null then
    raise exception 'Authentication required';
  end if;

  if p_device_id is null then
    raise exception 'Device id is required';
  end if;

  select d.* into v_device
  from public.paired_devices d
  where d.id = p_device_id
    and d.owner_id = v_caller
  for update;

  -- A device belonging to another owner is reported exactly like a device
  -- that does not exist.
  if not found then
    raise exception 'Device not found or access denied';
  end if;

  -- Idempotent: revoking an already-revoked device is a success, and does not
  -- overwrite the original revocation timestamp.
  if v_device.revoked_at is not null then
    return jsonb_build_object(
      'ok', true, 'device_id', v_device.id,
      'revoked_at', v_device.revoked_at, 'already_revoked', true
    );
  end if;

  update public.paired_devices
  set revoked_at = now(), revoked_by = v_caller
  where id = p_device_id
  returning * into v_device;

  return jsonb_build_object(
    'ok', true, 'device_id', v_device.id,
    'revoked_at', v_device.revoked_at, 'already_revoked', false
  );
end;
$function$;

revoke all on function public.revoke_paired_device(uuid) from public;
revoke all on function public.revoke_paired_device(uuid) from anon;
grant execute on function public.revoke_paired_device(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- get_device_pairing_state -- the device's own sanitized state.
--
-- Deliberately returns revoked devices too, so a revoked device can recognise
-- its state and return to the pairing screen rather than silently failing.
-- Carries no owner identity and no token material.
-- ----------------------------------------------------------------------------
create or replace function public.get_device_pairing_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller uuid;
  v_device record;
begin
  v_caller := auth.uid();

  if v_caller is null then
    return jsonb_build_object('paired', false, 'reason', 'not_authenticated');
  end if;

  select d.* into v_device
  from public.paired_devices d
  where d.auth_user_id = v_caller;

  if not found then
    return jsonb_build_object('paired', false, 'reason', 'not_paired');
  end if;

  return jsonb_build_object(
    'paired', true,
    'device_id', v_device.id,
    'project_id', v_device.project_id,
    'build_job_id', v_device.build_job_id,
    'device_name', v_device.device_name,
    'platform', v_device.platform,
    'created_at', v_device.created_at,
    'revoked_at', v_device.revoked_at,
    'active', (v_device.revoked_at is null)
  );
end;
$function$;

revoke all on function public.get_device_pairing_state() from public;
revoke all on function public.get_device_pairing_state() from anon;
grant execute on function public.get_device_pairing_state() to authenticated;

-- ----------------------------------------------------------------------------
-- get_device_config
--
-- Returns the immutable configuration snapshot from EXACTLY the build the
-- device is pinned to. This is why devices need no direct build_jobs access:
-- RLS on build_jobs would expose the owner's whole build history, and this
-- returns one snapshot and nothing else.
--
-- Deliberately omitted from the result: request_key, config_hash, storage
-- paths, checksums, worker/claim metadata, owner identity, and every other
-- build job.
-- ----------------------------------------------------------------------------
create or replace function public.get_device_config()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller uuid;
  v_device record;
  v_job record;
begin
  v_caller := auth.uid();

  if v_caller is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  select d.* into v_device
  from public.paired_devices d
  where d.auth_user_id = v_caller
    and d.revoked_at is null;

  -- Revocation takes effect here on the very next request: a revoked device
  -- simply stops matching, with no JWT invalidation required.
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_paired');
  end if;

  select b.status, b.project_id, b.config_snapshot, b.config_schema_version
  into v_job
  from public.build_jobs b
  where b.id = v_device.build_job_id;

  if not found
     or v_job.status <> 'succeeded'
     or v_job.project_id is distinct from v_device.project_id then
    return jsonb_build_object('ok', false, 'error', 'config_unavailable');
  end if;

  return jsonb_build_object(
    'ok', true,
    'project_id', v_device.project_id,
    'build_job_id', v_device.build_job_id,
    'config_schema_version', v_job.config_schema_version,
    'config', v_job.config_snapshot
  );
end;
$function$;

revoke all on function public.get_device_config() from public;
revoke all on function public.get_device_config() from anon;
grant execute on function public.get_device_config() to authenticated;

-- ----------------------------------------------------------------------------
-- Verification -- fails loudly rather than leaving a half-built pairing layer.
-- ----------------------------------------------------------------------------
do $$
declare
  v_missing text;
  v_count int;
  v_complete_sale_oid oid;
begin
  select string_agg(t, ', ') into v_missing
  from unnest(array['device_pairing_tokens','paired_devices']) t
  where not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname='public' and c.relname = t and c.relkind = 'r'
  );
  if v_missing is not null then
    raise exception 'Device pairing: missing table(s): %', v_missing;
  end if;

  select string_agg(c.relname, ', ') into v_missing
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname='public'
    and c.relname in ('device_pairing_tokens','paired_devices')
    and c.relrowsecurity is false;
  if v_missing is not null then
    raise exception 'Device pairing: RLS not enabled on: %', v_missing;
  end if;

  select string_agg(f, ', ') into v_missing
  from unnest(array['resolve_sale_owner','create_device_pairing_token',
                    'cancel_device_pairing_token','redeem_device_pairing_token',
                    'revoke_paired_device','get_device_pairing_state',
                    'get_device_config']) f
  where not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname = f
  );
  if v_missing is not null then
    raise exception 'Device pairing: missing function(s): %', v_missing;
  end if;

  -- Every pairing function must be SECURITY DEFINER with a locked search_path.
  select string_agg(p.proname, ', ') into v_missing
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public'
    and p.proname in ('resolve_sale_owner','create_device_pairing_token',
                      'cancel_device_pairing_token','redeem_device_pairing_token',
                      'revoke_paired_device','get_device_pairing_state',
                      'get_device_config')
    and (p.prosecdef is false or p.proconfig is null);
  if v_missing is not null then
    raise exception 'Device pairing: not SECURITY DEFINER or missing search_path: %', v_missing;
  end if;

  -- anon and PUBLIC must hold no privilege on either new table. This runs
  -- AFTER the revoke/grant block above, so it verifies the reset rather than
  -- Supabase's inherited defaults.
  select string_agg(table_name || '/' || grantee || '/' || privilege_type, ', ') into v_missing
  from information_schema.role_table_grants
  where table_schema='public'
    and table_name in ('device_pairing_tokens','paired_devices')
    and grantee in ('anon', 'PUBLIC');
  if v_missing is not null then
    raise exception 'Device pairing: anon/PUBLIC must have no table privileges, found: %', v_missing;
  end if;

  select count(*) into v_count from pg_policies
  where schemaname='public' and tablename='device_pairing_tokens';
  if v_count <> 1 then
    raise exception 'Device pairing: device_pairing_tokens expected 1 policy, found %', v_count;
  end if;

  -- authenticated must hold SELECT and nothing else on BOTH tables: any
  -- INSERT/UPDATE/DELETE/TRUNCATE grant would bypass the RPC state machines
  -- that are the only sanctioned write path.
  select string_agg(table_name || '/' || privilege_type, ', ') into v_missing
  from information_schema.role_table_grants
  where table_schema='public'
    and table_name in ('device_pairing_tokens','paired_devices')
    and grantee='authenticated' and privilege_type <> 'SELECT';
  if v_missing is not null then
    raise exception 'Device pairing: authenticated must hold SELECT only, found: %', v_missing;
  end if;

  -- service_role must hold only the minimum its planned jobs need.
  select string_agg(table_name || '/' || privilege_type, ', ') into v_missing
  from information_schema.role_table_grants
  where table_schema='public'
    and grantee='service_role'
    and (
      (table_name='device_pairing_tokens' and privilege_type not in ('SELECT','DELETE'))
      or (table_name='paired_devices' and privilege_type <> 'SELECT')
    );
  if v_missing is not null then
    raise exception 'Device pairing: service_role holds unintended table privileges: %', v_missing;
  end if;

  select count(*) into v_count from pg_policies
  where schemaname='public' and tablename='paired_devices';
  if v_count <> 2 then
    raise exception 'Device pairing: paired_devices expected 2 policies, found %', v_count;
  end if;

  -- complete_sale POSTURE check.
  --
  -- This deliberately does NOT hash or measure the function body. An earlier
  -- version asserted length(pg_get_functiondef(oid)) = 5903 and failed even
  -- though this migration never touches complete_sale: pg_get_functiondef
  -- REGENERATES its header from catalog metadata rather than replaying stored
  -- text, so the rendered length can shift for formatting-only reasons
  -- (identity-argument spelling, how SET clauses are quoted, a server minor
  -- version changing the deparser) with no change whatever to executable SQL.
  -- A character count is not a body-integrity check, and neither is an md5 of
  -- the same rendered text.
  --
  -- Body integrity is owned where it belongs: the capture migration
  -- (20260803201210) is the source of truth for the body, and this migration
  -- is statically proven to contain no CREATE OR REPLACE / ALTER / DROP /
  -- GRANT / REVOKE touching complete_sale. What IS worth asserting here is the
  -- SECURITY POSTURE this migration must not disturb -- all of it semantic and
  -- formatting-insensitive.
  --
  -- The overload is resolved with to_regprocedure, NOT by comparing
  -- pg_get_function_identity_arguments() to a hand-written string. That
  -- comparison replaced the 5903-byte check and would have been the NEXT false
  -- failure had it been applied -- it was caught by a live diagnostic first.
  -- Identity arguments are rendered WITH PARAMETER NAMES, so the live value is
  --   'p_project_id uuid, p_order_number text, p_payment_method text,
  --    p_subtotal numeric, p_tax_amount numeric, p_tip_amount numeric,
  --    p_total numeric, p_items jsonb'
  -- and never the types-only string it was compared against. The lookup found
  -- no row, v_complete_sale_oid stayed null, and the migration aborted on a
  -- function it had not touched.
  --
  -- to_regprocedure resolves the exact overload by argument TYPE -- no implicit
  -- casts, no dependence on parameter names, spacing, or deparser formatting --
  -- and returns null rather than raising when the overload is absent, which is
  -- what lets the missing case carry its own message.
  v_complete_sale_oid := to_regprocedure(
    'public.complete_sale(uuid,text,text,numeric,numeric,numeric,numeric,jsonb)'
  );

  if v_complete_sale_oid is null then
    raise exception 'Device pairing: complete_sale exact overload is missing';
  end if;

  if (select pg_get_function_result(v_complete_sale_oid)) <> 'uuid' then
    raise exception 'Device pairing: complete_sale must still return uuid';
  end if;

  if (select p.prosecdef from pg_proc p where p.oid = v_complete_sale_oid) then
    raise exception 'Device pairing: complete_sale must remain SECURITY INVOKER (DEFINER is Migration C)';
  end if;

  if not exists (
    select 1 from pg_proc p
    where p.oid = v_complete_sale_oid
      and 'search_path=public' = any(coalesce(p.proconfig, array[]::text[]))
  ) then
    raise exception 'Device pairing: complete_sale must keep SET search_path TO public';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_language l on l.oid = p.prolang
    where p.oid = v_complete_sale_oid and l.lanname = 'plpgsql'
  ) then
    raise exception 'Device pairing: complete_sale must remain LANGUAGE plpgsql';
  end if;

  if not has_function_privilege('authenticated', v_complete_sale_oid, 'EXECUTE') then
    raise exception 'Device pairing: complete_sale must keep EXECUTE for authenticated';
  end if;

  -- anon inherits anything granted to PUBLIC, so this single check covers both
  -- paths; the explicit PUBLIC lookup below makes the intent unambiguous.
  if has_function_privilege('anon', v_complete_sale_oid, 'EXECUTE') then
    raise exception 'Device pairing: complete_sale must not be executable by anon';
  end if;

  if exists (
    select 1 from information_schema.routine_privileges
    where specific_schema = 'public'
      and routine_name = 'complete_sale'
      and grantee = 'PUBLIC'
      and privilege_type = 'EXECUTE'
  ) then
    raise exception 'Device pairing: complete_sale must not be executable by PUBLIC';
  end if;
end $$;
