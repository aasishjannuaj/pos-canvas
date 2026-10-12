// v1.3 CP-2R — what survives an application restart, over real storage.
//
// WHAT MAKES THIS A RESTART AND NOT A RERENDER. Two things happen together:
//
//   the disk SURVIVES   the same IDBFactory is kept across the boundary, so the
//                       object stores hold exactly what the previous run wrote;
//   the process DIES    vi.resetModules() throws away the module registry, so
//                       every module-level cache, latch, open connection and
//                       in-memory copy is gone and the modules under test are
//                       imported fresh afterwards.
//
// Recreating the IDBFactory would be a WIPE, not a restart, and would prove
// nothing; keeping the modules would be a rerender, which the order rules out
// explicitly. Each test below crosses the boundary with `restart()` and then
// asks storage what is there, through freshly imported modules.
//
// WHAT IT STILL IS NOT. The browser process itself is not killed, the Android
// or Windows shell is not restarted, and no real device is involved. See the
// CP-2R report for the physical UAT this cannot replace.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SALE = "11111111-1111-4111-8111-111111111111";
const OTHER_SALE = "aaaaaaaa-1111-4111-8111-111111111111";
const QUEUE = "q-1";
const NOW = "2026-10-12T09:00:00.000Z";
const LATER = "2026-10-12T10:00:00.000Z";

const IDENTITY = {
  deviceAuthUserId: "22222222-2222-4222-8222-222222222222",
  deviceId: "33333333-3333-4333-8333-333333333333",
  projectId: "44444444-4444-4444-8444-444444444444",
  buildJobId: "55555555-5555-4555-8555-555555555555",
};

const REGISTER = "77777777-7777-4777-8777-777777777777";

/** Exactly what an outstanding online dispatch leaves behind. */
const ARMED = {
  sale: {
    saleRequestId: SALE,
    projectId: IDENTITY.projectId,
    paymentMethod: "cash" as const,
    tipAmount: 0,
    items: [{ itemId: "item-1", quantity: 2, modifiers: [] }],
    fingerprint: "fp-1",
  },
  identity: IDENTITY,
  dispatchedAt: NOW,
};

type QueueSession = typeof import("@/lib/saleQueueSession");
type Store = typeof import("@/lib/deviceOfflineStore");

/**
 * Crosses the restart boundary.
 *
 * The IDBFactory is deliberately NOT replaced: that is the disk. The module
 * registry is thrown away: that is the process.
 */
async function restart(): Promise<void> {
  vi.resetModules();
  await Promise.resolve();
}

async function queueSession(): Promise<QueueSession> {
  return import("@/lib/saleQueueSession");
}

async function enqueueOne(session: QueueSession, saleRequestId = SALE, queueRecordId = QUEUE) {
  return session.enqueueSale({
    saleRequestId,
    queueRecordId,
    ...IDENTITY,
    paymentMethod: "cash",
    items: [{ itemId: "item-1", quantity: 2, modifiers: [] }],
    occurredAt: "2026-10-12T00:05:00.000Z",
    now: NOW,
    registerSessionId: REGISTER,
  });
}

beforeEach(() => {
  // ONE fresh database per test. Within a test it is never replaced, so a
  // restart keeps whatever the test wrote before it.
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
});

// ---------------------------------------------------------------------------

describe("the restart boundary itself", () => {
  it("keeps the data and throws away the process", async () => {
    const before = await queueSession();

    expect((await enqueueOne(before)).ok).toBe(true);

    await restart();

    const after = await queueSession();

    // A genuinely different module instance...
    expect(after).not.toBe(before);
    // ...reading the same storage.
    const listed = await after.listQueuedSales();

    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.sales).toHaveLength(1);
  });

  it("clears the startup-sync latch, so a new process runs recovery again", async () => {
    const engineBefore = await import("@/lib/saleSyncEngine");

    engineBefore.resetStartupSyncForTests();
    await engineBefore.triggerStartupSaleSyncOnce("session-1");
    expect(engineBefore.hasTriggeredStartupSync("session-1")).toBe(true);

    await restart();

    const engineAfter = await import("@/lib/saleSyncEngine");

    // A LATCH THAT SURVIVED A RESTART WOULD SKIP RECOVERY on the one run that
    // needs it most.
    expect(engineAfter.hasTriggeredStartupSync("session-1")).toBe(false);
  });
});

