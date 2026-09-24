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
import type { DailyRegisterContext } from "@/lib/dailyRegister";

/**
 * Which screen the device host owes the operator.
 *
 * v1.3 CP2d REPLACED THE REGISTER GATE. There is no longer a normal cashier
 * step for opening a register, entering opening cash or choosing one: a
 * business day is a calendar fact the server establishes, so the till asks for
 * it and either has it or does not. What is left are two EXCEPTIONS -- a
 * business with no timezone configured, and a daily context the server refused
 * to establish -- and neither is register management.
 */
export type PosGate = "employee" | "timezone" | "daily" | "pos";

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
export type PosGateRecovery = "employee" | "daily";

/**
 * The one setup problem a cashier cannot fix and must not work around.
 *
 * The server refused to establish a business day because nobody has told it
 * what timezone this business keeps. There is no safe local answer -- not the
 * browser's zone, not Android's, not Windows's, not UTC -- so the till says so
 * and stops. Configuring it is the owner's job, in Lane 3.
 */
export type PosGateSetup = "business_timezone";

export type PosGateState = {
  /** The employee POS session, as the server last reported it. */
  employee: EmployeeSession | null;
  /** The DAILY register context, as the server last established it. */
  daily: DailyRegisterContext | null;
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
   * Set when the server answered `business_timezone_required`.
   *
   * Kept apart from `recovery` because it is not a staleness problem and no
   * amount of retrying by this cashier will clear it: somebody has to
   * configure the business. Cleared by a later ensure that succeeds.
   */
  setup: PosGateSetup | null;
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
  daily: null,
  establishedOnline: false,
  recovery: null,
  setup: null,
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
  // Setup outranks recovery: retrying a daily context for a business that has
  // no timezone can only fail again, and telling the cashier to recover
  // something nobody at the till can fix would be a lie about whose job it is.
  if (state.setup === "business_timezone") return "timezone";
  if (state.recovery === "daily" || state.daily === null) return "daily";

  return "pos";
}

/**
 * Why checkout is refused while a gate is pending.
 *
 * Fed to PosRuntime's `checkoutBlockedReason`, which is the runtime's own
 * pre-existing boundary: it is the FIRST statement in completeSale, ahead of
 * planSaleSubmission, submitSale and the durable enqueue. A covering overlay
 * stops a person reaching the button; this stops the sale even if something
 * else does.
 */
const GATE_BLOCKED_MESSAGES: Record<Exclude<PosGate, "pos">, string> = {
  employee: "Sign in an employee before taking a sale.",
  timezone: "Set this business's timezone before taking a sale.",
  daily: "Reconnect to establish today's register before taking a sale.",
};

