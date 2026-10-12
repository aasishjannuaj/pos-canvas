// v1.3 Cash Tender — the cash-received rules, and nothing else.
//
// PURE. No React, no DOM, no browser event, no Supabase, no node builtin, no
// side effect, no clock. Every function here is deterministic in its arguments,
// which is the only reason these rules can be proven at all: this repository
// runs Vitest under `environment: "node"` with no DOM, so anything that needed
// a rendered component could not be tested.
//
// ONE FUNCTION THROWS, AND ONLY ON A PROGRAMMER ERROR. buildCashTenderBinding
// rejects a malformed checkoutRevision rather than returning a binding, because
// a binding is the thing a confirmation is checked against and a quietly
// degraded one is worse than no binding at all. Cashier input is never an
// exception anywhere in this file — every keypad and validation refusal is a
// returned value.
//
// IT COMPUTES NO MONEY OF ITS OWN. Every figure is produced by lib/money.ts,
// whose header explains why a second money implementation is forbidden: the
// browser once computed totals in IEEE-754 doubles and printed receipts that
// disagreed with what the customer was charged. `Money` is a branded bigint
// scaled by 10^24 and rounds exactly as Postgres `round(numeric, 2)` does, so
// reusing it is what keeps `20.00 - 19.99` equal to `0.01` instead of
// `0.010000000000001776`. There is deliberately NO integer-cent arithmetic in
// this file: minor units appear only as the KEYSTROKES a cashier typed, and
// they become money through moneyFromFixedString before anything is compared.
//
// IT DECIDES NOTHING ABOUT A SALE. It reports whether a tender is sufficient
// against an amount it is handed. It does not submit, authorise, persist, open
// a drawer, or know what a sale is. The runtime checkpoint owns all of that.

import {
  compareMoney,
  formatMoney,
  moneyFromFixedString,
  subtractMoney,
} from "@/lib/money";
import type { Currency } from "@/lib/projectConfig";

// ---------------------------------------------------------------------------
// Bounds — derived from the server, not chosen here
// ---------------------------------------------------------------------------

/**
 * The largest tender this module will accept, as a fixed-decimal string.
 *
 * NOT AN ARBITRARY CAP. It is exactly the largest sale total the server will
 * commit: `c_max_money constant numeric := 9999999999.99` in
 * supabase/migrations/20260922120000_daily_sale_attribution.sql, enforced there
 * by `if ... v_total > c_max_money then raise exception 'Order amount is too
 * large'`. It is also the ceiling of every money column, all of which are
 * `numeric(12,2)` (supabase/migrations/20260729000000_capture_operational_schema.sql).
 *
 * So the cap cannot be below a valid supported sale: the two are the same
 * number. The deliberate consequence is that a sale AT the ceiling can be
 * tendered exactly but not overpaid — a 10,000,000,000.00 tender is refused as
 * `excessive` rather than silently clamped. That is accepted: the alternative
 * is accepting a figure the database cannot store.
 *
 * lib/money.ts imposes no limit of its own (its bigint representation
 * round-trips this value and larger ones exactly), which is why the bound has
 * to be stated here.
 */
export const MAX_TENDER_FIXED = "9999999999.99";

/**
 * How many minor-unit keystrokes that ceiling is.
 *
 * Derived, not picked: 9999999999.99 is 999999999999 minor units, which is 12
 * digits. The keypad therefore stops at 12 digits, and it stops by REPORTING
 * rather than by ignoring the keystroke.
 */
export const MAX_TENDER_DIGITS = 12;

/** Nothing entered yet. Distinct from "0", which is a real zero tender. */
export const EMPTY_TENDER_DIGITS = "";

const DIGITS_ONLY = /^[0-9]*$/;
const SINGLE_DIGIT = /^[0-9]$/;

/**
 * Non-negative money as the database and lib/money.ts both spell it.
 *
 * Deliberately NOT the pattern from lib/money.ts, which permits a leading "-".
 * An amount owed is never negative, and a binding is not the place to discover
 * that it was.
 */
const CANONICAL_MONEY = /^\d+\.\d{2}$/;

/**
 * Is this a digit string — actually a string, not merely something that LOOKS
 * like one after coercion?
 *
 * THE `typeof` IS THE WHOLE POINT. `RegExp.prototype.test` converts its
 * argument to a string first, so `DIGITS_ONLY.test(123)` is `true` and
 * `DIGITS_ONLY.test([])` is `true` — the empty array stringifies to "". Without
 * this check a number or an array arriving through an unsafe cast was silently
 * accepted and canonicalised into an apparently valid entry, which is exactly
 * the "silent acceptance of malformed state" this module must not do.
 */
