// v1.3 Task 5B — the owner's employee administration, as a pure model.
//
// PURE. No Supabase, no React, no storage, no clock. The calls live in
// lib/employeeAdmin.rpc.ts and the screen in components/employees; this module
// holds the decisions that are worth testing without either — which employees
// appear where, what an owner is told before they deactivate somebody, and
// which sentences the form and the server must agree on word for word.
//
// IT HOLDS NO PIN AND NO PIN STATE. There is no PIN parameter, no PIN field, no
// PIN in any type declared here, and nothing here is cached or persisted. A PIN
// exists only as an argument to one RPC call and dies with it.
//
// THE LIMIT BELOW IS A FINDING, NOT A CHOICE. Task 5B consumes the accepted
// employee contracts and adds none. One thing an owner would reasonably expect
// is therefore not offered, and it is stated to the owner rather than faked:
// see EMPLOYEE_ADMIN_LIMITS. A second limitation lived here until the accepted
// backend correction (migration 20260929120000) made list_employees return
// employeeCode; it has been removed, not left standing as obsolete advice.
import { isValidEmployeeCodeShape, isValidEmployeePinShape } from "@/lib/employeeSession";
import type { EmployeeRole } from "@/lib/employeeSession";

// ---------------------------------------------------------------------------
// The sentences the form and the server share
// ---------------------------------------------------------------------------

// ONE COPY EACH, imported by lib/employeeAdmin.rpc.ts for the matching server
// refusal. The form checks a shape to save a round trip and the server checks
// it again as the authority; if the two ever printed different sentences for
// the same rule, one of them would be teaching the owner something false.
export const EMPLOYEE_NAME_REQUIRED_MESSAGE = "Enter the employee's name.";
export const EMPLOYEE_CODE_SHAPE_MESSAGE = "Employee ID must be three digits, 001 to 999.";
export const EMPLOYEE_PIN_SHAPE_MESSAGE = "PIN must be exactly four digits.";
export const EMPLOYEE_CODE_TAKEN_MESSAGE =
  "That Employee ID is already in use. Choose another.";

// ---------------------------------------------------------------------------
// What the accepted contracts do not offer
// ---------------------------------------------------------------------------

/**
 * The one capability this screen does NOT have, and says so.
 *
 * RENAME. The only employee mutations that exist are create_employee,
 * set_employee_code, set_employee_pin, set_employee_active and
 * set_employee_role. None of them writes display_name after creation, so there
 * is no contract to call. Offering a name field that silently did nothing, or
 * writing employees.display_name directly from the browser, would each be
 * worse than the absence.
 *
 * WHAT WAS HERE AND IS NOW GONE: `employeeCodeHidden`, which told the owner
 * that existing Employee IDs could not be shown. That was true of the contract
 * Task 5B was built against and is FALSE of the current one — migration
 * 20260929120000 added `employeeCode` to list_employees. A limitation notice
 * that has been resolved is not a harmless leftover: it teaches an owner that
 * a value they can plainly see is unavailable.
 */
export const EMPLOYEE_ADMIN_LIMITS = {
  rename:
    "Employee names cannot be changed after an employee is added. Add the employee again under the correct name and deactivate the old record.",
} as const;

// ---------------------------------------------------------------------------
// Deactivating somebody: what actually happens
// ---------------------------------------------------------------------------

/**
 * The truthful consequences of set_employee_active(id, false).
 *
 * EVERY LINE IS READ OFF THE BACKEND, not off an intention:
 *
 *   * employee_login and employee_login_by_code skip inactive employees, and
 *     get_current_employee_session filters on e.active — so sign-in stops and
 *     they stop being reported as the operator;
 *   * set_employee_active touches employee_pos_sessions and
 *     employee_time_sessions NOT AT ALL — an open session stays open and no
 *     history is rewritten;
 *   * clock_out_employee also requires an active employee, so somebody
 *     deactivated mid-shift cannot clock themselves out at the till afterwards;
 *   * employees_active_project_code_key is partial (`where active`), so the
 *     Employee ID they held becomes available to somebody else.
 *
 * THIS SCREEN PERFORMS NONE OF THOSE SIDE EFFECTS ITSELF. It does not ring out,
 * end a POS session, clock anybody out or edit a time record — it states what
 * the one authorized call does, so the owner decides with the facts.
 */
export const DEACTIVATION_CONSEQUENCES: readonly string[] = [
  "They can no longer sign in at a till.",
  "An open till session or Time Clock shift is not closed, and past records are kept.",
  "If they are clocked in, clock them out before deactivating — they cannot clock out afterwards.",
  "Their Employee ID becomes available for someone else.",
] as const;

/** Reactivation is not the mirror image, and the owner is told why up front. */
export const REACTIVATION_NOTICE =
  "Reactivating is refused if someone else now holds their Employee ID. Assign a different Employee ID first.";

// ---------------------------------------------------------------------------
// The roster, arranged
// ---------------------------------------------------------------------------

