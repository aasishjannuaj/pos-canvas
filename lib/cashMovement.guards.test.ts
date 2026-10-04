// v1.3 Feature 1D — the lines a cash movement must never cross.
//
// TWO BOUNDARIES, AND BOTH WOULD BE CROSSED BY ACCIDENT.
//
// The FINANCIAL one. Feature 1D records source events and computes nothing:
// no expected cash, no actual cash, no resulting balance, no variance, no
// over/short, no close. That is not caution for its own sake —
// register_sessions.opening_cash is 0 on every DAILY row because a CHECK
// constraint requires it to be, so any arithmetic that used it as a starting
// drawer would be confident, wrong, and believed. The crossing would arrive as
// one helpful subtraction on a confirmation screen.
//
// The AUTHORITY one. Authorizing a movement is an action, not a sign-in. It must
// not create a POS session, switch the operator, ring anybody out, or punch a
// clock — a manager approves a paid-out over a cashier's shoulder and hands the
// till straight back. That crossing would arrive as one convenient call inside a
// handler, and everything would keep passing except who was operating the till.
//
// So these guards are mostly about ABSENCE: what the cash-movement code does NOT
// contain, and what it does NOT call. They read CODE, not comments — the prose
// above and in the migration deliberately names the things that must not happen,
// and a guard matching its own explanation would pass while the code did the
// opposite.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf-8");

/** Source with comments removed: these guards are about code, not prose. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

const MIGRATION = "supabase/migrations/20260927130000_cash_movements.sql";
const CASH = "lib/cashMovement.ts";
const CASH_RPC = "lib/cashMovement.rpc.ts";
const DEVICE_APP = "components/device/DeviceApp.tsx";
const POS_GATES = "components/device/PosGates.tsx";

/** SQL with its `--` comments stripped, for the same reason. */
const sqlCode = () =>
  read(MIGRATION)
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

/**
 * The migration's CONTRACT: everything before the verification block.
 *
 * The forbidden-token scans below must not read section 7. That block's entire
 * job is to name the things this feature must never do -- it raises on
 * `expected_cash`, on `opening_cash`, on `ensure_daily_register_context` -- so a
 * scan that included it would match the migration's own assertions and report a
 * violation that is really a guard. Section 7 is checked by EXECUTING it, which
 * the .db.test.ts does, and it strips comments from prosrc for the same reason
 * these helpers strip them here.
 */
const sqlContract = () => {
  const source = sqlCode();
  const verification = source.indexOf("do $do$");

  expect(verification).toBeGreaterThan(-1);

  // Section 7 is dropped, and so is every single-quoted literal.
  //
  // Both would otherwise make these scans match their own documentation. Section
  // 7's whole job is to name what must never happen -- it raises on
  // `expected_cash`, on `opening_cash` -- and the table's `comment on` states the
  // financial boundary in prose. What is left is IDENTIFIERS AND CALLS, which is
  // what a real violation would be: a column named expected_cash, or a read of
  // opening_cash. A violation cannot hide in a string literal, because a literal
  // does not compute anything.
  //
  // Section 7 is verified by EXECUTING it, which the .db.test.ts does against a
  // real cluster, and it strips comments from prosrc for exactly this reason.
  return source
    .slice(0, verification)
    .replace(/'(?:[^']|'')*'/g, "''");
};

/** One SQL function body, isolated. */
function sqlFunction(name: string): string {
  const source = sqlCode();
  const start = source.indexOf(`create or replace function public.${name}`);
  expect(start).toBeGreaterThan(-1);

  const end = source.indexOf("$function$;", start);
  expect(end).toBeGreaterThan(start);

  return source.slice(start, end);
}

/** The cash-movement handler in DeviceApp. */
function handler(): string {
  const source = read(DEVICE_APP);
  const start = source.indexOf("const handleCashMovement = useCallback");
  expect(start).toBeGreaterThan(-1);

  const end = source.indexOf("const dismissCashMovement", start);
  expect(end).toBeGreaterThan(start);

  return stripComments(source.slice(start, end));
}

/** The panel in PosGates. It is the last component in the file. */
function panel(): string {
  const source = read(POS_GATES);
  const start = source.indexOf("export function CashMovementPanel");
  expect(start).toBeGreaterThan(-1);

  return stripComments(source.slice(start));
}

const WRAPPERS = ["record_cash_drop", "record_paid_in", "record_paid_out"] as const;

// ---------------------------------------------------------------------------
// The financial boundary
// ---------------------------------------------------------------------------

