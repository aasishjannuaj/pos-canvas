// v1.3 Feature 1A.1 — static guards for the employee selector and single-hash
// login migration.
//
// SCOPE, STATED PLAINLY. No database is available to this suite and the
// migration has not been applied anywhere. These tests prove three things:
//
//   1. the SQL is valid and declares the intended posture;
//   2. the EFFECTIVE schema — the last definition of each function across the
//      whole ordered migration history, minus anything later dropped — has the
//      properties Feature 1A.1 requires (one hash verification, no roster scan,
//      no duplicate-PIN scan, PIN-only login gone);
//   3. the throttle and lockout constants, which are evaluated here from the
//      parsed SQL itself rather than compared as text.
//
// They do NOT prove runtime behaviour: that a real 15th failure throttles, that
// the window boundary behaves at the instant, or that two concurrent calls
// serialize. Those require executing against a database and belong to the
// staging validation phase. Where a property can only be shown structurally
// (lock ordering, which paths write which state), the test says so.
//
// Most describe blocks end with NEGATIVE CONTROLS that mutate a copy of the SQL
// and prove the guard would fail.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import pgQuery from "libpg-query";

const { parse, loadModule } = pgQuery as unknown as {
  parse: (sql: string) => Promise<{ stmts: Array<{ stmt: Record<string, unknown> }> }>;
  loadModule: () => Promise<unknown>;
};

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const FILENAME = "20260916120000_employee_selector_single_hash_login.sql";
const PREVIOUS = "20260914120000_employee_identity_and_pos_sessions.sql";

const sql = readFileSync(join(migrationsDir, FILENAME), "utf-8");

function stripComments(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

const executable = stripComments(sql);

beforeAll(async () => {
  await loadModule();
});

// ---------------------------------------------------------------------------
// Function extraction — shared by every block below
// ---------------------------------------------------------------------------

type FunctionDef = { name: string; types: string; body: string; file: string };

/** "p_employee_id uuid, p_pin text" -> "uuid,text". Named parameters only. */
function typesOf(params: string): string {
  return params
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.replace(/\s+default\s+.*$/i, "").split(/\s+/).slice(1).join(" "))
    .join(",");
}

/** "(uuid, text, uuid)" -> "uuid,text,uuid". */
function normalizeSignature(args: string): string {
  return args
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean)
    .join(",");
}

/** Every `create or replace function public.x(...)` in a file, with its body. */
function definitionsIn(text: string, file: string): Array<FunctionDef & { at: number }> {
  const out: Array<FunctionDef & { at: number }> = [];
  const header = /create or replace function (?:public\.)?(\w+)\s*\(([^)]*)\)\s*returns/gi;

  for (const match of text.matchAll(header)) {
    const start = (match.index ?? 0) + match[0].length;
    const opener = /\bas\s+(\$\w*\$)/i.exec(text.slice(start));

    if (!opener) {
      continue;
    }

    const bodyStart = start + opener.index + opener[0].length;
    const bodyEnd = text.indexOf(opener[1], bodyStart);

    out.push({
      name: match[1].toLowerCase(),
      types: typesOf(match[2]),
      body: text.slice(bodyStart, bodyEnd),
      file,
      at: match.index ?? 0,
    });
  }

  return out;
}

/** Every `drop function public.x(...)` in a file. */
function dropsIn(text: string): Array<{ name: string; types: string; at: number }> {
  return [...text.matchAll(/drop function (?:if exists )?(?:public\.)?(\w+)\s*\(([^)]*)\)/gi)].map(
    (m) => ({ name: m[1].toLowerCase(), types: normalizeSignature(m[2]), at: m.index ?? 0 })
  );
}

/**
 * The schema as it stands after the whole migration history: for each
 * name+signature, the last definition — unless a later statement dropped it.
 */
function effectiveSchema(files: Array<{ file: string; text: string }>): Map<string, FunctionDef> {
  const current = new Map<string, FunctionDef>();

  for (const { file, text } of files) {
    const events = [
      ...definitionsIn(text, file).map((d) => ({ kind: "def" as const, ...d })),
      ...dropsIn(text).map((d) => ({ kind: "drop" as const, ...d })),
    ].sort((a, b) => a.at - b.at);

    for (const event of events) {
      const key = `${event.name}(${event.types})`;

      if (event.kind === "def") {
        current.set(key, { name: event.name, types: event.types, body: event.body, file });
      } else {
        current.delete(key);
      }
    }
  }

  return current;
}

const allMigrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((file) => ({ file, text: stripComments(readFileSync(join(migrationsDir, file), "utf-8")) }));

const schema = effectiveSchema(allMigrations);

function effective(key: string): FunctionDef {
  const def = schema.get(key);

  if (!def) {
    throw new Error(`no effective definition for ${key}`);
  }

  return def;
}

