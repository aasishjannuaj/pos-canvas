// v1.3 Feature 1B-SERVER — register sessions and sale attribution.
//
// SCOPE. No database was contacted for this migration and it has not been
// applied anywhere; there is no local Postgres in this repository's toolchain.
// These tests work from the SQL source and the ordered migration history, and
// they go further than text matching where it matters:
//
//   * the money rules, the CHECK constraints, the one-open predicate and the
//     historical-claim WHERE clauses are PARSED and EVALUATED against probe
//     values with exact decimal arithmetic, so "12.345 is refused" is a
//     computed result of the SQL that ships, not a regex;
//   * complete_sale_v5 is proven to be complete_sale_v4's effective body plus a
//     declared list of edits, byte for byte;
//   * row-lock strength comes from the parsed locking clause, and the global
//     lock order is checked for cycles across every function that takes locks;
//   * every critical guard has a negative control that mutates a copy and
//     proves the guard fails.
//
// What this suite CANNOT do is run two transactions against each other. The
// concurrency outcomes (switch / deactivate / logout / close racing a sale) are
// argued here from lock modes and ordering, and must be exercised for real in
// the staging validation phase.
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
const FILENAME = "20260917120000_register_sessions_and_sale_attribution.sql";
const F1A = "20260914120000_employee_identity_and_pos_sessions.sql";
const F1A1 = "20260916120000_employee_selector_single_hash_login.sql";
const CEILING = "20260916130000_remove_active_employee_engineering_ceiling.sql";
const RECEIPT = "20260913120000_receipt_fidelity.sql";

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

// ===========================================================================
// Effective-schema resolution (same approach as the Feature 1A suites)
// ===========================================================================

type FunctionDef = { name: string; types: string; body: string; file: string; header: string };

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
      header: text.slice(match.index ?? 0, bodyStart),
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
        current.set(key, { name: e.name, types: e.types, body: e.body, header: e.header, file });
      } else {
        current.delete(key);
      }
    }
  }

  return current;
}

const orderedFiles = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
const allMigrations = () => orderedFiles.map((file) => ({ file, text: stripComments(read(file)) }));
const schema = effectiveSchema(allMigrations());

/** The effective schema if THIS migration's text were replaced by `text`. */
function schemaWith(text: string): Map<string, FunctionDef> {
  return effectiveSchema(
    orderedFiles.map((file) => ({ file, text: file === FILENAME ? stripComments(text) : stripComments(read(file)) }))
  );
}

function effective(key: string, from: Map<string, FunctionDef> = schema): FunctionDef {
  const def = from.get(key);

  if (!def) {
    throw new Error(`no effective definition for ${key}`);
  }

  return def;
}

/** A function body as written in a file, comments included. */
function rawBody(text: string, key: string): string {
  const def = definitionsIn(text, "x").find((d) => `${d.name}(${d.types})` === key);

  if (!def) {
    throw new Error(`does not define ${key}`);
  }

  return def.body;
}

const OPEN = "open_register_session(uuid,numeric)";
const CURRENT = "get_current_register_session()";
const CLOSE = "close_register_session(uuid)";
const V5 = "complete_sale_v5(text,numeric,jsonb,uuid,timestamptz,text,uuid,uuid)";
const NEW_FUNCTIONS = [OPEN, CURRENT, CLOSE, V5];

const V1 = "complete_sale(uuid,text,text,numeric,numeric,numeric,numeric,jsonb)";
const V2 = "complete_sale_v2(uuid,text,numeric,jsonb,uuid)";
const V3 = "complete_sale_v3(uuid,text,numeric,jsonb,uuid)";
const V4 = "complete_sale_v4(uuid,text,numeric,jsonb,uuid,timestamp with time zone,text)";
const LEGACY = [V1, V2, V3, V4];

/** A new function's body as written in this migration, comments included. */
const src = (key: string): string => rawBody(sql, key);

// ===========================================================================
// Parsed statements of THIS migration
// ===========================================================================

type AstNode = Record<string, unknown>;
type Stmt = Record<string, AstNode>;

async function statements(text: string): Promise<Stmt[]> {
  return (await parse(text)).stmts.map((s) => s.stmt as Stmt);
}

function str(node: unknown): string {
  return String(((node as AstNode).String as AstNode).sval);
}

function names(list: unknown): string[] {
  return ((list as unknown[]) ?? []).map(str);
}

function registerTable(stmts: Stmt[]): AstNode {
  const found = stmts.find(
    (s) => s.CreateStmt && (s.CreateStmt.relation as AstNode).relname === "register_sessions"
  );

  if (!found) throw new Error("register_sessions is not created");

  return found.CreateStmt;
}

function ordersAlter(stmts: Stmt[]): AstNode[] {
  return stmts
    .filter((s) => s.AlterTableStmt && (s.AlterTableStmt.relation as AstNode).relname === "orders")
    .flatMap((s) => (s.AlterTableStmt.cmds as AstNode[]).map((c) => c.AlterTableCmd as AstNode));
}

type Column = { name: string; type: string; notNull: boolean; primary: boolean; default: string | null };

function typeText(typeName: AstNode): string {
  const base = names(typeName.names).filter((n) => n !== "pg_catalog").join(".");
  const mods = ((typeName.typmods as AstNode[]) ?? []).map((m) => {
    const ival = ((m.A_Const as AstNode).ival as AstNode | undefined)?.ival;
    return typeof ival === "number" ? ival : 0;
  });

  return mods.length ? `${base}(${mods.join(",")})` : base;
}

function columnsOf(table: AstNode): Column[] {
  return (table.tableElts as AstNode[])
    .filter((e) => e.ColumnDef)
    .map((e) => {
      const def = e.ColumnDef as AstNode;
      const constraints = ((def.constraints as AstNode[]) ?? []).map((c) => c.Constraint as AstNode);
      const dflt = constraints.find((c) => c.contype === "CONSTR_DEFAULT");

      return {
        name: String(def.colname),
        type: typeText(def.typeName as AstNode),
        notNull: constraints.some((c) => c.contype === "CONSTR_NOTNULL" || c.contype === "CONSTR_PRIMARY"),
        primary: constraints.some((c) => c.contype === "CONSTR_PRIMARY"),
        default: dflt ? names(((dflt.raw_expr as AstNode).FuncCall as AstNode).funcname).join(".") + "()" : null,
      };
    });
}

type Fk = { name: string; cols: string[]; table: string; refCols: string[]; onDelete: string; onUpdate: string; match: string };

function fkOf(c: AstNode): Fk {
  return {
    name: String(c.conname),
    cols: names(c.fk_attrs),
    table: `${(c.pktable as AstNode).schemaname}.${(c.pktable as AstNode).relname}`,
    refCols: names(c.pk_attrs),
    onDelete: String(c.fk_del_action),
    onUpdate: String(c.fk_upd_action),
    match: String(c.fk_matchtype),
  };
}

function tableConstraints(table: AstNode): AstNode[] {
  return (table.tableElts as AstNode[]).filter((e) => e.Constraint).map((e) => e.Constraint as AstNode);
}

function allForeignKeys(stmts: Stmt[]): Fk[] {
  const fromTable = tableConstraints(registerTable(stmts)).filter((c) => c.contype === "CONSTR_FOREIGN");
  const fromOrders = ordersAlter(stmts)
    .filter((c) => c.subtype === "AT_AddConstraint")
    .map((c) => (c.def as AstNode).Constraint as AstNode)
    .filter((c) => c.contype === "CONSTR_FOREIGN");

  return [...fromTable, ...fromOrders].map(fkOf);
}

// ===========================================================================
// An exact evaluator for the SQL expressions this feature relies on.
//
// numeric is modelled exactly (BigInt mantissa + scale) with Postgres's rules:
// NaN equals NaN and sorts above everything, the infinities sort at the ends,
// round() is half away from zero, trunc() is toward zero, and both return a
// special value unchanged. SQL three-valued logic is honoured throughout.
// ===========================================================================

type Num =
  | { k: "num"; m: bigint; s: number }
  | { k: "nan" }
  | { k: "inf"; neg: boolean };
type Val = Num | { k: "text"; v: string } | boolean | null;

function num(text: string): Num {
  if (text === "NaN") return { k: "nan" };
  if (text === "Infinity") return { k: "inf", neg: false };
  if (text === "-Infinity") return { k: "inf", neg: true };

  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error(`invalid numeric ${text}`);

  const frac = match[3] ?? "";
  const m = BigInt(match[2] + frac) * (match[1] ? -1n : 1n);

  return { k: "num", m, s: frac.length };
}

function isNum(v: Val): v is Num {
  return typeof v === "object" && v !== null && (v.k === "num" || v.k === "nan" || v.k === "inf");
}

function rank(v: Num): number {
  return v.k === "nan" ? 3 : v.k === "inf" ? (v.neg ? 0 : 2) : 1;
}

function cmpNum(a: Num, b: Num): number {
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (a.k !== "num" || b.k !== "num") return 0;

  const s = Math.max(a.s, b.s);
  const am = a.m * 10n ** BigInt(s - a.s);
  const bm = b.m * 10n ** BigInt(s - b.s);

  return am === bm ? 0 : am < bm ? -1 : 1;
}

function rescale(v: Num, places: number, mode: "round" | "trunc"): Num {
  if (v.k !== "num" || v.s <= places) return v.k === "num" ? { k: "num", m: v.m * 10n ** BigInt(places - v.s), s: places } : v;

  const factor = 10n ** BigInt(v.s - places);
  const sign = v.m < 0n ? -1n : 1n;
  const abs = v.m * sign;
  let q = abs / factor;

  if (mode === "round" && (abs % factor) * 2n >= factor) q += 1n;

  return { k: "num", m: q * sign, s: places };
}

function numText(v: Num): string {
  if (v.k === "nan") return "NaN";
  if (v.k === "inf") return v.neg ? "-Infinity" : "Infinity";

  const neg = v.m < 0n;
  const digits = (neg ? -v.m : v.m).toString().padStart(v.s + 1, "0");
  const text = v.s ? `${digits.slice(0, -v.s)}.${digits.slice(-v.s)}` : digits;

  return neg ? `-${text}` : text;
}

function compare(a: Val, b: Val): number | null {
  if (a === null || b === null) return null;
  if (isNum(a) && isNum(b)) return cmpNum(a, b);
  if (typeof a === "object" && typeof b === "object" && a.k === "text" && b.k === "text") {
    return a.v === b.v ? 0 : a.v < b.v ? -1 : 1;
  }
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);

  throw new Error(`cannot compare ${JSON.stringify(a)} with ${JSON.stringify(b)}`);
}

type Env = Record<string, Val>;

function evaluate(node: AstNode, env: Env): Val {
  if (node.A_Const) {
    const c = node.A_Const as AstNode;
    if (c.isnull) return null;
    if (c.ival) return num(String(((c.ival as AstNode).ival as number | undefined) ?? 0));
    if (c.fval) return num(String((c.fval as AstNode).fval));
    if (c.sval) return { k: "text", v: String((c.sval as AstNode).sval) };
    if (c.boolval) return Boolean((c.boolval as AstNode).boolval);
    throw new Error("unsupported constant");
  }

  if (node.ColumnRef) {
    const key = names((node.ColumnRef as AstNode).fields).join(".");
    if (!(key in env)) throw new Error(`unbound ${key}`);
    return env[key];
  }

  if (node.TypeCast) {
    const cast = node.TypeCast as AstNode;
    const target = names((cast.typeName as AstNode).names).pop();
    const value = evaluate(cast.arg as AstNode, env);

    if (value === null) return null;
    if (target === "numeric") return isNum(value) ? value : num((value as { v: string }).v);
    if (target === "text") return { k: "text", v: isNum(value) ? numText(value) : String((value as { v: string }).v) };

    throw new Error(`unsupported cast to ${target}`);
  }

  if (node.NullTest) {
    const test = node.NullTest as AstNode;
    const isNull = evaluate(test.arg as AstNode, env) === null;
    return test.nulltesttype === "IS_NULL" ? isNull : !isNull;
  }

  if (node.BoolExpr) {
    const expr = node.BoolExpr as AstNode;
    const args = (expr.args as AstNode[]).map((a) => evaluate(a, env) as boolean | null);

    if (expr.boolop === "NOT_EXPR") return args[0] === null ? null : !args[0];
    if (expr.boolop === "AND_EXPR") return args.includes(false) ? false : args.includes(null) ? null : true;
    return args.includes(true) ? true : args.includes(null) ? null : false;
  }

  if (node.FuncCall) {
    const call = node.FuncCall as AstNode;
    const fn = names(call.funcname).pop();
    const [value, places] = (call.args as AstNode[]).map((a) => evaluate(a, env));

    if ((fn === "round" || fn === "trunc") && isNum(value as Val) && isNum(places as Val)) {
      const p = places as Num;
      if (p.k !== "num") throw new Error("bad places");
      return rescale(value as Num, Number(p.m), fn);
    }

    throw new Error(`unsupported function ${fn}`);
  }

  if (node.A_Expr) {
    const expr = node.A_Expr as AstNode;
    const op = str((expr.name as unknown[])[0]);

    if (expr.kind === "AEXPR_IN") {
      const left = evaluate(expr.lexpr as AstNode, env);
      const items = ((expr.rexpr as AstNode).List as AstNode).items as AstNode[];
      const results = items.map((i) => compare(left, evaluate(i, env)));
      const hit = results.includes(0) ? true : results.includes(null) ? null : false;
      return op === "=" ? hit : hit === null ? null : !hit;
    }

    if (!expr.lexpr && op === "-") {
      const value = evaluate(expr.rexpr as AstNode, env);
      if (value === null) return null;
      const n = value as Num;
      return n.k === "num" ? { k: "num", m: -n.m, s: n.s } : n.k === "inf" ? { k: "inf", neg: !n.neg } : n;
    }

    const c = compare(evaluate(expr.lexpr as AstNode, env), evaluate(expr.rexpr as AstNode, env));
    if (c === null) return null;

    switch (op) {
      case "=": return c === 0;
      case "<>": return c !== 0;
      case "<": return c < 0;
      case ">": return c > 0;
      case "<=": return c <= 0;
      case ">=": return c >= 0;
      default: throw new Error(`unsupported operator ${op}`);
    }
  }

  throw new Error(`unsupported node ${Object.keys(node)[0]}`);
}

