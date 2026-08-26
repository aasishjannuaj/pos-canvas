"use client";

// Feature 25.3 Phase 2 — recent sales for this business.
//
// SERVER-BACKED ONLY, deliberately. There is no local cache and no merge with
// the offline queue: a sale that has not reached POS Canvas is not a completed
// sale, and showing an OFF reference beside real order numbers would invite a
// cashier to treat it as recorded. Offline says so plainly instead.
//
// PROJECT-SCOPED, not per-device. `orders` has no device column, so this is
// "what this business sold", which is what the schema can prove and what a
// cashier asks for.

import { useEffect, useState } from "react";

import { fetchDeviceRecentOrders } from "@/lib/deviceOrders.rpc";
import type { DeviceHistoryOrder } from "@/lib/deviceOrders";
import {
  HISTORY_EMPTY,
  HISTORY_ERROR,
  HISTORY_LOADING,
  HISTORY_LOAD_MORE,
  HISTORY_LOAD_MORE_FAILED,
  HISTORY_NOT_PAIRED,
  HISTORY_OFFLINE,
  HISTORY_RETRY,
  HISTORY_TITLE,
  appendHistoryPage,
  describeHistoryRow,
  emptySalesHistoryList,
  hasMoreHistory,
} from "@/lib/salesHistoryView";
import type { SalesHistoryList } from "@/lib/salesHistoryView";

type Phase = "loading" | "ready" | "error";

/**
 * What a cashier is told when a load fails.
 *
 * NOTHING NAMES A MECHANISM. No function name, no SQL code, no PostgREST
 * vocabulary — anything a cashier cannot act on is noise on a till.
 */
function describeFailure(reason: string): string {
  if (reason === "unreachable") return HISTORY_OFFLINE;
  if (reason === "not_paired") return HISTORY_NOT_PAIRED;

  return HISTORY_ERROR;
}

type SalesHistoryScreenProps = {
  currencySymbol: string;
  onOpenOrder: (order: DeviceHistoryOrder) => void;
  onClose: () => void;
};

function formatWhen(iso: string): string {
  const parsed = new Date(iso);

  return Number.isNaN(parsed.getTime())
    ? iso
    : parsed.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

export default function SalesHistoryScreen({
  currencySymbol,
  onOpenOrder,
  onClose,
}: SalesHistoryScreenProps) {
  const [list, setList] = useState<SalesHistoryList>(emptySalesHistoryList);
  const [phase, setPhase] = useState<Phase>("loading");
  // Distinguished from `phase` so a failure while loading MORE never blanks the
  // rows already on screen — losing a cashier's place is worse than the error.
  const [loadingMore, setLoadingMore] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [moreFailed, setMoreFailed] = useState(false);
  const [reload, setReload] = useState(0);

  /**
   * The first page, re-run whenever `reload` changes.
   *
   * An inline async IIFE with a cancel guard — the same shape DeviceApp's
   * startup sync uses. State is only ever set after the await and only if the
   * screen is still mounted, so closing history mid-request sets nothing.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const result = await fetchDeviceRecentOrders(null);

      if (cancelled) return;

      if (!result.ok) {
        setPhase("error");
        setMessage(describeFailure(result.reason));
        return;
      }

      setList(appendHistoryPage(emptySalesHistoryList, result.page));
      setPhase("ready");
    })();

    return () => {
      cancelled = true;
    };
  }, [reload]);

  // An event, not an effect: the reset should show the instant it is pressed.
  function retry() {
    setPhase("loading");
    setMessage(null);
    setMoreFailed(false);
    setReload((value) => value + 1);
  }

  async function loadMore() {
    if (loadingMore || list.cursor === null) return;

    setLoadingMore(true);
    setMoreFailed(false);

    const result = await fetchDeviceRecentOrders(list.cursor);

    if (!result.ok) {
      // Rows already loaded stay exactly where they are.
      setMoreFailed(true);
      setLoadingMore(false);
      return;
    }

    setList((current) => appendHistoryPage(current, result.page));
    setLoadingMore(false);
  }

  return (
    <div className="flex min-h-screen flex-col bg-neutral-50 px-6 py-10">
      <div className="mx-auto w-full max-w-md">
        <p className="text-xs font-semibold uppercase tracking-widest text-neutral-400">
          POS Canvas
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-neutral-900">
          {HISTORY_TITLE}
        </h1>

        {/* Every state says what it is in words, so none of them reads as a
            stuck spinner. */}
        {phase === "loading" && (
          <p role="status" className="mt-6 text-sm text-neutral-600">
            {HISTORY_LOADING}
          </p>
        )}

        {phase === "error" && (
          <div className="mt-6 rounded-2xl border border-neutral-200 bg-white p-5">
            <p role="status" className="text-sm leading-relaxed text-neutral-700">
              {message}
            </p>

            <button
              type="button"
              onClick={retry}
              className="mt-4 w-full rounded-xl bg-neutral-900 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-neutral-800"
            >
              {HISTORY_RETRY}
            </button>
          </div>
        )}

        {phase === "ready" && list.orders.length === 0 && (
          <p role="status" className="mt-6 text-sm text-neutral-600">
            {HISTORY_EMPTY}
          </p>
        )}

        {phase === "ready" && list.orders.length > 0 && (
          <ul className="mt-6 flex flex-col gap-2">
            {list.orders.map((order) => {
              const row = describeHistoryRow(order);

              return (
                <li key={order.orderId}>
                  {/* A real button, so it is reachable by keyboard on Windows
                      and announced as an action rather than as text. */}
                  <button
                    type="button"
                    onClick={() => onOpenOrder(order)}
                    className="flex w-full items-baseline justify-between gap-4 rounded-xl border border-neutral-200 bg-white px-4 py-3 text-left transition-colors hover:border-neutral-300 hover:bg-neutral-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-neutral-900">
                        {row.orderNumber}
                      </span>
                      <span className="block text-xs text-neutral-500">
                        {formatWhen(row.time)} · {row.payment}
                      </span>
                    </span>

                    <span className="flex-none text-sm font-medium text-neutral-900">
                      {currencySymbol}
                      {row.total}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {phase === "ready" && moreFailed && (
          <p
            role="status"
            className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900"
          >
            {HISTORY_LOAD_MORE_FAILED}
          </p>
        )}

        {phase === "ready" && hasMoreHistory(list) && (
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="mt-4 w-full rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm font-semibold text-neutral-700 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : HISTORY_LOAD_MORE}
          </button>
        )}

        <button
          type="button"
          onClick={onClose}
          className="mt-8 w-full rounded-xl border border-neutral-200 bg-white px-4 py-3.5 text-sm font-semibold text-neutral-700 transition-colors hover:bg-neutral-100"
        >
          Back to POS
        </button>
      </div>
    </div>
  );
}