describe("1. a durably queued sale survives a full restart", () => {
  it("is still there, with its identity, money and register claim intact", async () => {
    const before = await queueSession();

    expect((await enqueueOne(before)).ok).toBe(true);

    await restart();

    const after = await queueSession();
    const read = await after.getQueuedSale(QUEUE);

    expect(read.ok).toBe(true);
    if (!read.ok) return;

    const record = read.value;

    // 5. RESTART CANNOT SILENTLY CHANGE ANY OF THESE.
    expect(record.saleRequestId).toBe(SALE);
    expect(record.queueRecordId).toBe(QUEUE);
    expect(record.registerSessionId).toBe(REGISTER);
    expect(record.items).toEqual([{ itemId: "item-1", quantity: 2, modifiers: [] }]);
    expect(record.paymentMethod).toBe("cash");
    expect(record.occurredAt).toBe("2026-10-12T00:05:00.000Z");
    expect(record.tipAmount).toBe(0);
    expect(record.state).toBe("pending");
  });
});

describe("2 and 3. an interrupted submission is reclaimed, never duplicated", () => {
  it("a record stranded in `syncing` returns to pending after restart recovery", async () => {
    const before = await queueSession();

    expect((await enqueueOne(before)).ok).toBe(true);
    expect((await before.updateQueueState(QUEUE, "syncing", NOW)).ok).toBe(true);

    // The process dies mid-submission.
    await restart();

    const after = await queueSession();
    const stranded = await after.getQueuedSale(QUEUE);

    expect(stranded.ok).toBe(true);
    if (!stranded.ok) return;
    // It survived the restart still marked syncing -- nothing silently dropped.
    expect(stranded.value.state).toBe("syncing");

    const report = await after.recoverInterruptedSyncs(LATER);

    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.recovered).toBe(1);

    const recovered = await after.getQueuedSale(QUEUE);

    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    // Back to pending, SAME identity -- it will be retried under the original
    // sale request id, which is what server idempotency keys on.
    expect(recovered.value.state).toBe("pending");
    expect(recovered.value.saleRequestId).toBe(SALE);
    expect(recovered.value.registerSessionId).toBe(REGISTER);
  });

  it("recovery is idempotent: running it twice recovers nothing the second time", async () => {
    const before = await queueSession();

    expect((await enqueueOne(before)).ok).toBe(true);
    expect((await before.updateQueueState(QUEUE, "syncing", NOW)).ok).toBe(true);

    await restart();

    const after = await queueSession();
    const first = await after.recoverInterruptedSyncs(LATER);
    const second = await after.recoverInterruptedSyncs(LATER);

    expect(first.ok && first.value.recovered).toBe(1);
    expect(second.ok && second.value.recovered).toBe(0);

    const listed = await after.listQueuedSales();

    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    // STILL ONE RECORD. Recovery never clones.
    expect(listed.value.sales).toHaveLength(1);
  });

  it("refuses a second record carrying the same sale identity, after restart", async () => {
    const before = await queueSession();

    expect((await enqueueOne(before)).ok).toBe(true);

    await restart();

    const after = await queueSession();
    // A different queue record, the SAME sale request id -- which is what a
    // duplicate submission would look like.
    const duplicate = await enqueueOne(after, SALE, "q-2");

    expect(duplicate).toEqual({ ok: false, reason: "duplicate_sale_request" });

    const listed = await after.listQueuedSales();

    expect(listed.ok && listed.value.sales).toHaveLength(1);
  });

  it("a genuinely different sale is still accepted after restart", async () => {
    const before = await queueSession();

    expect((await enqueueOne(before)).ok).toBe(true);

    await restart();

    const after = await queueSession();

    expect((await enqueueOne(after, OTHER_SALE, "q-2")).ok).toBe(true);

    const listed = await after.listQueuedSales();

    expect(listed.ok && listed.value.sales).toHaveLength(2);
  });

  it("a SYNCED record is not resubmitted by restart recovery", async () => {
    const before = await queueSession();

    expect((await enqueueOne(before)).ok).toBe(true);
    expect((await before.updateQueueState(QUEUE, "syncing", NOW)).ok).toBe(true);
    expect(
      (await before.markSynced(
        QUEUE,
        { orderId: "order-1", orderNumber: "ORD-0001", createdAt: NOW },
        NOW
      )).ok
    ).toBe(true);

    await restart();

    const after = await queueSession();
    const report = await after.recoverInterruptedSyncs(LATER);

    expect(report.ok && report.value.recovered).toBe(0);

    const record = await after.getQueuedSale(QUEUE);

    expect(record.ok).toBe(true);
    if (!record.ok) return;
    expect(record.value.state).toBe("synced");
    expect(record.value.serverOrderId).toBe("order-1");
  });
});

