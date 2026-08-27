import {
  OFFLINE_RECEIPT_BANNER,
  OFFLINE_RECEIPT_EXPLANATION_LINES,
  OFFLINE_RECEIPT_REFERENCE_LABEL,
} from "@/lib/provisionalReceipt";
import type { ProvisionalReceipt } from "@/lib/provisionalReceipt";
import { isNonZeroMoney } from "@/lib/completedSale";
import type { ProjectConfig } from "@/lib/projectConfig";

// Feature 24.5E — the receipt for a sale saved on this device.
//
// A SEPARATE COMPONENT FROM AuthoritativeReceipt, deliberately, and for the
// same reason AuthoritativeReceipt is separate from the Builder's preview
// Receipt: the two render different KINDS of fact. AuthoritativeReceipt prints
// what the server recorded, including an order number the server allocated.
// This one prints what this device saved, and there is no order number to print
// — so there is no branch anywhere in here that could print one, and no prop
// through which a caller could supply one.
//
// EVERY MONEY VALUE IS A FIXED TWO-DECIMAL STRING already computed by
// lib/provisionalReceipt.ts from the pinned configuration. Nothing here calls
// toFixed, multiplies a price by a quantity, or sums lines into a total: the
// arithmetic happens once, in a pure function, against the same rules the cart
// on screen used — so the paper and the screen cannot disagree.
//
// THE WORDING IS THE OWNER-APPROVED COPY and is imported rather than typed
// here, so this component cannot drift from the approved text.

type OfflineReceiptProps = {
  receipt: ProvisionalReceipt;
  businessProfile: ProjectConfig["businessProfile"];
  receiptSettings: ProjectConfig["receipt"];
  currencySymbol: string;
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

export default function OfflineReceipt({
  receipt,
  businessProfile,
  receiptSettings,
  currencySymbol,
}: OfflineReceiptProps) {
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

      {/* The banner and the reference, together and above everything else, so
          nobody reading this receipt has to hunt for its status. The reference
          is shown UNCONDITIONALLY — showOrderNumber governs an order number,
          and this sale does not have one; suppressing the reference too would
          leave a receipt with no handle at all. */}
      <div className="mt-3 border-t border-dashed border-neutral-300 pt-2 text-center">
        <p className="text-sm font-semibold tracking-wide">{OFFLINE_RECEIPT_BANNER}</p>
        <p className="mt-0.5 tabular-nums">
          {OFFLINE_RECEIPT_REFERENCE_LABEL} {receipt.offlineReference}
        </p>
        {/* When the customer paid, on this device's clock. Not a server time,
            and never presented as one. */}
        <p className="text-neutral-500">{formatReceiptDateTime(receipt.occurredAt)}</p>
      </div>

      <div className="mt-3 border-t border-dashed border-neutral-300 pt-2">
        {receipt.items.map((item, index) => (
          // Two lines of the same product with different options share an
          // itemId, so the key includes the index — exactly as
          // AuthoritativeReceipt does. Nothing is re-sorted here.
          <div key={`${item.itemId}-${index}`} className="py-0.5">
            <div className="flex justify-between gap-2">
              <span className="min-w-0 flex-1 break-words">
                {item.quantity} × {item.itemName}
              </span>
              <span className="flex-none tabular-nums">
                {currencySymbol}
                {item.lineTotal}
              </span>
            </div>

            {item.modifiers.map((modifier) => (
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

        {receiptSettings.showTaxLine && isNonZeroMoney(receipt.taxAmount) && (
          <div className="flex justify-between py-0.5">
            <span>Tax</span>
            <span className="tabular-nums">
              {currencySymbol}
              {receipt.taxAmount}
            </span>
          </div>
        )}

        {receiptSettings.showTipLine && isNonZeroMoney(receipt.tipAmount) && (
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

        {/* A LABEL, never an authorization. POS Canvas does not process, approve
            or capture a card payment online, and it must not appear to do so
            offline — see docs/OFFLINE_ARCHITECTURE.md §10. */}
        {receiptSettings.showPaymentMethod && (
          <div className="flex justify-between py-0.5 text-neutral-500">
            <span>Paid by</span>
            <span>{receipt.paymentMethod === "cash" ? "Cash" : "Card"}</span>
          </div>
        )}
      </div>

      {/* The approved explanation. It states the sale is saved and that a
          receipt number is still to come — and never suggests the payment might
          not have gone through, which is what "unconfirmed" or "pending" would
          read as to the customer holding it. */}
      <div className="mt-3 border-t border-dashed border-neutral-300 pt-2 text-center">
        {OFFLINE_RECEIPT_EXPLANATION_LINES.map((line) => (
          <p key={line} className="text-neutral-600">
            {line}
          </p>
        ))}
      </div>

      {receiptSettings.footer.trim() !== "" && (
        <p className="mt-3 border-t border-dashed border-neutral-300 pt-2 text-center text-neutral-600">
          {receiptSettings.footer}
        </p>
      )}
    </div>
  );
}
