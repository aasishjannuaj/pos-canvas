-- v1.3 Feature 1D — cash movements: money that enters or leaves a till without
-- a sale.
--
-- WHAT THIS RECORDS. Three ordinary events, named the way shopkeepers name
-- them. A CASH DROP is cash taken out of the drawer for safer storage: the
-- money stays inside the business and will be counted again at the safe. A PAID
-- IN is cash deliberately added for a reason that is not a sale -- a float
-- top-up, a reimbursement returned. A PAID OUT is cash removed to settle an
-- operational expense: unlike a drop, that money leaves the business entirely.
--
-- WHY A DROP AND A PAID OUT ARE NOT ONE THING even though both shrink the
-- drawer: the cash goes to different places. Merge them and a later count can
-- no longer say whether missing cash is banked or spent, which is precisely the
-- question a close exists to answer. Conversely "safe drop" and "cash pickup"
-- are NOT separate kinds; they name the destination or the collector of the same
-- event, and splitting them would force every future report to sum across
-- synonyms.
--
-- WHAT THIS DOES NOT DO, AND MUST NOT LEARN TO DO. It records source events and
-- computes nothing. No expected drawer cash, no actual drawer cash, no
-- resulting balance, no variance, no over/short, no close. Those need a
-- truthful starting-drawer figure, and this product does not have one:
-- register_sessions.opening_cash is 0 on every DAILY row because
-- register_sessions_daily_shape REQUIRES it to be -- it is a structural
-- placeholder that a constraint forces, not a drawer somebody counted. A
-- feature that read it as a baseline would produce confident arithmetic about
-- money nobody ever counted, and be believed.
--
-- APPEND-ONLY, BECAUSE THESE ARE THE SOURCE RECORDS. A movement, once written,
-- is evidence. There is no edit, no delete, no void and no reversal here, and
-- no correction semantics are invented: this migration grants no client role
-- UPDATE or DELETE on the table at all. How a mistake gets corrected is a
-- decision this checkpoint deliberately does not make.
--
-- AUTHORIZATION IS AN ACTION, NOT A SESSION. Every movement is authorized by an
-- Employee ID and PIN, reusing the hardened Feature 1B/1C door. It creates no
-- POS session, switches no operator, rings nobody out, and punches no clock:
-- the manager who authorizes a paid-out while a cashier keeps serving does not
-- take the till from them.
--
-- ONLINE ONLY, DELIBERATELY. There is no queue. An offline till cannot know
-- which business day a movement belongs to -- that is a server-derived,
-- timezone-dependent fact -- so a queued movement would be filed under a day
-- guessed after the event. A cash record nobody can date is worse than a
-- missing one, because it looks true.

-- ----------------------------------------------------------------------------
-- 1. The table.
--
-- amount CHECKS, mirroring register_sessions_opening_cash_* for the same
-- reasons CP1B gave: numeric(12,2)'s typmod ROUNDS on assignment, so it is not
-- the scale guard -- the RPC rejects the original argument before it is ever
-- assigned, and the CHECK below is defence in depth that survives a future
-- relaxation of the column type. NaN can be stored in a constrained numeric and
-- sorts ABOVE every number, so `amount > 0` does not exclude it; hence the
-- explicit finiteness CHECK.
--
-- NO project_id ON register_sessions. That table binds to a shop through its
-- device, so project_id here is derived from the device too, and is stored
-- because it is the replay scope and the reporting grain.
-- ----------------------------------------------------------------------------
create table if not exists public.cash_movements (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references public.projects(id) on delete cascade,
  paired_device_id    uuid not null references public.paired_devices(id),
  register_session_id uuid not null references public.register_sessions(id),
  employee_id         uuid not null references public.employees(id),
  movement_type       text not null,
  amount              numeric(12,2) not null,
  note                text,
  -- The SERVER's instant, and also this row's creation time -- which is why
  -- there is no created_at beside it. A second timestamp could only ever
  -- disagree with this one.
  occurred_at         timestamptz not null,
  request_id          uuid not null,

  -- Exactly three kinds, spelled one way. A text column with a CHECK, matching
  -- how employees.role and orders.payment_method are stored.
  constraint cash_movements_type_check
    check (movement_type in ('cash_drop', 'paid_in', 'paid_out')),

  -- STRICTLY POSITIVE. Direction is carried by movement_type, so a negative or
  -- zero amount is not a movement in the other direction -- it is a mistake, or
  -- an attempt to express a reversal through arithmetic. Neither is recordable
  -- here.
  constraint cash_movements_amount_positive
    check (amount > 0),

  constraint cash_movements_amount_finite
    check (amount <> 'NaN'::numeric
           and amount <> 'Infinity'::numeric
           and amount <> '-Infinity'::numeric),

  constraint cash_movements_amount_scale
    check (amount = trunc(amount, 2)),

  -- A stored note is already trimmed, never empty, and within the limit. Blank
  -- is expressed as NULL, one way only, so "no note" cannot be two things.
  --
  -- THE CHARACTER SET IS SPELLED OUT, AND THAT MATTERS. Bare btrim() strips
  -- SPACES ONLY -- a reason of one tab would pass `note <> ''` and be stored as
  -- invisible content, which is exactly the blank note this constraint exists to
  -- forbid. The same expression appears in cash_movement_append, so the check and
  -- the function cannot drift apart.
  constraint cash_movements_note_shape
    check (note is null
           or (note = btrim(note, E' \t\n\r\f\v')
               and note <> ''
               and length(note) <= 200)),

  -- A paid-in or paid-out without a reason cannot exist. This is the invariant,
  -- not a UI rule: money leaving or entering a business for a non-sale reason
  -- is the first thing an auditor asks about, and a row that cannot answer is
  -- the row that matters most. A drop needs no reason -- the reason is the drop.
  constraint cash_movements_note_required
    check (movement_type = 'cash_drop' or note is not null)
);

