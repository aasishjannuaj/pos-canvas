// v1.3 Cash Drawer Checkpoint 1C — one RAW spooler job carrying one drawer
// command.
//
// PURE ORCHESTRATION over an INJECTED spooler. win32Spooler.mjs supplies the
// real Win32 calls; tests supply a fake that records every call. Nothing here
// knows about koffi, Electron or a printer model.
//
// THE LIFECYCLE, in the documented Win32 order:
//
//   OpenPrinterW
//   -> StartDocPrinterW (DOC_INFO_1W, datatype RAW)
//   -> StartPagePrinter
//   -> WritePrinter, EXACTLY ONCE
//   -> EndPagePrinter
//   -> EndDocPrinter
//   -> ClosePrinter (always, once OpenPrinterW succeeded)
//
// THE COMMAND IS NEVER SENT TWICE. There is no loop and no retry anywhere in
// this file. WritePrinter is called once; if it fails, or reports any byte
// count other than the full command, the remaining bytes are NOT written and
// WritePrinter is NOT called again -- a second write could complete a
// half-command or pulse the drawer twice. The job is aborted instead, so a
// truncated command is deleted from the spool rather than delivered, and the
// answer is `unknown`: on a queue that prints directly, some bytes may already
// have left.
//
// STATUSES:
//   sent    -- every call succeeded and the spooler accepted all five bytes.
//              That is a SOFTWARE fact. It does not prove the drawer moved.
//   failed  -- refused before any byte could be written.
//   unknown -- anything at or after WritePrinter that was not a clean run.
// Nothing here throws: every spooler error becomes a status.

/** Every status the shell can answer openCashDrawer() with. */
export const CASH_DRAWER_STATUSES = Object.freeze([
  "sent",
  "not_configured",
  "failed",
  "unknown",
  "unavailable",
]);

/** The document name shown in the Windows print queue for a drawer job. */
export const CASH_DRAWER_DOCUMENT_NAME = "POS Canvas";

/** Calls one spooler function, turning a throw into `fallback`. */
async function attempt(operation, fallback) {
  try {
    return await operation();
  } catch {
    return fallback;
  }
}

/**
 * Sends `command` to `queueName` as one RAW job.
 *
 * @param {{
 *   spooler: {
 *     open(queueName: string): Promise<unknown>,
 *     startDoc(handle: unknown, docInfo: { docName: string, datatype: string }): Promise<number>,
 *     startPage(handle: unknown): Promise<boolean>,
 *     write(handle: unknown, bytes: Uint8Array): Promise<{ ok: boolean, written: number }>,
 *     endPage(handle: unknown): Promise<boolean>,
 *     endDoc(handle: unknown): Promise<boolean>,
 *     abort(handle: unknown): Promise<boolean>,
 *     close(handle: unknown): Promise<boolean>,
 *   },
 *   queueName: string,
 *   command: readonly number[],
 *   datatype: string,
 * }} input
 * @returns {Promise<"sent" | "failed" | "unknown">}
 */
export async function sendRawCashDrawerCommand({ spooler, queueName, command, datatype }) {
  // A fresh copy: the spooler never holds a reference to the profile's data.
  const bytes = Uint8Array.from(command);

  if (bytes.length !== 5 || datatype !== "RAW") {
    return "failed";
  }

  const handle = await attempt(() => spooler.open(queueName), null);

  if (!handle) {
    return "failed";
  }

  let status;

  const job = await attempt(
    () => spooler.startDoc(handle, { docName: CASH_DRAWER_DOCUMENT_NAME, datatype }),
    0
  );

  if (!job) {
    status = "failed";
  } else if (!(await attempt(() => spooler.startPage(handle), false))) {
    // A document was started but nothing was written: delete the empty job.
    await attempt(() => spooler.abort(handle), false);
    status = "failed";
  } else {
    // THE ONE WRITE. Its result is final whatever it says.
    const written = await attempt(() => spooler.write(handle, bytes), { ok: false, written: -1 });

    if (!written || written.ok !== true || written.written !== bytes.length) {
      // Never complete a partial command and never write it again.
      await attempt(() => spooler.abort(handle), false);
      status = "unknown";
    } else {
      const pageEnded = await attempt(() => spooler.endPage(handle), false);
      const docEnded = await attempt(() => spooler.endDoc(handle), false);

      status = pageEnded && docEnded ? "sent" : "unknown";
    }
  }

  const closed = await attempt(() => spooler.close(handle), false);

  // A handle that would not close after a clean job leaves the outcome
  // unproven; it is never a reason to send anything again.
  return status === "sent" && !closed ? "unknown" : status;
}
