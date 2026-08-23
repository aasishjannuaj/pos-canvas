// Feature 24.5A — guards for the read-only offline start.
//
// TWO JOBS. First, prove the safety fences hold: checkout is impossible while
// running from cache, and a server that ANSWERED can never be overridden by a
// cached one. Second, prove 24.5A stopped where it was supposed to — no queue,
// no migration, no RPC change, no receipt or inventory work.
//
// The fence assertions are STRUCTURAL because the guarded property is an
// ordering one: "the block is checked before anything can submit". A behavioural
// test of a React component cannot express that under this repository's
// deliberately DOM-free vitest environment, whereas source ordering can — the
// same technique lib/windowsShellSecurity.guards.test.ts uses on the preload.
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

/** Strips comments so explanatory prose never satisfies or trips a guard. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const RUNTIME = "components/runtime/PosRuntime.tsx";
const PANEL = "components/runtime/PosCheckoutPanel.tsx";
const DEVICE_APP = "components/device/DeviceApp.tsx";
const STORE = "lib/deviceOfflineStore.ts";
const CACHE = "lib/deviceOfflineCache.ts";
const SESSION = "lib/deviceOfflineSession.ts";
const CONNECTIVITY = "lib/deviceConnectivity.ts";

/** Every non-test source file that ships. */
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
// The checkout fence
// ---------------------------------------------------------------------------

describe("checkout is impossible while running from cache", () => {
  const runtime = code(read(RUNTIME));

  it("the block is checked BEFORE anything that could submit", () => {
    // Ordering is the property. A guard placed after planSaleSubmission would
    // still disable the button while minting a request id on every press.
    const fence = runtime.indexOf("if (checkoutBlockedReason !== null)");
    const plan = runtime.indexOf("planSaleSubmission({");
    const submit = runtime.indexOf("await submitSale({");

    expect(fence).toBeGreaterThan(-1);
    expect(plan).toBeGreaterThan(fence);
    expect(submit).toBeGreaterThan(fence);
  });

  it("the fence returns rather than falling through", () => {
    const fence = runtime.indexOf("if (checkoutBlockedReason !== null)");
    const body = runtime.slice(fence, fence + 260);

    expect(body).toContain("return;");
  });

  it("the pay button is disabled by the same condition", () => {
    expect(code(read(PANEL))).toContain("checkoutBlockedReason !== null ||");
  });

  it("the device supplies the reason ONLY in offline mode", () => {
    const app = code(read(DEVICE_APP));

    expect(app).toContain('getDeviceRuntimeMode(state) === "offline"');
    expect(app).toContain("describeOfflineCheckoutBlock(");
  });

  it("every operator refusal promises nothing and blames nobody", () => {
    // MOVED BY 24.5E. The single OFFLINE_CHECKOUT_BLOCKED_MESSAGE constant this
    // used to read lived in DeviceApp and said offline sales were not built
    // yet. They are now, so the copy it pinned would be a lie — but the RULE it
    // enforced is the valuable part and now applies to the whole table of
    // refusals in lib/offlineCheckout.ts, plus the preparing message.
    const checkout = read("lib/offlineCheckout.ts");
    const tableStart = checkout.indexOf("OFFLINE_CHECKOUT_BLOCKED_MESSAGES: Record<");
    const table = checkout.slice(tableStart, checkout.indexOf("\n};", tableStart));
    const messages = table.match(/"[^"]{20,}"/g);

    expect(messages).not.toBeNull();
    expect((messages ?? []).length).toBeGreaterThanOrEqual(5);

    const preparing = read("lib/offlineCheckout.ts").match(
      /OFFLINE_CHECKOUT_PREPARING_MESSAGE =\s*\n?\s*"([^"]+)"/
    )?.[1];

    expect(preparing).toBeDefined();

    for (const copy of [...(messages ?? []), `"${preparing}"`]) {
      for (const banned of ["error", "failed", "invalid", "corrupt", "database", "queue"]) {
        expect(`copy says ${banned}`).toBe(`copy says ${banned}`);
        expect(copy.toLowerCase()).not.toContain(banned);
      }
    }
  });

  it("the device host still persists nothing itself", () => {
    // SUPERSEDED IN PART BY 24.5E, which wired offline checkout. What survives
    // is the LAYERING: the component asks a library to persist a sale and never
    // touches storage, a queue record or a receipt model of its own.
    const app = code(read(DEVICE_APP));

    for (const banned of [
      "enqueueSale",
      "indexedDB",
      "openOfflineDb",
      "localStorage",
      "buildProvisionalReceipt",
      "QueuedSale",
    ]) {
      expect(`DeviceApp: ${banned}`).toBe(`DeviceApp: ${banned}`);
      expect(app).not.toContain(banned);
    }
  });

  it("the sale request id is still only passed through, never stored here", () => {
    // `saleRequestId` legitimately appears in the EXISTING online checkout,
    // which hands the runtime's id to complete_sale_v3. 24.5E did not add a
    // second one: the offline id is minted and persisted inside
    // lib/offlineCheckout.ts and lib/saleQueueSession.ts, not here.
    const app = code(read(DEVICE_APP));
    const occurrences = app.match(/saleRequestId/g) ?? [];

    expect(occurrences).toHaveLength(2);
    expect(app).toContain("saleRequestId: input.saleRequestId");
    expect(app).not.toContain("writeCacheKey");
  });
});

