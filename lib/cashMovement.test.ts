// v1.3 Feature 1D — cash movement parsing, money rules and note rules.
//
// WHY THIS IS FUSSY ABOUT MONEY. These rows are the source records a drawer
// count will one day be reconciled against. An amount that is off by a cent
// because it went through a float, or a 12.345 quietly rounded to 12.35, is
// worse than a rejected entry: it looks like a figure somebody typed.
//
// AND FUSSY ABOUT WHAT A SUCCESS IS. The employee is about to be told their
// movement was recorded, and shown an amount. Both had better be true, so a
// reply this module cannot read exactly is a failure and not a half-built
// success.
//
// IT IS ALSO A PIN DOOR. An unknown Employee ID, a wrong PIN and a deactivated
// employee must be indistinguishable, and a refusal on ROLE must name no role —
// otherwise an unattended till answers "who works here, and what are they?".
import { describe, expect, it } from "vitest";
import {
  CASH_MOVEMENT_NOTE_MAX_LENGTH,
  CASH_MOVEMENT_TYPES,
  cashMovementFailure,
  describeCashMovementSuccess,
  getCashAmountMessage,
  getCashMovementLabel,
  getCashMovementMessage,
  getCashNoteMessage,
  isCashMovementNoteRequired,
  MAX_CASH_MOVEMENT_AMOUNT,
  parseCashMovementResult,
  validateCashAmount,
  validateCashNote,
} from "@/lib/cashMovement";
import type { CashMovementErrorCode, CashMovementType } from "@/lib/cashMovement";
import { formatMoney } from "@/lib/money";

const MOVEMENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AT = "2026-09-27T19:31:13.714565+00:00";

const success = (over: Record<string, unknown> = {}) => ({
  ok: true,
  movementId: MOVEMENT,
  movementType: "cash_drop",
  amount: "25.00",
  note: null,
  employeeName: "Amy",
  occurredAt: AT,
  replayed: false,
  ...over,
});

// ---------------------------------------------------------------------------
// The three kinds
// ---------------------------------------------------------------------------

