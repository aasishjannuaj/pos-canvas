// v1.3 CP-2C — the Cash Tender wiring guards.
//
// This repository has no DOM environment and no React Testing Library
// (verified: no @testing-library and no browser provider in this worktree's
// node_modules), so component behavior is asserted at the source level, exactly
// as components/runtime/PosRuntime.layout.test.ts and
// components/runtime/modifierUx.guards.test.ts already do.
//
// THE DIVISION OF LABOUR IS THE POINT. Every rule Cash Tender obeys is tested
// directly against real inputs in lib/cashTenderEntry.test.ts, on top of the
// accepted lib/cashTender.test.ts. These guards prove something those cannot:
// that the components are WIRED to those rules and carry none of their own, and
// that Done reaches the checkout flow that already existed rather than a second
// one built beside it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(repoRoot, p), "utf-8");
const code = (src: string) =>
  src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const runtimeSource = read("components/runtime/PosRuntime.tsx");
const runtime = code(runtimeSource);
const pad = code(read("components/runtime/CashTenderPad.tsx"));
const panel = code(read("components/runtime/PosCheckoutPanel.tsx"));
const receiptLines = code(read("components/runtime/CashTenderReceiptLines.tsx"));
const authReceipt = code(read("components/runtime/AuthoritativeReceipt.tsx"));
const offlineReceipt = code(read("components/runtime/OfflineReceipt.tsx"));
const entryLib = code(read("lib/cashTenderEntry.ts"));

/**
 * completeSale's body.
 *
 * BOUNDED BY THE COMPONENT'S JSX RETURN, not by completeCashSale: that function
 * is declared ABOVE completeSale in the file, so slicing between them yields an
 * empty string -- which is how this guard first failed, and why the bound is
 * asserted non-empty everywhere it is used.
 */
const completeSaleBody = (() => {
  const start = runtimeSource.indexOf("  async function completeSale()");
  const end = runtimeSource.lastIndexOf("  return (");

  return start >= 0 && end > start ? code(runtimeSource.slice(start, end)) : "";
})();

/** Collapses whitespace, so button text split across JSX lines still matches. */
const flat = (src: string) => src.replace(/\s+/g, " ");
const padFlat = flat(pad);

describe("the accepted CP-1C logic is reused, not reimplemented", () => {
  it("every money rule comes from lib/cashTender.ts", () => {
    for (const reused of [
      "applyTenderDenomination",
      "buildCashTenderBinding",
      "cashTenderBindingsMatch",
      "formatTenderDigits",
      "MAX_TENDER_DIGITS",
      "validateCashTender",
    ]) {
      expect(entryLib).toContain(reused);
    }

    expect(entryLib).toContain('from "@/lib/cashTender"');
  });

  it("lib/cashTender.ts itself is untouched by this checkpoint", () => {
    // ACCEPTED AND CLOSED. CP-2C supplies a different INPUT INTERPRETATION; if
    // it had edited the accepted module instead, this hash would have moved.
    // Compared by content rather than by a stored digest so the assertion says
    // what it means: the cents-first contract is still exactly what it was.
    const accepted = read("lib/cashTender.ts");

    expect(accepted).toContain("export const MAX_TENDER_FIXED = \"9999999999.99\";");
    expect(accepted).toContain("export function appendTenderDigit(");
    expect(accepted).toContain("export function validateCashTender(");
    // The CP-1C keypad is still cents-first. CP-2C did not convert it.
    expect(accepted).toContain("The keypad — cents first");
  });

  it("no second money implementation exists in the new code", () => {
    for (const source of [entryLib, pad, receiptLines]) {
      expect(source).not.toContain("toFixed");
      expect(source).not.toContain("parseFloat");
      expect(source).not.toContain("parseInt");
      expect(source).not.toContain("Math.round");
    }
  });

  it("the entry module computes no total, tax or tip of its own", () => {
    expect(entryLib).not.toContain("calculateCartSummary");
    expect(entryLib).not.toContain("exactOrderTotals");
    expect(entryLib).not.toContain("taxAmount");
  });
});

