// Feature 22 Phase 4 — static guards for the first-run path.
//
// THE DEFECT CLASS THESE PROTECT AGAINST: a control that looks like a control
// and does nothing. The dashboard shipped with a search box that searched
// nothing, two "View all" buttons with no destination, and eight category chips
// with no onClick. None of that fails a type check, a lint rule, or any
// behavioural test — the app renders perfectly and simply ignores the click.
// The only place it fails is in front of an owner deciding whether this product
// works, which is why the assertions below are source-level.
//
// The second subject is the sign-in bounce: what a protected route may put in
// the URL when it turns an owner away, and what the sign-in page will render
// from it. Exactly one opaque code, and no destination at all.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CREATE_PROJECT_PATH } from "@/lib/dashboardState";
import { CONFIGURATION_DOWNLOAD_FAILED_MESSAGE } from "@/lib/generatedPosConfig";
import { LOGIN_REASON_PARAM, SESSION_EXPIRED_REASON } from "@/lib/sessionNotice";

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

/** Strips import statements: a module PATH is not customer-facing copy. */
function body(source: string): string {
  return code(source).replace(/^import[\s\S]*?from\s+"[^"]+";$/gm, "");
}

function walk(dir: string): string[] {
  const absolute = join(repoRoot, dir);
  if (!existsSync(absolute)) return [];

  return readdirSync(absolute).flatMap((entry) => {
    const relative = join(dir, entry);
    if (statSync(join(repoRoot, relative)).isDirectory()) return walk(relative);
    return /\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry) ? [relative] : [];
  });
}

const DASHBOARD_PAGE = "app/dashboard/page.tsx";
const HEADER = "components/dashboard/DashboardHeader.tsx";
const PROJECTS = "components/dashboard/RecentProjects.tsx";
const TRENDING = "components/dashboard/TrendingTemplates.tsx";
const APP_CARD = "components/dashboard/AndroidAppCard.tsx";
const GALLERY_HEADER = "components/templates/TemplateGalleryHeader.tsx";
const LOGIN = "app/login/page.tsx";
const SIGNUP = "app/signup/page.tsx";
const FORGOT = "app/forgot-password/page.tsx";
const RESET = "app/reset-password/page.tsx";
const PROXY = "proxy.ts";

const AUTH_PAGES = [LOGIN, SIGNUP, FORGOT, RESET];

/** Every dashboard surface an owner can see. */
const DASHBOARD_SURFACES = [DASHBOARD_PAGE, ...walk("components/dashboard")];

// ---------------------------------------------------------------------------
// A. The zero-project state
// ---------------------------------------------------------------------------

describe("a new account is given a next action", () => {
  const projects = code(read(PROJECTS));

  it("renders a distinct empty state, not just an absence", () => {
    expect(projects).toContain('state === "empty"');
    expect(read(PROJECTS)).toContain("No projects yet.");
  });

  it("the empty state carries a real Create Project CTA", () => {
    expect(projects).toContain("CREATE_PROJECT_LABEL");
    expect(projects).toContain("href={CREATE_PROJECT_PATH}");
  });

  it("the header greets a first-time owner and offers the same action", () => {
    const header = code(read(HEADER));
    expect(header).toContain("getDashboardWelcome(state)");
    expect(header).toContain("href={CREATE_PROJECT_PATH}");
    // The greeting is no longer hardcoded to a returning owner.
    expect(header).not.toContain("Welcome back");
  });

  it("the CTA destination is a route that actually exists", () => {
    // The shared constant is the only place the destination is named; this
    // asserts the page it names is really there.
    expect(CREATE_PROJECT_PATH).toBe("/templates");
    expect(existsSync(join(repoRoot, "app/templates/page.tsx"))).toBe(true);
  });

  it("creates nothing on the owner's behalf", () => {
    // No sample project, no auto-created project, no seeded data. The empty
    // state is a link and a sentence.
    for (const file of DASHBOARD_SURFACES) {
      const source = code(read(file));
      for (const banned of [
        "createProject",
        "insert(",
        "sampleProject",
        "seedProject",
        "use server",
      ]) {
        expect(`${file}: ${source}`).not.toContain(banned);
      }
    }
  });

  it("distinguishes an empty account from a failed load", () => {
    // Both produce zero projects. Only one of them means "create your first".
    expect(projects).toContain('state === "unavailable"');
    expect(code(read(DASHBOARD_PAGE))).toContain("resolveDashboardProjectsState");
    expect(code(read(DASHBOARD_PAGE))).toContain("loadFailed: error !== null");
  });

  it("shows no provider error when the load fails", () => {
    const page = code(read(DASHBOARD_PAGE));
    expect(page).not.toMatch(/\{[A-Za-z]*[Ee]rror\}/);
    expect(page).not.toContain("error.message");
    expect(code(read(PROJECTS))).not.toContain("error");
  });

  it("keeps the app download available on a zero-project dashboard", () => {
    // An owner with no projects is exactly who has not yet seen that the app
    // exists. It is rendered unconditionally, not behind a project check.
    const page = code(read(DASHBOARD_PAGE));
    expect(page).toContain("<AndroidAppCard />");
    expect(page).not.toMatch(/\{[^}]*&&\s*<AndroidAppCard/);
  });
});

