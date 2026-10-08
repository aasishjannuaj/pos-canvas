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

import { useEffect, useRef, useState } from "react";
import type { EmployeeSession } from "@/lib/employeeSession";
import type { LoginEmployee } from "@/lib/employeeSession";
import type { RosterState } from "@/lib/employeeRoster";
import { isRosterConfirmedEmpty, rosterEmployees } from "@/lib/employeeRoster";
import { isValidEmployeeCodeShape, isValidEmployeePinShape } from "@/lib/employeeSession";
import type { RegisterSession } from "@/lib/registerSession";
import type { DailyRegisterContext } from "@/lib/dailyRegister";
import { getOpeningCashMessage, validateOpeningCash } from "@/lib/registerSession";
import { isValidTimeClockCode, isValidTimeClockPin } from "@/lib/timeClock";
import type { TimeClockAction, TimeClockResult } from "@/lib/timeClock";
import {
  CASH_MOVEMENT_TYPES,
  getCashAmountMessage,
  getCashMovementLabel,
  getCashMovementMessage,
  getCashNoteMessage,
  isCashMovementNoteRequired,
  validateCashAmount,
  validateCashNote,
} from "@/lib/cashMovement";
import type { CashMovementResult, CashMovementType } from "@/lib/cashMovement";
import { businessInstantInTimezone } from "@/lib/salesReporting";
import { createLogoPublicUrl } from "@/lib/logoUpload";
import type { BrandingSettings, BusinessProfile } from "@/lib/projectConfig";

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
 *
 * v1.3 RC-polish — WHOSE TILL THIS IS. The card now opens with the merchant's
 * own identity, so a cashier walking up knows they are signing in to this shop's
 * register and not a generic utility. The branding is the PAIRED DEVICE'S
 * PINNED CONFIG, handed in by the host exactly as PosHeader receives it: no
 * fetch, no owner query, no live subscription. The logo src is built only by
 * createLogoPublicUrl — the same validated composer the header uses — so a
 * malformed stored path can never become an image source here either.
 *
 * Identity is shop-level only. Nothing here names, lists or hints at an
 * employee.
 */
