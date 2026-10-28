// v1.3.4 — opens the drawer through Epson's Status API, outside the Windows
// print queue, by running epsonStatusApiWorker.mjs in a short-lived utility
// process. Pure apart from the injected `fork`, so it is unit-tested with a fake.
//
// THE ANSWER DECIDES WHAT HAPPENS NEXT (cashDrawerIpc.mjs):
//   opened       -> done; the queue path is never used.
//   unavailable  -> this till has no Status API; the RAW print-job path is used.
//   failed       -> the API is there and said no (printer off, unplugged…). The
//                   RAW path is NOT used: a job queued behind a stuck printer
//                   would pop the drawer open later, at a random moment.
//   unknown      -> no answer before the deadline; the process is killed and
//                   nothing else is sent, for the same reason.

export const EPSON_DRAWER_TIMEOUT_MS = 8_000;

/**
 * @param {{
 *   fork: () => { postMessage: (m: unknown) => void, on: (e: string, f: (...a: any[]) => void) => void, kill: () => void },
 *   timeoutMs?: number,
 *   setTimer?: (run: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 * }} deps
 * @returns {(printer: string) => Promise<{ status: "opened" | "unavailable" | "failed" | "unknown", detail?: string }>}
 */
export function createEpsonDrawerOpener({
  fork,
  timeoutMs = EPSON_DRAWER_TIMEOUT_MS,
  setTimer = (run, ms) => setTimeout(run, ms),
  clearTimer = (handle) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (handle)),
}) {
  return function openViaStatusApi(printer) {
    return new Promise((resolve) => {
      let child = null;
      let settled = false;
      let timer = null;

      const settle = (answer) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimer(timer);
        try {
          child?.kill();
        } catch {
          // Already gone.
        }
        resolve(answer);
      };

      try {
        child = fork();
      } catch (error) {
        settle({ status: "unavailable", detail: `fork: ${String(error)}` });
        return;
      }

      timer = setTimer(() => settle({ status: "unknown", detail: `no answer in ${timeoutMs} ms` }), timeoutMs);

      child.on("message", (message) => {
        const status = message && typeof message === "object" ? message.status : null;
        const detail = message && typeof message.detail === "string" ? message.detail : undefined;

        settle(
          status === "opened" || status === "unavailable" || status === "failed"
            ? { status, ...(detail === undefined ? {} : { detail }) }
            : { status: "failed", detail: "malformed answer" }
        );
      });
      child.on("exit", (code) => settle({ status: "failed", detail: `helper exited (${code}) without answering` }));

      try {
        child.postMessage({ printer });
      } catch (error) {
        settle({ status: "failed", detail: `post: ${String(error)}` });
      }
    });
  };
}
