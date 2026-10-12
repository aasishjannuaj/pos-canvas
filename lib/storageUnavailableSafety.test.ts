// v1.3 CP-2R — unreadable financial storage must fail CLOSED.
//
// THE DEFECT THIS PINS. readOfflineSaleStatus answered a failed queue read with
// zeros, and a failed uncertain-sale read with `false`. Both reached
// decideDeviceResetSafety as "nothing outstanding", so a device that could not
// open its own storage was cleared to reset, unpair, or apply a new
// configuration — over records it had never managed to read.
//
// THE FAILURES HERE ARE SIMULATED DETERMINISTICALLY, not approximated with
// malformed fixtures. A malformed record is a successful read of bad data and
// is already covered by the restart suite; this file is about not being able to
// read at all, which is a different answer and was the one being lost. Each
// failure is injected by mocking the module boundary that reports it, with
// everything else left real via importActual.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const IDENTITY = {
  deviceAuthUserId: "22222222-2222-4222-8222-222222222222",
  deviceId: "33333333-3333-4333-8333-333333333333",
  projectId: "44444444-4444-4444-8444-444444444444",
  buildJobId: "55555555-5555-4555-8555-555555555555",
};
const SALE = "11111111-1111-4111-8111-111111111111";
const REGISTER = "77777777-7777-4777-8777-777777777777";
const NOW = "2026-10-12T09:00:00.000Z";

/** Makes listQueuedSales report that storage could not be read. */
function breakQueueRead(): void {
  vi.doMock("@/lib/saleQueueSession", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/saleQueueSession")>()),
    listQueuedSales: async () => ({ ok: false as const, reason: "storage_unavailable" as const }),
  }));
}

/** Makes the uncertain-sale evidence read report that it could not look. */
function breakEvidenceRead(): void {
  vi.doMock("@/lib/uncertainSaleSession", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/uncertainSaleSession")>()),
    readUncertainSaleEvidence: async () => "unreadable" as const,
  }));
}

async function readStatus() {
  const checkout = await import("@/lib/offlineCheckoutSession");

  return checkout.readOfflineSaleStatus();
}

async function gates() {
  const status = await import("@/lib/offlineSaleStatus");
  const update = await import("@/lib/deviceConfigUpdate");

  return { status, update };
}

/** The three operations the correction must cover, against one status. */
async function decideAll(saleStatus: Awaited<ReturnType<typeof readStatus>>) {
  const { status, update } = await gates();

  return {
    reset: status.decideDeviceResetSafety(saleStatus),
    // Voluntary unpair takes the SAME durable read and the SAME decision --
    // DeviceApp calls decideDeviceResetSafety for both.
    unpair: status.decideDeviceResetSafety(saleStatus),
    apply: update.decideApplyUpdateSafety({
      cartLineCount: 0,
      saleStatus,
      onlineHint: true,
    }),
  };
}

async function seedQueuedSale(): Promise<void> {
  const session = await import("@/lib/saleQueueSession");
  const queued = await session.enqueueSale({
    saleRequestId: SALE,
    queueRecordId: "q-1",
    ...IDENTITY,
    paymentMethod: "cash",
    items: [{ itemId: "item-1", quantity: 2, modifiers: [] }],
    occurredAt: "2026-10-12T00:05:00.000Z",
    now: NOW,
    registerSessionId: REGISTER,
  });

  expect(queued.ok).toBe(true);
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  vi.doUnmock("@/lib/saleQueueSession");
  vi.doUnmock("@/lib/uncertainSaleSession");
});

// ---------------------------------------------------------------------------

describe("1. storage read successfully and genuinely empty", () => {
  it("permits reset, unpair and Apply", async () => {
    const status = await readStatus();

    expect(status.evidenceReadable).toBe(true);
    expect(status.unsynced).toBe(0);

    const decided = await decideAll(status);

    expect(decided.reset.allowed).toBe(true);
    expect(decided.unpair.allowed).toBe(true);
    expect(decided.apply.allowed).toBe(true);
  });
});

