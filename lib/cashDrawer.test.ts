// v1.3 Cash Drawer Checkpoint 1A — the drawer-event rules and the durable,
// atomic claim, exercised against a real IndexedDB engine.
//
// fake-indexeddb implements the IndexedDB specification, so the unique-key
// `add`, transaction aborts, version upgrades and reopen-after-close are the
// real semantics rather than a mock. Opted in per file, as in
// lib/deviceOfflineStore.test.ts.
//
// Where a property can only be proven at the source level — WHERE PosRuntime
// calls the hook, WHO wires it — it lives in lib/cashDrawer.guards.test.ts.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  UNAVAILABLE_CASH_DRAWER,
  createDrawerEventRecord,
  isAutomaticDrawerEligible,
  isAutomaticDrawerPlatform,
  runAutomaticDrawerEvent,
} from "@/lib/cashDrawer";
import type {
  CashDrawerCapability,
  CashDrawerSaleEvent,
  ClaimDrawerEvent,
} from "@/lib/cashDrawer";
import { claimAutomaticDrawerEvent } from "@/lib/cashDrawerSession";
import {
  CACHE_STORE,
  DRAWER_EVENT_STORE,
  OFFLINE_DB_NAME,
  OFFLINE_DB_VERSION,
  SALE_QUEUE_REQUEST_ID_INDEX,
  SALE_QUEUE_STORE,
  insertDrawerEventClaim,
  insertQueuedSale,
  openOfflineDb,
  readPinnedConfigRecord,
  writePinnedConfigRecord,
} from "@/lib/deviceOfflineStore";

const SALE_A = "6f1d2a4e-7b3c-4d5e-8f90-a1b2c3d4e5f6";
const SALE_B = "6f1d2a4e-7b3c-4d5e-8f90-a1b2c3d4e5f7";

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

function cash(saleRequestId = SALE_A): CashDrawerSaleEvent {
  return { saleRequestId, paymentMethod: "cash" };
}

/** A capability that counts how often it is asked. */
function countingDrawer(answer: () => Promise<"opened" | "unavailable" | "unknown"> = async () => "opened") {
  const requestOpen = vi.fn<CashDrawerCapability["requestOpen"]>(answer);
  const capability: CashDrawerCapability = { available: true, requestOpen };

  return { capability, requestOpen };
}

/** The real durable claim, through the real database. */
const durableClaim: ClaimDrawerEvent = (id) => claimAutomaticDrawerEvent(id, 0);

