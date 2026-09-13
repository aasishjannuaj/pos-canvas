// Feature 28B — ONE exact money implementation, matching the server's contract.
//
// WHY THIS EXISTS. complete_sale* computes every figure in PostgreSQL `numeric`:
// exact decimal arithmetic, with round() breaking a half-cent tie AWAY FROM
// ZERO. The browser was computing the same figures in IEEE-754 doubles, and
// worse, rounding them on two different paths — the tax line was
// `taxAmount.toFixed(2)` while the total was `(subtotal + unroundedTax)
// .toFixed(2)`. So a slip could show a correct total above a tax line that did
// not add up to it. Measured over every subtotal from $0.01 to $10,000:
//
//   rate                       tax line wrong   total wrong
//   5%                                  9,950        23,998
//   7.5%                               16,681        12,001
//   8.25%                                 446         1,177
//   10%                                19,904        46,958
//   13%                                 2,615         4,451
//   6.35% (the product default)           191           242
//   20%                                     0             0
//
// Concretely: 10% tax on $0.15 showed $0.17 as $0.16; 5% on $2.30 showed the
// tax as $0.11 under a $2.42 total; the default 6.35% on $10.00 showed $10.63
// and charged $10.64.
//
// A cashier saw one total, the customer was charged another, and — worse — an
// OFFLINE receipt printed that estimate onto paper before the server ever
// priced the sale. lib/modifiers.ts has documented this hazard since Feature
// 18.1 and refused to add a second money implementation because of it. This
// module is the first implementation that is allowed to compute money, because
// it is the one that agrees with the server.
//
// THE SERVER REMAINS THE AUTHORITY. Nothing here decides what a customer pays.
// complete_sale* re-derives every figure from the authorized configuration and
// its answer is what is stored and printed on an authoritative receipt. What
// this module guarantees is that the number shown BEFORE that answer arrives —
// the cart, the Charge button, an offline receipt — is the same number.
//
// HOW IT WORKS. Values are held as BigInt integers scaled by 10^24, so every
// add, subtract and multiply is exact. Division and the final rescale round
// half away from zero, exactly as `round(numeric, 2)` does. A JavaScript number
// enters through String(n), which is its shortest round-tripping DECIMAL form —
// the same text Postgres parses out of the config JSON — so 6.49 is the decimal
// 6.49 here and there, not the double nearest to it.
//
// PURE. No React, no Supabase, no node builtins.

import type { TaxSettings } from "@/lib/projectConfig";

/** Working precision. Generous enough that no config value is truncated. */
const SCALE = 24n;
const SCALE_FACTOR = 10n ** SCALE;
const CENT_FACTOR = 10n ** (SCALE - 2n);

/**
 * A decimal value, scaled by 10^24.
 *
 * Deliberately a branded type. A bare bigint could be added to a raw count or a
 * quantity by accident, and the whole point of this module is that money cannot
 * be arithmetic'd by hand somewhere else.
 */
export type Money = bigint & { readonly __money: unique symbol };

const money = (raw: bigint): Money => raw as Money;

export const ZERO_MONEY: Money = money(0n);

/** Two fixed decimals, the only shape money is ever rendered in. */
const FIXED_DECIMAL_PATTERN = /^-?\d+\.\d{2}$/;

/**
 * Integer division that rounds a tie AWAY FROM ZERO.
 *
 * This is the whole contract. PostgreSQL's round(numeric, n) rounds half away
 * from zero; JavaScript's Math.round rounds half UP (so -0.5 becomes -0) and
 * toFixed rounds whichever way the underlying binary value happens to fall.
 * Every rescale in this module goes through here so there is exactly one
 * rounding rule in the codebase.
 */
function divideRoundHalfAway(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const quotient = magnitude / denominator;
  const remainder = magnitude % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;

  return negative ? -rounded : rounded;
}

/**
 * Parses decimal TEXT. Accepts the exponent form because String(1e-7) produces
 * it, and a menu price may legitimately be that small.
 */
function parseDecimalText(text: string): Money | null {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());

  if (match === null) return null;

  const [, sign, integerDigits, fractionDigits = "", exponentText = "0"] = match;
  const exponent = Number(exponentText);

  // A value this extreme is not a price, it is a bug or an attack. Refused
  // rather than clamped: 10^1000 as a BigInt is a denial of service on its own.
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return null;

  const digits = BigInt(integerDigits + fractionDigits);
  const shift = SCALE + BigInt(exponent) - BigInt(fractionDigits.length);
  const scaled =
    shift >= 0n
      ? digits * 10n ** shift
      : divideRoundHalfAway(digits, 10n ** -shift);

  return money(sign === "-" ? -scaled : scaled);
}

