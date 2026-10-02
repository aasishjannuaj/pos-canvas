// v1.3 Cash Drawer Checkpoint 1B — static guards on the migration text.
//
// TEXT-level assertions, complementing the executed suite beside this file
// (20261002120000_device_cash_drawer_enablement.db.test.ts), which proves the
// behaviour against a real PostgreSQL. These pin the SHAPE: what the migration
// is allowed to contain, the order of the setter's checks, and that the new
// get_device_pairing_state is the accepted definition plus exactly one key.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20261002120000_device_cash_drawer_enablement.sql";
const ACCEPTED_PAIRING_STATE = "20260831120000_device_config_update_offer.sql";

const read = (file: string) => readFileSync(join(migrationsDir, file), "utf-8");
const sql = read(MIGRATION);

/** Comment lines removed, so prose never satisfies or trips an assertion. */
const executable = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

/** One function's full `create or replace ... $function$` text from a file. */
function definition(source: string, name: string): string {
  const start = source.indexOf(`create or replace function public.${name}(`);

  expect(start, `${name} not found`).toBeGreaterThan(-1);

  const open = source.indexOf("$function$", start);
  const close = source.indexOf("$function$", open + 10);

  return source.slice(start, close + 10);
}

const setter = definition(executable, "set_device_cash_drawer_enabled");
const sqlFiles = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

describe("migration ordering and inventory", () => {
  it("is the newest migration", () => {
    expect(sqlFiles[sqlFiles.length - 1]).toBe(MIGRATION);
  });

  it("creates exactly two functions: the setter, and get_device_pairing_state", () => {
    const created = executable.match(/create or replace function public\.(\w+)/g) ?? [];

    expect(created.sort()).toEqual([
      "create or replace function public.get_device_pairing_state",
      "create or replace function public.set_device_cash_drawer_enabled",
    ]);
  });

  it("adds exactly one column, boolean NOT NULL DEFAULT false, with no backfill", () => {
    expect(executable).toContain(
      "alter table public.paired_devices\n  add column if not exists cash_drawer_enabled boolean not null default false;"
    );
    expect(executable.match(/add column/g) ?? []).toHaveLength(1);
    // Outside function bodies: the setter's own UPDATE is not a backfill.
    const statements = executable.replace(/(\$function\$)[\s\S]*?\1/g, "<<BODY>>");

    expect(statements).not.toMatch(/\bupdate\s+public\.paired_devices/i);
  });

  it("touches no table grant, policy, RLS setting, trigger or the immutability guard", () => {
    for (const banned of [
      /grant\s+[^;]*\bon\s+table\b/i,
      /grant\s+(all|update|insert|delete)\b/i,
      /\b(create|alter|drop)\s+policy\b/i,
      /row level security/i,
      /\b(create|drop)\s+(or replace\s+)?trigger\b/i,
      /paired_devices_guard_immutable_columns/,
      /\bdrop\s+(table|function|column)\b/i,
      /is_anonymous/,
    ]) {
      expect(`${banned}`).toBe(`${banned}`);
      expect(executable).not.toMatch(banned);
    }
  });
});

