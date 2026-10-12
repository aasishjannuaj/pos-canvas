// v1.3 CP-2C — the Cash Tender screen.
//
// A SHELL, DELIBERATELY. Every rule it obeys lives in lib/cashTenderEntry.ts
// (which in turn defers every money rule to the accepted lib/cashTender.ts):
// what a keystroke does, what a note adds, whether the entry is enough, what
// the change is, and whether the checkout moved underneath it. This file picks
// none of that — it renders the result and reports the keystroke.
//
// WHY THE SPLIT IS NOT COSMETIC. Vitest runs under `environment: "node"` here,
// with no DOM, no @testing-library and no browser provider, so nothing rendered
// in this file can be asserted by this repository's suite. Anything decided
// here would therefore be decided UNTESTED on a money path. So nothing is.
//
// IT DOES NOT OWN THE ENTRY EITHER. PosRuntime holds the buffer, because the
// staleness binding has to be captured against the live checkout at the moment
// the buffer changes, and only PosRuntime knows the cart, the total and the
// revision counter. This component computes the next buffer with the pure
// editing functions and hands it up; a refusal it keeps, because a refusal is
// something to show, not state the checkout needs.
//
// THERE IS NO CONFIRM TENDER BUTTON. Done and Clear are the only tender
// controls; Back is navigation, returning to the payment-method step the
// cashier came from, where the checkout's own Cancel still lives unchanged.
// Done is the only control that can start a sale, and the gate behind it is
// decideCashTenderSubmission evaluated against the LIVE checkout, not against
// anything blessed earlier — there is no earlier moment to bless.
//
// THE PHYSICAL KEYBOARD REACHES IT THROUGH A REAL <input>, AND NOTHING ELSE.
// A Windows till has a keyboard, and the on-screen keys alone left it unusable
// there. The smallest safe way to accept it is an ordinary controlled text input
// whose every value change goes through replaceCashEntry — the same shape, cap
// and canonicalisation the buttons apply, so nothing can be typed that a button
// would have refused.
//
// DELIBERATELY NO GLOBAL KEY LISTENER, which is what makes this safe beside
// barcode scanning. A window- or document-level handler would have received
// keystrokes aimed at the Search / Scan field and at every other control in the
// app. This handler is bound to one input, so a key reaches the cash amount
// only while that input holds focus, and nothing outside this component's
// subtree changes behavior at all.
//
// AND NO KEY IN THIS FIELD CAN START A SALE. Only an explicit activation of the
// Done button does — see handleEntryKeyDown for the scanner case that forced
// that rule. A scan can still land IN the field, visibly, to be cleared; what it
// can no longer do is submit.
//
// AND IT TAKES FOCUS FROM NOTHING. The cashier puts the caret in the field
// themselves, by tapping the row or tabbing to it; this component calls
// `.focus()` nowhere. That is NOT an oversight and must not be "fixed" by
// adding an autofocus or an `autoFocus` attribute:
// lib/recoveryCartPreservation.guards.test.ts names the ONLY two files in the
// layout and runtime trees that may focus anything — the Liquor and Retail
// Search / Scan fields — and its negative control requires the set of focusing
// files to equal that list exactly. That restriction exists so nothing inside
// the POS can take the caret while a host gate covers it, and extending it is
// a Control Room decision, not this checkpoint's. See the CP-2C report.
//
// IT REPLACES THE CHECKOUT BODY RATHER THAN STACKING UNDER IT, and it scrolls.
// The checkout overlay is `absolute inset-0 ... justify-between` with no
// overflow rule, inside an `overflow-hidden` aside that is 45% of the viewport
// height below `md`. At the Android emulator viewport Feature 16.2 measured
// (411 x 866), that is roughly 390px: a keypad added BELOW the existing header,
// total and payment selector would have pushed Done out of a container that
// clips rather than scrolls. So the total is restated here, and the keypad sits
// in its own scroll region with Done pinned beneath it.

"use client";

import { useState } from "react";

import { cashDenominations } from "@/lib/cashTender";
import type {
  CashEntryRefusal,
  CashEntryResult,
  CashTenderSubmission,
} from "@/lib/cashTenderEntry";
import {
  appendCashEntryDecimalPoint,
  appendCashEntryDigit,
  applyCashEntryDenomination,
  backspaceCashEntry,
  clearCashEntry,
  EMPTY_CASH_ENTRY,
  replaceCashEntry,
} from "@/lib/cashTenderEntry";
import type { ProjectConfig } from "@/lib/projectConfig";

