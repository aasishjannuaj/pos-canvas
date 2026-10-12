// v1.3 Cash Tender — the proof for lib/cashTender.ts.
//
// THE ORACLE BELOW IS THE POINT, for the same reason lib/money.test.ts has one:
// asserting change due against the module that computed it proves only that it
// is self-consistent. `oracleChange` is an INDEPENDENT model written in exact
// BigInt minor units with no shared code, so if the two ever disagree on a
// figure, one of them is wrong and this fails.
//
// THE CEILING IS PINNED TO ITS AUTHORITY, not to a number typed here. One test
// reads `c_max_money` out of the migration that enforces it and asserts
// MAX_TENDER_FIXED equals it, so raising the server bound without raising the
// keypad's — or inventing a smaller "practical" cap — breaks the build.
//
// Node environment, by necessity: this repository's Vitest `unit` project runs
// `environment: "node"` and the DOM libraries are absent. These are the rules
// that CAN be proven without a rendered component, which is exactly why they
// live in a pure module.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { formatMoney, moneyFromFixedString } from "@/lib/money";

import {
  CASH_DENOMINATIONS,
  EMPTY_TENDER_DIGITS,
  MAX_TENDER_DIGITS,
  MAX_TENDER_FIXED,
  appendTenderDigit,
  appendTenderDoubleZero,
  applyTenderDenomination,
  backspaceTenderDigit,
  buildCashTenderBinding,
  cashDenominations,
  cashTenderBindingsMatch,
  clearTenderDigits,
  formatTenderDigits,
  validateCashTender,
} from "@/lib/cashTender";
import type { CashTenderBindingInput } from "@/lib/cashTender";
import type { Currency } from "@/lib/projectConfig";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// The oracle — exact minor units, nothing shared with the module
// ---------------------------------------------------------------------------

function oracleMinorUnits(fixed: string): bigint {
  const match = /^(-?)(\d+)\.(\d{2})$/.exec(fixed);

  if (match === null) throw new Error(`oracle cannot read ${fixed}`);

  const magnitude = BigInt(match[2]) * 100n + BigInt(match[3]);

  return match[1] === "-" ? -magnitude : magnitude;
}

function oracleFixed(minorUnits: bigint): string {
  const negative = minorUnits < 0n;
  const magnitude = negative ? -minorUnits : minorUnits;
  const whole = magnitude / 100n;
  const minor = (magnitude % 100n).toString().padStart(2, "0");

  return `${negative ? "-" : ""}${whole}.${minor}`;
}

/** Change due, modelled independently of lib/cashTender.ts and lib/money.ts. */
function oracleChange(tenderDigits: string, amountDueFixed: string): string {
  const received = tenderDigits === "" ? 0n : BigInt(tenderDigits);

  return oracleFixed(received - oracleMinorUnits(amountDueFixed));
}

/**
 * lib/cashTender.ts with its comments removed.
 *
 * THE SCANS BELOW MUST READ CODE, NOT PROSE. The module's comments necessarily
 * NAME the things those comments explain are absent — createSaleFingerprint,
 * Supabase, the runtime — so scanning the raw text would fail on its own
 * documentation and the obvious "fix" would be to delete the explanation.
 */
