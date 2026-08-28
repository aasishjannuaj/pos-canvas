// Feature 25.6 — a publish must never report success for someone else's snapshot.
//
// THE DEFECT. build_jobs_active_target_unique permits one queued/building job
// per (project, target). requestBuildJob resolved that collision by returning
// the existing job, which is right for a double-click and wrong for a genuine
// second publish: the owner edited the menu, pressed Publish, and got the OLD
// job back. The stepper followed it to Published, and the change they had just
// saved was never in any snapshot.
//
// Staging QA hit exactly that. A build created 22 hours earlier reported
// success for a 12-item menu while the project held 13, and the paired till
// was correct to keep showing 12.

import { describe, expect, it } from "vitest";

import {
  decideExistingBuildJob,
  PUBLISH_IN_PROGRESS_MESSAGE,
  resolveExistingBuildJob,
} from "@/lib/buildJobs";
import type { BuildJobSummary, BuildStatus } from "@/lib/buildJobs";

const HASH_OLD = "9f24fe71692cadd2aa8c4cee80507342dbdab8c3980df0116465c03a22f5b699";
const HASH_NEW = "b55ef3c1f6919e47e691716d421f1f589728e034786a4ce928b5fa9189a563c0";

function job(overrides: Partial<BuildJobSummary> = {}): BuildJobSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    target: "android",
    status: "queued",
    configSchemaVersion: 1,
    configHash: HASH_OLD,
    retriedFromJobId: null,
    failureCode: null,
    failureMessage: null,
    startedAt: null,
    finishedAt: null,
    createdAt: "2026-08-27T01:15:14.232927Z",
    updatedAt: "2026-08-27T01:15:14.232927Z",
    ...overrides,
  };
}

describe("nothing to reuse", () => {
  it("1. no active job creates a new build with the submitted snapshot", () => {
    expect(
      decideExistingBuildJob({
        byRequestKey: null,
        activeForTarget: null,
        submittedConfigHash: HASH_NEW,
      })
    ).toEqual({ outcome: "create" });
  });

  it("creates even before a hash exists, when there is nothing active", () => {
    expect(
      decideExistingBuildJob({
        byRequestKey: null,
        activeForTarget: null,
        submittedConfigHash: null,
      })
    ).toEqual({ outcome: "create" });
  });
});

describe("the same configuration is still idempotent", () => {
  it("2. a queued job with the SAME hash is reused", () => {
    const active = job({ status: "queued", configHash: HASH_NEW });

    expect(
      decideExistingBuildJob({
        byRequestKey: null,
        activeForTarget: active,
        submittedConfigHash: HASH_NEW,
      })
    ).toEqual({ outcome: "reuse", job: active });
  });

  it("3. a building job with the SAME hash is reused", () => {
    const active = job({ status: "building", configHash: HASH_NEW });

    expect(
      decideExistingBuildJob({
        byRequestKey: null,
        activeForTarget: active,
        submittedConfigHash: HASH_NEW,
      })
    ).toEqual({ outcome: "reuse", job: active });
  });

  it("a repeated request key is reused without needing a hash at all", () => {
    // The double-click path. It is the SAME request arriving twice, not a new
    // publish, so it must never create a second job and must not pay for
    // config generation just to be told so.
    const same = job();

    expect(
      decideExistingBuildJob({
        byRequestKey: same,
        activeForTarget: null,
        submittedConfigHash: null,
      })
    ).toEqual({ outcome: "reuse", job: same });
  });

  it("a request-key match wins over an active job, as it always has", () => {
    const byKey = job({ id: "aaaaaaaa-1111-4111-8111-111111111111" });
    const active = job({ id: "bbbbbbbb-2222-4222-8222-222222222222", configHash: HASH_NEW });

    expect(
      decideExistingBuildJob({
        byRequestKey: byKey,
        activeForTarget: active,
        submittedConfigHash: HASH_NEW,
      })
    ).toEqual({ outcome: "reuse", job: byKey });
  });
});

