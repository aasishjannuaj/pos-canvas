// Feature 26.2 — may this till apply the configuration update it has been
// offered, right now?
//
// ONE DECISION, THREE INPUTS. The till must refuse an update while a cart is
// open, while it holds money the server has not acknowledged, or while it
// cannot reach the server. Each is a different kind of unsafe and each gets its
// own sentence, but there is exactly one function that answers the question and
// exactly one place that calls it.
//
// IT INVENTS NO FINANCIAL RULE. The money half is decideDeviceResetSafety,
// unchanged and re-used: the same durable read, the same counts, the same
// refusal an unpair already performs. A second opinion about whether unsynced
// sales are dangerous is the last thing this codebase needs — if that rule ever
// changes, it must change in one place and both callers must follow.
//
// WHY A CART BLOCKS AT ALL. Applying an update repins the build every
// complete_sale* prices from. A cart rung up against the old menu, checked out
// a moment after the pin moved, would be priced by the server from the NEW
// snapshot: the customer sees one total on screen and the books record another.
// The cart is not cleared to make that impossible — clearing a cashier's work
// to enable a background convenience is not a trade this feature gets to make.

import type { OfflineSaleStatus } from "@/lib/offlineSaleStatus";
import { decideDeviceResetSafety } from "@/lib/offlineSaleStatus";

/** Why an apply was refused before any request was made. */
export type ApplyUpdateBlockedReason =
  | "cart"
  | "cart_unreadable"
  | "unresolved_sales"
  | "offline";

export type ApplyUpdateSafety =
  | { allowed: true }
  | { allowed: false; reason: ApplyUpdateBlockedReason; message: string };

export const APPLY_BLOCKED_CART_MESSAGE =
  "Finish or clear the current cart before applying this update.";

/**
 * The POS is not answering the one question that gates this action.
 *
 * Reachable only if the runtime is not mounted while Device settings is open,
 * which the screen's own structure makes impossible today. It exists because
 * "I could not read the cart" and "the cart is empty" must never be the same
 * answer: the first is a refusal, and only the second is permission.
 */
export const APPLY_BLOCKED_CART_UNREADABLE_MESSAGE =
  "This device could not confirm the current cart is empty. Return to the POS and try again.";

export const APPLY_BLOCKED_OFFLINE_MESSAGE =
  "This device needs an internet connection to apply the update. Reconnect and try again.";

/**
 * What the server said, in the operator's words.
 *
 * NONE OF THESE IMPLY DAMAGE, because none of them cause any: a refused apply
 * leaves the till on the build it was already using, still selling, still
 * priced exactly as it was a moment ago.
 */
export const APPLY_UNREACHABLE_MESSAGE =
  "This device could not reach POS Canvas to apply the update. Check the connection and try again.";

export const APPLY_FAILED_MESSAGE =
  "POS Canvas could not apply the update. This device is still using its current menu. Try again in a moment.";

/**
 * `no_update_offered` and `offer_unusable` share a message on purpose.
 *
 * They differ only in why the offer stopped being valid — withdrawn, replaced,
 * or its build deleted — and an operator can do nothing different about either.
 * What they need to know is that there is nothing to apply and nothing is
 * wrong with their till.
 */
export const OFFER_WITHDRAWN_MESSAGE =
  "This update is no longer available. This device is still using its current menu.";

/**
 * Feature 26.2 — the server repinned, and then this device could not load what
 * it repinned to.
 *
 * THE ONE STATE THAT MUST NOT BE SOFTENED. The pin has already moved: the
 * server will now price this till's sales from the new build, while the only
 * configuration on the device is the old one. Selling from it would show a
 * customer one total and record another, so the till stops instead. This copy
 * belongs to a blocking screen, never to a toast.
 */
export const APPLY_RELOAD_FAILED_MESSAGE =
  "The update was applied, but this device could not load the new menu. Reconnect to POS Canvas to finish updating. This device cannot take payments until it does.";

