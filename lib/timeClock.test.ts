// v1.3 Feature 1C — Time Clock parsing and shape rules.
//
// WHAT THE TIME CLOCK IS FOR, AND WHY IT IS FUSSY. These records become
// somebody's pay. A punch that appears without a person making it, or a time
// that came from a till's own clock, is worse than a missing one: it looks
// true. So the parser refuses anything it cannot read rather than producing a
// half-built success, and there is no field anywhere through which a client
// could supply an instant.
//
// IT IS ALSO A PIN DOOR. An unknown Employee ID, a wrong PIN and a deactivated
// employee must be indistinguishable, or the Time Clock becomes a way to find
// out who works here — a weaker door beside the hardened one the POS login
// already uses.
import { describe, expect, it } from "vitest";
import {
  describeTimeClockSuccess,
  getTimeClockMessage,
  isValidTimeClockCode,
  isValidTimeClockPin,
  parseTimeClockResult,
  timeClockFailure,
} from "@/lib/timeClock";
import type { TimeClockErrorCode } from "@/lib/timeClock";

const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IN_AT = "2026-09-27T09:02:11.120Z";
const OUT_AT = "2026-09-27T17:31:04.880Z";

describe("credential shapes are checked before a PIN is sent anywhere", () => {
  it("accepts a three-digit Employee ID that is not 000", () => {
    expect(isValidTimeClockCode("001")).toBe(true);
    expect(isValidTimeClockCode("742")).toBe(true);
  });

  it("rejects 000, wrong lengths and non-digits", () => {
    for (const bad of ["000", "", "1", "12", "1234", "00a", " 01", "abc", null, 12]) {
      expect(isValidTimeClockCode(bad)).toBe(false);
    }
  });

  it("accepts exactly four digits as a PIN", () => {
    expect(isValidTimeClockPin("0000")).toBe(true);
    expect(isValidTimeClockPin("9183")).toBe(true);
  });

  it("rejects any other PIN shape", () => {
    for (const bad of ["", "123", "12345", "12a4", null, 1234]) {
      expect(isValidTimeClockPin(bad)).toBe(false);
    }
  });
});

describe("a successful punch", () => {
  it("reads a clock in", () => {
    expect(
      parseTimeClockResult({
        ok: true,
        outcome: "clocked_in",
        timeSessionId: SESSION,
        clockedInAt: IN_AT,
        replayed: false,
      })
    ).toEqual({
      ok: true,
      outcome: "clocked_in",
      timeSessionId: SESSION,
      clockedInAt: IN_AT,
      clockedOutAt: null,
      replayed: false,
    });
  });

  it("reads a clock out, carrying both instants", () => {
    const result = parseTimeClockResult({
      ok: true,
      outcome: "clocked_out",
      timeSessionId: SESSION,
      clockedInAt: IN_AT,
      clockedOutAt: OUT_AT,
      replayed: false,
    });

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ clockedInAt: IN_AT, clockedOutAt: OUT_AT });
  });

  it("marks a replayed answer as such", () => {
    const result = parseTimeClockResult({
      ok: true,
      outcome: "clocked_in",
      timeSessionId: SESSION,
      clockedInAt: IN_AT,
      replayed: true,
    });

    expect(result.ok && result.replayed).toBe(true);
  });

  // NEGATIVE CONTROL. The employee is about to be told they are clocked in, so
  // that had better be true: a reply missing the session id or the instant is
  // not a success we may report.
  it("refuses an ok payload that is missing what it claims", () => {
    for (const payload of [
      { ok: true, outcome: "clocked_in", clockedInAt: IN_AT },
      { ok: true, outcome: "clocked_in", timeSessionId: SESSION },
      { ok: true, outcome: "clocked_in", timeSessionId: "", clockedInAt: IN_AT },
      { ok: true, outcome: "finished", timeSessionId: SESSION, clockedInAt: IN_AT },
      { ok: true },
    ]) {
      expect(parseTimeClockResult(payload).ok).toBe(false);
    }
  });

  // NEGATIVE CONTROL: a close with no end instant is not a close.
  it("refuses a clock out with no clockedOutAt", () => {
    expect(
      parseTimeClockResult({
        ok: true,
        outcome: "clocked_out",
        timeSessionId: SESSION,
        clockedInAt: IN_AT,
      }).ok
    ).toBe(false);
  });
});

