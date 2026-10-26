// G-1-CLIENT-1 — the pure recovery rules: response validation against the
// accepted server contract, the decision table, and transfer verification.
//
// Every server answer used here is shaped exactly as
// supabase/migrations/20261015120000_sale_recovery_attribution.sql builds it
// (jsonb_build_object keys and value types). The REAL database answers are fed
// through these same parsers in
// supabase/migrations/20261015120000_sale_recovery_client_contract.db.test.ts.
import { describe, expect, it } from "vitest";
import {
  decideAfterLookup,
  decideOfflineRecovery,
  describeRecordedSale,
  isMissingRecoveryFunction,
  parseSaleLookupAnswer,
  parseSaleRecoveryAnswer,
  strictClaimsFromMarker,
  verifyQueueTransfer,
} from "@/lib/saleRecovery";
import type { CurrentOperator, LookupOrderSummary } from "@/lib/saleRecovery";
import {
  SALE_QUEUE_SCHEMA_VERSION,
  SALE_REQUEST_PAYLOAD_VERSION,
  STRICT_RECOVERY_PAYLOAD_VERSION,
} from "@/lib/saleQueue";
import type { QueuedSale } from "@/lib/saleQueue";
import { UNCERTAIN_SALE_SCHEMA_VERSION } from "@/lib/uncertainSaleRecord";
import type { PersistedUncertainSale } from "@/lib/uncertainSaleRecord";

const SALE = "9e9e0000-0000-4000-8000-00000000009e";
const AMY = "e0000000-0000-4000-8000-0000000000a1";
const BEN = "e0000000-0000-4000-8000-0000000000b2";
const AMY_SESSION = "5e550000-0000-4000-8000-0000000000a1";
const BEN_SESSION = "5e550000-0000-4000-8000-0000000000b2";
const YESTERDAY_REGISTER = "f0000000-0000-4000-8000-0000000000f1";
const TODAY_REGISTER = "f0000000-0000-4000-8000-0000000000f2";
const ATTEMPTED = "2026-10-14T15:00:00.000Z";

const IDENTITY = {
  deviceAuthUserId: "11111111-1111-4111-8111-111111111111",
  deviceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  buildJobId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};

const ITEMS = [
  { itemId: "item-1", quantity: 2, modifiers: [{ groupId: "g1", optionIds: ["o2", "o1"] }] },
  { itemId: "item-2", quantity: 1, modifiers: [] },
];

function marker(overrides: Partial<PersistedUncertainSale> = {}): PersistedUncertainSale {
  return {
    schemaVersion: UNCERTAIN_SALE_SCHEMA_VERSION,
    saleRequestId: SALE,
    ...IDENTITY,
    paymentMethod: "card",
    tipAmount: 0,
    items: ITEMS,
    fingerprint: "fp-1",
    dispatchedAt: ATTEMPTED,
    originalAttribution: {
      employeeId: AMY,
      employeePosSessionId: AMY_SESSION,
      registerSessionId: YESTERDAY_REGISTER,
      attemptedAt: ATTEMPTED,
    },
    ...overrides,
  };
}

const legacy = () => marker({ originalAttribution: null });

const ORDER = {
  orderId: "0d000000-0000-4000-8000-000000000001",
  orderNumber: "1001",
  total: "12.34",
  paymentMethod: "card",
  createdAt: "2026-10-14T15:00:03Z",
  occurredAt: null,
  source: "online",
  employeeId: AMY,
  registerSessionId: YESTERDAY_REGISTER,
};

const RECEIPT = {
  orderId: ORDER.orderId,
  orderNumber: "1001",
  paymentMethod: "card",
  subtotal: "11.00",
  taxAmount: "1.34",
  tipAmount: "0.00",
  total: "12.34",
  createdAt: "2026-10-14T15:00:03.000Z",
  items: [
    { itemId: "item-1", itemName: "Thing", unitPrice: "5.00", quantity: 2, lineTotal: "10.00" },
  ],
};

const AMY_NOW_YESTERDAY: CurrentOperator = {
  employeeId: AMY,
  employeePosSessionId: AMY_SESSION,
  registerSessionId: YESTERDAY_REGISTER,
};