comment on table public.cash_movements is
  'v1.3 Feature 1D -- append-only source records of cash entering or leaving a '
  'till without a sale: cash_drop, paid_in, paid_out. Authorized per action by '
  'an Employee ID and PIN; creates no POS session and does not change who '
  'operates the register. Bound to the authoritative DAILY register_session '
  'the server derived, never to one a client named. occurred_at is the SERVER''s '
  'clock. Computes nothing: no expected cash, no actual cash, no balance, no '
  'variance, no over/short, no close. register_sessions.opening_cash is a '
  'structural 0 on every DAILY row and is NOT read as a starting drawer.';

comment on column public.cash_movements.employee_id is
  'The employee who AUTHORIZED this movement, which is not necessarily the '
  'current POS operator: a manager may authorize a paid-out while a cashier '
  'keeps serving on the same till.';

-- ----------------------------------------------------------------------------
-- 2. The invariants.
-- ----------------------------------------------------------------------------

-- THE REPLAY KEY, SCOPED TO THE BUSINESS, AND AT THIS GRAIN ON PURPOSE. A
-- request id is looked up only alongside its project, so one shop's retry can
-- never resolve to another's row. It is NOT widened with the employee or the
-- register session: that would let one id create separate financial movements
-- for different people or different days inside one business, which is the
-- opposite of what a request id is for. Ownership is proved in the function
-- instead -- see the replay branch -- because the id identifies a ROW, never a
-- person. Feature 1C learned that the hard way.
create unique index if not exists cash_movements_project_request
  on public.cash_movements (project_id, request_id);

-- A close, and Lane 3's reporting, will always ask "what moved on this business
-- day". Not unique: a day has many movements.
create index if not exists cash_movements_register_session_idx
  on public.cash_movements (register_session_id, occurred_at desc);

-- ----------------------------------------------------------------------------
-- 3. No client touches this table directly -- not even to read it.
--
-- Feature 1D adds no history surface, so there is no runtime SELECT path to
-- grant. Reporting is Lane 3's, and it will come with its own contract.
-- ----------------------------------------------------------------------------
alter table public.cash_movements enable row level security;

revoke all on table public.cash_movements from public;
revoke all on table public.cash_movements from anon;
revoke all on table public.cash_movements from authenticated;
revoke all on table public.cash_movements from service_role;

