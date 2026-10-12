// v1.3 CP-2B item C — the authorization/mutation race, against a real store.
//
// THE RACE INDEPENDENT REVIEW FOUND. The host used to ask "is this sale
// register-blocked?", get an answer, and then call discardRejectedSale, which
// re-read the record and wrote it. Between those two reads the stored rejection
// reason could change to register_unverified — and the discard proceeded on the
// strength of an authorization decision taken when it was something else.
//
// It is closed by having no gap: the record is read, the gate is applied to
// THAT read, and the write is issued, all inside one IndexedDB readwrite
// transaction over the queue and cache stores. IndexedDB serialises readwrite
// transactions over the same scope, so a competing writer runs strictly before
// or strictly after — never between.
//
// fake-indexeddb implements the specification, including that serialisation, so
// these are measurements rather than assertions about a design.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";

import { discardRejectedSale } from "@/lib/rejectedSaleSession";
import {
  enqueueSale,
  getQueuedSale,
  REGISTER_BLOCKED_ERROR_CODE,
  updateQueueState,
} from "@/lib/saleQueueSession";

const SALE = "11111111-1111-4111-8111-111111111111";
const QUEUE = "q-1";
const NOW = "2026-10-12T09:00:00.000Z";

const OWNER = { allowed: true } as const;
const CASHIER = { allowed: false } as const;

// THE ONLY DISCARDABLE REJECTION. lib/rejectedSaleResolution.ts admits exactly
// one terminal code, and its comment is explicit that adding another "is a
// financial decision, not a refactor". So an "unrelated rejection a cashier may
// discard" means post_revocation and nothing else -- which is also why the race
// test below starts there: the record must genuinely BE discardable before the
// reason changes under it, or the test proves nothing.
const OTHER_REASON = "post_revocation";

async function seed(lastErrorCode: string): Promise<void> {
  const queued = await enqueueSale({
    saleRequestId: SALE,
    queueRecordId: QUEUE,
    deviceAuthUserId: "22222222-2222-4222-8222-222222222222",
    deviceId: "33333333-3333-4333-8333-333333333333",
    projectId: "44444444-4444-4444-8444-444444444444",
    buildJobId: "55555555-5555-4555-8555-555555555555",
    paymentMethod: "cash",
    items: [{ itemId: "item-1", quantity: 2, modifiers: [] }],
    occurredAt: "2026-10-12T00:05:00.000Z",
    now: NOW,
    registerSessionId: "77777777-7777-4777-8777-777777777777",
  });

  expect(queued.ok).toBe(true);
  expect((await updateQueueState(QUEUE, "syncing", NOW)).ok).toBe(true);
  expect(
    (await updateQueueState(QUEUE, "needs_attention", NOW, {
      lastErrorCode,
      lastErrorMessage: "seeded",
    })).ok
  ).toBe(true);
}

/** Flips the stored reason to the register one, as a competing writer would. */
async function becomeRegisterBlocked(): Promise<void> {
  await updateQueueState(QUEUE, "pending", NOW);
  await updateQueueState(QUEUE, "syncing", NOW);
  await updateQueueState(QUEUE, "needs_attention", NOW, {
    lastErrorCode: REGISTER_BLOCKED_ERROR_CODE,
    lastErrorMessage: "A register session is required for an offline sale",
  });
}

