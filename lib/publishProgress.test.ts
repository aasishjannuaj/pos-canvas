// Feature 24.6 — the publishing stage model.
//
// The whole point of this feature is that an owner is told the truth about a
// process the backend describes in four words. These tests exist mostly to stop
// the UI claiming more than that: every stage below maps to a real status, and
// there is no arithmetic anywhere that could turn into a percentage.

import { describe, expect, it } from "vitest";

import {
  PUBLISH_POLL_INTERVAL_MS,
  PUBLISH_STAGES,
  PUBLISH_STAGE_LABELS,
  PUBLISH_SUCCESS_MESSAGE,
  describePublishProgress,
  describePublishStageState,
  isPublishInFlight,
  resolvePublishProgress,
} from "@/lib/publishProgress";
import type { BuildJobSummary } from "@/lib/buildJobs";

function job(patch: Partial<BuildJobSummary> = {}): BuildJobSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    status: "queued",
    createdAt: "2026-08-23T18:00:00.000Z",
    failureMessage: null,
    ...patch,
  } as BuildJobSummary;
}

describe("the stages are exactly the facts the backend has", () => {
  it("runs preparing -> queued -> publishing -> published", () => {
    expect([...PUBLISH_STAGES]).toEqual([
      "preparing",
      "queued",
      "publishing",
      "published",
    ]);
  });

  it("names them for an owner, never as a build", () => {
    const labels = Object.values(PUBLISH_STAGE_LABELS).join(" ").toLowerCase();

    expect(labels).toContain("configuration");
    for (const forbidden of ["build", "apk", "compile", "app "]) {
      expect(labels).not.toContain(forbidden);
    }
  });

  it("invents no percentage anywhere", () => {
    const everything = [
      ...Object.values(PUBLISH_STAGE_LABELS),
      PUBLISH_SUCCESS_MESSAGE,
    ].join(" ");

    expect(everything).not.toMatch(/\d+\s*%/);
  });
});

describe("what an owner sees at each point", () => {
  it("shows Preparing only while the request is in flight", () => {
    expect(resolvePublishProgress({ requestStatus: "submitting", job: null })).toEqual({
      kind: "running",
      stage: "preparing",
    });
  });

  it("drops Preparing the moment a job exists, even mid-submit", () => {
    // The approved rule: Preparing must not survive the server answering. It is
    // expressed as precedence — the job outranks the request status — so there
    // is no timer that could leave it on screen.
    expect(
      resolvePublishProgress({ requestStatus: "submitting", job: job({ status: "queued" }) })
    ).toEqual({ kind: "running", stage: "queued" });
  });

  it("maps queued, building and succeeded truthfully", () => {
    expect(resolvePublishProgress({ requestStatus: "success", job: job() })).toEqual({
      kind: "running",
      stage: "queued",
    });
    expect(
      resolvePublishProgress({ requestStatus: "success", job: job({ status: "building" }) })
    ).toEqual({ kind: "running", stage: "publishing" });
    expect(
      resolvePublishProgress({ requestStatus: "success", job: job({ status: "succeeded" }) })
    ).toEqual({ kind: "published" });
  });

  it("carries the server's own words on a failed job", () => {
    expect(
      resolvePublishProgress({
        requestStatus: "success",
        job: job({ status: "failed", failureMessage: "Configuration snapshot was invalid." }),
      })
    ).toEqual({ kind: "failed", message: "Configuration snapshot was invalid." });
  });

  it("distinguishes a failed REQUEST from a failed JOB", () => {
    // A request that never produced a job is not a publish that went wrong —
    // there may be nothing queued at all, and telling an owner their publish
    // failed would send them looking for a job that does not exist.
    expect(resolvePublishProgress({ requestStatus: "error", job: null })).toEqual({
      kind: "request_failed",
      message: null,
    });

    // But once a job exists, the job's own status wins over a stale request error.
    expect(
      resolvePublishProgress({ requestStatus: "error", job: job({ status: "building" }) })
    ).toEqual({ kind: "running", stage: "publishing" });
  });

  it("shows nothing at all before anything is requested", () => {
    expect(resolvePublishProgress({ requestStatus: "idle", job: null })).toEqual({
      kind: "idle",
    });
  });

  it("a queued job whose processing never started is still just queued", () => {
    // Feature 17.2's "could not start automatically" is a separate notice beside
    // the stepper. The STAGE is unchanged, because the configuration really is
    // queued and nothing was lost — treating it as a failure would be alarming
    // and wrong.
    expect(resolvePublishProgress({ requestStatus: "success", job: job() })).toEqual({
      kind: "running",
      stage: "queued",
    });
  });
});

