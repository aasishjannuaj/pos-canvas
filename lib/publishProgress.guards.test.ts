// Feature 24.6 — structural guards for the publishing experience.
//
// This repository tests React by reading its source: vitest runs in the node
// environment and there is no DOM harness (see the comment in vitest.config).
// The properties below are exactly the ones a render test would check and a type
// checker cannot — that polling stops, that it cannot publish, and that the UI
// never invents progress it does not have.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf-8");

/** Source with comments stripped, so prose cannot satisfy an assertion. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const SHELL = "components/editor/EditorShell.tsx";
const PANEL = "components/editor/EditorPropertiesPanel.tsx";
const STEPS = "components/editor/PublishProgressSteps.tsx";
const MODEL = "lib/publishProgress.ts";

describe("the publish watcher is a single, self-terminating loop", () => {
  it("reschedules with setTimeout after each read, never on an interval", () => {
    const shell = code(read(SHELL));

    // setInterval would let a slow response stack a second request behind the
    // first; rescheduling after completion cannot.
    expect(shell).not.toContain("setInterval");
    expect(shell).toContain("PUBLISH_POLL_INTERVAL_MS");
  });

  it("stops at a terminal status instead of polling forever", () => {
    const shell = code(read(SHELL));
    const effect = shell.slice(shell.indexOf("const job = latestBuildJob;"));

    // Guarded twice: the effect refuses to start on a terminal job, and the tick
    // returns before rescheduling when a read comes back terminal.
    expect(effect).toContain("isTerminalBuildStatus(job.status)");
    expect(effect).toContain("isTerminalBuildStatus(result.job.status)");
  });

  it("tears the loop down on unmount", () => {
    const shell = code(read(SHELL));
    const effect = shell.slice(shell.indexOf("const job = latestBuildJob;"));
    const cleanup = effect.slice(effect.indexOf("return () => {"));

    expect(cleanup).toContain("cancelled = true");
    expect(cleanup).toContain("clearTimeout(timer)");
    expect(cleanup).toContain('removeEventListener("visibilitychange"');
  });

  it("never lets two reads overlap", () => {
    const effect = code(read(SHELL)).slice(
      code(read(SHELL)).indexOf("const job = latestBuildJob;")
    );

    expect(effect).toContain("pollInFlight.current");
  });

  it("skips a hidden tab and reads immediately when it comes back", () => {
    const effect = code(read(SHELL)).slice(
      code(read(SHELL)).indexOf("const job = latestBuildJob;")
    );

    expect(effect).toContain("document.hidden");
    expect(effect).toContain('addEventListener("visibilitychange"');
  });

  it("CANNOT publish — it only ever re-reads the job on screen", () => {
    const effect = code(read(SHELL)).slice(
      code(read(SHELL)).indexOf("const job = latestBuildJob;")
    );

    // The single most important property here. A loop that could reach
    // requestBuildJob would create a publish per tick.
    expect(effect).toContain("refreshBuildJobStatus(job.id)");
    expect(effect).not.toContain("requestBuildJob");
    expect(effect).not.toContain("startBuildProcessing");
  });
});

describe("the owner's actions stay distinct", () => {
  it("manual Refresh re-reads and never requests a publish", () => {
    const shell = code(read(SHELL));
    const handler = shell.slice(
      shell.indexOf("async function handleRefreshBuildStatus()"),
      shell.indexOf("async function handleDownloadArtifact()")
    );

    expect(handler).toContain("refreshBuildJobStatus(latestBuildJob.id)");
    expect(handler).not.toContain("requestBuildJob");
  });

  it("Retry processing re-dispatches the SAME job and creates no second one", () => {
    const shell = code(read(SHELL));
    const handler = shell.slice(
      shell.indexOf("async function handleRetryBuildProcessing()"),
      shell.indexOf("async function handleRefreshBuildStatus()")
    );

    expect(handler).toContain("startBuildProcessing(latestBuildJob.id)");
    expect(handler).not.toContain("requestBuildJob");
  });

  it("Publish cannot double-submit", () => {
    const panel = code(read(PANEL));

    // The button is disabled for the whole in-flight window, so a second click
    // cannot start a second request.
    expect(panel).toContain('buildRequestStatus === "submitting"');
    expect(panel).toContain("disabled=");
  });

  it("Refresh and Retry disable themselves while running", () => {
    const panel = code(read(PANEL));

    expect(panel).toContain("disabled={isRefreshingBuildStatus}");
    expect(panel).toContain("disabled={isRetryingBuildProcessing}");
  });
});

describe("the stepper claims only what is known", () => {
  it("invents no percentage and draws no progress bar", () => {
    const steps = code(read(STEPS));
    const model = code(read(MODEL));

    for (const source of [steps, model]) {
      expect(source).not.toContain("%");
      expect(source).not.toContain('role="progressbar"');
      expect(source).not.toContain("aria-valuenow");
    }
  });

  it("decides no stage for itself", () => {
    const steps = code(read(STEPS));

    // Every stage decision comes from the pure model, so the component cannot
    // disagree with the job the panel is showing.
    expect(steps).toContain("describePublishStageState");
    expect(steps).not.toContain('job.status');
    expect(steps).not.toContain('"building"');
    expect(steps).not.toContain('"succeeded"');
  });

  it("conveys state without relying on colour alone", () => {
    const steps = code(read(STEPS));

    // A visually-hidden word per row, so the timeline reads the same to a screen
    // reader and to someone who cannot separate the colours.
    expect(steps).toContain("STATE_WORDS");
    expect(steps).toContain("sr-only");
  });

  it("renders nothing before an owner has asked for anything", () => {
    const steps = code(read(STEPS));

    expect(steps).toContain('progress.kind === "idle"');
    expect(steps).toContain("return null");
  });
});

describe("the success wording stays honest", () => {
  it("never implies a binary was produced", () => {
    const model = read(MODEL);
    const panel = read(PANEL);

    for (const forbidden of [
      "app has been built",
      "APK ready",
      "application generated",
      "your app is ready",
    ]) {
      expect(model).not.toContain(forbidden);
      expect(panel).not.toContain(forbidden);
    }
  });
});
