// Feature 24.5F — the uncertain online sale's public API: storage plus rules.
//
// Thin, like lib/saleQueueSession.ts. Every rule lives in
// lib/uncertainSaleRecord.ts and every byte of I/O in
// lib/deviceOfflineStore.ts; this module owns the small amount of glue.
//
// NOTHING HERE TALKS TO THE NETWORK. It records that a request left the device
// and cannot say what became of it. Resolving one is the checkout path's job,
// through the ordinary complete_sale_v3 replay or the offline queue.
import {
  buildUncertainSaleRecord,
  ownsUncertainSale,
  readUncertainSaleRecord,
  toUncertainSale,
} from "@/lib/uncertainSaleRecord";
import type {
  PersistedUncertainSale,
  UncertainSaleIdentity,
} from "@/lib/uncertainSaleRecord";
import {
  deleteUncertainSaleRecordRaw,
  openOfflineDb,
  readUncertainSaleRecordRaw,
  writeUncertainSaleRecordRaw,
} from "@/lib/deviceOfflineStore";
import type { UncertainSale } from "@/lib/saleSubmission";
import { getSaleByRequestId } from "@/lib/saleQueueSession";

async function withDb<T>(
  run: (db: IDBDatabase) => Promise<T>,
  fallback: T
): Promise<T> {
  const opened = await openOfflineDb();

  if (!opened.ok) {
    return fallback;
  }

  try {
    return await run(opened.value);
  } finally {
    opened.value.close();
  }
}

/**
 * Makes an outbound sale identity durable BEFORE its request is dispatched.
 *
 * THE ORDERING IS THE ENTIRE POINT, and it is worth being blunt about why it is
 * this way round rather than the obvious one. Writing the record only after a
 * failure is observed sounds sufficient and is not: between `await rpc(...)`
 * starting and its rejection being handled, the process can die — a force-stop,
 * an OOM kill, a lid closing on a laptop. The request is already on the wire at
 * that point, so the server may commit it, while the device has never written
 * the key. That is precisely the gap this function closes: after it returns ok,
 * the key exists on disk and no amount of process death can lose it.
 *
 * The cost is a record that outlives requests which turn out fine. That is
 * cheap — one small row, deleted the moment a receipt arrives — and it fails in
 * the safe direction: a spurious record blocks a changed sale until it is
 * resolved, whereas a missing one duplicates a real one.
 *
 * Returns false when the write did not land. The caller MUST NOT dispatch in
 * that case; see PosRuntime, which refuses the sale rather than taking money it
 * could not protect.
 */
export async function armUncertainSale(input: {
  sale: UncertainSale;
  identity: UncertainSaleIdentity;
  dispatchedAt: string;
}): Promise<boolean> {
  const record = buildUncertainSaleRecord(input);

  // Validated with the same reader that guards every load: a record that could
  // not be read back is one that could never resolve anything.
  if (!readUncertainSaleRecord(record).ok) {
    return false;
  }

  return withDb(async (db) => {
    const written = await writeUncertainSaleRecordRaw(db, record);

    return written.ok;
  }, false);
}

export type UncertainSaleState =
  /** Nothing outstanding. Ordinary checkout. */
  | { status: "none" }
  /** An outstanding request belonging to the session now running. */
  | { status: "outstanding"; sale: UncertainSale; record: PersistedUncertainSale }
  /**
   * Something is stored that this session cannot use: another pairing's record,
   * or one that no longer reads back. Never applied to this session's checkout
   * and NEVER deleted — it still blocks a destructive reset.
   */
  | { status: "unusable"; reason: "identity_mismatch" | "unreadable" };

/**
 * Reads the outstanding request, if any, for the session now running.
 *
 * STORAGE BEING UNAVAILABLE READS AS "none", deliberately. A device with no
 * IndexedDB cannot have armed anything in the first place — PosRuntime refuses
 * to dispatch when arming fails — so there is nothing to be missed, and
 * blocking every till whose storage is momentarily unavailable would invent an
 * outage rather than prevent one.
 */
