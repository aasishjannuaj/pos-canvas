// v1.3 CP-2C — the dollars-first entry rules and the Done decision.
//
// WHAT THIS SUITE IS EVIDENCE OF, AND WHY IT IS WHERE IT IS. This repository
// runs Vitest under `environment: "node"` with no DOM, no @testing-library and
// no browser provider, so a rendered CashTenderPad cannot be asserted here at
// all. Every CP-2C decision therefore lives in lib/cashTenderEntry.ts and is
// proven here against real inputs; the component is a shell, and what it is
// wired to is proven separately by the structural guard in
// components/runtime/cashTenderUx.guards.test.ts.
//
// NOTHING HERE RE-TESTS lib/cashTender.ts. Its own 1751-line suite is accepted
// and untouched. What this suite checks is that CP-2C reads a DOLLARS buffer,
// hands CP-1C canonical minor units, and never reaches a submission that CP-1C
// would not have blessed.

import { describe, expect, it } from "vitest";

import { calculateCartSummary, createCartItem } from "@/lib/cart";
import {
  cashDenominations,
  MAX_TENDER_DIGITS,
  MAX_TENDER_FIXED,
} from "@/lib/cashTender";
import {
  appendCashEntryDecimalPoint,
  appendCashEntryDigit,
  applyCashEntryDenomination,
  backspaceCashEntry,
  captureCashTenderBinding,
  CASH_TENDER_MESSAGES,
  cashEntryToTenderDigits,
  clearCashEntry,
  decideCashTenderSubmission,
  EMPTY_CASH_ENTRY,
  formatCashEntryAmount,
  cashTenderReceiptLines,
  isCashTenderStale,
  isZeroCashEntry,
  replaceCashEntry,
  MAX_CASH_ENTRY_WHOLE_DIGITS,
  type CashTenderContext,
  type CashTenderOutcome,
} from "@/lib/cashTenderEntry";

/** Types one character at a time, the way the pad does. */
function type(keys: string): string {
  let entry = EMPTY_CASH_ENTRY;

  for (const key of keys) {
    const result = key === "." ? appendCashEntryDecimalPoint(entry) : appendCashEntryDigit(entry, key);

    entry = result.entry;
  }

  return entry;
}

function context(overrides: Partial<CashTenderContext> = {}): CashTenderContext {
  return {
    checkoutSessionId: "checkout-1",
    cartIdentity: "cart-a",
    amountDueFixed: "20.00",
    checkoutRevision: 0,
    ...overrides,
  };
}

/** The ordinary case: a tender entered against an unchanged checkout. */
function decideFresh(entry: string, ctx: CashTenderContext = context()) {
  return decideCashTenderSubmission({
    entry,
    context: ctx,
    capturedBinding: captureCashTenderBinding(ctx, entry),
    submissionInFlight: false,
  });
}

// ---------------------------------------------------------------------------

describe("dollars-first entry (requirement 3)", () => {
  it("reads typing 40 as forty dollars, not forty cents", () => {
    const entry = type("40");

    expect(entry).toBe("40");
    expect(formatCashEntryAmount(entry)).toBe("40.00");
    expect(cashEntryToTenderDigits(entry)).toBe("4000");
  });

  it("reads a single digit as whole dollars", () => {
    expect(formatCashEntryAmount(type("7"))).toBe("7.00");
  });

  it("is the opposite of the accepted cents-first keypad, on purpose", () => {
    // CP-1C: 8, 7, 5 is 8.75. CP-2C: 8, 7, 5 is 875.00. Asserted so a future
    // change back to cents-first cannot pass silently.
    expect(formatCashEntryAmount(type("875"))).toBe("875.00");
  });

  it("accepts a decimal amount", () => {
    expect(formatCashEntryAmount(type("40.5"))).toBe("40.50");
    expect(formatCashEntryAmount(type("40.55"))).toBe("40.55");
  });

  it("treats a decimal point on an empty buffer as 0.", () => {
    const entry = appendCashEntryDecimalPoint(EMPTY_CASH_ENTRY);

    expect(entry).toEqual({ ok: true, entry: "0." });
    expect(formatCashEntryAmount(type(".75"))).toBe("0.75");
  });

  it("replaces a lone leading zero rather than stacking it", () => {
    expect(appendCashEntryDigit("0", "5")).toEqual({ ok: true, entry: "5" });
    expect(formatCashEntryAmount("5")).toBe("5.00");
  });

  it("keeps a zero that is on its way to a cents amount", () => {
    expect(type("0.75")).toBe("0.75");
    expect(formatCashEntryAmount("0.75")).toBe("0.75");
  });

  it("renders an untouched buffer as 0.00 without calling it zero", () => {
    expect(formatCashEntryAmount(EMPTY_CASH_ENTRY)).toBe("0.00");
    expect(isZeroCashEntry(EMPTY_CASH_ENTRY)).toBe(false);
  });
});

describe("entry refusals are reported, never silent", () => {
  it("refuses a third decimal place", () => {
    expect(appendCashEntryDigit("40.55", "9")).toEqual({
      ok: false,
      refusal: "too_many_decimals",
      entry: "40.55",
    });
  });

  it("refuses a second decimal point", () => {
    expect(appendCashEntryDecimalPoint("40.5")).toEqual({
      ok: false,
      refusal: "duplicate_decimal_point",
      entry: "40.5",
    });
  });

  it("refuses a non-digit", () => {
    for (const key of ["a", "-", "+", " ", ",", "", "12", "٧"]) {
      expect(appendCashEntryDigit("40", key).ok).toBe(false);
    }
  });

  it("refuses more whole digits than the server ceiling has", () => {
    const atLimit = "9".repeat(MAX_CASH_ENTRY_WHOLE_DIGITS);

    expect(MAX_CASH_ENTRY_WHOLE_DIGITS).toBe(MAX_TENDER_DIGITS - 2);
    expect(appendCashEntryDigit(atLimit, "9")).toEqual({
      ok: false,
      refusal: "max_input_reached",
      entry: atLimit,
    });
    // And that limit is exactly the documented ceiling, not a round number.
    expect(formatCashEntryAmount(`${atLimit}.99`)).toBe(MAX_TENDER_FIXED);
  });

  it("echoes a malformed string unchanged and never edits what it refused", () => {
    expect(appendCashEntryDigit("1.2.3", "4")).toEqual({
      ok: false,
      refusal: "invalid_character",
      entry: "1.2.3",
    });
  });

  it("returns empty for a value that was never a buffer", () => {
    for (const value of [40, null, undefined, [], {}, NaN, true]) {
      const result = appendCashEntryDigit(value as unknown as string, "5");

      expect(result.ok).toBe(false);
      expect(result.entry).toBe(EMPTY_CASH_ENTRY);
    }
  });
});

