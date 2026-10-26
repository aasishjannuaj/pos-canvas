// Correction C5 — ATOMIC storage for the owner's pending stock actions and their
// protected quarantine, in IndexedDB.
//
// WHY. C1–C4 kept these records in localStorage, where "read, compare, remove"
// is three separate calls: another tab could write replacement bytes after the
// final read and before the removal, and the removal would delete them. Here
// every conditional removal and every archive creation is ONE readwrite
// transaction over the stores it touches. IndexedDB runs overlapping readwrite
// transactions one at a time, across all tabs of the origin, so nothing can
// land between the check and the removal: a concurrent write runs entirely
// before (the check sees it and refuses) or entirely after (it survives).
//
// The record formats, keys, classification and quarantine rules are C1–C4's
// (lib/inventoryPending.ts), unchanged:
//   * settle      — delete a pending key only while it holds EXACTLY the bytes
//                   of the entry being settled.
//   * quarantine  — in one transaction: the pending bytes still equal what the
//                   owner reviewed; the archive is ADDED (add() never
//                   overwrites; an existing archive is reused only if it holds
//                   the same bytes); then the pending key is deleted. Abort →
//                   nothing changed.
//   * completion  — an archive left with its original still pending (only
//                   possible for records that arrived from localStorage) is
//                   finished in one transaction, same bytes only.
//
// MIGRATION from localStorage is per key, idempotent and recorded: in one
// transaction the bytes are added (never overwriting different bytes — those
// are kept as a separate unresolved copy) and a migration record notes exactly
// which bytes were taken. localStorage originals are NEVER removed: it is the
// one store where check-then-remove cannot be made atomic, so removing them
// could itself destroy evidence an older tab wrote meanwhile. A migration
// record stops already-migrated bytes from being re-imported (so a settled or
// quarantined action is never resurrected); bytes that differ are migrated as
// new evidence.
//
// Every function resolves (never throws). Product code never sets the test hooks.
import {
  PENDING_STORAGE_PREFIX,
  QUARANTINE_ACKNOWLEDGEMENT,
  QUARANTINE_PREFIX,
  entryKey,
  isPending,
  isQuarantineRecord,
  quarantineKey,
  requestReferenceOf,
} from "@/lib/inventoryPending";
import type {
  BeginResult,
  KeyValueStorage,
  PendingInventoryAction,
  QuarantineRecord,
  QuarantineResult,
  QuarantineView,
} from "@/lib/inventoryPending";

export const PENDING_DB_NAME = "pos-canvas-inventory-pending";
const PENDING = "pending";
const QUARANTINE = "quarantine";
const MIGRATION = "migration";
// C6 — references already settled or quarantined in this business ("k:<key>",
// "r:<project>:<requestId>"). Written in the SAME transaction as the settlement
// or quarantine; consulted by every intake from legacy storage so a handled
// reference can only ever come back as a review copy, never as active work.
const HANDLED = "handled";
// C7 — a monotonic sequence ("seq"), advanced inside each migration transaction:
// history order must not depend on wall clocks (adversarial X1: skewed clocks).
const META = "meta";
const DB_VERSION = 3;

type RawRow = { key: string; raw: string };
type MigrationRow = { key: string; lsKey?: string; raw: string; migratedAt: string; outcome: string; seq?: number };
type ReviewRow = RawRow & { sourceKey: string; why: "conflict" | "after_handled" };
type HandledRow = { key: string; kind: "settled" | "quarantined"; raw: string; at: string };
/** C7 — an active row remembers which migration record created it, and when (absent: C5 rows and new actions). */
type ActiveRow = RawRow & { importedVia?: string; importedAt?: string; importedSeq?: number };

export type StoreRead =
  | { status: "ok"; entries: PendingInventoryAction[] }
  | { status: "unresolved"; reason: "storage_unavailable" | "unreadable_record" | "history_uncertain"; keys: string[]; raws: Record<string, string> };

