// v1.3 Feature 1B-RUNTIME checkpoint 2 — where the employee lock lives.
//
// Source guards, in the house style: they read the shipped files and assert
// WHERE behaviour lives and WHICH subtree can be touched, which no unit test on
// pure state can see.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..");
const read = (relative: string) => readFileSync(join(repoRoot, relative), "utf-8");

/** Source with comments stripped, so prose can neither satisfy nor trip a guard. */
function code(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
    .join("\n");
}

const DEVICE_APP = "components/device/DeviceApp.tsx";
const GATES = "components/device/PosGates.tsx";
const POS_RUNTIME = "components/runtime/PosRuntime.tsx";

const app = code(read(DEVICE_APP));
const gates = code(read(GATES));
const runtime = code(read(POS_RUNTIME));

describe("the primary login is an Employee ID and a PIN", () => {
  it("the lock card asks for both", () => {
    expect(gates).toContain("export function EmployeeLockCard");
    expect(gates).toContain('htmlFor="employee-code"');
    expect(gates).toContain('id="employee-code"');
    expect(gates).toContain('htmlFor="employee-pin"');
    expect(gates).toContain('id="employee-pin"');
  });

  it("the PIN is obscured and the Employee ID is not", () => {
    const card = gates.slice(gates.indexOf("export function EmployeeLockCard"), gates.indexOf("export function EmployeeSelector"));
    const pinInput = card.slice(card.indexOf('id="employee-pin"'));
    const codeInput = card.slice(card.indexOf('id="employee-code"'), card.indexOf('id="employee-pin"'));

    expect(pinInput.slice(0, 300)).toContain('type="password"');
    expect(codeInput).toContain('type="text"');
  });

  it("both fields raise a numeric keypad without becoming number inputs", () => {
    const card = gates.slice(gates.indexOf("export function EmployeeLockCard"), gates.indexOf("export function EmployeeSelector"));

    // type="number" would bring spinners, allow `-` and `e`, and strip a
    // leading zero — which is the entire Employee ID contract.
    expect(card.match(/inputMode="numeric"/g)).toHaveLength(2);
    expect(card.match(/pattern="\[0-9\]\*"/g)).toHaveLength(2);
    expect(card).not.toContain('type="number"');
  });

  it("their lengths are capped at 3 and 4", () => {
    const card = gates.slice(gates.indexOf("export function EmployeeLockCard"), gates.indexOf("export function EmployeeSelector"));

    expect(card).toContain("maxLength={3}");
    expect(card).toContain("maxLength={4}");
  });

  it("the shape check only greys out the button", () => {
    // Every SUBMITTED attempt must reach the server: the per-device throttle is
    // what makes a four-digit PIN survivable, and it can only count what it
    // sees. The local rules exist to save a round trip on a half-typed entry.
    const card = gates.slice(gates.indexOf("export function EmployeeLockCard"), gates.indexOf("export function EmployeeSelector"));

    expect(card).toContain("isValidEmployeeCodeShape(employeeCode) && isValidEmployeePinShape(pin)");
    expect(card).toContain("disabled={busy || !ready}");
  });

  it("it submits on Enter, because it is a form", () => {
    const card = gates.slice(gates.indexOf("export function EmployeeLockCard"), gates.indexOf("export function EmployeeSelector"));

    expect(card).toContain("<form");
    expect(card).toContain('type="submit"');
    expect(card).toContain("event.preventDefault()");
  });

  it("it never names an employee it has not been told about", () => {
    const card = gates.slice(gates.indexOf("export function EmployeeLockCard"), gates.indexOf("export function EmployeeSelector"));

    expect(card).not.toContain("displayName");
    expect(card).not.toContain("roster");
  });
});

describe("the host calls employee_login_by_code, and sends nothing else", () => {
  it("through the wrapper, never the RPC name", () => {
    expect(app).toContain("employeeLoginByCode");
    expect(app).not.toContain('"employee_login_by_code"');
  });

  it("the wrapper sends only the two typed values", () => {
    const rpc = code(read("lib/employee.rpc.ts"));
    const fn = rpc.slice(rpc.indexOf("export async function employeeLoginByCode"));
    const body = fn.slice(0, fn.indexOf("\n}"));

    expect(body).toContain("p_employee_code: employeeCode");
    expect(body).toContain("p_pin: pin");
    expect(body).not.toContain("p_project_id");
    expect(body).not.toContain("p_employee_id");
    expect(body).not.toContain("p_device_id");
  });

  it("the failure message is whatever the server said", () => {
    const handler = app.slice(
      app.indexOf("const handleEmployeeCodeLogin"),
      app.indexOf("const recoverDailyContext")
    );

    expect(handler).toContain("getEmployeeLoginErrorMessage(result.error");
    // Nothing here may turn one answer into two.
    expect(handler).not.toContain("not_found");
    expect(handler).not.toContain("unknown");
  });

  it("throttling is presented, not circumvented", () => {
    const handler = app.slice(
      app.indexOf("const handleEmployeeCodeLogin"),
      app.indexOf("const recoverDailyContext")
    );

    expect(handler).toContain("result.retryAfterSeconds");
    expect(code(read("lib/employeeSession.ts"))).toContain("locked_out");
  });
});

