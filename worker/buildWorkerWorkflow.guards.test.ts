// Feature 17.1 — static security guards for the production build workflow.
//
// Source-level assertions, following this repository's existing guard
// convention (lib/device.guards.test.ts, components/devices/devices.guards.test.ts,
// components/runtime/PosRuntime.layout.test.ts). They exist because the
// properties below are structural: a workflow that gained a pull_request
// trigger, or write permissions, or an echoed secret, would still run perfectly
// well while handing the production service-role credential to code nobody
// reviewed.
//
// WHY NO YAML PARSER: js-yaml is present only as a transitive dependency of
// eslint and ships no type declarations. Depending on it would couple this
// suite to another package's dependency tree and require adding @types purely
// for a test. Every assertion below therefore runs against the workflow TEXT
// with full-line comments stripped — the file has no trailing comments, so
// that stripping is exact, and it keeps the workflow's own explanatory prose
// (which necessarily names the things being forbidden) from tripping a guard.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const raw = readFileSync(join(repoRoot, ".github/workflows/build-worker.yml"), "utf-8");

/** The workflow with comment-only lines removed. */
const wf = raw
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

/**
 * The shell body of the WORKER step, comments stripped.
 *
 * lastIndexOf, not indexOf: Feature 27 added a preflight step whose own
 * `run: |` block now comes first, and anchoring on the first one would have
 * silently pointed every batch assertion below at the wrong script.
 */
const script = (wf.slice(wf.lastIndexOf("run: |")) || "")
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

/** The shell body of the preflight step. */
const preflight = wf.slice(wf.indexOf("run: |"), wf.lastIndexOf("run: |"));

/** The job header — everything before the first step. */
const jobHeader = wf.slice(wf.indexOf("jobs:"), wf.indexOf("    steps:"));

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
  scripts: Record<string, string>;
};

describe("the workflow exists and is well formed", () => {
  it("is present and named", () => {
    expect(raw.length).toBeGreaterThan(0);
    expect(wf).toContain("name: Build worker");
  });

  it("defines exactly one job", () => {
    expect([...wf.matchAll(/^ {2}[a-z-]+:\n\s+name:/gm)]).toHaveLength(1);
    expect(wf).toContain("process-queue:");
  });
});

describe("triggers", () => {
  it("can be dispatched — the only way a run ever starts", () => {
    expect(wf).toMatch(/^\s{2}workflow_dispatch:$/m);
  });

  it("never triggers on pull_request or pull_request_target", () => {
    // pull_request_target is the classic fork-exfiltration vector: it runs in
    // the base repository's context, with access to its secrets.
    expect(wf).not.toMatch(/^\s{2}pull_request:$/m);
    expect(wf).not.toMatch(/^\s{2}pull_request_target:$/m);
    expect(wf).not.toContain("pull_request");
  });

  it("never triggers on push", () => {
    expect(wf).not.toMatch(/^\s{2}push:$/m);
  });

  it("declares no trigger beyond dispatch and the Feature 27 schedule", () => {
    // Top-level trigger keys are the two-space entries between `on:` and the
    // `permissions:` block. An allowlist, so an unconsidered trigger is caught.
    const triggerBlock = wf.slice(wf.indexOf("\non:"), wf.indexOf("\npermissions:"));
    const keys = [...triggerBlock.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
    expect(keys.sort()).toEqual(["schedule", "workflow_dispatch"]);
  });
});

describe("Feature 27 — the schedule is a bounded safety net", () => {
  // 17.2 removed a 15-minute schedule and its reasoning still holds: demand
  // dispatch is the delivery mechanism and normal publishes must never wait for
  // a clock. What 17.2 could not do was recover a job when nobody publishes
  // again — every reclaim and every force-fail lives inside
  // claim_next_build_job, so with dispatch as the only trigger they were all
  // gated on an owner clicking Build. These assertions keep the safety net
  // present AND keep it from growing back into a polling loop.

  it("declares exactly one schedule trigger", () => {
    expect(wf).toMatch(/^\s{2}schedule:$/m);
    expect([...wf.matchAll(/^\s+- cron:/gm)]).toHaveLength(1);
  });

  it("runs hourly at most — never a polling cadence", () => {
    const cron = wf.match(/- cron:\s*"([^"]+)"/)?.[1];

    expect(cron).toBeDefined();

    const [minute, hour] = (cron ?? "").split(" ");

    // A step or a list in the minute field is sub-hourly by definition, and
    // that is the 15-minute polling 17.2 removed.
    expect(minute).not.toContain("*");
    expect(minute).not.toContain("/");
    expect(minute).not.toContain(",");
    expect(minute).not.toContain("-");
    // Every hour, so recovery is guaranteed within one.
    expect(hour).toBe("*");
  });

  it("keeps dispatch as the primary path, not a fallback the cron replaced", () => {
    expect(wf).toMatch(/^\s{2}workflow_dispatch:$/m);
    // The dispatcher still exists and is still what a queued job triggers.
    expect(
      readFileSync(join(repoRoot, "lib/buildJobs.actions.ts"), "utf-8")
    ).toContain("dispatchBuildWorkerWorkflow()");
  });

  it("adds no trigger beyond dispatch and the schedule", () => {
    for (const event of [
      "push",
      "pull_request",
      "pull_request_target",
      "repository_dispatch",
      "workflow_run",
      "workflow_call",
      "issues",
      "release",
    ]) {
      expect(wf).not.toMatch(new RegExp(`^\\s{2}${event}:`, "m"));
    }
  });
});

