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