// ---------------------------------------------------------------------------
// B. Dead controls
// ---------------------------------------------------------------------------

describe("no dashboard control is dead", () => {
  it("every button on the dashboard does something", () => {
    for (const file of DASHBOARD_SURFACES) {
      const buttons = code(read(file)).match(/<button[\s\S]*?>/g) ?? [];

      for (const button of buttons) {
        expect(`${file}: ${button}`).toMatch(/onClick=|type="submit"/);
      }
    }
  });

  it("every input on the dashboard is wired to state", () => {
    // The dead search box was an <input> with no value and no onChange.
    for (const file of DASHBOARD_SURFACES) {
      const inputs = code(read(file)).match(/<input[\s\S]*?\/>/g) ?? [];

      for (const input of inputs) {
        expect(`${file}: ${input}`).toContain("onChange=");
      }
    }
  });

  it("the removed dead surfaces are gone, not just unrendered", () => {
    for (const removed of [
      "components/dashboard/SearchBar.tsx",
      "components/dashboard/CategorySection.tsx",
    ]) {
      expect(existsSync(join(repoRoot, removed))).toBe(false);
    }
  });

  it("nothing imports the removed components", () => {
    for (const file of [...walk("app"), ...walk("components")]) {
      const source = code(read(file));
      expect(`${file}: ${source}`).not.toContain("dashboard/SearchBar");
      expect(`${file}: ${source}`).not.toContain("dashboard/CategorySection");
    }
  });

  it("the templates 'View all' is a link to a real route", () => {
    const trending = code(read(TRENDING));
    expect(trending).toContain('href="/templates"');
    // Not a <button> pretending to navigate.
    expect(trending).not.toMatch(/<button[\s\S]*?View all/);
  });

  it("no 'View all' survives without a destination", () => {
    for (const file of DASHBOARD_SURFACES) {
      const source = code(read(file));
      if (!source.includes("View all")) continue;

      const marker = source.indexOf("View all");
      const enclosing = source.slice(Math.max(0, marker - 400), marker);
      expect(`${file}: ${enclosing}`).toContain("href=");
    }
  });

  it("project cards still open the editor", () => {
    expect(code(read(PROJECTS))).toContain("href={`/editor/project-${project.id}`}");
  });

  it("every project is reachable, not only the first four", () => {
    // Removing the dead "View all" without this would have stranded a fifth
    // project behind a button that no longer existed.
    const projects = code(read(PROJECTS));
    expect(projects).not.toContain(".slice(0, 4)");
    expect(projects).toContain("projects.map(");
  });

  it("no placeholder route was invented to satisfy a button", () => {
    for (const invented of ["app/projects", "app/search", "app/categories"]) {
      expect(existsSync(join(repoRoot, invented))).toBe(false);
    }
  });

  it("the template gallery's dead search and filters are gone", () => {
    // Same defect, one step further along the first-run path.
    const gallery = code(read(GALLERY_HEADER));
    expect(gallery).not.toContain("<input");
    expect(gallery).not.toContain("<button");
    expect(gallery).not.toContain("filters");
  });

  it("the template cards themselves still create projects", () => {
    expect(code(read("components/templates/TemplateGalleryCard.tsx"))).toContain(
      "href={`/editor/${templateId}`}"
    );
    expect(code(read("components/template-detail/TemplateActionPanel.tsx"))).toContain(
      "href={`/editor/${templateId}`}"
    );
  });
});