describe("which backend a run may touch", () => {
  it("offers an explicit environment choice on manual dispatch", () => {
    expect(wf).toMatch(/^\s+environment:$/m);
    expect(wf).toContain("type: choice");
    expect(wf).toContain("- staging");
    expect(wf).toContain("- production");
  });

  it("defaults that choice to staging, so production is always deliberate", () => {
    const inputs = wf.slice(wf.indexOf("inputs:"), wf.indexOf("schedule:"));

    expect(inputs).toContain("default: staging");
    expect(inputs).toContain("required: true");
  });

  it("selects a GitHub Environment rather than reading repo secrets directly", () => {
    // The Environment is what makes the staging/production split enforceable:
    // production's deployment-branch rule confines it to main, which no
    // expression in this file could achieve.
    expect(jobHeader).toContain("environment: ${{");
  });

  it("resolves a SCHEDULED run to production", () => {
    expect(jobHeader).toContain("github.event_name == 'schedule' && 'production'");
  });

  it("resolves a MANUAL run to whatever was chosen", () => {
    expect(jobHeader).toContain("|| inputs.environment");
  });

  it("uses one secret name per variable — no staging/production ternary", () => {
    // A `cond && secrets.STAGING_X || secrets.X` idiom falls through to the
    // PRODUCTION value whenever the staging secret is missing or misnamed. The
    // Environment split exists precisely so that expression is unnecessary.
    expect(wf).not.toContain("STAGING_SUPABASE_URL");
    expect(wf).not.toContain("STAGING_SUPABASE_SERVICE_ROLE_KEY");
    expect(wf).not.toMatch(/secrets\.\w+\s*\|\|\s*secrets\./);
  });
});

describe("Feature 27 — the rollout gate", () => {
  it("gates scheduled runs on an explicit repository variable", () => {
    expect(jobHeader).toContain(
      "if: github.event_name != 'schedule' || vars.BUILD_WORKER_SCHEDULE_ENABLED == 'true'"
    );
  });

  it("treats an unset variable as disabled", () => {
    // `== 'true'` against an unset variable is a comparison with the empty
    // string, so absent means off. A truthiness check would have meant absent
    // reads as on for anything non-empty.
    expect(jobHeader).toContain("== 'true'");
    expect(jobHeader).not.toMatch(/vars\.BUILD_WORKER_SCHEDULE_ENABLED\s*(&&|\)|$)/m);
  });

  it("leaves manual dispatch ungated", () => {
    // The gate holds back autonomous recovery; it must never remove the
    // operator's fallback.
    expect(jobHeader).toContain("github.event_name != 'schedule' ||");
  });

  it("gates at job level, so a disabled run costs no runner minutes", () => {
    const ifAt = jobHeader.indexOf("if: github.event_name");
    const stepsAt = wf.indexOf("    steps:");

    expect(ifAt).toBeGreaterThan(-1);
    expect(ifAt).toBeLessThan(stepsAt);
  });
});

