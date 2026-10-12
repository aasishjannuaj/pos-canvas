# POS Canvas — v1.3.0 production migration runbook

> **STATUS: DOCUMENTATION ONLY. NOTHING IN THIS FILE HAS BEEN APPLIED.**
>
> v1.3.0 is a **release candidate**. It is **not released**. Production has
> **not** been contacted during its preparation, and no migration below has been
> applied to production or to staging as part of writing this runbook.

This runbook covers the 15 migrations that take production from the v1.2.0
baseline to the v1.3.0 schema. It is written against the migration files as they
exist in the tree, and every claim below was read out of those files rather than
recalled.

---

## 1. Expected production starting state

| Fact | Expected value |
|---|---|
| Total migrations in the v1.3.0 tree | **36** |
| v1.2.0 baseline migrations, already applied to production | **21** |
| v1.3.0 migrations to apply | **15** |
| Released product in production | **v1.2.0** |
| Employee tables (`employees`, `employee_pos_sessions`, …) | **absent** — every one is created by this release |
| `register_sessions`, `employee_time_sessions`, `cash_movements` | **absent** — created by this release |
| `orders.employee_id` / `paired_device_id` / `register_session_id` | **absent** |
| `projects.business_timezone` | **absent** |
| `paired_devices.cash_drawer_enabled` | **absent** |
| Highest checkout RPC in production | `complete_sale_v4` |

**If production does not match this, STOP.** In particular, if any employee
table already exists, production is not at the assumed baseline and this runbook
does not describe it.

Confirm the baseline before doing anything else:

```sql
-- Expect 21 rows, and none of the 15 filenames in §3.
select name from supabase_migrations.schema_migrations order by version;
```

---

## 2. Preflight checks

Run all of these **before** the first migration. Every one is read-only.

```sql
-- 1. pgcrypto must be available: migration 1 requires it for bcrypt PIN hashing.
select extname from pg_extension where extname = 'pgcrypto';

-- 2. The tables this release creates must not already exist.
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'employees', 'employee_pos_sessions', 'employee_login_attempts',
    'employee_login_device_failures', 'employee_login_device_throttles',
    'employee_login_employee_attempts', 'register_sessions',
    'employee_time_sessions', 'cash_movements'
  );
-- Expect zero rows.

-- 3. The columns this release adds must not already exist.
select table_name, column_name from information_schema.columns
where table_schema = 'public'
  and (
    (table_name = 'orders' and column_name in ('employee_id','paired_device_id','register_session_id'))
    or (table_name = 'projects' and column_name = 'business_timezone')
    or (table_name = 'paired_devices' and column_name = 'cash_drawer_enabled')
  );
-- Expect zero rows.

-- 4. Record the pre-migration row counts you will re-check at the end.
select
  (select count(*) from public.orders)          as orders,
  (select count(*) from public.projects)        as projects,
  (select count(*) from public.paired_devices)  as paired_devices;

-- 5. Record which checkout RPCs exist, so the v5 cutover is observable.
select proname from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and proname like 'complete_sale_v%'
order by proname;

-- 6. MIGRATION 15 PREREQUISITE — the exact eight-argument signature.
--
-- Run this AGAIN immediately before migration 15, not only here: 15 is a
-- `create or replace`, and `create or replace` only replaces in place while the
-- argument list is identical. A changed default or a reordered parameter leaves
-- the old function standing beside the new one and PostgreSQL chooses between
-- them by overload resolution.
select count(*) as definitions from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'complete_sale_v5';
-- Expect exactly 1.

select pg_get_function_identity_arguments(p.oid) as signature,
       p.prosecdef                               as security_definer,
       array_to_string(p.proconfig, ',')          as settings
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'complete_sale_v5';
-- Expect exactly one row:
--   signature        = p_payment_method text, p_tip_amount numeric,
--                      p_items jsonb, p_sale_request_id uuid,
--                      p_occurred_at timestamp with time zone, p_source text,
--                      p_employee_pos_session_id uuid,
--                      p_register_session_id uuid
--   security_definer = t
--   settings         = search_path=public, pg_temp

-- 7. MIGRATION 15 PREREQUISITE — the predecessor ACL it inherits.
--
-- Migration 15 restates the revokes from `public` and `anon` but NOT from
-- `service_role`. That is safe ONLY because migrations 4 and 8 already revoked
-- it and `create or replace` preserves an existing ACL. Confirm it is already
-- revoked BEFORE applying 15.
select r.rolname,
       has_function_privilege(r.rolname,
         'public.complete_sale_v5(text,numeric,jsonb,uuid,timestamptz,text,uuid,uuid)',
         'EXECUTE') as may_execute
from (values ('public'),('anon'),('authenticated'),('service_role')) as r(rolname);
-- Expect `authenticated` = true and public, anon, service_role = false.
```