describe("physical keyboard entry (item 1)", () => {
  /** Types into a real input: each keystroke reports the WHOLE new value. */
  function keyboard(keys: string): string {
    let entry = EMPTY_CASH_ENTRY;

    for (const key of keys) {
      entry = replaceCashEntry(entry, entry + key).entry;
    }

    return entry;
  }

  it("a cashier typing 40 gets $40.00", () => {
    // THE REQUIREMENT, through the path a physical keyboard actually takes.
    expect(keyboard("40")).toBe("40");
    expect(formatCashEntryAmount(keyboard("40"))).toBe("40.00");
    expect(decideFresh(keyboard("40"), context({ amountDueFixed: "32.00" }))).toMatchObject({
      status: "submit",
      tenderedFixed: "40.00",
      changeFixed: "8.00",
    });
  });

  it("agrees with the on-screen keys, character for character", () => {
    // ONE RULE, TWO INPUT DEVICES. If these ever diverged, an amount could be
    // typed that no button would have produced.
    for (const keys of ["40", "7", "875", "40.5", "40.55", "0.75", "1234567890"]) {
      expect(keyboard(keys)).toBe(type(keys));
    }
  });

  it("accepts a decimal point and two decimals", () => {
    expect(keyboard("32.50")).toBe("32.50");
    expect(formatCashEntryAmount("32.5")).toBe("32.50");
  });

  it("reads a comma as the decimal point, for comma-decimal tills", () => {
    // lib/cashTender.ts supports EUR and GBP; refusing their decimal separator
    // would be a defect on those tills, not a safeguard.
    expect(replaceCashEntry(EMPTY_CASH_ENTRY, "40,50")).toEqual({ ok: true, entry: "40.50" });
    expect(replaceCashEntry(EMPTY_CASH_ENTRY, ",")).toEqual({ ok: true, entry: "0." });
    expect(formatCashEntryAmount(replaceCashEntry("", "40,5").entry)).toBe("40.50");
  });

  it("still refuses a thousands-grouped amount, so no digit is ever regrouped", () => {
    // "1,000" becomes "1.000" -- three decimals -- and is refused exactly as it
    // was before commas were read at all. It is never silently read as 1000.
    expect(replaceCashEntry("5", "1,000")).toEqual({
      ok: false,
      refusal: "invalid_character",
      entry: "5",
    });
    expect(replaceCashEntry("5", "1,000.00").ok).toBe(false);
  });

  it("snaps back to the previous buffer on a refusal, dropping no character", () => {
    // A controlled input re-renders with what comes back, so a rejected paste
    // must return the buffer UNCHANGED -- dropping one character out of a pasted
    // string would leave a different number than the cashier pasted.
    for (const pasted of ["40abc", "-40", "1.2.3", "4e3", "40 ", " 40", "$40", "40.555", "٤٠"]) {
      expect(replaceCashEntry("32.50", pasted)).toEqual({
        ok: false,
        refusal: "invalid_character",
        entry: "32.50",
      });
    }
  });

  it("accepts a paste of a well-formed amount", () => {
    expect(replaceCashEntry(EMPTY_CASH_ENTRY, "40.00")).toEqual({ ok: true, entry: "40.00" });
    expect(replaceCashEntry("1", "32.5")).toEqual({ ok: true, entry: "32.5" });
  });

  it("canonicalises a leading zero the cashier typed over", () => {
    expect(replaceCashEntry("0", "05")).toEqual({ ok: true, entry: "5" });
    expect(replaceCashEntry("0", "007")).toEqual({ ok: true, entry: "7" });
    // But a zero on its way to a cents amount survives.
    expect(replaceCashEntry("", "0")).toEqual({ ok: true, entry: "0" });
    expect(replaceCashEntry("0", "0.")).toEqual({ ok: true, entry: "0." });
    expect(replaceCashEntry("0.", "0.75")).toEqual({ ok: true, entry: "0.75" });
  });

  it("handles deletion, selection overwrite and clearing to empty", () => {
    expect(replaceCashEntry("40.50", "40.5")).toEqual({ ok: true, entry: "40.5" });
    expect(replaceCashEntry("40.50", "")).toEqual({ ok: true, entry: EMPTY_CASH_ENTRY });
    // A selection overwritten wholesale by a new amount.
    expect(replaceCashEntry("40.50", "9")).toEqual({ ok: true, entry: "9" });
  });

  it("enforces the same whole-digit ceiling the buttons do", () => {
    const atLimit = "9".repeat(MAX_CASH_ENTRY_WHOLE_DIGITS);

    expect(replaceCashEntry(atLimit, `${atLimit}9`)).toEqual({
      ok: false,
      refusal: "max_input_reached",
      entry: atLimit,
    });
    // Including by paste, which is the route the buttons cannot be used for.
    expect(replaceCashEntry("5", "1".repeat(MAX_CASH_ENTRY_WHOLE_DIGITS + 1))).toMatchObject({
      ok: false,
      refusal: "max_input_reached",
    });
  });

  it("cannot type an amount the Done gate would not have read", () => {
    // Everything replaceCashEntry accepts is a buffer cashEntryToTenderDigits
    // can canonicalise, so a typed entry can never reach the gate as malformed.
    const candidates = [
      "", "0", "0.", "0.0", "0.00", "4", "40", "40.", "40.5", "40.55", "0.75",
      "1234567890", "9999999999.99",
    ];

    for (const candidate of candidates) {
      const accepted = replaceCashEntry(EMPTY_CASH_ENTRY, candidate);

      expect(accepted.ok).toBe(true);
      expect(cashEntryToTenderDigits(accepted.entry)).not.toBeNull();
      expect(decideFresh(accepted.entry)).not.toMatchObject({ refusal: "malformed" });
    }
  });

  it("survives a hostile replacement without throwing", () => {
    for (const value of [undefined, null, 0, 40, NaN, true, [], {}, Symbol("s"), () => {}]) {
      expect(() => replaceCashEntry("40", value as unknown as string)).not.toThrow();
      expect(replaceCashEntry("40", value as unknown as string)).toEqual({
        ok: false,
        refusal: "invalid_character",
        entry: "40",
      });
    }

    // A current buffer that was never a buffer falls back to empty rather than
    // echoing a number or an array into a field typed string.
    expect(replaceCashEntry(40 as unknown as string, "x").entry).toBe(EMPTY_CASH_ENTRY);
  });

  it("is what a barcode-shaped burst does, stated honestly", () => {
    // A wedge scanner typing into this field is the one residual risk item 1
    // does not remove, and the behavior is pinned here rather than left to be
    // discovered. A long code is REFUSED and the buffer is untouched...
    expect(replaceCashEntry("40", "40012345678905")).toMatchObject({
      ok: false,
      refusal: "max_input_reached",
      entry: "40",
    });

    // ...but a SHORT all-digit code is indistinguishable from a typed amount
    // and is accepted. Nothing in a pure function can tell the two apart; see
    // the report's residual-risk section.
    expect(replaceCashEntry(EMPTY_CASH_ENTRY, "12345678")).toEqual({
      ok: true,
      entry: "12345678",
    });
  });
});

