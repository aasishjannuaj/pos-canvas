// Feature 24.5F — the Windows shell is BOOTED, not merely read.
//
// WHY THIS FILE EXISTS. The first version of main.mjs called
// `protocol.registerSchemeAsPrivileged` — a function Electron does not have.
// It threw during module evaluation, so the packaged application could not
// start at all, and the installer shipped to hardware QA was dead on arrival.
//
// A structural guard had asserted the exact misspelling and passed. That is the
// whole lesson: a source-string assertion verifies that the file says what the
// author believed, never that the API exists. The same failure mode produced the
// PostgREST classifier bug in 24.5G — fixtures agreeing with the code instead of
// with reality — and the same answer applies. Run the real thing.
//
// So this spawns Electron twice:
//
//   1. the ACTUAL windows-shell app, asserting it does not die during load;
//   2. an offscreen window serving the REAL packaged runtime through the REAL
//      appProtocol.mjs, asserting the origin, the secure context, crypto.subtle,
//      IndexedDB and that DeviceApp genuinely mounted.
//
// SKIPPED, NOT FAILED, where Electron is unavailable — the root suite must stay
// runnable without the Windows shell's own node_modules installed. A skip says
// so loudly rather than passing quietly.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const shellDir = join(repoRoot, "windows-shell");
const electronBin = join(shellDir, "node_modules", ".bin", "electron");
const runtimeDir = join(shellDir, "runtime");

const electronAvailable = existsSync(electronBin);
const runtimeBuilt = existsSync(join(runtimeDir, "index.html"));
const canRun = electronAvailable && runtimeBuilt;

const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Runs an Electron app to completion and returns everything it printed. */
function runElectron(appPath: string, timeoutMs: number): string {
  try {
    return execFileSync(electronBin, [appPath, "--no-sandbox"], {
      cwd: shellDir,
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      // Electron writes Chromium noise to stderr; both streams are wanted.
    });
  } catch (error) {
    // A non-zero exit still carries the output that explains why.
    const shaped = error as { stdout?: string; stderr?: string };

    return `${shaped.stdout ?? ""}\n${shaped.stderr ?? ""}`;
  }
}

