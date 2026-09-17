// v1.3 Feature 1A.1 follow-up — static guards for removing the temporary
// engineering active-employee safeguard.
//
// SCOPE. No database was contacted for this migration and it has not been
// applied anywhere. These tests prove, from the SQL source and the ordered
// migration history:
//
//   * the two redefined functions are byte-for-byte their predecessors with
//     ONLY the safeguard deleted;
//   * no replacement roster rule exists under any number, name or error code;
//   * the Feature 1A / 1A.1 contract that staging validated is untouched;
//   * both already-applied migrations are unchanged.
//
// Negative controls mutate copies of the SQL and prove each guard would fail.
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
const FILENAME = "20260916130000_remove_active_employee_engineering_ceiling.sql";
const F1A = "20260914120000_employee_identity_and_pos_sessions.sql";
const F1A1 = "20260916120000_employee_selector_single_hash_login.sql";

const read = (file: string) => readFileSync(join(migrationsDir, file), "utf-8");
const sql = read(FILENAME);

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
// Effective-schema resolution (same approach as the 1A.1 suite)
// ---------------------------------------------------------------------------

type FunctionDef = { name: string; types: string; body: string; file: string };

function typesOf(params: string): string {
  return params
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.replace(/\s+default\s+.*$/i, "").split(/\s+/).slice(1).join(" "))
    .join(",");
}

function definitionsIn(text: string, file: string): Array<FunctionDef & { at: number }> {
  const out: Array<FunctionDef & { at: number }> = [];

  for (const match of text.matchAll(/create or replace function (?:public\.)?(\w+)\s*\(([^)]*)\)\s*returns/gi)) {
    const start = (match.index ?? 0) + match[0].length;
    const opener = /\bas\s+(\$\w*\$)/i.exec(text.slice(start));

    if (!opener) {
      continue;
    }

    const bodyStart = start + opener.index + opener[0].length;

    out.push({
      name: match[1].toLowerCase(),
      types: typesOf(match[2]),
      body: text.slice(bodyStart, text.indexOf(opener[1], bodyStart)),
      file,
      at: match.index ?? 0,
    });
  }

  return out;
}

function dropsIn(text: string): Array<{ name: string; types: string; at: number }> {
  return [...text.matchAll(/drop function (?:if exists )?(?:public\.)?(\w+)\s*\(([^)]*)\)/gi)].map((m) => ({
    name: m[1].toLowerCase(),
    types: m[2].split(",").map((a) => a.trim()).filter(Boolean).join(","),
    at: m.index ?? 0,
  }));
}

function effectiveSchema(files: Array<{ file: string; text: string }>): Map<string, FunctionDef> {
  const current = new Map<string, FunctionDef>();

  for (const { file, text } of files) {
    const events = [
      ...definitionsIn(text, file).map((d) => ({ kind: "def" as const, ...d })),
      ...dropsIn(text).map((d) => ({ kind: "drop" as const, ...d })),
    ].sort((a, b) => a.at - b.at);

    for (const e of events) {
      const key = `${e.name}(${e.types})`;

      if (e.kind === "def") {
        current.set(key, { name: e.name, types: e.types, body: e.body, file });
      } else {
        current.delete(key);
      }
    }
  }

  return current;
}

const orderedFiles = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
const allMigrations = orderedFiles.map((file) => ({ file, text: stripComments(read(file)) }));
const schema = effectiveSchema(allMigrations);

function effective(key: string, from: Map<string, FunctionDef> = schema): FunctionDef {
  const def = from.get(key);

  if (!def) {
    throw new Error(`no effective definition for ${key}`);
  }

  return def;
}

/** A function body as written in a file, comments included. */
function rawBody(file: string, key: string): string {
  const def = definitionsIn(read(file), file).find((d) => `${d.name}(${d.types})` === key);

  if (!def) {
    throw new Error(`${file} does not define ${key}`);
  }

  return def.body;
}

const CREATE = "create_employee(uuid,text,text,text)";
const ACTIVE = "set_employee_active(uuid,boolean)";

// ---------------------------------------------------------------------------
// The structural "no roster rule" guard — mirrors assertion A3 in the SQL
// ---------------------------------------------------------------------------

const GUARD = {
  [CREATE]: {
    employeeReads: 0,
    codes: ["invalid_display_name", "invalid_pin", "invalid_role", "not_authenticated", "not_found"],
  },
  [ACTIVE]: {
    employeeReads: 1,
    codes: ["not_authenticated", "not_found"],
  },
} as const;

