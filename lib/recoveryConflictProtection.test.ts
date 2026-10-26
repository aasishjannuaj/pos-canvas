// G-1-CLIENT-1A — an unresolved STRICT-RECOVERY conflict keeps new checkout
// refused, across restart and Retry, until an authoritative success clears it.
//
// The sequence under test (Control Room G-1-CLIENT-1A, item 1):
//   uncertain sale -> transferred to the strict-recovery queue (marker cleared)
//   -> sync answers attribution_conflict -> a new checkout is attempted
//   -> restart on the same storage -> a new checkout is attempted again.
// "A new checkout is permitted" is exactly `recoveryPermitsNewSale` over
// `readRecoveryAuthority` — the reading DeviceApp's fence is built from
// (prepareCheckoutAuthorization / decideSaleDispatch require verified_clear).
//
// Real modules: recoveryAuthority, saleRecoverySession, uncertainSaleSession,
// saleQueueSession, saleQueue, saleSyncEngine, offlineSaleRpc, saleRecoveryRpc,
// deviceOfflineStore. Storage: fake-indexeddb ("restart" = module reload over
// the same storage). SERVER: the simulated model — mocked responses.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServerModel } from "@/test/g1-client-1/serverModel";
import type { ServerModel } from "@/test/g1-client-1/serverModel";
import type { RecoveryRpcCall } from "@/lib/saleRecoveryRpc";
import type { SaleRpcCall } from "@/lib/offlineSaleRpc";
import type { QueuedSale } from "@/lib/saleQueue";

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
const T0 = Date.parse("2026-10-15T13:00:00.000Z");
const ATTEMPTED = "2026-10-15T14:00:00.000Z";
const ITEMS = [{ itemId: "item-1", quantity: 1, modifiers: [] }];

/** Every module freshly imported: the in-process restart boundary. */
async function load() {
  return {
    authority: await import("@/lib/recoveryAuthority"),
    session: await import("@/lib/uncertainSaleSession"),
    recovery: await import("@/lib/saleRecoverySession"),
    queue: await import("@/lib/saleQueueSession"),
    engine: await import("@/lib/saleSyncEngine"),
    rpc: await import("@/lib/offlineSaleRpc"),
    submission: await import("@/lib/saleSubmission"),
    store: await import("@/lib/deviceOfflineStore"),
  };
}

type Loaded = Awaited<ReturnType<typeof load>>;

function wire(answer: { status: number; body: unknown }) {
  return answer.status === 200
    ? { data: answer.body, error: null, status: 200 }
    : { data: null, error: answer.body, status: answer.status };
}

function model(): ServerModel {
  const m = createServerModel({ deviceId: DEVICE, now: () => Date.parse("2026-10-15T15:00:00.000Z") });

  m.openRegister(REGISTER);
  m.signIn(AMY_SESSION, AMY, T0);
  m.signIn(BEN_SESSION, BEN, Date.parse("2026-10-15T14:30:00.000Z"));

  return m;
}

function submitter(m: ServerModel, mods: Loaded) {
  const v5 = vi.fn<SaleRpcCall>(async (args) => wire(m.rpc("complete_sale_v5", args)));
  const recovery = vi.fn<RecoveryRpcCall>(async (name, args) => wire(m.rpc(name, args)));

  return { v5, recovery, submit: (record: QueuedSale) => mods.rpc.submitQueuedSale(record, { rpc: v5, recoveryRpc: recovery }) };
}

/** A legacy v5 call stored this sale under Ben: the conflict source. */
function legacyConflict(m: ServerModel) {
  m.v5({
    p_payment_method: "cash",
    p_tip_amount: 0,
    p_items: ITEMS,
    p_sale_request_id: SALE_ID,
    p_source: "online",
    p_employee_pos_session_id: BEN_SESSION,
    p_register_session_id: REGISTER,
  });
}

