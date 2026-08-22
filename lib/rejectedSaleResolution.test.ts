// Feature 24.5F — the discard policy, exhaustively.
//
// This is the narrowest, most dangerous rule in the offline feature: it is the
// only path by which unresolved financial evidence leaves a device's unresolved
// count. Every refusal below is a sale that must survive someone trying to clear
// a badge, so each one is asserted individually rather than as a table — a
// loop that silently stopped iterating would take the whole safety net with it.

import { describe, expect, it } from "vitest";

import {
  TERMINAL_LOCAL_RESOLUTION_CODES,
  decideRejectedSaleDiscardSafety,
  describeRejectedSaleReason,
  isTerminalLocalResolutionCode,
} from "@/lib/rejectedSaleResolution";
import type { QueuedSale } from "@/lib/saleQueue";

function sale(patch: Partial<QueuedSale> = {}): QueuedSale {
  return {
    state: "needs_attention",
    lastErrorCode: "post_revocation",
    saleRequestId: "11111111-1111-4111-8111-111111111111",
    serverOrderId: null,
    serverOrderNumber: null,
    ...patch,
  } as QueuedSale;
}

const NO_UNCERTAIN = { present: false } as const;

describe("which rejections a person may resolve locally", () => {
  it("allows exactly one code today, and names it", () => {
    expect([...TERMINAL_LOCAL_RESOLUTION_CODES]).toEqual(["post_revocation"]);
    expect(isTerminalLocalResolutionCode("post_revocation")).toBe(true);
    expect(isTerminalLocalResolutionCode(null)).toBe(false);
  });

  it("allows a post-revocation rejection with no order and nothing outstanding", () => {
    expect(
      decideRejectedSaleDiscardSafety({ record: sale(), uncertain: NO_UNCERTAIN })
    ).toEqual({ allowed: true });
  });
});

describe("states that can never be discarded", () => {
  // A pending or syncing row is still the engine's business. Discarding one
  // would race a submission that may be on the wire this instant.
  it("refuses a pending record", () => {
    expect(
      decideRejectedSaleDiscardSafety({
        record: sale({ state: "pending", lastErrorCode: null }),
        uncertain: NO_UNCERTAIN,
      })
    ).toEqual({ allowed: false, reason: "not_needs_attention" });
  });

  it("refuses a syncing record", () => {
    expect(
      decideRejectedSaleDiscardSafety({
        record: sale({ state: "syncing", lastErrorCode: null }),
        uncertain: NO_UNCERTAIN,
      })
    ).toEqual({ allowed: false, reason: "not_needs_attention" });
  });

  it("refuses a synced record", () => {
    expect(
      decideRejectedSaleDiscardSafety({
        record: sale({ state: "synced", serverOrderNumber: "ORD1001" }),
        uncertain: NO_UNCERTAIN,
      })
    ).toEqual({ allowed: false, reason: "not_needs_attention" });
  });

  it("refuses a record already discarded", () => {
    expect(
      decideRejectedSaleDiscardSafety({
        record: sale({ state: "discarded" }),
        uncertain: NO_UNCERTAIN,
      })
    ).toEqual({ allowed: false, reason: "not_needs_attention" });
  });

  it("refuses permanent_failure, which this feature was not designed for", () => {
    expect(
      decideRejectedSaleDiscardSafety({
        record: sale({ state: "permanent_failure", lastErrorCode: "record_unreadable" }),
        uncertain: NO_UNCERTAIN,
      })
    ).toEqual({ allowed: false, reason: "not_needs_attention" });
  });
});

