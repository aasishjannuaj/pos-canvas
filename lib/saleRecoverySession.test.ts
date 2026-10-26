// G-1-CLIENT-1 requirements 4, 5, 6 and 8 — finishing an outstanding sale
// under its original id and attribution, end to end on the client:
//   marker (real IndexedDB) -> lookup -> online strict | strict queue transfer
//   -> marker cleared ONLY after authoritative resolution or verified transfer.
//
// Real modules: saleRecoverySession, saleRecovery, saleRecoveryRpc (the real
// adapters, with an injected transport), uncertainSaleSession, saleQueueSession,
// deviceOfflineStore. Storage: fake-indexeddb. SERVER: the simulated model in
// test/g1-client-1/serverModel.ts — mocked responses. The real database
// answers are exercised separately in the client-contract .db.test.ts.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoverOutstandingSale, transferUncertainSaleToQueue } from "@/lib/saleRecoverySession";
import type { SaleRecoveryDeps } from "@/lib/saleRecoverySession";
import { lookupDeviceSale, submitSaleRecovery } from "@/lib/saleRecoveryRpc";
import type { RecoveryRpcCall } from "@/lib/saleRecoveryRpc";
import { armUncertainSale, readOutstandingUncertainRecord, readUncertainSale } from "@/lib/uncertainSaleSession";
import { UNCERTAIN_SALE_KEY, buildUncertainSaleRecord } from "@/lib/uncertainSaleRecord";
import type { OriginalSaleAttribution, PersistedUncertainSale } from "@/lib/uncertainSaleRecord";
import { createUncertainSale } from "@/lib/saleSubmission";
import { enqueueSale, getSaleByRequestId, listQueuedSales } from "@/lib/saleQueueSession";
import { SALE_QUEUE_STORE, openOfflineDb, writeCacheKey } from "@/lib/deviceOfflineStore";
import { STRICT_RECOVERY_PAYLOAD_VERSION } from "@/lib/saleQueue";
import { RECOVERY_PROTECTED_MESSAGES } from "@/lib/saleRecovery";
import type { CurrentOperator } from "@/lib/saleRecovery";
import { createServerModel } from "@/test/g1-client-1/serverModel";
import type { ServerModel } from "@/test/g1-client-1/serverModel";

const DEVICE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const IDENTITY = {
  deviceAuthUserId: "11111111-1111-4111-8111-111111111111",
  deviceId: DEVICE,
  projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  buildJobId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};
const SALE_ID = "9e9e0000-0000-4000-8000-00000000009e";
const AMY = "e0000000-0000-4000-8000-0000000000a1";
const BEN = "e0000000-0000-4000-8000-0000000000b2";
const AMY_SESSION = "5e550000-0000-4000-8000-0000000000a1";
const BEN_SESSION = "5e550000-0000-4000-8000-0000000000b2";
const REGISTER = "f0000000-0000-4000-8000-0000000000f1";
const NEXT_REGISTER = "f0000000-0000-4000-8000-0000000000f2";
const T0 = Date.parse("2026-10-15T13:00:00.000Z");
const ATTEMPTED = "2026-10-15T14:00:00.000Z";
const ITEMS = [{ itemId: "item-1", quantity: 2, modifiers: [{ groupId: "g1", optionIds: ["o1"] }] }];

const ORIGINAL: OriginalSaleAttribution = {
  employeeId: AMY,
  employeePosSessionId: AMY_SESSION,
  registerSessionId: REGISTER,
  attemptedAt: ATTEMPTED,
};

const AMY_NOW: CurrentOperator = { employeeId: AMY, employeePosSessionId: AMY_SESSION, registerSessionId: REGISTER };
const BEN_NOW: CurrentOperator = { employeeId: BEN, employeePosSessionId: BEN_SESSION, registerSessionId: REGISTER };

function model(): ServerModel {
  const m = createServerModel({ deviceId: DEVICE, now: () => Date.parse("2026-10-15T15:00:00.000Z") });

  m.openRegister(REGISTER);
  m.signIn(AMY_SESSION, AMY, T0);

  return m;
}

function wire(answer: { status: number; body: unknown }) {
  return answer.status === 200
    ? { data: answer.body, error: null, status: 200 }
    : { data: null, error: answer.body, status: answer.status };
}

