// Feature 25.6 — the stale-publish refusal, as WIRED.
//
// decideExistingBuildJob is pure and tested by execution next door. What a node
// test cannot execute is the server action around it and the editor that
// consumes the result, so those are asserted by reading their source — which is
// where the original defect lived: the decision was never wrong, it was simply
// not made.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf-8");
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const SERVER = "lib/buildJobs.server.ts";
const MODEL = "lib/buildJobs.ts";
const SHELL = "components/editor/EditorShell.tsx";

describe("every reuse path consults the configuration", () => {
  it("the lookup reports WHICH arm matched, not a collapsed job", () => {
    const server = code(read(SERVER));

    // THE NEGATIVE CONTROL. Collapsing the two arms again is how the hash
    // comparison becomes impossible to make.
    expect(server).toContain("byRequestKey: BuildJobSummary | null;");
    expect(server).toContain("activeForTarget: BuildJobSummary | null;");
    expect(server).not.toContain("if (earlyLookup.job)");
    expect(server).not.toContain("if (recovery.job)");
  });

  it("both reuse sites go through decideExistingBuildJob", () => {
    const server = code(read(SERVER));
    const calls = server.match(/decideExistingBuildJob\(\{/g) ?? [];

    // Early lookup, the deferred settle, and the post-insert recovery.
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it("no reuse is returned without a decision behind it", () => {
    const server = code(read(SERVER));

    for (const match of server.matchAll(/reusedExisting: true/g)) {
      const before = server.slice(Math.max(0, match.index! - 260), match.index!);

      expect(`reuse at ${match.index} is decided`).toBe(`reuse at ${match.index} is decided`);
      expect(before).toContain('outcome === "reuse"');
    }
  });

  it("the early pass cannot reuse an active job without the hash", () => {
    const server = code(read(SERVER));
    const early = server.slice(server.indexOf("const earlyDecision"), server.indexOf("const configHash"));

    // It is called with a null hash on purpose, so only a request-key match
    // can short-circuit; an active job falls through to the comparison.
    expect(early).toContain("submittedConfigHash: null");
    expect(early).toContain('earlyDecision.outcome === "reuse"');
  });

  it("the deferred case is settled once the hash exists", () => {
    const server = code(read(SERVER));
    const hashAt = server.indexOf("const configHash = computeGeneratedPosConfigHash");
    const settleAt = server.indexOf('earlyDecision.outcome === "hash_required"');

    expect(hashAt).toBeGreaterThan(-1);
    expect(settleAt).toBeGreaterThan(hashAt);
    // And it is settled BEFORE anything is inserted.
    expect(settleAt).toBeLessThan(server.indexOf('.from("build_jobs")\n    .insert('));
  });
});

describe("the refusal is a conflict, and changes nothing", () => {
  it("returns the typed conflict code with the fixed copy", () => {
    const server = code(read(SERVER));

    expect(server).toContain('errorCode: "active_job_exists"');
    expect(server).toContain("message: PUBLISH_IN_PROGRESS_MESSAGE");
  });

  it("never mutates, cancels or re-snapshots the stale job", () => {
    const server = code(read(SERVER));

    // No status transition and no snapshot rewrite exists anywhere in this
    // module — the stale job is left running exactly as it was.
    expect(server).not.toContain('status: "cancelled"');
    expect(server).not.toContain("cancelled");
    expect(server).not.toMatch(/\.update\(\{[\s\S]{0,200}config_snapshot/);
  });

  it("the conflict message is a constant, never a database string", () => {
    const server = code(read(SERVER));
    const model = code(read(MODEL));

    expect(model).toContain("export const PUBLISH_IN_PROGRESS_MESSAGE");
    // The raw insert error is never surfaced.
    expect(server).not.toContain("message: insertError.message");
    expect(server).not.toContain("insertError.details");
  });
});

describe("the stepper never follows a stale job", () => {
  it("a failed request sets the error and returns before touching build state", () => {
    const shell = code(read(SHELL));
    const submit = shell.slice(shell.indexOf("const result = await requestBuildJob({"));
    const failure = submit.slice(submit.indexOf("if (!result.ok) {"), submit.indexOf("setPendingRequestKey(null)"));

    expect(failure).toContain('setBuildRequestStatus("error")');
    expect(failure).toContain("setBuildRequestError(result.message)");
    expect(failure).toContain("return;");
    // The three things that would attach the stepper to the stale job.
    expect(failure).not.toContain("setLatestBuildJob(");
    expect(failure).not.toContain("setBuildProcessing(");
    expect(failure).not.toContain('setBuildRequestStatus("success")');
  });

  it("the progress stepper is driven by the job the request returned", () => {
    const shell = code(read(SHELL));

    // No job on a conflict means no progress to render for one.
    expect(shell).toContain("setLatestBuildJob(result.job)");
    expect(shell).toContain("resolvePublishProgress({");
  });
});
