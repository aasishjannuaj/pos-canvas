// v1.3 Feature 1C — the lines the Time Clock must never cross.
//
// The whole value of this feature is that three things stay apart: who is
// operating the till, which business day the money belongs to, and when a
// person was at work. Couple any two and an ordinary day becomes unrecordable
// — a cashier hands over the register and keeps working; a shift ends while the
// till stays open for the next person.
//
// The coupling would not announce itself. It would arrive as one convenient
// call inside a handler, and everything would keep passing except the hours.
// So these guards are about absence: what the Time Clock code does NOT contain,
// and what the POS paths do NOT call.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf-8");

/** Source with comments removed: these guards are about code, not prose. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

const MIGRATION = "supabase/migrations/20260927120000_employee_time_clock.sql";
const TIME_CLOCK = "lib/timeClock.ts";
const TIME_CLOCK_RPC = "lib/timeClock.rpc.ts";
const DEVICE_APP = "components/device/DeviceApp.tsx";
const POS_GATES = "components/device/PosGates.tsx";

/** SQL with its `--` comments stripped, for the same reason. */
const sqlCode = () =>
  read(MIGRATION)
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

/** One SQL function body, isolated. */
function sqlFunction(name: string): string {
  const source = sqlCode();
  const start = source.indexOf(`create or replace function public.${name}`);
  expect(start).toBeGreaterThan(-1);

  const end = source.indexOf("$function$;", start);
  expect(end).toBeGreaterThan(start);

  return source.slice(start, end);
}

/** The Time Clock handler in DeviceApp. */
function handler(): string {
  const source = read(DEVICE_APP);
  const start = source.indexOf("const handleTimeClock = useCallback");
  expect(start).toBeGreaterThan(-1);

  const end = source.indexOf("const dismissTimeClock", start);
  expect(end).toBeGreaterThan(start);

  return stripComments(source.slice(start, end));
}

// ---------------------------------------------------------------------------
// The server touches nothing that belongs to Feature 1B
// ---------------------------------------------------------------------------

