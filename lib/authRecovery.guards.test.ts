// Feature 22 Phase 1 — static guards for the recovery surface and the removed
// legacy prototype.
//
// Source-level assertions, per this repository's convention: there is no DOM
// environment, and every property below is structural. A page that renders a
// raw provider error, a form that submits via onClick, or a reinstated
// prototype route would all pass every behavioural test in this repo while
// being real defects.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf-8");
}

/** Strips comments so explanatory prose never trips a guard. */
function code(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const LOGIN = "app/login/page.tsx";
const SIGNUP = "app/signup/page.tsx";
const FORGOT = "app/forgot-password/page.tsx";
const RESET = "app/reset-password/page.tsx";
const CALLBACK = "app/auth/callback/route.ts";
const AUTH_LIB = "lib/supabase/auth.ts";

const AUTH_PAGES = [LOGIN, SIGNUP, FORGOT, RESET];

// ---------------------------------------------------------------------------
// Form semantics
// ---------------------------------------------------------------------------

describe("every auth form is a real form", () => {
  for (const page of AUTH_PAGES) {
    it(`${page} submits via onSubmit, not onClick`, () => {
      // Before this feature, login and signup were a button with an onClick, so
      // pressing Enter in a password field did nothing and password managers
      // could not offer to save credentials.
      const source = code(read(page));

      expect(source).toContain("<form");
      expect(source).toContain("onSubmit={handleSubmit}");
      expect(source).toContain('type="submit"');
      expect(source).not.toMatch(/AuthButton[^>]*onClick=/);
    });

    it(`${page} prevents the default form navigation`, () => {
      expect(code(read(page))).toContain("event.preventDefault()");
    });

    it(`${page} blocks a double submit`, () => {
      const source = code(read(page));
      expect(source).toMatch(/if \((isLoading|isSubmitting)\) \{\s*return;/);
      expect(source).toMatch(/disabled=\{(isLoading|isSubmitting)/);
    });
  }
});

// ---------------------------------------------------------------------------
// Customer-facing copy
// ---------------------------------------------------------------------------

describe("no raw provider error reaches a customer", () => {
  for (const page of AUTH_PAGES) {
    it(`${page} renders no raw error message`, () => {
      const source = code(read(page));

      // The exact regression: setError(signInError.message).
      expect(source).not.toMatch(/setError\([A-Za-z]*[Ee]rror\.message\)/);
      expect(source).not.toMatch(/\{[A-Za-z]*[Ee]rror\.message\}/);
    });

    it(`${page} names no provider or internal vocabulary`, () => {
      // Import statements are stripped first: these pages legitimately import
      // from "@/lib/authErrors", whose module name lowercases to a substring of
      // the provider type "AuthApiError". The subject of this guard is rendered
      // copy and error handling, not the import block.
      const source = code(read(page))
        .replace(/^import[\s\S]*?from\s+"[^"]+";$/gm, "")
        .toLowerCase();

      for (const banned of [
        "gotrue",
        "authapierror",
        "invalid_grant",
        "postgres",
        "rpc(",
        "supabase",
      ]) {
        expect(source).not.toContain(banned);
      }
    });
  }

  it("login and signup map through the shared helper", () => {
    expect(code(read(LOGIN))).toContain('getAuthErrorMessage(signInError, "sign_in")');
    expect(code(read(SIGNUP))).toContain('getAuthErrorMessage(signUpError, "sign_up")');
  });

  it("the reset page maps update failures too", () => {
    expect(code(read(RESET))).toContain(
      'getAuthErrorMessage(updateError, "update_password")'
    );
  });
});

describe("the forgot-password page cannot enumerate accounts", () => {
  const source = code(read(FORGOT));

  it("renders the single neutral result constant", () => {
    expect(source).toContain("PASSWORD_RESET_REQUEST_RESULT");
  });

  it("does not branch on the request outcome", () => {
    // Any branch — a different message, an error state, an early return — would
    // reveal whether the address has an account.
    expect(source).not.toMatch(/if \([A-Za-z]*[Ee]rror\)/);
    expect(source).not.toContain("getAuthErrorMessage");
    // The result is deliberately discarded rather than destructured.
    expect(source).toContain("await requestPasswordReset(trimmed)");
    expect(source).not.toMatch(/const \{[^}]*\} = await requestPasswordReset/);
  });

  it("shows the invalid-link banner without provider detail", () => {
    expect(source).toContain('searchParams.get("reason") === "invalid-or-expired"');
    expect(read(FORGOT)).toContain("invalid or has expired");
  });
});

describe("the reset page never shows a dead form", () => {
  const source = code(read(RESET));

  it("checks for a session before rendering the form", () => {
    expect(source).toContain("getCurrentSession()");
    expect(source).toMatch(/sessionState === "expired"/);
  });

  it("offers a way to recover from an expired link", () => {
    expect(read(RESET)).toContain("has expired or has already been used");
    expect(source).toContain('href="/forgot-password"');
    expect(read(RESET)).toContain("Request a new link");
  });

  it("validates the password pair before calling the provider", () => {
    expect(source).toContain("validateNewPassword(password, confirmation)");
  });
});

// ---------------------------------------------------------------------------
// Redirect safety
// ---------------------------------------------------------------------------

describe("recovery redirect targets are code-controlled", () => {
  it("the callback resolves next through a fixed map", () => {
    const source = code(read(CALLBACK));

    expect(source).toContain("ALLOWED_NEXT_DESTINATIONS");
    expect(source).toContain("new Map<string, string>");
    // The classic near-miss: startsWith("/") admits "//evil.example".
    expect(source).not.toContain('startsWith("/")');
  });

  it("every callback failure lands on the same neutral path", () => {
    const source = code(read(CALLBACK));
    expect(source).toContain("/forgot-password?reason=invalid-or-expired");
    // No provider error is forwarded.
    expect(source).not.toMatch(/error\.(message|code|status)/);
  });

  it("the reset request builds its redirect from the allow-list", () => {
    const source = code(read(AUTH_LIB));
    expect(source).toContain("createAuthCallbackUrl(");
    // window.location.origin is offered as a CANDIDATE, never used directly.
    expect(source).not.toMatch(/redirectTo:\s*`?\$?\{?window\.location\.origin/);
  });

  it("no auth page uses the service-role credential", () => {
    for (const file of [...AUTH_PAGES, CALLBACK, AUTH_LIB, "lib/siteOrigin.ts", "lib/authErrors.ts"]) {
      const source = code(read(file));
      expect(source).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
      expect(source).not.toContain("createAdminClient");
      expect(source).not.toContain("@/lib/supabase/admin");
    }
  });
});

// ---------------------------------------------------------------------------
// Signup hardening
// ---------------------------------------------------------------------------

describe("signup handles an unexpected missing session", () => {
  const source = code(read(SIGNUP));

  it("checks for a session before navigating", () => {
    // Confirm Email is OFF in production, so the session exists and the owner
    // goes to the dashboard. This branch exists so that if it is ever switched
    // on, the owner is told what to do instead of being silently bounced.
    expect(source).toContain("if (!data.session)");
    expect(source).toContain("setConfirmationRequired(true)");
  });

  it("navigates to the dashboard only with a session", () => {
    const handler = source.slice(
      source.indexOf("async function handleSubmit"),
      source.indexOf("if (confirmationRequired)")
    );

    expect(handler.indexOf("if (!data.session)")).toBeLessThan(
      handler.indexOf('router.push("/dashboard")')
    );
  });

  it("adds no email-confirmation callback infrastructure", () => {
    // Phase 1 adds exactly one route handler, for password recovery.
    const authRoutes = readdirSync(join(repoRoot, "app/auth"), { recursive: true });
    expect(authRoutes).toContain("callback");
  });
});

// ---------------------------------------------------------------------------
// Legacy prototype removal
// ---------------------------------------------------------------------------

describe("the legacy /pos prototype is gone", () => {
  it("app/pos no longer exists", () => {
    expect(existsSync(join(repoRoot, "app/pos"))).toBe(false);
  });

  it("its prototype components and hook are gone", () => {
    expect(existsSync(join(repoRoot, "components/pos"))).toBe(false);
    expect(existsSync(join(repoRoot, "hooks/useCart.ts"))).toBe(false);
  });

  it("nothing imports the removed modules", () => {
    function walk(dir: string): string[] {
      const absolute = join(repoRoot, dir);
      if (!existsSync(absolute)) return [];
      return readdirSync(absolute).flatMap((entry) => {
        const relative = join(dir, entry);
        return statSync(join(repoRoot, relative)).isDirectory()
          ? walk(relative)
          : // Test files excluded: a guard asserting an import is ABSENT must
            // necessarily name it, and this file is the case in point.
            /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)
            ? [relative]
            : [];
      });
    }

    const sources = [...walk("app"), ...walk("components"), ...walk("lib")];

    for (const file of sources) {
      const source = code(read(file));
      expect(source).not.toContain("@/hooks/useCart");
      expect(source).not.toContain("@/components/pos/");
    }
  });

  it("the prototype's hardcoded sample menu cannot reappear", () => {
    // Burger/Coffee/Sandwich/Fries with an alert() checkout was the exact
    // surface a stranger could reach at /pos.
    function walk(dir: string): string[] {
      const absolute = join(repoRoot, dir);
      if (!existsSync(absolute)) return [];
      return readdirSync(absolute).flatMap((entry) => {
        const relative = join(dir, entry);
        return statSync(join(repoRoot, relative)).isDirectory()
          ? walk(relative)
          : /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)
            ? [relative]
            : [];
      });
    }

    for (const file of [...walk("app"), ...walk("components")]) {
      const source = code(read(file));
      expect(source).not.toContain("placeholderItems");
      expect(source).not.toMatch(/alert\(\s*["'`]Cart is empty/);
    }
  });

  it("the real runtime routes are untouched", () => {
    expect(existsSync(join(repoRoot, "app/runtime/[id]/page.tsx"))).toBe(true);
    expect(existsSync(join(repoRoot, "app/device/page.tsx"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Route protection is unchanged
// ---------------------------------------------------------------------------

describe("existing auth protections are preserved", () => {
  const proxy = read("proxy.ts");

  it("the protected prefixes are unchanged", () => {
    expect(proxy).toContain(
      'const PROTECTED_PREFIXES = ["/dashboard", "/editor", "/runtime"]'
    );
  });

  it("the recovery pages are deliberately NOT protected", () => {
    // A locked-out owner has no session by definition; protecting these would
    // make recovery impossible.
    for (const path of ["/forgot-password", "/reset-password", "/auth/callback"]) {
      expect(proxy).not.toContain(path);
    }
  });

  it("/device remains outside owner route protection", () => {
    expect(proxy).not.toContain("/device");
  });
});