describe("2. storage read successfully with unresolved records", () => {
  it("a PENDING sale still blocks reset, unpair and Apply", async () => {
    await seedQueuedSale();

    const status = await readStatus();

    expect(status.evidenceReadable).toBe(true);
    expect(status.unsynced).toBe(1);

    const decided = await decideAll(status);

    expect(decided.reset.allowed).toBe(false);
    expect(decided.unpair.allowed).toBe(false);
    expect(decided.apply.allowed).toBe(false);
  });

  it("a NEEDS ATTENTION sale still blocks", async () => {
    await seedQueuedSale();

    const session = await import("@/lib/saleQueueSession");

    expect((await session.updateQueueState("q-1", "syncing", NOW)).ok).toBe(true);
    expect(
      (await session.updateQueueState("q-1", "needs_attention", NOW, {
        lastErrorCode: "register_unverified",
      })).ok
    ).toBe(true);

    const status = await readStatus();

    expect(status.evidenceReadable).toBe(true);
    expect(status.needsAttention).toBe(1);
    expect((await decideAll(status)).reset.allowed).toBe(false);
  });

  it("a QUARANTINED record still blocks", async () => {
    const store = await import("@/lib/deviceOfflineStore");
    const db = await store.openOfflineDb();

    expect(db.ok).toBe(true);
    if (!db.ok) return;

    await store.putQueuedSale(db.value, {
      queueRecordId: "broken-1",
      saleRequestId: "not-a-uuid",
      state: "pending",
    });

    const status = await readStatus();

    // A successful read of a record that will not parse. Still readable
    // storage -- and still blocking.
    expect(status.evidenceReadable).toBe(true);
    expect(status.unsynced).toBe(1);
    expect((await decideAll(status)).reset.allowed).toBe(false);
  });
});

describe("3. a failed QUEUE read blocks instead of appearing empty", () => {
  it("does not report an empty, readable queue", async () => {
    breakQueueRead();

    const status = await readStatus();

    // The counts are zero because there is nothing to count -- but the flag
    // says they mean nothing, which is the whole correction.
    expect(status.unsynced).toBe(0);
    expect(status.evidenceReadable).toBe(false);
  });

  it("blocks reset, unpair AND Apply", async () => {
    breakQueueRead();

    const decided = await decideAll(await readStatus());

    expect(decided.reset.allowed).toBe(false);
    expect(decided.unpair.allowed).toBe(false);
    expect(decided.apply.allowed).toBe(false);
  });

  it("explains itself to the operator without jargon", async () => {
    breakQueueRead();

    const decided = await decideAll(await readStatus());

    expect(decided.reset.allowed).toBe(false);
    if (decided.reset.allowed) return;

    const message = decided.reset.message;

    expect(message).toContain("could not check the sales saved on it");
    expect(message.toLowerCase()).not.toContain("indexeddb");
    expect(message.toLowerCase()).not.toContain("storage_unavailable");
    expect(message.toLowerCase()).not.toContain("undefined");
    // It says what to do next.
    expect(message).toContain("try again");
  });
});

describe("4. a failed UNCERTAIN-SALE evidence read also blocks", () => {
  it("is distinguished from 'no outstanding request'", async () => {
    breakEvidenceRead();

    const status = await readStatus();

    // The old boolean read would have said `false` here and sailed through.
    expect(status.evidenceReadable).toBe(false);
    expect((await decideAll(status)).reset.allowed).toBe(false);
    expect((await decideAll(status)).apply.allowed).toBe(false);
  });

  it("blocks even when the queue itself read back clean and empty", async () => {
    // The queue is fine; only the evidence read failed. Previously this was the
    // easiest way to reach a reset over an outstanding online request.
    breakEvidenceRead();

    const status = await readStatus();

    expect(status.unsynced).toBe(0);
    expect(status.evidenceReadable).toBe(false);
    expect((await decideAll(status)).reset.allowed).toBe(false);
  });

  it("a genuinely absent record still permits the operation", async () => {
    // Proving the block above comes from the FAILURE, not from the read being
    // consulted at all.
    const status = await readStatus();

    expect(status.evidenceReadable).toBe(true);
    expect(status.uncertainOnlineSale).toBe(false);
    expect((await decideAll(status)).reset.allowed).toBe(true);
  });

  it("an evidence record that IS present blocks with its own message", async () => {
    const uncertain = await import("@/lib/uncertainSaleSession");

    expect(
      await uncertain.armUncertainSale({
        sale: {
          saleRequestId: SALE,
          projectId: IDENTITY.projectId,
          paymentMethod: "cash",
          tipAmount: 0,
          items: [{ itemId: "item-1", quantity: 2, modifiers: [] }],
          fingerprint: "fp-1",
        },
        identity: IDENTITY,
        dispatchedAt: NOW,
      })
    ).toBe(true);

    const status = await readStatus();
    const decided = await decideAll(status);

    expect(status.evidenceReadable).toBe(true);
    expect(status.uncertainOnlineSale).toBe(true);
    expect(decided.reset.allowed).toBe(false);
    if (decided.reset.allowed) return;
    expect(decided.reset.message).toContain("may already have gone through");
  });
});