export async function readUncertainSale(
  identity: UncertainSaleIdentity
): Promise<UncertainSaleState> {
  return withDb<UncertainSaleState>(async (db) => {
    const raw = await readUncertainSaleRecordRaw(db);

    if (!raw.ok) return { status: "none" };

    const parsed = readUncertainSaleRecord(raw.value);

    if (!parsed.ok) {
      // "missing" is the ordinary empty case. Anything else means SOMETHING is
      // there that cannot be understood, which is not the same as nothing.
      return parsed.reason === "missing"
        ? { status: "none" }
        : { status: "unusable", reason: "unreadable" };
    }

    if (!ownsUncertainSale(parsed.record, identity)) {
      return { status: "unusable", reason: "identity_mismatch" };
    }

    return {
      status: "outstanding",
      sale: toUncertainSale(parsed.record),
      record: parsed.record,
    };
  }, { status: "none" });
}

/**
 * Clears the record after a POSITIVE resolution, and only then.
 *
 * The caller must already hold a server receipt, or a durable queue record that
 * will obtain one. A rejection is not a resolution: complete_sale_v4 authorizes
 * and locks BEFORE it looks the idempotency key up, so a refusal can arrive
 * without the key ever having been consulted and proves nothing about whether
 * the original request committed.
 */
export async function resolveUncertainSale(): Promise<boolean> {
  return withDb(async (db) => {
    const deleted = await deleteUncertainSaleRecordRaw(db);

    return deleted.ok;
  }, false);
}

/** True when anything at all is stored — usable or not. Governs reset safety. */
export async function hasUncertainSaleEvidence(): Promise<boolean> {
  return withDb(async (db) => {
    const raw = await readUncertainSaleRecordRaw(db);

    return raw.ok && raw.value !== null;
  }, false);
}

/**
 * Feature 24.5F — clears a marker the sale queue has already taken over.
 *
 * THE CRASH WINDOW THIS CLOSES. An offline enqueue and the marker delete are two
 * writes. If the process dies between them, the sale is durably queued under its
 * key and the marker is still on disk. Nothing is lost and nothing duplicates —
 * the queue record carries the same saleRequestId, so complete_sale_v4 still
 * creates or replays exactly one order — but the stale marker keeps blocking
 * changed sales and blocking reset over a sale that is already safe.
 *
 * WHY RECONCILIATION RATHER THAN ONE TRANSACTION, which was the other option and
 * looks tidier. IndexedDB can span both stores in a single readwrite
 * transaction, so it is technically available. It is the wrong trade here: the
 * enqueue is the single most safety-critical write in the feature, and folding a
 * cache delete into its transaction means a failure of the DELETE aborts the
 * INSERT. That converts a harmless stale marker into a refused sale — trading a
 * cosmetic problem for a lost one, in the direction that matters most.
 *
 * MATCHED ON THE EXACT KEY, never on "the queue is non-empty". A marker is only
 * released when a queue record claims the very saleRequestId it is protecting;
 * an unrelated queued sale proves nothing about this one.
 */
export async function reconcileUncertainSaleWithQueue(): Promise<boolean> {
  const raw = await withDb(
    async (db) => readUncertainSaleRecordRaw(db),
    { ok: false as const, reason: "unavailable" as const }
  );

  if (!raw.ok || raw.value === null) {
    return false;
  }

  const parsed = readUncertainSaleRecord(raw.value);

  // An unreadable marker is left exactly where it is: there is no key to match
  // it against, and it is still evidence that something happened.
  if (!parsed.ok) {
    return false;
  }

  const queued = await getSaleByRequestId(parsed.record.saleRequestId);

  if (!queued.ok) {
    return false;
  }

  // The queue owns this identity durably now. The marker has nothing left to
  // protect, and only this one is released.
  return resolveUncertainSale();
}
