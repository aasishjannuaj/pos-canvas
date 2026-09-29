"use client";

// v1.3 Task 5E — the Cash Activity report.
//
// SELF-CONTAINED, like the Devices, Employees and Employee Time panels.
// EditorShell passes the project id and the saved business timezone.
//
// THE EVENT STREAM, AND ONLY THAT. Every row is an authoritative
// `cash_movements` row read through list_cash_movements. Nothing is
// reconstructed from orders, cash-tender sales, receipts, opening cash, POS
// sessions or the Time Clock — a cash sale is a sale and belongs to the Sales
// Report.
//
// WHY THE WINDOW IS UNBOUNDED, DELIBERATELY. list_cash_movements filters on
// `occurred_at` (a timestamp), but every row carries the authoritative STORED
// `register_sessions.business_date`. Sending a timestamp window while showing
// the owner a business-date control would be two different questions wearing
// one label. So no window is sent at all, and the range is applied to the
// stored business date itself — the value the register recorded, never
// recomputed from `occurred_at` and never re-read in a different timezone.
//
// WHAT THIS SCREEN DOES NOT AND CANNOT SAY. There is no counted-closing-cash
// contract in POS Canvas, so Expected Cash, Actual Cash, Counted Closing Cash,
// Drawer Balance, Over/Short, Cash Variance and Financial Close are absent
// entirely — not approximated, and no figure here is labelled as one. The
// per-type totals below are each the exact sum of that ONE type's own events,
// and are never combined with one another.
import { useCallback, useEffect, useState } from "react";
import { fetchCashMovements, UNBOUNDED_WINDOW } from "@/lib/ownerReporting.rpc";
import { getOwnerReportMessage } from "@/lib/ownerReporting";
import type { CashMovementRow } from "@/lib/ownerReporting";
import { CASH_MOVEMENT_TYPES } from "@/lib/cashMovement";
import {
  CASH_ACTIVITY_DATE_NOTE,
  countForType,
  describeNote,
  formatCashAmount,
  formatCashTotal,
  getCashActivityLabel,
  totalForType,
} from "@/lib/cashActivity";
import {
  BUSINESS_RANGE_OPTIONS,
  currentBusinessDate,
  matchesBusinessDateRange,
} from "@/lib/salesReporting";
import type { BusinessDateRange } from "@/lib/salesReporting";

type CashActivityReportProps = {
  projectId: string | null;
  /** The project's SAVED business timezone, or null when unconfigured. */
  businessTimezone: string | null;
};