describe("Feature 1D records events and computes no drawer arithmetic", () => {
  // The structural zero. A DAILY row's opening_cash is 0 because
  // register_sessions_daily_shape REQUIRES it, so reading it as a baseline would
  // produce a confident total for money nobody counted.
  it("nothing in the feature reads opening_cash", () => {
    for (const [name, source] of [
      [MIGRATION, sqlContract()],
      [CASH, stripComments(read(CASH))],
      [CASH_RPC, stripComments(read(CASH_RPC))],
      ["the handler", handler()],
      ["the panel", panel()],
    ] as const) {
      expect(`${name} reads opening_cash`).toBe(`${name} reads opening_cash`);
      expect(source).not.toMatch(/opening_cash|openingCash/);
    }
  });

  it("no expected cash, actual cash, balance, variance or over/short exists anywhere", () => {
    const forbidden =
      /expected_?cash|expectedCash|actual_?cash|actualCash|drawer_?total|drawerTotal|resulting_?balance|over_?short|overShort|variance|reconcil|financial_?close|financialClose/i;

    for (const [name, source] of [
      [MIGRATION, sqlContract()],
      [CASH, stripComments(read(CASH))],
      [CASH_RPC, stripComments(read(CASH_RPC))],
      ["the handler", handler()],
      ["the panel", panel()],
    ] as const) {
      expect(`${name} computes drawer arithmetic`).toBe(`${name} computes drawer arithmetic`);
      expect(source).not.toMatch(forbidden);
    }
  });

  // NEGATIVE CONTROL ON THE SCHEMA. A column for a computed total is how this
  // boundary would actually be crossed: once the number is stored, something
  // will display it.
  it("the table stores no computed total and no correction state", () => {
    const table = sqlCode().slice(
      sqlCode().indexOf("create table if not exists public.cash_movements"),
      sqlCode().indexOf("comment on table public.cash_movements")
    );

    for (const banned of [
      "expected", "actual", "balance", "variance", "resulting", "reconcil",
      "void", "reversed", "reversal", "corrected", "correction", "updated_at",
    ]) {
      expect(table.toLowerCase()).not.toContain(banned);
    }
  });

  it("the panel never tells an operator what the drawer holds", () => {
    expect(panel()).not.toMatch(/should contain|drawer now|remaining|expected|balance/i);
  });
});

// ---------------------------------------------------------------------------
// Append-only
// ---------------------------------------------------------------------------

describe("a recorded movement is permanent", () => {
  it("the server only ever inserts into cash_movements", () => {
    const sql = sqlCode();

    expect(sql).toContain("insert into public.cash_movements");
    expect(sql).not.toMatch(/update public\.cash_movements|delete from public\.cash_movements/);
  });

  // No UPDATE or DELETE is granted, so append-only is an ACL fact and not a
  // convention the next writer can break.
  it("no client role is granted a mutation on the table", () => {
    const sql = sqlCode();

    expect(sql).toContain("revoke all on table public.cash_movements from authenticated");
    expect(sql).toContain("revoke all on table public.cash_movements from anon");
    expect(sql).toContain("revoke all on table public.cash_movements from service_role");
    expect(sql).not.toMatch(/grant (insert|update|delete|select)[^;]*on table public\.cash_movements/i);
  });

  // NEGATIVE CONTROL: Feature 1D invents no correction semantics, so there is no
  // reversal or void RPC to find.
  it("there is no void, reversal or correction contract", () => {
    const sql = sqlCode();

    expect(sql).not.toMatch(/function public\.(void|reverse|correct|delete|amend|adjust)_cash/i);
    expect(stripComments(read(CASH_RPC))).not.toMatch(/void|revers|correct|amend|adjust/i);
  });
});

// ---------------------------------------------------------------------------
// The server is the authority
// ---------------------------------------------------------------------------