export function EmployeeLockCard({
  businessProfile,
  branding,
  logoBaseUrl,
  busy,
  error,
  recovery,
  onSubmit,
  onTimeClock,
  onCashMovement,
}: {
  /** From the pinned config. The name is always shown, logo or not. */
  businessProfile: BusinessProfile;
  /** From the pinned config. Its logo path is validated before use. */
  branding: BrandingSettings;
  /** The logo origin, injected exactly as PosHeader's is. undefined = no logo. */
  logoBaseUrl: string | undefined;
  busy: boolean;
  error: string | null;
  /** Set when a refused sale sent the operator back here. */
  recovery: boolean;
  onSubmit: (employeeCode: string, pin: string) => void;
  /** Opens the Time Clock. Never unlocks the POS. */
  onTimeClock?: () => void;
  onCashMovement?: () => void;
}) {
  const [employeeCode, setEmployeeCode] = useState("");
  const [pin, setPin] = useState("");

  // A logo that fails to load must never blank the identity block or the
  // login. This flips on error and the business name carries it alone — the
  // same outcome a project without a logo already has.
  const [logoFailed, setLogoFailed] = useState(false);

  const ready = isValidEmployeeCodeShape(employeeCode) && isValidEmployeePinShape(pin);

  const businessName = businessProfile.businessName.trim();

  // Null unless the pinned path passes the strict validator AND the host
  // supplied a usable origin.
  const logoUrl = branding.logo
    ? createLogoPublicUrl(branding.logo.path, logoBaseUrl)
    : null;

  const showLogo = branding.logo !== undefined && logoUrl !== null && !logoFailed;

  return (
    <div className={SCREEN}>
      <form
        className="mx-auto flex w-full max-w-sm flex-col overflow-hidden rounded-2xl bg-white shadow-lg ring-1 ring-neutral-200"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && ready) onSubmit(employeeCode, pin);
        }}
      >
        {/* The merchant's colour, as a thin band. Decorative only: the
            controls below keep their fixed, high-contrast colours whatever
            accent an owner picked. */}
        <div aria-hidden="true" className="h-1.5 w-full" style={{ backgroundColor: branding.accentColor }} />

        {/* Merchant identity. The name is rendered unconditionally, OUTSIDE
            the logo branch: it is not replaced by the logo, and an absent,
            invalid or broken logo leaves it exactly where it was. */}
        <div className="flex flex-col items-center gap-3 border-b border-neutral-100 px-6 pb-5 pt-6 text-center">
          {showLogo && branding.logo && (
            // A plain <img> for the same reasons as PosHeader's. Max-only
            // sizing with object-contain: a wide banner and a tall mark are
            // each contained whole inside the bounded box, never stretched or
            // cropped. alt is empty because the name beside it already says
            // the same thing to a screen reader.
            // eslint-disable-next-line @next/next/no-img-element -- see PosHeader
            <img
              src={logoUrl}
              alt=""
              width={branding.logo.width}
              height={branding.logo.height}
              onError={() => setLogoFailed(true)}
              className="h-auto max-h-20 w-auto max-w-[240px] flex-none object-contain"
            />
          )}

          <p className="w-full break-words text-xl font-semibold tracking-tight text-neutral-900">
            {businessName}
          </p>
        </div>

        <div className="flex flex-col gap-4 p-6">
          <h1 className="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-500">
            Employee Login
          </h1>

          {/* The sale was refused because the signed-in employee is not who this
              till thought. Somebody signs in again, deliberately: the till will
              not adopt whoever the server happens to report. */}
          {recovery && (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              The signed-in employee changed. Sign in again to keep taking sales.
            </p>
          )}

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-neutral-700" htmlFor="employee-code">
              Employee ID
            </label>
            <input
              id="employee-code"
              className="w-full rounded-xl border border-neutral-300 bg-neutral-50 px-4 py-3 text-center text-2xl tabular-nums tracking-[0.4em] focus:border-neutral-500 focus:bg-white focus:outline-none"
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
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-neutral-700" htmlFor="employee-pin">
              PIN
            </label>
            <input
              id="employee-pin"
              className="w-full rounded-xl border border-neutral-300 bg-neutral-50 px-4 py-3 text-center text-2xl tracking-[0.5em] focus:border-neutral-500 focus:bg-white focus:outline-none"
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
          </div>

          {error !== null && (
            <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
              {error}
            </p>
          )}

          <button type="submit" className={PRIMARY} disabled={busy || !ready}>
            {busy ? "Signing in…" : "Sign In"}
          </button>

          {/* v1.3 Feature 1C — a SECOND, smaller door.
              Somebody arriving for their shift has to be able to clock in before
              anyone has signed the till in, and on a till they are not about to
              operate. It sits under the login rather than beside it because it is
              the rarer act, and pressing it never unlocks the POS.

              v1.3 Feature 1D -- a THIRD door, and the same reasoning: a till may
              need cash dropped to the safe before anybody has signed it in, and
              the employee who authorizes that is not necessarily about to
              operate it. Pressing this never unlocks the POS.

              RC-polish groups the two side doors below a divider so they read
              as secondary to Sign In; their callbacks are untouched. */}
          {(onTimeClock !== undefined || onCashMovement !== undefined) && (
            <div className="flex flex-col gap-2 border-t border-neutral-100 pt-4">
              {onTimeClock !== undefined && (
                <button
                  type="button"
                  className={SECONDARY}
                  disabled={busy}
                  onClick={onTimeClock}
                >
                  Time Clock
                </button>
              )}

              {onCashMovement !== undefined && (
                <button
                  type="button"
                  className={SECONDARY}
                  disabled={busy}
                  onClick={onCashMovement}
                >
                  Cash Movement
                </button>
              )}
            </div>
          )}
        </div>
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
            Ring Out
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

