// Feature 22 Phase 1 — behavioral tests for password recovery.
//
// The two security properties here are the reason this feature exists at all:
// a recovery link may only return to an origin this code chose, and the
// callback may only redirect to a path this code contains. Both are pure
// functions precisely so they can be tested exhaustively without a browser.
import { describe, expect, it } from "vitest";
import {
  ALLOWED_SITE_ORIGINS,
  AUTH_CALLBACK_PATH,
  DEVELOPMENT_SITE_ORIGIN,
  PRODUCTION_SITE_ORIGIN,
  createAuthCallbackUrl,
  isAllowedSiteOrigin,
  resolveSiteOrigin,
} from "@/lib/siteOrigin";
import {
  AUTH_ERROR_MESSAGES,
  MIN_PASSWORD_LENGTH,
  PASSWORD_RESET_REQUEST_RESULT,
  getAuthErrorMessage,
  validateNewPassword,
} from "@/lib/authErrors";
import { resolveNextDestination } from "@/app/auth/callback/route";

// ---------------------------------------------------------------------------
// Site origin — where a recovery email may point
// ---------------------------------------------------------------------------

describe("the recovery redirect origin is allow-listed", () => {
  it("knows exactly two origins", () => {
    expect(ALLOWED_SITE_ORIGINS).toEqual([
      "https://pos-canvas.vercel.app",
      "http://localhost:3000",
    ]);
  });

  it("uses production as the canonical origin", () => {
    expect(PRODUCTION_SITE_ORIGIN).toBe("https://pos-canvas.vercel.app");
    expect(new URL(PRODUCTION_SITE_ORIGIN).protocol).toBe("https:");
  });

  it("accepts each allowed origin unchanged", () => {
    expect(resolveSiteOrigin(PRODUCTION_SITE_ORIGIN)).toBe(PRODUCTION_SITE_ORIGIN);
    expect(resolveSiteOrigin(DEVELOPMENT_SITE_ORIGIN)).toBe(DEVELOPMENT_SITE_ORIGIN);
  });

  it("FAILS CLOSED to production for any other origin", () => {
    // The attack this prevents: rendering the app on a host the attacker
    // controls, so the recovery email points there instead.
    for (const hostile of [
      "https://evil.example",
      "https://pos-canvas.vercel.app.evil.example",
      "https://pos-canvas-preview.vercel.app",
      "http://pos-canvas.vercel.app", // downgraded scheme
      "https://pos-canvas.vercel.app/", // trailing slash is not the origin
      "javascript:alert(1)",
      "//evil.example",
      "",
      "   ",
      null,
      undefined,
    ]) {
      expect(resolveSiteOrigin(hostile as string | null)).toBe(PRODUCTION_SITE_ORIGIN);
    }
  });

  it("recognises only exact matches", () => {
    expect(isAllowedSiteOrigin(PRODUCTION_SITE_ORIGIN)).toBe(true);
    expect(isAllowedSiteOrigin("https://pos-canvas.vercel.app/extra")).toBe(false);
    expect(isAllowedSiteOrigin(42)).toBe(false);
  });

  it("builds a callback URL on an allowed origin", () => {
    expect(
      createAuthCallbackUrl({ origin: DEVELOPMENT_SITE_ORIGIN, next: "/reset-password" })
    ).toBe("http://localhost:3000/auth/callback?next=%2Freset-password");
  });

  it("builds a PRODUCTION callback URL when the origin is not allowed", () => {
    const url = createAuthCallbackUrl({
      origin: "https://evil.example",
      next: "/reset-password",
    });

    expect(url.startsWith(PRODUCTION_SITE_ORIGIN + AUTH_CALLBACK_PATH)).toBe(true);
    expect(url).not.toContain("evil.example");
  });

  it("matches the callback path Supabase must have allow-listed", () => {
    expect(AUTH_CALLBACK_PATH).toBe("/auth/callback");
    for (const origin of ALLOWED_SITE_ORIGINS) {
      expect(createAuthCallbackUrl({ origin, next: "/reset-password" })).toContain(
        `${origin}/auth/callback`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Callback destination — the open-redirect boundary
// ---------------------------------------------------------------------------

describe("the callback cannot become an open redirect", () => {
  it("resolves the known destination", () => {
    expect(resolveNextDestination("/reset-password")).toBe("/reset-password");
  });

  it("defaults to the reset page when next is absent", () => {
    expect(resolveNextDestination(null)).toBe("/reset-password");
  });

  it("DISCARDS every off-site or unknown destination", () => {
    // Note "//evil.example" and "/\\evil.example": both pass a naive
    // startsWith("/") check and both navigate off-site. An allow-list map is
    // immune to the whole class.
    for (const hostile of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "http://localhost:3000/reset-password",
      "/dashboard",
      "/editor/project-1",
      "/reset-password?x=1",
      "/reset-password/../admin",
      "javascript:alert(1)",
      "",
    ]) {
      expect(resolveNextDestination(hostile)).toBe("/reset-password");
    }
  });

  it("only ever returns an internal path", () => {
    for (const candidate of ["/reset-password", null, "https://evil.example", "/x"]) {
      const resolved = resolveNextDestination(candidate);
      expect(resolved.startsWith("/")).toBe(true);
      expect(resolved.startsWith("//")).toBe(false);
      expect(resolved).not.toContain(":");
    }
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe("auth errors are mapped, never passed through", () => {
  it("maps invalid credentials", () => {
    expect(
      getAuthErrorMessage({ message: "Invalid login credentials" }, "sign_in")
    ).toBe(AUTH_ERROR_MESSAGES.invalidCredentials);
    expect(getAuthErrorMessage({ status: 400 }, "sign_in")).toBe(
      AUTH_ERROR_MESSAGES.invalidCredentials
    );
  });

  it("maps an existing account on signup", () => {
    expect(
      getAuthErrorMessage({ message: "User already registered" }, "sign_up")
    ).toBe(AUTH_ERROR_MESSAGES.emailAlreadyRegistered);
  });

  it("maps a weak password", () => {
    expect(
      getAuthErrorMessage(
        { message: "Password should be at least 6 characters" },
        "sign_up"
      )
    ).toBe(AUTH_ERROR_MESSAGES.weakPassword);
  });

  it("maps rate limiting in every context", () => {
    for (const context of ["sign_in", "sign_up", "update_password"] as const) {
      expect(getAuthErrorMessage({ status: 429 }, context)).toBe(
        AUTH_ERROR_MESSAGES.rateLimited
      );
      expect(
        getAuthErrorMessage({ message: "Email rate limit exceeded" }, context)
      ).toBe(AUTH_ERROR_MESSAGES.rateLimited);
    }
  });

  it("maps an expired recovery session when updating a password", () => {
    expect(
      getAuthErrorMessage({ message: "Auth session missing!" }, "update_password")
    ).toBe(AUTH_ERROR_MESSAGES.sessionExpired);
    expect(getAuthErrorMessage({ status: 401 }, "update_password")).toBe(
      AUTH_ERROR_MESSAGES.sessionExpired
    );
  });

  it("collapses anything unrecognised to one generic sentence", () => {
    for (const error of [
      { message: "AuthApiError: unexpected_failure (500)" },
      { message: "fetch failed" },
      { message: "" },
      {},
      null,
      undefined,
    ]) {
      expect(getAuthErrorMessage(error, "sign_in")).toBe(AUTH_ERROR_MESSAGES.unknown);
    }
  });

  it("NEVER leaks provider vocabulary into customer copy", () => {
    const allCopy = Object.values(AUTH_ERROR_MESSAGES).join(" ").toLowerCase();

    for (const banned of [
      "supabase",
      "gotrue",
      "postgres",
      "jwt",
      "token",
      "http",
      "400",
      "401",
      "429",
      "500",
      "autherror",
      "invalid_grant",
      "error:",
    ]) {
      expect(allCopy).not.toContain(banned);
    }
  });

  it("never returns the original provider message", () => {
    const leaky = { message: "AuthApiError: invalid_grant at GoTrueClient" };

    for (const context of ["sign_in", "sign_up", "update_password"] as const) {
      const mapped = getAuthErrorMessage(leaky, context);
      expect(mapped).not.toContain("GoTrue");
      expect(mapped).not.toContain("invalid_grant");
      expect(Object.values(AUTH_ERROR_MESSAGES)).toContain(mapped);
    }
  });
});

// ---------------------------------------------------------------------------
// Password rules and non-enumeration
// ---------------------------------------------------------------------------

describe("new-password validation", () => {
  it("requires the minimum length", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(6);
    expect(validateNewPassword("abc", "abc")).toContain("at least 6");
  });

  it("requires both entries to match", () => {
    expect(validateNewPassword("correct-horse", "correct-hors")).toBe(
      "Both passwords must match."
    );
  });

  it("accepts a valid pair", () => {
    expect(validateNewPassword("correct-horse", "correct-horse")).toBeNull();
  });

  it("checks length before matching, so the clearer error wins", () => {
    expect(validateNewPassword("abc", "xyz")).toContain("at least 6");
  });
});

describe("the reset request reveals nothing about the account", () => {
  it("has exactly one result string", () => {
    expect(PASSWORD_RESET_REQUEST_RESULT).toBe(
      "If an account exists for that email, we've sent a password reset link."
    );
  });

  it("is conditional in wording, never confirming", () => {
    const copy = PASSWORD_RESET_REQUEST_RESULT.toLowerCase();
    expect(copy).toContain("if an account exists");
    // Nothing that would confirm or deny the address.
    for (const leak of ["we found", "no account", "not registered", "does not exist"]) {
      expect(copy).not.toContain(leak);
    }
  });
});
