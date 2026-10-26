// v1.3.4 owner decision (2026-10-26): a strict-recovery conflict is SET ASIDE and
// the till keeps selling (REPORT §10 / OD-3). These tests try to break that rule:
// a set-aside sale must stay preserved, never be sent again automatically, and
// never hide the cases that must still refuse a new sale. Real queue / sync /
// checkout-gate modules over fake-indexeddb; the server is a mocked submit.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLockManagerForTests } from "@/lib/tabLocks";
import { createLockRegistry } from "@/test/locks/processLocks";
import { enqueueSale, listQueuedSales, updateQueueState } from "@/lib/saleQueueSession";
import { isRecoveryActivityUnchanged, readCheckoutRecoveryClearance, resetRecoveryCoordinatorForTests } from "@/lib/recoveryCheckoutCoordinator";
import { createSaleSyncEngine } from "@/lib/saleSyncEngine";
import { openOfflineDb, putQueuedSale } from "@/lib/deviceOfflineStore";
import { readOfflineSaleStatus } from "@/lib/offlineCheckoutSession";
import { decideDeviceResetSafety } from "@/lib/offlineSaleStatus";
import type { OfflineSaleSubmission } from "@/lib/offlineSaleRpc";

const IDENTITY = {
  deviceAuthUserId: "a0000000-0000-4000-8000-000000000001",
  deviceId: "d0000000-0000-4000-8000-000000000001",
  projectId: "b0000000-0000-4000-8000-000000000001",
  buildJobId: "c0000000-0000-4000-8000-000000000001",
};
const CARA = {
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
    ...(strict ? { strictRecovery: CARA } : {}),
  }) as never;
const id = (n: number) => `7${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`;

/** A strict sale the server answered with a conflict: needs_attention + recoveryProtection. */
async function setAside(n: number) {
  expect((await enqueueSale(sale(id(n), true))).ok).toBe(true);
  expect((await updateQueueState(`q-${id(n)}`, "syncing", "2026-10-20T10:01:00.000Z")).ok).toBe(true);
  expect((await updateQueueState(`q-${id(n)}`, "needs_attention", "2026-10-20T10:02:00.000Z", { lastErrorCode: "attribution_conflict" })).ok).toBe(true);
}
async function rows() {
  const l = await listQueuedSales();
  if (!l.ok) throw new Error("list");
  return l.value.sales;
}
async function checkoutAllowed() {
  const c = await readCheckoutRecoveryClearance();
  return c.ok && isRecoveryActivityUnchanged(c.mark) ? true : c.ok ? "changed" : c.reason;
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetRecoveryCoordinatorForTests();
  setLockManagerForTests(createLockRegistry().process());
});
afterEach(() => setLockManagerForTests(undefined));

describe("v1.3.4 set-aside conflicts", () => {
  it("a set-aside conflict allows new sales, keeps its protection, original attribution and bytes", async () => {
    await setAside(1);
    const before = (await rows())[0];
    expect(before.recoveryProtection).toMatchObject({ code: "attribution_conflict" });
    expect(await checkoutAllowed()).toBe(true);
    expect((await rows())[0]).toEqual(before); // reading never changes it
    expect(before.strictRecovery).toEqual(CARA);
  });

  it("a set-aside conflict NEVER hides an unreadable strict-looking row: that still refuses", async () => {
    await setAside(2);
    const opened = await openOfflineDb();
    if (!opened.ok) throw new Error("db");
    await putQueuedSale(opened.value, { queueRecordId: "bad", saleRequestId: id(99), requestPayloadVersion: 5 } as never);
    opened.value.close();
    expect(await checkoutAllowed()).toBe("unreadable_recovery_record");
  });

  it("a set-aside conflict NEVER hides a strict sale being sent right now: that still refuses until it finishes", async () => {
    await setAside(3);
    await enqueueSale(sale(id(4), true));
    await updateQueueState(`q-${id(4)}`, "syncing", "2026-10-20T10:05:00.000Z");
    expect(await checkoutAllowed()).toBe("recovery_in_progress");
  });

  it("20 set-aside conflicts while trading continues: every one preserved byte-for-byte and never submitted; ordinary sales still sync", async () => {
    for (let n = 10; n < 30; n += 1) await setAside(n);
    const snapshot = JSON.stringify((await rows()).filter((r) => r.recoveryProtection));
    const submitted: string[] = [];
    const submit = vi.fn(async (r: { saleRequestId: string }): Promise<OfflineSaleSubmission> => {
      submitted.push(r.saleRequestId);
      return { ok: true, receipt: { orderId: `o-${r.saleRequestId}`, orderNumber: `ORD-${submitted.length}`, createdAt: "2026-10-20T11:00:00.000Z" } } as unknown as OfflineSaleSubmission;
    });
    for (let n = 100; n < 110; n += 1) {
      expect(await checkoutAllowed()).toBe(true);
      await enqueueSale(sale(id(n), false));
      await createSaleSyncEngine({ submit: submit as never, now: () => Date.now() }).run();
    }
    expect(submitted.sort()).toEqual(Array.from({ length: 10 }, (_, i) => id(100 + i)).sort());
    expect(JSON.stringify((await rows()).filter((r) => r.recoveryProtection))).toBe(snapshot);
  });

  it("reset and unpair stay refused while a set-aside sale is stored; the till shows it needs attention", async () => {
    await setAside(5);
    const status = await readOfflineSaleStatus();
    expect(status.needsAttention).toBeGreaterThanOrEqual(1);
    expect(decideDeviceResetSafety(status).allowed).toBe(false);
  });
});