describe("the roster is no longer the primary flow, and is not deleted", () => {
  it("DeviceApp renders the lock card at the employee gate", () => {
    const gateOverlay = app.slice(app.indexOf("const gateOverlay ="), app.indexOf("const activeOverlay"));

    expect(gateOverlay).toContain("<EmployeeLockCard");
    expect(gateOverlay).not.toContain("<EmployeeSelector");
    expect(gateOverlay).not.toContain("<EmployeePinEntry");
  });

  it("normal login does not depend on a roster fetch", () => {
    const handler = app.slice(
      app.indexOf("const handleEmployeeCodeLogin"),
      app.indexOf("const recoverDailyContext")
    );

    expect(handler).not.toContain("loadRoster");
    expect(handler).not.toContain("fetchLoginEmployees");
  });

  it("the roster RPC, its wrapper and its components all survive", () => {
    expect(code(read("lib/employee.rpc.ts"))).toContain("export async function fetchLoginEmployees");
    expect(code(read("lib/employee.rpc.ts"))).toContain('rpc("list_login_employees")');
    expect(gates).toContain("export function EmployeeSelector");
    expect(gates).toContain("export function EmployeePinEntry");
    expect(code(read("lib/employeeRoster.ts"))).toContain("export function shouldLoadRoster");
  });

  it("and employee_login(uuid) remains as the secondary path", () => {
    expect(code(read("lib/employee.rpc.ts"))).toContain("export async function employeeLogin(");
    expect(code(read("lib/employee.rpc.ts"))).toContain('rpc("employee_login"');
  });
});

