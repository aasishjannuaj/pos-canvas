// Feature 27 — publish self-healing.
//
// WHAT THIS FEATURE ACTUALLY CHANGED, recorded here because the answer is
// surprising and a future reader will otherwise look for code that is not
// there: almost nothing. Reclaiming a dead worker's build, the three-attempt
// cap, force-failing an exhausted job to worker_timeout, exclusive claim
// tokens and fail-closed leases were all already implemented inside
// claim_next_build_job and are untouched. The gap was never the recovery — it
// was that nothing CALLED it.
//
// Feature 17.2 made the worker demand-triggered and removed the schedule, which
// fixed latency and left every recovery path gated on an owner clicking Build.
// A publish whose dispatch failed, or whose runner died, stayed stuck until a
// human noticed. On top of that the workflow only ever ran `--target android`,
// so for desktop the recovery machinery had in effect never run at all.
//
// So these tests are mostly about the TRIGGER and about the SQL contract they
// depend on. Where they read migration SQL they are pinning a contract this
// feature relies on rather than one it wrote — if that contract changes, the
// safety net is no longer sufficient and this should fail.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  PUBLISH_TIMED_OUT_MESSAGE,
  describePublishFailure,
} from "@/lib/publishProgress";
import { isTerminalBuildStatus, needsBuildProcessing } from "@/lib/buildJobs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf-8");