/**
 * A JavaScript number, read as the DECIMAL it prints as.
 *
 * String(n) is the shortest text that round-trips to the same double, which is
 * also the text that reached PostgreSQL inside the configuration JSON. Reading
 * 6.49 as the decimal 6.49 rather than as 6.4900000000000002131628... is what
 * makes this module agree with the server rather than with IEEE-754.
 *
 * Null for a non-finite value, matching the server, which refuses NaN and the
 * infinities outright rather than coercing them.
 */
export function moneyFromNumber(value: number): Money | null {
  if (!Number.isFinite(value)) return null;

  return parseDecimalText(String(value));
}

/** A fixed two-decimal string, as the database and this module both emit. */
export function moneyFromFixedString(value: string): Money | null {
  if (!FIXED_DECIMAL_PATTERN.test(value)) return null;

  return parseDecimalText(value);
}

export function addMoney(a: Money, b: Money): Money {
  return money(a + b);
}

export function subtractMoney(a: Money, b: Money): Money {
  return money(a - b);
}

export function multiplyMoney(a: Money, b: Money): Money {
  return money(divideRoundHalfAway(a * b, SCALE_FACTOR));
}

/**
 * Multiplies by a whole count. Exact — a quantity has no fractional part, so
 * nothing is rounded here and a line total's only rounding point is the
 * explicit roundToCents its caller applies.
 */
export function multiplyByCount(a: Money, count: number): Money | null {
  if (!Number.isSafeInteger(count)) return null;

  return money(a * BigInt(count));
}

/**
 * Division, rounded to the working scale.
 *
 * Only the tax-inclusive rule needs it: `subtotal - subtotal / (1 + rate/100)`.
 * PostgreSQL computes that quotient at roughly sixteen significant digits and
 * rounds it before subtracting; carrying twenty-four here and rounding the same
 * way cannot land on the other side of a half-cent boundary, because a
 * difference that falls EXACTLY on one has a terminating quotient that both
 * scales represent exactly.
 */
export function divideMoney(a: Money, b: Money): Money | null {
  if (b <= 0n) return null;

  return money(divideRoundHalfAway(a * SCALE_FACTOR, b));
}

/** round(value, 2), half away from zero. */
export function roundToCents(value: Money): Money {
  return money(divideRoundHalfAway(value, CENT_FACTOR) * CENT_FACTOR);
}

export function isNegativeMoney(value: Money): boolean {
  return value < 0n;
}

export function compareMoney(a: Money, b: Money): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * The rendered form: always a sign, at least one integer digit, exactly two
 * decimals. Rounds first, so every caller gets the same two decimals whatever
 * working precision reached it.
 */
