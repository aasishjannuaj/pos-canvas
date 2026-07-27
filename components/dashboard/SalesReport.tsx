"use client";

import { useState } from "react";
import { CURRENCY_SYMBOLS } from "@/components/editor/EditorShell";
import type { Currency } from "@/components/editor/EditorShell";
import type { OrderTotal } from "@/lib/dashboard.types";

type DateRange = "today" | "yesterday" | "last7" | "thisMonth" | "allTime";

const RANGE_OPTIONS: { value: DateRange; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last7", label: "Last 7 Days" },
  { value: "thisMonth", label: "This Month" },
  { value: "allTime", label: "All Time" },
];

type SalesReportProps = {
  orderTotals: OrderTotal[];
  orderTotalsError: string | null;
  currency: Currency;
};

function isSameLocalDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString();
}

// Every boundary here is computed from the browser's local clock (`now`),
// matching the app's existing implicit timezone convention — see
// ProjectDashboard's isToday for the same pattern.
function matchesRange(createdAt: string, range: DateRange, now: Date): boolean {
  if (range === "allTime") {
    return true;
  }

  const orderDate = new Date(createdAt);

  if (range === "today") {
    return isSameLocalDay(orderDate, now);
  }

  if (range === "yesterday") {
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    return isSameLocalDay(orderDate, yesterday);
  }

  if (range === "last7") {
    // Today plus the previous 6 calendar days = 7 days total, from local
    // midnight of the earliest day through now.
    const start = new Date(now);
    start.setDate(now.getDate() - 6);
    start.setHours(0, 0, 0, 0);
    return orderDate.getTime() >= start.getTime();
  }

  // thisMonth — from the 1st of the current local month through today.
  return (
    orderDate.getFullYear() === now.getFullYear() &&
    orderDate.getMonth() === now.getMonth()
  );
}

// Matches formatReceiptDateTime's shape in EditorPreview.tsx.
function formatDateTime(createdAt: string): string {
  return new Date(createdAt).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Matches the existing "Cash"/"Card" convention used for receipts.
function formatPaymentMethod(paymentMethod: OrderTotal["paymentMethod"]): string {
  return paymentMethod === "cash" ? "Cash" : "Card";
}

export default function SalesReport({
  orderTotals,
  orderTotalsError,
  currency,
}: SalesReportProps) {
  const [range, setRange] = useState<DateRange>("today");

  const currencySymbol = CURRENCY_SYMBOLS[currency];
  const now = new Date();

  // Every row in `orders` is already a completed, paid sale — see
  // lib/dashboard.server.ts for why no status filter is applied.
  const filteredOrders = orderTotals
    .filter((order) => matchesRange(order.createdAt, range, now))
    .sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

  const totalSales = filteredOrders.reduce((sum, order) => sum + order.total, 0);
  const transactionCount = filteredOrders.length;
  const taxCollected = filteredOrders.reduce(
    (sum, order) => sum + order.taxAmount,
    0
  );
  const averageOrderValue =
    transactionCount === 0 ? 0 : totalSales / transactionCount;

  const summaryStats: { label: string; value: string }[] = [
    { label: "Total Sales", value: `${currencySymbol}${totalSales.toFixed(2)}` },
    { label: "Transactions", value: `${transactionCount}` },
    {
      label: "Average Order Value",
      value: `${currencySymbol}${averageOrderValue.toFixed(2)}`,
    },
    {
      label: "Tax Collected",
      value: `${currencySymbol}${taxCollected.toFixed(2)}`,
    },
  ];

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-auto bg-neutral-100 p-10">
      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold tracking-tight text-neutral-900">
          Sales Report
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

      {orderTotalsError ? (
        <div className="flex flex-col gap-1 rounded-2xl border border-red-200 bg-red-50 p-5 shadow-sm">
          <span className="text-xs font-medium uppercase tracking-wide text-red-400">
            Sales Data Unavailable
          </span>
          <span className="text-sm font-medium text-red-600">
            {orderTotalsError}
          </span>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
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
          </div>

          <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white shadow-sm">
            {filteredOrders.length === 0 ? (
              <p className="p-6 text-center text-sm text-neutral-500">
                No sales in this range.
              </p>
            ) : (
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-xs font-medium uppercase tracking-wide text-neutral-400">
                    <th className="px-4 py-3">Date &amp; Time</th>
                    <th className="px-4 py-3">Order #</th>
                    <th className="px-4 py-3 text-right">Items</th>
                    <th className="px-4 py-3 text-right">Subtotal</th>
                    <th className="px-4 py-3 text-right">Tax</th>
                    <th className="px-4 py-3 text-right">Tip</th>
                    <th className="px-4 py-3 text-right">Total</th>
                    <th className="px-4 py-3">Payment</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredOrders.map((order) => (
                    <tr
                      key={order.id}
                      className="border-b border-neutral-100 text-neutral-900 last:border-b-0"
                    >
                      <td className="px-4 py-3 text-neutral-600">
                        {formatDateTime(order.createdAt)}
                      </td>
                      <td className="px-4 py-3 font-medium">
                        {order.orderNumber}
                      </td>
                      <td className="px-4 py-3 text-right">{order.itemCount}</td>
                      <td className="px-4 py-3 text-right">
                        {currencySymbol}
                        {order.subtotal.toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {currencySymbol}
                        {order.taxAmount.toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {currencySymbol}
                        {order.tip.toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right font-medium">
                        {currencySymbol}
                        {order.total.toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-neutral-600">
                        {formatPaymentMethod(order.paymentMethod)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
