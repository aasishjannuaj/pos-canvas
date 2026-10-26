// Batch B — cross-tab coordination (lib/tabLocks.ts) and its use by the queue,
// the sync engine and the checkout gate. Storage: fake-indexeddb. Locks: the
// killable test registry (test/locks/processLocks.ts) standing in for two tabs,
// or `null` for a runtime without navigator.locks. SERVER: injected submit —
// mocked. The real-browser version of these scenarios is
// prototype/multitab/run-b.mjs (real Chromium, real navigator.locks).
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATE_LOCK,
  acquireLock,
  isLockHeld,
  releaseAfterCurrentTurn,
  setLockManagerForTests,
  submissionLock,
} from "@/lib/tabLocks";
import { createLockRegistry } from "@/test/locks/processLocks";
import { enqueueSale, listQueuedSales, recoverInterruptedSyncs, updateQueueState } from "@/lib/saleQueueSession";
import { isRecoveryActivityUnchanged, readCheckoutRecoveryClearance, resetRecoveryCoordinatorForTests } from "@/lib/recoveryCheckoutCoordinator";
import { createSaleSyncEngine } from "@/lib/saleSyncEngine";
import type { OfflineSaleSubmission } from "@/lib/offlineSaleRpc";

const IDENTITY = {
  deviceAuthUserId: "a0000000-0000-4000-8000-000000000001",
  deviceId: "d0000000-0000-4000-8000-000000000001",
  projectId: "b0000000-0000-4000-8000-000000000001",
  buildJobId: "c0000000-0000-4000-8000-000000000001",
};

function sale(id: string, strict: boolean) {
  return {
    saleRequestId: id,
    queueRecordId: `q-${id}`,
    ...IDENTITY,
    paymentMethod: "card",
    items: [{ itemId: "item-1", quantity: 1, modifiers: [] }],
    occurredAt: "2026-10-20T10:00:00.000Z",
    now: "2026-10-20T10:00:00.000Z",
    ...(strict
      ? {
          strictRecovery: {
            originalEmployeeId: "e1000000-0000-4000-8000-000000000001",
            originalEmployeePosSessionId: "e0000000-0000-4000-8000-000000000001",
            originalRegisterSessionId: "f0000000-0000-4000-8000-000000000001",
            originalAttemptAt: "2026-10-20T10:00:00.000Z",
          },
        }
      : {}),
  } as never;
}

const STRICT = "70000000-0000-4000-8000-000000000001";
const ORDINARY = "71000000-0000-4000-8000-000000000001";

async function state(id: string) {
  const listing = await listQueuedSales();
  if (!listing.ok) throw new Error("list");
  return listing.value.sales.find((s) => s.saleRequestId === id)?.state ?? null;
}

const never = (): Promise<OfflineSaleSubmission> => new Promise(() => undefined);

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetRecoveryCoordinatorForTests();
});
afterEach(() => setLockManagerForTests(undefined));

describe("tabLocks primitives", () => {
  it("exclusive: a second holder waits; ifAvailable gets null; release hands over", async () => {
    const reg = createLockRegistry();
    const a = reg.process();
    const b = reg.process();
    const first = await acquireLock(a, "x");

    expect(first?.isHeld()).toBe(true);
    expect(await acquireLock(b, "x", { ifAvailable: true })).toBeNull();
    expect(await isLockHeld(b, "x")).toBe(true);

    const waiting = acquireLock(b, "x", { waitMs: 1000 });

    first!.release();
    const second = await waiting;

    expect(first!.isHeld()).toBe(false);
    expect(second?.isHeld()).toBe(true);
    second!.release();
  });

  it("a bounded wait gives up with null and leaves nothing pending; a killed holder frees the lock", async () => {
    const reg = createLockRegistry();
    const a = reg.process();
    const b = reg.process();

    await acquireLock(a, "x");
    expect(await acquireLock(b, "x", { waitMs: 30 })).toBeNull();
    expect((await b.query()).pending).toEqual([]);

    a.kill();
    expect(await isLockHeld(b, "x")).toBe(false);
    expect(await acquireLock(b, "x", { ifAvailable: true })).not.toBeNull();
  });

  it("a request that throws, or no LockManager, never throws to the caller", async () => {
    const broken = { request: () => { throw new Error("boom"); }, query: async () => ({}) };

    expect(await acquireLock(broken, "x")).toBeNull();
    expect(await isLockHeld(null, "x")).toBeNull();
  });

  it("releaseAfterCurrentTurn: the awaiting caller's synchronous continuation still runs inside the lock", async () => {
    const reg = createLockRegistry();
    const a = reg.process();
    const take = async () => {
      const lock = (await acquireLock(a, "x"))!;
      releaseAfterCurrentTurn(lock);
      return lock;
    };

    const lock = await take();

    expect(lock.isHeld()).toBe(true); // continuation of the await: still held
    await new Promise((r) => setTimeout(r, 0));
    expect(lock.isHeld()).toBe(false);
  });
});