/** Every reason a body could still be enforcing a roster-size rule. */
function rosterRuleViolations(key: keyof typeof GUARD, body: string): string[] {
  const { employeeReads, codes } = GUARD[key];
  const code = body.replace(/--[^\n]*/g, "").replace(/'[^']*'/g, "''");
  const violations: string[] = [];

  if (body.includes("employee_limit_reached")) violations.push("employee_limit_reached");
  if (/\bcount\s*\(/i.test(code)) violations.push("count(");
  if (/(>=|<=|<>|!=|=|<|>)\s*[0-9]+/.test(code)) violations.push("numeric comparison");
  if (/(active_count|roster|ceiling|max_employee|employee_limit|\blimit\b)/i.test(code)) {
    violations.push("count/roster/limit identifier");
  }

  const reads = code.split("from public.employees").length - 1;
  if (reads !== employeeReads) violations.push(`employee reads ${reads}`);

  const found = [...new Set([...body.matchAll(/'error',\s*'([a-z_]+)'/g)].map((m) => m[1]))].sort();
  if (JSON.stringify(found) !== JSON.stringify([...codes].sort())) {
    violations.push(`error codes ${found.join(",")}`);
  }

  return violations;
}

// ---------------------------------------------------------------------------
// AST evaluation of the limiter constants
// ---------------------------------------------------------------------------

type AstNode = Record<string, unknown>;

function child(node: unknown, key: string): AstNode {
  const value = (node as AstNode | undefined)?.[key];

  if (value === null || typeof value !== "object") {
    throw new Error(`expected ${key}`);
  }

  return value as AstNode;
}

function intConst(node: unknown): number {
  const ival = child(child(node, "A_Const"), "ival");

  return typeof ival.ival === "number" ? ival.ival : 0;
}

async function evaluateCase(body: string, param: string, value: number): Promise<number> {
  const parsed = await parse(body);
  const target = child((child(parsed.stmts[0].stmt, "SelectStmt").targetList as unknown[])[0], "ResTarget");
  const caseExpr = child(target.val, "CaseExpr");

  for (const arm of caseExpr.args as unknown[]) {
    const when = child(arm, "CaseWhen");
    const expr = child(when.expr, "A_Expr");
    const op = child((expr.name as unknown[])[0], "String").sval;
    const column = child((child(expr.lexpr, "ColumnRef").fields as unknown[])[0], "String").sval;

    if (column !== param) throw new Error(`unexpected column ${String(column)}`);

    const bound = intConst(expr.rexpr);
    const hit = op === ">=" ? value >= bound : op === "=" ? value === bound : op === ">" ? value > bound : null;

    if (hit === null) throw new Error(`unexpected operator ${String(op)}`);
    if (hit) return intConst(when.result);
  }

  return intConst(caseExpr.defresult);
}

// ===========================================================================
// Ordering, immutability, grammar, scope
// ===========================================================================

describe("ordering and immutability", () => {
  it("sorts after both applied employee migrations and is the newest", () => {
    expect(F1A < FILENAME).toBe(true);
    expect(F1A1 < FILENAME).toBe(true);
    expect(orderedFiles[orderedFiles.length - 1]).toBe(FILENAME);
  });

  for (const [file, digest] of [
    [F1A, "724279536d2ceb995e4c55606106e1ec0c7f2c2cdd6cb3c0a6f6790c6fc015fc"],
    [F1A1, "cfa521949b22f4cb75dd8c9527478c781ea81a6db2d4fa53646fa7d8b7574c24"],
  ] as const) {
    it(`${file} is byte-for-byte what staging received`, () => {
      expect(createHash("sha256").update(readFileSync(join(migrationsDir, file))).digest("hex")).toBe(digest);
    });
  }

  it("NEGATIVE CONTROL: a one-byte change to an applied migration changes its digest", () => {
    const original = readFileSync(join(migrationsDir, F1A1));
    const altered = Buffer.concat([original, Buffer.from("\n")]);

    expect(createHash("sha256").update(altered).digest("hex")).not.toBe(
      "cfa521949b22f4cb75dd8c9527478c781ea81a6db2d4fa53646fa7d8b7574c24"
    );
  });
});

describe("grammar and scope", () => {
  it("parses", async () => {
    expect((await parse(sql)).stmts.length).toBeGreaterThan(0);
  });

  it("redefines exactly create_employee and set_employee_active", () => {
    const defined = definitionsIn(executable, FILENAME).map((d) => `${d.name}(${d.types})`).sort();

    expect(defined).toEqual([CREATE, ACTIVE].sort());
  });

  it("creates, drops and alters nothing else", () => {
    expect(executable).not.toMatch(/\bdrop\s+(function|table|index|policy|trigger)\b/i);
    expect(executable).not.toMatch(/create\s+(table|index|unique index|policy|trigger|or replace trigger)\b/i);
    expect(executable).not.toMatch(/\balter\s+(table|function)\b/i);
    expect(executable).not.toMatch(/execute\s+format/i);
  });

  it("grants no table privilege and touches no RLS", () => {
    expect(executable.match(/grant [^;]*on table [^;]*;/gi) ?? []).toEqual([]);
    expect(executable).not.toMatch(/(enable|disable|force|no force)\s+row level security/i);
    expect(executable).not.toMatch(/revoke[^;]*on table/i);
  });

  it("names nothing from sale, checkout, receipt, inventory or pairing", () => {
    for (const forbidden of [
      "complete_sale", "resolve_sale_owner", "restock_inventory", "adjust_inventory",
      "redeem_device_pairing_token", "revoke_paired_device", "unpair_own_device",
      "get_device_config", "apply_device_config_update", "get_device_recent_orders",
    ]) {
      expect(executable).not.toContain(forbidden);
    }
  });

  it("makes no commercial or marketing statement", () => {
    for (const phrase of [
      /unlimited/i,
      /no (employee|staff) limits?/i,
      /any number of (employees|staff)/i,
      /\bno limits?\b/i,
      /pricing|billing|licen[cs]/i,
    ]) {
      expect(sql).not.toMatch(phrase);
    }

    expect(sql).toContain("remove the temporary engineering active-employee");
    expect(sql).toContain("safeguard after staging performance validation");
  });
});

// ===========================================================================
// THE SAFEGUARD IS REMOVED — exactly, and only
// ===========================================================================

describe("the effective functions are this migration's", () => {
  for (const key of [CREATE, ACTIVE]) {
    it(`${key} is defined by ${FILENAME}`, () => {
      expect(effective(key).file).toBe(FILENAME);
    });
  }
});

describe("create_employee: its predecessor minus the safeguard, byte for byte", () => {
  const before = rawBody(F1A1, CREATE);
  const after = rawBody(FILENAME, CREATE);

  const REMOVED = [
    "  v_active_count integer;\n",
    "  select count(*) into v_active_count\n" +
      "  from public.employees e\n" +
      "  where e.project_id = p_project_id\n" +
      "    and e.active;\n\n" +
      "  -- Provisional engineering ceiling, not a supported limit.\n" +
      "  if v_active_count >= 50 then\n" +
      "    return jsonb_build_object('ok', false, 'error', 'employee_limit_reached');\n" +
      "  end if;\n\n",
  ];

  it("the predecessor contained exactly those snippets", () => {
    for (const snippet of REMOVED) {
      expect(before.split(snippet).length - 1).toBe(1);
    }
  });

  it("deleting them from the predecessor yields the new body exactly", () => {
    expect(REMOVED.reduce((body, snippet) => body.replace(snippet, ""), before)).toBe(after);
  });
});

describe("set_employee_active: its predecessor minus the safeguard, byte for byte", () => {
  const before = rawBody(F1A, ACTIVE);
  const after = rawBody(FILENAME, ACTIVE);

  const REMOVED = [
    "  v_active_count integer;\n",
    "  if p_active and not v_employee.active then\n" +
      "    select count(*) into v_active_count\n" +
      "    from public.employees e\n" +
      "    where e.project_id = v_employee.project_id\n" +
      "      and e.active;\n\n" +
      "    -- Same provisional engineering ceiling as create_employee: reactivating\n" +
      "    -- must not be a way around it.\n" +
      "    if v_active_count >= 50 then\n" +
      "      return jsonb_build_object('ok', false, 'error', 'employee_limit_reached');\n" +
      "    end if;\n" +
      "  end if;\n\n",
  ];

  it("the predecessor contained exactly those snippets", () => {
    for (const snippet of REMOVED) {
      expect(before.split(snippet).length - 1).toBe(1);
    }
  });

  it("deleting them from the predecessor yields the new body exactly", () => {
    expect(REMOVED.reduce((body, snippet) => body.replace(snippet, ""), before)).toBe(after);
  });
});

describe("no replacement roster rule exists", () => {
  for (const key of [CREATE, ACTIVE] as const) {
    it(`${key}: the effective body passes every structural rule`, () => {
      expect(rosterRuleViolations(key, effective(key).body)).toEqual([]);
    });

    it(`${key}: the predecessor FAILED the same rules (the guard is not vacuous)`, () => {
      const predecessor = key === CREATE ? rawBody(F1A1, CREATE) : rawBody(F1A, ACTIVE);

      expect(rosterRuleViolations(key, predecessor)).toEqual(
        expect.arrayContaining(["employee_limit_reached", "count(", "numeric comparison"])
      );
    });
  }

  it("asserts the same rules at apply time", () => {
    for (const message of [
      "F1A.2: % still returns employee_limit_reached",
      "F1A.2: % still counts rows",
      "F1A.2: % compares against a numeric literal",
      "F1A.2: % names a count, roster, ceiling or limit",
      "F1A.2: % reads public.employees % time(s), expected %",
      "F1A.2: % error codes are %, expected exactly %",
    ]) {
      expect(executable).toContain(message);
    }
  });

  const INSERTION = "  insert into public.employees (project_id, display_name, role, pin_hash)";
  const create = () => effective(CREATE).body;
  const active = () => effective(ACTIVE).body;
  const ACTIVE_ANCHOR = "  update public.employees e\n";

  for (const [label, key, mutate] of [
    ["restored >= 50", CREATE, () => create().replace(INSERTION,
      "  if (select count(*) from public.employees e where e.project_id = p_project_id and e.active) >= 50 then\n    return jsonb_build_object('ok', false, 'error', 'employee_limit_reached');\n  end if;\n" + INSERTION)],
    ["renumbered >= 20", CREATE, () => create().replace(INSERTION,
      "  if v_n >= 20 then\n    return jsonb_build_object('ok', false, 'error', 'invalid_role');\n  end if;\n" + INSERTION)],
    ["renumbered > 100", ACTIVE, () => active().replace(ACTIVE_ANCHOR,
      "  if v_total > 100 then\n    return jsonb_build_object('ok', false, 'error', 'not_found');\n  end if;\n" + ACTIVE_ANCHOR)],
    ["restored employee_limit_reached alone", ACTIVE, () => active().replace(ACTIVE_ANCHOR,
      "  if p_active then\n    return jsonb_build_object('ok', false, 'error', 'employee_limit_reached');\n  end if;\n" + ACTIVE_ANCHOR)],
    ["new error name, no number", CREATE, () => create().replace(INSERTION,
      "  if v_full then\n    return jsonb_build_object('ok', false, 'error', 'roster_full');\n  end if;\n" + INSERTION)],
    ["count hidden in a subquery", ACTIVE, () => active().replace(ACTIVE_ANCHOR,
      "  perform (select count(*) from public.employees e2 where e2.active);\n" + ACTIVE_ANCHOR)],
    ["extra employee read without count", CREATE, () => create().replace(INSERTION,
      "  if exists (select 1 from public.employees e where e.project_id = p_project_id offset v_cap) then\n    return jsonb_build_object('ok', false, 'error', 'not_found');\n  end if;\n" + INSERTION)],
    ["renamed ceiling variable", ACTIVE, () => active().replace("  v_updated record;\n", "  v_updated record;\n  v_max_employees integer;\n")],
  ] as const) {
    it(`NEGATIVE CONTROL: ${label} is detected`, () => {
      const mutated = mutate();

      expect(mutated).not.toBe(key === CREATE ? create() : active());
      expect(rosterRuleViolations(key, mutated)).not.toEqual([]);
    });
  }
});

// ===========================================================================
// Preserved behaviour
// ===========================================================================

describe("create_employee keeps everything else", () => {
  const body = effective(CREATE).body;

  for (const kept of [
    "v_caller := auth.uid();",
    "if exists (select 1 from public.paired_devices d where d.auth_user_id = v_caller) then",
    "if not found or v_project_owner is distinct from v_caller then",
    "if p_display_name is null or btrim(p_display_name) = '' then",
    "if p_role is null or p_role not in ('owner', 'manager', 'cashier') then",
    "if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then",
    "values (p_project_id, btrim(p_display_name), p_role, public.employee_pin_hash(p_pin))",
  ]) {
    it(`keeps: ${kept.slice(0, 70)}`, () => {
      expect(body).toContain(kept);
    });
  }

  it("returns exactly the same safe fields", () => {
    const success = body.slice(body.lastIndexOf("return jsonb_build_object("));
    const keys = [...success.matchAll(/'(\w+)'\s*,/g)].map((m) => m[1]);

    expect(keys).toEqual(["ok", "employeeId", "displayName", "role", "active", "createdAt"]);
    expect(success).not.toContain("pin");
  });

  it("does not trim or repair the PIN", () => {
    for (const repair of ["trim(p_pin", "lpad(p_pin", "replace(p_pin"]) {
      expect(body).not.toContain(repair);
    }
  });
});

describe("set_employee_active keeps everything else", () => {
  const body = effective(ACTIVE).body;

  for (const kept of [
    "v_caller := auth.uid();",
    "if exists (select 1 from public.paired_devices d where d.auth_user_id = v_caller) then",
    "if p_employee_id is null or p_active is null then",
    "join public.projects p on p.id = e.project_id",
    "and p.user_id = v_caller;",
    "set active = p_active,",
    "deactivated_at = case when p_active then null else coalesce(e.deactivated_at, now()) end",
  ]) {
    it(`keeps: ${kept.slice(0, 70)}`, () => {
      expect(body).toContain(kept);
    });
  }

  it("changes only active and deactivated_at, and never touches sessions", () => {
    const update = body.slice(body.indexOf("update public.employees e"), body.indexOf("returning"));
    const assigned = [...update.matchAll(/(\w+)\s*=/g)].map((m) => m[1]).filter((c) => c !== "id");

    expect(assigned).toEqual(["active", "deactivated_at"]);
    expect(body).not.toContain("employee_pos_sessions");
    expect(body).not.toMatch(/\bdelete\b/i);
  });

  it("returns exactly the same safe fields", () => {
    const success = body.slice(body.lastIndexOf("return jsonb_build_object("));
    const keys = [...success.matchAll(/'(\w+)'\s*,/g)].map((m) => m[1]);

    expect(keys).toEqual(["ok", "employeeId", "displayName", "role", "active", "deactivatedAt"]);
  });
});

describe("duplicate PINs remain legal", () => {
  for (const key of [CREATE, "set_employee_pin(uuid,text)"]) {
    it(`${key}: no duplicate scan, helper, error or loop; still hashes`, () => {
      const body = effective(key).body;

      for (const banned of ["employee_project_pin_taken", "employee_pin_verify", "duplicate_pin"]) {
        expect(body).not.toContain(banned);
      }

      expect(body).not.toMatch(/\bloop\b/i);
      expect(body).toContain("public.employee_pin_hash(p_pin)");
    });
  }

  it("the duplicate-PIN helper is still absent from the effective schema", () => {
    expect(schema.has("employee_project_pin_taken(uuid,text,uuid)")).toBe(false);
  });

  it("NEGATIVE CONTROL: restoring the helper call is detected", () => {
    const mutated = effective(CREATE).body.replace(
      "  insert into public.employees",
      "  if public.employee_project_pin_taken(p_project_id, p_pin, null) then\n    return null;\n  end if;\n  insert into public.employees"
    );

    expect(mutated).toContain("employee_project_pin_taken");
  });
});

// ===========================================================================
// Feature 1A.1 contract — unchanged
// ===========================================================================

describe("selector and single-hash login are untouched", () => {
  it("the PIN-only login stays retired", () => {
    expect(schema.has("employee_login(text)")).toBe(false);
    expect([...schema.keys()].filter((k) => k.startsWith("employee_login("))).toEqual(["employee_login(uuid,text)"]);
  });

  it("employee_login is still 1A.1's, verifying exactly one hash with no iteration", () => {
    const login = effective("employee_login(uuid,text)");

    expect(login.file).toBe(F1A1);
    expect(login.body.split("employee_pin_verify(").length - 1).toBe(1);
    expect(login.body).not.toMatch(/\b(loop|foreach|while)\b/i);
  });

  it("no other effective function verifies a PIN", () => {
    const verifiers = [...schema.entries()]
      .filter(([key, def]) => key !== "employee_pin_verify(text,text)" && def.body.includes("employee_pin_verify("))
      .map(([key]) => key);

    expect(verifiers).toEqual(["employee_login(uuid,text)"]);
  });

  it("the selector is still 1A.1's, returning only employeeId and displayName", () => {
    const selector = effective("list_login_employees()");

    expect(selector.file).toBe(F1A1);
    expect(selector.body).toContain("jsonb_build_object('employeeId', e.id, 'displayName', e.display_name)");
    expect(selector.body).toContain("order by e.display_name, e.id");
    expect(selector.body.replace(/'[^']*'/g, "''")).not.toMatch(/\brole\b/i);
  });

  it("every limiter helper is still 1A.1's", () => {
    for (const key of [
      "employee_login_employee_lock_seconds(integer)",
      "employee_login_device_cooldown_seconds(integer)",
      "employee_login_record_employee_failure(uuid,uuid,timestamptz)",
      "employee_login_record_device_failure(uuid,timestamptz)",
    ]) {
      expect(effective(key).file).toBe(F1A1);
    }
  });

  it("the employee/device ladder is 1-4:0, 5:30, 6:60, 7:120, 8:300, 9+:900", async () => {
    const body = effective("employee_login_employee_lock_seconds(integer)").body;
    const expected: Array<[number, number]> = [[1, 0], [4, 0], [5, 30], [6, 60], [7, 120], [8, 300], [9, 900], [50, 900]];

    for (const [n, seconds] of expected) {
      expect(await evaluateCase(body, "p_failed_count", n)).toBe(seconds);
    }
  });

  it("the device throttle is 1-14:0, 15-19:15, 20-24:30, 25+:60", async () => {
    const body = effective("employee_login_device_cooldown_seconds(integer)").body;
    const expected: Array<[number, number]> = [[1, 0], [14, 0], [15, 15], [19, 15], [20, 30], [24, 30], [25, 60], [1000, 60]];

    for (const [n, seconds] of expected) {
      expect(await evaluateCase(body, "p_recent_failures", n)).toBe(seconds);
    }
  });

  it("the rolling window is still inclusive and 300 seconds", () => {
    expect(effective("employee_login_record_device_failure(uuid,timestamptz)").body).toContain(
      "and f.failed_at >= p_now - interval '300 seconds';"
    );
  });

  it("NEGATIVE CONTROL: a changed throttle tier is detected", async () => {
    const body = effective("employee_login_device_cooldown_seconds(integer)").body.replace(
      "when p_recent_failures >= 25 then 60",
      "when p_recent_failures >= 25 then 120"
    );

    expect(await evaluateCase(body, "p_recent_failures", 25)).not.toBe(60);
  });

  it("the one-open-session index is still defined and never dropped", () => {
    expect(read(F1A)).toContain(
      "create unique index if not exists employee_pos_sessions_one_open_per_device\n  on public.employee_pos_sessions using btree (paired_device_id)\n  where ended_at is null;"
    );

    for (const { text } of allMigrations) {
      expect(text).not.toMatch(/drop index[^;]*employee_pos_sessions_one_open_per_device/i);
    }
  });

  it("asserts the whole 1A.1 contract again at apply time", () => {
    for (const message of [
      "F1A.2: an object retired by 20260916120000 has reappeared",
      "F1A.2: employee_login no longer verifies exactly one hash",
      "F1A.2: expected exactly one PIN-verifying function, found %",
      "F1A.2: the selector contract changed",
      "F1A.2: employee lockout for % failures changed",
      "F1A.2: device cooldown for % recent failures changed",
      "F1A.2: the rolling 300-second window changed",
      "F1A.2: % performs duplicate-PIN enforcement again",
    ]) {
      expect(executable).toContain(message);
    }
  });
});

// ===========================================================================
// Security posture of the redefined functions
// ===========================================================================

describe("security posture", () => {
  const SIGS = [
    "public.create_employee(uuid, text, text, text)",
    "public.set_employee_active(uuid, boolean)",
  ];

  for (const sig of SIGS) {
    it(`${sig}: revoked from public, anon, service_role, then granted to authenticated`, () => {
      const positions = [
        executable.indexOf(`revoke all on function ${sig} from public;`),
        executable.indexOf(`revoke all on function ${sig} from anon;`),
        executable.indexOf(`revoke all on function ${sig} from service_role;`),
        executable.indexOf(`grant execute on function ${sig} to authenticated;`),
      ];

      expect(positions.every((p) => p > -1)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    });
  }

  it("every header is SECURITY DEFINER with exactly public, pg_temp", () => {
    const headers = [...executable.matchAll(/create or replace function public\.\w+\([^)]*\)[\s\S]*?as \$function\$/g)];

    expect(headers).toHaveLength(2);

    for (const [header] of headers) {
      expect(header).toContain("security definer");
      expect(header).toContain("set search_path = public, pg_temp");
    }

    expect([...new Set(executable.match(/set search_path[^\n]*/g))]).toEqual(["set search_path = public, pg_temp"]);
  });

  it("grants nothing to anon or service_role", () => {
    expect(executable).not.toMatch(/grant[^;]*to (anon|service_role)\b/i);
  });

  it("asserts the grant matrix, PUBLIC and the unchanged ACL at apply time", () => {
    for (const message of [
      "F1A.2: % must be SECURITY DEFINER",
      "F1A.2: % must lock search_path to exactly public, pg_temp",
      "F1A.2: authenticated must be able to execute %",
      "F1A.2: % must NOT be able to execute %",
      "F1A.2: PUBLIC must NOT be able to execute %",
      "F1A.2: the EXECUTE grants of % changed",
    ]) {
      expect(executable).toContain(message);
    }
  });

  const headersOf = (text: string) => [...text.matchAll(/create or replace function public\.\w+\([^)]*\)[\s\S]*?as \$function\$/g)];

  it("NEGATIVE CONTROL: a service_role grant is detected", () => {
    expect(`${executable}\ngrant execute on function public.set_employee_active(uuid, boolean) to service_role;`).toMatch(
      /grant[^;]*to (anon|service_role)\b/i
    );
  });

  it("NEGATIVE CONTROL: an anon grant is detected", () => {
    expect(`${executable}\ngrant execute on function public.create_employee(uuid, text, text, text) to anon;`).toMatch(
      /grant[^;]*to (anon|service_role)\b/i
    );
  });

  it("NEGATIVE CONTROL: a widened search_path is detected", () => {
    const mutated = executable.replace("set search_path = public, pg_temp", "set search_path = public, extensions, pg_temp");

    expect([...new Set(mutated.match(/set search_path[^\n]*/g))]).not.toEqual(["set search_path = public, pg_temp"]);
  });

  it("NEGATIVE CONTROL: SECURITY INVOKER is detected", () => {
    const mutated = executable.replace("security definer", "security invoker");

    expect(headersOf(mutated).some(([h]) => !h.includes("security definer"))).toBe(true);
  });

  it("NEGATIVE CONTROL: a direct table grant is detected", () => {
    const mutated = `${executable}\ngrant select on table public.employees to authenticated;`;

    expect(mutated.match(/grant [^;]*on table [^;]*;/gi) ?? []).not.toEqual([]);
  });

  it("NEGATIVE CONTROL: a missing service_role revoke is detected", () => {
    const sig = "public.create_employee(uuid, text, text, text)";
    const mutated = executable.replace(`revoke all on function ${sig} from service_role;\n`, "");

    expect(mutated.indexOf(`revoke all on function ${sig} from service_role;`)).toBe(-1);
  });
});

// ===========================================================================
// Inertness
// ===========================================================================

// ---------------------------------------------------------------------------
// Trigger fingerprint typing — regression guard for a defect found on staging
//
// pg_trigger.tgenabled is PostgreSQL type "char". In PostgreSQL 17,
// `text || "char"` is ambiguous (42725 "operator is not unique"). The first
// version of this migration concatenated it uncast; libpg-query parses that
// fine and PL/pgSQL defers planning, so it only failed when the verification
// block reached it. Both trigger columns in the fingerprint are now cast
// explicitly, and this guard keeps them that way.
// ---------------------------------------------------------------------------

/** The live and baseline trigger fingerprint lines of this migration. */
function triggerFingerprintLines(text: string): string[] {
  return text.split("\n").filter((line) => line.includes("||") && /\btg(enabled|type)\b/.test(line));
}

/** Every trigger column concatenated without an explicit ::text cast. */
function uncastTriggerColumns(text: string): string[] {
  return triggerFingerprintLines(text).flatMap((line) =>
    [...line.matchAll(/\b(\w+)\.(tgenabled|tgtype)\b(?!::text)/g)].map((m) => `${m[1]}.${m[2]}`)
  );
}

const LIVE_FINGERPRINT =
  "    select c.relname || '.' || t.tgname || ':' || t.tgtype::text || ':' || t.tgenabled::text || ':' || pr.proname as x";
const BASELINE_FINGERPRINT =
  "    select b.relname || '.' || b.tgname || ':' || b.tgtype::text || ':' || b.tgenabled::text || ':' || b.proname";

describe("trigger fingerprint casts the \"char\" catalog columns explicitly", () => {
  it("contains exactly the corrected live and baseline expressions", () => {
    expect(triggerFingerprintLines(executable)).toEqual([LIVE_FINGERPRINT, BASELINE_FINGERPRINT]);
  });

  it("casts t.tgenabled, b.tgenabled, t.tgtype and b.tgtype to text", () => {
    for (const cast of ["t.tgenabled::text", "b.tgenabled::text", "t.tgtype::text", "b.tgtype::text"]) {
      expect(executable).toContain(cast);
    }

    expect(uncastTriggerColumns(executable)).toEqual([]);
  });

  it("the live and baseline fingerprints are the same expression apart from their aliases", () => {
    const normalize = (line: string) =>
      line.replace(/ as x$/, "").replace(/\b(t|c|pr|b)\./g, "_.");

    expect(normalize(LIVE_FINGERPRINT)).toBe(normalize(BASELINE_FINGERPRINT));
  });

  it("keeps the trigger inertness assertion itself", () => {
    expect(executable).toContain("raise exception 'F1A.2: triggers changed';");
    expect(executable).toContain("from f1a2_trg_baseline b");
  });

  for (const [label, from, to] of [
    ["live t.tgenabled", "t.tgenabled::text", "t.tgenabled"],
    ["baseline b.tgenabled", "b.tgenabled::text", "b.tgenabled"],
    ["live t.tgtype", "t.tgtype::text", "t.tgtype"],
    ["baseline b.tgtype", "b.tgtype::text", "b.tgtype"],
  ] as const) {
    it(`NEGATIVE CONTROL: removing the cast from ${label} is rejected`, () => {
      const mutated = executable.replace(from, to);

      expect(mutated).not.toBe(executable);
      expect(uncastTriggerColumns(mutated)).toEqual([to]);
      expect(triggerFingerprintLines(mutated)).not.toEqual([LIVE_FINGERPRINT, BASELINE_FINGERPRINT]);
    });
  }

  it("NEGATIVE CONTROL: the original defective form is rejected", () => {
    const original = executable.replace(LIVE_FINGERPRINT, LIVE_FINGERPRINT.replaceAll("::text", "")).replace(
      BASELINE_FINGERPRINT,
      BASELINE_FINGERPRINT.replaceAll("::text", "")
    );

    expect(uncastTriggerColumns(original).sort()).toEqual(
      ["b.tgenabled", "b.tgtype", "t.tgenabled", "t.tgtype"].sort()
    );
  });
});

describe("the rest of the schema is proven unchanged at apply time", () => {
  it("captures every baseline before the first redefinition", () => {
    const firstDdl = executable.indexOf("create or replace function public.create_employee(");

    for (const table of [
      "f1a2_proc_baseline", "f1a2_redefined_acl_baseline", "f1a2_pol_baseline", "f1a2_priv_baseline",
      "f1a2_rls_baseline", "f1a2_trg_baseline", "f1a2_idx_baseline", "f1a2_row_baseline",
    ]) {
      const at = executable.indexOf(`create temporary table ${table}`);

      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(firstDdl);
    }
  });

  it("excludes only the two redefined functions from the function baseline", () => {
    expect(executable).toContain("and p.proname not in ('create_employee', 'set_employee_active');");
  });

  it("covers the limiter tables in the privilege and row baselines", () => {
    for (const table of ["employee_login_employee_attempts", "employee_login_device_failures", "employee_login_device_throttles"]) {
      expect(executable).toContain(`('${table}')`);
      expect(executable).toContain(`from public.${table}) as`);
    }
  });

  it("fails on any drift", () => {
    for (const message of [
      "F1A.2: function %(%) changed or was dropped",
      "F1A.2: % unexpected new function(s)",
      "F1A.2: public policies changed",
      "F1A.2: privilege % on % for % changed",
      "F1A.2: a table or its RLS setting changed",
      "F1A.2: triggers changed",
      "F1A.2: indexes changed (including employee_pos_sessions_one_open_per_device)",
      "F1A.2: employee, session, limiter or pairing rows changed",
      "F1A.2: employee structure columns changed",
    ]) {
      expect(executable).toContain(message);
    }
  });

  it("checks the ledger only where one exists, so a manual apply is not blocked", () => {
    expect(executable).toContain("if to_regclass('supabase_migrations.schema_migrations') is not null then");
    expect(executable).toContain("where version in ('20260914120000', '20260916120000');");
  });
});