describe("backspace and clear", () => {
  it("removes one keystroke at a time, including the point", () => {
    expect(backspaceCashEntry("40.5")).toEqual({ ok: true, entry: "40." });
    expect(backspaceCashEntry("40.")).toEqual({ ok: true, entry: "40" });
    expect(backspaceCashEntry("40")).toEqual({ ok: true, entry: "4" });
    expect(backspaceCashEntry("4")).toEqual({ ok: true, entry: EMPTY_CASH_ENTRY });
    expect(backspaceCashEntry(EMPTY_CASH_ENTRY)).toEqual({ ok: true, entry: EMPTY_CASH_ENTRY });
  });

  it("clears to nothing entered, which is not zero", () => {
    expect(clearCashEntry()).toEqual({ ok: true, entry: EMPTY_CASH_ENTRY });
    expect(decideFresh(clearCashEntry().entry).status).toBe("refused");
    expect(decideFresh(EMPTY_CASH_ENTRY)).toMatchObject({ refusal: "missing" });
  });
});

describe("additive quick denominations (requirement 4)", () => {
  it("adds $20 twice to reach $40", () => {
    const once = applyCashEntryDenomination(EMPTY_CASH_ENTRY, 20);
    const twice = applyCashEntryDenomination(once.entry, 20);

    expect(once.entry).toBe("20.00");
    expect(twice).toEqual({ ok: true, entry: "40.00" });
    expect(formatCashEntryAmount(twice.entry)).toBe("40.00");
  });

  it("adds different notes together rather than replacing", () => {
    const twenty = applyCashEntryDenomination(EMPTY_CASH_ENTRY, 20);
    const plusFive = applyCashEntryDenomination(twenty.entry, 5);

    expect(plusFive.entry).toBe("25.00");
  });

  it("adds a note to a typed amount", () => {
    expect(applyCashEntryDenomination(type("40"), 20).entry).toBe("60.00");
  });

  it("canonicalises a half-typed buffer when a note is added", () => {
    expect(applyCashEntryDenomination("40.", 20)).toEqual({ ok: true, entry: "60.00" });
    expect(applyCashEntryDenomination("0.75", 1)).toEqual({ ok: true, entry: "1.75" });
  });

  it("refuses rather than clamps when the sum would pass the ceiling", () => {
    const atCeiling = `${"9".repeat(MAX_CASH_ENTRY_WHOLE_DIGITS)}.99`;

    expect(applyCashEntryDenomination(atCeiling, 1)).toEqual({
      ok: false,
      refusal: "max_amount_exceeded",
      entry: atCeiling,
    });
  });

  it("refuses a denomination that is not a positive whole number", () => {
    for (const value of [0, -20, 1.5, NaN, Infinity, "20"]) {
      expect(applyCashEntryDenomination("40", value as unknown as number)).toEqual({
        ok: false,
        refusal: "invalid_character",
        entry: "40",
      });
    }
  });

  it("every denomination the pad may offer is addable", () => {
    // CP-1C's own obligation on the caller: buttons come exclusively from
    // cashDenominations(currency). Proven addable for every currency so a new
    // one cannot ship with a note this layer refuses.
    for (const currency of ["USD", "CAD", "EUR", "GBP"] as const) {
      for (const note of cashDenominations(currency)) {
        expect(applyCashEntryDenomination(EMPTY_CASH_ENTRY, note).ok).toBe(true);
      }
    }
  });
});

describe("change due (requirement 5)", () => {
  it("reports change for an overpayment", () => {
    expect(decideFresh(type("50"))).toMatchObject({
      status: "submit",
      tenderedFixed: "50.00",
      changeFixed: "30.00",
    });
  });

  it("reports no change for an exact tender", () => {
    expect(decideFresh(type("20"))).toMatchObject({
      status: "submit",
      tenderedFixed: "20.00",
      changeFixed: "0.00",
    });
  });

  it("is exact where floating point is not", () => {
    // The regression lib/money.ts exists for: 20.00 - 19.99 must be 0.01, not
    // 0.010000000000001776.
    expect(decideFresh(type("20"), context({ amountDueFixed: "19.99" }))).toMatchObject({
      status: "submit",
      changeFixed: "0.01",
    });
    expect(decideFresh(type("100"), context({ amountDueFixed: "0.07" }))).toMatchObject({
      changeFixed: "99.93",
    });
  });

  it("gives no change figure on any refusal", () => {
    const refused = decideFresh(type("5"));

    expect(refused.status).toBe("refused");
    expect(refused).not.toHaveProperty("changeFixed");
    expect(refused).not.toHaveProperty("tenderedFixed");
  });
});

