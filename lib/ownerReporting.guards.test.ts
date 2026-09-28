// v1.3 Feature 1F — structural guards over the owner reporting contracts.
//
// WHAT THESE ADD OVER THE .db.test.ts. That suite executes the contracts against
// a real cluster and proves what HAPPENS. These prove properties that hold even
// when nothing is running: that the definer functions pin a search_path, that no
// grant widened, that no table grant was added as a shortcut, that the cash
// contract cannot grow a drawer figure, and that the Time contract cannot start
// reading POS sessions. Each is a change somebody could make that still passes
// every behavioural test on the day they make it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(repoRoot, p), "utf-8");

const MIGRATION = "supabase/migrations/20260928120000_owner_reporting_contracts.sql";
const sql = read(MIGRATION);

/** Strips SQL line comments, so prose explaining a rule never satisfies it. */
const executable = sql.replace(/^\s*--.*$/gm, "");

/** The four functions this migration exposes to a client. */
const OWNER_RPCS = [
  "list_employee_time_sessions",
  "list_cash_movements",
  "list_order_business_dates",
  "set_employee_role",
] as const;

/** Everything it defines, including the helper nobody may call. */
const ALL_FUNCTIONS = [...OWNER_RPCS, "project_has_covering_daily_register"] as const;

function bodyOf(name: string): string {
  const start = executable.indexOf(`create or replace function public.${name}`);
  expect(start).toBeGreaterThan(-1);

  const after = executable.slice(start);
  const end = after.indexOf("$function$;");

  return after.slice(0, end === -1 ? undefined : end);
}

describe("every owner contract verifies the project owner itself", () => {
  for (const fn of OWNER_RPCS) {
    it(`${fn} resolves auth.uid() and compares it to projects.user_id`, () => {
      const body = bodyOf(fn);

      expect(body).toContain("v_caller := auth.uid();");
      expect(body).toContain("select p.user_id into v_project_owner");
      expect(body).toContain("v_project_owner is distinct from v_caller");
      // A refusal must not reveal whether the project exists.
      expect(body).toContain("'error', 'not_found'");
    });

    it(`${fn} rejects a PAIRED DEVICE even though it is authenticated`, () => {
      expect(bodyOf(fn)).toContain(
        "select 1 from public.paired_devices d where d.auth_user_id = v_caller"
      );
    });

    it(`${fn} refuses an unauthenticated caller by name`, () => {
      expect(bodyOf(fn)).toContain("'error', 'not_authenticated'");
    });
  }
});

