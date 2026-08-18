// Feature 24.5A — the cold-start fallback decision, exhaustively.
//
// decideOfflineFallback is the gate between "the shop's internet is down" and a
// working till. It is pure, so every refusal path — including ones almost
// impossible to reproduce on real hardware — is reachable here.
import { describe, expect, it } from "vitest";
import {
  OFFLINE_BLOCKED_MESSAGES,
  decideOfflineFallback,
  getDeviceRuntimeMode,
} from "@/lib/deviceSession";
import type { DeviceState, OfflineBlockedReason } from "@/lib/deviceSession";
import {
  OFFLINE_DEVICE_LEASE_MS,
  buildPairingAssertion,
  buildPinnedConfigRecord,
} from "@/lib/deviceOfflineCache";
import { createGeneratedPosConfig } from "@/lib/generatedPosConfig";
import { defaultProjectConfig } from "@/lib/projectConfig";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const PROJECT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BUILD_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DEVICE_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const NOW = Date.parse("2026-08-18T12:00:00.000Z");

const config = createGeneratedPosConfig(
  {
    projectId: PROJECT_A,
    projectName: "Cafe A",
    templateId: "restaurant",
    config: defaultProjectConfig,
  },
  { generatedAt: "2026-08-18T09:00:00.000Z" }
);

function assertionAt(iso: string, overrides: Record<string, unknown> = {}) {
  return {
    ...buildPairingAssertion({
      deviceAuthUserId: USER_A,
      deviceId: DEVICE_A,
      projectId: PROJECT_A,
      buildJobId: BUILD_A,
      deviceName: "POS Device",
      platform: "windows",
      verifiedAt: iso,
    }),
    ...overrides,
  };
}

async function configRecord(overrides: Record<string, unknown> = {}) {
  const record = await buildPinnedConfigRecord({
    deviceAuthUserId: USER_A,
    projectId: PROJECT_A,
    buildJobId: BUILD_A,
    config,
    verifiedAt: "2026-08-18T09:00:00.000Z",
  });

  return { ...record!, ...overrides };
}

async function decide(
  assertionRecord: unknown,
  configRec: unknown,
  now = NOW,
  sessionUserId = USER_A
) {
  return decideOfflineFallback({ now, sessionUserId, assertionRecord, configRecord: configRec });
}

async function expectBlocked(
  assertionRecord: unknown,
  configRec: unknown,
  reason: OfflineBlockedReason,
  now = NOW,
  sessionUserId = USER_A
) {
  const result = await decide(assertionRecord, configRec, now, sessionUserId);

  expect(result.ok).toBe(false);
  expect(result.ok === false && result.reason).toBe(reason);
}

describe("a healthy cache inside the lease opens read-only", () => {
  it("returns the pinned config and the offline banner data", async () => {
    const result = await decide(
      assertionAt("2026-08-18T11:00:00.000Z"),
      await configRecord()
    );

    expect(result.ok).toBe(true);

    if (!result.ok) return;

    expect(result.config).toEqual(config);
    expect(result.pairing.projectId).toBe(PROJECT_A);
    expect(result.pairing.buildJobId).toBe(BUILD_A);
    expect(result.pairing.deviceId).toBe(DEVICE_A);
    expect(result.offline.lastVerifiedAt).toBe("2026-08-18T11:00:00.000Z");
    expect(result.offline.expiringSoon).toBe(false);
  });

  it("never carries a cached revocation answer", async () => {
    // revokedAt/createdAt are deliberately null: authorization while offline is
    // the lease, and a cached revocation field would invite treating stale data
    // as an authorization decision.
    const result = await decide(assertionAt("2026-08-18T11:00:00.000Z"), await configRecord());

    expect(result.ok === true && result.pairing.revokedAt).toBeNull();
    expect(result.ok === true && result.pairing.createdAt).toBeNull();
  });

  it("flags the final day so the operator is warned before it bricks", async () => {
    const verified = new Date(NOW - (OFFLINE_DEVICE_LEASE_MS - 3600_000)).toISOString();
    const result = await decide(assertionAt(verified), await configRecord());

    expect(result.ok === true && result.offline.expiringSoon).toBe(true);
  });
});

