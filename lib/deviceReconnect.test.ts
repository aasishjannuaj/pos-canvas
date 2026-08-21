// Feature 24.5F — regaining connectivity while the app stays open.
//
// THE HARDWARE FAILURE THIS PINS. An Android till took three sales offline, its
// internet came back while the app remained open, and nothing drained for
// thirty seconds. A fourth sale — taken after connectivity returned — went into
// the queue too. Only closing and reopening the app recovered it, because the
// startup trigger is a different path.
//
// Three separate causes, and all three had to be true at once:
//
//   1. the `online` event never fired (Android's manifest lacked
//      ACCESS_NETWORK_STATE, so Chromium could not observe the change);
//   2. the retry timer skips rows with no persisted nextAttemptAt, which fresh
//      sales are, so nothing else was scheduled to wake the engine;
//   3. the runtime mode was latched offline, which both routed the fourth sale
//      into the queue AND hid the Sync now button — the one manual recovery.
//
// The tests below model the reconnect EPISODE — refresh state, then drain — as
// DeviceApp performs it, so the sequence is deterministic without a DOM.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueSale, getQueuedSale, listQueuedSales } from "@/lib/saleQueueSession";
import type { EnqueueSaleInput } from "@/lib/saleQueueSession";
import {
  createSaleSyncEngine,
  resetStartupSyncForTests,
  resetSyncEngineForTests,
  subscribeToReconnect,
} from "@/lib/saleSyncEngine";
import { readOfflineSaleStatus } from "@/lib/offlineCheckoutSession";
import { backoffDelayMs } from "@/lib/saleSyncClassifier";
import { getDeviceRuntimeMode } from "@/lib/deviceSession";
import type { DevicePairing, DeviceState } from "@/lib/deviceSession";
import type { OfflineSaleSubmission } from "@/lib/offlineSaleRpc";
import type { QueuedSale } from "@/lib/saleQueue";
import type { GeneratedPosConfig } from "@/lib/generatedPosConfig";
import { createGeneratedPosConfig } from "@/lib/generatedPosConfig";
import { cloneProjectConfig, defaultProjectConfig } from "@/lib/projectConfig";

const T0 = Date.parse("2026-08-21T09:00:00.000Z");

const PAIRING: DevicePairing = {
  deviceId: "33333333-3333-4333-8333-333333333333",
  projectId: "44444444-4444-4444-8444-444444444444",
  buildJobId: "55555555-5555-4555-8555-555555555555",
  deviceName: "POS Device",
  platform: "android",
  createdAt: null,
  revokedAt: null,
};

function config(): GeneratedPosConfig {
  return createGeneratedPosConfig({
    projectId: PAIRING.projectId,
    projectName: "Corner Cafe",
    templateId: "cafe",
    config: cloneProjectConfig(defaultProjectConfig),
  });
}

let seq = 0;

function input(overrides: Partial<EnqueueSaleInput> = {}): EnqueueSaleInput {
  seq += 1;

  return {
    queueRecordId: `q-${seq}`,
    saleRequestId: `${String(seq).padStart(8, "a")}-1111-4111-8111-${String(seq).padStart(12, "0")}`,
    deviceAuthUserId: "22222222-2222-4222-8222-222222222222",
    deviceId: PAIRING.deviceId,
    projectId: PAIRING.projectId,
    buildJobId: PAIRING.buildJobId,
    paymentMethod: "cash",
    items: [{ itemId: "1", quantity: 1, modifiers: [] }],
    occurredAt: `2026-08-21T08:0${seq}:00.000Z`,
    now: `2026-08-21T08:0${seq}:00.000Z`,
    ...overrides,
  };
}

function receipt(orderNumber: string): OfflineSaleSubmission {
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
      createdAt: "2026-08-21T09:00:00Z",
      items: [],
    },
  };
}

function transportFailure(): OfflineSaleSubmission {
  return { ok: false, failure: { transport: "transport", message: "Failed to fetch" } };
}

