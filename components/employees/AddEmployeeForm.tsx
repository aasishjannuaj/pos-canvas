"use client";

// v1.3 Task 5B — the add-employee form.
//
// PRESENTATIONAL. It holds no state of its own, which is the point: the PIN
// value lives in EmployeeManagementPanel so that clearing it on success is one
// container's guarantee rather than a habit spread across components. This file
// renders what it is given and reports what was typed.
//
// THE PIN FIELD NEVER SHOWS, REMEMBERS OR RESTORES A PIN. It is a password
// input with autoComplete off, it starts empty for every employee, and there is
// no existing PIN anywhere in this codebase's reach to prefill it with —
// set_employee_pin returns an employee id and nothing more.
import { EMPLOYEE_ROLES } from "@/lib/employeeSession";
import type { EmployeeRole } from "@/lib/employeeSession";
import type { EmployeeDraft, EmployeeDraftProblem } from "@/lib/employeeAdmin";

const FIELD_CLASS =
  "rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none";
const LABEL_CLASS = "text-xs font-medium uppercase tracking-wide text-neutral-500";

type AddEmployeeFormProps = {
  draft: EmployeeDraft;
  onDraftChange: (patch: Partial<EmployeeDraft>) => void;
  onSubmit: () => void;
  isSubmitting: boolean;
  problem: EmployeeDraftProblem | null;
  errorMessage: string | null;
  successMessage: string | null;
};

export default function AddEmployeeForm({
  draft,
  onDraftChange,
  onSubmit,
  isSubmitting,
  problem,
  errorMessage,
  successMessage,
}: AddEmployeeFormProps) {
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-6">
      <h3 className="text-sm font-semibold text-neutral-900">Add an employee</h3>
      <p className="mt-2 text-sm leading-relaxed text-neutral-500">
        They sign in at the till with their Employee ID and PIN.
      </p>

      <form
        className="mt-4 flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label className={LABEL_CLASS} htmlFor="employee-name">
            Name
          </label>
          <input
            id="employee-name"
            type="text"
            value={draft.displayName}
            onChange={(event) => onDraftChange({ displayName: event.target.value })}
            className={FIELD_CLASS}
            autoComplete="off"
          />
          {problem?.field === "displayName" && (
            <p className="text-sm text-red-700">{problem.message}</p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label className={LABEL_CLASS} htmlFor="employee-role">
            Role
          </label>
          <select
            id="employee-role"
            value={draft.role}
            onChange={(event) =>
              onDraftChange({ role: event.target.value as EmployeeRole })
            }
            className={FIELD_CLASS}
          >
            {EMPLOYEE_ROLES.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className={LABEL_CLASS} htmlFor="employee-code">
            Employee ID
          </label>
          <input
            id="employee-code"
            type="text"
            inputMode="numeric"
            maxLength={3}
            value={draft.employeeCode}
            onChange={(event) => onDraftChange({ employeeCode: event.target.value })}
            className={FIELD_CLASS}
            autoComplete="off"
            placeholder="001"
          />
          {problem?.field === "employeeCode" && (
            <p className="text-sm text-red-700">{problem.message}</p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label className={LABEL_CLASS} htmlFor="employee-pin">
            PIN
          </label>
          <input
            id="employee-pin"
            // Masked, never stored, and cleared by the container the moment the
            // server accepts it.
            type="password"
            inputMode="numeric"
            maxLength={4}
            value={draft.pin}
            onChange={(event) => onDraftChange({ pin: event.target.value })}
            className={FIELD_CLASS}
            autoComplete="new-password"
          />
          {problem?.field === "pin" && (
            <p className="text-sm text-red-700">{problem.message}</p>
          )}
        </div>

        {errorMessage !== null && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorMessage}
          </p>
        )}

        {successMessage !== null && (
          <p role="status" className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">
            {successMessage}
          </p>
        )}

        <button
          type="submit"
          disabled={isSubmitting}
          className="self-start rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-neutral-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 disabled:cursor-not-allowed disabled:bg-neutral-400"
        >
          {isSubmitting ? "Adding…" : "Add Employee"}
        </button>
      </form>
    </section>
  );
}
