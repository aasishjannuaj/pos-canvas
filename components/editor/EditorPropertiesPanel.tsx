"use client";

import { useState } from "react";
import { CURRENCY_SYMBOLS, MENU_CATEGORIES } from "./EditorShell";
import type {
  CartSummary,
  CheckoutStatus,
  CompletedOrder,
  Currency,
  EditorMode,
  EditorSection,
  MenuCategory,
  MenuItem,
  PaymentMethod,
  ProjectConfig,
  RestockStatus,
} from "./EditorShell";
import type { InventoryTransaction } from "@/lib/inventory.types";

const currencyOptions: Currency[] = ["USD", "CAD", "EUR", "GBP"];

type EditorPropertiesPanelProps = {
  editorSection: EditorSection;
  selectedItem: MenuItem | null;
  onUpdate: (id: string, changes: Partial<MenuItem>) => void;
  onAdd: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  branding: ProjectConfig["branding"];
  onBrandingChange: (changes: Partial<ProjectConfig["branding"]>) => void;
  tax: ProjectConfig["tax"];
  onTaxChange: (changes: Partial<ProjectConfig["tax"]>) => void;
  receipt: ProjectConfig["receipt"];
  onReceiptChange: (changes: Partial<ProjectConfig["receipt"]>) => void;
  editorMode: EditorMode;
  cartSummary: CartSummary;
  selectedPaymentMethod: PaymentMethod | null;
  checkoutStatus: CheckoutStatus;
  completedOrders: CompletedOrder[];
  inventoryTransactions: InventoryTransaction[];
  menuItems: MenuItem[];
  projectId: string | null;
  restockStatus: RestockStatus;
  restockError: string | null;
  restockSuccessMessage: string | null;
  onRestock: (itemId: string, quantity: number) => void;
};

