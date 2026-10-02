// Cash Drawer Checkpoint 1D — the owner's per-register drawer setting, as a
// model.
//
// WHAT THIS FILE PROVES. That the authoritative database value reaches the
// owner summary unchanged and fails OFF; that only an active Windows register
// is configurable; and that the four presentation states are kept apart so the
// screen can give the true reason a switch is absent.
//
// lib/cashDrawerOwnerConfig.guards.test.ts proves the structural half — where
// the value is read from, that no component reaches past the server actions,
// and that the UI commits nothing optimistically.
//
// NOT RE-TESTED HERE. Whether the setter RPC authorizes correctly is the
// database's, proven by
// supabase/migrations/20261002120000_device_cash_drawer_enablement.db.test.ts.
// Restating it would make a second, weaker copy of the rule.
import { describe, expect, it } from "vitest";
import {
  CASH_DRAWER_PROPAGATION_NOTE,
  CASH_DRAWER_STALE_MESSAGE,
  CASH_DRAWER_UPDATE_FAILED_MESSAGE,
  canConfigureCashDrawer,
  mapPairedDeviceRow,
  resolveCashDrawerConfigState,
} from "@/lib/devices";
import type { PairedDeviceRow, PairedDeviceSummary } from "@/lib/devices";

function row(overrides: Partial<PairedDeviceRow> = {}): PairedDeviceRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    project_id: "22222222-2222-4222-8222-222222222222",
    build_job_id: "33333333-3333-4333-8333-333333333333",
    device_name: "Front Till",
    platform: "windows",
    created_at: "2026-10-01T12:00:00.000Z",
    last_seen_at: null,
    unpaired_at: null,
    revoked_at: null,
    offered_build_job_id: null,
    offered_at: null,
    cash_drawer_enabled: false,
    ...overrides,
  };
}

function device(overrides: Partial<PairedDeviceRow> = {}): PairedDeviceSummary {
  const mapped = mapPairedDeviceRow(row(overrides));

  if (mapped === null) throw new Error("fixture row should map");

  return mapped;
}

// ---------------------------------------------------------------------------
// The database value, carried unchanged
// ---------------------------------------------------------------------------