/** The body of the one definition in THIS migration with the given key. */
function bodyHere(key: string, text: string = executable): string {
  const def = definitionsIn(text, FILENAME).find((d) => `${d.name}(${d.types})` === key);

  if (!def) {
    throw new Error(`${FILENAME} does not define ${key}`);
  }

  return def.body;
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// Evaluating the SQL constants from the parsed AST
// ---------------------------------------------------------------------------

type AstNode = Record<string, unknown>;

function child(node: unknown, key: string): AstNode {
  const value = (node as AstNode | undefined)?.[key];

  if (value === null || typeof value !== "object") {
    throw new Error(`expected ${key} in ${JSON.stringify(node).slice(0, 120)}`);
  }

  return value as AstNode;
}

/** An integer A_Const. libpg-query omits `ival` inside the wrapper for zero. */
function intConst(node: unknown): number {
  const constant = child(node, "A_Const");
  const ival = child(constant, "ival");

  return typeof ival.ival === "number" ? ival.ival : 0;
}

/**
 * Evaluates `select case when <param> <op> <int> then <int> ... else <int> end`
 * for a given parameter value. Any other shape throws, so restructuring the SQL
 * fails this suite loudly instead of silently skipping a tier.
 */
async function evaluateCase(body: string, param: string, value: number): Promise<number> {
  const parsed = await parse(body);
  const select = child(parsed.stmts[0].stmt, "SelectStmt");
  const target = child((select.targetList as unknown[])[0], "ResTarget");
  const caseExpr = child(target.val, "CaseExpr");

  for (const arm of caseExpr.args as unknown[]) {
    const when = child(arm, "CaseWhen");
    const expr = child(when.expr, "A_Expr");
    const op = (child((expr.name as unknown[])[0], "String").sval as string) ?? "";
    const column = child(expr.lexpr, "ColumnRef");
    const columnName = child((column.fields as unknown[])[0], "String").sval;

    if (columnName !== param) {
      throw new Error(`unexpected column ${String(columnName)}`);
    }

    const bound = intConst(expr.rexpr);
    const matched =
      op === ">=" ? value >= bound
      : op === ">" ? value > bound
      : op === "=" ? value === bound
      : op === "<=" ? value <= bound
      : op === "<" ? value < bound
      : (() => {
          throw new Error(`unexpected operator ${op}`);
        })();

    if (matched) {
      return intConst(when.result);
    }
  }

  return intConst(caseExpr.defresult);
}

const EMPLOYEE_LADDER = "employee_login_employee_lock_seconds(integer)";
const DEVICE_TIERS = "employee_login_device_cooldown_seconds(integer)";

/** Expected lockout seconds for a NEW employee failure count. */
const EXPECTED_LADDER: Array<[number, number]> = [
  [0, 0], [1, 0], [2, 0], [3, 0], [4, 0],
  [5, 30], [6, 60], [7, 120], [8, 300],
  [9, 900], [10, 900], [11, 900], [25, 900], [1000, 900],
];

/** Expected whole-device cooldown for a rolling failure count. */
const EXPECTED_TIERS: Array<[number, number]> = [
  [0, 0], [1, 0], [13, 0], [14, 0],
  [15, 15], [16, 15], [19, 15],
  [20, 30], [21, 30], [24, 30],
  [25, 60], [26, 60], [40, 60], [1000, 60],
];

async function ladderFor(body: string): Promise<Array<[number, number]>> {
  const out: Array<[number, number]> = [];
  for (const [n] of EXPECTED_LADDER) out.push([n, await evaluateCase(body, "p_failed_count", n)]);
  return out;
}

async function tiersFor(body: string): Promise<Array<[number, number]>> {
  const out: Array<[number, number]> = [];
  for (const [n] of EXPECTED_TIERS) out.push([n, await evaluateCase(body, "p_recent_failures", n)]);
  return out;
}

// ===========================================================================
// Ordering, immutability, grammar
// ===========================================================================

describe("migration ordering and immutability", () => {
  it("sorts after the Feature 1A migration and everything before it", () => {
    for (const earlier of [PREVIOUS, "20260913120000_receipt_fidelity.sql"]) {
      expect(earlier < FILENAME).toBe(true);
    }
  });

  it("no later migration redefines the login or the selector", () => {
    // Later forward migrations may exist; the single-hash contract established
    // here must remain the effective one.
    const later = allMigrations.filter((m) => m.file > FILENAME);

    for (const { file, text } of later) {
      const redefined = definitionsIn(text, file).map((d) => `${d.name}(${d.types})`);

      expect(redefined).not.toContain("employee_login(uuid,text)");
      expect(redefined).not.toContain("list_login_employees()");
    }
  });

  it("leaves the applied Feature 1A migration byte-for-byte as staging received it", () => {
    // 20260914120000 is applied to staging and immutable. This is its SHA-256 at
    // checkpoint ba80054, the version that was applied.
    const digest = createHash("sha256")
      .update(readFileSync(join(migrationsDir, PREVIOUS)))
      .digest("hex");

    expect(digest).toBe("724279536d2ceb995e4c55606106e1ec0c7f2c2cdd6cb3c0a6f6790c6fc015fc");
  });
});

describe("PostgreSQL grammar", () => {
  it("parses the whole migration", async () => {
    expect((await parse(sql)).stmts.length).toBeGreaterThan(0);
  });

  it("uses no dynamic DDL of its own", () => {
    expect(executable).not.toMatch(/execute\s+format\s*\(/i);
  });

  for (const key of [EMPLOYEE_LADDER, DEVICE_TIERS]) {
    it(`the ${key} body parses as a single SELECT`, async () => {
      const parsed = await parse(bodyHere(key));

      expect(parsed.stmts).toHaveLength(1);
      expect(parsed.stmts[0].stmt).toHaveProperty("SelectStmt");
    });
  }
});

// ===========================================================================
// Retirement of the PIN-only contract
// ===========================================================================

describe("employee_login(text) is retired, with no compatibility wrapper", () => {
  it("drops the PIN-only signature explicitly, without CASCADE", () => {
    expect(executable).toContain("drop function public.employee_login(text);");
    expect(executable).not.toMatch(/drop[^;]*cascade/i);
  });

  it("the PIN-only signature is absent from the effective schema", () => {
    expect(schema.has("employee_login(text)")).toBe(false);
  });

  it("exactly one employee_login survives: (uuid, text)", () => {
    const logins = [...schema.keys()].filter((k) => k.startsWith("employee_login("));

    expect(logins).toEqual(["employee_login(uuid,text)"]);
  });

  it("the dead failure helper and its table are retired with it", () => {
    expect(executable).toContain("drop function public.employee_login_note_failure(uuid, timestamptz);");
    expect(schema.has("employee_login_note_failure(uuid,timestamptz)")).toBe(false);
    expect(executable).toContain("drop table public.employee_login_attempts;");
  });

  it("refuses to drop the old attempts table while it holds state", () => {
    const guard = executable.indexOf("if exists (select 1 from public.employee_login_attempts) then");
    const drop = executable.indexOf("drop table public.employee_login_attempts;");

    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(drop);
  });

  it("asserts the retirement at apply time", () => {
    expect(executable).toContain("if to_regprocedure('public.employee_login(text)') is not null then");
    expect(executable).toContain("expected exactly one employee_login overload");
  });

  it("NEGATIVE CONTROL: a later migration restoring employee_login(text) is detected", () => {
    const restored = [
      ...allMigrations,
      {
        file: "29991231000000_restore.sql",
        text:
          "create or replace function public.employee_login(p_pin text)\nreturns jsonb\n" +
          "language plpgsql as $function$ begin return null; end; $function$;",
      },
    ];

    expect(effectiveSchema(restored).has("employee_login(text)")).toBe(true);
  });
});

// ===========================================================================
// SINGLE BCRYPT PROOF
// ===========================================================================

describe("employee_login verifies exactly one hash", () => {
  const login = effective("employee_login(uuid,text)");

  it("the effective login is the one defined here", () => {
    expect(login.file).toBe(FILENAME);
  });

  it("calls the verifier exactly once", () => {
    expect(occurrences(login.body, "employee_pin_verify(")).toBe(1);
  });

  it("contains no iteration of any kind", () => {
    expect(login.body).not.toMatch(/\bloop\b/i);
    expect(login.body).not.toMatch(/\bforeach\b/i);
    expect(login.body).not.toMatch(/\bfor\s+v_\w+\s+in\b/i);
    expect(login.body).not.toMatch(/\bwhile\b/i);
  });

  it("resolves the selected employee by primary key, in this project, active only", () => {
    expect(login.body).toContain(
      "where e.id = p_employee_id\n    and e.project_id = v_device.project_id\n    and e.active;"
    );
  });

  it("no other effective function verifies a PIN", () => {
    const verifiers = [...schema.entries()]
      .filter(([key, def]) => key !== "employee_pin_verify(text,text)" && def.body.includes("employee_pin_verify("))
      .map(([key]) => key);

    expect(verifiers).toEqual(["employee_login(uuid,text)"]);
  });

  it("asserts the single verification at apply time", () => {
    expect(executable).toContain("employee_login must verify exactly one hash; found % calls");
    expect(executable).toContain("if v_def ~* '\\mloop\\M' or v_def ~* '\\mforeach\\M' then");
    expect(executable).toContain("only employee_login may verify a PIN; also found in: %");
  });

  it("NEGATIVE CONTROL: a roster scan reintroduced into login is detected", () => {
    const mutated = login.body.replace(
      "  if not public.employee_pin_verify(p_pin, v_employee.pin_hash) then",
      "  for v_employee in select * from public.employees loop\n  end loop;\n" +
        "  if not public.employee_pin_verify(p_pin, v_employee.pin_hash) then"
    );

    expect(mutated).toMatch(/\bloop\b/i);
  });

  it("NEGATIVE CONTROL: a second verification is detected", () => {
    const mutated = `${login.body}\nperform public.employee_pin_verify(p_pin, 'x');`;

    expect(occurrences(mutated, "employee_pin_verify(")).toBe(2);
  });

  it("NEGATIVE CONTROL: another function verifying a PIN is detected", () => {
    const extra = [
      ...allMigrations,
      {
        file: "29991231000000_extra.sql",
        text:
          "create or replace function public.sneaky(p_pin text)\nreturns boolean\n" +
          "language plpgsql as $function$ begin return public.employee_pin_verify(p_pin, 'x'); end; $function$;",
      },
    ];
    const verifiers = [...effectiveSchema(extra).entries()]
      .filter(([key, def]) => key !== "employee_pin_verify(text,text)" && def.body.includes("employee_pin_verify("))
      .map(([key]) => key);

    expect(verifiers).toContain("sneaky(text)");
  });
});

// ===========================================================================
// Duplicate-PIN enforcement removed
// ===========================================================================

describe("duplicate-PIN scanning is gone", () => {
  const OWNER_WRITERS = ["create_employee(uuid,text,text,text)", "set_employee_pin(uuid,text)"];

  for (const key of OWNER_WRITERS) {
    it(`${key} no longer verifies, scans, or reports a duplicate`, () => {
      // Both the definition written here and whatever is effective now.
      for (const body of [bodyHere(key), effective(key).body]) {
        expect(body).not.toContain("employee_pin_verify");
        expect(body).not.toContain("employee_project_pin_taken");
        expect(body).not.toContain("duplicate_pin");
        expect(body).not.toMatch(/\bloop\b/i);
      }

      const def = effective(key);

      expect(def.body).not.toContain("employee_pin_verify");
      expect(def.body).not.toContain("employee_project_pin_taken");
      expect(def.body).not.toContain("duplicate_pin");
      expect(def.body).not.toMatch(/\bloop\b/i);
    });

    it(`${key} still stores only a salted hash`, () => {
      expect(effective(key).body).toContain("public.employee_pin_hash(p_pin)");
    });
  }

  it("the duplicate-PIN helper is dropped, after both callers are replaced", () => {
    const drop = executable.indexOf("drop function public.employee_project_pin_taken(uuid, text, uuid);");

    expect(drop).toBeGreaterThan(executable.indexOf("create or replace function public.create_employee("));
    expect(drop).toBeGreaterThan(executable.indexOf("create or replace function public.set_employee_pin("));
    expect(schema.has("employee_project_pin_taken(uuid,text,uuid)")).toBe(false);
  });

  it("no deterministic PIN representation replaced the rule", () => {
    expect(executable).not.toMatch(/sha256\s*\(\s*[^)]*p_pin/i);
    expect(executable).not.toMatch(/md5\s*\(\s*[^)]*p_pin/i);
    expect(executable).not.toMatch(/digest\s*\(\s*[^)]*p_pin/i);
    expect(executable).not.toMatch(/pgp_sym_encrypt/i);

    for (const index of executable.match(/create (unique )?index[^;]*;/gi) ?? []) {
      expect(index).not.toMatch(/pin/i);
    }
  });

  it("asserts the removal at apply time", () => {
    expect(executable).toContain("% still performs duplicate-PIN enforcement");
    expect(executable).toContain("the duplicate-PIN helper employee_project_pin_taken was not retired");
  });

  it("NEGATIVE CONTROL: restoring the scan in create_employee is detected", () => {
    const body = effective("create_employee(uuid,text,text,text)").body.replace(
      "  insert into public.employees",
      "  if public.employee_project_pin_taken(p_project_id, p_pin, null) then\n" +
        "    return jsonb_build_object('ok', false, 'error', 'duplicate_pin');\n  end if;\n\n" +
        "  insert into public.employees"
    );

    expect(body).toContain("employee_project_pin_taken");
    expect(body).toContain("duplicate_pin");
  });
});

// ===========================================================================
// The provisional ceiling, as this migration left it
// ===========================================================================

// The ceiling was deliberately left in place by THIS migration and removed later
// by 20260916130000 after staging validation. These tests describe what this
// file did; the effective schema is covered by the later migration's suite.
describe("this migration left the 50 active-employee engineering ceiling in place", () => {
  it("its create_employee still enforced it", () => {
    expect(bodyHere("create_employee(uuid,text,text,text)")).toContain("if v_active_count >= 50 then");
  });

  it("set_employee_active is not redefined here", () => {
    const defined = definitionsIn(executable, FILENAME).map((d) => `${d.name}(${d.types})`);

    expect(defined).not.toContain("set_employee_active(uuid,boolean)");
  });

  it("is described as provisional, never as a product limit", () => {
    expect(sql).toContain("provisional engineering safety value");
    expect(sql).toContain("It is not a product limit.");
    expect(sql).not.toMatch(/supports up to 50|maximum of 50 employees/i);
  });

  it("asserts its presence at apply time", () => {
    expect(executable).toContain("the provisional 50 active-employee ceiling is missing from %");
  });
});

// ===========================================================================
// The selector
// ===========================================================================

describe("list_login_employees", () => {
  const body = bodyHere("list_login_employees()");
  const payload = body.slice(body.indexOf("jsonb_build_object('employeeId'"));
  const entry = payload.slice(0, payload.indexOf(")") + 1);

  it("takes no arguments", () => {
    expect(executable).toContain("create or replace function public.list_login_employees()\nreturns jsonb");
  });

  it("derives the project from the caller's ACTIVE pairing row", () => {
    expect(body).toContain("v_caller := auth.uid();");
    expect(body).toContain(
      "where d.auth_user_id = v_caller\n    and d.revoked_at is null\n    and d.unpaired_at is null;"
    );
    expect(body).toContain("where e.project_id = v_project_id\n    and e.active;");
  });

  it("returns exactly employeeId and displayName per entry", () => {
    const keys = [...entry.matchAll(/'(\w+)'\s*,/g)].map((m) => m[1]);

    expect(entry).toBe("jsonb_build_object('employeeId', e.id, 'displayName', e.display_name)");
    expect(keys).toEqual(["employeeId", "displayName"]);
  });

  it("never names role, PIN, hash, owner, project or account state in its output", () => {
    const output = body.slice(body.indexOf("select coalesce("));

    for (const leak of ["role", "pin", "owner", "deactivated", "active'", "project_id'", "failed", "locked"]) {
      expect(output.toLowerCase()).not.toContain(leak);
    }
  });

  it("orders by display name then id — not by hire date", () => {
    expect(body).toContain("order by e.display_name, e.id");
    expect(body).not.toContain("created_at");
  });

  it("refuses unauthenticated and unpaired callers with the device vocabulary", () => {
    expect(body).toContain("'error', 'not_authenticated'");
    expect(body).toContain("'error', 'not_paired'");
  });

  it("is stable, SECURITY DEFINER, with the locked search_path", () => {
    const header = executable.slice(
      executable.indexOf("create or replace function public.list_login_employees()"),
      executable.indexOf("as $function$", executable.indexOf("create or replace function public.list_login_employees()"))
    );

    expect(header).toContain("stable");
    expect(header).toContain("security definer");
    expect(header).toContain("set search_path = public, pg_temp");
  });

  it("writes nothing", () => {
    expect(body).not.toMatch(/\b(insert|update|delete)\b/i);
    expect(body).not.toContain("for update");
  });

  it("NEGATIVE CONTROL: adding role to the entry is detected", () => {
    const mutated = entry.replace("'displayName', e.display_name)", "'displayName', e.display_name, 'role', e.role)");
    const keys = [...mutated.matchAll(/'(\w+)'\s*,/g)].map((m) => m[1]);

    expect(keys).not.toEqual(["employeeId", "displayName"]);
  });

  it("NEGATIVE CONTROL: dropping the active filter is detected", () => {
    const mutated = body.replace("where e.project_id = v_project_id\n    and e.active;", "where e.project_id = v_project_id;");

    expect(mutated).not.toContain("and e.active;");
  });
});

// ===========================================================================
// Login contract and generic failure
// ===========================================================================

describe("employee_login(p_employee_id, p_pin)", () => {
  const body = bodyHere("employee_login(uuid,text)");

  it("has exactly that signature and no identity parameters", () => {
    expect(executable).toContain(
      "create or replace function public.employee_login(p_employee_id uuid, p_pin text)"
    );

    for (const claimed of ["p_project_id", "p_device_id", "p_paired_device_id", "p_role", "p_owner_id"]) {
      expect(body).not.toContain(claimed);
    }
  });

  it("uses the Feature 25.1 active-device predicate", () => {
    expect(body).toContain(
      "where d.auth_user_id = v_caller\n    and d.revoked_at is null\n    and d.unpaired_at is null\n  for update;"
    );
  });

  it("writes the generic failure once and returns it from every credential path", () => {
    expect(occurrences(body, "'invalid_credentials'")).toBe(1);
    expect(occurrences(body, "return v_generic_failure;")).toBe(3);
  });

  it("validates PIN shape server-side without repairing it", () => {
    expect(body).toContain("if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then");

    for (const repair of ["trim(p_pin", "btrim(p_pin", "lpad(p_pin", "replace(p_pin", "regexp_replace(p_pin"]) {
      expect(body).not.toContain(repair);
    }
  });

  it("returns only the approved session fields on success", () => {
    const success = body.slice(body.lastIndexOf("return jsonb_build_object("));
    const keys = [...success.matchAll(/'(\w+)'\s*,/g)].map((m) => m[1]);

    expect(keys).toEqual(["ok", "employeeSessionId", "employeeId", "displayName", "role", "startedAt"]);

    for (const leak of ["pin_hash", "p_pin", "failed_count", "locked_until", "throttled_until", "owner_id"]) {
      expect(success).not.toContain(leak);
    }
  });

  it("preserves login-as-switch and the one-open-session backstop", () => {
    expect(body).toContain("set ended_at = v_now,\n      end_reason = 'switched'");
    expect(executable).toContain("employee_pos_sessions_one_open_per_device is missing or weakened");
  });

  it("never passes PIN material as an argument to a raise", () => {
    for (const raise of executable.match(/raise exception[^;]*/g) ?? []) {
      const args = raise.replace(/'[^']*'/g, "");

      for (const secret of ["p_pin", "pin_hash"]) {
        expect(args).not.toContain(secret);
      }
    }
  });
});

// ===========================================================================
// Failure accounting — which path writes which limiter
// ===========================================================================

/** The text of the `if ... then ... end if;` block that begins with `opening`. */
function ifBlock(body: string, opening: string): string {
  const start = body.indexOf(opening);

  if (start < 0) {
    throw new Error(`block not found: ${opening}`);
  }

  return body.slice(start, body.indexOf("end if;", start) + "end if;".length);
}

describe("failure accounting (structural — behaviour is proven on staging)", () => {
  const body = bodyHere("employee_login(uuid,text)");

  const throttled = ifBlock(body, "if v_throttled_until is not null and v_throttled_until > v_now then");
  const notFound = ifBlock(body, "if not found then\n    perform");
  const employeeLocked = ifBlock(body, "if v_locked_until is not null and v_locked_until > v_now then");
  const malformed = ifBlock(body, "if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then");
  const wrongPin = ifBlock(body, "if not public.employee_pin_verify(p_pin, v_employee.pin_hash) then");
  const success = body.slice(body.indexOf(wrongPin) + wrongPin.length);

  const WRITES = /\b(perform|insert|update|delete)\b/i;

  it("a request during a device throttle writes nothing and reports the wait", () => {
    expect(throttled).not.toMatch(WRITES);
    expect(throttled).toContain("'error', 'locked_out'");
    expect(throttled).toContain("'retryAfterSeconds'");
  });

  it("a request during an employee lock writes nothing and reports the wait", () => {
    expect(employeeLocked).not.toMatch(WRITES);
    expect(employeeLocked).toContain("'error', 'locked_out'");
    expect(employeeLocked).toContain("'retryAfterSeconds'");
  });

  it("nonexistent / other-project / inactive: one device failure, no employee failure", () => {
    expect(occurrences(notFound, "employee_login_record_device_failure(")).toBe(1);
    expect(notFound).not.toContain("employee_login_record_employee_failure");
  });

  it("malformed PIN: one device failure, no employee failure", () => {
    expect(occurrences(malformed, "employee_login_record_device_failure(")).toBe(1);
    expect(malformed).not.toContain("employee_login_record_employee_failure");
  });

  it("valid active employee + wrong PIN: exactly one of each", () => {
    expect(occurrences(wrongPin, "employee_login_record_employee_failure(")).toBe(1);
    expect(occurrences(wrongPin, "employee_login_record_device_failure(")).toBe(1);
  });

  it("the device throttle is checked before the employee is even looked up", () => {
    expect(body.indexOf(throttled)).toBeLessThan(body.indexOf("from public.employees e"));
  });

  it("the employee lock is checked before the PIN shape and before the hash", () => {
    expect(body.indexOf(employeeLocked)).toBeLessThan(body.indexOf(malformed));
    expect(body.indexOf(malformed)).toBeLessThan(body.indexOf(wrongPin));
  });

  it("success clears only this employee at this till, and keeps device history", () => {
    expect(success).toContain(
      "delete from public.employee_login_employee_attempts a\n  where a.paired_device_id = v_device.id\n    and a.employee_id = v_employee.id;"
    );
    expect(success).not.toContain("delete from public.employee_login_device_failures");
    expect(success).not.toContain("employee_login_record_");
  });

  it("success removes a throttle row only once it has expired AND the window is empty", () => {
    expect(success).toContain("and t.throttled_until <= v_now\n    and not exists (");
  });

  it("login itself never establishes or extends a cooldown", () => {
    expect(body).not.toMatch(/insert into public\.employee_login_device_throttles/);
    expect(body).not.toMatch(/update public\.employee_login_device_throttles/);
  });

  it("NEGATIVE CONTROL: counting a malformed PIN against the employee is detected", () => {
    const mutated = malformed.replace(
      "perform public.employee_login_record_device_failure",
      "perform public.employee_login_record_employee_failure(v_device.id, v_employee.id, v_now);\n    perform public.employee_login_record_device_failure"
    );

    expect(mutated).toContain("employee_login_record_employee_failure");
  });

  it("NEGATIVE CONTROL: dropping malformed-PIN accounting is detected", () => {
    const mutated = malformed.replace(/\s*perform public\.employee_login_record_device_failure\([^)]*\);/, "");

    expect(occurrences(mutated, "employee_login_record_device_failure(")).toBe(0);
  });

  it("NEGATIVE CONTROL: writing during a throttle is detected", () => {
    const mutated = throttled.replace(
      "    return jsonb_build_object(",
      "    perform public.employee_login_record_device_failure(v_device.id, v_now);\n    return jsonb_build_object("
    );

    expect(mutated).toMatch(WRITES);
  });

  it("NEGATIVE CONTROL: success wiping device history is detected", () => {
    const mutated = `${success}\ndelete from public.employee_login_device_failures f where f.paired_device_id = v_device.id;`;

    expect(mutated).toContain("delete from public.employee_login_device_failures");
  });
});

// ===========================================================================
// The locked constants, evaluated from the SQL
// ===========================================================================

describe("the employee/device lockout ladder", () => {
  const body = bodyHere(EMPLOYEE_LADDER);

  it("is exactly 1-4 none, 5=30, 6=60, 7=120, 8=300, 9+=900", async () => {
    expect(await ladderFor(body)).toEqual(EXPECTED_LADDER);
  });

  it("is immutable and granted to nobody", () => {
    const header = executable.slice(
      executable.indexOf(`create or replace function public.${EMPLOYEE_LADDER.replace("(integer)", "(p_failed_count integer)")}`),
      executable.indexOf("as $function$", executable.indexOf("employee_login_employee_lock_seconds(p_failed_count"))
    );

    expect(header).toContain("immutable");
  });

  it("is applied to the NEW count, after the increment", () => {
    const writer = bodyHere("employee_login_record_employee_failure(uuid,uuid,timestamptz)");

    expect(writer.indexOf("failed_count = a.failed_count + 1")).toBeLessThan(
      writer.indexOf("v_lock := public.employee_login_employee_lock_seconds(v_count);")
    );
    expect(writer).toContain("returning failed_count into v_count;");
  });

  for (const [from, to, label] of [
    ["when p_failed_count = 5 then 30", "when p_failed_count = 5 then 20", "5 -> 30"],
    ["when p_failed_count >= 9 then 900", "when p_failed_count >= 9 then 600", "900 cap"],
    ["when p_failed_count >= 9 then 900", "when p_failed_count >= 10 then 900", "9+ threshold"],
    ["when p_failed_count = 8 then 300", "when p_failed_count = 8 then 120", "8 -> 300"],
  ] as const) {
    it(`NEGATIVE CONTROL: changing ${label} is detected`, async () => {
      expect(body).toContain(from);

      expect(await ladderFor(body.replace(from, to))).not.toEqual(EXPECTED_LADDER);
    });
  }
});

describe("the whole-device throttle", () => {
  const body = bodyHere(DEVICE_TIERS);

  it("is exactly 1-14 none, 15-19 = 15, 20-24 = 30, 25+ = 60", async () => {
    expect(await tiersFor(body)).toEqual(EXPECTED_TIERS);
  });

  it("never exceeds 60 seconds, and has no 120-second tier", async () => {
    for (const n of [25, 50, 100, 10_000]) {
      expect(await evaluateCase(body, "p_recent_failures", n)).toBe(60);
    }

    expect(body).not.toContain("120");
  });

  it("asserts the constants live at apply time", () => {
    expect(executable).toContain("device cooldown for % recent failures is %, expected %");
    expect(executable).toContain("employee lockout for % failures is %, expected %");
    expect(executable).toContain("(14, 0), (15, 15), (19, 15), (20, 30)");
    expect(executable).toContain("(24, 30), (25, 60), (26, 60), (1000, 60)");
  });

  for (const [from, to, label] of [
    ["when p_recent_failures >= 15 then 15", "when p_recent_failures >= 14 then 15", "15 threshold"],
    ["when p_recent_failures >= 15 then 15", "when p_recent_failures > 15 then 15", "15 inclusive"],
    ["when p_recent_failures >= 20 then 30", "when p_recent_failures >= 20 then 45", "20 -> 30"],
    ["when p_recent_failures >= 25 then 60", "when p_recent_failures >= 25 then 120", "60 cap"],
    ["when p_recent_failures >= 25 then 60", "when p_recent_failures >= 30 then 60", "25 threshold"],
  ] as const) {
    it(`NEGATIVE CONTROL: changing ${label} is detected`, async () => {
      expect(body).toContain(from);

      expect(await tiersFor(body.replace(from, to))).not.toEqual(EXPECTED_TIERS);
    });
  }
});

// ===========================================================================
// Rolling window and device-failure writer
// ===========================================================================

describe("the rolling 300-second window", () => {
  const writer = bodyHere("employee_login_record_device_failure(uuid,timestamptz)");
  const WINDOW = "and f.failed_at >= p_now - interval '300 seconds';";

  it("is inclusive and exactly 300 seconds", () => {
    expect(writer).toContain(WINDOW);
  });

  it("writes exactly one event per call", () => {
    expect(occurrences(writer, "insert into public.employee_login_device_failures")).toBe(1);
  });

  it("counts AFTER writing, so the new failure is included", () => {
    expect(writer.indexOf("insert into public.employee_login_device_failures")).toBeLessThan(
      writer.indexOf("select count(*) into v_recent")
    );
  });

  it("sets a cooldown only from that fresh count, and never shortens one", () => {
    expect(writer).toContain("v_cooldown := public.employee_login_device_cooldown_seconds(v_recent);");
    expect(writer).toContain("if v_cooldown > 0 then");
    expect(writer).toContain("set throttled_until = greatest(t.throttled_until, excluded.throttled_until),");
  });

  it("expires physically only beyond 24 hours, and only for this device", () => {
    expect(writer).toContain(
      "where f.paired_device_id = p_paired_device_id\n    and f.failed_at < p_now - interval '24 hours';"
    );
    expect(writer).toContain(
      "and (a.locked_until is null or a.locked_until <= p_now)\n    and a.last_failed_at < p_now - interval '24 hours';"
    );
  });

  it("the login uses the same window when deciding a throttle row is removable", () => {
    expect(bodyHere("employee_login(uuid,text)")).toContain(
      "and f.failed_at >= v_now - interval '300 seconds'"
    );
  });

  it("NEGATIVE CONTROL: an exclusive boundary is detected", () => {
    expect(writer.replace(">= p_now - interval '300 seconds'", "> p_now - interval '300 seconds'")).not.toContain(WINDOW);
  });

  it("NEGATIVE CONTROL: a different window length is detected", () => {
    expect(writer.replace("'300 seconds'", "'600 seconds'")).not.toContain(WINDOW);
  });

  it("NEGATIVE CONTROL: counting before writing is detected", () => {
    const insert = "  insert into public.employee_login_device_failures (paired_device_id, failed_at)\n  values (p_paired_device_id, p_now);\n";
    const count = writer.indexOf("  select count(*) into v_recent");
    const mutated = writer.replace(insert, "");
    const reordered = `${mutated.slice(0, mutated.indexOf("  v_cooldown :="))}${insert}${mutated.slice(mutated.indexOf("  v_cooldown :="))}`;

    expect(count).toBeGreaterThan(-1);
    expect(reordered.indexOf("insert into public.employee_login_device_failures")).toBeGreaterThan(
      reordered.indexOf("select count(*) into v_recent")
    );
  });
});

// ===========================================================================
// Serialization (structural — concurrency is proven on staging)
// ===========================================================================

describe("lock order", () => {
  const body = bodyHere("employee_login(uuid,text)");
  const lockAt = body.indexOf("for update;");

  function firstLimiterTouch(text: string): number {
    return Math.min(
      ...["employee_login_device_throttles", "employee_login_employee_attempts", "employee_login_record_"]
        .map((needle) => text.indexOf(needle))
        .filter((at) => at >= 0)
    );
  }

  it("locks the paired device before any limiter state is read or written", () => {
    expect(lockAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(firstLimiterTouch(body));
  });

  /** The statement that resolves the caller's pairing row, up to its semicolon. */
  function deviceSelect(text: string): string {
    const start = text.indexOf("select d.id, d.project_id");

    return text.slice(start, text.indexOf(";", start) + 1);
  }

  it("the first lock is the paired_devices row", () => {
    expect(body.slice(0, lockAt)).toContain("from public.paired_devices d");
    expect(deviceSelect(body)).toMatch(/for update;$/);
  });

  it("then locks the selected employee's attempt row", () => {
    const second = body.indexOf("for update;", lockAt + 1);

    expect(second).toBeGreaterThan(lockAt);
    expect(body.slice(lockAt + 1, second)).toContain("from public.employee_login_employee_attempts a");
  });

  it("reads the clock only after the device lock is granted", () => {
    expect(body.indexOf("v_now := clock_timestamp();")).toBeGreaterThan(lockAt);
    expect(body).not.toMatch(/\bnow\(\)/);
  });

  it("every limiter writer is private and only reachable from inside login", () => {
    for (const helper of [
      "employee_login_record_employee_failure(uuid, uuid, timestamptz)",
      "employee_login_record_device_failure(uuid, timestamptz)",
    ]) {
      expect(executable).not.toContain(`grant execute on function public.${helper}`);
    }

    const callers = [...schema.entries()]
      .filter(([, def]) => def.body.includes("employee_login_record_"))
      .map(([key]) => key)
      .filter((key) => !key.startsWith("employee_login_record_"));

    expect(callers).toEqual(["employee_login(uuid,text)"]);
  });

  it("asserts the lock order at apply time", () => {
    expect(executable).toContain("employee_login must lock the paired device before any limiter access");
    expect(executable).toContain("employee_login must read the clock after the device lock");
  });

  it("NEGATIVE CONTROL: checking the throttle before locking is detected", () => {
    const throttleRead =
      "  select t.throttled_until\n  into v_throttled_until\n  from public.employee_login_device_throttles t\n  where t.paired_device_id = v_device.id;\n";
    const mutated = body.replace(throttleRead, "").replace("  select d.id, d.project_id", `${throttleRead}  select d.id, d.project_id`);

    expect(mutated.indexOf("for update;")).toBeGreaterThan(firstLimiterTouch(mutated));
  });

  it("NEGATIVE CONTROL: removing the device lock is detected", () => {
    const mutated = body.replace("    and d.unpaired_at is null\n  for update;", "    and d.unpaired_at is null;");

    expect(mutated).not.toBe(body);
    expect(deviceSelect(mutated)).not.toMatch(/for update;$/);
  });
});

// ===========================================================================
// Privileges and RLS
// ===========================================================================

const NEW_TABLES = [
  "employee_login_employee_attempts",
  "employee_login_device_failures",
  "employee_login_device_throttles",
] as const;

const PUBLIC_SIGNATURES = [
  "public.list_login_employees()",
  "public.employee_login(uuid, text)",
  "public.create_employee(uuid, text, text, text)",
  "public.set_employee_pin(uuid, text)",
] as const;

const PRIVATE_SIGNATURES = [
  "public.employee_login_employee_lock_seconds(integer)",
  "public.employee_login_device_cooldown_seconds(integer)",
  "public.employee_login_record_employee_failure(uuid, uuid, timestamptz)",
  "public.employee_login_record_device_failure(uuid, timestamptz)",
] as const;

describe("limiter tables are RPC-only", () => {
  for (const table of NEW_TABLES) {
    it(`${table}: RLS on, every role revoked`, () => {
      expect(executable).toContain(`alter table public.${table} enable row level security;`);

      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(executable).toContain(`revoke all privileges on table public.${table} from ${role};`);
      }
    });
  }

  it("grants no table privilege to anyone and creates no policy", () => {
    expect(executable.match(/grant [^;]*on table [^;]*;/gi) ?? []).toEqual([]);
    expect(executable).not.toMatch(/create policy/i);
  });

  it("introduces no sequence for default privileges to leak", () => {
    expect(executable).not.toMatch(/generated\s+(always|by default)\s+as\s+identity/i);
    expect(executable).not.toMatch(/\bserial\b/i);
    expect(executable).not.toMatch(/create sequence/i);
  });

  it("keys the two limiter layers exactly as approved", () => {
    expect(executable).toContain(
      "constraint employee_login_employee_attempts_pkey\n    primary key (paired_device_id, employee_id)"
    );
    expect(executable).toContain(
      "on public.employee_login_device_failures using btree (paired_device_id, failed_at)"
    );
    expect(executable).toMatch(/create table if not exists public\.employee_login_device_throttles \(\n  paired_device_id uuid primary key/);
  });

  it("asserts table posture at apply time", () => {
    expect(executable).toContain("row level security is not enabled on %");
    expect(executable).toContain("% must carry no policy");
    expect(executable).toContain("% holds % on %");
  });

  it("NEGATIVE CONTROL: a browser grant on a limiter table is detected", () => {
    const mutated = `${executable}\ngrant select on table public.employee_login_device_failures to authenticated;`;

    expect(mutated.match(/grant [^;]*on table [^;]*;/gi) ?? []).not.toEqual([]);
  });
});

describe("function privileges", () => {
  for (const sig of PUBLIC_SIGNATURES) {
    it(`${sig}: revoked from public, anon, service_role; granted to authenticated only`, () => {
      const iPublic = executable.indexOf(`revoke all on function ${sig} from public;`);
      const iAnon = executable.indexOf(`revoke all on function ${sig} from anon;`);
      const iService = executable.indexOf(`revoke all on function ${sig} from service_role;`);
      const iGrant = executable.indexOf(`grant execute on function ${sig} to authenticated;`);

      expect(iPublic).toBeGreaterThan(-1);
      expect(iPublic).toBeLessThan(iAnon);
      expect(iAnon).toBeLessThan(iService);
      expect(iService).toBeLessThan(iGrant);
      expect(executable).not.toContain(`grant execute on function ${sig} to anon;`);
      expect(executable).not.toContain(`grant execute on function ${sig} to service_role;`);
    });
  }

  for (const sig of PRIVATE_SIGNATURES) {
    it(`${sig}: executable by nobody`, () => {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(executable).toContain(`revoke all on function ${sig} from ${role};`);
      }

      expect(executable).not.toContain(`grant execute on function ${sig}`);
    });
  }

  it("never grants anything to service_role or anon", () => {
    expect(executable).not.toMatch(/grant[^;]*to (service_role|anon)\b/i);
  });

  it("every function defined here is SECURITY DEFINER with exactly public, pg_temp", () => {
    const headers = [...executable.matchAll(/create or replace function public\.\w+\([^)]*\)[\s\S]*?as \$function\$/g)];

    expect(headers.length).toBe(8);

    for (const [header] of headers) {
      expect(header).toContain("security definer");
      expect(header).toContain("set search_path = public, pg_temp");
    }

    expect([...new Set(executable.match(/set search_path[^\n]*/g))]).toEqual([
      "set search_path = public, pg_temp",
    ]);
  });

  it("asserts the grant matrix at apply time", () => {
    expect(executable).toContain("service_role must NOT be able to execute %");
    expect(executable).toContain("anon must NOT be able to execute %");
    expect(executable).toContain("% is private and % must not execute it");
  });

  it("NEGATIVE CONTROL: removing a service_role revoke is detected", () => {
    const sig = "public.list_login_employees()";
    const mutated = executable.replace(`revoke all on function ${sig} from service_role;\n`, "");

    expect(mutated).not.toContain(`revoke all on function ${sig} from service_role;`);
  });

  it("NEGATIVE CONTROL: a widened search_path is detected", () => {
    const mutated = executable.replace(
      "set search_path = public, pg_temp",
      "set search_path = public, extensions, pg_temp"
    );

    expect([...new Set(mutated.match(/set search_path[^\n]*/g))]).not.toEqual([
      "set search_path = public, pg_temp",
    ]);
  });

  it("NEGATIVE CONTROL: dropping SECURITY DEFINER is detected", () => {
    const mutated = executable.replace(
      "returns jsonb\nlanguage plpgsql\nstable\nsecurity definer",
      "returns jsonb\nlanguage plpgsql\nstable\nsecurity invoker"
    );
    const headers = [...mutated.matchAll(/create or replace function public\.\w+\([^)]*\)[\s\S]*?as \$function\$/g)];

    expect(headers.some(([h]) => !h.includes("security definer"))).toBe(true);
  });
});

