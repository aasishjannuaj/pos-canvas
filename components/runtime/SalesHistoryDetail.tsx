"use client";

// Feature 25.3 Phase 2 — one historical sale, and its receipt.
//
// EVERY VALUE COMES FROM THE STORED ORDER. The item names, unit prices,
// modifiers and totals below were written by the server at sale time and are
// replayed unchanged. Re-pricing a past sale from today's menu would rewrite
// what a customer paid every time the shop edits a price.
//
// Feature 28A — ONE RECEIPT COMPONENT, and it is the one the customer's slip
// was printed from.
//
// This screen used to route the canonical receipt through toCompletedOrder into
// the Builder's number-typed Receipt, which parsed the server's fixed-decimal
// strings back into IEEE-754 doubles, recomputed each line as price × quantity,
// and threw away the persisted line_total entirely. The reprint and the
// original slip were therefore two different components reading two different
// models: they disagreed on the date format, on whether email and website
// printed at all, and — for two lines of the same product with different
// options — potentially on the order of the lines themselves.
//
// AuthoritativeReceipt renders the stored strings directly. Nothing on this
// screen multiplies, sums, rounds or reformats a money value.
//
// Feature 28C — the header is the one this sale was taken under, not today's.
// The server resolves it from the build that priced the sale (a device sale) or
// from the order's own receipt_snapshot (an owner sale). An order older than
// both carries neither, and falls back to the current configuration explicitly
// — see resolveReceiptPresentation.

import AuthoritativeReceipt from "@/components/runtime/AuthoritativeReceipt";
import { historyDisplayTime, toHistoryReceipt } from "@/lib/deviceOrders";
import type { DeviceHistoryOrder } from "@/lib/deviceOrders";
import { isCapacitorNativeShell, NATIVE_PRINT_UNAVAILABLE_MESSAGE } from "@/lib/nativeShell";
import { resolveReceiptPresentation } from "@/lib/receiptPresentation";
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

  const receipt = toHistoryReceipt(order);
  const presentation = resolveReceiptPresentation({
    stored: receipt.presentation,
    current: config,
  });
  // occurredAt when the server has one, createdAt otherwise — the same instant
  // the list row shows for this sale, and the one the customer's slip carried.
  const saleTime = historyDisplayTime(order);

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
          <AuthoritativeReceipt
            receipt={receipt}
            presentation={presentation}
            saleTime={saleTime}
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
          checkout receipt uses.

          Feature 28A — SAME COMPONENT, SAME PROPS as the copy above. Not
          "equivalent markup": literally the same three values, so print and
          screen cannot drift apart even in principle.

          Feature 25.5 — data-print-exclusive, because this screen is an overlay
          above a STILL-MOUNTED PosRuntime. If the cashier left a just-completed
          receipt open before opening history, its print area is also in the
          document, and both are absolutely positioned at the same origin: the
          two would overprint into one illegible slip carrying a sale the
          customer never asked for. This marks the historical receipt as the only
          thing that prints while it is on screen. */}
      <div className="receipt-print-area" data-print-exclusive>
        <AuthoritativeReceipt
          receipt={receipt}
          presentation={presentation}
          saleTime={saleTime}
        />
      </div>
    </div>
  );
}
