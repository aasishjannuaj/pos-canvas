// Feature 22 Phase 2 — guards for the customer-facing publish vocabulary.
//
// THE DISTINCTION THESE PROTECT:
//
//   Publishing a configuration  = freezing THIS project's saved business
//                                 configuration (a json_config snapshot) so a
//                                 device can pin to it. Per project.
//   The POS Canvas app          = one universal Android/Windows application,
//                                 downloaded separately, identical for every
//                                 customer.
//
// Copy that blurs those two teaches owners that each project produces its own
// app, which is false and would make the whole distribution model incoherent.
// Wording is not cosmetic here — it is the product's mental model.
//
// INTERNAL NAMING IS DELIBERATELY UNTOUCHED. build_jobs, build_artifacts,
// createBuildJob, BuildStatus, the build worker and every migration keep their
// names. The boundary asserted below is "what an owner reads", not "what the
// code is called"; renaming the backend for cosmetic symmetry would be churn
// with real regression risk and no customer benefit.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUILD_PROCESSING_STARTED_MESSAGE,
  BUILD_PROCESSING_UNAVAILABLE_MESSAGE,
  getBuildRequestButtonLabel,
  getBuildRequestSuccessMessage,
  getBuildStatusLabel,
} from "@/lib/buildJobs";
import { resolvePairingReadiness } from "@/lib/devicePairing.owner";

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

const PANEL = "components/editor/EditorPropertiesPanel.tsx";
const SHELL = "components/editor/EditorShell.tsx";
const DEVICES = "components/devices/DeviceManagementPanel.tsx";
const HOW_IT_WORKS = "components/landing/HowItWorks.tsx";

/** Every non-test .tsx an owner can actually see. */
function customerFacingSources(): string[] {
  function walk(dir: string): string[] {
    return readdirSync(join(repoRoot, dir)).flatMap((entry) => {
      const relative = join(dir, entry);
      if (statSync(join(repoRoot, relative)).isDirectory()) return walk(relative);
      return /\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry) ? [relative] : [];
    });
  }

  return [...walk("app"), ...walk("components")];
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

describe("customer-facing copy uses the publish vocabulary", () => {
  it("the editor section is 'Publish configuration', not 'Build Application'", () => {
    const panel = code(read(PANEL));
    expect(panel).toContain("Publish configuration");
    expect(panel).not.toContain("Build Application");
  });

  it("the supporting copy explains what publishing actually does", () => {
    expect(read(PANEL)).toContain(
      "Publish a saved version of your business configuration so"
    );
    expect(read(PANEL)).toContain("paired with the POS Canvas app");
  });

  it("the request button reads as publishing at every stage", () => {
    expect(getBuildRequestButtonLabel("idle")).toBe("Publish configuration");
    expect(getBuildRequestButtonLabel("submitting")).toBe("Publishing…");
    expect(getBuildRequestButtonLabel("success")).toBe("Publish again");
    expect(getBuildRequestButtonLabel("error")).toBe("Retry publishing");
  });

  it("the in-progress status reads 'Publishing', not 'Building'", () => {
    // "Building" implied a binary was being produced.
    expect(getBuildStatusLabel("building")).toBe("Publishing");
    expect(getBuildStatusLabel("queued")).toBe("Queued");
    expect(getBuildStatusLabel("succeeded")).toBe("Ready");
    expect(getBuildStatusLabel("failed")).toBe("Failed");
  });

  it("the queued messages describe a configuration, not a build", () => {
    expect(BUILD_PROCESSING_STARTED_MESSAGE).toBe(
      "Your configuration is queued and will publish automatically."
    );
    expect(BUILD_PROCESSING_UNAVAILABLE_MESSAGE).toBe(
      "Your configuration is queued, but publishing could not start automatically."
    );
    for (const message of [
      BUILD_PROCESSING_STARTED_MESSAGE,
      BUILD_PROCESSING_UNAVAILABLE_MESSAGE,
      getBuildRequestSuccessMessage(true),
      getBuildRequestSuccessMessage(false),
    ]) {
      expect(message.toLowerCase()).not.toContain("build");
    }
  });

  it("no customer-facing surface says an owner builds an app", () => {
    const banned = [
      "Build Application",
      "build your app",
      "Build your app",
      "generate app",
      "Generate App",
      "Generated App",
      "custom app",
      "Custom App",
      "APK build",
      "application build",
      "Download your app",
      "Export your POS",
    ];

    for (const file of customerFacingSources()) {
      const source = code(read(file));
      for (const phrase of banned) {
        expect(`${file}: ${source}`).not.toContain(phrase);
      }
    }
  });

  it("the landing page no longer says a project produces an app", () => {
    const howItWorks = read(HOW_IT_WORKS);
    expect(howItWorks).toContain("Install POS Canvas");
    expect(howItWorks).toContain("pair it with your published configuration");
    expect(code(howItWorks)).not.toContain("Download your app");
    expect(code(howItWorks)).not.toContain("Export your POS");
  });
});

// ---------------------------------------------------------------------------
// Platform selector
// ---------------------------------------------------------------------------