/** Strips comments, so prose can never satisfy a source assertion. */
function code(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const workflow = read(".github/workflows/build-worker.yml");
const claimSql = read(
  "supabase/migrations/20260729175512_build_job_worker_claiming.sql"
);

/** The claim function's body, where every recovery rule lives. */
const claimFn = claimSql.slice(
  claimSql.indexOf("create or replace function claim_next_build_job"),
  claimSql.indexOf("revoke all on function claim_next_build_job")
);

// ---------------------------------------------------------------------------
// The trigger — the only thing this feature adds
// ---------------------------------------------------------------------------

describe("something calls the recovery even when nobody publishes", () => {
  it("has a schedule, so recovery is not gated on an owner clicking Build", () => {
    expect(workflow).toMatch(/^\s{2}schedule:$/m);
    expect(workflow).toMatch(/- cron:/);
  });

  it("does not depend on a browser staying open", () => {
    // The publish panel polls, but only to READ. If polling could dispatch, a
    // closed laptop would still be the thing recovery depended on.
    const panel = code(read("components/editor/EditorShell.tsx"));

    expect(panel).not.toContain("dispatchBuildWorkerWorkflow");
    expect(panel).toContain("refreshBuildJobStatus");
  });

  it("recovers BOTH targets, because claiming is target-scoped", () => {
    // The bug: an android worker cannot claim, reclaim or force-fail a desktop
    // row, so `--target android` alone left desktop entirely unserviced.
    expect(claimFn).toContain("build_jobs.target = p_target");
    expect(workflow).toContain("for target in android desktop");
  });

  it("stays bounded — no polling loop, no unbounded worker", () => {
    expect(workflow).toContain("for attempt in 1 2 3 4 5");
    expect(workflow).not.toContain("while true");
    expect(workflow).not.toContain("sleep");
    // One cadence, not several.
    expect([...workflow.matchAll(/^\s+- cron:/gm)]).toHaveLength(1);
  });

  it("adds no second queue — build_jobs remains the only source of truth", () => {
    expect(workflow).toContain("npm run worker:run");
    for (const other of ["redis", "sqs", "rabbit", "bullmq", "pg_cron", "pgboss"]) {
      expect(workflow.toLowerCase()).not.toContain(other);
    }
  });
});

// ---------------------------------------------------------------------------
// The recovery contract this feature relies on
// ---------------------------------------------------------------------------

describe("stale building jobs are reclaimed, fresh ones are not", () => {
  it("reclaims only an EXPIRED lease under the attempt cap", () => {
    // All three conditions matter. Dropping the lease check would let a live
    // worker's job be stolen; dropping the cap would retry forever.
    expect(claimFn).toContain("bj.status = 'building'");
    expect(claimFn).toContain("bj.lease_expires_at < now()");
    expect(claimFn).toContain("bj.attempt_count < 3");
  });

  it("leaves a non-stale building job alone", () => {
    // The candidate CTE has no branch that selects `building` without an
    // expired lease — a currently-leased job is simply not eligible.
    const candidate = claimFn.slice(
      claimFn.indexOf("candidate as ("),
      claimFn.indexOf("order by bj.created_at")
    );

    expect(candidate).toContain("lease_expires_at < now()");
    expect(candidate.match(/status = 'building'/g)).toHaveLength(1);
  });

  it("force-fails an exhausted stale job rather than retrying it forever", () => {
    expect(claimFn).toContain("build_jobs.attempt_count >= 3");
    expect(claimFn).toContain("failure_code = 'worker_timeout'");
    expect(claimFn).toContain("status = 'failed'");
  });

  it("never marks unfinished work as succeeded", () => {
    expect(claimFn).not.toContain("'succeeded'");
  });

  it("counts every attempt, so the budget cannot be evaded", () => {
    expect(claimFn).toContain("attempt_count = build_jobs.attempt_count + 1");
  });
});

describe("two workers cannot process one job", () => {
  it("locks the candidate with FOR UPDATE SKIP LOCKED", () => {
    expect(claimFn).toContain("for update skip locked");
  });

  it("mints a fresh claim token on every claim", () => {
    expect(claimFn).toContain("claim_token = gen_random_uuid()");
  });

  it("makes the previous owner fail closed once reclaimed", () => {
    // heartbeat, fail and finalize each require the exact current token AND an
    // unexpired lease, so a worker that lost ownership can mutate nothing —
    // including finishing a build it thinks it still owns.
    for (const fn of ["heartbeat_build_job", "fail_build_job"]) {
      const body = claimSql.slice(
        claimSql.indexOf(`create or replace function ${fn}`),
        claimSql.indexOf(`revoke all on function ${fn}`)
      );

      expect(body).toContain("claim_token = p_claim_token");
      expect(body).toContain("lease_expires_at > now()");
    }

    const finalize = read(
      "supabase/migrations/20260729190422_build_artifact_storage.sql"
    );

    expect(finalize).toContain("claim_token = p_claim_token");
    expect(finalize).toContain("status = 'building'");
  });

  it("grants the claim RPC to service_role only, never to a browser role", () => {
    expect(claimSql).toContain(
      "revoke execute on function claim_next_build_job(text, text, integer) from anon, authenticated;"
    );
    expect(claimSql).toContain(
      "grant execute on function claim_next_build_job(text, text, integer) to service_role;"
    );
  });
});

// ---------------------------------------------------------------------------
// Recovery creates no duplicates
// ---------------------------------------------------------------------------

describe("recovery is idempotent and creates nothing", () => {
  it("claiming only UPDATEs — it never inserts a build row", () => {
    expect(claimFn).not.toMatch(/insert\s+into\s+build_jobs/i);
  });

  it("keeps the active-target uniqueness that prevents a duplicate publish", () => {
    const schema = read(
      "supabase/migrations/20260729151600_build_jobs_and_artifacts.sql"
    );

    expect(schema).toContain("create unique index if not exists build_jobs_active_target_unique");
    expect(schema).toContain("where status in ('queued', 'building')");
  });

  it("dispatches without naming a job, so a duplicate dispatch is harmless", () => {
    // A dispatch is a content-free "there is work" signal; the worker decides
    // what to claim. Two dispatches therefore cannot process one job twice.
    const dispatcher = code(read("lib/githubBuildWorker.server.ts"));

    expect(dispatcher).not.toContain("buildJobId");
    expect(dispatcher).not.toContain("projectId");
  });

  it("still reuses an existing active job rather than making a second one", () => {
    expect(code(read("lib/buildJobs.ts"))).toContain("decideExistingBuildJob");
    expect(code(read("lib/buildJobs.server.ts"))).toContain("byRequestKey");
  });
});

// ---------------------------------------------------------------------------
// What the owner sees
// ---------------------------------------------------------------------------

describe("an exhausted publish is actionable, not a dead end", () => {
  it("tells the owner retries are used up and to publish again", () => {
    expect(
      describePublishFailure({
        failureCode: "worker_timeout",
        failureMessage: "Build processing stopped before completion.",
      })
    ).toBe(PUBLISH_TIMED_OUT_MESSAGE);

    expect(PUBLISH_TIMED_OUT_MESSAGE).toContain("Publish again");
  });

  it("keeps the server's own message for every other failure", () => {
    // Those are specific to the build; generic advice would be a downgrade.
    for (const failureCode of [
      "invalid_config",
      "signing_failed",
      "artifact_upload_failed",
    ] as const) {
      expect(
        describePublishFailure({ failureCode, failureMessage: "Specific reason." })
      ).toBe("Specific reason.");
    }
  });

  it("says nothing when there is nothing to say", () => {
    expect(
      describePublishFailure({ failureCode: null, failureMessage: null })
    ).toBeNull();
  });

  it("leaks no worker internals to the owner", () => {
    for (const leak of ["claim", "lease", "heartbeat", "worker_timeout", "attempt"]) {
      expect(PUBLISH_TIMED_OUT_MESSAGE.toLowerCase()).not.toContain(leak);
    }
  });

  it("lets a failed job be published again — failed is not active", () => {
    // The uniqueness index covers queued and building only, so a terminal job
    // does not block the next publish. That IS the actionable retry.
    expect(isTerminalBuildStatus("failed")).toBe(true);
    expect(needsBuildProcessing("failed")).toBe(false);
    expect(needsBuildProcessing("queued")).toBe(true);
    expect(needsBuildProcessing("building")).toBe(true);
  });

  it("keeps manual Retry processing working alongside automatic recovery", () => {
    const actions = code(read("lib/buildJobs.actions.ts"));

    expect(actions).toContain("needsBuildProcessing");
    expect(actions).toContain("dispatchBuildWorkerWorkflow()");
    // And it still creates no second row.
    const retry = actions.slice(actions.indexOf("retryBuildProcessing"));
    expect(retry).not.toMatch(/insert/i);
  });
});

// ---------------------------------------------------------------------------
// Nothing privileged leaked toward the browser
// ---------------------------------------------------------------------------

describe("the recovery path stays server-side", () => {
  it("keeps the GitHub token in the one server-only module", () => {
    const dispatcher = read("lib/githubBuildWorker.server.ts");

    expect(dispatcher).toContain('import "server-only"');
    expect(dispatcher).not.toContain("NEXT_PUBLIC_GITHUB");
  });

  it("puts no service-role credential in any client component", () => {
    for (const file of [
      "components/editor/EditorShell.tsx",
      "components/editor/EditorPropertiesPanel.tsx",
    ]) {
      const source = code(read(file));

      expect(source).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
      expect(source).not.toContain("createAdminClient");
      expect(source).not.toContain("GITHUB_BUILD_WORKER_TOKEN");
    }
  });

  it("passes the worker exactly the two variables it reads", () => {
    expect(workflow).toContain("NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}");
    expect(workflow).toContain("SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}");
  });
});
