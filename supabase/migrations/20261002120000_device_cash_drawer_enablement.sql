-- ============================================================================
-- v1.3 Cash Drawer Checkpoint 1B — per-device cash drawer enablement
--
-- THE OWNER'S DECISION, STORED ON THE DEVICE IT GOVERNS. One boolean on the
-- paired_devices row, which already IS the register's identity. No second
-- device or register configuration model.
--
-- WHAT READS IT: get_device_pairing_state (below), and from there the till's
-- automatic drawer coordinator (lib/cashDrawer.ts, Checkpoint 1A), which
-- refuses to claim a drawer event unless this is true. Nothing here touches a
-- drawer, a printer or any hardware; that is a later checkpoint.
--
-- WHAT DOES NOT CHANGE:
--   * table grants -- still SELECT only; no role gains UPDATE. The one writer
--     is the owner RPC below.
--   * row level security -- both SELECT policies are untouched.
--   * paired_devices_guard_immutable_columns -- not redefined. The new column
--     is mutable because that trigger does not name it, the same principle
--     20260823120000 (unpaired_at) and 20260831120000 (the offer) used.
--   * revoke_paired_device / unpair_own_device / apply_device_config_update /
--     every sale RPC -- untouched. None of them writes the new column.
--
-- FAIL CLOSED AT EVERY LAYER. The column is NOT NULL DEFAULT false, so every
-- existing device reads false. get_device_pairing_state reports true only for
-- an ACTIVE WINDOWS device whose owner turned it on.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The column.
--
-- NOT NULL DEFAULT false: existing rows resolve to false on add, so no backfill
-- statement exists or is needed. A re-paired device gets a NEW row
-- (redeem_device_pairing_token inserts one), and so starts at false too.
-- ----------------------------------------------------------------------------
alter table public.paired_devices
  add column if not exists cash_drawer_enabled boolean not null default false;

comment on column public.paired_devices.cash_drawer_enabled is
  'Cash Drawer 1B — the owner turned automatic cash drawer opening ON for this '
  'device. Written only by set_device_cash_drawer_enabled. Read by the till '
  'through get_device_pairing_state, which reports it only for an active '
  'Windows device.';

-- ----------------------------------------------------------------------------
-- 2. set_device_cash_drawer_enabled — the OWNER sets it.
--
-- Modelled on offer_device_config_update and revoke_paired_device: SECURITY
-- DEFINER, owner resolved from auth.uid(), the device located by
-- `id = p_device_id AND owner_id = v_caller FOR UPDATE` so another owner's
-- device is indistinguishable from one that does not exist, inactive devices
-- refused with the same non-probing message, idempotent.
--
-- A PAIRED DEVICE CAN NEVER REACH THIS. The owner match alone already refuses
-- a till -- its anonymous auth user is not the owner_id of the row -- and the
-- caller is additionally refused outright if it appears as any device's
-- auth_user_id, the rule every v1.3 owner RPC uses (create_employee in
-- 20260914120000 and its successors). Redundant today; it keeps this
-- impossible if the owner match is ever loosened.
--
-- NO owner_id, project_id or platform is accepted from the caller. The
-- platform is the one frozen at pairing.
--
-- ENABLE IS WINDOWS ONLY. Turning it OFF is allowed for any active device, so
-- an owner can always clear it.
-- ----------------------------------------------------------------------------
create or replace function public.set_device_cash_drawer_enabled(
  p_device_id uuid,
  p_enabled boolean
)
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

  -- A till is never an owner here, whatever else is true of its auth user.
  if exists (select 1 from public.paired_devices d where d.auth_user_id = v_caller) then
    raise exception 'Device not found or access denied';
  end if;

  if p_device_id is null or p_enabled is null then
    raise exception 'Device id and enabled flag are required';
  end if;

  -- Owner scope enforced in the WHERE clause, not in a later branch: a device
  -- belonging to someone else simply does not match.
  select d.* into v_device
  from public.paired_devices d
  where d.id = p_device_id
    and d.owner_id = v_caller
  for update;

  if not found then
    raise exception 'Device not found or access denied';
  end if;

  -- A revoked or self-unpaired device is not a target. Same rule and same
  -- message as offer_device_config_update.
  if v_device.revoked_at is not null or v_device.unpaired_at is not null then
    raise exception 'Device not found or access denied';
  end if;

  if p_enabled and v_device.platform is distinct from 'windows' then
    raise exception 'Cash drawer is only supported on Windows devices';
  end if;

  -- Idempotent: setting the value it already has is a success and writes
  -- nothing.
  if v_device.cash_drawer_enabled = p_enabled then
    return jsonb_build_object(
      'ok', true,
      'device_id', v_device.id,
      'cash_drawer_enabled', v_device.cash_drawer_enabled,
      'changed', false
    );
  end if;

  update public.paired_devices
  set cash_drawer_enabled = p_enabled
  where id = p_device_id
  returning * into v_device;

  return jsonb_build_object(
    'ok', true,
    'device_id', v_device.id,
    'cash_drawer_enabled', v_device.cash_drawer_enabled,
    'changed', true
  );