describe("how each row renders", () => {
  it("marks earlier stages complete and later ones pending", () => {
    const progress = resolvePublishProgress({
      requestStatus: "success",
      job: job({ status: "building" }),
    });

    expect(describePublishStageState("preparing", progress)).toBe("complete");
    expect(describePublishStageState("queued", progress)).toBe("complete");
    expect(describePublishStageState("publishing", progress)).toBe("active");
    expect(describePublishStageState("published", progress)).toBe("pending");
  });

  it("completes every row once published", () => {
    const progress = resolvePublishProgress({
      requestStatus: "success",
      job: job({ status: "succeeded" }),
    });

    for (const stage of PUBLISH_STAGES) {
      expect(describePublishStageState(stage, progress)).toBe("complete");
    }
  });

  it("stops the timeline on failure rather than promising the rest", () => {
    const progress = resolvePublishProgress({
      requestStatus: "success",
      job: job({ status: "failed", failureMessage: "nope" }),
    });

    for (const stage of PUBLISH_STAGES) {
      expect(describePublishStageState(stage, progress)).toBe("stopped");
    }
  });

  it("shows nothing as started while idle", () => {
    const progress = resolvePublishProgress({ requestStatus: "idle", job: null });

    for (const stage of PUBLISH_STAGES) {
      expect(describePublishStageState(stage, progress)).toBe("pending");
    }
  });
});

describe("what drives the watcher", () => {
  it("is in flight only while a stage is running", () => {
    expect(isPublishInFlight({ kind: "running", stage: "queued" })).toBe(true);
    expect(isPublishInFlight({ kind: "published" })).toBe(false);
    expect(isPublishInFlight({ kind: "failed", message: null })).toBe(false);
    expect(isPublishInFlight({ kind: "request_failed", message: null })).toBe(false);
    expect(isPublishInFlight({ kind: "idle" })).toBe(false);
  });

  it("polls on a human interval, not a busy one", () => {
    expect(PUBLISH_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(1_000);
    expect(PUBLISH_POLL_INTERVAL_MS).toBeLessThanOrEqual(10_000);
  });
});

describe("what is announced", () => {
  it("says nothing before anything happens", () => {
    expect(describePublishProgress({ kind: "idle" })).toBeNull();
  });

  it("names the running stage", () => {
    expect(describePublishProgress({ kind: "running", stage: "publishing" })).toBe(
      "Publishing configuration…"
    );
  });

  it("says the configuration is published and pairable, not that an app was made", () => {
    const message = describePublishProgress({ kind: "published" });

    expect(message).toBe(PUBLISH_SUCCESS_MESSAGE);
    expect(message).toContain("configuration is published");
    expect(message).toContain("POS Canvas app");

    for (const forbidden of ["built", "APK", "generated", "application"]) {
      expect(message).not.toContain(forbidden);
    }
  });

  it("falls back to plain words when the server gave no reason", () => {
    expect(describePublishProgress({ kind: "failed", message: null })).toBe(
      "Publishing could not be completed."
    );
    expect(describePublishProgress({ kind: "request_failed", message: null })).toBe(
      "The publish request could not be sent."
    );
  });
});
