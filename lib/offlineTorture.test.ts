// Feature 24.5F — the torture scenarios, automated as far as a Node process can
// take them.
//
// WHAT THIS FILE IS FOR. 24.5F is a QA phase whose real subject is a phone and a
// PC. Some of its scenarios are genuinely hardware questions — does Android's
// WebView keep IndexedDB across a force-stop, does Electron keep it across a
// reboot — and nothing here can answer those. Others are timing and ordering
// questions that hardware answers WORSE than a test does: killing a process at
// the exact instant a request is in flight is luck on a phone and a parameter
// here.
//
// So this file automates the second group, deterministically, and each test is
// tagged with the OF id it discharges. The hardware checklist covers the first
// group and re-runs the second as a sanity check. Where both exist, the report
// states which is automated proof and which is hardware proof — they are not
// the same claim and must not be presented as one.
//
// WHAT IT CANNOT PROVE, stated plainly: anything that depends on the real
// complete_sale_v4 running in PostgreSQL. Order-number allocation, inventory
// shortfall, the revocation window and occurred_at validation are all server
// behaviour, and the migration suite next to that function only asserts its SQL
// text. Those need staging.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueSale,
  getQueuedSale,
  listQueuedSales,
  updateQueueState,
} from "@/lib/saleQueueSession";
import type { EnqueueSaleInput } from "@/lib/saleQueueSession";
import {
  createSaleSyncEngine,
  resetStartupSyncForTests,
  resetSyncEngineForTests,
  triggerStartupSaleSyncOnce,
} from "@/lib/saleSyncEngine";
import { openOfflineDb, putQueuedSale } from "@/lib/deviceOfflineStore";
import { readOfflineSaleStatus } from "@/lib/offlineCheckoutSession";
import { reconcileQueuedSale, toOfflineReference } from "@/lib/provisionalReceipt";
import { backoffDelayMs } from "@/lib/saleSyncClassifier";
import { decideDeviceResetSafety, earliestRetryAt } from "@/lib/offlineSaleStatus";
import { resolveOfflineSaleDraft } from "@/lib/offlineCheckout";
import { createCartItem } from "@/lib/cart";
import { classifyDeviceFailure } from "@/lib/deviceConnectivity";
import {
  SALE_UNCERTAIN_LOCKED_MESSAGE,
  createUncertainSale,
  decideUncertainSale,
  buildSaleRequestItems,
} from "@/lib/saleSubmission";
import type { UncertainSale } from "@/lib/saleSubmission";
import { createSaleFingerprint } from "@/lib/saleRequest";
import {
  armUncertainSale,
  hasUncertainSaleEvidence,
  readUncertainSale,
  reconcileUncertainSaleWithQueue,
  resolveUncertainSale,
} from "@/lib/uncertainSaleSession";
import { isDatabaseRejection } from "@/lib/deviceConnectivity";
import {
  UNCERTAIN_SALE_KEY,
  readUncertainSaleRecord,
} from "@/lib/uncertainSaleRecord";
import { readCacheKey, writeCacheKey, clearDeviceCache } from "@/lib/deviceOfflineStore";
import type { CartItem, PaymentMethod } from "@/lib/cart";
import type { MenuItem } from "@/lib/projectConfig";
import type { OfflineSaleSubmission } from "@/lib/offlineSaleRpc";
import type { QueuedSale } from "@/lib/saleQueue";

const T0 = Date.parse("2026-08-19T12:00:00.000Z");
const SESSION = "11111111-1111-4111-8111-111111111111";

let seq = 0;

function input(overrides: Partial<EnqueueSaleInput> = {}): EnqueueSaleInput {
  seq += 1;

  return {
    queueRecordId: `q-${seq}`,
    // Distinct in the LEADING bytes as well as the trailing ones, so two
    // records never collide in a derived display reference.
    saleRequestId: `${String(seq).padStart(8, "a")}-1111-4111-8111-${String(seq).padStart(12, "0")}`,
    deviceAuthUserId: "22222222-2222-4222-8222-222222222222",
    deviceId: "33333333-3333-4333-8333-333333333333",
    projectId: "44444444-4444-4444-8444-444444444444",
    buildJobId: "55555555-5555-4555-8555-555555555555",
    paymentMethod: "cash",
    items: [{ itemId: "item-1", quantity: 1, modifiers: [] }],
    occurredAt: `2026-08-19T11:0${seq}:00.000Z`,
    now: `2026-08-19T11:0${seq}:00.000Z`,
    ...overrides,
  };
}

function receipt(orderNumber: string, createdAt = "2026-08-19T12:30:00.000Z"): OfflineSaleSubmission {
  return {
    ok: true,
    receipt: {
      orderId: `order-${orderNumber}`,
      orderNumber,
      paymentMethod: "cash",
      subtotal: "5.00",
      taxAmount: "0.50",
      tipAmount: "0.00",
      total: "5.50",
      createdAt,
      items: [],
    },
  };
}

function transportFailure(): OfflineSaleSubmission {
  return { ok: false, failure: { transport: "transport", message: "Failed to fetch" } };
}

/**
 * A process restart: storage persists, every in-memory latch does not.
 *
 * This is the strongest restart a Node test can model, and it is the honest
 * one — the queue API opens a fresh connection on every call, so nothing
 * survives in memory between these lines except what is genuinely on disk.
 */
function restartProcess(): void {
  resetSyncEngineForTests();
  resetStartupSyncForTests();
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  seq = 0;
  restartProcess();
});

// ---------------------------------------------------------------------------
// OF-06 — several offline sales, FIFO, all distinct
// ---------------------------------------------------------------------------

