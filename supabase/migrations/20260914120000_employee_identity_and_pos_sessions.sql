-- v1.3 Feature 1A — Employee Identity & Till Session Foundation.
--
-- ADDITIVE ONLY. This migration creates three new tables, three private
-- helper functions and seven RPCs. It deliberately does NOT touch
-- complete_sale, complete_sale_v2, complete_sale_v3, complete_sale_v4,
-- resolve_sale_owner, any pairing RPC, any paired_devices column, policy,
-- grant or immutability trigger, or any existing operational-table privilege.
-- A verification block at the end proves that, rather than asserting it.
--
-- This migration is NOT applied automatically -- review, then apply manually.
-- It must be run as ONE SQL Editor submission (one session): the baseline
-- temporary tables below are compared against at the end, exactly as
-- 20260803270000 does.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS IS
-- ----------------------------------------------------------------------------
-- An employee is a PROJECT-SCOPED OPERATIONAL IDENTITY. It is not a Supabase
-- Auth user, has no password, no email, no JWT and no RLS identity of its own.
-- The only thing an employee can do is be the person currently signed in at a
-- till, which is what employee_pos_sessions records.
--
-- The register identity is the EXISTING paired_devices.id. No second registers
-- table is created, because paired_devices already answers "which physical
-- till is this" and adding a parallel master would create two answers to one
-- question.
--
-- ----------------------------------------------------------------------------
-- TRUST MODEL -- unchanged from the pairing layer, extended one step further
-- ----------------------------------------------------------------------------
--   * A paired device NEVER submits its own project_id or device_id. Every
--     device-facing function here takes zero identity arguments: the caller is
--     auth.uid(), the device is resolved from it, and the project is read off
--     that row. This is the get_device_config / unpair_own_device pattern.
--   * An ACTIVE device is `revoked_at is null AND unpaired_at is null`. That is
--     the predicate Feature 25.1 established and the one resolve_sale_owner,
--     get_device_config and complete_sale_v3/v4 already use.
--   * No role -- not anon, not authenticated, not service_role, not the owner's
--     own browser session -- holds ANY privilege on the three tables below, and
--     none of them has a single RLS policy. Every read and write goes through a
--     SECURITY DEFINER function with a locked search_path.
--
--     This is stricter than the pairing tables, which grant owners SELECT, and
--     the reason is pin_hash. A 4-6 digit PIN has at most 10^6 possibilities,
--     so ANY party holding the hash can recover the PIN offline in seconds
--     regardless of the cost factor. RLS filters rows, not columns, so a
--     column-free SELECT grant does not exist. Granting nothing is therefore
--     the only posture that keeps the hash server-side.
--
-- ----------------------------------------------------------------------------
-- HASHING DEPENDENCY -- READ THIS, IT IS THE OPPOSITE OF THE PAIRING DECISION
-- ----------------------------------------------------------------------------
-- 20260803210000 deliberately avoided pgcrypto and used core sha256(), because
-- Supabase installs pgcrypto into the "extensions" schema and an unqualified
-- digest() would not resolve under `SET search_path = public, pg_temp`.
--
-- That choice cannot be repeated here. A pairing code is 8 Crockford Base32
-- characters (2^40) and a fast digest of it is not usefully attackable. A PIN
-- is 4-6 digits (10^4-10^6) and a fast digest of it -- SHA-256, unsalted or
-- salted -- is an offline PIN oracle. Feature 1A therefore requires a SLOW
-- SALTED primitive, which in PostgreSQL means pgcrypto's crypt()/gen_salt().
--
-- The search_path problem is real and is WORSE than the pairing comment says:
-- the three existing `create extension if not exists "pgcrypto"` statements
-- carry no SCHEMA clause, so on a database bootstrapped from this history
-- outside Supabase, pgcrypto could legitimately land in "public" rather than
-- "extensions". The installed schema is environment-dependent and is not
-- pinned by this repository, so hardcoding extensions.crypt would be a guess.
--
-- RESOLUTION, and the reason for the only dynamic DDL in this repository:
--   1. Discover pgcrypto's ACTUAL schema from pg_extension/pg_namespace.
--   2. Prove crypt(text,text) and gen_salt(text,integer) exist IN that schema.
--   3. Build the two helpers with those calls FULLY SCHEMA-QUALIFIED.
--   4. Abort the whole migration, loudly, if any of that fails.
--
-- search_path is therefore never widened -- it stays `public, pg_temp` on every
-- function here -- and the qualified calls do not depend on it at all. That
-- also closes a shadowing hazard that widening WOULD have opened: with
-- `search_path = public, extensions, pg_temp`, a function named public.crypt
-- would take precedence over the real one.
--
-- The cost of this approach is that two function bodies live inside a string
-- literal and so are not covered by the repository's libpg-query parse suite.
-- Two compensating controls exist:
--   * the migration test extracts that string and parses it separately, so
--     parse coverage is restored;
--   * the verification block at the end performs a live hash/verify round trip
--     (correct PIN verifies, wrong PIN does not), which is a stronger check
--     than parsing and which a parse could never provide.
--
-- Declared idempotently here purely so an empty database applying this chain
-- standalone has the extension present; discovery below still governs which
-- schema is actually used.
create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- Self-capturing baseline, recorded BEFORE any DDL so the verification block
-- compares real values rather than hardcoded ones.
--
-- Feature 1A must be provably inert with respect to the pairing layer. These
-- capture what paired_devices looks like now; the end of the file proves it is
-- byte-for-byte the same afterwards.
-- ----------------------------------------------------------------------------
create temporary table f1a_paired_devices_baseline as
select (select count(*) from public.paired_devices) as n,
       (select coalesce(md5(string_agg(md5(d::text), '|' order by d.id::text)), 'empty')
        from public.paired_devices d) as fp;

create temporary table f1a_priv_baseline as
select r.rolname, t.tablename, p.priv,
       has_table_privilege(r.rolname, format('public.%I', t.tablename), p.priv) as held
from (values ('anon'), ('authenticated'), ('service_role')) as r(rolname)
cross join (values ('paired_devices'), ('device_pairing_tokens'), ('projects'),
                   ('orders'), ('order_items'), ('inventory_transactions'),
                   ('build_jobs'), ('build_artifacts')) as t(tablename)
cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
                   ('REFERENCES'), ('TRIGGER')) as p(priv);

create temporary table f1a_pol_baseline as
select tablename, policyname, cmd, qual, with_check, roles::text as roles
from pg_policies
where schemaname = 'public';

create temporary table f1a_proc_baseline as
select p.oid as fn_oid,
       p.proname,
       md5(pg_get_functiondef(p.oid)) as body,
       p.prosecdef,
       coalesce(p.proconfig, array[]::text[]) as config,
       coalesce(p.proacl::text, 'default') as acl
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind = 'f';

create temporary table f1a_trg_baseline as
select c.relname, t.tgname, t.tgtype, t.tgenabled, pr.proname
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_proc pr on pr.oid = t.tgfoid
where n.nspname = 'public' and not t.tgisinternal;