function moduleCode(): string {
  return readFileSync(join(REPO_ROOT, "lib/cashTender.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Types every digit of a string through the keypad, left to right. */
function typeDigits(entry: string, from = EMPTY_TENDER_DIGITS): string {
  return [...entry].reduce((digits, digit) => {
    const result = appendTenderDigit(digits, digit);

    if (!result.ok) throw new Error(`keypad refused "${digit}": ${result.refusal}`);

    return result.digits;
  }, from);
}

/** 999999999999 — the largest entry the keypad accepts. */
const MAX_DIGITS = "9".repeat(MAX_TENDER_DIGITS);

const BINDING: CashTenderBindingInput = {
  checkoutSessionId: "session-1",
  cartIdentity: "cart-A",
  amountDueFixed: "12.50",
  tenderDigits: "2000",
  // CP-1C correction — the revision is REQUIRED now, so the shared fixture
  // carries one and every `{ ...BINDING }` spread inherits a valid checkout
  // generation. A test that wants the omitted case removes it explicitly.
  checkoutRevision: 1,
};

// ---------------------------------------------------------------------------
// 1. The ceiling is the server's, not a number chosen here
// ---------------------------------------------------------------------------

describe("the maximum tender is derived from the server bound", () => {
  const migration = readFileSync(
    join(REPO_ROOT, "supabase/migrations/20260922120000_daily_sale_attribution.sql"),
    "utf8",
  );

  it("equals c_max_money in the migration that enforces the sale-total ceiling", () => {
    const declared = /c_max_money\s+constant\s+numeric\s*:=\s*([0-9]+\.[0-9]{2})\s*;/.exec(
      migration,
    );

    expect(declared).not.toBeNull();
    expect(MAX_TENDER_FIXED).toBe(declared?.[1]);
  });

  it("is still the bound complete_sale_v5 actually raises on", () => {
    expect(migration).toContain("v_total > c_max_money");
    expect(migration).toContain("Order amount is too large");
  });

  it("is not a shortened practical cap — it spans the full numeric(12,2) range", () => {
    // 12 digits of precision, 2 of scale. A six- or seven-digit cap would
    // refuse sale totals the database stores perfectly well.
    expect(MAX_TENDER_FIXED.replace(".", "")).toHaveLength(12);
    expect(MAX_TENDER_DIGITS).toBe(12);
  });

  it("is reachable through the keypad, so no valid sale total is unpayable", () => {
    expect(formatTenderDigits(MAX_DIGITS)).toBe(MAX_TENDER_FIXED);
    expect(
      validateCashTender({ amountDueFixed: MAX_TENDER_FIXED, tenderDigits: MAX_DIGITS }),
    ).toEqual({ status: "sufficient", change: "0.00" });
  });
});

// ---------------------------------------------------------------------------
// 2. Digit entry, cents first
// ---------------------------------------------------------------------------

describe("digit entry shifts in from the right", () => {
  it("builds 8.75 from 8, 7, 5", () => {
    expect(formatTenderDigits(typeDigits("8"))).toBe("0.08");
    expect(formatTenderDigits(typeDigits("87"))).toBe("0.87");
    expect(formatTenderDigits(typeDigits("875"))).toBe("8.75");
  });

  it("needs no decimal key, so a second decimal point cannot be typed", () => {
    const refused = appendTenderDigit("875", ".");

    expect(refused).toEqual({ ok: false, refusal: "invalid_digit", digits: "875" });
  });

  it("refuses anything that is not a single digit", () => {
    for (const bad of ["", "12", "-", "e", " ", "\n", "٩", "１"]) {
      expect(appendTenderDigit("1", bad).ok).toBe(false);
    }
  });

  it("refuses to extend digits that were not digits to begin with", () => {
    expect(appendTenderDigit("1a2", "3")).toEqual({
      ok: false,
      refusal: "invalid_digit",
      digits: "1a2",
    });
  });
});

// ---------------------------------------------------------------------------
// 3. The 00 key
// ---------------------------------------------------------------------------

describe("the 00 key", () => {
  it("adds two minor-unit zeros, making round cash fast to enter", () => {
    const result = appendTenderDoubleZero(typeDigits("20"));

    expect(result.ok).toBe(true);
    expect(result.digits).toBe("2000");
    expect(formatTenderDigits(result.digits)).toBe("20.00");
  });

  it("does nothing on an empty field rather than burning input length", () => {
    expect(appendTenderDoubleZero(EMPTY_TENDER_DIGITS)).toEqual({
      ok: true,
      digits: EMPTY_TENDER_DIGITS,
    });
  });

  it("refuses when the two zeros would pass the ceiling", () => {
    const eleven = "9".repeat(11);
    const result = appendTenderDoubleZero(eleven);

    expect(result).toEqual({ ok: false, refusal: "max_input_reached", digits: eleven });
  });

  it("is accepted exactly at the ceiling boundary", () => {
    const ten = "9".repeat(10);

    expect(appendTenderDoubleZero(ten)).toEqual({ ok: true, digits: `${ten}00` });
    expect(`${ten}00`).toHaveLength(MAX_TENDER_DIGITS);
  });

  it("refuses a field that was not digits", () => {
    expect(appendTenderDoubleZero("1.5").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Backspace
// ---------------------------------------------------------------------------

describe("backspace", () => {
  it("removes the last minor-unit digit entered", () => {
    expect(backspaceTenderDigit("875")).toEqual({ ok: true, digits: "87" });
    expect(formatTenderDigits("87")).toBe("0.87");
  });

  it("leaves an empty field empty instead of producing a stray zero", () => {
    expect(backspaceTenderDigit("8")).toEqual({ ok: true, digits: EMPTY_TENDER_DIGITS });
    expect(backspaceTenderDigit(EMPTY_TENDER_DIGITS)).toEqual({
      ok: true,
      digits: EMPTY_TENDER_DIGITS,
    });
  });

  it("normalizes a leading zero exposed by the deletion", () => {
    // "105" -> delete -> "10"; "1050" -> "105". A deletion that bares a zero
    // must not leave "05" behind.
    expect(backspaceTenderDigit("105").digits).toBe("10");
    expect(backspaceTenderDigit("04").digits).toBe(EMPTY_TENDER_DIGITS);
  });

  it("round-trips an entry back to empty", () => {
    let digits = typeDigits("12345");

    for (let step = 0; step < 5; step += 1) digits = backspaceTenderDigit(digits).digits;

    expect(digits).toBe(EMPTY_TENDER_DIGITS);
  });
});

// ---------------------------------------------------------------------------
// 5. Clear
// ---------------------------------------------------------------------------

describe("clear", () => {
  it("returns to nothing entered", () => {
    expect(clearTenderDigits()).toEqual({ ok: true, digits: EMPTY_TENDER_DIGITS });
  });

  it("is the way back from additive denominations", () => {
    const stacked = applyTenderDenomination(applyTenderDenomination("", 20).digits, 5).digits;

    expect(formatTenderDigits(stacked)).toBe("25.00");
    expect(formatTenderDigits(clearTenderDigits().digits)).toBe("0.00");
  });
});

// ---------------------------------------------------------------------------
// 6. Leading zeros
// ---------------------------------------------------------------------------

describe("leading zeros", () => {
  it("ignores zeros pressed before any significant digit", () => {
    expect(typeDigits("0007")).toBe("7");
    expect(formatTenderDigits(typeDigits("0007"))).toBe("0.07");
  });

  it("keeps zeros that carry value", () => {
    expect(typeDigits("1005")).toBe("1005");
    expect(formatTenderDigits("1005")).toBe("10.05");
  });

  it("does not let leading zeros consume the input budget", () => {
    const zeros = typeDigits("0".repeat(20));

    expect(zeros).toBe(EMPTY_TENDER_DIGITS);
    expect(typeDigits(MAX_DIGITS, zeros)).toHaveLength(MAX_TENDER_DIGITS);
  });

  it("treats a normalized entry and its padded form as the same money", () => {
    expect(formatTenderDigits("7")).toBe(formatTenderDigits("0007"));
  });
});

// ---------------------------------------------------------------------------
// 7. Two-decimal display
// ---------------------------------------------------------------------------

describe("the display is always two decimal places", () => {
  it.each([
    [EMPTY_TENDER_DIGITS, "0.00"],
    ["0", "0.00"],
    ["5", "0.05"],
    ["50", "0.50"],
    ["500", "5.00"],
    ["1005", "10.05"],
    ["100000", "1000.00"],
    [MAX_DIGITS, MAX_TENDER_FIXED],
  ])("renders %o as %s", (digits, expected) => {
    expect(formatTenderDigits(digits)).toBe(expected);
  });

  it("always emits exactly two decimals and no separators", () => {
    for (const digits of ["", "1", "99", "12345", MAX_DIGITS]) {
      expect(formatTenderDigits(digits)).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it("falls back to 0.00 rather than printing a non-numeric entry as money", () => {
    expect(formatTenderDigits("oops")).toBe("0.00");
  });
});

// ---------------------------------------------------------------------------
// 8. Maximum input enforcement
// ---------------------------------------------------------------------------

describe("maximum input enforcement", () => {
  it("accepts the full twelve digits", () => {
    expect(typeDigits(MAX_DIGITS)).toBe(MAX_DIGITS);
    expect(formatTenderDigits(MAX_DIGITS)).toBe(MAX_TENDER_FIXED);
  });

  it("refuses the thirteenth digit", () => {
    expect(appendTenderDigit(MAX_DIGITS, "9")).toEqual({
      ok: false,
      refusal: "max_input_reached",
      digits: MAX_DIGITS,
    });
  });

  it("refuses rather than silently dropping the keystroke", () => {
    // A cashier who sees nothing happen presses harder. The refusal is a value
    // the caller can surface.
    const result = appendTenderDigit(MAX_DIGITS, "1");

    expect(result.ok).toBe(false);
    expect(result).toHaveProperty("refusal");
  });

  it("does not clamp, truncate or wrap the existing entry", () => {
    const result = appendTenderDigit(MAX_DIGITS, "7");

    expect(result.digits).toBe(MAX_DIGITS);
    expect(formatTenderDigits(result.digits)).toBe(MAX_TENDER_FIXED);
  });

  it("rejects one minor unit above the maximum as excessive, not as sufficient", () => {
    // 10000000000.00 is one minor unit past the ceiling. It is unreachable
    // through the keypad, so it is asserted against the validator directly.
    const oneOver = "1".padEnd(MAX_TENDER_DIGITS + 1, "0");

    expect(oneOver).toBe("1000000000000");
    expect(validateCashTender({ amountDueFixed: "5.00", tenderDigits: oneOver })).toEqual({
      status: "excessive",
    });
  });

  it("accepts the maximum itself against a small sale", () => {
    const result = validateCashTender({ amountDueFixed: "5.00", tenderDigits: MAX_DIGITS });

    expect(result).toEqual({
      status: "sufficient",
      change: oracleChange(MAX_DIGITS, "5.00"),
    });
  });
});

// ---------------------------------------------------------------------------
// 9. Denomination configuration
// ---------------------------------------------------------------------------

describe("quick denominations are configured per currency", () => {
  const EXPECTED: Record<Currency, readonly number[]> = {
    USD: [1, 5, 10, 20, 50, 100],
    CAD: [1, 2, 5, 10, 20, 50, 100],
    EUR: [1, 2, 5, 10, 20, 50, 100, 200],
    GBP: [1, 2, 5, 10, 20, 50],
  };

  it.each(Object.keys(EXPECTED) as Currency[])("matches the locked %s set", (currency) => {
    expect(cashDenominations(currency)).toEqual(EXPECTED[currency]);
  });

  it("covers every currency the product supports, with no extras", () => {
    // Keyed on the Currency union from lib/projectConfig.ts, so a new currency
    // cannot ship without its denominations.
    expect(Object.keys(CASH_DENOMINATIONS).sort()).toEqual(["CAD", "EUR", "GBP", "USD"]);
  });

  it("does not assume the USD set applies elsewhere", () => {
    // EUR has 2 and 200; GBP's largest circulating note is 50.
    expect(cashDenominations("EUR")).toContain(2);
    expect(cashDenominations("EUR")).toContain(200);
    expect(cashDenominations("GBP")).not.toContain(100);
    expect(cashDenominations("USD")).not.toContain(2);
  });

  it("lists whole positive units in ascending order", () => {
    for (const currency of Object.keys(CASH_DENOMINATIONS) as Currency[]) {
      const values = cashDenominations(currency);

      expect(values.every((value) => Number.isInteger(value) && value > 0)).toBe(true);
      expect([...values].sort((a, b) => a - b)).toEqual([...values]);
      expect(new Set(values).size).toBe(values.length);
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Denominations are additive
// ---------------------------------------------------------------------------

describe("denominations add rather than replace", () => {
  it("accumulates a 20 and a 5 into 25.00", () => {
    const twenty = applyTenderDenomination(EMPTY_TENDER_DIGITS, 20);
    const plusFive = applyTenderDenomination(twenty.digits, 5);

    expect(formatTenderDigits(twenty.digits)).toBe("20.00");
    expect(formatTenderDigits(plusFive.digits)).toBe("25.00");
  });

  it("does not overwrite the previous selection", () => {
    const stacked = [20, 20, 5, 1]
      .reduce((digits, note) => applyTenderDenomination(digits, note).digits, EMPTY_TENDER_DIGITS);

    expect(formatTenderDigits(stacked)).toBe("46.00");
  });

  it("adds on top of keypad digits already entered", () => {
    const result = applyTenderDenomination(typeDigits("175"), 20);

    expect(formatTenderDigits(result.digits)).toBe("21.75");
  });

  it("agrees with the oracle on the accumulated figure", () => {
    const stacked = [100, 50, 20, 20, 10, 5, 1]
      .reduce((digits, note) => applyTenderDenomination(digits, note).digits, EMPTY_TENDER_DIGITS);

    expect(stacked).toBe((206n * 100n).toString());
  });

  it("refuses a denomination that is not a positive whole unit", () => {
    for (const bad of [0, -20, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(applyTenderDenomination("500", bad).ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 11. Denomination overflow
// ---------------------------------------------------------------------------

describe("denomination overflow", () => {
  it("refuses an addition that would pass the ceiling", () => {
    const result = applyTenderDenomination(MAX_DIGITS, 1);

    expect(result).toEqual({
      ok: false,
      refusal: "max_amount_exceeded",
      digits: MAX_DIGITS,
    });
  });

  it("does not clamp to the maximum, which would record money nobody added", () => {
    const nearCeiling = "999999999000";
    const result = applyTenderDenomination(nearCeiling, 100);

    expect(result.ok).toBe(false);
    expect(result.digits).toBe(nearCeiling);
    expect(formatTenderDigits(result.digits)).toBe("9999999990.00");
  });

  it("does not wrap around to a small figure", () => {
    const result = applyTenderDenomination(MAX_DIGITS, 200);

    expect(result.digits).toBe(MAX_DIGITS);
    expect(formatTenderDigits(result.digits)).toBe(MAX_TENDER_FIXED);
  });

  it("still accepts an addition that lands exactly on the ceiling", () => {
    const oneShort = (999999999999n - 10000n).toString();
    const result = applyTenderDenomination(oneShort, 100);

    expect(result).toEqual({ ok: true, digits: MAX_DIGITS });
    expect(formatTenderDigits(result.digits)).toBe(MAX_TENDER_FIXED);
  });
});

// ---------------------------------------------------------------------------
// 12. Validation — nothing entered
// ---------------------------------------------------------------------------

describe("nothing entered", () => {
  it("is missing, not zero", () => {
    expect(
      validateCashTender({ amountDueFixed: "12.50", tenderDigits: EMPTY_TENDER_DIGITS }),
    ).toEqual({ status: "missing" });
  });

  it("is distinguishable from an explicit zero entry", () => {
    const empty = validateCashTender({ amountDueFixed: "12.50", tenderDigits: "" });
    const zero = validateCashTender({ amountDueFixed: "12.50", tenderDigits: "0" });

    expect(empty.status).toBe("missing");
    expect(zero.status).toBe("not_positive");
  });

  it("is missing even when the sale is free, so a blank field is never accepted", () => {
    expect(validateCashTender({ amountDueFixed: "0.00", tenderDigits: "" })).toEqual({
      status: "missing",
    });
  });

  it("never carries a change figure", () => {
    expect(
      validateCashTender({ amountDueFixed: "12.50", tenderDigits: "" }),
    ).not.toHaveProperty("change");
  });
});

// ---------------------------------------------------------------------------
// 13. Validation — malformed
// ---------------------------------------------------------------------------

describe("malformed input", () => {
  it.each(["12.5", "12", "12.500", "", "abc", "1e3", " 12.50", "12.50 ", "$12.50", "12,50"])(
    "reports an amount due of %o as malformed",
    (amountDueFixed) => {
      expect(validateCashTender({ amountDueFixed, tenderDigits: "2000" })).toEqual({
        status: "malformed",
      });
    },
  );

  it.each(["12.50", "-500", "1 000", "5e2", "0x10", "٥٠٠", "5.00"])(
    "reports a tender entry of %o as malformed",
    (tenderDigits) => {
      expect(validateCashTender({ amountDueFixed: "12.50", tenderDigits })).toEqual({
        status: "malformed",
      });
    },
  );

  it("never defaults a malformed amount due to zero, which would accept anything", () => {
    const result = validateCashTender({ amountDueFixed: "not money", tenderDigits: "1" });

    expect(result.status).toBe("malformed");
    expect(result.status).not.toBe("sufficient");
  });

  it("refuses a negative amount due instead of handing out change", () => {
    expect(validateCashTender({ amountDueFixed: "-12.50", tenderDigits: "2000" })).toEqual({
      status: "malformed",
    });
  });
});

// ---------------------------------------------------------------------------
// 14. Validation — zero and negative tender
// ---------------------------------------------------------------------------

describe("zero and negative tender", () => {
  it("reports an explicit zero as not positive", () => {
    expect(validateCashTender({ amountDueFixed: "12.50", tenderDigits: "0" })).toEqual({
      status: "not_positive",
    });
  });

  it("reports padded zeros as not positive", () => {
    for (const digits of ["0", "00", "0000", "0".repeat(12)]) {
      expect(validateCashTender({ amountDueFixed: "12.50", tenderDigits: digits })).toEqual({
        status: "not_positive",
      });
    }
  });

  it("will not accept zero even against a zero amount due", () => {
    expect(validateCashTender({ amountDueFixed: "0.00", tenderDigits: "0" })).toEqual({
      status: "not_positive",
    });
  });

  it("cannot represent a negative tender through the keypad at all", () => {
    expect(appendTenderDigit("", "-").ok).toBe(false);
    expect(applyTenderDenomination("", -20).ok).toBe(false);
    expect(validateCashTender({ amountDueFixed: "12.50", tenderDigits: "-1" }).status).toBe(
      "malformed",
    );
  });
});

// ---------------------------------------------------------------------------
// 15. Validation — insufficient
// ---------------------------------------------------------------------------

describe("insufficient tender", () => {
  it("is reported with the exact shortfall", () => {
    expect(validateCashTender({ amountDueFixed: "12.50", tenderDigits: "1000" })).toEqual({
      status: "insufficient",
      shortfall: "2.50",
    });
  });

  it("is reported one minor unit short", () => {
    expect(validateCashTender({ amountDueFixed: "20.00", tenderDigits: "1999" })).toEqual({
      status: "insufficient",
      shortfall: "0.01",
    });
  });

  it("never reports a change figure", () => {
    const result = validateCashTender({ amountDueFixed: "12.50", tenderDigits: "1000" });

    expect(result).not.toHaveProperty("change");
  });

  it("agrees with the oracle on the shortfall", () => {
    const cases: Array<[string, string]> = [
      ["12.50", "1"],
      ["0.02", "1"],
      ["100.00", "9999"],
      ["9999999999.99", "999999999998"],
    ];

    for (const [amountDueFixed, tenderDigits] of cases) {
      const result = validateCashTender({ amountDueFixed, tenderDigits });

      expect(result.status).toBe("insufficient");
      expect(result).toEqual({
        status: "insufficient",
        shortfall: oracleFixed(oracleMinorUnits(amountDueFixed) - BigInt(tenderDigits)),
      });
    }
  });

  it("reports an amount due above the ceiling as insufficient, never acceptable", () => {
    // Unreachable by any accepted tender, so it falls out on the safe side.
    const result = validateCashTender({
      amountDueFixed: "10000000000.00",
      tenderDigits: MAX_DIGITS,
    });

    expect(result.status).toBe("insufficient");
  });
});

// ---------------------------------------------------------------------------
// 16. Validation — excessive
// ---------------------------------------------------------------------------

describe("excessive tender", () => {
  it("is reported above the server's sale-total ceiling", () => {
    expect(
      validateCashTender({ amountDueFixed: "12.50", tenderDigits: "1000000000000" }),
    ).toEqual({ status: "excessive" });
  });

  it("stops exactly one minor unit past the ceiling and not before", () => {
    expect(
      validateCashTender({ amountDueFixed: "12.50", tenderDigits: MAX_DIGITS }).status,
    ).toBe("sufficient");
    expect(
      validateCashTender({ amountDueFixed: "12.50", tenderDigits: `${MAX_DIGITS}0` }).status,
    ).toBe("excessive");
  });

  it("never reports a change figure", () => {
    expect(
      validateCashTender({ amountDueFixed: "12.50", tenderDigits: "1000000000000" }),
    ).not.toHaveProperty("change");
  });

  it("means a ceiling-value sale can be paid exactly but not overpaid", () => {
    // The documented consequence of pinning the cap to the server bound. It is
    // deterministic, and the alternative is accepting money the database
    // cannot store.
    expect(
      validateCashTender({ amountDueFixed: MAX_TENDER_FIXED, tenderDigits: MAX_DIGITS }),
    ).toEqual({ status: "sufficient", change: "0.00" });
    expect(
      validateCashTender({ amountDueFixed: MAX_TENDER_FIXED, tenderDigits: `${MAX_DIGITS}0` })
        .status,
    ).toBe("excessive");
  });
});

// ---------------------------------------------------------------------------
// 17. Validation — sufficient, and the change
// ---------------------------------------------------------------------------

describe("sufficient tender", () => {
  it("reports exact payment with zero change", () => {
    expect(validateCashTender({ amountDueFixed: "12.50", tenderDigits: "1250" })).toEqual({
      status: "sufficient",
      change: "0.00",
    });
  });

  it("reports overpayment with the exact change", () => {
    expect(validateCashTender({ amountDueFixed: "12.50", tenderDigits: "2000" })).toEqual({
      status: "sufficient",
      change: "7.50",
    });
  });

  it("computes the one-cent case exactly, with no floating-point residue", () => {
    // 20.00 - 19.99 in IEEE-754 doubles is 0.010000000000001776. This is the
    // reason lib/money.ts exists and the reason this module reuses it.
    const result = validateCashTender({ amountDueFixed: "19.99", tenderDigits: "2000" });

    expect(result).toEqual({ status: "sufficient", change: "0.01" });
    expect((result as { change: string }).change).not.toContain("0000000");
  });

  it("agrees with the oracle across the range", () => {
    const cases: Array<[string, string]> = [
      ["0.01", "1"],
      ["0.07", "100"],
      ["19.99", "2000"],
      ["12.50", "2000"],
      ["0.10", "10000"],
      ["1234.56", "200000"],
      ["1000000.00", "100000000"],
      ["9999999999.98", "999999999999"],
      ["9999999999.99", "999999999999"],
    ];

    for (const [amountDueFixed, tenderDigits] of cases) {
      expect(validateCashTender({ amountDueFixed, tenderDigits })).toEqual({
        status: "sufficient",
        change: oracleChange(tenderDigits, amountDueFixed),
      });
    }
  });

  it("always formats change as a fixed two-decimal string", () => {
    for (const tenderDigits of ["1250", "2000", "999999999999"]) {
      const result = validateCashTender({ amountDueFixed: "12.50", tenderDigits });

      expect((result as { change: string }).change).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it("never reports a shortfall", () => {
    expect(
      validateCashTender({ amountDueFixed: "12.50", tenderDigits: "2000" }),
    ).not.toHaveProperty("shortfall");
  });

  it("holds for a tender assembled entirely from quick denominations", () => {
    const digits = [20, 5]
      .reduce((acc, note) => applyTenderDenomination(acc, note).digits, EMPTY_TENDER_DIGITS);

    expect(validateCashTender({ amountDueFixed: "23.47", tenderDigits: digits })).toEqual({
      status: "sufficient",
      change: "1.53",
    });
  });
});

// ---------------------------------------------------------------------------
// 18. Exactness is delegated, never reimplemented
// ---------------------------------------------------------------------------

describe("every figure comes from lib/money.ts", () => {
  it("matches the oracle on a sweep of amounts and tenders", () => {
    for (let due = 1n; due <= 400n; due += 7n) {
      for (let received = 1n; received <= 800n; received += 11n) {
        const amountDueFixed = oracleFixed(due);
        const tenderDigits = received.toString();
        const result = validateCashTender({ amountDueFixed, tenderDigits });

        if (received < due) {
          expect(result).toEqual({
            status: "insufficient",
            shortfall: oracleFixed(due - received),
          });
        } else {
          expect(result).toEqual({
            status: "sufficient",
            change: oracleFixed(received - due),
          });
        }
      }
    }
  });

  it("does not drift at magnitudes where doubles lose cent precision", () => {
    // 2^53 minor units is ~90 trillion, but doubles already misrepresent
    // figures far below the ceiling once cents are involved.
    expect(
      validateCashTender({ amountDueFixed: "9007199254.74", tenderDigits: "900719925475" }),
    ).toEqual({ status: "sufficient", change: "0.01" });
  });

  it("contains no floating-point arithmetic of its own", () => {
    const code = moduleCode();

    for (const banned of ["parseFloat", "parseInt", "Number(", ".toFixed(", "Math."]) {
      expect(code).not.toContain(banned);
    }
  });

  it("imports no runtime module other than lib/money.ts", () => {
    const source = moduleCode();
    const runtimeImports = [...source.matchAll(/^import\s+(?!type\b)[\s\S]*?from\s+"([^"]+)";/gm)]
      .map((match) => match[1]);

    expect(runtimeImports).toEqual(["@/lib/money"]);
  });
});

// ---------------------------------------------------------------------------
// 19. Confirmation binding — what it covers
// ---------------------------------------------------------------------------

describe("the confirmation binding", () => {
  it("is deterministic for identical inputs", () => {
    expect(buildCashTenderBinding(BINDING)).toBe(buildCashTenderBinding({ ...BINDING }));
    expect(cashTenderBindingsMatch(buildCashTenderBinding(BINDING), buildCashTenderBinding(BINDING)))
      .toBe(true);
  });

  it("changes when the checkout session changes, so a reopen cannot reuse it", () => {
    const reopened = buildCashTenderBinding({ ...BINDING, checkoutSessionId: "session-2" });

    expect(cashTenderBindingsMatch(buildCashTenderBinding(BINDING), reopened)).toBe(false);
  });

  it("changes when the cart contents change", () => {
    const otherCart = buildCashTenderBinding({ ...BINDING, cartIdentity: "cart-B" });

    expect(cashTenderBindingsMatch(buildCashTenderBinding(BINDING), otherCart)).toBe(false);
  });

  it("changes when the amount owed changes under an identical cart", () => {
    // A price or tax change moves the total without moving the item identity.
    const repriced = buildCashTenderBinding({ ...BINDING, amountDueFixed: "13.50" });

    expect(cashTenderBindingsMatch(buildCashTenderBinding(BINDING), repriced)).toBe(false);
  });

  it("distinguishes two different carts that happen to share a total", () => {
    const a = buildCashTenderBinding({ ...BINDING, cartIdentity: "two-coffees" });
    const b = buildCashTenderBinding({ ...BINDING, cartIdentity: "one-sandwich" });

    expect(cashTenderBindingsMatch(a, b)).toBe(false);
  });

  it("changes when the tender entry is edited", () => {
    const edited = buildCashTenderBinding({ ...BINDING, tenderDigits: "1300" });

    expect(cashTenderBindingsMatch(buildCashTenderBinding(BINDING), edited)).toBe(false);
  });

  it("cannot be forged by a field containing the separator", () => {
    // JSON-encoded rather than delimiter-joined, so a crafted cart identity
    // cannot impersonate another binding's string.
    const crafted = buildCashTenderBinding({
      ...BINDING,
      cartIdentity: 'cart-A","12.50","2000',
      amountDueFixed: "0.01",
      tenderDigits: "1",
    });

    expect(cashTenderBindingsMatch(buildCashTenderBinding(BINDING), crafted)).toBe(false);
  });

  it("does not use the sale fingerprint as the cart identity", () => {
    // createSaleFingerprint excludes prices and item names by design, so a
    // confirmation bound to it alone would survive a repricing. The caller
    // supplies cartIdentity, and the amount owed is bound separately.
    const source = moduleCode();

    expect(source).not.toContain("createSaleFingerprint");
    expect(source).not.toContain("@/lib/saleRequest");
  });
});

// ---------------------------------------------------------------------------
// 20. Confirmation binding — the revision, and A -> B -> A
// ---------------------------------------------------------------------------

describe("the required revision", () => {
  it("is never produced inside the module", () => {
    const source = moduleCode();

    for (const banned of ["Date.now", "new Date", "Math.random", "crypto", "performance.now"]) {
      expect(source).not.toContain(banned);
    }
  });

  it("distinguishes two confirmations that differ only by revision", () => {
    const first = buildCashTenderBinding({ ...BINDING, checkoutRevision: 1 });
    const second = buildCashTenderBinding({ ...BINDING, checkoutRevision: 2 });

    expect(cashTenderBindingsMatch(first, second)).toBe(false);
  });

  it("treats revision zero as a real value, not as an absence", () => {
    const zero = buildCashTenderBinding({ ...BINDING, checkoutRevision: 0 });
    const one = buildCashTenderBinding({ ...BINDING, checkoutRevision: 1 });

    expect(cashTenderBindingsMatch(zero, one)).toBe(false);
    expect(zero).toContain(",0]");
  });

  it("detects A -> B -> A when the revision has advanced", () => {
    const confirmed = buildCashTenderBinding({ ...BINDING, checkoutRevision: 1 });
    const changed = buildCashTenderBinding({
      ...BINDING,
      cartIdentity: "cart-B",
      checkoutRevision: 2,
    });
    const restored = buildCashTenderBinding({ ...BINDING, checkoutRevision: 3 });

    expect(cashTenderBindingsMatch(confirmed, changed)).toBe(false);
    expect(cashTenderBindingsMatch(confirmed, restored)).toBe(false);
  });

  it("REFUSES to build a binding at all when the revision is omitted", () => {
    // THE CP-1C HIGH FINDING, INVERTED. This test previously asserted that an
    // omitted revision let a stale A match a later A. That hole is now closed
    // at the only place it could be closed: the builder will not produce a
    // string for a caller that cannot say which checkout generation it is on.
    const withoutRevision: Record<string, unknown> = { ...BINDING };

    delete withoutRevision.checkoutRevision;

    expect(() =>
      buildCashTenderBinding(withoutRevision as unknown as CashTenderBindingInput),
    ).toThrow(/checkoutRevision is required/);
  });
});

// ---------------------------------------------------------------------------
// 21. Confirmation binding — the revision must be a real counter
// ---------------------------------------------------------------------------

describe("revision validation", () => {
  /**
   * The exact binding a valid call produces, written out rather than built from
   * the module.
   *
   * THIS PINS THE WIRE FORMAT, INCLUDING THE VERSION BUMP. v1 encoded an absent
   * revision as `null`; v2 cannot produce that at all, so a confirmation
   * captured under the old reusable contract can never compare equal to one
   * captured under this one.
   */
  const VALID_BINDING =
    '["posc.cashtender.v2","session-1","cart-A","12.50","2000",1]';

  function attempt(
    over: Record<string, unknown>,
  ): { threw: true; message: string } | { threw: false; binding: string } {
    try {
      return {
        threw: false,
        binding: buildCashTenderBinding({
          ...BINDING,
          ...over,
        } as unknown as CashTenderBindingInput),
      };
    } catch (error) {
      return { threw: true, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Builds with one field deleted outright, not merely set to undefined. */
  function attemptWithout(
    field: keyof CashTenderBindingInput,
  ): { threw: true; message: string } | { threw: false; binding: string } {
    const partial: Record<string, unknown> = { ...BINDING };

    delete partial[field];

    try {
      return { threw: false, binding: buildCashTenderBinding(partial as unknown as CashTenderBindingInput) };
    } catch (error) {
      return { threw: true, message: error instanceof Error ? error.message : String(error) };
    }
  }

  // --- the valid case, and the format it pins -------------------------------

  it("accepts a valid required revision and emits the pinned v2 format", () => {
    expect(buildCashTenderBinding(BINDING)).toBe(VALID_BINDING);
  });

  it("accepts revision zero and Number.MAX_SAFE_INTEGER", () => {
    expect(attempt({ checkoutRevision: 0 }).threw).toBe(false);
    expect(attempt({ checkoutRevision: Number.MAX_SAFE_INTEGER }).threw).toBe(false);
  });

  it("is deterministic and matches a re-derived binding at the same revision", () => {
    expect(cashTenderBindingsMatch(buildCashTenderBinding(BINDING), buildCashTenderBinding({ ...BINDING })))
      .toBe(true);
  });

  // --- 1. 2. 3. every rejected revision ------------------------------------

  it("rejects an omitted revision property", () => {
    const outcome = attemptWithout("checkoutRevision");

    expect(outcome.threw).toBe(true);
    expect(outcome).not.toHaveProperty("binding");
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["NaN", Number.NaN],
    ["positive Infinity", Number.POSITIVE_INFINITY],
    ["negative Infinity", Number.NEGATIVE_INFINITY],
    ["a negative integer", -1],
    ["a fractional number", 1.5],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 2],
    ["a numeric string", "1"],
    ["a boolean", true],
    ["an object", { valueOf: () => 1 }],
  ])("rejects a revision of %s and produces no binding", (_label, checkoutRevision) => {
    const outcome = attempt({ checkoutRevision });

    expect(outcome.threw).toBe(true);
    expect(outcome).not.toHaveProperty("binding");
    if (outcome.threw) expect(outcome.message).toContain("checkoutRevision");
  });

  // --- 5. 6. revision freshness and A -> B -> A ----------------------------

  it("makes revision N and N+1 non-matching", () => {
    const n = buildCashTenderBinding({ ...BINDING, checkoutRevision: 41 });
    const next = buildCashTenderBinding({ ...BINDING, checkoutRevision: 42 });

    expect(cashTenderBindingsMatch(n, next)).toBe(false);
  });

  it("simulated A -> B -> A with distinct revisions cannot reuse the earlier binding", () => {
    // A confirmed at N; mutated to B at N+1; returned to a VISUALLY IDENTICAL A
    // at N+2. Every other bound field is back to its original value.
    const aAtN = buildCashTenderBinding({ ...BINDING, checkoutRevision: 7 });
    const bAtN1 = buildCashTenderBinding({
      ...BINDING,
      cartIdentity: "cart-B",
      amountDueFixed: "31.00",
      checkoutRevision: 8,
    });
    const aAtN2 = buildCashTenderBinding({ ...BINDING, checkoutRevision: 9 });

    expect(cashTenderBindingsMatch(aAtN, bAtN1)).toBe(false);
    expect(cashTenderBindingsMatch(bAtN1, aAtN2)).toBe(false);
    // The finding: the ORIGINAL confirmation must not match the restored state.
    expect(cashTenderBindingsMatch(aAtN, aAtN2)).toBe(false);
    expect(new Set([aAtN, bAtN1, aAtN2]).size).toBe(3);

    // And the cart/total fields really did return to their earlier values, so
    // the revision is demonstrably the only thing telling them apart.
    expect(aAtN.replace(',7]', ',X]')).toBe(aAtN2.replace(',9]', ',X]'));
  });

  // --- 7. every required field rejects missing/malformed/wrong-type --------

  it.each(["checkoutSessionId", "cartIdentity", "amountDueFixed", "tenderDigits"] as const)(
    "rejects an omitted %s",
    (field) => {
      const outcome = attemptWithout(field);

      expect(outcome.threw).toBe(true);
      expect(outcome).not.toHaveProperty("binding");
    },
  );

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["NaN", Number.NaN],
    ["positive Infinity", Number.POSITIVE_INFINITY],
    ["a number", 12.5],
    ["a boolean", true],
    ["an array", [1, 2]],
    ["an object", { a: 1 }],
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["a padded string", " session-1 "],
  ])("rejects a checkoutSessionId of %s", (_label, checkoutSessionId) => {
    expect(attempt({ checkoutSessionId }).threw).toBe(true);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["NaN", Number.NaN],
    ["a number", 12.5],
    ["an array", [1, 2]],
    ["an object", { a: 1 }],
    ["an empty string", ""],
    ["whitespace only", "  "],
    ["a padded string", " cart-A "],
  ])("rejects a cartIdentity of %s", (_label, cartIdentity) => {
    expect(attempt({ cartIdentity }).threw).toBe(true);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["NaN", Number.NaN],
    ["a number", 12.5],
    ["one decimal place", "12.5"],
    ["three decimal places", "12.500"],
    ["no decimal point", "12"],
    ["non-money text", "not money"],
    ["an empty string", ""],
    ["a negative amount", "-12.50"],
    ["a padded amount", " 12.50"],
    ["a currency symbol", "$12.50"],
  ])("rejects an amountDueFixed of %s", (_label, amountDueFixed) => {
    expect(attempt({ amountDueFixed }).threw).toBe(true);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 2000],
    ["an array", []],
    ["a decimal point", "20.00"],
    ["a sign", "-2000"],
    ["whitespace", "2 000"],
    ["letters", "20a0"],
    ["exponential", "2e3"],
    ["non-ASCII digits", "٢٠٠٠"],
    ["a leading zero", "02000"],
    ["many leading zeros", "0002000"],
    ["a bare zero", "0"],
  ])("rejects a tenderDigits of %s", (_label, tenderDigits) => {
    expect(attempt({ tenderDigits }).threw).toBe(true);
  });

  it("accepts empty tenderDigits, because a cleared field is an ordinary state", () => {
    // Sufficiency is validateCashTender's question; the runtime must be able to
    // recompute a live binding for a checkout whose amount was just cleared.
    expect(attempt({ tenderDigits: "" }).threw).toBe(false);
  });

  // --- 8. distinct invalid values cannot collide ---------------------------

  it("never lets distinct malformed values produce one apparently valid binding", () => {
    // THE CP-1C MEDIUM FINDING. JSON.stringify maps undefined, NaN and both
    // infinities to null inside an array, so these five produced ONE identical
    // binding. None of them may produce a string at all now.
    const bindings: string[] = [];

    for (const bad of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const outcome = attempt({ checkoutSessionId: bad });

      expect(outcome.threw).toBe(true);
      if (!outcome.threw) bindings.push(outcome.binding);
    }

    expect(bindings).toEqual([]);
  });

  it("names the offending field, so a broken caller is diagnosable", () => {
    for (const [field, bad] of [
      ["checkoutSessionId", null],
      ["cartIdentity", ""],
      ["amountDueFixed", "12.5"],
      ["tenderDigits", "02000"],
      ["checkoutRevision", Number.NaN],
    ] as const) {
      const outcome = attempt({ [field]: bad });

      expect(outcome.threw).toBe(true);
      if (outcome.threw) expect(outcome.message).toContain(field);
    }
  });

  it("still distinguishes every field it is supposed to distinguish", () => {
    const base = buildCashTenderBinding(BINDING);

    for (const over of [
      { checkoutSessionId: "session-2" },
      { cartIdentity: "cart-B" },
      { amountDueFixed: "13.50" },
      { tenderDigits: "1300" },
      { checkoutRevision: 2 },
    ]) {
      const other = attempt(over);

      expect(other.threw).toBe(false);
      if (!other.threw) expect(cashTenderBindingsMatch(base, other.binding)).toBe(false);
    }
  });

  it("cannot be forged by a field containing the separator", () => {
    const crafted = attempt({ cartIdentity: 'cart-A","12.50","2000' });

    expect(crafted.threw).toBe(false);
    if (!crafted.threw) {
      expect(cashTenderBindingsMatch(buildCashTenderBinding(BINDING), crafted.binding)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 21b. Malformed digit state — nothing coerces, nothing is silently accepted
// ---------------------------------------------------------------------------

describe("malformed digit state fails closed", () => {
  /**
   * Values that a `RegExp.test` guard alone would ACCEPT, because it coerces.
   *
   * `DIGITS_ONLY.test(123)` is true and `DIGITS_ONLY.test([])` is true — the
   * empty array stringifies to "". Before this correction a number arriving
   * through an unsafe cast was canonicalised into an apparently valid entry.
   */
  const COERCIBLE: [string, unknown][] = [
    ["a number", 123],
    ["zero", 0],
    ["a bigint", 7n],
    ["an empty array", []],
  ];

  const NON_COERCIBLE: [string, unknown][] = [
    ["true", true],
    ["null", null],
    ["undefined", undefined],
    ["an object", {}],
    ["an array of digits", [1, 2]],
  ];

  it.each([...COERCIBLE, ...NON_COERCIBLE])(
    "appendTenderDigit refuses %s as the entry",
    (_label, value) => {
      const result = appendTenderDigit(value as unknown as string, "4");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal).toBe("invalid_digit");
      // A non-string is not an entry, so nothing is echoed back as one.
      expect(typeof result.digits).toBe("string");
      expect(result.digits).toBe(EMPTY_TENDER_DIGITS);
    },
  );

  it.each([...COERCIBLE, ...NON_COERCIBLE])(
    "appendTenderDigit refuses %s as the pressed key",
    (_label, value) => {
      const result = appendTenderDigit("1250", value as unknown as string);

      expect(result.ok).toBe(false);
      // The existing entry is a real string, so it IS preserved unchanged.
      expect(result.digits).toBe("1250");
    },
  );

  it.each([...COERCIBLE, ...NON_COERCIBLE])(
    "appendTenderDoubleZero, backspace and applyTenderDenomination refuse %s",
    (_label, value) => {
      for (const result of [
        appendTenderDoubleZero(value as unknown as string),
        backspaceTenderDigit(value as unknown as string),
        applyTenderDenomination(value as unknown as string, 20),
      ]) {
        expect(result.ok).toBe(false);
        expect(result.digits).toBe(EMPTY_TENDER_DIGITS);
      }
    },
  );

  it.each([...COERCIBLE, ...NON_COERCIBLE])(
    "formatTenderDigits and validateCashTender refuse %s",
    (_label, value) => {
      expect(formatTenderDigits(value as unknown as string)).toBe("0.00");
      expect(
        validateCashTender({ amountDueFixed: "12.50", tenderDigits: value as unknown as string })
          .status,
      ).toBe("malformed");
    },
  );

  it("refuses a non-string amount due rather than coercing it", () => {
    for (const bad of [1250, null, undefined, {}, []]) {
      expect(
        validateCashTender({
          amountDueFixed: bad as unknown as string,
          tenderDigits: "2000",
        }).status,
      ).toBe("malformed");
    }
  });

  it.each([
    ["a sign", "+500"],
    ["a minus sign", "-500"],
    ["a decimal point", "5.00"],
    ["whitespace", "5 00"],
    ["a tab", "5\t00"],
    ["letters", "5a0"],
    ["non-ASCII digits", "٥٠٠"],
    ["fullwidth digits", "５００"],
    ["exponential", "5e2"],
    ["hex", "0x10"],
  ])("refuses the malformed string %s, echoing it unchanged", (_label, digits) => {
    const result = appendTenderDigit(digits, "1");

    expect(result.ok).toBe(false);
    // A malformed STRING is still the caller's entry, so refusals never edit it.
    expect(result.digits).toBe(digits);
  });

  it("refuses an excessively long entry without hanging", () => {
    const long = "9".repeat(100_000);

    // It is a valid digit string, so it is refused on LENGTH, deterministically.
    const result = appendTenderDigit(long, "1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe("max_input_reached");
    expect(validateCashTender({ amountDueFixed: "12.50", tenderDigits: long }).status).toBe(
      "excessive",
    );
  });

  it("refuses a value above the approved ceiling", () => {
    expect(
      validateCashTender({ amountDueFixed: "12.50", tenderDigits: `${MAX_DIGITS}0` }).status,
    ).toBe("excessive");
    expect(appendTenderDigit(MAX_DIGITS, "9").ok).toBe(false);
  });

  it("refuses double-zero overflow at the ceiling", () => {
    expect(appendTenderDoubleZero("9".repeat(11)).ok).toBe(false);
    expect(appendTenderDoubleZero("9".repeat(12)).ok).toBe(false);
    // And repeated presses cannot creep past it.
    let digits = "9".repeat(10);

    for (let press = 0; press < 5; press += 1) {
      const result = appendTenderDoubleZero(digits);

      if (result.ok) digits = result.digits;
    }

    expect(digits.length).toBeLessThanOrEqual(MAX_TENDER_DIGITS);
  });

  it("clear recovers safely from any malformed state", () => {
    // 12. Clear takes no input, so it cannot inherit a malformed one.
    expect(clearTenderDigits()).toEqual({ ok: true, digits: EMPTY_TENDER_DIGITS });
    expect(formatTenderDigits(clearTenderDigits().digits)).toBe("0.00");
    expect(
      validateCashTender({
        amountDueFixed: "12.50",
        tenderDigits: clearTenderDigits().digits,
      }),
    ).toEqual({ status: "missing" });
  });

  it("backspace from a malformed string refuses rather than half-editing it", () => {
    const result = backspaceTenderDigit("1a2");

    expect(result.ok).toBe(false);
    expect(result.digits).toBe("1a2");
  });

  it("13. leaves valid canonical tender calculations exactly as before", () => {
    expect(validateCashTender({ amountDueFixed: "19.99", tenderDigits: "2000" })).toEqual({
      status: "sufficient",
      change: "0.01",
    });
    expect(validateCashTender({ amountDueFixed: "12.50", tenderDigits: "1000" })).toEqual({
      status: "insufficient",
      shortfall: "2.50",
    });
    expect(formatTenderDigits("1005")).toBe("10.05");
    expect(appendTenderDigit("875", "0")).toEqual({ ok: true, digits: "8750" });
  });
});

// ---------------------------------------------------------------------------
// 21d. Canonical amount due, and the tender ceiling at the binding
// ---------------------------------------------------------------------------

describe("the binding accepts only canonical money", () => {
  const attempt = (
    over: Record<string, unknown>,
  ): { threw: true; message: string } | { threw: false; binding: string } => {
    try {
      return {
        threw: false,
        binding: buildCashTenderBinding({ ...BINDING, ...over } as unknown as CashTenderBindingInput),
      };
    } catch (error) {
      return { threw: true, message: error instanceof Error ? error.message : String(error) };
    }
  };

  it.each(["12.50", "0.01", "0.00", "1000000.00", MAX_TENDER_FIXED])(
    "accepts the canonical amount %s",
    (amountDueFixed) => {
      expect(attempt({ amountDueFixed }).threw).toBe(false);
    },
  );

  it.each([
    ["one leading zero", "012.50"],
    ["two leading zeros", "0012.50"],
    ["many leading zeros", "000000012.50"],
    ["a padded zero amount", "00.00"],
    ["a padded sub-unit amount", "00.50"],
  ])("rejects the non-canonical amount %s", (_label, amountDueFixed) => {
    const outcome = attempt({ amountDueFixed });

    expect(outcome.threw).toBe(true);
    expect(outcome).not.toHaveProperty("binding");
    if (outcome.threw) expect(outcome.message).toContain("canonical");
  });

  it("names the canonical spelling it expected, so the caller can fix it", () => {
    const outcome = attempt({ amountDueFixed: "0012.50" });

    expect(outcome.threw).toBe(true);
    if (outcome.threw) expect(outcome.message).toContain("12.50");
  });

  it("cannot be used to bind one amount under two different spellings", () => {
    // THE DEFECT. "0012.50" and "12.50" are the same money; binding both would
    // have produced two confirmations for one total.
    const canonical = attempt({ amountDueFixed: "12.50" });
    const padded = attempt({ amountDueFixed: "0012.50" });

    expect(canonical.threw).toBe(false);
    expect(padded.threw).toBe(true);
  });

  it("asks lib/money.ts what canonical means rather than deciding here", () => {
    // Round-trip: whatever formatMoney emits IS the canonical spelling. This
    // pins the relationship so a future edit cannot drift into a second rule.
    for (const value of ["12.50", "0.01", "0.00", "1000000.00", MAX_TENDER_FIXED]) {
      const money = moneyFromFixedString(value);

      expect(money).not.toBeNull();
      if (money !== null) expect(formatMoney(money)).toBe(value);
    }

    for (const value of ["0012.50", "00.50"]) {
      const money = moneyFromFixedString(value);

      expect(money).not.toBeNull();
      if (money !== null) expect(formatMoney(money)).not.toBe(value);
    }
  });

  it("still rejects every previously covered malformed amount", () => {
    for (const bad of [undefined, null, Number.NaN, 12.5, "12.5", "12.500", "", "-12.50", "$12.50"]) {
      expect(attempt({ amountDueFixed: bad }).threw).toBe(true);
    }
  });

  it("introduces no floating-point arithmetic", () => {
    const code = moduleCode();

    for (const banned of ["parseFloat", "parseInt", "Number(", ".toFixed(", "Math."]) {
      expect(code).not.toContain(banned);
    }
  });
});

describe("the binding enforces the tender ceiling", () => {
  const attempt = (
    tenderDigits: unknown,
  ): { threw: true; message: string } | { threw: false; binding: string } => {
    try {
      return {
        threw: false,
        binding: buildCashTenderBinding({
          ...BINDING,
          tenderDigits,
        } as unknown as CashTenderBindingInput),
      };
    } catch (error) {
      return { threw: true, message: error instanceof Error ? error.message : String(error) };
    }
  };

  it("1. accepts exactly MAX_TENDER_DIGITS", () => {
    expect(MAX_DIGITS).toHaveLength(MAX_TENDER_DIGITS);
    expect(attempt(MAX_DIGITS).threw).toBe(false);
  });

  it("2. rejects one digit beyond the limit", () => {
    const oneOver = `${MAX_DIGITS}0`;

    expect(oneOver).toHaveLength(MAX_TENDER_DIGITS + 1);
    const outcome = attempt(oneOver);

    expect(outcome.threw).toBe(true);
    expect(outcome).not.toHaveProperty("binding");
    if (outcome.threw) expect(outcome.message).toContain("at most");
  });

  it("3. rejects an extremely long digit string", () => {
    expect(attempt("9".repeat(100_000)).threw).toBe(true);
  });

  it("4. rejects negative, decimal, whitespace and non-ASCII entries", () => {
    for (const bad of ["-2000", "20.00", "2 000", "٢٠٠٠", "５００", "+2000", "2e3"]) {
      expect(attempt(bad).threw).toBe(true);
    }
  });

  it("5. rejects non-string runtime inputs", () => {
    for (const bad of [2000, null, undefined, {}, [], true, 7n]) {
      expect(attempt(bad).threw).toBe(true);
    }
  });

  it("agrees with the keypad about where the ceiling is", () => {
    // Same bound, both paths: the editing path refuses the 13th keystroke and
    // the binding path refuses a 13-digit entry.
    expect(appendTenderDigit(MAX_DIGITS, "9").ok).toBe(false);
    expect(attempt(`${MAX_DIGITS}9`).threw).toBe(true);
    expect(formatTenderDigits(MAX_DIGITS)).toBe(MAX_TENDER_FIXED);
  });
});

// ---------------------------------------------------------------------------
// 21e. An empty tender binds for COMPARISON — it is never authorization
// ---------------------------------------------------------------------------

describe("an empty tender is bindable but never sufficient", () => {
  it("6. still binds, so the runtime can compare a cleared checkout", () => {
    // The runtime recomputes a live binding from whatever is on screen. A
    // cashier who cleared the amount is an ordinary state, not an exception.
    const cleared = buildCashTenderBinding({ ...BINDING, tenderDigits: EMPTY_TENDER_DIGITS });

    expect(typeof cleared).toBe("string");
    expect(cashTenderBindingsMatch(cleared, buildCashTenderBinding(BINDING))).toBe(false);
  });

  it("validateCashTender reports `missing` for an empty tender", () => {
    expect(
      validateCashTender({ amountDueFixed: "12.50", tenderDigits: EMPTY_TENDER_DIGITS }),
    ).toEqual({ status: "missing" });
  });

  it("a bindable tender is NOT an authorized one", () => {
    // THE DISTINCTION THAT MATTERS. Being able to construct a comparison
    // binding says nothing about sufficiency. Every one of these binds, and not
    // one of them validates as sufficient.
    for (const tenderDigits of [EMPTY_TENDER_DIGITS, "1", "1249"]) {
      expect(() =>
        buildCashTenderBinding({ ...BINDING, tenderDigits }),
      ).not.toThrow();
      expect(
        validateCashTender({ amountDueFixed: "12.50", tenderDigits }).status,
      ).not.toBe("sufficient");
    }
  });

  it("invalid or excessive tender can never return sufficient", () => {
    for (const tenderDigits of ["", "0", "00", "-1", "12.50", "abc", `${MAX_DIGITS}0`]) {
      expect(
        validateCashTender({ amountDueFixed: "12.50", tenderDigits }).status,
      ).not.toBe("sufficient");
    }
  });

  it("only a sufficient validation may gate Confirm Tender in the future runtime", () => {
    // Recorded as an assertion so the contract is not left to prose: the
    // runtime must require `sufficient` before confirming. Nothing in this pure
    // module implements Confirm Tender, and this test does not pretend it does.
    const ok = validateCashTender({ amountDueFixed: "12.50", tenderDigits: "2000" });
    const notOk = validateCashTender({ amountDueFixed: "12.50", tenderDigits: EMPTY_TENDER_DIGITS });

    expect(ok.status).toBe("sufficient");
    expect(notOk.status).toBe("missing");
    expect(ok).toHaveProperty("change");
    expect(notOk).not.toHaveProperty("change");
  });
});

// ---------------------------------------------------------------------------
// 21c. The denomination contract stays GENERIC (Control Room decision)
// ---------------------------------------------------------------------------

describe("applyTenderDenomination remains generic arithmetic", () => {
  it("accepts any positive whole unit, including values in no currency table", () => {
    // DELIBERATE. Control Room chose to keep this generic rather than make it
    // currency-specific, so it adds whole units and does not police membership.
    for (const units of [3, 7, 13, 17, 99]) {
      const result = applyTenderDenomination(EMPTY_TENDER_DIGITS, units);

      expect(result.ok).toBe(true);
      expect(formatTenderDigits(result.digits)).toBe(`${units}.00`);
    }
  });

  it("accepts a note from another currency, because it consults no table", () => {
    // 200 exists only for EUR; this function takes no Currency and so cannot
    // and must not refuse it. Membership is the UI's obligation — see below.
    expect(applyTenderDenomination(EMPTY_TENDER_DIGITS, 200).ok).toBe(true);
    expect(cashDenominations("GBP")).not.toContain(200);
  });

  it("consults CASH_DENOMINATIONS nowhere, so the generic contract is real", () => {
    const code = moduleCode();
    const body = code.slice(
      code.indexOf("export function applyTenderDenomination"),
      code.indexOf("export function formatTenderDigits"),
    );

    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toContain("CASH_DENOMINATIONS");
    expect(body).not.toContain("cashDenominations");
    expect(body).not.toContain("Currency");
  });

  it("states the caller's obligation in source, so the gap cannot be forgotten", () => {
    // The residual risk of staying generic: nothing here catches a quick-tender
    // button whose value did not come from the approved table. The module says
    // so where the function is defined.
    const source = readFileSync(join(REPO_ROOT, "lib/cashTender.ts"), "utf8");

    expect(source).toContain("cashDenominations(currency)");
  });

  it("keeps the approved tables byte-for-byte", () => {
    expect(CASH_DENOMINATIONS).toEqual({
      USD: [1, 5, 10, 20, 50, 100],
      CAD: [1, 2, 5, 10, 20, 50, 100],
      EUR: [1, 2, 5, 10, 20, 50, 100, 200],
      GBP: [1, 2, 5, 10, 20, 50],
    });
  });

  it("keeps its additive, refuse-rather-than-clamp behaviour unchanged", () => {
    const stacked = [20, 5].reduce(
      (digits, note) => applyTenderDenomination(digits, note).digits,
      EMPTY_TENDER_DIGITS,
    );

    expect(formatTenderDigits(stacked)).toBe("25.00");
    expect(applyTenderDenomination(MAX_DIGITS, 1)).toEqual({
      ok: false,
      refusal: "max_amount_exceeded",
      digits: MAX_DIGITS,
    });
  });
});

// ---------------------------------------------------------------------------
// 22. Purity
// ---------------------------------------------------------------------------

describe("purity", () => {
  it("mutates no argument", () => {
    const input: CashTenderBindingInput = { ...BINDING, checkoutRevision: 4 };
    const snapshot = JSON.stringify(input);

    buildCashTenderBinding(input);
    validateCashTender({ amountDueFixed: input.amountDueFixed, tenderDigits: input.tenderDigits });

    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("returns a new entry rather than editing the one it was given", () => {
    const digits = "1250";

    expect(appendTenderDigit(digits, "7").digits).toBe("12507");
    expect(digits).toBe("1250");
  });

  it("refuses in-place mutation of the shared denomination table", () => {
    // `readonly` is a compile-time claim only. A caller that sorted this array
    // in place would corrupt the table for every till in the process, so the
    // module freezes it and the attempt throws.
    const usd = cashDenominations("USD");

    expect(Object.isFrozen(usd)).toBe(true);
    expect(() => {
      (usd as number[]).push(500);
    }).toThrow();
    expect(() => {
      (usd as number[]).reverse();
    }).toThrow();
    expect(cashDenominations("USD")).toEqual([1, 5, 10, 20, 50, 100]);
  });

  it("refuses replacing a whole currency's entry", () => {
    expect(Object.isFrozen(CASH_DENOMINATIONS)).toBe(true);
    expect(() => {
      (CASH_DENOMINATIONS as Record<Currency, readonly number[]>).USD = [7];
    }).toThrow();
  });

  it("returns identical results when called repeatedly", () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(validateCashTender({ amountDueFixed: "19.99", tenderDigits: "2000" })).toEqual({
        status: "sufficient",
        change: "0.01",
      });
    }
  });

  it("touches no browser, network, clock or storage API", () => {
    const source = moduleCode();

    for (const banned of [
      "window",
      "document",
      "localStorage",
      "navigator",
      "fetch(",
      "supabase",
      "node:",
      "useState",
      "useEffect",
    ]) {
      expect(source).not.toContain(banned);
    }
  });

  it("decides nothing about a sale", () => {
    // This module reports whether a tender is enough. Submitting, authorising,
    // persisting and opening the drawer belong to the runtime.
    const source = moduleCode();

    for (const banned of ["complete_sale", "sale_request", "openCashDrawer", "rpc("]) {
      expect(source).not.toContain(banned);
    }
  });
});
