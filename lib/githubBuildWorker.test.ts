// Feature 17.2 — behavioral tests for the workflow_dispatch contract.
//
// These cover the half of the dispatcher that has no credential and no I/O:
// which repository and workflow are targeted, what is sent, and what each HTTP
// status means. The credential half (lib/githubBuildWorker.server.ts) is
// covered by lib/githubBuildWorker.guards.test.ts instead — asserting that a
// token is never logged is a property of the source, not of a return value.
import { describe, expect, it } from "vitest";
import {
  GITHUB_API_VERSION,
  GITHUB_BUILD_WORKER_DISPATCH_URL,
  GITHUB_BUILD_WORKER_OWNER,
  GITHUB_BUILD_WORKER_REF,
  GITHUB_BUILD_WORKER_REPO,
  GITHUB_BUILD_WORKER_WORKFLOW_FILE,
  buildWorkflowDispatchBody,
  interpretWorkflowDispatchStatus,
} from "@/lib/githubBuildWorker";
import { needsBuildProcessing } from "@/lib/buildJobs";
import type { BuildStatus } from "@/lib/buildJobs";

describe("the dispatch endpoint", () => {
  it("targets exactly the pos-canvas build worker workflow", () => {
    expect(GITHUB_BUILD_WORKER_OWNER).toBe("aasishjannuaj");
    expect(GITHUB_BUILD_WORKER_REPO).toBe("pos-canvas");
    expect(GITHUB_BUILD_WORKER_WORKFLOW_FILE).toBe("build-worker.yml");
  });

  it("is the documented workflow_dispatch URL, on api.github.com over https", () => {
    expect(GITHUB_BUILD_WORKER_DISPATCH_URL).toBe(
      "https://api.github.com/repos/aasishjannuaj/pos-canvas" +
        "/actions/workflows/build-worker.yml/dispatches"
    );
    expect(new URL(GITHUB_BUILD_WORKER_DISPATCH_URL).protocol).toBe("https:");
    expect(new URL(GITHUB_BUILD_WORKER_DISPATCH_URL).host).toBe("api.github.com");
  });

  it("names the workflow by file, never by numeric id", () => {
    // A numeric id does not survive the workflow being deleted and recreated.
    expect(GITHUB_BUILD_WORKER_DISPATCH_URL).toContain("/workflows/build-worker.yml/");
    expect(GITHUB_BUILD_WORKER_DISPATCH_URL).not.toMatch(/\/workflows\/\d+\//);
  });

  it("carries no query string, so nothing can be smuggled into the URL", () => {
    expect(GITHUB_BUILD_WORKER_DISPATCH_URL).not.toContain("?");
    expect(new URL(GITHUB_BUILD_WORKER_DISPATCH_URL).search).toBe("");
  });

  it("pins the GitHub REST API version", () => {
    expect(GITHUB_API_VERSION).toBe("2022-11-28");
  });
});

describe("the dispatch body", () => {
  it("sends the default branch as the ref", () => {
    expect(GITHUB_BUILD_WORKER_REF).toBe("main");
    expect(JSON.parse(buildWorkflowDispatchBody())).toEqual({ ref: "main" });
  });

  it("sends nothing but the ref", () => {
    // The workflow declares no `inputs`, and GitHub rejects a dispatch that
    // carries inputs the workflow does not declare.
    expect(Object.keys(JSON.parse(buildWorkflowDispatchBody()))).toEqual(["ref"]);
  });

  it("tells GitHub nothing about the customer whose build this is", () => {
    // A dispatch is a content-free "there is work" signal; the worker finds its
    // job by claiming from Postgres. No id of any kind may travel to GitHub.
    const body = buildWorkflowDispatchBody();
    for (const leak of ["project", "owner", "job", "config", "user", "email"]) {
      expect(body.toLowerCase()).not.toContain(leak);
    }
  });
});

describe("interpretWorkflowDispatchStatus", () => {
  it("treats 204 No Content as the success", () => {
    expect(interpretWorkflowDispatchStatus(204)).toEqual({ ok: true });
  });

  it("treats 200 as a failure, because a real dispatch answers 204", () => {
    // Guards against a lazy `status < 300` check, which would call an
    // unexpected response a success and silently never start a build.
    expect(interpretWorkflowDispatchStatus(200)).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  it("maps a bad or under-permissioned token to unauthorized", () => {
    expect(interpretWorkflowDispatchStatus(401)).toEqual({
      ok: false,
      reason: "unauthorized",
    });
    expect(interpretWorkflowDispatchStatus(403)).toEqual({
      ok: false,
      reason: "unauthorized",
    });
  });

  it("maps 404 to not_found — the wrong repository looks identical to a missing workflow", () => {
    expect(interpretWorkflowDispatchStatus(404)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("maps 422 to rejected — an unknown ref, or no workflow_dispatch on that ref", () => {
    expect(interpretWorkflowDispatchStatus(422)).toEqual({
      ok: false,
      reason: "rejected",
    });
  });

  it("maps every server error to unreachable, which is the retryable class", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(interpretWorkflowDispatchStatus(status)).toEqual({
        ok: false,
        reason: "unreachable",
      });
    }
  });

  it("never returns ok for any status other than 204", () => {
    for (let status = 100; status < 600; status += 1) {
      if (status === 204) continue;
      expect(interpretWorkflowDispatchStatus(status).ok).toBe(false);
    }
  });
});

describe("needsBuildProcessing decides when a worker run is worth requesting", () => {
  it("requests a run for a queued build", () => {
    expect(needsBuildProcessing("queued")).toBe(true);
  });

  it("requests a run for a building build, which is the stale-recovery path", () => {
    // With 17.2's schedule removed, a dispatch is the ONLY thing that calls
    // claim_next_build_job, and reclaiming a dead worker's job happens inside
    // that function. A job stuck 'building' also holds its project's active-job
    // index, so every later Build click resolves to it — if 'building' did not
    // dispatch, that project could never cause a worker run again.
    expect(needsBuildProcessing("building")).toBe(true);
  });

  it("requests nothing for a finished build", () => {
    expect(needsBuildProcessing("succeeded")).toBe(false);
    expect(needsBuildProcessing("failed")).toBe(false);
  });

  it("covers every BuildStatus, so a new one cannot be silently ignored", () => {
    const all: BuildStatus[] = ["queued", "building", "succeeded", "failed"];
    expect(all.filter(needsBuildProcessing)).toEqual(["queued", "building"]);
  });

  it("matches the statuses the active-job lookup treats as active", () => {
    // lib/buildJobs.server.ts filters .in("status", ["queued", "building"]) for
    // the active-job index. If these two ever diverge, a job could be active
    // (blocking new inserts) while nothing would ever dispatch for it.
    const activeInLookup: BuildStatus[] = ["queued", "building"];
    expect(activeInLookup.every(needsBuildProcessing)).toBe(true);
  });
});
