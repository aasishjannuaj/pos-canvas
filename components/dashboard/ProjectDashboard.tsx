"use client";

import { CURRENCY_SYMBOLS } from "@/components/editor/EditorShell";
import type { Currency, MenuItem } from "@/components/editor/EditorShell";
import type { OrderTotal } from "@/lib/dashboard.types";

// Feature 10.1 — fixed low-stock threshold, project-scoped, no new table.
const LOW_STOCK_THRESHOLD = 5;

type ProjectDashboardProps = {
  orderTotals: OrderTotal[];
  orderTotalsError: string | null;
  menuItems: MenuItem[];
  currency: Currency;
};

// Matches the app's existing (implicit) timezone convention: every other
// date display (formatOrderTime, formatReceiptDateTime, formatTransactionTime)
// calls toLocaleString with no explicit timeZone from a client component,
// which resolves to the viewer's browser-local time. "Today" here is
// computed the same way, rather than as a UTC day boundary on the server.
function isToday(createdAt: string): boolean {
  const orderDate = new Date(createdAt);
  const now = new Date();
  return orderDate.toDateString() === now.toDateString();
}

export default function ProjectDashboard({
  orderTotals,
  orderTotalsError,
  menuItems,
  currency,
}: ProjectDashboardProps) {
  const currencySymbol = CURRENCY_SYMBOLS[currency];

  // Every row in `orders` is already a completed, paid sale — see
  // lib/dashboard.server.ts for why no status filter is applied.
  const todaysOrders = orderTotals.filter((order) => isToday(order.createdAt));

  const todaysSalesTotal = todaysOrders.reduce(
    (sum, order) => sum + order.total,
    0
  );
  const todaysTransactionCount = todaysOrders.length;
  const todaysTaxCollected = todaysOrders.reduce(
    (sum, order) => sum + order.taxAmount,
    0
  );
  const averageOrderValue =
    todaysTransactionCount === 0
      ? 0
      : todaysSalesTotal / todaysTransactionCount;

  // Low-stock reads directly from projectConfig.menuItems (already loaded
  // for the editor), so it's unaffected by an orders-query failure and
  // stays visible either way.
  const lowStockCount = menuItems.filter(
    (item) => item.trackInventory && item.stockQuantity <= LOW_STOCK_THRESHOLD
  ).length;

  // The 4 sales-derived metrics all come from the same orders query, so a
  // failure there invalidates all 4 together. Rendering them as "0" in that
  // case would be indistinguishable from a real zero-sales day, so they are
  // replaced with an explicit error message instead — same red-text
  // convention used for saveError/restockError/adjustError elsewhere in the
  // editor.
  const salesStats: { label: string; value: string }[] = [
    {
      label: "Today's Sales",
      value: `${currencySymbol}${todaysSalesTotal.toFixed(2)}`,
    },
    {
      label: "Today's Transactions",
      value: `${todaysTransactionCount}`,
    },
    {
      label: "Average Order Value",
      value: `${currencySymbol}${averageOrderValue.toFixed(2)}`,
    },
    {
      label: "Today's Tax Collected",
      value: `${currencySymbol}${todaysTaxCollected.toFixed(2)}`,
    },
  ];

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-auto bg-neutral-100 p-10">
      <h2 className="text-lg font-semibold tracking-tight text-neutral-900">
        Dashboard
      </h2>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        {orderTotalsError ? (
          <div className="col-span-2 flex flex-col gap-1 rounded-2xl border border-red-200 bg-red-50 p-5 shadow-sm md:col-span-3">
            <span className="text-xs font-medium uppercase tracking-wide text-red-400">
              Sales Data Unavailable
            </span>
            <span className="text-sm font-medium text-red-600">
              {orderTotalsError}
            </span>
          </div>
        ) : (
          salesStats.map((stat) => (
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
          ))
        )}

        <div className="flex flex-col gap-2 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Low-Stock Items
          </span>
          <span className="text-2xl font-semibold text-neutral-900">
            {lowStockCount}
          </span>
        </div>
      </div>
    </div>
  );
}
