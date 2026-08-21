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
    const terminal = app.indexOf('setState(createDeviceError("offline"));', gate);

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
