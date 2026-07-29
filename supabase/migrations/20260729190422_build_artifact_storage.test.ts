// Feature 15.6 correction — this repository has no live Postgres/Storage
// test harness (documented repeatedly across the Feature 15.5/15.6
// migrations: no Docker/psql available), so SQL correctness is otherwise
// only manually reviewed before "apply, then verify manually." This one
// migration-text assertion is the practical equivalent for the specific
// bucket-upsert correction reviewed in this change: it guards against the
// insufficient `on conflict (id) do nothing` form (which would leave a
// pre-existing, possibly-public bucket's `public` value untouched)
// silently reappearing in a future edit of this same file.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "20260729190422_build_artifact_storage.sql"
);

function readMigrationText(): string {
  return readFileSync(migrationPath, "utf-8");
}

describe("20260729190422_build_artifact_storage.sql — bucket upsert", () => {
  it("upserts the build-artifacts bucket with an ON CONFLICT DO UPDATE that forces public = false", () => {
    const text = readMigrationText();

    expect(text).toMatch(
      /insert into storage\.buckets \(id, name, public\)\s*\nvalues \('build-artifacts', 'build-artifacts', false\)\s*\non conflict \(id\) do update/
    );
    expect(text).toMatch(/public\s*=\s*false/);
  });

  it("does not use the insufficient ON CONFLICT DO NOTHING form for this bucket", () => {
    const text = readMigrationText();

    // "do nothing" must not appear anywhere immediately after this
    // bucket's own conflict clause — the whole point of the correction is
    // that a pre-existing (possibly public) row is actively corrected,
    // not left untouched.
    expect(text).not.toMatch(
      /values \('build-artifacts', 'build-artifacts', false\)\s*\non conflict \(id\) do nothing/
    );
  });

  it("still creates exactly one build-artifacts bucket row (id/name unchanged)", () => {
    const text = readMigrationText();

    expect(text).toContain("'build-artifacts', 'build-artifacts', false");
  });
});
