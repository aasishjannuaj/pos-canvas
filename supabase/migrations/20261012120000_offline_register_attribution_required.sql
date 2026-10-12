-- v1.3 CP-2B — a NEW offline sale must carry its ORIGINAL register session.
--
-- WHAT THIS CHANGES, and nothing else:
--   1. The register claim is validated by its OWN identity. The previous
--      zone-agreement branch called daily_register_context_for_sale and stored
--      whatever session that resolved, which could differ from the one the
--      cashier used. Control Room requirement 2 forbids automatic
--      substitution, so that call is gone.
--   2. A new sale with source 'offline_queued' and an unresolvable register
--      claim now raises instead of committing with NULL attribution.
--
-- WHAT IS DELIBERATELY UNCHANGED:
--   * The existing-order idempotency lookup and the canonical hash comparison,
--     including 'Sale request ID was already used for a different order'.
--   * Cross-source replay: a committed order replays under 'offline_queued'
--     and returns the original order, because the lookup precedes this branch.
--   * Closed-but-covering original sessions remain acceptable for late
--     posting.
--   * Online sales.
--   * NULL employee attribution, which remains the accepted v1.3 limitation.
--   * complete_sale_v2, v3 and v4.
--   * Every historical order. There is no backfill and no data change.
--
-- The error sentence follows the existing convention: a plain `raise
-- exception` with a stable message, which lib/saleSyncClassifier.ts maps to a
-- definitive server rejection rather than a retry.
--
-- FORWARD-ONLY. `create or replace` preserves the ACL, so the grants below are
-- restated exactly as accepted rather than changed.

