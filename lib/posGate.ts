// v1.3 Feature 1B-RUNTIME — which gate the till is standing at, and why.
//
// PURE. No Supabase, no React, no storage, no clock. DeviceApp holds this state
// and calls these functions; every transition here is a value in, a value out,
// so the whole runtime contract is testable without mounting anything.
//
// THE TWO THINGS THIS MODULE EXISTS TO PREVENT:
//
//   1. A till selling under an employee or a register the operator did not
//      believe was active. The server refuses that (complete_sale_v5 compares
//      the expectations it is sent against its own locked rows), and this module
//      makes the client's reaction to that refusal deterministic: clear what
//      the server disagreed about, re-derive it, and make a person re-establish
//      it. Never resubmit under whatever is current now.
//
//   2. A till inventing authority it does not have. Employee and register state
//      is established from the SERVER and held IN MEMORY ONLY. Nothing here is
//      persisted, so a cold start — online or offline — begins with no employee
//      and no register, and an offline cold start therefore cannot check out at
//      all. That is Policy 1, and it is enforced by `canCheckoutOffline` rather
//      than by whatever the last screen happened to show.
import type { EmployeeSession } from "@/lib/employeeSession";
import type { RegisterSession } from "@/lib/registerSession";

/** Which screen the device host owes the operator. */
export type PosGate = "employee" | "register" | "pos";

export type PosGateState = {
  /** The employee POS session, as the server last reported it. */
  employee: EmployeeSession | null;
  /** The OPEN register session, as the server last reported it. */
  register: RegisterSession | null;
  /**
   * True once both have been derived from the server in THIS app run.
   *
   * Not "we have values" — values can be left over from a state the server has
   * since changed. This is the flag Policy 1 turns on: it is set by a
   * successful server derivation and cleared whenever the runtime stops
   * trusting what it holds.
   */
  establishedOnline: boolean;
};

export const EMPTY_POS_GATE_STATE: PosGateState = {
  employee: null,
  register: null,
  establishedOnline: false,
};

/**
 * The gate to render.
 *
 * ORDER IS THE CONTRACT: employee first, then register. A register cannot be
 * opened without a signed-in employee — the server refuses it with
 * employee_session_required — so offering the register gate first would be
 * offering a dead end.
 */
export function resolvePosGate(state: PosGateState): PosGate {
  if (state.employee === null) return "employee";
  if (state.register === null) return "register";

  return "pos";
}

export type OfflineCheckoutGate =
  | { ok: true }
  | { ok: false; reason: "not_established"; message: string };

const NOT_ESTABLISHED =
  "Reconnect to sign in an employee and open the register before taking sales.";

/**
 * Whether a NEW offline checkout may be taken (Policy 1).
 *
 * BOTH must be established, and they must have been established from the server
 * during this app run. A till that started offline holds nothing, so it sells
 * nothing; a till that was already selling keeps its in-memory state when the
 * connection drops and carries on.
 *
 * THIS DOES NOT DECIDE WHETHER AN ALREADY-QUEUED SALE MAY SYNC. A paid sale on
 * disk is money that changed hands, and it stays syncable whatever this returns
 * — the server decides, per claim, whether its historical attribution can be
 * proven, and stores NULL when it cannot.
 */
export function canCheckoutOffline(state: PosGateState): OfflineCheckoutGate {
  if (!state.establishedOnline || state.employee === null || state.register === null) {
    return { ok: false, reason: "not_established", message: NOT_ESTABLISHED };
  }

  return { ok: true };
}

/**
 * The claims a queued offline sale carries.
 *
 * CLAIMS, NOT AUTHORITY. The server validates each one against its own history
 * — the session must belong to this device, the employee to this project, and
 * occurred_at must fall inside the interval — and stores NULL for whichever it
 * cannot prove. Null here simply means the till had nothing to claim.
 */
