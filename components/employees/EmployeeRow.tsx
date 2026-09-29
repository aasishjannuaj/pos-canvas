"use client";

// v1.3 Task 5B — one employee, and the four things an owner may do to them.
//
// PRESENTATIONAL, INCLUDING THE INLINE EDITORS. Whether an editor is open, and
// what has been typed into it, are the container's state — so the Employee ID
// and PIN boxes cannot survive a row re-render, and clearing them is one place's
// job. See EmployeeManagementPanel.
//
// WHAT IS NOT HERE. No rename control, because no accepted contract writes
// display_name after creation. No retrieved Employee ID and no retrieved PIN,
// because list_employees returns neither — the ID column shows a value only
// when the server has just confirmed one, and no PIN is readable at all.
import { EMPLOYEE_ROLES } from "@/lib/employeeSession";
import type { EmployeeRole } from "@/lib/employeeSession";
import { describeEmployeeStatus } from "@/lib/employeeAdmin";
import type { EmployeeSummary } from "@/lib/employeeAdmin.rpc";

export type RowEditor = "code" | "pin";

const FIELD_CLASS =
  "rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none";
const ACTION_CLASS =
  "rounded-lg border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 disabled:cursor-not-allowed disabled:text-neutral-400";

type EmployeeRowProps = {
  employee: EmployeeSummary;
  employeeCodeLabel: string;
  openEditor: RowEditor | null;
  editorValue: string;
  onEditorValueChange: (value: string) => void;
  onOpenEditor: (editor: RowEditor) => void;
  onCancelEditor: () => void;
  onSubmitEditor: () => void;
  onRoleChange: (role: EmployeeRole) => void;
  onToggleActive: () => void;
  isBusy: boolean;
  errorMessage: string | null;
  noticeMessage: string | null;
};

export default function EmployeeRow({
  employee,
  employeeCodeLabel,
  openEditor,
  editorValue,
  onEditorValueChange,
  onOpenEditor,
  onCancelEditor,
  onSubmitEditor,
  onRoleChange,
  onToggleActive,
  isBusy,
  errorMessage,
  noticeMessage,
}: EmployeeRowProps) {
  return (
    <li className="flex flex-col gap-3 border-t border-neutral-100 px-4 py-4 first:border-t-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-neutral-900">
            {employee.displayName}
          </p>
          <p className="mt-0.5 text-xs text-neutral-500">
            Employee ID {employeeCodeLabel} · {describeEmployeeStatus(employee)}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`employee-role-${employee.employeeId}`}>
            Role for {employee.displayName}
          </label>
          <select
            id={`employee-role-${employee.employeeId}`}
            value={employee.role}
            disabled={isBusy}
            onChange={(event) => onRoleChange(event.target.value as EmployeeRole)}
            className={FIELD_CLASS}
          >
            {EMPLOYEE_ROLES.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>

          <button
            type="button"
            className={ACTION_CLASS}
            disabled={isBusy}
            onClick={() => onOpenEditor("code")}
          >
            Set Employee ID
          </button>

          <button
            type="button"
            className={ACTION_CLASS}
            disabled={isBusy}
            onClick={() => onOpenEditor("pin")}
          >
            Set PIN
          </button>

          <button
            type="button"
            className={ACTION_CLASS}
            disabled={isBusy}
            onClick={onToggleActive}
          >
            {employee.active ? "Deactivate" : "Reactivate"}
          </button>
        </div>
      </div>

      {openEditor !== null && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmitEditor();
          }}
        >
          <label
            className="text-xs font-medium uppercase tracking-wide text-neutral-500"
            htmlFor={`employee-${openEditor}-${employee.employeeId}`}
          >
            {openEditor === "code" ? "New Employee ID" : "New PIN"}
          </label>
          <input
            id={`employee-${openEditor}-${employee.employeeId}`}
            // A new PIN is masked as it is typed and is never restored into
            // this box afterwards: the container clears it on success, and
            // nothing can read an existing PIN back to prefill it.
            type={openEditor === "code" ? "text" : "password"}
            inputMode="numeric"
            maxLength={openEditor === "code" ? 3 : 4}
            value={editorValue}
            onChange={(event) => onEditorValueChange(event.target.value)}
            className={FIELD_CLASS}
            autoComplete={openEditor === "code" ? "off" : "new-password"}
          />
          <button
            type="submit"
            disabled={isBusy}
            className="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-neutral-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 disabled:cursor-not-allowed disabled:bg-neutral-400"
          >
            Save
          </button>
          <button type="button" className={ACTION_CLASS} onClick={onCancelEditor}>
            Cancel
          </button>
        </form>
      )}

      {errorMessage !== null && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </p>
      )}

      {noticeMessage !== null && (
        <p role="status" className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">
          {noticeMessage}
        </p>
      )}
    </li>
  );
}
