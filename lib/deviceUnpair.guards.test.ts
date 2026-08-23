// Feature 25.1 — device-side unpair from a working till.
//
// The safety machinery was built and hardware-validated in 24.5F; what was
// missing was a way to reach it. A healthy paired till offered Reset on no
// screen at all — it appeared only on `revoked`, `config_unavailable` and
// `reconnect_required`, three states a working device is never in — so moving a
// tablet between businesses meant breaking it first or reinstalling.
//
// These guards exist to keep the entry point from becoming a second, weaker
// reset. There must stay exactly ONE authoritative answer to "may this device be
// reset", and it must stay the one that reads durable storage.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { decideDeviceResetSafety } from "@/lib/offlineSaleStatus";
import type { OfflineSaleStatus } from "@/lib/offlineSaleStatus";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf-8");

/** Source with comments stripped, so prose cannot satisfy an assertion. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const APP = "components/device/DeviceApp.tsx";
const SETTINGS = "components/device/DeviceSettingsScreen.tsx";
const RUNTIME = "components/runtime/PosRuntime.tsx";
const MIGRATION = "supabase/migrations/20260823120000_device_voluntary_unpair.sql";
const V4 = "supabase/migrations/20260819120000_offline_sale_contract_and_complete_sale_v4.sql";

function status(patch: Partial<OfflineSaleStatus> = {}): OfflineSaleStatus {
  return {
    waiting: 0,
    needsAttention: 0,
    synced: 0,
    unsynced: 0,
    total: 0,
    nextRetryAt: null,
    uncertainOnlineSale: false,
    ...patch,
  };
}

describe("a working till can reach its own settings", () => {
  it("the ready POS offers Device settings", () => {
    const ready = code(read(APP)).slice(code(read(APP)).indexOf('case "ready": {'));

    expect(ready).toContain("headerTrailing=");
    expect(ready).toContain("Device settings");
    expect(ready).toContain("setSettingsOpen(true)");
  });

  it("settings replace the POS rather than sitting beside checkout", () => {
    const ready = code(read(APP)).slice(code(read(APP)).indexOf('case "ready": {'));

    // A destructive control next to the pay button is one that eventually gets
    // pressed by accident.
    expect(ready).toContain("if (settingsOpen) {");
    expect(ready).toContain("<DeviceSettingsScreen");
  });

  it("the settings screen offers unpair behind a confirmation", () => {
    const settings = code(read(SETTINGS));

    expect(settings).toContain("UNPAIR_ACTION");
    expect(settings).toContain("UNPAIR_CONFIRM_LINES");
    expect(settings).toContain("UNPAIR_CONFIRM_ACTION");
    // Two steps: the action only arms the confirmation.
    expect(settings).toContain("setConfirming(true)");
    expect(settings).toContain("{confirming && (");
  });

  it("keeping the device paired is the default button", () => {
    const settings = code(read(SETTINGS));
    const confirm = settings.slice(settings.indexOf("{confirming && ("));

    expect(confirm.indexOf("Keep this device paired")).toBeLessThan(
      confirm.indexOf("UNPAIR_CONFIRM_ACTION")
    );
  });

  it("the owner runtime never gets the device affordance", () => {
    const runtime = code(read(RUNTIME));

    // headerTrailing is used ONLY where there is no homeLink, so a till still
    // has no route into the owner app and an owner runtime has no unpair.
    expect(runtime).toContain("headerTrailing ?? undefined");
    expect(runtime).toContain("homeLink !== null ?");
  });
});

describe("there is exactly one reset-safety decision", () => {
  it("the settings screen decides nothing itself", () => {
    const settings = code(read(SETTINGS));

    for (const forbidden of [
      "decideDeviceResetSafety",
      "resetDeviceSession",
      "clearOfflineCache",
      "readOfflineSaleStatus",
      "unsynced",
      "needsAttention",
    ]) {
      expect(settings).not.toContain(forbidden);
    }
  });

  it("voluntary unpair runs the SAME safety decision, then the server", () => {
    const app = code(read(APP));
    const ready = app.slice(app.indexOf('case "ready": {'));

    expect(ready).toContain("onUnpair={() => void handleUnpair()}");

    // 25.1 split the two intents deliberately: handleUnpair confirms with the
    // server before clearing anything, handleReset stays local-only so an
    // emergency screen still works with no network. What must NOT split is the
    // safety decision — both read durable storage and both call the one
    // decision function.
    const unpair = app.slice(app.indexOf("async function handleUnpair()"));
    const reset = app.slice(app.indexOf("async function handleReset()"));

    for (const body of [unpair.slice(0, 2_000), reset.slice(0, 2_000)]) {
      expect(body).toContain("await readOfflineSaleStatus()");
      expect(body).toContain("decideDeviceResetSafety(status)");
    }

    // One implementation of each, not one per screen.
    expect(app.match(/async function handleReset\(\)/g)).toHaveLength(1);
    expect(app.match(/async function handleUnpair\(\)/g)).toHaveLength(1);
  });

  it("the server is told BEFORE anything local is cleared", () => {
    const app = code(read(APP));
    const body = app.slice(app.indexOf("async function handleUnpair()"));
    const decide = body.indexOf("decideDeviceResetSafety(status)");
    const rpc = body.indexOf("await unpairOwnDevice()");
    const clear = body.indexOf("await clearOfflineCache()");
    const signOut = body.indexOf("await resetDeviceSession()");

    // safety -> server -> local. Any other order recreates the ghost Active row
    // this feature exists to remove.
    expect(rpc).toBeGreaterThan(decide);
    expect(clear).toBeGreaterThan(rpc);
    expect(signOut).toBeGreaterThan(clear);
  });

  it("a failed unpair clears nothing at all", () => {
    const app = code(read(APP));
    const body = app.slice(app.indexOf("async function handleUnpair()"));
    const failure = body.slice(body.indexOf("if (!unpaired.ok)"));
    const earlyReturn = failure.indexOf("return;");
    const clear = failure.indexOf("await clearOfflineCache()");

    expect(earlyReturn).toBeGreaterThan(-1);
    expect(clear === -1 || clear > earlyReturn).toBe(true);
  });

  it("the emergency reset stays local-only, so a dead network can still recover", () => {
    const app = code(read(APP));
    const reset = app.slice(app.indexOf("async function handleReset()"), app.length);
    const body = reset.slice(0, 2_000);

    expect(body).not.toContain("unpairOwnDevice");
  });

  it("handleReset still re-reads durable storage before deciding", () => {
    const app = code(read(APP));
    const body = app.slice(app.indexOf("async function handleReset()"));
    const readAt = body.indexOf("await readOfflineSaleStatus()");
    const decideAt = body.indexOf("decideDeviceResetSafety(status)");
    const clearAt = body.indexOf("await clearOfflineCache()");

    expect(readAt).toBeGreaterThan(-1);
    expect(decideAt).toBeGreaterThan(readAt);
    expect(clearAt).toBeGreaterThan(decideAt);
  });

  it("introduces no server revocation call", () => {
    const settings = code(read(SETTINGS));
    const app = code(read(APP));

    // Scoped to a revocation CALL, not the word: the screen legitimately reads
    // pairing.revokedAt to label itself Paired or Revoked, and a blanket ban on
    // the substring would forbid displaying the device's own state.
    expect(settings).not.toContain("revoke_paired_device");
    expect(settings).not.toContain("revokeDevice");
    expect(settings).not.toContain(".rpc(");
    // DeviceApp gained no new revoke path either — revocation stays the owner's
    // action against paired_devices, untouched by this feature.
    expect(app).not.toContain("revoke_paired_device");
  });

  it("the pre-existing reset entry points survive", () => {
    const app = code(read(APP));

    // revoked, config_unavailable and reconnect_required all still offer it.
    expect(app.match(/onReset=\{handleReset\}/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});

describe("what blocks an unpair", () => {
  it("allows it only when nothing is outstanding", () => {
    expect(decideDeviceResetSafety(status()).allowed).toBe(true);
  });

  it("a sale still waiting to sync blocks it", () => {
    expect(decideDeviceResetSafety(status({ waiting: 1, unsynced: 1 })).allowed).toBe(false);
  });

  it("a sale needing attention blocks it", () => {
    expect(
      decideDeviceResetSafety(status({ needsAttention: 1, unsynced: 1 })).allowed
    ).toBe(false);
  });

  it("an unresolved online sale blocks it even with an empty queue", () => {
    const safety = decideDeviceResetSafety(status({ uncertainOnlineSale: true }));

    expect(safety.allowed).toBe(false);

    if (!safety.allowed) {
      expect(safety.message).toContain("may already have gone through");
    }
  });

  it("names the count so nobody discards sales they cannot see", () => {
    const safety = decideDeviceResetSafety(status({ waiting: 3, unsynced: 3 }));

    expect(safety.allowed).toBe(false);

    if (!safety.allowed) {
      expect(safety.message).toContain("3 sales");
      expect(safety.unsynced).toBe(3);
    }
  });

  it("a refused unpair clears nothing and leaves the screen where it was", () => {
    const app = code(read(APP));
    const body = app.slice(app.indexOf("async function handleReset()"));
    const refusal = body.slice(body.indexOf("if (!safety.allowed)"));
    const earlyReturn = refusal.indexOf("return;");
    const clear = refusal.indexOf("await clearOfflineCache()");

    // The refusal returns before anything is cleared…
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(clear === -1 || clear > earlyReturn).toBe(true);
    // …and setSettingsOpen(false) sits AFTER the guard, so a blocked unpair
    // leaves settings open with its notice on display.
    expect(body.indexOf("setSettingsOpen(false)")).toBeGreaterThan(
      body.indexOf("decideDeviceResetSafety(status)")
    );
  });
});

describe("the migration is additive and cannot revoke", () => {
  it("adds unpaired_at as a nullable column with no backfill", () => {
    const sql = read(MIGRATION);

    expect(sql).toContain("add column if not exists unpaired_at timestamptz");
    // No default and no backfill: existing rows are not retroactively unpaired.
    expect(sql).not.toContain("unpaired_at timestamptz not null");
    expect(sql).not.toMatch(/update\s+public\.paired_devices\s+set\s+unpaired_at/i);
  });

  it("lets a device name only ITSELF", () => {
    const sql = read(MIGRATION);
    const fn = sql.slice(sql.indexOf("create or replace function public.unpair_own_device"));

    // No parameter exists to pass another device's id, so "own row only" is a
    // property of the signature rather than of a check that could be edited out.
    expect(sql).toContain("create or replace function public.unpair_own_device()");
    expect(fn).toContain("where d.auth_user_id = v_caller");
    expect(fn).not.toContain("owner_id = v_caller");
  });

  it("is idempotent", () => {
    const fn = read(MIGRATION);

    // coalesce keeps the FIRST instant, so a retry after a lost answer reports
    // success without moving the timestamp.
    expect(fn).toContain("set unpaired_at = coalesce(d.unpaired_at, now())");
  });

  it("never writes revoked_at or revoked_by", () => {
    const sql = read(MIGRATION);
    const fn = sql.slice(
      sql.indexOf("create or replace function public.unpair_own_device"),
      sql.indexOf("revoke all on function public.unpair_own_device")
    );

    expect(fn).not.toContain("revoked_at =");
    expect(fn).not.toContain("revoked_by");
  });

  it("cannot change owner, project or build identity", () => {
    const sql = read(MIGRATION);
    const fn = sql.slice(
      sql.indexOf("create or replace function public.unpair_own_device"),
      sql.indexOf("revoke all on function public.unpair_own_device")
    );

    // Scoped to the SET clause. `auth_user_id = v_caller` appears in the WHERE
    // predicate as the row selector — a read, not a write — so a whole-function
    // substring check would forbid the very lookup that makes this safe.
    const setClause = fn.slice(fn.indexOf("set unpaired_at"), fn.indexOf("where d.auth_user_id"));

    expect(setClause).toContain("unpaired_at");

    for (const frozen of ["owner_id", "project_id", "build_job_id", "auth_user_id", "revoked"]) {
      expect(setClause).not.toContain(frozen);
    }
  });

  it("is granted to authenticated only", () => {
    const sql = read(MIGRATION);

    expect(sql).toContain("revoke all on function public.unpair_own_device() from anon;");
    expect(sql).toContain("revoke all on function public.unpair_own_device() from service_role;");
    expect(sql).toContain("grant execute on function public.unpair_own_device() to authenticated;");
  });

  it("teaches startup about it so a crash cannot reopen the POS", () => {
    const sql = read(MIGRATION);

    // unpair committed, app died before the local reset: the next start must not
    // report this pairing as active.
    expect(sql).toContain("if v_device.unpaired_at is not null then");
    expect(sql).toContain("'reason', 'unpaired'");
    // …and the revocation answer is still derived from revoked_at alone.
    expect(sql).toContain("'active', (v_device.revoked_at is null)");
  });

  it("leaves the REVOCATION contract alone while applying the pairing rule", () => {
    // NARROWED BY THE APPROVED 25.1 LIFECYCLE WORK. The migration now does
    // redefine complete_sale_v3 and v4 — deliberately, to apply
    // "active = not revoked AND not unpaired" — so asserting it touches neither
    // would only be satisfiable by leaving the gap open.
    //
    // The property that survives is the one that matters: the revocation window
    // is unchanged, and unpaired_at never becomes a second temporal contract.
    // lib/deviceLifecycleContract.guards.test.ts carries the detailed ordering
    // and no-comparison guards; this is the coarse boundary check.
    const sql = read(MIGRATION);

    expect(sql).toContain("if v_occurred_at >= v_device_revoked_at then");
    expect(sql).not.toMatch(/occurred_at\s*[<>=]+\s*v_device_unpaired_at/);

    // The 24.5B migration itself is untouched by this feature.
    const v4 = read(V4);

    expect(v4).toContain("if v_occurred_at >= v_device_revoked_at then");
    expect(v4).not.toContain("unpaired_at");
  });
});

describe("the client clears a stale session after a server-side unpair", () => {
  it("keys on the server's reason, not on the screen", () => {
    const app = code(read(APP));

    // `not_paired` reaches the same screen and must NOT clear a session that was
    // never associated with a pairing.
    expect(app).toContain('pairingState.state.reason === "unpaired"');
    expect(app).toContain("await resetDeviceSession();");
  });

  it("routes an unpaired device to the pairing screen", () => {
    const session = code(read("lib/deviceSession.ts"));

    expect(session).toContain('result.reason === "not_paired" || result.reason === "unpaired"');
    expect(session).toContain('return { status: "unpaired", notice: null };');
  });
});

describe("no completed sale can be deleted", () => {
  it("this feature introduces no order deletion anywhere", () => {
    for (const file of [APP, SETTINGS, "lib/devices.ts", "lib/device.rpc.ts"]) {
      const source = code(read(file));

      expect(source).not.toContain("delete from public.orders");
      expect(source).not.toContain("deleteOrder");
      expect(source).not.toContain("deleteCompletedSale");
    }

    expect(read(MIGRATION)).not.toContain("delete from public.orders");
  });
});