describe("rejects underpayment and invalid values (requirement 6)", () => {
  it("refuses an underpayment and says how far short", () => {
    expect(decideFresh(type("15"), context({ amountDueFixed: "20.00" }))).toEqual({
      status: "refused",
      refusal: "insufficient",
      message: CASH_TENDER_MESSAGES.insufficient,
      shortfall: "5.00",
    });
  });

  it("refuses an underpayment by one cent", () => {
    expect(decideFresh(type("19.99"), context({ amountDueFixed: "20.00" }))).toMatchObject({
      refusal: "insufficient",
      shortfall: "0.01",
    });
  });

  it("refuses nothing entered as missing, not as zero", () => {
    expect(decideFresh(EMPTY_CASH_ENTRY)).toEqual({
      status: "refused",
      refusal: "missing",
      message: CASH_TENDER_MESSAGES.missing,
    });
  });

  it("refuses a typed zero as not positive", () => {
    for (const entry of ["0", "0.", "0.0", "0.00"]) {
      expect(isZeroCashEntry(entry)).toBe(true);
      expect(decideFresh(entry)).toMatchObject({ refusal: "not_positive" });
    }
  });

  it("refuses a buffer it cannot read", () => {
    for (const entry of ["1.2.3", "-5", "abc", "5e3", " 5", "5 ", "1,000"]) {
      expect(decideFresh(entry)).toMatchObject({ refusal: "malformed" });
    }
  });

  it("cannot express a tender above the ceiling at all, and says so honestly", () => {
    // STATED PLAINLY BECAUSE THE ALTERNATIVE WOULD BE A MISLEADING TEST.
    // `excessive` is a member of CP-1C's validation union and this module
    // handles it, but it is UNREACHABLE through this pad, and no assertion here
    // pretends otherwise. Three facts make it unreachable, each asserted below:
    //
    //   1. the pad stops at 10 whole digits, so the largest buffer it can build
    //      is 9999999999.99, which IS MAX_TENDER_FIXED -- equal to the ceiling,
    //      not above it, so compareMoney(received, max) > 0 is never true;
    //   2. adding a note to that buffer is refused rather than clamped;
    //   3. a longer buffer can only come from a programmer error, and it fails
    //      closed as `malformed` rather than being validated.
    const atCeiling = `${"9".repeat(MAX_CASH_ENTRY_WHOLE_DIGITS)}.99`;

    expect(formatCashEntryAmount(atCeiling)).toBe(MAX_TENDER_FIXED);
    expect(decideFresh(atCeiling, context({ amountDueFixed: "20.00" }))).toMatchObject({
      status: "submit",
      tenderedFixed: MAX_TENDER_FIXED,
    });

    expect(applyCashEntryDenomination(atCeiling, 1).ok).toBe(false);
    expect(appendCashEntryDigit("9".repeat(MAX_CASH_ENTRY_WHOLE_DIGITS), "9").ok).toBe(false);

    // Over-ceiling buffers are well-SHAPED but not bindable, so they are
    // refused -- never submitted, and never silently truncated.
    for (const entry of ["99999999999.99", "9".repeat(13), "9".repeat(40)]) {
      expect(decideFresh(entry)).toMatchObject({ refusal: "malformed" });
    }
  });

  it("refuses a total that is not canonical money", () => {
    for (const amountDueFixed of ["0012.50", "12.5", "12", "-12.50", "", "abc"]) {
      expect(decideFresh(type("50"), context({ amountDueFixed }))).toMatchObject({
        refusal: "malformed",
      });
    }
  });

  it("refuses a context the runtime should never have produced", () => {
    expect(decideFresh(type("50"), context({ checkoutSessionId: "" }))).toMatchObject({
      refusal: "malformed",
    });
    expect(decideFresh(type("50"), context({ cartIdentity: "" }))).toMatchObject({
      refusal: "malformed",
    });
    for (const checkoutRevision of [-1, 1.5, NaN, Infinity, Number.MAX_VALUE]) {
      expect(decideFresh(type("50"), context({ checkoutRevision }))).toMatchObject({
        refusal: "malformed",
      });
    }
  });
});

describe("stale checkout totals (requirement 6)", () => {
  const typed = type("50");

  function decideAgainst(live: CashTenderContext, captured: CashTenderContext) {
    return decideCashTenderSubmission({
      entry: typed,
      context: live,
      capturedBinding: captureCashTenderBinding(captured, typed),
      submissionInFlight: false,
    });
  }

  it("refuses when the total went up after the cash was entered", () => {
    expect(decideAgainst(context({ amountDueFixed: "25.00" }), context())).toEqual({
      status: "refused",
      refusal: "stale_total",
      message: CASH_TENDER_MESSAGES.stale_total,
    });
  });

  it("refuses when the total went DOWN after the cash was entered", () => {
    // $50 against a $20 total is sufficient, so nothing in validation would
    // object. Paying out change for a total the cashier never saw is the
    // defect; the refusal is what prevents it.
    expect(decideAgainst(context({ amountDueFixed: "15.00" }), context())).toMatchObject({
      refusal: "stale_total",
    });
  });

  it("reports the moved total rather than an underpayment", () => {
    // $50 tendered, total jumps to $80: both `insufficient` and `stale_total`
    // are true. The cashier is told what actually happened.
    expect(decideAgainst(context({ amountDueFixed: "80.00" }), context())).toMatchObject({
      refusal: "stale_total",
    });
  });

  it("refuses when the cart changed but the total did not", () => {
    expect(decideAgainst(context({ cartIdentity: "cart-b" }), context())).toMatchObject({
      refusal: "stale_total",
    });
  });

  it("refuses a cart that went A -> B -> A", () => {
    // Every other bound field has returned to its earlier value. Only the
    // revision counter distinguishes them, which is precisely the HIGH finding
    // CP-1C closed by making it required.
    expect(decideAgainst(context({ checkoutRevision: 2 }), context({ checkoutRevision: 0 })))
      .toMatchObject({ refusal: "stale_total" });
  });

  it("refuses a tender carried across a close and reopen", () => {
    expect(decideAgainst(context({ checkoutSessionId: "checkout-2" }), context()))
      .toMatchObject({ refusal: "stale_total" });
  });

  it("refuses when there is no capture to compare against", () => {
    expect(
      decideCashTenderSubmission({
        entry: typed,
        context: context(),
        capturedBinding: null,
        submissionInFlight: false,
      })
    ).toMatchObject({ refusal: "stale_total" });
  });

  it("does not tell an untouched keypad that the total changed", () => {
    expect(
      decideCashTenderSubmission({
        entry: EMPTY_CASH_ENTRY,
        context: context(),
        capturedBinding: null,
        submissionInFlight: false,
      })
    ).toMatchObject({ refusal: "missing" });
  });

  it("accepts an unchanged checkout", () => {
    expect(decideAgainst(context(), context())).toMatchObject({ status: "submit" });
  });

  it("treats an absent binding on either side as stale", () => {
    expect(isCashTenderStale(null, "x")).toBe(true);
    expect(isCashTenderStale("x", null)).toBe(true);
    expect(isCashTenderStale(null, null)).toBe(true);
    expect(isCashTenderStale("x", "x")).toBe(false);
    expect(isCashTenderStale("x", "y")).toBe(true);
  });

  it("builds no binding for a context or buffer it cannot read", () => {
    expect(captureCashTenderBinding(context({ amountDueFixed: "12.5" }), "50")).toBeNull();
    expect(captureCashTenderBinding(context({ checkoutSessionId: " x " }), "50")).toBeNull();
    expect(captureCashTenderBinding(context(), "1.2.3")).toBeNull();
    expect(captureCashTenderBinding(null as unknown as CashTenderContext, "50")).toBeNull();
  });

  it("binds an untouched keypad, so the first keystroke has something to differ from", () => {
    expect(captureCashTenderBinding(context(), EMPTY_CASH_ENTRY)).not.toBeNull();
  });
});

