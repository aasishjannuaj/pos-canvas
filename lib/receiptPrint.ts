// v1.3.4 Direct receipt printing — the renderer side.
//
// THE ONLY READER OF window.posCanvasReceiptPrint. The Windows shell's
// preload exposes it only to its packaged runtime (app://poscanvas). There it
// prints straight to the receipt printer with no print window; everywhere else
// (a browser, the Builder, the owner app) this is plain window.print().
//
// FIRE AND FORGET, like window.print(): nothing is awaited by the caller and no
// success is ever shown — the paper is the only confirmation.
//
// NEVER TWO RECEIPTS. The print window is opened as a fallback only when the
// shell answers that nothing was printed ("unavailable", "failed"). Any other
// answer, a rejection after the call, or a malformed reply is final: the job
// may have reached the printer, and the cashier can always tap again.

export type ReceiptPrintBridge = () => Promise<unknown>;

/** The bridge's function, or null unless `value` is exactly the preload's shape. */
export function detectReceiptPrintBridge(value: unknown): ReceiptPrintBridge | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const print = (value as { printReceipt?: unknown }).printReceipt;

  return typeof print === "function" ? (print as ReceiptPrintBridge) : null;
}

/** True only for the answers that mean no job was sent. */
export function shouldFallBackToPrintWindow(outcome: unknown): boolean {
  return outcome === "unavailable" || outcome === "failed";
}

/**
 * Prints the page's current print area. `bridge` and `openPrintWindow` are
 * injectable for tests; the defaults read the real window.
 */
export function printPage(
  options: {
    bridge?: ReceiptPrintBridge | null;
    openPrintWindow?: () => void;
  } = {}
): void {
  const openPrintWindow = options.openPrintWindow ?? (() => window.print());
  const bridge =
    options.bridge !== undefined
      ? options.bridge
      : typeof window === "undefined"
        ? null
        : detectReceiptPrintBridge(
            (window as unknown as { posCanvasReceiptPrint?: unknown }).posCanvasReceiptPrint
          );

  if (bridge === null) {
    openPrintWindow();
    return;
  }

  let reply: Promise<unknown>;

  try {
    reply = Promise.resolve(bridge());
  } catch {
    // Threw before any request left the renderer: nothing was printed.
    openPrintWindow();
    return;
  }

  reply.then(
    (outcome) => {
      if (shouldFallBackToPrintWindow(outcome)) {
        openPrintWindow();
      }
    },
    () => {
      // The request may have reached the printer. Final, never re-sent.
    }
  );
}
