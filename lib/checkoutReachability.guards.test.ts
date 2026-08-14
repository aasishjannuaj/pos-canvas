// Feature 18.2 Phase 5A — the checkout-version reachability invariant.
//
// THE INVARIANT, stated once:
//
//   No live modifier-capable checkout surface may reach complete_sale (v1) or
//   complete_sale_v2.
//
//     Owner runtime   -> complete_sale_v3
//     Device runtime  -> complete_sale_v3
//     Builder Preview -> complete_sale_v3
//
// WHY THIS NEEDS A GUARD RATHER THAN A TEST. The three surfaces are React
// components with no DOM environment in this repository, and the failure they
// protect against is not a wrong value — it is a wrong FUNCTION being called.
// Nothing observable breaks at the moment a surface is wired back to v1: sales
// keep completing. What changes is that the client's own arithmetic becomes the
// price of record, and any modifier selection stops being written to
// order_items.modifiers, so the loss only becomes visible when someone reprints
// a receipt weeks later and it no longer describes what was sold.
//
// The Phase 4 review found exactly this: EditorShell's Builder Preview was still
// on v1 after Phase 3 had made its cart modifier-bearing. It was a live,
// reachable path that persisted modifier-adjusted money v1 never recomputed and
// never recorded. This file is what makes that class of regression loud.
//
// v1 and v2 wrappers are deliberately KEPT in their transport modules, following
// the same convention D3 used when v2 arrived: a stale open tab keeps working
// and a deployment rollback stays possible. Defining them is fine. CALLING one
// is what this file forbids.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf-8");
}

