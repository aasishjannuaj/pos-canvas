// v1.3 Task 5B — the boundaries of the employee management owner UI.
//
// lib/employeeAdmin.test.ts proves the model and the parsing. These are the
// claims that are structural rather than behavioural — each one a way this
// screen could quietly become something it was not authorized to be:
//
//   * it may consume the accepted employee contracts and MAY NOT invent one;
//   * a PIN may be typed and sent, and may never be shown, stored or kept;
//   * deactivation may ask the server and may NOT tidy up on its own;
//   * an operational `owner` role may not become web administration access;
//   * employee data may not leak into the project configuration it sits beside.
//
// Source-level because this repository has no React Testing Library (verified —
// no testing-library dependency in package.json), so the components are read.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf-8");
}

/** Comment-stripped source: explanatory prose must never satisfy a guard. */
function code(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const MODEL = "lib/employeeAdmin.ts";
const RPC = "lib/employeeAdmin.rpc.ts";
const PANEL = "components/employees/EmployeeManagementPanel.tsx";
const FORM = "components/employees/AddEmployeeForm.tsx";
const ROW = "components/employees/EmployeeRow.tsx";
const DIALOG = "components/employees/DeactivateEmployeeDialog.tsx";
const SHELL = "components/editor/EditorShell.tsx";
const SIDEBAR = "components/editor/EditorSidebar.tsx";

const TASK_5B_SOURCES = [MODEL, RPC, PANEL, FORM, ROW, DIALOG];

/** The six contracts Task 5B was authorized to consume. No seventh. */
const ACCEPTED_CONTRACTS = [
  "create_employee",
  "list_employees",
  "set_employee_active",
  "set_employee_code",
  "set_employee_pin",
  "set_employee_role",
];

// ---------------------------------------------------------------------------
// The backend boundary
// ---------------------------------------------------------------------------

describe("Task 5B consumes the accepted contracts and adds none", () => {
  it("calls exactly the six accepted RPCs, by name", () => {
    const rpc = code(read(RPC));
    const called = [...rpc.matchAll(/\.rpc\(\s*"([a-z_]+)"/g)].map((match) => match[1]);

    expect([...new Set(called)].sort()).toEqual([...ACCEPTED_CONTRACTS].sort());
    // Each is called exactly once: no second call path to the same contract.
    expect(called).toHaveLength(ACCEPTED_CONTRACTS.length);
  });

  it("issues no RPC from anywhere else in the feature", () => {
    for (const file of [MODEL, PANEL, FORM, ROW, DIALOG]) {
      expect(`${file}: rpc`).toBe(`${file}: rpc`);
      expect(code(read(file))).not.toMatch(/\.rpc\(/);
    }
  });

  it("writes no SQL and defines no function of its own", () => {
    for (const file of TASK_5B_SOURCES) {
      const source = code(read(file));

      expect(`${file}: sql`).toBe(`${file}: sql`);
      expect(source).not.toMatch(/create\s+(or\s+replace\s+)?function/i);
      expect(source).not.toMatch(/\balter table\b|\bcreate table\b|\bgrant execute\b/i);
    }
  });

  it("touches no table directly, and reaches for no service role", () => {
    for (const file of TASK_5B_SOURCES) {
      const source = code(read(file));

      for (const banned of [
        "service_role",
        "SUPABASE_SERVICE_ROLE_KEY",
        "supabase/admin",
        "createAdminClient",
      ]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }

      // Every read and write goes through a SECURITY DEFINER contract that
      // resolves auth.uid() itself; a .from() here would be a second, weaker
      // authorization story running beside it.
      expect(source).not.toMatch(/\.from\(\s*["'](employees|projects|paired_devices)["']\s*\)/);
    }
  });

  it("sends no owner or project identity the server derives for itself", () => {
    const rpc = code(read(RPC));

    // The contracts read auth.uid(); an owner id crossing this boundary would
    // be a claim the client is not entitled to make.
    expect(rpc).not.toMatch(/p_owner|p_user_id|user_id:|auth_user_id/);
  });
});

// ---------------------------------------------------------------------------
// The PIN
// ---------------------------------------------------------------------------

describe("a PIN is typed, sent, and then gone", () => {
  it("reaches no storage, no URL, no log", () => {
    for (const file of TASK_5B_SOURCES) {
      const source = code(read(file));

      for (const banned of [
        "localStorage",
        "sessionStorage",
        "indexedDB",
        "document.cookie",
        "console.",
        "searchParams",
        "URLSearchParams",
      ]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("is never put in a query string", () => {
    for (const file of TASK_5B_SOURCES) {
      expect(`${file}: query`).toBe(`${file}: query`);
      expect(code(read(file))).not.toMatch(/[?&]pin=/i);
    }
  });

  it("is masked in both places it can be typed", () => {
    const form = code(read(FORM));
    const row = code(read(ROW));

    // The add form's PIN box.
    expect(form).toMatch(/id="employee-pin"[\s\S]{0,400}?type="password"/);
    expect(form).toContain('autoComplete="new-password"');
    expect(form).toMatch(/id="employee-pin"[\s\S]{0,400}?maxLength=\{4\}/);

    // The row's "Set PIN" box is a password field whenever it is the PIN one.
    expect(row).toContain('type={openEditor === "code" ? "text" : "password"}');
    expect(row).toContain('autoComplete={openEditor === "code" ? "off" : "new-password"}');
  });

  it("is never prefilled, because no existing PIN can be read", () => {
    const panel = code(read(PANEL));

    // Opening either editor starts from an empty string, unconditionally.
    const open = panel.slice(panel.indexOf("onOpenEditor={(kind) =>"));
    expect(open).toContain('setEditorValue("")');
    // And the row renders "" for every employee that is not the open one.
    expect(code(read(ROW))).not.toMatch(/defaultValue|placeholder=\{.*pin/i);
    expect(panel).toContain('editorValue={isOpen ? editorValue : ""}');
  });

  it("is cleared the moment the server accepts it", () => {
    const panel = code(read(PANEL));

    // The add form: the whole draft is replaced, so no field can be forgotten.
    const create = panel.slice(
      panel.indexOf("const result = await createEmployee("),
      panel.indexOf("async function handleSubmitEditor")
    );
    expect(create).toContain("setDraft(emptyEmployeeDraft())");

    // The row editor: closeEditor empties the box, and it is called on the
    // success path of setEmployeePin.
    expect(panel).toMatch(/function closeEditor\(\)\s*\{[\s\S]*?setEditorValue\(""\)/);

    const pin = panel.slice(panel.indexOf("const result = await setEmployeePin("));
    const success = pin.slice(pin.indexOf("setRowProblem({ employeeId, message: SET_EMPLOYEE_PIN"));
    expect(success).toContain("closeEditor()");
  });

  it("holds no PIN in any long-lived structure", () => {
    const model = code(read(MODEL));

    // The pure model is where a cache would naturally be written. It holds no
    // PIN at all — the draft type is the one place the word may appear — and
    // since the employeeCode correction it holds no cache of any kind either.
    expect(model).not.toMatch(/pinHash|pin_hash|storePin|cachePin|lastPin/i);
    expect(model).not.toMatch(/Record<string, string>|new Map\(/);
  });

  it("says nothing about a PIN after setting one", () => {
    const panel = code(read(PANEL));

    // Not the digits, not a mask, not a length. "PIN updated." and no more.
    expect(panel).toContain('message: "PIN updated."');
    expect(panel).not.toMatch(/ends with|last two|••|\*\*\*\*|digits long/i);
  });

  it("never reports a PIN back out of a contract result", () => {
    const rpc = code(read(RPC));
    const pinResult = rpc.slice(
      rpc.indexOf("export type SetEmployeePinResult"),
      rpc.indexOf("export async function setEmployeePin")
    );

    // The success type is an employee id and nothing else.
    expect(pinResult).toContain("{ ok: true; employeeId: string }");
    expect(pinResult).not.toMatch(/pin:|pinLength|hash/i);
  });
});

// ---------------------------------------------------------------------------
// Deactivation does what the contract does, and nothing more
// ---------------------------------------------------------------------------

describe("the employee lifecycle is the backend's, not this screen's", () => {
  it("performs no session, time-clock or register side effect", () => {
    for (const file of TASK_5B_SOURCES) {
      const source = code(read(file));

      for (const banned of [
        "end_employee_pos_session",
        "endEmployeePosSession",
        "clock_out_employee",
        "clockOut",
        "employee_time_sessions",
        "employee_pos_sessions",
        "register_sessions",
        "close_register",
        "ringOut",
      ]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("changes status only through set_employee_active", () => {
    const panel = code(read(PANEL));

    expect(panel).toContain("setEmployeeActive(employee.employeeId, true)");
    expect(panel).toContain("setEmployeeActive(employeeToDeactivate.employeeId, false)");
    // No direct flag write anywhere.
    expect(panel).not.toMatch(/active:\s*(true|false)\s*\}\s*\)/);
  });

  it("asks before deactivating, and states the consequences first", () => {
    const panel = code(read(PANEL));
    const dialog = code(read(DIALOG));

    // Deactivation opens the dialog; only its confirm button calls the server.
    expect(panel).toMatch(/if \(employee\.active\) \{[\s\S]{0,200}setEmployeeToDeactivate\(employee\)/);
    expect(dialog).toContain("DEACTIVATION_CONSEQUENCES");
    expect(dialog).toContain('role="alertdialog"');
  });

  it("renumbers nobody when a reactivation is refused", () => {
    const panel = code(read(PANEL));
    const reactivate = panel.slice(
      panel.indexOf("async function handleReactivate"),
      panel.indexOf("async function handleConfirmDeactivate")
    );

    // The refusal is shown and the owner chooses. No retry with a new code, no
    // automatic set_employee_code, no second attempt of any kind.
    expect(reactivate).toContain("SET_EMPLOYEE_ACTIVE_MESSAGES[result.code]");
    expect(reactivate).not.toContain("setEmployeeCode");
    expect(reactivate).not.toMatch(/retry|nextCode|\+ 1/);
  });
});

// ---------------------------------------------------------------------------
// Rename, and the Employee ID that cannot be read
// ---------------------------------------------------------------------------

describe("capabilities the accepted contracts do not provide are stated, not faked", () => {
  it("offers no rename, and writes display_name nowhere but creation", () => {
    for (const file of TASK_5B_SOURCES) {
      const source = code(read(file));

      expect(`${file}: rename`).toBe(`${file}: rename`);
      expect(source).not.toContain("set_employee_display_name");
      expect(source).not.toMatch(/renameEmployee|onRename/);
    }

    // p_display_name appears once, in create_employee's arguments.
    const rpc = code(read(RPC));
    expect(rpc.match(/p_display_name/g)).toHaveLength(1);
  });

  it("tells the owner the rename limit on the screen itself", () => {
    const panel = code(read(PANEL));

    expect(panel).toContain("EMPLOYEE_ADMIN_LIMITS.rename");
    // And no longer carries the read limitation that the accepted backend
    // correction resolved.
    expect(panel).not.toContain("employeeCodeHidden");
    expect(panel).not.toContain("Not shown");
  });

  it("reads each Employee ID off its own list row, with no cache in between", () => {
    const panel = code(read(PANEL));

    // The label is the row's value. Not a map, not a remembered code, not a
    // value carried over from a create or a set-code.
    expect(panel).toContain("describeEmployeeCode(employee.employeeCode)");

    // The pre-correction cache is GONE, not merely unread: a second source of
    // truth that nothing reads today is one somebody wires up tomorrow.
    for (const banned of ["knownCodes", "rememberEmployeeCode", "KnownEmployeeCodes"]) {
      expect(`panel: ${banned}`).toBe(`panel: ${banned}`);
      expect(panel).not.toContain(banned);
    }

    // The contract type carries it, which is what makes a fresh load sufficient.
    const rpc = code(read(RPC));
    const summary = rpc.slice(
      rpc.indexOf("export type EmployeeSummary"),
      rpc.indexOf("export type ListEmployeesErrorCode")
    );
    expect(summary).toContain("employeeCode: string | null;");

    // And the row still renders the label it is handed.
    const row = code(read(ROW));
    expect(row).toContain("employeeCodeLabel");
    expect(row).not.toContain("employee.employeeCode");
  });

  it("never converts an Employee ID to a number", () => {
    // `001` → `1` would address the wrong person. The leading zeros are
    // identity data, so the value stays text from the RPC body to the label.
    for (const file of TASK_5B_SOURCES) {
      const source = code(read(file));

      for (const banned of [
        "parseInt",
        "parseFloat",
        "Number(",
        "toFixed",
        "toLocaleString",
        "padStart",
        "padEnd",
      ]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }

      // Unary plus / arithmetic coercion on the code itself.
      expect(source).not.toMatch(/\+\s*employeeCode|employeeCode\s*[-*/]|\bcode\s*\*\s*1\b/);
    }

    // The parser takes the string as-is; it does not repair or normalise it.
    const rpc = code(read(RPC));
    expect(rpc).toContain(
      'employeeCode: typeof value.employeeCode === "string" ? value.employeeCode : null'
    );
  });

  it("leaves a null Employee ID alone rather than filling it in", () => {
    const model = code(read(MODEL));
    const panel = code(read(PANEL));

    // A truthful unassigned label, and never one of the two wrong answers.
    expect(model).toContain('EMPLOYEE_CODE_UNASSIGNED_LABEL = "Not assigned"');
    expect(model).not.toMatch(/"000"|'000'/);
    expect(model).not.toMatch(/\?\?\s*["']0*1["']|\|\|\s*["']0*1["']/);

    // No automatic mutation: nothing calls set_employee_code, or any other
    // write, in response to reading a null code.
    expect(model).not.toContain("setEmployeeCode");
    expect(panel).not.toMatch(/employeeCode === null[\s\S]{0,200}setEmployeeCode/);
    expect(panel).not.toMatch(/backfill|assignMissing|ensureCode/i);

    // set_employee_code is reachable only from the owner's own editor submit.
    const calls = [...panel.matchAll(/setEmployeeCode\(/g)];
    expect(calls).toHaveLength(1);
    const submit = panel.slice(
      panel.indexOf("async function handleSubmitEditor"),
      panel.indexOf("async function handleRoleChange")
    );
    expect(submit).toContain("setEmployeeCode(employeeId, editorValue)");
  });
});

// ---------------------------------------------------------------------------
// Who this screen is for
// ---------------------------------------------------------------------------

describe("an operational role is not web administration access", () => {
  it("gates nothing in this UI on an employee's role", () => {
    for (const file of [PANEL, FORM, ROW, DIALOG]) {
      const source = code(read(file));

      expect(`${file}: authority`).toBe(`${file}: authority`);
      // Role is displayed and changed; it never decides what may be rendered
      // or which control is available.
      expect(source).not.toMatch(/role === ["']owner["']|role !== ["']owner["']/);
      expect(source).not.toMatch(/isOwner|canManage|hasPermission/);
    }
  });

  it("reads no employee session to decide access", () => {
    for (const file of TASK_5B_SOURCES) {
      const source = code(read(file));

      expect(`${file}: session`).toBe(`${file}: session`);
      expect(source).not.toMatch(/getCurrentEmployeeSession|employeeLogin|posGate/i);
    }
  });

  it("says so on the screen, where an owner will read it", () => {
    expect(read(PANEL)).toMatch(/grant no access to this builder/);
  });
});

// ---------------------------------------------------------------------------
// Where it lives
// ---------------------------------------------------------------------------

describe("the section is part of the existing Builder, not a new architecture", () => {
  it("is a sidebar section beside Devices", () => {
    const sidebar = code(read(SIDEBAR));

    expect(sidebar).toContain('{ label: "Employees"');
    expect(code(read(SHELL))).toContain('| "Employees"');
  });

  it("adds no route of its own", () => {
    for (const file of TASK_5B_SOURCES) {
      const source = code(read(file));

      expect(`${file}: route`).toBe(`${file}: route`);
      expect(source).not.toMatch(/router\.push|useRouter|redirect\(/);
    }
  });

  it("receives the project id and nothing else from EditorShell", () => {
    const shell = code(read(SHELL));
    // Sliced to the element's own closing "/>", not a fixed character count: a
    // fixed window ran into the NEXT branch and failed on ReceiptPreview's
    // props, which is a guard punishing unrelated code.
    const start = shell.indexOf("<EmployeeManagementPanel");
    const mount = shell.slice(start, shell.indexOf("/>", start) + 2);

    expect(mount).toContain("projectId={projectId}");
    // No config, no menu, no branding, no orders: employee data and project
    // configuration stay separate systems that merely share a screen.
    expect(mount).not.toMatch(/projectConfig|menuItems|branding|orderTotals|receipt/);
  });

  it("puts no employee data into the saved project or a published build", () => {
    const shell = code(read(SHELL));

    // EditorShell holds no employee state at all — the panel owns its own.
    expect(shell).not.toMatch(/const \[employees/);
    expect(shell).not.toMatch(/employeeDraft|employeeRoster|knownCodes/);

    for (const file of ["lib/projects.ts", "lib/projects.server.ts"]) {
      expect(`${file}: employees`).toBe(`${file}: employees`);
      expect(code(read(file))).not.toMatch(/employee/i);
    }
  });

  it("works for every template, not just one", () => {
    for (const file of TASK_5B_SOURCES) {
      const source = code(read(file));

      expect(`${file}: template`).toBe(`${file}: template`);
      expect(source).not.toMatch(/liquor|templateId|template_id/i);
    }
  });
});
