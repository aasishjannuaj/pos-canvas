"use client";

// v1.3 Task 5B — the confirmation before somebody is deactivated.
//
// IT EXISTS TO TELL THE TRUTH, NOT TO ADD FRICTION. Deactivation is the one
// action here whose consequences reach beyond this screen, and three of them
// are easy to guess wrong: an open till session is NOT closed, a clocked-in
// employee cannot clock out afterwards, and their Employee ID becomes free for
// somebody else. DEACTIVATION_CONSEQUENCES states what the single authorized
// call does — this dialog performs none of it, and nothing here rings anyone
// out, ends a session or edits a time record.
import { DEACTIVATION_CONSEQUENCES } from "@/lib/employeeAdmin";
import type { EmployeeSummary } from "@/lib/employeeAdmin.rpc";

type DeactivateEmployeeDialogProps = {
  employee: EmployeeSummary;
  onConfirm: () => void;
  onDismiss: () => void;
  isSubmitting: boolean;
  errorMessage: string | null;
};

export default function DeactivateEmployeeDialog({
  employee,
  onConfirm,
  onDismiss,
  isSubmitting,
  errorMessage,
}: DeactivateEmployeeDialogProps) {
  return (
    <section
      role="alertdialog"
      aria-labelledby="deactivate-employee-heading"
      className="rounded-xl border border-amber-200 bg-amber-50 p-6"
    >
      <h3
        id="deactivate-employee-heading"
        className="text-sm font-semibold text-neutral-900"
      >
        Deactivate {employee.displayName}?
      </h3>

      <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed text-neutral-700">
        {DEACTIVATION_CONSEQUENCES.map((consequence) => (
          <li key={consequence}>{consequence}</li>
        ))}
      </ul>

      {errorMessage !== null && (
        <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={isSubmitting}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-neutral-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 disabled:cursor-not-allowed disabled:bg-neutral-400"
        >
          {isSubmitting ? "Deactivating…" : "Deactivate"}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={isSubmitting}
          className="rounded-lg border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 disabled:cursor-not-allowed disabled:text-neutral-400"
        >
          Cancel
        </button>
      </div>
    </section>
  );
}
