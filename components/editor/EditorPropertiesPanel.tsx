"use client";

import { useState } from "react";
import Link from "next/link";
import { CURRENCY_SYMBOLS } from "./EditorShell";
import type {
  AdjustStatus,
  CartSummary,
  CheckoutStatus,
  CompletedOrder,
  Currency,
  EditorMode,
  EditorSection,
  ExportStatus,
  MenuItem,
  PaymentMethod,
  ProjectConfig,
  RestockStatus,
} from "./EditorShell";
import type { InventoryTransaction } from "@/lib/inventory.types";
import type { GeneratedPosExportEligibility } from "@/lib/generatedPosConfig";
import {
  getBuildRequestButtonLabel,
  getBuildRequestSuccessMessage,
  getBuildStatusLabel,
  getBuildTargetLabel,
} from "@/lib/buildJobs";
import type {
  BuildJobSummary,
  BuildRequestStatus,
  BuildTarget,
} from "@/lib/buildJobs";

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
  businessProfile: ProjectConfig["businessProfile"];
  onBusinessProfileChange: (
    changes: Partial<ProjectConfig["businessProfile"]>
  ) => void;
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
  adjustStatus: AdjustStatus;
  adjustError: string | null;
  adjustSuccessMessage: string | null;
  onAdjust: (itemId: string, newQuantity: number) => void;
  // Feature 14.4 — null whenever there's no saved project id yet
  // (mirrors exportEligibility.canExport being false for the same reason).
  // A plain value passed down from EditorShell, never state.
  runtimeUrl: string | null;
  exportEligibility: GeneratedPosExportEligibility;
  exportStatus: ExportStatus;
  exportError: string | null;
  onExport: () => void;
  // Feature 15.4 — Build Application. exportEligibility is reused as-is
  // (unrenamed) for this block too, exactly as it already is for Launch
  // POS and Export POS JSON — build-request readiness is the same
  // question asked a third time.
  selectedBuildTarget: BuildTarget;
  onBuildTargetChange: (target: BuildTarget) => void;
  buildRequestStatus: BuildRequestStatus;
  buildRequestError: string | null;
  latestBuildJob: BuildJobSummary | null;
  latestBuildWasReused: boolean;
  onRequestBuild: () => void;
  onRefreshBuildStatus: () => void;
  isRefreshingBuildStatus: boolean;
  // Feature 15.7 — artifact download. Purely presentational, exactly like
  // the build-request props above: this component never calls a Server
  // Action, never touches Supabase Storage, and never receives a signed
  // URL, a storage path, or any artifact metadata — only a status, a
  // sanitized error string, and a click handler owned by EditorShell.
  downloadStatus: "idle" | "downloading";
  downloadError: string | null;
  onDownloadArtifact: () => void;
};

// Feature 14.2 — the single source of the Export sub-section's status
// text. Eligibility reasons take priority over exportStatus, since they
// describe *why the button is disabled right now* — once eligible, the
// export attempt's own lifecycle (idle/exporting/success/error) takes over.
function getExportStatusMessage(
  eligibility: GeneratedPosExportEligibility,
  exportStatus: ExportStatus
): string {
  if (eligibility.reason === "save-first") {
    return "Save this project before exporting.";
  }

  if (eligibility.reason === "saving") {
    return "Wait for the current save to finish.";
  }

  if (eligibility.reason === "save-changes-first") {
    return "Save your latest changes before exporting.";
  }

  if (exportStatus === "exporting") {
    return "Exporting…";
  }

  if (exportStatus === "success") {
    return "Export complete.";
  }

  if (exportStatus === "error") {
    return "Export failed.";
  }

  return "Ready to export.";
}

function getExportStatusClassName(
  eligibility: GeneratedPosExportEligibility,
  exportStatus: ExportStatus
): string {
  if (!eligibility.canExport) {
    return "text-neutral-500";
  }

  if (exportStatus === "success") {
    return "text-emerald-600";
  }

  if (exportStatus === "error") {
    return "text-red-600";
  }

  return "text-neutral-500";
}

