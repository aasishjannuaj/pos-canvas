// Feature 24.5E — the sync engine's lifecycle: startup once, reconnect safely.
//
// 24.5D built the engine and its triggers and deliberately wired nothing to
// them. This file covers the wiring 24.5E added: the startup run that is
// allowed to reclaim stranded work and may happen only once per process, and
// the reconnect subscription that must attach once and detach cleanly.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasTriggeredStartupSync,
  resetStartupSyncForTests,
  resetSyncEngineForTests,
  subscribeToReconnect,
  triggerSaleSync,
  triggerStartupSaleSyncOnce,
} from "@/lib/saleSyncEngine";
import { enqueueSale, getQueuedSale, updateQueueState } from "@/lib/saleQueueSession";
import type { EnqueueSaleInput } from "@/lib/saleQueueSession";
import type { SyncRunReport } from "@/lib/saleSyncEngine";
import type { OfflineSaleSubmission } from "@/lib/offlineSaleRpc";
import type { QueuedSale } from "@/lib/saleQueue";

const T0 = Date.parse("2026-08-19T12:00:00.000Z");

let seq = 0;

function input(overrides: Partial<EnqueueSaleInput> = {}): EnqueueSaleInput {
  seq += 1;

  return {
    queueRecordId: `q-${seq}`,
    saleRequestId: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    deviceAuthUserId: "22222222-2222-4222-8222-222222222222",
    deviceId: "33333333-3333-4333-8333-333333333333",
    projectId: "44444444-4444-4444-8444-444444444444",
    buildJobId: "55555555-5555-4555-8555-555555555555",
    paymentMethod: "cash",
    items: [{ itemId: "item-1", quantity: 1, modifiers: [] }],
    occurredAt: "2026-08-19T11:00:00.000Z",
    now: `2026-08-19T11:00:${String(seq).padStart(2, "0")}.000Z`,
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
      createdAt: "2026-08-19T12:00:00.000Z",
      items: [],
    },
  };
}

