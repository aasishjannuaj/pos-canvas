"use client";

import { useState } from "react";
import { CURRENCY_SYMBOLS } from "@/components/editor/EditorShell";
import type { Currency } from "@/components/editor/EditorShell";
import type { OrderTotal } from "@/lib/dashboard.types";
import { RANGE_OPTIONS, matchesRange } from "@/lib/dateRange";
import type { DateRange } from "@/lib/dateRange";

type SortKey = "units" | "revenue" | "orders";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "units", label: "Units Sold" },
  { value: "revenue", label: "Gross Sales" },
  { value: "orders", label: "Number of Orders" },
];

type ProductAggregate = {
  key: string;
  productName: string;
  unitsSold: number;
  orderCount: number;
  grossSales: number;
  avgSellingPrice: number;
  revenueSharePct: number;
};

type ProductPerformanceProps = {
  orderTotals: OrderTotal[];
  orderTotalsError: string | null;
  currency: Currency;
};

// Group by item_id primarily, falling back to item_name only if item_id is
// ever missing/blank — cheap insurance against malformed rows, matching the
// same non-null assumption the rest of the app already makes about item_id.
function productKey(itemId: string, itemName: string): string {
  return itemId.trim() !== "" ? itemId : itemName;
}

function aggregateProducts(orders: OrderTotal[]): ProductAggregate[] {
  const byKey = new Map<
    string,
    {
      productName: string;
      unitsSold: number;
      grossSales: number;
      orderIds: Set<string>;
    }
  >();

  for (const order of orders) {
    for (const item of order.items) {
      const key = productKey(item.itemId, item.itemName);
      const existing = byKey.get(key);

      if (existing) {
        existing.unitsSold += item.quantity;
        existing.grossSales += item.lineTotal;
        // A Set, so a product appearing on multiple lines of the same
        // order still only counts that order once.
        existing.orderIds.add(order.id);
      } else {
        byKey.set(key, {
          productName: item.itemName,
          unitsSold: item.quantity,
          grossSales: item.lineTotal,
          orderIds: new Set([order.id]),
        });
      }
    }
  }

  const totalGrossSales = Array.from(byKey.values()).reduce(
    (sum, product) => sum + product.grossSales,
    0
  );

  return Array.from(byKey.entries()).map(([key, value]) => ({
    key,
    productName: value.productName,
    unitsSold: value.unitsSold,
    orderCount: value.orderIds.size,
    grossSales: value.grossSales,
    avgSellingPrice:
      value.unitsSold === 0 ? 0 : value.grossSales / value.unitsSold,
    // Guarded against a zero-revenue range (e.g. every line item somehow
    // totaling $0) so this never divides by zero.
    revenueSharePct:
      totalGrossSales === 0 ? 0 : (value.grossSales / totalGrossSales) * 100,
  }));
}

function sortProducts(
  products: ProductAggregate[],
  sortKey: SortKey
): ProductAggregate[] {
  const sorted = [...products];

  if (sortKey === "units") {
    sorted.sort((a, b) => b.unitsSold - a.unitsSold);
  } else if (sortKey === "revenue") {
    sorted.sort((a, b) => b.grossSales - a.grossSales);
  } else {
    sorted.sort((a, b) => b.orderCount - a.orderCount);
  }

  return sorted;
}

export default function ProductPerformance({
  orderTotals,
  orderTotalsError,
  currency,
}: ProductPerformanceProps) {
  const [range, setRange] = useState<DateRange>("today");
  const [sortKey, setSortKey] = useState<SortKey>("units");

  const currencySymbol = CURRENCY_SYMBOLS[currency];
  const now = new Date();

  // Every row in `orders` is already a completed, paid sale — see
  // lib/dashboard.server.ts for why no status filter is applied.
  const filteredOrders = orderTotals.filter((order) =>
    matchesRange(order.createdAt, range, now)
  );

  const products = aggregateProducts(filteredOrders);
  const sortedProducts = sortProducts(products, sortKey);

  const totalUnitsSold = products.reduce(
    (sum, product) => sum + product.unitsSold,
    0
  );
  const distinctProductCount = products.length;

  const topSellingByUnits =
    products.length === 0
      ? null
      : products.reduce((top, product) =>
          product.unitsSold > top.unitsSold ? product : top
        );

  const highestRevenueProduct =
    products.length === 0
      ? null
      : products.reduce((top, product) =>
          product.grossSales > top.grossSales ? product : top
        );

  const summaryStats: { label: string; value: string }[] = [
    { label: "Total Units Sold", value: `${totalUnitsSold}` },
    { label: "Distinct Products Sold", value: `${distinctProductCount}` },
    {
      label: "Top-Selling Product",
      value: topSellingByUnits
        ? `${topSellingByUnits.productName} — ${topSellingByUnits.unitsSold} units`
        : "—",
    },
    {
      label: "Highest-Revenue Product",
      value: highestRevenueProduct
        ? `${highestRevenueProduct.productName} — ${currencySymbol}${highestRevenueProduct.grossSales.toFixed(2)}`
        : "—",
    },
  ];

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-auto bg-neutral-100 p-10">
      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold tracking-tight text-neutral-900">
          Product Performance
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

          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Sort By
            </span>
            <div className="flex flex-wrap gap-2">
              {SORT_OPTIONS.map((option) => {
                const isActive = sortKey === option.value;

                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setSortKey(option.value)}
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
            {sortedProducts.length === 0 ? (
              <p className="p-6 text-center text-sm text-neutral-500">
                No sales in this range.
              </p>
            ) : (
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-xs font-medium uppercase tracking-wide text-neutral-400">
                    <th className="px-4 py-3">Product</th>
                    <th className="px-4 py-3 text-right">Units Sold</th>
                    <th className="px-4 py-3 text-right">Orders</th>
                    <th className="px-4 py-3 text-right">Gross Sales</th>
                    <th className="px-4 py-3 text-right">Avg. Price</th>
                    <th className="px-4 py-3 text-right">Revenue Share</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedProducts.map((product) => (
                    <tr
                      key={product.key}
                      className="border-b border-neutral-100 text-neutral-900 last:border-b-0"
                    >
                      <td className="px-4 py-3 font-medium">
                        {product.productName}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {product.unitsSold}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {product.orderCount}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {currencySymbol}
                        {product.grossSales.toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {currencySymbol}
                        {product.avgSellingPrice.toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {product.revenueSharePct.toFixed(1)}%
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
