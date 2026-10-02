// v1.3 Cash Drawer Checkpoint 1A — permanent source-level guards.
//
// lib/cashDrawer.test.ts proves the rules and the atomic claim against a real
// IndexedDB engine. What it cannot prove is WHERE the coordinator is reached
// from, because this repository deliberately has no React Testing Library:
// PosRuntime and DeviceApp are asserted at the source level here, the way
// lib/offlineReadOnly.guards.test.ts and PosRuntime.layout.test.ts already do.
//
// THE PROPERTIES:
//   * PosRuntime reports a completed sale from exactly two places — after the
//     online receipt + success lock, and after the offline durable save — and
//     from nowhere earlier.
//   * Only DeviceApp wires the coordinator. The owner runtime, the Builder,
//     sync, Sales History, print/reprint, templates and Retail cannot reach it.
//   * The shared boundary carries no hardware parameter, and 1A contacts no
//     hardware: no IPC, no printer, no drawer command bytes.
//   * The claim is a single atomic `add`, never a read-then-write.
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

const POS_RUNTIME = "components/runtime/PosRuntime.tsx";
const DEVICE_APP = "components/device/DeviceApp.tsx";
const STORE = "lib/deviceOfflineStore.ts";
const DRAWER = "lib/cashDrawer.ts";
const DRAWER_SESSION = "lib/cashDrawerSession.ts";

/** The identifiers by which anything could reach the automatic drawer path. */
const DRAWER_TOKENS = [
  "cashDrawer",
  "CashDrawer",
  "DrawerEvent",
  "runAutomaticDrawerEvent",
  "claimAutomaticDrawerEvent",
  "onSaleCompleted",
  "reportSaleCompleted",
  "DRAWER_EVENT_STORE",
  "drawer-events",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "build" || entry === "dist") continue;

    const path = join(dir, entry);

    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry)) out.push(path);
  }

  return out;
}

const isTest = (path: string) => /\.test\.tsx?$/.test(path);

const productionFiles = ["lib", "components", "app"].flatMap((root) => walk(root)).filter((f) => !isTest(f));

/** The body of the named function, from its declaration to the next top-level-ish function. */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);

  expect(start, `${signature} not found`).toBeGreaterThanOrEqual(0);

  // Up to the next declaration at the same indentation (two spaces in a
  // component, column 0 in a module).
  const indent = source.slice(source.lastIndexOf("\n", start) + 1, start);
  const rest = source.slice(start + signature.length);
  const next = rest.search(new RegExp(`\\n${indent}(?:async )?function |\\n${indent}const |\\n${indent}export `));

  return next === -1 ? rest : rest.slice(0, next);
}

// ---------------------------------------------------------------------------
// The two completion points in PosRuntime
// ---------------------------------------------------------------------------