function queued(overrides: Partial<QueuedSale> = {}): QueuedSale {
  return {
    queueSchemaVersion: SALE_QUEUE_SCHEMA_VERSION,
    requestPayloadVersion: STRICT_RECOVERY_PAYLOAD_VERSION,
    queueRecordId: "q-1",
    saleRequestId: SALE,
    ...IDENTITY,
    paymentMethod: "card",
    tipAmount: 0,
    // Same lines, different order and option order: canonically identical.
    items: [ITEMS[1], { ...ITEMS[0], modifiers: [{ groupId: "g1", optionIds: ["o1", "o2"] }] }],
    occurredAt: ATTEMPTED,
    source: "offline_queued",
    state: "pending",
    queuedAt: "2026-10-15T09:00:00.000Z",
    updatedAt: "2026-10-15T09:00:00.000Z",
    attemptCount: 0,
    lastAttemptAt: null,
    nextAttemptAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    serverOrderId: null,
    serverOrderNumber: null,
    serverCreatedAt: null,
    employeePosSessionId: AMY_SESSION,
    registerSessionId: YESTERDAY_REGISTER,
    strictRecovery: {
      originalEmployeeId: AMY,
      originalEmployeePosSessionId: AMY_SESSION,
      originalRegisterSessionId: YESTERDAY_REGISTER,
      originalAttemptAt: ATTEMPTED,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe("lookup answers are validated against the accepted contract", () => {
  it("reads the three bare statuses", () => {
    expect(parseSaleLookupAnswer({ status: "not_found" })).toEqual({ status: "not_found" });
    expect(parseSaleLookupAnswer({ status: "not_this_device" })).toEqual({ status: "not_this_device" });
    expect(parseSaleLookupAnswer({ status: "payload_mismatch" })).toEqual({ status: "payload_mismatch" });
  });

  it("refuses any disclosure beside not_this_device / payload_mismatch", () => {
    for (const status of ["not_this_device", "payload_mismatch", "not_found"]) {
      expect(parseSaleLookupAnswer({ status, orderId: ORDER.orderId })).toEqual({ status: "malformed" });
    }
  });

  it("reads a match with every field, exactly as sent", () => {
    for (const attribution of ["verified", "conflict", "unverified", "claims_unverifiable"]) {
      const answer = parseSaleLookupAnswer({ status: "match", attribution, order: ORDER });

      expect(answer).toEqual({ status: "match", attribution, order: ORDER });
    }
  });

  it("refuses a match whose order is incomplete or mistyped", () => {
    const broken: Record<string, unknown>[] = [
      { ...ORDER, orderId: "" },
      { ...ORDER, orderNumber: 1001 },
      { ...ORDER, total: 12.34 },
      { ...ORDER, total: "12.3" },
      { ...ORDER, paymentMethod: "cheque" },
      { ...ORDER, createdAt: "yesterday" },
      { ...ORDER, occurredAt: "later" },
      { ...ORDER, source: "" },
      { ...ORDER, employeeId: 7 },
      { ...ORDER, registerSessionId: "" },
    ];

    for (const order of broken) {
      expect(parseSaleLookupAnswer({ status: "match", attribution: "verified", order })).toEqual({
        status: "malformed",
      });
    }

    expect(parseSaleLookupAnswer({ status: "match", attribution: "maybe", order: ORDER })).toEqual({
      status: "malformed",
    });
    expect(parseSaleLookupAnswer({ status: "match", attribution: "verified" })).toEqual({ status: "malformed" });
  });

  it("refuses anything that is not an object or has an unknown status", () => {
    for (const value of [null, undefined, "not_found", 42, [], { status: "found" }, {}]) {
      expect(parseSaleLookupAnswer(value)).toEqual({ status: "malformed" });
    }
  });
});

describe("strict-recovery answers are validated against the accepted contract", () => {
  it("accepts created / replayed ONLY with a valid receipt", () => {
    expect(parseSaleRecoveryAnswer({ status: "created", receipt: RECEIPT })).toEqual({
      status: "created",
      receipt: RECEIPT,
    });
    expect(parseSaleRecoveryAnswer({ status: "replayed", receipt: RECEIPT })).toEqual({
      status: "replayed",
      receipt: RECEIPT,
    });
    expect(parseSaleRecoveryAnswer({ status: "created" })).toEqual({ status: "malformed" });
    expect(parseSaleRecoveryAnswer({ status: "replayed", receipt: { ...RECEIPT, total: 12 } })).toEqual({
      status: "malformed",
    });
  });

  it("reads an attribution conflict as a conflict and never as a success", () => {
    const answer = parseSaleRecoveryAnswer({
      status: "attribution_conflict",
      orderId: ORDER.orderId,
      orderNumber: "1001",
      stored: { employeeId: BEN, registerSessionId: TODAY_REGISTER, pairedDeviceId: IDENTITY.deviceId },
      expected: { employeeId: AMY, registerSessionId: YESTERDAY_REGISTER, pairedDeviceId: IDENTITY.deviceId },
    });

    expect(answer).toEqual({ status: "attribution_conflict", orderId: ORDER.orderId, orderNumber: "1001" });
    expect(parseSaleRecoveryAnswer({ status: "attribution_conflict", orderNumber: "1001" })).toEqual({
      status: "malformed",
    });
  });

  it("reads a bare not_this_device, and refuses one that discloses anything", () => {
    expect(parseSaleRecoveryAnswer({ status: "not_this_device" })).toEqual({ status: "not_this_device" });
    expect(parseSaleRecoveryAnswer({ status: "not_this_device", orderNumber: "1" })).toEqual({
      status: "malformed",
    });
  });

  it("refuses unknown shapes", () => {
    for (const value of [null, "created", { status: "ok" }, { receipt: RECEIPT }]) {
      expect(parseSaleRecoveryAnswer(value)).toEqual({ status: "malformed" });
    }
  });

  it("recognises PostgREST's missing-function code and nothing else", () => {
    expect(isMissingRecoveryFunction({ code: "PGRST202", message: "Could not find the function" })).toBe(true);
    expect(isMissingRecoveryFunction({ code: "P0001", message: "Could not find the function" })).toBe(false);
    expect(isMissingRecoveryFunction({ code: "42883" })).toBe(false);
    expect(isMissingRecoveryFunction(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("the decision table", () => {
  const match = (attribution: string, order: Record<string, unknown> = ORDER) =>
    parseSaleLookupAnswer({ status: "match", attribution, order });

  it("offline: an attributed marker goes to the strict queue; a legacy one stays protected", () => {
    expect(decideOfflineRecovery(marker())).toEqual({ step: "queue_strict" });
    expect(decideOfflineRecovery(legacy())).toEqual({ step: "protected", reason: "legacy_unresolvable" });
  });

  it("a verified match resolves the marker; conflict and unverifiable claims stay protected", () => {
    expect(decideAfterLookup(marker(), match("verified"), null)).toEqual({
      step: "resolve_recorded",
      order: ORDER as LookupOrderSummary,
    });
    expect(decideAfterLookup(marker(), match("conflict"), AMY_NOW_YESTERDAY)).toEqual({
      step: "protected",
      reason: "attribution_conflict",
    });
    expect(decideAfterLookup(marker(), match("claims_unverifiable"), AMY_NOW_YESTERDAY)).toEqual({
      step: "protected",
      reason: "claims_unverifiable",
    });
    // Claims WERE sent, so "unverified" is not the contract.
    expect(decideAfterLookup(marker(), match("unverified"), AMY_NOW_YESTERDAY)).toEqual({
      step: "protected",
      reason: "malformed_response",
    });
  });

  it("LEGACY CLEARANCE: only a match whose attribution is 'unverified' (no claims were sent)", () => {
    expect(decideAfterLookup(legacy(), match("unverified"), null)).toEqual({
      step: "resolve_recorded",
      order: ORDER as LookupOrderSummary,
    });

    for (const attribution of ["verified", "conflict", "claims_unverifiable"]) {
      expect(decideAfterLookup(legacy(), match(attribution), null)).toEqual({
        step: "protected",
        reason: "malformed_response",
      });
    }

    // Every non-match keeps a legacy marker protected — including not_found.
    expect(decideAfterLookup(legacy(), { status: "not_found" }, AMY_NOW_YESTERDAY)).toEqual({
      step: "protected",
      reason: "legacy_unresolvable",
    });
    expect(decideAfterLookup(legacy(), { status: "not_this_device" }, null).step).toBe("protected");
    expect(decideAfterLookup(legacy(), { status: "payload_mismatch" }, null).step).toBe("protected");
    expect(decideAfterLookup(legacy(), { status: "malformed" }, null).step).toBe("protected");
  });

  it("a match whose payment method differs from the marker is not this sale", () => {
    expect(
      decideAfterLookup(marker(), match("verified", { ...ORDER, paymentMethod: "cash" }), null)
    ).toEqual({ step: "protected", reason: "malformed_response" });
  });

  it("not_found: online strict ONLY for the original employee on the original register", () => {
    expect(decideAfterLookup(marker(), { status: "not_found" }, AMY_NOW_YESTERDAY)).toEqual({
      step: "online_strict",
    });

    // Employee change.
    expect(
      decideAfterLookup(marker(), { status: "not_found" }, {
        employeeId: BEN,
        employeePosSessionId: BEN_SESSION,
        registerSessionId: YESTERDAY_REGISTER,
      })
    ).toEqual({ step: "queue_strict" });

    // Register rollover, same employee (a NEW session today).
    expect(
      decideAfterLookup(marker(), { status: "not_found" }, {
        employeeId: AMY,
        employeePosSessionId: "5e550000-0000-4000-8000-0000000000a9",
        registerSessionId: TODAY_REGISTER,
      })
    ).toEqual({ step: "queue_strict" });

    // Nobody established.
    expect(decideAfterLookup(marker(), { status: "not_found" }, null)).toEqual({ step: "queue_strict" });
  });

  it("not_this_device, payload_mismatch and malformed stay protected", () => {
    expect(decideAfterLookup(marker(), { status: "not_this_device" }, AMY_NOW_YESTERDAY)).toEqual({
      step: "protected",
      reason: "not_this_device",
    });
    expect(decideAfterLookup(marker(), { status: "payload_mismatch" }, AMY_NOW_YESTERDAY)).toEqual({
      step: "protected",
      reason: "payload_mismatch",
    });
    expect(decideAfterLookup(marker(), { status: "malformed" }, AMY_NOW_YESTERDAY)).toEqual({
      step: "protected",
      reason: "malformed_response",
    });
  });

  it("the recorded-sale sentence quotes only what the lookup returned", () => {
    const text = describeRecordedSale(ORDER as LookupOrderSummary);

    expect(text).toContain("order 1001");
    expect(text).toContain("12.34");
  });
});

// ---------------------------------------------------------------------------

describe("transfer verification", () => {
  it("accepts the strict record bound to exactly the marker's originals", () => {
    expect(verifyQueueTransfer(marker(), queued())).toEqual({ ok: true });
  });

  it("refuses a record for a different sale", () => {
    expect(verifyQueueTransfer(marker(), queued({ saleRequestId: "9e9e0000-0000-4000-8000-00000000009f" }))).toEqual({
      ok: false,
      reason: "different_sale",
    });
    expect(verifyQueueTransfer(marker(), queued({ paymentMethod: "cash" })).ok).toBe(false);
    expect(verifyQueueTransfer(marker(), queued({ items: [ITEMS[1]] })).ok).toBe(false);
    expect(
      verifyQueueTransfer(marker(), queued({ items: [{ ...ITEMS[0], quantity: 3 }, ITEMS[1]] })).ok
    ).toBe(false);
  });

  it("refuses a record from a different pairing", () => {
    expect(verifyQueueTransfer(marker(), queued({ buildJobId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc0" }))).toEqual({
      ok: false,
      reason: "different_pairing",
    });
  });

  it("refuses an ORDINARY record for an attributed marker — it would sync through v5", () => {
    const ordinary = queued({ requestPayloadVersion: SALE_REQUEST_PAYLOAD_VERSION, strictRecovery: undefined });

    expect(verifyQueueTransfer(marker(), ordinary)).toEqual({ ok: false, reason: "not_strict" });
  });

  it("refuses a strict record bound to different originals", () => {
    const strict = queued().strictRecovery!;

    for (const strictRecovery of [
      { ...strict, originalEmployeeId: BEN },
      { ...strict, originalEmployeePosSessionId: BEN_SESSION },
      { ...strict, originalRegisterSessionId: TODAY_REGISTER },
      { ...strict, originalAttemptAt: "2026-10-15T09:00:00.000Z" },
    ]) {
      expect(verifyQueueTransfer(marker(), queued({ strictRecovery }))).toEqual({
        ok: false,
        reason: "different_originals",
      });
    }

    expect(verifyQueueTransfer(marker(), queued({ occurredAt: "2026-10-15T09:00:00.000Z" }))).toEqual({
      ok: false,
      reason: "different_originals",
    });
  });

  it("a LEGACY marker is carried by a record holding exactly its sale", () => {
    const ordinary = queued({ requestPayloadVersion: SALE_REQUEST_PAYLOAD_VERSION, strictRecovery: undefined });

    expect(verifyQueueTransfer(legacy(), ordinary)).toEqual({ ok: true });
    expect(verifyQueueTransfer(legacy(), { ...ordinary, paymentMethod: "cash" }).ok).toBe(false);
  });

  it("strict claims come from the marker and nowhere else", () => {
    expect(strictClaimsFromMarker(marker())).toEqual({
      originalEmployeeId: AMY,
      originalEmployeePosSessionId: AMY_SESSION,
      originalRegisterSessionId: YESTERDAY_REGISTER,
      originalAttemptAt: ATTEMPTED,
    });
    expect(strictClaimsFromMarker(legacy())).toBeNull();
  });
});
