// v1.3 CP2d — the daily register context, as the device holds it.
//
// Pure in, pure out. The thing worth proving here is a negative: nothing in
// this module decides what day it is. It parses the server's answer, it decides
// when to ask again, and a wrong device clock can make it ask at a silly time
// but can never make it file a sale on the wrong day.
import { describe, expect, it } from "vitest";
import {
  DAILY_REFRESH_BACKOFF_MS,
  DAILY_REFRESH_GRACE_MS,
  DAILY_REFRESH_MAX_MS,
  adoptSaleRegisterId,
  nextDailyRefreshDelayMs,
  parseDailyEnsureResponse,
  shouldAdoptSaleRegisterId,
  timestampMs,
} from "@/lib/dailyRegister";
import type { DailyRegisterContext } from "@/lib/dailyRegister";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const PAYLOAD = {
  ok: true,
  created: true,
  registerSession: {
    registerSessionId: ID,
    businessDate: "2026-09-19",
    businessTimezone: "America/New_York",
    openedAt: "2026-09-19T04:00:00+00:00",
    closedAt: "2026-09-20T04:00:00+00:00",
    openedByEmployeeId: null,
    closedByEmployeeId: null,
    openingCash: "0.00",
  },
};

const TODAY: DailyRegisterContext = {
  registerSessionId: ID,
  businessDate: "2026-09-19",
  businessTimezone: "America/New_York",
  openedAt: "2026-09-19T04:00:00+00:00",
  closedAt: "2026-09-20T04:00:00+00:00",
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe("what the server answered", () => {
  it("reads an established context", () => {
    expect(parseDailyEnsureResponse(PAYLOAD)).toEqual({ ok: true, context: TODAY });
  });

  it("keeps each domain refusal as itself", () => {
    for (const error of [
      "business_timezone_required",
      "daily_register_timezone_conflict",
      "not_paired",
      "not_authenticated",
    ] as const) {
      expect(parseDailyEnsureResponse({ ok: false, error })).toEqual({ ok: false, error });
    }
  });

  it("an unrecognised refusal is `unavailable`, never invented", () => {
    expect(parseDailyEnsureResponse({ ok: false, error: "something_new" }))
      .toEqual({ ok: false, error: "unavailable" });
  });

  it("a payload it cannot read is `unavailable`, not a refusal", () => {
    // "We could not understand the answer" must never become "the server said
    // this business has no timezone": one is a bug, the other is somebody's
    // setup job, and they earn different screens.
    for (const value of [null, undefined, 42, "ok", {}, { ok: true }, { ok: "yes" }]) {
      expect(parseDailyEnsureResponse(value)).toEqual({ ok: false, error: "unavailable" });
    }
  });

  it("refuses a malformed register id rather than sending it as an expectation", () => {
    for (const bad of ["", "not-a-uuid", 7, null, `${ID} `]) {
      expect(
        parseDailyEnsureResponse({ ...PAYLOAD, registerSession: { ...PAYLOAD.registerSession, registerSessionId: bad } })
      ).toEqual({ ok: false, error: "unavailable" });
    }
  });

  it("requires the calendar fields it will display and schedule from", () => {
    for (const field of ["businessDate", "businessTimezone", "openedAt", "closedAt"] as const) {
      expect(
        parseDailyEnsureResponse({
          ...PAYLOAD,
          registerSession: { ...PAYLOAD.registerSession, [field]: null },
        })
      ).toEqual({ ok: false, error: "unavailable" });
    }
  });
});

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

describe("when to ask again", () => {
  const closedAt = Date.parse("2026-09-20T04:00:00Z");

  it("waits until just after the business day ends", () => {
    const now = closedAt - 3_600_000;

    expect(nextDailyRefreshDelayMs({ closedAtMs: closedAt, nowMs: now, consecutiveUnchanged: 0 }))
      .toBe(3_600_000 + DAILY_REFRESH_GRACE_MS);
  });

  it("never sleeps longer than the cap, however far away the end is", () => {
    expect(
      nextDailyRefreshDelayMs({ closedAtMs: closedAt, nowMs: closedAt - 86_400_000, consecutiveUnchanged: 0 })
    ).toBe(DAILY_REFRESH_MAX_MS);
  });

  it("DOES NOT BUSY-LOOP when the day has already ended by this clock", () => {
    // An early timer, or a device clock a day fast. The server keeps answering
    // with the same context; each unchanged answer waits longer.
    const delays = [0, 1, 2, 3, 4, 10].map((n) =>
      nextDailyRefreshDelayMs({ closedAtMs: closedAt, nowMs: closedAt + 60_000, consecutiveUnchanged: n })
    );

    expect(delays).toEqual([
      DAILY_REFRESH_BACKOFF_MS[0],
      DAILY_REFRESH_BACKOFF_MS[1],
      DAILY_REFRESH_BACKOFF_MS[2],
      DAILY_REFRESH_BACKOFF_MS[3],
      DAILY_REFRESH_BACKOFF_MS[3],
      DAILY_REFRESH_BACKOFF_MS[3],
    ]);

    // And every one of them is a real wait, not a spin.
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(60_000);
    }
  });

  it("a context with no known end is asked about soon, not immediately", () => {
    expect(nextDailyRefreshDelayMs({ closedAtMs: null, nowMs: Date.now(), consecutiveUnchanged: 0 }))
      .toBe(DAILY_REFRESH_BACKOFF_MS[0]);
  });

  it("an unreadable timestamp behaves like no timestamp at all", () => {
    expect(timestampMs("not a date")).toBeNull();
    expect(timestampMs(null)).toBeNull();
    expect(timestampMs("2026-09-20T04:00:00+00:00")).toBe(closedAt);

    expect(nextDailyRefreshDelayMs({ closedAtMs: NaN, nowMs: 0, consecutiveUnchanged: 1 }))
      .toBe(DAILY_REFRESH_BACKOFF_MS[1]);
  });

  it("a clock that is WRONG changes only when it asks, never what it believes", () => {
    // The whole point. Two wildly different "now"s produce two different
    // delays and the same context; nothing here returns a date.
    const early = nextDailyRefreshDelayMs({ closedAtMs: closedAt, nowMs: closedAt - 10_000_000, consecutiveUnchanged: 0 });
    const late = nextDailyRefreshDelayMs({ closedAtMs: closedAt, nowMs: closedAt + 10_000_000, consecutiveUnchanged: 0 });

    expect(early).not.toBe(late);
    expect(typeof early).toBe("number");
    expect(typeof late).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Adoption
// ---------------------------------------------------------------------------

describe("adopting what a completed sale was stored against", () => {
  it("adopts a different id", () => {
    expect(shouldAdoptSaleRegisterId(TODAY, OTHER)).toBe(true);
    expect(shouldAdoptSaleRegisterId(null, OTHER)).toBe(true);
  });

  it("does not adopt the id it already holds", () => {
    expect(shouldAdoptSaleRegisterId(TODAY, ID)).toBe(false);
  });

  it("does not adopt anything that is not a uuid", () => {
    for (const bad of [undefined, null, "", "reg-1", 7, {}, [ID]]) {
      expect(shouldAdoptSaleRegisterId(TODAY, bad)).toBe(false);
    }
  });

  it("the adopted context has NO known end, so the rest is reconciled from the server", () => {
    const adopted = adoptSaleRegisterId(TODAY, OTHER);

    expect(adopted.registerSessionId).toBe(OTHER);
    // Keeping yesterday's closedAt would schedule the next refresh against a
    // day that has already finished.
    expect(adopted.closedAt).toBeNull();
    expect(nextDailyRefreshDelayMs({
      closedAtMs: timestampMs(adopted.closedAt),
      nowMs: Date.now(),
      consecutiveUnchanged: 0,
    })).toBe(DAILY_REFRESH_BACKOFF_MS[0]);
  });
});