// Feature 14.4 — reuses the exact same GeneratedPosExportEligibility
// reason codes as the Export status message above (unrenamed, per the
// approved plan) — Launch has no lifecycle of its own beyond eligibility,
// since it's a pure navigation action, not an async operation like Export.
function getLaunchStatusMessage(eligibility: GeneratedPosExportEligibility): string {
  if (eligibility.reason === "save-first") {
    return "Save this project before launching the POS.";
  }

  if (eligibility.reason === "saving") {
    return "Wait for the current save to finish.";
  }

  if (eligibility.reason === "save-changes-first") {
    return "Save your latest changes before launching the POS.";
  }

  return "Open the standalone POS runtime for this saved project.";
}

// Feature 15.4 — reuses the exact same GeneratedPosExportEligibility reason
// codes as Export/Launch above (unrenamed, per the approved plan), with
// build-request-specific copy for each.
function getBuildEligibilityMessage(
  eligibility: GeneratedPosExportEligibility
): string {
  if (eligibility.reason === "save-first") {
    return "Save this project before requesting a build.";
  }

  if (eligibility.reason === "saving") {
    return "Wait for the current save to finish.";
  }

  if (eligibility.reason === "save-changes-first") {
    return "Save your latest changes before requesting a build.";
  }

  return "Choose a target and request a build.";
}

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
  businessProfile,
  onBusinessProfileChange,
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
  adjustStatus,
  adjustError,
  adjustSuccessMessage,
  onAdjust,
  runtimeUrl,
  exportEligibility,
  exportStatus,
  exportError,
  onExport,
  selectedBuildTarget,
  onBuildTargetChange,
  buildRequestStatus,
  buildRequestError,
  latestBuildJob,
  latestBuildWasReused,
  onRequestBuild,
  onRefreshBuildStatus,
  isRefreshingBuildStatus,
  downloadStatus,
  downloadError,
  onDownloadArtifact,
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

  // Feature 9.7B — manual adjustment form. Same rationale as the restock
  // form above: purely local UI state, not shared with EditorPreview.
  const [selectedAdjustItemId, setSelectedAdjustItemId] = useState<
    string | null
  >(null);
  const [adjustQuantityInput, setAdjustQuantityInput] = useState("");

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

  const effectiveAdjustItemId =
    selectedAdjustItemId ?? trackedItems[0]?.id ?? null;
  const adjustItem =
    trackedItems.find((item) => item.id === effectiveAdjustItemId) ?? null;

  const parsedAdjustQuantity = Number(adjustQuantityInput);
  const isAdjustQuantityValid =
    adjustQuantityInput.trim() !== "" &&
    Number.isInteger(parsedAdjustQuantity) &&
    parsedAdjustQuantity >= 0;

  const adjustDisabled =
    !adjustItem ||
    !isAdjustQuantityValid ||
    adjustStatus === "saving" ||
    projectId === null;

  function handleAdjustClick() {
    if (adjustItem && isAdjustQuantityValid) {
      onAdjust(adjustItem.id, parsedAdjustQuantity);
    }
  }

  return (
    <aside className="flex w-80 min-h-0 flex-none flex-col gap-4 overflow-y-auto border-l border-neutral-200 bg-white p-6">
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

          <div className="flex flex-col gap-3 border-t border-neutral-200 pt-4">
            <h3 className="text-sm font-semibold tracking-tight text-neutral-900">
              Manual Inventory Adjustment
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
                    value={effectiveAdjustItemId ?? ""}
                    onChange={(event) =>
                      setSelectedAdjustItemId(event.target.value)
                    }
                    className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none"
                  >
                    {trackedItems.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  {adjustItem && (
                    <span className="text-xs text-neutral-500">
                      Current stock: {adjustItem.stockQuantity}
                    </span>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                    New Stock
                  </label>
                  <input
                    type="number"
                    step="1"
                    min="0"
                    value={adjustQuantityInput}
                    onChange={(event) =>
                      setAdjustQuantityInput(event.target.value)
                    }
                    className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none"
                  />
                </div>

                {projectId === null && (
                  <p className="text-xs text-red-600">
                    Save this project before adjusting inventory.
                  </p>
                )}

                {adjustStatus === "error" && adjustError && (
                  <p className="text-xs text-red-600">{adjustError}</p>
                )}

                {adjustStatus === "success" && adjustSuccessMessage && (
                  <p className="text-xs text-emerald-600">
                    {adjustSuccessMessage}
                  </p>
                )}

                <button
                  type="button"
                  onClick={handleAdjustClick}
                  disabled={adjustDisabled}
                  className="w-full rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {adjustStatus === "saving" ? "Adjusting..." : "Adjust Inventory"}
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
                    <input
                      type="text"
                      value={selectedItem.category}
                      onChange={(event) =>
                        onUpdate(selectedItem.id, {
                          category: event.target.value,
                        })
                      }
                      className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none"
                    />
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

          {/* Feature 13.1 — core business identity/contact, separate from
              Branding (visual appearance only) and Settings (receipt
              formatting/visibility only). Every field is optional and never
              blocks Save. Edits here update the POS header (business name)
              and receipt preview (all fields) immediately — same
              projectConfig state, same live-preview mechanism as every other
              section. */}
          {editorSection === "Business" && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                  Business Name
                </label>
                <input
                  type="text"
                  value={businessProfile.businessName}
                  onChange={(event) =>
                    onBusinessProfileChange({ businessName: event.target.value })
                  }
                  className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                  Address Line 1
                </label>
                <input
                  type="text"
                  value={businessProfile.addressLine1}
                  placeholder="Optional"
                  onChange={(event) =>
                    onBusinessProfileChange({ addressLine1: event.target.value })
                  }
                  className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                  Address Line 2
                </label>
                <input
                  type="text"
                  value={businessProfile.addressLine2}
                  placeholder="Optional"
                  onChange={(event) =>
                    onBusinessProfileChange({ addressLine2: event.target.value })
                  }
                  className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                  City
                </label>
                <input
                  type="text"
                  value={businessProfile.city}
                  placeholder="Optional"
                  onChange={(event) =>
                    onBusinessProfileChange({ city: event.target.value })
                  }
                  className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                  State / Region
                </label>
                <input
                  type="text"
                  value={businessProfile.state}
                  placeholder="Optional"
                  onChange={(event) =>
                    onBusinessProfileChange({ state: event.target.value })
                  }
                  className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                  Postal Code
                </label>
                <input
                  type="text"
                  value={businessProfile.postalCode}
                  placeholder="Optional"
                  onChange={(event) =>
                    onBusinessProfileChange({ postalCode: event.target.value })
                  }
                  className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                  Phone
                </label>
                <input
                  type="text"
                  value={businessProfile.phone}
                  placeholder="Optional"
                  onChange={(event) =>
                    onBusinessProfileChange({ phone: event.target.value })
                  }
                  className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                  Email
                </label>
                <input
                  type="text"
                  value={businessProfile.email}
                  placeholder="Optional"
                  onChange={(event) =>
                    onBusinessProfileChange({ email: event.target.value })
                  }
                  className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                  Website
                </label>
                <input
                  type="text"
                  value={businessProfile.website}
                  placeholder="Optional"
                  onChange={(event) =>
                    onBusinessProfileChange({ website: event.target.value })
                  }
                  className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none"
                />
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

          {editorSection === "Dashboard" && (
            <p className="text-sm text-neutral-500">
              Dashboard details are shown in the main content area.
            </p>
          )}

          {editorSection === "Sales Report" && (
            <p className="text-sm text-neutral-500">
              The sales report is shown in the main content area.
            </p>
          )}

          {editorSection === "Product Performance" && (
            <p className="text-sm text-neutral-500">
              Product performance is shown in the main content area.
            </p>
          )}

          {editorSection === "Inventory Summary" && (
            <p className="text-sm text-neutral-500">
              Inventory summary is shown in the main content area.
            </p>
          )}

          {editorSection === "Devices" && (
            <p className="text-sm text-neutral-500">
              Device pairing is shown in the main content area.
            </p>
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

              {/* Feature 11.1 — printable receipt content/layout. The live
                  preview in the main content area updates immediately as
                  these change (same receipt object, same Receipt component). */}
              <div className="flex flex-col gap-4 border-t border-neutral-200 pt-4">
                <h3 className="text-sm font-semibold tracking-tight text-neutral-900">
                  Receipt Content
                </h3>

                <label className="flex items-center justify-between gap-3 rounded-xl border border-neutral-200 px-4 py-3">
                  <span className="text-sm font-medium text-neutral-900">
                    Show Business Name
                  </span>
                  <input
                    type="checkbox"
                    checked={receipt.showBusinessName}
                    onChange={(event) =>
                      onReceiptChange({ showBusinessName: event.target.checked })
                    }
                    className="h-4 w-4 cursor-pointer accent-blue-600"
                  />
                </label>

                <p className="text-xs text-neutral-400">
                  Business address, phone, email, and website are managed in
                  the Business section and shown on the receipt automatically
                  when filled in.
                </p>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                    Receipt Header Message
                  </label>
                  <textarea
                    value={receipt.headerMessage}
                    placeholder="Optional"
                    onChange={(event) =>
                      onReceiptChange({ headerMessage: event.target.value })
                    }
                    rows={2}
                    className="resize-none rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none"
                  />
                </div>

                <label className="flex items-center justify-between gap-3 rounded-xl border border-neutral-200 px-4 py-3">
                  <span className="text-sm font-medium text-neutral-900">
                    Show Tax Line
                  </span>
                  <input
                    type="checkbox"
                    checked={receipt.showTaxLine}
                    onChange={(event) =>
                      onReceiptChange({ showTaxLine: event.target.checked })
                    }
                    className="h-4 w-4 cursor-pointer accent-blue-600"
                  />
                </label>

                <label className="flex items-center justify-between gap-3 rounded-xl border border-neutral-200 px-4 py-3">
                  <span className="text-sm font-medium text-neutral-900">
                    Show Tip Line
                  </span>
                  <input
                    type="checkbox"
                    checked={receipt.showTipLine}
                    onChange={(event) =>
                      onReceiptChange({ showTipLine: event.target.checked })
                    }
                    className="h-4 w-4 cursor-pointer accent-blue-600"
                  />
                </label>

                <label className="flex items-center justify-between gap-3 rounded-xl border border-neutral-200 px-4 py-3">
                  <span className="text-sm font-medium text-neutral-900">
                    Show Payment Method
                  </span>
                  <input
                    type="checkbox"
                    checked={receipt.showPaymentMethod}
                    onChange={(event) =>
                      onReceiptChange({ showPaymentMethod: event.target.checked })
                    }
                    className="h-4 w-4 cursor-pointer accent-blue-600"
                  />
                </label>

                <label className="flex items-center justify-between gap-3 rounded-xl border border-neutral-200 px-4 py-3">
                  <span className="text-sm font-medium text-neutral-900">
                    Show Order Number
                  </span>
                  <input
                    type="checkbox"
                    checked={receipt.showOrderNumber}
                    onChange={(event) =>
                      onReceiptChange({ showOrderNumber: event.target.checked })
                    }
                    className="h-4 w-4 cursor-pointer accent-blue-600"
                  />
                </label>
              </div>

              {/* Feature 14.4 — Launch POS and Feature 14.2 — Export POS
                  JSON, grouped together as "Run & Export": the two ways to
                  deliver this saved project's runtime. Purely
                  presentational — this component never generates the
                  runtime URL or the JSON itself, only reads the
                  eligibility/status props and renders accordingly. */}
              <div className="flex flex-col gap-4 border-t border-neutral-200 pt-4">
                <h3 className="text-sm font-semibold tracking-tight text-neutral-900">
                  Run &amp; Export
                </h3>

                {/* Launch POS */}
                <div className="flex flex-col gap-3">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                      Launch POS
                    </p>
                    <p className="mt-1 text-xs text-neutral-500">
                      Open the standalone POS runtime for this saved
                      project.
                    </p>
                  </div>

                  <span className="text-xs font-medium text-neutral-500">
                    {getLaunchStatusMessage(exportEligibility)}
                  </span>

                  {exportEligibility.canExport && runtimeUrl !== null ? (
                    <Link
                      href={runtimeUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="Launch POS, opens in a new tab"
                      className="w-full rounded-full bg-blue-600 px-4 py-2 text-center text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                    >
                      Launch POS ↗
                    </Link>
                  ) : (
                    // Feature 14.4 — a genuinely non-interactive element,
                    // never a real link styled to look disabled: no href,
                    // no onClick, not part of the tab order. The status
                    // text above already explains why, so this is
                    // aria-hidden rather than announced as an inert
                    // "button" a screen reader user might try to activate.
                    <span
                      aria-hidden="true"
                      className="w-full cursor-not-allowed rounded-full bg-blue-600 px-4 py-2 text-center text-sm font-medium text-white opacity-50"
                    >
                      Launch POS ↗
                    </span>
                  )}
                </div>

                {/* Export POS JSON */}
                <div className="flex flex-col gap-3 border-t border-neutral-200 pt-4">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                      Export POS JSON
                    </p>
                    <p className="mt-1 text-xs text-neutral-500">
                      Download a versioned runtime configuration for this
                      POS project.
                    </p>
                  </div>

                  <span
                    className={`text-xs font-medium ${getExportStatusClassName(
                      exportEligibility,
                      exportStatus
                    )}`}
                  >
                    {getExportStatusMessage(exportEligibility, exportStatus)}
                  </span>

                  {exportStatus === "error" && exportError && (
                    <span className="text-xs text-red-600">{exportError}</span>
                  )}

                  <button
                    type="button"
                    onClick={onExport}
                    disabled={
                      !exportEligibility.canExport || exportStatus === "exporting"
                    }
                    className="w-full rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {exportStatus === "exporting"
                      ? "Exporting…"
                      : "Export POS JSON"}
                  </button>
                </div>

                {/* Feature 15.4 — Build Application. Purely presentational:
                    this component never calls a Server Action, generates a
                    request key, or touches build_jobs itself — it only
                    reads the props EditorShell already computed and calls
                    onBuildTargetChange/onRequestBuild/onRefreshBuildStatus.
                    Reuses exportEligibility exactly as Launch POS/Export
                    POS JSON already do. */}
                <div className="flex flex-col gap-3 border-t border-neutral-200 pt-4">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                      Build Application
                    </p>
                    <p className="mt-1 text-xs text-neutral-500">
                      Create a queued build request from this saved POS
                      configuration.
                    </p>
                  </div>

                  {/* aria-live region — announces eligibility text, a
                      request failure, and the success/reused message as
                      they change, without requiring focus to move here. */}
                  <div aria-live="polite" className="flex flex-col gap-2">
                    <span className="text-xs font-medium text-neutral-500">
                      {getBuildEligibilityMessage(exportEligibility)}
                    </span>

                    <div
                      role="group"
                      aria-label="Build target"
                      className="grid grid-cols-2 gap-2"
                    >
                      {(["android", "desktop"] as const).map((target) => {
                        const isSelected = selectedBuildTarget === target;

                        return (
                          <button
                            key={target}
                            type="button"
                            aria-pressed={isSelected}
                            disabled={buildRequestStatus === "submitting"}
                            onClick={() => onBuildTargetChange(target)}
                            className={`rounded-xl border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50 ${
                              isSelected
                                ? "border-blue-600 bg-blue-600 text-white"
                                : "border-neutral-200 text-neutral-700 hover:border-blue-600 hover:text-blue-600"
                            }`}
                          >
                            {getBuildTargetLabel(target)}
                          </button>
                        );
                      })}
                    </div>

                    {buildRequestStatus === "error" && buildRequestError && (
                      <span className="text-xs text-red-600">
                        {buildRequestError}
                      </span>
                    )}

                    <button
                      type="button"
                      onClick={onRequestBuild}
                      disabled={
                        !exportEligibility.canExport ||
                        buildRequestStatus === "submitting"
                      }
                      className="w-full rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {getBuildRequestButtonLabel(buildRequestStatus)}
                    </button>

                    {buildRequestStatus === "success" && (
                      <span className="text-xs font-medium text-emerald-600">
                        {getBuildRequestSuccessMessage(latestBuildWasReused)}
                      </span>
                    )}
                  </div>

                  {latestBuildJob && (
                    // aria-live region — separate from the one above, since
                    // this reflects the displayed job's own status (which
                    // can also change from a manual refresh, independent of
                    // buildRequestStatus).
                    <div
                      aria-live="polite"
                      className="flex flex-col gap-1.5 rounded-xl border border-neutral-200 px-4 py-3 text-xs text-neutral-600"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-neutral-500">Target</span>
                        <span className="font-medium text-neutral-900">
                          {getBuildTargetLabel(latestBuildJob.target)}
                        </span>
                      </div>

                      <div className="flex items-center justify-between">
                        <span className="text-neutral-500">Status</span>
                        <span className="font-medium text-neutral-900">
                          {getBuildStatusLabel(latestBuildJob.status)}
                        </span>
                      </div>

                      <div className="flex items-center justify-between">
                        <span className="text-neutral-500">Requested</span>
                        <span className="font-medium text-neutral-900">
                          {formatTransactionTime(latestBuildJob.createdAt)}
                        </span>
                      </div>

                      {/* Feature 17.1 — replaces the pre-worker copy, which
                          said processing was "not enabled yet". A scheduled
                          GitHub Actions run now claims queued jobs, so that
                          sentence became untrue.
                          "about 15 minutes" matches the workflow's cadence and
                          is deliberately hedged: scheduled runs are best-effort
                          and GitHub can delay them, so this states a typical
                          case rather than a promise. No countdown and no
                          progress indicator — neither the browser nor the
                          server knows when the next run will actually fire. */}
                      {latestBuildJob.status === "queued" && (
                        <p className="mt-1 text-neutral-400">
                          Your build is queued and will be picked up
                          automatically. It usually starts within about 15
                          minutes, but automated runs can occasionally be
                          delayed. Use Refresh to check its status.
                        </p>
                      )}

                      {latestBuildJob.status === "building" && (
                        <p className="mt-1 text-neutral-400">
                          Your build is being processed. Use Refresh to check
                          its status.
                        </p>
                      )}

                      {latestBuildJob.status === "failed" &&
                        latestBuildJob.failureMessage && (
                          <p className="mt-1 text-red-600">
                            {latestBuildJob.failureMessage}
                          </p>
                        )}

                      {/* Feature 15.7 — the real download action, replacing
                          Feature 15.6's "download will be added in the next
                          feature" placeholder copy. Deliberately shows only
                          a button: no filename, storage path, checksum,
                          file size, artifact type, artifact id, expiration,
                          or signed URL is rendered anywhere here, and no
                          separate artifact-metadata query exists to
                          populate any of that. The status row above still
                          reads "Ready" (getBuildStatusLabel is unchanged).
                          Clicking calls EditorShell's handler, which
                          requests a fresh short-lived signed URL from the
                          Server Action — nothing about the artifact is in
                          this component's props or in the initial HTML. */}
                      {latestBuildJob.status === "succeeded" && (
                        <div className="mt-2 flex flex-col gap-1.5">
                          <button
                            type="button"
                            onClick={onDownloadArtifact}
                            disabled={downloadStatus === "downloading"}
                            className="w-full rounded-full bg-neutral-900 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-neutral-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {downloadStatus === "downloading"
                              ? "Downloading…"
                              : "Download configuration"}
                          </button>

                          {downloadError && (
                            <p className="text-red-600">{downloadError}</p>
                          )}
                        </div>
                      )}

                      {/* A refresh failure sets buildRequestError without
                          touching buildRequestStatus, so this is what
                          surfaces it — the request-failure message above
                          already covers buildRequestStatus === "error". */}
                      {buildRequestError && buildRequestStatus !== "error" && (
                        <p className="mt-1 text-red-600">{buildRequestError}</p>
                      )}

                      <button
                        type="button"
                        onClick={onRefreshBuildStatus}
                        disabled={isRefreshingBuildStatus}
                        className="mt-2 w-full rounded-full border border-neutral-200 px-4 py-2 text-xs font-medium text-neutral-700 transition-colors hover:border-blue-600 hover:text-blue-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isRefreshingBuildStatus
                          ? "Refreshing…"
                          : "Refresh status"}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </aside>
  );
}
