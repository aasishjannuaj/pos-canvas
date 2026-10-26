// G-1-CLIENT-1B — coordination between strict-recovery submission and a new
// checkout's final action. Real modules: recoveryCheckoutCoordinator,
// saleQueueSession, saleQueue, saleSyncEngine, offlineSaleRpc, saleRecoveryRpc,
// deviceOfflineStore. Storage: fake-indexeddb ("restart" = module reload over
// the same storage). SERVER: the simulated model — mocked responses.
//
// "The final action" is modelled exactly as DeviceApp performs it: obtain the
// clearance (durable read), then — synchronously — require
// isRecoveryActivityUnchanged(mark) and only then act. Every interleaving below
// is forced with a deterministic barrier inside the injected submission, never
// with sleeps; every wait is bounded (vi.waitFor's default timeout).
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServerModel } from "@/test/g1-client-1/serverModel";
import type { ServerModel } from "@/test/g1-client-1/serverModel";
import type { RecoveryRpcCall } from "@/lib/saleRecoveryRpc";
import type { QueuedSale, StrictRecoveryClaims } from "@/lib/saleQueue";
import type { OfflineSaleSubmission } from "@/lib/offlineSaleRpc";

const DEVICE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const IDENTITY = {
  deviceAuthUserId: "11111111-1111-4111-8111-111111111111",
  deviceId: DEVICE,
  projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  buildJobId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};
const AMY = "e0000000-0000-4000-8000-0000000000a1";
const BEN = "e0000000-0000-4000-8000-0000000000b2";
const AMY_SESSION = "5e550000-0000-4000-8000-0000000000a1";
const BEN_SESSION = "5e550000-0000-4000-8000-0000000000b2";
const REGISTER = "f0000000-0000-4000-8000-0000000000f1";
const ATTEMPTED = "2026-10-15T14:00:00.000Z";
const STRICT_ID = "9e9e0000-0000-4000-8000-00000000009e";
const ITEMS = [{ itemId: "item-1", quantity: 1, modifiers: [] }];
const STRICT: StrictRecoveryClaims = {
  originalEmployeeId: AMY,
  originalEmployeePosSessionId: AMY_SESSION,
  originalRegisterSessionId: REGISTER,
  originalAttemptAt: ATTEMPTED,
};

async function load() {
  return {
    gate: await import("@/lib/recoveryCheckoutCoordinator"),
    queue: await import("@/lib/saleQueueSession"),
    engine: await import("@/lib/saleSyncEngine"),
    rpc: await import("@/lib/offlineSaleRpc"),
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
  m.signIn(AMY_SESSION, AMY, Date.parse("2026-10-15T13:00:00.000Z"));
  m.signIn(BEN_SESSION, BEN, Date.parse("2026-10-15T14:30:00.000Z"));

  return m;
}

function legacyConflict(m: ServerModel) {
  m.v5({
    p_payment_method: "cash",
    p_tip_amount: 0,
    p_items: ITEMS,
    p_sale_request_id: STRICT_ID,
    p_source: "online",
    p_employee_pos_session_id: BEN_SESSION,
    p_register_session_id: REGISTER,
  });
}

let seq = 0;

async function enqueueOrdinary(mods: Loaded) {
  seq += 1;

  const r = await mods.queue.enqueueSale({
    saleRequestId: `9e9e0000-0000-4000-8000-0000000001${String(seq).padStart(2, "0")}`,
    queueRecordId: `q-ordinary-${seq}`,
    ...IDENTITY,
    paymentMethod: "cash",
    items: ITEMS,
    occurredAt: ATTEMPTED,
    now: `2026-10-15T14:0${seq}:00.000Z`,
    employeePosSessionId: BEN_SESSION,
    registerSessionId: REGISTER,
  });

  if (!r.ok) throw new Error(`enqueue failed: ${r.reason}`);

  return r.value;
}

async function enqueueStrict(mods: Loaded) {
  const r = await mods.queue.enqueueSale({
    saleRequestId: STRICT_ID,
    queueRecordId: "q-strict",
    ...IDENTITY,
    paymentMethod: "cash",
    items: ITEMS,
    occurredAt: ATTEMPTED,
    now: "2026-10-15T14:00:30.000Z",
    strictRecovery: STRICT,
  });

  if (!r.ok) throw new Error(`enqueue failed: ${r.reason}`);

  return r.value;
}

/** The real submission over the model, with an optional barrier in front. */
function submitter(m: ServerModel, mods: Loaded) {
  let hold: Promise<void> | null = null;
  let release: (() => void) | null = null;
  let entered = 0;
  const recovery: RecoveryRpcCall = async (name, args) => wire(m.rpc(name, args));

  return {
    holdNext() {
      hold = new Promise<void>((r) => {
        release = r;
      });
    },
    release() {
      release?.();
      hold = null;
    },
    entered: () => entered,
    submit: async (record: QueuedSale): Promise<OfflineSaleSubmission> => {
      entered += 1;

      if (hold !== null) await hold;

      return mods.rpc.submitQueuedSale(record, {
        rpc: async (args) => wire(m.rpc("complete_sale_v5", args)),
        recoveryRpc: recovery,
      });
    },
  };
}

/** DeviceApp's final gate, verbatim in shape: read, then a synchronous check. */
async function finalGate(mods: Loaded) {
  const clearance = await mods.gate.readCheckoutRecoveryClearance();

  if (!clearance.ok) return { acted: false, reason: clearance.reason };

  return mods.gate.isRecoveryActivityUnchanged(clearance.mark)
    ? { acted: true as const }
    : { acted: false, reason: "recovery_in_progress" as const };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  seq = 0;
});