/** The real adapters, over the model. Every call recorded. */
function deps(m: ServerModel, override?: RecoveryRpcCall): { deps: Partial<SaleRecoveryDeps>; calls: string[] } {
  const calls: string[] = [];
  const rpc: RecoveryRpcCall =
    override ??
    (async (name, args) => {
      calls.push(name);
      return wire(m.rpc(name, args));
    });
  const tracked: RecoveryRpcCall = async (name, args, signal) => {
    if (override) calls.push(name);
    return rpc(name, args, signal);
  };

  return {
    calls,
    deps: {
      lookup: (input) => lookupDeviceSale(input, { rpc: tracked, timeoutMs: 50 }),
      recover: (input) => submitSaleRecovery(input, { rpc: tracked, timeoutMs: 50 }),
      newQueueRecordId: () => "q-recovered-1",
      now: () => "2026-10-15T15:00:00.000Z",
    },
  };
}

async function arm(original: OriginalSaleAttribution | null = ORIGINAL): Promise<PersistedUncertainSale> {
  const sale = createUncertainSale({
    saleRequestId: SALE_ID,
    projectId: IDENTITY.projectId,
    paymentMethod: "card",
    tipAmount: 0,
    items: ITEMS,
    fingerprint: "fp-1",
  });

  if (original === null) {
    // A record written by an older build: no originals key at all.
    const { originalAttribution: _legacy, ...older } = buildUncertainSaleRecord({
      sale,
      identity: IDENTITY,
      dispatchedAt: ATTEMPTED,
    });

    void _legacy;

    const opened = await openOfflineDb();

    if (!opened.ok) throw new Error("storage did not open");

    await writeCacheKey(opened.value, UNCERTAIN_SALE_KEY, older);
    opened.value.close();
  } else if (!(await armUncertainSale({ sale, identity: IDENTITY, dispatchedAt: ATTEMPTED, originalAttribution: original }))) {
    throw new Error("arm failed");
  }

  const record = await readOutstandingUncertainRecord(IDENTITY, { saleRequestId: SALE_ID, fingerprint: "fp-1" });

  if (record === null) throw new Error("marker not readable");

  return record;
}

const markerStatus = async () => (await readUncertainSale(IDENTITY)).status;

/** The lost original request, committed by the server under `session`. */
function commitOriginal(m: ServerModel, session: string, register = REGISTER) {
  return m.v5({
    p_payment_method: "card",
    p_tip_amount: 0,
    p_items: ITEMS,
    p_sale_request_id: SALE_ID,
    p_source: "online",
    p_employee_pos_session_id: session,
    p_register_session_id: register,
  });
}

type Proto = Record<string, (...a: unknown[]) => IDBRequest>;
const restores: (() => void)[] = [];

