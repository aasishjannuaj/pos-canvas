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
 *   print: (event: unknown, options: { silent: true, printBackground: true, deviceName?: string }) => Promise<boolean>,
 * }} deps
 */
export function createPrintReceiptHandler({ isTrusted, listQueueNames, print }) {
  // One job at a time: a double tap queues behind the first, it never races it.
  let queue = Promise.resolve();

  async function attemptOnce(event) {
    let deviceName;
    try {
      deviceName = chooseReceiptPrinter(await listQueueNames(event));
    } catch {
      deviceName = undefined; // the default printer is still a valid choice
    }

    const options =
      deviceName === undefined
        ? { silent: true, printBackground: true }
        : { silent: true, printBackground: true, deviceName };

    try {
      return (await print(event, options)) === true ? "printed" : "failed";
    } catch {
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
