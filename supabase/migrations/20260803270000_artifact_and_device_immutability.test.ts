// Milestone 16, Feature 16.3 — Migration D4c static guards.
//
// TEXT-level assertions. libpg-query parses a DO block's body as an opaque
// string, so the plpgsql inside both guards and the verification block is not
// statically validated; the verification block is self-checking at apply time.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(migrationsDir, "20260803270000_artifact_and_device_immutability.sql"),
  "utf-8"
);

const executable = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

// Approved by review; every one is proven to have no writer.
const DEVICE_IMMUTABLE = [
  "auth_user_id",
  "owner_id",
  "project_id",
  "build_job_id",
  "device_name",
  "platform",
  "created_at",
  "last_seen_at",
] as const;

// The only two columns revoke_paired_device writes.
const DEVICE_MUTABLE = ["revoked_at", "revoked_by"] as const;

const deviceGuard = executable.slice(
  executable.indexOf("create or replace function public.paired_devices_guard_immutable_columns()"),
  executable.indexOf("create or replace trigger paired_devices_guard_immutable")
);
const artifactGuard = executable.slice(
  executable.indexOf("create or replace function public.build_artifacts_guard_immutable_updates()"),
  executable.indexOf("create or replace trigger build_artifacts_guard_immutable")
);

describe("migration ordering", () => {
  it("sorts after D4b", () => {
    expect(
      "20260803260000_build_jobs_immutability_guard.sql" <
        "20260803270000_artifact_and_device_immutability.sql"
    ).toBe(true);
  });
});

describe("object inventory", () => {
  it("creates exactly two functions, both guards", () => {
    const created = executable.match(/create or replace function public\.(\w+)/g) ?? [];
    expect(created.sort()).toEqual([
      "create or replace function public.build_artifacts_guard_immutable_updates",
      "create or replace function public.paired_devices_guard_immutable_columns",
    ]);
  });

  it("creates exactly two triggers, both BEFORE UPDATE FOR EACH ROW", () => {
    expect(executable).toContain(
      "create or replace trigger build_artifacts_guard_immutable\n  before update on public.build_artifacts\n  for each row\n  execute function public.build_artifacts_guard_immutable_updates();"
    );
    expect(executable).toContain(
      "create or replace trigger paired_devices_guard_immutable\n  before update on public.paired_devices\n  for each row\n  execute function public.paired_devices_guard_immutable_columns();"
    );
    const triggers = executable.match(/create or replace trigger \w+/g) ?? [];
    expect(triggers.length).toBe(2);
  });

  it("targets only build_artifacts and paired_devices with new DDL", () => {
    const targets = new Set(
      [...executable.matchAll(/before update on public\.(\w+)/g)].map((m) => m[1])
    );
    expect([...targets].sort()).toEqual(["build_artifacts", "paired_devices"]);
  });

  it("adds no DELETE or INSERT trigger", () => {
    expect(executable).not.toMatch(/before\s+delete|after\s+delete|before\s+insert|after\s+insert/i);
    expect(executable).toContain("must not fire on DELETE");
    expect(executable).toContain("must not fire on INSERT");
  });
});

describe("build_artifacts guard", () => {
  it("rejects unconditionally, with no branching at all", () => {
    expect(artifactGuard).toContain(
      "raise exception 'build_artifacts rows cannot be updated after creation';"
    );
    // No conditional: every UPDATE raises.
    expect(artifactGuard).not.toMatch(/\bif\b|\bcase\b|is distinct from/i);
    expect(artifactGuard).not.toContain("return new");
  });

  it("uses a fixed message with no interpolation", () => {
    const raises = artifactGuard.match(/raise exception[^;]*;/g) ?? [];
    expect(raises.length).toBe(1);
    expect(raises[0]).not.toContain("%");
    for (const leak of ["storage_path", "checksum", "original_filename", "build_job_id", "old.", "new."]) {
      expect(raises[0]).not.toContain(leak);
    }
  });

  it("is SECURITY DEFINER with a locked search_path", () => {
    expect(artifactGuard).toContain("security definer");
    expect(artifactGuard).toContain("set search_path to public, pg_temp");
    expect(artifactGuard).toContain("returns trigger");
    expect(artifactGuard).toContain("language plpgsql");
  });
});

