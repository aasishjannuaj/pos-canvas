-- ----------------------------------------------------------------------------
-- Feature 26.1 — let a paired till move to a newer published configuration
-- without unpair/re-pair. SERVER CONTRACT ONLY; no client change ships with it.
--
-- WHY THIS IS NOT A CACHE REFRESH, and why the design is shaped the way it is.
--
-- `paired_devices.build_job_id` is NOT a display pointer. It is the PRICING
-- AUTHORITY: complete_sale (and v2, v3, v4) all resolve the caller's device row
-- and price the sale from THAT build's `config_snapshot`. Moving the pointer
-- therefore changes what the SERVER charges, not merely what the till shows.
--
-- Two consequences drive everything below:
--
--   1. MID-SALE. If the pointer moved while a cart was open, the till would show
--      the old prices and the server would charge the new ones. A customer would
--      be charged something other than what they were shown.
--
--   2. QUEUED OFFLINE SALES. A queued sale carries item ids and quantities, not
--      prices — the server prices it AT SYNC TIME from the then-current pinned
--      build. Moving the pointer with a queue outstanding reprices yesterday's
--      sales at today's prices. Already-committed sales are safe (the
--      sale_request_id replay returns the stored order before any pricing runs);
--      un-synced ones are not.
--
-- So the update is a TWO-PARTY, EXPLICIT act: the owner OFFERS a build, and the
-- till APPLIES it. Neither side can reprice alone, and nothing here ever follows
-- the latest build automatically.
--
-- WHAT THIS MIGRATION DELIBERATELY CANNOT DO. The cart and the offline queue
-- live in the device's IndexedDB. `paired_devices` has no queue or sync column
-- and the server has, by definition, never seen an unsynced sale. Server-side
-- blocking on "cart open" or "sales outstanding" is therefore IMPOSSIBLE from
-- this schema — it is not omitted here, it cannot exist here.
--
--   >> apply_device_config_update() MUST NOT be exposed in any UI until
--   >> Feature 26.2 adds the client-side gate: blocked on a non-empty cart, and
--   >> blocked on unresolved financial evidence via decideDeviceResetSafety.
--
-- Nothing in this migration changes automatic startup behaviour, and
-- get_device_config keeps returning the CURRENT build until Apply succeeds.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- 1. Schema — additive, nullable, no backfill
-- ----------------------------------------------------------------------------

-- The offer. Two columns rather than one so "which build" and "when" are both
-- answerable; `offered_at` is what a future UI would use to say how long an
-- update has been waiting.
--
-- ON DELETE SET NULL, never cascade: deleting a build must make an offer
-- evaporate, never delete the device that was offered it. (paired_devices'
-- existing build_job_id cascade is a different and much older decision.)
alter table public.paired_devices
  add column if not exists offered_build_job_id uuid
    references public.build_jobs(id) on delete set null,
  add column if not exists offered_at timestamptz;

comment on column public.paired_devices.offered_build_job_id is
  'Feature 26.1 — a newer succeeded build the owner has offered this device. '
  'Advisory only: it does not price anything and is not read by get_device_config. '
  'It becomes the pricing authority only when the DEVICE calls '
  'apply_device_config_update(), which moves it into build_job_id.';

comment on column public.paired_devices.offered_at is
  'Feature 26.1 — when the offer was made. Cleared with the offer.';

-- No index on offered_build_job_id: paired_devices is small and every lookup in
-- this contract is by auth_user_id or by primary key. An index here would be
-- speculation.

-- The audit trail. Until now nothing recorded WHICH snapshot priced a sale,
-- which is exactly the question this feature makes it possible to ask.
--
-- NULLABLE AND NOT BACKFILLED, by product decision. The pinned build at sale
-- time was never recorded, so historical rows cannot be reconstructed; writing a
-- guess would be worse than an honest null. Owner-taken sales are also null and
-- correctly so — an owner prices from live project config, not from a build.
--
-- ON DELETE NO ACTION, NOT SET NULL, and this is the load-bearing choice.
--
-- SET NULL was the first draft, on the reasoning that deleting a build must
-- never delete an order. That reasoning is right and NO ACTION satisfies it too
-- — but SET NULL reintroduces the exact ambiguity this column exists to remove.
-- A null would stop meaning "no build priced this" and start meaning "no build
-- priced this, OR one did and it was deleted", which is unanswerable after the
-- fact. An audit trail that silently erases itself is not an audit trail.
--
-- So the reference is enforced: a build that priced a real sale cannot be
-- deleted while that sale exists. Nothing currently supported is blocked by
-- this — see below — and if a future project-delete flow trips it, that is the
-- correct signal rather than an obstacle: it means the deletion would have
-- destroyed the provenance of money that changed hands.
--
-- WHY NO ACTION RATHER THAN RESTRICT. They refuse the same thing; they differ
-- in WHEN. RESTRICT is checked immediately and cannot be deferred, so it fires
-- even when the referencing orders are being deleted in the SAME statement.
-- NO ACTION is checked at end of statement, so a legitimate multi-table cascade
-- resolves first and only a genuine dangling reference fails. That matters here
-- because deleting an auth.users row cascades to BOTH orders (via user_id) and
-- build_jobs (via owner_id); RESTRICT could fail that account deletion
-- depending on the order Postgres happens to process the cascades in, which is
-- not defined. NO ACTION gives the identical guarantee without that hazard.
alter table public.orders
  add column if not exists build_job_id uuid
    references public.build_jobs(id) on delete no action;

comment on column public.orders.build_job_id is
  'Feature 26.1 — the build whose config_snapshot priced this sale, or null when '
  'no build did (an owner-taken sale) or when the sale predates this column. '
  'Never backfilled: the pinned build at sale time was not recorded before now. '
  'ON DELETE NO ACTION: a build that priced a sale cannot be deleted while that '
  'sale exists, so a null never means "the build was deleted".';

-- Postgres does not index a foreign key automatically, and the referential
-- check on build deletion would otherwise scan orders, which grows without
-- bound. Partial, because the historical rows this cannot fill are null.
create index if not exists orders_build_job_idx
  on public.orders (build_job_id)
  where build_job_id is not null;

-- ----------------------------------------------------------------------------
-- 1b. Relax paired_devices_guard_immutable_columns — by exactly one transition.
--
-- 20260803270000 froze build_job_id along with the device's identity columns,
-- and said so deliberately: "A future rename or heartbeat feature needs a new
-- RPC and therefore a migration regardless; relaxing this guard at that point
-- is one line". Feature 26.1 is that future feature for the pricing pin.
-- Without this, the trigger refuses the UPDATE inside
-- apply_device_config_update outright and the whole feature is dead on arrival.
--
-- The relaxation is NOT "drop the check". Dropping it would let any present or
-- future writer move a till's pricing authority silently, which is the thing
-- the 20260803270000 guard exists to prevent. Instead the pin may move only
-- while CONSUMING AN OFFER the owner actually made:
--
--   * an offer must already be recorded (old.offered_build_job_id not null),
--   * the new pin must be exactly that offered build, and
--   * the same statement must clear both offer columns.
--
-- So the offer -> apply contract is enforced by the table itself, not only by
-- apply_device_config_update. A device cannot be repriced to a build its owner
-- never offered even if some later code path tries, and a consumed offer cannot
-- be left standing.
--
-- Every other column stays exactly as frozen as it was. The two new columns are
-- not named here, so they are mutable — the same principle 20260823120000 used
-- for unpaired_at.
-- ----------------------------------------------------------------------------
create or replace function public.paired_devices_guard_immutable_columns()
returns trigger
language plpgsql
security definer
set search_path to public, pg_temp
as $function$
begin
  if new.auth_user_id is distinct from old.auth_user_id then
    raise exception 'paired_devices.auth_user_id cannot be changed after creation';
  end if;

  if new.owner_id is distinct from old.owner_id then
    raise exception 'paired_devices.owner_id cannot be changed after creation';
  end if;

  if new.project_id is distinct from old.project_id then
    raise exception 'paired_devices.project_id cannot be changed after creation';
  end if;

  -- Feature 26.1 — the pricing pin is no longer frozen for life, but it moves
  -- ONLY by consuming an offer the owner made, and only while clearing it.
  if new.build_job_id is distinct from old.build_job_id then
    if old.offered_build_job_id is null
       or new.build_job_id is distinct from old.offered_build_job_id
       or new.offered_build_job_id is not null
       or new.offered_at is not null then
      raise exception
        'paired_devices.build_job_id can only change by applying an offered config update';
    end if;
  end if;

  if new.device_name is distinct from old.device_name then
    raise exception 'paired_devices.device_name cannot be changed after creation';
  end if;

  if new.platform is distinct from old.platform then
    raise exception 'paired_devices.platform cannot be changed after creation';
  end if;

  if new.created_at is distinct from old.created_at then
    raise exception 'paired_devices.created_at cannot be changed after creation';
  end if;

  if new.last_seen_at is distinct from old.last_seen_at then
    raise exception 'paired_devices.last_seen_at cannot be changed after creation';
  end if;

  return new;
end;
$function$;

