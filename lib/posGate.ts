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

/**
 * What the operator must EXPLICITLY re-establish before another sale.
 *
 * Set only when the server has specifically proven that the till's displayed
 * sale context was stale — complete_sale_v5 refused the expectations it was
 * sent. It is deliberately NOT set by ordinary startup or reconnect: there,
 * nothing has been disproved and a plain derivation is correct.
 *
 * WHY A SEPARATE FIELD RATHER THAN `establishedOnline: false`. Clearing that
 * flag stops OFFLINE checkout, but it does not stop the POS from reopening: a
 * re-derivation that finds a different employee and an open register would set
 * it straight back to true and `resolvePosGate` would return "pos". The
 * operator would then be selling under someone the server had just told the
 * till was not who it thought. This field survives the re-derivation and forces
 * the gate regardless of what the server reports.
 */
export type PosGateRecovery = "employee" | "register";

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
  /**
   * Set after a stale-expectation refusal; cleared only by an explicit act.
   *
   * "The server says this is current, but a person must re-establish it before
   * this till sells again."
   */
  recovery: PosGateRecovery | null;
};

export const EMPTY_POS_GATE_STATE: PosGateState = {
  employee: null,
  register: null,
  establishedOnline: false,
  recovery: null,
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
  // RECOVERY OUTRANKS WHAT THE TILL HOLDS. A pending recovery keeps the
  // operator at the gate that re-establishes it even when the server has since
  // reported a perfectly good employee and a perfectly good open register —
  // because "the server has A" and "this operator chose A" are different
  // claims, and only the second one may reopen the POS.
  if (state.recovery === "employee" || state.employee === null) return "employee";
  if (state.recovery === "register" || state.register === null) return "register";

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
  if (
    state.recovery !== null ||
    !state.establishedOnline ||
    state.employee === null ||
    state.register === null
  ) {
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
    case "expectations_missing":
      // The register may still be open, but it is re-established anyway: the
      // till has just been proven wrong about server state, so it re-asks for
      // both, and `recovery` makes the employee gate mandatory on the way back.
      return { employee: null, register: null, establishedOnline: false, recovery: "employee" };
    case "register_changed":
    case "register_closed":
      // The employee was NOT disproved, so they stay signed in — but the
      // register must be re-established by a person, not by whatever the next
      // derivation happens to find open.
      return { ...state, register: null, establishedOnline: false, recovery: "register" };
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
    recovery: null,
  };
}

/**
 * The re-read that follows a stale-expectation refusal. AUTHORITATIVE
 * OBSERVATION, NOT ESTABLISHED AUTHORITY.
 *
 * The server has just proven this till wrong about its own sale context, so the
 * runtime asks again — but what comes back may not reopen the POS. Two
 * different claims are being kept apart here:
 *
 *   "the server currently reports Bo and register B"   — an observation
 *   "this operator signed in as Bo and took register B" — authority
 *
 * Only the second may sell. So nothing observed is adopted: `establishedOnline`
 * stays false, `recovery` survives, and `resolvePosGate` keeps the operator at
 * the gate. The read is still worth making — it is what detects that the
 * employee ALSO changed during a register recovery, which escalates.
 *
 * NOTHING OBSERVED IS EVEN STORED in the fields a sale reads. That is
 * deliberate: an observed register that never lands in `state.register` cannot
 * be claimed by `buildOfflineClaims`, cannot become an expectation, and cannot
 * be reached by any future code path that forgets why this existed.
 */
export function applyRecoveryObservation(
  state: PosGateState,
  observed: { employee: EmployeeSession | null; register: RegisterSession | null }
): PosGateState {
  // Anything other than a register-only recovery sends the operator all the way
  // back to the employee gate. A state with no recovery pending reaching this
  // function is a caller bug, and the safe direction is the strict one.
  if (state.recovery !== "register" || state.employee === null) {
    return { employee: null, register: null, establishedOnline: false, recovery: "employee" };
  }

  // The register was the only thing disproved, so the signed-in employee may be
  // carried — but ONLY while the server still reports the very same session. A
  // different session id means the employee changed too, and that is an
  // employee recovery, not a register one.
  if (
    observed.employee === null ||
    observed.employee.employeeSessionId !== state.employee.employeeSessionId
  ) {
    return { employee: null, register: null, establishedOnline: false, recovery: "employee" };
  }

  return { employee: state.employee, register: null, establishedOnline: false, recovery: "register" };
}

/**
 * One server read: it either happened or it did not, and if it did it either
 * found a session or it did not.
 *
 * A FAILED READ IS NOT AN ABSENT SESSION. "The server says nobody is signed in"
 * and "we could not ask" must never collapse into the same transition — the
 * first is information, the second is the absence of it, and they call for
 * different gates.
 */
export type SessionRead<T> = { ok: false } | { ok: true; session: T | null };