/**
 * A stand-in for DeviceApp's reconnect episode, in the order the component runs
 * it: refresh authoritative state FIRST, then wake the sync engine. The order
 * is the point — a successful drain must never be able to leave a revoked till
 * looking healthy.
 */
function deviceModel(initial: DeviceState) {
  let state = initial;
  let cart: string[] = ["latte"];
  const draftIdentity: string | null = "draft-abc";

  return {
    read: (): DeviceState => state,
    mode: (): string => getDeviceRuntimeMode(state),
    cart: (): string[] => cart,
    draft: (): string | null => draftIdentity,
    addToCart: (item: string): void => {
      cart = [...cart, item];
    },
    /**
     * Where a NEW sale would go, exactly as DeviceApp decides it.
     *
     * "blocked" is not a mode — it is the absence of a POS. Only the `ready`
     * branch renders PosRuntime, so a revoked or reconnect-required device
     * cannot route a sale anywhere at all. getDeviceRuntimeMode answers
     * "online" for those states because it describes the RUNTIME, not
     * authorization, and conflating the two here would make this model claim a
     * revoked till could sell.
     */
    routeForNextSale: (): "offline-queue" | "online-v3" | "blocked" => {
      if (state.status !== "ready") {
        return "blocked";
      }

      return getDeviceRuntimeMode(state) === "offline" ? "offline-queue" : "online-v3";
    },
    /** The authoritative half of a reconnect episode. */
    refresh: async (server: {
      pairing: () => Promise<{ ok: boolean; revoked?: boolean }>;
    }): Promise<void> => {
      const answer = await server.pairing();

      if (!answer.ok) {
        // Transport again — captive portal, flapping. Change nothing.
        return;
      }

      if (answer.revoked === true) {
        state = { status: "revoked", pairing: PAIRING };
        return;
      }

      if (state.status !== "ready" || !state.offline) {
        return;
      }

      state = { ...state, offline: null };
    },
  };
}

function offlineReady(): DeviceState {
  return {
    status: "ready",
    pairing: PAIRING,
    config: config(),
    offline: {
      lastVerifiedAt: new Date(T0 - 3_600_000).toISOString(),
      leaseExpiresAt: new Date(T0 + 6 * 24 * 3_600_000).toISOString(),
      expiringSoon: false,
    },
  };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  seq = 0;
  resetSyncEngineForTests();
  resetStartupSyncForTests();
});

// ---------------------------------------------------------------------------
// The exact sequence hardware showed
// ---------------------------------------------------------------------------

describe("the observed hardware sequence, end to end", () => {
  it("drains without a restart and sends the NEXT sale online", async () => {
    // 1-3. offline, three queued sales
    const device = deviceModel(offlineReady());

    await enqueueSale(input());
    await enqueueSale(input());
    await enqueueSale(input());

    expect(device.mode()).toBe("offline");
    expect(device.routeForNextSale()).toBe("offline-queue");
    expect((await readOfflineSaleStatus()).waiting).toBe(3);

    // 4-5. connectivity returns; the app stays mounted. No restart anywhere.
    let allocated = 1000;
    const submit = vi.fn(async (record: QueuedSale) => {
      void record;
      allocated += 1;

      return receipt(`ORD${allocated}`);
    });

    await device.refresh({ pairing: async () => ({ ok: true }) });
    const report = await createSaleSyncEngine({ submit, now: () => T0 }).run();

    // 6. the queue drains
    expect(report.synced).toBe(3);
    expect((await readOfflineSaleStatus()).waiting).toBe(0);

    // 7-8. THE PART THAT FAILED ON HARDWARE: the next sale is an ONLINE sale.
    expect(device.mode()).toBe("online");
    expect(device.routeForNextSale()).toBe("online-v3");
  });

  it("keeps the cashier's cart and checkout identity across the refresh", async () => {
    const device = deviceModel(offlineReady());

    device.addToCart("croissant");

    const cartBefore = device.cart();
    const draftBefore = device.draft();

    await device.refresh({ pairing: async () => ({ ok: true }) });

    // The transition is in place: PosRuntime is never unmounted, so nothing it
    // owns is discarded. A cashier mid-sale notices only the banner clearing.
    expect(device.cart()).toEqual(cartBefore);
    expect(device.cart()).toContain("croissant");
    expect(device.draft()).toBe(draftBefore);
  });
});