describe("set_device_cash_drawer_enabled", () => {
  it("takes only the device and the flag — no owner, project or platform from the caller", () => {
    expect(setter).toContain(
      "set_device_cash_drawer_enabled(\n  p_device_id uuid,\n  p_enabled boolean\n)\nreturns jsonb"
    );
    expect(setter).not.toMatch(/p_owner|p_project|p_platform/);
  });

  it("is SECURITY DEFINER with a pinned search_path", () => {
    expect(setter).toContain("security definer\nset search_path = public, pg_temp\n");
  });

  it("checks, in order: caller, not-a-till, arguments, owned target, active target, Windows, then writes", () => {
    const at = (needle: string) => {
      const i = setter.indexOf(needle);

      expect(i, needle).toBeGreaterThan(-1);

      return i;
    };

    const caller = at("if v_caller is null then\n    raise exception 'Authentication required';");
    const till = at("if exists (select 1 from public.paired_devices d where d.auth_user_id = v_caller) then\n    raise exception 'Device not found or access denied';");
    const args = at("if p_device_id is null or p_enabled is null then");
    const lookup = at("where d.id = p_device_id\n    and d.owner_id = v_caller\n  for update;");
    const notFound = at("if not found then\n    raise exception 'Device not found or access denied';");
    const inactive = at("if v_device.revoked_at is not null or v_device.unpaired_at is not null then\n    raise exception 'Device not found or access denied';");
    const windows = at("if p_enabled and v_device.platform is distinct from 'windows' then\n    raise exception 'Cash drawer is only supported on Windows devices';");
    const idempotent = at("if v_device.cash_drawer_enabled = p_enabled then");
    const write = at("update public.paired_devices\n  set cash_drawer_enabled = p_enabled\n  where id = p_device_id");

    expect([caller, till, args, lookup, notFound, inactive, windows, idempotent, write]).toEqual(
      [caller, till, args, lookup, notFound, inactive, windows, idempotent, write].slice().sort((a, b) => a - b)
    );
  });

  it("writes ONE column and nothing else", () => {
    expect(setter.match(/update public\.paired_devices/g) ?? []).toHaveLength(1);
    expect(setter).not.toMatch(/set cash_drawer_enabled = p_enabled,/);
    expect(setter).not.toMatch(/revoked_at\s*=|unpaired_at\s*=|build_job_id\s*=|offered_/);
  });

  it("EXECUTE is revoked from PUBLIC, anon and service_role and granted to authenticated only", () => {
    const grants = executable.match(/^(revoke|grant) .*set_device_cash_drawer_enabled.*$/gm) ?? [];

    expect(grants).toEqual([
      "revoke all on function public.set_device_cash_drawer_enabled(uuid, boolean) from public;",
      "revoke all on function public.set_device_cash_drawer_enabled(uuid, boolean) from anon;",
      "revoke all on function public.set_device_cash_drawer_enabled(uuid, boolean) from service_role;",
      "grant execute on function public.set_device_cash_drawer_enabled(uuid, boolean) to authenticated;",
    ]);
  });
});

describe("get_device_pairing_state is the accepted definition plus one gated key", () => {
  const ADDED =
    ",\n    'cash_drawer_enabled', (\n      v_device.cash_drawer_enabled\n      and v_device.revoked_at is null\n      and v_device.platform is not distinct from 'windows'\n    ) is true";

  it("removing the one added key gives back the accepted 20260831120000 definition exactly", () => {
    const accepted = definition(
      read(ACCEPTED_PAIRING_STATE)
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n"),
      "get_device_pairing_state"
    );
    const redefined = definition(executable, "get_device_pairing_state");

    expect(redefined).toContain(ADDED);
    expect(redefined.replace(ADDED, "")).toBe(accepted);
  });

  it("this migration is now the latest definition of get_device_pairing_state", () => {
    const definers = sqlFiles.filter((f) =>
      read(f).includes("create or replace function public.get_device_pairing_state(")
    );

    expect(definers[definers.length - 1]).toBe(MIGRATION);
  });
});

describe("no other migration writes the column", () => {
  it("cash_drawer_enabled is assigned only inside the setter", () => {
    for (const file of sqlFiles) {
      const body = read(file)
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n");
      const writes = body.match(/(?<![\w.])cash_drawer_enabled\s*=(?!\s*p_enabled\b)/g) ?? [];
      const assignments = body.match(/set\s+cash_drawer_enabled\s*=/gi) ?? [];

      expect(`${file}: ${writes.length}`).toBe(`${file}: 0`);
      expect(`${file}: ${assignments.length}`).toBe(`${file}: ${file === MIGRATION ? 1 : 0}`);
    }
  });
});
