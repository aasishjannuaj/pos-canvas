import type { ResolvedReceiptPresentation } from "@/lib/receiptPresentation";
import { shouldShowChargedLine } from "@/lib/receiptPresentation";
import type { CompletedSaleReceipt } from "@/lib/completedSale";

// Milestone 16, Feature 16.3 — Migration D3.
//
// Renders a COMPLETED sale strictly from what complete_sale_v2 returned. Every
// money value is printed as the exact two-decimal string the database produced;
// nothing here calls toFixed, multiplies a price by a quantity, or sums items
// into a total. If the displayed number could be derived in the browser, it
// could disagree with the stored order — which is the defect this component
// exists to close.
//
// Deliberately NOT a variant of components/editor/Receipt.tsx. That component
// serves the Builder preview, which has no server round-trip and legitimately
// works in JavaScript numbers. Keeping the two apart means a preview value can
// never be rendered as if it were an authoritative one.

// Feature 28C — ONE presentation prop, resolved by the caller.
//
// It replaces businessProfile + receiptSettings + currencySymbol, which were
// three independently-passed values that could disagree with each other, and
// which every caller read from TODAY'S configuration. The resolved value also
// carries where it came from, which is what decides whether a toggle set after
// the sale may hide a line the Total depends on.
type AuthoritativeReceiptProps = {
  receipt: CompletedSaleReceipt;
  presentation: ResolvedReceiptPresentation;
  /**
   * Feature 28A — WHEN the customer paid, when that is not createdAt.
   *
   * A sale queued offline is committed hours after it happened: createdAt is
   * the server clock, occurredAt is the till. The slip the customer was handed
   * carried occurredAt, so a reprint carrying createdAt would be the same sale
   * timestamped two different ways on two pieces of paper. Optional because a
   * live checkout has no such gap — the two are the same instant — and the
   * canonical receipt type has only createdAt to offer.
   */
  saleTime?: string | null;
};

function formatReceiptDateTime(value: string): string {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function AuthoritativeReceipt({
  receipt,
  presentation,
  saleTime,
}: AuthoritativeReceiptProps) {
  const { businessProfile, receipt: receiptSettings, currencySymbol } = presentation;

  const addressLines = [
    businessProfile.addressLine1,
    businessProfile.addressLine2,
    [businessProfile.city, businessProfile.state, businessProfile.postalCode]
      .filter((part) => part.trim() !== "")
      .join(" "),
  ].filter((line) => line.trim() !== "");

  return (
    <div className="mx-auto max-w-xs font-mono text-xs text-neutral-900">
      <div className="text-center">
        {receiptSettings.showBusinessName && (
          <p className="text-sm font-semibold">
            {businessProfile.businessName.trim()}
          </p>
        )}
        {addressLines.map((line) => (
          <p key={line} className="text-neutral-500">
            {line}
          </p>
        ))}
        {businessProfile.phone.trim() !== "" && (
          <p className="text-neutral-500">{businessProfile.phone}</p>
        )}
        {receiptSettings.headerMessage.trim() !== "" && (
          <p className="mt-2 text-neutral-600">{receiptSettings.headerMessage}</p>
        )}
      </div>

      <div className="mt-3 border-t border-dashed border-neutral-300 pt-2 text-center">
        {receiptSettings.showOrderNumber && (
          <p className="text-neutral-500">{receipt.orderNumber}</p>
        )}
        <p className="text-neutral-500">
          {formatReceiptDateTime(saleTime ?? receipt.createdAt)}
        </p>
      </div>

      <div className="mt-3 border-t border-dashed border-neutral-300 pt-2">
        {receipt.items.map((item, index) => (
          // Feature 18.2 — two lines of the same product with different options
          // share an itemId, so the key includes the index. The server already
          // returns them in a stable order; nothing is re-sorted here.
          <div key={`${item.itemId}-${index}`} className="py-0.5">
            <div className="flex justify-between gap-2">
              <span className="min-w-0 flex-1 break-words">
                {item.quantity} × {item.itemName}
              </span>
              {/* The server's stored line total, never quantity × price. */}
              <span className="flex-none tabular-nums">
                {currencySymbol}
                {item.lineTotal}
              </span>
            </div>

            {/* Feature 18.2 — modifiers come from the AUTHORITATIVE payload,
                which carries the names and prices recorded at sale time. They
                are never looked up in the current menu, so a renamed or
                repriced option cannot rewrite a printed receipt. An older
                payload has no `modifiers` key at all and renders nothing. */}
            {item.modifiers?.map((modifier) => (
              <div
                key={`${modifier.groupId}-${modifier.optionId}`}
                className="flex justify-between gap-2 pl-4 text-[11px] text-neutral-500"
              >
                <span className="min-w-0 flex-1 break-words">{modifier.optionName}</span>
                {modifier.priceAdjustment !== "0.00" && (
                  <span className="flex-none tabular-nums">
                    +{currencySymbol}
                    {modifier.priceAdjustment}
                  </span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="mt-2 border-t border-dashed border-neutral-300 pt-2">
        <div className="flex justify-between py-0.5">
          <span>Subtotal</span>
          <span className="tabular-nums">
            {currencySymbol}
            {receipt.subtotal}
          </span>
        </div>

        {/* Feature 28C — a charged line is never hidden by a setting made
            after the sale. shouldShowChargedLine still honours the toggle when
            the toggle IS the sale-time one; what it refuses is a receipt whose
            visible lines cannot add up to the Total printed below them. */}
        {shouldShowChargedLine({ amount: receipt.taxAmount }) && (
          <div className="flex justify-between py-0.5">
            <span>Tax</span>
            <span className="tabular-nums">
              {currencySymbol}
              {receipt.taxAmount}
            </span>
          </div>
        )}

        {shouldShowChargedLine({ amount: receipt.tipAmount }) && (
          <div className="flex justify-between py-0.5">
            <span>Tip</span>
            <span className="tabular-nums">
              {currencySymbol}
              {receipt.tipAmount}
            </span>
          </div>
        )}

        <div className="mt-1 flex justify-between border-t border-neutral-300 pt-1 font-semibold">
          <span>Total</span>
          <span className="tabular-nums">
            {currencySymbol}
            {receipt.total}
          </span>
        </div>

        {receiptSettings.showPaymentMethod && (
          <div className="flex justify-between py-0.5 text-neutral-500">
            <span>Paid by</span>
            <span>{receipt.paymentMethod === "cash" ? "Cash" : "Card"}</span>
          </div>
        )}
      </div>

      {receiptSettings.footer.trim() !== "" && (
        <p className="mt-3 border-t border-dashed border-neutral-300 pt-2 text-center text-neutral-600">
          {receiptSettings.footer}
        </p>
      )}
    </div>
  );
}