Operational preflight:

- [ ] A fresh, **verified** production database backup / PITR window exists, and
      its restore path has been confirmed — see §7, which is the only real
      recovery mechanism for most of this release.
- [ ] Release freeze is in effect.
- [ ] The migrations are applied **scoped to the production project**, never via
      an unscoped `supabase db push`.
- [ ] Migrations lead the client. Do **not** deploy the v1.3 web app or publish
      v1.3.0 native artifacts until §6 passes.

---

## 3. The 15 migrations, in order

Apply in exactly this order. The order is not cosmetic — see the dependency
column.

**Apply strictly in timestamp order.** Every file name begins with a
fixed-width timestamp, so lexicographic order IS chronological order: no
file may be applied before any file that sorts earlier than it. Migration 15
makes this a safety requirement rather than a convention — see §7.

| # | File | What it does | Depends on |
|---|---|---|---|
| 1 | `20260914120000_employee_identity_and_pos_sessions.sql` | `create extension pgcrypto`; creates `employees`, `employee_pos_sessions`, `employee_login_attempts` | v1.2 baseline (`projects`, `paired_devices`) |
| 2 | `20260916120000_employee_selector_single_hash_login.sql` | Replaces the login model: creates `employee_login_device_failures`, `employee_login_device_throttles`, `employee_login_employee_attempts`; **drops** `employee_login_attempts`, `employee_login(text)`, `employee_login_note_failure(uuid, timestamptz)`, `employee_project_pin_taken(uuid, text, uuid)` | 1 |
| 3 | `20260916130000_remove_active_employee_engineering_ceiling.sql` | Redefines `create_employee` and `set_employee_active` to drop the active-employee ceiling | 1, 2 |
| 4 | `20260917120000_register_sessions_and_sale_attribution.sql` | Creates `register_sessions`; adds `orders.employee_id`, `orders.paired_device_id`, `orders.register_session_id`; **creates `complete_sale_v5`** | 1, 2, 3 |
| 5 | `20260919120000_employee_code_and_four_digit_pin.sql` | Adds the Employee ID / 4-digit PIN model to `employees`; **drops** `create_employee(uuid, text, text, text)` (signature change) | 1, 3 |
| 6 | `20260920120000_project_business_timezone.sql` | Adds `projects.business_timezone` + trigger | v1.2 `projects` |
| 7 | `20260921120000_daily_register_context.sql` | Adds the DAILY business-date context to `register_sessions` | 4, 6 |
| 8 | `20260922120000_daily_sale_attribution.sql` | **Redefines `complete_sale_v5`** to attribute sales to the DAILY register context | 4, 7 |
| 9 | `20260926120000_employee_session_safe_termination.sql` | Safe POS-session termination functions | 1, 4 |
| 10 | `20260927120000_employee_time_clock.sql` | Creates `employee_time_sessions` (Time Clock) | 1, 6 |
| 11 | `20260927130000_cash_movements.sql` | Creates `cash_movements`; adds `cash_movement_trim` and the Cash Drop / Paid In / Paid Out RPCs | 1, 4, 7 |
| 12 | `20260928120000_owner_reporting_contracts.sql` | Owner reporting RPCs (Sales, Sales by Employee, Employee Time, Cash Activity) | 4, 8, 10, 11 |
| 13 | `20260929120000_list_employees_employee_code.sql` | Redefines `list_employees` to return the Employee ID | 5 |
| 14 | `20261002120000_device_cash_drawer_enablement.sql` | Adds `paired_devices.cash_drawer_enabled` (`not null default false`) + `set_device_cash_drawer_enabled` | v1.2 `paired_devices` |
| 15 | `20261012120000_offline_register_attribution_required.sql` | **Redefines `complete_sale_v5`** again: a new `offline_queued` sale must carry its ORIGINAL register session. The claim is validated by its own identity instead of being re-derived, and an unprovable claim now raises instead of committing with NULL attribution. Forward-only: no backfill, no data change, no historical order touched | 4, 8 |

