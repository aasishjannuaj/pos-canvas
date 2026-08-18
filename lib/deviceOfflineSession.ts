// Feature 24.5A — orchestration: storage I/O plus the pure decisions, joined.
//
// Thin by design. Every rule lives in lib/deviceOfflineCache.ts (pure, tested
// under Node) and every byte of I/O in lib/deviceOfflineStore.ts (the only
// IndexedDB in the repository). This module owns the small amount of glue
// between them and nothing else, so there is no third place for a rule to hide.
//
// NOTHING HERE CAN FAIL LOUDLY. A till must start even when storage is denied,
// full or corrupt; the worst outcome any of these functions may produce is
// "this device cannot start offline".
import {
  buildPairingAssertion,
  buildPinnedConfigRecord,
} from "@/lib/deviceOfflineCache";
import {
  clearDeviceCache,
  openOfflineDb,
  readPairingAssertionRecord,
  readPinnedConfigRecord,
  requestStoragePersistence,
  writePairingAssertionRecord,
  writePinnedConfigRecord,
} from "@/lib/deviceOfflineStore";
import type { PersistenceOutcome } from "@/lib/deviceOfflineStore";
import { decideOfflineFallback } from "@/lib/deviceSession";
import type {
  DevicePairing,
  OfflineBlockedReason,
  OfflineRuntimeInfo,
} from "@/lib/deviceSession";
import type { GeneratedPosConfig } from "@/lib/generatedPosConfig";

export type CachePersistResult = {
  stored: boolean;
  persistence: PersistenceOutcome | null;
};

/**
 * Writes the authoritative pairing + configuration to the durable cache.
 *
 * Called ONLY after a successful authoritative start, which is what makes
 * `lastVerifiedAt` meaningful: it is the moment the server confirmed this
 * device is paired and not revoked.
 *
 * WHY THE CONFIG IS WRITTEN FIRST: if the process dies between the two writes,
 * a config with no assertion is inert (decideOfflineFallback refuses without an
 * assertion), whereas an assertion with no config would pass the lease check
 * and then fail on a missing snapshot. Both are refused, but the first ordering
 * never leaves a record that looks more authorized than it is.
 *
 * ATOMIC REPLACEMENT ON A BUILD CHANGE comes for free: both records are keyed by
 * name, so a new buildJobId overwrites the previous snapshot wholesale. Nothing
 * is merged — a configuration is a snapshot, not a document.
 */
export async function persistDeviceCache(input: {
  deviceAuthUserId: string;
  pairing: DevicePairing;
  config: GeneratedPosConfig;
  verifiedAt: string;
}): Promise<CachePersistResult> {
  const opened = await openOfflineDb();

  if (!opened.ok) {
    return { stored: false, persistence: null };
  }

  const db = opened.value;

  try {
    const configRecord = await buildPinnedConfigRecord({
      deviceAuthUserId: input.deviceAuthUserId,
      projectId: input.pairing.projectId,
      buildJobId: input.pairing.buildJobId,
      config: input.config,
      verifiedAt: input.verifiedAt,
    });

    // No digest means no usable record; writing the snapshot anyway would
    // guarantee a rejection on the next read.
    if (configRecord === null) {
      return { stored: false, persistence: null };
    }

    const configWrite = await writePinnedConfigRecord(db, configRecord);

    if (!configWrite.ok) {
      return { stored: false, persistence: null };
    }

    const assertionWrite = await writePairingAssertionRecord(
      db,
      buildPairingAssertion({
        deviceAuthUserId: input.deviceAuthUserId,
        deviceId: input.pairing.deviceId,
        projectId: input.pairing.projectId,
        buildJobId: input.pairing.buildJobId,
        deviceName: input.pairing.deviceName,
        platform: input.pairing.platform,
        verifiedAt: input.verifiedAt,
      })
    );

    if (!assertionWrite.ok) {
      return { stored: false, persistence: null };
    }

    // Advisory. A denial changes nothing the operator can act on, so it is
    // recorded and never surfaced.
    const persistence = await requestStoragePersistence();

    return { stored: true, persistence };
  } finally {
    db.close();
  }
}

export type OfflineFallbackOutcome =
  | {
      ok: true;
      pairing: DevicePairing;
      config: GeneratedPosConfig;
      offline: OfflineRuntimeInfo;
    }
  | { ok: false; reason: OfflineBlockedReason };

/**
 * Attempts a cached start. Reached ONLY after a classified transport failure.
 *
 * Reading does not touch `lastVerifiedAt`. An offline reopen must never extend
 * its own lease, or a till kept off the network would renew itself forever and
 * the 7 days would mean nothing.
 */
export async function loadOfflineFallback(input: {
  now: number;
  sessionUserId: string;
}): Promise<OfflineFallbackOutcome> {
  const opened = await openOfflineDb();

  if (!opened.ok) {
    return { ok: false, reason: "storage_unavailable" };
  }

  const db = opened.value;

  try {
    const assertionRecord = await readPairingAssertionRecord(db);
    const configRecord = await readPinnedConfigRecord(db);

    if (!assertionRecord.ok || !configRecord.ok) {
      return { ok: false, reason: "storage_unavailable" };
    }

    return await decideOfflineFallback({
      now: input.now,
      sessionUserId: input.sessionUserId,
      assertionRecord: assertionRecord.value,
      configRecord: configRecord.value,
    });
  } finally {
    db.close();
  }
}

/**
 * Removes every cached record.
 *
 * Called on local reset, on re-pair and on a CONFIRMED revocation — the three
 * moments after which the cached configuration belongs to a device or a
 * business this browser is no longer running. There is no sale queue in 24.5A,
 * so nothing here can destroy an unsynced sale; when 24.5C adds one, this
 * function is where the owner-approved "block unpair while the queue is
 * non-empty" rule attaches.
 */
export async function clearOfflineCache(): Promise<boolean> {
  const opened = await openOfflineDb();

  if (!opened.ok) {
    return false;
  }

  const db = opened.value;

  try {
    const cleared = await clearDeviceCache(db);

    return cleared.ok;
  } finally {
    db.close();
  }
}
