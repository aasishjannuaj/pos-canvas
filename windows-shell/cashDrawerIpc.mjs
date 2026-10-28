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
 * v1.3.4 — NO ATTEMPT CAN BLOCK THE NEXT ONE. A native spooler call that never
 * returned used to hold the serialized queue forever, so every later drawer
 * request waited behind it until the app restarted. Each attempt now answers
 * `unknown` after this long and the queue moves on; the stuck call is left to
 * finish on its own worker thread and is never retried.
 */
export const CASH_DRAWER_ATTEMPT_TIMEOUT_MS = 15_000;

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
 *   log?: (step: string, fields?: Record<string, unknown>) => void,
 *   openDirect?: ((queueName: string) => Promise<{ status: string, detail?: string }>) | null,
 *   attemptTimeoutMs?: number,
 *   setTimer?: (run: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 *   now?: () => number,
 * }} dependencies
 * @returns {(event: unknown) => Promise<"sent" | "not_configured" | "failed" | "unknown" | "unavailable">}
 */
export function createOpenCashDrawerHandler({
  isTrusted,
  listQueueNames,
  loadSpooler,
  // v1.3.4 — the on-till hardware log (hardwareLog.mjs); a no-op by default.
  log = () => {},
  // v1.3.4 — Epson's Status API (epsonDrawer.mjs), tried FIRST: it pulses the
  // drawer outside the Windows print queue, so stuck receipts and an empty
  // paper roll cannot hold it. Null skips it.
  openDirect = null,
  attemptTimeoutMs = CASH_DRAWER_ATTEMPT_TIMEOUT_MS,
  setTimer = (run, ms) => setTimeout(run, ms),
  clearTimer = (handle) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (handle)),
  now = () => Date.now(),
}) {
  let queue = Promise.resolve();

  async function attemptOnce(event) {
    let queueNames;
    const listedAt = now();

    try {
      queueNames = await listQueueNames(event);
    } catch (error) {
      log("drawer_list_failed", { ms: now() - listedAt, error: String(error) });
      return "failed";
    }

    const match = matchCashDrawerProfile(queueNames);

    log("drawer_queues", {
      ms: now() - listedAt,
      queues: Array.isArray(queueNames) ? queueNames.map(String) : [],
      match: match.status === "matched" ? match.queueName : match.reason,
    });

    if (match.status !== "matched") {
      return "not_configured";
    }

    // v1.3.4 — DIRECT FIRST. Only "unavailable" (no Status API on this till)
    // falls through to the print-job path below. A refusal or a missing answer
    // does NOT: a print job queued behind a stuck printer would open the drawer
    // later, at a moment nobody chose.
    if (openDirect !== null) {
      const directAt = now();
      let direct;

      try {
        direct = await openDirect(match.queueName);
      } catch (error) {
        direct = { status: "failed", detail: String(error) };
      }

      log("drawer_status_api", { ms: now() - directAt, status: direct.status, detail: direct.detail ?? null });

      if (direct.status === "opened") return "sent";
      if (direct.status === "failed") return "failed";
      if (direct.status !== "unavailable") return "unknown";
    }

    let spooler;

    try {
      spooler = await loadSpooler();
    } catch (error) {
      log("drawer_spooler_unavailable", { error: String(error) });
      return "failed";
    }

    const sentAt = now();

    try {
      const status = await sendRawCashDrawerCommand({
        spooler,
        queueName: match.queueName,
        command: match.profile.command,
        datatype: match.profile.datatype,
      });

      log("drawer_spooled", { ms: now() - sentAt, status });
      return status;
    } catch (error) {
      log("drawer_spool_threw", { ms: now() - sentAt, error: String(error) });
      return "unknown";
    }
  }

  /** One attempt, answered within attemptTimeoutMs whatever the native calls do. */
  function boundedAttempt(event) {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (status) => {
        if (!settled) {
          settled = true;
          clearTimer(timer);
          resolve(status);
        }
      };
      const timer = setTimer(() => {
        log("drawer_attempt_timed_out", { ms: attemptTimeoutMs });
        settle("unknown");
      }, attemptTimeoutMs);

      attemptOnce(event).then(settle, () => settle("unknown"));
    });
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

    log("drawer_request", { trusted });

    if (!trusted) {
      return Promise.resolve("unavailable");
    }

    const run = queue.then(() => boundedAttempt(event));

    queue = run.catch(() => undefined);

    return run;
  };
}
