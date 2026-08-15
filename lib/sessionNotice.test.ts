// Feature 22 Phase 4 — the sign-in notice is a closed set of one.
import { describe, expect, it } from "vitest";
import {
  LOGIN_REASON_PARAM,
  SESSION_EXPIRED_NOTICE,
  SESSION_EXPIRED_REASON,
  getLoginNotice,
} from "@/lib/sessionNotice";

describe("getLoginNotice", () => {
  it("returns the expired-session copy for the one known reason", () => {
    expect(getLoginNotice(SESSION_EXPIRED_REASON)).toBe(SESSION_EXPIRED_NOTICE);
  });

  it("returns nothing for a direct visit", () => {
    // The plain /login case: no parameter, no banner.
    expect(getLoginNotice(null)).toBeNull();
    expect(getLoginNotice(undefined)).toBeNull();
    expect(getLoginNotice("")).toBeNull();
  });

  it("returns nothing for any other reason code", () => {
    for (const reason of [
      "session_expired",
      "Session-Expired",
      "expired",
      "logged-out",
      "session-expired ",
      " session-expired",
    ]) {
      expect(getLoginNotice(reason)).toBeNull();
    }
  });

  it("never echoes a value from the URL back onto the page", () => {
    // The attack this closes: a link that puts its own sentence on this
    // product's sign-in page. Whatever the parameter contains, the only two
    // possible outputs are the fixed sentence and null.
    for (const injected of [
      "Your account is locked. Call +1-555-0100 to restore access.",
      "<script>alert(1)</script>",
      "https://evil.example/login",
      "session-expired&next=https://evil.example",
    ]) {
      expect(getLoginNotice(injected)).toBeNull();
    }
  });

  it("carries no destination of its own", () => {
    // Nothing in this module resolves to a URL, so nothing here can become an
    // open redirect. The parameter name and the reason are both opaque codes.
    expect(SESSION_EXPIRED_REASON).not.toContain("/");
    expect(SESSION_EXPIRED_REASON).not.toContain(":");
    expect(LOGIN_REASON_PARAM).toBe("reason");
  });
});

describe("the notice copy", () => {
  it("says what happened and what to do", () => {
    expect(SESSION_EXPIRED_NOTICE).toBe(
      "Your session expired. Sign in again to continue."
    );
  });

  it("names no provider, token, or status code", () => {
    const lower = SESSION_EXPIRED_NOTICE.toLowerCase();
    for (const banned of [
      "supabase",
      "gotrue",
      "jwt",
      "token",
      "refresh",
      "cookie",
      "401",
      "auth",
    ]) {
      expect(lower).not.toContain(banned);
    }
  });
});
