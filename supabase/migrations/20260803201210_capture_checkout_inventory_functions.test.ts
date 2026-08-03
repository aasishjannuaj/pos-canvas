// Feature 16.3, Migration A — guards that this capture migration stays a
// faithful, behavior-preserving transcription of the live functions.
//
// Migration A's entire value is that it changes nothing. These assertions
// encode that contract, so a future edit that quietly introduces
// SECURITY DEFINER, widens a grant, drops the search_path lock, or alters a
// signature fails here instead of silently changing production's checkout
// behavior on the next apply.
//
// Same convention as the Feature 15.6 bucket-upsert test: this repository has
// no live Postgres test harness (no Docker, no psql), so SQL correctness is
// asserted at the migration-text level.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "20260803201210_capture_checkout_inventory_functions.sql"
);

const sql = readFileSync(migrationPath, "utf-8");

// Comments legitimately discuss SECURITY DEFINER (explaining that it is
// Migration C's job, not this one's), so the executable-SQL assertions below
// run against a comment-stripped copy.
const executable = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

const FUNCTIONS = [
  {
    name: "complete_sale",
    signature:
      "public.complete_sale(uuid, text, text, numeric, numeric, numeric, numeric, jsonb)",
    returns: "RETURNS uuid",
  },
  {
    name: "restock_inventory",
    signature: "public.restock_inventory(uuid, text, integer)",
    returns: "RETURNS jsonb",
  },
  {
    name: "adjust_inventory",
    signature: "public.adjust_inventory(uuid, text, integer)",
    returns: "RETURNS jsonb",
  },
] as const;

describe("Migration A captures all three live functions", () => {
  it("defines each function exactly once", () => {
    for (const fn of FUNCTIONS) {
      const matches = executable.match(
        new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn.name}\\(`, "g")
      );

      expect(matches?.length ?? 0).toBe(1);
    }
  });

  it("preserves each return type", () => {
    for (const fn of FUNCTIONS) {
      expect(executable).toContain(fn.returns);
    }
  });

  it("keeps every function LANGUAGE plpgsql", () => {
    expect(executable.match(/LANGUAGE plpgsql/g)?.length).toBe(FUNCTIONS.length);
  });
});

describe("Migration A preserves the live security posture", () => {
  it("never introduces SECURITY DEFINER in executable SQL", () => {
    // INVOKER is PostgreSQL's default and is therefore correctly absent.
    // Converting complete_sale to DEFINER belongs to Migration C.
    expect(executable.toUpperCase()).not.toContain("SECURITY DEFINER");
  });

  it("locks search_path to public on all three functions", () => {
    expect(executable.match(/SET search_path TO 'public'/g)?.length).toBe(
      FUNCTIONS.length
    );
  });

  it("declares the full four-statement posture for every function", () => {
    // revoke PUBLIC, revoke anon, grant authenticated, grant service_role.
    // Both grants are explicit so the posture is fully declared in source
    // rather than inherited from Supabase's role defaults. postgres is the
    // owner and holds EXECUTE implicitly, so it is deliberately not granted.
    for (const fn of FUNCTIONS) {
      expect(executable).toContain(`revoke all on function ${fn.signature} from public;`);
      expect(executable).toContain(`revoke all on function ${fn.signature} from anon;`);
      expect(executable).toContain(
        `grant execute on function ${fn.signature} to authenticated;`
      );
      expect(executable).toContain(
        `grant execute on function ${fn.signature} to service_role;`
      );
    }
  });

  it("grants EXECUTE to exactly two roles per function", () => {
    expect(
      executable.match(/grant execute on function .* to authenticated;/g)?.length
    ).toBe(FUNCTIONS.length);
    expect(
      executable.match(/grant execute on function .* to service_role;/g)?.length
    ).toBe(FUNCTIONS.length);
    // postgres must never be granted explicitly — it is the owner.
    expect(executable).not.toMatch(/grant\s+execute[^;]*\bto\s+postgres\b/i);
  });

  it("never grants EXECUTE to anon or PUBLIC", () => {
    expect(executable).not.toMatch(/grant\s+execute[^;]*\bto\s+anon\b/i);
    expect(executable).not.toMatch(/grant\s+execute[^;]*\bto\s+public\b/i);
  });
});

describe("Migration A makes no behavioral change", () => {
  it("contains no DDL beyond the three function definitions and their grants", () => {
    const forbidden = [
      /\bcreate\s+table\b/i,
      /\balter\s+table\b/i,
      /\bdrop\s+function\b/i,
      /\bcreate\s+policy\b/i,
      /\bdrop\s+policy\b/i,
      /\bcreate\s+trigger\b/i,
      /\bcreate\s+index\b/i,
      /\balter\s+.*enable row level security/i,
    ];

    for (const pattern of forbidden) {
      expect(executable).not.toMatch(pattern);
    }
  });

  it("keeps complete_sale's owner-only project predicate untouched", () => {
    // Device authorization is Migration C. Until then complete_sale must
    // still scope the project to the calling owner.
    expect(executable).toContain("and user_id = v_user_id");
  });

  it("does not recompute prices or totals yet", () => {
    // Server-side money recomputation is Migration C. This capture must
    // still store the client-supplied amounts verbatim.
    expect(executable).toContain("round(p_subtotal, 2)");
    expect(executable).toContain("round(p_total, 2)");
  });
});