describe("the Time Clock functions stay in their own lane", () => {
  for (const fn of ["clock_in_employee", "clock_out_employee"]) {
    it(`${fn} never reads or writes a POS session or a register`, () => {
      const body = sqlFunction(fn);

      for (const forbidden of [
        "employee_pos_sessions",
        "register_sessions",
        "orders",
        "order_items",
        "inventory_transactions",
        "project_order_counters",
      ]) {
        expect(`${fn}: ${forbidden}`).toBe(`${fn}: ${forbidden}`);
        expect(body).not.toContain(forbidden);
      }
    });

    // NEGATIVE CONTROL, AND THE POINT OF THE WHOLE FEATURE. If either function
    // ever accepted a timestamp, a till with a wrong clock — or an operator who
    // set it — could move somebody's recorded hours.
    it(`${fn} accepts no timestamp from the client`, () => {
      const body = sqlFunction(fn);
      const signature = body.slice(0, body.indexOf(")"));

      expect(signature).not.toMatch(/timestamptz|timestamp|_at\b/);
      expect(body).toContain("clock_timestamp()");
    });

    it(`${fn} derives its authority from auth.uid(), not from an argument`, () => {
      const body = sqlFunction(fn);

      expect(body).toContain("v_caller := auth.uid()");
      expect(body).toContain("where d.auth_user_id = v_caller");

      for (const forbidden of ["p_project_id", "p_paired_device_id", "p_employee_id"]) {
        expect(body).not.toContain(forbidden);
      }
    });

    it(`${fn} reuses the existing throttle and bcrypt path`, () => {
      const body = sqlFunction(fn);

      expect(body).toContain("employee_login_device_throttles");
      expect(body).toContain("employee_login_record_device_failure");
      expect(body).toContain("employee_login_record_employee_failure");
      expect(body).toContain("employee_pin_verify");
      // The dummy hash is what keeps a malformed or unknown code costing the
      // same time as a real one.
      expect(body).toContain("v_dummy_hash");
    });

    it(`${fn} gives one generic answer for every credential problem`, () => {
      const body = sqlFunction(fn);

      expect(body).toContain("v_generic_failure");
      // The lookup itself requires `active`, so a deactivated employee is
      // simply not found — indistinguishable from an unknown id.
      expect(body).toContain("and e.active");

      for (const leak of ["employee_not_found", "wrong_pin", "inactive_employee", "no_such_employee"]) {
        expect(body).not.toContain(leak);
      }
    });

    it(`${fn} takes the device FOR SHARE, then the employee FOR UPDATE`, () => {
      const body = sqlFunction(fn);

      const device = body.indexOf("from public.paired_devices d");
      const employee = body.indexOf("from public.employees e\n  where e.id = v_employee.id");

      expect(device).toBeGreaterThan(-1);
      expect(employee).toBeGreaterThan(device);
      expect(body.slice(device, device + 400)).toContain("for share");
      expect(body.slice(employee)).toContain("for update");
    });

    it(`${fn} revalidates the employee AFTER taking the lock`, () => {
      const body = sqlFunction(fn);
      const lock = body.indexOf("for update");

      // A deactivation that committed while the bcrypt ran must win.
      expect(body.slice(lock)).toContain("not v_employee.active");
    });
  }

  it("a replay proves the row belongs to the caller before returning it", () => {
    // A request id is unique per business, so it identifies a row -- but not
    // whose. Matching on it alone would hand the next employee to authenticate
    // somebody else's session id and punch times as their own success.
    for (const fn of ["clock_in_employee", "clock_out_employee"]) {
      const body = sqlFunction(fn);

      expect(body).toContain("v_existing.employee_id is distinct from v_employee.id");
      expect(body).toContain("'error', 'request_conflict'");

      // The ownership test must come BEFORE the success is built.
      const check = body.indexOf("v_existing.employee_id is distinct from v_employee.id");
      const success = body.indexOf("'replayed', true");
      expect(check).toBeLessThan(success);
    }
  });

  it("a conflicting replay reveals nothing about the other employee", () => {
    for (const fn of ["clock_in_employee", "clock_out_employee"]) {
      const body = sqlFunction(fn);
      const conflict = body.indexOf("'error', 'request_conflict'");
      const line = body.slice(body.lastIndexOf("return", conflict), body.indexOf(";", conflict));

      // NEGATIVE CONTROL: the refusal carries the code and nothing else.
      for (const leaked of ["timeSessionId", "clockedInAt", "clockedOutAt", "employee_id"]) {
        expect(`${fn}: ${leaked}`).toBe(`${fn}: ${leaked}`);
        expect(line).not.toContain(leaked);
      }
    }
  });

  it("the replay keys stay project-scoped rather than per employee", () => {
    const sql = sqlCode();

    // Widening these to include employee_id would let one uuid create separate
    // punches for different people inside one business.
    expect(sql).toContain("on public.employee_time_sessions (project_id, clock_in_request_id)");
    expect(sql).toContain("on public.employee_time_sessions (project_id, clock_out_request_id)");
    expect(sql).not.toContain("(project_id, employee_id, clock_in_request_id)");
    expect(sql).not.toContain("(project_id, employee_id, clock_out_request_id)");
  });

  it("clock out finds the BUSINESS open shift, not this till's", () => {
    const body = sqlFunction("clock_out_employee");
    const lookup = body.slice(body.indexOf("into v_open"));

    expect(lookup).toContain("s.project_id = v_device.project_id");
    expect(lookup).toContain("s.employee_id = v_employee.id");
    // NEGATIVE CONTROL: scoping the open-shift lookup to the device is the one
    // change that would break clocking out at another register.
    expect(lookup.slice(0, lookup.indexOf("if not found"))).not.toContain(
      "clock_in_paired_device_id"
    );
  });

  it("records the device on each action without letting it own the shift", () => {
    const table = sqlCode().slice(sqlCode().indexOf("create table"), sqlCode().indexOf("comment on table"));

    expect(table).toContain("clock_in_paired_device_id");
    expect(table).toContain("clock_out_paired_device_id");

    // The open-session rule is scoped to the business, never the device.
    expect(sqlCode()).toContain(
      "on public.employee_time_sessions (project_id, employee_id)\n  where clocked_out_at is null"
    );
  });

  it("stores no derived or speculative columns", () => {
    const table = sqlCode().slice(sqlCode().indexOf("create table"), sqlCode().indexOf("comment on table"));

    for (const forbidden of [
      "duration",
      "status",
      "break",
      "wage",
      "payroll",
      "overtime",
      "notes",
      "scheduled",
      "corrected_by",
    ]) {
      expect(`column ${forbidden}`).toBe(`column ${forbidden}`);
      expect(table).not.toContain(forbidden);
    }
  });

  it("never fabricates a clock out", () => {
    const sql = sqlCode();

    // Deactivation is not a punch, and neither is a POS event. Nothing in this
    // migration may close a session on anyone's behalf.
    expect(sql).not.toContain("set_employee_active");
    expect(sql.match(/set\s+clocked_out_at/g) ?? []).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The client sends three things and keeps nothing
// ---------------------------------------------------------------------------

describe("the wrappers send only credentials and a request id", () => {
  it("passes exactly the three parameters", () => {
    const rpc = stripComments(read(TIME_CLOCK_RPC));

    expect(rpc).toContain("p_employee_code: employeeCode");
    expect(rpc).toContain("p_pin: pin");
    expect(rpc).toContain("p_request_id: requestId");

    for (const forbidden of ["p_project_id", "p_paired_device_id", "p_employee_id", "_at:"]) {
      expect(rpc).not.toContain(forbidden);
    }
  });

  // NEGATIVE CONTROL: no client clock, anywhere on this path.
  it("reads no clock of its own", () => {
    for (const file of [TIME_CLOCK, TIME_CLOCK_RPC]) {
      const source = stripComments(read(file));

      expect(`${file}: Date.now`).toBe(`${file}: Date.now`);
      expect(source).not.toContain("Date.now()");
      expect(source).not.toContain("new Date(");
      expect(source).not.toContain("toISOString()");
    }
  });

  // NEGATIVE CONTROL: online only. A punch that appears without somebody at
  // the till is worse than a missing one, because it looks true.
  it("keeps nothing locally and retries nothing", () => {
    for (const file of [TIME_CLOCK, TIME_CLOCK_RPC, DEVICE_APP]) {
      const source = stripComments(read(file));
      const scope = file === DEVICE_APP ? handler() : source;

      for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "enqueue", "setTimeout"]) {
        expect(`${file}: ${forbidden}`).toBe(`${file}: ${forbidden}`);
        expect(scope).not.toContain(forbidden);
      }
    }
  });

  it("calls only the two Time Clock RPCs", () => {
    const rpc = stripComments(read(TIME_CLOCK_RPC));
    const called = [...rpc.matchAll(/rpc\(\s*(?:rpc|"([^"]+)")/g)].map((m) => m[1]).filter(Boolean);

    expect(rpc).toContain('"clock_in_employee"');
    expect(rpc).toContain('"clock_out_employee"');
    expect(called.length).toBe(0); // the name is a parameter, not a literal at the call site

    for (const forbidden of ["employee_login", "complete_sale", "ensure_daily", "end_employee_pos_session"]) {
      expect(rpc).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// The POS is not disturbed
// ---------------------------------------------------------------------------

describe("using the Time Clock changes no POS authority", () => {
  it("the handler writes only its own state", () => {
    const body = handler();

    for (const forbidden of [
      "setGate(",
      "gateRef.current =",
      "beginEmployeeSwitch",
      "lockOperatorOut",
      "applyEmployeeAuthenticated",
      "deriveGateState",
      "acquireDaily",
      "runSync",
      "clearCart",
    ]) {
      expect(`handler: ${forbidden}`).toBe(`handler: ${forbidden}`);
      expect(body).not.toContain(forbidden);
    }

    expect(body).toContain("setTimeClockResult");
  });

  it("the handler has its own single-flight, separate from Ring Out's", () => {
    const body = handler();

    expect(body).toContain("if (timeClockInFlightRef.current)");
    // NEGATIVE CONTROL: sharing Ring Out's guard would let a punch block a
    // lock-out, or the reverse.
    expect(body).not.toContain("ringOutInFlightRef");
  });

  // NEGATIVE CONTROL, both directions. These are the couplings the feature
  // exists to prevent.
  it("POS login does not clock anybody in", () => {
    const source = read(DEVICE_APP);
    const login = source.slice(
      source.indexOf("const handleEmployeeCodeLogin = useCallback"),
      source.indexOf("const recoverDailyContext")
    );

    expect(stripComments(login)).not.toContain("clockIn");
    expect(stripComments(login)).not.toContain("TimeClock");
  });

  it("Ring Out and Auto-Lock do not clock anybody out", () => {
    const source = read(DEVICE_APP);
    const lock = stripComments(
      source.slice(source.indexOf("const lockOperatorOut = useCallback"), source.indexOf("  }, []);", source.indexOf("const lockOperatorOut = useCallback")))
    );

    for (const forbidden of ["clockOut", "clockIn", "TimeClock", "timeClock"]) {
      expect(`lockOperatorOut: ${forbidden}`).toBe(`lockOperatorOut: ${forbidden}`);
      expect(lock).not.toContain(forbidden);
    }
  });

  it("the panel overlays the gates rather than replacing the login form", () => {
    const source = read(DEVICE_APP);

    expect(source).toContain("const activeOverlay = timeClockOverlay ?? gateOverlay ?? overlay;");
    // The lock card keeps its own form and gains only a secondary action.
    expect(read(POS_GATES)).toContain("Sign In");
    expect(read(POS_GATES)).toContain("Time Clock");
  });

  it("is reachable both while locked and while somebody else operates the till", () => {
    const source = read(DEVICE_APP);

    expect(source).toContain("<EmployeeLockCard");
    expect(source).toContain("<DailyRegisterStatus");
    expect((source.match(/onTimeClock=\{\(\) => \{/g) ?? []).length).toBe(2);
  });

  it("the panel asks for explicit intent rather than resolving it", () => {
    const gates = read(POS_GATES);

    // A server-resolved toggle would perform the opposite of what somebody who
    // forgot to clock out yesterday came to do.
    expect(gates).toContain("Clock In");
    expect(gates).toContain("Clock Out");
    expect(gates).toContain('setAction("clock_in")');
    expect(gates).toContain('setAction("clock_out")');
  });
});

// ---------------------------------------------------------------------------
// Nothing else in the product learned about the Time Clock
// ---------------------------------------------------------------------------

describe("the rest of the product is unaware", () => {
  it("owner and browser v3 gained nothing", () => {
    const walk = (dir: string): string[] => {
      const out: string[] = [];

      for (const entry of readdirSync(join(repoRoot, dir))) {
        const child = join(dir, entry);

        if (statSync(join(repoRoot, child)).isDirectory()) out.push(...walk(child));
        else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(child);
      }

      return out;
    };

    for (const file of [...walk("components/runtime"), ...walk("components/editor/pos-layouts")]) {
      const source = stripComments(read(file));

      for (const banned of ["timeClock", "TimeClock", "clock_in_employee", "clock_out_employee"]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("no accepted Feature 1B migration mentions the Time Clock", () => {
    for (const file of readdirSync(join(repoRoot, "supabase/migrations"))) {
      if (!file.endsWith(".sql") || file.startsWith("20260927120000")) continue;

      expect(`${file}: employee_time_sessions`).toBe(`${file}: employee_time_sessions`);
      expect(read(join("supabase/migrations", file))).not.toContain("employee_time_sessions");
    }
  });

  it("the migration is additive: it creates and grants, and alters nothing else", () => {
    const sql = sqlCode();

    expect(sql).toContain("create table if not exists public.employee_time_sessions");
    // NEGATIVE CONTROL: no reshaping of anything that already existed.
    for (const forbidden of [
      "alter table public.employees",
      "alter table public.employee_pos_sessions",
      "alter table public.register_sessions",
      "alter table public.orders",
      "drop table",
      "drop function",
    ]) {
      expect(`migration: ${forbidden}`).toBe(`migration: ${forbidden}`);
      expect(sql).not.toContain(forbidden);
    }
  });

  it("locks the table down and grants only the two RPCs", () => {
    const sql = sqlCode();

    expect(sql).toContain("alter table public.employee_time_sessions enable row level security");
    expect(sql).toContain("revoke all on table public.employee_time_sessions from authenticated");
    expect(sql).toContain("grant execute on function public.clock_in_employee(text, text, uuid) to authenticated");
    expect(sql).toContain("grant execute on function public.clock_out_employee(text, text, uuid) to authenticated");
    expect(sql).not.toContain("grant execute on function public.clock_in_employee(text, text, uuid) to anon");
    expect(sql).not.toContain("create policy");
  });
});