-- ----------------------------------------------------------------------------
-- 2. offer_device_config_update — the OWNER half
--
-- Modelled on revoke_paired_device: SECURITY DEFINER, owner resolved from
-- auth.uid(), the device located by `id = p_device_id AND owner_id = v_caller`
-- so another owner's device is indistinguishable from one that does not exist.
-- No owner_id or project_id is ever accepted from the caller.
-- ----------------------------------------------------------------------------
create or replace function public.offer_device_config_update(
  p_device_id uuid,
  p_build_job_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller uuid;
  v_device record;
  v_job    record;
begin
  v_caller := auth.uid();

  if v_caller is null then
    raise exception 'Authentication required';
  end if;

  if p_device_id is null or p_build_job_id is null then
    raise exception 'Device id and build id are required';
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

  -- An inactive device is not a target for an update. Same rule the rest of the
  -- device contract uses, and the same non-probing message.
  if v_device.revoked_at is not null or v_device.unpaired_at is not null then
    raise exception 'Device not found or access denied';
  end if;

  -- The build must exist, be finished, and belong to the SAME PROJECT as the
  -- device. Cross-project is the failure that would let one customer's prices
  -- reach another's till, so it is checked against the device's own project_id
  -- rather than anything the caller supplied.
  select b.id, b.project_id, b.status into v_job
  from public.build_jobs b
  where b.id = p_build_job_id
    and b.owner_id = v_caller;

  if not found
     or v_job.project_id is distinct from v_device.project_id
     or v_job.status <> 'succeeded' then
    raise exception 'Build not found or not usable for this device';
  end if;

  -- Idempotent: offering the same build twice is a success and does not move
  -- offered_at, so "waiting since" stays truthful.
  if v_device.offered_build_job_id = p_build_job_id then
    return jsonb_build_object(
      'ok', true,
      'device_id', v_device.id,
      'offered_build_job_id', v_device.offered_build_job_id,
      'offered_at', v_device.offered_at,
      'already_offered', true
    );
  end if;

  -- NOTE what is NOT touched: build_job_id. An offer changes nothing about
  -- pricing. Only the device, via apply_device_config_update(), can do that.
  update public.paired_devices
  set offered_build_job_id = p_build_job_id,
      offered_at = now()
  where id = p_device_id
  returning * into v_device;

  return jsonb_build_object(
    'ok', true,
    'device_id', v_device.id,
    'offered_build_job_id', v_device.offered_build_job_id,
    'offered_at', v_device.offered_at,
    'already_offered', false
  );
end;
$function$;

-- Authenticated only. service_role is revoked DELIBERATELY and explicitly:
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE on every new public
-- function to anon, authenticated AND service_role, so omitting this line
-- leaves a grant nobody wrote. Nothing server-side offers an update — the
-- owner does, through their own session — and both functions resolve identity
-- from auth.uid(), which service_role does not have. Same pattern as
-- get_device_recent_orders in 20260823130000.
revoke all on function public.offer_device_config_update(uuid, uuid) from public;
revoke all on function public.offer_device_config_update(uuid, uuid) from anon;
revoke all on function public.offer_device_config_update(uuid, uuid) from service_role;
grant execute on function public.offer_device_config_update(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 3. apply_device_config_update — the DEVICE half
--
-- Modelled on unpair_own_device: NO PARAMETERS. A device may only ever act on
-- its own row, and that is a property of the signature rather than of a check
-- someone could edit away. There is no device id, project id or build id to
-- pass, so there is nothing to forge.
--
-- >> NOT SAFE TO EXPOSE IN UI UNTIL 26.2. See the header: the cart and the
-- >> unsynced queue are invisible to this function.
-- ----------------------------------------------------------------------------
create or replace function public.apply_device_config_update()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_caller   uuid;
  v_device   record;
  v_job      record;
  v_previous uuid;
begin
  v_caller := auth.uid();

  if v_caller is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  -- Locked for the rest of the transaction so a concurrent offer cannot change
  -- what is being applied between the read and the write.
  select d.* into v_device
  from public.paired_devices d
  where d.auth_user_id = v_caller
    and d.revoked_at is null
    and d.unpaired_at is null
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_paired');
  end if;

  if v_device.offered_build_job_id is null then
    -- Truthful, not an error: there is simply nothing to apply.
    return jsonb_build_object(
      'ok', false,
      'error', 'no_update_offered',
      'build_job_id', v_device.build_job_id
    );
  end if;

  -- Re-validated at APPLY time, not trusted from when the offer was made. A
  -- build could have been deleted, or the device moved, in between.
  select b.id, b.project_id, b.status into v_job
  from public.build_jobs b
  where b.id = v_device.offered_build_job_id;

  if not found
     or v_job.project_id is distinct from v_device.project_id
     or v_job.status <> 'succeeded' then
    return jsonb_build_object('ok', false, 'error', 'offer_unusable');
  end if;

  -- Captured BEFORE the update, because the RETURNING below overwrites v_device
  -- and the old pin would otherwise be unrecoverable for the response.
  v_previous := v_device.build_job_id;

  -- The move and the clear are ONE statement: there is no instant in which the
  -- device is pinned to the new build while still showing an outstanding offer,
  -- and none in which the offer is consumed without the pin moving.
  update public.paired_devices
  set build_job_id = offered_build_job_id,
      offered_build_job_id = null,
      offered_at = null
  where id = v_device.id
  returning * into v_device;

  -- Enough for the client to refresh: it re-runs its normal config load, which
  -- already replaces the cached snapshot on every authoritative start.
  return jsonb_build_object(
    'ok', true,
    'device_id', v_device.id,
    'project_id', v_device.project_id,
    'build_job_id', v_device.build_job_id,
    'previous_build_job_id', v_previous
  );
end;
$function$;

revoke all on function public.apply_device_config_update() from public;
revoke all on function public.apply_device_config_update() from anon;
revoke all on function public.apply_device_config_update() from service_role;
grant execute on function public.apply_device_config_update() to authenticated;

-- ----------------------------------------------------------------------------
-- 4. The sale audit trail — ALL FOUR order-creating functions
--
-- WHY ALL FOUR, and not just v4. complete_sale, complete_sale_v2,
-- complete_sale_v3 and complete_sale_v4 every one of them inserts into
-- public.orders, every one prices a device sale from the pinned build's
-- config_snapshot, and every one is still called by shipping client code
-- (lib/orders.ts calls v1/v2/v3, lib/device.rpc.ts calls v2/v3,
-- lib/offlineSaleRpc.ts calls v4). Filling the column on one path only would
-- have produced an audit trail that is silently incomplete, which is worse than
-- none: a null would stop meaning "before this feature" and start meaning
-- "maybe, depending on which RPC the client happened to use".
--
-- WHAT IS UNCHANGED. Each body below is the CURRENT deployed definition with
-- exactly two tokens added — `build_job_id` to the INSERT column list and
-- `v_build_job_id` to its VALUES. No pricing, validation, locking, ordering,
-- inventory or idempotency logic is touched.
--
-- REPLAY IS UNAFFECTED. The sale_request_id lookup returns the stored order
-- before any INSERT is reached, so a replay neither creates a row nor rewrites
-- an existing build_job_id. The value is written once, by the insert that
-- actually created the order.
--
-- OWNER SALES STAY NULL, correctly. v_build_job_id is only ever set from the
-- caller's paired_devices row; an owner prices from live project config, so no
-- build priced that sale and the column has nothing truthful to record.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.complete_sale(p_project_id uuid, p_order_number text, p_payment_method text, p_subtotal numeric, p_tax_amount numeric, p_tip_amount numeric, p_total numeric, p_items jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  -- numeric(12,2) ceiling. Every stored money value is checked against this.
  c_max_money      constant numeric := 9999999999.99;
  -- Per-item ceilings. Deliberately far below c_max_money so a single absurd
  -- line is rejected with a clear message rather than by an overflow error.
  c_max_unit_price constant numeric := 1000000.00;
  c_max_quantity   constant integer := 10000;
  c_max_items      constant integer := 200;
  -- stockQuantity must fit int4 with room to spare (the column is integer).
  c_max_stock      constant numeric := 1000000000;

  v_caller        uuid;
  v_owner_id      uuid;
  v_is_owner      boolean;

  v_build_job_id  uuid;
  v_snapshot      jsonb;

  v_config        jsonb;
  v_live_items    jsonb;
  v_price_items   jsonb;
  v_tax           jsonb;

  v_tax_enabled   boolean;
  v_tax_inclusive boolean;
  v_rate          numeric;

  v_order_id      uuid;
  v_lines         jsonb := '[]'::jsonb;

  v_cart_item     jsonb;
  v_item_id       text;
  v_qty_num       numeric;
  v_quantity      integer;
  v_price_item    jsonb;
  v_live_item     jsonb;
  v_live_index    integer;
  v_item_name     text;
  v_unit_price    numeric;
  v_line_total    numeric;

  v_track         boolean;
  v_stock_num     numeric;
  v_stock_before  integer;
  v_stock_after   integer;

  v_subtotal      numeric := 0;
  v_tax_amount    numeric := 0;
  v_tip_amount    numeric := 0;
  v_total_before_tip numeric := 0;
  v_total         numeric := 0;

  v_item_count    integer;
  v_distinct_count integer;
  i               integer;
begin
  -- ==========================================================================
  -- 1. Caller identity and request shape. Nothing here touches the database.
  -- ==========================================================================
  v_caller := auth.uid();

  if v_caller is null then
    raise exception 'Authentication required';
  end if;

  if p_project_id is null then
    raise exception 'Project ID is required';
  end if;

  if p_order_number is null or btrim(p_order_number) = '' then
    raise exception 'Order number is required';
  end if;

  if p_payment_method is null or p_payment_method not in ('cash', 'card') then
    raise exception 'Invalid payment method';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one order item is required';
  end if;

  if jsonb_array_length(p_items) > c_max_items then
    raise exception 'Too many order items';
  end if;

  -- Every element must be a JSON OBJECT. jsonb's ->> returns NULL rather than
  -- raising when applied to a scalar or an array, so a payload like
  -- [1, "x", []] would otherwise slip through to the itemId test below and be
  -- reported as a missing id rather than a malformed request.
  select count(*) into v_item_count
  from jsonb_array_elements(p_items) e
  where jsonb_typeof(e.value) <> 'object';

  if v_item_count > 0 then
    raise exception 'Invalid order item';
  end if;

  -- Every element must carry a usable itemId before the duplicate check below
  -- can mean anything (count(distinct ...) ignores nulls). btrim collapses a
  -- whitespace-only id to '', so it is rejected here too.
  select count(*) into v_item_count
  from jsonb_array_elements(p_items) e
  where coalesce(btrim(e.value ->> 'itemId'), '') = '';

  if v_item_count > 0 then
    raise exception 'Invalid order item';
  end if;

  -- Duplicate item ids are REJECTED rather than aggregated. The web client
  -- already merges repeat additions into one line (PosRuntime.addToCart), so
  -- this costs nothing real, and it is what lets each item below be priced,
  -- decremented and audited exactly once.
  select count(*), count(distinct btrim(e.value ->> 'itemId'))
  into v_item_count, v_distinct_count
  from jsonb_array_elements(p_items) e;

  if v_item_count <> v_distinct_count then
    raise exception 'The same item appears more than once in this order';
  end if;

  -- ==========================================================================
  -- 2. Authorization. The ONLY place the acting business owner is established.
  --    Raises 'Project not found or access denied' for a non-owner, an unpaired
  --    caller, a revoked device, and a device paired to a different project —
  --    all indistinguishable by design.
  -- ==========================================================================
  v_owner_id := public.resolve_sale_owner(p_project_id);

  if v_owner_id is null then
    raise exception 'Project not found or access denied';
  end if;

  v_is_owner := (v_caller = v_owner_id);

  -- ==========================================================================
  -- 3. Lock the project row. This is the single serialization point for
  --    concurrent sales, and it is taken BEFORE any price or stock is read so
  --    the whole read set is consistent.
  -- ==========================================================================
  select p.config
  into v_config
  from public.projects p
  where p.id = p_project_id
    and p.user_id = v_owner_id
  for update;

  if not found then
    raise exception 'Project not found or access denied';
  end if;

  v_live_items := coalesce(v_config -> 'menuItems', '[]'::jsonb);

  if jsonb_typeof(v_live_items) <> 'array' then
    raise exception 'Project configuration is invalid';
  end if;

  -- ==========================================================================
  -- 4. Resolve the authorized PRICING source.
  -- ==========================================================================
  if v_is_owner then
    -- Owner: the live configuration just locked above. Prices and stock come
    -- from one atomic read, so no skew between them is possible.
    v_price_items := v_live_items;
    v_tax := coalesce(v_config -> 'tax', '{}'::jsonb);
  else
    -- Device: the build id comes from the device's own pairing row. It is never
    -- a parameter, so a device cannot request another build's snapshot.
    select d.build_job_id
    into v_build_job_id
    from public.paired_devices d
    where d.auth_user_id = v_caller
      and d.project_id = p_project_id
      and d.revoked_at is null;

    if not found then
      raise exception 'Project not found or access denied';
    end if;

    select b.config_snapshot
    into v_snapshot
    from public.build_jobs b
    where b.id = v_build_job_id
      and b.project_id = p_project_id
      and b.status = 'succeeded';

    if not found then
      raise exception 'This device is not linked to a usable build';
    end if;

    v_price_items := coalesce(v_snapshot -> 'menuItems', '[]'::jsonb);
    v_tax := coalesce(v_snapshot -> 'tax', '{}'::jsonb);
  end if;

  if jsonb_typeof(v_price_items) <> 'array' then
    raise exception 'Pricing configuration is invalid';
  end if;

  -- ==========================================================================
  -- 5. Tip. A paired device may never book a tip: there is no tip-entry UI on
  --    a device, so any non-zero value is either a stale client or tampering.
  --    The owner's non-negative tip is preserved — receipt.tipsEnabled is a
  --    supported setting and removing it would be an unrelated regression.
  -- ==========================================================================
  -- SPECIAL VALUES ARE REJECTED BEFORE THE OWNER/DEVICE BRANCH, for both
  -- callers identically. A range check alone would NOT be proof of finiteness:
  -- PostgreSQL orders NaN as GREATER than every finite numeric, so `NaN > max`
  -- is true and a not-a-number tip would be misreported as "too large", while
  -- on the device branch `NaN <> 0` would misreport it as a tip that was set.
  -- See the SAFE NUMERIC PREDICATE note above the DECLARE block.
  if p_tip_amount is not null
     and p_tip_amount::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'Order amounts are not valid';
  end if;

  if v_is_owner then
    v_tip_amount := round(coalesce(p_tip_amount, 0), 2);

    if v_tip_amount < 0 then
      raise exception 'Order amounts cannot be negative';
    end if;

    if v_tip_amount > c_max_money then
      raise exception 'Order amount is too large';
    end if;
  else
    if coalesce(p_tip_amount, 0) <> 0 then
      raise exception 'Tips are not supported on this device';
    end if;

    v_tip_amount := 0;
  end if;

  -- ==========================================================================
  -- 6. Tax settings, read from the authorized pricing source. Every cast is
  --    guarded: malformed configuration must produce a controlled message, not
  --    a raw cast error.
  -- ==========================================================================
  begin
    v_tax_enabled := coalesce((v_tax ->> 'enabled')::boolean, true);
  exception
    when invalid_text_representation then
      v_tax_enabled := true;
  end;

  begin
    v_tax_inclusive := coalesce((v_tax ->> 'pricesIncludeTax')::boolean, false);
  exception
    when invalid_text_representation then
      v_tax_inclusive := false;
  end;

  begin
    v_rate := coalesce((v_tax ->> 'rate')::numeric, 0);
  exception
    when invalid_text_representation then
      v_rate := 0;
  end;

  -- DOCUMENTED FALLBACK RULE, mirroring toRuntimeSafeTax in
  -- lib/generatedPosConfig.ts: a rate that is missing, unparseable, NULL, or a
  -- special value falls back to 0; a finite rate is clamped to 0..100.
  --
  -- The special-value test MUST come before the clamp. NaN compares greater
  -- than every finite numeric in PostgreSQL, so `elsif v_rate > 100` alone
  -- would silently turn a corrupt rate into a 100% tax charge — the customer
  -- would be billed double. Falling back to 0 matches the TypeScript rule
  -- (Number.isFinite(rate) ? clamp : 0) exactly.
  if v_rate is null or v_rate::text in ('NaN', 'Infinity', '-Infinity') then
    v_rate := 0;
  elsif v_rate < 0 then
    v_rate := 0;
  elsif v_rate > 100 then
    v_rate := 100;
  end if;

  -- ==========================================================================
  -- 7. Per-item validation and server-side pricing.
  --
  --    Only `itemId` and `quantity` are read from the client. The client's
  --    `name` and `price` keys are never referenced anywhere in this function.
  -- ==========================================================================
  for v_cart_item in
    select value
    from jsonb_array_elements(p_items)
  loop
    v_item_id := btrim(v_cart_item ->> 'itemId');

    -- Quantity: a positive whole number within bounds. Parsed as numeric first
    -- so a fractional value like 1.5 is REJECTED rather than silently truncated
    -- by an ::integer cast.
    begin
      v_qty_num := (v_cart_item ->> 'quantity')::numeric;
    exception
      when invalid_text_representation then
        raise exception 'Invalid quantity for an order item';
    end;

    -- The special-value test is not redundant with the range test: NaN = NaN is
    -- TRUE for numeric, so `v_qty_num <> trunc(v_qty_num)` does NOT reject NaN,
    -- and NaN would then reach the ::integer cast below and raise a raw
    -- "cannot convert NaN to integer".
    if v_qty_num is null
       or v_qty_num::text in ('NaN', 'Infinity', '-Infinity')
       or v_qty_num <> trunc(v_qty_num)
       or v_qty_num < 1
       or v_qty_num > c_max_quantity then
      raise exception 'Invalid quantity for an order item';
    end if;

    v_quantity := v_qty_num::integer;

    -- Locate the item in the AUTHORIZED pricing source.
    v_price_item := null;

    for i in 0 .. jsonb_array_length(v_price_items) - 1
    loop
      if v_price_items -> i ->> 'id' = v_item_id then
        v_price_item := v_price_items -> i;
        exit;
      end if;
    end loop;

    -- A stale or deleted item must never be sellable. Reports the id, never a
    -- client-supplied name, so an error message cannot echo attacker input.
    if v_price_item is null then
      raise exception 'Menu item % is not available', v_item_id;
    end if;

    v_item_name := btrim(coalesce(v_price_item ->> 'name', ''));

    if v_item_name = '' then
      raise exception 'Menu item % is not available', v_item_id;
    end if;

    begin
      v_unit_price := (v_price_item ->> 'price')::numeric;
    exception
      when invalid_text_representation then
        raise exception 'Menu item % has an invalid price', v_item_id;
    end;

    -- A JSON string price of "NaN", "Infinity" or "-Infinity" casts to a valid
    -- numeric without raising, so the special-value test is what stops it —
    -- not the range test, which NaN passes by comparing greater than the bound
    -- and thus produces the wrong error.
    if v_unit_price is null
       or v_unit_price::text in ('NaN', 'Infinity', '-Infinity')
       or v_unit_price < 0
       or v_unit_price > c_max_unit_price then
      raise exception 'Menu item % has an invalid price', v_item_id;
    end if;

    v_line_total := round(v_unit_price * v_quantity, 2);

    if v_line_total is null
       or v_line_total::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'Order amount is not valid';
    end if;

    if v_line_total > c_max_money then
      raise exception 'Order amount is too large';
    end if;

    v_subtotal := v_subtotal + v_line_total;

    -- Checked inside the loop, not only at the end, so a runaway order is
    -- rejected as early as possible.
    if v_subtotal > c_max_money then
      raise exception 'Order amount is too large';
    end if;

    -- Inventory always comes from the LIVE locked config, never the snapshot.
    v_live_index := null;

    for i in 0 .. jsonb_array_length(v_live_items) - 1
    loop
      if v_live_items -> i ->> 'id' = v_item_id then
        v_live_index := i;
        exit;
      end if;
    end loop;

    -- Present in a pinned snapshot but deleted from the live project: not
    -- sellable, because its stock can no longer be tracked.
    if v_live_index is null then
      raise exception 'Menu item % is not available', v_item_id;
    end if;

    v_live_item := v_live_items -> v_live_index;

    begin
      v_track := coalesce((v_live_item ->> 'trackInventory')::boolean, false);
    exception
      when invalid_text_representation then
        raise exception 'Inventory configuration for % is invalid', v_item_id;
    end;

    v_stock_before := 0;
    v_stock_after := 0;

    if v_track then
      begin
        v_stock_num := coalesce((v_live_item ->> 'stockQuantity')::numeric, 0);
      exception
        when invalid_text_representation then
          raise exception 'Inventory configuration for % is invalid', v_item_id;
      end;

      if v_stock_num is null
         or v_stock_num::text in ('NaN', 'Infinity', '-Infinity')
         or v_stock_num <> trunc(v_stock_num)
         or v_stock_num < 0
         or v_stock_num > c_max_stock then
        raise exception 'Inventory configuration for % is invalid', v_item_id;
      end if;

      v_stock_before := v_stock_num::integer;

      if v_stock_before < v_quantity then
        raise exception 'Insufficient inventory for %', v_item_name;
      end if;

      v_stock_after := v_stock_before - v_quantity;

      v_live_items := jsonb_set(
        v_live_items,
        array[v_live_index::text, 'stockQuantity'],
        to_jsonb(v_stock_after),
        true
      );
    end if;

    -- Accumulated rather than inserted here: the order row does not exist yet,
    -- because its totals are not known until every line has been priced.
    v_lines := v_lines || jsonb_build_object(
      'item_id', v_item_id,
      'item_name', v_item_name,
      'unit_price', v_unit_price,
      'quantity', v_quantity,
      'line_total', v_line_total,
      'track', v_track,
      'stock_before', v_stock_before,
      'stock_after', v_stock_after
    );
  end loop;

  -- ==========================================================================
  -- 8. Order-level money. Recomputed entirely from the values derived above;
  --    p_subtotal, p_tax_amount and p_total are not read.
  -- ==========================================================================
  v_subtotal := round(v_subtotal, 2);

  if not v_tax_enabled then
    v_tax_amount := 0;
    v_total_before_tip := v_subtotal;
  elsif v_tax_inclusive then
    v_tax_amount := round(v_subtotal - v_subtotal / (1 + v_rate / 100), 2);
    v_total_before_tip := v_subtotal;
  else
    v_tax_amount := round(v_subtotal * v_rate / 100, 2);
    v_total_before_tip := v_subtotal + v_tax_amount;
  end if;

  if v_tax_amount < 0 then
    v_tax_amount := 0;
  end if;

  v_total := round(v_total_before_tip + v_tip_amount, 2);

  -- Final gate before any INSERT. Finiteness is asserted BEFORE the magnitude
  -- bound, because a NaN would pass the ">" test as "too large" and a NULL
  -- would pass every comparison as UNKNOWN and then hit a not-null constraint
  -- as a raw 23502. Every one of these four values is destined for a
  -- numeric(12,2) NOT NULL column.
  if v_subtotal is null
     or v_tax_amount is null
     or v_tip_amount is null
     or v_total is null
     or v_subtotal::text in ('NaN', 'Infinity', '-Infinity')
     or v_tax_amount::text in ('NaN', 'Infinity', '-Infinity')
     or v_tip_amount::text in ('NaN', 'Infinity', '-Infinity')
     or v_total::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'Order amount is not valid';
  end if;

  if v_subtotal > c_max_money
     or v_tax_amount > c_max_money
     or v_tip_amount > c_max_money
     or v_total > c_max_money then
    raise exception 'Order amount is too large';
  end if;

  if v_subtotal < 0 or v_total < 0 then
    raise exception 'Order amounts cannot be negative';
  end if;

  -- ==========================================================================
  -- 9. Atomic write. orders -> order_items -> inventory_transactions ->
  --    projects.config, all inside this one transaction. Any raise above or
  --    below rolls the whole thing back.
  -- ==========================================================================
  insert into public.orders (
    user_id,
    project_id,
    order_number,
    payment_method,
    subtotal,
    tax_amount,
    tip_amount,
    total,
    build_job_id
  )
  values (
    v_owner_id,          -- the RESOLVED owner, never the caller, never a device
    p_project_id,
    p_order_number,
    p_payment_method,
    v_subtotal,
    v_tax_amount,
    v_tip_amount,
    v_total,
    v_build_job_id
  )
  returning id into v_order_id;

  -- Exactly one row per requested item, guaranteed by the duplicate rejection.
  insert into public.order_items (
    order_id,
    item_id,
    item_name,
    unit_price,
    quantity,
    line_total
  )
  select
    v_order_id,
    line ->> 'item_id',
    line ->> 'item_name',
    (line ->> 'unit_price')::numeric,
    (line ->> 'quantity')::integer,
    (line ->> 'line_total')::numeric
  from jsonb_array_elements(v_lines) as line;

  -- Exactly one row per TRACKED item, stamped with the resolved owner so a
  -- device's anonymous uid never appears in the audit trail.
  insert into public.inventory_transactions (
    user_id,
    project_id,
    order_id,
    item_id,
    item_name,
    transaction_type,
    quantity_change,
    quantity_before,
    quantity_after
  )
  select
    v_owner_id,
    p_project_id,
    v_order_id,
    line ->> 'item_id',
    line ->> 'item_name',
    'sale',
    -(line ->> 'quantity')::integer,
    (line ->> 'stock_before')::integer,
    (line ->> 'stock_after')::integer
  from jsonb_array_elements(v_lines) as line
  where (line ->> 'track')::boolean;

  update public.projects
  set config = jsonb_set(v_config, '{menuItems}', v_live_items, true),
      updated_at = now()
  where id = p_project_id
    and user_id = v_owner_id;

  if not found then
    raise exception 'Failed to update project inventory';
  end if;

  return v_order_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.complete_sale_v2(p_project_id uuid, p_payment_method text, p_tip_amount numeric, p_items jsonb, p_sale_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  c_max_money      constant numeric := 9999999999.99;
  c_max_unit_price constant numeric := 1000000.00;
  c_max_quantity   constant integer := 10000;
  c_max_items      constant integer := 200;
  c_max_stock      constant numeric := 1000000000;
  c_max_suffix     constant bigint  := 999999999999999;
  c_max_prefix_len constant integer := 32;

  v_caller        uuid;
  v_owner_id      uuid;
  v_is_owner      boolean;
  v_build_job_id  uuid;
  v_source        jsonb;
  v_price_items   jsonb;
  v_tax           jsonb;
  v_receipt       jsonb;

  v_config        jsonb;
  v_live_items    jsonb;

  v_method        text;
  v_tip_amount    numeric := 0;
  v_norm          jsonb := '[]'::jsonb;
  v_items_text    text;
  v_canonical     text;
  v_hash          text;

  v_order_id      uuid;
  v_existing      record;
  v_payload       jsonb;

  v_tax_enabled   boolean;
  v_tax_inclusive boolean;
  v_rate          numeric;

  v_lines         jsonb := '[]'::jsonb;
  v_item          jsonb;
  v_item_id       text;
  v_qty_num       numeric;
  v_quantity      integer;
  v_price_item    jsonb;
  v_live_item     jsonb;
  v_live_index    integer;
  v_item_name     text;
  v_unit_price    numeric;
  v_line_total    numeric;
  v_track         boolean;
  v_stock_num     numeric;
  v_stock_before  integer;
  v_stock_after   integer;

  v_subtotal      numeric := 0;
  v_tax_amount    numeric := 0;
  v_total_before_tip numeric := 0;
  v_total         numeric := 0;

  v_prefix        text;
  v_suffix        bigint;
  v_order_number  text;

  v_count         integer;
  v_distinct      integer;
  i               integer;
begin
  -- ==========================================================================
  -- 1. Caller and request shape.
  -- ==========================================================================
  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'Authentication required';
  end if;

  if p_project_id is null then
    raise exception 'Project ID is required';
  end if;

  -- A client-generated request id is mandatory. There is deliberately no
  -- server-side fallback: a generated id would make every retry look like a new
  -- sale, which is the exact failure this parameter exists to prevent. The
  -- all-zero uuid is rejected as an obvious uninitialised placeholder. Version
  -- and variant nibbles are NOT checked — any distinct uuid is a valid key, and
  -- rejecting v1/v7 ids would break clients for no security benefit.
  if p_sale_request_id is null then
    raise exception 'A sale request ID is required';
  end if;
  if p_sale_request_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception 'A sale request ID is required';
  end if;

  if p_payment_method is null or p_payment_method not in ('cash', 'card') then
    raise exception 'Invalid payment method';
  end if;
  v_method := p_payment_method;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one order item is required';
  end if;
  if jsonb_array_length(p_items) > c_max_items then
    raise exception 'Too many order items';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(p_items) e
  where jsonb_typeof(e.value) <> 'object';
  if v_count > 0 then
    raise exception 'Invalid order item';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(p_items) e
  where coalesce(btrim(e.value ->> 'itemId'), '') = '';
  if v_count > 0 then
    raise exception 'Invalid order item';
  end if;

  -- Duplicates are rejected BEFORE hashing, so two requests that differ only in
  -- how a repeated item was split across lines can never canonicalize alike.
  select count(*), count(distinct btrim(e.value ->> 'itemId'))
  into v_count, v_distinct
  from jsonb_array_elements(p_items) e;
  if v_count <> v_distinct then
    raise exception 'The same item appears more than once in this order';
  end if;

  -- ==========================================================================
  -- 2. Authorization — the only place the acting owner is established.
  -- ==========================================================================
  v_owner_id := public.resolve_sale_owner(p_project_id);
  if v_owner_id is null then
    raise exception 'Project not found or access denied';
  end if;
  v_is_owner := (v_caller = v_owner_id);

  -- ==========================================================================
  -- 3. Lock the project row. Single serialization point per project, taken
  --    before any pricing, stock, idempotency or counter access.
  -- ==========================================================================
  select p.config into v_config
  from public.projects p
  where p.id = p_project_id and p.user_id = v_owner_id
  for update;
  if not found then
    raise exception 'Project not found or access denied';
  end if;

  v_live_items := coalesce(v_config -> 'menuItems', '[]'::jsonb);
  if jsonb_typeof(v_live_items) <> 'array' then
    raise exception 'Project configuration is invalid';
  end if;

  -- Device branch: resolved here because a revoked device must be rejected even
  -- on a replay. Only the build id is read now; the snapshot itself is fetched
  -- later, so an idempotent replay never depends on it.
  if not v_is_owner then
    select d.build_job_id into v_build_job_id
    from public.paired_devices d
    where d.auth_user_id = v_caller
      and d.project_id = p_project_id
      and d.revoked_at is null;
    if not found then
      raise exception 'Project not found or access denied';
    end if;
  end if;

  -- ==========================================================================
  -- 4. Tip. Rejected for special values before the owner/device branch, since
  --    NaN sorts above every finite numeric and would otherwise be misreported.
  -- ==========================================================================
  if p_tip_amount is not null
     and p_tip_amount::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'Order amounts are not valid';
  end if;

  if v_is_owner then
    v_tip_amount := round(coalesce(p_tip_amount, 0), 2);
    if v_tip_amount < 0 then
      raise exception 'Order amounts cannot be negative';
    end if;
    if v_tip_amount > c_max_money then
      raise exception 'Order amount is too large';
    end if;
  else
    if coalesce(p_tip_amount, 0) <> 0 then
      raise exception 'Tips are not supported on this device';
    end if;
    v_tip_amount := round(0::numeric, 2);
  end if;

  -- ==========================================================================
  -- 5. Normalize items, then build the canonical preimage and its hash.
  -- ==========================================================================
  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_item_id := btrim(v_item ->> 'itemId');

    begin
      v_qty_num := (v_item ->> 'quantity')::numeric;
    exception
      when invalid_text_representation then
        raise exception 'Invalid quantity for an order item';
    end;

    if v_qty_num is null
       or v_qty_num::text in ('NaN', 'Infinity', '-Infinity')
       or v_qty_num <> trunc(v_qty_num)
       or v_qty_num < 1
       or v_qty_num > c_max_quantity then
      raise exception 'Invalid quantity for an order item';
    end if;

    v_quantity := v_qty_num::integer;

    v_norm := v_norm || jsonb_build_object('id', v_item_id, 'qty', v_quantity);
  end loop;

  select string_agg(
           octet_length(e.value ->> 'id')::text || ':' ||
           (e.value ->> 'id') || '=' || (e.value ->> 'qty'),
           E'\n' order by (e.value ->> 'id') collate "C"
         )
  into v_items_text
  from jsonb_array_elements(v_norm) e;

  v_canonical :=
    'posc.sale.v1' || E'\n' ||
    'project=' || p_project_id::text || E'\n' ||
    'payment=' || v_method || E'\n' ||
    'tip=' || v_tip_amount::text || E'\n' ||
    'items=' || jsonb_array_length(v_norm)::text ||
    case when v_items_text is null then '' else E'\n' || v_items_text end;

  v_hash := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');

  -- ==========================================================================
  -- 6. Idempotency lookup — after authorization and the lock, BEFORE counter
  --    allocation, order insert, inventory mutation and audit inserts.
  --
  --    Placed here deliberately: a replay must succeed even if the item was
  --    since renamed, repriced, removed from the menu, or has since run out of
  --    stock. The payload is rebuilt from the stored order, never recomputed.
  -- ==========================================================================
  select o.id, o.sale_request_hash into v_existing
  from public.orders o
  where o.project_id = p_project_id
    and o.sale_request_id = p_sale_request_id;

  if found then
    if v_existing.sale_request_hash is distinct from v_hash then
      raise exception 'Sale request ID was already used for a different order';
    end if;
    v_order_id := v_existing.id;
  else
    -- ========================================================================
    -- 7. New sale. Resolve the authorized pricing source.
    -- ========================================================================
    if v_is_owner then
      v_source := v_config;
    else
      select b.config_snapshot into v_source
      from public.build_jobs b
      where b.id = v_build_job_id
        and b.project_id = p_project_id
        and b.status = 'succeeded';
      if not found then
        raise exception 'This device is not linked to a usable build';
      end if;
    end if;

    v_price_items := coalesce(v_source -> 'menuItems', '[]'::jsonb);
    v_tax := coalesce(v_source -> 'tax', '{}'::jsonb);
    v_receipt := coalesce(v_source -> 'receipt', '{}'::jsonb);

    if jsonb_typeof(v_price_items) <> 'array' then
      raise exception 'Pricing configuration is invalid';
    end if;

    -- Tax settings. Malformed values fall back exactly as toRuntimeSafeTax
    -- does: a special or unparseable rate becomes 0, NOT the 100 clamp.
    begin
      v_tax_enabled := coalesce((v_tax ->> 'enabled')::boolean, true);
    exception when invalid_text_representation then v_tax_enabled := true;
    end;
    begin
      v_tax_inclusive := coalesce((v_tax ->> 'pricesIncludeTax')::boolean, false);
    exception when invalid_text_representation then v_tax_inclusive := false;
    end;
    begin
      v_rate := coalesce((v_tax ->> 'rate')::numeric, 0);
    exception when invalid_text_representation then v_rate := 0;
    end;

    if v_rate is null or v_rate::text in ('NaN', 'Infinity', '-Infinity') then
      v_rate := 0;
    elsif v_rate < 0 then
      v_rate := 0;
    elsif v_rate > 100 then
      v_rate := 100;
    end if;

    -- ========================================================================
    -- 8. Per-item server pricing and live-stock validation.
    -- ========================================================================
    for v_item in select value from jsonb_array_elements(v_norm)
    loop
      v_item_id := v_item ->> 'id';
      v_quantity := (v_item ->> 'qty')::integer;

      v_price_item := null;
      for i in 0 .. jsonb_array_length(v_price_items) - 1
      loop
        if v_price_items -> i ->> 'id' = v_item_id then
          v_price_item := v_price_items -> i;
          exit;
        end if;
      end loop;

      if v_price_item is null then
        raise exception 'Menu item % is not available', v_item_id;
      end if;

      v_item_name := btrim(coalesce(v_price_item ->> 'name', ''));
      if v_item_name = '' then
        raise exception 'Menu item % is not available', v_item_id;
      end if;

      -- ----------------------------------------------------------------
      -- Feature 18.1 — FAIL-CLOSED against stale clients.
      --
      -- v2 has no concept of modifiers. If it sold a product that now carries
      -- modifier groups, it would charge the BASE price and silently drop
      -- every option the customer asked for — an undercharge and a wrong
      -- order, produced by code that looks like it succeeded.
      --
      -- v2 therefore refuses such a product outright. This is the only change
      -- to v2's behavior, and it can only ever reject a sale that v2 was going
      -- to price incorrectly.
      --
      -- It covers BOTH branches automatically because v_price_item comes from
      -- v_source, which section 7 resolved to the owner's locked live config
      -- or to the device's pinned build snapshot. A device on an old pinned
      -- build has no modifierGroups in its snapshot and is unaffected; a
      -- device on a new pinned build is stopped here exactly like a stale
      -- browser tab.
      --
      -- Idempotent replays are unaffected: section 6 returns the stored
      -- receipt before any pricing runs, so a sale that already succeeded
      -- still replays cleanly.
      -- ----------------------------------------------------------------
      if jsonb_typeof(v_price_item -> 'modifierGroups') = 'array'
         and jsonb_array_length(v_price_item -> 'modifierGroups') > 0 then
        raise exception
          'This item now has options. Please refresh the POS and try again.';
      end if;

      begin
        v_unit_price := (v_price_item ->> 'price')::numeric;
      exception when invalid_text_representation then
        raise exception 'Menu item % has an invalid price', v_item_id;
      end;

      if v_unit_price is null
         or v_unit_price::text in ('NaN', 'Infinity', '-Infinity')
         or v_unit_price < 0
         or v_unit_price > c_max_unit_price then
        raise exception 'Menu item % has an invalid price', v_item_id;
      end if;

      v_line_total := round(v_unit_price * v_quantity, 2);
      if v_line_total is null
         or v_line_total::text in ('NaN', 'Infinity', '-Infinity') then
        raise exception 'Order amount is not valid';
      end if;
      if v_line_total > c_max_money then
        raise exception 'Order amount is too large';
      end if;

      v_subtotal := v_subtotal + v_line_total;
      if v_subtotal > c_max_money then
        raise exception 'Order amount is too large';
      end if;

      -- Inventory always from the LIVE locked config.
      v_live_index := null;
      for i in 0 .. jsonb_array_length(v_live_items) - 1
      loop
        if v_live_items -> i ->> 'id' = v_item_id then
          v_live_index := i;
          exit;
        end if;
      end loop;
      if v_live_index is null then
        raise exception 'Menu item % is not available', v_item_id;
      end if;
      v_live_item := v_live_items -> v_live_index;

      begin
        v_track := coalesce((v_live_item ->> 'trackInventory')::boolean, false);
      exception when invalid_text_representation then
        raise exception 'Inventory configuration for % is invalid', v_item_id;
      end;

      v_stock_before := 0;
      v_stock_after := 0;

      if v_track then
        begin
          v_stock_num := coalesce((v_live_item ->> 'stockQuantity')::numeric, 0);
        exception when invalid_text_representation then
          raise exception 'Inventory configuration for % is invalid', v_item_id;
        end;

        if v_stock_num is null
           or v_stock_num::text in ('NaN', 'Infinity', '-Infinity')
           or v_stock_num <> trunc(v_stock_num)
           or v_stock_num < 0
           or v_stock_num > c_max_stock then
          raise exception 'Inventory configuration for % is invalid', v_item_id;
        end if;

        v_stock_before := v_stock_num::integer;
        if v_stock_before < v_quantity then
          raise exception 'Insufficient inventory for %', v_item_name;
        end if;
        v_stock_after := v_stock_before - v_quantity;

        v_live_items := jsonb_set(
          v_live_items, array[v_live_index::text, 'stockQuantity'],
          to_jsonb(v_stock_after), true
        );
      end if;

      v_lines := v_lines || jsonb_build_object(
        'item_id', v_item_id, 'item_name', v_item_name,
        'unit_price', v_unit_price, 'quantity', v_quantity,
        'line_total', v_line_total, 'track', v_track,
        'stock_before', v_stock_before, 'stock_after', v_stock_after
      );
    end loop;

    -- ========================================================================
    -- 9. Order-level money — identical rules and rounding points to Migration C.
    -- ========================================================================
    v_subtotal := round(v_subtotal, 2);

    if not v_tax_enabled then
      v_tax_amount := 0;
      v_total_before_tip := v_subtotal;
    elsif v_tax_inclusive then
      v_tax_amount := round(v_subtotal - v_subtotal / (1 + v_rate / 100), 2);
      v_total_before_tip := v_subtotal;
    else
      v_tax_amount := round(v_subtotal * v_rate / 100, 2);
      v_total_before_tip := v_subtotal + v_tax_amount;
    end if;

    if v_tax_amount < 0 then
      v_tax_amount := 0;
    end if;

    v_total := round(v_total_before_tip + v_tip_amount, 2);

    if v_subtotal is null or v_tax_amount is null
       or v_tip_amount is null or v_total is null
       or v_subtotal::text in ('NaN', 'Infinity', '-Infinity')
       or v_tax_amount::text in ('NaN', 'Infinity', '-Infinity')
       or v_tip_amount::text in ('NaN', 'Infinity', '-Infinity')
       or v_total::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'Order amount is not valid';
    end if;

    if v_subtotal > c_max_money or v_tax_amount > c_max_money
       or v_tip_amount > c_max_money or v_total > c_max_money then
      raise exception 'Order amount is too large';
    end if;

    if v_subtotal < 0 or v_total < 0 then
      raise exception 'Order amounts cannot be negative';
    end if;

    -- ========================================================================
    -- 10. Order number. Prefix from the SAME authorized source as the prices,
    --     so a device's receipt prefix matches the build it is pinned to.
    -- ========================================================================
    v_prefix := btrim(coalesce(v_receipt ->> 'orderPrefix', ''));
    v_prefix := regexp_replace(v_prefix, '[[:cntrl:]]', '', 'g');
    if length(v_prefix) > c_max_prefix_len then
      v_prefix := left(v_prefix, c_max_prefix_len);
    end if;

    -- Lazily create the counter: D2 seeded only the projects that existed then,
    -- so any project created afterwards gets its row here, on first sale.
    insert into public.project_order_counters (project_id, last_number)
    values (p_project_id, 1000)
    on conflict (project_id) do nothing;

    select c.last_number into v_suffix
    from public.project_order_counters c
    where c.project_id = p_project_id
    for update;

    if v_suffix is null then
      raise exception 'Order number could not be allocated';
    end if;
    if v_suffix >= c_max_suffix then
      raise exception 'Order number sequence exhausted for this project';
    end if;

    -- Transactional allocation. Not a sequence: nextval is non-transactional
    -- and would leave a permanent gap on every rolled-back sale.
    update public.project_order_counters
    set last_number = last_number + 1,
        updated_at = now()
    where project_id = p_project_id
    returning last_number into v_suffix;

    v_order_number := v_prefix || v_suffix::text;

    -- ========================================================================
    -- 11. Atomic write.
    -- ========================================================================
    begin
      insert into public.orders (
        user_id, project_id, order_number, payment_method,
        subtotal, tax_amount, tip_amount, total,
        number_source, sale_request_id, sale_request_hash,
        build_job_id
      )
      values (
        v_owner_id, p_project_id, v_order_number, v_method,
        v_subtotal, v_tax_amount, v_tip_amount, v_total,
        'server', p_sale_request_id, v_hash,
        v_build_job_id
      )
      returning id into v_order_id;
    exception
      when unique_violation then
        -- The project FOR UPDATE lock serializes every sale for this project,
        -- so this should be unreachable. It is kept as a final backstop rather
        -- than a primary path: re-read the winning row and apply the SAME hash
        -- comparison, so a racing duplicate replays instead of double-selling.
        -- The subtransaction rollback has already undone this INSERT; no
        -- inventory row or config update has been written yet.
        select o.id, o.sale_request_hash into v_existing
        from public.orders o
        where o.project_id = p_project_id
          and o.sale_request_id = p_sale_request_id;

        if not found then
          raise exception 'Could not allocate a unique order number';
        end if;
        if v_existing.sale_request_hash is distinct from v_hash then
          raise exception 'Sale request ID was already used for a different order';
        end if;
        v_order_id := v_existing.id;
    end;

    -- Only write the rest when this call actually created the order.
    if not exists (
      select 1 from public.order_items oi where oi.order_id = v_order_id
    ) then
      insert into public.order_items (
        order_id, item_id, item_name, unit_price, quantity, line_total
      )
      select v_order_id, line ->> 'item_id', line ->> 'item_name',
             (line ->> 'unit_price')::numeric, (line ->> 'quantity')::integer,
             (line ->> 'line_total')::numeric
      from jsonb_array_elements(v_lines) as line;

      insert into public.inventory_transactions (
        user_id, project_id, order_id, item_id, item_name,
        transaction_type, quantity_change, quantity_before, quantity_after
      )
      select v_owner_id, p_project_id, v_order_id, line ->> 'item_id',
             line ->> 'item_name', 'sale',
             -(line ->> 'quantity')::integer,
             (line ->> 'stock_before')::integer,
             (line ->> 'stock_after')::integer
      from jsonb_array_elements(v_lines) as line
      where (line ->> 'track')::boolean;

      update public.projects
      set config = jsonb_set(v_config, '{menuItems}', v_live_items, true),
          updated_at = now()
      where id = p_project_id and user_id = v_owner_id;

      if not found then
        raise exception 'Failed to update project inventory';
      end if;
    end if;
  end if;

  -- ==========================================================================
  -- 12. Authoritative payload — ONE construction path, used by both the new-sale
  --     and the idempotent-replay branch, always rebuilt from the stored rows.
  --
  --     Money is returned as fixed two-decimal STRINGS. numeric(12,2)::text is
  --     exact; a JSON number would be parsed into an IEEE-754 double by the
  --     browser and could render a cent differently from what is stored.
  --     Deliberately absent: user_id, sale_request_id, sale_request_hash,
  --     build id, device id, config snapshot and inventory before/after values.
  -- ==========================================================================
  select jsonb_build_object(
           'orderId', o.id::text,
           'orderNumber', o.order_number,
           'paymentMethod', o.payment_method,
           'subtotal', o.subtotal::text,
           'taxAmount', o.tax_amount::text,
           'tipAmount', o.tip_amount::text,
           'total', o.total::text,
           'createdAt', to_char(o.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'items', coalesce((
             select jsonb_agg(
                      jsonb_build_object(
                        'itemId', oi.item_id,
                        'itemName', oi.item_name,
                        'unitPrice', oi.unit_price::text,
                        'quantity', oi.quantity,
                        'lineTotal', oi.line_total::text
                      )
                      order by oi.item_id collate "C"
                    )
             from public.order_items oi
             where oi.order_id = o.id
           ), '[]'::jsonb)
         )
  into v_payload
  from public.orders o
  where o.id = v_order_id;

  if v_payload is null then
    raise exception 'Order could not be loaded';
  end if;

  return v_payload;
end;
$function$;

CREATE OR REPLACE FUNCTION public.complete_sale_v3(p_project_id uuid, p_payment_method text, p_tip_amount numeric, p_items jsonb, p_sale_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  c_max_money      constant numeric := 9999999999.99;
  c_max_unit_price constant numeric := 1000000.00;
  c_max_quantity   constant integer := 10000;
  c_max_items      constant integer := 200;
  c_max_stock      constant numeric := 1000000000;
  c_max_suffix     constant bigint  := 999999999999999;
  c_max_prefix_len constant integer := 32;

  v_caller        uuid;
  v_owner_id      uuid;
  v_is_owner      boolean;
  v_build_job_id  uuid;
  v_source        jsonb;
  v_price_items   jsonb;
  v_tax           jsonb;
  v_receipt       jsonb;

  v_config        jsonb;
  v_live_items    jsonb;

  v_method        text;
  v_tip_amount    numeric := 0;
  v_norm          jsonb := '[]'::jsonb;
  v_items_text    text;
  v_canonical     text;
  v_hash          text;

  v_order_id      uuid;
  v_existing      record;
  v_payload       jsonb;

  v_tax_enabled   boolean;
  v_tax_inclusive boolean;
  v_rate          numeric;

  v_lines         jsonb := '[]'::jsonb;
  v_item          jsonb;
  v_item_id       text;
  v_qty_num       numeric;
  v_quantity      integer;
  v_price_item    jsonb;
  v_live_item     jsonb;
  v_live_index    integer;
  v_item_name     text;
  v_unit_price    numeric;
  v_line_total    numeric;
  v_track         boolean;
  v_stock_num     numeric;
  v_stock_before  integer;
  v_stock_after   integer;

  v_subtotal      numeric := 0;
  v_tax_amount    numeric := 0;
  v_total_before_tip numeric := 0;
  v_total         numeric := 0;

  v_prefix        text;
  v_suffix        bigint;
  v_order_number  text;

  v_count         integer;
  v_distinct      integer;
  i               integer;

  -- Feature 18.1 — modifier state. Everything here is derived from the
  -- AUTHORIZED config; the request contributes identifiers only.
  c_max_mod_groups   constant integer := 10;
  c_max_mod_options  constant integer := 20;
  c_max_mod_selected constant integer := 50;

  v_mods          jsonb;
  v_mod_groups    jsonb;
  v_mod_sel       jsonb;
  v_mod_group     jsonb;
  v_mod_option    jsonb;
  v_mod_opt_id    text;
  v_group_id      text;
  v_group_found   boolean;
  v_option_found  boolean;
  v_mod_adjust    numeric;
  v_mod_total     numeric;
  v_mod_snapshot  jsonb;
  v_mod_count     integer;
  v_sel_count     integer;
  v_selected_total integer;
  v_line_identity text;
  v_mod_text      text;
  v_required_ok   boolean;
  j               integer;
  k               integer;
begin
  -- ==========================================================================
  -- 1. Caller and request shape.
  -- ==========================================================================
  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'Authentication required';
  end if;

  if p_project_id is null then
    raise exception 'Project ID is required';
  end if;

  -- A client-generated request id is mandatory. There is deliberately no
  -- server-side fallback: a generated id would make every retry look like a new
  -- sale, which is the exact failure this parameter exists to prevent. The
  -- all-zero uuid is rejected as an obvious uninitialised placeholder. Version
  -- and variant nibbles are NOT checked — any distinct uuid is a valid key, and
  -- rejecting v1/v7 ids would break clients for no security benefit.
  if p_sale_request_id is null then
    raise exception 'A sale request ID is required';
  end if;
  if p_sale_request_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception 'A sale request ID is required';
  end if;

  if p_payment_method is null or p_payment_method not in ('cash', 'card') then
    raise exception 'Invalid payment method';
  end if;
  v_method := p_payment_method;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one order item is required';
  end if;
  if jsonb_array_length(p_items) > c_max_items then
    raise exception 'Too many order items';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(p_items) e
  where jsonb_typeof(e.value) <> 'object';
  if v_count > 0 then
    raise exception 'Invalid order item';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(p_items) e
  where coalesce(btrim(e.value ->> 'itemId'), '') = '';
  if v_count > 0 then
    raise exception 'Invalid order item';
  end if;

  -- Feature 18.1 — the v2 duplicate-itemId rule cannot survive verbatim: the
  -- same product with two different modifier selections is two legitimate
  -- lines. It is replaced by a duplicate-LINE rule in section 5, which
  -- compares the canonical (item + selection) identity and therefore keeps the
  -- exact property v2's rule protected — two requests that differ only in how
  -- one line was split can still never canonicalize alike.

  -- Modifier payload shape. Checked here, before any config is loaded, so a
  -- malformed or oversized request never reaches the pricing loop.
  select count(*) into v_count
  from jsonb_array_elements(p_items) e
  where e.value ? 'modifiers'
    and jsonb_typeof(e.value -> 'modifiers') <> 'array';
  if v_count > 0 then
    raise exception 'Invalid order item';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(p_items) e
  where jsonb_array_length(coalesce(e.value -> 'modifiers', '[]'::jsonb)) > c_max_mod_groups;
  if v_count > 0 then
    raise exception 'Too many options for an order item';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(p_items) e,
       jsonb_array_elements(coalesce(e.value -> 'modifiers', '[]'::jsonb)) m
  where jsonb_typeof(m.value) <> 'object'
     or coalesce(btrim(m.value ->> 'groupId'), '') = ''
     or (m.value ? 'optionIds' and jsonb_typeof(m.value -> 'optionIds') <> 'array');
  if v_count > 0 then
    raise exception 'Invalid order item';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(p_items) e,
       jsonb_array_elements(coalesce(e.value -> 'modifiers', '[]'::jsonb)) m
  where jsonb_array_length(coalesce(m.value -> 'optionIds', '[]'::jsonb)) > c_max_mod_options;
  if v_count > 0 then
    raise exception 'Too many options for an order item';
  end if;

  -- Every option id must be a non-empty string. jsonb_array_elements_text
  -- renders a non-string element as its text form, so the type is checked
  -- explicitly rather than inferred.
  select count(*) into v_count
  from jsonb_array_elements(p_items) e,
       jsonb_array_elements(coalesce(e.value -> 'modifiers', '[]'::jsonb)) m,
       jsonb_array_elements(coalesce(m.value -> 'optionIds', '[]'::jsonb)) o
  where jsonb_typeof(o.value) <> 'string'
     or coalesce(btrim(o.value #>> '{}'), '') = '';
  if v_count > 0 then
    raise exception 'Invalid order item';
  end if;

  -- ==========================================================================
  -- 2. Authorization — the only place the acting owner is established.
  -- ==========================================================================
  v_owner_id := public.resolve_sale_owner(p_project_id);
  if v_owner_id is null then
    raise exception 'Project not found or access denied';
  end if;
  v_is_owner := (v_caller = v_owner_id);

  -- ==========================================================================
  -- 3. Lock the project row. Single serialization point per project, taken
  --    before any pricing, stock, idempotency or counter access.
  -- ==========================================================================
  select p.config into v_config
  from public.projects p
  where p.id = p_project_id and p.user_id = v_owner_id
  for update;
  if not found then
    raise exception 'Project not found or access denied';
  end if;

  v_live_items := coalesce(v_config -> 'menuItems', '[]'::jsonb);
  if jsonb_typeof(v_live_items) <> 'array' then
    raise exception 'Project configuration is invalid';
  end if;

  -- Device branch: resolved here because a revoked device must be rejected even
  -- on a replay. Only the build id is read now; the snapshot itself is fetched
  -- later, so an idempotent replay never depends on it.
  if not v_is_owner then
    select d.build_job_id into v_build_job_id
    from public.paired_devices d
    where d.auth_user_id = v_caller
      and d.project_id = p_project_id
      and d.revoked_at is null
      -- Feature 25.1 — stated explicitly here as well as inside
      -- resolve_sale_owner. Two predicates that mean the same thing must say the
      -- same thing, or they drift apart silently.
      and d.unpaired_at is null;
    if not found then
      raise exception 'Project not found or access denied';
    end if;
  end if;

  -- ==========================================================================
  -- 4. Tip. Rejected for special values before the owner/device branch, since
  --    NaN sorts above every finite numeric and would otherwise be misreported.
  -- ==========================================================================
  if p_tip_amount is not null
     and p_tip_amount::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'Order amounts are not valid';
  end if;

  if v_is_owner then
    v_tip_amount := round(coalesce(p_tip_amount, 0), 2);
    if v_tip_amount < 0 then
      raise exception 'Order amounts cannot be negative';
    end if;
    if v_tip_amount > c_max_money then
      raise exception 'Order amount is too large';
    end if;
  else
    if coalesce(p_tip_amount, 0) <> 0 then
      raise exception 'Tips are not supported on this device';
    end if;
    v_tip_amount := round(0::numeric, 2);
  end if;

  -- ==========================================================================
  -- 5. Normalize items, then build the canonical preimage and its hash.
  -- ==========================================================================
  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_item_id := btrim(v_item ->> 'itemId');

    begin
      v_qty_num := (v_item ->> 'quantity')::numeric;
    exception
      when invalid_text_representation then
        raise exception 'Invalid quantity for an order item';
    end;

    if v_qty_num is null
       or v_qty_num::text in ('NaN', 'Infinity', '-Infinity')
       or v_qty_num <> trunc(v_qty_num)
       or v_qty_num < 1
       or v_qty_num > c_max_quantity then
      raise exception 'Invalid quantity for an order item';
    end if;

    v_quantity := v_qty_num::integer;

    v_mods := coalesce(v_item -> 'modifiers', '[]'::jsonb);

    -- A group carrying no options selects nothing, so it is dropped before the
    -- identity is built. Keeping it would make {g:[]} and an omitted g two
    -- different identities for the same cart.
    select coalesce(jsonb_agg(m.value order by btrim(m.value ->> 'groupId') collate "C"), '[]'::jsonb)
    into v_mods
    from jsonb_array_elements(v_mods) m
    where jsonb_array_length(coalesce(m.value -> 'optionIds', '[]'::jsonb)) > 0;

    -- Duplicate group ids inside one line would make the identity ambiguous.
    select count(*), count(distinct btrim(m.value ->> 'groupId'))
    into v_count, v_distinct
    from jsonb_array_elements(v_mods) m;
    if v_count <> v_distinct then
      raise exception 'The same option group appears more than once for an item';
    end if;

    select count(*) into v_selected_total
    from jsonb_array_elements(v_mods) m,
         jsonb_array_elements_text(m.value -> 'optionIds') o;
    if v_selected_total > c_max_mod_selected then
      raise exception 'Too many options for an order item';
    end if;

    -- Duplicate option ids inside one group: same reasoning.
    select count(*) into v_count
    from jsonb_array_elements(v_mods) m
    where (select count(*) from jsonb_array_elements_text(m.value -> 'optionIds')) <>
          (select count(distinct o.value) from jsonb_array_elements_text(m.value -> 'optionIds') o);
    if v_count > 0 then
      raise exception 'The same option appears more than once for an item';
    end if;

    -- CANONICAL LINE IDENTITY.
    --   <len(itemId)>:<itemId>[<groups>]<group>*
    --   group  := <len(gid)>:<gid>(<options>)<option>*
    --   option := <len(oid)>:<oid>
    -- Every id is byte-length-prefixed and every repeat carries an explicit
    -- count, so the string parses back unambiguously — a delimiter inside an id
    -- cannot shift the reading. Groups sort by group id and options by option
    -- id, so the order a cashier tapped them in cannot change the identity.
    -- This is the same injectivity technique v2 uses for item ids, extended one
    -- level down.
    select coalesce(string_agg(
             octet_length(g.gid)::text || ':' || g.gid ||
             '(' || g.optcount::text || ')' || g.opts,
             '' order by g.gid collate "C"), '')
    into v_mod_text
    from (
      select btrim(m.value ->> 'groupId') as gid,
             (select count(*) from jsonb_array_elements_text(m.value -> 'optionIds')) as optcount,
             (select coalesce(string_agg(
                       octet_length(o.value)::text || ':' || o.value,
                       '' order by o.value collate "C"), '')
              from jsonb_array_elements_text(m.value -> 'optionIds') o) as opts
      from jsonb_array_elements(v_mods) m
    ) g;

    v_line_identity :=
      octet_length(v_item_id)::text || ':' || v_item_id ||
      '[' || jsonb_array_length(v_mods)::text || ']' || v_mod_text;

    v_norm := v_norm || jsonb_build_object(
      'id', v_item_id,
      'qty', v_quantity,
      'mods', v_mods,
      'key', v_line_identity
    );
  end loop;

  -- Duplicate LINES — the modifier-aware replacement for v2's duplicate-item
  -- rule. The same product with different selections is allowed; the identical
  -- product-and-selection twice is not.
  select count(*), count(distinct e.value ->> 'key')
  into v_count, v_distinct
  from jsonb_array_elements(v_norm) e;
  if v_count <> v_distinct then
    raise exception 'The same item and options appear more than once in this order';
  end if;

  select string_agg(
           (e.value ->> 'key') || '=' || (e.value ->> 'qty'),
           E'\n' order by (e.value ->> 'key') collate "C"
         )
  into v_items_text
  from jsonb_array_elements(v_norm) e;

  -- A NEW canonical format. v1 keyed a line on item id alone, so two different
  -- modifier selections of one product would collide. complete_sale_v2's own
  -- preimage is deliberately left untouched, so a stale tab still hashes
  -- exactly as it always did.
  v_canonical :=
    'posc.sale.v2' || E'\n' ||
    'project=' || p_project_id::text || E'\n' ||
    'payment=' || v_method || E'\n' ||
    'tip=' || v_tip_amount::text || E'\n' ||
    'items=' || jsonb_array_length(v_norm)::text ||
    case when v_items_text is null then '' else E'\n' || v_items_text end;

  v_hash := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');

  -- ==========================================================================
  -- 6. Idempotency lookup — after authorization and the lock, BEFORE counter
  --    allocation, order insert, inventory mutation and audit inserts.
  --
  --    Placed here deliberately: a replay must succeed even if the item was
  --    since renamed, repriced, removed from the menu, or has since run out of
  --    stock. The payload is rebuilt from the stored order, never recomputed.
  -- ==========================================================================
  select o.id, o.sale_request_hash into v_existing
  from public.orders o
  where o.project_id = p_project_id
    and o.sale_request_id = p_sale_request_id;

  if found then
    if v_existing.sale_request_hash is distinct from v_hash then
      raise exception 'Sale request ID was already used for a different order';
    end if;
    v_order_id := v_existing.id;
  else
    -- ========================================================================
    -- 7. New sale. Resolve the authorized pricing source.
    -- ========================================================================
    if v_is_owner then
      v_source := v_config;
    else
      select b.config_snapshot into v_source
      from public.build_jobs b
      where b.id = v_build_job_id
        and b.project_id = p_project_id
        and b.status = 'succeeded';
      if not found then
        raise exception 'This device is not linked to a usable build';
      end if;
    end if;

    v_price_items := coalesce(v_source -> 'menuItems', '[]'::jsonb);
    v_tax := coalesce(v_source -> 'tax', '{}'::jsonb);
    v_receipt := coalesce(v_source -> 'receipt', '{}'::jsonb);

    if jsonb_typeof(v_price_items) <> 'array' then
      raise exception 'Pricing configuration is invalid';
    end if;

    -- Tax settings. Malformed values fall back exactly as toRuntimeSafeTax
    -- does: a special or unparseable rate becomes 0, NOT the 100 clamp.
    begin
      v_tax_enabled := coalesce((v_tax ->> 'enabled')::boolean, true);
    exception when invalid_text_representation then v_tax_enabled := true;
    end;
    begin
      v_tax_inclusive := coalesce((v_tax ->> 'pricesIncludeTax')::boolean, false);
    exception when invalid_text_representation then v_tax_inclusive := false;
    end;
    begin
      v_rate := coalesce((v_tax ->> 'rate')::numeric, 0);
    exception when invalid_text_representation then v_rate := 0;
    end;

    if v_rate is null or v_rate::text in ('NaN', 'Infinity', '-Infinity') then
      v_rate := 0;
    elsif v_rate < 0 then
      v_rate := 0;
    elsif v_rate > 100 then
      v_rate := 100;
    end if;

    -- ========================================================================
    -- 8. Per-item server pricing and live-stock validation.
    -- ========================================================================
    for v_item in select value from jsonb_array_elements(v_norm)
    loop
      v_item_id := v_item ->> 'id';
      v_quantity := (v_item ->> 'qty')::integer;
      v_mods := coalesce(v_item -> 'mods', '[]'::jsonb);

      v_price_item := null;
      for i in 0 .. jsonb_array_length(v_price_items) - 1
      loop
        if v_price_items -> i ->> 'id' = v_item_id then
          v_price_item := v_price_items -> i;
          exit;
        end if;
      end loop;

      if v_price_item is null then
        raise exception 'Menu item % is not available', v_item_id;
      end if;

      v_item_name := btrim(coalesce(v_price_item ->> 'name', ''));
      if v_item_name = '' then
        raise exception 'Menu item % is not available', v_item_id;
      end if;

      begin
        v_unit_price := (v_price_item ->> 'price')::numeric;
      exception when invalid_text_representation then
        raise exception 'Menu item % has an invalid price', v_item_id;
      end;

      if v_unit_price is null
         or v_unit_price::text in ('NaN', 'Infinity', '-Infinity')
         or v_unit_price < 0
         or v_unit_price > c_max_unit_price then
        raise exception 'Menu item % has an invalid price', v_item_id;
      end if;

      -- ----------------------------------------------------------------
      -- Feature 18.1 — modifier resolution, validation and pricing.
      --
      -- Every value used below comes from v_price_item, which is the
      -- AUTHORIZED source resolved in section 7 (the owner's locked live
      -- config, or the device's pinned build snapshot). The request supplied
      -- identifiers and nothing else; there is no field in it for a name or a
      -- price, so none can be trusted by accident.
      -- ----------------------------------------------------------------
      v_mod_groups := coalesce(v_price_item -> 'modifierGroups', '[]'::jsonb);
      if jsonb_typeof(v_mod_groups) <> 'array' then
        v_mod_groups := '[]'::jsonb;
      end if;

      v_mod_total := 0;
      v_mod_snapshot := '[]'::jsonb;

      -- A product with no groups accepts no selections. This is what stops an
      -- option being attached to a plain item, or borrowed from another product.
      if jsonb_array_length(v_mod_groups) = 0 and jsonb_array_length(v_mods) > 0 then
        raise exception 'Menu item % does not have options', v_item_id;
      end if;

      for j in 0 .. jsonb_array_length(v_mods) - 1
      loop
        v_mod_sel := v_mods -> j;
        v_group_id := btrim(v_mod_sel ->> 'groupId');

        -- The group must belong to THIS product.
        v_mod_group := null;
        for k in 0 .. jsonb_array_length(v_mod_groups) - 1
        loop
          if v_mod_groups -> k ->> 'id' = v_group_id then
            v_mod_group := v_mod_groups -> k;
            exit;
          end if;
        end loop;

        if v_mod_group is null then
          raise exception 'Menu item % does not have that option group', v_item_id;
        end if;

        v_sel_count := jsonb_array_length(coalesce(v_mod_sel -> 'optionIds', '[]'::jsonb));

        -- A single-choice group accepts at most one option.
        if coalesce(v_mod_group ->> 'selection', 'single') = 'single' and v_sel_count > 1 then
          raise exception 'Only one option may be chosen for %', coalesce(v_mod_group ->> 'name', v_group_id);
        end if;

        -- maxSelections applies to multiple-choice groups only, and only when set.
        if coalesce(v_mod_group ->> 'selection', 'single') = 'multiple'
           and v_mod_group -> 'maxSelections' is not null
           and jsonb_typeof(v_mod_group -> 'maxSelections') = 'number'
           and v_sel_count > (v_mod_group ->> 'maxSelections')::integer then
          raise exception 'Too many options chosen for %', coalesce(v_mod_group ->> 'name', v_group_id);
        end if;

        for k in 0 .. v_sel_count - 1
        loop
          v_mod_opt_id := btrim(v_mod_sel -> 'optionIds' ->> k);

          -- The option must belong to THIS group, not merely to the product.
          v_mod_option := null;
          for i in 0 .. jsonb_array_length(coalesce(v_mod_group -> 'options', '[]'::jsonb)) - 1
          loop
            if v_mod_group -> 'options' -> i ->> 'id' = v_mod_opt_id then
              v_mod_option := v_mod_group -> 'options' -> i;
              exit;
            end if;
          end loop;

          if v_mod_option is null then
            raise exception 'That option is not available for %', coalesce(v_mod_group ->> 'name', v_group_id);
          end if;

          begin
            v_mod_adjust := (v_mod_option ->> 'priceAdjustment')::numeric;
          exception when invalid_text_representation then
            raise exception 'An option for % has an invalid price', v_item_id;
          end;

          -- Same money discipline as the base price: MVP adjustments are
          -- non-negative, finite, and bounded by the per-unit ceiling.
          if v_mod_adjust is null
             or v_mod_adjust::text in ('NaN', 'Infinity', '-Infinity')
             or v_mod_adjust < 0
             or v_mod_adjust > c_max_unit_price then
            raise exception 'An option for % has an invalid price', v_item_id;
          end if;

          v_mod_total := v_mod_total + v_mod_adjust;

          -- The historical snapshot: names and prices as they are RIGHT NOW,
          -- so a receipt reprinted after a menu change still shows what the
          -- customer actually bought and paid.
          v_mod_snapshot := v_mod_snapshot || jsonb_build_object(
            'groupId', v_group_id,
            'groupName', coalesce(v_mod_group ->> 'name', ''),
            'optionId', v_mod_opt_id,
            'optionName', coalesce(v_mod_option ->> 'name', ''),
            'priceAdjustment', round(v_mod_adjust, 2)::text
          );
        end loop;
      end loop;

      -- Required groups must be satisfied. Checked over the PRODUCT's groups
      -- rather than the submission, so an omitted group is caught as readily as
      -- an empty one.
      for k in 0 .. jsonb_array_length(v_mod_groups) - 1
      loop
        if (v_mod_groups -> k ->> 'required')::boolean is true then
          v_required_ok := false;

          for j in 0 .. jsonb_array_length(v_mods) - 1
          loop
            if btrim(v_mods -> j ->> 'groupId') = (v_mod_groups -> k ->> 'id')
               and jsonb_array_length(coalesce(v_mods -> j -> 'optionIds', '[]'::jsonb)) > 0 then
              v_required_ok := true;
              exit;
            end if;
          end loop;

          if not v_required_ok then
            raise exception 'Please choose % for %',
              coalesce(v_mod_groups -> k ->> 'name', 'an option'), v_item_name;
          end if;
        end if;
      end loop;

      -- The line's unit price is the base plus every selected adjustment. It is
      -- re-bounded because the sum can exceed the per-unit ceiling even when
      -- each part is individually valid.
      v_unit_price := round(v_unit_price + v_mod_total, 2);

      if v_unit_price is null
         or v_unit_price::text in ('NaN', 'Infinity', '-Infinity')
         or v_unit_price < 0
         or v_unit_price > c_max_unit_price then
        raise exception 'Menu item % has an invalid price', v_item_id;
      end if;

      v_line_total := round(v_unit_price * v_quantity, 2);
      if v_line_total is null
         or v_line_total::text in ('NaN', 'Infinity', '-Infinity') then
        raise exception 'Order amount is not valid';
      end if;
      if v_line_total > c_max_money then
        raise exception 'Order amount is too large';
      end if;

      v_subtotal := v_subtotal + v_line_total;
      if v_subtotal > c_max_money then
        raise exception 'Order amount is too large';
      end if;

      -- Inventory always from the LIVE locked config.
      v_live_index := null;
      for i in 0 .. jsonb_array_length(v_live_items) - 1
      loop
        if v_live_items -> i ->> 'id' = v_item_id then
          v_live_index := i;
          exit;
        end if;
      end loop;
      if v_live_index is null then
        raise exception 'Menu item % is not available', v_item_id;
      end if;
      v_live_item := v_live_items -> v_live_index;

      begin
        v_track := coalesce((v_live_item ->> 'trackInventory')::boolean, false);
      exception when invalid_text_representation then
        raise exception 'Inventory configuration for % is invalid', v_item_id;
      end;

      v_stock_before := 0;
      v_stock_after := 0;

      if v_track then
        begin
          v_stock_num := coalesce((v_live_item ->> 'stockQuantity')::numeric, 0);
        exception when invalid_text_representation then
          raise exception 'Inventory configuration for % is invalid', v_item_id;
        end;

        if v_stock_num is null
           or v_stock_num::text in ('NaN', 'Infinity', '-Infinity')
           or v_stock_num <> trunc(v_stock_num)
           or v_stock_num < 0
           or v_stock_num > c_max_stock then
          raise exception 'Inventory configuration for % is invalid', v_item_id;
        end if;

        v_stock_before := v_stock_num::integer;
        if v_stock_before < v_quantity then
          raise exception 'Insufficient inventory for %', v_item_name;
        end if;
        v_stock_after := v_stock_before - v_quantity;

        v_live_items := jsonb_set(
          v_live_items, array[v_live_index::text, 'stockQuantity'],
          to_jsonb(v_stock_after), true
        );
      end if;

      v_lines := v_lines || jsonb_build_object(
        'item_id', v_item_id, 'item_name', v_item_name,
        'unit_price', v_unit_price, 'quantity', v_quantity,
        'line_total', v_line_total, 'track', v_track,
        'stock_before', v_stock_before, 'stock_after', v_stock_after,
        'modifiers', v_mod_snapshot
      );
    end loop;

    -- ========================================================================
    -- 9. Order-level money — identical rules and rounding points to Migration C.
    -- ========================================================================
    v_subtotal := round(v_subtotal, 2);

    if not v_tax_enabled then
      v_tax_amount := 0;
      v_total_before_tip := v_subtotal;
    elsif v_tax_inclusive then
      v_tax_amount := round(v_subtotal - v_subtotal / (1 + v_rate / 100), 2);
      v_total_before_tip := v_subtotal;
    else
      v_tax_amount := round(v_subtotal * v_rate / 100, 2);
      v_total_before_tip := v_subtotal + v_tax_amount;
    end if;

    if v_tax_amount < 0 then
      v_tax_amount := 0;
    end if;

    v_total := round(v_total_before_tip + v_tip_amount, 2);

    if v_subtotal is null or v_tax_amount is null
       or v_tip_amount is null or v_total is null
       or v_subtotal::text in ('NaN', 'Infinity', '-Infinity')
       or v_tax_amount::text in ('NaN', 'Infinity', '-Infinity')
       or v_tip_amount::text in ('NaN', 'Infinity', '-Infinity')
       or v_total::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'Order amount is not valid';
    end if;

    if v_subtotal > c_max_money or v_tax_amount > c_max_money
       or v_tip_amount > c_max_money or v_total > c_max_money then
      raise exception 'Order amount is too large';
    end if;

    if v_subtotal < 0 or v_total < 0 then
      raise exception 'Order amounts cannot be negative';
    end if;

    -- ========================================================================
    -- 10. Order number. Prefix from the SAME authorized source as the prices,
    --     so a device's receipt prefix matches the build it is pinned to.
    -- ========================================================================
    v_prefix := btrim(coalesce(v_receipt ->> 'orderPrefix', ''));
    v_prefix := regexp_replace(v_prefix, '[[:cntrl:]]', '', 'g');
    if length(v_prefix) > c_max_prefix_len then
      v_prefix := left(v_prefix, c_max_prefix_len);
    end if;

    -- Lazily create the counter: D2 seeded only the projects that existed then,
    -- so any project created afterwards gets its row here, on first sale.
    insert into public.project_order_counters (project_id, last_number)
    values (p_project_id, 1000)
    on conflict (project_id) do nothing;

    select c.last_number into v_suffix
    from public.project_order_counters c
    where c.project_id = p_project_id
    for update;

    if v_suffix is null then
      raise exception 'Order number could not be allocated';
    end if;
    if v_suffix >= c_max_suffix then
      raise exception 'Order number sequence exhausted for this project';
    end if;

    -- Transactional allocation. Not a sequence: nextval is non-transactional
    -- and would leave a permanent gap on every rolled-back sale.
    update public.project_order_counters
    set last_number = last_number + 1,
        updated_at = now()
    where project_id = p_project_id
    returning last_number into v_suffix;

    v_order_number := v_prefix || v_suffix::text;

    -- ========================================================================
    -- 11. Atomic write.
    -- ========================================================================
    begin
      insert into public.orders (
        user_id, project_id, order_number, payment_method,
        subtotal, tax_amount, tip_amount, total,
        number_source, sale_request_id, sale_request_hash,
        build_job_id
      )
      values (
        v_owner_id, p_project_id, v_order_number, v_method,
        v_subtotal, v_tax_amount, v_tip_amount, v_total,
        'server', p_sale_request_id, v_hash,
        v_build_job_id
      )
      returning id into v_order_id;
    exception
      when unique_violation then
        -- The project FOR UPDATE lock serializes every sale for this project,
        -- so this should be unreachable. It is kept as a final backstop rather
        -- than a primary path: re-read the winning row and apply the SAME hash
        -- comparison, so a racing duplicate replays instead of double-selling.
        -- The subtransaction rollback has already undone this INSERT; no
        -- inventory row or config update has been written yet.
        select o.id, o.sale_request_hash into v_existing
        from public.orders o
        where o.project_id = p_project_id
          and o.sale_request_id = p_sale_request_id;

        if not found then
          raise exception 'Could not allocate a unique order number';
        end if;
        if v_existing.sale_request_hash is distinct from v_hash then
          raise exception 'Sale request ID was already used for a different order';
        end if;
        v_order_id := v_existing.id;
    end;

    -- Only write the rest when this call actually created the order.
    if not exists (
      select 1 from public.order_items oi where oi.order_id = v_order_id
    ) then
      insert into public.order_items (
        order_id, item_id, item_name, unit_price, quantity, line_total, modifiers
      )
      select v_order_id, line ->> 'item_id', line ->> 'item_name',
             (line ->> 'unit_price')::numeric, (line ->> 'quantity')::integer,
             (line ->> 'line_total')::numeric,
             coalesce(line -> 'modifiers', '[]'::jsonb)
      from jsonb_array_elements(v_lines) as line;

      insert into public.inventory_transactions (
        user_id, project_id, order_id, item_id, item_name,
        transaction_type, quantity_change, quantity_before, quantity_after
      )
      select v_owner_id, p_project_id, v_order_id, line ->> 'item_id',
             line ->> 'item_name', 'sale',
             -(line ->> 'quantity')::integer,
             (line ->> 'stock_before')::integer,
             (line ->> 'stock_after')::integer
      from jsonb_array_elements(v_lines) as line
      where (line ->> 'track')::boolean;

      update public.projects
      set config = jsonb_set(v_config, '{menuItems}', v_live_items, true),
          updated_at = now()
      where id = p_project_id and user_id = v_owner_id;

      if not found then
        raise exception 'Failed to update project inventory';
      end if;
    end if;
  end if;

  -- ==========================================================================
  -- 12. Authoritative payload — ONE construction path, used by both the new-sale
  --     and the idempotent-replay branch, always rebuilt from the stored rows.
  --
  --     Money is returned as fixed two-decimal STRINGS. numeric(12,2)::text is
  --     exact; a JSON number would be parsed into an IEEE-754 double by the
  --     browser and could render a cent differently from what is stored.
  --     Deliberately absent: user_id, sale_request_id, sale_request_hash,
  --     build id, device id, config snapshot and inventory before/after values.
  -- ==========================================================================
  select jsonb_build_object(
           'orderId', o.id::text,
           'orderNumber', o.order_number,
           'paymentMethod', o.payment_method,
           'subtotal', o.subtotal::text,
           'taxAmount', o.tax_amount::text,
           'tipAmount', o.tip_amount::text,
           'total', o.total::text,
           'createdAt', to_char(o.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'items', coalesce((
             select jsonb_agg(
                      jsonb_build_object(
                        'itemId', oi.item_id,
                        'itemName', oi.item_name,
                        'unitPrice', oi.unit_price::text,
                        'quantity', oi.quantity,
                        'lineTotal', oi.line_total::text,
                        'modifiers', coalesce(oi.modifiers, '[]'::jsonb)
                      )
                      order by oi.item_id collate "C"
                    )
             from public.order_items oi
             where oi.order_id = o.id
           ), '[]'::jsonb)
         )
  into v_payload
  from public.orders o
  where o.id = v_order_id;

  if v_payload is null then
    raise exception 'Order could not be loaded';
  end if;

  return v_payload;
end;
$function$;

CREATE OR REPLACE FUNCTION public.complete_sale_v4(p_project_id uuid, p_payment_method text, p_tip_amount numeric, p_items jsonb, p_sale_request_id uuid, p_occurred_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_source text DEFAULT 'online'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  c_max_money      constant numeric := 9999999999.99;
  c_max_unit_price constant numeric := 1000000.00;
  c_max_quantity   constant integer := 10000;
  c_max_items      constant integer := 200;
  c_max_stock      constant numeric := 1000000000;
  c_max_suffix     constant bigint  := 999999999999999;
  c_max_prefix_len constant integer := 32;

  -- Feature 24.5B — clock skew allowance for a device-reported sale time.
  -- FIVE MINUTES, matching OFFLINE_CLOCK_TOLERANCE_MS in
  -- lib/deviceOfflineCache.ts so the client and the server agree on what
  -- "close enough" means. Wide enough to absorb ordinary drift and an NTP
  -- correction; far too narrow to backdate a sale past a revocation.
  c_clock_skew     constant interval := interval '5 minutes';

  -- Feature 24.5B — the maximum age of a NEW offline sale.
  --
  -- SEVEN DAYS, the same number as OFFLINE_DEVICE_LEASE_MS in
  -- lib/deviceOfflineCache.ts. The client refuses to OPEN offline past that
  -- lease; without the same bound here the server would still accept a sale
  -- claiming to be from outside it, and the two halves of one owner-approved
  -- policy would disagree.
  --
  -- WHY THIS IS A SECURITY BOUND AND NOT HOUSEKEEPING: the pairing floor below
  -- is not sufficient on its own. A till paired months ago satisfies
  -- `occurred_at >= paired_at` for any date since, so without an age ceiling a
  -- device could backdate a sale created TODAY to a moment months ago — and
  -- slide it in front of a revoked_at set last week. The revocation window in
  -- 6c compares against occurred_at, so an unbounded past is an unbounded
  -- bypass of it. This closes that.
  c_offline_max_age constant interval := interval '7 days';

  v_caller        uuid;
  v_owner_id      uuid;
  v_is_owner      boolean;
  v_build_job_id  uuid;

  -- Feature 24.5B. NOTE the name: v_source is already taken by the pricing
  -- CONFIG below, which is a different thing entirely.
  v_sale_source   text;
  v_occurred_at   timestamptz;
  v_device_revoked_at timestamptz;
  -- Feature 25.1 — the device removed itself. Administrative, never temporal:
  -- this value is NEVER compared against occurred_at.
  v_device_unpaired_at timestamptz;
  v_device_paired_at  timestamptz;
  v_shortfall     integer;
  v_has_shortfall boolean := false;
  v_source        jsonb;
  v_price_items   jsonb;
  v_tax           jsonb;
  v_receipt       jsonb;

  v_config        jsonb;
  v_live_items    jsonb;

  v_method        text;
  v_tip_amount    numeric := 0;
  v_norm          jsonb := '[]'::jsonb;
  v_items_text    text;
  v_canonical     text;
  v_hash          text;

  v_order_id      uuid;
  v_existing      record;
  v_payload       jsonb;

  v_tax_enabled   boolean;
  v_tax_inclusive boolean;
  v_rate          numeric;

  v_lines         jsonb := '[]'::jsonb;
  v_item          jsonb;
  v_item_id       text;
  v_qty_num       numeric;
  v_quantity      integer;
  v_price_item    jsonb;
  v_live_item     jsonb;
  v_live_index    integer;
  v_item_name     text;
  v_unit_price    numeric;
  v_line_total    numeric;
  v_track         boolean;
  v_stock_num     numeric;
  v_stock_before  integer;
  v_stock_after   integer;

  v_subtotal      numeric := 0;
  v_tax_amount    numeric := 0;
  v_total_before_tip numeric := 0;
  v_total         numeric := 0;

  v_prefix        text;
  v_suffix        bigint;
  v_order_number  text;

  v_count         integer;
  v_distinct      integer;
  i               integer;

  -- Feature 18.1 — modifier state. Everything here is derived from the
  -- AUTHORIZED config; the request contributes identifiers only.
  c_max_mod_groups   constant integer := 10;
  c_max_mod_options  constant integer := 20;
  c_max_mod_selected constant integer := 50;

  v_mods          jsonb;
  v_mod_groups    jsonb;
  v_mod_sel       jsonb;
  v_mod_group     jsonb;
  v_mod_option    jsonb;
  v_mod_opt_id    text;
  v_group_id      text;
  v_group_found   boolean;
  v_option_found  boolean;
  v_mod_adjust    numeric;
  v_mod_total     numeric;
  v_mod_snapshot  jsonb;
  v_mod_count     integer;
  v_sel_count     integer;
  v_selected_total integer;
  v_line_identity text;
  v_mod_text      text;
  v_required_ok   boolean;
  j               integer;
  k               integer;
begin
  -- ==========================================================================
  -- 1. Caller and request shape.
  -- ==========================================================================
  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'Authentication required';
  end if;

  if p_project_id is null then
    raise exception 'Project ID is required';
  end if;

  -- A client-generated request id is mandatory. There is deliberately no
  -- server-side fallback: a generated id would make every retry look like a new
  -- sale, which is the exact failure this parameter exists to prevent. The
  -- all-zero uuid is rejected as an obvious uninitialised placeholder. Version
  -- and variant nibbles are NOT checked — any distinct uuid is a valid key, and
  -- rejecting v1/v7 ids would break clients for no security benefit.
  if p_sale_request_id is null then
    raise exception 'A sale request ID is required';
  end if;
  if p_sale_request_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception 'A sale request ID is required';
  end if;

  if p_payment_method is null or p_payment_method not in ('cash', 'card') then
    raise exception 'Invalid payment method';
  end if;
  v_method := p_payment_method;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one order item is required';
  end if;
  if jsonb_array_length(p_items) > c_max_items then
    raise exception 'Too many order items';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(p_items) e
  where jsonb_typeof(e.value) <> 'object';
  if v_count > 0 then
    raise exception 'Invalid order item';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(p_items) e
  where coalesce(btrim(e.value ->> 'itemId'), '') = '';
  if v_count > 0 then
    raise exception 'Invalid order item';
  end if;

  -- Feature 18.1 — the v2 duplicate-itemId rule cannot survive verbatim: the
  -- same product with two different modifier selections is two legitimate
  -- lines. It is replaced by a duplicate-LINE rule in section 5, which
  -- compares the canonical (item + selection) identity and therefore keeps the
  -- exact property v2's rule protected — two requests that differ only in how
  -- one line was split can still never canonicalize alike.

  -- Modifier payload shape. Checked here, before any config is loaded, so a
  -- malformed or oversized request never reaches the pricing loop.
  select count(*) into v_count
  from jsonb_array_elements(p_items) e
  where e.value ? 'modifiers'
    and jsonb_typeof(e.value -> 'modifiers') <> 'array';
  if v_count > 0 then
    raise exception 'Invalid order item';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(p_items) e
  where jsonb_array_length(coalesce(e.value -> 'modifiers', '[]'::jsonb)) > c_max_mod_groups;
  if v_count > 0 then
    raise exception 'Too many options for an order item';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(p_items) e,
       jsonb_array_elements(coalesce(e.value -> 'modifiers', '[]'::jsonb)) m
  where jsonb_typeof(m.value) <> 'object'
     or coalesce(btrim(m.value ->> 'groupId'), '') = ''
     or (m.value ? 'optionIds' and jsonb_typeof(m.value -> 'optionIds') <> 'array');
  if v_count > 0 then
    raise exception 'Invalid order item';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(p_items) e,
       jsonb_array_elements(coalesce(e.value -> 'modifiers', '[]'::jsonb)) m
  where jsonb_array_length(coalesce(m.value -> 'optionIds', '[]'::jsonb)) > c_max_mod_options;
  if v_count > 0 then
    raise exception 'Too many options for an order item';
  end if;

  -- Every option id must be a non-empty string. jsonb_array_elements_text
  -- renders a non-string element as its text form, so the type is checked
  -- explicitly rather than inferred.
  select count(*) into v_count
  from jsonb_array_elements(p_items) e,
       jsonb_array_elements(coalesce(e.value -> 'modifiers', '[]'::jsonb)) m,
       jsonb_array_elements(coalesce(m.value -> 'optionIds', '[]'::jsonb)) o
  where jsonb_typeof(o.value) <> 'string'
     or coalesce(btrim(o.value #>> '{}'), '') = '';
  if v_count > 0 then
    raise exception 'Invalid order item';
  end if;

  -- Feature 24.5B — the sale source. A CLOSED set, checked before anything
  -- else reads it: an unbounded text column would let a caller invent a
  -- category that every later filter and report silently ignores.
  v_sale_source := lower(btrim(coalesce(p_source, 'online')));
  if v_sale_source not in ('online', 'offline_queued') then
    raise exception 'Invalid sale source';
  end if;

  -- ==========================================================================
  -- 2. Authorization.
  --
  -- FEATURE 24.5B DELIBERATELY DOES NOT CALL resolve_sale_owner FOR A DEVICE,
  -- and this is the one place v4 relaxes something v3 enforced. Read carefully.
  --
  -- resolve_sale_owner filters `revoked_at is null`, so under v3 a revoked
  -- device is refused at the very first step — before the idempotency lookup.
  -- That means a sale the device COMPLETED while it was still authorized can
  -- never be recorded once the owner revokes it, and an already-committed sale
  -- can never be replayed. For an offline till that is not a security control,
  -- it is silent destruction of takings that physically happened.
  --
  -- v4 therefore resolves the device itself, WITHOUT the revoked filter, and
  -- moves the revocation decision to the two places where it actually belongs:
  --
  --   * an idempotent REPLAY of an existing order is allowed regardless of
  --     revocation. It allocates nothing, mutates nothing, and returns only an
  --     order this same caller already created.
  --   * a NEW sale from a revoked device is refused, except for an offline sale
  --     whose validated occurred_at is strictly before revoked_at — the
  --     owner-approved window (docs/OFFLINE_ARCHITECTURE.md §13).
  --
  -- A device with NO pairing row for this project is still refused outright,
  -- with the same non-probing message resolve_sale_owner uses.
  -- ==========================================================================
  select p.user_id into v_owner_id
  from public.projects p
  where p.id = p_project_id and p.user_id = v_caller;

  v_is_owner := found;

  if not v_is_owner then
    select d.owner_id, d.build_job_id, d.revoked_at, d.created_at, d.unpaired_at
      into v_owner_id, v_build_job_id, v_device_revoked_at, v_device_paired_at,
           v_device_unpaired_at
    from public.paired_devices d
    where d.auth_user_id = v_caller
      and d.project_id = p_project_id;

    if not found then
      raise exception 'Project not found or access denied';
    end if;
  end if;

  -- Feature 24.5B — only a paired device may claim offline semantics. An owner
  -- calling from the browser is, by definition, online; letting an owner post
  -- offline_queued would hand them a path that skips the inventory rejection
  -- every online sale is subject to.
  if v_is_owner and v_sale_source <> 'online' then
    raise exception 'Only a paired device can record an offline sale';
  end if;

  -- ==========================================================================
  -- 3. Lock the project row. Single serialization point per project, taken
  --    before any pricing, stock, idempotency or counter access.
  -- ==========================================================================
  select p.config into v_config
  from public.projects p
  where p.id = p_project_id and p.user_id = v_owner_id
  for update;
  if not found then
    raise exception 'Project not found or access denied';
  end if;

  v_live_items := coalesce(v_config -> 'menuItems', '[]'::jsonb);
  if jsonb_typeof(v_live_items) <> 'array' then
    raise exception 'Project configuration is invalid';
  end if;

  -- The device's pinned build id was read in section 2, together with its
  -- revocation state. Nothing else about the device is needed until a NEW sale
  -- is being priced, so an idempotent replay still never depends on it.

  -- ==========================================================================
  -- 4. Tip. Rejected for special values before the owner/device branch, since
  --    NaN sorts above every finite numeric and would otherwise be misreported.
  -- ==========================================================================
  if p_tip_amount is not null
     and p_tip_amount::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'Order amounts are not valid';
  end if;

  if v_is_owner then
    v_tip_amount := round(coalesce(p_tip_amount, 0), 2);
    if v_tip_amount < 0 then
      raise exception 'Order amounts cannot be negative';
    end if;
    if v_tip_amount > c_max_money then
      raise exception 'Order amount is too large';
    end if;
  else
    if coalesce(p_tip_amount, 0) <> 0 then
      raise exception 'Tips are not supported on this device';
    end if;
    v_tip_amount := round(0::numeric, 2);
  end if;

  -- ==========================================================================
  -- 5. Normalize items, then build the canonical preimage and its hash.
  -- ==========================================================================
  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_item_id := btrim(v_item ->> 'itemId');

    begin
      v_qty_num := (v_item ->> 'quantity')::numeric;
    exception
      when invalid_text_representation then
        raise exception 'Invalid quantity for an order item';
    end;

    if v_qty_num is null
       or v_qty_num::text in ('NaN', 'Infinity', '-Infinity')
       or v_qty_num <> trunc(v_qty_num)
       or v_qty_num < 1
       or v_qty_num > c_max_quantity then
      raise exception 'Invalid quantity for an order item';
    end if;

    v_quantity := v_qty_num::integer;

    v_mods := coalesce(v_item -> 'modifiers', '[]'::jsonb);

    -- A group carrying no options selects nothing, so it is dropped before the
    -- identity is built. Keeping it would make {g:[]} and an omitted g two
    -- different identities for the same cart.
    select coalesce(jsonb_agg(m.value order by btrim(m.value ->> 'groupId') collate "C"), '[]'::jsonb)
    into v_mods
    from jsonb_array_elements(v_mods) m
    where jsonb_array_length(coalesce(m.value -> 'optionIds', '[]'::jsonb)) > 0;

    -- Duplicate group ids inside one line would make the identity ambiguous.
    select count(*), count(distinct btrim(m.value ->> 'groupId'))
    into v_count, v_distinct
    from jsonb_array_elements(v_mods) m;
    if v_count <> v_distinct then
      raise exception 'The same option group appears more than once for an item';
    end if;

    select count(*) into v_selected_total
    from jsonb_array_elements(v_mods) m,
         jsonb_array_elements_text(m.value -> 'optionIds') o;
    if v_selected_total > c_max_mod_selected then
      raise exception 'Too many options for an order item';
    end if;

    -- Duplicate option ids inside one group: same reasoning.
    select count(*) into v_count
    from jsonb_array_elements(v_mods) m
    where (select count(*) from jsonb_array_elements_text(m.value -> 'optionIds')) <>
          (select count(distinct o.value) from jsonb_array_elements_text(m.value -> 'optionIds') o);
    if v_count > 0 then
      raise exception 'The same option appears more than once for an item';
    end if;

    -- CANONICAL LINE IDENTITY.
    --   <len(itemId)>:<itemId>[<groups>]<group>*
    --   group  := <len(gid)>:<gid>(<options>)<option>*
    --   option := <len(oid)>:<oid>
    -- Every id is byte-length-prefixed and every repeat carries an explicit
    -- count, so the string parses back unambiguously — a delimiter inside an id
    -- cannot shift the reading. Groups sort by group id and options by option
    -- id, so the order a cashier tapped them in cannot change the identity.
    -- This is the same injectivity technique v2 uses for item ids, extended one
    -- level down.
    select coalesce(string_agg(
             octet_length(g.gid)::text || ':' || g.gid ||
             '(' || g.optcount::text || ')' || g.opts,
             '' order by g.gid collate "C"), '')
    into v_mod_text
    from (
      select btrim(m.value ->> 'groupId') as gid,
             (select count(*) from jsonb_array_elements_text(m.value -> 'optionIds')) as optcount,
             (select coalesce(string_agg(
                       octet_length(o.value)::text || ':' || o.value,
                       '' order by o.value collate "C"), '')
              from jsonb_array_elements_text(m.value -> 'optionIds') o) as opts
      from jsonb_array_elements(v_mods) m
    ) g;

    v_line_identity :=
      octet_length(v_item_id)::text || ':' || v_item_id ||
      '[' || jsonb_array_length(v_mods)::text || ']' || v_mod_text;

    v_norm := v_norm || jsonb_build_object(
      'id', v_item_id,
      'qty', v_quantity,
      'mods', v_mods,
      'key', v_line_identity
    );
  end loop;

  -- Duplicate LINES — the modifier-aware replacement for v2's duplicate-item
  -- rule. The same product with different selections is allowed; the identical
  -- product-and-selection twice is not.
  select count(*), count(distinct e.value ->> 'key')
  into v_count, v_distinct
  from jsonb_array_elements(v_norm) e;
  if v_count <> v_distinct then
    raise exception 'The same item and options appear more than once in this order';
  end if;

  select string_agg(
           (e.value ->> 'key') || '=' || (e.value ->> 'qty'),
           E'\n' order by (e.value ->> 'key') collate "C"
         )
  into v_items_text
  from jsonb_array_elements(v_norm) e;

  -- A NEW canonical format. v1 keyed a line on item id alone, so two different
  -- modifier selections of one product would collide. complete_sale_v2's own
  -- preimage is deliberately left untouched, so a stale tab still hashes
  -- exactly as it always did.
  v_canonical :=
    'posc.sale.v2' || E'\n' ||
    'project=' || p_project_id::text || E'\n' ||
    'payment=' || v_method || E'\n' ||
    'tip=' || v_tip_amount::text || E'\n' ||
    'items=' || jsonb_array_length(v_norm)::text ||
    case when v_items_text is null then '' else E'\n' || v_items_text end;

  v_hash := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');

  -- ==========================================================================
  -- 6. Idempotency lookup — after authorization and the lock, BEFORE counter
  --    allocation, order insert, inventory mutation and audit inserts.
  --
  --    Placed here deliberately: a replay must succeed even if the item was
  --    since renamed, repriced, removed from the menu, or has since run out of
  --    stock. The payload is rebuilt from the stored order, never recomputed.
  -- ==========================================================================
  select o.id, o.sale_request_hash into v_existing
  from public.orders o
  where o.project_id = p_project_id
    and o.sale_request_id = p_sale_request_id;

  if found then
    if v_existing.sale_request_hash is distinct from v_hash then
      raise exception 'Sale request ID was already used for a different order';
    end if;
    v_order_id := v_existing.id;
  else
    -- ========================================================================
    -- 6b. Feature 24.5B — WHEN did this sale happen, and was the device still
    --     allowed to make it?
    --
    --     NEW SALES ONLY, deliberately. A replay returned above without ever
    --     reading p_occurred_at, which is also why occurred_at is NOT part of
    --     the canonical preimage in section 5: a retry whose clock has moved a
    --     few seconds must be the SAME sale, not a hash conflict.
    --
    --     created_at is untouched by all of this. It remains the server clock,
    --     recording when the row was committed. occurred_at records when the
    --     money physically changed hands. Neither is derivable from the other
    --     once a sale can be queued for hours.
    -- ========================================================================
    if v_sale_source = 'online' then
      -- An online sale happens now, by definition. A caller-supplied time is
      -- refused rather than ignored, so nobody can backdate an online sale and
      -- believe it worked.
      if p_occurred_at is not null then
        raise exception 'An online sale cannot declare its own sale time';
      end if;

      v_occurred_at := now();
    else
      -- THE DEVICE CLOCK IS NOT AUTHORITATIVE. Every bound below is checked
      -- against server time or against a server-recorded fact, and each one
      -- raises a DISTINCT message so the sync engine can tell an operator
      -- problem from a tampering attempt.
      if p_occurred_at is null then
        raise exception 'An offline sale must declare when it happened';
      end if;

      -- Not in the future. A clock running fast is ordinary; a clock running
      -- fast by more than the skew allowance is either broken or being used to
      -- reach past a revocation.
      if p_occurred_at > now() + c_clock_skew then
        raise exception 'Offline sale time is in the future';
      end if;

      -- Not before this device existed. paired_devices.created_at is a server
      -- timestamp, so this bound cannot be moved by the device. It is one of
      -- the two floors on backdating, and on its own it is NOT enough: a device
      -- paired months ago satisfies it for any date since.
      if v_device_paired_at is not null
         and p_occurred_at < v_device_paired_at - c_clock_skew then
        raise exception 'Offline sale time predates this device';
      end if;

      -- Not older than the offline lease. THE SECOND FLOOR, and the one that
      -- makes the revocation window in 6c enforceable: an unbounded past would
      -- let a new submission be backdated in front of any later revoked_at.
      --
      -- REJECTED, NEVER CLAMPED. Silently moving the timestamp to the boundary
      -- would write a sale time nobody reported, into the books, to make a
      -- validation pass — the exact rewriting of financial history this
      -- contract exists to prevent. The sale stays in the device queue for a
      -- person to resolve.
      if p_occurred_at < now() - c_offline_max_age - c_clock_skew then
        raise exception 'Offline sale time is older than the offline limit';
      end if;

      v_occurred_at := p_occurred_at;
    end if;

    -- ========================================================================
    -- 6c. The revocation window (docs/OFFLINE_ARCHITECTURE.md §13).
    --
    --     Owner-approved policy, and the reason section 2 stopped filtering
    --     revoked devices out: a sale that happened BEFORE the owner revoked
    --     the till is real money and is recorded; a sale claiming to have
    --     happened after it is refused and reported. The comparison uses the
    --     server-validated occurred_at above, never the raw parameter.
    -- ========================================================================
    -- ==========================================================================
    -- 6c-i. Feature 25.1 — the device removed itself.
    --
    --     UNCONDITIONAL, AND DELIBERATELY NOT A WINDOW. There is no
    --     `occurred_at < unpaired_at` exception here and there must never be
    --     one. Revocation earns its temporal comparison because an owner can
    --     revoke remotely while a till is offline, so sales taken before that
    --     moment are real money the device could not have known about. A
    --     voluntary unpair is the opposite: it is initiated ON the device, and
    --     only after decideDeviceResetSafety has proven the queue holds nothing
    --     pending, syncing, needing attention, or uncertain. There is no
    --     legitimate sale left for a window to admit.
    --
    --     PLACED INSIDE THE NEW-SALE BRANCH, after the section 6 idempotency
    --     lookup returned nothing. A REPLAY of an already-committed order never
    --     reaches this line and is still answered exactly as before: it
    --     allocates nothing, mutates nothing, and returns the order this same
    --     caller already created. Refusing a replay would protect nothing and
    --     would throw away the one guarantee that exists for the case where our
    --     model of reality turns out to be wrong.
    -- ==========================================================================
    if not v_is_owner and v_device_unpaired_at is not null then
      raise exception 'This device is no longer paired';
    end if;

    if not v_is_owner and v_device_revoked_at is not null then
      if v_sale_source <> 'offline_queued' then
        -- A revoked device gets no NEW online sale. It has already reconnected
        -- by definition, so it has already learned it was revoked.
        raise exception 'Project not found or access denied';
      end if;

      if v_occurred_at >= v_device_revoked_at then
        raise exception 'Offline sale occurred after this device was revoked';
      end if;
    end if;

    -- ========================================================================
    -- 7. New sale. Resolve the authorized pricing source.
    -- ========================================================================
    if v_is_owner then
      v_source := v_config;
    else
      select b.config_snapshot into v_source
      from public.build_jobs b
      where b.id = v_build_job_id
        and b.project_id = p_project_id
        and b.status = 'succeeded';
      if not found then
        raise exception 'This device is not linked to a usable build';
      end if;
    end if;

    v_price_items := coalesce(v_source -> 'menuItems', '[]'::jsonb);
    v_tax := coalesce(v_source -> 'tax', '{}'::jsonb);
    v_receipt := coalesce(v_source -> 'receipt', '{}'::jsonb);

    if jsonb_typeof(v_price_items) <> 'array' then
      raise exception 'Pricing configuration is invalid';
    end if;

    -- Tax settings. Malformed values fall back exactly as toRuntimeSafeTax
    -- does: a special or unparseable rate becomes 0, NOT the 100 clamp.
    begin
      v_tax_enabled := coalesce((v_tax ->> 'enabled')::boolean, true);
    exception when invalid_text_representation then v_tax_enabled := true;
    end;
    begin
      v_tax_inclusive := coalesce((v_tax ->> 'pricesIncludeTax')::boolean, false);
    exception when invalid_text_representation then v_tax_inclusive := false;
    end;
    begin
      v_rate := coalesce((v_tax ->> 'rate')::numeric, 0);
    exception when invalid_text_representation then v_rate := 0;
    end;

    if v_rate is null or v_rate::text in ('NaN', 'Infinity', '-Infinity') then
      v_rate := 0;
    elsif v_rate < 0 then
      v_rate := 0;
    elsif v_rate > 100 then
      v_rate := 100;
    end if;

    -- ========================================================================
    -- 8. Per-item server pricing and live-stock validation.
    -- ========================================================================
    for v_item in select value from jsonb_array_elements(v_norm)
    loop
      v_item_id := v_item ->> 'id';
      v_quantity := (v_item ->> 'qty')::integer;
      v_mods := coalesce(v_item -> 'mods', '[]'::jsonb);

      v_price_item := null;
      for i in 0 .. jsonb_array_length(v_price_items) - 1
      loop
        if v_price_items -> i ->> 'id' = v_item_id then
          v_price_item := v_price_items -> i;
          exit;
        end if;
      end loop;

      if v_price_item is null then
        raise exception 'Menu item % is not available', v_item_id;
      end if;

      v_item_name := btrim(coalesce(v_price_item ->> 'name', ''));
      if v_item_name = '' then
        raise exception 'Menu item % is not available', v_item_id;
      end if;

      begin
        v_unit_price := (v_price_item ->> 'price')::numeric;
      exception when invalid_text_representation then
        raise exception 'Menu item % has an invalid price', v_item_id;
      end;

      if v_unit_price is null
         or v_unit_price::text in ('NaN', 'Infinity', '-Infinity')
         or v_unit_price < 0
         or v_unit_price > c_max_unit_price then
        raise exception 'Menu item % has an invalid price', v_item_id;
      end if;

      -- ----------------------------------------------------------------
      -- Feature 18.1 — modifier resolution, validation and pricing.
      --
      -- Every value used below comes from v_price_item, which is the
      -- AUTHORIZED source resolved in section 7 (the owner's locked live
      -- config, or the device's pinned build snapshot). The request supplied
      -- identifiers and nothing else; there is no field in it for a name or a
      -- price, so none can be trusted by accident.
      -- ----------------------------------------------------------------
      v_mod_groups := coalesce(v_price_item -> 'modifierGroups', '[]'::jsonb);
      if jsonb_typeof(v_mod_groups) <> 'array' then
        v_mod_groups := '[]'::jsonb;
      end if;

      v_mod_total := 0;
      v_mod_snapshot := '[]'::jsonb;

      -- A product with no groups accepts no selections. This is what stops an
      -- option being attached to a plain item, or borrowed from another product.
      if jsonb_array_length(v_mod_groups) = 0 and jsonb_array_length(v_mods) > 0 then
        raise exception 'Menu item % does not have options', v_item_id;
      end if;

      for j in 0 .. jsonb_array_length(v_mods) - 1
      loop
        v_mod_sel := v_mods -> j;
        v_group_id := btrim(v_mod_sel ->> 'groupId');

        -- The group must belong to THIS product.
        v_mod_group := null;
        for k in 0 .. jsonb_array_length(v_mod_groups) - 1
        loop
          if v_mod_groups -> k ->> 'id' = v_group_id then
            v_mod_group := v_mod_groups -> k;
            exit;
          end if;
        end loop;

        if v_mod_group is null then
          raise exception 'Menu item % does not have that option group', v_item_id;
        end if;

        v_sel_count := jsonb_array_length(coalesce(v_mod_sel -> 'optionIds', '[]'::jsonb));

        -- A single-choice group accepts at most one option.
        if coalesce(v_mod_group ->> 'selection', 'single') = 'single' and v_sel_count > 1 then
          raise exception 'Only one option may be chosen for %', coalesce(v_mod_group ->> 'name', v_group_id);
        end if;

        -- maxSelections applies to multiple-choice groups only, and only when set.
        if coalesce(v_mod_group ->> 'selection', 'single') = 'multiple'
           and v_mod_group -> 'maxSelections' is not null
           and jsonb_typeof(v_mod_group -> 'maxSelections') = 'number'
           and v_sel_count > (v_mod_group ->> 'maxSelections')::integer then
          raise exception 'Too many options chosen for %', coalesce(v_mod_group ->> 'name', v_group_id);
        end if;

        for k in 0 .. v_sel_count - 1
        loop
          v_mod_opt_id := btrim(v_mod_sel -> 'optionIds' ->> k);

          -- The option must belong to THIS group, not merely to the product.
          v_mod_option := null;
          for i in 0 .. jsonb_array_length(coalesce(v_mod_group -> 'options', '[]'::jsonb)) - 1
          loop
            if v_mod_group -> 'options' -> i ->> 'id' = v_mod_opt_id then
              v_mod_option := v_mod_group -> 'options' -> i;
              exit;
            end if;
          end loop;

          if v_mod_option is null then
            raise exception 'That option is not available for %', coalesce(v_mod_group ->> 'name', v_group_id);
          end if;

          begin
            v_mod_adjust := (v_mod_option ->> 'priceAdjustment')::numeric;
          exception when invalid_text_representation then
            raise exception 'An option for % has an invalid price', v_item_id;
          end;

          -- Same money discipline as the base price: MVP adjustments are
          -- non-negative, finite, and bounded by the per-unit ceiling.
          if v_mod_adjust is null
             or v_mod_adjust::text in ('NaN', 'Infinity', '-Infinity')
             or v_mod_adjust < 0
             or v_mod_adjust > c_max_unit_price then
            raise exception 'An option for % has an invalid price', v_item_id;
          end if;

          v_mod_total := v_mod_total + v_mod_adjust;

          -- The historical snapshot: names and prices as they are RIGHT NOW,
          -- so a receipt reprinted after a menu change still shows what the
          -- customer actually bought and paid.
          v_mod_snapshot := v_mod_snapshot || jsonb_build_object(
            'groupId', v_group_id,
            'groupName', coalesce(v_mod_group ->> 'name', ''),
            'optionId', v_mod_opt_id,
            'optionName', coalesce(v_mod_option ->> 'name', ''),
            'priceAdjustment', round(v_mod_adjust, 2)::text
          );
        end loop;
      end loop;

      -- Required groups must be satisfied. Checked over the PRODUCT's groups
      -- rather than the submission, so an omitted group is caught as readily as
      -- an empty one.
      for k in 0 .. jsonb_array_length(v_mod_groups) - 1
      loop
        if (v_mod_groups -> k ->> 'required')::boolean is true then
          v_required_ok := false;

          for j in 0 .. jsonb_array_length(v_mods) - 1
          loop
            if btrim(v_mods -> j ->> 'groupId') = (v_mod_groups -> k ->> 'id')
               and jsonb_array_length(coalesce(v_mods -> j -> 'optionIds', '[]'::jsonb)) > 0 then
              v_required_ok := true;
              exit;
            end if;
          end loop;

          if not v_required_ok then
            raise exception 'Please choose % for %',
              coalesce(v_mod_groups -> k ->> 'name', 'an option'), v_item_name;
          end if;
        end if;
      end loop;

      -- The line's unit price is the base plus every selected adjustment. It is
      -- re-bounded because the sum can exceed the per-unit ceiling even when
      -- each part is individually valid.
      v_unit_price := round(v_unit_price + v_mod_total, 2);

      if v_unit_price is null
         or v_unit_price::text in ('NaN', 'Infinity', '-Infinity')
         or v_unit_price < 0
         or v_unit_price > c_max_unit_price then
        raise exception 'Menu item % has an invalid price', v_item_id;
      end if;

      v_line_total := round(v_unit_price * v_quantity, 2);
      if v_line_total is null
         or v_line_total::text in ('NaN', 'Infinity', '-Infinity') then
        raise exception 'Order amount is not valid';
      end if;
      if v_line_total > c_max_money then
        raise exception 'Order amount is too large';
      end if;

      v_subtotal := v_subtotal + v_line_total;
      if v_subtotal > c_max_money then
        raise exception 'Order amount is too large';
      end if;

      -- Inventory always from the LIVE locked config.
      v_live_index := null;
      for i in 0 .. jsonb_array_length(v_live_items) - 1
      loop
        if v_live_items -> i ->> 'id' = v_item_id then
          v_live_index := i;
          exit;
        end if;
      end loop;
      if v_live_index is null then
        raise exception 'Menu item % is not available', v_item_id;
      end if;
      v_live_item := v_live_items -> v_live_index;

      begin
        v_track := coalesce((v_live_item ->> 'trackInventory')::boolean, false);
      exception when invalid_text_representation then
        raise exception 'Inventory configuration for % is invalid', v_item_id;
      end;

      v_stock_before := 0;
      v_stock_after := 0;
      v_shortfall := 0;

      if v_track then
        begin
          v_stock_num := coalesce((v_live_item ->> 'stockQuantity')::numeric, 0);
        exception when invalid_text_representation then
          raise exception 'Inventory configuration for % is invalid', v_item_id;
        end;

        if v_stock_num is null
           or v_stock_num::text in ('NaN', 'Infinity', '-Infinity')
           or v_stock_num <> trunc(v_stock_num)
           or v_stock_num < 0
           or v_stock_num > c_max_stock then
          raise exception 'Inventory configuration for % is invalid', v_item_id;
        end if;

        v_stock_before := v_stock_num::integer;

        -- Feature 24.5B — the online rule is UNCHANGED: refuse, so the cashier
        -- can still act on it while the customer is standing there.
        --
        -- An offline queued sale is the opposite situation. The food is gone
        -- and the cash is in the drawer; the only question left is whether the
        -- books reflect it. Refusing here would delete a real financial record
        -- to protect a stock number, so the sale is accepted, tracked stock
        -- floors at 0 — the live config's own check rejects a negative — and
        -- the shortfall is recorded per line for the owner to reconcile.
        if v_stock_before < v_quantity then
          if v_sale_source <> 'offline_queued' then
            raise exception 'Insufficient inventory for %', v_item_name;
          end if;

          v_shortfall := v_quantity - v_stock_before;
          v_has_shortfall := true;
          v_stock_after := 0;
        else
          v_shortfall := 0;
          v_stock_after := v_stock_before - v_quantity;
        end if;

        v_live_items := jsonb_set(
          v_live_items, array[v_live_index::text, 'stockQuantity'],
          to_jsonb(v_stock_after), true
        );
      end if;

      v_lines := v_lines || jsonb_build_object(
        'item_id', v_item_id, 'item_name', v_item_name,
        'unit_price', v_unit_price, 'quantity', v_quantity,
        'line_total', v_line_total, 'track', v_track,
        'stock_before', v_stock_before, 'stock_after', v_stock_after,
        'shortfall', coalesce(v_shortfall, 0),
        'modifiers', v_mod_snapshot
      );
    end loop;

    -- ========================================================================
    -- 9. Order-level money — identical rules and rounding points to Migration C.
    -- ========================================================================
    v_subtotal := round(v_subtotal, 2);

    if not v_tax_enabled then
      v_tax_amount := 0;
      v_total_before_tip := v_subtotal;
    elsif v_tax_inclusive then
      v_tax_amount := round(v_subtotal - v_subtotal / (1 + v_rate / 100), 2);
      v_total_before_tip := v_subtotal;
    else
      v_tax_amount := round(v_subtotal * v_rate / 100, 2);
      v_total_before_tip := v_subtotal + v_tax_amount;
    end if;

    if v_tax_amount < 0 then
      v_tax_amount := 0;
    end if;

    v_total := round(v_total_before_tip + v_tip_amount, 2);

    if v_subtotal is null or v_tax_amount is null
       or v_tip_amount is null or v_total is null
       or v_subtotal::text in ('NaN', 'Infinity', '-Infinity')
       or v_tax_amount::text in ('NaN', 'Infinity', '-Infinity')
       or v_tip_amount::text in ('NaN', 'Infinity', '-Infinity')
       or v_total::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'Order amount is not valid';
    end if;

    if v_subtotal > c_max_money or v_tax_amount > c_max_money
       or v_tip_amount > c_max_money or v_total > c_max_money then
      raise exception 'Order amount is too large';
    end if;

    if v_subtotal < 0 or v_total < 0 then
      raise exception 'Order amounts cannot be negative';
    end if;

    -- ========================================================================
    -- 10. Order number. Prefix from the SAME authorized source as the prices,
    --     so a device's receipt prefix matches the build it is pinned to.
    -- ========================================================================
    v_prefix := btrim(coalesce(v_receipt ->> 'orderPrefix', ''));
    v_prefix := regexp_replace(v_prefix, '[[:cntrl:]]', '', 'g');
    if length(v_prefix) > c_max_prefix_len then
      v_prefix := left(v_prefix, c_max_prefix_len);
    end if;

    -- Lazily create the counter: D2 seeded only the projects that existed then,
    -- so any project created afterwards gets its row here, on first sale.
    insert into public.project_order_counters (project_id, last_number)
    values (p_project_id, 1000)
    on conflict (project_id) do nothing;

    select c.last_number into v_suffix
    from public.project_order_counters c
    where c.project_id = p_project_id
    for update;

    if v_suffix is null then
      raise exception 'Order number could not be allocated';
    end if;
    if v_suffix >= c_max_suffix then
      raise exception 'Order number sequence exhausted for this project';
    end if;

    -- Transactional allocation. Not a sequence: nextval is non-transactional
    -- and would leave a permanent gap on every rolled-back sale.
    update public.project_order_counters
    set last_number = last_number + 1,
        updated_at = now()
    where project_id = p_project_id
    returning last_number into v_suffix;

    v_order_number := v_prefix || v_suffix::text;

    -- ========================================================================
    -- 11. Atomic write.
    -- ========================================================================
    begin
      insert into public.orders (
        user_id, project_id, order_number, payment_method,
        subtotal, tax_amount, tip_amount, total,
        number_source, sale_request_id, sale_request_hash,
        -- Feature 24.5B. created_at is deliberately NOT listed: it keeps its
        -- now() default, so the server clock still records when this row was
        -- committed no matter what the device said about occurred_at.
        occurred_at, source, has_inventory_shortfall,
        build_job_id
      )
      values (
        v_owner_id, p_project_id, v_order_number, v_method,
        v_subtotal, v_tax_amount, v_tip_amount, v_total,
        'server', p_sale_request_id, v_hash,
        v_occurred_at, v_sale_source, v_has_shortfall,
        v_build_job_id
      )
      returning id into v_order_id;
    exception
      when unique_violation then
        -- The project FOR UPDATE lock serializes every sale for this project,
        -- so this should be unreachable. It is kept as a final backstop rather
        -- than a primary path: re-read the winning row and apply the SAME hash
        -- comparison, so a racing duplicate replays instead of double-selling.
        -- The subtransaction rollback has already undone this INSERT; no
        -- inventory row or config update has been written yet.
        select o.id, o.sale_request_hash into v_existing
        from public.orders o
        where o.project_id = p_project_id
          and o.sale_request_id = p_sale_request_id;

        if not found then
          raise exception 'Could not allocate a unique order number';
        end if;
        if v_existing.sale_request_hash is distinct from v_hash then
          raise exception 'Sale request ID was already used for a different order';
        end if;
        v_order_id := v_existing.id;
    end;

    -- Only write the rest when this call actually created the order.
    if not exists (
      select 1 from public.order_items oi where oi.order_id = v_order_id
    ) then
      insert into public.order_items (
        order_id, item_id, item_name, unit_price, quantity, line_total, modifiers,
        inventory_shortfall
      )
      select v_order_id, line ->> 'item_id', line ->> 'item_name',
             (line ->> 'unit_price')::numeric, (line ->> 'quantity')::integer,
             (line ->> 'line_total')::numeric,
             coalesce(line -> 'modifiers', '[]'::jsonb),
             coalesce((line ->> 'shortfall')::integer, 0)
      from jsonb_array_elements(v_lines) as line;

      insert into public.inventory_transactions (
        user_id, project_id, order_id, item_id, item_name,
        transaction_type, quantity_change, quantity_before, quantity_after
      )
      -- Feature 24.5B — the change is stock_before minus stock_after, NOT the
      -- requested quantity. Once an offline sale can floor at 0 those two
      -- differ, and inventory_transactions carries its own
      -- `quantity_after = quantity_before + quantity_change` check that would
      -- reject the row. The shortfall lives on order_items, where it can be
      -- expressed without breaking that arithmetic.
      select v_owner_id, p_project_id, v_order_id, line ->> 'item_id',
             line ->> 'item_name', 'sale',
             -((line ->> 'stock_before')::integer - (line ->> 'stock_after')::integer),
             (line ->> 'stock_before')::integer,
             (line ->> 'stock_after')::integer
      from jsonb_array_elements(v_lines) as line
      where (line ->> 'track')::boolean
        and (line ->> 'stock_before')::integer <> (line ->> 'stock_after')::integer;

      update public.projects
      set config = jsonb_set(v_config, '{menuItems}', v_live_items, true),
          updated_at = now()
      where id = p_project_id and user_id = v_owner_id;

      if not found then
        raise exception 'Failed to update project inventory';
      end if;
    end if;
  end if;

  -- ==========================================================================
  -- 12. Authoritative payload — ONE construction path, used by both the new-sale
  --     and the idempotent-replay branch, always rebuilt from the stored rows.
  --
  --     Money is returned as fixed two-decimal STRINGS. numeric(12,2)::text is
  --     exact; a JSON number would be parsed into an IEEE-754 double by the
  --     browser and could render a cent differently from what is stored.
  --     Deliberately absent: user_id, sale_request_id, sale_request_hash,
  --     build id, device id, config snapshot and inventory before/after values.
  -- ==========================================================================
  select jsonb_build_object(
           'orderId', o.id::text,
           'orderNumber', o.order_number,
           'paymentMethod', o.payment_method,
           'subtotal', o.subtotal::text,
           'taxAmount', o.tax_amount::text,
           'tipAmount', o.tip_amount::text,
           'total', o.total::text,
           'createdAt', to_char(o.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           -- Feature 24.5B — ADDITIVE ONLY. Every field v3 returned keeps its
           -- name and its type, so a client reading a v4 payload with v3's
           -- parser is unaffected.
           'occurredAt', to_char(o.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'source', o.source,
           'hasInventoryShortfall', o.has_inventory_shortfall,
           'items', coalesce((
             select jsonb_agg(
                      jsonb_build_object(
                        'itemId', oi.item_id,
                        'itemName', oi.item_name,
                        'unitPrice', oi.unit_price::text,
                        'quantity', oi.quantity,
                        'lineTotal', oi.line_total::text,
                        'modifiers', coalesce(oi.modifiers, '[]'::jsonb),
                        'inventoryShortfall', coalesce(oi.inventory_shortfall, 0)
                      )
                      order by oi.item_id collate "C"
                    )
             from public.order_items oi
             where oi.order_id = o.id
           ), '[]'::jsonb)
         )
  into v_payload
  from public.orders o
  where o.id = v_order_id;

  if v_payload is null then
    raise exception 'Order could not be loaded';
  end if;

  return v_payload;
end;
$function$;

-- ----------------------------------------------------------------------------
-- 5. get_device_pairing_state — advertise an offer, and nothing more
--
-- The SMALLEST change that lets 26.2 render "Update available": three fields
-- the device already has a right to know about itself. No build metadata, no
-- project data, no other device's anything.
--
-- `update_available` is computed here rather than left to the client so the
-- rule — an offer exists AND it is not what we are already pinned to — lives in
-- one place. The other two are for a future "waiting since" and for support.
--
-- WHAT DOES NOT CHANGE: get_device_config still returns the CURRENT
-- build_job_id and never follows the offer. Until the device calls
-- apply_device_config_update(), an offer is a notification and nothing else.
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
    end
  );
end;
$function$;

-- ----------------------------------------------------------------------------
-- 6. An inactive device holds no offer
--
-- WHY CLEAR RATHER THAN LEAVE. An offer is an invitation to reprice. A device
-- that has been revoked or has unpaired itself must not carry one into whatever
-- happens next — and if it is ever re-paired, redeem_device_pairing_token
-- inserts a NEW row, so a stale offer on the old row would only ever be
-- confusing evidence. Clearing keeps "offer outstanding" and "device active"
-- from drifting apart.
--
-- NOTHING FINANCIAL CHANGES. build_job_id is untouched by both functions below,
-- so a revoked device's already-recorded sales still price and replay exactly as
-- they did. The unpair path's blocking rules are also unchanged: 25.1's refusal
-- to unpair with unresolved sales is enforced client-side and is not weakened
-- here.
-- ----------------------------------------------------------------------------
create or replace function public.unpair_own_device()
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

  -- A device may only ever name itself. There is no parameter to pass another
  -- device's id, which is what makes "may only unpair its own row" a property
  -- of the signature rather than of a check that could be edited away.
  update public.paired_devices d
  set unpaired_at = coalesce(d.unpaired_at, now()),
      -- Feature 26.1 — a device leaving takes no pending offer with it.
      offered_build_job_id = null,
      offered_at = null
  where d.auth_user_id = v_caller
  returning * into v_device;

  if not found then
    -- Same non-probing message the rest of the pairing layer uses.
    raise exception 'Device not found or access denied';
  end if;

  return jsonb_build_object(
    'ok', true,
    'device_id', v_device.id,
    'unpaired_at', v_device.unpaired_at
  );
end;
$function$;

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
  set revoked_at = now(),
      revoked_by = v_caller,
      -- Feature 26.1 — a revoked device holds no offer.
      offered_build_job_id = null,
      offered_at = null
  where id = p_device_id
  returning * into v_device;

  return jsonb_build_object(
    'ok', true, 'device_id', v_device.id,
    'revoked_at', v_device.revoked_at, 'already_revoked', false
  );
end;
$function$;
