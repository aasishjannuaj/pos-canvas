import { describe, expect, it } from "vitest";

import {
  createRequestKeeper,
  describeInventoryActionError,
  isDefinitiveInventoryActionError,
  parseInventoryActionResult,
  requestKey,
} from "@/lib/inventoryActions";

describe("createRequestKeeper — retrying the same submission reuses its request id", () => {
  it("returns the same id for the same key until settled, then a new one", () => {
    let n = 0;
    const keeper = createRequestKeeper(() => `id-${++n}`);
    const key = requestKey("receive", "cola", 10);

    expect(keeper.idFor(key)).toBe("id-1");
    expect(keeper.idFor(key)).toBe("id-1"); // retry after a lost reply
    keeper.settle(key);
    expect(keeper.idFor(key)).toBe("id-2"); // a NEW receive of 10 is a new request
  });

  it("different action, item or input never shares an id", () => {
    let n = 0;
    const keeper = createRequestKeeper(() => `id-${++n}`);

    const ids = [
      keeper.idFor(requestKey("receive", "cola", 10)),
      keeper.idFor(requestKey("receive", "cola", 11)),
      keeper.idFor(requestKey("receive", "chips", 10)),
      keeper.idFor(requestKey("count", "cola", 10)),
      keeper.idFor(requestKey("tracking", "cola", true)),
    ];

    expect(new Set(ids).size).toBe(5);
  });
});

describe("parseInventoryActionResult", () => {
  it("accepts receive/count results and tracking results", () => {
    expect(parseInventoryActionResult({ action: "receive", itemId: "cola", before: 2, after: 12 })).toEqual({
      action: "receive", itemId: "cola", before: 2, after: 12, replayed: false, catalogVersion: null, catalogVersionBefore: null,
    });
    expect(parseInventoryActionResult({ action: "count", itemId: "cola", before: 12, after: 5, replayed: true })?.replayed).toBe(true);
    expect(parseInventoryActionResult({ action: "tracking", itemId: "cola", before: true, after: false })?.after).toBe(false);
  });

  it("refuses malformed answers", () => {
    for (const bad of [null, "x", {}, { action: "delete", itemId: "a", before: 1, after: 2 },
      { action: "receive", itemId: "", before: 1, after: 2 }, { action: "receive", itemId: "a", before: 1.5, after: 2 },
      { action: "tracking", itemId: "a", before: 1, after: 0 }]) {
      expect(parseInventoryActionResult(bad)).toBeNull();
    }
  });
});

describe("server refusals", () => {
  it("definitive refusals settle the request id; transport-like errors do not", () => {
    expect(isDefinitiveInventoryActionError("request_conflict")).toBe(true);
    expect(isDefinitiveInventoryActionError("Project not found or access denied")).toBe(true);
    expect(isDefinitiveInventoryActionError("Turn on stock tracking first")).toBe(true);
    expect(isDefinitiveInventoryActionError("TypeError: Failed to fetch")).toBe(false);
  });

  it("messages are owner-readable", () => {
    expect(describeInventoryActionError("request_conflict")).toMatch(/Nothing was changed/);
    expect(describeInventoryActionError("Turn on stock tracking first")).toMatch(/stock tracking/);
  });
});
