"use client";

// v1.3 Task 5D — the Employee Time report.
//
// SELF-CONTAINED, like DeviceManagementPanel and EmployeeManagementPanel: it
// owns its range state and fetches its own rows, because the range is a SERVER
// window — list_employee_time_sessions filters in SQL — so changing it has to
// re-ask the database rather than re-filter an array. EditorShell passes the
// project id and the saved business timezone and nothing else.
//
// THE TIME CLOCK IS THE ONLY SOURCE. Every row comes from
// employee_time_sessions through the accepted owner contract. Nothing here
// reads employee_pos_sessions, register_sessions, orders, sale attribution or
// cash movements: "who was signed in at this till" and "who was on the clock"
// are different facts, and mixing them would produce a number that is neither.
//
// WHAT THIS REPORT REFUSES TO SAY. It does not compute pay, overtime, wages or
// labour cost; it does not round to a payroll increment; it does not split a
// shift across midnight; and it never turns an unfinished shift into a figure.
// An open shift shows "Open" and "—", and contributes nothing to the total.
import { useCallback, useEffect, useState } from "react";
import { fetchEmployeeTimeSessions } from "@/lib/ownerReporting.rpc";
import { getOwnerReportMessage } from "@/lib/ownerReporting";
import type { TimeSessionRow } from "@/lib/ownerReporting";
import {
  TIME_RANGE_INCLUSION_NOTE,
  TIME_RANGE_OPTIONS,
  countClosedSessions,
  countOpenSessions,
  describeClockOut,
  describeSessionDuration,
  formatDuration,
  formatSessionTimestamp,
  timeReportWindow,
  totalClosedDurationMs,
} from "@/lib/timeReporting";
import type { TimeReportRange } from "@/lib/timeReporting";

type EmployeeTimeReportProps = {
  projectId: string | null;
  /** The project's SAVED business timezone, or null when unconfigured. */
  businessTimezone: string | null;
};

export default function EmployeeTimeReport({
  projectId,
  businessTimezone,
}: EmployeeTimeReportProps) {
  const [range, setRange] = useState<TimeReportRange>("allTime");
  const [sessions, setSessions] = useState<TimeSessionRow[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Starts true only when there is something to load, so an unsaved project
  // never shows a spinner for data that will never arrive.
  const [isLoading, setIsLoading] = useState(projectId !== null);

  // Without a business timezone there is no defensible instant for "the start
  // of today in this business", so no dated window can be built and only All
  // Time is offered. Nothing falls back to the browser's midnight.
  const datedRangesAvailable =
    timeReportWindow("today", new Date(), businessTimezone) !== null;
  const effectiveRange: TimeReportRange = datedRangesAvailable ? range : "allTime";

  const loadSessions = useCallback(async () => {
    if (projectId === null) return;

    const window = timeReportWindow(effectiveRange, new Date(), businessTimezone);

    // Only reachable if a range were selected without a usable timezone, which
    // the control prevents. Refusing to send is better than sending a guess.
    if (window === null) {
      setSessions([]);
      setErrorMessage(null);
      setIsLoading(false);
      return;
    }

    const result = await fetchEmployeeTimeSessions(projectId, window);

    if (result.ok) {
      setSessions(result.timeSessions);
      setErrorMessage(null);
    } else {
      // A failure is said out loud. An empty list would read as "nobody worked",
      // which is a claim about the business rather than about the request.
      setSessions([]);
      setErrorMessage(getOwnerReportMessage(result.code));
    }

    setIsLoading(false);
  }, [projectId, effectiveRange, businessTimezone]);

  useEffect(() => {
    // Async IIFE for the same reason as DeviceManagementPanel's mount effect:
    // react-hooks/set-state-in-effect traces the writes back to the effect body
    // otherwise. Every write happens after an await.
    void (async () => {
      await loadSessions();
    })();
  }, [loadSessions]);

  const closedCount = countClosedSessions(sessions);
  const openCount = countOpenSessions(sessions);
  const totalMs = totalClosedDurationMs(sessions);

  const summaryStats: { label: string; value: string }[] = [
    // Named for what it is: the sum of FINISHED shifts. An open shift is
    // counted beside it, never inside it.
    { label: "Total Worked (Closed Shifts)", value: formatDuration(totalMs) },
    { label: "Closed Shifts", value: `${closedCount}` },
    { label: "Open Shifts", value: `${openCount}` },
  ];

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-auto bg-neutral-100 p-10">
      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold tracking-tight text-neutral-900">
          Employee Time
        </h2>

        <div className="flex flex-wrap gap-2">
          {TIME_RANGE_OPTIONS.map((option) => {
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

        {/* Says what the contract actually does, rather than the wider claim a
            reader would otherwise assume. */}
        <p className="text-sm leading-relaxed text-neutral-600">
          {TIME_RANGE_INCLUSION_NOTE}
        </p>

        {!datedRangesAvailable && (
          <p className="text-sm leading-relaxed text-neutral-600">
            Set this project&rsquo;s business timezone to report by day. Until
            then only All Time is available, and times below are shown in UTC.
          </p>
        )}
      </div>

      {errorMessage !== null ? (
        <div className="flex flex-col gap-1 rounded-2xl border border-red-200 bg-red-50 p-5 shadow-sm">
          <span className="text-xs font-medium uppercase tracking-wide text-red-400">
            Time Clock Data Unavailable
          </span>
          <span className="text-sm font-medium text-red-600">{errorMessage}</span>
        </div>
      ) : projectId === null ? (
        <section className="rounded-2xl border border-neutral-200 bg-white p-6">
          <h3 className="text-sm font-semibold text-neutral-900">
            Save this project first
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-neutral-500">
            Time Clock records belong to a saved project.
          </p>
        </section>
      ) : isLoading ? (
        <p className="rounded-2xl border border-neutral-200 bg-white p-6 text-center text-sm text-neutral-500">
          Loading Time Clock records…
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
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

          {openCount > 0 && (
            <p className="text-sm leading-relaxed text-neutral-600">
              {openCount === 1
                ? "1 shift is still open. Open shifts have no duration yet and are not included in the total."
                : `${openCount} shifts are still open. Open shifts have no duration yet and are not included in the total.`}
            </p>
          )}

          <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white shadow-sm">
            {sessions.length === 0 ? (
              <p className="p-6 text-center text-sm text-neutral-500">
                No Time Clock records in this range.
              </p>
            ) : (
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-xs font-medium uppercase tracking-wide text-neutral-400">
                    <th className="px-4 py-3">Employee</th>
                    <th className="px-4 py-3">Clocked In</th>
                    <th className="px-4 py-3">Clocked Out</th>
                    <th className="px-4 py-3 text-right">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((session) => (
                    <tr
                      key={session.timeSessionId}
                      className="border-b border-neutral-100 text-neutral-900 last:border-b-0"
                    >
                      <td className="px-4 py-3 font-medium">{session.displayName}</td>
                      <td className="px-4 py-3 text-neutral-600">
                        {formatSessionTimestamp(session.clockedInAt, businessTimezone)}
                      </td>
                      <td className="px-4 py-3 text-neutral-600">
                        {describeClockOut(session, businessTimezone)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {describeSessionDuration(session)}
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
