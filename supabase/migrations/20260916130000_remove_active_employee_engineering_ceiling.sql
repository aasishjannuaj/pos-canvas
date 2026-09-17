-- v1.3 Feature 1A.1 follow-up — remove the temporary engineering active-employee
-- safeguard after staging performance validation.
--
-- FORWARD MIGRATION. 20260914120000 and 20260916120000 are applied to staging
-- and immutable. This file redefines exactly two functions and nothing else:
--
--   * create_employee(uuid, text, text, text)
--   * set_employee_active(uuid, boolean)
--
-- It is NOT applied automatically -- review, then apply manually, as ONE SQL
-- Editor submission (one session).
--
-- ----------------------------------------------------------------------------
-- WHY THE SAFEGUARD EXISTED, AND WHY IT IS NO LONGER NEEDED
-- ----------------------------------------------------------------------------
-- 20260914120000 introduced `if v_active_count >= 50 then ... 'employee_limit_reached'`
-- in create_employee, and the same check on reactivation in
-- set_employee_active. It was a technical guard, never a product rule: the
-- original PIN-only login verified the submitted PIN against every active
-- salted hash, and duplicate-PIN enforcement verified a candidate against every
-- employee on each create and PIN reset. Bounding the active roster bounded that
-- bcrypt work.
--
-- 20260916120000 removed both of those paths. Staging validation of it measured
-- employee_login(uuid, text) at a flat ~60 ms of database execution time at 1,
-- 5, 10, 20 and 50 active employees, and at a 260-employee stress roster, for
-- first, middle and last selector positions and for wrong PINs alike;
-- create_employee measured flat as well. No request path left in the employee
-- contract performs work proportional to the number of employees except the
-- selector, whose cost is the rows it returns. The safeguard therefore bounds
-- nothing and is removed here.
--
-- ----------------------------------------------------------------------------
-- WHAT CHANGES, EXACTLY
-- ----------------------------------------------------------------------------
-- create_employee:     the v_active_count variable, the active-employee count
--                      query, and the employee_limit_reached branch are removed.
-- set_employee_active: the v_active_count variable and the reactivation block
--                      that counted active employees and returned
--                      employee_limit_reached are removed.
--
-- Everything else in both functions is carried over unchanged: caller and
-- ownership checks, paired-device rejection, not_found behaviour, validation,
-- salted hashing, the active/deactivated_at transition, and the returned fields.
-- No replacement count, threshold or other roster-size rule is introduced, and
-- the verification block below proves that structurally rather than by looking
-- for one particular number.
--
-- Nothing else is touched: the selector, single-hash login, the two-layer
-- limiter and its constants, duplicate-PIN support, sessions, the
-- one-open-session index, RLS and every privilege are verified unchanged.

-- ----------------------------------------------------------------------------
-- 0. Self-capturing baselines, recorded BEFORE any DDL.
-- ----------------------------------------------------------------------------
create temporary table f1a2_proc_baseline as
select p.oid as fn_oid,
       p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       md5(pg_get_functiondef(p.oid)) as body,
       p.prosecdef,
       coalesce(p.proconfig, array[]::text[]) as config,
       coalesce(p.proacl::text, 'default') as acl
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f'
  and p.proname not in ('create_employee', 'set_employee_active');

create temporary table f1a2_redefined_acl_baseline as
select p.proname, coalesce(p.proacl::text, 'default') as acl
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('create_employee', 'set_employee_active');

create temporary table f1a2_pol_baseline as
select tablename, policyname, cmd, qual, with_check, roles::text as roles
from pg_policies
where schemaname = 'public';

create temporary table f1a2_priv_baseline as
select r.rolname, t.tablename, p.priv,
       has_table_privilege(r.rolname, format('public.%I', t.tablename), p.priv) as held
from (values ('anon'), ('authenticated'), ('service_role')) as r(rolname)
cross join (values ('paired_devices'), ('device_pairing_tokens'), ('projects'),
                   ('orders'), ('order_items'), ('inventory_transactions'),
                   ('build_jobs'), ('build_artifacts'),
                   ('employees'), ('employee_pos_sessions'),
                   ('employee_login_employee_attempts'),
                   ('employee_login_device_failures'),
                   ('employee_login_device_throttles')) as t(tablename)
cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
                   ('REFERENCES'), ('TRIGGER')) as p(priv);

create temporary table f1a2_rls_baseline as
select c.relname, c.relrowsecurity
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r';

create temporary table f1a2_trg_baseline as
select c.relname, t.tgname, t.tgtype, t.tgenabled, pr.proname
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_proc pr on pr.oid = t.tgfoid
where n.nspname = 'public' and not t.tgisinternal;

create temporary table f1a2_idx_baseline as
select tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public';

create temporary table f1a2_row_baseline as
select (select count(*) from public.paired_devices) as devices,
       (select coalesce(md5(string_agg(md5(d::text), '|' order by d.id::text)), 'empty')
        from public.paired_devices d) as devices_fp,
       (select count(*) from public.employees) as employees,
       (select coalesce(md5(string_agg(md5(e::text), '|' order by e.id::text)), 'empty')
        from public.employees e) as employees_fp,
       (select count(*) from public.employee_pos_sessions) as sessions,
       (select coalesce(md5(string_agg(md5(s::text), '|' order by s.id::text)), 'empty')
        from public.employee_pos_sessions s) as sessions_fp,
       (select count(*) from public.employee_login_employee_attempts) as emp_attempts,
       (select count(*) from public.employee_login_device_failures) as dev_failures,
       (select count(*) from public.employee_login_device_throttles) as dev_throttles,
       (select md5(string_agg(table_name || '.' || column_name || ':' || data_type, ','
                              order by table_name, ordinal_position))
        from information_schema.columns
        where table_schema = 'public'
          and table_name in ('employees', 'employee_pos_sessions',
                             'employee_login_employee_attempts',
                             'employee_login_device_failures',
                             'employee_login_device_throttles')) as employee_columns;

