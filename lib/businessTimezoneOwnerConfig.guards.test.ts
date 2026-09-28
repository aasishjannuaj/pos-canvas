// v1.3 Task 5A — the wiring and the boundaries, guarded at source level.
//
// lib/businessTimezone.test.ts proves the model and the request. These are the
// claims that are structural rather than behavioural, and each one is a way the
// feature could quietly become something it was not authorised to be:
//
//   * the value must be LOADED, or the owner is editing a field that always
//     reads "Not set" no matter what the database holds;
//   * it must be SAVED through the ordinary owner update, not a new RPC, a
//     service-role client or a second project-update system;
//   * nothing may infer it from the browser, the device, a locale or an IP;
//   * the control belongs in the EXISTING Business section, not in a new
//     settings architecture;
//   * historical register rows and reporting must be left alone.
//
// Source-level because this repository has no React Testing Library (verified —
// no testing-library dependency in package.json), so components are read.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf-8");
}

/** Comment-stripped source: explanatory prose must never satisfy a guard. */
function code(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const MODEL = "lib/businessTimezone.ts";
const PROJECTS = "lib/projects.ts";
const PROJECTS_SERVER = "lib/projects.server.ts";
const EDITOR_PAGE = "app/editor/[id]/page.tsx";
const SHELL = "components/editor/EditorShell.tsx";
const PANEL = "components/editor/EditorPropertiesPanel.tsx";

const TASK_5A_SOURCES = [MODEL, PROJECTS, PROJECTS_SERVER, EDITOR_PAGE, SHELL, PANEL];

// ---------------------------------------------------------------------------
// It is loaded, not assumed
// ---------------------------------------------------------------------------

describe("the configured timezone reaches the owner's screen", () => {
  it("the project read selects the column", () => {
    const server = code(read(PROJECTS_SERVER));

    // Both reads: the editor loads one project, the dashboard lists them, and
    // SavedProject now declares the column for both.
    expect(server.match(/business_timezone/g)?.length).toBe(2);
    expect(code(read(PROJECTS))).toContain("business_timezone: string | null;");
  });

  it("the editor route passes the loaded value into the Builder", () => {
    expect(code(read(EDITOR_PAGE))).toContain(
      "initialBusinessTimezone={project.business_timezone}"
    );
  });

  it("the Builder seeds its state from that prop and nothing else", () => {
    const shell = code(read(SHELL));

    expect(shell).toContain("useState<string | null>(\n    initialBusinessTimezone ?? null\n  )");
    // Two values: what the owner is editing, and what the database holds.
    expect(shell).toContain("savedBusinessTimezone");
  });
});

// ---------------------------------------------------------------------------
// It is saved through the accepted owner path
// ---------------------------------------------------------------------------

describe("the save path is the existing owner project update", () => {
  it("the Builder saves through saveNewProject/updateProject only", () => {
    const shell = code(read(SHELL));

    expect(shell).toContain("businessTimezoneUpdate(savedBusinessTimezone, businessTimezone)");
    expect(shell).toContain("businessTimezoneUpdate(null, businessTimezone)");
    // No second project-update system, and no direct table access from the UI.
    expect(shell).not.toMatch(/\.from\(\s*["']projects["']\s*\)/);
  });

  it("no Task 5A source reaches for service-role or bypasses RLS", () => {
    for (const file of TASK_5A_SOURCES) {
      const source = code(read(file));

      for (const banned of [
        "service_role",
        "SUPABASE_SERVICE_ROLE_KEY",
        "supabase/admin",
        "createAdminClient",
      ]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("no Task 5A source invents an RPC or a migration for the timezone", () => {
    for (const file of TASK_5A_SOURCES) {
      const source = code(read(file));

      expect(`${file}: rpc`).toBe(`${file}: rpc`);
      expect(source).not.toMatch(/\.rpc\(\s*["'][a-z_]*timezone/i);
      expect(source).not.toMatch(/create\s+(or\s+replace\s+)?function/i);
    }
  });

  it("the database keeps the last word on whether a change is allowed", () => {
    const projects = code(read(PROJECTS));
    const shell = code(read(SHELL));

    // The refusal is translated, never re-implemented or swallowed.
    expect(projects).toContain("business_timezone_change_blocked_open_register");
    expect(projects).toContain("BUSINESS_TIMEZONE_BLOCKED_MESSAGE");
    // The Builder has no opinion of its own about open registers.
    expect(shell).not.toContain("business_timezone_change_blocked_open_register");
    expect(shell).not.toMatch(/register_sessions|open register/i);
  });
});

// ---------------------------------------------------------------------------
// Nothing is inferred
// ---------------------------------------------------------------------------

describe("no timezone is inferred from the browser, device, locale or location", () => {
  const INFERENCE = [
    /resolvedOptions\(\)/,
    /getTimezoneOffset/,
    /navigator\./,
    /geolocation/,
    /\bipapi|ipinfo|geoip\b/i,
    /process\.env\.TZ/,
  ];

  for (const file of TASK_5A_SOURCES) {
    it(`${file} reads no ambient timezone`, () => {
      const source = code(read(file));

      for (const rule of INFERENCE) {
        expect(`${file}: ${rule}`).toBe(`${file}: ${rule}`);
        expect(rule.test(source)).toBe(false);
      }
    });
  }

  it("the only runtime read is the capability list, and it selects nothing", () => {
    const model = code(read(MODEL));

    // Enumerating zones is allowed; choosing one is not.
    expect(model).toContain('supportedValuesOf("timeZone")');
    expect(model).not.toMatch(/resolvedOptions|getTimezoneOffset|navigator/);
    // No default is exported for a caller to fall back to.
    expect(model).not.toMatch(/DEFAULT_(BUSINESS_)?TIMEZONE/);
  });

  it("UTC is an option an owner may pick, never a fallback the code picks", () => {
    const model = code(read(MODEL));
    const utcLines = model
      .split("\n")
      .filter((line) => line.includes("UTC"))
      .map((line) => line.trim());

    // Exactly one mention: a member of the fallback OPTION list.
    expect(utcLines).toEqual(['"UTC",']);
    expect(model).not.toMatch(/\?\?\s*["']UTC["']|\|\|\s*["']UTC["']|=\s*["']UTC["']/);
  });

  it("an unset project stays unset in the control", () => {
    const panel = code(read(PANEL));

    // The placeholder is the unset state, and it is only selectable while the
    // project really is unset.
    expect(panel).toContain("BUSINESS_TIMEZONE_UNSET_LABEL");
    expect(panel).toContain('value={businessTimezone ?? ""}');
    expect(panel).toContain('disabled={businessTimezone !== null}');
  });
});

// ---------------------------------------------------------------------------
// Where it lives, and what it does not touch
// ---------------------------------------------------------------------------

describe("the control is another setting in the existing Business section", () => {
  it("renders inside the Business section, after the existing fields", () => {
    const panel = code(read(PANEL));
    const business = panel.indexOf('editorSection === "Business"');
    const taxes = panel.indexOf('editorSection === "Taxes"');
    const control = panel.indexOf('id="business-timezone"');

    expect(business).toBeGreaterThan(-1);
    expect(control).toBeGreaterThan(business);
    expect(control).toBeLessThan(taxes);
  });

  it("adds no new route, sidebar or settings architecture", () => {
    const shell = code(read(SHELL));
    const panel = code(read(PANEL));

    // The Builder's sidebar sections are unchanged: no "Settings"-style new
    // destination was introduced for this.
    const sidebar = code(read("components/editor/EditorSidebar.tsx"));
    expect(sidebar).not.toMatch(/timezone/i);
    expect(shell).not.toMatch(/router\.push\(["'][^"']*timezone/i);
    expect(panel).not.toMatch(/<nav|role="tablist"/);
  });

  it("uses the Business section's own field conventions", () => {
    const panel = code(read(PANEL));
    const control = panel.slice(panel.indexOf('id="business-timezone"') - 600);

    expect(control).toContain("text-xs font-medium uppercase tracking-wide text-neutral-400");
    expect(control).toContain("rounded-lg border border-neutral-200");
  });
});

describe("Task 5A leaves history and reporting alone", () => {
  it("writes no historical register data", () => {
    for (const file of TASK_5A_SOURCES) {
      const source = code(read(file));

      for (const banned of [
        "register_sessions",
        "business_date",
        "employee_time_sessions",
        "cash_movements",
      ]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("changes no reporting behaviour", () => {
    // The authoritative value is available through the project path for a later
    // reporting task to consume; Task 5A consumes none of it itself.
    //
    // NOT A BAN ON MENTIONING REPORTS: EditorShell has mounted SalesReport
    // since long before this task, and an earlier draft of this guard failed on
    // that pre-existing import — which would have been a test punishing the
    // wrong thing. What Task 5A must not do is FEED the timezone into a report,
    // which is the later, unauthorised work.
    for (const file of TASK_5A_SOURCES) {
      const source = code(read(file));

      expect(`${file}: dateRange`).toBe(`${file}: dateRange`);
      expect(source).not.toContain("@/lib/dateRange");
      expect(source).not.toMatch(/salesByEmployee|businessDateRange|bucketByBusinessDate/i);
    }

    const shell = code(read(SHELL));
    const mount = shell.slice(shell.indexOf("<SalesReport"), shell.indexOf("<SalesReport") + 600);

    expect(mount).not.toMatch(/timezone/i);
  });

  it("the existing Business profile fields still render", () => {
    const panel = code(read(PANEL));

    for (const field of [
      "businessProfile.businessName",
      "businessProfile.addressLine1",
      "businessProfile.city",
      "businessProfile.phone",
      "businessProfile.email",
      "businessProfile.website",
    ]) {
      expect(`panel: ${field}`).toBe(`panel: ${field}`);
      expect(panel).toContain(field);
    }
  });
});
