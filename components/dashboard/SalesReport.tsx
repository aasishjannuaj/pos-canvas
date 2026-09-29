"use client";

// v1.3 Task 5C — the Sales Report, told in BUSINESS days.
//
// WHAT CHANGED AND WHY. This report used to bucket sales with
// lib/dateRange.ts, whose every boundary is the VIEWER'S local midnight
// (`toDateString()`, `setHours(0,0,0,0)`). For a point of sale that is the
// wrong question: a shop that trades past midnight has a business day of its
// own, and two owners in two timezones would see two different "Today" for the
// same shop. Buckets now come from lib/salesReporting.ts, which is given the
// project's business timezone and the register's own recorded dates and reads
// no ambient timezone at all.
//
// dateRange.ts IS UNTOUCHED. Product Performance still uses it; nothing here
// redefines what it means for anyone else.
//
// THE MONEY IS NOT REDEFINED. Total Sales, Transactions, Average Order Value
// and Tax Collected are computed exactly as before, from the same fields, over
// whatever set of orders the range selects. Task 5C changes WHICH orders a
// range selects, not what a sale is worth.
import { useState } from "react";
import { CURRENCY_SYMBOLS } from "@/components/editor/EditorShell";
import type { Currency } from "@/components/editor/EditorShell";
import type { OrderTotal } from "@/lib/dashboard.types";
import type { OrderBusinessDate } from "@/lib/ownerReporting";
import {
  BUSINESS_DATE_UNAVAILABLE_LABEL,
  BUSINESS_RANGE_OPTIONS,
  currentBusinessDate,
  groupSalesByEmployee,
  indexOrderBusinessDates,
  matchesBusinessDateRange,
  resolveOrderBusinessDate,
} from "@/lib/salesReporting";
import type { BusinessDateRange, ReportEmployee } from "@/lib/salesReporting";

type SalesReportProps = {
  orderTotals: OrderTotal[];
  orderTotalsError: string | null;
  currency: Currency;
  /**
   * The project's SAVED business timezone. An unsaved edit in the Business
   * panel must not silently re-bucket a report.
   */
  businessTimezone: string | null;
  /** register_sessions.business_date per order, from list_order_business_dates. */
  orderBusinessDates: OrderBusinessDate[];
  businessDatesError: string | null;
  employees: ReportEmployee[];
  employeesError: string | null;
  isLoadingReportData: boolean;
};

