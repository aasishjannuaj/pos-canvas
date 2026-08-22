// Feature 24.5E — what the cashier is told, and when a reset is refused.
import { describe, expect, it } from "vitest";
import {
  decideDeviceResetSafety,
  describeOfflineSaleStatus,
  toOfflineSaleStatus,
} from "@/lib/offlineSaleStatus";
import { summarizeQueue } from "@/lib/saleQueue";
import type { QueueState, QueueSummary, QueuedSale } from "@/lib/saleQueue";

function summary(counts: Partial<QueueSummary> = {}): QueueSummary {
  return {
    pending: 0,
    syncing: 0,
    synced: 0,
    needsAttention: 0,
    discarded: 0,
    permanentFailure: 0,
    outstanding: 0,
    total: 0,
    ...counts,
  };
}

function saleIn(state: QueueState): QueuedSale {
  return { state } as QueuedSale;
}

describe("the cashier's counts", () => {
  it("says nothing at all when the device is holding nothing", () => {
    const status = toOfflineSaleStatus(summary());

    expect(status.unsynced).toBe(0);
    expect(describeOfflineSaleStatus(status)).toEqual([]);
  });

  it("counts sales on their way as waiting, in plain language", () => {
    const status = toOfflineSaleStatus(summary({ pending: 2, syncing: 1, total: 3 }));

    expect(status.waiting).toBe(3);
    expect(describeOfflineSaleStatus(status)).toEqual(["3 sales waiting to sync"]);
  });

  it("uses the singular for one sale", () => {
    expect(
      describeOfflineSaleStatus(toOfflineSaleStatus(summary({ pending: 1, total: 1 })))
    ).toEqual(["1 sale waiting to sync"]);
  });

  it("never counts a sale that needs attention as synced or as merely waiting", () => {
    const status = toOfflineSaleStatus(
      summary({ synced: 4, needsAttention: 1, permanentFailure: 1, total: 6 })
    );

    expect(status.synced).toBe(4);
    expect(status.needsAttention).toBe(2);
    expect(status.waiting).toBe(0);
    expect(describeOfflineSaleStatus(status)).toEqual(["2 sales need attention"]);
  });

  it("treats a record it can no longer read as needing attention, never as gone", () => {
    const status = toOfflineSaleStatus(summary({ synced: 1, total: 1 }), 2);

    expect(status.needsAttention).toBe(2);
    expect(status.unsynced).toBe(2);
    expect(status.total).toBe(3);
  });

  it("uses no technical or database vocabulary", () => {
    const lines = describeOfflineSaleStatus(
      toOfflineSaleStatus(summary({ pending: 1, needsAttention: 1, total: 2 }))
    );

    expect(lines).toHaveLength(2);

    for (const line of lines) {
      for (const banned of ["queue", "record", "indexeddb", "state", "rpc", "error"]) {
        expect(`"${line}" says ${banned}`).toBe(`"${line}" says ${banned}`);
        expect(line.toLowerCase()).not.toContain(banned);
      }
    }
  });

  it("reads the real summarizeQueue output, not a hand-built shape", () => {
    const status = toOfflineSaleStatus(
      summarizeQueue([saleIn("pending"), saleIn("synced"), saleIn("needs_attention")])
    );

    expect(status).toEqual({
      waiting: 1,
      needsAttention: 1,
      synced: 1,
      unsynced: 2,
      total: 3,
      nextRetryAt: null,
      uncertainOnlineSale: false,
    });
  });
});

describe("a reset cannot destroy sales the server has not accepted", () => {
  it("allows a reset when there is nothing unsynced", () => {
    expect(decideDeviceResetSafety(toOfflineSaleStatus(summary()))).toEqual({ allowed: true });
  });

  it("allows a reset when every sale is already recorded", () => {
    // Synced records alone are a copy, not the only copy, and they carry their
    // reconciliation data with them.
    expect(
      decideDeviceResetSafety(toOfflineSaleStatus(summary({ synced: 12, total: 12 })))
    ).toEqual({ allowed: true });
  });

  it("blocks while a sale is still waiting", () => {
    const safety = decideDeviceResetSafety(
      toOfflineSaleStatus(summary({ pending: 3, total: 3 }))
    );

    expect(safety.allowed).toBe(false);

    if (safety.allowed) return;

    expect(safety.unsynced).toBe(3);
    // §15 requires any path near discarding sales to state HOW MANY.
    expect(safety.message).toContain("3 sales");
  });

  it("blocks while a sale is mid-submission", () => {
    expect(
      decideDeviceResetSafety(toOfflineSaleStatus(summary({ syncing: 1, total: 1 }))).allowed
    ).toBe(false);
  });

  it("blocks hardest on sales that need a person — that is the evidence", () => {
    for (const counts of [
      summary({ needsAttention: 1, total: 1 }),
      summary({ permanentFailure: 1, total: 1 }),
    ]) {
      const safety = decideDeviceResetSafety(toOfflineSaleStatus(counts));

      expect(safety.allowed).toBe(false);
    }
  });

  it("blocks on a record it can no longer read", () => {
    expect(
      decideDeviceResetSafety(toOfflineSaleStatus(summary({ synced: 1, total: 1 }), 1)).allowed
    ).toBe(false);
  });

  it("explains itself without offering to discard anything", () => {
    const safety = decideDeviceResetSafety(toOfflineSaleStatus(summary({ pending: 1, total: 1 })));

    expect(safety.allowed).toBe(false);

    if (safety.allowed) return;

    expect(safety.message).toContain("1 sale");
    // The explicit "discard N unsynced sales" confirmation is deferred; nothing
    // here may imply it exists.
    for (const banned of ["discard", "delete", "erase", "wipe"]) {
      expect(`message offers ${banned}`).toBe(`message offers ${banned}`);
      expect(safety.message.toLowerCase()).not.toContain(banned);
    }
  });
});
