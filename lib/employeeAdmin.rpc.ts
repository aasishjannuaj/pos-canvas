/**
 * v1.3 Feature 1F + Task 5B — the owner's employee-administration calls.
 *
 * ONE MODULE, SIX CONTRACTS, NO SEVENTH. Feature 1F wrapped set_employee_role
 * and recorded that create_employee, list_employees, set_employee_active,
 * set_employee_code and set_employee_pin already existed in the database with
 * the same owner authorization and still had no TypeScript caller. Task 5B is
 * that owner-admin surface, so those five are wrapped here now. Nothing was
 * added to the database to do it: every function below calls an accepted RPC
 * with its accepted arguments, and a capability the contracts do not offer is
 * reported as absent rather than invented — see EMPLOYEE_ADMIN_LIMITS in
 * lib/employeeAdmin.ts.
 *
 * AUTHORIZATION IS THE DATABASE'S, IN ALL SIX. Each function resolves
 * auth.uid(), refuses a caller that is itself a paired device, and reaches
 * employees only through a join to projects on projects.user_id — so "not
 * yours" and "does not exist" come back as one indistinguishable not_found.
 * No owner id is ever sent from here, and no service-role client is reachable
 * from this module.
 *
 * ROLE IS NOT A PERMISSION THIS MODULE GRANTS. It records what an employee is.
 * Authorization is resolved from employees.role at the moment of a privileged
 * operation, inside the database — never from a session payload, a cached
 * client value, or a role a caller supplied. So a downgrade takes effect on the
 * next authoritative resolution, with nothing to revoke and nothing to expire.
 *
 * AND IT IS AN OPERATIONAL ROLE, NOT A WEB ONE. An employee whose role is
 * `owner` is an owner AT THE TILL. It grants nothing in this administration
 * interface, which is reached only by the authenticated project owner
 * (auth.uid() = projects.user_id). Nothing in this module reads an employee
 * role to decide what a web user may do.
 *
 * NO PIN MATERIAL EXISTS IN THESE RESULTS. set_employee_pin returns an employee
 * id and nothing else — not the PIN, not a hash, not a length — and no other
 * contract here projects pin_hash at all. There is consequently no PIN value
 * for any caller to display, prefill, cache or log, and this module does not
 * reconstruct one.
 */
import { createClient } from "@/lib/supabase/client";
import {
  EMPLOYEE_CODE_SHAPE_MESSAGE,
  EMPLOYEE_CODE_TAKEN_MESSAGE,
  EMPLOYEE_NAME_REQUIRED_MESSAGE,
  EMPLOYEE_PIN_SHAPE_MESSAGE,
} from "@/lib/employeeAdmin";
import {
  EMPLOYEE_ROLES,
  isEmployeeRole,
  isValidEmployeeCodeShape,
  isValidEmployeePinShape,
} from "@/lib/employeeSession";
import type { EmployeeRole } from "@/lib/employeeSession";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The refusal code shared by every contract in this module.
 *
 * `unavailable` is this module's own, never the server's: it means the call did
 * not complete, or completed with a body that could not be read. It is always
 * separate from a catalogued refusal, because "we do not know" and "the server
 * said no" must not be shown to an owner as the same thing.
 */
type TransportErrorCode = "unavailable";

/** Reads a catalogued `error` string, or falls back to `unavailable`. */
function refusal<T extends string>(
  payload: Record<string, unknown>,
  known: readonly T[]
): T | TransportErrorCode {
  const error = payload.error;

  return typeof error === "string" && (known as readonly string[]).includes(error)
    ? (error as T)
    : "unavailable";
}

// ---------------------------------------------------------------------------
// list_employees — the owner's roster
// ---------------------------------------------------------------------------

