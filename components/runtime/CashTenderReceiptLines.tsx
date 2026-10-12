// v1.3 CP-2C — Cash Tendered and Change Due on a cash receipt.
//
// ONE COMPONENT, RENDERED BY BOTH RECEIPTS. AuthoritativeReceipt (a server
// payload) and OfflineReceipt (a provisional record) print identical markup
// here, and two copies of it would drift the moment either was touched.
//
// IT ADDS NOTHING TO THE SALE. Both receipts' Subtotal, Tax, Tip and Total come
// from their own payload and are not read, recomputed or adjusted here — this
// renders two extra lines BELOW the Total describing how the money crossed the
// counter. The decision about whether they may be printed at all is
// cashTenderReceiptLines in lib/cashTenderEntry.ts, which is pure and tested;
// this file holds no rule of its own.

import type { CashTenderOutcome } from "@/lib/cashTenderEntry";
import { cashTenderReceiptLines } from "@/lib/cashTenderEntry";

type CashTenderReceiptLinesProps = {
  paymentMethod: "cash" | "card";
  outcome: CashTenderOutcome | null;
  /** The total this receipt prints, so the two lines can be checked against it. */
  receiptTotalFixed: string;
  currencySymbol: string;
};

export default function CashTenderReceiptLines({
  paymentMethod,
  outcome,
  receiptTotalFixed,
  currencySymbol,
}: CashTenderReceiptLinesProps) {
  const lines = cashTenderReceiptLines({ paymentMethod, outcome, receiptTotalFixed });

  // A card sale, no tender in hand, a figure that did not round-trip through
  // lib/money.ts, or a tender that does not reconcile against the total printed
  // above. Printing nothing is the honest outcome — see the resolver.
  if (lines === null) {
    return null;
  }

  return (
    <>
      <div className="flex justify-between py-0.5 text-neutral-600">
        <span>Cash Tendered</span>
        <span className="tabular-nums">
          {currencySymbol}
          {lines.tenderedFixed}
        </span>
      </div>

      <div className="flex justify-between py-0.5 text-neutral-600">
        <span>Change Due</span>
        <span className="tabular-nums">
          {currencySymbol}
          {lines.changeFixed}
        </span>
      </div>
    </>
  );
}
