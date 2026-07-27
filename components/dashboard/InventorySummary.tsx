"use client";

import { useState } from "react";
import type { MenuItem } from "@/components/editor/EditorShell";
import type { InventoryTransaction } from "@/lib/inventory.types";
import { RANGE_OPTIONS, matchesRange } from "@/lib/dateRange";
import type { DateRange } from "@/lib/dateRange";
import { productKey } from "@/lib/productKey";

// Feature 10.4 — same fixed low-stock threshold as the Business Dashboard.
const LOW_STOCK_THRESHOLD = 5;

type InventoryStatus =
  | "outOfStock"
  | "lowStock"
  | "inStock"
  | "notTracked"
  | "deleted";

const STATUS_LABELS: Record<InventoryStatus, string> = {
  outOfStock: "Out of Stock",
  lowStock: "Low Stock",
  inStock: "In Stock",
  notTracked: "Not Tracked",
  deleted: "Deleted",
};

// Out of Stock -> Low Stock -> In Stock -> Not Tracked -> Deleted.
const STATUS_PRIORITY: Record<InventoryStatus, number> = {
  outOfStock: 0,
  lowStock: 1,
  inStock: 2,
  notTracked: 3,
  deleted: 4,
};

const STATUS_STYLES: Record<InventoryStatus, string> = {
  outOfStock: "bg-red-50 text-red-600",
  lowStock: "bg-amber-50 text-amber-600",
  inStock: "bg-emerald-50 text-emerald-600",
  notTracked: "bg-neutral-100 text-neutral-500",
  deleted: "bg-neutral-100 text-neutral-400",
};

type InventoryRow = {
  key: string;
  productName: string;
  currentStock: number | null;
  status: InventoryStatus;
  unitsSold: number;
  unitsRestocked: number;
  adjustmentNet: number;
  totalNetMovement: number;
};

type SortMode = "status" | "stock" | "unitsSold" | "netMovement";

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: "status", label: "Status" },
  { value: "stock", label: "Current Stock" },
  { value: "unitsSold", label: "Units Sold" },
  { value: "netMovement", label: "Net Movement" },
];

type InventorySummaryProps = {
  menuItems: MenuItem[];
  inventoryTransactions: InventoryTransaction[];
  inventoryTransactionsError: string | null;
};

function statusForStock(stockQuantity: number): InventoryStatus {
  if (stockQuantity <= 0) {
    return "outOfStock";
  }
  if (stockQuantity <= LOW_STOCK_THRESHOLD) {
    return "lowStock";
  }
  return "inStock";
}

function formatSigned(value: number): string {
  return value > 0 ? `+${value}` : `${value}`;
}

function emptyRow(
  key: string,
  productName: string,
  currentStock: number | null,
  status: InventoryStatus
): InventoryRow {
  return {
    key,
    productName,
    currentStock,
    status,
    unitsSold: 0,
    unitsRestocked: 0,
    adjustmentNet: 0,
    totalNetMovement: 0,
  };
}

// Current stock always comes from projectConfig.menuItems — the single
// source of truth the rest of the editor already uses (restock/adjustment
// handlers write here, never to a separate table). Movement is folded in
// from inventory_transactions, matched primarily by item_id (stable even
// across a rename), falling back to item_name via productKey only if
// item_id is ever missing/blank.
//
// A transaction that doesn't resolve to a currently *tracked* product is
// never discarded — it still produces its own row:
//   - item_id matches a menu item that exists but has trackInventory=false
//     -> "Not Tracked" (current stock has no meaning for it, same
//     convention the rest of the app already uses for untracked items).
//   - item_id matches no current menu item at all -> "Deleted"; the
//     product name comes from the transaction's own historical snapshot,
//     since there is no current name to prefer.
function buildInventoryRows(
  menuItems: MenuItem[],
  transactionsInRange: InventoryTransaction[]
): InventoryRow[] {
  const rows = new Map<string, InventoryRow>();
  const menuItemById = new Map(menuItems.map((item) => [item.id, item]));

  for (const item of menuItems) {
    if (!item.trackInventory) {
      continue;
    }

    const key = productKey(item.id, item.name);
    rows.set(
      key,
      emptyRow(key, item.name, item.stockQuantity, statusForStock(item.stockQuantity))
    );
  }

  for (const transaction of transactionsInRange) {
    const key = productKey(transaction.itemId, transaction.itemName);
    let row = rows.get(key);

    if (!row) {
      const menuItem = menuItemById.get(transaction.itemId);

      row = menuItem
        ? emptyRow(key, menuItem.name, null, "notTracked")
        : emptyRow(key, transaction.itemName, null, "deleted");

      rows.set(key, row);
    }

    if (transaction.transactionType === "sale") {
      row.unitsSold += Math.abs(transaction.quantityChange);
    } else if (transaction.transactionType === "restock") {
      row.unitsRestocked += transaction.quantityChange;
    } else if (transaction.transactionType === "adjustment") {
      row.adjustmentNet += transaction.quantityChange;
    }

    row.totalNetMovement += transaction.quantityChange;
  }

  return Array.from(rows.values());
}

function sortRows(rows: InventoryRow[], sortMode: SortMode): InventoryRow[] {
  const sorted = [...rows];

  if (sortMode === "status") {
    sorted.sort((a, b) => {
      const priorityDiff = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
      return priorityDiff !== 0
        ? priorityDiff
        : a.productName.localeCompare(b.productName);
    });
  } else if (sortMode === "stock") {
    // Nulls (Not Tracked / Deleted) always sort after numeric stock values.
    sorted.sort((a, b) => {
      if (a.currentStock === null && b.currentStock === null) {
        return 0;
      }
      if (a.currentStock === null) {
        return 1;
      }
      if (b.currentStock === null) {
        return -1;
      }
      return b.currentStock - a.currentStock;
    });
  } else if (sortMode === "unitsSold") {
    sorted.sort((a, b) => b.unitsSold - a.unitsSold);
  } else {
    sorted.sort((a, b) => b.totalNetMovement - a.totalNetMovement);
  }

  return sorted;
}