function formatTransactionTime(createdAt: string): string {
  return new Date(createdAt).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function EditorPropertiesPanel({
  editorSection,
  selectedItem,
  onUpdate,
  onAdd,
  onDuplicate,
  onDelete,
  branding,
  onBrandingChange,
  tax,
  onTaxChange,
  receipt,
  onReceiptChange,
  editorMode,
  cartSummary,
  selectedPaymentMethod,
  checkoutStatus,
  completedOrders,
  inventoryTransactions,
  menuItems,
  projectId,
  restockStatus,
  restockError,
  restockSuccessMessage,
  onRestock,
}: EditorPropertiesPanelProps) {
  const currencySymbol = CURRENCY_SYMBOLS[receipt.currency];
  // Feature 8.4 — completedOrders is newest-first, so index 0 is the latest
  // order (previously this read the last array element, back when new
  // orders were appended rather than prepended).
  const latestOrder = completedOrders[0] ?? null;
  // Feature 9.4 — inventoryTransactions is also newest-first.
  const recentTransactions = inventoryTransactions.slice(0, 10);

  // Feature 9.6 — restock form. Purely local UI state: which item is
  // selected and what quantity has been typed. Neither needs to be shared
  // with EditorPreview, so it isn't lifted to EditorShell.
  const [selectedRestockItemId, setSelectedRestockItemId] = useState<
    string | null
  >(null);
  const [restockQuantityInput, setRestockQuantityInput] = useState("");

  const trackedItems = menuItems.filter((item) => item.trackInventory);
  const effectiveRestockItemId =
    selectedRestockItemId ?? trackedItems[0]?.id ?? null;
  const restockItem =
    trackedItems.find((item) => item.id === effectiveRestockItemId) ?? null;

  const parsedRestockQuantity = Number(restockQuantityInput);
  const isRestockQuantityValid =
    restockQuantityInput.trim() !== "" &&
    Number.isInteger(parsedRestockQuantity) &&
    parsedRestockQuantity > 0;

  const restockDisabled =
    !restockItem ||
    !isRestockQuantityValid ||
    restockStatus === "saving" ||
    projectId === null;

  function handleRestockClick() {
    if (restockItem && isRestockQuantityValid) {
      onRestock(restockItem.id, parsedRestockQuantity);
    }
  }

  return (
    <aside className="flex w-80 flex-none flex-col gap-4 border-l border-neutral-200 bg-white p-6">
      {editorMode === "preview" ? (
        <>
          <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
            Cart Summary
          </h2>

          <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-neutral-600">Items</span>
              <span className="font-medium text-neutral-900">
                {cartSummary.itemCount}
              </span>
            </div>

            <div className="flex items-center justify-between text-sm">
              <span className="text-neutral-600">Subtotal</span>
              <span className="font-medium text-neutral-900">
                {currencySymbol}
                {cartSummary.subtotal.toFixed(2)}
              </span>
            </div>

            <div className="flex items-center justify-between text-sm">
              <span className="text-neutral-600">Tax</span>
              <span className="font-medium text-neutral-900">
                {currencySymbol}
                {cartSummary.taxAmount.toFixed(2)}
              </span>
            </div>

            <div className="flex items-center justify-between border-t border-neutral-200 pt-3 text-sm font-semibold text-neutral-900">
              <span>Total</span>
              <span>
                {currencySymbol}
                {cartSummary.total.toFixed(2)}
              </span>
            </div>
          </div>

          {checkoutStatus === "success" ? (
            <p className="rounded-xl bg-emerald-50 px-4 py-3 text-center text-sm font-medium text-emerald-700">
              Sale completed
            </p>
          ) : (
            <div className="flex flex-col gap-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-neutral-600">Checkout Status</span>
                <span className="font-medium text-neutral-900">
                  {cartSummary.itemCount > 0 ? "Ready to checkout" : "Cart empty"}
                </span>
              </div>

              {selectedPaymentMethod && (
                <div className="flex items-center justify-between">
                  <span className="text-neutral-600">Payment Method</span>
                  <span className="font-medium text-neutral-900">
                    {selectedPaymentMethod === "cash" ? "Cash" : "Card"}
                  </span>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col gap-2 border-t border-neutral-200 pt-4 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-neutral-600">Completed Orders</span>
              <span className="font-medium text-neutral-900">
                {completedOrders.length}
              </span>
            </div>

            {latestOrder && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-neutral-600">Latest Order</span>
                  <span className="font-medium text-neutral-900">
                    {latestOrder.orderNumber}
                  </span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-neutral-600">Latest Total</span>
                  <span className="font-medium text-neutral-900">
                    {currencySymbol}
                    {latestOrder.total.toFixed(2)}
                  </span>
                </div>
              </>
            )}
          </div>

          <div className="flex flex-col gap-3 border-t border-neutral-200 pt-4">
            <h3 className="text-sm font-semibold tracking-tight text-neutral-900">
              Restock Inventory
            </h3>

            {trackedItems.length === 0 ? (
              <p className="text-sm text-neutral-500">
                No inventory-tracked items available.
              </p>
            ) : (
              <>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                    Item
                  </label>
                  <select
                    value={effectiveRestockItemId ?? ""}
                    onChange={(event) =>
                      setSelectedRestockItemId(event.target.value)
                    }
                    className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none"
                  >
                    {trackedItems.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  {restockItem && (
                    <span className="text-xs text-neutral-500">
                      Current stock: {restockItem.stockQuantity}
                    </span>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                    Quantity to Add
                  </label>
                  <input
                    type="number"
                    step="1"
                    min="1"
                    value={restockQuantityInput}
                    onChange={(event) =>
                      setRestockQuantityInput(event.target.value)
                    }
                    className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none"
                  />
                </div>

                {projectId === null && (
                  <p className="text-xs text-red-600">
                    Save this project before restocking inventory.
                  </p>
                )}

                {restockStatus === "error" && restockError && (
                  <p className="text-xs text-red-600">{restockError}</p>
                )}

                {restockStatus === "success" && restockSuccessMessage && (
                  <p className="text-xs text-emerald-600">
                    {restockSuccessMessage}
                  </p>
                )}

                <button
                  type="button"
                  onClick={handleRestockClick}
                  disabled={restockDisabled}
                  className="w-full rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {restockStatus === "saving" ? "Restocking..." : "Restock"}
                </button>
              </>
            )}
          </div>

          <div className="flex flex-col gap-2 border-t border-neutral-200 pt-4">
            <h3 className="text-sm font-semibold tracking-tight text-neutral-900">
              Inventory Activity
            </h3>

            {recentTransactions.length === 0 ? (
              <p className="text-sm text-neutral-500">No inventory activity yet.</p>
            ) : (
              <div className="flex flex-col gap-3">
                {recentTransactions.map((transaction) => (
                  <div key={transaction.id} className="flex flex-col gap-0.5">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium text-neutral-900">
                        {transaction.itemName}
                      </span>
                      <span
                        className={
                          transaction.quantityChange < 0
                            ? "font-medium text-red-600"
                            : "font-medium text-emerald-600"
                        }
                      >
                        {transaction.quantityChange > 0 ? "+" : ""}
                        {transaction.quantityChange}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-xs text-neutral-500">
                      <span className="capitalize">{transaction.transactionType}</span>
                      <span>
                        {transaction.quantityBefore} → {transaction.quantityAfter}
                      </span>
                    </div>

                    <span className="text-xs text-neutral-400">
                      {formatTransactionTime(transaction.createdAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
            {editorSection}
          </h2>

          {editorSection === "Menu" && (
            <>
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={onAdd}
                  className="w-full rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                >
                  + Add Item
                </button>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={onDuplicate}
                    disabled={!selectedItem}
                    className="flex-1 rounded-full border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:border-blue-600 hover:text-blue-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:border-neutral-100 disabled:text-neutral-300 disabled:hover:border-neutral-100 disabled:hover:text-neutral-300"
                  >
                    Duplicate Item
                  </button>

                  <button
                    type="button"
                    onClick={onDelete}
                    disabled={!selectedItem}
                    className="flex-1 rounded-full border border-neutral-200 px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:border-red-600 hover:bg-red-600 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 disabled:cursor-not-allowed disabled:border-neutral-100 disabled:text-neutral-300 disabled:hover:border-neutral-100 disabled:hover:bg-transparent disabled:hover:text-neutral-300"
                  >
                    Delete Item
                  </button>
                </div>
              </div>

              {selectedItem ? (
                <div className="flex flex-col gap-4 border-t border-neutral-200 pt-4">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                      Item Name
                    </label>
                    <input
                      type="text"
                      value={selectedItem.name}
                      onChange={(event) =>
                        onUpdate(selectedItem.id, { name: event.target.value })
                      }
                      className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none"
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                      Price
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={selectedItem.price}
                      onChange={(event) =>
                        onUpdate(selectedItem.id, {
                          price: Number(event.target.value) || 0,
                        })
                      }
                      className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none"
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                      Category
                    </label>
                    <select
                      value={selectedItem.category}
                      onChange={(event) =>
                        onUpdate(selectedItem.id, {
                          category: event.target.value as MenuCategory,
                        })
                      }
                      className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none"
                    >
                      {MENU_CATEGORIES.map((category) => (
                        <option key={category} value={category}>
                          {category}
                        </option>
                      ))}
                    </select>
                  </div>

                  <label className="flex items-center justify-between gap-3 rounded-xl border border-neutral-200 px-4 py-3">
                    <span className="text-sm font-medium text-neutral-900">
                      Track Inventory
                    </span>
                    <input
                      type="checkbox"
                      checked={selectedItem.trackInventory}
                      onChange={(event) =>
                        onUpdate(selectedItem.id, {
                          trackInventory: event.target.checked,
                        })
                      }
                      className="h-4 w-4 cursor-pointer accent-blue-600"
                    />
                  </label>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                      Stock Quantity
                    </label>
                    <input
                      type="number"
                      step="1"
                      min="0"
                      value={selectedItem.stockQuantity}
                      disabled={!selectedItem.trackInventory}
                      onChange={(event) =>
                        onUpdate(selectedItem.id, {
                          stockQuantity: Math.max(
                            0,
                            Math.floor(Number(event.target.value) || 0)
                          ),
                        })
                      }
                      className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-400"
                    />
                  </div>
                </div>
              ) : (
                <div className="mt-4 flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-neutral-200 p-6 text-center">
                  <span className="text-2xl">🧩</span>
                  <p className="text-sm text-neutral-500">
                    Select an item in the preview to edit its properties.
                  </p>
                </div>
              )}
            </>
          )}

          {editorSection === "Branding" && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                  Business Name
                </label>
                <input
                  type="text"
                  value={branding.businessName}
                  onChange={(event) =>
                    onBrandingChange({ businessName: event.target.value })
                  }
                  className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                  Accent Color
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={branding.accentColor}
                    onChange={(event) =>
                      onBrandingChange({ accentColor: event.target.value })
                    }
                    className="h-10 w-14 cursor-pointer rounded-lg border border-neutral-200 p-1"
                  />
                  <span className="text-sm text-neutral-600">{branding.accentColor}</span>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                  Logo
                </label>
                <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-neutral-200 p-6 text-center">
                  <span className="text-2xl">🖼️</span>
                  <p className="text-sm text-neutral-500">
                    Logo upload coming soon
                  </p>
                </div>
              </div>
            </div>
          )}

          {editorSection === "Taxes" && (
            <div className="flex flex-col gap-4">
              <label className="flex items-center justify-between gap-3 rounded-xl border border-neutral-200 px-4 py-3">
                <span className="text-sm font-medium text-neutral-900">
                  Enable Tax
                </span>
                <input
                  type="checkbox"
                  checked={tax.enabled}
                  onChange={(event) => onTaxChange({ enabled: event.target.checked })}
                  className="h-4 w-4 cursor-pointer accent-blue-600"
                />
              </label>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                  Tax Rate
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={tax.rate}
                    disabled={!tax.enabled}
                    onChange={(event) =>
                      onTaxChange({
                        rate: Math.max(0, Number(event.target.value) || 0),
                      })
                    }
                    className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-400"
                  />
                  <span className="text-sm font-medium text-neutral-500">%</span>
                </div>
              </div>

              <label className="flex items-center justify-between gap-3 rounded-xl border border-neutral-200 px-4 py-3">
                <span className="text-sm font-medium text-neutral-900">
                  Prices Include Tax
                </span>
                <input
                  type="checkbox"
                  checked={tax.pricesIncludeTax}
                  disabled={!tax.enabled}
                  onChange={(event) =>
                    onTaxChange({ pricesIncludeTax: event.target.checked })
                  }
                  className="h-4 w-4 cursor-pointer accent-blue-600 disabled:cursor-not-allowed"
                />
              </label>

              <label className="flex items-center justify-between gap-3 rounded-xl border border-neutral-200 px-4 py-3">
                <span className="text-sm font-medium text-neutral-900">
                  Show Tax Separately
                </span>
                <input
                  type="checkbox"
                  checked={tax.showTaxSeparately}
                  disabled={!tax.enabled}
                  onChange={(event) =>
                    onTaxChange({ showTaxSeparately: event.target.checked })
                  }
                  className="h-4 w-4 cursor-pointer accent-blue-600 disabled:cursor-not-allowed"
                />
              </label>
            </div>
          )}

          {editorSection === "Settings" && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                  Currency
                </label>
                <select
                  value={receipt.currency}
                  onChange={(event) =>
                    onReceiptChange({ currency: event.target.value as Currency })
                  }
                  className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none"
                >
                  {currencyOptions.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                  Receipt Footer
                </label>
                <textarea
                  value={receipt.footer}
                  onChange={(event) => onReceiptChange({ footer: event.target.value })}
                  rows={3}
                  className="resize-none rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                  Order Prefix
                </label>
                <input
                  type="text"
                  value={receipt.orderPrefix}
                  onChange={(event) =>
                    onReceiptChange({ orderPrefix: event.target.value })
                  }
                  className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none"
                />
              </div>

              <label className="flex items-center justify-between gap-3 rounded-xl border border-neutral-200 px-4 py-3">
                <span className="text-sm font-medium text-neutral-900">
                  Enable Tips
                </span>
                <input
                  type="checkbox"
                  checked={receipt.tipsEnabled}
                  onChange={(event) =>
                    onReceiptChange({ tipsEnabled: event.target.checked })
                  }
                  className="h-4 w-4 cursor-pointer accent-blue-600"
                />
              </label>
            </div>
          )}
        </>
      )}
    </aside>
  );
}
