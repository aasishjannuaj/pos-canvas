import { describe, expect, it } from "vitest";

import {
  REASON_TEXT,
  compareFacts,
  decisionEffect,
  formatStockLevel,
  heldFacts,
  parseHoldDetail,
  parseHoldList,
  reasonText,
  stockPreviewText,
} from "@/lib/saleHolds";

const summary = {
  holdId: "h1", saleRequestId: "s1", reason: "after_revocation", state: "held", receivedAt: "2026-10-24T10:00:00Z",
  decidedAt: null, pairedDeviceId: "d1", deviceName: "Front till", employeeId: "e1", employeeName: "Amy",
  total: "3.85", paymentMethod: "cash", occurredAt: "2026-10-24T09:00:00.000000Z", orderId: null,
};

describe("saleHolds", () => {
  it("every server hold reason has plain words; unknown codes fall back to the code", () => {
    for (const r of ["after_revocation", "after_unpair", "identity_conflict", "not_this_device", "identity_version_mismatch",
      "build_not_pinned_by_device", "price_mismatch", "time_out_of_bounds", "attribution_after_removal_delivered",
      "attribution_invalid", "unconfirmed_attempt"]) {
      expect(REASON_TEXT[r]).toMatch(/\w+ \w+/);
    }
    expect(reasonText("identity_conflict")).toBe("A different sale already uses this reference");
    expect(reasonText("future_reason")).toBe("future_reason");
  });

  it("parses the list and refuses malformed answers", () => {
    const list = parseHoldList({ enabled: true, counts: { held: 1 }, holds: [summary] });
    expect(list?.counts).toEqual({ held: 1, accepted: 0, declined: 0 });
    expect(list?.holds[0].employeeName).toBe("Amy");
    expect(parseHoldList({ enabled: true, holds: [{ ...summary, state: "weird" }] })).toBeNull();
    expect(parseHoldList({ holds: [] })).toBeNull();
  });

  it("parses a conflict detail and finds the differing fields", () => {
    const payload = { occurredAt: "2026-10-24T09:00:00Z", employeeId: "e2", paymentMethod: "cash", total: "3.85",
      lines: [{ itemId: "cola", quantity: 2, unitPrice: "1.75", lineTotal: "3.50" }] };
    const detail = parseHoldDetail({
      ...summary, reason: "identity_conflict", payload, detail: {}, validDecisions: ["record_as_separate", "decline", "bogus"],
      decisions: [], stockPreview: [{ itemId: "cola", itemName: "Synthetic Cola", before: 1, after: 0, shortfall: 1 }],
      conflict: { kind: "order", order: { occurredAt: "2026-10-24T09:00:00Z", paymentMethod: "cash", total: "3.85",
        attribution: { employeeId: "e1" }, items: [{ itemId: "cola", quantity: 2, unitPrice: "1.75", lineTotal: "3.50" }] } },
    });
    expect(detail?.validDecisions).toEqual(["record_as_separate", "decline"]);
    expect(compareFacts(heldFacts(payload), detail!.conflict!.facts)).toEqual(["employeeId"]);
  });

  it("the same instant spelled with microseconds or whole seconds is not a difference (found by WEB-2 run2)", () => {
    const a = { occurredAt: "2026-10-24T09:00:00.000000Z", employeeId: "e1", paymentMethod: "cash", total: "1.00", lines: [] };
    expect(compareFacts(a, { ...a, occurredAt: "2026-10-24T09:00:00Z" })).toEqual([]);
    expect(compareFacts(a, { ...a, occurredAt: "2026-10-24T09:00:01Z" })).toEqual(["occurredAt"]);
  });

  it("decision effects name what happens; stock wording never hides a shortfall", () => {
    expect(decisionEffect("decline", "3.85")).toMatch(/Does not record this \$3.85 sale\. Stock is not changed/);
    expect(decisionEffect("record_as_separate", null)).toMatch(/existing sale is not changed/);
    expect(stockPreviewText({ itemId: "cola", itemName: "Synthetic Cola", before: 1, after: 0, shortfall: 1 }))
      .toBe("Accepting will reduce Synthetic Cola from 1 to 0 (1 short)");
  });

  it("WEB-6: a negative level renders as oversold", () => {
    expect(formatStockLevel(-2)).toBe("−2 (oversold)");
    expect(formatStockLevel(0)).toBe("0");
    expect(formatStockLevel(5)).toBe("5");
  });
});