describe("G-1-CLIENT-1B: committed conflict and strict submissions gate the final action", () => {
  // v1.3.4 owner decision (2026-10-26): a committed conflict is set aside and checkout continues.
  it("a COMMITTED protected conflict is SET ASIDE — checkout continues, also after restart and Retry; the record stays protected", async () => {
    let mods = await load();
    const m = model();

    await enqueueStrict(mods);
    legacyConflict(m);
    await mods.engine.createSaleSyncEngine({ submit: submitter(m, mods).submit, now: () => Date.now() }).run();

    expect(await finalGate(mods)).toEqual({ acted: true });

    vi.resetModules();
    mods = await load();
    expect(mods.gate.isStrictRecoveryInFlight()).toBe(false);
    expect(await finalGate(mods)).toEqual({ acted: true });

    await mods.queue.startOperatorRetry("q-strict", new Date().toISOString());
    expect(await finalGate(mods)).toEqual({ acted: true });
    const listing = await mods.queue.listQueuedSales();
    expect(listing.ok && listing.value.sales.find((s) => s.saleRequestId === STRICT_ID)?.recoveryProtection).toMatchObject({ code: "attribution_conflict" });
  });

  it("a strict submission ACTIVELY IN FLIGHT refuses temporarily; after a clean result the gate opens", async () => {
    const mods = await load();
    const m = model();
    const server = submitter(m, mods);

    await enqueueStrict(mods);
    server.holdNext();

    const run = mods.engine.createSaleSyncEngine({ submit: server.submit, now: () => Date.now() }).run();

    await vi.waitFor(() => expect(server.entered()).toBe(1));
    expect(mods.gate.isStrictRecoveryInFlight()).toBe(true);
    expect(await finalGate(mods)).toEqual({ acted: false, reason: "recovery_in_progress" });

    server.release();
    await run;

    expect(mods.gate.isStrictRecoveryInFlight()).toBe(false);
    expect(await finalGate(mods)).toEqual({ acted: true });
    expect(m.state.orders.find((o) => o.saleRequestId === STRICT_ID)?.employeeId).toBe(AMY);
  });

  it("RECOVERY STARTS BETWEEN the initial check and the final action: the action is refused", async () => {
    const mods = await load();
    const m = model();
    const server = submitter(m, mods);

    await enqueueStrict(mods);

    // Initial check: clear (the strict record is merely pending).
    const clearance = await mods.gate.readCheckoutRecoveryClearance();

    expect(clearance.ok).toBe(true);

    // Recovery starts before the final action.
    server.holdNext();

    const run = mods.engine.createSaleSyncEngine({ submit: server.submit, now: () => Date.now() }).run();

    await vi.waitFor(() => expect(server.entered()).toBe(1));

    expect(clearance.ok && mods.gate.isRecoveryActivityUnchanged(clearance.mark)).toBe(false);

    server.release();
    await run;
  });

  it("a recovery that starts AND files its conflict entirely inside the checkout's read is still caught", async () => {
    const mods = await load();
    const m = model();
    const server = submitter(m, mods);

    await enqueueStrict(mods);
    legacyConflict(m);

    const clearance = await mods.gate.readCheckoutRecoveryClearance();

    expect(clearance.ok).toBe(true);

    await mods.engine.createSaleSyncEngine({ submit: server.submit, now: () => Date.now() }).run();
    expect((await mods.queue.getSaleByRequestId(STRICT_ID)).ok && (await mods.queue.getSaleByRequestId(STRICT_ID) as { value: QueuedSale }).value.recoveryProtection).toBeTruthy();

    // Nothing in flight any more — but the counter moved.
    expect(mods.gate.isStrictRecoveryInFlight()).toBe(false);
    expect(clearance.ok && mods.gate.isRecoveryActivityUnchanged(clearance.mark)).toBe(false);
  });

  it("ORDERING A — checkout acts first, recovery afterwards: both proceed; a later conflict is set aside and LATER checkouts continue", async () => {
    const mods = await load();
    const m = model();

    await enqueueStrict(mods);
    legacyConflict(m);

    // Checkout passes both parts and acts (a new ordinary sale is saved).
    expect(await finalGate(mods)).toEqual({ acted: true });
    await enqueueOrdinary(mods);

    // Recovery runs afterwards and files the conflict.
    await mods.engine.createSaleSyncEngine({ submit: submitter(m, mods).submit, now: () => Date.now() }).run();

    const listing = await mods.queue.listQueuedSales();

    expect(listing.ok && listing.value.sales.find((s) => s.saleRequestId !== STRICT_ID)?.state).toBe("synced");
    expect(listing.ok && listing.value.sales.find((s) => s.saleRequestId === STRICT_ID)?.recoveryProtection).toMatchObject({ code: "attribution_conflict" });
    expect(await finalGate(mods)).toEqual({ acted: true });
  });

  it("ORDERING B — recovery starts first: the checkout is refused, and allowed after a clean recovery", async () => {
    const mods = await load();
    const m = model();
    const server = submitter(m, mods);

    await enqueueStrict(mods);
    server.holdNext();

    const run = mods.engine.createSaleSyncEngine({ submit: server.submit, now: () => Date.now() }).run();

    await vi.waitFor(() => expect(server.entered()).toBe(1));
    expect(await finalGate(mods)).toEqual({ acted: false, reason: "recovery_in_progress" });

    server.release();
    await run;
    expect(await finalGate(mods)).toEqual({ acted: true });
  });
});