describe("rejection codes that are not authoritative", () => {
  // These all reach needs_attention, and NONE of them proves the sale was
  // refused. A transport failure never reached the server; an unknown outcome
  // may have committed. Discarding either could destroy the only local record
  // of money that is in the books.
  it("refuses a transport failure that exhausted its attempts", () => {
    expect(
      decideRejectedSaleDiscardSafety({
        record: sale({ lastErrorCode: "transport_attempts_exhausted" }),
        uncertain: NO_UNCERTAIN,
      })
    ).toEqual({ allowed: false, reason: "not_terminal_rejection" });
  });

  it("refuses an unknown outcome that exhausted its attempts", () => {
    expect(
      decideRejectedSaleDiscardSafety({
        record: sale({ lastErrorCode: "unknown_attempts_exhausted" }),
        uncertain: NO_UNCERTAIN,
      })
    ).toEqual({ allowed: false, reason: "not_terminal_rejection" });
  });

  it("refuses an uncatalogued server error", () => {
    expect(
      decideRejectedSaleDiscardSafety({
        record: sale({ lastErrorCode: "unrecognised_server_error" }),
        uncertain: NO_UNCERTAIN,
      })
    ).toEqual({ allowed: false, reason: "not_terminal_rejection" });
  });

  it("refuses a record with no error code at all", () => {
    expect(
      decideRejectedSaleDiscardSafety({
        record: sale({ lastErrorCode: null }),
        uncertain: NO_UNCERTAIN,
      })
    ).toEqual({ allowed: false, reason: "not_terminal_rejection" });
  });

  it("refuses other authorization refusals that are not the approved one", () => {
    for (const code of ["not_authorized", "not_a_paired_device", "build_unavailable"]) {
      expect(
        decideRejectedSaleDiscardSafety({
          record: sale({ lastErrorCode: code }),
          uncertain: NO_UNCERTAIN,
        })
      ).toEqual({ allowed: false, reason: "not_terminal_rejection" });
    }
  });
});

describe("evidence that the server may already own this sale", () => {
  it("refuses when a server order number is present", () => {
    expect(
      decideRejectedSaleDiscardSafety({
        record: sale({ serverOrderNumber: "ORD1001" }),
        uncertain: NO_UNCERTAIN,
      })
    ).toEqual({ allowed: false, reason: "server_order_exists" });
  });

  it("refuses when only a server order id is present", () => {
    expect(
      decideRejectedSaleDiscardSafety({
        record: sale({ serverOrderId: "order-1" }),
        uncertain: NO_UNCERTAIN,
      })
    ).toEqual({ allowed: false, reason: "server_order_exists" });
  });

  it("refuses when an outstanding online request names this very sale", () => {
    expect(
      decideRejectedSaleDiscardSafety({
        record: sale(),
        uncertain: {
          present: true,
          saleRequestId: "11111111-1111-4111-8111-111111111111",
        },
      })
    ).toEqual({ allowed: false, reason: "uncertain_sale_outstanding" });
  });

  it("refuses when outstanding evidence exists but cannot be attributed", () => {
    // Unreadable, or belonging to another pairing. "We cannot tell whose this
    // is" must read as "it might be this one".
    expect(
      decideRejectedSaleDiscardSafety({
        record: sale(),
        uncertain: { present: true, saleRequestId: null },
      })
    ).toEqual({ allowed: false, reason: "uncertain_sale_outstanding" });
  });

  it("allows when the outstanding request is demonstrably a different sale", () => {
    expect(
      decideRejectedSaleDiscardSafety({
        record: sale(),
        uncertain: {
          present: true,
          saleRequestId: "99999999-9999-4999-8999-999999999999",
        },
      })
    ).toEqual({ allowed: true });
  });
});

describe("what the operator is told", () => {
  it("explains a post-revocation rejection without server jargon", () => {
    const reason = describeRejectedSaleReason("post_revocation");

    expect(reason).toContain("after this device had already been revoked");
    expect(reason).toContain("did not create a server order");

    for (const jargon of ["v4", "complete_sale", "SQLSTATE", "post_revocation", "RPC", "occurred_at"]) {
      expect(reason).not.toContain(jargon);
    }
  });

  it("falls back to a plain explanation for any other code", () => {
    const reason = describeRejectedSaleReason("unrecognised_server_error");

    expect(reason).toContain("could not record this sale");
    expect(reason).not.toContain("unrecognised_server_error");
  });
});
