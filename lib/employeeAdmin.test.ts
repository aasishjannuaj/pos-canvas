// v1.3 Task 5B — the owner employee-administration model, and what this client
// is willing to believe the server said.
//
// PURE THROUGHOUT. Nothing here mocks Supabase: the interesting claims are
// about a MODEL and about PARSING. The wrappers themselves are four lines each
// (build arguments, call, hand the body to a parser), and the parsers are where
// a wrong answer would actually reach an owner — a roster row with a guessed
// id, a refusal shown as a success, or a PIN field materialising out of a
// payload that has none.
//
// WHAT IS DELIBERATELY NOT RE-TESTED HERE. Whether a three-digit Employee ID is
// free, whether a PIN is correct, and whether a reactivation is safe are the
// database's decisions, proven by
// supabase/migrations/20260919120000_employee_code_and_four_digit_pin.db.test.ts.
// Restating them here would create a second, weaker copy free to drift.
import { describe, expect, it } from "vitest";
import {
  DEACTIVATION_CONSEQUENCES,
  EMPLOYEE_ADMIN_LIMITS,
  EMPLOYEE_CODE_SHAPE_MESSAGE,
  EMPLOYEE_CODE_UNASSIGNED_LABEL,
  EMPLOYEE_CODE_TAKEN_MESSAGE,
  EMPLOYEE_NAME_REQUIRED_MESSAGE,
  EMPLOYEE_PIN_SHAPE_MESSAGE,
  REACTIVATION_NOTICE,
  describeEmployeeCode,
  describeEmployeeStatus,
  emptyEmployeeDraft,
  findEmployeeDraftProblem,
  groupEmployeesByStatus,
} from "@/lib/employeeAdmin";
import {
  CREATE_EMPLOYEE_MESSAGES,
  LIST_EMPLOYEES_MESSAGES,
  SET_EMPLOYEE_ACTIVE_MESSAGES,
  SET_EMPLOYEE_CODE_MESSAGES,
  SET_EMPLOYEE_PIN_MESSAGES,
  parseCreateEmployeeResult,
  parseListEmployeesResult,
  parseSetEmployeeActiveResult,
  parseSetEmployeeCodeResult,
  parseSetEmployeePinResult,
} from "@/lib/employeeAdmin.rpc";

const ADA = {
  employeeId: "11111111-1111-4111-8111-111111111111",
  displayName: "Ada",
  role: "cashier",
  active: true,
  createdAt: "2026-09-01T10:00:00Z",
  deactivatedAt: null,
  employeeCode: "001",
};

const BO = {
  employeeId: "22222222-2222-4222-8222-222222222222",
  displayName: "Bo",
  role: "manager",
  active: false,
  createdAt: "2026-09-02T10:00:00Z",
  deactivatedAt: "2026-09-20T17:00:00Z",
  // A leaver from before Employee IDs existed: legitimately uncoded.
  employeeCode: null,
};

// ---------------------------------------------------------------------------
// The roster, as read from the server
// ---------------------------------------------------------------------------