describe("G-1-CLIENT-1B: temporary coordination is released on every path", () => {
  it("a transport failure releases it; the healthy strict record WAITING between attempts does not block", async () => {
    const mods = await load();

    await enqueueStrict(mods);
    await mods.engine.createSaleSyncEngine({
      submit: (r) =>
        mods.rpc.submitQueuedSale(r, {
          recoveryRpc: async () => ({ data: null, error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" } }),
        }),
      now: () => Date.now(),
    }).run();

    expect(mods.gate.isStrictRecoveryInFlight()).toBe(false);
    expect((await mods.queue.getSaleByRequestId(STRICT_ID) as { value: QueuedSale }).value.state).toBe("pending");
    expect(await finalGate(mods)).toEqual({ acted: true });
  });

  // A refused claim leaves syncOne through the same finally as a throw; the
  // throw is the one that can be forced deterministically here.
  it("a THROWING submission releases the counter; the record left in `syncing` refuses until startup recovery", async () => {
    let mods = await load();

    await enqueueStrict(mods);

    await expect(
      mods.engine.createSaleSyncEngine({
        submit: async () => {
          throw new Error("G-1B injected throw");
        },
        now: () => Date.now(),
      }).run()
    ).rejects.toThrow("G-1B injected throw");

    expect(mods.gate.isStrictRecoveryInFlight()).toBe(false);
    // Durable state still shows a submission that never finished: refused, safely.
    expect(await finalGate(mods)).toEqual({ acted: false, reason: "recovery_in_progress" });

    // Restart: the counter is fresh (it cannot grant anything), the durable
    // `syncing` still refuses until startup recovery returns it to pending.
    vi.resetModules();
    mods = await load();
    expect(await finalGate(mods)).toEqual({ acted: false, reason: "recovery_in_progress" });
    await mods.queue.recoverInterruptedSyncs(new Date().toISOString());
    expect(await finalGate(mods)).toEqual({ acted: true });
  });

  it("an abandoned (cancelled) checkout holds nothing: recovery proceeds normally afterwards", async () => {
    const mods = await load();
    const m = model();

    await enqueueStrict(mods);

    const clearance = await mods.gate.readCheckoutRecoveryClearance();

    expect(clearance.ok).toBe(true);
    // The checkout is cancelled here: nothing to release.

    const report = await mods.engine.createSaleSyncEngine({ submit: submitter(m, mods).submit, now: () => Date.now() }).run();

    expect(report.synced).toBe(1);
    expect(mods.gate.isStrictRecoveryInFlight()).toBe(false);
  });
});

describe("G-1-CLIENT-1B: ordinary offline operation is unaffected", () => {
  it("ordinary pending, syncing and needs_attention records, and an ordinary sync in flight, never block", async () => {
    const mods = await load();
    const m = model();
    const server = submitter(m, mods);

    const a = await enqueueOrdinary(mods);

    await enqueueOrdinary(mods);
    await mods.queue.updateQueueState(a.queueRecordId, "syncing", ATTEMPTED);
    await mods.queue.updateQueueState(a.queueRecordId, "needs_attention", ATTEMPTED, { lastErrorCode: "attribution_conflict" });

    expect(await finalGate(mods)).toEqual({ acted: true });

    server.holdNext();

    const run = mods.engine.createSaleSyncEngine({ submit: server.submit, now: () => Date.now() }).run();

    await vi.waitFor(() => expect(server.entered()).toBe(1));
    // An ORDINARY submission in flight: no counter, durable shows no strict syncing.
    // Batch B: a clearance is valid only in the synchronous turn after its read
    // (its cross-tab gate is released on the next macrotask), exactly as
    // DeviceApp uses it — so it is read here, while the ordinary sync is in flight.
    const clearance = await mods.gate.readCheckoutRecoveryClearance();

    expect(mods.gate.isStrictRecoveryInFlight()).toBe(false);
    expect(clearance.ok && mods.gate.isRecoveryActivityUnchanged(clearance.mark)).toBe(true);
    expect(await finalGate(mods)).toEqual({ acted: true });

    server.release();
    await run;
  });
});

describe("G-1-CLIENT-1B: storage failures refuse safely", () => {
  it("a queue that cannot be read refuses; an unreadable strict-looking row refuses", async () => {
    const mods = await load();
    const proto = IDBObjectStore.prototype as unknown as Record<string, (...a: unknown[]) => IDBRequest>;
    const original = proto.getAll;

    proto.getAll = function (this: IDBObjectStore, ...args: unknown[]) {
      if (this.name === mods.store.SALE_QUEUE_STORE) throw new DOMException("G-1B injected", "UnknownError");
      return original.apply(this, args);
    };

    try {
      expect(await finalGate(mods)).toEqual({ acted: false, reason: "read_failed" });
    } finally {
      proto.getAll = original;
    }

    const opened = await mods.store.openOfflineDb();

    if (!opened.ok) throw new Error("storage did not open");

    await mods.store.putQueuedSale(opened.value, { queueRecordId: "bad", saleRequestId: STRICT_ID, requestPayloadVersion: 5 } as unknown as QueuedSale);
    opened.value.close();
    expect(await finalGate(mods)).toEqual({ acted: false, reason: "unreadable_recovery_record" });
  });
});