/**
 * What each refused keystroke looks like.
 *
 * SEPARATE FROM CASH_TENDER_MESSAGES on purpose. Those answer "why can this
 * sale not complete"; these answer "why did that key do nothing", which is a
 * different question asked at a different moment. Both exist because a silent
 * refusal makes a cashier press harder.
 */
const KEY_REFUSAL_MESSAGES: Readonly<Record<CashEntryRefusal, string>> = Object.freeze({
  invalid_character: "That key is not a number.",
  duplicate_decimal_point: "There is already a decimal point.",
  too_many_decimals: "Cash amounts have at most two decimal places.",
  max_input_reached: "That is as long as a cash amount can be.",
  max_amount_exceeded: "That would be more cash than a sale can take.",
});

type CashTenderPadProps = {
  currency: ProjectConfig["receipt"]["currency"];
  currencySymbol: string;
  branding: ProjectConfig["branding"];
  /** The live total, fixed two decimals — the existing bill total. */
  amountDueFixed: string;
  /** The buffer. Owned by PosRuntime. */
  entry: string;
  /**
   * What the buffer means against the live checkout right now.
   *
   * Computed by the host at render time from the same pure function Done uses,
   * with `submissionInFlight: false` — this drives the Change Due readout and
   * the refusal text, and a reading that blanked mid-save would tell the
   * cashier the change had changed. Whether Done may actually fire is `busy`
   * below, plus the host's own authoritative call.
   */
  decision: CashTenderSubmission;
  /**
   * A refusal produced by an actual Done press rather than by this render.
   *
   * Only reachable if the checkout moved between the render that enabled Done
   * and the press itself. Surfaced rather than swallowed: a button that appears
   * to do nothing is how a cashier ends up pressing it repeatedly.
   */
  pressRefusal: string | null;
  /** A completion is under way. */
  busy: boolean;
  /**
   * The checkout's own sale error, unchanged and unfiltered.
   *
   * THIS STEP REPLACES THE CHECKOUT BODY, so it inherits the body's obligation
   * to state why a sale failed. Without it a cash sale that lost its connection
   * would return from "Saving..." to "Done" with nothing said — and the host's
   * Feature 24.5F (DEF-01) notice, the one that tells the operator offline mode
   * is now available, would never be read. It is passed through exactly as the
   * Complete Sale screen shows it, including that substitution.
   */
  saleError: string | null;
  /** Non-null when the host refuses to take any sale at all. */
  blockedReason: string | null;
  onEntryChange: (entry: string) => void;
  onDone: () => void;
  onBack: () => void;
};

const KEYPAD_DIGITS: readonly string[] = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

const KEY_CLASS =
  "rounded-xl border border-neutral-200 py-3 text-base font-medium text-neutral-800 transition-colors hover:border-blue-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50";

