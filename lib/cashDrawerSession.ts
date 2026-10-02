// v1.3 Cash Drawer Checkpoint 1A — the storage glue for the drawer-event claim.
//
// The one module that turns lib/cashDrawer.ts's injected ClaimDrawerEvent into
// a real IndexedDB write. Thin by design, like lib/uncertainSaleSession.ts: it
// opens the EXISTING device database through lib/deviceOfflineStore.ts (still
// the only IndexedDB opener), performs the single atomic insert, and closes.
//
// No second database and no other storage technology.
import { createDrawerEventRecord } from "@/lib/cashDrawer";
import type { DrawerEventClaimResult } from "@/lib/cashDrawer";
import { insertDrawerEventClaim, openOfflineDb } from "@/lib/deviceOfflineStore";

/**
 * Claims the automatic drawer event for one sale.
 *
 * Fails CLOSED: storage that cannot be opened or written answers `failed`, and
 * the coordinator then asks no drawer.
 */
export async function claimAutomaticDrawerEvent(
  saleRequestId: string,
  now: number = Date.now()
): Promise<DrawerEventClaimResult> {
  const opened = await openOfflineDb();

  if (!opened.ok) {
    return "failed";
  }

  const db = opened.value;

  try {
    const inserted = await insertDrawerEventClaim(
      db,
      createDrawerEventRecord({ saleRequestId, now })
    );

    if (inserted.ok) return "claimed";

    return inserted.reason === "exists" ? "already_claimed" : "failed";
  } finally {
    db.close();
  }
}