export default function InventorySummary({
  menuItems,
  inventoryTransactions,
  inventoryTransactionsError,
}: InventorySummaryProps) {
  const [range, setRange] = useState<DateRange>("today");
  const [sortMode, setSortMode] = useState<SortMode>("status");

  const now = new Date();

  // Current-stock metrics depend only on menuItems, so they stay accurate
  // and visible even if the inventory-transactions query failed.
  const trackedItems = menuItems.filter((item) => item.trackInventory);
  const totalTrackedProducts = trackedItems.length;
  const totalUnitsInStock = trackedItems.reduce(
    (sum, item) => sum + item.stockQuantity,
    0
  );
  const lowStockCount = trackedItems.filter(
    (item) => item.stockQuantity >= 1 && item.stockQuantity <= LOW_STOCK_THRESHOLD
  ).length;
  const outOfStockCount = trackedItems.filter(
    (item) => item.stockQuantity <= 0
  ).length;

  // Movement-dependent data is treated as unavailable (not "zero") when the
  // loader failed — never folded into rows, and rendered as "—" below
  // rather than a misleading 0.
  const transactionsInRange = inventoryTransactionsError
    ? []
    : inventoryTransactions.filter((transaction) =>
        matchesRange(transaction.createdAt, range, now)
      );

  const netInventoryChange = transactionsInRange.reduce(
    (sum, transaction) => sum + transaction.quantityChange,
    0
  );

  const rows = buildInventoryRows(menuItems, transactionsInRange);
  const sortedRows = sortRows(rows, sortMode);

  const summaryStats: { label: string; value: string }[] = [
    { label: "Tracked Products", value: `${totalTrackedProducts}` },
    { label: "Units In Stock", value: `${totalUnitsInStock}` },
    { label: "Low-Stock Products", value: `${lowStockCount}` },
    { label: "Out-of-Stock Products", value: `${outOfStockCount}` },
  ];

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-auto bg-neutral-100 p-10">
      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold tracking-tight text-neutral-900">
          Inventory Summary
        </h2>

        <div className="flex flex-wrap gap-2">
          {RANGE_OPTIONS.map((option) => {
            const isActive = range === option.value;

            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setRange(option.value)}
                className={`rounded-full px-4 py-2 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
                  isActive
                    ? "bg-blue-600 text-white"
                    : "border border-neutral-200 text-neutral-700 hover:border-blue-600 hover:text-blue-600"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        {summaryStats.map((stat) => (
          <div
            key={stat.label}
            className="flex flex-col gap-2 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm"
          >
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              {stat.label}
            </span>
            <span className="text-2xl font-semibold text-neutral-900">
              {stat.value}
            </span>
          </div>
        ))}

        {inventoryTransactionsError ? (
          <div className="flex flex-col gap-1 rounded-2xl border border-red-200 bg-red-50 p-5 shadow-sm">
            <span className="text-xs font-medium uppercase tracking-wide text-red-400">
              Movement Unavailable
            </span>
            <span className="text-sm font-medium text-red-600">
              {inventoryTransactionsError}
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-2 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Net Inventory Change
            </span>
            <span className="text-2xl font-semibold text-neutral-900">
              {formatSigned(netInventoryChange)}
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
          Sort By
        </span>
        <div className="flex flex-wrap gap-2">
          {SORT_OPTIONS.map((option) => {
            const isActive = sortMode === option.value;

            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setSortMode(option.value)}
                className={`rounded-full px-4 py-2 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
                  isActive
                    ? "bg-blue-600 text-white"
                    : "border border-neutral-200 text-neutral-700 hover:border-blue-600 hover:text-blue-600"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white shadow-sm">
        {inventoryTransactionsError && (
          <p className="border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
            Movement data unavailable: {inventoryTransactionsError}. Current
            stock and status below are still accurate.
          </p>
        )}

        {sortedRows.length === 0 ? (
          <p className="p-6 text-center text-sm text-neutral-500">
            No inventory-tracked products yet.
          </p>
        ) : (
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-xs font-medium uppercase tracking-wide text-neutral-400">
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3 text-right">Current Stock</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Units Sold</th>
                <th className="px-4 py-3 text-right">Units Restocked</th>
                <th className="px-4 py-3 text-right">Adjustment Net</th>
                <th className="px-4 py-3 text-right">Net Movement</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => (
                <tr
                  key={row.key}
                  className="border-b border-neutral-100 text-neutral-900 last:border-b-0"
                >
                  <td className="px-4 py-3 font-medium">{row.productName}</td>
                  <td className="px-4 py-3 text-right">
                    {row.currentStock === null ? "—" : row.currentStock}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[row.status]}`}
                    >
                      {STATUS_LABELS[row.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {inventoryTransactionsError ? "—" : row.unitsSold}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {inventoryTransactionsError ? "—" : row.unitsRestocked}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {inventoryTransactionsError
                      ? "—"
                      : formatSigned(row.adjustmentNet)}
                  </td>
                  <td className="px-4 py-3 text-right font-medium">
                    {inventoryTransactionsError
                      ? "—"
                      : formatSigned(row.totalNetMovement)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