/**
 * One employee, exactly as list_employees projects them.
 *
 * `employeeCode` IS THE AUTHORITATIVE READ VALUE, added to the contract by
 * migration 20260929120000. It is the roster's own answer for this employee,
 * so a reloaded screen no longer has to remember anything: whatever the list
 * says is what is shown.
 *
 * IT IS text OR null, AND NEVER A NUMBER. `001` arrives as the JSON string
 * "001" and is carried as a string all the way to the screen — an Employee ID
 * is identity data whose leading zeros are part of it, and any numeric
 * conversion would turn `001` into `1` and address the wrong person. null is a
 * legitimate state: an employee who left before Employee IDs existed has none,
 * and that is reported as unassigned rather than repaired.
 *
 * STILL ABSENT: pin_hash and every other credential field. The contract never
 * selects the column, so none can appear here.
 */
export type EmployeeSummary = {
  employeeId: string;
  displayName: string;
  role: EmployeeRole;
  active: boolean;
  createdAt: string | null;
  deactivatedAt: string | null;
  employeeCode: string | null;
};

export type ListEmployeesErrorCode = "not_authenticated" | "not_found" | "unavailable";

export const LIST_EMPLOYEES_MESSAGES: Record<ListEmployeesErrorCode, string> = {
  not_authenticated: "Sign in to see this project's employees.",
  not_found: "That project is not available.",
  unavailable: "The employee list could not be loaded. Please try again.",
};

export type ListEmployeesResult =
  | { ok: true; employees: EmployeeSummary[] }
  | { ok: false; code: ListEmployeesErrorCode };

function parseEmployeeSummary(value: unknown): EmployeeSummary | null {
  if (!isRecord(value)) return null;

  const employeeId = value.employeeId;
  const displayName = value.displayName;

  // An unreadable row is dropped rather than repaired: a roster entry with a
  // guessed id could send a code or PIN change to the wrong person.
  if (
    typeof employeeId !== "string" ||
    employeeId === "" ||
    typeof displayName !== "string" ||
    !isEmployeeRole(value.role) ||
    typeof value.active !== "boolean"
  ) {
    return null;
  }

  return {
    employeeId,
    displayName,
    role: value.role,
    active: value.active,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
    deactivatedAt: typeof value.deactivatedAt === "string" ? value.deactivatedAt : null,
    // Taken as the string it is. Anything that is not a string — JSON null for
    // a legacy employee, or a malformed value — becomes null, the honest
    // "unassigned" state. It is never parsed, padded, trimmed or coerced.
    employeeCode: typeof value.employeeCode === "string" ? value.employeeCode : null,
  };
}

export function parseListEmployeesResult(payload: unknown): ListEmployeesResult {
  if (!isRecord(payload)) return { ok: false, code: "unavailable" };

  if (payload.ok !== true) {
    return {
      ok: false,
      code: refusal(payload, ["not_authenticated", "not_found"] as const),
    };
  }

  const rows = payload.employees;

  if (!Array.isArray(rows)) return { ok: false, code: "unavailable" };

  const employees: EmployeeSummary[] = [];

  for (const row of rows) {
    const employee = parseEmployeeSummary(row);

    if (employee !== null) employees.push(employee);
  }

  // A project with no employees answers `[]`, which is a real and different
  // answer from "the list could not be read" — the caller must be able to tell
  // "nobody yet" from "we do not know", so an empty success stays a success.
  return { ok: true, employees };
}

export async function listEmployees(projectId: string): Promise<ListEmployeesResult> {
  const supabase = createClient();

  const { data, error } = await supabase.rpc("list_employees", {
    p_project_id: projectId,
  });

  if (error) return { ok: false, code: "unavailable" };

  return parseListEmployeesResult(data);
}

// ---------------------------------------------------------------------------
// create_employee — hiring
// ---------------------------------------------------------------------------

export type CreateEmployeeErrorCode =
  | "not_authenticated"
  | "not_found"
  | "invalid_display_name"
  | "invalid_role"
  | "invalid_employee_code"
  | "invalid_pin"
  | "employee_code_taken"
  | "unavailable";

export const CREATE_EMPLOYEE_MESSAGES: Record<CreateEmployeeErrorCode, string> = {
  not_authenticated: "Sign in to add an employee.",
  not_found: "That project is not available.",
  invalid_display_name: EMPLOYEE_NAME_REQUIRED_MESSAGE,
  invalid_role: `Choose one of: ${EMPLOYEE_ROLES.join(", ")}.`,
  invalid_employee_code: EMPLOYEE_CODE_SHAPE_MESSAGE,
  invalid_pin: EMPLOYEE_PIN_SHAPE_MESSAGE,
  employee_code_taken: EMPLOYEE_CODE_TAKEN_MESSAGE,
  unavailable: "The employee could not be added. Please try again.",
};

