// v1.3 Feature 1B-RUNTIME — opening-cash validation and the register parsers.
//
// The validation here mirrors open_register_session's rules so a cashier hears
// about a typo a moment sooner. It is not authority, and these tests assert the
// one property that matters for money: an over-precise amount is REFUSED, never
// rounded and sent.
import { describe, expect, it } from "vitest";
import {
  MAX_OPENING_CASH,
  getOpeningCashMessage,
  getRegisterCloseMessage,
  getRegisterOpenMessage,
  parseCurrentRegisterSessionResult,
  parseRegisterCloseResult,
  parseRegisterOpenResult,
  parseRegisterSession,
  validateOpeningCash,
} from "@/lib/registerSession";

const SESSION = {
  registerSessionId: "reg-1",
  openedAt: "2026-09-18T02:05:00+00:00",
  openedByEmployeeId: "emp-ada",
  openingCash: "25.50",
  closedAt: null,
  closedByEmployeeId: null,
};

describe("opening cash", () => {
  for (const [input, canonical] of [
    ["0", "0.00"],
    ["0.00", "0.00"],
    ["5", "5.00"],
    ["12.3", "12.30"],
    ["12.34", "12.34"],
    ["  100.00  ", "100.00"],
    ["9999999999.99", "9999999999.99"],
  ] as const) {
    it(`accepts ${JSON.stringify(input)}`, () => {
      const result = validateOpeningCash(input);

      expect(result.ok).toBe(true);
      expect(result.ok === true && result.canonical).toBe(canonical);
    });
  }

  it("accepts zero, which is a real opening float", () => {
    expect(validateOpeningCash("0")).toEqual({ ok: true, amount: 0, canonical: "0.00" });
  });

  for (const [input, problem] of [
    ["", "empty"],
    ["   ", "empty"],
    ["abc", "not_a_number"],
    ["1e3", "not_a_number"],
    ["1,000", "not_a_number"],
    ["$10", "not_a_number"],
    ["10.", "not_a_number"],
    ["-0.01", "negative"],
    ["-5", "negative"],
    ["12.345", "too_precise"],
    ["0.001", "too_precise"],
    ["10000000000.00", "too_large"],
  ] as const) {
    it(`refuses ${JSON.stringify(input)} as ${problem}`, () => {
      const result = validateOpeningCash(input);

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.problem).toBe(problem);
      expect(getOpeningCashMessage(problem)).toBeTruthy();
    });
  }

  it("REFUSES over-precision rather than rounding it", () => {
    // The one rule that protects the books: 12.345 must never quietly become
    // 12.35, on the client or on the server.
    const result = validateOpeningCash("12.345");

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("12.35");
  });

  it("-0 and -0.00 are zero, not negative", () => {
    expect(validateOpeningCash("-0").ok).toBe(true);
    expect(validateOpeningCash("-0.00").ok).toBe(true);
  });

  it("the client ceiling is the column's ceiling", () => {
    expect(MAX_OPENING_CASH).toBe(9999999999.99);
  });
});

describe("parsing what the server returns", () => {
  it("reads an open session", () => {
    expect(parseRegisterSession(SESSION)).toEqual(SESSION);
  });

  it("reads a closed session", () => {
    const closed = { ...SESSION, closedAt: "2026-09-18T03:00:00+00:00", closedByEmployeeId: "emp-ada" };

    expect(parseRegisterSession(closed)).toEqual(closed);
  });

  it("refuses a half-closed shape", () => {
    // The server's biconditional restated: a closed session always says who
    // closed it.
    expect(parseRegisterSession({ ...SESSION, closedAt: "2026-09-18T03:00:00+00:00" })).toBeNull();
    expect(parseRegisterSession({ ...SESSION, closedByEmployeeId: "emp-ada" })).toBeNull();
  });

  it("refuses a session missing its money or identity", () => {
    for (const key of ["registerSessionId", "openedAt", "openedByEmployeeId", "openingCash"]) {
      expect(parseRegisterSession({ ...SESSION, [key]: "" })).toBeNull();
      expect(parseRegisterSession({ ...SESSION, [key]: null })).toBeNull();
    }

    expect(parseRegisterSession(null)).toBeNull();
    expect(parseRegisterSession([SESSION])).toBeNull();
  });

  it("reads an open result, replayed or not", () => {
    expect(parseRegisterOpenResult({ ok: true, replayed: false, registerSession: SESSION })).toEqual({
      ok: true,
      session: SESSION,
      replayed: false,
    });
    expect(parseRegisterOpenResult({ ok: true, replayed: true, registerSession: SESSION })).toEqual({
      ok: true,
      session: SESSION,
      replayed: true,
    });
  });

  it("reads already_open WITH the session that is open, so the till can adopt it", () => {
    const result = parseRegisterOpenResult({
      ok: false,
      error: "already_open",
      registerSession: SESSION,
    });

    expect(result).toEqual({ ok: false, code: "already_open", session: SESSION });
  });

  it("reads every approved open failure", () => {
    for (const code of [
      "not_authenticated",
      "not_paired",
      "invalid_request",
      "invalid_opening_cash",
      "employee_session_required",
      "request_conflict",
    ] as const) {
      const result = parseRegisterOpenResult({ ok: false, error: code });

      expect(result).toEqual({ ok: false, code, session: null });
      expect(getRegisterOpenMessage(code)).toBeTruthy();
    }
  });

  it("an unknown or malformed answer is `unavailable`, never a success", () => {
    expect(parseRegisterOpenResult({ ok: false, error: "something_new" }).ok).toBe(false);
    expect(parseRegisterOpenResult({ ok: true }).ok).toBe(false);
    expect(parseRegisterOpenResult(null).ok).toBe(false);
    expect(parseRegisterCloseResult({ ok: true }).ok).toBe(false);
    expect(parseCurrentRegisterSessionResult("nope").ok).toBe(false);
  });

  it("reads a close, including the already-closed replay", () => {
    const closed = { ...SESSION, closedAt: "2026-09-18T03:00:00+00:00", closedByEmployeeId: "emp-ada" };

    expect(parseRegisterCloseResult({ ok: true, alreadyClosed: false, registerSession: closed })).toEqual(
      { ok: true, session: closed, alreadyClosed: false }
    );
    expect(parseRegisterCloseResult({ ok: true, alreadyClosed: true, registerSession: closed })).toEqual(
      { ok: true, session: closed, alreadyClosed: true }
    );

    for (const code of ["not_authenticated", "not_paired", "not_found", "employee_session_required"] as const) {
      expect(parseRegisterCloseResult({ ok: false, error: code })).toEqual({ ok: false, code });
      expect(getRegisterCloseMessage(code)).toBeTruthy();
    }
  });

  it("no open register is a successful answer, not an error", () => {
    expect(parseCurrentRegisterSessionResult({ ok: true, registerSession: null })).toEqual({
      ok: true,
      session: null,
    });
    expect(parseCurrentRegisterSessionResult({ ok: true })).toEqual({ ok: true, session: null });
    expect(parseCurrentRegisterSessionResult({ ok: true, registerSession: SESSION })).toEqual({
      ok: true,
      session: SESSION,
    });
    expect(parseCurrentRegisterSessionResult({ ok: false, error: "not_paired" })).toEqual({
      ok: false,
      code: "not_paired",
    });
  });
});
