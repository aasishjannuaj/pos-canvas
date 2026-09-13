// Feature 28 — Receipt Fidelity.
//
// THE CONTRACT UNDER TEST, in one sentence: what the customer is handed must
// match what the cashier saw, what the server charged, what was persisted, and
// what is reprinted months later — and nothing configured after the sale may
// change any of it.
//
// Three parts, one feature:
//   28A  one canonical receipt component and one canonical receipt model
//   28B  client money that agrees with the server (proved in lib/money.test.ts
//        against an independent oracle; exercised end-to-end here)
//   28C  the sale-time presentation and the cart line order, persisted
//
// WHERE THE ASSERTIONS ARE STRUCTURAL, they read the SQL or the component
// source with comments stripped, and every one of them is paired with a
// negative control — prose must never be able to satisfy a guard, and a guard
// that cannot fail is not a guard.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { calculateCartSummary, createCartItem } from "@/lib/cart";
import { isCompletedSaleReceipt, isNonZeroMoney } from "@/lib/completedSale";
import type { CompletedSaleReceipt } from "@/lib/completedSale";
import { parseDeviceHistoryPage, toHistoryReceipt } from "@/lib/deviceOrders";
import { createGeneratedPosConfig } from "@/lib/generatedPosConfig";
import type { GeneratedPosConfig } from "@/lib/generatedPosConfig";
import { buildProvisionalReceipt } from "@/lib/provisionalReceipt";
import { cloneProjectConfig, defaultProjectConfig } from "@/lib/projectConfig";
import {
  currentConfigPresentation,
  resolveReceiptPresentation,
  saleTimePresentation,
  shouldShowChargedLine,
} from "@/lib/receiptPresentation";
import type { QueuedSale } from "@/lib/saleQueue";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf-8");

/** Strips comments, so prose can never satisfy a source assertion. */
function code(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*--.*$/gm, "");
}

const MIGRATION = code(read("supabase/migrations/20260913120000_receipt_fidelity.sql"));

const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REQUEST = "7a4b2c9d-1e3f-4a5b-8c6d-9e0f1a2b3c4d";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type ConfigOverrides = {
  itemName?: string;
  itemPrice?: number;
  baconPrice?: number;
  taxRate?: number;
  taxEnabled?: boolean;
  businessName?: string;
  footer?: string;
  headerMessage?: string;
  showTaxLine?: boolean;
};

function makeConfig(overrides: ConfigOverrides = {}): GeneratedPosConfig {
  const project = cloneProjectConfig(defaultProjectConfig);

  project.menuItems = [
    {
      id: "item-latte",
      name: overrides.itemName ?? "Latte",
      price: overrides.itemPrice ?? 4.5,
      category: "Drinks",
      trackInventory: false,
      stockQuantity: 0,
      modifierGroups: [
        {
          id: "g-milk",
          name: "Milk",
          selection: "single",
          required: false,
          maxSelections: null,
          options: [
            { id: "o-oat", name: "Oat", priceAdjustment: overrides.baconPrice ?? 0.5 },
            { id: "o-soy", name: "Soy", priceAdjustment: 0.75 },
          ],
        },
      ],
    },
    {
      id: "item-muffin",
      name: "Muffin",
      price: 3.25,
      category: "Food",
      trackInventory: false,
      stockQuantity: 0,
    },
  ];

  project.tax = {
    ...project.tax,
    enabled: overrides.taxEnabled ?? true,
    rate: overrides.taxRate ?? 5,
    pricesIncludeTax: false,
  };

  project.businessProfile = {
    ...project.businessProfile,
    businessName: overrides.businessName ?? "Cafe Aurora",
    addressLine1: "12 Mill Lane",
    city: "Brighton",
    phone: "01273 000000",
  };

  project.receipt = {
    ...project.receipt,
    footer: overrides.footer ?? "Thanks for visiting!",
    headerMessage: overrides.headerMessage ?? "",
    showTaxLine: overrides.showTaxLine ?? true,
  };

  return createGeneratedPosConfig(
    { projectId: PROJECT, projectName: "Aurora", templateId: "cafe", config: project },
    { generatedAt: "2026-09-01T09:00:00.000Z" }
  );
}

