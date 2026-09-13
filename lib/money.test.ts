// Feature 28B — the exact client money contract.
//
// THE ORACLE BELOW IS THE POINT. Asserting lib/money.ts against itself would
// prove nothing, so every arithmetic claim here is checked against
// `serverTotals`, an INDEPENDENT model of complete_sale_v4's rules written
// straight from the SQL in exact BigInt rationals: round half away from zero,
// round the unit price before multiplying, sum the ROUNDED line totals, and
// multiply before dividing by 100. If lib/money.ts and that model ever disagree
// on a value, one of them is wrong and this fails.

import { describe, expect, it } from "vitest";

import {
  exactLineMoney,
  exactOrderTotals,
  formatMoney,
  moneyFromFixedString,
  moneyFromNumber,
  normalizeTaxRate,
  roundToCents,
  storedMoneyToFixedString,
} from "@/lib/money";
import type { TaxSettings } from "@/lib/projectConfig";

// ---------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------

/** round(numerator / denominator) with a tie going AWAY from zero. */
function divHalfAway(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const quotient = magnitude / denominator;
  const remainder = magnitude % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;

  return negative ? -rounded : rounded;
}

/** A decimal number as an exact fraction, read from the text it prints as. */
function asFraction(value: number): { num: bigint; den: bigint } {
  const text = String(value);
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);

  if (match === null) throw new Error(`oracle cannot read ${text}`);

  const [, sign, whole, fraction = "", exponent = "0"] = match;
  let num = BigInt(whole + fraction);
  let den = 10n ** BigInt(fraction.length);
  const e = Number(exponent);

  if (e >= 0) num *= 10n ** BigInt(e);
  else den *= 10n ** BigInt(-e);

  return { num: sign === "-" ? -num : num, den };
}

function centsFromCentsString(text: string): bigint {
  const [whole, fraction] = text.replace("-", "").split(".");
  const magnitude = BigInt(whole) * 100n + BigInt(fraction);

  return text.startsWith("-") ? -magnitude : magnitude;
}

function toFixedFromCents(cents: bigint): string {
  const negative = cents < 0n;
  const magnitude = negative ? -cents : cents;

  return `${negative ? "-" : ""}${magnitude / 100n}.${(magnitude % 100n)
    .toString()
    .padStart(2, "0")}`;
}

/**
 * complete_sale_v4's sections 8, 9 and 11, in exact rationals.
 *
 * Written from the SQL, not from lib/money.ts. `lines` are the priced lines as
 * the server sees them: an unrounded combined unit price and a whole quantity.
 */
function serverTotals(input: {
  lines: readonly { unitPrice: number; quantity: number }[];
  tax: TaxSettings;
  tipAmount: number;
}): { subtotal: string; taxAmount: string; tipAmount: string; total: string } {
  let subtotalCents = 0n;

  for (const line of input.lines) {
    // v_unit_price := round(base + mods, 2)
    const unit = asFraction(line.unitPrice);
    const unitCents = divHalfAway(unit.num * 100n, unit.den);
    // v_line_total := round(unit_price * quantity, 2) — exact for whole cents.
    subtotalCents += unitCents * BigInt(line.quantity);
  }

  // Clamp exactly as the SQL does.
  let rate = asFraction(Number.isFinite(input.tax.rate) ? input.tax.rate : 0);
  if (rate.num < 0n) rate = { num: 0n, den: 1n };
  if (rate.num * 1n > 100n * rate.den) rate = { num: 100n, den: 1n };

  let taxCents = 0n;
  let beforeTipCents = subtotalCents;

  if (input.tax.enabled) {
    if (input.tax.pricesIncludeTax) {
      // tax = S * r / (100 + r)
      taxCents = divHalfAway(
        subtotalCents * rate.num,
        100n * rate.den + rate.num
      );
      beforeTipCents = subtotalCents;
    } else {
      // tax = S * r / 100
      taxCents = divHalfAway(subtotalCents * rate.num, 100n * rate.den);
      beforeTipCents = subtotalCents + taxCents;
    }
  }

  if (taxCents < 0n) taxCents = 0n;

  const rawTip = asFraction(
    Number.isFinite(input.tipAmount) && input.tipAmount > 0 ? input.tipAmount : 0
  );
  const tipCents = divHalfAway(rawTip.num * 100n, rawTip.den);

  return {
    subtotal: toFixedFromCents(subtotalCents),
    taxAmount: toFixedFromCents(taxCents),
    tipAmount: toFixedFromCents(tipCents),
    total: toFixedFromCents(beforeTipCents + tipCents),
  };
}