-- ----------------------------------------------------------------------------
-- 1. PIN hashing helpers -- discovered, proven, then built fully qualified.
--
-- These two functions are the ONLY place in the system that touches a PIN in
-- either direction. They are granted to NOBODY: every revoke below strips the
-- default PUBLIC EXECUTE that a new function is born with, and no grant
-- follows. They remain callable from inside the SECURITY DEFINER RPCs below
-- because those execute as their owner, which is also these functions' owner.
--
-- employee_pin_hash raises on a malformed PIN. That is a programming-error
-- backstop, NOT the validation path: every caller validates the shape first and
-- returns a jsonb result, because a RAISE inside employee_login would roll back
-- the failed-attempt counter -- the same trap 20260803210000 documents for
-- redeem_device_pairing_token.
--
-- employee_pin_verify never raises. crypt() rejects a malformed salt argument
-- with an exception, so the stored value's shape is checked first and anything
-- unexpected returns false rather than aborting a login transaction.
-- ----------------------------------------------------------------------------
do $do$
declare
  v_schema text;
begin
  select n.nspname into v_schema
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pgcrypto';

  if v_schema is null then
    raise exception
      'Feature 1A requires the pgcrypto extension for salted PIN hashing; it is not installed';
  end if;

  if to_regprocedure(format('%I.crypt(text, text)', v_schema)) is null then
    raise exception
      'pgcrypto is installed in schema %, but crypt(text, text) is not present there', v_schema;
  end if;

  if to_regprocedure(format('%I.gen_salt(text, integer)', v_schema)) is null then
    raise exception
      'pgcrypto is installed in schema %, but gen_salt(text, integer) is not present there', v_schema;
  end if;

  -- Cost factor 10. bcrypt at cost 10 is roughly 60-100ms per verification on
  -- current hardware, which is deliberate: it is the per-guess floor that makes
  -- a 4-6 digit PIN space impractical to walk, and it is small enough that a
  -- till operator does not notice it. The device-level backoff in section 4
  -- bounds how much of this work an attacker can force.
  execute format($ddl$
create or replace function public.employee_pin_hash(p_pin text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then
    raise exception 'A 4 to 6 digit numeric PIN is required';
  end if;

  return %I.crypt(p_pin, %I.gen_salt('bf', 10));
end;
$fn$;
$ddl$, v_schema, v_schema);

  execute format($ddl$
create or replace function public.employee_pin_verify(p_pin text, p_pin_hash text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if p_pin is null or p_pin_hash is null then
    return false;
  end if;

  if left(p_pin_hash, 2) <> '$2' or length(p_pin_hash) <> 60 then
    return false;
  end if;

  return %I.crypt(p_pin, p_pin_hash) = p_pin_hash;
end;
$fn$;
$ddl$, v_schema);
end
$do$;

-- No grant follows any of these: the default PUBLIC EXECUTE is removed and
-- nothing replaces it.
revoke all on function public.employee_pin_hash(text) from public;
revoke all on function public.employee_pin_hash(text) from anon;
revoke all on function public.employee_pin_hash(text) from authenticated;
revoke all on function public.employee_pin_hash(text) from service_role;

revoke all on function public.employee_pin_verify(text, text) from public;
revoke all on function public.employee_pin_verify(text, text) from anon;
revoke all on function public.employee_pin_verify(text, text) from authenticated;
revoke all on function public.employee_pin_verify(text, text) from service_role;

-- ----------------------------------------------------------------------------
-- 2. employees
--
-- Project-scoped operational identities. There is deliberately NO column that
-- could hold a plaintext, reversible or deterministic PIN: pin_hash is a
-- bcrypt modular-crypt string and the check constraint enforces exactly that
-- shape, so a SHA-256 hex digest (64 chars) or a raw PIN cannot be stored even
-- by a future writer that forgets to hash.
--
-- role is text + check, not an enum, because this schema contains no enum types
-- at all -- build_jobs.status is the precedent. The set is closed on purpose
-- (v1.3 architectural decision 4): owner, manager, cashier, and no configurable
-- permission model.
--
-- NO UNIQUE CONSTRAINT ON display_name. Two people called Sam is a real shop,
-- not a data error, and disambiguating them is a Lane 3 presentation problem.
-- ----------------------------------------------------------------------------
create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),

  project_id uuid not null references public.projects(id) on delete cascade,

  display_name text not null,

  role text not null,

  -- bcrypt modular crypt: '$2a$10$' + 22 salt chars + 31 digest chars = 60.
  pin_hash text not null,

  active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deactivated_at timestamptz,

  constraint employees_display_name_check
    check (btrim(display_name) <> ''),

  constraint employees_role_check
    check (role in ('owner', 'manager', 'cashier')),

  -- Structural proof that the value is a slow salted hash and not a fast digest
  -- or a PIN. A 64-character SHA-256 hex string fails the length test; a raw
  -- PIN fails both.
  constraint employees_pin_hash_shape_check
    check (pin_hash like '$2%' and length(pin_hash) = 60),

  -- Biconditional, not a one-way implication: a reactivated employee must not
  -- keep carrying the timestamp of a deactivation that has been undone.
  constraint employees_active_state_check
    check ((active and deactivated_at is null)
           or (not active and deactivated_at is not null))
);

comment on table public.employees is
  'v1.3 Feature 1A -- project-scoped operational identities. NOT Supabase Auth users. '
  'No role holds any privilege on this table; all access is through SECURITY DEFINER RPCs.';

comment on column public.employees.pin_hash is
  'bcrypt (pgcrypto crypt/gen_salt, cost 10). Never returned by any RPC and never '
  'readable by anon, authenticated or service_role.';

create index if not exists employees_project_idx
  on public.employees using btree (project_id);

-- The login scan: employee_login walks the ACTIVE employees of one project and
-- verifies the candidate PIN against each salted hash. Partial, because an
-- inactive employee can never be the answer.
create index if not exists employees_project_active_idx
  on public.employees using btree (project_id)
  where active;

-- Matches set_build_jobs_updated_at, the only updated_at trigger precedent in
-- this schema.
create or replace function public.set_employees_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;

revoke all on function public.set_employees_updated_at() from public;
revoke all on function public.set_employees_updated_at() from anon;
revoke all on function public.set_employees_updated_at() from authenticated;
revoke all on function public.set_employees_updated_at() from service_role;

create or replace trigger employees_set_updated_at
  before update on public.employees
  for each row
  execute function public.set_employees_updated_at();

-- ----------------------------------------------------------------------------
-- 3. employee_pos_sessions
--
-- Who is signed in at which till, and when they stopped being signed in.
--
-- THIS IS NOT A TIME CLOCK and it is not a register session. It records a POS
-- login only. Clock-in/out, register open/close, cash movements and sale
-- attribution are explicitly out of Feature 1A.
--
-- NO project_id COLUMN, deliberately. Both foreign keys already resolve to a
-- project -- employee_id -> employees.project_id and paired_device_id ->
-- paired_devices.project_id -- and employee_login proves those two agree before
-- inserting. A third stored copy could only ever drift out of agreement with
-- the two authoritative ones, and there is no query here that needs it.
-- ----------------------------------------------------------------------------
create table if not exists public.employee_pos_sessions (
  id uuid primary key default gen_random_uuid(),

  employee_id uuid not null references public.employees(id) on delete cascade,
  paired_device_id uuid not null references public.paired_devices(id) on delete cascade,

  started_at timestamptz not null default now(),

  ended_at timestamptz,
  end_reason text,

  constraint employee_pos_sessions_end_reason_check
    check (end_reason is null or end_reason in ('logout', 'switched')),

  -- An ended session always says why, and an open session never does.
  constraint employee_pos_sessions_end_state_check
    check ((ended_at is null and end_reason is null)
           or (ended_at is not null and end_reason is not null)),

  constraint employee_pos_sessions_end_order_check
    check (ended_at is null or ended_at >= started_at)
);

