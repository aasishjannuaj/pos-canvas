// Feature 17.2 — static security guards for the GitHub dispatch path.
//
// Source-level assertions, following this repository's existing guard
// convention (lib/device.guards.test.ts, worker/buildWorkerWorkflow.guards.test.ts).
// They exist because the properties below are structural: a token that reached
// the browser bundle, or that got interpolated into a log line, would leave
// every test passing and every build working, while handing out a credential
// that can start workflow runs in the production repository.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf-8");
}

/** Strips comments so prose naming a banned thing never trips a guard. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Every .ts/.tsx file under lib/ and components/, recursively. */
function sourceFiles(relativeDir: string): string[] {
  const absolute = join(repoRoot, relativeDir);
  return readdirSync(absolute).flatMap((entry) => {
    const relative = join(relativeDir, entry);
    if (statSync(join(absolute, entry)).isDirectory()) {
      return sourceFiles(relative);
    }
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [relative] : [];
  });
}

const ALL_SOURCES = [...sourceFiles("lib"), ...sourceFiles("components")];

const TOKEN_VAR = "GITHUB_BUILD_WORKER_TOKEN";
const SERVER_MODULE = "lib/githubBuildWorker.server.ts";
const PURE_MODULE = "lib/githubBuildWorker.ts";

const serverSource = code(read(SERVER_MODULE));
const pureSource = code(read(PURE_MODULE));

describe("the GitHub token is server-only", () => {
  it("the dispatcher declares itself server-only", () => {
    // Next.js fails the build if a client component pulls this in, which is the
    // mechanism that makes every other assertion here enforceable at all.
    expect(serverSource).toContain('import "server-only"');
  });

  it("exactly one source file names the token variable", () => {
    const naming = ALL_SOURCES.filter((file) => read(file).includes(TOKEN_VAR));
    expect(naming).toEqual([SERVER_MODULE]);
  });

  it("the token variable is never NEXT_PUBLIC_-prefixed anywhere", () => {
    // A NEXT_PUBLIC_ variable is inlined into client JavaScript by definition,
    // so this prefix would publish the credential to every visitor.
    for (const file of ALL_SOURCES) {
      expect(read(file)).not.toContain(`NEXT_PUBLIC_${TOKEN_VAR}`);
      expect(read(file)).not.toMatch(/NEXT_PUBLIC_GITHUB/);
    }
  });

  it("no client component reaches the dispatcher", () => {
    for (const file of ALL_SOURCES) {
      const raw = read(file);
      if (!raw.includes('"use client"')) continue;
      expect(code(raw)).not.toContain("@/lib/githubBuildWorker.server");
    }
  });

  it("only the server action imports the dispatcher", () => {
    const importers = ALL_SOURCES.filter((file) =>
      code(read(file)).includes("@/lib/githubBuildWorker.server")
    );
    expect(importers).toEqual(["lib/buildJobs.actions.ts"]);
    expect(read("lib/buildJobs.actions.ts").startsWith('"use server"')).toBe(true);
  });

  it("the token is read inside a function, never captured at module scope", () => {
    // A module-scope read would freeze the value at import time and put it in a
    // module binding that survives for the life of the process.
    const moduleScope = serverSource.slice(
      0,
      serverSource.indexOf("export async function")
    );
    expect(moduleScope).not.toContain("process.env[");
    expect(moduleScope).not.toContain("process.env.");
  });
});