### Order-critical pairs

- **4 before 8.** `complete_sale_v5` is created by 4 and redefined by 8. Running
  8 first leaves the checkout RPC at the wrong definition.
- **1 before 2.** 2 drops a table 1 creates and replaces the login functions 1
  installs.
- **4, 7 before 11 and 12.** Cash Movements and the reporting contracts both
  read the DAILY register context.
- **5 before 13.** `list_employees` returns a column 5 adds.
- **4 and 8 before 15.** 15 is a `create or replace` of `complete_sale_v5`, not
  a `create`. It restates the revokes from `public` and `anon` but **not** from
  `service_role`, which 4 and 8 both do, and relies on `create or replace`
  preserving the ACL they left. Applied where the function does not already
  exist it would CREATE it, and under Supabase's default privileges on `public`
  the new function is born executable by `anon`, `authenticated` AND
  `service_role` — so `service_role` would silently keep `EXECUTE` on the
  checkout RPC. §2.6 and §2.7 verify both prerequisites; §7 stops the release
  if either does not hold.

---

## 4. Notable risks

**Low-risk by construction, with four things worth watching.**

1. **No table or column belonging to v1.2 is dropped.** Every `drop` in this
   release removes an object that this same release created (migration 2's
   `employee_login_attempts`), or a function whose signature changed
   (migrations 2, 5), or an in-migration verification scaffold that the
   migration creates and drops itself (the `cp2b_*`/`cp2c_*` baseline tables in
   migrations 7 and 8). **No customer data is destroyed.**
2. **Migration 2's table drop is harmless *only* from the assumed baseline.**
   `employee_login_attempts` exists for the duration of migrations 1→2 and holds
   nothing, because production has no employees yet. If employees have already
   been created between 1 and 2, **STOP** — the drop would discard real login
   history.
3. **Every added column is nullable or `not null default`**, so all five are
   metadata-only in PostgreSQL 11+ and take no table rewrite:
   `orders.employee_id`, `orders.paired_device_id`,
   `orders.register_session_id`, `projects.business_timezone` (nullable),
   `paired_devices.cash_drawer_enabled` (`not null default false`). Existing
   orders stay `NULL` on the three attribution columns: **attribution is
   forward-only and existing v1.2 sales are not backfilled.** Reports covering
   pre-v1.3 dates will show those sales as unattributed, which is truthful.
4. **The checkout RPC changes.** `complete_sale_v5` arrives in migration 4. A
   v1.2 client keeps calling `complete_sale_v4`, which is left in place, so
   tills continue selling throughout. This is why migrations lead the client and
   not the reverse.

`paired_devices.cash_drawer_enabled` defaults to **`false`**, so no production
device gains any drawer capability from this release. See §8.

---

## 5. Verification after each meaningful group

Stop at each checkpoint and run its checks before continuing.

### Group A — employee identity (migrations 1–3, 5)

```sql
select table_name from information_schema.tables
where table_schema='public' and table_name in
  ('employees','employee_pos_sessions','employee_login_device_failures',
   'employee_login_device_throttles','employee_login_employee_attempts');
-- Expect 5 rows.

-- The replaced login model is gone, not duplicated.
select table_name from information_schema.tables
where table_schema='public' and table_name='employee_login_attempts';
-- Expect zero rows.

-- Zero-grant / zero-policy RLS: assert EFFECTIVE privilege, not the grant list.
select has_table_privilege('anon','public.employees','select') as anon_select,
       has_table_privilege('authenticated','public.employees','select') as auth_select;
-- Expect false, false.
```

### Group B — register sessions, DAILY and attribution (4, 6, 7, 8)

