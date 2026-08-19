-- Milestone 24, Feature 24.5B — the server-side offline sale contract.
--
-- SCOPE: three additive columns, one new function, and nothing else. No table
-- is dropped, no grant is widened, no policy or trigger changes, no existing
-- migration file is touched, and complete_sale_v3 is left byte-for-byte alone.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES
-- ----------------------------------------------------------------------------
--   1. orders.occurred_at            — when the sale physically happened.
--   2. orders.source                 — 'online' | 'offline_queued'.
--   3. orders.has_inventory_shortfall — fast filter for reconciliation.
--   4. order_items.inventory_shortfall — how many units short, per line.
--   5. complete_sale_v4              — built from v3's audited body by targeted
--      replacement, so every part not listed below is byte-identical to the
--      function in production today.
--
-- ----------------------------------------------------------------------------
-- WHY created_at IS NOT REUSED
-- ----------------------------------------------------------------------------
-- orders.created_at defaults to now() and records when the SERVER committed the
-- row. That is correct and stays exactly as it is. Once a sale can sit in a
-- device queue for hours, it stops being the answer to "when did the customer
-- pay" — a 14:05 sale synced at 18:30 would report as 18:30 and quietly corrupt
-- every daily-takings and shift figure. The two timestamps answer different
-- questions and neither is derivable from the other, so both are kept.
--
-- ----------------------------------------------------------------------------
-- EXACTLY WHAT DIFFERS BETWEEN v3 AND v4
-- ----------------------------------------------------------------------------
--   * signature  — p_occurred_at and p_source added, both defaulted.
--   * section 1  — p_source validated against a closed set.
--   * section 2  — the device is resolved WITHOUT resolve_sale_owner's
--                  revoked filter, so the revocation decision can be made per
--                  case in 6c instead of refusing everything up front. See the
--                  long note in the function body; this is the one place v4
--                  relaxes something v3 enforced.
--   * section 6b — occurred_at validation. New sales only.
--   * section 6c — the revocation window.
--   * section 8  — offline sales floor stock at 0 and record a shortfall;
--                  online behaviour is untouched.
--   * section 11 — the new columns are persisted, and the inventory audit row
--                  records the ACTUAL decrement rather than the requested
--                  quantity.
--   * section 12 — payload gains occurredAt, source, hasInventoryShortfall and
--                  a per-line inventoryShortfall. Nothing is renamed.
--
-- Everything else — caller and shape validation, the project FOR UPDATE lock,
-- tip rules, canonicalization and hashing, the idempotency lookup, pinned-build
-- pricing, modifier resolution, money bounds, tax modes and rounding points,
-- order-number allocation, the atomic write and the single payload path — is
-- carried over unmodified.
--
-- ----------------------------------------------------------------------------
-- ATOMICITY
-- ----------------------------------------------------------------------------
-- Wrapped in an explicit transaction, following the v3 migration: the
-- verification block is the last statement, and a failure must not leave
-- production carrying new columns and half a function. Every statement here is
-- transaction-safe — no CREATE INDEX CONCURRENTLY, no VACUUM, no ALTER TYPE.
--
-- ONE LOCK WORTH KNOWING ABOUT: step 1 sets occurred_at NOT NULL after
-- backfilling it, which takes a brief ACCESS EXCLUSIVE lock and scans the table
-- to validate. On a small orders table that is milliseconds. If orders ever
-- grows large, split that one statement into a separate migration using a NOT
-- VALID check constraint plus VALIDATE CONSTRAINT.
-- ----------------------------------------------------------------------------

begin;

-- ----------------------------------------------------------------------------
-- 1. orders.occurred_at
--
-- Added nullable, backfilled from created_at, then made NOT NULL. Backfilling
-- to created_at is the only honest value for a historical row: every order
-- recorded before this migration was made online, at the moment it was
-- committed, so the two genuinely were the same instant.
--
-- NOT NULL rather than nullable-and-flagged: v4 REFUSES a sale whose declared
-- time cannot be validated (see 6b) instead of recording one with a null. A
-- refusal leaves the sale in the device's queue where it can be resolved; a
-- null would put an unanswerable row in the books. The default keeps any future
-- writer honest without having to know about this column.
-- ----------------------------------------------------------------------------
alter table public.orders
  add column if not exists occurred_at timestamptz;

update public.orders set occurred_at = created_at where occurred_at is null;

alter table public.orders alter column occurred_at set default now();
alter table public.orders alter column occurred_at set not null;