function makeTax(overrides: Partial<TaxSettings> = {}): TaxSettings {
  return {
    enabled: true,
    rate: 10,
    pricesIncludeTax: false,
    showTaxSeparately: true,
    ...overrides,
  };
}

/** Runs both implementations over the same lines and asserts they agree. */
function agree(input: {
  lines: readonly { unitPrice: number; quantity: number }[];
  tax: TaxSettings;
  tipAmount?: number;
}) {
  const tipAmount = input.tipAmount ?? 0;
  const lineTotals = input.lines.map((line) => {
    const priced = exactLineMoney(line);

    expect(priced).not.toBeNull();

    return priced!.lineTotal;
  });

  const mine = exactOrderTotals({ lineTotals, tax: input.tax, tipAmount });
  const theirs = serverTotals({ lines: input.lines, tax: input.tax, tipAmount });

  expect(mine).toEqual(theirs);

  return mine;
}

// ---------------------------------------------------------------------------
// The rounding rule itself
// ---------------------------------------------------------------------------

describe("rounding is half AWAY from zero, as PostgreSQL numeric is", () => {
  it("rounds a positive tie up", () => {
    expect(formatMoney(roundToCents(moneyFromNumber(1.005)!))).toBe("1.01");
    expect(formatMoney(roundToCents(moneyFromNumber(2.675)!))).toBe("2.68");
    expect(formatMoney(roundToCents(moneyFromNumber(0.005)!))).toBe("0.01");
  });

  it("rounds a negative tie DOWN, not toward zero and not toward +inf", () => {
    // Math.round(-0.5) is -0 and toFixed is unpredictable here; numeric is not.
    expect(formatMoney(roundToCents(moneyFromNumber(-1.005)!))).toBe("-1.01");
    expect(formatMoney(roundToCents(moneyFromNumber(-0.005)!))).toBe("-0.01");
  });

  it("NEGATIVE CONTROL: the float shortcuts get these wrong", () => {
    // The exact reason this module exists. Both of these are what the codebase
    // used before, and both disagree with the charge.
    expect((1.005).toFixed(2)).toBe("1.00");
    expect(Math.round(1.005 * 100) / 100).toBe(1);
    expect(formatMoney(roundToCents(moneyFromNumber(1.005)!))).not.toBe(
      (1.005).toFixed(2)
    );
  });

  it("reads a number as the decimal it prints as, not as its binary value", () => {
    // 6.49 is stored as 6.4900000000000002131628... The server parses "6.49"
    // out of the config JSON and gets exactly 6.49, and so must this.
    expect(formatMoney(moneyFromNumber(6.49)!)).toBe("6.49");
    expect(formatMoney(moneyFromNumber(0.1)!)).toBe("0.10");
    expect(formatMoney(moneyFromNumber(1e-7)!)).toBe("0.00");
  });

  it("refuses a value that is not a number rather than coercing it to zero", () => {
    expect(moneyFromNumber(Number.NaN)).toBeNull();
    expect(moneyFromNumber(Infinity)).toBeNull();
    expect(moneyFromNumber(-Infinity)).toBeNull();
    expect(moneyFromFixedString("12.3")).toBeNull();
    expect(moneyFromFixedString("12.345")).toBeNull();
    expect(moneyFromFixedString("abc")).toBeNull();
    expect(moneyFromFixedString("12.34")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The edge cases the feature was specified against
// ---------------------------------------------------------------------------

describe("the cart shows the amount that will actually be charged", () => {
  // The four cases Feature 28B was specified against, plus two where the old
  // code got the TOTAL wrong rather than only the tax line. Every float figure
  // below was measured from the previous implementation, not predicted.
  type Case = {
    subtotal: number;
    rate: number;
    tax: string;
    total: string;
    floatTax: string;
    floatTotal: string;
  };

  // Explicitly typed rather than `as const`: with literal types TypeScript
  // resolves the divergence assertion below at compile time and rejects the
  // one case where the float total happens to match.
  const CASES: Case[] = [
    { subtotal: 2.3, rate: 5, tax: "0.12", total: "2.42", floatTax: "0.11", floatTotal: "2.42" },
    { subtotal: 4.5, rate: 13, tax: "0.59", total: "5.09", floatTax: "0.58", floatTotal: "5.08" },
    { subtotal: 6.0, rate: 8.25, tax: "0.50", total: "6.50", floatTax: "0.49", floatTotal: "6.50" },
    { subtotal: 50.0, rate: 6.35, tax: "3.18", total: "53.18", floatTax: "3.17", floatTotal: "53.17" },
    { subtotal: 0.15, rate: 10, tax: "0.02", total: "0.17", floatTax: "0.01", floatTotal: "0.16" },
    { subtotal: 10.0, rate: 6.35, tax: "0.64", total: "10.64", floatTax: "0.64", floatTotal: "10.63" },
  ];

  for (const testCase of CASES) {
    it(`${testCase.subtotal} at ${testCase.rate}% totals ${testCase.total}`, () => {
      const totals = agree({
        lines: [{ unitPrice: testCase.subtotal, quantity: 1 }],
        tax: makeTax({ rate: testCase.rate }),
      });

      expect(totals.subtotal).toBe(testCase.subtotal.toFixed(2));
      expect(totals.taxAmount).toBe(testCase.tax);
      expect(totals.total).toBe(testCase.total);
    });

    it(`NEGATIVE CONTROL: the old float math said tax ${testCase.floatTax}, total ${testCase.floatTotal}`, () => {
      // Reproduces the previous calculateCartSummary exactly, INCLUDING its two
      // separate rounding paths: the tax line was `taxAmount.toFixed(2)` and the
      // total was `(subtotal + unroundedTax).toFixed(2)`, which is why a receipt
      // could show a right total over a wrong tax line and still not add up.
      const taxAmount = testCase.subtotal * (testCase.rate / 100);

      expect(taxAmount.toFixed(2)).toBe(testCase.floatTax);
      expect((testCase.subtotal + taxAmount).toFixed(2)).toBe(testCase.floatTotal);

      // Every case must diverge somewhere, or it is not an edge case and the
      // assertion above has stopped proving anything.
      expect(
        testCase.floatTax !== testCase.tax || testCase.floatTotal !== testCase.total
      ).toBe(true);
    });
  }

  it("the old math could not even make its own lines add up", () => {
    // 2.30 subtotal, 0.11 tax, 2.42 total. A customer reading that slip is
    // right and it is wrong.
    const subtotal = 2.3;
    const taxAmount = subtotal * (5 / 100);

    expect(
      (subtotal + Number(taxAmount.toFixed(2))).toFixed(2)
    ).not.toBe((subtotal + taxAmount).toFixed(2));

    // The exact path cannot do this: the total is the sum of the rounded parts.
    const totals = agree({ lines: [{ unitPrice: 2.3, quantity: 1 }], tax: makeTax({ rate: 5 }) });

    expect((Number(totals.subtotal) + Number(totals.taxAmount)).toFixed(2)).toBe(
      totals.total
    );
  });
});

describe("the order-level sequence matches the server's", () => {
  it("sums the ROUNDED line totals, not the unrounded products", () => {
    // 0.155 per unit rounds to 0.16 before multiplying. Summing first gives
    // 0.465 -> 0.47, the server gives 0.16 x 3 = 0.48.
    const totals = agree({
      lines: [{ unitPrice: 0.155, quantity: 3 }],
      tax: makeTax({ enabled: false }),
    });

    expect(totals.subtotal).toBe("0.48");
    expect(exactLineMoney({ unitPrice: 0.155, quantity: 3 })!.unitPrice).toBe("0.16");
  });

  it("NEGATIVE CONTROL: rounding once at the end gives a different answer", () => {
    // 0.155 * 3 is 0.46499999999999997 as a double, so this rounds DOWN twice
    // over: once in the multiply, once in toFixed.
    expect((0.155 * 3).toFixed(2)).toBe("0.46");
  });

  it("multiplies before dividing by 100, as `subtotal * rate / 100` does", () => {
    // `subtotal * (rate/100)` rounds the rate first. 8.875% is a real rate.
    agree({ lines: [{ unitPrice: 4, quantity: 1 }], tax: makeTax({ rate: 8.875 }) });
    expect(
      exactOrderTotals({
        lineTotals: ["4.00"],
        tax: makeTax({ rate: 8.875 }),
        tipAmount: 0,
      }).taxAmount
    ).toBe("0.36");
    expect((4 * (8.875 / 100)).toFixed(2)).toBe("0.35");
  });

  it("extracts tax from a tax-inclusive price without changing the total", () => {
    const totals = agree({
      lines: [{ unitPrice: 0.15, quantity: 1 }],
      tax: makeTax({ rate: 20, pricesIncludeTax: true }),
    });

    expect(totals.subtotal).toBe("0.15");
    expect(totals.taxAmount).toBe("0.03");
    // The defining property of inclusive pricing.
    expect(totals.total).toBe(totals.subtotal);
    expect((0.15 - 0.15 / 1.2).toFixed(2)).toBe("0.02");
  });

  it("charges nothing when tax is disabled, whatever the rate says", () => {
    const totals = agree({
      lines: [{ unitPrice: 4, quantity: 2 }],
      tax: makeTax({ enabled: false, rate: 20 }),
    });

    expect(totals.taxAmount).toBe("0.00");
    expect(totals.total).toBe("8.00");
  });

  it("clamps a rate above 100 to 100 rather than dropping it to 0", () => {
    // The old client dropped it to 0, which undercharges against the server.
    expect(formatMoney(normalizeTaxRate(250))).toBe("100.00");
    expect(formatMoney(normalizeTaxRate(-5))).toBe("0.00");
    expect(formatMoney(normalizeTaxRate(Number.NaN))).toBe("0.00");

    agree({ lines: [{ unitPrice: 10, quantity: 1 }], tax: makeTax({ rate: 250 }) });
  });
});

describe("it agrees with the server across the whole realistic range", () => {
  for (const rate of [0, 4, 5, 6.35, 7.5, 8.25, 8.875, 10, 13, 15, 20]) {
    for (const pricesIncludeTax of [false, true]) {
      it(`${rate}%${pricesIncludeTax ? " inclusive" : ""}: 2,000 subtotals`, () => {
        const tax = makeTax({ rate, pricesIncludeTax });

        for (let cents = 1; cents <= 2000; cents += 1) {
          const lines = [{ unitPrice: cents / 100, quantity: 1 }];
          const lineTotals = [exactLineMoney(lines[0])!.lineTotal];

          expect(exactOrderTotals({ lineTotals, tax, tipAmount: 0 })).toEqual(
            serverTotals({ lines, tax, tipAmount: 0 })
          );
        }
      });
    }
  }
});

describe("stored money crosses the PostgREST boundary without drifting", () => {
  it("round-trips a numeric(12,2) that arrived as a double", () => {
    expect(storedMoneyToFixedString(8.8)).toBe("8.80");
    expect(storedMoneyToFixedString(0)).toBe("0.00");
    expect(storedMoneyToFixedString(1234567.89)).toBe("1234567.89");
    expect(storedMoneyToFixedString(6.49)).toBe("6.49");
  });

  it("NEGATIVE CONTROL: refuses a value no numeric(12,2) column could hold", () => {
    // A third decimal means the value did not come from stored money, and
    // silently rounding it here would invent a figure nobody charged.
    expect(storedMoneyToFixedString(1.005)).toBeNull();
    expect(storedMoneyToFixedString(0.001)).toBeNull();
    expect(storedMoneyToFixedString(Number.NaN)).toBeNull();
  });

  it("agrees with the oracle's own formatting", () => {
    for (const cents of [0n, 1n, 99n, 100n, 12345n, 999999n]) {
      expect(storedMoneyToFixedString(Number(cents) / 100)).toBe(
        toFixedFromCents(cents)
      );
      expect(centsFromCentsString(toFixedFromCents(cents))).toBe(cents);
    }
  });
});