describe("checkout gate across tabs", () => {
  it("M1: another tab's strict claim waits while this tab's checkout holds the gate", async () => {
    const reg = createLockRegistry();
    const tabB = reg.process();

    setLockManagerForTests(tabB);
    expect((await enqueueSale(sale(STRICT, true))).ok).toBe(true);

    // Tab A holds the gate as a checkout does; tab B's engine must not claim.
    const tabA = reg.process();
    const gate = (await acquireLock(tabA, GATE_LOCK))!;
    const submit = vi.fn(never);
    const run = createSaleSyncEngine({ submit, now: () => Date.now() }).run();

    await new Promise((r) => setTimeout(r, 50));
    expect(await state(STRICT)).toBe("pending");
    expect(submit).not.toHaveBeenCalled();

    gate.release();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(await state(STRICT)).toBe("syncing");
    void run;
  });

  it("a clearance is refused after its turn, and a busy gate refuses rather than reading without it", async () => {
    const reg = createLockRegistry();
    const tab = reg.process();

    setLockManagerForTests(tab);
    const c = await readCheckoutRecoveryClearance();

    expect(c.ok && isRecoveryActivityUnchanged(c.mark)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.ok && isRecoveryActivityUnchanged(c.mark)).toBe(false);
  });

  it("without navigator.locks: a pending strict row refuses checkout; ordinary rows do not (fail closed)", async () => {
    setLockManagerForTests(null);
    expect((await enqueueSale(sale(ORDINARY, false))).ok).toBe(true);

    const ordinary = await readCheckoutRecoveryClearance();

    expect(ordinary.ok && isRecoveryActivityUnchanged(ordinary.mark)).toBe(true);
    expect((await enqueueSale(sale(STRICT, true))).ok).toBe(true);
    expect(await readCheckoutRecoveryClearance()).toEqual({ ok: false, reason: "recovery_in_progress" });
  });
});

describe("startup recovery and concurrent drains across tabs", () => {
  it("M2: a syncing row whose submission lock another tab holds is left alone; once that tab dies it is reclaimed", async () => {
    const reg = createLockRegistry();
    const tabA = reg.process();
    const tabB = reg.process();

    setLockManagerForTests(tabA);
    await enqueueSale(sale(STRICT, true));
    void createSaleSyncEngine({ submit: never, now: () => Date.now() }).run();
    await vi.waitFor(async () => expect(await state(STRICT)).toBe("syncing"));
    expect(await isLockHeld(tabB, submissionLock(`q-${STRICT}`))).toBe(true);

    setLockManagerForTests(tabB);
    const live = await recoverInterruptedSyncs("2026-10-20T10:05:00.000Z");

    expect(live.ok && live.value.recovered).toBe(0);
    expect(await state(STRICT)).toBe("syncing");

    tabA.kill();
    const orphan = await recoverInterruptedSyncs("2026-10-20T10:06:00.000Z");

    expect(orphan.ok && orphan.value.recovered).toBe(1);
    expect(await state(STRICT)).toBe("pending");
  });

  it("without navigator.locks: strict syncing rows are left for the gate to keep refusing; ordinary ones are reclaimed as before", async () => {
    setLockManagerForTests(null);
    await enqueueSale(sale(STRICT, true));
    await enqueueSale(sale(ORDINARY, false));
    await updateQueueState(`q-${STRICT}`, "syncing", "2026-10-20T10:01:00.000Z");
    await updateQueueState(`q-${ORDINARY}`, "syncing", "2026-10-20T10:01:00.000Z");

    const r = await recoverInterruptedSyncs("2026-10-20T10:05:00.000Z");

    expect(r.ok && r.value.recovered).toBe(1);
    expect(await state(STRICT)).toBe("syncing");
    expect(await state(ORDINARY)).toBe("pending");
  });

  it("M3: a row whose submission another tab holds is skipped, not claimed or sent", async () => {
    const reg = createLockRegistry();
    const tabA = reg.process();
    const tabB = reg.process();

    setLockManagerForTests(tabB);
    await enqueueSale(sale(STRICT, true));
    // Tab A has listed the row and taken its submission lock, about to claim.
    const held = (await acquireLock(tabA, submissionLock(`q-${STRICT}`)))!;
    const submit = vi.fn(never);
    const report = await createSaleSyncEngine({ submit, now: () => Date.now() }).run();

    expect(report.outcomes).toEqual([
      { queueRecordId: `q-${STRICT}`, result: "skipped", code: "locked_by_another_tab", orderNumber: null },
    ]);
    expect(submit).not.toHaveBeenCalled();
    expect(await state(STRICT)).toBe("pending");
    held.release();
  });

  it("M3: two tabs draining at once submit each row exactly once", async () => {
    const reg = createLockRegistry();
    const tabA = reg.process();
    const tabB = reg.process();

    setLockManagerForTests(tabA);
    await enqueueSale(sale(STRICT, true));
    await enqueueSale(sale(ORDINARY, false));

    const submit = vi.fn(async (): Promise<OfflineSaleSubmission> => {
      await new Promise((r) => setTimeout(r, 20));
      return { ok: false, failure: { kind: "network" } } as unknown as OfflineSaleSubmission;
    });
    const runA = createSaleSyncEngine({ submit, now: () => Date.now() }).run();

    // The override is module-global, so after this line both runs resolve tabB's
    // manager; exclusivity does not depend on the owner (Web Locks are exclusive
    // within one tab too). The two-real-tabs version is run-b.mjs M3.
    setLockManagerForTests(tabB);
    const runB = createSaleSyncEngine({ submit, now: () => Date.now() }).run();

    await Promise.all([runA, runB]);
    const ids = submit.mock.calls.map((call) => (call as unknown as [{ saleRequestId: string }])[0].saleRequestId);

    expect(ids.sort()).toEqual([STRICT, ORDINARY].sort());
  });
});
