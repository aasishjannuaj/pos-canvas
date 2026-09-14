// v1.3 Feature 1A — static guards for the employee identity migration.
//
// SCOPE, STATED PLAINLY: these are TEXT and PARSE level assertions. They prove
// the migration is valid SQL and declares the intended security posture. They
// do NOT prove runtime behaviour — that a lockout really throttles, that the
// partial unique index really rejects a second concurrent login, that RLS
// filters as intended, or that bcrypt actually runs can only be established by
// executing against a real database. No such claim is made here, and no
// database was available while these were written.
//
// Several tests below are NEGATIVE CONTROLS: they mutate a copy of the
// migration text to remove or weaken a security property and assert that the
// corresponding guard then FAILS. A guard that cannot fail is not a guard, and
// this suite is the only place that can demonstrate the difference without a
// database.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import pgQuery from "libpg-query";

const { parse, loadModule } = pgQuery as unknown as {
  parse: (sql: string) => Promise<{ stmts: unknown[] }>;
  loadModule: () => Promise<unknown>;
};

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const FILENAME = "20260914120000_employee_identity_and_pos_sessions.sql";
const sql = readFileSync(join(migrationsDir, FILENAME), "utf-8");

/** The migration with every comment line removed, so prose never satisfies a guard. */
const executable = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

const NEW_TABLES = ["employees", "employee_pos_sessions", "employee_login_attempts"] as const;

/** Callable by an ordinary signed-in caller. */
const PUBLIC_FUNCTIONS = [
  "employee_login",
  "get_current_employee_session",
  "employee_logout",
  "create_employee",
  "list_employees",
  "set_employee_active",
  "set_employee_pin",
] as const;

/** Callable by nobody — reachable only from inside the functions above. */
const PRIVATE_FUNCTIONS = [
  "employee_pin_hash",
  "employee_pin_verify",
  "employee_login_note_failure",
  "employee_project_pin_taken",
  "set_employees_updated_at",
] as const;

