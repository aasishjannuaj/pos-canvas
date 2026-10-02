// v1.3 Cash Drawer Checkpoint 1B — the owner's per-device setting on its way
// from get_device_pairing_state to the till: the parser, the cached pairing
// assertion, and the offline fallback that rebuilds a pairing from it.
//
// FAIL CLOSED AT EVERY STEP. Only a literal `true` from the server, and only a
// literal `true` in the cache, may produce true; everything else is false. The
// cache field was added WITHOUT a schema-version bump, so a v1 record written
// before it existed must read false and must still open offline.
//
// The database half (who may set it, and what the server reports) is executed
// against PostgreSQL in
// supabase/migrations/20261002120000_device_cash_drawer_enablement.db.test.ts.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { decideOfflineFallback, parsePairingState } from "@/lib/deviceSession";
import type { DevicePairing } from "@/lib/deviceSession";
import {
  OFFLINE_CACHE_SCHEMA_VERSION,
  OFFLINE_DEVICE_LEASE_MS,
  buildPairingAssertion,
  buildPinnedConfigRecord,
  readPairingAssertion,
} from "@/lib/deviceOfflineCache";
import { loadOfflineFallback, persistDeviceCache } from "@/lib/deviceOfflineSession";
import { createGeneratedPosConfig } from "@/lib/generatedPosConfig";
import { defaultProjectConfig } from "@/lib/projectConfig";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const DEVICE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BUILD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const VERIFIED = "2026-10-02T11:00:00.000Z";

const config = createGeneratedPosConfig(
  { projectId: PROJECT, projectName: "Shop", templateId: "restaurant", config: defaultProjectConfig },
  { generatedAt: "2026-10-02T09:00:00.000Z" }
);

/** Everything the accepted get_device_pairing_state returns for a live device. */
function serverPairing(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paired: true,
    device_id: DEVICE,
    project_id: PROJECT,
    build_job_id: BUILD,
    device_name: "Till",
    platform: "windows",
    created_at: "2026-08-01T09:00:00Z",
    revoked_at: null,
    active: true,
    update_available: false,
    offered_build_job_id: null,
    offered_at: null,
    ...extra,
  };
}

function parsedFlag(value: unknown): boolean {
  const result = parsePairingState(serverPairing({ cash_drawer_enabled: value }));

  if (!result.paired) throw new Error("expected a paired result");

  return result.pairing.cashDrawerEnabled;
}

function assertion(cashDrawerEnabled: boolean, verifiedAt = VERIFIED) {
  return buildPairingAssertion({
    deviceAuthUserId: USER,
    deviceId: DEVICE,
    projectId: PROJECT,
    buildJobId: BUILD,
    deviceName: "Till",
    platform: "windows",
    cashDrawerEnabled,
    verifiedAt,
  });
}

