// v1.3 Feature 1B-RUNTIME correction — the login roster's lifecycle.
//
// PURE. No Supabase, no React, no storage. DeviceApp holds this state and calls
// these functions; the fetch itself lives in lib/employee.rpc.ts.
//
// WHY THIS EXISTS AT ALL. The roster began as a bare array, and an empty array
// cannot tell three different situations apart:
//
//   * nobody has asked the server yet,
//   * the server answered and this project genuinely has no one who can sign in,
//   * the request failed.
//
// Collapsing them made the selector claim "No one can sign in on this till yet.
// Add an employee from the dashboard." on a perfectly normal startup, before a
// single request had been made — telling an operator to go fix a problem that
// did not exist. Only a SUCCESSFUL, EMPTY response may establish that claim.
//
// THE ROSTER IS NOT AUTHORITY. It is a list of names and ids offered so someone
// can pick themselves; it decides nothing. Authority comes from employee_login
// and lives in lib/posGate.ts. Nothing here is persisted, and an offline till
// never consults it.
import type { LoginEmployee } from "@/lib/employeeSession";
import type { PosGate } from "@/lib/posGate";

export type RosterState =
  /** Never requested on this till, in this app run. */
  | { status: "unloaded" }
  /** A request is in flight. Exactly one may be. */
  | { status: "loading" }
  /** The server answered. `employees` may legitimately be empty. */
  | { status: "loaded"; employees: readonly LoginEmployee[] }
  /** The request failed. Only an explicit retry leaves this state. */
  | { status: "failed"; message: string };

export const UNLOADED_ROSTER: RosterState = { status: "unloaded" };

export const ROSTER_FAILED_MESSAGE =
  "Could not load the employee list. Check the connection and try again.";

/**
 * Whether the host should start a roster load right now.
 *
 * FOUR CONDITIONS, AND EACH ONE CLOSES A SPECIFIC HOLE:
 *
 *   `ready` + `online` — there is a server to ask. An offline till must not
 *   try, and must not treat a roster as a way in; the employee gate cannot be
 *   satisfied without a server at all.
 *
 *   gate === "employee" — the roster is only ever offered at that gate. A till
 *   selling happily does not re-fetch a list nobody is looking at.
 *
 *   nothing selected — the operator has moved on to the PIN screen, and
 *   swapping the list underneath them would be pointless work.
 *
 *   status === "unloaded" — THIS IS THE LOOP GUARD, and it is why `failed` is
 *   not retried automatically. A till that could not reach the server would
 *   otherwise re-request forever, once per render, for as long as the outage
 *   lasted. A failure is surfaced with a Refresh button and waits for a person.
 */
export function shouldLoadRoster(input: {
  ready: boolean;
  online: boolean;
  gate: PosGate;
  employeeSelected: boolean;
  roster: RosterState;
}): boolean {
  return (
    input.ready &&
    input.online &&
    input.gate === "employee" &&
    !input.employeeSelected &&
    input.roster.status === "unloaded"
  );
}

/**
 * Marks a load as started.
 *
 * IDEMPOTENT ON `loading`: a second caller that arrives while a request is in
 * flight gets the same state back, so a re-render cannot turn one fetch into
 * two. An explicit Refresh from `loaded` or `failed` is allowed and expected —
 * that is a person asking.
 */
export function beginRosterLoad(state: RosterState): RosterState {
  return state.status === "loading" ? state : { status: "loading" };
}

export function applyRosterLoaded(employees: readonly LoginEmployee[]): RosterState {
  return { status: "loaded", employees };
}

export function applyRosterFailed(message: string = ROSTER_FAILED_MESSAGE): RosterState {
  return { status: "failed", message };
}

/** The till lost its pairing or its readiness: the roster is forgotten entirely. */
export function resetRoster(): RosterState {
  return UNLOADED_ROSTER;
}

/** The employees to offer. Empty for every state that is not a successful load. */
export function rosterEmployees(state: RosterState): readonly LoginEmployee[] {
  return state.status === "loaded" ? state.employees : [];
}

/**
 * Whether the selector may say "no one can sign in".
 *
 * TRUE ONLY AFTER A SUCCESSFUL, EMPTY RESPONSE. This is the whole point of the
 * module: the claim is a fact about the project, so it needs a fact from the
 * server behind it.
 */
export function isRosterConfirmedEmpty(state: RosterState): boolean {
  return state.status === "loaded" && state.employees.length === 0;
}
