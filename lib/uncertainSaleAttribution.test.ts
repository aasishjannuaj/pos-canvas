// G-1-CLIENT-1 requirement 1 and 6 — the ORIGINAL attribution is captured on
// the durable marker before dispatch, survives re-arms and restarts unchanged,
// and a legacy marker is never upgraded with whoever is signed in now.
//
// Real modules: uncertainSaleSession, uncertainSaleRecord, deviceOfflineStore.
// Storage: fake-indexeddb. "Restart" here is a brand-new connection with no
// in-memory state carried over; the REAL browser-process restart is exercised
// in test/g1-client-1/restart/run-restart.ts.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  armUncertainSale,
  readOutstandingUncertainRecord,
  readUncertainSale,
} from "@/lib/uncertainSaleSession";
import {
  UNCERTAIN_SALE_KEY,
  buildUncertainSaleRecord,
  readUncertainSaleRecord,
} from "@/lib/uncertainSaleRecord";
import { createUncertainSale } from "@/lib/saleSubmission";
import type { UncertainSale } from "@/lib/saleSubmission";
import { CACHE_STORE, openOfflineDb, readCacheKey, writeCacheKey } from "@/lib/deviceOfflineStore";

const IDENTITY = {
  deviceAuthUserId: "11111111-1111-4111-8111-111111111111",
  deviceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  buildJobId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};
const SALE_ID = "9e9e0000-0000-4000-8000-00000000009e";
const OTHER_SALE = "9e9e0000-0000-4000-8000-0000000000ff";

const AMY = {
  employeeId: "e0000000-0000-4000-8000-0000000000a1",
  employeePosSessionId: "5e550000-0000-4000-8000-0000000000a1",
  registerSessionId: "f0000000-0000-4000-8000-0000000000f1",
  attemptedAt: "2026-10-14T15:00:00.000Z",
};
const BEN = {
  employeeId: "e0000000-0000-4000-8000-0000000000b2",
  employeePosSessionId: "5e550000-0000-4000-8000-0000000000b2",
  registerSessionId: "f0000000-0000-4000-8000-0000000000f2",
  attemptedAt: "2026-10-15T09:00:00.000Z",
};

function sale(id = SALE_ID, fingerprint = "fp-1"): UncertainSale {
  return createUncertainSale({
    saleRequestId: id,
    projectId: IDENTITY.projectId,
    paymentMethod: "cash",
    tipAmount: 0,
    items: [{ itemId: "item-1", quantity: 2, modifiers: [] }],
    fingerprint,
  });
}

type Proto = Record<string, (...a: unknown[]) => IDBRequest>;
const restores: (() => void)[] = [];

function onCachePut(how: "throw" | "abort_after_success") {
  const proto = IDBObjectStore.prototype as unknown as Proto;
  const original = proto.put;
  const hits: string[] = [];

  proto.put = function (this: IDBObjectStore, ...args: unknown[]) {
    if (this.name === CACHE_STORE && args[1] === UNCERTAIN_SALE_KEY) {
      if (how === "throw") {
        hits.push("throw");
        throw new DOMException("G-1 injected synchronous failure", "UnknownError");
      }

      const request = original.apply(this, args);
      const tx = this.transaction;

      hits.push("abort_after_success");
      request.addEventListener("success", () => {
        try {
          tx.abort();
        } catch {
          // already finished
        }
      });

      return request;
    }

    return original.apply(this, args);
  };

  restores.push(() => {
    proto.put = original;
  });

  return hits;
}

