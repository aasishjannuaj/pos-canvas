// Feature 24.5E — guards for offline checkout.
//
// The properties this feature turns on are ARCHITECTURAL and none of them is
// visible in a behavioural test: which module may submit, which may persist,
// what order the runtime does things in, and what a receipt is allowed to say.
// The failure they protect against is never a wrong value — it is a sale that
// looks completed and is not on disk, or a provisional receipt that acquires an
// order number it has no right to.
//
// The ordering assertions are STRUCTURAL because the guarded property is an
// ordering one. A React component cannot be exercised under this repository's
// deliberately DOM-free vitest environment, but source order can be read, and
// "the cart is cleared only after the durable write succeeded" is exactly a
// statement about source order.
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
const RECEIPT = "components/runtime/OfflineReceipt.tsx";
const CHECKOUT = "lib/offlineCheckout.ts";
const CHECKOUT_SESSION = "lib/offlineCheckoutSession.ts";
const PROVISIONAL = "lib/provisionalReceipt.ts";
const STATUS = "lib/offlineSaleStatus.ts";
const RPC_ADAPTER = "lib/offlineSaleRpc.ts";

const NEW_MODULES = [CHECKOUT, CHECKOUT_SESSION, PROVISIONAL, STATUS];

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
// Checkout never submits
// ---------------------------------------------------------------------------