// ---------------------------------------------------------------------------
// Opening, and the test seams
// ---------------------------------------------------------------------------
let factoryOverride: IDBFactory | null | undefined;

/** Test seam: an IDBFactory (fake-indexeddb), null for "unavailable", undefined for the real one. */
export function setPendingStoreFactoryForTests(factory: IDBFactory | null | undefined): void {
  factoryOverride = factory;
}

export type StoreTestHooks = {
  /** Called synchronously INSIDE a conditional transaction, after its read and before its write/delete. */
  afterConditionalRead?: (operation: "settle" | "quarantine" | "complete" | "migrate", key: string) => void;
  /** Called between per-key migration transactions (may throw to simulate an interruption). */
  betweenMigrationKeys?: (key: string) => void;
};
let hooks: StoreTestHooks = {};
export function setPendingStoreTestHooks(next: StoreTestHooks): void {
  hooks = next;
}

function factory(): IDBFactory | null {
  if (factoryOverride !== undefined) return factoryOverride;
  try {
    return typeof indexedDB === "undefined" ? null : indexedDB;
  } catch {
    return null;
  }
}

export function openPendingStore(): Promise<IDBDatabase | null> {
  const f = factory();
  if (f === null) return Promise.resolve(null);
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = f.open(PENDING_DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of [PENDING, QUARANTINE, MIGRATION, HANDLED, META]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function tx(db: IDBDatabase, stores: string[], mode: IDBTransactionMode): IDBTransaction {
  return mode === "readwrite"
    ? db.transaction(stores, mode, { durability: "strict" } as IDBTransactionOptions)
    : db.transaction(stores, mode);
}

/** Runs `body` in one transaction; resolves with its value on COMPLETE, or null on abort/error. */
function run<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, body: (t: IDBTransaction, set: (v: T) => void) => void): Promise<T | null> {
  return new Promise((resolve) => {
    let value: T | null = null;
    let t: IDBTransaction;
    try {
      t = tx(db, stores, mode);
    } catch {
      resolve(null);
      return;
    }
    t.oncomplete = () => resolve(value);
    t.onabort = () => resolve(null);
    t.onerror = () => undefined; // onabort follows
    try {
      body(t, (v) => {
        value = v;
      });
    } catch {
      try {
        t.abort();
      } catch {
        // already finishing
      }
    }
  });
}

function rangeFor(prefix: string): IDBKeyRange {
  return IDBKeyRange.bound(prefix, `${prefix}￿`);
}

function readRange(db: IDBDatabase, store: string, prefix: string): Promise<RawRow[] | null> {
  return run<RawRow[]>(db, [store], "readonly", (t, set) => {
    const req = t.objectStore(store).getAll(rangeFor(prefix));
    req.onsuccess = () => set(req.result as RawRow[]);
  });
}

function readOne(db: IDBDatabase, store: string, key: string): Promise<string | null | undefined> {
  return run<string | null>(db, [store], "readonly", (t, set) => {
    const req = t.objectStore(store).get(key);
    req.onsuccess = () => set(req.result ? (req.result as RawRow).raw : null);
  }).then((v) => (v === null ? null : v));
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Migration from localStorage (C1–C4 format)
// ---------------------------------------------------------------------------
/**
 * C6 — ONE intake rule for every byte string arriving from legacy storage
 * (a localStorage key, or a member of a Batch B list), run inside the caller's
 * transaction:
 *   * its reference was already SETTLED or QUARANTINED here (handled record,
 *     or an archive of that key)        → review copy, never active work;
 *   * nothing lives under the key        → stored under the key (readable
 *                                          entries become recoverable work);
 *   * the same bytes live there          → nothing to do;
 *   * different bytes live there         → review copy beside them.
 * Review copies are unresolved by construction (their key is not the entry's
 * key) and are never overwritten.
 */
function intake(
  t: IDBTransaction,
  projectId: string,
  sourceKey: string,
  bytes: string,
  then: (outcome: string) => void,
  origin: { via: string; at: string; seq: number } | null
): void {
  let ref: string | null = null;
  try {
    const v: unknown = JSON.parse(bytes);
    if (typeof v === "object" && v !== null && typeof (v as { requestId?: unknown }).requestId === "string") ref = (v as { requestId: string }).requestId;
  } catch {
    ref = null;
  }
  const handled = t.objectStore(HANDLED);
  const byKey = handled.get(`k:${sourceKey}`);
  byKey.onsuccess = () => {
    const byRef = ref === null ? null : handled.get(`r:${projectId}:${ref}`);
    const afterRef = () => {
      const archived = t.objectStore(QUARANTINE).get(quarantineKey(projectId, sourceKey));
      archived.onsuccess = () => {
        const existing = t.objectStore(PENDING).get(sourceKey);
        existing.onsuccess = () => {
          hooks.afterConditionalRead?.("migrate", sourceKey);
          const wasHandled = byKey.result !== undefined || (byRef !== null && byRef.result !== undefined) || archived.result !== undefined;
          const row = existing.result as RawRow | undefined;
          if (wasHandled) {
            addReviewCopy(t, projectId, sourceKey, bytes, "after_handled");
            then("review_after_handled");
          } else if (row === undefined) {
            t.objectStore(PENDING).add({ key: sourceKey, raw: bytes, ...(origin ? { importedVia: origin.via, importedAt: origin.at, importedSeq: origin.seq } : {}) } satisfies ActiveRow);
            then("added");
          } else if (row.raw === bytes) {
            then("already_present");
          } else {
            addReviewCopy(t, projectId, sourceKey, bytes, "conflict");
            then("review_conflict");
          }
        };
      };
    };
    if (byRef === null) afterRef();
    else byRef.onsuccess = afterRef;
  };
}

function addReviewCopy(t: IDBTransaction, projectId: string, sourceKey: string, bytes: string, why: ReviewRow["why"], n = 0): void {
  const base = `${PENDING_STORAGE_PREFIX}${projectId}:review-${fnv(sourceKey + "\u0000" + bytes)}`;
  const copyKey = n === 0 ? base : `${base}-${n}`;
  const probe = t.objectStore(PENDING).get(copyKey);
  probe.onsuccess = () => {
    const there = probe.result as RawRow | undefined;
    if (there === undefined) t.objectStore(PENDING).add({ key: copyKey, raw: bytes, sourceKey, why } satisfies ReviewRow);
    else if (there.raw !== bytes) addReviewCopy(t, projectId, sourceKey, bytes, why, n + 1); // never overwrite anything
  };
}

/** C6 — the migration record for one (key, exact bytes): every distinct byte string is taken ONCE, ever. */
function migrationRowKey(lsKey: string, bytes: string, n = 0): string {
  return `${lsKey}\u0000${fnv(bytes)}${n === 0 ? "" : `#${n}`}`;
}

/**
 * Migrates this business's localStorage pending and quarantine keys.
 * true = every key read and recorded in IndexedDB. C6: no legacy storage
 * (null — absent or inaccessible) is NOT proof that nothing is there → false.
 */
export async function migrateFromLocalStorage(db: IDBDatabase, ls: KeyValueStorage | null, projectId: string, now: () => string = () => new Date().toISOString()): Promise<boolean> {
  if (ls === null) return false;
  let keys: string[];
  try {
    keys = [];
    for (let i = 0; i < ls.length; i += 1) {
      const k = ls.key(i);
      if (k === null) continue;
      if (k === `${PENDING_STORAGE_PREFIX}${projectId}` || k.startsWith(`${PENDING_STORAGE_PREFIX}${projectId}:`) ||
          k.startsWith(`${QUARANTINE_PREFIX}${projectId}:`)) keys.push(k);
    }
  } catch {
    return false;
  }
  let allOk = true;
  // C7: legacy ARCHIVES first, so a pending record's quarantine history is already
  // preserved before the record itself is taken (the final audit enforces it anyway).
  const isArchive = (k: string) => (k.startsWith(QUARANTINE_PREFIX) ? 0 : 1);
  for (const lsKey of keys.sort((a, b) => isArchive(a) - isArchive(b) || (a < b ? -1 : a > b ? 1 : 0))) {
    hooks.betweenMigrationKeys?.(lsKey);
    let raw: string | null;
    try {
      raw = ls.getItem(lsKey);
    } catch {
      allOk = false;
      continue;
    }
    if (raw === null) continue;
    const bytes = raw;
    const isQuarantine = lsKey.startsWith(QUARANTINE_PREFIX);
    const done = await run<string>(db, [PENDING, QUARANTINE, MIGRATION, HANDLED, META], "readwrite", (t, set) => {
      const migrations = t.objectStore(MIGRATION);
      let seq = 0;
      const counter = t.objectStore(META).get("seq");
      counter.onsuccess = () => {
        seq = ((counter.result as { value?: number } | undefined)?.value ?? 0) + 1;
        t.objectStore(META).put({ key: "seq", value: seq });
        seen(0);
      };
      const seen = (n: number) => {
        const rk = migrationRowKey(lsKey, bytes, n);
        const prior = migrations.get(rk);
        prior.onsuccess = () => {
          const row = prior.result as MigrationRow | undefined;
          if (row !== undefined && row.raw === bytes) return set("skip"); // these exact bytes were taken before
          if (row !== undefined) return seen(n + 1); // hash collision: probe on, never overwrite
          // C5 kept one record per key (the last bytes taken): honour it too.
          const v1 = migrations.get(lsKey);
          v1.onsuccess = () => {
            const old = v1.result as MigrationRow | undefined;
            const record = (outcome: string) => {
              migrations.add({ key: rk, lsKey, raw: bytes, migratedAt: now(), outcome, seq } satisfies MigrationRow);
              set(outcome);
            };
            if (old !== undefined && old.raw === bytes) return record("skip_c5_record");
            if (isQuarantine) {
              const q = t.objectStore(QUARANTINE).get(lsKey);
              q.onsuccess = () => {
                hooks.afterConditionalRead?.("migrate", lsKey);
                const there = q.result as RawRow | undefined;
                if (there === undefined) {
                  t.objectStore(QUARANTINE).add({ key: lsKey, raw: bytes } satisfies RawRow);
                  record("added");
                } else if (there.raw === bytes) {
                  record("already_present");
                } else {
                  addReviewCopy(t, projectId, lsKey, bytes, "conflict"); // an archive is never overwritten
                  record("review_conflict");
                }
              };
            } else {
              intake(t, projectId, lsKey, bytes, record, { via: rk, at: now(), seq });
            }
          };
        };
      };
    });
    if (done === null) allOk = false;
  }
  return allOk;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// C7 — the dispatchable set is AUDITED against all preserved history
// ---------------------------------------------------------------------------
export type History = { handled: HandledRow[]; archives: RawRow[]; migrations: MigrationRow[] };

/** Every request id a byte string names: an entry, a Batch B list, or (damaged) any "requestId" it contains. */
function idsIn(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    if (Array.isArray(v)) return v.flatMap((m) => (m && typeof m === "object" && typeof (m as { requestId?: unknown }).requestId === "string" ? [(m as { requestId: string }).requestId] : []));
    if (v && typeof v === "object" && typeof (v as { requestId?: unknown }).requestId === "string") return [(v as { requestId: string }).requestId];
  } catch {
    // damaged: fall through to the pattern
  }
  return [...raw.matchAll(/"requestId"\s*:\s*"([^"]{1,100})"/g)].map((m) => m[1]);
}

/**
 * Why an active, readable row may NOT be dispatched — or null if no preserved
 * history touches it. History that marks a request as handled:
 *   * a handled record of its key or reference (C6+);
 *   * any archive whose original key, source key, request reference, or the
 *     request ids inside its archived bytes name it;
 *   * any migration record naming its key or request that is OLDER than this
 *     row's own import and is not the import that created it — e.g. a C5
 *     settlement, which left a migration record but no handled record.
 */
export function historyReason(h: History, projectId: string, row: ActiveRow): string | null {
  const ids = idsIn(row.raw);
  const ref = ids.length === 1 ? ids[0] : null;
  if (h.handled.some((x) => x.key === `k:${row.key}` || (ref !== null && x.key === `r:${projectId}:${ref}`))) return "handled";
  for (const a of h.archives) {
    let rec: unknown = null;
    try {
      rec = JSON.parse(a.raw);
    } catch {
      rec = null;
    }
    const r = (rec ?? {}) as Partial<QuarantineRecord>;
    const names = [r.originalKey, r.sourceKey].includes(row.key) ||
      (ref !== null && (r.requestReference === ref || (typeof r.rawValue === "string" && idsIn(r.rawValue).includes(ref)) || idsIn(a.raw).includes(ref)));
    if (names) return "quarantined";
  }
  const pendingPrefix = `${PENDING_STORAGE_PREFIX}${projectId}`;
  for (const m of h.migrations) {
    const lsKey = m.lsKey ?? m.key; // C5 records were keyed by the localStorage key itself
    if (!(lsKey === pendingPrefix || lsKey.startsWith(`${pendingPrefix}:`))) continue;
    if (row.importedVia !== undefined && m.key === row.importedVia) continue; // the import that created this row
    if (lsKey === row.key && m.raw === row.raw) continue; // the same bytes under the same key: that same import
    // Only EARLIER history, by sequence — never by wall clock. A record without a
    // sequence predates this version, so it is earlier than any sequenced import.
    if (row.importedSeq !== undefined && m.seq !== undefined && !(m.seq < row.importedSeq)) continue;
    if (lsKey === row.key || (ref !== null && idsIn(m.raw).includes(ref))) return "earlier_migration";
  }
  return null;
}

function loadHistory(t: IDBTransaction, projectId: string, then: (h: History) => void): void {
  const handled = t.objectStore(HANDLED).getAll();
  handled.onsuccess = () => {
    const archives = t.objectStore(QUARANTINE).getAll(rangeFor(`${QUARANTINE_PREFIX}${projectId}:`));
    archives.onsuccess = () => {
      const migrations = t.objectStore(MIGRATION).getAll();
      migrations.onsuccess = () =>
        then({ handled: handled.result as HandledRow[], archives: archives.result as RawRow[], migrations: migrations.result as MigrationRow[] });
    };
  };
}

async function readHistory(db: IDBDatabase, projectId: string): Promise<History | null> {
  return run<History>(db, [HANDLED, QUARANTINE, MIGRATION], "readonly", (t, set) => loadHistory(t, projectId, set));
}

function classify(projectId: string, rows: ActiveRow[], history: History | null = null): StoreRead {
  const entries: PendingInventoryAction[] = [];
  const unreadable: string[] = [];
  const uncertain: string[] = [];
  const raws: Record<string, string> = {};
  for (const row of rows) {
    try {
      const v: unknown = JSON.parse(row.raw);
      if (isPending(v, projectId) && row.key === entryKey(projectId, v.requestId)) {
        if (history !== null && historyReason(history, projectId, row) !== null) {
          uncertain.push(row.key); // C7: readable, but its history says it may have been handled
          raws[row.key] = row.raw;
          continue;
        }
        entries.push(v);
        continue;
      }
    } catch {
      // unreadable
    }
    unreadable.push(row.key);
    raws[row.key] = row.raw;
  }
  if (unreadable.length > 0 || uncertain.length > 0) {
    return { status: "unresolved", reason: unreadable.length > 0 ? "unreadable_record" : "history_uncertain", keys: [...unreadable, ...uncertain].sort(), raws };
  }
  entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.requestId.localeCompare(b.requestId));
  return { status: "ok", entries };
}

/**
 * Expands a migrated Batch B list into per-entry keys — one transaction, same
 * list bytes only. C6: every member goes through the same intake rule, so a
 * settled or quarantined member comes back only as a review copy and a
 * conflicting member is kept beside the active one. The list's exact bytes stay
 * in localStorage and in its migration record.
 */
async function expandLegacyList(db: IDBDatabase, projectId: string): Promise<void> {
  const listKey = `${PENDING_STORAGE_PREFIX}${projectId}`;
  const raw = await readOne(db, PENDING, listKey);
  if (raw === null || raw === undefined) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return; // stays unresolved for the owner
  }
  if (!Array.isArray(parsed) || !parsed.every((v) => isPending(v, projectId))) return;
  const members = parsed as PendingInventoryAction[];
  await run<boolean>(db, [PENDING, QUARANTINE, HANDLED], "readwrite", (t, set) => {
    const again = t.objectStore(PENDING).get(listKey);
    again.onsuccess = () => {
      if (!again.result || (again.result as RawRow).raw !== raw) return;
      const listRow = again.result as ActiveRow;
      const origin = listRow.importedVia !== undefined && listRow.importedSeq !== undefined
        ? { via: listRow.importedVia, at: listRow.importedAt ?? "", seq: listRow.importedSeq }
        : null;
      const next = (i: number) => {
        if (i === members.length) {
          t.objectStore(PENDING).delete(listKey);
          set(true);
          return;
        }
        intake(t, projectId, entryKey(projectId, members[i].requestId), JSON.stringify(members[i]), () => next(i + 1), origin);
      };
      next(0);
    };
  });
}