describe("paired_devices guard", () => {
  it("freezes exactly the eight approved columns", () => {
    for (const col of DEVICE_IMMUTABLE) {
      expect(deviceGuard).toContain(`new.${col} is distinct from old.${col}`);
      expect(deviceGuard).toContain(`paired_devices.${col} cannot be changed after creation`);
    }
    const compared = [...deviceGuard.matchAll(/new\.(\w+) is distinct from old\.\1/g)].map((m) => m[1]);
    expect([...new Set(compared)].sort()).toEqual([...DEVICE_IMMUTABLE].sort());
    expect((deviceGuard.match(/cannot be changed after creation/g) ?? []).length)
      .toBe(DEVICE_IMMUTABLE.length);
  });

  it("leaves revoked_at and revoked_by writable — the only real writer", () => {
    for (const col of DEVICE_MUTABLE) {
      expect(deviceGuard).not.toContain(`new.${col} is distinct from old.${col}`);
      expect(deviceGuard).not.toContain(`paired_devices.${col} cannot be changed`);
    }
  });

  it("uses IS DISTINCT FROM so NULL columns compare correctly", () => {
    // device_name, platform and last_seen_at are all nullable; <> would miss a
    // NULL-to-value change entirely.
    expect(deviceGuard).not.toMatch(/new\.\w+ <> old\.\w+/);
  });

  it("returns NEW so an allowed revocation proceeds", () => {
    expect(deviceGuard).toContain("return new;");
  });

  it("is SECURITY DEFINER with a locked search_path", () => {
    expect(deviceGuard).toContain("security definer");
    expect(deviceGuard).toContain("set search_path to public, pg_temp");
    expect(deviceGuard).toContain("returns trigger");
    expect(deviceGuard).toContain("language plpgsql");
  });

  it("names only the column in each message, never a value", () => {
    const raises = deviceGuard.match(/raise exception[^;]*;/g) ?? [];
    expect(raises.length).toBe(DEVICE_IMMUTABLE.length);
    for (const r of raises) {
      expect(r).not.toContain("%");
      expect(r).not.toContain("old.");
      expect(r).not.toContain("new.");
    }
  });
});

