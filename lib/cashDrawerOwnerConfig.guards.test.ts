// Cash Drawer Checkpoint 1D — permanent source-level guards for the owner's
// per-register drawer configuration.
//
// lib/cashDrawerOwnerConfig.test.ts proves the model. These are the structural
// properties, and this repository has no React Testing Library, so the
// components are read:
//
//   * the value is READ through the one existing owner device query;
//   * the write goes browser → action → server wrapper → accepted RPC, and
//     nothing in a component reaches past that;
//   * nothing is committed to the screen before the database confirms it;
//   * no hardware, Electron, printer or koffi concept enters Lane 3;
//   * the setting is PER REGISTER — there is no project, template or employee
//     level drawer configuration anywhere.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

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

const MODEL = "lib/devices.ts";
const SERVER = "lib/devicePairing.server.ts";
const ACTIONS = "lib/devicePairing.actions.ts";
const PANEL = "components/devices/DeviceManagementPanel.tsx";
const LIST = "components/devices/PairedDeviceList.tsx";
const ROW = "components/devices/DeviceRow.tsx";

const BROWSER_COMPONENTS = [PANEL, LIST, ROW];
const TASK_1D_SOURCES = [MODEL, SERVER, ACTIONS, ...BROWSER_COMPONENTS];

// ---------------------------------------------------------------------------
// The owner read
// ---------------------------------------------------------------------------

