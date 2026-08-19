// Feature 24.5D — classification and backoff, exhaustively.
//
// The highest-stakes decisions in the engine: whether a sale retries, waits for
// a person, or stops. A wrong "permanent" abandons money; a wrong "retry"
// hammers a server that has already said no.
import { describe, expect, it } from "vitest";
import {
  KNOWN_SERVER_ERRORS,
  SYNC_BACKOFF_BASE_MS,
  SYNC_BACKOFF_MAX_MS,
  SYNC_MAX_ATTEMPTS,
  backoffDelayMs,
  classifySubmissionFailure,
  classifyUnreadableRecord,
  nextAttemptAtFrom,
  toSubmissionFailure,
} from "@/lib/saleSyncClassifier";

describe("backoff", () => {
  it("grows and then caps", () => {
    expect(backoffDelayMs(0)).toBe(SYNC_BACKOFF_BASE_MS);
    expect(backoffDelayMs(1)).toBe(5_000);
    expect(backoffDelayMs(2)).toBe(15_000);
    expect(backoffDelayMs(3)).toBe(45_000);
    expect(backoffDelayMs(4)).toBe(135_000);
    expect(backoffDelayMs(5)).toBe(405_000);
    expect(backoffDelayMs(6)).toBe(SYNC_BACKOFF_MAX_MS);
    expect(backoffDelayMs(50)).toBe(SYNC_BACKOFF_MAX_MS);
  });

  it("is monotonic and never exceeds the cap", () => {
    let previous = 0;

    for (let n = 1; n <= 20; n += 1) {
      const delay = backoffDelayMs(n);

      expect(delay).toBeGreaterThanOrEqual(previous);
      expect(delay).toBeLessThanOrEqual(SYNC_BACKOFF_MAX_MS);
      previous = delay;
    }
  });

  it("is deterministic — no jitter, so a test can assert an exact instant", () => {
    expect(backoffDelayMs(3)).toBe(backoffDelayMs(3));
    expect(nextAttemptAtFrom(2, Date.parse("2026-08-19T12:00:00.000Z"))).toBe(
      "2026-08-19T12:00:15.000Z"
    );
  });
});

describe("a transport failure retries", () => {
  it("retries while attempts remain", () => {
    const result = classifySubmissionFailure({ transport: "transport", message: null }, 1);

    expect(result.outcome).toBe("retry");
    expect(result.code).toBe("transport");
  });

  it("asks for a person once attempts are exhausted", () => {
    const result = classifySubmissionFailure(
      { transport: "transport", message: null },
      SYNC_MAX_ATTEMPTS
    );

    expect(result.outcome).toBe("needs_attention");
    expect(result.code).toBe("transport_attempts_exhausted");
  });

  it("ignores message text when nothing answered", () => {
    // A body that happens to look like a business error is meaningless if the
    // request never reached a server.
    const result = classifySubmissionFailure(
      { transport: "transport", message: "Offline sale occurred after this device was revoked" },
      1
    );

    expect(result.outcome).toBe("retry");
  });
});

describe("an unknown outcome retries, because retrying is free", () => {
  it("retries the lost-response case", () => {
    // The opposite default to lib/deviceConnectivity.ts, and deliberately so:
    // there an unknown must not grant access; here an unknown must not abandon
    // a sale, and the idempotency key makes a retry safe.
    const result = classifySubmissionFailure({ transport: "unknown", message: null }, 2);

    expect(result.outcome).toBe("retry");
    expect(result.code).toBe("unknown_outcome");
  });

  it("stops after the attempt cap rather than looping forever", () => {
    const result = classifySubmissionFailure(
      { transport: "unknown", message: null },
      SYNC_MAX_ATTEMPTS
    );

    expect(result.outcome).toBe("needs_attention");
    expect(result.code).toBe("unknown_attempts_exhausted");
  });
});

describe("known server answers are matched EXACTLY", () => {
  it("covers every message the brief required", () => {
    for (const message of [
      "Offline sale time is in the future",
      "Offline sale time predates this device",
      "Offline sale time is older than the offline limit",
      "Only a paired device can record an offline sale",
      "Offline sale occurred after this device was revoked",
      "Invalid sale source",
      "Sale request ID was already used for a different order",
    ]) {
      expect(`uncovered: ${message}`).toBe(`uncovered: ${message}`);
      expect(KNOWN_SERVER_ERRORS[message]).toBeDefined();

      const result = classifySubmissionFailure({ transport: "server_rejected", message }, 1);

      expect(result.outcome).toBe("needs_attention");
    }
  });

  it("maps each to a distinct, stable code", () => {
    const codes = Object.values(KNOWN_SERVER_ERRORS);

    expect(new Set(codes).size).toBe(codes.length);
  });

  it("matches by equality, not by substring", () => {
    // A near-miss must NOT be silently filed as the message it resembles.
    const nearMiss = classifySubmissionFailure(
      {
        transport: "server_rejected",
        message: "ERROR: Offline sale time is in the future (SQLSTATE P0001)",
      },
      1
    );

    expect(nearMiss.outcome).toBe("needs_attention");
    expect(nearMiss.code).toBe("unrecognised_server_error");
  });

  it("tolerates surrounding whitespace only", () => {
    const padded = classifySubmissionFailure(
      { transport: "server_rejected", message: "  Invalid sale source  " },
      1
    );

    expect(padded.code).toBe("invalid_source");
  });
});

