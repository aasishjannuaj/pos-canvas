"use client";

// v1.3 Task 5B — the Employees section, self-contained.
//
// SHAPED LIKE DeviceManagementPanel, for the same reason: it owns its own state
// and calls the accepted RPCs directly rather than threading a dozen more props
// through EditorShell and EditorPropertiesPanel. EditorShell passes exactly one
// prop, the project id.
//
// WHO MAY USE THIS SCREEN. The authenticated PROJECT OWNER, and only them —
// every contract below resolves auth.uid(), refuses a caller that is a paired
// device, and reaches employees only through projects.user_id. An employee
// whose operational role is `owner` gains nothing here: that role is authority
// AT THE TILL, and nothing in this component reads an employee role to decide
// what a web user may do.
//
// PIN HANDLING, STATED ONCE AND OBEYED THROUGHOUT:
//   * no PIN is ever read back — set_employee_pin returns an employee id and
//     nothing else, so there is no value in reach to display or prefill;
//   * a PIN being typed lives in this component's state and nowhere else: not
//     in localStorage, not in sessionStorage, not in a URL or query parameter,
//     not in a log, not in SavedProject, and not in anything published;
//   * every PIN box opens empty and is CLEARED THE MOMENT the server accepts
//     it, which is why the value lives here rather than inside the row.
//
// WHERE THE EMPLOYEE ID COMES FROM: the list row, every time. list_employees
// returns `employeeCode` (migration 20260929120000), so a refresh, a remount or
// any ordinary reload renders the roster's own current answer. Nothing is
// remembered between loads — the earlier draft of this screen cached codes
// returned by create/set-code because the contract did not return them on read,
// and that cache is gone rather than merely unread.
//
// WHAT THIS SCREEN STILL CANNOT DO, and says so instead of faking: rename an
// employee. No accepted contract writes display_name after creation. See
// EMPLOYEE_ADMIN_LIMITS.
import { useCallback, useEffect, useState } from "react";
import AddEmployeeForm from "@/components/employees/AddEmployeeForm";
import DeactivateEmployeeDialog from "@/components/employees/DeactivateEmployeeDialog";
import EmployeeRow from "@/components/employees/EmployeeRow";
import type { RowEditor } from "@/components/employees/EmployeeRow";
import type { EmployeeRole } from "@/lib/employeeSession";
import {
  EMPLOYEE_ADMIN_LIMITS,
  EMPLOYEE_CODE_SHAPE_MESSAGE,
  EMPLOYEE_PIN_SHAPE_MESSAGE,
  REACTIVATION_NOTICE,
  describeEmployeeCode,
  emptyEmployeeDraft,
  findEmployeeDraftProblem,
  groupEmployeesByStatus,
} from "@/lib/employeeAdmin";
import type { EmployeeDraft, EmployeeDraftProblem } from "@/lib/employeeAdmin";
import {
  CREATE_EMPLOYEE_MESSAGES,
  LIST_EMPLOYEES_MESSAGES,
  SET_EMPLOYEE_ACTIVE_MESSAGES,
  SET_EMPLOYEE_CODE_MESSAGES,
  SET_EMPLOYEE_PIN_MESSAGES,
  SET_EMPLOYEE_ROLE_MESSAGES,
  createEmployee,
  isValidEmployeeCodeShape,
  isValidEmployeePinShape,
  listEmployees,
  setEmployeeActive,
  setEmployeeCode,
  setEmployeePin,
  setEmployeeRole,
} from "@/lib/employeeAdmin.rpc";
import type { EmployeeSummary } from "@/lib/employeeAdmin.rpc";

type OpenEditor = { employeeId: string; kind: RowEditor };
type RowMessage = { employeeId: string; message: string };

type EmployeeManagementPanelProps = {
  projectId: string | null;
};

