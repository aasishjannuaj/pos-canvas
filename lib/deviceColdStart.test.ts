// Feature 24.5G — the offline cold start, end to end over real storage.
//
// THE BUG THIS PINS. A paired Android till with a valid cache showed "This
// device is offline" on every zero-network launch. supabase-js will not return
// a session once the access token has expired and it cannot reach the server to
// refresh it, and the cold-start gate treated that as "this device cannot
// operate" — returning before the cached-start validator was ever consulted.
//
// The identity needed to OPEN the cache never required a valid token. It is an
// ownership selector for evidence the device already holds, and everything
// underneath it — the assertion, the digest, the identity match, the 7-day
// lease — still has to pass. These tests assert exactly that, and that each of
// those gates still refuses on its own.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { readPersistedDeviceUserId } from "@/lib/device.rpc";
import { classifyDeviceFailure, permitsOfflineFallback } from "@/lib/deviceConnectivity";
import { classifyStartupFailure } from "@/lib/deviceStartupError";
import { DEVICE_AUTH_STORAGE_KEY } from "@/lib/supabase/deviceClient";
import { loadOfflineFallback, persistDeviceCache } from "@/lib/deviceOfflineSession";
import { OFFLINE_DEVICE_LEASE_MS } from "@/lib/deviceOfflineCache";
import { openOfflineDb, writePinnedConfigRecord } from "@/lib/deviceOfflineStore";
import { createGeneratedPosConfig } from "@/lib/generatedPosConfig";
import { cloneProjectConfig, defaultProjectConfig } from "@/lib/projectConfig";
import { DEVICE_ERROR_MESSAGES, DEVICE_ERROR_TITLES } from "@/lib/deviceSession";
import type { DeviceErrorKind, DevicePairing } from "@/lib/deviceSession";

const USER = "0385499a-1111-4111-8111-111111111111";
const OTHER_USER = "99999999-9999-4999-8999-999999999999";

const PAIRING: DevicePairing = {
  deviceId: "33333333-3333-4333-8333-333333333333",
  projectId: "44444444-4444-4444-8444-444444444444",
  buildJobId: "55555555-5555-4555-8555-555555555555",
  deviceName: "POS Device",
  platform: "android",
  createdAt: null,
  revokedAt: null,
};

const PAIRED_AT = Date.parse("2026-08-20T08:00:00.000Z");

function config() {
  return createGeneratedPosConfig({
    projectId: PAIRING.projectId,
    projectName: "Corner Cafe",
    templateId: "cafe",
    config: cloneProjectConfig(defaultProjectConfig),
  });
}

/**
 * A supabase-js session blob, shaped as auth-js persists it.
 *
 * The token fields are present precisely so the tests can prove the reader
 * ignores them: nothing under test may return, log or depend on either.
 */
function sessionBlob(userId: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    access_token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.PLACEHOLDER.SIGNATURE",
    refresh_token: "REFRESH-PLACEHOLDER",
    expires_at: Math.floor(PAIRED_AT / 1000) + 3600,
    token_type: "bearer",
    user: { id: userId, is_anonymous: true },
    ...overrides,
  });
}

