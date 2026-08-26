"use client";

// Feature 25.3 Phase 2 — one historical sale, and its receipt.
//
// EVERY VALUE COMES FROM THE STORED ORDER. The item names, unit prices,
// modifiers and totals below were written by the server at sale time and are
// replayed unchanged. Re-pricing a past sale from today's menu would rewrite
// what a customer paid every time the shop edits a price — so the pinned config
// contributes only the business header and receipt settings, never a number.
//
// ONE RECEIPT IMPLEMENTATION. The chain is
//   history DTO -> CompletedSaleReceipt -> toCompletedOrder -> Receipt
// exactly as the till uses at checkout, so a reprint cannot disagree with the
// slip the customer was handed.

import Receipt from "@/components/editor/Receipt";
import { toCompletedOrder } from "@/lib/saleSubmission";
import { toHistoryReceipt } from "@/lib/deviceOrders";
import type { DeviceHistoryOrder } from "@/lib/deviceOrders";
import { isCapacitorNativeShell, NATIVE_PRINT_UNAVAILABLE_MESSAGE } from "@/lib/nativeShell";
import { REPRINT_ACTION } from "@/lib/salesHistoryView";
import type { GeneratedPosConfig } from "@/lib/generatedPosConfig";

type SalesHistoryDetailProps = {
  order: DeviceHistoryOrder;
  config: GeneratedPosConfig;
  onBack: () => void;
};

export default function SalesHistoryDetail({ order, config, onBack }: SalesHistoryDetailProps) {
  // Resolved once per render rather than at module scope: the shell is a runtime
  // fact, and a module-level constant would freeze whatever the first import saw.
  const nativeShell = isCapacitorNativeShell();

  const completed = toCompletedOrder(toHistoryReceipt(order));

  function handleReprint() {
    // Belt and braces: the button is already disabled on Android, and there is
    // no print path there to fall back to. A reprint that appeared to work
    // while doing nothing would be worse than a button that explains itself,
    // which is what the sentence below the button does.
    if (nativeShell) {
      return;
    }

    window.print();
  }

  return (
    <div className="flex min-h-screen flex-col bg-neutral-50 px-6 py-10">
      <div className="mx-auto w-full max-w-md">
        <p className="text-xs font-semibold uppercase tracking-widest text-neutral-400">
          POS Canvas
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-neutral-900">
          {order.orderNumber}
        </h1>

        <div className="mt-6 rounded-2xl border border-neutral-200 bg-white p-4">
          <Receipt
            order={completed}
            businessProfile={config.businessProfile}
            receipt={config.receipt}
          />
        </div>

        <div className="mt-4 flex flex-col gap-2">
          <button
            type="button"
            onClick={handleReprint}
            disabled={nativeShell}
            aria-disabled={nativeShell}
            className="w-full rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm font-semibold text-neutral-700 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white"
          >
            {REPRINT_ACTION}
          </button>

          {/* Shown WITHOUT a press on Android, so the limitation is visible
              rather than discovered. Not colour alone — it is a sentence. */}
          {nativeShell && (
            <p className="text-xs leading-relaxed text-neutral-500">
              {NATIVE_PRINT_UNAVAILABLE_MESSAGE}
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={onBack}
          className="mt-8 w-full rounded-xl border border-neutral-200 bg-white px-4 py-3.5 text-sm font-semibold text-neutral-700 transition-colors hover:bg-neutral-100"
        >
          Back to recent sales
        </button>
      </div>

      {/* The print-only copy. Positioned off-screen on screen and revealed by
          the existing @media print rules in globals.css — the same mechanism the
          checkout receipt uses, so no new print CSS exists for history. */}
      <div className="receipt-print-area">
        <Receipt
          order={completed}
          businessProfile={config.businessProfile}
          receipt={config.receipt}
        />
      </div>
    </div>
  );
}
