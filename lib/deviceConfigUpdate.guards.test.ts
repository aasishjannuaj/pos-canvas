// Feature 26.1 — structural guards for the config-update offer contract.
//
// WHAT THESE CAN AND CANNOT PROVE. vitest runs in the node environment with no
// database, so these read the migration SQL and assert the properties a reviewer
// would check by eye — the predicates, the parameter shapes, the grants, the
// things deliberately NOT done. Behaviour (a cross-project offer actually being
// refused, an apply actually moving the pin) is proved by the staging plan, not
// here. The split is the same one every device migration in this repo has used.
//
// THE PROPERTY THAT MATTERS MOST. paired_devices.build_job_id is the pricing
// authority: all four complete_sale* functions price a device sale from that
// build's config_snapshot. So "who may move it, and when" is a money question,
// and these guards exist to keep the answer from drifting.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf-8");

const MIGRATION = "supabase/migrations/20260831120000_device_config_update_offer.sql";

/** The migration with every function body removed — the statements that run. */
function statements(): string {
  return read(MIGRATION).replace(/(\$function\$)[\s\S]*?\1/g, "\n<<BODY>>\n");
}

/** One function's body, by name. */
function body(name: string): string {
  const s = read(MIGRATION);
  const i = s.indexOf(`function public.${name}(`);

  expect(i, `${name} not found in the migration`).toBeGreaterThan(-1);

  const open = s.indexOf("$function$", i);
  return s.slice(open, s.indexOf("$function$", open + 10));
}

describe("the migration is additive and destroys nothing", () => {
  it("contains no DML, DROP or TRUNCATE at the top level", () => {
    const lines = statements()
      .split("\n")
      .map((l) => l.trim().toLowerCase())
      .filter((l) => /^(insert|update|delete|truncate|drop)\b/.test(l));

    expect(lines).toEqual([]);
  });

  it("adds columns nullable, with no default and no backfill", () => {
    const s = statements();

    expect(s).toContain("add column if not exists offered_build_job_id uuid");
    expect(s).toContain("add column if not exists offered_at timestamptz");
    expect(s).toContain("add column if not exists build_job_id uuid");
    // A default or a backfill would invent history that was never recorded.
    expect(s).not.toMatch(/add column[^;]*default/i);
    expect(s).not.toMatch(/update public\.orders/i);
  });

  it("never lets a deleted build delete an order or a device", () => {
    const s = statements();
    const refs = s.match(/references public\.build_jobs\(id\)[^,;]*/g) ?? [];

    // Two new FKs: paired_devices.offered_build_job_id and orders.build_job_id.
    // paired_devices.build_job_id already existed and is not re-declared here.
    expect(refs.length).toBe(2);
    // Neither may cascade. paired_devices.build_job_id already does, and
    // extending that to a financial record would let a build deletion destroy
    // orders.
    for (const ref of refs) {
      expect(`${ref} does not cascade`).toBe(`${ref} does not cascade`);
      expect(ref).not.toContain("cascade");
    }
  });

  it("an offer evaporates when its build goes; the audit trail does not", () => {
    const s = statements();
    const offer = s.slice(s.indexOf("offered_build_job_id uuid"));

    // An offer is advisory, so losing it is the right outcome.
    expect(offer.slice(0, 120)).toContain("on delete set null");
  });

  it("a build that priced a sale cannot be deleted out from under it", () => {
    // THE FINANCIAL-INTEGRITY GUARD. SET NULL here would make a null ambiguous
    // all over again — "no build priced this" or "one did and it was deleted" —
    // which is exactly the ambiguity this column exists to remove.
    const s = statements();
    const orders = s.slice(s.indexOf("alter table public.orders"));

    expect(orders.slice(0, 200)).toContain("on delete no action");
    expect(orders.slice(0, 200)).not.toContain("on delete set null");
  });

  it("uses NO ACTION rather than RESTRICT, so an account cascade still works", () => {
    // Both refuse a dangling reference; they differ in WHEN. RESTRICT is
    // immediate and would fire even while the referencing orders are being
    // deleted in the same statement — which is what an auth.users deletion
    // does, cascading to orders (user_id) and build_jobs (owner_id) at once,
    // in an order Postgres does not define.
    const s = statements();
    const orders = s.slice(s.indexOf("alter table public.orders"));

    expect(orders.slice(0, 200)).not.toContain("on delete restrict");
  });

  it("indexes the new orders FK, because orders grows without bound", () => {
    expect(statements()).toContain("create index if not exists orders_build_job_idx");
    expect(statements()).toContain("where build_job_id is not null");
  });
});