describe("the server derives everything that matters", () => {
  it("the shared contract takes its authority from auth.uid(), not an argument", () => {
    const body = sqlFunction("cash_movement_append");

    expect(body).toContain("v_caller := auth.uid()");
    expect(body).toContain("where d.auth_user_id = v_caller");

    for (const forbidden of ["p_project_id", "p_paired_device_id", "p_employee_id"]) {
      expect(body).not.toContain(forbidden);
    }
  });

  // THE RULE THAT KEEPS A TAMPERED CLOCK OUT OF THE BOOKS. No public RPC may
  // accept an instant, and the stamp comes from the database.
  it("no function accepts a timestamp, and the stamp is the server's", () => {
    for (const fn of [...WRAPPERS, "cash_movement_append"]) {
      const body = sqlFunction(fn);
      const signature = body.slice(0, body.indexOf(")"));

      expect(signature).not.toMatch(/timestamptz|timestamp|_at\b/);
    }

    expect(sqlFunction("cash_movement_append")).toContain("clock_timestamp()");
  });

  // =========================================================================
  // ONE CLOCK DECIDES THE BUSINESS DAY, AND IT IS THE EVENT'S OWN.
  //
  // This was a real defect. The authentication clock is read before a bcrypt and
  // three lock acquisitions; deriving the business day from it while stamping
  // occurred_at later is a midnight race, and a request entering at 23:59:59
  // filed money against yesterday and dated it today. The row contradicted
  // itself, permanently, about which day the money moved.
  // =========================================================================
  it("the business day is derived from the movement instant, not the auth clock", () => {
    const body = sqlFunction("cash_movement_append");

    expect(body).toContain("business_date_of(v_occurred_at, v_timezone)");
    expect(body).not.toContain("business_date_of(v_auth_now");
    // And no third name sneaks in between them.
    expect(body.match(/business_date_of\(/g)).toHaveLength(1);
  });

  it("the movement instant is read exactly once, and stamped as read", () => {
    const body = sqlFunction("cash_movement_append");

    expect(body.match(/v_occurred_at := clock_timestamp\(\)/g)).toHaveLength(1);
    // The row carries that value, not a fresh reading taken at the insert.
    expect(body).toContain("p_movement_type, p_amount, v_note, v_occurred_at, p_request_id");
    expect(body).not.toMatch(/occurred_at\s*\)?\s*values[\s\S]{0,200}clock_timestamp/);
  });

  it("the two clocks are named apart, and the auth one only paces throttles", () => {
    const body = sqlFunction("cash_movement_append");

    // A single v_now feeding both jobs is the shape the defect had.
    expect(body).not.toMatch(/\bv_now\b/);
    expect(body).toContain("v_auth_now := clock_timestamp()");

    // v_auth_now reaches the limiters and the lockout arithmetic, and nothing else.
    for (const limiter of [
      "v_throttled_until > v_auth_now",
      "v_locked_until > v_auth_now",
      "record_device_failure(v_device.id, v_auth_now)",
    ]) {
      expect(body).toContain(limiter);
    }
  });

  // ORDER IS THE PROPERTY: the instant is taken after the credential check, the
  // active revalidation and the role gate, under the locks already held.
  it("the movement instant is captured after authorization completes", () => {
    const body = sqlFunction("cash_movement_append");
    const at = (needle: string) => {
      const i = body.indexOf(needle);
      expect(`found ${needle}`).toBe(`found ${needle}`);
      expect(i).toBeGreaterThan(-1);
      return i;
    };

    const captured = at("v_occurred_at := clock_timestamp()");

    expect(at("employee_pin_verify(p_pin")).toBeLessThan(captured);
    expect(at("not v_employee.active")).toBeLessThan(captured);
    expect(at("not in ('owner', 'manager')")).toBeLessThan(captured);
    // ...and before every decision that depends on it.
    expect(captured).toBeLessThan(at("business_date_of(v_occurred_at"));
    expect(captured).toBeLessThan(at("r.business_date = v_business_date"));
    expect(captured).toBeLessThan(at("insert into public.cash_movements"));
  });

  // THE WHOLE REASON THERE ARE THREE RPCs. A till that could name the kind of
  // financial event it was creating could ask for a "drop" and have a paid-out
  // recorded, or walk straight past the role gate.
  it("no public RPC lets a caller name the movement type", () => {
    for (const fn of WRAPPERS) {
      const signature = sqlFunction(fn);

      expect(signature.slice(0, signature.indexOf(")"))).not.toContain("p_movement_type");
    }

    // And each one hard-codes its own.
    expect(sqlFunction("record_cash_drop")).toContain("'cash_drop'");
    expect(sqlFunction("record_paid_in")).toContain("'paid_in'");
    expect(sqlFunction("record_paid_out")).toContain("'paid_out'");
  });

  it("the only function that takes a movement type is revoked from every client role", () => {
    const sql = sqlCode();
    const args = "(text, text, text, numeric, text, uuid, uuid)";

    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(sql).toContain(
        `revoke all on function public.cash_movement_append${args} from ${role}`
      );
    }

    expect(sql).not.toMatch(/grant execute on function public\.cash_movement_append/);
  });

  it("each public RPC is granted to authenticated and nobody else", () => {
    const sql = sqlCode();
    const args = "(text, text, numeric, text, uuid, uuid)";

    for (const fn of WRAPPERS) {
      for (const role of ["public", "anon", "service_role"]) {
        expect(sql).toContain(`revoke all on function public.${fn}${args} from ${role}`);
      }

      expect(sql).toContain(`grant execute on function public.${fn}${args} to authenticated`);
    }
  });

  it("every function is SECURITY DEFINER with a pinned search_path", () => {
    for (const fn of [...WRAPPERS, "cash_movement_append"]) {
      const body = sqlFunction(fn);

      expect(body).toContain("security definer");
      expect(body).toContain("set search_path = public, pg_catalog, pg_temp");
    }
  });

  it("the client sends no authority and no clock", () => {
    const rpc = stripComments(read(CASH_RPC));
    const payload = rpc.slice(rpc.indexOf("p_employee_code:"), rpc.indexOf("if (error)"));

    expect(payload).toContain("p_employee_code:");
    expect(payload).toContain("p_pin:");
    expect(payload).toContain("p_amount:");
    expect(payload).toContain("p_note:");
    expect(payload).toContain("p_expected_register_session_id:");
    expect(payload).toContain("p_request_id:");

    for (const forbidden of [
      "p_project_id", "p_paired_device_id", "p_employee_id", "p_movement_type",
      "p_occurred_at", "occurredAt:", "Date.now", "new Date",
    ]) {
      expect(payload).not.toContain(forbidden);
    }
  });

  // THE MONEY NEVER BECOMES A FLOAT ON THE WIRE. JSON.stringify(25.00) is "25",
  // so the canonical two-decimal string is what travels.
  it("the amount travels as exact text, not as a number", () => {
    const rpc = stripComments(read(CASH_RPC));

    expect(rpc).toMatch(/amount: string/);
    expect(rpc).not.toMatch(/amount: number|Number\(|parseFloat|toFixed/);
  });
});

// ---------------------------------------------------------------------------
// The DAILY contract
// ---------------------------------------------------------------------------