/** Arm, transfer to the strict queue (offline), marker cleared. */
async function transferredStrictSale(mods: Loaded) {
  const sale = mods.submission.createUncertainSale({
    saleRequestId: SALE_ID,
    projectId: IDENTITY.projectId,
    paymentMethod: "cash",
    tipAmount: 0,
    items: ITEMS,
    fingerprint: "fp-1",
  });

  expect(
    await mods.session.armUncertainSale({
      sale,
      identity: IDENTITY,
      dispatchedAt: ATTEMPTED,
      originalAttribution: { employeeId: AMY, employeePosSessionId: AMY_SESSION, registerSessionId: REGISTER, attemptedAt: ATTEMPTED },
    })
  ).toBe(true);

  const marker = await mods.session.readOutstandingUncertainRecord(IDENTITY, { saleRequestId: SALE_ID, fingerprint: "fp-1" });
  const outcome = await mods.recovery.recoverOutstandingSale({ marker: marker!, online: false, current: null });

  expect(outcome.kind).toBe("queued");
  expect((await mods.session.readUncertainSale(IDENTITY)).status).toBe("none");
}

async function stored(mods: Loaded): Promise<QueuedSale> {
  const read = await mods.queue.getSaleByRequestId(SALE_ID);

  if (!read.ok) throw new Error(`read failed: ${read.reason}`);

  return read.value;
}

const permitsNewCheckout = async (mods: Loaded) =>
  mods.authority.recoveryPermitsNewSale(await mods.authority.readRecoveryAuthority(IDENTITY));

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
});

