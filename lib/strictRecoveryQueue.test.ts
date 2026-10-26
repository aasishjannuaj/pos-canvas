// G-1-CLIENT-1 requirements 7 and 9 — a strict-recovery queue record keeps its
// strict requirement, original claims and original attempt time through
// parsing, restart, retry and synchronisation; it is submitted ONLY through
// complete_sale_recovery_v1; and it syncs through the EXISTING sequential
// engine, one sale at a time, becoming `synced` only on a valid server result.
//
// Real modules: saleQueueSession, saleQueue, saleSyncEngine, offlineSaleRpc,
// saleRecoveryRpc, saleSyncClassifier, deviceOfflineStore. Storage:
// fake-indexeddb. The SERVER is the simulated model in
// test/g1-client-1/serverModel.ts — mocked responses, labelled as such. The
// real database contract is exercised in
// supabase/migrations/20261015120000_sale_recovery_client_contract.db.test.ts.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLockManagerForTests } from "@/lib/tabLocks";
import { createLockRegistry } from "@/test/locks/processLocks";
import {
  enqueueSale,
  getSaleByRequestId,
  listQueuedSales,
  markAttempt,
  recoverInterruptedSyncs,
  startOperatorRetry,
  updateQueueState,
} from "@/lib/saleQueueSession";
import type { EnqueueSaleInput } from "@/lib/saleQueueSession";
import {
  SALE_REQUEST_PAYLOAD_VERSION,
  STRICT_RECOVERY_PAYLOAD_VERSION,
  isStrictRecoverySale,
  readQueuedSale,
} from "@/lib/saleQueue";
import type { QueuedSale, StrictRecoveryClaims } from "@/lib/saleQueue";
import { openOfflineDb, putQueuedSale } from "@/lib/deviceOfflineStore";
import { submitQueuedSale } from "@/lib/offlineSaleRpc";
import type { SaleRpcCall } from "@/lib/offlineSaleRpc";
import type { RecoveryRpcCall } from "@/lib/saleRecoveryRpc";
import {
  createSaleSyncEngine,
  resetStartupSyncForTests,
  resetSyncEngineForTests,
  triggerSaleSync,
} from "@/lib/saleSyncEngine";
import { createServerModel } from "@/test/g1-client-1/serverModel";
import type { ServerModel } from "@/test/g1-client-1/serverModel";

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
const YESTERDAY_REGISTER = "f0000000-0000-4000-8000-0000000000f1";
const TODAY_REGISTER = "f0000000-0000-4000-8000-0000000000f2";
const YESTERDAY_10 = Date.parse("2026-10-14T14:00:00.000Z");
const ATTEMPTED = "2026-10-14T15:00:00.000Z";
const YESTERDAY_18 = Date.parse("2026-10-14T22:00:00.000Z");
const TODAY_09 = Date.parse("2026-10-15T13:00:00.000Z");

const STRICT: StrictRecoveryClaims = {
  originalEmployeeId: AMY,
  originalEmployeePosSessionId: AMY_SESSION,
  originalRegisterSessionId: YESTERDAY_REGISTER,
  originalAttemptAt: ATTEMPTED,
};

let seq = 0;

