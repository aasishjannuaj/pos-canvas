// Feature 16.4A — static security guards for the paired-device surface.
//
// These are source-level assertions, not behavioral tests. They exist because
// the properties they protect are structural: once device code imports the
// cookie-backed owner client, no runtime test will notice until an owner is
// silently signed out of their own browser, or worse, a device sale is
// transacted through an owner session that happened to be present.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf-8");
}

function listFiles(relativeDir: string): string[] {
  const absolute = join(repoRoot, relativeDir);
  return readdirSync(absolute)
    .filter((entry) => statSync(join(absolute, entry)).isFile())
    .map((entry) => join(relativeDir, entry));
}

/** Every file that runs on a paired device. */
const DEVICE_FILES = [
  "app/device/page.tsx",
  "lib/device.rpc.ts",
  "lib/deviceSession.ts",
  "lib/supabase/deviceClient.ts",
  ...listFiles("components/device"),
].filter((path) => !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"));

/** Strips comments so explanatory prose naming a banned module never trips a guard. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("device code never reaches an owner or privileged Supabase client", () => {
  const BANNED = [
    "@/lib/supabase/client",
    "@/lib/supabase/server",
    "@/lib/supabase/admin",
    "@/lib/supabase/adminConfig",
    // Both build the cookie-backed browser client internally.
    "@/lib/orders",
    "@/lib/projects",
  ];

  for (const file of DEVICE_FILES) {
    for (const banned of BANNED) {
      it(`${file} does not import ${banned}`, () => {
        expect(code(read(file))).not.toContain(banned);
      });
    }
  }

  it("covers every file under components/device", () => {
    // Guards that silently stop covering new files are worse than no guards.
    const deviceComponents = DEVICE_FILES.filter((path) =>
      path.startsWith("components/device")
    );
    expect(deviceComponents.length).toBeGreaterThanOrEqual(3);
  });

  it("device code never references the service-role credential", () => {
    // Comment-stripped: lib/supabase/deviceClient.ts documents WHY the
    // service-role key is absent, and that explanation must not trip a guard
    // whose subject is executable code.
    for (const file of DEVICE_FILES) {
      expect(code(read(file))).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
      expect(code(read(file))).not.toContain("createAdminClient");
    }
  });

  it("the device client is built on supabase-js, never on the cookie-backed ssr helper", () => {
    const source = code(read("lib/supabase/deviceClient.ts"));
    expect(source).toContain("@supabase/supabase-js");
    expect(source).not.toContain("@supabase/ssr");
    expect(source).not.toContain("createBrowserClient");
  });

  it("the device client persists a session, refreshes it, and ignores URL fragments", () => {
    const source = code(read("lib/supabase/deviceClient.ts"));
    expect(source).toContain("persistSession: true");
    expect(source).toContain("autoRefreshToken: true");
    expect(source).toContain("detectSessionInUrl: false");
    expect(source).toContain('storageKey: DEVICE_AUTH_STORAGE_KEY');
  });
});

describe("owner session handling is untouched", () => {
  it("lib/supabase/client.ts still builds the cookie-backed owner client", () => {
    const source = code(read("lib/supabase/client.ts"));
    expect(source).toContain("createBrowserClient");
    expect(source).toContain("@supabase/ssr");
  });

  it("lib/supabase/server.ts and proxy.ts are unchanged in shape", () => {
    expect(code(read("lib/supabase/server.ts"))).toContain("createServerClient");
    expect(code(read("lib/supabase/proxy.ts"))).toContain("getClaims");
  });

  it("no device code signs out or mutates the owner session", () => {
    for (const file of DEVICE_FILES) {
      const source = code(read(file));
      // A global sign-out would kill the owner's session too. The device reset
      // must be scope: "local" on the device client only.
      expect(source).not.toContain('scope: "global"');
      expect(source).not.toContain("document.cookie");
    }
  });

  it("the device reset clears only the device storage key", () => {
    const source = code(read("lib/device.rpc.ts"));
    expect(source).toContain('signOut({ scope: "local" })');
    expect(source).toContain("removeItem(DEVICE_AUTH_STORAGE_KEY)");
  });
});

describe("/device is outside owner route protection", () => {
  const proxySource = read("proxy.ts");

  it("is not in the proxy matcher", () => {
    const matcher = proxySource.slice(proxySource.indexOf("matcher"));
    expect(matcher).not.toContain("/device");
  });

  it("is not in the protected-prefix list", () => {
    expect(proxySource).toContain(
      'const PROTECTED_PREFIXES = ["/dashboard", "/editor", "/runtime"]'
    );
  });

  it("the device route does not read cookies or owner auth on the server", () => {
    const source = code(read("app/device/page.tsx"));
    expect(source).not.toContain("cookies()");
    expect(source).not.toContain("getProjectById");
    expect(source).not.toContain("getClaims");
  });

  it("is not linked from owner navigation", () => {
    for (const file of [
      "components/editor/EditorShell.tsx",
      "components/editor/EditorSidebar.tsx",
      "components/runtime/PosRuntime.tsx",
      "app/page.tsx",
    ]) {
      expect(code(read(file))).not.toContain('"/device"');
    }
  });
});

describe("the pinned config is never persisted", () => {
  it("no device file writes storage beyond the auth reset", () => {
    for (const file of DEVICE_FILES) {
      const source = code(read(file));
      expect(source).not.toContain("localStorage.setItem");
      expect(source).not.toContain("sessionStorage");
      expect(source).not.toContain("indexedDB");
    }
  });

  it("the only storage removal is the device auth key", () => {
    const removals = DEVICE_FILES.flatMap((file) =>
      [...code(read(file)).matchAll(/removeItem\(([^)]*)\)/g)].map((m) => m[1].trim())
    );
    expect(removals).toEqual(["DEVICE_AUTH_STORAGE_KEY"]);
  });
});

describe("pairing errors stay collapsed", () => {
  it("device code renders messages from the shared table, never a raw rpc error", () => {
    const rpc = code(read("lib/device.rpc.ts"));
    expect(rpc).toContain("getRedeemErrorMessage");
    // The redemption path must never surface error.message from PostgREST.
    const redeemSection = rpc.slice(rpc.indexOf("redeemDevicePairingCode"));
    expect(redeemSection.slice(0, redeemSection.indexOf("fetchDeviceConfig"))).not.toContain(
      "error.message"
    );
  });

  it("redemption sends the resolved identity, not hardcoded or null values", () => {
    const rpc = code(read("lib/device.rpc.ts"));
    expect(rpc).toContain("p_device_name: input.identity.deviceName");
    expect(rpc).toContain("p_platform: input.identity.platform");
    // The nulls of the first 16.4A pass would have frozen every till as
    // "Unnamed device", since D4c allows no later correction.
    expect(rpc).not.toContain("p_device_name: null");
    expect(rpc).not.toContain("p_platform: null");
  });

  it("the device app derives its platform from the shells' own bridges", () => {
    // Feature 23.3 widened this from one signal to two. Both still come from a
    // shell's own bridge — never from a user agent — and the Android signal is
    // passed first because resolveDeviceIdentity gives it priority.
    const app = code(read("components/device/DeviceApp.tsx"));

    expect(app).toContain("isNativeShell: isCapacitorNativeShell()");
    expect(app).toContain("isWindowsShell: isWindowsShell()");
    expect(app).toContain('from "@/lib/nativeShell"');
    expect(app).toContain('from "@/lib/windowsShell"');
  });

  it("introduces no user-agent sniffing anywhere in device code", () => {
    // lib/nativeShell.ts already answers this question with Capacitor's own
    // isNativePlatform(). A second, UA-based mechanism would be both
    // unreliable and a silent fork of an existing decision.
    for (const file of DEVICE_FILES) {
      const source = code(read(file));
      expect(source).not.toMatch(/navigator\.userAgent|userAgentData|navigator\.platform/i);
      expect(source).not.toMatch(/\/android\/i|\/iphone\/i|\/mobile\/i/i);
    }
  });

  it("does not add a rename path or a last_seen write", () => {
    for (const file of DEVICE_FILES) {
      const source = code(read(file));
      expect(source).not.toContain("last_seen");
      expect(source).not.toMatch(/rename|update_device_name/i);
    }
  });

  it("normalization is reused, never re-implemented", () => {
    const rpc = code(read("lib/device.rpc.ts"));
    expect(rpc).toContain("normalizePairingCode");
    expect(rpc).toContain("isValidPairingCodeShape");

    const screen = code(read("components/device/DevicePairingScreen.tsx"));
    expect(screen).toContain("normalizePairingCode");
    expect(screen).toContain("isValidPairingCodeShape");
    // A local regex would be a second implementation that can drift from SQL.
    expect(screen).not.toContain("toUpperCase()");
    expect(screen).not.toContain("replace(/[^0-9A-Za-z]/g");
  });
});

describe("PosRuntime is transport-agnostic", () => {
  const source = code(read("components/runtime/PosRuntime.tsx"));

  it("no longer imports the owner data layer", () => {
    expect(source).not.toContain("@/lib/orders");
    expect(source).not.toContain("@/lib/projects");
  });

  it("takes checkout and stock refresh as injected behavior", () => {
    expect(source).toContain("submitSale: PosRuntimeCompleteSale");
    expect(source).toContain("refreshStock: PosRuntimeRefreshStock | null");
    expect(source).toContain("homeLink: PosRuntimeHomeLink | null");
  });

  it("is unaware of Supabase and of auth roles", () => {
    expect(source).not.toContain("supabase");
    expect(source).not.toContain("anonymous");
    expect(source).not.toMatch(/\bisOwner\b|\bisDevice\b|mode\s*===/);
  });

  it("the owner host supplies checkout, stock refresh and the dashboard link", () => {
    const owner = code(read("components/runtime/OwnerPosRuntime.tsx"));
    // Feature 18.2 — the owner host now calls complete_sale_v3. v2 stays
    // exported from lib/orders.ts for a stale tab and for rollback, but no
    // current host may reach it: v2 fails closed on modifier-bearing products,
    // so a host still wired to it would start refusing sales the moment an
    // owner authors a modifier group.
    expect(owner).toContain("completeSaleOrderV3");
    expect(owner).not.toContain("completeSaleOrderV2");
    expect(owner).toContain("getProjectConfig");
    expect(owner).toContain('href: "/dashboard"');
  });

  it("the device host calls complete_sale_v3, not v2", () => {
    const app = code(read("components/device/DeviceApp.tsx"));
    expect(app).toContain("completeDeviceSaleV3");
    expect(app).not.toMatch(/completeDeviceSale\b(?!V3)/);
  });

  it("both hosts send modifier IDENTIFIERS only", () => {
    // Feature 18.2 Phase 5A — the payload build moved out of PosRuntime into
    // lib/saleSubmission.ts's buildSaleRequestItems, so the Builder Preview's
    // own v3 checkout runs the identical function rather than a copy. The
    // property asserted is unchanged: toModifierSelections strips every display
    // name and price adjustment before the request is assembled.
    const submission = code(read("lib/saleSubmission.ts"));
    expect(submission).toContain("toModifierSelections(cartItem.modifiers)");
    expect(submission).not.toMatch(/SaleSubmissionItem = \{[^}]*priceAdjustment/s);
    expect(submission).not.toMatch(/SaleSubmissionItem = \{[^}]*groupName/s);

    // And no host may assemble a payload of its own alongside it.
    for (const file of [
      "components/runtime/PosRuntime.tsx",
      "components/editor/EditorShell.tsx",
    ]) {
      expect(code(read(file))).toContain("items: plan.items");
      expect(code(read(file))).not.toContain("items: cart.map");
    }
  });
});