function isDigitString(value: unknown): value is string {
  return typeof value === "string" && DIGITS_ONLY.test(value);
}

/**
 * The entry to report back on a refusal.
 *
 * A malformed STRING is still the caller's current entry, so it is echoed
 * unchanged — refusals never edit what they refuse. A non-string is not an
 * entry at all, and echoing it would put a number or an array into a field
 * typed `string`, so there is nothing honest to return but empty.
 */
function priorDigits(value: unknown): string {
  return typeof value === "string" ? value : EMPTY_TENDER_DIGITS;
}

/** Describes a rejected value for an error message, without ever throwing. */
function describeValue(value: unknown): string {
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  if (value === null) return "null";

  return `${typeof value} ${String(value)}`;
}

// ---------------------------------------------------------------------------
// Quick denominations
// ---------------------------------------------------------------------------

/**
 * The notes and coins a cashier is handed, per configured currency.
 *
 * PER CURRENCY, BECAUSE THE WORLD IS. A single `1/5/10/20/50/100` set is wrong
 * outside North America: €1 and €2 are coins and the note series runs to 200,
 * while the Bank of England's largest note in circulation is £50. Keyed on the
 * existing `Currency` union from lib/projectConfig.ts, so a new currency cannot
 * be added to the product without the compiler demanding its denominations.
 *
 * Whole units, ascending. Values only — no labels, because formatting belongs
 * to whatever renders them.
 *
 * FROZEN, NOT MERELY TYPED READONLY. `readonly` is erased at build time, so a
 * caller that sorted or reversed this array in place would silently corrupt the
 * denominations every other till in the process then renders. The freeze makes
 * that attempt throw instead.
 */
export const CASH_DENOMINATIONS: Readonly<Record<Currency, readonly number[]>> = Object.freeze({
  USD: Object.freeze([1, 5, 10, 20, 50, 100]),
  CAD: Object.freeze([1, 2, 5, 10, 20, 50, 100]),
  EUR: Object.freeze([1, 2, 5, 10, 20, 50, 100, 200]),
  GBP: Object.freeze([1, 2, 5, 10, 20, 50]),
});

export function cashDenominations(currency: Currency): readonly number[] {
  return CASH_DENOMINATIONS[currency];
}

// ---------------------------------------------------------------------------
// The keypad — cents first
// ---------------------------------------------------------------------------

/**
 * Why a keystroke was refused.
 *
 * TYPED, NEVER THROWN, AND NEVER SILENT. Ordinary cashier input is not an
 * exceptional condition, so a refusal is a value the caller can show. And a
 * refusal is always reported: a keystroke that would exceed the ceiling is not
 * dropped on the floor, because a cashier who sees nothing happen presses
 * harder.
 */
export type TenderEditRefusal =
  | "invalid_digit"
  | "max_input_reached"
  | "max_amount_exceeded";

export type TenderEditResult =
  | { ok: true; digits: string }
  | { ok: false; refusal: TenderEditRefusal; digits: string };

/** Drops leading zeros so "007" and "7" are the same seven cents. */
function normalizeDigits(digits: string): string {
  const trimmed = digits.replace(/^0+/, "");

  return trimmed;
}

const refuse = (digits: string, refusal: TenderEditRefusal): TenderEditResult => ({
  ok: false,
  refusal,
  digits,
});

/**
 * Appends one digit, cents first.
 *
 * CENTS FIRST, SO MALFORMED INPUT CANNOT BE EXPRESSED. Digits shift in from the
 * right — 8, 7, 5 is 8.75 — so there is no decimal key, which means no "1.2.3",
 * no three decimal places, and no partially typed "8." state to validate. An
 * entire class of invalid input stops existing rather than being rejected.
 *
 * A leading zero is dropped rather than refused: pressing 0 on an empty field
 * is a no-op a cashier will not notice, and treating it as an error would be
 * noise.
 */
export function appendTenderDigit(digits: string, digit: string): TenderEditResult {
  // A malformed string is echoed unchanged; a non-string becomes empty, because
  // it was never an entry. See priorDigits.
  if (!isDigitString(digits)) return refuse(priorDigits(digits), "invalid_digit");
  if (typeof digit !== "string" || !SINGLE_DIGIT.test(digit)) {
    return refuse(digits, "invalid_digit");
  }

  const next = normalizeDigits(digits + digit);

  if (next.length > MAX_TENDER_DIGITS) return refuse(digits, "max_input_reached");

  return { ok: true, digits: next };
}

