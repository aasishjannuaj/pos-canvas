// Milestone 16, Feature 16.3 — Migration D4b static guards.
//
// TEXT-level assertions. libpg-query parses a DO block's body as an opaque
// string, so the plpgsql inside the guard and the verification block is not
// statically validated; the verification block is self-checking at apply time.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(migrationsDir, "20260803260000_build_jobs_immutability_guard.sql"),
  "utf-8"
);

const executable = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

// Derived from every live SET clause; see the migration header.
const IMMUTABLE = [
  "project_id",
  "owner_id",
  "request_key",
  "target",
  "config_snapshot",
  "config_schema_version",
  "config_hash",
  "retried_from_job_id",
] as const;

const MUTABLE = [
  "status",
  "started_at",
  "finished_at",
  "failure_code",
  "failure_message",
  "claimed_by",
  "claim_token",
  "heartbeat_at",
  "lease_expires_at",
  "attempt_count",
  "updated_at",
] as const;

describe("migration ordering", () => {
  it("sorts after the D3 checkout migration", () => {
    expect(
      "20260803250000_complete_sale_v2.sql" <
        "20260803260000_build_jobs_immutability_guard.sql"
    ).toBe(true);
  });
});

describe("immutable column list is exact", () => {
  it("guards every approved immutable column", () => {
    for (const col of IMMUTABLE) {
      expect(executable).toContain(`new.${col} is distinct from old.${col}`);
      expect(executable).toContain(`build_jobs.${col} cannot be changed after creation`);
    }
  });

  it("guards exactly eight columns and no more", () => {
    const compared = [...executable.matchAll(/new\.(\w+) is distinct from old\.\1/g)].map((m) => m[1]);
    // `status` is compared too, but to DRIVE the transition rule rather than to
    // freeze the column — so it is excluded from the immutable set here and
    // asserted separately.
    expect(compared).toContain("status");
    const frozen = [...new Set(compared)].filter((c) => c !== "status");
    expect(frozen.sort()).toEqual([...IMMUTABLE].sort());
    const raises = executable.match(/cannot be changed after creation/g) ?? [];
    expect(raises.length).toBe(IMMUTABLE.length);
  });

  it("does NOT freeze any column the build worker legitimately writes", () => {
    for (const col of MUTABLE) {
      expect(executable).not.toContain(`build_jobs.${col} cannot be changed after creation`);
      // status is compared, but only to drive the transition rule.
      if (col !== "status") {
        expect(executable).not.toContain(`new.${col} is distinct from old.${col}`);
      }
    }
  });

  it("uses IS DISTINCT FROM rather than <> so NULLs compare correctly", () => {
    expect(executable).not.toMatch(/new\.\w+ <> old\.\w+/);
  });
});

describe("status transition matrix", () => {
  it("permits exactly the four approved transitions", () => {
    expect(executable).toContain("(old.status = 'queued' and new.status = 'building')");
    expect(executable).toContain(
      "or (old.status = 'building' and new.status in ('succeeded', 'failed'))"
    );
  });

  it("allows building -> building implicitly, by only running when status changes", () => {
    // The stale re-claim is a same-status update; the rule must be skipped for
    // it, not enumerated as an allowed pair.
    expect(executable).toContain("if new.status is distinct from old.status then");
    expect(executable).not.toMatch(/old\.status = 'building' and new\.status = 'building'/);
  });

  it("never introduces a building -> queued path", () => {
    expect(executable).not.toMatch(/new\.status\s*=\s*'queued'/);
  });

  it("treats succeeded and failed as terminal — no rule admits them as OLD", () => {
    const rule = executable.slice(
      executable.indexOf("if new.status is distinct from old.status then"),
      executable.indexOf("return new;")
    );
    expect(rule).not.toMatch(/old\.status = 'succeeded'/);
    expect(rule).not.toMatch(/old\.status = 'failed'/);
  });

  it("rejects anything else with a controlled message", () => {
    expect(executable).toContain(
      "'build_jobs status cannot change from % to %', old.status, new.status"
    );
  });
});