comment on table public.employee_pos_sessions is
  'v1.3 Feature 1A -- the employee currently signed in at a paired device. Not a time '
  'clock, not a register session, and never used for sale attribution in v1.3.';

-- THE INVARIANT (v1.3 architectural decision 11): at most ONE open employee POS
-- session per register, enforced by the database rather than by the correctness
-- of any function. employee_login closes the previous session in the same
-- statement sequence that opens the new one, so this index is the backstop for
-- a concurrent second caller, not the normal switching mechanism.
create unique index if not exists employee_pos_sessions_one_open_per_device
  on public.employee_pos_sessions using btree (paired_device_id)
  where ended_at is null;

create index if not exists employee_pos_sessions_device_started_idx
  on public.employee_pos_sessions using btree (paired_device_id, started_at desc);

create index if not exists employee_pos_sessions_employee_started_idx
  on public.employee_pos_sessions using btree (employee_id, started_at desc);

-- ----------------------------------------------------------------------------
-- 4. employee_login_attempts -- server-authoritative brute-force state.
--
-- WHY A DEDICATED TABLE (v1.3 architectural decision 10). The obvious home for
-- a per-register counter is paired_devices, and that is exactly what
-- paired_devices_guard_immutable_columns forbids: it raises on any change to
-- auth_user_id, owner_id, project_id, device_name, platform, created_at and
-- last_seen_at, and permits build_job_id to move only while consuming an owner
-- offer. Putting a counter there would mean relaxing that trigger, trading a
-- proven financial-identity guarantee for a convenience. A separate table costs
-- one row per till and weakens nothing.
--
-- NO project_id COLUMN: paired_device_id is already authoritative for both the
-- register and its project.
--
-- THIS ONE ACTUALLY LIMITS GUESSING, unlike device_pairing_tokens.attempt_count
-- -- which its own migration is careful to say does not, because a wrong
-- pairing code matches no row and so increments nothing. Here the row is keyed
-- by the CALLING DEVICE, which is resolved from auth.uid() before any PIN is
-- examined, so every failed attempt lands on a row that exists.
-- ----------------------------------------------------------------------------
create table if not exists public.employee_login_attempts (
  paired_device_id uuid primary key
    references public.paired_devices(id) on delete cascade,

  failed_count integer not null default 0,

  first_failed_at timestamptz,
  last_failed_at timestamptz,
  locked_until timestamptz,

  updated_at timestamptz not null default now(),

  constraint employee_login_attempts_failed_count_check
    check (failed_count >= 0),

  constraint employee_login_attempts_failure_state_check
    check ((failed_count = 0 and first_failed_at is null and last_failed_at is null)
           or (failed_count > 0 and first_failed_at is not null and last_failed_at is not null))
);

comment on table public.employee_login_attempts is
  'v1.3 Feature 1A -- per-register failed employee-login state and lockout window. '
  'Server-authoritative; the device is resolved from auth.uid() before any PIN is read.';

-- ----------------------------------------------------------------------------
-- 5. Row level security and privileges.
--
-- DETERMINISTIC PRIVILEGE RESET -- revoke first, then grant nothing.
--
-- Supabase applies ALTER DEFAULT PRIVILEGES on the public schema, so a table
-- created here is BORN with ALL privileges already granted to anon,
-- authenticated and service_role. Enabling RLS would not save it: TRUNCATE is
-- not subject to RLS at all. Without these revokes an unauthenticated anon-key
-- client could truncate the employee table.
--
-- Revoking from PUBLIC as well as the named roles matters because a PUBLIC
-- grant applies to every current and future role.
--
-- NO GRANT FOLLOWS, ON ANY TABLE, TO ANY ROLE -- including the project owner's
-- own authenticated session, and including service_role, which receives nothing
-- speculative. RLS is enabled anyway as defence in depth, with zero policies,
-- so even a future accidental grant still yields zero rows.
-- ----------------------------------------------------------------------------
alter table public.employees enable row level security;
alter table public.employee_pos_sessions enable row level security;
alter table public.employee_login_attempts enable row level security;

revoke all privileges on table public.employees from public;
revoke all privileges on table public.employees from anon;
revoke all privileges on table public.employees from authenticated;
revoke all privileges on table public.employees from service_role;

revoke all privileges on table public.employee_pos_sessions from public;
revoke all privileges on table public.employee_pos_sessions from anon;
revoke all privileges on table public.employee_pos_sessions from authenticated;
revoke all privileges on table public.employee_pos_sessions from service_role;

revoke all privileges on table public.employee_login_attempts from public;
revoke all privileges on table public.employee_login_attempts from anon;
revoke all privileges on table public.employee_login_attempts from authenticated;
revoke all privileges on table public.employee_login_attempts from service_role;