describe("offer — the owner half", () => {
  const fn = () => body("offer_device_config_update");

  it("takes a device and a build, and derives the owner from the JWT", () => {
    const s = statements();

    expect(s).toContain("function public.offer_device_config_update(\n  p_device_id uuid,\n  p_build_job_id uuid\n)");
    expect(fn()).toContain("v_caller := auth.uid()");
    // No owner or project may be supplied by the caller.
    expect(fn()).not.toContain("p_owner_id");
    expect(fn()).not.toContain("p_project_id");
  });

  it("scopes the device to the caller in the WHERE clause", () => {
    // Not in a later branch: another owner's device must simply not match, so
    // it is indistinguishable from one that does not exist.
    expect(fn()).toContain("and d.owner_id = v_caller");
    expect(fn()).toContain("'Device not found or access denied'");
  });

  it("refuses an inactive device", () => {
    expect(fn()).toContain("v_device.revoked_at is not null or v_device.unpaired_at is not null");
  });

  it("refuses a build from another project or another owner", () => {
    const b = fn();

    expect(b).toContain("and b.owner_id = v_caller");
    // Compared against the DEVICE's project, never against caller input.
    expect(b).toContain("v_job.project_id is distinct from v_device.project_id");
  });

  it("refuses a build that is not succeeded", () => {
    expect(fn()).toContain("v_job.status <> 'succeeded'");
  });

  it("is idempotent for the same build, and does not move offered_at", () => {
    const b = fn();
    const branch = b.slice(b.indexOf("v_device.offered_build_job_id = p_build_job_id"));

    expect(branch).toContain("'already_offered', true");
    // The early return happens before any update, so offered_at is untouched.
    expect(branch.indexOf("return")).toBeLessThan(branch.indexOf("update public.paired_devices"));
  });

  it("NEVER touches build_job_id — an offer prices nothing", () => {
    // THE NEGATIVE CONTROL for this half. An offer that moved the pin would
    // reprice a till with nobody at the till agreeing to it.
    const update = fn().slice(fn().indexOf("update public.paired_devices"));

    expect(update).toContain("set offered_build_job_id = p_build_job_id");
    expect(update).not.toMatch(/set[^;]*\bbuild_job_id\s*=\s*p_build_job_id/);
    expect(update).not.toMatch(/^\s*build_job_id\s*=/m);
  });
});

describe("apply — the device half", () => {
  const fn = () => body("apply_device_config_update");

  it("takes NO parameters, so a device can only ever act on itself", () => {
    // The same shape unpair_own_device uses: "may only affect its own row" is a
    // property of the signature, not of a check that could be edited away.
    //
    // ANCHORED ON THE CREATE LINE. Matching "apply_device_config_update()"
    // anywhere passed even with a p_device_id added, because the revoke/grant
    // lines carry the zero-arg signature too — the assertion agreed with the
    // grants instead of the definition. A negative control caught it.
    const create = statements().match(
      /create or replace function public\.apply_device_config_update\([^)]*\)/
    );

    expect(create, "apply_device_config_update definition not found").not.toBeNull();
    expect(create![0]).toBe("create or replace function public.apply_device_config_update()");

    expect(fn()).not.toContain("p_device_id");
    expect(fn()).not.toContain("p_project_id");
    expect(fn()).not.toContain("p_build_job_id");
  });

  it("resolves the device from auth.uid() and requires it to be active", () => {
    const b = fn();

    expect(b).toContain("v_caller := auth.uid()");
    expect(b).toContain("where d.auth_user_id = v_caller");
    expect(b).toContain("and d.revoked_at is null");
    expect(b).toContain("and d.unpaired_at is null");
  });

  it("locks the row so a concurrent offer cannot change what is applied", () => {
    expect(fn()).toContain("for update");
  });

  it("answers truthfully when there is nothing to apply", () => {
    expect(fn()).toContain("'no_update_offered'");
  });

  it("re-validates the offered build at apply time, not offer time", () => {
    const b = fn();
    const check = b.slice(b.indexOf("select b.id, b.project_id, b.status into v_job"));

    expect(check).toContain("v_job.project_id is distinct from v_device.project_id");
    expect(check).toContain("v_job.status <> 'succeeded'");
    expect(check).toContain("'offer_unusable'");
  });

  it("moves the pin and clears the offer in ONE statement", () => {
    // Two statements would leave an instant where the device is repinned but
    // still advertising an outstanding offer, or vice versa.
    const update = fn().slice(fn().indexOf("update public.paired_devices"));
    const stmt = update.slice(0, update.indexOf(";"));

    expect(stmt).toContain("set build_job_id = offered_build_job_id");
    expect(stmt).toContain("offered_build_job_id = null");
    expect(stmt).toContain("offered_at = null");
  });

  it("returns what the client needs to refresh its config", () => {
    const b = fn();

    expect(b).toContain("'build_job_id', v_device.build_job_id");
    expect(b).toContain("'previous_build_job_id', v_previous");
    // Captured before the update, or the RETURNING would have overwritten it.
    expect(b.indexOf("v_previous := v_device.build_job_id")).toBeLessThan(
      b.indexOf("update public.paired_devices")
    );
  });

  it("cannot see a cart or an unsynced queue, and the migration says so", () => {
    // The honest limit of this contract. paired_devices carries no queue or
    // sync column and the server has by definition never seen an unsynced
    // sale, so the gate MUST be client-side in 26.2.
    const s = read(MIGRATION);

    expect(s).toContain("MUST NOT be exposed in any UI until");
    expect(s).toContain("Feature 26.2");
    expect(fn()).not.toContain("cart");
    expect(fn()).not.toContain("unsynced");
  });
});