describe("5. the refusal lifts only on a successful fresh read", () => {
  it("stays in force while the read keeps failing, and lifts when it succeeds", async () => {
    breakQueueRead();

    const whileBroken = await readStatus();

    expect(whileBroken.evidenceReadable).toBe(false);
    expect((await decideAll(whileBroken)).reset.allowed).toBe(false);

    // Repeating the read changes nothing while it still fails -- there is no
    // latch that could decay into permission, and none that could stick.
    const stillBroken = await readStatus();

    expect(stillBroken.evidenceReadable).toBe(false);
    expect((await decideAll(stillBroken)).reset.allowed).toBe(false);

    // Storage recovers. A FRESH read is what establishes safety.
    vi.doUnmock("@/lib/saleQueueSession");
    vi.resetModules();

    const recovered = await readStatus();

    expect(recovered.evidenceReadable).toBe(true);
    expect((await decideAll(recovered)).reset.allowed).toBe(true);
  });

  it("a recovered read does not become permissive over real records", async () => {
    await seedQueuedSale();

    breakQueueRead();
    expect((await decideAll(await readStatus())).reset.allowed).toBe(false);

    vi.doUnmock("@/lib/saleQueueSession");
    vi.resetModules();

    const recovered = await readStatus();

    // Readable again -- and the sale it can now see still blocks.
    expect(recovered.evidenceReadable).toBe(true);
    expect(recovered.unsynced).toBe(1);
    expect((await decideAll(recovered)).reset.allowed).toBe(false);
  });
});

describe("6. the correction changes no financial record", () => {
  it("leaves the queued sale byte-identical across failed and recovered reads", async () => {
    await seedQueuedSale();

    const session = await import("@/lib/saleQueueSession");
    const before = await session.getQueuedSale("q-1");

    expect(before.ok).toBe(true);
    if (!before.ok) return;

    breakQueueRead();
    await readStatus();
    await decideAll(await readStatus());

    vi.doUnmock("@/lib/saleQueueSession");
    vi.resetModules();

    const after = await (await import("@/lib/saleQueueSession")).getQueuedSale("q-1");

    expect(after.ok).toBe(true);
    if (!after.ok) return;

    // Identity, money, claim and state all untouched: reading a status and
    // refusing an operation writes nothing.
    expect(after.value).toEqual(before.value);
    expect(after.value.saleRequestId).toBe(SALE);
    expect(after.value.registerSessionId).toBe(REGISTER);
    expect(after.value.state).toBe("pending");
  });
});

describe("7. the pre-read initial state is fail-closed", () => {
  // DeviceApp cannot be rendered here (no DOM, and it needs pairing, storage
  // and a backend client to mount), so this is asserted at the source level, as
  // lib/deviceUnpair.guards.test.ts and friends already do for this component.
  //
  // IT IS HERE BECAUSE A BITE CONTROL FOUND NOTHING. Flipping this one literal
  // to `true` left every other suite green: a till would then assert, before
  // its first durable read returned, that its records were readable and empty —
  // the same fail-open this correction removes, at the one moment the device
  // genuinely knows nothing.
  it("EMPTY_SALE_STATUS does not claim its records are readable", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const app = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "components/device/DeviceApp.tsx"),
      "utf-8"
    );
    const literal = app.slice(
      app.indexOf("const EMPTY_SALE_STATUS: OfflineSaleStatus = {"),
      app.indexOf("};", app.indexOf("const EMPTY_SALE_STATUS: OfflineSaleStatus = {"))
    );

    expect(literal).not.toBe("");
    expect(literal).toContain("evidenceReadable: false,");
    expect(literal).not.toContain("evidenceReadable: true");
  });

  it("the gate refuses that initial state", async () => {
    const { status } = await gates();
    const initial = {
      waiting: 0,
      needsAttention: 0,
      synced: 0,
      unsynced: 0,
      total: 0,
      nextRetryAt: null,
      uncertainOnlineSale: false,
      evidenceReadable: false,
    };

    // Zeros everywhere, and still refused -- because nothing has been read.
    expect(status.decideDeviceResetSafety(initial).allowed).toBe(false);
  });
});
