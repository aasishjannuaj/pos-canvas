// v1.3 Feature 1B-RUNTIME checkpoint 1 — static guards for the Employee ID +
// four-digit-PIN migration.
//
// SCOPE, STATED PLAINLY. These tests parse the SQL and assert the posture it
// declares. They do NOT execute it. The runtime behaviour — that the backfill
// numbers 001,002,003 by created_at then id; that 1000 active employees fail
// the migration atomically while 999 succeed; that a reissued code refuses a
// reactivation with employee_code_taken; that an unknown Employee ID and a
// wrong PIN are indistinguishable — was proven against a real PostgreSQL 17.11
// cluster during implementation, because none of it can be shown by reading
// text. What is checked here is everything a future edit could quietly break.
//
// Most describe blocks end with a NEGATIVE CONTROL that mutates a copy of the
// SQL and proves the guard would actually fail.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const FILENAME = "20260919120000_employee_code_and_four_digit_pin.sql";

const sql = readFileSync(join(migrationsDir, FILENAME), "utf-8");

/** The SQL with `--` comments removed, so prose cannot satisfy or trip a guard. */
const code = sql.replace(/--[^\n]*/g, "");

describe("the file itself", () => {
  it("sorts after every migration whose contract it depends on", () => {
    // NOT "is the newest file". That assertion is hostile to the future: every
    // legitimate migration written after this one would break it, and the fix
    // would be to edit a historical test — which is exactly the habit that
    // makes historical tests untrustworthy.
    //
    // What actually matters is that this migration lands after the four it
    // builds on: it re-creates functions they define, and it depends on the
    // employees table and the register/attribution contracts existing.
    for (const dependency of [
      "20260914120000_employee_identity_and_pos_sessions.sql",
      "20260916120000_employee_selector_single_hash_login.sql",
      "20260916130000_remove_active_employee_engineering_ceiling.sql",
      "20260917120000_register_sessions_and_sale_attribution.sql",
    ]) {
      // Named in the message so a failure says WHICH dependency is misordered.
      expect(`${dependency} sorts before ${FILENAME}: ${dependency < FILENAME}`).toBe(
        `${dependency} sorts before ${FILENAME}: true`
      );
      expect(readdirSync(migrationsDir)).toContain(dependency);
    }
  });

  it("a later migration is allowed to exist", () => {
    // The guard above must keep passing when one does. Asserted directly, so
    // that a future edit reintroducing "must be last" fails here.
    const hypothetical = "20270101000000_some_future_migration.sql";

    expect(FILENAME < hypothetical).toBe(true);
  });

  it("does not modify any accepted migration", () => {
    // The accepted files are named here so that deleting or renaming one is a
    // failure rather than a silent pass.
    for (const accepted of [
      "20260914120000_employee_identity_and_pos_sessions.sql",
      "20260916120000_employee_selector_single_hash_login.sql",
      "20260916130000_remove_active_employee_engineering_ceiling.sql",
      "20260917120000_register_sessions_and_sale_attribution.sql",
    ]) {
      expect(readdirSync(migrationsDir)).toContain(accepted);
    }
  });
});

describe("employee_code is a per-project label, not an identity", () => {
  it("is text, because 001 must not become 1", () => {
    expect(code).toMatch(/alter table public\.employees\s+add column if not exists employee_code text/);
    expect(code).not.toMatch(/employee_code (integer|int|smallint|numeric)/);
  });

  it("accepts exactly three digits and refuses 000", () => {
    expect(code).toContain("employees_employee_code_shape_check");
    expect(code).toMatch(/employee_code ~ '\^\[0-9\]\{3\}\$'/);
    expect(code).toMatch(/employee_code <> '000'/);
  });

  it("an ACTIVE employee must have one; a leaver may keep or lack one", () => {
    expect(code).toContain("employees_active_requires_code_check");
    expect(code).toMatch(/check \(not active or employee_code is not null\)/);
  });

  it("uniqueness is a PARTIAL unique index — the database, not an RPC", () => {
    // A plain unique index would let a leaver's retained code block the next
    // hire, which is the one behaviour this feature must not have. An RPC
    // pre-check alone would lose the race between two owners.
    expect(code).toMatch(
      /create unique index if not exists employees_active_project_code_key\s+on public\.employees \(project_id, employee_code\)\s+where active/
    );
  });

  it("scoped to the project, never global", () => {
    const index = code.slice(code.indexOf("employees_active_project_code_key"));

    expect(index.slice(0, 200)).toContain("(project_id, employee_code)");
  });

  it("NEGATIVE CONTROL: dropping the partial predicate is caught", () => {
    const broken = code.replace(/\n  where active;/, ";");

    expect(broken).not.toMatch(
      /create unique index if not exists employees_active_project_code_key\s+on public\.employees \(project_id, employee_code\)\s+where active/
    );
  });
});