describe("definer functions are pinned and narrowly granted", () => {
  for (const fn of ALL_FUNCTIONS) {
    it(`${fn} is SECURITY DEFINER with a pinned search_path`, () => {
      const body = bodyOf(fn);

      expect(body).toContain("security definer");
      expect(body).toContain("set search_path = public, pg_temp");
    });

    it(`${fn} revokes from public, anon and service_role`, () => {
      for (const role of ["public", "anon", "service_role"]) {
        expect(executable).toMatch(
          new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from ${role};`)
        );
      }
    });
  }

  for (const fn of OWNER_RPCS) {
    it(`${fn} grants execute to authenticated and to nobody else`, () => {
      expect(executable).toMatch(
        new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to authenticated;`)
      );
      expect(executable).not.toMatch(
        new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to (anon|service_role|public);`)
      );
    });
  }

  it("the shared DAILY helper is granted to NOBODY -- it is not an RPC", () => {
    expect(executable).toContain(
      "revoke all on function public.project_has_covering_daily_register(uuid, timestamptz) from authenticated;"
    );
    expect(executable).not.toMatch(
      /grant execute on function public\.project_has_covering_daily_register/
    );
  });

  it("the replaced trigger body is executable by nobody, including authenticated", () => {
    expect(executable).toContain(
      "revoke all on function public.projects_validate_business_timezone() from authenticated;"
    );
  });
});

describe("role is resolved from the authoritative table, never from a session", () => {
  const body = bodyOf("set_employee_role");

  it("finds the employee in public.employees", () => {
    expect(body).toContain("from public.employees e");
    expect(body).toContain("where e.id = p_employee_id");
  });

  it("never reads a POS session, which would scope the mutation to signed-in staff", () => {
    // A negative control that replaced this lookup with an employee_pos_sessions
    // join passed every other test while silently making the role of anyone not
    // currently signed in unchangeable.
    expect(body).not.toContain("employee_pos_sessions");
    expect(body).not.toContain("employee_time_sessions");
  });

  it("caches no role anywhere -- it writes employees.role and returns it", () => {
    expect(body).toContain("update public.employees e");
    expect(body).toContain("set role = p_role");
    // Nothing in this migration may add a role column to a session table.
    expect(executable).not.toMatch(/alter table public\.employee_pos_sessions/i);
    expect(executable).not.toMatch(/add column\s+role/i);
  });
});

describe("no shortcut was taken with table privileges or RLS", () => {
  it("grants no table access at all", () => {
    expect(executable).not.toMatch(/grant\s+(select|insert|update|delete|all)[^;]*\son\s+table/i);
  });

  it("creates no policy and disables no row level security", () => {
    expect(executable).not.toMatch(/create\s+policy/i);
    expect(executable).not.toMatch(/disable\s+row\s+level\s+security/i);
    expect(executable).not.toMatch(/drop\s+policy/i);
  });

  it("creates no table and no view", () => {
    expect(executable).not.toMatch(/create\s+table/i);
    expect(executable).not.toMatch(/create\s+(or replace\s+)?view/i);
    expect(executable).not.toMatch(/materialized\s+view/i);
  });

  it("writes no historical data: no backfill, no update of operational rows", () => {
    for (const table of [
      "public.orders",
      "public.employees",
      "public.employee_time_sessions",
      "public.cash_movements",
      "public.register_sessions",
    ]) {
      expect(executable).not.toContain(`insert into ${table}`);
      expect(executable).not.toContain(`delete from ${table}`);
    }

    // The ONE update this migration performs is the role change, by id.
    const updates = [...executable.matchAll(/update\s+public\.(\w+)/g)].map((m) => m[1]);
    expect(updates).toEqual(["employees"]);
  });
});

describe("the Cash contract exposes source events, never a drawer position", () => {
  const body = bodyOf("list_cash_movements");

  it("returns no opening, expected, counted, variance or over/short figure", () => {
    for (const banned of [
      "opening_cash",
      "expected",
      "counted",
      "variance",
      "over_short",
      "closing_cash",
    ]) {
      expect(body).not.toContain(banned);
    }
  });

  it("computes no total, sum or balance", () => {
    expect(body).not.toMatch(/\bsum\s*\(/i);
    expect(body).not.toContain("balance");
  });

  it("joins the STORED business date rather than deriving one", () => {
    expect(body).toContain("'businessDate', r.business_date");
    // business_date_of would be a recomputation from occurred_at.
    expect(body).not.toContain("business_date_of");
  });
});

describe("the Time contract reads worked time and nothing else", () => {
  const body = bodyOf("list_employee_time_sessions");

  it("reads employee_time_sessions, never employee_pos_sessions", () => {
    expect(body).toContain("from public.employee_time_sessions");
    expect(body).not.toContain("employee_pos_sessions");
  });

  it("returns no computed duration", () => {
    for (const banned of ["duration", "worked", "minutes", "hours", "extract(epoch"]) {
      expect(body.toLowerCase()).not.toContain(banned);
    }
  });

  it("returns no request ids or credential material", () => {
    for (const banned of ["request_id", "pin_hash", "employee_code"]) {
      expect(body).not.toContain(banned);
    }
  });

  it("reports an open shift as open rather than as a zero", () => {
    expect(body).toContain("'isOpen', t.clocked_out_at is null");
  });
});

describe("the business-date contract exposes one field and one field only", () => {
  const body = bodyOf("list_order_business_dates");

  it("returns just the order id and the stored business date", () => {
    const keys = [...body.matchAll(/'(\w+)',\s+[or]\./g)].map((m) => m[1]);
    expect(keys.sort()).toEqual(["businessDate", "orderId"]);
  });

  it("exposes no other register field", () => {
    for (const banned of ["opening_cash", "opened_at", "closed_at", "opened_by_employee_id"]) {
      expect(body).not.toContain(banned);
    }
  });

  it("does not derive a date from created_at", () => {
    expect(body).not.toContain("business_date_of");
  });
});

describe("the timezone guard reuses the accepted DAILY invariant", () => {
  const helper = bodyOf("project_has_covering_daily_register");
  const trigger = bodyOf("projects_validate_business_timezone");

  it("the helper is the accepted step-4a predicate, widened to a project", () => {
    // The four clauses ensure_daily_register_context uses, verbatim.
    expect(helper).toContain("r.business_date is not null");
    expect(helper).toContain("r.opened_at <= p_at");
    expect(helper).toContain("p_at < r.closed_at");
    expect(helper).toContain("d.project_id = p_project_id");
  });

  it("the accepted sale-path predicate is UNCHANGED by this migration", () => {
    const accepted = read("supabase/migrations/20260921120000_daily_register_context.sql");

    expect(accepted).toContain("and r.business_date is not null");
    expect(accepted).toContain("and r.opened_at <= v_now");
    expect(accepted).toContain("and v_now < r.closed_at");
    expect(accepted).toContain("'daily_register_timezone_conflict'");
  });

  it("the trigger refuses with the exact agreed error code", () => {
    expect(trigger).toContain("business_timezone_change_blocked_open_register");
  });

  it("the trigger asks the shared helper rather than restating the predicate", () => {
    expect(trigger).toContain("public.project_has_covering_daily_register(new.id, now())");
    expect(trigger).not.toContain("register_sessions");
  });

  it("an unchanged value short-circuits before any refusal", () => {
    const shortCircuit = trigger.indexOf("old.business_timezone is not distinct from new.business_timezone");
    const refusal = trigger.indexOf("business_timezone_change_blocked_open_register");

    expect(shortCircuit).toBeGreaterThan(-1);
    expect(shortCircuit).toBeLessThan(refusal);
  });

  it("the guard is scoped to UPDATE, so creating a project is never blocked", () => {
    expect(trigger).toContain("tg_op = 'UPDATE'");
  });

  it("the accepted value validation survives", () => {
    expect(trigger).toContain("public.is_valid_business_timezone(new.business_timezone)");
    expect(trigger).toContain("Invalid business timezone");
  });
});

describe("the client wrappers add no authority and invent no values", () => {
  /** Strips comments, so prose explaining a rule never trips the rule. */
  const code = (source: string) =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  const rpc = code(read("lib/ownerReporting.rpc.ts"));
  const admin = code(read("lib/employeeAdmin.rpc.ts"));
  const pure = code(read("lib/ownerReporting.ts"));

  it("owner reads use the owner client, never the device client", () => {
    expect(rpc).toContain('from "@/lib/supabase/client"');
    expect(rpc).not.toContain("deviceClient");
    expect(admin).toContain('from "@/lib/supabase/client"');
    expect(admin).not.toContain("deviceClient");
  });

  it("no wrapper touches the service-role client", () => {
    for (const source of [rpc, admin, pure]) {
      expect(source).not.toContain("supabase/admin");
      expect(source).not.toContain("SERVICE_ROLE");
    }
  });

  it("a transport failure is never reported as an empty report", () => {
    expect(rpc).toContain('{ ok: false, error: "unavailable" }');
  });

  it("the pure module computes no duration, total or business date", () => {
    for (const banned of ["Date.now", "new Date(", "durationMs", "reduce(", "toLocaleDateString"]) {
      expect(pure).not.toContain(banned);
    }
  });

  it("an unreadable row fails the report rather than shortening it", () => {
    expect(pure).toContain('return { ok: false, code: "unavailable" };');
  });

  it("a missing business date is null and is never filled in", () => {
    expect(pure).toContain("findOrderBusinessDate");
    // No timezone machinery here at all: bucketing an order with no recorded
    // business day is a presentation choice, made where it can be labelled.
    expect(pure).not.toContain("timeZone");
    expect(pure).not.toContain("Intl.");
    expect(pure).not.toContain("getTimezoneOffset");
  });
});
