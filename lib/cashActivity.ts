// v1.3 Task 5E — Cash Activity, as a pure model.
//
// PURE. No Supabase, no React, no storage, no ambient clock or timezone.
//
// WHAT THIS REPORT IS. The authoritative `cash_movements` EVENT STREAM, read
// through list_cash_movements: money that entered or left a till for a reason
// that was not a sale. A Cash Activity event exists because a cash_movements
// row exists, and for no other reason. Nothing here is reconstructed from
// orders, cash-tender sales, receipts, payment methods, opening cash, employee
// POS sessions, the Time Clock or any client state.
//
// CASH SALES ARE SALES. CASH MOVEMENTS ARE CASH MOVEMENTS. A customer paying
// cash is a sale and belongs to Task 5C; a cashier dropping cash into the safe
// is a movement and belongs here. Merging the two would invent a third quantity
// that the product does not record and cannot vouch for.
//
// WHAT THIS REPORT IS NOT, AND CANNOT BE. There is no counted-closing-cash
// contract anywhere in POS Canvas, so Expected Cash, Actual Cash, Counted
// Closing Cash, Drawer Balance, Over/Short, Cash Variance and Financial Close
// cannot be calculated truthfully. They are therefore not calculated at all,
// not approximated, and no other number is labelled as one of them.
// register_sessions.opening_cash is a structural 0 on every DAILY row and is
// never read here.
//
// AMOUNTS ARE POSITIVE, AND DIRECTION IS THE TYPE. The database enforces
// `amount > 0` and carries meaning in movement_type; this module preserves that
// exactly. Nothing is rewritten negative, and no movement is ever added to or
// subtracted from another to produce a balance.
//
// MONEY IS EXACT. Amounts are numeric(12,2) carried as text and summed through
// lib/money.ts (BigInt, scaled), never as IEEE-754 doubles. Feature 28B exists
// because float arithmetic over money in this codebase produced totals that
// disagreed with the server; a cash report must not reintroduce that.
import { ZERO_MONEY, addMoney, formatMoney, moneyFromFixedString } from "@/lib/money";
import type { Money } from "@/lib/money";
import { CASH_MOVEMENT_LABELS } from "@/lib/cashMovement";
import type { CashMovementType } from "@/lib/cashMovement";

/**
 * How each canonical stored value is named to the OWNER.
 *
 * THE STORED VALUES ARE UNTOUCHED: `cash_drop`, `paid_in`, `paid_out` remain
 * exactly what the database holds, and this is presentation only.
 *
 * WHY THIS DIFFERS FROM lib/cashMovement's CASH_MOVEMENT_LABELS ON ONE ENTRY.
 * The till says "Cash Drop" to the cashier performing it, which is the action
 * in front of them. An owner reading a report later wants the fuller name for
 * the same event — the money was picked up, or dropped to the safe — so
 * `cash_drop` reads "Cash Pickup / Safe Drop" here. The other two are the same
 * words in both places, and a test asserts both the agreement and this one
 * deliberate difference so neither can drift unnoticed.
 */
export const CASH_ACTIVITY_LABELS: Record<CashMovementType, string> = {
  cash_drop: "Cash Pickup / Safe Drop",
  paid_in: CASH_MOVEMENT_LABELS.paid_in,
  paid_out: CASH_MOVEMENT_LABELS.paid_out,
};

export function getCashActivityLabel(type: CashMovementType): string {
  return CASH_ACTIVITY_LABELS[type];
}

/** Shown where a movement has no note. Never a fabricated reason. */
export const CASH_NOTE_ABSENT_LABEL = "—";

/**
 * What the owner is told the date column means.
 *
 * list_cash_movements returns `register_sessions.business_date`, joined and
 * stored, and this report selects on THAT value. It is never recomputed from
 * `occurred_at` and never re-read in a different timezone, so a movement stays
 * on the business day the register recorded it on, whatever the project's
 * timezone is set to afterwards.
 */
export const CASH_ACTIVITY_DATE_NOTE =
  "Movements are listed by the business day the register recorded them on.";