/** C4 completion: an archive whose original is still pending with the same bytes is finished atomically. */
async function completeInterrupted(db: IDBDatabase, projectId: string, rows: RawRow[]): Promise<void> {
  for (const row of rows) {
    await run<boolean>(db, [PENDING, QUARANTINE], "readwrite", (t, set) => {
      const archived = t.objectStore(QUARANTINE).get(quarantineKey(projectId, row.key));
      archived.onsuccess = () => {
        const a = archived.result as RawRow | undefined;
        if (!a) return;
        let record: unknown;
        try {
          record = JSON.parse(a.raw);
        } catch {
          return;
        }
        if (!isQuarantineRecord(record) || record.originalKey !== row.key) return;
        const current = t.objectStore(PENDING).get(row.key);
        current.onsuccess = () => {
          hooks.afterConditionalRead?.("complete", row.key);
          const c = current.result as RawRow | undefined;
          if (c && c.raw === (record as QuarantineRecord).rawValue) {
            t.objectStore(PENDING).delete(row.key);
            set(true);
          }
        };
      };
    });
  }
}

export async function readPendingStore(projectId: string, ls: KeyValueStorage | null): Promise<StoreRead> {
  // C6 — migration readiness: legacy storage that cannot be read may still hold
  // unsettled work, so it is not proof of an empty queue. Refuse, keep uncertainty.
  if (ls === null) return { status: "unresolved", reason: "storage_unavailable", keys: [], raws: {} };
  const db = await openPendingStore();
  if (db === null) return { status: "unresolved", reason: "storage_unavailable", keys: [], raws: {} };
  try {
    if (!(await migrateFromLocalStorage(db, ls, projectId))) {
      return { status: "unresolved", reason: "storage_unavailable", keys: [], raws: {} };
    }
    await expandLegacyList(db, projectId);
    const prefix = `${PENDING_STORAGE_PREFIX}${projectId}`;
    let rows = (await readRange(db, PENDING, prefix))?.filter((r) => r.key === prefix || r.key.startsWith(`${prefix}:`));
    if (rows === undefined) return { status: "unresolved", reason: "storage_unavailable", keys: [], raws: {} };
    const first = classify(projectId, rows);
    if (first.status === "unresolved") {
      await completeInterrupted(db, projectId, rows.filter((r) => first.keys.includes(r.key)));
      rows = (await readRange(db, PENDING, prefix))?.filter((r) => r.key === prefix || r.key.startsWith(`${prefix}:`));
      if (rows === undefined) return { status: "unresolved", reason: "storage_unavailable", keys: [], raws: {} };
    }
    // C7: the FINAL dispatchable set is audited against all preserved history.
    const history = await readHistory(db, projectId);
    if (history === null) return { status: "unresolved", reason: "storage_unavailable", keys: [], raws: {} };
    return classify(projectId, rows, history);
  } finally {
    db.close();
  }
}