// ===========================================================================
// Inertness and history
// ===========================================================================

describe("the rest of the schema is untouched", () => {
  it("captures its baselines before any DDL", () => {
    const baseline = executable.indexOf("create temporary table f1a1_proc_baseline");
    const firstDdl = executable.indexOf("drop function public.employee_login(text);");

    expect(baseline).toBeGreaterThan(-1);
    expect(baseline).toBeLessThan(firstDdl);
  });

  it("excludes from the function baseline only what it deliberately replaces or drops", () => {
    const list = executable.slice(
      executable.indexOf("and p.proname not in ("),
      executable.indexOf(");", executable.indexOf("and p.proname not in ("))
    );
    const names = [...list.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();

    expect(names).toEqual(
      [
        "create_employee",
        "employee_login",
        "employee_login_note_failure",
        "employee_project_pin_taken",
        "set_employee_pin",
      ].sort()
    );
  });

  it("redefines nothing outside the employee contract", () => {
    const defined = definitionsIn(executable, FILENAME).map((d) => d.name).sort();

    expect(defined).toEqual(
      [
        "create_employee",
        "employee_login",
        "employee_login_device_cooldown_seconds",
        "employee_login_employee_lock_seconds",
        "employee_login_record_device_failure",
        "employee_login_record_employee_failure",
        "list_login_employees",
        "set_employee_pin",
      ].sort()
    );
  });

  it("names no sale, checkout, receipt, inventory or pairing function", () => {
    for (const forbidden of [
      "complete_sale",
      "resolve_sale_owner",
      "restock_inventory",
      "adjust_inventory",
      "redeem_device_pairing_token",
      "revoke_paired_device",
      "unpair_own_device",
      "apply_device_config_update",
      "get_device_recent_orders",
      "paired_devices_guard_immutable_columns",
    ]) {
      expect(executable).not.toContain(forbidden);
    }
  });

  it("alters no existing table and touches no paired_devices policy, grant or trigger", () => {
    for (const alter of executable.match(/alter table public\.(\w+)/g) ?? []) {
      expect(NEW_TABLES.some((t) => alter.endsWith(t))).toBe(true);
    }

    expect(executable).not.toMatch(/on table public\.paired_devices/);
    expect(executable).not.toMatch(/create (or replace )?trigger/i);
    expect(executable).not.toMatch(/add column|drop column/i);
  });

  it("proves employee and session history are preserved", () => {
    expect(executable).toContain("F1A.1: employee history changed");
    expect(executable).toContain("F1A.1: employee session history changed");
    expect(executable).toContain("the employees or employee_pos_sessions columns changed");
    expect([...executable.matchAll(/drop table public\.(\w+)/g)].map((m) => m[1])).toEqual([
      "employee_login_attempts",
    ]);
  });

  it("proves every other function, policy, privilege and trigger is unchanged", () => {
    for (const message of [
      "F1A.1: pre-existing function %(%) changed",
      "F1A.1: the set of public policies changed",
      "F1A.1: privilege % on % for % changed",
      "F1A.1: trigger %.% changed or was removed",
      "F1A.1: unexpected new triggers: %",
      "F1A.1: paired_devices changed",
    ]) {
      expect(executable).toContain(message);
    }
  });

  it("refuses unauthenticated calls at apply time, with caller identity cleared first", () => {
    const clear = executable.indexOf("perform set_config('request.jwt.claims', '', true);");
    const smoke = executable.indexOf("public.employee_login(null, null)");

    expect(clear).toBeGreaterThan(-1);
    expect(clear).toBeLessThan(smoke);
  });
});