describe("the fail-closed backend preflight", () => {
  it("runs BEFORE anything else, including the install", () => {
    const preflightAt = wf.indexOf("Confirm which backend this run will touch");
    const checkoutAt = wf.indexOf("actions/checkout");
    const workerAt = wf.lastIndexOf("npm run worker:run");

    expect(preflightAt).toBeGreaterThan(-1);
    expect(preflightAt).toBeLessThan(checkoutAt);
    expect(preflightAt).toBeLessThan(workerAt);
  });

  it("derives the project ref from the public URL", () => {
    expect(preflight).toContain('ref="${NEXT_PUBLIC_SUPABASE_URL#https://}"');
    expect(preflight).toContain('ref="${ref%%.*}"');
  });

  it("compares against the expected ref and aborts on a mismatch", () => {
    expect(preflight).toContain('if [ "${ref}" != "${EXPECTED_REF}" ]; then');
    expect(preflight).toContain("exit 1");
  });

  it("aborts when no expectation is configured, rather than guessing", () => {
    expect(preflight).toContain('if [ -z "${EXPECTED_REF}" ]; then');
  });

  it("takes the expected ref from repository variables, not this public file", () => {
    expect(wf).toContain("vars.PRODUCTION_PROJECT_REF");
    expect(wf).toContain("vars.STAGING_PROJECT_REF");
    // The refs themselves must not be hardcoded here.
    expect(wf).not.toContain("xhjadcffrgjpkobniiwz");
    expect(wf).not.toContain("pkwlpstqdqscegfkjnel");
  });

  it("is never given the service-role key", () => {
    // It only needs the URL. Not passing the key is stronger than trusting
    // GitHub's masking to keep it out of the log.
    const step = wf.slice(
      wf.indexOf("Confirm which backend this run will touch"),
      wf.indexOf("Check out the triggering ref")
    );

    expect(step).toContain("NEXT_PUBLIC_SUPABASE_URL:");
    expect(step).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });
});

describe("permissions", () => {
  it("grants read-only access to repository contents", () => {
    expect(wf).toMatch(/^permissions:\n\s+contents: read$/m);
  });

  it("grants no write scope of any kind", () => {
    expect(wf).not.toContain("write-all");
    expect(wf).not.toMatch(/:\s*write$/m);
  });

  it("declares permissions exactly once, so no job-level escalation exists", () => {
    expect([...wf.matchAll(/^\s*permissions:/gm)]).toHaveLength(1);
  });

  it("does not persist git credentials into the workspace", () => {
    expect(wf).toContain("persist-credentials: false");
  });

  it("checks out no explicit ref or repository, so only the default branch runs", () => {
    expect(wf).not.toMatch(/^\s+ref:/m);
    expect(wf).not.toMatch(/^\s+repository:/m);
  });
});

describe("concurrency", () => {
  it("serializes runs", () => {
    expect(wf).toMatch(/^concurrency:\n\s+group: build-worker$/m);
  });

  it("does not cancel a run that may already hold a claim", () => {
    expect(wf).toContain("cancel-in-progress: false");
    expect(wf).not.toContain("cancel-in-progress: true");
  });
});

describe("batch semantics", () => {
  it("invokes the worker a bounded five times", () => {
    expect(script).toContain("for attempt in 1 2 3 4 5;");
  });

  it("uses no unbounded loop construct", () => {
    expect(script).not.toMatch(/\bwhile\b/);
    expect(script).not.toMatch(/\buntil\b/);
    expect(script).not.toMatch(/\bsleep\b/);
  });

  it("fails the run on the first non-zero worker exit", () => {
    expect(script).toContain("set -euo pipefail");
  });

  it("processes BOTH targets", () => {
    // claim_next_build_job is scoped to p_target: an android worker cannot
    // claim a desktop row, cannot reclaim a stale desktop build, and cannot
    // force-fail an exhausted one. Running android only meant desktop jobs sat
    // queued until a human ran the worker by hand.
    expect(script).toContain("for target in android desktop");
    expect(script).toContain('npm run worker:run -- --target "${target}"');
  });

  it("interleaves targets so a backlog on one cannot starve the other", () => {
    // The attempt loop must be OUTSIDE the target loop: five android
    // invocations followed by five desktop ones would let a busy android queue
    // consume the whole run.
    const attemptAt = script.indexOf("for attempt in");
    const targetAt = script.indexOf("for target in");

    expect(attemptAt).toBeGreaterThan(-1);
    expect(targetAt).toBeGreaterThan(attemptAt);
  });

  it("does not parse worker stdout to decide anything", () => {
    // The worker exits 0 both on success and on an empty queue; the two differ
    // only in a JSON log line. That shape is a convention, not a contract, so
    // batching must not depend on it.
    expect(script).not.toContain("grep");
    expect(script).not.toContain("jq");
    expect(script).not.toContain("no_job_available");
    expect(script).not.toMatch(/\|\s*(head|tail|awk|sed)\b/);
  });
});

