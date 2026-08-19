// Real PostgreSQL grammar validation for every migration in this directory.
//
// WHY THIS EXISTS: the Feature 16.3 function-capture migration shipped with
// three `CREATE OR REPLACE FUNCTION … $function$` statements that were never
// terminated with a semicolon (pg_get_functiondef does not emit one). Every
// string-based assertion passed, because the text was individually correct —
// but the file was not valid SQL, and it failed on apply with
// `syntax error at or near "revoke"`.
//
// String matching cannot catch that class of defect. libpg-query embeds
// PostgreSQL's actual parser, so these tests fail for exactly the reasons the
// database would, before anything reaches production.
//
// This validates SYNTAX only. It cannot check that referenced tables or roles
// exist, that RLS behaves as intended, or that a function body is
// semantically correct — those still require applying to a real database.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import pgQuery from "libpg-query";

const { parse, loadModule } = pgQuery as unknown as {
  parse: (sql: string) => Promise<{ stmts: unknown[] }>;
  loadModule: () => Promise<unknown>;
};

const migrationsDir = dirname(fileURLToPath(import.meta.url));

const migrationFiles = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

beforeAll(async () => {
  await loadModule();
});

describe("every migration parses under the real PostgreSQL grammar", () => {
  it("finds migration files to check", () => {
    expect(migrationFiles.length).toBeGreaterThan(0);
  });

  for (const file of migrationFiles) {
    it(`parses ${file}`, async () => {
      const sql = readFileSync(join(migrationsDir, file), "utf-8");

      // Throws a real PostgreSQL syntax error (message and position) if the
      // file is not valid SQL.
      const result = await parse(sql);

      expect(result.stmts.length).toBeGreaterThan(0);
    });
  }
});

describe("statement termination regression (the defect that reached production)", () => {
  it("rejects an unterminated CREATE FUNCTION followed by REVOKE", async () => {
    // The exact shape of the bug, proving these tests actually detect it.
    const broken =
      "CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $function$ begin return 1; end; $function$\n" +
      "revoke all on function public.f() from public;";

    await expect(parse(broken)).rejects.toThrow(/syntax error at or near "revoke"/);
  });

  it("accepts the same SQL once the statement is terminated", async () => {
    const fixed =
      "CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $function$ begin return 1; end; $function$;\n" +
      "revoke all on function public.f() from public;";

    const result = await parse(fixed);

    expect(result.stmts.length).toBe(2);
  });

  it("terminates every dollar-quoted function body in the capture migration", () => {
    const sql = readFileSync(
      join(migrationsDir, "20260803201210_capture_checkout_inventory_functions.sql"),
      "utf-8"
    );

    // Every closing $function$ must be immediately followed by a semicolon.
    const closings = sql.match(/\n\$function\$;?/g) ?? [];
    const terminated = closings.filter((c) => c.endsWith(";"));

    expect(closings.length).toBe(3);
    expect(terminated.length).toBe(3);
  });

  it("parses the capture migration into exactly 15 statements", () => {
    // 3 CREATE OR REPLACE FUNCTION + 12 revoke/grant. A wrong count means
    // statements merged (missing terminator) or split unexpectedly.
    return parse(
      readFileSync(
        join(migrationsDir, "20260803201210_capture_checkout_inventory_functions.sql"),
        "utf-8"
      )
    ).then((r) => {
      expect(r.stmts.length).toBe(15);
    });
  });
});


// ---------------------------------------------------------------------------
// Dependency ordering — can this history build a database FROM SCRATCH?
//
// WHY THIS EXISTS: the first attempt to bootstrap a brand-new Supabase project
// from this history failed on the very first migration with
// `relation "projects" does not exist`. 20260729151600_build_jobs_and_artifacts
// declares a foreign key to `projects`, but `projects` was created by
// 20260803201200_capture_operational_schema — five days LATER in sort order.
//
// Production never revealed it. That migration RETROACTIVELY captured a schema
// that already existed before this repo was migration-managed, and was
// timestamped when it was written rather than when those tables were created,
// so the foreign key always resolved against tables that were already there.
// The defect is only reachable on an empty database, which is exactly the case
// that matters for staging, for disaster recovery, and for any new environment.
//
// The fix was to rename the capture migration to sort first. This guard is
// deliberately SEMANTIC rather than "file X must be first": it recomputes the
// dependency order every run, so it keeps holding as migrations are added and
// it names the offending pair when it fails.
// ---------------------------------------------------------------------------

/** Strips `--` comments so prose about a table never counts as a reference. */
function executableSql(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");
}

describe("the migration history can build a database from scratch", () => {
  const ordered = migrationFiles.map((file) => ({
    file,
    sql: executableSql(readFileSync(join(migrationsDir, file), "utf-8")),
  }));

  /** First index at which each repo-owned public table is created. */
  const createdAt = new Map<string, number>();

  ordered.forEach(({ sql }, index) => {
    const pattern = /create table (?:if not exists )?(?:public\.)?(\w+)/gi;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(sql)) !== null) {
      const table = match[1].toLowerCase();

      if (!createdAt.has(table)) {
        createdAt.set(table, index);
      }
    }
  });

  it("finds the tables this repository creates", () => {
    // A sanity floor: if the extraction breaks, the assertion below would pass
    // vacuously and this guard would be worthless.
    expect(createdAt.size).toBeGreaterThanOrEqual(8);
    expect(createdAt.has("projects")).toBe(true);
  });

  it("no migration references a table before the migration that creates it", () => {
    const violations: string[] = [];

    ordered.forEach(({ file, sql }, index) => {
      const references = new Set<string>();
      const patterns = [
        /references\s+(?:public\.)?(\w+)\s*\(/gi,
        /alter table\s+(?:if exists\s+)?(?:public\.)?(\w+)/gi,
        /(?:from|join|insert into|update)\s+public\.(\w+)/gi,
      ];

      for (const pattern of patterns) {
        let match: RegExpExecArray | null;

        while ((match = pattern.exec(sql)) !== null) {
          references.add(match[1].toLowerCase());
        }
      }

      for (const table of references) {
        const creator = createdAt.get(table);

        // Unknown tables are Supabase's own (auth.users, storage.objects) or
        // system catalogs. Only tables THIS repo creates are ordered here.
        if (creator === undefined) continue;

        if (creator > index) {
          violations.push(
            `${file} references "${table}", which is not created until ${ordered[creator].file}`
          );
        }
      }
    });

    expect(violations).toEqual([]);
  });
});
