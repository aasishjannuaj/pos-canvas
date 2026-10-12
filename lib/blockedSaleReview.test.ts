// v1.3 CP-2B item C — the blocked-sale review rules.
//
// Vitest runs under environment: "node" with no DOM here, so every rule this
// workflow obeys lives in lib/blockedSaleReview.ts and is proven against real
// inputs. The component is a renderer; what it is wired to is asserted
// separately by the structural guard.

import { describe, expect, it } from "vitest";

import {
  BLOCKED_SALE_ACK_REFUSALS,
  BLOCKED_SALE_REVIEW_REFUSALS,
  BLOCKED_SALE_REVIEW_ROLES,
  buildBlockedSaleAcknowledgement,
  decideBlockedSaleReviewer,
  summarizeBlockedSale,
  type BlockedSaleSummary,
} from "@/lib/blockedSaleReview";
import { EMPLOYEE_ROLES } from "@/lib/employeeSession";
import {
  appendBlockedSaleReview,
  BLOCKED_SALE_REVIEW_TRAIL_LIMIT,
  readQueuedSale,
  SALE_QUEUE_SCHEMA_VERSION,
  SALE_REQUEST_PAYLOAD_VERSION,
} from "@/lib/saleQueue";

const OWNER = { employeeId: "e1", displayName: "Olive", role: "owner" as const };
const MANAGER = { employeeId: "e2", displayName: "Mira", role: "manager" as const };
const CASHIER = { employeeId: "e3", displayName: "Cass", role: "cashier" as const };

const RECORD = {
  saleRequestId: "sale-req-1",
  queueRecordId: "queue-1",
  occurredAt: "2026-10-11T23:55:00.000Z",
  paymentMethod: "cash" as "cash" | "card",
  registerSessionId: "reg-yesterday",
  employeePosSessionId: "pos-1",
  lastErrorCode: "register_unverified",
};

const RECEIPT = {
  total: "32.00",
  items: [
    { itemName: "Bourbon", quantity: 1, lineTotal: "20.00" },
    { itemName: "Mixer", quantity: 1, lineTotal: "12.00" },
  ],
};

const REASON = "This sale could not be recorded against a register.";

function summary(overrides: Partial<typeof RECORD> = {}): BlockedSaleSummary {
  const built = summarizeBlockedSale({
    record: { ...RECORD, ...overrides },
    receipt: RECEIPT,
    rejectionReason: REASON,
  });

  if (built === null) throw new Error("fixture produced no summary");

  return built;
}

// ---------------------------------------------------------------------------

describe("who may review a blocked sale", () => {
  it("permits an owner and a manager", () => {
    for (const session of [OWNER, MANAGER]) {
      expect(decideBlockedSaleReviewer(session)).toEqual({
        allowed: true,
        reviewer: session,
      });
    }
  });

  it("REFUSES a cashier", () => {
    // The person most likely to be at the till when a sale blocks is the one
    // who took the money. Letting them clear their own unreconciled takings is
    // the gap this closes.
    expect(decideBlockedSaleReviewer(CASHIER)).toEqual({
      allowed: false,
      refusal: "role_not_permitted",
      message: BLOCKED_SALE_REVIEW_REFUSALS.role_not_permitted,
    });
  });

  it("covers every role the schema allows, with no gaps", () => {
    // employees_role_check is owner / manager / cashier. If a fourth role is
    // ever added, this fails rather than silently defaulting it to permitted.
    expect([...EMPLOYEE_ROLES].sort()).toEqual(["cashier", "manager", "owner"]);

    for (const role of EMPLOYEE_ROLES) {
      const decision = decideBlockedSaleReviewer({ ...OWNER, role });

      expect(decision.allowed).toBe(BLOCKED_SALE_REVIEW_ROLES.includes(role));
    }
  });

  it("refuses an unreadable or absent session rather than assuming one", () => {
    for (const session of [
      null, undefined, "owner", 42, [], {},
      { employeeId: "", displayName: "O", role: "owner" },
      { employeeId: "e1", displayName: "   ", role: "owner" },
      { employeeId: "e1", displayName: "O", role: "supervisor" },
      { employeeId: "e1", displayName: "O" },
      { employeeId: "e1", displayName: "O", role: null },
    ]) {
      const decision = decideBlockedSaleReviewer(session);

      expect(decision.allowed).toBe(false);
      if (decision.allowed) continue;
      expect(decision.refusal).toBe("not_signed_in");
    }
  });

  it("never throws, whatever it is handed", () => {
    for (const value of [NaN, Infinity, Symbol("s"), () => {}, new Date(), [[]], true]) {
      expect(() => decideBlockedSaleReviewer(value)).not.toThrow();
      expect(decideBlockedSaleReviewer(value).allowed).toBe(false);
    }
  });

  it("the permitted set is frozen", () => {
    expect(Object.isFrozen(BLOCKED_SALE_REVIEW_ROLES)).toBe(true);
    expect([...BLOCKED_SALE_REVIEW_ROLES].sort()).toEqual(["manager", "owner"]);
  });
});