/**
 * The three reads that surround a register-recovery operation.
 *
 * THE EMPLOYEE SESSION MUST SPAN THE REGISTER OBSERVATION. Reading the employee
 * once and then the register left a window: the server could switch from Ada to
 * Bo in between, and the till would pair a confirmed-a-moment-ago Ada with a
 * register read after she was gone. The second employee read closes exactly
 * that window by requiring the same POS session on both sides of the register
 * operation.
 *
 * This is not atomicity, and it is not claimed to be. A switch AFTER the final
 * read is ordinary runtime staleness, which complete_sale_v5's online
 * expectations already refuse. What it removes is the case where the client
 * ITSELF observed the register under one employee and established under
 * another — the only version of this race that can reach the offline queue.
 */
export type RegisterRecoveryReads = {
  /** Before the register operation. */
  employeeBefore: SessionRead<EmployeeSession>;
  /** The register that was read, opened, or found already open. */
  register: SessionRead<RegisterSession>;
  /** After the register operation. Must be the same session as `employeeBefore`. */
  employeeAfter: SessionRead<EmployeeSession>;
};

/**
 * Whether the employee the recovery retained is still the one signed in.
 *
 * Used twice per adoption and once more as the PRE-CHECK that decides whether
 * open_register_session may be called at all. Every identity comparison in the
 * register-recovery flow goes through here, so there is one rule and one place
 * to read it.
 *
 * COMPARED BY POS SESSION IDENTITY. Not by employee id, and certainly not by
 * display name: Ada signing out and back in is a NEW session, and
 * complete_sale_v5 compares session ids too, so accepting anything weaker here
 * would only move the refusal later.
 */
export type RetainedEmployeeCheck =
  | { ok: true; employee: EmployeeSession }
  /** The read failed. Nothing was learned, so nothing changes but the gate. */
  | { ok: false; state: PosGateState; reason: "unavailable" }
  /** The server answered, and it is somebody else (or nobody). */
  | { ok: false; state: PosGateState; reason: "employee_changed" };

export function checkRetainedEmployee(
  state: PosGateState,
  read: SessionRead<EmployeeSession>
): RetainedEmployeeCheck {
  // Nothing retained to revalidate against: there is no safe way forward.
  if (state.employee === null) {
    return {
      ok: false,
      reason: "employee_changed",
      state: { employee: null, register: null, establishedOnline: false, recovery: "employee" },
    };
  }

  if (!read.ok) {
    // The operator stays where they are and can retry. The retained employee is
    // NOT signed out — a failed read is not evidence that they left.
    return {
      ok: false,
      reason: "unavailable",
      state: { ...state, register: null, establishedOnline: false, recovery: "register" },
    };
  }

  if (
    read.session === null ||
    read.session.employeeSessionId !== state.employee.employeeSessionId
  ) {
    // Gone, or somebody else. EITHER WAY THIS IS AN EMPLOYEE RECOVERY: the
    // observed employee is not adopted, not stored and not claimable. Somebody
    // signs in, with a PIN, before this till sells again.
    return {
      ok: false,
      reason: "employee_changed",
      state: { employee: null, register: null, establishedOnline: false, recovery: "employee" },
    };
  }

  return { ok: true, employee: read.session };
}

/**
 * Resolves a register recovery from a sandwich of reads.
 *
 * The operator's press authorizes taking the REGISTER. It is not authorization
 * to switch EMPLOYEE, so the retained employee must be confirmed on BOTH sides
 * of the register operation before anything is established.
 *
 * WHY THE SECOND READ EARNS ITS ROUND TRIP. Without it the client could
 * establish a pair it had never seen coexist: employee confirmed, employee
 * switched, register read, pair established. An online sale would refuse that
 * pair — but `establishedOnline` is what Policy 1 reads, so a connection drop
 * straight afterwards would let a NEW OFFLINE SALE be taken under an employee
 * the server had already replaced, and no later refusal can un-take it.
 *
 * FAILS CLOSED IN EVERY DIRECTION. The only outcome that establishes is: same
 * POS session before, an open register, same POS session after.
 */
export function applyExplicitRegisterEstablished(
  state: PosGateState,
  reads: RegisterRecoveryReads
): PosGateState {
  const before = checkRetainedEmployee(state, reads.employeeBefore);

  if (!before.ok) {
    return before.state;
  }

  if (!reads.register.ok) {
    return { ...state, register: null, establishedOnline: false, recovery: "register" };
  }

  // THE SPANNING CHECK. Same retained session, read after the register.
  const after = checkRetainedEmployee(state, reads.employeeAfter);

  if (!after.ok) {
    return after.state;
  }

  // The employee held throughout, but there is no register to take.
  if (reads.register.session === null) {
    return { employee: after.employee, register: null, establishedOnline: false, recovery: "register" };
  }

  // Confirmed, spanned, and open. THE ONLY ESTABLISHING OUTCOME.
  return {
    employee: after.employee,
    register: reads.register.session,
    establishedOnline: true,
    recovery: null,
  };
}

/**
 * The operator chose to switch employee. An explicit act, so no recovery is
 * raised — but the POS closes until somebody signs in.
 */
export function beginEmployeeSwitch(state: PosGateState): PosGateState {
  return { ...state, employee: null, establishedOnline: false };
}

/** The till lost its authority entirely: revoked, unpaired, signed out. */
export function clearPosGateState(): PosGateState {
  return EMPTY_POS_GATE_STATE;
}
