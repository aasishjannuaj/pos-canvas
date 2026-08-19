// Feature 24.5E — the provisional receipt, exercised as a pure function.
//
// Everything below runs from (durable record + pinned config), which is exactly
// what a restarted app has. That is not a convenience of the test: it is the
// property the test exists to prove.
import { describe, expect, it } from "vitest";
import {
  OFFLINE_RECEIPT_BANNER,
  OFFLINE_RECEIPT_EXPLANATION,
  OFFLINE_RECEIPT_EXPLANATION_LINES,
  OFFLINE_RECEIPT_REFERENCE_LABEL,
  SYNCED_AS_PREFIX,
  buildProvisionalReceipt,
  describeSyncedAs,
  reconcileQueuedSale,
  toOfflineReference,
} from "@/lib/provisionalReceipt";
import { isFixedDecimalString } from "@/lib/completedSale";
import { calculateCartSummary, createCartItem } from "@/lib/cart";
import { createGeneratedPosConfig } from "@/lib/generatedPosConfig";
import { cloneProjectConfig, defaultProjectConfig } from "@/lib/projectConfig";
import type { GeneratedPosConfig } from "@/lib/generatedPosConfig";
import type { QueueState, QueuedSale } from "@/lib/saleQueue";

const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BUILD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DEVICE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const USER = "11111111-1111-4111-8111-111111111111";
const REQUEST = "7a4b2c9d-1e3f-4a5b-8c6d-9e0f1a2b3c4d";

/** The pinned snapshot, with one modifier-bearing product. */
function pinnedConfig(): GeneratedPosConfig {
  const project = cloneProjectConfig(defaultProjectConfig);

  project.menuItems[0] = {
    ...project.menuItems[0],
    modifierGroups: [
      {
        id: "g-extras",
        name: "Extras",
        selection: "multiple",
        required: false,
        maxSelections: null,
        options: [
          { id: "o-bacon", name: "Extra bacon", priceAdjustment: 1.5 },
          { id: "o-cheese", name: "Extra cheese", priceAdjustment: 0.75 },
        ],
      },
    ],
  };

  return createGeneratedPosConfig(
    {
      projectId: PROJECT,
      projectName: "Cafe A",
      templateId: "restaurant",
      config: project,
    },
    { generatedAt: "2026-08-18T09:00:00.000Z" }
  );
}

