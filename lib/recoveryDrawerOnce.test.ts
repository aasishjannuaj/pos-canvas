// G-1-CLIENT-1 — the accepted exactly-once drawer behaviour holds through
// recovery: a recovered sale opens the drawer at most once for its sale request
// id, however many times its completion is reported, and nothing on the
// recovery or sync path can open it at all.
//
// Real modules: cashDrawer (the coordinator), cashDrawerSession (the durable
// claim), deviceOfflineStore. Storage: fake-indexeddb. The drawer itself is a
// counting stand-in capability — no hardware, no IPC.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runAutomaticDrawerEvent } from "@/lib/cashDrawer";
import type { CashDrawerCapability } from "@/lib/cashDrawer";
import { claimAutomaticDrawerEvent } from "@/lib/cashDrawerSession";

const SALE_ID = "9e9e0000-0000-4000-8000-00000000009e";

function countingDrawer() {
  const opened: string[] = [];
  const capability: CashDrawerCapability = {
    available: true,
    requestOpen: async ({ saleRequestId }) => {
      opened.push(saleRequestId);
      return "sent" as const;
    },
  };

  return { opened, capability };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

describe("a recovered cash sale opens the drawer at most once", () => {
  it("the first completion report opens it; every later report for the same id is already_claimed", async () => {
    const drawer = countingDrawer();
    const report = () =>
      runAutomaticDrawerEvent({
        event: { saleRequestId: SALE_ID, paymentMethod: "cash" },
        platform: "windows",
        autoOpenEnabled: true,
        claim: claimAutomaticDrawerEvent,
        capability: drawer.capability,
      });

    // The recovered sale completes (online strict, recorded, or queued).
    expect(await report()).toMatchObject({ status: "requested" });
    // A double press, a second recovery of the same sale, a reprint: nothing.
    expect(await report()).toEqual({ status: "already_claimed" });
    expect(await report()).toEqual({ status: "already_claimed" });

    expect(drawer.opened).toEqual([SALE_ID]);
  });

  it("an earlier in-process completion of the same id (claimed before the restart) is honoured", async () => {
    // The original attempt's completion was reported and the drawer claimed;
    // the process then restarted and the same sale was recovered again.
    expect(await claimAutomaticDrawerEvent(SALE_ID)).toBe("claimed");

    const drawer = countingDrawer();
    const outcome = await runAutomaticDrawerEvent({
      event: { saleRequestId: SALE_ID, paymentMethod: "cash" },
      platform: "windows",
      autoOpenEnabled: true,
      claim: claimAutomaticDrawerEvent,
      capability: drawer.capability,
    });

    expect(outcome).toEqual({ status: "already_claimed" });
    expect(drawer.opened).toEqual([]);
  });
});

describe("nothing on the recovery or sync path can open the drawer", () => {
  const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

  it("the recovery, strict-queue and sync modules never reference the drawer", () => {
    for (const file of [
      "lib/saleRecovery.ts",
      "lib/saleRecoveryRpc.ts",
      "lib/saleRecoverySession.ts",
      "lib/offlineSaleRpc.ts",
      "lib/saleSyncEngine.ts",
      "lib/saleQueueSession.ts",
    ]) {
      const source = read(file);

      for (const banned of ["runAutomaticDrawerEvent", "claimAutomaticDrawerEvent", "requestOpen", "cashDrawer"]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });
});