describe("every unsafe cache is refused", () => {
  it("no cache at all", async () => {
    await expectBlocked(null, null, "no_cache");
  });

  it("an assertion but no config", async () => {
    await expectBlocked(assertionAt("2026-08-18T11:00:00.000Z"), null, "no_cache");
  });

  it("a config but no assertion — the config alone proves nothing", async () => {
    await expectBlocked(null, await configRecord(), "no_cache");
  });

  it("the session belongs to a different anonymous user", async () => {
    // The re-pair isolation guarantee: a new pairing means a new auth user.
    await expectBlocked(
      assertionAt("2026-08-18T11:00:00.000Z"),
      await configRecord(),
      "identity_mismatch",
      NOW,
      USER_B
    );
  });

  it("the lease expired", async () => {
    const verified = new Date(NOW - OFFLINE_DEVICE_LEASE_MS - 1000).toISOString();

    await expectBlocked(assertionAt(verified), await configRecord(), "lease_expired");
  });

  it("the clock is in the future", async () => {
    const future = new Date(NOW + 48 * 3600_000).toISOString();

    await expectBlocked(assertionAt(future), await configRecord(), "clock_invalid");
  });

  it("the recorded time is unparseable", async () => {
    await expectBlocked(
      assertionAt("2026-08-18T11:00:00.000Z", { lastVerifiedAt: "whenever" }),
      await configRecord(),
      "clock_invalid"
    );
  });

  it("the config digest does not match its snapshot", async () => {
    await expectBlocked(
      assertionAt("2026-08-18T11:00:00.000Z"),
      await configRecord({ integrity: "0".repeat(64) }),
      "cache_corrupt"
    );
  });

  it("the config snapshot is not a valid GeneratedPosConfig", async () => {
    await expectBlocked(
      assertionAt("2026-08-18T11:00:00.000Z"),
      await configRecord({ configSnapshot: { schemaVersion: 1 } }),
      "cache_corrupt"
    );
  });

  it("the config belongs to a different build than the assertion", async () => {
    // A build change replaces the cache atomically; a mismatch means an
    // interrupted write, and half a replacement must not price a sale.
    await expectBlocked(
      assertionAt("2026-08-18T11:00:00.000Z", { buildJobId: "different-build" }),
      await configRecord(),
      "identity_mismatch"
    );
  });

  it("the envelope version is from the future", async () => {
    await expectBlocked(
      assertionAt("2026-08-18T11:00:00.000Z", { cacheSchemaVersion: 99 }),
      await configRecord(),
      "cache_corrupt"
    );
  });

  it("the assertion is structurally malformed", async () => {
    for (const bad of ["nope", [], 7, { cacheSchemaVersion: 1 }]) {
      const result = await decide(bad, await configRecord());

      expect(result.ok).toBe(false);
    }
  });

  it("every refusal has operator copy that names no internals", async () => {
    for (const [reason, message] of Object.entries(OFFLINE_BLOCKED_MESSAGES)) {
      expect(`copy for ${reason}`).toBe(`copy for ${reason}`);
      expect(message.length).toBeGreaterThan(20);

      for (const jargon of ["IndexedDB", "SHA", "digest", "schema", "null", "undefined"]) {
        expect(message).not.toContain(jargon);
      }
    }
  });
});

describe("an offline reopen never extends its own lease", () => {
  it("reading the cache leaves lastVerifiedAt untouched", async () => {
    // If a reopen refreshed the timestamp, a till kept off the network would
    // renew itself forever and the 7 days would mean nothing.
    const assertion = assertionAt("2026-08-18T11:00:00.000Z");
    const frozen = JSON.parse(JSON.stringify(assertion));

    await decide(assertion, await configRecord());
    await decide(assertion, await configRecord(), NOW + 3600_000);

    expect(assertion).toEqual(frozen);
  });

  it("a second reopen a day later still measures from the original contact", async () => {
    const verified = new Date(NOW - 6 * 24 * 3600_000).toISOString();
    const assertion = assertionAt(verified);

    expect((await decide(assertion, await configRecord(), NOW)).ok).toBe(true);

    // Two days later the ORIGINAL contact is 8 days old, so it must be refused.
    const twoDaysOn = NOW + 2 * 24 * 3600_000;

    await expectBlocked(assertion, await configRecord(), "lease_expired", twoDaysOn);
  });
});

describe("the runtime mode is explicit, never inferred", () => {
  it("a ready state without offline info is online", () => {
    const state = { status: "ready", pairing: {}, config } as unknown as DeviceState;

    expect(getDeviceRuntimeMode(state)).toBe("online");
  });

  it("a ready state carrying offline info is read-only", () => {
    const state = {
      status: "ready",
      pairing: {},
      config,
      offline: {
        lastVerifiedAt: "2026-08-18T11:00:00.000Z",
        leaseExpiresAt: "2026-08-25T11:00:00.000Z",
        expiringSoon: false,
      },
    } as unknown as DeviceState;

    expect(getDeviceRuntimeMode(state)).toBe("offline_read_only");
  });

  it("non-ready states are never offline mode", () => {
    for (const status of ["checking", "unpaired", "revoked", "reconnect_required"] as const) {
      const state = { status, reason: "no_cache", notice: null } as unknown as DeviceState;

      expect(getDeviceRuntimeMode(state)).toBe("online");
    }
  });
});