describe("what the reviewer is shown", () => {
  it("shows the ORIGINAL sale id, never a new one", () => {
    expect(summary().saleRequestId).toBe("sale-req-1");
  });

  it("shows the claimed register as a CLAIM, and null when there is none", () => {
    expect(summary().claimedRegisterSessionId).toBe("reg-yesterday");
    expect(summary({ registerSessionId: undefined as unknown as string }).claimedRegisterSessionId)
      .toBeNull();
    expect(summary({ registerSessionId: "" }).claimedRegisterSessionId).toBeNull();
  });

  it("marks a cash sale as cash collected", () => {
    // The most important field on the screen: money is in the drawer that POS
    // Canvas has no record of.
    expect(summary().recordedAsCashPayment).toBe(true);
    expect(summary({ paymentMethod: "card" as const }).recordedAsCashPayment).toBe(false);
  });

  it("shows the amount, the items and the time", () => {
    const s = summary();

    expect(s.totalFixed).toBe("32.00");
    expect(s.occurredAt).toBe("2026-10-11T23:55:00.000Z");
    expect(s.items).toEqual([
      { name: "Bourbon", quantity: 1, lineTotal: "20.00" },
      { name: "Mixer", quantity: 1, lineTotal: "12.00" },
    ]);
  });

  it("shows the rejection reason and code", () => {
    expect(summary().rejectionReason).toBe(REASON);
    expect(summary().rejectionCode).toBe("register_unverified");
    expect(summary({ lastErrorCode: null as unknown as string }).rejectionCode).toBeNull();
  });

  it("renders a degraded record with nulls rather than refusing to show it", () => {
    // An operator with a blocked sale must at least be able to LOOK at it.
    const degraded = summarizeBlockedSale({
      record: { saleRequestId: "s", queueRecordId: "q" },
      receipt: null,
      rejectionReason: REASON,
    });

    expect(degraded).not.toBeNull();
    expect(degraded?.totalFixed).toBeNull();
    expect(degraded?.items).toEqual([]);
    expect(degraded?.claimedRegisterSessionId).toBeNull();
    // An unreadable payment method is treated as card, so nothing is ever
    // falsely announced as cash in the drawer.
    expect(degraded?.recordedAsCashPayment).toBe(false);
  });

  it("drops unreadable line items instead of inventing them", () => {
    const s = summarizeBlockedSale({
      record: RECORD,
      receipt: { total: "9.00", items: [
        { itemName: "Good", quantity: 2, lineTotal: "9.00" },
        { itemName: "", quantity: 1 },
        { quantity: 1, lineTotal: "1.00" },
        { itemName: "NoQty", quantity: 1.5 },
        null, "x", 7,
      ] },
      rejectionReason: REASON,
    });

    expect(s?.items).toEqual([{ name: "Good", quantity: 2, lineTotal: "9.00" }]);
  });

  it("returns null only when there is no identity to show", () => {
    for (const record of [null, undefined, 42, "x", {}, { saleRequestId: "s" }, { queueRecordId: "q" }]) {
      expect(summarizeBlockedSale({ record, receipt: RECEIPT, rejectionReason: REASON })).toBeNull();
    }
  });

  it("exposes no field that could carry a reassigned register or a new sale", () => {
    // Control Room forbids register reassignment and replacement transactions.
    // The shape itself is the guarantee.
    const keys = Object.keys(summary()).sort();

    expect(keys).toEqual([
      "claimedEmployeeSessionId", "claimedRegisterSessionId", "items", "occurredAt",
      "paymentMethod", "queueRecordId", "recordedAsCashPayment", "rejectionCode",
      "rejectionReason", "saleRequestId", "totalFixed",
    ]);
    for (const banned of ["newSaleRequestId", "replacementId", "assignedRegisterSessionId", "synced", "resolvedRegisterSessionId"]) {
      expect(keys).not.toContain(banned);
    }
  });

  it("never throws on a hostile record or receipt", () => {
    for (const value of [NaN, Symbol("s"), () => {}, [[]], new Map()]) {
      expect(() => summarizeBlockedSale({
        record: value, receipt: value, rejectionReason: REASON,
      })).not.toThrow();
    }
  });
});