/** A presentation snapshot in the shape the server returns it. */
function storedPresentation(config: GeneratedPosConfig): unknown {
  return JSON.parse(
    JSON.stringify({ businessProfile: config.businessProfile, receipt: config.receipt })
  );
}

function queued(overrides: Partial<QueuedSale> = {}): QueuedSale {
  return {
    queueRecordId: "q-1",
    saleRequestId: REQUEST,
    projectId: PROJECT,
    occurredAt: "2026-09-02T10:15:00.000Z",
    paymentMethod: "cash",
    tipAmount: 0,
    items: [{ itemId: "item-latte", quantity: 1, modifiers: [] }],
    state: "pending",
    attemptCount: 0,
    serverOrderId: null,
    serverOrderNumber: null,
    serverCreatedAt: null,
    ...overrides,
  } as QueuedSale;
}

/** One history page exactly as get_device_recent_orders builds it. */
function historyPage(order: Record<string, unknown>) {
  return {
    ok: true,
    orders: [
      {
        orderId: "11111111-1111-4111-8111-111111111111",
        orderNumber: "ORD-1042",
        paymentMethod: "cash",
        subtotal: "5.00",
        taxAmount: "0.25",
        tipAmount: "0.00",
        total: "5.25",
        createdAt: "2026-09-02T10:16:00Z",
        occurredAt: null,
        source: "online",
        presentation: null,
        items: [
          {
            itemId: "item-latte",
            itemName: "Latte",
            unitPrice: "5.00",
            quantity: 1,
            lineTotal: "5.00",
            modifiers: [],
          },
        ],
        ...order,
      },
    ],
    nextCursor: null,
  };
}

// ---------------------------------------------------------------------------
// 28B — the cart, the charge and the offline slip agree
// ---------------------------------------------------------------------------

describe("what the cashier sees is what the server will charge", () => {
  it("a single item", () => {
    const config = makeConfig({ itemPrice: 4.5, taxRate: 13 });
    const cart = [createCartItem(config.menuItems[0], [], 1)];
    const summary = calculateCartSummary(cart, config.tax, 0);

    expect(summary.subtotal).toBe("4.50");
    expect(summary.taxAmount).toBe("0.59");
    expect(summary.total).toBe("5.09");
    expect(summary.itemCount).toBe(1);
  });

  it("a quantity greater than one", () => {
    const config = makeConfig({ itemPrice: 2.3, taxRate: 5 });
    const cart = [createCartItem(config.menuItems[0], [], 3)];
    const summary = calculateCartSummary(cart, config.tax, 0);

    expect(summary.subtotal).toBe("6.90");
    expect(summary.taxAmount).toBe("0.35");
    expect(summary.total).toBe("7.25");
    expect(summary.itemCount).toBe(3);
  });

  it("multiple items", () => {
    const config = makeConfig({ itemPrice: 4.5, taxRate: 5 });
    const cart = [
      createCartItem(config.menuItems[0], [], 1),
      createCartItem(config.menuItems[1], [], 2),
    ];
    const summary = calculateCartSummary(cart, config.tax, 0);

    expect(summary.subtotal).toBe("11.00");
    expect(summary.total).toBe("11.55");
  });

  it("the same item twice with different modifiers stays two lines", () => {
    const config = makeConfig({ itemPrice: 4.5, taxRate: 5 });
    const milk = config.menuItems[0].modifierGroups![0];
    const oat = [{ groupId: "g-milk", groupName: "Milk", options: [milk.options[0]] }];
    const soy = [{ groupId: "g-milk", groupName: "Milk", options: [milk.options[1]] }];

    const cart = [
      createCartItem(config.menuItems[0], oat, 1),
      createCartItem(config.menuItems[0], soy, 1),
    ];

    // Different line identities, so neither can silently absorb the other.
    expect(cart[0].lineKey).not.toBe(cart[1].lineKey);

    const summary = calculateCartSummary(cart, config.tax, 0);

    // 5.00 + 5.25
    expect(summary.subtotal).toBe("10.25");
    expect(summary.total).toBe("10.76");
  });

  it("a zero-tax sale charges nothing extra", () => {
    const config = makeConfig({ itemPrice: 4.5, taxEnabled: false });
    const summary = calculateCartSummary(
      [createCartItem(config.menuItems[0], [], 2)],
      config.tax,
      0
    );

    expect(summary.subtotal).toBe("9.00");
    expect(summary.taxAmount).toBe("0.00");
    expect(summary.total).toBe("9.00");
  });

  it("the visible lines always add up to the visible total", () => {
    // The property the old float math could not hold. Checked across a range
    // rather than at one point.
    for (const rate of [5, 6.35, 7.5, 8.25, 10, 13]) {
      const config = makeConfig({ taxRate: rate });

      for (let cents = 1; cents <= 400; cents += 1) {
        const item = { ...config.menuItems[0], price: cents / 100 };
        const summary = calculateCartSummary(
          [createCartItem(item, [], 1)],
          config.tax,
          0
        );

        expect(
          (Number(summary.subtotal) + Number(summary.taxAmount)).toFixed(2)
        ).toBe(summary.total);
      }
    }
  });

  it("NEGATIVE CONTROL: the old float math broke that property", () => {
    const subtotal = 2.3;
    const taxAmount = subtotal * (5 / 100);

    expect(
      (subtotal + Number(taxAmount.toFixed(2))).toFixed(2)
    ).not.toBe((subtotal + taxAmount).toFixed(2));
  });
});