/** A minimal Storage stand-in, so this runs under plain Node. */
function storageWith(value: string | null): Pick<Storage, "getItem"> {
  return { getItem: (key: string) => (key === DEVICE_AUTH_STORAGE_KEY ? value : null) };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

/** Everything a device holds after one successful authoritative online start. */
async function pairOnline(): Promise<void> {
  const stored = await persistDeviceCache({
    deviceAuthUserId: USER,
    pairing: PAIRING,
    config: config(),
    verifiedAt: new Date(PAIRED_AT).toISOString(),
  });

  expect(stored.stored).toBe(true);
}

// ---------------------------------------------------------------------------
// The local identity read
// ---------------------------------------------------------------------------

describe("the persisted device identity is readable without a network", () => {
  it("recovers the user id from the session supabase-js already stored", () => {
    expect(readPersistedDeviceUserId(storageWith(sessionBlob(USER)))).toBe(USER);
  });

  it("returns the identity and NOTHING else", () => {
    // The blob carries an access token and a refresh token. The reader's return
    // type has nowhere to put either, and this pins that it never does.
    const recovered = readPersistedDeviceUserId(storageWith(sessionBlob(USER)));

    expect(recovered).toBe(USER);
    expect(recovered).not.toContain("eyJ");
    expect(recovered).not.toContain("REFRESH");
  });

  it("works when the access token has already expired", () => {
    // The whole point: an expired token is exactly when supabase-js stops
    // handing back a session, and exactly when the cache must still open.
    const expired = sessionBlob(USER, { expires_at: Math.floor(PAIRED_AT / 1000) - 60 });

    expect(readPersistedDeviceUserId(storageWith(expired))).toBe(USER);
  });

  it("fails safely on malformed storage, and never throws", () => {
    for (const bad of [
      null,
      "",
      "not json",
      "{}",
      '{"user":null}',
      '{"user":{}}',
      '{"user":{"id":123}}',
      '{"user":{"id":"not-a-uuid"}}',
      '{"user":{"id":""}}',
      "[]",
    ]) {
      expect(`malformed: ${bad}`).toBe(`malformed: ${bad}`);
      expect(readPersistedDeviceUserId(storageWith(bad))).toBeNull();
    }
  });

  it("returns null rather than throwing where there is no storage at all", () => {
    expect(readPersistedDeviceUserId(null)).toBeNull();
    expect(readPersistedDeviceUserId(undefined)).toBeNull();
    expect(readPersistedDeviceUserId({} as Pick<Storage, "getItem">)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The valid case
// ---------------------------------------------------------------------------

describe("a paired till opens its cached POS with zero network", () => {
  it("restores the same identity and reaches offline-ready", async () => {
    await pairOnline();

    // The process dies and relaunches with no network. The only thing recovered
    // locally is the identity; every gate below is the real validator.
    const recovered = readPersistedDeviceUserId(storageWith(sessionBlob(USER)));

    expect(recovered).toBe(USER);

    const fallback = await loadOfflineFallback({
      now: PAIRED_AT + 60_000,
      sessionUserId: recovered!,
    });

    expect(fallback.ok).toBe(true);

    if (!fallback.ok) return;

    expect(fallback.pairing.deviceId).toBe(PAIRING.deviceId);
    expect(fallback.pairing.projectId).toBe(PAIRING.projectId);
    expect(fallback.pairing.buildJobId).toBe(PAIRING.buildJobId);
    expect(fallback.config.project.projectId).toBe(PAIRING.projectId);
    expect(fallback.offline.lastVerifiedAt).toBe(new Date(PAIRED_AT).toISOString());
  });

  it("still opens on day 6 of the lease, and not on day 8", async () => {
    await pairOnline();

    const day6 = await loadOfflineFallback({
      now: PAIRED_AT + 6 * 24 * 60 * 60 * 1000,
      sessionUserId: USER,
    });

    expect(day6.ok).toBe(true);

    const day8 = await loadOfflineFallback({
      now: PAIRED_AT + OFFLINE_DEVICE_LEASE_MS + 1,
      sessionUserId: USER,
    });

    expect(day8.ok).toBe(false);
    expect(day8.ok === false && day8.reason).toBe("lease_expired");
  });
});

// ---------------------------------------------------------------------------
// Every refusal still refuses
// ---------------------------------------------------------------------------

describe("recovering an identity locally weakens no other gate", () => {
  it("no persisted identity means no cached POS", async () => {
    await pairOnline();

    // Cache is perfect; the device simply cannot say who it is. The runtime
    // gate treats this as "never paired" and requires the network.
    expect(readPersistedDeviceUserId(storageWith(null))).toBeNull();
  });

  it("a DIFFERENT auth user cannot open this device's cache", async () => {
    await pairOnline();

    const recovered = readPersistedDeviceUserId(storageWith(sessionBlob(OTHER_USER)));

    expect(recovered).toBe(OTHER_USER);

    const fallback = await loadOfflineFallback({
      now: PAIRED_AT + 60_000,
      sessionUserId: recovered!,
    });

    expect(fallback.ok).toBe(false);
    expect(fallback.ok === false && fallback.reason).toBe("identity_mismatch");
  });

  it("a missing pairing assertion blocks", async () => {
    // Config written, assertion never was.
    const opened = await openOfflineDb();

    expect(opened.ok).toBe(true);

    if (!opened.ok) return;

    opened.value.close();

    const fallback = await loadOfflineFallback({
      now: PAIRED_AT + 60_000,
      sessionUserId: USER,
    });

    expect(fallback.ok).toBe(false);
    expect(fallback.ok === false && fallback.reason).toBe("no_cache");
  });

  it("a corrupt pinned config blocks on its digest", async () => {
    await pairOnline();

    // Tamper with the snapshot, leaving the recorded digest in place.
    const opened = await openOfflineDb();

    expect(opened.ok).toBe(true);

    if (!opened.ok) return;

    const good = config();

    await writePinnedConfigRecord(opened.value, {
      cacheSchemaVersion: 1,
      configSchemaVersion: good.schemaVersion,
      deviceAuthUserId: USER,
      projectId: PAIRING.projectId,
      buildJobId: PAIRING.buildJobId,
      configSnapshot: { ...good, generatedAt: "1999-01-01T00:00:00.000Z" },
      integrity: "0".repeat(64),
      fetchedAt: new Date(PAIRED_AT).toISOString(),
      lastVerifiedAt: new Date(PAIRED_AT).toISOString(),
    });
    opened.value.close();

    const fallback = await loadOfflineFallback({
      now: PAIRED_AT + 60_000,
      sessionUserId: USER,
    });

    expect(fallback.ok).toBe(false);
    expect(fallback.ok === false && fallback.reason).toBe("cache_corrupt");
  });

  it("a clock claiming the cache was verified in the future blocks", async () => {
    await pairOnline();

    const fallback = await loadOfflineFallback({
      now: PAIRED_AT - 24 * 60 * 60 * 1000,
      sessionUserId: USER,
    });

    expect(fallback.ok).toBe(false);
    expect(fallback.ok === false && fallback.reason).toBe("clock_invalid");
  });
});

// ---------------------------------------------------------------------------
// The write race
// ---------------------------------------------------------------------------

describe("the cache is durable before a device is called offline-ready", () => {
  it("reports the write, and the record is readable immediately after", async () => {
    const stored = await persistDeviceCache({
      deviceAuthUserId: USER,
      pairing: PAIRING,
      config: config(),
      verifiedAt: new Date(PAIRED_AT).toISOString(),
    });

    // The awaited result is the signal the runtime gates on. Because it is
    // awaited, a read straight afterwards already sees the record — which is
    // exactly what a process killed one moment later would have found.
    expect(stored.stored).toBe(true);

    const fallback = await loadOfflineFallback({
      now: PAIRED_AT + 1_000,
      sessionUserId: USER,
    });

    expect(fallback.ok).toBe(true);
  });

  it("reports failure rather than claiming readiness when storage is gone", async () => {
    globalThis.indexedDB = undefined as unknown as IDBFactory;

    const stored = await persistDeviceCache({
      deviceAuthUserId: USER,
      pairing: PAIRING,
      config: config(),
      verifiedAt: new Date(PAIRED_AT).toISOString(),
    });

    // `false` is what drives the operator notice. It must never be true here.
    expect(stored.stored).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Feature 24.5G — the two ways a paired till reaches its cache with no network
//
// The hardware failure was PATH A: the session was fine and the DOWNSTREAM RPC
// lost the network, but postgrest's synthesized error classified as a server
// reply, so the offline gate refused before the validator ever ran. PATH B is
// the earlier fix: the session itself could not be validated.
//
// Both are modelled with the REAL library error shape, because a synthetic
// `{ message: "Failed to fetch" }` is exactly what let PATH A ship broken.
// ---------------------------------------------------------------------------

/** What `.rpc()` hands device.rpc.ts offline, with the status it plumbs through. */
const OFFLINE_RPC_ERROR = {
  message: "TypeError: Failed to fetch",
  details: "TypeError: Failed to fetch\n    at https://localhost/assets/index.js:1:2",
  hint: "",
  code: "",
  status: 0,
};

/** auth-js's shape when a token refresh cannot reach the server. */
const OFFLINE_AUTH_ERROR = {
  name: "AuthRetryableFetchError",
  message: "Failed to fetch",
  status: 0,
};

/**
 * The runtime's gate, as a function: openOfflineOrFail refuses anything that is
 * not a transport failure, and only then consults the cache.
 *
 * Feature 25.4 — the refusal now reports WHICH error it is, exactly as the
 * component does. It used to return a single "error-offline" screen, which
 * quietly baked in the assumption this feature removes: that every refusal here
 * means the network is down. The gate itself — permitsOfflineFallback, then the
 * validator — is byte-for-byte the same decision it was.
 */
async function coldStart(input: {
  failure: ReturnType<typeof classifyDeviceFailure> | undefined;
  sessionUserId: string;
  now: number;
}): Promise<{
  screen: "ready-offline" | "reconnect_required" | "error";
  kind?: DeviceErrorKind;
  reason?: string;
}> {
  if (input.failure === undefined || !permitsOfflineFallback(input.failure)) {
    return { screen: "error", kind: classifyStartupFailure(input.failure) };
  }

  const fallback = await loadOfflineFallback({
    now: input.now,
    sessionUserId: input.sessionUserId,
  });

  return fallback.ok
    ? { screen: "ready-offline" }
    : { screen: "reconnect_required", reason: fallback.reason };
}

describe("PATH A: valid local session, downstream RPC loses the network", () => {
  it("classifies the real offline RPC error as transport", () => {
    // The exact bug. This returned "server_rejected" and refused the cache.
    expect(classifyDeviceFailure(OFFLINE_RPC_ERROR)).toBe("transport");
    expect(permitsOfflineFallback(classifyDeviceFailure(OFFLINE_RPC_ERROR))).toBe(true);
  });

  it("reaches ready/offline instead of the terminal offline error", async () => {
    await pairOnline();

    // getDeviceSession succeeded — the token is NOT expired — so the identity
    // comes from the live session exactly as it did on the phone.
    const outcome = await coldStart({
      failure: classifyDeviceFailure(OFFLINE_RPC_ERROR),
      sessionUserId: USER,
      now: PAIRED_AT + 60_000,
    });

    expect(outcome.screen).toBe("ready-offline");
    // The screenshot's failure, asserted as impossible.
    expect(outcome.screen).not.toBe("error-offline");
  });

  it("does the same for a failed config fetch", async () => {
    await pairOnline();

    const outcome = await coldStart({
      failure: classifyDeviceFailure(OFFLINE_RPC_ERROR),
      sessionUserId: USER,
      now: PAIRED_AT + 3 * 60 * 60 * 1000,
    });

    expect(outcome.screen).toBe("ready-offline");
  });
});

describe("PATH B: the session itself cannot be validated", () => {
  it("classifies the auth refresh failure as transport", () => {
    expect(classifyDeviceFailure(OFFLINE_AUTH_ERROR)).toBe("transport");
  });

  it("recovers the identity locally and still reaches ready/offline", async () => {
    await pairOnline();

    // Token expired: supabase-js returns no session, so the id comes from disk.
    const expired = sessionBlob(USER, { expires_at: Math.floor(PAIRED_AT / 1000) - 60 });
    const recovered = readPersistedDeviceUserId(storageWith(expired));

    expect(recovered).toBe(USER);

    const outcome = await coldStart({
      failure: classifyDeviceFailure(OFFLINE_AUTH_ERROR),
      sessionUserId: recovered!,
      now: PAIRED_AT + 2 * 60 * 60 * 1000,
    });

    expect(outcome.screen).toBe("ready-offline");
  });
});

describe("an answered rejection still never opens the cache", () => {
  it("a P0001 revocation refuses, and the validator is never consulted", async () => {
    await pairOnline();

    // The cache is perfect. It must still not be used: the server ANSWERED.
    const outcome = await coldStart({
      failure: classifyDeviceFailure({
        message: "Project not found or access denied",
        details: null,
        hint: null,
        code: "P0001",
        status: 400,
      }),
      sessionUserId: USER,
      now: PAIRED_AT + 60_000,
    });

    expect(outcome.screen).toBe("error");
    // Feature 25.4 — a revocation ANSWERED. Telling the operator "No
    // connection" here was the same untruth the fresh-install branch told.
    expect(outcome.kind).toBe("startup_failed");
  });

  it("401, 403 and 503 responses all refuse", async () => {
    await pairOnline();

    for (const status of [401, 403, 503]) {
      expect(`status ${status}`).toBe(`status ${status}`);

      const outcome = await coldStart({
        failure: classifyDeviceFailure({ message: "denied", status }),
        sessionUserId: USER,
        now: PAIRED_AT + 60_000,
      });

      expect(outcome.screen).toBe("error");
      expect(outcome.kind).toBe("startup_failed");
    }
  });

  it("a transport failure with a BROKEN cache still refuses, distinctly", async () => {
    // No cache written at all: transport is permitted, the validator runs, and
    // it is the validator that refuses — a different screen from the above.
    const outcome = await coldStart({
      failure: classifyDeviceFailure(OFFLINE_RPC_ERROR),
      sessionUserId: USER,
      now: PAIRED_AT + 60_000,
    });

    expect(outcome.screen).toBe("reconnect_required");
    expect(outcome.reason).toBe("no_cache");
  });
});

// ---------------------------------------------------------------------------
// Feature 25.4 — a paired till is told which thing is wrong, too
//
// The fresh-install branch was fixed first. The SAME untruth lived one path
// over: openOfflineOrFail answered createDeviceError("offline") for every
// failure the offline gate refused, so a paired till whose start the server
// REFUSED reported "No connection" on a working network.
//
// The gate is untouched. What changed is only the sentence on the way out, and
// these run over real IndexedDB so the lease, digest and identity checks are
// genuinely exercised rather than mocked past.
// ---------------------------------------------------------------------------

describe("a paired till whose start was refused is not told the network is down", () => {
  it("a definite server rejection with no usable fallback says startup_failed", async () => {
    // No cache at all AND an answered rejection: the terminal error path.
    const outcome = await coldStart({
      failure: classifyDeviceFailure({ status: 422, code: "P0001", message: "denied" }),
      sessionUserId: USER,
      now: PAIRED_AT + 60_000,
    });

    expect(outcome.screen).toBe("error");
    expect(outcome.kind).toBe("startup_failed");
    expect(DEVICE_ERROR_TITLES[outcome.kind!]).toBe("Unable to start this device");
    expect(DEVICE_ERROR_TITLES[outcome.kind!]).not.toBe("No connection");
  });

  it("the same is true with a PERFECT cache — the refusal still wins", async () => {
    await pairOnline();

    const outcome = await coldStart({
      failure: classifyDeviceFailure({ status: 401, message: "denied" }),
      sessionUserId: USER,
      now: PAIRED_AT + 60_000,
    });

    // The 24.5A rule is intact: an answered rejection never opens the cache.
    expect(outcome.screen).toBe("error");
    expect(outcome.kind).toBe("startup_failed");
  });

  it("an unclassifiable failure does not claim the network is down either", async () => {
    for (const failure of [classifyDeviceFailure({ weird: true }), undefined] as const) {
      const outcome = await coldStart({ failure, sessionUserId: USER, now: PAIRED_AT + 60_000 });

      expect(outcome.screen).toBe("error");
      expect(outcome.kind).toBe("startup_failed");
    }
  });

  it("a transport failure NEVER reaches this terminal error at all", async () => {
    // Worth pinning explicitly, because it is what makes the persisted path
    // differ from fresh install: permitsOfflineFallback admits transport, so a
    // transport failure always goes on to the validator. With no usable cache
    // the answer is reconnect_required — NOT "No connection", and NOT an error.
    const outcome = await coldStart({
      failure: classifyDeviceFailure(OFFLINE_RPC_ERROR),
      sessionUserId: USER,
      now: PAIRED_AT + 60_000,
    });

    expect(outcome.screen).toBe("reconnect_required");
    expect(outcome.screen).not.toBe("error");
  });

  it("but the mapping still answers offline for transport, wherever it is asked", () => {
    // One authority, shared with fresh install. If the gate above ever changed
    // so that transport could reach a terminal error, this is what it would say.
    expect(classifyStartupFailure("transport")).toBe("offline");
    expect(DEVICE_ERROR_TITLES.offline).toBe("No connection");
  });

  it("no refusal message names the thing that refused", async () => {
    await pairOnline();

    const outcome = await coldStart({
      failure: classifyDeviceFailure({
        status: 403,
        code: "42501",
        message: "permission denied for table paired_devices",
      }),
      sessionUserId: USER,
      now: PAIRED_AT + 60_000,
    });

    const shown = `${DEVICE_ERROR_TITLES[outcome.kind!]} ${DEVICE_ERROR_MESSAGES[outcome.kind!]}`;

    for (const leak of ["paired_devices", "42501", "403", "permission denied", "supabase"]) {
      expect(shown.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });
});

describe("the copy change bypasses no offline gate", () => {
  it("a valid lease still opens the till offline on a transport failure", async () => {
    await pairOnline();

    const outcome = await coldStart({
      failure: classifyDeviceFailure(OFFLINE_AUTH_ERROR),
      sessionUserId: USER,
      now: PAIRED_AT + 6 * 24 * 60 * 60 * 1000,
    });

    expect(outcome.screen).toBe("ready-offline");
  });

  it("an expired lease still refuses, with reconnect_required unchanged", async () => {
    await pairOnline();

    const outcome = await coldStart({
      failure: classifyDeviceFailure(OFFLINE_AUTH_ERROR),
      sessionUserId: USER,
      now: PAIRED_AT + OFFLINE_DEVICE_LEASE_MS + 1,
    });

    expect(outcome.screen).toBe("reconnect_required");
    expect(outcome.reason).toBe("lease_expired");
  });

  it("a foreign identity still refuses, and never as a copy decision", async () => {
    await pairOnline();

    const outcome = await coldStart({
      failure: classifyDeviceFailure(OFFLINE_AUTH_ERROR),
      sessionUserId: OTHER_USER,
      now: PAIRED_AT + 60_000,
    });

    expect(outcome.screen).toBe("reconnect_required");
    expect(outcome.reason).toBe("identity_mismatch");
  });

  it("every reconnect_required reason still routes to its own screen", async () => {
    // No cache is the reason a fresh-ish paired device hits; the others are
    // covered above and in the 24.5G blocks. What matters here is that NONE of
    // them became a DeviceError when the terminal copy changed.
    const outcome = await coldStart({
      failure: classifyDeviceFailure(OFFLINE_RPC_ERROR),
      sessionUserId: USER,
      now: PAIRED_AT + 60_000,
    });

    expect(outcome.screen).toBe("reconnect_required");
    expect(outcome.reason).toBe("no_cache");
    expect(outcome.kind).toBeUndefined();
  });
});