function writeApp(name: string, source: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pos-canvas-${name}-`));

  scratchDirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "main.mjs" }));
  writeFileSync(join(dir, "main.mjs"), source);

  return dir;
}

describe.skipIf(!canRun)("the Windows shell actually starts", () => {
  it("exposes the scheme API main.mjs calls, under its real name", () => {
    // The direct answer to the bug: assert against Electron's OWN export list,
    // not against a string in our source.
    const app = writeApp(
      "api",
      `import { app, protocol } from "electron";
       const names = Object.keys(protocol);
       console.log("API " + JSON.stringify({
         plural: typeof protocol.registerSchemesAsPrivileged,
         singular: typeof protocol.registerSchemeAsPrivileged,
         hasHandle: typeof protocol.handle,
         names: names.filter((n) => n.toLowerCase().includes("privileged")),
       }));
       app.quit();`
    );

    const output = runElectron(app, 60_000);
    const line = output.split("\n").find((l) => l.startsWith("API "));

    expect(line, `no API line in:\n${output.slice(0, 800)}`).toBeDefined();

    const api = JSON.parse(line!.slice(4));

    expect(api.plural).toBe("function");
    // The name the broken build used. Proving it does NOT exist is the point.
    expect(api.singular).toBe("undefined");
    expect(api.hasHandle).toBe("function");
    expect(api.names).toEqual(["registerSchemesAsPrivileged"]);
  }, 90_000);

  it("boots the real shell without a fatal load exception", () => {
    // The shell opens a window and stays up, so it is run with a short timeout
    // and judged on what it printed before being killed.
    const output = runElectron(shellDir, 15_000);

    expect(output).not.toContain("App threw an error during load");
    expect(output).not.toContain("is not a function");
    expect(output).not.toContain("Cannot find module");
    // Its own startup line proves it reached the ready handler and registered
    // the protocol rather than dying at module scope.
    expect(output).toContain("app://poscanvas/index.html");
  }, 60_000);

  it("serves the packaged runtime and mounts DeviceApp", () => {
    const app = writeApp(
      "mount",
      `import { app, BrowserWindow, net, protocol } from "electron";
       import { pathToFileURL } from "node:url";
       import { resolveAppAssetPath } from ${JSON.stringify(join(shellDir, "appProtocol.mjs"))};

       const ROOT = ${JSON.stringify(runtimeDir)};
       const served = [];

       protocol.registerSchemesAsPrivileged([
         { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
       ]);

       app.whenReady().then(async () => {
         protocol.handle("app", async (request) => {
           const p = resolveAppAssetPath(request.url, ROOT);
           if (p === null) { served.push([request.url, 404]); return new Response("Not found", { status: 404 }); }
           try {
             const r = await net.fetch(pathToFileURL(p).toString());
             served.push([request.url, r.status]);
             return r;
           } catch {
             served.push([request.url, "threw"]);
             return new Response("Not found", { status: 404 });
           }
         });

         const w = new BrowserWindow({
           show: false,
           webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
         });

         let failed = null;
         w.webContents.on("did-fail-load", (_e, code, desc, url, isMain) => {
           failed = { code, desc, url, isMain };
         });

         w.webContents.on("did-finish-load", async () => {
           const probe = await w.webContents.executeJavaScript(\`(() => ({
             origin: location.origin,
             secure: window.isSecureContext === true,
             subtle: typeof crypto?.subtle?.digest === "function",
             idb: typeof indexedDB !== "undefined",
             mounted: (document.getElementById("pos-canvas-device")?.children.length ?? -1),
           }))()\`).catch((e) => ({ error: String(e) }));

           console.log("MOUNT " + JSON.stringify({ ...probe, served, failed }));
           app.quit();
         });

         w.loadURL("app://poscanvas/index.html");
       });`
    );

    const output = runElectron(app, 60_000);
    const line = output.split("\n").find((l) => l.startsWith("MOUNT "));

    expect(line, `no MOUNT line in:\n${output.slice(0, 1200)}`).toBeDefined();

    const result = JSON.parse(line!.slice(6));

    // No navigation failure of any kind.
    expect(result.failed).toBeNull();

    // The approved permanent origin, and the two properties the offline cache
    // silently depends on.
    expect(result.origin).toBe("app://poscanvas");
    expect(result.secure).toBe(true);
    expect(result.subtle).toBe(true);
    expect(result.idb).toBe(true);

    // DeviceApp rendered. `mounted` is the child count of the React root.
    expect(result.mounted).toBeGreaterThan(0);

    // The document plus BOTH hashed assets, each a real 200. A single failed
    // asset would leave a blank window that still "finished loading".
    const urls: string[] = result.served.map((entry: [string, number]) => entry[0]);
    const statuses = new Map<string, number>(result.served);

    expect(urls.some((u) => u.endsWith("/index.html"))).toBe(true);
    expect(urls.some((u) => /\/assets\/.*\.js$/.test(u))).toBe(true);
    expect(urls.some((u) => /\/assets\/.*\.css$/.test(u))).toBe(true);

    for (const [url, status] of statuses) {
      expect(`${url} -> ${status}`).toBe(`${url} -> 200`);
    }
  }, 90_000);
});

describe.skipIf(canRun)("smoke test prerequisites", () => {
  it("reports why the Electron smoke test did not run", () => {
    // Visible rather than silent: a skipped boot test must announce itself.
    const reasons = [
      electronAvailable ? null : "electron is not installed in windows-shell/node_modules",
      runtimeBuilt ? null : "windows-shell/runtime is not built (npm run windows:runtime)",
    ].filter((reason) => reason !== null);

    console.warn(`[smoke] Windows startup smoke test skipped: ${reasons.join("; ")}`);
    expect(reasons.length).toBeGreaterThan(0);
  });
});