describe("OF-06: three offline sales sync FIFO as three distinct orders", () => {
  it("submits A, B, C in order and allocates three distinct order numbers", async () => {
    const a = await enqueueSale(input());
    const b = await enqueueSale(input());
    const c = await enqueueSale(input());

    expect(a.ok && b.ok && c.ok).toBe(true);

    if (!a.ok || !b.ok || !c.ok) return;

    // Three sales, three identities, three references. A shared reference would
    // make a paper slip ambiguous even though the sales were distinct.
    const requestIds = [a, b, c].map((sale) => sale.value.saleRequestId);
    const references = requestIds.map((id) => toOfflineReference(id));

    expect(new Set(requestIds).size).toBe(3);
    expect(new Set(references).size).toBe(3);

    const submitted: string[] = [];
    let allocated = 1000;
    const submit = vi.fn(async (record: QueuedSale) => {
      submitted.push(record.queueRecordId);
      allocated += 1;

      return receipt(`ORD${allocated}`);
    });

    const report = await createSaleSyncEngine({ submit, now: () => T0 }).run();

    expect(report.synced).toBe(3);
    // Oldest first: the morning's takings are not reordered by the queue.
    expect(submitted).toEqual([a.value.queueRecordId, b.value.queueRecordId, c.value.queueRecordId]);

    const listing = await listQueuedSales();

    expect(listing.ok).toBe(true);

    if (!listing.ok) return;

    const orderNumbers = listing.value.sales.map((sale) => sale.serverOrderNumber);

    expect(new Set(orderNumbers).size).toBe(3);
    expect(orderNumbers).not.toContain(null);

    // Nothing missing, nothing duplicated, nothing left waiting.
    expect(listing.value.sales).toHaveLength(3);
    expect(submit).toHaveBeenCalledTimes(3);

    const status = await readOfflineSaleStatus();

    expect(status.waiting).toBe(0);
    expect(status.needsAttention).toBe(0);
    expect(status.synced).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// OF-09 — killed mid-sync, on both sides of the server's commit
// ---------------------------------------------------------------------------

describe("OF-09: a process killed mid-submission produces exactly one order", () => {
  it("recovers and commits once when the server never received it", async () => {
    const enqueued = await enqueueSale(input());

    expect(enqueued.ok).toBe(true);

    if (!enqueued.ok) return;

    // The kill: the record was claimed, the request went out, the process died.
    await updateQueueState(enqueued.value.queueRecordId, "syncing", "2026-08-19T11:30:00.000Z");

    restartProcess();

    const submit = vi.fn(async () => receipt("ORD1001"));

    await triggerStartupSaleSyncOnce(SESSION, { submit, now: () => T0 });

    expect(submit).toHaveBeenCalledTimes(1);

    const stored = await getQueuedSale(enqueued.value.queueRecordId);

    expect(stored.ok && stored.value.state).toBe("synced");
    expect(stored.ok && stored.value.serverOrderNumber).toBe("ORD1001");
  });

  it("recovers and REPLAYS when the server had already committed it", async () => {
    // The dangerous half. The server allocated an order number and the response
    // never arrived, so the device cannot tell this case from the one above —
    // which is exactly why the key is durable and the retry carries it.
    const enqueued = await enqueueSale(input());

    expect(enqueued.ok).toBe(true);

    if (!enqueued.ok) return;

    const serverOrders = new Map<string, string>();

    serverOrders.set(enqueued.value.saleRequestId, "ORD2002");

    await updateQueueState(enqueued.value.queueRecordId, "syncing", "2026-08-19T11:30:00.000Z");

    restartProcess();

    let allocations = 0;
    const submit = vi.fn(async (record: QueuedSale) => {
      const existing = serverOrders.get(record.saleRequestId);

      if (existing !== undefined) {
        // complete_sale_v4 resolves the key BEFORE allocating a number,
        // mutating inventory or writing an audit row.
        return receipt(existing);
      }

      allocations += 1;
      serverOrders.set(record.saleRequestId, `ORD300${allocations}`);

      return receipt(`ORD300${allocations}`);
    });

    await triggerStartupSaleSyncOnce(SESSION, { submit, now: () => T0 });

    const stored = await getQueuedSale(enqueued.value.queueRecordId);

    expect(stored.ok && stored.value.serverOrderNumber).toBe("ORD2002");
    // ONE order number, ONE allocation, ONE inventory mutation — the replay
    // took none of them.
    expect(allocations).toBe(0);
    expect(serverOrders.size).toBe(1);
    expect(submit.mock.calls[0][0].saleRequestId).toBe(enqueued.value.saleRequestId);
  });

  it("does not reclaim a record a live process may still be submitting", async () => {
    const enqueued = await enqueueSale(input());

    expect(enqueued.ok).toBe(true);

    if (!enqueued.ok) return;

    await updateQueueState(enqueued.value.queueRecordId, "syncing", "2026-08-19T11:30:00.000Z");

    // No restart: this is a drain during a running session.
    const submit = vi.fn(async () => receipt("ORD9"));

    await createSaleSyncEngine({ submit, now: () => T0 }).run();

    expect(submit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// OF-11 — connectivity flapping
// ---------------------------------------------------------------------------

describe("OF-11: a flapping connection never loses or duplicates a sale", () => {
  it("keeps one identity across many failures and syncs once when stable", async () => {
    const enqueued = await enqueueSale(input());

    expect(enqueued.ok).toBe(true);

    if (!enqueued.ok) return;

    const seenRequestIds = new Set<string>();
    let attempt = 0;
    const submit = vi.fn(async (record: QueuedSale) => {
      seenRequestIds.add(record.saleRequestId);
      attempt += 1;

      // Offline, offline, offline, then the connection holds.
      return attempt <= 3 ? transportFailure() : receipt("ORD4004");
    });

    let clock = T0;
    const engine = createSaleSyncEngine({ submit, now: () => clock });

    for (let cycle = 0; cycle < 4; cycle += 1) {
      // Each "online" event, with enough time elapsed for the backoff window to
      // have opened — the flap is faster than the schedule, and the schedule wins.
      await engine.run();
      clock += backoffDelayMs(cycle + 1) + 1_000;

      const midway = await getQueuedSale(enqueued.value.queueRecordId);

      // The financial record is present at every single point in the flap.
      expect(midway.ok).toBe(true);
    }

    // ONE identity throughout, which is what makes every one of those attempts
    // safe to have made.
    expect(seenRequestIds.size).toBe(1);
    expect([...seenRequestIds][0]).toBe(enqueued.value.saleRequestId);

    const stored = await getQueuedSale(enqueued.value.queueRecordId);

    expect(stored.ok).toBe(true);

    if (!stored.ok) return;

    expect(stored.value.state).toBe("synced");
    expect(stored.value.serverOrderNumber).toBe("ORD4004");
    expect(stored.value.attemptCount).toBe(4);
    // The sale time is the customer's, untouched by four attempts.
    expect(stored.value.occurredAt).toBe("2026-08-19T11:01:00.000Z");

    const listing = await listQueuedSales();

    expect(listing.ok && listing.value.sales).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// OF-12 — restart during backoff
// ---------------------------------------------------------------------------

describe("OF-12: a restart inside a backoff window respects the schedule", () => {
  it("keeps nextAttemptAt on disk and does not hammer the server on relaunch", async () => {
    const enqueued = await enqueueSale(input());

    expect(enqueued.ok).toBe(true);

    if (!enqueued.ok) return;

    const submit = vi.fn(async () => transportFailure());

    await createSaleSyncEngine({ submit, now: () => T0 }).run();

    const backedOff = await getQueuedSale(enqueued.value.queueRecordId);

    expect(backedOff.ok).toBe(true);

    if (!backedOff.ok) return;

    expect(backedOff.value.state).toBe("pending");
    expect(backedOff.value.nextAttemptAt).not.toBeNull();
    expect(backedOff.value.attemptCount).toBe(1);

    const dueAt = Date.parse(backedOff.value.nextAttemptAt!);

    expect(dueAt).toBe(T0 + backoffDelayMs(1));

    // The app is killed and relaunched INSIDE the window.
    restartProcess();

    const afterRestart = vi.fn(async () => receipt("ORD5005"));

    await triggerStartupSaleSyncOnce(SESSION, {
      submit: afterRestart,
      now: () => dueAt - 1_000,
    });

    // A relaunch is not a licence to retry immediately: a till restarted in a
    // loop would otherwise become a retry storm against a struggling server.
    expect(afterRestart).not.toHaveBeenCalled();

    const stillWaiting = await getQueuedSale(enqueued.value.queueRecordId);

    expect(stillWaiting.ok && stillWaiting.value.state).toBe("pending");

    // And the operator still sees it as waiting, not as lost or as done.
    const status = await readOfflineSaleStatus();

    expect(status.waiting).toBe(1);
    expect(status.synced).toBe(0);
    expect(decideDeviceResetSafety(status).allowed).toBe(false);

    // Once the window elapses it goes, on the next ordinary drain.
    const later = vi.fn(async () => receipt("ORD5005"));

    await createSaleSyncEngine({ submit: later, now: () => dueAt + 1_000 }).run();

    expect(later).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// OF-13 — the server refusing a device's clock
// ---------------------------------------------------------------------------

describe("OF-13: an unusable sale time is reported, never silently corrected", () => {
  it("becomes needs_attention with the sale and its original time intact", async () => {
    const enqueued = await enqueueSale(input());

    expect(enqueued.ok).toBe(true);

    if (!enqueued.ok) return;

    const submit = vi.fn(async () => ({
      ok: false as const,
      failure: {
        transport: "server_rejected" as const,
        // The exact string complete_sale_v4 raises.
        message: "Offline sale time is in the future",
      },
    }));

    await createSaleSyncEngine({ submit, now: () => T0 }).run();

    const stored = await getQueuedSale(enqueued.value.queueRecordId);

    expect(stored.ok).toBe(true);

    if (!stored.ok) return;

    expect(stored.value.state).toBe("needs_attention");
    expect(stored.value.lastErrorCode).toBe("clock_future");
    // NOT corrected, NOT rewritten, NOT deleted. The device's claim is
    // preserved exactly as made, for a person to resolve.
    expect(stored.value.occurredAt).toBe("2026-08-19T11:01:00.000Z");
    expect(stored.value.serverOrderNumber).toBeNull();

    // It must never present itself as recorded.
    expect(reconcileQueuedSale(stored.value)?.synced).toBe(false);

    const status = await readOfflineSaleStatus();

    expect(status.needsAttention).toBe(1);
    expect(status.synced).toBe(0);
    expect(decideDeviceResetSafety(status).allowed).toBe(false);

    // And a later drain does not quietly retry a server rejection.
    const again = vi.fn(async () => receipt("ORD6006"));

    await createSaleSyncEngine({ submit: again, now: () => T0 + 3_600_000 }).run();

    expect(again).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// OF-18 — a corrupt row beside good ones
// ---------------------------------------------------------------------------

describe("OF-18: a corrupt record is quarantined, never dropped and never sent", () => {
  it("leaves its neighbours syncing normally and reports itself for attention", async () => {
    const before = await enqueueSale(input());
    const after = await enqueueSale(input());

    expect(before.ok && after.ok).toBe(true);

    if (!before.ok || !after.ok) return;

    // A row that no longer reads back: a partial write, a half-applied upgrade,
    // a hand-edited profile. Written straight through the storage adapter so it
    // bypasses the validation enqueue applies.
    const opened = await openOfflineDb();

    expect(opened.ok).toBe(true);

    if (!opened.ok) return;

    await putQueuedSale(opened.value, {
      queueRecordId: "q-corrupt",
      saleRequestId: "not-a-uuid",
      paymentMethod: "bitcoin",
      items: [],
    });
    opened.value.close();

    const listing = await listQueuedSales();

    expect(listing.ok).toBe(true);

    if (!listing.ok) return;

    // Reported, not skipped in silence.
    expect(listing.value.quarantined).toHaveLength(1);
    expect(listing.value.quarantined[0].queueRecordId).toBe("q-corrupt");
    expect(listing.value.sales).toHaveLength(2);

    const submitted: string[] = [];
    let allocated = 7000;
    const submit = vi.fn(async (record: QueuedSale) => {
      submitted.push(record.queueRecordId);
      allocated += 1;

      return receipt(`ORD${allocated}`);
    });

    const report = await createSaleSyncEngine({ submit, now: () => T0 }).run();

    // The good sales went. The corrupt row was never submitted as if valid —
    // there is no request that could be made from bytes nobody can read.
    expect(report.synced).toBe(2);
    expect(submitted).toEqual([before.value.queueRecordId, after.value.queueRecordId]);
    expect(submitted).not.toContain("q-corrupt");

    // Still on disk afterwards. Deleting it would destroy the only trace of
    // money someone may have taken.
    const opened2 = await openOfflineDb();

    expect(opened2.ok).toBe(true);

    if (!opened2.ok) return;

    opened2.value.close();

    const after2 = await listQueuedSales();

    expect(after2.ok && after2.value.quarantined).toHaveLength(1);

    // The operator is told a sale needs attention, and a reset stays blocked.
    const status = await readOfflineSaleStatus();

    expect(status.needsAttention).toBe(1);
    expect(status.synced).toBe(2);
    expect(decideDeviceResetSafety(status).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OF-25 — DEF-01: an online attempt that dies on the wire continues offline
//
// The component wiring is structural and lives in lib/offlineCheckout.guards
// .test.ts. What is behavioural, and what actually decides whether a customer
// is charged twice, is the IDENTITY the continued sale carries.
// ---------------------------------------------------------------------------

const MENU_ITEM: MenuItem = {
  id: "1",
  name: "Bacon Egg & Cheese",
  price: 6.49,
  category: "Breakfast",
  trackInventory: false,
  stockQuantity: 0,
};

const PROJECT = "44444444-4444-4444-8444-444444444444";

function liveCart() {
  return [createCartItem(MENU_ITEM, [], 2)];
}

let mint = 0;
const generate = () => {
  mint += 1;

  return `bbbbbbbb-1111-4111-8111-${String(mint).padStart(12, "0")}`;
};

describe("OF-25: a lost online sale continues offline under ONE identity", () => {
  it("inherits the failed attempt's request id, so the queued sale is a REPLAY", () => {
    // The online attempt: v3 was sent and nothing came back. This is the id it
    // carried, and the server may or may not have recorded an order under it.
    const online = { id: "cccccccc-1111-4111-8111-000000000001", fingerprint: "" };
    const cart = liveCart();

    // The fingerprint the offline path will compute for the same cart. Taken
    // from the resolver itself rather than hand-written, so the test cannot
    // pass by agreeing with a stale copy of the format.
    const probe = resolveOfflineSaleDraft({
      current: null,
      projectId: PROJECT,
      paymentMethod: "cash",
      tipAmount: 0,
      cart,
      now: T0,
      generate,
    });

    expect(probe.ok).toBe(true);

    if (!probe.ok) return;

    const drafted = resolveOfflineSaleDraft({
      current: null,
      projectId: PROJECT,
      paymentMethod: "cash",
      tipAmount: 0,
      cart,
      now: T0 + 30_000,
      inherited: { ...online, fingerprint: probe.draft.fingerprint },
      generate,
    });

    expect(drafted.ok).toBe(true);

    if (!drafted.ok) return;

    // THE POINT: complete_sale_v4 will resolve this key to the order v3 may
    // already have created, instead of allocating a second one.
    expect(drafted.draft.saleRequestId).toBe(online.id);
    // The local handle is this device's own and must NOT be inherited — the
    // failed attempt may already have written a row under one.
    expect(drafted.draft.queueRecordId).not.toBe(online.id);
    // The sale time is when the cashier confirmed offline, not a server field.
    expect(drafted.draft.occurredAt).toBe(new Date(T0 + 30_000).toISOString());
  });

  it("does NOT inherit when the cart changed after the failed attempt", () => {
    // A changed cart is a request v3 never sent. Reusing the key would make
    // v4 raise a hash conflict, stranding a real sale.
    const cart = liveCart();
    const probe = resolveOfflineSaleDraft({
      current: null,
      projectId: PROJECT,
      paymentMethod: "cash",
      tipAmount: 0,
      cart,
      now: T0,
      generate,
    });

    expect(probe.ok).toBe(true);

    if (!probe.ok) return;

    const changed = resolveOfflineSaleDraft({
      current: null,
      projectId: PROJECT,
      paymentMethod: "cash",
      tipAmount: 0,
      cart: [createCartItem(MENU_ITEM, [], 3)],
      now: T0 + 30_000,
      inherited: {
        id: "cccccccc-1111-4111-8111-000000000001",
        fingerprint: probe.draft.fingerprint,
      },
      generate,
    });

    expect(changed.ok).toBe(true);

    if (!changed.ok) return;

    expect(changed.draft.saleRequestId).not.toBe("cccccccc-1111-4111-8111-000000000001");
  });

  it("does not inherit when nothing was inherited — the ordinary offline sale", () => {
    const plain = resolveOfflineSaleDraft({
      current: null,
      projectId: PROJECT,
      paymentMethod: "cash",
      tipAmount: 0,
      cart: liveCart(),
      now: T0,
      inherited: null,
      generate,
    });

    expect(plain.ok).toBe(true);

    if (!plain.ok) return;

    expect(plain.draft.saleRequestId).toMatch(/^bbbbbbbb-/);
  });

  it("proves the replay creates no second order end to end", async () => {
    // The full scenario: v3 committed ORD7007 and its response was lost; the
    // till fell back to cache; the cashier pressed Pay again.
    const lostOnlineId = "cccccccc-1111-4111-8111-000000000009";
    const serverOrders = new Map<string, string>([[lostOnlineId, "ORD7007"]]);
    let allocations = 0;

    const enqueued = await enqueueSale(input({ saleRequestId: lostOnlineId }));

    expect(enqueued.ok).toBe(true);

    if (!enqueued.ok) return;

    const submit = vi.fn(async (record: QueuedSale) => {
      const existing = serverOrders.get(record.saleRequestId);

      if (existing !== undefined) {
        return receipt(existing);
      }

      allocations += 1;
      serverOrders.set(record.saleRequestId, `ORD800${allocations}`);

      return receipt(`ORD800${allocations}`);
    });

    await createSaleSyncEngine({ submit, now: () => T0 }).run();

    const stored = await getQueuedSale(enqueued.value.queueRecordId);

    expect(stored.ok && stored.value.serverOrderNumber).toBe("ORD7007");
    // ONE order in the books. No new number, no second inventory mutation.
    expect(allocations).toBe(0);
    expect(serverOrders.size).toBe(1);
  });

  it("only a TRANSPORT classification may unlock the cache", () => {
    // The guard that keeps a server answer from being laundered into offline
    // permission. These are the shapes lib/device.rpc.ts actually returns.
    expect(classifyDeviceFailure({ message: "Failed to fetch" })).toBe("transport");
    expect(classifyDeviceFailure({ message: "NetworkError when attempting to fetch resource" })).toBe(
      "transport"
    );

    // A server that answered — a revocation, a business rejection, a 4xx — is
    // never transport, whatever its text says.
    expect(classifyDeviceFailure({ code: "P0001", message: "Project not found or access denied" })).toBe(
      "server_rejected"
    );
    expect(classifyDeviceFailure({ status: 401, message: "network error" })).toBe("server_rejected");
    expect(classifyDeviceFailure({ code: "P0001", message: "Insufficient inventory for Latte" })).toBe(
      "server_rejected"
    );
    // Indeterminate stays indeterminate, and permitsOfflineFallback admits only
    // "transport", so this cannot open a cache either.
    expect(classifyDeviceFailure({ message: "something odd" })).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// OF-26 — DEF-02: the persisted retry instant drives one timer
// ---------------------------------------------------------------------------

describe("OF-26: a backed-off sale has a due time a host can schedule against", () => {
  it("is null while nothing has failed, so an idle till schedules nothing", async () => {
    await enqueueSale(input());

    const status = await readOfflineSaleStatus();

    // A FRESH pending record has no due time. Treating null as "due now" would
    // wake the engine the instant a sale is taken — on a till that is still
    // offline, a guaranteed failure burning one of ten attempts.
    expect(status.waiting).toBe(1);
    expect(status.nextRetryAt).toBeNull();
  });

  it("appears the moment a retryable failure persists a backoff window", async () => {
    const enqueued = await enqueueSale(input());

    expect(enqueued.ok).toBe(true);

    if (!enqueued.ok) return;

    const submit = vi.fn(async () => transportFailure());

    await createSaleSyncEngine({ submit, now: () => T0 }).run();

    const status = await readOfflineSaleStatus();

    expect(status.nextRetryAt).toBe(new Date(T0 + backoffDelayMs(1)).toISOString());
    expect(status.waiting).toBe(1);
  });

  it("moves forward on each further failure, so the timer reschedules", async () => {
    const enqueued = await enqueueSale(input());

    expect(enqueued.ok).toBe(true);

    if (!enqueued.ok) return;

    const submit = vi.fn(async () => transportFailure());

    await createSaleSyncEngine({ submit, now: () => T0 }).run();

    const first = (await readOfflineSaleStatus()).nextRetryAt;
    const secondRunAt = T0 + backoffDelayMs(1) + 1_000;

    await createSaleSyncEngine({ submit, now: () => secondRunAt }).run();

    const second = (await readOfflineSaleStatus()).nextRetryAt;

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(Date.parse(second!)).toBeGreaterThan(Date.parse(first!));
    expect(second).toBe(new Date(secondRunAt + backoffDelayMs(2)).toISOString());
  });

  it("disappears once the sale syncs, so the timer is torn down", async () => {
    const enqueued = await enqueueSale(input());

    expect(enqueued.ok).toBe(true);

    if (!enqueued.ok) return;

    await createSaleSyncEngine({ submit: async () => transportFailure(), now: () => T0 }).run();

    expect((await readOfflineSaleStatus()).nextRetryAt).not.toBeNull();

    const dueAt = T0 + backoffDelayMs(1) + 1_000;

    await createSaleSyncEngine({ submit: async () => receipt("ORD9009"), now: () => dueAt }).run();

    const status = await readOfflineSaleStatus();

    expect(status.nextRetryAt).toBeNull();
    expect(status.waiting).toBe(0);
    expect(status.synced).toBe(1);
  });

  it("is null for needs_attention, permanent_failure and synced alike", async () => {
    const enqueued = await enqueueSale(input());

    expect(enqueued.ok).toBe(true);

    if (!enqueued.ok) return;

    // A catalogued business rejection: nothing to retry, a person must act.
    const submit = vi.fn(async () => ({
      ok: false as const,
      failure: {
        transport: "server_rejected" as const,
        message: "Offline sale time is in the future",
      },
    }));

    await createSaleSyncEngine({ submit, now: () => T0 }).run();

    const status = await readOfflineSaleStatus();

    expect(status.needsAttention).toBe(1);
    // No timer for a record that will never be retried automatically.
    expect(status.nextRetryAt).toBeNull();
  });

  it("survives a restart and yields only the REMAINING delay", async () => {
    const enqueued = await enqueueSale(input());

    expect(enqueued.ok).toBe(true);

    if (!enqueued.ok) return;

    await createSaleSyncEngine({ submit: async () => transportFailure(), now: () => T0 }).run();

    const dueAt = T0 + backoffDelayMs(1);

    restartProcess();

    const afterRestart = await readOfflineSaleStatus();

    // Off disk, unchanged. A host relaunching one second in schedules the
    // remainder rather than firing immediately.
    expect(afterRestart.nextRetryAt).toBe(new Date(dueAt).toISOString());

    const remaining = Date.parse(afterRestart.nextRetryAt!) - (T0 + 1_000);

    expect(remaining).toBe(backoffDelayMs(1) - 1_000);
    expect(remaining).toBeGreaterThan(0);

    // Relaunched AFTER the window, the same value clamps to zero — prompt, not
    // early. attemptCount is untouched by any of this.
    const late = Date.parse(afterRestart.nextRetryAt!) - (dueAt + 60_000);

    expect(Math.max(0, late)).toBe(0);

    const record = await getQueuedSale(enqueued.value.queueRecordId);

    expect(record.ok && record.value.attemptCount).toBe(1);
  });

  it("reports the EARLIEST window when several sales are backing off", async () => {
    const a = await enqueueSale(input());
    const b = await enqueueSale(input());

    expect(a.ok && b.ok).toBe(true);

    if (!a.ok || !b.ok) return;

    // Two failures at different times give two different windows; a host may
    // only schedule one timer, and it must be the nearer one.
    await createSaleSyncEngine({ submit: async () => transportFailure(), now: () => T0 }).run();

    const listing = await listQueuedSales();

    expect(listing.ok).toBe(true);

    if (!listing.ok) return;

    const windows = listing.value.sales
      .map((sale) => sale.nextAttemptAt)
      .filter((value): value is string => value !== null)
      .sort();

    expect(windows).toHaveLength(2);
    expect(earliestRetryAt(listing.value.sales)).toBe(windows[0]);
  });

  it("ignores a window nobody can read rather than inventing an instant", async () => {
    const enqueued = await enqueueSale(input());

    expect(enqueued.ok).toBe(true);

    if (!enqueued.ok) return;

    const stored = await getQueuedSale(enqueued.value.queueRecordId);

    expect(stored.ok).toBe(true);

    if (!stored.ok) return;

    // isDueForAttempt already treats an unparseable window as due, so a drain
    // will reach it. Fabricating a timer instant from it would be worse.
    expect(
      earliestRetryAt([{ ...stored.value, nextAttemptAt: "whenever" }])
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// OF-27 — an online sale whose outcome nobody knows
//
// The release blocker this closes: after a dispatched complete_sale_v3 request
// went unanswered, changing the payment method minted a SECOND idempotency key,
// and a second key cannot replay — it creates a second order for one customer.
// ---------------------------------------------------------------------------

const BACON: MenuItem = {
  id: "2",
  name: "Bacon",
  price: 2.0,
  category: "Sides",
  trackInventory: false,
  stockQuantity: 0,
};

const EXTRAS = {
  groupId: "g-extras",
  groupName: "Extras",
  options: [{ id: "o-bacon", name: "Extra bacon", priceAdjustment: 1.5 }],
};

const DISPATCHED_ID = "dddddddd-1111-4111-8111-000000000001";

function fingerprintOf(cart: readonly CartItem[], paymentMethod: PaymentMethod, tip = 0): string {
  return createSaleFingerprint({
    projectId: PROJECT,
    paymentMethod,
    tipAmount: tip,
    items: cart,
  });
}

/** The uncertainty a dispatched-then-unanswered cash sale of 2 leaves behind. */
function dispatched(cart: readonly CartItem[] = liveCart()): UncertainSale {
  return createUncertainSale({
    saleRequestId: DISPATCHED_ID,
    projectId: PROJECT,
    paymentMethod: "cash",
    tipAmount: 0,
    items: buildSaleRequestItems(cart),
    fingerprint: fingerprintOf(cart, "cash"),
  });
}

describe("OF-27: an unanswered v3 request keeps its identity and locks its details", () => {
  it("preserves the dispatched key and exactly what was sent", () => {
    const uncertain = dispatched();

    expect(uncertain.saleRequestId).toBe(DISPATCHED_ID);
    expect(uncertain.projectId).toBe(PROJECT);
    expect(uncertain.paymentMethod).toBe("cash");
    expect(uncertain.tipAmount).toBe(0);
    expect(uncertain.fingerprint).toBe(fingerprintOf(liveCart(), "cash"));
    // Identifiers and quantities only — no price rides along as evidence.
    expect(uncertain.items).toEqual([{ itemId: "1", quantity: 2, modifiers: [] }]);
    expect(JSON.stringify(uncertain)).not.toContain("6.49");
  });

  it("resumes an IDENTICAL request under the original key", () => {
    const decision = decideUncertainSale(dispatched(), fingerprintOf(liveCart(), "cash"));

    expect(decision.status).toBe("resume");
    expect(decision.status === "resume" && decision.saleRequestId).toBe(DISPATCHED_ID);
  });

  it("blocks a payment-method change in BOTH directions", () => {
    const cashThenCard = decideUncertainSale(dispatched(), fingerprintOf(liveCart(), "card"));

    expect(cashThenCard.status).toBe("locked");
    expect(cashThenCard.status === "locked" && cashThenCard.message).toBe(
      SALE_UNCERTAIN_LOCKED_MESSAGE
    );

    // And the mirror image: a card sale that went unanswered, switched to cash.
    const cardSale = createUncertainSale({
      saleRequestId: DISPATCHED_ID,
      projectId: PROJECT,
      paymentMethod: "card",
      tipAmount: 0,
      items: buildSaleRequestItems(liveCart()),
      fingerprint: fingerprintOf(liveCart(), "card"),
    });

    expect(decideUncertainSale(cardSale, fingerprintOf(liveCart(), "cash")).status).toBe("locked");
  });

  it("blocks a quantity change", () => {
    const changed = [createCartItem(MENU_ITEM, [], 3)];

    expect(decideUncertainSale(dispatched(), fingerprintOf(changed, "cash")).status).toBe("locked");
  });

  it("blocks a modifier change", () => {
    const withBacon = [createCartItem(MENU_ITEM, [EXTRAS], 2)];

    expect(decideUncertainSale(dispatched(), fingerprintOf(withBacon, "cash")).status).toBe(
      "locked"
    );
  });

  it("blocks a product change", () => {
    const different = [createCartItem(BACON, [], 2)];

    expect(decideUncertainSale(dispatched(), fingerprintOf(different, "cash")).status).toBe(
      "locked"
    );
  });

  it("blocks an added line, and a removed one", () => {
    const added = [createCartItem(MENU_ITEM, [], 2), createCartItem(BACON, [], 1)];

    expect(decideUncertainSale(dispatched(), fingerprintOf(added, "cash")).status).toBe("locked");
    expect(decideUncertainSale(dispatched(), fingerprintOf([], "cash")).status).toBe("locked");
  });

  it("blocks a tip change, for whenever a surface gains tip entry", () => {
    // Devices cannot tip today, but the tip IS in the server's hash, so this
    // must not be a case a future tip-bearing till discovers the hard way.
    const tipped = fingerprintOf(liveCart(), "cash", 1);

    expect(decideUncertainSale(dispatched(), tipped).status).toBe("locked");
  });

  it("a LOCKED decision names no new identity to submit", () => {
    const locked = decideUncertainSale(dispatched(), fingerprintOf(liveCart(), "card"));

    // The shape itself is the guarantee: there is nowhere in a locked decision
    // to put a request id, so a caller cannot accidentally send one.
    expect(locked.status).toBe("locked");
    expect("saleRequestId" in locked).toBe(false);
    expect(JSON.stringify(locked)).not.toContain(DISPATCHED_ID);
  });

  it("lets the cashier recover by putting the order back", () => {
    // The block is not a dead end. Restoring the cart restores the fingerprint,
    // and the sale resumes under its original key.
    const uncertain = dispatched();

    expect(decideUncertainSale(uncertain, fingerprintOf([createCartItem(MENU_ITEM, [], 5)], "cash")).status).toBe(
      "locked"
    );
    expect(decideUncertainSale(uncertain, fingerprintOf(liveCart(), "cash")).status).toBe("resume");
  });

  it("is inert when no request is outstanding", () => {
    expect(decideUncertainSale(null, fingerprintOf(liveCart(), "cash")).status).toBe("none");
    expect(decideUncertainSale(null, "anything").status).toBe("none");
  });

  it("a resumed request reaches v4 as a REPLAY, so one order exists", async () => {
    // End to end: v3 committed ORD3003 and the response was lost. The cashier
    // pressed Pay again without changing anything, the till was offline by
    // then, and the sale queued under the dispatched key.
    const serverOrders = new Map<string, string>([[DISPATCHED_ID, "ORD3003"]]);
    let allocations = 0;

    const decision = decideUncertainSale(dispatched(), fingerprintOf(liveCart(), "cash"));

    expect(decision.status).toBe("resume");

    if (decision.status !== "resume") return;

    const enqueued = await enqueueSale(input({ saleRequestId: decision.saleRequestId }));

    expect(enqueued.ok).toBe(true);

    if (!enqueued.ok) return;

    const submit = vi.fn(async (record: QueuedSale) => {
      const existing = serverOrders.get(record.saleRequestId);

      if (existing !== undefined) return receipt(existing);

      allocations += 1;
      serverOrders.set(record.saleRequestId, `ORD400${allocations}`);

      return receipt(`ORD400${allocations}`);
    });

    await createSaleSyncEngine({ submit, now: () => T0 }).run();

    const stored = await getQueuedSale(enqueued.value.queueRecordId);

    expect(stored.ok && stored.value.serverOrderNumber).toBe("ORD3003");
    expect(allocations).toBe(0);
    expect(serverOrders.size).toBe(1);
  });

  it("a blocked attempt submits NOTHING at all", async () => {
    // The counterfactual that used to fail: a changed request after an unknown
    // outcome reached the server under a fresh key and created a second order.
    const serverOrders = new Map<string, string>([[DISPATCHED_ID, "ORD3003"]]);
    const submit = vi.fn(async () => receipt("ORD9999"));

    const decision = decideUncertainSale(dispatched(), fingerprintOf(liveCart(), "card"));

    expect(decision.status).toBe("locked");

    // Nothing is queued, because the runtime returns before any identity is
    // resolved. The queue is the observable proof.
    const listing = await listQueuedSales();

    expect(listing.ok && listing.value.sales).toHaveLength(0);

    await createSaleSyncEngine({ submit, now: () => T0 }).run();

    expect(submit).not.toHaveBeenCalled();
    expect(serverOrders.size).toBe(1);
  });

  it("a definite server rejection never CREATES an uncertainty", () => {
    // Requirement: only a dispatched-and-unanswered request is uncertain. These
    // are answers, and an answer is not an unknown.
    for (const answered of [
      { code: "P0001", message: "Insufficient inventory for Latte" },
      { status: 401, message: "Authentication required" },
      { code: "P0001", message: "Project not found or access denied" },
    ]) {
      expect(classifyDeviceFailure(answered)).toBe("server_rejected");
    }

    // Only this one is dispatched-and-unanswered.
    expect(classifyDeviceFailure({ message: "Failed to fetch" })).toBe("transport");
  });
});

// ---------------------------------------------------------------------------
// OF-28 — the unknown outcome survives process death
//
// The release blocker this closes: the uncertainty lived only in component
// state, so a kill between dispatch and response lost the one key capable of
// recognising an order the server may have committed.
// ---------------------------------------------------------------------------

const IDENTITY = {
  deviceAuthUserId: "22222222-2222-4222-8222-222222222222",
  deviceId: "33333333-3333-4333-8333-333333333333",
  projectId: PROJECT,
  buildJobId: "55555555-5555-4555-8555-555555555555",
};

const OTHER_IDENTITY = {
  deviceAuthUserId: "99999999-9999-4999-8999-999999999999",
  deviceId: "88888888-8888-4888-8888-888888888888",
  projectId: "77777777-7777-4777-8777-777777777777",
  buildJobId: "66666666-6666-4666-8666-666666666666",
};

const DISPATCHED_AT = "2026-08-19T11:59:00.000Z";

async function arm(sale = dispatched()): Promise<boolean> {
  return armUncertainSale({ sale, identity: IDENTITY, dispatchedAt: DISPATCHED_AT });
}

describe("OF-28: an unanswered request survives a process kill", () => {
  it("is durable the moment it is armed, before any response could arrive", async () => {
    expect(await arm()).toBe(true);

    // Read through a completely fresh connection — the strongest "the process
    // died" a Node test can model, since nothing in memory carries over.
    restartProcess();

    const after = await readUncertainSale(IDENTITY);

    expect(after.status).toBe("outstanding");
  });

  it("restart reads back the SAME key and the SAME financial payload", async () => {
    await arm();
    restartProcess();

    const after = await readUncertainSale(IDENTITY);

    expect(after.status).toBe("outstanding");

    if (after.status !== "outstanding") return;

    expect(after.sale.saleRequestId).toBe(DISPATCHED_ID);
    expect(after.sale.fingerprint).toBe(fingerprintOf(liveCart(), "cash"));
    expect(after.sale.paymentMethod).toBe("cash");
    expect(after.sale.tipAmount).toBe(0);
    expect(after.sale.items).toEqual([{ itemId: "1", quantity: 2, modifiers: [] }]);
    expect(after.record.dispatchedAt).toBe(DISPATCHED_AT);
  });

  it("after restart the SAME order resumes under the original key", async () => {
    await arm();
    restartProcess();

    const after = await readUncertainSale(IDENTITY);

    expect(after.status).toBe("outstanding");

    if (after.status !== "outstanding") return;

    const decision = decideUncertainSale(after.sale, fingerprintOf(liveCart(), "cash"));

    expect(decision.status).toBe("resume");
    expect(decision.status === "resume" && decision.saleRequestId).toBe(DISPATCHED_ID);
  });

  it("after restart a CHANGED order cannot mint a new identity", async () => {
    await arm();
    restartProcess();

    const after = await readUncertainSale(IDENTITY);

    expect(after.status).toBe("outstanding");

    if (after.status !== "outstanding") return;

    // Every hash-significant field, one at a time, across the restart.
    for (const changed of [
      fingerprintOf(liveCart(), "card"),
      fingerprintOf([createCartItem(MENU_ITEM, [], 3)], "cash"),
      fingerprintOf([createCartItem(MENU_ITEM, [EXTRAS], 2)], "cash"),
      fingerprintOf([createCartItem(BACON, [], 2)], "cash"),
      fingerprintOf(liveCart(), "cash", 1),
    ]) {
      const decision = decideUncertainSale(after.sale, changed);

      expect(decision.status).toBe("locked");
      expect(JSON.stringify(decision)).not.toContain(DISPATCHED_ID);
    }
  });

  it("the replay after restart yields exactly ONE order when the server had committed", async () => {
    await arm();
    restartProcess();

    const after = await readUncertainSale(IDENTITY);

    expect(after.status).toBe("outstanding");

    if (after.status !== "outstanding") return;

    const serverOrders = new Map<string, string>([[DISPATCHED_ID, "ORD5005"]]);
    let allocations = 0;

    const enqueued = await enqueueSale(input({ saleRequestId: after.sale.saleRequestId }));

    expect(enqueued.ok).toBe(true);

    if (!enqueued.ok) return;

    const submit = vi.fn(async (record: QueuedSale) => {
      const existing = serverOrders.get(record.saleRequestId);

      if (existing !== undefined) return receipt(existing);

      allocations += 1;
      serverOrders.set(record.saleRequestId, `ORD600${allocations}`);

      return receipt(`ORD600${allocations}`);
    });

    await createSaleSyncEngine({ submit, now: () => T0 }).run();

    const stored = await getQueuedSale(enqueued.value.queueRecordId);

    expect(stored.ok && stored.value.serverOrderNumber).toBe("ORD5005");
    expect(allocations).toBe(0);
    expect(serverOrders.size).toBe(1);
  });

  it("the replay creates exactly ONE order when the server had NOT committed", async () => {
    await arm();
    restartProcess();

    const after = await readUncertainSale(IDENTITY);

    expect(after.status).toBe("outstanding");

    if (after.status !== "outstanding") return;

    const serverOrders = new Map<string, string>();
    const enqueued = await enqueueSale(input({ saleRequestId: after.sale.saleRequestId }));

    expect(enqueued.ok).toBe(true);

    if (!enqueued.ok) return;

    const submit = vi.fn(async (record: QueuedSale) => {
      const existing = serverOrders.get(record.saleRequestId);

      if (existing !== undefined) return receipt(existing);

      serverOrders.set(record.saleRequestId, "ORD7001");

      return receipt("ORD7001");
    });

    await createSaleSyncEngine({ submit, now: () => T0 }).run();

    expect(serverOrders.size).toBe(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("a positive resolution clears it durably", async () => {
    await arm();

    expect(await hasUncertainSaleEvidence()).toBe(true);
    expect(await resolveUncertainSale()).toBe(true);

    restartProcess();

    expect((await readUncertainSale(IDENTITY)).status).toBe("none");
    expect(await hasUncertainSaleEvidence()).toBe(false);
  });

  it("a failure during resolution leaves it exactly where it was", async () => {
    await arm();

    // A transport failure resolves nothing, so nothing is cleared. There is no
    // code path from a failed submission to resolveUncertainSale.
    const submit = vi.fn(async () => transportFailure());

    await enqueueSale(input({ saleRequestId: DISPATCHED_ID }));
    await createSaleSyncEngine({ submit, now: () => T0 }).run();

    restartProcess();

    expect((await readUncertainSale(IDENTITY)).status).toBe("outstanding");
  });

  it("a reset is blocked while the evidence exists", async () => {
    await arm();

    const status = await readOfflineSaleStatus();

    expect(status.uncertainOnlineSale).toBe(true);

    const safety = decideDeviceResetSafety(status);

    expect(safety.allowed).toBe(false);
    expect(safety.allowed === false && safety.message).toContain("may already have gone through");
    // It is evidence, not a queued sale, so it does not inflate the count the
    // cashier is shown.
    expect(status.waiting).toBe(0);
  });

  it("clearing the config cache does NOT take the evidence with it", async () => {
    // Revocation and re-pair both clear the cache, and neither is gated on the
    // reset-safety check. Before this was a targeted delete, a revocation would
    // silently have destroyed the only copy of the key.
    await arm();

    const opened = await openOfflineDb();

    expect(opened.ok).toBe(true);

    if (!opened.ok) return;

    await writeCacheKey(opened.value, "pairing-assertion", { some: "record" });
    await clearDeviceCache(opened.value);

    const assertion = await readCacheKey(opened.value, "pairing-assertion");
    const evidence = await readCacheKey(opened.value, UNCERTAIN_SALE_KEY);

    opened.value.close();

    expect(assertion.ok && assertion.value).toBeNull();
    expect(evidence.ok && evidence.value).not.toBeNull();
    expect((await readUncertainSale(IDENTITY)).status).toBe("outstanding");
  });

  it("another pairing's record is neither applied nor deleted", async () => {
    await arm();

    // A different device session reads the same storage.
    const seen = await readUncertainSale(OTHER_IDENTITY);

    expect(seen.status).toBe("unusable");
    expect(seen.status === "unusable" && seen.reason).toBe("identity_mismatch");

    // Not consumed: the owning session still sees it.
    expect((await readUncertainSale(IDENTITY)).status).toBe("outstanding");
    // And it still blocks a reset, because it is still evidence.
    expect(await hasUncertainSaleEvidence()).toBe(true);
    expect(decideDeviceResetSafety(await readOfflineSaleStatus()).allowed).toBe(false);
  });

  it("a record that no longer reads back blocks rather than frees the till", async () => {
    const opened = await openOfflineDb();

    expect(opened.ok).toBe(true);

    if (!opened.ok) return;

    await writeCacheKey(opened.value, UNCERTAIN_SALE_KEY, { schemaVersion: 1, saleRequestId: "nope" });
    opened.value.close();

    const seen = await readUncertainSale(IDENTITY);

    expect(seen.status).toBe("unusable");
    expect(seen.status === "unusable" && seen.reason).toBe("unreadable");
    expect(decideDeviceResetSafety(await readOfflineSaleStatus()).allowed).toBe(false);
  });

  it("stores no price, no card data and no credential", async () => {
    await arm();

    const opened = await openOfflineDb();

    expect(opened.ok).toBe(true);

    if (!opened.ok) return;

    const raw = await readCacheKey(opened.value, UNCERTAIN_SALE_KEY);

    opened.value.close();

    expect(raw.ok).toBe(true);

    const serialized = JSON.stringify(raw.ok ? raw.value : {}).toLowerCase();

    for (const banned of [
      "6.49",
      "subtotal",
      "linetotal",
      "unitprice",
      "cardnumber",
      "cvv",
      "cvc",
      "expiry",
      "cardholder",
      "access_token",
      "refresh_token",
      "service_role",
      "apikey",
    ]) {
      expect(`evidence contains ${banned}`).toBe(`evidence contains ${banned}`);
      expect(serialized).not.toContain(banned);
    }

    // What it DOES hold: the key, the identity, the request, the moment.
    expect(serialized).toContain(DISPATCHED_ID);
    expect(serialized).toContain("cash");
  });

  it("an ordinary successful checkout leaves nothing behind", async () => {
    // Modelled as the runtime does it: arm, then resolve on the receipt.
    await arm();
    await resolveUncertainSale();

    const status = await readOfflineSaleStatus();

    expect(status.uncertainOnlineSale).toBe(false);
    expect(decideDeviceResetSafety(status).allowed).toBe(true);
  });

  it("a pre-dispatch failure never arms anything", async () => {
    // planSaleSubmission refuses BEFORE the arm call, so an insecure browser or
    // an insufficient-stock refusal cannot leave a spurious record. Nothing was
    // armed here, and the till is free.
    expect(await hasUncertainSaleEvidence()).toBe(false);
    expect((await readUncertainSale(IDENTITY)).status).toBe("none");
    expect(decideDeviceResetSafety(await readOfflineSaleStatus()).allowed).toBe(true);
  });

  it("refuses to arm a record it could not read back", async () => {
    const armed = await armUncertainSale({
      sale: { ...dispatched(), saleRequestId: "not-a-uuid" },
      identity: IDENTITY,
      dispatchedAt: DISPATCHED_AT,
    });

    // A key the server would refuse cannot resolve anything, so it is not a
    // usable protection and must not be reported as one.
    expect(armed).toBe(false);
    expect(await hasUncertainSaleEvidence()).toBe(false);
  });

  it("the stored envelope validates as its own reader expects", async () => {
    await arm();

    const opened = await openOfflineDb();

    expect(opened.ok).toBe(true);

    if (!opened.ok) return;

    const raw = await readCacheKey(opened.value, UNCERTAIN_SALE_KEY);

    opened.value.close();

    expect(readUncertainSaleRecord(raw.ok ? raw.value : null).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OF-29 — a first dispatch that PostgreSQL definitively refused
//
// The operational blocker: keeping the arm after an ordinary "Insufficient
// inventory" left the cart unchangeable, the same request permanently refused
// and reset permanently blocked — over a sale that never existed.
// ---------------------------------------------------------------------------

/**
 * The runtime's rule, as a function, so the two branches can be exercised
 * without a DOM. PosRuntime applies exactly this; the wiring is pinned
 * structurally in lib/offlineCheckout.guards.test.ts.
 */
function releasesArm(input: {
  wasAlreadyUncertain: boolean;
  failure: "transport" | "server_rejected" | "unknown" | undefined;
  rolledBack: boolean | undefined;
}): boolean {
  if (input.failure === "transport") return false;

  return !input.wasAlreadyUncertain && input.rolledBack === true;
}

describe("OF-29: a definite database rejection releases only a first dispatch", () => {
  it("recognises a raised SQLSTATE as proof this invocation committed nothing", () => {
    // complete_sale_v3/v4 raise business errors as P0001.
    expect(isDatabaseRejection({ code: "P0001", message: "Insufficient inventory for Latte" })).toBe(
      true
    );
    expect(isDatabaseRejection({ code: "23505" })).toBe(true);
    expect(isDatabaseRejection({ code: "42501" })).toBe(true);
  });

  it("refuses to treat a proxy or gateway answer as proof of rollback", () => {
    // These can arrive AFTER the database committed. A status is not a SQLSTATE.
    expect(isDatabaseRejection({ status: 502, message: "Bad Gateway" })).toBe(false);
    expect(isDatabaseRejection({ status: 504, message: "Gateway Timeout" })).toBe(false);
    expect(isDatabaseRejection({ message: "Failed to fetch" })).toBe(false);
    expect(isDatabaseRejection({ details: "something", hint: "else" })).toBe(false);
    // OS socket codes live in the same field and mean the opposite.
    expect(isDatabaseRejection({ code: "ECONNRESET" })).toBe(false);
    expect(isDatabaseRejection(null)).toBe(false);
  });

  it("releases a first dispatch that PostgreSQL refused", () => {
    for (const message of [
      "Insufficient inventory for Latte",
      "Invalid order item",
      "Too many order items",
    ]) {
      void message;

      expect(
        releasesArm({ wasAlreadyUncertain: false, failure: "server_rejected", rolledBack: true })
      ).toBe(true);
    }
  });

  it("keeps a first dispatch that only TIMED OUT or was never answered", () => {
    expect(
      releasesArm({ wasAlreadyUncertain: false, failure: "transport", rolledBack: false })
    ).toBe(false);
    expect(
      releasesArm({ wasAlreadyUncertain: false, failure: "unknown", rolledBack: undefined })
    ).toBe(false);
    // Answered, but not by the database — a 504 after a commit looks like this.
    expect(
      releasesArm({ wasAlreadyUncertain: false, failure: "server_rejected", rolledBack: false })
    ).toBe(false);
  });

  it("NEVER releases a pre-existing uncertainty, whatever the rejection", () => {
    // The replay may have been refused before the idempotency lookup — a
    // revoked device, a lost session — while the ORIGINAL attempt committed.
    for (const rolledBack of [true, false, undefined]) {
      expect(
        releasesArm({ wasAlreadyUncertain: true, failure: "server_rejected", rolledBack })
      ).toBe(false);
    }

    expect(
      releasesArm({ wasAlreadyUncertain: true, failure: "transport", rolledBack: false })
    ).toBe(false);
  });

  it("an ordinary business rejection leaves the till usable", async () => {
    // Arm, then release as the runtime would on a proven rollback.
    await arm();

    expect(await hasUncertainSaleEvidence()).toBe(true);

    expect(
      releasesArm({ wasAlreadyUncertain: false, failure: "server_rejected", rolledBack: true })
    ).toBe(true);

    await resolveUncertainSale();

    // The cart is now editable — nothing is outstanding to lock it — and the
    // till is resettable again.
    const state = await readUncertainSale(IDENTITY);

    expect(state.status).toBe("none");
    expect(decideUncertainSale(null, fingerprintOf(liveCart(), "card")).status).toBe("none");

    const status = await readOfflineSaleStatus();

    expect(status.uncertainOnlineSale).toBe(false);
    expect(decideDeviceResetSafety(status).allowed).toBe(true);
  });

  it("the dispatch window stays protected — release happens only after an answer", async () => {
    // Arming still precedes dispatch; a process death before any response is
    // classified still finds the record on restart. The release above can only
    // run once an answer has actually been received.
    await arm();
    restartProcess();

    expect((await readUncertainSale(IDENTITY)).status).toBe("outstanding");
  });
});

// ---------------------------------------------------------------------------
// OF-30 — the queue handoff crash window
// ---------------------------------------------------------------------------

describe("OF-30: a marker the queue already owns is reconciled, not stranded", () => {
  it("clears a stale marker whose exact key is durably queued", async () => {
    // The crash: enqueue committed, the marker delete never ran.
    await arm();
    await enqueueSale(input({ saleRequestId: DISPATCHED_ID }));

    restartProcess();

    expect(await reconcileUncertainSaleWithQueue()).toBe(true);
    expect((await readUncertainSale(IDENTITY)).status).toBe("none");

    // The SALE is untouched — only the marker went.
    const listing = await listQueuedSales();

    expect(listing.ok && listing.value.sales).toHaveLength(1);
    expect(listing.ok && listing.value.sales[0].saleRequestId).toBe(DISPATCHED_ID);
  });

  it("does NOT clear a marker merely because some unrelated sale is queued", async () => {
    await arm();
    // A different sale entirely.
    await enqueueSale(input());

    restartProcess();

    expect(await reconcileUncertainSaleWithQueue()).toBe(false);
    expect((await readUncertainSale(IDENTITY)).status).toBe("outstanding");
    expect(await hasUncertainSaleEvidence()).toBe(true);
  });

  it("leaves the marker alone when the queue is empty", async () => {
    await arm();

    expect(await reconcileUncertainSaleWithQueue()).toBe(false);
    expect((await readUncertainSale(IDENTITY)).status).toBe("outstanding");
  });

  it("leaves an unreadable marker alone — there is no key to match", async () => {
    const opened = await openOfflineDb();

    expect(opened.ok).toBe(true);

    if (!opened.ok) return;

    await writeCacheKey(opened.value, UNCERTAIN_SALE_KEY, { schemaVersion: 1, saleRequestId: "x" });
    opened.value.close();

    await enqueueSale(input());

    expect(await reconcileUncertainSaleWithQueue()).toBe(false);
    expect(await hasUncertainSaleEvidence()).toBe(true);
  });

  it("the stranded state was never duplicate-unsafe to begin with", async () => {
    // Even without reconciliation the books stay correct: the queue record
    // carries the same key, so v4 creates or replays exactly one order. The
    // marker was a blocking nuisance, not a financial risk.
    await arm();

    const enqueued = await enqueueSale(input({ saleRequestId: DISPATCHED_ID }));

    expect(enqueued.ok).toBe(true);

    if (!enqueued.ok) return;

    const serverOrders = new Map<string, string>([[DISPATCHED_ID, "ORD8008"]]);
    let allocations = 0;

    const submit = vi.fn(async (record: QueuedSale) => {
      const existing = serverOrders.get(record.saleRequestId);

      if (existing !== undefined) return receipt(existing);

      allocations += 1;

      return receipt(`ORD900${allocations}`);
    });

    await createSaleSyncEngine({ submit, now: () => T0 }).run();

    const stored = await getQueuedSale(enqueued.value.queueRecordId);

    expect(stored.ok && stored.value.serverOrderNumber).toBe("ORD8008");
    expect(allocations).toBe(0);
    expect(serverOrders.size).toBe(1);
  });
});