describe("a cash movement belongs to a business day it did not create", () => {
  // THE RULE. An unattended till must not be able to open a business day by
  // dropping cash, so the DAILY is read and never ensured.
  it("the server never opens, closes or ensures a register", () => {
    const body = sqlFunction("cash_movement_append");

    for (const forbidden of [
      "ensure_daily_register_context",
      "open_register_session",
      "close_register_session",
    ]) {
      expect(`cash_movement_append calls ${forbidden}`).toBe(
        `cash_movement_append calls ${forbidden}`
      );
      expect(body).not.toContain(forbidden);
    }

    // It only ever READS the register row, and locks it shared.
    expect(body).toContain("from public.register_sessions r");
    expect(body).toContain("for share");
    expect(body).not.toMatch(/insert into public\.register_sessions|update public\.register_sessions/);
  });

  it("the server derives the business date itself and refuses a day it cannot find", () => {
    const body = sqlFunction("cash_movement_append");

    // From the movement's own instant. Deriving it from the pre-auth clock was the
    // midnight race; see "one clock decides the business day" above.
    expect(body).toContain("public.business_date_of(v_occurred_at, v_timezone)");
    expect(body).toContain("r.business_date = v_business_date");
    expect(body).toContain("no_daily_context");
  });

  // The 23:59:59 case: the operator confirms on one business day and the server
  // commits on the next. Without this the money is filed, permanently, under the
  // wrong day.
  it("a day that changed under the request refuses the movement", () => {
    const body = sqlFunction("cash_movement_append");

    expect(body).toContain("p_expected_register_session_id");
    expect(body).toContain("daily_changed");
    expect(body).toMatch(
      /v_register\.id is distinct from p_expected_register_session_id[\s\S]{0,200}daily_changed/
    );
  });

  it("the client sends the day it last heard from the server, and does not invent one", () => {
    const source = handler();

    expect(source).toContain("gateRef.current.daily?.registerSessionId");
    expect(source).toContain("expectedRegisterSessionId");
    expect(source).toContain('cashMovementFailure("no_daily_context")');
    // It must not reach for a daily-context call to make one exist.
    expect(source).not.toMatch(/ensureDailyRegisterContext|acquireDaily|recoverDailyContext/);
  });
});

// ---------------------------------------------------------------------------
// Authorizing is not signing in
// ---------------------------------------------------------------------------