/**
 * What the server says about a newly created employee.
 *
 * `employeeCode` is present because create_employee returns it — this is the
 * one moment the owner is told an Employee ID by the server, and it is the
 * value they just chose, not a retrieved secret.
 */
export type CreatedEmployee = {
  employeeId: string;
  displayName: string;
  role: EmployeeRole;
  employeeCode: string;
  active: boolean;
};

export type CreateEmployeeResult =
  | { ok: true; employee: CreatedEmployee }
  | { ok: false; code: CreateEmployeeErrorCode };

const CREATE_EMPLOYEE_REFUSALS = [
  "not_authenticated",
  "not_found",
  "invalid_display_name",
  "invalid_role",
  "invalid_employee_code",
  "invalid_pin",
  "employee_code_taken",
] as const;

export function parseCreateEmployeeResult(payload: unknown): CreateEmployeeResult {
  if (!isRecord(payload)) return { ok: false, code: "unavailable" };

  if (payload.ok !== true) {
    return { ok: false, code: refusal(payload, CREATE_EMPLOYEE_REFUSALS) };
  }

  const employeeId = payload.employeeId;
  const employeeCode = payload.employeeCode;

  // A success that cannot be read is not reported as one: the owner would be
  // shown an Employee ID the server may not have stored.
  if (
    typeof employeeId !== "string" ||
    employeeId === "" ||
    typeof employeeCode !== "string" ||
    !isEmployeeRole(payload.role) ||
    typeof payload.active !== "boolean"
  ) {
    return { ok: false, code: "unavailable" };
  }

  return {
    ok: true,
    employee: {
      employeeId,
      displayName: typeof payload.displayName === "string" ? payload.displayName : "",
      role: payload.role,
      employeeCode,
      active: payload.active,
    },
  };
}

export async function createEmployee(input: {
  projectId: string;
  displayName: string;
  role: EmployeeRole;
  employeeCode: string;
  pin: string;
}): Promise<CreateEmployeeResult> {
  const supabase = createClient();

  // The PIN is an argument and never anything else: it is not logged, not
  // stored, not returned, and the only reference to it dies with this call.
  const { data, error } = await supabase.rpc("create_employee", {
    p_project_id: input.projectId,
    p_display_name: input.displayName,
    p_role: input.role,
    p_employee_code: input.employeeCode,
    p_pin: input.pin,
  });

  if (error) return { ok: false, code: "unavailable" };

  return parseCreateEmployeeResult(data);
}

// ---------------------------------------------------------------------------
// set_employee_code — reassigning an Employee ID
// ---------------------------------------------------------------------------

export type SetEmployeeCodeErrorCode =
  | "not_authenticated"
  | "not_found"
  | "invalid_employee_code"
  | "employee_code_taken"
  | "unavailable";

export const SET_EMPLOYEE_CODE_MESSAGES: Record<SetEmployeeCodeErrorCode, string> = {
  not_authenticated: "Sign in to change an Employee ID.",
  not_found: "That employee is not available.",
  invalid_employee_code: EMPLOYEE_CODE_SHAPE_MESSAGE,
  employee_code_taken: EMPLOYEE_CODE_TAKEN_MESSAGE,
  unavailable: "The Employee ID could not be changed. Please try again.",
};

export type SetEmployeeCodeResult =
  | { ok: true; employeeId: string; employeeCode: string }
  | { ok: false; code: SetEmployeeCodeErrorCode };

