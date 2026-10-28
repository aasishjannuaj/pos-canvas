// v1.3.4 — the quick "is the server there?" check, BEFORE a sale is sent.
//
// THE OWNER'S GAP. When the shop's internet dropped silently, Pay sent the sale
// on a dead connection and waited out the 30 s submission deadline before the
// till went offline. A request that was dispatched and never answered may have
// committed, so that wait cannot simply be shortened.
//
// THIS CHECK SENDS NO SALE. It runs before any identity is armed, minted or
// sent, using the same read the live indicator uses (get_device_pairing_state).
// If nothing answers within PRE_SALE_CHECK_TIMEOUT_MS, the sale is NOT sent and
// the host moves the till to offline mode; pressing Pay again saves it offline.
// No sale was dispatched, so there is nothing that could be recorded twice.
//
// ANY ANSWER COUNTS AS REACHABLE. A server that replied — even with an error —
// is there, and the real sale request then gets its own authoritative answer.
// Only silence (transport failure or timeout) means "go offline".
import type { ReachabilityProbeResult } from "@/lib/liveStatus";
import { probeDeviceReachability } from "@/lib/device.rpc";

export const PRE_SALE_CHECK_TIMEOUT_MS = 3_000;

/** How long the till waits for offline saving before handing back to the cashier. */
export const OFFLINE_AUTO_SAVE_WAIT_MS = 15_000;

export type ReachabilityProbe = (signal: AbortSignal) => Promise<ReachabilityProbeResult>;

export async function isServerReachableBeforeSale(
  probe: ReachabilityProbe,
  options: {
    timeoutMs?: number;
    setTimer?: (run: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
  } = {}
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? PRE_SALE_CHECK_TIMEOUT_MS;
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const controller = new AbortController();

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (reachable: boolean) => {
      if (!settled) {
        settled = true;
        clearTimer(timer);
        resolve(reachable);
      }
    };

    const timer = setTimer(() => {
      controller.abort();
      settle(false);
    }, timeoutMs);

    let pending: Promise<ReachabilityProbeResult>;

    try {
      pending = Promise.resolve(probe(controller.signal));
    } catch {
      settle(false);
      return;
    }

    pending.then(
      (result) => settle(result.type === "response"),
      () => settle(false)
    );
  });
}

/**
 * The device host's one entry point: the same read the live indicator uses,
 * bounded to PRE_SALE_CHECK_TIMEOUT_MS. Used before a new online sale and
 * before a background sync claims any row. It never sends a sale.
 */
export function checkDeviceServerReachable(): Promise<boolean> {
  return isServerReachableBeforeSale(probeDeviceReachability);
}
