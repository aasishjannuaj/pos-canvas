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

/** The shell body of the final step, comments stripped. */
const script = (wf.slice(wf.indexOf("run: |")) || "")
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

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

  it("declares no trigger beyond workflow_dispatch", () => {
    // Top-level trigger keys are the two-space entries between `on:` and the
    // `permissions:` block. An allowlist, so an unconsidered trigger is caught.
    const triggerBlock = wf.slice(wf.indexOf("\non:"), wf.indexOf("\npermissions:"));
    const keys = [...triggerBlock.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
    expect(keys.sort()).toEqual(["workflow_dispatch"]);
  });
});

describe("Feature 17.2 — the schedule is gone", () => {
  // The point of 17.2 is that GitHub creates a run ONLY when POS Canvas
  // dispatches one, or when an operator clicks Run workflow. A schedule
  // reintroduced by a later edit would restore the 15-minute polling this
  // feature exists to remove, and would do it silently: everything would still
  // work, just wastefully. These four assertions are the tripwire.

  it("declares no schedule trigger", () => {
    expect(wf).not.toMatch(/^\s{2}schedule:$/m);
    expect(wf).not.toContain("schedule:");
  });

  it("contains no cron expression at all", () => {
    expect(wf).not.toContain("cron");
    expect([...wf.matchAll(/cron:/g)]).toHaveLength(0);
  });

  it("has no trigger that fires without an explicit request", () => {
    // Every event that can start a run on its own. workflow_dispatch and
    // repository_dispatch are the two request-driven ones; only the first is
    // allowed here (repository_dispatch would need a differently scoped token).
    for (const event of [
      "schedule",
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

  it("keeps manual dispatch as the emergency fallback", () => {
    // If POS Canvas cannot reach the GitHub API, this is the only remaining way
    // to drain the queue — so removing it would leave no recovery path at all.
    expect(wf).toMatch(/^\s{2}workflow_dispatch:$/m);
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

  it("targets Android only", () => {
    expect(script).toContain("--target android");
    expect(script).not.toContain("--target desktop");
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
    const envBlock = wf.slice(wf.indexOf("env:"), wf.indexOf("run: |"));
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
