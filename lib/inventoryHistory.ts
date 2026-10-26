// Batch B — the owner's inventory audit/history feed (inventory_history RPC).
//
// One list: owner actions (Received, Counted — including counts that changed
// nothing — and tracking switches), ledger rows (sales, opening stock, legacy
// restock/adjust), and deleted items. A ledger row written BY an action carries
// that action's request id and is folded into the action's line, so nothing is
// shown twice.
import { createClient } from "@/lib/supabase/client";

export type HistoryEntry =
  | { kind: "action"; at: string; requestId: string; action: "receive" | "count" | "tracking"; itemId: string;
      before: number | boolean | null; after: number | boolean | null; note: string | null; zeroChange: boolean; itemDeleted: boolean }
  | { kind: "ledger"; at: string; transactionType: string; itemId: string; itemName: string; before: number; after: number;
      change: number; actionRequestId: string | null; itemDeleted: boolean }
  | { kind: "deletion"; at: string; itemId: string; lastStock: unknown };

export function parseHistory(value: unknown): HistoryEntry[] | null {
  if (!Array.isArray(value)) return null;
  const out: HistoryEntry[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) return null;
    const e = raw as Record<string, unknown>;
    if (typeof e.at !== "string" || typeof e.itemId !== "string") return null;
    if (e.kind === "action" && (e.action === "receive" || e.action === "count" || e.action === "tracking")) {
      const result = (e.result ?? {}) as Record<string, unknown>;
      out.push({
        kind: "action", at: e.at, requestId: String(e.requestId ?? ""), action: e.action, itemId: e.itemId,
        before: (result.before ?? null) as number | boolean | null, after: (result.after ?? null) as number | boolean | null,
        note: typeof e.note === "string" ? e.note : null, zeroChange: e.zeroChange === true, itemDeleted: e.itemDeleted === true,
      });
    } else if (e.kind === "ledger" && Number.isInteger(e.before) && Number.isInteger(e.after)) {
      out.push({
        kind: "ledger", at: e.at, transactionType: String(e.transactionType ?? ""), itemId: e.itemId,
        itemName: typeof e.itemName === "string" ? e.itemName : e.itemId, before: e.before as number, after: e.after as number,
        change: Number(e.change ?? 0), actionRequestId: typeof e.actionRequestId === "string" ? e.actionRequestId : null,
        itemDeleted: e.itemDeleted === true,
      });
    } else if (e.kind === "deletion") {
      out.push({ kind: "deletion", at: e.at, itemId: e.itemId, lastStock: e.lastStock ?? null });
    } else {
      return null;
    }
  }
  return out;
}

/** Owner-readable lines; ledger rows already represented by an action are folded away. */
export function describeHistory(entries: HistoryEntry[], nameFor: (itemId: string) => string): { key: string; text: string; at: string }[] {
  const lines: { key: string; text: string; at: string }[] = [];
  for (const e of entries) {
    if (e.kind === "ledger" && e.actionRequestId !== null) continue;
    const deleted = e.kind !== "deletion" && e.itemDeleted ? " (deleted item)" : "";
    if (e.kind === "action") {
      const name = nameFor(e.itemId) + deleted;
      if (e.action === "tracking") {
        lines.push({ key: `a-${e.requestId}`, at: e.at, text: e.zeroChange
          ? `${name}: tracking already ${e.after ? "on" : "off"} (no change)`
          : `${name}: tracking turned ${e.after ? "on" : "off"}` });
      } else if (e.action === "count") {
        lines.push({ key: `a-${e.requestId}`, at: e.at, text: e.zeroChange
          ? `${name}: counted ${String(e.after)} (no change)`
          : `${name}: counted ${String(e.after)} (was ${String(e.before)})` });
      } else {
        lines.push({ key: `a-${e.requestId}`, at: e.at, text: `${name}: received ${Number(e.after) - Number(e.before)} (${String(e.before)} → ${String(e.after)})` });
      }
    } else if (e.kind === "ledger") {
      const label = e.transactionType === "sale" ? "sold" : e.transactionType === "restock" ? "restocked" : "adjusted";
      lines.push({ key: `l-${e.at}-${e.itemId}-${e.after}`, at: e.at, text: `${e.itemName}${deleted}: ${label} ${e.change > 0 ? "+" : ""}${e.change} (${e.before} → ${e.after})` });
    } else {
      lines.push({ key: `d-${e.itemId}`, at: e.at, text: `${nameFor(e.itemId)}: item deleted (last stock ${String(e.lastStock ?? "—")})` });
    }
  }
  return lines;
}

export async function fetchInventoryHistory(projectId: string, limit = 200): Promise<{ entries: HistoryEntry[] | null; error: string | null }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("inventory_history", { p_project_id: projectId, p_limit: limit });
  if (error) return { entries: null, error: error.message };
  const entries = parseHistory(data);
  return entries === null ? { entries: null, error: "Invalid response from inventory history." } : { entries, error: null };
}
