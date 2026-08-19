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
import type { CartItem, PaymentMethod } from "@/lib/cart";
import type { ProvisionalReceipt } from "@/lib/provisionalReceipt";

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
 * Feature 19 — the origin a stored logo path is resolved against.
 *
 * INJECTED for the same reason submitSale and refreshStock are: the engine must
 * stay unaware of Supabase. Reading NEXT_PUBLIC_SUPABASE_URL inside PosRuntime
 * would put the word "supabase" back into a component whose whole contract is
 * that it does not know what is behind its host — a property lib/
 * device.guards.test.ts asserts directly.
 *
 * `null` disables logo rendering entirely; the business name still shows.
 * A logo is never fetched from anywhere but this origin — createLogoPublicUrl
 * rejects a non-http(s) value and any path that is not the exact
 * `{uuid}/{sha256}.{ext}` shape.
 */
export type PosRuntimeLogoBaseUrl = string | null;

/**
 * Called when a sale fails in a way that may mean this device is no longer
 * authorized. The host re-resolves authoritative state; the engine never
 * decides this for itself.
 */
export type PosRuntimeOnSaleRejected = (message: string | null) => void;

/**
 * Feature 24.5E — completes a sale WITHOUT a server, by making it durable here.
 *
 * SEPARATE FROM PosRuntimeCompleteSale ON PURPOSE, and not merged into it
 * behind a flag. The two do genuinely different things: one round-trips to
 * complete_sale_v3 and returns the server's authoritative receipt; this one
 * writes an IndexedDB record and returns a provisional one that carries no
 * order number at all. A single function returning "a receipt, maybe
 * authoritative" is exactly the ambiguity the whole receipt model exists to
 * remove, and it is how a provisional total would eventually be printed as if
 * the server had confirmed it.
 *
 * A HOST THAT PASSES null CANNOT SELL OFFLINE. The owner runtime and the
 * Builder Preview both pass null and are unchanged in every respect; only a
 * paired device running from a validated cache supplies an implementation.
 *
 * THE CONTRACT THE ENGINE RELIES ON: this promise resolves `ok` ONLY after the
 * sale is durably stored. The runtime clears the cart on that answer, so an
 * implementation that resolved early would silently destroy a sale.
 *
 * The whole cart is passed, unlike the online path's stripped item list,
 * because the host has to do two things with it that the wire payload cannot
 * express: fingerprint the attempt so a retry reuses one identity, and price
 * the provisional receipt from the pinned config. The host is still responsible
 * for stripping it down to identifiers and quantities before anything is
 * stored — lib/offlineCheckout.ts does that through the same
 * buildSaleRequestItems the online path uses.
 */
export type PosRuntimeQueueOfflineSale = (input: {
  paymentMethod: PaymentMethod;
  tipAmount: number;
  cart: readonly CartItem[];
}) => Promise<
  | {
      ok: true;
      /**
       * Null means the sale IS saved but its paper copy could not be drawn.
       * Never a reason to report a failed sale.
       */
      receipt: ProvisionalReceipt | null;
    }
  | { ok: false; message: string }
>;

/**
 * Feature 24.5E — the cashier left a checkout without completing it.
 *
 * WHY THIS EXISTS, and it is not bookkeeping. A failed enqueue deliberately
 * KEEPS the sale's identity so a retry of the same cart reuses one
 * saleRequestId and one occurredAt. That is correct within an attempt and wrong
 * the moment the attempt ends: without this signal, a cashier who fails to save
 * a sale, cancels, and later rings up a cart that happens to hash identically
 * would inherit the abandoned sale's identity — and with it a sale time from
 * minutes or hours earlier, recorded against a different customer's money.
 *
 * The runtime knows when an attempt ends (the checkout overlay closes) and the
 * host does not, so the runtime says so. Supplied together with
 * PosRuntimeQueueOfflineSale by the same host, under the same condition.
 */
export type PosRuntimeDiscardOfflineSaleDraft = () => void;