describe("there are exactly three kinds of movement", () => {
  it("names them the way the server stores them", () => {
    expect([...CASH_MOVEMENT_TYPES]).toEqual(["cash_drop", "paid_in", "paid_out"]);
  });

  // A drop and a paid-out both shrink the drawer and are still not one event:
  // one is banked, the other is spent. Merging them would make a later count
  // unable to say which.
  it("labels each one, and does not treat a safe drop as a fourth kind", () => {
    expect(getCashMovementLabel("cash_drop")).toBe("Cash Drop");
    expect(getCashMovementLabel("paid_in")).toBe("Paid In");
    expect(getCashMovementLabel("paid_out")).toBe("Paid Out");
    expect(CASH_MOVEMENT_TYPES).toHaveLength(3);
  });

  it("requires a reason for money in or out, and not for a drop", () => {
    expect(isCashMovementNoteRequired("cash_drop")).toBe(false);
    expect(isCashMovementNoteRequired("paid_in")).toBe(true);
    expect(isCashMovementNoteRequired("paid_out")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The amount
// ---------------------------------------------------------------------------

describe("the amount is read from the digits, never through a float", () => {
  it("accepts whole and two-decimal amounts, canonicalised", () => {
    for (const [typed, canonical] of [
      ["25", "25.00"],
      ["25.5", "25.50"],
      ["25.50", "25.50"],
      ["0.01", "0.01"],
      ["  12.34  ", "12.34"],
      ["1.10", "1.10"],
      [MAX_CASH_MOVEMENT_AMOUNT, "9999999999.99"],
    ] as const) {
      const result = validateCashAmount(typed);

      expect(result.ok).toBe(true);
      expect(result.ok && result.canonical).toBe(canonical);
    }
  });

  // THE POINT OF CARRYING Money RATHER THAN A NUMBER. 1.10 must stay 1.10, and
  // 0.1 + 0.2 must not be able to happen here at all.
  it("carries the exact value in this codebase's money representation", () => {
    const result = validateCashAmount("1.10");

    expect(result.ok).toBe(true);
    expect(result.ok && formatMoney(result.amount)).toBe("1.10");
    expect(result.ok && typeof result.amount).toBe("bigint");
  });

  // NEGATIVE CONTROL: rounding a third decimal would put a figure in the books
  // that nobody typed. The server refuses it too, rather than letting
  // numeric(12,2) round on assignment.
  it("refuses over-precision instead of rounding it", () => {
    for (const typed of ["12.345", "0.001", "1.999"]) {
      expect(validateCashAmount(typed)).toEqual({ ok: false, problem: "too_precise" });
    }
  });

  // Direction lives in the movement kind, so a negative is not a movement the
  // other way — it is a mistake, or a reversal expressed as arithmetic, and
  // Feature 1D has no reversal.
  it("refuses zero and anything negative", () => {
    expect(validateCashAmount("0")).toEqual({ ok: false, problem: "not_positive" });
    expect(validateCashAmount("0.00")).toEqual({ ok: false, problem: "not_positive" });
    expect(validateCashAmount("-5.00")).toEqual({ ok: false, problem: "not_a_number" });
    expect(validateCashAmount("-0.00")).toEqual({ ok: false, problem: "not_a_number" });
  });

  it("refuses everything that is not a plain decimal", () => {
    for (const typed of [
      "", "   ", "abc", "1e3", "1E3", "+5", "1,000", "$5", "10.", ".5", "1 2", "Infinity", "NaN",
    ]) {
      const result = validateCashAmount(typed);

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.problem).toBe(typed.trim() === "" ? "empty" : "not_a_number");
    }
  });

  it("refuses more than numeric(12,2) can hold", () => {
    expect(validateCashAmount("10000000000.00")).toEqual({ ok: false, problem: "too_large" });
    expect(validateCashAmount("9999999999.99").ok).toBe(true);
  });

  it("says something useful for every amount problem", () => {
    for (const problem of ["empty", "not_a_number", "too_precise", "not_positive", "too_large"] as const) {
      expect(getCashAmountMessage(problem).trim()).not.toBe("");
      expect(getCashAmountMessage(problem)).not.toMatch(/numeric|rpc|trunc|bigint|null/i);
    }
  });
});

// ---------------------------------------------------------------------------
// The note
// ---------------------------------------------------------------------------

describe("the reason", () => {
  it("is trimmed, and blank means NULL on a drop", () => {
    expect(validateCashNote("  to the safe  ", "cash_drop")).toEqual({
      ok: true,
      note: "to the safe",
    });
    expect(validateCashNote("", "cash_drop")).toEqual({ ok: true, note: null });
    expect(validateCashNote("     ", "cash_drop")).toEqual({ ok: true, note: null });
  });

  it("is required for money moving in or out", () => {
    for (const type of ["paid_in", "paid_out"] as const) {
      expect(validateCashNote("", type)).toEqual({ ok: false, problem: "required" });
      expect(validateCashNote("   ", type)).toEqual({ ok: false, problem: "required" });
      expect(validateCashNote(" milk ", type)).toEqual({ ok: true, note: "milk" });
    }
  });

  // NEGATIVE CONTROL, AND THE WHOLE POINT. A silently shortened reason is a
  // different reason, and the clause that gets cut is the one that explained the
  // money. So the limit refuses; it never truncates.
  it("refuses an over-length reason rather than truncating it", () => {
    const at = "x".repeat(CASH_MOVEMENT_NOTE_MAX_LENGTH);
    const over = "x".repeat(CASH_MOVEMENT_NOTE_MAX_LENGTH + 1);

    expect(validateCashNote(at, "paid_out")).toEqual({ ok: true, note: at });
    expect(validateCashNote(over, "paid_out")).toEqual({ ok: false, problem: "too_long" });
    expect(validateCashNote(over, "cash_drop")).toEqual({ ok: false, problem: "too_long" });

    // Nothing shortened anywhere: the accepted note is the whole note.
    expect((validateCashNote(at, "paid_out") as { note: string }).note).toHaveLength(200);
  });

  // Trailing whitespace is not content, so a 200-character reason typed with a
  // stray space still fits.
  it("measures the trimmed reason, not the keystrokes", () => {
    const padded = `  ${"x".repeat(CASH_MOVEMENT_NOTE_MAX_LENGTH)}  `;

    expect(validateCashNote(padded, "paid_in").ok).toBe(true);
  });

  it("says something useful for every note problem", () => {
    for (const problem of ["required", "too_long"] as const) {
      expect(getCashNoteMessage(problem).trim()).not.toBe("");
    }

    expect(getCashNoteMessage("too_long")).toContain("200");
  });
});

// ---------------------------------------------------------------------------
// The server's answer
// ---------------------------------------------------------------------------

describe("a recorded movement", () => {
  it("is read back exactly as the server rendered it", () => {
    expect(parseCashMovementResult(success())).toEqual({
      ok: true,
      movementId: MOVEMENT,
      movementType: "cash_drop",
      amount: "25.00",
      note: null,
      employeeName: "Amy",
      occurredAt: AT,
      replayed: false,
    });
  });

  it("carries a note and a replay flag through", () => {
    const result = parseCashMovementResult(
      success({ movementType: "paid_out", note: "milk", replayed: true, amount: "3.50" })
    );

    expect(result).toMatchObject({
      movementType: "paid_out",
      note: "milk",
      amount: "3.50",
      replayed: true,
    });
  });

  // NEGATIVE CONTROL. The employee is about to be told this was recorded, so a
  // reply missing any part of what it claims is not a success we may report.
  it("refuses an ok payload that is missing what it claims", () => {
    for (const missing of ["movementId", "movementType", "amount", "employeeName", "occurredAt"]) {
      const payload: Record<string, unknown> = success();
      delete payload[missing];

      expect(parseCashMovementResult(payload).ok).toBe(false);
      expect(parseCashMovementResult({ ...success(), [missing]: "" }).ok).toBe(false);
    }
  });

  it("refuses a movement kind it does not know", () => {
    expect(parseCashMovementResult(success({ movementType: "safe_drop" })).ok).toBe(false);
    expect(parseCashMovementResult(success({ movementType: "cash_pickup" })).ok).toBe(false);
  });

  // NEGATIVE CONTROL ON THE MONEY. An amount that does not read as stored
  // money — a bare integer, a third decimal, a float that lost its identity —
  // must never reach a confirmation screen as if it were exact.
  it("refuses an amount that is not exact stored money", () => {
    for (const amount of ["25", "25.0", "25.000", "2.5e1", "abc", "-25.00 ", "NaN"]) {
      expect(parseCashMovementResult(success({ amount })).ok).toBe(false);
    }
  });

  it("never throws, whatever it is handed", () => {
    for (const payload of [null, undefined, 0, "done", [], true, { ok: "yes" }]) {
      expect(() => parseCashMovementResult(payload)).not.toThrow();
      expect(parseCashMovementResult(payload).ok).toBe(false);
    }
  });
});

describe("refusals", () => {
  const CODES: CashMovementErrorCode[] = [
    "not_authenticated",
    "not_paired",
    "invalid_credentials",
    "locked_out",
    "not_permitted",
    "invalid_amount",
    "note_required",
    "invalid_note",
    "invalid_request",
    "no_daily_context",
    "daily_changed",
    "business_timezone_required",
    "request_required",
    "request_conflict",
    "offline",
    "unavailable",
  ];

  it("carries every code the server can send", () => {
    for (const code of CODES) {
      expect(parseCashMovementResult({ ok: false, error: code })).toMatchObject({
        ok: false,
        error: code,
      });
    }
  });

  it("maps an unrecognised error to unavailable rather than trusting it", () => {
    expect(parseCashMovementResult({ ok: false, error: "kaboom" })).toMatchObject({
      error: "unavailable",
    });
  });

  it("carries a lockout's retry wait", () => {
    const result = parseCashMovementResult({ ok: false, error: "locked_out", retryAfterSeconds: 90 });

    expect(result).toMatchObject({ error: "locked_out", retryAfterSeconds: 90 });
    expect(result.ok === false && result.message).toContain("2 minutes");
  });

  it("says something for every code, without jargon", () => {
    for (const code of CODES) {
      const message = getCashMovementMessage(code);

      expect(message.trim()).not.toBe("");
      expect(message).not.toMatch(/rpc|sql|uuid|numeric|null|register_session|bcrypt|trunc/i);
    }
  });

  // NEGATIVE CONTROL: the one answer that must stay generic. If this ever
  // distinguishes a bad PIN from an unknown ID, the panel becomes a directory.
  it("gives one indistinguishable answer for every credential problem", () => {
    const message = getCashMovementMessage("invalid_credentials");

    expect(message).not.toMatch(/not found|no such|unknown employee|wrong pin|inactive|deactivat/i);
    expect(message).toBe("That Employee ID or PIN was not recognised.");
  });

  // NEGATIVE CONTROL: a role refusal must not name the role, or an unattended
  // till answers "what is 004 allowed to do?" to anybody with a valid PIN.
  it("refuses on role without naming a role or a requirement", () => {
    const message = getCashMovementMessage("not_permitted");

    expect(message.trim()).not.toBe("");
    expect(message).not.toMatch(/owner|manager|cashier|role|permission|privilege|ask a/i);
  });

  // NEGATIVE CONTROL: a replay conflict must reveal nothing about whose record
  // it collided with, or a request id becomes a way to read somebody's cash.
  it("says nothing at all about whose movement a conflict hit", () => {
    const result = parseCashMovementResult({ ok: false, error: "request_conflict" });

    expect(result.ok === false && result.message).toBe("Please try again.");
    expect(result.ok === false && result.message).not.toMatch(
      /employee|another|already|someone|amount|recorded/i
    );
  });

  // Offline is a refusal, and the copy must say so rather than implying the
  // movement is waiting somewhere to be sent.
  it("tells an offline till the movement did not happen", () => {
    const message = getCashMovementMessage("offline");

    expect(message).toMatch(/connection/i);
    expect(message).not.toMatch(/later|queued|saved|will send|pending|retry/i);
  });

  // The one refusal with real guidance: there is no business day yet, and a cash
  // movement may not start one — so it says what does.
  it("tells a till with no business day how to get one", () => {
    const message = getCashMovementMessage("no_daily_context");

    expect(message).toMatch(/sign in/i);
    expect(message).not.toMatch(/queued|saved|later/i);
  });
});

describe("what the panel says", () => {
  it("describes a success by what happened, with the server's figure", () => {
    for (const type of CASH_MOVEMENT_TYPES) {
      const described = describeCashMovementSuccess(
        parseCashMovementResult(success({ movementType: type, amount: "3.50" }))
      );

      expect(described).toContain(getCashMovementLabel(type as CashMovementType));
      expect(described).toContain("3.50");
    }
  });

  // NEGATIVE CONTROL ON THE FINANCIAL BOUNDARY. A confirmation that mentioned
  // what the drawer now holds would be arithmetic over a starting figure nobody
  // ever counted.
  it("never mentions a drawer total, an expectation or a variance", () => {
    const messages = [
      describeCashMovementSuccess(parseCashMovementResult(success())),
      ...(["not_permitted", "no_daily_context", "daily_changed"] as const).map((code) =>
        getCashMovementMessage(code)
      ),
    ];

    for (const message of messages) {
      expect(message).not.toMatch(
        /expected|drawer (should|now|holds|contains)|remaining|balance|variance|over\/short|total in/i
      );
    }
  });

  it("passes a failure's own message through", () => {
    expect(describeCashMovementSuccess(cashMovementFailure("offline"))).toBe(
      getCashMovementMessage("offline")
    );
  });
});