describe("PosRuntime reports a sale only after it has succeeded", () => {
  const runtime = code(read(POS_RUNTIME));
  const completeSale = functionBody(runtime, "async function completeSale() {");

  it("the host is told only through reportSaleCompleted, which never lets a throw reach the sale", () => {
    expect(runtime.match(/onSaleCompleted\(/g) ?? []).toHaveLength(1);

    const report = functionBody(runtime, "function reportSaleCompleted(");

    expect(report).toContain("if (onSaleCompleted === null)");
    expect(report).toMatch(/try \{\s*onSaleCompleted\(\{ saleRequestId, paymentMethod \}\);\s*\} catch/);
  });

  it("exactly two completion points, both inside completeSale", () => {
    expect(runtime.match(/reportSaleCompleted\(/g) ?? []).toHaveLength(3); // definition + 2 calls
    expect(completeSale.match(/reportSaleCompleted\(/g) ?? []).toHaveLength(2);
  });

  it("OFFLINE: only after the durable save answered ok, never before it", () => {
    const enqueue = completeSale.indexOf("await queueOfflineSale(");
    const failed = completeSale.indexOf("if (!saved.ok) {");
    const failedReturn = completeSale.indexOf("return;", failed);
    const call = completeSale.indexOf("reportSaleCompleted(saved.saleRequestId, selectedPaymentMethod);");
    const success = completeSale.indexOf('setSaleSaveStatus("success");', failedReturn);

    expect(enqueue).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(enqueue);
    expect(call).toBeGreaterThan(failedReturn);
    expect(call).toBeGreaterThan(success);

    // Not gated on the paper copy: a saved sale with no drawable receipt is
    // still a completed sale.
    const offlineTail = completeSale.slice(failedReturn, call);
    expect(offlineTail).not.toMatch(/if \(saved\.receipt/);
  });

  it("ONLINE: only after the authoritative receipt and the success lock", () => {
    const offlineEnd = completeSale.indexOf("reportSaleCompleted(saved.saleRequestId");
    const online = completeSale.slice(offlineEnd + 1);

    const arm = online.indexOf("await armOnlineSale(");
    const dispatch = online.indexOf("await submitSale(");
    const rejected = online.indexOf("if (error || !receipt) {");
    const rejectedReturn = online.indexOf("return;", online.indexOf("onSaleRejected?.("));
    const lock = online.indexOf('setCheckoutStatus("success");');
    const call = online.indexOf("reportSaleCompleted(plan.request.id, receipt.paymentMethod);");
    const refresh = online.indexOf("await refreshStock(");

    for (const point of [arm, dispatch, rejected, rejectedReturn, lock, call, refresh]) {
      expect(point).toBeGreaterThan(-1);
    }

    expect(call).toBeGreaterThan(arm);
    expect(call).toBeGreaterThan(dispatch);
    expect(call).toBeGreaterThan(rejectedReturn);
    expect(call).toBeGreaterThan(lock);
    // Before the stock refresh, whose failure is not a failed sale.
    expect(call).toBeLessThan(refresh);
  });

  it("nothing before the success boundary reports: selection, the fences, planning, arming, dispatch, rejection", () => {
    const beforeOffline = completeSale.slice(0, completeSale.indexOf("if (!saved.ok) {"));

    expect(beforeOffline).not.toContain("reportSaleCompleted");

    const offlineEnd = completeSale.indexOf("reportSaleCompleted(saved.saleRequestId");
    const online = completeSale.slice(offlineEnd + 1);
    const beforeLock = online.slice(0, online.indexOf('setCheckoutStatus("success");'));

    expect(beforeLock).not.toContain("reportSaleCompleted");

    for (const signature of [
      "function selectPaymentMethod(",
      "function openReceipt(",
      "function closeReceipt(",
    ]) {
      expect(functionBody(runtime, signature)).not.toContain("reportSaleCompleted");
    }
  });

  it("the identity reported is the saleRequestId on both paths", () => {
    expect(completeSale).toContain("reportSaleCompleted(saved.saleRequestId,");
    expect(completeSale).toContain("reportSaleCompleted(plan.request.id,");
  });

  it("PosRuntime itself knows nothing about drawers", () => {
    for (const banned of ["cashDrawer", "runAutomaticDrawerEvent", "claimAutomaticDrawerEvent", "indexedDB"]) {
      expect(runtime).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// Host boundary
// ---------------------------------------------------------------------------

describe("only the real DeviceApp runtime wires the coordinator", () => {
  it("DeviceApp is the only host passing onSaleCompleted", () => {
    const passing = productionFiles.filter((f) => code(read(f)).includes("onSaleCompleted="));

    expect(passing).toEqual([DEVICE_APP]);
  });

  it("the coordinator and the claim are imported by DeviceApp alone", () => {
    const importers = productionFiles.filter((f) => {
      const source = code(read(f));

      return source.includes('from "@/lib/cashDrawer"') || source.includes('from "@/lib/cashDrawerSession"');
    });

    // SUPERSEDED BY Cash Drawer 1C: lib/windowsCashDrawer.ts — the renderer
    // adapter for the Windows hardware bridge — imports the capability types
    // and the no-op. It in turn is imported by DeviceApp alone, so the
    // coordinator is still reachable only from the one wiring point.
    expect(importers.sort()).toEqual([DEVICE_APP, DRAWER_SESSION, "lib/windowsCashDrawer.ts"].sort());

    const adapterImporters = productionFiles.filter((f) =>
      code(read(f)).includes('from "@/lib/windowsCashDrawer"')
    );

    expect(adapterImporters).toEqual([DEVICE_APP]);
  });

  it("DeviceApp's handler is wired once, to PosRuntime, with the 1A no-op capability", () => {
    const app = code(read(DEVICE_APP));

    expect(app.match(/handleSaleCompleted/g) ?? []).toHaveLength(2);
    expect(app).toContain("onSaleCompleted={handleSaleCompleted}");

    const handler = app.slice(app.indexOf("const handleSaleCompleted"), app.indexOf("const handleSaleRejected"));

    expect(handler).toContain("runAutomaticDrawerEvent(");
    expect(handler).toContain("claim: claimAutomaticDrawerEvent");
    // SUPERSEDED BY Cash Drawer 1C: the 1A no-op is replaced by the RESOLVED
    // capability — the Windows bridge where the shell exposes one, the no-op
    // everywhere else. Still passed only to the coordinator, which calls it
    // only after cash, live Windows, the owner setting and the durable claim;
    // the handler itself never opens anything.
    expect(handler).toContain("capability: resolveCashDrawerCapability(),");
    expect(handler).not.toMatch(/requestOpen\(|openCashDrawer\(|posCanvasCashDrawer/);
    // SUPERSEDED BY Cash Drawer 1B. 1A pinned the wiring to the locked-off
    // AUTO_OPEN_CASH_DRAWER_DEFAULT because no authoritative setting existed.
    // 1B supplies it: the owner's per-device value on the pairing the till is
    // running under, through the EXISTING readyPairingRef. The surviving
    // properties: exactly that expression, no literal true anywhere in the
    // wiring, and the locked default itself still off.
    expect(handler).toContain("autoOpenEnabled: readyPairingRef.current?.cashDrawerEnabled === true,");
    expect(handler.match(/autoOpenEnabled:/g) ?? []).toHaveLength(1);
    expect(handler).not.toMatch(/autoOpenEnabled:\s*true/);
    expect(handler).not.toMatch(/cashDrawerEnabled\s*(?:\?\?|\|\|)\s*true/);
    expect(code(read(DRAWER))).toContain("export const AUTO_OPEN_CASH_DRAWER_DEFAULT = false;");
    expect(handler).toContain("isNativeShell: isCapacitorNativeShell()");
    expect(handler).toContain("isWindowsShell: isWindowsShell()");
  });

  it("the owner runtime and the Builder never reach it", () => {
    for (const file of ["components/runtime/OwnerPosRuntime.tsx", "components/editor/EditorShell.tsx"]) {
      const source = code(read(file));

      for (const token of DRAWER_TOKENS) {
        expect(`${file}: ${token}`).toBe(`${file}: ${token}`);
        expect(source).not.toContain(token);
      }
    }
  });

  it("sync, Sales History, receipts and print/reprint never reach it", () => {
    for (const file of [
      "lib/saleSyncEngine.ts",
      "lib/offlineSaleRpc.ts",
      "lib/saleQueueSession.ts",
      "lib/saleSyncClassifier.ts",
      "lib/offlineCheckoutSession.ts",
      "lib/uncertainSaleSession.ts",
      "components/device/DeviceSyncStatus.tsx",
      "components/device/RejectedSaleReview.tsx",
      "components/runtime/SalesHistoryScreen.tsx",
      "components/runtime/SalesHistoryDetail.tsx",
      "components/runtime/AuthoritativeReceipt.tsx",
      "components/runtime/OfflineReceipt.tsx",
      "components/runtime/PosCheckoutPanel.tsx",
      "components/editor/Receipt.tsx",
    ]) {
      const source = code(read(file));

      for (const token of DRAWER_TOKENS) {
        expect(`${file}: ${token}`).toBe(`${file}: ${token}`);
        expect(source).not.toContain(token);
      }
    }
  });

  it("every file that prints holds no drawer path, so printing neither requires nor creates an event", () => {
    const printers = productionFiles.filter((f) => code(read(f)).includes("window.print("));

    expect(printers.length).toBeGreaterThan(0);

    for (const file of printers) {
      const source = code(read(file));

      for (const token of DRAWER_TOKENS) {
        expect(`${file}: ${token}`).toBe(`${file}: ${token}`);
        expect(source).not.toContain(token);
      }
    }
  });

  it("the coordinator takes no receipt: an event exists whether or not anything prints", () => {
    const drawer = code(read(DRAWER));
    const event = drawer.slice(drawer.indexOf("export type CashDrawerSaleEvent"), drawer.indexOf("};", drawer.indexOf("export type CashDrawerSaleEvent")));

    expect(event).toContain("saleRequestId: string;");
    expect(event).toContain("paymentMethod: PaymentMethod;");
    expect(event).not.toMatch(/receipt|print/i);
  });
});

describe("templates and Retail carry no drawer implementation", () => {
  const templateFiles = [
    ...walk("components/editor/pos-layouts").filter((f) => !isTest(f)),
    "lib/posLayout.ts",
    "lib/projectConfig.ts",
    "lib/projectFeatures.ts",
    "lib/generatedPosConfig.ts",
    "components/landing/Templates.tsx",
  ];

  it("no template or layout file references the drawer path", () => {
    expect(templateFiles).toContain("components/editor/pos-layouts/RetailStoreBrowser.tsx");

    for (const file of templateFiles) {
      const source = read(file);

      for (const token of [...DRAWER_TOKENS, "openDrawer", "kickDrawer"]) {
        expect(`${file}: ${token}`).toBe(`${file}: ${token}`);
        expect(source).not.toContain(token);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Eligibility, platform and hardware boundary
// ---------------------------------------------------------------------------

describe("eligibility is cash only and the platform is Windows only", () => {
  const drawer = code(read(DRAWER));

  it("card is never eligible", () => {
    expect(functionBody(drawer, "export function isAutomaticDrawerEligible(")).toMatch(
      /^paymentMethod: PaymentMethod\): boolean \{\s*return paymentMethod === "cash";\s*\}/
    );
  });

  it("Android cannot activate the automatic path", () => {
    expect(functionBody(drawer, "export function isAutomaticDrawerPlatform(")).toMatch(
      /^platform: DevicePlatform\): boolean \{\s*return platform === "windows";\s*\}/
    );
  });

  it("the coordinator checks cash, then Windows, then enablement BEFORE the claim, and the claim BEFORE the capability", () => {
    // CORRECTED IN 1A: the locked order is cash -> windows -> enabled -> claim
    // -> capability. A disabled device must return before the ledger.
    const run = functionBody(drawer, "export async function runAutomaticDrawerEvent(");
    const eligible = run.indexOf("isAutomaticDrawerEligible(event.paymentMethod)");
    const platform = run.indexOf("isAutomaticDrawerPlatform(platform)");
    const enabled = run.indexOf("if (autoOpenEnabled !== true) {");
    const claim = run.indexOf("await claim(event.saleRequestId)");
    const notClaimed = run.indexOf('if (claimed !== "claimed")');
    const capability = run.indexOf("capability.requestOpen(");

    expect(eligible).toBeGreaterThan(-1);
    expect(platform).toBeGreaterThan(eligible);
    expect(enabled).toBeGreaterThan(platform);
    expect(claim).toBeGreaterThan(enabled);
    expect(run.match(/autoOpenEnabled !== true/g) ?? []).toHaveLength(1);
    // Configuration and hardware availability are separate questions.
    expect(run).not.toContain("capability.available");
    expect(notClaimed).toBeGreaterThan(claim);
    expect(capability).toBeGreaterThan(notClaimed);
    // Asked once. No loop, no retry, no timer.
    expect(run.match(/requestOpen\(/g) ?? []).toHaveLength(1);
    expect(run).not.toMatch(/\bfor\s*\(|\bwhile\s*\(|setTimeout|setInterval|retry/i);
  });

  it("no Android-shell or native-device source references the drawer path", () => {
    const androidSources = [
      ...walk("native-device"),
      ...walk("android-shell"),
      "lib/nativeShell.ts",
    ].filter((f) => !isTest(f));

    for (const file of androidSources) {
      const source = read(file);

      for (const token of DRAWER_TOKENS) {
        expect(`${file}: ${token}`).toBe(`${file}: ${token}`);
        expect(source).not.toContain(token);
      }
    }
  });
});

describe("the shared boundary carries no hardware parameter and 1A contacts no hardware", () => {
  const drawer = code(read(DRAWER));
  const capabilityType = drawer.slice(
    drawer.indexOf("export type CashDrawerCapability = {"),
    drawer.indexOf("};", drawer.indexOf("export type CashDrawerCapability = {")) + 2
  );

  it("the capability is exactly { available, requestOpen({ saleRequestId }) }", () => {
    expect(capabilityType).toBe(
      [
        "export type CashDrawerCapability = {",
        "  readonly available: boolean;",
        "  requestOpen(event: { readonly saleRequestId: string }): Promise<CashDrawerOpenOutcome>;",
        "};",
      ].join("\n")
    );

    for (const banned of ["printer", "path", "bytes", "byte", "escpos", "channel", "pulse", "transport", "command", "port", "Uint8Array", "Buffer"]) {
      expect(`capability: ${banned}`).toBe(`capability: ${banned}`);
      expect(capabilityType).not.toMatch(new RegExp(`\\b${banned}\\b`, "i"));
    }
  });

  it("the drawer modules reach no IPC, shell, printer or OS API", () => {
    for (const file of [DRAWER, DRAWER_SESSION]) {
      const source = code(read(file));

      for (const banned of [
        "electron",
        "ipcRenderer",
        "posCanvasDesktop",
        "koffi",
        "powershell",
        "child_process",
        "window.",
        "fetch(",
        "rpc(",
        "supabase",
        "0x1b",
        "\\x1b",
        "\\u001b",
        "escpos",
        "localStorage",
        "indexedDB.open",
      ]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source.toLowerCase()).not.toContain(banned.toLowerCase());
      }
    }
  });

  it("the drawer kick sequence appears nowhere in production code", () => {
    // Assembled here so this file does not itself contain the sequence.
    const spaced = ["1B", "70", "00", "02", "14"].join(" ");
    const hexArray = ["0x1b", "0x70", "0x00", "0x02", "0x14"].join(", ");
    const sources = [
      ...productionFiles,
      ...walk("windows-shell").filter((f) => !isTest(f)),
      ...walk("native-device").filter((f) => !isTest(f)),
    ];

    // SUPERSEDED BY Cash Drawer 1C: the validated command now exists in
    // production — exactly ONCE, as data in the one validated profile, inside
    // the Windows shell's main-process hardware layer. Nowhere else: not the
    // renderer, not the shared runtime, not Android, not any other shell file.
    const PROFILE_FILE = join("windows-shell", "cashDrawerProfiles.mjs");

    expect(sources).toContain(PROFILE_FILE);

    for (const file of sources) {
      const source = read(file).toLowerCase();
      const hexCount = source.split(hexArray).length - 1;

      expect(`${file}: kick`).toBe(`${file}: kick`);
      expect(source).not.toContain(spaced.toLowerCase());
      expect(`${file}: ${hexCount}`).toBe(`${file}: ${file === PROFILE_FILE ? 1 : 0}`);
    }
  });

  it("the Windows shell's drawer code lives only in the designated 1C modules", () => {
    // SUPERSEDED BY Cash Drawer 1C, which adds the authorized hardware bridge.
    // The surviving property: drawer code exists only in these files, and the
    // shell's other modules (protocol, navigation, server URL) know nothing of it.
    const allowed = new Set(
      [
        "main.mjs",
        "preload.js",
        "cashDrawerProfiles.mjs",
        "cashDrawerRaw.mjs",
        "cashDrawerIpc.mjs",
        "win32Spooler.mjs",
      ].map((f) => join("windows-shell", f))
    );

    for (const file of walk("windows-shell").filter((f) => !isTest(f))) {
      const source = read(file);

      expect(`${file}: drawer`).toBe(`${file}: drawer`);

      if (!allowed.has(file)) {
        expect(source.toLowerCase()).not.toContain("drawer");
      }
    }
  });

  it("1A's only capability is the no-op, and it contacts nothing", () => {
    const capability = drawer.slice(drawer.indexOf("export const UNAVAILABLE_CASH_DRAWER"));
    const body = capability.slice(0, capability.indexOf("});") + 3);

    expect(body).toContain("available: false,");
    expect(body).toContain('requestOpen: async () => "unavailable" as const,');
  });
});

// ---------------------------------------------------------------------------
// The atomic, durable claim
// ---------------------------------------------------------------------------

describe("the claim is one atomic insert in the existing database", () => {
  const store = code(read(STORE));

  it("the ledger is a third store in the same database, keyed by saleRequestId", () => {
    expect(store).toContain('export const OFFLINE_DB_NAME = "pos-canvas-device"');
    expect(store).toContain("export const OFFLINE_DB_VERSION = 3");
    expect(store).toContain('export const DRAWER_EVENT_STORE = "drawer-events"');
    expect(store).toContain('db.createObjectStore(DRAWER_EVENT_STORE, { keyPath: "saleRequestId" })');
    expect(store).toContain("if (!db.objectStoreNames.contains(DRAWER_EVENT_STORE))");
    expect(store).not.toContain("deleteObjectStore");
  });

  it("uses `add` and nothing else — no read, no put, no check-then-write", () => {
    const insert = functionBody(store, "export function insertDrawerEventClaim(");

    expect(insert.match(/\.add\(/g) ?? []).toHaveLength(1);

    for (const banned of [".get(", ".getAll(", ".getKey(", ".put(", ".count(", "openCursor", "await "]) {
      expect(`insertDrawerEventClaim: ${banned}`).toBe(`insertDrawerEventClaim: ${banned}`);
      expect(insert).not.toContain(banned);
    }
  });

  it("reports success only from the transaction's commit", () => {
    const insert = functionBody(store, "export function insertDrawerEventClaim(");

    expect(insert).toContain("transaction.oncomplete = () => settle({ ok: true });");
    expect(insert.match(/ok: true/g) ?? []).toHaveLength(1);
    expect(insert).toContain('request.error?.name === "ConstraintError"');
  });

  it("the session claims through that insert and fails closed", () => {
    const session = code(read(DRAWER_SESSION));

    expect(session).toContain("await openOfflineDb()");
    expect(session).toContain("insertDrawerEventClaim(");
    expect(session).toContain('if (!opened.ok) {\n    return "failed";');
    expect(session).not.toMatch(/readCacheKey|writeCacheKey|\.get\(|\.put\(/);
  });
});