```sql
select column_name from information_schema.columns
where table_schema='public' and table_name='orders'
  and column_name in ('employee_id','paired_device_id','register_session_id');
-- Expect 3 rows.

select column_name from information_schema.columns
where table_schema='public' and table_name='projects' and column_name='business_timezone';
-- Expect 1 row.

select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and proname like 'complete_sale_v%' order by proname;
-- Expect v5 present; v3/v4 still present and untouched.

-- Existing sales were not rewritten.
select count(*) as orders_total,
       count(employee_id) as attributed
from public.orders;
-- orders_total must equal the preflight count; attributed must be 0.
```

### Group C — Time Clock and Cash Movements (9, 10, 11)

```sql
select table_name from information_schema.tables
where table_schema='public' and table_name in ('employee_time_sessions','cash_movements');
-- Expect 2 rows.

select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public'
  and proname in ('record_cash_drop','record_paid_in','record_paid_out','cash_movement_trim')
order by proname;
-- Expect 4 rows.

select count(*) from public.cash_movements;
-- Expect 0.
```

### Group D — owner reporting and device config (12, 13, 14)

```sql
select column_name, is_nullable, column_default from information_schema.columns
where table_schema='public' and table_name='paired_devices' and column_name='cash_drawer_enabled';
-- Expect: not nullable, default false.

select count(*) as devices, count(*) filter (where cash_drawer_enabled) as drawer_on
from public.paired_devices;
-- drawer_on MUST be 0.

select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and proname='set_device_cash_drawer_enabled';
-- Expect 1 row.
```

### Group E — offline register attribution (migration 15)

Its own group, because it is the only migration in this release that changes
how a sale is accepted or refused, and because every check below must hold
AFTER the replacement exactly as §2.6 and §2.7 required it BEFORE.

```sql
-- Still exactly ONE definition, with the same signature: a changed argument
-- list would have left an overload behind rather than replacing in place.
select count(*) as definitions,
       pg_get_function_identity_arguments(p.oid) as signature,
       p.prosecdef as security_definer,
       array_to_string(p.proconfig, ',') as settings
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'complete_sale_v5'
group by 2, 3, 4;
-- Expect ONE row: definitions = 1, the §2.6 signature, security_definer = t,
-- settings = search_path=public, pg_temp.

-- The ACL survived the replacement. 15 does not restate the `service_role`
-- revoke, so this is the check that proves the inherited ACL is still intact.
select r.rolname,
       has_function_privilege(r.rolname,
         'public.complete_sale_v5(text,numeric,jsonb,uuid,timestamptz,text,uuid,uuid)',
         'EXECUTE') as may_execute
from (values ('public'),('anon'),('authenticated'),('service_role')) as r(rolname);
-- Expect `authenticated` = true and public, anon, service_role = false.
-- If `service_role` reads true, STOP: see §7.

-- Nothing historical was rewritten. 15 is forward-only with no backfill.
select count(*) as orders_with_null_register
from public.orders where register_session_id is null;
-- Expect the SAME number as before migration 15. The guard applies only to
-- NEW offline sales; existing rows are deliberately untouched.

-- And the predecessor RPCs a v1.2 client still calls are intact.
select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname='public' and proname in ('complete_sale_v3','complete_sale_v4')
order by proname;
-- Expect both rows.
```

The behavioural check belongs in the application, not here: a till with an
unprovable register claim must receive `A register session is required for an
offline sale` and the sale must land in the owner review queue rather than
committing. `supabase/migrations/20261012120000_offline_register_attribution_required.db.test.ts`
executes that end to end against a real PostgreSQL and is the authority for it.

---

## 6. Final verification

```sql
-- 1. All 36 migrations recorded.
select count(*) from supabase_migrations.schema_migrations;
-- Expect 36.

-- 2. All 15 of this release recorded, exactly once each.
select name, count(*) from supabase_migrations.schema_migrations
where name like '202609%' or name like '202610%'
group by name having count(*) <> 1;
-- Expect zero rows.

-- 3. Row counts for pre-existing tables are unchanged from preflight step 4.

-- 4. No function was left SECURITY DEFINER with a permissive search_path.
select p.proname, p.proconfig
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef
  and (p.proconfig is null or not exists (
    select 1 from unnest(p.proconfig) c where c like 'search_path=%'
  ));
-- Expect zero rows.

-- 5. No drawer is enabled anywhere.
select count(*) from public.paired_devices where cash_drawer_enabled;
-- Expect 0.
```

Then, and only then:

- [ ] Deploy the v1.3 web app.
- [ ] Owner smoke test against production: create an employee, sign in with the
      4-digit PIN, open a register session, record a sale, Ring Out, confirm
      Auto-Lock, record a Cash Movement, read each owner report.
- [ ] Only after that, build / publish / verify the v1.3.0 native artifacts and
      move the release pointers (`lib/androidRelease.ts`,
      `lib/windowsRelease.ts`) — see §10 step 8 of `RELEASE_CHECKLIST.md`.

---

## 7. STOP conditions

Stop immediately, apply nothing further, and escalate if **any** of these occur:

- The starting state in §1 does not match, or a preflight query returns
  unexpected rows.
- `pgcrypto` is unavailable.
- Any migration errors, or a migration is recorded twice.
- Employee rows exist before migration 2 is applied (see §4.2).
- `orders` row count changes at any checkpoint.
- Any `complete_sale_v3` or `complete_sale_v4` function disappears.
- Any `anon` or `authenticated` effective privilege appears on a new table.
- `cash_drawer_enabled` is `true` for any device.
- Anything suggests you are connected to a project other than production.
- **Migration 15 prerequisites do not hold.** Before applying
  `20261012120000_offline_register_attribution_required.sql`, §2.6 must report
  exactly ONE `complete_sale_v5` with the exact eight-argument signature,
  `security_definer = t` and `search_path=public, pg_temp`, and §2.7 must report
  `authenticated` alone holding `EXECUTE`. If the function is absent,
  duplicated, differently shaped, or if `service_role` still holds `EXECUTE`,
  **STOP and apply nothing further.** 15 would then either create a second
  overload or create the function outright and leave `service_role` executing
  the checkout RPC, because 15 does not restate that revoke itself.
- Any migration is applied out of timestamp order (§3).

**Do not improvise a fix mid-release.** Stop, record the exact state, and
decide the recovery route deliberately.

---

## 8. Cash Drawer release condition

This release contains Cash Drawer **software** checkpoints 1A, 1B, 1C and 1D
only.

- **Physical, end-to-end Cash Drawer validation: NOT YET COMPLETED.** Checkpoint
  1E has not been performed; 1E-PREP is paused.
- `cash_drawer_enabled` is `false` for every device and is written only by
  `set_device_cash_drawer_enabled`, an owner action.
- Nothing in v1.3 may be described as production-proven, physically validated,
  or release-proven hardware support.

Do not enable a drawer on a production device as part of this migration.

---

## 9. Recovery considerations

**Read this before starting, not after.**

**This release is forward-only.** There is no down-migration, and this runbook
deliberately contains **no rollback SQL**. Writing inverse DDL here would be
fabrication: the hand-written inverse of migration 2 alone would have to
re-create a table the release intentionally replaced, and an inverse of
migrations 4 and 8 would have to restore a prior `complete_sale_v5` body that
does not exist in any file.

What is actually supported:

| Situation | Real recovery route |
|---|---|
| A migration fails partway | Each file is a single transaction where PostgreSQL permits it. Re-check state with §5, fix the cause, re-apply only the failed file. Do **not** hand-edit an applied migration. |
| The release must be abandoned after partial application | **Restore from backup / PITR.** This is the only complete route. There is no inverse SQL. |
| The release must be abandoned after full application | **Restore from backup / PITR**, or leave the schema in place and roll the *client* back. The new objects are additive and inert to a v1.2 client: it calls `complete_sale_v4`, which this release leaves untouched, and the new tables are simply unused. This is usually preferable to a restore. |
| Drawer behaviour is wrong | No schema change needed: `cash_drawer_enabled` is already `false`. |

Because a restore is the only true rollback for the destructive steps, **the
verified backup in §2 is a hard prerequisite, not a formality.**

---

## 10. What this runbook does not cover

Deferred to v1.4 or later, and absent from v1.3.0 — do not look for them here:

- Financial Close / Register Reconciliation → **v1.4**
- Refund / Void / Post-Sale Correction → **v1.4**
- Extended discounts → v1.4
- Time Clock auditable correction → v1.4
- Cash Drop threshold → v1.4
- Android native receipt printing → v1.4 or later
- Centralized entitlement expansion → v1.4
- Vendor / PO / advanced purchasing → not currently scheduled
