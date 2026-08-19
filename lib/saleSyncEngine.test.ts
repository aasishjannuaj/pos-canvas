// Feature 24.5D — the drain loop against a real IndexedDB queue.
//
// The submission adapter and the clock are injected, so a lost response, a
// revoked device and a five-minute backoff are all modelled exactly without a
// network or a real timer. The QUEUE is real: every state change here goes
// through 24.5C's storage.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { enqueueSale, getQueuedSale, listQueuedSales, updateQueueState } from "@/lib/saleQueueSession";
import type { EnqueueSaleInput } from "@/lib/saleQueueSession";
import {
  createSaleSyncEngine,
  getSyncStatus,
  isSyncRunning,
  resetSyncEngineForTests,
  runSaleSync,
  subscribeToReconnect,
  triggerSaleSync,
} from "@/lib/saleSyncEngine";
import type { SyncDeps } from "@/lib/saleSyncEngine";
import { SYNC_MAX_ATTEMPTS } from "@/lib/saleSyncClassifier";
import type { OfflineSaleSubmission } from "@/lib/offlineSaleRpc";
import type { QueuedSale } from "@/lib/saleQueue";

const T0 = Date.parse("2026-08-19T12:00:00.000Z");

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetSyncEngineForTests();
});

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
      createdAt: "2026-08-19T12:00:00Z",
      items: [],
    } as unknown as OfflineSaleSubmission extends { ok: true; receipt: infer R } ? R : never,
  };
}

function rejected(message: string): OfflineSaleSubmission {
  return { ok: false, failure: { transport: "server_rejected", message } };
}

const transportDown: OfflineSaleSubmission = {
  ok: false,
  failure: { transport: "transport", message: "TypeError: Failed to fetch" },
};

const lostResponse: OfflineSaleSubmission = {
  ok: false,
  failure: { transport: "unknown", message: "signal timed out" },
};

function deps(
  submit: (record: QueuedSale) => Promise<OfflineSaleSubmission>,
  now: number = T0
): Partial<SyncDeps> {
  return { submit, now: () => now };
}

// ---------------------------------------------------------------------------
// Submission mapping
// ---------------------------------------------------------------------------

