/**
 * v1.3 Feature 1F — the owner reporting contracts, as values.
 *
 * PURE. No Supabase client, no React, no DOM. These are the shapes the four
 * owner RPCs return and the parsers that refuse anything else, kept separate
 * from the transport (lib/ownerReporting.rpc.ts) for the same reason
 * lib/employeeSession.ts is separate from lib/employee.rpc.ts: the rules are
 * testable without a network, and a caller cannot accidentally depend on a
 * field the server never promised.
 *
 * NOTHING HERE COMPUTES MONEY OR TIME. No duration, no sum, no balance, no
 * business date. Every value below is a field the server returned; anything
 * derived from two of them is the caller's arithmetic over authoritative
 * inputs, not a second source of truth invented here.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// ---------------------------------------------------------------------------
// Failure vocabulary — shared by all four reads
// ---------------------------------------------------------------------------

/**
 * Exactly what the server can say.
 *
 * `not_found` deliberately covers "no such project", "not yours" and "you are a
 * paired device". The server refuses to distinguish them and this type refuses
 * to invent the distinction back.
 */
export type OwnerReportErrorCode = "not_authenticated" | "not_found" | "unavailable";

export const OWNER_REPORT_MESSAGES: Record<OwnerReportErrorCode, string> = {
  not_authenticated: "Sign in to view this report.",
  not_found: "That project is not available.",
  unavailable: "The report could not be loaded. Please try again.",
};

export function getOwnerReportMessage(code: OwnerReportErrorCode): string {
  return OWNER_REPORT_MESSAGES[code];
}

function readErrorCode(value: unknown): OwnerReportErrorCode {
  if (!isRecord(value)) return "unavailable";

  return value.error === "not_authenticated" || value.error === "not_found"
    ? value.error
    : "unavailable";
}

// ---------------------------------------------------------------------------
// Time Clock
// ---------------------------------------------------------------------------

/**
 * One worked shift.
 *
 * NO DURATION FIELD, deliberately. It is `clockedOutAt - clockedInAt`, and the
 * server does not send one — see list_employee_time_sessions. An OPEN shift has
 * `clockedOutAt === null` and `isOpen === true`, and has no duration at all: it
 * is not zero, and it is not "so far", both of which would be claims about a
 * shift that has not ended.
 *
 * THIS IS NOT A POS SESSION. employee_pos_sessions answers "who is signed in at
 * this till"; its span is not worked time and nothing here is derived from it.
 */
export type TimeSessionRow = {
  timeSessionId: string;
  employeeId: string;
  displayName: string;
  clockedInAt: string;
  clockedOutAt: string | null;
  isOpen: boolean;
  clockInPairedDeviceId: string;
  clockOutPairedDeviceId: string | null;
};

export type TimeSessionsResult =
  | { ok: true; timeSessions: TimeSessionRow[] }
  | { ok: false; code: OwnerReportErrorCode };

function parseTimeSession(value: unknown): TimeSessionRow | null {
  if (!isRecord(value)) return null;

  const timeSessionId = nonEmptyString(value.timeSessionId);
  const employeeId = nonEmptyString(value.employeeId);
  const clockedInAt = nonEmptyString(value.clockedInAt);
  const clockInPairedDeviceId = nonEmptyString(value.clockInPairedDeviceId);

  if (
    timeSessionId === null ||
    employeeId === null ||
    clockedInAt === null ||
    clockInPairedDeviceId === null ||
    typeof value.isOpen !== "boolean"
  ) {
    return null;
  }

  const clockedOutAt = nullableString(value.clockedOutAt);

  // The open flag and the absent clock-out must agree. If they ever disagreed,
  // one of them would be lying about whether somebody is still on shift.
  if (value.isOpen !== (clockedOutAt === null)) return null;

  return {
    timeSessionId,
    employeeId,
    displayName: nullableString(value.displayName) ?? "",
    clockedInAt,
    clockedOutAt,
    isOpen: value.isOpen,
    clockInPairedDeviceId,
    clockOutPairedDeviceId: nullableString(value.clockOutPairedDeviceId),
  };
}

export function parseTimeSessionsResult(payload: unknown): TimeSessionsResult {
  if (!isRecord(payload)) return { ok: false, code: "unavailable" };
  if (payload.ok !== true) return { ok: false, code: readErrorCode(payload) };
  if (!Array.isArray(payload.timeSessions)) return { ok: false, code: "unavailable" };

  const rows: TimeSessionRow[] = [];

  for (const raw of payload.timeSessions) {
    const row = parseTimeSession(raw);

    // One unreadable row invalidates the report rather than silently shortening
    // it: a shift quietly missing from a time report is worse than an error.
    if (row === null) return { ok: false, code: "unavailable" };

    rows.push(row);
  }

  return { ok: true, timeSessions: rows };
}

// ---------------------------------------------------------------------------
// Cash Activity
// ---------------------------------------------------------------------------

export const CASH_MOVEMENT_TYPES = ["cash_drop", "paid_in", "paid_out"] as const;

export type CashMovementType = (typeof CASH_MOVEMENT_TYPES)[number];

export function isCashMovementType(value: unknown): value is CashMovementType {
  return (
    typeof value === "string" &&
    (CASH_MOVEMENT_TYPES as readonly string[]).includes(value)
  );
}

