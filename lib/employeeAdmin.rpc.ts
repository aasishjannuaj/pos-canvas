/**
 * v1.3 Feature 1F — the owner's employee-role change.
 *
 * SCOPE, STATED SO IT IS NOT MISREAD. This module wraps the ONE employee
 * mutation Feature 1F introduces. create_employee, list_employees,
 * set_employee_active, set_employee_code and set_employee_pin already exist in
 * the database with the same owner authorization and still have no TypeScript
 * caller; wrapping them is owner-admin surface work, not part of 1F's
 * authorized backend contract, and is deliberately left alone here.
 *
 * ROLE IS NOT A PERMISSION THIS CALL GRANTS. It records what an employee is.
 * Authorization is resolved from employees.role at the moment of a privileged
 * operation, inside the database — never from a session payload, a cached
 * client value, or a role a caller supplied. So a downgrade takes effect on the
 * next authoritative resolution, with nothing to revoke and nothing to expire.
 */
import { createClient } from "@/lib/supabase/client";
import { EMPLOYEE_ROLES, isEmployeeRole } from "@/lib/employeeSession";
import type { EmployeeRole } from "@/lib/employeeSession";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
