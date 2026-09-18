// v1.3 Feature 1A — static security guards for the employee identity surface.
//
// These are SOURCE-LEVEL assertions, not behavioural tests. They exist because
// the properties they protect are structural: once employee code imports the
// cookie-backed owner client, or writes a PIN to storage, no runtime test will
// notice until a PIN is sitting in a tablet's localStorage or an owner is
// silently signed out of their own browser.
//
// Modelled directly on lib/device.guards.test.ts, which protects the same
// boundary for the pairing surface.
//
// SEVERAL TESTS HERE ARE NEGATIVE CONTROLS. They introduce the exact defect a
// guard is meant to catch into a copy of the source and assert the guard then
// fails. A guard nobody has ever seen fail is a guard nobody knows works.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf-8");
}

/** Strips comments so explanatory prose naming a banned thing never trips a guard. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const EMPLOYEE_FILES = ["lib/employeeSession.ts", "lib/employee.rpc.ts"] as const;

const PURE_FILE = "lib/employeeSession.ts";
const RPC_FILE = "lib/employee.rpc.ts";

// ---------------------------------------------------------------------------
// Client discipline
// ---------------------------------------------------------------------------

describe("employee code never reaches an owner or privileged Supabase client", () => {
  // The same list lib/device.guards.test.ts enforces, for the same reasons.
  const BANNED = [
    "@/lib/supabase/client",
    "@/lib/supabase/server",
    "@/lib/supabase/admin",
    "@/lib/supabase/adminConfig",
    "@/lib/orders",
    "@/lib/projects",
  ];

  for (const file of EMPLOYEE_FILES) {
    for (const banned of BANNED) {
      it(`${file} does not import ${banned}`, () => {
        expect(code(read(file))).not.toContain(banned);
      });
    }
  }

  it("the RPC boundary uses the dedicated device client", () => {
    expect(code(read(RPC_FILE))).toContain('from "@/lib/supabase/deviceClient"');
  });

  it("NEGATIVE CONTROL: the ban detects an added owner-client import", () => {
    const mutated = code(read(RPC_FILE)).replace(
      'from "@/lib/supabase/deviceClient"',
      'from "@/lib/supabase/client"'
    );

    expect(mutated).toContain("@/lib/supabase/client");
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe("the model stays pure", () => {
  it("imports nothing at all", () => {
    // lib/employeeSession.ts is dependency-free by design, which is what lets it
    // be reasoned about and tested without a database, a network or a browser.
    expect(code(read(PURE_FILE))).not.toMatch(/^\s*import\s/m);
  });

  it("touches no effectful global", () => {
    const source = code(read(PURE_FILE));

    for (const effect of [
      "fetch(",
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "document",
      "window",
      "process.env",
      "setTimeout",
      "Date.now",
      "crypto",
    ]) {
      expect(source).not.toContain(effect);
    }
  });
});

// ---------------------------------------------------------------------------
// The PIN
// ---------------------------------------------------------------------------

describe("a PIN is never persisted, logged or returned", () => {
  for (const file of EMPLOYEE_FILES) {
    it(`${file} writes to no storage of any kind`, () => {
      const source = code(read(file));

      for (const sink of [
        "localStorage",
        "sessionStorage",
        "indexedDB",
        "IDBDatabase",
        "@/lib/deviceOfflineCache",
        "@/lib/deviceOfflineStore",
        "@/lib/offlineCheckoutSession",
        "@/lib/saleQueue",
      ]) {
        expect(source).not.toContain(sink);
      }
    });

    it(`${file} logs nothing`, () => {
      const source = code(read(file));

      for (const sink of ["console.log", "console.warn", "console.error", "console.debug"]) {
        expect(source).not.toContain(sink);
      }
    });
  }

  it("the RPC boundary never puts the PIN in an error or a result", () => {
    const source = code(read(RPC_FILE));

    // `pin` appears only as the parameter, the shape check and the single RPC
    // argument. It must never be interpolated into a message or spread into a
    // returned object.
    expect(source).not.toMatch(/message:[^\n]*\bpin\b/);
    expect(source).not.toMatch(/\$\{\s*pin\s*\}/);
    expect(source).not.toMatch(/JSON\.stringify\([^)]*pin/);
    expect(source).not.toContain("...args");
  });

  it("no employee module names a hash, salt or counter", () => {
    for (const file of EMPLOYEE_FILES) {
      const source = code(read(file));

      for (const leak of ["pin_hash", "pinHash", "gen_salt", "bcrypt", "failed_count", "failedCount", "locked_until"]) {
        expect(source).not.toContain(leak);
      }
    }
  });

  it("NEGATIVE CONTROL: the storage ban detects a PIN written to localStorage", () => {
    const mutated = code(read(RPC_FILE)).replace(
      "  try {",
      "  localStorage.setItem('lastPin', pin);\n  try {"
    );

    expect(mutated).toContain("localStorage");
  });

  it("NEGATIVE CONTROL: the logging ban detects a PIN written to the console", () => {
    const mutated = code(read(RPC_FILE)).replace("  try {", "  console.log(pin);\n  try {");

    expect(mutated).toContain("console.log");
  });
});

// ---------------------------------------------------------------------------
// The RPC surface a device may touch
// ---------------------------------------------------------------------------

describe("the device RPC surface is exactly four calls", () => {
  const source = code(read(RPC_FILE));
  const called = [...source.matchAll(/\.rpc\(\s*"([^"]+)"/g)].map((m) => m[1]);

  it("calls only the employee session RPCs", () => {
    // UPDATED BY v1.3 checkpoint 2: employee_login_by_code is the primary
    // cashier login. employee_login and list_login_employees are kept as the
    // secondary/admin path and are still allowed here.
    expect(new Set(called)).toEqual(
      new Set([
        "list_login_employees",
        "employee_login",
        "employee_login_by_code",
        "get_current_employee_session",
        "employee_logout",
      ])
    );
  });

  it("never calls an owner-management RPC from device code", () => {
    // These exist in the database as the authoritative write path, but they are
    // owner operations. A device that could call them could mint itself an
    // employee, or read the roster of a shop it is not in.
    for (const ownerRpc of [
      "create_employee",
      "list_employees",
      "set_employee_active",
      "set_employee_pin",
    ]) {
      expect(source).not.toContain(`"${ownerRpc}"`);
    }
  });

  it("never calls a sale, checkout, inventory or pairing RPC", () => {
    for (const forbidden of [
      "complete_sale",
      "restock_inventory",
      "adjust_inventory",
      "redeem_device_pairing_token",
      "revoke_paired_device",
      "unpair_own_device",
      "apply_device_config_update",
      "get_device_config",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("login sends the selected employee and the PIN, and nothing else", () => {
    const args = [...source.matchAll(/\.rpc\([^)]*\)/gs)].join("\n");

    expect(args).toContain("p_employee_id: employeeId");
    expect(args).toContain("p_pin: pin");

    for (const claimed of [
      "p_project_id",
      "p_device_id",
      "p_paired_device_id",
      "p_role",
      "p_owner_id",
    ]) {
      expect(args).not.toContain(claimed);
    }
  });

  it("the selector is requested with no arguments", () => {
    expect(source).toMatch(/\.rpc\(\s*"list_login_employees"\s*\)/);
  });

  it("NEGATIVE CONTROL: the identity ban detects a device-supplied project id", () => {
    const mutated = source.replace("p_pin: pin,", "p_pin: pin,\n      p_project_id: projectId,");

    expect(mutated).toContain("p_project_id");
  });
});

// ---------------------------------------------------------------------------
// The client decides nothing about an authentication attempt
// ---------------------------------------------------------------------------

describe("a submitted login attempt is never refused locally", () => {
  // lib/employee.rpc.test.ts proves this behaviourally. These are the
  // structural half: they fail on the SHAPE of a short-circuit even if someone
  // writes one that the behavioural tests' input list happens not to cover.
  const body = code(read(RPC_FILE)).slice(
    code(read(RPC_FILE)).indexOf("export async function employeeLogin"),
    code(read(RPC_FILE)).indexOf("export async function fetchCurrentEmployeeSession")
  );

  it("employeeLogin goes straight to the RPC with no guard clause in front", () => {
    const opening = body.slice(0, body.indexOf(".rpc("));

    // Between the signature and the call there is a `try {` and nothing else.
    // Any `if (...) return` before the RPC is a local verdict on an attempt the
    // server must both answer and COUNT: employee_login resolves the active
    // device first, so a malformed PIN advances the lockout ladder, and a
    // client that filtered those out would restore unlimited free probing.
    expect(opening).not.toMatch(/\breturn\b/);
    expect(opening.replace(/\s/g, "")).toContain("{try{");
  });

  it("employeeLogin does not consult the shape helper at all", () => {
    // The helper stays exported for keypad affordance. It must not gate a
    // submitted attempt, so this module no longer imports it.
    expect(code(read(RPC_FILE))).not.toContain("isValidEmployeePinShape");
  });

  it("nothing repairs the value before transmission", () => {
    for (const mutation of [
      "pin.trim()",
      "pin.padStart",
      "pin.padEnd",
      "pin.replace",
      "pin.slice",
      "pin.normalize",
      "String(pin).trim",
    ]) {
      expect(body).not.toContain(mutation);
    }

    expect(body).toContain("p_pin: pin,");
  });

  it("NEGATIVE CONTROL: the guard-clause ban detects a reinstated short-circuit", () => {
    const mutated = body.replace(
      "  try {",
      "  if (!isValidEmployeePinShape(pin)) {\n    return fail();\n  }\n\n  try {"
    );
    const opening = mutated.slice(0, mutated.indexOf(".rpc("));

    expect(opening).toMatch(/\breturn\b/);
  });

  it("NEGATIVE CONTROL: the repair ban detects a trim", () => {
    const mutated = body.replace("p_pin: pin,", "p_pin: pin.trim(),");

    expect(mutated).toContain("pin.trim()");
  });

  it("the pure helper survives for presentation use", () => {
    // Requirement: it may remain, but no guard may require a short-circuit.
    expect(code(read(PURE_FILE))).toContain("export function isValidEmployeePinShape");
  });
});

// ---------------------------------------------------------------------------
// Error discipline
// ---------------------------------------------------------------------------

describe("the backend's collapsed failures are not reopened", () => {
  it("every operator-facing message comes from the shared table", () => {
    const source = code(read(RPC_FILE));

    // No string literal sentence built here: the RPC layer maps codes, and
    // lib/employeeSession.ts owns the words.
    expect(source).toContain("getEmployeeLoginErrorMessage");
    expect(source).not.toMatch(/message:\s*"[A-Z]/);
  });

  it("a failure that reached no verification is never reported as a bad PIN", () => {
    const source = code(read(RPC_FILE));

    // Both catch paths and both error paths route through unreachedFailure,
    // which can only produce "offline" or "unavailable".
    expect(source).toContain('function unreachedFailure(error: unknown): "offline" | "unavailable"');
    expect(source).not.toMatch(/catch[\s\S]{0,200}invalid_credentials/);
  });

  it("distinguishes offline from unavailable, as Feature 25.4 requires", () => {
    const source = code(read(RPC_FILE));

    expect(source).toContain("isAuthRetryableFetchError");
    expect(source).toContain("classifyDeviceFailure");
    expect(source).toContain('kind === "transport" ? "offline" : "unavailable"');
  });

  it("the message table reveals nothing about why a credential failed", () => {
    const source = read(PURE_FILE);
    const table = source.slice(
      source.indexOf("const EMPLOYEE_LOGIN_ERROR_MESSAGES"),
      source.indexOf("export function getEmployeeLoginErrorMessage")
    );

    for (const leak of [
      "inactive",
      "deactivated",
      "no such",
      "not found",
      "does not exist",
      "wrong project",
      "another shop",
    ]) {
      expect(table.toLowerCase()).not.toContain(leak);
    }
  });
});

// ---------------------------------------------------------------------------
// Feature 1A.1 — the PIN-only login contract is retired everywhere
// ---------------------------------------------------------------------------

describe("nothing calls the retired employee_login(text)", () => {
  /** Every non-test TypeScript source file under the given directories. */
  function sources(dirs: string[]): string[] {
    const out: string[] = [];

    const walk = (relative: string) => {
      const absolute = join(repoRoot, relative);

      for (const entry of readdirSync(absolute)) {
        const child = join(relative, entry);
        const stats = statSync(join(repoRoot, child));

        if (stats.isDirectory()) {
          if (entry !== "node_modules" && !entry.startsWith(".")) {
            walk(child);
          }
        } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
          out.push(child);
        }
      }
    };

    for (const dir of dirs) {
      walk(dir);
    }

    return out;
  }

  const files = sources(["lib", "app", "components"]);

  /** The argument object of every employee_login call in a source string. */
  function loginCalls(source: string): string[] {
    return [...source.matchAll(/\.rpc\(\s*"employee_login"\s*,\s*\{([^}]*)\}/g)].map((m) => m[1]);
  }

  it("finds the source files it is guarding", () => {
    expect(files).toContain(RPC_FILE);
  });

  it("every employee_login call in the codebase names the selected employee", () => {
    const offenders: string[] = [];

    for (const file of files) {
      for (const argsText of loginCalls(code(read(file)))) {
        if (!argsText.includes("p_employee_id")) {
          offenders.push(file);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("employee_login is called from exactly one place", () => {
    const callers = files.filter((file) => loginCalls(code(read(file))).length > 0);

    expect(callers).toEqual([RPC_FILE]);
  });

  it("employeeLogin requires the employee id before the PIN", () => {
    expect(code(read(RPC_FILE))).toMatch(
      /export async function employeeLogin\(\s*employeeId: string,\s*pin: string\s*\)/
    );
  });

  it("NEGATIVE CONTROL: a PIN-only call is detected", () => {
    const mutated = code(read(RPC_FILE)).replace(
      "p_employee_id: employeeId,\n      p_pin: pin,",
      "p_pin: pin,"
    );

    expect(mutated).not.toBe(code(read(RPC_FILE)));
    expect(loginCalls(mutated).some((argsText) => !argsText.includes("p_employee_id"))).toBe(true);
  });

  it("NEGATIVE CONTROL: a single-argument employeeLogin is detected", () => {
    const mutated = code(read(RPC_FILE)).replace(
      /export async function employeeLogin\(\s*employeeId: string,\s*pin: string\s*\)/,
      "export async function employeeLogin(pin: string)"
    );

    expect(mutated).not.toMatch(
      /export async function employeeLogin\(\s*employeeId: string,\s*pin: string\s*\)/
    );
  });
});

// ---------------------------------------------------------------------------
// Feature 1A.1 — the selector model never widens
// ---------------------------------------------------------------------------

describe("the selector model carries an id and a name, nothing else", () => {
  const source = code(read(PURE_FILE));
  const typeBody = source.slice(
    source.indexOf("export type LoginEmployee = {"),
    source.indexOf("};", source.indexOf("export type LoginEmployee = {"))
  );

  it("LoginEmployee has exactly employeeId and displayName", () => {
    const fields = [...typeBody.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);

    expect(fields.sort()).toEqual(["displayName", "employeeId"]);
  });

  it("the parser copies only those two fields", () => {
    const parser = source.slice(source.indexOf("export function parseLoginEmployeesResult"));

    expect(parser).toContain("employees.push({ employeeId, displayName });");
    expect(parser).not.toMatch(/\.\.\.\s*item/);
    expect(parser).not.toContain("role");
  });

  it("NEGATIVE CONTROL: an added role field is detected", () => {
    const mutated = typeBody.replace("displayName: string;", "displayName: string;\n  role: string;");
    const fields = [...mutated.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);

    expect(fields.sort()).not.toEqual(["displayName", "employeeId"]);
  });
});