/**
 * The `00` key: two minor-unit zeros at once.
 *
 * Present because round cash is the common case — $20.00 is 20 then 00 then 0,
 * and a till that makes the usual amount the longest to type is a till that
 * slows a queue down.
 */
export function appendTenderDoubleZero(digits: string): TenderEditResult {
  if (!isDigitString(digits)) return refuse(priorDigits(digits), "invalid_digit");

  // No-op on an empty field: "00" is still nothing entered, and growing the
  // string with zeros that normalize away would only burn the input budget.
  if (digits === EMPTY_TENDER_DIGITS) return { ok: true, digits: EMPTY_TENDER_DIGITS };

  const next = normalizeDigits(`${digits}00`);

  if (next.length > MAX_TENDER_DIGITS) return refuse(digits, "max_input_reached");

  return { ok: true, digits: next };
}

/** Removes the last minor-unit digit entered. Empty stays empty. */
export function backspaceTenderDigit(digits: string): TenderEditResult {
  if (!isDigitString(digits)) return refuse(priorDigits(digits), "invalid_digit");

  return { ok: true, digits: normalizeDigits(digits.slice(0, -1)) };
}

/** Back to nothing entered. */
export function clearTenderDigits(): TenderEditResult {
  return { ok: true, digits: EMPTY_TENDER_DIGITS };
}

/**
 * Adds a whole-unit denomination to whatever is already there.
 *
 * ADDITIVE, NOT REPLACEMENT. A cashier handed a $20 and a $5 presses both;
 * replacement would force them to work out $25 in their head, and the $20 note
 * they are holding is not a correction of the $5. `clearTenderDigits` is the
 * way back, which is cheaper to reach for than mental arithmetic is to avoid.
 *
 * REFUSES RATHER THAN CLAMPS when the sum would pass the ceiling. Clamping
 * would quietly record a different amount of money than the cashier added, and
 * wrapping is not arithmetic anyone expects from a till.
 *
 * GENERIC ON PURPOSE, AND THAT PUTS AN OBLIGATION ON THE CALLER. It adds any
 * positive whole unit; it does not consult CASH_DENOMINATIONS and takes no
 * Currency. Membership is therefore NOT enforced here, so a future quick-tender
 * UI must take its buttons exclusively from `cashDenominations(currency)` —
 * that function is the only approved source of which notes exist for a
 * currency, and nothing in this module will catch a value that did not come
 * from it.
 */
export function applyTenderDenomination(digits: string, wholeUnits: number): TenderEditResult {
  if (!isDigitString(digits)) return refuse(priorDigits(digits), "invalid_digit");

  if (!Number.isSafeInteger(wholeUnits) || wholeUnits <= 0) {
    return refuse(digits, "invalid_digit");
  }

  const current = digits === EMPTY_TENDER_DIGITS ? 0n : BigInt(digits);
  const added = BigInt(wholeUnits) * 100n;
  const next = (current + added).toString();

  if (next.length > MAX_TENDER_DIGITS) return refuse(digits, "max_amount_exceeded");

  return { ok: true, digits: next };
}

/**
 * The keypad's digits as a fixed two-decimal string.
 *
 * Empty renders as "0.00" because that is what a till shows before anyone has
 * typed — but emptiness is NOT zero to `validateCashTender`, which reports
 * `missing` rather than `not_positive`. The display and the decision are
 * deliberately allowed to differ here; conflating them is how a blank field
 * becomes an accepted zero tender.
 */