describe("no platform target is selectable for a project", () => {
  it("the publish block offers no Android/Desktop choice", () => {
    const panel = code(read(PANEL));
    expect(panel).not.toContain('aria-label="Build target"');
    expect(panel).not.toContain('["android", "desktop"]');
    expect(panel).not.toContain("onBuildTargetChange");
    expect(panel).not.toContain("getBuildTargetLabel");
  });

  it("the word Desktop appears on no customer-facing surface", () => {
    // Publishing has never produced a desktop installer; offering it was a
    // promise nothing could fulfil.
    for (const file of customerFacingSources()) {
      expect(`${file}: ${code(read(file))}`).not.toContain("Desktop");
    }
  });

  it("the target is a fixed internal value, still sent with the request", () => {
    const shell = code(read(SHELL));
    expect(shell).toContain('const selectedBuildTarget: BuildTarget = "android"');
    expect(shell).toContain("target: selectedBuildTarget");
    // Nothing can change it any more.
    expect(shell).not.toContain("setSelectedBuildTarget");
    expect(shell).not.toContain("handleBuildTargetChange");
  });

  it("the internal BuildTarget contract is untouched", () => {
    // The worker still accepts android|desktop; only the customer choice went.
    const buildJobs = code(read("lib/buildJobs.ts"));
    expect(buildJobs).toContain('export type BuildTarget = "android" | "desktop"');
    expect(buildJobs).toContain("getBuildTargetLabel");
  });
});

// ---------------------------------------------------------------------------
// The save/publish rule — behaviour, not wording
// ---------------------------------------------------------------------------

describe("publishing stays blocked while there are unsaved changes", () => {
  const panel = code(read(PANEL));

  it("the publish button is disabled unless eligible", () => {
    expect(panel).toContain("!exportEligibility.canExport ||");
    expect(panel).toContain("buildRequestStatus === \"submitting\"");
  });

  it("the dirty-state message tells the owner to save first", () => {
    expect(panel).toContain("Save your changes before publishing this configuration.");
  });

  it("an unsaved project cannot publish either", () => {
    expect(panel).toContain("Save this project before publishing this configuration.");
  });

  it("no auto-save was introduced", () => {
    // The fix for the dirty state is a disabled button and a sentence, never a
    // silent save the owner did not ask for.
    const shell = code(read(SHELL));
    const handler = shell.slice(
      shell.indexOf("async function handleRequestBuild"),
      shell.indexOf("async function handleRefreshBuildStatus")
    );
    expect(handler).not.toContain("handleSave");
    expect(handler).toContain("!exportEligibility.canExport || projectId === null");
  });

  it("the eligibility rule itself is unchanged", () => {
    const eligibility = code(read("lib/generatedPosConfig.ts"));
    expect(eligibility).toContain('reason: "save-changes-first"');
    expect(eligibility).toContain("input.isDirty");
  });
});

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

describe("device copy uses the publish vocabulary", () => {
  it("the gate reads 'Publish this configuration first'", () => {
    const devices = code(read(DEVICES));
    expect(devices).toContain("Publish this configuration first");
    expect(devices).not.toContain("Build this POS first");
  });

  it("the readiness message points at publishing", () => {
    const readiness = resolvePairingReadiness({ projectId: "p1", jobs: [] });
    expect(readiness.state).toBe("no_succeeded_build");
    expect(readiness.state === "no_succeeded_build" && readiness.message).toContain(
      "Publish this configuration"
    );
  });

  it("the Ready-configuration requirement is unchanged", () => {
    // Wording moved; the rule did not. No published configuration, no pairing.
    expect(resolvePairingReadiness({ projectId: null, jobs: [] }).state).toBe(
      "unsaved_project"
    );
    expect(resolvePairingReadiness({ projectId: "p1", jobs: [] }).state).toBe(
      "no_succeeded_build"
    );
  });
});

// ---------------------------------------------------------------------------
// Artifact vs app
// ---------------------------------------------------------------------------

describe("the configuration download stays distinct from the app download", () => {
  it("the artifact button still says 'Download configuration'", () => {
    // Accurate: it downloads the json_config snapshot, not an installer.
    expect(code(read(PANEL))).toContain("Download configuration");
  });

  it("the app download says 'Download Android APK' and lives elsewhere", () => {
    const card = code(read("components/dashboard/AndroidAppCard.tsx"));
    expect(card).toContain("Download Android APK");
    // The two must never appear on the same surface.
    expect(code(read(PANEL))).not.toContain("Download Android");
    expect(card).not.toContain("Download configuration");
  });

  it("the universal app metadata is still uncoupled from build jobs", () => {
    const release = code(read("lib/androidRelease.ts"));
    for (const banned of ["build_jobs", "buildJob", "projectId", "GeneratedPosConfig"]) {
      expect(release).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// Internal naming is intentionally retained
// ---------------------------------------------------------------------------

describe("internal build naming is deliberately unchanged", () => {
  it("the build job table, actions and worker keep their names", () => {
    expect(code(read("lib/buildJobs.server.ts"))).toContain("createBuildJob");
    expect(code(read("lib/buildJobs.actions.ts"))).toContain("requestBuildJob");
    expect(code(read("lib/buildJobs.ts"))).toContain("BuildStatus");
  });

  it("no migration was renamed for cosmetic consistency", () => {
    const migrations = readdirSync(join(repoRoot, "supabase/migrations")).filter((f) =>
      f.endsWith(".sql")
    );
    expect(migrations.some((f) => f.includes("build_jobs"))).toBe(true);
  });
});
