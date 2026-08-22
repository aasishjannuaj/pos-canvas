// Feature 24.5C — the queue's pure rules: state machine, validation, recovery.
//
// Runs under plain Node. Storage is exercised separately in
// lib/saleQueueSession.test.ts against a real IndexedDB implementation.
import { describe, expect, it } from "vitest";
import {
  QUEUE_STATES,
  QUEUE_TRANSITIONS,
  SALE_QUEUE_SCHEMA_VERSION,
  SALE_REQUEST_PAYLOAD_VERSION,
  TERMINAL_QUEUE_STATES,
  canTransition,
  isQueueState,
  markQueuedSaleAttempt,
  readQueuedSale,
  recoverInterruptedSale,
  sortQueueFifo,
  summarizeQueue,
  transitionQueuedSale,
} from "@/lib/saleQueue";
import type { QueueState, QueuedSale } from "@/lib/saleQueue";

const NOW = "2026-08-19T12:00:00.000Z";

function makeSale(overrides: Partial<QueuedSale> = {}): QueuedSale {
  return {
    queueSchemaVersion: SALE_QUEUE_SCHEMA_VERSION,
    requestPayloadVersion: SALE_REQUEST_PAYLOAD_VERSION,
    queueRecordId: "q-1",
    saleRequestId: "11111111-1111-4111-8111-111111111111",
    deviceAuthUserId: "22222222-2222-4222-8222-222222222222",
    deviceId: "33333333-3333-4333-8333-333333333333",
    projectId: "44444444-4444-4444-8444-444444444444",
    buildJobId: "55555555-5555-4555-8555-555555555555",
    paymentMethod: "cash",
    tipAmount: 0,
    items: [{ itemId: "item-1", quantity: 2, modifiers: [] }],
    occurredAt: "2026-08-19T11:00:00.000Z",
    source: "offline_queued",
    state: "pending",
    queuedAt: "2026-08-19T11:00:05.000Z",
    updatedAt: "2026-08-19T11:00:05.000Z",
    attemptCount: 0,
    lastAttemptAt: null,
    nextAttemptAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    serverOrderId: null,
    serverOrderNumber: null,
    serverCreatedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

describe("the queue state machine", () => {
  it("declares exactly the six approved states", () => {
    expect([...QUEUE_STATES].sort()).toEqual(
      [
        "needs_attention",
        "pending",
        "permanent_failure",
        "synced",
        "syncing",
        // Feature 24.5F — a rejected sale an operator resolved deliberately.
        "discarded",
      ].sort()
    );
  });

  it("permits every approved transition", () => {
    const legal: [QueueState, QueueState][] = [
      ["pending", "syncing"],
      ["syncing", "pending"],
      ["syncing", "synced"],
      ["syncing", "needs_attention"],
      ["syncing", "permanent_failure"],
      ["needs_attention", "pending"],
      ["needs_attention", "permanent_failure"],
    ];

    for (const [from, to] of legal) {
      expect(`${from} -> ${to}`).toBe(`${from} -> ${to}`);
      expect(canTransition(from, to)).toBe(true);
    }
  });

  it("refuses synced -> pending, which would re-submit recorded money", () => {
    expect(canTransition("synced", "pending")).toBe(false);
    expect(canTransition("synced", "syncing")).toBe(false);
  });

  it("treats synced and permanent_failure as terminal", () => {
    for (const state of TERMINAL_QUEUE_STATES) {
      expect(`${state} is terminal`).toBe(`${state} is terminal`);
      expect(QUEUE_TRANSITIONS[state]).toEqual([]);

      for (const target of QUEUE_STATES) {
        expect(canTransition(state, target)).toBe(false);
      }
    }
  });

  it("refuses pending -> synced, so nothing skips the syncing step", () => {
    // A sale may only become synced by way of an attempt. Allowing the jump
    // would let a caller mark money recorded without anything having submitted.
    expect(canTransition("pending", "synced")).toBe(false);
    expect(canTransition("pending", "needs_attention")).toBe(false);
    expect(canTransition("pending", "permanent_failure")).toBe(false);
  });

  it("refuses a transition to the same state", () => {
    for (const state of QUEUE_STATES) {
      expect(`${state} -> ${state}`).toBe(`${state} -> ${state}`);
      expect(canTransition(state, state)).toBe(false);
    }
  });

  it("applies a legal transition immutably", () => {
    const before = makeSale();
    const result = transitionQueuedSale(before, "syncing", NOW);

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.record.state).toBe("syncing");
    expect(result.ok === true && result.record.updatedAt).toBe(NOW);
    expect(before.state).toBe("pending");
  });

  it("reports an illegal transition instead of applying it", () => {
    const result = transitionQueuedSale(makeSale({ state: "synced" }), "pending", NOW);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("illegal_transition");
    expect(result.ok === false && result.from).toBe("synced");
    expect(result.ok === false && result.to).toBe("pending");
  });

  it("carries an error reason onto a failing transition", () => {
    const result = transitionQueuedSale(makeSale({ state: "syncing" }), "needs_attention", NOW, {
      lastErrorCode: "P0001",
      lastErrorMessage: "Offline sale occurred after this device was revoked",
    });

    expect(result.ok === true && result.record.lastErrorCode).toBe("P0001");
    expect(result.ok === true && result.record.lastErrorMessage).toContain("revoked");
  });

  it("isQueueState rejects anything not in the set", () => {
    expect(isQueueState("pending")).toBe(true);
    for (const bad of ["", "PENDING", "queued", null, 3, {}]) {
      expect(isQueueState(bad)).toBe(false);
    }
  });
});

describe("attempt metadata", () => {
  it("increments and timestamps without touching state", () => {
    const marked = markQueuedSaleAttempt(makeSale({ state: "syncing" }), NOW);

    expect(marked.attemptCount).toBe(1);
    expect(marked.lastAttemptAt).toBe(NOW);
    expect(marked.state).toBe("syncing");
  });

  it("survives a subsequent transition", () => {
    // The count must not be reset by moving state, or a record that keeps
    // failing mid-sync would retry forever without reaching a cap.
    const marked = markQueuedSaleAttempt(makeSale({ state: "syncing" }), NOW);
    const moved = transitionQueuedSale(marked, "pending", NOW);

    expect(moved.ok === true && moved.record.attemptCount).toBe(1);
    expect(moved.ok === true && moved.record.lastAttemptAt).toBe(NOW);
  });
});

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

describe("interrupted-sync recovery", () => {
  it("returns a stranded syncing record to pending", () => {
    const recovered = recoverInterruptedSale(makeSale({ state: "syncing" }), NOW);

    expect(recovered.state).toBe("pending");
    expect(recovered.updatedAt).toBe(NOW);
  });

  it("preserves attempt metadata across recovery", () => {
    // The attempt genuinely happened. Erasing it would uncap retries.
    const stranded = makeSale({ state: "syncing", attemptCount: 3, lastAttemptAt: "x" });
    const recovered = recoverInterruptedSale(stranded, NOW);

    expect(recovered.attemptCount).toBe(3);
    expect(recovered.lastAttemptAt).toBe("x");
  });

  it("leaves every other state alone", () => {
    for (const state of ["pending", "synced", "needs_attention", "permanent_failure"] as const) {
      const record = makeSale({ state });

      expect(`recovery touched ${state}`).toBe(`recovery touched ${state}`);
      expect(recoverInterruptedSale(record, NOW)).toEqual(record);
    }
  });
});

// ---------------------------------------------------------------------------
// Ordering and counts
// ---------------------------------------------------------------------------

describe("ordering and summary", () => {
  it("orders FIFO by queuedAt", () => {
    const sorted = sortQueueFifo([
      makeSale({ queueRecordId: "c", queuedAt: "2026-08-19T11:00:03.000Z" }),
      makeSale({ queueRecordId: "a", queuedAt: "2026-08-19T11:00:01.000Z" }),
      makeSale({ queueRecordId: "b", queuedAt: "2026-08-19T11:00:02.000Z" }),
    ]);

    expect(sorted.map((s) => s.queueRecordId)).toEqual(["a", "b", "c"]);
  });

  it("breaks ties by record id so the order is total", () => {
    const sorted = sortQueueFifo([
      makeSale({ queueRecordId: "z", queuedAt: NOW }),
      makeSale({ queueRecordId: "a", queuedAt: NOW }),
    ]);

    expect(sorted.map((s) => s.queueRecordId)).toEqual(["a", "z"]);
  });

  it("counts each state and excludes permanent_failure from outstanding", () => {
    const summary = summarizeQueue([
      makeSale({ state: "pending" }),
      makeSale({ state: "pending" }),
      makeSale({ state: "syncing" }),
      makeSale({ state: "synced" }),
      makeSale({ state: "needs_attention" }),
      makeSale({ state: "permanent_failure" }),
    ]);

    expect(summary.pending).toBe(2);
    expect(summary.syncing).toBe(1);
    expect(summary.synced).toBe(1);
    expect(summary.needsAttention).toBe(1);
    expect(summary.permanentFailure).toBe(1);
    expect(summary.total).toBe(6);
    // pending + syncing + needs_attention. A permanent failure is waiting for a
    // person, not for the network, so a status badge counting it never clears.
    expect(summary.outstanding).toBe(4);
  });

  it("summarizes an empty queue as all zeroes", () => {
    expect(summarizeQueue([])).toEqual({
      pending: 0,
      syncing: 0,
      synced: 0,
      needsAttention: 0,
      discarded: 0,
      permanentFailure: 0,
      outstanding: 0,
      total: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("a stored record is validated before it is believed", () => {
  it("round-trips a good record through JSON", () => {
    const result = readQueuedSale(JSON.parse(JSON.stringify(makeSale())));

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.record.items[0].quantity).toBe(2);
  });

  it("refuses missing and structurally wrong values", () => {
    for (const bad of [null, undefined, "nope", 7, []]) {
      expect(readQueuedSale(bad).ok).toBe(false);
    }
  });

  it("refuses an envelope or payload version it does not understand", () => {
    expect(readQueuedSale(makeSale({ queueSchemaVersion: 99 })).ok).toBe(false);
    expect(readQueuedSale(makeSale({ requestPayloadVersion: 99 })).ok).toBe(false);
  });

  it("refuses a record missing any identity field", () => {
    for (const field of [
      "queueRecordId",
      "saleRequestId",
      "deviceAuthUserId",
      "deviceId",
      "projectId",
      "buildJobId",
      "occurredAt",
      "queuedAt",
    ] as const) {
      const record = { ...makeSale(), [field]: "" };

      expect(`missing ${field} accepted`).toBe(`missing ${field} accepted`);
      expect(readQueuedSale(record).ok).toBe(false);
    }
  });

  it("refuses a source that is not offline_queued", () => {
    expect(readQueuedSale({ ...makeSale(), source: "online" }).ok).toBe(false);
  });

  it("refuses an unknown state", () => {
    const result = readQueuedSale({ ...makeSale(), state: "queued" });

    expect(result.ok === false && result.reason).toBe("invalid_state");
  });

  it("NEVER invents a missing financial field", () => {
    // The rule that matters most: a sale whose payment method or items cannot
    // be read is not defaulted into existence, it is refused.
    const noMethod = readQueuedSale({ ...makeSale(), paymentMethod: undefined });
    const noItems = readQueuedSale({ ...makeSale(), items: undefined });

    expect(noMethod.ok === false && noMethod.reason).toBe("invalid_money");
    expect(noItems.ok === false && noItems.reason).toBe("invalid_items");
  });

  it("refuses an unknown payment method", () => {
    for (const method of ["", "crypto", "CASH", null, 1]) {
      expect(readQueuedSale({ ...makeSale(), paymentMethod: method }).ok).toBe(false);
    }
  });

  it("refuses a non-zero tip, which the server would reject anyway", () => {
    for (const tip of [0.01, -1, Number.NaN, "0"]) {
      expect(readQueuedSale({ ...makeSale(), tipAmount: tip }).ok).toBe(false);
    }
  });

  it("refuses malformed items", () => {
    for (const items of [
      [],
      [{ itemId: "", quantity: 1, modifiers: [] }],
      [{ itemId: "a", quantity: 0, modifiers: [] }],
      [{ itemId: "a", quantity: 1.5, modifiers: [] }],
      [{ itemId: "a", quantity: -1, modifiers: [] }],
      [{ itemId: "a", quantity: 1, modifiers: "none" }],
      [{ itemId: "a", quantity: 1, modifiers: [{ groupId: "", optionIds: [] }] }],
      [{ itemId: "a", quantity: 1, modifiers: [{ groupId: "g", optionIds: [""] }] }],
      "not-an-array",
    ]) {
      expect(readQueuedSale({ ...makeSale(), items }).ok).toBe(false);
    }
  });

  it("accepts an absent modifiers array as no modifiers", () => {
    const result = readQueuedSale({
      ...makeSale(),
      items: [{ itemId: "a", quantity: 1 }],
    });

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.record.items[0].modifiers).toEqual([]);
  });

  it("refuses a negative or non-integer attempt count", () => {
    for (const count of [-1, 1.5, "2", null]) {
      expect(readQueuedSale({ ...makeSale(), attemptCount: count }).ok).toBe(false);
    }
  });
});


// ---------------------------------------------------------------------------
// Final persistence-integrity audit (24.5C review)
//
// The audit found that saleRequestId was accepted as any non-empty string and
// that timestamps were never parsed. Both are unsubmittable-record bugs: a key
// complete_sale_v4 cannot accept, or an occurredAt it cannot validate, would
// enqueue happily and then be rejected by the server forever, holding money
// that can never be recorded.
// ---------------------------------------------------------------------------

describe("the idempotency key must be one the server will accept", () => {
  it("accepts a real v4 UUID", () => {
    expect(readQueuedSale(makeSale()).ok).toBe(true);
  });

  it("refuses the nil UUID, which every complete_sale_* rejects", () => {
    const result = readQueuedSale(
      makeSale({ saleRequestId: "00000000-0000-0000-0000-000000000000" })
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("malformed");
  });

  it("refuses anything that is not a UUID", () => {
    for (const bad of [
      "same-id",
      "",
      "   ",
      "11111111-1111-4111-8111",
      "11111111-1111-4111-8111-11111111111z",
      42,
      null,
    ]) {
      expect(`accepted key ${String(bad)}`).toBe(`accepted key ${String(bad)}`);
      expect(readQueuedSale(makeSale({ saleRequestId: bad as string })).ok).toBe(false);
    }
  });
});

describe("timestamps must be parseable, not merely non-empty", () => {
  it("refuses an unparseable occurredAt", () => {
    // The value complete_sale_v4 checks against the 7-day bound, the pairing
    // floor and revoked_at.
    for (const bad of ["whenever", "", "2026-13-45T99:99:99Z", 0, null]) {
      expect(`accepted occurredAt ${String(bad)}`).toBe(`accepted occurredAt ${String(bad)}`);
      expect(readQueuedSale(makeSale({ occurredAt: bad as string })).ok).toBe(false);
    }
  });

  it("refuses an unparseable queuedAt or updatedAt", () => {
    expect(readQueuedSale(makeSale({ queuedAt: "nope" })).ok).toBe(false);
    expect(readQueuedSale(makeSale({ updatedAt: "nope" })).ok).toBe(false);
  });

  it("accepts null attempt timestamps but refuses unparseable ones", () => {
    expect(readQueuedSale(makeSale({ lastAttemptAt: null, nextAttemptAt: null })).ok).toBe(true);
    expect(readQueuedSale(makeSale({ lastAttemptAt: "soon" })).ok).toBe(false);
    expect(readQueuedSale(makeSale({ nextAttemptAt: "later" })).ok).toBe(false);
    expect(
      readQueuedSale(makeSale({ lastAttemptAt: "2026-08-19T11:30:00.000Z" })).ok
    ).toBe(true);
  });
});
