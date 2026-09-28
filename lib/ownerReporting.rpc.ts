/**
 * v1.3 Feature 1F — the owner's three reporting reads.
 *
 * THE OWNER CLIENT, NOT THE DEVICE CLIENT. These use the cookie-backed browser
 * client, so `auth.uid()` inside each RPC is the platform account. A paired
 * device authenticates as a real Supabase user too, which is exactly why every
 * one of these functions rejects a caller that owns a pairing row: being signed
 * in is not the same as being the owner.
 *
 * NO AUTHORITY TRAVELS IN THE PAYLOAD. Each call sends a project id and an
 * optional window, and the server decides whether the caller may see that
 * project. Nothing here can widen what comes back.
 *
 * NOTHING IS COMPUTED HERE. These return rows. Durations, totals and business-
 * day bucketing are the caller's, over values the server already owned.
 */
import { createClient } from "@/lib/supabase/client";
import {
  parseCashMovementsResult,
  parseOrderBusinessDatesResult,
  parseTimeSessionsResult,
} from "@/lib/ownerReporting";
import type {
  CashMovementsResult,
  OrderBusinessDatesResult,
  TimeSessionsResult,
} from "@/lib/ownerReporting";

/**
 * An inclusive-start, exclusive-end window, or null for "everything".
 *
 * ISO instants, not dates: a business day is a half-open interval of time, and
 * turning a calendar date into one requires a timezone the caller must choose
 * deliberately rather than inherit from whatever machine is running.
 */
export type ReportWindow = {
  from: string | null;
  to: string | null;
};

export const UNBOUNDED_WINDOW: ReportWindow = { from: null, to: null };

/**
 * A transport failure is `unavailable`, never a silent empty report.
 *
 * An empty array is a real answer — "nothing happened in this window" — and a
 * failed request must never be shown as one. That is the difference between a
 * quiet day and a broken report.
 */
async function callOwnerReport(
  fn: string,
  projectId: string,
  window: ReportWindow
): Promise<unknown> {
  const supabase = createClient();

  const { data, error } = await supabase.rpc(fn, {
    p_project_id: projectId,
    p_from: window.from,
    p_to: window.to,
  });

  if (error) {
    return { ok: false, error: "unavailable" };
  }

  return data;
}

export async function fetchEmployeeTimeSessions(
  projectId: string,
  window: ReportWindow = UNBOUNDED_WINDOW
): Promise<TimeSessionsResult> {
  return parseTimeSessionsResult(
    await callOwnerReport("list_employee_time_sessions", projectId, window)
  );
}

export async function fetchCashMovements(
  projectId: string,
  window: ReportWindow = UNBOUNDED_WINDOW
): Promise<CashMovementsResult> {
  return parseCashMovementsResult(
    await callOwnerReport("list_cash_movements", projectId, window)
  );
}

export async function fetchOrderBusinessDates(
  projectId: string,
  window: ReportWindow = UNBOUNDED_WINDOW
): Promise<OrderBusinessDatesResult> {
  return parseOrderBusinessDatesResult(
    await callOwnerReport("list_order_business_dates", projectId, window)
  );
}