export default function CashActivityReport({
  projectId,
  businessTimezone,
}: CashActivityReportProps) {
  const [range, setRange] = useState<BusinessDateRange>("allTime");
  const [movements, setMovements] = useState<CashMovementRow[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(projectId !== null);

  const loadMovements = useCallback(async () => {
    if (projectId === null) return;

    // Unbounded on purpose — see the file header. The range is applied to the
    // stored business date below, not to occurred_at.
    const result = await fetchCashMovements(projectId, UNBOUNDED_WINDOW);

    if (result.ok) {
      setMovements(result.cashMovements);
      setErrorMessage(null);
    } else {
      // Said out loud. An empty list would read as "no cash was moved", which
      // is a claim about the business rather than about the request.
      setMovements([]);
      setErrorMessage(getOwnerReportMessage(result.code));
    }

    setIsLoading(false);
  }, [projectId]);

  useEffect(() => {
    // Async IIFE for the same reason as DeviceManagementPanel's mount effect:
    // react-hooks/set-state-in-effect traces the writes back to the effect body
    // otherwise. Every write happens after an await.
    void (async () => {
      await loadMovements();
    })();
  }, [loadMovements]);

  // The instant is universal; the timezone that turns it into today's business
  // date is the business's, never this browser's.
  const today = currentBusinessDate(new Date(), businessTimezone);
  const datedRangesAvailable = today !== null;
  const effectiveRange: BusinessDateRange = datedRangesAvailable ? range : "allTime";

  // Selected on the STORED business date. Never on occurredAt, and never on a
  // date recomputed from it.
  const visible = movements.filter((movement) =>
    matchesBusinessDateRange(movement.businessDate, effectiveRange, today)
  );

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-auto bg-neutral-100 p-10">
      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold tracking-tight text-neutral-900">
          Cash Activity
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

        <p className="text-sm leading-relaxed text-neutral-600">
          {CASH_ACTIVITY_DATE_NOTE}
        </p>

        {/* The boundary, stated to the owner rather than only to a reader of
            the source. */}
        <p className="text-sm leading-relaxed text-neutral-600">
          Cash taken as payment for a sale is in the Sales Report, not here.
          These are recorded cash events only — POS Canvas does not count a
          drawer, so it cannot tell you a closing balance.
        </p>

        {!datedRangesAvailable && (
          <p className="text-sm leading-relaxed text-neutral-600">
            Set this project&rsquo;s business timezone to report by business
            day. Until then only All Time is available.
          </p>
        )}
      </div>

      {errorMessage !== null ? (
        <div className="flex flex-col gap-1 rounded-2xl border border-red-200 bg-red-50 p-5 shadow-sm">
          <span className="text-xs font-medium uppercase tracking-wide text-red-400">
            Cash Activity Unavailable
          </span>
          <span className="text-sm font-medium text-red-600">{errorMessage}</span>
        </div>
      ) : projectId === null ? (
        <section className="rounded-2xl border border-neutral-200 bg-white p-6">
          <h3 className="text-sm font-semibold text-neutral-900">
            Save this project first
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-neutral-500">
            Cash movements belong to a saved project.
          </p>
        </section>
      ) : isLoading ? (
        <p className="rounded-2xl border border-neutral-200 bg-white p-6 text-center text-sm text-neutral-500">
          Loading cash activity…
        </p>
      ) : (
        <>
          {/* One tile per movement type. Each is the exact sum of THAT type's
              own events; they are never added to or subtracted from one
              another, and none of them is a drawer figure. */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {CASH_MOVEMENT_TYPES.map((type) => (
              <div
                key={type}
                className="flex flex-col gap-2 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm"
              >
                <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                  {getCashActivityLabel(type)}
                </span>
                <span className="text-2xl font-semibold text-neutral-900">
                  ${formatCashTotal(totalForType(visible, type))}
                </span>
                <span className="text-xs text-neutral-500">
                  {countForType(visible, type) === 1
                    ? "1 movement"
                    : `${countForType(visible, type)} movements`}
                </span>
              </div>
            ))}
          </div>

          <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white shadow-sm">
            {visible.length === 0 ? (
              <p className="p-6 text-center text-sm text-neutral-500">
                No cash movements in this range.
              </p>
            ) : (
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-xs font-medium uppercase tracking-wide text-neutral-400">
                    <th className="px-4 py-3">Business Date</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3 text-right">Amount</th>
                    <th className="px-4 py-3">Employee</th>
                    <th className="px-4 py-3">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((movement) => (
                    <tr
                      key={movement.movementId}
                      className="border-b border-neutral-100 text-neutral-900 last:border-b-0"
                    >
                      {/* The stored register date, shown as stored. */}
                      <td className="px-4 py-3 text-neutral-600">
                        {movement.businessDate}
                      </td>
                      <td className="px-4 py-3 font-medium">
                        {getCashActivityLabel(movement.movementType)}
                      </td>
                      {/* Positive, exactly as recorded. Direction is the type. */}
                      <td className="px-4 py-3 text-right">
                        ${formatCashAmount(movement.amount)}
                      </td>
                      <td className="px-4 py-3 text-neutral-600">
                        {movement.displayName}
                      </td>
                      <td className="px-4 py-3 text-neutral-600">
                        {describeNote(movement.note)}
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
