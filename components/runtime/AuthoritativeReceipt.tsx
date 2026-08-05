import type { CompletedSaleReceipt } from "@/lib/completedSale";
import { isNonZeroMoney } from "@/lib/completedSale";
import type { ProjectConfig } from "@/lib/projectConfig";

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

type AuthoritativeReceiptProps = {
  receipt: CompletedSaleReceipt;
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

export default function AuthoritativeReceipt({
  receipt,
  businessProfile,
  receiptSettings,
  currencySymbol,
}: AuthoritativeReceiptProps) {
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
          {formatReceiptDateTime(receipt.createdAt)}
        </p>
      </div>

      <div className="mt-3 border-t border-dashed border-neutral-300 pt-2">
        {receipt.items.map((item) => (
          <div key={item.itemId} className="flex justify-between gap-2 py-0.5">
            <span className="min-w-0 flex-1 truncate">
              {item.quantity} × {item.itemName}
            </span>
            {/* The server's stored line total, never quantity × price. */}
            <span className="flex-none tabular-nums">
              {currencySymbol}
              {item.lineTotal}
            </span>
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