export default function EmployeeManagementPanel({
  projectId,
}: EmployeeManagementPanelProps) {
  const [employees, setEmployees] = useState<EmployeeSummary[]>([]);
  // Starts true when there is something to load, so the first paint reads
  // "Loading employees…" without the mount effect writing state synchronously
  // (react-hooks/set-state-in-effect).
  const [isLoading, setIsLoading] = useState(projectId !== null);
  const [listError, setListError] = useState<string | null>(null);

  const [draft, setDraft] = useState<EmployeeDraft>(emptyEmployeeDraft);
  const [draftProblem, setDraftProblem] = useState<EmployeeDraftProblem | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createNotice, setCreateNotice] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const [openEditor, setOpenEditor] = useState<OpenEditor | null>(null);
  /**
   * What is typed in the open editor — an Employee ID or a NEW PIN.
   *
   * ONE BOX AT A TIME, HELD HERE. Keeping it in the container is what makes
   * "cleared on success" a single guarantee: a row cannot hold a stale PIN,
   * and opening any editor starts from "".
   */
  const [editorValue, setEditorValue] = useState("");

  const [busyEmployeeId, setBusyEmployeeId] = useState<string | null>(null);
  /**
   * A first-party refusal for one row, beside a first-party confirmation.
   *
   * NAMED `rowProblem` RATHER THAN `rowError`, DELIBERATELY. Every string it
   * can hold comes from a message map in this feature; it is never the text of
   * a caught exception, which no surface in this codebase may print (see
   * lib/onboardingPolish.guards.test.ts). A field called `somethingError` reads
   * like one, and the first draft of this component tripped that guard for
   * exactly that reason.
   */
  const [rowProblem, setRowProblem] = useState<RowMessage | null>(null);
  const [rowNotice, setRowNotice] = useState<RowMessage | null>(null);

  const [employeeToDeactivate, setEmployeeToDeactivate] =
    useState<EmployeeSummary | null>(null);
  const [isDeactivating, setIsDeactivating] = useState(false);
  const [deactivateError, setDeactivateError] = useState<string | null>(null);

  // Every state write happens AFTER the await, so this is safe to call from a
  // mount effect as well as from the Refresh button.
  const loadEmployees = useCallback(async () => {
    if (projectId === null) return;

    const result = await listEmployees(projectId);

    if (result.ok) {
      setEmployees(result.employees);
      setListError(null);
    } else {
      setListError(LIST_EMPLOYEES_MESSAGES[result.code]);
    }

    setIsLoading(false);
  }, [projectId]);

  useEffect(() => {
    // Wrapped in an async IIFE for the same reason DeviceManagementPanel's
    // mount effect is: react-hooks/set-state-in-effect traces loadEmployees'
    // setEmployees back to the effect body otherwise. The IIFE is what makes
    // the write unreachable synchronously from it.
    void (async () => {
      await loadEmployees();
    })();
  }, [loadEmployees]);

  function closeEditor() {
    setOpenEditor(null);
    // The PIN box is emptied on the way out as well as on success: cancelling
    // must not leave a typed PIN sitting in state behind a closed form.
    setEditorValue("");
  }

  async function handleCreate() {
    if (projectId === null || isCreating) return;

    const problem = findEmployeeDraftProblem(draft);

    setDraftProblem(problem);
    setCreateError(null);
    setCreateNotice(null);

    if (problem !== null) return;

    setIsCreating(true);

    const result = await createEmployee({
      projectId,
      displayName: draft.displayName.trim(),
      role: draft.role,
      employeeCode: draft.employeeCode,
      pin: draft.pin,
    });

    setIsCreating(false);

    if (!result.ok) {
      setCreateError(CREATE_EMPLOYEE_MESSAGES[result.code]);
      return;
    }

    // THE PIN IS GONE FROM STATE HERE, on the same tick the server accepted it.
    // emptyEmployeeDraft() rather than a patch, so no field can be forgotten.
    setDraft(emptyEmployeeDraft());
    // The code create_employee returned is reported to the owner right here,
    // which is the one authoritative moment for it. It is NOT stored: the
    // reload below brings the roster's own value, and that is what the list
    // renders from now on.
    setCreateNotice(
      `${result.employee.displayName} was added with Employee ID ${result.employee.employeeCode}.`
    );

    await loadEmployees();
  }

  async function handleSubmitEditor() {
    if (openEditor === null || busyEmployeeId !== null) return;

    const { employeeId, kind } = openEditor;

    setRowProblem(null);
    setRowNotice(null);

    // The shape is checked before the round trip; the server checks it again
    // and remains the authority on both.
    if (kind === "code" && !isValidEmployeeCodeShape(editorValue)) {
      setRowProblem({ employeeId, message: EMPLOYEE_CODE_SHAPE_MESSAGE });
      return;
    }

    if (kind === "pin" && !isValidEmployeePinShape(editorValue)) {
      setRowProblem({ employeeId, message: EMPLOYEE_PIN_SHAPE_MESSAGE });
      return;
    }

    setBusyEmployeeId(employeeId);

    if (kind === "code") {
      const result = await setEmployeeCode(employeeId, editorValue);

      setBusyEmployeeId(null);

      if (!result.ok) {
        setRowProblem({ employeeId, message: SET_EMPLOYEE_CODE_MESSAGES[result.code] });
        return;
      }

      setRowNotice({
        employeeId,
        message: `Employee ID is now ${result.employeeCode}.`,
      });
      closeEditor();
      await loadEmployees();
      return;
    }

    const result = await setEmployeePin(employeeId, editorValue);

    setBusyEmployeeId(null);

    if (!result.ok) {
      setRowProblem({ employeeId, message: SET_EMPLOYEE_PIN_MESSAGES[result.code] });
      return;
    }

    // CLEARED IMMEDIATELY, and the confirmation repeats nothing about the PIN —
    // not the digits, not a mask, not its length. The server told us only that
    // it was set, and that is all an owner is told.
    closeEditor();
    setRowNotice({ employeeId, message: "PIN updated." });
  }

  async function handleRoleChange(employee: EmployeeSummary, role: EmployeeRole) {
    if (busyEmployeeId !== null || role === employee.role) return;

    setRowProblem(null);
    setRowNotice(null);
    setBusyEmployeeId(employee.employeeId);

    const result = await setEmployeeRole(employee.employeeId, role);

    setBusyEmployeeId(null);

    if (!result.ok) {
      setRowProblem({
        employeeId: employee.employeeId,
        message: SET_EMPLOYEE_ROLE_MESSAGES[result.code],
      });
      return;
    }

    // Reloaded rather than patched locally: the row must render what the server
    // stored, not what this screen asked for.
    await loadEmployees();
  }

  async function handleReactivate(employee: EmployeeSummary) {
    if (busyEmployeeId !== null) return;

    setRowProblem(null);
    setRowNotice(null);
    setBusyEmployeeId(employee.employeeId);

    const result = await setEmployeeActive(employee.employeeId, true);

    setBusyEmployeeId(null);

    if (!result.ok) {
      // employee_code_taken and employee_code_required both arrive here, and
      // each says what to fix. Nothing is renumbered on the owner's behalf.
      setRowProblem({
        employeeId: employee.employeeId,
        message: SET_EMPLOYEE_ACTIVE_MESSAGES[result.code],
      });
      return;
    }

    await loadEmployees();
  }

  async function handleConfirmDeactivate() {
    if (employeeToDeactivate === null || isDeactivating) return;

    setIsDeactivating(true);
    setDeactivateError(null);

    const result = await setEmployeeActive(employeeToDeactivate.employeeId, false);

    setIsDeactivating(false);

    if (!result.ok) {
      setDeactivateError(SET_EMPLOYEE_ACTIVE_MESSAGES[result.code]);
      return;
    }

    setEmployeeToDeactivate(null);
    await loadEmployees();
  }

  const roster = groupEmployeesByStatus(employees);

  function renderRow(employee: EmployeeSummary) {
    const isOpen = openEditor?.employeeId === employee.employeeId;

    return (
      <EmployeeRow
        key={employee.employeeId}
        employee={employee}
        employeeCodeLabel={describeEmployeeCode(employee.employeeCode)}
        openEditor={isOpen ? openEditor.kind : null}
        editorValue={isOpen ? editorValue : ""}
        onEditorValueChange={setEditorValue}
        onOpenEditor={(kind) => {
          setRowProblem(null);
          setRowNotice(null);
          // Always empty: an existing Employee ID is not readable and an
          // existing PIN does not exist to be read.
          setEditorValue("");
          setOpenEditor({ employeeId: employee.employeeId, kind });
        }}
        onCancelEditor={closeEditor}
        onSubmitEditor={() => void handleSubmitEditor()}
        onRoleChange={(role) => void handleRoleChange(employee, role)}
        onToggleActive={() => {
          setRowProblem(null);
          setRowNotice(null);

          if (employee.active) {
            setDeactivateError(null);
            setEmployeeToDeactivate(employee);
            return;
          }

          void handleReactivate(employee);
        }}
        isBusy={busyEmployeeId === employee.employeeId}
        errorMessage={
          rowProblem?.employeeId === employee.employeeId ? rowProblem.message : null
        }
        noticeMessage={
          rowNotice?.employeeId === employee.employeeId ? rowNotice.message : null
        }
      />
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-neutral-50 p-8">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <header>
          <h2 className="text-lg font-semibold tracking-tight text-neutral-900">
            Employees
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-neutral-500">
            Everyone who signs in at a till for this project. Roles apply at the
            till only — they grant no access to this builder.
          </p>
        </header>

        {projectId === null ? (
          <section className="rounded-xl border border-neutral-200 bg-white p-6">
            <h3 className="text-sm font-semibold text-neutral-900">
              Save this project first
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-neutral-500">
              Employees belong to a saved project. Save this one, then add the
              people who will use it.
            </p>
          </section>
        ) : (
          <>
            <AddEmployeeForm
              draft={draft}
              onDraftChange={(patch) => {
                setDraftProblem(null);
                setCreateError(null);
                setCreateNotice(null);
                setDraft((current) => ({ ...current, ...patch }));
              }}
              onSubmit={() => void handleCreate()}
              isSubmitting={isCreating}
              problem={draftProblem}
              errorMessage={createError}
              successMessage={createNotice}
            />

            {employeeToDeactivate !== null && (
              <DeactivateEmployeeDialog
                employee={employeeToDeactivate}
                onConfirm={() => void handleConfirmDeactivate()}
                onDismiss={() => {
                  setEmployeeToDeactivate(null);
                  setDeactivateError(null);
                }}
                isSubmitting={isDeactivating}
                errorMessage={deactivateError}
              />
            )}

            <section className="rounded-xl border border-neutral-200 bg-white">
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <h3 className="text-sm font-semibold text-neutral-900">
                  This project&rsquo;s employees
                </h3>
                <button
                  type="button"
                  onClick={() => {
                    setIsLoading(true);
                    void loadEmployees();
                  }}
                  className="rounded-lg border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
                >
                  Refresh
                </button>
              </div>

              {isLoading ? (
                <p className="border-t border-neutral-100 px-4 py-6 text-sm text-neutral-500">
                  Loading employees…
                </p>
              ) : listError !== null ? (
                <p
                  role="alert"
                  className="border-t border-neutral-100 px-4 py-6 text-sm text-red-700"
                >
                  {listError}
                </p>
              ) : employees.length === 0 ? (
                <p className="border-t border-neutral-100 px-4 py-6 text-sm text-neutral-500">
                  No employees yet. Add the first one above.
                </p>
              ) : (
                <>
                  <ul className="flex flex-col">{roster.active.map(renderRow)}</ul>

                  {roster.inactive.length > 0 && (
                    <>
                      <p className="border-t border-neutral-100 px-4 pt-4 text-xs font-medium uppercase tracking-wide text-neutral-500">
                        Inactive
                      </p>
                      <p className="px-4 pb-3 pt-1 text-sm leading-relaxed text-neutral-500">
                        {REACTIVATION_NOTICE}
                      </p>
                      <ul className="flex flex-col">{roster.inactive.map(renderRow)}</ul>
                    </>
                  )}
                </>
              )}
            </section>

            <section className="rounded-xl border border-neutral-200 bg-white p-6">
              <h3 className="text-sm font-semibold text-neutral-900">
                What this screen cannot change
              </h3>
              <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed text-neutral-500">
                <li>{EMPLOYEE_ADMIN_LIMITS.rename}</li>
              </ul>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
