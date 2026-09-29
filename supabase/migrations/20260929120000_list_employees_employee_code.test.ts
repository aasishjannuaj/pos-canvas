// v1.3 Lane 1 Task 5B correction — static guards for list_employees exposing
// employeeCode.
//
// SCOPE, STATED PLAINLY. These parse the SQL; they do not execute it. The
// runtime behaviour — "001" comes back as the string "001", each code belongs
// to its own row, owners/devices/strangers are refused exactly as before — is
// proven against a real PostgreSQL in the sibling .db.test.ts. What is checked
// here is everything a future edit could quietly break, and it runs on a
// machine with no PostgreSQL at all.
//
// Each describe block ends with a NEGATIVE CONTROL that mutates a copy of the
// SQL and proves the guard would actually fail.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const FILENAME = "20260929120000_list_employees_employee_code.sql";
const ORIGINAL = "20260914120000_employee_identity_and_pos_sessions.sql";

const sql = readFileSync(join(migrationsDir, FILENAME), "utf-8");

/** The SQL with `--` comments removed, so prose cannot satisfy or trip a guard. */
const stripComments = (text: string): string => text.replace(/--[^\n]*/g, "");

/**
 * Replaces the first `from` AT OR AFTER the function's `create` statement.
 *
 * The header comment quotes some of the same text, and a mutation that lands
 * in prose instead of code would prove nothing.
 */
function mutate(text: string, from: string, to: string): string {
  const start = text.indexOf("create or replace function public.list_employees(");
  const at = text.indexOf(from, start);

  if (start === -1 || at === -1) return text;

  return text.slice(0, at) + to + text.slice(at + from.length);
}

/** From `create or replace function public.list_employees(` to its `$function$;`. */
function functionBlock(text: string): string {
  const start = text.indexOf("create or replace function public.list_employees(");
  const end = text.indexOf("$function$;", start);

  if (start === -1 || end === -1) return "";

  return text.slice(start, end + "$function$;".length);
}

// ---------------------------------------------------------------------------

describe("the file itself", () => {
  it("sorts after the migrations it depends on", () => {
    for (const dependency of [ORIGINAL, "20260919120000_employee_code_and_four_digit_pin.sql"]) {
      expect(`${dependency} < ${FILENAME}: ${dependency < FILENAME}`).toBe(
        `${dependency} < ${FILENAME}: true`
      );
      expect(readdirSync(migrationsDir)).toContain(dependency);
    }
  });
});

// ---------------------------------------------------------------------------

