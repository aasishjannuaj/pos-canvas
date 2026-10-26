import { describe, expect, it } from "vitest";

import { afterAction, afterSave, isStructuralChange } from "@/lib/catalogVersion";
import { describeHistory, parseHistory } from "@/lib/inventoryHistory";

describe("catalogVersion — authoritative versions without blessing stale snapshots", () => {
  it("adopts an action's new version only when the action was authorized at our version", () => {
    expect(afterAction(3, 3, 4)).toEqual({ version: 4, stale: false }); // our tracking change
    expect(afterAction(3, 3, 3)).toEqual({ version: 3, stale: false }); // no-op
    expect(afterAction(3, 5, 6)).toEqual({ version: 3, stale: true }); // someone else changed the catalog
    expect(afterAction(3, null, 3)).toEqual({ version: 3, stale: false }); // replay, nothing new
    expect(afterAction(3, null, 5)).toEqual({ version: 3, stale: true }); // replay, catalog moved on
  });

  it("after a save: structural saves adopt (they required a current base); non-structural only if nothing moved", () => {
    expect(afterSave(3, true, 4)).toEqual({ version: 4, stale: false });
    expect(afterSave(3, false, 3)).toEqual({ version: 3, stale: false });
    expect(afterSave(3, false, 5)).toEqual({ version: 3, stale: true });
  });

  it("structural = items added or removed relative to the saved set", () => {
    expect(isStructuralChange(new Set(["a", "b"]), ["a", "b"])).toBe(false);
    expect(isStructuralChange(new Set(["a", "b"]), ["b", "a"])).toBe(false);
    expect(isStructuralChange(new Set(["a", "b"]), ["a"])).toBe(true);
    expect(isStructuralChange(new Set(["a"]), ["a", "c"])).toBe(true);
    expect(isStructuralChange(new Set(["a", "b"]), ["a", "c"])).toBe(true);
  });
});

describe("inventoryHistory", () => {
  const feed = [
    { kind: "action", at: "2026-10-24T10:05:00+00:00", requestId: "r3", action: "tracking", itemId: "cola", result: { before: true, after: false }, zeroChange: false },
    { kind: "action", at: "2026-10-24T10:04:00+00:00", requestId: "r2", action: "count", itemId: "chips", result: { before: 10, after: 10 }, zeroChange: true },
    { kind: "ledger", at: "2026-10-24T10:03:00+00:00", transactionType: "restock", itemId: "chips", itemName: "Chips", before: 10, after: 13, change: 3, actionRequestId: "r1" },
    { kind: "action", at: "2026-10-24T10:03:00+00:00", requestId: "r1", action: "receive", itemId: "chips", result: { before: 10, after: 13 }, zeroChange: false },
    { kind: "ledger", at: "2026-10-24T10:02:00+00:00", transactionType: "sale", itemId: "cola", itemName: "Cola", before: 20, after: 19, change: -1, actionRequestId: null },
    { kind: "deletion", at: "2026-10-24T10:01:00+00:00", itemId: "water", lastStock: 0 },
  ];

  it("parses the feed and folds action-written ledger rows into their action", () => {
    const entries = parseHistory(feed);
    expect(entries).not.toBeNull();
    const lines = describeHistory(entries!, (id) => ({ cola: "Cola", chips: "Chips", water: "Water" })[id] ?? id).map((l) => l.text);
    expect(lines).toEqual([
      "Cola: tracking turned off",
      "Chips: counted 10 (no change)",
      "Chips: received 3 (10 → 13)",
      "Cola: sold -1 (20 → 19)",
      "Water: item deleted (last stock 0)",
    ]);
  });

  it("refuses a malformed feed", () => {
    expect(parseHistory({})).toBeNull();
    expect(parseHistory([{ kind: "bogus", at: "x", itemId: "a" }])).toBeNull();
  });
});