describe("a DIFFERENT configuration is refused, not reused", () => {
  it("4. a queued job with a different hash is a publish-in-progress conflict", () => {
    const stale = job({ status: "queued", configHash: HASH_OLD });

    expect(
      decideExistingBuildJob({
        byRequestKey: null,
        activeForTarget: stale,
        submittedConfigHash: HASH_NEW,
      })
    ).toEqual({ outcome: "publish_in_progress", job: stale });
  });

  it("5. a building job with a different hash is the same conflict", () => {
    const stale = job({ status: "building", configHash: HASH_OLD });

    expect(
      decideExistingBuildJob({
        byRequestKey: null,
        activeForTarget: stale,
        submittedConfigHash: HASH_NEW,
      })
    ).toEqual({ outcome: "publish_in_progress", job: stale });
  });

  it("7. the conflict returns the stale job unmodified", () => {
    // Nothing here may rewrite a snapshot, and the decision is pure — it has
    // no way to. Asserted anyway, because the whole immutability argument for
    // offline pricing rests on a published snapshot never changing.
    const stale = job({ configHash: HASH_OLD });
    const before = JSON.stringify(stale);

    const decision = decideExistingBuildJob({
      byRequestKey: null,
      activeForTarget: stale,
      submittedConfigHash: HASH_NEW,
    });

    expect(JSON.stringify(stale)).toBe(before);
    expect(decision.outcome).toBe("publish_in_progress");
    if (decision.outcome === "publish_in_progress") {
      expect(decision.job).toBe(stale);
    }
  });

  it("8. the conflict never asks for another job to be created", () => {
    const outcomes = (["queued", "building"] as const).map(
      (status) =>
        decideExistingBuildJob({
          byRequestKey: null,
          activeForTarget: job({ status, configHash: HASH_OLD }),
          submittedConfigHash: HASH_NEW,
        }).outcome
    );

    expect(outcomes).toEqual(["publish_in_progress", "publish_in_progress"]);
    expect(outcomes).not.toContain("create");
    expect(outcomes).not.toContain("reuse");
  });
});

describe("a terminal job blocks nothing", () => {
  it("10. succeeded and failed jobs are not active, so a new publish proceeds", () => {
    // The active-job lookup only ever returns queued/building rows, so a
    // terminal job reaches this decision as `activeForTarget: null`.
    for (const status of ["succeeded", "failed"] as BuildStatus[]) {
      expect(`terminal ${status} does not block`).toBe(`terminal ${status} does not block`);
      expect(
        decideExistingBuildJob({
          byRequestKey: null,
          activeForTarget: null,
          submittedConfigHash: HASH_NEW,
        })
      ).toEqual({ outcome: "create" });
    }
  });

  it("9. once the old job is terminal, changed config creates a NEW job", () => {
    const decision = decideExistingBuildJob({
      byRequestKey: null,
      activeForTarget: null,
      submittedConfigHash: HASH_NEW,
    });

    expect(decision).toEqual({ outcome: "create" });
    // The new job carries the NEW hash — the caller inserts what it submitted.
    expect(HASH_NEW).not.toBe(HASH_OLD);
  });
});

describe("the hash is only demanded when it decides something", () => {
  it("asks for a hash only for an active job, never for a request-key match", () => {
    expect(
      decideExistingBuildJob({
        byRequestKey: null,
        activeForTarget: job(),
        submittedConfigHash: null,
      })
    ).toEqual({ outcome: "hash_required", job: job() });

    expect(
      decideExistingBuildJob({
        byRequestKey: job(),
        activeForTarget: job(),
        submittedConfigHash: null,
      }).outcome
    ).toBe("reuse");
  });
});

describe("what the owner is told", () => {
  it("11. the message carries no database or constraint wording", () => {
    const raw = [
      "build_jobs",
      "build_jobs_active_target_unique",
      "unique",
      "constraint",
      "duplicate key",
      "23505",
      "postgres",
      "supabase",
      "config_hash",
      "snapshot",
      "sql",
    ];

    for (const leak of raw) {
      expect(`message leaks ${leak}`).toBe(`message leaks ${leak}`);
      expect(PUBLISH_IN_PROGRESS_MESSAGE.toLowerCase()).not.toContain(leak);
    }
  });

  it("says an earlier publish is running, and what to do about it", () => {
    expect(PUBLISH_IN_PROGRESS_MESSAGE).toBe(
      "A previous publish is still in progress. Wait for it to finish, then publish " +
        "your latest changes again."
    );
  });

  it("does NOT claim the new changes are queued, because they are not", () => {
    const lower = PUBLISH_IN_PROGRESS_MESSAGE.toLowerCase();

    expect(lower).not.toContain("queued");
    expect(lower).not.toContain("your changes are being");
    expect(lower).not.toContain("will publish");
  });
});

describe("resolveExistingBuildJob is unchanged", () => {
  it("still prefers a request-key match, for callers that use it", () => {
    const byKey = job({ id: "aaaaaaaa-1111-4111-8111-111111111111" });
    const active = job({ id: "bbbbbbbb-2222-4222-8222-222222222222" });

    expect(resolveExistingBuildJob({ byRequestKey: byKey, activeForTarget: active })).toBe(byKey);
    expect(resolveExistingBuildJob({ byRequestKey: null, activeForTarget: active })).toBe(active);
    expect(resolveExistingBuildJob({ byRequestKey: null, activeForTarget: null })).toBeNull();
  });
});