// ---------------------------------------------------------------------------
// v1.3 CP2d — the two EXCEPTIONS that replaced register management
// ---------------------------------------------------------------------------

/**
 * The business has not told the server what timezone it keeps.
 *
 * DELIBERATELY NOT A PICKER. Offering the cashier a timezone here would let a
 * till decide which day this shop's money lands on, which is the one thing the
 * whole daily model exists to prevent — and the device's own zone is the least
 * trustworthy answer available, because it follows whoever carried the tablet.
 * Somebody with authority sets it once, in the owner's settings; this screen
 * says so and offers to ask again.
 */
export function BusinessTimezoneRequiredCard({
  busy,
  error,
  onRetry,
}: {
  busy: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <div className={SCREEN}>
      <div className={PANEL}>
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-neutral-900">Setup needed</h2>
          <p className="text-sm text-neutral-600">
            This business needs a timezone before sales can be rung up. An owner can set it in the
            business settings.
          </p>
        </div>

        <p className="text-sm text-neutral-500">
          Sales already waiting to sync are safe and will be sent once this is sorted.
        </p>

        {error !== null && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        <button
          type="button"
          className="rounded-xl bg-neutral-900 px-4 py-3 text-white disabled:opacity-50"
          disabled={busy}
          onClick={onRetry}
        >
          {busy ? "Checking…" : "Try again"}
        </button>
      </div>
    </div>
  );
}

/**
 * The server would not establish today's business day.
 *
 * THIS IS NOT REGISTER MANAGEMENT AND MUST NOT LOOK LIKE IT. An ordinary
 * midnight never reaches this screen: complete_sale_v5 rolls a sale forward to
 * the current day by itself, so a cashier crossing midnight notices nothing.
 * Reaching here means the day genuinely could not be established — a timezone
 * changed underneath an existing day, or the server was unreachable — and the
 * only honest action is to ask again. No opening cash, no register to pick, and
 * nothing this screen can invent locally.
 */
export function DailyContextRecoveryCard({
  employee,
  busy,
  error,
  recovery,
  onRetry,
  onSwitchEmployee,
}: {
  employee: EmployeeSession;
  busy: boolean;
  error: string | null;
  recovery: boolean;
  onRetry: () => void;
  onSwitchEmployee: () => void;
}) {
  return (
    <div className={SCREEN}>
      <div className={PANEL}>
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-neutral-900">
            {recovery ? "Today's register needs checking" : "Getting today's register"}
          </h2>
          <p className="text-sm text-neutral-600">
            {recovery
              ? "The server could not confirm which business day this till is on. Nothing has been lost — try again, and check the connection if it keeps happening."
              : "Setting this till up for today."}
          </p>
        </div>

        <p className="text-sm text-neutral-500">
          Signed in as <span className="font-medium text-neutral-800">{employee.displayName}</span>
        </p>

        {error !== null && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        <button
          type="button"
          className="rounded-xl bg-neutral-900 px-4 py-3 text-white disabled:opacity-50"
          disabled={busy}
          onClick={onRetry}
        >
          {busy ? "Checking…" : "Try again"}
        </button>

        <button
          type="button"
          className="rounded-xl border border-neutral-300 px-4 py-3 disabled:opacity-50"
          disabled={busy}
          onClick={onSwitchEmployee}
        >
          Switch employee
        </button>
      </div>
    </div>
  );
}

/**
 * Who is on the till, and which business day it is.
 *
 * NO CLOSE BUTTON, deliberately. A business day is not a drawer period: nobody
 * opens one and nobody closes one, and offering a cashier a button that ends
 * the day would be offering them a way to misfile the evening's sales. Signing
 * out leaves the day exactly where it is.
 */
export function DailyRegisterStatus({
  employee,
  daily,
  busy,
  error,
  onSwitchEmployee,
  onLogout,
  onTimeClock,
  onCashMovement,
}: {
  employee: EmployeeSession;
  daily: DailyRegisterContext;
  busy: boolean;
  error: string | null;
  onSwitchEmployee: () => void;
  onLogout: () => void;
  /**
   * v1.3 Feature 1C — a colleague's shift, while this operator keeps the till.
   *
   * Employee B must be able to clock in or out without Employee A being rung
   * out, switched, or losing the cart they are part way through.
   */
  onTimeClock?: () => void;
  /**
   * v1.3 Feature 1D — a movement authorized over this operator's shoulder.
   *
   * A manager may record a paid-out on this till without Employee A being rung
   * out, switched, or losing the cart they are part way through.
   */
  onCashMovement?: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-white p-3 text-sm shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-neutral-700">
          <span className="font-medium text-neutral-900">{employee.displayName}</span>
          {/* The SERVER's business date, shown exactly as it answered. Nothing
              here formats, parses or recomputes it from a device clock. */}
          {daily.businessDate !== "" && (
            <span className="text-neutral-500"> · {daily.businessDate}</span>
          )}
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
            Ring Out
          </button>
          {onTimeClock !== undefined && (
            <button
              type="button"
              className="rounded-lg border border-neutral-300 px-3 py-1.5"
              disabled={busy}
              onClick={onTimeClock}
            >
              Time Clock
            </button>
          )}
          {onCashMovement !== undefined && (
            <button
              type="button"
              className="rounded-lg border border-neutral-300 px-3 py-1.5"
              disabled={busy}
              onClick={onCashMovement}
            >
              Cash Movement
            </button>
          )}
        </span>
      </div>

      {error !== null && <p className="text-red-600">{error}</p>}
    </div>
  );
}

/**
 * v1.3 Feature 1C — the Time Clock panel.
 *
 * EXPLICIT INTENT, NOT A TOGGLE. The employee says whether they are arriving or
 * leaving before they authenticate. A single button that let the server decide
 * would, for anyone who forgot to clock out yesterday, perform the opposite of
 * what they came to do — and a punch nobody meant is exactly the record a
 * timesheet cannot afford. A wrong choice here is refused and says so.
 *
 * IT OPENS NOTHING. Using this panel never signs anybody into the POS, never
 * rings the current operator out, never touches the cart. It sits over
 * whatever was on screen and goes away again.
 */
export function TimeClockPanel({
  busy,
  result,
  onSubmit,
  onDismiss,
}: {
  busy: boolean;
  /** The server's answer, success or refusal. Nothing is computed locally. */
  result: TimeClockResult | null;
  onSubmit: (action: TimeClockAction, employeeCode: string, pin: string) => void;
  onDismiss: () => void;
}) {
  const [action, setAction] = useState<TimeClockAction | null>(null);
  const [employeeCode, setEmployeeCode] = useState("");
  const [pin, setPin] = useState("");

  const ready = isValidTimeClockCode(employeeCode) && isValidTimeClockPin(pin);

  if (result !== null && result.ok) {
    return (
      <div className={SCREEN}>
        <div className={PANEL}>
          <h1 className="text-lg font-semibold text-neutral-900">
            {result.outcome === "clocked_in" ? "Clocked in" : "Clocked out"}
          </h1>
          {/* The SERVER's instant, shown as it answered. Nothing here reads a
              device clock, so what an employee is told matches what payroll
              will see. */}
          <p className="text-sm text-neutral-600">
            {result.outcome === "clocked_in" ? result.clockedInAt : result.clockedOutAt}
          </p>
          <button type="button" className={PRIMARY} onClick={onDismiss}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={SCREEN}>
      <form
        className={PANEL}
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && ready && action !== null) onSubmit(action, employeeCode, pin);
        }}
      >
        <h1 className="text-lg font-semibold text-neutral-900">Time Clock</h1>

        <span className="flex gap-2">
          <button
            type="button"
            className={`flex-1 rounded-xl border px-4 py-3 text-base ${
              action === "clock_in"
                ? "border-blue-600 bg-blue-600 text-white"
                : "border-neutral-300 text-neutral-700"
            }`}
            disabled={busy}
            onClick={() => setAction("clock_in")}
          >
            Clock In
          </button>
          <button
            type="button"
            className={`flex-1 rounded-xl border px-4 py-3 text-base ${
              action === "clock_out"
                ? "border-blue-600 bg-blue-600 text-white"
                : "border-neutral-300 text-neutral-700"
            }`}
            disabled={busy}
            onClick={() => setAction("clock_out")}
          >
            Clock Out
          </button>
        </span>

        <label className="text-sm text-neutral-700" htmlFor="time-clock-code">
          Employee ID
        </label>
        <input
          id="time-clock-code"
          className="rounded-xl border border-neutral-300 px-4 py-3 text-base"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          maxLength={3}
          placeholder="000"
          value={employeeCode}
          disabled={busy}
          onChange={(event) => setEmployeeCode(event.target.value.replace(/[^0-9]/g, ""))}
        />

        <label className="text-sm text-neutral-700" htmlFor="time-clock-pin">
          PIN
        </label>
        <input
          id="time-clock-pin"
          className="rounded-xl border border-neutral-300 px-4 py-3 text-base"
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

        {/* The server's wording, verbatim -- including the one generic answer
            that covers an unknown ID, a wrong PIN and a deactivated employee,
            so this panel cannot be used to find out who works here. */}
        {result !== null && !result.ok && (
          <p className="text-sm text-red-600">{result.message}</p>
        )}

        <button type="submit" className={PRIMARY} disabled={busy || !ready || action === null}>
          {busy ? "Sending…" : "Confirm"}
        </button>

        <button type="button" className={SECONDARY} disabled={busy} onClick={onDismiss}>
          Cancel
        </button>
      </form>
    </div>
  );
}