export async function readQuarantineStore(projectId: string): Promise<QuarantineView[]> {
  const db = await openPendingStore();
  if (db === null) return [];
  try {
    const rows = (await readRange(db, QUARANTINE, `${QUARANTINE_PREFIX}${projectId}:`)) ?? [];
    const out: QuarantineView[] = rows.map((r) => {
      try {
        const v: unknown = JSON.parse(r.raw);
        return isQuarantineRecord(v) ? { kind: "record" as const, key: r.key, record: v } : { kind: "damaged" as const, key: r.key, raw: r.raw };
      } catch {
        return { kind: "damaged" as const, key: r.key, raw: r.raw };
      }
    });
    return out.sort((a, b) =>
      a.kind === "record" && b.kind === "record" ? a.record.quarantinedAt.localeCompare(b.record.quarantinedAt) : a.key.localeCompare(b.key));
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Begin / settle
// ---------------------------------------------------------------------------
export async function beginPendingStore(
  submission: Omit<PendingInventoryAction, "requestId" | "createdAt">,
  mint: () => string,
  ls: KeyValueStorage | null,
  now: () => string = () => new Date().toISOString()
): Promise<BeginResult> {
  const read = await readPendingStore(submission.projectId, ls);
  if (read.status === "unresolved") return { ok: false, reason: read.reason };
  const existing = read.entries.find((e) => e.action === submission.action && e.itemId === submission.itemId && e.input === submission.input);
  if (existing) return { ok: true, entry: existing, reused: true };

  const entry: PendingInventoryAction = { ...submission, requestId: mint(), createdAt: now() };
  const key = entryKey(entry.projectId, entry.requestId);
  const text = JSON.stringify(entry);
  const db = await openPendingStore();
  if (db === null) return { ok: false, reason: "storage_unavailable" };
  try {
    const written = await run<boolean>(db, [PENDING], "readwrite", (t, set) => {
      t.objectStore(PENDING).add({ key, raw: text } satisfies RawRow); // add(): never overwrites
      set(true);
    });
    if (written !== true) return { ok: false, reason: "persist_failed" };
    return (await readOne(db, PENDING, key)) === text ? { ok: true, entry, reused: false } : { ok: false, reason: "persist_failed" };
  } finally {
    db.close();
  }
}

export type SettleResult = "settled" | "not_matching" | "absent" | "failed";

/** C6 — record that a reference was handled, inside the caller's transaction (add-if-absent: never overwrites). */
function markHandled(t: IDBTransaction, keys: string[], kind: HandledRow["kind"], raw: string, at: string): void {
  const store = t.objectStore(HANDLED);
  for (const key of keys) {
    const probe = store.get(key);
    probe.onsuccess = () => {
      if (probe.result === undefined) store.add({ key, kind, raw, at } satisfies HandledRow);
    };
  }
}

/** Delete the entry's key only while it holds EXACTLY the entry's bytes — atomically. */
export async function settlePendingStore(entry: PendingInventoryAction): Promise<SettleResult> {
  const db = await openPendingStore();
  if (db === null) return "failed";
  const key = entryKey(entry.projectId, entry.requestId);
  const text = JSON.stringify(entry);
  try {
    const r = await run<SettleResult>(db, [PENDING, HANDLED], "readwrite", (t, set) => {
      const s = t.objectStore(PENDING);
      const req = s.get(key);
      req.onsuccess = () => {
        hooks.afterConditionalRead?.("settle", key);
        const row = req.result as RawRow | undefined;
        if (row === undefined) return set("absent");
        if (row.raw !== text) return set("not_matching");
        s.delete(key);
        markHandled(t, [`k:${key}`, `r:${entry.projectId}:${entry.requestId}`], "settled", text, new Date().toISOString());
        set("settled");
      };
    });
    return r ?? "failed";
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Quarantine (one transaction: check, archive, remove)
// ---------------------------------------------------------------------------
export async function quarantineStore(
  projectId: string,
  input: { key: string; expectedRaw: string; actor: { userId: string | null; label: string }; reason: string; acknowledged: boolean },
  now: () => string = () => new Date().toISOString()
): Promise<QuarantineResult> {
  const activePrefix = `${PENDING_STORAGE_PREFIX}${projectId}`;
  if (!input.acknowledged || input.reason.trim() === "" || !(input.key === activePrefix || input.key.startsWith(`${activePrefix}:`))) {
    return { status: "invalid" };
  }
  const db = await openPendingStore();
  if (db === null) return { status: "quarantine_failed" };
  const qKey = quarantineKey(projectId, input.key);
  const fresh: QuarantineRecord = {
    version: 1,
    projectId,
    originalKey: input.key,
    rawValue: input.expectedRaw,
    requestReference: requestReferenceOf(projectId, input.key, input.expectedRaw),
    quarantinedAt: now(),
    actor: input.actor,
    reason: input.reason.trim(),
    serverOutcome: "unknown",
    acknowledgement: QUARANTINE_ACKNOWLEDGEMENT,
  };
  try {
    const outcome = await run<QuarantineResult>(db, [PENDING, QUARANTINE, HANDLED, MIGRATION], "readwrite", (t, set) => {
      const pending = t.objectStore(PENDING);
      const quarantine = t.objectStore(QUARANTINE);
      const cur = pending.get(input.key);
      cur.onsuccess = () => {
        hooks.afterConditionalRead?.("quarantine", input.key);
        const row = cur.result as RawRow | undefined;
        if (row === undefined) return set({ status: "gone" });
        if (row.raw !== input.expectedRaw) return set({ status: "changed" });
        let readable = false;
        try {
          const parsed: unknown = JSON.parse(row.raw);
          readable = isPending(parsed, projectId) && input.key === entryKey(projectId, parsed.requestId);
        } catch {
          // still unreadable — as expected
        }
        // C7: a readable record may be quarantined only when preserved history makes it
        // uncertain — judged here, inside this transaction, by the same audit reads use.
        const proceed = (go: () => void) => {
          if (!readable) return go();
          loadHistory(t, projectId, (h) => (historyReason(h, projectId, row as ActiveRow) !== null ? go() : set({ status: "repaired" })));
        };
        proceed(() => {
        const arch = quarantine.get(qKey);
        arch.onsuccess = () => {
          const existing = arch.result as RawRow | undefined;
          // C6: a review copy remembers which legacy key it came from.
          const sourceKey = (row as Partial<ReviewRow>).sourceKey;
          let record: QuarantineRecord = typeof sourceKey === "string" ? { ...fresh, sourceKey } : fresh;
          if (existing !== undefined) {
            let prior: unknown = null;
            try {
              prior = JSON.parse(existing.raw);
            } catch {
              prior = null;
            }
            if (!isQuarantineRecord(prior) || prior.rawValue !== row.raw) {
              // A different archive occupies the key: never overwrite it; change nothing.
              set({ status: "quarantine_failed" });
              t.abort();
              return;
            }
            record = prior; // the same bytes were archived before: reuse, never rewrite
          } else {
            quarantine.add({ key: qKey, raw: JSON.stringify(record) } satisfies RawRow); // add(): never overwrites
          }
          pending.delete(input.key);
          // C6: the key — and the request reference, if any — are now handled: neither can come back as active work.
          markHandled(t, [`k:${input.key}`, ...(record.requestReference ? [`r:${projectId}:${record.requestReference}`] : [])],
            "quarantined", row.raw, record.quarantinedAt);
          set({ status: "quarantined", record });
        };
        });
      };
    });
    if (outcome === null) return { status: "quarantine_failed" }; // aborted: nothing changed, original kept
    return outcome;
  } finally {
    db.close();
  }
}
