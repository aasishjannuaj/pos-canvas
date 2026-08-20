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
import type { DeviceFailureKind } from "@/lib/deviceConnectivity";
import type { SaleRequestState } from "@/lib/saleRequest";
import type { UncertainSale } from "@/lib/saleSubmission";
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
}) => Promise<{
  receipt: CompletedSaleReceipt | null;
  error: string | null;
  /**
   * Feature 24.5F (DEF-01) — OPTIONAL, so the owner and Builder hosts are
   * unchanged. A device host reports whether the request reached a server at
   * all, which is the only signal that may unlock a cached offline runtime.
   */
  failure?: DeviceFailureKind;
  /**
   * Feature 24.5F — OPTIONAL. True when PostgreSQL itself raised, which proves
   * this invocation committed nothing. Absent means "not proven", never "did
   * not commit".
   */
  rolledBack?: boolean;
}>;

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
export type PosRuntimeOnSaleRejected = (rejection: {
  message: string | null;
  /**
   * Feature 24.5F (DEF-01) — how the attempt failed, when the host knows.
   *
   * An OBJECT rather than a second positional argument, because the two values
   * mean opposite things and a transposition would be silent: `message` is
   * display text that may say anything, while `failure` is the classification
   * that decides whether a till may open its cache. Absent means the host does
   * not classify, and the receiver must treat it as "not proven to be a
   * transport failure" — never as one.
   */
  failure?: DeviceFailureKind;
}) => void;

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
  /**
   * Feature 24.5F (DEF-01) — the identity of an online attempt that just died
   * on the wire, when this queued sale is that same attempt continuing.
   *
   * THIS IS THE DUPLICATE-SALE DEFENCE, and it is not an optimisation. If an
   * online complete_sale_v3 call reached the server and its response was lost,
   * the order EXISTS. Queuing the retry under a fresh idempotency key would ask
   * complete_sale_v4 to create a second one. Passing the original key instead
   * makes the queued submission a REPLAY: v4 resolves the key before allocating
   * an order number, mutating inventory or writing an audit row, and returns
   * the order v3 already created.
   *
   * Null whenever this is an ordinary offline sale with no online attempt
   * behind it. The host only honours it when the cart still hashes the same,
   * so a changed cart can never inherit an identity it does not match.
   */
  inheritedRequest: SaleRequestState | null;
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

/**
 * Feature 24.5F — makes an outbound sale identity durable BEFORE the request is
 * dispatched, returning whether it landed.
 *
 * WHY THE RUNTIME CANNOT JUST REMEMBER IT. The window between a request leaving
 * the device and its answer being handled is exactly where a process can die,
 * and the sale_request_id it carried is the only thing that can later prove —
 * or safely replay — an order the server may have created. Held in component
 * state that key dies with the process, and the cashier rings the customer up
 * again under a new one, which the server cannot recognise as the same sale.
 *
 * A HOST THAT DOES NOT SUPPLY THIS IS UNCHANGED. The owner runtime and the
 * Builder preview run in a browser tab against a live connection and have no
 * offline story at all; they keep the existing behaviour. A host that DOES
 * supply it is promising durability, so a `false` return means the runtime must
 * not dispatch — see PosRuntime, which refuses the sale rather than taking
 * money it could not protect.
 */
export type PosRuntimeArmOnlineSale = (sale: UncertainSale) => Promise<boolean>;

/**
 * Feature 24.5F — clears the durable record after a POSITIVE resolution.
 *
 * Called only with a server receipt in hand, or once a durable queue record has
 * taken ownership of the same key. Never on a rejection.
 */
export type PosRuntimeResolveOnlineSale = () => Promise<void>;