describe("single submission (requirement 8)", () => {
  it("refuses while a completion is already under way", () => {
    expect(
      decideCashTenderSubmission({
        entry: type("50"),
        context: context(),
        capturedBinding: captureCashTenderBinding(context(), type("50")),
        submissionInFlight: true,
      })
    ).toEqual({
      status: "refused",
      refusal: "submission_in_progress",
      message: CASH_TENDER_MESSAGES.submission_in_progress,
    });
  });

  it("checks in-flight before anything else, so a repeat press re-enters nothing", () => {
    // A perfectly valid tender, a stale one, a malformed one and an empty one
    // all report the same refusal while a submission is outstanding: the second
    // press never reaches validation, staleness or the binding at all.
    for (const entry of [type("50"), type("1"), "1.2.3", EMPTY_CASH_ENTRY]) {
      expect(
        decideCashTenderSubmission({
          entry,
          context: context({ amountDueFixed: "25.00" }),
          capturedBinding: captureCashTenderBinding(context(), entry),
          submissionInFlight: true,
        })
      ).toMatchObject({ refusal: "submission_in_progress" });
    }
  });

  it("the same tender decides identically every time it is asked", () => {
    // The decision is a pure function of the live context, so a repeated press
    // cannot drift into a different answer — the duplicate-submission defence
    // is the in-flight flag, never a one-shot side effect inside this function.
    const entry = type("50");
    const captured = captureCashTenderBinding(context(), entry);
    const first = decideCashTenderSubmission({
      entry,
      context: context(),
      capturedBinding: captured,
      submissionInFlight: false,
    });
    const second = decideCashTenderSubmission({
      entry,
      context: context(),
      capturedBinding: captured,
      submissionInFlight: false,
    });

    expect(second).toEqual(first);
  });
});

describe("nothing in this module throws", () => {
  const hostile = [
    undefined,
    null,
    NaN,
    Infinity,
    0,
    40,
    -1,
    true,
    "",
    ".",
    "..",
    "1.2.3",
    "-5",
    "5e3",
    "٧",
    "9".repeat(40),
    [],
    {},
    () => {},
    Symbol("s"),
  ];

  it("survives hostile buffers on every editing function", () => {
    for (const value of hostile) {
      const entry = value as unknown as string;

      expect(() => appendCashEntryDigit(entry, "5")).not.toThrow();
      expect(() => appendCashEntryDigit("40", entry)).not.toThrow();
      expect(() => appendCashEntryDecimalPoint(entry)).not.toThrow();
      expect(() => backspaceCashEntry(entry)).not.toThrow();
      expect(() => applyCashEntryDenomination(entry, 20)).not.toThrow();
      expect(() => applyCashEntryDenomination("40", entry as unknown as number)).not.toThrow();
      expect(() => formatCashEntryAmount(entry)).not.toThrow();
      expect(() => cashEntryToTenderDigits(entry)).not.toThrow();
      expect(() => isZeroCashEntry(entry)).not.toThrow();
    }
  });

  it("survives hostile contexts and buffers at the Done decision", () => {
    for (const value of hostile) {
      expect(() =>
        decideCashTenderSubmission({
          entry: value as unknown as string,
          context: context(),
          capturedBinding: null,
          submissionInFlight: false,
        })
      ).not.toThrow();

      expect(() =>
        decideCashTenderSubmission({
          entry: "50",
          context: value as unknown as CashTenderContext,
          capturedBinding: "x",
          submissionInFlight: false,
        })
      ).not.toThrow();

      expect(() => captureCashTenderBinding(value as unknown as CashTenderContext, "50")).not.toThrow();
    }
  });

  it("never returns submit for a buffer or context it could not read", () => {
    for (const value of hostile) {
      const byEntry = decideCashTenderSubmission({
        entry: value as unknown as string,
        context: context(),
        capturedBinding: "x",
        submissionInFlight: false,
      });
      const byContext = decideCashTenderSubmission({
        entry: "50",
        context: value as unknown as CashTenderContext,
        capturedBinding: "x",
        submissionInFlight: false,
      });

      expect(byEntry.status).toBe("refused");
      expect(byContext.status).toBe("refused");
    }
  });
});