// ---------------------------------------------------------------------------
// Authorization still wins
// ---------------------------------------------------------------------------

describe("a reconnect cannot launder a revocation", () => {
  it("a revoked answer does NOT return the till to online-ready", async () => {
    const device = deviceModel(offlineReady());

    await enqueueSale(input());

    await device.refresh({ pairing: async () => ({ ok: true, revoked: true }) });

    expect(device.read().status).toBe("revoked");
    // No POS is rendered at all, so no sale can be taken by any route.
    expect(device.routeForNextSale()).toBe("blocked");
  });

  it("the queued sale is preserved through a revocation", async () => {
    const device = deviceModel(offlineReady());

    await enqueueSale(input());
    await device.refresh({ pairing: async () => ({ ok: true, revoked: true }) });

    // Money taken before a revocation is still money. complete_sale_v4 decides
    // which sales it accepts; the device destroys nothing.
    const listing = await listQueuedSales();

    expect(listing.ok && listing.value.sales).toHaveLength(1);
    expect((await readOfflineSaleStatus()).unsynced).toBe(1);
  });

  it("a still-unreachable server leaves the till exactly as it was", async () => {
    // `online` is a hint. A captive portal fires it and answers nothing.
    const device = deviceModel(offlineReady());

    await device.refresh({ pairing: async () => ({ ok: false }) });

    expect(device.mode()).toBe("offline");
    expect(device.routeForNextSale()).toBe("offline-queue");
  });
});

// ---------------------------------------------------------------------------
// Draining semantics
// ---------------------------------------------------------------------------