// ---------------------------------------------------------------------------
// A server answer always wins
// ---------------------------------------------------------------------------

describe("a server that answered is never overridden by cache", () => {
  it("only a transport failure can reach the fallback", () => {
    const app = code(read(DEVICE_APP));

    expect(app).toContain("permitsOfflineFallback(failure)");
    expect(app).toContain("openOfflineOrFail");
  });

  it("permitsOfflineFallback admits exactly one kind", () => {
    const connectivity = code(read(CONNECTIVITY));

    expect(connectivity).toContain('return kind === "transport";');
  });

  it("a confirmed revocation clears the cache", () => {
    // Otherwise the next launch would open offline on a withdrawn device.
    const app = code(read(DEVICE_APP));

    expect(app).toContain('if (next.status === "revoked")');
    expect(app).toContain("clearOfflineCache()");
  });

  it("a local reset clears the cache before signing out", () => {
    const app = code(read(DEVICE_APP));
    const clear = app.indexOf("await clearOfflineCache();");
    const signOut = app.indexOf("await resetDeviceSession();");

    expect(clear).toBeGreaterThan(-1);
    expect(signOut).toBeGreaterThan(clear);
  });

  it("the lease is never refreshed by a read", () => {
    const session = code(read(SESSION));
    const load = session.indexOf("export async function loadOfflineFallback");
    const body = session.slice(load);

    expect(body).not.toContain("writePairingAssertionRecord");
    expect(body).not.toContain("writePinnedConfigRecord");
  });
});

// ---------------------------------------------------------------------------
// Cross-platform storage
// ---------------------------------------------------------------------------

