// Feature 24.5A — integrity, identity and lease rules for the durable cache.
//
// Everything here runs under plain Node: the rules are pure, and Node 18+ has
// the same Web Crypto SubtleCrypto the browsers do, so the digests these tests
// compute are the digests a real till computes.
import { describe, expect, it } from "vitest";
import {
  OFFLINE_CACHE_SCHEMA_VERSION,
  OFFLINE_CLOCK_TOLERANCE_MS,
  OFFLINE_DEVICE_LEASE_MS,
  buildPairingAssertion,
  buildPinnedConfigRecord,
  canonicalize,
  digestConfig,
  evaluateLease,
  parseIsoTime,
  readPairingAssertion,
  readPinnedConfig,
} from "@/lib/deviceOfflineCache";
import { GENERATED_POS_CONFIG_SCHEMA_VERSION } from "@/lib/generatedPosConfig";
import type { GeneratedPosConfig } from "@/lib/generatedPosConfig";
import { createGeneratedPosConfig } from "@/lib/generatedPosConfig";
import { defaultProjectConfig } from "@/lib/projectConfig";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const PROJECT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BUILD_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BUILD_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DEVICE_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

/**
 * `generatedAt` is pinned deliberately.
 *
 * lib/generatedPosConfig.ts calls it "the one intentionally non-deterministic"
 * field, so two unpinned calls produce two different configs and two different
 * digests. That is correct for a BUILD — every publish is a new snapshot — and
 * irrelevant to the cache, which stores one fixed snapshot that came from
 * build_jobs.config_snapshot and never regenerates it. Pinning here reproduces
 * the production condition instead of testing the clock.
 */
function makeConfig(businessName = "Cafe A"): GeneratedPosConfig {
  return createGeneratedPosConfig(
    {
      projectId: PROJECT_A,
      projectName: businessName,
      templateId: "restaurant",
      config: {
        ...defaultProjectConfig,
        businessProfile: { ...defaultProjectConfig.businessProfile, businessName },
      },
    },
    { generatedAt: "2026-08-18T12:00:00.000Z" }
  );
}

const IDENTITY_A = {
  deviceAuthUserId: USER_A,
  projectId: PROJECT_A,
  buildJobId: BUILD_A,
};

async function storedConfig(config = makeConfig()) {
  const record = await buildPinnedConfigRecord({
    deviceAuthUserId: USER_A,
    projectId: PROJECT_A,
    buildJobId: BUILD_A,
    config,
    verifiedAt: "2026-08-18T12:00:00.000Z",
  });

  expect(record).not.toBeNull();

  return record!;
}

// ---------------------------------------------------------------------------
// Canonicalization + digest
// ---------------------------------------------------------------------------

describe("canonicalization is order-independent", () => {
  it("the same data in a different key order digests identically", () => {
    // WHY THIS MATTERS: property order follows insertion, so a snapshot parsed
    // from two responses can serialize differently. Without sorting, a perfectly
    // good cache would fail its own integrity check.
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalize({ a: { c: 3, d: 2 }, b: 1 })
    );
  });

  it("array order is preserved, because menu order is meaningful", () => {
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it("undefined members are dropped, matching JSON round-tripping", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });
});

