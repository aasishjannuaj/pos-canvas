// v1.3.4 Direct receipt printing — the main-process side.
//
// THE OWNER'S ASK. "Print Receipt" printed through the Windows print window,
// where the cashier had to pick the printer every time. On the Windows till it
// now prints the page straight away with webContents.print({ silent: true }):
// the same page and the same @media print rules as window.print(), so what is
// printed is exactly what the dialog would have printed.
//
// WHICH PRINTER. The physically validated receipt queue (the cash drawer's
// profile, cashDrawerProfiles.mjs) when exactly one is installed; otherwise
// the Windows default printer. Nothing here sends raw bytes — the drawer
// command stays in cashDrawerProfiles.mjs and nowhere else.
//
// IT CARRIES NOTHING ACROSS. The channel takes no arguments: the renderer
// cannot name a printer, a page or a copy count.
//
// IT NEVER RETRIES, AND IT NEVER DOUBLES. One request is one print job. The
// renderer falls back to the print window only on an answer that means nothing
// was printed ("unavailable", "failed"); an answer it cannot trust is final.
import { matchCashDrawerProfile } from "./cashDrawerProfiles.mjs";

export const RECEIPT_PRINT_CHANNEL = "pos-canvas-shell:print-receipt";

/** Every answer the renderer can receive. */
export const RECEIPT_PRINT_OUTCOMES = Object.freeze(["printed", "failed", "unavailable"]);

/**
 * The printer to name, or undefined for the Windows default. Never throws.
 *
 * @param {readonly unknown[]} installedQueueNames
 * @returns {string | undefined}
 */
export function chooseReceiptPrinter(installedQueueNames) {
  const match = matchCashDrawerProfile(installedQueueNames);
  return match.status === "matched" ? match.queueName : undefined;
}

/**
 * @param {{
 *   isTrusted: (event: unknown) => boolean,
 *   listQueueNames: (event: unknown) => Promise<readonly unknown[]>,
 *   print: (event: unknown, options: Record<string, unknown>) => Promise<{ success: boolean, failureReason?: string } | boolean>,
 *   log?: (step: string, fields?: Record<string, unknown>) => void,
 *   now?: () => number,
 * }} deps
 */
export function createPrintReceiptHandler({ isTrusted, listQueueNames, print, log = () => {}, now = () => Date.now() }) {
  // One job at a time: a double tap queues behind the first, it never races it.
  let queue = Promise.resolve();

  async function attemptOnce(event) {
    let deviceName;
    try {
      deviceName = chooseReceiptPrinter(await listQueueNames(event));
    } catch {
      deviceName = undefined; // the default printer is still a valid choice
    }

    // v1.3.4 (owner's Windows test) — THE PRINTER'S OWN PAPER. A silent print
    // otherwise lays the page out on A4, which put the receipt off the edge of
    // the 80 mm roll and ran the two Cash Drop slips together. The print window
    // always used the printer's default paper; this asks for exactly that.
    const options =
      deviceName === undefined
        ? { silent: true, printBackground: true, usePrinterDefaultPageSize: true }
        : { silent: true, printBackground: true, usePrinterDefaultPageSize: true, deviceName };

    const startedAt = now();

    try {
      const answer = await print(event, options);
      const success = answer === true || (typeof answer === "object" && answer !== null && answer.success === true);
      const failureReason = typeof answer === "object" && answer !== null ? answer.failureReason ?? null : null;

      log("receipt_print", { printer: deviceName ?? "(windows default)", success, failureReason, ms: now() - startedAt });
      return success ? "printed" : "failed";
    } catch (error) {
      log("receipt_print_threw", { printer: deviceName ?? "(windows default)", error: String(error), ms: now() - startedAt });
      return "failed";
    }
  }

  return function handlePrintReceipt(event) {
    let trusted = false;
    try {
      trusted = isTrusted(event) === true;
    } catch {
      trusted = false;
    }
    if (!trusted) {
      return Promise.resolve("unavailable");
    }

    const run = queue.then(() => attemptOnce(event));
    queue = run.catch(() => undefined);
    return run;
  };
}
