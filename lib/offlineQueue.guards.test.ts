// Feature 24.5C — guards for the durable sale queue.
//
// TWO JOBS. First, prove the fences that still matter hold: nothing submits,
// nothing enqueues from the UI, offline checkout is still closed, and online
// checkout still calls complete_sale_v3. Second, prove the queue stores a sale
// intent and nothing it has no business holding — no card data, no credential,
// no price it might later be trusted for.
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

const QUEUE = "lib/saleQueue.ts";
const SESSION = "lib/saleQueueSession.ts";
const STORE = "lib/deviceOfflineStore.ts";
const RUNTIME = "components/runtime/PosRuntime.tsx";
const DEVICE_APP = "components/device/DeviceApp.tsx";
const RPC = "lib/device.rpc.ts";

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
// The queue exists and is durable
// ---------------------------------------------------------------------------

describe("the queue is backed by IndexedDB, not memory", () => {
  it("adds a dedicated store at database version 2", () => {
    const store = code(read(STORE));

    expect(store).toContain("export const OFFLINE_DB_VERSION = 2");
    expect(store).toContain('export const SALE_QUEUE_STORE = "sale-queue"');
    expect((store.match(/createObjectStore\(/g) ?? []).length).toBe(2);
  });

  it("never drops or recreates the 24.5A cache store", () => {
    // A device upgrading from 24.5A may be relying on its pinned config to open
    // offline. The upgrade must not cost it that.
    const store = code(read(STORE));

    expect(store).not.toContain("deleteObjectStore");
    expect(store).toContain("if (!db.objectStoreNames.contains(CACHE_STORE))");
    expect(store).toContain("if (!db.objectStoreNames.contains(SALE_QUEUE_STORE))");
  });

  it("enforces one-sale-one-key in the storage engine, not in application code", () => {
    const store = code(read(STORE));

    expect(store).toContain('createIndex(SALE_QUEUE_REQUEST_ID_INDEX, "saleRequestId", { unique: true })');
  });

  it("enqueues with add, so an existing record can never be overwritten", () => {
    // `put` would silently replace a queued sale — the difference between
    // "queued once" and "an earlier sale just disappeared".
    const store = code(read(STORE));
    const insert = store.slice(store.indexOf("export async function insertQueuedSale"));

    expect(insert.slice(0, 400)).toContain("store.add(record)");
  });

  it("keeps no memory-only or localStorage fallback for a financial record", () => {
    const session = code(read(SESSION));

    expect(session).not.toContain("localStorage");
    expect(session).not.toContain("sessionStorage");

    // Every read and write goes through the database. A module-level cache
    // would be a second, non-durable source of truth for money — local arrays
    // INSIDE a function are just how results are collected and are fine.
    expect(session).toContain("await openOfflineDb()");
    expect(session).not.toMatch(/^(let|var)\s+\w+/m);
    expect(session).not.toMatch(/^const\s+\w+\s*(:\s*[^=]+)?=\s*(new Map|new Set|\[\])/m);
  });

  it("offers no bulk delete of queued sales", () => {
    // Owner-approved rule: queued sales are never silently discarded.
    const session = code(read(SESSION));
    const store = code(read(STORE));

    expect(session).not.toContain("clearQueue");
    expect(session).not.toContain("deleteAll");
    expect(store).not.toMatch(/SALE_QUEUE_STORE[\s\S]{0,120}store\.clear\(\)/);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("the idempotency key is durable and caller-owned", () => {
  it("enqueueSale accepts a saleRequestId rather than minting one", () => {
    // A function that generated its own key would produce a new one on every
    // retry, which is exactly how a crash-and-retry becomes two sales.
    const session = code(read(SESSION));

    expect(session).toContain("saleRequestId: string;");
    expect(session).not.toContain("crypto.randomUUID");
    expect(session).not.toContain("createSaleRequestId");
  });

  it("nothing in the queue regenerates a key on retry", () => {
    for (const file of [QUEUE, SESSION]) {
      const source = code(read(file));

      expect(`${file} mints a key`).toBe(`${file} mints a key`);
      expect(source).not.toContain("randomUUID");
    }
  });
});

// ---------------------------------------------------------------------------
// THE FENCES — nothing may submit or enqueue yet
// ---------------------------------------------------------------------------

describe("24.5C stores intents and submits nothing", () => {
  it("the queue never touches the network", () => {
    for (const file of [QUEUE, SESSION]) {
      const source = code(read(file));

      for (const banned of ["fetch(", "supabase", "rpc(", "complete_sale", "XMLHttpRequest"]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("no sync engine or retry loop exists", () => {
    for (const premature of ["lib/syncEngine.ts", "lib/offlineSync.ts", "lib/saleSync.ts"]) {
      expect(`exists early: ${premature}`).toBe(`exists early: ${premature}`);
      expect(exists(premature)).toBe(false);
    }

    for (const file of [QUEUE, SESSION]) {
      const source = code(read(file));

      expect(source).not.toContain("setInterval");
      expect(source).not.toContain("setTimeout");
      expect(source).not.toContain("addEventListener");
    }
  });

  it("NOTHING in the app calls enqueueSale yet", () => {
    // The single most important fence in this feature. 24.5E wires checkout.
    const callers = productSourceFiles()
      .filter((file) => file !== SESSION)
      .filter((file) => code(read(file)).includes("enqueueSale"));

    expect(callers).toEqual([]);
  });

  it("offline checkout remains fenced exactly as 24.5A left it", () => {
    const runtime = code(read(RUNTIME));
    const fence = runtime.indexOf("if (checkoutBlockedReason !== null)");
    const plan = runtime.indexOf("planSaleSubmission({");
    const submit = runtime.indexOf("await submitSale({");

    expect(fence).toBeGreaterThan(-1);
    expect(plan).toBeGreaterThan(fence);
    expect(submit).toBeGreaterThan(fence);

    const app = code(read(DEVICE_APP));

    expect(app).toContain('getDeviceRuntimeMode(state) === "offline_read_only"');
    expect(app).toContain("OFFLINE_CHECKOUT_BLOCKED_MESSAGE");
    expect(app).not.toContain("enqueueSale");
  });

  it("online checkout still calls complete_sale_v3, never v4", () => {
    const rpc = read(RPC);

    expect(rpc).toContain('rpc("complete_sale_v3"');
    expect(rpc).not.toContain("complete_sale_v4");

    // NARROWED BY 24.5D. The sync adapter now legitimately issues v4 — that is
    // the whole feature. What must still be true is that the CHECKOUT path
    // never touches it: an online sale goes to v3, and the runtime knows
    // nothing about the offline RPC.
    const callers = productSourceFiles().filter((file) =>
      code(read(file)).includes('rpc("complete_sale_v4"')
    );

    expect(callers).toEqual(["lib/offlineSaleRpc.ts"]);

    for (const file of [
      "lib/device.rpc.ts",
      "lib/saleSubmission.ts",
      "components/runtime/PosRuntime.tsx",
      "components/device/DeviceApp.tsx",
    ]) {
      expect(`${file}: complete_sale_v4`).toBe(`${file}: complete_sale_v4`);
      expect(code(read(file))).not.toContain("complete_sale_v4");
    }
  });

  it("no provisional receipt or owner queue UI was built", () => {
    for (const premature of [
      "components/device/OfflineReceipt.tsx",
      "components/device/DeviceQueueStatus.tsx",
      "lib/provisionalReceipt.ts",
      "lib/publishProgress.ts",
    ]) {
      expect(`exists early: ${premature}`).toBe(`exists early: ${premature}`);
      expect(exists(premature)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

describe("the queue holds a sale intent and nothing else", () => {
  it("has nowhere to put card data", () => {
    for (const file of [QUEUE, SESSION]) {
      const source = code(read(file)).toLowerCase();

      for (const banned of [
        "cardnumber",
        "card_number",
        "cvv",
        "cvc",
        "pan",
        "expiry",
        "cardholder",
        "track1",
        "track2",
        "magstripe",
      ]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("stores no credential of any kind", () => {
    for (const file of [QUEUE, SESSION]) {
      const source = code(read(file));

      for (const banned of [
        "service_role",
        "SERVICE_ROLE",
        "anon_key",
        "ANON_KEY",
        "access_token",
        "refresh_token",
        "password",
        "apiKey",
      ]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("stores no price, so no stored amount can ever be trusted as one", () => {
    // complete_sale_v4 prices from the pinned build snapshot and ignores
    // anything a client sends. A stored total would be a number that looks
    // authoritative, is never used, and would eventually be believed.
    const queue = code(read(QUEUE));

    for (const banned of ["unitPrice", "lineTotal", "subtotal", "taxAmount", "displayedTotal"]) {
      expect(`queue record carries ${banned}`).toBe(`queue record carries ${banned}`);
      expect(queue).not.toContain(banned);
    }
  });

  it("pins the payment method to the two the server accepts", () => {
    const queue = code(read(QUEUE));

    expect(queue).toContain('raw.paymentMethod !== "cash" && raw.paymentMethod !== "card"');
  });

  it("refuses a non-zero tip, which the server would reject anyway", () => {
    expect(code(read(QUEUE))).toContain("raw.tipAmount !== 0");
  });
});

// ---------------------------------------------------------------------------
// Regression
// ---------------------------------------------------------------------------

describe("24.5C changed nothing it was not meant to", () => {
  it("no migration was added", () => {
    const migrations = readdirSync(join(repoRoot, "supabase/migrations")).filter((f) =>
      f.endsWith(".sql")
    );

    expect(migrations).toHaveLength(17);
    expect(migrations).toContain("20260819120000_offline_sale_contract_and_complete_sale_v4.sql");
  });

  it("the 24.5A cache module still stores configuration only", () => {
    const cache = code(read("lib/deviceOfflineCache.ts"));

    for (const banned of ["QueuedSale", "saleRequestId", "paymentMethod"]) {
      expect(`cache: ${banned}`).toBe(`cache: ${banned}`);
      expect(cache).not.toContain(banned);
    }
  });

  it("Android and Windows branding and release metadata are untouched", () => {
    expect(read("android/app/src/main/res/values/styles.xml")).toContain(
      '<item name="windowSplashScreenBackground">@color/ic_launcher_background</item>'
    );
    expect(exists("windows-shell/build/icon.ico")).toBe(true);
    expect(read("lib/windowsRelease.ts")).toContain("isPrerelease: true");
    expect(read("lib/androidRelease.ts")).toContain(
      "aded13d8db6eaed8a4fdeb5e56cf1a12036df24b64f54eec8f98ff2feb910125"
    );
  });
});