describe("anything unrecognised fails safe", () => {
  it("an unknown server answer becomes needs_attention, never discarded", () => {
    const result = classifySubmissionFailure(
      { transport: "server_rejected", message: "Menu item burger is not available" },
      1
    );

    expect(result.outcome).toBe("needs_attention");
    expect(result.code).toBe("unrecognised_server_error");
  });

  it("an empty or absent message still preserves the sale", () => {
    for (const message of [null, "", "   "]) {
      const result = classifySubmissionFailure({ transport: "server_rejected", message }, 1);

      expect(result.outcome).toBe("needs_attention");
    }
  });

  it("NO server answer is ever classified permanent_failure", () => {
    // permanent_failure means "retry and review cannot help", which is a claim
    // the server never actually makes — even a hash conflict is resolvable by
    // someone confirming the original order.
    const messages = [...Object.keys(KNOWN_SERVER_ERRORS), "something nobody catalogued", ""];

    for (const message of messages) {
      for (const transport of ["server_rejected", "unknown", "transport"] as const) {
        for (const attempts of [0, 1, SYNC_MAX_ATTEMPTS, 99]) {
          const result = classifySubmissionFailure({ transport, message }, attempts);

          expect(`permanent for ${transport}/${message}`).toBe(
            `permanent for ${transport}/${message}`
          );
          expect(result.outcome).not.toBe("permanent_failure");
        }
      }
    }
  });

  it("permanent_failure is reserved for an unreadable local record", () => {
    const result = classifyUnreadableRecord();

    expect(result.outcome).toBe("permanent_failure");
    expect(result.code).toBe("record_unreadable");
  });
});

describe("toSubmissionFailure reuses the 24.5A transport classifier", () => {
  it("recognises a Postgres answer as a server rejection", () => {
    const failure = toSubmissionFailure({ code: "P0001", message: "Invalid sale source" });

    expect(failure.transport).toBe("server_rejected");
    expect(failure.message).toBe("Invalid sale source");
  });

  it("recognises a network failure as transport", () => {
    expect(toSubmissionFailure({ message: "TypeError: Failed to fetch" }).transport).toBe(
      "transport"
    );
  });

  it("recognises an indeterminate error as unknown", () => {
    expect(toSubmissionFailure({ message: "something went wrong" }).transport).toBe("unknown");
  });
});


// ---------------------------------------------------------------------------
// 24.5D audit — the two "unknown" categories are NOT the same thing
// ---------------------------------------------------------------------------

describe("unknown TRANSPORT and unknown SERVER ERROR are different categories", () => {
  const uncatalogued = "Menu item burger is not available";

  it("unknown transport RETRIES — the outcome of the request is genuinely unknown", () => {
    // Nothing trustworthy came back, so the sale may or may not have landed.
    // Retrying is free because the durable saleRequestId makes it idempotent,
    // and NOT retrying would abandon a sale that was never recorded.
    for (const attempts of [0, 1, 5]) {
      const result = classifySubmissionFailure({ transport: "unknown", message: null }, attempts);

      expect(`attempt ${attempts}`).toBe(`attempt ${attempts}`);
      expect(result.outcome).toBe("retry");
      expect(result.code).toBe("unknown_outcome");
    }
  });

  it("an uncatalogued SERVER REJECTION does NOT retry — it stops immediately", () => {
    // PostgreSQL definitely answered. The answer is deterministic: resubmitting
    // the identical request would produce the identical rejection, so retrying
    // is pure noise against a server that has already decided.
    for (const attempts of [0, 1, 5, 9]) {
      const result = classifySubmissionFailure(
        { transport: "server_rejected", message: uncatalogued },
        attempts
      );

      expect(`attempt ${attempts}`).toBe(`attempt ${attempts}`);
      expect(result.outcome).toBe("needs_attention");
      expect(result.code).toBe("unrecognised_server_error");
    }
  });

  it("the same message classifies differently depending on whether a server replied", () => {
    // The distinction lives in the TRANSPORT verdict, not in the text.
    const asTransport = classifySubmissionFailure(
      { transport: "transport", message: uncatalogued },
      1
    );
    const asUnknown = classifySubmissionFailure({ transport: "unknown", message: uncatalogued }, 1);
    const asRejection = classifySubmissionFailure(
      { transport: "server_rejected", message: uncatalogued },
      1
    );

    expect(asTransport.outcome).toBe("retry");
    expect(asUnknown.outcome).toBe("retry");
    expect(asRejection.outcome).toBe("needs_attention");
  });

  it("a server rejection is never resubmitted, at any attempt count", () => {
    // The property stated as an invariant rather than as sampled cases.
    for (let attempts = 0; attempts <= SYNC_MAX_ATTEMPTS + 5; attempts += 1) {
      const result = classifySubmissionFailure(
        { transport: "server_rejected", message: uncatalogued },
        attempts
      );

      expect(result.outcome).not.toBe("retry");
    }
  });
});