describe("4. an uncertain submission stays unresolved across a restart", () => {
  it("is still outstanding, under its original sale identity", async () => {
    const before = await import("@/lib/uncertainSaleSession");

    expect(await before.armUncertainSale(ARMED)).toBe(true);

    await restart();

    const after = await import("@/lib/uncertainSaleSession");
    const state = await after.readUncertainSale(IDENTITY);

    // UNRESOLVED means unresolved: the fence is still up, so the next sale
    // cannot mint a new identity for the same money.
    expect(state.status).toBe("outstanding");
    if (state.status !== "outstanding") return;
    expect(state.sale.saleRequestId).toBe(SALE);
    expect(state.sale.fingerprint).toBe("fp-1");
  });

  it("does not leak to a different device identity after a restart", async () => {
    const before = await import("@/lib/uncertainSaleSession");

    expect(await before.armUncertainSale(ARMED)).toBe(true);

    await restart();

    const after = await import("@/lib/uncertainSaleSession");
    const state = await after.readUncertainSale({
      ...IDENTITY,
      deviceId: "99999999-9999-4999-8999-999999999999",
    });

    // 6. RESTART RESPECTS THE EXISTING OWNERSHIP RULES. Another pairing's
    // evidence is unusable, not inherited.
    expect(state.status).toBe("unusable");
    if (state.status !== "unusable") return;
    expect(state.reason).toBe("identity_mismatch");
  });
});

describe("5 and 8. a rejected sale survives restart as Needs Attention", () => {
  it("keeps its state, reason, identity and register claim", async () => {
    const before = await queueSession();

    expect((await enqueueOne(before)).ok).toBe(true);
    expect((await before.updateQueueState(QUEUE, "syncing", NOW)).ok).toBe(true);
    expect(
      (await before.updateQueueState(QUEUE, "needs_attention", NOW, {
        lastErrorCode: "register_unverified",
        lastErrorMessage: "A register session is required for an offline sale",
      })).ok
    ).toBe(true);

    await restart();

    const after = await queueSession();
    const record = await after.getQueuedSale(QUEUE);

    expect(record.ok).toBe(true);
    if (!record.ok) return;

    expect(record.value.state).toBe("needs_attention");
    expect(record.value.lastErrorCode).toBe("register_unverified");
    expect(record.value.lastErrorMessage).toBe(
      "A register session is required for an offline sale"
    );
    expect(record.value.saleRequestId).toBe(SALE);
    expect(record.value.registerSessionId).toBe(REGISTER);
  });

  it("restart recovery does not drag it back into the sync queue", async () => {
    const before = await queueSession();

    expect((await enqueueOne(before)).ok).toBe(true);
    expect((await before.updateQueueState(QUEUE, "syncing", NOW)).ok).toBe(true);
    expect(
      (await before.updateQueueState(QUEUE, "needs_attention", NOW, {
        lastErrorCode: "register_unverified",
      })).ok
    ).toBe(true);

    await restart();

    const after = await queueSession();

    expect((await after.recoverInterruptedSyncs(LATER)).ok).toBe(true);

    const record = await after.getQueuedSale(QUEUE);

    expect(record.ok).toBe(true);
    if (!record.ok) return;
    // A person still has to resolve it. Recovery is not a resolution.
    expect(record.value.state).toBe("needs_attention");
  });

  it("still counts as unresolved, so the till cannot be reset over it", async () => {
    const before = await queueSession();

    expect((await enqueueOne(before)).ok).toBe(true);
    expect((await before.updateQueueState(QUEUE, "syncing", NOW)).ok).toBe(true);
    expect(
      (await before.updateQueueState(QUEUE, "needs_attention", NOW, {
        lastErrorCode: "register_unverified",
      })).ok
    ).toBe(true);

    await restart();

    const after = await queueSession();
    const summary = await after.getQueueSummary();

    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.needsAttention).toBe(1);
  });
});

describe("7. corrupt or unreadable stored state fails safely", () => {
  async function writeRaw(value: unknown): Promise<void> {
    const store: Store = await import("@/lib/deviceOfflineStore");
    const db = await store.openOfflineDb();

    expect(db.ok).toBe(true);
    if (!db.ok) return;

    await store.putQueuedSale(db.value, value);
  }

  it("quarantines an unreadable record instead of dropping it", async () => {
    await writeRaw({ queueRecordId: "broken-1", saleRequestId: "not-a-uuid", state: "pending" });

    await restart();

    const after = await queueSession();
    const listed = await after.listQueuedSales();

    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    // NOT silently discarded, and NOT loaded as a usable sale.
    expect(listed.value.sales).toHaveLength(0);
    expect(listed.value.quarantined).toHaveLength(1);
    expect(listed.value.quarantined[0].queueRecordId).toBe("broken-1");
  });

  it("is never treated as successfully completed", async () => {
    await writeRaw({ queueRecordId: "broken-1", saleRequestId: "not-a-uuid", state: "synced" });

    await restart();

    const after = await queueSession();
    const summary = await after.getQueueSummary();

    expect(summary.ok).toBe(true);
    if (!summary.ok) return;

    // A corrupt record claiming to be synced must not be counted as a completed
    // sale: that is how a real sale disappears from the evidence.
    expect(summary.value.synced).toBe(0);
  });

  it("a corrupt record does not hide a healthy one beside it", async () => {
    const before = await queueSession();

    expect((await enqueueOne(before)).ok).toBe(true);
    await writeRaw({ queueRecordId: "broken-1", saleRequestId: "not-a-uuid", state: "pending" });

    await restart();

    const after = await queueSession();
    const listed = await after.listQueuedSales();

    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.sales).toHaveLength(1);
    expect(listed.value.sales[0].saleRequestId).toBe(SALE);
    expect(listed.value.quarantined).toHaveLength(1);
  });

  it("an unreadable uncertain record is reported unusable, not absent", async () => {
    const store: Store = await import("@/lib/deviceOfflineStore");
    const db = await store.openOfflineDb();

    expect(db.ok).toBe(true);
    if (!db.ok) return;

    const record = await import("@/lib/uncertainSaleRecord");

    void record;
    await store.writeUncertainSaleRecordRaw(db.value, { schemaVersion: 999, nonsense: true });

    await restart();

    const after = await import("@/lib/uncertainSaleSession");
    const state = await after.readUncertainSale(IDENTITY);

    // "Something is there that cannot be understood" is NOT "nothing is there".
    // Treating it as nothing would release the fence over a sale that may have
    // reached the server.
    expect(state.status).toBe("unusable");
  });
});

