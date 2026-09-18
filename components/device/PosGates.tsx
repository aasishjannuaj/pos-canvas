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
import type { RosterState } from "@/lib/employeeRoster";
import { isRosterConfirmedEmpty, rosterEmployees } from "@/lib/employeeRoster";
import { isValidEmployeeCodeShape, isValidEmployeePinShape } from "@/lib/employeeSession";
import type { RegisterSession } from "@/lib/registerSession";
import { getOpeningCashMessage, validateOpeningCash } from "@/lib/registerSession";

const PANEL = "mx-auto flex w-full max-w-sm flex-col gap-4 rounded-2xl bg-white p-6 shadow-sm";
const SCREEN = "flex min-h-0 flex-1 items-center justify-center bg-neutral-50 p-4";
const PRIMARY =
  "w-full rounded-xl bg-neutral-900 px-4 py-3 text-base font-medium text-white " +
  "disabled:cursor-not-allowed disabled:bg-neutral-300";
const SECONDARY = "w-full rounded-xl border border-neutral-300 px-4 py-3 text-base text-neutral-700";

/**
 * THE PRIMARY CASHIER LOGIN: unlock the till by typing who you are.
 *
 * It should feel like unlocking a till, not like browsing a staff directory.
 * One compact card over a dimmed POS, two numeric fields, one button — because
 * the cashier doing this has a queue in front of them and does it forty times a
 * day.
 *
 * WHY THIS REPLACED THE ROSTER AS THE NORMAL PATH. A list of everyone who works
 * here, shown on an unattended screen, is a staff directory anyone can read;
 * and picking a name is not a credential. Typing an Employee ID is.
 *
 * SHAPE CHECKS ONLY GREY OUT THE BUTTON. Every SUBMITTED attempt goes to the
 * server verbatim, because the per-device throttle is what makes a four-digit
 * PIN survivable and it can only count attempts it actually sees. The
 * length rules here just save a round trip on a half-typed entry.
 *
 * NOTHING HERE KNOWS WHETHER AN ID EXISTS. The server answers unknown-ID and
 * wrong-PIN identically, and this card shows whatever it says without trying to
 * be more specific.
 */
export function EmployeeLockCard({
  busy,
  error,
  recovery,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  /** Set when a refused sale sent the operator back here. */
  recovery: boolean;
  onSubmit: (employeeCode: string, pin: string) => void;
}) {
  const [employeeCode, setEmployeeCode] = useState("");
  const [pin, setPin] = useState("");

  const ready = isValidEmployeeCodeShape(employeeCode) && isValidEmployeePinShape(pin);

  return (
    <div className={SCREEN}>
      <form
        className={PANEL}
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && ready) onSubmit(employeeCode, pin);
        }}
      >
        <h1 className="text-lg font-semibold text-neutral-900">Employee Login</h1>

        {/* The sale was refused because the signed-in employee is not who this
            till thought. Somebody signs in again, deliberately: the till will
            not adopt whoever the server happens to report. */}
        {recovery && (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
            The signed-in employee changed. Sign in again to keep taking sales.
          </p>
        )}

        <label className="text-sm text-neutral-600" htmlFor="employee-code">
          Employee ID
        </label>
        <input
          id="employee-code"
          className="w-full rounded-xl border border-neutral-300 px-4 py-3 text-center text-2xl tracking-[0.4em]"
          type="text"
          // inputMode + pattern together are what raise a NUMERIC keypad on
          // Android rather than a full keyboard. type="number" would do it too
          // and would also bring spinners, allow `-` and `e`, and strip a
          // leading zero — which is the whole contract here.
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          maxLength={3}
          autoFocus
          placeholder="000"
          value={employeeCode}
          disabled={busy}
          onChange={(event) => setEmployeeCode(event.target.value.replace(/[^0-9]/g, ""))}
        />

        <label className="text-sm text-neutral-600" htmlFor="employee-pin">
          PIN
        </label>
        <input
          id="employee-pin"
          className="w-full rounded-xl border border-neutral-300 px-4 py-3 text-center text-2xl tracking-[0.5em]"
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          maxLength={4}
          placeholder="••••"
          value={pin}
          disabled={busy}
          onChange={(event) => setPin(event.target.value.replace(/[^0-9]/g, ""))}
        />

        {error !== null && <p className="text-sm text-red-600">{error}</p>}

        <button type="submit" className={PRIMARY} disabled={busy || !ready}>
          {busy ? "Signing in…" : "Sign In"}
        </button>
      </form>
    </div>
  );
}

/**
 * The roster, as the server offers it. Names and ids only — never PIN material.
 *
 * THE FOUR STATES ARE RENDERED AS FOUR STATES. This screen used to receive a
 * bare array, so "we have not asked yet", "the request failed" and "this
 * project has nobody" all arrived as `[]` and all rendered as the last one —
 * telling an operator on a perfectly good till to go add an employee. Only a
 * SUCCESSFUL, EMPTY response may say that now.
 */
export function EmployeeSelector({
  roster,
  busy,
  error,
  recovery,
  onSelect,
  onRetry,
}: {
  roster: RosterState;
  busy: boolean;
  error: string | null;
  /** Set when a refused sale sent the operator back here. */
  recovery: boolean;
  onSelect: (employee: LoginEmployee) => void;
  onRetry: () => void;
}) {
  const employees = rosterEmployees(roster);
  const loading = roster.status === "loading" || roster.status === "unloaded";

  return (
    <div className={SCREEN}>
      <div className={PANEL}>
        <h1 className="text-lg font-semibold text-neutral-900">Who is on the till?</h1>

        {/* The sale was refused because the signed-in employee is not who this
            till thought. Someone must sign in again, deliberately — the till
            will not adopt whoever the server reports. */}
        {recovery && (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
            The signed-in employee changed. Sign in again to keep taking sales.
          </p>
        )}

        {error !== null && <p className="text-sm text-red-600">{error}</p>}

        {roster.status === "failed" && <p className="text-sm text-red-600">{roster.message}</p>}

        {loading && <p className="text-sm text-neutral-600">Loading employees…</p>}

        {isRosterConfirmedEmpty(roster) && (
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

        <button
          type="button"
          className={SECONDARY}
          disabled={busy || roster.status === "loading"}
          onClick={onRetry}
        >
          {roster.status === "loading" ? "Loading…" : "Refresh"}
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
  recovery,
  onOpen,
  onAdoptCurrentRegister,
  onSwitchEmployee,
}: {
  employee: EmployeeSession;
  busy: boolean;
  error: string | null;
  /** Set when a refused sale sent the operator back here. */
  recovery: boolean;
  onOpen: (openingCash: number) => void;
  /** The explicit act that adopts the register the server currently reports. */
  onAdoptCurrentRegister: () => void;
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

        {/* v1.3 Feature 1B-RUNTIME correction — the register recovery surface.
            The sale was refused because the register this till was selling
            through is not the one the server holds. The till does NOT adopt the
            current register by itself; it says so, and offers a button. The
            press is the explicit act that re-establishes checkout. */}
        {recovery && (
          <>
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              The register changed on this till. Take the register that is open now, or open a
              new one.
            </p>
            <button
              type="button"
              className={SECONDARY}
              disabled={busy}
              onClick={onAdoptCurrentRegister}
            >
              {busy ? "Checking…" : "Use the register that is open"}
            </button>
          </>
        )}

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
