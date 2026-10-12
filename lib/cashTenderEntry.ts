// v1.3 CP-2C Cash Tender — dollars-first entry, and the Done decision.
//
// PURE. No React, no DOM, no browser event, no Supabase, no node builtin, no
// side effect, no clock. Same reason as lib/cashTender.ts: this repository runs
// Vitest under `environment: "node"` with no DOM and no @testing-library, so
// every rule that has to be PROVEN lives here and the component that renders it
// stays a thin shell with no decisions of its own.
//
// WHY THIS MODULE EXISTS AT ALL, GIVEN THAT lib/cashTender.ts IS ACCEPTED.
// CP-1C's keypad is CENTS-FIRST by explicit design: digits shift in from the
// right, so 8, 7, 5 is 8.75 and there is no decimal key. CP-2C's requirement is
// the opposite — "typing 40 means $40.00". Those two cannot both be true of one
// function, so this module supplies the DIFFERENT INPUT INTERPRETATION and
// nothing else. It changes no money rule:
//
//   the ceiling             -> MAX_TENDER_FIXED / MAX_TENDER_DIGITS (CP-1C)
//   additive denominations  -> applyTenderDenomination (CP-1C)
//   which notes exist       -> cashDenominations (CP-1C)
//   is it enough, what change -> validateCashTender (CP-1C)
//   staleness identity      -> buildCashTenderBinding (CP-1C)
//
// Every figure still comes from lib/money.ts by way of those functions. There is
// no second money implementation here, no `Number`, no `parseFloat`, no
// `toFixed`, and no integer-cent arithmetic: minor units appear only as the
// CANONICAL DIGIT STRING CP-1C already defined, and this module's only original
// work is converting a dollars-shaped keystroke buffer into it.
//
// THE ENTRY IS TEXT, NOT A NUMBER, AND THAT IS DELIBERATE. "40", "40." and
// "40.0" are three different things a cashier can be halfway through typing and
// all three mean four thousand minor units. Storing the buffer as money would
// destroy the difference and make the decimal key feel broken; storing it as a
// number would reintroduce floating point on a money path. So the buffer is the
// keystrokes, and it becomes money exactly once, through CP-1C.
//
// CASHIER INPUT IS NEVER AN EXCEPTION. Every refusal in this file is a returned
// value, including the ones that come back from CP-1C. buildCashTenderBinding
// DOES throw by design — it refuses to hand back a binding for malformed input
// — so the two places that call it here catch that and report `malformed`
// instead. Nothing in this module can throw at a keypress or at Done.
//
// IT DECIDES NOTHING ABOUT A SALE. decideCashTenderSubmission reports whether
// this tender may be handed to the checkout flow that already exists. It does
// not submit, authorise, persist, open a drawer, mint a sale identity, or know
// what a sale is. PosRuntime's completeSale owns all of that and is unchanged.

import {
  applyTenderDenomination,
  buildCashTenderBinding,
  cashTenderBindingsMatch,
  EMPTY_TENDER_DIGITS,
  formatTenderDigits,
  MAX_TENDER_DIGITS,
  validateCashTender,
} from "@/lib/cashTender";
import { compareMoney, formatMoney, moneyFromFixedString, subtractMoney } from "@/lib/money";

// ---------------------------------------------------------------------------
// Shape of the entry buffer
// ---------------------------------------------------------------------------

/** Nothing typed yet. Distinct from "0", which is a real zero the cashier typed. */
export const EMPTY_CASH_ENTRY = "";

/**
 * How many whole-unit digits the buffer accepts.
 *
 * DERIVED FROM CP-1C, NOT PICKED. MAX_TENDER_DIGITS is 12 minor-unit digits
 * because the server's ceiling is 9999999999.99; two of those digits are the
 * cents, so ten of them are the dollars. Writing `10` here instead would let
 * the two modules disagree about the ceiling the moment either changed.
 */
export const MAX_CASH_ENTRY_WHOLE_DIGITS = MAX_TENDER_DIGITS - 2;

