import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// OFF-2-EXACT-CLAIM-1 — main() run end to end against a RECORDING STAND-IN for
// the service-role client, to prove the routing at runtime: which claim RPC is
// called, that exact mode never calls another, and that a missing or
// mismatched job stops before any read, upload or finalize.
//
// This is a BOUNDARY STAND-IN, not a database: it asserts what the worker ASKS
// for, never what the database would do. Database behaviour is executed in
// supabase/migrations/20261016120000_claim_build_job_by_id.db.test.ts.
// worker/once.test.ts deliberately avoids mocking Supabase for parseArgs; this
// file exists only because the brief requires runtime routing evidence.

type Call = { kind: "rpc" | "from" | "storage"; name: string; args?: unknown; filters?: [string, string, unknown][] };

const calls: Call[] = [];
let rpcAnswer: { data: unknown; error: { message: string } | null } = { data: [], error: null };
let rowAnswer: { data: unknown; error: unknown } = { data: null, error: null };
let clientCreated = 0;

function recordingClient() {
  clientCreated += 1;

  return {
    rpc: async (name: string, args: unknown) => {
      calls.push({ kind: "rpc", name, args });
      return rpcAnswer;
    },
    from: (table: string) => {
      const call: Call = { kind: "from", name: table, filters: [] };
      calls.push(call);
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => { call.filters!.push(["eq", col, val]); return chain; },
        gt: (col: string, val: unknown) => { call.filters!.push(["gt", col, val]); return chain; },
        maybeSingle: async () => rowAnswer,
      };
      return chain;
    },
    storage: {
      from: (bucket: string) => {
        calls.push({ kind: "storage", name: bucket });
        return { upload: async () => ({ error: { message: "not reached" } }) };
      },
    },
  };
}

vi.mock("@/worker/supabase", () => ({ createWorkerAdminClient: () => recordingClient() }));

const JOB = "b0000000-0000-4000-8000-000000000001";
const PROJECT = "a0000000-0000-4000-8000-000000000001";
const EXACT = ["--target", "android", "--job", JOB, "--project", PROJECT];

let argv: string[];

async function run(args: string[]) {
  // argv[1] must NOT be worker/once.ts: that would satisfy the module's own
  // entrypoint guard and run main() a second time on first import.
  process.argv = ["node", "vitest-routing-harness", ...args];
  const { main } = await import("@/worker/once");
  await main();
  return process.exitCode ?? 0;
}

beforeEach(() => {
  argv = process.argv;
  calls.length = 0;
  clientCreated = 0;
  rpcAnswer = { data: [], error: null };
  rowAnswer = { data: null, error: null };
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  process.argv = argv;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("main(): default routing is unchanged", () => {
  it("calls claim_next_build_job once with the original arguments; an empty queue exits 0", async () => {
    expect(await run(["--target", "android"])).toBe(0);
    expect(calls).toEqual([
      { kind: "rpc", name: "claim_next_build_job", args: { p_target: "android", p_worker_id: expect.any(String), p_lease_seconds: 300 } },
    ]);
  });

  it("a claimed job is re-read with id, status, token and lease, and NO project filter", async () => {
    rpcAnswer = { data: [{ id: JOB, target: "android", claim_token: "tok", lease_expires_at: "x", attempt_count: 1 }], error: null };
    expect(await run(["--target", "android"])).toBe(1); // claim_lost: the stand-in returns no row
    expect(calls[1]).toEqual({
      kind: "from",
      name: "build_jobs",
      filters: [["eq", "id", JOB], ["eq", "status", "building"], ["eq", "claim_token", "tok"], ["gt", "lease_expires_at", expect.any(String)]],
    });
    expect(calls.some((c) => c.kind === "storage")).toBe(false);
  });
});

describe("main(): exact routing", () => {
  it("calls ONLY claim_build_job_by_id, with the named job, project and target", async () => {
    await run(EXACT);
    expect(calls.filter((c) => c.kind === "rpc")).toEqual([
      { kind: "rpc", name: "claim_build_job_by_id", args: { p_build_job_id: JOB, p_project_id: PROJECT, p_target: "android", p_worker_id: expect.any(String), p_lease_seconds: 300 } },
    ]);
  });

  it("an unavailable job stops with exit 1: no fallback claim, no read, no upload", async () => {
    expect(await run(EXACT)).toBe(1);
    expect(calls.map((c) => `${c.kind}:${c.name}`)).toEqual(["rpc:claim_build_job_by_id"]);
  });

  it("a claim error stops with exit 1 and never retries through the global claim", async () => {
    rpcAnswer = { data: null, error: { message: "boom" } };
    expect(await run(EXACT)).toBe(1);
    expect(calls.map((c) => `${c.kind}:${c.name}`)).toEqual(["rpc:claim_build_job_by_id"]);
  });

  it("a mismatched answer stops with exit 1 before any read or upload", async () => {
    rpcAnswer = { data: [{ id: "b0000000-0000-4000-8000-0000000000ff", target: "android", claim_token: "tok", lease_expires_at: "x", attempt_count: 1 }], error: null };
    expect(await run(EXACT)).toBe(1);
    expect(calls.map((c) => `${c.kind}:${c.name}`)).toEqual(["rpc:claim_build_job_by_id"]);
  });

  it("the named job is re-read with EVERY existing condition PLUS the named project", async () => {
    rpcAnswer = { data: [{ id: JOB, target: "android", claim_token: "tok", lease_expires_at: "x", attempt_count: 1 }], error: null };
    expect(await run(EXACT)).toBe(1); // claim_lost: the stand-in returns no row, so nothing is built
    expect(calls[1]).toEqual({
      kind: "from",
      name: "build_jobs",
      filters: [["eq", "id", JOB], ["eq", "status", "building"], ["eq", "claim_token", "tok"], ["gt", "lease_expires_at", expect.any(String)], ["eq", "project_id", PROJECT]],
    });
    expect(calls.some((c) => c.kind === "storage")).toBe(false);
  });
});

describe("main(): malformed input never reaches Supabase", () => {
  it.each([
    [["--target", "android", "--job", JOB]],
    [["--target", "android", "--project", PROJECT]],
    [["--target", "android", "--job", "nope", "--project", PROJECT]],
    [["--target", "android", "--job", JOB, "--project", "nope"]],
    [["--target", "android", "--job", JOB, "--job", JOB, "--project", PROJECT]],
    [["--job", JOB, "--project", PROJECT]],
  ])("%j exits 1 without creating a client", async (args) => {
    expect(await run(args)).toBe(1);
    expect(clientCreated).toBe(0);
    expect(calls).toEqual([]);
  });
});
