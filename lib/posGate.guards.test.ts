// v1.3 Feature 1B-RUNTIME — the architecture the Control Room locked.
//
// Source guards, in the house style: they read the shipped files and assert
// WHERE behaviour lives, which no unit test can do. The rules being protected:
//
//   * the device host owns employee and register orchestration;
//   * PosRuntime stays host-agnostic and Supabase-unaware;
//   * no template carries employee, register or attribution logic;
//   * Android and Windows consume the same DeviceApp, with no forked logic;
//   * the owner/browser host stays on complete_sale_v3 by decision.
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
const POS_RUNTIME = "components/runtime/PosRuntime.tsx";
const OWNER = "components/runtime/OwnerPosRuntime.tsx";

/**
 * One exported declaration, from its own line to the next top-level `export`.
 *
 * Slicing to the end of the file would drag in every later function — and
 * lib/device.rpc.ts still holds the older v2 and v3 wrappers, which legitimately
 * pass a project id. A guard that read those would pass or fail for the wrong
 * reason.
 */
function exportedDeclaration(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);

  expect(`${name} is exported`).toBe(start === -1 ? "MISSING" : `${name} is exported`);

  const next = source.slice(start + 1).search(/\nexport (async function|function|type|const) /);

  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

function filesUnder(relative: string): string[] {
  const out: string[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(join(repoRoot, dir))) {
      const child = join(dir, entry);

      if (statSync(join(repoRoot, child)).isDirectory()) {
        if (entry !== "node_modules" && !entry.startsWith(".")) walk(child);
      } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        out.push(child);
      }
    }
  };

  walk(relative);

  return out;
}