export type OfflineAttributionClaims = {
  employeePosSessionId: string | null;
  registerSessionId: string | null;
};

export function buildOfflineClaims(state: PosGateState): OfflineAttributionClaims {
  return {
    employeePosSessionId: state.employee?.employeeSessionId ?? null,
    registerSessionId: state.register?.registerSessionId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Stale-state handling
// ---------------------------------------------------------------------------

/**
 * The refusals complete_sale_v5 raises when what the till expected is not what
 * the server holds. Copied verbatim from
 * 20260917120000_register_sessions_and_sale_attribution.sql; a test pins them
 * against the migration so a server-side rewording cannot silently strand this
 * classifier.
 */
export const SALE_EMPLOYEE_MISSING = "An employee must be signed in on this register";
export const SALE_EMPLOYEE_CHANGED = "The signed-in employee changed";
export const SALE_REGISTER_CLOSED = "The register is not open";
export const SALE_REGISTER_CHANGED = "The register session changed";
export const SALE_EXPECTATIONS_MISSING =
  "This sale must name the signed-in employee and the open register";

export type SaleAttributionFailure =
  | "employee_missing"
  | "employee_changed"
  | "register_closed"
  | "register_changed"
  | "expectations_missing";

/**
 * Classifies a sale refusal, or returns null when it is not about attribution.
 *
 * MATCHED ON THE SERVER'S OWN TEXT because that is what PostgREST returns for a
 * RAISE, and complete_sale_v5 deliberately raises distinct messages for exactly
 * this purpose. A message this does not recognise is NOT treated as an
 * attribution problem: the caller shows it and leaves the gate alone, which is
 * the safe direction — a sale that failed for some other reason must not clear
 * the operator's session as a side effect.
 */
export function classifySaleAttributionFailure(
  message: string | null
): SaleAttributionFailure | null {
  if (message === null) return null;

  if (message.includes(SALE_EMPLOYEE_CHANGED)) return "employee_changed";
  if (message.includes(SALE_EMPLOYEE_MISSING)) return "employee_missing";
  if (message.includes(SALE_REGISTER_CHANGED)) return "register_changed";
  if (message.includes(SALE_REGISTER_CLOSED)) return "register_closed";
  if (message.includes(SALE_EXPECTATIONS_MISSING)) return "expectations_missing";

  return null;
}

/**
 * What the till must forget after such a refusal.
 *
 * Whatever the server disagreed about is dropped, which sends the operator back
 * to the gate that re-establishes it. The sale is NOT resubmitted: the same
 * cart may be rung again deliberately, by a person, once the right employee and
 * register are established. Silently retrying is the one behaviour this whole
 * mechanism exists to prevent.
 */
export function applySaleAttributionFailure(
  state: PosGateState,
  failure: SaleAttributionFailure
): PosGateState {
  switch (failure) {
    case "employee_changed":
    case "employee_missing":
      // The register may still be open, but it is re-derived anyway: the till
      // has just been proven wrong about server state, so it re-asks for both.
      return { employee: null, register: null, establishedOnline: false };
    case "register_changed":
    case "register_closed":
      return { ...state, register: null, establishedOnline: false };
    case "expectations_missing":
      return { employee: null, register: null, establishedOnline: false };
  }
}

/**
 * What the till holds after a server derivation.
 *
 * `establishedOnline` is true only when BOTH came back, because that is the
 * pair Policy 1 gates offline checkout on. A derivation that returns an
 * employee but no register leaves the till at the register gate, online, with
 * nothing established.
 */
export function applyServerDerivation(input: {
  employee: EmployeeSession | null;
  register: RegisterSession | null;
}): PosGateState {
  return {
    employee: input.employee,
    register: input.register,
    establishedOnline: input.employee !== null && input.register !== null,
  };
}

/** The till lost its authority entirely: revoked, unpaired, signed out. */
export function clearPosGateState(): PosGateState {
  return EMPTY_POS_GATE_STATE;
}