describe("the sale audit trail covers every order-creating path", () => {
  const SALE_FNS = ["complete_sale", "complete_sale_v2", "complete_sale_v3", "complete_sale_v4"];

  it("all four sale functions are replaced, not just v4", () => {
    // THE NEGATIVE CONTROL. Filling the column on one path only makes a null
    // ambiguous: "before this feature" or "whichever RPC the client used?".
    const s = read(MIGRATION);

    for (const fn of SALE_FNS) {
      expect(`${fn} is replaced`).toBe(`${fn} is replaced`);
      expect(s).toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`));
    }
  });

  it("each records the build it actually priced from", () => {
    const s = read(MIGRATION);

    for (const fn of SALE_FNS) {
      const b = s.slice(s.indexOf(`FUNCTION public.${fn}(`));
      const insert = b.slice(b.indexOf("insert into public.orders"));
      const stmt = insert.slice(0, insert.indexOf("returning id into v_order_id"));

      expect(`${fn} records build_job_id`).toBe(`${fn} records build_job_id`);
      expect(stmt).toContain("build_job_id");
      expect(stmt).toContain("v_build_job_id");
    }
  });

  it("the recorded build is the one that priced the sale, from the device row", () => {
    const s = read(MIGRATION);

    for (const fn of SALE_FNS) {
      const b = s.slice(s.indexOf(`FUNCTION public.${fn}(`));
      const insert = b.indexOf("insert into public.orders");

      // v_build_job_id is read from paired_devices before the insert, and the
      // same variable selects the config_snapshot that priced the sale.
      expect(`${fn} sources the build from the device`).toBe(
        `${fn} sources the build from the device`
      );
      expect(b.slice(0, insert)).toContain("paired_devices");
      expect(b.slice(0, insert)).toContain("config_snapshot");
    }
  });

  it("replay still returns the stored order without rewriting anything", () => {
    const s = read(MIGRATION);

    for (const fn of ["complete_sale_v2", "complete_sale_v3", "complete_sale_v4"]) {
      const b = s.slice(s.indexOf(`FUNCTION public.${fn}(`));
      const insert = b.indexOf("insert into public.orders");
      const lookup = b.indexOf("sale_request_id");

      // The idempotency lookup precedes the insert, so a replay never reaches
      // it — and nothing anywhere updates build_job_id after the fact.
      expect(`${fn}: replay before insert`).toBe(`${fn}: replay before insert`);
      expect(lookup).toBeLessThan(insert);
    }

    expect(statements()).not.toMatch(/update public\.orders[^;]*build_job_id/i);
  });
});

describe("pairing state advertises the offer, and get_device_config ignores it", () => {
  it("reports update_available for an active device with a different offer", () => {
    const b = body("get_device_pairing_state");

    expect(b).toContain("'update_available'");
    expect(b).toContain("v_device.offered_build_job_id is not null");
    expect(b).toContain("is distinct from v_device.build_job_id");
    expect(b).toContain("v_device.revoked_at is null");
  });

  it("leaks no build or project data beyond the device's own", () => {
    const b = body("get_device_pairing_state");

    expect(b).not.toContain("config_snapshot");
    expect(b).not.toContain("join public.build_jobs");
    expect(b).toContain("'offered_build_job_id', v_device.offered_build_job_id");
  });

  it("never reports an offered_at for an offer that is not there", () => {
    // ON DELETE SET NULL clears offered_build_job_id and nothing else, so a
    // deleted build leaves offered_at behind pointing at an offer that no
    // longer exists. Reading the column raw would report that ghost.
    const b = body("get_device_pairing_state");

    expect(b).toContain("'offered_at', case");
    expect(b).toContain("when v_device.offered_build_job_id is null then null");
    expect(b).not.toContain("'offered_at', v_device.offered_at");
  });

  it("get_device_config is NOT touched, so the pin holds until Apply", () => {
    // THE NEGATIVE CONTROL for the whole feature: a config load that followed
    // the offer would be the silent auto-update this design exists to avoid.
    expect(read(MIGRATION)).not.toContain("function public.get_device_config");
  });
});

describe("an inactive device holds no offer", () => {
  it("unpair clears the offer without touching the pin", () => {
    const b = body("unpair_own_device");

    expect(b).toContain("offered_build_job_id = null");
    expect(b).toContain("offered_at = null");
    expect(b).not.toMatch(/set[^;]*\bbuild_job_id\s*=/);
    // 25.1's own behaviour is unchanged.
    expect(b).toContain("unpaired_at = coalesce(d.unpaired_at, now())");
  });

  it("revoke clears the offer without touching the pin", () => {
    const b = body("revoke_paired_device");

    expect(b).toContain("offered_build_job_id = null");
    expect(b).toContain("offered_at = null");
    expect(b).not.toMatch(/set[^;]*\bbuild_job_id\s*=/);
    // Idempotent revoke still returns early without overwriting the timestamp.
    expect(b).toContain("'already_revoked', true");
  });
});

// Found on staging, not by reading: 20260803270000 installed a BEFORE UPDATE
// trigger that froze paired_devices.build_job_id for life, so the very first
// apply_device_config_update failed with "build_job_id cannot be changed after
// creation". The feature is impossible without relaxing that guard, and the
// only safe relaxation is one that still refuses every move except the offer.
describe("the immutability guard yields exactly one transition, and no more", () => {
  it("replaces the guard, or apply is dead on arrival", () => {
    expect(statements()).toContain(
      "create or replace function public.paired_devices_guard_immutable_columns()"
    );
  });

  it("lets the pin move ONLY onto the build that was offered", () => {
    const b = body("paired_devices_guard_immutable_columns");

    // An unoffered move, a move to some other build, or a move that leaves the
    // offer standing: all three still raise.
    expect(b).toContain("old.offered_build_job_id is null");
    expect(b).toContain("new.build_job_id is distinct from old.offered_build_job_id");
    expect(b).toContain("new.offered_build_job_id is not null");
    expect(b).toContain("new.offered_at is not null");
    expect(b).toContain(
      "'paired_devices.build_job_id can only change by applying an offered config update'"
    );
  });

  it("keeps every other column exactly as frozen as it was", () => {
    const b = body("paired_devices_guard_immutable_columns");

    for (const column of [
      "auth_user_id",
      "owner_id",
      "project_id",
      "device_name",
      "platform",
      "created_at",
      "last_seen_at",
    ]) {
      expect(b).toContain(`new.${column} is distinct from old.${column}`);
      expect(b).toContain(`'paired_devices.${column} cannot be changed after creation'`);
    }
  });

  it("does not drop or re-point the trigger itself", () => {
    const s = statements();

    expect(s).not.toMatch(/drop\s+trigger/i);
    expect(s).not.toMatch(/create\s+(or replace\s+)?trigger/i);
  });
});

describe("security posture", () => {
  it("both new RPCs are SECURITY DEFINER with a pinned search_path", () => {
    const s = statements();

    for (const fn of ["offer_device_config_update", "apply_device_config_update"]) {
      const i = s.indexOf(`function public.${fn}`);
      const decl = s.slice(i, i + 400);

      expect(`${fn} is definer`).toBe(`${fn} is definer`);
      expect(decl).toContain("security definer");
      expect(decl).toContain("set search_path = public, pg_temp");
    }
  });

  it("execute is revoked from public and anon, granted only to authenticated", () => {
    const s = statements();

    for (const sig of [
      "public.offer_device_config_update(uuid, uuid)",
      "public.apply_device_config_update()",
    ]) {
      expect(`${sig} grants`).toBe(`${sig} grants`);
      expect(s).toContain(`revoke all on function ${sig} from public;`);
      expect(s).toContain(`revoke all on function ${sig} from anon;`);
      // service_role must be revoked EXPLICITLY. Supabase's ALTER DEFAULT
      // PRIVILEGES grants execute on every new public function to anon,
      // authenticated and service_role, so omitting this leaves a grant nobody
      // wrote — staging proved it, and get_device_recent_orders already does it.
      expect(s).toContain(`revoke all on function ${sig} from service_role;`);
      expect(s).toContain(`grant execute on function ${sig} to authenticated;`);
      expect(s).not.toContain(`grant execute on function ${sig} to anon`);
      expect(s).not.toContain(`grant execute on function ${sig} to service_role`);
    }
  });

  it("grants no broad table privilege to anyone", () => {
    const s = statements();

    expect(s).not.toMatch(/grant\s+(all|select|insert|update|delete)\s+on\s+(table\s+)?public\./i);
  });
});
