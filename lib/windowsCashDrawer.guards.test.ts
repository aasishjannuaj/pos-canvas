// v1.3 Cash Drawer Checkpoint 1C — permanent source-level guards on the
// Windows cash drawer hardware bridge.
//
// The behaviour is tested in lib/windowsCashDrawerShell.test.ts (pure shell
// modules), lib/windowsCashDrawerSpooler.test.ts (the real koffi declarations)
// and lib/windowsCashDrawer.test.ts (the renderer adapter). These guards pin
// the SHAPE those tests cannot see: what crosses the preload, what the main
// process listens for, which files may touch koffi or the validated command,
// and where the bridge must never appear.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf-8");

/** Comments stripped, so explanatory prose never satisfies or trips a guard. */
const code = (source: string) =>
  source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/ .*$/gm, "");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".next", "build", "dist", "runtime", "www"].includes(entry)) continue;

    const path = join(dir, entry);

    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry)) out.push(path);
  }

  return out;
}

const isTest = (path: string) => /\.test\.tsx?$/.test(path);

const SHELL = "windows-shell";
const PRELOAD = join(SHELL, "preload.js");
const MAIN = join(SHELL, "main.mjs");
const PROFILES = join(SHELL, "cashDrawerProfiles.mjs");
const RAW = join(SHELL, "cashDrawerRaw.mjs");
const IPC = join(SHELL, "cashDrawerIpc.mjs");
const SPOOLER = join(SHELL, "win32Spooler.mjs");
const ADAPTER = join("lib", "windowsCashDrawer.ts");
const CHANNEL = "pos-canvas-shell:open-cash-drawer";

const appFiles = ["lib", "components", "app"].flatMap((root) => walk(root)).filter((f) => !isTest(f));
const shellFiles = walk(SHELL).filter((f) => !isTest(f));
const everyProductionFile = [
  ...appFiles,
  ...shellFiles,
  ...walk("native-device").filter((f) => !isTest(f)),
  ...walk("android-shell").filter((f) => !isTest(f)),
];

// ---------------------------------------------------------------------------
// The preload: one argument-less function, only for app://poscanvas
// ---------------------------------------------------------------------------