describe("reading the employee list", () => {
  it("returns every readable employee, in the order the server sent them", () => {
    const result = parseListEmployeesResult({ ok: true, employees: [ADA, BO] });

    expect(result).toEqual({
      ok: true,
      employees: [
        {
          employeeId: ADA.employeeId,
          displayName: "Ada",
          role: "cashier",
          active: true,
          createdAt: ADA.createdAt,
          deactivatedAt: null,
          employeeCode: "001",
        },
        {
          employeeId: BO.employeeId,
          displayName: "Bo",
          role: "manager",
          active: false,
          createdAt: BO.createdAt,
          deactivatedAt: BO.deactivatedAt,
          employeeCode: null,
        },
      ],
    });
  });

  it("treats a project with nobody in it as a real answer, not a failure", () => {
    // The distinction an owner depends on: "nobody yet, add the first one" is
    // not the same screen as "we could not find out".
    const result = parseListEmployeesResult({ ok: true, employees: [] });

    expect(result).toEqual({ ok: true, employees: [] });
  });

  it("carries no PIN material, because the contract projects none", () => {
    const result = parseListEmployeesResult({
      ok: true,
      // Even if a payload arrived carrying these, they are not in the shape and
      // cannot survive the parse into anything a screen could render.
      employees: [{ ...ADA, pin: "1234", pinHash: "$2a$10$abc", pin_hash: "x" }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Object.keys(result.employees[0]).sort()).toEqual([
      "active",
      "createdAt",
      "deactivatedAt",
      "displayName",
      "employeeCode",
      "employeeId",
      "role",
    ]);
    expect(JSON.stringify(result.employees)).not.toContain("1234");
    expect(JSON.stringify(result.employees).toLowerCase()).not.toContain("pin");
  });

  it("drops a row it cannot read rather than guessing at it", () => {
    // A row with no id, or a role this client does not know, would become a
    // button that sends a PIN change to nobody in particular.
    const result = parseListEmployeesResult({
      ok: true,
      employees: [ADA, { ...BO, employeeId: "" }, { ...BO, role: "superuser" }, null, "x"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.employees).toHaveLength(1);
    expect(result.employees[0].employeeId).toBe(ADA.employeeId);
  });

  it("reports the server's two refusals, and nothing else as either", () => {
    expect(parseListEmployeesResult({ ok: false, error: "not_authenticated" })).toEqual({
      ok: false,
      code: "not_authenticated",
    });
    expect(parseListEmployeesResult({ ok: false, error: "not_found" })).toEqual({
      ok: false,
      code: "not_found",
    });

    // Anything else is "we do not know", never a specific accusation.
    for (const payload of [
      { ok: false, error: "kaboom" },
      { ok: false },
      { ok: true },
      { ok: true, employees: "not-an-array" },
      null,
      [],
      "nope",
    ]) {
      expect(`payload ${JSON.stringify(payload)}`).toBe(`payload ${JSON.stringify(payload)}`);
      expect(parseListEmployeesResult(payload)).toEqual({ ok: false, code: "unavailable" });
    }
  });
});

// ---------------------------------------------------------------------------
// Adding somebody
// ---------------------------------------------------------------------------

describe("adding an employee", () => {
  it("reports the Employee ID the server confirmed", () => {
    const result = parseCreateEmployeeResult({
      ok: true,
      employeeId: ADA.employeeId,
      displayName: "Ada",
      role: "cashier",
      employeeCode: "007",
      active: true,
      createdAt: ADA.createdAt,
    });

    expect(result).toEqual({
      ok: true,
      employee: {
        employeeId: ADA.employeeId,
        displayName: "Ada",
        role: "cashier",
        employeeCode: "007",
        active: true,
      },
    });
  });

  it("keeps the leading zero it was given", () => {
    const result = parseCreateEmployeeResult({
      ok: true,
      employeeId: ADA.employeeId,
      displayName: "Ada",
      role: "cashier",
      employeeCode: "001",
      active: true,
    });

    expect(result.ok && result.employee.employeeCode).toBe("001");
  });

  it("maps every refusal the contract can return", () => {
    for (const error of [
      "not_authenticated",
      "not_found",
      "invalid_display_name",
      "invalid_role",
      "invalid_employee_code",
      "invalid_pin",
      "employee_code_taken",
    ]) {
      expect(`create refusal ${error}`).toBe(`create refusal ${error}`);
      expect(parseCreateEmployeeResult({ ok: false, error })).toEqual({
        ok: false,
        code: error,
      });
    }
  });

  it("refuses to call an unreadable success a success", () => {
    // Reporting "added" without a usable id would leave an employee on the till
    // that this screen cannot then give an ID or a PIN to.
    for (const payload of [
      { ok: true, displayName: "Ada", role: "cashier", employeeCode: "007", active: true },
      { ok: true, employeeId: ADA.employeeId, role: "cashier", active: true },
      { ok: true, employeeId: ADA.employeeId, role: "nope", employeeCode: "007", active: true },
    ]) {
      expect(`create success ${JSON.stringify(payload)}`).toBe(
        `create success ${JSON.stringify(payload)}`
      );
      expect(parseCreateEmployeeResult(payload)).toEqual({ ok: false, code: "unavailable" });
    }
  });
});

// ---------------------------------------------------------------------------
// Employee IDs and PINs
// ---------------------------------------------------------------------------

describe("changing an Employee ID", () => {
  it("returns the new ID so the owner can read it back once", () => {
    expect(
      parseSetEmployeeCodeResult({
        ok: true,
        employeeId: ADA.employeeId,
        displayName: "Ada",
        role: "cashier",
        employeeCode: "042",
        active: true,
      })
    ).toEqual({ ok: true, employeeId: ADA.employeeId, employeeCode: "042" });
  });

  it("passes the taken-ID refusal through as itself", () => {
    expect(parseSetEmployeeCodeResult({ ok: false, error: "employee_code_taken" })).toEqual({
      ok: false,
      code: "employee_code_taken",
    });
    expect(parseSetEmployeeCodeResult({ ok: false, error: "invalid_employee_code" })).toEqual({
      ok: false,
      code: "invalid_employee_code",
    });
  });
});

describe("changing a PIN", () => {
  it("succeeds with an employee id and NOTHING else", () => {
    // The whole PIN posture rests on this shape. There is no PIN, no hash and
    // no length in a success, so no screen can display, confirm or re-show one.
    const result = parseSetEmployeePinResult({ ok: true, employeeId: ADA.employeeId });

    expect(result).toEqual({ ok: true, employeeId: ADA.employeeId });
    expect(Object.keys(result)).toEqual(["ok", "employeeId"]);
  });

  it("carries no PIN even when the payload volunteers one", () => {
    const result = parseSetEmployeePinResult({
      ok: true,
      employeeId: ADA.employeeId,
      pin: "4321",
      pinLength: 4,
    });

    expect(JSON.stringify(result)).not.toContain("4321");
    expect(JSON.stringify(result)).not.toContain("pinLength");
  });

  it("reports a malformed PIN as the server's refusal", () => {
    expect(parseSetEmployeePinResult({ ok: false, error: "invalid_pin" })).toEqual({
      ok: false,
      code: "invalid_pin",
    });
    expect(parseSetEmployeePinResult({ ok: false, error: "not_found" })).toEqual({
      ok: false,
      code: "not_found",
    });
  });
});

// ---------------------------------------------------------------------------
// Leaving, and coming back
// ---------------------------------------------------------------------------

describe("deactivating and reactivating", () => {
  it("reports the status the server stored, in both directions", () => {
    expect(
      parseSetEmployeeActiveResult({ ok: true, employeeId: ADA.employeeId, active: false })
    ).toEqual({ ok: true, employeeId: ADA.employeeId, active: false });

    expect(
      parseSetEmployeeActiveResult({ ok: true, employeeId: ADA.employeeId, active: true })
    ).toEqual({ ok: true, employeeId: ADA.employeeId, active: true });
  });

  it("keeps the two reactivation refusals apart", () => {
    // They are fixed the same way but they are not the same fact, and a merged
    // message would tell half of the owners something untrue about their data.
    expect(
      parseSetEmployeeActiveResult({ ok: false, error: "employee_code_taken" })
    ).toEqual({ ok: false, code: "employee_code_taken" });
    expect(
      parseSetEmployeeActiveResult({ ok: false, error: "employee_code_required" })
    ).toEqual({ ok: false, code: "employee_code_required" });

    expect(SET_EMPLOYEE_ACTIVE_MESSAGES.employee_code_taken).not.toBe(
      SET_EMPLOYEE_ACTIVE_MESSAGES.employee_code_required
    );
  });

  it("tells the owner what deactivation does and does not do", () => {
    const sentences = DEACTIVATION_CONSEQUENCES.join(" ");

    // Read off the backend: set_employee_active touches neither session table,
    // and clock_out_employee requires an active employee.
    expect(sentences).toContain("no longer sign in");
    expect(sentences).toMatch(/not closed/i);
    expect(sentences).toMatch(/clock(ed)? (them )?out/i);
    expect(sentences).toMatch(/Employee ID becomes available/i);

    // And it never promises an automatic tidy-up the one authorized call does
    // not perform.
    expect(sentences).not.toMatch(/automatically|signs them out|will be closed|ends their/i);
  });

  it("warns before reactivation that an Employee ID may no longer be free", () => {
    expect(REACTIVATION_NOTICE).toMatch(/refused/i);
    expect(REACTIVATION_NOTICE).toMatch(/Employee ID/);
  });
});

// ---------------------------------------------------------------------------
// The roster, arranged
// ---------------------------------------------------------------------------

describe("arranging the roster", () => {
  it("splits current staff from leavers, keeping the server's order", () => {
    const later = { ...ADA, employeeId: "33333333-3333-4333-8333-333333333333" };
    const roster = groupEmployeesByStatus([ADA, BO, later] as never);

    expect(roster.active.map((e) => e.employeeId)).toEqual([ADA.employeeId, later.employeeId]);
    expect(roster.inactive.map((e) => e.employeeId)).toEqual([BO.employeeId]);
  });

  it("does not hide leavers, who are who the owner came to reactivate", () => {
    const roster = groupEmployeesByStatus([BO] as never);

    expect(roster.active).toEqual([]);
    expect(roster.inactive).toHaveLength(1);
  });

  it("labels each row with the status the server reported", () => {
    expect(describeEmployeeStatus(ADA as never)).toBe("Active");
    expect(describeEmployeeStatus(BO as never)).toBe("Inactive");
  });
});

describe("the Employee ID column reads the list row", () => {
  it("shows the authoritative code the list returned", () => {
    expect(describeEmployeeCode("001")).toBe("001");
    expect(describeEmployeeCode("025")).toBe("025");
    expect(describeEmployeeCode("999")).toBe("999");
  });

  it("keeps leading zeros, because they are the identity", () => {
    // THE WHOLE POINT. `1` and `001` are different Employee IDs to everybody
    // who types one at a till, so the value must survive as text. Anything
    // numeric — parseInt, Number, unary +, a numeric format — collapses them.
    for (const code of ["001", "007", "010", "025", "099"]) {
      expect(`code ${code}`).toBe(`code ${code}`);
      expect(describeEmployeeCode(code)).toBe(code);
      expect(describeEmployeeCode(code)).not.toBe(String(Number(code)));
      expect(describeEmployeeCode(code)).toHaveLength(3);
      expect(typeof describeEmployeeCode(code)).toBe("string");
    }

    // Stated as the failure it prevents: 001 must never render as 1.
    expect(describeEmployeeCode("001")).not.toBe("1");
    expect(describeEmployeeCode("025")).not.toBe("25");
  });

  it("survives a full parse without being reformatted", () => {
    // End to end: the RPC body's string reaches the label unchanged.
    const result = parseListEmployeesResult({
      ok: true,
      employees: [
        { ...ADA, employeeCode: "001" },
        { ...ADA, employeeId: "x", employeeCode: "025" },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.employees.map((e) => describeEmployeeCode(e.employeeCode))).toEqual([
      "001",
      "025",
    ]);
  });

  it("says a legacy employee is unassigned, and never invents one", () => {
    expect(describeEmployeeCode(null)).toBe(EMPLOYEE_CODE_UNASSIGNED_LABEL);
    expect(describeEmployeeCode(undefined)).toBe(EMPLOYEE_CODE_UNASSIGNED_LABEL);
    expect(describeEmployeeCode("")).toBe(EMPLOYEE_CODE_UNASSIGNED_LABEL);

    expect(EMPLOYEE_CODE_UNASSIGNED_LABEL).toBe("Not assigned");
    // Never the two wrong answers: 000 is a refused code, 001 is a guess.
    expect(EMPLOYEE_CODE_UNASSIGNED_LABEL).not.toBe("000");
    expect(EMPLOYEE_CODE_UNASSIGNED_LABEL).not.toBe("001");
    expect(EMPLOYEE_CODE_UNASSIGNED_LABEL).not.toBe("Not shown");
  });

  it("is a pure read, so a null code can mutate nothing", () => {
    // It takes a value and returns a string. There is no employee to write to,
    // no client to call with, and nothing to back-fill — the shape of the
    // function is the guarantee.
    const employee = { ...BO };

    expect(describeEmployeeCode(employee.employeeCode)).toBe(EMPLOYEE_CODE_UNASSIGNED_LABEL);
    expect(employee.employeeCode).toBeNull();
    expect(employee).toEqual(BO);
  });

  it("gives every employee the code from their own row", () => {
    const result = parseListEmployeesResult({
      ok: true,
      employees: [
        { ...ADA, employeeId: "a", employeeCode: "001" },
        { ...ADA, employeeId: "b", employeeCode: "025" },
        { ...ADA, employeeId: "c", employeeCode: null },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(
      result.employees.map((e) => [e.employeeId, describeEmployeeCode(e.employeeCode)])
    ).toEqual([
      ["a", "001"],
      ["b", "025"],
      ["c", "Not assigned"],
    ]);
  });

  it("reconstructs a fresh load from the list alone, remembering nothing", () => {
    // THE RELOAD REQUIREMENT. Two independent parses of two different server
    // answers, with no state carried between them: the second render shows the
    // second answer. If any code were cached from a create or a set-code, the
    // reassigned value below could not win.
    const first = parseListEmployeesResult({
      ok: true,
      employees: [{ ...ADA, employeeCode: "001" }],
    });
    const afterReassignment = parseListEmployeesResult({
      ok: true,
      employees: [{ ...ADA, employeeCode: "025" }],
    });

    expect(first.ok && describeEmployeeCode(first.employees[0].employeeCode)).toBe("001");
    expect(
      afterReassignment.ok &&
        describeEmployeeCode(afterReassignment.employees[0].employeeCode)
    ).toBe("025");

    // And a code that only ever came from a mutation result is not consulted:
    // describeEmployeeCode takes the row's value and has nowhere else to look.
    expect(describeEmployeeCode.length).toBe(1);
  });

  it("no longer claims existing Employee IDs cannot be read", () => {
    // That statement was true of the pre-correction contract and is false now.
    const limits = Object.values(EMPLOYEE_ADMIN_LIMITS).join(" ");

    expect(limits).not.toMatch(/not shown|cannot be read|are not shown here/i);
    // The rename limitation is untouched and still stated.
    expect(EMPLOYEE_ADMIN_LIMITS.rename).toMatch(/names cannot be changed/i);
    expect(Object.keys(EMPLOYEE_ADMIN_LIMITS)).toEqual(["rename"]);
  });
});

// ---------------------------------------------------------------------------
// The form, before it costs a round trip
// ---------------------------------------------------------------------------

describe("checking a draft employee", () => {
  const VALID = {
    displayName: "Ada",
    role: "cashier",
    employeeCode: "001",
    pin: "1234",
  } as const;

  it("accepts a well-formed draft", () => {
    expect(findEmployeeDraftProblem({ ...VALID })).toBeNull();
  });

  it("requires a name that is not just spaces", () => {
    for (const displayName of ["", "   ", "\t"]) {
      expect(`name ${JSON.stringify(displayName)}`).toBe(`name ${JSON.stringify(displayName)}`);
      expect(findEmployeeDraftProblem({ ...VALID, displayName })).toEqual({
        field: "displayName",
        message: EMPLOYEE_NAME_REQUIRED_MESSAGE,
      });
    }
  });

  it("holds Employee IDs to exactly three digits, and refuses 000", () => {
    for (const employeeCode of ["", "1", "12", "1234", "abc", "00a", "000", " 01", "١٢٣"]) {
      expect(`code ${JSON.stringify(employeeCode)}`).toBe(`code ${JSON.stringify(employeeCode)}`);
      expect(findEmployeeDraftProblem({ ...VALID, employeeCode })).toEqual({
        field: "employeeCode",
        message: EMPLOYEE_CODE_SHAPE_MESSAGE,
      });
    }

    // The boundaries the server allows are allowed here too.
    for (const employeeCode of ["001", "010", "999"]) {
      expect(`code ok ${employeeCode}`).toBe(`code ok ${employeeCode}`);
      expect(findEmployeeDraftProblem({ ...VALID, employeeCode })).toBeNull();
    }
  });

  it("holds PINs to exactly four ASCII digits", () => {
    for (const pin of ["", "123", "12345", "abcd", "12 4", " 1234", "١٢٣٤"]) {
      expect(`pin ${JSON.stringify(pin)}`).toBe(`pin ${JSON.stringify(pin)}`);
      expect(findEmployeeDraftProblem({ ...VALID, pin })).toEqual({
        field: "pin",
        message: EMPLOYEE_PIN_SHAPE_MESSAGE,
      });
    }

    expect(findEmployeeDraftProblem({ ...VALID, pin: "0000" })).toBeNull();
  });

  it("reports the first problem in field order, so focus has somewhere to go", () => {
    const problem = findEmployeeDraftProblem({
      displayName: "",
      role: "cashier",
      employeeCode: "bad",
      pin: "nope",
    });

    expect(problem?.field).toBe("displayName");
  });

  it("starts empty, at the least privileged role, with no PIN", () => {
    const draft = emptyEmployeeDraft();

    expect(draft).toEqual({ displayName: "", role: "cashier", employeeCode: "", pin: "" });
    // Two calls must not share an object: clearing one form would clear another.
    expect(emptyEmployeeDraft()).not.toBe(draft);
  });
});

// ---------------------------------------------------------------------------
// One rule, one sentence
// ---------------------------------------------------------------------------

describe("the form and the server say the same thing about the same rule", () => {
  it("shares the Employee ID, PIN, name and taken-ID sentences", () => {
    // Imported constants rather than two literals, so they cannot drift into
    // teaching an owner two different rules for one check.
    expect(CREATE_EMPLOYEE_MESSAGES.invalid_employee_code).toBe(EMPLOYEE_CODE_SHAPE_MESSAGE);
    expect(SET_EMPLOYEE_CODE_MESSAGES.invalid_employee_code).toBe(EMPLOYEE_CODE_SHAPE_MESSAGE);
    expect(CREATE_EMPLOYEE_MESSAGES.invalid_pin).toBe(EMPLOYEE_PIN_SHAPE_MESSAGE);
    expect(SET_EMPLOYEE_PIN_MESSAGES.invalid_pin).toBe(EMPLOYEE_PIN_SHAPE_MESSAGE);
    expect(CREATE_EMPLOYEE_MESSAGES.invalid_display_name).toBe(EMPLOYEE_NAME_REQUIRED_MESSAGE);
    expect(CREATE_EMPLOYEE_MESSAGES.employee_code_taken).toBe(EMPLOYEE_CODE_TAKEN_MESSAGE);
    expect(SET_EMPLOYEE_CODE_MESSAGES.employee_code_taken).toBe(EMPLOYEE_CODE_TAKEN_MESSAGE);
  });

  it("never prints a raw error code at an owner", () => {
    const messages = [
      ...Object.values(LIST_EMPLOYEES_MESSAGES),
      ...Object.values(CREATE_EMPLOYEE_MESSAGES),
      ...Object.values(SET_EMPLOYEE_CODE_MESSAGES),
      ...Object.values(SET_EMPLOYEE_PIN_MESSAGES),
      ...Object.values(SET_EMPLOYEE_ACTIVE_MESSAGES),
    ];

    for (const message of messages) {
      expect(`message ${message}`).toBe(`message ${message}`);
      // A snake_case identifier, not a full stop: an earlier form of this
      // guard banned /employees\./ and failed on the sentence "…this project's
      // employees." — punishing correct copy for looking like SQL.
      expect(message).not.toMatch(/[a-z]_[a-z]|auth\.uid|employees\.[a-z]/);
      expect(message.endsWith(".")).toBe(true);
    }
  });
});
