// v1.3 Cash Drawer Checkpoint 1C — the main-process side of
// posCanvasCashDrawer.openCashDrawer().
//
// PURE. Everything Electron- or Win32-specific is injected by main.mjs, so the
// trust decision and the whole request path are tested under plain Node.
//
// THE REQUEST CARRIES NOTHING. The channel takes no arguments: the handler
// receives only the IPC event, and every hardware decision -- which queue,
// which bytes, which datatype -- is made here from built-in data. The renderer
// cannot name a printer, a path, a network target, a channel, a pulse or a
// byte.
//
// 1C DOES NOT DECIDE ELIGIBILITY. By the time a request arrives, the runtime
// has already required a completed cash sale on a live Windows shell with the
// owner's per-device setting on, and has durably claimed that sale's single
// drawer event (lib/cashDrawer.ts). This file does not deduplicate, does not
// retry, and never sends the command twice for one request.
import { isAppRuntimeUrl } from "./appProtocol.mjs";
import { matchCashDrawerProfile } from "./cashDrawerProfiles.mjs";
import { sendRawCashDrawerCommand } from "./cashDrawerRaw.mjs";

/** The one channel. invoke/handle, no payload. */
export const CASH_DRAWER_CHANNEL = "pos-canvas-shell:open-cash-drawer";

/**
 * Whether a request may reach printer code at all.
 *
 * ALL must hold: the frame still exists; it is the window's MAIN frame (not an
 * iframe); it is showing the packaged runtime at app://poscanvas; the window is
 * one this shell created; and this is Windows. Anything else is `unavailable`
 * with no printer work done.
 *
 * @param {{
 *   senderFrame: { url?: unknown } | null | undefined,
 *   mainFrame: unknown,
 *   senderWindowId: number | null | undefined,
 *   shellWindowIds: ReadonlySet<number>,
 *   platform: string,
 * }} input
 */
export function isTrustedCashDrawerSender({ senderFrame, mainFrame, senderWindowId, shellWindowIds, platform }) {
  if (platform !== "win32") {
    return false;
  }

  if (senderFrame === null || senderFrame === undefined || senderFrame !== mainFrame) {
    return false;
  }

  if (typeof senderFrame.url !== "string" || !isAppRuntimeUrl(senderFrame.url)) {
    return false;
  }

  return typeof senderWindowId === "number" && shellWindowIds.has(senderWindowId);
}

/**
 * Builds the ipcMain.handle listener.
 *
 * ATTEMPTS ARE SERIALIZED, one after another, so two quick cash sales each get
 * their own job in order and never interleave spooler calls. That is ordering,
 * not deduplication: every accepted request is attempted exactly once.
 *
 * NOTHING ESCAPES. Every failure -- enumeration, a native module that will not
 * load, a spooler error -- resolves to a status. A rejection would only reach
 * the renderer's adapter, which would call it `unknown` anyway; resolving here
 * keeps the shell's own answer honest.
 *
 * @param {{
 *   isTrusted: (event: unknown) => boolean,
 *   listQueueNames: (event: unknown) => Promise<unknown[]>,
 *   loadSpooler: () => Promise<Parameters<typeof sendRawCashDrawerCommand>[0]["spooler"]>,
 * }} dependencies
 * @returns {(event: unknown) => Promise<"sent" | "not_configured" | "failed" | "unknown" | "unavailable">}
 */
export function createOpenCashDrawerHandler({ isTrusted, listQueueNames, loadSpooler }) {
  let queue = Promise.resolve();

  async function attemptOnce(event) {
    let queueNames;

    try {
      queueNames = await listQueueNames(event);
    } catch {
      return "failed";
    }

    const match = matchCashDrawerProfile(queueNames);

    if (match.status !== "matched") {
      return "not_configured";
    }

    let spooler;

    try {
      spooler = await loadSpooler();
    } catch {
      return "failed";
    }

    try {
      return await sendRawCashDrawerCommand({
        spooler,
        queueName: match.queueName,
        command: match.profile.command,
        datatype: match.profile.datatype,
      });
    } catch {
      return "unknown";
    }
  }

  return function handleOpenCashDrawer(event) {
    // Decided NOW, against the event as it arrived -- not after waiting in the
    // queue, by which time the frame may have navigated.
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
