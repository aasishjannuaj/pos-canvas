-- v1.3 Feature 1B-RUNTIME, CP2a — the authoritative business timezone.
--
-- WHAT THIS IS FOR. The daily register model coming in CP2b needs one question
-- answered truthfully: what calendar date is it, at this business? Nothing in
-- this system could answer that before now. There is no timezone column, no
-- timezone in the published config, and no timezone reaching a till; every
-- existing date display quietly uses the BROWSER's clock — lib/dateRange.ts and
-- ProjectDashboard both say so in their own comments.
--
-- A browser's clock cannot own a business day. A till taken on holiday, a
-- laptop with the wrong region, a Windows machine that never had its timezone
-- set, an Android device roaming across a border — each would silently file
-- takings under the wrong date, and nothing downstream would notice. So the
-- answer belongs to the BUSINESS, stored beside it, read by the server.
--
-- THIS MIGRATION ADDS NO REGISTER BEHAVIOUR. No daily rows, no ensure
-- function, no complete_sale_v5 change. It adds the column, the validation that
-- makes the column trustworthy, and the two calendar helpers CP2b will build
-- on. Nothing else reads it yet.
--
-- NULL IS A LEGITIMATE STATE, AND DELIBERATELY SO. Every existing project has
-- no timezone and there is no honest way to guess one: not from UTC, not from
-- the server, not from an address, not from a phone number. A wrong guess is
-- worse than an absence, because an absence can be detected and a guess cannot.
-- So the column is nullable with no default, and the daily-context work will
-- refuse to proceed rather than invent one.

-- ----------------------------------------------------------------------------
-- 1. The column.
-- ----------------------------------------------------------------------------
alter table public.projects
  add column if not exists business_timezone text;

comment on column public.projects.business_timezone is
  'v1.3 CP2a -- the IANA timezone whose calendar date defines this business''s '
  'day, e.g. America/New_York. NULL until an owner sets it; never guessed. '
  'Validated by projects_validate_business_timezone against pg_timezone_names. '
  'The SERVER reads this; a browser, Android or Windows clock is never authority.';