describe("guard function security", () => {
  it("is SECURITY DEFINER with a locked search_path", () => {
    expect(executable).toContain("create or replace function public.build_jobs_guard_immutable_columns()");
    expect(executable).toContain("returns trigger");
    expect(executable).toContain("security definer");
    expect(executable).toContain("set search_path to public, pg_temp");
  });

  it("uses no dynamic SQL and reads or writes no table", () => {
    const body = executable.slice(
      executable.indexOf("create or replace function public.build_jobs_guard_immutable_columns()"),
      executable.indexOf("create or replace trigger")
    );
    expect(body).not.toMatch(/\bexecute\s+format|\bexecute\s+'/i);
    expect(body).not.toMatch(/\b(select|insert|update|delete)\s+.*\bfrom\b/i);
    expect(body).not.toMatch(/insert into|update public\.|delete from/i);
  });

  it("leaks no id, config value, request_key or claim_token in any message", () => {
    // Scoped to the GUARD FUNCTION body — the code that runs on every worker
    // update. The verification block runs once at apply time as postgres and
    // legitimately interpolates counts into its diagnostics.
    const guardBody = executable.slice(
      executable.indexOf("create or replace function public.build_jobs_guard_immutable_columns()"),
      executable.indexOf("create or replace trigger")
    );
    // Every guard message that interpolates anything must interpolate ONLY the
    // two status literals — four public enum values, not identifiers.
    const interpolated = guardBody.match(/raise exception[^;]*'[^']*%[^']*'[^;]*;/g) ?? [];
    for (const r of interpolated) {
      expect(r).toContain("old.status, new.status");
    }
    for (const forbidden of ["old.id", "new.id", "old.config_snapshot,", "new.config_snapshot,", "old.request_key,", "old.claim_token", "new.claim_token"]) {
      expect(executable).not.toContain(forbidden);
    }
  });
});

describe("trigger placement", () => {
  it("is BEFORE UPDATE FOR EACH ROW on build_jobs", () => {
    expect(executable).toContain(
      "create or replace trigger build_jobs_guard_immutable\n  before update on public.build_jobs\n  for each row\n  execute function public.build_jobs_guard_immutable_columns();"
    );
  });

  it("is named so it fires before the existing updated-at trigger", () => {
    // PostgreSQL runs BEFORE ROW triggers in name order.
    expect("build_jobs_guard_immutable" < "build_jobs_set_updated_at").toBe(true);
    expect(executable).toContain("'build_jobs_guard_immutable' < 'build_jobs_set_updated_at'");
  });

  it("adds exactly one trigger and asserts the table ends with two", () => {
    const triggers = executable.match(/create or replace trigger \w+/g) ?? [];
    expect(triggers).toEqual(["create or replace trigger build_jobs_guard_immutable"]);
    expect(executable).toContain("expected exactly 2 triggers on build_jobs");
  });
});

describe("updated-at hardening", () => {
  it("alters only the search_path, never the body", () => {
    expect(executable).toContain(
      "alter function public.set_build_jobs_updated_at() set search_path to public, pg_temp;"
    );
    expect(executable).not.toMatch(
      /create\s+or\s+replace\s+function\s+(public\.)?set_build_jobs_updated_at/i
    );
    expect(executable).not.toMatch(/drop\s+function[^;]*set_build_jobs_updated_at/i);
  });

  it("keeps it SECURITY INVOKER", () => {
    expect(executable).toContain("set_build_jobs_updated_at must remain SECURITY INVOKER");
    expect(executable).not.toMatch(/alter function[^;]*set_build_jobs_updated_at[^;]*security definer/i);
  });
});

describe("verification block", () => {
  it("captures a real in-session baseline instead of hardcoding hashes", () => {
    expect(executable).toContain("create temporary table d4b_fn_baseline");
    expect(executable).toContain("create temporary table d4b_jobs_baseline");
    expect(executable).toContain("create temporary table d4b_priv_baseline");
    expect(executable).toContain("md5(p.prosrc)");
    expect(executable).toContain("md5(b::text) as row_md5");
    // No literal 32-hex hash anywhere — guessing one caused a false failure
    // earlier in this milestone.
    expect(executable).not.toMatch(/\b[0-9a-f]{32}\b/);
  });

  it("asserts every guard property the design requires", () => {
    for (const msg of [
      "D4b: guard function is missing",
      "D4b: guard function must be owned by postgres",
      "D4b: guard function must be SECURITY DEFINER",
      "D4b: guard function must lock search_path to public, pg_temp",
      "D4b: guard trigger is missing",
      "D4b: guard trigger must be FOR EACH ROW",
      "D4b: guard trigger must be BEFORE",
      "D4b: guard trigger must fire on UPDATE",
      "D4b: guard trigger name must sort before the updated-at trigger",
      "D4b: set_build_jobs_updated_at must remain SECURITY INVOKER",
      "D4b: set_build_jobs_updated_at must now lock search_path",
    ]) {
      expect(executable).toContain(msg);
    }
  });

  it("asserts the six build RPCs and both checkout functions are unchanged", () => {
    for (const fn of [
      "claim_next_build_job",
      "heartbeat_build_job",
      "complete_build_job",
      "fail_build_job",
      "finalize_build_job_with_artifact",
      "set_build_jobs_updated_at",
      "complete_sale",
      "complete_sale_v2",
    ]) {
      expect(executable).toContain(`'${fn}'`);
    }
    expect(executable).toContain("changed body, posture or grants");
  });

  it("asserts build_jobs data and the D1 matrix are untouched", () => {
    expect(executable).toContain("D4b: build_jobs row count changed");
    expect(executable).toContain("D4b: at least one build_jobs row changed");
    expect(executable).toContain("D4b: the D1 table privilege matrix changed");
  });
});

describe("scope containment", () => {
  it("replaces no checkout, pairing or worker RPC", () => {
    for (const fn of [
      "complete_sale",
      "complete_sale_v2",
      "resolve_sale_owner",
      "claim_next_build_job",
      "heartbeat_build_job",
      "complete_build_job",
      "fail_build_job",
      "finalize_build_job_with_artifact",
      "create_device_pairing_token",
      "redeem_device_pairing_token",
      "revoke_paired_device",
    ]) {
      expect(executable).not.toMatch(
        new RegExp(`create\\s+or\\s+replace\\s+function\\s+(public\\.)?${fn}\\s*\\(`, "i")
      );
    }
    const created = executable.match(/create or replace function public\.(\w+)/g) ?? [];
    expect(created).toEqual(["create or replace function public.build_jobs_guard_immutable_columns"]);
  });

  it("changes no grant, policy or RLS setting", () => {
    expect(executable).not.toMatch(/^\s*(grant|revoke)\b/im);
    expect(executable).not.toMatch(/create\s+policy|drop\s+policy/i);
    expect(executable).not.toMatch(/enable\s+row\s+level\s+security|disable\s+row\s+level\s+security/i);
  });

  it("makes no table DDL and adds no constraint or index", () => {
    // The only CREATE TABLEs are the three in-session TEMPORARY baselines.
    const tables = executable.match(/create (temporary )?table \w+/g) ?? [];
    expect(tables.every((t) => t.startsWith("create temporary table"))).toBe(true);
    expect(tables.length).toBe(3);
    expect(executable).not.toMatch(/alter table/i);
    expect(executable).not.toMatch(/add constraint|create (unique )?index|foreign key/i);
  });

  it("writes no data to any real table", () => {
    expect(executable).not.toMatch(/insert into public\./i);
    expect(executable).not.toMatch(/update public\.\w+\s+set/i);
    expect(executable).not.toMatch(/delete from public\./i);
    expect(executable).not.toMatch(/^\s*truncate\s+/im);
  });

  it("adds no artifact or paired-device trigger — that is D4c", () => {
    expect(executable).not.toMatch(/on public\.build_artifacts/i);
    expect(executable).not.toMatch(/on public\.paired_devices/i);
    expect(executable).not.toMatch(/on public\.device_pairing_tokens/i);
  });

  it("drops its temporary baselines at the end", () => {
    for (const t of ["d4b_fn_baseline", "d4b_jobs_baseline", "d4b_priv_baseline"]) {
      expect(executable).toContain(`drop table if exists ${t};`);
    }
  });
});