describe("the pad decides nothing (requirements 3 to 6)", () => {
  it("delegates every keystroke to the pure editing functions", () => {
    for (const delegated of [
      "appendCashEntryDigit",
      "appendCashEntryDecimalPoint",
      "applyCashEntryDenomination",
      "backspaceCashEntry",
      "clearCashEntry",
    ]) {
      expect(pad).toContain(delegated);
    }
  });

  it("takes its denominations exclusively from cashDenominations", () => {
    // lib/cashTender.ts states this obligation on the caller explicitly:
    // applyTenderDenomination does not consult CASH_DENOMINATIONS and will add
    // any positive whole unit, so a hardcoded button list here would be a note
    // that no currency necessarily has.
    expect(pad).toContain("cashDenominations(currency)");
    expect(pad).not.toContain("CASH_DENOMINATIONS");
    expect(pad).not.toMatch(/\[\s*1,\s*5,\s*10,\s*20/);
  });

  it("reads the sufficiency decision rather than recomputing it", () => {
    expect(pad).toContain('decision.status === "submit"');
    expect(pad).toContain("decision.changeFixed");
    // No comparison of a tender against a total anywhere in the component.
    expect(pad).not.toContain("validateCashTender");
    expect(pad).not.toContain("compareMoney");
    expect(pad).not.toContain("subtractMoney");
  });

  it("does not own the entry buffer, so a moved total cannot hide from it", () => {
    expect(pad).toContain("onEntryChange");
    expect(pad).not.toContain("useState(EMPTY_CASH_ENTRY)");
    expect(runtime).toContain("const [cashEntry, setCashEntry] = useState(EMPTY_CASH_ENTRY);");
  });

  it("shows a change figure only once the tender covers the total", () => {
    expect(pad).toContain('decision.status === "submit" ? decision.changeFixed : null');
  });
});

describe("the physical keyboard reaches the pad safely (item 1)", () => {
  it("accepts keyboard input through a real controlled input", () => {
    expect(pad).toContain('type="text"');
    expect(pad).toContain('inputMode="decimal"');
    expect(pad).toContain("value={entry}");
    expect(pad).toContain("onChange={(event) => apply(replaceCashEntry(entry, event.target.value))}");
    expect(pad).toContain('aria-label="Cash received"');
  });

  it("routes every value change through the pure rule, not a second one", () => {
    // The input must not maintain its own notion of a valid amount: a cashier
    // must not be able to type what a button would have refused.
    expect(pad).toContain("replaceCashEntry");
    expect(pad).not.toContain("event.target.value.replace");
    expect(pad).not.toContain("Number(");
    expect(pad).not.toContain("isNaN");
  });

  it("uses no global key listener, so barcode scanning is untouched", () => {
    // THE SAFETY ARGUMENT FOR ITEM 1. A window- or document-level handler would
    // have received keystrokes aimed at the Search / Scan field and at every
    // other control in the app. Every handler here is bound to one element.
    for (const banned of [
      "window.addEventListener",
      "document.addEventListener",
      "onKeyDownCapture",
      "onKeyPress",
      "useCapture",
    ]) {
      expect(pad).not.toContain(banned);
    }

    // And nothing in this checkpoint touches the scan-focus mechanism.
    for (const source of [pad, entryLib, receiptLines]) {
      expect(source).not.toContain("scanFocusRequest");
      expect(source).not.toContain("sellingSurfaceActive");
      expect(source).not.toContain("barcode");
    }
  });

  it("avoids type=number, whose own parsing would compete with the rule", () => {
    expect(pad).not.toContain('type="number"');
    expect(pad).not.toContain("valueAsNumber");
    expect(pad).not.toContain("step=");
  });

  it("NO key in the cash field can start a sale", () => {
    // THE CORRECTION. A keyboard-wedge scanner types a short numeric code and
    // then sends Enter. The code is indistinguishable from a typed amount, so
    // it lands in the field; the Enter that followed must not then complete a
    // sale. The submit route is gone, and this is what keeps it gone.
    const handler = pad.slice(
      pad.indexOf("function handleEntryKeyDown"),
      pad.indexOf("return (")
    );

    expect(handler).not.toBe("");
    expect(handler).toContain('if (event.key === "Enter")');
    expect(handler).toContain("event.preventDefault();");

    // Nothing in the handler can reach a sale, by any spelling.
    for (const banned of ["onDone", "doneDisabled", "decision", "submit"]) {
      expect(handler).not.toContain(banned);
    }
  });

  it("Done keeps native keyboard activation, and still cannot repeat", () => {
    // Done is a real <button>, so Enter and Space activate it natively once the
    // cashier has focused IT -- that is an explicit activation, not a stray key
    // in a text field. Nothing here re-implements that, and nothing disables it.
    // The WHOLE element, from its opening tag to its marker attribute.
    const doneMarker = pad.indexOf("data-cash-tender-done");
    const doneButton = pad.slice(pad.lastIndexOf("<button", doneMarker), doneMarker);

    expect(doneButton).toContain('type="button"');
    expect(doneButton).toContain("onClick={onDone}");
    expect(doneButton).toContain("onKeyDown={handleDoneKeyDown}");
    expect(doneButton).toContain("disabled={doneDisabled}");

    // The held-key guard on Done is untouched by the correction.
    const doneHandler = pad.slice(
      pad.indexOf("function handleDoneKeyDown"),
      pad.indexOf("function handleEntryKeyDown")
    );

    expect(doneHandler).toContain("event.repeat");
    expect(doneHandler).toContain('event.key === "Enter"');
    expect(doneHandler).toContain('event.key === " "');
    expect(doneHandler).toContain("event.preventDefault();");
  });

  it("the synchronous duplicate-submission guard is untouched", () => {
    // The correction removed a ROUTE, not a defence. PosRuntime's ref guard is
    // asserted in full by the requirement-8 block below; this pins that the
    // correction did not quietly drop it.
    expect(runtime).toContain("const cashDoneInFlightRef = useRef(false);");
    expect(runtime).toContain("cashDoneInFlightRef.current = true;");
    expect(runtime).toContain("submissionInFlight: isSubmitBlocked(saleSaveStatus),");
  });

  it("takes focus from nothing, because an accepted invariant forbids it", () => {
    // lib/recoveryCartPreservation.guards.test.ts names the ONLY two files in
    // the layout and runtime trees that may call .focus() — the Liquor and
    // Retail Search / Scan fields — and its negative control requires the set
    // of focusing files to equal that list EXACTLY. An autofocus here made this
    // component a third, and that suite failed. It was removed rather than the
    // allowlist widened: the restriction exists so nothing inside the POS can
    // take the caret while a host gate covers it, and extending it is a Control
    // Room decision.
    //
    // `autoFocus` is banned alongside it, so the attribute is not a way around
    // this either.
    expect(pad).not.toContain(".focus()");
    expect(pad).not.toContain("autoFocus");
    expect(pad).not.toContain("document.activeElement");
    expect(pad).not.toContain("useRef");
  });

  it("the cash field is reachable without any focus call", () => {
    // A <label> wraps the row, so tapping the row — a much larger target than
    // the number on a touch till — puts the caret in the input. Keyboard users
    // reach it by tabbing. Neither needs this component to move focus.
    expect(pad).toContain("<label");
    expect(padFlat).toContain("Cash Received");

    const label = pad.slice(pad.indexOf("<label"), pad.indexOf("</label>"));

    expect(label).toContain("<input");
    expect(label).toContain('aria-label="Cash received"');
  });

  });

describe("the receipt lines reconcile against the printed total (item 2)", () => {
  it("the resolver is given the total the receipt actually prints", () => {
    expect(entryLib).toContain("receiptTotalFixed: string;");
    expect(entryLib).toContain("compareMoney(subtractMoney(tendered, change), total) !== 0");
    expect(receiptLines).toContain("receiptTotalFixed");
  });

  it("both receipts pass their OWN payload total, not a client figure", () => {
    for (const receipt of [authReceipt, offlineReceipt]) {
      expect(receipt).toContain("receiptTotalFixed={receipt.total}");
      // Never the cart summary, which is what the change was computed against.
      expect(receipt).not.toContain("cartSummary");
    }
  });

  it("the check is exact money arithmetic, not a tolerance", () => {
    expect(entryLib).toContain('from "@/lib/money"');
    expect(entryLib).not.toContain("Math.abs");
    expect(entryLib).not.toContain("epsilon");
    expect(entryLib).not.toContain("0.01");
  });

  it("no change figure is ever recomputed from the printed total", () => {
    // The only two outcomes are "the figures the cashier used" or "nothing". A
    // recomputed Change Due would be money that never crossed the counter.
    const resolver = entryLib.slice(entryLib.indexOf("export function cashTenderReceiptLines"));

    expect(resolver).toContain("return { tenderedFixed: outcome.tenderedFixed, changeFixed: outcome.changeFixed };");
    expect(resolver).not.toContain("subtractMoney(tendered, total)");
    expect(resolver).not.toContain("formatMoney(subtractMoney");
  });
});

describe("one Done button, and no Confirm Tender (requirement 7)", () => {
  it("offers Clear and Done and nothing that confirms a tender separately", () => {
    // Done carries a saving label, so it is matched through that expression
    // rather than as bare element text.
    expect(pad).toContain('{busy ? "Saving..." : "Done"}');
    expect(padFlat).toContain("> Clear <");
    expect(pad).not.toContain("Confirm Tender");
    expect(pad).not.toContain("Confirm");
  });

  it("has exactly one control that can start a sale", () => {
    // ONE ROUTE, AND IT IS THE BUTTON'S OWN onClick. onDone is called from
    // nowhere else in this file -- not from a key handler, not from an effect,
    // not from the input. Counted, so any second route added later fails here.
    expect(pad.match(/onClick=\{onDone\}/g)).toHaveLength(1);
    expect(pad.match(/onDone\(\)/g)).toBeNull();

    // onDone appears exactly three times: the prop type, the destructured
    // parameter, and that one onClick.
    expect(pad.match(/onDone/g)).toHaveLength(3);
  });

  it("the step inherits the checkout body's duty to report a failed sale", () => {
    // IT REPLACED THE BODY THAT SHOWED THIS. Without the pass-through a cash
    // sale that lost its connection would return from "Saving..." to "Done"
    // with nothing said, and the Feature 24.5F notice offering offline mode
    // would never be read.
    expect(pad).toContain("saleError: string | null;");
    expect(padFlat).toContain("{saleError !== null && (");
    expect(runtime).toContain('saleError={saleSaveStatus === "error" ? displayedSaleError : null}');
    // displayedSaleError is the host's existing derivation, not a second one.
    expect(runtime).toContain("const displayedSaleError =");
    expect(pad).not.toContain("OFFLINE_AVAILABLE_AFTER_CONNECTION_LOST");
  });

  it("Back is navigation and reuses the existing payment-method step", () => {
    expect(padFlat).toContain("> Back <");
    expect(runtime).toContain("function leaveCashTender()");
    expect(runtime).toContain("setSelectedPaymentMethod(null);");
    // It must not be a second way to cancel a checkout.
    expect(pad).not.toContain("onCloseCheckout");
  });
});

describe("duplicate submission is refused three ways (requirement 8)", () => {
  it("the pad swallows held Enter and Space repeats before they become clicks", () => {
    expect(pad).toContain("event.repeat");
    expect(pad).toContain('event.key === "Enter"');
    expect(pad).toContain('event.key === " "');
    expect(pad).toContain("event.preventDefault();");
    expect(pad).toContain("onKeyDown={handleDoneKeyDown}");
  });

  it("the host holds a synchronous in-flight ref, checked and set before the await", () => {
    expect(runtime).toContain("const cashDoneInFlightRef = useRef(false);");

    const body = runtime.slice(
      runtime.indexOf("async function completeCashSale()"),
      runtime.indexOf("const shownReceipt =")
    );

    expect(body).not.toBe("");

    const guard = body.indexOf("if (cashDoneInFlightRef.current");
    const set = body.indexOf("cashDoneInFlightRef.current = true;");
    const awaited = body.indexOf("await completeSale()");
    const cleared = body.indexOf("cashDoneInFlightRef.current = false;");

    // ORDER IS THE PROPERTY. A ref set after the await would be read as false
    // by a second press, which is the race the ref exists to close.
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(set).toBeGreaterThan(guard);
    expect(awaited).toBeGreaterThan(set);
    expect(cleared).toBeGreaterThan(awaited);
    expect(body).toContain("finally");
  });

  it("the pure gate refuses while a submission is outstanding, and checks it first", () => {
    const decide = entryLib.slice(entryLib.indexOf("export function decideCashTenderSubmission"));
    const inFlight = decide.indexOf("input.submissionInFlight");

    expect(inFlight).toBeGreaterThanOrEqual(0);
    for (const later of [
      "cashEntryToTenderDigits(input.entry)",
      "captureCashTenderBinding(",
      "validateCashTender(",
    ]) {
      expect(decide.indexOf(later)).toBeGreaterThan(inFlight);
    }
  });

  it("the Done press passes the live in-flight reading, and the render does not", () => {
    expect(runtime).toContain("submissionInFlight: isSubmitBlocked(saleSaveStatus),");
    expect(runtime).toContain("submissionInFlight: false,");
    // The disabled state is driven by the same existing predicate the Complete
    // Sale button uses, not by a second notion of "busy".
    expect(runtime).toContain("busy={isSubmitBlocked(saleSaveStatus)}");
  });
});

describe("Done reaches the checkout flow that already exists (requirements 9 and 10)", () => {
  it("calls completeSale, not a cash-specific pipeline", () => {
    expect(runtime).toContain("await completeSale();");
    expect(runtime).toContain("onDone={completeCashSale}");
  });

  it("completeSale itself knows nothing about cash tender", () => {
    // THE WHOLE SAFETY CLAIM OF THIS CHECKPOINT. If any cash-tender symbol
    // appeared inside completeSale, the existing online / offline / UNKNOWN /
    // identity path would have been forked rather than reused.
    const body = completeSaleBody;

    expect(body).not.toBe("");
    expect(body).toContain("planSaleSubmission");
    expect(body).toContain("queueOfflineSale");
    expect(body).toContain("decideUncertainSale");

    for (const banned of [
      "cashEntry",
      "cashTender",
      "CashTender",
      "decideCashTenderSubmission",
      "changeFixed",
      "tenderedFixed",
    ]) {
      expect(body).not.toContain(banned);
    }
  });

  it("the existing fences and gates are still the first things completeSale does", () => {
    const body = completeSaleBody;

    const blocked = body.indexOf("if (checkoutBlockedReason !== null)");
    const emptyCart = body.indexOf("if (cart.length === 0 || !selectedPaymentMethod");
    // v1.3 CP-2D — CP-2B STRENGTHENED THIS CHECK; it did not move or remove it.
    // The literal was `if (isSubmitBlocked(saleSaveStatus))`; CP-2B added a
    // synchronous ref in front of it, because React state cannot close a
    // same-tick double activation. The ORDERING this test exists to pin is
    // unchanged, so the anchor is updated rather than the assertion relaxed,
    // and the ref is asserted alongside so the stronger form cannot be quietly
    // reverted to the weaker one.
    const doubleSubmit = body.indexOf(
      "if (saleInFlightRef.current || isSubmitBlocked(saleSaveStatus))"
    );

    expect(doubleSubmit).toBeGreaterThan(-1);
    expect(body).toContain("saleInFlightRef.current = true;");
    const fingerprint = body.indexOf("createSaleFingerprint({");
    const uncertainty = body.indexOf("decideUncertainSale(");

    expect(blocked).toBe(body.indexOf("if ("));
    expect(emptyCart).toBeGreaterThan(blocked);
    expect(doubleSubmit).toBeGreaterThan(emptyCart);
    expect(fingerprint).toBeGreaterThan(doubleSubmit);
    expect(uncertainty).toBeGreaterThan(fingerprint);
  });

  it("no sale RPC, queue write or identity is reachable from the cash tender code", () => {
    for (const source of [pad, entryLib, receiptLines]) {
      for (const banned of [
        "complete_sale",
        "submitSale",
        "planSaleSubmission",
        "queueOfflineSale",
        "saleRequestId",
        "createSaleFingerprint",
        "supabase",
      ]) {
        expect(source).not.toContain(banned);
      }
    }
  });

  it("the tender does not survive a checkout, a reopen or a method change", () => {
    expect(runtime).toContain("function resetCashTender()");

    for (const caller of ["function closeCheckout()", "function openCheckout()", "function selectPaymentMethod("]) {
      const start = runtime.indexOf(caller);

      expect(start).toBeGreaterThanOrEqual(0);
      expect(runtime.slice(start, runtime.indexOf("\n  }", start))).toContain("resetCashTender();");
    }
  });
});

describe("the staleness counters are advanced by the runtime (requirement 6)", () => {
  it("every cart mutator and the payment selector advance the revision", () => {
    // lib/cashTender.ts is explicit that the revision only detects a cart that
    // went A -> B -> A "while the runtime actually advances the counter on every
    // mutation", and that no pure test there can prove that it does. This is
    // that proof, and it is why bumpCheckoutRevision exists as one function.
    for (const mutator of [
      "function addToCart(",
      "function increaseQuantity(",
      "function decreaseQuantity(",
      "function removeFromCart(",
      "function clearCart(",
      "function selectPaymentMethod(",
    ]) {
      const start = runtime.indexOf(mutator);

      expect(start).toBeGreaterThanOrEqual(0);
      expect(runtime.slice(start, runtime.indexOf("\n  }", start))).toContain("bumpCheckoutRevision();");
    }
  });

  it("exactly these functions advance the revision, and nothing else writes the cart", () => {
    // ENUMERATED, NOT COUNTED. A bare total would be satisfied by a bump moved
    // from a cart mutator into some unrelated function, which is precisely the
    // failure this is meant to catch: a stale tender comparing equal to a live
    // one. So the guard names the callers, and it also checks that no SIXTH
    // function writes the cart without being one of them.
    const declarations = [...runtime.matchAll(/\n  (?:async )?function (\w+)\(/g)];
    const bumping: string[] = [];
    const writingCart: string[] = [];

    for (const [index, declaration] of declarations.entries()) {
      const start = declaration.index ?? 0;
      const end = declarations[index + 1]?.index ?? runtime.length;
      const body = runtime.slice(start, end);

      if (body.includes("bumpCheckoutRevision();")) bumping.push(declaration[1]);
      if (body.includes("setCart(")) writingCart.push(declaration[1]);
    }

    expect(writingCart.sort()).toEqual([
      "addToCart",
      "clearCart",
      "decreaseQuantity",
      "increaseQuantity",
      "removeFromCart",
    ]);

    // The five cart writers above, plus the two checkout mutations that change
    // what a tender means without touching the cart.
    expect(bumping.sort()).toEqual([
      "addToCart",
      "clearCart",
      "decreaseQuantity",
      "increaseQuantity",
      "leaveCashTender",
      "removeFromCart",
      "selectPaymentMethod",
    ]);

    // Every cart writer bumps. Stated as a containment rather than inferred
    // from the two lists above, so a future reader does not have to diff them.
    for (const writer of writingCart) {
      expect(bumping).toContain(writer);
    }
  });

  it("reopening a checkout starts a new episode", () => {
    expect(runtime).toContain("setCheckoutEpisode((previous) => previous + 1);");
    expect(runtime).toContain("checkoutSessionId: `checkout-${checkoutEpisode}`");
  });

  it("the binding is captured on every entry change, against the live context", () => {
    expect(runtime).toContain("function changeCashEntry(entry: string)");
    expect(runtime).toContain("captureCashTenderBinding(cashTenderContext, entry)");
    expect(runtime).toContain("onEntryChange={changeCashEntry}");
  });

  it("the total bound is the one the checkout displays", () => {
    expect(runtime).toContain("amountDueFixed: cartSummary.total,");
  });

  it("the counters use no clock and no crypto", () => {
    for (const source of [runtime.slice(runtime.indexOf("const [checkoutEpisode")), pad, entryLib]) {
      expect(source).not.toContain("Date.now");
      expect(source).not.toContain("randomUUID");
      expect(source).not.toContain("node:crypto");
    }
  });
});

describe("the receipt gains two lines and no new figure (requirement 11)", () => {
  it("both receipt models render the shared lines, in the same place", () => {
    for (const receipt of [authReceipt, offlineReceipt]) {
      expect(receipt).toContain("CashTenderReceiptLines");
      expect(receipt).toContain("paymentMethod={receipt.paymentMethod}");
      expect(receipt).toContain("outcome={cashTender}");

      // BELOW the Total, and the Total is still the payload's own.
      // The USAGE, not the import at the top of the file.
      expect(receipt.indexOf("{receipt.total}")).toBeLessThan(
        receipt.indexOf("<CashTenderReceiptLines")
      );
      expect(receipt).toContain("{receipt.total}");
    }
  });

  it("the lines component changes no total and decides nothing", () => {
    expect(receiptLines).toContain(
      "cashTenderReceiptLines({ paymentMethod, outcome, receiptTotalFixed })"
    );
    expect(receiptLines).toContain("Cash Tendered");
    expect(receiptLines).toContain("Change Due");

    // NARROWED, NOT DROPPED. The component is now handed the printed total so
    // the resolver can reconcile against it, so it may NAME receiptTotalFixed —
    // but it still must not read the payload, render a Total line, or touch any
    // other figure on the receipt.
    expect(receiptLines).toContain("receiptTotalFixed");
    for (const banned of [
      "receipt.total",
      "subtotal",
      "taxAmount",
      "tipAmount",
      ">Total<",
      "{receiptTotalFixed}",
    ]) {
      expect(receiptLines).not.toContain(banned);
    }
  });

  it("the sale total is never recomputed from the tender", () => {
    for (const source of [authReceipt, offlineReceipt, receiptLines]) {
      expect(source).not.toContain("tenderedFixed -");
      expect(source).not.toContain("- changeFixed");
    }
  });

  it("the outcome reaches the printed copy as well as the screen", () => {
    // Two print-only copies exist in PosRuntime, one per receipt model, and
    // both must carry the same figures the overlay shows.
    expect(runtime.match(/cashTender=\{cashTenderOutcome\}/g)).toHaveLength(3);
  });

  it("a historical reprint is deliberately NOT given fabricated figures", () => {
    // The tender is not persisted anywhere -- see the CP-2C report. A reprint
    // therefore shows the receipt it always showed rather than two lines
    // invented from an unrelated sale still in memory.
    const history = code(read("components/runtime/SalesHistoryDetail.tsx"));

    expect(history).not.toContain("cashTender");
    expect(history).not.toContain("CashTenderReceiptLines");
  });

  it("no migration or RPC was introduced for the tender", () => {
    for (const source of [entryLib, pad, receiptLines, runtime]) {
      expect(source).not.toContain("cash_tendered");
      expect(source).not.toContain("change_due");
      expect(source).not.toContain("receipt_snapshot");
    }
  });
});

describe("the Builder preview is unaffected", () => {
  it("the panel takes the tender step as an optional slot and builds no pad", () => {
    expect(panel).toContain("cashTenderStep?: ReactNode;");
    expect(panel).toContain("cashTenderStep = null,");
    expect(panel).toContain("cashTender = null,");
    // The shared panel must not import the pad: EditorPreview renders this
    // panel and has no checkout session, revision counter or real sale.
    expect(panel).not.toContain("CashTenderPad");
    expect(panel).not.toContain("cashDenominations");
    expect(panel).not.toContain("decideCashTenderSubmission");
  });

  it("the existing checkout body is still rendered when no step is supplied", () => {
    expect(panel).toContain("cashTenderStep !== null ?");
    expect(panel).toContain("Payment Method");
    expect(panel).toContain("onClick={onCompleteSale}");
    expect(panel).toContain("Complete Sale");
  });

  it("EditorPreview passes neither new prop", () => {
    const preview = code(read("components/editor/EditorPreview.tsx"));

    expect(preview).toContain("PosCheckoutPanel");
    expect(preview).not.toContain("cashTenderStep");
    expect(preview).not.toContain("cashTender=");
  });
});