describe("one shared implementation, no platform adapter", () => {
  it("exactly one module OPENS IndexedDB", () => {
    // Reframed by 24.5C. The property that matters is that one adapter owns the
    // connection — not that no other file may name IDBDatabase, which
    // lib/saleQueueSession.ts now legitimately does as a parameter type without
    // ever opening a database itself.
    const openers = productSourceFiles().filter((file) =>
      /indexedDB\.open\(|idb\.open\(/.test(code(read(file)))
    );

    expect(openers).toEqual([STORE]);

    // And nobody reaches for the global except that adapter.
    const globalUsers = productSourceFiles().filter(
      (file) => file !== STORE && /globalThis\.indexedDB|window\.indexedDB/.test(code(read(file)))
    );

    expect(globalUsers).toEqual([]);
  });

  it("navigator.storage is requested from that same module only", () => {
    const offenders = productSourceFiles().filter(
      (file) => file !== STORE && read(file).includes("navigator.storage")
    );

    expect(offenders).toEqual([]);
  });

  it("no Capacitor storage plugin, SQLite, or Electron persistence was added", () => {
    const manifest = read("package.json");

    for (const banned of [
      "@capacitor/preferences",
      "capacitor-sqlite",
      "sqlite",
      "localforage",
      "dexie",
      "idb",
      "electron-store",
    ]) {
      expect(`package.json: ${banned}`).toBe(`package.json: ${banned}`);
      expect(manifest).not.toContain(`"${banned}"`);
    }
  });

  it("the shells gained no storage code of their own", () => {
    for (const file of [
      "windows-shell/main.mjs",
      "windows-shell/preload.js",
      "capacitor.config.ts",
    ]) {
      const source = code(read(file));

      // "Preferences" alone would match webPreferences, which is Electron's
      // own security configuration and has nothing to do with storage.
      for (const banned of [
        "indexedDB",
        "sqlite",
        "@capacitor/preferences",
        "offlineQueue",
        "electron-store",
      ]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("fake-indexeddb is a DEV dependency and never a runtime one", () => {
    const manifest = JSON.parse(read("package.json"));

    expect(manifest.devDependencies["fake-indexeddb"]).toBeDefined();
    expect(manifest.dependencies["fake-indexeddb"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scope — 24.5B-F did not start
// ---------------------------------------------------------------------------

describe("Feature 24.5A stops at read-only startup", () => {
  it("no sync engine exists, and nothing submits a queued sale", () => {
    // SUPERSEDED IN PART BY 24.5C, deliberately. This used to assert that no
    // queue module and no queue object store existed at all — a fence around
    // 24.5A. 24.5C built exactly that, so keeping the fence would mean a
    // passing suite could only be bought by not doing the approved work.
    //
    // lib/offlineQueue.guards.test.ts now asserts the queue's own properties.
    // What survives here is the part 24.5C still was not allowed to do: submit.
    for (const premature of ["lib/syncEngine.ts", "lib/offlineSync.ts", "lib/saleSync.ts"]) {
      expect(`exists early: ${premature}`).toBe(`exists early: ${premature}`);
      expect(exists(premature)).toBe(false);
    }

    for (const file of ["lib/saleQueue.ts", "lib/saleQueueSession.ts"]) {
      const source = code(read(file));

      expect(`${file} submits`).toBe(`${file} submits`);
      expect(source).not.toContain("complete_sale");
      expect(source).not.toContain("supabase");
    }
  });

  it("the cache stores configuration only, never a sale", () => {
    const cache = code(read(CACHE));

    for (const banned of ["saleRequestId", "QueuedSale", "paymentMethod", "occurred_at"]) {
      expect(`cache: ${banned}`).toBe(`cache: ${banned}`);
      expect(cache).not.toContain(banned);
    }
  });

  it("the server contract exists but NO client is wired onto it", () => {
    // SUPERSEDED BY 24.5B. This asserted that no migration mentioned the
    // offline contract at all; 24.5B created it. The phase boundary that
    // matters now is different and stricter: the server is ready, and the
    // client has not moved. 24.5A's read-only startup is still the only
    // offline behaviour a till has.
    const migrationsDir = join(repoRoot, "supabase/migrations");
    const withV4 = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => readFileSync(join(migrationsDir, f), "utf-8").includes("complete_sale_v4"));

    expect(withV4).toHaveLength(1);

    // NARROWED AGAIN BY 24.5D. The queue records `occurredAt`/`offline_queued`,
    // and the sync adapter now issues v4 — both are the approved work. The
    // surviving property is where that call may live: exactly one adapter, and
    // never the checkout path.
    const v4Callers = productSourceFiles().filter((file) =>
      code(read(file)).includes('rpc("complete_sale_v4"')
    );

    expect(v4Callers).toEqual(["lib/offlineSaleRpc.ts"]);

    for (const file of [RUNTIME, DEVICE_APP, "lib/device.rpc.ts", "lib/saleSubmission.ts"]) {
      const source = code(read(file));

      for (const premature of ["occurredAt", "offline_queued", "enqueueSale"]) {
        expect(`${file}: ${premature}`).toBe(`${file}: ${premature}`);
        expect(source).not.toContain(premature);
      }
    }
  });

  it("the sale RPC contract is untouched", () => {
    const rpc = read("lib/device.rpc.ts");

    expect(rpc).toContain('rpc("complete_sale_v3"');
    expect(rpc).not.toContain("complete_sale_v4");
    expect(read("lib/saleRequest.ts")).not.toContain("offline");
  });

  it("no client allocates an order number or invents a stock figure", () => {
    // NARROWED BY 24.5E. The provisional receipt is now built (approved
    // decision D, docs/OFFLINE_ARCHITECTURE.md §8), so banning its name would
    // make the suite pass only by leaving approved work undone. The surviving
    // property is the one that always mattered: the server allocates order
    // numbers and owns inventory, and no client-side counterpart exists.
    for (const file of productSourceFiles()) {
      const source = read(file);

      for (const premature of ["allocateOrderNumber", "stockShortfall"]) {
        expect(`${file}: ${premature}`).toBe(`${file}: ${premature}`);
        expect(source).not.toContain(premature);
      }
    }
  });

  it("no 24.6 publish-progress work began", () => {
    // FEATURE 24.6 HAS NOW STARTED, with owner approval, so lib/publishProgress.ts
    // exists deliberately and asserting its absence would only pin this file to a
    // past that has moved on. The boundary it protected is still real, so it is
    // restated rather than dropped: publish progress is an OWNER-EDITOR concern
    // and must not reach into the device, offline or branding surfaces.
    expect(read("lib/publishProgress.ts")).not.toContain("@/lib/device");
    expect(read("lib/publishProgress.ts")).not.toContain("@/lib/saleQueue");
    expect(read("lib/publishProgress.ts")).not.toContain("@/lib/brand");
  });
});

// ---------------------------------------------------------------------------
// Regression
// ---------------------------------------------------------------------------

describe("Feature 24.5A changed nothing it was not meant to", () => {
  it("Android and Windows branding is untouched", () => {
    expect(read("android/app/src/main/res/values/styles.xml")).toContain(
      '<item name="windowSplashScreenBackground">@color/ic_launcher_background</item>'
    );
    expect(exists("windows-shell/build/icon.ico")).toBe(true);
    expect(exists("windows-shell/splash.html")).toBe(true);
  });

  it("release metadata is untouched", () => {
    expect(read("lib/windowsRelease.ts")).toContain(
      "03b88e35d12b01ffbf62116519817c554b18f8a8e51c21064b9f6e82a748855d"
    );
    expect(read("lib/windowsRelease.ts")).toContain("isPrerelease: true");
    expect(read("lib/androidRelease.ts")).toContain(
      "aded13d8db6eaed8a4fdeb5e56cf1a12036df24b64f54eec8f98ff2feb910125"
    );
  });

  it("the online checkout path is unchanged when nothing blocks it", () => {
    const runtime = code(read(RUNTIME));

    // The default keeps every existing host — the owner editor and the Builder
    // Preview — on exactly the path they were on before 24.5A.
    expect(runtime).toContain("checkoutBlockedReason = null");
    expect(runtime).toContain("await submitSale({");
    expect(runtime).toContain("saleRequestId: plan.request.id");
  });

  it("the customer logo pipeline is untouched", () => {
    expect(read("lib/logoUpload.ts")).toContain('LOGO_BUCKET = "project-logos"');
  });
});