/** How many decimal places a cashier may type. Money has two. */
export const MAX_CASH_ENTRY_DECIMALS = 2;

/**
 * A buffer this module will read: whole digits, optionally a point, at most two
 * decimals.
 *
 * It matches the EMPTY string too, and it deliberately matches INCOMPLETE
 * states like "40." and "4" — those are not errors, they are what a buffer
 * looks like between keystrokes. What it does not match is anything that could
 * never become money: a second point, a third decimal, a sign, a space, a
 * separator, or a bare ".".
 */
const CASH_ENTRY_SHAPE = /^(?:\d+(?:\.\d{0,2})?)?$/;

const SINGLE_DIGIT = /^[0-9]$/;

/**
 * Is this buffer one this module wrote, or at least one it could have?
 *
 * THE `typeof` IS LOAD-BEARING, for the same reason lib/cashTender.ts spells it
 * out: `RegExp.prototype.test` coerces its argument first, so
 * `CASH_ENTRY_SHAPE.test(40)` is `true` and `CASH_ENTRY_SHAPE.test([])` is
 * `true`. Without this a number or an array arriving through an unsafe cast
 * would be canonicalised into an apparently valid entry.
 */
function isCashEntry(value: unknown): value is string {
  return typeof value === "string" && CASH_ENTRY_SHAPE.test(value);
}

/**
 * The buffer to echo back on a refusal.
 *
 * A malformed STRING is still what the caller currently has, so it is returned
 * unchanged — a refusal never edits what it refused. A non-string was never a
 * buffer, and echoing it would put a number or an array into a field typed
 * `string`, so there is nothing honest to return but empty.
 */