function record(overrides: Partial<QueuedSale> = {}): QueuedSale {
  return {
    queueSchemaVersion: 1,
    requestPayloadVersion: 4,
    queueRecordId: "local-1",
    saleRequestId: REQUEST,
    deviceAuthUserId: USER,
    deviceId: DEVICE,
    projectId: PROJECT,
    buildJobId: BUILD,
    paymentMethod: "cash",
    tipAmount: 0,
    items: [{ itemId: "1", quantity: 2, modifiers: [] }],
    occurredAt: "2026-08-19T14:05:00.000Z",
    source: "offline_queued",
    state: "pending",
    queuedAt: "2026-08-19T14:05:00.000Z",
    updatedAt: "2026-08-19T14:05:00.000Z",
    attemptCount: 0,
    lastAttemptAt: null,
    nextAttemptAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    serverOrderId: null,
    serverOrderNumber: null,
    serverCreatedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The approved wording
// ---------------------------------------------------------------------------

describe("the customer-facing wording is exactly what the owner approved", () => {
  it("is the approved text, character for character", () => {
    expect(OFFLINE_RECEIPT_BANNER).toBe("OFFLINE RECEIPT");
    expect(OFFLINE_RECEIPT_REFERENCE_LABEL).toBe("Ref:");
    expect(OFFLINE_RECEIPT_EXPLANATION).toBe(
      "This sale is saved on this device\n" +
        "and will sync when internet is restored.\n" +
        "A final receipt number will be created after sync."
    );
    expect(OFFLINE_RECEIPT_EXPLANATION_LINES).toHaveLength(3);
  });

  it("never suggests the payment might not have gone through", () => {
    // The distinction the owner's decision turns on: the sale is real and
    // complete, and only its receipt NUMBER is still to come. "Unconfirmed",
    // "pending" and "not recorded" all read to a customer as "your card may
    // have been declined".
    const copy = `${OFFLINE_RECEIPT_BANNER}\n${OFFLINE_RECEIPT_EXPLANATION}`.toLowerCase();

    for (const banned of [
      "not yet recorded",
      "unconfirmed",
      "pending",
      "provisional",
      "failed",
      "error",
      "may not",
    ]) {
      expect(`copy says ${banned}`).toBe(`copy says ${banned}`);
      expect(copy).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// The reference
// ---------------------------------------------------------------------------

describe("the offline reference", () => {
  it("is derived from the request id, so it is identical every time", () => {
    expect(toOfflineReference(REQUEST)).toBe(toOfflineReference(REQUEST));
    expect(toOfflineReference(REQUEST)).toMatch(/^OFF-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  });

  it("cannot be mistaken for an order number", () => {
    const reference = toOfflineReference(REQUEST) ?? "";

    expect(reference.startsWith("OFF-")).toBe(true);
    expect(reference).not.toMatch(/^ORD/);
    // A server order number is the receipt prefix plus digits. This is neither.
    expect(reference).not.toMatch(/^[A-Z]+-?\d+$/);
  });

  it("differs between two sales", () => {
    expect(toOfflineReference("00000000-0000-4000-8000-000000000001")).not.toBe(
      toOfflineReference("ffffffff-ffff-4fff-8fff-ffffffffffff")
    );
  });

  it("refuses anything that is not a request id", () => {
    for (const bad of ["", "not-a-uuid", "1234", "7a4b2c9d1e3f4a5b8c6d"]) {
      expect(`reference for ${bad}`).toBe(`reference for ${bad}`);
      expect(toOfflineReference(bad)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Building the receipt
// ---------------------------------------------------------------------------

describe("the receipt is priced from the pinned configuration", () => {
  const config = pinnedConfig();

  it("computes totals with the POS's own tax rules", () => {
    const built = buildProvisionalReceipt({ record: record(), config });

    expect(built.ok).toBe(true);

    if (!built.ok) return;

    // 2 x 6.49 = 12.98, plus the config's own 6.35% tax.
    expect(built.receipt.subtotal).toBe("12.98");
    expect(built.receipt.taxAmount).toBe("0.82");
    expect(built.receipt.total).toBe("13.80");
    expect(built.receipt.tipAmount).toBe("0.00");
  });

  it("prices modifiers from the AUTHORIZED groups, not from the record", () => {
    const built = buildProvisionalReceipt({
      record: record({
        items: [
          {
            itemId: "1",
            quantity: 1,
            modifiers: [{ groupId: "g-extras", optionIds: ["o-bacon", "o-cheese"] }],
          },
        ],
      }),
      config,
    });

    expect(built.ok).toBe(true);

    if (!built.ok) return;

    // 6.49 + 1.50 + 0.75
    expect(built.receipt.items[0].unitPrice).toBe("8.74");
    expect(built.receipt.items[0].lineTotal).toBe("8.74");
    expect(built.receipt.items[0].modifiers.map((entry) => entry.optionName)).toEqual([
      "Extra bacon",
      "Extra cheese",
    ]);
    expect(built.receipt.items[0].modifiers[0].priceAdjustment).toBe("1.50");
    expect(built.receipt.subtotal).toBe("8.74");
  });

  it("emits every money value as a fixed two-decimal string", () => {
    const built = buildProvisionalReceipt({ record: record(), config });

    expect(built.ok).toBe(true);

    if (!built.ok) return;

    for (const value of [
      built.receipt.subtotal,
      built.receipt.taxAmount,
      built.receipt.tipAmount,
      built.receipt.total,
      built.receipt.items[0].unitPrice,
      built.receipt.items[0].lineTotal,
    ]) {
      expect(isFixedDecimalString(value)).toBe(true);
    }
  });

  it("carries the sale time from the record and no server field at all", () => {
    const built = buildProvisionalReceipt({ record: record(), config });

    expect(built.ok).toBe(true);

    if (!built.ok) return;

    expect(built.receipt.occurredAt).toBe("2026-08-19T14:05:00.000Z");
    expect(built.receipt.status).toBe("offline_pending");
    expect(Object.keys(built.receipt)).not.toContain("orderNumber");
    expect(Object.keys(built.receipt)).not.toContain("orderId");
    expect(JSON.stringify(built.receipt)).not.toContain("ORD");
  });

  it("labels a card sale without holding any card data", () => {
    const built = buildProvisionalReceipt({
      record: record({ paymentMethod: "card" }),
      config,
    });

    expect(built.ok).toBe(true);

    if (!built.ok) return;

    expect(built.receipt.paymentMethod).toBe("card");

    const serialized = JSON.stringify(built.receipt).toLowerCase();

    for (const banned of ["cardnumber", "cvv", "cvc", "expiry", "cardholder", "pan"]) {
      expect(`receipt holds ${banned}`).toBe(`receipt holds ${banned}`);
      expect(serialized).not.toContain(banned);
    }
  });

  it("is byte-identical when rebuilt from the same record", () => {
    // The reload path: no cart, no React state, just the record and the config.
    const stored = record();
    const first = buildProvisionalReceipt({ record: stored, config });
    const second = buildProvisionalReceipt({
      record: JSON.parse(JSON.stringify(stored)) as QueuedSale,
      config,
    });

    expect(first).toEqual(second);
  });

  it("refuses rather than half-renders when the config lost an item", () => {
    const built = buildProvisionalReceipt({
      record: record({ items: [{ itemId: "not-on-this-menu", quantity: 1, modifiers: [] }] }),
      config,
    });

    expect(built.ok).toBe(false);

    if (built.ok) return;

    expect(built.reason).toBe("unknown_item");
  });
});

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

describe("reconciliation joins the reference to the order number", () => {
  it("shows nothing server-side while the sale is still waiting", () => {
    const reconciled = reconcileQueuedSale(record());

    expect(reconciled).not.toBeNull();
    expect(reconciled?.synced).toBe(false);
    expect(reconciled?.serverOrderNumber).toBeNull();
    expect(describeSyncedAs(reconciled!)).toBeNull();
  });

  it("shows both identities once the server has recorded it", () => {
    const reconciled = reconcileQueuedSale(
      record({
        state: "synced",
        serverOrderId: "order-1010",
        serverOrderNumber: "ORD1010",
        serverCreatedAt: "2026-08-19T18:40:00.000Z",
      })
    );

    expect(reconciled?.offlineReference).toBe(toOfflineReference(REQUEST));
    expect(reconciled?.synced).toBe(true);
    expect(describeSyncedAs(reconciled!)).toBe(`${SYNCED_AS_PREFIX}ORD1010`);
  });

  it("keeps BOTH times, and never overwrites the sale time with the server's", () => {
    const reconciled = reconcileQueuedSale(
      record({
        state: "synced",
        serverOrderId: "order-1010",
        serverOrderNumber: "ORD1010",
        serverCreatedAt: "2026-08-19T18:40:00.000Z",
      })
    );

    expect(reconciled?.occurredAt).toBe("2026-08-19T14:05:00.000Z");
    expect(reconciled?.serverCreatedAt).toBe("2026-08-19T18:40:00.000Z");
    expect(Date.parse(reconciled!.serverCreatedAt!)).toBeGreaterThan(
      Date.parse(reconciled!.occurredAt)
    );
  });

  it("never presents an unsynced sale as recorded, whatever the record says", () => {
    // Defence in depth: even a record that somehow carried an order number
    // without reaching `synced` must not surface it.
    for (const state of ["pending", "syncing", "needs_attention", "permanent_failure"] as QueueState[]) {
      const reconciled = reconcileQueuedSale(
        record({ state, serverOrderNumber: "ORD9999", serverOrderId: "order-9999" })
      );

      expect(`state ${state} reads as synced`).toBe(`state ${state} reads as synced`);
      expect(reconciled?.synced).toBe(false);
      expect(reconciled?.serverOrderNumber).toBeNull();
      expect(describeSyncedAs(reconciled!)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// The concrete audit: quantity > 1, a modifier adjustment, and tax
// ---------------------------------------------------------------------------

describe("quantity, modifiers and tax add up exactly once", () => {
  const config = pinnedConfig();

  const audited = record({
    items: [
      {
        itemId: "1",
        quantity: 2,
        modifiers: [{ groupId: "g-extras", optionIds: ["o-bacon", "o-cheese"] }],
      },
    ],
  });

  it("computes the one arithmetic this POS has, and no other", () => {
    const built = buildProvisionalReceipt({ record: audited, config });

    expect(built.ok).toBe(true);

    if (!built.ok) return;

    const line = built.receipt.items[0];

    // base 6.49 + bacon 1.50 + cheese 0.75 = 8.74 per unit
    expect(line.unitPrice).toBe("8.74");
    expect(line.quantity).toBe(2);
    // 2 x 8.74 = 17.48 — the modifiers are inside this figure, counted once.
    expect(line.lineTotal).toBe("17.48");
    expect(built.receipt.subtotal).toBe("17.48");
    // 6.35% of 17.48
    expect(built.receipt.taxAmount).toBe("1.11");
    expect(built.receipt.total).toBe("18.59");
  });

  it("matches calculateCartSummary to the cent, because it IS calculateCartSummary", () => {
    // The independent check: build the same cart the POS would hold, run the
    // shared summary function, and require the receipt to agree exactly. If the
    // receipt ever grew its own pricing, this is what would catch it.
    const expected = calculateCartSummary(
      [
        createCartItem(
          config.menuItems[0],
          [
            {
              groupId: "g-extras",
              groupName: "Extras",
              options: [
                { id: "o-bacon", name: "Extra bacon", priceAdjustment: 1.5 },
                { id: "o-cheese", name: "Extra cheese", priceAdjustment: 0.75 },
              ],
            },
          ],
          2
        ),
      ],
      config.tax,
      0
    );

    const built = buildProvisionalReceipt({ record: audited, config });

    expect(built.ok).toBe(true);

    if (!built.ok) return;

    expect(built.receipt.subtotal).toBe(expected.subtotal.toFixed(2));
    expect(built.receipt.taxAmount).toBe(expected.taxAmount.toFixed(2));
    expect(built.receipt.total).toBe(expected.total.toFixed(2));
    expect(built.receipt.tipAmount).toBe(expected.tip.toFixed(2));
  });

  it("does not double-count: the modifier rows are a breakdown, not addends", () => {
    // The rendered receipt shows each option under its line with a "+1.50"
    // annotation, exactly as AuthoritativeReceipt shows the server's own
    // snapshot. That figure is the PER-UNIT adjustment already contained in the
    // line total above it. Adding the annotations to the totals would overstate
    // the sale, so this pins that they are not part of the arithmetic.
    const built = buildProvisionalReceipt({ record: audited, config });

    expect(built.ok).toBe(true);

    if (!built.ok) return;

    const line = built.receipt.items[0];
    const annotations = line.modifiers.reduce(
      (sum, modifier) => sum + Number(modifier.priceAdjustment),
      0
    );

    expect(annotations).toBeCloseTo(2.25, 10);

    // The subtotal is the line total alone. Adding the annotations on top would
    // give 19.73, and adding them per unit would give 21.98; neither appears.
    expect(built.receipt.subtotal).toBe(line.lineTotal);
    expect(built.receipt.subtotal).not.toBe((Number(line.lineTotal) + annotations).toFixed(2));
    expect(built.receipt.total).not.toBe(
      (Number(line.lineTotal) + annotations * line.quantity).toFixed(2)
    );

    // And the line total is exactly unit x quantity — nothing is added twice.
    expect(Number(line.lineTotal)).toBeCloseTo(Number(line.unitPrice) * line.quantity, 10);
  });

  it("keeps the same relationship when tax is inclusive rather than added", () => {
    const inclusive: GeneratedPosConfig = {
      ...config,
      tax: { ...config.tax, pricesIncludeTax: true },
    };

    const built = buildProvisionalReceipt({ record: audited, config: inclusive });

    expect(built.ok).toBe(true);

    if (!built.ok) return;

    // Prices already include tax, so the total equals the subtotal and the tax
    // line is the portion inside it — the shared summary's own rule, unchanged.
    expect(built.receipt.subtotal).toBe("17.48");
    expect(built.receipt.total).toBe("17.48");
    expect(built.receipt.taxAmount).toBe("1.04");
  });
});