async function expression(text: string): Promise<AstNode> {
  const parsed = await parse(`select ${text}`);
  return (((parsed.stmts[0].stmt.SelectStmt as AstNode).targetList as AstNode[])[0].ResTarget as AstNode).val as AstNode;
}

const n = (text: string): Num => num(text);
const t = (v: string): Val => ({ k: "text", v });
/** A timestamp as epoch seconds; ordering is all these predicates need. */
const ts = (seconds: number): Num => ({ k: "num", m: BigInt(seconds), s: 0 });

// ===========================================================================
// Pure checkers — each returns its violations so negative controls can reuse
// them on mutated copies.
// ===========================================================================

/** Opening-cash rules of open_register_session, evaluated. */
async function openingCashRules(migration: string): Promise<(cash: Val) => boolean> {
  const body = rawBody(stripComments(migration), OPEN);
  const maxMoney = /c_max_money constant numeric := ([0-9.]+);/.exec(body)?.[1];

  if (!maxMoney) throw new Error("c_max_money is not declared");

  const conditions = [
    ...body.matchAll(/^\s*if ((?:(?!\bthen\b)[\s\S])*?) then\s*return jsonb_build_object\('ok', false, 'error', 'invalid_opening_cash'\);/gm),
  ].map((m) => m[1]);
  const parsed = await Promise.all(conditions.map(expression));

  return (cash: Val) =>
    !parsed.some((cond) => evaluate(cond, { p_opening_cash: cash, c_max_money: num(maxMoney) }) === true);
}

const CASH_ACCEPTED = ["0", "0.00", "0.01", "12.34", "12.340", "12.3", "5", "9999999999.99"];
const CASH_REFUSED = ["12.345", "0.001", "0.005", "12.3400001", "-0.01", "-1", "NaN", "Infinity", "-Infinity",
  "10000000000.00", "9999999999.991"];

async function cashViolations(migration: string): Promise<string[]> {
  const accepts = await openingCashRules(migration);
  const out: string[] = [];

  for (const v of CASH_ACCEPTED) if (!accepts(n(v))) out.push(`refuses ${v}`);
  for (const v of CASH_REFUSED) if (accepts(n(v))) out.push(`accepts ${v}`);
  if (accepts(null)) out.push("accepts null");

  return out;
}

/** The register_sessions CHECK constraints, evaluated on unconstrained values. */
async function registerChecks(migration: string): Promise<(row: Env) => boolean> {
  const table = registerTable(await statements(migration));
  const checks = tableConstraints(table)
    .filter((c) => c.contype === "CONSTR_CHECK")
    .map((c) => c.raw_expr as AstNode);

  return (row: Env) => checks.every((c) => evaluate(c, row) !== false);
}

const T0 = 1_000_000;
const CLOSER = t("00000000-0000-0000-0000-00000000000a");
const regRow = (cash: string, closed: number | null, closer: Val): Env => ({
  opening_cash: n(cash),
  opened_at: ts(T0),
  closed_at: closed === null ? null : ts(closed),
  closed_by_employee_id: closer,
});

const REGISTER_ROWS: Array<[string, Env, boolean]> = [
  ["zero cash", regRow("0", null, null), true],
  ["cents", regRow("12.34", null, null), true],
  ["trailing zero", regRow("12.340", null, null), true],
  ["ceiling", regRow("9999999999.99", null, null), true],
  ["negative", regRow("-0.01", null, null), false],
  ["three decimals", regRow("12.345", null, null), false],
  ["sub-cent", regRow("0.001", null, null), false],
  ["NaN", regRow("NaN", null, null), false],
  ["Infinity", regRow("Infinity", null, null), false],
  ["-Infinity", regRow("-Infinity", null, null), false],
  ["closed later with closer", regRow("1", T0 + 3600, CLOSER), true],
  ["closed at the same instant", regRow("1", T0, CLOSER), true],
  ["closed without closer", regRow("1", T0 + 3600, null), false],
  ["closer without close", regRow("1", null, CLOSER), false],
  ["closed before opened", regRow("1", T0 - 1, CLOSER), false],
];

async function registerCheckViolations(migration: string): Promise<string[]> {
  const accepts = await registerChecks(migration);
  return REGISTER_ROWS.filter(([, row, ok]) => accepts(row) !== ok).map(([label, , ok]) =>
    `${ok ? "refuses" : "accepts"} ${label}`
  );
}

const APPROVED_FKS: Fk[] = [
  { name: "register_sessions_paired_device_id_fkey", cols: ["paired_device_id"], table: "public.paired_devices", refCols: ["id"], onDelete: "a", onUpdate: "a", match: "s" },
  { name: "register_sessions_opened_by_employee_id_fkey", cols: ["opened_by_employee_id"], table: "public.employees", refCols: ["id"], onDelete: "a", onUpdate: "a", match: "s" },
  { name: "register_sessions_closed_by_employee_id_fkey", cols: ["closed_by_employee_id"], table: "public.employees", refCols: ["id"], onDelete: "a", onUpdate: "a", match: "s" },
  { name: "orders_employee_id_fkey", cols: ["employee_id"], table: "public.employees", refCols: ["id"], onDelete: "a", onUpdate: "a", match: "s" },
  { name: "orders_paired_device_id_fkey", cols: ["paired_device_id"], table: "public.paired_devices", refCols: ["id"], onDelete: "a", onUpdate: "a", match: "s" },
  { name: "orders_register_session_device_fkey", cols: ["register_session_id", "paired_device_id"], table: "public.register_sessions", refCols: ["id", "paired_device_id"], onDelete: "a", onUpdate: "a", match: "s" },
];

async function fkViolations(migration: string): Promise<string[]> {
  const actual = allForeignKeys(await statements(migration));
  const expected = JSON.stringify([...APPROVED_FKS].sort((a, b) => a.name.localeCompare(b.name)));
  const got = JSON.stringify([...actual].sort((a, b) => a.name.localeCompare(b.name)));

  return got === expected ? [] : [`foreign keys differ: ${got}`];
}

/** orders_register_session_requires_device, evaluated. */
async function ordersCheckViolations(migration: string): Promise<string[]> {
  const checks = ordersAlter(await statements(migration))
    .filter((c) => c.subtype === "AT_AddConstraint")
    .map((c) => (c.def as AstNode).Constraint as AstNode)
    .filter((c) => c.contype === "CONSTR_CHECK");
  const id = t("00000000-0000-0000-0000-00000000000b");
  const rows: Array<[string, Env, boolean]> = [
    ["nothing", { paired_device_id: null, register_session_id: null, employee_id: null }, true],
    ["device only", { paired_device_id: id, register_session_id: null, employee_id: null }, true],
    ["device + employee", { paired_device_id: id, register_session_id: null, employee_id: id }, true],
    ["device + register", { paired_device_id: id, register_session_id: id, employee_id: null }, true],
    ["all three", { paired_device_id: id, register_session_id: id, employee_id: id }, true],
    ["register without device", { paired_device_id: null, register_session_id: id, employee_id: null }, false],
    ["register + employee without device", { paired_device_id: null, register_session_id: id, employee_id: id }, false],
  ];
  const out: string[] = [];

  if (checks.length !== 1 || checks[0].conname !== "orders_register_session_requires_device") {
    out.push(`orders checks are ${checks.map((c) => c.conname).join(",")}`);
  }

  for (const [label, row, ok] of rows) {
    if (checks.every((c) => evaluate(c.raw_expr as AstNode, row) !== false) !== ok) {
      out.push(`${ok ? "refuses" : "accepts"} ${label}`);
    }
  }

  return out;
}

async function oneOpenViolations(migration: string): Promise<string[]> {
  const index = (await statements(migration))
    .map((s) => s.IndexStmt)
    .find((i) => i && i.idxname === "register_sessions_one_open_per_device");

  if (!index) return ["missing"];

  const out: string[] = [];
  const cols = (index.indexParams as AstNode[]).map((p) => (p.IndexElem as AstNode).name);

  if (!index.unique) out.push("not unique");
  if ((index.relation as AstNode).relname !== "register_sessions") out.push("wrong table");
  if (JSON.stringify(cols) !== JSON.stringify(["paired_device_id"])) out.push(`columns ${cols.join(",")}`);
  if (!index.whereClause) return [...out, "not partial"];
  if (evaluate(index.whereClause as AstNode, { closed_at: null }) !== true) out.push("excludes open sessions");
  if (evaluate(index.whereClause as AstNode, { closed_at: ts(T0) }) !== false) out.push("includes closed sessions");

  return out;
}

/** Posture of one new function: definer, search_path, ACL. */
function functionPostureViolations(migration: string, key: string): string[] {
  const exec = stripComments(migration);
  const def = definitionsIn(exec, FILENAME).find((d) => `${d.name}(${d.types})` === key);
  const out: string[] = [];

  if (!def) return ["not defined"];

  const header = def.header.toLowerCase().replace(/\s+/g, " ");
  if (!header.includes(" security definer ")) out.push("not security definer");
  if (!header.includes(" set search_path = public, pg_temp ")) out.push("search_path");
  if ((header.match(/ set /g) ?? []).length !== 1) out.push("extra set clause");

  const sig = key
    .replace(/timestamptz/g, "timestamptz")
    .replace(/^(\w+)\((.*)\)$/, (_m, name: string, args: string) => `${name}(${args.split(",").filter(Boolean).join(", ")})`);
  const acl = [...exec.matchAll(/^(revoke|grant) ([^;]*) on function public\.([^;]*?) (from|to) (\w+);$/gim)]
    .filter((m) => m[3] === sig)
    .map((m) => `${m[1].toLowerCase()} ${m[2].toLowerCase()} ${m[5].toLowerCase()}`)
    .sort();

  const expected = [
    "grant execute authenticated",
    "revoke all anon",
    "revoke all public",
    "revoke all service_role",
  ];

  if (JSON.stringify(acl) !== JSON.stringify(expected)) out.push(`acl ${acl.join(" | ")}`);

  return out;
}

type Lock = { table: string; mode: "update" | "no key update" | "share" | "key share" | "write" };

