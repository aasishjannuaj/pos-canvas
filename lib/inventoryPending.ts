// Batch B (Inventory corrections) — DURABLE request identity for the owner's
// stock actions. Correction C1 — persistence made strict.
//
// A "Received +N", "Counted = N" or tracking change is written here BEFORE it is
// dispatched, and removed only on a definitive answer. If the reply is lost and
// the page is reloaded (or the browser restarts), the editor finds the entry and
// re-sends it with the ORIGINAL business, payload and request id — the server
// replays the stored result instead of applying the action twice.
//
// C1 rules:
//   * NOTHING IS DISPATCHED UNLESS ITS IDENTITY IS SAFELY PERSISTED. beginPending
//     writes the entry, reads it back and compares; a denied, full or lying
//     storage returns ok:false and the caller sends nothing.
//   * UNREADABLE IS NOT EMPTY. Storage that cannot be read, or any pending record
//     that cannot be parsed, is "unresolved": the caller must not start new
//     actions until the owner has explicitly QUARANTINED the listed records.
//
// C4 — UNREADABLE RECORDS ARE NEVER DELETED. quarantineUnreadable copies the
// exact raw bytes, the original key and any request reference, with the owner's
// identity, the time, a reason and the server outcome "unknown", into a protected
// quarantine key; reads that copy back; re-reads the original; and only then
// removes the original from the ACTIVE pending area. Quarantined records are
// never read as pending, never submitted, never given a new request id and never
// marked resolved — checking the audit history does not prove an outcome. There
// is no code path that removes a quarantine record.
//   * ONE KEY PER ENTRY. Every pending action has its own key
//     (<prefix><projectId>:<requestId>), so two tabs never read-modify-write a
//     shared list and cannot overwrite each other's entries. The Batch B
//     single-list key (<prefix><projectId>) is migrated on read.
//
// C5 — STORAGE MOVED TO INDEXEDDB (lib/inventoryPendingStore.ts), where every
// conditional removal and archive creation is one transaction. This module now
// holds only the shared formats, keys and validators, and the localStorage
// accessor used as the MIGRATION SOURCE. The localStorage read/compare/remove
// functions of C1–C4 were removed: they could not be made atomic.
import type { InventoryAction } from "@/lib/inventoryActions";

export type PendingInventoryAction = {
  requestId: string;
  projectId: string;
  action: InventoryAction;
  itemId: string;
  input: number | boolean;
  createdAt: string;
};

export type KeyValueStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
};

export const PENDING_STORAGE_PREFIX = "pos-canvas:inventory-pending:";

export const entryKey = (projectId: string, requestId: string) => `${PENDING_STORAGE_PREFIX}${projectId}:${requestId}`;

export type PendingRead =
  | { status: "ok"; entries: PendingInventoryAction[] }
  | { status: "unresolved"; reason: "storage_unavailable" | "unreadable_record"; keys: string[] };

export type BeginResult =
  | { ok: true; entry: PendingInventoryAction; reused: boolean }
  | { ok: false; reason: "storage_unavailable" | "unreadable_record" | "history_uncertain" | "persist_failed" };

export function isPending(value: unknown, projectId: string): value is PendingInventoryAction {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const inputOk = v.action === "tracking" ? typeof v.input === "boolean" : Number.isInteger(v.input);
  return (
    typeof v.requestId === "string" &&
    v.requestId !== "" &&
    v.projectId === projectId &&
    (v.action === "receive" || v.action === "count" || v.action === "tracking") &&
    typeof v.itemId === "string" &&
    v.itemId !== "" &&
    inputOk &&
    typeof v.createdAt === "string"
  );
}

// ---------------------------------------------------------------------------
// C4 — protected quarantine of unreadable pending records
// ---------------------------------------------------------------------------

export const QUARANTINE_PREFIX = "pos-canvas:inventory-quarantine:";

/** Deterministic: the same original key always archives to the same quarantine key. */
export const quarantineKey = (projectId: string, originalKey: string) =>
  `${QUARANTINE_PREFIX}${projectId}:${encodeURIComponent(originalKey)}`;

export type QuarantineRecord = {
  version: 1;
  projectId: string;
  /** The exact storage key the record was found under. */
  originalKey: string;
  /** The exact bytes found there, unmodified. */
  rawValue: string;
  /** The request id the key or the bytes refer to, if any can be read; null otherwise. */
  requestReference: string | null;
  quarantinedAt: string;
  actor: { userId: string | null; label: string };
  reason: string;
  /** Always "unknown": nothing on this device can prove what the server did. */
  serverOutcome: "unknown";
  acknowledgement: string;
  /** C6 — for a review copy: the legacy key its bytes were found under. */
  sourceKey?: string;
};

export type QuarantineView =
  | { kind: "record"; key: string; record: QuarantineRecord }
  | { kind: "damaged"; key: string; raw: string | null };

export type QuarantineResult =
  | { status: "quarantined"; record: QuarantineRecord }
  | { status: "gone" } // another tab already removed or archived it — nothing done
  | { status: "changed" } // the bytes are no longer the ones the owner reviewed — nothing done
  | { status: "repaired" } // it is now a readable pending entry — nothing done
  | { status: "quarantine_failed" } // the archive could not be proven — the original is kept
  | { status: "archived_original_kept" } // archived, but the original changed before removal — original kept
  | { status: "archived_removal_pending" } // archived and verified; removing the original failed — finished on next read
  | { status: "invalid" };

export const QUARANTINE_ACKNOWLEDGEMENT =
  "The server outcome of this stock change is unknown. Checking the inventory history does not prove it. " +
  "It will not be sent again and will not be recreated under a new request.";

export function requestReferenceOf(projectId: string, originalKey: string, raw: string): string | null {
  // C6: the bytes' own requestId comes first (a review copy's key is not a reference);
  // otherwise the key's suffix, unless it is a review/legacy copy key or the list key.
  const m = /"requestId"\s*:\s*"([^"]{1,100})"/.exec(raw);
  if (m) return m[1];
  const prefix = `${PENDING_STORAGE_PREFIX}${projectId}:`;
  if (!originalKey.startsWith(prefix) || originalKey.length === prefix.length) return null;
  const suffix = originalKey.slice(prefix.length);
  return /^(review|legacy)-/.test(suffix) ? null : suffix;
}

export function isQuarantineRecord(v: unknown): v is QuarantineRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return r.version === 1 && typeof r.projectId === "string" && typeof r.originalKey === "string" &&
    typeof r.rawValue === "string" && typeof r.quarantinedAt === "string" && typeof r.reason === "string" &&
    r.serverOutcome === "unknown" && typeof r.actor === "object" && r.actor !== null;
}

export function browserStorage(): KeyValueStorage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}