async function configRecord() {
  const record = await buildPinnedConfigRecord({
    deviceAuthUserId: USER,
    projectId: PROJECT,
    buildJobId: BUILD,
    config,
    verifiedAt: VERIFIED,
  });

  if (record === null) throw new Error("no digest");

  return record;
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

describe("parsePairingState reads cash_drawer_enabled as a literal true only", () => {
  it("true is true", () => {
    expect(parsedFlag(true)).toBe(true);
  });

  it("false, missing and null are false", () => {
    expect(parsedFlag(false)).toBe(false);
    expect(parsedFlag(null)).toBe(false);

    const missing = parsePairingState(serverPairing());
    expect(missing.paired === true && missing.pairing.cashDrawerEnabled).toBe(false);
  });

  it("strings, numbers, objects and arrays are false — no truthiness", () => {
    for (const value of ["true", "1", "yes", 1, -1, {}, { value: true }, [true], Number.NaN]) {
      expect(`${JSON.stringify(value)}: ${parsedFlag(value)}`).toBe(`${JSON.stringify(value)}: false`);
    }
  });

  it("a revoked device is false even if the payload says true", () => {
    const result = parsePairingState(
      serverPairing({ revoked_at: "2026-09-01T09:00:00Z", active: false, cash_drawer_enabled: true })
    );

    expect(result.paired === true && result.pairing.cashDrawerEnabled).toBe(false);
  });

  it("an unpaired or unreadable answer yields no pairing at all", () => {
    expect(parsePairingState({ paired: false, reason: "unpaired", cash_drawer_enabled: true }).paired).toBe(false);
    expect(parsePairingState({ cash_drawer_enabled: true }).paired).toBe(false);
  });

  it("every accepted field still parses exactly as before", () => {
    const result = parsePairingState(serverPairing({ cash_drawer_enabled: true }));

    expect(result.paired === true && result.pairing).toEqual({
      deviceId: DEVICE,
      projectId: PROJECT,
      buildJobId: BUILD,
      deviceName: "Till",
      platform: "windows",
      createdAt: "2026-08-01T09:00:00Z",
      revokedAt: null,
      cashDrawerEnabled: true,
    } satisfies DevicePairing);
  });
});

// ---------------------------------------------------------------------------
// The cached pairing assertion
// ---------------------------------------------------------------------------

describe("the cached pairing assertion carries it without a schema-version bump", () => {
  it("the schema version is still 1", () => {
    expect(OFFLINE_CACHE_SCHEMA_VERSION).toBe(1);
    expect(assertion(true).cacheSchemaVersion).toBe(1);
  });

  it("round-trips true and false", () => {
    for (const value of [true, false]) {
      const read = readPairingAssertion(structuredClone(assertion(value)), USER);

      expect(read.ok === true && read.assertion.cashDrawerEnabled).toBe(value);
    }
  });

  it("an old v1 record written before the field existed reads false — and is still accepted", () => {
    const { cashDrawerEnabled: _dropped, ...old } = assertion(true);
    void _dropped;

    expect("cashDrawerEnabled" in old).toBe(false);

    const read = readPairingAssertion(old, USER);

    expect(read.ok).toBe(true);
    expect(read.ok === true && read.assertion.cashDrawerEnabled).toBe(false);
  });

  it("anything stored that is not literally true reads false", () => {
    for (const value of ["true", 1, null, {}, [true]]) {
      const read = readPairingAssertion({ ...assertion(false), cashDrawerEnabled: value }, USER);

      expect(read.ok === true && read.assertion.cashDrawerEnabled).toBe(false);
    }
  });

  it("the builder stores a strict boolean", () => {
    expect(assertion(true).cashDrawerEnabled).toBe(true);
    expect(
      buildPairingAssertion({ ...assertion(false), verifiedAt: VERIFIED, cashDrawerEnabled: "yes" as unknown as boolean })
        .cashDrawerEnabled
    ).toBe(false);
  });

  it("unsupported schema and identity mismatch are still refused", () => {
    expect(readPairingAssertion({ ...assertion(true), cacheSchemaVersion: 2 }, USER)).toEqual({
      ok: false,
      reason: "unsupported_schema",
    });
    expect(readPairingAssertion(assertion(true), OTHER_USER)).toEqual({ ok: false, reason: "identity_mismatch" });
  });
});

// ---------------------------------------------------------------------------
// The offline fallback
// ---------------------------------------------------------------------------

describe("a valid offline start carries the last authoritative value", () => {
  const decide = async (record: unknown, now = NOW, user = USER) =>
    decideOfflineFallback({ now, sessionUserId: user, assertionRecord: record, configRecord: await configRecord() });

  it("cached true propagates into the rebuilt pairing", async () => {
    const result = await decide(assertion(true));

    expect(result.ok === true && result.pairing.cashDrawerEnabled).toBe(true);
  });

  it("cached false, and an old record without the field, give false", async () => {
    const { cashDrawerEnabled: _dropped, ...old } = assertion(true);
    void _dropped;

    for (const record of [assertion(false), old]) {
      const result = await decide(record);

      expect(result.ok).toBe(true);
      expect(result.ok === true && result.pairing.cashDrawerEnabled).toBe(false);
    }
  });

  it("an expired lease, a future clock and another device's record are still refused — true does not help", async () => {
    const expired = new Date(NOW - OFFLINE_DEVICE_LEASE_MS - 60_000).toISOString();
    const future = new Date(NOW + 60 * 60_000).toISOString();

    expect(await decide(assertion(true, expired))).toEqual({ ok: false, reason: "lease_expired" });
    expect(await decide(assertion(true, future))).toEqual({ ok: false, reason: "clock_invalid" });
    expect(await decide(assertion(true), NOW, OTHER_USER)).toEqual({ ok: false, reason: "identity_mismatch" });
  });
});

describe("persistDeviceCache -> loadOfflineFallback, through real IndexedDB", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
  });

  const pairing = (cashDrawerEnabled: boolean): DevicePairing => ({
    deviceId: DEVICE,
    projectId: PROJECT,
    buildJobId: BUILD,
    deviceName: "Till",
    platform: "windows",
    createdAt: "2026-08-01T09:00:00Z",
    revokedAt: null,
    cashDrawerEnabled,
  });

  it("the authoritative value written online is the value an offline start reads", async () => {
    for (const value of [true, false]) {
      globalThis.indexedDB = new IDBFactory();

      const stored = await persistDeviceCache({
        deviceAuthUserId: USER,
        pairing: pairing(value),
        config,
        verifiedAt: VERIFIED,
      });

      expect(stored.stored).toBe(true);

      const loaded = await loadOfflineFallback({ now: NOW, sessionUserId: USER });

      expect(loaded.ok === true && loaded.pairing.cashDrawerEnabled).toBe(value);
    }
  });

  it("a later authoritative OFF replaces an earlier ON", async () => {
    await persistDeviceCache({ deviceAuthUserId: USER, pairing: pairing(true), config, verifiedAt: VERIFIED });
    await persistDeviceCache({ deviceAuthUserId: USER, pairing: pairing(false), config, verifiedAt: VERIFIED });

    const loaded = await loadOfflineFallback({ now: NOW, sessionUserId: USER });

    expect(loaded.ok === true && loaded.pairing.cashDrawerEnabled).toBe(false);
  });
});