async function readBack() {
  const read = await getQueuedSale(QUEUE);

  expect(read.ok).toBe(true);
  if (!read.ok) throw new Error("record vanished");

  return read.value;
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

describe("the gate is enforced on the record actually being mutated", () => {
  it("refuses a cashier discarding a register-blocked sale", async () => {
    await seed(REGISTER_BLOCKED_ERROR_CODE);

    expect(await discardRejectedSale(QUEUE, CASHIER)).toEqual({
      ok: false,
      reason: "reviewer_not_permitted",
    });

    const after = await readBack();

    // THE SALE REMAINS UNRESOLVED, with its identity and evidence intact.
    expect(after.state).toBe("needs_attention");
    expect(after.saleRequestId).toBe(SALE);
    expect(after.lastErrorCode).toBe(REGISTER_BLOCKED_ERROR_CODE);
    expect(after.registerSessionId).toBe("77777777-7777-4777-8777-777777777777");
  });

  it("does NOT let an owner discard a register-blocked sale either", async () => {
    // STATED HONESTLY RATHER THAN ASSERTED THE OTHER WAY. There is currently no
    // such thing as an "eligible register-blocked sale": register_unverified is
    // not a terminal rejection, so the accepted safety policy refuses it for
    // EVERYBODY. The role gate grants nothing the policy forbids -- an owner is
    // refused here too, and by the policy, not by the role.
    await seed(REGISTER_BLOCKED_ERROR_CODE);

    const result = await discardRejectedSale(QUEUE, OWNER);

    expect(result).toEqual({ ok: false, reason: "not_terminal_rejection" });

    const after = await readBack();

    expect(after.state).toBe("needs_attention");
    expect(after.lastErrorCode).toBe(REGISTER_BLOCKED_ERROR_CODE);
  });

  it("an owner CAN discard an eligible sale, so the gate is not a blanket refusal", async () => {
    await seed(OTHER_REASON);

    expect((await discardRejectedSale(QUEUE, OWNER)).ok).toBe(true);
    expect((await readBack()).state).toBe("discarded");
  });

  it("leaves the cashier policy alone for an unrelated rejection", async () => {
    await seed(OTHER_REASON);

    const result = await discardRejectedSale(QUEUE, CASHIER);

    expect(result.ok).toBe(true);
    expect((await readBack()).state).toBe("discarded");
  });
});

describe("the specific interleaving", () => {
  it("a cashier discard cannot be carried by a reason that changed under it", async () => {
    // 1. the record is rejected for an unrelated reason, so a cashier is eligible
    // 2. it becomes register_unverified before the discard mutation
    // 3. the unauthorised discard must be refused and the sale left unresolved
    //
    // The two operations are STARTED TOGETHER and not awaited in order, so the
    // store decides which transaction runs first. Whichever order it picks, the
    // invariant below must hold.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      globalThis.indexedDB = new IDBFactory();
      await seed(OTHER_REASON);

      const discarding = discardRejectedSale(QUEUE, CASHIER);
      const flipping = becomeRegisterBlocked();
      const [result] = await Promise.all([discarding, flipping]);

      const after = await readBack();

      if (result.ok) {
        // A discard only happened if the record was NOT register-blocked at the
        // moment it was written. The carried-forward code is that moment's code.
        expect(after.lastErrorCode).not.toBe(REGISTER_BLOCKED_ERROR_CODE);
        expect(after.state).toBe("discarded");
      } else {
        // Refused, by the role gate or by the safety policy -- either way the
        // sale is untouched and still waiting for a person.
        expect(["reviewer_not_permitted", "not_terminal_rejection"]).toContain(result.reason);
        expect(after.state).toBe("needs_attention");
        expect(after.saleRequestId).toBe(SALE);
      }
    }
  });

  it("NEVER discards a register-blocked record for a cashier, over many races", async () => {
    // The invariant stated directly: across many interleavings, there is no run
    // in which a record that was register-blocked when written ended up
    // discarded by someone not permitted to resolve it.
    const violations: string[] = [];

    for (let attempt = 0; attempt < 40; attempt += 1) {
      globalThis.indexedDB = new IDBFactory();
      await seed(OTHER_REASON);

      const discarding = discardRejectedSale(QUEUE, CASHIER);

      // Flip at a slightly different point each run, so the two transactions
      // are offered every ordering the store can give them.
      if (attempt % 2 === 0) await Promise.resolve();

      await Promise.all([discarding, becomeRegisterBlocked()]);

      const after = await readBack();

      if (after.state === "discarded" && after.lastErrorCode === REGISTER_BLOCKED_ERROR_CODE) {
        violations.push(`attempt ${attempt}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("an owner wins the same race legitimately, so the test is not vacuous", async () => {
    // If the refusals above came from the discard simply never running, this
    // would fail too. It does not: the same interleaving with a permitted
    // reviewer still resolves the sale.
    let discarded = 0;

    for (let attempt = 0; attempt < 20; attempt += 1) {
      globalThis.indexedDB = new IDBFactory();
      await seed(OTHER_REASON);

      const [result] = await Promise.all([
        discardRejectedSale(QUEUE, OWNER),
        becomeRegisterBlocked(),
      ]);

      if (result.ok) discarded += 1;
    }

    expect(discarded).toBeGreaterThan(0);
  });
});