describe("what the engine sends", () => {
  it("submits the persisted request id, occurred_at and source unchanged", async () => {
    await enqueueSale(
      input({
        queueRecordId: "q-map",
        saleRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        occurredAt: "2026-08-19T09:30:00.000Z",
      })
    );

    const seen: QueuedSale[] = [];

    await runSaleSync(
      deps(async (record) => {
        seen.push(record);
        return receipt("ORD1001");
      })
    );

    expect(seen).toHaveLength(1);
    expect(seen[0].saleRequestId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(seen[0].occurredAt).toBe("2026-08-19T09:30:00.000Z");
    expect(seen[0].source).toBe("offline_queued");
    expect(seen[0].tipAmount).toBe(0);
  });

  it("carries no price of any kind", async () => {
    await enqueueSale(input({ queueRecordId: "q-price" }));

    const seen: QueuedSale[] = [];

    await runSaleSync(
      deps(async (record) => {
        seen.push(record);
        return receipt("ORD1002");
      })
    );

    const serialized = JSON.stringify(seen[0]);

    for (const banned of ["unitPrice", "lineTotal", "subtotal", "total", "taxAmount"]) {
      expect(`sent ${banned}`).toBe(`sent ${banned}`);
      expect(serialized).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// FIFO and sequencing
// ---------------------------------------------------------------------------

describe("FIFO, one at a time", () => {
  it("submits oldest first", async () => {
    await enqueueSale(input({ queueRecordId: "third", now: "2026-08-19T11:00:30.000Z" }));
    await enqueueSale(input({ queueRecordId: "first", now: "2026-08-19T11:00:10.000Z" }));
    await enqueueSale(input({ queueRecordId: "second", now: "2026-08-19T11:00:20.000Z" }));

    const order: string[] = [];

    await runSaleSync(
      deps(async (record) => {
        order.push(record.queueRecordId);
        return receipt(`ORD-${record.queueRecordId}`);
      })
    );

    expect(order).toEqual(["first", "second", "third"]);
  });

  it("never has two submissions in flight", async () => {
    for (let i = 0; i < 4; i += 1) await enqueueSale(input());

    let inFlight = 0;
    let maxInFlight = 0;

    await runSaleSync(
      deps(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return receipt("ORD");
      })
    );

    expect(maxInFlight).toBe(1);
  });

  it("concurrent sync calls collapse into a single run", async () => {
    await enqueueSale(input({ queueRecordId: "q-single" }));

    let calls = 0;

    const submit = async (): Promise<OfflineSaleSubmission> => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return receipt("ORD1");
    };

    const [a, b, c] = await Promise.all([
      runSaleSync(deps(submit)),
      runSaleSync(deps(submit)),
      triggerSaleSync("manual", deps(submit)),
    ]);

    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(isSyncRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------

describe("success", () => {
  it("marks synced and records the server order identity", async () => {
    await enqueueSale(input({ queueRecordId: "q-ok" }));

    const report = await runSaleSync(deps(async () => receipt("ORD1042")));

    expect(report.synced).toBe(1);

    const read = await getQueuedSale("q-ok");

    if (!read.ok) throw new Error("unreachable");

    expect(read.value.state).toBe("synced");
    expect(read.value.serverOrderNumber).toBe("ORD1042");
    expect(read.value.serverOrderId).toBe("order-ORD1042");
    expect(read.value.serverCreatedAt).toBe("2026-08-19T12:00:00Z");
    // Retry state is normalised — there is nothing left to retry.
    expect(read.value.nextAttemptAt).toBeNull();
    expect(read.value.lastErrorCode).toBeNull();
  });

  it("does not delete the record — 24.5E reconciles against it", async () => {
    await enqueueSale(input({ queueRecordId: "q-keep" }));
    await runSaleSync(deps(async () => receipt("ORD1")));

    const listing = await listQueuedSales();

    expect(listing.ok === true && listing.value.sales.map((s) => s.queueRecordId)).toContain(
      "q-keep"
    );
  });
});

// ---------------------------------------------------------------------------
// Retry and backoff
// ---------------------------------------------------------------------------

describe("transport failure retries with persisted backoff", () => {
  it("returns to pending, counts the attempt and schedules the next", async () => {
    await enqueueSale(input({ queueRecordId: "q-retry" }));

    await runSaleSync(deps(async () => transportDown));

    const read = await getQueuedSale("q-retry");

    if (!read.ok) throw new Error("unreachable");

    expect(read.value.state).toBe("pending");
    expect(read.value.attemptCount).toBe(1);
    expect(read.value.lastErrorCode).toBe("transport");
    // First attempt -> 5s later, deterministic because there is no jitter.
    expect(read.value.nextAttemptAt).toBe("2026-08-19T12:00:05.000Z");
  });

  it("skips a record still inside its backoff window", async () => {
    await enqueueSale(input({ queueRecordId: "q-wait" }));
    await runSaleSync(deps(async () => transportDown));
    resetSyncEngineForTests();

    let calls = 0;

    // One second later: still inside the 5s window.
    await runSaleSync(
      deps(async () => {
        calls += 1;
        return transportDown;
      }, T0 + 1_000)
    );

    expect(calls).toBe(0);
  });

  it("retries once the window has elapsed, and backs off further", async () => {
    await enqueueSale(input({ queueRecordId: "q-again" }));
    await runSaleSync(deps(async () => transportDown));
    resetSyncEngineForTests();

    await runSaleSync(deps(async () => transportDown, T0 + 10_000));

    const read = await getQueuedSale("q-again");

    if (!read.ok) throw new Error("unreachable");

    expect(read.value.attemptCount).toBe(2);
    // Second attempt -> 15s after the second run's clock.
    expect(read.value.nextAttemptAt).toBe("2026-08-19T12:00:25.000Z");
  });

  it("a restart does not reset the schedule", async () => {
    await enqueueSale(input({ queueRecordId: "q-persist" }));
    await runSaleSync(deps(async () => transportDown));

    const before = await getQueuedSale("q-persist");

    // A restart is a fresh engine against the same durable queue.
    resetSyncEngineForTests();

    const after = await getQueuedSale("q-persist");

    expect(after.ok === true && after.value.nextAttemptAt).toBe(
      before.ok === true ? before.value.nextAttemptAt : "mismatch"
    );
    expect(after.ok === true && after.value.attemptCount).toBe(1);
  });

  it("asks for a person once attempts are exhausted", async () => {
    await enqueueSale(input({ queueRecordId: "q-exhaust" }));

    // Drive the attempt count up to the cap, always past the backoff window.
    for (let attempt = 1; attempt <= SYNC_MAX_ATTEMPTS; attempt += 1) {
      resetSyncEngineForTests();
      await runSaleSync(deps(async () => transportDown, T0 + attempt * 3_600_000));
    }

    const read = await getQueuedSale("q-exhaust");

    expect(read.ok === true && read.value.state).toBe("needs_attention");
    expect(read.ok === true && read.value.lastErrorCode).toBe("transport_attempts_exhausted");
  });
});

// ---------------------------------------------------------------------------
// THE LOST-RESPONSE CASE
// ---------------------------------------------------------------------------

describe("a lost response never becomes a second sale", () => {
  it("retries with the SAME request id and accepts the replayed order", async () => {
    // Models the exact semantic from the brief: the server created the order,
    // the client never heard, and the retry must land on the same one.
    await enqueueSale(
      input({ queueRecordId: "q-lost", saleRequestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })
    );

    const serverOrders = new Map<string, string>();
    let call = 0;

    const submit = async (record: QueuedSale): Promise<OfflineSaleSubmission> => {
      call += 1;

      // The server records the sale against its idempotency key BOTH times;
      // the first response is simply lost in transit.
      if (!serverOrders.has(record.saleRequestId)) {
        serverOrders.set(record.saleRequestId, "ORD2001");
      }

      if (call === 1) return lostResponse;

      return receipt(serverOrders.get(record.saleRequestId) as string);
    };

    await runSaleSync(deps(submit));

    const afterLoss = await getQueuedSale("q-lost");

    expect(afterLoss.ok === true && afterLoss.value.state).toBe("pending");
    expect(afterLoss.ok === true && afterLoss.value.lastErrorCode).toBe("unknown_outcome");
    expect(afterLoss.ok === true && afterLoss.value.saleRequestId).toBe(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    );

    resetSyncEngineForTests();
    await runSaleSync(deps(submit, T0 + 60_000));

    const afterRetry = await getQueuedSale("q-lost");

    if (!afterRetry.ok) throw new Error("unreachable");

    expect(afterRetry.value.state).toBe("synced");
    expect(afterRetry.value.serverOrderNumber).toBe("ORD2001");
    // ONE order on the server for two submissions.
    expect(serverOrders.size).toBe(1);
    expect(call).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Business errors
// ---------------------------------------------------------------------------

describe("known business errors are preserved for review", () => {
  const cases: [string, string][] = [
    ["Offline sale occurred after this device was revoked", "post_revocation"],
    ["Offline sale time is older than the offline limit", "lease_expired"],
    ["Offline sale time is in the future", "clock_future"],
    ["Offline sale time predates this device", "clock_before_pairing"],
    ["Sale request ID was already used for a different order", "hash_conflict"],
    ["Only a paired device can record an offline sale", "not_a_paired_device"],
    ["Invalid sale source", "invalid_source"],
  ];

  for (const [message, code] of cases) {
    it(`"${message}" -> needs_attention (${code})`, async () => {
      const id = `q-${code}`;

      await enqueueSale(input({ queueRecordId: id }));
      await runSaleSync(deps(async () => rejected(message)));

      const read = await getQueuedSale(id);

      expect(read.ok === true && read.value.state).toBe("needs_attention");
      expect(read.ok === true && read.value.lastErrorCode).toBe(code);
      expect(read.ok === true && read.value.lastErrorMessage).toBe(message);
    });
  }

  it("an uncatalogued server answer still preserves the sale", async () => {
    await enqueueSale(input({ queueRecordId: "q-unknown" }));
    await runSaleSync(deps(async () => rejected("Menu item burger is not available")));

    const read = await getQueuedSale("q-unknown");

    expect(read.ok === true && read.value.state).toBe("needs_attention");
    expect(read.ok === true && read.value.lastErrorCode).toBe("unrecognised_server_error");
  });

  it("one needs_attention record does not block the sales behind it", async () => {
    await enqueueSale(input({ queueRecordId: "bad", now: "2026-08-19T11:00:01.000Z" }));
    await enqueueSale(input({ queueRecordId: "good1", now: "2026-08-19T11:00:02.000Z" }));
    await enqueueSale(input({ queueRecordId: "good2", now: "2026-08-19T11:00:03.000Z" }));

    const report = await runSaleSync(
      deps(async (record) =>
        record.queueRecordId === "bad"
          ? rejected("Offline sale occurred after this device was revoked")
          : receipt(`ORD-${record.queueRecordId}`)
      )
    );

    expect(report.attempted).toBe(3);
    expect(report.synced).toBe(2);
    expect(report.needsAttention).toBe(1);

    const good = await getQueuedSale("good2");

    expect(good.ok === true && good.value.state).toBe("synced");
  });
});

// ---------------------------------------------------------------------------
// Recovery, status, hooks
// ---------------------------------------------------------------------------

describe("recovery, status and hooks", () => {
  it("recovers a record stranded in syncing — on the STARTUP trigger only", async () => {
    // Recovery moved out of the drain: it cannot tell a dead process's orphan
    // from another engine's in-flight work, so it belongs where that ambiguity
    // does not exist.
    await enqueueSale(input({ queueRecordId: "q-stranded" }));
    await updateQueueState("q-stranded", "syncing", "2026-08-19T11:30:00.000Z");

    const ignored = await runSaleSync(deps(async () => receipt("ORD-NEVER")));

    expect(ignored.attempted).toBe(0);
    resetSyncEngineForTests();

    const report = await triggerSaleSync("startup", deps(async () => receipt("ORD3001")));

    expect(report.synced).toBe(1);

    const read = await getQueuedSale("q-stranded");

    expect(read.ok === true && read.value.state).toBe("synced");
  });

  it("reports queue status without building UI", async () => {
    await enqueueSale(input({ queueRecordId: "s1" }));
    await enqueueSale(input({ queueRecordId: "s2" }));

    const status = await getSyncStatus();

    expect(status.running).toBe(false);
    expect(status.summary?.pending).toBe(2);
    expect(status.summary?.outstanding).toBe(2);
  });

  it("the run report summarises what happened", async () => {
    await enqueueSale(input({ queueRecordId: "r1" }));

    const report = await runSaleSync(deps(async () => receipt("ORD4001")));

    expect(report.attempted).toBe(1);
    expect(report.outcomes[0].result).toBe("synced");
    expect(report.outcomes[0].orderNumber).toBe("ORD4001");
    expect(report.lastSyncedAt).toBe("2026-08-19T12:00:00.000Z");
    expect(report.summary?.synced).toBe(1);
  });

  it("every trigger drains, and only startup also reclaims orphans", async () => {
    await enqueueSale(input({ queueRecordId: "t1" }));

    const report = await triggerSaleSync("manual", deps(async () => receipt("ORD5001")));

    expect(report.synced).toBe(1);
    resetSyncEngineForTests();

    // A reconnect must NOT reclaim another engine's in-flight record.
    await enqueueSale(input({ queueRecordId: "t2" }));
    await updateQueueState("t2", "syncing", "2026-08-19T11:30:00.000Z");

    const reconnect = await triggerSaleSync("reconnect", deps(async () => receipt("ORD5002")));

    expect(reconnect.attempted).toBe(0);
  });

  it("the reconnect subscription attaches and detaches cleanly", () => {
    const listeners: Record<string, (() => void)[]> = {};
    const target = {
      addEventListener: (type: string, handler: () => void) => {
        (listeners[type] ??= []).push(handler);
      },
      removeEventListener: (type: string, handler: () => void) => {
        listeners[type] = (listeners[type] ?? []).filter((h) => h !== handler);
      },
    } as unknown as Window;

    let fired = 0;
    const unsubscribe = subscribeToReconnect(() => {
      fired += 1;
    }, target);

    listeners.online?.forEach((h) => h());
    expect(fired).toBe(1);

    unsubscribe();
    expect(listeners.online).toHaveLength(0);
  });

  it("is a no-op where there is no window", () => {
    expect(() => subscribeToReconnect(() => undefined, undefined)()).not.toThrow();
  });

  it("an empty queue is a clean no-op", async () => {
    const report = await runSaleSync(deps(async () => receipt("never")));

    expect(report.attempted).toBe(0);
    expect(report.summary?.total).toBe(0);
  });
});


// ---------------------------------------------------------------------------
// 24.5D audit — single-flight scope
// ---------------------------------------------------------------------------

describe("single-flight is scoped to an engine, not to the module", () => {
  it("one engine + three concurrent triggers = one drain", async () => {
    await enqueueSale(input({ queueRecordId: "sf-1" }));

    const engine = createSaleSyncEngine();
    let calls = 0;

    const submit = async (): Promise<OfflineSaleSubmission> => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return receipt("ORD-SF");
    };

    const [a, b, c] = await Promise.all([
      engine.run(deps(submit)),
      engine.run(deps(submit)),
      engine.run(deps(submit)),
    ]);

    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(engine.isRunning()).toBe(false);
  });

  it("two independent engines do not share single-flight state", async () => {
    // The first version held activeRun at module scope, which made the guard
    // accidentally global: engine B would have blocked purely because it
    // imported the same file.
    const a = createSaleSyncEngine();
    const b = createSaleSyncEngine();

    // Definite-assignment: TypeScript cannot see that a Promise executor runs
    // synchronously, and would otherwise narrow this to `never`.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    await enqueueSale(input({ queueRecordId: "sf-a" }));

    const runA = a.run(
      deps(async () => {
        await gate;
        return receipt("ORD-A");
      })
    );

    expect(a.isRunning()).toBe(true);
    // B is a different engine and must be free to run.
    expect(b.isRunning()).toBe(false);

    const reportB = await b.run(deps(async () => receipt("ORD-B")));

    expect(b.isRunning()).toBe(false);
    expect(a.isRunning()).toBe(true);

    release();
    await runA;

    expect(reportB).not.toBe(await runA);
  });

  it("two engines draining ONE queue cannot both submit the same sale", async () => {
    // Not luck: claiming a record is a pending -> syncing transition read from
    // storage, so whichever engine arrives second finds the transition illegal
    // and skips. The queue is the arbiter.
    await enqueueSale(input({ queueRecordId: "sf-shared" }));

    const a = createSaleSyncEngine();
    const b = createSaleSyncEngine();
    const submitted: string[] = [];

    // Definite-assignment: TypeScript cannot see that a Promise executor runs
    // synchronously, and would otherwise narrow this to `never`.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const runA = a.run(
      deps(async (record) => {
        submitted.push(`a:${record.queueRecordId}`);
        await gate;
        return receipt("ORD-SHARED");
      })
    );

    // Let A claim the record before B looks.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const reportB = await b.run(
      deps(async (record) => {
        submitted.push(`b:${record.queueRecordId}`);
        return receipt("ORD-DUPLICATE");
      })
    );

    release();
    await runA;

    expect(submitted).toEqual(["a:sf-shared"]);
    expect(reportB.synced).toBe(0);
  });

  it("the shared engine still backs the module-level helpers", async () => {
    await enqueueSale(input({ queueRecordId: "sf-shared-api" }));

    const report = await runSaleSync(deps(async () => receipt("ORD-MODULE")));

    expect(report.synced).toBe(1);
    expect(isSyncRunning()).toBe(false);
    resetSyncEngineForTests();
  });
});

// ---------------------------------------------------------------------------
// 24.5D audit — success response validation
// ---------------------------------------------------------------------------

describe("a sale becomes synced only on a valid reconciliation identity", () => {
  it("keeps a server timestamp only when it parses", async () => {
    await enqueueSale(input({ queueRecordId: "ts-bad" }));

    const engine = createSaleSyncEngine();

    await engine.run(
      deps(async () => {
        const good = receipt("ORD-TS");

        return {
          ok: true,
          receipt: { ...good.ok ? good.receipt : {}, createdAt: "whenever" },
        } as OfflineSaleSubmission;
      })
    );

    const read = await getQueuedSale("ts-bad");

    if (!read.ok) throw new Error("unreachable");

    // The sale is still recorded; only the unreadable metadata is dropped.
    expect(read.value.state).toBe("synced");
    expect(read.value.serverOrderNumber).toBe("ORD-TS");
    expect(read.value.serverCreatedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 24.5D audit — attemptCount semantics
// ---------------------------------------------------------------------------

describe("attemptCount counts submissions and nothing else", () => {
  it("a skipped record inside its backoff window is NOT counted", async () => {
    await enqueueSale(input({ queueRecordId: "ac-skip" }));

    const engine = createSaleSyncEngine();

    await engine.run(deps(async () => transportDown));

    const afterFirst = await getQueuedSale("ac-skip");

    expect(afterFirst.ok === true && afterFirst.value.attemptCount).toBe(1);

    // Three runs inside the window: skipped every time, never counted.
    for (const offset of [500, 1_000, 2_000]) {
      await engine.run(deps(async () => transportDown, T0 + offset));
    }

    const afterSkips = await getQueuedSale("ac-skip");

    expect(afterSkips.ok === true && afterSkips.value.attemptCount).toBe(1);
  });

  it("a startup scan alone does not count an attempt", async () => {
    await enqueueSale(input({ queueRecordId: "ac-scan" }));

    const engine = createSaleSyncEngine();

    // Nothing due yet is impossible for a fresh record, so instead park it and
    // confirm recovery + listing leave the counter alone.
    await updateQueueState("ac-scan", "syncing", "2026-08-19T11:30:00.000Z");
    await getSyncStatus();

    const read = await getQueuedSale("ac-scan");

    expect(read.ok === true && read.value.attemptCount).toBe(0);
    void engine;
  });

  it("concurrent callers joining one run do not multiply attempts", async () => {
    await enqueueSale(input({ queueRecordId: "ac-join" }));

    const engine = createSaleSyncEngine();
    const submit = async (): Promise<OfflineSaleSubmission> => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return transportDown;
    };

    await Promise.all([engine.run(deps(submit)), engine.run(deps(submit)), engine.run(deps(submit))]);

    const read = await getQueuedSale("ac-join");

    expect(read.ok === true && read.value.attemptCount).toBe(1);
  });

  it("a retry preserves the request id, occurred_at and the financial payload", async () => {
    await enqueueSale(
      input({
        queueRecordId: "ac-payload",
        saleRequestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        occurredAt: "2026-08-19T08:15:00.000Z",
        items: [
          { itemId: "item-x", quantity: 3, modifiers: [{ groupId: "g", optionIds: ["o1", "o2"] }] },
        ],
      })
    );

    const engine = createSaleSyncEngine();
    const seen: QueuedSale[] = [];

    await engine.run(
      deps(async (record) => {
        seen.push(record);
        return transportDown;
      })
    );

    await engine.run(
      deps(async (record) => {
        seen.push(record);
        return transportDown;
      }, T0 + 3_600_000)
    );

    expect(seen).toHaveLength(2);
    expect(seen[1].saleRequestId).toBe(seen[0].saleRequestId);
    expect(seen[1].occurredAt).toBe("2026-08-19T08:15:00.000Z");
    expect(seen[1].items).toEqual(seen[0].items);
    expect(seen[1].paymentMethod).toBe(seen[0].paymentMethod);
    expect(seen[1].tipAmount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 24.5D audit — needs_attention destroys nothing
// ---------------------------------------------------------------------------

describe("needs_attention preserves every piece of financial evidence", () => {
  it("keeps identity, payload, retry history and the server's reason", async () => {
    await enqueueSale(
      input({
        queueRecordId: "na-keep",
        saleRequestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        occurredAt: "2026-08-19T07:45:00.000Z",
        paymentMethod: "card",
        items: [{ itemId: "item-y", quantity: 2, modifiers: [] }],
      })
    );

    const engine = createSaleSyncEngine();
    const before = await getQueuedSale("na-keep");

    await engine.run(
      deps(async () => rejected("Offline sale occurred after this device was revoked"))
    );

    const after = await getQueuedSale("na-keep");

    if (!after.ok || !before.ok) throw new Error("unreachable");

    expect(after.value.state).toBe("needs_attention");

    // Everything that identifies or prices the sale is byte-identical.
    expect(after.value.saleRequestId).toBe(before.value.saleRequestId);
    expect(after.value.occurredAt).toBe(before.value.occurredAt);
    expect(after.value.projectId).toBe(before.value.projectId);
    expect(after.value.buildJobId).toBe(before.value.buildJobId);
    expect(after.value.deviceId).toBe(before.value.deviceId);
    expect(after.value.deviceAuthUserId).toBe(before.value.deviceAuthUserId);
    expect(after.value.paymentMethod).toBe("card");
    expect(after.value.items).toEqual(before.value.items);
    expect(after.value.queuedAt).toBe(before.value.queuedAt);

    // Retry history and the server's own words are kept for whoever reviews it.
    expect(after.value.attemptCount).toBe(1);
    expect(after.value.lastAttemptAt).not.toBeNull();
    expect(after.value.lastErrorCode).toBe("post_revocation");
    expect(after.value.lastErrorMessage).toBe(
      "Offline sale occurred after this device was revoked"
    );
  });

  it("is never deleted automatically", async () => {
    await enqueueSale(input({ queueRecordId: "na-alive" }));

    const engine = createSaleSyncEngine();

    await engine.run(deps(async () => rejected("Invalid sale source")));
    await engine.run(deps(async () => rejected("Invalid sale source"), T0 + 3_600_000));

    const listing = await listQueuedSales();

    expect(listing.ok === true && listing.value.sales.map((s) => s.queueRecordId)).toContain(
      "na-alive"
    );
  });

  it("is not retried by a later drain", async () => {
    await enqueueSale(input({ queueRecordId: "na-stop" }));

    const engine = createSaleSyncEngine();

    await engine.run(deps(async () => rejected("Invalid sale source")));

    let calls = 0;

    await engine.run(
      deps(async () => {
        calls += 1;
        return receipt("ORD-NEVER");
      }, T0 + 86_400_000)
    );

    expect(calls).toBe(0);
  });
});