export type ApplyUpdateSafetyInput = {
  /**
   * Cart lines open in the runtime AT THIS INSTANT. Any line at all blocks.
   *
   * `null` means the runtime could not be asked, and is also a block. This is
   * deliberately not `number` with a 0 default: a default would turn "unknown"
   * into "safe", which is the single most dangerous coercion available here.
   *
   * The caller must read this from PosRuntime's layout-effect ref, never from a
   * mirrored count — see the note on PosRuntimeProps.cartLineCountRef.
   */
  cartLineCount: number | null;
  /** The durable read, exactly as an unpair takes it. */
  saleStatus: OfflineSaleStatus;
  /**
   * readOnlineHint()'s answer: true, false, or null when the host cannot say.
   *
   * ONLY `false` BLOCKS. navigator.onLine lies in the permissive direction — a
   * captive portal reports online — so this is worth nothing as permission and
   * something as a refusal: a browser that is sure it has no network is right
   * about that, and skipping a doomed request keeps the operator out of a
   * pointless timeout. `null` (no navigator, a host that does not implement it)
   * proceeds and lets the transport answer, which is the authority anyway.
   */
  onlineHint: boolean | null;
};

/**
 * The same refusal, worded for Apply.
 *
 * Reads counts to phrase a sentence; it decides nothing. `decideDeviceResetSafety`
 * has already ruled by the time this is called, and if that rule ever changes
 * this text follows it automatically — the only thing that could drift is a
 * number in a sentence, never whether the till is allowed to repin.
 */
export function describeApplyBlockedBySales(status: OfflineSaleStatus): string {
  if (status.uncertainOnlineSale) {
    return (
      "A sale on this device may already have gone through, and this device still " +
      "holds the only record of it. Finish that sale before applying this update."
    );
  }

  const count = status.unsynced;
  const sales = count === 1 ? "1 sale" : `${count} sales`;
  const they = count === 1 ? "it" : "them";

  return (
    `This device still has ${sales} that ${count === 1 ? "has" : "have"} not reached ` +
    `POS Canvas yet. Let ${they} finish syncing before applying this update.`
  );
}

/**
 * The single authoritative local answer.
 *
 * ORDER IS DELIBERATE. The cart comes first because it is the one condition the
 * operator can resolve in seconds and the one they are most likely staring at.
 * Money comes second because it is the most serious and its message is the
 * longest. Connection comes last: it is the only one that may resolve itself.
 *
 * A `true` here is permission to ATTEMPT, never a promise of success. The server
 * re-validates everything at apply time and may still refuse.
 */
export function decideApplyUpdateSafety(input: ApplyUpdateSafetyInput): ApplyUpdateSafety {
  if (input.cartLineCount === null) {
    return {
      allowed: false,
      reason: "cart_unreadable",
      message: APPLY_BLOCKED_CART_UNREADABLE_MESSAGE,
    };
  }

  if (input.cartLineCount > 0) {
    return { allowed: false, reason: "cart", message: APPLY_BLOCKED_CART_MESSAGE };
  }

  // Feature 24.5E/24.5F's RULE, borrowed whole — the decision is
  // decideDeviceResetSafety's and this module does not second-guess it.
  //
  // Its MESSAGE is not borrowed, and that distinction is the point. Its wording
  // ends "...before resetting this device", which is correct for the unpair it
  // was written for and wrong here: the operator pressed Apply update, and
  // telling them to reset a till over a pending sale is telling them to do
  // something they did not ask for and should not do. Same rule, right verb.
  const financial = decideDeviceResetSafety(input.saleStatus);

  if (!financial.allowed) {
    return {
      allowed: false,
      reason: "unresolved_sales",
      message: describeApplyBlockedBySales(input.saleStatus),
    };
  }

  if (input.onlineHint === false) {
    return { allowed: false, reason: "offline", message: APPLY_BLOCKED_OFFLINE_MESSAGE };
  }

  return { allowed: true };
}