describe("digests are stable and sensitive", () => {
  it("produces 64 lowercase hex characters", async () => {
    const digest = await digestConfig(makeConfig());

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the same config digests the same twice", async () => {
    expect(await digestConfig(makeConfig())).toBe(await digestConfig(makeConfig()));
  });

  it("a one-character change alters the digest", async () => {
    expect(await digestConfig(makeConfig("Cafe A"))).not.toBe(
      await digestConfig(makeConfig("Cafe B"))
    );
  });

  it("returns null rather than throwing when Web Crypto is missing", async () => {
    expect(await digestConfig(makeConfig(), null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The lease
// ---------------------------------------------------------------------------

describe("the 7-day lease", () => {
  const now = Date.parse("2026-08-18T12:00:00.000Z");

  it("is exactly seven days", () => {
    expect(OFFLINE_DEVICE_LEASE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("a fresh assertion is valid", () => {
    const result = evaluateLease(new Date(now).toISOString(), now);

    expect(result.ok).toBe(true);
  });

  it("one millisecond before expiry is still valid", () => {
    const verified = new Date(now - OFFLINE_DEVICE_LEASE_MS + 1).toISOString();

    expect(evaluateLease(verified, now).ok).toBe(true);
  });

  it("one millisecond after expiry is refused", () => {
    const verified = new Date(now - OFFLINE_DEVICE_LEASE_MS - 1).toISOString();
    const result = evaluateLease(verified, now);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("expired");
  });

  it("eight days offline is refused", () => {
    const verified = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();

    expect(evaluateLease(verified, now).ok).toBe(false);
  });

  it("warns inside the final day but stays valid", () => {
    const verified = new Date(now - (OFFLINE_DEVICE_LEASE_MS - 60_000)).toISOString();
    const result = evaluateLease(verified, now);

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.expiringSoon).toBe(true);
  });

  it("does not warn early in the lease", () => {
    const result = evaluateLease(new Date(now - 60_000).toISOString(), now);

    expect(result.ok === true && result.expiringSoon).toBe(false);
  });
});

describe("clock anomalies are refused, never accommodated", () => {
  const now = Date.parse("2026-08-18T12:00:00.000Z");

  it("a missing value is refused", () => {
    const result = evaluateLease(undefined, now);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("missing");
  });

  it("an unparseable value is refused", () => {
    for (const bad of ["", "   ", "not-a-date", "2026-13-45T99:99:99Z"]) {
      expect(`bad ${bad}`).toBe(`bad ${bad}`);
      expect(evaluateLease(bad, now).ok).toBe(false);
    }
  });

  it("a timestamp meaningfully in the future is refused", () => {
    // Either the clock moved backwards or the record was edited to extend the
    // lease. Both mean "reconnect", never "trust it".
    const future = new Date(now + OFFLINE_CLOCK_TOLERANCE_MS + 60_000).toISOString();
    const result = evaluateLease(future, now);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("future");
  });

  it("small skew inside the tolerance is accepted", () => {
    const slightlyAhead = new Date(now + 60_000).toISOString();

    expect(evaluateLease(slightlyAhead, now).ok).toBe(true);
  });

  it("a non-finite now is refused", () => {
    expect(evaluateLease(new Date(now).toISOString(), Number.NaN).ok).toBe(false);
  });

  it("parseIsoTime rejects non-strings and nonsense", () => {
    expect(parseIsoTime(null)).toBeNull();
    expect(parseIsoTime(12345)).toBeNull();
    expect(parseIsoTime("nope")).toBeNull();
    expect(parseIsoTime("2026-08-18T12:00:00.000Z")).toBe(now);
  });
});

// ---------------------------------------------------------------------------
// Reading records back
// ---------------------------------------------------------------------------

describe("a pairing assertion is validated before it is believed", () => {
  const assertion = buildPairingAssertion({
    deviceAuthUserId: USER_A,
    deviceId: DEVICE_A,
    projectId: PROJECT_A,
    buildJobId: BUILD_A,
    deviceName: "POS Device",
    platform: "windows",
    verifiedAt: "2026-08-18T12:00:00.000Z",
  });

  it("round-trips through storage", () => {
    const result = readPairingAssertion(JSON.parse(JSON.stringify(assertion)), USER_A);

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.assertion.buildJobId).toBe(BUILD_A);
  });

  it("refuses a record belonging to a different auth user", () => {
    const result = readPairingAssertion(assertion, USER_B);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("identity_mismatch");
  });

  it("refuses an unknown envelope version", () => {
    const future = { ...assertion, cacheSchemaVersion: OFFLINE_CACHE_SCHEMA_VERSION + 1 };
    const result = readPairingAssertion(future, USER_A);

    expect(result.ok === false && result.reason).toBe("unsupported_schema");
  });

  it("refuses missing and malformed records", () => {
    expect(readPairingAssertion(null, USER_A).ok).toBe(false);
    expect(readPairingAssertion("nope", USER_A).ok).toBe(false);
    expect(readPairingAssertion([], USER_A).ok).toBe(false);
    expect(readPairingAssertion({ ...assertion, deviceId: "" }, USER_A).ok).toBe(false);
    expect(readPairingAssertion({ ...assertion, lastVerifiedAt: 5 }, USER_A).ok).toBe(false);
  });
});

describe("a cached config is validated before it prices anything", () => {
  it("round-trips through storage", async () => {
    const record = await storedConfig();
    const result = await readPinnedConfig(JSON.parse(JSON.stringify(record)), IDENTITY_A);

    expect(result.ok).toBe(true);
  });

  it("refuses a tampered snapshot whose digest no longer matches", async () => {
    const record = await storedConfig();
    const tampered = {
      ...record,
      configSnapshot: {
        ...record.configSnapshot,
        businessProfile: {
          ...record.configSnapshot.businessProfile,
          businessName: "Someone Else",
        },
      },
    };

    const result = await readPinnedConfig(tampered, IDENTITY_A);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("integrity_mismatch");
  });

  it("refuses a rewritten digest", async () => {
    const record = await storedConfig();
    const result = await readPinnedConfig({ ...record, integrity: "0".repeat(64) }, IDENTITY_A);

    expect(result.ok === false && result.reason).toBe("integrity_mismatch");
  });

  it("refuses a snapshot that is not a valid GeneratedPosConfig", async () => {
    const record = await storedConfig();
    const result = await readPinnedConfig(
      { ...record, configSnapshot: { schemaVersion: GENERATED_POS_CONFIG_SCHEMA_VERSION } },
      IDENTITY_A
    );

    expect(result.ok === false && result.reason).toBe("invalid_config");
  });

  it("refuses another project's or another build's record", async () => {
    const record = await storedConfig();

    expect(
      (await readPinnedConfig(record, { ...IDENTITY_A, projectId: PROJECT_B })).ok
    ).toBe(false);
    expect(
      (await readPinnedConfig(record, { ...IDENTITY_A, buildJobId: BUILD_B })).ok
    ).toBe(false);
    expect(
      (await readPinnedConfig(record, { ...IDENTITY_A, deviceAuthUserId: USER_B })).ok
    ).toBe(false);
  });

  it("refuses an unknown envelope version and malformed shapes", async () => {
    const record = await storedConfig();

    expect(
      (await readPinnedConfig({ ...record, cacheSchemaVersion: 99 }, IDENTITY_A)).ok
    ).toBe(false);
    expect((await readPinnedConfig(null, IDENTITY_A)).ok).toBe(false);
    expect((await readPinnedConfig([], IDENTITY_A)).ok).toBe(false);
    expect((await readPinnedConfig({ ...record, integrity: "" }, IDENTITY_A)).ok).toBe(false);
  });

  it("refuses a declared config version that disagrees with the snapshot", async () => {
    const record = await storedConfig();
    const result = await readPinnedConfig({ ...record, configSchemaVersion: 99 }, IDENTITY_A);

    expect(result.ok === false && result.reason).toBe("malformed");
  });

  it("BUSINESS A's cache cannot be read by BUSINESS B's device", async () => {
    // The isolation guarantee, stated as its own test because it is the one a
    // reviewer will look for: a re-pair produces a new anonymous auth user, so
    // the previous business's record can never match.
    const businessA = await storedConfig(makeConfig("Cafe A"));

    const asBusinessB = await readPinnedConfig(businessA, {
      deviceAuthUserId: USER_B,
      projectId: PROJECT_B,
      buildJobId: BUILD_B,
    });

    expect(asBusinessB.ok).toBe(false);
    expect(asBusinessB.ok === false && asBusinessB.reason).toBe("identity_mismatch");
  });
});
