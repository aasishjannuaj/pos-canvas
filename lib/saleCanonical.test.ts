import { describe, expect, it } from "vitest";
import {
  SALE_CANONICAL_VERSION,
  buildCanonicalSaleRequest,
  computeSaleRequestHash,
  hashCanonicalSaleRequest,
  normalizeSaleItems,
  roundMoneyString,
} from "@/lib/saleCanonical";

const P = "11111111-1111-4111-8111-111111111111";
const Q = "22222222-2222-4222-8222-222222222222";

// Pinned fixtures. complete_sale_v2 computes these inside PostgreSQL; these
// values are what a live cross-check must reproduce.
const FIXTURES = {
  singleItem: "8e0d5d4a2aba27714b7a567ac67174a992a7e65bda981e00e78414b6561e1287",
  twoItems: "69b79f836ec539909246464fd2c5d9921c6c013097b87007c80bf8962c2bcfd7",
  card: "2be7ecc8d9eeb64e33120ea7eb1b47e4122f7511a8889c8d063f5af40969faae",
  tipRounded: "d6aadb26f396c5e95754caa0ca6377b17b432388feacde3b58cb3ab308f1bb8d",
  quantityDiffers: "ec568ac8b095730476c74936a903aa856ca081563ff69de05b1f05949f0bc500",
};

const base = { projectId: P, paymentMethod: "cash" as const, tipAmount: "0" };

describe("roundMoneyString — PostgreSQL round(numeric, 2)", () => {
  it("rounds half away from zero on exact decimals", () => {
    expect(roundMoneyString("2.005")).toBe("2.01");
    expect(roundMoneyString("1.005")).toBe("1.01");
    expect(roundMoneyString("2.675")).toBe("2.68");
    // JavaScript's own double arithmetic disagrees — which is why the input is
    // a decimal string, never a number.
    expect((2.005).toFixed(2)).toBe("2.00");
  });

  it("always emits exactly two decimals", () => {
    expect(roundMoneyString("0")).toBe("0.00");
    expect(roundMoneyString("10")).toBe("10.00");
    expect(roundMoneyString("3.1")).toBe("3.10");
  });

  it("rejects anything that is not a decimal literal", () => {
    for (const bad of ["", "abc", "NaN", "Infinity", "1e5", "1.2.3"]) {
      expect(() => roundMoneyString(bad)).toThrow();
    }
  });
});

describe("normalizeSaleItems", () => {
  it("trims ids and sorts by UTF-8 byte order, matching COLLATE \"C\"", () => {
    const out = normalizeSaleItems([
      { itemId: " m2 ", quantity: 1 },
      { itemId: "m1", quantity: 2 },
      { itemId: "M3", quantity: 3 },
    ]);
    // Uppercase 'M' (0x4D) sorts before lowercase 'm' (0x6D) in byte order.
    expect(out.map((i) => i.itemId)).toEqual(["M3", "m1", "m2"]);
  });

  it("rejects duplicates before anything is hashed", () => {
    expect(() =>
      normalizeSaleItems([
        { itemId: "m1", quantity: 1 },
        { itemId: " m1", quantity: 2 },
      ])
    ).toThrow(/duplicate/i);
  });

  it("rejects empty, zero, negative, fractional and oversized quantities", () => {
    expect(() => normalizeSaleItems([])).toThrow();
    expect(() => normalizeSaleItems([{ itemId: "  ", quantity: 1 }])).toThrow();
    for (const q of [0, -1, 1.5, 10001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => normalizeSaleItems([{ itemId: "m1", quantity: q }])).toThrow();
    }
  });
});

describe("canonical preimage", () => {
  it("has the exact documented shape", () => {
    const canonical = buildCanonicalSaleRequest({
      projectId: P,
      paymentMethod: "cash",
      tipAmount: "0.00",
      items: [{ itemId: "m1", quantity: 2 }],
    });
    expect(canonical).toBe(
      `${SALE_CANONICAL_VERSION}\nproject=${P}\npayment=cash\ntip=0.00\nitems=1\n2:m1=2`
    );
  });

  it("length-prefixes ids so the encoding is injective", () => {
    // Without the octet-length prefix these two carts would share a preimage.
    const a = buildCanonicalSaleRequest({
      projectId: P, paymentMethod: "cash", tipAmount: "0.00",
      items: [{ itemId: "a=1\n3:b", quantity: 2 }],
    });
    const b = buildCanonicalSaleRequest({
      projectId: P, paymentMethod: "cash", tipAmount: "0.00",
      items: [{ itemId: "a", quantity: 1 }, { itemId: "b", quantity: 2 }],
    });
    expect(a).not.toBe(b);
    expect(hashCanonicalSaleRequest(a)).not.toBe(hashCanonicalSaleRequest(b));
  });

  it("uses the byte length, not the character count", () => {
    const canonical = buildCanonicalSaleRequest({
      projectId: P, paymentMethod: "cash", tipAmount: "0.00",
      items: [{ itemId: "café", quantity: 1 }],
    });
    expect(canonical).toContain("5:café=1"); // 5 UTF-8 bytes, 4 characters
  });
});

describe("pinned hash fixtures", () => {
  it("single item, no tip", () => {
    expect(computeSaleRequestHash({ ...base, items: [{ itemId: "m1", quantity: 2 }] }).hash)
      .toBe(FIXTURES.singleItem);
  });

  it("is independent of the order items were submitted in", () => {
    const forward = computeSaleRequestHash({
      ...base, items: [{ itemId: "m1", quantity: 2 }, { itemId: "m2", quantity: 1 }],
    }).hash;
    const reversed = computeSaleRequestHash({
      ...base, items: [{ itemId: "m2", quantity: 1 }, { itemId: "m1", quantity: 2 }],
    }).hash;
    expect(forward).toBe(FIXTURES.twoItems);
    expect(reversed).toBe(FIXTURES.twoItems);
  });

  it("changes when the payment method changes", () => {
    const hash = computeSaleRequestHash({
      ...base, paymentMethod: "card", items: [{ itemId: "m1", quantity: 2 }],
    }).hash;
    expect(hash).toBe(FIXTURES.card);
    expect(hash).not.toBe(FIXTURES.singleItem);
  });

  it("changes when the tip changes, after exact rounding", () => {
    const hash = computeSaleRequestHash({
      ...base, tipAmount: "2.005", items: [{ itemId: "m1", quantity: 2 }],
    }).hash;
    expect(hash).toBe(FIXTURES.tipRounded);
    // 2.005 and 2.01 are the same request once normalized.
    expect(
      computeSaleRequestHash({ ...base, tipAmount: "2.01", items: [{ itemId: "m1", quantity: 2 }] }).hash
    ).toBe(FIXTURES.tipRounded);
  });

  it("changes when a quantity changes", () => {
    expect(computeSaleRequestHash({ ...base, items: [{ itemId: "m1", quantity: 3 }] }).hash)
      .toBe(FIXTURES.quantityDiffers);
  });

  it("changes when the project changes", () => {
    expect(computeSaleRequestHash({ ...base, projectId: Q, items: [{ itemId: "m1", quantity: 2 }] }).hash)
      .not.toBe(FIXTURES.singleItem);
  });

  it("emits a lowercase 64-character hex digest", () => {
    const { hash } = computeSaleRequestHash({ ...base, items: [{ itemId: "m1", quantity: 1 }] });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