describe("the decision the reviewer records", () => {
  const AT = "2026-10-12T09:00:00.000Z";

  it("records who, when, what and against which original sale", () => {
    const result = buildBlockedSaleAcknowledgement({
      action: "acknowledged",
      summary: summary(),
      reviewer: decideBlockedSaleReviewer(MANAGER),
      atIso: AT,
      note: "  Counted into the morning float.  ",
    });

    expect(result).toEqual({
      ok: true,
      acknowledgement: {
        action: "acknowledged",
        saleRequestId: "sale-req-1",
        byEmployeeId: "e2",
        byDisplayName: "Mira",
        byRole: "manager",
        atIso: AT,
        claimedRegisterSessionId: "reg-yesterday",
        recordedAsCashPayment: true,
        note: "Counted into the morning float.",
      },
    });
  });

  it("supports escalation, which is NOT a resolution", () => {
    const escalated = buildBlockedSaleAcknowledgement({
      action: "escalated", summary: summary(),
      reviewer: decideBlockedSaleReviewer(OWNER), atIso: AT,
    });

    expect(escalated).toMatchObject({ ok: true });
    if (!escalated.ok) return;
    expect(escalated.acknowledgement.action).toBe("escalated");
  });

  it("has no outcome meaning the sale was recorded", () => {
    for (const action of ["synced", "recorded", "resolved", "completed", "reassigned", "deleted"]) {
      expect(buildBlockedSaleAcknowledgement({
        action, summary: summary(), reviewer: decideBlockedSaleReviewer(OWNER), atIso: AT,
      })).toEqual({
        ok: false,
        refusal: "unknown_action",
        message: BLOCKED_SALE_ACK_REFUSALS.unknown_action,
      });
    }
  });

  it("REFUSES to record an unattributable decision", () => {
    // An audit entry that cannot say who is worse than none: it looks like
    // accountability and is not.
    for (const reviewer of [
      decideBlockedSaleReviewer(CASHIER),
      decideBlockedSaleReviewer(null),
      undefined as never,
      null as never,
    ]) {
      expect(buildBlockedSaleAcknowledgement({
        action: "acknowledged", summary: summary(), reviewer, atIso: AT,
      })).toMatchObject({ ok: false, refusal: "reviewer_not_permitted" });
    }
  });

  it("refuses a malformed or absent time rather than inventing one", () => {
    // This is the only timestamp the entry will ever have; no server corrects it.
    for (const atIso of [
      undefined, null, "", "yesterday", "2026-10-12", 1760000000000,
      // Right shape, impossible calendar -- a pattern alone accepts these, and
      // an earlier version of the module did. Hence the Date round trip.
      "2026-99-12T09:00:00.000Z", "2026-10-99T09:00:00.000Z", "2026-02-30T09:00:00.000Z",
      // Right instant, non-canonical spelling.
      "2026-10-12T09:00:00Z", "2026-10-12T05:00:00.000-04:00", " 2026-10-12T09:00:00.000Z",
    ]) {
      expect(buildBlockedSaleAcknowledgement({
        action: "acknowledged", summary: summary(),
        reviewer: decideBlockedSaleReviewer(OWNER), atIso,
      })).toMatchObject({ ok: false, refusal: "invalid_time" });
    }
  });

  it("refuses when there is no readable sale", () => {
    expect(buildBlockedSaleAcknowledgement({
      action: "acknowledged", summary: null,
      reviewer: decideBlockedSaleReviewer(OWNER), atIso: AT,
    })).toMatchObject({ ok: false, refusal: "unreadable_sale" });
  });

  it("carries the claim and the cash flag into the record so they cannot drift", () => {
    const card = buildBlockedSaleAcknowledgement({
      action: "acknowledged",
      summary: summary({ paymentMethod: "card" as const, registerSessionId: "" }),
      reviewer: decideBlockedSaleReviewer(OWNER), atIso: AT,
    });

    expect(card).toMatchObject({ ok: true });
    if (!card.ok) return;
    expect(card.acknowledgement.recordedAsCashPayment).toBe(false);
    expect(card.acknowledgement.claimedRegisterSessionId).toBeNull();
  });

  it("bounds a note and normalises an empty one to null", () => {
    const long = buildBlockedSaleAcknowledgement({
      action: "acknowledged", summary: summary(),
      reviewer: decideBlockedSaleReviewer(OWNER), atIso: AT, note: "x".repeat(900),
    });

    expect(long).toMatchObject({ ok: true });
    if (!long.ok) return;
    expect(long.acknowledgement.note).toHaveLength(500);

    for (const note of ["", "   ", undefined, null, 42, {}]) {
      const r = buildBlockedSaleAcknowledgement({
        action: "acknowledged", summary: summary(),
        reviewer: decideBlockedSaleReviewer(OWNER), atIso: AT, note,
      });

      expect(r).toMatchObject({ ok: true });
      if (!r.ok) continue;
      expect(r.acknowledgement.note).toBeNull();
    }
  });

  it("never throws, and never returns ok for input it could not read", () => {
    for (const value of [NaN, Symbol("s"), () => {}, [[]], new Map(), true]) {
      const call = () => buildBlockedSaleAcknowledgement({
        action: value, summary: value as never, reviewer: value as never,
        atIso: value, note: value,
      });

      expect(call).not.toThrow();
      expect(call().ok).toBe(false);
    }
  });

  it("every refusal has words an operator can act on", () => {
    for (const message of Object.values(BLOCKED_SALE_ACK_REFUSALS)) {
      expect(message.length).toBeGreaterThan(10);
      expect(message.endsWith(".")).toBe(true);
      expect(message).not.toMatch(/undefined|null|NaN/);
    }
    expect(Object.isFrozen(BLOCKED_SALE_ACK_REFUSALS)).toBe(true);
    expect(Object.isFrozen(BLOCKED_SALE_REVIEW_REFUSALS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The durable trail on the queue record
// ---------------------------------------------------------------------------

describe("the durable review trail", () => {
  const ENTRY = {
    action: "acknowledged" as const,
    saleRequestId: "sale-req-1",
    byEmployeeId: "e2",
    byDisplayName: "Mira",
    byRole: "manager",
    atIso: "2026-10-12T09:00:00.000Z",
    claimedRegisterSessionId: "77777777-7777-4777-8777-777777777777",
    recordedAsCashPayment: true,
    note: null,
  };

  // The same shape lib/saleQueue.test.ts uses, so this fixture is held to the
  // real parser's bar -- including UUID-shaped identifiers.
  function record(overrides: Record<string, unknown> = {}) {
    const parsed = readQueuedSale({
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
      state: "needs_attention",
      queuedAt: "2026-08-19T11:00:05.000Z",
      updatedAt: "2026-08-19T11:00:05.000Z",
      attemptCount: 1,
      lastAttemptAt: "2026-08-19T11:30:00.000Z",
      nextAttemptAt: null,
      lastErrorCode: "register_unverified",
      lastErrorMessage: "A register session is required for an offline sale",
      serverOrderId: null,
      serverOrderNumber: null,
      serverCreatedAt: null,
      employeePosSessionId: "66666666-6666-4666-8666-666666666666",
      registerSessionId: "77777777-7777-4777-8777-777777777777",
      ...overrides,
    });

    if (!parsed.ok) throw new Error(`fixture unreadable: ${parsed.reason}`);

    return parsed.record;
  }

  it("a record written before this feature reads back with an empty trail", () => {
    // Absent means "nobody has reviewed it", which is the truth.
    expect(record().blockedSaleReviews).toEqual([]);
  });

  it("appends without touching anything else on the record", () => {
    const before = record();
    const appended = appendBlockedSaleReview(before, ENTRY);

    expect(appended.ok).toBe(true);
    if (!appended.ok) return;

    const after = appended.record;

    expect(after.blockedSaleReviews).toEqual([ENTRY]);

    // THE SALE IS UNCHANGED. Identity, money, claim, state and error code all
    // survive: acknowledging is not resolving.
    for (const key of [
      "saleRequestId", "queueRecordId", "state", "paymentMethod", "occurredAt",
      "registerSessionId", "employeePosSessionId", "lastErrorCode", "attemptCount",
    ] as const) {
      expect(after[key]).toEqual(before[key]);
    }
    expect(after.items).toEqual(before.items);
  });

  it("never mutates the record it was given", () => {
    const before = record();

    appendBlockedSaleReview(before, ENTRY);
    expect(before.blockedSaleReviews).toEqual([]);
  });

  it("is append-only: a second decision does not replace the first", () => {
    const escalated = { ...ENTRY, action: "escalated" as const, byDisplayName: "Olive" };
    const first = appendBlockedSaleReview(record(), ENTRY);

    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = appendBlockedSaleReview(first.record, escalated);

    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.record.blockedSaleReviews).toEqual([ENTRY, escalated]);
  });

  it("REFUSES at the limit instead of silently losing the newest decision", () => {
    // THE CORRECTED DEFECT. The first version dropped the NEWEST entry at the
    // cap and still returned a record, so the caller reported a save that had
    // not happened. Now the append refuses and the caller must surface it.
    let current = record();

    for (let i = 0; i < BLOCKED_SALE_REVIEW_TRAIL_LIMIT; i += 1) {
      const step = appendBlockedSaleReview(current, { ...ENTRY, byEmployeeId: `e${i}` });

      expect(step.ok).toBe(true);
      if (!step.ok) return;
      current = step.record;
    }

    expect(current.blockedSaleReviews).toHaveLength(BLOCKED_SALE_REVIEW_TRAIL_LIMIT);

    const overflow = appendBlockedSaleReview(current, { ...ENTRY, byEmployeeId: "lost" });

    expect(overflow).toEqual({ ok: false, reason: "history_full" });
  });

  it("preserves every existing record when it refuses", () => {
    // The trail is the evidence. A refusal must not disturb it.
    let current = record();

    for (let i = 0; i < BLOCKED_SALE_REVIEW_TRAIL_LIMIT; i += 1) {
      const step = appendBlockedSaleReview(current, { ...ENTRY, byEmployeeId: `e${i}` });

      if (!step.ok) return;
      current = step.record;
    }

    const snapshot = JSON.stringify(current);

    expect(appendBlockedSaleReview(current, { ...ENTRY, byEmployeeId: "lost" }).ok).toBe(false);
    expect(JSON.stringify(current)).toBe(snapshot);
    expect(current.blockedSaleReviews?.[0].byEmployeeId).toBe("e0");
    expect(current.blockedSaleReviews?.some((e) => e.byEmployeeId === "lost")).toBe(false);
  });

  it("round-trips a stored trail", () => {
    expect(record({ blockedSaleReviews: [ENTRY] }).blockedSaleReviews).toEqual([ENTRY]);
  });

  it("drops a malformed entry without making the record unreadable", () => {
    // The money this record represents has already changed hands. Refusing to
    // load it over a bad review note would be the tail wagging the dog.
    const stored = record({
      blockedSaleReviews: [
        ENTRY,
        { action: "deleted", saleRequestId: "s", byEmployeeId: "e", atIso: "t" },
        { action: "acknowledged", saleRequestId: "", byEmployeeId: "e", atIso: "t" },
        { action: "acknowledged", saleRequestId: "s", byEmployeeId: "", atIso: "t" },
        { action: "acknowledged", saleRequestId: "s", byEmployeeId: "e", atIso: "" },
        null, "x", 7, [],
      ],
    });

    expect(stored.blockedSaleReviews).toEqual([ENTRY]);
    expect(stored.saleRequestId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("treats a non-array trail as empty rather than refusing the record", () => {
    for (const value of ["x", 7, {}, null, true]) {
      const stored = record({ blockedSaleReviews: value });

      expect(stored.blockedSaleReviews).toEqual([]);
      expect(stored.state).toBe("needs_attention");
    }
  });

  it("carries a decision built by the review module straight onto the record", () => {
    const built = buildBlockedSaleAcknowledgement({
      action: "acknowledged",
      summary: summary(),
      reviewer: decideBlockedSaleReviewer(MANAGER),
      atIso: "2026-10-12T09:00:00.000Z",
    });

    expect(built).toMatchObject({ ok: true });
    if (!built.ok) return;

    const after = appendBlockedSaleReview(record(), built.acknowledgement);

    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.record.blockedSaleReviews?.[0]).toEqual(built.acknowledgement);
    expect(record({ blockedSaleReviews: [built.acknowledgement] }).blockedSaleReviews)
      .toEqual([built.acknowledgement]);
  });
});