export function parseSetEmployeeCodeResult(payload: unknown): SetEmployeeCodeResult {
  if (!isRecord(payload)) return { ok: false, code: "unavailable" };

  if (payload.ok !== true) {
    return {
      ok: false,
      code: refusal(payload, [
        "not_authenticated",
        "not_found",
        "invalid_employee_code",
        "employee_code_taken",
      ] as const),
    };
  }

  const employeeId = payload.employeeId;
  const employeeCode = payload.employeeCode;

  if (
    typeof employeeId !== "string" ||
    employeeId === "" ||
    typeof employeeCode !== "string"
  ) {
    return { ok: false, code: "unavailable" };
  }

  return { ok: true, employeeId, employeeCode };
}

export async function setEmployeeCode(
  employeeId: string,
  employeeCode: string
): Promise<SetEmployeeCodeResult> {
  const supabase = createClient();

  const { data, error } = await supabase.rpc("set_employee_code", {
    p_employee_id: employeeId,
    p_employee_code: employeeCode,
  });

  if (error) return { ok: false, code: "unavailable" };

  return parseSetEmployeeCodeResult(data);
}

// ---------------------------------------------------------------------------
// set_employee_pin — a new PIN, and nothing said about it afterwards
// ---------------------------------------------------------------------------

export type SetEmployeePinErrorCode =
  | "not_authenticated"
  | "not_found"
  | "invalid_pin"
  | "unavailable";

export const SET_EMPLOYEE_PIN_MESSAGES: Record<SetEmployeePinErrorCode, string> = {
  not_authenticated: "Sign in to set a PIN.",
  not_found: "That employee is not available.",
  invalid_pin: EMPLOYEE_PIN_SHAPE_MESSAGE,
  unavailable: "The PIN could not be changed. Please try again.",
};

/**
 * The success carries an employee id and NOTHING ELSE.
 *
 * This shape is the server's and is reproduced exactly. It is the reason no
 * caller in this codebase can display, confirm or re-show a PIN: there is no
 * field in which one could arrive.
 */
export type SetEmployeePinResult =
  | { ok: true; employeeId: string }
  | { ok: false; code: SetEmployeePinErrorCode };

export function parseSetEmployeePinResult(payload: unknown): SetEmployeePinResult {
  if (!isRecord(payload)) return { ok: false, code: "unavailable" };

  if (payload.ok !== true) {
    return {
      ok: false,
      code: refusal(payload, ["not_authenticated", "not_found", "invalid_pin"] as const),
    };
  }

  const employeeId = payload.employeeId;

  if (typeof employeeId !== "string" || employeeId === "") {
    return { ok: false, code: "unavailable" };
  }

  return { ok: true, employeeId };
}

export async function setEmployeePin(
  employeeId: string,
  pin: string
): Promise<SetEmployeePinResult> {
  const supabase = createClient();

  const { data, error } = await supabase.rpc("set_employee_pin", {
    p_employee_id: employeeId,
    p_pin: pin,
  });

  if (error) return { ok: false, code: "unavailable" };

  return parseSetEmployeePinResult(data);
}

// ---------------------------------------------------------------------------
// set_employee_active — leaving, and coming back
// ---------------------------------------------------------------------------

export type SetEmployeeActiveErrorCode =
  | "not_authenticated"
  | "not_found"
  | "employee_code_required"
  | "employee_code_taken"
  | "unavailable";

/**
 * The two reactivation refusals say different things and must not be merged.
 *
 * `employee_code_taken` means somebody working today holds the ID this person
 * left with; `employee_code_required` means they predate Employee IDs and have
 * none at all. Both are fixed by assigning an Employee ID first, and neither is
 * a reason to renumber anyone silently — which is precisely what the database
 * refuses to do on its own.
 */
export const SET_EMPLOYEE_ACTIVE_MESSAGES: Record<SetEmployeeActiveErrorCode, string> = {
  not_authenticated: "Sign in to change an employee's status.",
  not_found: "That employee is not available.",
  employee_code_required:
    "This employee has no Employee ID. Assign one, then reactivate them.",
  employee_code_taken:
    "Their previous Employee ID now belongs to an active employee. Assign a different Employee ID, then reactivate them.",
  unavailable: "The employee's status could not be changed. Please try again.",
};

export type SetEmployeeActiveResult =
  | { ok: true; employeeId: string; active: boolean }
  | { ok: false; code: SetEmployeeActiveErrorCode };