describe("6. restart respects revocation, reset and attribution rules", () => {
  async function resetSafety() {
    const checkout = await import("@/lib/offlineCheckoutSession");
    const status = await import("@/lib/offlineSaleStatus");

    return status.decideDeviceResetSafety(await checkout.readOfflineSaleStatus());
  }

  it("a queued sale still blocks a device reset after a restart", async () => {
    const before = await queueSession();

    expect((await enqueueOne(before)).ok).toBe(true);

    await restart();

    const safety = await resetSafety();

    // Resetting here would erase the only record of money already taken.
    expect(safety.allowed).toBe(false);
    if (safety.allowed) return;
    expect(safety.unsynced).toBe(1);
  });

  it("an uncertain online sale still blocks a device reset after a restart", async () => {
    const before = await import("@/lib/uncertainSaleSession");

    expect(await before.armUncertainSale(ARMED)).toBe(true);

    await restart();

    const safety = await resetSafety();

    expect(safety.allowed).toBe(false);
    if (safety.allowed) return;
    expect(safety.message).toContain("may already have gone through");
  });

  it("a CORRUPT record still blocks a reset after a restart", async () => {
    // THE CASE THAT MATTERS MOST HERE. A record that cannot be parsed may well
    // be a real unsynced sale. If quarantining it also made it invisible to the
    // reset gate, a till could be wiped over money it had taken.
    const store: Store = await import("@/lib/deviceOfflineStore");
    const db = await store.openOfflineDb();

    expect(db.ok).toBe(true);
    if (!db.ok) return;

    await store.putQueuedSale(db.value, {
      queueRecordId: "broken-1",
      saleRequestId: "not-a-uuid",
      state: "pending",
    });

    await restart();

    const safety = await resetSafety();

    expect(safety.allowed).toBe(false);
    if (safety.allowed) return;
    expect(safety.unsynced).toBe(1);
  });

  it("allows a reset after a restart when nothing is outstanding", async () => {
    // The gate is not simply always-closed: with everything resolved it opens,
    // which is what makes the refusals above meaningful.
    const before = await queueSession();

    expect((await enqueueOne(before)).ok).toBe(true);
    expect((await before.updateQueueState(QUEUE, "syncing", NOW)).ok).toBe(true);
    expect(
      (await before.markSynced(
        QUEUE,
        { orderId: "order-1", orderNumber: "ORD-0001", createdAt: NOW },
        NOW
      )).ok
    ).toBe(true);

    await restart();

    expect((await resetSafety()).allowed).toBe(true);
  });

  it("the queue is device-global, which the reset gate is what protects", async () => {
    // STATED AS A FINDING, NOT A COMPLAINT. listQueuedSales takes no identity
    // and the sync engine references none, so a record written under one
    // pairing is still present after a restart. What prevents it reaching the
    // wrong project is that a device carrying unresolved sales cannot be reset
    // or re-paired at all -- the assertion above. This pins the dependency, so
    // that if the reset gate is ever relaxed, the gap becomes visible here.
    const before = await queueSession();

    expect((await enqueueOne(before)).ok).toBe(true);

    await restart();

    const after = await queueSession();
    const listed = await after.listQueuedSales();

    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.sales).toHaveLength(1);
    // The record still names the pairing it was taken under.
    expect(listed.value.sales[0].deviceId).toBe(IDENTITY.deviceId);
    expect(listed.value.sales[0].projectId).toBe(IDENTITY.projectId);
    expect((await resetSafety()).allowed).toBe(false);
  });
});