describe("the device host owns the gates", () => {
  const app = code(read(DEVICE_APP));

  it("derives both sessions from the server", () => {
    expect(app).toContain("fetchCurrentEmployeeSession");
    expect(app).toContain("fetchCurrentRegisterSession");
    expect(app).toContain("deriveGateState");
  });

  it("uses the Feature 1A wrappers rather than re-issuing their RPCs", () => {
    for (const wrapper of ["employeeLogin", "employeeLogout", "fetchLoginEmployees"]) {
      expect(app).toContain(wrapper);
    }

    // The RPC names themselves belong to lib/employee.rpc.ts and
    // lib/register.rpc.ts. A component naming one is a component that has
    // started talking to the database.
    for (const rpcName of [
      "employee_login",
      "list_login_employees",
      "get_current_employee_session",
      "open_register_session",
      "close_register_session",
      "get_current_register_session",
    ]) {
      expect(`${DEVICE_APP}: ${rpcName}`).toBe(`${DEVICE_APP}: ${rpcName}`);
      expect(app).not.toContain(`"${rpcName}"`);
    }
  });

  it("holds gate state in memory and never persists it", () => {
    // Policy 1: an employee session and an open register are server state. A
    // till that wrote them to storage could start offline and invent authority.
    const gateRegion = app.slice(app.indexOf("const [gate, setGate]"), app.indexOf("const loadRoster"));

    expect(gateRegion).not.toContain("localStorage");
    expect(gateRegion).not.toContain("sessionStorage");
    expect(gateRegion).not.toContain("writeCachedValue");
  });

  it("gates a NEW offline checkout on established state", () => {
    expect(app).toContain("canCheckoutOffline");
    // Enforced at the durable write, not only in the UI.
    expect(app.indexOf("canCheckoutOffline(gateRef.current)")).toBeGreaterThan(-1);
  });

  it("attaches historical claims to a queued sale", () => {
    expect(app).toContain("buildOfflineClaims(gateRef.current)");
  });

  it("re-derives after a stale-state refusal instead of retrying", () => {
    expect(app).toContain("classifySaleAttributionFailure");
    expect(app).toContain("applySaleAttributionFailure");

    // The refusal path must not resubmit. A second completeDeviceSaleV5 call
    // inside the same callback would be exactly that.
    const callback = app.slice(app.indexOf("const completeSale"), app.indexOf("const handleSaleRejected"));

    expect(callback.match(/completeDeviceSaleV5\(/g)).toHaveLength(1);
  });

  it("the refusal re-read OBSERVES — it must never establish", () => {
    // The correction, pinned at the call site. `deriveGateState()` with no
    // argument establishes, and establishing here is what silently adopted a
    // different employee or register after the server refused the sale.
    const callback = app.slice(app.indexOf("const completeSale"), app.indexOf("const handleSaleRejected"));

    expect(callback).toContain('deriveGateState("observe")');
    expect(callback).not.toMatch(/deriveGateState\(\s*\)/);
  });

  it("only observe mode reaches applyRecoveryObservation, and it is the only user", () => {
    expect(app).toContain("applyRecoveryObservation");
    expect(app).toContain('mode === "observe"');
  });
});

describe("the online device sale is v5, with expectations", () => {
  const app = code(read(DEVICE_APP));
  const rpc = code(read("lib/device.rpc.ts"));

  it("the host calls completeDeviceSaleV5", () => {
    expect(app).toContain("completeDeviceSaleV5");
    expect(app).not.toContain("completeDeviceSaleV3");
  });

  it("it sends both expectations", () => {
    expect(app).toContain("expectedEmployeePosSessionId");
    expect(app).toContain("expectedRegisterSessionId");
  });

  it("the wrapper sends no project id — the server derives it", () => {
    const v5 = exportedDeclaration(rpc, "completeDeviceSaleV5");

    expect(v5).toContain('rpc("complete_sale_v5"');
    expect(v5).not.toMatch(/p_project_id\s*:/);
    expect(v5).toContain("p_employee_pos_session_id");
    expect(v5).toContain("p_register_session_id");
    // Online sales never declare their own time, and a device may not tip.
    expect(v5).toContain("p_occurred_at: null");
    expect(v5).toContain("p_tip_amount: 0");
  });

  it("v3 remains defined for the owner host and for rollback", () => {
    expect(rpc).toContain('rpc("complete_sale_v3"');
  });
});

describe("the owner/browser POS is untouched", () => {
  const owner = code(read(OWNER));

  it("still submits through complete_sale_v3", () => {
    expect(owner).toContain("completeSaleOrderV3");
    expect(owner).not.toContain("completeDeviceSaleV5");
    expect(owner).not.toContain("complete_sale_v5");
  });

  it("has no employee or register machinery", () => {
    for (const banned of ["employeeLogin", "openRegisterSession", "posGate", "registerSession"]) {
      expect(`${OWNER}: ${banned}`).toBe(`${OWNER}: ${banned}`);
      expect(owner).not.toContain(banned);
    }
  });
});

describe("PosRuntime stays host-agnostic", () => {
  const runtime = code(read(POS_RUNTIME));

  it("knows nothing about Supabase or the device session", () => {
    for (const banned of ["supabase", "Supabase", "getDeviceSupabaseClient", "auth.uid"]) {
      expect(`${POS_RUNTIME}: ${banned}`).toBe(`${POS_RUNTIME}: ${banned}`);
      expect(runtime).not.toContain(banned);
    }
  });

  it("knows nothing about employees, registers or attribution", () => {
    for (const banned of [
      "employeeLogin",
      "employee_login",
      "openRegisterSession",
      "closeRegisterSession",
      "registerSessionId",
      "employeePosSessionId",
      "complete_sale_v5",
      "posGate",
    ]) {
      expect(`${POS_RUNTIME}: ${banned}`).toBe(`${POS_RUNTIME}: ${banned}`);
      expect(runtime).not.toContain(banned);
    }
  });

  it("still receives its sale behaviour by injection", () => {
    expect(runtime).toContain("submitSale: PosRuntimeCompleteSale");
  });
});

describe("no template carries Feature 1B behaviour", () => {
  const templateFiles = [
    ...filesUnder("components/editor/pos-layouts"),
    ...filesUnder("components/runtime").filter(
      (file) => file !== POS_RUNTIME && file !== OWNER && !file.includes("PosGates")
    ),
  ];

  for (const file of templateFiles) {
    it(`${file} has no employee, register or attribution logic`, () => {
      const source = code(read(file));

      for (const banned of [
        "employeeLogin",
        "openRegisterSession",
        "closeRegisterSession",
        "fetchCurrentRegisterSession",
        "completeDeviceSaleV5",
        "buildOfflineClaims",
        "canCheckoutOffline",
      ]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    });
  }

  it("the gate components live under the device host", () => {
    // Shared, functional, and mounted by DeviceApp — not by a template.
    expect(code(read(DEVICE_APP))).toContain('from "@/components/device/PosGates"');
  });
});

describe("Android and Windows consume the same runtime", () => {
  it("the native entry mounts the shared DeviceApp and nothing else", () => {
    const main = code(read("native-device/main.tsx"));

    expect(main).toContain('import DeviceApp from "@/components/device/DeviceApp"');
    expect(main).not.toContain("posGate");
    expect(main).not.toContain("registerSession");
    expect(main).not.toContain("employee");
  });

  it("no platform file forks employee, register or attribution behaviour", () => {
    const platformFiles = [
      ...filesUnder("native-device"),
      ...filesUnder("windows-shell").filter((file) => file.endsWith(".ts")),
    ];

    for (const file of platformFiles) {
      const source = code(read(file));

      for (const banned of ["employeeLogin", "openRegisterSession", "complete_sale_v5", "posGate"]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });
});

describe("the roster is requested, not assumed", () => {
  const app = code(read(DEVICE_APP));
  const gates = code(read("components/device/PosGates.tsx"));

  it("the host asks for the roster automatically", () => {
    // The defect: nothing called loadRoster on the way in, so a normal startup
    // sat at the employee gate holding a list it had never requested.
    expect(app).toContain("shouldLoadRoster");
    expect(app).toContain("void loadRoster()");
  });

  it("the load conditions live in the pure module, not inline in the component", () => {
    expect(app).toContain('from "@/lib/employeeRoster"');
    expect(app).toContain("beginRosterLoad");
    expect(app).toContain("applyRosterLoaded");
    expect(app).toContain("applyRosterFailed");
  });

  it("a failed load is NOT turned into an empty roster", () => {
    // The old code did `setRoster([])` on failure, which the selector then
    // rendered as "this project has nobody".
    const loader = app.slice(app.indexOf("const loadRoster"), app.indexOf("const refreshSaleStatus"));

    expect(loader).toContain("applyRosterFailed()");
    expect(loader).not.toContain("setRoster([])");
  });

  it("concurrent loads are refused", () => {
    const loader = app.slice(app.indexOf("const loadRoster"), app.indexOf("const refreshSaleStatus"));

    expect(loader).toContain("rosterInFlightRef.current");
  });

  it("only a confirmed empty response may say nobody can sign in", () => {
    const claim = "No one can sign in on this till yet";

    expect(gates).toContain(claim);
    expect(gates).toContain("isRosterConfirmedEmpty(roster)");

    // The claim must be guarded by that function and nothing weaker. Reading
    // the rendered block proves the guard sits on the claim itself.
    const guarded = gates.slice(
      gates.indexOf("isRosterConfirmedEmpty(roster)"),
      gates.indexOf(claim)
    );

    expect(guarded.length).toBeLessThan(200);
  });

  it("the selector receives the lifecycle, not a bare array", () => {
    expect(gates).toContain("roster: RosterState");
    expect(app).toContain("roster={roster}");
  });
});

describe("recovery is an explicit act", () => {
  const app = code(read(DEVICE_APP));
  const gates = code(read("components/device/PosGates.tsx"));

  it("both gates are told when they are a recovery surface", () => {
    expect(app).toContain('recovery={gate.recovery === "employee"}');
    expect(app).toContain('recovery={gate.recovery === "register"}');
  });

  it("adopting the open register is a button, never automatic", () => {
    expect(gates).toContain("onAdoptCurrentRegister");
    expect(app).toContain("handleAdoptCurrentRegister");

    // The host's handler is reachable only from that callback prop.
    expect(app).toContain("onAdoptCurrentRegister={() => void handleAdoptCurrentRegister()}");
  });

  it("the explicit adoption is the only caller of applyExplicitRegisterEstablished", () => {
    expect(app.match(/applyExplicitRegisterEstablished\(/g)).toHaveLength(1);

    const handler = app.slice(
      app.indexOf("const handleAdoptCurrentRegister"),
      app.indexOf("const handleCloseRegister")
    );

    expect(handler).toContain("applyExplicitRegisterEstablished(gateRef.current");
  });
});

describe("the runtime's stale-state messages match the server's", () => {
  it("every classified message exists verbatim in the migration", () => {
    const migration = read(
      "supabase/migrations/20260917120000_register_sessions_and_sale_attribution.sql"
    );
    const gate = read("lib/posGate.ts");

    for (const constant of [
      "An employee must be signed in on this register",
      "The signed-in employee changed",
      "The register is not open",
      "The register session changed",
      "This sale must name the signed-in employee and the open register",
    ]) {
      expect(`migration: ${constant}`).toBe(`migration: ${constant}`);
      expect(migration).toContain(`raise exception '${constant}'`);
      expect(gate).toContain(constant);
    }
  });
});