/**
 * One recorded movement of cash that was not a sale.
 *
 * AMOUNT IS A STRING. The server sends numeric(12,2); parsing it into a
 * JavaScript number here would make every downstream total IEEE-754 arithmetic
 * over money. The canonical decimal travels as text, exactly as
 * lib/cashMovement.rpc.ts sends it.
 *
 * businessDate IS THE STORED REGISTER DATE, joined from register_sessions, not
 * derived from occurredAt. There is deliberately no opening, expected, counted
 * or variance field: those figures are not recorded anywhere in this product.
 */
export type CashMovementRow = {
  movementId: string;
  movementType: CashMovementType;
  amount: string;
  employeeId: string;
  displayName: string;
  pairedDeviceId: string;
  registerSessionId: string;
  businessDate: string;
  occurredAt: string;
  note: string | null;
};

export type CashMovementsResult =
  | { ok: true; cashMovements: CashMovementRow[] }
  | { ok: false; code: OwnerReportErrorCode };

function parseCashMovement(value: unknown): CashMovementRow | null {
  if (!isRecord(value)) return null;

  const movementId = nonEmptyString(value.movementId);
  const employeeId = nonEmptyString(value.employeeId);
  const pairedDeviceId = nonEmptyString(value.pairedDeviceId);
  const registerSessionId = nonEmptyString(value.registerSessionId);
  const businessDate = nonEmptyString(value.businessDate);
  const occurredAt = nonEmptyString(value.occurredAt);

  // The amount arrives as a JSON number or a string depending on the driver;
  // either way it is carried onward as its exact text, never as a float.
  const amount =
    typeof value.amount === "string"
      ? value.amount
      : typeof value.amount === "number"
        ? String(value.amount)
        : null;

  if (
    movementId === null ||
    employeeId === null ||
    pairedDeviceId === null ||
    registerSessionId === null ||
    businessDate === null ||
    occurredAt === null ||
    amount === null ||
    !isCashMovementType(value.movementType)
  ) {
    return null;
  }

  return {
    movementId,
    movementType: value.movementType,
    amount,
    employeeId,
    displayName: nullableString(value.displayName) ?? "",
    pairedDeviceId,
    registerSessionId,
    businessDate,
    occurredAt,
    note: nullableString(value.note),
  };
}

export function parseCashMovementsResult(payload: unknown): CashMovementsResult {
  if (!isRecord(payload)) return { ok: false, code: "unavailable" };
  if (payload.ok !== true) return { ok: false, code: readErrorCode(payload) };
  if (!Array.isArray(payload.cashMovements)) return { ok: false, code: "unavailable" };

  const rows: CashMovementRow[] = [];

  for (const raw of payload.cashMovements) {
    const row = parseCashMovement(raw);

    // A movement that cannot be read is not dropped from a cash report.
    if (row === null) return { ok: false, code: "unavailable" };

    rows.push(row);
  }

  return { ok: true, cashMovements: rows };
}

// ---------------------------------------------------------------------------
// Registered-order business dates
// ---------------------------------------------------------------------------

/**
 * The authoritative business date of one REGISTERED sale.
 *
 * An order with no register session simply has no entry. That absence is the
 * signal to fall back to presentation bucketing — it is never a null date here,
 * because a null would look like "this order has no business day" rather than
 * "this product never recorded one for it".
 */
export type OrderBusinessDate = {
  orderId: string;
  businessDate: string;
};

export type OrderBusinessDatesResult =
  | { ok: true; orderBusinessDates: OrderBusinessDate[] }
  | { ok: false; code: OwnerReportErrorCode };

export function parseOrderBusinessDatesResult(payload: unknown): OrderBusinessDatesResult {
  if (!isRecord(payload)) return { ok: false, code: "unavailable" };
  if (payload.ok !== true) return { ok: false, code: readErrorCode(payload) };
  if (!Array.isArray(payload.orderBusinessDates)) return { ok: false, code: "unavailable" };

  const rows: OrderBusinessDate[] = [];

  for (const raw of payload.orderBusinessDates) {
    if (!isRecord(raw)) return { ok: false, code: "unavailable" };

    const orderId = nonEmptyString(raw.orderId);
    const businessDate = nonEmptyString(raw.businessDate);

    if (orderId === null || businessDate === null) {
      return { ok: false, code: "unavailable" };
    }

    rows.push({ orderId, businessDate });
  }

  return { ok: true, orderBusinessDates: rows };
}

/**
 * The authoritative business date for an order, or null when this product never
 * recorded one.
 *
 * NULL IS NOT A FAILURE AND MUST NOT BE FILLED IN HERE. A legacy or offline sale
 * genuinely has no recorded business day, and the caller's fallback — bucket
 * `created_at` by the project's CURRENT business timezone — is a presentation
 * choice that belongs at the presentation layer, where it can be labelled.
 * Never the viewer's timezone, never UTC, never a guessed historical zone.
 */
export function findOrderBusinessDate(
  dates: readonly OrderBusinessDate[],
  orderId: string
): string | null {
  return dates.find((row) => row.orderId === orderId)?.businessDate ?? null;
}