async function readAllDrawerEvents(): Promise<unknown[]> {
  const opened = await openOfflineDb();

  if (!opened.ok) throw new Error("unreachable");

  const db = opened.value;

  const rows = await new Promise<unknown[]>((resolve, reject) => {
    const request = db.transaction(DRAWER_EVENT_STORE, "readonly").objectStore(DRAWER_EVENT_STORE).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  db.close();

  return rows;
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

describe("automatic eligibility", () => {
  it("cash is eligible and card never is", () => {
    expect(isAutomaticDrawerEligible("cash")).toBe(true);
    expect(isAutomaticDrawerEligible("card")).toBe(false);
  });

  it("only the Windows shell may run the automatic path — never Android, never web", () => {
    expect(isAutomaticDrawerPlatform("windows")).toBe(true);
    expect(isAutomaticDrawerPlatform("android")).toBe(false);
    expect(isAutomaticDrawerPlatform("web")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The coordinator against the real ledger
// ---------------------------------------------------------------------------

describe("one completed cash sale produces exactly one drawer event", () => {
  it("a successful cash sale claims once and asks the drawer once", async () => {
    const { capability, requestOpen } = countingDrawer();

    const outcome = await runAutomaticDrawerEvent({
      event: cash(),
      platform: "windows",
      claim: durableClaim,
      capability,
    });

    expect(outcome).toEqual({ status: "requested", outcome: "opened" });
    expect(requestOpen).toHaveBeenCalledTimes(1);
    expect(requestOpen).toHaveBeenCalledWith({ saleRequestId: SALE_A });
    expect(await readAllDrawerEvents()).toHaveLength(1);
  });

  it("the identity is the saleRequestId: the record is keyed by it and by nothing else", async () => {
    await runAutomaticDrawerEvent({
      event: cash(),
      platform: "windows",
      claim: durableClaim,
      capability: UNAVAILABLE_CASH_DRAWER,
    });

    const [record] = await readAllDrawerEvents();

    expect(record).toEqual(createDrawerEventRecord({ saleRequestId: SALE_A, now: 0 }));

    const opened = await openOfflineDb();
    if (!opened.ok) throw new Error("unreachable");
    expect(opened.value.transaction(DRAWER_EVENT_STORE).objectStore(DRAWER_EVENT_STORE).keyPath).toBe(
      "saleRequestId"
    );
    opened.value.close();
  });

  it("a card sale records nothing and asks nothing", async () => {
    const { capability, requestOpen } = countingDrawer();
    const claim = vi.fn(durableClaim);

    const outcome = await runAutomaticDrawerEvent({
      event: { saleRequestId: SALE_A, paymentMethod: "card" },
      platform: "windows",
      claim,
      capability,
    });

    expect(outcome).toEqual({ status: "skipped", reason: "not_cash" });
    expect(claim).not.toHaveBeenCalled();
    expect(requestOpen).not.toHaveBeenCalled();
    expect(await readAllDrawerEvents()).toHaveLength(0);
  });

  it("Android cannot activate the automatic path: no claim, no drawer request", async () => {
    const { capability, requestOpen } = countingDrawer();
    const claim = vi.fn(durableClaim);

    for (const platform of ["android", "web"] as const) {
      const outcome = await runAutomaticDrawerEvent({ event: cash(), platform, claim, capability });

      expect(outcome).toEqual({ status: "skipped", reason: "platform" });
    }

    expect(claim).not.toHaveBeenCalled();
    expect(requestOpen).not.toHaveBeenCalled();
    expect(await readAllDrawerEvents()).toHaveLength(0);
  });

  it("an empty identity is refused before the ledger", async () => {
    const claim = vi.fn(durableClaim);

    const outcome = await runAutomaticDrawerEvent({
      event: cash("  "),
      platform: "windows",
      claim,
      capability: UNAVAILABLE_CASH_DRAWER,
    });

    expect(outcome).toEqual({ status: "skipped", reason: "invalid_identity" });
    expect(claim).not.toHaveBeenCalled();
  });
});

describe("deduplication is durable and keyed by saleRequestId", () => {
  it("the same saleRequestId produces one event in total; a different one produces its own", async () => {
    const { capability, requestOpen } = countingDrawer();
    const run = (id: string) =>
      runAutomaticDrawerEvent({ event: cash(id), platform: "windows", claim: durableClaim, capability });

    expect((await run(SALE_A)).status).toBe("requested");
    expect(await run(SALE_A)).toEqual({ status: "already_claimed" });
    expect((await run(SALE_B)).status).toBe("requested");

    expect(requestOpen).toHaveBeenCalledTimes(2);
    expect(requestOpen.mock.calls.map(([event]) => event.saleRequestId)).toEqual([SALE_A, SALE_B]);
    expect(await readAllDrawerEvents()).toHaveLength(2);
  });

  it("duplicate callbacks for one sale produce one event", async () => {
    const { capability, requestOpen } = countingDrawer();

    for (let i = 0; i < 5; i += 1) {
      await runAutomaticDrawerEvent({ event: cash(), platform: "windows", claim: durableClaim, capability });
    }

    expect(requestOpen).toHaveBeenCalledTimes(1);
    expect(await readAllDrawerEvents()).toHaveLength(1);
  });

  it("concurrent claims for one sale have exactly one winner", async () => {
    const { capability, requestOpen } = countingDrawer();

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        runAutomaticDrawerEvent({ event: cash(), platform: "windows", claim: durableClaim, capability })
      )
    );

    expect(outcomes.filter((o) => o.status === "requested")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "already_claimed")).toHaveLength(7);
    expect(requestOpen).toHaveBeenCalledTimes(1);
  });

  it("concurrent raw inserts on one connection: one commits, the rest are refused as existing", async () => {
    const opened = await openOfflineDb();
    if (!opened.ok) throw new Error("unreachable");

    const results = await Promise.all(
      Array.from({ length: 6 }, () => insertDrawerEventClaim(opened.value, { saleRequestId: SALE_A }))
    );

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "exists")).toHaveLength(5);
    opened.value.close();
  });

  it("a restart retains the claim: a fresh connection still refuses the same sale", async () => {
    const { capability, requestOpen } = countingDrawer();

    await runAutomaticDrawerEvent({ event: cash(), platform: "windows", claim: durableClaim, capability });

    // Every claim opens and closes its own connection, so the second run below
    // is a new connection to the same persisted database — what a remount or a
    // process restart sees. Opening an extra one first makes that explicit.
    const reopened = await openOfflineDb();
    if (!reopened.ok) throw new Error("unreachable");
    reopened.value.close();

    const second = await runAutomaticDrawerEvent({
      event: cash(),
      platform: "windows",
      claim: durableClaim,
      capability,
    });

    expect(second).toEqual({ status: "already_claimed" });
    expect(requestOpen).toHaveBeenCalledTimes(1);
  });
});

describe("failure and unknown never re-kick", () => {
  it("a ledger that cannot be written asks no drawer", async () => {
    const { capability, requestOpen } = countingDrawer();

    for (const claim of [
      async () => "failed" as const,
      async () => {
        throw new Error("storage exploded");
      },
    ]) {
      const outcome = await runAutomaticDrawerEvent({ event: cash(), platform: "windows", claim, capability });

      expect(outcome).toEqual({ status: "claim_failed" });
    }

    expect(requestOpen).not.toHaveBeenCalled();
  });

  it("unavailable storage fails closed to `failed`", async () => {
    // @ts-expect-error — simulating a WebView with no IndexedDB at all.
    globalThis.indexedDB = undefined;

    expect(await claimAutomaticDrawerEvent(SALE_A)).toBe("failed");
  });

  it("a capability that throws is reported as unknown, never thrown, and never retried", async () => {
    const { capability, requestOpen } = countingDrawer(async () => {
      throw new Error("drawer exploded");
    });

    const first = await runAutomaticDrawerEvent({ event: cash(), platform: "windows", claim: durableClaim, capability });
    const second = await runAutomaticDrawerEvent({ event: cash(), platform: "windows", claim: durableClaim, capability });

    expect(first).toEqual({ status: "requested", outcome: "unknown" });
    expect(second).toEqual({ status: "already_claimed" });
    expect(requestOpen).toHaveBeenCalledTimes(1);
  });

  it("an `unknown` answer leaves the claim standing, so the sale is never re-kicked", async () => {
    const { capability, requestOpen } = countingDrawer(async () => "unknown");

    await runAutomaticDrawerEvent({ event: cash(), platform: "windows", claim: durableClaim, capability });
    await runAutomaticDrawerEvent({ event: cash(), platform: "windows", claim: durableClaim, capability });

    expect(requestOpen).toHaveBeenCalledTimes(1);
    expect(await readAllDrawerEvents()).toHaveLength(1);
  });

  it("an unrecognised capability answer is treated as unknown", async () => {
    const { capability } = countingDrawer(async () => "kicked" as unknown as "opened");

    expect(
      await runAutomaticDrawerEvent({ event: cash(), platform: "windows", claim: durableClaim, capability })
    ).toEqual({ status: "requested", outcome: "unknown" });
  });

  it("the coordinator never rejects, so a caller's sale cannot be disturbed by it", async () => {
    const { capability } = countingDrawer(async () => {
      throw new Error("drawer exploded");
    });

    await expect(
      runAutomaticDrawerEvent({
        event: cash(),
        platform: "windows",
        claim: async () => {
          throw new Error("ledger exploded");
        },
        capability,
      })
    ).resolves.toEqual({ status: "claim_failed" });

    await expect(
      runAutomaticDrawerEvent({ event: cash(), platform: "windows", claim: durableClaim, capability })
    ).resolves.toEqual({ status: "requested", outcome: "unknown" });
  });
});

describe("the 1A capability contacts nothing", () => {
  it("is unavailable and answers unavailable", async () => {
    expect(UNAVAILABLE_CASH_DRAWER.available).toBe(false);
    expect(await UNAVAILABLE_CASH_DRAWER.requestOpen({ saleRequestId: SALE_A })).toBe("unavailable");
    expect(Object.isFrozen(UNAVAILABLE_CASH_DRAWER)).toBe(true);
  });

  it("the shared boundary takes only the sale identity — no hardware parameter", () => {
    expect(Object.keys(UNAVAILABLE_CASH_DRAWER).sort()).toEqual(["available", "requestOpen"]);
    expect(UNAVAILABLE_CASH_DRAWER.requestOpen.length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("the v2 -> v3 upgrade is additive", () => {
  it("a v2 device keeps its config and every queued sale, and gains the ledger", async () => {
    const v2 = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = globalThis.indexedDB.open(OFFLINE_DB_NAME, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore(CACHE_STORE);
        const queue = db.createObjectStore(SALE_QUEUE_STORE, { keyPath: "queueRecordId" });
        queue.createIndex(SALE_QUEUE_REQUEST_ID_INDEX, "saleRequestId", { unique: true });
        queue.createIndex("by-state", "state", { unique: false });
        queue.createIndex("by-queued-at", "queuedAt", { unique: false });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    await writePinnedConfigRecord(v2, { marker: "config-from-v2" });
    await insertQueuedSale(v2, { queueRecordId: "q-1", saleRequestId: SALE_A, state: "queued", queuedAt: "t" });
    expect(v2.objectStoreNames.contains(DRAWER_EVENT_STORE)).toBe(false);
    v2.close();

    const upgraded = await openOfflineDb();
    if (!upgraded.ok) throw new Error("unreachable");

    expect(upgraded.value.version).toBe(OFFLINE_DB_VERSION);
    expect(OFFLINE_DB_VERSION).toBe(3);
    expect(upgraded.value.objectStoreNames.contains(DRAWER_EVENT_STORE)).toBe(true);

    const config = await readPinnedConfigRecord(upgraded.value);
    expect(config.ok === true && config.value).toEqual({ marker: "config-from-v2" });

    const queued = await new Promise<number>((resolve) => {
      const request = upgraded.value.transaction(SALE_QUEUE_STORE).objectStore(SALE_QUEUE_STORE).count();
      request.onsuccess = () => resolve(request.result);
    });
    expect(queued).toBe(1);

    upgraded.value.close();
  });

  it("a drawer claim shares no key space with the sale queue", async () => {
    // A queued sale and its drawer event carry the same saleRequestId; the
    // ledger must not collide with, read or alter the queue.
    const opened = await openOfflineDb();
    if (!opened.ok) throw new Error("unreachable");

    await insertQueuedSale(opened.value, { queueRecordId: "q-1", saleRequestId: SALE_A, state: "queued", queuedAt: "t" });
    opened.value.close();

    expect(await claimAutomaticDrawerEvent(SALE_A)).toBe("claimed");
    expect(await claimAutomaticDrawerEvent(SALE_A)).toBe("already_claimed");
  });
});