-- ----------------------------------------------------------------------------
-- 4. The contract, written once.
--
-- WHY AN INTERNAL HELPER AND NOT THREE COPIES. The three movements differ by
-- exactly two things: which literal goes in movement_type, and whether a note
-- is required. Everything else -- the device derivation, the throttles, the
-- bcrypt, the role gate, the DAILY derivation, the expectation check, the replay
-- ownership rules, the unique-violation re-resolution -- is identical, and it is
-- the part that must not drift. Three copies of two hundred lines would drift.
--
-- AND IT IS NOT A PUBLIC SURFACE. This is the one function that takes
-- movement_type as an argument, so it is revoked from public, anon,
-- authenticated AND service_role below, and the DO block at the end asserts
-- that no client role can execute it. Clients reach it only through the three
-- wrappers, each of which hard-codes its own action. That is the whole reason
-- the wrappers exist rather than one generic RPC: a till must not be able to
-- name the kind of financial event it is creating.
-- ----------------------------------------------------------------------------
create or replace function public.cash_movement_append(
  p_movement_type text,
  p_employee_code text,
  p_pin text,
  p_amount numeric,
  p_note text,
  p_expected_register_session_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $function$
declare
  -- One answer for every credential problem, exactly as employee_login_by_code
  -- and the Time Clock do it: an unknown Employee ID, a wrong PIN and a
  -- deactivated employee are indistinguishable from outside.
  v_generic_failure constant jsonb :=
    jsonb_build_object('ok', false, 'error', 'invalid_credentials');
  v_dummy_hash constant text :=
    '$2a$10$Qw5T.qSV4YJ11CVkf2oUruuburfRGbD4bIoXiMvaWpYs4p6MIwzSG';
  -- The ceiling numeric(12,2) can hold, stated the way complete_sale_v5 states
  -- it so the two money paths cannot disagree.
  c_max_money constant numeric := 9999999999.99;
  c_max_note constant integer := 200;
  v_caller          uuid;
  v_device          record;
  v_now             timestamptz;
  v_throttled_until timestamptz;
  v_note            text;
  v_employee        record;
  v_locked_until    timestamptz;
  v_timezone        text;
  v_business_date   date;
  v_register        record;
  v_existing        record;
  v_movement_id     uuid;
  v_occurred_at     timestamptz;
begin
  -- A wrapper passed something that is not one of the three. Unreachable from
  -- any client -- no client role may execute this function -- so this is a
  -- programming error and is raised rather than answered.
  if p_movement_type is null
     or p_movement_type not in ('cash_drop', 'paid_in', 'paid_out') then
    raise exception 'cash_movement_append: unknown movement type %', p_movement_type;
  end if;

  v_caller := auth.uid();

  if v_caller is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  if p_request_id is null
     or p_request_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return jsonb_build_object('ok', false, 'error', 'request_required');
  end if;

  -- THE EXPECTATION IS MANDATORY. A caller that cannot say which business day
  -- it believes it is on has not earned a movement: see the DAILY section below
  -- for why.
  if p_expected_register_session_id is null
     or p_expected_register_session_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return jsonb_build_object('ok', false, 'error', 'invalid_request');
  end if;

  -- ==========================================================================
  -- LOCK ORDER, step 1: the paired device, FOR SHARE.
  --
  -- Shared rather than exclusive because nothing here changes the device, and a
  -- cash movement must not block a sale on a busy till. It still conflicts with
  -- the FOR UPDATE that ensure_daily_register_context takes, which is exactly
  -- what makes a midnight rollover racing a movement serialize instead of
  -- interleaving.
  -- ==========================================================================
  select d.id, d.project_id
    into v_device
  from public.paired_devices d
  where d.auth_user_id = v_caller
    and d.revoked_at is null
    and d.unpaired_at is null
  for share;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_paired');
  end if;

  v_now := clock_timestamp();

  -- The device cooldown is checked BEFORE anything is looked up, so a throttled
  -- till cannot be used to probe for Employee IDs at all.
  select t.throttled_until
    into v_throttled_until
  from public.employee_login_device_throttles t
  where t.paired_device_id = v_device.id;

  if v_throttled_until is not null and v_throttled_until > v_now then
    return jsonb_build_object(
      'ok', false,
      'error', 'locked_out',
      'retryAfterSeconds', ceil(extract(epoch from (v_throttled_until - v_now)))::integer
    );
  end if;

  -- ==========================================================================
  -- THE MONEY, CHECKED BEFORE THE PIN.
  --
  -- Deliberate order. A mistyped amount reveals nothing about anybody's
  -- credentials, so refusing it here costs no bcrypt and -- more importantly --
  -- does not spend one of the operator's throttle attempts on their own typo.
  --
  -- p_amount IS DECLARED numeric, NOT numeric(12,2). PostgreSQL ignores a
  -- typmod on a function parameter, so the narrower declaration would be
  -- decoration; and if it were ever honoured it would ROUND 25.005 to 25.01 --
  -- putting a number in the books that nobody typed. The value is inspected
  -- exactly as it arrived.
  --
  -- FINITENESS FIRST, and the order is load-bearing: NaN sorts above every
  -- number, so `p_amount <= 0` would let it through, and trunc('NaN',2) is NaN
  -- which equals itself, so the scale test would let it through too.
  -- ==========================================================================
  if p_amount is null
     or p_amount::text in ('NaN', 'Infinity', '-Infinity')
     or p_amount <= 0
     or p_amount <> trunc(p_amount, 2)
     or p_amount > c_max_money then
    return jsonb_build_object('ok', false, 'error', 'invalid_amount');
  end if;

  -- ONE SPELLING OF "NO NOTE". Trimmed, and blank collapsed to NULL, so a drop
  -- with a note of three spaces and a drop with no note are the same row.
  --
  -- THE WHITESPACE SET IS EXPLICIT. Bare btrim() strips SPACES ONLY, so a reason
  -- of a single tab would survive it, read as present, and satisfy a required
  -- note with something nobody can see. The client's .trim() strips all of these
  -- and more, so the UI can never disagree with this -- but a caller reaching the
  -- RPC directly must get the same rule, and this is where that is decided.
  v_note := nullif(btrim(coalesce(p_note, ''), E' \t\n\r\f\v'), '');

  -- OVER-LENGTH IS REFUSED, NEVER TRUNCATED. A silently shortened reason is a
  -- different reason, and the sentence that got cut is the one that explained
  -- the money.
  if v_note is not null and length(v_note) > c_max_note then
    return jsonb_build_object('ok', false, 'error', 'invalid_note');
  end if;

  if v_note is null and p_movement_type <> 'cash_drop' then
    return jsonb_build_object('ok', false, 'error', 'note_required');
  end if;

  -- ==========================================================================
  -- The credential door, reused verbatim from Feature 1B/1C rather than
  -- reimplemented: a second, weaker PIN path beside the hardened one is how
  -- four-digit PINs stop being survivable.
  -- ==========================================================================

  -- A malformed code spends a bcrypt anyway, so timing does not separate
  -- "badly typed" from "does not exist".
  if p_employee_code is null or p_employee_code !~ '^[0-9]{3}$' or p_employee_code = '000' then
    perform public.employee_pin_verify(coalesce(p_pin, '0000'), v_dummy_hash);
    perform public.employee_login_record_device_failure(v_device.id, v_now);
    return v_generic_failure;
  end if;

  -- THE PROJECT COMES FROM THE DEVICE, NEVER THE CLIENT. `001` at one business
  -- and `001` at another are different people.
  select e.id, e.pin_hash
    into v_employee
  from public.employees e
  where e.project_id = v_device.project_id
    and e.employee_code = p_employee_code
    and e.active;

  if not found then
    perform public.employee_pin_verify(coalesce(p_pin, '0000'), v_dummy_hash);
    perform public.employee_login_record_device_failure(v_device.id, v_now);
    return v_generic_failure;
  end if;

  select a.locked_until
    into v_locked_until
  from public.employee_login_employee_attempts a
  where a.paired_device_id = v_device.id
    and a.employee_id = v_employee.id;

  if v_locked_until is not null and v_locked_until > v_now then
    return jsonb_build_object(
      'ok', false,
      'error', 'locked_out',
      'retryAfterSeconds', ceil(extract(epoch from (v_locked_until - v_now)))::integer
    );
  end if;

  if p_pin is null or p_pin !~ '^[0-9]{4}$' then
    perform public.employee_pin_verify('0000', v_dummy_hash);
    perform public.employee_login_record_device_failure(v_device.id, v_now);
    return v_generic_failure;
  end if;

  if not public.employee_pin_verify(p_pin, v_employee.pin_hash) then
    perform public.employee_login_record_employee_failure(v_device.id, v_employee.id, v_now);
    perform public.employee_login_record_device_failure(v_device.id, v_now);
    return v_generic_failure;
  end if;

  delete from public.employee_login_employee_attempts a
  where a.paired_device_id = v_device.id
    and a.employee_id = v_employee.id;

  -- ==========================================================================
  -- LOCK ORDER, step 2: the project, FOR SHARE.
  --
  -- Taken here rather than earlier so it is not held across the bcrypt, and
  -- BEFORE the employee row so the accepted global order -- device, project,
  -- employee POS session, employee, register session -- is preserved. The lock
  -- exists because the business timezone read below decides which DAILY this
  -- money lands on, and a timezone changing mid-transaction could move it to
  -- another day.
  -- ==========================================================================
  perform 1
  from public.projects p
  where p.id = v_device.project_id
  for share;

  -- ==========================================================================
  -- LOCK ORDER, step 4: the employee row, FOR SHARE.
  --
  -- SHARED, not exclusive, and that is a deliberate difference from the Time
  -- Clock. Clocking in needs FOR UPDATE because two clock-ins for one person
  -- must serialize -- only one shift may be open. Two cash movements by one
  -- person are both legitimate and independent, so there is nothing to
  -- serialize; an exclusive lock would only make one manager's two drops queue
  -- behind each other. FOR SHARE still conflicts with set_employee_active's
  -- UPDATE, which is the race that matters: a deactivation committing beside a
  -- movement must win.
  --
  -- Taken AFTER the bcrypt, deliberately: holding a row lock across a password
  -- hash would let one slow verification stall this person's every other action.
  -- ==========================================================================
  select e.id, e.active, e.project_id, e.role, e.display_name
    into v_employee
  from public.employees e
  where e.id = v_employee.id
  for share;

  -- REVALIDATED UNDER THE LOCK. A deactivation that committed while the bcrypt
  -- ran is visible now, and wins.
  if not found or not v_employee.active or v_employee.project_id is distinct from v_device.project_id then
    return v_generic_failure;
  end if;

  -- ==========================================================================
  -- THE ROLE GATE, AND IT IS THE SERVER'S.
  --
  -- A cashier may DROP cash: requiring a manager would leave tills sitting on
  -- more money than they need to, which is the exact risk dropping reduces --
  -- and in a small shop the cashier is often alone. A cashier may NOT move money
  -- in or out for a non-sale reason: those are where abuse concentrates, and
  -- they are worth a second person.
  --
  -- CHECKED AFTER AUTHENTICATION, NEVER BEFORE. Refusing on role before the PIN
  -- is verified would answer "is 004 a cashier?" to anybody holding the till,
  -- turning this into a role oracle. Authenticate, then authorize.
  --
  -- The refusal names no role and no requirement: it says the action is not
  -- available to this employee and stops.
  -- ==========================================================================
  if p_movement_type <> 'cash_drop' and v_employee.role not in ('owner', 'manager') then
    return jsonb_build_object('ok', false, 'error', 'not_permitted');
  end if;

  -- ==========================================================================
  -- THE BUSINESS DAY, DERIVED -- NEVER ACCEPTED, NEVER CREATED.
  --
  -- CP2a's helpers, called as their owner, exactly as
  -- ensure_daily_register_context calls them. The server's clock and the shop's
  -- stored zone decide the date; no argument here can influence it.
  -- ==========================================================================
  begin
    v_timezone := public.require_business_timezone(v_device.project_id);
  exception
    when invalid_parameter_value then
      if sqlerrm <> 'business_timezone_required' then
        raise;
      end if;

      return jsonb_build_object('ok', false, 'error', 'business_timezone_required');
  end;

  v_business_date := public.business_date_of(v_now, v_timezone);

  if v_business_date is null then
    -- The stored zone no longer resolves, so the server cannot say what day it
    -- is for this shop. Same answer as a shop that never told us, because it is
    -- the same problem and has the same fix.
    return jsonb_build_object('ok', false, 'error', 'business_timezone_required');
  end if;

  -- ==========================================================================
  -- LOCK ORDER, step 5: the DAILY register row, FOR SHARE.
  --
  -- READ, NOT ENSURED. ensure_daily_register_context is deliberately NOT called:
  -- a cash movement may not bring a business day into existence. If nobody has
  -- signed this till in today, there is no DAILY and there is nothing for this
  -- money to belong to -- so the movement is refused and the operator is told to
  -- establish the day the ordinary way. Creating one here would let an
  -- unattended till open a business day by itself.
  --
  -- business_date is the sole DAILY discriminator, and
  -- register_sessions_one_daily_per_device_date makes (device, date) unique, so
  -- this selects at most one row.
  -- ==========================================================================
  select r.id
    into v_register
  from public.register_sessions r
  where r.paired_device_id = v_device.id
    and r.business_date = v_business_date
  for share;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'no_daily_context');
  end if;

  -- ==========================================================================
  -- THE EXPECTATION. The client says which day it believed it was on; the
  -- server says which day it is. They must agree.
  --
  -- This is not belt-and-braces. The real case is an operator pressing Confirm
  -- at 23:59:59 and the server committing at 00:00:01: without this check the
  -- money is filed, silently and permanently, under the wrong business day. The
  -- two ids are a CONCURRENCY EXPECTATION, never authority -- the id above was
  -- derived, and this only refuses when the derivation disagrees.
  -- ==========================================================================
  if v_register.id is distinct from p_expected_register_session_id then
    return jsonb_build_object('ok', false, 'error', 'daily_changed');
  end if;

  -- ==========================================================================
  -- REPLAY, AND WHOSE MOVEMENT IT IS.
  --
  -- A retry whose first reply was lost must get its ORIGINAL answer, not a
  -- second movement -- money moved once.
  --
  -- OWNERSHIP AND CONTEXT ARE PART OF THE REPLAY, NOT AN AFTERTHOUGHT. A request
  -- id is unique per business, so it identifies a row -- but it says nothing
  -- about WHOSE row, which day it belonged to, or what kind of event it was.
  -- Matching on the id alone would hand the next employee to authenticate
  -- somebody else's cash record as their own success, simply for presenting a
  -- uuid they happened to have. So the row must also belong to this employee,
  -- this business day and this action; anything else is a conflict that changes
  -- nothing and -- this part matters -- reveals nothing. The refusal carries no
  -- id, no amount, no note and no time, so a request id cannot be used to read
  -- another employee's financial record.
  -- ==========================================================================
  select m.id, m.employee_id, m.register_session_id, m.movement_type,
         m.amount, m.note, m.occurred_at
    into v_existing
  from public.cash_movements m
  where m.project_id = v_device.project_id
    and m.request_id = p_request_id;

  if found then
    if v_existing.employee_id is distinct from v_employee.id
       or v_existing.register_session_id is distinct from v_register.id
       or v_existing.movement_type is distinct from p_movement_type then
      return jsonb_build_object('ok', false, 'error', 'request_conflict');
    end if;

    return jsonb_build_object(
      'ok', true,
      'movementId', v_existing.id,
      'movementType', v_existing.movement_type,
      'amount', v_existing.amount::text,
      'note', v_existing.note,
      'employeeName', v_employee.display_name,
      'occurredAt', v_existing.occurred_at,
      'replayed', true
    );
  end if;

  -- THE SERVER'S CLOCK, and there is no argument through which a device could
  -- offer its own. A till with a wrong clock cannot misdate this shop's money.
  v_occurred_at := clock_timestamp();

  -- THE UNIQUE INDEX IS THE LAST WORD. The lookup above closes the ordinary
  -- case, but two requests carrying the SAME id can reach the insert together --
  -- neither saw the other's row, and nothing they locked serializes them.
  -- Catching the violation re-resolves it through the SAME ownership and context
  -- checks rather than letting a raw constraint error reach a till.
  begin
    insert into public.cash_movements (
      project_id, paired_device_id, register_session_id, employee_id,
      movement_type, amount, note, occurred_at, request_id
    )
    values (
      v_device.project_id, v_device.id, v_register.id, v_employee.id,
      p_movement_type, p_amount, v_note, v_occurred_at, p_request_id
    )
    returning id into v_movement_id;
  exception
    when unique_violation then
      select m.id, m.employee_id, m.register_session_id, m.movement_type,
             m.amount, m.note, m.occurred_at
        into v_existing
      from public.cash_movements m
      where m.project_id = v_device.project_id
        and m.request_id = p_request_id;

      if not found then
        -- The only unique constraint on this table is the replay key, so a
        -- violation with no matching row means the winner has not committed yet.
        -- Answering "try again" is honest; inventing a success is not.
        return jsonb_build_object('ok', false, 'error', 'request_conflict');
      end if;

      if v_existing.employee_id is distinct from v_employee.id
         or v_existing.register_session_id is distinct from v_register.id
         or v_existing.movement_type is distinct from p_movement_type then
        return jsonb_build_object('ok', false, 'error', 'request_conflict');
      end if;

      return jsonb_build_object(
        'ok', true,
        'movementId', v_existing.id,
        'movementType', v_existing.movement_type,
        'amount', v_existing.amount::text,
        'note', v_existing.note,
        'employeeName', v_employee.display_name,
        'occurredAt', v_existing.occurred_at,
        'replayed', true
      );
  end;

  return jsonb_build_object(
    'ok', true,
    'movementId', v_movement_id,
    'movementType', p_movement_type,
    -- ::text, not a JSON number. A jsonb number becomes a float the moment
    -- JavaScript parses it, and the amount an employee is shown on the
    -- confirmation has to be the amount that was stored, exactly -- the same
    -- reason open_register_session renders opening_cash this way.
    'amount', p_amount::text,
    'note', v_note,
    'employeeName', v_employee.display_name,
    'occurredAt', v_occurred_at,
    'replayed', false
  );