describe("the token is never emitted", () => {
  // The token binding is named `token`; every use of it must be accounted for.
  const tokenUses = [...serverSource.matchAll(/\btoken\b/g)];

  it("appears in the Authorization header and nowhere else that leaves the process", () => {
    expect(serverSource).toContain("Authorization: `Bearer ${token}`");
    // Declaration, the two typeof/trim validity checks, and the header.
    expect(tokenUses.length).toBeLessThanOrEqual(6);
  });

  it("is never logged", () => {
    for (const line of serverSource.split("\n")) {
      if (!line.includes("console.")) continue;
      expect(line).not.toContain("token");
      expect(line).not.toContain(TOKEN_VAR + "}");
    }
    // No template literal anywhere in a console call may interpolate it.
    expect(serverSource).not.toMatch(/console\.[a-z]+\([^)]*\$\{token/);
  });

  it("is never returned to a caller", () => {
    // Every return in this module is a WorkflowDispatchOutcome: {ok} plus an
    // enum reason. No branch may return a string built from the token.
    const returns = [...serverSource.matchAll(/return\s+([^;]+);/g)].map((m) => m[1]);
    for (const returned of returns) {
      expect(returned).not.toContain("token");
      expect(returned).not.toContain("Authorization");
      expect(returned).not.toContain("response");
    }
  });

  it("never reads the GitHub response body or status text", () => {
    // A body or statusText could be echoed into a log; only the numeric status
    // is ever consulted, and it carries nothing sensitive.
    expect(serverSource).not.toContain(".text()");
    expect(serverSource).not.toContain(".json()");
    expect(serverSource).not.toContain("statusText");
    expect(serverSource).toContain("response.status");
  });

  it("never inspects the caught error, which can carry the request headers", () => {
    // `catch {}` with no binding: a fetch TypeError can reference the Request it
    // came from, and that Request holds the Authorization header.
    expect(serverSource).toMatch(/\}\s*catch\s*\{/);
    expect(serverSource).not.toMatch(/catch\s*\(\s*[a-z]/i);
  });
});

describe("the pure contract module holds no credential", () => {
  it("reads no environment variable and performs no I/O", () => {
    expect(pureSource).not.toContain("process.env");
    expect(pureSource).not.toContain("fetch(");
    expect(pureSource).not.toContain("Authorization");
    expect(pureSource).not.toContain("token");
  });

  it("pins the ref to the default branch", () => {
    // Dispatching another ref would run that ref's version of the workflow with
    // the production service-role secrets attached.
    expect(pureSource).toContain('GITHUB_BUILD_WORKER_REF = "main"');
  });
});

describe("the request is shaped the way GitHub requires", () => {
  it("POSTs with the versioned Accept header and a User-Agent", () => {
    expect(serverSource).toContain('method: "POST"');
    expect(serverSource).toContain('Accept: "application/vnd.github+json"');
    expect(serverSource).toContain('"X-GitHub-Api-Version": GITHUB_API_VERSION');
    // GitHub rejects API requests without a User-Agent.
    expect(serverSource).toContain('"User-Agent"');
  });

  it("bounds the call so a slow GitHub cannot hold the Build click open", () => {
    expect(serverSource).toContain("AbortSignal.timeout");
    expect(serverSource).toContain("DISPATCH_TIMEOUT_MS");
  });

  it("opts out of fetch caching, since a dispatch is a side effect", () => {
    expect(serverSource).toContain('cache: "no-store"');
  });

  it("targets the URL from the pure module rather than rebuilding one", () => {
    expect(serverSource).toContain("fetch(GITHUB_BUILD_WORKER_DISPATCH_URL");
    expect(serverSource).not.toContain("api.github.com");
  });
});

describe("the database build job stays the source of truth", () => {
  const actions = code(read("lib/buildJobs.actions.ts"));

  it("dispatches only after createBuildJob has returned", () => {
    // Ordering is the whole design: the row is committed before GitHub is
    // contacted, so GitHub's availability is never an input to whether a
    // customer's build exists.
    const create = actions.indexOf("await createBuildJob");
    const trigger = actions.indexOf("triggerBuildProcessing(result.job.status)");
    expect(create).toBeGreaterThan(-1);
    expect(trigger).toBeGreaterThan(create);
  });

  it("does not dispatch when no build was queued", () => {
    // The !result.ok branch returns before reaching the trigger.
    const failureBranch = actions.slice(
      actions.indexOf("if (!result.ok)"),
      actions.indexOf("triggerBuildProcessing(result.job.status)")
    );
    expect(failureBranch).toContain("return result;");
    expect(failureBranch).not.toContain("dispatchBuildWorkerWorkflow");
  });

  it("never deletes, fails or otherwise mutates a job because of a dispatch result", () => {
    // A failed dispatch must leave a perfectly valid queued build alone.
    expect(actions).not.toContain(".delete(");
    expect(actions).not.toContain(".update(");
    expect(actions).not.toContain("failBuildJob");
    expect(actions).not.toContain('status: "failed"');
  });

  it("gates the dispatch on the shared status predicate", () => {
    expect(actions).toContain("needsBuildProcessing(status)");
  });

  it("drops the failure reason before it can reach a browser", () => {
    // WorkflowDispatchFailureReason is an operator diagnostic. The action
    // collapses it to started/unavailable and returns no reason field.
    expect(actions).toContain('dispatch.ok ? "started" : "unavailable"');
    expect(actions).not.toContain("dispatch.reason");
    expect(actions).not.toContain("not_configured");
  });
});

describe("retrying processing never creates a second build", () => {
  const actions = code(read("lib/buildJobs.actions.ts"));
  const retry = actions.slice(actions.indexOf("export async function startBuildProcessing"));

  it("contains no build-creation path at all", () => {
    expect(retry).not.toContain("createBuildJob");
    expect(retry).not.toContain("requestKey");
    expect(retry).not.toContain(".insert(");
  });

  it("acts on an existing job id, validated before any lookup", () => {
    expect(retry).toContain("isValidUuid(buildJobId)");
    expect(retry).toContain("getBuildJobById(buildJobId)");
  });

  it("reuses the same trigger and the same status gate as the request path", () => {
    // Two dispatch paths that disagreed about when to fire would eventually
    // disagree about the stale-recovery case, which is the one that matters.
    expect(retry).toContain("triggerBuildProcessing(job.status)");
  });

  it("returns one sanitized message for every failure", () => {
    expect(retry).toContain("BUILD_PROCESSING_RETRY_FAILED_MESSAGE");
    // A missing job and one belonging to another owner must stay
    // indistinguishable, exactly as getBuildJobById already guarantees.
    const failures = [...retry.matchAll(/ok: false,\s*message: ([A-Z_]+)/g)].map(
      (m) => m[1]
    );
    expect(new Set(failures)).toEqual(new Set(["BUILD_PROCESSING_RETRY_FAILED_MESSAGE"]));
  });

  it("the Builder retries the displayed job's own id, never a fresh request", () => {
    const shell = code(read("components/editor/EditorShell.tsx"));
    const handler = shell.slice(
      shell.indexOf("async function handleRetryBuildProcessing"),
      shell.indexOf("// Feature 15.7 — the artifact download handler")
    );
    expect(handler).toContain("startBuildProcessing(latestBuildJob.id)");
    expect(handler).not.toContain("requestBuildJob");
  });
});

describe("the queued build copy no longer promises a start time", () => {
  const panelCode = code(read("components/editor/EditorPropertiesPanel.tsx"));
  // Comment-stripped for the same reason every other guard in this repository
  // strips them: lib/buildJobs.ts documents WHY the 15-minute estimate was
  // removed, and that explanation must not trip the guard that removed it.
  const copy = code(read("lib/buildJobs.ts"));

  it("the 15-minute estimate is gone from the Builder", () => {
    // It described a polling schedule that no longer exists.
    expect(panelCode).not.toContain("15 minutes");
    expect(panelCode).not.toContain("about 15");
    expect(panelCode).not.toMatch(/usually starts within/i);
  });

  it("no user-facing copy quotes a cadence or a duration at all", () => {
    for (const source of [copy, panelCode]) {
      expect(source).not.toMatch(/\b\d+\s*(minutes?|hours?)\b/);
    }
  });

  it("says processing starts automatically", () => {
    expect(copy).toContain(
      "Your build is queued and processing will start automatically."
    );
    expect(panelCode).toContain("BUILD_PROCESSING_STARTED_MESSAGE");
  });

  it("has distinct copy for a build that was queued but not started", () => {
    expect(copy).toContain(
      "Your build is queued, but automatic processing could not be started."
    );
    expect(panelCode).toContain("getBuildProcessingUnavailableMessage");
  });

  it("never tells an owner a building job is queued", () => {
    // The panel's own Status row says "Building" at the same moment, so reusing
    // the queued sentence there would contradict the line above it.
    expect(copy).toContain("BUILD_PROCESSING_STALLED_MESSAGE");
    expect(panelCode).toContain("getBuildProcessingUnavailableMessage(");
    expect(panelCode).toContain("latestBuildJob.status");
  });

  it("offers Retry processing, and only in the unavailable state", () => {
    expect(panelCode).toContain("Retry processing");
    expect(panelCode).toContain('buildProcessing === "unavailable"');
    expect(panelCode).toContain("onRetryBuildProcessing");
  });

  it("does not show the started copy while the trigger is known to have failed", () => {
    // Both messages at once would be self-contradicting.
    expect(panelCode).toContain('buildProcessing !== "unavailable"');
  });

  it("never surfaces a GitHub concept to the owner", () => {
    // The owner asked for a build, not for a CI run. Nothing about GitHub,
    // Actions, workflows, tokens or HTTP belongs in this panel.
    for (const term of ["GitHub", "workflow", "Actions run", "dispatch", "HTTP"]) {
      expect(panelCode).not.toContain(term);
    }
  });
});