describe("guard functions read and write nothing", () => {
  it("performs no table access and no dynamic SQL", () => {
    for (const body of [artifactGuard, deviceGuard]) {
      expect(body).not.toMatch(/\bexecute\s+format|\bexecute\s+'/i);
      expect(body).not.toMatch(/\bfrom\s+public\.|\binto\s+\w+\s+from\b/i);
      expect(body).not.toMatch(/insert into|update public\.|delete from/i);
      expect(body).not.toMatch(/\bperform\b/i);
    }
  });
});

describe("scope containment", () => {
  it("makes no build_jobs DDL and replaces no build_jobs trigger", () => {
    expect(executable).not.toMatch(/before update on public\.build_jobs/i);
    expect(executable).not.toMatch(/create or replace trigger build_jobs_/i);
    expect(executable).not.toMatch(
      /create\s+or\s+replace\s+function\s+public\.(set_build_jobs_updated_at|build_jobs_guard_immutable_columns)/i
    );
    expect(executable).not.toMatch(/alter table public\.build_jobs/i);
  });

  it("replaces no checkout, pairing or worker RPC", () => {
    for (const fn of [
      "complete_sale", "complete_sale_v2", "resolve_sale_owner",
      "create_device_pairing_token", "cancel_device_pairing_token",
      "redeem_device_pairing_token", "revoke_paired_device",
      "get_device_pairing_state", "get_device_config",
      "claim_next_build_job", "heartbeat_build_job", "complete_build_job",
      "fail_build_job", "finalize_build_job_with_artifact",
    ]) {
      expect(executable).not.toMatch(
        new RegExp(`create\\s+or\\s+replace\\s+function\\s+(public\\.)?${fn}\\s*\\(`, "i")
      );
    }
  });

  it("issues no GRANT, REVOKE, policy or ALTER FUNCTION", () => {
    expect(executable).not.toMatch(/^\s*(grant|revoke)\b/im);
    expect(executable).not.toMatch(/create\s+policy|drop\s+policy|alter\s+policy/i);
    expect(executable).not.toMatch(/alter\s+function/i);
    expect(executable).not.toMatch(/enable\s+row\s+level\s+security|disable\s+row\s+level\s+security/i);
  });

  it("adds no constraint, index or composite key", () => {
    expect(executable).not.toMatch(/add constraint|create (unique )?index|foreign key|references /i);
    expect(executable).not.toMatch(/alter table public\.(build_artifacts|paired_devices)/i);
  });

  it("writes no data and creates only TEMPORARY tables", () => {
    const tables = executable.match(/create (temporary )?table \w+/g) ?? [];
    expect(tables.length).toBe(6);
    expect(tables.every((t) => t.startsWith("create temporary table"))).toBe(true);
    expect(executable).not.toMatch(/insert into public\./i);
    expect(executable).not.toMatch(/update public\.\w+\s+set/i);
    expect(executable).not.toMatch(/delete from public\./i);
    expect(executable).not.toMatch(/^\s*truncate\s+/im);
  });
});

describe("verification block", () => {
  it("captures a self-verifying in-session baseline", () => {
    for (const t of [
      "d4c_tbl_baseline", "d4c_trg_baseline", "d4c_pol_baseline",
      "d4c_priv_baseline", "d4c_fn_baseline", "d4c_allfn_baseline",
    ]) {
      expect(executable).toContain(`create temporary table ${t}`);
      expect(executable).toContain(`drop table if exists ${t};`);
    }
  });

  it("pins the D4b build_jobs count and fingerprint", () => {
    expect(executable).toContain("'f9772a2f8fa5c6e1c862609a8d30f94d'");
    expect(executable).toContain("D4c: expected 5 build_jobs rows, found %");
    expect(executable).toContain("D4c: build_jobs fingerprint does not match the D4b baseline");
  });

  it("asserts all three tables are unchanged in count and content", () => {
    expect(executable).toContain("D4c: % row count changed from % to %");
    expect(executable).toContain("D4c: build_artifacts rows changed");
    expect(executable).toContain("D4c: paired_devices rows changed");
    expect(executable).toContain("D4c: build_jobs rows changed");
  });

  it("asserts every listed function is unchanged", () => {
    for (const fn of [
      "create_device_pairing_token", "cancel_device_pairing_token",
      "redeem_device_pairing_token", "revoke_paired_device",
      "complete_sale", "complete_sale_v2",
      "claim_next_build_job", "heartbeat_build_job", "complete_build_job",
      "fail_build_job", "finalize_build_job_with_artifact",
      "set_build_jobs_updated_at", "build_jobs_guard_immutable_columns",
    ]) {
      expect(executable).toContain(`'${fn}'`);
    }
    expect(executable).toContain("changed body, posture, owner or grants");
  });

  it("proves EXACTLY two functions and two triggers are new", () => {
    expect(executable).toContain("D4c: unexpected set of new functions: %");
    expect(executable).toContain("D4c: unexpected set of new triggers: %");
    expect(executable).toContain("p.proname not in (select proname from d4c_allfn_baseline)");
    expect(executable).toContain("t.tgname not in (select tgname from d4c_trg_baseline)");
  });

  it("asserts the new functions and triggers have the required posture", () => {
    expect(executable).toContain("must be postgres-owned, SECURITY DEFINER and search_path-locked");
    expect(executable).toContain("must be FOR EACH ROW");
    expect(executable).toContain("must be BEFORE");
    expect(executable).toContain("must fire on UPDATE");
    expect(executable).toContain("must be enabled");
  });

  it("asserts policies, grants and pre-existing triggers are unchanged", () => {
    expect(executable).toContain("D4c: a pre-existing trigger changed or disappeared");
    expect(executable).toContain("D4c: the number of RLS policies changed");
    expect(executable).toContain("D4c: an RLS policy definition changed");
    expect(executable).toContain("D4c: the D1 table privilege matrix changed");
  });
});