describe("the setting is read through the one existing owner query", () => {
  it("the owner SELECT asks for cash_drawer_enabled", () => {
    const server = code(read(SERVER));

    expect(server).toContain("cash_drawer_enabled");
    expect(server).toMatch(/\.select\(\s*\n?\s*"[^"]*cash_drawer_enabled[^"]*"/);
  });

  it("the existing approved owner fields are all still selected", () => {
    const server = code(read(SERVER));
    const select = server.slice(
      server.indexOf('"id, project_id, build_job_id'),
      server.indexOf('.eq("project_id", projectId)')
    );

    for (const column of [
      "id",
      "project_id",
      "build_job_id",
      "device_name",
      "platform",
      "created_at",
      "last_seen_at",
      "revoked_at",
      "unpaired_at",
      "offered_build_job_id",
      "offered_at",
    ]) {
      expect(`selects ${column}`).toBe(`selects ${column}`);
      expect(select).toContain(column);
    }

    // And still no identity column, which is the property the narrow select
    // exists for.
    expect(select).not.toContain("auth_user_id");
    expect(select).not.toContain("owner_id");
    expect(select).not.toContain("revoked_by");
  });

  it("there is still exactly ONE owner paired-device query", () => {
    const server = code(read(SERVER));

    expect(server.match(/\.from\("paired_devices"\)/g) ?? []).toHaveLength(1);
  });

  it("no second configuration store or model exists", () => {
    for (const file of TASK_1D_SOURCES) {
      const source = code(read(file));

      for (const banned of [
        "localStorage",
        "sessionStorage",
        "indexedDB",
        "cashDrawerConfigStore",
        "drawerSettings",
      ]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The mutation boundary
// ---------------------------------------------------------------------------

describe("the write goes browser → action → wrapper → accepted RPC", () => {
  it("no browser component calls an RPC or a table directly", () => {
    for (const file of BROWSER_COMPONENTS) {
      const source = code(read(file));

      expect(`${file}: rpc`).toBe(`${file}: rpc`);
      expect(source).not.toContain(".rpc(");
      expect(source).not.toContain(".from(");
      expect(source).not.toContain("set_device_cash_drawer_enabled");
      expect(source).not.toContain("createClient");
    }
  });

  it("no part of this feature reaches for a service role", () => {
    for (const file of TASK_1D_SOURCES) {
      const source = code(read(file));

      for (const banned of [
        "service_role",
        "SUPABASE_SERVICE_ROLE_KEY",
        "createAdminClient",
        "supabase/admin",
      ]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("the action takes a device id and a boolean, and nothing else", () => {
    const actions = code(read(ACTIONS));
    const action = actions.slice(
      actions.indexOf("export async function setDeviceCashDrawerEnabled"),
      actions.indexOf("export async function cancelPairingToken")
    );

    expect(action).toContain("deviceId: string");
    expect(action).toContain("enabled: boolean");
    // No owner, project or platform may be named by a caller.
    expect(action).not.toMatch(/ownerId|owner_id|projectId|project_id|platform/);
    expect(action).toContain("isValidUuid(deviceId)");
    expect(action).toContain('typeof enabled !== "boolean"');
  });

  it("the action delegates to the server wrapper and does nothing else", () => {
    const actions = code(read(ACTIONS));
    const action = actions.slice(
      actions.indexOf("export async function setDeviceCashDrawerEnabled"),
      actions.indexOf("export async function cancelPairingToken")
    );

    expect(action).toContain("setOwnerDeviceCashDrawerEnabled(deviceId, enabled)");
    expect(action).not.toContain(".rpc(");
    expect(action).not.toContain(".from(");
  });

  it("the wrapper calls exactly set_device_cash_drawer_enabled", () => {
    const server = code(read(SERVER));
    const wrapper = server.slice(
      server.indexOf("export async function setOwnerDeviceCashDrawerEnabled")
    );

    expect(wrapper).toContain('supabase.rpc("set_device_cash_drawer_enabled", {');
    // Exactly the two accepted parameters, and no third.
    expect(wrapper).toContain("p_device_id: deviceId,");
    expect(wrapper).toContain("p_enabled: enabled,");
    expect(wrapper).not.toMatch(/p_owner|p_project|p_platform|p_enabled_by/);
  });

  it("nothing updates paired_devices directly", () => {
    for (const file of TASK_1D_SOURCES) {
      const source = code(read(file));

      expect(`${file}: update`).toBe(`${file}: update`);
      expect(source).not.toMatch(/\.update\(|\.upsert\(|\.insert\(/);
    }
  });

  it("the setter RPC is named in exactly one production file", () => {
    const named = TASK_1D_SOURCES.filter((f) =>
      code(read(f)).includes("set_device_cash_drawer_enabled")
    );

    expect(named).toEqual([SERVER]);
  });
});

// ---------------------------------------------------------------------------
// Confirmed state, never optimistic
// ---------------------------------------------------------------------------

describe("nothing is shown before the database confirms it", () => {
  const panel = code(read(PANEL));
  const handler = panel.slice(
    panel.indexOf("async function handleCashDrawerChange"),
    panel.indexOf("async function handleOfferUpdateToAll")
  );

  it("the handler exists above the offer handlers", () => {
    // Placement matters: lib/deviceOffer.test.ts bans `setDevices(` between
    // `handleOfferUpdate` and `return (`, and that window would otherwise
    // swallow this handler's authoritative re-read.
    expect(handler.length).toBeGreaterThan(0);
    expect(panel.indexOf("async function handleCashDrawerChange")).toBeLessThan(
      panel.indexOf("async function handleOfferUpdateToAll")
    );
  });

  it("the row renders the stored value, never a requested one", () => {
    const row = code(read(ROW));

    expect(row).toContain("checked={device.cashDrawerEnabled}");
    // No local mirror of the setting to drift from the database.
    expect(row).not.toMatch(/useState|pendingEnabled|requestedEnabled|optimistic/i);
  });

  it("the panel holds no requested-value state", () => {
    expect(panel).not.toMatch(/pendingCashDrawer|requestedCashDrawer|optimisticDrawer/i);
    // The only drawer state is which row is working, what failed, and whether
    // the list can still be trusted.
    expect(panel).toContain("const [cashDrawerDeviceId, setCashDrawerDeviceId]");
    expect(panel).toContain("const [cashDrawerErrors, setCashDrawerErrors]");
    expect(panel).toContain("const [cashDrawerStale, setCashDrawerStale]");
  });

  it("commits only by replacing the list from an authoritative re-read", () => {
    expect(handler).toContain("const reread = await listProjectPairedDevices(projectId)");
    expect(handler).toContain("setDevices(reread.devices)");
    // The re-read happens AFTER the RPC, not before or instead of it.
    expect(handler.indexOf("setDeviceCashDrawerEnabled(device.id, enabled)")).toBeLessThan(
      handler.indexOf("listProjectPairedDevices(projectId)")
    );
  });

  it("prevents duplicate and same-tick submissions with a ref", () => {
    expect(panel).toContain("const cashDrawerRef = useRef(false)");
    expect(handler).toContain("if (cashDrawerRef.current ||");
    expect(handler).toContain("cashDrawerRef.current = true;");
  });

  it("disables the control and announces busy while pending", () => {
    const row = code(read(ROW));

    expect(row).toContain("disabled={cashDrawerLocked}");
    expect(row).toContain("aria-busy={isCashDrawerUpdating}");
    expect(row).toContain("Updating…");
  });

  it("keeps the confirmed state visible while pending", () => {
    const row = code(read(ROW));

    // "Updating…" sits BESIDE the control; it does not replace it, so the
    // owner can still see what the register is currently set to.
    expect(row).toMatch(
      /checked=\{device\.cashDrawerEnabled\}[\s\S]{0,900}isCashDrawerUpdating &&[\s\S]{0,120}Updating…/
    );
  });
});

// ---------------------------------------------------------------------------
// Failure and staleness
// ---------------------------------------------------------------------------

describe("a failed change says nothing changed", () => {
  const panel = code(read(PANEL));
  const handler = panel.slice(
    panel.indexOf("async function handleCashDrawerChange"),
    panel.indexOf("async function handleOfferUpdateToAll")
  );

  it("preserves the previous authoritative state on failure", () => {
    // There is nothing to roll back, which is the point: the list is never
    // touched unless the re-read succeeded.
    const failure = handler.slice(handler.indexOf("if (!result.ok)"));

    expect(failure.slice(0, failure.indexOf("return;"))).not.toContain("setDevices(");
  });

  it("shows the exact failure sentence, accessibly", () => {
    const row = code(read(ROW));

    expect(panel).toContain("CASH_DRAWER_UPDATE_FAILED_MESSAGE");
    expect(row).toContain('role="alert"');
    expect(row).toContain("{cashDrawerError}");
  });

  it("marks the list stale when the write landed but the re-read did not", () => {
    expect(handler).toContain("setCashDrawerStale(true)");
    // Reached only on the re-read's failure path, after a successful RPC.
    expect(handler.indexOf("if (reread.ok)")).toBeLessThan(
      handler.indexOf("setCashDrawerStale(true)")
    );
  });

  it("guesses no value when the re-read failed", () => {
    const stale = handler.slice(handler.indexOf("setCashDrawerStale(true)"));

    expect(stale).not.toContain("setDevices(");
    expect(stale).not.toContain("enabled");
  });

  it("blocks another change until Refresh recovers the truth", () => {
    expect(handler).toContain("cashDrawerStale ||");
    expect(panel).toContain("cashDrawerLocked={cashDrawerDeviceId !== null || cashDrawerStale}");
    // Refresh is the only exit.
    expect(panel).toMatch(/onRefresh=\{\(\) => \{[\s\S]{0,400}setCashDrawerStale\(false\)/);
  });

  it("is narrow to the drawer setting: Revoke and Offer are untouched", () => {
    // The bulk control's own disabled condition lives in the LIST, not the
    // panel — an earlier form of this guard looked in the wrong file.
    expect(code(read(LIST))).toContain(
      "disabled={bulkOffering || offeringDeviceId !== null}"
    );
    const row = code(read(ROW));

    // The revoke button's disabled condition is still its own.
    expect(row).toContain("disabled={isBusy}");
    expect(row).toContain("disabled={anyOfferInFlight}");
  });
});

// ---------------------------------------------------------------------------
// What the screen offers, per platform
// ---------------------------------------------------------------------------

describe("the control appears only where it can work", () => {
  const row = code(read(ROW));

  it("an active Windows register gets a real, labelled checkbox", () => {
    expect(row).toContain('type="checkbox"');
    expect(row).toContain("Auto-open cash drawer");
    expect(row).toContain("htmlFor={drawerControlId}");
    expect(row).toContain("id={drawerControlId}");
    expect(row).toContain("aria-describedby=");
    expect(row).toContain("focus-visible:outline");
  });

  it("states the supporting text exactly", () => {
    expect(read(ROW)).toContain(
      "For this register only. Opens automatically after successful cash\n                sales on Windows."
    );
  });

  it("a non-Windows register is told why, with no switch", () => {
    expect(read(ROW)).toContain(
      "Automatic drawer opening is supported on Windows registers only."
    );

    const unsupported = row.slice(
      row.indexOf('drawerState === "unsupported_platform"'),
      row.indexOf('Cash drawer settings are unavailable')
    );

    expect(unsupported).not.toContain('type="checkbox"');
    expect(unsupported).not.toContain("onCashDrawerChange");
    // Not dressed up as something the owner could fix.
    expect(unsupported).not.toMatch(/permission|not allowed|upgrade|contact support/i);
  });

  it("a revoked register has the sentence and no mutation control", () => {
    expect(row).toContain("Cash drawer settings are unavailable for revoked registers.");

    const revoked = row.slice(row.indexOf("Cash drawer settings are unavailable"));

    expect(revoked).not.toContain('type="checkbox"');
    expect(revoked).not.toContain("onCashDrawerChange");
    // And the stored value is not presented as operational state.
    expect(revoked).not.toContain("device.cashDrawerEnabled");
  });

  it("derives all of this from the shared model, not from its own test", () => {
    expect(row).toContain("resolveCashDrawerConfigState(device)");
    expect(row).not.toMatch(/=== "windows"|platform\.toLowerCase/);
  });

  it("the switch is one control, rendered once", () => {
    expect(row.match(/type="checkbox"/g) ?? []).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The propagation note
// ---------------------------------------------------------------------------

describe("how a register learns of the change", () => {
  it("is said once, in the list, not on every row", () => {
    const list = code(read(LIST));

    expect(list).toContain("CASH_DRAWER_PROPAGATION_NOTE");
    // RENDERED once. The constant is named twice in the file — once to import
    // it, once to use it — so counting bare occurrences would be counting the
    // import too.
    expect(list.match(/\{CASH_DRAWER_PROPAGATION_NOTE\}/g) ?? []).toHaveLength(1);
    expect(code(read(ROW))).not.toContain("CASH_DRAWER_PROPAGATION_NOTE");
  });

  it("keeps the wording in the model's constant, never copied into a component", () => {
    const model = code(read(MODEL));

    expect(model).toContain("export const CASH_DRAWER_PROPAGATION_NOTE");
    for (const phrase of [
      "Restart the POS app",
      "reconnect and refresh its device settings",
      "last saved setting",
      "offline authorization expires",
    ]) {
      expect(`model: ${phrase}`).toBe(`model: ${phrase}`);
      expect(model).toContain(phrase);
      for (const file of [PANEL, LIST, ROW]) {
        expect(`${file}: ${phrase}`).toBe(`${file}: ${phrase}`);
        expect(read(file)).not.toContain(phrase);
      }
    }
  });

  it("adds no polling, Realtime, websocket or per-sale fetch", () => {
    for (const file of TASK_1D_SOURCES) {
      const source = code(read(file));

      for (const banned of [
        "setInterval",
        "setTimeout",
        "realtime",
        "Realtime",
        "websocket",
        "WebSocket",
        "EventSource",
        "subscribe(",
        "channel(",
      ]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Lane 3 carries no hardware
// ---------------------------------------------------------------------------

describe("owner configuration contacts nothing", () => {
  it("no Electron, IPC, printer, koffi or spooler concept appears", () => {
    for (const file of TASK_1D_SOURCES) {
      const source = code(read(file));

      for (const banned of [
        "electron",
        "Electron",
        "ipcRenderer",
        "ipcMain",
        "koffi",
        "spooler",
        "Spooler",
        "printer",
        "Printer",
        "posCanvasCashDrawer",
        "requestOpen",
        "0x1b",
        "ESC",
      ]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("the Builder's device UI does not reach the runtime coordinator", () => {
    // An accepted Checkpoint 1A guard pins the importers of lib/cashDrawer.ts
    // to the device runtime alone. The owner model answers the Windows
    // question independently for exactly that reason.
    for (const file of TASK_1D_SOURCES) {
      const source = code(read(file));

      expect(`${file}: coordinator`).toBe(`${file}: coordinator`);
      expect(source).not.toContain('from "@/lib/cashDrawer"');
      expect(source).not.toContain('from "@/lib/cashDrawerSession"');
      expect(source).not.toContain('from "@/lib/windowsCashDrawer"');
    }
  });

  it("offers no Test Drawer, manual open or printer selection", () => {
    for (const file of TASK_1D_SOURCES) {
      const source = code(read(file));

      for (const banned of [
        "Test Drawer",
        "testDrawer",
        "Open Drawer",
        "openDrawer",
        "kickDrawer",
        "printerProfile",
        "selectPrinter",
      ]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Per register, and only per register
// ---------------------------------------------------------------------------

describe("there is no drawer setting above the register", () => {
  it("none is stored on a project, template or employee", () => {
    for (const file of [
      "lib/projectConfig.ts",
      "lib/projects.ts",
      "lib/generatedPosConfig.ts",
      "data/templates.ts",
      "lib/employeeSession.ts",
    ]) {
      const source = code(read(file));

      expect(`${file}: drawer`).toBe(`${file}: drawer`);
      expect(source).not.toMatch(/cashDrawer|cash_drawer/i);
    }
  });

  it("the owner feature names a device and never a project or employee", () => {
    const server = code(read(SERVER));
    const start = server.indexOf("export async function setOwnerDeviceCashDrawerEnabled");
    // Bounded to this function's OWN body. Slicing to end-of-file swept in
    // offerDeviceConfigUpdate, which legitimately takes a project id.
    const wrapper = server.slice(
      start,
      server.indexOf("export async function", start + 1)
    );

    expect(wrapper).not.toMatch(/projectId|employeeId|templateId/);
  });

  it("the supporting text says it is this register only", () => {
    expect(read(ROW)).toMatch(/For this register only\./);
  });
});