export function describePosGateBlock(state: PosGateState): string | null {
  const gate = resolvePosGate(state);

  return gate === "pos" ? null : GATE_BLOCKED_MESSAGES[gate];
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
    state.setup !== null ||
    !state.establishedOnline ||
    state.employee === null ||
    state.daily === null
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
    // v1.3 CP2d — the retained DAILY id, deliberately. A till that queued sales
    // across midnight keeps sending the day it was established under, and CP2c
    // treats that as the DAILY-MODE SIGNAL and derives the real day from
    // occurred_at. Manufacturing tomorrow's id here, from a device clock, is
    // exactly what must not happen.
    registerSessionId: state.daily?.registerSessionId ?? null,
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

/**
 * v1.3 CP2c — the two DAILY domain failures complete_sale_v5 raises on the
 * ONLINE path, verbatim.
 *
 * They are NOT sentences like the Feature 1B refusals above: CP2c re-raises
 * whatever `daily_register_context_for_sale` returned in `failure`
 * (`raise exception '%', v_daily.failure`), so the wire text is the bare
 * contract code. They arrive here exactly as CP2b minted them.
 *
 * WHY THEY LIVE IN THIS FILE AT ALL. CP2c added them to the server and CP2d
 * built the states that answer them, and nothing connected the two — so a real
 * timezone conflict refused the sale correctly and then left the cashier
 * looking at a raw domain code with no way forward. A guard now pins both
 * against the CP2c migration, exactly as the five above are pinned against
 * Feature 1B's.
 */
export const SALE_DAILY_TIMEZONE_CONFLICT = "daily_register_timezone_conflict";
export const SALE_DAILY_TIMEZONE_REQUIRED = "business_timezone_required";

/**
 * DELIBERATELY NOT CLASSIFIED: CP2c's third failure value.
 *
 * `daily_register_context_for_sale` can also return `not_paired`, and v5 would
 * re-raise it the same way. It is unreachable from v5 in practice -- the device
 * row was resolved two sections earlier, so a sale cannot get that far without
 * a pairing -- and more importantly there is no useful cashier state for it:
 * a till that is not paired has no employee to retain, no day to recover and no
 * setting anyone at the counter can change. It falls through to the generic
 * failure path on purpose, and a test pins that choice so it reads as a
 * decision rather than an oversight.
 */
export const SALE_DAILY_NOT_PAIRED = "not_paired";

export type SaleAttributionFailure =
  | "employee_missing"
  | "employee_changed"
  | "register_closed"
  | "register_changed"
  | "expectations_missing"
  // v1.3 CP2c, routed by CP2d. Neither disproves the OPERATOR -- only the day.
  | "daily_conflict"
  | "timezone_required";

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
  if (message.includes(SALE_DAILY_TIMEZONE_CONFLICT)) return "daily_conflict";
  if (message.includes(SALE_DAILY_TIMEZONE_REQUIRED)) return "timezone_required";

  // Everything else, INCLUDING SALE_DAILY_NOT_PAIRED. A refusal this runtime
  // has no state for is not an attribution problem it can resolve, and
  // inventing one would put the operator in a recovery that cannot succeed.
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
      return { ...EMPTY_POS_GATE_STATE, recovery: "employee" };
    case "register_changed":
    case "register_closed":
      // v1.3 CP2d — THIS IS NOW AN EXCEPTION, NOT A SHIFT CHANGE. CP2c rolls an
      // ordinary midnight forward inside the sale itself, so a register refusal
      // that still reaches the till is not "the day turned over": it is a daily
      // context the server would not establish, or one this till has no
      // business holding. The employee was NOT disproved and stays signed in;
      // the context is re-established by an explicit act, never by whatever the
      // next derivation happens to find.
      return { ...state, daily: null, establishedOnline: false, recovery: "daily" };
    case "daily_conflict":
      // v1.3 CP2c — the server would not establish a day for this instant,
      // because the business changed timezone under a context that already
      // exists. THE OPERATOR WAS NOT DISPROVED, so they stay signed in: this is
      // the same class as a stale register, and it is the DAY that a person
      // must re-establish through the explicit recovery, never a login.
      return { ...state, daily: null, establishedOnline: false, recovery: "daily", setup: null };
    case "timezone_required":
      // v1.3 CP2c — the business has not told the server what day it is. No
      // recovery is raised because there is nothing at this till to recover:
      // retrying can only fail again until somebody with authority configures
      // the timezone. The operator stays signed in and the cart stays put.
      return {
        ...state,
        daily: null,
        establishedOnline: false,
        recovery: null,
        setup: "business_timezone",
      };
  }
}

/**
 * The outcome of one ensure_daily_register_context() call, as the pure rules
 * consume it.
 *
 * A FAILED CALL IS NOT A REFUSED DAY. `unavailable` means the question never
 * reached the server; the till keeps what it already had and tries again. Only
 * `timezone_required` and `conflict` are the server saying no, and they earn
 * different screens because one is a setup job and the other is an exception.
 */
export type DailyAcquisition =
  | { ok: true; context: DailyRegisterContext }
  | { ok: false; reason: "timezone_required" | "conflict" | "unavailable" };

/**
 * Applies a daily acquisition to a state whose employee is already confirmed.
 *
 * Shared by login, reconnect, resume and recovery so there is exactly one
 * answer to "what does this outcome mean", rather than four that drift.
 */
function withDaily(
  employee: EmployeeSession,
  previous: DailyRegisterContext | null,
  acquisition: DailyAcquisition,
  recovery: PosGateRecovery | null
): PosGateState {
  if (acquisition.ok) {
    // A PENDING RECOVERY SURVIVES A SUCCESSFUL ACQUISITION. The server having a
    // perfectly good business day is an observation; it is not this operator
    // choosing to trust the till again. Only an explicit act clears a recovery,
    // which is why `establishedOnline` follows the recovery rather than the
    // acquisition.
    return {
      employee,
      daily: recovery === null ? acquisition.context : null,
      establishedOnline: recovery === null,
      recovery,
      setup: null,
    };
  }

  if (acquisition.reason === "timezone_required") {
    return { employee, daily: null, establishedOnline: false, recovery: null, setup: "business_timezone" };
  }

  if (acquisition.reason === "conflict") {
    return { employee, daily: null, establishedOnline: false, recovery: "daily", setup: null };
  }

  // UNAVAILABLE. Nothing was learned, so nothing established is thrown away: a
  // till that was already selling keeps its context and carries on offline,
  // which is exactly what Policy 1 allows and what a midnight refresh that
  // fires without a network must not undo.
  return {
    employee,
    daily: previous,
    establishedOnline: previous !== null,
    recovery,
    setup: null,
  };
}

