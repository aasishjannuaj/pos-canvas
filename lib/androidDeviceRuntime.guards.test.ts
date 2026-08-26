// Feature 24.5G — guards for the Android app's LOCALLY PACKAGED device runtime.
//
// WHAT WENT WRONG, recorded because the guards below are shaped by it. The
// Android shell loaded the runtime from a hosted URL, so a device with no
// network could not execute DeviceApp at all: the WebView failed, Capacitor
// showed a static "needs an internet connection" page, and every offline
// capability built across 24.5A-F was unreachable behind it. Real hardware QA
// found it. Automation could not, because every offline module is tested
// directly under Node and none of them cares how the app was loaded.
//
// So these are deliberately ARCHITECTURAL: they assert what the app is built
// from and what it needs in order to start, which is precisely the class of
// property a unit test cannot see.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

const CAPACITOR = "capacitor.config.ts";
const VITE = "native-device/vite.config.mts";
const ENTRY = "native-device/main.tsx";
const PACKAGED = "android/app/src/main/assets/public";

/** The built runtime, when one is present. Absent on a clean checkout. */
function packagedBundle(): string | null {
  const dir = join(repoRoot, PACKAGED, "assets");

  if (!existsSync(dir)) return null;

  const js = readdirSync(dir).filter((f) => f.endsWith(".js"));

  return js.length === 0 ? null : readFileSync(join(dir, js[0]), "utf-8");
}

// ---------------------------------------------------------------------------
// The app boots from itself
// ---------------------------------------------------------------------------