describe("authorizing a movement takes nobody's till", () => {
  it("the server touches no POS session and no Time Clock", () => {
    const body = sqlFunction("cash_movement_append");

    for (const forbidden of [
      "employee_login_by_code",
      "employee_pos_sessions",
      "end_employee_pos_session",
      "employee_logout",
      "employee_time_sessions",
      "clock_in_employee",
      "clock_out_employee",
    ]) {
      expect(`cash_movement_append touches ${forbidden}`).toBe(
        `cash_movement_append touches ${forbidden}`
      );
      expect(body).not.toContain(forbidden);
    }
  });

  it("the server touches no sale, no order and no stock", () => {
    const body = sqlFunction("cash_movement_append");

    for (const forbidden of [
      "complete_sale", "public.orders", "order_items", "inventory", "project_order_counters",
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });

  it("the server reuses the hardened credential door rather than a second one", () => {
    const body = sqlFunction("cash_movement_append");

    expect(body).toContain("employee_login_device_throttles");
    expect(body).toContain("employee_login_record_device_failure");
    expect(body).toContain("employee_login_record_employee_failure");
    expect(body).toContain("employee_pin_verify");
    // The dummy hash is what keeps an unknown or malformed code costing the same
    // time as a real one.
    expect(body).toContain("v_dummy_hash");
  });

  it("the server gives one generic answer for every credential problem", () => {
    const body = sqlFunction("cash_movement_append");

    expect(body).toContain("'error', 'invalid_credentials'");
    expect(body).not.toMatch(/employee_not_found|unknown_employee|wrong_pin|inactive_employee/);
  });

  // ROLE IS CHECKED AFTER THE PIN, ALWAYS. Refusing on role first would answer
  // "is 004 a cashier?" to anybody holding the till.
  it("the role gate is on the server, and sits after the bcrypt", () => {
    const body = sqlFunction("cash_movement_append");

    expect(body).toContain("v_employee.role not in ('owner', 'manager')");
    expect(body).toContain("not_permitted");
    expect(body.indexOf("employee_pin_verify(p_pin")).toBeLessThan(body.indexOf("not_permitted"));
  });

  it("the handler creates, switches and ends no authority at all", () => {
    const source = handler();

    for (const forbidden of [
      "lockOperatorOut", "beginEmployeeSwitch", "employeeLoginByCode", "endEmployeePosSession",
      "clockInEmployee", "clockOutEmployee", "setGate(", "setSelectedEmployee", "setGateBusy",
      "clearPosGateState", "handleTimeClock",
    ]) {
      expect(`the handler calls ${forbidden}`).toBe(`the handler calls ${forbidden}`);
      expect(source).not.toContain(forbidden);
    }
  });

  it("the handler touches no cart, no sale and no queue", () => {
    const source = handler();

    for (const forbidden of [
      "setCart", "clearCart", "completeSale", "enqueue", "queue", "IndexedDB", "idb", "cache",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  // The panel sits ABOVE whatever was on screen, so an employee-locked till stays
  // locked while a colleague authorizes a drop on it.
  it("the panel layers over the gates without replacing them", () => {
    const source = read(DEVICE_APP);

    expect(source).toContain("cashMovementOverlay ?? timeClockOverlay ?? gateOverlay ?? overlay");
    expect(source).toContain("<CashMovementPanel");
    expect(source).toContain("<EmployeeLockCard");
  });
});

// ---------------------------------------------------------------------------
// Idempotency and replay ownership
// ---------------------------------------------------------------------------

describe("a retry returns the original movement, and only to its owner", () => {
  it("the replay key is exactly (project, request) and is not widened", () => {
    const sql = sqlCode();

    expect(sql).toContain(
      "create unique index if not exists cash_movements_project_request\n  on public.cash_movements (project_id, request_id)"
    );
    // Adding employee or register_session would let one id create separate
    // financial movements for different people or different days in one shop.
    expect(sql).not.toMatch(
      /unique index[^;]*cash_movements[^;]*\((project_id, )?(employee_id|register_session_id|movement_type)/
    );
  });

  // THE FEATURE 1C LESSON, AND IT COST A CHECKPOINT. A request id identifies a
  // ROW, never a person — so the replay must prove the row belongs to this
  // employee, this business day and this action.
  it("a replay proves ownership, day and action before answering", () => {
    const body = sqlFunction("cash_movement_append");

    expect(body).toContain("v_existing.employee_id is distinct from v_employee.id");
    expect(body).toContain("v_existing.register_session_id is distinct from v_register.id");
    expect(body).toContain("v_existing.movement_type is distinct from p_movement_type");
    expect(body).toContain("'error', 'request_conflict'");
  });

  // Both the lookup and the unique-violation path must apply the same three
  // checks, or the race leaks what the ordinary path refuses.
  it("the unique-violation path re-resolves through the same checks", () => {
    const body = sqlFunction("cash_movement_append");

    expect(body).toContain("when unique_violation then");
    expect(
      body.match(/v_existing\.employee_id is distinct from v_employee\.id/g)
    ).toHaveLength(2);
    expect(
      body.match(/v_existing\.movement_type is distinct from p_movement_type/g)
    ).toHaveLength(2);
  });

  // NEGATIVE CONTROL: a conflict must reveal nothing, or a request id becomes a
  // way to read another employee's cash record.
  it("a conflict returns the code and nothing else", () => {
    const body = sqlFunction("cash_movement_append");

    for (const conflict of body.split("'request_conflict'")) {
      // Each conflict return is built from ok+error alone; no id, amount or time.
      const tail = conflict.slice(Math.max(0, conflict.length - 120));

      expect(tail).not.toMatch(/movementId|v_existing\.amount|v_existing\.occurred_at/);
    }
  });

  it("the client mints one request id per confirmed attempt, and never reuses it", () => {
    const source = handler();

    expect(source).toContain("newCashMovementRequestId()");
    expect(source).toContain("cashMovementInFlightRef.current");
    expect(stripComments(read(CASH_RPC))).toContain("crypto.randomUUID()");
  });
});

// ---------------------------------------------------------------------------
// Online only
// ---------------------------------------------------------------------------

describe("a cash movement is online only", () => {
  // The sale queue works because complete_sale_v5 owns an idempotency contract
  // that can decide which queued money is still valid. A movement has none, and
  // an offline till cannot even know which business day it belongs to.
  it("nothing in the feature queues, caches or stores a movement", () => {
    for (const [name, source] of [
      [CASH, stripComments(read(CASH))],
      [CASH_RPC, stripComments(read(CASH_RPC))],
      ["the handler", handler()],
      ["the panel", panel()],
    ] as const) {
      expect(`${name} queues a movement`).toBe(`${name} queues a movement`);
      expect(source).not.toMatch(
        /indexedDB|IDBDatabase|localStorage|sessionStorage|enqueue|pendingSale|saleQueue|outbox|retryAfterReconnect/i
      );
    }
  });

  it("a transport failure is a refusal that keeps nothing", () => {
    const rpc = stripComments(read(CASH_RPC));

    expect(rpc).toContain('cashMovementFailure(unreachedFailure(');
    expect(rpc).toContain("classifyDeviceFailure");
    // No retry loop, no scheduled resend.
    expect(rpc).not.toMatch(/setTimeout|setInterval|while \(|for \(/);
  });

  it("the offline copy does not imply the movement is waiting somewhere", () => {
    const messages = read(CASH).slice(read(CASH).indexOf("CASH_MOVEMENT_MESSAGES"));

    expect(messages).toMatch(/offline: "[^"]*connection/i);
    expect(messages).not.toMatch(/offline: "[^"]*(queued|saved|later|will send|pending)/i);
  });
});

// ---------------------------------------------------------------------------
// The review step, and what the panel does not have
// ---------------------------------------------------------------------------

describe("the review screen is the only thing between typing and a permanent record", () => {
  // These records cannot be corrected by this feature, so the cost of a mistyped
  // amount is forever and the cost of one more tap is nothing.
  it("submitting the form reaches review, not the server", () => {
    const source = panel();
    const form = source.slice(source.indexOf("onSubmit={(event)"), source.indexOf("</form>"));

    expect(form).toContain("setReviewing(true)");
    expect(form).not.toContain("onSubmit(");
  });

  it("only the explicit Confirm sends anything", () => {
    const source = panel();

    expect(source.match(/onSubmit\(type, employeeCode, pin/g)).toHaveLength(1);

    const confirm = source.slice(source.indexOf("if (reviewing"), source.indexOf("Back"));

    expect(confirm).toContain("onSubmit(type, employeeCode, pin, amount.canonical, note.note)");
    expect(confirm).toContain("Confirm");
  });

  it("cancelling or going back sends nothing", () => {
    const source = panel();

    expect(source).toContain("onClick={() => setReviewing(false)}");
    expect(source).toContain("onClick={onDismiss}");
  });

  it("the review screen shows the kind, the exact amount and the reason", () => {
    const source = panel();
    const review = source.slice(source.indexOf("if (reviewing"), source.indexOf("Back"));

    expect(review).toContain("getCashMovementLabel(type)");
    expect(review).toContain("amount.canonical");
    expect(review).toContain("note.note");
  });

  // TEXT, NOT number. A number input would hand this a float, allow `e` and a
  // sign, and strip what the operator typed.
  it("the amount is a text field validated through the money parser", () => {
    const source = panel();

    expect(source).toContain("validateCashAmount(amountText)");
    expect(source).toContain('inputMode="decimal"');
    expect(source).not.toContain('type="number"');
  });

  // No maxLength: truncating as somebody types hides that their reason was too
  // long, and the rule is that over-length is refused.
  it("the reason is never silently truncated in the UI", () => {
    const source = panel();
    const note = source.slice(source.indexOf("<textarea"), source.indexOf("</textarea>") + 11);

    expect(note).not.toContain("maxLength");
    expect(note).not.toContain("slice(");
    expect(source).toContain("validateCashNote(noteText, type)");
  });

  it("the success screen shows the SERVER's figure, name and instant", () => {
    const source = panel();
    const done = source.slice(source.indexOf("result !== null && result.ok"), source.indexOf("noDailyContext) {"));

    expect(done).toContain("result.amount");
    expect(done).toContain("result.employeeName");
    expect(done).toContain("result.occurredAt");
    // Nothing recomputed locally.
    expect(done).not.toContain("amount.canonical");
  });

  it("a till with no business day is told so, and offered nothing else", () => {
    const source = panel();

    expect(source).toContain("noDailyContext");
    expect(source).toContain('getCashMovementMessage("no_daily_context")');
  });
});

describe("one note normalization rule, shared by the function and the CHECK", () => {
  // TWO DEFECTS CAME FROM NOT HAVING THIS. Bare btrim() strips SPACES ONLY, so a
  // one-tab reason satisfied a REQUIRED note; the ASCII-only replacement still did
  // not match the client's .trim(), so an NBSP-only reason did. The rule is now one
  // IMMUTABLE function, called from both places.
  it("the rule exists once and both callers use it", () => {
    const sql = sqlCode();

    expect(sql).toContain("create or replace function public.cash_movement_trim(p_note text)");
    expect(sql).toContain("immutable");
    // The CHECK calls it rather than restating it.
    expect(sql).toContain("check (note is null\n           or (note = public.cash_movement_trim(note)");
    expect(sqlFunction("cash_movement_append")).toContain("nullif(public.cash_movement_trim(p_note), '')");
  });

  // NEGATIVE CONTROL: neither shortcut may reappear anywhere in the contract.
  // btrim() alone strips spaces only, and [[:space:]] is resolved from the
  // cluster's ctype rather than from this rule -- under en_US.UTF-8 it misses
  // U+FEFF, which .trim() removes.
  it("neither btrim() alone nor [[:space:]] is used to normalize a note", () => {
    const body = sqlFunction("cash_movement_append");

    expect(body).not.toMatch(/btrim\(/);
    expect(body).not.toContain("[[:space:]]");
    expect(body).not.toMatch(/regexp_replace\([^)]*p_note/);
  });

  it("the rule is not executable by any client role", () => {
    const sql = sqlCode();

    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(sql).toContain(`revoke all on function public.cash_movement_trim(text) from ${role}`);
    }

    expect(sql).not.toMatch(/grant execute on function public\.cash_movement_trim/);
  });

  // The client half of the same contract: one enumerated set, and .trim() is its
  // definition. The per-character agreement is proved in lib/cashMovement.test.ts
  // and in the DB suite; this only pins that the client states the set at all.
  it("the client enumerates the same set rather than trusting a shortcut", () => {
    const source = read(CASH);

    expect(source).toContain("CASH_NOTE_TRIMMED_WHITESPACE");
    expect(source).toContain("\\u00A0");
    expect(source).toContain("\\uFEFF");
    // U+200B is in neither implementation, deliberately.
    expect(stripComments(source)).not.toContain("\\u200B");
  });
});

describe("Feature 1D adds no history and no printing", () => {
  // Reading a financial table is Lane 3's contract, and it will come with its
  // own. There is no runtime SELECT path to grant here at all.
  it("there is no history RPC and no read wrapper", () => {
    const sql = sqlCode();

    expect(sql).not.toMatch(/function public\.(list|get|fetch|read)_cash_movements/i);
    expect(stripComments(read(CASH_RPC))).not.toMatch(/\.from\(|select\(|list|history/i);
  });

  it("no client role may even read the table", () => {
    const sql = sqlCode();

    expect(sql).toContain("alter table public.cash_movements enable row level security");
    expect(sql).not.toMatch(/create policy[^;]*cash_movements/i);
    expect(sql).toContain("revoke all on table public.cash_movements from authenticated");
  });

  /**
   * NARROWED BY RC-POLISH, and the invariant it protects is unchanged.
   *
   * Feature 1D guaranteed "a print failure cannot influence whether the
   * financial event exists" the simplest possible way: by never printing. The
   * Cash Drop now prints two slips, so the guarantee has to come from WHERE the
   * printing happens instead — strictly downstream of the server's answer, in a
   * fire-and-forget effect that inspects nothing and can reach no authority
   * verb. That is asserted in detail by "printing the Cash Drop is downstream
   * of authority" at the end of this file.
   *
   * What stays absolutely true here: the AUTHORITY PATH still never prints. The
   * host's submit handler and the RPC client remain unaware that a printer
   * exists, so nothing between "send the movement" and "the server answered"
   * can be affected by paper.
   */
  it("the authority path still never prints", () => {
    for (const source of [handler(), stripComments(read(CASH_RPC))]) {
      expect(source).not.toMatch(/window\.print|printReceipt|Printer|bluetooth/i);
    }
  });

  it("the panel prints nothing except the downstream Cash Drop slips", () => {
    const source = panel();

    // No printer hardware, no native bridge, no second print surface.
    expect(source).not.toMatch(/printReceipt|Printer|bluetooth/i);
    // Exactly one print call, and it is the browser's.
    expect([...source.matchAll(/window\.print\(\)/g)]).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The rest of the product is unaware
// ---------------------------------------------------------------------------

describe("nothing outside the device host learned about cash movements", () => {
  const walk = (dir: string): string[] => {
    const out: string[] = [];

    for (const entry of readdirSync(join(repoRoot, dir))) {
      const child = join(dir, entry);

      if (statSync(join(repoRoot, child)).isDirectory()) out.push(...walk(child));
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(child);
    }

    return out;
  };

  // The owner's editor and the browser v3 runtime are a different product
  // surface. A cash movement is a till action, authorized at a till by an
  // employee with a PIN; there is no version of it that belongs in a preview.
  it("owner and browser v3 gained nothing", () => {
    for (const file of [...walk("components/runtime"), ...walk("components/editor/pos-layouts")]) {
      const source = stripComments(read(file));

      for (const banned of [
        "cashMovement", "CashMovement", "record_cash_drop", "record_paid_in", "record_paid_out",
      ]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  // ONE IMPLEMENTATION, THREE TARGETS. Android and Windows package the same
  // native-device entry that the hosted /device route renders, so a cash movement
  // behaves identically on all three by construction rather than by three
  // separate code paths kept in step by hand.
  it("Android, Windows and the hosted route still mount the same DeviceApp", () => {
    for (const entry of ["native-device/main.tsx", "app/device/page.tsx"]) {
      const source = read(entry);

      expect(source).toContain('from "@/components/device/DeviceApp"');
      // The panel lives in DeviceApp's own tree, so no entry point wires it up --
      // and none may, or the three targets would start to differ.
      expect(stripComments(source)).not.toContain("CashMovement");
    }

    // And the panel is reached from the shared host, not from a platform shim.
    expect(read(DEVICE_APP)).toContain("<CashMovementPanel");
  });
});

// ---------------------------------------------------------------------------
// v1.3 RC-polish — the Cash Drop slips are a side effect, not a record
//
// Everything below is about keeping printing OUT of the authority path. The
// ledger is settled before a printer is mentioned, and nothing on a paper
// failure can reach back into it.
// ---------------------------------------------------------------------------

describe("printing the Cash Drop is downstream of authority", () => {
  const gates = stripComments(read(POS_GATES));
  const deviceApp = stripComments(read(DEVICE_APP));

  const printEffect = (() => {
    const at = gates.indexOf("useEffect(");

    expect(at, "the print effect moved or was removed").toBeGreaterThan(-1);

    return gates.slice(at, gates.indexOf("}, [result]);", at));
  })();

  it("prints only an authoritative success", () => {
    // The movement exists before a printer is named: `result.ok` is the
    // server's answer, not a local assumption.
    expect(printEffect).toContain("result === null || !result.ok");
    expect(printEffect.indexOf("!result.ok")).toBeLessThan(printEffect.indexOf("window.print()"));
  });

  it("prints for cash_drop and refuses the other two kinds", () => {
    expect(printEffect).toContain('result.movementType !== "cash_drop"');
    expect(printEffect.indexOf('movementType !== "cash_drop"')).toBeLessThan(
      printEffect.indexOf("window.print()")
    );

    // PAID IN AND PAID OUT NEVER AUTO-PRINT. Asserted as the absence of any
    // other branch that could reach the printer, not just as the presence of
    // the cash_drop check above.
    for (const other of ["paid_in", "paid_out"]) {
      expect(`${other} cannot reach the printer`).toBe(`${other} cannot reach the printer`);
      expect(printEffect).not.toContain(other);
    }
  });

  it("calls window.print() exactly once, from exactly one place", () => {
    // Two slips in ONE job. A second call would be a second job, and would
    // also be a second dialog the cashier has to dismiss.
    expect([...gates.matchAll(/window\.print\(\)/g)]).toHaveLength(1);
    expect([...printEffect.matchAll(/window\.print\(\)/g)]).toHaveLength(1);
    // Not a copy count: nothing asks the driver for N copies, because the web
    // platform cannot.
    for (const banned of ["copies", "copyCount", "numCopies"]) {
      expect(`${banned} is absent`).toBe(`${banned} is absent`);
      expect(gates).not.toContain(banned);
    }
  });

  it("prints once per MOVEMENT, not once per render", () => {
    // React may render this panel repeatedly holding the same result.
    expect(gates).toContain("const printedMovementIdRef = useRef<string | null>(null);");
    expect(printEffect).toContain("printedMovementIdRef.current === result.movementId");
    expect(printEffect.indexOf("printedMovementIdRef.current = result.movementId")).toBeLessThan(
      printEffect.indexOf("window.print()")
    );
  });

  it("is fire-and-forget: the outcome is never inspected or awaited", () => {
    for (const banned of [
      "await window.print",
      "window.print().then",
      "catch",
      "printFailed",
      "printError",
      "printSucceeded",
    ]) {
      expect(`${banned} is absent from the print effect`).toBe(
        `${banned} is absent from the print effect`
      );
      expect(printEffect).not.toContain(banned);
    }
  });

  it("cannot reverse, retry or duplicate the movement", () => {
    // None of the authority verbs is even reachable from this component.
    for (const banned of [
      "recordCashMovement",
      "newCashMovementRequestId",
      "requestId",
      "reverse",
      "rollback",
      "void(",
      "delete",
    ]) {
      expect(`${banned} is absent from PosGates`).toBe(`${banned} is absent from PosGates`);
      expect(gates).not.toContain(banned);
    }
  });

  it("writes no second ledger and persists nothing", () => {
    for (const banned of [
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "IndexedDB",
      "fetch(",
      "supabase",
      "insert",
    ]) {
      expect(`${banned} is absent from PosGates`).toBe(`${banned} is absent from PosGates`);
      expect(gates).not.toContain(banned);
    }
  });

  it("leaves the authoritative submit path exactly as it was", () => {
    // Still ONE request, with ONE fresh id, from the host — unchanged by this
    // checkpoint, and still nowhere near the printer.
    expect([...deviceApp.matchAll(/recordCashMovement\(/g)]).toHaveLength(1);
    expect([...deviceApp.matchAll(/newCashMovementRequestId\(\)/g)]).toHaveLength(1);
    expect(deviceApp).toContain("cashMovementInFlightRef.current");
    // The host knows nothing about printing.
    expect(deviceApp).not.toContain("window.print()");
  });

  it("introduces no native print path", () => {
    // Android native printing stays out of scope, and no Electron bridge is
    // invented: the slip prints through the browser or not at all.
    for (const banned of [
      "isCapacitorNativeShell",
      "Capacitor",
      "posCanvasShell",
      "ipcRenderer",
      "webContents",
      "printer",
      "Printer",
    ]) {
      expect(`${banned} is absent from PosGates`).toBe(`${banned} is absent from PosGates`);
      expect(gates).not.toContain(banned);
    }
  });

  it("puts only server-returned fields on the slip", () => {
    for (const field of [
      "result.amount",
      "result.note",
      "result.employeeName",
      "result.occurredAt",
      "result.movementId",
    ]) {
      expect(`${field} appears on the slip`).toBe(`${field} appears on the slip`);
      expect(gates).toContain(field);
    }

    expect(gates).toContain("Employee Signature: __________________");

    // NOTHING SENSITIVE, AND NO ARITHMETIC. A slip that travels with cash must
    // not carry a credential, and Feature 1D records events rather than
    // balances.
    // Bounded to the print area itself: the rest of the panel legitimately
    // contains PIN entry, and slicing to end-of-file would read it.
    const slipStart = gates.indexOf("cash-drop-print-area");
    const slipEnd = gates.indexOf("if (noDailyContext)", slipStart);

    expect(slipStart).toBeGreaterThan(-1);
    expect(slipEnd).toBeGreaterThan(slipStart);

    const slip = gates.slice(slipStart, slipEnd);

    for (const banned of [
      "pin",
      "Pin",
      "PIN",
      "hash",
      "Expected Cash",
      "expectedCash",
      "balance",
      "Balance",
      "over/short",
      "employeeCode",
    ]) {
      expect(`${banned} is absent from the slip`).toBe(`${banned} is absent from the slip`);
      expect(slip).not.toContain(banned);
    }
  });
});
