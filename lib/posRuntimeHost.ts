// Feature 16.4A — the contract between PosRuntime (the shared POS engine) and
// whichever host is running it.
//
// Types only: no React, no Supabase, no runtime code. It exists so PosRuntime
// itself imports NEITHER lib/orders.ts (which builds the cookie-backed owner
// client internally) NOR lib/projects.ts (an owner-RLS read a paired device
// cannot perform). The engine now states what it needs; the host supplies it.
//
// WHY INJECTION RATHER THAN A ROLE FLAG: a `mode: "owner" | "device"` prop
// would leave both code paths compiled into the engine, so a bug in one
// branch could transact through the wrong session. With injection there is no
// owner code path inside the device bundle to reach — the engine literally
// cannot call the cookie client because it never imports it.
import type { CompletedSaleReceipt } from "@/lib/completedSale";
import type { MenuItem } from "@/lib/projectConfig";
import type { PaymentMethod } from "@/lib/cart";

/**
 * Completes one sale. Implementations must round-trip through
 * complete_sale_v3 and return the SERVER's authoritative receipt — never a
 * locally assembled object.
 *
 * Only itemId and quantity are accepted: there is deliberately nowhere in
 * this shape to put a client-supplied name, price, tax or total.
 */
export type PosRuntimeCompleteSale = (input: {
  projectId: string;
  paymentMethod: PaymentMethod;
  // Always 0 in the current runtime (there is no tip-entry UI and
  // calculateCartSummary is called with a literal 0), but carried through the
  // contract rather than assumed, so this refactor makes no equivalence claim
  // about a money field. complete_sale_v3 rejects any nonzero tip from a
  // paired device.
  tipAmount: number;
  // Feature 18.2 — each line may carry modifier IDENTIFIERS. Still no field
  // exists for a name, price, tax or total: complete_sale_v3 resolves all of
  // them from the authorized config.
  items: {
    itemId: string;
    quantity: number;
    modifiers: { groupId: string; optionIds: string[] }[];
  }[];
  saleRequestId: string;
}) => Promise<{ receipt: CompletedSaleReceipt | null; error: string | null }>;

/**
 * Re-reads live stock after a completed sale.
 *
 * `null` means the host has no stock refresh — the paired-device case, where
 * the projects table is not readable and the pinned snapshot's stock numbers
 * are not live. The engine then simply skips the refresh instead of showing a
 * failure the operator can do nothing about.
 */
export type PosRuntimeRefreshStock = (projectId: string) => Promise<{
  menuItems: Pick<MenuItem, "id" | "stockQuantity" | "trackInventory">[] | null;
  error: string | null;
}>;

/**
 * The header's exit affordance. `null` renders no link at all — a till has
 * nowhere to go back to, and must not offer a route into the owner app.
 */
export type PosRuntimeHomeLink = {
  href: string;
  label: string;
};

/**
 * Called when a sale fails in a way that may mean this device is no longer
 * authorized. The host re-resolves authoritative state; the engine never
 * decides this for itself.
 */
export type PosRuntimeOnSaleRejected = (message: string | null) => void;