/** Strips comments, so prose naming a retired version never trips a guard. */
function code(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Every non-test .ts/.tsx file the app ships, recursively. */
function sourceFiles(relativeDir: string): string[] {
  return readdirSync(join(repoRoot, relativeDir)).flatMap((entry) => {
    const relative = join(relativeDir, entry);
    if (statSync(join(repoRoot, relative)).isDirectory()) {
      return sourceFiles(relative);
    }
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [relative] : [];
  });
}

const ALL_APP_SOURCES = [
  ...sourceFiles("lib"),
  ...sourceFiles("components"),
  ...sourceFiles("app"),
  ...sourceFiles("worker"),
];

/**
 * Every surface that can put a modifier-bearing line into a cart.
 *
 * All three mount ProductBrowser (components/editor/pos-layouts/index.tsx),
 * which is the single interception point that opens ModifierSelector — so all
 * three are modifier-capable and all three must be on v3.
 */
const MODIFIER_CAPABLE_SURFACES: { file: string; entryPoint: string }[] = [
  { file: "components/runtime/OwnerPosRuntime.tsx", entryPoint: "completeSaleOrderV3" },
  { file: "components/device/DeviceApp.tsx", entryPoint: "completeDeviceSaleV3" },
  { file: "components/editor/EditorShell.tsx", entryPoint: "completeSaleOrderV3" },
];

/**
 * The retired entry points, and the one module each may be DEFINED in.
 *
 * A reference anywhere else is a live caller.
 */
const RETIRED_ENTRY_POINTS: { name: string; definedIn: string; version: string }[] = [
  { name: "completeSaleOrder", definedIn: "lib/orders.ts", version: "v1" },
  { name: "completeSaleOrderV2", definedIn: "lib/orders.ts", version: "v2" },
  { name: "completeDeviceSale", definedIn: "lib/device.rpc.ts", version: "v2" },
];

/** The raw RPC names, and the one module each may be INVOKED from. */
const RETIRED_RPC_NAMES: { rpc: string; definedIn: string[] }[] = [
  { rpc: 'rpc("complete_sale"', definedIn: ["lib/orders.ts"] },
  { rpc: 'rpc("complete_sale_v2"', definedIn: ["lib/orders.ts", "lib/device.rpc.ts"] },
];

describe("no live modifier-capable surface reaches v1 or v2", () => {
  for (const surface of MODIFIER_CAPABLE_SURFACES) {
    const source = code(read(surface.file));

    it(`${surface.file} calls ${surface.entryPoint}`, () => {
      expect(source).toContain(surface.entryPoint);
    });

    it(`${surface.file} names no retired entry point`, () => {
      for (const retired of RETIRED_ENTRY_POINTS) {
        // Word-boundary with a version lookahead, so completeSaleOrderV3 and
        // completeDeviceSaleV3 are not mistaken for their retired prefixes.
        expect(source).not.toMatch(new RegExp(`\\b${retired.name}\\b(?!V\\d)`));
      }
    });

    it(`${surface.file} invokes no RPC directly`, () => {
      // Every surface goes through a transport wrapper, so a hand-rolled
      // supabase.rpc call here would bypass the whole versioning scheme.
      expect(source).not.toContain('rpc("complete_sale');
    });
  }

  it("all three surfaces are covered", () => {
    // A guard that silently stops covering a surface is worse than no guard.
    expect(MODIFIER_CAPABLE_SURFACES).toHaveLength(3);
  });
});

describe("the retired wrappers are defined but called by nobody", () => {
  for (const retired of RETIRED_ENTRY_POINTS) {
    it(`${retired.name} (${retired.version}) has no caller outside ${retired.definedIn}`, () => {
      const callers = ALL_APP_SOURCES.filter(
        (file) =>
          file !== retired.definedIn &&
          new RegExp(`\\b${retired.name}\\b(?!V\\d)`).test(code(read(file)))
      );

      expect(callers).toEqual([]);
    });

    it(`${retired.name} is still exported, so a rollback stays possible`, () => {
      // Deliberately asserted, not merely tolerated: deleting these would make
      // reverting the rollout a code change rather than a deploy.
      expect(code(read(retired.definedIn))).toContain(`export async function ${retired.name}(`);
    });
  }

  for (const retired of RETIRED_RPC_NAMES) {
    it(`${retired.rpc} is invoked only from ${retired.definedIn.join(" and ")}`, () => {
      const callers = ALL_APP_SOURCES.filter(
        (file) => !retired.definedIn.includes(file) && code(read(file)).includes(retired.rpc)
      );

      expect(callers).toEqual([]);
    });
  }
});

describe("the Builder Preview is pinned to the chosen architecture", () => {
  const shell = code(read("components/editor/EditorShell.tsx"));

  // The Phase 5A decision was v3-PERSISTED, not simulation-only, because this
  // path has persisted real sales since Feature 8.3/9.2 and feeds the Dashboard,
  // Sales Report, Product Performance and Inventory Summary. These assertions
  // pin that decision so neither half of it drifts.

  it("submits through the v3 wrapper", () => {
    expect(shell).toContain("completeSaleOrderV3({");
  });

  it("sends a sale request id, so a lost response replays instead of double-selling", () => {
    expect(shell).toContain("saleRequestId: plan.request.id");
    expect(shell).toContain("planSaleSubmission({");
  });

  it("sends no client-computed money", () => {
    const call = shell.slice(shell.indexOf("completeSaleOrderV3({"));
    const block = call.slice(0, call.indexOf("});"));
    // v1 took all four of these from the client. v3 has nowhere to put them.
    expect(block).not.toContain("subtotal");
    expect(block).not.toContain("taxAmount");
    expect(block).not.toContain("total");
    expect(block).not.toContain("items: cart");
  });

  it("sends no client-generated order number", () => {
    // v1's `${orderPrefix}${1001 + completedOrders.length}` could collide
    // between two open tabs. v3 allocates the number server-side.
    expect(shell).not.toContain("1001 +");
    expect(shell).not.toContain("orderPrefix}$");
  });

  it("fabricates no tip", () => {
    // The former BUILDER_PREVIEW_SAMPLE_TIP = 3 was harmless only while v1
    // ignored nothing and trusted everything. v3 accepts an owner tip, so a
    // hardcoded sample would have become real revenue on every preview sale.
    expect(shell).not.toContain("BUILDER_PREVIEW_SAMPLE_TIP");
    expect(shell).toContain("const BUILDER_PREVIEW_TIP = 0");
    expect(shell).not.toMatch(/tipsEnabled\s*\?/);
  });

  it("keeps the receipt authoritative rather than locally assembled", () => {
    expect(shell).toContain("setLastCompletedReceipt(receipt)");
    expect(shell).toContain("toCompletedOrder(receipt)");
    // The old path built a CompletedOrder from the cart and the client summary.
    expect(shell).not.toMatch(/items:\s*\[\.\.\.cart\]/);
  });

  it("deducts local stock sequentially across lines of one product", () => {
    // complete_sale_v3 writes one inventory_transactions row per LINE, deducting
    // in sequence. Since Phase 3 a cart can hold two lines of one product, so
    // re-reading menuItem.stockQuantity per line would show the same
    // quantityBefore twice and understate the deduction in this session's
    // Inventory Activity, until a reload replaced it with the server's rows.
    expect(shell).toContain("const runningStock = new Map<string, number>()");
    expect(shell).toContain(
      "runningStock.get(item.itemId) ?? menuItem.stockQuantity"
    );
    expect(shell).toContain("runningStock.set(item.itemId, quantityAfter)");
  });

  it("reports item counts and line totals from the receipt, not the cart", () => {
    const totals = shell.slice(shell.indexOf("setOrderTotals("));
    const block = totals.slice(0, totals.indexOf("...prev,"));
    expect(block).toContain("receipt.items.reduce");
    expect(block).toContain("Number(item.lineTotal)");
    expect(block).not.toContain("item.price * item.quantity");
  });

  it("did NOT become a simulation: the persistence surface is intact", () => {
    // Recorded explicitly because "make preview non-persistent" was the other
    // candidate architecture. If a later change removes these, the decision has
    // been reversed and that must be a deliberate, visible act.
    expect(shell).toContain("setCompletedOrders(");
    expect(shell).toContain("setOrderTotals(");
    expect(shell).toContain("setInventoryTransactions(");
  });
});

describe("the shared submission path is the only payload builder", () => {
  const submission = code(read("lib/saleSubmission.ts"));

  it("is pure: no React, no Supabase, no transport", () => {
    for (const banned of ["react", "supabase", "use client", "fetch(", "rpc("]) {
      expect(submission).not.toContain(banned);
    }
  });

  it("both v3 hosts plan through it", () => {
    for (const file of [
      "components/runtime/PosRuntime.tsx",
      "components/editor/EditorShell.tsx",
    ]) {
      expect(code(read(file))).toContain('from "@/lib/saleSubmission"');
    }
  });

  it("the device host reaches it through the shared engine, not its own copy", () => {
    // DeviceApp injects transport into PosRuntime; it must not plan a sale
    // itself, or the device would stop sharing the runtime's rules.
    const device = code(read("components/device/DeviceApp.tsx"));
    expect(device).not.toContain("planSaleSubmission");
    expect(device).toContain("PosRuntime");
  });
});