/**
 * Startup and reload: the till comes up LOCKED, whoever the server reports.
 *
 * THIS IS THE CHECKPOINT-2 RULE, AND IT IS THE POINT OF THE WHOLE FEATURE.
 * get_current_employee_session answering "Ada is signed in" is an observation
 * about the server, not a statement that Ada is standing at this till. A
 * session outlives a reload, an app switch, a battery swap and a shift change;
 * unlocking on it would mean the till reopens under whoever was last
 * authenticated, for anyone who picks it up.
 *
 * So nothing observed populates `employee`. A person types an Employee ID and
 * a PIN, or the POS stays locked. The daily context is not derived here either:
 * it is established after login, by the server, and a till with nobody signed
 * in has no business holding one.
 */
export function applyStartupLock(): PosGateState {
  return EMPTY_POS_GATE_STATE;
}

/**
 * The operator authenticated HERE, in this app run, and the till then asked the
 * server for today.
 *
 * THE RACE THIS FUNCTION EXISTS TO CLOSE. Between the login returning and the
 * daily context coming back, another till on the same pairing -- or a switch at
 * this one -- can have replaced the employee POS session. Establishing on the
 * login's word alone would open the POS under an operator the server had
 * already moved on from, and a connection drop straight afterwards would let
 * offline sales be taken under them.
 *
 * So the login's session id is re-read AFTER the daily call and compared by
 * SESSION IDENTITY. Not employee id, not employee code, not display name: the
 * same person signing out and back in is a different POS session, and
 * complete_sale_v5 compares session ids too, so anything weaker only moves the
 * refusal later.
 *
 * A REVALIDATION THAT FAILS LOCKS THE TILL. Not "adopt the new session", not
 * "retry the login" -- back to Employee ID and PIN, with the cart untouched.
 */
export function applyEmployeeAuthenticated(input: {
  /** The session employee_login_by_code returned, in THIS app run. */
  employee: EmployeeSession;
  /** What ensure_daily_register_context() answered. */
  daily: DailyAcquisition;
  /** The employee session re-read AFTER the daily call. */
  revalidated: SessionRead<EmployeeSession>;
}): PosGateState {
  if (!input.revalidated.ok) {
    // The re-read never happened, so the spanning check cannot be satisfied.
    // Nothing is established on an unverified pair.
    return applyStartupLock();
  }

  if (
    input.revalidated.session === null ||
    input.revalidated.session.employeeSessionId !== input.employee.employeeSessionId
  ) {
    return applyStartupLock();
  }

  return withDaily(input.employee, null, input.daily, null);
}

/**
 * A reconnect or a resume, for a till whose operator authenticated here.
 *
 * It must not log them out -- a flapping connection is not a shift change, and
 * neither is a new calendar day -- and it must not unlock a till nobody signed
 * into. So: locked stays locked, an authenticated operator is kept ONLY while
 * the server still reports the very same POS session, and the daily context is
 * whatever the server says it is now.
 *
 * DATE CHANGE ALONE NEVER COSTS A LOGIN. A till that slept through midnight
 * comes back, confirms the same session, ensures the current context and
 * carries on. A CHANGED OR MISSING SESSION ALWAYS DOES.
 */
export function applyReconnectDerivation(
  state: PosGateState,
  observed: { employee: SessionRead<EmployeeSession>; daily: DailyAcquisition }
): PosGateState {
  if (state.employee === null) {
    return applyStartupLock();
  }

  if (!observed.employee.ok) {
    return applyStartupLock();
  }

  if (
    observed.employee.session === null ||
    observed.employee.session.employeeSessionId !== state.employee.employeeSessionId
  ) {
    return applyStartupLock();
  }

  return withDaily(state.employee, state.daily, observed.daily, state.recovery);
}

/**
 * A refresh that must never take anything away.
 *
 * The freshness timer, and any refresh that fires while the till is offline or
 * mid-sale. It can only ever REPLACE the context with a newer authoritative
 * one; it cannot lock the till, cannot end the employee session, cannot clear
 * the cart and cannot stop an already-authorized offline checkout because a
 * business day ended on the device's clock.
 *
 * A till with nothing established is left exactly as it was: a refresh is not
 * a way in.
 */
export function applyDailyRefresh(
  state: PosGateState,
  acquisition: DailyAcquisition
): PosGateState {
  if (state.employee === null) {
    return state;
  }

  if (!acquisition.ok) {
    if (acquisition.reason === "unavailable") {
      // Offline, or the server could not be reached. Keep everything.
      return state;
    }

    // The server refused. The till stops being established -- but the operator
    // is NOT signed out and the cart is NOT touched; those belong to the host.
    return withDaily(state.employee, null, acquisition, state.recovery);
  }

  // A pending recovery is carried straight through: withDaily refuses to
  // establish while one is set, so a refresh nobody asked for cannot reopen a
  // till the server has already proven wrong.
  return withDaily(state.employee, state.daily, acquisition, state.recovery);
}