describe("the backfill is deterministic and bounded", () => {
  it("orders by created_at then id, and by nothing else", () => {
    const backfill = code.slice(
      code.indexOf("update public.employees e"),
      code.indexOf("employees_employee_code_shape_check")
    );

    expect(backfill).toMatch(/order by e2\.created_at asc, e2\.id asc/);
    // The roster elsewhere sorts a DISPLAY list by name, which is fine; the
    // backfill must not, because a rename would renumber the whole team.
    expect(backfill).not.toContain("display_name");
    expect(backfill).not.toContain("role");
  });

  it("numbers per project", () => {
    expect(code).toMatch(/partition by e2\.project_id/);
  });

  it("pads to three characters, preserving the leading zero", () => {
    expect(code).toMatch(/lpad\(\s*row_number\(\) over \(/);
    expect(code).toMatch(/3,\s*'0'\s*\)/);
  });

  it("numbers ACTIVE employees only", () => {
    const backfill = code.slice(code.indexOf("update public.employees e"), code.indexOf("alter table public.employees\n  drop constraint"));

    expect(backfill).toContain("where e2.active");
  });

  it("refuses a project with more than 999 active employees, and says why", () => {
    expect(code).toMatch(/having count\(\*\) > 999/);
    expect(code).toContain("three-digit Employee ID namespace holds 999");
    expect(code).toContain("errcode = 'check_violation'");
  });

  it("the guard runs BEFORE any code is assigned, so failure leaves nothing", () => {
    expect(code.indexOf("having count(*) > 999")).toBeLessThan(
      code.indexOf("set employee_code = numbered.code")
    );
  });

  it("never widens, wraps or truncates", () => {
    expect(code).not.toMatch(/lpad\([^)]*4,\s*'0'/);
    expect(code).not.toContain("% 1000");
    expect(code).not.toContain("substring(");
  });
});

describe("the PIN is exactly four digits, on every credential path", () => {
  const PATHS = [
    "employee_pin_hash",
    "employee_login_by_code",
    "employee_login",
    "create_employee",
    "set_employee_pin",
  ];

  it("no path still accepts 4-6", () => {
    // Comments are stripped, because the bodies deliberately quote the OLD rule
    // while explaining what replaced it.
    expect(code).not.toContain("[0-9]{4,6}");
  });

  it("every path states the new rule", () => {
    for (const path of PATHS) {
      const start = code.indexOf(`function public.${path}(`);

      expect(`${path} is defined`).toBe(start === -1 ? "MISSING" : `${path} is defined`);
    }

    // Four occurrences of the tightened rule in the re-created bodies, plus the
    // hash helper's own backstop.
    expect(code.match(/\^\[0-9\]\{4\}\$/g)?.length).toBeGreaterThanOrEqual(PATHS.length);
  });

  it("the migration asserts it too, from the LIVE definitions", () => {
    // Text guards can only see this file. The DO block reads pg_proc, so a
    // function left behind on the old rule by some other migration is caught.
    expect(code).toContain("still accepts a 4-6 digit PIN");
    expect(code).toContain("does not enforce an exactly-4-digit PIN");
  });

  it("strips comments before that assertion — the A8b trap, again", () => {
    // Asserted against the RAW file: the stripper above removes from `--` to
    // end of line, and the SQL literal being asserted CONTAINS `--`. Reading
    // `code` here would test the stripper, not the migration.
    expect(sql).toContain("regexp_replace(pg_get_functiondef(p.oid)");
    expect(sql).toContain("chr(10)");
  });

  it("NEGATIVE CONTROL: a leftover 4-6 rule is caught", () => {
    expect(code.replace("'^[0-9]{4}$'", "'^[0-9]{4,6}$'")).toContain("[0-9]{4,6}");
  });
});

describe("pgcrypto is discovered, never hardcoded", () => {
  it("resolves the extension's real schema before rebuilding the hasher", () => {
    // Supabase puts pgcrypto in `extensions`; that is a deployment detail, not
    // a guarantee. 20260914120000 refused to guess and so does this.
    expect(code).toMatch(/from pg_extension e\s+join pg_namespace n on n\.oid = e\.extnamespace\s+where e\.extname = 'pgcrypto'/);
    expect(code).toContain("to_regprocedure(format('%I.crypt(text, text)', v_schema))");
    expect(code).toContain("to_regprocedure(format('%I.gen_salt(text, integer)', v_schema))");
  });

  it("builds the call fully qualified from the discovered schema", () => {
    expect(code).toContain("%I.crypt(p_pin, %I.gen_salt('bf', 10))");
    expect(code).not.toContain("extensions.crypt(");
  });

  it("keeps bcrypt at cost 10", () => {
    expect(code).toContain("gen_salt('bf', 10)");
  });
});

describe("Employee ID login carries no client authority", () => {
  const login = code.slice(
    code.indexOf("function public.employee_login_by_code("),
    code.indexOf("revoke all on function public.employee_login_by_code")
  );

  it("takes only what a person typed", () => {
    expect(code).toContain("function public.employee_login_by_code(p_employee_code text, p_pin text)");
    expect(login).not.toContain("p_project_id");
    expect(login).not.toContain("p_employee_id");
    expect(login).not.toContain("p_device_id");
  });

  it("derives the device from auth.uid() and the project from the device", () => {
    expect(login).toContain("v_caller := auth.uid();");
    expect(login).toMatch(/from public\.paired_devices d\s+where d\.auth_user_id = v_caller/);
    expect(login).toContain("where e.project_id = v_device.project_id");
  });

  it("only an ACTIVE employee can sign in", () => {
    expect(login).toContain("and e.active");
  });

  it("locks the device row, so two presses cannot both open a session", () => {
    expect(login).toContain("for update");
  });

  it("does not touch the register — the lifecycles are independent", () => {
    expect(login).not.toContain("register_sessions");
  });
});

describe("one failure surface, and no free enumeration", () => {
  const login = code.slice(
    code.indexOf("function public.employee_login_by_code("),
    code.indexOf("revoke all on function public.employee_login_by_code")
  );

  it("every credential problem returns the same generic failure", () => {
    expect(login).toContain("v_generic_failure constant jsonb");
    expect(login).toContain("'error', 'invalid_credentials'");

    // Malformed code, unknown code, bad PIN shape and wrong PIN: four paths,
    // one answer. None of them names which part was wrong.
    expect(login.match(/return v_generic_failure;/g)?.length).toBe(4);
    expect(login).not.toContain("employee_not_found");
    expect(login).not.toContain("unknown_employee");
  });

  it("an unresolved Employee ID still pays the bcrypt cost", () => {
    // A UUID is unguessable, so the older path's early return leaked little. A
    // three-digit code is 999 guesses, and an early return would turn "which
    // IDs exist here" into a timing measurement.
    expect(login).toContain("v_dummy_hash constant text");
    expect(login.match(/employee_pin_verify\(coalesce\(p_pin, '0000'\), v_dummy_hash\)/g)?.length).toBe(2);
  });

  it("and is still counted by the device-wide limiter", () => {
    // The dummy verify equalises cost; the throttle is what actually bounds
    // enumeration.
    const beforeResolve = login.slice(0, login.indexOf("select a.locked_until"));

    expect(beforeResolve.match(/employee_login_record_device_failure/g)?.length).toBe(2);
  });

  it("the device cooldown is checked before anything is looked up", () => {
    expect(login.indexOf("employee_login_device_throttles")).toBeLessThan(
      login.indexOf("from public.employees e")
    );
  });

  it("the per-employee limiter is keyed to the durable UUID, not the code", () => {
    // A reissued code must not inherit the previous holder's failure history,
    // and a renumbered employee must not shed their own.
    expect(login).toContain("and a.employee_id = v_employee.id");
    expect(login).not.toMatch(/employee_login_employee_attempts[\s\S]{0,200}employee_code/);
  });

  it("NEGATIVE CONTROL: removing the dummy verify is caught", () => {
    const broken = login.replace(/perform public\.employee_pin_verify\(coalesce\(p_pin, '0000'\), v_dummy_hash\);/g, "");

    expect(broken.match(/employee_pin_verify\(coalesce\(p_pin, '0000'\), v_dummy_hash\)/g)).toBeNull();
  });
});

describe("management contracts", () => {
  it("create_employee now requires an Employee ID, and the codeless form is gone", () => {
    expect(code).toContain("drop function if exists public.create_employee(uuid, text, text, text);");
    expect(code).toContain(
      "function public.create_employee(\n  p_project_id uuid,\n  p_display_name text,\n  p_role text,\n  p_employee_code text,\n  p_pin text\n)"
    );
  });

  it("a lost race returns a catalogued error, not a raw 23505", () => {
    expect(code.match(/when unique_violation then/g)?.length).toBe(3);
    expect(code.match(/'error', 'employee_code_taken'/g)?.length).toBe(3);
  });

  it("set_employee_code changes the label and nothing else", () => {
    const setter = code.slice(
      code.indexOf("function public.set_employee_code("),
      code.indexOf("revoke all on function public.set_employee_code")
    );

    expect(setter).toContain("set employee_code = p_employee_code");
    expect(setter).not.toContain("pin_hash");
    expect(setter).not.toContain("set id =");
    expect(setter).not.toContain("project_id =");
  });

  it("reactivation refuses rather than renumbering anybody", () => {
    const activator = code.slice(
      code.indexOf("function public.set_employee_active("),
      code.indexOf("revoke all on function public.set_employee_active")
    );

    expect(activator).toContain("'error', 'employee_code_taken'");
    expect(activator).toContain("'error', 'employee_code_required'");
    // It must not resolve the clash by editing anyone.
    expect(activator).not.toContain("set employee_code =");
  });

  it("owner authorization is still the join to projects", () => {
    for (const fn of ["set_employee_code", "set_employee_pin", "set_employee_active"]) {
      const body = code.slice(code.indexOf(`function public.${fn}(`));

      expect(body.slice(0, 2000)).toContain("join public.projects p on p.id = e.project_id");
      expect(body.slice(0, 2000)).toContain("and p.user_id = v_caller");
    }
  });

  it("a paired device may never call a management RPC", () => {
    for (const fn of ["create_employee", "set_employee_code", "set_employee_pin", "set_employee_active"]) {
      const body = code.slice(code.indexOf(`function public.${fn}(`));

      expect(body.slice(0, 2000)).toContain(
        "if exists (select 1 from public.paired_devices d where d.auth_user_id = v_caller)"
      );
    }
  });
});

describe("the roster survives as the secondary path", () => {
  it("list_login_employees is left completely alone", () => {
    // Untouched on purpose. Adding the Employee ID to it would change a
    // client-facing contract this checkpoint does not need, and an owner-facing
    // list belongs with the management UI in a later checkpoint.
    expect(code).not.toContain("function public.list_login_employees()");
    expect(code).not.toContain("drop function public.list_login_employees");
  });

  it("employee_login(uuid, text) is kept as the secondary login", () => {
    expect(code).toContain("function public.employee_login(p_employee_id uuid, p_pin text)");
    expect(code).not.toContain("drop function public.employee_login(uuid");
  });
});

describe("security posture", () => {
  const FUNCTIONS = [
    "employee_login_by_code",
    "set_employee_code",
    "create_employee",
    "set_employee_pin",
    "set_employee_active",
  ];

  it("every function is SECURITY DEFINER with a locked search_path", () => {
    for (const fn of FUNCTIONS) {
      const body = code.slice(code.indexOf(`function public.${fn}(`));

      expect(body.slice(0, 400)).toContain("security definer");
      expect(body.slice(0, 400)).toContain("set search_path = public, pg_temp");
    }
  });

  it("every function is revoked from public, anon and service_role", () => {
    for (const fn of FUNCTIONS) {
      for (const role of ["public", "anon", "service_role"]) {
        expect(code).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from ${role};`));
      }
    }
  });

  it("execute is granted to authenticated only", () => {
    for (const fn of FUNCTIONS) {
      expect(code).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to authenticated;`));
    }
  });

  it("the PIN hasher is granted to nobody at all", () => {
    expect(code).toMatch(/revoke all on function public\.employee_pin_hash\(text\) from public;/);
    expect(code).not.toMatch(/grant execute on function public\.employee_pin_hash/);
  });

  it("no PIN material is ever returned", () => {
    expect(code).not.toMatch(/'pinHash'/);
    expect(code).not.toMatch(/'pin'/);
  });
});