create or replace function public.complete_sale_v5(
  p_payment_method text,
  p_tip_amount numeric,
  p_items jsonb,
  p_sale_request_id uuid,
  p_occurred_at timestamptz default null,
  p_source text default 'online',
  p_employee_pos_session_id uuid default null,
  p_register_session_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
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
  -- Feature 28C — the business identity and receipt settings to print this
  -- sale's receipt with, frozen at sale time. Set on the OWNER branch only: a
  -- device sale already records build_job_id, whose config_snapshot is
  -- immutable and holds the same two objects, so storing a second copy would
  -- create two answers to one question.
  v_receipt_snapshot jsonb;

  -- Feature 24.5B. NOTE the name: v_source is already taken by the pricing
  -- CONFIG below, which is a different thing entirely.
  v_sale_source   text;
  v_occurred_at   timestamptz;
  v_device_revoked_at timestamptz;
  -- Feature 25.1 — the device removed itself. Administrative, never temporal:
  -- this value is NEVER compared against occurred_at.
  v_device_unpaired_at timestamptz;
  v_device_paired_at  timestamptz;
  -- v1.3 Feature 1B — every identity below is DERIVED on the server. None of
  -- them is a parameter, and no parameter is ever copied into one.
  v_project_id    uuid;
  v_device_id     uuid;
  v_employee_id   uuid;
  v_register_session_id uuid;

  -- v1.3 CP2c -- the DAILY register context.
  v_expected_daily record;
  v_daily record;
  v_daily_claim record;
  v_business_date date;
  v_current_zone text;
  v_employee_session record;
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
  -- 2. Authorization — v1.3 Feature 1B: DEVICE ONLY, project DERIVED.
  --
  -- complete_sale_v5 takes no project id. The project is the one the calling
  -- device is paired to, read from the device's own row, so no request can
  -- name another tenant. Owner Web and Builder stay on complete_sale_v3; an
  -- owner's auth user has no paired_devices row and is refused here with the
  -- same non-probing message every other refusal uses.
  --
  -- The device row is resolved WITHOUT the revoked/unpaired filter, exactly as
  -- v4 does and for v4's reason: an idempotent replay of an order this project
  -- already holds must still be answerable after the till is revoked. Both
  -- decisions stay in the new-sale branch (6c), unchanged.
  --
  -- LOCK ORDER, step 1 of the Feature 1B global order: the device row FOR
  -- SHARE, BEFORE the project row. employee_login, register open/close,
  -- revoke, unpair and the config-update pair all take this row FOR UPDATE
  -- (or UPDATE it) and none of them locks projects, so no cycle exists. Taking
  -- it first also means a till's login — which holds this row across a bcrypt
  -- verification — delays only that till's sales, never the whole project's.
  -- Every device fact used later (pinned build, revocation, unpair) comes
  -- from this locked read, so a concurrent config apply cannot slip a
  -- different build under the pricing below.
  -- ==========================================================================
  select d.id, d.project_id, d.owner_id, d.build_job_id, d.revoked_at,
         d.created_at, d.unpaired_at
    into v_device_id, v_project_id, v_owner_id, v_build_job_id,
         v_device_revoked_at, v_device_paired_at, v_device_unpaired_at
  from public.paired_devices d
  where d.auth_user_id = v_caller
  for share;

  if not found then
    raise exception 'Project not found or access denied';
  end if;

  -- Constant. Every owner branch below is unreachable in v5 and is kept only so
  -- the pricing, tax, receipt and inventory code stays byte-for-byte v4's.
  v_is_owner := false;

  -- ==========================================================================
  -- 3. Lock the project row. Single serialization point per project, taken
  --    before any pricing, stock, idempotency or counter access.
  -- ==========================================================================
  select p.config into v_config
  from public.projects p
  where p.id = v_project_id and p.user_id = v_owner_id
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
    'project=' || v_project_id::text || E'\n' ||
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
  where o.project_id = v_project_id
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
    -- 6d. v1.3 Feature 1B — sale attribution. NEW SALES ONLY.
    --
    --     A replay returned above with the attribution it was stored with; it
    --     never reaches this block, so a completed sale stays replayable after
    --     a switch, logout, deactivation, register close or reopen.
    --
    --     LOCK ORDER, steps 3-5 (the device is step 1 and the project step 2,
    --     both already held): employee POS session, employee, register session.
    -- ========================================================================
    if v_sale_source = 'online' then
      -- ONLINE: current state, compared against what the till expected.
      --
      -- The two ids are CONCURRENCY EXPECTATIONS, never authority. Every
      -- stored identity is read from the locked server row below.
      if p_employee_pos_session_id is null or p_register_session_id is null then
        raise exception 'This sale must name the signed-in employee and the open register';
      end if;

      -- FOR SHARE on BOTH rows. The session lock conflicts with employee_logout's
      -- UPDATE (which takes no device lock); the employee lock conflicts with
      -- set_employee_active's UPDATE. FOR KEY SHARE would NOT: it is compatible
      -- with a non-key UPDATE. If either writer commits first, READ COMMITTED
      -- re-checks this WHERE clause against the new row version, the row stops
      -- qualifying, and the sale is refused. employee_login's switch is excluded
      -- earlier, by the device lock.
      select s.id, s.employee_id
        into v_employee_session
      from public.employee_pos_sessions s
      join public.employees e on e.id = s.employee_id
      where s.paired_device_id = v_device_id
        and s.ended_at is null
        and e.active
        and e.project_id = v_project_id
        and e.role in ('owner', 'manager', 'cashier')
      for share of s, e;

      if not found then
        raise exception 'An employee must be signed in on this register';
      end if;

      if v_employee_session.id is distinct from p_employee_pos_session_id then
        raise exception 'The signed-in employee changed';
      end if;

      -- ====================================================================
      -- v1.3 CP2c -- IS THE EXPECTATION A DAILY CONTEXT OF THIS DEVICE?
      --
      -- This single lookup decides which of two worlds the sale is in, and it
      -- is deliberately narrow: the row must exist, belong to THIS device, and
      -- carry a business_date. Anything else -- an unknown id, a legacy drawer
      -- period, or ANOTHER device's daily context -- falls through to the
      -- accepted Feature 1B block below and is judged by the rules that were
      -- already there. A daily id from another till therefore authorizes
      -- nothing; it is simply not this device's register.
      -- ====================================================================
      select r.id, r.business_date, r.business_timezone, r.opened_at, r.closed_at
        into v_expected_daily
      from public.register_sessions r
      where r.id = p_register_session_id
        and r.paired_device_id = v_device_id
        and r.business_date is not null
      for share;

      if found then
        -- ==================================================================
        -- DAILY. The till named a business day; the server decides which
        -- business day it actually is.
        --
        -- CURRENTNESS IS NOT closed_at. A daily row is born with its end
        -- already set, so `closed_at is null` -- the legacy test, still used
        -- below -- would say every daily context is closed. What makes a daily
        -- context current is that it is the one the authoritative server
        -- instant falls inside, for this device, in the project's own zone.
        --
        -- SERVER TIME, NOT p_occurred_at. An online sale may not declare when
        -- it happened; section 6b already refused any attempt, and v_occurred_at
        -- is now() for this branch. The day is derived from the same clock.
        -- ==================================================================
        select c.register_session_id, c.failure
          into v_daily
        from public.daily_register_context_for_sale(v_device_id, v_occurred_at) c;

        if v_daily.failure is not null then
          -- The current context cannot be established safely. A NEW online sale
          -- is refused rather than attributed to a day nobody can name. CP2b's
          -- contract strings are raised verbatim so one vocabulary covers the
          -- whole feature; nothing historical is rewritten to make this pass.
          raise exception '%', v_daily.failure;
        end if;

        select r.business_date into v_business_date
        from public.register_sessions r
        where r.id = v_daily.register_session_id;

        if v_expected_daily.business_date > v_business_date then
          -- A FUTURE business day is never a rollover. Time does not run
          -- backwards, so an expectation ahead of the server's own calendar is
          -- a stale-state problem, not a midnight that has passed.
          raise exception 'The register session changed';
        end if;

        if v_expected_daily.business_date < v_business_date then
          -- ================================================================
          -- EXPECTED CALENDAR ROLLOVER. The till has been open across at least
          -- one midnight. That is the normal life of a till, not an incident:
          -- no cashier closed anything, nobody logged out, and there is nothing
          -- for anyone to recover. The sale is attributed to the day it is
          -- actually happening on.
          --
          -- HOW FAR BACK DOES NOT MATTER. A till that slept from the 18th to
          -- the 20th rolls straight to the 20th; the 19th is not manufactured
          -- to bridge the gap, because no sale happened on the 19th and an
          -- empty day invented by a sale would be a lie about the business.
          -- ================================================================
          null;
        elsif v_expected_daily.id is distinct from v_daily.register_session_id then
          -- Same business date, different daily row. Uniqueness on
          -- (paired_device_id, business_date) means this cannot happen today;
          -- it is checked anyway, because "cannot happen" is an argument about
          -- an index that some later migration could relax, and the safe answer
          -- if it ever does happen is to refuse.
          raise exception 'The register session changed';
        end if;

        v_register_session_id := v_daily.register_session_id;
      else
        -- ==================================================================
        -- LEGACY / MANUAL -- the accepted Feature 1B block, unchanged.
        --
        -- register_session close takes the device row FOR UPDATE, so the step-1
        -- lock already excludes it; this lock is the backstop for any future
        -- writer of this row.
        -- ==================================================================
        select r.id
          into v_register_session_id
        from public.register_sessions r
        where r.paired_device_id = v_device_id
          and r.closed_at is null
        for share;

        if not found then
          raise exception 'The register is not open';
        end if;

        if v_register_session_id is distinct from p_register_session_id then
          raise exception 'The register session changed';
        end if;
      end if;

      v_employee_id := v_employee_session.employee_id;
    else
      -- OFFLINE: SERVER-VALIDATED HISTORICAL ATTRIBUTION — not cryptographically
      -- proven operator identity.
      --
      -- The two ids are CLAIMS captured at offline checkout. Each dimension is
      -- validated on its own against durable server history for THIS device
      -- and the already-validated occurred_at. A claim that does not validate
      -- is stored as NULL; it never rejects a paid sale, is never filled from
      -- current state, and is never inferred from the other dimension.
      --
      -- KNOWN LIMITATION: Feature 1A keeps no history of active/inactive
      -- intervals — deactivation leaves a session open and reactivation clears
      -- deactivated_at — so the session interval cannot prove the employee was
      -- active at every instant inside it. The claim is validated against the
      -- session interval and the device/project relationship only.
      if p_employee_pos_session_id is not null then
        select s.employee_id
          into v_employee_id
        from public.employee_pos_sessions s
        join public.employees e on e.id = s.employee_id
        where s.id = p_employee_pos_session_id
          and s.paired_device_id = v_device_id
          and e.project_id = v_project_id
          and s.started_at <= v_occurred_at
          and (s.ended_at is null or v_occurred_at < s.ended_at)
        for share of s;

        if not found then
          v_employee_id := null;
        end if;
      end if;

      if p_register_session_id is not null then
        -- ==================================================================
        -- v1.3 CP2c -- THE CLAIM SIGNALS THE MODEL, NEVER THE ATTRIBUTION.
        --
        -- A queued sale carries whatever register id the till held when the
        -- money changed hands. If that id is a DAILY context of THIS device,
        -- it says one thing only: this record was taken under the daily model.
        -- It does NOT say which day the sale belongs to, and it must not,
        -- because a till that queued sales across midnight kept the same
        -- retained id on both sides of it. Honouring the id would file a
        -- 00:07 sale under yesterday.
        --
        -- So the day is DERIVED, from the already-accepted occurred_at and the
        -- project's own zone -- the same calendar rules, reaching a different
        -- day for a different instant. 23:58 and 00:07 on the same retained
        -- claim land on different business dates, which is the entire point.
        --
        -- ANOTHER DEVICE'S DAILY ID IS NOT A SIGNAL. The lookup is scoped to
        -- this device, so a foreign daily id falls through to the accepted
        -- historical validation below, which is scoped the same way and stores
        -- NULL. It can never manufacture attribution for this till.
        --
        -- AND THE ZONE IT WAS TAKEN UNDER MUST STILL BE THE BUSINESS'S ZONE.
        -- Deriving a day is only honest while the calendar has not moved
        -- underneath the sale; see the snapshot comparison below.
        -- ==================================================================
        -- v1.3 CP-2B — the claim's OWN time window is read here, because the
        -- claim is now validated by its own identity rather than re-derived.
        select r.id, r.business_timezone, r.opened_at, r.closed_at
          into v_daily_claim
        from public.register_sessions r
        where r.id = p_register_session_id
          and r.paired_device_id = v_device_id
          and r.business_date is not null
        for share;

        if found then
          -- ================================================================
          -- THE SNAPSHOT IS PART OF THE CLAIM, AND IT IS CHECKED FIRST.
          --
          -- The claim carries the zone the till was operating under when the
          -- money changed hands. If the business has since changed zones, the
          -- day this sale belonged to was measured with a ruler nobody uses
          -- any more -- and deriving it now, with the new zone, would be
          -- REINTERPRETING a completed sale rather than recording it.
          --
          -- Waiting for daily_register_context_for_sale to notice is not
          -- enough, and that was the defect. Its conflict check only fires
          -- when an interval already covers the instant; for a past day with
          -- no context yet it would cheerfully CREATE one under the new zone,
          -- which is the incompatible historical row this whole design exists
          -- to prevent. So the comparison happens here, before it is called.
          --
          -- IDENTITY, NOT EQUIVALENCE. CP2a stores the zone verbatim and CP2b
          -- treats any changed snapshot as a conflict. A distinct string is a
          -- conflict here for the same reason: no alias canonicalization, no
          -- offset comparison, no normalization. Two spellings of the same
          -- offset are still two different answers to "what did this business
          -- call that day", and picking one would be inventing an answer.
          --
          -- The project row is already held FOR UPDATE by section 3, so this
          -- is a plain read of a pinned row -- no new lock, no lock order.
          -- A NULL current zone is distinct from the claim's (a daily row
          -- cannot have a null one), so the already-approved "no timezone now
          -- means unprovable" behaviour falls out of the same comparison.
          -- ================================================================
          select p.business_timezone
            into v_current_zone
          from public.projects p
          where p.id = v_project_id;

          if v_daily_claim.business_timezone is distinct from v_current_zone then
            -- UNPROVABLE, NOT INVALID. Nothing is created, nothing is
            -- rewritten, and the claim row is not touched.
            v_register_session_id := null;
          else
            -- v1.3 CP-2B — NO SUBSTITUTION. This branch used to call
            -- daily_register_context_for_sale and store whatever register that
            -- resolved for the sale's instant, which could be a DIFFERENT
            -- session from the one the cashier actually used. Control Room
            -- requirement 2 forbids that outright, so the claim is now
            -- validated by its own identity and accepted or refused as itself.
            --
            -- Closed-but-covering is deliberately still accepted: a sale queued
            -- before close of business belongs to the session that was open
            -- when the money changed hands, and owner reporting joins
            -- register_sessions and reads its business_date, so late posting
            -- files under the correct day.
            if v_daily_claim.opened_at <= v_occurred_at
               and (v_daily_claim.closed_at is null
                    or v_occurred_at < v_daily_claim.closed_at) then
              v_register_session_id := v_daily_claim.id;
            else
              v_register_session_id := null;
            end if;

          end if;
        else
          -- ==================================================================
          -- LEGACY / MANUAL, or a claim this device cannot own -- the accepted
          -- Feature 1B validation, unchanged.
          -- ==================================================================
          select r.id
            into v_register_session_id
          from public.register_sessions r
          where r.id = p_register_session_id
            and r.paired_device_id = v_device_id
            and r.opened_at <= v_occurred_at
            and (r.closed_at is null or v_occurred_at < r.closed_at)
          for share;

          if not found then
            v_register_session_id := null;
          end if;
        end if;
      end if;
    end if;

    -- ========================================================================
    -- 6d. v1.3 CP-2B — A NEW OFFLINE SALE MUST CARRY ITS ORIGINAL REGISTER.
    --
    --     PLACED HERE DELIBERATELY, and the position is the whole safety
    --     argument:
    --       * AFTER the idempotency lookup in section 6, which is at the top
    --         level of this body. An already-committed sale returned before
    --         this branch was ever entered, so a replay — including a
    --         cross-source replay of an ONLINE order under source
    --         'offline_queued' — cannot reach this statement.
    --       * INSIDE the new-sale branch only.
    --       * BEFORE every side effect: the order-counter allocation, the
    --         orders insert, the order_items insert, the inventory_transactions
    --         insert and the projects config update all follow in section 8.
    --         Nothing has been written at this point, so the refusal is clean
    --         by construction and not merely by transaction rollback.
    --
    --     WHY REGISTER AND NOT EMPLOYEE. Owner reporting JOINS
    --     register_sessions and reads its business_date; a NULL register
    --     therefore leaves the sale with no authoritative business date and
    --     nothing to reconcile it against. A NULL employee loses WHO rang it,
    --     which is an attribution gap, and remains the accepted v1.3
    --     limitation. These are different kinds of loss.
    --
    --     ONLINE IS UNTOUCHED. An online sale already raises 'The register is
    --     not open' when none is, and takes its register from server state
    --     rather than from a claim.
    -- ========================================================================
    if v_sale_source = 'offline_queued' and v_register_session_id is null then
      raise exception 'A register session is required for an offline sale';
    end if;

    -- ========================================================================
    -- 7. New sale. Resolve the authorized pricing source.
    -- ========================================================================
    if v_is_owner then
      v_source := v_config;
      -- Feature 28C — captured from the SAME v_config this sale is being priced
      -- from, inside the same project lock, so the header on the receipt and the
      -- prices on it can never come from two different reads.
      v_receipt_snapshot := jsonb_build_object(
        'businessProfile', coalesce(v_config -> 'businessProfile', '{}'::jsonb),
        'receipt', coalesce(v_config -> 'receipt', '{}'::jsonb)
      );
    else
      select b.config_snapshot into v_source
      from public.build_jobs b
      where b.id = v_build_job_id
        and b.project_id = v_project_id
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
    values (v_project_id, 1000)
    on conflict (project_id) do nothing;

    select c.last_number into v_suffix
    from public.project_order_counters c
    where c.project_id = v_project_id
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
    where project_id = v_project_id
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
        build_job_id,
        receipt_snapshot,
        -- v1.3 Feature 1B — all three derived above, never from a parameter.
        employee_id, paired_device_id, register_session_id
      )
      values (
        v_owner_id, v_project_id, v_order_number, v_method,
        v_subtotal, v_tax_amount, v_tip_amount, v_total,
        'server', p_sale_request_id, v_hash,
        v_occurred_at, v_sale_source, v_has_shortfall,
        v_build_job_id,
        v_receipt_snapshot,
        v_employee_id, v_device_id, v_register_session_id
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
        where o.project_id = v_project_id
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
        inventory_shortfall, line_position
      )
      select v_order_id, line ->> 'item_id', line ->> 'item_name',
             (line ->> 'unit_price')::numeric, (line ->> 'quantity')::integer,
             (line ->> 'line_total')::numeric,
             coalesce(line -> 'modifiers', '[]'::jsonb),
             coalesce((line ->> 'shortfall')::integer, 0),
             line_no::integer
      from jsonb_array_elements(v_lines) with ordinality as t(line, line_no);

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
      select v_owner_id, v_project_id, v_order_id, line ->> 'item_id',
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
      where id = v_project_id and user_id = v_owner_id;

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
  --     build id, config snapshot and inventory before/after values.
  --     v1.3 Feature 1B — the STORED attribution is returned, read from the
  --     order row, so a replay answers with what was recorded, never with
  --     who happens to be signed in now.
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
           'attribution', jsonb_build_object(
             'employeeId', o.employee_id,
             'pairedDeviceId', o.paired_device_id,
             'registerSessionId', o.register_session_id
           ),
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
                      -- Feature 28C — cart order for a sale written since this
                      -- feature, and a DETERMINISTIC fallback for every older row,
                      -- whose line_position is null and always will be. item_id
                      -- alone is not a total order: two lines of the same product
                      -- with different options tie on it, and a tie left to the
                      -- planner can order the slip and the reprint differently.
                      order by oi.line_position nulls last,
                               oi.item_id collate "C",
                               oi.id
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

revoke all on function public.complete_sale_v5(text, numeric, jsonb, uuid, timestamptz, text, uuid, uuid) from public;
revoke all on function public.complete_sale_v5(text, numeric, jsonb, uuid, timestamptz, text, uuid, uuid) from anon;
grant execute on function public.complete_sale_v5(text, numeric, jsonb, uuid, timestamptz, text, uuid, uuid) to authenticated;