describe("the offline slip carries the money the server will record", () => {
  it("its totals are the cart's totals, to the cent", () => {
    const config = makeConfig({ itemPrice: 2.3, taxRate: 5 });
    const built = buildProvisionalReceipt({ record: queued(), config });

    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const summary = calculateCartSummary(
      [createCartItem(config.menuItems[0], [], 1)],
      config.tax,
      0
    );

    expect(built.receipt.subtotal).toBe(summary.subtotal);
    expect(built.receipt.taxAmount).toBe(summary.taxAmount);
    expect(built.receipt.total).toBe(summary.total);
    // And the figure the server will compute for the same sale.
    expect(built.receipt.taxAmount).toBe("0.12");
    expect(built.receipt.total).toBe("2.42");
  });

  it("prices a modified line the way the server will", () => {
    const config = makeConfig({ itemPrice: 4.5, baconPrice: 0.5, taxRate: 5 });
    const built = buildProvisionalReceipt({
      record: queued({
        items: [
          { itemId: "item-latte", quantity: 2, modifiers: [{ groupId: "g-milk", optionIds: ["o-oat"] }] },
        ],
      }),
      config,
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.receipt.items[0].unitPrice).toBe("5.00");
    expect(built.receipt.items[0].lineTotal).toBe("10.00");
    expect(built.receipt.total).toBe("10.50");
  });

  it("rounds the unit price BEFORE multiplying, as the server does", () => {
    const config = makeConfig({ itemPrice: 0.155, taxEnabled: false });
    const built = buildProvisionalReceipt({
      record: queued({ items: [{ itemId: "item-latte", quantity: 3, modifiers: [] }] }),
      config,
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.receipt.items[0].unitPrice).toBe("0.16");
    expect(built.receipt.items[0].lineTotal).toBe("0.48");
    expect(built.receipt.total).toBe("0.48");
  });

  it("NEGATIVE CONTROL: every float route to that line is a cent short", () => {
    // Multiply-then-round: 0.46. Round-then-multiply with toFixed: 0.45,
    // because 0.155 is stored as 0.15499999999999999889 and toFixed rounds it
    // DOWN where PostgreSQL's round(0.155, 2) rounds half away from zero to
    // 0.16. Both are wrong, and they are wrong by different amounts.
    expect((0.155 * 3).toFixed(2)).toBe("0.46");
    expect((0.155).toFixed(2)).toBe("0.15");
    expect((Number((0.155).toFixed(2)) * 3).toFixed(2)).toBe("0.45");
  });

  it("records the payment method it was taken with, cash or card", () => {
    const config = makeConfig();

    for (const paymentMethod of ["cash", "card"] as const) {
      const built = buildProvisionalReceipt({ record: queued({ paymentMethod }), config });

      expect(built.ok).toBe(true);
      if (!built.ok) return;

      expect(built.receipt.paymentMethod).toBe(paymentMethod);
    }
  });
});

// ---------------------------------------------------------------------------
// 28C — the presentation is the sale's, not today's
// ---------------------------------------------------------------------------

describe("a historical receipt is printed with the sale's own settings", () => {
  const atSaleTime = makeConfig({
    businessName: "Cafe Aurora",
    footer: "Thanks for visiting!",
    headerMessage: "",
  });
  const today = makeConfig({
    businessName: "Aurora Coffee Co",
    footer: "See you soon",
    headerMessage: "NOW OPEN LATE",
    itemName: "Flat White",
    itemPrice: 9.99,
    taxRate: 20,
    showTaxLine: false,
  });

  it("uses the stored snapshot over the current configuration", () => {
    const resolved = resolveReceiptPresentation({
      stored: storedPresentation(atSaleTime),
      current: today,
    });

    expect(resolved.source).toBe("sale_time");
    expect(resolved.businessProfile.businessName).toBe("Cafe Aurora");
    expect(resolved.receipt.footer).toBe("Thanks for visiting!");
    expect(resolved.receipt.headerMessage).toBe("");
  });

  it("a business rename, a new footer and a new header do not reach it", () => {
    const resolved = resolveReceiptPresentation({
      stored: storedPresentation(atSaleTime),
      current: today,
    });

    expect(resolved.businessProfile.businessName).not.toBe(today.businessProfile.businessName);
    expect(resolved.receipt.footer).not.toBe(today.receipt.footer);
    expect(resolved.receipt.headerMessage).not.toBe(today.receipt.headerMessage);
  });

  it("NEGATIVE CONTROL: without a snapshot it IS today's, and says so", () => {
    // This is the old behaviour, and the test proves the difference is real
    // rather than an artefact of the fixtures being identical.
    const resolved = resolveReceiptPresentation({ stored: null, current: today });

    expect(resolved.source).toBe("current");
    expect(resolved.businessProfile.businessName).toBe("Aurora Coffee Co");
  });

  it("falls back rather than printing half a snapshot", () => {
    for (const broken of [
      undefined,
      null,
      42,
      "nope",
      [],
      {},
      { businessProfile: { businessName: "Half" } },
      { receipt: { footer: "Half" } },
      { businessProfile: "x", receipt: {} },
    ]) {
      expect(
        resolveReceiptPresentation({ stored: broken, current: today }).source
      ).toBe("current");
    }
  });

  it("normalizes a snapshot missing a toggle instead of losing the receipt", () => {
    // Display settings are not money: a missing field costs a toggle, not the
    // whole slip. lib/completedSale.ts refuses malformed MONEY, and must.
    const resolved = resolveReceiptPresentation({
      stored: { businessProfile: { businessName: "Old Name" }, receipt: { currency: "GBP" } },
      current: today,
    });

    expect(resolved.source).toBe("sale_time");
    expect(resolved.businessProfile.businessName).toBe("Old Name");
    expect(resolved.businessProfile.city).toBe("");
    expect(resolved.currencySymbol).toBe("£");
    expect(resolved.receipt.showTaxLine).toBe(defaultProjectConfig.receipt.showTaxLine);
  });

  it("takes the currency symbol from the same place as the settings", () => {
    // Three independently-passed props could disagree; one resolved value
    // cannot.
    const gbp = makeConfig();
    gbp.receipt.currency = "GBP";

    expect(saleTimePresentation(gbp).currencySymbol).toBe("£");
    expect(currentConfigPresentation(gbp).currencySymbol).toBe("£");
    expect(
      resolveReceiptPresentation({ stored: storedPresentation(gbp), current: today })
        .currencySymbol
    ).toBe("£");
  });
});

describe("money that reaches the Total is always shown", () => {
  // DEFECT-1, found in staging QA and fixed here. The first implementation let
  // a sale-time showTaxLine=false hide a CHARGED tax line, and staging order
  // ORD-1008 duly printed Subtotal $10.00 over Total $12.00 with no Tax row
  // while $2.00 of tax had been charged. A display setting must never be able
  // to produce a slip whose visible lines cannot reach its own Total.

  it("renders a charged tax line even when the SALE-TIME toggle was off", () => {
    expect(shouldShowChargedLine({ amount: "2.00" })).toBe(true);
  });

  it("renders a charged tip line even when the SALE-TIME toggle was off", () => {
    expect(shouldShowChargedLine({ amount: "1.50" })).toBe(true);
  });

  it("renders a charged tax line when only TODAY'S toggle exists and is off", () => {
    // The pre-migration case: no snapshot, so the fallback is current config.
    expect(shouldShowChargedLine({ amount: "0.22" })).toBe(true);
  });

  it("may still hide a zero tax line", () => {
    expect(shouldShowChargedLine({ amount: "0.00" })).toBe(false);
    expect(shouldShowChargedLine({ amount: "-0.00" })).toBe(false);
  });

  it("may still hide a zero tip line", () => {
    expect(shouldShowChargedLine({ amount: "0.00" })).toBe(false);
  });

  it("the visible components reconcile to the Total", () => {
    // The property DEFECT-1 violated, asserted directly: for any stored order,
    // whatever the toggles said, subtotal + every shown line == total.
    const orders = [
      // ORD-1008 as staging actually stored it, with its sale-time toggle off.
      { subtotal: "10.00", tax: "2.00", tip: "0.00", total: "12.00" },
      { subtotal: "2.30", tax: "0.12", tip: "0.00", total: "2.42" },
      { subtotal: "7.00", tax: "0.00", tip: "0.00", total: "7.00" },
      { subtotal: "9.25", tax: "0.59", tip: "0.00", total: "9.84" },
      { subtotal: "20.00", tax: "1.00", tip: "3.00", total: "24.00" },
    ];

    for (const order of orders) {
      const shownTax = shouldShowChargedLine({ amount: order.tax }) ? order.tax : "0.00";
      const shownTip = shouldShowChargedLine({ amount: order.tip }) ? order.tip : "0.00";
      const reconciled = (
        Number(order.subtotal) + Number(shownTax) + Number(shownTip)
      ).toFixed(2);

      expect(`${order.total}: ${reconciled}`).toBe(`${order.total}: ${order.total}`);
    }
  });

  it("NEGATIVE CONTROL: the rule this replaced could not reconcile", () => {
    // The exact logic that shipped into staging QA, kept so the regression has
    // a name. Given ORD-1008 it hides $2.00 and the slip stops adding up.
    const oldRule = (amount: string, setting: boolean, source: "sale_time" | "current") =>
      isNonZeroMoney(amount) && (source === "current" ? true : setting);

    expect(oldRule("2.00", false, "sale_time")).toBe(false);
    expect(shouldShowChargedLine({ amount: "2.00" })).toBe(true);

    const shown = oldRule("2.00", false, "sale_time") ? 2 : 0;
    expect((10 + shown).toFixed(2)).not.toBe("12.00");
  });

  it("both receipt components go through that rule, with no toggle left in the gate", () => {
    for (const file of [
      "components/runtime/AuthoritativeReceipt.tsx",
      "components/runtime/OfflineReceipt.tsx",
    ]) {
      const source = code(read(file));

      expect(`${file}: ${(source.match(/shouldShowChargedLine\(\{/g) ?? []).length}`).toBe(
        `${file}: 2`
      );
      // No toggle may gate a money line any more — in either direction.
      for (const forbidden of [
        "receiptSettings.showTaxLine &&",
        "receiptSettings.showTipLine &&",
        "setting: receiptSettings",
        "source: presentation.source",
      ]) {
        expect(`${file} contains ${forbidden}`).toBe(
          source.includes(forbidden) ? `${file} STILL contains ${forbidden}` : `${file} contains ${forbidden}`
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 28A — one canonical receipt, printed and on screen
// ---------------------------------------------------------------------------

describe("the reprint is the same receipt, not a second rendering of it", () => {
  const detail = code(read("components/runtime/SalesHistoryDetail.tsx"));
  const authoritative = code(read("components/runtime/AuthoritativeReceipt.tsx"));

  it("renders AuthoritativeReceipt, never the number-typed preview Receipt", () => {
    expect(detail).toContain("<AuthoritativeReceipt");
    expect(detail).not.toContain('from "@/components/editor/Receipt"');
    expect(detail).not.toContain("toCompletedOrder");
  });

  it("print and screen receive the SAME values, not equivalent ones", () => {
    expect(detail.match(/<AuthoritativeReceipt/g)).toHaveLength(2);
    expect(detail.match(/receipt=\{receipt\}/g)).toHaveLength(2);
    expect(detail.match(/presentation=\{presentation\}/g)).toHaveLength(2);
  });

  it("NEGATIVE CONTROL: the Builder's preview Receipt still recomputes", () => {
    // It is allowed to: it renders a FABRICATED sample in ReceiptPreview and
    // prices nothing. This asserts the two components are still different in
    // exactly the way that makes keeping them apart worthwhile — if this ever
    // stops being true, the preview has quietly become a receipt renderer.
    const preview = code(read("components/editor/Receipt.tsx"));

    expect(preview).toContain("(item.price * item.quantity).toFixed(2)");
    expect(authoritative).not.toContain("toFixed");
    expect(authoritative).toContain("{item.lineTotal}");
  });

  it("no real sale can reach the preview Receipt any more", () => {
    for (const file of [
      "components/runtime/PosCheckoutPanel.tsx",
      "components/runtime/PosRuntime.tsx",
      "components/editor/EditorPreview.tsx",
      "components/runtime/SalesHistoryDetail.tsx",
    ]) {
      expect(`${file}: ${code(read(file)).includes("editor/Receipt")}`).toBe(
        `${file}: false`
      );
    }

    // The one legitimate consumer, and its data is invented in the file itself.
    expect(code(read("components/editor/ReceiptPreview.tsx"))).toContain("SAMPLE_ORDER_BASE");
  });

  it("the canonical component never derives a money value", () => {
    for (const forbidden of ["toFixed", "* item.quantity", "reduce(", "Number("]) {
      expect(`AuthoritativeReceipt: ${authoritative.includes(forbidden)}`).toBe(
        `AuthoritativeReceipt: false`
      );
    }

    expect(authoritative).toContain("{receipt.subtotal}");
    expect(authoritative).toContain("{receipt.total}");
  });

  it("the owner's loader reads stored money and the stored line total", () => {
    const server = code(read("lib/orders.server.ts"));

    expect(server).toContain("storedMoneyToFixedString(orderItem.line_total)");
    expect(server).toContain("storedMoneyToFixedString(row.total)");
    expect(server).not.toContain("createHistoricalCartItem(");
  });
});

describe("the order total IS the receipt total", () => {
  it("every figure on a history receipt comes from the payload unchanged", () => {
    const parsed = parseDeviceHistoryPage(
      historyPage({
        subtotal: "10.25",
        taxAmount: "0.51",
        tipAmount: "0.00",
        total: "10.76",
        items: [
          { itemId: "item-latte", itemName: "Latte", unitPrice: "5.00", quantity: 1, lineTotal: "5.00", modifiers: [] },
          { itemId: "item-latte", itemName: "Latte", unitPrice: "5.25", quantity: 1, lineTotal: "5.25", modifiers: [] },
        ],
      })
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const receipt = toHistoryReceipt(parsed.page.orders[0]);
    const lineSum = receipt.items.reduce((sum, item) => sum + Number(item.lineTotal), 0);

    expect(lineSum.toFixed(2)).toBe(receipt.subtotal);
    expect((Number(receipt.subtotal) + Number(receipt.taxAmount)).toFixed(2)).toBe(
      receipt.total
    );
  });

  it("refuses a payload whose money is not stored money", () => {
    // The reject-rather-than-coerce rule, still in force for every figure.
    for (const bad of [{ total: "10.7" }, { total: 10.76 }, { subtotal: "abc" }]) {
      expect(parseDeviceHistoryPage(historyPage(bad)).ok).toBe(false);
    }
  });

  it("carries the presentation through to the renderer untouched", () => {
    const presentation = storedPresentation(makeConfig({ businessName: "Cafe Aurora" }));
    const parsed = parseDeviceHistoryPage(historyPage({ presentation }));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const receipt: CompletedSaleReceipt = toHistoryReceipt(parsed.page.orders[0]);

    expect(
      resolveReceiptPresentation({ stored: receipt.presentation, current: makeConfig() })
        .businessProfile.businessName
    ).toBe("Cafe Aurora");
  });

  it("an absent presentation is still a valid receipt", () => {
    // Every order predating Feature 28C. It must render, not fail.
    const parsed = parseDeviceHistoryPage(historyPage({ presentation: null }));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(isCompletedSaleReceipt(parsed.page.orders[0])).toBe(true);
    expect(
      resolveReceiptPresentation({
        stored: parsed.page.orders[0].presentation,
        current: makeConfig(),
      }).source
    ).toBe("current");
  });

  it("does not re-sort the lines the server sent", () => {
    // The client must not have an ordering opinion; the server's is the one
    // both the slip and the reprint were built from.
    const items = [
      { itemId: "b-item", itemName: "Second", unitPrice: "1.00", quantity: 1, lineTotal: "1.00", modifiers: [] },
      { itemId: "a-item", itemName: "First", unitPrice: "4.00", quantity: 1, lineTotal: "4.00", modifiers: [] },
    ];
    const parsed = parseDeviceHistoryPage(historyPage({ items, subtotal: "5.00" }));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.page.orders[0].items.map((item) => item.itemName)).toEqual([
      "Second",
      "First",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 28C — the migration's contract
// ---------------------------------------------------------------------------

describe("the sale records what it was priced and printed with", () => {
  it("adds both columns, nullable and without a backfill", () => {
    expect(MIGRATION).toContain("add column if not exists receipt_snapshot jsonb");
    expect(MIGRATION).toContain("add column if not exists line_position integer");
    // A backfill would be inventing values nobody recorded.
    expect(MIGRATION).not.toMatch(/update\s+public\.orders\s+set\s+receipt_snapshot/i);
    expect(MIGRATION).not.toMatch(/update\s+public\.order_items\s+set\s+line_position/i);
    expect(MIGRATION).not.toMatch(/receipt_snapshot\s+jsonb\s+not\s+null/i);
    expect(MIGRATION).not.toMatch(/line_position\s+integer\s+not\s+null/i);
  });

  it("all four sale paths write both, not just the newest", () => {
    // Asserted against the INSERT STATEMENTS, not merely against the presence
    // of the words somewhere in the function. A first version of this guard
    // passed while complete_sale_v2 had lost line_position from its insert
    // entirely, because the ORDER BY further down still mentioned the column.
    for (const fn of [
      "public.complete_sale(",
      "public.complete_sale_v2(",
      "public.complete_sale_v3(",
      "public.complete_sale_v4(",
    ]) {
      const start = MIGRATION.indexOf(`CREATE OR REPLACE FUNCTION ${fn}`);

      expect(`${fn} is replaced`).toBe(start > -1 ? `${fn} is replaced` : "missing");

      const body = MIGRATION.slice(start, MIGRATION.indexOf("$function$;", start));

      const ordersInsert = body.slice(
        body.indexOf("insert into public.orders ("),
        body.indexOf("returning id into v_order_id")
      );
      const itemsInsert = body.slice(
        body.indexOf("insert into public.order_items ("),
        body.indexOf("insert into public.inventory_transactions (")
      );

      for (const [label, haystack, needle] of [
        ["orders column", ordersInsert, "receipt_snapshot"],
        ["orders value", ordersInsert, "v_receipt_snapshot"],
        ["items column", itemsInsert, "line_position"],
        ["items value", itemsInsert, "line_no::integer"],
        ["items ordinality", itemsInsert, "with ordinality as t(line, line_no)"],
      ] as const) {
        expect(`${fn} ${label}`).toBe(
          haystack.includes(needle) ? `${fn} ${label}` : `${fn} ${label} MISSING`
        );
      }
    }
  });

  it("captures the snapshot on the OWNER branch only", () => {
    // A device sale already points at an immutable config_snapshot through
    // build_job_id. A second copy would be a second answer to one question.
    for (const fn of [
      "public.complete_sale(",
      "public.complete_sale_v2(",
      "public.complete_sale_v3(",
      "public.complete_sale_v4(",
    ]) {
      const start = MIGRATION.indexOf(`CREATE OR REPLACE FUNCTION ${fn}`);
      const body = MIGRATION.slice(start, MIGRATION.indexOf("$function$;", start));

      const assignment = body.indexOf("v_receipt_snapshot := jsonb_build_object(");
      // The owner branch that CONTAINS the assignment — v1 has several
      // `if v_is_owner then` blocks (tip rules, tax rules), so the last one in
      // the file is not necessarily the pricing one.
      const ownerBranch = body.lastIndexOf("if v_is_owner then", assignment);
      // The device branch of that same if/else, where the build snapshot is read.
      const deviceBranch = body.indexOf("select b.config_snapshot", assignment);

      expect(`${fn} assigns inside the owner branch`).toBe(
        ownerBranch > -1 && assignment > ownerBranch && assignment < deviceBranch
          ? `${fn} assigns inside the owner branch`
          : `${fn} assigns somewhere else`
      );

      // Exactly one assignment per function — a second one would be a path
      // where a device sale also wrote a copy.
      expect(`${fn}: ${(body.match(/v_receipt_snapshot :=/g) ?? []).length}`).toBe(`${fn}: 1`);
    }

    // And it is only ever built from the live config, never from a build's.
    expect(MIGRATION).not.toMatch(
      /v_receipt_snapshot := jsonb_build_object\(\s*'businessProfile', coalesce\(v_(snapshot|source)/
    );
  });

  it("orders lines by cart position, with a deterministic fallback", () => {
    const orderings = MIGRATION.match(/order by oi\.line_position nulls last,\s+oi\.item_id collate "C",\s+oi\.id/g);

    // Three complete_sale payloads plus get_device_recent_orders.
    expect(orderings).toHaveLength(4);
    // item_id alone is not a total order and must never be the whole rule again.
    expect(MIGRATION).not.toMatch(/order by oi\.item_id collate "C"\s*\n\s*\)/);
  });

  it("resolves presentation from the build first, the order second, null last", () => {
    const history = MIGRATION.slice(
      MIGRATION.indexOf("create or replace function public.get_device_recent_orders")
    );

    expect(history).toContain("'presentation', coalesce(");
    expect(history).toContain("from public.build_jobs b");
    expect(history).toContain("where b.id = o.build_job_id");
    expect(history).toContain("o.receipt_snapshot");
    // Both halves or nothing — half a snapshot is a receipt that never existed.
    expect(history).toContain("when b.config_snapshot ? 'businessProfile'");
    expect(history).toContain("and b.config_snapshot ? 'receipt'");
  });

  it("changes no pricing, privilege or scoping rule", () => {
    // The blast radius claim, asserted rather than promised.
    expect(MIGRATION).not.toMatch(/\bgrant\b/i);
    expect(MIGRATION).not.toMatch(/\brevoke\b/i);
    expect(MIGRATION).not.toContain("p_project_id uuid default");
    expect(MIGRATION).not.toMatch(/drop\s+(table|column|function|policy|trigger)/i);
    // Pricing still comes from the authorized source, never from the caller.
    expect(MIGRATION).toContain("select b.config_snapshot into v_source");
  });

  it("NEGATIVE CONTROL: the assertions above read SQL, not prose", () => {
    // MIGRATION is comment-stripped, so the file's own explanation of what it
    // does cannot satisfy any guard in this block.
    const raw = read("supabase/migrations/20260913120000_receipt_fidelity.sql");

    expect(raw).toContain("-- Feature 28C");
    expect(MIGRATION).not.toContain("-- Feature 28C");
    expect(raw.length).toBeGreaterThan(MIGRATION.length);
  });
});
