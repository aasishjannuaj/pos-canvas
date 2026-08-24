// Feature 25.3 — the ONE module that calls get_device_recent_orders.
//
// Same shape as lib/offlineSaleRpc.ts and for the same reason: keeping a device
// RPC in its own small adapter makes "history is reachable only from here" a
// property a guard can check by listing files.
//
// READ-ONLY. This calls a `stable` function that writes nothing — not an order,
// not last_seen_at, not a heartbeat. Looking at history changes nothing.

import { getDeviceSupabaseClient } from "@/lib/supabase/deviceClient";
import { classifyDeviceFailure } from "@/lib/deviceConnectivity";
import { parseDeviceHistoryPage } from "@/lib/deviceOrders";
import type { DeviceHistoryCursor, DeviceHistoryResult } from "@/lib/deviceOrders";

/** Matches the server clamp, so the UI and the function agree on a full page. */
export const DEVICE_HISTORY_PAGE_SIZE = 25;

export type FetchDeviceHistoryResult =
  | DeviceHistoryResult
  /**
   * The server was not reached. Kept distinct from every server answer so the
   * screen can say "you are offline" rather than "there are no sales" — those
   * look identical to a cashier and mean opposite things.
   */
  | { ok: false; reason: "unreachable" };

/**
 * Fetches one page of this project's recent sales.
 *
 * THE CURSOR IS PASSED WHOLE OR NOT AT ALL. Both halves travel together because
 * created_at alone cannot separate two orders written in the same instant; the
 * server rejects a half cursor, and this never constructs one.
 */
export async function fetchDeviceRecentOrders(
  cursor: DeviceHistoryCursor | null = null,
  limit: number = DEVICE_HISTORY_PAGE_SIZE
): Promise<FetchDeviceHistoryResult> {
  try {
    const { data, error } = await getDeviceSupabaseClient().rpc("get_device_recent_orders", {
      p_limit: limit,
      p_before_created_at: cursor?.createdAt ?? null,
      p_before_id: cursor?.id ?? null,
    });

    if (error) {
      // A transport failure is "we could not ask"; anything else is an answer,
      // and an answer is parsed rather than guessed at.
      return classifyDeviceFailure(error) === "transport"
        ? { ok: false, reason: "unreachable" }
        : { ok: false, reason: "unreadable" };
    }

    return parseDeviceHistoryPage(data);
  } catch (thrown) {
    return classifyDeviceFailure(thrown) === "transport"
      ? { ok: false, reason: "unreachable" }
      : { ok: false, reason: "unreadable" };
  }
}
