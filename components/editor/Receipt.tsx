import { CURRENCY_SYMBOLS } from "./EditorShell";
import type { CompletedOrder, ProjectConfig } from "./EditorShell";

type ReceiptProps = {
  order: CompletedOrder;
  businessProfile: ProjectConfig["businessProfile"];
  receipt: ProjectConfig["receipt"];
};

// Matches the date/time format the app has always used for receipts.
function formatReceiptDateTime(createdAt: string): string {
  return new Date(createdAt).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Feature 13.1 — composes the second address line ("City, State Postal")
// from whichever of city/state/postalCode are present, never leaving a
// dangling comma or extra space when one or more parts are empty. Kept
// separate from addressLine1/addressLine2 (each its own line) rather than
// folded into one long string, per the "separate readable lines" preference.
function composeCityStateZip(
  city: string,
  state: string,
  postalCode: string
): string {
  const cityState = [city, state].filter(Boolean).join(", ");
  return [cityState, postalCode].filter(Boolean).join(" ");
}

// Feature 11.1/13.1 — the single shared receipt-rendering component. Used
// for the live Builder preview (with sample order data), the visible
// completed-sale receipt overlay, and the print-only copy — so the three can
// never drift out of sync with each other. Purely presentational: it never
// calls window.print() itself, and it never touches completedOrders or any
// persistence path — the caller owns both of those concerns.
//
// Feature 13.1 — business identity/contact now comes from businessProfile
// (the single source of truth shared with the POS header), not from
// branding/receipt. showBusinessName still gates only the business name;
// address/phone/email/website each render automatically whenever they have
// a non-empty trimmed value, with no separate visibility toggle (per the
// MVP scope) — an empty field simply renders no line, never a blank one.
export default function Receipt({ order, businessProfile, receipt }: ReceiptProps) {
  const currencySymbol = CURRENCY_SYMBOLS[receipt.currency];

  const trimmedBusinessName = businessProfile.businessName.trim();
  const trimmedAddressLine1 = businessProfile.addressLine1.trim();
  const trimmedAddressLine2 = businessProfile.addressLine2.trim();
  const cityStateZip = composeCityStateZip(
    businessProfile.city.trim(),
    businessProfile.state.trim(),
    businessProfile.postalCode.trim()
  );
  const trimmedPhone = businessProfile.phone.trim();
  const trimmedEmail = businessProfile.email.trim();
  const trimmedWebsite = businessProfile.website.trim();
  const trimmedHeader = receipt.headerMessage.trim();
  const trimmedFooter = receipt.footer.trim();

  return (
    <div className="flex flex-col gap-1 text-sm text-neutral-900">
      <div className="flex flex-col items-center gap-1 border-b border-neutral-200 pb-3 text-center">
        {receipt.showBusinessName && trimmedBusinessName && (
          <p className="text-sm font-semibold text-neutral-900">
            {trimmedBusinessName}
          </p>
        )}

        {trimmedAddressLine1 && (
          <p className="text-xs text-neutral-500">{trimmedAddressLine1}</p>
        )}

        {trimmedAddressLine2 && (
          <p className="text-xs text-neutral-500">{trimmedAddressLine2}</p>
        )}

        {cityStateZip && <p className="text-xs text-neutral-500">{cityStateZip}</p>}

        {trimmedPhone && <p className="text-xs text-neutral-500">{trimmedPhone}</p>}

        {trimmedEmail && <p className="text-xs text-neutral-500">{trimmedEmail}</p>}

        {trimmedWebsite && (
          <p className="text-xs text-neutral-500">{trimmedWebsite}</p>
        )}

        {receipt.showOrderNumber && (
          <p className="text-xs text-neutral-500">{order.orderNumber}</p>
        )}

        <p className="text-xs text-neutral-400">
          {formatReceiptDateTime(order.createdAt)}
        </p>

        {trimmedHeader && (
          <p className="mt-1 text-xs text-neutral-600">{trimmedHeader}</p>
        )}
      </div>

      <div className="flex flex-col gap-1.5 py-3">
        {order.items.map((item) => (
          <div
            key={item.itemId}
            className="flex items-center justify-between gap-2 text-xs text-neutral-600"
          >
            <span className="flex-1 truncate text-neutral-900">
              {item.quantity} × {item.name}
            </span>
            <span className="font-medium text-neutral-900">
              {currencySymbol}
              {(item.price * item.quantity).toFixed(2)}
            </span>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-1 border-t border-neutral-200 pt-2 text-xs text-neutral-600">
        <div className="flex items-center justify-between">
          <span>Subtotal</span>
          <span>
            {currencySymbol}
            {order.subtotal.toFixed(2)}
          </span>
        </div>

        {receipt.showTaxLine && order.taxAmount > 0 && (
          <div className="flex items-center justify-between">
            <span>Tax</span>
            <span>
              {currencySymbol}
              {order.taxAmount.toFixed(2)}
            </span>
          </div>
        )}

        {receipt.showTipLine && order.tip > 0 && (
          <div className="flex items-center justify-between">
            <span>Tip</span>
            <span>
              {currencySymbol}
              {order.tip.toFixed(2)}
            </span>
          </div>
        )}

        <div className="flex items-center justify-between border-t border-neutral-200 pt-1 text-sm font-semibold text-neutral-900">
          <span>Total</span>
          <span>
            {currencySymbol}
            {order.total.toFixed(2)}
          </span>
        </div>

        {receipt.showPaymentMethod && (
          <div className="flex items-center justify-between pt-1">
            <span>Payment</span>
            <span className="font-medium text-neutral-900">
              {order.paymentMethod === "cash" ? "Cash" : "Card"}
            </span>
          </div>
        )}
      </div>

      {trimmedFooter && (
        <p className="mt-3 text-center text-[11px] text-neutral-400">
          {trimmedFooter}
        </p>
      )}
    </div>
  );
}
