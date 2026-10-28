// v1.3.4 (owner's offline test) — the background sync never claims a row, and
// so never pauses new sales, while the server is silent.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLockManagerForTests } from "@/lib/tabLocks";
import { createLockRegistry } from "@/test/locks/processLocks";
import { enqueueSale, listQueuedSales } from "@/lib/saleQueueSession";
import { createSaleSyncEngine } from "@/lib/saleSyncEngine";
import { isStrictRecoveryInFlight, readCheckoutRecoveryClearance, resetRecoveryCoordinatorForTests } from "@/lib/recoveryCheckoutCoordinator";
import type { OfflineSaleSubmission } from "@/lib/offlineSaleRpc";

const IDENTITY = {
  deviceAuthUserId: "a0000000-0000-4000-8000-000000000001",
  deviceId: "d0000000-0000-4000-8000-000000000001",
  projectId: "b0000000-0000-4000-8000-000000000001",
  buildJobId: "c0000000-0000-4000-8000-000000000001",
};
const STRICT = {
  originalEmployeeId: "e1000000-0000-4000-8000-000000000001",
  originalEmployeePosSessionId: "e0000000-0000-4000-8000-000000000001",
  originalRegisterSessionId: "f0000000-0000-4000-8000-000000000001",
  originalAttemptAt: "2026-10-20T10:00:00.000Z",
};
const sale = (id: string, strict: boolean) =>
  ({
    saleRequestId: id, queueRecordId: `q-${id}`, ...IDENTITY, paymentMethod: "cash",
    items: [{ itemId: "item-1", quantity: 1, modifiers: [] }],
    occurredAt: "2026-10-20T10:00:00.000Z", now: "2026-10-20T10:00:00.000Z",
    ...(strict ? { strictRecovery: STRICT } : {}),
  }) as never;
const A = "71000000-0000-4000-8000-000000000001";
const B = "72000000-0000-4000-8000-000000000002";

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetRecoveryCoordinatorForTests();
  setLockManagerForTests(createLockRegistry().process());
});
afterEach(() => setLockManagerForTests(undefined));

describe("sync with the server silent", () => {
  it("claims nothing, submits nothing, never holds the recovery counter, and checkout stays open", async () => {
    await enqueueSale(sale(A, true));
    await enqueueSale(sale(B, false));
    const submit = vi.fn();
    let counterSeenDuringCheck: boolean | null = null;
    const report = await createSaleSyncEngine({
      submit: submit as never,
      now: () => Date.now(),
      canReachServer: async () => {
        counterSeenDuringCheck = isStrictRecoveryInFlight();
        const clearance = await readCheckoutRecoveryClearance();
        expect(clearance.ok).toBe(true); // a new sale is NOT paused while the check runs
        return false;
      },
    }).run();
    expect(submit).not.toHaveBeenCalled();
    expect(counterSeenDuringCheck).toBe(false);
    expect(report.attempted).toBe(0);
    const rows = await listQueuedSales();
    if (!rows.ok) throw new Error("list");
    expect(rows.value.sales.map((s) => s.state).sort()).toEqual(["pending", "pending"]);
  });

  it("a throwing check counts as silence", async () => {
    await enqueueSale(sale(A, false));
    const submit = vi.fn();
    await createSaleSyncEngine({ submit: submit as never, now: () => Date.now(), canReachServer: async () => { throw new Error("x"); } }).run();
    expect(submit).not.toHaveBeenCalled();
  });

  it("an empty queue does not even ask the server", async () => {
    const canReachServer = vi.fn(async () => true);
    await createSaleSyncEngine({ submit: vi.fn() as never, now: () => Date.now(), canReachServer }).run();
    expect(canReachServer).not.toHaveBeenCalled();
  });

  it("with the server there, it syncs exactly as before", async () => {
    await enqueueSale(sale(B, false));
    const submit = vi.fn(async (r: { saleRequestId: string }): Promise<OfflineSaleSubmission> =>
      ({ ok: true, receipt: { orderId: `o-${r.saleRequestId}`, orderNumber: "ORD-1", createdAt: "2026-10-20T11:00:00.000Z" } }) as unknown as OfflineSaleSubmission);
    const report = await createSaleSyncEngine({ submit: submit as never, now: () => Date.now(), canReachServer: async () => true }).run();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(report.synced).toBe(1);
  });
});
