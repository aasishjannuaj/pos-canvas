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
    <div className="flex min-h-screen flex-col bg-neutral-50">
      {/* RC-polish — the way back is at the top and stays there. It was a
          full-width button below the receipt and the reprint action, which on a
          long receipt meant scrolling to leave.

          It is ordinary screen chrome, and the print rules in globals.css hide
          everything outside .receipt-print-area, so none of this reaches paper. */}
      <div className="sticky top-0 z-10 flex-none border-b border-neutral-200 bg-white">
        <div className="mx-auto flex w-full max-w-md items-center justify-between gap-4 px-6 py-3">
          <button
            type="button"
            onClick={onBack}
            className="-ml-2 inline-flex flex-none items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-semibold text-neutral-700 transition-colors hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400"
          >
            {/* Drawn, not typed: a glyph renders differently across the Android
                WebView and the Windows shell. */}
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 16 6 10l6-6" />
            </svg>
            Back to recent sales
          </button>

          <div className="min-w-0 text-right">
            <p className="truncate text-sm font-semibold tracking-tight text-neutral-900">
              {order.orderNumber}
            </p>
            <p className="truncate text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
              POS Canvas
            </p>
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-md px-6 py-6">
        <div className="rounded-2xl border border-neutral-200 bg-white p-4">
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