export function formatTenderDigits(digits: string): string {
  if (!isDigitString(digits)) return "0.00";

  const padded = digits.padStart(3, "0");
  const whole = padded.slice(0, -2).replace(/^0+(?=\d)/, "");
  const minor = padded.slice(-2);

  return `${whole}.${minor}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * What the cashier's entry means against the amount owed.
 *
 * `change` appears on exactly one member, so a caller cannot read a change
 * figure out of an unsuccessful result — the type refuses it rather than a
 * comment asking nicely.
 */
export type CashTenderValidation =
  /** Nothing entered. */
  | { status: "missing" }
  /** The amount due, or the entry, is not a figure this module will read. */
  | { status: "malformed" }
  /** Entered, but zero. Negative is unrepresentable from keystrokes. */
  | { status: "not_positive" }
  | { status: "insufficient"; shortfall: string }
  /** Above the largest sale the server will commit. See MAX_TENDER_FIXED. */
  | { status: "excessive" }
  | { status: "sufficient"; change: string };

/**
 * Is this tender enough, and what is the change?
 *
 * EVERY FIGURE COMES FROM lib/money.ts. The keystrokes become a fixed-decimal
 * string, the string becomes `Money`, and the comparison and subtraction are
 * exact bigint operations. No `Number`, no `parseFloat`, no `toFixed` touches a
 * financial value anywhere in this path.
 *
 * THE AMOUNT DUE IS AN INPUT, NEVER A COMPUTATION. This module does not know
 * what a cart is. A malformed amount due is reported rather than defaulted,
 * because defaulting it to zero would make every tender sufficient.
 */
export function validateCashTender(input: {
  /** The authoritative amount owed, as a fixed two-decimal string. */
  amountDueFixed: string;
  /** The keypad's minor-unit digits. */
  tenderDigits: string;
}): CashTenderValidation {
  // `typeof` first: moneyFromFixedString would coerce a number through its own
  // RegExp test exactly as the digit guards did.
  if (typeof input.amountDueFixed !== "string") return { status: "malformed" };

  const due = moneyFromFixedString(input.amountDueFixed);

  if (due === null) return { status: "malformed" };

  const zero = moneyFromFixedString("0.00");

  if (zero === null) return { status: "malformed" };

  // A negative amount owed is not a sale. Reported rather than tolerated,
  // because every tender is "sufficient" against a negative figure and the
  // change due would exceed what was handed over.
  //
  // An amount owed ABOVE the ceiling needs no special case: no acceptable
  // tender can reach it, so it falls out as `insufficient` and is never
  // accepted. That is the safe direction, so it is left alone.
  if (compareMoney(due, zero) < 0) return { status: "malformed" };

  if (!isDigitString(input.tenderDigits)) return { status: "malformed" };

  if (input.tenderDigits === EMPTY_TENDER_DIGITS) return { status: "missing" };

  const received = moneyFromFixedString(formatTenderDigits(input.tenderDigits));

  if (received === null) return { status: "malformed" };

  if (compareMoney(received, zero) <= 0) return { status: "not_positive" };

  const max = moneyFromFixedString(MAX_TENDER_FIXED);

  if (max === null) return { status: "malformed" };

  if (compareMoney(received, max) > 0) return { status: "excessive" };

  if (compareMoney(received, due) < 0) {
    return { status: "insufficient", shortfall: formatMoney(subtractMoney(due, received)) };
  }

  return { status: "sufficient", change: formatMoney(subtractMoney(received, due)) };
}

// ---------------------------------------------------------------------------
// Confirmation binding
// ---------------------------------------------------------------------------

/**
 * Everything a tender confirmation is tied to.
 *
 * WHY THE SALE FINGERPRINT IS NOT USED AS THE CART IDENTITY. `createSaleFingerprint`
 * in lib/saleRequest.ts covers items, quantities, modifier selections, the
 * payment method and the tip, and its own doc states that "Prices and item names
 * are excluded because the server derives them." A confirmation bound to it
 * alone would survive a price or tax change. So `cartIdentity` is supplied by
 * the caller — which may compose the fingerprint with anything else it needs —
 * and `amountDueFixed` is bound SEPARATELY to cover the pricing inputs the
 * fingerprint leaves out. Nothing here imports or alters that fingerprint, and
 * the server contract is untouched.
 */
export type CashTenderBindingInput = {
  /** Identifies one open checkout. Changes on close/reopen. */
  checkoutSessionId: string;
  /** Cart contents, as the caller chooses to identify them. */
  cartIdentity: string;
  /** The exact amount owed when the tender was confirmed. */
  amountDueFixed: string;
  /** The keystrokes that were confirmed. */
  tenderDigits: string;
  /**
   * A caller-owned counter that advances on every checkout mutation.
   *
   * REQUIRED, AND THIS MODULE NEVER PRODUCES ONE. It was optional in CP-1C,
   * and that was the HIGH finding: a pure function cannot know that a cart went
   * A -> B -> A, because all four fields above return to their earlier values
   * and the binding returned to its earlier value with them. Omitting the
   * revision therefore made a stale confirmation compare EQUAL to a live one.
   *
   * Documenting that hole was not the same as closing it. On a money path the
   * default has to be fail-closed, so an omitted revision is now refused rather
   * than encoded as "no revision": a caller that cannot say which checkout
   * generation it is on cannot obtain a binding at all.
   *
   * MUST BE A NON-NEGATIVE SAFE INTEGER. Past 2^53 - 1 a counter stops being
   * able to represent its own increment, so a revision that large is a broken
   * counter, not a long shift.
   */
  checkoutRevision: number;
};

/**
 * The checkout revision, or a thrown error if it is not one.
 *
 * WHY `=== undefined` IS STILL CHECKED EXPLICITLY, even though the field is now
 * required. `required` is a compile-time claim that erases at build time, so an
 * untyped caller — or `JSON.parse` output, or a stale build — can still arrive
 * with the property missing. Nullish coalescing is what made that
 * indistinguishable from a real value in CP-1C: `JSON.stringify` encodes NaN
 * and Infinity as `null` (JSON has no literal for either), so a caller whose
 * counter became NaN produced a binding byte-identical to one that supplied no
 * revision, and every NaN revision collided with every other.
 *
 * FAIL CLOSED, NOT FAIL QUIET. A malformed revision is a programmer or runtime
 * defect, not something a cashier typed, and no string is safe to return:
 * anything returned here is a binding that something else will be compared
 * against.
 */
function requireCheckoutRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      "cashTender: checkoutRevision is required and must be a non-negative safe integer; " +
        `received ${describeValue(value)}`,
    );
  }

  return value;
}

/**
 * A required identifier, or a thrown error.
 *
 * `typeof` FIRST, AND IT IS NOT PEDANTRY. Every required field of this type is
 * declared `string`, and every one of those declarations erases at build time.
 * `JSON.stringify` maps `undefined`, `NaN` and both infinities to `null` inside
 * an array, so in CP-1C five different malformed values for the SAME field all
 * produced one identical binding. Rejecting the non-string is what stops five
 * different mistakes from looking like one valid confirmation.
 *
 * EMPTY AND PADDED ARE REFUSED TOO. "" is not an identity, "   " is not an
 * identity, and " s1 " is a different string from "s1" while naming the same
 * thing — a binding whose equality depends on invisible characters is not an
 * identity check, it is a formatting check.
 */
function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`cashTender: ${field} must be a string; received ${describeValue(value)}`);
  }

  if (value.length === 0) {
    throw new Error(`cashTender: ${field} must not be empty`);
  }

  if (value.trim() !== value) {
    throw new Error(
      `cashTender: ${field} must not have leading or trailing whitespace; ` +
        `received ${describeValue(value)}`,
    );
  }

  return value;
}

/**
 * The amount owed, or a thrown error.
 *
 * BOUND SEPARATELY FROM THE CART, AND VALIDATED HERE RATHER THAN TRUSTED.
 * CP-1C bound whatever string it was handed, so "12.5", "12.500", "not money"
 * and "" were all acceptable totals. Two spellings of one amount would then
 * produce two different bindings, and a malformed one would produce a
 * confirmation over a total nobody could compute.
 *
 * It goes through moneyFromFixedString rather than a second parser, because
 * lib/money.ts is the money contract and a module that re-implemented it would
 * be the exact mistake that file exists to prevent. The pattern is checked
 * first only because money.ts accepts a leading "-" and an amount owed never
 * is negative.
 */
function requireAmountDue(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_MONEY.test(value)) {
    throw new Error(
      "cashTender: amountDueFixed must be a non-negative fixed two-decimal string " +
        `such as "12.50"; received ${describeValue(value)}`,
    );
  }

  const parsed = moneyFromFixedString(value);

  if (parsed === null) {
    throw new Error(`cashTender: amountDueFixed is not readable as money; received ${value}`);
  }

  // CANONICAL, DECIDED BY lib/money.ts RATHER THAN BY A RULE WRITTEN HERE.
  //
  // The pattern above is a shape check, and a shape check is not enough:
  // "0012.50" matches `\d+\.\d{2}` perfectly well, so the previous version
  // bound it as a distinct total from "12.50". Two spellings of one amount then
  // produce two different confirmations, which is the same ambiguity the
  // tenderDigits canonical rule exists to prevent.
  //
  // The test is a ROUND TRIP through the project's own parser and formatter:
  // whatever formatMoney emits for this value IS the canonical spelling, by
  // definition. That is why this introduces no second money parser and no new
  // monetary convention — it asks lib/money.ts the question instead of
  // answering it independently, and it stays exact because the comparison is
  // between two strings, never between two numbers.
  const canonical = formatMoney(parsed);

  if (canonical !== value) {
    throw new Error(
      "cashTender: amountDueFixed must be the canonical fixed-decimal form " +
        `${canonical}; received ${value}`,
    );
  }

  return value;
}

/**
 * The confirmed keystrokes, or a thrown error.
 *
 * CANONICAL, SO ONE TENDER HAS EXACTLY ONE BINDING. "2000", "02000" and
 * "0002000" are the same twenty dollars, and CP-1C turned them into three
 * different confirmations. The keypad never produces a leading zero — every
 * mutator in this file normalises — so a non-canonical entry did not come from
 * the keypad and must not be bound.
 *
 * EMPTY IS ALLOWED. A cleared field is a real, ordinary checkout state, and the
 * runtime recomputes a live binding from whatever is on screen; throwing there
 * would turn "the cashier cleared the amount" into an exception. Whether a
 * tender is sufficient is validateCashTender's question, not this one's.
 */
function requireTenderDigits(value: unknown): string {
  if (!isDigitString(value)) {
    throw new Error(
      `cashTender: tenderDigits must be a digit string; received ${describeValue(value)}`,
    );
  }

  if (normalizeDigits(value) !== value) {
    throw new Error(
      `cashTender: tenderDigits must be canonical, without leading zeros; received ${value}`,
    );
  }

  // THE SAME CEILING THE KEYPAD ENFORCES, APPLIED AT THE BINDING TOO.
  //
  // Because the entry is already canonical, its length IS its significant digit
  // count, so this is exactly the bound appendTenderDigit applies — not a
  // second, looser rule. Without it a 13-digit entry was canonical and so bound
  // happily, even though no keypad could produce it and validateCashTender
  // would call it `excessive`. A binding must not be obtainable for a tender
  // that can never be sufficient.
  //
  // MAX_TENDER_DIGITS is unchanged; this only stops the binding path from
  // disagreeing with the editing path about what it means.
  if (value.length > MAX_TENDER_DIGITS) {
    throw new Error(
      `cashTender: tenderDigits must be at most ${MAX_TENDER_DIGITS} digits ` +
        `(${MAX_TENDER_FIXED}); received ${value.length} digits`,
    );
  }

  return value;
}

/**
 * A deterministic string identity for a confirmation.
 *
 * JSON rather than a delimiter join, so a value containing the delimiter cannot
 * forge a different binding's identity. Field order is fixed by the array, so
 * identical inputs always produce an identical string.
 *
 * EVERY FIELD IS VALIDATED BEFORE SERIALIZATION, AND A VIOLATION THROWS. The
 * builder returns a binding or it returns nothing: there is no malformed input
 * for which it hands back a string, because a string is precisely the thing
 * another binding gets compared against.
 *
 * VERSION v2. The tag changed with this correction, and deliberately: a v1
 * binding encoded an absent revision as `null`, which is no longer a value this
 * builder can produce. Bumping it means a confirmation captured under the old,
 * reusable contract can never compare equal to one captured under this one.
 */
export function buildCashTenderBinding(input: CashTenderBindingInput): string {
  return JSON.stringify([
    "posc.cashtender.v2",
    requireIdentifier(input?.checkoutSessionId, "checkoutSessionId"),
    requireIdentifier(input?.cartIdentity, "cartIdentity"),
    requireAmountDue(input?.amountDueFixed),
    requireTenderDigits(input?.tenderDigits),
    requireCheckoutRevision(input?.checkoutRevision),
  ]);
}

/**
 * Do two bindings describe the same confirmed configuration?
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. Equality here means every bound field
 * matched, which catches a different cart with an identical total, a changed
 * total under an identical cart, an edited tender, a switched payment method
 * (through `cartIdentity`), and a reopened checkout (through
 * `checkoutSessionId`).
 *
 * A -> B -> A IS NOW DETECTABLE, BUT ONLY BECAUSE THE RUNTIME SAYS SO. The
 * revision is required and bound, so a cart returned to a previously confirmed
 * state carries a LATER revision and produces a different binding. That holds
 * only while the runtime actually advances the counter on every mutation: this
 * function still cannot detect a change it was never told about, and no pure
 * test here proves the runtime tells it. Consuming a confirmation before the
 * sale dispatch, and destroying it on mutation, remain the runtime's alone.
 */
export function cashTenderBindingsMatch(a: string, b: string): boolean {
  return a === b;
}