-- ----------------------------------------------------------------------------
-- 2. orders.source
--
-- A checked text column rather than a Postgres enum, deliberately: adding a
-- value to an enum cannot run inside a transaction (ALTER TYPE ... ADD VALUE),
-- which would break this migration's atomicity guarantee and every future one
-- that needs a new source.
-- ----------------------------------------------------------------------------
alter table public.orders
  add column if not exists source text not null default 'online';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'orders_source_check'
  ) then
    alter table public.orders
      add constraint orders_source_check
      check (source = any (array['online'::text, 'offline_queued'::text]));
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 3. orders.has_inventory_shortfall
--
-- An order-level flag so "show me what needs reconciling" is an index lookup
-- rather than a join across every line of every order. The DETAIL lives on
-- order_items; this is the pointer.
-- ----------------------------------------------------------------------------
alter table public.orders
  add column if not exists has_inventory_shortfall boolean not null default false;

create index if not exists orders_inventory_shortfall_idx
  on public.orders using btree (project_id, created_at desc)
  where has_inventory_shortfall;

-- ----------------------------------------------------------------------------
-- 4. order_items.inventory_shortfall
--
-- How many units this line sold that stock did not have. Answers both questions
-- an owner will ask — which item, and how many short — with one integer.
--
-- WHY NOT inventory_transactions: that table carries a
-- `quantity_after = quantity_before + quantity_change` check and a
-- `quantity_after >= 0` check. A shortfall is by definition the part of the
-- sale that could NOT be taken out of stock, so it has no consistent
-- representation there. Recording it on the line keeps the audit table's
-- arithmetic true.
-- ----------------------------------------------------------------------------
alter table public.order_items
  add column if not exists inventory_shortfall integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'order_items_inventory_shortfall_check'
  ) then
    alter table public.order_items
      add constraint order_items_inventory_shortfall_check
      check (inventory_shortfall >= 0 and inventory_shortfall <= quantity);
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 5. complete_sale_v4
-- ----------------------------------------------------------------------------
create or replace function public.complete_sale_v4(
  p_project_id uuid,
  p_payment_method text,
  p_tip_amount numeric,
  p_items jsonb,
  p_sale_request_id uuid,
  -- Feature 24.5B. Both default so v4 is a drop-in superset of v3 for an
  -- ordinary online caller, and so adopting it later is a rename rather than a
  -- rewrite of every call site.
  p_occurred_at timestamptz default null,
  p_source text default 'online'
)
returns jsonb
language plpgsql
security definer
set search_path to public, pg_temp
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

  -- Feature 24.5B. NOTE the name: v_source is already taken by the pricing
  -- CONFIG below, which is a different thing entirely.
  v_sale_source   text;
  v_occurred_at   timestamptz;
  v_device_revoked_at timestamptz;
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
    select d.owner_id, d.build_job_id, d.revoked_at, d.created_at
      into v_owner_id, v_build_job_id, v_device_revoked_at, v_device_paired_at
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
        occurred_at, source, has_inventory_shortfall
      )
      values (
        v_owner_id, p_project_id, v_order_number, v_method,
        v_subtotal, v_tax_amount, v_tip_amount, v_total,
        'server', p_sale_request_id, v_hash,
        v_occurred_at, v_sale_source, v_has_shortfall
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
-- Identical posture to v3: SECURITY DEFINER, locked search_path, executable by
-- authenticated only. service_role is revoked deliberately — the build worker
-- and every other privileged path must never be able to complete a sale.
revoke all on function public.complete_sale_v4(uuid, text, numeric, jsonb, uuid, timestamptz, text) from public;
revoke all on function public.complete_sale_v4(uuid, text, numeric, jsonb, uuid, timestamptz, text) from anon;
revoke all on function public.complete_sale_v4(uuid, text, numeric, jsonb, uuid, timestamptz, text) from service_role;
grant execute on function public.complete_sale_v4(uuid, text, numeric, jsonb, uuid, timestamptz, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 6. Verification — fails loudly rather than leaving a half-applied contract.
-- ----------------------------------------------------------------------------
do $$
declare
  v_missing text;
begin
  select string_agg(c, ', ') into v_missing
  from unnest(array['occurred_at', 'source', 'has_inventory_shortfall']) c
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = c
  );
  if v_missing is not null then
    raise exception 'orders is missing: %', v_missing;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_items'
      and column_name = 'inventory_shortfall'
  ) then
    raise exception 'order_items.inventory_shortfall is missing';
  end if;

  if exists (select 1 from public.orders where occurred_at is null) then
    raise exception 'orders.occurred_at was not fully backfilled';
  end if;

  -- v3 must survive this migration untouched. A device on an older pinned
  -- bundle still calls it, and 24.5B does not move any client onto v4.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'complete_sale_v3'
  ) then
    raise exception 'complete_sale_v3 disappeared';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'complete_sale_v4'
  ) then
    raise exception 'complete_sale_v4 was not created';
  end if;
end $$;

commit;