end;
$function$;

comment on function public.cash_movement_append(text, text, text, numeric, text, uuid, uuid) is
  'v1.3 Feature 1D -- INTERNAL. The whole cash-movement contract, written once '
  'and called only by record_cash_drop, record_paid_in and record_paid_out, '
  'each of which supplies its own movement_type. Revoked from every client role '
  'precisely because it takes movement_type as an argument: no till may name '
  'the kind of financial event it is creating.';

-- ----------------------------------------------------------------------------
-- 5. The three public actions.
--
-- THREE RPCs, NOT ONE WITH A TYPE ARGUMENT. Each names the event it creates, and
-- the literal is written here where it cannot be chosen by a caller. A single
-- record_cash_movement(p_movement_type => ...) would mean the role gate's
-- subject -- is this a drop, or is it money leaving the business? -- arrived
-- from the till, and a cashier refused a paid-out could simply ask for a drop
-- that was recorded as one.
--
-- Each wrapper is thin on purpose: no validation, no derivation, no answer of
-- its own. All of that lives once, in cash_movement_append.
-- ----------------------------------------------------------------------------
create or replace function public.record_cash_drop(
  p_employee_code text,
  p_pin text,
  p_amount numeric,
  p_note text,
  p_expected_register_session_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $function$
begin
  return public.cash_movement_append(
    'cash_drop', p_employee_code, p_pin, p_amount, p_note,
    p_expected_register_session_id, p_request_id
  );
end;
$function$;

comment on function public.record_cash_drop(text, text, numeric, text, uuid, uuid) is
  'v1.3 Feature 1D -- records cash taken out of this till for safer storage. '
  'Any active employee may authorize one. Note optional. Creates no POS session '
  'and does not change who operates the register.';

create or replace function public.record_paid_in(
  p_employee_code text,
  p_pin text,
  p_amount numeric,
  p_note text,
  p_expected_register_session_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $function$
begin
  return public.cash_movement_append(
    'paid_in', p_employee_code, p_pin, p_amount, p_note,
    p_expected_register_session_id, p_request_id
  );
end;
$function$;

comment on function public.record_paid_in(text, text, numeric, text, uuid, uuid) is
  'v1.3 Feature 1D -- records cash added to this till for a reason that is not a '
  'sale. Owner or manager only. Note REQUIRED. Writes no order and no receipt.';

create or replace function public.record_paid_out(
  p_employee_code text,
  p_pin text,
  p_amount numeric,
  p_note text,
  p_expected_register_session_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $function$
begin
  return public.cash_movement_append(
    'paid_out', p_employee_code, p_pin, p_amount, p_note,
    p_expected_register_session_id, p_request_id
  );
end;
$function$;

comment on function public.record_paid_out(text, text, numeric, text, uuid, uuid) is
  'v1.3 Feature 1D -- records cash removed from this till to settle an '
  'operational expense; unlike a cash drop, that money leaves the business. '
  'Owner or manager only. Note REQUIRED.';

-- ----------------------------------------------------------------------------
-- 6. Privileges. Supabase's ALTER DEFAULT PRIVILEGES means a new function is
--    BORN executable by anon, authenticated and service_role, so every grant
--    here is written revoke-then-grant, matching CP2b, CP2c, CP3.1 and 1C.
-- ----------------------------------------------------------------------------

-- THE INTERNAL HELPER IS REVOKED FROM EVERY CLIENT ROLE, authenticated
-- included. It is the only function that takes movement_type as an argument;
-- reachable, it would be the generic mutation surface the three wrappers exist
-- to prevent.
revoke all on function public.cash_movement_append(text, text, text, numeric, text, uuid, uuid) from public;
revoke all on function public.cash_movement_append(text, text, text, numeric, text, uuid, uuid) from anon;
revoke all on function public.cash_movement_append(text, text, text, numeric, text, uuid, uuid) from authenticated;
revoke all on function public.cash_movement_append(text, text, text, numeric, text, uuid, uuid) from service_role;

revoke all on function public.record_cash_drop(text, text, numeric, text, uuid, uuid) from public;
revoke all on function public.record_cash_drop(text, text, numeric, text, uuid, uuid) from anon;
revoke all on function public.record_cash_drop(text, text, numeric, text, uuid, uuid) from service_role;
grant execute on function public.record_cash_drop(text, text, numeric, text, uuid, uuid) to authenticated;

revoke all on function public.record_paid_in(text, text, numeric, text, uuid, uuid) from public;
revoke all on function public.record_paid_in(text, text, numeric, text, uuid, uuid) from anon;
revoke all on function public.record_paid_in(text, text, numeric, text, uuid, uuid) from service_role;
grant execute on function public.record_paid_in(text, text, numeric, text, uuid, uuid) to authenticated;

revoke all on function public.record_paid_out(text, text, numeric, text, uuid, uuid) from public;
revoke all on function public.record_paid_out(text, text, numeric, text, uuid, uuid) from anon;
revoke all on function public.record_paid_out(text, text, numeric, text, uuid, uuid) from service_role;
grant execute on function public.record_paid_out(text, text, numeric, text, uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 7. Verify what this migration claims, against the live catalog.
--
-- THE SOURCE CHECKS READ CODE, NOT PROSE. The comments above deliberately name
-- the things this function must not call -- "ensure_daily_register_context is
-- deliberately NOT called" -- so a naive prosrc test would match its own
-- explanation and pass while the code did the opposite. v_body is the body with
-- its -- comments stripped.
-- ----------------------------------------------------------------------------
do $do$
declare
  c_public_args constant text :=
    'p_employee_code text, p_pin text, p_amount numeric, p_note text, '
    || 'p_expected_register_session_id uuid, p_request_id uuid';
  v_helper oid;
  v_fn     oid;
  v_name   text;
  v_body   text;
  v_types  text[] := array['cash_drop', 'paid_in', 'paid_out'];
  v_i      integer;
begin
  -- ------------------------------------------------------------------ the table
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'cash_movements') then
    raise exception '1D: cash_movements was not created.';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.cash_movements'::regclass) then
    raise exception '1D: cash_movements must have RLS enabled.';
  end if;

  if (select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'cash_movements') <> 0 then
    raise exception '1D: cash_movements must have no policies.';
  end if;

  -- Effective privileges, not a proacl substring. NO SELECT EITHER: Feature 1D
  -- adds no history surface, so there is no runtime read path to grant.
  if has_table_privilege('authenticated', 'public.cash_movements', 'SELECT')
     or has_table_privilege('authenticated', 'public.cash_movements', 'INSERT')
     or has_table_privilege('authenticated', 'public.cash_movements', 'UPDATE')
     or has_table_privilege('authenticated', 'public.cash_movements', 'DELETE')
     or has_table_privilege('anon', 'public.cash_movements', 'SELECT')
     or has_table_privilege('anon', 'public.cash_movements', 'INSERT')
     or has_table_privilege('service_role', 'public.cash_movements', 'SELECT')
     or has_table_privilege('service_role', 'public.cash_movements', 'UPDATE')
     or has_table_privilege('service_role', 'public.cash_movements', 'DELETE') then
    raise exception '1D: cash_movements is directly reachable by a client role.';
  end if;

  if not exists (select 1 from pg_indexes where schemaname = 'public'
                  and indexname = 'cash_movements_project_request') then
    raise exception '1D: the (project, request) replay index is missing.';
  end if;

  -- THE REPLAY KEY IS NOT WIDENED. Adding employee or register_session to this
  -- index would let one request id create separate financial movements for
  -- different people or different business days inside one shop.
  if (select array_to_string(array_agg(a.attname order by a.attnum), ',')
        from pg_index i
        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
       where i.indexrelid = 'public.cash_movements_project_request'::regclass)
     <> 'project_id,request_id' then
    raise exception '1D: the replay index is not exactly (project_id, request_id).';
  end if;

  -- ------------------------------------------------------- the internal helper
  select p.oid into v_helper from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'cash_movement_append';

  if v_helper is null then
    raise exception '1D: cash_movement_append was not created.';
  end if;

  -- THE POINT OF HAVING THREE WRAPPERS. The one function that accepts a
  -- movement_type must not be callable by a client, or a till could name the
  -- kind of financial event it creates and walk straight past the role gate.
  if has_function_privilege('anon', v_helper, 'EXECUTE')
     or has_function_privilege('authenticated', v_helper, 'EXECUTE')
     or has_function_privilege('service_role', v_helper, 'EXECUTE') then
    raise exception '1D: cash_movement_append is executable by a client role.';
  end if;

  if not (select p.prosecdef from pg_proc p where p.oid = v_helper)
     or not exists (select 1 from pg_proc p where p.oid = v_helper
                     and p.proconfig @> array['search_path=public, pg_catalog, pg_temp']) then
    raise exception '1D: cash_movement_append needs SECURITY DEFINER and a pinned search_path.';
  end if;

  select regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g')
    into v_body
  from pg_proc p where p.oid = v_helper;

  -- ------------------------------------------ the financial boundary, in code
  -- A cash movement records a source event. The moment it reads the structural
  -- zero in opening_cash, or starts adding things up, it is doing a drawer count
  -- with a baseline nobody ever entered -- confidently, and wrongly.
  if v_body ~* 'opening_cash' then
    raise exception '1D: cash_movement_append reads opening_cash.';
  end if;

  if v_body ~* 'expected_cash|actual_cash|over_short|variance|closing_cash|drawer_total' then
    raise exception '1D: cash_movement_append computes drawer arithmetic.';
  end if;

  -- ------------------------------------------- it stays out of everyone's lane
  -- A movement may not bring a business day into existence, end one, take the
  -- till from its operator, or touch a sale.
  if v_body ~* 'ensure_daily_register_context|open_register_session|close_register_session' then
    raise exception '1D: cash_movement_append opens, closes or ensures a register.';
  end if;

  if v_body ~* 'employee_login_by_code|employee_pos_sessions|end_employee_pos_session|employee_logout' then
    raise exception '1D: cash_movement_append touches POS session authority.';
  end if;

  if v_body ~* 'employee_time_sessions|clock_in_employee|clock_out_employee' then
    raise exception '1D: cash_movement_append touches the Time Clock.';
  end if;

  if v_body ~* '\minsert into public\.orders|\mupdate public\.orders|order_items|inventory|project_order_counters' then
    raise exception '1D: cash_movement_append touches sales or stock.';
  end if;

  -- It may only ever INSERT into its own table.
  if v_body ~* 'update public\.cash_movements|delete from public\.cash_movements' then
    raise exception '1D: cash_movement_append is not append-only.';
  end if;

  -- ------------------------------------------------ the rules it must contain
  if v_body !~ 'v_caller := auth\.uid\(\)' or v_body !~ 'where d\.auth_user_id = v_caller' then
    raise exception '1D: cash_movement_append does not derive authority from auth.uid().';
  end if;

  if v_body !~ 'clock_timestamp\(\)' then
    raise exception '1D: cash_movement_append does not stamp from the server clock.';
  end if;

  -- The replay ownership AND context rule, asserted rather than trusted to
  -- review: this is the Feature 1C defect, and it cost a checkpoint.
  if v_body !~ 'v_existing\.employee_id is distinct from v_employee\.id'
     or v_body !~ 'v_existing\.register_session_id is distinct from v_register\.id'
     or v_body !~ 'v_existing\.movement_type is distinct from p_movement_type' then
    raise exception '1D: a cash-movement replay does not prove ownership and context.';
  end if;

  if v_body !~ 'not in \(''owner'', ''manager''\)' then
    raise exception '1D: cash_movement_append has no server-side role gate.';
  end if;

  if v_body !~ 'no_daily_context' or v_body !~ 'daily_changed' then
    raise exception '1D: cash_movement_append does not enforce the DAILY contract.';
  end if;

  -- BARE btrim() WOULD BE A BUG, not a style choice: it strips spaces only, so a
  -- one-tab reason would satisfy a required note with invisible content.
  if v_body ~ 'btrim\(coalesce\(p_note, ''''\)\)' then
    raise exception '1D: cash_movement_append trims only spaces from the note.';
  end if;

  if v_body !~ 'btrim\(coalesce\(p_note' then
    raise exception '1D: cash_movement_append does not trim the note.';
  end if;

  -- ------------------------------------------------------ the three wrappers
  for v_i in 1 .. 3 loop
    v_name := 'record_' || v_types[v_i];

    select p.oid into v_fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_name;

    if v_fn is null then
      raise exception '1D: public.% was not created.', v_name;
    end if;

    -- NO CLIENT-SUPPLIED AUTHORITY, AND NO CLIENT CLOCK. The exact argument list
    -- is pinned because every omission here is a hole: a p_movement_type would
    -- defeat the role gate, a p_employee_id would let a till record money
    -- against somebody who never authorized it, and an instant would let a
    -- tampered clock file cash under another business day.
    if pg_get_function_identity_arguments(v_fn) <> c_public_args then
      raise exception '1D: public.% takes unexpected arguments: %',
        v_name, pg_get_function_identity_arguments(v_fn);
    end if;

    -- Said separately, because the exact match above would also fail for a
    -- harmless rename, and these are the rules that actually matter.
    if pg_get_function_identity_arguments(v_fn) ~* 'timestamp'
       or pg_get_function_identity_arguments(v_fn) ~* 'movement_type'
       or pg_get_function_identity_arguments(v_fn) ~* 'project_id|paired_device_id|employee_id' then
      raise exception '1D: public.% accepts authority or a clock from its caller.', v_name;
    end if;

    if not (select p.prosecdef from pg_proc p where p.oid = v_fn)
       or not exists (select 1 from pg_proc p where p.oid = v_fn
                       and p.proconfig @> array['search_path=public, pg_catalog, pg_temp']) then
      raise exception '1D: public.% needs SECURITY DEFINER and a pinned search_path.', v_name;
    end if;

    if has_function_privilege('anon', v_fn, 'EXECUTE')
       or has_function_privilege('service_role', v_fn, 'EXECUTE') then
      raise exception '1D: public.% is executable by anon or service_role.', v_name;
    end if;

    if not has_function_privilege('authenticated', v_fn, 'EXECUTE') then
      raise exception '1D: authenticated must execute public.%.', v_name;
    end if;

    -- Each wrapper hard-codes ITS OWN action, and does no work of its own.
    select regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g')
      into v_body
    from pg_proc p where p.oid = v_fn;

    if v_body !~ ('''' || v_types[v_i] || '''') then
      raise exception '1D: public.% does not hard-code its own movement type.', v_name;
    end if;

    if v_body !~ 'cash_movement_append' then
      raise exception '1D: public.% does not delegate to the shared contract.', v_name;
    end if;

    -- A wrapper that validated or derived anything of its own would be a
    -- second contract, and the two would drift.
    if v_body ~* 'insert into|auth\.uid|employee_pin_verify|business_date_of' then
      raise exception '1D: public.% does work that belongs in the shared contract.', v_name;
    end if;
  end loop;

  -- ------------------------------------------------- nothing accepted moved
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in
         ('complete_sale_v5', 'employee_login_by_code', 'end_employee_pos_session',
          'ensure_daily_register_context', 'clock_in_employee', 'clock_out_employee')) <> 6 then
    raise exception '1D: an accepted Feature 1B/1C function is missing.';
  end if;

  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('complete_sale_v5', 'ensure_daily_register_context',
                           'clock_in_employee', 'clock_out_employee')
         and p.prosrc ~ 'cash_movements') <> 0 then
    raise exception '1D: an accepted function was made aware of cash movements.';
  end if;

  raise notice '1D verified: cash_movements, one internal contract, three public actions, and nothing else moved.';
end;
$do$;
