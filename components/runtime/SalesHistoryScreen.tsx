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
    <div className="flex min-h-screen flex-col bg-neutral-50">
      {/* RC-polish — the way back is the first thing on screen and stays there.
          It used to be a full-width button BELOW every row and every Load more,
          which on a long page meant scrolling to leave. Sticky, so a cashier can
          always get back to the till in one press. */}
      <div className="sticky top-0 z-10 flex-none border-b border-neutral-200 bg-white">
        <div className="mx-auto flex w-full max-w-md items-center justify-between gap-4 px-6 py-3">
          <button
            type="button"
            onClick={onClose}
            className="-ml-2 inline-flex flex-none items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-semibold text-neutral-700 transition-colors hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400"
          >
            {/* Drawn, not typed: a glyph renders differently across the Android
                WebView and the Windows shell. */}
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 16 6 10l6-6" />
            </svg>
            Back to POS
          </button>

          <div className="min-w-0 text-right">
            <p className="truncate text-sm font-semibold tracking-tight text-neutral-900">
              {HISTORY_TITLE}
            </p>
            <p className="truncate text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
              POS Canvas
            </p>
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-md px-6 py-6">
        {/* Every state says what it is in words, so none of them reads as a
            stuck spinner. */}
        {phase === "loading" && (
          <p role="status" className="text-sm text-neutral-600">
            {HISTORY_LOADING}
          </p>
        )}

        {phase === "error" && (
          <div className="rounded-2xl border border-neutral-200 bg-white p-5">
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
          <p role="status" className="text-sm text-neutral-600">
            {HISTORY_EMPTY}
          </p>
        )}

        {/* RC-polish — one framed surface with divided rows rather than six
            free-floating pills. Same rows, same data, same press target. */}
        {phase === "ready" && list.orders.length > 0 && (
          <ul className="divide-y divide-neutral-100 overflow-hidden rounded-2xl border border-neutral-200 bg-white">
            {list.orders.map((order) => {
              const row = describeHistoryRow(order);

              return (
                <li key={order.orderId}>
                  {/* A real button, so it is reachable by keyboard on Windows
                      and announced as an action rather than as text. */}
                  <button
                    type="button"
                    onClick={() => onOpenOrder(order)}
                    className="flex w-full items-baseline justify-between gap-4 px-4 py-3.5 text-left transition-colors hover:bg-neutral-50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-neutral-900">
                        {row.orderNumber}
                      </span>
                      <span className="block text-xs text-neutral-500">
                        {formatWhen(row.time)} · {row.payment}
                      </span>
                    </span>

                    <span className="flex-none text-sm font-semibold tabular-nums text-neutral-900">
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
      </div>
    </div>
  );
}