export default function CashTenderPad({
  currency,
  currencySymbol,
  branding,
  amountDueFixed,
  entry,
  decision,
  pressRefusal,
  busy,
  saleError,
  blockedReason,
  onEntryChange,
  onDone,
  onBack,
}: CashTenderPadProps) {
  const [keyRefusal, setKeyRefusal] = useState<string | null>(null);

  // Every keystroke goes through here, so the refusal notice is set and cleared
  // in exactly one place and cannot be left over from an earlier key.
  function apply(result: CashEntryResult) {
    if (result.ok) {
      setKeyRefusal(null);
      onEntryChange(result.entry);
    } else {
      setKeyRefusal(KEY_REFUSAL_MESSAGES[result.refusal]);
    }
  }

  const changeFixed = decision.status === "submit" ? decision.changeFixed : null;

  // Shown only once the cashier has actually typed something. An untouched pad
  // is not a mistake, and "Enter the cash received" above a field that already
  // reads 0.00 is noise.
  const entryRefusal =
    entry !== EMPTY_CASH_ENTRY && decision.status === "refused" ? decision.message : null;

  const shortfall =
    decision.status === "refused" && decision.refusal === "insufficient"
      ? decision.shortfall
      : undefined;

  const doneDisabled = busy || blockedReason !== null || decision.status !== "submit";

  /**
   * THE KEY-REPEAT GUARD, and it is the reason this handler exists at all.
   *
   * A <button> already fires click for Enter and for Space, so an ordinary press
   * needs nothing. What it does NOT do is stop a HELD key: the browser repeats
   * keydown, every repeat becomes another click, and a cashier resting a thumb
   * on Enter would otherwise press Done dozens of times. `event.repeat` is true
   * for exactly those, so they are swallowed before they become clicks.
   *
   * It is the outermost of three defences, not the only one: the host holds a
   * synchronous in-flight ref, and decideCashTenderSubmission refuses while a
   * submission is outstanding. This one keeps the other two from ever being
   * asked thousands of times.
   */
  function handleDoneKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.repeat && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
    }
  }

  /**
   * Enter in the cash field does NOTHING. It must not start a sale.
   *
   * THIS IS A CORRECTION, AND THE REASON MATTERS. An earlier version had Enter
   * here call onDone, mirroring the Done button. A keyboard-wedge barcode
   * scanner is a keyboard: it types a code and then sends Enter. A SHORT,
   * all-digit code is indistinguishable from a typed amount, so it is accepted
   * into this field — and the Enter that followed it would then have completed
   * a sale the cashier never asked for, for an amount they never entered.
   *
   * Nothing in a key handler can tell that scan from typing; doing so needs
   * scan detection, which does not exist in this repository and is not this
   * component's to invent. So the submit route is removed instead: the scan
   * still lands in the field, where the cashier SEES it and clears it, and the
   * Enter that follows is inert.
   *
   * WHY A HANDLER AT ALL, RATHER THAN REMOVING onKeyDown. Nothing in the
   * runtime tree is a <form> today, so an unhandled Enter in a lone input
   * already does nothing — but that is a property of an ancestor this file does
   * not own. Neutralising Enter HERE makes the guarantee local and unconditional:
   * it survives some future ancestor becoming a form, which would otherwise turn
   * a scanner's Enter into an implicit submit again.
   *
   * DONE ITSELF IS UNAFFECTED. It is a real <button>, so Enter and Space
   * activate it natively whenever the cashier has focused it — which is an
   * explicit activation of Done, not a stray key in a text field.
   */
  function handleEntryKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-hidden" data-cash-tender-pad>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        <p className="text-sm font-semibold text-neutral-900">Cash Tender</p>

        {/* The existing bill total, restated — see the header for why the
            checkout's own row is not simply left above this pad. */}
        <div className="flex items-center justify-between rounded-xl border border-neutral-200 px-4 py-2.5">
          <span className="text-sm text-neutral-600">Order Total</span>
          <span className="text-base font-semibold tabular-nums text-neutral-900">
            {currencySymbol}
            {amountDueFixed}
          </span>
        </div>

        {/* A <label>, so tapping anywhere on the row puts the caret in the
            field — on a touch till the row is a much easier target than the
            number itself. */}
        <label className="flex items-center justify-between gap-3 rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-2.5 focus-within:border-blue-600">
          <span className="flex-none text-sm text-neutral-600">Cash Received</span>

          <span className="flex min-w-0 flex-1 items-baseline justify-end gap-1">
            <span className="flex-none text-base font-semibold text-neutral-500">
              {currencySymbol}
            </span>

            {/* type="text" with inputMode="decimal", NOT type="number": a
                number input accepts "e", "+" and "-", shows spinners that a
                cashier can drag, reports an empty string for values it considers
                invalid, and formats per browser locale. inputMode still brings
                up the numeric keypad on a touch device. */}
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              aria-label="Cash received"
              placeholder="0.00"
              value={entry}
              disabled={busy}
              onChange={(event) => apply(replaceCashEntry(entry, event.target.value))}
              onKeyDown={handleEntryKeyDown}
              className="w-full min-w-0 bg-transparent text-right text-base font-semibold tabular-nums text-neutral-900 outline-none placeholder:font-normal placeholder:text-neutral-400 disabled:cursor-not-allowed"
              data-cash-received
            />
          </span>
        </label>

        {/* Live Change Due. Present only when the entry actually covers the
            total: a figure here while the tender is short would be a number the
            cashier could hand over by mistake. */}
        <div
          className="flex items-center justify-between rounded-xl px-4 py-2.5"
          style={{ backgroundColor: changeFixed === null ? undefined : branding.accentColor }}
        >
          <span className={`text-sm ${changeFixed === null ? "text-neutral-400" : "text-white"}`}>
            Change Due
          </span>
          <span
            aria-live="polite"
            className={`text-base font-semibold tabular-nums ${
              changeFixed === null ? "text-neutral-400" : "text-white"
            }`}
            data-change-due
          >
            {changeFixed === null ? "—" : `${currencySymbol}${changeFixed}`}
          </span>
        </div>

        {/* Quick denominations. Additive — $20 twice is $40 — and taken
            EXCLUSIVELY from cashDenominations(currency), which lib/cashTender.ts
            names as the only approved source of which notes exist for a
            currency. Nothing in that module enforces membership, so this is
            where that documented obligation on the caller is met. */}
        <div className="grid grid-cols-3 gap-2">
          {cashDenominations(currency).map((note) => (
            <button
              key={note}
              type="button"
              disabled={busy}
              onClick={() => apply(applyCashEntryDenomination(entry, note))}
              className="rounded-xl border border-neutral-200 py-2 text-sm font-medium text-neutral-700 transition-colors hover:border-blue-600 hover:text-blue-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {currencySymbol}
              {note}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-3 gap-2">
          {KEYPAD_DIGITS.map((digit) => (
            <button
              key={digit}
              type="button"
              disabled={busy}
              onClick={() => apply(appendCashEntryDigit(entry, digit))}
              className={KEY_CLASS}
            >
              {digit}
            </button>
          ))}

          <button
            type="button"
            disabled={busy}
            aria-label="Decimal point"
            onClick={() => apply(appendCashEntryDecimalPoint(entry))}
            className={KEY_CLASS}
          >
            .
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() => apply(appendCashEntryDigit(entry, "0"))}
            className={KEY_CLASS}
          >
            0
          </button>

          <button
            type="button"
            disabled={busy}
            aria-label="Backspace"
            onClick={() => apply(backspaceCashEntry(entry))}
            className={KEY_CLASS}
          >
            ⌫
          </button>
        </div>
      </div>

      <div className="flex flex-none flex-col gap-2">
        {keyRefusal !== null && (
          <p aria-live="polite" className="text-center text-xs text-neutral-600">
            {keyRefusal}
          </p>
        )}

        {entryRefusal !== null && (
          <p aria-live="polite" className="text-center text-xs text-red-600">
            {entryRefusal}
            {shortfall === undefined ? "" : ` Short by ${currencySymbol}${shortfall}.`}
          </p>
        )}

        {pressRefusal !== null && (
          <p aria-live="polite" className="text-center text-xs text-red-600">
            {pressRefusal}
          </p>
        )}

        {saleError !== null && (
          <p aria-live="polite" className="text-center text-xs text-red-600">
            {saleError}
          </p>
        )}

        {/* Feature 24.5A's reason, stated at the control that is refused,
            exactly as the Complete Sale button states it. */}
        {blockedReason !== null && (
          <p className="text-center text-xs text-neutral-600">{blockedReason}</p>
        )}

        <button
          type="button"
          disabled={doneDisabled}
          onClick={onDone}
          onKeyDown={handleDoneKeyDown}
          className="w-full rounded-full bg-blue-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
          data-cash-tender-done
        >
          {busy ? "Saving..." : "Done"}
        </button>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setKeyRefusal(null);
              onEntryChange(clearCashEntry().entry);
            }}
            className="rounded-full border border-neutral-200 px-5 py-2.5 text-sm font-medium text-neutral-700 transition-colors hover:border-neutral-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Clear
          </button>

          {/* NAVIGATION, NOT A TENDER CONTROL. It returns to the payment-method
              step this screen was reached from, where the checkout's existing
              Cancel is unchanged — so nothing that could cancel or confirm a
              sale is duplicated here. */}
          <button
            type="button"
            disabled={busy}
            onClick={onBack}
            className="rounded-full border border-neutral-200 px-5 py-2.5 text-sm font-medium text-neutral-700 transition-colors hover:border-neutral-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Back
          </button>
        </div>
      </div>
    </div>
  );
}