/** The subset of a listed employee this model needs. */
export type RosterEmployee = {
  employeeId: string;
  displayName: string;
  role: EmployeeRole;
  active: boolean;
  createdAt: string | null;
  deactivatedAt: string | null;
  /** The roster's own answer, as text; null when this employee has none. */
  employeeCode: string | null;
};

export type EmployeeRoster<T extends RosterEmployee> = {
  active: T[];
  inactive: T[];
};

/**
 * Split into who works here and who used to, preserving the server's order.
 *
 * ORDER IS NOT RECOMPUTED. list_employees orders by created_at then id, which
 * is stable and already correct; re-sorting by name here would mean the list
 * reshuffled whenever a later feature changed a name, and would quietly depend
 * on a locale. Only the split is this module's decision.
 *
 * INACTIVE EMPLOYEES ARE NOT HIDDEN. They are the ones an owner comes here to
 * reactivate, and a leaver who has vanished from the screen looks like deleted
 * history — which is exactly what the backend refuses to do.
 */
export function groupEmployeesByStatus<T extends RosterEmployee>(
  employees: readonly T[]
): EmployeeRoster<T> {
  const active: T[] = [];
  const inactive: T[] = [];

  for (const employee of employees) {
    if (employee.active) active.push(employee);
    else inactive.push(employee);
  }

  return { active, inactive };
}

/** "Active", or "Inactive" — the status an owner reads on the row. */
export function describeEmployeeStatus(employee: RosterEmployee): string {
  return employee.active ? "Active" : "Inactive";
}

// ---------------------------------------------------------------------------
// The Employee ID, read from the row it belongs to
// ---------------------------------------------------------------------------

/** What an employee with no Employee ID reads as. */
export const EMPLOYEE_CODE_UNASSIGNED_LABEL = "Not assigned";

/**
 * What to show in the Employee ID column.
 *
 * ONE SOURCE, AND IT IS THE LIST ROW. This takes the value straight off the
 * employee it was given, so a refresh, a remount or any ordinary reload shows
 * whatever list_employees currently says. There is deliberately no cache and no
 * map keyed by employee id: a remembered code is a second source of truth that
 * would go stale the moment anything changed it elsewhere, and an earlier draft
 * of this screen carried exactly that (`KnownEmployeeCodes`) because the old
 * contract returned no code on read. It does now, so the cache is gone rather
 * than merely unused.
 *
 * NOT A NUMBER, AT ANY POINT. The value is returned as it was stored: `001`
 * stays `"001"` and `025` stays `"025"`. Nothing here parses, pads, trims or
 * formats it, because the leading zeros ARE the identity — `1` and `001` are
 * different Employee IDs to everybody who types one at a till.
 *
 * NULL IS A TRUTHFUL STATE, NOT A GAP TO FILL. An employee who left before
 * Employee IDs existed has none. They read as unassigned; they are never shown
 * `000`, never given an invented `001`, and never mutated to acquire one.
 */
export function describeEmployeeCode(employeeCode: string | null | undefined): string {
  return typeof employeeCode === "string" && employeeCode !== ""
    ? employeeCode
    : EMPLOYEE_CODE_UNASSIGNED_LABEL;
}

// ---------------------------------------------------------------------------
// The add-employee form, before it costs a round trip
// ---------------------------------------------------------------------------

export type EmployeeDraft = {
  displayName: string;
  role: EmployeeRole;
  employeeCode: string;
  pin: string;
};

export type EmployeeDraftField = "displayName" | "employeeCode" | "pin";

export type EmployeeDraftProblem = {
  field: EmployeeDraftField;
  message: string;
};

/**
 * The first thing wrong with a draft, in the order the fields are read.
 *
 * A SHAPE CHECK, NEVER A DECISION. It repeats no rule of its own: the name test
 * is the server's `btrim(...) = ''`, and the ID and PIN tests are
 * isValidEmployeeCodeShape and isValidEmployeePinShape, the same predicates the
 * till uses, matching `^[0-9]{3}$`/not `000` and `^[0-9]{4}$`. Whether the ID is
 * free, and whether anything may be written at all, remain the server's answers
 * — this only spares the owner a round trip to be told a PIN needs four digits.
 *
 * One problem at a time, in field order, so focus can go to it.
 */
export function findEmployeeDraftProblem(draft: EmployeeDraft): EmployeeDraftProblem | null {
  if (draft.displayName.trim() === "") {
    return { field: "displayName", message: EMPLOYEE_NAME_REQUIRED_MESSAGE };
  }

  if (!isValidEmployeeCodeShape(draft.employeeCode)) {
    return { field: "employeeCode", message: EMPLOYEE_CODE_SHAPE_MESSAGE };
  }

  if (!isValidEmployeePinShape(draft.pin)) {
    return { field: "pin", message: EMPLOYEE_PIN_SHAPE_MESSAGE };
  }

  return null;
}

/** An empty draft. `role` starts at the least privileged of the three. */
export function emptyEmployeeDraft(): EmployeeDraft {
  return { displayName: "", role: "cashier", employeeCode: "", pin: "" };
}