describe("G-1-CLIENT-1A: an unresolved strict-recovery conflict keeps checkout refused", () => {
  it("THE SEQUENCE: transfer -> conflict -> new checkout refused -> restart -> new checkout still refused", async () => {
    let mods = await load();
    const m = model();

    await transferredStrictSale(mods);
    // Healthy pending strict record: ordinary operation continues.
    expect(await permitsNewCheckout(mods)).toBe(true);

    legacyConflict(m);
    await mods.engine.createSaleSyncEngine({ submit: submitter(m, mods).submit, now: () => Date.now() }).run();

    const record = await stored(mods);

    expect(record.state).toBe("needs_attention");
    expect(record.lastErrorCode).toBe("attribution_conflict");
    expect(await permitsNewCheckout(mods)).toBe(false);
    expect(await mods.authority.readRecoveryAuthority(IDENTITY)).toEqual({ status: "blocked", reason: "recovery_conflict" });

    // Restart on the same storage.
    vi.resetModules();
    mods = await load();

    expect(await permitsNewCheckout(mods)).toBe(false);
    expect(await mods.authority.readRecoveryAuthority(IDENTITY)).toEqual({ status: "blocked", reason: "recovery_conflict" });
    // The sale itself is untouched: same id, payload and originals.
    const after = await stored(mods);

    expect(after.saleRequestId).toBe(SALE_ID);
    expect(after.items).toEqual(ITEMS);
    expect(after.strictRecovery).toEqual({
      originalEmployeeId: AMY,
      originalEmployeePosSessionId: AMY_SESSION,
      originalRegisterSessionId: REGISTER,
      originalAttemptAt: ATTEMPTED,
    });
    expect(after.occurredAt).toBe(ATTEMPTED);
    expect(m.state.orders).toHaveLength(1);
  });

  it("Retry (back to pending) does NOT erase the protection; neither does a later no-answer failure", async () => {
    const mods = await load();
    const m = model();

    await transferredStrictSale(mods);
    legacyConflict(m);

    const server = submitter(m, mods);

    await mods.engine.createSaleSyncEngine({ submit: server.submit, now: () => Date.now() }).run();

    const record = await stored(mods);

    expect((await mods.queue.startOperatorRetry(record.queueRecordId, new Date().toISOString())).ok).toBe(true);
    expect((await stored(mods)).state).toBe("pending");
    expect((await stored(mods)).lastErrorCode).toBeNull();
    expect(await permitsNewCheckout(mods)).toBe(false);

    // The next attempt never gets an answer: retry/backoff, still protected.
    await mods.engine.createSaleSyncEngine({
      submit: (r) =>
        mods.rpc.submitQueuedSale(r, {
          rpc: server.v5,
          recoveryRpc: async () => ({ data: null, error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" } }),
        }),
      now: () => Date.now(),
      manual: true,
    }).run();

    expect((await stored(mods)).state).toBe("pending");
    expect(await permitsNewCheckout(mods)).toBe(false);
    expect(server.v5).not.toHaveBeenCalled();
  });

  it("AUTHORITATIVE RESOLUTION clears it: a validated strict receipt marks the record synced", async () => {
    const mods = await load();
    const m = model();

    await transferredStrictSale(mods);
    legacyConflict(m);

    const server = submitter(m, mods);

    await mods.engine.createSaleSyncEngine({ submit: server.submit, now: () => Date.now() }).run();
    expect(await permitsNewCheckout(mods)).toBe(false);

    // The server side is corrected (test-only): the conflicting order goes and
    // the strict record is retried, so the server creates it under the originals.
    m.state.orders.length = 0;
    await mods.queue.startOperatorRetry((await stored(mods)).queueRecordId, new Date().toISOString());
    await mods.engine.createSaleSyncEngine({ submit: server.submit, now: () => Date.now(), manual: true }).run();

    expect((await stored(mods)).state).toBe("synced");
    expect(m.state.orders[0]).toMatchObject({ saleRequestId: SALE_ID, employeeId: AMY });
    expect(await permitsNewCheckout(mods)).toBe(true);
    expect(server.v5).not.toHaveBeenCalled();
  });

  it("ordinary pending and needs_attention records do NOT block new checkout", async () => {
    const mods = await load();

    for (let i = 1; i <= 3; i += 1) {
      await mods.queue.enqueueSale({
        saleRequestId: `9e9e0000-0000-4000-8000-00000000000${i}`,
        queueRecordId: `q-${i}`,
        ...IDENTITY,
        paymentMethod: "cash",
        items: ITEMS,
        occurredAt: ATTEMPTED,
        now: ATTEMPTED,
        employeePosSessionId: BEN_SESSION,
        registerSessionId: REGISTER,
      });
    }

    await mods.queue.updateQueueState("q-1", "syncing", ATTEMPTED);
    await mods.queue.updateQueueState("q-1", "needs_attention", ATTEMPTED, { lastErrorCode: "attribution_conflict" });

    expect(await permitsNewCheckout(mods)).toBe(true);
  });

  it("a strict record still retrying after a no-answer failure (no conflict) does NOT block", async () => {
    const mods = await load();

    await transferredStrictSale(mods);
    await mods.engine.createSaleSyncEngine({
      submit: (r) =>
        mods.rpc.submitQueuedSale(r, {
          recoveryRpc: async () => ({ data: null, error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" } }),
        }),
      now: () => Date.now(),
    }).run();

    expect((await stored(mods)).state).toBe("pending");
    expect(await permitsNewCheckout(mods)).toBe(true);
  });

  it("an UNREADABLE strict-recovery record fails safe (refuses), an unreadable ordinary one keeps today's behaviour", async () => {
    const mods = await load();
    const opened = await mods.store.openOfflineDb();

    if (!opened.ok) throw new Error("storage did not open");

    // A strict record whose protection or metadata cannot be read.
    await mods.store.putQueuedSale(opened.value, {
      queueRecordId: "bad-strict",
      saleRequestId: SALE_ID,
      requestPayloadVersion: 5,
      garbage: true,
    } as unknown as QueuedSale);
    opened.value.close();

    expect(await mods.authority.readRecoveryAuthority(IDENTITY)).toEqual({
      status: "blocked",
      reason: "unreadable_recovery_record",
    });
  });

  it("an ordinary unreadable queue row does not block (unchanged policy)", async () => {
    const mods = await load();
    const opened = await mods.store.openOfflineDb();

    if (!opened.ok) throw new Error("storage did not open");

    await mods.store.putQueuedSale(opened.value, {
      queueRecordId: "bad-ordinary",
      saleRequestId: SALE_ID,
      requestPayloadVersion: 4,
      garbage: true,
    } as unknown as QueuedSale);
    opened.value.close();

    expect(await permitsNewCheckout(mods)).toBe(true);
  });

  it("a queue that cannot be read refuses new checkout (fail safe)", async () => {
    const mods = await load();
    const proto = IDBObjectStore.prototype as unknown as Record<string, (...a: unknown[]) => IDBRequest>;
    const original = proto.getAll;

    proto.getAll = function (this: IDBObjectStore, ...args: unknown[]) {
      if (this.name === mods.store.SALE_QUEUE_STORE) throw new DOMException("G-1A injected", "UnknownError");
      return original.apply(this, args);
    };

    try {
      expect(await mods.authority.readRecoveryAuthority(IDENTITY)).toEqual({ status: "blocked", reason: "read_failed" });
    } finally {
      proto.getAll = original;
    }
  });
});
