// v1.3 CP-2D — the integration seams between CP-2B, CP-2C and CP-2R.
//
// Each checkpoint's own suite still runs unchanged; this file covers only what
// could not exist until they were in one tree: the bounded cleanup, and the
// places where one checkpoint's behaviour has to hold through another's code.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import { describeApplyBlockedBySales } from "@/lib/deviceConfigUpdate";
import {
  decideDeviceResetSafety,
  describeOfflineSaleStatus,
} from "@/lib/offlineSaleStatus";
import type { OfflineSaleStatus } from "@/lib/offlineSaleStatus";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(repoRoot, p), "utf-8");
const code = (src: string) =>
  src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

function status(patch: Partial<OfflineSaleStatus> = {}): OfflineSaleStatus {
  return {
    waiting: 0,
    needsAttention: 0,
    synced: 0,
    unsynced: 0,
    total: 0,
    nextRetryAt: null,
    uncertainOnlineSale: false,
    evidenceReadable: true,
    ...patch,
  };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

// ---------------------------------------------------------------------------

describe("D1. the Apply refusal never quotes a count it did not read", () => {
  it("says it cannot verify, rather than '0 sales'", () => {
    const message = describeApplyBlockedBySales(status({ evidenceReadable: false }));

    expect(message).toContain("cannot check the sales saved on it");
    expect(message).toContain("cannot apply this update yet");
    // THE DEFECT, NAMED: a count of zero read as reassurance.
    expect(message).not.toContain("0 sales");
    expect(message).not.toMatch(/\b0\b/);
  });

  it("still quotes a real count when storage WAS read", () => {
    expect(describeApplyBlockedBySales(status({ unsynced: 3 }))).toContain("3 sales");
    expect(describeApplyBlockedBySales(status({ unsynced: 1 }))).toContain("1 sale");
  });

  it("an outstanding online request keeps its own wording", () => {
    expect(describeApplyBlockedBySales(status({ uncertainOnlineSale: true })))
      .toContain("may already have gone through");
  });

  it("unreadable storage takes precedence over every count below it", () => {
    const message = describeApplyBlockedBySales(
      status({ evidenceReadable: false, unsynced: 9, uncertainOnlineSale: true })
    );

    expect(message).toContain("cannot check the sales saved on it");
    expect(message).not.toContain("9 sales");
  });
});

describe("D2. the cashier status never implies everything has synced", () => {
  it("says so when the device cannot check", () => {
    const lines = describeOfflineSaleStatus(status({ evidenceReadable: false }));

    // Previously this returned [] -- the same screen a fully synced till shows.
    expect(lines).not.toEqual([]);
    expect(lines.join(" ")).toContain("Cannot check saved sales");
  });

  it("is still silent when storage was read and nothing is outstanding", () => {
    expect(describeOfflineSaleStatus(status())).toEqual([]);
  });

  it("still reports real counts when storage was read", () => {
    expect(describeOfflineSaleStatus(status({ waiting: 2 })).join(" ")).toContain("2 sales waiting");
    expect(describeOfflineSaleStatus(status({ needsAttention: 1 })).join(" "))
      .toContain("1 sale needs attention");
  });

  it("the unreadable line replaces the counts rather than joining them", () => {
    // Counts alongside "cannot check" would be two contradictory claims.
    const lines = describeOfflineSaleStatus(
      status({ evidenceReadable: false, waiting: 4, needsAttention: 2 })
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Cannot check saved sales");
  });

  it("and the gate still refuses, so the copy and the decision agree", () => {
    expect(decideDeviceResetSafety(status({ evidenceReadable: false })).allowed).toBe(false);
  });
});

describe("D3. the discard closes its connection without touching atomicity", () => {
  const session = code(read("lib/rejectedSaleSession.ts"));
  const body = session.slice(
    session.indexOf("export async function discardRejectedSale("),
    session.indexOf("export async function listRejectedSaleReviews(")
  );

  it("closes the database it opened", () => {
    expect(body).not.toBe("");
    expect(body).toContain("db.value.close();");
    expect(body).toContain("} finally {");
  });

  it("closes AFTER the mutation has settled, never during it", () => {
    const mutate = body.indexOf("await withQueueRecordMutation<DiscardRejectedSaleResult>(");
    const close = body.indexOf("db.value.close();");

    expect(mutate).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(mutate);
  });

  it("the single-transaction property is unchanged", () => {
    const store = code(read("lib/deviceOfflineStore.ts"));
    const fn = store.slice(
      store.indexOf("export function withQueueRecordMutation<T>("),
      store.indexOf("function withStore<T>(")
    );

    expect(fn).toContain('db.transaction([SALE_QUEUE_STORE, CACHE_STORE], "readwrite")');
    expect(fn).toContain("queueStore.put(outcome.record)");
    // Still synchronous: an await here would auto-commit the transaction.
    expect(fn).not.toContain("await ");
    // And no close inside the helper, which could race its own transaction.
    expect(fn).not.toContain("close()");
  });

  it("still discards and still refuses, with the connection closed", async () => {
    const queue = await import("@/lib/saleQueueSession");
    const rejected = await import("@/lib/rejectedSaleSession");

    const seed = async (code_: string) => {
      const q = await queue.enqueueSale({
        saleRequestId: "11111111-1111-4111-8111-111111111111",
        queueRecordId: "q-1",
        deviceAuthUserId: "22222222-2222-4222-8222-222222222222",
        deviceId: "33333333-3333-4333-8333-333333333333",
        projectId: "44444444-4444-4444-8444-444444444444",
        buildJobId: "55555555-5555-4555-8555-555555555555",
        paymentMethod: "cash",
        items: [{ itemId: "item-1", quantity: 1, modifiers: [] }],
        occurredAt: "2026-10-12T00:05:00.000Z",
        now: "2026-10-12T09:00:00.000Z",
        registerSessionId: "77777777-7777-4777-8777-777777777777",
      });

      expect(q.ok).toBe(true);
      await queue.updateQueueState("q-1", "syncing", "2026-10-12T09:00:00.000Z");
      await queue.updateQueueState("q-1", "needs_attention", "2026-10-12T09:00:00.000Z", {
        lastErrorCode: code_,
        lastErrorMessage: "seeded",
      });
    };

    // A register-blocked sale still refuses an unauthorised reviewer...
    await seed("register_unverified");
    expect(await rejected.discardRejectedSale("q-1", { allowed: false })).toEqual({
      ok: false,
      reason: "reviewer_not_permitted",
    });

    // ...and an eligible unrelated rejection still discards, repeatedly, which
    // would fail if the connection had been left in a broken state.
    globalThis.indexedDB = new IDBFactory();
    await seed("post_revocation");
    expect((await rejected.discardRejectedSale("q-1", { allowed: false })).ok).toBe(true);
  });
});

describe("CP-2C cash tender does not bypass CP-2B authorization", () => {
  const runtime = code(read("components/runtime/PosRuntime.tsx"));

  it("Done goes through completeSale, which still holds every CP-2B gate", () => {
    const cash = runtime.slice(
      runtime.indexOf("async function completeCashSale()"),
      runtime.indexOf("const shownReceipt =")
    );

    expect(cash).not.toBe("");
    // The cash path dispatches nothing itself.
    expect(cash).toContain("await completeSale();");
    for (const banned of ["planSaleSubmission", "submitSale", "queueOfflineSale("]) {
      expect(cash).not.toContain(banned);
    }
  });

  it("completeSale still carries BOTH checkpoints' guards, in order", () => {
    const body = runtime.slice(
      runtime.indexOf("async function completeSale()"),
      runtime.indexOf("async function completeCashSale()") > runtime.indexOf("async function completeSale()")
        ? runtime.indexOf("async function completeCashSale()")
        : runtime.lastIndexOf("return (")
    );

    expect(body).not.toBe("");

    const blocked = body.indexOf("if (checkoutBlockedReason !== null)");
    const emptyCart = body.indexOf("if (cart.length === 0 || !selectedPaymentMethod");
    const doubleSubmit = body.indexOf("if (saleInFlightRef.current || isSubmitBlocked(saleSaveStatus))");
    const prepareRefusal = body.indexOf("if (prepareRefusalRef.current !== null)");
    const fingerprint = body.indexOf("createSaleFingerprint({");
    const uncertainty = body.indexOf("decideUncertainSale(");

    // CP-2A/24.5A offline fence first, then the original gates, then CP-2B's
    // authorization, then the UNKNOWN-outcome fence. Nothing reordered by the
    // merge.
    expect(blocked).toBe(body.indexOf("if ("));
    expect(emptyCart).toBeGreaterThan(blocked);
    expect(doubleSubmit).toBeGreaterThan(emptyCart);
    expect(prepareRefusal).toBeGreaterThan(doubleSubmit);
    expect(fingerprint).toBeGreaterThan(prepareRefusal);
    expect(uncertainty).toBeGreaterThan(fingerprint);
  });

  it("both checkpoints' in-flight guards survive the merge", () => {
    // CP-2B's guards the dispatch; CP-2C's guards the Done press. They are
    // layered, not duplicates, and losing either reopens a different window.
    expect(runtime).toContain("const saleInFlightRef = useRef(false);");
    expect(runtime).toContain("const cashDoneInFlightRef = useRef(false);");
  });

  it("both checkpoints' open-checkout work survives the merge", () => {
    const open = runtime.slice(
      runtime.indexOf("function openCheckout()"),
      runtime.indexOf("function closeCheckout()")
    );

    expect(open).not.toBe("");
    // CP-2B mints the authorization...
    expect(open).toContain("prepareCheckoutAuthorization()");
    expect(open).toContain("prepareRefusalRef.current = null;");
    // ...and CP-2C starts a new tender episode. Both, before the panel opens.
    expect(open).toContain("setCheckoutEpisode((previous) => previous + 1);");
    expect(open).toContain("resetCashTender();");
    expect(open.indexOf("setCheckoutOpen(true)")).toBeGreaterThan(
      open.indexOf("resetCashTender();")
    );
  });

  it("the scanner-focus boundary still holds across the merge", () => {
    // CP-2C's pad focuses nothing; the accepted focus invariant names only the
    // two Search / Scan fields.
    expect(code(read("components/runtime/CashTenderPad.tsx"))).not.toContain(".focus()");
    expect(runtime).toContain("setScanFocusRequest((previous) => previous + 1);");
  });
});