/** Every guard on the migration's SCOPE, as one predicate a mutation can be run through. */
function scopeViolations(text: string): string[] {
  const body = stripComments(text).toLowerCase();
  const problems: string[] = [];

  const created = [...body.matchAll(/create\s+or\s+replace\s+function\s+([\w.]+)\s*\(/g)].map(
    (m) => m[1]
  );

  if (created.join(",") !== "public.list_employees") {
    problems.push(`functions created: ${created.join(",") || "none"}`);
  }

  for (const [label, pattern] of [
    ["drop", /\bdrop\s+/],
    ["create table", /\bcreate\s+(unique\s+)?(table|index|trigger|view|policy|type)\b/],
    ["alter", /\balter\s+(table|function|policy)\b/],
    ["insert", /\binsert\s+into\b/],
    ["update", /\bupdate\s+public\./],
    ["delete", /\bdelete\s+from\b/],
    ["table grant", /\bgrant\b[^;]*\bon\s+(table\s+)?public\.(?!list_employees)/],
    ["service_role grant", /\bgrant\b[^;]*\bto\s+[^;]*service_role/],
    ["anon grant", /\bgrant\b[^;]*\bto\s+[^;]*\banon\b/],
  ] as const) {
    if (pattern.test(body)) problems.push(label);
  }

  for (const untouchable of [
    "set_employee_active",
    "clock_out_employee",
    "clock_in_employee",
    "create_employee",
    "set_employee_code",
    "set_employee_pin",
    "employee_pos_sessions",
    "employee_time_sessions",
  ]) {
    if (body.includes(untouchable)) problems.push(`mentions ${untouchable}`);
  }

  return problems;
}

describe("the migration changes the employee read contract and nothing else", () => {
  it("replaces exactly one function, and creates, drops, alters and writes nothing", () => {
    expect(scopeViolations(sql)).toEqual([]);
  });

  it("the new body is the accepted body plus ONE key, character for character", () => {
    const original = functionBlock(readFileSync(join(migrationsDir, ORIGINAL), "utf-8"));

    expect(original).not.toBe("");
    expect(functionBlock(sql)).toBe(
      original.replace(
        "'deactivatedAt', e.deactivated_at\n",
        "'deactivatedAt', e.deactivated_at,\n        'employeeCode', e.employee_code\n"
      )
    );
  });

  it("NEGATIVE CONTROL: the scope guard fails on each out-of-scope edit", () => {
    for (const mutation of [
      `${sql}\ndrop function public.list_employees(uuid);`,
      `${sql}\nalter table public.employees add column x text;`,
      `${sql}\nupdate public.employees set employee_code = '001';`,
      `${sql}\ngrant select on table public.employees to authenticated;`,
      `${sql}\ngrant execute on function public.list_employees(uuid) to anon;`,
      `${sql}\ngrant execute on function public.list_employees(uuid) to service_role;`,
      `${sql}\ncreate or replace function public.list_employees_v2() returns int language sql as $$ select 1 $$;`,
      `${sql}\nselect public.set_employee_active(null, false);`,
    ]) {
      expect(scopeViolations(mutation)).not.toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------

/** Every guard on the SECURITY posture, as one predicate. */
function securityViolations(text: string): string[] {
  const block = stripComments(functionBlock(text)).toLowerCase();
  const all = stripComments(text).toLowerCase();
  const problems: string[] = [];

  const required: [string, RegExp][] = [
    ["returns jsonb", /\breturns\s+jsonb\b/],
    ["stable", /\bstable\b/],
    ["security definer", /\bsecurity\s+definer\b/],
    ["safe search_path", /set\s+search_path\s*=\s*public,\s*pg_temp\b/],
    ["auth.uid()", /v_caller\s*:=\s*auth\.uid\(\)/],
    ["not_authenticated", /if\s+v_caller\s+is\s+null\s+then\s+return[^;]*'not_authenticated'/],
    [
      "paired-device refusal",
      /if\s+exists\s*\(\s*select\s+1\s+from\s+public\.paired_devices\s+d\s+where\s+d\.auth_user_id\s*=\s*v_caller\s*\)\s*then\s+return[^;]*'not_found'/,
    ],
    ["owner lookup", /select\s+p\.user_id\s+into\s+v_project_owner\s+from\s+public\.projects\s+p\s+where\s+p\.id\s*=\s*p_project_id/],
    [
      "owner check",
      /if\s+not\s+found\s+or\s+v_project_owner\s+is\s+distinct\s+from\s+v_caller\s+then\s+return[^;]*'not_found'/,
    ],
    ["project scope", /where\s+e\.project_id\s*=\s*p_project_id\s*;/],
  ];

  for (const [label, pattern] of required) {
    if (!pattern.test(block)) problems.push(`missing ${label}`);
  }

  if (/security\s+invoker/.test(block)) problems.push("security invoker");
  if (/pin/.test(block.replace(/'employeecode'/g, ""))) problems.push("pin material");
  if (/crypt|hash/.test(block)) problems.push("credential material");

  for (const statement of [
    "revoke all on function public.list_employees(uuid) from public;",
    "revoke all on function public.list_employees(uuid) from anon;",
    "revoke all on function public.list_employees(uuid) from service_role;",
    "grant execute on function public.list_employees(uuid) to authenticated;",
  ]) {
    if (!all.includes(statement)) problems.push(`missing ${statement}`);
  }

  return problems;
}

describe("authorization and credential posture are unchanged", () => {
  it("keeps every accepted check, grant and setting, and selects no credential", () => {
    expect(securityViolations(sql)).toEqual([]);
  });

  it("NEGATIVE CONTROL: removing a check or exposing a credential fails", () => {
    for (const [from, to] of [
      ["or v_project_owner is distinct from v_caller ", ""],
      ["if exists (select 1 from public.paired_devices d where d.auth_user_id = v_caller) then", "if false then"],
      ["security definer", "security invoker"],
      ["set search_path = public, pg_temp", "set search_path = public"],
      ["'employeeCode', e.employee_code", "'employeeCode', e.employee_code,\n        'pinHash', e.pin_hash"],
      ["grant execute on function public.list_employees(uuid) to authenticated;", ""],
    ] as const) {
      const mutated = mutate(sql, from, to);

      expect(mutated).not.toBe(sql);
      expect(securityViolations(mutated)).not.toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------

/** The employeeCode key: present, sourced straight from the text column, never coerced. */
function employeeCodeViolations(text: string): string[] {
  const block = stripComments(functionBlock(text)).toLowerCase();
  const problems: string[] = [];

  const sourced = [...block.matchAll(/'employeecode'\s*,\s*([^\n]*)/g)].map((m) => m[1].trim());

  if (sourced.length !== 1) problems.push(`employeeCode keys: ${sourced.length}`);
  else if (sourced[0].replace(/,$/, "") !== "e.employee_code") {
    problems.push(`employeeCode sourced from: ${sourced[0]}`);
  }

  if (/employee_code\s*::|cast\s*\(\s*e\.employee_code|to_number|lpad|ltrim/.test(block)) {
    problems.push("employee_code is transformed");
  }

  for (const key of ["employeeid", "displayname", "role", "active", "createdat", "deactivatedat"]) {
    if (!block.includes(`'${key}'`)) problems.push(`lost ${key}`);
  }

  return problems;
}

describe("employeeCode is exposed as stored text", () => {
  it("adds exactly one employeeCode key, read straight from employees.employee_code", () => {
    expect(employeeCodeViolations(sql)).toEqual([]);
  });

  it("NEGATIVE CONTROL: omitting, coercing, or re-sourcing the code fails", () => {
    const line = "'employeeCode', e.employee_code";

    for (const mutated of [
      mutate(sql, `,\n        ${line}`, ""),
      mutate(sql, line, "'employeeCode', e.employee_code::integer"),
      mutate(sql, line, "'employeeCode', ltrim(e.employee_code, '0')"),
      mutate(sql, line, "'employeeCode', (select x.employee_code from public.employees x where x.id <> e.id limit 1)"),
      mutate(sql, "'deactivatedAt', e.deactivated_at,", ""),
    ]) {
      expect(mutated).not.toBe(sql);
      expect(employeeCodeViolations(mutated)).not.toEqual([]);
    }
  });
});
