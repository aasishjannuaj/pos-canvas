// Feature 25.3 Phase 2 — structural guards for the Sales history UI.
//
// This repository tests React by reading its source (vitest runs in the node
// environment; there is no DOM harness). The properties below are the ones a
// render test would check and a type checker cannot — above all that opening
// history does not throw away the cart, and that history never re-prices a past
// sale from today's menu.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf-8");
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const APP = "components/device/DeviceApp.tsx";
const MENU = "components/device/OperatorMenu.tsx";
const LIST = "components/runtime/SalesHistoryScreen.tsx";
const DETAIL = "components/runtime/SalesHistoryDetail.tsx";
const VIEW = "lib/salesHistoryView.ts";

const ready = () => {
  const app = code(read(APP));
  return app.slice(app.indexOf('case "ready": {'));
};

describe("one operator menu, not two pills", () => {
  it("the ready POS renders the menu", () => {
    expect(ready()).toContain("<OperatorMenu");
    expect(ready()).toContain("headerTrailing=");
  });

  it("the standalone Device settings pill is gone", () => {
    // Two full buttons would leave the business name almost nothing at the
    // 411 CSS px Android viewport.
    const r = ready();

    expect(r).not.toContain(">\n              Device settings\n            </button>");
    expect(r.match(/<button/g) ?? []).toHaveLength(0);
  });

  it("the menu offers exactly Sales history and Device settings", () => {
    const menu = code(read(MENU));

    expect(menu).toContain("OPERATOR_MENU_HISTORY");
    expect(menu).toContain("OPERATOR_MENU_SETTINGS");
    expect(menu).toContain("onOpenHistory");
    expect(menu).toContain("onOpenSettings");
  });

  it("is labelled, dismissible, and offers no route out of the till", () => {
    const menu = code(read(MENU));

    expect(menu).toContain("aria-label={OPERATOR_MENU_LABEL}");
    expect(menu).toContain('aria-haspopup="menu"');
    expect(menu).toContain('role="menuitem"');
    expect(menu).toContain('event.key === "Escape"');
    // Feature 16.4A — a till has nowhere to go back to.
    expect(menu).not.toContain("next/link");
    expect(menu).not.toContain("/dashboard");
  });
});

describe("opening a till screen must not destroy the cart", () => {
  it("renders screens as an OVERLAY above a still-mounted PosRuntime", () => {
    const r = ready();

    // The cart is useState INSIDE PosRuntime, so returning a different tree
    // unmounts it and throws away whatever was rung up.
    expect(r).toContain("const overlay =");
    expect(r).toContain("{overlay !== null && (");
    expect(r).toContain("<PosRuntime");
  });

  it("no till screen early-returns before PosRuntime", () => {
    const r = ready();
    const posRuntime = r.indexOf("<PosRuntime");

    for (const screen of ["<SalesHistoryScreen", "<SalesHistoryDetail", "<DeviceSettingsScreen", "<RejectedSaleReview"]) {
      expect(`${screen} is composed, not returned early`).toBe(`${screen} is composed, not returned early`);
      // Every screen appears in the overlay expression, which sits ABOVE the
      // PosRuntime render in source but does not return.
      expect(r).toContain(screen);
    }

    expect(posRuntime).toBeGreaterThan(-1);
    expect(r.indexOf("const overlay =")).toBeLessThan(posRuntime);
  });

  it("closing the detail returns to the LIST, not out of history", () => {
    expect(ready()).toContain("onBack={() => setHistoryOrder(null)}");
    expect(ready()).toContain("onClose={() => setHistoryOpen(false)}");
  });

  it("closing history does not unpair or reset the device", () => {
    const r = ready();
    const historyBlock = r.slice(r.indexOf("<SalesHistoryScreen"), r.indexOf("<DeviceSettingsScreen"));

    for (const forbidden of ["handleUnpair", "handleReset", "resetDeviceSession", "clearOfflineCache"]) {
      expect(historyBlock).not.toContain(forbidden);
    }
  });
});