describe("secrets handling", () => {
  it("supplies both worker variables through the secrets context", () => {
    expect(wf).toContain("NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}");
    expect(wf).toContain("SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}");
  });

  it("passes exactly the two variables the worker reads, and nothing else", () => {
    // lib/supabase/adminConfig.ts reads these two. Anything more would put an
    // unnecessary credential into the environment.
    // The WORKER step's env block: the last `env:` before the last `run: |`.
    // Feature 27's preflight added an earlier env block, and anchoring on the
    // first one pointed this assertion at the wrong step.
    const workerRunAt = wf.lastIndexOf("run: |");
    const envBlock = wf.slice(wf.lastIndexOf("env:", workerRunAt), workerRunAt);
    const keys = [...envBlock.matchAll(/^\s+([A-Z_]+):/gm)].map((m) => m[1]);
    expect(keys.sort()).toEqual(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
  });

  it("never interpolates a secret into command text", () => {
    // An interpolated secret can surface in a shell trace or an error line.
    // Environment injection keeps the value out of the command string itself.
    expect(script).not.toContain("secrets.");
    expect(script).not.toContain("${{");
  });

  it("never echoes, prints or exports a secret value", () => {
    expect(script).not.toMatch(/echo\s+[^\n]*SUPABASE_SERVICE_ROLE_KEY/);
    expect(script).not.toMatch(/echo\s+[^\n]*NEXT_PUBLIC_SUPABASE_URL/);
    expect(script).not.toMatch(/\bset\s+-x\b/);
    expect(script).not.toContain("env |");
    expect(script).not.toContain("printenv");
  });

  it("never exposes the service-role key under a NEXT_PUBLIC_ name", () => {
    expect(wf).not.toMatch(/NEXT_PUBLIC_[A-Z_]*SERVICE_ROLE/);
    expect(wf).not.toMatch(
      /NEXT_PUBLIC_SUPABASE_URL:\s*\$\{\{\s*secrets\.SUPABASE_SERVICE_ROLE_KEY/
    );
  });

  it("contains no hardcoded Supabase credential or project URL", () => {
    expect(raw).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(raw).not.toMatch(/https:\/\/[a-z0-9]{15,}\.supabase\.co/);
    expect(raw).not.toContain("sb_secret");
  });

  it("uploads no artifact and saves no cache, so nothing can carry a secret out", () => {
    expect(wf).not.toContain("upload-artifact");
    expect(wf).not.toContain("cache/save");
  });

  it("runs no third-party action beyond the two official setup actions", () => {
    const uses = [...wf.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    for (const action of uses) {
      expect(action.startsWith("actions/")).toBe(true);
    }
    expect(uses.sort()).toEqual(["actions/checkout@v4", "actions/setup-node@v4"]);
  });

  it("never writes back to the repository", () => {
    expect(wf).not.toContain("git push");
    expect(wf).not.toContain("git commit");
    expect(wf).not.toContain("GITHUB_TOKEN");
  });
});

describe("the npm scripts the workflow depends on", () => {
  it("worker:run uses ambient environment only", () => {
    expect(pkg.scripts["worker:run"]).toBe("node --import tsx worker/once.ts");
    expect(pkg.scripts["worker:run"]).not.toContain("--env-file");
  });

  it("worker:once still loads .env.local, so local development is unchanged", () => {
    expect(pkg.scripts["worker:once"]).toBe(
      "node --env-file=.env.local --import tsx worker/once.ts"
    );
  });

  it("the workflow invokes the ambient-env script, never the local one", () => {
    expect(script).toContain("npm run worker:run --");
    expect(script).not.toContain("worker:once");
  });

  it("installs devDependencies, which tsx is part of", () => {
    expect(wf).toContain("run: npm ci");
    expect(wf).not.toContain("--omit=dev");
    expect(wf).not.toContain("--production");
  });
});