/**
 * The subset of a movement this model needs.
 *
 * A structural subset of lib/ownerReporting's CashMovementRow, consumed from
 * the accepted contract rather than copied into a second cash model. Note what
 * is absent and must stay absent: no request or idempotency id, no PIN, no
 * hash, no credential — the contract projects none of them, and
 * `cash_movements.request_id` is deliberately not among its fields.
 *
 * `businessDate` is non-nullable because it cannot be null: a movement is only
 * ever bound to a DAILY register session, which cash_movement_append selects by
 * `r.business_date = v_business_date` after refusing a null business date
 * outright (`business_timezone_required`) and refusing a missing day
 * (`no_daily_context`). There is therefore no undated movement to represent.
 */
export type CashActivityRow = {
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

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * A stored amount as exact Money, or null if it is not a shape we recognise.
 *
 * numeric(12,2) reaches the client as "12.50", or as the JSON number 12.5 which
 * the accepted parser stringifies to "12.5". Both are the same exact decimal,
 * so a missing second place is PADDED — not parsed as a float and not rounded.
 * Anything else returns null rather than being coerced into a plausible figure.
 */
export function cashAmountToMoney(amount: string): Money | null {
  const text = amount.trim();

  const normalized = /^-?\d+$/.test(text)
    ? `${text}.00`
    : /^-?\d+\.\d$/.test(text)
      ? `${text}0`
      : text;

  return moneyFromFixedString(normalized);
}

/** A stored amount as it should be displayed: exact, two places, positive. */
export function formatCashAmount(amount: string): string {
  const money = cashAmountToMoney(amount);

  // An unreadable amount is not shown as 0.00, which would be a figure the
  // report cannot stand behind.
  return money === null ? amount : formatMoney(money);
}

/**
 * The exact sum of the movements OF ONE TYPE.
 *
 * ONE TYPE ONLY, and that is the whole safety property. A figure that mixed
 * types would be arithmetic across events that mean opposite things, which is
 * the first step towards a drawer balance this product cannot compute. The
 * caller asks for one type at a time and gets a total of that type's own
 * events, summed exactly.
 */
export function totalForType(
  rows: readonly CashActivityRow[],
  type: CashMovementType
): Money {
  let total = ZERO_MONEY;

  for (const row of rows) {
    if (row.movementType !== type) continue;

    const amount = cashAmountToMoney(row.amount);

    if (amount !== null) total = addMoney(total, amount);
  }

  return total;
}

/** How many movements of one type are in this population. */
export function countForType(
  rows: readonly CashActivityRow[],
  type: CashMovementType
): number {
  return rows.filter((row) => row.movementType === type).length;
}

/** A Money total as a plain two-decimal string. */
export function formatCashTotal(total: Money): string {
  return formatMoney(total);
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/**
 * A movement's note, faithfully, or a dash.
 *
 * NOTHING IS INVENTED. A `cash_drop` legitimately has no note — the drop is its
 * own reason — and the absence is shown as an absence rather than filled with a
 * placeholder that reads like a recorded reason. A stored note is already
 * trimmed and non-empty (cash_movements_note_shape), so it is passed through
 * untouched.
 */
export function describeNote(note: string | null): string {
  return typeof note === "string" && note.trim() !== "" ? note : CASH_NOTE_ABSENT_LABEL;
}

// ---------------------------------------------------------------------------
// Three identities, kept apart
// ---------------------------------------------------------------------------

/**
 * The employee a movement was authorized by, as the contract recorded them.
 *
 * READ, NEVER RESOLVED. `cash_movements.employee_id` is NOT NULL and the
 * contract inner-joins employees, so an attributed employee always exists and
 * always has a name. Nothing here consults the project owner, the current POS
 * operator, sale attribution, the Time Clock, the device or the register — each
 * of which would rewrite history to match the present. An employee who has
 * since been deactivated keeps every movement they authorized.
 *
 * Returns the empty string only if the server sent no name, and even then it
 * borrows nobody else's.
 */
export function describeMovementEmployee(row: CashActivityRow): string {
  return row.displayName;
}

/**
 * EMPLOYEE, DEVICE and REGISTER are three different things.
 *
 * A till is not a person and a drawer period is not a person. These helpers
 * exist so the screen can show device and register attribution without any
 * function ever turning one into the other.
 */
export function describeMovementDevice(row: CashActivityRow): string {
  return row.pairedDeviceId;
}

export function describeMovementRegister(row: CashActivityRow): string {
  return row.registerSessionId;
}