describe("a server observation cannot unlock the POS", () => {
  it("there is no derivation mode that establishes an employee", () => {
    expect(app).toContain('type GateDerivationMode = "reconnect" | "observe"');
    expect(app).not.toContain('"establish"');
  });

  it("the only caller of applyEmployeeAuthenticated is the login handler", () => {
    expect(app.match(/applyEmployeeAuthenticated\(/g)).toHaveLength(1);

    const handler = app.slice(
      app.indexOf("const handleEmployeeCodeLogin"),
      app.indexOf("const recoverDailyContext")
    );

    expect(handler).toContain("applyEmployeeAuthenticated({");
  });

  it("and it is reached only after the server accepted the credentials", () => {
    const handler = app.slice(
      app.indexOf("const handleEmployeeCodeLogin"),
      app.indexOf("const recoverDailyContext")
    );

    expect(handler.indexOf("if (!result.ok)")).toBeLessThan(handler.indexOf("applyEmployeeAuthenticated"));
  });

  it("DeviceApp has no observation-based derivation at all", () => {
    // Anything that populates `employee` from what the server merely reports is
    // exactly what checkpoint 2 forbids on startup.
    expect(app).not.toContain("applyServerDerivation");
    expect(app).not.toContain("applyRecoveryObservation");
  });
});

describe("signing in never rotates the register", () => {
  it("the login handler asks the SERVER for the day and hands it over untouched", () => {
    const handler = app.slice(
      app.indexOf("const handleEmployeeCodeLogin"),
      app.indexOf("const recoverDailyContext")
    );

    // v1.3 CP2d — there is no register to read any more. The day comes from
    // ensure_daily_register_context and is handed to the pure transition
    // exactly as the server returned it.
    expect(handler).toContain("await acquireDaily()");
    expect(handler).toContain("daily,");
    expect(handler).not.toContain("fetchCurrentRegisterSession");
  });

  it("it opens and closes nothing", () => {
    const handler = app.slice(
      app.indexOf("const handleEmployeeCodeLogin"),
      app.indexOf("const recoverDailyContext")
    );

    for (const banned of ["openRegisterSession", "closeRegisterSession", "applyExplicitRegisterEstablished"]) {
      expect(`${banned} in login handler`).toBe(`${banned} in login handler`);
      expect(handler).not.toContain(banned);
    }
  });
});

describe("the POS underneath stays mounted and inert", () => {
  const readyArm = app.slice(app.indexOf('case "ready": {'));
  const tree = readyArm.slice(readyArm.indexOf("\n      return ("));

  it("the lock is an overlay, not a replacement tree", () => {
    expect(readyArm.match(/\n {6}return \(/g)).toHaveLength(1);
    expect(tree).toContain("<PosRuntime");
    expect(app).toContain("const activeOverlay = gateOverlay ?? overlay;");
  });

  it("the POS subtree is inert whenever the lock is up", () => {
    expect(app).toContain('<div className="min-h-0 flex-1" inert={activeOverlay !== null}>');
    expect(tree.match(/inert=/g)).toHaveLength(1);
  });

  it("the lock card renders OUTSIDE the inert subtree", () => {
    const WRAPPER = '<div className="min-h-0 flex-1" inert={activeOverlay !== null}>';
    const wrapperAt = tree.indexOf(WRAPPER);
    const overlayAt = tree.indexOf("{activeOverlay !== null && (");

    // Balanced `{...}` blanked first. JSX attributes hold arrow functions, and
    // their `>` closes a tag as far as any naive scan is concerned — which is
    // exactly how a correct structure gets mis-reported as a nesting bug.
    const masked = tree.split("");
    let braces = 0;

    for (let i = 0; i < tree.length; i += 1) {
      if (tree[i] === "{") braces += 1;
      if (braces > 0) masked[i] = " ";
      if (tree[i] === "}") braces -= 1;
    }

    const flat = masked.join("");
    const tagRe = /<(\/?)[A-Za-z][\w.]*[^<>]*?(\/?)>/g;

    tagRe.lastIndex = wrapperAt + WRAPPER.length;

    let depth = 1;
    let closedAt = -1;

    for (let m = tagRe.exec(flat); m !== null; m = tagRe.exec(flat)) {
      if (m[2] === "/") continue;

      depth += m[1] === "/" ? -1 : 1;

      if (depth === 0) {
        closedAt = m.index + m[0].length;
        break;
      }
    }

    // The wrapper must CLOSE before the overlay renders. Source order alone
    // cannot tell "after the wrapper opened" from "after it closed".
    expect(closedAt).toBeGreaterThan(-1);
    expect(closedAt).toBeLessThan(overlayAt);
    expect(tree.slice(wrapperAt, closedAt)).not.toContain("EmployeeLockCard");
    expect(tree.slice(wrapperAt, closedAt)).toContain("<PosRuntime");
  });

  it("PosRuntime still knows nothing about employees or logins", () => {
    for (const banned of [
      "EmployeeLockCard",
      "employeeLoginByCode",
      "employee_login_by_code",
      "employeeCode",
      "posGate",
      "inert",
    ]) {
      expect(`${POS_RUNTIME}: ${banned}`).toBe(`${POS_RUNTIME}: ${banned}`);
      expect(runtime).not.toContain(banned);
    }
  });

  it("and still owns the cart, which the host never touches", () => {
    expect(runtime).toContain("const [cart, setCart] = useState<CartItem[]>([])");
    expect(app).not.toContain("setCart(");
  });
});

describe("shared architecture", () => {
  const walk = (dir: string): string[] => {
    const out: string[] = [];

    for (const entry of readdirSync(join(repoRoot, dir))) {
      const child = join(dir, entry);

      if (statSync(join(repoRoot, child)).isDirectory()) out.push(...walk(child));
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(child);
    }

    return out;
  };

  it("no template implements employee login", () => {
    for (const file of walk("components/editor/pos-layouts")) {
      const source = code(read(file));

      for (const banned of ["EmployeeLockCard", "employeeLoginByCode", "employee_login", "employeeCode"]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("neither platform forks it", () => {
    for (const file of [...walk("native-device"), ...walk("windows-shell").filter((f) => f.endsWith(".ts") || f.endsWith(".mjs"))]) {
      const source = code(read(file));

      for (const banned of ["EmployeeLockCard", "employeeLoginByCode", "employee_login"]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("both shells mount the same DeviceApp", () => {
    expect(code(read("native-device/main.tsx"))).toContain(
      'import DeviceApp from "@/components/device/DeviceApp"'
    );
  });
});

describe("offline is untouched", () => {
  it("typed credentials never become offline authority", () => {
    // The lock only ever reaches the server. There is no branch that accepts an
    // Employee ID and a PIN without one.
    const handler = app.slice(
      app.indexOf("const handleEmployeeCodeLogin"),
      app.indexOf("const recoverDailyContext")
    );

    expect(handler).toContain("await employeeLoginByCode(");
    expect(handler).not.toContain("offline");
    expect(handler).not.toContain("localStorage");
    expect(handler).not.toContain("IndexedDB");
  });

  it("the gates are still not rendered as a way in while offline", () => {
    const gateOverlay = app.slice(app.indexOf("const gateOverlay ="), app.indexOf("const activeOverlay"));

    expect(gateOverlay).toContain("offlineMode ||");
  });

  it("Policy 1 and the queue contract are unchanged", () => {
    const posGate = code(read("lib/posGate.ts"));

    expect(posGate).toContain("state.recovery !== null ||");
    expect(posGate).toContain("!state.establishedOnline");
    expect(code(read("lib/saleQueue.ts"))).toContain("SALE_QUEUE_SCHEMA_VERSION = 1");
    expect(code(read("lib/saleQueue.ts"))).toContain("SALE_REQUEST_PAYLOAD_VERSION = 4");
  });
});