describe("every refusal has words a cashier can act on", () => {
  it("states a message for each refusal, and the messages are frozen", () => {
    for (const [refusal, message] of Object.entries(CASH_TENDER_MESSAGES)) {
      expect(message.length).toBeGreaterThan(10);
      expect(message.endsWith(".")).toBe(true);
      expect(message).not.toMatch(/undefined|null|NaN|\bdigits\b|binding|revision/i);
      expect(refusal).not.toBe("");
    }

    expect(Object.isFrozen(CASH_TENDER_MESSAGES)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The handoff to the checkout that already exists
// ---------------------------------------------------------------------------

describe("the real checkout total is readable by the pad (requirements 2 and 9)", () => {
  const NO_TAX = { enabled: false, rate: 0, pricesIncludeTax: false, showTaxSeparately: false };
  // 8.875 is a PERCENTAGE, not a fraction -- normalizeTaxRate caps the value at
  // 100, which is what settles the convention. Verified against the real
  // calculateCartSummary output rather than assumed: 9.99 + 0.89 = 10.88.
  const TAX = { enabled: true, rate: 8.875, pricesIncludeTax: false, showTaxSeparately: true };

  function menuItem(id: string, price: number) {
    return { id, name: id, price, category: "c", trackInventory: false, stockQuantity: 0 };
  }

  it("accepts the total calculateCartSummary actually produces", () => {
    // NOT A FIXTURE TOTAL. PosRuntime passes cartSummary.total straight through
    // as amountDueFixed, and this module refuses any total that is not
    // canonical money — so if the two disagreed about spelling, every cash sale
    // would be refused as `malformed`. That is what this proves, through the
    // real cart and summary functions rather than a hand-written string.
    const cart = [createCartItem(menuItem("a", 12.5), []), createCartItem(menuItem("b", 7.5), [])];
    const summary = calculateCartSummary(cart, NO_TAX, 0);

    expect(summary.total).toBe("20.00");
    expect(decideFresh(type("50"), context({ amountDueFixed: summary.total }))).toMatchObject({
      status: "submit",
      changeFixed: "30.00",
    });
  });

  it("accepts a taxed total whose cents are not round", () => {
    const cart = [createCartItem(menuItem("a", 9.99), [])];
    const summary = calculateCartSummary(cart, TAX, 0);

    // The exact figure the existing checkout screen shows, read back here.
    expect(summary.total).toBe("10.88");
    expect(summary.taxAmount).toBe("0.89");
    expect(decideFresh(type("20"), context({ amountDueFixed: summary.total }))).toMatchObject({
      status: "submit",
    });
  });

  it("refuses a tender one cent short of a taxed total", () => {
    const cart = [createCartItem(menuItem("a", 9.99), [])];
    const summary = calculateCartSummary(cart, TAX, 0);
    const oneCentShort = applyCashEntryDenomination(EMPTY_CASH_ENTRY, 10);

    // 10.00 against 10.88 -- real figures, not a contrived pair.
    expect(summary.total).toBe("10.88");
    expect(decideFresh(oneCentShort.entry, context({ amountDueFixed: summary.total }))).toEqual({
      status: "refused",
      refusal: "insufficient",
      message: CASH_TENDER_MESSAGES.insufficient,
      shortfall: "0.88",
    });
  });

  it("accepts an empty cart's total without inventing a sale", () => {
    // An empty cart totals 0.00, which is canonical, so the pad reads it. The
    // sale is refused by completeSale's own `cart.length === 0` guard, which
    // this module neither duplicates nor replaces.
    const summary = calculateCartSummary([], NO_TAX, 0);

    expect(summary.total).toBe("0.00");
    expect(decideFresh(type("5"), context({ amountDueFixed: summary.total }))).toMatchObject({
      status: "submit",
      changeFixed: "5.00",
    });
  });
});

// ---------------------------------------------------------------------------
// The receipt lines
// ---------------------------------------------------------------------------

describe("cash tendered and change due on the receipt (requirement 11)", () => {
  const outcome = { tenderedFixed: "50.00", changeFixed: "30.00" };
  const TOTAL = "20.00";

  it("prints both figures for a cash sale that reconciles", () => {
    expect(
      cashTenderReceiptLines({ paymentMethod: "cash", outcome, receiptTotalFixed: TOTAL })
    ).toEqual(outcome);
  });

  it("prints nothing for a card sale, whatever it is handed", () => {
    // A card sale has no tender. An outcome arriving beside one is a leak from
    // an earlier cash sale, not a figure to print.
    expect(
      cashTenderReceiptLines({ paymentMethod: "card", outcome, receiptTotalFixed: TOTAL })
    ).toBeNull();
  });

  it("prints nothing when there is no tender in hand", () => {
    expect(
      cashTenderReceiptLines({ paymentMethod: "cash", outcome: null, receiptTotalFixed: TOTAL })
    ).toBeNull();
    expect(
      cashTenderReceiptLines({ paymentMethod: "cash", outcome: undefined, receiptTotalFixed: TOTAL })
    ).toBeNull();
  });

  it("prints nothing rather than a figure that did not round-trip through money", () => {
    // "0050.00" and "50.5" are second spellings; a receipt is the customer's
    // copy of what happened, and a number printed because it could not be read
    // would be a claim about money that was never checked.
    for (const bad of ["0050.00", "50.5", "50", "-50.00", "", "abc", "1e3"]) {
      expect(
        cashTenderReceiptLines({
          paymentMethod: "cash",
          outcome: { ...outcome, tenderedFixed: bad },
          receiptTotalFixed: TOTAL,
        })
      ).toBeNull();
      expect(
        cashTenderReceiptLines({
          paymentMethod: "cash",
          outcome: { ...outcome, changeFixed: bad },
          receiptTotalFixed: TOTAL,
        })
      ).toBeNull();
      expect(
        cashTenderReceiptLines({ paymentMethod: "cash", outcome, receiptTotalFixed: bad })
      ).toBeNull();
    }
  });

  it("prints a zero change line for an exact tender", () => {
    // Exact cash is not "no tender": the receipt should still say what was
    // handed over, with no change due.
    expect(
      cashTenderReceiptLines({
        paymentMethod: "cash",
        outcome: { tenderedFixed: "20.00", changeFixed: "0.00" },
        receiptTotalFixed: "20.00",
      })
    ).toEqual({ tenderedFixed: "20.00", changeFixed: "0.00" });
  });

  it("is what a real decision produces, unaltered", () => {
    // The two figures the receipt prints are exactly the two the Done decision
    // returned -- nothing recomputes them on the way to paper.
    const decision = decideFresh(type("50"), context({ amountDueFixed: TOTAL }));

    expect(decision.status).toBe("submit");

    if (decision.status !== "submit") return;

    expect(
      cashTenderReceiptLines({
        paymentMethod: "cash",
        outcome: {
          tenderedFixed: decision.tenderedFixed,
          changeFixed: decision.changeFixed,
        },
        receiptTotalFixed: TOTAL,
      })
    ).toEqual({ tenderedFixed: "50.00", changeFixed: "30.00" });
  });

  it("survives a hostile outcome without throwing", () => {
    for (const value of [null, undefined, 0, "x", [], {}, NaN, true]) {
      const call = () =>
        cashTenderReceiptLines({
          paymentMethod: "cash",
          outcome: value as unknown as CashTenderOutcome,
          receiptTotalFixed: TOTAL,
        });

      expect(call).not.toThrow();
      expect(call()).toBeNull();
    }

    expect(
      cashTenderReceiptLines(null as unknown as Parameters<typeof cashTenderReceiptLines>[0])
    ).toBeNull();
  });
});

describe("the receipt lines reconcile against the receipt's own total (item 2)", () => {
  // THE DIVERGENCE THIS GUARDS AGAINST IS REAL, NOT HYPOTHETICAL. The change
  // was computed on the device against cartSummary.total when Done was pressed;
  // the authoritative total is derived independently by the server from the
  // authorized configuration. Nothing makes those two the same number.
  const outcome = { tenderedFixed: "40.00", changeFixed: "8.00" };

  it("prints both lines when tendered - change equals the printed total", () => {
    expect(
      cashTenderReceiptLines({ paymentMethod: "cash", outcome, receiptTotalFixed: "32.00" })
    ).toEqual(outcome);
  });

  it("prints NOTHING when the authoritative total came back higher", () => {
    // 40.00 - 8.00 is 32.00, but this receipt says 35.00. Printing both lines
    // would put three mutually contradictory money figures on one receipt.
    expect(
      cashTenderReceiptLines({ paymentMethod: "cash", outcome, receiptTotalFixed: "35.00" })
    ).toBeNull();
  });

  it("prints NOTHING when the authoritative total came back lower", () => {
    expect(
      cashTenderReceiptLines({ paymentMethod: "cash", outcome, receiptTotalFixed: "30.00" })
    ).toBeNull();
  });

  it("catches a one-cent divergence", () => {
    // The check is exact bigint arithmetic through lib/money.ts, so the
    // smallest possible disagreement is caught rather than rounded away.
    expect(
      cashTenderReceiptLines({ paymentMethod: "cash", outcome, receiptTotalFixed: "32.01" })
    ).toBeNull();
    expect(
      cashTenderReceiptLines({ paymentMethod: "cash", outcome, receiptTotalFixed: "31.99" })
    ).toBeNull();
  });

  it("never recomputes the change from the printed total", () => {
    // A Change Due recalculated here would be a figure that never crossed the
    // counter, and the drawer would then disagree with the receipt. The only
    // two outcomes are "the figures the cashier used" or "nothing".
    const mismatched = cashTenderReceiptLines({
      paymentMethod: "cash",
      outcome,
      receiptTotalFixed: "35.00",
    });

    expect(mismatched).toBeNull();
    expect(mismatched).not.toEqual({ tenderedFixed: "40.00", changeFixed: "5.00" });
  });

  it("holds for every decision the pad can produce, against its own total", () => {
    // Round trip: decide, then print. A decision printed against the total it
    // was decided from always reconciles -- so the check never suppresses a
    // correct pair, which is the other half of the property.
    for (const [due, tendered] of [
      ["32.00", "40"],
      ["19.99", "20"],
      ["0.07", "100"],
      ["10.88", "10.88"],
      ["12.34", "12.35"],
    ] as const) {
      const decision = decideFresh(type(tendered), context({ amountDueFixed: due }));

      expect(decision.status).toBe("submit");

      if (decision.status !== "submit") continue;

      expect(
        cashTenderReceiptLines({
          paymentMethod: "cash",
          outcome: {
            tenderedFixed: decision.tenderedFixed,
            changeFixed: decision.changeFixed,
          },
          receiptTotalFixed: due,
        })
      ).toEqual({ tenderedFixed: decision.tenderedFixed, changeFixed: decision.changeFixed });
    }
  });
});

// ---------------------------------------------------------------------------
// The host protocol, as a sequence
// ---------------------------------------------------------------------------

describe("the protocol PosRuntime implements, walked end to end", () => {
  /**
   * A stand-in for PosRuntime's own state, implementing exactly the protocol
   * the component does and nothing more: capture on every entry change, advance
   * the revision on every checkout mutation, decide at render with
   * `submissionInFlight: false`, and decide at the press with the live reading.
   *
   * WHAT THIS IS AND IS NOT. It is not a rendered component and does not claim
   * to be — there is no DOM here. It is the SEQUENCE the component drives, which
   * per-function tests cannot show: that typing, then a cart change, then Done
   * produces a refusal rather than a sale. That the component really drives this
   * sequence is asserted separately, at the source level, in
   * components/runtime/cashTenderUx.guards.test.ts.
   */
  function host(amountDueFixed: string) {
    let episode = 1;
    let revision = 0;
    let cart = "cart-a";
    let due = amountDueFixed;
    let entry = EMPTY_CASH_ENTRY;
    let captured: string | null = null;
    let inFlight = false;
    const completed: CashTenderOutcome[] = [];

    const live = (): CashTenderContext => ({
      checkoutSessionId: `checkout-${episode}`,
      cartIdentity: cart,
      amountDueFixed: due,
      checkoutRevision: revision,
    });

    return {
      completed,
      /** CashTenderPad's onEntryChange -> PosRuntime's changeCashEntry. */
      change(next: CashEntryResultLike) {
        entry = next.entry;
        captured = captureCashTenderBinding(live(), entry);
      },
      /** Any cart mutator -> bumpCheckoutRevision. */
      mutateCart(nextCart: string, nextDue: string) {
        revision += 1;
        cart = nextCart;
        due = nextDue;
      },
      /** closeCheckout then openCheckout -> a new episode, tender discarded. */
      reopen() {
        episode += 1;
        entry = EMPTY_CASH_ENTRY;
        captured = null;
        inFlight = false;
      },
      /** What the pad renders. */
      render() {
        return decideCashTenderSubmission({
          entry,
          context: live(),
          capturedBinding: captured,
          submissionInFlight: false,
        });
      },
      /** PosRuntime's completeCashSale, including the in-flight latch. */
      press() {
        const decision = decideCashTenderSubmission({
          entry,
          context: live(),
          capturedBinding: captured,
          submissionInFlight: inFlight,
        });

        if (decision.status === "submit") {
          inFlight = true;
          completed.push({
            tenderedFixed: decision.tenderedFixed,
            changeFixed: decision.changeFixed,
          });
        }

        return decision;
      },
      typed: () => entry,
    };
  }

  type CashEntryResultLike = { entry: string };

  it("takes a $50 note for a $20 sale and hands back $30", () => {
    const till = host("20.00");

    till.change(appendCashEntryDigit(EMPTY_CASH_ENTRY, "5"));
    till.change(appendCashEntryDigit(till.typed(), "0"));

    expect(till.typed()).toBe("50");
    expect(till.render()).toMatchObject({ status: "submit", changeFixed: "30.00" });
    expect(till.press()).toMatchObject({ status: "submit" });
    expect(till.completed).toEqual([{ tenderedFixed: "50.00", changeFixed: "30.00" }]);
  });

  it("takes two $20 notes for a $35 sale and hands back $5", () => {
    const till = host("35.00");

    till.change(applyCashEntryDenomination(EMPTY_CASH_ENTRY, 20));
    expect(till.render()).toMatchObject({ refusal: "insufficient", shortfall: "15.00" });

    till.change(applyCashEntryDenomination(till.typed(), 20));
    expect(till.typed()).toBe("40.00");
    expect(till.render()).toMatchObject({ status: "submit", changeFixed: "5.00" });
    expect(till.press().status).toBe("submit");
  });

  it("refuses the sale when the cart changed after the cash was entered", () => {
    const till = host("20.00");

    till.change(applyCashEntryDenomination(EMPTY_CASH_ENTRY, 50));
    expect(till.render()).toMatchObject({ status: "submit", changeFixed: "30.00" });

    // Another item is scanned while the pad is open.
    till.mutateCart("cart-b", "25.00");

    expect(till.render()).toMatchObject({ refusal: "stale_total" });
    expect(till.press()).toMatchObject({ refusal: "stale_total" });
    expect(till.completed).toEqual([]);
  });

  it("refuses the sale when the cart got CHEAPER after the cash was entered", () => {
    const till = host("20.00");

    till.change(applyCashEntryDenomination(EMPTY_CASH_ENTRY, 20));
    expect(till.render().status).toBe("submit");

    // A line is removed. $20 still covers $15, so nothing in validation would
    // object -- and $5 of change would be handed over for a total the cashier
    // never saw. The refusal is what prevents it.
    till.mutateCart("cart-c", "15.00");

    expect(till.press()).toMatchObject({ refusal: "stale_total" });
    expect(till.completed).toEqual([]);
  });

  it("accepts the re-entered tender once the cashier types it again", () => {
    const till = host("20.00");

    till.change(applyCashEntryDenomination(EMPTY_CASH_ENTRY, 50));
    till.mutateCart("cart-b", "25.00");
    expect(till.press()).toMatchObject({ refusal: "stale_total" });

    // Re-entered against the total now on screen. A refusal is not a dead end.
    till.change(clearCashEntry());
    till.change(applyCashEntryDenomination(EMPTY_CASH_ENTRY, 50));

    expect(till.render()).toMatchObject({ status: "submit", changeFixed: "25.00" });
    expect(till.press().status).toBe("submit");
    expect(till.completed).toEqual([{ tenderedFixed: "50.00", changeFixed: "25.00" }]);
  });

  it("completes exactly once however many times Done is pressed", () => {
    const till = host("20.00");

    till.change(applyCashEntryDenomination(EMPTY_CASH_ENTRY, 20));

    expect(till.press().status).toBe("submit");

    for (let press = 0; press < 25; press += 1) {
      expect(till.press()).toMatchObject({ refusal: "submission_in_progress" });
    }

    expect(till.completed).toHaveLength(1);
  });

  it("discards an entered tender across a close and reopen", () => {
    const till = host("20.00");

    till.change(applyCashEntryDenomination(EMPTY_CASH_ENTRY, 50));
    expect(till.render().status).toBe("submit");

    till.reopen();

    expect(till.typed()).toBe(EMPTY_CASH_ENTRY);
    expect(till.render()).toMatchObject({ refusal: "missing" });
    expect(till.press()).toMatchObject({ refusal: "missing" });
    expect(till.completed).toEqual([]);
  });

  it("never completes a sale the pad would not have enabled Done for", () => {
    // THE INVARIANT BEHIND THE WHOLE STEP, walked across a long mixed sequence
    // of keystrokes, notes, cart mutations and a reopen.
    const till = host("12.34");
    const steps: (() => void)[] = [
      () => till.change(appendCashEntryDigit(till.typed(), "1")),
      () => till.change(appendCashEntryDecimalPoint(till.typed())),
      () => till.change(appendCashEntryDigit(till.typed(), "2")),
      () => till.mutateCart("cart-x", "12.34"),
      () => till.change(clearCashEntry()),
      () => till.change(applyCashEntryDenomination(till.typed(), 20)),
      () => till.mutateCart("cart-y", "40.00"),
      () => till.change(applyCashEntryDenomination(till.typed(), 50)),
      () => till.reopen(),
      () => till.change(applyCashEntryDenomination(till.typed(), 100)),
    ];

    let submittableRenders = 0;
    let acceptedPresses = 0;

    for (const step of steps) {
      step();

      const rendered = till.render();
      const pressed = till.press();

      if (rendered.status === "refused") {
        // A press can never complete a sale the pad had refused. The REASON may
        // legitimately differ -- once a sale is outstanding every press reports
        // submission_in_progress -- but the outcome may not.
        expect(pressed.status).toBe("refused");

        continue;
      }

      submittableRenders += 1;

      if (pressed.status === "submit") {
        acceptedPresses += 1;
        // The figures that reach the sale are the figures the cashier read.
        expect(pressed.tenderedFixed).toBe(rendered.tenderedFixed);
        expect(pressed.changeFixed).toBe(rendered.changeFixed);
      } else {
        // The only reason a submittable render may be refused at the press.
        expect(pressed.refusal).toBe("submission_in_progress");
      }
    }

    // NOT VACUOUS: the sequence really did reach submittable states, so the
    // branch above was exercised rather than skipped.
    expect(submittableRenders).toBeGreaterThan(0);
    expect(till.completed).toHaveLength(acceptedPresses);

    // TWO, one per checkout episode, and that is correct rather than a leak:
    // the in-flight latch is cleared by a reopen because a reopened checkout is
    // a different sale. Within one episode it never clears, which the
    // twenty-five-press test above proves.
    expect(acceptedPresses).toBe(2);
  });
});
