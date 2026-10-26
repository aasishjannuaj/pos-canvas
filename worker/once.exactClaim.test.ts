import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_LEASE_SECONDS } from "@/lib/buildJobs.worker";
import { decideClaimOutcome, parseArgs, planClaim } from "@/worker/once";
import type { ClaimPlan } from "@/worker/once";

// OFF-2-EXACT-CLAIM-1 — the exact-job flags and the claim routing, tested as
// the pure functions main() calls (parseArgs -> planClaim -> one rpc ->
// decideClaimOutcome). No Supabase here, matching the convention in
// worker/once.test.ts; the database side is executed in
// supabase/migrations/20261016120000_claim_build_job_by_id.db.test.ts.

const JOB = "b0000000-0000-4000-8000-000000000001";
const PROJECT = "a0000000-0000-4000-8000-000000000001";

describe("parseArgs: --job and --project", () => {
  it("parses both, with an explicit target, in either flag form", () => {
    const exact = { jobId: JOB, projectId: PROJECT };

    expect(parseArgs(["--target", "android", "--job", JOB, "--project", PROJECT])).toEqual({ ok: true, target: "android", exact });
    expect(parseArgs(["--target=desktop", `--job=${JOB}`, `--project=${PROJECT}`])).toEqual({ ok: true, target: "desktop", exact });
    expect(parseArgs(["--project", PROJECT, "--job", JOB, "--target", "android"])).toEqual({ ok: true, target: "android", exact });
  });

  it("normalizes uuid case", () => {
    expect(parseArgs(["--target", "android", "--job", JOB.toUpperCase(), "--project", PROJECT.toUpperCase()]))
      .toEqual({ ok: true, target: "android", exact: { jobId: JOB, projectId: PROJECT } });
  });

  it("without either flag returns EXACTLY what it always returned (no exact key at all)", () => {
    const parsed = parseArgs(["--target", "android"]);

    expect(parsed).toStrictEqual({ ok: true, target: "android" });
    expect(Object.keys(parsed)).toEqual(["ok", "target"]);
  });

  it("requires the explicit target first: exact flags never stand in for it", () => {
    expect(parseArgs(["--job", JOB, "--project", PROJECT])).toEqual({ ok: false, reason: "missing_target" });
    expect(parseArgs(["--target", "ios", "--job", JOB, "--project", PROJECT])).toEqual({ ok: false, reason: "invalid_target" });
  });

  it.each([
    ["--job without --project", ["--target", "android", "--job", JOB]],
    ["--project without --job", ["--target", "android", "--project", PROJECT]],
  ])("refuses %s", (_label, argv) => {
    expect(parseArgs(argv)).toEqual({ ok: false, reason: "exact_job_incomplete" });
  });

  it.each([
    ["a repeated --job", ["--target", "android", "--job", JOB, "--job", JOB, "--project", PROJECT]],
    ["a repeated --project, mixed forms", ["--target", "android", "--job", JOB, "--project", PROJECT, `--project=${PROJECT}`]],
  ])("refuses %s rather than guessing which one was meant", (_label, argv) => {
    expect(parseArgs(argv)).toEqual({ ok: false, reason: "exact_flag_repeated" });
  });

  it.each([
    ["not a uuid", "build-1"],
    ["empty", ""],
    ["a uuid with junk", `${JOB}x`],
    ["an injection attempt", `${JOB}' or '1'='1`],
  ])("refuses a --job that is %s", (_label, value) => {
    expect(parseArgs(["--target", "android", "--job", value, "--project", PROJECT])).toEqual({ ok: false, reason: "invalid_job_id" });
    expect(parseArgs(["--target", "android", `--job=${value}`, "--project", PROJECT])).toEqual({ ok: false, reason: "invalid_job_id" });
  });

  it("refuses a malformed --project", () => {
    expect(parseArgs(["--target", "android", "--job", JOB, "--project", "shop"])).toEqual({ ok: false, reason: "invalid_project_id" });
  });

  it("refuses a flag with no value, including one swallowed by the next flag", () => {
    expect(parseArgs(["--target", "android", "--project", PROJECT, "--job"])).toEqual({ ok: false, reason: "invalid_job_id" });
    expect(parseArgs(["--target", "android", "--job", "--project", PROJECT])).toEqual({ ok: false, reason: "invalid_job_id" });
  });

  it("--help still wins over everything", () => {
    expect(parseArgs(["--target", "android", "--job", JOB, "--project", PROJECT, "--help"])).toEqual({ ok: false, reason: "help_requested" });
  });
});