/**
 * v1.3 Feature 1D — the Cash Movement panel.
 *
 * FOUR DELIBERATE STEPS. Choose the kind, authenticate, enter the money, then
 * REVIEW before anything is sent. The review screen exists because these records
 * are permanent and this checkpoint builds no correction path: the cost of a
 * mistyped amount is forever, and the cost of one more tap is nothing. Reaching
 * the review screen sends nothing -- only the final Confirm does.
 *
 * IT SHOWS WHAT HAPPENED, NOT WHAT THE DRAWER HOLDS. No expected cash, no
 * resulting balance, no "the drawer should contain". Feature 1D records source
 * events, and a till that displayed drawer arithmetic would be doing it against a
 * starting figure nobody ever counted.
 *
 * IT OPENS NOTHING. Using this panel signs nobody into the POS, rings the current
 * operator out, or touches the cart. A manager may authorize a paid-out over a
 * cashier's shoulder and hand the till straight back.
 */
export function CashMovementPanel({
  busy,
  result,
  noDailyContext,
  businessName,
  currencySymbol,
  businessTimezone,
  onSubmit,
  onDismiss,
}: {
  busy: boolean;
  /** The server's answer, success or refusal. Nothing is computed locally. */
  result: CashMovementResult | null;
  /**
   * This till has no authoritative business day yet, so there is nothing for a
   * movement to belong to -- and a movement may not start one. Refused here, and
   * refused again by the server.
   */
  noDailyContext: boolean;
  /**
   * v1.3 Cash Drop slip polish — the three values a printed slip needs and this
   * panel previously had no way to see. All three are read-only presentation,
   * supplied by the host from configuration it already holds.
   */
  businessName: string;
  currencySymbol: string;
  /**
   * The DAILY's business timezone snapshot, or null when there is no business
   * day. NEVER the device's zone: see the slip's date/time below.
   */
  businessTimezone: string | null;
  onSubmit: (
    type: CashMovementType,
    employeeCode: string,
    pin: string,
    amount: string,
    note: string | null
  ) => void;
  onDismiss: () => void;
}) {
  const [type, setType] = useState<CashMovementType | null>(null);
  const [employeeCode, setEmployeeCode] = useState("");
  const [pin, setPin] = useState("");
  const [amountText, setAmountText] = useState("");
  const [noteText, setNoteText] = useState("");
  const [reviewing, setReviewing] = useState(false);

  // v1.3 RC-polish — which movement has already been sent to the printer.
  //
  // A REF AND NOT STATE, because printing must not re-render anything, and
  // because this exists purely to make the effect below idempotent. React may
  // render this panel many times holding the same `result`; the drop must reach
  // the printer once per MOVEMENT, not once per render.
  const printedMovementIdRef = useRef<string | null>(null);

  // v1.3 RC-polish — the two Cash Drop slips.
  //
  // DOWNSTREAM OF AUTHORITY, AND NOTHING ELSE. This runs only because `result`
  // already arrived: the movement is recorded, the server rendered the amount
  // and the instant, and the ledger is settled whatever happens next. It takes
  // no decision, writes nothing, and returns nothing.
  //
  // CASH DROP ONLY. Paid In and Paid Out produce no slip, and the condition is
  // here at the call site rather than inside a shared receipt component on
  // purpose — a slip parameterised by movement type would quietly start
  // printing for all three the moment somebody reused it.
  //
  // FIRE AND FORGET. window.print() is not awaited and its outcome is never
  // inspected, matching the rule the receipt print paths already follow. A
  // printer that is out of paper, offline or cancelled leaves an authoritative
  // cash movement that simply has no slip — which is a paper problem, not a
  // money problem. Nothing here can reverse the movement, retry the request,
  // mint another request id or write a second record: none of those things is
  // reachable from this component.
  useEffect(() => {
    if (result === null || !result.ok || result.movementType !== "cash_drop") {
      return;
    }

    if (printedMovementIdRef.current === result.movementId) {
      return;
    }

    printedMovementIdRef.current = result.movementId;

    window.print();
  }, [result]);

  // THE SERVER'S ANSWER, SHOWN AS IT CAME. The amount and the instant are the
  // ones that were stored, so what the employee reads matches the record.
  if (result !== null && result.ok) {
    return (
      <div className={SCREEN}>
        <div className={PANEL}>
          <h1 className="text-lg font-semibold text-neutral-900">
            {getCashMovementLabel(result.movementType)} recorded
          </h1>
          <p className="text-2xl font-semibold text-neutral-900">{result.amount}</p>
          {result.note !== null && <p className="text-sm text-neutral-600">{result.note}</p>}
          <p className="text-sm text-neutral-600">{result.employeeName}</p>
          <p className="text-sm text-neutral-600">{result.occurredAt}</p>
          <button type="button" className={PRIMARY} onClick={onDismiss}>
            Done
          </button>
        </div>

        {/* v1.3 RC-polish — the printed Cash Drop record: TWO slips, one print
            job. Copy 1 travels with the dropped cash, copy 2 stays for the
            store. Two slips in one job, NOT a driver copy count: the web
            platform has no way to ask for N copies, so asking for two pages is
            the only way to get two slips deterministically.

            `receipt-print-area` is reused so the existing off-screen-on-screen
            and reveal-in-print rules apply unchanged.
            data-print-exclusive="cash-movement" is a STRONGER claim than the
            valueless marker Sales history uses: this panel is a full-viewport
            overlay that can sit above a still-mounted PosRuntime, so while it
            is showing nothing else may print — see app/globals.css. Without
            that, a cashier with a receipt still open would be handed the sale
            and the drop superimposed at the same origin.

            Only fields the server already returned appear here. No PIN, no
            credential, no hash, no expected cash, no drawer arithmetic. */}
        {result.movementType === "cash_drop" && (
          <div
            className="receipt-print-area cash-drop-print-area"
            data-print-exclusive="cash-movement"
          >
            {[
              { label: "Copy 1 — with the cash", footer: "Send this copy with the cash." },
              { label: "Copy 2 — store record", footer: "Keep this copy for the store record." },
            ].map((copy) => (
              <section className="cash-drop-slip" key={copy.label}>
                {/* The shop, from the same pinned configuration the till sells
                    from, so this slip and a sale receipt beside it can never
                    name the business differently. */}
                <p className="cash-drop-slip-shop">{businessName}</p>

                <h2 className="cash-drop-slip-title">
                  {getCashMovementLabel(result.movementType)}
                </h2>

                <p className="cash-drop-slip-copy">{copy.label}</p>

                {/* The SERVER's amount, unchanged, with the project's currency
                    symbol in front of it: a slip that travels with money has to
                    say which money. */}
                <p className="cash-drop-slip-amount">
                  {currencySymbol}
                  {result.amount}
                </p>

                <dl className="cash-drop-slip-rows">
                  <div className="cash-drop-slip-row">
                    <dt>Employee</dt>
                    <dd>{result.employeeName}</dd>
                  </div>

                  <div className="cash-drop-slip-row">
                    <dt>Date / time</dt>
                    {/* THE BUSINESS ZONE, OR THE RAW INSTANT — never the
                        device's. businessInstantInTimezone returns null rather
                        than guessing when the zone is unusable, and the honest
                        fallback is the server's own instant verbatim: still
                        authoritative, simply unconverted. Nothing here calls
                        toLocaleString. */}
                    <dd>
                      {businessInstantInTimezone(result.occurredAt, businessTimezone) ??
                        result.occurredAt}
                    </dd>
                  </div>

                  {result.note !== null && (
                    <div className="cash-drop-slip-row">
                      <dt>Reason</dt>
                      <dd>{result.note}</dd>
                    </div>
                  )}

                  {/* FULL id, never truncated — it is how this slip is matched
                      to the ledger. The reference class lets it break anywhere
                      so a UUID cannot run off a 72 mm roll. */}
                  <div className="cash-drop-slip-row">
                    <dt>Reference</dt>
                    <dd className="cash-drop-slip-reference">{result.movementId}</dd>
                  </div>
                </dl>

                {/* A ruled line, not a run of underscores: underscores are a
                    fixed width and overflow the real printable width. */}
                <p className="cash-drop-slip-signature-label">Employee signature</p>
                <p className="cash-drop-slip-signature-rule" aria-hidden="true" />

                <p className="cash-drop-slip-footer">{copy.footer}</p>
              </section>
            ))}
          </div>
        )}
      </div>
    );
  }

  // No business day on this till yet. The only useful thing to say is how to get
  // one, and it is not through this panel.
  if (noDailyContext) {
    return (
      <div className={SCREEN}>
        <div className={PANEL}>
          <h1 className="text-lg font-semibold text-neutral-900">Cash Movement</h1>
          <p className="text-sm text-red-600">{getCashMovementMessage("no_daily_context")}</p>
          <button type="button" className={SECONDARY} onClick={onDismiss}>
            Close
          </button>
        </div>
      </div>
    );
  }

  if (type === null) {
    return (
      <div className={SCREEN}>
        <div className={PANEL}>
          <h1 className="text-lg font-semibold text-neutral-900">Cash Movement</h1>
          {CASH_MOVEMENT_TYPES.map((option) => (
            <button
              key={option}
              type="button"
              className={SECONDARY}
              disabled={busy}
              onClick={() => setType(option)}
            >
              {getCashMovementLabel(option)}
            </button>
          ))}
          <button type="button" className={SECONDARY} disabled={busy} onClick={onDismiss}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const amount = validateCashAmount(amountText);
  const note = validateCashNote(noteText, type);
  const ready =
    isValidEmployeeCodeShape(employeeCode) &&
    isValidEmployeePinShape(pin) &&
    amount.ok &&
    note.ok;

  // THE REVIEW STEP. Nothing has been sent to reach this screen, and nothing is
  // sent until Confirm.
  if (reviewing && amount.ok && note.ok) {
    return (
      <div className={SCREEN}>
        <div className={PANEL}>
          <h1 className="text-lg font-semibold text-neutral-900">Confirm</h1>
          <p className="text-sm text-neutral-600">{getCashMovementLabel(type)}</p>
          {/* The exact amount, rendered by the same money formatter the rest of
              the POS uses -- not the raw keystrokes. */}
          <p className="text-2xl font-semibold text-neutral-900">{amount.canonical}</p>
          {note.note !== null && <p className="text-sm text-neutral-600">{note.note}</p>}

          {result !== null && !result.ok && (
            <p className="text-sm text-red-600">{result.message}</p>
          )}

          <button
            type="button"
            className={PRIMARY}
            disabled={busy}
            onClick={() => onSubmit(type, employeeCode, pin, amount.canonical, note.note)}
          >
            {busy ? "Recording…" : "Confirm"}
          </button>
          <button
            type="button"
            className={SECONDARY}
            disabled={busy}
            onClick={() => setReviewing(false)}
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={SCREEN}>
      <form
        className={PANEL}
        onSubmit={(event) => {
          event.preventDefault();
          // TO THE REVIEW SCREEN, NOT TO THE SERVER.
          if (!busy && ready) setReviewing(true);
        }}
      >
        <h1 className="text-lg font-semibold text-neutral-900">
          {getCashMovementLabel(type)}
        </h1>

        <label className="text-sm text-neutral-700" htmlFor="cash-movement-code">
          Employee ID
        </label>
        <input
          id="cash-movement-code"
          className="rounded-xl border border-neutral-300 px-4 py-3 text-base"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          maxLength={3}
          placeholder="000"
          value={employeeCode}
          disabled={busy}
          onChange={(event) => setEmployeeCode(event.target.value.replace(/[^0-9]/g, ""))}
        />

        <label className="text-sm text-neutral-700" htmlFor="cash-movement-pin">
          PIN
        </label>
        <input
          id="cash-movement-pin"
          className="rounded-xl border border-neutral-300 px-4 py-3 text-base"
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

        <label className="text-sm text-neutral-700" htmlFor="cash-movement-amount">
          Amount
        </label>
        {/* TEXT, NOT number. The typed digits are what decide the precision, and
            a number input would hand this a float. inputMode gets the numeric
            keypad on a till without changing what the value is. */}
        <input
          id="cash-movement-amount"
          className="rounded-xl border border-neutral-300 px-4 py-3 text-base"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={amountText}
          disabled={busy}
          onChange={(event) => setAmountText(event.target.value)}
        />
        {amountText.trim() !== "" && !amount.ok && (
          <p className="text-sm text-red-600">{getCashAmountMessage(amount.problem)}</p>
        )}

        <label className="text-sm text-neutral-700" htmlFor="cash-movement-note">
          {isCashMovementNoteRequired(type) ? "Reason" : "Reason (optional)"}
        </label>
        {/* NO maxLength. Truncating as somebody types hides that their reason was
            too long; the rule is stated, and an over-length note is refused with
            a message rather than silently shortened. */}
        <textarea
          id="cash-movement-note"
          className="rounded-xl border border-neutral-300 px-4 py-3 text-base"
          rows={2}
          autoComplete="off"
          value={noteText}
          disabled={busy}
          onChange={(event) => setNoteText(event.target.value)}
        />
        {!note.ok && noteText.trim() !== "" && (
          <p className="text-sm text-red-600">{getCashNoteMessage(note.problem)}</p>
        )}

        {/* The server's wording, verbatim -- including the one generic answer
            covering an unknown ID, a wrong PIN and a deactivated employee. */}
        {result !== null && !result.ok && (
          <p className="text-sm text-red-600">{result.message}</p>
        )}

        <button type="submit" className={PRIMARY} disabled={busy || !ready}>
          Review
        </button>

        <button type="button" className={SECONDARY} disabled={busy} onClick={onDismiss}>
          Cancel
        </button>
      </form>
    </div>
  );
}
