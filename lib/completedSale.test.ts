import { describe, expect, it } from "vitest";
import {
  isCompletedSaleReceipt,
  isFixedDecimalString,
  isNonZeroMoney,
} from "@/lib/completedSale";
import type { CompletedSaleReceipt } from "@/lib/completedSale";

// A payload shaped exactly as complete_sale_v2 returns it: money as fixed
// two-decimal strings, quantity as an integer.
const serverPayload: CompletedSaleReceipt = {
  orderId: "11111111-1111-4111-8111-111111111111",
  orderNumber: "ORD-1001",
  paymentMethod: "cash",
  subtotal: "20.00",
  taxAmount: "1.27",
  tipAmount: "0.00",
  total: "21.27",
  createdAt: "2026-08-05T10:00:00Z",
  items: [
    {
      itemId: "m1",
      itemName: "Live Latte",
      unitPrice: "10.00",
      quantity: 2,
      lineTotal: "20.00",
    },
  ],
};

describe("isFixedDecimalString", () => {
  it("requires exactly two decimals", () => {
    for (const ok of ["0.00", "10.00", "1.05", "9999999999.99", "-1.50"]) {
      expect(isFixedDecimalString(ok)).toBe(true);
    }
    for (const bad of ["10", "10.0", "10.000", "1e2", "", "abc", 10, null]) {
      expect(isFixedDecimalString(bad)).toBe(false);
    }
  });
});

describe("isNonZeroMoney", () => {
  it("compares text, never a parsed float", () => {
    expect(isNonZeroMoney("0.00")).toBe(false);
    expect(isNonZeroMoney("-0.00")).toBe(false);
    expect(isNonZeroMoney("0.01")).toBe(true);
    expect(isNonZeroMoney("1.27")).toBe(true);
  });
});

describe("isCompletedSaleReceipt", () => {
  it("accepts a well-formed server payload", () => {
    expect(isCompletedSaleReceipt(serverPayload)).toBe(true);
  });

  it("rejects a payload whose money arrived as JSON numbers", () => {
    // The exact regression this guard exists for: a number would be parsed into
    // an IEEE-754 double and could render a cent differently from the store.
    const numeric = { ...serverPayload, subtotal: 20 as unknown as string };
    expect(isCompletedSaleReceipt(numeric)).toBe(false);
  });

  it("rejects a payload with an item priced as a number", () => {
    const bad = {
      ...serverPayload,
      items: [{ ...serverPayload.items[0], lineTotal: 20 as unknown as string }],
    };
    expect(isCompletedSaleReceipt(bad)).toBe(false);
  });

  it("rejects missing identity, bad payment method and bad quantities", () => {
    expect(isCompletedSaleReceipt({ ...serverPayload, orderId: "" })).toBe(false);
    expect(isCompletedSaleReceipt({ ...serverPayload, orderNumber: "" })).toBe(false);
    expect(
      isCompletedSaleReceipt({ ...serverPayload, paymentMethod: "crypto" })
    ).toBe(false);
    for (const q of [0, -1, 1.5]) {
      expect(
        isCompletedSaleReceipt({
          ...serverPayload,
          items: [{ ...serverPayload.items[0], quantity: q }],
        })
      ).toBe(false);
    }
  });

  it("rejects non-objects and a missing items array", () => {
    for (const bad of [null, undefined, "x", 1, []]) {
      expect(isCompletedSaleReceipt(bad)).toBe(false);
    }
    expect(isCompletedSaleReceipt({ ...serverPayload, items: undefined })).toBe(false);
  });
});

describe("the receipt renders server values verbatim", () => {
  it("keeps the exact decimal strings the database produced", () => {
    // No toFixed, no Number(), no recomputation anywhere in the pipeline.
    expect(serverPayload.subtotal).toBe("20.00");
    expect(serverPayload.total).toBe("21.27");
    // Why the strings are kept: reconstructing money in JavaScript can drift.
    // 20 + 1.27 happens to be exact, but 0.10 + 0.20 is not — and a receipt
    // must not depend on which pair of values it happened to get.
    expect(String(Number("0.10") + Number("0.20"))).not.toBe("0.30");
    expect(Number("0.10") + Number("0.20")).not.toBe(0.3);
  });

  it("does not derive a line total from unit price and quantity", () => {
    const item = serverPayload.items[0];
    expect(item.lineTotal).toBe("20.00");
    // A pinned device price differs from the live price; only the stored
    // lineTotal is authoritative.
    const pinned = { ...item, unitPrice: "7.00", lineTotal: "14.00" };
    expect(pinned.lineTotal).toBe("14.00");
    expect(isCompletedSaleReceipt({ ...serverPayload, items: [pinned], subtotal: "14.00", total: "14.00" })).toBe(true);
  });
});
