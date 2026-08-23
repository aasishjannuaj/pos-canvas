// Feature 24.5D — guards for the sync engine.
//
// The properties that matter are architectural, and none of them is visible in
// a behavioural test: WHERE complete_sale_v4 may be called from, that checkout
// is still fenced, that online sales still go to v3, and that the engine did
// not grow its own copy of the queue's persistence.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf-8");
}

function exists(relativePath: string): boolean {
  return existsSync(join(repoRoot, relativePath));
}

function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const ENGINE = "lib/saleSyncEngine.ts";
const CLASSIFIER = "lib/saleSyncClassifier.ts";
const RPC_ADAPTER = "lib/offlineSaleRpc.ts";
const DEVICE_RPC = "lib/device.rpc.ts";
const RUNTIME = "components/runtime/PosRuntime.tsx";
const DEVICE_APP = "components/device/DeviceApp.tsx";

function productSourceFiles(): string[] {
  const files: string[] = [];

  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(repoRoot, relative), { withFileTypes: true })) {
      const next = `${relative}/${entry.name}`;

      if (entry.isDirectory()) {
        walk(next);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.test\.tsx?$/.test(entry.name)) continue;

      files.push(next);
    }
  };

  for (const root of ["lib", "components", "app"]) walk(root);

  return files;
}

// ---------------------------------------------------------------------------
// Where v4 may be called from
// ---------------------------------------------------------------------------

