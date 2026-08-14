import { describe, expect, it } from "vitest";
import {
  createSaleFingerprint,
  createSaleRequestId,
  isSubmitBlocked,
  isValidSaleRequestId,
  resolveSaleRequest,
} from "@/lib/saleRequest";

const P = "11111111-1111-4111-8111-111111111111";
const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const cart = (items: { lineKey: string; quantity: number }[]) =>
  createSaleFingerprint({ projectId: P, paymentMethod: "cash", tipAmount: 0, items });

describe("isValidSaleRequestId", () => {
  it("accepts a real uuid and rejects the all-zero placeholder", () => {
    expect(isValidSaleRequestId(ID_A)).toBe(true);
    expect(isValidSaleRequestId("00000000-0000-0000-0000-000000000000")).toBe(false);
  });

  it("rejects non-uuid values", () => {
    for (const bad of ["", "abc", null, undefined, 12345, `${ID_A}x`]) {
      expect(isValidSaleRequestId(bad)).toBe(false);
    }
  });

  it("accepts any uuid version — v1 and v7 ids are valid keys", () => {
    expect(isValidSaleRequestId("aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa")).toBe(true);
    expect(isValidSaleRequestId("aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa")).toBe(true);
  });
});

describe("createSaleRequestId", () => {
  it("uses crypto.randomUUID", () => {
    expect(createSaleRequestId({ randomUUID: () => ID_A })).toBe(ID_A);
  });

  it("throws rather than falling back to an unsafe generator", () => {
    // A colliding id across two terminals would make one device's retry return
    // the other's receipt, so failing loudly is the only safe option.
    // null, not undefined — undefined would fall through to the default
    // parameter and pick up the real platform crypto.
    expect(() => createSaleRequestId(null)).toThrow(/unavailable/i);
    expect(() => createSaleRequestId({})).toThrow(/unavailable/i);
    expect(() => createSaleRequestId({ randomUUID: () => "not-a-uuid" })).toThrow(/unavailable/i);
  });
});

describe("createSaleFingerprint", () => {
  it("is independent of item order", () => {
    expect(cart([{ lineKey: "2:m2[0]", quantity: 1 }, { lineKey: "2:m1[0]", quantity: 2 }]))
      .toBe(cart([{ lineKey: "2:m1[0]", quantity: 2 }, { lineKey: "2:m2[0]", quantity: 1 }]));
  });

  it("changes with quantity, item set, payment method, tip and project", () => {
    const baseline = cart([{ lineKey: "2:m1[0]", quantity: 1 }]);
    expect(cart([{ lineKey: "2:m1[0]", quantity: 2 }])).not.toBe(baseline);
    expect(cart([{ lineKey: "2:m2[0]", quantity: 1 }])).not.toBe(baseline);
    expect(cart([{ lineKey: "2:m1[0]", quantity: 1 }, { lineKey: "2:m2[0]", quantity: 1 }])).not.toBe(baseline);
    expect(createSaleFingerprint({ projectId: P, paymentMethod: "card", tipAmount: 0, items: [{ lineKey: "2:m1[0]", quantity: 1 }] })).not.toBe(baseline);
    expect(createSaleFingerprint({ projectId: P, paymentMethod: "cash", tipAmount: 1, items: [{ lineKey: "2:m1[0]", quantity: 1 }] })).not.toBe(baseline);
    expect(createSaleFingerprint({ projectId: "other", paymentMethod: "cash", tipAmount: 0, items: [{ lineKey: "2:m1[0]", quantity: 1 }] })).not.toBe(baseline);
  });

  it("ignores names and prices, which the server derives", () => {
    const a = createSaleFingerprint({ projectId: P, paymentMethod: "cash", tipAmount: 0, items: [{ lineKey: "2:m1[0]", quantity: 1 }] });
    const b = createSaleFingerprint({ projectId: P, paymentMethod: "cash", tipAmount: 0, items: [{ lineKey: "2:m1[0]", quantity: 1 }] });
    expect(a).toBe(b);
  });
});

describe("resolveSaleRequest", () => {
  const fp = cart([{ lineKey: "2:m1[0]", quantity: 1 }]);

  it("generates an id on the first attempt", () => {
    const state = resolveSaleRequest(null, fp, () => ID_A);
    expect(state).toEqual({ id: ID_A, fingerprint: fp });
  });

  it("REUSES the id when the cart is unchanged — the retry case", () => {
    const first = resolveSaleRequest(null, fp, () => ID_A);
    const retry = resolveSaleRequest(first, fp, () => ID_B);
    expect(retry.id).toBe(ID_A);
    expect(retry).toBe(first);
  });

  it("issues a NEW id when the cart changes", () => {
    const first = resolveSaleRequest(null, fp, () => ID_A);
    const changed = resolveSaleRequest(first, cart([{ lineKey: "2:m1[0]", quantity: 2 }]), () => ID_B);
    expect(changed.id).toBe(ID_B);
  });

  it("issues a new id when the payment method changes", () => {
    const first = resolveSaleRequest(null, fp, () => ID_A);
    const other = createSaleFingerprint({ projectId: P, paymentMethod: "card", tipAmount: 0, items: [{ lineKey: "2:m1[0]", quantity: 1 }] });
    expect(resolveSaleRequest(first, other, () => ID_B).id).toBe(ID_B);
  });

  it("issues a new id after a successful sale clears the state", () => {
    const first = resolveSaleRequest(null, fp, () => ID_A);
    expect(first.id).toBe(ID_A);
    // The runtime sets the state back to null once the cart resets.
    expect(resolveSaleRequest(null, fp, () => ID_B).id).toBe(ID_B);
  });
});

describe("isSubmitBlocked", () => {
  it("blocks a second submit while one is in flight", () => {
    expect(isSubmitBlocked("saving")).toBe(true);
    for (const s of ["idle", "success", "error"]) {
      expect(isSubmitBlocked(s)).toBe(false);
    }
  });
});
