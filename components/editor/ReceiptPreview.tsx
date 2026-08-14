"use client";

import Receipt from "./Receipt";
import type { CompletedOrder, ProjectConfig } from "./EditorShell";

// Feature 11.1 — fixed sample order data for the Settings-tab live preview.
// Local to this module only: it never enters completedOrders state, is never
// passed to any checkout function (Phase 5A: the Builder's checkout is
// completeSaleOrderV3, and this file does not import it or any other), and has
// no persistence path whatsoever.
// orderNumber is deliberately NOT included here — it depends on
// the live receipt.orderPrefix setting, so it's built fresh on every render
// inside the component below instead of being frozen at module load.
const SAMPLE_ORDER_BASE: Omit<CompletedOrder, "orderNumber"> = {
  id: "sample-preview-order",
  items: [
    // Feature 18.2 — sample lines carry the new cart shape. lineKey is the
    // canonical no-modifier form, and basePrice equals price because no sample
    // option is selected.
    { lineKey: "8:sample-1[0]", itemId: "sample-1", name: "Sample Item", basePrice: 6.5, price: 6.5, quantity: 2, modifiers: [] },
    { lineKey: "8:sample-2[0]", itemId: "sample-2", name: "Another Item", basePrice: 3.25, price: 3.25, quantity: 1, modifiers: [] },
  ],
  subtotal: 16.25,
  taxAmount: 1.03,
  tip: 2.0,
  total: 19.28,
  paymentMethod: "card",
  createdAt: new Date().toISOString(),
};

type ReceiptPreviewProps = {
  businessProfile: ProjectConfig["businessProfile"];
  receipt: ProjectConfig["receipt"];
};

export default function ReceiptPreview({
  businessProfile,
  receipt,
}: ReceiptPreviewProps) {
  // Bug fix — this used to be a hardcoded "ORD-1001" baked into a
  // module-level constant, so changing Order Prefix in Settings never
  // updated the preview. Building it here from the live receipt.orderPrefix
  // means it always reflects the current setting immediately.
  const sampleOrder: CompletedOrder = {
    ...SAMPLE_ORDER_BASE,
    orderNumber: `${receipt.orderPrefix}1001`,
  };

  return (
    <div className="flex flex-1 flex-col items-center gap-4 overflow-auto bg-neutral-100 p-10">
      <h2 className="text-lg font-semibold tracking-tight text-neutral-900">
        Receipt Preview
      </h2>

      <p className="max-w-sm text-center text-sm text-neutral-500">
        Sample data — this preview updates immediately as you change receipt
        settings. It never creates a real order.
      </p>

      <div className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
        <Receipt order={sampleOrder} businessProfile={businessProfile} receipt={receipt} />
      </div>
    </div>
  );
}