async function rawMarker(): Promise<unknown> {
  const opened = await openOfflineDb();

  if (!opened.ok) throw new Error("storage did not open");

  try {
    const read = await readCacheKey(opened.value, UNCERTAIN_SALE_KEY);

    if (!read.ok) throw new Error("read failed");

    return read.value;
  } finally {
    opened.value.close();
  }
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

describe("requirement 1 — originals captured before dispatch", () => {
  it("a first arm stores the original employee, session, register and attempt time", async () => {
    expect(
      await armUncertainSale({ sale: sale(), identity: IDENTITY, dispatchedAt: AMY.attemptedAt, originalAttribution: AMY })
    ).toBe(true);

    // A fresh read with nothing in memory: the restart boundary.
    const record = await readOutstandingUncertainRecord(IDENTITY, { saleRequestId: SALE_ID, fingerprint: "fp-1" });

    expect(record?.originalAttribution).toEqual(AMY);
    expect(record?.saleRequestId).toBe(SALE_ID);
  });

  it("a re-arm of the SAME sale after an employee change and register rollover keeps the originals", async () => {
    await armUncertainSale({ sale: sale(), identity: IDENTITY, dispatchedAt: AMY.attemptedAt, originalAttribution: AMY });

    // Ben is now signed in on today's register, and the same sale is re-armed.
    expect(
      await armUncertainSale({
        sale: sale(),
        identity: IDENTITY,
        dispatchedAt: BEN.attemptedAt,
        originalAttribution: BEN,
      })
    ).toBe(true);

    const parsed = readUncertainSaleRecord(await rawMarker());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.record.originalAttribution).toEqual(AMY);
    // Only the dispatch time moved.
    expect(parsed.record.dispatchedAt).toBe(BEN.attemptedAt);
    expect(parsed.record.saleRequestId).toBe(SALE_ID);
  });

  it("an arm for a DIFFERENT sale is refused and the stored evidence is untouched", async () => {
    await armUncertainSale({ sale: sale(), identity: IDENTITY, dispatchedAt: AMY.attemptedAt, originalAttribution: AMY });

    const before = await rawMarker();

    expect(
      await armUncertainSale({ sale: sale(OTHER_SALE, "fp-2"), identity: IDENTITY, dispatchedAt: BEN.attemptedAt, originalAttribution: BEN })
    ).toBe(false);
    // Same id, changed payload: also a different sale.
    expect(
      await armUncertainSale({ sale: sale(SALE_ID, "fp-2"), identity: IDENTITY, dispatchedAt: BEN.attemptedAt, originalAttribution: BEN })
    ).toBe(false);

    expect(await rawMarker()).toEqual(before);
  });

  it("an arm over an UNREADABLE record is refused, and the record is left as found", async () => {
    const opened = await openOfflineDb();

    if (!opened.ok) throw new Error("storage did not open");

    await writeCacheKey(opened.value, UNCERTAIN_SALE_KEY, { schemaVersion: 1, garbage: true });
    opened.value.close();

    expect(
      await armUncertainSale({ sale: sale(), identity: IDENTITY, dispatchedAt: AMY.attemptedAt, originalAttribution: AMY })
    ).toBe(false);
    expect(await rawMarker()).toEqual({ schemaVersion: 1, garbage: true });
  });

  it("a write that throws refuses the arm and writes nothing (the caller then refuses to dispatch)", async () => {
    const hits = onCachePut("throw");

    expect(
      await armUncertainSale({ sale: sale(), identity: IDENTITY, dispatchedAt: AMY.attemptedAt, originalAttribution: AMY })
    ).toBe(false);
    expect(hits).toEqual(["throw"]);
    expect(await rawMarker()).toBeNull();
  });

  it("a write whose transaction aborts AFTER the request succeeded is a refusal, not a durable arm", async () => {
    const hits = onCachePut("abort_after_success");

    expect(
      await armUncertainSale({ sale: sale(), identity: IDENTITY, dispatchedAt: AMY.attemptedAt, originalAttribution: AMY })
    ).toBe(false);
    expect(hits).toEqual(["abort_after_success"]);
    expect(await rawMarker()).toBeNull();
  });

  it("a failed RE-arm leaves the original record intact", async () => {
    await armUncertainSale({ sale: sale(), identity: IDENTITY, dispatchedAt: AMY.attemptedAt, originalAttribution: AMY });

    const before = await rawMarker();

    onCachePut("abort_after_success");

    expect(
      await armUncertainSale({ sale: sale(), identity: IDENTITY, dispatchedAt: BEN.attemptedAt, originalAttribution: BEN })
    ).toBe(false);
    expect(await rawMarker()).toEqual(before);
  });
});

describe("requirement 6 — legacy markers are never upgraded", () => {
  it("a record written before originals existed reads back as LEGACY (null), not malformed", async () => {
    const legacy = buildUncertainSaleRecord({ sale: sale(), identity: IDENTITY, dispatchedAt: AMY.attemptedAt });
    // An older build's bytes: no originalAttribution key at all.
    const { originalAttribution, ...olderBuild } = legacy;

    expect(originalAttribution).toBeNull();
    expect(readUncertainSaleRecord(olderBuild)).toEqual({ ok: true, record: { ...olderBuild, originalAttribution: null } });
  });

  it("re-arming a legacy record with the CURRENT employee does not fill its attribution in", async () => {
    const opened = await openOfflineDb();

    if (!opened.ok) throw new Error("storage did not open");

    const { originalAttribution: _absent, ...olderBuild } = buildUncertainSaleRecord({
      sale: sale(),
      identity: IDENTITY,
      dispatchedAt: AMY.attemptedAt,
    });

    void _absent;
    await writeCacheKey(opened.value, UNCERTAIN_SALE_KEY, olderBuild);
    opened.value.close();

    expect(
      await armUncertainSale({ sale: sale(), identity: IDENTITY, dispatchedAt: BEN.attemptedAt, originalAttribution: BEN })
    ).toBe(true);

    const parsed = readUncertainSaleRecord(await rawMarker());

    expect(parsed.ok && parsed.record.originalAttribution).toBeNull();
  });

  it("a half-written attribution is MALFORMED (blocks), never treated as legacy", async () => {
    const record = buildUncertainSaleRecord({
      sale: sale(),
      identity: IDENTITY,
      dispatchedAt: AMY.attemptedAt,
      originalAttribution: AMY,
    });

    for (const broken of [
      { ...AMY, employeePosSessionId: undefined },
      { ...AMY, registerSessionId: "" },
      { ...AMY, attemptedAt: "yesterday" },
      { ...AMY, employeeId: 42 },
      "amy",
    ]) {
      expect(readUncertainSaleRecord({ ...record, originalAttribution: broken })).toEqual({
        ok: false,
        reason: "malformed",
      });
    }

    const opened = await openOfflineDb();

    if (!opened.ok) throw new Error("storage did not open");

    await writeCacheKey(opened.value, UNCERTAIN_SALE_KEY, { ...record, originalAttribution: { employeeId: AMY.employeeId } });
    opened.value.close();

    expect(await readUncertainSale(IDENTITY)).toEqual({ status: "unusable", reason: "unreadable" });
  });

  it("the outstanding-record read names exactly one sale and nothing else", async () => {
    await armUncertainSale({ sale: sale(), identity: IDENTITY, dispatchedAt: AMY.attemptedAt, originalAttribution: AMY });

    expect(await readOutstandingUncertainRecord(IDENTITY, { saleRequestId: OTHER_SALE, fingerprint: "fp-1" })).toBeNull();
    expect(await readOutstandingUncertainRecord(IDENTITY, { saleRequestId: SALE_ID, fingerprint: "fp-2" })).toBeNull();
    expect(
      await readOutstandingUncertainRecord(
        { ...IDENTITY, buildJobId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc0" },
        { saleRequestId: SALE_ID, fingerprint: "fp-1" }
      )
    ).toBeNull();
  });
});
