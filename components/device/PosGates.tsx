// v1.3 Feature 1B-RUNTIME — the device host's employee and register gates.
//
// FUNCTIONAL, SHARED, AND DELIBERATELY PLAIN. These render between "the pairing
// is ready" and "PosRuntime is mounted", so every till reaches the POS the same
// way on Android, Windows and the hosted route. Lane 2 owns template
// presentation; nothing here is template-aware, and no template may carry its
// own employee or register behaviour.
//
// NO BUSINESS DECISIONS LIVE HERE. Which gate to show comes from lib/posGate.ts,
// what an amount may be comes from lib/registerSession.ts, and every RPC lives
// in lib/employee.rpc.ts and lib/register.rpc.ts. These components render props
// and call callbacks.
"use client";

import { useState } from "react";
import type { EmployeeSession } from "@/lib/employeeSession";
import type { LoginEmployee } from "@/lib/employeeSession";
import { isValidEmployeePinShape } from "@/lib/employeeSession";
import type { RegisterSession } from "@/lib/registerSession";
import { getOpeningCashMessage, validateOpeningCash } from "@/lib/registerSession";

const PANEL = "mx-auto flex w-full max-w-sm flex-col gap-4 rounded-2xl bg-white p-6 shadow-sm";
const SCREEN = "flex min-h-0 flex-1 items-center justify-center bg-neutral-50 p-4";
const PRIMARY =
  "w-full rounded-xl bg-neutral-900 px-4 py-3 text-base font-medium text-white " +
  "disabled:cursor-not-allowed disabled:bg-neutral-300";
const SECONDARY = "w-full rounded-xl border border-neutral-300 px-4 py-3 text-base text-neutral-700";

/** The roster, as the server offers it. Names and ids only — never PIN material. */
export function EmployeeSelector({
  employees,
  busy,
  error,
  onSelect,
  onRetry,
}: {
  employees: readonly LoginEmployee[];
  busy: boolean;
  error: string | null;
  onSelect: (employee: LoginEmployee) => void;
  onRetry: () => void;
}) {
  return (
    <div className={SCREEN}>
      <div className={PANEL}>
        <h1 className="text-lg font-semibold text-neutral-900">Who is on the till?</h1>

        {error !== null && <p className="text-sm text-red-600">{error}</p>}

        {employees.length === 0 && !busy && error === null && (
          <p className="text-sm text-neutral-600">
            No one can sign in on this till yet. Add an employee from the dashboard.
          </p>
        )}

        <div className="flex flex-col gap-2">
          {employees.map((employee) => (
            <button
              key={employee.employeeId}
              type="button"
              className={SECONDARY}
              disabled={busy}
              onClick={() => onSelect(employee)}
            >
              {employee.displayName}
            </button>
          ))}
        </div>

        <button type="button" className={SECONDARY} disabled={busy} onClick={onRetry}>
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>
    </div>
  );
}

/**
 * The PIN keypad for ONE selected employee.
 *
 * The shape check only greys out Submit. Every SUBMITTED attempt goes to the
 * server verbatim — no trimming, no padding, no local refusal — because the
 * server's per-device throttle is what makes a 4-6 digit PIN survivable, and it
 * can only count attempts it actually sees.
 */
export function EmployeePinEntry({
  employee,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  employee: LoginEmployee;
  busy: boolean;
  error: string | null;
  onSubmit: (pin: string) => void;
  onCancel: () => void;
}) {
  const [pin, setPin] = useState("");

  return (
    <div className={SCREEN}>
      <form
        className={PANEL}
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) onSubmit(pin);
        }}
      >
        <h1 className="text-lg font-semibold text-neutral-900">{employee.displayName}</h1>
        <label className="text-sm text-neutral-600" htmlFor="employee-pin">
          Enter your PIN
        </label>
        <input
          id="employee-pin"
          className="w-full rounded-xl border border-neutral-300 px-4 py-3 text-center text-2xl tracking-[0.5em]"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          value={pin}
          disabled={busy}
          onChange={(event) => setPin(event.target.value)}
        />

        {error !== null && <p className="text-sm text-red-600">{error}</p>}

        <button type="submit" className={PRIMARY} disabled={busy || !isValidEmployeePinShape(pin)}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <button type="button" className={SECONDARY} disabled={busy} onClick={onCancel}>
          Back
        </button>
      </form>
    </div>
  );
}

/**
 * The register gate: an employee is signed in, but no register is open.
 *
 * The amount is validated here only so the cashier hears about a typo a moment
 * sooner. It is sent exactly as typed — never rounded — and the server's answer
 * is the one that decides.
 */
export function RegisterOpenPanel({
  employee,
  busy,
  error,
  onOpen,
  onSwitchEmployee,
}: {
  employee: EmployeeSession;
  busy: boolean;
  error: string | null;
  onOpen: (openingCash: number) => void;
  onSwitchEmployee: () => void;
}) {
  const [cash, setCash] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  return (
    <div className={SCREEN}>
      <form
        className={PANEL}
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;

          const validated = validateOpeningCash(cash);

          if (!validated.ok) {
            setLocalError(getOpeningCashMessage(validated.problem));
            return;
          }

          setLocalError(null);
          onOpen(validated.amount);
        }}
      >
        <h1 className="text-lg font-semibold text-neutral-900">Open the register</h1>
        <p className="text-sm text-neutral-600">Signed in: {employee.displayName}</p>

        <label className="text-sm text-neutral-600" htmlFor="opening-cash">
          Cash in the drawer
        </label>
        <input
          id="opening-cash"
          className="w-full rounded-xl border border-neutral-300 px-4 py-3 text-right text-2xl"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={cash}
          disabled={busy}
          onChange={(event) => {
            setCash(event.target.value);
            setLocalError(null);
          }}
        />

        {(localError ?? error) !== null && (
          <p className="text-sm text-red-600">{localError ?? error}</p>
        )}

        <button type="submit" className={PRIMARY} disabled={busy}>
          {busy ? "Opening…" : "Open register"}
        </button>
        <button type="button" className={SECONDARY} disabled={busy} onClick={onSwitchEmployee}>
          Switch employee
        </button>
      </form>
    </div>
  );
}

/**
 * Who is on the till and which register is open, plus the two actions that
 * change either. Rendered in the device host's own controls, never inside a
 * template.
 */
export function RegisterStatus({
  employee,
  register,
  busy,
  error,
  onSwitchEmployee,
  onLogout,
  onCloseRegister,
}: {
  employee: EmployeeSession;
  register: RegisterSession;
  busy: boolean;
  error: string | null;
  onSwitchEmployee: () => void;
  onLogout: () => void;
  onCloseRegister: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-white p-3 text-sm shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-neutral-700">
          <span className="font-medium text-neutral-900">{employee.displayName}</span>
          <span className="text-neutral-500"> · register open · {register.openingCash} to start</span>
        </span>

        <span className="flex gap-2">
          <button
            type="button"
            className="rounded-lg border border-neutral-300 px-3 py-1.5"
            disabled={busy}
            onClick={onSwitchEmployee}
          >
            Switch
          </button>
          <button
            type="button"
            className="rounded-lg border border-neutral-300 px-3 py-1.5"
            disabled={busy}
            onClick={onLogout}
          >
            Sign out
          </button>
          <button
            type="button"
            className="rounded-lg border border-neutral-300 px-3 py-1.5"
            disabled={busy}
            onClick={onCloseRegister}
          >
            Close register
          </button>
        </span>
      </div>

      {error !== null && <p className="text-red-600">{error}</p>}
    </div>
  );
}