/**
 * Adopting the register id a COMPLETED sale was stored against.
 *
 * Freshness only, and only ever after the server has already written the order.
 * CP2c rolls a sale forward at the moment of sale, so the id that comes back
 * may be a newer business day than the one this till was holding. Taking it
 * means the next sale arrives current instead of rolling forward again.
 *
 * It cannot establish anything: a till with nothing established, or one with a
 * recovery pending, is returned untouched.
 */
export function applySaleRegisterAdoption(
  state: PosGateState,
  context: DailyRegisterContext
): PosGateState {
  if (state.employee === null || !state.establishedOnline || state.recovery !== null) {
    return state;
  }

  return { ...state, daily: context };
}

/**
 * One server read: it either happened or it did not, and if it did it either
 * found a session or it did not.
 *
 * A FAILED READ IS NOT AN ABSENT SESSION. "The server says nobody is signed in"
 * and "we could not ask" must never collapse into the same transition -- the
 * first is information, the second is the absence of it, and they call for
 * different gates.
 */
export type SessionRead<T> = { ok: false } | { ok: true; session: T | null };

/**
 * Whether the employee a recovery retained is still the one signed in.
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
    return { ok: false, reason: "employee_changed", state: { ...EMPTY_POS_GATE_STATE, recovery: "employee" } };
  }

  if (!read.ok) {
    // The operator stays where they are and can retry. The retained employee is
    // NOT signed out -- a failed read is not evidence that they left.
    return {
      ok: false,
      reason: "unavailable",
      state: { ...state, daily: null, establishedOnline: false, recovery: "daily" },
    };
  }

  if (
    read.session === null ||
    read.session.employeeSessionId !== state.employee.employeeSessionId
  ) {
    // Gone, or somebody else. EITHER WAY THIS IS AN EMPLOYEE RECOVERY: the
    // observed employee is not adopted, not stored and not claimable. Somebody
    // signs in, with a PIN, before this till sells again.
    return { ok: false, reason: "employee_changed", state: { ...EMPTY_POS_GATE_STATE, recovery: "employee" } };
  }

  return { ok: true, employee: read.session };
}

/**
 * The reads that surround an EXPLICIT daily recovery.
 *
 * The operator's press authorizes re-establishing the DAY. It is not
 * authorization to switch EMPLOYEE, so the retained employee is confirmed on
 * BOTH sides of the ensure call before anything is established.
 *
 * WHY THE SECOND READ EARNS ITS ROUND TRIP. Without it the client could
 * establish a pair it had never seen coexist: employee confirmed, employee
 * switched, context established, pair adopted. An online sale would refuse that
 * pair -- but `establishedOnline` is what Policy 1 reads, so a connection drop
 * straight afterwards would let a NEW OFFLINE SALE be taken under an employee
 * the server had already replaced, and no later refusal can un-take it.
 */
export type DailyRecoveryReads = {
  /** Before the ensure call. */
  employeeBefore: SessionRead<EmployeeSession>;
  /** What ensure_daily_register_context() answered. */
  daily: DailyAcquisition;
  /** After the ensure call. Must be the same session as `employeeBefore`. */
  employeeAfter: SessionRead<EmployeeSession>;
};

/**
 * Resolves an explicit daily recovery from a sandwich of reads.
 *
 * FAILS CLOSED IN EVERY DIRECTION. The only outcome that establishes is: same
 * POS session before, a context the server established, same POS session after.
 */
export function applyExplicitDailyEstablished(
  state: PosGateState,
  reads: DailyRecoveryReads
): PosGateState {
  const before = checkRetainedEmployee(state, reads.employeeBefore);

  if (!before.ok) {
    return before.state;
  }

  // THE SPANNING CHECK. Same retained session, read after the ensure.
  const after = checkRetainedEmployee(state, reads.employeeAfter);

  if (!after.ok) {
    return after.state;
  }

  if (!reads.daily.ok) {
    if (reads.daily.reason === "timezone_required") {
      return { employee: after.employee, daily: null, establishedOnline: false, recovery: null, setup: "business_timezone" };
    }

    // Still refused, or still unreachable: the operator stays in recovery and
    // may try again. Nothing is invented and nothing is adopted.
    return { employee: after.employee, daily: null, establishedOnline: false, recovery: "daily", setup: null };
  }

  // Confirmed, spanned, and established. THE ONLY ESTABLISHING OUTCOME.
  return {
    employee: after.employee,
    daily: reads.daily.context,
    establishedOnline: true,
    recovery: null,
    setup: null,
  };
}

/**
 * The operator chose to switch employee. An explicit act, so no recovery is
 * raised -- but the POS closes until somebody signs in.
 */
export function beginEmployeeSwitch(state: PosGateState): PosGateState {
  return { ...state, employee: null, establishedOnline: false };
}

/** The till lost its authority entirely: revoked, unpaired, signed out. */
export function clearPosGateState(): PosGateState {
  return EMPTY_POS_GATE_STATE;
}