describe("planClaim: which claim RPC runs", () => {
  it("without exact flags: the global claim, with exactly the arguments it always had", () => {
    expect(planClaim({ ok: true, target: "android" }, "worker-1")).toEqual({
      mode: "queue",
      rpc: "claim_next_build_job",
      args: { p_target: "android", p_worker_id: "worker-1", p_lease_seconds: DEFAULT_LEASE_SECONDS },
    });
  });

  it("with exact flags: ONLY claim_build_job_by_id, for that job, project and target", () => {
    const plan = planClaim({ ok: true, target: "desktop", exact: { jobId: JOB, projectId: PROJECT } }, "worker-2");

    expect(plan).toEqual({
      mode: "exact",
      rpc: "claim_build_job_by_id",
      exact: { jobId: JOB, projectId: PROJECT },
      args: { p_build_job_id: JOB, p_project_id: PROJECT, p_target: "desktop", p_worker_id: "worker-2", p_lease_seconds: DEFAULT_LEASE_SECONDS },
    });
    expect(JSON.stringify(plan)).not.toContain("claim_next_build_job");
  });

  it("keeps the worker's lease (the SQL bound is 30..3600)", () => {
    expect(DEFAULT_LEASE_SECONDS).toBeGreaterThanOrEqual(30);
    expect(DEFAULT_LEASE_SECONDS).toBeLessThanOrEqual(3600);
  });
});

describe("decideClaimOutcome: what the claim's answer means", () => {
  const queue = planClaim({ ok: true, target: "android" }, "w");
  const exact = planClaim({ ok: true, target: "android", exact: { jobId: JOB, projectId: PROJECT } }, "w") as Extract<ClaimPlan, { mode: "exact" }>;

  it("queue mode is unchanged: a row proceeds, an empty answer is a normal no-op", () => {
    expect(decideClaimOutcome(queue, { id: "any", target: "android" })).toEqual({ kind: "claimed" });
    expect(decideClaimOutcome(queue, null)).toEqual({ kind: "no_job_available" });
    expect(decideClaimOutcome(queue, undefined)).toEqual({ kind: "no_job_available" });
  });

  it("exact mode proceeds only for the named job and target", () => {
    expect(decideClaimOutcome(exact, { id: JOB, target: "android" })).toEqual({ kind: "claimed" });
    expect(decideClaimOutcome(exact, { id: JOB.toUpperCase(), target: "android" })).toEqual({ kind: "claimed" });
  });

  it("exact mode: no row is UNAVAILABLE (stop), never a quiet no-op", () => {
    expect(decideClaimOutcome(exact, null)).toEqual({ kind: "exact_job_unavailable" });
    expect(decideClaimOutcome(exact, undefined)).toEqual({ kind: "exact_job_unavailable" });
  });

  it.each([
    ["another job id", { id: "b0000000-0000-4000-8000-000000000002", target: "android" }],
    ["another target", { id: JOB, target: "desktop" }],
    ["no id", { target: "android" }],
    ["a non-string id", { id: 7, target: "android" }],
  ])("exact mode: %s is a MISMATCH (stop)", (_label, claimed) => {
    expect(decideClaimOutcome(exact, claimed)).toEqual({ kind: "exact_job_mismatch" });
  });
});

describe("main() wiring (source)", () => {
  const source = readFileSync(join(__dirname, "once.ts"), "utf8");
  const mainBody = source.slice(source.indexOf("export async function main()"));

  it("makes exactly ONE claim call, the planned one: no second, fallback claim", () => {
    expect(mainBody.match(/admin\.rpc\(plan\.rpc, plan\.args\)/g)).toHaveLength(1);
    expect(mainBody).not.toMatch(/rpc\(\s*["']claim_next_build_job["']/);
    expect(mainBody).not.toMatch(/rpc\(\s*["']claim_build_job_by_id["']/);
  });

  it("decides on the claim through decideClaimOutcome and scopes the re-read to the named project", () => {
    expect(mainBody).toContain("decideClaimOutcome(plan, claimed)");
    expect(mainBody).toMatch(/plan\.mode === "exact"\) \{\s*ownedRowQuery = ownedRowQuery\.eq\("project_id", plan\.exact\.projectId\)/);
  });

  it("keeps every existing re-read condition: id, status 'building', claim token, unexpired lease", () => {
    expect(mainBody).toMatch(/\.eq\("id", buildJobId\)\s*\.eq\("status", "building"\)\s*\.eq\("claim_token", claimToken\)\s*\.gt\("lease_expires_at", new Date\(\)\.toISOString\(\)\)/);
  });
});