function priorEntry(value: unknown): string {
  return typeof value === "string" ? value : EMPTY_CASH_ENTRY;
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/**
 * Why a keystroke was refused.
 *
 * TYPED, NEVER THROWN, AND NEVER SILENT — CP-1C's rule, kept. A keystroke that
 * would exceed a limit is reported rather than dropped, because a cashier who
 * sees nothing happen presses harder.
 */
export type CashEntryRefusal =
  | "invalid_character"
  | "duplicate_decimal_point"
  | "too_many_decimals"
  | "max_input_reached"
  | "max_amount_exceeded";

export type CashEntryResult =
  | { ok: true; entry: string }
  | { ok: false; refusal: CashEntryRefusal; entry: string };

const refuse = (entry: string, refusal: CashEntryRefusal): CashEntryResult => ({
  ok: false,
  refusal,
  entry,
});

/** Splits a well-shaped buffer into its two halves. */
function splitEntry(entry: string): { whole: string; fraction: string; pointed: boolean } {
  const pointAt = entry.indexOf(".");

  if (pointAt < 0) {
    return { whole: entry, fraction: "", pointed: false };
  }

  return {
    whole: entry.slice(0, pointAt),
    fraction: entry.slice(pointAt + 1),
    pointed: true,
  };
}

/**
 * Appends one digit, DOLLARS FIRST.
 *
 * So 4 then 0 is forty dollars, which is the whole point of this module: the
 * cashier types the number on the note in their hand, left to right, the way
 * they would say it.
 *
 * THE PRICE OF DOLLARS-FIRST IS THAT INVALID INPUT BECOMES EXPRESSIBLE, and
 * paying it honestly is why this function is longer than CP-1C's. Cents-first
 * made "1.2.3" and three decimal places unrepresentable; a decimal key brings
 * them back, so each one is refused explicitly and by name rather than being
 * left to the validator to notice later.
 *
 * A LEADING ZERO IS REPLACED, NOT STACKED. Pressing 0 then 5 is five dollars,
 * not "05" — the zero was the cashier starting to type, not a value. But "0."
 * is a real state on the way to "0.75", so the replacement only applies while
 * the buffer is exactly "0".
 */
export function appendCashEntryDigit(entry: string, digit: string): CashEntryResult {
  if (!isCashEntry(entry)) return refuse(priorEntry(entry), "invalid_character");
  if (typeof digit !== "string" || !SINGLE_DIGIT.test(digit)) {
    return refuse(entry, "invalid_character");
  }

  const { whole, fraction, pointed } = splitEntry(entry);

  if (pointed) {
    if (fraction.length >= MAX_CASH_ENTRY_DECIMALS) {
      return refuse(entry, "too_many_decimals");
    }

    return { ok: true, entry: `${whole}.${fraction}${digit}` };
  }

  // "0" was a start, not an amount. Anything else grows.
  if (whole === "0") return { ok: true, entry: digit };

  if (whole.length >= MAX_CASH_ENTRY_WHOLE_DIGITS) {
    return refuse(entry, "max_input_reached");
  }

  return { ok: true, entry: whole + digit };
}

/**
 * The decimal key.
 *
 * ON AN EMPTY BUFFER IT WRITES "0.", not ".". A bare "." is not a number and
 * would have to be special-cased by everything downstream; "0." is the same
 * intention spelled in a way that is already valid, and it is what the cashier
 * sees on every other till.
 */
export function appendCashEntryDecimalPoint(entry: string): CashEntryResult {
  if (!isCashEntry(entry)) return refuse(priorEntry(entry), "invalid_character");

  if (entry.indexOf(".") >= 0) return refuse(entry, "duplicate_decimal_point");

  if (entry === EMPTY_CASH_ENTRY) return { ok: true, entry: "0." };

  return { ok: true, entry: `${entry}.` };
}

/**
 * Accepts a WHOLE replacement buffer, as a text input reports one.
 *
 * WHY THE PER-KEYSTROKE FUNCTIONS ARE NOT ENOUGH. A real <input> does not hand
 * over keystrokes; it hands over its new value, and that value can differ from
 * the old one by a paste, a selection overwrite, a delete, a drag, an IME
 * commit or a caret edit in the middle of the number. A physical keyboard
 * reaches the pad through this function alone, which is why the rule it applies
 * is the SAME shape, the SAME whole-digit cap and the SAME canonicalisation the
 * on-screen keys apply — a cashier must not be able to type an amount the
 * buttons would have refused.
 *
 * IT REFUSES BY SNAPPING BACK. On a refusal the caller re-renders the input
 * with the PREVIOUS buffer, so a rejected character never appears. That is the
 * only honest option for a controlled input: silently dropping one character
 * out of a pasted string would leave a different number than the cashier
 * pasted.
 *
 * A COMMA IS READ AS A DECIMAL POINT. "40,50" is how a cashier in a
 * comma-decimal locale types forty euros fifty, and lib/cashTender.ts supports
 * EUR and GBP, so refusing it would be a defect for those tills rather than a
 * safeguard. It cannot be read as a thousands separator here because a
 * thousands-grouped entry is refused either way: "1,000" becomes "1.000",
 * which is three decimal places and is rejected, exactly as it was before this
 * conversion existed. No digit is ever dropped or regrouped.
 */
export function replaceCashEntry(current: string, next: string): CashEntryResult {
  const fallback = isCashEntry(current) ? current : EMPTY_CASH_ENTRY;

  if (typeof next !== "string") return refuse(fallback, "invalid_character");

  // One substitution, before any shape check. A second comma therefore becomes
  // a second point and is refused as a malformed buffer, not silently dropped.
  const typed = next.replace(/,/g, ".");

  if (typed === EMPTY_CASH_ENTRY) return { ok: true, entry: EMPTY_CASH_ENTRY };

  // A bare point is the one incomplete buffer that is not yet well-shaped but
  // is a real intention. Spelled the way the decimal key spells it.
  if (typed === ".") return { ok: true, entry: "0." };

  if (!isCashEntry(typed)) return refuse(fallback, "invalid_character");

  const { whole, fraction, pointed } = splitEntry(typed);
  // "05" was a cashier starting to type, not five cents of a different number.
  const canonicalWhole = whole.replace(/^0+(?=\d)/, "");

  if (canonicalWhole.length > MAX_CASH_ENTRY_WHOLE_DIGITS) {
    return refuse(fallback, "max_input_reached");
  }

  return { ok: true, entry: pointed ? `${canonicalWhole}.${fraction}` : canonicalWhole };
}

/** Removes the last keystroke. Empty stays empty. */
export function backspaceCashEntry(entry: string): CashEntryResult {
  if (!isCashEntry(entry)) return refuse(priorEntry(entry), "invalid_character");

  return { ok: true, entry: entry.slice(0, -1) };
}

/** Back to nothing entered. The Clear key. */
export function clearCashEntry(): CashEntryResult {
  return { ok: true, entry: EMPTY_CASH_ENTRY };
}

/**
 * Adds a whole-unit denomination to whatever is already there.
 *
 * ADDITIVE, SO $20 TWICE IS $40 — and it is additive because CP-1C's
 * applyTenderDenomination is, not because this function does arithmetic. The
 * buffer is converted to CP-1C's canonical digits, CP-1C adds the note, and the
 * result comes back as a canonical buffer. The ceiling, and the refusal rather
 * than a clamp when the sum would pass it, are therefore CP-1C's own.
 *
 * IT CANONICALISES THE BUFFER. Pressing $20 while halfway through typing "40."
 * yields "60.00", not "60." — the cashier added a note to a figure, so the
 * figure is now settled, and leaving a dangling point would invite a third
 * decimal keystroke that then had to be refused.
 *
 * MEMBERSHIP IS STILL NOT ENFORCED HERE. CP-1C's own documentation puts that
 * obligation on the caller: a quick-tender UI must take its buttons
 * exclusively from `cashDenominations(currency)`. CashTenderPad does.
 */
export function applyCashEntryDenomination(entry: string, wholeUnits: number): CashEntryResult {
  if (!isCashEntry(entry)) return refuse(priorEntry(entry), "invalid_character");

  const digits = cashEntryToTenderDigits(entry);

  if (digits === null) return refuse(entry, "invalid_character");

  const added = applyTenderDenomination(digits, wholeUnits);

  if (!added.ok) {
    // CP-1C reports `invalid_digit` for a denomination that is not a positive
    // safe integer. Renamed rather than passed through, because at this layer
    // the rejected thing was a button, not a character.
    return refuse(entry, added.refusal === "invalid_digit" ? "invalid_character" : added.refusal);
  }

  return { ok: true, entry: formatTenderDigits(added.digits) };
}

// ---------------------------------------------------------------------------
// Reading the buffer
// ---------------------------------------------------------------------------

/**
 * The buffer as CP-1C's canonical minor-unit digit string, or null if it is not
 * a buffer this module will read.
 *
 * CANONICAL MEANS NO LEADING ZEROS, because that is what CP-1C's
 * requireTenderDigits demands of a binding — it rejects "0400" and it rejects
 * "0". So a buffer that amounts to nothing returns EMPTY_TENDER_DIGITS, exactly
 * as an untouched keypad does, and the difference between "typed nothing" and
 * "typed zero" is NOT carried here. isZeroCashEntry carries it instead, so that
 * a cashier who typed 0 is told their tender is not positive rather than being
 * told they typed nothing.
 */
export function cashEntryToTenderDigits(entry: string): string | null {
  if (!isCashEntry(entry)) return null;
  if (entry === EMPTY_CASH_ENTRY) return EMPTY_TENDER_DIGITS;

  const { whole, fraction } = splitEntry(entry);
  const minor = `${whole}${fraction.padEnd(MAX_CASH_ENTRY_DECIMALS, "0")}`.replace(/^0+/, "");

  return minor;
}

/** Did the cashier type something that amounts to zero? */
export function isZeroCashEntry(entry: string): boolean {
  if (entry === EMPTY_CASH_ENTRY) return false;

  return cashEntryToTenderDigits(entry) === EMPTY_TENDER_DIGITS;
}

/**
 * The buffer as a fixed two-decimal string.
 *
 * An unreadable buffer and an empty one both render "0.00" — what a till shows
 * before anyone has typed. As in CP-1C, that display is NOT the decision:
 * decideCashTenderSubmission still reports `missing` for an empty buffer rather
 * than treating it as an accepted zero tender.
 */
export function formatCashEntryAmount(entry: string): string {
  const digits = cashEntryToTenderDigits(entry);

  if (digits === null) return "0.00";

  return formatTenderDigits(digits);
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

/**
 * Everything the tender is tied to, as the runtime sees it right now.
 *
 * `checkoutRevision` is the counter CP-1C made REQUIRED, and its documentation
 * is explicit about what it buys and what it costs: a pure function cannot see
 * that a cart went A -> B -> A, so without a counter a stale confirmation
 * compares EQUAL to a live one. It also says the counter working at all "holds
 * only while the runtime actually advances it on every mutation", and that no
 * pure test here can prove the runtime does. PosRuntime advances it in one
 * place — bumpCheckoutRevision — called from every cart mutator and from the
 * payment-method selector, and a structural guard asserts that.
 */
export type CashTenderContext = {
  checkoutSessionId: string;
  cartIdentity: string;
  amountDueFixed: string;
  checkoutRevision: number;
};

/**
 * The binding for this buffer against this context, or null if either is not
 * something a binding may be built from.
 *
 * NULL RATHER THAN A THROW, because this is called on every keystroke and on
 * every render. CP-1C throws here on purpose — "the builder returns a binding
 * or it returns nothing" — and that is the right contract for the builder. At
 * this layer the honest translation of "no binding" is a value, and the one
 * thing that must never happen is a binding being INVENTED for input the
 * builder refused: null propagates into `malformed`, never into a submission.
 */
export function captureCashTenderBinding(
  context: CashTenderContext,
  entry: string
): string | null {
  const digits = cashEntryToTenderDigits(entry);

  if (digits === null) return null;

  try {
    return buildCashTenderBinding({
      checkoutSessionId: context?.checkoutSessionId,
      cartIdentity: context?.cartIdentity,
      amountDueFixed: context?.amountDueFixed,
      tenderDigits: digits,
      checkoutRevision: context?.checkoutRevision,
    });
  } catch {
    return null;
  }
}

/**
 * Has the checkout moved underneath an entered tender?
 *
 * TRUE WHEN THERE IS NOTHING TO COMPARE. A missing capture is not evidence that
 * nothing changed, so it reads as stale: on a money path the absence of proof
 * is not proof of absence. The one caller that must not show "the total
 * changed" for an untouched keypad checks for an empty buffer first.
 */
export function isCashTenderStale(
  capturedBinding: string | null,
  liveBinding: string | null
): boolean {
  if (capturedBinding === null || liveBinding === null) return true;

  return !cashTenderBindingsMatch(capturedBinding, liveBinding);
}

// ---------------------------------------------------------------------------
// The Done decision
// ---------------------------------------------------------------------------

export type CashTenderRefusal =
  | "submission_in_progress"
  | "missing"
  | "malformed"
  | "not_positive"
  | "insufficient"
  | "excessive"
  | "stale_total";

/**
 * What the cashier reads. Frozen and exported so the tests assert the exact
 * words rather than a paraphrase, and so the component cannot quietly reword a
 * refusal into something softer than it is.
 */
export const CASH_TENDER_MESSAGES: Readonly<Record<CashTenderRefusal, string>> = Object.freeze({
  submission_in_progress: "This sale is already being completed.",
  missing: "Enter the cash received.",
  malformed: "That cash amount could not be read. Clear it and enter it again.",
  not_positive: "Enter a cash amount greater than zero.",
  insufficient: "That is not enough to cover the total.",
  excessive: "That cash amount is too large.",
  stale_total: "The order total changed. Check the total and enter the cash received again.",
});

export type CashTenderSubmission =
  | {
      status: "submit";
      /** What the cashier handed over, fixed two decimals. */
      tenderedFixed: string;
      /** What to hand back, fixed two decimals. Never negative. */
      changeFixed: string;
      /** The binding this decision was made against. */
      binding: string;
    }
  | {
      status: "refused";
      refusal: CashTenderRefusal;
      message: string;
      /** Only on `insufficient`: how far short, fixed two decimals. */
      shortfall?: string;
    };

const refuseSubmission = (
  refusal: CashTenderRefusal,
  shortfall?: string
): CashTenderSubmission => ({
  status: "refused",
  refusal,
  message: CASH_TENDER_MESSAGES[refusal],
  ...(shortfall === undefined ? {} : { shortfall }),
});

/**
 * May this tender be handed to the checkout flow?
 *
 * THE SINGLE GATE BEHIND ONE BUTTON. CP-2C has no Confirm Tender step, so there
 * is no earlier moment at which a tender was blessed and no window between a
 * blessing and a dispatch. Every check below is evaluated against the LIVE
 * context at the instant Done was pressed.
 *
 * THE ORDER OF THE CHECKS IS THE DESIGN, not a sequence that happens to work:
 *
 *   1. in flight      — first, so a second press can never re-enter any of the
 *                       rest of this. See requirement 8.
 *   2. unreadable     — before anything is derived from the buffer.
 *   3. nothing typed  — before staleness, so an untouched keypad is never told
 *                       the total changed.
 *   4. typed zero     — reported as not positive rather than as nothing typed,
 *                       which is the difference CP-1C's canonical digits drop.
 *   5. stale          — BEFORE sufficiency. When the total has moved, the
 *                       truthful fact is that it moved; saying "not enough"
 *                       would send the cashier to fix the wrong thing, and
 *                       saying nothing and paying out change against a total
 *                       the cashier never saw is the defect this exists to
 *                       prevent. A total that moved DOWN is refused on exactly
 *                       the same terms as one that moved up.
 *   6. sufficiency    — CP-1C's validateCashTender, unmodified, which is also
 *                       where the server's own ceiling is applied.
 *
 * A REFUSAL IS NOT A FAILED SALE. Nothing here has been submitted, nothing has
 * been minted, and the cart is untouched: the cashier fixes the entry and
 * presses Done again.
 */
export function decideCashTenderSubmission(input: {
  entry: string;
  context: CashTenderContext;
  /** The binding captured when the buffer last changed. */
  capturedBinding: string | null;
  /** Is a completion already under way for this checkout? */
  submissionInFlight: boolean;
}): CashTenderSubmission {
  if (input.submissionInFlight) return refuseSubmission("submission_in_progress");

  const digits = cashEntryToTenderDigits(input.entry);

  if (digits === null) return refuseSubmission("malformed");

  if (input.entry === EMPTY_CASH_ENTRY) return refuseSubmission("missing");

  if (digits === EMPTY_TENDER_DIGITS) return refuseSubmission("not_positive");

  const liveBinding = captureCashTenderBinding(input.context, input.entry);

  // A live context that cannot produce a binding is a malformed context — a
  // total that is not canonical money, an empty checkout id, a broken revision
  // counter. Reported as unreadable rather than as stale: nothing moved, the
  // runtime handed over something it should not have, and no tender may pass.
  if (liveBinding === null) return refuseSubmission("malformed");

  if (isCashTenderStale(input.capturedBinding, liveBinding)) {
    return refuseSubmission("stale_total");
  }

  const validation = validateCashTender({
    amountDueFixed: input.context.amountDueFixed,
    tenderDigits: digits,
  });

  switch (validation.status) {
    case "sufficient":
      return {
        status: "submit",
        tenderedFixed: formatTenderDigits(digits),
        changeFixed: validation.change,
        binding: liveBinding,
      };
    case "insufficient":
      return refuseSubmission("insufficient", validation.shortfall);
    case "excessive":
      return refuseSubmission("excessive");
    case "not_positive":
      return refuseSubmission("not_positive");
    case "missing":
      return refuseSubmission("missing");
    case "malformed":
      return refuseSubmission("malformed");
  }
}

// ---------------------------------------------------------------------------
// What the receipt may say about the tender
// ---------------------------------------------------------------------------

/**
 * What a completed cash sale was settled with.
 *
 * PRESENTATION ONLY, AND THAT IS THE WHOLE POINT. Neither figure is part of the
 * sale: the total, subtotal, tax and tip on the receipt are the server's (or,
 * offline, the provisional record's) and nothing here touches them. Cash
 * tendered and change due describe how the money moved across the counter, and
 * the sale would be identical had the cashier been handed the exact amount.
 */
export type CashTenderOutcome = {
  tenderedFixed: string;
  changeFixed: string;
};

/**
 * Canonical non-negative money, decided by lib/money.ts rather than by a rule
 * written here — the same round trip CP-1C's requireAmountDue performs, and for
 * the same reason: "0012.50" passes a shape check and is still a second
 * spelling of one amount.
 */
function isCanonicalReceiptMoney(value: unknown): value is string {
  if (typeof value !== "string") return false;

  const parsed = moneyFromFixedString(value);

  if (parsed === null) return false;

  return formatMoney(parsed) === value && !value.startsWith("-");
}

/**
 * The two lines a cash receipt may add, or null for a receipt that must not
 * carry them.
 *
 * NULL FOR A CARD SALE, unconditionally and before anything else is read. A
 * card sale has no tender and no change, so an outcome arriving alongside one
 * is a leak from an earlier cash sale, not a figure to print.
 *
 * NULL RATHER THAN A FALLBACK for anything unreadable. A receipt is the
 * customer's copy of what happened; a "0.00" printed because a figure could not
 * be read would be a claim about money that was never checked. Printing nothing
 * is honest, and the sale total — which this never touches — is unaffected
 * either way.
 */
export function cashTenderReceiptLines(input: {
  paymentMethod: "cash" | "card";
  outcome: CashTenderOutcome | null | undefined;
  /**
   * The total THIS RECEIPT prints — the server's for an authoritative receipt,
   * the provisional record's for an offline one.
   *
   * REQUIRED, AND IT IS THE WHOLE POINT OF THE CHECK BELOW. The change was
   * computed on the device against cartSummary.total at the moment Done was
   * pressed. The authoritative total is derived independently by the server
   * from the authorized configuration. Those are two different numbers from two
   * different places, and nothing guarantees they agree — a configuration that
   * changed between the device pinning it and the sale landing is enough.
   */
  receiptTotalFixed: string;
}): CashTenderOutcome | null {
  if (input?.paymentMethod !== "cash") return null;

  const outcome = input?.outcome;

  if (outcome === null || outcome === undefined) return null;

  if (!isCanonicalReceiptMoney(outcome.tenderedFixed)) return null;
  if (!isCanonicalReceiptMoney(outcome.changeFixed)) return null;
  if (!isCanonicalReceiptMoney(input.receiptTotalFixed)) return null;

  // THE CONSISTENCY CHECK. tendered - change must equal the total this receipt
  // actually prints, exactly, in lib/money.ts arithmetic.
  //
  // WHY NOTHING IS PRINTED ON A MISMATCH, rather than a recomputed change. The
  // figure the cashier physically handed back is the one in `outcome`; a Change
  // Due recomputed here from the authoritative total would print a number that
  // never crossed the counter, and the drawer would then disagree with the
  // receipt. Printing neither line leaves the receipt's own Subtotal, Tax, Tip
  // and Total — all of them still the payload's own — as the only money on it,
  // which is the one set of figures that is certainly right.
  //
  // This cannot hide a wrong SALE: the total, and therefore what the customer
  // was charged, is the server's either way and is untouched by this module.
  const tendered = moneyFromFixedString(outcome.tenderedFixed);
  const change = moneyFromFixedString(outcome.changeFixed);
  const total = moneyFromFixedString(input.receiptTotalFixed);

  if (tendered === null || change === null || total === null) return null;

  if (compareMoney(subtractMoney(tendered, change), total) !== 0) return null;

  return { tenderedFixed: outcome.tenderedFixed, changeFixed: outcome.changeFixed };
}
