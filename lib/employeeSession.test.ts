// v1.3 Feature 1A — the pure employee session model.
//
// Behavioural tests for lib/employeeSession.ts. Everything here runs under
// plain Node with no database, no network and no browser: this module is pure
// by construction and these tests are the reason it has to stay that way.
import { describe, expect, it } from "vitest";
import {
  EMPLOYEE_ROLES,
  formatRetryWait,
  getEmployeeLoginErrorMessage,
  isEmployeeRole,
  isValidEmployeePinShape,
  parseCurrentEmployeeSessionResult,
  parseEmployeeLoginResult,
  parseEmployeeLogoutResult,
} from "@/lib/employeeSession";
import type { EmployeeLoginErrorCode } from "@/lib/employeeSession";

const SUCCESS = {
  ok: true,
  employeeSessionId: "11111111-1111-1111-1111-111111111111",
  employeeId: "22222222-2222-2222-2222-222222222222",
  displayName: "Sam",
  role: "cashier",
  startedAt: "2026-09-14T10:00:00.000Z",
};

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

describe("roles are a closed set", () => {
  it("is exactly owner, manager and cashier", () => {
    expect([...EMPLOYEE_ROLES]).toEqual(["owner", "manager", "cashier"]);
  });

  it("accepts each member", () => {
    for (const role of EMPLOYEE_ROLES) {
      expect(isEmployeeRole(role)).toBe(true);
    }
  });

  it("rejects anything else, including near-misses and casing", () => {
    for (const value of ["admin", "supervisor", "Owner", "CASHIER", "", null, undefined, 3, {}]) {
      expect(isEmployeeRole(value)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// PIN shape
// ---------------------------------------------------------------------------

describe("PIN shape", () => {
  it("accepts 4, 5 and 6 ASCII digits", () => {
    for (const pin of ["0000", "1234", "12345", "123456", "999999"]) {
      expect(isValidEmployeePinShape(pin)).toBe(true);
    }
  });

  it("rejects anything shorter or longer", () => {
    for (const pin of ["", "1", "123", "1234567"]) {
      expect(isValidEmployeePinShape(pin)).toBe(false);
    }
  });

  it("rejects non-digits, including separators an operator might type", () => {
    for (const pin of ["12a4", "12 4", "12-34", "１２３４", "١٢٣٤", "+1234", "1.234"]) {
      expect(isValidEmployeePinShape(pin)).toBe(false);
    }
  });

  it("does NOT trim an invalid PIN into validity", () => {
    // This is the rule, not an accident. A pairing code is normalized because a
    // human reads it aloud; a PIN is typed on a keypad and " 1234 " is wrong.
    expect(isValidEmployeePinShape(" 1234")).toBe(false);
    expect(isValidEmployeePinShape("1234 ")).toBe(false);
    expect(isValidEmployeePinShape(" 1234 ")).toBe(false);
    expect(isValidEmployeePinShape("\t1234\n")).toBe(false);
  });

  it("rejects multiline input that contains a valid PIN on one line", () => {
    // A non-anchored or `m`-flagged regex would accept this.
    expect(isValidEmployeePinShape("9999\n1234")).toBe(false);
    expect(isValidEmployeePinShape("1234\n")).toBe(false);
  });

  it("rejects non-strings", () => {
    for (const pin of [1234, null, undefined, {}, ["1234"], true]) {
      expect(isValidEmployeePinShape(pin)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Operator-facing copy
// ---------------------------------------------------------------------------

describe("failure messages", () => {
  const CODES: EmployeeLoginErrorCode[] = [
    "not_authenticated",
    "not_paired",
    "invalid_credentials",
    "locked_out",
    "offline",
    "unavailable",
  ];

  it("has a message for every code", () => {
    for (const code of CODES) {
      expect(getEmployeeLoginErrorMessage(code).length).toBeGreaterThan(0);
    }
  });

  it("uses no server jargon anywhere", () => {
    for (const code of CODES) {
      const message = getEmployeeLoginErrorMessage(code).toLowerCase();

      for (const jargon of [
        "rpc",
        "sql",
        "postgres",
        "pgrst",
        "employee_login",
        "auth.uid",
        "bcrypt",
        "hash",
        "token",
        "jwt",
        "null",
        "undefined",
        "row",
      ]) {
        expect(message).not.toContain(jargon);
      }
    }
  });

  it("never names an employee or reveals why a credential failed", () => {
    const message = getEmployeeLoginErrorMessage("invalid_credentials").toLowerCase();

    for (const leak of ["inactive", "disabled", "deactivated", "not found", "no such", "expired"]) {
      expect(message).not.toContain(leak);
    }
  });

  it("folds the wait into the lockout message when one is known", () => {
    expect(getEmployeeLoginErrorMessage("locked_out", 30)).toContain("30 seconds");
    expect(getEmployeeLoginErrorMessage("locked_out", 900)).toContain("15 minutes");
  });

  it("falls back to the plain lockout message when no wait is known", () => {
    expect(getEmployeeLoginErrorMessage("locked_out")).toBe(
      "Too many incorrect PINs. Try again shortly."
    );
    expect(getEmployeeLoginErrorMessage("locked_out", null)).toBe(
      "Too many incorrect PINs. Try again shortly."
    );
  });

  it("ignores a retry hint on codes that are not lockouts", () => {
    expect(getEmployeeLoginErrorMessage("invalid_credentials", 30)).toBe(
      "That PIN was not recognised."
    );
  });
});

describe("formatRetryWait", () => {
  it("rounds up, so the message never expires before the lock does", () => {
    expect(formatRetryWait(0.4)).toBe("1 second");
    expect(formatRetryWait(29.1)).toBe("30 seconds");
    expect(formatRetryWait(61)).toBe("2 minutes");
    expect(formatRetryWait(60)).toBe("1 minute");
  });

  it("singularizes correctly", () => {
    expect(formatRetryWait(1)).toBe("1 second");
    expect(formatRetryWait(2)).toBe("2 seconds");
  });

  it("degrades to a vague wait rather than nonsense", () => {
    for (const value of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatRetryWait(value)).toBe("a moment");
    }
  });
});

// ---------------------------------------------------------------------------
// Login payloads
// ---------------------------------------------------------------------------

describe("parseEmployeeLoginResult", () => {
  it("reads a complete success payload", () => {
    const result = parseEmployeeLoginResult(SUCCESS);

    expect(result).toEqual({
      ok: true,
      session: {
        employeeSessionId: SUCCESS.employeeSessionId,
        employeeId: SUCCESS.employeeId,
        displayName: "Sam",
        role: "cashier",
        startedAt: SUCCESS.startedAt,
      },
    });
  });

  it("never surfaces an unexpected field from the payload", () => {
    const result = parseEmployeeLoginResult({
      ...SUCCESS,
      pin_hash: "$2a$10$leaked",
      failed_count: 3,
      owner_id: "33333333-3333-3333-3333-333333333333",
    });

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(Object.keys(result.session).sort()).toEqual([
        "displayName",
        "employeeId",
        "employeeSessionId",
        "role",
        "startedAt",
      ]);
    }
  });

  it("maps each server failure code through unchanged", () => {
    for (const code of ["not_authenticated", "not_paired", "invalid_credentials"] as const) {
      const result = parseEmployeeLoginResult({ ok: false, error: code });

      expect(result).toEqual({
        ok: false,
        error: code,
        message: getEmployeeLoginErrorMessage(code),
      });
    }
  });

  it("carries the retry wait on a lockout, rounded up", () => {
    const result = parseEmployeeLoginResult({
      ok: false,
      error: "locked_out",
      retryAfterSeconds: 29.2,
    });

    expect(result).toEqual({
      ok: false,
      error: "locked_out",
      retryAfterSeconds: 30,
      message: "Too many incorrect PINs. Try again in 30 seconds.",
    });
  });

  it("tolerates a lockout with no usable wait", () => {
    for (const bad of [undefined, null, "30", Number.NaN, -1]) {
      const result = parseEmployeeLoginResult({
        ok: false,
        error: "locked_out",
        retryAfterSeconds: bad,
      });

      expect(result).toEqual({
        ok: false,
        error: "locked_out",
        message: "Too many incorrect PINs. Try again shortly.",
      });
    }
  });

  it("collapses an unrecognised error code to unavailable, not to a bad PIN", () => {
    // "The server said something we could not read" is not "the PIN is wrong".
    const result = parseEmployeeLoginResult({ ok: false, error: "employee_is_inactive" });

    expect(result).toEqual({
      ok: false,
      error: "unavailable",
      message: getEmployeeLoginErrorMessage("unavailable"),
    });
  });

  it("refuses an incomplete success rather than inventing a field", () => {
    for (const missing of [
      "employeeSessionId",
      "employeeId",
      "displayName",
      "role",
      "startedAt",
    ] as const) {
      const payload: Record<string, unknown> = { ...SUCCESS };
      delete payload[missing];

      expect(parseEmployeeLoginResult(payload)).toEqual({
        ok: false,
        error: "unavailable",
        message: getEmployeeLoginErrorMessage("unavailable"),
      });
    }
  });

  it("refuses a success carrying a role outside the closed set", () => {
    const result = parseEmployeeLoginResult({ ...SUCCESS, role: "admin" });

    expect(result.ok).toBe(false);
  });

  it("refuses blank strings, which are not identities", () => {
    expect(parseEmployeeLoginResult({ ...SUCCESS, displayName: "   " }).ok).toBe(false);
    expect(parseEmployeeLoginResult({ ...SUCCESS, employeeId: "" }).ok).toBe(false);
  });

  it("never throws, whatever it is handed", () => {
    for (const payload of [null, undefined, 0, "ok", [], [SUCCESS], true, Number.NaN]) {
      expect(() => parseEmployeeLoginResult(payload)).not.toThrow();
      expect(parseEmployeeLoginResult(payload).ok).toBe(false);
    }
  });

  it("treats a truthy-but-not-true ok as a failure", () => {
    expect(parseEmployeeLoginResult({ ...SUCCESS, ok: "true" }).ok).toBe(false);
    expect(parseEmployeeLoginResult({ ...SUCCESS, ok: 1 }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Current session payloads
// ---------------------------------------------------------------------------

describe("parseCurrentEmployeeSessionResult", () => {
  it("reads a signed-in session", () => {
    const result = parseCurrentEmployeeSessionResult({
      ok: true,
      session: {
        employeeSessionId: SUCCESS.employeeSessionId,
        employeeId: SUCCESS.employeeId,
        displayName: "Ada",
        role: "manager",
        startedAt: SUCCESS.startedAt,
      },
    });

    expect(result).toEqual({
      ok: true,
      session: {
        employeeSessionId: SUCCESS.employeeSessionId,
        employeeId: SUCCESS.employeeId,
        displayName: "Ada",
        role: "manager",
        startedAt: SUCCESS.startedAt,
      },
    });
  });

  it("treats nobody-signed-in as a successful answer", () => {
    expect(parseCurrentEmployeeSessionResult({ ok: true, session: null })).toEqual({
      ok: true,
      session: null,
    });
    expect(parseCurrentEmployeeSessionResult({ ok: true })).toEqual({ ok: true, session: null });
  });

  it("separates 'nobody is signed in' from 'we could not read the answer'", () => {
    const unreadable = parseCurrentEmployeeSessionResult({ ok: true, session: { role: "cashier" } });

    expect(unreadable).toEqual({
      ok: false,
      error: "unavailable",
      message: getEmployeeLoginErrorMessage("unavailable"),
    });
  });

  it("maps not_paired through, so a revoked till can act on it", () => {
    expect(parseCurrentEmployeeSessionResult({ ok: false, error: "not_paired" })).toEqual({
      ok: false,
      error: "not_paired",
      message: getEmployeeLoginErrorMessage("not_paired"),
    });
  });

  it("never throws", () => {
    for (const payload of [null, undefined, "", [], 7]) {
      expect(() => parseCurrentEmployeeSessionResult(payload)).not.toThrow();
      expect(parseCurrentEmployeeSessionResult(payload).ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Logout payloads
// ---------------------------------------------------------------------------

describe("parseEmployeeLogoutResult", () => {
  it("reports the session it closed", () => {
    expect(parseEmployeeLogoutResult({ ok: true, endedSessionId: SUCCESS.employeeSessionId })).toEqual(
      { ok: true, endedSessionId: SUCCESS.employeeSessionId }
    );
  });

  it("succeeds with null when nobody was signed in", () => {
    // Idempotence: a client that never saw the first reply may retry.
    expect(parseEmployeeLogoutResult({ ok: true, endedSessionId: null })).toEqual({
      ok: true,
      endedSessionId: null,
    });
    expect(parseEmployeeLogoutResult({ ok: true })).toEqual({ ok: true, endedSessionId: null });
  });

  it("maps failures through the shared table", () => {
    expect(parseEmployeeLogoutResult({ ok: false, error: "not_authenticated" })).toEqual({
      ok: false,
      error: "not_authenticated",
      message: getEmployeeLoginErrorMessage("not_authenticated"),
    });
  });

  it("never throws", () => {
    for (const payload of [null, undefined, 0, "done", []]) {
      expect(() => parseEmployeeLogoutResult(payload)).not.toThrow();
      expect(parseEmployeeLogoutResult(payload).ok).toBe(false);
    }
  });
});