function abortQueueAddAfterSuccess() {
  const proto = IDBObjectStore.prototype as unknown as Proto;
  const original = proto.add;
  const hits: string[] = [];

  proto.add = function (this: IDBObjectStore, ...args: unknown[]) {
    const request = original.apply(this, args);

    if (this.name === SALE_QUEUE_STORE) {
      const tx = this.transaction;

      hits.push("abort_after_success");
      request.addEventListener("success", () => {
        try {
          tx.abort();
        } catch {
          // already finished
        }
      });
    }

    return request;
  };

  restores.push(() => {
    proto.add = original;
  });

  return hits;
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

// ---------------------------------------------------------------------------

describe("online: the lookup decides, and 'not found' never clears anything", () => {
  it("lost response, same employee and register: lookup finds it (verified) -> recorded, marker cleared, ONE order", async () => {
    const m = model();

    commitOriginal(m, AMY_SESSION);

    const marker = await arm();
    const { deps: d, calls } = deps(m);
    const outcome = await recoverOutstandingSale({ marker, online: true, current: AMY_NOW }, d);

    expect(outcome.kind).toBe("recorded");
    expect(outcome.kind === "recorded" && outcome.order.orderNumber).toBe(m.state.orders[0].orderNumber);
    expect(calls).toEqual(["get_device_sale_by_request_id"]);
    expect(await markerStatus()).toBe("none");
    expect(m.state.orders).toHaveLength(1);
  });

  it("not found, original employee on the original register: online strict CREATES under the originals", async () => {
    const m = model();
    const marker = await arm();
    const { deps: d, calls } = deps(m);
    const outcome = await recoverOutstandingSale({ marker, online: true, current: AMY_NOW }, d);

    expect(outcome.kind).toBe("completed");
    expect(calls).toEqual(["get_device_sale_by_request_id", "complete_sale_recovery_v1"]);
    expect(m.state.orders).toHaveLength(1);
    expect(m.state.orders[0]).toMatchObject({ employeeId: AMY, registerSessionId: REGISTER, saleRequestId: SALE_ID });
    expect(await markerStatus()).toBe("none");
  });

  it("not found, but a DIFFERENT employee is signed in: strict queue transfer under the ORIGINALS", async () => {
    const m = model();
    const marker = await arm();

    m.signIn(BEN_SESSION, BEN);

    const { deps: d, calls } = deps(m);
    const outcome = await recoverOutstandingSale({ marker, online: true, current: BEN_NOW }, d);

    expect(outcome.kind).toBe("queued");
    expect(calls).toEqual(["get_device_sale_by_request_id"]);
    expect(m.state.orders).toHaveLength(0);

    const read = await getSaleByRequestId(SALE_ID);

    expect(read.ok && read.value.requestPayloadVersion).toBe(STRICT_RECOVERY_PAYLOAD_VERSION);
    expect(read.ok && read.value.strictRecovery).toEqual({
      originalEmployeeId: AMY,
      originalEmployeePosSessionId: AMY_SESSION,
      originalRegisterSessionId: REGISTER,
      originalAttemptAt: ATTEMPTED,
    });
    expect(read.ok && read.value.occurredAt).toBe(ATTEMPTED);
    expect(await markerStatus()).toBe("none");
  });

  it("not found after a REGISTER ROLLOVER (same employee, new session, new register): strict queue", async () => {
    const m = model();
    const marker = await arm();

    m.openRegister(NEXT_REGISTER);
    m.signIn("5e550000-0000-4000-8000-0000000000a9", AMY);

    const { deps: d } = deps(m);
    const outcome = await recoverOutstandingSale(
      {
        marker,
        online: true,
        current: { employeeId: AMY, employeePosSessionId: "5e550000-0000-4000-8000-0000000000a9", registerSessionId: NEXT_REGISTER },
      },
      d
    );

    expect(outcome.kind).toBe("queued");
    const read = await getSaleByRequestId(SALE_ID);

    expect(read.ok && read.value.registerSessionId).toBe(REGISTER);
  });

  it("online strict refused because the online context moved -> the SAME sale goes to the strict queue", async () => {
    const m = model();
    const marker = await arm();

    // The client still believes Amy/REGISTER, but the server's register moved.
    m.openRegister(NEXT_REGISTER);

    const { deps: d, calls } = deps(m);
    const outcome = await recoverOutstandingSale({ marker, online: true, current: AMY_NOW }, d);

    expect(calls).toEqual(["get_device_sale_by_request_id", "complete_sale_recovery_v1"]);
    expect(outcome.kind).toBe("queued");
    expect(m.state.orders).toHaveLength(0);
  });

  it("attribution CONFLICT (a legacy v5 call stored Ben) stays protected; nothing is changed", async () => {
    const m = model();
    const marker = await arm();

    m.signIn(BEN_SESSION, BEN);
    commitOriginal(m, BEN_SESSION);

    const { deps: d } = deps(m);
    const outcome = await recoverOutstandingSale({ marker, online: true, current: BEN_NOW }, d);

    expect(outcome).toEqual({
      kind: "protected",
      reason: "attribution_conflict",
      message: RECOVERY_PROTECTED_MESSAGES.attribution_conflict,
      connectionLost: false,
    });
    expect(await markerStatus()).toBe("outstanding");
    expect(m.state.orders).toHaveLength(1);
    expect(m.state.orders[0].employeeId).toBe(BEN);

    // And a second attempt gets the same answer: the conflict is the server's
    // durable state, and the marker (re-read through a fresh connection) stays.
    const again = await recoverOutstandingSale(
      {
        marker: (await readOutstandingUncertainRecord(IDENTITY, { saleRequestId: SALE_ID, fingerprint: "fp-1" }))!,
        online: true,
        current: BEN_NOW,
      },
      d
    );

    expect(again.kind === "protected" && again.reason).toBe("attribution_conflict");
    expect(await markerStatus()).toBe("outstanding");
  });

  it("another till's order / a different sale under this id / an unreadable answer: protected", async () => {
    for (const [arrange, reason] of [
      [
        (m: ServerModel) => {
          commitOriginal(m, AMY_SESSION);
          m.state.orders[0].pairedDeviceId = null;
        },
        "not_this_device",
      ],
      [
        (m: ServerModel) => {
          m.v5({ p_payment_method: "cash", p_tip_amount: 0, p_items: ITEMS, p_sale_request_id: SALE_ID, p_source: "online", p_employee_pos_session_id: AMY_SESSION, p_register_session_id: REGISTER });
        },
        "payload_mismatch",
      ],
      [(m: ServerModel) => m.state.malformed.add("get_device_sale_by_request_id"), "malformed_response"],
    ] as const) {
      globalThis.indexedDB = new IDBFactory();

      const m = model();

      arrange(m);

      const marker = await arm();
      const { deps: d } = deps(m);
      const outcome = await recoverOutstandingSale({ marker, online: true, current: AMY_NOW }, d);

      expect(outcome.kind === "protected" && outcome.reason).toBe(reason);
      expect(await markerStatus()).toBe("outstanding");
    }
  });

  it("MISSING server functions: protected, and complete_sale_v5 is never called", async () => {
    const m = model();

    m.state.missing.add("get_device_sale_by_request_id");
    m.state.missing.add("complete_sale_recovery_v1");

    const marker = await arm();
    const { deps: d, calls } = deps(m);
    const outcome = await recoverOutstandingSale({ marker, online: true, current: AMY_NOW }, d);

    expect(outcome.kind === "protected" && outcome.reason).toBe("recovery_unavailable");
    expect(calls).toEqual(["get_device_sale_by_request_id"]);
    expect(calls).not.toContain("complete_sale_v5");
    expect(m.state.orders).toHaveLength(0);
    expect(await markerStatus()).toBe("outstanding");
  });

  it("online strict function missing after a successful lookup: protected, no v5 fallback", async () => {
    const m = model();

    m.state.missing.add("complete_sale_recovery_v1");

    const marker = await arm();
    const { deps: d, calls } = deps(m);
    const outcome = await recoverOutstandingSale({ marker, online: true, current: AMY_NOW }, d);

    expect(outcome.kind === "protected" && outcome.reason).toBe("recovery_unavailable");
    expect(calls).toEqual(["get_device_sale_by_request_id", "complete_sale_recovery_v1"]);
    expect(await markerStatus()).toBe("outstanding");
  });

  it("lookup lost on the wire: an ATTRIBUTED marker is moved to the strict queue (same id, same originals)", async () => {
    const m = model();
    const marker = await arm();
    const dropped: RecoveryRpcCall = async () => ({
      data: null,
      error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" },
    });
    const { deps: d } = deps(m, dropped);
    const outcome = await recoverOutstandingSale({ marker, online: true, current: AMY_NOW }, d);

    expect(outcome.kind).toBe("queued");
    expect(await markerStatus()).toBe("none");
  });

  it("lookup TIMED OUT (unknown outcome): protected, never a transport claim", async () => {
    const m = model();
    const marker = await arm();
    const hanging: RecoveryRpcCall = (_n, _a, signal) =>
      new Promise((resolve) =>
        signal.addEventListener("abort", () =>
          resolve({ data: null, error: { message: "AbortError", details: "", hint: "", code: "" } })
        )
      );
    const { deps: d } = deps(m, hanging);
    const outcome = await recoverOutstandingSale({ marker, online: true, current: AMY_NOW }, d);

    expect(outcome).toMatchObject({ kind: "protected", reason: "unknown_outcome", connectionLost: false });
    expect(await markerStatus()).toBe("outstanding");
  });

  it("online strict lost on the wire after a 'not found': protected AND flagged as a lost connection", async () => {
    const m = model();
    const marker = await arm();
    let n = 0;
    const secondDrops: RecoveryRpcCall = async (name, args) => {
      n += 1;
      return n === 1
        ? wire(m.rpc(name, args))
        : { data: null, error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" } };
    };
    const { deps: d } = deps(m, secondDrops);
    const outcome = await recoverOutstandingSale({ marker, online: true, current: AMY_NOW }, d);

    expect(outcome).toMatchObject({ kind: "protected", reason: "connection_lost", connectionLost: true });
    expect(await markerStatus()).toBe("outstanding");
  });
});

// ---------------------------------------------------------------------------

describe("requirement 6 — legacy markers", () => {
  it("offline: protected, nothing queued under the current employee", async () => {
    const marker = await arm(null);
    const outcome = await recoverOutstandingSale({ marker, online: false, current: BEN_NOW });

    expect(outcome.kind === "protected" && outcome.reason).toBe("legacy_unresolvable");

    const listing = await listQueuedSales();

    expect(listing.ok && listing.value.sales).toEqual([]);
    expect(await markerStatus()).toBe("outstanding");
  });

  it("online, not found: protected (no claims to complete it under); no creation call", async () => {
    const m = model();
    const marker = await arm(null);
    const { deps: d, calls } = deps(m);
    const outcome = await recoverOutstandingSale({ marker, online: true, current: AMY_NOW }, d);

    expect(outcome.kind === "protected" && outcome.reason).toBe("legacy_unresolvable");
    expect(calls).toEqual(["get_device_sale_by_request_id"]);
    expect(await markerStatus()).toBe("outstanding");
  });

  it("online, EXACT match for this device and payload (attribution 'unverified'): cleared, attribution untouched", async () => {
    const m = model();

    commitOriginal(m, AMY_SESSION);

    const marker = await arm(null);
    const { deps: d, calls } = deps(m);
    const outcome = await recoverOutstandingSale({ marker, online: true, current: BEN_NOW }, d);

    expect(outcome.kind).toBe("recorded");
    expect(calls).toEqual(["get_device_sale_by_request_id"]);
    expect(await markerStatus()).toBe("none");
    // The order still says Amy; nothing this client did changed it.
    expect(m.state.orders[0].employeeId).toBe(AMY);
  });

  it("online, a lost lookup for a legacy marker: protected, flagged as a lost connection, nothing queued", async () => {
    const m = model();
    const marker = await arm(null);
    const dropped: RecoveryRpcCall = async () => ({
      data: null,
      error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" },
    });
    const { deps: d } = deps(m, dropped);
    const outcome = await recoverOutstandingSale({ marker, online: true, current: AMY_NOW }, d);

    expect(outcome).toMatchObject({ kind: "protected", reason: "connection_lost", connectionLost: true });
    expect(await markerStatus()).toBe("outstanding");
  });
});

// ---------------------------------------------------------------------------

describe("requirement 8 — transfer without a loss window", () => {
  it("offline: an attributed marker transfers and is cleared only after the verified read-back", async () => {
    const marker = await arm();
    const outcome = await recoverOutstandingSale({ marker, online: false, current: BEN_NOW });

    expect(outcome.kind).toBe("queued");
    expect(outcome.kind === "queued" && outcome.markerCleared).toBe(true);
    expect(await markerStatus()).toBe("none");
  });

  it("a queue write whose transaction aborts AFTER the request succeeded: protected, marker kept, nothing queued", async () => {
    const marker = await arm();
    const hits = abortQueueAddAfterSuccess();
    const outcome = await recoverOutstandingSale({ marker, online: false, current: BEN_NOW });

    expect(hits).toEqual(["abort_after_success"]);
    expect(outcome.kind === "protected" && outcome.reason).toBe("transfer_failed");
    expect(await markerStatus()).toBe("outstanding");

    const listing = await listQueuedSales();

    expect(listing.ok && listing.value.sales).toEqual([]);
  });

  it("a DIFFERENT record already holding the key: transfer_conflict, both kept", async () => {
    const marker = await arm();

    await enqueueSale({
      saleRequestId: SALE_ID,
      queueRecordId: "older-build-record",
      ...IDENTITY,
      paymentMethod: "card",
      items: ITEMS,
      occurredAt: "2026-10-15T14:05:00.000Z",
      now: "2026-10-15T14:05:00.000Z",
      employeePosSessionId: BEN_SESSION,
      registerSessionId: REGISTER,
    });

    const outcome = await recoverOutstandingSale({ marker, online: false, current: BEN_NOW });

    expect(outcome.kind === "protected" && outcome.reason).toBe("transfer_conflict");
    expect(await markerStatus()).toBe("outstanding");
  });

  it("a second transfer of the same marker (crash before the marker delete) is idempotent", async () => {
    const marker = await arm();
    const first = await transferUncertainSaleToQueue({ marker, queueRecordId: "q-a", now: "2026-10-15T15:00:00.000Z" });
    const second = await transferUncertainSaleToQueue({ marker, queueRecordId: "q-b", now: "2026-10-15T15:01:00.000Z" });

    expect(first.ok && first.record.queueRecordId).toBe("q-a");
    expect(second.ok && second.record.queueRecordId).toBe("q-a");

    const listing = await listQueuedSales();

    expect(listing.ok && listing.value.sales).toHaveLength(1);
  });

  it("the recovery path itself never mints a sale id", async () => {
    const m = model();
    const marker = await arm();
    const { deps: d } = deps(m);
    const spy = vi.fn(d.lookup!);
    const outcome = await recoverOutstandingSale({ marker, online: true, current: AMY_NOW }, { ...d, lookup: spy });

    expect(outcome.kind).toBe("completed");
    expect(spy.mock.calls[0][0].saleRequestId).toBe(SALE_ID);
    expect(m.state.orders[0].saleRequestId).toBe(SALE_ID);
  });
});