export function parseSetEmployeeActiveResult(payload: unknown): SetEmployeeActiveResult {
  if (!isRecord(payload)) return { ok: false, code: "unavailable" };

  if (payload.ok !== true) {
    return {
      ok: false,
      code: refusal(payload, [
        "not_authenticated",
        "not_found",
        "employee_code_required",
        "employee_code_taken",
      ] as const),
    };
  }

  const employeeId = payload.employeeId;

  if (typeof employeeId !== "string" || employeeId === "" || typeof payload.active !== "boolean") {
    return { ok: false, code: "unavailable" };
  }

  return { ok: true, employeeId, active: payload.active };
}

export async function setEmployeeActive(
  employeeId: string,
  active: boolean
): Promise<SetEmployeeActiveResult> {
  const supabase = createClient();

  const { data, error } = await supabase.rpc("set_employee_active", {
    p_employee_id: employeeId,
    p_active: active,
  });

  if (error) return { ok: false, code: "unavailable" };

  return parseSetEmployeeActiveResult(data);
}

// ---------------------------------------------------------------------------
// set_employee_role — Feature 1F, unchanged
// ---------------------------------------------------------------------------

export type SetEmployeeRoleErrorCode =
  | "not_authenticated"
  | "not_found"
  | "invalid_role"
  | "unavailable";

export const SET_EMPLOYEE_ROLE_MESSAGES: Record<SetEmployeeRoleErrorCode, string> = {
  not_authenticated: "Sign in to change an employee's role.",
  // The server refuses to distinguish "no such employee" from "not yours", and
  // this message refuses to guess which it was.
  not_found: "That employee is not available.",
  invalid_role: `Choose one of: ${EMPLOYEE_ROLES.join(", ")}.`,
  unavailable: "The role could not be changed. Please try again.",
};

export function getSetEmployeeRoleMessage(code: SetEmployeeRoleErrorCode): string {
  return SET_EMPLOYEE_ROLE_MESSAGES[code];
}

export type SetEmployeeRoleResult =
  | {
      ok: true;
      employeeId: string;
      displayName: string;
      role: EmployeeRole;
      active: boolean;
    }
  | { ok: false; code: SetEmployeeRoleErrorCode };

export function parseSetEmployeeRoleResult(payload: unknown): SetEmployeeRoleResult {
  if (!isRecord(payload)) return { ok: false, code: "unavailable" };

  if (payload.ok !== true) {
    const error = payload.error;

    return {
      ok: false,
      code:
        error === "not_authenticated" || error === "not_found" || error === "invalid_role"
          ? error
          : "unavailable",
    };
  }

  const employeeId = typeof payload.employeeId === "string" ? payload.employeeId : null;

  // A success that cannot be read is not reported as a success: the caller
  // would show a role the server may not have stored.
  if (
    employeeId === null ||
    !isEmployeeRole(payload.role) ||
    typeof payload.active !== "boolean"
  ) {
    return { ok: false, code: "unavailable" };
  }

  return {
    ok: true,
    employeeId,
    displayName: typeof payload.displayName === "string" ? payload.displayName : "",
    role: payload.role,
    active: payload.active,
  };
}

export async function setEmployeeRole(
  employeeId: string,
  role: EmployeeRole
): Promise<SetEmployeeRoleResult> {
  const supabase = createClient();

  const { data, error } = await supabase.rpc("set_employee_role", {
    p_employee_id: employeeId,
    p_role: role,
  });

  if (error) return { ok: false, code: "unavailable" };

  return parseSetEmployeeRoleResult(data);
}

// ---------------------------------------------------------------------------
// Shape checks, borrowed rather than restated
// ---------------------------------------------------------------------------

/**
 * Re-exported from lib/employeeSession so the owner UI and the till apply ONE
 * rule each for Employee IDs and PINs.
 *
 * Restating `^[0-9]{3}$` or `^[0-9]{4}$` here would create a second copy free
 * to drift from both the till's and the server's — and the server's is the
 * authority in every case: these only let the form say so without a round trip.
 */
export { isValidEmployeeCodeShape, isValidEmployeePinShape };