/** A minimal EventTarget stand-in, so listener bookkeeping is observable. */
function fakeTarget() {
  const listeners = new Map<string, Set<EventListener>>();

  return {
    addEventListener: ((type: string, handler: EventListener) => {
      const set = listeners.get(type) ?? new Set<EventListener>();

      set.add(handler);
      listeners.set(type, set);
    }) as typeof window.addEventListener,
    removeEventListener: ((type: string, handler: EventListener) => {
      listeners.get(type)?.delete(handler);
    }) as typeof window.removeEventListener,
    emit(type: string): void {
      for (const handler of listeners.get(type) ?? []) {
        handler(new Event(type));
      }
    },
    count(type: string): number {
      return listeners.get(type)?.size ?? 0;
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
// Startup
// ---------------------------------------------------------------------------

describe("startup sync happens exactly once per device session", () => {
  const SESSION_A = "11111111-1111-4111-8111-111111111111";
  const SESSION_B = "99999999-9999-4999-8999-999999999999";

  it("runs on the first call and reports it has been claimed", async () => {
    await enqueueSale(input());

    const submit = vi.fn(async () => receipt("ORD1"));

    expect(hasTriggeredStartupSync(SESSION_A)).toBe(false);

    const report = await triggerStartupSaleSyncOnce(SESSION_A, { submit, now: () => T0 });

    expect(hasTriggeredStartupSync(SESSION_A)).toBe(true);
    expect(report?.synced).toBe(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("does nothing on a second call for the SAME session, however it is reached", async () => {
    // React can mount a component twice — StrictMode, an error boundary, a
    // route change — and a second startup would un-claim a submission that is
    // still on the wire.
    await enqueueSale(input());

    const submit = vi.fn(async () => receipt("ORD1"));

    await triggerStartupSaleSyncOnce(SESSION_A, { submit, now: () => T0 });

    await enqueueSale(input());

    const second = await triggerStartupSaleSyncOnce(SESSION_A, { submit, now: () => T0 });

    expect(second).toBeNull();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("runs again for a DIFFERENT device session in the same process", async () => {
    // The re-pair case: unpair, pair to another project, and the app never
    // reloaded. A process-wide boolean would silently deny the new session its
    // startup pass forever.
    await enqueueSale(input());

    const submit = vi.fn(async () => receipt("ORD1"));

    await triggerStartupSaleSyncOnce(SESSION_A, { submit, now: () => T0 });

    expect(hasTriggeredStartupSync(SESSION_B)).toBe(false);

    await enqueueSale(input());

    const second = await triggerStartupSaleSyncOnce(SESSION_B, { submit, now: () => T0 });

    expect(second).not.toBeNull();
    expect(second?.synced).toBe(1);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(hasTriggeredStartupSync(SESSION_B)).toBe(true);
    // And the old session's latch is spent, not restored.
    expect(hasTriggeredStartupSync(SESSION_A)).toBe(false);
  });

  it("recovers a record stranded mid-submission by a dead process", async () => {
    const enqueued = await enqueueSale(input());

    expect(enqueued.ok).toBe(true);

    if (!enqueued.ok) return;

    // What a process kill during a submit leaves behind: a record claiming to
    // be in flight with nothing flying it.
    await updateQueueState(enqueued.value.queueRecordId, "syncing", "2026-08-19T11:30:00.000Z");

    const submit = vi.fn(async (record: QueuedSale) => {
      void record;

      return receipt("ORD1");
    });
    const report = await triggerStartupSaleSyncOnce(SESSION_A, { submit, now: () => T0 });

    expect(report?.synced).toBe(1);

    const stored = await getQueuedSale(enqueued.value.queueRecordId);

    expect(stored.ok && stored.value.state).toBe("synced");
    // Replay is safe because the SAME persisted key goes back out.
    expect(submit.mock.calls[0][0].saleRequestId).toBe(enqueued.value.saleRequestId);
  });

  it("a reconnect does NOT reclaim work that may still be in flight", async () => {
    const enqueued = await enqueueSale(input());

    expect(enqueued.ok).toBe(true);

    if (!enqueued.ok) return;

    await updateQueueState(enqueued.value.queueRecordId, "syncing", "2026-08-19T11:30:00.000Z");

    const submit = vi.fn(async () => receipt("ORD1"));

    await triggerSaleSync("reconnect", { submit, now: () => T0 });

    // Untouched: only startup can tell an orphan from another engine's work.
    expect(submit).not.toHaveBeenCalled();

    const stored = await getQueuedSale(enqueued.value.queueRecordId);

    expect(stored.ok && stored.value.state).toBe("syncing");
  });
});

// ---------------------------------------------------------------------------
// Reconnect
// ---------------------------------------------------------------------------

describe("the reconnect listener", () => {
  it("subscribes once and fires on an online event", () => {
    const target = fakeTarget();
    const onReconnect = vi.fn();

    subscribeToReconnect(onReconnect, target);

    expect(target.count("online")).toBe(1);

    target.emit("online");

    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("is removed by its own teardown, and stops firing", () => {
    const target = fakeTarget();
    const onReconnect = vi.fn();

    const unsubscribe = subscribeToReconnect(onReconnect, target);

    unsubscribe();

    expect(target.count("online")).toBe(0);

    target.emit("online");

    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("survives a host with no event support at all", () => {
    // Server rendering, or a shell that has not attached a window yet.
    const unsubscribe = subscribeToReconnect(() => undefined, undefined);

    expect(() => unsubscribe()).not.toThrow();
  });

  it("keeps repeated online events to ONE drain", async () => {
    await enqueueSale(input());
    await enqueueSale(input());

    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });

    let started = 0;
    const submit = vi.fn(async () => {
      started += 1;
      await gate;

      return receipt(`ORD${started}`);
    });

    const target = fakeTarget();
    const runs: Promise<SyncRunReport>[] = [];

    subscribeToReconnect(() => {
      runs.push(triggerSaleSync("reconnect", { submit, now: () => T0 }));
    }, target);

    // A flapping connection: five online events in a row.
    for (let index = 0; index < 5; index += 1) {
      target.emit("online");
    }

    expect(runs).toHaveLength(5);

    // Wait until the drain reaches its first submission. Bounded and
    // condition-driven rather than a fixed sleep: the drain does several
    // IndexedDB round-trips before it submits, and how many event-loop turns
    // that takes is not something this test should pretend to know.
    for (let turn = 0; turn < 500 && started === 0; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // One submission is in flight, not five, and the sales behind it are not
    // being raced for. The gate is still closed, so this cannot climb.
    expect(started).toBe(1);

    release();

    const reports = await Promise.all(runs);

    // Single-flight, stated as the property that matters: all five triggers
    // resolved to the SAME report object, because four of them joined the run
    // the first one started instead of opening their own.
    expect(new Set(reports).size).toBe(1);
    // And the queue drained once: two sales, two submissions, not ten.
    expect(submit).toHaveBeenCalledTimes(2);
    expect(reports[0].synced).toBe(2);
  });
});