-- ----------------------------------------------------------------------------
-- 6. employee_login_note_failure -- private.
--
-- Records one failed attempt and returns the SINGLE generic credential failure.
-- Separated out because employee_login has four distinct ways to reach the same
-- outcome and all four must be indistinguishable to the caller: a malformed
-- PIN, a PIN matching no employee, a PIN matching an INACTIVE employee, and a
-- PIN belonging to a different project. None of them may be told apart, and
-- none of them may skip the counter.
--
-- THE BACKOFF LADDER, applied to the NEW failure count:
--     1-4  no lock          (a genuine mistyped PIN is not punished)
--       5  30 seconds
--       6  1 minute
--       7  2 minutes
--       8  5 minutes
--      9+  15 minutes       (cap)
--
-- WHY THE COUNTER SURVIVES. This returns jsonb; it never raises. A RAISE would
-- roll back the very UPDATE that records the attempt, which is the trap
-- 20260803210000 documents at length for redeem_device_pairing_token. Every
-- expected failure in this feature is therefore a return value.
--
-- The caller has already taken a FOR UPDATE lock on the register's
-- paired_devices row, so concurrent attempts on one till are serialized and
-- cannot race the counter past the ladder.
-- ----------------------------------------------------------------------------
create or replace function public.employee_login_note_failure(
  p_paired_device_id uuid,
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  update public.employee_login_attempts a
  set failed_count = a.failed_count + 1,
      first_failed_at = coalesce(a.first_failed_at, p_now),
      last_failed_at = p_now,
      locked_until = case
        when a.failed_count + 1 >= 9 then p_now + make_interval(secs => 900)
        when a.failed_count + 1 = 8 then p_now + make_interval(secs => 300)
        when a.failed_count + 1 = 7 then p_now + make_interval(secs => 120)
        when a.failed_count + 1 = 6 then p_now + make_interval(secs => 60)
        when a.failed_count + 1 = 5 then p_now + make_interval(secs => 30)
        -- Below the threshold there is no lock, and any expired one is cleared
        -- rather than left to be re-read as live state.
        else null
      end,
      updated_at = p_now
  where a.paired_device_id = p_paired_device_id;

  -- The ONLY credential failure this feature emits. It carries no employee id,
  -- no display name, no counter, no lockout hint and no indication of which of
  -- the four causes applied.
  return jsonb_build_object('ok', false, 'error', 'invalid_credentials');
end;
$function$;

revoke all on function public.employee_login_note_failure(uuid, timestamptz) from public;
revoke all on function public.employee_login_note_failure(uuid, timestamptz) from anon;
revoke all on function public.employee_login_note_failure(uuid, timestamptz) from authenticated;
revoke all on function public.employee_login_note_failure(uuid, timestamptz) from service_role;

-- ----------------------------------------------------------------------------
-- 7. employee_login -- the device-facing authentication and switch RPC.
--
-- TAKES THE PIN AND NOTHING ELSE. There is no p_project_id and no p_device_id,
-- because a paired device must never be trusted to state which register or
-- which tenant it is (v1.3 architectural decision 5). The caller is auth.uid(),
-- the register is the paired_devices row bound to it, and the project is read
-- off that row.
--
-- LOGIN IS ALSO THE SWITCH (decision 12). A successful login while another
-- employee holds the till closes that session with reason 'switched' and opens
-- the new one in the same transaction. There is deliberately no second
-- authentication path: two ways to authenticate is two places for an
-- authorization bug to live.
--
-- SERIALIZATION. The register's paired_devices row is taken FOR UPDATE before
-- anything else happens. That is the single device-level serialization point:
-- it orders concurrent logins on one till, keeps the failure counter honest,
-- bounds how much concurrent bcrypt work one register can demand, and makes the
-- close-then-open pair effectively atomic. SELECT FOR UPDATE takes a row lock
-- and fires no trigger, so paired_devices_guard_immutable_columns is not
-- involved and nothing on that row is written.
--
-- The partial unique index remains the final invariant regardless, but it is a
-- backstop -- reaching it would be a bug, not the normal switching mechanism.
--
-- THE PIN NECESSARILY CROSSES THE WIRE. Unlike a pairing code, which is hashed
-- in the application precisely so the plaintext never enters Postgres, a salted
-- verification can only be performed where the salt is. The PIN arrives as a
-- bound parameter over TLS, is compared, and is never stored, logged, returned
-- or placed in an exception message.
--
-- WHY THE SCAN IS A LOOP. Finding the employee requires verifying the candidate
-- against every active salted hash in the project, because a salted hash is not
-- indexable by construction -- and making it indexable would mean storing a
-- deterministic digest, which is the offline PIN oracle decision 9 forbids. The
-- cost is bounded at the other end instead, by the PROVISIONAL engineering
-- ceiling on active employees described above create_employee. At the current
-- ceiling of 50 a login costs at most 50 bcrypt verifications. That number is a
-- benchmark-pending safety value, NOT a supported roster size -- see the note
-- there before quoting it anywhere.
-- ----------------------------------------------------------------------------
create or replace function public.employee_login(p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller uuid;
  v_device record;
  v_attempts record;
  v_employee record;
  v_now timestamptz := now();
  v_session_id uuid;
begin
  v_caller := auth.uid();

  if v_caller is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  -- The register, and the serialization point. An ACTIVE device is neither
  -- revoked nor unpaired -- the Feature 25.1 predicate, identical to the one
  -- get_device_config and complete_sale_v4 use. A revoked or voluntarily
  -- unpaired device simply stops matching, on the very next request, with no
  -- JWT invalidation required.
  select d.id, d.project_id
  into v_device
  from public.paired_devices d
  where d.auth_user_id = v_caller
    and d.revoked_at is null
    and d.unpaired_at is null
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_paired');
  end if;

  -- Ensure the attempts row exists, then read it. Created unconditionally so
  -- that every subsequent failure path has a row to increment.
  insert into public.employee_login_attempts (paired_device_id)
  values (v_device.id)
  on conflict (paired_device_id) do nothing;

  select a.locked_until
  into v_attempts
  from public.employee_login_attempts a
  where a.paired_device_id = v_device.id;

  -- The one failure that is NOT collapsed into invalid_credentials, and the
  -- reason it is safe to distinguish: it reveals only this register's own rate
  -- state, which this register produced. It says nothing about whether any PIN
  -- exists, who the employees are, whether one is inactive, or what any other
  -- project contains. Without it a till cannot tell an operator why it is
  -- refusing, and the operator retries into a longer lock.
  if v_attempts.locked_until is not null and v_attempts.locked_until > v_now then
    return jsonb_build_object(
      'ok', false,
      'error', 'locked_out',
      'retryAfterSeconds',
        ceil(extract(epoch from (v_attempts.locked_until - v_now)))::integer
    );
  end if;

  -- A malformed PIN is a FAILED ATTEMPT, not a free probe, and it is never
  -- trimmed or coerced into validity. Accepting it silently would hand an
  -- attacker an unlimited, unmetered way to distinguish "the device is live"
  -- from "the device is locked".
  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then
    return public.employee_login_note_failure(v_device.id, v_now);
  end if;

  for v_employee in
    select e.id, e.display_name, e.role, e.pin_hash, e.project_id
    from public.employees e
    where e.project_id = v_device.project_id
      and e.active
    order by e.created_at, e.id
  loop
    if public.employee_pin_verify(p_pin, v_employee.pin_hash) then
      -- Tenancy re-asserted at the point of use rather than inferred from the
      -- query that selected the row. The predicate above already guarantees it;
      -- this exists so that a future edit which widens that predicate fails
      -- closed instead of silently opening a cross-project login.
      if v_employee.project_id is distinct from v_device.project_id then
        return public.employee_login_note_failure(v_device.id, v_now);
      end if;

      -- The switch half. Closing the incumbent and opening the replacement
      -- happen in one transaction under the register's row lock, so no window
      -- exists in which the till has two operators or none.
      update public.employee_pos_sessions s
      set ended_at = v_now,
          end_reason = 'switched'
      where s.paired_device_id = v_device.id
        and s.ended_at is null;

      insert into public.employee_pos_sessions (employee_id, paired_device_id, started_at)
      values (v_employee.id, v_device.id, v_now)
      returning id into v_session_id;

      -- Success resets the failure state for this register completely.
      delete from public.employee_login_attempts
      where paired_device_id = v_device.id;

      -- Safe data only. No PIN, no hash, no counter, no lockout state, no owner
      -- identity, no other employee and no other device.
      return jsonb_build_object(
        'ok', true,
        'employeeSessionId', v_session_id,
        'employeeId', v_employee.id,
        'displayName', v_employee.display_name,
        'role', v_employee.role,
        'startedAt', v_now
      );
    end if;
  end loop;

  -- No active employee in this project matched. Indistinguishable from a
  -- malformed PIN, an inactive employee and another project's employee.
  return public.employee_login_note_failure(v_device.id, v_now);
end;
$function$;

revoke all on function public.employee_login(text) from public;
revoke all on function public.employee_login(text) from anon;
grant execute on function public.employee_login(text) to authenticated;

-- ----------------------------------------------------------------------------
-- 8. get_current_employee_session -- who is signed in at THIS register.
--
-- Zero arguments, for the same reason employee_login has none.
--
-- AN INACTIVE EMPLOYEE IS NOT AN AUTHORIZED OPERATOR. The join filters on
-- e.active, so deactivating someone mid-shift stops them being reported as the
-- current operator on the next call. The session ROW is deliberately left open
-- and untouched: it is history, and Feature 1A does not rewrite history to
-- express an authorization decision. Closing it would also require deciding an
-- end_reason that did not happen.
-- ----------------------------------------------------------------------------
create or replace function public.get_current_employee_session()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller uuid;
  v_device record;
  v_session record;
begin
  v_caller := auth.uid();

  if v_caller is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  select d.id, d.project_id
  into v_device
  from public.paired_devices d
  where d.auth_user_id = v_caller
    and d.revoked_at is null
    and d.unpaired_at is null;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_paired');
  end if;

  select s.id as session_id,
         s.started_at,
         e.id as employee_id,
         e.display_name,
         e.role
  into v_session
  from public.employee_pos_sessions s
  join public.employees e on e.id = s.employee_id
  where s.paired_device_id = v_device.id
    and s.ended_at is null
    and e.active
    -- Both foreign keys must still agree on the project. They cannot disagree
    -- today; this makes that a checked fact rather than an assumption.
    and e.project_id = v_device.project_id;

  if not found then
    -- Signed in nowhere is a successful answer, not an error.
    return jsonb_build_object('ok', true, 'session', null);
  end if;

  return jsonb_build_object(
    'ok', true,
    'session', jsonb_build_object(
      'employeeSessionId', v_session.session_id,
      'employeeId', v_session.employee_id,
      'displayName', v_session.display_name,
      'role', v_session.role,
      'startedAt', v_session.started_at
    )
  );
end;
$function$;

revoke all on function public.get_current_employee_session() from public;
revoke all on function public.get_current_employee_session() from anon;
grant execute on function public.get_current_employee_session() to authenticated;

-- ----------------------------------------------------------------------------
-- 9. employee_logout
--
-- Zero arguments: no employee id, no project id, no device id, and therefore no
-- way to express "close someone else's session". The WHERE clause names only
-- the register resolved from auth.uid(), so a device cannot end another
-- device's session even by accident.
--
-- Idempotent: logging out when nobody is signed in succeeds and reports null,
-- so a client that never saw the reply is free to retry.
-- ----------------------------------------------------------------------------
create or replace function public.employee_logout()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller uuid;
  v_device record;
  v_session_id uuid;
begin
  v_caller := auth.uid();

  if v_caller is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  select d.id
  into v_device
  from public.paired_devices d
  where d.auth_user_id = v_caller
    and d.revoked_at is null
    and d.unpaired_at is null;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_paired');
  end if;

  update public.employee_pos_sessions s
  set ended_at = now(),
      end_reason = 'logout'
  where s.paired_device_id = v_device.id
    and s.ended_at is null
  returning s.id into v_session_id;

  return jsonb_build_object(
    'ok', true,
    'endedSessionId', v_session_id
  );
end;
$function$;

revoke all on function public.employee_logout() from public;
revoke all on function public.employee_logout() from anon;
grant execute on function public.employee_logout() to authenticated;

-- ----------------------------------------------------------------------------
-- 10. employee_project_pin_taken -- private duplicate-PIN check.
--
-- WHY THIS IS A SCAN AND NOT AN INDEX (v1.3 architectural decision 9). The
-- cheap way to forbid duplicate PINs in a project is a unique index on a
-- deterministic digest of the PIN. That is exactly what must never exist: a
-- deterministic unsalted digest of a 4-6 digit PIN is an offline oracle, and a
-- unique index on it would additionally leak, to anyone who could read the
-- table, that two employees share a PIN. So the candidate is verified against
-- the existing SALTED hashes instead, inside the trusted management path, and
-- nothing deterministic is ever stored or indexed.
--
-- INACTIVE EMPLOYEES COUNT. Skipping them would let a project mint a duplicate
-- while someone is deactivated, which becomes a genuine collision the moment
-- they are reactivated -- at which point two people can open one till and only
-- one of them is ever recognised.
-- ----------------------------------------------------------------------------
create or replace function public.employee_project_pin_taken(
  p_project_id uuid,
  p_pin text,
  p_exclude_employee_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_hash text;
begin
  for v_hash in
    select e.pin_hash
    from public.employees e
    where e.project_id = p_project_id
      and (p_exclude_employee_id is null or e.id <> p_exclude_employee_id)
  loop
    if public.employee_pin_verify(p_pin, v_hash) then
      return true;
    end if;
  end loop;

  return false;
end;
$function$;

revoke all on function public.employee_project_pin_taken(uuid, text, uuid) from public;
revoke all on function public.employee_project_pin_taken(uuid, text, uuid) from anon;
revoke all on function public.employee_project_pin_taken(uuid, text, uuid) from authenticated;
revoke all on function public.employee_project_pin_taken(uuid, text, uuid) from service_role;

-- ----------------------------------------------------------------------------
-- 11. Owner-only employee management -- the authoritative write path. NO UI.
--
-- Lane 3 builds the administration screens later; these are the contract those
-- screens will call, and they are what makes "no plaintext PIN is ever stored"
-- a checkable property rather than an aspiration, because they are the only
-- writers this table has.
--
-- AUTHORITY IS ALWAYS DERIVED. The owner is auth.uid(); p_project_id is only
-- ever a value to MATCH against projects.user_id, never a claim to be believed
-- -- the same shape as resolve_sale_owner and offer_device_config_update.
--
-- A PAIRED DEVICE CAN NEVER REACH THESE. Two independent reasons, both checked:
-- a device's anonymous auth user owns no projects, so the ownership match fails
-- on its own; and the caller is additionally rejected outright if it has a
-- paired_devices row. The second check is redundant today and exists so that it
-- stays impossible if the first is ever loosened.
--
-- FAILURES ARE COLLAPSED to 'not_found' for "no such project/employee", "not
-- yours" and "you are a device", so these cannot be used to probe which
-- projects or employees exist. Validation failures (role, PIN shape, duplicate
-- PIN, limit) are reported distinctly: this is an authenticated owner acting on
-- their own tenant, where a useful message costs nothing, and the generic-error
-- requirement is about the LOGIN path.
--
-- THE ACTIVE-EMPLOYEE CEILING IS A PROVISIONAL ENGINEERING SAFETY VALUE.
--
-- READ THIS BEFORE QUOTING THE NUMBER ANYWHERE. 50 is a staging/engineering
-- runtime ceiling pending benchmark validation. It is NOT the permanent
-- production maximum, NOT a supported-roster promise, NOT a documented POS
-- Canvas limit, and NOT a product or marketing constraint. It exists to bound a
-- cost, not to describe a capability, and it is expected to be revisited --
-- most likely raised -- once the login path has been benchmarked on real
-- hardware. Nothing outside this migration depends on the value.
--
-- WHY A CEILING IS NEEDED AT ALL: employee_login must verify a candidate PIN
-- against every active salted hash in the project, because a salted hash is not
-- indexable by construction and making it indexable would mean storing the
-- deterministic digest decision 9 forbids. An unbounded roster would therefore
-- turn one login into unbounded bcrypt work. Bounding the roster bounds that
-- work.
--
-- It is enforced HERE, where an owner can see and act on the refusal, rather
-- than silently truncating the login scan -- a scan that stopped early would
-- make employee 51 unable to sign in with no visible cause.
-- ----------------------------------------------------------------------------
create or replace function public.create_employee(
  p_project_id uuid,
  p_display_name text,
  p_role text,
  p_pin text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller uuid;
  v_project_owner uuid;
  v_active_count integer;
  v_employee record;
begin
  v_caller := auth.uid();

  if v_caller is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  if exists (select 1 from public.paired_devices d where d.auth_user_id = v_caller) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if p_project_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  select p.user_id into v_project_owner
  from public.projects p
  where p.id = p_project_id;

  if not found or v_project_owner is distinct from v_caller then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if p_display_name is null or btrim(p_display_name) = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_display_name');
  end if;

  if p_role is null or p_role not in ('owner', 'manager', 'cashier') then
    return jsonb_build_object('ok', false, 'error', 'invalid_role');
  end if;

  -- Never trimmed or padded into validity: a PIN is 4 to 6 ASCII digits or it
  -- is not a PIN.
  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_pin');
  end if;

  select count(*) into v_active_count
  from public.employees e
  where e.project_id = p_project_id
    and e.active;

  -- Provisional engineering ceiling, not a supported limit. See the note above.
  if v_active_count >= 50 then
    return jsonb_build_object('ok', false, 'error', 'employee_limit_reached');
  end if;

  if public.employee_project_pin_taken(p_project_id, p_pin, null) then
    return jsonb_build_object('ok', false, 'error', 'duplicate_pin');
  end if;

  insert into public.employees (project_id, display_name, role, pin_hash)
  values (p_project_id, btrim(p_display_name), p_role, public.employee_pin_hash(p_pin))
  returning id, display_name, role, active, created_at into v_employee;

  return jsonb_build_object(
    'ok', true,
    'employeeId', v_employee.id,
    'displayName', v_employee.display_name,
    'role', v_employee.role,
    'active', v_employee.active,
    'createdAt', v_employee.created_at
  );
end;
$function$;

revoke all on function public.create_employee(uuid, text, text, text) from public;
revoke all on function public.create_employee(uuid, text, text, text) from anon;
grant execute on function public.create_employee(uuid, text, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- list_employees -- sanitized roster.
--
-- pin_hash is not in the projection. It is not omitted by convention or by a
-- later filter; the column is simply never selected, so there is no code path
-- in which it could be returned.
-- ----------------------------------------------------------------------------
create or replace function public.list_employees(p_project_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller uuid;
  v_project_owner uuid;
  v_rows jsonb;
begin
  v_caller := auth.uid();

  if v_caller is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  if exists (select 1 from public.paired_devices d where d.auth_user_id = v_caller) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if p_project_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  select p.user_id into v_project_owner
  from public.projects p
  where p.id = p_project_id;

  if not found or v_project_owner is distinct from v_caller then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'employeeId', e.id,
        'displayName', e.display_name,
        'role', e.role,
        'active', e.active,
        'createdAt', e.created_at,
        'deactivatedAt', e.deactivated_at
      )
      order by e.created_at, e.id
    ),
    '[]'::jsonb
  )
  into v_rows
  from public.employees e
  where e.project_id = p_project_id;

  return jsonb_build_object('ok', true, 'employees', v_rows);
end;
$function$;

revoke all on function public.list_employees(uuid) from public;
revoke all on function public.list_employees(uuid) from anon;
grant execute on function public.list_employees(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- set_employee_active
--
-- HISTORY IS NOT DELETED. Deactivating an employee does not touch
-- employee_pos_sessions at all -- past sessions remain exactly as they were,
-- and an open one stays open. What changes is authorization:
-- get_current_employee_session filters on e.active and so stops reporting them
-- as the current operator, and employee_login's scan skips them.
--
-- Reactivation clears deactivated_at, which the biconditional check constraint
-- requires -- an active employee carrying a deactivation timestamp would be a
-- record of something that did not happen.
-- ----------------------------------------------------------------------------
create or replace function public.set_employee_active(
  p_employee_id uuid,
  p_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller uuid;
  v_employee record;
  v_active_count integer;
  v_updated record;
begin
  v_caller := auth.uid();

  if v_caller is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  if exists (select 1 from public.paired_devices d where d.auth_user_id = v_caller) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if p_employee_id is null or p_active is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  -- The join to projects is the authorization: an employee of a project the
  -- caller does not own is indistinguishable from one that does not exist.
  select e.id, e.project_id, e.active
  into v_employee
  from public.employees e
  join public.projects p on p.id = e.project_id
  where e.id = p_employee_id
    and p.user_id = v_caller;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if p_active and not v_employee.active then
    select count(*) into v_active_count
    from public.employees e
    where e.project_id = v_employee.project_id
      and e.active;

    -- Same provisional engineering ceiling as create_employee: reactivating
    -- must not be a way around it.
    if v_active_count >= 50 then
      return jsonb_build_object('ok', false, 'error', 'employee_limit_reached');
    end if;
  end if;

  update public.employees e
  set active = p_active,
      deactivated_at = case when p_active then null else coalesce(e.deactivated_at, now()) end
  where e.id = p_employee_id
  returning e.id, e.display_name, e.role, e.active, e.deactivated_at into v_updated;

  return jsonb_build_object(
    'ok', true,
    'employeeId', v_updated.id,
    'displayName', v_updated.display_name,
    'role', v_updated.role,
    'active', v_updated.active,
    'deactivatedAt', v_updated.deactivated_at
  );
end;
$function$;

revoke all on function public.set_employee_active(uuid, boolean) from public;
revoke all on function public.set_employee_active(uuid, boolean) from anon;
grant execute on function public.set_employee_active(uuid, boolean) to authenticated;

-- ----------------------------------------------------------------------------
-- set_employee_pin -- rotate one employee's PIN.
--
-- Excludes the employee being changed from the duplicate check, so re-setting
-- someone to the PIN they already have is not reported as a collision with
-- themselves.
-- ----------------------------------------------------------------------------
create or replace function public.set_employee_pin(
  p_employee_id uuid,
  p_pin text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller uuid;
  v_employee record;
begin
  v_caller := auth.uid();

  if v_caller is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  if exists (select 1 from public.paired_devices d where d.auth_user_id = v_caller) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if p_employee_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  select e.id, e.project_id
  into v_employee
  from public.employees e
  join public.projects p on p.id = e.project_id
  where e.id = p_employee_id
    and p.user_id = v_caller;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_pin');
  end if;

  if public.employee_project_pin_taken(v_employee.project_id, p_pin, v_employee.id) then
    return jsonb_build_object('ok', false, 'error', 'duplicate_pin');
  end if;

  update public.employees e
  set pin_hash = public.employee_pin_hash(p_pin)
  where e.id = v_employee.id;

  -- Deliberately returns no PIN material of any kind, not even a length.
  return jsonb_build_object('ok', true, 'employeeId', v_employee.id);
end;
$function$;

revoke all on function public.set_employee_pin(uuid, text) from public;
revoke all on function public.set_employee_pin(uuid, text) from anon;
grant execute on function public.set_employee_pin(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 12. Verification -- fails loudly rather than leaving a half-built identity
-- layer, and proves inertness rather than asserting it.
--
-- Two halves:
--   A. everything Feature 1A was supposed to build exists and is locked down;
--   B. everything Feature 1A was supposed to leave alone is byte-for-byte
--      unchanged from the baselines captured at the top of this file.
-- ----------------------------------------------------------------------------
do $do$
declare
  v_schema text;
  v_missing text;
  v_count integer;
  v_oid oid;
  v_hash text;
  v_row record;
  v_fn text;
  v_new_triggers text[];
  -- Callable by an ordinary signed-in caller (owner session or paired device).
  v_public_fns text[] := array[
    'employee_login',
    'get_current_employee_session',
    'employee_logout',
    'create_employee',
    'list_employees',
    'set_employee_active',
    'set_employee_pin'
  ];
  -- Callable by nobody: reachable only from inside the functions above.
  v_private_fns text[] := array[
    'employee_pin_hash',
    'employee_pin_verify',
    'employee_login_note_failure',
    'employee_project_pin_taken',
    'set_employees_updated_at'
  ];
begin
  -- ==========================================================================
  -- A1. The tables exist.
  -- ==========================================================================
  select string_agg(t, ', ') into v_missing
  from unnest(array['employees', 'employee_pos_sessions', 'employee_login_attempts']) as t
  where to_regclass(format('public.%I', t)) is null;

  if v_missing is not null then
    raise exception 'F1A: missing tables: %', v_missing;
  end if;

  -- ==========================================================================
  -- A2. No column anywhere in this feature can hold a PIN in a recoverable
  -- form. Names are not security, but a column called "pin" would mean the
  -- design had drifted, and this catches that at apply time.
  -- ==========================================================================
  select string_agg(format('%s.%s', table_name, column_name), ', ') into v_missing
  from information_schema.columns
  where table_schema = 'public'
    and table_name in ('employees', 'employee_pos_sessions', 'employee_login_attempts')
    and column_name in ('pin', 'pin_plain', 'pin_plaintext', 'pin_digest',
                        'pin_sha256', 'pin_code', 'plaintext_pin');

  if v_missing is not null then
    raise exception 'F1A: forbidden PIN-bearing columns present: %', v_missing;
  end if;

  -- ==========================================================================
  -- A3. The one-open-session-per-register invariant is a real partial unique
  -- index, not a convention.
  -- ==========================================================================
  select count(*) into v_count
  from pg_indexes
  where schemaname = 'public'
    and tablename = 'employee_pos_sessions'
    and indexname = 'employee_pos_sessions_one_open_per_device'
    and indexdef like '%UNIQUE%'
    and indexdef like '%ended_at IS NULL%';

  if v_count <> 1 then
    raise exception
      'F1A: employee_pos_sessions_one_open_per_device must be a UNIQUE index partial on ended_at IS NULL';
  end if;

  -- ==========================================================================
  -- A4. RLS is on and NO table carries a single policy.
  -- ==========================================================================
  for v_row in
    select t as tbl
    from unnest(array['employees', 'employee_pos_sessions', 'employee_login_attempts']) as t
  loop
    if not (select c.relrowsecurity
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname = v_row.tbl) then
      raise exception 'F1A: row level security is not enabled on %', v_row.tbl;
    end if;

    select count(*) into v_count
    from pg_policies
    where schemaname = 'public' and tablename = v_row.tbl;

    if v_count <> 0 then
      raise exception 'F1A: % must have zero policies, found %', v_row.tbl, v_count;
    end if;
  end loop;

  -- ==========================================================================
  -- A5. No role holds ANY privilege on ANY of the three tables.
  --
  -- anon covering PUBLIC is deliberate and is the same reasoning D1 used: anon
  -- inherits every PUBLIC grant, so anon holding nothing proves PUBLIC holds
  -- nothing. authenticated is included because the project OWNER's browser
  -- session is authenticated too, and pin_hash must not reach it either.
  -- ==========================================================================
  for v_row in
    select r.rolname, t.tbl, p.priv
    from (values ('anon'), ('authenticated'), ('service_role')) as r(rolname)
    cross join (values ('employees'), ('employee_pos_sessions'),
                       ('employee_login_attempts')) as t(tbl)
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
                       ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as p(priv)
  loop
    if has_table_privilege(v_row.rolname, format('public.%I', v_row.tbl), v_row.priv) then
      raise exception 'F1A: % must hold no privilege on %, but holds %',
        v_row.rolname, v_row.tbl, v_row.priv;
    end if;
  end loop;

  -- ==========================================================================
  -- A6. Every function this feature adds is SECURITY DEFINER with a locked
  -- search_path of exactly `public, pg_temp` -- never widened to an extension
  -- schema.
  -- ==========================================================================
  foreach v_fn in array (v_public_fns || v_private_fns)
  loop
    -- Reset first: SELECT INTO leaves the target untouched when nothing
    -- matches, so without this a missing function would inherit the previous
    -- iteration's oid and pass every check below.
    v_oid := null;

    select p.oid into v_oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_fn;

    if v_oid is null then
      raise exception 'F1A: function % was not created', v_fn;
    end if;

    if not (select p.prosecdef from pg_proc p where p.oid = v_oid) then
      raise exception 'F1A: % must be SECURITY DEFINER', v_fn;
    end if;

    -- Exact CONTENT, tolerant FORMATTING.
    --
    -- The existing migrations assert `cfg like 'search_path=%public%pg_temp%'`,
    -- which is right for their purpose but too loose for this one: that pattern
    -- also matches `search_path=public, extensions, pg_temp`, which is exactly
    -- the widening Feature 1A must never perform. Normalizing away whitespace
    -- and any quoting PostgreSQL may add, then comparing exactly, forbids a
    -- third schema without depending on how the setting is rendered.
    if not exists (
      select 1 from pg_proc p,
        unnest(coalesce(p.proconfig, array[]::text[])) as cfg
      where p.oid = v_oid
        and regexp_replace(cfg, '[\s"]', '', 'g') = 'search_path=public,pg_temp'
    ) then
      raise exception 'F1A: % must lock search_path to "public, pg_temp" (found %)',
        v_fn,
        coalesce((select array_to_string(p.proconfig, ',') from pg_proc p where p.oid = v_oid),
                 '<none>');
    end if;
  end loop;

  -- ==========================================================================
  -- A7. EXECUTE grants: the seven RPCs to authenticated only; the five private
  -- helpers to nobody at all.
  -- ==========================================================================
  foreach v_fn in array v_public_fns
  loop
    v_oid := null;

    select p.oid into v_oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_fn;

    if v_oid is null then
      raise exception 'F1A: function % was not created', v_fn;
    end if;

    if not has_function_privilege('authenticated', v_oid, 'EXECUTE') then
      raise exception 'F1A: authenticated must be able to execute %', v_fn;
    end if;

    if has_function_privilege('anon', v_oid, 'EXECUTE') then
      raise exception 'F1A: anon must NOT be able to execute %', v_fn;
    end if;

    if has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception 'F1A: service_role receives no speculative privilege on %', v_fn;
    end if;
  end loop;

  foreach v_fn in array v_private_fns
  loop
    v_oid := null;

    select p.oid into v_oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_fn;

    if v_oid is null then
      raise exception 'F1A: function % was not created', v_fn;
    end if;

    for v_row in select r from unnest(array['anon', 'authenticated', 'service_role']) as r
    loop
      if has_function_privilege(v_row.r, v_oid, 'EXECUTE') then
        raise exception 'F1A: % is private and % must not be able to execute it',
          v_fn, v_row.r;
      end if;
    end loop;
  end loop;

  -- ==========================================================================
  -- A8. The hashing helpers really do call pgcrypto, SCHEMA-QUALIFIED, and they
  -- really work. This is the compensating control for building those two bodies
  -- through format(): a parse check could never establish either fact.
  -- ==========================================================================
  select n.nspname into v_schema
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pgcrypto';

  if v_schema is null then
    raise exception 'F1A: pgcrypto disappeared during this migration';
  end if;

  foreach v_fn in array array['employee_pin_hash', 'employee_pin_verify']
  loop
    v_oid := null;

    select p.oid into v_oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_fn;

    if position(format('%I.crypt(', v_schema) in pg_get_functiondef(v_oid)) = 0 then
      raise exception
        'F1A: % must call crypt() qualified with the resolved pgcrypto schema (%)',
        v_fn, v_schema;
    end if;
  end loop;

  if position(format('%I.gen_salt(', v_schema) in
              pg_get_functiondef('public.employee_pin_hash(text)'::regprocedure)) = 0 then
    raise exception 'F1A: employee_pin_hash must call gen_salt() schema-qualified';
  end if;

  -- Live round trip.
  v_hash := public.employee_pin_hash('1234');

  if v_hash is null or left(v_hash, 2) <> '$2' or length(v_hash) <> 60 then
    raise exception 'F1A: employee_pin_hash did not produce a 60-character bcrypt string';
  end if;

  if v_hash = public.employee_pin_hash('1234') then
    raise exception 'F1A: employee_pin_hash is deterministic -- the salt is not being applied';
  end if;

  if not public.employee_pin_verify('1234', v_hash) then
    raise exception 'F1A: employee_pin_verify rejected the correct PIN';
  end if;

  if public.employee_pin_verify('4321', v_hash) then
    raise exception 'F1A: employee_pin_verify accepted the wrong PIN';
  end if;

  if public.employee_pin_verify('1234', encode(sha256('1234'::bytea), 'hex')) then
    raise exception 'F1A: employee_pin_verify accepted a fast digest as a stored hash';
  end if;

  if public.employee_pin_verify('1234', '1234') then
    raise exception 'F1A: employee_pin_verify accepted a plaintext PIN as a stored hash';
  end if;

  -- ==========================================================================
  -- B1. paired_devices is untouched -- no row written, nothing renumbered.
  -- ==========================================================================
  if (select count(*) from public.paired_devices)
     is distinct from (select n from f1a_paired_devices_baseline) then
    raise exception 'F1A: paired_devices row count changed';
  end if;

  if (select coalesce(md5(string_agg(md5(d::text), '|' order by d.id::text)), 'empty')
      from public.paired_devices d)
     is distinct from (select fp from f1a_paired_devices_baseline) then
    raise exception 'F1A: paired_devices rows changed';
  end if;

  -- ==========================================================================
  -- B2. No pre-existing privilege moved, on any operational or pairing table.
  -- ==========================================================================
  for v_row in
    select b.rolname, b.tablename, b.priv, b.held
    from f1a_priv_baseline b
  loop
    if has_table_privilege(v_row.rolname, format('public.%I', v_row.tablename), v_row.priv)
       is distinct from v_row.held then
      raise exception 'F1A: privilege % on % for % changed',
        v_row.priv, v_row.tablename, v_row.rolname;
    end if;
  end loop;

  -- ==========================================================================
  -- B3. No pre-existing policy was added, dropped or rewritten -- in
  -- particular none of the paired_devices policies.
  -- ==========================================================================
  select count(*) into v_count from f1a_pol_baseline;

  if (select count(*) from pg_policies where schemaname = 'public') <> v_count then
    raise exception 'F1A: the set of public policies changed';
  end if;

  if exists (
    select 1
    from f1a_pol_baseline b
    full outer join (
      select tablename, policyname, cmd, qual, with_check, roles::text as roles
      from pg_policies where schemaname = 'public'
    ) c
      on c.tablename = b.tablename and c.policyname = b.policyname
    where c.policyname is null
       or b.policyname is null
       or c.cmd is distinct from b.cmd
       or c.qual is distinct from b.qual
       or c.with_check is distinct from b.with_check
       or c.roles is distinct from b.roles
  ) then
    raise exception 'F1A: an existing policy definition changed';
  end if;

  -- ==========================================================================
  -- B4. No pre-existing function changed body, security posture, locked
  -- search_path or EXECUTE grants. This is what proves complete_sale,
  -- complete_sale_v2/v3/v4, resolve_sale_owner and every pairing RPC are
  -- untouched, without having to enumerate them.
  -- ==========================================================================
  for v_row in
    select b.fn_oid, b.proname, b.body, b.prosecdef, b.config, b.acl
    from f1a_proc_baseline b
  loop
    if not exists (select 1 from pg_proc p where p.oid = v_row.fn_oid) then
      raise exception 'F1A: pre-existing function % was dropped', v_row.proname;
    end if;

    if (select md5(pg_get_functiondef(p.oid)) from pg_proc p where p.oid = v_row.fn_oid)
       is distinct from v_row.body then
      raise exception 'F1A: pre-existing function % changed body', v_row.proname;
    end if;

    if (select p.prosecdef from pg_proc p where p.oid = v_row.fn_oid)
       is distinct from v_row.prosecdef then
      raise exception 'F1A: pre-existing function % changed security posture', v_row.proname;
    end if;

    if (select coalesce(p.proconfig, array[]::text[]) from pg_proc p where p.oid = v_row.fn_oid)
       is distinct from v_row.config then
      raise exception 'F1A: pre-existing function % changed search_path', v_row.proname;
    end if;

    if (select coalesce(p.proacl::text, 'default') from pg_proc p where p.oid = v_row.fn_oid)
       is distinct from v_row.acl then
      raise exception 'F1A: pre-existing function % changed EXECUTE grants', v_row.proname;
    end if;
  end loop;

  -- ==========================================================================
  -- B5. Exactly one new trigger, on the new table, and every pre-existing
  -- trigger -- paired_devices_guard_immutable above all -- is unchanged.
  -- ==========================================================================
  for v_row in select b.relname, b.tgname, b.tgtype, b.tgenabled, b.proname from f1a_trg_baseline b
  loop
    if not exists (
      select 1
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_proc pr on pr.oid = t.tgfoid
      where n.nspname = 'public'
        and not t.tgisinternal
        and c.relname = v_row.relname
        and t.tgname = v_row.tgname
        and t.tgtype = v_row.tgtype
        and t.tgenabled = v_row.tgenabled
        and pr.proname = v_row.proname
    ) then
      raise exception 'F1A: pre-existing trigger %.% changed or was removed',
        v_row.relname, v_row.tgname;
    end if;
  end loop;

  select array_agg(tgname order by tgname) into v_new_triggers
  from (
    select t.tgname
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not t.tgisinternal
    except
    select b.tgname from f1a_trg_baseline b
  ) s;

  if v_new_triggers is distinct from array['employees_set_updated_at'] then
    raise exception 'F1A: unexpected set of new triggers: %',
      coalesce(array_to_string(v_new_triggers, ', '), '<none>');
  end if;

  raise notice 'F1A: employee identity and till session foundation verified.';
end
$do$;