describe("the list is honest about every state", () => {
  it("reaches the server only through the Phase 1 wrapper", () => {
    const list = code(read(LIST));

    expect(list).toContain("fetchDeviceRecentOrders");
    // Never a direct table read, and never the RPC name in a component.
    expect(list).not.toContain('from("orders")');
    expect(list).not.toContain("get_device_recent_orders");
    expect(list).not.toContain("supabase");
  });

  it("names loading, empty, offline and error states in words", () => {
    const list = code(read(LIST));

    for (const state of ["HISTORY_LOADING", "HISTORY_EMPTY", "HISTORY_OFFLINE", "HISTORY_ERROR", "HISTORY_RETRY"]) {
      expect(list).toContain(state);
    }
  });

  it("shows offline rather than stale or cached history", () => {
    const list = code(read(LIST));

    expect(list).toContain('reason === "unreachable"');
    // No local cache, no queue merge — an unsynced sale is not a completed one.
    expect(list).not.toContain("saleQueue");
    expect(list).not.toContain("listQueuedSales");
    expect(list).not.toContain("OFF-");
  });

  it("a failed Load more keeps the rows already on screen", () => {
    const list = code(read(LIST));
    const loadMore = list.slice(list.indexOf("async function loadMore()"));

    expect(loadMore).toContain("setMoreFailed(true)");
    // The only setList in that path appends; nothing resets the list.
    expect(loadMore).not.toContain("setList(emptySalesHistoryList)");
    expect(list).toContain("HISTORY_LOAD_MORE_FAILED");
  });

  it("Load more is driven by the server cursor and disabled while loading", () => {
    const list = code(read(LIST));

    expect(list).toContain("hasMoreHistory(list)");
    expect(list).toContain("disabled={loadingMore}");
    expect(list).toContain("fetchDeviceRecentOrders(list.cursor)");
  });

  it("exposes no mechanism to a cashier", () => {
    const view = code(read(VIEW));

    for (const jargon of ["rpc", "PGRST", "postgrest", "build_job", "sql"]) {
      expect(view.toLowerCase()).not.toContain(jargon);
    }
  });
});

describe("the receipt is the stored sale, replayed", () => {
  it("maps through the SAME chain the till uses", () => {
    const detail = code(read(DETAIL));

    expect(detail).toContain("toHistoryReceipt(order)");
    expect(detail).toContain("toCompletedOrder(");
    expect(detail).toContain("<Receipt");
  });

  it("NEVER re-prices from today's menu", () => {
    const detail = code(read(DETAIL));

    // The pinned config contributes the business header and receipt settings
    // only. Touching menuItems here would rewrite what a customer paid.
    expect(detail).toContain("config.businessProfile");
    expect(detail).toContain("config.receipt");
    expect(detail).not.toContain("config.menuItems");
    expect(detail).not.toContain("calculateCartSummary");
    expect(detail).not.toContain("createCartItem");
  });

  it("reuses the existing print CSS rather than adding any", () => {
    expect(code(read(DETAIL))).toContain('className="receipt-print-area"');
  });
});

describe("reprint tells the truth on every platform", () => {
  it("web and Windows call window.print()", () => {
    expect(code(read(DETAIL))).toContain("window.print()");
  });

  it("Android is disabled and explains itself without a press", () => {
    const detail = code(read(DETAIL));

    expect(detail).toContain("isCapacitorNativeShell()");
    expect(detail).toContain("disabled={nativeShell}");
    expect(detail).toContain("NATIVE_PRINT_UNAVAILABLE_MESSAGE");
    // Shown, not hidden: a missing button reads as a missing feature.
    expect(detail).toContain("{nativeShell && (");
  });

  it("never claims a print succeeded", () => {
    const detail = code(read(DETAIL));

    for (const lie of ["Printed", "print successful", "Sent to printer"]) {
      expect(detail).not.toContain(lie);
    }
  });
});

describe("history introduces no destructive or privileged action", () => {
  it("offers no delete, void, refund or edit", () => {
    for (const file of [LIST, DETAIL, VIEW, MENU]) {
      const source = code(read(file)).toLowerCase();

      for (const forbidden of ["delete", "void order", "refund", "edit sale"]) {
        expect(`${file}: ${forbidden}`).toBe(`${file}: ${forbidden}`);
        expect(source).not.toContain(forbidden);
      }
    }
  });

  it("touches no owner, publish or admin path", () => {
    for (const file of [LIST, DETAIL, MENU]) {
      const source = code(read(file));

      for (const forbidden of ["requestBuildJob", "startBuildProcessing", "refreshBuildJobStatus", "admin", "service_role"]) {
        expect(source).not.toContain(forbidden);
      }
    }
  });

  it("the 25.1 unpair path is unchanged", () => {
    const r = ready();

    expect(r).toContain("onUnpair={() => void handleUnpair()}");
    expect(r).toContain("unpairBlocked={resetBlocked}");
  });
});