describe("the preload exposes openCashDrawer() and nothing else, to the packaged runtime only", () => {
  const preload = code(read(PRELOAD));
  const block = preload.slice(preload.indexOf("const isPackagedRuntime"));

  it("is gated on exactly app://poscanvas, separately from the identity and retry branches", () => {
    expect(preload).toContain(
      'const isPackagedRuntime =\n  window.location.protocol === "app:" && window.location.host === "poscanvas";'
    );
    expect(block).toContain("if (isPackagedRuntime) {");
    expect(preload.indexOf("const isPackagedRuntime")).toBeGreaterThan(preload.lastIndexOf('"posCanvasDesktop"'));
  });

  it("is a separate frozen global holding one zero-parameter function that invokes one channel with no arguments", () => {
    expect(block).toContain(
      'contextBridge.exposeInMainWorld(\n    "posCanvasCashDrawer",\n    Object.freeze({\n      openCashDrawer: () => ipcRenderer.invoke("' +
        CHANNEL +
        '"),\n    })\n  );'
    );
    expect(preload.match(/posCanvasCashDrawer/g) ?? []).toHaveLength(1);
    expect(preload.match(/ipcRenderer\.invoke\(/g) ?? []).toHaveLength(1);
    expect(preload).not.toMatch(/invoke\([^)]*,[^)]*\)/);
    expect(preload).not.toMatch(/openCashDrawer:\s*\([^)]/);
  });

  it("the identity fact is untouched: still one frozen boolean, no function, no IPC", () => {
    const identity = preload.slice(preload.indexOf("} else {"), preload.indexOf("const isPackagedRuntime"));

    expect(identity).toContain("Object.freeze({ isWindowsShell: true })");
    expect(identity).not.toContain("ipcRenderer");
    expect(identity).not.toContain("posCanvasCashDrawer");
  });

  it("the drawer bridge is never in the local-page (splash/offline) branch", () => {
    const local = preload.slice(preload.indexOf("if (isLocalPage) {"), preload.indexOf("} else {"));

    expect(local).not.toMatch(/drawer|invoke/i);
  });

  it("the preload names no hardware vocabulary", () => {
    for (const banned of ["printer", "bytes", "Buffer", "Uint8Array", "queue", "pulse", "escpos", "koffi", "winspool", "saleRequestId", "0x1b"]) {
      expect(`preload: ${banned}`).toBe(`preload: ${banned}`);
      expect(preload.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  it("uses the channel the main process listens on", () => {
    expect(code(read(IPC))).toContain(`export const CASH_DRAWER_CHANNEL = "${CHANNEL}";`);
  });
});

// ---------------------------------------------------------------------------
// The main process: one handle, event only, fully validated
// ---------------------------------------------------------------------------

describe("the main process listens for no payload and validates every request", () => {
  const main = code(read(MAIN));

  it("registers exactly one ipcMain.handle, taking only the event", () => {
    expect(main.match(/ipcMain\.handle\(/g) ?? []).toHaveLength(1);
    expect(main).toContain("ipcMain.handle(CASH_DRAWER_CHANNEL, (event) => handleOpenCashDrawer(event));");
    expect(main).not.toMatch(/ipcMain\.handle\(CASH_DRAWER_CHANNEL,\s*\([^)]*,[^)]*\)/);
  });

  it("the shell has exactly two IPC channels: retry and the drawer — no general print or RAW channel", () => {
    const listeners = main.match(/ipcMain\.(on|handle|once|handleOnce)\(/g) ?? [];

    expect(listeners).toHaveLength(2);

    // Every channel name anywhere in the shell is one of exactly these two.
    const channels = new Set(
      shellFiles.flatMap((file) => [...code(read(file)).matchAll(/["'`](pos-canvas-shell:[^"'`]*)["'`]/g)].map((m) => m[1]))
    );

    expect([...channels].sort()).toEqual([CHANNEL, "pos-canvas-shell:retry"].sort());
  });

  it("trust is decided from the frame, the main frame, the window and the platform", () => {
    const wiring = main.slice(main.indexOf("const handleOpenCashDrawer"), main.indexOf("ipcMain.handle(CASH_DRAWER_CHANNEL"));

    for (const piece of [
      "senderFrame: event.senderFrame,",
      "mainFrame: event.sender.mainFrame,",
      "senderWindowId: BrowserWindow.fromWebContents(event.sender)?.id ?? null,",
      "shellWindowIds,",
      "platform: process.platform,",
    ]) {
      expect(wiring).toContain(piece);
    }

    expect(main).toContain("shellWindowIds.add(windowId);");
    expect(main).toContain("shellWindowIds.delete(windowId);");
  });

  it("enumerates with Electron's getPrintersAsync and uses only the names", () => {
    expect(main).toContain("(await event.sender.getPrintersAsync()).map((printer) => printer.name)");
  });

  it("loads the native spooler lazily and never imports koffi itself", () => {
    expect(main).toContain('loadSpooler: () => import("./win32Spooler.mjs").then((module) => module.loadWin32Spooler()),');
    expect(main).not.toMatch(/^import[^;]*win32Spooler/m);
    expect(main).not.toContain("koffi");
  });

  it("isTrustedCashDrawerSender checks all five conditions", () => {
    const ipc = code(read(IPC));
    const trust = ipc.slice(ipc.indexOf("export function isTrustedCashDrawerSender"), ipc.indexOf("export function createOpenCashDrawerHandler"));

    expect(trust).toContain('platform !== "win32"');
    expect(trust).toContain("senderFrame !== mainFrame");
    expect(trust).toContain("isAppRuntimeUrl(senderFrame.url)");
    expect(trust).toContain("shellWindowIds.has(senderWindowId)");
  });

  it("the handler takes only the event, and checks trust before anything else", () => {
    const ipc = code(read(IPC));
    const handler = ipc.slice(ipc.indexOf("return function handleOpenCashDrawer"));

    expect(handler).toContain("return function handleOpenCashDrawer(event) {");
    expect(handler.indexOf("isTrusted(event)")).toBeLessThan(handler.indexOf("attemptOnce(event)"));
    expect(handler).toContain('return Promise.resolve("unavailable");');
  });
});

// ---------------------------------------------------------------------------
// koffi, Win32 and the validated command are each in one place
// ---------------------------------------------------------------------------

describe("native code and the command are confined", () => {
  it("koffi is imported only by win32Spooler.mjs, lazily, after the platform check", () => {
    const importers = everyProductionFile.filter((f) => /["']koffi["']/.test(code(read(f))));

    expect(importers).toEqual([SPOOLER]);

    const spooler = code(read(SPOOLER));
    const load = spooler.slice(spooler.indexOf("export async function loadWin32Spooler"));

    expect(spooler).not.toMatch(/^import[^;]*koffi/m);
    expect(load.indexOf('process.platform !== "win32" || process.arch !== "x64"')).toBeLessThan(
      load.indexOf('await import("koffi")')
    );
    expect(load).toContain('koffi.load("winspool.drv")');
  });

  it("binds exactly the eight RAW-job spooler functions, all as async calls — no enumeration or configuration API", () => {
    const spooler = code(read(SPOOLER));
    const bound = [...spooler.matchAll(/lib\.func\("__stdcall", "(\w+)"/g)].map((m) => m[1]).sort();

    expect(bound).toEqual(
      [
        "AbortPrinter",
        "ClosePrinter",
        "EndDocPrinter",
        "EndPagePrinter",
        "OpenPrinterW",
        "StartDocPrinterW",
        "StartPagePrinter",
        "WritePrinter",
      ].sort()
    );
    expect(spooler).toContain("fn.async(...args,");
    expect(spooler).not.toMatch(/EnumPrinters|GetPrinter|SetPrinter|AddJob|ScheduleJob|DocumentProperties|GetDefaultPrinter/);
    expect(spooler).not.toMatch(/"bool"/);
  });

  it("the validated queue name lives only in the profile", () => {
    for (const file of everyProductionFile) {
      const hits = code(read(file)).split("EPSON TM-T20 ReceiptE4").length - 1;

      expect(`${file}: ${hits}`).toBe(`${file}: ${file === PROFILES ? 1 : 0}`);
    }
  });

  it("the profile is the validated bytes, RAW, frozen, exact-match only", () => {
    const profiles = code(read(PROFILES));

    expect(profiles).toContain("command: Object.freeze([0x1b, 0x70, 0x00, 0x02, 0x14]),");
    expect(profiles).toContain('datatype: "RAW",');
    expect(profiles).toContain("normalizeQueueName(profile.queueName) === normalized");
    expect(profiles).not.toMatch(/startsWith|endsWith|includes\(|indexOf|search\(|RegExp|\.test\(|match\(/);
  });
});

// ---------------------------------------------------------------------------
// Exactly one write, no retry, no re-kick
// ---------------------------------------------------------------------------

describe("the command is never sent twice", () => {
  it("cashDrawerRaw calls write exactly once and has no loop, timer or retry", () => {
    const raw = code(read(RAW));

    expect(raw.match(/spooler\.write\(/g) ?? []).toHaveLength(1);
    expect(raw.match(/spooler\.open\(/g) ?? []).toHaveLength(1);
    expect(raw).toContain("written.written !== bytes.length");
    expect(raw).toContain("bytes.length !== 5");

    for (const file of [RAW, IPC, SPOOLER, ADAPTER]) {
      const source = code(read(file));

      expect(`${file}: loop`).toBe(`${file}: loop`);
      expect(source).not.toMatch(/\bfor\s*\(|\bwhile\s*\(|setInterval|\bretry\b|\brekick\b/i);
    }
  });

  it("a partial or failed write aborts, never writes again", () => {
    const raw = code(read(RAW));
    const afterWrite = raw.slice(raw.indexOf("spooler.write("));

    expect(afterWrite).toContain("await attempt(() => spooler.abort(handle), false);");
    expect(afterWrite).toContain('status = "unknown";');
  });

  it("the adapter calls the bridge once, with no arguments, and never with the sale id", () => {
    const adapter = code(read(ADAPTER));

    expect(adapter.match(/openCashDrawer\(\)/g) ?? []).toHaveLength(1);
    expect(adapter).not.toMatch(/openCashDrawer\([^)]/);
    expect(adapter).not.toContain("saleRequestId");
    expect(adapter).toContain("export const CASH_DRAWER_BRIDGE_TIMEOUT_MS = 10_000;");
  });
});

// ---------------------------------------------------------------------------
// Where the bridge must never appear
// ---------------------------------------------------------------------------

describe("the bridge appears only where it belongs", () => {
  const TOKENS = ["posCanvasCashDrawer", "openCashDrawer", "windowsCashDrawer", "resolveCashDrawerCapability", "koffi"];

  it("lib/windowsCashDrawer.ts is the only renderer reader of the bridge, and DeviceApp its only importer", () => {
    const readers = appFiles.filter((f) => code(read(f)).includes("posCanvasCashDrawer"));
    const importers = appFiles.filter((f) => code(read(f)).includes('from "@/lib/windowsCashDrawer"'));

    expect(readers).toEqual([ADAPTER]);
    expect(importers).toEqual([join("components", "device", "DeviceApp.tsx")]);
  });

  it("Android, templates, Retail, the Builder, the owner runtime, sync and reprint carry none of it", () => {
    const excluded = [
      ...walk("native-device"),
      ...walk("android-shell"),
      ...walk(join("components", "editor")),
      join("lib", "nativeShell.ts"),
      join("lib", "posLayout.ts"),
      join("lib", "projectConfig.ts"),
      join("components", "runtime", "OwnerPosRuntime.tsx"),
      join("components", "runtime", "PosRuntime.tsx"),
      join("components", "runtime", "SalesHistoryScreen.tsx"),
      join("components", "runtime", "SalesHistoryDetail.tsx"),
      join("components", "runtime", "PosCheckoutPanel.tsx"),
      join("lib", "saleSyncEngine.ts"),
      join("lib", "offlineSaleRpc.ts"),
      join("lib", "saleQueueSession.ts"),
    ].filter((f) => !isTest(f));

    expect(excluded).toContain(join("components", "editor", "pos-layouts", "RetailStoreBrowser.tsx"));

    for (const file of excluded) {
      const source = read(file);

      for (const token of TOKENS) {
        expect(`${file}: ${token}`).toBe(`${file}: ${token}`);
        expect(source).not.toContain(token);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The dependency
// ---------------------------------------------------------------------------

describe("koffi is pinned, Windows-shell only, and packaged outside the asar", () => {
  const shellPackage = JSON.parse(read(join(SHELL, "package.json")));
  const lock = JSON.parse(read(join(SHELL, "package-lock.json")));

  it("is exactly 3.3.2 under windows-shell dependencies, and nowhere in the root project", () => {
    expect(shellPackage.dependencies).toEqual({ koffi: "3.3.2" });

    const root = JSON.parse(read("package.json"));

    expect(JSON.stringify(root)).not.toContain("koffi");
  });

  it("the lockfile pins koffi and its Windows x64 binary package by integrity", () => {
    for (const name of ["node_modules/koffi", "node_modules/@koromix/koffi-win32-x64"]) {
      expect(lock.packages[name]?.version).toBe("3.3.2");
      expect(lock.packages[name]?.integrity).toMatch(/^sha512-/);
    }
  });

  it("the installer unpacks koffi, ships the four bridge modules, and stays x64", () => {
    expect(shellPackage.build.asarUnpack).toEqual([
      "node_modules/koffi/**",
      "node_modules/@koromix/koffi-win32-x64/**",
    ]);

    for (const file of ["cashDrawerProfiles.mjs", "cashDrawerRaw.mjs", "cashDrawerIpc.mjs", "win32Spooler.mjs"]) {
      expect(shellPackage.build.files).toContain(file);
    }

    expect(shellPackage.build.win.target).toEqual([{ target: "nsis", arch: ["x64"] }]);
  });

  it("CI asserts the packaged native binary and version", () => {
    const workflow = read(join(".github", "workflows", "windows-app.yml"));

    expect(workflow).toContain("- name: Verify the cash drawer native module is packaged");
    expect(workflow).toContain('dist/win-unpacked/resources/app.asar.unpacked/node_modules');
    expect(workflow).toContain('"$unpacked/@koromix/koffi-win32-x64"');
    expect(workflow).toContain('if ($koffiVersion -ne "3.3.2")');
  });
});