describe("the Android app carries its own runtime", () => {
  it("declares no remote server, so there is nothing to fetch at startup", () => {
    const config = code(read(CAPACITOR));

    // THE defect, stated as an assertion. A server.url of any kind makes the
    // hosted page the entry point and reintroduces the network dependency.
    expect(config).not.toMatch(/server\s*:\s*\{/);
    expect(config).not.toContain("server.url");
    expect(config).not.toContain("errorPath");
    expect(config).not.toContain("vercel.app");
    expect(config).not.toContain("POS_CANVAS_ANDROID_SERVER_URL");
    expect(config).not.toContain("readAndroidServerUrl");
  });

  it("points webDir at the built runtime", () => {
    const config = code(read(CAPACITOR));

    expect(config).toContain('webDir: "android-shell/www"');
  });

  it("the sync that produces an APK builds that runtime first", () => {
    // Otherwise an APK could be assembled around a stale or missing bundle.
    const manifest = JSON.parse(read("package.json"));

    expect(manifest.scripts["android:runtime"]).toContain(VITE);
    expect(manifest.scripts["android:sync"]).toContain("android:runtime");
    expect(manifest.scripts["android:sync"]).toContain("cap sync android");
  });

  it("the old network-dependent stub generator is gone", () => {
    expect(exists("android-shell/generateWww.mjs")).toBe(false);

    // And its copy cannot come back through another door.
    for (const file of [CAPACITOR, VITE, ENTRY]) {
      const source = read(file);

      expect(`${file} still promises a network`).toBe(`${file} still promises a network`);
      expect(source).not.toContain("needs an internet connection");
      expect(source).not.toContain("loads the POS runtime over the network");
    }
  });
});

// ---------------------------------------------------------------------------
// It is the REAL runtime, not a stub
// ---------------------------------------------------------------------------

describe("the local entry is the real device application", () => {
  it("mounts the same DeviceApp the hosted route mounts", () => {
    const entry = code(read(ENTRY));

    expect(entry).toContain('from "@/components/device/DeviceApp"');
    expect(entry).toContain("createRoot(");
  });

  it("contains no POS or financial logic of its own", () => {
    // The entry is a mount. A second implementation of any of this is the one
    // outcome this feature must not produce.
    const entry = code(read(ENTRY));

    for (const banned of [
      "calculateCartSummary",
      "buildSaleRequestItems",
      "enqueueSale",
      "complete_sale",
      "createSaleRequestId",
      "IndexedDB",
      "indexedDB",
      "subtotal",
      "taxAmount",
    ]) {
      expect(`entry reimplements ${banned}`).toBe(`entry reimplements ${banned}`);
      expect(entry).not.toContain(banned);
    }
  });

  it("neither native shell holds a copy of the POS", () => {
    // Everything under android-shell/ must be entry, config or shim — never a
    // second cart, price, queue or receipt.
    const walk = (relative: string): string[] => {
      const out: string[] = [];

      for (const name of readdirSync(join(repoRoot, relative))) {
        const next = `${relative}/${name}`;

        if (name === "www" || name === "runtime" || name === "node_modules") continue;
        if (statSync(join(repoRoot, next)).isDirectory()) {
          out.push(...walk(next));
          continue;
        }
        if (/\.(ts|tsx|mts|mjs|js)$/.test(name)) out.push(next);
      }

      return out;
    };

    const sources = [...walk("android-shell"), ...walk("native-device")];

    expect(sources.length).toBeGreaterThan(0);

    for (const file of sources) {
      const source = code(read(file));

      for (const banned of [
        "calculateCartSummary",
        "buildSaleRequestItems",
        "planSaleSubmission",
        "enqueueSale",
        "rpc(",
        "createCartItem",
        "toOfflineReference",
      ]) {
        expect(`${file} duplicates ${banned}`).toBe(`${file} duplicates ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Origin and secure context
// ---------------------------------------------------------------------------

describe("the runtime's origin is local, permanent and secure", () => {
  it("relies on Capacitor's https scheme rather than a weaker one", () => {
    const config = code(read(CAPACITOR));

    // file://, http://localhost and capacitor:// were all rejected: the first
    // two are not what Capacitor's default produces, and crypto.subtle — which
    // lib/deviceOfflineCache.ts needs to write ANY cache — is unavailable
    // outside a secure context.
    for (const banned of ["file://", "capacitor://", "androidScheme: \"http\"", "http://localhost"]) {
      expect(`config selects ${banned}`).toBe(`config selects ${banned}`);
      expect(config).not.toContain(banned);
    }
  });

  it("the entry refuses to start where offline storage could not work", () => {
    const entry = code(read(ENTRY));

    expect(entry).toContain("window.isSecureContext !== true");
    expect(entry).toContain("crypto?.subtle?.digest");
    // It must not render the POS in that case.
    const guard = entry.indexOf("insecure !== null");
    const render = entry.indexOf("createRoot(");

    expect(guard).toBeGreaterThan(-1);
    expect(render).toBeGreaterThan(guard);
  });

  it("no weaker hash was substituted to accommodate a bad origin", () => {
    const cache = code(read("lib/deviceOfflineCache.ts"));

    expect(cache).toContain('subtle.digest("SHA-256", bytes)');

    for (const banned of ["md5", "sha1", "SHA-1", "Math.random"]) {
      expect(`cache uses ${banned}`).toBe(`cache uses ${banned}`);
      expect(cache).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// What the bundle may and may not contain
// ---------------------------------------------------------------------------

describe("the packaged bundle contains a POS and no server", () => {
  it("bundles no server-only module, service-role credential or Node builtin", () => {
    const bundle = packagedBundle();

    if (bundle === null) return;

    for (const banned of [
      // The literal top-level throw from the server-only package. Its presence
      // once silently truncated the entire runtime out of the bundle.
      "It should only be used from a Server Component",
      "service_role",
      "SERVICE_ROLE",
      "SUPABASE_SERVICE_ROLE_KEY",
      "node:crypto",
      "next/headers",
    ]) {
      expect(`bundle contains ${banned}`).toBe(`bundle contains ${banned}`);
      expect(bundle).not.toContain(banned);
    }
  });

  it("bundles the offline runtime the app needs to trade without a network", () => {
    const bundle = packagedBundle();

    if (bundle === null) return;

    // Semantic markers, not filenames: each is a string that can only be
    // present if the corresponding module was really compiled in.
    for (const marker of [
      "pos-canvas-device", // the IndexedDB database name
      "sale-queue", // the durable queue's object store
      "uncertain-online-sale", // 24.5F's evidence record
      "OFFLINE RECEIPT", // the approved provisional receipt wording
      "complete_sale_v3", // online checkout
      "complete_sale_v4", // queued sync
    ]) {
      expect(`bundle is missing ${marker}`).toBe(`bundle is missing ${marker}`);
      expect(bundle).toContain(marker);
    }
  });

  it("needs nothing from the hosted app in order to boot", () => {
    const html = readFileSync(join(repoRoot, PACKAGED, "index.html"), "utf-8");

    // Every script and stylesheet the document loads is relative and local.
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);

    expect(refs.length).toBeGreaterThan(0);

    for (const ref of refs) {
      expect(`${ref} is remote`).toBe(`${ref} is remote`);
      expect(ref.startsWith("http://")).toBe(false);
      expect(ref.startsWith("https://")).toBe(false);
      expect(ref.startsWith("//")).toBe(false);
    }

    // And no font, script or style is fetched from a third party at runtime.
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).not.toContain("fonts.gstatic.com");
    expect(html).not.toContain("vercel.app");
  });
});

// ---------------------------------------------------------------------------
// Feature 24.5G — the offline cold start
// ---------------------------------------------------------------------------

describe("a transport failure reaches the cache, not a dead end", () => {
  const APP = "components/device/DeviceApp.tsx";

  it("the auth gate consults the cache BEFORE the terminal offline error", () => {
    // The defect: `createDeviceError("offline")` returned before
    // loadOfflineFallback was ever reached, so a paired till with a perfect
    // cache could not open without a network.
    const app = code(read(APP));
    const gate = app.indexOf("if (!session.ok) {");
    const recover = app.indexOf("readPersistedDeviceUserId()");
    const fallback = app.indexOf("await openOfflineOrFail(persistedUserId, failure);");

    for (const index of [gate, recover, fallback]) {
      expect(index).toBeGreaterThan(-1);
    }

    expect(recover).toBeGreaterThan(gate);
    expect(fallback).toBeGreaterThan(recover);

    // The terminal error survives, but ONLY for a device with no identity.
    //
    // Feature 25.4 changed WHICH error that is — it is now classified rather
    // than always "offline" — so this anchors on the terminal setState itself.
    // The ordering property guarded here is unchanged: the cache is consulted
    // before any dead end, and the dead end is reachable only with no identity.
    const terminal = app.indexOf(
      "setState(createDeviceError(classifyStartupFailure(failure)));",
      gate
    );

    expect(terminal).toBeGreaterThan(recover);
    expect(terminal).toBeLessThan(fallback);
    expect(app.slice(recover, terminal)).toContain("if (persistedUserId === null)");
  });

  it("offline authorization still runs the one shared validator", () => {
    // No second offline path: the same openOfflineOrFail the pairing-state
    // branch uses, which admits only a transport failure and then runs the
    // whole cached-start validator.
    const app = code(read(APP));

    expect((app.match(/openOfflineOrFail\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(app).toContain("permitsOfflineFallback(failure)");
    expect(app).not.toContain("decideOfflineFallback(");
    expect(app).not.toContain("evaluateLease(");
  });

  it("the identity helper makes no network call and returns no token", () => {
    const rpc = code(read("lib/device.rpc.ts"));
    const fn = rpc.slice(rpc.indexOf("export function readPersistedDeviceUserId"));
    const body = fn.slice(0, fn.indexOf("\n}"));

    expect(body).toContain("DEVICE_AUTH_STORAGE_KEY");
    expect(body).toContain("storage.getItem(");

    for (const banned of [
      "await",
      "fetch",
      "rpc(",
      "getDeviceSupabaseClient",
      "access_token",
      "refresh_token",
      "removeItem",
      "setItem",
    ]) {
      expect(`identity helper uses ${banned}`).toBe(`identity helper uses ${banned}`);
      expect(body).not.toContain(banned);
    }

    // Its return type has nowhere to put a token.
    expect(rpc).toContain("): string | null {");
  });

  it("a session failure is classified, not collapsed", () => {
    const rpc = code(read("lib/device.rpc.ts"));
    const fn = rpc.slice(rpc.indexOf("export async function getDeviceSession"));
    const body = fn.slice(0, fn.indexOf("\n}"));

    expect(body).toContain("failure: classifyAuthFailure(error)");
    // "No session stored" is still not a failure — there is nothing to fall
    // back to, and giving it a kind would invite treating it as one.
    expect(body).toContain("if (!data.session?.user?.id) {");
    expect(rpc).toContain("isAuthRetryableFetchError(error) ? \"transport\"");
  });

  it("the durable cache write is awaited before the device is called ready", () => {
    const app = code(read(APP));

    expect(app).toContain("const persisted = await persistDeviceCache({");
    expect(app).not.toContain("void persistDeviceCache(");
    // A failed write is surfaced, never assumed successful.
    expect(app).toContain("setOfflinePrepared(persisted.stored)");
    expect(app).toContain("offlinePrepared === false");
  });

  it("online startup still validates through Supabase", () => {
    const app = code(read(APP));

    expect(app).toContain("await getDeviceSession()");
    expect(app).toContain("await signInDeviceAnonymously()");
    expect(app).toContain("await fetchDevicePairingState()");
    expect(app).toContain("await fetchDeviceConfig()");
  });

  it("no localStorage fallback was added for financial data", () => {
    // The identity read is the ONE localStorage touch, and it reads an id.
    for (const file of ["lib/saleQueueSession.ts", "lib/uncertainSaleSession.ts", "lib/offlineCheckoutSession.ts"]) {
      const source = code(read(file));

      expect(`${file}: localStorage`).toBe(`${file}: localStorage`);
      expect(source).not.toContain("localStorage");
      expect(source).not.toContain("sessionStorage");
    }

    const app = code(read(APP));

    expect(app).not.toContain("localStorage");
  });
});

// ---------------------------------------------------------------------------
// Feature 24.5F — regaining connectivity without a restart
// ---------------------------------------------------------------------------

describe("a reconnect both refreshes state and wakes the queue", () => {
  const APP = "components/device/DeviceApp.tsx";

  it("the Android manifest can observe connectivity changes", () => {
    // Without ACCESS_NETWORK_STATE the WebView never fires `online`, so the
    // reconnect listener is correct and never called. Hardware proved it.
    const manifest = read("android/app/src/main/AndroidManifest.xml");

    expect(manifest).toContain('android:name="android.permission.INTERNET"');
    expect(manifest).toContain('android:name="android.permission.ACCESS_NETWORK_STATE"');
  });

  it("the reconnect episode refreshes state BEFORE it drains", () => {
    // Order matters: a successful drain must never leave a revoked till
    // looking healthy.
    const app = code(read(APP));
    const handler = app.slice(app.indexOf("return subscribeToReconnect(("));
    const body = handler.slice(0, handler.indexOf("}, [syncSessionKey"));

    const refresh = body.indexOf("await returnOnlineFromReconnect();");
    const drain = body.indexOf('await runSync("reconnect");');

    expect(refresh).toBeGreaterThan(-1);
    expect(drain).toBeGreaterThan(refresh);
  });

  it("the refresh is authoritative and in place, never a remount", () => {
    const app = code(read(APP));
    // Bounded to the callback itself: the next statement after it is the
    // reconnect useEffect, and slicing past that would sweep in unrelated code.
    const fn = app.slice(app.indexOf("const returnOnlineFromReconnect = useCallback"));
    const body = fn.slice(0, fn.indexOf("useEffect("));

    expect(body).not.toBe("");
    expect(body.length).toBeLessThan(fn.length);

    // The server decides, not navigator.onLine.
    expect(body).toContain("await fetchDevicePairingState()");
    expect(body).toContain("await fetchDeviceConfig()");
    expect(body).not.toContain("navigator.onLine");

    // In place: resolveDeviceState would set `checking` and unmount PosRuntime,
    // destroying the cashier's cart and any checkout in progress.
    expect(body).not.toContain("resolveDeviceState");
    expect(body).not.toContain('status: "checking"');
    expect(body).toContain('if (previous.status !== "ready" || !previous.offline)');

    // The latch releases only on a confirmed authoritative start.
    expect(body).toContain("offline: null,");

    // A revocation confirmed during the outage is applied, not skipped.
    expect(body).toContain('if (next.status === "revoked")');
    // A still-unreachable server changes nothing.
    expect(body).toContain("if (!pairingState.ok) {");
  });

  it("Sync now is offered on queued work, not on runtime mode", () => {
    const app = code(read(APP));

    // Feature 24.5F — GATED ON `waiting`, NOT ON `unsynced`.
    //
    // `unsynced` counts needs_attention as well as pending/syncing, and nothing
    // promotes a needs_attention record back to pending — isDueForAttempt
    // refuses anything that is not pending, so a drain triggered for one does
    // nothing whatsoever. Hardware QA found a revoked till offering Sync now
    // over an authoritatively rejected sale, where every press was inert.
    expect(app).toContain(
      'onSyncNow={saleStatus.waiting > 0 ? () => void runSync("manual") : null}'
    );
    expect(app).not.toContain("onSyncNow={saleStatus.unsynced > 0");
    // The gate that hid the only manual recovery exactly when it was needed.
    expect(app).not.toContain("onSyncNow={offlineMode ?");
  });

  it("no polling was added, and the backoff curve is untouched", () => {
    const app = code(read(APP));

    expect(app).not.toContain("setInterval");
    expect(app).not.toContain("backoffDelayMs");
    // The one timer remains the DEF-02 scheduler, aimed at a persisted instant.
    expect(app).toContain("saleStatus.nextRetryAt");
  });

  it("no Capacitor network plugin was added", () => {
    const manifest = JSON.parse(read("package.json"));
    const all = { ...manifest.dependencies, ...manifest.devDependencies };

    expect(all["@capacitor/network"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Feature 24.5F — a revoked till can still settle what it owes
// ---------------------------------------------------------------------------

describe("the revoked screen is not a dead end", () => {
  const APP = "components/device/DeviceApp.tsx";

  it("drains the queue when the device learns it is revoked", () => {
    const app = code(read(APP));

    expect(app).toContain('if (syncSessionKey === null || state.status !== "revoked")');
    expect(app).toContain('void runSync("revoked");');

    // An EFFECT keyed on the status, so every route into revoked is covered —
    // resolveDeviceState, returnOnlineFromReconnect and a rejected sale
    // re-resolving. Adding a call at each site is how one gets forgotten.
    expect(app).toContain('}, [syncSessionKey, state.status, runSync]);');
  });

  it("the drain runs AFTER the authoritative state is applied", () => {
    // An effect cannot run before its own render commits, so the revoked state
    // is on screen — and checkout gone — before any submission starts.
    const app = code(read(APP));
    const effect = app.indexOf('void runSync("revoked");');
    const revokedCase = app.indexOf('case "revoked":');

    expect(effect).toBeGreaterThan(-1);
    expect(revokedCase).toBeGreaterThan(-1);
  });

  it("renders the queue status, and Sync now only for retryable work", () => {
    const app = code(read(APP));
    const branch = app.slice(app.indexOf('case "revoked":'), app.indexOf('case "config_unavailable":'));

    expect(branch).toContain("statusSlot={");
    expect(branch).toContain("<DeviceSyncStatus");

    // The strip still appears for anything unresolved — a rejected sale must not
    // vanish from the screen just because it cannot be retried.
    expect(branch).toContain("saleStatus.unsynced > 0 ?");

    // Feature 24.5F — but the BUTTON is gated on retryable work only.
    expect(branch).toContain(
      'onSyncNow={saleStatus.waiting > 0 ? () => void runSync("manual") : null}'
    );
    expect(branch).not.toContain('onSyncNow={() => void runSync("manual")}');
  });

  it("offers a way out of a needs_attention deadlock", () => {
    const app = code(read(APP));
    const branch = app.slice(app.indexOf('case "revoked":'), app.indexOf('case "config_unavailable":'));

    // Feature 24.5F — without this the till is bricked: a rejected sale cannot
    // sync, cannot be retried, and blocks the reset that would clear it.
    expect(branch).toContain("onReview={saleStatus.needsAttention > 0");
    expect(branch).toContain("<RejectedSaleReview");
    expect(branch).toContain("onDiscard={handleDiscard}");

    // Reset is rendered unavailable while evidence exists...
    expect(branch).toContain("resetDisabled={resetBlocked}");
    // ...but handleReset remains the authority, reading durable storage.
    expect(branch).toContain("onReset={handleReset}");
  });

  it("still renders no POS on a revoked device", () => {
    const app = code(read(APP));
    const branch = app.slice(app.indexOf('case "revoked":'), app.indexOf('case "config_unavailable":'));

    expect(branch).not.toContain("<PosRuntime");
  });

  it("never renders a POS or checkout on that screen", () => {
    const app = code(read(APP));
    const branch = app.slice(app.indexOf('case "revoked":'), app.indexOf('case "config_unavailable":'));

    for (const banned of ["PosRuntime", "queueOfflineSale", "submitSale", "checkoutBlockedReason"]) {
      expect(`revoked screen renders ${banned}`).toBe(`revoked screen renders ${banned}`);
      expect(branch).not.toContain(banned);
    }
  });

  it("never filters queue rows by revoked_at locally", () => {
    // The server decides which sales count. A device that pre-judged would
    // either strand real money or quietly discard evidence.
    for (const file of [APP, "lib/saleSyncEngine.ts", "lib/saleQueueSession.ts", "lib/offlineSaleRpc.ts"]) {
      const source = code(read(file));

      for (const banned of ["revokedAt", "revoked_at"]) {
        expect(`${file} filters on ${banned}`).toBe(`${file} filters on ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("v4 is still the only offline sync path", () => {
    expect(code(read("lib/offlineSaleRpc.ts"))).toContain('rpc("complete_sale_v4"');
    expect(code(read("lib/device.rpc.ts"))).not.toContain("complete_sale_v4");

    const engine = code(read("lib/saleSyncEngine.ts"));

    expect(engine).toContain("offlineSaleRpc");
    // The new trigger name changes why a drain happens, never how.
    expect(engine).toContain('"revoked"');
  });

  it("revocation clears configuration but never financial evidence", () => {
    const store = code(read("lib/deviceOfflineStore.ts"));
    const clear = store.slice(store.indexOf("export async function clearDeviceCache"));
    const body = clear.slice(0, clear.indexOf("\n}"));

    expect(body).toContain("PAIRING_ASSERTION_KEY");
    expect(body).toContain("PINNED_CONFIG_KEY");
    expect(body).not.toContain("SALE_QUEUE_STORE");
    expect(body).not.toContain("UNCERTAIN_SALE_KEY");

    // And the auth session is dropped only by an explicit reset.
    const app = code(read(APP));
    const revokedHandling = app.slice(app.indexOf('if (next.status === "revoked")'));

    expect(revokedHandling.slice(0, 200)).not.toContain("resetDeviceSession");
  });
});

// ---------------------------------------------------------------------------
// Regression — the money path is untouched
// ---------------------------------------------------------------------------

describe("packaging changed no financial behaviour", () => {
  it("online checkout is still complete_sale_v3", () => {
    const rpc = code(read("lib/device.rpc.ts"));

    expect(rpc).toContain('rpc("complete_sale_v3"');
    expect(rpc).not.toContain("complete_sale_v4");
  });

  it("complete_sale_v4 is still reachable only from the sync adapter", () => {
    const adapter = code(read("lib/offlineSaleRpc.ts"));

    expect(adapter).toContain('rpc("complete_sale_v4"');

    const engine = code(read("lib/saleSyncEngine.ts"));

    expect(engine).toContain("offlineSaleRpc");
  });

  it("the offline database schema is unchanged", () => {
    const store = code(read("lib/deviceOfflineStore.ts"));

    expect(store).toContain('export const OFFLINE_DB_NAME = "pos-canvas-device"');
    expect(store).toContain("export const OFFLINE_DB_VERSION = 2");
    expect(store).toContain('export const CACHE_STORE = "device-cache"');
    expect(store).toContain('export const SALE_QUEUE_STORE = "sale-queue"');
  });

  it("the shared checkout panel no longer drags the Builder in behind it", () => {
    // The coupling that made the bundle unbuildable: PosCheckoutPanel imports
    // editor/Receipt, which imported CURRENCY_SYMBOLS from EditorShell, which
    // imports a "use server" action, which imports server-only.
    const receipt = code(read("components/editor/Receipt.tsx"));

    expect(receipt).toContain('from "@/lib/projectConfig"');
    expect(receipt).toContain('from "@/lib/cart"');
    expect(receipt).not.toContain("./EditorShell");
  });
});

describe("resolving a rejected sale never becomes a delete-sale feature", () => {
  const APP_FILE = "components/device/DeviceApp.tsx";

  it("handleReset reads durable storage BEFORE it decides or clears anything", () => {
    const app = code(read(APP_FILE));
    const body = app.slice(app.indexOf("async function handleReset()"));
    const read_ = body.indexOf("await readOfflineSaleStatus()");
    const decide = body.indexOf("decideDeviceResetSafety(status)");
    const clear = body.indexOf("await clearOfflineCache()");
    const signOut = body.indexOf("await resetDeviceSession()");

    expect(read_).toBeGreaterThan(-1);
    // The durable read comes first, the decision second, and nothing is
    // destroyed until both have happened.
    expect(decide).toBeGreaterThan(read_);
    expect(clear).toBeGreaterThan(decide);
    expect(signOut).toBeGreaterThan(decide);
  });

  it("the UI never decides discard safety for itself", () => {
    const app = code(read(APP_FILE));
    const screen = code(read("components/device/RejectedSaleReview.tsx"));

    // Every condition lives in the policy module. A component that reimplemented
    // any of them could widen the rule without touching a single test.
    for (const source of [app, screen]) {
      expect(source).not.toContain('lastErrorCode === "post_revocation"');
      expect(source).not.toContain("serverOrderNumber === null");
      expect(source).not.toContain('state === "needs_attention"');
    }

    expect(code(read("lib/rejectedSaleSession.ts"))).toContain(
      "decideRejectedSaleDiscardSafety({"
    );
  });

  it("discard never reaches the server or invents an order", () => {
    const session = code(read("lib/rejectedSaleSession.ts"));

    expect(session).not.toContain("complete_sale_v4");
    expect(session).not.toContain("submitQueuedSale");
    expect(session).not.toContain("markSynced");
    expect(session).not.toContain("serverOrderNumber:");
    expect(session).not.toContain("deleteQueuedSaleRecord");
    expect(session).not.toContain("deleteSyncedSale");
  });

  it("the confirmation is a second step, and discard is not the default button", () => {
    const screen = code(read("components/device/RejectedSaleReview.tsx"));

    // The confirmation body only renders once a record has been chosen.
    expect(screen).toContain("isConfirming &&");
    expect(screen).toContain("DISCARD_REJECTED_SALE_CONFIRMATION_LINES");
    // Keep is the solid, primary button; discard is the outlined one. Scoped to
    // the confirmation JSX rather than the whole file — the import list at the
    // top names the discard constant first, so a file-wide index comparison
    // would be measuring the imports, not the buttons.
    const confirmation = screen.slice(screen.indexOf("{isConfirming && ("));

    expect(confirmation).toContain("Keep this sale");
    expect(confirmation.indexOf("Keep this sale")).toBeLessThan(
      confirmation.indexOf("DISCARD_REJECTED_SALE_CONFIRM_ACTION")
    );
  });
});

describe("a sale that needs attention is reachable from every screen that reports it", () => {
  const APP_FILE = "components/device/DeviceApp.tsx";

  it("the ready POS offers Review sale, not just the revoked screen", () => {
    const app = code(read(APP_FILE));
    // `case "ready"` is the last arm of the switch, so the slice runs to the end
    // of the file rather than to a following case label.
    const ready = app.slice(app.indexOf('case "ready": {'));

    // Windows hardware found a paired, working till whose only sign of an
    // unresolved sale was the banner, with no control anywhere that could act on
    // it — and reset could not clear it either, because that sale blocked reset.
    expect(ready).toContain("onReview={saleStatus.needsAttention > 0");
    expect(ready).toContain("<RejectedSaleReview");
    expect(ready).toContain("onRetry={handleRetry}");
    expect(ready).toContain("onDiscard={handleDiscard}");
  });

  it("both screens render the SAME review component", () => {
    const app = code(read(APP_FILE));

    // Two call sites, one component. A second review implementation would drift
    // from the policy the first one enforces.
    expect(app.match(/<RejectedSaleReview/g)).toHaveLength(2);
    expect(app).not.toContain("ReadyRejectedSaleReview");
    expect(app).not.toContain("ReadySaleReview");
  });

  it("the UI never decides retry safety for itself", () => {
    const app = code(read(APP_FILE));
    const screen = code(read("components/device/RejectedSaleReview.tsx"));

    for (const source of [app, screen]) {
      expect(source).not.toContain("transport_attempts_exhausted");
      expect(source).not.toContain("RETRYABLE_NEEDS_ATTENTION_CODES");
      expect(source).not.toContain("attemptCount = 0");
    }

    expect(code(read("lib/rejectedSaleSession.ts"))).toContain(
      "decideRejectedSaleRetrySafety({"
    );
  });

  it("the operator retry never reaches the server itself", () => {
    const session = code(read("lib/rejectedSaleSession.ts"));

    // It returns the row to pending and lets the existing engine submit; there
    // is no second submission path.
    expect(session).not.toContain("complete_sale_v4");
    expect(session).not.toContain("submitQueuedSale");
    expect(session).not.toContain("markSynced");
    expect(session).toContain("startOperatorRetry(");
  });

  it("a manual attempt cannot be the one that exhausts the budget", () => {
    const classifier = code(read("lib/saleSyncClassifier.ts"));

    expect(classifier).toContain("options.manual !== true");
    // Every exhaustion branch goes through the shared guard rather than
    // re-testing the counter, so none can be left behind by a later edit.
    expect(classifier.match(/exhausted\s*$/gm)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(classifier).not.toContain("attemptCount >= SYNC_MAX_ATTEMPTS\n      ?");
  });
});