-- ----------------------------------------------------------------------------
-- 1. create_employee -- identical to its 20260916120000 definition except that
-- the engineering active-employee safeguard is removed.
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

  -- Never trimmed or padded into validity.
  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_pin');
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
revoke all on function public.create_employee(uuid, text, text, text) from service_role;
grant execute on function public.create_employee(uuid, text, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 2. set_employee_active -- identical to its 20260914120000 definition except
-- that the engineering safeguard on reactivation is removed.
--
-- History is still never deleted: past and open sessions are not touched, and
-- reactivation still clears deactivated_at as the biconditional check requires.
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
revoke all on function public.set_employee_active(uuid, boolean) from service_role;
grant execute on function public.set_employee_active(uuid, boolean) to authenticated;

-- ----------------------------------------------------------------------------
-- 3. Verification -- fails loudly, and the whole migration rolls back with it.
-- ----------------------------------------------------------------------------
do $do$
declare
  v_def text;
  v_code text;
  v_sig text;
  v_oid oid;
  v_row record;
  v_count integer;
  v_codes text[];
  v_allowed text[];
  v_text text;
  v_new_triggers text[];
  v_role text;
  v_tbl text;
begin
  -- ==========================================================================
  -- A1. The earlier employee migrations are in effect.
  -- ==========================================================================
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    select count(*) into v_count
    from supabase_migrations.schema_migrations
    where version in ('20260914120000', '20260916120000');

    if v_count <> 2 then
      raise exception 'F1A.2: expected 20260914120000 and 20260916120000 in the ledger, found % of 2', v_count;
    end if;
  end if;

  -- Feature 1A objects.
  foreach v_text in array array['employees', 'employee_pos_sessions']
  loop
    if to_regclass(format('public.%I', v_text)) is null then
      raise exception 'F1A.2: Feature 1A table % is missing', v_text;
    end if;
  end loop;

  -- Feature 1A.1 objects, and what it retired.
  foreach v_text in array array['employee_login_employee_attempts',
                                'employee_login_device_failures',
                                'employee_login_device_throttles']
  loop
    if to_regclass(format('public.%I', v_text)) is null then
      raise exception 'F1A.2: Feature 1A.1 table % is missing', v_text;
    end if;
  end loop;

  if to_regclass('public.employee_login_attempts') is not null
     or to_regprocedure('public.employee_login(text)') is not null
     or to_regprocedure('public.employee_login_note_failure(uuid,timestamptz)') is not null
     or to_regprocedure('public.employee_project_pin_taken(uuid,text,uuid)') is not null then
    raise exception 'F1A.2: an object retired by 20260916120000 has reappeared';
  end if;

  -- ==========================================================================
  -- A2. Both redefined functions: present, SECURITY DEFINER, exact search_path,
  -- authenticated only, and the same ACL they had before this migration.
  -- ==========================================================================
  foreach v_sig in array array['public.create_employee(uuid,text,text,text)',
                               'public.set_employee_active(uuid,boolean)']
  loop
    if to_regprocedure(v_sig) is null then
      raise exception 'F1A.2: % is missing', v_sig;
    end if;

    v_oid := to_regprocedure(v_sig)::oid;

    if not (select p.prosecdef from pg_proc p where p.oid = v_oid) then
      raise exception 'F1A.2: % must be SECURITY DEFINER', v_sig;
    end if;

    if not exists (
      select 1 from pg_proc p, unnest(coalesce(p.proconfig, array[]::text[])) as cfg
      where p.oid = v_oid
        and regexp_replace(cfg, '[\s"]', '', 'g') = 'search_path=public,pg_temp'
    ) then
      raise exception 'F1A.2: % must lock search_path to exactly public, pg_temp', v_sig;
    end if;

    if not has_function_privilege('authenticated', v_oid, 'EXECUTE') then
      raise exception 'F1A.2: authenticated must be able to execute %', v_sig;
    end if;

    foreach v_role in array array['anon', 'service_role']
    loop
      if has_function_privilege(v_role, v_oid, 'EXECUTE') then
        raise exception 'F1A.2: % must NOT be able to execute %', v_role, v_sig;
      end if;
    end loop;

    if exists (
      select 1
      from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as a
      where p.oid = v_oid and a.grantee = 0 and a.privilege_type = 'EXECUTE'
    ) then
      raise exception 'F1A.2: PUBLIC must NOT be able to execute %', v_sig;
    end if;

    if (select coalesce(p.proacl::text, 'default') from pg_proc p where p.oid = v_oid)
       is distinct from
       (select b.acl from f1a2_redefined_acl_baseline b
        where b.proname = (select p.proname from pg_proc p where p.oid = v_oid)) then
      raise exception 'F1A.2: the EXECUTE grants of % changed', v_sig;
    end if;
  end loop;

  -- ==========================================================================
  -- A3. THE SAFEGUARD IS GONE, AND NOTHING REPLACED IT.
  --
  -- Checked on the definition with string literals and comments removed, so a
  -- rule cannot hide in prose and prose cannot trip a rule:
  --   * no employee_limit_reached anywhere;
  --   * no count( of any kind;
  --   * no comparison against a numeric literal of any value;
  --   * no identifier naming an active count, roster size, ceiling or limit;
  --   * no additional read of public.employees beyond what authorization needs;
  --   * no error code outside the function's known set -- so a replacement
  --     rejection under a new name fails too.
  -- ==========================================================================
  for v_row in
    select * from (values
      ('public.create_employee(uuid,text,text,text)', 0,
       array['invalid_display_name', 'invalid_pin', 'invalid_role',
             'not_authenticated', 'not_found']),
      ('public.set_employee_active(uuid,boolean)', 1,
       array['not_authenticated', 'not_found'])
    ) as x(sig, employee_reads, codes)
  loop
    v_def := pg_get_functiondef(v_row.sig::regprocedure);
    v_code := regexp_replace(v_def, '--[^\n]*', '', 'g');
    v_code := regexp_replace(v_code, '''[^'']*''', '''''', 'g');

    if position('employee_limit_reached' in v_def) > 0 then
      raise exception 'F1A.2: % still returns employee_limit_reached', v_row.sig;
    end if;

    if v_code ~* '\mcount\s*\(' then
      raise exception 'F1A.2: % still counts rows', v_row.sig;
    end if;

    if v_code ~ '(>=|<=|<>|!=|=|<|>)\s*[0-9]+' then
      raise exception 'F1A.2: % compares against a numeric literal', v_row.sig;
    end if;

    if v_code ~* '(active_count|roster|ceiling|max_employee|employee_limit|\mlimit\M)' then
      raise exception 'F1A.2: % names a count, roster, ceiling or limit', v_row.sig;
    end if;

    v_count := (length(v_code) - length(replace(v_code, 'from public.employees', '')))
               / length('from public.employees');

    if v_count <> v_row.employee_reads then
      raise exception 'F1A.2: % reads public.employees % time(s), expected %',
        v_row.sig, v_count, v_row.employee_reads;
    end if;

    select coalesce(array_agg(distinct m[1] order by m[1]), array[]::text[]) into v_codes
    from regexp_matches(v_def, '''error'',\s*''([a-z_]+)''', 'g') as m;

    v_allowed := v_row.codes;

    if not (v_codes <@ v_allowed and v_codes @> v_allowed) then
      raise exception 'F1A.2: % error codes are %, expected exactly %', v_row.sig, v_codes, v_allowed;
    end if;
  end loop;

  -- ==========================================================================
  -- A4. Everything else in the two functions is preserved.
  -- ==========================================================================
  v_def := pg_get_functiondef('public.create_employee(uuid,text,text,text)'::regprocedure);

  foreach v_text in array array[
    'v_caller := auth.uid();',
    'if exists (select 1 from public.paired_devices d where d.auth_user_id = v_caller) then',
    'if not found or v_project_owner is distinct from v_caller then',
    'if p_display_name is null or btrim(p_display_name) = '''' then',
    'if p_role is null or p_role not in (''owner'', ''manager'', ''cashier'') then',
    'if p_pin is null or p_pin !~ ''^[0-9]{4,6}$'' then',
    'values (p_project_id, btrim(p_display_name), p_role, public.employee_pin_hash(p_pin))',
    '''employeeId'', v_employee.id,',
    '''createdAt'', v_employee.created_at'
  ]
  loop
    if position(v_text in v_def) = 0 then
      raise exception 'F1A.2: create_employee lost: %', v_text;
    end if;
  end loop;

  v_def := pg_get_functiondef('public.set_employee_active(uuid,boolean)'::regprocedure);

  foreach v_text in array array[
    'v_caller := auth.uid();',
    'if exists (select 1 from public.paired_devices d where d.auth_user_id = v_caller) then',
    'if p_employee_id is null or p_active is null then',
    'join public.projects p on p.id = e.project_id',
    'and p.user_id = v_caller;',
    'set active = p_active,',
    'deactivated_at = case when p_active then null else coalesce(e.deactivated_at, now()) end',
    '''deactivatedAt'', v_updated.deactivated_at'
  ]
  loop
    if position(v_text in v_def) = 0 then
      raise exception 'F1A.2: set_employee_active lost: %', v_text;
    end if;
  end loop;

  if position('employee_pos_sessions' in v_def) > 0 then
    raise exception 'F1A.2: set_employee_active must not touch session history';
  end if;

  -- ==========================================================================
  -- A5. Duplicate PINs are still legal: no scan, no helper, no error.
  -- ==========================================================================
  foreach v_sig in array array['public.create_employee(uuid,text,text,text)',
                               'public.set_employee_pin(uuid,text)']
  loop
    v_def := pg_get_functiondef(v_sig::regprocedure);

    if position('employee_pin_verify' in v_def) > 0
       or position('employee_project_pin_taken' in v_def) > 0
       or position('duplicate_pin' in v_def) > 0
       or v_def ~* '\mloop\M' then
      raise exception 'F1A.2: % performs duplicate-PIN enforcement again', v_sig;
    end if;

    if position('public.employee_pin_hash(p_pin)' in v_def) = 0 then
      raise exception 'F1A.2: % must still store only a salted hash', v_sig;
    end if;
  end loop;

  -- ==========================================================================
  -- A6. Single-hash login and the selector are exactly as 20260916120000 left
  -- them.
  -- ==========================================================================
  v_def := pg_get_functiondef('public.employee_login(uuid,text)'::regprocedure);

  if (length(v_def) - length(replace(v_def, 'employee_pin_verify(', '')))
     / length('employee_pin_verify(') <> 1
     or v_def ~* '\mloop\M' or v_def ~* '\mforeach\M' then
    raise exception 'F1A.2: employee_login no longer verifies exactly one hash';
  end if;

  select count(*) into v_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
    and p.proname <> 'employee_pin_verify'
    and position('employee_pin_verify(' in pg_get_functiondef(p.oid)) > 0;

  if v_count <> 1 then
    raise exception 'F1A.2: expected exactly one PIN-verifying function, found %', v_count;
  end if;

  v_def := pg_get_functiondef('public.list_login_employees()'::regprocedure);

  if position('jsonb_build_object(''employeeId'', e.id, ''displayName'', e.display_name)' in v_def) = 0
     or position('order by e.display_name, e.id' in v_def) = 0
     or regexp_replace(v_def, '''[^'']*''', '''''', 'g') ~* '\mrole\M' then
    raise exception 'F1A.2: the selector contract changed';
  end if;

  -- ==========================================================================
  -- A7. Limiter constants, evaluated live, and the rolling window.
  -- ==========================================================================
  for v_row in
    select * from (values (0, 0), (1, 0), (4, 0), (5, 30), (6, 60), (7, 120),
                          (8, 300), (9, 900), (10, 900), (50, 900)) as x(n, expected)
  loop
    if public.employee_login_employee_lock_seconds(v_row.n) is distinct from v_row.expected then
      raise exception 'F1A.2: employee lockout for % failures changed', v_row.n;
    end if;
  end loop;

  for v_row in
    select * from (values (0, 0), (1, 0), (14, 0), (15, 15), (19, 15), (20, 30),
                          (24, 30), (25, 60), (26, 60), (1000, 60)) as x(n, expected)
  loop
    if public.employee_login_device_cooldown_seconds(v_row.n) is distinct from v_row.expected then
      raise exception 'F1A.2: device cooldown for % recent failures changed', v_row.n;
    end if;
  end loop;

  if position('f.failed_at >= p_now - interval ''300 seconds'''
              in pg_get_functiondef('public.employee_login_record_device_failure(uuid,timestamptz)'::regprocedure)) = 0 then
    raise exception 'F1A.2: the rolling 300-second window changed';
  end if;

  -- ==========================================================================
  -- A8. Limiter tables still RPC-only.
  -- ==========================================================================
  foreach v_tbl in array array['employees', 'employee_pos_sessions',
                               'employee_login_employee_attempts',
                               'employee_login_device_failures',
                               'employee_login_device_throttles']
  loop
    if not (select c.relrowsecurity from pg_class c
            where c.oid = to_regclass(format('public.%I', v_tbl))) then
      raise exception 'F1A.2: row level security is off on %', v_tbl;
    end if;

    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = v_tbl) then
      raise exception 'F1A.2: % must carry no policy', v_tbl;
    end if;
  end loop;

  -- ==========================================================================
  -- B1. Every other function is byte-identical.
  -- ==========================================================================
  for v_row in select * from f1a2_proc_baseline
  loop
    if not exists (select 1 from pg_proc p where p.oid = v_row.fn_oid)
       or (select md5(pg_get_functiondef(p.oid)) from pg_proc p where p.oid = v_row.fn_oid)
          is distinct from v_row.body
       or (select p.prosecdef from pg_proc p where p.oid = v_row.fn_oid)
          is distinct from v_row.prosecdef
       or (select coalesce(p.proconfig, array[]::text[]) from pg_proc p where p.oid = v_row.fn_oid)
          is distinct from v_row.config
       or (select coalesce(p.proacl::text, 'default') from pg_proc p where p.oid = v_row.fn_oid)
          is distinct from v_row.acl then
      raise exception 'F1A.2: function %(%) changed or was dropped', v_row.proname, v_row.args;
    end if;
  end loop;

  select count(*) into v_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f'
    and p.oid not in (select fn_oid from f1a2_proc_baseline)
    and p.proname not in ('create_employee', 'set_employee_active');

  if v_count <> 0 then
    raise exception 'F1A.2: % unexpected new function(s)', v_count;
  end if;

  -- ==========================================================================
  -- B2. Policies, privileges, RLS, triggers and indexes are unchanged.
  -- ==========================================================================
  if exists (
    select 1
    from f1a2_pol_baseline b
    full outer join (
      select tablename, policyname, cmd, qual, with_check, roles::text as roles
      from pg_policies where schemaname = 'public'
    ) c on c.tablename = b.tablename and c.policyname = b.policyname
    where c.policyname is null or b.policyname is null
       or c.cmd is distinct from b.cmd or c.qual is distinct from b.qual
       or c.with_check is distinct from b.with_check or c.roles is distinct from b.roles
  ) then
    raise exception 'F1A.2: public policies changed';
  end if;

  for v_row in select * from f1a2_priv_baseline
  loop
    if has_table_privilege(v_row.rolname, format('public.%I', v_row.tablename), v_row.priv)
       is distinct from v_row.held then
      raise exception 'F1A.2: privilege % on % for % changed', v_row.priv, v_row.tablename, v_row.rolname;
    end if;
  end loop;

  if exists (
    select 1
    from f1a2_rls_baseline b
    full outer join (
      select c.relname, c.relrowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
    ) c on c.relname = b.relname
    where c.relname is null or b.relname is null or c.relrowsecurity is distinct from b.relrowsecurity
  ) then
    raise exception 'F1A.2: a table or its RLS setting changed';
  end if;

  select array_agg(x order by x) into v_new_triggers
  from (
    select c.relname || '.' || t.tgname || ':' || t.tgtype || ':' || t.tgenabled || ':' || pr.proname as x
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc pr on pr.oid = t.tgfoid
    where n.nspname = 'public' and not t.tgisinternal
    except
    select b.relname || '.' || b.tgname || ':' || b.tgtype || ':' || b.tgenabled || ':' || b.proname
    from f1a2_trg_baseline b
  ) s;

  if v_new_triggers is not null
     or (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and not t.tgisinternal)
        <> (select count(*) from f1a2_trg_baseline) then
    raise exception 'F1A.2: triggers changed';
  end if;

  if exists (
    select 1
    from f1a2_idx_baseline b
    full outer join (select tablename, indexname, indexdef from pg_indexes where schemaname = 'public') c
      on c.indexname = b.indexname
    where c.indexname is null or b.indexname is null or c.indexdef is distinct from b.indexdef
  ) then
    raise exception 'F1A.2: indexes changed (including employee_pos_sessions_one_open_per_device)';
  end if;

  -- ==========================================================================
  -- B3. Rows and columns of every employee structure are unchanged.
  -- ==========================================================================
  select * into v_row from f1a2_row_baseline;

  if (select count(*) from public.paired_devices) is distinct from v_row.devices
     or (select coalesce(md5(string_agg(md5(d::text), '|' order by d.id::text)), 'empty')
         from public.paired_devices d) is distinct from v_row.devices_fp
     or (select count(*) from public.employees) is distinct from v_row.employees
     or (select coalesce(md5(string_agg(md5(e::text), '|' order by e.id::text)), 'empty')
         from public.employees e) is distinct from v_row.employees_fp
     or (select count(*) from public.employee_pos_sessions) is distinct from v_row.sessions
     or (select coalesce(md5(string_agg(md5(s::text), '|' order by s.id::text)), 'empty')
         from public.employee_pos_sessions s) is distinct from v_row.sessions_fp
     or (select count(*) from public.employee_login_employee_attempts) is distinct from v_row.emp_attempts
     or (select count(*) from public.employee_login_device_failures) is distinct from v_row.dev_failures
     or (select count(*) from public.employee_login_device_throttles) is distinct from v_row.dev_throttles then
    raise exception 'F1A.2: employee, session, limiter or pairing rows changed';
  end if;

  if (select md5(string_agg(table_name || '.' || column_name || ':' || data_type, ','
                            order by table_name, ordinal_position))
      from information_schema.columns
      where table_schema = 'public'
        and table_name in ('employees', 'employee_pos_sessions',
                           'employee_login_employee_attempts',
                           'employee_login_device_failures',
                           'employee_login_device_throttles'))
     is distinct from v_row.employee_columns then
    raise exception 'F1A.2: employee structure columns changed';
  end if;

  raise notice 'F1A.2: temporary engineering active-employee safeguard removed and verified.';
end
$do$;