export function formatMoney(value: Money): string {
  const cents = divideRoundHalfAway(value, CENT_FACTOR);
  const negative = cents < 0n;
  const magnitude = negative ? -cents : cents;
  const whole = magnitude / 100n;
  const fraction = magnitude % 100n;

  return `${negative ? "-" : ""}${whole}.${fraction.toString().padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// The POS money rules, in the server's order
// ---------------------------------------------------------------------------

/**
 * The tax rate the server will use.
 *
 * Mirrors complete_sale_v4 exactly: a special or unparseable rate becomes 0,
 * a negative rate becomes 0, and anything above 100 is CLAMPED to 100 rather
 * than rejected. The old client code dropped a >100 rate to 0 instead, which
 * disagreed with the server in the one direction that undercharges.
 */
export function normalizeTaxRate(rate: number): Money {
  const parsed = moneyFromNumber(rate);

  if (parsed === null) return ZERO_MONEY;
  if (parsed < 0n) return ZERO_MONEY;

  const hundred = parseDecimalText("100") as Money;

  return parsed > hundred ? hundred : parsed;
}

export type ExactLineMoney = {
  /** base + adjustments, rounded to cents — what the server stores. */
  unitPrice: string;
  /** round(unitPrice × quantity, 2) — what the server stores. */
  lineTotal: string;
};

/**
 * One sold line, priced the way the server prices it.
 *
 * THE ORDER OF THE TWO ROUNDING POINTS IS THE CONTRACT. complete_sale* rounds
 * the combined unit price to cents FIRST and multiplies the rounded figure by
 * the quantity SECOND. Multiplying first and rounding once — which is what
 * `price * quantity` did — is a different number whenever the combined unit
 * price has a third decimal, and a menu price or a modifier adjustment is
 * allowed to have one.
 */
export function exactLineMoney(input: {
  unitPrice: number;
  quantity: number;
}): ExactLineMoney | null {
  const parsed = moneyFromNumber(input.unitPrice);

  if (parsed === null) return null;

  const unitPrice = roundToCents(parsed);
  const multiplied = multiplyByCount(unitPrice, input.quantity);

  if (multiplied === null) return null;

  return {
    unitPrice: formatMoney(unitPrice),
    lineTotal: formatMoney(roundToCents(multiplied)),
  };
}

export type ExactOrderTotals = {
  subtotal: string;
  taxAmount: string;
  tipAmount: string;
  total: string;
};

/**
 * The order-level figures, in the server's sequence.
 *
 * Sum the STORED line totals, round; apply the tax rule; add the tip; round.
 * Summing unrounded line values instead — which is what the old code did — can
 * differ from the sum of what is actually persisted.
 *
 * A malformed line total is treated as zero rather than refused: this function
 * feeds a display, and its caller has already been given a line it could not
 * price. The server refuses such a sale outright, which is the check that
 * matters.
 */
export function exactOrderTotals(input: {
  lineTotals: readonly string[];
  tax: TaxSettings;
  tipAmount: number;
}): ExactOrderTotals {
  let summed = ZERO_MONEY;

  for (const lineTotal of input.lineTotals) {
    summed = addMoney(summed, moneyFromFixedString(lineTotal) ?? ZERO_MONEY);
  }

  const subtotal = roundToCents(summed);
  const rate = normalizeTaxRate(input.tax.rate);
  const hundred = parseDecimalText("100") as Money;

  let taxAmount = ZERO_MONEY;
  let totalBeforeTip = subtotal;

  if (input.tax.enabled) {
    if (input.tax.pricesIncludeTax) {
      // tax = subtotal - subtotal / (1 + rate/100); the price already contains it.
      const divisor = addMoney(hundred, rate);
      const quotient = divideMoney(multiplyMoney(subtotal, hundred), divisor);

      taxAmount = roundToCents(
        quotient === null ? ZERO_MONEY : subtractMoney(subtotal, quotient)
      );
      totalBeforeTip = subtotal;
    } else {
      // tax = subtotal * rate / 100. Multiply BEFORE dividing, as the server
      // does: `subtotal * (rate/100)` rounds the rate first and is a different
      // number.
      const divided = divideMoney(multiplyMoney(subtotal, rate), hundred);

      taxAmount = roundToCents(divided ?? ZERO_MONEY);
      totalBeforeTip = addMoney(subtotal, taxAmount);
    }
  }

  // The server floors a negative tax at zero rather than passing it through.
  if (isNegativeMoney(taxAmount)) {
    taxAmount = ZERO_MONEY;
  }

  const parsedTip = moneyFromNumber(input.tipAmount);
  const tip =
    parsedTip === null || isNegativeMoney(parsedTip)
      ? ZERO_MONEY
      : roundToCents(parsedTip);

  return {
    subtotal: formatMoney(subtotal),
    taxAmount: formatMoney(taxAmount),
    tipAmount: formatMoney(tip),
    total: formatMoney(roundToCents(addMoney(totalBeforeTip, tip))),
  };
}

/**
 * A number the database already rounded, as its fixed-decimal string.
 *
 * NOT A RECOMPUTATION. PostgREST serialises numeric(12,2) as a JSON number, so
 * an order loaded through the table API arrives as a double that has already
 * lost its decimal identity. Every such value has at most two decimals and is
 * far inside the exactly-representable range, so String(n) round-trips it
 * without loss — but the conversion is still funnelled through this module, and
 * still refused when the value does not look like stored money, so no caller
 * can quietly invent a third decimal.
 */
export function storedMoneyToFixedString(value: number): string | null {
  const parsed = moneyFromNumber(value);

  if (parsed === null) return null;
  // Anything with a third decimal did not come out of a numeric(12,2) column.
  if (roundToCents(parsed) !== parsed) return null;

  return formatMoney(parsed);
}