describe("the authoritative setting reaches the owner summary", () => {
  it("false in the database is false on the owner model", () => {
    expect(device({ cash_drawer_enabled: false }).cashDrawerEnabled).toBe(false);
  });

  it("true in the database is true on the owner model", () => {
    expect(device({ cash_drawer_enabled: true }).cashDrawerEnabled).toBe(true);
  });

  it("is a real boolean, never a truthy value passed along", () => {
    expect(typeof device({ cash_drawer_enabled: true }).cashDrawerEnabled).toBe("boolean");
    expect(typeof device({ cash_drawer_enabled: false }).cashDrawerEnabled).toBe("boolean");
  });

  it("fails OFF for anything that is not literally true", () => {
    // The column is NOT NULL DEFAULT false, so none of these should occur —
    // and if one ever did, automatic opening must not be what we switch on.
    expect(device({ cash_drawer_enabled: null }).cashDrawerEnabled).toBe(false);
    expect(device({ cash_drawer_enabled: undefined }).cashDrawerEnabled).toBe(false);

    const withoutColumn = row();

    delete withoutColumn.cash_drawer_enabled;

    expect(mapPairedDeviceRow(withoutColumn)?.cashDrawerEnabled).toBe(false);
  });

  it("is off for a register nobody has configured", () => {
    // The product default and the column default are the same answer.
    expect(device().cashDrawerEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Which registers may be configured
// ---------------------------------------------------------------------------

describe("only an active Windows register is configurable", () => {
  it("an active Windows register is", () => {
    expect(canConfigureCashDrawer(device({ platform: "windows" }))).toBe(true);
    expect(resolveCashDrawerConfigState(device({ platform: "windows" }))).toBe(
      "configurable"
    );
  });

  it("an active Android register is not", () => {
    const android = device({ platform: "android" });

    expect(canConfigureCashDrawer(android)).toBe(false);
    expect(resolveCashDrawerConfigState(android)).toBe("unsupported_platform");
  });

  it("a web or unknown platform is not", () => {
    for (const platform of ["web", "ios", "linux", "WINDOWS PHONE", null, "", "   "]) {
      expect(`platform ${JSON.stringify(platform)}`).toBe(
        `platform ${JSON.stringify(platform)}`
      );
      expect(canConfigureCashDrawer(device({ platform }))).toBe(false);
    }
  });

  it("a revoked Windows register is not, and says why", () => {
    const revoked = device({ revoked_at: "2026-10-01T13:00:00.000Z" });

    expect(revoked.status).toBe("revoked");
    expect(canConfigureCashDrawer(revoked)).toBe(false);
    expect(resolveCashDrawerConfigState(revoked)).toBe("revoked");
  });

  it("an unpaired register renders no drawer block at all", () => {
    // Feature 25.1 is emphatic that revoked and unpaired are different events.
    // Telling an owner their till was cut off when it removed itself would be
    // false, so the honest option is to say nothing.
    const unpaired = device({ unpaired_at: "2026-10-01T13:00:00.000Z" });

    expect(unpaired.status).toBe("unpaired");
    expect(canConfigureCashDrawer(unpaired)).toBe(false);
    expect(resolveCashDrawerConfigState(unpaired)).toBe("none");
  });

  it("reads the platform the device reported, whatever its casing", () => {
    for (const platform of ["windows", "Windows", "WINDOWS", " windows "]) {
      expect(`platform ${platform}`).toBe(`platform ${platform}`);
      expect(canConfigureCashDrawer(device({ platform }))).toBe(true);
    }
  });

  it("stays configurable regardless of the stored value", () => {
    // Whether the owner may CHANGE the setting is a different question from
    // what the setting currently is.
    expect(canConfigureCashDrawer(device({ cash_drawer_enabled: true }))).toBe(true);
    expect(canConfigureCashDrawer(device({ cash_drawer_enabled: false }))).toBe(true);
  });

  it("a revoked register's stored value is not operational state", () => {
    // It may still be true in the column — revoking does not clear it — and
    // the screen must not present that as something still in force.
    const revoked = device({
      revoked_at: "2026-10-01T13:00:00.000Z",
      cash_drawer_enabled: true,
    });

    expect(revoked.cashDrawerEnabled).toBe(true);
    expect(resolveCashDrawerConfigState(revoked)).toBe("revoked");
    expect(canConfigureCashDrawer(revoked)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The four states are four different sentences
// ---------------------------------------------------------------------------

describe("the reason a switch is absent", () => {
  it("distinguishes a platform fact from a pairing fact", () => {
    const android = resolveCashDrawerConfigState(device({ platform: "android" }));
    const revoked = resolveCashDrawerConfigState(
      device({ revoked_at: "2026-10-01T13:00:00.000Z" })
    );

    expect(android).not.toBe(revoked);
    expect(android).toBe("unsupported_platform");
    expect(revoked).toBe("revoked");
  });

  it("has exactly one state with a control", () => {
    const states = [
      resolveCashDrawerConfigState(device({ platform: "windows" })),
      resolveCashDrawerConfigState(device({ platform: "android" })),
      resolveCashDrawerConfigState(device({ revoked_at: "2026-10-01T13:00:00.000Z" })),
      resolveCashDrawerConfigState(device({ unpaired_at: "2026-10-01T13:00:00.000Z" })),
    ];

    expect(states.filter((s) => s === "configurable")).toHaveLength(1);
    expect(new Set(states).size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// What the owner is told
// ---------------------------------------------------------------------------

describe("the owner-facing copy", () => {
  it("says a failed change changed nothing", () => {
    expect(CASH_DRAWER_UPDATE_FAILED_MESSAGE).toBe(
      "Cash drawer setting could not be updated. Nothing changed. Refresh and try again."
    );
  });

  it("admits when a saved change could not be read back", () => {
    expect(CASH_DRAWER_STALE_MESSAGE).toMatch(/could not be reloaded/i);
    expect(CASH_DRAWER_STALE_MESSAGE).toMatch(/out of date/i);
    expect(CASH_DRAWER_STALE_MESSAGE).toMatch(/Refresh/);
  });

  it("describes propagation as a pull, never a push", () => {
    expect(CASH_DRAWER_PROPAGATION_NOTE).toBe(
      "Changes take effect the next time this register refreshes its device settings. If it is offline, it may keep its last saved setting until it reconnects or its offline authorization expires."
    );
  });

  it("promises no synchronisation this product does not have", () => {
    const copy = [
      CASH_DRAWER_PROPAGATION_NOTE,
      CASH_DRAWER_STALE_MESSAGE,
      CASH_DRAWER_UPDATE_FAILED_MESSAGE,
    ].join(" ");

    for (const forbidden of [
      "immediately",
      "instantly",
      "instant",
      "live",
      "real time",
      "realtime",
      "push",
      "right away",
      "straight away",
      "every sale",
    ]) {
      expect(`copy: ${forbidden}`).toBe(`copy: ${forbidden}`);
      expect(copy.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("tells the owner what an offline register will do", () => {
    expect(CASH_DRAWER_PROPAGATION_NOTE).toMatch(/offline/i);
    expect(CASH_DRAWER_PROPAGATION_NOTE).toMatch(/last saved setting/i);
    expect(CASH_DRAWER_PROPAGATION_NOTE).toMatch(/offline authorization expires/i);
  });
});