describe("complete_sale_v4 is reachable from exactly one adapter", () => {
  it("only lib/offlineSaleRpc.ts issues the RPC", () => {
    const callers = productSourceFiles().filter((file) =>
      code(read(file)).includes('rpc("complete_sale_v4"')
    );

    expect(callers).toEqual([RPC_ADAPTER]);
  });

  it("the adapter is imported only by the sync engine", () => {
    const importers = productSourceFiles().filter(
      (file) => file !== RPC_ADAPTER && code(read(file)).includes("offlineSaleRpc")
    );

    expect(importers).toEqual([ENGINE]);
  });

  it("the ordinary device RPC module knows nothing about v4", () => {
    const rpc = code(read(DEVICE_RPC));

    expect(rpc).toContain('rpc("complete_sale_v3"');
    expect(rpc).not.toContain("complete_sale_v4");
    expect(rpc).not.toContain("offline_queued");
  });

  it("uses the device client, never a service-role credential", () => {
    const adapter = code(read(RPC_ADAPTER));

    expect(adapter).toContain("getDeviceSupabaseClient()");

    for (const banned of ["service_role", "SERVICE_ROLE", "admin", "createClient("]) {
      expect(`adapter: ${banned}`).toBe(`adapter: ${banned}`);
      expect(adapter).not.toContain(banned);
    }
  });

  it("sends the persisted values and never regenerates one", () => {
    const adapter = code(read(RPC_ADAPTER));

    expect(adapter).toContain("p_sale_request_id: record.saleRequestId");
    expect(adapter).toContain("p_occurred_at: record.occurredAt");
    expect(adapter).toContain("p_source: record.source");

    for (const banned of ["randomUUID", "Date.now()", "new Date()", "createSaleRequestId"]) {
      expect(`adapter: ${banned}`).toBe(`adapter: ${banned}`);
      expect(adapter).not.toContain(banned);
    }
  });

  it("sends no price as authority", () => {
    const adapter = code(read(RPC_ADAPTER));

    for (const banned of ["unitPrice", "lineTotal", "subtotal", "p_total", "price"]) {
      expect(`adapter: ${banned}`).toBe(`adapter: ${banned}`);
      expect(adapter).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// THE FENCES
// ---------------------------------------------------------------------------

describe("the sync engine is driven from exactly one place", () => {
  it("the checkout fence is still evaluated before any sale path", () => {
    // SUPERSEDED IN PART BY 24.5E, which opened offline checkout. The fence
    // itself did not move: it is still the first statement in completeSale, and
    // both sale paths — the online submit and the durable enqueue — are below
    // it, so an ineligible device reaches neither.
    const runtime = code(read(RUNTIME));
    const fence = runtime.indexOf("if (checkoutBlockedReason !== null)");
    const plan = runtime.indexOf("planSaleSubmission({");
    const submit = runtime.indexOf("await submitSale({");
    const queue = runtime.indexOf("await queueOfflineSale({");

    expect(fence).toBeGreaterThan(-1);
    expect(plan).toBeGreaterThan(fence);
    expect(submit).toBeGreaterThan(fence);
    expect(queue).toBeGreaterThan(fence);

    const app = code(read(DEVICE_APP));

    expect(app).toContain('getDeviceRuntimeMode(state) === "offline"');
    expect(app).toContain("describeOfflineCheckoutBlock(");
  });

  it("enqueueSale is called by ONE library module and no component", () => {
    const callers = productSourceFiles()
      .filter((file) => file !== "lib/saleQueueSession.ts")
      .filter((file) => code(read(file)).includes("enqueueSale"));

    expect(callers).toEqual(["lib/offlineCheckoutSession.ts"]);
  });

  it("the engine is triggered from the device runtime and nowhere else", () => {
    // 24.5D shipped the engine as a library with nothing calling it; 24.5E
    // wires it, and this is where that wiring is pinned. ONE host: a second
    // caller elsewhere would mean two components racing to drive one queue.
    const callers = productSourceFiles()
      .filter((file) => file !== ENGINE)
      .filter((file) => /runSaleSync|triggerSaleSync|subscribeToReconnect/.test(code(read(file))));

    expect(callers).toEqual([DEVICE_APP]);
  });

  it("startup recovery is claimed exactly once per device session", () => {
    const engine = code(read(ENGINE));
    const app = code(read(DEVICE_APP));

    // The latch lives at module scope, not in a component: React can mount a
    // component twice (StrictMode, an error boundary, a route change) and a
    // second "startup" would un-claim a submission still on the wire.
    //
    // KEYED, not a bare boolean — a 24.5E review correction. A process can
    // outlive a pairing (unpair and re-pair happen without a reload), and a
    // process-wide boolean would deny the new device session its startup pass
    // forever. See lib/offlineCheckout.guards.test.ts for the full rule.
    expect(engine).toContain("let startupSyncSessionKey: string | null = null");
    expect(engine).toContain("if (startupSyncSessionKey === sessionKey)");
    expect(engine).toContain("startupSyncSessionKey = sessionKey");

    // Exactly one call site, and it is the latched one — never the raw trigger.
    expect((app.match(/await triggerStartupSaleSyncOnce\(/g) ?? [])).toHaveLength(1);
    expect(app).not.toContain('triggerSaleSync("startup")');

    // Only the startup trigger recovers stranded records.
    const trigger = engine.slice(engine.indexOf("export async function triggerSaleSync"));

    expect(trigger.slice(0, 600)).toContain('if (trigger === "startup")');
    expect(code(read("lib/saleSyncEngine.ts")).match(/recoverInterruptedSyncs\(/g)).toHaveLength(2);
  });

  it("the reconnect listener is subscribed once and cleaned up", () => {
    const app = code(read(DEVICE_APP));

    expect((app.match(/subscribeToReconnect\(/g) ?? [])).toHaveLength(1);
    // The effect RETURNS the unsubscribe, which is what makes teardown happen.
    expect(app).toMatch(/return subscribeToReconnect\(/);
    // Connectivity is a hint that nudges a drain, never a gate on selling.
    expect(app).not.toContain("navigator.onLine");
  });

  it("registers no global listener or timer of its own", () => {
    // subscribeToReconnect EXPOSES a subscription for a caller to attach; the
    // engine must never attach one itself, or it would start draining before
    // 24.5E decides where that belongs.
    //
    // Checked as "no module-level side effect" rather than by banning the word
    // addEventListener, which appears legitimately in the injected target's
    // TYPE and in the subscription the caller opts into.
    const engine = code(read(ENGINE));

    expect(engine).not.toContain("setInterval");
    expect(engine).not.toMatch(/setTimeout\(/);

    // The only addEventListener is on the injected target inside the exported
    // subscribe function — never on globalThis at module scope.
    expect(engine).not.toMatch(/^globalThis\.window\.addEventListener/m);
    expect(engine).not.toMatch(/^\s*subscribeToReconnect\(/m);

    // No statement outside a declaration: the module does nothing on import.
    const topLevelCalls = engine
      .split("\n")
      .filter((line) => /^[a-zA-Z_$][\w$]*\(/.test(line));

    expect(topLevelCalls).toEqual([]);
  });

  it("24.5F and 24.6 have not started", () => {
    // NARROWED BY 24.5E, which built the provisional receipt and its component.
    // What is still out of scope: the owner-facing queue console and the
    // publish-progress work of a later milestone.
    for (const premature of [
      "components/devices/DeviceQueueStatus.tsx",
      "components/dashboard/DeviceSyncPanel.tsx",
    ]) {
      expect(`exists early: ${premature}`).toBe(`exists early: ${premature}`);
      expect(exists(premature)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Layering
// ---------------------------------------------------------------------------

describe("the engine owns sequencing and nothing else", () => {
  it("keeps no persistence of its own", () => {
    const engine = code(read(ENGINE));

    for (const banned of ["indexedDB", "IDBDatabase", "openOfflineDb", "localStorage"]) {
      expect(`engine: ${banned}`).toBe(`engine: ${banned}`);
      expect(engine).not.toContain(banned);
    }

    // Every mutation goes through the 24.5C API.
    expect(engine).toContain("@/lib/saleQueueSession");
  });

  it("keeps no classification of its own", () => {
    const engine = code(read(ENGINE));

    expect(engine).toContain("classifySubmissionFailure");
    // The message table lives in the classifier, not here.
    expect(engine).not.toContain("Offline sale time");
    expect(engine).not.toContain("KNOWN_SERVER_ERRORS =");
  });

  it("the classifier is pure — no storage, no network, no clock of its own", () => {
    const classifier = code(read(CLASSIFIER));

    for (const banned of ["indexedDB", "fetch(", "supabase", "Date.now()", "localStorage"]) {
      expect(`classifier: ${banned}`).toBe(`classifier: ${banned}`);
      expect(classifier).not.toContain(banned);
    }
  });

  it("single-flight is enforced in code, not by a disabled button", () => {
    const engine = code(read(ENGINE));

    expect(engine).toContain("let activeRun: Promise<SyncRunReport> | null = null");
    expect(engine).toContain("if (activeRun !== null)");
  });

  it("the drain loop never breaks early on a failed record", () => {
    // A malformed sale from three days ago must not strand this morning's.
    const engine = code(read(ENGINE));
    const loop = engine.slice(engine.indexOf("for (const record of due.value)"));
    const body = loop.slice(0, loop.indexOf("const summary"));

    expect(body).not.toContain("break;");
    expect(body).not.toContain("return report;");
  });
});

// ---------------------------------------------------------------------------
// Regression
// ---------------------------------------------------------------------------

describe("24.5D changed nothing it was not meant to", () => {
  it("no migration was added or changed", () => {
    const migrations = readdirSync(join(repoRoot, "supabase/migrations")).filter((f) =>
      f.endsWith(".sql")
    );

    expect(migrations).toHaveLength(17);
  });

  it("the queue's own rules are unchanged where they matter", () => {
    const queue = code(read("lib/saleQueue.ts"));

    expect(queue).toContain("isValidSaleRequestId(raw.saleRequestId)");
    expect(queue).toContain('raw.source !== "offline_queued"');
    expect(queue).toContain("raw.tipAmount !== 0");
  });

  it("branding and release metadata are untouched", () => {
    expect(read("android/app/src/main/res/values/styles.xml")).toContain(
      '<item name="windowSplashScreenBackground">@color/ic_launcher_background</item>'
    );
    expect(exists("windows-shell/build/icon.ico")).toBe(true);
    expect(read("lib/windowsRelease.ts")).toContain("isPrerelease: true");
  });
});