/** Table-level lock acquisition order of a PL/pgSQL body, callees inlined. */
function lockSequence(body: string, from: Map<string, FunctionDef>, depth = 0): Lock[] {
  const code = body.replace(/--[^\n]*/g, "").replace(/'[^']*'/g, "''");
  const events: Array<{ at: number; locks: Lock[] }> = [];

  for (const m of code.matchAll(/\bselect\b((?:(?!\bselect\b)[\s\S])*?)\bfor\s+(update|share|no key update|key share)\b(?:\s+of\s+([\w,\s]+?))?\s*;/gi)) {
    const text = m[0];
    const aliases = new Map<string, string>();

    for (const a of text.matchAll(/public\.(\w+)\s+(\w+)/g)) {
      aliases.set(a[2], a[1]);
    }

    const locked = m[3]
      ? m[3].split(",").map((a) => a.trim()).map((a) => aliases.get(a) ?? a)
      : [...aliases.values()];

    events.push({
      at: m.index ?? 0,
      locks: locked.map((table) => ({ table, mode: m[2].toLowerCase() as Lock["mode"] })),
    });
  }

  for (const m of code.matchAll(/\bupdate\s+public\.(\w+)/gi)) {
    events.push({ at: m.index ?? 0, locks: [{ table: m[1], mode: "no key update" }] });
  }

  for (const m of code.matchAll(/\bdelete\s+from\s+public\.(\w+)/gi)) {
    events.push({ at: m.index ?? 0, locks: [{ table: m[1], mode: "write" }] });
  }

  for (const m of code.matchAll(/\binsert\s+into\s+public\.(\w+)[^;]*?on\s+conflict[^;]*?do\s+update/gi)) {
    events.push({ at: m.index ?? 0, locks: [{ table: m[1], mode: "write" }] });
  }

  if (depth < 2) {
    for (const m of code.matchAll(/\bpublic\.(\w+)\s*\(/g)) {
      const callee = [...from.values()].find((d) => d.name === m[1].toLowerCase());
      if (callee && !/^(employee_pin_hash|employee_pin_verify)$/.test(callee.name)) {
        events.push({ at: m.index ?? 0, locks: lockSequence(callee.body, from, depth + 1) });
      }
    }
  }

  return events.sort((a, b) => a.at - b.at).flatMap((e) => e.locks);
}

function firstAcquisitionOrder(locks: Lock[]): string[] {
  return [...new Set(locks.map((l) => l.table))];
}

const LOCKING_FUNCTIONS = [
  V5, OPEN, CLOSE, V4, V3, V2, V1,
  "employee_login(uuid,text)",
  "employee_logout()",
  "set_employee_active(uuid,boolean)",
  "set_employee_pin(uuid,text)",
  "create_employee(uuid,text,text,text)",
  "revoke_paired_device(uuid)",
  "unpair_own_device()",
  "offer_device_config_update(uuid,uuid)",
  "apply_device_config_update()",
  "restock_inventory(uuid,text,integer)",
  "adjust_inventory(uuid,text,integer)",
];

/** Every pair "A is locked before B" across all functions, and any cycle. */
function lockOrderCycles(from: Map<string, FunctionDef>): string[] {
  const edges = new Map<string, Set<string>>();

  for (const key of LOCKING_FUNCTIONS) {
    const order = firstAcquisitionOrder(lockSequence(effective(key, from).body, from));

    for (let i = 0; i < order.length; i += 1) {
      for (let j = i + 1; j < order.length; j += 1) {
        if (!edges.has(order[i])) edges.set(order[i], new Set());
        edges.get(order[i])!.add(order[j]);
      }
    }
  }

  const cycles: string[] = [];

  for (const [a, targets] of edges) {
    for (const b of targets) {
      if (edges.get(b)?.has(a)) cycles.push(`${a} <-> ${b}`);
    }
  }

  return cycles.sort();
}

// Postgres row-lock conflict table (explicit locking, "Row-Level Locks").
const CONFLICTS: Record<Lock["mode"], Array<Lock["mode"]>> = {
  "key share": ["update", "write"],
  share: ["update", "no key update", "write"],
  "no key update": ["update", "no key update", "share", "write"],
  update: ["update", "no key update", "share", "key share", "write"],
  write: ["update", "no key update", "share", "key share", "write"],
};

function conflicts(a: Lock["mode"], b: Lock["mode"]): boolean {
  return CONFLICTS[a].includes(b);
}

function lockOn(key: string, table: string, from: Map<string, FunctionDef> = schema): Lock["mode"] | null {
  return lockSequence(effective(key, from).body, from, 2).find((l) => l.table === table)?.mode ?? null;
}

/** Parse one PL/pgSQL SELECT ... INTO ... statement as plain SQL. */
async function selectStatement(fragment: string): Promise<AstNode> {
  const plain = fragment.replace(/\binto\b[\s\S]*?(?=^\s*from\b)/m, "");
  return (await parse(plain)).stmts[0].stmt.SelectStmt as AstNode;
}

function statementEnding(body: string, anchor: string, terminator: string): string {
  const start = body.indexOf(anchor);
  if (start < 0) throw new Error(`no statement starting ${anchor}`);
  const end = body.indexOf(terminator, start);
  return body.slice(start, end + terminator.length);
}

// The v5 body, re-derived from v4.
type Edit = { label: string; old?: string; start?: string; end?: string; new: string };

const V5_EDITS: Edit[] = [
  {
    label: "declare the server-derived identities",
    old: "  v_device_paired_at  timestamptz;\n",
    new:
      "  v_device_paired_at  timestamptz;\n" +
      "  -- v1.3 Feature 1B — every identity below is DERIVED on the server. None of\n" +
      "  -- them is a parameter, and no parameter is ever copied into one.\n" +
      "  v_project_id    uuid;\n" +
      "  v_device_id     uuid;\n" +
      "  v_employee_id   uuid;\n" +
      "  v_register_session_id uuid;\n" +
      "  v_employee_session record;\n",
  },
  {
    label: "no project parameter to validate",
    old: "  if p_project_id is null then\n    raise exception 'Project ID is required';\n  end if;\n\n",
    new: "",
  },
  {
    label: "device-only authorization, locked, project derived",
    start: "  -- ==========================================================================\n  -- 2. Authorization.\n",
    end: "    raise exception 'Only a paired device can record an offline sale';\n  end if;\n",
    new: [
      "  -- ==========================================================================",
      "  -- 2. Authorization — v1.3 Feature 1B: DEVICE ONLY, project DERIVED.",
      "  --",
      "  -- complete_sale_v5 takes no project id. The project is the one the calling",
      "  -- device is paired to, read from the device's own row, so no request can",
      "  -- name another tenant. Owner Web and Builder stay on complete_sale_v3; an",
      "  -- owner's auth user has no paired_devices row and is refused here with the",
      "  -- same non-probing message every other refusal uses.",
      "  --",
      "  -- The device row is resolved WITHOUT the revoked/unpaired filter, exactly as",
      "  -- v4 does and for v4's reason: an idempotent replay of an order this project",
      "  -- already holds must still be answerable after the till is revoked. Both",
      "  -- decisions stay in the new-sale branch (6c), unchanged.",
      "  --",
      "  -- LOCK ORDER, step 1 of the Feature 1B global order: the device row FOR",
      "  -- SHARE, BEFORE the project row. employee_login, register open/close,",
      "  -- revoke, unpair and the config-update pair all take this row FOR UPDATE",
      "  -- (or UPDATE it) and none of them locks projects, so no cycle exists. Taking",
      "  -- it first also means a till's login — which holds this row across a bcrypt",
      "  -- verification — delays only that till's sales, never the whole project's.",
      "  -- Every device fact used later (pinned build, revocation, unpair) comes",
      "  -- from this locked read, so a concurrent config apply cannot slip a",
      "  -- different build under the pricing below.",
      "  -- ==========================================================================",
      "  select d.id, d.project_id, d.owner_id, d.build_job_id, d.revoked_at,",
      "         d.created_at, d.unpaired_at",
      "    into v_device_id, v_project_id, v_owner_id, v_build_job_id,",
      "         v_device_revoked_at, v_device_paired_at, v_device_unpaired_at",
      "  from public.paired_devices d",
      "  where d.auth_user_id = v_caller",
      "  for share;",
      "",
      "  if not found then",
      "    raise exception 'Project not found or access denied';",
      "  end if;",
      "",
      "  -- Constant. Every owner branch below is unreachable in v5 and is kept only so",
      "  -- the pricing, tax, receipt and inventory code stays byte-for-byte v4's.",
      "  v_is_owner := false;",
      "",
    ].join("\n"),
  },
  {
    label: "attribution, after every v4 new-sale gate and before pricing",
    old:
      "    -- ========================================================================\n" +
      "    -- 7. New sale. Resolve the authorized pricing source.\n",
    new: [
      "    -- ========================================================================",
      "    -- 6d. v1.3 Feature 1B — sale attribution. NEW SALES ONLY.",
      "    --",
      "    --     A replay returned above with the attribution it was stored with; it",
      "    --     never reaches this block, so a completed sale stays replayable after",
      "    --     a switch, logout, deactivation, register close or reopen.",
      "    --",
      "    --     LOCK ORDER, steps 3-5 (the device is step 1 and the project step 2,",
      "    --     both already held): employee POS session, employee, register session.",
      "    -- ========================================================================",
      "    if v_sale_source = 'online' then",
      "      -- ONLINE: current state, compared against what the till expected.",
      "      --",
      "      -- The two ids are CONCURRENCY EXPECTATIONS, never authority. Every",
      "      -- stored identity is read from the locked server row below.",
      "      if p_employee_pos_session_id is null or p_register_session_id is null then",
      "        raise exception 'This sale must name the signed-in employee and the open register';",
      "      end if;",
      "",
      "      -- FOR SHARE on BOTH rows. The session lock conflicts with employee_logout's",
      "      -- UPDATE (which takes no device lock); the employee lock conflicts with",
      "      -- set_employee_active's UPDATE. FOR KEY SHARE would NOT: it is compatible",
      "      -- with a non-key UPDATE. If either writer commits first, READ COMMITTED",
      "      -- re-checks this WHERE clause against the new row version, the row stops",
      "      -- qualifying, and the sale is refused. employee_login's switch is excluded",
      "      -- earlier, by the device lock.",
      "      select s.id, s.employee_id",
      "        into v_employee_session",
      "      from public.employee_pos_sessions s",
      "      join public.employees e on e.id = s.employee_id",
      "      where s.paired_device_id = v_device_id",
      "        and s.ended_at is null",
      "        and e.active",
      "        and e.project_id = v_project_id",
      "        and e.role in ('owner', 'manager', 'cashier')",
      "      for share of s, e;",
      "",
      "      if not found then",
      "        raise exception 'An employee must be signed in on this register';",
      "      end if;",
      "",
      "      if v_employee_session.id is distinct from p_employee_pos_session_id then",
      "        raise exception 'The signed-in employee changed';",
      "      end if;",
      "",
      "      -- register_session close takes the device row FOR UPDATE, so the step-1",
      "      -- lock already excludes it; this lock is the backstop for any future",
      "      -- writer of this row.",
      "      select r.id",
      "        into v_register_session_id",
      "      from public.register_sessions r",
      "      where r.paired_device_id = v_device_id",
      "        and r.closed_at is null",
      "      for share;",
      "",
      "      if not found then",
      "        raise exception 'The register is not open';",
      "      end if;",
      "",
      "      if v_register_session_id is distinct from p_register_session_id then",
      "        raise exception 'The register session changed';",
      "      end if;",
      "",
      "      v_employee_id := v_employee_session.employee_id;",
      "    else",
      "      -- OFFLINE: SERVER-VALIDATED HISTORICAL ATTRIBUTION — not cryptographically",
      "      -- proven operator identity.",
      "      --",
      "      -- The two ids are CLAIMS captured at offline checkout. Each dimension is",
      "      -- validated on its own against durable server history for THIS device",
      "      -- and the already-validated occurred_at. A claim that does not validate",
      "      -- is stored as NULL; it never rejects a paid sale, is never filled from",
      "      -- current state, and is never inferred from the other dimension.",
      "      --",
      "      -- KNOWN LIMITATION: Feature 1A keeps no history of active/inactive",
      "      -- intervals — deactivation leaves a session open and reactivation clears",
      "      -- deactivated_at — so the session interval cannot prove the employee was",
      "      -- active at every instant inside it. The claim is validated against the",
      "      -- session interval and the device/project relationship only.",
      "      if p_employee_pos_session_id is not null then",
      "        select s.employee_id",
      "          into v_employee_id",
      "        from public.employee_pos_sessions s",
      "        join public.employees e on e.id = s.employee_id",
      "        where s.id = p_employee_pos_session_id",
      "          and s.paired_device_id = v_device_id",
      "          and e.project_id = v_project_id",
      "          and s.started_at <= v_occurred_at",
      "          and (s.ended_at is null or v_occurred_at < s.ended_at)",
      "        for share of s;",
      "",
      "        if not found then",
      "          v_employee_id := null;",
      "        end if;",
      "      end if;",
      "",
      "      if p_register_session_id is not null then",
      "        select r.id",
      "          into v_register_session_id",
      "        from public.register_sessions r",
      "        where r.id = p_register_session_id",
      "          and r.paired_device_id = v_device_id",
      "          and r.opened_at <= v_occurred_at",
      "          and (r.closed_at is null or v_occurred_at < r.closed_at)",
      "        for share;",
      "",
      "        if not found then",
      "          v_register_session_id := null;",
      "        end if;",
      "      end if;",
      "    end if;",
      "",
      "    -- ========================================================================",
      "    -- 7. New sale. Resolve the authorized pricing source.",
      "",
    ].join("\n"),
  },
  {
    label: "store the attribution",
    old: "        build_job_id,\n        receipt_snapshot\n      )\n",
    new:
      "        build_job_id,\n        receipt_snapshot,\n" +
      "        -- v1.3 Feature 1B — all three derived above, never from a parameter.\n" +
      "        employee_id, paired_device_id, register_session_id\n      )\n",
  },
  {
    label: "store the attribution (values)",
    old: "        v_build_job_id,\n        v_receipt_snapshot\n      )\n",
    new:
      "        v_build_job_id,\n        v_receipt_snapshot,\n" +
      "        v_employee_id, v_device_id, v_register_session_id\n      )\n",
  },
  {
    label: "payload comment",
    old: "  --     build id, device id, config snapshot and inventory before/after values.\n",
    new:
      "  --     build id, config snapshot and inventory before/after values.\n" +
      "  --     v1.3 Feature 1B — the STORED attribution is returned, read from the\n" +
      "  --     order row, so a replay answers with what was recorded, never with\n" +
      "  --     who happens to be signed in now.\n",
  },
  {
    label: "return the stored attribution",
    old: "           'hasInventoryShortfall', o.has_inventory_shortfall,\n",
    new:
      "           'hasInventoryShortfall', o.has_inventory_shortfall,\n" +
      "           'attribution', jsonb_build_object(\n" +
      "             'employeeId', o.employee_id,\n" +
      "             'pairedDeviceId', o.paired_device_id,\n" +
      "             'registerSessionId', o.register_session_id\n" +
      "           ),\n",
  },
];

function applyEdits(body: string, edits: Edit[] = V5_EDITS): string {
  let out = body;

  for (const edit of edits) {
    if (edit.start !== undefined && edit.end !== undefined) {
      const a = out.indexOf(edit.start);
      const b = out.indexOf(edit.end);

      if (a < 0 || b < a || out.indexOf(edit.start, a + 1) >= 0 || out.indexOf(edit.end, b + 1) >= 0) {
        throw new Error(`anchor problem: ${edit.label}`);
      }

      out = out.slice(0, a) + edit.new + out.slice(b + edit.end.length);
    } else if (edit.old !== undefined) {
      if (out.split(edit.old).length !== 2) throw new Error(`anchor not unique: ${edit.label}`);
      out = out.replace(edit.old, () => edit.new);
    }
  }

  expect(out.split("p_project_id").length - 1).toBe(11);

  return out.replaceAll("p_project_id", "v_project_id");
}

/** The canonical-preimage block of a sale body. */
function hashPreimage(body: string): string {
  const start = body.indexOf("v_canonical :=");
  const end = body.indexOf("v_hash := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');", start);
  if (start < 0 || end < 0) throw new Error("no canonical preimage");
  return body.slice(start, end);
}

function hashViolations(body: string): string[] {
  const preimage = hashPreimage(body);
  const out: string[] = [];

  if (/employee|register|device|session|v_caller|v_owner_id/i.test(preimage)) out.push("identity in preimage");

  const v4 = hashPreimage(effective(V4).body).replaceAll("p_project_id", "v_project_id");
  if (preimage !== v4) out.push("preimage differs from v4");

  return out;
}

/** Ordered positions in the v5 body that the replay contract depends on. */
function replayOrderViolations(body: string): string[] {
  const at = (s: string) => body.indexOf(s);
  const out: string[] = [];
  const replay = at("select o.id, o.sale_request_hash into v_existing");

  const later = [
    "for share of s, e;",
    "raise exception 'An employee must be signed in on this register';",
    "raise exception 'The signed-in employee changed';",
    "raise exception 'The register is not open';",
    "raise exception 'The register session changed';",
    "from public.register_sessions r",
    "raise exception 'This sale must name the signed-in employee and the open register';",
  ];

  if (replay < 0) out.push("no replay lookup");

  for (const s of later) {
    if (at(s) < 0) out.push(`missing ${s}`);
    else if (at(s) < replay) out.push(`${s} precedes the replay lookup`);
  }

  if (at("from public.paired_devices d") > at("from public.projects p")) out.push("project before device");
  if (at("from public.projects p") > replay) out.push("replay before the project lock");

  return out;
}

// ===========================================================================
// 1. Ordering, immutability, grammar, scope
// ===========================================================================

describe("ordering and immutability", () => {
  it("sorts after every applied employee migration", () => {
    for (const earlier of [F1A, F1A1, CEILING, RECEIPT]) {
      expect(earlier < FILENAME).toBe(true);
    }
  });

  for (const [file, digest] of [
    [F1A, "724279536d2ceb995e4c55606106e1ec0c7f2c2cdd6cb3c0a6f6790c6fc015fc"],
    [F1A1, "cfa521949b22f4cb75dd8c9527478c781ea81a6db2d4fa53646fa7d8b7574c24"],
    [CEILING, "091faa90b40282be9245cd08b0dc40f4981a00601934b12bcec164754af729e5"],
    [RECEIPT, "b6f5ee8da29a9dc1c921478b0cb9b56040d56ce24822d1acc34236b366b84c82"],
  ] as const) {
    it(`${file} is byte-for-byte unchanged`, () => {
      expect(createHash("sha256").update(readFileSync(join(migrationsDir, file))).digest("hex")).toBe(digest);
    });
  }

  it("NEGATIVE CONTROL: a one-byte change to an applied migration changes its digest", () => {
    const altered = Buffer.concat([readFileSync(join(migrationsDir, CEILING)), Buffer.from("\n")]);

    expect(createHash("sha256").update(altered).digest("hex")).not.toBe(
      "091faa90b40282be9245cd08b0dc40f4981a00601934b12bcec164754af729e5"
    );
  });
});

describe("grammar and scope", () => {
  it("parses", async () => {
    expect((await parse(sql)).stmts.length).toBeGreaterThan(0);
  });

  it("defines exactly the four approved functions", () => {
    const defined = definitionsIn(executable, FILENAME).map((d) => `${d.name}(${d.types})`).sort();

    expect(defined).toEqual([...NEW_FUNCTIONS].sort());
  });

  it("drops nothing, creates exactly one table and four indexes, and adds no trigger or policy", async () => {
    const stmts = await statements(sql);

    expect(executable).not.toMatch(/\bdrop\s+(function|table|index|policy|trigger|column|constraint)\b/i);
    expect(stmts.filter((s) => s.CreateStmt).map((s) => (s.CreateStmt.relation as AstNode).relname)).toEqual([
      "register_sessions",
    ]);
    expect(stmts.filter((s) => s.IndexStmt).map((s) => s.IndexStmt.idxname)).toEqual([
      "register_sessions_one_open_per_device",
      "orders_employee_created_idx",
      "orders_paired_device_created_idx",
      "orders_register_session_idx",
    ]);
    expect(stmts.some((s) => s.CreateTrigStmt || s.CreatePolicyStmt || s.CreateSeqStmt || s.ViewStmt)).toBe(false);
    expect(executable).not.toMatch(/\bcreate\s+(or\s+replace\s+)?(trigger|policy|view|type|domain)\b/i);
  });

  it("alters only register_sessions (RLS) and orders (the attribution foundation)", async () => {
    const altered = (await statements(sql))
      .filter((s) => s.AlterTableStmt)
      .map((s) => (s.AlterTableStmt.relation as AstNode).relname);

    expect(altered).toEqual(["register_sessions", "orders"]);
  });

  it("uses dynamic SQL only inside the verification block", () => {
    const doBlock = executable.indexOf("do $do$");

    expect(doBlock).toBeGreaterThan(0);
    expect(executable.slice(0, doBlock).replace(/grant execute on function/gi, "")).not.toMatch(/\bexecute\b/i);
  });

  it("names no runtime, queue or native file and changes no other lane's objects", () => {
    for (const forbidden of [
      "DeviceApp", "offlineSaleRpc", "offlineCheckout", "saleQueue", "list_login_employees",
      "restock_inventory", "adjust_inventory", "get_device_recent_orders", "resolve_sale_owner",
    ]) {
      expect(executable).not.toContain(forbidden);
    }
  });

  it("introduces none of the deferred concepts", () => {
    const ddl = executable.slice(0, executable.indexOf("create or replace function"));

    for (const deferred of [
      /employee_display_name/i, /employee_role/i, /attribution_source/i, /close_reason/i,
      /expected_cash/i, /counted_cash/i, /actual_cash/i, /variance/i, /over_short/i,
      /cash_movement/i, /paid_(in|out)/i, /close_request_id/i, /\bclock_(in|out)\b/i, /barcode/i,
    ]) {
      expect(ddl).not.toMatch(deferred);
    }

    expect(executable).not.toMatch(/close_request_id/i);
    expect(executable).not.toMatch(/\bregisters\b/);
  });
});

// ===========================================================================
// 2. register_sessions schema
// ===========================================================================

describe("register_sessions: exact columns", () => {
  it("has exactly the approved columns, types, nullability and default", async () => {
    expect(columnsOf(registerTable(await statements(sql)))).toEqual([
      { name: "id", type: "uuid", notNull: true, primary: true, default: "gen_random_uuid()" },
      { name: "paired_device_id", type: "uuid", notNull: true, primary: false, default: null },
      { name: "opened_by_employee_id", type: "uuid", notNull: true, primary: false, default: null },
      { name: "opened_at", type: "timestamptz", notNull: true, primary: false, default: null },
      { name: "opening_cash", type: "numeric(12,2)", notNull: true, primary: false, default: null },
      { name: "open_request_id", type: "uuid", notNull: true, primary: false, default: null },
      { name: "closed_at", type: "timestamptz", notNull: false, primary: false, default: null },
      { name: "closed_by_employee_id", type: "uuid", notNull: false, primary: false, default: null },
    ]);
  });

  for (const absent of ["project_id", "employee_pos_session_id", "close_reason", "owner_id"]) {
    it(`has no ${absent}`, async () => {
      expect(columnsOf(registerTable(await statements(sql))).map((c) => c.name)).not.toContain(absent);
    });
  }

  it("NEGATIVE CONTROL: an added project_id column is detected", async () => {
    const mutated = sql.replace(
      "  closed_by_employee_id uuid,\n",
      "  closed_by_employee_id uuid,\n  project_id uuid,\n"
    );

    expect(mutated).not.toBe(sql);
    expect(columnsOf(registerTable(await statements(mutated))).map((c) => c.name)).toContain("project_id");
  });

  it("keys: open-request idempotency per device, and the composite identity", async () => {
    const keys = tableConstraints(registerTable(await statements(sql)))
      .filter((c) => c.contype === "CONSTR_UNIQUE")
      .map((c) => [c.conname, names(c.keys)]);

    expect(keys).toEqual([
      ["register_sessions_device_request_key", ["paired_device_id", "open_request_id"]],
      ["register_sessions_id_device_key", ["id", "paired_device_id"]],
    ]);
  });

  it("has exactly the five named CHECK constraints", async () => {
    const checks = tableConstraints(registerTable(await statements(sql)))
      .filter((c) => c.contype === "CONSTR_CHECK")
      .map((c) => c.conname);

    expect(checks).toEqual([
      "register_sessions_opening_cash_nonnegative",
      "register_sessions_opening_cash_finite",
      "register_sessions_opening_cash_scale",
      "register_sessions_closed_state",
      "register_sessions_closed_after_opened",
    ]);
  });
});

describe("register_sessions: CHECK constraints, evaluated", () => {
  for (const [label, row, ok] of REGISTER_ROWS) {
    it(`${ok ? "accepts" : "refuses"} ${label}`, async () => {
      expect((await registerChecks(sql))(row)).toBe(ok);
    });
  }

  it("NEGATIVE CONTROL: dropping the finiteness CHECK lets NaN through (NaN sorts above 0)", async () => {
    const mutated = sql.replace(
      /  constraint register_sessions_opening_cash_finite\n[\s\S]*?\n\n/,
      ""
    );

    expect(mutated).not.toBe(sql);
    expect(await registerCheckViolations(mutated)).toContain("accepts NaN");
  });

  it("NEGATIVE CONTROL: dropping the scale CHECK lets 12.345 through", async () => {
    const mutated = sql.replace(
      "  constraint register_sessions_opening_cash_scale\n    check (opening_cash = trunc(opening_cash, 2)),\n",
      ""
    );

    expect(mutated).not.toBe(sql);
    expect(await registerCheckViolations(mutated)).toEqual(
      expect.arrayContaining(["accepts three decimals", "accepts sub-cent"])
    );
  });

  it("NEGATIVE CONTROL: a one-way closed rule is not the biconditional", async () => {
    const mutated = sql.replace(
      "check ((closed_at is null) = (closed_by_employee_id is null))",
      "check (closed_at is null or closed_by_employee_id is not null)"
    );

    expect(mutated).not.toBe(sql);
    expect(await registerCheckViolations(mutated)).toContain("accepts closer without close");
  });

  it("NEGATIVE CONTROL: dropping the close-order CHECK is detected", async () => {
    const mutated = sql.replace("check (closed_at is null or closed_at >= opened_at)", "check (true)");

    expect(mutated).not.toBe(sql);
    expect(await registerCheckViolations(mutated)).toContain("accepts closed before opened");
  });
});

describe("the one-open-register-per-device index", () => {
  it("is UNIQUE on (paired_device_id) and partial on exactly the open sessions", async () => {
    expect(await oneOpenViolations(sql)).toEqual([]);
  });

  it("NEGATIVE CONTROL: removing the index is detected", async () => {
    const mutated = sql.replace(
      /create unique index register_sessions_one_open_per_device[\s\S]*?where closed_at is null;\n/,
      ""
    );

    expect(mutated).not.toBe(sql);
    expect(await oneOpenViolations(mutated)).toEqual(["missing"]);
  });

  it("NEGATIVE CONTROL: a non-unique or wrong-predicate index is detected", async () => {
    const plain = sql.replace(
      "create unique index register_sessions_one_open_per_device",
      "create index register_sessions_one_open_per_device"
    );
    const inverted = sql.replace(
      "  on public.register_sessions using btree (paired_device_id)\n  where closed_at is null;",
      "  on public.register_sessions using btree (paired_device_id)\n  where closed_at is not null;"
    );

    expect(await oneOpenViolations(plain)).toContain("not unique");
    expect(await oneOpenViolations(inverted)).toEqual(["excludes open sessions", "includes closed sessions"]);
  });
});

// ===========================================================================
// 3. Foreign keys and the orders attribution foundation
// ===========================================================================

describe("foreign keys: exactly the approved, history-preserving matrix", () => {
  it("six foreign keys, all ON DELETE / ON UPDATE NO ACTION, MATCH SIMPLE", async () => {
    expect(await fkViolations(sql)).toEqual([]);
  });

  it("no CASCADE, SET NULL, SET DEFAULT or RESTRICT anywhere in this file", () => {
    expect(executable).not.toMatch(/on\s+(delete|update)\s+(cascade|set\s+null|set\s+default|restrict)/i);
  });

  it("NEGATIVE CONTROL: CASCADE on the register's device is detected", async () => {
    const mutated = sql.replace(
      "    references public.paired_devices (id) on delete no action,\n\n  constraint register_sessions_opened_by",
      "    references public.paired_devices (id) on delete cascade,\n\n  constraint register_sessions_opened_by"
    );

    expect(mutated).not.toBe(sql);
    expect(await fkViolations(mutated)).not.toEqual([]);
  });

  it("NEGATIVE CONTROL: SET NULL on an order's employee is detected", async () => {
    const mutated = sql.replace(
      "    references public.employees (id) on delete no action,\n  add constraint orders_paired_device_id_fkey",
      "    references public.employees (id) on delete set null,\n  add constraint orders_paired_device_id_fkey"
    );

    expect(mutated).not.toBe(sql);
    expect(await fkViolations(mutated)).not.toEqual([]);
  });

  it("NEGATIVE CONTROL: a register-only foreign key (no device in the key) is detected", async () => {
    const mutated = sql.replace(
      "    foreign key (register_session_id, paired_device_id)\n    references public.register_sessions (id, paired_device_id) on delete no action,",
      "    foreign key (register_session_id)\n    references public.register_sessions (id) on delete no action,"
    );

    expect(mutated).not.toBe(sql);
    expect(await fkViolations(mutated)).not.toEqual([]);
  });

  it("NEGATIVE CONTROL: a MATCH FULL composite key is detected", async () => {
    const mutated = sql.replace(
      "references public.register_sessions (id, paired_device_id) on delete no action,",
      "references public.register_sessions (id, paired_device_id) match full on delete no action,"
    );

    expect(mutated).not.toBe(sql);
    expect(await fkViolations(mutated)).not.toEqual([]);
  });
});

function partialOn(where: AstNode | undefined): string | null {
  if (!where?.NullTest) return null;
  const test = where.NullTest as AstNode;
  return `${names(((test.arg as AstNode).ColumnRef as AstNode).fields).join(".")}:${String(test.nulltesttype)}`;
}

describe("orders attribution columns", () => {
  it("adds exactly three nullable, defaultless uuid columns", async () => {
    const added = ordersAlter(await statements(sql))
      .filter((c) => c.subtype === "AT_AddColumn")
      .map((c) => {
        const def = (c.def as AstNode).ColumnDef as AstNode;
        return { name: def.colname, type: typeText(def.typeName as AstNode), constraints: def.constraints ?? [] };
      });

    expect(added).toEqual([
      { name: "employee_id", type: "uuid", constraints: [] },
      { name: "paired_device_id", type: "uuid", constraints: [] },
      { name: "register_session_id", type: "uuid", constraints: [] },
    ]);
  });

  it("adds nothing else to orders: no snapshot, no source, no session column", async () => {
    const cmds = ordersAlter(await statements(sql));

    expect(cmds.map((c) => c.subtype)).toEqual([
      "AT_AddColumn", "AT_AddColumn", "AT_AddColumn",
      "AT_AddConstraint", "AT_AddConstraint", "AT_AddConstraint", "AT_AddConstraint",
    ]);
  });

  it("backfills nothing and writes no existing row", async () => {
    const topLevel = (await statements(sql)).map((s) => Object.keys(s)[0]);

    // No top-level data statement at all: only DDL, grants, comments and the
    // verification block. Function bodies write only when a caller runs them.
    expect(topLevel.filter((k) => /^(Insert|Update|Delete|Merge|Copy|Truncate)Stmt$/.test(k))).toEqual([]);
    expect(topLevel.filter((k) => k === "DoStmt")).toHaveLength(1);
    expect(executable).toContain("raise exception 'F1B: % existing order(s) were given an attribution; nothing may be backfilled', v_count;");
  });

  it("register -> device structural CHECK, evaluated", async () => {
    expect(await ordersCheckViolations(sql)).toEqual([]);
  });

  it("NEGATIVE CONTROL: removing the register -> device CHECK is detected", async () => {
    const mutated = sql.replace(
      ",\n  add constraint orders_register_session_requires_device\n    check (register_session_id is null or paired_device_id is not null);",
      ";"
    );

    expect(mutated).not.toBe(sql);
    expect(await ordersCheckViolations(mutated)).toEqual(
      expect.arrayContaining(["accepts register without device"])
    );
  });

  it("NEGATIVE CONTROL: a CHECK that allows a register id without a device is detected", async () => {
    const mutated = sql.replace(
      "check (register_session_id is null or paired_device_id is not null)",
      "check (register_session_id is null or employee_id is not null)"
    );

    expect(mutated).not.toBe(sql);
    expect(await ordersCheckViolations(mutated)).toContain("accepts register + employee without device");
  });

  it("NEGATIVE CONTROL: a CHECK that demands a register whenever a device exists is detected", async () => {
    const mutated = sql.replace(
      "check (register_session_id is null or paired_device_id is not null)",
      "check ((register_session_id is null) = (paired_device_id is null))"
    );

    expect(mutated).not.toBe(sql);
    expect(await ordersCheckViolations(mutated)).toEqual(
      expect.arrayContaining(["refuses device only", "refuses device + employee"])
    );
  });

  it("indexes: partial reporting indexes, one per attribution column", async () => {
    const idx = (await statements(sql))
      .map((s) => s.IndexStmt)
      .filter((i) => i && (i.relation as AstNode).relname === "orders")
      .map((i) => ({
        name: i.idxname,
        unique: Boolean(i.unique),
        cols: (i.indexParams as AstNode[]).map((p) => {
          const e = p.IndexElem as AstNode;
          return `${e.name}${e.ordering === "SORTBY_DESC" ? " desc" : ""}`;
        }),
        partialOn: partialOn(i.whereClause as AstNode | undefined),
      }));

    expect(idx).toEqual([
      { name: "orders_employee_created_idx", unique: false, cols: ["employee_id", "created_at desc"], partialOn: "employee_id:IS_NOT_NULL" },
      { name: "orders_paired_device_created_idx", unique: false, cols: ["paired_device_id", "created_at desc"], partialOn: "paired_device_id:IS_NOT_NULL" },
      { name: "orders_register_session_idx", unique: false, cols: ["register_session_id"], partialOn: "register_session_id:IS_NOT_NULL" },
    ]);
  });
});

// ===========================================================================
// 4. Security posture
// ===========================================================================

describe("register_sessions is RPC-only", () => {
  it("enables row level security and creates no policy", async () => {
    const stmts = await statements(sql);
    const rls = stmts
      .filter((s) => s.AlterTableStmt && (s.AlterTableStmt.relation as AstNode).relname === "register_sessions")
      .flatMap((s) => (s.AlterTableStmt.cmds as AstNode[]).map((c) => (c.AlterTableCmd as AstNode).subtype));

    expect(rls).toEqual(["AT_EnableRowSecurity"]);
    expect(stmts.some((s) => s.CreatePolicyStmt)).toBe(false);
  });

  it("revokes every table privilege from public, anon, authenticated and service_role, and grants none", async () => {
    const tableGrants = (await statements(sql))
      .map((s) => s.GrantStmt)
      .filter((g) => g && g.objtype === "OBJECT_TABLE")
      .map((g) => ({
        grant: Boolean(g.is_grant),
        table: ((g.objects as AstNode[])[0].RangeVar as AstNode).relname,
        privileges: g.privileges ?? "ALL",
        grantee: ((g.grantees as AstNode[])[0].RoleSpec as AstNode).rolename ?? "PUBLIC",
      }));

    expect(tableGrants).toEqual(
      ["PUBLIC", "anon", "authenticated", "service_role"].map((grantee) => ({
        grant: false, table: "register_sessions", privileges: "ALL", grantee,
      }))
    );
  });

  it("NEGATIVE CONTROL: a table grant is detected", async () => {
    const mutated = sql.replace(
      "revoke all privileges on table public.register_sessions from service_role;",
      "revoke all privileges on table public.register_sessions from service_role;\ngrant select on table public.register_sessions to authenticated;"
    );
    const grants = (await statements(mutated))
      .map((s) => s.GrantStmt)
      .filter((g) => g && g.objtype === "OBJECT_TABLE" && g.is_grant);

    expect(grants).toHaveLength(1);
  });
});

describe("function posture: SECURITY DEFINER, exact search_path, authenticated only", () => {
  for (const key of NEW_FUNCTIONS) {
    it(`${key}`, () => {
      expect(functionPostureViolations(sql, key)).toEqual([]);
    });
  }

  it("get_current_register_session is STABLE; the writers are not", () => {
    const header = (key: string) => definitionsIn(executable, FILENAME).find((d) => `${d.name}(${d.types})` === key)!.header.toLowerCase();

    expect(header(CURRENT)).toMatch(/\bstable\b/);

    for (const key of [OPEN, CLOSE, V5]) {
      expect(header(key)).not.toMatch(/\b(stable|immutable)\b/);
    }
  });

  it("NEGATIVE CONTROL: a service_role grant is detected", () => {
    const mutated = sql.replace(
      "revoke all on function public.close_register_session(uuid) from service_role;",
      "grant execute on function public.close_register_session(uuid) to service_role;"
    );

    expect(mutated).not.toBe(sql);
    expect(functionPostureViolations(mutated, CLOSE)).not.toEqual([]);
  });

  it("NEGATIVE CONTROL: a missing anon or public revoke is detected", () => {
    for (const line of [
      "revoke all on function public.open_register_session(uuid, numeric) from anon;\n",
      "revoke all on function public.open_register_session(uuid, numeric) from public;\n",
    ]) {
      const mutated = sql.replace(line, "");
      expect(mutated).not.toBe(sql);
      expect(functionPostureViolations(mutated, OPEN)).not.toEqual([]);
    }
  });

  it("NEGATIVE CONTROL: dropping SECURITY DEFINER is detected", () => {
    const mutated = sql.replace(
      "returns jsonb\nlanguage plpgsql\nsecurity definer\nset search_path = public, pg_temp\nas $function$\ndeclare\n  c_max_money",
      "returns jsonb\nlanguage plpgsql\nset search_path = public, pg_temp\nas $function$\ndeclare\n  c_max_money"
    );

    expect(mutated).not.toBe(sql);
    expect(functionPostureViolations(mutated, OPEN)).toContain("not security definer");
  });

  it("NEGATIVE CONTROL: a widened search_path is detected", () => {
    const i = sql.indexOf("create or replace function public.complete_sale_v5(");
    const mutated = sql.slice(0, i) + sql.slice(i).replace("set search_path = public, pg_temp", "set search_path = public, extensions, pg_temp");

    expect(functionPostureViolations(mutated, V5)).toContain("search_path");
  });

  it("the apply-time block asserts the same posture live", () => {
    for (const message of [
      "F1B: % must be SECURITY DEFINER",
      "F1B: % must lock search_path to exactly public, pg_temp",
      "F1B: authenticated must be able to execute %",
      "F1B: % must NOT be able to execute %",
      "F1B: PUBLIC must NOT be able to execute %",
      "F1B: row level security is off on register_sessions",
      "F1B: register_sessions must carry no policy",
      "F1B: % holds % on register_sessions",
      "F1B: PUBLIC holds a privilege on register_sessions",
    ]) {
      expect(executable).toContain(message);
    }
  });
});

// ===========================================================================
// 5. open_register_session
// ===========================================================================

describe("open_register_session: opening cash, evaluated from the SQL", () => {
  for (const cash of CASH_ACCEPTED) {
    it(`accepts ${cash}`, async () => {
      expect((await openingCashRules(sql))(n(cash))).toBe(true);
    });
  }

  for (const cash of CASH_REFUSED) {
    it(`refuses ${cash}`, async () => {
      expect((await openingCashRules(sql))(n(cash))).toBe(false);
    });
  }

  it("refuses null", async () => {
    expect((await openingCashRules(sql))(null)).toBe(false);
  });

  it("refuses 12.345 rather than rounding it: the rule compares the ORIGINAL argument", async () => {
    const body = src(OPEN);

    expect(body).toContain("if p_opening_cash <> round(p_opening_cash, 2) then");
    // Nothing assigns the argument to a rounded variable before it is checked.
    expect(body).not.toMatch(/:=\s*round\(/);
    expect(body.indexOf("round(p_opening_cash, 2)")).toBeLessThan(body.indexOf("insert into public.register_sessions"));
    expect(body).toContain("values (\n      v_device.id, v_employee_session.employee_id, clock_timestamp(), p_opening_cash, p_request_id\n    )");
  });

  it("every money rule is its own IF, before any table is read", () => {
    const body = src(OPEN);
    const firstRead = body.indexOf("from public.");

    for (const rule of [
      "if p_opening_cash is null then",
      "if p_opening_cash::text in ('NaN', 'Infinity', '-Infinity') then",
      "if p_opening_cash < 0 then",
      "if p_opening_cash <> round(p_opening_cash, 2) then",
      "if p_opening_cash > c_max_money then",
    ]) {
      expect(body.indexOf(rule)).toBeGreaterThan(0);
      expect(body.indexOf(rule)).toBeLessThan(firstRead);
    }
  });

  it("the ceiling matches numeric(12,2) and every money constant in the sale functions", () => {
    expect(src(OPEN)).toContain("c_max_money constant numeric := 9999999999.99;");
    expect(effective(V4).body).toContain("c_max_money      constant numeric := 9999999999.99;");
  });

  it("NEGATIVE CONTROL: removing the three-decimal rejection lets 12.345 through", async () => {
    const mutated = sql.replace(
      "  if p_opening_cash <> round(p_opening_cash, 2) then\n    return jsonb_build_object('ok', false, 'error', 'invalid_opening_cash');\n  end if;\n",
      ""
    );

    expect(mutated).not.toBe(sql);
    expect(await cashViolations(mutated)).toEqual(expect.arrayContaining(["accepts 12.345", "accepts 0.001"]));
  });

  it("NEGATIVE CONTROL: rounding first, then checking, is detected", async () => {
    const mutated = sql.replace(
      "  if p_opening_cash <> round(p_opening_cash, 2) then",
      "  if round(p_opening_cash, 2) <> round(p_opening_cash, 2) then"
    );

    expect(await cashViolations(mutated)).toContain("accepts 12.345");
  });

  it("NEGATIVE CONTROL: dropping the special-value rule is detected", async () => {
    const mutated = sql.replace(
      "  if p_opening_cash::text in ('NaN', 'Infinity', '-Infinity') then\n    return jsonb_build_object('ok', false, 'error', 'invalid_opening_cash');\n  end if;\n",
      ""
    );

    expect(mutated).not.toBe(sql);
    // NaN is neither < 0 nor different from round(NaN); only the ceiling stops it.
    expect(await cashViolations(mutated)).toEqual([]);
    const lowered = mutated.replace("  if p_opening_cash > c_max_money then", "  if false and p_opening_cash > c_max_money then");
    expect(await cashViolations(lowered)).toEqual(expect.arrayContaining(["accepts NaN", "accepts Infinity"]));
  });

  it("the apply-time block calls the live function with the same probes", () => {
    for (const probe of ["('12.345', 'invalid_opening_cash')", "('NaN', 'invalid_opening_cash')",
      "('Infinity', 'invalid_opening_cash')", "('-Infinity', 'invalid_opening_cash')",
      "('-0.01', 'invalid_opening_cash')", "('0', 'not_paired')", "('12.340', 'not_paired')"]) {
      expect(executable).toContain(probe);
    }
  });
});

describe("open_register_session: contract", () => {
  const body = () => src(OPEN);

  it("takes only a request id and an amount", () => {
    expect(definitionsIn(executable, FILENAME).find((d) => d.name === "open_register_session")!.header)
      .toMatch(/open_register_session\(\n  p_request_id uuid,\n  p_opening_cash numeric\n\)/);
  });

  it("derives device, project and employee from auth.uid(), from an ACTIVE device", () => {
    expect(body()).toContain("v_caller := auth.uid();");
    expect(body()).toContain(
      "  from public.paired_devices d\n  where d.auth_user_id = v_caller\n    and d.revoked_at is null\n    and d.unpaired_at is null\n  for update;"
    );
    expect(body()).toContain("    and e.project_id = v_device.project_id\n");
    expect(body()).toContain("    and e.active\n");
    expect(body()).toContain("    and e.role in ('owner', 'manager', 'cashier')\n");
  });

  it("returns exactly the approved error codes", () => {
    const codes = [...new Set([...body().matchAll(/'error', '([a-z_]+)'/g)].map((m) => m[1]))].sort();

    expect(codes).toEqual([
      "already_open", "employee_session_required", "invalid_opening_cash", "invalid_request",
      "not_authenticated", "not_paired", "request_conflict",
    ]);
  });

  it("replays by (device, request id) before requiring an employee, and even when closed", () => {
    const b = body();
    const replay = b.indexOf("    and r.open_request_id = p_request_id;");
    const requireEmployee = b.indexOf("if not v_has_employee then");

    expect(replay).toBeGreaterThan(0);
    expect(replay).toBeLessThan(requireEmployee);
    // The replay lookup does not filter on open state.
    expect(statementEnding(b, "  select r.id, r.opened_at", "p_request_id;")).not.toContain("closed_at is null");
    expect(b).toContain("    if v_register.opening_cash <> p_opening_cash then\n      return jsonb_build_object('ok', false, 'error', 'request_conflict');");
    expect(b).toContain("'replayed', true,");
  });

  it("refuses a second open while one is open, and returns the open session", () => {
    const b = body();

    expect(b.indexOf("if not v_has_employee then")).toBeLessThan(b.indexOf("    and r.closed_at is null;"));
    expect(b.indexOf("'error', 'already_open',")).toBeLessThan(b.indexOf("insert into public.register_sessions"));
  });

  it("stores the server clock and the signed-in employee, never a client value", () => {
    expect(body()).toContain(
      "      paired_device_id, opened_by_employee_id, opened_at, opening_cash, open_request_id"
    );
    expect(body()).toContain("v_device.id, v_employee_session.employee_id, clock_timestamp(), p_opening_cash, p_request_id");
  });

  it("returns only safe fields", () => {
    const keys = [...new Set([...body().matchAll(/'([a-zA-Z]+)', v_register\./g)].map((m) => m[1]))].sort();

    expect(keys).toEqual(["closedAt", "closedByEmployeeId", "openedAt", "openedByEmployeeId", "openingCash", "registerSessionId"]);
    expect(body()).not.toMatch(/'(pairedDeviceId|openRequestId|projectId|authUserId)'/);
  });
});

// ===========================================================================
// 6. get_current_register_session and close_register_session
// ===========================================================================

describe("get_current_register_session", () => {
  const body = () => src(CURRENT);

  it("takes no argument, reads the active device, and locks nothing", () => {
    expect(body()).toContain("    and d.revoked_at is null\n    and d.unpaired_at is null;");
    expect(body()).not.toMatch(/\bfor\s+(update|share|no key update|key share)\b/i);
    expect(body()).not.toMatch(/\b(insert|update|delete)\b\s+(into\s+)?public\./i);
  });

  it("answers null when no register is open, and only open sessions otherwise", () => {
    expect(body()).toContain("return jsonb_build_object('ok', true, 'registerSession', null);");
    expect(body()).toContain("    and r.closed_at is null;");
  });

  it("returns only safe fields and the approved error codes", () => {
    const keys = [...body().matchAll(/'([a-zA-Z]+)', /g)].map((m) => m[1]);

    expect(new Set(keys)).toEqual(new Set([
      "ok", "error", "registerSession", "registerSessionId", "openedAt", "openedByEmployeeId",
      "openingCash", "closedAt", "closedByEmployeeId",
    ]));
    expect([...new Set([...body().matchAll(/'error', '([a-z_]+)'/g)].map((m) => m[1]))].sort()).toEqual([
      "not_authenticated", "not_paired",
    ]);
  });
});

describe("close_register_session", () => {
  const body = () => src(CLOSE);

  it("takes only the target id and no close request id", () => {
    expect(definitionsIn(executable, FILENAME).find((d) => d.name === "close_register_session")!.header)
      .toMatch(/close_register_session\(\n  p_register_session_id uuid\n\)/);
  });

  it("returns exactly the approved error codes", () => {
    expect([...new Set([...body().matchAll(/'error', '([a-z_]+)'/g)].map((m) => m[1]))].sort()).toEqual([
      "employee_session_required", "not_authenticated", "not_found", "not_paired",
    ]);
  });

  it("finds the target only on the caller's own device", () => {
    expect(body()).toContain("  where r.id = p_register_session_id\n    and r.paired_device_id = v_device.id\n  for update;");
  });

  it("requires a signed-in employee only for the FIRST close", () => {
    const b = body();
    const firstClose = b.indexOf("  if v_register.closed_at is null then");
    const requirement = b.indexOf("return jsonb_build_object('ok', false, 'error', 'employee_session_required');");
    const endFirst = b.indexOf("  -- Already closed: the stored state, unchanged.");

    expect(firstClose).toBeGreaterThan(0);
    expect(requirement).toBeGreaterThan(firstClose);
    expect(requirement).toBeLessThan(endFirst);
    expect(b.slice(endFirst)).toContain("'alreadyClosed', true,");
    expect(b.slice(endFirst)).not.toContain("v_employee_session");
  });

  it("sets only closed_at and closed_by_employee_id, once", () => {
    const update = statementEnding(body(), "    update public.register_sessions r", "into v_register;");

    expect(update).toContain("    set closed_at = clock_timestamp(),\n        closed_by_employee_id = v_employee_session.employee_id\n");
    expect(update).toContain("    where r.id = v_register.id\n      and r.closed_at is null\n");
    expect((update.match(/=/g) ?? []).length).toBe(3);
    expect(body().match(/\bupdate\s+public\./gi)).toHaveLength(1);
    expect(body()).not.toMatch(/opening_cash\s*=/);
  });

  it("an old target can never close the current session: every write is keyed by the target id", () => {
    expect(body()).not.toMatch(/closed_at is null\s*\n\s*for update/);
    expect(body()).not.toMatch(/where r\.paired_device_id = v_device\.id\s*\n\s*and r\.closed_at is null/);
  });

  it("NEGATIVE CONTROL: closing 'the open session' instead of the target is detected", () => {
    const mutated = body().replace(
      "  where r.id = p_register_session_id\n    and r.paired_device_id = v_device.id\n  for update;",
      "  where r.paired_device_id = v_device.id\n    and r.closed_at is null\n  for update;"
    );

    expect(mutated).toMatch(/closed_at is null\s*\n\s*for update/);
  });
});

// ===========================================================================
// 7. complete_sale_v5
// ===========================================================================

describe("complete_sale_v5 is complete_sale_v4 plus the declared edits, byte for byte", () => {
  it("v4's effective body is the receipt-fidelity one", () => {
    expect(effective(V4).file).toBe(RECEIPT);
  });

  it("re-deriving v5 from v4 reproduces the migration exactly", () => {
    const v4 = rawBody(read(RECEIPT), V4);

    expect(applyEdits(v4)).toBe(rawBody(sql, V5));
  });

  it("every edit anchor exists exactly once in v4", () => {
    const v4 = rawBody(read(RECEIPT), V4);

    for (const edit of V5_EDITS) {
      if (edit.old !== undefined) expect(v4.split(edit.old).length - 1).toBe(1);
      if (edit.start !== undefined) expect(v4.split(edit.start).length - 1).toBe(1);
      if (edit.end !== undefined) expect(v4.split(edit.end).length - 1).toBe(1);
    }
  });

  it("NEGATIVE CONTROL: an undeclared change to v5 breaks the equality", () => {
    const v4 = rawBody(read(RECEIPT), V4);
    const tampered = rawBody(sql, V5).replace(
      "    if v_stock_before < v_quantity then",
      "    if v_stock_before < v_quantity and false then"
    );

    expect(tampered).not.toBe(rawBody(sql, V5));
    expect(applyEdits(v4)).not.toBe(tampered);
  });

  it("the preserved v4 behaviour is really there: pricing, tax, inventory, shortfall, receipt, line order, offline rules", () => {
    const body = src(V5);

    for (const kept of [
      "c_clock_skew     constant interval := interval '5 minutes';",
      "c_offline_max_age constant interval := interval '7 days';",
      "raise exception 'An online sale cannot declare its own sale time';",
      "raise exception 'Offline sale time is in the future';",
      "raise exception 'Offline sale time predates this device';",
      "raise exception 'Offline sale time is older than the offline limit';",
      "if p_occurred_at < now() - c_offline_max_age - c_clock_skew then",
      "raise exception 'This device is no longer paired';",
      "if v_occurred_at >= v_device_revoked_at then",
      "raise exception 'Tips are not supported on this device';",
      "raise exception 'Insufficient inventory for %', v_item_name;",
      "v_has_shortfall := true;",
      "v_tax_amount := round(v_subtotal - v_subtotal / (1 + v_rate / 100), 2);",
      "      when unique_violation then",
      "raise exception 'Sale request ID was already used for a different order';",
      "             line_no::integer",
      "order by oi.line_position nulls last,",
      "'receipt', coalesce(v_config -> 'receipt', '{}'::jsonb)",
      "-((line ->> 'stock_before')::integer - (line ->> 'stock_after')::integer),",
    ]) {
      expect(body).toContain(kept);
    }
  });
});

describe("complete_sale_v5: signature and identity", () => {
  const header = () => definitionsIn(executable, FILENAME).find((d) => d.name === "complete_sale_v5")!.header;

  it("has the exact device-only signature", () => {
    expect(header()).toContain(
      "complete_sale_v5(\n" +
      "  p_payment_method text,\n" +
      "  p_tip_amount numeric,\n" +
      "  p_items jsonb,\n" +
      "  p_sale_request_id uuid,\n" +
      "  p_occurred_at timestamptz default null,\n" +
      "  p_source text default 'online',\n" +
      "  p_employee_pos_session_id uuid default null,\n" +
      "  p_register_session_id uuid default null\n" +
      ")"
    );
  });

  it("accepts no project, employee, device or owner id", () => {
    expect(header()).not.toMatch(/p_(project_id|employee_id|paired_device_id|device_id|owner_id)\b/);
    expect(src(V5)).not.toContain("p_project_id");
  });

  it("derives every stored identity from locked server rows", () => {
    const body = src(V5);

    expect(body).toContain(
      "  select d.id, d.project_id, d.owner_id, d.build_job_id, d.revoked_at,\n" +
      "         d.created_at, d.unpaired_at\n" +
      "    into v_device_id, v_project_id, v_owner_id, v_build_job_id,\n" +
      "         v_device_revoked_at, v_device_paired_at, v_device_unpaired_at\n" +
      "  from public.paired_devices d\n" +
      "  where d.auth_user_id = v_caller\n" +
      "  for share;"
    );
    expect(body).toContain("v_employee_id := v_employee_session.employee_id;");
    expect(body).toContain("        v_employee_id, v_device_id, v_register_session_id\n      )");
    expect(body).toContain("v_is_owner := false;");
    expect(body.match(/v_is_owner :=/g)).toHaveLength(1);
  });

  it("never assigns a client id to a stored identity", () => {
    const body = src(V5);

    expect(body).not.toMatch(/v_(employee_id|device_id|register_session_id|project_id)\s*:=\s*p_/);
    expect(body).not.toMatch(/values\s*\([^;]*p_(employee_pos|register)_session_id/);
  });

  it("NEGATIVE CONTROL: copying the client's register id into the order is detected", () => {
    const mutated = src(V5).replace(
      "        v_employee_id, v_device_id, v_register_session_id\n      )",
      "        v_employee_id, v_device_id, p_register_session_id\n      )"
    );

    expect(mutated).toMatch(/values\s*\([^;]*p_(employee_pos|register)_session_id/);
  });

  it("NEGATIVE CONTROL: a direct employee_id parameter is detected", () => {
    const mutated = header().replace("  p_register_session_id uuid default null\n", "  p_register_session_id uuid default null,\n  p_employee_id uuid default null\n");

    expect(mutated).toMatch(/p_(project_id|employee_id|paired_device_id|device_id|owner_id)\b/);
    const assigned = src(V5).replace(
      "v_employee_id := v_employee_session.employee_id;",
      "v_employee_id := p_employee_id;"
    );
    expect(assigned).toMatch(/v_(employee_id|device_id|register_session_id|project_id)\s*:=\s*p_/);
  });

  it("the apply-time block refuses any identity parameter live", () => {
    expect(executable).toContain("arg in ('p_project_id', 'p_employee_id', 'p_paired_device_id', 'p_device_id', 'p_owner_id')");
  });
});

describe("complete_sale_v5: the sale hash carries no identity", () => {
  it("the preimage is v4's, with only the derived project id", () => {
    expect(hashViolations(src(V5))).toEqual([]);
    expect(hashPreimage(src(V5))).toContain("'project=' || v_project_id::text");
  });

  for (const [label, from, to] of [
    ["employee", "'tip=' || v_tip_amount::text || E'\\n' ||", "'tip=' || v_tip_amount::text || E'\\n' ||\n    'employee=' || v_employee_id::text || E'\\n' ||"],
    ["register", "'tip=' || v_tip_amount::text || E'\\n' ||", "'tip=' || v_tip_amount::text || E'\\n' ||\n    'register=' || p_register_session_id::text || E'\\n' ||"],
    ["device", "'project=' || v_project_id::text", "'project=' || v_project_id::text || v_device_id::text"],
  ] as const) {
    it(`NEGATIVE CONTROL: putting the ${label} into the hash is detected`, () => {
      const mutated = src(V5).replace(from, to);

      expect(mutated).not.toBe(src(V5));
      expect(hashViolations(mutated)).toContain("identity in preimage");
    });
  }
});

describe("complete_sale_v5: replay ordering", () => {
  it("the replay lookup follows the device and project locks and precedes every attribution requirement", () => {
    expect(replayOrderViolations(src(V5))).toEqual([]);
  });

  it("a replay returns the stored order, whose payload carries the STORED attribution", () => {
    const body = src(V5);

    expect(body).toContain(
      "           'attribution', jsonb_build_object(\n" +
      "             'employeeId', o.employee_id,\n" +
      "             'pairedDeviceId', o.paired_device_id,\n" +
      "             'registerSessionId', o.register_session_id\n" +
      "           ),"
    );
    // One payload path, read from the order row, used by both branches.
    expect(body.match(/into v_payload/g)).toHaveLength(1);
    expect(body.indexOf("into v_payload")).toBeGreaterThan(body.lastIndexOf("  end if;\n\n  -- ====="));
  });

  it("the attribution block lives inside the new-sale branch", () => {
    const body = src(V5);
    const miss = body.indexOf("    v_order_id := v_existing.id;\n  else\n");
    const block = body.indexOf("    -- 6d. v1.3 Feature 1B — sale attribution. NEW SALES ONLY.");
    const insert = body.indexOf("      insert into public.orders (");

    expect(miss).toBeGreaterThan(0);
    expect(block).toBeGreaterThan(miss);
    expect(block).toBeLessThan(insert);
  });

  it("NEGATIVE CONTROL: requiring the current employee before the replay lookup is detected", () => {
    const body = src(V5);
    const hoisted = body.replace(
      "  select o.id, o.sale_request_hash into v_existing",
      "  select s.id into v_employee_session from public.employee_pos_sessions s join public.employees e on e.id = s.employee_id where s.ended_at is null for share of s, e;\n  if not found then\n    raise exception 'An employee must be signed in on this register';\n  end if;\n  select o.id, o.sale_request_hash into v_existing"
    );

    expect(replayOrderViolations(hoisted)).not.toEqual([]);
  });

  it("NEGATIVE CONTROL: locking the project before the device is detected", () => {
    const body = src(V5);
    const lockAt = body.indexOf("  select d.id, d.project_id, d.owner_id");
    const swapped =
      "  select p.config into v_config\n  from public.projects p\n  where true\n  for update;\n" + body.slice(lockAt);

    expect(replayOrderViolations(swapped)).toContain("project before device");
  });
});

describe("complete_sale_v5: online attribution", () => {
  const onlineBlock = () => {
    const body = src(V5);
    return body.slice(body.indexOf("    if v_sale_source = 'online' then\n      -- ONLINE"), body.indexOf("    else\n      -- OFFLINE"));
  };

  it("requires both expectations", () => {
    expect(onlineBlock()).toContain(
      "      if p_employee_pos_session_id is null or p_register_session_id is null then\n" +
      "        raise exception 'This sale must name the signed-in employee and the open register';"
    );
  });

  it("compares each expectation with the locked server row and refuses a mismatch", () => {
    expect(onlineBlock()).toContain(
      "      if v_employee_session.id is distinct from p_employee_pos_session_id then\n" +
      "        raise exception 'The signed-in employee changed';"
    );
    expect(onlineBlock()).toContain(
      "      if v_register_session_id is distinct from p_register_session_id then\n" +
      "        raise exception 'The register session changed';"
    );
  });

  it("the current-session query is filtered to an OPEN session of an ACTIVE employee of THIS project, on THIS device", async () => {
    const stmt = await selectStatement(
      statementEnding(onlineBlock(), "      select s.id, s.employee_id", "for share of s, e;").trim()
    );
    const where = stmt.whereClause as AstNode;
    const DEV = t("dev-1");
    const PROJ = t("proj-1");
    const base: Env = {
      "s.paired_device_id": DEV, "s.ended_at": null, "e.active": true, "e.project_id": PROJ,
      "e.role": t("cashier"), v_device_id: DEV, v_project_id: PROJ,
    };

    expect(evaluate(where, base)).toBe(true);
    for (const role of ["owner", "manager"]) expect(evaluate(where, { ...base, "e.role": t(role) })).toBe(true);
    expect(evaluate(where, { ...base, "s.ended_at": ts(T0) })).toBe(false);
    expect(evaluate(where, { ...base, "e.active": false })).toBe(false);
    expect(evaluate(where, { ...base, "e.project_id": t("proj-2") })).toBe(false);
    expect(evaluate(where, { ...base, "s.paired_device_id": t("dev-2") })).toBe(false);
  });

  it("requires an open register session of THIS device", async () => {
    const stmt = await selectStatement(
      statementEnding(onlineBlock(), "      select r.id", "      for share;").trim()
    );
    const where = stmt.whereClause as AstNode;
    const DEV = t("dev-1");

    expect(evaluate(where, { "r.paired_device_id": DEV, "r.closed_at": null, v_device_id: DEV })).toBe(true);
    expect(evaluate(where, { "r.paired_device_id": DEV, "r.closed_at": ts(T0), v_device_id: DEV })).toBe(false);
    expect(evaluate(where, { "r.paired_device_id": t("dev-2"), "r.closed_at": null, v_device_id: DEV })).toBe(false);
    expect(onlineBlock()).toContain("raise exception 'The register is not open';");
  });

  it("an online revoked or unpaired device is refused before attribution (v4's gates)", () => {
    const body = src(V5);

    expect(body.indexOf("raise exception 'This device is no longer paired';")).toBeLessThan(
      body.indexOf("-- 6d. v1.3 Feature 1B")
    );
    expect(body).toContain(
      "      if v_sale_source <> 'offline_queued' then\n" +
      "        -- A revoked device gets no NEW online sale."
    );
  });
});

// ===========================================================================
// 8. Concurrency: lock modes, conflicts, ordering
// ===========================================================================

describe("concurrency: the sale's locks conflict with exactly the writers they must", () => {
  it("parsed lock strengths of the v5 attribution reads", async () => {
    const body = src(V5);
    const strength = async (anchor: string, end: string) => {
      const stmt = await selectStatement(statementEnding(body, anchor, end).trim());
      return ((stmt.lockingClause as AstNode[])[0].LockingClause as AstNode).strength;
    };

    expect(await strength("  select d.id, d.project_id, d.owner_id", "  for share;")).toBe("LCS_FORSHARE");
    expect(await strength("      select s.id, s.employee_id", "for share of s, e;")).toBe("LCS_FORSHARE");
    expect(await strength("      select r.id\n        into v_register_session_id", "      for share;")).toBe("LCS_FORSHARE");
  });

  it("the employee-session read locks BOTH the session and the employee", async () => {
    const body = src(V5);
    const stmt = await selectStatement(statementEnding(body, "      select s.id, s.employee_id", "for share of s, e;").trim());
    const rels = ((stmt.lockingClause as AstNode[])[0].LockingClause as AstNode).lockedRels as AstNode[];

    expect(rels.map((r) => (r.RangeVar as AstNode).relname)).toEqual(["s", "e"]);
  });

  it("sale vs employee switch: employee_login's device lock conflicts with the sale's", () => {
    expect(lockOn("employee_login(uuid,text)", "paired_devices")).toBe("update");
    expect(lockOn(V5, "paired_devices")).toBe("share");
    expect(conflicts(lockOn(V5, "paired_devices")!, lockOn("employee_login(uuid,text)", "paired_devices")!)).toBe(true);
  });

  it("sale vs deactivation: set_employee_active's UPDATE conflicts with the sale's employee lock", () => {
    expect(lockOn("set_employee_active(uuid,boolean)", "employees")).toBe("no key update");
    expect(lockOn(V5, "employees")).toBe("share");
    expect(conflicts("share", "no key update")).toBe(true);
    // The trap: KEY SHARE would NOT have conflicted.
    expect(conflicts("key share", "no key update")).toBe(false);
  });

  it("sale vs logout: employee_logout's UPDATE conflicts with the sale's session lock", () => {
    expect(lockOn("employee_logout()", "employee_pos_sessions")).toBe("no key update");
    expect(lockOn("employee_logout()", "paired_devices")).toBeNull();
    expect(lockOn(V5, "employee_pos_sessions")).toBe("share");
    expect(conflicts("share", "no key update")).toBe(true);
  });

  it("sale vs register close: close's device and register locks conflict with the sale's", () => {
    expect(lockOn(CLOSE, "paired_devices")).toBe("update");
    expect(lockOn(CLOSE, "register_sessions")).toBe("update");
    expect(conflicts(lockOn(V5, "paired_devices")!, "update")).toBe(true);
    expect(conflicts(lockOn(V5, "register_sessions")!, "update")).toBe(true);
  });

  it("sale vs revoke / unpair / config apply: each conflicts with the sale's device lock", () => {
    for (const key of ["revoke_paired_device(uuid)", "unpair_own_device()", "apply_device_config_update()", "offer_device_config_update(uuid,uuid)"]) {
      const mode = lockOn(key, "paired_devices");
      expect(mode).not.toBeNull();
      expect(conflicts("share", mode!)).toBe(true);
    }
  });

  it("two sales on one device do not block each other at the device (both SHARE)", () => {
    expect(conflicts("share", "share")).toBe(false);
  });

  it("open and close serialize against each other at the device", () => {
    expect(lockOn(OPEN, "paired_devices")).toBe("update");
    expect(conflicts("update", "update")).toBe(true);
  });

  it("re-check after a concurrent commit: every locked read filters on the state the writer changes", () => {
    const body = src(V5);

    expect(body).toContain("      where s.paired_device_id = v_device_id\n        and s.ended_at is null\n        and e.active\n");
    expect(body).toContain("      where r.paired_device_id = v_device_id\n        and r.closed_at is null\n      for share;");
  });

  it("NEGATIVE CONTROL: a KEY SHARE employee lock would be detected", () => {
    const mutated = new Map(schema);
    const def = effective(V5);
    mutated.set(V5, { ...def, body: def.body.replace("      for share of s, e;", "      for key share of s, e;") });

    expect(lockOn(V5, "employees", mutated)).toBe("key share");
    expect(conflicts(lockOn(V5, "employees", mutated)!, "no key update")).toBe(false);
  });

  it("NEGATIVE CONTROL: an unlocked session read would be detected", () => {
    const mutated = new Map(schema);
    const def = effective(V5);
    mutated.set(V5, { ...def, body: def.body.replace("      for share of s, e;", "      ;").replace(/        for share of s;/, "        ;") });

    expect(lockOn(V5, "employee_pos_sessions", mutated)).toBeNull();
  });
});

describe("concurrency: one global lock order, no cycle", () => {
  it("v5 acquires device, project, session, employee, register, then v4's counter", () => {
    expect(firstAcquisitionOrder(lockSequence(src(V5), schema))).toEqual([
      "paired_devices", "projects", "employee_pos_sessions", "employees", "register_sessions",
      "project_order_counters",
    ]);
  });

  it("close acquires device, session, employee, register — never the project", () => {
    expect(firstAcquisitionOrder(lockSequence(effective(CLOSE).body, schema))).toEqual([
      "paired_devices", "employee_pos_sessions", "employees", "register_sessions",
    ]);
  });

  it("open acquires device, session, employee — never the project — and then only reads and inserts registers", () => {
    expect(firstAcquisitionOrder(lockSequence(effective(OPEN).body, schema))).toEqual([
      "paired_devices", "employee_pos_sessions", "employees",
    ]);

    const body = src(OPEN);
    expect(body.indexOf("from public.register_sessions r")).toBeGreaterThan(body.indexOf("for share of s, e;"));
    expect(body.indexOf("insert into public.register_sessions")).toBeGreaterThan(body.indexOf("for share of s, e;"));
  });

  it("no device RPC and no earlier sale function locks the project together with the device", () => {
    for (const key of LOCKING_FUNCTIONS.filter((k) => k !== V5)) {
      const order = firstAcquisitionOrder(lockSequence(effective(key).body, schema));
      expect(`${key}: ${order.includes("projects") && order.includes("paired_devices")}`).toBe(`${key}: false`);
    }
  });

  it("across every locking function, no pair of tables is ever taken in both orders", () => {
    expect(lockOrderCycles(schema)).toEqual([]);
  });

  it("NEGATIVE CONTROL: a close that locked the register before the device creates a cycle", () => {
    const mutated = new Map(schema);
    const def = effective(CLOSE);
    mutated.set(CLOSE, {
      ...def,
      body: "  select r.id from public.register_sessions r where true for update;\n" + def.body,
    });

    expect(lockOrderCycles(mutated)).toContain("paired_devices <-> register_sessions");
  });

  it("NEGATIVE CONTROL: a device RPC that locked the project would create a cycle", () => {
    const mutated = new Map(schema);
    const key = "revoke_paired_device(uuid)";
    const def = effective(key);
    mutated.set(key, { ...def, body: "  select 1 from public.projects p where true for update;\n" + def.body });

    expect(lockOrderCycles(mutated)).toContain("paired_devices <-> projects");
  });
});

// ===========================================================================
// 9. Offline: server-validated historical attribution
// ===========================================================================

describe("offline: server-validated historical attribution", () => {
  const offlineBlock = () => {
    const body = src(V5);
    return body.slice(body.indexOf("    else\n      -- OFFLINE"), body.indexOf("    -- 7. New sale."));
  };

  const employeeWhere = async () =>
    ((await selectStatement(statementEnding(offlineBlock(), "        select s.employee_id", "for share of s;").trim()))
      .whereClause) as AstNode;
  const registerWhere = async () =>
    ((await selectStatement(statementEnding(offlineBlock(), "        select r.id", "        for share;").trim()))
      .whereClause) as AstNode;

  const DEV = t("dev-1");
  const PROJ = t("proj-1");
  const CLAIM = t("claim-1");
  const OCC = ts(T0);

  const empEnv = (over: Env = {}): Env => ({
    "s.id": CLAIM, "s.paired_device_id": DEV, "e.project_id": PROJ,
    "s.started_at": ts(T0 - 600), "s.ended_at": null,
    p_employee_pos_session_id: CLAIM, v_device_id: DEV, v_project_id: PROJ, v_occurred_at: OCC,
    ...over,
  });
  const regEnv = (over: Env = {}): Env => ({
    "r.id": CLAIM, "r.paired_device_id": DEV, "r.opened_at": ts(T0 - 600), "r.closed_at": null,
    p_register_session_id: CLAIM, v_device_id: DEV, v_occurred_at: OCC,
    ...over,
  });

  it("a valid employee claim: still-open session", async () => {
    expect(evaluate(await employeeWhere(), empEnv())).toBe(true);
  });

  it("a valid employee claim: ended after the sale", async () => {
    expect(evaluate(await employeeWhere(), empEnv({ "s.ended_at": ts(T0 + 1) }))).toBe(true);
  });

  it("interval bounds: [started_at, ended_at)", async () => {
    const where = await employeeWhere();

    expect(evaluate(where, empEnv({ "s.started_at": OCC }))).toBe(true);
    expect(evaluate(where, empEnv({ "s.started_at": ts(T0 + 1) }))).toBe(false);
    expect(evaluate(where, empEnv({ "s.ended_at": OCC }))).toBe(false);
    expect(evaluate(where, empEnv({ "s.ended_at": ts(T0 - 1) }))).toBe(false);
  });

  it("a cross-device employee claim is not valid", async () => {
    expect(evaluate(await employeeWhere(), empEnv({ "s.paired_device_id": t("dev-2") }))).toBe(false);
  });

  it("an employee of another project is not valid", async () => {
    expect(evaluate(await employeeWhere(), empEnv({ "e.project_id": t("proj-2") }))).toBe(false);
  });

  it("a different (unknown) session is not valid", async () => {
    expect(evaluate(await employeeWhere(), empEnv({ "s.id": t("other") }))).toBe(false);
  });

  it("KNOWN LIMITATION, pinned: current employee activity is NOT part of the historical rule", async () => {
    const where = await employeeWhere();

    // The WHERE clause names no active/deactivated column, so an employee
    // deactivated since the sale still validates. Feature 1A keeps no history
    // of active intervals; see the SQL comment.
    expect(JSON.stringify(where)).not.toMatch(/"(active|deactivated_at)"/);
    expect(offlineBlock()).toContain("KNOWN LIMITATION");
  });

  it("a valid register claim: open, or closed after the sale", async () => {
    const where = await registerWhere();

    expect(evaluate(where, regEnv())).toBe(true);
    expect(evaluate(where, regEnv({ "r.closed_at": ts(T0 + 1) }))).toBe(true);
    expect(evaluate(where, regEnv({ "r.opened_at": OCC }))).toBe(true);
  });

  it("register interval bounds and ownership", async () => {
    const where = await registerWhere();

    expect(evaluate(where, regEnv({ "r.opened_at": ts(T0 + 1) }))).toBe(false);
    expect(evaluate(where, regEnv({ "r.closed_at": OCC }))).toBe(false);
    expect(evaluate(where, regEnv({ "r.closed_at": ts(T0 - 1) }))).toBe(false);
    expect(evaluate(where, regEnv({ "r.paired_device_id": t("dev-2") }))).toBe(false);
    expect(evaluate(where, regEnv({ "r.id": t("other") }))).toBe(false);
  });

  it("an invalid claim becomes NULL; nothing in the offline branch can refuse the sale", () => {
    const block = offlineBlock();

    expect(block).not.toMatch(/\braise\b/i);
    expect(block).toContain("        if not found then\n          v_employee_id := null;\n        end if;");
    expect(block).toContain("        if not found then\n          v_register_session_id := null;\n        end if;");
  });

  it("the two dimensions are validated independently, and neither is inferred from current state", () => {
    const block = offlineBlock();

    expect(block).toContain("      if p_employee_pos_session_id is not null then");
    expect(block).toContain("      if p_register_session_id is not null then");
    expect(block).not.toMatch(/ended_at is null\s*\n\s*and e\.active/);
    expect(block).not.toContain("closed_at is null\n        for share");
    expect(block).not.toMatch(/v_employee_id[^;]*register|v_register_session_id[^;]*employee/i);
  });

  it("every combination is structurally storable, and the device is always the syncing one", async () => {
    const orders = (await statements(sql));
    const checks = ordersAlter(orders)
      .filter((c) => c.subtype === "AT_AddConstraint")
      .map((c) => (c.def as AstNode).Constraint as AstNode)
      .filter((c) => c.contype === "CONSTR_CHECK");
    const E = t("emp");
    const R = t("reg");

    for (const [employee, register] of [[E, R], [E, null], [null, R], [null, null]] as const) {
      const row: Env = { paired_device_id: DEV, employee_id: employee, register_session_id: register };
      expect(checks.every((c) => evaluate(c.raw_expr as AstNode, row) !== false)).toBe(true);
    }

    // v_device_id is assigned once, from the locked device row, before any branch.
    const body = src(V5);
    expect(body.match(/v_device_id\b(?=,|\s*\n)/g)?.length).toBeGreaterThan(0);
    expect(body).not.toMatch(/v_device_id\s*:=/);
  });

  it("offline claims are locked against a concurrent logout or close", async () => {
    const stmt = await selectStatement(statementEnding(offlineBlock(), "        select s.employee_id", "for share of s;").trim());

    expect(((stmt.lockingClause as AstNode[])[0].LockingClause as AstNode).strength).toBe("LCS_FORSHARE");
  });

  it("NEGATIVE CONTROL: rejecting an unprovable claim would be detected", () => {
    const mutated = offlineBlock().replace(
      "          v_employee_id := null;",
      "          raise exception 'Unknown employee session';"
    );

    expect(mutated).toMatch(/\braise\b/i);
  });

  it("NEGATIVE CONTROL: dropping the device predicate from the claim is detected", async () => {
    const text = statementEnding(offlineBlock(), "        select s.employee_id", "for share of s;")
      .replace("          and s.paired_device_id = v_device_id\n", "");
    const where = (await selectStatement(text.trim())).whereClause as AstNode;

    expect(evaluate(where, empEnv({ "s.paired_device_id": t("dev-2") }))).toBe(true);
  });
});

// ===========================================================================
// 10. Legacy: v1-v4 untouched, and they write NULL attribution
// ===========================================================================

describe("legacy sale functions", () => {
  for (const key of LEGACY) {
    it(`${key} is still defined by ${RECEIPT}`, () => {
      expect(effective(key).file).toBe(RECEIPT);
    });
  }

  it("this migration redefines none of them", () => {
    expect(executable).not.toMatch(/create\s+or\s+replace\s+function\s+(public\.)?complete_sale(_v[234])?\s*\(/i);
  });

  it("NEGATIVE CONTROL: redefining v4 here is detected", () => {
    const mutated =
      sql +
      "\ncreate or replace function public.complete_sale_v4(p_project_id uuid, p_payment_method text, p_tip_amount numeric, p_items jsonb, p_sale_request_id uuid, p_occurred_at timestamp with time zone default null, p_source text default 'online')\nreturns jsonb\nlanguage sql\nas $function$ select '{}'::jsonb $function$;\n";

    expect(effective(V4, schemaWith(mutated)).file).toBe(FILENAME);
  });

  for (const key of LEGACY) {
    it(`${key} names no attribution column, so its orders keep NULL`, () => {
      const body = effective(key).body;

      expect(body).toContain("insert into public.orders");
      expect(body).not.toMatch(/\b(employee_id|paired_device_id|register_session_id)\b/);
    });
  }

  it("the new columns have no default and no trigger can fill them", async () => {
    const stmts = await statements(sql);

    expect(stmts.some((s) => s.CreateTrigStmt)).toBe(false);
    for (const cmd of ordersAlter(stmts).filter((c) => c.subtype === "AT_AddColumn")) {
      expect(((cmd.def as AstNode).ColumnDef as AstNode).constraints ?? []).toEqual([]);
    }
  });

  it("receipt fidelity, inventory and occurred_at code in v4 is unchanged in v5 apart from the declared edits", () => {
    const v4 = rawBody(read(RECEIPT), V4);
    const v5 = rawBody(sql, V5);

    for (const block of [
      v4.slice(v4.indexOf("    -- 8. Per-item server pricing"), v4.indexOf("    -- 10. Order number.")),
      v4.slice(v4.indexOf("    -- Only write the rest when this call actually created the order."), v4.indexOf("  -- 12. Authoritative payload")),
    ]) {
      expect(block.length).toBeGreaterThan(500);
      expect(v5).toContain(block.replaceAll("p_project_id", "v_project_id"));
    }
  });

  it("the apply-time block proves every pre-existing function byte-identical", () => {
    for (const message of [
      "F1B: % was created or replaced by this migration",
      "F1B: function %(%) changed or was dropped",
      "F1B: new functions are %, expected exactly the four approved RPCs",
    ]) {
      expect(executable).toContain(message);
    }

    for (const sig of [
      "'public.complete_sale(uuid,text,text,numeric,numeric,numeric,numeric,jsonb)'",
      "'public.complete_sale_v2(uuid,text,numeric,jsonb,uuid)'",
      "'public.complete_sale_v3(uuid,text,numeric,jsonb,uuid)'",
      "'public.complete_sale_v4(uuid,text,numeric,jsonb,uuid,timestamptz,text)'",
    ]) {
      expect(executable).toContain(sig);
    }
  });
});

// ===========================================================================
// 11. The apply-time verification block
// ===========================================================================

describe("apply-time verification", () => {
  it("baselines are captured before any DDL", () => {
    const firstDdl = executable.indexOf("create table public.register_sessions");

    for (const baseline of [
      "f1b_proc_baseline", "f1b_pol_baseline", "f1b_priv_baseline", "f1b_rls_baseline",
      "f1b_trg_baseline", "f1b_idx_baseline", "f1b_con_baseline", "f1b_col_baseline", "f1b_row_baseline",
    ]) {
      const at = executable.indexOf(`create temporary table ${baseline} as`);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(firstDdl);
    }
  });

  it("asserts every part of the contract", () => {
    for (const message of [
      "F1B: expected 20260914120000, 20260916120000 and 20260916130000 in the ledger, found % of 3",
      "F1B: register_sessions columns are not exactly the approved set: %",
      "F1B: register_sessions CHECK constraints are %",
      "F1B: register_sessions CHECKs % the row (cash %, closed %, closer %)",
      "F1B: foreign key % is missing, or is not % -> %(%) ON DELETE NO ACTION",
      "F1B: % unexpected foreign key(s) touch register_sessions",
      "F1B: register_sessions_one_open_per_device must be UNIQUE on (paired_device_id) and partial",
      "F1B: the one-open predicate is not exactly \"closed_at is null\"",
      "F1B: orders attribution columns are not nullable, defaultless uuids: %",
      "F1B: orders_register_session_requires_device does not mean \"no register without a device\"",
      "F1B: index % is missing or not on % with the approved order",
      "F1B: complete_sale_v5 accepts an identity it must derive",
      "F1B: the complete_sale_v5 sale hash must not include attribution",
      "F1B: complete_sale_v5 must look up a replay before requiring any current state",
      "F1B: complete_sale_v5 must lock the device before the project",
      "F1B: a register RPC answered an anonymous caller",
      "F1B: a register RPC did not refuse a caller that is not a paired device",
      "F1B: complete_sale_v5 accepted a sale from a caller that is not a paired device",
      "F1B: register_sessions must be empty after this migration",
      "F1B: public policies changed",
      "F1B: privilege % on % for % changed",
      "F1B: a table other than register_sessions appeared, vanished or changed RLS",
      "F1B: triggers changed",
      "F1B: an existing index changed or was dropped",
      "F1B: new indexes are %",
      "F1B: an existing constraint changed or was dropped",
      "F1B: new constraints are %",
      "F1B: an existing column changed or was dropped",
      "F1B: new columns outside register_sessions are %",
      "F1B: existing sale, inventory, project, device, employee or session rows changed",
    ]) {
      expect(executable).toContain(message);
    }
  });

  it("casts every catalog \"char\" column before concatenating it", () => {
    const doBlock = executable.slice(executable.indexOf("do $do$"));

    expect(doBlock).not.toMatch(/\|\|\s*[a-z]\.(tgenabled|relkind|prokind|contype|provolatile|confdeltype)\b(?!::text)/);
    expect(doBlock).not.toMatch(/\b[a-z]\.(tgenabled|relkind|prokind|contype|provolatile)\s*\|\|/);
  });

  it("smoke calls run with no borrowed identity and restore it", () => {
    const doBlock = executable.slice(executable.indexOf("do $do$"));
    const clears = [...doBlock.matchAll(/perform set_config\('request\.jwt\.claims', '', true\);/g)];

    expect(clears.length).toBe(2);
    expect(doBlock.indexOf("perform set_config('request.jwt.claims', '', true);")).toBeLessThan(
      doBlock.indexOf("public.open_register_session(gen_random_uuid()")
    );
    expect(doBlock).toContain("exit when not exists (select 1 from public.paired_devices d where d.auth_user_id = v_probe_sub);");
  });

  it("the probe identity can never be a real device and no probe can write", () => {
    const doBlock = executable.slice(executable.indexOf("do $do$"));

    expect(doBlock).not.toMatch(/\b(insert\s+into|update|delete\s+from)\s+public\./i);
  });
});
