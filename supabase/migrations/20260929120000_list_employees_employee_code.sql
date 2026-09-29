-- ============================================================================
-- v1.3 Lane 1 Task 5B correction — list_employees exposes employeeCode.
--
-- WHAT THIS SOLVES. The owner's roster could not show an existing employee's
-- Employee ID after a fresh load: list_employees (20260914120000) predates the
-- employee_code column (20260919120000), and 20260919120000 deferred adding it
-- to "the management UI". A code was only ever returned by create_employee and
-- set_employee_code, so a reloaded roster had no legitimate way to read one.
--
-- WHAT CHANGES, IN ONE LINE: each returned employee gains
-- 'employeeCode', e.employee_code. Nothing else.
--
-- WHY `create or replace`, AND WHY THAT IS SAFE HERE. The return type is jsonb
-- before and after; only the jsonb VALUE gains a key. PostgreSQL permits a
-- replace that keeps the name, argument types and return type, and a replace
-- keeps the function's owner and ACL. No drop, no second overload, no new RPC.
--
-- WHAT IS REPRODUCED EXACTLY from 20260914120000: `stable`, `security
-- definer`, `search_path = public, pg_temp`, the not_authenticated / paired-
-- device / null-project / projects.user_id owner checks and their answers, the
-- `order by e.created_at, e.id` ordering, and the six existing keys.
--
-- employee_code IS text AND STAYS text. `001` is returned as the JSON string
-- "001", never a number. An ACTIVE employee always has one (employees_active_
-- requires_code_check). An INACTIVE employee who left before 20260919120000 may
-- legitimately have none, and is returned as JSON null -- not "", not a guess.
--
-- STILL NOT EXPOSED: pin_hash or any credential material. The column is never
-- selected.
--
-- NOT TOUCHED: any table, row, constraint, index, employee code, PIN rule,
-- role, Time Clock, employee POS session, set_employee_active, or any other
-- function. No prior migration is edited.
-- ============================================================================

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
        'deactivatedAt', e.deactivated_at,
        'employeeCode', e.employee_code
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

-- Restated, identical to 20260914120000. A replace already keeps the ACL; these
-- make the intended grants explicit rather than inherited.
revoke all on function public.list_employees(uuid) from public;
revoke all on function public.list_employees(uuid) from anon;
revoke all on function public.list_employees(uuid) from service_role;
grant execute on function public.list_employees(uuid) to authenticated;
