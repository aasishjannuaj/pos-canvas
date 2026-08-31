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

  it("DEF-01: only a classified TRANSPORT failure may open the cache", () => {
    const app = code(read(DEVICE_APP));
    const runtime = code(read(RUNTIME));
    const rpc = code(read("lib/device.rpc.ts"));

    // The classification is the EXISTING one, surfaced rather than re-derived.
    //
    // Feature 25.4 — an auth call is classified by classifyAuthFailure, which
    // is that same classifier behind auth-js's own is-this-a-fetch-failure
    // predicate. What this guards is that NOTHING here invents a third answer,
    // so both established names satisfy it and an inline re-derivation does not.
    expect(rpc).toMatch(/failure: classify(Device|Auth)Failure\(error\)/);
    expect(rpc).toContain("failure: classifyDeviceFailure(thrown)");
    expect(rpc).toContain("failure: classifyAuthFailure(thrown)");
    expect(rpc).toContain('isAuthRetryableFetchError(error) ? "transport" : classifyDeviceFailure(error)');
    // A malformed body proves the server answered; it must never read as
    // transport.
    expect(rpc).toContain('failure: "server_rejected"');

    // The runtime records the unknown outcome ONLY on that verdict. (24.5F's
    // second review replaced the original boolean with an UncertainSale record;
    // the property guarded here is unchanged.)
    expect(runtime).toContain('if (failure === "transport") {');
    expect(runtime).toContain("setUncertainSale(");
    // Never from a message, never from the browser's own hint.
    expect(runtime).not.toContain("navigator.onLine");
    expect(app).not.toContain("navigator.onLine");
    expect(runtime).not.toContain("onlineTransportFailure");

    // And the host acts on the verdict, not on the text.
    const handler = app.slice(app.indexOf("const handleSaleRejected"));
    const body = handler.slice(0, handler.indexOf("];"));
    const transport = body.indexOf('rejection.failure === "transport"');
    const revocation = body.indexOf("isPossibleRevocationError(");

    expect(transport).toBeGreaterThan(-1);
    expect(revocation).toBeGreaterThan(transport);
    expect(body.slice(transport, revocation)).toContain("return;");
  });

  it("DEF-01: the transition reuses the validated cached start, and keeps the cart", () => {
    const app = code(read(DEVICE_APP));
    const transition = app.slice(
      app.indexOf("const enterOfflineFromTransportFailure"),
      app.indexOf("const handleSaleRejected")
    );

    expect(transition).not.toBe("");

    // The SAME eligibility a cold offline boot runs — lease, integrity,
    // identity, assertion. Not a hand-rolled subset.
    expect(transition).toContain("loadOfflineFallback({");
    expect(transition).toContain("if (!fallback.ok)");

    // resolveDeviceState would set `checking`, unmount PosRuntime and destroy
    // the cashier's cart — the one thing this path exists to protect.
    expect(transition).not.toContain("resolveDeviceState");
    expect(transition).not.toContain('status: "checking"');

    // It may only ever move a LIVE POS, and never manufacture authorization.
    expect(transition).toContain('if (previous.status !== "ready")');
    expect(transition).toContain("offline: fallback.offline");
    expect(transition).toContain("config: fallback.config");
    for (const banned of ["revokedAt: null", "leaseMs", "OFFLINE_DEVICE_LEASE_MS"]) {
      expect(`transition fabricates ${banned}`).toBe(`transition fabricates ${banned}`);
      expect(transition).not.toContain(banned);
    }
  });

  it("DEF-01: the continued sale inherits the failed attempt's identity", () => {
    const runtime = code(read(RUNTIME));

    // The duplicate-sale defence. Gated on the unknown-outcome decision, so a
    // key is inherited only when the request is genuinely the same one — and a
    // changed request is refused outright rather than given a second identity.
    expect(runtime).toContain("inheritedRequest: resumed,");
    expect(runtime).toContain('uncertainty.status === "resume"');

    // And released the moment a durable record owns it.
    const offline = runtime.slice(
      runtime.indexOf("if (queueOfflineSale !== null)"),
      runtime.indexOf("const plan = planSaleSubmission({")
    );
    const failure = offline.indexOf("if (!saved.ok)");
    const release = offline.indexOf("setSaleRequest(null);");
    const resolve = offline.indexOf("setUncertainSale(null);");
    const clear = offline.indexOf("clearCart();");

    expect(failure).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(failure);
    expect(resolve).toBeGreaterThan(failure);
    expect(clear).toBeGreaterThan(release);
    // The failure branch keeps BOTH the identity and the uncertainty, so a
    // retry is still the same sale and a changed one is still refused.
    const failureBranch = offline.slice(failure, release);

    expect(failureBranch).not.toContain("setSaleRequest(null)");
    expect(failureBranch).not.toContain("setUncertainSale(null)");
  });

  it("the unknown-outcome gate runs before ANY identity is resolved", () => {
    const runtime = code(read(RUNTIME));
    const gate = runtime.indexOf("const uncertainty = decideUncertainSale(");
    const locked = runtime.indexOf('if (uncertainty.status === "locked")');
    const queue = runtime.indexOf("await queueOfflineSale({");
    const plan = runtime.indexOf("planSaleSubmission({");
    const submit = runtime.indexOf("await submitSale({");

    for (const index of [gate, locked, queue, plan, submit]) {
      expect(index).toBeGreaterThan(-1);
    }

    // Governs BOTH paths: nothing offline and nothing online can start first.
    expect(queue).toBeGreaterThan(gate);
    expect(plan).toBeGreaterThan(gate);
    expect(submit).toBeGreaterThan(gate);
    expect(locked).toBeGreaterThan(gate);

    // And a lock RETURNS rather than falling through.
    expect(runtime.slice(locked, queue)).toContain("return;");
  });

  it("a locked attempt mints nothing and sends nothing", () => {
    const runtime = code(read(RUNTIME));
    const locked = runtime.indexOf('if (uncertainty.status === "locked")');
    const body = runtime.slice(locked, runtime.indexOf("const resumed ="));

    for (const banned of ["createSaleRequestId", "randomUUID", "planSaleSubmission", "submitSale", "queueOfflineSale"]) {
      expect(`locked branch reaches ${banned}`).toBe(`locked branch reaches ${banned}`);
      expect(body).not.toContain(banned);
    }
  });

  it("both paths resume the outstanding key rather than minting one", () => {
    const runtime = code(read(RUNTIME));

    expect(runtime).toContain("inheritedRequest: resumed,");
    expect(runtime).toContain("current: saleRequest ?? resumed,");
    expect(runtime).toContain('uncertainty.status === "resume"');
  });

  it("closing a checkout does NOT erase an unknown outcome", () => {
    // A cancel abandons a local intention; it cannot un-send a request that
    // already left the device.
    const runtime = code(read(RUNTIME));
    const close = runtime.slice(runtime.indexOf("function closeCheckout()"));
    const body = close.slice(0, close.indexOf("\n  }"));

    expect(body).not.toBe("");
    expect(body).toContain("discardOfflineSaleDraft?.();");
    expect(body).not.toContain("setUncertainSale");
  });

  it("uncertainty is created ONLY by a dispatched-and-unanswered request", () => {
    const runtime = code(read(RUNTIME));

    expect(runtime).toContain('if (failure === "transport") {');

    const create = runtime.indexOf("setUncertainSale(\n          createUncertainSale({");
    const transport = runtime.indexOf('if (failure === "transport") {');

    expect(create).toBeGreaterThan(transport);
    // It carries the key that was actually sent, not a fresh one.
    expect(runtime).toContain("saleRequestId: plan.request.id,");
    expect(runtime).toContain("fingerprint: plan.request.fingerprint,");
  });

  it("only a POSITIVE resolution clears it", () => {
    const runtime = code(read(RUNTIME));
    const clears = runtime.split("setUncertainSale(null)").length - 1;

    // Exactly two: an online receipt, and a durable offline enqueue.
    expect(clears).toBe(2);

    // Never on a rejection — authorization is checked before the idempotency
    // lookup, so a refusal proves nothing about the original request.
    const failure = runtime.indexOf("if (error || !receipt) {");
    const rejectReturn = runtime.indexOf("onSaleRejected?.({ message: error, failure });");

    expect(failure).toBeGreaterThan(-1);
    expect(runtime.slice(failure, rejectReturn)).not.toContain("setUncertainSale(null)");
  });

  it("the gate compares the SAME fingerprint the server hashes", () => {
    const submission = code(read("lib/saleSubmission.ts"));
    const decide = submission.slice(submission.indexOf("export function decideUncertainSale"));

    expect(decide).toContain("uncertain.fingerprint === fingerprint");
    // One comparison, not a per-field list that could miss a field.
    for (const banned of ["paymentMethod ===", "tipAmount ===", "items ==="]) {
      expect(`decide compares ${banned}`).toBe(`decide compares ${banned}`);
      expect(decide).not.toContain(banned);
    }

    // The runtime feeds it the real fingerprint, built from the live cart.
    const runtime = code(read(RUNTIME));

    expect(runtime).toContain("const fingerprint = createSaleFingerprint({");
  });

  it("the identity is made DURABLE before the request is dispatched", () => {
    // The ordering IS the fix. A record written only after a failure is
    // observed does not exist during the window where the process can die with
    // the request already on the wire.
    const runtime = code(read(RUNTIME));
    const arm = runtime.indexOf("await armOnlineSale(");
    const refuse = runtime.indexOf("if (!armed) {");
    const dispatch = runtime.indexOf("await submitSale({");

    for (const index of [arm, refuse, dispatch]) {
      expect(index).toBeGreaterThan(-1);
    }

    expect(dispatch).toBeGreaterThan(arm);
    expect(dispatch).toBeGreaterThan(refuse);

    // A failed arm REFUSES the sale — no memory-only fallback for an identity.
    const refusal = runtime.slice(refuse, dispatch);

    expect(refusal).toContain("SALE_UNPROTECTED_MESSAGE");
    expect(refusal).toContain("return;");
  });

  it("the durable copy outranks the component's own memory", () => {
    const runtime = code(read(RUNTIME));

    expect(runtime).toContain("persistedUncertainSale ?? uncertainSale");
  });

  it("the record is cleared only when the outcome is definitively KNOWN", () => {
    const runtime = code(read(RUNTIME));
    const clears = runtime.split("resolveOnlineSale?.()").length - 1;

    // Exactly three, each a known outcome: an online receipt, a durable offline
    // enqueue that takes over the key, and a first dispatch PostgreSQL provably
    // rolled back.
    expect(clears).toBe(3);

    // The rollback release is guarded on BOTH conditions — never on a rejection
    // alone, and never for a sale that was already uncertain beforehand.
    expect(runtime).toContain("} else if (!wasAlreadyUncertain && rolledBack === true) {");
    expect(runtime).toContain('const wasAlreadyUncertain = uncertainty.status === "resume";');

    // Nothing clears it between observing a failure and reporting it, other
    // than that one explicitly-guarded branch.
    const failure = runtime.indexOf("if (error || !receipt) {");
    const rollbackBranch = runtime.indexOf("} else if (!wasAlreadyUncertain && rolledBack === true) {");
    const reject = runtime.indexOf("onSaleRejected?.({ message: error, failure });");

    expect(rollbackBranch).toBeGreaterThan(failure);
    expect(runtime.slice(rollbackBranch, reject).split("resolveOnlineSale?.()").length - 1).toBe(1);

    // And the session layer deletes only through the one function.
    const session = code(read("lib/uncertainSaleSession.ts"));

    expect((session.match(/deleteUncertainSaleRecordRaw\(/g) ?? [])).toHaveLength(1);
    expect(session).toContain("export async function resolveUncertainSale");
  });

  it("a rollback release requires PostgreSQL to have raised, not merely answered", () => {
    // A proxy 502 or a gateway 504 can arrive AFTER a commit. Only a SQLSTATE
    // proves this invocation committed nothing.
    const connectivity = code(read("lib/deviceConnectivity.ts"));
    const fn = connectivity.slice(connectivity.indexOf("export function isDatabaseRejection"));
    const body = fn.slice(0, fn.indexOf("\n}"));

    expect(body).toContain("/^[0-9A-Z]{5}$/.test(normalized)");
    // A status alone is deliberately NOT evidence here.
    expect(body).not.toContain("error.status");
    expect(body).not.toContain("details");
    expect(body).not.toContain("hint");

    const rpc = code(read("lib/device.rpc.ts"));

    expect(rpc).toContain("rolledBack: isDatabaseRejection(error)");
  });

  it("the queue handoff is reconciled on an exact key, never on queue depth", () => {
    const session = code(read("lib/uncertainSaleSession.ts"));
    const fn = session.slice(session.indexOf("export async function reconcileUncertainSaleWithQueue"));

    expect(fn).toContain("getSaleByRequestId(parsed.record.saleRequestId)");
    // Never "the queue has something in it".
    expect(fn).not.toContain("listQueuedSales");
    expect(fn).not.toContain("countQueuedSales");
    // An unreadable marker has no key to match and is left alone.
    expect(fn).toContain("if (!parsed.ok) {");

    // And it runs before the session reads its outstanding request.
    const app = code(read(DEVICE_APP));
    const reconcile = app.indexOf("await reconcileUncertainSaleWithQueue();");
    const readBack = app.indexOf("const outstanding = await readUncertainSale({");

    expect(reconcile).toBeGreaterThan(-1);
    expect(readBack).toBeGreaterThan(reconcile);
  });

  it("evidence survives a cache clear, a revocation and a re-pair", () => {
    // clearDeviceCache used to be store.clear(), which would have taken the
    // outstanding key out along with the menu — silently, on revocation, which
    // is not gated on the reset-safety check.
    const store = code(read("lib/deviceOfflineStore.ts"));
    const clear = store.slice(store.indexOf("export async function clearDeviceCache"));
    const body = clear.slice(0, clear.indexOf("\n}"));

    expect(body).not.toContain("store.clear()");
    expect(body).toContain("PAIRING_ASSERTION_KEY");
    expect(body).toContain("PINNED_CONFIG_KEY");
    expect(body).not.toContain("UNCERTAIN_SALE_KEY");
  });

  it("a reset is blocked while the evidence exists", () => {
    const status = code(read("lib/offlineSaleStatus.ts"));
    const decide = status.slice(status.indexOf("export function decideDeviceResetSafety"));
    const gate = decide.indexOf("status.uncertainOnlineSale");
    const allow = decide.indexOf("return { allowed: true }");

    expect(gate).toBeGreaterThan(-1);
    // Checked BEFORE the "nothing unsynced, go ahead" branch.
    expect(allow).toBeGreaterThan(gate);
  });

  it("a mismatched or unreadable record is never deleted", () => {
    const session = code(read("lib/uncertainSaleSession.ts"));
    const read_ = session.slice(session.indexOf("export async function readUncertainSale"));
    const body = read_.slice(0, read_.indexOf("export async function resolveUncertainSale"));

    expect(body).toContain('status: "unusable", reason: "identity_mismatch"');
    expect(body).toContain('status: "unusable", reason: "unreadable"');
    // The read path deletes nothing, ever.
    expect(body).not.toContain("delete");
  });

  it("the persisted record holds no price, no card data and no credential", () => {
    const record = code(read("lib/uncertainSaleRecord.ts"));

    for (const banned of [
      "unitPrice",
      "lineTotal",
      "subtotal",
      "taxAmount",
      "cardNumber",
      "cvv",
      "expiry",
      "cardholder",
      "access_token",
      "refresh_token",
      "service_role",
      "apiKey",
    ]) {
      expect(`record carries ${banned}`).toBe(`record carries ${banned}`);
      expect(record).not.toContain(banned);
    }

    // And it never reaches for a second storage technology.
    for (const file of ["lib/uncertainSaleRecord.ts", "lib/uncertainSaleSession.ts"]) {
      const source = code(read(file));

      expect(`${file}: localStorage`).toBe(`${file}: localStorage`);
      expect(source).not.toContain("localStorage");
      expect(source).not.toContain("sessionStorage");
      expect(source).not.toContain("indexedDB.open");
    }
  });

  it("it lives in the existing database, not a new one", () => {
    const store = code(read("lib/deviceOfflineStore.ts"));

    // No second database, no version bump, no third object store.
    expect(store).toContain('export const OFFLINE_DB_NAME = "pos-canvas-device"');
    expect(store).toContain("export const OFFLINE_DB_VERSION = 2");
    expect((store.match(/createObjectStore\(/g) ?? [])).toHaveLength(2);
    expect(store).toContain("UNCERTAIN_SALE_KEY");
  });

  it("DEF-02: one timer, aimed at the persisted instant, with a teardown", () => {
    const app = code(read(DEVICE_APP));
    const effect = app.slice(app.indexOf("const dueAt = saleStatus.nextRetryAt;"));
    const body = effect.slice(0, effect.indexOf("}, [syncSessionKey, saleStatus.nextRetryAt, runSync]);"));

    expect(body).not.toBe("");
    // A real instant, not a poll.
    expect(body).toContain("setTimeout(");
    expect(app).not.toContain("setInterval");
    expect(body).toContain("Math.max(0, due - Date.now())");
    // Nothing scheduled -> no timer at all.
    expect(body).toContain("if (syncSessionKey === null || dueAt === null)");
    expect(body).toContain("return () => clearTimeout(timer);");
    // Keyed so an unchanged instant installs no second timer.
    expect(app).toContain("}, [syncSessionKey, saleStatus.nextRetryAt, runSync]);");
    // A scheduled retry is not a person pressing anything.
    expect(body).toContain('runSync("retry")');
    // The engine, not a second copy of the backoff curve.
    expect(app).not.toContain("backoffDelayMs");
    expect(app).not.toContain("SYNC_BACKOFF");
  });

  it("DEF-02: only a persisted, readable window is ever scheduled", () => {
    const status = code(read("lib/offlineSaleStatus.ts"));
    const fn = status.slice(status.indexOf("export function earliestRetryAt"));
    const body = fn.slice(0, fn.indexOf("\n}"));

    // Fresh pending records have no due time; treating null as "due now" would
    // wake the engine the instant a sale is taken.
    expect(body).toContain('record.state !== "pending" || record.nextAttemptAt === null');
    // A record in flight must not get a timer — that is a second submission.
    expect(body).not.toContain('"syncing"');
    // Unparseable is left to the drain rather than turned into an instant.
    expect(body).toContain("parseIsoTime(record.nextAttemptAt) === null");
    // Pure: no clock, no storage, no engine.
    for (const banned of ["Date.now()", "setTimeout", "indexedDB", "openOfflineDb"]) {
      expect(`earliestRetryAt uses ${banned}`).toBe(`earliestRetryAt uses ${banned}`);
      expect(body).not.toContain(banned);
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

    // NARROWED BY 25.1. This pinned the GLOBAL migration count, which made it a
    // tripwire for every future feature rather than a statement about this
    // phase. Timestamps sort, so the honest assertion is that nothing was added
    // at or before this phase's boundary — a later migration is somebody else's
    // business, and deleting or renaming one of these still fails.
    const OWNED_THROUGH = "20260819120000";

    expect(migrations.filter((file) => file.slice(0, 14) <= OWNED_THROUGH)).toHaveLength(17);
    expect(migrations).toContain("20260819120000_offline_sale_contract_and_complete_sale_v4.sql");
  });

  it("24.5F and the owner-facing queue UI have not begun", () => {
    for (const premature of [
      "components/devices/DeviceQueueStatus.tsx",
      "components/dashboard/DeviceSyncPanel.tsx",
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
    expect(read("lib/windowsRelease.ts")).toContain("isPrerelease: false");
  });
});