describe("reconnect wakes the engine without changing the schedule", () => {
  it("attempts a fresh pending row immediately", async () => {
    const enqueued = await enqueueSale(input());

    expect(enqueued.ok).toBe(true);

    const submit = vi.fn(async () => receipt("ORD1"));

    await createSaleSyncEngine({ submit, now: () => T0 }).run();

    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("RESPECTS a persisted backoff window rather than clearing it", async () => {
    const enqueued = await enqueueSale(input());

    expect(enqueued.ok).toBe(true);

    if (!enqueued.ok) return;

    // One failure puts it inside a window.
    await createSaleSyncEngine({ submit: async () => transportFailure(), now: () => T0 }).run();

    const backedOff = await getQueuedSale(enqueued.value.queueRecordId);

    expect(backedOff.ok && backedOff.value.attemptCount).toBe(1);

    const dueAt = T0 + backoffDelayMs(1);

    // A reconnect arrives INSIDE the window. It is a wake-up, not permission to
    // hammer a server that is already struggling.
    const during = vi.fn(async () => receipt("ORD1"));

    await createSaleSyncEngine({ submit: during, now: () => dueAt - 1_000 }).run();

    expect(during).not.toHaveBeenCalled();

    const unchanged = await getQueuedSale(enqueued.value.queueRecordId);

    expect(unchanged.ok && unchanged.value.attemptCount).toBe(1);
    expect(unchanged.ok && unchanged.value.nextAttemptAt).toBe(new Date(dueAt).toISOString());

    // And it goes once the window elapses.
    const after = vi.fn(async () => receipt("ORD1"));

    await createSaleSyncEngine({ submit: after, now: () => dueAt + 1_000 }).run();

    expect(after).toHaveBeenCalledTimes(1);
  });

  it("repeated reconnect signals produce ONE drain and no duplicate orders", async () => {
    await enqueueSale(input());
    await enqueueSale(input());

    const seen = new Set<string>();
    let allocated = 2000;
    const submit = vi.fn(async (record: QueuedSale) => {
      seen.add(record.saleRequestId);
      allocated += 1;

      return receipt(`ORD${allocated}`);
    });

    const engine = createSaleSyncEngine({ submit, now: () => T0 });

    // Five events in the same tick — a flapping connection does this.
    await Promise.all([engine.run(), engine.run(), engine.run(), engine.run(), engine.run()]);

    expect(submit).toHaveBeenCalledTimes(2);
    expect(seen.size).toBe(2);

    const listing = await listQueuedSales();

    expect(listing.ok && listing.value.sales).toHaveLength(2);
    expect(
      listing.ok && new Set(listing.value.sales.map((s) => s.serverOrderNumber)).size
    ).toBe(2);
  });

  it("a reconnect arriving mid-sync joins the run instead of starting a second", async () => {
    await enqueueSale(input());

    let inFlight = 0;
    let maxConcurrent = 0;
    const submit = vi.fn(async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;

      return receipt("ORD1");
    });

    const engine = createSaleSyncEngine({ submit, now: () => T0 });
    const first = engine.run();
    const second = engine.run();

    await Promise.all([first, second]);

    expect(maxConcurrent).toBe(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The listener itself
// ---------------------------------------------------------------------------

describe("the reconnect listener", () => {
  function fakeWindow() {
    const handlers = new Map<string, Set<() => void>>();

    return {
      target: {
        addEventListener: (type: string, handler: () => void) => {
          if (!handlers.has(type)) handlers.set(type, new Set());
          handlers.get(type)!.add(handler);
        },
        removeEventListener: (type: string, handler: () => void) => {
          handlers.get(type)?.delete(handler);
        },
      } as unknown as Window,
      count: (type: string) => handlers.get(type)?.size ?? 0,
      fire: (type: string) => {
        for (const handler of [...(handlers.get(type) ?? [])]) handler();
      },
    };
  }

  it("registers exactly one handler and fires on an online event", () => {
    const win = fakeWindow();
    const onReconnect = vi.fn();
    const unsubscribe = subscribeToReconnect(onReconnect, win.target);

    expect(win.count("online")).toBe(1);

    win.fire("online");

    expect(onReconnect).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it("a remount leaves exactly one live handler, not two", () => {
    // The leak that would double every reconnect episode.
    const win = fakeWindow();
    const first = vi.fn();
    const unsubscribeFirst = subscribeToReconnect(first, win.target);

    unsubscribeFirst();

    const second = vi.fn();
    const unsubscribeSecond = subscribeToReconnect(second, win.target);

    expect(win.count("online")).toBe(1);

    win.fire("online");

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    unsubscribeSecond();

    expect(win.count("online")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Manual recovery
// ---------------------------------------------------------------------------

describe("Sync now is available whenever there is queued work", () => {
  it("is offered while the runtime is still offline", async () => {
    // The hole hardware found: the mode-based gate hid the only manual recovery
    // at exactly the moment it was needed.
    await enqueueSale(input());

    const status = await readOfflineSaleStatus();
    const device = deviceModel(offlineReady());

    expect(device.mode()).toBe("offline");
    expect(status.unsynced).toBeGreaterThan(0);
    // The condition DeviceApp now uses — the queue's own counts, never
    // navigator.onLine and never the runtime mode.
    expect(status.unsynced > 0).toBe(true);
  });

  it("is not offered when there is nothing to sync", async () => {
    const status = await readOfflineSaleStatus();

    expect(status.unsynced).toBe(0);
    expect(status.unsynced > 0).toBe(false);
  });

  it("a press that fails offline preserves every record and the backoff", async () => {
    const enqueued = await enqueueSale(input());

    expect(enqueued.ok).toBe(true);

    if (!enqueued.ok) return;

    await createSaleSyncEngine({ submit: async () => transportFailure(), now: () => T0 }).run();

    const after = await getQueuedSale(enqueued.value.queueRecordId);

    expect(after.ok).toBe(true);

    if (!after.ok) return;

    // Still there, still pending, never marked synced, never deleted.
    expect(after.value.state).toBe("pending");
    expect(after.value.serverOrderNumber).toBeNull();
    expect((await readOfflineSaleStatus()).unsynced).toBe(1);
  });
});
