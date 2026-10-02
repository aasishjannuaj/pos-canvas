// v1.3 Cash Drawer Checkpoint 1C — the Windows hardware capability, as the
// renderer sees it.
//
// THE ONLY READER OF window.posCanvasCashDrawer. The Windows shell's preload
// exposes that object only to its packaged runtime (app://poscanvas); in a
// browser, the Builder, the owner app or the Android shell it does not exist,
// and this resolves to the 1A UNAVAILABLE_CASH_DRAWER.
//
// IT CARRIES NOTHING ACROSS. openCashDrawer() is invoked with ZERO arguments:
// not the sale's id, not a printer, not bytes. Which queue and which command
// are decided in the shell's main process from built-in, physically validated
// data. The capability's own `saleRequestId` parameter is accepted (it is the
// 1A contract) and deliberately never forwarded.
//
// IT DECIDES NOTHING. Eligibility -- cash, live Windows, the owner's setting,
// the durable once-per-sale claim -- is lib/cashDrawer.ts's, and has already
// passed before requestOpen is ever called.
//
// IT NEVER RETRIES. One requestOpen is one openCashDrawer() call. A reply that
// is not a known status, a rejection, a throw, and no reply within the timeout
// are all `unknown`, and `unknown` is final: the drawer event was claimed
// before the call, so nothing will ask again.
import {
  UNAVAILABLE_CASH_DRAWER,
  normalizeCashDrawerOutcome,
} from "@/lib/cashDrawer";
import type { CashDrawerCapability, CashDrawerOpenOutcome } from "@/lib/cashDrawer";

/** How long to wait for the shell before calling the outcome unknown. */
export const CASH_DRAWER_BRIDGE_TIMEOUT_MS = 10_000;

/** The one function the bridge exposes. */
export type OpenCashDrawerBridge = () => Promise<unknown>;

/**
 * The bridge's function, or null unless `value` is exactly the shape the
 * preload exposes: an object whose `openCashDrawer` is a function.
 */
export function detectCashDrawerBridge(value: unknown): OpenCashDrawerBridge | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const open = (value as { openCashDrawer?: unknown }).openCashDrawer;

  return typeof open === "function" ? (open as OpenCashDrawerBridge) : null;
}

/**
 * Wraps the bridge as the 1A capability.
 *
 * `setTimer`/`clearTimer` are injectable so the timeout is tested without
 * waiting ten seconds.
 */
export function createWindowsCashDrawerCapability(
  openCashDrawer: OpenCashDrawerBridge,
  options: {
    timeoutMs?: number;
    setTimer?: (callback: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
  } = {}
): CashDrawerCapability {
  const timeoutMs = options.timeoutMs ?? CASH_DRAWER_BRIDGE_TIMEOUT_MS;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  return Object.freeze({
    available: true,
    // The 1A event is accepted and NOT forwarded: the call below has no
    // arguments at all.
    requestOpen: (): Promise<CashDrawerOpenOutcome> =>
      new Promise<CashDrawerOpenOutcome>((resolve) => {
        let settled = false;
        const settle = (outcome: CashDrawerOpenOutcome) => {
          if (!settled) {
            settled = true;
            clearTimer(timer);
            resolve(outcome);
          }
        };

        // A late answer after this fires is ignored, and nothing is re-sent.
        const timer = setTimer(() => settle("unknown"), timeoutMs);

        let reply: Promise<unknown>;

        try {
          reply = Promise.resolve(openCashDrawer());
        } catch {
          settle("unknown");
          return;
        }

        reply.then(
          (value) => settle(normalizeCashDrawerOutcome(value)),
          () => settle("unknown")
        );
      }),
  });
}

/**
 * The capability for THIS renderer: the Windows bridge when the shell exposed
 * it, otherwise the 1A no-op. Resolving it calls nothing.
 */
export function resolveCashDrawerCapability(): CashDrawerCapability {
  const bridge =
    typeof window === "undefined"
      ? null
      : detectCashDrawerBridge(
          (window as unknown as { posCanvasCashDrawer?: unknown }).posCanvasCashDrawer
        );

  return bridge === null ? UNAVAILABLE_CASH_DRAWER : createWindowsCashDrawerCapability(bridge);
}