-- ----------------------------------------------------------------------------
-- 2. What counts as a valid business timezone.
--
-- NOT SIMPLY "IS IT IN pg_timezone_names". That view is a mixture, and two of
-- the things in it would quietly destroy a business day:
--
--   America/New_York   Jan 07:00  Jul 08:00   <- observes DST
--   US/Eastern         Jan 07:00  Jul 08:00   <- link to the above, also fine
--   EST                Jan 07:00  Jul 07:00   <- FIXED OFFSET, no DST
--   Etc/GMT+5          Jan 07:00  Jul 07:00   <- FIXED OFFSET, and sign-inverted
--
-- (Those are measured values, not assumptions.) A business in New York that
-- stored `EST` would be an hour out for eight months of the year: sales taken
-- after 11pm in summer would be filed under the wrong calendar date, every
-- night, and nothing would look broken. `Etc/GMT+5` is worse again -- the POSIX
-- sign convention means GMT+5 is UTC MINUS five, so a naive owner picking it
-- for a UTC+5 business would be ten hours wrong.
--
-- So the rule is: a name PostgreSQL recognises, in Region/City form, outside
-- the Etc/ namespace. That admits every real geographic zone --
-- America/New_York, America/Indiana/Indianapolis, Europe/London,
-- Australia/Sydney, Pacific/Auckland -- and excludes exactly the fixed-offset
-- traps and the bare legacy names (EST, MST, CET, UTC, GMT, Japan, Egypt).
--
-- NOTHING IS NORMALISED. The value is stored exactly as given. PostgreSQL
-- exposes no canonical/alias flag, so distinguishing `US/Eastern` from
-- `America/New_York` would mean shipping our own copy of the IANA link table --
-- a private scheme that would rot on its own schedule and silently disagree
-- with the database underneath it. Storing verbatim keeps one authority.
-- `US/Eastern` therefore remains acceptable: it resolves identically, as the
-- measurements above show.
--
-- STABLE, not IMMUTABLE: the tz database can change under us between releases.
-- That is also why this cannot be a CHECK constraint, and why the trigger in
-- section 3 exists instead.
-- ----------------------------------------------------------------------------
create or replace function public.is_valid_business_timezone(p_timezone text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog, pg_temp
as $function$
  select p_timezone is not null
     and p_timezone like '%/%'
     and p_timezone not like 'Etc/%'
     and exists (select 1 from pg_catalog.pg_timezone_names t where t.name = p_timezone);
$function$;

revoke all on function public.is_valid_business_timezone(text) from public;
revoke all on function public.is_valid_business_timezone(text) from anon;
revoke all on function public.is_valid_business_timezone(text) from service_role;
grant execute on function public.is_valid_business_timezone(text) to authenticated;

-- ----------------------------------------------------------------------------
-- 3. The database is the authority, not the client.
--
-- A TRIGGER RATHER THAN A CHECK CONSTRAINT, because the validation reads a
-- system catalogue: a CHECK may not contain a subquery, and the tz database is
-- not immutable across releases. A trigger is the narrowest mechanism that
-- still makes the rule impossible to bypass -- including by a direct table
-- write from an owner's own session, which is exactly how projects are edited
-- today (RLS-protected table access, no RPC).
--
-- It fires only when the value actually changes, so an ordinary project update
-- that never mentions the timezone costs nothing and cannot be broken by a
-- future tz-database change invalidating a name stored years ago.
-- ----------------------------------------------------------------------------
create or replace function public.projects_validate_business_timezone()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $function$
begin
  -- NULL is allowed and means "not set yet". It is not an error, and it is not
  -- a licence to guess: the daily-context work refuses instead.
  if new.business_timezone is null then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.business_timezone is not distinct from new.business_timezone then
    return new;
  end if;

  if not public.is_valid_business_timezone(new.business_timezone) then
    raise exception
      'Invalid business timezone %. Use an IANA Region/City name such as America/New_York.',
      new.business_timezone
      using errcode = 'invalid_parameter_value';
  end if;

  return new;
end;
$function$;

revoke all on function public.projects_validate_business_timezone() from public;
revoke all on function public.projects_validate_business_timezone() from anon;
revoke all on function public.projects_validate_business_timezone() from service_role;

drop trigger if exists projects_validate_business_timezone on public.projects;

create trigger projects_validate_business_timezone
  before insert or update of business_timezone on public.projects
  for each row
  execute function public.projects_validate_business_timezone();

-- ----------------------------------------------------------------------------
-- 4. The calendar foundation CP2b will build on.
--
-- CALENDAR-FIRST, NEVER ARITHMETIC. The half-open interval of a business day is
-- taken by converting the local date's midnight through the zone, and the NEXT
-- LOCAL DATE's midnight through the zone -- not by adding 24 hours to the
-- first. A business day is a calendar fact, and calendars are not uniform:
--
--   2026-03-08 America/New_York  spring forward  ->  23 hours
--   2026-11-01 America/New_York  fall back       ->  25 hours
--
-- Adding an interval would make both of those exactly 24 hours, which would put
-- the last hour of a spring-forward day into the wrong business date and lose
-- an hour of a fall-back day entirely.
--
-- HALF-OPEN [starts_at, ends_at). The end is the next day's start, so the two
-- days touch with no gap and no overlap -- which is what makes
-- complete_sale_v5's existing offline containment test (opened_at <= t <
-- closed_at) resolve every instant to exactly one day.
--
-- Returns nothing for an invalid zone rather than raising: the caller decides
-- whether a missing day is an error, and CP2b's caller will already have
-- required the timezone through section 5.
-- ----------------------------------------------------------------------------
create or replace function public.business_day_bounds(
  p_business_date date,
  p_timezone text
)
returns table (starts_at timestamptz, ends_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_catalog, pg_temp
as $function$
  select
    (p_business_date::timestamp) at time zone p_timezone,
    ((p_business_date + 1)::timestamp) at time zone p_timezone
  where public.is_valid_business_timezone(p_timezone)
    and p_business_date is not null;
$function$;

revoke all on function public.business_day_bounds(date, text) from public;
revoke all on function public.business_day_bounds(date, text) from anon;
revoke all on function public.business_day_bounds(date, text) from service_role;
grant execute on function public.business_day_bounds(date, text) to authenticated;

/**
 * The business date of an instant, in a business's own zone.
 *
 * The inverse of the bounds above, and the thing CP2b will call with
 * clock_timestamp() for a live sale and with a queued sale's occurred_at when
 * it syncs. Kept here so both directions of the conversion live together and
 * cannot drift apart.
 */
create or replace function public.business_date_of(
  p_at timestamptz,
  p_timezone text
)
returns date
language sql
stable
security definer
set search_path = public, pg_catalog, pg_temp
as $function$
  select case
           when public.is_valid_business_timezone(p_timezone) and p_at is not null
             then (p_at at time zone p_timezone)::date
         end;
$function$;

revoke all on function public.business_date_of(timestamptz, text) from public;
revoke all on function public.business_date_of(timestamptz, text) from anon;
revoke all on function public.business_date_of(timestamptz, text) from service_role;
grant execute on function public.business_date_of(timestamptz, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 5. The domain failure CP2b needs, established once.
--
-- `business_timezone_required` is the stable answer for "this business has not
-- told us what day it is". It exists here so that every future caller raises
-- the SAME error rather than each inventing its own, and so the decision to
-- refuse rather than guess is written down in one place.
--
-- SECURITY DEFINER because it reads projects, which is RLS-protected: a device
-- RPC in CP2b will need the project's timezone without the device having any
-- right to read the projects table. It takes a project id and returns only the
-- timezone -- no name, no owner, no configuration.
-- ----------------------------------------------------------------------------
create or replace function public.require_business_timezone(p_project_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_catalog, pg_temp
as $function$
declare
  v_timezone text;
begin
  select p.business_timezone into v_timezone
  from public.projects p
  where p.id = p_project_id;

  if not found then
    -- Indistinguishable from "no timezone set". A caller holding a project id
    -- it has no right to must not learn whether the project exists.
    raise exception 'business_timezone_required'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_timezone is null then
    raise exception 'business_timezone_required'
      using errcode = 'invalid_parameter_value';
  end if;

  return v_timezone;
end;
$function$;

revoke all on function public.require_business_timezone(uuid) from public;
revoke all on function public.require_business_timezone(uuid) from anon;
revoke all on function public.require_business_timezone(uuid) from service_role;
grant execute on function public.require_business_timezone(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 6. Verification -- fails loudly, and the whole migration rolls back with it.
-- ----------------------------------------------------------------------------
do $do$
declare
  v_text text;
  v_bounds record;
  v_hours numeric;
  v_column record;
begin
  -- A1. Nullable, no default. Every existing project stays valid.
  select column_default, is_nullable, data_type into v_column
  from information_schema.columns
  where table_schema = 'public' and table_name = 'projects'
    and column_name = 'business_timezone';

  if not found then
    raise exception 'projects.business_timezone is missing.';
  end if;

  if v_column.column_default is not null then
    raise exception
      'projects.business_timezone must have no default, found %.', v_column.column_default;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'projects'
      and column_name = 'business_timezone' and is_nullable = 'NO'
  ) then
    raise exception 'projects.business_timezone must be nullable.';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'projects'
      and column_name = 'business_timezone' and data_type <> 'text'
  ) then
    raise exception 'projects.business_timezone must be text.';
  end if;

  -- A2. The validator accepts real geographic zones.
  foreach v_text in array array[
    'America/New_York', 'America/Indiana/Indianapolis', 'Europe/London',
    'Australia/Sydney', 'Pacific/Auckland', 'Asia/Kolkata', 'US/Eastern'
  ]
  loop
    if not public.is_valid_business_timezone(v_text) then
      raise exception 'is_valid_business_timezone rejected the real zone %.', v_text;
    end if;
  end loop;

  -- A3. And refuses the fixed-offset traps, which observe no DST.
  foreach v_text in array array[
    'EST', 'MST', 'CET', 'UTC', 'GMT', 'Etc/GMT+5', 'Etc/UTC', 'Japan',
    'localtime', 'Not/AZone', '', 'America/New_York '
  ]
  loop
    if public.is_valid_business_timezone(v_text) then
      raise exception 'is_valid_business_timezone accepted %, which is not a safe business zone.', v_text;
    end if;
  end loop;

  if public.is_valid_business_timezone(null) then
    raise exception 'is_valid_business_timezone(null) must be false.';
  end if;

  -- A4. The trigger exists and fires on the column.
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.projects'::regclass
      and tgname = 'projects_validate_business_timezone'
      and not tgisinternal
  ) then
    raise exception 'The business timezone trigger is missing.';
  end if;

  -- A5. CALENDAR, NOT ARITHMETIC. An ordinary day is 24 hours, a spring-forward
  -- day is 23 and a fall-back day is 25. If any of these were computed by
  -- adding an interval, all three would be 24.
  select * into v_bounds from public.business_day_bounds(date '2026-09-18', 'America/New_York');
  v_hours := extract(epoch from (v_bounds.ends_at - v_bounds.starts_at)) / 3600;

  if v_hours <> 24 then
    raise exception 'An ordinary New York day measured % hours.', v_hours;
  end if;

  select * into v_bounds from public.business_day_bounds(date '2026-03-08', 'America/New_York');
  v_hours := extract(epoch from (v_bounds.ends_at - v_bounds.starts_at)) / 3600;

  if v_hours <> 23 then
    raise exception 'The spring-forward day measured % hours; it must be 23.', v_hours;
  end if;

  select * into v_bounds from public.business_day_bounds(date '2026-11-01', 'America/New_York');
  v_hours := extract(epoch from (v_bounds.ends_at - v_bounds.starts_at)) / 3600;

  if v_hours <> 25 then
    raise exception 'The fall-back day measured % hours; it must be 25.', v_hours;
  end if;

  -- A6. Days touch exactly: one day's end is the next day's start, so every
  -- instant belongs to exactly one business date.
  if (select ends_at from public.business_day_bounds(date '2026-12-31', 'America/New_York'))
     <> (select starts_at from public.business_day_bounds(date '2027-01-01', 'America/New_York')) then
    raise exception 'The year boundary leaves a gap or an overlap.';
  end if;

  -- A7. The two directions agree.
  if public.business_date_of(
       (select starts_at from public.business_day_bounds(date '2026-03-08', 'America/New_York')),
       'America/New_York') <> date '2026-03-08' then
    raise exception 'business_date_of disagrees with business_day_bounds.';
  end if;

  -- A8. An invalid zone yields nothing rather than a wrong answer.
  if exists (select 1 from public.business_day_bounds(date '2026-09-18', 'Not/AZone')) then
    raise exception 'business_day_bounds answered for an invalid timezone.';
  end if;

  if public.business_date_of(now(), 'EST') is not null then
    raise exception 'business_date_of answered for a fixed-offset zone.';
  end if;

  -- A9. Every function added here is SECURITY DEFINER with a locked
  -- search_path, and none is executable by anon or service_role.
  foreach v_text in array array[
    'is_valid_business_timezone', 'business_day_bounds', 'business_date_of',
    'require_business_timezone', 'projects_validate_business_timezone'
  ]
  loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_text
        and p.prosecdef
        and p.proconfig @> array['search_path=public, pg_catalog, pg_temp']
    ) then
      raise exception '% is not SECURITY DEFINER with a locked search_path.', v_text;
    end if;

    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_text
        and array_to_string(p.proacl, ',') ~ '(anon|service_role)='
    ) then
      raise exception '% is granted to anon or service_role.', v_text;
    end if;
  end loop;

  -- A10. Untouched: this migration adds no register behaviour.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'register_sessions'
      and column_name in ('business_date', 'business_timezone', 'is_daily')
  ) then
    raise exception 'CP2a must not add daily-register columns; that is CP2b.';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'ensure_daily_register_context'
  ) then
    raise exception 'CP2a must not create ensure_daily_register_context; that is CP2b.';
  end if;
end;
$do$;