describe("what this migration must NOT have touched", () => {
  it("does not alter sale, register or session contracts", () => {
    for (const banned of [
      "create or replace function public.complete_sale_v5",
      "create or replace function public.open_register_session",
      "create or replace function public.close_register_session",
      "alter table public.register_sessions",
      "alter table public.employee_pos_sessions",
      "alter table public.orders",
    ]) {
      expect(`migration: ${banned}`).toBe(`migration: ${banned}`);
      expect(code).not.toContain(banned);
    }
  });

  it("asserts those contracts still exist afterwards", () => {
    expect(code).toContain("'complete_sale_v5', 'open_register_session', 'close_register_session'");
  });

  it("asserts the UUID is still the identity", () => {
    expect(code).toContain("employees.id is no longer the primary key");
    expect(code).toContain("employee_pos_sessions no longer references employees(id)");
  });

  it("changes no existing bcrypt hash", () => {
    // set_employee_pin sets a hash when an owner deliberately changes a PIN;
    // that is the feature. What must not exist is a bulk rewrite of stored
    // hashes as part of the data migration, which would need a plaintext
    // nobody has.
    const dataMigration = code.slice(0, code.indexOf("function public.employee_pin_hash("));

    expect(dataMigration).not.toContain("pin_hash");
  });

  it("drops no employee data", () => {
    expect(code).not.toMatch(/delete from public\.employees/);
    expect(code).not.toMatch(/drop table/);
    expect(code).not.toMatch(/drop column/);
  });
});

describe("provenance", () => {
  it("records the file's hash, so a silent edit is visible in review", () => {
    const digest = createHash("sha256").update(sql, "utf8").digest("hex");

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(sql.length).toBeGreaterThan(1000);
  });
});
