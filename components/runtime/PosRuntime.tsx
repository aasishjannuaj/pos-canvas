"use client";

import {
  type MutableRefObject,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import type { GeneratedPosConfig } from "@/lib/generatedPosConfig";
import { CURRENCY_SYMBOLS } from "@/lib/projectConfig";
import type { MenuItem } from "@/lib/projectConfig";
import {
  calculateCartSummary,
  canAddItemQuantity,
  createCartItem,
  getItemQuantityInCart,
} from "@/lib/cart";
import type {
  CartItem,
  CartModifierSelection,
  CheckoutStatus,
  PaymentMethod,
  SaleSaveStatus,
} from "@/lib/cart";
// v1.3 Feature 1E-A — the shared stock predicate. The rule it applies is
// lib/cart.ts's own `canAddItemQuantity`, so this replaces a local
// re-derivation of that rule rather than adding a second policy beside it.
// Only the predicate is imported: this component reports no activation status,
// because it cannot know one (see addToCart).
import type { CashTenderOutcome, CashTenderSubmission } from "@/lib/cashTenderEntry";
import {
  captureCashTenderBinding,
  decideCashTenderSubmission,
  EMPTY_CASH_ENTRY,
} from "@/lib/cashTenderEntry";
import { canActivateItem } from "@/lib/itemActivation";
import type { CompletedSaleReceipt } from "@/lib/completedSale";
import { isSubmitBlocked } from "@/lib/saleRequest";
import type { SaleRequestState } from "@/lib/saleRequest";
import {
  SALE_UNCONFIRMED_MESSAGE,
  SALE_UNPROTECTED_MESSAGE,
  createUncertainSale,
  decideUncertainSale,
  planSaleSubmission,
} from "@/lib/saleSubmission";
import type { UncertainSale } from "@/lib/saleSubmission";

// ---------------------------------------------------------------------------
// v1.3 CP-2B — the sale authorization boundary
//
// THREE AUTHORITIES, AND THEY ARE NOT INTERCHANGEABLE. The host owns who is
// signed in, which register is open and which configuration this till prices
// from; the durable store owns whether an earlier request is unresolved; this
// runtime owns the cart. A sale may begin only when all three agree, and the
// point of the types below is that disagreement has to be SAID rather than
// inferred from a missing value.
// ---------------------------------------------------------------------------

/**
 * The host's authority, read at one instant.
 *
 * DELIBERATELY OPAQUE. This runtime knows nothing about employees, registers or
 * attribution, and it must stay that way — the host owns those identities and
 * applies them at the RPC boundary. So the host collapses everything that must
 * not change mid-order into ONE token, and this runtime only ever asks whether
 * the token it prepared under is the token it is completing under. It never
 * learns, and never needs to learn, what changed.
 *
 * WHAT THE HOST FOLDS IN, and why it is more than the build pin: the signed-in
 * operator, the open register, the configuration pin, AND a generation that
 * counts how many times the pairing/configuration snapshot has been replaced.
 * That last part is what makes a configuration change detectable even when the
 * build id is unchanged — a reconnect or an offline-to-online transition
 * re-resolves the device state and produces a fresh snapshot while the pin
 * stays put.
 */
export type HostAuthoritySnapshot = {
  // LINE COMMENTS, NOT A BLOCK, AND DELIBERATELY. Several guards in this
  // repository strip JSX comments with a regex that matches `{` followed by a
  // block comment; a `/** */` opening immediately after this brace pairs with a
  // distant `*/ }` and silently deletes thousands of lines of real source from
  // what those guards then read.
  //
  // authorityToken is opaque to this runtime: compared for equality, never
  // interpreted.
  authorityToken: string;
  // A host-supplied reason this till must not start a new sale, or null.
  //
  // OPAQUE, LIKE checkoutBlockedReason ALREADY IS. This runtime knows nothing
  // about gates or durable sale records and must not start: the host decides
  // whether its own preconditions are satisfied and hands down a sentence to
  // show. The runtime refuses when it is non-null and displays it verbatim.
  blockedReason: string | null;
};

/**
 * Whether a tender has been authorized for this attempt.
 *
 * THE CP-2C EXTENSION POINT, AND DELIBERATELY INERT TODAY. There is no Cash
 * Tender UI, so nothing can legitimately produce a tender authorization and
 * this runtime must not invent one — a fabricated financial approval is worse
 * than none. `{ required: false }` is the only value CP-2B constructs, and it
 * means "this checkout has no tender step", not "the tender was approved".
 */
/**
 * v1.3 CP-2B — the host's verdict on ONE specific sale attempt.
 *
 * SALE-BOUND, AND OPAQUE. The runtime hands over the exact identity it is about
 * to dispatch and the host answers for that identity alone. It is the host that
 * compares the authority this checkout was PREPARED under against the authority
 * live right now — the runtime cannot, because it holds neither, and because a
 * token it fetched a moment ago compared against itself proves nothing.
 *
 * `resume_exact` carries the host's own saleRequestId. The runtime uses it
 * verbatim and never mints a replacement: a request that may already exist on
 * the server must be replayed under the key that was dispatched.
 */
export type HostSaleAuthorization =
  /** Verified clear, prepared authority still current. An ordinary new sale. */
  | { decision: "new_sale" }
  /** An approved same-identity replay of a request already outstanding. */
  | { decision: "resume_exact"; requestId: string }
  /** Anything else. The reason is the host's own sentence, shown verbatim. */
  | { decision: "blocked"; reason: string };

/**
 * v1.3 CP-2B FINAL — the host's answer when a checkout asks to be authorized.
 *
 * ONE GENERATION PER CHECKOUT, ISSUED BY THE HOST. The runtime keeps the number
 * and presents it again at dispatch, which is what lets the host compare what
 * the runtime BELIEVES it prepared under with what the host actually issued. A
 * runtime that minted its own would be comparing a value with itself, and a
 * host that re-derived one at dispatch would be unable to tell a current
 * checkout from a stale one.
 *
 * `ok: false` carries the host's own sentence and no generation: nothing was
 * minted, so there is nothing for a later dispatch to present.
 */
export type HostCheckoutPreparation =
  | { ok: true; generation: number; authorityToken: string }
  | { ok: false; reason: string };

export type TenderAuthorization =
  | { required: false }
  | { required: true; consumed: boolean };

export type SaleAuthorizationRefusal =
  | "in_flight"
  | "tender_unauthorized"
  | "host_unavailable"
  | "authority_blocked"
  | "host_changed";

export type SaleAuthorizationDecision =
  | { ok: true }
  | { ok: false; refusal: SaleAuthorizationRefusal; message: string };

/** What the operator is told. Plain, and never blaming the cashier. */
export const SALE_AUTHORIZATION_MESSAGES: Record<SaleAuthorizationRefusal, string> = {
  in_flight: "This sale is already being saved.",
  tender_unauthorized: "Confirm the amount received before completing this sale.",
  host_unavailable: "Sign in an employee before taking a sale.",
  // Replaced by the host's own sentence when it supplies one.
  authority_blocked: "This till cannot start a sale right now.",
  host_changed:
    "The signed-in employee, open register or configuration changed. Review the order and try again.",
};

/**
 * May this attempt proceed?
 *
 * PURE, AND THAT IS WHY IT CAN BE PROVEN. Every input is a value the caller
 * already read; nothing here touches React, the DOM, storage or the clock, so
 * the whole refusal matrix is reachable from a Node test. The runtime reads the
 * live authority synchronously and hands it in — this function never reads
 * anything itself, because a function that read its own inputs could read them
 * at the wrong moment.
 *
 * ORDER IS LOAD-BEARING. In-flight first, because it is the cheapest and the
 * likeliest second press. Host availability before host comparison, because
 * "nobody is signed in" is a different fact from "somebody else is". Recovery
 * before the host comparison, because an unresolved earlier sale makes the rest
 * moot and must be reported as itself.
 *
 * WHAT IT DELIBERATELY DOES NOT DECIDE: an `outstanding` recovery record is NOT
 * refused here. decideUncertainSale already owns that, keyed on the sale
 * fingerprint, and it is what preserves the legitimate same-identity replay.
 */
export function decideSaleAuthorization(input: {
  hostPresent: boolean;
  prepared: HostAuthoritySnapshot | null;
  live: HostAuthoritySnapshot | null;
  inFlight: boolean;
  tender: TenderAuthorization;
}): SaleAuthorizationDecision {
  const refuse = (refusal: SaleAuthorizationRefusal): SaleAuthorizationDecision => ({
    ok: false,
    refusal,
    message: SALE_AUTHORIZATION_MESSAGES[refusal],
  });

  if (input.inFlight) return refuse("in_flight");

  if (input.tender.required && input.tender.consumed) return refuse("tender_unauthorized");

  // NO HOST MEANS NO HOST AUTHORITY TO CHECK, not "authority granted". The
  // owner runtime and the Builder Preview have no employee, no register and no
  // durable recovery store, and they sold perfectly well before this checkpoint.
  if (!input.hostPresent) return { ok: true };

  if (input.live === null) return refuse("host_unavailable");

  // FENCED BEFORE ANYTHING ELSE ABOUT THE HOST. The host reports its own
  // preconditions; "not yet verified" and "could not be verified" both arrive
  // here as a reason, and a reason is always a refusal, never permission.
  if (input.live.blockedReason !== null) {
    return {
      ok: false,
      refusal: "authority_blocked",
      message: input.live.blockedReason,
    };
  }

  if (input.prepared === null) return refuse("host_changed");

  // NEWLY ESTABLISHED AUTHORITY IS NOT A SUBSTITUTE FOR THE OLD ONE. One
  // comparison, because the host already folded every fact that matters into
  // the token — and because this runtime is not permitted to know which fact it
  // was.
  if (input.prepared.authorityToken !== input.live.authorityToken) {
    return refuse("host_changed");
  }

  return { ok: true };
}
import { createSaleFingerprint } from "@/lib/saleRequest";
import {
  OFFLINE_AVAILABLE_AFTER_CONNECTION_LOST,
  OFFLINE_RECEIPT_UNAVAILABLE_NOTE,
} from "@/lib/provisionalReceipt";
import type { ProvisionalReceipt } from "@/lib/provisionalReceipt";

/**
 * W-02-RETRY-UX-FIX-1 — what the cashier reads after a classified transport
 * failure, instead of the raw technical error ("TypeError: Failed to fetch").
 *
 * The request may have reached the server, so this never says the sale failed
 * or that nothing was saved: it says the sale is unconfirmed.
 *
 * W-02-RETRY-UX-FIX-2 — NO PROMISES THE GATES MAY NOT KEEP. The FIX-1 wording
 * told the cashier to press Pay again once reconnected and promised the sale
 * would "not be recorded twice". Reconnecting does not by itself authorize a
 * retry — the host's checkout gates decide that (employee, register, recovery
 * state) — so the message now only asks for the order to be left unchanged and
 * defers to whatever the screen then says. When offline checkout IS available,
 * displayedSaleError shows OFFLINE_AVAILABLE_AFTER_CONNECTION_LOST instead.
 */
export const SALE_CONNECTION_LOST_MESSAGE =
  "The connection was lost before this sale was confirmed. Keep the order unchanged. Reconnect and follow the on-screen instructions.";
import AuthoritativeReceipt from "@/components/runtime/AuthoritativeReceipt";
import { saleTimePresentation } from "@/lib/receiptPresentation";
import OfflineReceipt from "@/components/runtime/OfflineReceipt";
import PosHeader from "@/components/runtime/PosHeader";
import ProductBrowser from "@/components/editor/pos-layouts";
import { isBarcodeScanningEnabled } from "@/lib/projectFeatures";
import CashTenderPad from "@/components/runtime/CashTenderPad";
import PosCheckoutPanel from "@/components/runtime/PosCheckoutPanel";
import type {
  PosRuntimeCompleteSale,
  PosRuntimeHomeLink,
  PosRuntimeLogoBaseUrl,
  PosRuntimeArmOnlineSale,
  PosRuntimeDiscardOfflineSaleDraft,
  PosRuntimeResolveOnlineSale,
  PosRuntimeOnSaleCompleted,
  PosRuntimeOnSaleRejected,
  PosRuntimeQueueOfflineSale,
  PosRuntimeRecoverOutstandingSale,
  PosRuntimeRefreshStock,
} from "@/lib/posRuntimeHost";

type PosRuntimeProps = {
  // Feature 14.3 — the immutable generated contract. No ProjectConfig, no raw
  // project row, no Supabase client.
  config: GeneratedPosConfig;

  // Feature 16.4A — host-injected behavior. Previously this component imported
  // lib/orders.ts and lib/projects.ts directly, which hardwired it to the
  // cookie-backed owner client and to an owner-RLS read of `projects`. A paired
  // device can do neither: its session lives in its own localStorage namespace,
  // and `projects` is invisible to it under RLS.
  //
  // These are REQUIRED rather than optional-with-owner-defaults on purpose. A
  // default would keep an owner-session code path compiled into the device
  // bundle, where a bug could transact a device sale through whatever owner
  // cookie happened to exist in the same browser. Injection makes that
  // structurally impossible. components/runtime/OwnerPosRuntime.tsx supplies
  // the owner implementations, unchanged.
  submitSale: PosRuntimeCompleteSale;

  // null = this host has no live stock source (paired device).
  refreshStock: PosRuntimeRefreshStock | null;

  // null = render no exit link (a till has nowhere to go back to).
  homeLink: PosRuntimeHomeLink | null;

  /**
   * Feature 25.1 — an optional host affordance for the header's trailing slot.
   *
   * USED ONLY WHEN THERE IS NO homeLink, which keeps Feature 16.4A's rule
   * intact: a till still has nowhere to go back to and still must not offer a
   * route into the owner app. This is the opposite direction — a device-owned
   * control (Device settings) the owner runtime never passes.
   *
   * PosRuntime renders it and knows nothing else about it, so no unpair or reset
   * logic enters this component.
   */
  headerTrailing?: ReactNode;
  /**
   * RC-polish fix — is this runtime's selling surface actually operable?
   *
   * A HOST SIGNAL, AND DELIBERATELY GENERIC. A till host passes `false` while
   * anything covers the POS, because the covering host keeps this runtime
   * MOUNTED (and its subtree `inert`) so the cart survives. This runtime
   * therefore cannot observe a cover appearing or clearing by itself, and the
   * Search / Scan field had no way to learn the till had become usable.
   *
   * Nothing here knows WHICH overlay — only operable or not. It is forwarded
   * to the Search / Scan presentation path and read nowhere else.
   *
   * OPTIONAL, AND ABSENT MEANS OPERABLE. A host with no overlay concept — the
   * owner's browser runtime, the Builder preview — omits it and keeps exactly
   * today's behaviour. Absence must never read as "inactive", or omitting it
   * would silently disable focus for those hosts.
   */
  sellingSurfaceActive?: boolean;
  /**
   * v1.3 CP-2B — reads the host's authority at the instant it is called.
   *
   * A FUNCTION, NOT A VALUE, AND THAT IS THE ENTIRE POINT. A prop is captured
   * by whichever render produced the handler's closure; by the time Done runs
   * the employee may have rung out and that prop would still say otherwise. The
   * host reads its own synchronous refs when this is called, so what comes back
   * is true now rather than true at last render.
   *
   * OPTIONAL, AND ABSENT MEANS NO DEVICE HOST: the owner runtime and the
   * Builder Preview omit it and keep exactly today's behaviour.
   */
  readHostAuthority?: (() => HostAuthoritySnapshot | null) | null;
  /**
   * v1.3 CP-2B — asks the host to authorize ONE sale identity, synchronously.
   *
   * CALLED IMMEDIATELY BEFORE DISPATCH, not at render and not at checkout open.
   * Between arming a request and sending it the operator can ring out, a
   * register can close and a configuration can be re-resolved; this is the last
   * point at which any of that can be seen. The host compares the PREPARED
   * authority with the live one and answers for the exact identity supplied.
   *
   * Absent means no device host: the owner runtime and the Builder Preview omit
   * it and keep exactly today's behaviour.
   */
  authorizeSaleDispatch?:
    | ((attempt: {
        // NULL, NOT AN EMPTY STRING. On the offline path the identity is minted
        // inside the host, further down, and the runtime genuinely does not
        // know it. An explicit typed absence says that; `""` would be a
        // sentinel the host could not distinguish from a real id.
        requestId: string | null;
        fingerprint: string;
        // The generation this checkout was PREPARED under, handed back so the
        // host can compare it with the one it issued.
        checkoutGeneration: number;
      }) => HostSaleAuthorization)
    | null;
  /**
   * v1.3 CP-2B FINAL — asks the host to authorize a NEW checkout.
   *
   * CALLED AT THE OPEN BOUNDARY AND NOWHERE ELSE. The host mints a generation,
   * binds it to the authority live at that instant, and refuses outright while
   * an unresolved sale is still being protected. A checkout that is already
   * open never calls it again, which is what stops a stale checkout refreshing
   * itself into validity.
   *
   * Absent means no device host: the owner runtime and the Builder Preview omit
   * it and keep exactly today's behaviour.
   */
  prepareCheckoutAuthorization?: (() => HostCheckoutPreparation) | null;
  /**
   * v1.3 CP-2B FINAL — tells the host a checkout's authorization is finished.
   *
   * GENERATION-SCOPED, BECAUSE CALLBACKS ARRIVE LATE. A completion or a close
   * can settle after the cashier has already opened the next order, and an
   * unconditional clear would de-authorize that new checkout. The host ignores
   * any generation other than the one it currently holds.
   *
   * It does NOT release durable recovery protection. Closing a checkout cannot
   * un-send a request that already left the device.
   */
  invalidateCheckoutAuthorization?: ((generation: number) => void) | null;

  /**
   * Feature 26.2 — the LIVE cart size, for a host that must authorize on it.
   *
   * WHY A REF AND NOT THE COUNT ABOVE. `onCartLineCountChange` fires from a
   * passive effect: React commits the new cart, paints, and only then runs it.
   * Between the commit and that flush the host's mirrored count is stale, and
   * for the one decision that moves a till's pricing authority "stale" is not a
   * theoretical objection — it is the difference between refusing an update over
   * an open cart and repricing that cart underneath the cashier.
   *
   * This is written from a LAYOUT effect instead, which React flushes
   * synchronously as part of the same commit, before the browser paints and
   * therefore before any subsequent click can be handled. A handler that reads
   * `.current` reads what the cart is now, not what it was at last render.
   *
   * `null` means no runtime is mounted and the question cannot be answered. A
   * reader must treat that as a refusal, never as an empty cart.
   */
  cartLineCountRef?: MutableRefObject<number | null>;

  // Feature 19 — the origin a stored logo path resolves against, supplied by
  // the host so this component never names Supabase. null = no logo rendering.
  logoBaseUrl: PosRuntimeLogoBaseUrl;

  // Optional: lets a host re-check its own authorization after a rejected sale.
  onSaleRejected?: PosRuntimeOnSaleRejected;

  /**
   * Feature 24.5A — when set, completing a sale is IMPOSSIBLE and this string
   * says why.
   *
   * A reason rather than a boolean, so the panel can explain itself and so the
   * only way to disable checkout is to state a cause. Null means the ordinary
   * online runtime, unchanged in every respect.
   *
   * Browsing, the cart, modifiers and totals all keep working — the fence is
   * around the one action that writes money.
   *
   * Feature 24.5E DID NOT WEAKEN THIS. It is still the first statement in
   * completeSale and still the only fence that matters; what changed is that a
   * device with a validated offline session now passes null here and supplies
   * queueOfflineSale instead, so "offline" and "cannot sell" stopped being the
   * same sentence.
   */
  checkoutBlockedReason?: string | null;

  /**
   * Feature 24.5E — when set, this runtime completes sales LOCALLY.
   *
   * Non-null means the host has already validated everything that makes an
   * offline sale safe (pairing assertion, 7-day lease, pinned configuration and
   * its integrity, identity, durable storage) and will make the sale durable
   * before it answers. The runtime then submits nothing: no RPC is called, no
   * server receipt exists, and the customer gets a provisional one.
   *
   * null — the default, and what the owner runtime and the Builder Preview both
   * pass — leaves the online complete_sale_v3 path byte-identical to before.
   */
  queueOfflineSale?: PosRuntimeQueueOfflineSale | null;

  /**
   * Feature 24.5E — tells the host this checkout attempt is over.
   *
   * Supplied together with queueOfflineSale, by the same host, under the same
   * condition. It is what bounds the reuse of a sale's identity to a single
   * attempt: see PosRuntimeDiscardOfflineSaleDraft for why an unbounded reuse
   * would record a later customer's sale at an earlier customer's time.
   */
  discardOfflineSaleDraft?: PosRuntimeDiscardOfflineSaleDraft | null;

  /**
   * Feature 24.5F — durable protection for an online request's identity.
   *
   * Supplied together by a host that has storage. `armOnlineSale` must make the
   * identity durable before the request is dispatched and report whether it
   * did; `resolveOnlineSale` clears it after a receipt. `persistedUncertainSale`
   * is what was found on disk at startup — the copy that survives a process
   * kill, and the one that wins over anything this component remembers.
   */
  armOnlineSale?: PosRuntimeArmOnlineSale | null;
  resolveOnlineSale?: PosRuntimeResolveOnlineSale | null;
  persistedUncertainSale?: UncertainSale | null;

  /**
   * G-1-CLIENT-1 — finishes an outstanding sale under its original identity
   * and attribution, instead of resubmitting it. See
   * PosRuntimeRecoverOutstandingSale. Null — the owner runtime and the Builder
   * preview — leaves every path exactly as it was.
   */
  recoverOutstandingSale?: PosRuntimeRecoverOutstandingSale | null;

  /**
   * v1.3 Cash Drawer Checkpoint 1A — told once per SUCCEEDED sale, after the
   * success boundary on each path. See PosRuntimeOnSaleCompleted. Null — the
   * default, and what the owner runtime and the Builder preview pass — means
   * nothing is told and nothing changes.
   */
  onSaleCompleted?: PosRuntimeOnSaleCompleted | null;
};

const LEAVE_CONFIRM_MESSAGE = "Your current cart will be lost. Leave the POS?";

// Feature 14.3 — the standalone runtime viewer. Treats `config` as
// immutable startup configuration: every session concern (cart, checkout,
// payment method, receipt, order count, a local stock-refreshable copy of
// menuItems) lives in its own local state here, never written back onto
// `config` or any of its nested objects. Reuses the same ProductBrowser,
// PosCheckoutPanel, and Receipt components the Builder's own preview mode
// uses — this is the shared POS engine's real runtime, not a rebuild of it.
export default function PosRuntime({
  config,
  submitSale,
  refreshStock,
  homeLink,
  headerTrailing,
  sellingSurfaceActive,
  readHostAuthority = null,
  authorizeSaleDispatch = null,
  prepareCheckoutAuthorization = null,
  invalidateCheckoutAuthorization = null,
  cartLineCountRef,
  logoBaseUrl,
  onSaleRejected,
  checkoutBlockedReason = null,
  queueOfflineSale = null,
  discardOfflineSaleDraft = null,
  armOnlineSale = null,
  resolveOnlineSale = null,
  persistedUncertainSale = null,
  recoverOutstandingSale = null,
  onSaleCompleted = null,
}: PosRuntimeProps) {
  // Feature 14.3 — a local, independent copy of the menu, seeded once from
  // config.menuItems. Only ever updated field-by-field (stockQuantity/
  // trackInventory, after a confirmed sale) via a fresh array/object at
  // every step — config.menuItems itself is never touched.
  const [menuItems, setMenuItems] = useState<MenuItem[]>(() =>
    config.menuItems.map((item) => ({ ...item }))
  );

  const [cart, setCart] = useState<CartItem[]>([]);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [selectedPaymentMethod, setSelectedPaymentMethod] =
    useState<PaymentMethod | null>(null);
  const [checkoutStatus, setCheckoutStatus] = useState<CheckoutStatus>("idle");
  const [saleSaveStatus, setSaleSaveStatus] = useState<SaleSaveStatus>("idle");
  const [saleSaveError, setSaleSaveError] = useState<string | null>(null);
  // W-02-RETRY-UX-FIX-1 — where the CURRENT sale error came from. Only an
  // online attempt that ended in a classified transport failure may be
  // presented as "connection lost, save it on this device"; every other error
  // (an offline save failure, an eligibility or conflict refusal, a blocked
  // gate, the uncertain-sale lock) is shown as itself. Reset at the start of
  // every attempt and when the checkout closes, so it can never outlive the
  // error it describes.
  const [saleErrorOrigin, setSaleErrorOrigin] = useState<"connection_lost" | null>(null);

  // Feature 14.3 — deliberately a single most-recent order, not a growing
  // history: the receipt flow only ever needs to show/print the sale that
  // just happened, so the runtime doesn't carry a Recent Orders reprint
  // list the way the Builder's preview does.
  // D3 — the completed sale is the SERVER payload, never a locally assembled
  // object. Nothing from the cart survives past a successful checkout.
  const [lastCompletedReceipt, setLastCompletedReceipt] =
    useState<CompletedSaleReceipt | null>(null);

  // Feature 24.5E — the offline equivalent, kept in a SEPARATE slot rather than
  // widened into the one above. The two receipt models mean different things
  // (one has a server order number, one deliberately has none), and a single
  // union-typed slot is how a provisional total eventually gets rendered by the
  // authoritative component. Only one is ever non-null: each success path
  // clears the other, so a stale receipt of the wrong kind cannot be reopened.
  const [lastProvisionalReceipt, setLastProvisionalReceipt] =
    useState<ProvisionalReceipt | null>(null);

  // One id per logical checkout attempt; reused across retries of the same
  // intent so a lost response replays instead of double-selling.
  const [saleRequest, setSaleRequest] = useState<SaleRequestState | null>(null);

  /**
   * Feature 24.5F — a complete_sale_v3 request was dispatched and never
   * answered, so an order carrying its key MAY exist on the server.
   *
   * A RECORD, NOT A BOOLEAN, and not scoped to a checkout episode either — both
   * were review corrections. The earlier boolean was cleared by closeCheckout,
   * which meant cancelling a checkout silently discarded the fact that money
   * might already have been recorded; and being a boolean it could not say
   * WHICH request was outstanding, so a cashier who changed the payment method
   * would mint a second identity and create a second order.
   *
   * It is cleared ONLY by a definitive resolution — see clearUncertainSale
   * below. Until then it both authorises a resume under the original key and
   * refuses anything that would need a new one.
   */
  const [uncertainSale, setUncertainSale] = useState<UncertainSale | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);

  /**
   * v1.3 RC-polish — how many times the Search / Scan field has been asked to
   * take focus.
   *
   * A COUNTER, NOT A BOOLEAN, because the request has to be repeatable. Two
   * sales in a row must produce two distinct asks, and a flag that was already
   * `true` would produce one. It only ever increases; its value means nothing,
   * only the change does.
   *
   * IT LIVES HERE AND NOT IN THE BROWSER because the browser cannot see the
   * event. A completed sale is dismissed in an overlay that sits above a
   * product panel which never unmounted, so nothing down there changes when
   * the cashier presses Done — which is exactly why this exists rather than a
   * mount effect.
   */
  const [scanFocusRequest, setScanFocusRequest] = useState(0);

  /**
   * v1.3 CP-2B — one submission at a time, decided synchronously.
   *
   * PREVENTS: two Done activations in a single React tick — a double-click, a
   * repeated key, an assistive-technology repeat — both passing the existing
   * guard and starting two submissions.
   *
   * WHY EXISTING STATE CANNOT: saleSaveStatus is React state, so both
   * activations read "idle" until React commits "saving". isSubmitBlocked is
   * correct and stays exactly where it is; the ref closes the window it cannot
   * see. It belongs here because this is the function that dispatches.
   */
  const saleInFlightRef = useRef(false);

  /**
   * The host authority this checkout was prepared under.
   *
   * PREVENTS: an order prepared by one operator, or against one configuration,
   * being completed under a different one established mid-order.
   *
   * WHY EXISTING STATE CANNOT: nothing in this runtime recorded the authority
   * at all; the host's identity reached the server only at dispatch.
   */
  const preparedAuthorityRef = useRef<HostAuthoritySnapshot | null>(null);

  /**
   * v1.3 CP-2B FINAL — the checkout generation this order was prepared under.
   *
   * Issued by the host at open, presented back at dispatch. Null when no device
   * host supplied a preparation function, which is the owner runtime and the
   * Builder Preview; those hosts also supply no dispatch authorizer, so nothing
   * reads it.
   */
  const preparedCheckoutRef = useRef<{ generation: number; authorityToken: string } | null>(null);

  /**
   * The host's own sentence when it REFUSED to prepare this checkout.
   *
   * A ref, not state: it is written at open and read inside the Done handler in
   * the same turn, and it must never be a render behind.
   */
  const prepareRefusalRef = useRef<string | null>(null);

  /**
   * v1.3 CP-2C — the Cash Tender buffer, and what it was bound to.
   *
   * THE BUFFER LIVES HERE, NOT IN CashTenderPad, because the binding has to be
   * captured against the LIVE checkout at the moment the buffer changes, and
   * the cart, the total and the revision counter are all here. A pad that owned
   * its own buffer could be re-rendered with a different total underneath it and
   * never know.
   */
  const [cashEntry, setCashEntry] = useState(EMPTY_CASH_ENTRY);
  const [cashTenderBinding, setCashTenderBinding] = useState<string | null>(null);

  /**
   * What the completed cash sale was settled with, for the receipt.
   *
   * PRESENTATION ONLY. It is not part of the sale, is never sent anywhere, and
   * the receipt's own Total is untouched by it — see cashTenderReceiptLines.
   * Cleared by closeCheckout so it cannot survive onto a later sale, and the
   * resolver independently refuses to print it against a card receipt.
   */
  const [cashTenderOutcome, setCashTenderOutcome] = useState<CashTenderOutcome | null>(null);

  /**
   * v1.3 CP-2C — which open checkout this is, and how many times it has moved.
   *
   * BOTH ARE REQUIRED BY lib/cashTender.ts AND NEITHER IS PRODUCED BY IT. The
   * episode distinguishes a close and reopen; the revision distinguishes a cart
   * that changed and came back. CP-1C's documentation is explicit that the
   * revision only works "while the runtime actually advances the counter on
   * every mutation", and that no pure test can prove that it does — so it is
   * advanced in ONE function, bumpCheckoutRevision, called from every cart
   * mutator and from the payment-method selector, and a structural guard in
   * components/runtime/cashTenderUx.guards.test.ts asserts each of those calls.
   *
   * COUNTERS, NOT UUIDS, deliberately: no clock and no crypto is involved in
   * either, so the pad's staleness decision stays deterministic.
   */
  const [checkoutEpisode, setCheckoutEpisode] = useState(0);
  const [checkoutRevision, setCheckoutRevision] = useState(0);

  /**
   * v1.3 CP-2C — Done has already started a completion.
   *
   * A REF, BECAUSE A SECOND PRESS MUST BE REFUSED IN THE SAME TICK.
   * `saleSaveStatus` is state: two clicks delivered before React flushes would
   * both read "idle" and both call completeSale. This is written synchronously,
   * before the await, so the second press reads it. It is the innermost of
   * three defences — the pad swallows held-key repeats, and
   * decideCashTenderSubmission refuses while a submission is outstanding — and
   * the only one that is race-free by construction.
   */
  const cashDoneInFlightRef = useRef(false);

  /**
   * v1.3 CP-2C — a refusal produced by an actual Done press.
   *
   * Only reachable when the checkout moved between the render that enabled Done
   * and the press itself. Kept separate from saleSaveError on purpose: a tender
   * that may not be submitted is not a sale that failed, and routing it through
   * saleSaveStatus would make the checkout read as an error — and, worse, would
   * let displayedSaleError offer offline mode for a problem offline cannot fix.
   */
  const [cashTenderPressRefusal, setCashTenderPressRefusal] = useState<string | null>(null);

  // Feature 14.3 — seeded from the server-loaded starting count
  // (getProjectOrders().orders.length, capped at 20 — see
  // app/runtime/[id]/page.tsx for the known MVP limitation this carries),
  // incremented once per locally confirmed sale for the rest of this
  // session. Never re-fetched mid-session.
  const currencySymbol = CURRENCY_SYMBOLS[config.receipt.currency];

  // Feature 14.3 money safeguard — the tip amount is always 0 here. There
  // is no tip-entry UI in this MVP, so a nonzero tip must never be
  // fabricated regardless of config.receipt.tipsEnabled; calculateCartSummary
  // itself also independently guards against a non-finite/negative value,
  // but the explicit 0 below is what guarantees no hardcoded sample amount
  // (the Builder-preview-only 3 in EditorShell.tsx) can ever reach this
  // real, persisted checkout path.
  const cartSummary = calculateCartSummary(cart, config.tax, 0);

  // Feature 28C — this till's pinned configuration is the one every sale it
  // takes is priced from, so for a receipt printed here it IS the sale-time
  // configuration. A HISTORICAL receipt is a different question and is resolved
  // per order — see SalesHistoryDetail.
  const livePresentation = saleTimePresentation(config);

  /**
   * Feature 24.5F (DEF-01) — what the cashier reads after a lost connection.
   *
   * DERIVED, never assigned from an effect. The host's re-resolve happens
   * asynchronously after onSaleRejected, so the moment offline checkout becomes
   * available is a prop change, not an event this component can observe. Read
   * at render time it is simply true or false; written from an effect it would
   * be an extra render and the set-state-in-effect lint rule besides.
   *
   * The generic "could not be confirmed" message stays for every other failure,
   * including a lost connection on a till that has NO usable cache — there is
   * nothing better to offer there, and promising offline mode that cannot open
   * would be worse than the plain truth.
   *
   * W-02-RETRY-UX-FIX-1 — ONLY FOR THE ERROR IT DESCRIBES. This substitution
   * used to apply to ANY error while an uncertain sale was held and offline
   * checkout was available, so an offline save that failed in storage (B-1), an
   * eligibility or conflict refusal, or the uncertain-sale lock on a changed
   * cart were all replaced by "press Pay again to save it on this device". It
   * now requires saleErrorOrigin to say the error IS that connection loss.
   */
  const displayedSaleError =
    saleErrorOrigin === "connection_lost" &&
    uncertainSale !== null &&
    queueOfflineSale !== null &&
    saleSaveStatus === "error"
      ? OFFLINE_AVAILABLE_AFTER_CONNECTION_LOST
      : saleSaveError;

  /**
   * v1.3 CP-2C — is the cashier on the Cash Tender step right now?
   *
   * DERIVED, never assigned from an effect, for the same reason
   * displayedSaleError above is: the step is a function of state this component
   * already holds, so reading it at render time is simply true or false, while
   * writing it from an effect would be an extra render and the
   * set-state-in-effect lint rule besides.
   *
   * The success view is excluded explicitly: once a sale has completed the
   * overlay belongs to the receipt, not to a keypad.
   */
  const cashTenderActive =
    checkoutOpen && selectedPaymentMethod === "cash" && checkoutStatus !== "success";

  /**
   * What an entered tender is bound to, as of this render.
   *
   * `cartIdentity` IS the sale fingerprint, which is the composition
   * lib/cashTender.ts explicitly permits — and its own documentation explains
   * why that is not sufficient alone: the fingerprint covers items, quantities,
   * modifier selections, the payment method and the tip, but deliberately not
   * prices, because the server derives those. `amountDueFixed` is bound
   * separately and covers exactly that gap, and the revision covers a cart that
   * changed and came back.
   */
  const cashTenderContext = cashTenderActive
    ? {
        checkoutSessionId: `checkout-${checkoutEpisode}`,
        cartIdentity: createSaleFingerprint({
          projectId: config.project.projectId,
          paymentMethod: "cash" as const,
          tipAmount: cartSummary.tipAmount,
          items: cart,
        }),
        amountDueFixed: cartSummary.total,
        checkoutRevision,
      }
    : null;

  /**
   * What the buffer means, for the pad to render.
   *
   * `submissionInFlight: false` DELIBERATELY. This reading drives the Change Due
   * figure and the refusal text; passing the live flag here would blank the
   * change the instant Done was pressed, which reads as the change having
   * changed. Whether Done may fire is the pad's `busy` prop plus the
   * authoritative call in completeCashSale, which does pass it.
   */
  const cashTenderDecision: CashTenderSubmission | null =
    cashTenderContext === null
      ? null
      : decideCashTenderSubmission({
          entry: cashEntry,
          context: cashTenderContext,
          capturedBinding: cashTenderBinding,
          submissionInFlight: false,
        });

  /**
   * v1.3 CP-2C — the buffer changed, so recapture what it is bound to.
   *
   * CAPTURED HERE AND NOWHERE ELSE, against the context of the render the
   * keystroke happened in. That is what makes a later total change detectable:
   * the capture is what the checkout looked like when the cashier typed, and
   * Done compares it with what the checkout looks like then.
   */
  function changeCashEntry(entry: string) {
    setCashTenderPressRefusal(null);
    setCashEntry(entry);
    setCashTenderBinding(
      cashTenderContext === null ? null : captureCashTenderBinding(cashTenderContext, entry)
    );
  }

  /** v1.3 CP-2C — back to the payment-method step, discarding the tender. */
  function leaveCashTender() {
    bumpCheckoutRevision();
    resetCashTender();
    setSelectedPaymentMethod(null);
  }

  /**
   * v1.3 CP-2C — Done.
   *
   * IT ADDS A GATE AND THEN CALLS THE EXISTING FLOW. completeSale below is
   * unchanged by this checkpoint: the same offline fence, the same
   * UNKNOWN-outcome gate, the same fingerprint, the same durable enqueue, the
   * same planSaleSubmission and submitSale, the same receipt handling and the
   * same sale identity. Cash tender is a precondition on reaching it, never a
   * second way through it, and there is no cash-specific transaction path
   * anywhere in this component.
   *
   * THE REF IS CHECKED AND SET SYNCHRONOUSLY, BEFORE THE AWAIT, which is the
   * only part of the duplicate-submission defence that is race-free: two clicks
   * delivered before React flushes would both read `saleSaveStatus` as idle, and
   * both would reach completeSale. It is cleared in a `finally` so a failed sale
   * can be retried — the cart and the tender both survive a failure.
   */
  async function completeCashSale() {
    if (cashDoneInFlightRef.current || cashTenderContext === null) {
      return;
    }

    const decision = decideCashTenderSubmission({
      entry: cashEntry,
      context: cashTenderContext,
      capturedBinding: cashTenderBinding,
      // The authoritative reading, unlike the one rendered above.
      submissionInFlight: isSubmitBlocked(saleSaveStatus),
    });

    if (decision.status !== "submit") {
      setCashTenderPressRefusal(decision.message);

      return;
    }

    cashDoneInFlightRef.current = true;
    setCashTenderPressRefusal(null);
    // Presentation only, and set before the sale rather than after it because
    // completeSale reports its outcome through state this function does not
    // read. Nothing renders it until a receipt exists, and both success paths
    // produce the receipt that gates it.
    setCashTenderOutcome({
      tenderedFixed: decision.tenderedFixed,
      changeFixed: decision.changeFixed,
    });

    try {
      await completeSale();
    } finally {
      cashDoneInFlightRef.current = false;
    }
  }

  const shownReceipt = receiptOpen ? lastCompletedReceipt : null;
  const shownProvisionalReceipt = receiptOpen ? lastProvisionalReceipt : null;

  // Feature 14.3 — warn only while there's a real, not-yet-checked-out cart
  // to lose; registered/removed as cart.length flips, exactly mirroring
  // EditorShell's own isDirty-keyed beforeunload effect from Feature 13.2.
  useEffect(() => {
    if (cart.length === 0) {
      return;
    }

    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [cart.length]);

  // Feature 26.2 — the live cart size, for a host that must authorize on it.
  //
  // A layout effect is flushed synchronously inside the commit that changed the
  // cart, before the browser paints and therefore before React can dispatch the
  // next click. That is what makes "add an item, open settings, press Apply"
  // impossible to slip through: by the time the settings click is handled, this
  // has already run.
  //
  // NO DEPENDENCY ARRAY, deliberately. The value must be correct after EVERY
  // commit, and a dependency list is a claim about which renders can change it —
  // a claim a future edit could quietly falsify. Writing a number on every
  // commit costs nothing and cannot drift.
  //
  // The cleanup nulls it on unmount so a host can never read a count belonging
  // to a runtime that is no longer on screen.
  useLayoutEffect(() => {
    if (cartLineCountRef === undefined) {
      return;
    }

    cartLineCountRef.current = cart.length;

    return () => {
      cartLineCountRef.current = null;
    };
  });

  // Feature 18.2 — every cart operation keys on lineKey, not itemId, so the
  // same product with two different modifier selections stays two independent
  // lines. Stock, by contrast, is held against the PRODUCT, so the quantity
  // checks below count every line carrying that itemId.
  //
  // v1.3 Feature 1E-A — RETURNS NOTHING, DELIBERATELY. An earlier pass had this
  // report whether the item was added, predicted from the render-time `cart`
  // before dispatching. That prediction was reachably wrong in both directions:
  // with a stock ceiling of one, two adds in the same tick both read the same
  // snapshot and were both told "added" while the updater committed only the
  // first; and a remove followed by an add in one tick predicted a stock refusal
  // while the updater went on to add. A synchronous function that dispatches a
  // functional update cannot observe that update's outcome, so it must not claim
  // to — and lib/itemActivation.ts is the preflight for callers that need to
  // decide BEFORE attempting an add.
  //
  // The check below is the ONE authoritative stock decision, and it stays inside
  // the updater against `prev` for exactly the reason the prediction failed:
  // `prev` is the cart as it actually is, including updates queued in this tick.
  // It calls the same shared predicate the preflight does, so there is one stock
  // policy, applied at two moments, with the fresh one deciding the mutation.
  /**
   * v1.3 CP-2C — the checkout moved. Called by every cart mutator and by the
   * payment-method selector; see checkoutRevision above for why it has to be.
   *
   * It is called unconditionally, including by a mutator whose own stock guard
   * then declines to change the cart. That is the safe direction: an advanced
   * revision invalidates a tender the cashier must then re-enter, while a missed
   * one leaves a stale tender comparing equal to a live one.
   */
  function bumpCheckoutRevision() {
    setCheckoutRevision((previous) => previous + 1);
  }

  /** v1.3 CP-2C — forget the entered cash, its binding and its receipt lines. */
  function resetCashTender() {
    cashDoneInFlightRef.current = false;
    setCashEntry(EMPTY_CASH_ENTRY);
    setCashTenderBinding(null);
    setCashTenderOutcome(null);
    setCashTenderPressRefusal(null);
  }

  function addToCart(menuItem: MenuItem, selections: CartModifierSelection[] = []): void {
    bumpCheckoutRevision();
    setCart((prev) => {
      const line = createCartItem(menuItem, selections);
      const existing = prev.find((cartItem) => cartItem.lineKey === line.lineKey);

      // The authoritative check, against the cart as it actually is.
      if (!canActivateItem(menuItem, prev)) {
        return prev;
      }

      if (existing) {
        return prev.map((cartItem) =>
          cartItem.lineKey === line.lineKey
            ? { ...cartItem, quantity: cartItem.quantity + 1 }
            : cartItem
        );
      }

      return [...prev, line];
    });
  }

  function increaseQuantity(lineKey: string) {
    bumpCheckoutRevision();
    setCart((prev) =>
      prev.map((cartItem) => {
        if (cartItem.lineKey !== lineKey) {
          return cartItem;
        }

        const menuItem = menuItems.find((item) => item.id === cartItem.itemId);

        if (
          menuItem &&
          !canAddItemQuantity({
            item: menuItem,
            currentQuantity: getItemQuantityInCart(prev, cartItem.itemId),
            addQuantity: 1,
          })
        ) {
          return cartItem;
        }

        return { ...cartItem, quantity: cartItem.quantity + 1 };
      })
    );
  }

  function decreaseQuantity(lineKey: string) {
    bumpCheckoutRevision();
    setCart((prev) =>
      prev
        .map((cartItem) =>
          cartItem.lineKey === lineKey
            ? { ...cartItem, quantity: cartItem.quantity - 1 }
            : cartItem
        )
        .filter((cartItem) => cartItem.quantity > 0)
    );
  }

  function removeFromCart(lineKey: string) {
    bumpCheckoutRevision();
    setCart((prev) => prev.filter((cartItem) => cartItem.lineKey !== lineKey));
  }

  function clearCart() {
    bumpCheckoutRevision();
    setCart([]);
  }

  function openCheckout() {
    if (cart.length === 0) {
      return;
    }

    // v1.3 CP-2B FINAL — THE PREPARATION BOUNDARY, and the only one.
    //
    // A host that can authorize checkouts mints a generation here and binds it
    // to the authority live at this instant. A host that cannot (the owner
    // runtime, the Builder Preview) falls through to the original behaviour
    // unchanged.
    //
    // THE REFUSAL DOES NOT HIDE THE CHECKOUT. The cashier still sees the order
    // and, on the recovery path, still sees the unfinished-sale screen that
    // tells them how to resolve it — what is withheld is the AUTHORIZATION, so
    // Done refuses with the host's own sentence rather than dispatching.
    prepareRefusalRef.current = null;

    if (prepareCheckoutAuthorization !== null) {
      const preparation = prepareCheckoutAuthorization();

      if (preparation.ok) {
        preparedCheckoutRef.current = {
          generation: preparation.generation,
          authorityToken: preparation.authorityToken,
        };
        preparedAuthorityRef.current = readHostAuthority?.() ?? null;
      } else {
        preparedCheckoutRef.current = null;
        preparedAuthorityRef.current = null;
        prepareRefusalRef.current = preparation.reason;
      }
    } else {
      preparedCheckoutRef.current = null;
      preparedAuthorityRef.current = readHostAuthority?.() ?? null;
    }

    // v1.3 CP-2C — a new episode, so a tender cannot be carried across a close
    // and reopen even if every other bound field came back identical.
    setCheckoutEpisode((previous) => previous + 1);
    resetCashTender();
    setCheckoutOpen(true);
  }

  function closeCheckout() {
    // THE ONE PLACE FOCUS IS REQUESTED, and it is guarded on success.
    //
    // `checkoutStatus` is still the status of the attempt being dismissed,
    // because this runs before the reset below. So a sale that SUCCEEDED
    // returns the cashier to the selling screen ready to scan the next
    // customer's first item, while a cancel ("idle"), a decline, a failed save
    // or an error leaves the caret exactly where the cashier put it — they are
    // mid-recovery, and yanking focus into a search box is the last thing that
    // should happen to them.
    //
    // The only other thing that can focus the field is mounting, which the
    // gates already cause when the selling surface becomes active again.
    //
    // Written as line comments on purpose: a /** */ block opening immediately
    // after a `{` reads as a JSX `{/* ... */}` comment to the regex strippers
    // several guards use, and makes them swallow real markup.
    if (checkoutStatus === "success") {
      setScanFocusRequest((previous) => previous + 1);
    }

    // v1.3 CP-2B — the prepared authority dies with the checkout; reopening
    // captures a fresh one, never inheriting one across a close.
    //
    // THE DURABLE RECOVERY LOCK IS UNTOUCHED HERE, exactly as uncertainSale is:
    // closing a checkout abandons a local intention and cannot un-send a
    // request that already left the device.
    preparedAuthorityRef.current = null;

    // v1.3 CP-2B FINAL — and the host drops the authorization for THIS
    // generation specifically. Naming it is what stops a close that arrives
    // late from de-authorizing a checkout the cashier has already opened since.
    //
    // The host is contractually forbidden from touching durable recovery here,
    // which is why the comment above about uncertainSale still holds.
    const finished = preparedCheckoutRef.current;

    if (finished !== null) {
      invalidateCheckoutAuthorization?.(finished.generation);
    }

    preparedCheckoutRef.current = null;
    prepareRefusalRef.current = null;

    setCheckoutOpen(false);
    setSelectedPaymentMethod(null);
    // v1.3 CP-2C — the tender belonged to the checkout being dismissed, and the
    // receipt figures belonged to the sale that is now off screen.
    resetCashTender();
    setCheckoutStatus("idle");
    setSaleSaveStatus("idle");
    setSaleSaveError(null);
    setSaleErrorOrigin(null);

    // Feature 24.5F — uncertainSale is DELIBERATELY NOT cleared here.
    //
    // Closing a checkout abandons a local intention; it cannot un-send a
    // request that already left the device. If an order may exist on the
    // server, that remains true whether or not the cashier pressed Cancel, and
    // forgetting it here is precisely how the next identical-looking sale would
    // become a second order for the same customer.

    // Feature 24.5E — THE ATTEMPT IS OVER, whether it succeeded, failed, or was
    // cancelled. Any sale identity the host is still holding for a retry is
    // void from here: the next Complete Sale is a different sale, even if the
    // cart that reaches it looks identical.
    discardOfflineSaleDraft?.();
  }

  function selectPaymentMethod(method: PaymentMethod) {
    // v1.3 CP-2C — switching method is a checkout mutation, and it discards any
    // cash already entered: a tender typed for one payment method is not a
    // tender for another, and the revision bump would refuse it anyway.
    bumpCheckoutRevision();
    resetCashTender();
    setSelectedPaymentMethod(method);
  }

  // Feature 24.5E — one opener for both receipt kinds. A provisional sale is
  // addressed by its durable queue record id, which is the only stable handle
  // it has: it has no order number, and it must not be given one.
  function openReceipt(receiptId: string) {
    if (
      lastCompletedReceipt?.orderId === receiptId ||
      lastProvisionalReceipt?.queueRecordId === receiptId
    ) {
      setReceiptOpen(true);
    }
  }

  function closeReceipt() {
    setReceiptOpen(false);
  }

  // v1.3 Cash Drawer Checkpoint 1A — tells the host a sale has SUCCEEDED.
  //
  // Called only from the two success branches of completeSale below, each time
  // AFTER that branch has crossed into the success view. A host that throws
  // here cannot reach the sale: it is already complete, and the throw is
  // swallowed so the success view stays exactly as it is.
  function reportSaleCompleted(saleRequestId: string, paymentMethod: PaymentMethod) {
    if (onSaleCompleted === null) {
      return;
    }

    try {
      onSaleCompleted({ saleRequestId, paymentMethod });
    } catch {
      // Drawer truth is not sale truth.
    }
  }

  async function completeSale() {
    // Feature 24.5A — THE OFFLINE FENCE, and it is deliberately the very first
    // statement in this function.
    //
    // Placed ahead of every other guard so there is no ordering in which a
    // blocked runtime reaches planSaleSubmission, submitSale or the durable
    // enqueue below. A disabled button is a UI affordance; this is the actual
    // boundary, and it is what guarantees no sale RPC is called, no request id
    // is minted and no record is written when a sale must not happen.
    //
    // 24.5E DID NOT MOVE OR WEAKEN THIS. What changed is who sets the reason: a
    // device with a validated cache and a live lease now passes null and
    // supplies queueOfflineSale, while a device that fails any part of that
    // check still lands here with a message saying which part.
    //
    // W-02-RETRY-UX-FIX-1 — the previous attempt's error origin is cleared
    // first. This is a DISPLAY reset, not a guard: it only stops a stale
    // "connection lost" origin from relabelling whatever this press reports.
    setSaleErrorOrigin(null);

    if (checkoutBlockedReason !== null) {
      setSaleSaveStatus("error");
      setSaleSaveError(checkoutBlockedReason);
      return;
    }

    if (cart.length === 0 || !selectedPaymentMethod || checkoutStatus === "success") {
      return;
    }

    // Double-submit guard: a second Pay press while a request is in flight must
    // never start a second attempt.
    //
    // v1.3 CP-2B — the ref JOINS it rather than replacing it. saleSaveStatus is
    // React state, so two activations in one tick both read "idle"; the ref is
    // written in the same turn it is read and closes that window.
    if (saleInFlightRef.current || isSubmitBlocked(saleSaveStatus)) {
      return;
    }

    // v1.3 CP-2B FINAL — the host REFUSED to authorize this checkout when it
    // opened, and that refusal stands for as long as it stays open. Reopening
    // is what asks again; nothing here re-asks on the cashier's behalf, because
    // a checkout that could re-prepare itself is exactly the stale-checkout
    // hole this lifecycle exists to close.
    if (prepareRefusalRef.current !== null) {
      setSaleSaveStatus("error");
      setSaleSaveError(prepareRefusalRef.current);
      return;
    }

    // v1.3 CP-2B — THE SYNCHRONOUS AUTHORIZATION BOUNDARY.
    //
    // From here to the claim below there is no `await`, which is what makes it
    // atomic: nobody can ring out, re-pair or press again in the middle of it.
    // The live read happens HERE, not at render time — a snapshot taken by an
    // earlier render is precisely the thing that cannot authorize a sale.
    const liveAuthority = readHostAuthority?.() ?? null;

    const authorization = decideSaleAuthorization({
      hostPresent: readHostAuthority !== null,
      prepared: preparedAuthorityRef.current,
      live: liveAuthority,
      inFlight: saleInFlightRef.current,
      // CP-2B HAS NO TENDER STEP, so no checkout requires a tender
      // authorization and none is fabricated. This is the seam CP-2C fills;
      // until it does, Cash and Card authorize exactly as they do today.
      tender: { required: false },
    });

    if (!authorization.ok) {
      setSaleSaveStatus("error");
      setSaleSaveError(authorization.message);
      return;
    }

    // Feature 24.5F — THE UNKNOWN-OUTCOME GATE.
    //
    // Placed before the offline/online branch and before any identity is
    // resolved, because it governs BOTH paths: whatever this press does next,
    // it must do it under the outstanding request's own key or not at all.
    //
    // The fingerprint is computed here rather than inside either branch so the
    // two cannot drift — it is the same value complete_sale_v3 and
    // complete_sale_v4 hash, so comparing it answers "would the server see this
    // as the same sale?" exactly.
    const fingerprint = createSaleFingerprint({
      projectId: config.project.projectId,
      paymentMethod: selectedPaymentMethod,
      tipAmount: cartSummary.tipAmount,
      items: cart,
    });

    // Feature 24.5F — THE DURABLE COPY WINS.
    //
    // `persistedUncertainSale` came off disk and survives a process kill;
    // `uncertainSale` is this component's own memory of the same event and is
    // gone the moment the app is. Preferring the durable one means a restart
    // resumes exactly where the previous process left off, and it also fails in
    // the safe direction if the two ever disagree: a record that is still on
    // disk keeps blocking even if local state has forgotten it.
    const uncertainty = decideUncertainSale(
      persistedUncertainSale ?? uncertainSale,
      fingerprint
    );

    if (uncertainty.status === "locked") {
      // NOTHING IS SENT and no identity is minted. The sale that may already
      // exist keeps its key, the cart is untouched, and the operator is told
      // how to get back to a state that can be resolved.
      setSaleSaveStatus("error");
      setSaleSaveError(uncertainty.message);
      return;
    }

    // The identity an outstanding request must be resumed under, if there is
    // one. Null for an ordinary sale.
    const resumed =
      uncertainty.status === "resume"
        ? { id: uncertainty.saleRequestId, fingerprint }
        : null;

    // Feature 24.5F — WAS this sale already uncertain before this press?
    //
    // Modelled explicitly from the gate's own decision, never inferred from a
    // message. It is the difference between "we armed this a moment ago purely
    // to protect the dispatch window" and "an earlier attempt genuinely went
    // unanswered", and those two demand opposite handling of a rejection.
    const wasAlreadyUncertain = uncertainty.status === "resume";

    // v1.3 CP-2B — THE CLAIM, the last synchronous statement before any await.
    saleInFlightRef.current = true;

    setSaleSaveStatus("saving");
    setSaleSaveError(null);

    // v1.3 CP-2B — the armed identity, kept so an UNEXPECTED THROW after the
    // durable arm still protects the outcome. Set only once the arm actually
    // succeeded, so it stays null for every pre-dispatch failure.
    let armedUncertainty: UncertainSale | null = null;

    try {
      // G-1-CLIENT-1 — AN OUTSTANDING SALE IS RECOVERED, NEVER RESUBMITTED.
      //
      // Before this, pressing Pay on an unanswered sale sent it again: online
      // through complete_sale_v5 under whoever was signed in NOW, or offline
      // into an ordinary queue record carrying the current employee and the
      // current time. Both completed the sale under the wrong person — W-02
      // finding G-1. The host now finishes it under its original id and its
      // ORIGINAL attribution, or keeps it protected and says why.
      //
      // Placed ahead of both branches because it governs both, and after the
      // unknown-outcome gate, which is what established `resumed`: only the
      // EXACT outstanding sale reaches here, never a changed cart.
      if (resumed !== null && recoverOutstandingSale !== null) {
        const generation = preparedCheckoutRef.current?.generation ?? -1;

        const resumeAuthorization = authorizeSaleDispatch?.({
          requestId: resumed.id,
          fingerprint,
          checkoutGeneration: generation,
        }) ?? { decision: "new_sale" as const };

        if (resumeAuthorization.decision === "blocked") {
          setSaleSaveStatus("error");
          setSaleSaveError(resumeAuthorization.reason);
          return;
        }

        const recovered = await recoverOutstandingSale({
          saleRequestId: resumed.id,
          paymentMethod: selectedPaymentMethod,
          tipAmount: cartSummary.tipAmount,
          cart,
          checkoutGeneration: generation,
        });

        if (recovered.kind === "protected") {
          // NOTHING CHANGES: the cart, the request id and the durable record
          // all stay, so the same sale can be finished later.
          setSaleSaveStatus("error");
          setSaleSaveError(recovered.message);

          // Only a positively classified transport failure may move the till
          // into its validated offline mode, exactly as on the online path.
          if (recovered.failure === "transport") {
            onSaleRejected?.({ message: recovered.message, failure: "transport" });
          }

          return;
        }

        // RESOLVED: by a validated receipt, a validated lookup match, or a
        // verified durable transfer to a strict queue record. The next sale
        // mints its own identity.
        setSaleRequest(null);
        setUncertainSale(null);
        setLastCompletedReceipt(recovered.kind === "completed" ? recovered.receipt : null);
        setLastProvisionalReceipt(recovered.kind === "queued" ? recovered.receipt : null);
        clearCart();
        setCheckoutStatus("success");
        invalidateCheckoutAuthorization?.(generation);
        setSaleSaveStatus("success");
        // A recorded sale has no receipt to show — the lookup returns a summary,
        // not a receipt, and none is invented — so the host's sentence is shown.
        setSaleSaveError(
          recovered.kind === "recorded"
            ? recovered.message
            : recovered.kind === "queued" && recovered.receipt === null
              ? OFFLINE_RECEIPT_UNAVAILABLE_NOTE
              : null
        );
        // The completion point for a recovered sale. The drawer ledger is keyed
        // on the sale request id, so a sale whose completion was already
        // reported cannot open the drawer a second time. Online, the payment
        // method is the SERVER's record of it, as on the online path below.
        const recoveredPaymentMethod =
          recovered.kind === "completed" ? recovered.receipt.paymentMethod : selectedPaymentMethod;

        reportSaleCompleted(recovered.saleRequestId, recoveredPaymentMethod);
        return;
      }

      // Feature 24.5E — THE OFFLINE BRANCH, and the ordering below is the whole
      // safety property of this feature:
      //
      //   await the host's durable write
      //     -> if it failed, STOP. The cart is untouched, nothing says "saved",
      //        and no receipt is produced. There is no memory-only fallback and
      //        no optimistic success anywhere on this path.
      //     -> only once it succeeded: keep the receipt, clear the cart, and
      //        show the success view.
      //
      // Nothing here submits. The host has already made the sale durable; the
      // sync engine sends it to complete_sale_v4 later, from storage, on its own
      // schedule. This component has never heard of that RPC.
      if (queueOfflineSale !== null) {
        // v1.3 CP-2B — the same final gate on the offline path. An unresolved
        // online identity must not be allowed to become a NEW offline
        // transaction, and an authority that changed since this checkout was
        // prepared must not be allowed to author one either.
        const offlineAuthorization = authorizeSaleDispatch?.({
          // NULL when this is an ordinary offline sale: the host mints the
          // draft identity itself, further down, and this runtime has no id to
          // name. An empty string here would be a sentinel the host could not
          // tell apart from a real request id.
          requestId: resumed?.id ?? null,
          fingerprint: fingerprint,
          checkoutGeneration: preparedCheckoutRef.current?.generation ?? -1,
        }) ?? { decision: "new_sale" as const };

        if (offlineAuthorization.decision === "blocked") {
          setSaleSaveStatus("error");
          setSaleSaveError(offlineAuthorization.reason);
          return;
        }

        const saved = await queueOfflineSale({
          paymentMethod: selectedPaymentMethod,
          // The same literal-0 tip the online path uses. There is still no
          // tip-entry UI, and complete_sale_v4 rejects a device tip outright.
          tipAmount: cartSummary.tipAmount,
          cart,
          // Feature 24.5F (DEF-01) — ONLY when this very checkout just lost an
          // online attempt on the wire. Outside that window the offline sale is
          // an ordinary new sale and mints its own identity; inheriting a stale
          // id from an unrelated earlier episode would be the duplicate bug in
          // reverse.
          inheritedRequest: resumed,
        });

        if (!saved.ok) {
          // The sale did NOT happen. The cart survives so the cashier can retry
          // before handing anything over — see docs/OFFLINE_ARCHITECTURE.md §18
          // case 15, which requires this failure to be loud and blocking.
          setSaleSaveStatus("error");
          setSaleSaveError(saved.message);
          return;
        }

        // Past this line the sale is on disk.
        //
        // The online identity is released HERE, not earlier: if the enqueue had
        // failed, the cart and that identity both had to survive so the next
        // press was still the same sale. Now that a durable record owns it, the
        // next sale must mint its own — otherwise a later identical cart would
        // inherit this key and replay this sale instead of making its own.
        setSaleRequest(null);
        // RESOLVED. A durable record now owns this key, and the sync engine will
        // submit it exactly once: complete_sale_v4 either creates the order or
        // replays the one complete_sale_v3 already created. Either way there is
        // no longer an unknown outcome for this device to protect.
        setUncertainSale(null);
        // The queue record now owns this key durably, so the outbound-attempt
        // record has nothing left to protect: complete_sale_v4 will create the
        // order or replay the one complete_sale_v3 made, exactly once.
        void resolveOnlineSale?.();
        setLastCompletedReceipt(null);
        setLastProvisionalReceipt(saved.receipt);
        clearCart();
        setCheckoutStatus("success");
        // v1.3 CP-2B FINAL — this checkout's authorization is spent. Named by
        // generation, so a late settle cannot reach the next order's.
        invalidateCheckoutAuthorization?.(preparedCheckoutRef.current?.generation ?? -1);
        setSaleSaveStatus("success");
        // Informational only, on the success screen: the sale is saved either
        // way, and this says nothing about whether it was recorded.
        setSaleSaveError(saved.receipt === null ? OFFLINE_RECEIPT_UNAVAILABLE_NOTE : null);
        // v1.3 Cash Drawer Checkpoint 1A — the OFFLINE completion point. Only
        // here, after the durable save answered ok; never before it, and never
        // from sync, which submits from storage without coming through here.
        reportSaleCompleted(saved.saleRequestId, selectedPaymentMethod);
        return;
      }

      // Feature 18.2 Phase 5A — the stock re-check, the request-id decision and
      // the payload build all moved to lib/saleSubmission.ts, unchanged in
      // behavior, so the Builder Preview's own v3 checkout runs the exact same
      // rules rather than a second copy of them. See that module's header for why
      // sharing these three specifically is what matters.
      const plan = planSaleSubmission({
        projectId: config.project.projectId,
        paymentMethod: selectedPaymentMethod,
        tipAmount: cartSummary.tipAmount,
        cart,
        menuItems,
        // resolveSaleRequest reuses an id whose fingerprint matches, so this is
        // already the replay path. `resumed` is belt-and-braces: if component
        // state ever lost the request while the uncertainty survived, the
        // outstanding key is still what goes back out — never a fresh one.
        current: saleRequest ?? resumed,
      });

      if (!plan.ok) {
        setSaleSaveStatus("error");
        setSaleSaveError(plan.error);
        return;
      }

      setSaleRequest(plan.request);

      // Feature 24.5F — ARM BEFORE DISPATCH, and nothing may come between.
      //
      // From the next statement onwards the request may reach the server, and the
      // process may die before its answer is handled. If the key is not already
      // on disk at that instant it is lost, and the sale becomes unrecognisable
      // to any later attempt — which is how one customer gets two orders.
      //
      // A host without storage (the owner runtime, the Builder preview) supplies
      // no arm function and is unchanged. A host that DOES supply one is
      // promising durability, so a failed write means the sale must not be taken:
      // there is no memory-only fallback for a financial identity, exactly as
      // there is none for a queued sale.
      if (armOnlineSale !== null) {
        const armed = await armOnlineSale(
          createUncertainSale({
            saleRequestId: plan.request.id,
            projectId: config.project.projectId,
            paymentMethod: selectedPaymentMethod,
            tipAmount: cartSummary.tipAmount,
            items: plan.items,
            fingerprint: plan.request.fingerprint,
          })
        );

        if (!armed) {
          setSaleSaveStatus("error");
          setSaleSaveError(SALE_UNPROTECTED_MESSAGE);
          return;
        }

        // v1.3 CP-2B — from here the request is PROTECTED, and an unexpected
        // throw below must keep it so. Recorded only after the arm returned
        // true, so a refused arm leaves it null and the catch treats that
        // failure as genuinely pre-dispatch.
        armedUncertainty = createUncertainSale({
          saleRequestId: plan.request.id,
          projectId: config.project.projectId,
          paymentMethod: selectedPaymentMethod,
          tipAmount: cartSummary.tipAmount,
          items: plan.items,
          fingerprint: plan.request.fingerprint,
        });
      }

      // v1.3 CP-2B — THE FINAL DISPATCH GATE, and it sits here on purpose.
      //
      // The arm above was awaited. During that await the operator can ring out,
      // a register can close and a configuration can be re-resolved, and the
      // authority read before the claim is by now a statement about the past.
      // This is the last instant at which any of that is visible, so the host
      // is asked again — about THIS identity, not about the checkout in general.
      //
      // NO AWAIT BETWEEN THIS VERDICT AND THE DISPATCH BELOW.
      const dispatchAuthorization = authorizeSaleDispatch?.({
        requestId: plan.request.id,
        fingerprint: plan.request.fingerprint,
        // -1 IS NOT A GENERATION THIS HOST CAN HAVE ISSUED. A device host that
        // supplied an authorizer but no preparation leaves this null, and the
        // host refuses rather than defaulting to permission. Hosts with neither
        // function never reach here at all.
        checkoutGeneration: preparedCheckoutRef.current?.generation ?? -1,
      }) ?? { decision: "new_sale" as const };

      if (dispatchAuthorization.decision === "blocked") {
        // REFUSED, AND THE ARMED IDENTITY SURVIVES. Nothing was sent, but the
        // durable record written before this point is NOT deleted: a refusal to
        // dispatch is not proof that no earlier request exists, and the key it
        // protects must outlive this attempt. No new identity is minted.
        setSaleSaveStatus("error");
        setSaleSaveError(dispatchAuthorization.reason);
        return;
      }

      const { receipt, error, failure, rolledBack } = await submitSale({
        projectId: config.project.projectId,
        paymentMethod: selectedPaymentMethod,
        tipAmount: cartSummary.tipAmount,
        // Identifiers and quantities only. buildSaleRequestItems (inside the plan)
        // strips every display name and price adjustment, so there is nowhere in
        // this payload for a client-supplied amount to sit.
        items: plan.items,
        saleRequestId: plan.request.id,
      });

      if (error || !receipt) {
        // The cart is preserved and the request id is retained, so pressing Pay
        // again retries the SAME attempt. A transport failure may already have
        // committed server-side, so the message must not claim the sale failed —
        // the retry will return the original receipt if it did.
        setSaleSaveStatus("error");

        // W-02-RETRY-UX-FIX-1 — the WORDS only; classification, the marker and
        // the retained request id are untouched below.
        //
        //   transport         -> plain "connection lost, may have gone through"
        //                        (never the raw "TypeError: Failed to fetch");
        //   rolled back       -> the server's own message: PostgreSQL refused
        //                        it, so it is a definite, meaningful answer
        //                        (e.g. "One or more items are no longer
        //                        available");
        //   any other answer a classifying host could not resolve (a gateway
        //   504, a malformed response) -> "could not be confirmed", never the
        //                        raw text, because it may have committed;
        //   a host that does not classify at all -> unchanged behaviour.
        const connectionLost = failure === "transport";

        setSaleSaveError(
          connectionLost
            ? SALE_CONNECTION_LOST_MESSAGE
            : failure !== undefined && rolledBack !== true
              ? SALE_UNCONFIRMED_MESSAGE
              : error ?? SALE_UNCONFIRMED_MESSAGE
        );
        setSaleErrorOrigin(connectionLost ? "connection_lost" : null);

        // Feature 24.5F — the request was DISPATCHED and nothing answered, so an
        // order carrying this key may exist. Recorded ONLY on a classified
        // transport failure: a server that answered is a definite outcome, and a
        // host that does not classify at all is not proof of one.
        if (failure === "transport") {
          // The DURABLE record was already written before dispatch; this is the
          // in-memory mirror, so the gate below reacts without waiting for the
          // host to re-read storage. It is never the only copy.
          setUncertainSale(
            createUncertainSale({
              saleRequestId: plan.request.id,
              projectId: config.project.projectId,
              paymentMethod: selectedPaymentMethod,
              tipAmount: cartSummary.tipAmount,
              items: plan.items,
              fingerprint: plan.request.fingerprint,
            })
          );
        } else if (!wasAlreadyUncertain && rolledBack === true) {
          // A FIRST DISPATCH THAT POSTGRESQL DEFINITIVELY REFUSED.
          //
          // The arm written moments ago was protecting a window that has now
          // closed with a known answer: this invocation committed nothing, so
          // there is no order for its key to identify and nothing to resolve. The
          // record is released, and an ordinary "insufficient inventory" goes back
          // to being an ordinary rejection the cashier can fix by editing the cart.
          //
          // Keeping it would brick the till: the same request would keep being
          // refused, the cart could not be changed, and reset would stay blocked
          // forever over a sale that never existed.
          //
          // `rolledBack` REQUIRES A SQLSTATE, so a proxy 502 or a gateway 504 —
          // which can arrive after a commit — does not qualify and is kept.
          void resolveOnlineSale?.();
        }

        // A REJECTION NEVER CLEARS A PRE-EXISTING UNCERTAINTY, and the tempting
        // argument that it should is wrong. It runs: this attempt carried the
        // outstanding key, the sale function resolves that key before doing
        // anything else, so a rejection proves the original never landed.
        //
        // It does not hold, because the idempotency lookup is NOT the first thing
        // that runs. Authorization and the project lock come before it (section 6
        // of complete_sale_v4: "after authorization and the lock"), so a revoked
        // device or a lost session is refused BEFORE the key is ever looked up.
        // Such an answer says nothing about whether the ORIGINAL request — a
        // different invocation entirely — committed.
        //
        // Hence the asymmetry above: a rejection releases only an arm created by
        // THIS dispatch, whose entire history we witnessed. Anything older is kept
        // until a positive resolution proves what happened to it.

        // Feature 16.4A — the host decides what a rejection means for its own
        // authorization. A paired device re-resolves its pairing state here, so a
        // revocation that landed mid-shift moves it to the revoked screen instead
        // of leaving a dead Pay button. The engine itself draws no conclusion.
        onSaleRejected?.({ message: error, failure });
        return;
      }

      // Success: the authoritative payload is the ONLY record kept. The cart is
      // discarded and the request id cleared, so the next sale gets a new id.
      setLastCompletedReceipt(receipt);
      // The server answered. Nothing is unknown any more — clear the durable
      // record as well as this component's copy, in that order of importance.
      setUncertainSale(null);
      void resolveOnlineSale?.();
      // Feature 24.5E — a device that reconnects mid-shift must not be able to
      // reopen the previous offline sale's provisional receipt from the success
      // screen of an online one.
      setLastProvisionalReceipt(null);
      setSaleRequest(null);
      clearCart();

      // Lock the UI into the success view *before* attempting the reload, so
      // there is no window where Complete Sale could be clicked again for a
      // sale that already succeeded — mirrors EditorShell's completeSale.
      setCheckoutStatus("success");

      // v1.3 CP-2B FINAL — spent, exactly as on the offline path above.
      invalidateCheckoutAuthorization?.(preparedCheckoutRef.current?.generation ?? -1);

      // v1.3 Cash Drawer Checkpoint 1A — the ONLINE completion point. Past the
      // authoritative receipt and the success lock above, and before the stock
      // refresh, whose failure is not a failed sale. The payment method is the
      // SERVER's record of it, not the button that was selected.
      reportSaleCompleted(plan.request.id, receipt.paymentMethod);

      // Feature 16.4A — a host with no live stock source (a paired device, which
      // cannot read `projects` under RLS) passes null. The sale is complete and
      // authoritative either way; there is simply nothing to refresh, so the
      // operator is not shown a warning about something they cannot fix.
      if (refreshStock === null) {
        setSaleSaveStatus("success");
        return;
      }

      const { menuItems: latestMenuItems, error: reloadError } = await refreshStock(
        config.project.projectId
      );

      if (reloadError || !latestMenuItems) {
        // The sale already happened — this is a read-only refresh failure,
        // not a failed sale. Non-blocking warning, not an error.
        setSaleSaveStatus("success");
        setSaleSaveError(
          "Sale completed, but inventory could not be refreshed. Reload the page to see the latest stock."
        );
        return;
      }

      // Merge only stockQuantity/trackInventory per matching item id — never
      // overwrite the rest of the local menuItems copy, and never touch
      // config.menuItems itself.
      setMenuItems((prev) =>
        prev.map((item) => {
          const dbItem = latestMenuItems.find(
            (dbMenuItem) => dbMenuItem.id === item.id
          );

          if (!dbItem) {
            return item;
          }

          return {
            ...item,
            stockQuantity: dbItem.stockQuantity,
            trackInventory: dbItem.trackInventory,
          };
        })
      );

      setSaleSaveStatus("success");
    } catch {
      // AN UNCLASSIFIED THROW IS NOT A ROLLBACK.
      //
      // If the durable arm had already succeeded, this request may have left
      // the device and may have committed. Treating the exception as a clean
      // failure would clear the way for a second attempt, under a new identity,
      // for a sale that already exists. Setting the in-memory mirror from the
      // armed identity is what makes decideUncertainSale refuse the next press
      // WITHOUT waiting for the host to re-read storage.
      //
      // THE FENCE IS ESTABLISHED HERE, BEFORE THE finally RELEASES THE GUARD.
      if (armedUncertainty !== null) {
        setUncertainSale(armedUncertainty);
        setSaleSaveStatus("error");
        setSaleSaveError(SALE_UNCONFIRMED_MESSAGE);
      } else {
        // Nothing armed, so nothing dispatched: a genuine pre-dispatch failure.
        //
        // THE THROWN MESSAGE IS NOT SHOWN. A caught exception's text is written
        // for a developer, not a cashier, and no customer-facing surface in this
        // product reads one. The operator gets the same settled sentence every
        // other unconfirmed outcome produces.
        setSaleSaveStatus("error");
        setSaleSaveError(SALE_UNCONFIRMED_MESSAGE);
      }
    } finally {
      // RELEASED ON EVERY PATH, including the throw above, and only after the
      // recovery fence is already in place.
      //
      // Safe on an UNKNOWN outcome, and must be: this ref guards one DISPATCH,
      // while an unresolved OUTCOME is guarded by decideUncertainSale, which is
      // now holding the armed identity. Holding both would duplicate that
      // authority and strand the authorized recovery path.
      saleInFlightRef.current = false;
    }
  }

  return (
    <div className="flex h-screen flex-col bg-neutral-50">
      {/* Feature 19 — the shared header, identical here and in the Builder's
          preview. Serves the owner runtime and the paired device alike, since
          both render this component. */}
      <PosHeader
        businessProfile={config.businessProfile}
        branding={config.branding}
        logoBaseUrl={logoBaseUrl ?? undefined}
        size="full"
        trailing={
          /* Feature 16.4A — a paired device passes null: a till has nowhere to
             go back to, and must not offer a route into the owner app. */
          homeLink !== null ? (
            <Link
              href={homeLink.href}
              onClick={(event) => {
                if (cart.length > 0 && !window.confirm(LEAVE_CONFIRM_MESSAGE)) {
                  event.preventDefault();
                }
              }}
              className="flex-none text-sm font-medium text-white/90 transition-colors hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              {homeLink.label}
            </Link>
          ) : (
            // Feature 25.1 — the device's own affordance. Never rendered
            // alongside a homeLink: an owner runtime has a way back, a till has
            // settings, and neither surface gets both.
            headerTrailing ?? undefined
          )
        }
      />

      {/* Feature 16.2 Android fix — this row was unconditionally
          `flex-row` with a fixed 24rem (384px) cart beside a flex-1 product
          panel, which is a desktop-only assumption. Measured on the Android
          emulator (411 x 866 CSS px, the Medium_Phone AVD at 420dpi): the
          384px `flex-none` cart consumed 93% of the width, leaving the
          product panel 27px wide with its 2-column grid overflowing
          horizontally (scrollerW=27 vs gridScrollW=51). The panel was
          technically still scrollable, but 27px is unusable — which is why
          it read as "the left section does not scroll".
          Notably NOT the cause: 100vh measured exactly equal to
          window.innerHeight (866 = 866), and the flex/overflow chain
          already produced a correctly bounded scroll container, because
          `overflow: hidden`/`overflow-y: auto` zero out the automatic
          minimum size. So no 100dvh change and no scroll-container
          restructuring were needed.
          Below `md` the panels now stack vertically, each keeping its own
          independent scroll (the page itself still does not scroll). At
          `md` and above every value is byte-identical to before —
          verified: leftW=896, cartW=384, flex-direction row, scroller
          height 693 in both. */}
      <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white">
          {/* v1.3 Lane 2 Task 2 — templateId selects a presentation variant
              (see components/editor/pos-layouts/index.tsx). It is already on
              the pinned GeneratedPosConfig contract, so this adds no field,
              no fetch and no persisted state. */}
          <ProductBrowser
            layout={config.project.layout}
            templateId={config.project.templateId}
            barcodeScanningEnabled={isBarcodeScanningEnabled(config.features)}
            scanFocusRequest={scanFocusRequest}
            sellingSurfaceActive={sellingSurfaceActive}
            menuItems={menuItems}
            selectedItemId={null}
            editorMode="preview"
            branding={config.branding}
            currencySymbol={currencySymbol}
            onSelect={() => {}}
            onAddToCart={addToCart}
          />
        </div>

        {/* Below `md` the cart becomes a full-width bottom panel with a
            bounded share of the height, so the product panel above keeps
            the majority of the screen. `overflow-hidden` is retained
            unchanged at every width because the checkout and receipt
            overlays inside this panel are `absolute inset-0` and depend on
            this element staying their positioning context. */}
        <aside className="relative flex h-[45%] min-h-0 w-full flex-none flex-col overflow-hidden border-t border-neutral-200 bg-neutral-50 md:h-auto md:w-96 md:border-l md:border-t-0">
          <PosCheckoutPanel
            menuItems={menuItems}
            cart={cart}
            cartSummary={cartSummary}
            currencySymbol={currencySymbol}
            orderNumber=""
            tax={config.tax}
            receipt={config.receipt}
            businessProfile={config.businessProfile}
            branding={config.branding}
            onIncreaseQuantity={increaseQuantity}
            onDecreaseQuantity={decreaseQuantity}
            onRemoveFromCart={removeFromCart}
            onClearCart={clearCart}
            checkoutOpen={checkoutOpen}
            onOpenCheckout={openCheckout}
            onCloseCheckout={closeCheckout}
            selectedPaymentMethod={selectedPaymentMethod}
            onSelectPaymentMethod={selectPaymentMethod}
            checkoutStatus={checkoutStatus}
            onCompleteSale={completeSale}
            checkoutBlockedReason={checkoutBlockedReason}
            saleSaveStatus={saleSaveStatus}
            saleSaveError={displayedSaleError}
            recentOrders={[]}
            lastCompletedOrderId={
              lastCompletedReceipt?.orderId ??
              lastProvisionalReceipt?.queueRecordId ??
              null
            }
            lastOfflineReference={lastProvisionalReceipt?.offlineReference ?? null}
            onOpenReceipt={openReceipt}
            authoritativeReceipt={shownReceipt}
            provisionalReceipt={shownProvisionalReceipt}
            onCloseReceipt={closeReceipt}
            cashTender={cashTenderOutcome}
            cashTenderStep={
              cashTenderActive && cashTenderDecision !== null && cashTenderContext !== null ? (
                <CashTenderPad
                  currency={config.receipt.currency}
                  currencySymbol={currencySymbol}
                  branding={config.branding}
                  amountDueFixed={cashTenderContext.amountDueFixed}
                  entry={cashEntry}
                  decision={cashTenderDecision}
                  pressRefusal={cashTenderPressRefusal}
                  busy={isSubmitBlocked(saleSaveStatus)}
                  // The same value the Complete Sale screen receives, so the
                  // 24.5F offline-available substitution reaches this step too.
                  saleError={saleSaveStatus === "error" ? displayedSaleError : null}
                  blockedReason={checkoutBlockedReason}
                  onEntryChange={changeCashEntry}
                  onDone={completeCashSale}
                  onBack={leaveCashTender}
                />
              ) : null
            }
          />
        </aside>
      </div>

      {/* Print-only copy — see app/globals.css's .receipt-print-area rules
          and PosCheckoutPanel's own comment for why this must be a
          top-level sibling of the overflow-hidden layout above rather than
          nested inside it. */}
      {shownReceipt && (
        <div className="receipt-print-area">
          <AuthoritativeReceipt
            receipt={shownReceipt}
            presentation={livePresentation}
            cashTender={cashTenderOutcome}
          />
        </div>
      )}

      {/* Feature 24.5E — the same print mechanism, a different document. The
          existing Print Receipt button and the existing .receipt-print-area
          stylesheet are reused unchanged; no second printing stack exists. What
          is printed carries the OFFLINE RECEIPT banner and no order number. */}
      {shownProvisionalReceipt && (
        <div className="receipt-print-area">
          <OfflineReceipt
            receipt={shownProvisionalReceipt}
            presentation={livePresentation}
            cashTender={cashTenderOutcome}
          />
        </div>
      )}
    </div>
  );
}
