// Feature 16.4B — static guards for the owner Devices UI.
//
// Source-level assertions, because these properties are structural: a browser
// component that reaches past the server actions, renders an identity field,
// or persists a pairing code would not fail any behavioral test in this
// repository (there is no DOM environment), but each would be a real defect.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf-8");
}

/** Strips comments so prose naming a banned symbol never trips a guard. */
function code(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const OWNER_DEVICE_FILES = readdirSync(join(repoRoot, "components/devices"))
  .filter((entry) => statSync(join(repoRoot, "components/devices", entry)).isFile())
  .map((entry) => join("components/devices", entry))
  .filter((path) => !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"));

describe("the Devices section is wired into the editor", () => {
  it("exists in the EditorSection union", () => {
    expect(code(read("components/editor/EditorShell.tsx"))).toContain('| "Devices"');
  });

  it("appears in the sidebar section list", () => {
    expect(code(read("components/editor/EditorSidebar.tsx"))).toContain(
      '{ label: "Devices", icon: "📱" }'
    );
  });

  it("renders the panel in the main content area", () => {
    const shell = code(read("components/editor/EditorShell.tsx"));
    expect(shell).toContain('editorSection === "Devices"');
    expect(shell).toContain("<DeviceManagementPanel");
  });

  it("passes only the project id and a build-navigation callback", () => {
    const shell = code(read("components/editor/EditorShell.tsx"));
    const panelUsage = shell.slice(
      shell.indexOf("<DeviceManagementPanel"),
      shell.indexOf("<DeviceManagementPanel") + 260
    );
    // The panel is self-contained; a growing prop list here would mean state
    // leaked back into EditorShell.
    expect(panelUsage).toContain("projectId={projectId}");
    expect(panelUsage).toContain("onGoToBuild=");
    expect(panelUsage).not.toContain("devices=");
    expect(panelUsage).not.toContain("buildJob");
  });

  it("does not disturb the existing sections or Build behavior", () => {
    const sidebar = code(read("components/editor/EditorSidebar.tsx"));
    for (const label of [
      "Menu",
      "Branding",
      "Business",
      "Taxes",
      "Settings",
      "Dashboard",
      "Sales Report",
      "Product Performance",
      "Inventory Summary",
    ]) {
      expect(sidebar).toContain(`label: "${label}"`);
    }

    const shell = code(read("components/editor/EditorShell.tsx"));
    expect(shell).toContain("requestBuildJob");
    expect(shell).toContain("refreshBuildJobStatus");
    expect(shell).toContain("downloadBuildArtifact");
  });
});

describe("the owner UI reaches the database only through existing actions", () => {
  const BANNED = [
    "@/lib/supabase/admin",
    "@/lib/supabase/adminConfig",
    "@/lib/supabase/server",
    "@/lib/supabase/deviceClient",
    "SUPABASE_SERVICE_ROLE_KEY",
    "createAdminClient",
    "service_role",
  ];

  for (const file of OWNER_DEVICE_FILES) {
    for (const banned of BANNED) {
      it(`${file} does not reference ${banned}`, () => {
        expect(code(read(file))).not.toContain(banned);
      });
    }
  }

  it("never writes paired_devices, device_pairing_tokens or build_jobs directly", () => {
    for (const file of OWNER_DEVICE_FILES) {
      const source = code(read(file));
      expect(source).not.toContain(".from(");
      expect(source).not.toContain(".rpc(");
      expect(source).not.toContain("paired_devices");
      expect(source).not.toContain("device_pairing_tokens");
      expect(source).not.toContain("createClient");
    }
  });

  it("uses only the four existing pairing actions plus the build-list action", () => {
    const panel = code(read("components/devices/DeviceManagementPanel.tsx"));
    expect(panel).toContain("requestDevicePairingToken");
    expect(panel).toContain("cancelPairingToken");
    expect(panel).toContain("listProjectPairedDevices");
    expect(panel).toContain("revokeDevice");
    expect(panel).toContain("listProjectBuildJobs");
  });

  it("never sends an owner id", () => {
    for (const file of OWNER_DEVICE_FILES) {
      const source = code(read(file));
      expect(source).not.toContain("ownerId");
      expect(source).not.toContain("owner_id");
      expect(source).not.toContain("auth.uid");
    }
  });

  it("renders no auth_user_id, owner_id or revoked_by", () => {
    for (const file of OWNER_DEVICE_FILES) {
      const source = code(read(file));
      expect(source).not.toContain("auth_user_id");
      expect(source).not.toContain("authUserId");
      expect(source).not.toContain("revoked_by");
      expect(source).not.toContain("revokedBy");
    }
  });
});

describe("the plaintext pairing code is never persisted", () => {
  it("no owner device file touches storage, cookies or the URL", () => {
    for (const file of OWNER_DEVICE_FILES) {
      const source = code(read(file));
      expect(source).not.toContain("localStorage");
      expect(source).not.toContain("sessionStorage");
      expect(source).not.toContain("document.cookie");
      expect(source).not.toContain("indexedDB");
      expect(source).not.toContain("history.pushState");
      expect(source).not.toContain("searchParams");
      expect(source).not.toContain("router.push");
    }
  });

  it("never logs anything", () => {
    for (const file of OWNER_DEVICE_FILES) {
      expect(code(read(file))).not.toContain("console.");
    }
  });

  it("keeps only the formatted code in state, not the raw code", () => {
    const panel = code(read("components/devices/DeviceManagementPanel.tsx"));
    expect(panel).toContain("formattedCode: result.formattedCode");
    // result.code is the plaintext; copying it into state would double the
    // number of places it lives for no display benefit.
    expect(panel).not.toContain("code: result.code");
  });

  it("cancel consumes the token server-side rather than only hiding it", () => {
    const panel = code(read("components/devices/DeviceManagementPanel.tsx"));
    expect(panel).toContain("await cancelPairingToken(activeCode.tokenId)");
    expect(panel).toContain("setActiveCode(null)");
  });
});

describe("the pairing card and revoke dialog say what they must", () => {
  it("the card instructs the operator and shows the fixed lifetime", () => {
    const card = read("components/devices/PairingCodeCard.tsx");
    expect(card).toContain("Enter this code on the POS device.");
    expect(card).toContain("PAIRING_CODE_TTL_LABEL");
    expect(card).toContain("getPairingCodeRemainingSeconds");
  });

  it("the card handles an expired code explicitly", () => {
    const card = code(read("components/devices/PairingCodeCard.tsx"));
    expect(card).toContain("expired");
    expect(card).toContain("Expired");
  });

  it("the revoke dialog states all three consequences", () => {
    const dialog = read("components/devices/RevokeDeviceDialog.tsx");
    expect(dialog).toMatch(/stop being able to make sales/i);
    expect(dialog).toMatch(/cannot currently be undone/i);
    expect(dialog).toMatch(/resetting the physical device is separate/i);
  });
});

describe("device list presentation reuses the existing helpers", () => {
  it("labels come from lib/devices.ts, not from local strings", () => {
    const row = code(read("components/devices/DeviceRow.tsx"));
    expect(row).toContain("getPairedDeviceDisplayName");
    expect(row).toContain("getPairedDeviceStatusLabel");
    expect(row).toContain("isPairedDeviceActive");
    // A local status ternary would be a second source of truth.
    expect(row).not.toContain('=== "revoked" ?');
  });

  it("revoked devices stay in the list and lose only their action", () => {
    const row = code(read("components/devices/DeviceRow.tsx"));
    expect(row).toContain("{active && (");
    expect(row).toContain("Revoke");
  });

  it("refresh is manual — no Realtime subscription and no polling", () => {
    for (const file of OWNER_DEVICE_FILES) {
      const source = code(read(file));
      expect(source).not.toContain(".channel(");
      expect(source).not.toContain("subscribe(");
      expect(source).not.toContain("setInterval(() => void load");
    }
    expect(code(read("components/devices/PairedDeviceList.tsx"))).toContain(
      "onRefresh"
    );
  });
});

describe("the build-list action is a thin wrapper, not a new query", () => {
  const actions = code(read("lib/buildJobs.actions.ts"));

  it("delegates to the existing server function", () => {
    expect(actions).toContain("getProjectBuildJobs");
    expect(actions).toContain("export async function listProjectBuildJobs");
  });

  it("adds no Supabase query of its own", () => {
    const wrapper = actions.slice(actions.indexOf("listProjectBuildJobs"));
    expect(wrapper).not.toContain(".from(");
    expect(wrapper).not.toContain("select(");
  });

  it("validates the project id as a uuid before any database call", () => {
    const wrapper = actions.slice(actions.indexOf("listProjectBuildJobs"));
    expect(wrapper).toContain("isValidUuid(projectId)");
  });
});
