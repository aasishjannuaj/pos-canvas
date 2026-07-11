"use client";

import { MENU_CATEGORIES } from "./EditorShell";
import type { Currency, MenuItem, ProjectConfig } from "./EditorShell";

const currencySymbols: Record<Currency, string> = {
  USD: "$",
  CAD: "CA$",
  EUR: "€",
  GBP: "£",
};

// Static preview-only figure — the builder has no real order math yet.
const STATIC_TIP = 3;

const STATIC_SUBTOTAL = 20;

type EditorPreviewProps = {
  menuItems: MenuItem[];
  selectedItemId: string | null;
  onSelect: (id: string) => void;
  branding: ProjectConfig["branding"];
  tax: ProjectConfig["tax"];
  receipt: ProjectConfig["receipt"];
};

function calculateOrderSummary(tax: {
  enabled: boolean;
  rate: number;
  pricesIncludeTax: boolean;
}) {
  const subtotal = STATIC_SUBTOTAL;
  const safeRate = Number.isFinite(tax.rate) && tax.rate > 0 ? tax.rate : 0;

  if (!tax.enabled) {
    return { subtotal, taxAmount: 0, total: subtotal };
  }

  if (tax.pricesIncludeTax) {
    const taxAmount = subtotal - subtotal / (1 + safeRate / 100);
    return { subtotal, taxAmount, total: subtotal };
  }

  const taxAmount = subtotal * (safeRate / 100);
  return { subtotal, taxAmount, total: subtotal + taxAmount };
}

export default function EditorPreview({
  menuItems,
  selectedItemId,
  onSelect,
  branding,
  tax,
  receipt,
}: EditorPreviewProps) {
  const { subtotal, taxAmount, total } = calculateOrderSummary(tax);

  const currencySymbol = currencySymbols[receipt.currency];
  const orderNumber = `${receipt.orderPrefix}1001`;
  const finalTotal = receipt.tipsEnabled ? total + STATIC_TIP : total;

  return (
    <div className="flex flex-1 items-center justify-center overflow-auto bg-neutral-100 p-10">
      <div className="flex aspect-[9/16] w-full max-w-sm flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
        {/* POS Header */}
        <div
          className="flex-none px-4 py-3"
          style={{ backgroundColor: branding.accentColor }}
        >
          <span className="text-sm font-semibold tracking-tight text-white">
            {branding.businessName}
          </span>
        </div>

        {/* Section Tabs */}
        <div className="flex flex-none gap-2 border-b border-neutral-200 bg-white px-3 py-2">
          {MENU_CATEGORIES.map((section, index) => (
            <span
              key={section}
              className={
                index === 0
                  ? "rounded-full px-3 py-1.5 text-xs font-medium text-white"
                  : "rounded-full bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-600"
              }
              style={index === 0 ? { backgroundColor: branding.accentColor } : undefined}
            >
              {section}
            </span>
          ))}
        </div>

        {/* Menu Content */}
        <div className="flex-1 overflow-y-auto px-3 py-3">
          <div className="flex flex-col gap-4">
            {MENU_CATEGORIES.map((section) => {
              const sectionItems = menuItems.filter(
                (item) => item.category === section
              );

              if (sectionItems.length === 0) {
                return null;
              }

              return (
                <div key={section} className="flex flex-col gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                    {section}
                  </span>

                  <div className="grid grid-cols-2 gap-2">
                    {sectionItems.map((item) => {
                      const isSelected = selectedItemId === item.id;

                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => onSelect(item.id)}
                          className={`flex flex-col justify-between gap-2 rounded-lg border p-2.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
                            isSelected
                              ? "text-white"
                              : "border-neutral-200 bg-neutral-50 hover:border-neutral-300"
                          }`}
                          style={
                            isSelected
                              ? {
                                  backgroundColor: branding.accentColor,
                                  borderColor: branding.accentColor,
                                }
                              : undefined
                          }
                        >
                          <span
                            className={`text-xs font-medium leading-tight ${
                              isSelected ? "text-white" : "text-neutral-900"
                            }`}
                          >
                            {item.name}
                          </span>
                          <span
                            className="text-xs font-semibold"
                            style={{
                              color: isSelected ? "#FFFFFF" : branding.accentColor,
                            }}
                          >
                            {currencySymbol}
                            {item.price.toFixed(2)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Order Summary */}
        <div className="flex-none border-t border-neutral-200 bg-neutral-50 px-4 py-3">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
            Order {orderNumber}
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-xs text-neutral-600">
              <span>Subtotal</span>
              <span>
                {currencySymbol}
                {subtotal.toFixed(2)}
              </span>
            </div>

            {tax.enabled && tax.showTaxSeparately && (
              <div className="flex items-center justify-between text-xs text-neutral-600">
                <span>Tax</span>
                <span>
                  {currencySymbol}
                  {taxAmount.toFixed(2)}
                </span>
              </div>
            )}

            {receipt.tipsEnabled && (
              <div className="flex items-center justify-between text-xs text-neutral-600">
                <span>Tip</span>
                <span>
                  {currencySymbol}
                  {STATIC_TIP.toFixed(2)}
                </span>
              </div>
            )}

            <div className="flex items-center justify-between border-t border-neutral-200 pt-1 text-sm font-semibold text-neutral-900">
              <span>Total</span>
              <span>
                {currencySymbol}
                {finalTotal.toFixed(2)}
              </span>
            </div>
          </div>

          <p className="mt-2 text-center text-[11px] text-neutral-400">
            {receipt.footer}
          </p>
        </div>
      </div>
    </div>
  );
}