function saleId(n: number): string {
  return `9e9e0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function input(overrides: Partial<EnqueueSaleInput> = {}): EnqueueSaleInput {
  seq += 1;

  return {
    saleRequestId: saleId(seq),
    queueRecordId: `q-${String(seq).padStart(3, "0")}`,
    ...IDENTITY,
    paymentMethod: "cash",
    items: [{ itemId: `item-${seq}`, quantity: 1, modifiers: [] }],
    occurredAt: "2026-10-15T13:30:00.000Z",
    now: `2026-10-15T13:30:${String(seq).padStart(2, "0")}.000Z`,
    employeePosSessionId: BEN_SESSION,
    registerSessionId: TODAY_REGISTER,
    ...overrides,
  };
}

/** Yesterday Amy rang on yesterday's register; today Ben is on today's. */
function model(): ServerModel {
  const m = createServerModel({ deviceId: DEVICE, now: () => TODAY_09 });

  m.openRegister(YESTERDAY_REGISTER);
  m.signIn(AMY_SESSION, AMY, YESTERDAY_10);
  m.signOut(YESTERDAY_18);
  m.openRegister(TODAY_REGISTER);
  m.signIn(BEN_SESSION, BEN, TODAY_09);

  return m;
}

/** PostgREST's { data, error, status } from a model answer. */
function wire(answer: { status: number; body: unknown }) {
  return answer.status === 200
    ? { data: answer.body, error: null, status: 200 }
    : { data: null, error: answer.body, status: answer.status };
}

function rpcs(m: ServerModel) {
  const v5 = vi.fn<SaleRpcCall>(async (args) => wire(m.rpc("complete_sale_v5", args)));
  const recovery = vi.fn<RecoveryRpcCall>(async (name, args) => wire(m.rpc(name, args)));

  return {
    v5,
    recovery,
    submit: (record: QueuedSale) => submitQueuedSale(record, { rpc: v5, recoveryRpc: recovery }),
  };
}

async function rawPut(record: unknown) {
  const opened = await openOfflineDb();

  if (!opened.ok) throw new Error("storage did not open");

  try {
    await putQueuedSale(opened.value, record as QueuedSale);
  } finally {
    opened.value.close();
  }
}

async function stored(id: string): Promise<QueuedSale> {
  const read = await getSaleByRequestId(id);

  if (!read.ok) throw new Error(`read failed: ${read.reason}`);

  return read.value;
}

beforeEach(() => {
  seq = 0;
  globalThis.indexedDB = new IDBFactory();
  resetSyncEngineForTests();
  resetStartupSyncForTests();
});

// ---------------------------------------------------------------------------

describe("requirement 7 — the strict requirement survives every reader", () => {
  it("a strict enqueue writes payload v5, the originals as its claims, and the original attempt time", async () => {
    const enqueued = await enqueueSale(input({ strictRecovery: STRICT, occurredAt: "2099-01-01T00:00:00.000Z" }));

    expect(enqueued.ok).toBe(true);
    if (!enqueued.ok) return;

    expect(enqueued.value.requestPayloadVersion).toBe(STRICT_RECOVERY_PAYLOAD_VERSION);
    expect(enqueued.value.strictRecovery).toEqual(STRICT);
    // The caller's own time and claims are NOT used for a strict record.
    expect(enqueued.value.occurredAt).toBe(ATTEMPTED);
    expect(enqueued.value.employeePosSessionId).toBe(AMY_SESSION);
    expect(enqueued.value.registerSessionId).toBe(YESTERDAY_REGISTER);
    expect(isStrictRecoverySale(enqueued.value)).toBe(true);
  });

  it("reads back identically through a fresh connection (restart boundary)", async () => {
    const enqueued = await enqueueSale(input({ strictRecovery: STRICT }));

    if (!enqueued.ok) throw new Error("seed");

    expect(await stored(enqueued.value.saleRequestId)).toEqual(enqueued.value);
  });

  it("an ordinary record reads back exactly as before, with no strict key at all", async () => {
    const enqueued = await enqueueSale(input());

    if (!enqueued.ok) throw new Error("seed");

    const read = await stored(enqueued.value.saleRequestId);

    expect(read.requestPayloadVersion).toBe(SALE_REQUEST_PAYLOAD_VERSION);
    expect("strictRecovery" in read).toBe(false);
  });

  it("attempt, retry backoff, attention, operator retry and startup recovery all keep it", async () => {
    const enqueued = await enqueueSale(input({ strictRecovery: STRICT }));

    if (!enqueued.ok) throw new Error("seed");

    const { queueRecordId, saleRequestId } = enqueued.value;

    await updateQueueState(queueRecordId, "syncing", "2026-10-15T13:31:00.000Z");
    await markAttempt(queueRecordId, "2026-10-15T13:31:00.000Z");
    await updateQueueState(queueRecordId, "pending", "2026-10-15T13:31:05.000Z", {
      lastErrorCode: "transport",
      nextAttemptAt: "2026-10-15T13:31:10.000Z",
    });
    await updateQueueState(queueRecordId, "syncing", "2026-10-15T13:32:00.000Z");
    await recoverInterruptedSyncs("2026-10-15T13:33:00.000Z");
    await updateQueueState(queueRecordId, "syncing", "2026-10-15T13:34:00.000Z");
    await updateQueueState(queueRecordId, "needs_attention", "2026-10-15T13:34:05.000Z", {
      lastErrorCode: "attribution_conflict",
    });
    await startOperatorRetry(queueRecordId, "2026-10-15T13:35:00.000Z");

    const after = await stored(saleRequestId);

    expect(after.state).toBe("pending");
    expect(after.requestPayloadVersion).toBe(STRICT_RECOVERY_PAYLOAD_VERSION);
    expect(after.strictRecovery).toEqual(STRICT);
    expect(after.occurredAt).toBe(ATTEMPTED);
    expect(after.employeePosSessionId).toBe(AMY_SESSION);
    expect(after.registerSessionId).toBe(YESTERDAY_REGISTER);
    expect(after.saleRequestId).toBe(saleRequestId);
  });

  it("missing or damaged strict metadata is QUARANTINED — never read as an ordinary sale", async () => {
    const good = await enqueueSale(input({ strictRecovery: STRICT }));

    if (!good.ok) throw new Error("seed");

    const base = good.value;
    const damaged: Record<string, unknown>[] = [
      // Strict version, metadata gone.
      { ...base, queueRecordId: "bad-1", saleRequestId: saleId(901), strictRecovery: undefined },
      { ...base, queueRecordId: "bad-2", saleRequestId: saleId(902), strictRecovery: null },
      // Strict metadata with a bad time / missing claim.
      { ...base, queueRecordId: "bad-3", saleRequestId: saleId(903), strictRecovery: { ...STRICT, originalAttemptAt: "soon" } },
      { ...base, queueRecordId: "bad-4", saleRequestId: saleId(904), strictRecovery: { ...STRICT, originalRegisterSessionId: "" } },
      // Ordinary version CARRYING strict metadata.
      { ...base, queueRecordId: "bad-5", saleRequestId: saleId(905), requestPayloadVersion: SALE_REQUEST_PAYLOAD_VERSION },
      // Claims or time diverging from the originals.
      { ...base, queueRecordId: "bad-6", saleRequestId: saleId(906), employeePosSessionId: BEN_SESSION },
      { ...base, queueRecordId: "bad-7", saleRequestId: saleId(907), registerSessionId: TODAY_REGISTER },
      { ...base, queueRecordId: "bad-8", saleRequestId: saleId(908), occurredAt: "2026-10-15T13:30:00.000Z" },
    ];

    for (const record of damaged) {
      expect(readQueuedSale(record)).toEqual({ ok: false, reason: "malformed" });
      await rawPut(record);
    }

    const listing = await listQueuedSales();

    expect(listing.ok).toBe(true);
    if (!listing.ok) return;

    expect(listing.value.sales.map((s) => s.queueRecordId)).toEqual([base.queueRecordId]);
    expect(listing.value.quarantined.map((q) => q.queueRecordId).sort()).toEqual(
      damaged.map((d) => d.queueRecordId).sort()
    );

    // And the engine never submits a quarantined record, to either function.
    const m = model();
    const server = rpcs(m);

    await createSaleSyncEngine({ submit: server.submit, now: () => TODAY_09 }).run();

    const submittedIds = [...server.recovery.mock.calls.map((c) => c[1].p_sale_request_id), ...server.v5.mock.calls.map((c) => c[0].p_sale_request_id)];

    expect(submittedIds).toEqual([base.saleRequestId]);
  });

  it("even a record that slipped past the reader is never sent to complete_sale_v5", async () => {
    const m = model();
    const server = rpcs(m);
    const enqueued = await enqueueSale(input({ strictRecovery: STRICT }));

    if (!enqueued.ok) throw new Error("seed");

    const broken = { ...enqueued.value, strictRecovery: null } as QueuedSale;
    const result = await server.submit(broken);

    expect(result.ok).toBe(false);
    expect(server.v5).not.toHaveBeenCalled();
    expect(server.recovery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("strict records submit ONLY through complete_sale_recovery_v1", () => {
  it("sends source offline_queued with the ORIGINAL claims and attempt time; v5 is never called", async () => {
    const m = model();
    const server = rpcs(m);
    const enqueued = await enqueueSale(input({ strictRecovery: STRICT }));

    if (!enqueued.ok) throw new Error("seed");

    const result = await server.submit(enqueued.value);

    expect(result.ok).toBe(true);
    expect(server.v5).not.toHaveBeenCalled();
    expect(server.recovery).toHaveBeenCalledTimes(1);

    const [name, args] = server.recovery.mock.calls[0];

    expect(name).toBe("complete_sale_recovery_v1");
    expect(args).toMatchObject({
      p_sale_request_id: enqueued.value.saleRequestId,
      p_source: "offline_queued",
      p_original_employee_pos_session_id: AMY_SESSION,
      p_original_register_session_id: YESTERDAY_REGISTER,
      p_original_attempt_at: ATTEMPTED,
      p_current_employee_pos_session_id: null,
    });
    // Identifiers only: no price anywhere in the request.
    expect(JSON.stringify(args)).not.toMatch(/price|total|subtotal/i);

    // Server side: Amy, yesterday's register, the original time. Not Ben, not NULL.
    expect(m.state.orders).toHaveLength(1);
    expect(m.state.orders[0]).toMatchObject({
      employeeId: AMY,
      registerSessionId: YESTERDAY_REGISTER,
      occurredAt: ATTEMPTED,
      source: "offline_queued",
    });
  });

  it("an ordinary record still goes to complete_sale_v5 and never to recovery", async () => {
    const m = model();
    const server = rpcs(m);
    const enqueued = await enqueueSale(input());

    if (!enqueued.ok) throw new Error("seed");

    expect((await server.submit(enqueued.value)).ok).toBe(true);
    expect(server.v5).toHaveBeenCalledTimes(1);
    expect(server.recovery).not.toHaveBeenCalled();
  });
});

describe("each server outcome lands where it must, and only a valid result syncs", () => {
  async function syncOneStrict(
    arrange: (m: ServerModel) => void,
    recoveryOverride?: RecoveryRpcCall
  ) {
    const m = model();

    arrange(m);

    const server = rpcs(m);
    const enqueued = await enqueueSale(input({ strictRecovery: STRICT }));

    if (!enqueued.ok) throw new Error("seed");

    const report = await createSaleSyncEngine({
      submit: (record) =>
        submitQueuedSale(record, { rpc: server.v5, recoveryRpc: recoveryOverride ?? server.recovery, timeoutMs: 50 }),
      now: () => TODAY_09,
    }).run();

    return { m, server, report, record: await stored(enqueued.value.saleRequestId) };
  }

  it("created -> synced, with the server's own order number", async () => {
    const { record, m } = await syncOneStrict(() => undefined);

    expect(record.state).toBe("synced");
    expect(record.serverOrderNumber).toBe(m.state.orders[0].orderNumber);
  });

  it("replayed (the original request DID commit, under the originals) -> synced, still one order", async () => {
    const { record, m } = await syncOneStrict((m) => {
      // The lost original: committed offline-style under Amy and yesterday.
      m.v5({
        p_payment_method: "cash",
        p_tip_amount: 0,
        p_items: [{ itemId: "item-1", quantity: 1, modifiers: [] }],
        p_sale_request_id: saleId(1),
        p_source: "offline_queued",
        p_occurred_at: ATTEMPTED,
        p_employee_pos_session_id: AMY_SESSION,
        p_register_session_id: YESTERDAY_REGISTER,
      });
    });

    expect(record.state).toBe("synced");
    expect(m.state.orders).toHaveLength(1);
  });

  it("attribution conflict (a legacy v5 call stored Ben) -> needs_attention, nothing changed", async () => {
    const { record, m, server } = await syncOneStrict((m) => {
      m.v5({
        p_payment_method: "cash",
        p_tip_amount: 0,
        p_items: [{ itemId: "item-1", quantity: 1, modifiers: [] }],
        p_sale_request_id: saleId(1),
        p_source: "online",
        p_employee_pos_session_id: BEN_SESSION,
        p_register_session_id: TODAY_REGISTER,
      });
    });

    expect(record.state).toBe("needs_attention");
    expect(record.lastErrorCode).toBe("attribution_conflict");
    expect(m.state.orders).toHaveLength(1);
    expect(m.state.orders[0].employeeId).toBe(BEN);
    expect(server.v5).not.toHaveBeenCalled();
  });

  it("another till's order under this id -> needs_attention not_this_device", async () => {
    const { record } = await syncOneStrict((m) => {
      m.state.orders.push({
        orderId: "0d000000-0000-4000-8000-000000000999",
        orderNumber: "999",
        saleRequestId: saleId(1),
        contentHash: "x",
        source: "online",
        paymentMethod: "cash",
        employeeId: null,
        employeePosSessionId: null,
        registerSessionId: null,
        pairedDeviceId: null,
        occurredAt: null,
        createdAt: new Date(TODAY_09).toISOString(),
      });
    });

    expect(record.state).toBe("needs_attention");
    expect(record.lastErrorCode).toBe("not_this_device");
  });

  it("missing function -> needs_attention recovery_unavailable, and NO v5 fallback", async () => {
    const { record, server, m } = await syncOneStrict((m) => m.state.missing.add("complete_sale_recovery_v1"));

    expect(record.state).toBe("needs_attention");
    expect(record.lastErrorCode).toBe("recovery_unavailable");
    expect(server.v5).not.toHaveBeenCalled();
    expect(m.state.orders).toHaveLength(0);
  });

  it("unreadable answer -> needs_attention, never synced", async () => {
    const { record } = await syncOneStrict((m) => m.state.malformed.add("complete_sale_recovery_v1"));

    expect(record.state).toBe("needs_attention");
    expect(record.lastErrorCode).toBe("unrecognised_server_error");
    expect(record.serverOrderId).toBeNull();
  });

  it("unprovable original claims (attempt after the session ended) -> refused, NO order, never NULL", async () => {
    const m = model();
    const server = rpcs(m);
    const enqueued = await enqueueSale(
      input({ strictRecovery: { ...STRICT, originalAttemptAt: "2026-10-14T23:30:00.000Z" } })
    );

    if (!enqueued.ok) throw new Error("seed");

    await createSaleSyncEngine({ submit: server.submit, now: () => TODAY_09 }).run();

    const record = await stored(enqueued.value.saleRequestId);

    expect(record.state).toBe("needs_attention");
    expect(record.lastErrorCode).toBe("recovery_attribution_unproven");
    expect(m.state.orders).toHaveLength(0);
  });

  it("a transport failure retries under the SAME id with backoff", async () => {
    const failing: RecoveryRpcCall = async () => ({
      data: null,
      error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" },
    });
    const { record } = await syncOneStrict(() => undefined, failing);

    expect(record.state).toBe("pending");
    expect(record.lastErrorCode).toBe("transport");
    expect(record.nextAttemptAt).not.toBeNull();
    expect(record.attemptCount).toBe(1);
  });

  it("our own timeout is an UNKNOWN outcome and retries; it is never a transport claim", async () => {
    const hanging: RecoveryRpcCall = (_name, _args, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () =>
          resolve({ data: null, error: { message: "AbortError: signal is aborted", details: "", hint: "", code: "" } })
        );
      });
    const { record } = await syncOneStrict(() => undefined, hanging);

    expect(record.state).toBe("pending");
    expect(record.lastErrorCode).toBe("sale_timeout");
  });
});

// ---------------------------------------------------------------------------

describe("requirement 9 — the existing sequential engine, one sale at a time", () => {
  it("drains a mixed backlog one request per sale, never concurrently, with no duplicates", async () => {
    const m = model();
    const server = rpcs(m);
    let inFlight = 0;
    let maxInFlight = 0;

    for (let i = 0; i < 3; i += 1) await enqueueSale(input());
    for (let i = 0; i < 2; i += 1) {
      await enqueueSale(input({ strictRecovery: STRICT }));
    }

    const submit = async (record: QueuedSale) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));

      try {
        return await server.submit(record);
      } finally {
        inFlight -= 1;
      }
    };

    const report = await createSaleSyncEngine({ submit, now: () => TODAY_09 }).run();

    expect(report.attempted).toBe(5);
    expect(report.synced).toBe(5);
    expect(maxInFlight).toBe(1);
    // One RPC per sale, each carrying exactly one sale request id.
    expect(server.v5.mock.calls.length + server.recovery.mock.calls.length).toBe(5);
    expect(new Set(m.state.orders.map((o) => o.saleRequestId)).size).toBe(5);
    expect(m.state.orders).toHaveLength(5);
    // The two strict ones carry the originals; the ordinary ones carry Ben.
    expect(m.state.orders.filter((o) => o.employeeId === AMY)).toHaveLength(2);
    expect(m.state.orders.filter((o) => o.employeeId === BEN)).toHaveLength(3);
    expect(m.state.orders.some((o) => o.employeeId === null)).toBe(false);
  });

  it("an INTERRUPTED sync (committed, response lost, process died) resumes under the same id and replays", async () => {
    const m = model();
    const enqueued = await enqueueSale(input({ strictRecovery: STRICT }));

    if (!enqueued.ok) throw new Error("seed");

    // First process: the server commits, then the process dies before the
    // response is handled — the record is left in `syncing`. A dead process
    // never resumes, so its submission simply never settles.
    // Batch B: each process gets its own lock holder, and the death releases
    // that holder's locks — as the browser does for a dead tab or app process.
    const locks = createLockRegistry();
    const firstProcess = locks.process();

    setLockManagerForTests(firstProcess);
    const dying = createSaleSyncEngine({
      submit: async (record) => {
        m.rpc("complete_sale_recovery_v1", {
          p_payment_method: record.paymentMethod,
          p_tip_amount: 0,
          p_items: record.items,
          p_sale_request_id: record.saleRequestId,
          p_source: "offline_queued",
          p_original_employee_pos_session_id: STRICT.originalEmployeePosSessionId,
          p_original_register_session_id: STRICT.originalRegisterSessionId,
          p_original_attempt_at: STRICT.originalAttemptAt,
        });
        return new Promise<never>(() => undefined);
      },
      now: () => TODAY_09,
    });

    void dying.run();
    await vi.waitFor(async () => expect((await stored(enqueued.value.saleRequestId)).state).toBe("syncing"));
    expect(m.state.orders).toHaveLength(1);

    // Second process: startup reclaims the orphan and the ordinary engine
    // submits it again — under the same id, through strict recovery.
    firstProcess.kill();
    setLockManagerForTests(locks.process());
    resetSyncEngineForTests();
    const server = rpcs(m);

    await triggerSaleSync("startup", { submit: server.submit, now: () => TODAY_09 });

    const record = await stored(enqueued.value.saleRequestId);

    expect(record.state).toBe("synced");
    expect(server.recovery).toHaveBeenCalledTimes(1);
    expect(server.recovery.mock.calls[0][1].p_sale_request_id).toBe(enqueued.value.saleRequestId);
    expect(server.v5).not.toHaveBeenCalled();
    // Still exactly one order, under the originals.
    expect(m.state.orders).toHaveLength(1);
    expect(m.state.orders[0].employeeId).toBe(AMY);
    setLockManagerForTests(undefined);
  });
});