describe("offline checkout persists and never submits", () => {
  it("no checkout surface names complete_sale_v4", () => {
    for (const file of [RUNTIME, PANEL, DEVICE_APP, RECEIPT, ...NEW_MODULES]) {
      expect(`${file}: complete_sale_v4`).toBe(`${file}: complete_sale_v4`);
      expect(code(read(file))).not.toContain("complete_sale_v4");
    }
  });

  it("the v4 adapter is still the only caller, and only the engine imports it", () => {
    const callers = productSourceFiles().filter((file) =>
      code(read(file)).includes('rpc("complete_sale_v4"')
    );

    expect(callers).toEqual([RPC_ADAPTER]);

    const importers = productSourceFiles().filter(
      (file) => file !== RPC_ADAPTER && code(read(file)).includes("offlineSaleRpc")
    );

    expect(importers).toEqual(["lib/saleSyncEngine.ts"]);
  });

  it("the offline path touches no network of its own", () => {
    for (const file of NEW_MODULES) {
      const source = code(read(file));

      for (const banned of ["fetch(", "supabase", "rpc(", "XMLHttpRequest", "WebSocket"]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("the durable write, not a submission, is what offline checkout does", () => {
    const session = code(read(CHECKOUT_SESSION));

    expect(session).toContain("await enqueueSale(");
    expect(session).toContain("@/lib/saleQueueSession");
  });

  it("a duplicate key is only a success when the stored sale is equivalent", () => {
    // "Something already holds this id" and "this sale is already saved" are
    // different statements, and only the second justifies telling a cashier the
    // sale is done.
    const session = code(read(CHECKOUT_SESSION));
    const duplicate = session.slice(session.indexOf('if (enqueued.reason === "duplicate_sale_request")'));
    const body = duplicate.slice(0, duplicate.indexOf("return {\n    ok: false,\n    reason: \"storage_write_failed\""));

    expect(body).toContain("isEquivalentOfflineSale(existing.value, attempted)");

    const equivalence = body.indexOf("isEquivalentOfflineSale(");
    const success = body.indexOf("ok: true");

    expect(equivalence).toBeGreaterThan(-1);
    expect(success).toBeGreaterThan(equivalence);

    // A non-equivalent record is a hard refusal, never a storage retry prompt.
    expect(body).toContain('reason: "conflicting_local_record"');
    expect(body).toContain("OFFLINE_SALE_CONFLICT_MESSAGE");
  });

  it("the equivalence check compares the money, the context and the moment", () => {
    const checkout = code(read(CHECKOUT));
    const compare = checkout.slice(checkout.indexOf("export function isEquivalentOfflineSale"));

    for (const field of [
      "saleRequestId",
      "queueRecordId",
      "deviceAuthUserId",
      "deviceId",
      "projectId",
      "buildJobId",
      "paymentMethod",
      "tipAmount",
      "source",
      "occurredAt",
      "canonicalItems",
    ]) {
      expect(`equivalence covers ${field}`).toBe(`equivalence covers ${field}`);
      expect(compare).toContain(field);
    }
  });
});

// ---------------------------------------------------------------------------
// Online checkout is untouched
// ---------------------------------------------------------------------------

describe("online checkout is exactly what it was", () => {
  it("the device still completes an online sale through complete_sale_v3", () => {
    const rpc = code(read("lib/device.rpc.ts"));

    expect(rpc).toContain('rpc("complete_sale_v3"');
    expect(rpc).not.toContain("complete_sale_v4");
    expect(rpc).not.toContain("enqueueSale");
    expect(code(read(DEVICE_APP))).toContain("completeDeviceSaleV3");
  });

  it("the online branch of the runtime is unchanged and still submits", () => {
    const runtime = code(read(RUNTIME));

    expect(runtime).toContain("planSaleSubmission({");
    expect(runtime).toContain("await submitSale({");
    expect(runtime).toContain("saleRequestId: plan.request.id");
    // The offline handler defaults to null, so every existing host — the owner
    // runtime and the Builder Preview — is byte-identical to before.
    expect(runtime).toContain("queueOfflineSale = null");
  });

  it("an online sale never enters the queue", () => {
    const runtime = code(read(RUNTIME));
    // The offline branch RETURNS before the online path, and the online path
    // has no enqueue in it at all.
    const online = runtime.slice(runtime.indexOf("planSaleSubmission({"));

    for (const banned of ["queueOfflineSale", "enqueue", "occurredAt", "offline_queued"]) {
      expect(`online path: ${banned}`).toBe(`online path: ${banned}`);
      expect(online).not.toContain(banned);
    }
  });

  it("the owner runtime and the Builder Preview never pass an offline handler", () => {
    for (const file of [
      "components/runtime/OwnerPosRuntime.tsx",
      "components/editor/EditorShell.tsx",
      "components/editor/EditorPreview.tsx",
    ]) {
      expect(`${file}: queueOfflineSale`).toBe(`${file}: queueOfflineSale`);
      expect(code(read(file))).not.toContain("queueOfflineSale");
    }
  });
});

// ---------------------------------------------------------------------------
// THE ORDERING RULE
// ---------------------------------------------------------------------------

describe("the UI says saved only after the sale is on disk", () => {
  const runtime = code(read(RUNTIME));
  const branch = runtime.slice(
    runtime.indexOf("if (queueOfflineSale !== null)"),
    runtime.indexOf("planSaleSubmission({")
  );

  it("the offline branch exists and sits inside completeSale", () => {
    expect(branch).not.toBe("");
    expect(branch).toContain("await queueOfflineSale({");
  });

  it("awaits the write, checks it, and only then clears the cart", () => {
    const write = branch.indexOf("await queueOfflineSale({");
    const check = branch.indexOf("if (!saved.ok)");
    const clear = branch.indexOf("clearCart();");
    const success = branch.indexOf('setCheckoutStatus("success")');
    const receipt = branch.indexOf("setLastProvisionalReceipt(saved.receipt)");

    for (const index of [write, check, clear, success, receipt]) {
      expect(index).toBeGreaterThan(-1);
    }

    expect(check).toBeGreaterThan(write);
    expect(clear).toBeGreaterThan(check);
    expect(success).toBeGreaterThan(check);
    expect(receipt).toBeGreaterThan(check);
  });

  it("the failure path returns before anything that would report success", () => {
    const failure = branch.slice(
      branch.indexOf("if (!saved.ok)"),
      branch.indexOf("clearCart();")
    );

    expect(failure).toContain("return;");
    expect(failure).toContain('setSaleSaveStatus("error")');
    expect(failure).not.toContain("clearCart");
    expect(failure).not.toContain('setCheckoutStatus("success")');
  });

  it("a durable success CONSUMES the sale's identity", () => {
    // The review's central question. If the draft survived a successful write,
    // a later cart that happened to hash the same would inherit this sale's
    // saleRequestId and occurredAt — a second customer's money recorded at the
    // first customer's time, under an idempotency key the server has already
    // seen. The clear must sit after the failure return, not before it.
    const app = code(read(DEVICE_APP));
    const handler = app.slice(
      app.indexOf("const queueOfflineSale:"),
      app.indexOf("const discardOfflineSaleDraft:")
    );

    expect(handler).not.toBe("");

    const write = handler.indexOf("await completeOfflineSale({");
    const failure = handler.indexOf("if (!outcome.ok)");
    const consume = handler.indexOf("offlineDraftRef.current = null;");

    for (const index of [write, failure, consume]) {
      expect(index).toBeGreaterThan(-1);
    }

    expect(failure).toBeGreaterThan(write);
    expect(consume).toBeGreaterThan(failure);

    // The failure branch keeps it, which is what makes a retry ONE sale.
    expect(handler.slice(failure, consume)).toContain("return { ok: false");
    expect(handler.slice(failure, consume)).not.toContain("offlineDraftRef.current = null");
  });

  it("an ended checkout attempt discards the identity too", () => {
    // The other half: a FAILED attempt keeps its identity for a retry, so
    // something has to void it when the attempt ends rather than retries.
    const app = code(read(DEVICE_APP));
    const runtime = code(read(RUNTIME));

    expect(app).toContain("const discardOfflineSaleDraft: PosRuntimeDiscardOfflineSaleDraft");
    expect(app).toContain("discardOfflineSaleDraft={offlineSaleAllowed ? discardOfflineSaleDraft : null}");
    // Supplied under the SAME condition as the sale handler: one capability.
    expect(app).toContain("queueOfflineSale={offlineSaleAllowed ? queueOfflineSale : null}");

    // And the runtime calls it when the checkout closes — cancelled or done.
    const close = runtime.slice(runtime.indexOf("function closeCheckout()"));

    expect(close.slice(0, 400)).toContain("discardOfflineSaleDraft?.();");
  });

  it("the identity is minted before the write and never after it", () => {
    const app = code(read(DEVICE_APP));
    const handler = app.slice(
      app.indexOf("const queueOfflineSale:"),
      app.indexOf("const discardOfflineSaleDraft:")
    );

    const now = handler.indexOf("const now = Date.now();");
    const mint = handler.indexOf("resolveOfflineSaleDraft({");
    const store = handler.indexOf("offlineDraftRef.current = drafted.draft;");
    const write = handler.indexOf("await completeOfflineSale({");

    expect(now).toBeGreaterThan(-1);
    expect(mint).toBeGreaterThan(now);
    expect(store).toBeGreaterThan(mint);
    expect(write).toBeGreaterThan(store);

    // occurredAt comes from the clock read at CONFIRMATION, not from a second
    // reading taken after validation finished.
    expect((handler.match(/Date\.now\(\)/g) ?? [])).toHaveLength(1);
  });

  it("there is no memory-only fallback under the durable write", () => {
    for (const file of [RUNTIME, DEVICE_APP, ...NEW_MODULES]) {
      const source = code(read(file));

      for (const banned of ["localStorage", "sessionStorage", "document.cookie"]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }

    // And no module-level mutable store standing in for one.
    for (const file of NEW_MODULES) {
      expect(`${file} holds module state`).toBe(`${file} holds module state`);
      expect(code(read(file))).not.toMatch(/^(let|var)\s+\w+/m);
      expect(code(read(file))).not.toMatch(
        /^const\s+\w+\s*(:\s*[^=]+)?=\s*(new Map|new Set|\[\])/m
      );
    }
  });

  it("the cart is never written to storage, so it cannot resurrect", () => {
    const runtimeSource = code(read(RUNTIME));

    expect(runtimeSource).not.toContain("indexedDB");
    expect(runtimeSource).not.toMatch(/setItem\(/);
    // The only cart persistence anywhere is the queued SALE, which is a
    // different thing: frozen, not editable, and never read back into a cart.
    expect(runtimeSource).not.toContain("enqueueSale");
  });
});

// ---------------------------------------------------------------------------
// The receipt
// ---------------------------------------------------------------------------

describe("the provisional receipt says the approved thing and nothing more", () => {
  it("uses the approved wording from the shared constants", () => {
    const receipt = code(read(RECEIPT));

    expect(receipt).toContain("OFFLINE_RECEIPT_BANNER");
    expect(receipt).toContain("OFFLINE_RECEIPT_EXPLANATION_LINES");
    expect(receipt).toContain("OFFLINE_RECEIPT_REFERENCE_LABEL");
    // Imported, never retyped, so the component cannot drift from the copy.
    expect(receipt).toContain('from "@/lib/provisionalReceipt"');
    expect(receipt).not.toContain('"OFFLINE RECEIPT"');
  });

  it("pins the approved copy itself", () => {
    const provisional = read(PROVISIONAL);

    expect(provisional).toContain('export const OFFLINE_RECEIPT_BANNER = "OFFLINE RECEIPT"');
    expect(provisional).toContain('"This sale is saved on this device"');
    expect(provisional).toContain('"and will sync when internet is restored."');
    expect(provisional).toContain('"A final receipt number will be created after sync."');
  });

  it("fabricates no order number, and has nowhere to put one", () => {
    const receipt = code(read(RECEIPT));
    const provisional = code(read(PROVISIONAL));

    for (const banned of ["orderNumber", "orderId", "orderPrefix", "ORD"]) {
      expect(`receipt component: ${banned}`).toBe(`receipt component: ${banned}`);
      expect(receipt).not.toContain(banned);
    }

    // The ProvisionalReceipt type carries no server field at all — not even a
    // nullable one, which is the shape that eventually gets filled in.
    const type = provisional.slice(
      provisional.indexOf("export type ProvisionalReceipt = {"),
      provisional.indexOf("export type ProvisionalReceiptFailure")
    );

    expect(type).not.toContain("orderNumber");
    expect(type).not.toContain("orderId");
    expect(type).not.toContain("createdAt");
  });

  it("prices from the pinned config through the existing POS arithmetic", () => {
    const provisional = code(read(PROVISIONAL));

    expect(provisional).toContain("calculateCartSummary(");
    expect(provisional).toContain("createCartItem(");
    expect(provisional).toContain("buildModifierSnapshot(");
    // No second pricing implementation: nothing here computes tax itself.
    expect(provisional).not.toContain("tax.rate");
    expect(provisional).not.toContain("pricesIncludeTax");
  });

  it("reuses the one printing mechanism rather than adding a second", () => {
    const runtime = code(read(RUNTIME));
    const panel = code(read(PANEL));

    // The same print-only region and the same Print Receipt button.
    expect((runtime.match(/receipt-print-area/g) ?? []).length).toBe(2);
    expect((panel.match(/window\.print\(\)/g) ?? []).length).toBe(1);
    expect(panel).toContain("<OfflineReceipt");
  });
});

// ---------------------------------------------------------------------------
// Money and card safety
// ---------------------------------------------------------------------------

describe("nothing new stores a price as authority or a card detail at all", () => {
  it("the queued payload is still identifiers and quantities", () => {
    const checkout = code(read(CHECKOUT));

    expect(checkout).toContain("buildSaleRequestItems(input.cart)");

    const builder = checkout.slice(checkout.indexOf("export function buildOfflineEnqueueInput"));

    for (const banned of ["price", "subtotal", "taxAmount", "total", "lineTotal"]) {
      expect(`enqueue input carries ${banned}`).toBe(`enqueue input carries ${banned}`);
      expect(builder).not.toContain(banned);
    }
  });

  it("holds no card data anywhere in the new modules or the receipt", () => {
    for (const file of [...NEW_MODULES, RECEIPT]) {
      const source = code(read(file)).toLowerCase();

      for (const banned of [
        "cardnumber",
        "card_number",
        "cvv",
        "cvc",
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
    for (const file of NEW_MODULES) {
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

  it("never claims POS Canvas approved a card payment", () => {
    const receipt = code(read(RECEIPT)).toLowerCase();

    for (const banned of ["approved", "authorized", "authorised", "captured", "declined"]) {
      expect(`receipt says ${banned}`).toBe(`receipt says ${banned}`);
      expect(receipt).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe("the decisions stay pure and the I/O stays thin", () => {
  it("the pure modules read no storage and no clock of their own", () => {
    for (const file of [CHECKOUT, PROVISIONAL, STATUS]) {
      const source = code(read(file));

      for (const banned of ["indexedDB", "openOfflineDb", "Date.now()", "navigator", "window."]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("the eligibility rule is shared with the read-only start, not re-derived", () => {
    // Selling from a cache must never clear a lower bar than opening from one.
    const checkout = code(read(CHECKOUT));

    expect(checkout).toContain("decideOfflineFallback({");
    expect(checkout).toContain("evaluateLease(");
    // No second opinion about what a valid cache is.
    expect(checkout).not.toContain("readPinnedConfig(");
    expect(checkout).not.toContain("digestConfig(");
  });

  it("the device host holds no persistence or receipt logic of its own", () => {
    const app = code(read(DEVICE_APP));

    for (const banned of [
      "enqueueSale",
      "indexedDB",
      "openOfflineDb",
      "buildProvisionalReceipt",
      "calculateCartSummary",
      "toOfflineReference",
    ]) {
      expect(`DeviceApp: ${banned}`).toBe(`DeviceApp: ${banned}`);
      expect(app).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// Unpair safety
// ---------------------------------------------------------------------------

describe("a reset cannot destroy unsynced financial records", () => {
  it("the reset checks safety BEFORE it clears or signs out anything", () => {
    const app = code(read(DEVICE_APP));
    const reset = app.slice(app.indexOf("async function handleReset()"));
    const body = reset.slice(0, reset.indexOf("\n  }"));

    const check = body.indexOf("decideDeviceResetSafety(");
    const refuse = body.indexOf("if (!safety.allowed)");
    const clear = body.indexOf("await clearOfflineCache();");
    const signOut = body.indexOf("await resetDeviceSession();");

    for (const index of [check, refuse, clear, signOut]) {
      expect(index).toBeGreaterThan(-1);
    }

    expect(refuse).toBeGreaterThan(check);
    expect(clear).toBeGreaterThan(refuse);
    expect(signOut).toBeGreaterThan(clear);

    // The refusal returns rather than falling through into the clear.
    expect(body.slice(refuse, clear)).toContain("return;");
  });

  it("no code path deletes the queue in bulk", () => {
    // clearDeviceCache clears the CONFIG store only; there is no queue-wide
    // delete anywhere, which is what makes this a storage-layer property and
    // not only a UI guard.
    const store = code(read("lib/deviceOfflineStore.ts"));

    expect(store).not.toMatch(/SALE_QUEUE_STORE[\s\S]{0,160}store\.clear\(\)/);
    expect(code(read("lib/deviceOfflineSession.ts"))).not.toContain("SALE_QUEUE_STORE");

    const deleters = productSourceFiles().filter((file) =>
      /deleteQueuedSaleRecord|deleteSyncedSale/.test(code(read(file)))
    );

    // Only the storage adapter that defines it and the guarded, synced-only
    // single delete in the queue API.
    expect(deleters.sort()).toEqual(["lib/deviceOfflineStore.ts", "lib/saleQueueSession.ts"]);
  });

  it("the single delete that exists refuses anything but a synced record", () => {
    const session = code(read("lib/saleQueueSession.ts"));
    const remove = session.slice(session.indexOf("export async function deleteSyncedSale"));

    expect(remove).toContain('if (parsed.record.state !== "synced")');
  });
});

// ---------------------------------------------------------------------------
// Cashier status
// ---------------------------------------------------------------------------

describe("the cashier is told the truth about what is waiting", () => {
  it("a needs_attention sale is never presented as synced", () => {
    const provisional = code(read(PROVISIONAL));

    expect(provisional).toContain('const synced = record.state === "synced"');
    expect(provisional).toContain("serverOrderNumber: synced ? record.serverOrderNumber : null");
  });

  it("the status strip counts sales, never percentages or progress", () => {
    const status = code(read(STATUS));
    const component = code(read("components/device/DeviceSyncStatus.tsx"));

    for (const banned of ["%", "percent", "progress", "Math.round"]) {
      expect(`status: ${banned}`).toBe(`status: ${banned}`);
      expect(status).not.toContain(banned);
      expect(component).not.toContain(banned);
    }
  });

  it("the startup latch is keyed by device session, not by process", () => {
    // A process can outlive a pairing: unpair and re-pair happen without a
    // reload. A bare boolean would deny the second session its startup pass
    // forever; a key collapses rerenders and remounts within one session while
    // letting a genuinely new session through.
    const engine = code(read("lib/saleSyncEngine.ts"));
    const app = code(read(DEVICE_APP));

    expect(engine).toContain("let startupSyncSessionKey: string | null = null");
    expect(engine).toContain("if (startupSyncSessionKey === sessionKey)");
    expect(engine).toContain("startupSyncSessionKey = sessionKey");
    expect(engine).not.toContain("startupSyncTriggered");

    // One call site, carrying the session key, and the effect keys on it.
    expect((app.match(/await triggerStartupSaleSyncOnce\(/g) ?? [])).toHaveLength(1);
    expect(app).toContain("triggerStartupSaleSyncOnce(syncSessionKey)");
    expect(app).toContain("}, [syncSessionKey]);");
    expect(app).not.toContain('triggerSaleSync("startup")');
  });

  it("the manual trigger is minimal, not a queue console", () => {
    const component = code(read("components/device/DeviceSyncStatus.tsx"));

    expect(component).toContain("Sync now");
    // No per-sale list, no retry-per-record, no timestamps.
    for (const banned of ["QueuedSale", "map((sale", "lastAttemptAt", "lastErrorCode"]) {
      expect(`sync status: ${banned}`).toBe(`sync status: ${banned}`);
      expect(component).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

describe("24.5E changed nothing it was not meant to", () => {
  it("no migration was added or changed", () => {
    const migrations = readdirSync(join(repoRoot, "supabase/migrations")).filter((file) =>
      file.endsWith(".sql")
    );

    expect(migrations).toHaveLength(17);
    expect(migrations).toContain("20260819120000_offline_sale_contract_and_complete_sale_v4.sql");
  });

  it("24.5F and the owner-facing queue UI have not begun", () => {
    for (const premature of [
      "components/devices/DeviceQueueStatus.tsx",
      "components/dashboard/DeviceSyncPanel.tsx",
      "lib/publishProgress.ts",
    ]) {
      expect(`exists early: ${premature}`).toBe(`exists early: ${premature}`);
      expect(exists(premature)).toBe(false);
    }
  });

  it("branding and release metadata are untouched", () => {
    expect(read("android/app/src/main/res/values/styles.xml")).toContain(
      '<item name="windowSplashScreenBackground">@color/ic_launcher_background</item>'
    );
    expect(exists("windows-shell/build/icon.ico")).toBe(true);
    expect(read("lib/windowsRelease.ts")).toContain("isPrerelease: true");
  });
});