end;
$function$;

-- Authenticated only, exactly as offer_device_config_update. service_role is
-- revoked DELIBERATELY: Supabase's default privileges grant EXECUTE on every
-- new public function to anon, authenticated and service_role, and this
-- function resolves identity from auth.uid(), which service_role does not have.
revoke all on function public.set_device_cash_drawer_enabled(uuid, boolean) from public;
revoke all on function public.set_device_cash_drawer_enabled(uuid, boolean) from anon;
revoke all on function public.set_device_cash_drawer_enabled(uuid, boolean) from service_role;
grant execute on function public.set_device_cash_drawer_enabled(uuid, boolean) to authenticated;

-- ----------------------------------------------------------------------------
-- 3. get_device_pairing_state — a STRICT SUPERSET of 20260831120000 §5
--
-- Every key, every branch and every value of the accepted definition is
-- reproduced unchanged; the one addition is `cash_drawer_enabled`.
--
-- It is true ONLY for an active Windows device whose owner turned it on. The
-- server folds those rules in itself, so a revoked or non-Windows device reads
-- false no matter what is stored. An older client ignores the unknown key.
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

  -- Feature 25.1 — this device removed itself. Revocation is checked below and
  -- is unaffected; this is the administrative case, and it ends the session.
  if v_device.unpaired_at is not null then
    return jsonb_build_object('paired', false, 'reason', 'unpaired');
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
    'active', (v_device.revoked_at is null),
    -- Feature 26.1 — additive. An older client ignores unknown keys, so this is
    -- safe to ship before any client reads it.
    'update_available', (
      v_device.offered_build_job_id is not null
      and v_device.offered_build_job_id is distinct from v_device.build_job_id
      and v_device.revoked_at is null
    ),
    'offered_build_job_id', v_device.offered_build_job_id,
    -- Reported as null whenever there is no offer, which is NOT the same as
    -- reading the column. ON DELETE SET NULL clears offered_build_job_id when
    -- an offered build is deleted, but a foreign key action touches only its own
    -- column, so offered_at is left behind pointing at an offer that no longer
    -- exists. A CHECK constraint cannot fix that — it would refuse the FK action
    -- itself — so the inconsistency is resolved here, where it is read.
    'offered_at', case
      when v_device.offered_build_job_id is null then null
      else v_device.offered_at
    end,
    -- Cash Drawer 1B — additive, and gated here rather than trusted to the
    -- client: stored ON, not revoked, and a Windows device. `is true` keeps the
    -- value a strict boolean.
    'cash_drawer_enabled', (
      v_device.cash_drawer_enabled
      and v_device.revoked_at is null
      and v_device.platform is not distinct from 'windows'
    ) is true
  );
end;
$function$;