// ---------------------------------------------------------------------------
// C. The session-expired bounce
// ---------------------------------------------------------------------------

describe("a protected-route bounce explains itself", () => {
  const proxy = read(PROXY);

  it("redirects to the sign-in page with the shared reason code", () => {
    expect(proxy).toContain("LOGIN_REASON_PARAM");
    expect(proxy).toContain("SESSION_EXPIRED_REASON");
    expect(proxy).toContain(
      "redirectUrl.searchParams.set(LOGIN_REASON_PARAM, SESSION_EXPIRED_REASON)"
    );
    expect(`/login?${LOGIN_REASON_PARAM}=${SESSION_EXPIRED_REASON}`).toBe(
      "/login?reason=session-expired"
    );
  });

  it("drops the original query string before adding the reason", () => {
    // Otherwise the parameters of whatever the owner was doing follow them onto
    // a sign-in URL, and an inbound link could smuggle extra parameters in.
    const block = code(proxy).slice(
      code(proxy).indexOf("isProtectedRoute && !claims"),
      code(proxy).indexOf("isAuthPage && claims")
    );

    expect(block).toContain('redirectUrl.search = ""');
    expect(block.indexOf('redirectUrl.search = ""')).toBeLessThan(
      block.indexOf("searchParams.set")
    );
  });

  it("records no destination to return to", () => {
    // No return-to parameter is accepted, produced, or read anywhere. This is
    // the open-redirect this phase deliberately does not build.
    const source = code(proxy);
    for (const banned of ["next=", "redirectTo", "returnTo", "callbackUrl"]) {
      expect(source).not.toContain(banned);
    }

    // The reason code is the only parameter this file may ever set...
    expect(source).not.toMatch(/searchParams\.set\((?!LOGIN_REASON_PARAM)/);

    // ...and the two literal paths are the only destinations it may resolve to,
    // so the requested path can never be reflected into the redirect.
    const destinations = source.match(/redirectUrl\.pathname = [^;]+;/g) ?? [];
    expect(destinations).toEqual([
      'redirectUrl.pathname = "/login";',
      'redirectUrl.pathname = "/dashboard";',
    ]);
  });

  it("keeps route protection exactly as it was", () => {
    expect(proxy).toContain(
      'const PROTECTED_PREFIXES = ["/dashboard", "/editor", "/runtime"]'
    );
    expect(proxy).toContain("if (isProtectedRoute && !claims)");
    expect(proxy).toContain("NextResponse.redirect(redirectUrl)");
    // No prefix was loosened into a pass-through.
    expect(code(proxy)).not.toContain("return supabaseResponse;\n  }");
  });

  it("the sign-in page renders the banner only for the known code", () => {
    const login = code(read(LOGIN));
    expect(login).toContain("getLoginNotice(searchParams.get(LOGIN_REASON_PARAM))");
    expect(login).toContain("{notice && !error && (");
    // The sentence comes from the module, never from the URL.
    expect(login).not.toContain('searchParams.get("message")');
    expect(login).not.toMatch(/\{searchParams\.get\([^)]*\)\}/);
  });

  it("the sign-in page navigates only to a fixed path", () => {
    const login = code(read(LOGIN));
    expect(login).toContain('router.push("/dashboard")');
    expect(login).not.toMatch(/router\.push\((?!"\/dashboard")/);
    expect(login).not.toContain("window.location");
  });

  it("no other page reads the reason parameter", () => {
    for (const file of [...walk("app"), ...walk("components")]) {
      if (file === LOGIN) continue;
      expect(`${file}: ${code(read(file))}`).not.toContain("SESSION_EXPIRED");
    }
  });
});

// ---------------------------------------------------------------------------
// D/E. Auth surfaces — final pass
// ---------------------------------------------------------------------------

describe("the auth surfaces remain real forms", () => {
  for (const page of AUTH_PAGES) {
    it(`${page} still submits as a form and blocks a double submit`, () => {
      const source = code(read(page));

      expect(source).toContain("<form");
      expect(source).toContain("onSubmit={handleSubmit}");
      expect(source).toContain('type="submit"');
      expect(source).toContain("event.preventDefault()");
      expect(source).toMatch(/if \((isLoading|isSubmitting)\) \{\s*return;/);
      expect(source).toMatch(/disabled=\{(isLoading|isSubmitting)/);
    });

    it(`${page} nests no second form`, () => {
      // A nested <form> submits the wrong one and is invalid HTML; React will
      // render it without complaint.
      const opens = (code(read(page)).match(/<form[\s>]/g) ?? []).length;
      const closes = (code(read(page)).match(/<\/form>/g) ?? []).length;

      expect(opens).toBeLessThanOrEqual(1);
      expect(opens).toBe(closes);
    });
  }
});

describe("no raw provider vocabulary reaches a customer", () => {
  /** Every non-test .tsx an owner can actually see, plus the proxy. */
  const CUSTOMER_FACING = [...walk("app"), ...walk("components")];

  it("no page renders a provider error message", () => {
    for (const page of AUTH_PAGES) {
      const source = code(read(page));
      expect(`${page}: ${source}`).not.toMatch(/setError\([A-Za-z]*[Ee]rror\.message\)/);
      expect(`${page}: ${source}`).not.toMatch(/\{[A-Za-z]*[Ee]rror\.message\}/);
    }
  });

  it("no auth or dashboard surface names the provider in its own code", () => {
    for (const file of [...AUTH_PAGES, ...DASHBOARD_SURFACES, GALLERY_HEADER]) {
      const source = body(read(file)).toLowerCase();

      for (const banned of ["supabase", "gotrue", "jwt", "authapierror", "invalid_grant"]) {
        expect(`${file}: ${source}`).not.toContain(banned);
      }
    }
  });

  it("the four auth paths all map their errors through the shared helper", () => {
    expect(code(read(LOGIN))).toContain('getAuthErrorMessage(signInError, "sign_in")');
    expect(code(read(SIGNUP))).toContain('getAuthErrorMessage(signUpError, "sign_up")');
    expect(code(read(RESET))).toContain(
      'getAuthErrorMessage(updateError, "update_password")'
    );
    // Forgot-password deliberately maps nothing: one neutral result, always.
    expect(code(read(FORGOT))).toContain("PASSWORD_RESET_REQUEST_RESULT");
    expect(code(read(FORGOT))).not.toContain("getAuthErrorMessage");
  });

  it("forgot-password still cannot enumerate accounts", () => {
    const source = code(read(FORGOT));
    expect(source).not.toMatch(/if \([A-Za-z]*[Ee]rror\)/);
    expect(source).toContain("await requestPasswordReset(trimmed)");
    expect(source).not.toMatch(/const \{[^}]*\} = await requestPasswordReset/);
  });

  it("no customer-facing surface prints a status code", () => {
    for (const file of CUSTOMER_FACING) {
      const source = body(read(file));
      expect(`${file}: ${source}`).not.toMatch(/\{\s*[A-Za-z]*[Ee]rror\.status\s*\}/);
      expect(`${file}: ${source}`).not.toMatch(/\{\s*[A-Za-z]*[Ee]rror\.code\s*\}/);
    }
  });

  it("no customer-facing surface reads a caught exception's message", () => {
    // Feature 22 Phase 4 — this once held exactly one violation: the editor's
    // configuration download rendered `error.message` from its catch block.
    //
    // The rule is narrow on purpose. `result.message` is everywhere in this
    // codebase and is FINE: those are first-party strings this app composed
    // and reviewed (sanitizeBuildFailureMessage, pairing results, readiness
    // messages). What may never reach a screen is the text of a thrown
    // exception, because nobody wrote it and nobody has read it.
    for (const file of CUSTOMER_FACING) {
      const source = code(read(file));
      expect(`${file}: ${source}`).not.toMatch(/[A-Za-z]*[Ee]rror\.message/);
    }
  });

  it("the configuration download cannot render a thrown exception", () => {
    const shell = code(read("components/editor/EditorShell.tsx"));
    const handler = shell.slice(
      shell.indexOf("function handleExport"),
      shell.indexOf("async function handleRequestBuild")
    );

    // Not bound at all: there is no identifier in scope to render.
    expect(handler).toContain("} catch {");
    expect(handler).not.toMatch(/catch \(/);
    expect(handler).toContain("setExportError(CONFIGURATION_DOWNLOAD_FAILED_MESSAGE)");

    // The mechanics either side of it are untouched.
    expect(handler).toContain("createGeneratedPosConfig({");
    expect(handler).toContain("createGeneratedPosConfigFilename(");
    expect(handler).toContain("downloadJsonFile(filename, jsonText)");
    expect(handler).toContain("!exportEligibility.canExport || projectId === null");
  });

  it("the download failure message names nothing internal", () => {
    const lower = CONFIGURATION_DOWNLOAD_FAILED_MESSAGE.toLowerCase();

    for (const banned of [
      "supabase",
      "json",
      "schema",
      "undefined",
      "null",
      "fetch",
      "network",
      "status",
      "stack",
      "build",
    ]) {
      expect(lower).not.toContain(banned);
    }

    // And it still says which thing failed and what to do about it.
    expect(CONFIGURATION_DOWNLOAD_FAILED_MESSAGE).toContain("configuration");
    expect(CONFIGURATION_DOWNLOAD_FAILED_MESSAGE).toContain("try again");
  });
});

// ---------------------------------------------------------------------------
// H. Locked vocabulary
// ---------------------------------------------------------------------------

describe("the locked vocabulary survives this phase", () => {
  const CUSTOMER_FACING = [...walk("app"), ...walk("components")];

  it("no surface reintroduces per-project app language", () => {
    for (const file of CUSTOMER_FACING) {
      const source = code(read(file));

      for (const banned of [
        "Build Application",
        "Request Build",
        "Download your app",
        "custom app",
        "Custom App",
        "desktop build",
        "your APK",
        "project APK",
      ]) {
        expect(`${file}: ${source}`).not.toContain(banned);
      }
    }
  });

  it("the app card still describes one universal app", () => {
    // Phase 3's discoverability wording is untouched by Phase 4.
    expect(read(APP_CARD)).toContain("universal POS Canvas app");
    expect(code(read(APP_CARD))).toContain("getPlatformDownloads");
    expect(code(read(APP_CARD))).toContain("PlatformDownloadRow");
  });

  it("the publish vocabulary is untouched", () => {
    const panel = code(read("components/editor/EditorPropertiesPanel.tsx"));
    expect(panel).toContain("Publish configuration");
    expect(panel).toContain("Download configuration");
    expect(panel).not.toContain("Build Application");
  });

  it("no onboarding wizard, tour, or checklist was added", () => {
    // Phase 4 is copy, links and one banner. Explicitly not a tutorial system.
    for (const file of [...DASHBOARD_SURFACES, GALLERY_HEADER, ...AUTH_PAGES]) {
      const source = code(read(file)).toLowerCase();
      for (const banned of ["wizard", "walkthrough", "tourstep", "onboardingstep"]) {
        expect(`${file}: ${source}`).not.toContain(banned);
      }
    }
  });
});