beforeAll(async () => {
  await loadModule();
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe("migration ordering", () => {
  it("sorts after every migration in the v1.2.0 release", () => {
    // String comparison, which is how a migration runner orders filenames.
    for (const earlier of [
      "20260729000000_capture_operational_schema.sql",
      "20260803210000_device_pairing.sql",
      "20260819120000_offline_sale_contract_and_complete_sale_v4.sql",
      "20260823120000_device_voluntary_unpair.sql",
      "20260831120000_device_config_update_offer.sql",
      "20260913120000_receipt_fidelity.sql",
    ]) {
      expect(earlier < FILENAME).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Grammar — including the dynamically generated bodies
// ---------------------------------------------------------------------------

describe("PostgreSQL grammar", () => {
  it("parses the whole migration", async () => {
    const result = await parse(sql);

    expect(result.stmts.length).toBeGreaterThan(0);
  });

  // COMPENSATING CONTROL #1 for building the hashing helpers through format().
  //
  // A dollar-quoted string is opaque to the parser: libpg-query validates the
  // DO block that CONTAINS these bodies, not the bodies themselves, so without
  // this they would be the only unparsed SQL in the repository. Extracting them
  // and substituting the %I placeholder restores that coverage.
  const dynamicBodies = [...sql.matchAll(/\$ddl\$([\s\S]*?)\$ddl\$/g)].map((m) => m[1]);

  it("builds exactly two function bodies dynamically", () => {
    expect(dynamicBodies.length).toBe(2);
  });

  it("parses each dynamically generated function body", async () => {
    for (const raw of dynamicBodies) {
      const rendered = raw.replaceAll("%I", "extensions");

      const result = await parse(rendered);

      expect(result.stmts.length).toBe(1);
    }
  });

  it("leaves no stray format() specifier in a dynamic body", () => {
    // A literal % that is not an intended %I would make format() raise at apply
    // time — for instance a `like '$2%'` written inside one of these bodies.
    for (const raw of dynamicBodies) {
      expect(raw.replaceAll("%I", "")).not.toContain("%");
    }
  });

  it("NEGATIVE CONTROL: a malformed dynamic body is rejected by the parser", async () => {
    // The defect class migrations.parse.test.ts exists for: an unterminated
    // CREATE FUNCTION swallowing the statement that follows it. This is what
    // makes the extraction test above a real check rather than a formality.
    await expect(
      parse(
        "create or replace function f() returns int language plpgsql as $fn$ begin return 1; end; $fn$\n" +
          "revoke all on function public.f() from public;"
      )
    ).rejects.toThrow(/syntax error at or near "revoke"/);
  });
});

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

describe("PIN hashing", () => {
  it("discovers pgcrypto's schema instead of assuming it", () => {
    expect(executable).toContain("from pg_extension e");
    expect(executable).toContain("join pg_namespace n on n.oid = e.extnamespace");
    expect(executable).toContain("where e.extname = 'pgcrypto'");
  });

  it("proves both required pgcrypto functions exist before using them", () => {
    expect(executable).toContain("to_regprocedure(format('%I.crypt(text, text)', v_schema))");
    expect(executable).toContain(
      "to_regprocedure(format('%I.gen_salt(text, integer)', v_schema))"
    );
  });

  it("aborts rather than guessing when pgcrypto cannot be proven", () => {
    // Three distinct raises: not installed, no crypt, no gen_salt.
    expect(executable).toContain("Feature 1A requires the pgcrypto extension");
    expect(executable).toContain("crypt(text, text) is not present there");
    expect(executable).toContain("gen_salt(text, integer) is not present there");
  });

  it("never hardcodes an extension schema", () => {
    expect(executable).not.toContain("extensions.crypt");
    expect(executable).not.toContain("extensions.gen_salt");
    expect(executable).not.toContain("extensions.digest");
  });

  it("never widens search_path to reach pgcrypto", () => {
    const settings = executable.match(/set search_path[^;\n]*/g) ?? [];

    expect(settings.length).toBeGreaterThan(0);

    for (const setting of settings) {
      expect(setting).toBe("set search_path = public, pg_temp");
    }
  });

  it("uses a slow salted primitive, not a fast digest", () => {
    expect(executable).toContain("%I.gen_salt('bf', 10)");
    // sha256 appears exactly once in executable SQL: the verification block
    // proving a fast digest is REJECTED as a stored hash.
    const sha256Uses = executable.match(/sha256\(/g) ?? [];
    expect(sha256Uses.length).toBe(1);
    expect(executable).toContain("employee_pin_verify accepted a fast digest");
    expect(executable).not.toContain("md5(p_pin");
    expect(executable).not.toContain("digest(p_pin");
  });

  // COMPENSATING CONTROL #2 — the apply-time round trip.
  it("asserts a live hash/verify round trip at apply time", () => {
    expect(executable).toContain("v_hash := public.employee_pin_hash('1234');");
    expect(executable).toContain("if not public.employee_pin_verify('1234', v_hash) then");
    expect(executable).toContain("if public.employee_pin_verify('4321', v_hash) then");
  });

  it("asserts the hash is salted by proving it is not deterministic", () => {
    expect(executable).toContain("if v_hash = public.employee_pin_hash('1234') then");
    expect(executable).toContain("the salt is not being applied");
  });

  it("asserts the generated bodies really call pgcrypto schema-qualified", () => {
    expect(executable).toContain("format('%I.crypt(', v_schema)");
    expect(executable).toContain("format('%I.gen_salt(', v_schema)");
  });
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("schema", () => {
  it("creates each table exactly once", () => {
    for (const table of NEW_TABLES) {
      const matches = executable.match(
        new RegExp(`create table if not exists public\\.${table}\\b`, "g")
      );

      expect(matches?.length ?? 0).toBe(1);
    }
  });

  it("stores only a bcrypt hash — there is no plaintext or reversible PIN column", () => {
    expect(executable).toContain("pin_hash text not null");
    expect(executable).not.toMatch(/^\s*(pin|pin_plain\w*|plaintext_pin|pin_code)\s+text/im);
  });

  it("constrains pin_hash to the bcrypt modular-crypt shape", () => {
    expect(executable).toContain("check (pin_hash like '$2%' and length(pin_hash) = 60)");
  });

  it("NEGATIVE CONTROL: a SHA-256 hex digest fails the pin_hash shape rule", () => {
    // 64 hex characters, no $2 prefix — the value a fast-digest implementation
    // would have produced. Both halves of the constraint reject it.
    const sha256Hex = "a".repeat(64);

    expect(sha256Hex.startsWith("$2")).toBe(false);
    expect(sha256Hex.length).not.toBe(60);
  });

  it("NEGATIVE CONTROL: a real bcrypt string satisfies the pin_hash shape rule", () => {
    const bcrypt = "$2a$10$" + "b".repeat(53);

    expect(bcrypt.startsWith("$2")).toBe(true);
    expect(bcrypt.length).toBe(60);
  });

  it("closes the role set to exactly owner, manager and cashier", () => {
    expect(executable).toContain("check (role in ('owner', 'manager', 'cashier'))");
    // No enum type, matching a schema that contains none.
    expect(executable).not.toContain("create type");
  });

  it("ties active and deactivated_at together in both directions", () => {
    expect(executable).toContain(
      "check ((active and deactivated_at is null)\n           or (not active and deactivated_at is not null))"
    );
  });

  it("does not persist a third project_id copy on sessions or attempts", () => {
    const sessionsBlock = executable.slice(
      executable.indexOf("create table if not exists public.employee_pos_sessions"),
      executable.indexOf("create unique index if not exists employee_pos_sessions_one_open_per_device")
    );
    const attemptsBlock = executable.slice(
      executable.indexOf("create table if not exists public.employee_login_attempts"),
      executable.indexOf("comment on table public.employee_login_attempts")
    );

    expect(sessionsBlock).not.toContain("project_id");
    expect(attemptsBlock).not.toContain("project_id");
  });

  it("keys brute-force state by the register, not by a claimed identity", () => {
    expect(executable).toContain(
      "paired_device_id uuid primary key\n    references public.paired_devices(id) on delete cascade"
    );
  });
});

// ---------------------------------------------------------------------------
// The one-session invariant
// ---------------------------------------------------------------------------

describe("one open session per register", () => {
  it("enforces the invariant with a partial unique index", () => {
    expect(executable).toContain(
      "create unique index if not exists employee_pos_sessions_one_open_per_device\n  on public.employee_pos_sessions using btree (paired_device_id)\n  where ended_at is null"
    );
  });

  it("verifies at apply time that the index really is UNIQUE and partial", () => {
    expect(executable).toContain("and indexdef like '%UNIQUE%'");
    expect(executable).toContain("and indexdef like '%ended_at IS NULL%'");
  });

  it("closes the incumbent session rather than relying on the unique failure", () => {
    expect(executable).toContain("set ended_at = v_now,\n          end_reason = 'switched'");
    expect(executable).toContain(
      "where s.paired_device_id = v_device.id\n        and s.ended_at is null;"
    );
  });
});

// ---------------------------------------------------------------------------
// Privileges and RLS
// ---------------------------------------------------------------------------

describe("privileges", () => {
  it("revokes every privilege from every role on every new table", () => {
    for (const table of NEW_TABLES) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(executable).toContain(
          `revoke all privileges on table public.${table} from ${role};`
        );
      }
    }
  });

  it("grants no table privilege to anyone — not even the owner", () => {
    const grants = executable.match(/grant [^;]*on table [^;]*;/g) ?? [];

    expect(grants).toEqual([]);
  });

  it("NEGATIVE CONTROL: the no-table-grant guard detects an added grant", () => {
    const mutated = executable.replace(
      "alter table public.employees enable row level security;",
      "alter table public.employees enable row level security;\ngrant select on table public.employees to authenticated;"
    );

    expect(mutated.match(/grant [^;]*on table [^;]*;/g) ?? []).not.toEqual([]);
  });

  it("enables row level security on all three tables", () => {
    for (const table of NEW_TABLES) {
      expect(executable).toContain(`alter table public.${table} enable row level security;`);
    }
  });

  it("creates no policy at all", () => {
    expect(executable).not.toContain("create policy");
  });

  it("verifies zero policies and zero privileges at apply time", () => {
    expect(executable).toContain("must have zero policies, found");
    expect(executable).toContain("must hold no privilege on");
  });

  it("verifies the locked search_path exactly, so a third schema cannot slip in", () => {
    // Deliberately stricter than the existing migrations'
    // `like 'search_path=%public%pg_temp%'`, which would also accept
    // `public, extensions, pg_temp`.
    expect(executable).toContain(
      "regexp_replace(cfg, '[\\s\"]', '', 'g') = 'search_path=public,pg_temp'"
    );
    expect(executable).not.toContain("like 'search_path=%public%pg_temp%'");
  });

  it("never grants TRUNCATE anywhere", () => {
    expect(executable).not.toMatch(/grant[^;]*truncate/i);
    // ...and proves the absence, since a Supabase table is born with it.
    expect(executable).toContain("('TRUNCATE')");
  });
});

describe("function privileges", () => {
  for (const fn of PUBLIC_FUNCTIONS) {
    it(`${fn} is revoked from public and anon, then granted to authenticated only`, () => {
      expect(executable).toMatch(
        new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public;`)
      );
      expect(executable).toMatch(
        new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from anon;`)
      );
      expect(executable).toMatch(
        new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to authenticated;`)
      );
      expect(executable).not.toMatch(
        new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`)
      );
    });
  }

  for (const fn of PRIVATE_FUNCTIONS) {
    it(`${fn} is granted to nobody`, () => {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(executable).toMatch(
          new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from ${role};`)
        );
      }

      expect(executable).not.toMatch(
        new RegExp(`grant execute on function public\\.${fn}\\(`)
      );
    });
  }

  it("grants nothing to service_role anywhere in the migration", () => {
    expect(executable).not.toMatch(/grant[^;]*to service_role/);
  });
});

describe("every new function is SECURITY DEFINER with a locked search_path", () => {
  for (const fn of [...PUBLIC_FUNCTIONS, ...PRIVATE_FUNCTIONS]) {
    it(fn, () => {
      const start = executable.indexOf(`create or replace function public.${fn}(`);

      expect(start).toBeGreaterThan(-1);

      // The header runs from the name to the body delimiter.
      const header = executable.slice(start, executable.indexOf("as $", start));

      expect(header).toContain("security definer");
      expect(header).toContain("set search_path = public, pg_temp");
    });
  }
});

// ---------------------------------------------------------------------------
// Server-derived identity
// ---------------------------------------------------------------------------

describe("a device never supplies its own identity", () => {
  it("employee_login takes only the PIN", () => {
    expect(executable).toContain("create or replace function public.employee_login(p_pin text)");
  });

  it("get_current_employee_session and employee_logout take nothing", () => {
    expect(executable).toContain(
      "create or replace function public.get_current_employee_session()"
    );
    expect(executable).toContain("create or replace function public.employee_logout()");
  });

  it("resolves the register from auth.uid() in all three device RPCs", () => {
    const deviceBlock = executable.slice(
      executable.indexOf("create or replace function public.employee_login(p_pin text)"),
      executable.indexOf("create or replace function public.employee_project_pin_taken")
    );

    const resolutions = deviceBlock.match(/where d\.auth_user_id = v_caller/g) ?? [];

    expect(resolutions.length).toBe(3);
    expect(deviceBlock).not.toContain("p_project_id");
    expect(deviceBlock).not.toContain("p_device_id");
    expect(deviceBlock).not.toContain("p_paired_device_id uuid,\n  p_project");
  });

  it("uses the Feature 25.1 active-device predicate, not revocation alone", () => {
    const matches =
      executable.match(/d\.revoked_at is null\n    and d\.unpaired_at is null/g) ?? [];

    // employee_login, get_current_employee_session, employee_logout.
    expect(matches.length).toBe(3);
  });

  it("NEGATIVE CONTROL: dropping the unpaired check breaks the predicate guard", () => {
    const mutated = executable.replaceAll("\n    and d.unpaired_at is null", "");

    expect(mutated.match(/d\.revoked_at is null\n    and d\.unpaired_at is null/g)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Generic login failure
// ---------------------------------------------------------------------------

describe("login failures are generic", () => {
  it("emits exactly one credential failure code", () => {
    const failures = executable.match(/'error', 'invalid_credentials'/g) ?? [];

    // Written once, in the shared helper, so the four causes cannot drift apart.
    expect(failures.length).toBe(1);
  });

  it("routes malformed PIN, no match and cross-project through that one helper", () => {
    const loginBlock = executable.slice(
      executable.indexOf("create or replace function public.employee_login(p_pin text)"),
      executable.indexOf("revoke all on function public.employee_login(text) from public;")
    );

    const noted = loginBlock.match(/public\.employee_login_note_failure\(v_device\.id, v_now\)/g) ?? [];

    expect(noted.length).toBe(3);
  });

  it("never leaks an employee id, name or role on a failure", () => {
    const helper = executable.slice(
      executable.indexOf("create or replace function public.employee_login_note_failure"),
      executable.indexOf("revoke all on function public.employee_login_note_failure")
    );

    expect(helper).toContain("jsonb_build_object('ok', false, 'error', 'invalid_credentials')");
    expect(helper).not.toContain("display_name");
    expect(helper).not.toContain("employeeId");
    expect(helper).not.toContain("failed_count'");
  });

  it("never returns a hash, a PIN or a counter on success", () => {
    const loginBlock = executable.slice(
      executable.indexOf("create or replace function public.employee_login(p_pin text)"),
      executable.indexOf("revoke all on function public.employee_login(text) from public;")
    );
    const success = loginBlock.slice(loginBlock.indexOf("'ok', true,"));

    for (const forbidden of ["pin_hash", "p_pin", "failed_count", "locked_until", "owner_id"]) {
      expect(success).not.toContain(forbidden);
    }
  });

  it("never passes PIN material as an argument to a raise", () => {
    const raises = executable.match(/raise exception[^;]*/g) ?? [];

    expect(raises.length).toBeGreaterThan(0);

    for (const raise of raises) {
      // Strip the quoted format string: what remains is the argument list,
      // which is the only part a VALUE could reach. A function name inside the
      // message text is prose, not a leak.
      const args = raise.replace(/'[^']*'/g, "");

      for (const secret of ["p_pin", "v_hash", "pin_hash"]) {
        expect(args).not.toContain(secret);
      }
    }
  });

  it("counts a malformed PIN as a failed attempt rather than a free probe", () => {
    expect(executable).toContain(
      "if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then\n    return public.employee_login_note_failure(v_device.id, v_now);"
    );
  });

  it("never trims or coerces a PIN into validity", () => {
    expect(executable).not.toContain("btrim(p_pin");
    expect(executable).not.toContain("trim(p_pin");
    expect(executable).not.toContain("lpad(p_pin");
  });
});

// ---------------------------------------------------------------------------
// Brute force
// ---------------------------------------------------------------------------

describe("brute-force protection is server-authoritative", () => {
  it("returns rather than raising, so the counter survives", () => {
    const helper = executable.slice(
      executable.indexOf("create or replace function public.employee_login_note_failure"),
      executable.indexOf("revoke all on function public.employee_login_note_failure")
    );

    expect(helper).toContain("update public.employee_login_attempts");
    expect(helper).not.toContain("raise exception");
  });

  it("implements a monotonic capped ladder", () => {
    for (const [threshold, seconds] of [
      [">= 9", 900],
      ["= 8", 300],
      ["= 7", 120],
      ["= 6", 60],
      ["= 5", 30],
    ] as const) {
      expect(executable).toContain(
        `when a.failed_count + 1 ${threshold} then p_now + make_interval(secs => ${seconds})`
      );
    }
  });

  it("clears an expired lock instead of leaving stale state readable", () => {
    expect(executable).toContain("else null\n      end,");
  });

  it("resets the failure state only on a successful login", () => {
    const deletes = executable.match(/delete from public\.employee_login_attempts/g) ?? [];

    expect(deletes.length).toBe(1);
  });

  it("reports a lockout distinctly, carrying only a wait", () => {
    expect(executable).toContain("'error', 'locked_out'");
    expect(executable).toContain("'retryAfterSeconds',");
    expect(executable).toContain(
      "ceil(extract(epoch from (v_attempts.locked_until - v_now)))::integer"
    );
  });

  it("checks the lock BEFORE any PIN work is done", () => {
    const loginBlock = executable.slice(
      executable.indexOf("create or replace function public.employee_login(p_pin text)")
    );

    expect(loginBlock.indexOf("'error', 'locked_out'")).toBeLessThan(
      loginBlock.indexOf("public.employee_pin_verify")
    );
  });

  it("does not touch paired_devices to store rate state", () => {
    expect(executable).not.toMatch(/update public\.paired_devices/);
  });
});

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

describe("login serializes per register", () => {
  it("locks the resolved paired_devices row FOR UPDATE", () => {
    const loginBlock = executable.slice(
      executable.indexOf("create or replace function public.employee_login(p_pin text)"),
      executable.indexOf("revoke all on function public.employee_login(text) from public;")
    );

    expect(loginBlock).toContain("from public.paired_devices d");
    expect(loginBlock).toContain("for update;");
    // The lock is taken before the attempts row is read or any PIN is examined.
    expect(loginBlock.indexOf("for update;")).toBeLessThan(
      loginBlock.indexOf("employee_login_attempts")
    );
  });

  it("NEGATIVE CONTROL: removing FOR UPDATE breaks the serialization guard", () => {
    const mutated = executable.replace("  for update;", "  ;");
    const loginBlock = mutated.slice(
      mutated.indexOf("create or replace function public.employee_login(p_pin text)"),
      mutated.indexOf("revoke all on function public.employee_login(text) from public;")
    );

    expect(loginBlock).not.toContain("for update;");
  });
});

// ---------------------------------------------------------------------------
// Owner management path
// ---------------------------------------------------------------------------

describe("owner-only management RPCs", () => {
  const OWNER_FUNCTIONS = [
    "create_employee",
    "list_employees",
    "set_employee_active",
    "set_employee_pin",
  ] as const;

  for (const fn of OWNER_FUNCTIONS) {
    it(`${fn} rejects a paired device outright`, () => {
      const block = executable.slice(
        executable.indexOf(`create or replace function public.${fn}(`),
        executable.indexOf(`revoke all on function public.${fn}(`)
      );

      expect(block).toContain(
        "if exists (select 1 from public.paired_devices d where d.auth_user_id = v_caller) then"
      );
      expect(block).toContain("'error', 'not_found'");
    });

    it(`${fn} derives owner authority from auth.uid()`, () => {
      const block = executable.slice(
        executable.indexOf(`create or replace function public.${fn}(`),
        executable.indexOf(`revoke all on function public.${fn}(`)
      );

      expect(block).toContain("v_caller := auth.uid();");
      expect(block).toMatch(/user_id (=|is distinct from) v_caller|p\.user_id = v_caller/);
      expect(block).not.toContain("p_owner_id");
    });
  }

  it("list_employees never selects pin_hash", () => {
    const block = executable.slice(
      executable.indexOf("create or replace function public.list_employees("),
      executable.indexOf("revoke all on function public.list_employees(")
    );

    expect(block).not.toContain("pin_hash");
  });

  it("prevents duplicate PINs by verifying against salted hashes, not a digest", () => {
    const block = executable.slice(
      executable.indexOf("create or replace function public.employee_project_pin_taken("),
      executable.indexOf("revoke all on function public.employee_project_pin_taken(")
    );

    expect(block).toContain("public.employee_pin_verify(p_pin, v_hash)");

    // No equality lookup against a stored or computed digest: the candidate is
    // verified one salted hash at a time, which is the only way to do this
    // without storing something deterministic.
    for (const shortcut of ["sha256", "md5", "digest(", "pin_hash =", "= p_pin", "where e.pin_hash"]) {
      expect(block).not.toContain(shortcut);
    }
  });

  it("stores no deterministic PIN digest and indexes none", () => {
    const indexes = executable.match(/create (unique )?index[^;]*;/g) ?? [];

    for (const index of indexes) {
      expect(index).not.toContain("pin");
    }
  });

  it("caps the active roster so the login scan stays bounded", () => {
    const caps = executable.match(/if v_active_count >= 50 then/g) ?? [];

    // create_employee and set_employee_active(true) — reactivating must not be
    // a way around the ceiling.
    expect(caps.length).toBe(2);
  });

  it("documents the ceiling as provisional, never as a supported limit", () => {
    // The control-room ruling: 50 is a staging/engineering safety value pending
    // benchmark validation. This test is what stops the number acquiring the
    // status of a product promise by being quietly re-described later.
    expect(sql).toContain("PROVISIONAL ENGINEERING SAFETY VALUE");
    expect(sql).toContain("NOT the permanent");
    expect(sql).toContain("NOT a supported-roster promise");
    expect(sql).toContain("NOT a documented POS");
    expect(sql).toContain("NOT a product or marketing constraint");
    expect(sql).toContain("pending benchmark validation");
  });

  it("never presents the ceiling as a capability anywhere in the feature", () => {
    // Prose is included deliberately here: the risk is a COMMENT that reads as
    // a promise, not executable SQL.
    for (const claim of [
      "supports up to 50",
      "maximum of 50 employees",
      "limit of 50 employees per",
      "50 employees per project is the",
    ]) {
      expect(sql).not.toContain(claim);
    }
  });
});

// ---------------------------------------------------------------------------
// Inertness — the released v1.2.0 contract
// ---------------------------------------------------------------------------

describe("the v1.2.0 contract is untouched", () => {
  it("redefines no existing function", () => {
    const created = [...executable.matchAll(/create or replace function (?:public\.)?(\w+)\(/g)].map(
      (m) => m[1]
    );

    expect(new Set(created)).toEqual(
      new Set([...PUBLIC_FUNCTIONS, ...PRIVATE_FUNCTIONS])
    );
  });

  it("names no sale, checkout or inventory function", () => {
    for (const forbidden of [
      "complete_sale",
      "resolve_sale_owner",
      "restock_inventory",
      "adjust_inventory",
      "get_device_config",
      "get_device_pairing_state",
      "redeem_device_pairing_token",
      "revoke_paired_device",
      "unpair_own_device",
      "apply_device_config_update",
      "offer_device_config_update",
      "get_device_recent_orders",
    ]) {
      expect(executable).not.toContain(forbidden);
    }
  });

  it("alters no existing table and drops nothing", () => {
    const alters = executable.match(/alter table public\.(\w+)/g) ?? [];

    for (const alter of alters) {
      // Only the three new tables, and only to enable RLS.
      expect(NEW_TABLES.some((t) => alter.endsWith(t))).toBe(true);
    }

    expect(executable).not.toMatch(/\bdrop (table|function|policy|trigger|index|column)\b/i);
    expect(executable).not.toMatch(/alter table[^;]*(add|drop) column/i);
  });

  it("touches no paired_devices policy, grant or trigger", () => {
    expect(executable).not.toContain("create policy");
    expect(executable).not.toMatch(/grant[^;]*on table public\.paired_devices/);
    expect(executable).not.toMatch(/revoke[^;]*on table public\.paired_devices/);
    expect(executable).not.toContain("paired_devices_guard_immutable_columns");
  });

  it("proves inertness at apply time rather than asserting it", () => {
    expect(executable).toContain("F1A: paired_devices rows changed");
    expect(executable).toContain("F1A: pre-existing function % changed body");
    expect(executable).toContain("F1A: pre-existing function % changed EXECUTE grants");
    expect(executable).toContain("F1A: an existing policy definition changed");
    expect(executable).toContain("F1A: pre-existing trigger %.% changed or was removed");
  });

  it("captures its baselines before any DDL runs", () => {
    const firstBaseline = executable.indexOf("create temporary table f1a_paired_devices_baseline");
    const firstDdl = executable.indexOf("create table if not exists public.employees");

    expect(firstBaseline).toBeGreaterThan(-1);
    expect(firstBaseline).toBeLessThan(firstDdl);
  });
});
