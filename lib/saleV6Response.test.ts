import { describe, expect, it } from "vitest";

import { classifyV6Response, isAnswerAboutTheSale } from "@/lib/saleV6Response";

const HASH = "a".repeat(64);

describe("classifyV6Response — by structured class, never by wording (K-4)", () => {
  it("booked, replayed and held answers are read from the payload", () => {
    expect(classifyV6Response({ status: "booked", identityHash: HASH, order: { orderId: "o1", orderNumber: "S-1001" } }, null))
      .toEqual({ kind: "booked", identityHash: HASH, order: { orderId: "o1", orderNumber: "S-1001" } });
    expect(classifyV6Response({ status: "replayed", identityHash: HASH, order: { orderId: "o1", orderNumber: "S-1001" } }, null).kind).toBe("replayed");
    expect(classifyV6Response({ status: "held", identityHash: HASH, holdId: "h1", reason: "after_revocation", state: "held" }, null))
      .toEqual({ kind: "held", identityHash: HASH, holdId: "h1", reason: "after_revocation", state: "held" });
  });

  it("LFS01 is about the sale; LFA01 and LFC01 never are, whatever the message says", () => {
    expect(classifyV6Response(null, { code: "LFS01", message: "sale_malformed_identity", hint: "lf_class=sale" }))
      .toEqual({ kind: "sale_rejected", code: "sale_malformed_identity" });
    expect(classifyV6Response(null, { code: "LFA01", message: "Sale request ID was already used for a different order" }))
      .toEqual({ kind: "authorization_failure", code: "Sale request ID was already used for a different order" });
    expect(classifyV6Response(null, { code: "LFC01", message: "local_first_not_enabled" }).kind).toBe("capability_off");
    // Legacy wording with no structured code is NOT treated as a sale rejection.
    expect(classifyV6Response(null, { code: "P0001", message: "Project not found or access denied" }).kind).toBe("retry");
  });

  it("transport failures, missing functions and unreadable answers retry under the same ID (O1)", () => {
    for (const [data, error] of [
      [null, { code: "", message: "TypeError: Failed to fetch" }],
      [null, { code: "PGRST202", message: "Could not find the function" }],
      [null, null],
      [{ status: "booked", identityHash: "short", order: { orderId: "o", orderNumber: "n" } }, null],
      [{ status: "held", identityHash: HASH }, null],
      [{ status: "mystery", identityHash: HASH }, null],
    ] as const) {
      expect(classifyV6Response(data, error as never)).toEqual({ kind: "retry" });
    }
  });

  it("only sale answers may isolate a sale", () => {
    expect(isAnswerAboutTheSale({ kind: "sale_rejected", code: "x" })).toBe(true);
    expect(isAnswerAboutTheSale({ kind: "authorization_failure", code: "x" })).toBe(false);
    expect(isAnswerAboutTheSale({ kind: "capability_off", code: "x" })).toBe(false);
    expect(isAnswerAboutTheSale({ kind: "retry" })).toBe(false);
  });
});