describe("refusals", () => {
  it("carries the server's state conflicts through", () => {
    const already = parseTimeClockResult({
      ok: false,
      error: "already_clocked_in",
      clockedInAt: IN_AT,
    });

    expect(already).toMatchObject({ ok: false, error: "already_clocked_in", clockedInAt: IN_AT });
    expect(parseTimeClockResult({ ok: false, error: "not_clocked_in" })).toMatchObject({
      ok: false,
      error: "not_clocked_in",
    });
  });

  it("carries a lockout's retry wait", () => {
    const result = parseTimeClockResult({
      ok: false,
      error: "locked_out",
      retryAfterSeconds: 90,
    });

    expect(result).toMatchObject({ ok: false, error: "locked_out", retryAfterSeconds: 90 });
    expect(result.ok === false && result.message).toContain("2 minutes");
  });

  it("maps an unrecognised error to unavailable rather than trusting it", () => {
    expect(parseTimeClockResult({ ok: false, error: "kaboom" })).toMatchObject({
      error: "unavailable",
    });
  });

  it("never throws", () => {
    for (const payload of [null, undefined, 0, "done", [], true]) {
      expect(() => parseTimeClockResult(payload)).not.toThrow();
      expect(parseTimeClockResult(payload).ok).toBe(false);
    }
  });
});

describe("the messages an employee reads", () => {
  const CODES: TimeClockErrorCode[] = [
    "not_authenticated",
    "not_paired",
    "invalid_credentials",
    "locked_out",
    "already_clocked_in",
    "not_clocked_in",
    "request_required",
    "offline",
    "unavailable",
  ];

  it("say something for every code, without jargon", () => {
    for (const code of CODES) {
      const message = getTimeClockMessage(code);

      expect(message.trim()).not.toBe("");
      expect(message).not.toMatch(/rpc|sql|uuid|null|session_id|token|bcrypt|hash/i);
    }
  });

  // NEGATIVE CONTROL: the one answer that must stay generic. If this message
  // ever distinguishes a bad PIN from an unknown ID, the Time Clock becomes a
  // staff directory.
  it("give one indistinguishable answer for every credential problem", () => {
    const message = getTimeClockMessage("invalid_credentials");

    expect(message).not.toMatch(/not found|no such|unknown employee|wrong pin|inactive|deactivat/i);
    expect(message).toBe("That Employee ID or PIN was not recognised.");
  });

  it("describe a success by what happened", () => {
    expect(
      describeTimeClockSuccess({
        ok: true,
        outcome: "clocked_in",
        timeSessionId: SESSION,
        clockedInAt: IN_AT,
        clockedOutAt: null,
        replayed: false,
      })
    ).toBe("Clocked in.");

    expect(
      describeTimeClockSuccess({
        ok: true,
        outcome: "clocked_out",
        timeSessionId: SESSION,
        clockedInAt: IN_AT,
        clockedOutAt: OUT_AT,
        replayed: false,
      })
    ).toBe("Clocked out.");
  });

  it("passes a failure's own message through", () => {
    expect(describeTimeClockSuccess(timeClockFailure("offline"))).toBe(
      getTimeClockMessage("offline")
    );
  });

  // Offline is a refusal, and the copy has to say so rather than implying the
  // punch is waiting somewhere.
  it("tells an offline employee the punch did not happen", () => {
    const message = getTimeClockMessage("offline");

    expect(message).toMatch(/connection/i);
    expect(message).not.toMatch(/later|queued|saved|will send|pending/i);
  });
});
