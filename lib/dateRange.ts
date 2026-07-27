// Feature 10.2/10.3 — shared browser-local date-range filtering, used by
// both the Sales Report and Product Performance so the two features can
// never disagree on what "This Month" (etc.) means. Extracted from
// SalesReport.tsx verbatim; behavior is unchanged.

export type DateRange = "today" | "yesterday" | "last7" | "thisMonth" | "allTime";

export const RANGE_OPTIONS: { value: DateRange; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last7", label: "Last 7 Days" },
  { value: "thisMonth", label: "This Month" },
  { value: "allTime", label: "All Time" },
];

export function isSameLocalDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString();
}

// Every boundary here is computed from the browser's local clock (`now`),
// matching the app's existing implicit timezone convention — see
// ProjectDashboard's isToday for the same pattern.
export function matchesRange(
  createdAt: string,
  range: DateRange,
  now: Date
): boolean {
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