// Matches formatReceiptDateTime's shape in EditorPreview.tsx. This is the
// instant the sale happened, shown the way every other timestamp in the app is
// shown; it is NOT what decides the sale's business day.
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
  businessTimezone,
  orderBusinessDates,
  businessDatesError,
  employees,
  employeesError,
  isLoadingReportData,
}: SalesReportProps) {
  const [range, setRange] = useState<BusinessDateRange>("today");

  const currencySymbol = CURRENCY_SYMBOLS[currency];

  // The instant is universal; the timezone that turns it into a date is the
  // BUSINESS's, never this browser's.
  const today = currentBusinessDate(new Date(), businessTimezone);

  // With no usable business timezone there is no "today" to compare against,
  // so no dated range can be evaluated and only All Time is offered. Showing a
  // "Today" button that silently meant the VIEWER'S today is exactly the
  // behaviour this task removes.
  const datedRangesAvailable = today !== null;
  const effectiveRange: BusinessDateRange = datedRangesAvailable ? range : "allTime";

  const businessDateIndex = indexOrderBusinessDates(orderBusinessDates);

  const datedOrders = orderTotals.map((order) => ({
    order,
    resolution: resolveOrderBusinessDate(order, businessDateIndex, businessTimezone),
  }));

  const filteredOrders = datedOrders
    .filter(({ resolution }) =>
      matchesBusinessDateRange(resolution.businessDate, effectiveRange, today)
    )
    .sort(
      (a, b) =>
        new Date(b.order.createdAt).getTime() - new Date(a.order.createdAt).getTime()
    );

  const totalSales = filteredOrders.reduce((sum, { order }) => sum + order.total, 0);
  const transactionCount = filteredOrders.length;
  const taxCollected = filteredOrders.reduce(
    (sum, { order }) => sum + order.taxAmount,
    0
  );
  const averageOrderValue =
    transactionCount === 0 ? 0 : totalSales / transactionCount;

  // Every filtered sale, including the unattributed ones — which is what makes
  // these groups add up to Total Sales above.
  const employeeGroups = groupSalesByEmployee(
    filteredOrders.map(({ order }) => order),
    employees
  );

  const unavailableCount = filteredOrders.filter(
    ({ resolution }) => resolution.source === "unavailable"
  ).length;

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
          {BUSINESS_RANGE_OPTIONS.map((option) => {
            const isActive = effectiveRange === option.value;
            const isDisabled = !datedRangesAvailable && option.value !== "allTime";

            return (
              <button
                key={option.value}
                type="button"
                disabled={isDisabled}
                onClick={() => setRange(option.value)}
                className={`rounded-full px-4 py-2 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
                  isActive
                    ? "bg-blue-600 text-white"
                    : isDisabled
                      ? "border border-neutral-200 text-neutral-400"
                      : "border border-neutral-200 text-neutral-700 hover:border-blue-600 hover:text-blue-600"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>

        {!datedRangesAvailable && (
          <p className="text-sm leading-relaxed text-neutral-600">
            Set this project&rsquo;s business timezone to report by business day.
            Until then only All Time is available, and no sale is assigned to a
            day it cannot be shown to belong to.
          </p>
        )}

        {businessDatesError !== null && (
          <p
            role="alert"
            className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800"
          >
            {businessDatesError} Recorded business days could not be loaded, so
            this report cannot show business-day totals.
          </p>
        )}
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
      ) : isLoadingReportData ? (
        <p className="rounded-2xl border border-neutral-200 bg-white p-6 text-center text-sm text-neutral-500">
          Loading sales report…
        </p>
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

          {unavailableCount > 0 && (
            <p className="text-sm leading-relaxed text-neutral-600">
              {unavailableCount === 1
                ? "1 sale has no business day recorded and cannot be assigned to one. It is included in the totals above."
                : `${unavailableCount} sales have no business day recorded and cannot be assigned to one. They are included in the totals above.`}
            </p>
          )}

          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold tracking-tight text-neutral-900">
              Sales by Employee
            </h3>

            {employeesError !== null && (
              <p
                role="alert"
                className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800"
              >
                {employeesError} Employee names could not be loaded.
              </p>
            )}

            <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white shadow-sm">
              {employeeGroups.length === 0 ? (
                <p className="p-6 text-center text-sm text-neutral-500">
                  No sales in this range.
                </p>
              ) : (
                <table className="w-full min-w-[520px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-neutral-200 text-xs font-medium uppercase tracking-wide text-neutral-400">
                      <th className="px-4 py-3">Employee</th>
                      <th className="px-4 py-3">Employee ID</th>
                      <th className="px-4 py-3 text-right">Transactions</th>
                      <th className="px-4 py-3 text-right">Tax</th>
                      <th className="px-4 py-3 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {employeeGroups.map((group) => (
                      <tr
                        key={group.key}
                        className="border-b border-neutral-100 text-neutral-900 last:border-b-0"
                      >
                        <td className="px-4 py-3 font-medium">
                          {group.displayName}
                          {group.active === false && (
                            <span className="ml-2 text-xs font-normal text-neutral-500">
                              Inactive
                            </span>
                          )}
                        </td>
                        {/* A string, always: 001 is 001. */}
                        <td className="px-4 py-3 text-neutral-600">
                          {group.employeeCode ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-right">{group.orderCount}</td>
                        <td className="px-4 py-3 text-right">
                          {currencySymbol}
                          {group.taxAmount.toFixed(2)}
                        </td>
                        <td className="px-4 py-3 text-right font-medium">
                          {currencySymbol}
                          {group.total.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white shadow-sm">
            {filteredOrders.length === 0 ? (
              <p className="p-6 text-center text-sm text-neutral-500">
                No sales in this range.
              </p>
            ) : (
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-xs font-medium uppercase tracking-wide text-neutral-400">
                    <th className="px-4 py-3">Business Date</th>
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
                  {filteredOrders.map(({ order, resolution }) => (
                    <tr
                      key={order.id}
                      className="border-b border-neutral-100 text-neutral-900 last:border-b-0"
                    >
                      <td className="px-4 py-3 text-neutral-600">
                        {resolution.businessDate ?? BUSINESS_DATE_UNAVAILABLE_LABEL}
                      </td>
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
