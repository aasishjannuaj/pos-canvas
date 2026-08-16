// Feature 23.3 — how a till says which platform it is.
//
// THE PROPERTY THAT MATTERS MOST: paired_devices.platform is written ONCE, at
// redemption, and frozen by a trigger afterwards (see
// supabase/migrations/20260803270000_artifact_and_device_immutability.sql).
// There is no rename RPC and no writer. A wrong value is therefore permanent for
// the life of that pairing — which is why the resolution below is a total,
// pure function with an explicit priority, tested exhaustively, rather than a
// conditional somewhere in a component.
//
// THE SECOND PROPERTY: the shell states a FACT ("you are inside the POS Canvas
// desktop shell") and the web app decides what that fact MEANS (`windows`).
// Keeping the mapping on the web side means it is reviewable, testable under
// plain Node, and changeable without shipping a new binary to every till.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveDeviceIdentity } from "@/lib/deviceSession";
import type { DevicePlatform } from "@/lib/deviceSession";
import { detectWindowsShell, isWindowsShell } from "@/lib/windowsShell";
import { detectNativeShell } from "@/lib/nativeShell";
import { formatDevicePlatform } from "@/lib/devicePairing.owner";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf-8");
}

/** Strips comments so explanatory prose never trips a guard. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const PRELOAD = "windows-shell/preload.js";
const DEVICE_APP = "components/device/DeviceApp.tsx";
const RPC = "lib/device.rpc.ts";
const DETECTOR = "lib/windowsShell.ts";

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe("the Windows shell is detected by its bridge, never by a user agent", () => {
  it("recognises the exact bridge shape", () => {
    expect(detectWindowsShell({ isWindowsShell: true })).toBe(true);
  });

  it("refuses anything else, including truthy near-misses", () => {
    // A decoy of roughly the right shape must not pass: `1` and `"true"` are
    // truthy, and a page that could set this global would otherwise relabel
    // itself permanently.
    const notTheShell: unknown[] = [
      undefined,
      null,
      {},
      true,
      1,
      "yes",
      [],
      { isWindowsShell: false },
      { isWindowsShell: 1 },
      { isWindowsShell: "true" },
      { isWindowsShell: null },
      { windows: true },
      { isWindowsShell: () => true },
    ];

    for (const bridge of notTheShell) {
      expect(`bridge ${JSON.stringify(bridge) ?? String(bridge)}`).toBe(
        `bridge ${JSON.stringify(bridge) ?? String(bridge)}`
      );
      expect(detectWindowsShell(bridge)).toBe(false);
    }
  });

  it("is safe during server rendering", () => {
    // Vitest runs under Node with no DOM, so `window` is genuinely undefined
    // here — this exercises the real SSR branch rather than a simulated one.
    expect(typeof window).toBe("undefined");
    expect(isWindowsShell()).toBe(false);
  });

  it("sniffs no user agent anywhere", () => {
    for (const file of [DETECTOR, "lib/nativeShell.ts", DEVICE_APP]) {
      const source = code(read(file));

      for (const banned of [
        "userAgent",
        "navigator.platform",
        "appVersion",
        "Electron/",
        "Chrome/",
        "Win32",
        "Windows NT",
      ]) {
        expect(`${file}: ${source}`).not.toContain(banned);
      }
    }
  });

  it("reads only its own global", () => {
    const source = code(read(DETECTOR));
    expect(source).toContain("posCanvasDesktop");
    expect(source).toContain('typeof window === "undefined"');
    // It must not reach for Capacitor's global, or the two detectors would fork
    // one decision across two files.
    expect(source).not.toContain("Capacitor");
  });
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe("platform resolution is total and prioritised", () => {
  const cases: [boolean, boolean, DevicePlatform][] = [
    [true, false, "android"],
    [false, true, "windows"],
    [false, false, "web"],
    [true, true, "android"],
  ];

  for (const [isNativeShell, isWindowsShellSignal, expected] of cases) {
    it(`native=${isNativeShell} windows=${isWindowsShellSignal} -> ${expected}`, () => {
      expect(
        resolveDeviceIdentity({ isNativeShell, isWindowsShell: isWindowsShellSignal })
          .platform
      ).toBe(expected);
    });
  }

  it("never lets the desktop signal override a real Android shell", () => {
    // The Capacitor bridge is produced by Capacitor itself; the desktop global
    // is ordinary page state from Android's point of view. If both appear, the
    // one that cannot be faked wins.
    expect(
      resolveDeviceIdentity({
        isNativeShell: detectNativeShell({ isNativePlatform: () => true }),
        isWindowsShell: detectWindowsShell({ isWindowsShell: true }),
      }).platform
    ).toBe("android");
  });

  it("takes named signals, not positional booleans", () => {
    // Transposed arguments would permanently mislabel every till they touched,
    // and platform cannot be corrected after insert.
    const source = code(read("lib/deviceSession.ts"));
    expect(source).toContain("export type DeviceShellSignals");
    expect(source).toContain("resolveDeviceIdentity(signals: DeviceShellSignals)");
  });

  it("still records no hardware or session identifier", () => {
    const identity = resolveDeviceIdentity({
      isNativeShell: false,
      isWindowsShell: true,
    });

    expect(Object.keys(identity).sort()).toEqual(["deviceName", "platform"]);
    expect(identity.deviceName).toBe("POS Device");
  });
});

// ---------------------------------------------------------------------------
// The pairing path
// ---------------------------------------------------------------------------

describe("the pairing path is unchanged apart from the value it sends", () => {
  it("the device app passes both signals to the shared resolver", () => {
    const app = code(read(DEVICE_APP));

    expect(app).toContain("isNativeShell: isCapacitorNativeShell()");
    expect(app).toContain("isWindowsShell: isWindowsShell()");
  });

  it("uses the same RPC, with no Windows-specific branch", () => {
    const rpc = code(read(RPC));

    expect(rpc).toContain("redeem_device_pairing_token");
    expect(rpc).toContain("p_platform: input.identity.platform");
    // No parallel endpoint, no platform-specific argument.
    expect(rpc).not.toContain("windows");
    expect(rpc).not.toContain("redeem_windows");
  });

  it("adds no Windows-specific RPC anywhere", () => {
    for (const file of [RPC, "lib/devicePairing.ts", "lib/devicePairing.server.ts"]) {
      const source = code(read(file));
      for (const banned of ["windows_device", "redeem_windows", "pair_windows"]) {
        expect(`${file}: ${source}`).not.toContain(banned);
      }
    }
  });

  it("requires no migration — the column already accepts any non-empty text", () => {
    // The only constraint is non-emptiness; there is no enum and no CHECK
    // listing platforms, so "windows" needs no schema change.
    const migration = read("supabase/migrations/20260803210000_device_pairing.sql");

    expect(migration).toContain("platform text");
    expect(migration).toContain("check (platform is null or btrim(platform) <> '')");
    expect(migration).not.toMatch(/platform\s+text\s+check\s*\(\s*platform\s+in\s*\(/);
    expect(migration).not.toContain("platform in ('android'");
  });

  it("no new migration was added for this feature", () => {
    // The only in ('android', ...) checks in this repo are on build_jobs.target,
    // an unrelated per-project concept.
    expect(existsSync(join(repoRoot, "supabase/migrations"))).toBe(true);

    const deviceMigrations = read(
      "supabase/migrations/20260803270000_artifact_and_device_immutability.sql"
    );
    expect(deviceMigrations).toContain(
      "paired_devices.platform cannot be changed after creation"
    );
  });
});

// ---------------------------------------------------------------------------
// Owner-facing formatting
// ---------------------------------------------------------------------------

describe("the owner device list reads Windows", () => {
  it("maps the three known platforms", () => {
    expect(formatDevicePlatform("android")).toBe("Android");
    expect(formatDevicePlatform("windows")).toBe("Windows");
    expect(formatDevicePlatform("web")).toBe("Web");
  });

  it("keeps the existing fallback convention for anything else", () => {
    expect(formatDevicePlatform(null)).toBe("Unknown platform");
    expect(formatDevicePlatform("   ")).toBe("Unknown platform");
    // An unrecognised non-empty value is shown as-is, unchanged from before.
    expect(formatDevicePlatform("ios")).toBe("ios");
    expect(formatDevicePlatform("linux")).toBe("linux");
  });

  it("says Windows, never Desktop", () => {
    // Feature 22 Phase 2 locked the customer vocabulary: the product word is
    // Windows. A guard already bans "Desktop" on customer-facing surfaces.
    expect(formatDevicePlatform("windows")).not.toContain("Desktop");
    expect(code(read("lib/devicePairing.owner.ts"))).not.toContain("Desktop");
  });
});

// ---------------------------------------------------------------------------
// The renderer-visible surface
// ---------------------------------------------------------------------------

describe("each document kind gets exactly one bridge", () => {
  const preload = code(read(PRELOAD));

  it("the hosted page receives the identity fact and nothing else", () => {
    const identityBranch = preload.slice(preload.indexOf("} else {"));

    expect(identityBranch).toContain("Object.freeze({ isWindowsShell: true })");
    expect(identityBranch).not.toContain("ipcRenderer");
    expect(identityBranch).not.toContain("posCanvasShell");
  });

  it("the fallback page keeps retry and gains no identity", () => {
    const retryBranch = preload.slice(
      preload.indexOf("if (isLocalFallbackPage) {"),
      preload.indexOf("} else {")
    );

    expect(retryBranch).toContain("pos-canvas-shell:retry");
    expect(retryBranch).not.toContain("posCanvasDesktop");
  });

  it("the two bridges are mutually exclusive branches", () => {
    // One `if/else`, so no document can ever receive both.
    expect(preload).toContain("if (isLocalFallbackPage) {");
    expect(preload).toContain("} else {");
    expect((preload.match(/exposeInMainWorld\(/g) ?? []).length).toBe(2);
  });

  it("exposes no Node, IPC, filesystem, shell, or environment access", () => {
    for (const banned of [
      "ipcRenderer.invoke",
      "require(\"fs\")",
      "require(\"path\")",
      "require(\"child_process\")",
      "require(\"os\")",
      "process.env",
      "process.platform",
      "shell.",
      "getPath",
      "userData",
      "app.getVersion",
      "__dirname",
    ]) {
      expect(`preload: ${preload}`).not.toContain(banned);
    }
  });

  it("hands the page no function on the identity bridge", () => {
    const identityBranch = preload.slice(preload.indexOf("} else {"));
    expect(identityBranch).not.toMatch(/:\s*\(\s*\)\s*=>/);
    expect(identityBranch).not.toContain("function");
  });
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

describe("Feature 23.3 stops where it was scoped to stop", () => {
  it("Windows is a published pre-release download", () => {
    const model = code(read("lib/platformDownloads.ts"));
    // Feature 23.6 — Windows is now a real download. The invariant that
    // survives: it is served by the shared model from one release object, and
    // it is labelled as an unsigned pre-release.
    expect(model).toContain("export function getWindowsDownload(");
    expect(model).toContain('status: "available"');
    expect(code(read("lib/windowsRelease.ts"))).toContain("isPrerelease: true");
  });

  it("adds no signing work", () => {
    // Feature 23.4 added the installer and its workflow deliberately; those are
    // asserted in lib/windowsInstaller.guards.test.ts. What 23.3 still fences
    // out is everything downstream of a built installer.
    // Feature 23.6 published the Windows pre-release, so "no release metadata"
    // is no longer the rule. What survives is the substantive current state:
    // the release exists, it is marked pre-release, and it is the ONLY Windows
    // release metadata in the repository.
    expect(code(read("lib/windowsRelease.ts"))).toContain(
      "export const CURRENT_WINDOWS_RELEASE: WindowsRelease | null = {"
    );
    expect(code(read("lib/windowsRelease.ts"))).toContain("isPrerelease: true");

    const shellPackage = read("windows-shell/package.json");
    for (const banned of ["certificateFile", "certificatePassword", "signtool"]) {
      expect(`package.json: ${shellPackage}`).not.toContain(banned);
    }
  });

  it("adds no fingerprinting, hardware id, or registry access", () => {
    for (const file of [PRELOAD, "windows-shell/main.mjs", DETECTOR]) {
      const source = code(read(file));
      for (const banned of [
        "machineId",
        "serialNumber",
        "macAddress",
        "registry",
        "winreg",
        "hostname",
        "networkInterfaces",
      ]) {
        expect(`${file}: ${source}`).not.toContain(banned);
      }
    }
  });

  it("leaves the root dependency tree untouched", () => {
    const rootPackage = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    for (const name of Object.keys({
      ...rootPackage.dependencies,
      ...rootPackage.devDependencies,
    })) {
      expect(name).not.toMatch(/^electron($|-)/);
      expect(name).not.toMatch(/^@electron\//);
    }
  });
});
